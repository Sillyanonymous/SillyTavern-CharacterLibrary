/**
 * Gallery Extractor Registry
 *
 * Discovers external gallery page URLs in character card text and dispatches
 * to host-specific extractors that resolve them to direct image URLs.
 *
 * @typedef {Object} Extractor
 * @property {string} id - Unique extractor identifier
 * @property {string} name - Human-readable name for logs
 * @property {RegExp[]} patterns - URL patterns this extractor handles
 * @property {function(string, Object): Promise<ExtractorResult>} extractImages
 *
 * @typedef {Object} ExtractorResult
 * @property {Array<{url: string, filename: string}>} images - Resolved direct image URLs
 * @property {boolean} [aborted] - True if the operation was aborted
 * @property {string} [error] - Error message if the extraction failed entirely
 */

const extractors = [];

/**
 * Register a gallery extractor
 * @param {Extractor} extractor
 */
export function registerExtractor(extractor) {
    if (!extractor?.id || !extractor?.patterns?.length || typeof extractor.extractImages !== 'function') {
        console.warn('[ExtractorRegistry] Invalid extractor:', extractor?.id);
        return;
    }
    extractors.push(extractor);
}

/**
 * Find gallery page URLs in a block of text.
 * Returns deduplicated URLs that match any registered extractor.
 * @param {string} text
 * @returns {string[]}
 */
export function findGalleryUrls(text) {
    if (!text || extractors.length === 0) return [];

    const found = new Set();

    // Generic URL extraction: find all http(s) URLs in the text
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
    let m;
    while ((m = urlRegex.exec(text)) !== null) {
        const url = m[0].replace(/[.,;:!?)}\]]+$/, ''); // trim trailing punctuation
        for (const ext of extractors) {
            if (ext.patterns.some(p => p.test(url))) {
                found.add(url);
                break;
            }
        }
    }

    return [...found];
}

/**
 * Scan all text fields of a character for gallery page URLs.
 * Mirrors the field list used by findCharacterMediaUrls in library.js.
 * @param {Object} character - Character object (must be hydrated)
 * @returns {string[]}
 */
export function findCharacterGalleryUrls(character) {
    if (!character) return [];

    const data = character.data || character;
    const fields = [
        'description', 'personality', 'scenario', 'first_mes',
        'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'
    ];

    const allText = [];

    for (const field of fields) {
        const val = data[field];
        if (val && typeof val === 'string') allText.push(val);
    }

    // Provider taglines
    const extensions = data.extensions;
    if (extensions && typeof extensions === 'object') {
        for (const providerData of Object.values(extensions)) {
            const tagline = providerData?.tagline;
            if (tagline && typeof tagline === 'string') allText.push(tagline);
        }
    }

    // Alternate greetings
    const altGreetings = data.alternate_greetings;
    if (Array.isArray(altGreetings)) {
        for (const g of altGreetings) {
            if (g && typeof g === 'string') allText.push(g);
        }
    }

    // Lorebook entries
    const entries = data.character_book?.entries;
    if (entries) {
        const entryList = Array.isArray(entries) ? entries : Object.values(entries);
        for (const entry of entryList) {
            if (entry?.content && typeof entry.content === 'string') allText.push(entry.content);
        }
    }

    return findGalleryUrls(allText.join('\n'));
}

/**
 * Dispatch a gallery URL to the matching extractor and resolve direct image URLs.
 * @param {string} url - Gallery page URL
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<ExtractorResult>}
 */
const EXTRACT_TIMEOUT_MS = 15000;

export async function extractGalleryImages(url, opts = {}) {
    for (const ext of extractors) {
        if (ext.patterns.some(p => p.test(url))) {
            const timeout = ext.extractTimeout ?? EXTRACT_TIMEOUT_MS;
            const timeoutSignal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
            const combined = timeoutSignal
                ? (opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal)
                : (opts.signal || null);
            try {
                return await ext.extractImages(url, { ...opts, signal: combined });
            } catch (err) {
                if (err.name === 'TimeoutError') {
                    return { images: [], error: 'Extraction timed out' };
                }
                throw err;
            }
        }
    }
    return { images: [], error: 'No extractor matched this URL' };
}

/**
 * Check whether any registered extractor handles this URL
 * @param {string} url
 * @returns {boolean}
 */
export function isGalleryUrl(url) {
    return extractors.some(ext => ext.patterns.some(p => p.test(url)));
}

/**
 * Get all registered extractors (for debugging / settings UI)
 * @returns {Extractor[]}
 */
export function getRegisteredExtractors() {
    return [...extractors];
}

/**
 * Identify which extractor names match a set of URLs.
 * @param {string[]} urls
 * @returns {string[]} Deduplicated extractor names in match order
 */
export function identifyGallerySources(urls) {
    if (!urls?.length) return [];
    const seen = new Set();
    const names = [];
    for (const url of urls) {
        for (const ext of extractors) {
            if (!seen.has(ext.id) && ext.patterns.some(p => p.test(url))) {
                seen.add(ext.id);
                names.push(ext.name);
                break;
            }
        }
    }
    return names;
}
