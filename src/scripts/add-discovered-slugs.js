// ─── Apply discovered slugs ────────────────────────────────────────────────────
//
// Reads discovered-slugs.json and appends the new slugs to each ATS file's
// COMPANY_SLUGS array under a dated banner.
//
// Idempotent: entries already present in the array (compared case-insensitively,
// since Ashby board names are mixed case) are skipped, so running this twice is
// a no-op the second time.
//
// Usage:
//   node src/scripts/add-discovered-slugs.js
//   node src/scripts/add-discovered-slugs.js --dry-run
//   node src/scripts/add-discovered-slugs.js --ats=greenhouse

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.resolve(HERE, '../../discovered-slugs.json');
const ATS_DIR = path.resolve(HERE, '../ats');

const PLATFORM_FILES = {
    greenhouse: 'greenhouse.js',
    ashby: 'ashby.js',
    lever: 'lever.js',
    recruitee: 'recruitee.js',
    teamtailor: 'teamtailor.js',
    smartrecruiters: 'smartRecruiters.js',
    personio: 'personio.js',
};

// Personio entries are { subdomain, tld } objects rather than bare strings.
const OBJECT_PLATFORMS = new Set(['personio']);

const SLUGS_PER_LINE = 6;
const OBJECTS_PER_LINE = 2;

/** The COMPANY_SLUGS array literal, captured so it can be rewritten in place. */
const ARRAY_PATTERN = /(export const COMPANY_SLUGS = \[)([\s\S]*?)(\n\];)/;

function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Every quoted string already inside the array, lowercased. Used for dedup —
 * deliberately not a JS parse, because the array also carries comments and this
 * only needs the string literals.
 */
function existingSlugs(arrayBody) {
    return new Set([...arrayBody.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1].toLowerCase()));
}

/** The value used to dedup an entry — the string itself, or its subdomain. */
function dedupKey(entry) {
    return String(typeof entry === 'string' ? entry : entry?.subdomain ?? '').toLowerCase();
}

function formatBlock(entries, isObjectPlatform) {
    const lines = [];

    if (isObjectPlatform) {
        for (let i = 0; i < entries.length; i += OBJECTS_PER_LINE) {
            const chunk = entries.slice(i, i + OBJECTS_PER_LINE)
                .map(e => `{ subdomain: '${e.subdomain}', tld: '${e.tld}' }`)
                .join(', ');
            lines.push(`    ${chunk},`);
        }
    } else {
        for (let i = 0; i < entries.length; i += SLUGS_PER_LINE) {
            lines.push(`    ${entries.slice(i, i + SLUGS_PER_LINE).map(s => `'${s}'`).join(', ')},`);
        }
    }

    return `\n\n    // --- DISCOVERED ${today()} ---\n${lines.join('\n')}`;
}

function parseArgs(argv) {
    const atsArg = argv.find(a => a.startsWith('--ats='))?.split('=')[1];

    if (atsArg && !PLATFORM_FILES[atsArg]) {
        throw new Error(`--ats=${atsArg} is not one of: ${Object.keys(PLATFORM_FILES).join(', ')}`);
    }

    return {
        platforms: atsArg ? [atsArg] : Object.keys(PLATFORM_FILES),
        dryRun: argv.includes('--dry-run'),
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`[add-slugs] ${INPUT_FILE} not found — run discover-slugs.js first.`);
        process.exit(1);
    }

    const discovered = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

    if (options.dryRun) console.log('[add-slugs] DRY RUN — no files will be written\n');

    let grandTotal = 0;

    for (const platform of options.platforms) {
        const candidates = discovered[platform] || [];
        const filePath = path.join(ATS_DIR, PLATFORM_FILES[platform]);

        if (candidates.length === 0) {
            console.log(`${platform.padEnd(12)} nothing discovered`);
            continue;
        }

        const source = fs.readFileSync(filePath, 'utf8');
        const match = source.match(ARRAY_PATTERN);

        if (!match) {
            console.error(`${platform.padEnd(12)} could not locate COMPANY_SLUGS — skipped`);
            continue;
        }

        const [, open, body, close] = match;
        const known = existingSlugs(body);

        // Dedup against the file AND within the candidate list itself.
        const seen = new Set();
        const fresh = candidates.filter((entry) => {
            const key = dedupKey(entry);
            if (!key || known.has(key) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (fresh.length === 0) {
            console.log(`${platform.padEnd(12)} all ${candidates.length} already present — no change`);
            continue;
        }

        grandTotal += fresh.length;
        console.log(`${platform.padEnd(12)} +${fresh.length} new (${candidates.length - fresh.length} already present) → ${known.size + fresh.length} total`);

        if (options.dryRun) {
            const preview = fresh.slice(0, 12).map(dedupKey).join(', ');
            console.log(`             ${preview}${fresh.length > 12 ? ` … +${fresh.length - 12} more` : ''}`);
            continue;
        }

        const block = formatBlock(fresh, OBJECT_PLATFORMS.has(platform));
        fs.writeFileSync(filePath, source.replace(ARRAY_PATTERN, `${open}${body}${block}${close}`));
    }

    console.log(`\n[add-slugs] ${options.dryRun ? 'would add' : 'added'} ${grandTotal} slugs`);

    if (!options.dryRun && grandTotal > 0) {
        console.log('[add-slugs] verify with: node --check src/ats/greenhouse.js && node src/index.js --limit=3');
    }
}

main();
