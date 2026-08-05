// ─── Recruitee ─────────────────────────────────────────────────────────────────
//
// API: GET https://{subdomain}.recruitee.com/api/offers/
// One request per company returns the whole board with descriptions and
// requirements. No pagination, no auth.
//
// Recruitee is the only platform that expresses workplace type as three
// independent booleans (remote / hybrid / on_site) rather than a string.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { parseCountryFromLocation } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'recruitee';

const REQUEST_DELAY_MS = 300;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const COMPANY_SLUGS = [
    'limehome',

    // --- DISCOVERED 2026-08-04 ---
    'conclusion', 'centric', 'cz', 'bunq', 'channable', 'multisafepay',
    'holded', 'funda', 'make', 'famly', 'nmbrs', 'robovision',
    'bamboohr', 'pay', 'gorgias', 'coursera', 'personio', 'twisto',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Local normalizers ────────────────────────────────────────────────────────
// Recruitee's own vocabularies. Kept local rather than in utils/location.js
// because these take a job object / Recruitee-specific codes, not a plain string.

function normalizeRecruiteeWorkplaceType(job) {
    const isRemote = Boolean(job.remote);
    const isHybrid = Boolean(job.hybrid);
    const isOnSite = Boolean(job.on_site);

    if (isRemote && !isOnSite && !isHybrid) return 'Remote';
    if (isHybrid) return 'Hybrid';
    if (isRemote) return 'Remote'; // remote + on_site → still tagged Remote
    if (isOnSite) return 'Onsite';
    return 'Unspecified';
}

function mapEmploymentType(code) {
    if (!code) return null;
    const lower = String(code).toLowerCase();
    if (lower.includes('full')) return 'FullTime';
    if (lower.includes('part')) return 'PartTime';
    if (lower.includes('contract') || lower === 'freelance') return 'Contract';
    if (lower.includes('intern')) return 'Intern';
    if (lower.includes('temp')) return 'Temporary';
    return null;
}

function mapExperienceLevel(code) {
    if (!code) return null;
    const lower = String(code).toLowerCase();
    if (lower.includes('entry') || lower.includes('junior') || lower.includes('intern') || lower.includes('associate')) return 'Entry';
    if (lower.includes('mid') || lower.includes('intermediate') || lower.includes('regular')) return 'Mid';
    if (lower.includes('senior') || lower.includes('experienced') || lower.includes('expert')) return 'Senior';
    if (lower.includes('executive') || lower.includes('director') || lower.includes('lead') || lower.includes('principal') || lower.includes('vp')) return 'Lead';
    if (lower.includes('staff') || lower.includes('distinguished')) return 'Staff';
    return null;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every published offer from every company. No location filtering.
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const allJobs = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`[Recruitee] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    /** Fetches one board. Returns its published offers, or [] on any failure. */
    async function fetchBoard(subdomain) {
        console.log(`[Recruitee] Fetching: ${subdomain}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`https://${subdomain}.recruitee.com/api/offers/`, {
                headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
                signal: controller.signal,
            });

            if (!response.ok) {
                failCount++;
                return [];
            }

            const data = await response.json();
            const offers = (data.offers || []).filter(offer => !offer.status || offer.status === 'published');
            console.log(`[Recruitee] ${subdomain}: ${offers.length} jobs fetched`);

            if (offers.length === 0) return [];

            successCount++;

            // Kept per worker: paces this slot's next request.
            await sleep(REQUEST_DELAY_MS);

            return offers.map(offer => ({ ...offer, _subdomain: subdomain }));

        } catch (error) {
            failCount++;
            if (error.name !== 'AbortError') {
                console.error(`[Recruitee] ${subdomain}: ${error.message}`);
            }
            return [];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    allJobs.push(...collectFulfilled(await runConcurrent(slugList, fetchBoard, FETCH_CONCURRENCY)));

    console.log(`[Recruitee] ${allJobs.length} jobs from ${successCount} companies (${failCount} failed/empty)`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `recruitee_${job._subdomain}_${job.id}`;
}

export function extractJobTitle(job) {
    return job.title || '';
}

export function extractCompany(job) {
    if (job.company_name) return job.company_name;

    return String(job._subdomain || '')
        .replace(/[-_]/g, ' ')
        .replace(/\d+$/, '')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
        .trim();
}

export function extractLocation(job) {
    if (Array.isArray(job.locations) && job.locations.length > 0) {
        const parts = job.locations
            .map(loc => [loc.city || loc.name, loc.country].filter(Boolean).join(', '))
            .filter(Boolean);
        if (parts.length > 0) return parts.join('; ');
    }

    const flat = [job.city, job.country].filter(Boolean);
    if (flat.length > 0) return flat.join(', ');

    return job.location || '';
}

export function extractAllLocations(job) {
    const locations = [];

    if (Array.isArray(job.locations)) {
        for (const loc of job.locations) {
            const parts = [loc.city, loc.country].filter(Boolean);
            if (parts.length > 0) locations.push(parts.join(', '));
            if (loc.name) locations.push(loc.name);
        }
    }

    if (job.city) locations.push(job.city);
    if (job.location) locations.push(job.location);

    return normalizeArray(locations);
}

/** Prefers the structured country_code, then the country name, then the location string. */
export function extractCountry(job) {
    if (Array.isArray(job.locations)) {
        for (const loc of job.locations) {
            if (loc.country_code) return String(loc.country_code).toUpperCase();
            if (loc.country) return loc.country;
        }
    }
    if (job.country_code) return String(job.country_code).toUpperCase();
    if (job.country) return job.country;
    return parseCountryFromLocation(job.location);
}

export function extractDescription(job) {
    const parts = [job.description, job.requirements].filter(Boolean);
    return StripHtml(parts.join('\n'));
}

export function extractDescriptionHtml(job) {
    const parts = [job.description, job.requirements].filter(Boolean);
    return SanitizeHtml(parts.join(''));
}

export function extractURL(job) {
    return job.careers_url || null;
}

export function extractDirectApplyURL(job) {
    return job.careers_apply_url || null;
}

export function extractPostedDate(job) {
    return job.published_at || job.created_at || null;
}

export function extractDepartment(job) {
    return job.department || 'N/A';
}

export function extractWorkplaceType(job) {
    return normalizeRecruiteeWorkplaceType(job);
}

export function extractIsRemote(job) {
    // Only the pure-remote combination counts; remote+on_site is a hybrid in
    // everything but its tag.
    return normalizeRecruiteeWorkplaceType(job) === 'Remote' && !job.on_site;
}

export function extractEmploymentType(job) {
    return mapEmploymentType(job.employment_type_code);
}

export function extractExperienceLevel(job) {
    return mapExperienceLevel(job.experience_code);
}

export function extractIsEntryLevel(job) {
    return mapExperienceLevel(job.experience_code) === 'Entry';
}

export function extractTags(job) {
    const tags = [];

    if (Array.isArray(job.tags)) tags.push(...job.tags);
    if (job.category_code) tags.push(`Category: ${job.category_code.replace(/_/g, ' ')}`);
    if (job.education_code && job.education_code !== 'not_applicable') {
        tags.push(`Education: ${job.education_code.replace(/_/g, ' ')}`);
    }
    if (job.min_hours && job.max_hours) tags.push(`${job.min_hours}-${job.max_hours}h/week`);

    return normalizeArray(tags);
}

export function extractSalaryCurrency(job) {
    return job.salary?.currency || null;
}

export function extractSalaryMin(job) {
    const value = Number(job.salary?.min);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function extractSalaryMax(job) {
    const value = Number(job.salary?.max);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function extractSalaryInterval(job) {
    const period = String(job.salary?.period || '').toLowerCase();
    if (!period) return null;
    if (period.includes('year') || period.includes('annual')) return 'per-year-salary';
    if (period.includes('month')) return 'per-month-salary';
    if (period.includes('hour')) return 'per-hour-wage';
    return 'per-year-salary';
}

export function extractATSPlatform() {
    return 'recruitee';
}
