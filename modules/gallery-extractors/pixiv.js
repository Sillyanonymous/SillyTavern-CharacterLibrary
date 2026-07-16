/**
 * Pixiv Gallery Extractor
 *
 * Extracts artwork images from pixiv.net artwork URLs. Pixiv's image CDN
 * (i.pximg.net) is Referer-gated, and R-18 image URLs are returned only to a
 * logged-in session, so this extractor REQUIRES the cl-helper plugin: ajax
 * metadata is fetched through /pixiv-proxy (cookie + Referer injected) and each
 * image rides a per-image downloadFn that streams it through /pixiv-image (the
 * only path that can attach the Referer the CDN demands).
 *
 * Patterns:
 *   https://www.pixiv.net/en/artworks/{id}   (optional lang prefix, optional /{page})
 *   https://www.pixiv.net/artworks/{id}
 *   https://www.pixiv.net/member_illust.php?illust_id={id}   (legacy)
 *
 * Login: paste the account PHPSESSID in Settings > Media. R-18 works also need
 * the account's "View R-18 works" toggle ON, otherwise their image URLs come back
 * null and the artwork yields nothing.
 */

import { registerExtractor } from './extractor-registry.js';
import CoreAPI from '../core-api.js';

const PIXIV_PATTERNS = [
    /pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+/i,
    /pixiv\.net\/member_illust\.php\?(?:[^#]*&)?illust_id=\d+/i,
];

const ARTWORK_ID_RE = /\/(?:[a-z]{2}\/)?artworks\/(\d+)/i;
const LEGACY_ID_RE = /[?&]illust_id=(\d+)/i;

const CL_HELPER_BASE = '/plugins/cl-helper';
const REQUEST_DELAY_MS = 400;
const PAGE_LIMIT = 200; // Pixiv's own per-artwork max; a safety belt, never drops in practice.

const _apiRequest = (...args) => CoreAPI.apiRequest(...args);

let _pixivHelperOk = null;
let _pixivCheckedAt = 0;
const HELPER_CACHE_MS = 60000;

// Confirms cl-helper (with the pixiv routes) is reachable and primes the saved
// cookie into its RAM if needed. Returns false ONLY when the plugin/route is
// absent, so the caller can show a clear "install cl-helper" message instead of
// mistaking a Pixiv 404 for a missing plugin (eg. the R-18-no-login case).
async function ensurePixivHelper() {
    const now = Date.now();
    if (_pixivHelperOk !== null && now - _pixivCheckedAt < HELPER_CACHE_MS) {
        return _pixivHelperOk;
    }
    let ok = false;
    try {
        const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-session`);
        if (resp && resp.status !== 404 && resp.ok) {
            ok = true;
            const data = await resp.json().catch(() => null);
            if (!data?.active) {
                const savedCookie = CoreAPI.getSetting?.('pixivCookie');
                if (savedCookie && typeof savedCookie === 'string') {
                    try { await _apiRequest(`${CL_HELPER_BASE}/pixiv-set-cookie`, 'POST', { cookie: savedCookie }); } catch { /* ignore */ }
                }
            }
        }
    } catch { ok = false; }
    _pixivHelperOk = ok;
    _pixivCheckedAt = now;
    return ok;
}

export function invalidatePixivAuthCache() {
    _pixivHelperOk = null;
    _pixivCheckedAt = 0;
}
window.invalidatePixivAuthCache = invalidatePixivAuthCache;

function parseIllustId(url) {
    return url.match(ARTWORK_ID_RE)?.[1] || url.match(LEGACY_ID_RE)?.[1] || null;
}

// i.pximg.net is Referer-gated, so the bytes can only come through the cl-helper
// image proxy. Hand the pipeline a downloadFn that returns the same shape
// downloadMediaToMemory does ({ success, arrayBuffer, contentType }).
function makeDownloadFn(imgUrl) {
    return async (abortSignal) => {
        let path;
        try {
            const u = new URL(imgUrl);
            path = u.pathname + (u.search || '');
        } catch {
            return { success: false, error: 'Bad Pixiv image URL' };
        }
        try {
            const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-image${path}`, 'GET', null, { signal: abortSignal });
            if (!resp?.ok) return { success: false, error: `Pixiv image download failed (HTTP ${resp?.status ?? '?'})` };
            const arrayBuffer = await resp.arrayBuffer();
            const contentType = resp.headers.get('content-type') || 'image/png';
            return { success: true, arrayBuffer, contentType };
        } catch (err) {
            if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
            return { success: false, error: err?.message || 'Pixiv image download failed' };
        }
    };
}

