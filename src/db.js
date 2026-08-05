import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/job-scraper';

export const client = new MongoClient(MONGO_URI);

let db;

/**
 * Connects to MongoDB and returns the `job-scraper` database handle.
 * Idempotent — repeated calls reuse the same connection.
 *
 * Deliberately minimal compared to the German pipeline's connection.js: no
 * Mongoose. Unlike the `jobs` collection, whose indexes are owned by the main
 * pipeline, `remoteJobs` belongs to this process, so its indexes are created
 * here.
 *
 * @returns {Promise<import('mongodb').Db>}
 */
export async function connectToDb() {
    if (db) return db;

    await client.connect();
    db = client.db('job-scraper');

    console.log('[Remote Scraper] Connected to MongoDB.');

    await ensureIndexes(db);

    return db;
}

/**
 * Creates the indexes `remoteJobs` needs. createIndex is idempotent, so this is
 * safe on every run; it only does work the first time.
 *
 * JobID is unique because saveRemoteJob treats it as the identity of a posting
 * — the index is what makes that guarantee hold under concurrent writes rather
 * than merely by convention. Status is queried on its own when listing active
 * jobs, so it gets a plain index.
 *
 * @param {import('mongodb').Db} database
 */
async function ensureIndexes(database) {
    const remoteJobs = database.collection('remoteJobs');

    await remoteJobs.createIndex({ JobID: 1 }, { unique: true, name: 'JobID_unique' });
    await remoteJobs.createIndex({ Status: 1 }, { name: 'Status_1' });

    console.log('[Remote Scraper] Indexes ensured on remoteJobs.');
}
