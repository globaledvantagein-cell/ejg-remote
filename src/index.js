// ─── EJG Remote Scraper ────────────────────────────────────────────────────────
//
// Incremental architecture. The previous design re-fetched, re-filtered and
// re-saved every job on every run; at ~2,800 companies and ~60,000 jobs that
// took over an hour, and almost all of it was work already done the day before.
//
// Three changes carry the speedup:
//
//   1. Content hashing (scrapeState) — a company whose board is byte-identical
//      to last run is skipped without processing a single job. On a typical day
//      most boards do not change.
//   2. RAM dedup (dedupCache) — the per-job "have we seen this?" query became
//      two Sets loaded once at startup. 60,000 round-trips → 1.
//   3. Bulk writes (bulkSaver) — inserts and freshness touches are batched 500
//      at a time instead of one round-trip each.
//
// Jobs that vanish from a feed are not deleted on sight; expiryTracker counts
// consecutive misses and only expires after three, with a guard against partial
// API responses.
//
// Per-job pipeline (unchanged, still ordered cheapest-first):
//   country whitelist → fully remote → (enrich) → restriction scan →
//   completeness → dedup → map → resolve filters → buffer

import 'dotenv/config';

import { connectToDb, client } from './db.js';

import * as greenhouse from './ats/greenhouse.js';
import * as ashby from './ats/ashby.js';
import * as lever from './ats/lever.js';
import * as workday from './ats/workday.js';
import * as workable from './ats/workable.js';
import * as recruitee from './ats/recruitee.js';
import * as personio from './ats/personio.js';
import * as smartRecruiters from './ats/smartRecruiters.js';
import * as teamtailor from './ats/teamtailor.js';

import { isWhitelistedCountry, isFullyRemote, hasRestriction, hasPositiveSignal } from './remote/remoteFilter.js';
import { categorizeFromTitle, buildDedupKey, normalizeCountryCode } from './remote/remoteSaver.js';
import { resolveAll } from './remote/filterNormalizer.js';
import { deriveExperienceLevelFromTitle, deriveIsEntryLevelFromTitle } from './utils/jobFields.js';
import { runConcurrent } from './utils/concurrent.js';

import {
    loadAllScrapeStates,
    getScrapeState,
    computeIdHash,
    computeContentHash,
    compareHashes,
    saveScrapeStatesBulk,
    ensureScrapeStateIndexes,
    isFirstEverRun,
    ComparisonResult,
} from './remote/scrapeState.js';

import { loadDedupCache, isDuplicate, isExistingJobId, addToCache } from './remote/dedupCache.js';
import { createBulkBuffer, addInsert, addUpdate, flushBuffer, flushIfFull } from './remote/bulkSaver.js';
import {
    loadAllActiveJobIds,
    companyKey,
    jobCountDropGuard,
    markMissedJobs,
    resetMissCounters,
    expireStaleJobs,
    ensureExpiryIndexes,
} from './remote/expiryTracker.js';

const ATS_MODULES = [greenhouse, ashby, lever, workday, workable, recruitee, personio, smartRecruiters, teamtailor];

// Per-platform fan-out. The fast JSON APIs tolerate more parallelism; the slow
// or rate-sensitive ones (Recruitee answers in seconds, Personio serves XML)
// stay low.
const CONCURRENCY_BY_ATS = {
    greenhouse: 15,
    ashby: 15,
    lever: 15,
    workday: 10,
    smartrecruiters: 10,
    teamtailor: 5,
    personio: 5,
    recruitee: 5,
    workable: 5,
};

const DEFAULT_CONCURRENCY = 5;

// Below this, a description carries no usable information: no responsibilities,
// no requirements, and nothing for the restriction scan to read.
const MIN_DESCRIPTION_LENGTH = 200;

// Heartbeat cadence for the per-job loop. A platform can carry tens of thousands
// of jobs, so per-job logging would bury everything else; this is frequent
// enough to show the run is alive and roughly how far along it is.
const PROGRESS_INTERVAL = 1000;

