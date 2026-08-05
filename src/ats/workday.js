// ─── Workday ───────────────────────────────────────────────────────────────────
//
// List:   POST https://{company}.{instance}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs
//         body { appliedFacets: {}, limit, offset, searchText: '' }
// Detail: GET  https://{company}.{instance}.myworkdayjobs.com/wday/cxs/{company}/{site}{externalPath}
//
// Workday is the heaviest of the nine. The list payload carries a title and a
// location string and nothing else — no country, no workplace type, no
// description — so every field that matters for filtering comes from the detail
// call in enrichJob(). index.js only enriches jobs that already look remote and
// already look whitelisted, which keeps the detail traffic proportional to the
// output rather than to the (very large) global job count.
//
// Because these tenants list every job worldwide, pagination is capped per
// company. When the cap truncates a board it is logged — never silently.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeEmploymentType, normalizeWorkplaceType, parseCountryFromLocation } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'workday';

const PAGE_SIZE = 20;              // Workday's cxs endpoint caps page size at 20
const MAX_JOBS_PER_COMPANY = 500;  // hard cap — some tenants list 5000+
const MAX_PAGES_PER_COMPANY = MAX_JOBS_PER_COMPANY / PAGE_SIZE; // 25 pages × 20
const PAGE_DELAY_MS = 200;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const COMPANY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30000;

