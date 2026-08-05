// ─── Merge per-platform discovery files ────────────────────────────────────────
//
// Parallel discovery runs write disc-<platform>.json each, because seven
// processes sharing one file would race on read-modify-write. This folds them
// (plus any existing discovered-slugs.json) into the single file that
// add-discovered-slugs.js consumes.
//
// Usage:
//   node src/scripts/merge-discovered.js
//   node src/scripts/merge-discovered.js --pattern=disc-   # non-default prefix

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TARGET = path.join(ROOT, 'discovered-slugs.json');

const PLATFORMS = ['greenhouse', 'ashby', 'lever', 'recruitee', 'teamtailor', 'smartrecruiters', 'personio'];

const prefix = process.argv.slice(2).find(a => a.startsWith('--pattern='))?.split('=')[1] || 'disc-';

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** Stable identity for an entry: the string itself, or a Personio subdomain. */
function keyOf(entry) {
    return String(typeof entry === 'string' ? entry : entry?.subdomain ?? '').toLowerCase();
}

const merged = {};
for (const platform of PLATFORMS) merged[platform] = new Map();

// Seed from the existing combined file so earlier findings are never dropped.
const existing = readJson(TARGET);
if (existing) {
    for (const platform of PLATFORMS) {
        for (const entry of existing[platform] || []) {
            if (keyOf(entry)) merged[platform].set(keyOf(entry), entry);
        }
    }
    console.log('[merge] seeded from existing discovered-slugs.json');
}

let filesRead = 0;

for (const file of fs.readdirSync(ROOT)) {
    if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;

    const data = readJson(path.join(ROOT, file));
    if (!data) {
        console.warn(`[merge] ${file}: unreadable or incomplete — skipped`);
        continue;
    }

    filesRead++;
    let added = 0;

    for (const platform of PLATFORMS) {
        for (const entry of data[platform] || []) {
            const key = keyOf(entry);
            if (!key || merged[platform].has(key)) continue;
            merged[platform].set(key, entry);
            added++;
        }
    }

    console.log(`[merge] ${file.padEnd(28)} +${added}`);
}

const output = {};
let total = 0;
for (const platform of PLATFORMS) {
    output[platform] = [...merged[platform].values()];
    total += output[platform].length;
}

output.stats = {
    mergedFrom: filesRead,
    found: total,
    timestamp: new Date().toISOString(),
};

fs.writeFileSync(TARGET, `${JSON.stringify(output, null, 2)}\n`);

console.log('\n─────────────────────────────────────────────');
for (const platform of PLATFORMS) {
    console.log(`[merge] ${platform.padEnd(16)} ${output[platform].length}`);
}
console.log(`[merge] total ${total} across ${filesRead} files → discovered-slugs.json`);
console.log('─────────────────────────────────────────────');
