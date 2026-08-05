// ─── Expiry tracker ────────────────────────────────────────────────────────────
//
// A job that vanishes from its ATS feed has almost certainly been filled or
// withdrawn — but "almost certainly" is not "certainly". A rate-limited request,
// a brief API outage or a board being renamed all make jobs disappear for a run
// without meaning anything.
//
// So disappearance is counted, not acted on: a job must be missing from three
// consecutive runs before it is expired. Two independent safeguards sit on top:
//
//   - A company whose fetch errored is skipped entirely. No fetch, no evidence.
//   - jobCountDropGuard() vetoes expiry when a board's job count halves in one
//     run, which is the signature of a partial API response rather than a
//     genuine clear-out.
//
// Grouping note: the natural key is "which company did this job come from", but
// several platforms build JobIDs without the slug in them (`lever_${id}`,
// `workable_${id}`), so it cannot be recovered by parsing. Documents therefore
// carry an explicit `sourceSlug`, and rows written before that field existed
// fall back to JobID parsing — and, failing that, are left alone rather than
// guessed at.

const JOBS_COLLECTION = 'remoteJobs';

/** A job must be missing this many consecutive runs before it expires. */
export const MISS_THRESHOLD = 3;

/** Below this fraction of the previous count, expiry is vetoed for the company. */
const SUSPICIOUS_DROP_RATIO = 0.5;

/** Composite key for the active-jobs map. */
export function companyKey(ats, slug) {
    return `${ats}|${slug}`;
}

/**
 * Best-effort slug recovery for documents predating `sourceSlug`.
 *
 * JobIDs are built as `${platform}_${slug}_${id}` on most platforms, so the
 * middle segment is the slug. Platforms that omit it return null, and the caller
 * treats null as "cannot attribute" — such rows are never expired.
 */
function slugFromJobId(jobId, ats) {
    if (typeof jobId !== 'string') return null;

    // SmartRecruiters uses the `sr_` prefix rather than its ATS_NAME.
    const prefixes = [`${ats}_`, 'sr_'];
    const prefix = prefixes.find(p => jobId.startsWith(p));
    if (!prefix) return null;

    const rest = jobId.slice(prefix.length);
    const lastUnderscore = rest.lastIndexOf('_');

    // No second segment → the ID carries no slug (lever, workable).
    if (lastUnderscore <= 0) return null;

    return rest.slice(0, lastUnderscore);
}

/**
 * Loads every active job ID, grouped by the company that produced it.
 *
 * One query, one pass, all of it in RAM — the per-company loop never touches the
 * database.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<Map<string, Set<string>>>} "ats|slug" → Set of JobIDs
 */
export async function loadAllActiveJobIds(db) {
    const docs = await db.collection(JOBS_COLLECTION)
        .find({ Status: 'active' }, { projection: { JobID: 1, ATSPlatform: 1, sourceSlug: 1 } })
        .toArray();

    const map = new Map();
    let unattributed = 0;

    for (const doc of docs) {
        const ats = doc.ATSPlatform;
        if (!ats || !doc.JobID) continue;

        const slug = doc.sourceSlug || slugFromJobId(doc.JobID, ats);
        if (!slug) {
            unattributed++;
            continue;
        }

        const key = companyKey(ats, slug);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(doc.JobID);
    }

    console.log(`[ExpiryTracker] Loaded ${docs.length} active job IDs across ${map.size} companies`);
    if (unattributed > 0) {
        console.log(`[ExpiryTracker] ${unattributed} jobs could not be attributed to a company — they will not be expired`);
    }

    return map;
}

/**
 * True when the current fetch returned suspiciously fewer jobs than last time.
 *
 * A board going from 40 postings to 3 in a day is far more likely to be a
 * truncated API response than 37 simultaneous hires.
 *
 * @param {number} storedCount
 * @param {number} currentCount
 * @returns {boolean} true when expiry should be vetoed
 */
export function jobCountDropGuard(storedCount, currentCount) {
    if (!storedCount || storedCount <= 0) return false;
    return currentCount < storedCount * SUSPICIOUS_DROP_RATIO;
}

/**
 * Increments consecutiveMisses on jobs absent from this run.
 *
 * @param {import('mongodb').Db} db
 * @param {string[]} missedJobIds
 * @returns {Promise<number>} number of documents touched
 */
export async function markMissedJobs(db, missedJobIds) {
    if (!missedJobIds || missedJobIds.length === 0) return 0;

    const operations = missedJobIds.map(jobId => ({
        updateOne: {
            filter: { JobID: jobId },
            update: { $inc: { consecutiveMisses: 1 } },
        },
    }));

    const result = await db.collection(JOBS_COLLECTION).bulkWrite(operations, { ordered: false });
    return result.modifiedCount || 0;
}

/**
 * Resets the miss counter on every job seen this run.
 *
 * Filtered to documents whose counter is actually non-zero — without that, this
 * would rewrite tens of thousands of documents to set 0 to 0 on every run.
 *
 * @param {import('mongodb').Db} db
 * @param {Set<string>|string[]} seenJobIds
 * @returns {Promise<number>}
 */
export async function resetMissCounters(db, seenJobIds) {
    const ids = [...seenJobIds];
    if (ids.length === 0) return 0;

    const CHUNK = 10000;
    let modified = 0;

    for (let i = 0; i < ids.length; i += CHUNK) {
        const result = await db.collection(JOBS_COLLECTION).updateMany(
            { JobID: { $in: ids.slice(i, i + CHUNK) }, consecutiveMisses: { $gt: 0 } },
            { $set: { consecutiveMisses: 0 } },
        );
        modified += result.modifiedCount || 0;
    }

    return modified;
}

/**
 * Expires jobs that have been missing for MISS_THRESHOLD consecutive runs.
 *
 * Documents are marked expired rather than deleted: the frontend may still hold
 * links to them, and an expired row remains auditable.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<number>}
 */
export async function expireStaleJobs(db) {
    const result = await db.collection(JOBS_COLLECTION).updateMany(
        { Status: 'active', consecutiveMisses: { $gte: MISS_THRESHOLD } },
        { $set: { Status: 'expired', expiredAt: new Date() } },
    );

    return result.modifiedCount || 0;
}

/** Index supporting the expiry sweep. Safe to call every run. */
export async function ensureExpiryIndexes(db) {
    await db.collection(JOBS_COLLECTION).createIndex(
        { Status: 1, consecutiveMisses: 1 },
        { name: 'Status_misses' },
    );
}
