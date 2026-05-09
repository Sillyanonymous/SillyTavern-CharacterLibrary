// Shared CharacterTavern API utilities - used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for the
// character-tavern.com API.

// ========================================
// CONSTANTS
// ========================================

import { CL_HELPER_PLUGIN_BASE as CL_HELPER_CT_BASE } from '../provider-utils.js';
export { CL_HELPER_CT_BASE };

let _getSetting = null;

/**
 * Must be called once before any other export is used.
 * @param {{ getSetting: Function }} deps
 */
export function initChartavernApi(deps) {
    _getSetting = deps.getSetting;
}

// Default upstream hosts. CharacterTavern has three: the REST API, the
// public site (favicons, og:images), and the cards CDN.
const CT_DEFAULT_API   = 'https://character-tavern.com/api';
const CT_DEFAULT_SITE  = 'https://character-tavern.com';
const CT_DEFAULT_CDN   = 'https://cards.character-tavern.com';

// When proxying through a self-hosted gateway, the convention below
// mirrors the gateway used by this extension upstream. A reverse proxy
// that exposes these paths gets the simple single-field setup; per-host
// overrides remain available for non-standard topologies.
const CT_GATEWAY_PATHS = {
    api:  '/v1/ct',
    site: '/v1/ct-site',
    cdn:  '/v1/ct-cdn',
};

function _trimSlash(s) {
    return s.replace(/\/+$/, '');
}

function _resolveCtBase(overrideKey, defaultBase, gatewayPath) {
    const override = _trimSlash((_getSetting?.(overrideKey) || '').trim());
    if (override) return override;
    const base = _trimSlash((_getSetting?.('chartavernGatewayBaseUrl') || '').trim());
    if (base) return base + gatewayPath;
    return defaultBase;
}

export function getCtApiBase() {
    return _resolveCtBase('chartavernGatewayApiUrl', CT_DEFAULT_API, CT_GATEWAY_PATHS.api);
}

export function getCtSiteBase() {
    return _resolveCtBase('chartavernGatewaySiteUrl', CT_DEFAULT_SITE, CT_GATEWAY_PATHS.site);
}

export function getCtCardsCdn() {
    return _resolveCtBase('chartavernGatewayCdnUrl', CT_DEFAULT_CDN, CT_GATEWAY_PATHS.cdn);
}

export function getCtGatewayKey() {
    return _getSetting?.('chartavernGatewayKey') || '';
}

// Sort options accepted by /api/search/cards
export const CT_SORT_OPTIONS = {
    most_popular: 'Most Popular',
    trending: 'Trending',
    newest: 'Newest',
    oldest: 'Oldest',
    most_likes: 'Most Liked'
};

// ========================================
// NETWORK (shared)
// ========================================

import { fetchWithProxy } from '../provider-utils.js';
export { fetchWithProxy };

/**
 * Build outgoing headers for a CharacterTavern request. When the user
 * configures a gateway URL + key, the key is sent as Authorization so
 * the gateway can authenticate the call. Direct (default) requests to
 * character-tavern.com need no auth header.
 * @returns {Object}
 */
export function getCtHeaders() {
    const headers = { 'Accept': 'application/json' };
    const gwKey = _getSetting?.('chartavernGatewayKey');
    if (gwKey) headers['Authorization'] = `Bearer ${gwKey}`;
    return headers;
}

// ========================================
// AUTH - cl-helper cookie session
// ========================================

let ctSessionActive = false;

/**
 * Check if the cl-helper plugin is reachable.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtPluginAvailable(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Check if a CT session is active in cl-helper.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return false;
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return ctSessionActive;
    } catch {
        ctSessionActive = false;
        return false;
    }
}

/**
 * Store cookies in cl-helper for proxied CT requests.
 * @param {Function} apiRequest
 * @param {string} cookieString - Raw cookie header value (e.g. "session=abc123")
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function ctSetCookie(apiRequest, cookieString) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-set-cookie`, 'POST', {
            cookie: cookieString,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
        const data = await resp.json();
        if (data?.ok) {
            ctSessionActive = true;
            return { ok: true };
        }
        return { ok: false, error: data?.error || 'Failed to store cookies' };
    } catch (err) {
        return { ok: false, error: err.message || 'Network error' };
    }
}

/**
 * Validate stored CT cookies by making a test request through cl-helper.
 * Clears session state if cookies are expired/invalid.
 * @param {Function} apiRequest
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function ctValidateSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-validate`);
        if (!resp.ok) return { valid: false, reason: 'validation request failed' };
        const data = await resp.json();
        if (!data?.valid) {
            ctSessionActive = false;
        }
        return data;
    } catch {
        ctSessionActive = false;
        return { valid: false, reason: 'network error' };
    }
}

/**
 * Log out from CharacterTavern via cl-helper.
 * @param {Function} apiRequest
 */