export const COMPANY_SLUGS = [
    { company: 'leidos', instance: 'wd5', site: 'External', name: 'Leidos' },
    { company: 'cadence', instance: 'wd1', site: 'External_Careers', name: 'Cadence' },
    { company: 'redhat', instance: 'wd5', site: 'Jobs', name: 'Red Hat' },
    { company: 'paypal', instance: 'wd1', site: 'Jobs', name: 'PayPal' },
    { company: 'nxp', instance: 'wd3', site: 'Careers', name: 'NXP' },
    { company: 'astrazeneca', instance: 'wd3', site: 'Careers', name: 'AstraZeneca' },
    { company: 'takeda', instance: 'wd3', site: 'External', name: 'Takeda' },
    { company: 'analogdevices', instance: 'wd1', site: 'External', name: 'Analog Devices' },
    { company: 'kone', instance: 'wd3', site: 'Careers', name: 'KONE' },
    { company: 'equinix', instance: 'wd1', site: 'External', name: 'Equinix' },
    { company: 'trendmicro', instance: 'wd3', site: 'External', name: 'Trend Micro' },
    { company: 'broadridge', instance: 'wd5', site: 'Careers', name: 'Broadridge' },
    { company: 'thales', instance: 'wd3', site: 'Careers', name: 'Thales' },
    { company: 'dupont', instance: 'wd5', site: 'Jobs', name: 'DuPont' },
    { company: 'mars', instance: 'wd3', site: 'External', name: 'Mars' },
    { company: 'dell', instance: 'wd1', site: 'External', name: 'Dell' },
    { company: 'intel', instance: 'wd1', site: 'External', name: 'Intel' },
    { company: 'globalfoundries', instance: 'wd1', site: 'External', name: 'GlobalFoundries' },
    { company: 'micron', instance: 'wd1', site: 'External', name: 'Micron' },
    { company: 'shell', instance: 'wd3', site: 'ShellCareers', name: 'Shell' },
    { company: 'mufgub', instance: 'wd3', site: 'MUFG-Careers', name: 'MUFG' },
    { company: 'gsk', instance: 'wd5', site: 'GSKCareers', name: 'GSK' },
    { company: 'illumina', instance: 'wd1', site: 'illumina-careers', name: 'Illumina' },
    { company: 'fastretailing', instance: 'wd3', site: 'graduates_eu_Uniqlo', name: 'Uniqlo' },
    { company: 'aresmgmt', instance: 'wd1', site: 'External', name: 'Ares Management' },
    { company: 'tmhcc', instance: 'wd108', site: 'External', name: 'Tokio Marine HCC' },
    { company: 'sabre', instance: 'wd1', site: 'SabreJobs', name: 'Sabre' },
    { company: 'maersk', instance: 'wd3', site: 'Maersk_Careers', name: 'Maersk' },
    { company: 'philips', instance: 'wd3', site: 'jobs-and-careers', name: 'Philips' },
    { company: 'bdx', instance: 'wd1', site: 'EXTERNAL_CAREER_SITE_GERMANY', name: 'BD (Becton Dickinson)' },
    { company: 'alcon', instance: 'wd5', site: 'careers_alcon', name: 'Alcon' },
    { company: 'sandvik', instance: 'wd3', site: 'walter-jobs', name: 'Walter (Sandvik)' },
    { company: 'condenast', instance: 'wd5', site: 'CondeCareers', name: 'Condé Nast' },
    { company: 'freseniusglobal', instance: 'wd3', site: 'FK_Careers', name: 'Fresenius Kabi' },
    { company: 'solenis', instance: 'wd1', site: 'Solenis', name: 'Solenis' },
    { company: 'athora', instance: 'wd3', site: 'athora-careers', name: 'Athora' },
    { company: 'alantra', instance: 'wd3', site: 'Alantra', name: 'Alantra' },
    { company: 'aesop', instance: 'wd3', site: 'aesopcareers', name: 'Aesop' },
    { company: 'bb', instance: 'wd3', site: 'BlackBerry', name: 'BlackBerry' },
    { company: 'novanta', instance: 'wd5', site: 'Novanta-Careers', name: 'Novanta' },
    { company: 'airliquidehr', instance: 'wd3', site: 'AirLiquideExternalCareer', name: 'Air Liquide' },
    { company: 'covestro', instance: 'wd3', site: 'cov_external', name: 'Covestro' },
    { company: 'galileo', instance: 'wd3', site: 'global_education_germany_career_site', name: 'Galileo Global Education' },
    { company: 'insulet', instance: 'wd5', site: 'insuletcareers', name: 'Insulet (Omnipod)' },
    { company: 'ossur', instance: 'wd3', site: 'ossurcareersglobal', name: 'Össur' },
    { company: 'rentschler', instance: 'wd3', site: 'Rentschler_Career', name: 'Rentschler Biopharma' },
    { company: 'raymondjames', instance: 'wd1', site: 'RaymondJamesCareers', name: 'Raymond James' },
    { company: 'brenntag', instance: 'wd3', site: 'brenntag_jobs', name: 'Brenntag' },
    { company: 'unilever', instance: 'wd3', site: 'Unilever_Experienced_Professionals', name: 'Unilever' },
    { company: 'iberdrola', instance: 'wd3', site: 'Iberdrola', name: 'Iberdrola' },
    { company: 'hl', instance: 'wd1', site: 'Campus', name: 'Houlihan Lokey' },
    { company: 'bf', instance: 'wd5', site: 'International', name: 'Brown-Forman' },
    { company: 'wilhelmsen', instance: 'wd3', site: 'Wilhelmsen', name: 'Wilhelmsen' },
    { company: 'europcar', instance: 'wd103', site: 'EuropcarCareerPage', name: 'Europcar' },
    { company: 'db', instance: 'wd3', site: 'DBWebsite', name: 'Deutsche Bank' },
    { company: 'pae', instance: 'wd1', site: 'Amentum_Careers', name: 'Amentum' },
    { company: 'villeroyboch', instance: 'wd3', site: 'careers', name: 'Villeroy & Boch' },
    { company: 'holmanautogroup', instance: 'wd1', site: 'HolmanEnterprisesCareers', name: 'Holman' },
    { company: 'kbr', instance: 'wd5', site: 'KBR_Careers', name: 'KBR' },
    { company: 'movadogroup', instance: 'wd1', site: 'Careers', name: 'Movado Group' },
    { company: 'barrywehmiller', instance: 'wd1', site: 'BWCareers', name: 'Barry-Wehmiller' },
    { company: 'skechers', instance: 'wd5', site: 'One-career-site', name: 'Skechers' },
    { company: 'otis', instance: 'wd5', site: 'REC_Ext_Gateway', name: 'Otis' },
    { company: 'esab', instance: 'wd5', site: 'esabcareers', name: 'ESAB' },
    { company: 'ttiemea', instance: 'wd3', site: 'TTI', name: 'TTI (Techtronic Industries)' },
    { company: 'jm', instance: 'wd103', site: 'External', name: 'Johnson Matthey' },
    { company: 'faro', instance: 'wd1', site: 'FARO', name: 'FARO Technologies' },
    { company: 'cw', instance: 'wd1', site: 'External', name: 'Curtiss-Wright' },
    { company: 'livanova', instance: 'wd5', site: 'Search', name: 'LivaNova' },
    { company: 'relx', instance: 'wd3', site: 'ReedExhibitions', name: 'RELX (Reed Exhibitions)' },
    { company: 'zuehlke', instance: 'wd3', site: 'Zuhlke-Careers', name: 'Zühlke' },

    // --- REMOTE EXPANSION 2026-08-04 ---
    // Tenant triples resolved by probing company × instance × site and keeping
    // only the combinations whose cxs endpoint returned a non-zero total.
    { company: 'salesforce', instance: 'wd12', site: 'External_Career_Site', name: 'Salesforce' },
    { company: 'hp', instance: 'wd5', site: 'ExternalCareerSite', name: 'HP' },
    { company: 'pnc', instance: 'wd5', site: 'External', name: 'PNC Financial Services' },
    { company: 'keybank', instance: 'wd5', site: 'External_Career_Site', name: 'KeyBank' },
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Base host for a board entry. */
function buildBaseUrl(company, instance) {
    return `https://${company}.${instance}.myworkdayjobs.com`;
}

async function fetchJobsPage(listUrl, offset) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(listUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' }),
            signal: controller.signal,
        });

        if (!response.ok) return null;
        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every board, paginating each. No location filtering.
 * @param {Array<{company:string,instance:string,site:string,name:string}>} slugList
 * @returns {Promise<object[]>}
 */
