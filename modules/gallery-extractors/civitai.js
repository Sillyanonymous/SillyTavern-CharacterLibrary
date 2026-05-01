/**
 * Civitai Gallery Extractor
 *
 * Extracts images from Civitai post and image pages on both civitai.com and
 * its NSFW-inclusive mirror civitai.red. Results from both hosts are merged,
 * because the .red mirror may expose images hidden from the main site while
 * the main site may expose SFW content filtered out on .red.
 *
 * Patterns:
 *   https://civitai.com/posts/{id}
 *   https://civitai.com/images/{id}
 *   https://civitai.red/posts/{id}
 *   https://civitai.red/images/{id}
 *
 * Strategy:
 *   - /posts/{id}: call /api/v1/images?postId={id}&limit=200 on both hosts,
 *     merge by image id.
 *   - /images/{id}: the public API does not support lookup by image id.
 *     Fetch the HTML page on both hosts, regex-extract image.civitai.com
 *     CDN URLs, dedupe by image UUID and prefer the largest variant.
 *
 * Auth:
 *   When a Civitai API key is configured via cl-helper (POST /civitai-set-key),
 *   requests are routed through /plugins/cl-helper/civitai-proxy which attaches
 *   the Bearer token. Without a key, requests go direct to Civitai, falling
 *   back to ST's built-in /proxy/ on CORS failure. Public content works either
 *   way; private/hidden content needs the key.
 */

import { registerExtractor } from './extractor-registry.js';
import CoreAPI from '../core-api.js';

const CIVITAI_PATTERNS = [
    /civitai\.(?:com|red)\/posts\/\d+/i,
    /civitai\.(?:com|red)\/images\/\d+/i,
];