// ─── CLI flags ────────────────────────────────────────────────────────────────

/**
 * Reads `--limit=N`. Caps how many companies each ATS processes.
 * A malformed value is treated as absent — a mistyped flag should cost a slow
 * run, not a dead one.
 */
function parseCompanyLimit(argv) {
    const flag = argv.find(arg => arg.startsWith('--limit='));
    if (!flag) return null;

    const value = Number(flag.slice('--limit='.length));
    if (!Number.isInteger(value) || value < 1) {
        console.warn(`[Remote Scraper] Ignoring malformed flag "${flag}" — expected --limit=<positive integer>`);
        return null;
    }
    return value;
}

const ARGV = process.argv.slice(2);
const COMPANY_LIMIT = parseCompanyLimit(ARGV);
const FORCE_CLEANUP = ARGV.includes('--cleanup');

/** Milliseconds → "4m 32s", or "48.3s" under a minute. */
function formatDuration(ms) {
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
}

/**
 * The identifying string for a slug entry.
 *
 * Most platforms use a bare string, but Workday entries are
 * { company, instance, site, name } and Personio entries are
 * { subdomain, tld } — both need a stable scalar for the state key.
 */
function slugOf(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return String(entry);
    return entry.company || entry.subdomain || JSON.stringify(entry);
}

/** Calls an optional extractor, returning `fallback` when the ATS doesn't define it. */
function callOptional(ats, name, job, fallback = null) {
    return typeof ats[name] === 'function' ? ats[name](job) : fallback;
}

/**
 * Builds the full job document. Field names mirror the German pipeline exactly
 * so the frontend, cache and filter layers treat remote jobs identically.
 *
 * `sourceSlug` is new: the expiry tracker needs to know which company produced a
 * job, and several platforms build JobIDs that do not contain the slug.
 */
function buildJobDocument(ats, job, sourceSlug) {
    const jobTitle = ats.extractJobTitle(job) || '';
    const department = ats.extractDepartment(job) || 'N/A';
    const country = ats.extractCountry(job);
    const description = ats.extractDescription(job) || '';
    const { category, domain } = categorizeFromTitle(jobTitle, department);

    const experienceLevel = callOptional(ats, 'extractExperienceLevel', job)
        || deriveExperienceLevelFromTitle(jobTitle);
    const isEntryLevel = callOptional(ats, 'extractIsEntryLevel', job)
        ?? deriveIsEntryLevelFromTitle(jobTitle);

    return {
        JobID: ats.extractJobID(job),
        JobTitle: jobTitle,
        Company: ats.extractCompany(job) || '',
        Location: ats.extractLocation(job) || '',
        AllLocations: callOptional(ats, 'extractAllLocations', job, []) || [],
        Country: normalizeCountryCode(country),
        Description: description,
        DescriptionHtml: callOptional(ats, 'extractDescriptionHtml', job, '') || '',
        ApplicationURL: ats.extractURL(job),
        DirectApplyURL: callOptional(ats, 'extractDirectApplyURL', job),
        PostedDate: ats.extractPostedDate(job),
        Department: department,
        WorkplaceType: ats.extractWorkplaceType(job),
        EmploymentType: ats.extractEmploymentType(job),
        ExperienceLevel: experienceLevel,
        IsRemote: true, // every job that reaches here has passed isFullyRemote()
        isEntryLevel: Boolean(isEntryLevel),
        Category: category,
        Domain: domain,
        SubDomain: department !== 'N/A' ? department : null,
        ATSPlatform: ats.extractATSPlatform(),
        sourceSlug,
        Tags: callOptional(ats, 'extractTags', job, []) || [],
        SalaryMin: callOptional(ats, 'extractSalaryMin', job),
        SalaryMax: callOptional(ats, 'extractSalaryMax', job),
        SalaryCurrency: callOptional(ats, 'extractSalaryCurrency', job),
        SalaryInterval: callOptional(ats, 'extractSalaryInterval', job),
        dedupKey: buildDedupKey(ats.extractCompany(job) || '', jobTitle, country),
        hasPositiveRemoteSignal: hasPositiveSignal(description),
    };
}

