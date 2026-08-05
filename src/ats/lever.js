// ─── Lever ─────────────────────────────────────────────────────────────────────
//
// List:   GET https://api.lever.co/v0/postings/{slug}?mode=json
// Detail: GET https://api.lever.co/v0/postings/{slug}/{jobId}
//
// The list endpoint returns only a short intro snippet, so the full description
// — which the restriction filter depends on — has to come from the per-job
// detail endpoint. That is what enrichJob() is for: index.js calls it only after
// a job has already passed the cheap country and remote checks, so we make one
// detail request per surviving job rather than per posting.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeEmploymentType, normalizeWorkplaceType, parseCountryFromLocation } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'lever';

const BASE_URL = 'https://api.lever.co/v0/postings';
const REQUEST_DELAY_MS = 300;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

export const COMPANY_SLUGS = [
    'welocalize',
    'veeva',
    'crytek',
    'sonarsource',
    'agicap',
    'coupa', 'qonto', 'pipedrive', 'brevo', 'spotify', 'contentsquare',
    'bazaarvoice', 'didomi', 'sophos',

    // --- REMOTE EXPANSION 2026-08-04 ---
    'palantir', 'gettyimages', 'zoox',

    // --- DISCOVERED 2026-08-04 ---
    'gopuff', 'lyrahealth', 'ninjavan', 'includedhealth', 'ro', 'anchorage',
    'nium', 'zopa', 'linkedin', 'angellist', 'swordhealth', 'wealthfront',
    'secureframe', 'neon', 'deputy', 'alloy', 'sysdig', 'loopreturns',
    'logrocket', 'prismic', 'boltjobs', 'brilliant', 'fundrise', 'immutable',
    '15five', 'anyscale', 'ledger',

    // --- DISCOVERED 2026-08-04 ---
    'distro', 'sila', 'tractian', 'aleph', 'hive', 'meesho',
    'canarytechnologies', 'emburse', 'netomi', 'captivateiq', 'porter', 'h1',
    'jobandtalent', 'glide', 'gridware', 'mable', 'swile', 'skyways',
    'trustly', 'mashgin', 'snappr', 'superside', 'theathletic', 'frontify',
    'pyka', 'fampay', 'proper', 'omnisend', 'bloom', 'teleo',
    'finch', 'suger', 'nimblerx', 'tovala', 'unusual', 'blue',
    'copia', 'mytos', 'emilabs', 'doola', 'unify', 'fleetzero',
    'prosper', 'revi', 'younited', 'people-ai', 'zippi', 'starkbank',
    'epsilon3', 'musixmatch', 'multiplylabs', 'handoff', 'trellis', 'eternal',
    'skio', 'verifiable', 'twodots', 'maverickx', 'plume', 'thunkable',
    'synapticure', 'newton', 'quartzy', 'picktrace', 'evry-health', 'plexus',
    'postera', 'smartcuts', 'bolster', 'polleverywhere', 'backerkit', 'biorender',
    'fintual', 'shiru', 'kinter', 'livingcarbon', 'marqvision',

    // --- DISCOVERED 2026-08-04 ---
    'deliverect', 'bloomon', 'ion', 'intersect', 'rise', 'zeta',
    'tekton', 'rigetti', 'vida', 'gemcareers', 'enable', 'voltalabs',
    'text', 'relay', 'proof', 'sapling',

    // --- DISCOVERED 2026-08-04 ---
    'coins', 'pattern', 'life', 'protective', 'belong', 'capital',
    'vacancies', 'reply', 'outreach', 'doctrine', 'rover', 'until',
    'gate', 'safe', 'dutch', 'retro', 'neighbor', 'objective',
    'mega', 'grand', 'florence', 'factor', 'planned', 'harmony',
    'instrument', 'integrate', 'cents', 'pleased', 'advocate', 'source',
    'choose', 'fantasy', 'genesis', 'ranger', 'unlikely', 'employ',
    'find', 'super', 'syntax', 'nobody', 'sure', 'engine',
    'career', 'basis', 'signal', 'healthcare', 'candidate', 'retired',
    'horizon', 'trio',

    // --- DISCOVERED 2026-08-04 ---
    'ajax', 'spear', 'pigment', 'disher', 'mulberry', 'lessen',
    'silhouette', 'malt', 'kepler', 'pivotal', 'dexterity', 'waterworks',
    'biggie', 'ecosystem', 'mantra', 'azul', 'promenade', 'playbook',
    'outlast', 'arcadia', 'riverdale', 'hush', 'tiberius', 'mindful',
    'procreate', 'purvis', 'minted', 'noodle', 'pendulum', 'waterfall',
    'markham', 'gauntlet', 'raya', 'maya', 'mcgovern', 'mindy',
    'serotonin', 'centrifuge', 'teller', 'renegade', 'ladders', 'krypton',
    'tact', 'cred', 'magnify', 'raine', 'slate', 'latch',
    'autonomous', 'checker', 'nimbus', 'crossfit', 'tonic', 'anomaly',
    'sesame', 'articulate', 'rupa', 'whereby', 'giddyup', 'illumination',
    'stockpile', 'precede',

    // --- DISCOVERED 2026-08-05 ---
    'fresha', 'filevine', 'lodgify', 'metabase', 'restaurant365', 'voltus',
    'truv', 'immuta', 'olo', 'chownow', 'coderpad', 'findem',
    'deepgenomics', 'dwolla', 'benchsci',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every company. No location filtering.
 * Descriptions are intentionally left short here — see enrichJob().
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const allJobs = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`[Lever] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    /** Fetches one board. Returns its jobs, or [] on any failure. */
    async function fetchBoard(siteName) {
        console.log(`[Lever] Fetching: ${siteName}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`${BASE_URL}/${siteName}?mode=json`, {
                headers: { 'User-Agent': USER_AGENT },
                signal: controller.signal,
            });

            if (!response.ok) {
                failCount++;
                return [];
            }

            // A dead or renamed board can answer 200 with an HTML error page,
            // so the parse is guarded rather than the status trusted alone.
            let data;
            try {
                data = await response.json();
            } catch {
                failCount++;
                console.warn(`[Lever] ${siteName}: response was not valid JSON`);
                return [];
            }

            const jobs = Array.isArray(data) ? data : [];
            console.log(`[Lever] ${siteName}: ${jobs.length} jobs fetched`);

            if (jobs.length === 0) return [];

            successCount++;

            // Kept per worker: paces this slot's next request.
            await sleep(REQUEST_DELAY_MS);

            return jobs.map(job => ({ ...job, _siteName: siteName }));

        } catch (error) {
            failCount++;
            console.error(`[Lever] ${siteName}: ${error.message}`);
            return [];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    allJobs.push(...collectFulfilled(await runConcurrent(slugList, fetchBoard, FETCH_CONCURRENCY)));

    console.log(`[Lever] ${allJobs.length} jobs from ${successCount} companies (${failCount} failed/empty)`);
    return allJobs;
}

