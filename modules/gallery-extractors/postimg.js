/**
 * Postimg Gallery Extractor
 *
 * Extracts images from postimg.cc gallery pages. Each gallery card embeds
 * data attributes: data-hotlink (CDN hash), data-name, data-ext. The full
 * CDN URL is also available in the data-pswp-src attribute on each link.
 *
 * Pattern: https://postimg.cc/gallery/{galleryId}
 * CDN URLs: https://i.postimg.cc/{hash}/{name}.{ext}
 */

import { registerExtractor } from './extractor-registry.js';

const POSTIMG_PATTERNS = [
    /postimg\.cc\/gallery\/[a-zA-Z0-9]+/
];

const CARD_DATA_REGEX = /data-hotlink="([^"]+)"\s+data-name="([^"]+)"\s+data-ext="([^"]+)"/g;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Postimg gallery URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);
        const images = parseCards(html);

        if (images.length === 0) {
            return { images: [], error: 'No images found in gallery' };
        }

        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseCards(html) {
    const found = new Set();
    const images = [];
    CARD_DATA_REGEX.lastIndex = 0;
    let m;
    while ((m = CARD_DATA_REGEX.exec(html)) !== null) {
        const hotlink = m[1];
        const name = m[2];
        const ext = m[3];
        const filename = `${name}.${ext}`;
        const fileUrl = `https://i.postimg.cc/${hotlink}/${filename}`;
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
    id: 'postimg',
    name: 'Postimg',
    patterns: POSTIMG_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