/**
 * True when a Location string describes a role with NO geographic restriction.
 *
 * isFullyRemote() reads WorkplaceType, which normalizeWorkplaceType() derives
 * with a `lower.includes('remote')` test — so "Remote - US" normalises to
 * "Remote" and sails through. The Location field is where the restriction
 * actually survives, and it is the only place it can be seen.
 *
 *   ""                       → accept (many ATSs omit Location for global roles)
 *   "Remote" / "  remote  "  → accept
 *   "Remote - US"            → reject
 *   "Remote, United Kingdom" → reject
 *   "New York"               → reject
 *
 * Deliberately strict: anything beyond the bare word is a qualifier, and a
 * qualifier means somebody somewhere cannot take the job.
 */
function isGlobalRemoteLocation(rawLocation) {
    const cleaned = String(rawLocation ?? '').trim().toLowerCase();
    return cleaned === '' || cleaned === 'remote';
}

// ─── Phase 2: per-company work ────────────────────────────────────────────────

/**
 * Fetches one company and decides whether it needs processing.
 *
 * Runs inside runConcurrent, so it must never throw: a rejected worker would be
 * reported as a failure for the whole slot. Errors become status:'error', which
 * the caller treats as "no evidence" — the stored state is preserved and nothing
 * is expired.
 */
async function fetchAndCompare(ats, entry, stateMap) {
    const slug = slugOf(entry);

    try {
        const jobs = await ats.fetchCompanyJobs(entry);

        if (!Array.isArray(jobs) || jobs.length === 0) {
            // An empty board is indistinguishable from a failed fetch on most of
            // these APIs, so it is treated as "no evidence" rather than "every
            // job was removed". Expiry needs three consecutive misses anyway.
            return { slug, entry, status: 'error', jobs: [] };
        }

        const idHash = computeIdHash(jobs, ats.extractJobID);
        const contentHash = computeContentHash(
            jobs,
            ats.extractJobID,
            ats.extractJobTitle,
            ats.extractLocation,
            ats.extractWorkplaceType,
        );

        const stored = getScrapeState(stateMap, ats.ATS_NAME, slug);
        const comparison = compareHashes(stored, idHash, contentHash);

        if (comparison === ComparisonResult.UNCHANGED) {
            return { slug, entry, status: 'unchanged', jobs: [], idHash, contentHash, jobCount: jobs.length, stored };
        }

        return { slug, entry, status: 'changed', comparison, jobs, idHash, contentHash, jobCount: jobs.length, stored };

    } catch (error) {
        console.error(`[${ats.ATS_NAME}] ${slug}: fetch failed — ${error.message}`);
        return { slug, entry, status: 'error', jobs: [] };
    }
}

/**
 * Runs the filter pipeline over one company's jobs and queues the survivors.
 *
 * Counters are bumped through bump(), which updates both the per-company tally
 * this returns and the platform-wide progress tally the heartbeat reads. Keeping
 * them in step at every branch is what lets the heartbeat report honest running
 * totals rather than a count that only settles between companies.
 *
 * @returns {Promise<{saved:number, refreshed:number, filtered:number, duped:number, geoLocked:number}>}
 */
