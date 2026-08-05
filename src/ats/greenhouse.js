// ─── Greenhouse ────────────────────────────────────────────────────────────────
//
// API: GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
// One request per company returns the whole board with full descriptions.
// No pagination, no auth.
//
// Unlike the German pipeline's config, fetchAllJobs() does NOT filter by
// location — it returns every job from every board. Country and remote filtering
// happen in index.js.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import { normalizeEmploymentType, normalizeWorkplaceType, parseCountryFromLocation } from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'greenhouse';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';
const REQUEST_DELAY_MS = 400;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;

export const COMPANY_SLUGS = [
    'airbnb', 'stripe', 'figma', 'airtable', 'gitlab', 'reddit', 'pinterest',
    'twitch', 'deliveryhero', 'getaround', 'wolt', 'personio', 'contentful',
    'celonis', 'adjust', 'signavio', 'sennder', 'n26', 'gorillas', 'flink',
    'trade-republic', 'taxfix', 'raisin', 'heyjobs', 'omio', 'scalablecapital',
    'eyeo', 'jimdo', 'shopify', 'datadog', 'notion', 'miro', 'zapier', 'asana',
    'dropbox', 'docusign', 'confluent', 'databricks', 'snowflake', 'hashicorp',
    'cloudflare', 'mongodb', 'elastic', 'okta', 'zendesk', 'hubspot', 'intercom',
    'segment', 'amplitude', 'mixpanel', 'launchdarkly', 'pagerduty', 'sumo-logic',
    'new-relic', 'splunk', 'dynatrace',
    'doctolib', 'sumup', 'flix', 'jetbrains', 'ionos', 'helsing', 'isaraerospace',
    'staffbase', 'moia', 'freenow', 'scout24', 'parloa', 'autoscout24',
    'trustpilot', 'finanzcheck', 'nice', 'grafanalabs', 'catawiki', 'navvis',
    'clickhouse', 'flaconi', 'moonfare', 'trivago', 'adyen', 'zscaler', 'anaplan',
    'think-cell', 'commercetools', 'grover', 'pleo', 'apaleo', 'idnow', 'typeform',
    'dataiku', 'workato', 'mirakl', 'bitpanda', 'tanium', 'smartsheet', 'anydesk',
    'spryker', 'strato', 'fivetran', 'tripadvisor', 'fireblocks', 'bitgo',
    'beyondtrust', 'tekla', 'adahealth', 'qualtrics', 'sofi', 'riotgames', 'udemy',
    'klaviyo', 'cultureamp', 'planradar', 'five9', 'wooga', 'braze', 'bloomreach',
    'konux', 'jfrog', 'cockroachlabs', 'scaleai', 'algolia', 'veracode', 'wrike',
    'zuora', 'propstack', 'pendo',

    // --- REMOTE EXPANSION 2026-08-04 ---
    'remotecom', 'affirm', 'postman', 'tide', 'justworks', 'vercel',
    'monzo', 'mercury', 'pingidentity', 'marqeta', 'webflow', 'planetscale',
    'lattice', 'ghost', 'doordashusa', 'anthropic', 'chime', 'carta',
    'temporaltechnologies', 'billcom', 'discord', 'betterment', 'zoominfo', 'ziprecruiter',
    'hackerrank', 'salesloft', 'showpad', 'datacamp', 'turing', 'greenhouse',
    'coursera', 'udacity', 'calendly', 'skillsoft', 'upwork', 'stackblitz',
    'karat', 'builtin', 'cornerstone', 'netskope', 'cribl', 'blackduck',
    'tailscale', 'fastly', 'dragos', 'jamf', 'huntress', 'axonius',
    'sumologic', 'dashlane', 'honeycomb', 'bitwarden', 'lastpass', 'buildkite',
    'cybereason', 'expel', 'circleci', 'netlify', 'classpass', 'peloton',
    'zocdoc', 'bird', 'veracyte', 'omadahealth', 'spin', 'mindbody',
    'gymshark', 'amwell', 'branch', 'parsleyhealth', 'calm', 'onetrust',
    'gocardless', 'alloy', 'britive', 'bigid', 'truelayer', 'lithic',
    'highnote', 'osano', 'treasuryprime',

    // --- DISCOVERED 2026-08-04 ---
    'spacex', 'waymo', 'brex', 'samsara', 'oscar', 'block',
    'twilio', 'coinbase', 'hubspotjobs', 'lyft', 'flexport', 'ripple',
    'robinhood', 'instacart', 'oura', 'gusto', 'dialpad', 'proton',
    'faire', 'chainguard', 'hightouch', 'duolingo', 'keepersecurity', 'pandadoc',
    'linkedin', 'newrelic', 'thunes', 'gemini', 'attentive', 'later',
    'forter', 'blockchain', 'stockx', 'project44', 'flatironhealth', 'komodohealth',
    'celigo', 'customerio', 'complyadvantage', 'iterable', 'automatticcareers', 'khanacademy',
    'riskified', 'carbon', 'linkedinjobs', 'make', 'squarespace', 'typeface',
    'hootsuite', 'weights_and_biases', 'dominodatalab', 'fourkites', 'storyblok', 'narvar',
    'deepmind', 'descript', 'orcasecurity', 'doximity', 'fleet', 'route',
    'flipdish', 'instabase', 'descope', 'kickstarter', 'stabilityai', 'consensys',
    'form3', 'cleo', 'nansen', 'mercari', 'masterclass', 'athena',
    'public', 'remote', 'new', 'dataikujobs', 'figment', 'socket',
    'orca', 'teachablecareers', 'letsgetchecked',

    // --- DISCOVERED 2026-08-04 ---
    'pulse', 'agency', 'hellofresh', 'stage', 'billiontoone', 'astranis',
    'clara', 'clutch', 'abacus', 'inversionspace', 'oklo', 'humaninterest',
    'powerx', 'alpaca', 'getyourguide', 'cabify', 'checkr', 'instawork',
    'flex', 'cognite', 'nex', 'maymobility', 'pairteam', 'axle',
    'ivalua', 'gigs', 'singlestore', 'clear', 'relex', 'apolloio',
    'behavox', 'nabis', 'aclu', 'prolific', 'shifttechnology', 'camp',
    'squad', 'kalshi', 'qventus', 'icarus', 'xendit', 'daybreakhealth',
    'gostudent', 'marqvision', 'truecaller', 'goatgroup', 'mentimeter', 'ledgy',
    'heartaerospace', 'truebill', 'odeko', 'observeai', 'extend', 'momentic',
    'axiom', 'radar', 'hive', 'sendbird', 'ophelia', 'coast',
    'ginkgobioworks', 'nanonets', 'mesh', 'hazel', 'symphony', 'akidolabs',
    'pelago', 'swayable', 'scandit', 'modernhealth', 'flip', 'carrotfertility',
    'openwork', 'journey', 'attain', 'refurbed', 'mattermost', 'givecampus',
    'plume', 'starcloud', 'wallapop', 'veriff', 'focalsystems', 'osmosis',
    'weave', 'novacredit', 'momentus', 'carbonchain', 'beam', 'guild',
    'bitmovin', 'assemblyai', 'prodigal', 'recidiviz', 'generalproximity', 'prospa',
    'clever', 'saltsecurity', 'haven', 'albedo', 'burnt', 'zerocater',
    'lob', 'seed', 'outschool', 'pursuit', 'roofr', 'ansabiotechnologies',
    'regent', 'sensei', 'smartasset', 'legalist', 'upkeep', 'postscript',
    'laika', 'hubblenetwork', 'raven', 'axial', 'mantis', 'trident',
    'zencoder', 'sirum', 'papa', 'enveritas', 'niraenergy', 'diligent',
    'realm', 'cortex', 'warp', 'feanixbiotechnologies', 'understoodcare', 'superset',
    'usergems', 'culturebiosciences', 'grey', 'reflex', 'nexus', 'dispatch',
    'juno', 'submittable', 'cocoon', 'glide', 'momence', 'baubap',
    'luminate', 'navierai', 'sunset', 'traderepublic', 'genius', 'athinkingape',
    'sfox', 'tempo', 'tetra', 'aon3d', 'meruhealth', 'gather',
    'seer', 'dots', 'newton', 'paradigm', 'archer', 'whitespace',

    // --- DISCOVERED 2026-08-04 ---
    'dept', 'ebury', 'valtech', 'lighthouse', 'collibra', 'flowtraders',
    'relativity', 'imc', 'proof', 'impact', 'spire', 'ever',
    'uplift', 'known', 'mobius', 'legion', 'array', 'alt',
    'rosebud', 'factored', 'parallel', 'karbon', 'solari', 'ora',
    'shelf', 'beyond', 'david', 'poka', 'understood', 'spaceium',
    'able', 'quilt', 'verse', 'hatchcareers', 'aura', 'candid',
    'ansa', 'future', 'harmonic', 'iris', 'b12', 'geniusjobs',
    'thrive', 'method', 'current', 'serif', 'imt', 'village',
    'sixfold', 'recall', 'thesiscareers', 'industrial', 'eclipse', 'paragoncareers',
    'general', 'medium', 'sei', 'integrated', 'yuma', 'spotlight',
    'praxis', 'swordhealth',

    // --- DISCOVERED 2026-08-04 ---
    'stone', 'super', 'vast', 'inter', 'essential', 'mozilla',
    'engine', 'oliver', 'nintendo', 'peak', 'excel', 'latitude',
    'glance', 'wing', 'orchestra', 'techno', 'playlist', 'disco',
    'coalition', 'place', 'prophet', 'bandwidth', 'align', 'example',
    'link', 'further', 'solutions', 'figure', 'sunrise', 'mill',
    'oasis', 'forbes', 'upgrade', 'focused', 'roller', 'sonic',
    'find', 'tomorrow', 'honor', 'veterans', 'boulevard', 'prove',
    'range', 'nothing', 'lincoln', 'echo', 'insider', 'ireland',
    'elite', 'brave', 'help', 'action', 'instead', 'candles',
    'insurance', 'flash', 'outside', 'released', 'india', 'goal',
    'lift', 'antenna', 'knit', 'chile', 'blend', 'watershed',
    'national', 'space', 'converted', 'fellow', 'shadow', 'hook',
    'allied', 'forward', 'testing', 'patch', 'residential', 'secondary',
    'moon', 'scanner', 'invisible', 'isaac', 'system', 'education',
    'charles', 'festival', 'decisions', 'strike', 'builder', 'automated',
    'interval', 'cabin', 'belize', 'briefly', 'tract', 'london',
    'none', 'ohio', 'portable', 'ultimate', 'oklahoma', 'adapter',
    'edinburgh', 'benjamin', 'cycles', 'durable', 'spencer', 'gravity',
    'galaxy', 'ensemble', 'endorsed', 'found', 'japan', 'administrative',
    'refer', 'supreme', 'superior', 'logos', 'dublin', 'broadway',
    'jamaica', 'struck', 'apparatus', 'location', 'capacity', 'nursing',
    'universal', 'disney', 'brothers', 'sterling', 'decide', 'domains',
    'pine', 'talent', 'noble', 'strictly', 'homeland', 'lions',
    'remedy', 'highland', 'antigua', 'hometown', 'knock', 'support',
    'international', 'community', 'technology', 'interest', 'australia', 'drive',
    'basic', 'opportunities', 'summer', 'contract', 'chicago', 'spain',
    'workshop', 'delete', 'explore', 'netherlands', 'korea', 'vendor',
    'denver', 'taiwan', 'gateway', 'metro', 'bold', 'portugal',
    'victory', 'bulgaria', 'franchise', 'rehabilitation', 'fits', 'athletics',
    'minimal', 'flickr', 'optimal', 'shield', 'informal', 'transform',
    'mighty', 'prospects', 'unlock', 'casa', 'keen', 'blacks',

    // --- DISCOVERED 2026-08-04 ---
    'infuse', 'monks', 'olsson', 'toast', 'roku', 'marksman',
    'lush', 'quince', 'artefact', 'reformation', 'eucalyptus', 'upstart',
    'atoms', 'metropolis', 'mullins', 'rebuilt', 'tulip', 'kodiak',
    'armada', 'lovable', 'gallup', 'fetch', 'comstock', 'hark',
    'bathhouse', 'accordion', 'slice', 'brady', 'dojo', 'conga',
    'bees', 'tamara', 'goodman', 'convene', 'fender', 'keystone',
    'octus', 'firsthand', 'pantheon', 'crescent', 'orchard', 'otter',
    'octave', 'nerdy', 'trolley', 'lockwood', 'nucleus', 'hover',
    'pronto', 'airspace', 'fingerprint', 'airship', 'afresh', 'pallet',
    'raft', 'rumble', 'ritual', 'magnolia', 'newsweek', 'enforce',
    'liberate', 'ifit', 'motive', 'lifted', 'prevail', 'fulfil',
    'flamingo', 'suki', 'liftoff', 'starburst', 'wight', 'aperture',
    'orderly', 'galileo', 'foundry', 'westbrook', 'octagon', 'ezra',
    'presidents', 'earnest', 'peachy', 'counterpart', 'translucent', 'winton',
    'levitate', 'springboard', 'napoleon', 'bennie', 'wasabi', 'oddball',
    'goop', 'acumen', 'bravo', 'brennan', 'educate', 'hearst',
    'boku', 'centennial', 'hovercraft', 'philo', 'viaduct', 'nooks',
    'modernize', 'activate', 'spins', 'mako', 'olly', 'protagonist',
    'baton', 'cerebral', 'bobbie', 'wheelhouse', 'minty', 'teague',
    'homeward', 'seesaw', 'murad', 'nametag', 'coefficient', 'noah',
    'oath', 'daylight', 'kettle', 'jackpot', 'staged', 'didi',
    'imply', 'aligned', 'teammate', 'voter', 'caribou', 'zola',
    'collectively', 'roadie', 'defcon', 'resonate', 'reactivate', 'prospectus',
    'seurat', 'canto', 'comet', 'maxwell', 'credible', 'gator',
    'flourish', 'barbarian', 'goodwin', 'pawnee', 'margaux', 'ponderosa',
    'hogwarts', 'capitalize', 'imre', 'outshine', 'lakewood', 'padilla',
    'arnie', 'ingenious', 'grin', 'encore', 'warwick', 'boldly',
    'checkbook', 'founders', 'elly', 'momentous', 'indigo', 'dorset',
    'bethesda', 'caregiver', 'gremlin', 'sandler', 'cline', 'implicit',
    'splice', 'recast', 'scotch', 'dwight', 'bark', 'countryside',
    'dragons', 'thorn', 'skinner', 'outsiders', 'bernadette', 'hologram',
    'aziz', 'cavanaugh', 'cheddar', 'tranquility', 'symmetry', 'blip',
    'inbound', 'fruitful', 'outlive', 'craftsman', 'hanover', 'hone',
    'kano', 'hiram', 'cameo', 'evermore', 'devine', 'sylvain',
    'fermat', 'alameda', 'polaris', 'rawls', 'shawnee', 'signpost',
    'wingspan', 'insomniac', 'biosphere', 'inroads', 'expedition', 'profound',
    'dante', 'vega', 'warsaw', 'ignition', 'manifest', 'poetic',
    'digs', 'thea', 'watermelon', 'staging', 'rooted', 'ethic',
    'spotter', 'gearbox', 'revel', 'spitfire', 'kana', 'kayak',
    'incumbent', 'trove', 'tester', 'reliant', 'synaptic', 'resilience',
    'chicory', 'omicron', 'candidly', 'nimbus',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Metadata helpers ─────────────────────────────────────────────────────────

function metadataToObject(metadata) {
    if (!metadata) return {};
    if (Array.isArray(metadata)) {
        const result = {};
        for (const item of metadata) {
            if (!item?.name) continue;
            result[item.name] = item.value;
        }
        return result;
    }
    if (typeof metadata === 'object') return metadata;
    return {};
}

function findMetadataValue(metadataObj, keywords = []) {
    const entries = Object.entries(metadataObj || {});
    for (const [key, value] of entries) {
        const lowered = key.toLowerCase();
        if (keywords.some(keyword => lowered.includes(keyword))) {
            return value;
        }
    }
    return null;
}

// Greenhouse has no salary fields — pay ranges are prose inside `content`.
function parseSalaryFromText(text) {
    if (!text) return {};
    const cleaned = StripHtml(text).replace(/\./g, '').replace(/,/g, '.');

    const currencyMatch = cleaned.match(/(USD|EUR|GBP|CHF|CAD|AUD|JPY|SEK|NOK|DKK|PLN)/i);
    const symbolMatch = cleaned.match(/[€$£]/);
    const rangeMatch = cleaned.match(/(\d{2,7}(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d{2,7}(?:\.\d+)?)/i);

    let salaryCurrency = null;
    if (currencyMatch) {
        salaryCurrency = currencyMatch[1].toUpperCase();
    } else if (symbolMatch) {
        if (symbolMatch[0] === '€') salaryCurrency = 'EUR';
        if (symbolMatch[0] === '$') salaryCurrency = 'USD';
        if (symbolMatch[0] === '£') salaryCurrency = 'GBP';
    }

    let salaryInterval = null;
    const lower = cleaned.toLowerCase();
    if (lower.includes('per hour') || lower.includes('/hour') || lower.includes('hourly')) salaryInterval = 'per-hour-wage';
    if (lower.includes('per month') || lower.includes('/month') || lower.includes('monthly')) salaryInterval = 'per-month-salary';
    if (lower.includes('per year') || lower.includes('/year') || lower.includes('annual') || lower.includes('yearly')) salaryInterval = 'per-year-salary';

    return {
        SalaryMin: rangeMatch ? Number(rangeMatch[1]) : null,
        SalaryMax: rangeMatch ? Number(rangeMatch[2]) : null,
        SalaryCurrency: salaryCurrency,
        SalaryInterval: salaryInterval,
    };
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every board. No location filtering.
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
 * @param {string} boardToken
 * @returns {Promise<object[]>}
 */
export async function fetchCompanyJobs(boardToken) {
    console.log(`[Greenhouse] Fetching: ${boardToken}...`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${BASE_URL}/${boardToken}/jobs?content=true`, {
            signal: controller.signal,
        });

        if (!response.ok) {
            return [];
        }

        // A dead or renamed board can answer 200 with an HTML error page,
        // so the parse is guarded rather than the status trusted alone.
        let data;
        try {
            data = await response.json();
        } catch {
            console.warn(`[Greenhouse] ${boardToken}: response was not valid JSON`);
            return [];
        }

        const jobs = data.jobs || [];
        console.log(`[Greenhouse] ${boardToken}: ${jobs.length} jobs fetched`);

        if (jobs.length === 0) return [];

        // Kept per worker: paces this slot's next request, so the platform
        // sees at most FETCH_CONCURRENCY requests per delay window.
        await sleep(REQUEST_DELAY_MS);

        return jobs.map(job => ({ ...job, _boardToken: boardToken }));

    } catch (error) {
        console.error(`[Greenhouse] ${boardToken}: ${error.message}`);
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
    console.log(`[Greenhouse] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    const allJobs = collectFulfilled(await runConcurrent(slugList, fetchCompanyJobs, FETCH_CONCURRENCY));

    console.log(`[Greenhouse] ${allJobs.length} jobs fetched in total`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    return `greenhouse_${job._boardToken}_${job.id}`;
}

export function extractJobTitle(job) {
    return job.title;
}

export function extractCompany(job) {
    const boardToken = job._boardToken;

    // Greenhouse's own field, present on every board that sets a display name.
    // Checked first: it is authoritative and needs no guessing.
    if (job.company_name) return job.company_name;

    if (Array.isArray(job.metadata) && job.metadata.length > 0) {
        const companyField = job.metadata.find(m => m.name?.toLowerCase().includes('company'));
        // The VALUE must be non-empty, not merely the field present. Several
        // boards (Reddit among them) define a metadata field literally named
        // "Company" and leave its value null — returning it unchecked produced
        // documents with no company at all.
        const value = typeof companyField?.value === 'string' ? companyField.value.trim() : '';
        if (value) return value;
    }

    return String(boardToken || '')
        .split(/[-_]/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function extractLocation(job) {
    return job.location?.name || '';
}

export function extractDescription(job) {
    return StripHtml(job.content || '');
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(job.content || '');
}

export function extractURL(job) {
    return job.absolute_url;
}

export function extractDirectApplyURL() {
    return null;
}

export function extractPostedDate(job) {
    return job.updated_at;
}

export function extractDepartment(job) {
    const fromDepartments = Array.isArray(job.departments) && job.departments.length > 0 ? job.departments[0]?.name : null;
    if (fromDepartments) return fromDepartments;
    const metadata = metadataToObject(job.metadata);
    return findMetadataValue(metadata, ['department', 'team']) || 'N/A';
}

export function extractAllLocations(job) {
    const officeLocations = (job.offices || []).map(office => office?.location).filter(Boolean);
    return normalizeArray([job.location?.name, ...officeLocations]);
}

/**
 * Greenhouse has no country field — only a display string. Read the country off
 * the primary location, falling back to any office that names one.
 */
export function extractCountry(job) {
    const fromLocation = parseCountryFromLocation(job.location?.name);
    if (fromLocation) return fromLocation;

    for (const office of job.offices || []) {
        const fromOffice = parseCountryFromLocation(office?.location);
        if (fromOffice) return fromOffice;
    }
    return null;
}

export function extractEmploymentType(job) {
    const metadata = metadataToObject(job.metadata);
    const value = findMetadataValue(metadata, ['employment', 'contract', 'time']);
    return normalizeEmploymentType(value);
}

/**
 * Greenhouse exposes no workplace field. The German pipeline hardcoded
 * 'Unspecified'; here the location string is the only remote signal there is
 * ("Remote - US", "Remote, United Kingdom"), so it gets normalized instead.
 */
export function extractWorkplaceType(job) {
    return normalizeWorkplaceType(job.location?.name);
}

export function extractIsRemote(job) {
    return extractWorkplaceType(job) === 'Remote';
}

export function extractTags(job) {
    const metadata = metadataToObject(job.metadata);
    const tags = [];
    for (const [key, value] of Object.entries(metadata)) {
        if (!value) continue;
        if (Array.isArray(value)) {
            tags.push(...value.map(v => `${key}:${v}`));
        } else {
            tags.push(`${key}:${value}`);
        }
    }
    return normalizeArray(tags);
}

export function extractSalaryCurrency(job) {
    const fromContent = parseSalaryFromText(job.content || '');
    if (fromContent.SalaryCurrency) return fromContent.SalaryCurrency;
    const metadata = metadataToObject(job.metadata);
    return findMetadataValue(metadata, ['currency']) || null;
}

export function extractSalaryMin(job) {
    const fromContent = parseSalaryFromText(job.content || '');
    if (Number.isFinite(fromContent.SalaryMin)) return fromContent.SalaryMin;
    const metadata = metadataToObject(job.metadata);
    const val = Number(findMetadataValue(metadata, ['salary min', 'min salary', 'minimum salary', 'comp min']));
    return Number.isFinite(val) ? val : null;
}

export function extractSalaryMax(job) {
    const fromContent = parseSalaryFromText(job.content || '');
    if (Number.isFinite(fromContent.SalaryMax)) return fromContent.SalaryMax;
    const metadata = metadataToObject(job.metadata);
    const val = Number(findMetadataValue(metadata, ['salary max', 'max salary', 'maximum salary', 'comp max']));
    return Number.isFinite(val) ? val : null;
}

export function extractSalaryInterval(job) {
    const fromContent = parseSalaryFromText(job.content || '');
    if (fromContent.SalaryInterval) return fromContent.SalaryInterval;
    const metadata = metadataToObject(job.metadata);
    const raw = findMetadataValue(metadata, ['salary interval', 'interval']);
    if (!raw) return null;
    const lower = String(raw).toLowerCase();
    if (lower.includes('hour')) return 'per-hour-wage';
    if (lower.includes('month')) return 'per-month-salary';
    if (lower.includes('year')) return 'per-year-salary';
    return null;
}

export function extractATSPlatform() {
    return 'greenhouse';
}
