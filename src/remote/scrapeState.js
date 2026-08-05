// ─── Scrape state ──────────────────────────────────────────────────────────────
//
// One document per company per ATS, recording what that board looked like last
// run. Two hashes let the next run decide whether to reprocess it at all:
//
//   idHash      — SHA-256 over the sorted job IDs. Changes when a posting is
//                 added or removed.
//   contentHash — SHA-256 over sorted "id|title|location|workplace" fingerprints.
//                 Changes when an existing posting is edited in a way that could
//                 flip a filter decision.
//
// Description is deliberately excluded from the content hash. Companies retouch
// description copy constantly — a typo fix would invalidate the hash and force a
// full reprocess without ever changing whether the job qualifies.
//
// The whole collection is loaded into a Map once at startup, so the per-company
// loop performs zero database round-trips.

import { createHash } from 'node:crypto';

const STATE_COLLECTION = 'scrapeState';

/** Outcome of comparing stored hashes against freshly computed ones. */
export const ComparisonResult = Object.freeze({
    UNCHANGED: 'UNCHANGED',
    CONTENT_CHANGED: 'CONTENT_CHANGED',
    JOBS_CHANGED: 'JOBS_CHANGED',
    FIRST_RUN: 'FIRST_RUN',
});

/** Map key for a company. Kept in one place so both writers agree on the shape. */
export function stateKey(ats, slug) {
    return `${ats}|${slug}`;
}

/**
 * Loads every scrapeState document into a Map keyed by "ats|slug".
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<Map<string, object>>}
 */
export async function loadAllScrapeStates(db) {
    const docs = await db.collection(STATE_COLLECTION).find({}).toArray();

    const stateMap = new Map();
    for (const doc of docs) {
        stateMap.set(stateKey(doc.ats, doc.slug), doc);
    }

    console.log(`[ScrapeState] Loaded ${stateMap.size} company states`);
    return stateMap;
}

/**
 * Reads one company's state from the in-memory Map.
 *
 * @returns {object|null} null on the first run for this company.
 */
export function getScrapeState(stateMap, ats, slug) {
    return stateMap.get(stateKey(ats, slug)) || null;
}

/**
 * Sorts deterministically by code unit.
 *
 * Array.prototype.sort() without a comparator coerces to string and compares by
 * UTF-16 code unit, which IS deterministic — but localeCompare() is not: its
 * ordering depends on the runtime's ICU locale data, so the same input could
 * hash differently on a developer machine and on a CI runner. An explicit
 * `<`/`>` comparison sidesteps both concerns.
 */
function sortDeterministic(values) {
    return [...values].sort((a, b) => {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    });
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hashes the sorted job IDs. Detects additions and removals.
 *
 * A null/undefined ID becomes the literal string "null" rather than being
 * dropped: a posting the ATS failed to identify is a real change in the board,
 * and silently skipping it would hide that.
 *
 * @param {object[]} jobs
 * @param {(job: object) => string} extractJobID
 * @returns {string} hex digest
 */
export function computeIdHash(jobs, extractJobID) {
    const ids = (jobs || []).map((job) => {
        const id = extractJobID(job);
        return id === null || id === undefined ? 'null' : String(id);
    });

    return sha256(sortDeterministic(ids).join('\n'));
}

/**
 * Hashes sorted "id|title|location|workplace" fingerprints. Detects edits to the
 * fields that can change a filtering decision.
 *
 * @param {object[]} jobs
 * @param {(job: object) => string} extractJobID
 * @param {(job: object) => string} extractJobTitle
 * @param {(job: object) => string} extractLocation
 * @param {(job: object) => string} extractWorkplaceType
 * @returns {string} hex digest
 */
export function computeContentHash(jobs, extractJobID, extractJobTitle, extractLocation, extractWorkplaceType) {
    const safe = (value) => (value === null || value === undefined ? 'null' : String(value));

    const fingerprints = (jobs || []).map((job) => [
        safe(extractJobID(job)),
        safe(extractJobTitle(job)),
        safe(extractLocation(job)),
        safe(extractWorkplaceType(job)),
    ].join('|'));

    return sha256(sortDeterministic(fingerprints).join('\n'));
}

/**
 * Upserts one company's state.
 *
 * @param {import('mongodb').Db} db
 */
export async function saveScrapeState(db, ats, slug, idHash, contentHash, jobCount) {
    const now = new Date();

    await db.collection(STATE_COLLECTION).findOneAndUpdate(
        { slug, ats },
        {
            $set: { idHash, contentHash, jobCount, lastScrapedAt: now },
            $setOnInsert: { slug, ats, createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
    );
}

/**
 * Bulk equivalent of saveScrapeState. One round-trip for a whole platform
 * instead of one per company.
 *
 * @param {import('mongodb').Db} db
 * @param {Array<{ats:string, slug:string, idHash:string, contentHash:string, jobCount:number}>} states
 */
export async function saveScrapeStatesBulk(db, states) {
    if (!states || states.length === 0) {
        console.log('[ScrapeState] No states to save (every company failed or was skipped)');
        return 0;
    }

    const now = new Date();
    const operations = states.map(({ ats, slug, idHash, contentHash, jobCount }) => ({
        updateOne: {
            filter: { slug, ats },
            update: {
                $set: { idHash, contentHash, jobCount, lastScrapedAt: now },
                $setOnInsert: { slug, ats, createdAt: now },
            },
            upsert: true,
        },
    }));

    const result = await db.collection(STATE_COLLECTION).bulkWrite(operations, { ordered: false });

    const upserted = result.upsertedCount || 0;
    const modified = result.modifiedCount || 0;
    console.log(`[ScrapeState] Saving ${states.length} states for ${states[0].ats} (${upserted} new, ${modified} updated)`);

    return upserted + modified;
}

/**
 * Decides what to do with a company given its stored state and current hashes.
 *
 * @param {object|null} stored
 * @param {string} currentIdHash
 * @param {string} currentContentHash
 * @returns {string} a ComparisonResult value
 */
export function compareHashes(stored, currentIdHash, currentContentHash) {
    if (!stored) return ComparisonResult.FIRST_RUN;

    if (stored.idHash !== currentIdHash) return ComparisonResult.JOBS_CHANGED;

    if (stored.contentHash !== currentContentHash) return ComparisonResult.CONTENT_CHANGED;

    return ComparisonResult.UNCHANGED;
}

/**
 * Creates the compound unique index. Safe to call on every run.
 *
 * @param {import('mongodb').Db} db
 */
export async function ensureScrapeStateIndexes(db) {
    await db.collection(STATE_COLLECTION).createIndex(
        { slug: 1, ats: 1 },
        { unique: true, name: 'slug_ats_unique' },
    );
}

/** True when no company has ever been scraped — used to gate one-time cleanups. */
export async function isFirstEverRun(db) {
    const count = await db.collection(STATE_COLLECTION).estimatedDocumentCount();
    return count === 0;
}
