// Copied from job-Data/src/core/jobExtractor.js.

/**
 * Dedupes, trims and drops falsy entries from an array of location/tag strings.
 * Returns [] for any non-array input.
 */
export function normalizeArray(values) {
    return Array.isArray(values)
        ? [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))]
        : [];
}

// Also from jobExtractor.js. Most ATS platforms publish no seniority field, so
// the job document's ExperienceLevel / isEntryLevel are derived from the title —
// exactly as the German pipeline does, so both populations rank consistently.

export function deriveExperienceLevelFromTitle(title) {
    const lower = String(title || '').toLowerCase();
    if (/\b(staff|staff\+|distinguished)\b/i.test(lower)) return 'Staff';
    if (/\b(lead|principal|tech lead)\b/i.test(lower)) return 'Lead';
    if (/\b(senior|sr\.?|senior level)\b/i.test(lower)) return 'Senior';
    if (/\b(junior|jr\.?|entry|associate|graduate|intern|entry level|entry-level)\b/i.test(lower)) return 'Entry';
    if (/\b(mid|mid-level|intermediate|regular)\b/i.test(lower)) return 'Mid';
    return 'Mid';
}

export function deriveIsEntryLevelFromTitle(title) {
    const lower = String(title || '').toLowerCase();
    return /\b(junior|jr\.?|entry|associate|graduate|intern|entry level|entry-level)\b/i.test(lower);
}
