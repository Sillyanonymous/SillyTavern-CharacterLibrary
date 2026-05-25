/**
 * Dropbox Gallery Extractor
 *
 * Dropbox's SPA embeds folder contents (file URLs + names) as a base64-
 * encoded protobuf blob inside the initial page HTML; no separate listing
 * XHR is made. We grep image URLs out of the decoded bytes and flip
 * dl=0 -> dl=1 to get a direct file response instead of the preview page.
 *
 * Patterns:
 *   Folder share: https://www.dropbox.com/scl/fo/{id}/{rkey}?rlkey=...
 *   File share:   https://www.dropbox.com/scl/fi/{id}/{filename}?rlkey=...
 */

import { registerExtractor } from './extractor-registry.js';

const DROPBOX_PATTERNS = [
    /dropbox\.com\/scl\/(?:fo|fi)\/[A-Za-z0-9_-]+\//
];

const IMAGE_EXT = '(?:png|jpe?g|gif|webp|heic|jfif)';
const SCL_FILE_URL_RE = new RegExp(
    `https://www\\.dropbox\\.com/scl/(?:fo|fi)/[A-Za-z0-9_\\-/%~.]+?\\.${IMAGE_EXT}\\?[A-Za-z0-9=&_-]+`,
    'gi'
);
const B64_BLOB_RE = /"([A-Za-z0-9+/]{5000,}={0,2})"/g;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Dropbox folder or single-file share URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    // Decode &amp; (card-HTML residue) and drop st= (viewer-session token tied to the original requester); rlkey alone authorizes.
    const cleanUrl = url
        .replace(/&amp;/g, '&')
        .replace(/([?&])st=[^&]*(&|$)/, (_, lead, tail) => tail ? lead : '');

    try {
        if (/\/scl\/fi\//.test(cleanUrl)) {
            return { images: [toDownloadEntry(cleanUrl)] };
        }

        const html = await fetchPage(cleanUrl, signal);
        const images = parseFolderBlob(html);
        if (images.length === 0) {
            return { images: [], error: 'No image files found in folder' };
        }
        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseFolderBlob(html) {
    const seen = new Set();
    const images = [];
    B64_BLOB_RE.lastIndex = 0;
    let m;
    while ((m = B64_BLOB_RE.exec(html)) !== null) {
        let decoded;
        try { decoded = atob(m[1]); } catch { continue; }
        SCL_FILE_URL_RE.lastIndex = 0;
        let f;
        while ((f = SCL_FILE_URL_RE.exec(decoded)) !== null) {
            const entry = toDownloadEntry(f[0]);
            if (!seen.has(entry.url)) {
                seen.add(entry.url);
                images.push(entry);
            }
        }
        if (images.length > 0) break;
    }
    return images;
}

function toDownloadEntry(rawUrl) {
    let url = rawUrl.replace(/([?&])dl=0(?=$|&)/, '$1dl=1');
    if (!/[?&]dl=1(?=$|&)/.test(url)) {
        url += url.includes('?') ? '&dl=1' : '?dl=1';
    }
    const pathPart = url.split('?')[0];
    const filename = decodeURIComponent(pathPart.split('/').pop() || 'image');
    return { url, filename };
}

// cl-helper is the only working path: direct fetch is CORS-blocked, ST's /proxy/ 400s on Dropbox's UA defaults.
async function fetchPage(url, signal) {
    const helperUrl = toHelperProxyUrl(url);
    if (!helperUrl) throw new Error('Invalid Dropbox URL');
    let response;
    try {
        response = await fetch(helperUrl, { signal });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(`cl-helper unreachable: ${err.message}`);
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} via cl-helper (restart ST if /dropbox-proxy is missing)`);
    }
    return response.text();
}

function toHelperProxyUrl(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== 'www.dropbox.com') return null;
        return `/api/plugins/cl-helper/dropbox-proxy${u.pathname}${u.search}`;
    } catch { return null; }
}

registerExtractor({
    id: 'dropbox',
    name: 'Dropbox',
    patterns: DROPBOX_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
