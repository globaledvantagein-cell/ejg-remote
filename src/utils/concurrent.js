// ─── Concurrent runner ─────────────────────────────────────────────────────────
//
// A counter-based semaphore. N workers share one cursor into the item list; each
// takes the next index, awaits its task, then immediately takes another. That
// keeps all N slots busy for the whole run, unlike a batching approach where a
// single slow item stalls its entire batch while the other slots idle.
//
// No dependencies — the only primitives are a shared integer and Promise.all
// over the worker loops.

const DEFAULT_CONCURRENCY = 5;

/**
 * Runs `workerFn` over `items` with at most `concurrency` in flight at once.
 *
 * Never rejects. Each task is settled individually, so one failure neither
 * cancels its siblings nor aborts the run — the caller decides what a rejection
 * means by inspecting the result entries.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} workerFn
 * @param {number} [concurrency=5]
 * @returns {Promise<Array<{status:'fulfilled', value:R}|{status:'rejected', reason:any}>>}
 *          One entry per item, in the order of `items` — not completion order.
 */
export async function runConcurrent(items, workerFn, concurrency = DEFAULT_CONCURRENCY) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const results = new Array(list.length);
    let cursor = 0;

    // One worker loop. Claims indices until the list is exhausted. `cursor++` is
    // atomic here because JS runs this synchronously between awaits, so no two
    // workers can ever claim the same index.
    async function worker() {
        while (cursor < list.length) {
            const index = cursor++;
            const [settled] = await Promise.allSettled([workerFn(list[index], index)]);
            results[index] = settled;
        }
    }

    // Never spawn more workers than there is work.
    const workerCount = Math.max(1, Math.min(concurrency, list.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    return results;
}

/**
 * Convenience wrapper for the common case: flatten every fulfilled result that
 * returned an array, discarding rejections (the worker is expected to have
 * logged them already).
 *
 * @template T
 * @param {Array<{status:string, value?:T[]}>} settledResults
 * @returns {T[]}
 */
export function collectFulfilled(settledResults) {
    const collected = [];

    for (const result of settledResults) {
        if (result?.status === 'fulfilled' && Array.isArray(result.value)) {
            collected.push(...result.value);
        }
    }

    return collected;
}
