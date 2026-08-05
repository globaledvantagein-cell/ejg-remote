// ─── Dedup cache ───────────────────────────────────────────────────────────────
//
// The old pipeline issued one findOne per job to answer "have we seen this
// before?". At 60,000 jobs that is 60,000 round-trips, and it dominated the run.
//
// Both questions the pipeline asks are membership tests over a set that changes
// only through this process, so the whole answer fits in RAM: one query at
// startup, O(1) lookups thereafter.
//
//   dedupKeys — company+title+country. Catches the same role posted by the same
//               employer through two different ATS platforms.
//   jobIds    — the ATS's own identifier. Catches a posting we already store,
//               which needs its scrapedAt refreshed rather than a second copy.

const JOBS_COLLECTION = 'remoteJobs';

/**
 * Loads every active job's dedupKey and JobID into two Sets.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<{dedupKeys: Set<string>, jobIds: Set<string>}>}
 */
export async function loadDedupCache(db) {
    const docs = await db.collection(JOBS_COLLECTION)
        .find({ Status: 'active' }, { projection: { dedupKey: 1, JobID: 1 } })
        .toArray();

    const dedupKeys = new Set();
    const jobIds = new Set();

    for (const doc of docs) {
        if (doc.dedupKey) dedupKeys.add(doc.dedupKey);
        if (doc.JobID) jobIds.add(doc.JobID);
    }

    console.log(`[DedupCache] Loaded ${jobIds.size} job IDs, ${dedupKeys.size} dedup keys`);
    return { dedupKeys, jobIds };
}

/** True when another posting already occupies this company+title+country. */
export function isDuplicate(cache, dedupKey) {
    if (!dedupKey) return false;
    return cache.dedupKeys.has(dedupKey);
}

/** True when this exact posting is already stored. */
export function isExistingJobId(cache, jobId) {
    if (!jobId) return false;
    return cache.jobIds.has(jobId);
}

/**
 * Records a newly saved job so later jobs in the same run dedup against it.
 *
 * Without this, two identical postings arriving in one run would both pass the
 * duplicate check — the database write that would have blocked the second has
 * not been flushed yet.
 */
export function addToCache(cache, dedupKey, jobId) {
    if (dedupKey) cache.dedupKeys.add(dedupKey);
    if (jobId) cache.jobIds.add(jobId);
}
