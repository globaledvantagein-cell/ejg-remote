// ─── Remote Saver ──────────────────────────────────────────────────────────────
//
// Persistence for remote jobs. Writes into the dedicated `remoteJobs`
// collection, tagged with jobScope "remote", and with every field the
// frontend/cache/filter layer expects.

const JOBS_COLLECTION = 'remoteJobs';

// Gender tags German and European ATS platforms append to titles. Stripped so
// "Senior Engineer (m/f/d)" and "Senior Engineer (all genders)" collapse to the
// same dedup key.
const GENDER_TAG_PATTERN = /\((?:\s*(?:m|w|f|d|x|all\s+genders?|any\s+gender|divers|alle\s+geschlechter)\s*[\/|,·-]?\s*)+\)/gi;

// Every spelling of a whitelisted country the nine ATS platforms emit → ISO
// alpha-2. Normalising here rather than in each extractCountry keeps the ATS
// modules free to return whatever their API gives them.
const COUNTRY_CODE_MAP = new Map(Object.entries({
    // United States
    'us': 'US', 'usa': 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'united states': 'US',
    'united states of america': 'US', 'america': 'US',
    // United Kingdom
    'gb': 'GB', 'uk': 'GB', 'gbr': 'GB', 'u.k.': 'GB', 'united kingdom': 'GB',
    'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
    'northern ireland': 'GB',
    // Canada
    'ca': 'CA', 'can': 'CA', 'canada': 'CA',
    // Australia
    'au': 'AU', 'aus': 'AU', 'australia': 'AU',
    // Ireland
    'ie': 'IE', 'irl': 'IE', 'ireland': 'IE', 'republic of ireland': 'IE',
    // New Zealand
    'nz': 'NZ', 'nzl': 'NZ', 'new zealand': 'NZ',
    // Singapore
    'sg': 'SG', 'sgp': 'SG', 'singapore': 'SG',
}));

/**
 * Maps any known spelling of a country to its ISO alpha-2 code.
 *
 * Unrecognised values are returned trimmed and uppercased rather than dropped —
 * a job that reached the saver has already passed the country whitelist, so an
 * unmapped value means the map is behind the whitelist, and silently writing
 * null would hide that. Null/empty in, null out.
 *
 * @param {string|null|undefined} country
 * @returns {string|null}
 */
export function normalizeCountryCode(country) {
    if (!country) return null;

    const cleaned = String(country).trim();
    if (!cleaned) return null;

    return COUNTRY_CODE_MAP.get(cleaned.toLowerCase()) || cleaned.toUpperCase();
}

// Legal-entity suffixes. Only stripped as whole words — "AG" must not eat the
// tail of "Chainalysis".
const LEGAL_SUFFIXES = [
    'incorporated', 'corporation', 'holdings', 'holding', 'limited', 'group',
    'gmbh', 'corp', 'llc', 'inc', 'ltd', 'plc', 'bv', 'nv', 'ag', 'se', 'sa',
    'lp', 'co',
];

// Descriptive suffixes an ATS board token tends to carry that the company's own
// name does not: "Hubspotjobs" → "hubspot", "AshbyHQ" → "ashby".
//
// Split by how they may attach:
//   GLUED  — also stripped when run together with the name. Safe because almost
//            no company name genuinely ends in these letters.
//   SPACED — only stripped as a separate word. Stripping these glued would
//            maul real names: "Twilio" ends in "io", "Whatsapp" in "app".
const GLUED_SUFFIXES = ['jobs', 'careers', 'hq'];
const SPACED_SUFFIXES = ['technologies', 'technology', 'software', 'labs', 'lab', 'app', 'io', 'ai'];

/**
 * Canonicalises a company name for duplicate detection.
 *
 * The same employer reaches us under several spellings depending on the ATS —
 * "Reddit, Inc." from one board, "Reddit" from another, "Hubspotjobs" from a
 * board token. All must collapse to one key or the cross-ATS dedup never fires.
 *
 * @param {string} company
 * @returns {string}
 */
