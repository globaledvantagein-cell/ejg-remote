// ─── SmartRecruiters ───────────────────────────────────────────────────────────
//
// List:   GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=N&country=xx
// Detail: GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
//
// The list payload carries location (including a `remote` boolean) and taxonomy,
// but not the description — that only exists on the detail endpoint. Detail is
// therefore fetched in enrichJob(), after index.js has already filtered on
// country and remoteness, rather than for every posting.
//
// The German pipeline pinned country=de server-side. Here the list is paginated
// once per whitelisted country code, which keeps the fetch bounded without
// pulling every posting on earth.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeEmploymentType } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'smartrecruiters';

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 30; // → 3000 postings per company per country
const REQUEST_DELAY_MS = 250;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;

// ISO country codes the list endpoint is queried with, mirroring the remote
// filter's whitelist.
const QUERY_COUNTRIES = ['us', 'gb', 'ca', 'au', 'ie', 'nz', 'sg'];

const EXPERIENCE_MAP = {
    'internship': 'Entry',
    'entry level': 'Entry',
    'associate': 'Entry',
    'mid-senior level': 'Mid',
    'director': 'Director',
    'executive': 'Executive',
    'not applicable': null,
};

const EMPLOYMENT_MAP = {
    'full-time': 'FullTime',
    'part-time': 'PartTime',
    'intern': 'Intern',
    'contract': 'Contract',
    'temporary': 'Temporary',
};

