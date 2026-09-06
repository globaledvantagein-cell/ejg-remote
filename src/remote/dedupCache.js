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

// Jobs the location filter has already thrown out. remoteJobs only ever holds
// displayable rows, so a rejected job leaves no trace there — and on the next
// run the scraper, having forgotten it, saves it again. That loop is why
// "Remote · United States" postings kept reappearing after every cleanup.
//
// This collection is the memory of the rejection: three tiny fields per job,
// merged into the same Sets the dedup checks already consult, so a job rejected
// once is silently skipped forever after. A TTL of one year lets a posting that
// has genuinely left the ATS become eligible again rather than blacklisting an
// ID for all time.
const REJECT_COLLECTION = 'remoteRejectCache';

/**
 * Loads every remembered rejection.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<{rejectedJobIds: Set<string>, rejectedDedupKeys: Set<string>}>}
 */
export async function loadRejectCache(db) {
    const docs = await db.collection(REJECT_COLLECTION)
        .find({}, { projection: { JobID: 1, dedupKey: 1 } })
        .toArray();

    const rejectedJobIds = new Set();
    const rejectedDedupKeys = new Set();

    for (const doc of docs) {
        if (doc.JobID) rejectedJobIds.add(doc.JobID);
        if (doc.dedupKey) rejectedDedupKeys.add(doc.dedupKey);
    }

    return { rejectedJobIds, rejectedDedupKeys };
}

/**
 * Loads every active job's dedupKey and JobID into two Sets, then folds the
 * remembered rejections into the same two Sets.
 *
 * Merging rather than keeping them apart is deliberate: "already stored" and
 * "already rejected" both mean "do not save this", so every caller of
 * isDuplicate() and isExistingJobId() gets the rejection memory for free and no
 * other code has to learn that the second collection exists.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<{dedupKeys: Set<string>, jobIds: Set<string>}>}
 */
export async function loadDedupCache(db) {
    const [docs, rejects] = await Promise.all([
        db.collection(JOBS_COLLECTION)
            .find({ Status: 'active' }, { projection: { dedupKey: 1, JobID: 1 } })
            .toArray(),
        loadRejectCache(db),
    ]);

    const dedupKeys = new Set();
    const jobIds = new Set();

    for (const doc of docs) {
        if (doc.dedupKey) dedupKeys.add(doc.dedupKey);
        if (doc.JobID) jobIds.add(doc.JobID);
    }

    const activeCount = jobIds.size;

    for (const id of rejects.rejectedJobIds) jobIds.add(id);
    for (const key of rejects.rejectedDedupKeys) dedupKeys.add(key);

    console.log(
        `[DedupCache] Loaded ${activeCount} active job IDs + ${rejects.rejectedJobIds.size} rejected IDs = ${jobIds.size} total`,
    );
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

/**
 * Remembers one rejection, in the database and in RAM.
 *
 * The upsert is keyed on JobID so re-running a scrape — or a cleanup migration
 * over jobs already recorded — is idempotent rather than a duplicate-key error.
 *
 * The in-memory Sets are updated too: without that, a company posting the same
 * geo-locked role twice in one run would have the second copy sail through, the
 * write that would have blocked it not yet being visible to this process.
 *
 * @param {import('mongodb').Db} db
 * @param {string} jobId
 * @param {string} dedupKey
 * @param {{dedupKeys: Set<string>, jobIds: Set<string>}} [cache]
 */
export async function saveRejection(db, jobId, dedupKey, cache) {
    if (!jobId) return null;

    const result = await db.collection(REJECT_COLLECTION).updateOne(
        { JobID: jobId },
        { $set: { JobID: jobId, dedupKey: dedupKey ?? null }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
    );

    if (cache) addToCache(cache, dedupKey, jobId);
    return result;
}

/**
 * Batch form of saveRejection. A run can reject hundreds of jobs per company,
 * and one round-trip each would reintroduce exactly the per-job chatter this
 * module exists to remove.
 *
 * ordered:false for the same reason as the job bulk writer: a collision on one
 * JobID must not discard every write queued behind it.
 *
 * @param {import('mongodb').Db} db
 * @param {Array<{jobId: string, dedupKey?: string}>} rejections
 */
export async function saveRejectionsBulk(db, rejections, cache) {
    if (!Array.isArray(rejections) || rejections.length === 0) return null;

    const now = new Date();
    const seen = new Set();
    const operations = [];

    for (const { jobId, dedupKey } of rejections) {
        // A duplicate JobID inside one bulkWrite is an error on some server
        // versions, and pointless work on the rest.
        if (!jobId || seen.has(jobId)) continue;
        seen.add(jobId);

        operations.push({
            updateOne: {
                filter: { JobID: jobId },
                update: {
                    $set: { JobID: jobId, dedupKey: dedupKey ?? null },
                    $setOnInsert: { createdAt: now },
                },
                upsert: true,
            },
        });

        if (cache) addToCache(cache, dedupKey, jobId);
    }

    if (operations.length === 0) return null;

    try {
        return await db.collection(REJECT_COLLECTION).bulkWrite(operations, { ordered: false });
    } catch (error) {
        // The non-colliding upserts have already applied; losing the run over a
        // duplicate-key race would be worse than the incomplete batch.
        console.error(`[DedupCache] Reject cache write partially failed — ${error.message}`);
        return error?.result ?? null;
    }
}

/**
 * Creates the reject cache's indexes. Safe to call on every startup — index
 * creation is a no-op once they exist.
 *
 * The TTL is the important one: it caps the collection's growth and, more to
 * the point, stops a one-off rejection from banning an ID permanently.
 */
export async function ensureRejectCacheIndexes(db) {
    const collection = db.collection(REJECT_COLLECTION);

    await collection.createIndex({ JobID: 1 }, { unique: true, name: 'jobId_unique' });
    await collection.createIndex({ dedupKey: 1 }, { name: 'dedupKey_idx' });
    await collection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 365 * 24 * 60 * 60, name: 'createdAt_ttl' },
    );
}
