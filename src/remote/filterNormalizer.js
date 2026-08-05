// ─── Filter Normalizer ─────────────────────────────────────────────────────────
//
// Copied verbatim from job-Data/src/utils/filterNormalizer.js so remote jobs
// carry exactly the same filter* fields as German-pipeline jobs and the frontend
// queries work unchanged. The `parsedRequirements` (Gemma) branches are dead
// code in this project — nothing here runs AI extraction — but they are kept so
// the two copies stay diffable and so a job later enriched by the main pipeline
// resolves identically.
//
// Reconciles the two independent sources of truth on a job document — the raw
// ATS-scraped fields (WorkplaceType, ExperienceLevel, EmploymentType, Salary*)
// and the Gemma AI-extracted `parsedRequirements` — into a single set of
// canonical, lowercase filter values the frontend can query directly.
//
// TRUST HIERARCHY (which source wins when they disagree):
//   Workplace   : Gemma remote_policy_detail (≠ not_mentioned) → ATS WorkplaceType
//                 → scan Location for "remote" → null
//   Experience  : Gemma experience_level → ATS ExperienceLevel → isEntryLevel flag → null
//   Employment  : Gemma employment_type → ATS EmploymentType → null
//   Salary      : ATS SalaryMin/SalaryMax (structured beats text) → Gemma salary_*
//                 → null. The PAIR is atomic: sources are never mixed within one
//                 job. If the ATS provided EITHER bound, the ATS wins the whole
//                 pair (tier "ats"); only when the ATS has neither do we fall to
//                 Gemma (tier "jd").
//   Visa        : Gemma visa_sponsorship only. "available" → "available", else null.
//   Relocation  : Gemma relocation_support only. "available" → "available", else null.
//
// Every exported function is null-safe, tolerates a missing `parsedRequirements`
// or missing ATS fields, and never throws.

// Hardcoded FX fallbacks — no API call. A salary filter tolerates stale rates;
// these move slowly enough that a coarse bucket is unaffected. All salaries are
// normalized to yearly EUR integers before storage.
const CURRENCY_TO_EUR = {
    EUR: 1,
    USD: 0.92,
    GBP: 1.17,
    CHF: 1.05,
};

// Interval → multiplier to convert an amount to a yearly figure.
const INTERVAL_TO_YEARLY = {
    yearly: 1,
    monthly: 12,
    hourly: 2080, // 40 hours × 52 weeks
};

// Yearly salary sanity bounds — anything outside is treated as a misread.
const SALARY_YEARLY_BOUNDS = { min: 10000, max: 1000000 };

// ─── ATS normalization maps (lowercased keys → canonical value) ────────────────
// Exhaustive across the 9 ATS platforms plus Gemma's own enum outputs. Keys are
// stored lowercase; lookups lowercase their input first for O(1) matching.

const WORKPLACE_MAP = new Map(Object.entries({
    'remote': 'remote',
    'fully remote': 'remote',
    'fully_remote': 'remote',
    'hybrid': 'hybrid',
    'partially remote': 'hybrid',
    'partially_remote': 'hybrid',
    'flexible': 'hybrid',
    'on-site': 'onsite',
    'on_site': 'onsite',
    'onsite': 'onsite',
    'in-office': 'onsite',
    'office': 'onsite',
}));

const EXPERIENCE_MAP = new Map(Object.entries({
    'entry level': 'entry',
    'entry': 'entry',
    'entry_level': 'entry',
    'junior': 'entry',
    'intern': 'entry',
    'internship': 'entry',
    'student': 'entry',
    'werkstudent': 'entry',
    'praktikant': 'entry',
    // "Mid-Senior level" is LinkedIn's format, widely copied. Intent is
    // senior-leaning, so it maps to "senior" (not "mid").
    'mid-senior level': 'senior',
    'mid': 'mid',
    'mid level': 'mid',
    'mid_level': 'mid',
    'mid-level': 'mid',
    'associate': 'mid',
    'fachkraft': 'mid',
    'experienced': 'mid',
    'professional': 'mid',
    'ic2': 'mid',
    'ic3': 'mid',
    'senior': 'senior',
    'senior level': 'senior',
    'senior_level': 'senior',
    'ic4': 'senior',
    'staff': 'senior',
    'lead': 'lead',
    'principal': 'lead',
    'staff engineer': 'lead',
    'teamleiter': 'lead',
    'team lead': 'lead',
    'director': 'executive',
    'vp': 'executive',
    'vice president': 'executive',
    'head of': 'executive',
    'c-level': 'executive',
    'executive': 'executive',
    'geschäftsführer': 'executive',
    'managing director': 'executive',
    'cto': 'executive',
    'ceo': 'executive',
    'cfo': 'executive',
    'coo': 'executive',
    'ciso': 'executive',
}));

