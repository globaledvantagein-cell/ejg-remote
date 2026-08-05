// ─── Bulk saver ────────────────────────────────────────────────────────────────
//
// Collects writes and sends them in batches instead of one round-trip per job.
//
// Every flush uses `ordered: false`. Two reasons: MongoDB may execute the batch
// in parallel rather than strictly in sequence, and — more importantly here — a
// single failing operation does not abandon the rest of the batch. With an
// ordered batch, one duplicate-key collision on the unique JobID index would
// silently discard every remaining write behind it.

const JOBS_COLLECTION = 'remoteJobs';

/**
 * Flush threshold. Large enough that the round-trip cost is amortised, small
 * enough that the pending operations array cannot grow without bound across a
 * 60,000-job run.
 */
export const AUTO_FLUSH_SIZE = 500;

/** A fresh, empty write buffer. */
export function createBulkBuffer() {
    return {
        operations: [],
        savedCount: 0,
        updatedCount: 0,
        flushedOperations: 0,
        errorCount: 0,
    };
}

/** Queues an insert for a job we have never stored. */
export function addInsert(buffer, jobDoc) {
    const now = new Date();

    buffer.operations.push({
        insertOne: {
            document: {
                ...jobDoc,
                Status: 'active',
                jobScope: 'remote',
                approvalMethod: 'remote_auto',
                consecutiveMisses: 0,
                createdAt: now,
                scrapedAt: now,
            },
        },
    });

    buffer.savedCount++;
}

/**
 * Queues a freshness touch for a job we already store.
 *
 * consecutiveMisses is reset here as well as in the expiry pass: seeing the job
 * in the feed is itself proof it has not disappeared, and resetting at the point
 * of observation keeps the counter honest even if the later pass is skipped.
 */
export function addUpdate(buffer, jobId) {
    buffer.operations.push({
        updateOne: {
            filter: { JobID: jobId },
            update: { $set: { scrapedAt: new Date(), consecutiveMisses: 0 } },
        },
    });

    buffer.updatedCount++;
}

/**
 * Sends the queued operations, then empties the buffer.
 *
 * A MongoBulkWriteError is caught rather than thrown: with ordered:false the
 * successful operations in the batch have already been applied, and the usual
 * cause is a duplicate-key collision on JobID, which simply means another path
 * inserted the job first. Losing the whole run over that would be wrong.
 *
 * @param {import('mongodb').Db} db
 * @returns {Promise<object|null>} the driver result, or null when nothing queued
 */
export async function flushBuffer(db, buffer) {
    if (buffer.operations.length === 0) return null;

    const batch = buffer.operations;
    buffer.operations = [];

    try {
        const result = await db.collection(JOBS_COLLECTION).bulkWrite(batch, { ordered: false });

        const inserted = result.insertedCount || 0;
        const updated = result.modifiedCount || 0;
        buffer.flushedOperations += batch.length;

        console.log(`[BulkSaver] Flushed ${batch.length} operations (${inserted} inserted, ${updated} updated, 0 errors)`);
        return result;

    } catch (error) {
        // Partial success is the norm here, not an exception: the writes that
        // did not collide have been applied.
        const writeErrors = error?.writeErrors?.length ?? 0;
        const inserted = error?.result?.insertedCount ?? 0;
        const updated = error?.result?.modifiedCount ?? 0;

        buffer.flushedOperations += batch.length;
        buffer.errorCount += writeErrors || 1;

        console.log(`[BulkSaver] Flushed ${batch.length} operations (${inserted} inserted, ${updated} updated, ${writeErrors || 1} errors)`);
        return error?.result ?? null;
    }
}

/** Flushes only once the buffer has reached AUTO_FLUSH_SIZE. */
export async function flushIfFull(db, buffer) {
    if (buffer.operations.length >= AUTO_FLUSH_SIZE) {
        return flushBuffer(db, buffer);
    }
    return null;
}
