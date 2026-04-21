/**
 * ImgBB / ibb.co Gallery Extractor
 *
 * Extracts images from ibb.co album pages via embedded JSON data.
 * Album pages embed `data-object='...'` attributes on each image element,
 * containing URL-encoded JSON with the full-size image URL.
 * Pagination uses POST to /json with seek-based cursors.
 *
 * Pattern: https://ibb.co/album/{albumId}
 * Full-size URLs: https://i.ibb.co/{id}/{filename}
 */

import { registerExtractor } from './extractor-registry.js';

const IMGBB_PATTERNS = [
    /ibb\.co\/album\/[a-zA-Z0-9]+/
];

const DATA_OBJECT_REGEX = /data-object='([^']+)'/g;
const SEEK_REGEX = /data-seek="([^"]+)"/;
const AUTH_TOKEN_REGEX = /PF\.obj\.config\.auth_token="([^"]+)"/;
const HAS_NEXT_REGEX = /class="pagination-next"/;

const REQUEST_DELAY_MS = 300;
const MAX_PAGES = 20;

/**
 * @param {string} url - ibb.co album URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);

        const images = parseDataObjects(html);

        const seekMatch = SEEK_REGEX.exec(html);
        const authMatch = AUTH_TOKEN_REGEX.exec(html);
        const hasNext = HAS_NEXT_REGEX.test(html);

        if (hasNext && seekMatch && authMatch) {
            const albumMatch = url.match(/ibb\.co\/album\/([a-zA-Z0-9]+)/);
            if (albumMatch) {
                const paginatedImages = await fetchPaginatedImages(
                    albumMatch[1], seekMatch[1], authMatch[1], signal
                );
                images.push(...paginatedImages);
            }
        }

        if (images.length === 0) {
            return { images: [], error: 'No images found in album' };
        }

        const seen = new Set();
        const unique = images.filter(img => {
            if (seen.has(img.url)) return false;
            seen.add(img.url);
            return true;
        });

        return { images: unique };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseDataObjects(html) {
    const images = [];
    DATA_OBJECT_REGEX.lastIndex = 0;
    let m;
    while ((m = DATA_OBJECT_REGEX.exec(html)) !== null) {
        try {
            const decoded = decodeURIComponent(m[1]
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&#039;/g, "'"));
            const obj = JSON.parse(decoded);
            const imgUrl = obj?.image?.url;
            if (imgUrl && typeof imgUrl === 'string') {
                images.push({
                    url: imgUrl,
                    filename: imgUrl.split('/').pop()
                });
            }
        } catch { /* malformed */ }
    }
    return images;
}

async function fetchPaginatedImages(albumId, initialSeek, authToken, signal) {
    const images = [];
    let seek = initialSeek;
    let page = 2;

    while (page <= MAX_PAGES) {
        if (signal?.aborted) break;
        await delay(REQUEST_DELAY_MS);

        try {
            const params = new URLSearchParams({
                action: 'list',
                page: String(page),
                seek,
                auth_token: authToken,
                pathname: `/album/${albumId}`,
            });

            const jsonUrl = `https://ibb.co/json`;
            let response;
            try {
                response = await fetch(jsonUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                    signal,
                });
            } catch (_) {
                const proxyUrl = `/proxy/${encodeURIComponent(jsonUrl)}`;
                response = await fetch(proxyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                    signal,
                });
            }

            if (!response.ok) break;
            const data = await response.json();

            if (!data.html) break;
            const pageImages = parseDataObjects(data.html);
            images.push(...pageImages);

            if (!data.seekEnd || data.seekEnd === seek) break;
            seek = data.seekEnd;
            page++;
        } catch (err) {
            if (err.name === 'AbortError') break;
            break;
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

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Register
registerExtractor({
    id: 'imgbb',
    name: 'ImgBB',
    patterns: IMGBB_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
