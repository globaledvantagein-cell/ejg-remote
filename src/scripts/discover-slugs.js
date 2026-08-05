// ─── Slug discovery ────────────────────────────────────────────────────────────
//
// Greenhouse, Ashby and Lever all expose an unauthenticated board endpoint that
// answers 200 for a real slug and 404 for anything else. That makes slug
// discovery a pure probing problem: generate plausible slugs, ask, keep the
// hits.
//
// Two-stage probe, because a 200 does not by itself mean the board is worth
// adding:
//   1. HEAD  — cheap existence check. ~90% of candidates die here having
//              transferred no body at all.
//   2. GET   — only for the HEAD survivors, to count open jobs. A board that
//              exists but lists nothing costs a request on every scraper run
//              forever, so by default those are dropped (--include-empty keeps
//              them).
//
// Usage:
//   node src/scripts/discover-slugs.js                    # all three platforms
//   node src/scripts/discover-slugs.js --ats=greenhouse   # one platform
//   node src/scripts/discover-slugs.js --no-yc            # skip the YC source
//   node src/scripts/discover-slugs.js --include-empty    # keep 0-job boards
//   node src/scripts/discover-slugs.js --limit=200        # cap candidates (test)

import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runConcurrent } from '../utils/concurrent.js';
import { COMPANY_NAMES } from './companyNames.js';

import * as greenhouse from '../ats/greenhouse.js';
import * as ashby from '../ats/ashby.js';
import * as lever from '../ats/lever.js';
import * as recruitee from '../ats/recruitee.js';
import * as teamtailor from '../ats/teamtailor.js';
import * as smartRecruiters from '../ats/smartRecruiters.js';
import * as personio from '../ats/personio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.resolve(HERE, '../../discovered-slugs.json');

// --out lets parallel per-platform runs write to separate files. Seven processes
// sharing one file would race on read-modify-write no matter how carefully the
// merge is written; separate files sidestep it entirely and merge-slugs.js
// folds them together afterwards.
const outFlag = process.argv.slice(2).find(a => a.startsWith('--out='))?.split('=')[1];
const OUTPUT_FILE = outFlag ? path.resolve(process.cwd(), outFlag) : DEFAULT_OUTPUT;

// Default 10. Latency-bound platforms (Recruitee answers in 1-10s) finish
// proportionally faster at a higher setting without sending more requests per
// second than the API is already serving.
// Every candidate ever probed and found dead is remembered here, so repeat runs
// spend their requests on genuinely new slugs instead of re-confirming tens of
// thousands of 404s. This is the single biggest saving across runs.
const CACHE_FILE = path.resolve(HERE, '../../probed-cache.json');

const CONCURRENCY_FLAG = process.argv.slice(2).find(a => a.startsWith('--concurrency='))?.split('=')[1];
const CONCURRENCY = Number(CONCURRENCY_FLAG) > 0 ? Number(CONCURRENCY_FLAG) : 10;
const PROBE_DELAY_MS = 100;   // per worker, after each probe
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const YC_API = 'https://yc-oss.github.io/api/companies/all.json';

// Source 4: common English words. Many boards are a single dictionary word
// ('make', 'later', 'route', 'fleet', 'axis' all turned up as real boards), and
// no company-name list will ever contain them. Probed verbatim — running these
// through slugVariants would only generate noise like 'makejobs'.
// Frequency-ordered, ~44k usable words after length filtering. Frequency order
// matters: the common head of the list is where the hits are (a real company is
// far likelier to be called "Bloom" than "Zygote"), and the probe cache means
// re-running against a longer list only costs the words never tried before.
// Format is "word count" per line; the parser takes the first token, so a plain
// one-word-per-line list works unchanged.
const WORDLIST_API = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt';

// Tier 3: the full English dictionary, ~348k usable words. Hit rate in this tail
// is far lower than the frequency-ordered list, but the probe cache means only
// the words never tried before cost a request, so the marginal yield is free of
// the marginal cost of re-testing. Enabled with --big-words.
const BIG_WORDLIST_API = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

// Public-company registries. Real trading names, free, no auth — a source of
// company names that no startup-oriented list contains.
const COMPANY_DATASETS = [
    { name: 'SEC EDGAR', url: 'https://www.sec.gov/files/company_tickers.json',
      parse: (json) => Object.values(json).map(e => e.title).filter(Boolean) },
    { name: 'Nasdaq', url: 'https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nasdaq/nasdaq_full_tickers.json',
      parse: (json) => json.map(e => e.name).filter(Boolean) },
];

