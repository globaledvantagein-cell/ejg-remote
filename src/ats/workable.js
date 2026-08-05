// ─── Workable ──────────────────────────────────────────────────────────────────
//
// API: GET https://jobs.workable.com/api/v1/jobs?location={country}&limit=100
//      paginated via nextPageToken.
//
// Workable has no per-company board API that still works — the old
// www.workable.com/api/accounts/{slug} endpoint 302s to a dead page. What works
// is this aggregator search endpoint, which is queried by location.
//
// This is the one platform where "slug list" means something different: there
// are no company slugs, so COMPANY_SLUGS holds the whitelisted countries to
// search instead. The German pipeline queried location=Germany; this queries
// each English-speaking market in turn. Country filtering still runs in
// index.js — the query narrows the fetch, it does not replace the check.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeEmploymentType, normalizeWorkplaceType } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'workable';

const API_BASE = 'https://jobs.workable.com/api/v1/jobs';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_COUNTRY = 8; // 100 × 8 = 800 jobs per country per run
const PAGE_DELAY_MS = 500;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Search locations, not company slugs — see the header note. */
export const COMPANY_SLUGS = [
    'United States',
    'United Kingdom',
    'Canada',
    'Australia',
    'Ireland',
    'New Zealand',
    'Singapore',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every whitelisted country search. No client-side
 * location filtering — that stays in index.js.
 * @param {string[]} slugList - country names to search
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const allJobs = [];

    console.log(`[Workable] Fetching jobs across ${slugList.length} countries (${FETCH_CONCURRENCY} at a time)...`);

    /**
     * Paginates one country search. Pages stay sequential — each needs the
     * previous page's nextPageToken — and only the countries run in parallel.
     */
    async function fetchCountry(location) {
        console.log(`[Workable] Fetching: ${location}...`);

        const countryJobs = [];
        let pageToken = null;
        let pageCount = 0;
        let countryTotal = 0;

        try {
            do {
                const params = new URLSearchParams({ location, limit: String(PAGE_SIZE) });
                if (pageToken) params.set('pageToken', pageToken);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

                let data;
                try {
                    const response = await fetch(`${API_BASE}?${params.toString()}`, {
                        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
                        signal: controller.signal,
                    });

                    if (!response.ok) {
                        console.log(`[Workable] ${location}: HTTP ${response.status} — stopping pagination`);
                        break;
                    }
                    data = await response.json();
                } finally {
                    clearTimeout(timeoutId);
                }

                const jobs = data.jobs || [];
                if (jobs.length === 0) break;

                countryJobs.push(...jobs);
                countryTotal += jobs.length;
                pageCount++;
                pageToken = data.nextPageToken || null;

                if (pageToken) await sleep(PAGE_DELAY_MS);

            } while (pageToken && pageCount < MAX_PAGES_PER_COUNTRY);

            if (pageToken && pageCount >= MAX_PAGES_PER_COUNTRY) {
                console.log(`[Workable] ${location}: page cap reached at ${countryTotal} jobs, remainder skipped`);
            } else {
                console.log(`[Workable] ${location}: ${countryTotal} jobs fetched`);
            }

            return countryJobs;

        } catch (error) {
            console.error(`[Workable] ${location}: ${error.message}`);
            // Whatever paginated successfully before the failure is still good.
            return countryJobs;
        }
    }

    allJobs.push(...collectFulfilled(await runConcurrent(slugList, fetchCountry, FETCH_CONCURRENCY)));

    console.log(`[Workable] ${allJobs.length} jobs total`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `workable_${job.id}`;
}

export function extractJobTitle(job) {
    return job.title || '';
}

export function extractCompany(job) {
    return job.company?.title || '';
}

export function extractLocation(job) {
    return [job.location?.city, job.location?.countryName].filter(Boolean).join(', ');
}

export function extractAllLocations(job) {
    if (Array.isArray(job.locations) && job.locations.length > 0) {
        return normalizeArray(job.locations);
    }
    return normalizeArray([extractLocation(job)]);
}

export function extractCountry(job) {
    return job.location?.countryName || null;
}

export function extractDescription(job) {
    const parts = [job.description, job.requirementsSection, job.benefitsSection].filter(Boolean);
    return StripHtml(parts.join('\n'));
}

export function extractDescriptionHtml(job) {
    const parts = [job.description, job.requirementsSection, job.benefitsSection].filter(Boolean);
    return SanitizeHtml(parts.join(''));
}

export function extractURL(job) {
    return job.url || null;
}

export function extractDirectApplyURL(job) {
    // The jobs.workable.com listing page is also the apply page.
    return job.url || null;
}

export function extractPostedDate(job) {
    return job.created ? new Date(job.created) : null;
}

export function extractDepartment(job) {
    return job.department || 'N/A';
}

export function extractWorkplaceType(job) {
    return normalizeWorkplaceType(job.workplace);
}

export function extractIsRemote(job) {
    return String(job.workplace || '').toLowerCase() === 'remote';
}

export function extractEmploymentType(job) {
    return normalizeEmploymentType(job.employmentType);
}

export function extractTags(job) {
    return normalizeArray([
        job.department,
        job.employmentType,
        job.workplace ? `Workplace: ${job.workplace}` : null,
    ]);
}

// The public Workable search API exposes no compensation.
export function extractSalaryMin() { return null; }
export function extractSalaryMax() { return null; }
export function extractSalaryCurrency() { return null; }
export function extractSalaryInterval() { return null; }

export function extractATSPlatform() {
    return 'workable';
}