async function processCompanyJobs(db, ats, result, ctx) {
    const counts = { saved: 0, refreshed: 0, filtered: 0, duped: 0, geoLocked: 0 };
    const progress = ctx.progress;

    const bump = (field) => {
        counts[field]++;
        // geoLocked was added later; guard so an older progress object without
        // the key does not turn into NaN in the heartbeat line.
        if (progress && typeof progress[field] === 'number') progress[field]++;
    };

    for (const rawJob of result.jobs) {
        // Counted before filtering, so the heartbeat measures work done rather
        // than work that survived.
        if (progress) {
            progress.seen++;
            if (progress.seen % PROGRESS_INTERVAL === 0) {
                console.log(
                    `[Remote Scraper] ${ats.ATS_NAME}: processing jobs... `
                    + `${progress.seen}/${progress.total} (${progress.saved} saved, ${progress.filtered} filtered)`,
                );
            }
        }

        try {
            // 1. Country whitelist — free, and kills the overwhelming majority.
            if (!isWhitelistedCountry(ats.extractCountry(rawJob))) {
                bump('filtered');
                continue;
            }

            // 2. Remote check — also free. Hybrid and Onsite are rejected.
            if (!isFullyRemote(ats.extractWorkplaceType(rawJob), ats.extractIsRemote(rawJob))) {
                bump('filtered');
                continue;
            }

            // 2b. isFullyRemote passed — now verify the Location carries no
            //     geographic qualifier. Checked here, before enrichment, so an
            //     obviously geo-locked posting never costs a network request.
            const rawLocation = ats.extractLocation(rawJob);
            if (!isGlobalRemoteLocation(rawLocation)) {
                console.log(
                    '[RemoteFilter] Rejected geo-locked: "%s" — %s at %s',
                    rawLocation,
                    ats.extractJobTitle(rawJob) || '(untitled)',
                    ats.extractCompany(rawJob) || '(unknown)',
                );
                bump('geoLocked');
                bump('filtered');
                continue;
            }

            // 3. Enrichment (Lever / Workday / SmartRecruiters). The first step
            //    that costs a request, hence its position behind the free gates.
            const job = typeof ats.enrichJob === 'function' ? await ats.enrichJob(rawJob) : rawJob;

            // Workday's authoritative workplace type only exists post-enrichment.
            if (!isFullyRemote(ats.extractWorkplaceType(job), ats.extractIsRemote(job))) {
                bump('filtered');
                continue;
            }

            // Re-checked on the ENRICHED record: several ATSs leave Location
            // empty on the list payload and only populate it here, so the raw
            // check above would have waved those through as "no location".
            const enrichedLocation = ats.extractLocation(job);
            if (!isGlobalRemoteLocation(enrichedLocation)) {
                console.log(
                    '[RemoteFilter] Rejected geo-locked: "%s" — %s at %s',
                    enrichedLocation,
                    ats.extractJobTitle(job) || '(untitled)',
                    ats.extractCompany(job) || '(unknown)',
                );
                bump('geoLocked');
                bump('filtered');
                continue;
            }

            // 4. Restriction scan on the description.
            const description = ats.extractDescription(job) || '';
            if (hasRestriction(description).restricted) {
                bump('filtered');
                continue;
            }

            const company = ats.extractCompany(job) || '';
            const title = ats.extractJobTitle(job) || '';
            const country = ats.extractCountry(job);

            // 5. Completeness. A posting with no description is useless to a
            //    reader and invisible to the restriction scan above — it would
            //    pass that gate on a technicality rather than on merit.
            if (description.length < MIN_DESCRIPTION_LENGTH) {
                bump('filtered');
                continue;
            }

            if (!company.trim()) {
                bump('filtered');
                continue;
            }

            const jobId = ats.extractJobID(job);
            const dedupKey = buildDedupKey(company, title, country);

            // 6. Already stored? Refresh its freshness stamp rather than
            //    inserting a second copy.
            if (isExistingJobId(ctx.dedupCache, jobId)) {
                addUpdate(ctx.buffer, jobId);
                ctx.seenJobIds.add(jobId);
                bump('refreshed');
                await flushIfFull(db, ctx.buffer);
                continue;
            }

            // 7. Cross-ATS duplicate — same role reachable through another board.
            if (isDuplicate(ctx.dedupCache, dedupKey)) {
                bump('duped');
                continue;
            }

            // 8. Map, resolve filter fields, queue the insert.
            const jobDoc = buildJobDocument(ats, job, result.slug);
            addInsert(ctx.buffer, { ...jobDoc, ...resolveAll(jobDoc) });

            addToCache(ctx.dedupCache, dedupKey, jobId);
            ctx.seenJobIds.add(jobId);
            bump('saved');

            await flushIfFull(db, ctx.buffer);

        } catch (error) {
            console.error(`[${ats.ATS_NAME}] ${result.slug}: job failed — ${error.message}`);
            bump('filtered');
        }
    }

    return counts;
}

