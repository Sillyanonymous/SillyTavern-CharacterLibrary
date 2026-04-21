/**
 * Catbox Album Extractor
 *
 * Extracts images from catbox.moe album pages. Album pages list files
 * as plain-text links (>https://files.catbox.moe/{filename}<) in the HTML.
 *
 * Pattern: https://catbox.moe/c/{albumId}
 * File URLs: https://files.catbox.moe/{filename}
 */

import { registerExtractor } from './extractor-registry.js';

const CATBOX_PATTERNS = [
    /catbox\.moe\/c\/[a-zA-Z0-9]+/
];

const FILE_LINK_REGEX = />https:\/\/files\.catbox\.moe\/([^<]+)</g;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Catbox album URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);
        const images = parseFileLinks(html);

        if (images.length === 0) {
            return { images: [], error: 'No files found in album' };
        }

        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseFileLinks(html) {
    const found = new Set();
    const images = [];
    FILE_LINK_REGEX.lastIndex = 0;
    let m;
    while ((m = FILE_LINK_REGEX.exec(html)) !== null) {
        const filename = m[1].trim();
        const fileUrl = `https://files.catbox.moe/${filename}`;
        if (!found.has(fileUrl)) {
            found.add(fileUrl);
            images.push({ url: fileUrl, filename });
        }
    }
    return images;
}

async function fetchPage(url, signal) {
    let response;
    try {
        response = await fetch(url, { signal });
    } catch (_) {
        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
        response = await fetch(proxyUrl, { signal });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

registerExtractor({
    id: 'catbox',
    name: 'Catbox',
    patterns: CATBOX_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