/**
 * Fetches the full description from the per-job detail endpoint and merges it
 * onto the job. Returns the job unchanged when the detail call fails — the
 * caller still gets whatever the list endpoint had.
 *
 * @param {object} job
 * @returns {Promise<object>}
 */
export async function enrichJob(job) {
    const companySlug = job._siteName;
    const jobId = job.id;

    if (!companySlug || !jobId) return job;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${BASE_URL}/${companySlug}/${jobId}`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        });

        if (!response.ok) return job;

        const data = await response.json();

        // The detail payload splits the posting into: description (intro HTML),
        // lists (array of {text, content} sections) and additional (closing HTML).
        const parts = [];
        const htmlParts = [];

        if (data.description) {
            parts.push(StripHtml(data.description));
            htmlParts.push(SanitizeHtml(data.description));
        }

        if (Array.isArray(data.lists)) {
            for (const section of data.lists) {
                if (section.text) {
                    parts.push(`\n${section.text}:`);
                    htmlParts.push(`<h4>${section.text}</h4>`);
                }
                if (section.content) {
                    parts.push(StripHtml(section.content));
                    htmlParts.push(SanitizeHtml(section.content));
                }
            }
        }

        if (data.additional) {
            parts.push(StripHtml(data.additional));
            htmlParts.push(SanitizeHtml(data.additional));
        }

        const fullDescription = parts.join('\n').replace(/\s{3,}/g, '\n\n').trim();
        const fullDescriptionHtml = htmlParts.join('\n').trim();

        if (!fullDescription || fullDescription.length < 50) return job;

        return { ...job, _fullDescription: fullDescription, _fullDescriptionHtml: fullDescriptionHtml };

    } catch (error) {
        return job;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `lever_${job.id}`;
}

export function extractJobTitle(job) {
    return job.text || 'Untitled Position';
}

export function extractCompany(job) {
    if (job.hostedUrl) {
        try {
            const parts = new URL(job.hostedUrl).pathname.split('/').filter(Boolean);
            if (parts.length > 0) {
                return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            }
        } catch (error) {
            // Fall through to the slug.
        }
    }
    const slug = String(job._siteName || '');
    return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Company via Lever';
}

export function extractLocation(job) {
    const locations = normalizeArray([
        job.categories?.location,
        ...(job.categories?.allLocations || []),
    ]);
    return locations.length > 0 ? locations.join(', ') : '';
}

export function extractDescription(job) {
    if (job._fullDescription) return job._fullDescription;
    if (job.descriptionPlain) return StripHtml(job.descriptionPlain);
    if (job.description) return StripHtml(job.description);
    return '';
}

export function extractDescriptionHtml(job) {
    if (job._fullDescriptionHtml) return job._fullDescriptionHtml;
    return SanitizeHtml(job.description || '');
}

export function extractURL(job) {
    return job.hostedUrl || job.applyUrl || null;
}

export function extractDirectApplyURL(job) {
    return job.applyUrl || null;
}

export function extractPostedDate(job) {
    return job.createdAt || null;
}

export function extractDepartment(job) {
    return job.categories?.department || 'N/A';
}

export function extractAllLocations(job) {
    return normalizeArray([job.categories?.location, ...(job.categories?.allLocations || [])]);
}

export function extractCountry(job) {
    if (job.country) return String(job.country).trim();
    return parseCountryFromLocation(job.categories?.location);
}

export function extractEmploymentType(job) {
    return normalizeEmploymentType(job.categories?.commitment);
}

export function extractWorkplaceType(job) {
    return normalizeWorkplaceType(job.workplaceType);
}

/** Diverges from leverConfig.js: Hybrid does not count as remote here. */
export function extractIsRemote(job) {
    return normalizeWorkplaceType(job.workplaceType) === 'Remote';
}

export function extractTags(job) {
    return normalizeArray(Array.isArray(job.tags) ? job.tags : []);
}

export function extractSalaryMin(job) {
    return Number.isFinite(job.salaryRange?.min) ? job.salaryRange.min : null;
}

export function extractSalaryMax(job) {
    return Number.isFinite(job.salaryRange?.max) ? job.salaryRange.max : null;
}

export function extractSalaryCurrency(job) {
    return job.salaryRange?.currency || null;
}

export function extractSalaryInterval(job) {
    return job.salaryRange?.interval || null;
}

export function extractATSPlatform() {
    return 'lever';
}
