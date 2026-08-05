// ─── Teamtailor ────────────────────────────────────────────────────────────────
//
// Feed: GET https://{slug}.teamtailor.com/jobs.json  (JSON Feed v1.1)
// One request returns the entire published board with full descriptions. No
// pagination, no auth.
//
// The feed does NOT publish: department, employmentType, jobLocationType or any
// remote flag. Workplace type therefore has to be inferred from the title and
// location text, which is the only signal available. baseSalary appears on a
// minority of postings.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeCountry, normalizeEmploymentType, normalizeWorkplaceType } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'teamtailor';

const REQUEST_DELAY_MS = 300;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;

// schema.org QuantitativeValue.unitText → the shared interval vocabulary
const SALARY_UNIT_TO_INTERVAL = {
    YEAR: 'per-year-salary',
    MONTH: 'per-month-salary',
    HOUR: 'per-hour-wage',
};

export const COMPANY_SLUGS = [
    'teamviewer',
    'grouponede',
    'roccofortehotelsgermany',
    'leaseweb',
    'cacustomeralliancegmbh',
    'teamlewis',
    'mintos',
    'tibber',
    'polestar',
    'securitas',
    'bryter',
    'oatly',
    'esker',
    'raidboxes',

    // --- REMOTE EXPANSION 2026-08-04 ---
    'chip', 'monese',

    // --- DISCOVERED 2026-08-04 ---
    'jobandtalent', 'fuse', 'match', 'almond', 'groundcontrol', 'ember',
    'basalt', 'payfit', 'butter', 'remarkable', 'arc', 'flower',
    'spacelift', 'switchboard', 'tobii', 'storytel', 'vipps', 'lunar',
    'bambuser', 'replika', 'pylon', 'sullyai', 'podimo', 'genius',
    'picnic', 'fishbrain', 'joy', 'wave', 'banner', 'axis',
    'salt', 'semaphore', 'templafy', 'paystack', 'sweep', 'getaccept',
    'hive', 'checkr', 'hent', 'presto', 'grain', 'bamboo',
    'constant', 'waypoint', 'dialect', 'valinktherapeutics', 'enso', 'converge',

    // --- DISCOVERED 2026-08-04 ---
    'sweet', 'fresha', 'next', 'key', 'bios', 'thrive',
    'loft', 'five', 'sendcloud', 'spectrocloud', 'color', 'rho',
    'dharma', 'sigma', 'anima', 'varnish-software', 'level', 'lead',
    'puzzle', 'dbt', 'lightyear', 'scalr',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Full feed URL for a slug. A bare custom domain is accepted too. */
function buildFeedUrl(boardName) {
    const host = boardName.includes('.') ? boardName : `${boardName}.teamtailor.com`;
    return `https://${host}/jobs.json`;
}

/** First jobLocation address block, or null. */
function getPrimaryAddress(job) {
    const locations = job?._jobposting?.jobLocation;
    if (!Array.isArray(locations) || locations.length === 0) return null;
    return locations[0]?.address || null;
}

/** Every jobLocation address block (feeds may list several). */
function getAllAddresses(job) {
    const locations = job?._jobposting?.jobLocation;
    return Array.isArray(locations) ? locations.map(loc => loc?.address).filter(Boolean) : [];
}

/** "Berlin, DE" from an address block; falls back to whichever part exists. */
function formatAddress(address) {
    if (!address) return null;
    const parts = [address.addressLocality, address.addressCountry].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
}

function getSalaryValue(job) {
    return job?._jobposting?.baseSalary?.value || null;
}

/** Coerce a schema.org numeric-or-string amount to a finite number, else null. */
function toAmount(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every career site. No location filtering.
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
/**
 * Fetches one company's board. Returns its jobs, or [] on any failure.
 *
 * Exported so the incremental pipeline can hash and compare a single company
 * before deciding whether to process it. fetchAllJobs() is a thin fan-out over
 * this.
 *
 * @param {string} boardName
 * @returns {Promise<object[]>}
 */
export async function fetchCompanyJobs(boardName) {
    console.log(`[Teamtailor] Fetching: ${boardName}...`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(buildFeedUrl(boardName), { signal: controller.signal });

        if (!response.ok) {
            return [];
        }

        // A renamed career site can answer 200 with an HTML error page, so
        // the parse is guarded rather than the status trusted alone.
        let data;
        try {
            data = await response.json();
        } catch {
            console.warn(`[Teamtailor] ${boardName}: response was not valid JSON`);
            return [];
        }

        const items = Array.isArray(data?.items) ? data.items : [];
        console.log(`[Teamtailor] ${boardName}: ${items.length} jobs fetched`);

        if (items.length === 0) return [];

        // Kept per worker: paces this slot's next request.
        await sleep(REQUEST_DELAY_MS);

        return items.map(job => ({
            ...job,
            _boardName: boardName,
            _feedTitle: data?.title || null,
        }));

    } catch (error) {
        console.error(`[Teamtailor] ${boardName}: ${error.message}`);
        return [];
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetches every job from every board. No location filtering.
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    console.log(`[Teamtailor] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    const allJobs = collectFulfilled(await runConcurrent(slugList, fetchCompanyJobs, FETCH_CONCURRENCY));

    console.log(`[Teamtailor] ${allJobs.length} jobs fetched in total`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    // identifier.value is the stable numeric posting id; item.id is a uuid that
    // also identifies the posting, so it is a safe fallback.
    const rawId = job?._jobposting?.identifier?.value ?? job?.id;
    return `teamtailor_${job._boardName}_${rawId}`;
}

export function extractJobTitle(job) {
    return job?.title || job?._jobposting?.title || '';
}

export function extractCompany(job) {
    const fromPosting = job?._jobposting?.hiringOrganization?.name;
    if (fromPosting) return fromPosting;
    if (job?._feedTitle) return job._feedTitle;

    return String(job._boardName || '')
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function extractLocation(job) {
    const formatted = getAllAddresses(job).map(formatAddress).filter(Boolean);
    if (formatted.length > 0) return [...new Set(formatted)].join(', ');
    return '';
}

export function extractAllLocations(job) {
    return normalizeArray(getAllAddresses(job).map(formatAddress));
}

export function extractCountry(job) {
    return normalizeCountry(getPrimaryAddress(job)?.addressCountry);
}

export function extractDescription(job) {
    return StripHtml(job?.content_html || job?._jobposting?.description || '');
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(job?.content_html || job?._jobposting?.description || '');
}

export function extractURL(job) {
    return job?.url || null;
}

export function extractDirectApplyURL(job) {
    return job?.url || null;
}

export function extractPostedDate(job) {
    return job?.date_published || job?._jobposting?.datePosted || null;
}

/** Not published in the JSON feed — see the header note. */
export function extractDepartment() {
    return 'N/A';
}

export function extractEmploymentType(job) {
    return normalizeEmploymentType(job?._jobposting?.employmentType);
}

/** No jobLocationType in the feed — inferred from the only text there is. */
export function extractWorkplaceType(job) {
    return normalizeWorkplaceType(`${job?.title || ''} ${extractLocation(job)}`);
}

export function extractIsRemote(job) {
    return extractWorkplaceType(job) === 'Remote';
}

export function extractTags(job) {
    const address = getPrimaryAddress(job);
    return normalizeArray([address?.addressLocality, address?.addressRegion]);
}

export function extractSalaryCurrency(job) {
    return job?._jobposting?.baseSalary?.currency || null;
}

export function extractSalaryMin(job) {
    // Amounts arrive as strings ("127000") in the live feed.
    return toAmount(getSalaryValue(job)?.minValue);
}

export function extractSalaryMax(job) {
    return toAmount(getSalaryValue(job)?.maxValue);
}

export function extractSalaryInterval(job) {
    const unit = getSalaryValue(job)?.unitText;
    if (!unit) return null;
    return SALARY_UNIT_TO_INTERVAL[String(unit).toUpperCase()] || null;
}

export function extractATSPlatform() {
    return 'teamtailor';
}