export async function ctLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_CT_BASE}/ct-logout`, 'POST');
    } catch { /* ignore */ }
    ctSessionActive = false;
}

/** @returns {boolean} */
export function isCtSessionActive() {
    return ctSessionActive;
}

/**
 * Fetch a CT API URL, routing through cl-helper proxy when authenticated.
 * @param {string} url - Full CT API URL (e.g. https://character-tavern.com/api/search/cards?...)
 * @param {Function} [apiRequest] - CoreAPI.apiRequest (required for proxied requests)
 * @returns {Promise<Response>}
 */
async function ctFetch(url, apiRequest) {
    if (ctSessionActive && apiRequest) {
        // Route through cl-helper proxy: strip the CT origin, prepend proxy path
        const path = url.replace(getCtSiteBase(), '');
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-proxy${path}`);
        return resp;
    }
    return fetchWithProxy(url, { headers: getCtHeaders() });
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search characters via /api/search/cards
 * @param {Object} opts
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number}>}
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        query = '',
        sort = 'most_popular',
        page = 1,
        limit = 30,
        tags = '',
        excludeTags = '',
        minimumTokens,
        maximumTokens,
        hasLorebook,
        isOC,
        nsfw = true
    } = opts;

    const params = new URLSearchParams();
    params.set('query', query);
    params.set('sort', sort);
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (tags) params.set('tags', tags);
    if (excludeTags) params.set('exclude_tags', excludeTags);
    if (minimumTokens != null) params.set('minimum_tokens', String(minimumTokens));
    if (maximumTokens != null) params.set('maximum_tokens', String(maximumTokens));
    if (hasLorebook != null) params.set('hasLorebook', String(hasLorebook));
    if (isOC != null) params.set('isOC', String(isOC));

    // CT API has no explicit NSFW toggle - exclude_tags is used instead
    if (!nsfw) {
        const existing = excludeTags ? excludeTags.split(',').map(t => t.trim()) : [];
        if (!existing.includes('nsfw')) existing.push('nsfw');
        params.set('exclude_tags', existing.join(','));
    }

    const url = `${getCtApiBase()}/search/cards?${params}`;
    const resp = await ctFetch(url, apiRequest);
    if (!resp.ok) {
        throw new Error(`CT search returned HTTP ${resp.status}`);
    }
    return resp.json();
}

/**
 * Fetch full character details via /api/character/{author}/{slug}
 * @param {string} author
 * @param {string} slug
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<Object>} { card: {...}, ownerCTId: ... }
 */
export async function fetchCharacterDetail(author, slug, apiRequest) {
    const url = `${getCtApiBase()}/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
    const resp = await ctFetch(url, apiRequest);
    if (!resp.ok) {
        throw new Error(`CT detail returned HTTP ${resp.status}`);
    }
    return resp.json();
}

/**
 * Fetch top tags from /api/catalog/top-tags
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags() {
    const url = `${getCtApiBase()}/catalog/top-tags`;
    const resp = await fetchWithProxy(url, { headers: getCtHeaders() });
    if (!resp.ok) throw new Error(`Top tags fetch failed (${resp.status})`);
    return resp.json();
}

// ========================================
// URL / PATH HELPERS
// ========================================

/**
 * Build avatar thumbnail URL via Cloudflare image resizing.
 * @param {string} path - "author/slug" format
 * @param {number} [width=320]
 * @returns {string}
 */
export function getAvatarUrl(path, width = 320) {
    return `${getCtCardsCdn()}/cdn-cgi/image/format=auto,width=${width},quality=85/${path}.png`;
}

/**
 * Build full-size card PNG URL (for download / import).
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCardPngUrl(path) {
    return `${getCtCardsCdn()}/${path}.png`;
}

/**
 * Build the web page URL for a character.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCharacterPageUrl(path) {
    return `${getCtSiteBase()}/character/${path}`;
}

/**
 * Parse a character-tavern.com URL into author/slug path.
 * Accepts: https://character-tavern.com/character/author/slug
 * @param {string} url
 * @returns {string|null} "author/slug" or null
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?character-tavern\.com$/i.test(u.hostname)) return null;
        const match = u.pathname.match(/^\/character\/([^/]+)\/([^/]+)/);
        if (match) return `${match[1]}/${match[2]}`;
    } catch { /* ignore */ }
    return null;
}

// ========================================
// TEXT UTILITIES (shared + local)
// ========================================

export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

/**
 * Normalize tags into an array of strings.
 * CT API returns tags as an array; handles legacy space-separated strings too.
 */
export function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.filter(Boolean);
    if (typeof tags === 'string') return tags.split(/\s+/).filter(Boolean);
    return [];
}
