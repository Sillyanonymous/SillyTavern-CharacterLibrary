/**
 * Imgbox Gallery Extractor
 *
 * Extracts images from imgbox.com gallery pages. The gallery page lists
 * thumbnail URLs of the form:
 *   https://thumbs{N}.imgbox.com/{xx}/{yy}/{ID}_b.{ext}
 * The corresponding full-resolution URL is:
 *   https://images{N}.imgbox.com/{xx}/{yy}/{ID}_o.{ext}
 *
 * Pattern: https://imgbox.com/g/{galleryId}
 */

import { registerExtractor } from './extractor-registry.js';

const IMGBOX_PATTERNS = [
    /imgbox\.com\/g\/[a-zA-Z0-9]+/
];

// Captures: 1=subdomain digits, 2=xx, 3=yy, 4=ID, 5=ext
const THUMB_REGEX = /https?:\/\/thumbs(\d+)\.imgbox\.com\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-zA-Z0-9]+)_b\.([a-zA-Z0-9]+)/g;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Imgbox gallery URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);
        const images = parseThumbs(html);

        if (images.length === 0) {
            return { images: [], error: 'No images found in gallery' };
        }

        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseThumbs(html) {
    const found = new Set();
    const images = [];
    THUMB_REGEX.lastIndex = 0;
    let m;
    while ((m = THUMB_REGEX.exec(html)) !== null) {
        const subN = m[1];
        const xx = m[2];
        const yy = m[3];
        const id = m[4];
        const ext = m[5];
        const fullUrl = `https://images${subN}.imgbox.com/${xx}/${yy}/${id}_o.${ext}`;
        if (!found.has(fullUrl)) {
            found.add(fullUrl);
            images.push({ url: fullUrl, filename: `${id}.${ext}` });
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
    id: 'imgbox',
    name: 'Imgbox',
    patterns: IMGBOX_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