/**
 * Fetches one Workday board, paginating it to the cap. Pages within a board stay
 * sequential — the offset walk is inherently serial.
 *
 * Exported so the incremental pipeline can hash one board at a time.
 *
 * @param {{company:string, instance:string, site:string, name:string}} board
 * @returns {Promise<object[]>}
 */
export async function fetchCompanyJobs(board) {
    const { company, instance, site, name } = board;
    const baseUrl = buildBaseUrl(company, instance);
    const listUrl = `${baseUrl}/wday/cxs/${company}/${site}/jobs`;

    console.log(`[Workday] Fetching: ${company}...`);

    try {
        const firstData = await fetchJobsPage(listUrl, 0);
        if (!firstData) {
            return [];
        }

        const total = firstData.total || 0;
        if (!total) return [];

        const decorate = (postings) => (postings || []).map(posting => ({
            ...posting,
            _company: company,
            _instance: instance,
            _site: site,
            _companyName: name,
        }));

        const companyJobs = decorate(firstData.jobPostings);
        let offset = PAGE_SIZE;
        let pageCount = 1;

        while (offset < total
            && pageCount < MAX_PAGES_PER_COMPANY
            && companyJobs.length < MAX_JOBS_PER_COMPANY) {
            await sleep(PAGE_DELAY_MS);

            const pageData = await fetchJobsPage(listUrl, offset);
            if (!pageData) break;

            companyJobs.push(...decorate(pageData.jobPostings));
            offset += PAGE_SIZE;
            pageCount++;

            console.log(`[Workday] ${company}: page ${pageCount}, ${companyJobs.length} jobs so far...`);
        }

        // A tenant whose last page overshoots the cap is trimmed, so the
        // logged number and the number kept always agree.
        if (companyJobs.length > MAX_JOBS_PER_COMPANY) {
            companyJobs.length = MAX_JOBS_PER_COMPANY;
        }

        if (companyJobs.length < total) {
            console.log(`[Workday] ${company}: capped at ${companyJobs.length} jobs (total available: ${total})`);
        }

        console.log(`[Workday] ${company}: ${companyJobs.length} jobs fetched`);

        // Kept per worker: paces this slot's next board.
        await sleep(COMPANY_DELAY_MS);

        return companyJobs;

    } catch (error) {
        console.error(`[Workday] ${company} (${name}): ${error?.message || error}`);
        return [];
    }
}

/** Drops duplicate board entries, which would otherwise yield duplicate jobs. */
export function dedupeBoards(slugList) {
    const seen = new Set();
    return slugList.filter(board => {
        const key = `${board.company}_${board.site}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Fetches every job from every board. No location filtering.
 * @param {Array<object>} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const boards = dedupeBoards(slugList);
    console.log(`[Workday] Fetching jobs from ${boards.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    const allJobs = collectFulfilled(await runConcurrent(boards, fetchCompanyJobs, FETCH_CONCURRENCY));

    console.log(`[Workday] ${allJobs.length} jobs fetched in total`);
    return allJobs;
}

/**
 * Fetches the detail payload — description, workplace type, employment type,
 * department, apply URL and posted date all live there, not in the list.
 * Returns the job unchanged if the call fails.
 *
 * @param {object} job
 * @returns {Promise<object>}
 */
export async function enrichJob(job) {
    const { _company, _instance, _site, externalPath } = job;
    if (!_company || !_instance || !_site || !externalPath) return job;

    const baseUrl = buildBaseUrl(_company, _instance);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${baseUrl}/wday/cxs/${_company}/${_site}${externalPath}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });

        if (!response.ok) return job;

        const data = await response.json();
        return { ...job, _detail: data };

    } catch (error) {
        return job;
    } finally {
        clearTimeout(timeoutId);
    }
}