/** Runs one ATS platform end to end. */
async function processAts(db, ats, ctx) {
    const atsName = ats.ATS_NAME;
    const startedAt = Date.now();

    const allSlugs = ats.COMPANY_SLUGS;
    const slugs = COMPANY_LIMIT === null ? allSlugs : allSlugs.slice(0, COMPANY_LIMIT);
    const concurrency = CONCURRENCY_BY_ATS[atsName] ?? DEFAULT_CONCURRENCY;

    console.log(`\n[Remote Scraper] Starting ${atsName}... (${slugs.length}${COMPANY_LIMIT !== null ? ` of ${allSlugs.length}` : ''} companies, ${concurrency} at a time)`);

    // Job IDs seen anywhere in this ATS this run — the basis for expiry.
    const seenJobIds = new Set();

    // ── Fetch + hash every company concurrently ────────────────────────────────
    const settled = await runConcurrent(
        slugs,
        (entry) => fetchAndCompare(ats, entry, ctx.stateMap),
        concurrency,
    );

    const results = settled
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    // Denominator for the progress heartbeat: only companies that actually need
    // processing contribute. Counting skipped companies here would report a
    // total the loop never reaches.
    const totalToProcess = results
        .filter(r => r.status === 'changed')
        .reduce((sum, r) => sum + r.jobs.length, 0);

    const progress = { seen: 0, total: totalToProcess, saved: 0, refreshed: 0, filtered: 0, duped: 0, geoLocked: 0 };
    const atsCtx = { ...ctx, seenJobIds, progress };

    // ── Process the results sequentially ───────────────────────────────────────
    const totals = { saved: 0, refreshed: 0, filtered: 0, duped: 0, geoLocked: 0 };
    let unchanged = 0;
    let processed = 0;
    let failed = 0;

    const statesToSave = [];

    for (const result of results) {
        const key = companyKey(atsName, result.slug);
        const storedJobIds = ctx.existingJobsMap.get(key) || new Set();

        if (result.status === 'error') {
            // No fetch means no evidence. Preserve the stored state and treat
            // every previously-known job as still present, so a transient
            // outage cannot push jobs toward expiry.
            for (const id of storedJobIds) seenJobIds.add(id);
            failed++;
            console.log(`[${atsName}] ${result.slug}: fetch failed, preserving previous state`);
            continue;
        }

        if (result.status === 'unchanged') {
            // The board is byte-identical, so every job we already hold from it
            // is still live. No processing, no writes beyond the state stamp.
            for (const id of storedJobIds) seenJobIds.add(id);
            statesToSave.push({
                ats: atsName,
                slug: result.slug,
                idHash: result.idHash,
                contentHash: result.contentHash,
                jobCount: result.jobCount,
            });
            unchanged++;
            console.log(`[${atsName}] ${result.slug}: unchanged, skipping (${result.jobCount} jobs)`);
            continue;
        }

        // status === 'changed'
        const counts = await processCompanyJobs(db, ats, result, atsCtx);
        totals.saved += counts.saved;
        totals.refreshed += counts.refreshed;
        totals.filtered += counts.filtered;
        totals.duped += counts.duped;
        totals.geoLocked += counts.geoLocked || 0;
        processed++;

        statesToSave.push({
            ats: atsName,
            slug: result.slug,
            idHash: result.idHash,
            contentHash: result.contentHash,
            jobCount: result.jobCount,
        });

        const reason = result.comparison === ComparisonResult.FIRST_RUN ? 'first run' : result.comparison.toLowerCase();
        console.log(`[${atsName}] ${result.slug}: ${counts.saved} new, ${counts.refreshed} refreshed, ${counts.filtered} filtered (${reason})`);
    }

    // ── Expiry bookkeeping for this platform ───────────────────────────────────
    const missed = [];

    for (const result of results) {
        if (result.status === 'error') continue;

        const key = companyKey(atsName, result.slug);
        const storedJobIds = ctx.existingJobsMap.get(key);
        if (!storedJobIds || storedJobIds.size === 0) continue;

        const storedCount = result.stored?.jobCount ?? storedJobIds.size;
        if (jobCountDropGuard(storedCount, result.jobCount)) {
            console.warn(`[${atsName}] ${result.slug}: job count dropped ${storedCount} → ${result.jobCount}, skipping expiry (suspected partial response)`);
            for (const id of storedJobIds) seenJobIds.add(id);
            continue;
        }

        for (const id of storedJobIds) {
            if (!seenJobIds.has(id)) missed.push(id);
        }
    }

    if (missed.length > 0) {
        const touched = await markMissedJobs(db, missed);
        console.log(`[${atsName}] ${touched} jobs missing from this run (miss counter incremented)`);
    }

    // Fold this platform's sightings into the run-wide set for the final reset.
    for (const id of seenJobIds) ctx.allSeenJobIds.add(id);

    // ── Persist state + drain the buffer ───────────────────────────────────────
    await saveScrapeStatesBulk(db, statesToSave);
    await flushBuffer(db, ctx.buffer);

    console.log(
        `[${atsName}]: ${slugs.length} companies, ${unchanged} unchanged, ${processed} processed, ${failed} failed, `
        + `${totals.saved} new, ${totals.refreshed} refreshed, ${totals.filtered} filtered, ${totals.duped} duplicates, `
        + `done in ${formatDuration(Date.now() - startedAt)}`,
    );
    console.log(`[RemoteFilter] Accepted: ${totals.saved + totals.refreshed}, Rejected geo-locked: ${totals.geoLocked}`);

    return { ...totals, unchanged, processed, failed };
}