const EMPLOYMENT_MAP = new Map(Object.entries({
    'full-time': 'fulltime',
    'fulltime': 'fulltime',
    'full_time': 'fulltime',
    'permanent': 'fulltime',
    'regular': 'fulltime',
    'festanstellung': 'fulltime',
    'unbefristet': 'fulltime',
    'vollzeit': 'fulltime',
    'fulltime_fixed_term': 'fulltime',
    'part-time': 'parttime',
    'parttime': 'parttime',
    'part_time': 'parttime',
    'teilzeit': 'parttime',
    'contract': 'contract',
    'freelance': 'contract',
    'temporary': 'contract',
    'befristet': 'contract',
    'fixed-term': 'contract',
    'contractor': 'contract',
    'zeitarbeit': 'contract',
    'internship': 'internship',
    'werkstudent': 'internship',
    'working student': 'internship',
    'praktikum': 'internship',
    'ausbildung': 'internship',
    'apprenticeship': 'internship',
}));

/** Look up `raw` in `map` case-insensitively. Returns canonical value or null. */
function lookup(map, raw) {
    if (raw === null || raw === undefined) return null;
    const key = String(raw).trim().toLowerCase();
    if (!key) return null;
    return map.get(key) ?? null;
}

/**
 * Resolve the canonical workplace type for a job.
 * Gemma remote_policy_detail wins → ATS WorkplaceType → Location scan → null.
 * @param {object} job - full job document
 * @returns {"remote"|"hybrid"|"onsite"|null}
 */
export function resolveWorkplace(job) {
    if (!job) return null;

    const gemmaRaw = job.parsedRequirements?.remote_policy_detail;
    if (gemmaRaw && String(gemmaRaw).toLowerCase() !== 'not_mentioned') {
        const fromGemma = lookup(WORKPLACE_MAP, gemmaRaw);
        if (fromGemma) return fromGemma;
    }

    const fromAts = lookup(WORKPLACE_MAP, job.WorkplaceType);
    if (fromAts) return fromAts;

    // Location strings only ever surface "Remote" (Greenhouse). Never "hybrid".
    if (String(job.Location || '').toLowerCase().includes('remote')) return 'remote';

    return null;
}

/**
 * Resolve the canonical experience level for a job.
 * Gemma experience_level wins → ATS ExperienceLevel → isEntryLevel flag → null.
 * @param {object} job - full job document
 * @returns {"entry"|"mid"|"senior"|"lead"|"executive"|null}
 */
export function resolveExperience(job) {
    if (!job) return null;

    const fromGemma = lookup(EXPERIENCE_MAP, job.parsedRequirements?.experience_level);
    if (fromGemma) return fromGemma;

    const fromAts = lookup(EXPERIENCE_MAP, job.ExperienceLevel);
    if (fromAts) return fromAts;

    if (job.isEntryLevel === true) return 'entry';

    return null;
}

/**
 * Resolve the canonical employment type for a job.
 * Gemma employment_type wins → ATS EmploymentType → null.
 * @param {object} job - full job document
 * @returns {"fulltime"|"parttime"|"contract"|"internship"|null}
 */
export function resolveEmployment(job) {
    if (!job) return null;

    const fromGemma = lookup(EMPLOYMENT_MAP, job.parsedRequirements?.employment_type);
    if (fromGemma) return fromGemma;

    return lookup(EMPLOYMENT_MAP, job.EmploymentType);
}

/**
 * Resolve visa sponsorship. Only confirmed positives are surfaced.
 * @param {object} job - full job document
 * @returns {"available"|null}
 */
export function resolveVisa(job) {
    return job?.parsedRequirements?.visa_sponsorship === 'available' ? 'available' : null;
}