/** jobPostingInfo block from the detail payload, or an empty object. */
function getInfo(job) {
    return job._detail?.jobPostingInfo || {};
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    // externalPath is always unique: /job/Hamburg/Revenue-Analyst_JR108514.
    // bulletFields is not — some tenants put the country there instead of a req id.
    const path = job.externalPath || '';
    const reqFromPath = path.split('_').pop() || '';
    const reqFromBullet = job.bulletFields?.[job.bulletFields?.length - 1] || '';
    const reqId = reqFromPath || reqFromBullet || path;
    return `workday_${job._company}_${reqId}`;
}

export function extractJobTitle(job) {
    return job.title || '';
}

export function extractCompany(job) {
    return job._companyName || job._detail?.hiringOrganization?.name || job._company || '';
}

export function extractLocation(job) {
    if (job.locationsText) return job.locationsText;
    // Some tenants (Europcar) put location in bulletFields: ['Germany','Hamburg','JR108514']
    if (Array.isArray(job.bulletFields) && job.bulletFields.length >= 2) {
        const [country, city] = job.bulletFields;
        if (city && country) return `${city}, ${country}`;
        if (country) return country;
    }
    return '';
}

export function extractAllLocations(job) {
    if (job.locationsText) {
        return normalizeArray(job.locationsText.split(',').map(part => part.trim()));
    }
    if (Array.isArray(job.bulletFields) && job.bulletFields.length >= 2) {
        return normalizeArray([`${job.bulletFields[1]}, ${job.bulletFields[0]}`]);
    }
    return [];
}

/**
 * Workday exposes no country field at any level, so it is read off the location
 * string. bulletFields[0] is checked first because when a tenant uses that shape
 * it holds the country outright.
 */
export function extractCountry(job) {
    if (Array.isArray(job.bulletFields) && job.bulletFields.length >= 2 && !job.locationsText) {
        return job.bulletFields[0] || null;
    }
    return parseCountryFromLocation(extractLocation(job));
}

export function extractDescription(job) {
    return StripHtml(getInfo(job).jobDescription || '');
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(getInfo(job).jobDescription || '');
}

export function extractURL(job) {
    const info = getInfo(job);
    if (info.externalUrl) return info.externalUrl;
    if (!job._company || !job._instance || !job._site || !job.externalPath) return null;
    return `${buildBaseUrl(job._company, job._instance)}/${job._company}/${job._site}/job${job.externalPath}`;
}

export function extractDirectApplyURL(job) {
    return getInfo(job).externalUrl || null;
}

export function extractPostedDate(job) {
    const startDate = getInfo(job).startDate;
    return startDate ? new Date(startDate) : null;
}

export function extractDepartment(job) {
    const info = getInfo(job);
    return info.jobFunctionSummary || info.jobFamily || job._detail?.hiringOrganization?.industry || 'N/A';
}

/**
 * Pre-enrichment the list payload has no workplace field, so the location string
 * is the only signal ("Remote, United States"). Post-enrichment the detail's
 * remoteType is authoritative and wins.
 */
export function extractWorkplaceType(job) {
    const info = getInfo(job);
    const fromDetail = info.remoteType || info.workplaceType || info.locationType;
    if (fromDetail) return normalizeWorkplaceType(fromDetail);
    return normalizeWorkplaceType(extractLocation(job));
}

export function extractIsRemote(job) {
    return extractWorkplaceType(job) === 'Remote';
}

export function extractEmploymentType(job) {
    const info = getInfo(job);
    return normalizeEmploymentType(info.timeType || info.jobType);
}

export function extractTags(job) {
    return normalizeArray(Array.isArray(job.bulletFields) ? job.bulletFields : []);
}

// Workday's public cxs endpoints do not expose compensation.
export function extractSalaryMin() { return null; }
export function extractSalaryMax() { return null; }
export function extractSalaryCurrency() { return null; }
export function extractSalaryInterval() { return null; }

export function extractATSPlatform() {
    return 'workday';
}
