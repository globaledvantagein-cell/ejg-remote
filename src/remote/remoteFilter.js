// ─── Remote Filter ─────────────────────────────────────────────────────────────
//
// Decides whether a job scraped from anywhere in the world is (a) posted in an
// English-speaking country we care about, (b) genuinely fully remote, and (c)
// not secretly geo-locked to a country a candidate in Germany cannot work from.
//
// The bar is deliberately high. A false negative costs one missed listing; a
// false positive costs a user an application they were never eligible for.

import { normalizeWorkplaceType } from '../utils/location.js';

// Both 2- and 3-letter ISO codes: ATS platforms are inconsistent about which
// they return (Ashby ships alpha-2, some Workday tenants ship alpha-3).
export const ENGLISH_COUNTRY_WHITELIST = new Set([
    'US', 'USA',
    'GB', 'UK', 'GBR',
    'CA', 'CAN',
    'AU', 'AUS',
    'IE', 'IRL',
    'NZ', 'NZL',
    'SG', 'SGP',
]);

// Full country names → the code we check against the whitelist. Several ATS
// platforms return a display name rather than a code.
const COUNTRY_NAME_TO_CODE = new Map(Object.entries({
    'united states': 'US',
    'united states of america': 'US',
    'usa': 'US',
    'u.s.': 'US',
    'u.s.a.': 'US',
    'america': 'US',
    'united kingdom': 'GB',
    'great britain': 'GB',
    'england': 'GB',
    'scotland': 'GB',
    'wales': 'GB',
    'northern ireland': 'GB',
    'canada': 'CA',
    'australia': 'AU',
    'ireland': 'IE',
    'republic of ireland': 'IE',
    'new zealand': 'NZ',
    'singapore': 'SG',
}));

/**
 * True when a country code or country name refers to one of the whitelisted
 * English-speaking markets. Accepts 'US', 'usa', 'United States', 'GBR', etc.
 *
 * @param {string|null|undefined} countryCode
 * @returns {boolean}
 */
export function isWhitelistedCountry(countryCode) {
    if (!countryCode) return false;

    const cleaned = String(countryCode).trim();
    if (!cleaned) return false;

    if (ENGLISH_COUNTRY_WHITELIST.has(cleaned.toUpperCase())) return true;

    const mapped = COUNTRY_NAME_TO_CODE.get(cleaned.toLowerCase());
    return Boolean(mapped && ENGLISH_COUNTRY_WHITELIST.has(mapped));
}

/**
 * True only for explicitly fully-remote roles.
 *
 * Trust hierarchy — WorkplaceType is authoritative, IsRemote is the fallback:
 *
 *   Remote                  → true
 *   Hybrid / Onsite         → false, regardless of IsRemote
 *   Unspecified (or absent) → fall back to IsRemote
 *
 * The order matters. Many ATS platforms set IsRemote=true to mean "has a remote
 * component", which is true of every hybrid role — so consulting that flag first
 * admits hybrids wholesale. It is only meaningful when the platform declined to
 * state a workplace type at all.
 *
 * @param {string|null|undefined} workplaceType - raw or already-normalized value
 * @param {boolean|null|undefined} isRemoteFlag - the ATS's own boolean, if any
 * @returns {boolean}
 */
export function isFullyRemote(workplaceType, isRemoteFlag) {
    const normalized = normalizeWorkplaceType(workplaceType);

    if (normalized === 'Remote') return true;

    // Hybrid and Onsite are explicit statements — the flag does not override them.
    if (normalized !== 'Unspecified') return false;

    // No workplace type from the ATS: the boolean is the only signal we have.
    return isRemoteFlag === true;
}

// A location requirement is a restriction whatever country it names: "must be
// based in the UK" locks a candidate in Germany out exactly as "must be based in
// California" does. So rather than enumerate places — a list that can only ever
// be incomplete — the patterns below match the *phrase* and carve out the
// location-agnostic continuations that mean the opposite.
//
// These are the continuations that confirm openness rather than restrict it.
// "must be based in Europe" is an invitation; "must be based in Ireland" is not.
const LOCATION_AGNOSTIC = [
    'emea',
    'europe(?:an)?',
    'eu\\b',
    'anywhere',
    'any\\s+(?:location|country|city|state|region)',
    'any\\s+time\\s*zone',
    'a\\s+time\\s*zone',
    '(?:a\\s+)?(?:cet|cest|gmt|utc|central\\s+european)',
    'remote(?:ly)?',
    'a\\s+remote',
    'your\\s+(?:own\\s+)?home',
    'the\\s+(?:eu|emea|europe)',
].join('|');

// "must be (located|based) in …" where … is a real place. The optional "the"
// sits outside the lookahead so "must be based in the UK" is still caught —
// that leading article was what let country-level restrictions slip past.
const LOCATION_REQUIREMENT = new RegExp(
    `\\bmust\\s+be\\s+(?:located|based)\\s+in\\s+(?:the\\s+)?(?!(?:${LOCATION_AGNOSTIC}))[a-z]`,
);

