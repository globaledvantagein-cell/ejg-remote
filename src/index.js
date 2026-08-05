// ─── EJG Remote Scraper ────────────────────────────────────────────────────────
//
// Runs once and exits. PM2's cron_restart schedules the next run.
//
// Pipeline, per job:
//   country whitelist → fully remote → (enrich) → restriction scan → dedup →
//   map → resolve filters → save
//
// Each gate is ordered cheapest-first. The enrichment step sits after the two
// free checks precisely because it costs an HTTP request per job: Lever,
// Workday and SmartRecruiters only hand over descriptions on a per-job detail
// endpoint, so we pay for that only on jobs that already look like keepers.

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
import { saveRemoteJob, deduplicateRemoteJob, categorizeFromTitle, buildDedupKey, normalizeCountryCode } from './remote/remoteSaver.js';
import { resolveAll } from './remote/filterNormalizer.js';
import { deriveExperienceLevelFromTitle, deriveIsEntryLevelFromTitle } from './utils/jobFields.js';

const ATS_MODULES = [
    greenhouse,
    ashby,
    lever,
    workday,
    workable,
    recruitee,
    personio,
    smartRecruiters,
    teamtailor,
];

/**
 * Reads `--limit=N` off the command line. N caps how many companies each ATS
 * fetches from, cutting a full run down to something testable in a minute or
 * two. Returns null when the flag is absent, which means "no cap".
 *
 * A malformed or non-positive N is treated as absent rather than fatal — the
 * cost of a mistyped flag should be a slow run, not a dead one.
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

const COMPANY_LIMIT = parseCompanyLimit(process.argv.slice(2));

// Below this, a description carries no usable information: no responsibilities,
// no requirements, and nothing for the restriction scan to read.
const MIN_DESCRIPTION_LENGTH = 200;

/** Milliseconds → "4m 32s", or "48.3s" under a minute. */
function formatDuration(ms) {
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
}

/** Calls an optional extractor, returning `fallback` when the ATS doesn't define it. */
function callOptional(ats, name, job, fallback = null) {
    return typeof ats[name] === 'function' ? ats[name](job) : fallback;
}

/**
 * Builds the full job document. Field names mirror the German pipeline exactly
 * so the frontend, cache and filter layers treat remote jobs identically.
 */
function buildJobDocument(ats, job) {
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
        Country: country,
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
        Tags: callOptional(ats, 'extractTags', job, []) || [],
        SalaryMin: callOptional(ats, 'extractSalaryMin', job),
        SalaryMax: callOptional(ats, 'extractSalaryMax', job),
        SalaryCurrency: callOptional(ats, 'extractSalaryCurrency', job),
        SalaryInterval: callOptional(ats, 'extractSalaryInterval', job),
        dedupKey: buildDedupKey(ats.extractCompany(job) || '', jobTitle, country),
        hasPositiveRemoteSignal: hasPositiveSignal(description),
    };
}