export function normalizeCompany(company) {
    let name = String(company || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        // Punctuation → space, so "reddit,inc." and "reddit inc" converge.
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Repeat: "Acme Technologies Inc" needs two passes to shed both suffixes.
    for (let pass = 0; pass < 3; pass++) {
        const before = name;

        for (const suffix of [...LEGAL_SUFFIXES, ...SPACED_SUFFIXES]) {
            name = name.replace(new RegExp(`\\s+${suffix}$`), '');
        }
        for (const suffix of GLUED_SUFFIXES) {
            name = name.replace(new RegExp(`\\s*${suffix}$`), '');
        }

        name = name.replace(/\s+/g, ' ').trim();
        if (name === before) break;
    }

    // Never return empty: a one-word name that is itself a suffix ("Group")
    // should key on itself rather than collapse into every other stripped name.
    return name || String(company || '').toLowerCase().trim();
}

/**
 * Canonicalises a job title for duplicate detection.
 *
 * Drops gender tags and every parenthesised qualifier, folds the Sr./Jr.
 * abbreviations to their long forms, and strips trailing location/scope
 * decorations that differ between boards for the same posting.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
    let text = String(title || '')
        .toLowerCase()
        .replace(GENDER_TAG_PATTERN, ' ')
        // Every parenthesised group, not just trailing ones:
        // "Engineer (Remote) - EMEA (US)" → "engineer - emea".
        .replace(/\([^()]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ');

    // Seniority abbreviations → long form, so "Sr. Engineer" and "Senior
    // Engineer" share a key. The word boundary sits before the optional period
    // rather than after it: `\bsr\.?\b` cannot match the boundary between "."
    // and a following space, so it backtracks and leaves the period stranded
    // ("senior. engineer").
    text = text
        .replace(/\bsr\b\.?/g, 'senior')
        .replace(/\bjr\b\.?/g, 'junior');

    // Trailing scope decorations, repeatedly: "Engineer - Remote - US".
    for (let pass = 0; pass < 3; pass++) {
        const before = text;
        text = text.replace(
            /\s*[-–—,|]\s*(remote|hybrid|onsite|us|usa|uk|gb|eu|emea|apac|worldwide|global|anywhere|united\s+states|united\s+kingdom|canada|australia|ireland|singapore)\s*$/,
            '',
        );
        if (text === before) break;
    }

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * The key two postings must share to be considered the same job.
 * Same company + same canonical title + same country.
 *
 * @param {string} company
 * @param {string} title
 * @param {string|null} country
 * @returns {string}
 */
export function buildDedupKey(company, title, country) {
    // All three components are normalised: the same posting reaches us with the
    // company spelled differently per ATS, the title decorated differently, and
    // the country as a code or a display name.
    const code = normalizeCountryCode(country) || '';
    return `${normalizeCompany(company)}|${normalizeTitle(title)}|${code}`;
}

/**
 * True when a remote job with the same company/title/country is already stored.
 *
 * @param {import('mongodb').Db} db
 * @param {string} company
 * @param {string} title
 * @param {string|null} country
 * @returns {Promise<boolean>}
 */
export async function deduplicateRemoteJob(db, company, title, country) {
    const dedupKey = buildDedupKey(company, title, country);

    const existing = await db.collection(JOBS_COLLECTION).findOne(
        { dedupKey, jobScope: 'remote' },
        { projection: { _id: 1 } },
    );

    return Boolean(existing);
}

// Title/department keyword → { Category, Domain }. Ordered: the first match
// wins, so the more specific buckets are listed before the broad ones.
// This is a coarse stand-in for the German pipeline's AI categorisation — good
// enough to drive category filters, not intended to be exact.
const CATEGORY_RULES = [
    { keywords: ['product manager', 'product owner', 'product management'], category: 'product-tech', domain: 'Non-Technical' },
    { keywords: ['data', 'analytics', 'analyst', 'machine learning', ' ai ', 'ai/', 'artificial intelligence'], category: 'data', domain: 'Technical' },
    { keywords: ['engineer', 'developer', 'devops', 'sre', 'architect', 'backend', 'back-end', 'frontend', 'front-end', 'fullstack', 'full-stack', 'full stack'], category: 'software', domain: 'Technical' },
    { keywords: ['design', 'ux', 'ui'], category: 'other-technical', domain: 'Technical' },
    { keywords: ['marketing', 'sales', 'business development', 'account'], category: 'other-non-technical', domain: 'Non-Technical' },
];

/**
 * Derives a rough Category/Domain pair from the job title and department.
 * No AI involved — keyword matching only.
 *
 * @param {string} title
 * @param {string} [department]
 * @returns {{category:string, domain:string}}
 */
export function categorizeFromTitle(title, department) {
    // Pad with spaces so ' ai ' can match at the string edges too.
    const haystack = ` ${String(title || '')} ${String(department || '')} `.toLowerCase();

    for (const rule of CATEGORY_RULES) {
        if (rule.keywords.some(keyword => haystack.includes(keyword))) {
            return { category: rule.category, domain: rule.domain };
        }
    }

    return { category: 'other-technical', domain: 'Technical' };
}

/**
 * Upserts a fully-mapped remote job.
 *
 * New job      → inserted active, with jobScope/approvalMethod/timestamps.
 * Existing job → only `scrapedAt` is refreshed, so an active listing stays fresh
 *                without clobbering anything downstream (e.g. an AI enrichment
 *                pass) that may have written to the document since.
 *
 * @param {import('mongodb').Db} db
 * @param {object} jobDoc - full job document, must carry JobID
 * @returns {Promise<{saved:boolean, isNew:boolean}>}
 */
export async function saveRemoteJob(db, jobDoc) {
    const jobs = db.collection(JOBS_COLLECTION);
    const now = new Date();

    // Single choke point for country normalisation: every document written to
    // Mongo carries an ISO alpha-2 code, whatever the source ATS returned.
    const doc = { ...jobDoc, Country: normalizeCountryCode(jobDoc.Country) };

    const existing = await jobs.findOne(
        { JobID: doc.JobID },
        { projection: { _id: 1, Status: 1 } },
    );

    if (existing) {
        if (existing.Status === 'active') {
            await jobs.updateOne({ _id: existing._id }, { $set: { scrapedAt: now } });
            return { saved: true, isNew: false };
        }
        // Non-active (expired/rejected) documents are left untouched — resurrecting
        // them is the main pipeline's decision, not this scraper's.
        return { saved: false, isNew: false };
    }

    await jobs.insertOne({
        ...doc,
        Status: 'active',
        jobScope: 'remote',
        approvalMethod: 'remote_auto',
        createdAt: now,
        scrapedAt: now,
    });

    return { saved: true, isNew: true };
}
