// Shared Botbooru API utilities - used by botbooru-provider.js and botbooru-browse.js
//
// Contains constants, auth headers, posts/detail/tags fetch, the card
// download helpers, and the post cache. Initialized once via
// initBotbooruApi() which receives getSetting + debugLog from CoreAPI.
//
// Botbooru sends no CORS headers, so every request rides fetchWithProxy
// (the first direct attempt rejects, the origin is cached, ST's /proxy/
// carries everything after; Authorization survives the proxy).

import { fetchWithProxy as _rawFetchWithProxy, CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

export const BOTBOORU_BASE = 'https://botbooru.com';

// ========================================
// INITIALIZATION
// ========================================

let _getSetting = null;
let _debugLog = null;
let _apiRequest = null;     // CoreAPI.apiRequest, for the cl-helper basic-auth reroute
let _getCSRFToken = null;   // CoreAPI.getCSRFToken, ditto

/**
 * Must be called once before any other export is used.
 * Typically called from BotbooruProvider.init(coreAPI).
 * @param {{ getSetting: Function, debugLog: Function, apiRequest?: Function, getCSRFToken?: Function }} deps
 */
export function initBotbooruApi(deps) {
    _getSetting = deps.getSetting;
    _debugLog = deps.debugLog;
    _apiRequest = deps.apiRequest || null;
    _getCSRFToken = deps.getCSRFToken || null;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

// ========================================
// NETWORK
// ========================================

/**
 * Build Botbooru API headers with optional Bearer token.
 * @param {boolean} includeAuth
 * @returns {Object}
 */
export function getBotbooruHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const token = _getSetting?.('botbooruToken');
    if (includeAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

const BOTBOORU_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/botbooru-proxy`;

let _clHelper = null;       // { available, basicAuth } once definitively probed
let _clHelperProbe = null;  // in-flight dedupe

async function probeClHelper() {
    if (_clHelper) return _clHelper;
    if (_clHelperProbe) return _clHelperProbe;
    if (!_apiRequest) return { available: false, basicAuth: false };
    _clHelperProbe = (async () => {
        try {
            const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
            const data = resp.ok ? await resp.json().catch(() => ({})) : {};
            _clHelper = { available: !!data.ok, basicAuth: !!data.basicAuth };
            return _clHelper;
        } catch {
            return { available: false, basicAuth: false }; // transient: dont cache, retry next call
        } finally {
            _clHelperProbe = null;
        }
    })();
    return _clHelperProbe;
}

/** fetchWithProxy, signature-compatible, reroutes authed requests via cl-helper under basic auth. @param {string} url @param {Object} [opts] @returns {Promise<Response>} */
export async function fetchWithProxy(url, opts = {}) {
    const auth = opts.headers?.Authorization;
    if (auth && _apiRequest && url.startsWith(BOTBOORU_BASE)) {
        const { available, basicAuth } = await probeClHelper();
        if (available && basicAuth) {
            const path = url.slice(BOTBOORU_BASE.length) || '/';
            const headers = {
                'X-CSRF-Token': _getCSRFToken?.() || '',
                'X-CL-Botbooru-Auth': auth,
            };
            if (opts.body != null) headers['Content-Type'] = 'application/json';
            const r = await _apiRequest(`${BOTBOORU_PROXY_BASE}${path}`, opts.method || 'GET', null, { headers, body: opts.body });
            if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`HTTP ${r.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
            }
            return r;
        }
    }
    return _rawFetchWithProxy(url, opts);
}

// ========================================
// URL HELPERS
// ========================================

/**
 * Grid/preview thumbnail (size-bucketed endpoint, serves webp). The ?v=
 * revision matches the site's own requests; without it CL hits a different
 * CDN cache key, which can pin a cached miss for lazily-generated previews.
 */
export function getBotbooruPreviewUrl(filename, rev = 1) {
    return `${BOTBOORU_BASE}/images/preview/480/${filename}?v=${rev || 1}`;
}

/** Card download URL; kind is 'png' or 'json'. */
export function getBotbooruDownloadUrl(id, kind = 'png') {
    return `${BOTBOORU_BASE}/download/${kind}/${id}`;
}

// ========================================
// POSTS (BROWSE / SEARCH)
// ========================================

/**
 * Search/browse posts.
 * Sorts: latest, random, favorites, views, downloads, curated.
 * q is space-joined tag names. sfw_only is only sent when true; NSFW
 * results additionally require a token whose account has show_nsfw on.
 * @param {{ sort?: string, q?: string, sfwOnly?: boolean, minTokens?: number,
 *           timeWindow?: string, curatedSort?: string, limit?: number, offset?: number }} params
 * @returns {Promise<{total: number, posts: Array}|null>}
 */
