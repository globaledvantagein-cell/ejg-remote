// ─── Ashby ─────────────────────────────────────────────────────────────────────
//
// API: GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// One request per company returns the whole board with full descriptions and
// structured compensation. No pagination, no auth.
//
// Ashby is the richest of the nine: it ships an explicit `workplaceType` and an
// `isRemote` boolean, so remote detection here needs no heuristics.

import fetch from 'node-fetch';
import { StripHtml, SanitizeHtml } from '../utils/html.js';
import {
    normalizeCountry,
    normalizeEmploymentType,
    normalizeWorkplaceType,
    parseCountryFromLocation,
} from '../utils/location.js';
import { normalizeArray } from '../utils/jobFields.js';
import { runConcurrent, collectFulfilled } from '../utils/concurrent.js';

export const ATS_NAME = 'ashby';

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';
const REQUEST_DELAY_MS = 300;
const FETCH_CONCURRENCY = 5;   // companies fetched in parallel per platform
const REQUEST_TIMEOUT_MS = 20000;

export const COMPANY_SLUGS = [
    'Ashby', 'Deel', 'OpenAI', 'Cohere', 'Linear', 'Notion', 'Ramp', 'Mercury',
    'Lattice', 'Supabase', 'Vercel', 'Replit', 'Cal', 'Modal', 'Sourcegraph',
    'Grammarly', 'Scale', 'Hugging-Face', 'Weights-Biases', 'dbt-labs',
    'Replicate', 'Together', 'Perplexity', 'Cursor', 'Anthropic', 'Mistral',
    'Stability', 'Adept', 'Character', 'Inflection', 'Personio', 'Contentful',
    'Celonis', 'Taxfix', 'Raisin', 'N26', 'Trade-Republic', 'Sennder', 'Adjust',
    'GetYourGuide', 'Delivery-Hero', 'Auto1', 'Zalando', 'HelloFresh',
    'Rocket-Internet',
    'moss', 'upvest', 'deepl', 'amboss', 'bunch', 'leapsome', 'carwow', 'rohlik',
    'pleo', 'lemon-markets', 'forto', 'billie', 'alephalpha', 'docker', 'babbel',
    'mollie', 'cosmos', 'rasa', 'airwallex', 'redis', 'uipath', 'deliveroo',
    'camunda', 'enpal', 'neon', 'langchain', 'kestra', 'voodoo',

    // --- REMOTE EXPANSION 2026-08-04 ---
    'Harvey', 'ElevenLabs', 'Sierra', 'Abridge', 'Amplitude', 'Attio',
    'Render', 'Warp', 'Mutiny', 'Airbyte', 'Posthog', 'Railway',
    'Runway', 'Hightouch', 'Vanta', 'Drata', 'Jane', 'Socket',
    'Secureframe', 'Semgrep', 'Alchemy', 'Amber', 'Oneleet', 'Paxos',
    'Infisical', 'Uniswap', 'Compound', 'QuickNode', 'Blockdaemon', 'Doppler',
    'Jump', 'Miro', 'Orb', 'Workos', 'Paddle', 'Persona',
    'Passage', 'Zapier', 'Footprint', 'Stytch', 'Thinkific',

    // --- DISCOVERED 2026-08-04 ---
    'Whoop', 'Zip', 'Plaid', 'Socure', 'Kong', 'Hinge-Health',
    'Synthesia', '1Password', 'Baseten', 'Vultr', 'Delinea', 'Temporal',
    'Writer', 'Docebo', 'Benchling', 'Sentry', 'Constructor', 'Chainalysis-careers',
    'Thought-Machine', 'Trading212', 'Sardine', 'Jobber', 'Wealthsimple', 'Quantexa',
    'SafetyCulture', 'OakNorth', 'Iterable', 'Sanity', 'Poshmark', 'Oyster',
    'Anyscale', 'Gorgias', 'Wayflyer', 'LlamaIndex', 'ClearBank', 'Substack',
    'Bubble', 'Mural', 'Sift', 'Acorns', 'Ledger', 'Improbable',
    'Dave', 'Freetrade', 'ModernTreasury', 'Patreon', 'Beamery', 'Pinecone',
    'Vector', 'Prefect', 'Unit', 'Lightspeed', 'Stash', 'Dune',
    'Recharge', 'Cedar', 'Weaviate', 'MagicEden', 'FullStory', 'Ghost',
    'OpenSea', 'Bunny', 'Inngest', 'Orca',

    // --- DISCOVERED 2026-08-04 ---
    'snowflake', 'legora', 'doctolib', 'nord-security', 'trm-labs', 'finni-health',
    'alan', 'satispay', 'deepgram', 'clickup', 'eightsleep', 'tailor',
    'taktile', 'overview', 'speak', 'permitflow', 'astro-mechanica', 'exa',
    'supercell', 'voize', 'stepful', 'qonto', 'kalshi', 'candidhealth',
    'fieldguide', 'litmus', 'arq', 'encord', 'confluent', 'twenty',
    'weave', 'clipboard', 'vapi', 'campfire', 'afterquery', 'confido',
    'glia', 'level', 'retell-ai', 'skydropx', 'reducto', 'hexa',
    'roboflow', 'vetcove', 'onebrief', 'juicebox', 'docplanner', 'middesk',
    'savvy', 'nash', 'avoca', 'bynder', 'tremendous', 'versemedical',
    'omni', 'numeral', 'trustly', 'curri', 'tennr', 'radar',
    'revenuecat', 'legionhealth', 'lemfi', 'turion-space', 'latent', 'rivet',
    'capimoney', 'vibe', 'primer', 'amenitiz', 'padlet', 'shortstory',
    'ditto', 'abacum', 'triomics', 'hivehealth', 'float', 'aspora',
    'firecrawl', 'phonely', 'rescale', 'shepherd', 'mintlify', 'fuse',
    'epidemic-sound', 'healthsherpa', 'gecko-robotics', 'humaans', 'tavus', 'fleek',
    'metriport', 'aiprise', 'garage', 'backmarket', 'chariot', 'promise',
    'flux', 'signoz', 'sphere', 'posh', 'solveintelligence', 'codes-health',
    'nox-metals', 'lunar', 'frontify', 'nanonets', 'universe', 'topline-pro',
    'claimsorted', 'humanarchive', 'classdojo', 'aios', 'camber', 'charge-robotics',
    'aurelian', 'litellm', 'outset', 'pointone', '9-mothers', 'boom',
    'duffel', 'ziina', 'odys-aviation', 'pylon', 'resend', 'modus',
    'hud', 'auctor', 'eloquentai', 'choco', 'spellbrush', 'vori',
    'photoroom', 'atob', 'formal', 'arketa', 'regent', 'bree',
    'mach9', 'novig', 'vooma', 'brettonai', 'furtherai', 'clarion',
    'circleback', 'kastle', 'david-ai', 'sygaldry-technologies', 'sapien', 'plane',
    'titan', 'glide', 'benepass', 'junction', 'luminai', 'sieve',
    'lancedb', 'salient', 'extend', 'gumloop', 'artisan', 'verahealth',
    'lucis', 'circuithub', 'tilt', 'tempo', 'pulse', 'glimpse',
    'flint', 'herondata', 'enode', 'quindar', 'concourse', 'terminal',
    'safetykit', 'healthtech-1', 'fulcrum', 'gelato', 'cambly', 'permutive',
    'corvus-robotics', 'atlas', 'dex', 'atomic', 'ready', 'aleph',
    'agave', 'happl', 'govdash', 'langfuse', 'honeydew', 'sagecare',
    'sphinx', 'solidroad', 'minerva', 'claim-health', 'reacher', 'sazabi',
    'dispatch', 'corti', 'close', 'flip', 'outschool', 'switchboard',
    'probablygenetic', 'thndr', 'blissway', 'stacker', 'notabene', 'anima',
    'phoenix', 'h3x-technologies', 'ollama', 'meticulous', 'complete', 'blink',
    'automat', 'casca', 'sweep', 'tamarindbio', 'aqua-voice', 'ultra',
    'substrate', 'saturn', 'simple-ai', 'mosaic', 'halluminate', 'ycombinator',
    'hatch', 'sable', 'phonic', 'stable', 'belvo', 'spruceid',
    'hypercore', 'invert', 'cinder', 'spade', 'realitydefender', 'two-dots',
    'unify', 'thera', 'magicpatterns', 'relace', 'vitalize', 'escape',
    'hockeystack', 'fleetworks', 'decodahealth', 'sola', 'paradigm', 'usul',
    'sunset', 'interfere', 'uplane', 'complir', 'meadow', 'snapmagic',
    'mednet', 'golinks', 'verto', 'ello', 'lightdash', 'novel',
    'popl', 'kodex', 'zensors', 'skylink', 'eventual', 'blee',
    'cambio', 'finvest', 'electricair', 'glade', 'offdeal', 'zeit-ai',
    'dataleap', 'sim', 'prox', 'lance', 'asimov', 'cardboard',
    'polymath', 'guild', 'marble', 'sorare', 'snapdocs', 'assembly',
    'prelim', 'squad', 'bunkerhillhealth', 'deepnote', 'accord', 'humanly',
    'powerus', 'yotta', 'kingdom', 'axle-health', 'liveflow', 'flutterflow',
    'parallel-bio', 'lago', 'aviator', 'stream', 'julius', 'pirros',
    'cosine', 'bluedot', 'invopop', 'artie', 'hyperbound', 'foundation',
    'onyx', 'greptile', 'pivotrobotics', 'polar', 'doublezero', 'anara',
    'abundant', 'innate', 'salespatriot', 'blaxel', 'chestnut', 'truthsystems',
    'flai', 'idler', 'diligencesquared', 'beyondreachlabs', 'constellationspace', 'caremessage',
    'reach', 'armory', 'breaker', 'headstart', 'blueberrypediatrics', 'paragon',
    'datafold', 'finch', 'hudu', 'svix', 'double', 'windmill',
    'ekho', 'knowtex', 'nango', 'inkeep', 'loula', 'wallbit',
    'pure', 'hazel', 'brainbaselabs', 'mem0', 'anthrogen', 'thundercompute',
    'conductor', 'ctgt', 'bild-ai', 'axiom', 'dedalus-labs', 'agentmail',
    'interface', 'solva', 'kernel', 'fleetline', 'sol', 'the-token-company',
    'infera', 'influxdata', 'aptible', 'bankjoy', 'mux', 'castle',
    'rezi', 'upcodes', 'cointracker', 'edwin', 'runa', 'prometheus',
    'anglehealth', 'hotplate', 'farel', 'authzed', 'simplify', 'replo',
    'formance', 'oneschema', 'birdie', 'boostly', 'tank-payments', 'bitstack',
    'rollstack', 'depot', 'goveagle', 'metal', 'airgoods', 'fortuna-health',
    'tekton-dynamics', 'momentic', 'greenboard', 'centralize', 'focal', 'commodityai',
    'fazeshift', 'archil', 'capy', 'apolink', 'reviserobotics', 'mastra',
    'wafer', 'foresight', 'opennote', 'veritus', 'compresr', 'maven',
    'brainly', 'tenjin', 'readme', 'shasqi', 'new-story', 'verge-genomics',
    'onechronos', 'pursuit', 'simetrik', 'snackpass', 'beacons', 'rutter',
    'freshpaint', 'vorticity', 'ladder', 'Fig', 'atrato', 'greatquestion',
    'infracost', 'jiga', 'warpbuild', 'malga', 'phasebiolabs', 'triggerdev',
    'coperniq', 'kivo-health', 'conduit', 'vellum', 'tuesday-labs', 'arini',
    'spur', 'clearly-ai', 'pharos', 'ryvn', 'flowtel', 'butter',
    'ambral', 'jeevyfabrication', 'pingo', 'mangodesk', 'lark', 'careswift',
    'bootloop', 'misolabs', 'hyperspell', 'hypercubic', 'onerobot', 'assemble',
    'tsenta', 'chronicle-labs', 'cosmic-robotics',

    // --- DISCOVERED 2026-08-04 ---
    'helion', 'cognition', 'lambda', 'meter', 'rain', 'broccoli',
    'stellar', 'orbital', 'frontcareers', 'relay', 'parallel', 'notable',
    'andromeda', 'shift', 'artemis', 'maple', 'glow', 'nabla',
    'bland', 'axle-careers', 'corgi', 'empirical', 'spotlight', 'method',
    'sequence', 'ontra', 'arlo', 'human', 'dyneti', 'output',
    'pivot', 'seneca', 'harmonic', 'stealth', 'the-flex', 'known',
    'finary', 'finny', 'light', 'vitable', 'forerunner', 'theflex',
    'flock', 'nomic', 'elyos', 'intelligence', 'fullstack', 'recall',
    'credal', 'libra', 'context', 'catena', 'avallon', 'bolna',
    'outrival', 'bite', 'synthetic', 'cranston', 'multiply', 'rev',
    'axel', 'aragorn', 'electric', 'argon-ai', 'laminar-jobs', 'formula',
    'button',

    // --- DISCOVERED 2026-08-04 ---
    'applied', 'barnes', 'faculty', 'directive', 'range', 'owner',
    'silver', 'opened', 'genesis', 'factory', 'watershed', 'tabs',
    'agent', 'gamma', 'prompt', 'span', 'cube', 'sunday',
    'focused', 'assured', 'campus', 'cape', 'swap', 'fundamental',
    'column', 'phil', 'dust', 'capable', 'numeric', 'junior',
    'clark', 'collective', 'merge', 'casa', 'april', 'away',
    'console', 'incident', 'lyric', 'wonderful', 'counsel', 'arena',
    'access', 'sent', 'safe', 'moment', 'hawk', 'phantom',
    'company', 'january', 'town', 'warren', 'adaptive', 'real',
    'skip', 'acquisition', 'parker', 'quantum', 'lightning', 'sunrise',
    'conduct', 'plain', 'monaco', 'change', 'conversion', 'generate',
    'magical', 'pencil', 'namespace', 'share', 'valid', 'bureau',
    'interaction', 'intro', 'architect', 'material', 'build', 'dimensional',
    'unwrap', 'lens', 'coastal', 'phrase', 'found', 'base',
    'movement', 'icon', 'zero', 'granted', 'tight', 'arcade',
    'hook', 'hang', 'arch', 'brunswick', 'velocity', 'shapes',
    'texture', 'resolution', 'weekend', 'pearl', 'regard', 'twelve',
    'harmony', 'bernard', 'decimal', 'post', 'anything', 'simply',
    'chief', 'dakota', 'wilson', 'plot', 'citizen', 'tiger',
    'passes', 'clarity', 'nirvana', 'sail', 'special', 'grand',
    'gardens', 'linda', 'timely', 'griffin', 'knock', 'going',
    'archive', 'further', 'levels', 'focus', 'catalog', 'steel',
    'attention', 'ocean', 'wheel', 'edited', 'liquid', 'eagle',
    'buffer', 'obvious', 'spare', 'stylus', 'ment', 'vanilla',
    'arbor', 'union', 'primary', 'stand', 'reserve', 'matrix',
    'refer', 'bold', 'arthur', 'reset', 'olympus', 'composite',
    'passport', 'latitude', 'gravity', 'darwin', 'complement', 'reservoir',
    'beside', 'optimum', 'smallest',

    // --- DISCOVERED 2026-08-04 ---
    'crusoe', 'halter', 'leland', 'perk', 'handshake', 'etched',
    'mach', 'profound', 'dandy', 'humanoid', 'volta', 'headway',
    'industrious', 'lovable', 'ideals', 'fireworks', 'vogel', 'hopper',
    'kayak', 'amplify', 'nooks', 'antares', 'kirin', 'steadily',
    'equip', 'scribe', 'specter', 'lemonade', 'xenon', 'rainmaker',
    'astronomer', 'canals', 'felix', 'radiant', 'sesame', 'nudge',
    'abound', 'solace', 'darkroom', 'viktor', 'crisp', 'rowan',
    'multiverse', 'envoy', 'imprint', 'hercules', 'monumental', 'superpower',
    'dapper', 'crosby', 'singular', 'solstice', 'allocate', 'aaru',
    'upside', 'hiya', 'blacksmith', 'revel', 'doss', 'leap',
    'marshmallow', 'cantina', 'siena', 'nelly', 'granola', 'bounce',
    'playground', 'chalk', 'lassie', 'orchard', 'motorway', 'prelude',
    'emergence', 'poolside', 'grounded', 'virtuous', 'opal', 'quartermaster',
    'tomo', 'buena', 'snowball', 'dandelion', 'protege', 'siro',
    'omniscient', 'sanctuary', 'augustus', 'duet', 'atticus', 'zilch',
    'kyra', 'kota', 'laurel', 'amigo', 'scarlet', 'sparrow',
    'sleeper', 'bestow', 'knot', 'peek', 'cloaked', 'sona',
    'boosters', 'artsy', 'kira', 'swan', 'mirage', 'pika',
    'overflow', 'tracksuit', 'elicit', 'openly', 'capsule', 'eliza',
    'irregular', 'snappy', 'jellyfish', 'swoop', 'fable', 'astra',
    'sandstone', 'lapel', 'vesta', 'loki', 'stacks', 'maki',
    'daydream', 'grotto', 'kinship', 'propel', 'inertia', 'summation',
    'kuro', 'rebar', 'monk', 'corridor', 'aisle', 'poetic',
    'odin', 'conception', 'outpost', 'tides', 'clair', 'vantage',
    'outsmart', 'somethings', 'freda', 'adonis', 'quorum', 'sekai',
    'graphite', 'tread', 'apron', 'ignition', 'foley', 'paradox',
    'squads', 'ajax', 'seon', 'spruce', 'smalls', 'flipper',
    'nous', 'ando', 'slant', 'codex', 'bastion', 'aslan',
    'kiefer', 'airspeed', 'ravenna', 'temper', 'ropes', 'baba',
    'freed', 'ernest', 'meow', 'hyde', 'leopard', 'dusk',
    'ledge', 'cello', 'swans', 'inherent', 'coworker', 'playbook',
    'gradient', 'leona', 'endgame', 'delphi', 'rerun', 'trove',
    'anagram', 'thorin', 'moxie', 'speakeasy', 'mandolin', 'materialize',
    'tachyon', 'monogram', 'inference', 'limbic', 'spiral', 'victorious',
    'evolve', 'neptune', 'hamster', 'pilgrim', 'worldly', 'stronghold',
    'molecule', 'kindred', 'georgian', 'prose', 'anterior', 'polaroid',
    'remo', 'winona', 'mycroft', 'trig', 'cleric', 'halliday',
    'augur', 'pensive', 'windfall', 'nuna', 'euphoric', 'symbiotic',
    'clove', 'oath', 'bruno', 'gorilla', 'inclined', 'slate',
    'conquest', 'goody', 'trajectory', 'baton', 'backbone', 'kale',
    'sahara', 'firsthand', 'mast', 'clubhouse', 'aida', 'symmetry',
    'pathways', 'clasp', 'whisk', 'porters', 'bridger', 'grapevine',
    'exclaim', 'liven', 'lottie', 'pemberton', 'anon', 'falconer',
    'lovelace', 'arrakis', 'contra', 'deductive', 'earthforce', 'oberst',
    'incandescent', 'mona', 'shook', 'tango', 'impulse', 'clarify',
    'revive', 'vivid', 'espresso', 'flawless', 'rewind', 'glacier',
    'faction', 'odyssey', 'deduction', 'stork', 'rhythms', 'tenor',
    'ascertain', 'tenderly', 'caruso', 'hobbes', 'vasco', 'nomad',
    'caribou', 'sentient', 'kinetic', 'fizz', 'katana', 'discern',
    'yadda', 'amma', 'toms', 'zeno', 'luxor', 'antioch',
    'spherical', 'pathos', 'scholarly', 'telemachus', 'maniac', 'flora',
    'vega', 'adapt', 'raft', 'convey', 'believer', 'aviv',
    'dipper', 'jigsaw', 'walrus', 'alden', 'craze', 'brimstone',
    'lifespan', 'miri', 'genies', 'breadwinner', 'collider', 'vitally',
    'maca', 'brumby',
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function findCompensationComponent(job, typeName) {
    const summaryComponents = job?.compensation?.summaryComponents || [];
    const tierComponents = (job?.compensation?.compensationTiers || []).flatMap(tier => tier.components || []);
    const all = [...summaryComponents, ...tierComponents];
    return all.find(component => String(component?.compensationType || '').toLowerCase() === String(typeName).toLowerCase()) || null;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches every job from every board. No location filtering.
 * @param {string[]} slugList
 * @returns {Promise<object[]>}
 */
export async function fetchAllJobs(slugList = COMPANY_SLUGS) {
    const allJobs = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`[Ashby] Fetching jobs from ${slugList.length} companies (${FETCH_CONCURRENCY} at a time)...`);

    /** Fetches one board. Returns its jobs, or [] on any failure. */
    async function fetchBoard(boardName) {
        console.log(`[Ashby] Fetching: ${boardName}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`${BASE_URL}/${boardName}?includeCompensation=true`, {
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
                console.warn(`[Ashby] ${boardName}: response was not valid JSON`);
                return [];
            }

            const jobs = data.jobs || [];
            console.log(`[Ashby] ${boardName}: ${jobs.length} jobs fetched`);

            if (jobs.length === 0) return [];

            successCount++;

            // Kept per worker: paces this slot's next request.
            await sleep(REQUEST_DELAY_MS);

            return jobs.map(job => ({ ...job, _boardName: boardName }));

        } catch (error) {
            failCount++;
            console.error(`[Ashby] ${boardName}: ${error.message}`);
            return [];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    allJobs.push(...collectFulfilled(await runConcurrent(slugList, fetchBoard, FETCH_CONCURRENCY)));

    console.log(`[Ashby] ${allJobs.length} jobs from ${successCount} boards (${failCount} failed/empty)`);
    return allJobs;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

export function extractJobID(job) {
    const urlParts = String(job.jobUrl || '').split('/');
    return `ashby_${job._boardName}_${urlParts[urlParts.length - 1]}`;
}

export function extractJobTitle(job) {
    return job.title;
}

export function extractCompany(job) {
    return String(job._boardName || '')
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function extractLocation(job) {
    const secondaries = (job.secondaryLocations || []).map(sec => sec?.location).filter(Boolean);
    const all = normalizeArray([job.location, ...secondaries]);
    return all.length > 0 ? all.join(', ') : '';
}

export function extractDescription(job) {
    return StripHtml(job.descriptionPlain || job.descriptionHtml || '');
}

export function extractDescriptionHtml(job) {
    return SanitizeHtml(job.descriptionHtml || '');
}

export function extractURL(job) {
    return job.jobUrl || job.applyUrl;
}

export function extractDirectApplyURL(job) {
    return job.applyUrl || null;
}

export function extractPostedDate(job) {
    return job.publishedAt;
}

export function extractDepartment(job) {
    return job.department || 'N/A';
}

export function extractAllLocations(job) {
    const secondaries = (job.secondaryLocations || []).map(sec => sec?.location).filter(Boolean);
    return normalizeArray([job.location, ...secondaries]);
}

/**
 * Prefers the structured postal address; falls back to the trailing segment of
 * the display location for boards that omit the address block.
 */
export function extractCountry(job) {
    const structured = normalizeCountry(job?.address?.postalAddress?.addressCountry);
    if (structured) return structured;
    return parseCountryFromLocation(job.location);
}

export function extractEmploymentType(job) {
    return normalizeEmploymentType(job.employmentType);
}

export function extractWorkplaceType(job) {
    return normalizeWorkplaceType(job.workplaceType);
}

/**
 * NOTE: this deliberately diverges from ashbyConfig.js, which treats Hybrid as
 * remote. For a remote-only scraper that would be a false positive, so only the
 * ATS's own boolean and an explicit Remote workplace type count.
 */
export function extractIsRemote(job) {
    if (typeof job.isRemote === 'boolean') return job.isRemote;
    return normalizeWorkplaceType(job.workplaceType) === 'Remote';
}

export function extractTags(job) {
    return normalizeArray([job.department, job.team, job.workplaceType, job.employmentType]);
}

export function extractSalaryCurrency(job) {
    const salary = findCompensationComponent(job, 'Salary');
    return salary?.currencyCode || null;
}

export function extractSalaryMin(job) {
    const salary = findCompensationComponent(job, 'Salary');
    return Number.isFinite(salary?.minValue) ? salary.minValue : null;
}

export function extractSalaryMax(job) {
    const salary = findCompensationComponent(job, 'Salary');
    return Number.isFinite(salary?.maxValue) ? salary.maxValue : null;
}

export function extractSalaryInterval(job) {
    const salary = findCompensationComponent(job, 'Salary');
    if (!salary?.interval) return null;
    const lower = String(salary.interval).toLowerCase();
    if (lower.includes('year')) return 'per-year-salary';
    if (lower.includes('month')) return 'per-month-salary';
    if (lower.includes('hour')) return 'per-hour-wage';
    return null;
}

export function extractATSPlatform() {
    return 'ashby';
}