// ─── One-time cleanups ────────────────────────────────────────────────────────

/**
 * Deletes hybrid jobs admitted by an older isFullyRemote that trusted the ATS
 * IsRemote flag ahead of WorkplaceType. Cheap enough to run unconditionally.
 */
async function purgeHybridJobs(db) {
    const { deletedCount } = await db.collection('remoteJobs').deleteMany({ WorkplaceType: 'Hybrid' });
    console.log(deletedCount > 0
        ? `[Cleanup] Deleted ${deletedCount} hybrid jobs`
        : '[Cleanup] No hybrid jobs to delete');
}

const VALID_COUNTRY_CODES = new Set(['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'SG']);

/**
 * Rewrites Country on rows stored before normalisation existed. A one-time
 * migration — gated behind --cleanup or the first ever run, because it scans the
 * whole collection and has nothing to do on a healthy database.
 */
async function normalizeStoredCountries(db) {
    const collection = db.collection('remoteJobs');

    const stale = await collection.find(
        { Country: { $nin: [...VALID_COUNTRY_CODES] } },
        { projection: { _id: 1, Country: 1, Company: 1, JobTitle: 1 } },
    ).toArray();

    if (stale.length === 0) {
        console.log('[Cleanup] All stored countries already ISO alpha-2');
        return;
    }

    const operations = stale.map(doc => {
        const code = normalizeCountryCode(doc.Country);
        return {
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { Country: code, dedupKey: buildDedupKey(doc.Company || '', doc.JobTitle || '', code) } },
            },
        };
    });

    const { modifiedCount } = await collection.bulkWrite(operations, { ordered: false });
    console.log(`[Cleanup] Normalized Country on ${modifiedCount} stored jobs`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const runStartedAt = Date.now();

    if (COMPANY_LIMIT !== null) {
        console.log(`[Remote Scraper] TEST RUN — --limit=${COMPANY_LIMIT}: first ${COMPANY_LIMIT} company/companies per ATS`);
    }

    // ── Phase 1: startup ───────────────────────────────────────────────────────
    const startupBegan = Date.now();

    const db = await connectToDb();
    await ensureScrapeStateIndexes(db);
    await ensureExpiryIndexes(db);

    const firstRun = await isFirstEverRun(db);

    const [stateMap, dedupCache, existingJobsMap] = await Promise.all([
        loadAllScrapeStates(db),
        loadDedupCache(db),
        loadAllActiveJobIds(db),
    ]);

    // The heavy migrations only earn their scan on a first run or on request.
    if (FORCE_CLEANUP || firstRun) {
        console.log(`[Remote Scraper] Running cleanups (${firstRun ? 'first ever run' : '--cleanup requested'})`);
        await purgeHybridJobs(db);
        await normalizeStoredCountries(db);
    } else {
        await purgeHybridJobs(db);
    }

    const ctx = {
        stateMap,
        dedupCache,
        existingJobsMap,
        buffer: createBulkBuffer(),
        allSeenJobIds: new Set(),
    };

    console.log(`[Remote Scraper] Startup complete in ${formatDuration(Date.now() - startupBegan)}`);

    // ── Phase 2: per ATS, sequential ───────────────────────────────────────────
    const totals = { saved: 0, refreshed: 0, filtered: 0, duped: 0, geoLocked: 0, unchanged: 0, processed: 0, failed: 0 };

    for (const ats of ATS_MODULES) {
        try {
            const counts = await processAts(db, ats, ctx);
            for (const key of Object.keys(totals)) totals[key] += counts[key] || 0;
        } catch (error) {
            // One dead platform must not cost us the other eight.
            console.error(`[Remote Scraper] ${ats.ATS_NAME} failed entirely: ${error.message}`);
        }
    }

    // ── Phase 3: cleanup ───────────────────────────────────────────────────────
    const cleanupBegan = Date.now();

    await flushBuffer(db, ctx.buffer);

    const resetCount = await resetMissCounters(db, ctx.allSeenJobIds);
    const expiredCount = await expireStaleJobs(db);

    console.log(`[Remote Scraper] Expiry: ${expiredCount} jobs expired, ${resetCount} miss counters reset`);
    console.log(`[Remote Scraper] Cleanup complete in ${formatDuration(Date.now() - cleanupBegan)}`);

    // Proof the bulk path actually carried the writes. If flushedOperations is 0
    // while jobs were saved, something bypassed the buffer.
    const b = ctx.buffer;
    console.log(`[BulkSaver] Total: ${b.flushedOperations} operations flushed, ${b.savedCount} inserts, ${b.updatedCount} updates, ${b.errorCount} errors`);

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log('\n─────────────────────────────────────────────');
    console.log(`[Remote Scraper] Complete in ${formatDuration(Date.now() - runStartedAt)}`);
    console.log(`[Remote Scraper] Companies: ${totals.unchanged} unchanged (skipped), ${totals.processed} processed, ${totals.failed} failed`);
    console.log(`[Remote Scraper] Jobs: ${totals.saved} new, ${totals.refreshed} refreshed, ${totals.filtered} filtered, ${totals.duped} duplicates`);
    console.log(`[RemoteFilter] Rejected geo-locked across all platforms: ${totals.geoLocked}`);
    console.log(`[Remote Scraper] Expired: ${expiredCount}`);
    console.log('─────────────────────────────────────────────');
}

try {
    await main();
    await client.close();
    process.exit(0);
} catch (error) {
    console.error('[Remote Scraper] Fatal error:', error);
    await client.close().catch(() => {});
    process.exit(1);
}