export async function fetchBotbooruPosts(params = {}) {
    const qs = new URLSearchParams();
    if (params.sort) qs.set('sort', params.sort);
    if (params.q) qs.set('q', params.q);
    if (params.sfwOnly) qs.set('sfw_only', 'true');
    if (params.minTokens) qs.set('min_tokens', String(params.minTokens));
    if (params.timeWindow) qs.set('time_window', params.timeWindow);
    if (params.curatedSort) qs.set('curated_sort', params.curatedSort);
    if (params.curatedIncludeUpdated === false) qs.set('curated_include_updated', 'false');
    if (params.hideAi) qs.set('hide_ai', 'true');
    if (params.includeLorebookTokens) qs.set('include_lorebook_tokens', 'true');
    if (params.uploadedAfter) qs.set('uploaded_after', params.uploadedAfter);
    if (params.uploadedBefore) qs.set('uploaded_before', params.uploadedBefore);
    qs.set('limit', String(params.limit ?? 40));
    qs.set('offset', String(params.offset ?? 0));
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/posts/?${qs}`, { headers: getBotbooruHeaders(true) });
        return await resp.json();
    } catch (e) {
        debugLog('[Botbooru] posts fetch failed:', e.message);
        return null;
    }
}

// ========================================
// POST DETAIL (with LRU cache)
// ========================================

export const botbooruPostCache = new Map();
const POST_CACHE_MAX = 3;
const POST_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch a single post's full detail (all card fields inline).
 * @param {number|string} id
 * @returns {Promise<Object|null>}
 */
export async function fetchBotbooruPost(id) {
    const cached = botbooruPostCache.get(id);
    if (cached && Date.now() - cached.time < POST_CACHE_TTL) {
        debugLog('[Botbooru] Using cached post', id);
        return cached.value;
    }
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/post/${id}`, { headers: getBotbooruHeaders(true) });
        const post = await resp.json();
        if (!post?.id) return null;
        while (botbooruPostCache.size >= POST_CACHE_MAX) {
            botbooruPostCache.delete(botbooruPostCache.keys().next().value);
        }
        botbooruPostCache.set(id, { value: post, time: Date.now() });
        return post;
    } catch (e) {
        debugLog('[Botbooru] post fetch failed:', id, e.message);
        return null;
    }
}

// ========================================
// CARD FETCH
// ========================================

/**
 * Fetch the card for a post. /download/json returns a ready chara_card_v2
 * envelope, so this validates rather than rebuilds.
 * @param {number|string} id
 * @returns {Promise<Object|null>} { spec, spec_version, data } or null
 */
export async function fetchBotbooruCard(id) {
    try {
        const resp = await fetchWithProxy(getBotbooruDownloadUrl(id, 'json'), { headers: getBotbooruHeaders(true) });
        const card = await resp.json();
        if (!card?.data?.name) return null;
        return card;
    } catch (e) {
        debugLog('[Botbooru] card json fetch failed:', id, e.message);
        return null;
    }
}

// ========================================
// TAGS
// ========================================

let _tagsCache = null;
let _tagsPromise = null;

/**
 * Full tag list: [{ id?, name, category, count, count_nsfw, count_nsfl, alias_of? }].
 * Heavy (~1.6MB), so it is fetched lazily once per session; concurrent
 * callers share the in-flight promise so it doesnt fire twice.
 * @returns {Promise<Array|null>}
 */
export async function fetchBotbooruTags() {
    if (_tagsCache) return _tagsCache;
    if (_tagsPromise) return _tagsPromise;
    _tagsPromise = (async () => {
        try {
            const resp = await fetchWithProxy(`${BOTBOORU_BASE}/tags/`, { headers: getBotbooruHeaders(false) });
            const tags = await resp.json();
            _tagsCache = Array.isArray(tags) ? tags : null;
            return _tagsCache;
        } catch (e) {
            debugLog('[Botbooru] tags fetch failed:', e.message);
            return null;
        } finally {
            _tagsPromise = null;
        }
    })();
    return _tagsPromise;
}

/**
 * Related tags for the current query (lightweight, per-search).
 * @param {string} q - space-joined tag names
 * @returns {Promise<Array|null>}
 */