/** Runs one ATS platform end to end and returns its counters. */
async function processAts(db, ats) {
    const atsName = ats.ATS_NAME;
    console.log(`\n[Remote Scraper] Starting ${atsName}...`);

    const slugs = COMPANY_LIMIT === null
        ? ats.COMPANY_SLUGS
        : ats.COMPANY_SLUGS.slice(0, COMPANY_LIMIT);

    if (COMPANY_LIMIT !== null) {
        console.log(`[Remote Scraper] ${atsName}: limited to ${slugs.length} of ${ats.COMPANY_SLUGS.length} companies`);
    }

    const atsStartedAt = Date.now();

    const jobs = await ats.fetchAllJobs(slugs);
    console.log(`[Remote Scraper] ${atsName}: ${jobs.length} jobs fetched`);

    let saved = 0;
    let filtered = 0;
    let duped = 0;

    for (const rawJob of jobs) {
        try {
            // 1. Country whitelist — free, and kills the overwhelming majority.
            if (!isWhitelistedCountry(ats.extractCountry(rawJob))) {
                filtered++;
                continue;
            }

            // 2. Remote check — also free. Hybrid and Unspecified are rejected.
            if (!isFullyRemote(ats.extractWorkplaceType(rawJob), ats.extractIsRemote(rawJob))) {
                filtered++;
                continue;
            }

            // 3. Enrichment (Lever / Workday / SmartRecruiters only). This is the
            //    first step that costs a request, hence its position.
            const job = typeof ats.enrichJob === 'function' ? await ats.enrichJob(rawJob) : rawJob;

            // Workday's authoritative workplace type only exists post-enrichment,
            // so the remote gate is re-run against the enriched payload.
            if (!isFullyRemote(ats.extractWorkplaceType(job), ats.extractIsRemote(job))) {
                filtered++;
                continue;
            }

            // 4. Restriction scan on the description.
            const description = ats.extractDescription(job) || '';
            const restriction = hasRestriction(description);
            if (restriction.restricted) {
                filtered++;
                continue;
            }

            const company = ats.extractCompany(job) || '';
            const title = ats.extractJobTitle(job) || '';
            const country = ats.extractCountry(job);

            // 5. Completeness. A posting with no description is useless to a
            //    reader and, worse, invisible to the restriction scan above —
            //    there is no text in which a geo-lock could be found, so it
            //    passes that gate on a technicality rather than on merit.
            if (description.length < MIN_DESCRIPTION_LENGTH) {
                console.log(`[Remote Scraper] SKIP: ${title} at ${company} — description too short (${description.length} chars)`);
                filtered++;
                continue;
            }

            if (!company.trim()) {
                console.log(`[Remote Scraper] SKIP: ${title} — missing company name`);
                filtered++;
                continue;
            }

            // 6. Cross-company duplicate check.

            if (await deduplicateRemoteJob(db, company, title, country)) {
                duped++;
                continue;
            }

            // 7. Map, resolve filter fields, save. The write happens here, per
            //    job, rather than being batched at the end of the platform —
            //    rows land in `jobs` while the run is still going.
            const jobDoc = buildJobDocument(ats, job);
            const result = await saveRemoteJob(db, { ...jobDoc, ...resolveAll(jobDoc) });

            if (result.saved) {
                saved++;
                console.log(`[Remote Scraper] SAVED: ${jobDoc.JobTitle} at ${jobDoc.Company} (${jobDoc.Country}, Remote)`);
            }

        } catch (error) {
            console.error(`[Remote Scraper] ${atsName}: job failed — ${error.message}`);
            filtered++;
        }
    }

    const elapsedSeconds = ((Date.now() - atsStartedAt) / 1000).toFixed(1);
    console.log(`[Remote Scraper] ${atsName}: ${saved} remote jobs saved, ${filtered} filtered, ${duped} duplicates`);
    console.log(`[Remote Scraper] ${atsName}: done in ${elapsedSeconds}s (${jobs.length} jobs from ${slugs.length} companies)`);

    return { saved, filtered, duped };
}

/**
 * Deletes hybrid jobs admitted by the old isFullyRemote, which trusted the
 * ATS IsRemote flag ahead of WorkplaceType. Those rows cannot be corrected in
 * place — they were never eligible — so they are removed before the run.
 *
 * Runs every time and is a no-op once the collection is clean.
 *
 * @param {import('mongodb').Db} db
 */
async function purgeHybridJobs(db) {
    const { deletedCount } = await db.collection('remoteJobs').deleteMany({ WorkplaceType: 'Hybrid' });

    if (deletedCount > 0) {
        console.log(`[Remote Scraper] Cleanup: deleted ${deletedCount} hybrid jobs from remoteJobs`);
    } else {
        console.log('[Remote Scraper] Cleanup: no hybrid jobs to delete');
    }
}

/**
 * Removes rows the current filters would never have admitted.
 *
 * Three passes, each targeting damage from a bug fixed in this codebase:
 *   1. Geo-locked postings the old US-only restriction patterns missed.
 *   2. Cross-ATS duplicates the old loose dedup key failed to collapse.
 *   3. Rows with no company name or no usable description.
 *
 * Idempotent — a second run finds nothing and reports zeroes.
 *
 * @param {import('mongodb').Db} db
 */