/** "must reside in …", same carve-out. */
const RESIDENCE_REQUIREMENT = new RegExp(
    `\\bmust\\s+reside\\s+in\\s+(?:the\\s+)?(?!(?:${LOCATION_AGNOSTIC}))[a-z]`,
);

/** "this role requires you to be based in Toronto" */
const ROLE_REQUIRES_LOCATION = new RegExp(
    `\\brequires?\\s+you\\s+to\\s+be\\s+(?:located|based)\\s+in\\s+(?:the\\s+)?(?!(?:${LOCATION_AGNOSTIC}))[a-z]`,
);

/** "you must be authorized to work in <anywhere>" — work authorisation anywhere
 *  specific is a restriction; Germany is not that place. */
const WORK_AUTHORIZATION = /\bauthori[sz]ed?\s+to\s+work\s+in\s+(?:the\s+)?[a-z]/;

/** "open to US residents only", "UK residents only" */
const RESIDENTS_ONLY = /\b[a-z.]{2,}\s+residents?\s+only\b/;

/** "this position is open to candidates in Canada only" */
const OPEN_TO_COUNTRY_ONLY = /\bopen\s+to\s+(?:candidates?\s+(?:in|from)\s+)?(?:the\s+)?[a-z.\s]{2,30}?\s*only\b/;

/** "this role is US-based" / "this position is Ireland based" — but not
 *  "remote-based" or "home-based", which say the opposite. */
const ROLE_IS_X_BASED = /\bthis\s+(?:role|position|job)\s+is\s+(?!remote|home|globally|fully)[a-z.]{2,}[\s-]based\b/;

// Phrases that mean the role cannot legally or practically be done from Germany.
// A hit here discards the job outright.
export const HARD_DISCARD_PATTERNS = [
    LOCATION_REQUIREMENT,
    RESIDENCE_REQUIREMENT,
    ROLE_REQUIRES_LOCATION,
    WORK_AUTHORIZATION,
    RESIDENTS_ONLY,
    OPEN_TO_COUNTRY_ONLY,
    ROLE_IS_X_BASED,
    // Matches "Remote - US only", "Remote, US only" and "remote role, US only".
    // The gap is bounded and dot-free so the two halves must be one clause —
    // "…fully remote. Our US only office…" is not a match.
    /\bremote\b[^.]{0,20}?\bus\s*only\b/,
    /\bus[\s-]based\s+candidates?\s+only\b/,
    /\beligible\s+to\s+work\s+in\s+the\s+united\s+states\b/,
    /\bus\s+work\s+authorization\s+required\b/,
    /\bremote\s+within\s+(the\s+)?(us|usa|united\s+states)\b/,
];

// Phrases that mean "remote" in the job title but hybrid in practice — the role
// expects a body in a building on some cadence.
export const SOFT_DISCARD_PATTERNS = [
    /\b(1|2|3|one|two|three)\s*[\-–]?\s*days?\s*(per\s+week\s+)?(onsite|in[\s-]office|on[\s-]site)\b/,
    /\bhybrid\s+(schedule|arrangement|model)\b/,
    /\bcommutable\s+distance\b/,
    /\blocal\s+candidates?\s+preferred\b/,
    /\bvisit\s+(our\s+)?office\b/,
    /\bin[\s-]office\s+(days?|required|expected)\b/,
    /\bonsite\s+(required|expected|preferred)\b/,
];

/**
 * Scans a job description for location restrictions.
 * Hard patterns are checked first — they are the more serious disqualifier and
 * their type is what gets reported when a description trips both.
 *
 * @param {string|null|undefined} descriptionText
 * @returns {{restricted:boolean, type?:"hard"|"soft", pattern?:RegExp}}
 */
export function hasRestriction(descriptionText) {
    if (!descriptionText) return { restricted: false };

    const text = String(descriptionText).toLowerCase();

    for (const pattern of HARD_DISCARD_PATTERNS) {
        if (pattern.test(text)) return { restricted: true, type: 'hard', pattern };
    }

    for (const pattern of SOFT_DISCARD_PATTERNS) {
        if (pattern.test(text)) return { restricted: true, type: 'soft', pattern };
    }

    return { restricted: false };
}

// Phrases that actively confirm a role is open to Germany/Europe. These do not
// filter anything today — they are recorded so quality ranking can prefer jobs
// with explicit European intent over jobs that merely lack a red flag.
export const POSITIVE_REMOTE_SIGNALS = [
    /\b(emea|europe|eu|european)\s*(timezone|time\s*zone|based|remote)?\b/,
    /\bwork\s+from\s+anywhere\b/,
    /\bglobally?\s+remote\b/,
    /\bremote[\s-]first\b.*\bno\s+location\s+restrict/,
    /\b(cet|cest|central\s+european)\s*(time)?\b/,
];

/**
 * True when the description explicitly signals Europe/global remote friendliness.
 * Informational only — never used to reject a job.
 *
 * @param {string|null|undefined} descriptionText
 * @returns {boolean}
 */
export function hasPositiveSignal(descriptionText) {
    if (!descriptionText) return false;
    const text = String(descriptionText).toLowerCase();
    return POSITIVE_REMOTE_SIGNALS.some(pattern => pattern.test(text));
}