// Fetch a pixiv ajax path through the cl-helper proxy. Throws on a non-ok
// response with `pixivStatus` attached so the caller can word the message; the
// cl-helper-missing case is handled separately by ensurePixivHelper().
async function fetchAjax(path, signal) {
    const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-proxy${path}`, 'GET', null, { signal });
    if (!resp) throw new Error('Could not reach the cl-helper plugin');
    if (!resp.ok) {
        const e = new Error(`Pixiv responded HTTP ${resp.status}`);
        e.pixivStatus = resp.status;
        throw e;
    }
    const data = await resp.json();
    if (data?.error) throw new Error(data?.message || 'Pixiv API error');
    return data?.body;
}

async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    const illustId = parseIllustId(url);
    if (!illustId) return { images: [], error: 'Unsupported Pixiv URL' };

    if (!(await ensurePixivHelper())) {
        return { images: [], error: 'Pixiv needs the cl-helper plugin. Install or update it in SillyTavern, then restart.' };
    }
    if (signal?.aborted) return { images: [], aborted: true };

    // Metadata is public for every artwork (even R-18), so this tells us page
    // count, type, and whether we actually have image access, before we touch
    // /pages (which 404s for an R-18 work when not logged in).
    let meta;
    try {
        meta = await fetchAjax(`/ajax/illust/${illustId}`, signal);
    } catch (err) {
        if (err?.name === 'AbortError') return { images: [], aborted: true };
        if (err?.pixivStatus === 404) return { images: [], error: 'Pixiv artwork not found (it may have been deleted or made private).' };
        return { images: [], error: `Could not load the Pixiv artwork: ${err?.message || 'unknown error'}` };
    }
    if (signal?.aborted) return { images: [], aborted: true };
    if (!meta) return { images: [], error: 'Pixiv returned no artwork data.' };

    if (meta.illustType === 2) {
        return { images: [], error: "Pixiv animations (ugoira) aren't supported." };
    }

    const isR18 = Number(meta.xRestrict) > 0;
    const firstUrl = meta.urls?.original || meta.urls?.regular || null;

    // No image URL on a public-metadata response means we lack access. For R-18
    // that is the login / account-toggle gate; surface it clearly here so we
    // never reach the /pages 404 that used to read as "cl-helper missing".
    if (!firstUrl) {
        return {
            images: [],
            error: isR18
                ? 'This R-18 Pixiv artwork needs a login. Add your Pixiv session in Settings > Media, and make sure "View R-18 works" is ON in your Pixiv account.'
                : 'Pixiv returned no image URLs for this artwork (it may be restricted).',
        };
    }

    const pageCount = Number(meta.pageCount) || 1;
    let pageUrls;
    if (pageCount > 1) {
        let pages = null;
        try {
            pages = await fetchAjax(`/ajax/illust/${illustId}/pages`, signal);
        } catch (err) {
            if (err?.name === 'AbortError') return { images: [], aborted: true };
            // We have access (firstUrl is set) but the page list failed; fall back
            // to the first image rather than failing the whole artwork.
            pages = null;
        }
        if (signal?.aborted) return { images: [], aborted: true };
        pageUrls = (Array.isArray(pages) ? pages : [])
            .map(p => p?.urls?.original || p?.urls?.regular)
            .filter(Boolean);
        if (pageUrls.length === 0) pageUrls = [firstUrl];
    } else {
        pageUrls = [firstUrl];
    }

    const images = pageUrls.slice(0, PAGE_LIMIT).map((imgUrl, i) => ({
        url: imgUrl,
        filename: filenameFor(illustId, imgUrl, i),
        downloadFn: makeDownloadFn(imgUrl),
    }));
    return { images };
}

function filenameFor(illustId, imgUrl, index) {
    let ext = 'png';
    try {
        const last = new URL(imgUrl).pathname.split('/').pop() || '';
        const m = last.match(/\.([a-z0-9]{2,5})$/i);
        if (m) ext = m[1].toLowerCase();
    } catch { /* keep default */ }
    return `pixiv_${illustId}_p${index}.${ext}`;
}

registerExtractor({
    id: 'pixiv',
    name: 'Pixiv',
    patterns: PIXIV_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS,
});
