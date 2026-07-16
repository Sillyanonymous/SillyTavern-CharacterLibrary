/**
 * ImgBB / ibb.co Gallery Extractor
 *
 * Albums: pages embed `data-object='...'` attributes per image (URL-encoded
 * JSON with the full-size URL); pagination POSTs to same-origin /json with
 * seek-based cursors. Single image pages: og:image carries the full-size
 * i.ibb.co URL.
 *
 * Patterns: https://ibb.co/album/{albumId}, https://ibb.co/{slug}
 * (ibb.co.com serves identical markup). Full-size URLs: https://i.ibb.co/{id}/{filename}
 */

import { registerExtractor } from './extractor-registry.js';
import { proxyEncode } from '../providers/provider-utils.js';

// Host-anchored on // so direct i.ibb.co file URLs never match.
const IMGBB_PATTERNS = [
    /\/\/(?:www\.)?ibb\.co(?:\.com)?\/album\/[a-zA-Z0-9]+/,
    /\/\/(?:www\.)?ibb\.co(?:\.com)?\/(?!album\b|json\b|login\b|upload\b)[a-zA-Z0-9]{6,16}\/?$/,
];

const DATA_OBJECT_REGEX = /data-object='([^']+)'/g;
const SEEK_REGEX = /data-seek="([^"]+)"/;
const AUTH_TOKEN_REGEX = /PF\.obj\.config\.auth_token="([^"]+)"/;
const HAS_NEXT_REGEX = /class="pagination-next"/;

const REQUEST_DELAY_MS = 300;
const MAX_PAGES = 20;

/**
 * @param {string} url - ibb.co album or single-image page URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const albumMatch = url.match(/ibb\.co(?:\.com)?\/album\/([a-zA-Z0-9]+)/);
        return albumMatch
            ? await extractAlbum(url, albumMatch[1], signal)
            : await extractSinglePage(url, signal);
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

async function extractAlbum(url, albumId, signal) {
    const html = await fetchPage(url, signal);

    const images = parseDataObjects(html);

    const seekMatch = SEEK_REGEX.exec(html);
    const authMatch = AUTH_TOKEN_REGEX.exec(html);
    const hasNext = HAS_NEXT_REGEX.test(html);

    if (hasNext && seekMatch && authMatch) {
        const paginatedImages = await fetchPaginatedImages(
            new URL(url).origin, albumId, seekMatch[1], authMatch[1], signal
        );
        images.push(...paginatedImages);
    }

    if (images.length === 0) {
        // Flagged albums list nothing to guests (SSR and /json both come back empty).
        return { images: [], error: 'No images found in album (empty or hidden from anonymous viewers)' };
    }

    const seen = new Set();
    const unique = images.filter(img => {
        if (seen.has(img.url)) return false;
        seen.add(img.url);
        return true;
    });

    return { images: unique };
}

async function extractSinglePage(url, signal) {
    const html = await fetchPage(url, signal);

    // og:image is the full-size original (the inline viewer img is a display-size variant with a different id).
    const m = /<meta property="og:image" content="([^"]+)"/.exec(html)
        || /<link rel="image_src" href="([^"]+)"/.exec(html);
    const direct = m?.[1];
    if (!direct || !/\/\/i\.ibb\.co\//.test(direct)) {
        return { images: [], error: 'No direct image found on page' };
    }
    return { images: [{ url: direct, filename: direct.split('/').pop() }] };
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

async function fetchPaginatedImages(origin, albumId, initialSeek, authToken, signal) {
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

            // Same-origin as the album page; auth_token + seek come from that page's session.
            const jsonUrl = `${origin}/json`;
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
                const proxyUrl = `/proxy/${proxyEncode(jsonUrl)}`;
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
        const proxyUrl = `/proxy/${proxyEncode(url)}`;
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