export const COMPANY_SLUGS = [
    'BoschGroup',
    'aboutyougmbh',
    'ScalableGmbH',
    'SIXT',
    'alten',
    'Flink3',
    'StepStoneGroup',
    'ServiceNow',
    'ifs1',
    'AltagramGmbH',
    'Endava',
    'ecovadis',
    'Bosch-HomeComfort',
    'Meta1',
    'smartrecruiters',

    // --- REMOTE EXPANSION 2026-08-04 ---
    'Experian', 'Sutherland', 'Alorica', 'WTW', 'Visa', 'Alight',
    'TTEC', 'Lonza', 'McDonaldsCorporation',

    // --- DISCOVERED 2026-08-04 ---
    'deliveryhero', 'wise', 'grab', 'canva', 'tomra', 'trigo',
    'beamery', 'nexthink', 'hackerrank', 'together', 'modernloop', 'judobank',
    'palantir', 'cocusocial', 'shaped', 'netskope', 'hootsuite', 'lokal',
    'manara', 'justworks', 'workato', 'perdiemjobs', 'touchmark', 'lumi',
    'dashlabsai', 'vendease', 'flextock', 'agency', 'newrelic', 'zenefits',
    'datadriven', 'bukuwarung', 'mosaic', 'bananajobs', 'armis', 'picnic',
    'wayup', 'vouch', 'hiresweet', 'electroneek', 'bloom', 'juicebox',
    'riverbank', 'superset', 'uber', 'namely', 'socure', 'glean',
    'dataiku', 'securiti', 'wayfair', 'lyra', 'letsgetchecked', 'clerky',
    'kamcord', '42', 'bellabeat', 'kunasystems', 'onechronos', 'innov8',
    'alemhealth', 'vidaco', 'zyper', 'excepgen', 'wren', 'actiondesk',
    'loophealth', 'pahamify', 'bandit', 'statiq', 'functionup', 'kodo',
    'navattic', 'syronahealth', 'homeroom', 'finku', 'whitelab', 'albiwareinc',
    'vincigames', 'orbio', 'visionlab', 'nox', 'mable',

    // --- DISCOVERED 2026-08-04 ---
    'coolblue', 'magellan', 'mirantis', 'seekout', 'servicetitan', 'brighthire',
    'siteminder', 'aitech', 'knockjobs', 'pinwheel',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Paginates the list endpoint for one company + country pair. */
async function fetchListedJobs(companyId, country) {
    const listed = [];
    let offset = 0;

    for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
        const params = new URLSearchParams({
            limit: String(PAGE_SIZE),
            offset: String(offset),
            country,
            language: 'en',
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let data;
        try {
            const response = await fetch(`${BASE_URL}/${encodeURIComponent(companyId)}/postings?${params}`, {
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });

            if (!response.ok) throw new Error(`list HTTP ${response.status}`);

            // Guarded: an edge/proxy error can answer 200 with an HTML body.
            try {
                data = await response.json();
            } catch {
                throw new Error('list response was not valid JSON');
            }
        } finally {
            clearTimeout(timeoutId);
        }

        const batch = data.content || [];
        listed.push(...batch);

        if (batch.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await sleep(REQUEST_DELAY_MS);
    }

    return listed;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches the listed postings for every company across every whitelisted
 * country. Descriptions arrive later via enrichJob().
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const allJobs = [];
    let failCount = 0;

    console.log(`[SmartRecruiters] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    /**
     * Queries one company across every whitelisted country. The country loop
     * stays sequential so a single company never opens QUERY_COUNTRIES
     * connections at once — parallelism is across companies only.
     */
    async function fetchCompany(companyId) {
        console.log(`[SmartRecruiters] Fetching: ${companyId}...`);

        const companyJobs = [];

        for (const country of QUERY_COUNTRIES) {
            try {
                const listed = await fetchListedJobs(companyId, country);
                if (listed.length > 0) {
                    companyJobs.push(...listed.map(job => ({ ...job, _companyId: companyId })));
                }
                await sleep(REQUEST_DELAY_MS);
            } catch (error) {
                failCount++;
                console.error(`[SmartRecruiters] ${companyId}/${country}: ${error.message}`);
            }
        }

        console.log(`[SmartRecruiters] ${companyId}: ${companyJobs.length} jobs fetched`);
        return companyJobs;
    }

    allJobs.push(...collectFulfilled(await runConcurrent(slugList, fetchCompany, FETCH_CONCURRENCY)));

    console.log(`[SmartRecruiters] ${allJobs.length} jobs listed (${failCount} query failures)`);
    return allJobs;
}

/**
 * Fetches the posting detail — description sections and apply URL live only
 * there. Returns the job unchanged if the call fails.
 *
 * @param {object} job
 * @returns {Promise<object>}
 */
export async function enrichJob(job) {
    if (!job._companyId || !job.id) return job;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(
            `${BASE_URL}/${encodeURIComponent(job._companyId)}/postings/${job.id}`,
            { headers: { 'Accept': 'application/json' }, signal: controller.signal },
        );

        if (!response.ok) return job;

        return { ...job, _detail: await response.json() };
    } catch (error) {
        return job;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * SmartRecruiters splits a posting into four named sections. Concatenated with
 * headers preserved.
 */
function assembleDescription(sections, asHtml) {
    if (!sections || typeof sections !== 'object') return '';

    const order = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];
    const parts = [];

    for (const key of order) {
        const section = sections[key];
        if (!section?.text) continue;
        const title = section.title || key;
        parts.push(asHtml ? `<h3>${title}</h3>${section.text}` : `${title}\n${StripHtml(section.text)}`);
    }

    return parts.join(asHtml ? '\n' : '\n\n');
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `sr_${job._companyId}_${job.id}`;
}

export function extractJobTitle(job) {
    return job.name || '';
}

export function extractCompany(job) {
    const companyObj = job.company || job._detail?.company;
    if (companyObj?.name) return companyObj.name;

    return String(job._companyId || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function extractLocation(job) {
    const loc = job.location || {};
    return loc.fullLocation
        || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ')
        || '';
}

export function extractAllLocations(job) {
    // SmartRecruiters returns a single location per posting, never an array.
    return normalizeArray([extractLocation(job)]);
}

export function extractCountry(job) {
    const code = job.location?.country;
    return code ? String(code).toUpperCase() : null;
}

export function extractDescription(job) {
    return assembleDescription(job._detail?.jobAd?.sections, false);
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(assembleDescription(job._detail?.jobAd?.sections, true));
}

export function extractURL(job) {
    return job._detail?.postingUrl || job._detail?.applyUrl || null;
}

export function extractDirectApplyURL(job) {
    return job._detail?.applyUrl || null;
}

export function extractPostedDate(job) {
    return job.releasedDate || job._detail?.releasedDate || null;
}

export function extractDepartment(job) {
    return job.department?.label || job.function?.label || 'N/A';
}

export function extractWorkplaceType(job) {
    const loc = job.location || {};
    if (loc.remote === true) return 'Remote';
    if (loc.hybrid === true) return 'Hybrid';
    return 'Unspecified';
}

export function extractIsRemote(job) {
    return job.location?.remote === true;
}

export function extractEmploymentType(job) {
    const label = String(job.typeOfEmployment?.label || '').toLowerCase();
    return EMPLOYMENT_MAP[label] || normalizeEmploymentType(job.typeOfEmployment?.label);
}

export function extractExperienceLevel(job) {
    return EXPERIENCE_MAP[String(job.experienceLevel?.label || '').toLowerCase()] || null;
}

export function extractTags(job) {
    return normalizeArray([
        job.industry?.label,
        job.function?.label,
        job.department?.label,
        job.typeOfEmployment?.label,
    ]);
}

// Compensation is only in SmartRecruiters' authenticated Customer API.
export function extractSalaryMin() { return null; }
export function extractSalaryMax() { return null; }
export function extractSalaryCurrency() { return null; }
export function extractSalaryInterval() { return null; }

export function extractATSPlatform() {
    return 'smartrecruiters';
}