/**
 * Resolve relocation support. Only confirmed positives are surfaced.
 * @param {object} job - full job document
 * @returns {"available"|null}
 */
export function resolveRelocation(job) {
    return job?.parsedRequirements?.relocation_support === 'available' ? 'available' : null;
}

/** Coerce to a finite positive number, or null. */
function toPositiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Convert a raw amount to a yearly-EUR integer, or null if it can't be
 * converted (unknown currency) or falls outside yearly bounds after conversion.
 */
function toYearlyEur(amount, currency, interval) {
    if (amount === null) return null;

    const rate = CURRENCY_TO_EUR[currency];
    if (!rate) return null; // unknown currency — cannot convert reliably

    const multiplier = INTERVAL_TO_YEARLY[interval] ?? 1; // unknown interval → yearly
    const yearly = Math.round(amount * multiplier * rate);

    if (yearly < SALARY_YEARLY_BOUNDS.min || yearly > SALARY_YEARLY_BOUNDS.max) return null;
    return yearly;
}

/**
 * Resolve salary into a canonical yearly-EUR pair with its source tier.
 *
 * The ATS wins the whole pair if it provided EITHER bound (structured data beats
 * text extraction); only when the ATS has neither bound do we fall to Gemma.
 * Sources are never mixed within a single job. All amounts are converted to
 * yearly EUR integers and validated against yearly bounds; out-of-bounds amounts
 * become null. When neither source yields a usable amount, everything is null.
 *
 * @param {object} job - full job document
 * @returns {{min:number|null, max:number|null, currency:string|null, interval:string|null, tier:"ats"|"jd"|null}}
 */
export function resolveSalary(job) {
    const empty = { min: null, max: null, currency: null, interval: null, tier: null };
    if (!job) return empty;

    const atsMin = toPositiveNumber(job.SalaryMin);
    const atsMax = toPositiveNumber(job.SalaryMax);

    const pr = job.parsedRequirements;
    const gemmaMin = toPositiveNumber(pr?.salary_min);
    const gemmaMax = toPositiveNumber(pr?.salary_max);

    let rawMin, rawMax, rawCurrency, rawInterval, tier;

    if (atsMin !== null || atsMax !== null) {
        rawMin = atsMin;
        rawMax = atsMax;
        rawCurrency = job.SalaryCurrency;
        rawInterval = job.SalaryInterval;
        tier = 'ats';
    } else if (gemmaMin !== null || gemmaMax !== null) {
        rawMin = gemmaMin;
        rawMax = gemmaMax;
        rawCurrency = pr?.salary_currency;
        rawInterval = pr?.salary_interval;
        tier = 'jd';
    } else {
        return empty;
    }

    const currency = typeof rawCurrency === 'string' ? rawCurrency.toUpperCase() : null;
    const interval = typeof rawInterval === 'string' ? rawInterval.toLowerCase() : 'yearly';

    const min = toYearlyEur(rawMin, currency, interval);
    const max = toYearlyEur(rawMax, currency, interval);

    // Nothing survived conversion/bounds — treat as no salary.
    if (min === null && max === null) return empty;

    // Everything is stored normalized to yearly EUR.
    return { min, max, currency: 'EUR', interval: 'yearly', tier };
}

/**
 * Reconcile every filter field for a job in one pass. Returns the flat
 * `filter*` shape that gets persisted onto the document and served to clients.
 * @param {object} job - full job document
 * @returns {{filterWorkplace, filterExperience, filterEmployment, filterVisa, filterRelocation, filterSalaryMin, filterSalaryMax, filterSalaryCurrency, filterSalaryInterval, filterSalaryTier}}
 */
export function resolveAll(job) {
    const salary = resolveSalary(job);
    return {
        filterWorkplace: resolveWorkplace(job),
        filterExperience: resolveExperience(job),
        filterEmployment: resolveEmployment(job),
        filterVisa: resolveVisa(job),
        filterRelocation: resolveRelocation(job),
        filterSalaryMin: salary.min,
        filterSalaryMax: salary.max,
        filterSalaryCurrency: salary.currency,
        filterSalaryInterval: salary.interval,
        filterSalaryTier: salary.tier,
    };
}
