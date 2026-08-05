// ─── Personio ──────────────────────────────────────────────────────────────────
//
// Feed: GET https://{subdomain}.jobs.personio.{tld}/xml?language=en
// XML, not JSON. One request per company returns every published position with
// its full sectioned description and structured salary.
//
// Personio quirk: a feed with exactly one job returns <position> as an object
// rather than an array. The parser is configured to force both <position> and
// <jobDescription> to arrays so downstream code has one shape to handle.

import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { isGermanyString, normalizeEmploymentType, parseCountryFromLocation } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'personio';

const REQUEST_DELAY_MS = 500;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;

// Personio seniority → the shared ExperienceLevel taxonomy
const SENIORITY_MAP = {
    'student': 'Entry',
    'entry-level': 'Entry',
    'experienced': 'Mid',
    'lead': 'Senior',
    'senior': 'Senior',
    'manager': 'Senior',
    'director': 'Director',
    'executive': 'Executive',
};

export const COMPANY_SLUGS = [
    { subdomain: 'workidentity', tld: 'de' },
    { subdomain: 'agile-robots-se', tld: 'de' },
    { subdomain: 'miles-mobility', tld: 'de' },
    { subdomain: 'peter-park', tld: 'de' },
    { subdomain: 'trg', tld: 'de' },
    { subdomain: 'unternehmertum', tld: 'de' },
    { subdomain: 'impower', tld: 'de' },
    { subdomain: 'carbmee', tld: 'com' },
    { subdomain: 'yoummday-gmbh', tld: 'de' },
    { subdomain: 'aiya-europe', tld: 'de' },
    { subdomain: 'data4life', tld: 'de' },
    { subdomain: 'zdf-digital', tld: 'de' },
    { subdomain: 'pitch', tld: 'de' },
    { subdomain: 'altagramgroup', tld: 'de' },
    { subdomain: 'bliq', tld: 'de' },
    { subdomain: 'anton', tld: 'com' },
    { subdomain: 'kemmler-kemmler-gmbh', tld: 'de' },
    { subdomain: 'zipmend', tld: 'de' },
    { subdomain: 'certivity', tld: 'de' },
    { subdomain: 'everience', tld: 'de' },
    { subdomain: 'studysmarter', tld: 'de' },
    { subdomain: 'tech11', tld: 'de' },
    { subdomain: 'pm-team', tld: 'de' },
    { subdomain: 'ht-ventures-gmbh', tld: 'de' },
    { subdomain: 'epages-gmbh', tld: 'de' },
    { subdomain: 'hafencity-hamburg', tld: 'de' },
    { subdomain: 'azeti', tld: 'de' },
    { subdomain: 'berlin-bytes', tld: 'de' },
    { subdomain: 'socialhub', tld: 'de' },
    { subdomain: 'aignostics', tld: 'de' },
    { subdomain: 'robco', tld: 'de' },

    // --- DISCOVERED 2026-08-04 ---
    { subdomain: 'neon', tld: 'de' }, { subdomain: 'phoenix', tld: 'de' },
    { subdomain: 'cosine', tld: 'de' }, { subdomain: 'atlas', tld: 'de' },
    { subdomain: 'argo', tld: 'de' }, { subdomain: 'bik', tld: 'com' },
    { subdomain: 'monday', tld: 'de' }, { subdomain: 'planetafoods', tld: 'de' },
    { subdomain: 'every', tld: 'de' }, { subdomain: 'aios', tld: 'de' },
    { subdomain: 'powerus', tld: 'de' }, { subdomain: 'julius', tld: 'de' },
    { subdomain: 'basecamp', tld: 'de' }, { subdomain: 'arcus', tld: 'de' },
    { subdomain: 'resolve', tld: 'de' }, { subdomain: 'amazon', tld: 'de' },
    { subdomain: 'salesforce', tld: 'de' }, { subdomain: 'payhawk', tld: 'de' },
    { subdomain: 'trading212', tld: 'de' }, { subdomain: 'storytel', tld: 'de' },
    { subdomain: 'bright', tld: 'de' }, { subdomain: 'legacy', tld: 'de' },
    { subdomain: 'motion', tld: 'de' }, { subdomain: 'upflow', tld: 'de' },
    { subdomain: 'machine26', tld: 'de' }, { subdomain: 'kaya', tld: 'de' },
    { subdomain: 'blitz', tld: 'de' }, { subdomain: 'invitris', tld: 'de' },
    { subdomain: 'linc', tld: 'de' }, { subdomain: 'craftwork', tld: 'de' },
    { subdomain: 'teleport', tld: 'de' }, { subdomain: 'mentimeter', tld: 'de' },
    { subdomain: 'framer', tld: 'de' }, { subdomain: 'haddock', tld: 'de' },
    { subdomain: 'cotera', tld: 'de' }, { subdomain: 'pina', tld: 'de' },
    { subdomain: 'contour', tld: 'de' }, { subdomain: 'alchemy', tld: 'de' },
    { subdomain: 'ory', tld: 'de' }, { subdomain: 'ada', tld: 'de' },
    { subdomain: 'channable', tld: 'de' }, { subdomain: 'personio', tld: 'de' },
    { subdomain: 'daedalus', tld: 'de' }, { subdomain: 'gauss', tld: 'de' },
    { subdomain: 'voize', tld: 'de' },

    // --- DISCOVERED 2026-08-04 ---
    { subdomain: 'holy', tld: 'de' }, { subdomain: 'center', tld: 'de' },
    { subdomain: 'montana', tld: 'de' }, { subdomain: 'cycle', tld: 'de' },
    { subdomain: 'closed', tld: 'de' }, { subdomain: 'pair', tld: 'de' },
    { subdomain: 'code', tld: 'de' }, { subdomain: 'november', tld: 'de' },
    { subdomain: 'friends', tld: 'de' }, { subdomain: 'parking', tld: 'de' },
    { subdomain: 'sides', tld: 'de' }, { subdomain: 'twelve', tld: 'de' },
    { subdomain: 'water', tld: 'de' }, { subdomain: 'connect', tld: 'de' },
    { subdomain: 'open', tld: 'de' }, { subdomain: 'flow', tld: 'de' },
    { subdomain: 'climate', tld: 'de' }, { subdomain: 'dental', tld: 'de' },
    { subdomain: 'demo', tld: 'de' }, { subdomain: 'charlotte', tld: 'de' },
    { subdomain: 'improving', tld: 'de' }, { subdomain: 'more', tld: 'de' },
    { subdomain: 'sports', tld: 'de' }, { subdomain: 'place', tld: 'de' },
    { subdomain: 'current', tld: 'de' }, { subdomain: 'join', tld: 'de' },
    { subdomain: 'again', tld: 'de' }, { subdomain: 'choice', tld: 'de' },
    { subdomain: 'thomas', tld: 'de' }, { subdomain: 'station', tld: 'de' },
    { subdomain: 'strong', tld: 'de' }, { subdomain: 'forward', tld: 'de' },
    { subdomain: 'trial', tld: 'de' }, { subdomain: 'deep', tld: 'de' },
    { subdomain: 'dark', tld: 'de' }, { subdomain: 'visual', tld: 'de' },
    { subdomain: 'johnson', tld: 'de' }, { subdomain: 'heat', tld: 'de' },
    { subdomain: 'fresh', tld: 'de' }, { subdomain: 'upper', tld: 'de' },
    { subdomain: 'equal', tld: 'de' }, { subdomain: 'objects', tld: 'de' },
    { subdomain: 'delete', tld: 'de' }, { subdomain: 'frank', tld: 'de' },
    { subdomain: 'daniel', tld: 'de' }, { subdomain: 'matrix', tld: 'de' },
    { subdomain: 'grow', tld: 'de' }, { subdomain: 'victoria', tld: 'de' },
    { subdomain: 'kevin', tld: 'de' }, { subdomain: 'launch', tld: 'de' },
    { subdomain: 'sessions', tld: 'de' }, { subdomain: 'clark', tld: 'de' },
    { subdomain: 'patrick', tld: 'de' }, { subdomain: 'purple', tld: 'de' },
    { subdomain: 'jonathan', tld: 'de' }, { subdomain: 'nikon', tld: 'de' },
    { subdomain: 'sigma', tld: 'com' }, { subdomain: 'spoke', tld: 'de' },
    { subdomain: 'activation', tld: 'com' }, { subdomain: 'soup', tld: 'com' },
    { subdomain: 'june', tld: 'de' }, { subdomain: 'popular', tld: 'de' },
    { subdomain: 'remember', tld: 'de' }, { subdomain: 'unique', tld: 'de' },
    { subdomain: 'royal', tld: 'de' }, { subdomain: 'lots', tld: 'de' },
    { subdomain: 'straight', tld: 'de' }, { subdomain: 'ahead', tld: 'de' },
    { subdomain: 'adams', tld: 'de' }, { subdomain: 'phrase', tld: 'de' },
    { subdomain: 'functional', tld: 'de' }, { subdomain: 'genuine', tld: 'de' },
    { subdomain: 'inspired', tld: 'de' },
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false, // keep numbers as strings; coerced explicitly below
    trimValues: true,
    isArray: (name) => ['position', 'jobDescription'].includes(name),
});