const POST_URL_RE = /^\/posts\/(\d+)/i;
const IMAGE_URL_RE = /^\/images\/(\d+)/i;
const CDN_URL_RE = /https:\/\/image\.civitai\.com\/[^\s"'<>)]+/gi;

const REQUEST_DELAY_MS = 300;
const PER_POST_LIMIT = 200;
const CL_HELPER_BASE = '/plugins/cl-helper';

const _apiRequest = (...args) => CoreAPI.apiRequest(...args);

let _civitaiAuthActive = null;
let _civitaiAuthCheckedAt = 0;
const AUTH_CACHE_MS = 60000;

async function isCivitaiAuthActive() {
    const now = Date.now();
    if (_civitaiAuthActive !== null && now - _civitaiAuthCheckedAt < AUTH_CACHE_MS) {
        return _civitaiAuthActive;
    }
    try {
        const resp = await _apiRequest(`${CL_HELPER_BASE}/civitai-session`);
        if (!resp?.ok) {
            _civitaiAuthActive = false;
        } else {
            const data = await resp.json();
            if (data?.active) {
                _civitaiAuthActive = true;
            } else {
                // cl-helper is up but has no key in memory. If the user has
                // a saved key (e.g. ST restarted), push it now.
                const savedKey = CoreAPI.getSetting?.('civitaiApiKey');
                if (savedKey && typeof savedKey === 'string') {
                    try {
                        const setResp = await _apiRequest(`${CL_HELPER_BASE}/civitai-set-key`, 'POST', { key: savedKey });
                        _civitaiAuthActive = !!setResp?.ok;
                    } catch {
                        _civitaiAuthActive = false;
                    }
                } else {
                    _civitaiAuthActive = false;
                }
            }
        }
    } catch {
        _civitaiAuthActive = false;
    }
    _civitaiAuthCheckedAt = now;
    return _civitaiAuthActive;
}

export function invalidateCivitaiAuthCache() {
    _civitaiAuthActive = null;
    _civitaiAuthCheckedAt = 0;
}

window.invalidateCivitaiAuthCache = invalidateCivitaiAuthCache;

/**
 * @param {string} url - Civitai post or image URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { images: [], error: 'Invalid Civitai URL' };
    }

    const postMatch = parsed.pathname.match(POST_URL_RE);
    const imageMatch = parsed.pathname.match(IMAGE_URL_RE);
    if (!postMatch && !imageMatch) {
        return { images: [], error: 'Unsupported Civitai URL' };
    }

    const authActive = await isCivitaiAuthActive();

    try {
        const results = postMatch
            ? await extractFromPost(postMatch[1], { signal, authActive })
            : await extractFromImage(imageMatch[1], { signal, authActive });

        if (signal?.aborted) return { images: [], aborted: true };
        if (results.length === 0) {
            return { images: [], error: 'No images found' };
        }
        return { images: results };
    } catch (err) {
        if (err?.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err?.message || 'Civitai extraction failed' };
    }
}

async function extractFromPost(postId, { signal, authActive }) {
    const hosts = ['civitai.com', 'civitai.red'];
    const path = `/api/v1/images?postId=${encodeURIComponent(postId)}&limit=${PER_POST_LIMIT}&nsfw=X`;

    const perHost = await Promise.all(hosts.map(host =>
        fetchJson(host, path, { signal, authActive }).catch(() => null)
    ));

    const byId = new Map();
    for (const data of perHost) {
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
            if (!item?.url || typeof item.url !== 'string') continue;
            const id = item.id ?? item.url;
            if (byId.has(id)) continue;
            byId.set(id, {
                url: item.url,
                filename: filenameFromCdnUrl(item.url, id),
            });
        }
    }
    return [...byId.values()];
}

async function extractFromImage(imageId, { signal, authActive }) {
    const hosts = ['civitai.com', 'civitai.red'];
    const path = `/images/${encodeURIComponent(imageId)}`;

    const htmls = await Promise.all(hosts.map(host =>
        fetchHtml(host, path, { signal, authActive }).catch(() => null)
    ));

    const byUuid = new Map();
    for (const html of htmls) {
        if (!html) continue;
        CDN_URL_RE.lastIndex = 0;
        let m;
        while ((m = CDN_URL_RE.exec(html)) !== null) {
            const clean = m[0].replace(/[.,;:!?)}\]]+$/, '');
            const uuid = extractCdnUuid(clean);
            if (!uuid) continue;
            const existing = byUuid.get(uuid);
            if (!existing || preferLarger(clean, existing.url)) {
                byUuid.set(uuid, {
                    url: clean,
                    filename: filenameFromCdnUrl(clean, uuid),
                });
            }
        }
    }
    return [...byUuid.values()];
}

function extractCdnUuid(cdnUrl) {
    // https://image.civitai.com/{identityPrefix}/{uuid}/width=.../filename.jpeg
    const m = cdnUrl.match(/image\.civitai\.com\/[^/]+\/([a-f0-9-]{8,})\//i);
    return m ? m[1] : null;
}

function preferLarger(candidate, current) {
    // "original=true" beats anything else, then higher "width=N" wins.
    const candOrig = /original=true/i.test(candidate);
    const currOrig = /original=true/i.test(current);
    if (candOrig !== currOrig) return candOrig;
    const candWidth = parseInt(candidate.match(/width=(\d+)/i)?.[1] || '0', 10);
    const currWidth = parseInt(current.match(/width=(\d+)/i)?.[1] || '0', 10);
    return candWidth > currWidth;
}

function filenameFromCdnUrl(cdnUrl, fallbackKey) {
    try {
        const u = new URL(cdnUrl);
        const last = u.pathname.split('/').filter(Boolean).pop();
        if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
    } catch {}
    return `civitai_${fallbackKey}.jpeg`;
}

async function fetchJson(host, path, { signal, authActive }) {
    const resp = await fetchRaw(host, path, { signal, authActive, accept: 'application/json' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

async function fetchHtml(host, path, { signal, authActive }) {
    const resp = await fetchRaw(host, path, { signal, authActive, accept: 'text/html' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

async function fetchRaw(host, path, { signal, authActive, accept }) {
    if (authActive) {
        const proxyPath = `${CL_HELPER_BASE}/civitai-proxy/${host}${path.startsWith('/') ? path : '/' + path}`;
        const resp = await _apiRequest(proxyPath, 'GET', null, { signal });
        if (resp) return resp;
    }

    const target = `https://${host}${path}`;
    try {
        return await fetch(target, { signal, headers: { Accept: accept } });
    } catch (_) {
        const fallback = `/proxy/${encodeURIComponent(target)}`;
        return fetch(fallback, { signal, headers: { Accept: accept } });
    }
}

registerExtractor({
    id: 'civitai',
    name: 'Civitai',
    patterns: CIVITAI_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS,
});