export async function fetchBotbooruRelatedTags(q) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/tags/related/?q=${encodeURIComponent(q)}`, { headers: getBotbooruHeaders(false) });
        return await resp.json();
    } catch (e) {
        debugLog('[Botbooru] related tags fetch failed:', e.message);
        return null;
    }
}

/**
 * The Writer-category tag is the card's creator credit; the uploader is just
 * who posted it (often a reuploader). Returns the first Writer tag name.
 * @param {Object} post - posts[] item or /post/{id} detail
 * @returns {string|null}
 */
export function getBotbooruWriterTag(post) {
    return (post?.tags || []).find(t => t?.category === 'Writer')?.name || null;
}

// ========================================
// USERS
// ========================================

/**
 * Normalize a post's tags to the /posts/ object shape. The uploads and
 * favorites lists return tags as plain STRINGS; category is unknowable
 * there (null), so consumers must treat null-category as "any".
 */
export function normalizeBotbooruPostTags(post) {
    if (Array.isArray(post?.tags)) {
        post.tags = post.tags.map(t => (typeof t === 'string' ? { name: t, category: null } : t));
    }
    return post;
}

/**
 * Fetch a user profile. Used for uploader name resolution (the posts list
 * only carries uploader_id) and for the uploads browse view: `uploads[]`
 * comes back in posts[] item shape with `uploads_list_total` for paging,
 * EXCEPT its tags are plain strings (normalized here).
 * @param {number|string} id
 * @param {{ uploadLimit?: number, uploadOffset?: number, uploadSort?: string }} [opts]
 * @returns {Promise<Object|null>}
 */
export async function fetchBotbooruUser(id, opts = {}) {
    const qs = new URLSearchParams({
        upload_limit: String(opts.uploadLimit ?? 1),
        upload_offset: String(opts.uploadOffset ?? 0),
        upload_sort: opts.uploadSort || 'latest',
    });
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/users/${id}?${qs}`, { headers: getBotbooruHeaders(true) });
        const user = await resp.json();
        if (user?.id == null) return null;
        if (Array.isArray(user.uploads)) user.uploads.forEach(normalizeBotbooruPostTags);
        return user;
    } catch (e) {
        debugLog('[Botbooru] user fetch failed:', id, e.message);
        return null;
    }
}

// ========================================
// USER FOLLOWS (server-backed)
// ========================================

/**
 * List the users an account follows.
 * @param {number|string} userId - the account whose following list to read
 * @returns {Promise<{total: number, users: Array}|null>}
 */
export async function fetchBotbooruFollowing(userId, opts = {}) {
    const qs = new URLSearchParams({
        limit: String(opts.limit ?? 100),
        offset: String(opts.offset ?? 0),
    });
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/users/${userId}/following?${qs}`, { headers: getBotbooruHeaders(true) });
        const data = await resp.json();
        return Array.isArray(data?.users) ? data : null;
    } catch (e) {
        debugLog('[Botbooru] following fetch failed:', e.message);
        return null;
    }
}

/**
 * Follow (POST, idempotent) or unfollow (DELETE) a user.
 * @returns {Promise<boolean|null>} the resulting following state, null on error
 */
export async function setBotbooruFollow(userId, follow) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/users/${userId}/follow`, {
            method: follow ? 'POST' : 'DELETE',
            headers: getBotbooruHeaders(true),
        });
        const data = await resp.json();
        return typeof data?.following === 'boolean' ? data.following : null;
    } catch (e) {
        debugLog('[Botbooru] follow toggle failed:', userId, e.message);
        return null;
    }
}

// ========================================
// FAVORITE TAGS (followed tags; they boost matching cards in the curated sort)
// ========================================

/** @returns {Promise<Array<{id, tag_id, tag_name, category}>|null>} */
export async function fetchBotbooruFollowedTags() {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/follows/tags`, { headers: getBotbooruHeaders(true) });
        const data = await resp.json();
        return Array.isArray(data) ? data : null;
    } catch (e) {
        debugLog('[Botbooru] followed tags fetch failed:', e.message);
        return null;
    }
}

/** category is REQUIRED by the endpoint (422 without). */
export async function addBotbooruFollowedTag(tagName, category) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/follows/tags`, {
            method: 'POST',
            headers: { ...getBotbooruHeaders(true), 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_name: tagName, category }),
        });
        const entry = await resp.json();
        return entry?.id != null ? entry : null;
    } catch (e) {
        debugLog('[Botbooru] follow tag failed:', tagName, e.message);
        return null;
    }
}

/** @returns {Promise<boolean>} */
export async function removeBotbooruFollowedTag(entryId) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/follows/tags/${entryId}`, {
            method: 'DELETE',
            headers: getBotbooruHeaders(true),
        });
        return resp.ok; // 204, no body
    } catch (e) {
        debugLog('[Botbooru] unfollow tag failed:', entryId, e.message);
        return false;
    }
}

// ========================================
// TAG WEIGHTS (weighted-tag account mode)
// ========================================

/** @returns {Promise<Array<{id, tag_id, tag_name, category, weight, always_block, always_follow}>|null>} */
export async function fetchBotbooruTagWeights() {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/tag-weights`, { headers: getBotbooruHeaders(true) });
        const data = await resp.json();
        return Array.isArray(data) ? data : null;
    } catch (e) {
        debugLog('[Botbooru] tag weights fetch failed:', e.message);
        return null;
    }
}

