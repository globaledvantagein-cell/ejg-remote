// Copied from job-Data/src/core/locationPrefilters.js — the subset this project
// needs. GERMAN_CITIES is kept because several ATS extractors (Personio in
// particular) infer country from a bare city name.

// List of German cities for location matching
export const GERMAN_CITIES = [
    'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln',
    'stuttgart', 'düsseldorf', 'dusseldorf', 'dortmund', 'essen', 'leipzig',
    'dresden', 'hanover', 'hannover', 'nuremberg', 'nürnberg', 'duisburg',
    'bochum', 'wuppertal', 'bielefeld', 'bonn', 'münster', 'munster',
    'karlsruhe', 'mannheim', 'augsburg', 'wiesbaden', 'mönchengladbach',
    'gelsenkirchen', 'braunschweig', 'chemnitz', 'kiel', 'aachen',
    'halle', 'magdeburg', 'freiburg', 'krefeld', 'lübeck', 'lubeck',
    'oberhausen', 'erfurt', 'mainz', 'rostock', 'kassel', 'hagen',
    'potsdam', 'saarbrücken', 'saarbrucken', 'hamm', 'ludwigshafen',
    'leverkusen', 'oldenburg', 'osnabrück', 'osnabruck', 'solingen',
    'heidelberg', 'darmstadt', 'regensburg', 'ingolstadt', 'würzburg',
    'wurzburg', 'wolfsburg', 'göttingen', 'gottingen', 'recklinghausen',
    'heilbronn', 'ulm', 'pforzheim', 'offenbach', 'bottrop', 'trier',
    'jena', 'cottbus', 'siegen', 'hildesheim', 'salzgitter', 'gütersloh',
    'gutersloh', 'iserlohn', 'schwerin', 'koblenz', 'zwickau', 'witten',
    'gera', 'hanau', 'esslingen', 'ludwigsburg', 'tubingen', 'tübingen',
    'flensburg', 'konstanz', 'worms', 'marburg', 'lüneburg', 'luneburg',
    'bayreuth', 'bamberg', 'plauen', 'neubrandenburg', 'wilhelmshaven',
    'dormagen', 'bomlitz', 'brunsbüttel', 'brunsbuttel',
    'meppen', 'emden', 'cuxhaven', 'celle', 'paderborn', 'reutlingen',
    'germany', 'deutschland', 'german'
];

/**
 * Returns true if the given text string refers to Germany.
 * Checks for 'germany', 'deutschland', '\bde\b', or any city in GERMAN_CITIES.
 */
export function isGermanyString(text) {
    if (!text) return false;
    const t = String(text).toLowerCase();
    if (t.includes('germany') || t.includes('deutschland')) return true;
    if (/\bde\b/.test(t)) return true;
    return GERMAN_CITIES.some(city => t.includes(city));
}

/** Normalises a workplace-type string → 'Remote' | 'Hybrid' | 'Onsite' | 'Unspecified' */
export function normalizeWorkplaceType(value) {
    if (!value) return 'Unspecified';
    const lower = String(value).toLowerCase();
    if (lower.includes('remote')) return 'Remote';
    if (lower.includes('hybrid')) return 'Hybrid';
    if (lower.includes('onsite') || lower.includes('on-site') || lower.includes('on_site') || lower.includes('office')) return 'Onsite';
    return 'Unspecified';
}

/** Normalises an employment-type string → 'FullTime' | 'PartTime' | 'Contract' | 'Intern' | 'Temporary' | null */
export function normalizeEmploymentType(value) {
    if (!value) return null;
    const lower = String(value).toLowerCase();
    if (lower.includes('full')) return 'FullTime';
    if (lower.includes('part')) return 'PartTime';
    if (lower.includes('intern')) return 'Intern';
    if (lower.includes('temp')) return 'Temporary';
    if (lower.includes('contract') || lower.includes('freelance')) return 'Contract';
    return null;
}

/**
 * Pulls a country out of a free-text location string.
 *
 * NEW in this project. The German pipeline never needed this — its extractCountry
 * functions only ever answered "DE or not". A remote scraper has to tell the US
 * from the UK from Canada, and most ATS platforms only give us a display string
 * like "Austin, TX, United States" or "London, UK".
 *
 * Returns the trailing comma-separated segment, which is the country on every
 * ATS location format we handle. Callers pass the result to
 * isWhitelistedCountry(), which understands both codes and full names, so no
 * ISO mapping is done here.
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function parseCountryFromLocation(text) {
    if (!text) return null;

    const cleaned = String(text)
        // "Remote - United States" / "Remote — Canada" → drop the prefix
        .replace(/^\s*(fully\s+)?remote\s*[-–—:]\s*/i, '')
        .trim();
    if (!cleaned) return null;

    const segments = cleaned.split(',').map(part => part.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    return segments[segments.length - 1];
}

/** Normalises a country string → 2-letter ISO code or the cleaned original */
export function normalizeCountry(value) {
    if (!value) return null;
    const cleaned = String(value).trim();
    const lower = cleaned.toLowerCase();
    if (lower === 'germany' || lower === 'deutschland') return 'DE';
    if (cleaned.length === 2) return cleaned.toUpperCase();
    return cleaned;
}