/** Primary office plus every additionalOffices entry, as a flat array. */
function collectAllOffices(job) {
    const offices = [];
    if (job.office) offices.push(job.office);

    const extras = job.additionalOffices?.office;
    if (Array.isArray(extras)) {
        offices.push(...extras);
    } else if (typeof extras === 'string' && extras) {
        offices.push(extras);
    }
    return offices;
}

/**
 * Personio splits a description into named sections (Intro / Your tasks / Your
 * profile / Benefits). Concatenated with headers preserved.
 */
function assembleDescription(jobDescriptionsBlock, asHtml) {
    const sections = jobDescriptionsBlock?.jobDescription || [];
    if (!Array.isArray(sections) || sections.length === 0) return '';

    if (asHtml) {
        return sections.map(section => `<h3>${section.name || ''}</h3>${section.value || ''}`).join('\n');
    }
    return sections.map(section => `${section.name || ''}\n${StripHtml(section.value || '')}`).join('\n\n');
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every position from every company feed. No location filtering.
 * @param {Array<{subdomain:string, tld:string}>} slugList
 * @returns {Promise<object[]>}
 */
/**
 * Fetches one company's board. Returns its jobs, or [] on any failure.
 *
 * Exported so the incremental pipeline can hash and compare a single company
 * before deciding whether to process it. fetchAllJobs() is a thin fan-out over
 * this.
 *
 * @param {string} { subdomain, tld }
 * @returns {Promise<object[]>}
 */
export async function fetchCompanyJobs({ subdomain, tld }) {
    console.log(`[Personio] Fetching: ${subdomain}...`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`https://${subdomain}.jobs.personio.${tld}/xml?language=en`, {
            headers: { 'Accept': 'application/xml,text/xml' },
            signal: controller.signal,
        });

        if (!response.ok) {
            return [];
        }

        // A retired careers subdomain can answer 200 with an HTML holding
        // page, so the XML parse is guarded rather than the status trusted.
        let parsed;
        try {
            parsed = xmlParser.parse(await response.text());
        } catch {
            console.warn(`[Personio] ${subdomain}: response was not valid XML`);
            return [];
        }

        const positions = parsed?.['workzag-jobs']?.position || [];
        console.log(`[Personio] ${subdomain}: ${positions.length} jobs fetched`);

        if (positions.length === 0) return [];

        // Kept per worker: paces this slot's next request.
        await sleep(REQUEST_DELAY_MS);

        return positions.map(job => ({ ...job, _subdomain: subdomain, _tld: tld }));

    } catch (error) {
        console.error(`[Personio] ${subdomain}: ${error.message}`);
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
    console.log(`[Personio] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    const allJobs = collectFulfilled(await runConcurrent(slugList, fetchCompanyJobs, FETCH_CONCURRENCY));

    console.log(`[Personio] ${allJobs.length} jobs fetched in total`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `personio_${job._subdomain}_${job.id}`;
}

export function extractJobTitle(job) {
    return job.name || '';
}

export function extractCompany(job) {
    if (job.subcompany) return job.subcompany;

    return String(job._subdomain || '')
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function extractLocation(job) {
    return job.office || '';
}

export function extractAllLocations(job) {
    return normalizeArray(collectAllOffices(job));
}

/**
 * Personio offices are usually city-only ("Berlin", not "Berlin, Germany"), so
 * there is often no country to read. German cities are still recognised via
 * isGermanyString — a DE result is correctly rejected by the whitelist, which is
 * more useful than returning null and having the job scored as unknown.
 */
export function extractCountry(job) {
    const offices = collectAllOffices(job);
    if (offices.some(office => isGermanyString(office))) return 'DE';

    for (const office of offices) {
        const parsed = parseCountryFromLocation(office);
        // A bare city name is not a country — only trust multi-part strings.
        if (parsed && String(office).includes(',')) return parsed;
    }
    return null;
}

export function extractDescription(job) {
    return assembleDescription(job.jobDescriptions, false);
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(assembleDescription(job.jobDescriptions, true));
}

export function extractURL(job) {
    return `https://${job._subdomain}.jobs.personio.${job._tld}/job/${job.id}?language=en`;
}

export function extractDirectApplyURL(job) {
    // Personio's job page is the apply page — the form is inline.
    return extractURL(job);
}

export function extractPostedDate(job) {
    return job.createdAt || null;
}

export function extractDepartment(job) {
    return job.department || job.recruitingCategory || 'N/A';
}

export function extractWorkplaceType(job) {
    const offices = collectAllOffices(job).join(' ').toLowerCase();
    if (offices.includes('remote')) return 'Remote';
    if (offices.includes('hybrid')) return 'Hybrid';
    return 'Unspecified';
}

export function extractIsRemote(job) {
    return extractWorkplaceType(job) === 'Remote';
}

export function extractEmploymentType(job) {
    return normalizeEmploymentType(job.employmentType);
}

export function extractExperienceLevel(job) {
    return SENIORITY_MAP[String(job.seniority || '').toLowerCase()] || null;
}

export function extractTags(job) {
    if (!job.keywords) return [];
    return normalizeArray(String(job.keywords).split(',').map(tag => tag.trim()));
}

export function extractSalaryMin(job) {
    const value = Number(job.salaryInformation?.min);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function extractSalaryMax(job) {
    const value = Number(job.salaryInformation?.max);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function extractSalaryCurrency(job) {
    return job.salaryInformation?.currencyCode || null;
}

export function extractSalaryInterval(job) {
    const type = String(job.salaryInformation?.type || '').toLowerCase();
    if (type === 'yearly') return 'per-year-salary';
    if (type === 'monthly') return 'per-month-salary';
    if (type === 'hourly') return 'per-hour-wage';
    return null;
}

export function extractATSPlatform() {
    return 'personio';
}