/** Upsert. payload: { tag_name, category, weight, always_follow?, always_block? } */
export async function upsertBotbooruTagWeight(payload) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/tag-weights`, {
            method: 'POST',
            headers: { ...getBotbooruHeaders(true), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const entry = await resp.json();
        return entry?.id != null ? entry : null;
    } catch (e) {
        debugLog('[Botbooru] tag weight upsert failed:', payload?.tag_name, e.message);
        return null;
    }
}

/** @returns {Promise<boolean>} */
export async function deleteBotbooruTagWeight(entryId) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me/tag-weights/${entryId}`, {
            method: 'DELETE',
            headers: getBotbooruHeaders(true),
        });
        return resp.ok; // 204, no body
    } catch (e) {
        debugLog('[Botbooru] tag weight delete failed:', entryId, e.message);
        return false;
    }
}

// ========================================
// FAVORITES (post hearts; POST is a pure toggle)
// ========================================

/**
 * Read a post's favorite state for the logged-in account.
 * @returns {Promise<{count: number, favorited: boolean}|null>}
 */
export async function fetchBotbooruFavoriteState(postId) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/interactions/${postId}/favorites`, { headers: getBotbooruHeaders(true) });
        const data = await resp.json();
        return typeof data?.favorited === 'boolean' ? data : null;
    } catch (e) {
        debugLog('[Botbooru] favorite state fetch failed:', postId, e.message);
        return null;
    }
}

/**
 * Toggle a post's favorite (no body; the response is the new state).
 * @returns {Promise<{favorited: boolean, count: number}|null>}
 */
export async function toggleBotbooruFavorite(postId) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/interactions/${postId}/favorite`, {
            method: 'POST',
            headers: getBotbooruHeaders(true),
        });
        const data = await resp.json();
        return typeof data?.favorited === 'boolean' ? data : null;
    } catch (e) {
        debugLog('[Botbooru] favorite toggle failed:', postId, e.message);
        return null;
    }
}

/**
 * The account's favorites list: a BARE ARRAY of posts[]-shaped items with
 * kind:"character", STRING tags (normalized here), and no uploader_id. No
 * total field; hasMore = full page.
 * @returns {Promise<Array|null>}
 */
export async function fetchBotbooruFavorites(userId, opts = {}) {
    const qs = new URLSearchParams({
        page: String(opts.page ?? 1),
        per_page: String(opts.perPage ?? 40),
    });
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/users/${userId}/favorites?${qs}`, { headers: getBotbooruHeaders(true) });
        const data = await resp.json();
        if (!Array.isArray(data)) return null;
        return data.filter(item => item?.kind === 'character').map(normalizeBotbooruPostTags);
    } catch (e) {
        debugLog('[Botbooru] favorites list fetch failed:', e.message);
        return null;
    }
}

// ========================================
// ACCOUNT
// ========================================

/**
 * Read the logged-in account (token validation; null on failure incl. 401).
 * @returns {Promise<Object|null>}
 */
export async function fetchBotbooruMe() {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me`, { headers: getBotbooruHeaders(true) });
        return await resp.json();
    } catch (e) {
        debugLog('[Botbooru] auth/me failed:', e.message);
        return null;
    }
}

/**
 * PATCH account preferences, eg. { show_nsfw: true }. The account flags are
 * the server-side master switches; the sfw_only query param filters per
 * request but cant reveal NSFW while the account switch is off.
 * @param {Object} patch
 * @returns {Promise<Object|null>} updated account or null
 */
export async function patchBotbooruAccount(patch) {
    try {
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/auth/me`, {
            method: 'PATCH',
            headers: { ...getBotbooruHeaders(true), 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        return await resp.json();
    } catch (e) {
        debugLog('[Botbooru] account patch failed:', e.message);
        return null;
    }
}

// ========================================
// DOWNLOAD TRACKING
// ========================================

/** Fire-and-forget download ping (feeds the site's card stats); call sites gate it on the setting. */
export function trackBotbooruDownload(id, kind = 'png') {
    fetchWithProxy(`${BOTBOORU_BASE}/posts/${id}/track-download?kind=${encodeURIComponent(kind)}`, {
        method: 'POST',
        headers: getBotbooruHeaders(true),
    }).catch(() => {});
}