// YC tags its companies with regions; these are the ones whose jobs can clear
// the scraper's country whitelist.
const ALLOWED_REGIONS = [
    'united states of america', 'america / canada', 'canada', 'united kingdom',
    'australia', 'new zealand', 'ireland', 'singapore', 'remote',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Platform definitions ─────────────────────────────────────────────────────

// `existsVia` is per-platform because HEAD is not universally safe:
//   HEAD — the API answers 200/404 honestly and cheaply.
//   GET  — the API either rejects HEAD outright (Teamtailor throws on a *valid*
//          board, so HEAD there would silently discard good slugs) or answers
//          200 for everything (SmartRecruiters returns 200 for any company id,
//          so only a non-empty body proves the board is real).
const PLATFORMS = {
    greenhouse: {
        module: greenhouse,
        url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
        countJobs: (data) => (Array.isArray(data?.jobs) ? data.jobs.length : 0),
        // Greenhouse tokens are lowercase; probing mixed case just wastes requests.
        caseStyle: 'lower',
        existsVia: 'HEAD',
    },
    ashby: {
        module: ashby,
        url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
        countJobs: (data) => (Array.isArray(data?.jobs) ? data.jobs.length : 0),
        // Ashby board names are the company's display name, case preserved.
        caseStyle: 'preserve',
        existsVia: 'HEAD',
    },
    lever: {
        module: lever,
        url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
        countJobs: (data) => (Array.isArray(data) ? data.length : 0),
        caseStyle: 'lower',
        existsVia: 'HEAD',
    },
    recruitee: {
        module: recruitee,
        url: (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
        countJobs: (data) => (Array.isArray(data?.offers)
            ? data.offers.filter(o => !o.status || o.status === 'published').length
            : 0),
        caseStyle: 'lower',
        existsVia: 'HEAD',
        // Recruitee answers in 3-18s; the default 15s timeout aborts live
        // boards mid-response and reports them as nonexistent.
        timeoutMs: 45000,
    },
    teamtailor: {
        module: teamtailor,
        url: (slug) => `https://${encodeURIComponent(slug)}.teamtailor.com/jobs.json`,
        countJobs: (data) => (Array.isArray(data?.items) ? data.items.length : 0),
        caseStyle: 'lower',
        existsVia: 'GET',   // HEAD throws on valid boards
    },
    smartrecruiters: {
        module: smartRecruiters,
        url: (slug) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=10`,
        countJobs: (data) => (Array.isArray(data?.content) ? (data.totalFound ?? data.content.length) : 0),
        // Company ids are mixed case: 'BoschGroup', 'ScalableGmbH'.
        caseStyle: 'preserve',
        existsVia: 'GET',   // answers 200 for any id — only a non-empty body counts
    },
    personio: {
        module: personio,
        // Personio entries are { subdomain, tld }. Candidates are carried as
        // "subdomain|tld" strings and converted back on output.
        objectSlug: true,
        url: (slug) => {
            const [subdomain, tld] = String(slug).split('|');
            return `https://${encodeURIComponent(subdomain)}.jobs.personio.${tld}/xml?language=en`;
        },
        // XML, not JSON — a real feed contains at least one <position> block.
        isXml: true,
        countJobs: (text) => (String(text).match(/<position>/g) || []).length,
        caseStyle: 'lower',
        existsVia: 'GET',
        expand: (slug) => [`${slug}|de`, `${slug}|com`],
        toEntry: (slug) => {
            const [subdomain, tld] = String(slug).split('|');
            return { subdomain, tld };
        },
    },
};

// ─── Candidate generation ─────────────────────────────────────────────────────

/** Strips accents/punctuation and collapses whitespace. */
function cleanName(name) {
    return String(name || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * True when the name is plausibly an English-market company. Rejects anything
 * carrying CJK, Cyrillic, Arabic, Hebrew, Thai or Devanagari characters — those
 * boards will not post English-language roles in whitelisted countries.
 */
function isLikelyEnglish(name) {
    return !/[　-鿿가-힯Ѐ-ӿ֐-׿؀-ۿ฀-๿ऀ-ॿ]/.test(String(name || ''));
}

/**
 * Slug variants for one company name. Ordered cheapest-signal first, though all
 * are probed. Deduplicated, and empty/1-char results dropped.
 */
export function slugVariants(name, caseStyle = 'lower', core = false) {
    const clean = cleanName(name);
    if (!clean) return [];

    const words = clean.split(' ');
    const joined = words.join('');
    const hyphen = words.join('-');
    const underscore = words.join('_');

    // Core forms carried ~90% of the hits in the first full run; the suffix and
    // drop-last forms are a long tail that triples the probe count for a handful
    // of extra boards. --core trades that tail for a ~3x faster sweep.
    const base = core
        ? [joined, hyphen]
        : [joined, hyphen, underscore, `${joined}jobs`, `${joined}-jobs`, `${joined}careers`, `${joined}-careers`];

    // A trailing "Inc"/"Labs"/"AI" is often absent from the board token.
    if (!core && words.length > 1) {
        const dropLast = words.slice(0, -1);
        base.push(dropLast.join(''), dropLast.join('-'));
    }

    const cased = caseStyle === 'preserve'
        // Ashby: probe the display-name forms as written plus a lowercase pass.
        ? [...base, ...base.map(s => s.toLowerCase())]
        : base.map(s => s.toLowerCase());

    return [...new Set(cased)].filter(s => s.length > 1);
}

/** Fetches the common-English wordlist, trimmed to plausible slug lengths. */
async function fetchCompanyDatasets() {
    const names = [];
    for (const source of COMPANY_DATASETS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(source.url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
            if (!response.ok) {
                console.warn(`[discover] ${source.name}: HTTP ${response.status} — skipped`);
                continue;
            }
            const parsed = source.parse(await response.json());
            console.log(`[discover] ${source.name}: ${parsed.length} company names`);
            names.push(...parsed);
        } catch (error) {
            console.warn(`[discover] ${source.name}: ${error.message} — skipped`);
        } finally {
            clearTimeout(timer);
        }
    }
    return names;
}

async function fetchWordlist(useBig = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(useBig ? BIG_WORDLIST_API : WORDLIST_API, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
        if (!response.ok) {
            console.warn(`[discover] wordlist returned HTTP ${response.status} — skipping`);
            return [];
        }
        const words = (await response.text())
            .split(/\r?\n/)
            // "word 12345" → "word"; a bare word list is unaffected.
            .map(line => line.trim().split(/\s+/)[0].toLowerCase())
            .filter(w => /^[a-z]{4,14}$/.test(w));
        console.log(`[discover] wordlist: ${words.length} words`);
        return words;
    } catch (error) {
        console.warn(`[discover] wordlist unreachable (${error.message}) — skipping`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/** Fetches the YC directory, filtered to plausible English-market companies. */
async function fetchYcCompanies() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(YC_API, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
        if (!response.ok) {
            console.warn(`[discover] YC API returned HTTP ${response.status} — continuing without it`);
            return [];
        }

        const all = await response.json();
        if (!Array.isArray(all)) {
            console.warn('[discover] YC API payload was not an array — continuing without it');
            return [];
        }

        const kept = all.filter((company) => {
            if (!company?.name || !isLikelyEnglish(company.name)) return false;
            // Dead companies do not have job boards.
            if (String(company.status || '').toLowerCase() === 'inactive') return false;

            const regions = (company.regions || []).map(r => String(r).toLowerCase());
            return regions.length === 0 || regions.some(r => ALLOWED_REGIONS.includes(r));
        });

        console.log(`[discover] YC: ${kept.length} eligible of ${all.length} companies`);
        return kept.map(c => c.name);

    } catch (error) {
        console.warn(`[discover] YC API unreachable (${error.message}) — continuing without it`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

// ─── Probing ──────────────────────────────────────────────────────────────────

async function request(url, method, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method,
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Stage 1: does this board exist?
 *
 * On HEAD platforms this is a status check with no body transferred. On GET
 * platforms it degrades to the full stage-2 count, which stage 2 then reuses —
 * so those platforms pay for one request per candidate, not two.
 */
async function probeExists(platform, slug) {
    const config = PLATFORMS[platform];

    if (config.existsVia === 'GET') {
        const count = await probeJobCount(platform, slug);
        return count > 0 ? { exists: true, count } : { exists: false };
    }

    try {
        const response = await request(config.url(slug), 'HEAD', config.timeoutMs);
        return { exists: response.status === 200 };
    } catch {
        return { exists: false };
    } finally {
        await sleep(PROBE_DELAY_MS);
    }
}

/** Stage 2: how many jobs does it list? -1 when the body could not be read. */
async function probeJobCount(platform, slug) {
    const config = PLATFORMS[platform];
    try {
        const response = await request(config.url(slug), 'GET', config.timeoutMs);
        if (!response.ok) return -1;
        return config.isXml
            ? config.countJobs(await response.text())
            : config.countJobs(await response.json());
    } catch {
        return -1;
    } finally {
        await sleep(PROBE_DELAY_MS);
    }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * The probe cache: { platform: { dead: [...], empty: [...] } }.
 *   dead  — the endpoint 404'd. Nothing short of the company signing up changes
 *           that, so these are skipped permanently.
 *   empty — the board exists but listed no jobs. Skipped by default because it
 *           costs a request for nothing, but re-probeable with --retry-empty
 *           since a quiet board can post again.
 */
function readCache() {
    if (!fs.existsSync(CACHE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
        console.warn('[discover] probe cache unreadable — starting fresh');
        return {};
    }
}

function writeCache(platform, dead, empty) {
    // Re-read before writing: a parallel --ats run may have finished meanwhile.
    const cache = readCache();
    const prior = cache[platform] || { dead: [], empty: [] };

    cache[platform] = {
        dead: [...new Set([...(prior.dead || []), ...dead])],
        empty: [...new Set([...(prior.empty || []), ...empty])],
    };

    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache)}
`);
    return cache[platform];
}

/** Existing slugs for a platform, lowercased, for dedup. */
function existingSlugs(platform) {
    const slugs = PLATFORMS[platform].module.COMPANY_SLUGS || [];
    return new Set(slugs
        // Object-shaped entries (Personio) dedup on their identifying field.
        .map(s => (typeof s === 'string' ? s : s?.subdomain))
        .filter(Boolean)
        .map(s => String(s).toLowerCase()));
}

async function discoverPlatform(platform, names, options) {
    const config = PLATFORMS[platform];
    const { caseStyle } = config;
    const known = existingSlugs(platform);

    // Build the candidate set: every variant of every name, minus anything the
    // ATS file already carries. Deduped so one slug is probed once even when
    // several company names generate it.
    const candidates = new Set();

    // Raw words are probed verbatim — see WORDLIST_API note.
    for (const word of (options.rawNames || [])) {
        if (!known.has(word.toLowerCase())) {
            for (const probeSlug of (config.expand ? config.expand(word) : [word])) candidates.add(probeSlug);
        }
    }

    for (const name of names) {
        for (const variant of slugVariants(name, caseStyle, options.core)) {
            // For Personio the dedup key is the subdomain, before tld expansion.
            if (known.has(variant.toLowerCase())) continue;
            for (const probeSlug of (config.expand ? config.expand(variant) : [variant])) {
                candidates.add(probeSlug);
            }
        }
    }

    // Drop anything already proven dead, and — unless --retry-empty — anything
    // proven to be a live-but-jobless board. This is what makes repeat runs
    // cheap: the corpus can grow freely while the probe count covers only what
    // has genuinely never been tested.
    const cached = readCache()[platform] || { dead: [], empty: [] };
    const skipSet = new Set([
        ...(cached.dead || []),
        ...(options.retryEmpty ? [] : (cached.empty || [])),
    ]);

    const generated = candidates.size;
    let list = [...candidates].filter(slug => !skipSet.has(slug));
    const skippedByCache = generated - list.length;

    if (options.limit) list = list.slice(0, options.limit);

    console.log(`\n[discover] ${platform}: probing ${list.length} candidates (${known.size} in file, ${skippedByCache} already tested — skipped)`);

    const t0 = Date.now();
    const existsResults = await runConcurrent(
        list,
        async (slug) => ({ slug, ...await probeExists(platform, slug) }),
        CONCURRENCY,
    );

    // GET-based platforms already have their count from stage 1; only HEAD
    // platforms need the second pass.
    const survivors = [];
    const preCounted = [];

    for (const result of existsResults) {
        if (result.status !== 'fulfilled' || !result.value.exists) continue;
        if (typeof result.value.count === 'number') preCounted.push(result.value);
        else survivors.push(result.value.slug);
    }

    console.log(`[discover] ${platform}: ${survivors.length + preCounted.length} boards exist (via ${config.existsVia})${survivors.length ? ' — counting jobs...' : ''}`);

    const countResults = await runConcurrent(
        survivors,
        async (slug) => ({ slug, count: await probeJobCount(platform, slug) }),
        CONCURRENCY,
    );

    const found = [];
    let emptyBoards = 0;

    const allCounted = [
        ...preCounted.map(v => ({ slug: v.slug, count: v.count })),
        ...countResults.filter(r => r.status === 'fulfilled').map(r => r.value),
    ];

    for (const { slug, count } of allCounted) {
        if (count > 0 || (options.includeEmpty && count === 0)) {
            found.push({ slug, count });
        } else if (count === 0) {
            emptyBoards++;
        }
    }

    found.sort((a, b) => b.count - a.count);

    // Everything probed this run that did not yield a usable board is recorded,
    // split by reason so a jobless board can be retried later but a 404 never is.
    const usableSet = new Set(found.map(f => f.slug));
    const countedSet = new Set(allCounted.map(c => c.slug));

    const newlyDead = list.filter(slug => !countedSet.has(slug));
    const newlyEmpty = allCounted.filter(c => !usableSet.has(c.slug)).map(c => c.slug);

    const totals = writeCache(platform, newlyDead, newlyEmpty);

    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[discover] ${platform}: cache now holds ${totals.dead.length} dead + ${totals.empty.length} empty slugs`);
    console.log(`[discover] ${platform}: ${found.length} usable, ${emptyBoards} existed but listed 0 jobs (dropped), ${seconds}s`);

    return { probed: list.length, found };
}

function parseArgs(argv) {
    const get = (flag) => argv.find(a => a.startsWith(`${flag}=`))?.split('=')[1];
    const atsArg = get('--ats');

    if (atsArg && !PLATFORMS[atsArg]) {
        throw new Error(`--ats=${atsArg} is not one of: ${Object.keys(PLATFORMS).join(', ')}`);
    }

    const limitRaw = get('--limit');
    const limit = limitRaw ? Number(limitRaw) : null;
    if (limitRaw && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error(`--limit=${limitRaw} must be a positive integer`);
    }

    return {
        platforms: atsArg ? [atsArg] : Object.keys(PLATFORMS),
        core: argv.includes('--core'),
        words: argv.includes('--words'),
        bigWords: argv.includes('--big-words'),
        companies: argv.includes('--companies'),
        onlyWords: argv.includes('--only-words'),
        retryEmpty: argv.includes('--retry-empty'),
        useYc: !argv.includes('--no-yc'),
        includeEmpty: argv.includes('--include-empty'),
        limit,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    console.log('─────────────────────────────────────────────');
    console.log(`[discover] platforms: ${options.platforms.join(', ')}`);

    const names = [...COMPANY_NAMES];
    console.log(`[discover] curated list: ${names.length} companies`);

    if (options.useYc) {
        names.push(...await fetchYcCompanies());
    } else {
        console.log('[discover] --no-yc: skipping the Y Combinator source');
    }

    let rawNames = [];
    if (options.words || options.onlyWords || options.bigWords) {
        rawNames = await fetchWordlist(options.bigWords);
    }
    if (options.companies) names.push(...await fetchCompanyDatasets());
    options.rawNames = rawNames;

    const uniqueNames = (options.onlyWords || options.bigWords) ? [] : [...new Set(names.filter(isLikelyEnglish))];
    console.log(`[discover] ${uniqueNames.length} unique company names to expand into slugs`);

    /** Reads the results file fresh. Missing or corrupt reads as empty. */
    function readStore() {
        if (!fs.existsSync(OUTPUT_FILE)) return {};
        try {
            return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        } catch {
            console.warn('[discover] results file was unreadable — starting fresh');
            return {};
        }
    }

    const discoveries = new Map();
    let totalProbed = 0;

    for (const platform of options.platforms) {
        const config = PLATFORMS[platform];
        const { probed, found } = await discoverPlatform(platform, uniqueNames, options);
        totalProbed += probed;
        discoveries.set(platform, found.map(f => (config.toEntry ? config.toEntry(f.slug) : f.slug)));
    }

    // Re-read immediately before writing rather than reusing a snapshot taken at
    // startup. A --ats run of another platform may have finished while this one
    // was probing, and a stale snapshot would silently erase its results.
    const store = readStore();
    const output = {};

    for (const platform of Object.keys(PLATFORMS)) {
        const merged = new Map();
        for (const entry of store[platform] || []) {
            merged.set(JSON.stringify(entry).toLowerCase(), entry);
        }
        for (const entry of discoveries.get(platform) || []) {
            merged.set(JSON.stringify(entry).toLowerCase(), entry);
        }
        output[platform] = [...merged.values()];
    }

    output.stats = {
        probed: totalProbed,
        found: Object.keys(PLATFORMS).reduce((sum, p) => sum + output[p].length, 0),
        timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

    console.log('\n─────────────────────────────────────────────');
    for (const platform of Object.keys(PLATFORMS)) {
        console.log(`[discover] ${platform.padEnd(16)} ${output[platform].length}`);
    }
    console.log(`[discover] probed ${totalProbed} candidates this run`);
    console.log(`[discover] written to ${OUTPUT_FILE}`);
    console.log('─────────────────────────────────────────────');
    console.log('\nNext step — add them to the ATS files:');
    console.log('  node src/scripts/add-discovered-slugs.js            # apply');
    console.log('  node src/scripts/add-discovered-slugs.js --dry-run  # preview first');
    console.log('─────────────────────────────────────────────');
}

// Only run when invoked directly. Importing this module (to reuse slugVariants,
// or to test it) must not kick off a discovery run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