async function cleanupBadRows(db) {
    const collection = db.collection('remoteJobs');
    let restricted = 0;
    let duplicates = 0;
    let incomplete = 0;

    // ── 1. Restricted ──────────────────────────────────────────────────────────
    // Evaluated in JS rather than as a Mongo query so the stored rows are judged
    // by exactly the same hasRestriction() the scraper now applies. A hand-built
    // $regex would inevitably drift from it.
    const withDescriptions = await collection.find(
        {},
        { projection: { _id: 1, Description: 1 } },
    ).toArray();

    const restrictedIds = withDescriptions
        .filter(doc => hasRestriction(doc.Description).restricted)
        .map(doc => doc._id);

    if (restrictedIds.length > 0) {
        const result = await collection.deleteMany({ _id: { $in: restrictedIds } });
        restricted = result.deletedCount;
    }

    // ── 2. Cross-ATS duplicates ────────────────────────────────────────────────
    // Keys are recomputed with the current normaliser; the stored dedupKey was
    // written by the older, looser one and would under-report.
    const survivors = await collection.find(
        {},
        { projection: { _id: 1, Company: 1, JobTitle: 1, Country: 1, createdAt: 1 } },
    ).toArray();

    const groups = new Map();
    for (const doc of survivors) {
        const key = buildDedupKey(doc.Company || '', doc.JobTitle || '', doc.Country);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
    }

    const duplicateIds = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        // Oldest wins: it is the row the frontend may already be linking to.
        group.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        duplicateIds.push(...group.slice(1).map(doc => doc._id));
    }

    if (duplicateIds.length > 0) {
        const result = await collection.deleteMany({ _id: { $in: duplicateIds } });
        duplicates = result.deletedCount;
    }

    // ── 3. Incomplete ──────────────────────────────────────────────────────────
    const incompleteResult = await collection.deleteMany({
        $or: [
            { Company: { $in: [null, ''] } },
            { Company: { $exists: false } },
            { $expr: { $lt: [{ $strLenCP: { $ifNull: ['$Description', ''] } }, MIN_DESCRIPTION_LENGTH] } },
        ],
    });
    incomplete = incompleteResult.deletedCount;

    console.log(`[Cleanup] Removed: ${restricted} restricted, ${duplicates} duplicates, ${incomplete} incomplete`);
}

// The only country values a stored document may carry, post-normalisation.
const VALID_COUNTRY_CODES = new Set(['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'SG']);

/**
 * Rewrites Country on rows stored before normalisation existed.
 *
 * saveRemoteJob normalises on insert only — an existing document has just its
 * scrapedAt refreshed — so rows written by earlier runs keep whatever spelling
 * their ATS used ("United States", "USA", "U.S."). This brings them in line so
 * the collection holds ISO alpha-2 throughout.
 *
 * dedupKey is rebuilt alongside, since it embeds the country.
 *
 * @param {import('mongodb').Db} db
 */
async function normalizeStoredCountries(db) {
    const collection = db.collection('remoteJobs');

    // Matching on "not two uppercase letters" is not enough: "UK" is two letters
    // but is not the ISO code (GB is). The filter is the explicit valid set.
    const stale = await collection.find(
        { Country: { $nin: [...VALID_COUNTRY_CODES] } },
        { projection: { _id: 1, Country: 1, Company: 1, JobTitle: 1 } },
    ).toArray();

    if (stale.length === 0) {
        console.log('[Remote Scraper] Cleanup: all stored countries already ISO alpha-2');
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

    const { modifiedCount } = await collection.bulkWrite(operations);
    console.log(`[Remote Scraper] Cleanup: normalized Country on ${modifiedCount} stored jobs`);
}

async function main() {
    const startedAt = Date.now();

    if (COMPANY_LIMIT !== null) {
        console.log(`[Remote Scraper] TEST RUN — --limit=${COMPANY_LIMIT}: fetching the first ${COMPANY_LIMIT} company/companies per ATS`);
    }

    const db = await connectToDb();

    await purgeHybridJobs(db);
    await normalizeStoredCountries(db);
    await cleanupBadRows(db);

    const totals = { saved: 0, filtered: 0, duped: 0 };

    for (const ats of ATS_MODULES) {
        try {
            const counts = await processAts(db, ats);
            totals.saved += counts.saved;
            totals.filtered += counts.filtered;
            totals.duped += counts.duped;
        } catch (error) {
            // One dead platform must not cost us the other eight.
            console.error(`[Remote Scraper] ${ats.ATS_NAME} failed entirely: ${error.message}`);
        }
    }

    console.log('\n─────────────────────────────────────────────');
    console.log(`[Remote Scraper] Complete: ${totals.saved} jobs saved in ${formatDuration(Date.now() - startedAt)}`);
    console.log(`[Remote Scraper] Total: ${totals.saved} saved, ${totals.filtered} filtered, ${totals.duped} duplicates`);
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
