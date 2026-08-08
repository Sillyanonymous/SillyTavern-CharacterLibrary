// Shared Saucepan API utilities - used by both saucepan-provider.js and
// saucepan-browse.js, plus DataCat and the Creator Downloads adapter for
// creator/companion lookups. All calls go through cl-helper (transport only).

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

const SAUCEPAN_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/saucepan-proxy`;
const SAUCEPAN_CUSTOM_PROVIDER_PROFILES = new Set([
    'custom_and_vetted',
    'vetted_only_owner_bypass',
    'internal_only_owner_bypass',
]);

// Saucepan CDN images can't be hotlinked: the CDN answers with
// Cross-Origin-Resource-Policy: same-origin, so the browser refuses to render
// them from our origin. Route them through cl-helper's proxy instead. Images
// live at saucepan.ai/cdn/{imageId}/card; plugin routes are prefixed with /api.
export const SAUCEPAN_CDN_PROXY_BASE = `/api${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`;

// The CDN is variant-addressed (/cdn/{id}/{variant}). Small surfaces use 'card' so a 70px
// avatar or grid thumb does not pull a full-size source; full-screen and saved media use
// 'highres' (the API's own highres_url variant).
export const SAUCEPAN_IMG_CARD = 'card';
export const SAUCEPAN_IMG_FULL = 'highres';

/**
 * Absolute CDN URL for a Saucepan image id.
 * @param {string} imageId
 * @param {string} [variant] - SAUCEPAN_IMG_CARD (default) or SAUCEPAN_IMG_FULL
 * @returns {string}
 */
export function saucepanCdnUrl(imageId, variant = SAUCEPAN_IMG_CARD) {
    return imageId ? `https://saucepan.ai/cdn/${imageId}/${variant}` : '';
}

/**
 * Canonical page URL for a companion.
 * @param {string} id - companion UUID
 * @returns {string}
 */
export function saucepanCompanionUrl(id) {
    return `https://saucepan.ai/companion/${id}`;
}

const SAUCEPAN_ORDER_MAP = {
    saucepan_new: 'created',
    saucepan_trending: 'trending',
    saucepan_popular: 'popularity',
};

// Saucepan's own default "content warning" exclusion list, the extreme-content
// tags the site hides by default (the "CW" toggle). Applied only when the user
// enables the "Hide extreme content" toggle; otherwise no tags are excluded.
const SAUCEPAN_CW_EXTREME_TAGS = [
    'noncon_dubcon', 'incest_stepcest', 'gore', 'body_horror', 'slur_usage',
    'self_harm_suicide', 'vore', 'cannibalism', 'feral', 'user_harm',
    'eating_disorder', 'amputation', 'miscarriage',
];

// ========================================
// NETWORK
// ========================================

let _apiRequest = null;
let _getSaucepanToken = null;

/**
 * Bind the CoreAPI.apiRequest function for proxied requests. Called from the
 * Saucepan provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter that returns the persisted Saucepan Bearer token (or null).
 * Used by native extraction to authenticate the definition fetch.
 */
export function setSaucepanTokenGetter(fn) { _getSaucepanToken = fn; }

/**
 * Return true if a Saucepan token appears to be configured.
 * @returns {boolean}
 */
export function hasSaucepanToken() { return !!(_getSaucepanToken?.() ?? null); }

/** Return true only when Saucepan says this companion may use a custom provider. */
export function canUseSaucepanHiddenCapture(companion) {
    return SAUCEPAN_CUSTOM_PROVIDER_PROFILES.has(companion?.providers_profile);
}

/**
 * Ping cl-helper's health endpoint. Used by the auth bridges to report a
 * friendly "plugin not available" instead of a raw HTTP error.
 * @returns {Promise<boolean>}
 */
export async function checkClHelperAvailable() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

let _tokenPushInFlight = null;

// cl-helper holds the token in RAM only, so it is empty after every ST restart while
// the client still has one persisted. Provider init pushes it fire-and-forget, so a
// call made before that lands would 403; re-push once and retry rather than fail.
async function tryPushSavedToken() {
    if (_tokenPushInFlight) return _tokenPushInFlight;
    // Bail BEFORE storing anything: a path that returns without awaiting would finish
    // before the assignment lands, so clearing from inside would be overwritten and the
    // stale resolved promise would suppress every later retry for the whole session.
    const saved = _getSaucepanToken?.() ?? null;
    if (!saved) return false;
    const attempt = (async () => {
        try {
            return !!(await pushSaucepanToken(saved))?.ok;
        } catch {
            return false;
        }
    })();
    _tokenPushInFlight = attempt;
    attempt.finally(() => { if (_tokenPushInFlight === attempt) _tokenPushInFlight = null; });
    return attempt;
}

async function saucepanFetch(method, apiPath, body) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound (cl-helper required)');
    const url = `${SAUCEPAN_PROXY_BASE}${apiPath}`;
    const send = () => (method === 'POST' ? _apiRequest(url, 'POST', body) : _apiRequest(url));
    let resp = await send();
    if (resp.status === 401 || resp.status === 403) {
        if (await tryPushSavedToken()) resp = await send();
    }
    return resp;
}

// ========================================
// SESSION (cl-helper token management)
// ========================================

/** Shared error shaping for the session endpoints. */
async function sessionError(resp) {
    const text = await resp.text().catch(() => '');
    return `HTTP ${resp.status}: ${text.slice(0, 200)}`;
}

/**
 * Log into Saucepan via cl-helper (which performs the credentialed request).
 * The password is never stored; the returned token is what callers persist.
 * @returns {Promise<{ok: boolean, token?: string, error?: string}>}
 */
export async function saucepanLogin(handle, password) {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-login`, 'POST', { handle, password });
        if (!resp.ok) return { ok: false, error: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Push a Bearer token into cl-helper's in-memory store (proxy auth).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function pushSaucepanToken(token) {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`, 'POST', { token });
        if (!resp.ok) return { ok: false, error: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Validate the token cl-helper currently holds.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateSaucepanSession() {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-validate`);
        if (!resp.ok) return { valid: false, reason: await sessionError(resp) };
        return await resp.json();
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

/**
 * Clear the token from cl-helper's in-memory store.
 * @returns {Promise<boolean>}
 */
export async function clearSaucepanToken() {
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-clear-token`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
}

// ========================================
// IMAGES
// ========================================

/**
 * Rewrite a Saucepan CDN image URL to the local cl-helper proxy path.
 * Non-Saucepan URLs are returned unchanged.
 * @param {string} url
 * @returns {string}
 */
export function resolveSaucepanImageUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('https://saucepan.ai/cdn/')) {
        return url.replace('https://saucepan.ai/cdn/', SAUCEPAN_CDN_PROXY_BASE);
    }
    // Legacy CDN host found in older DataCat rows. The host no longer
    // resolves, but its path shape maps 1:1 onto saucepan.ai/cdn/.
    if (url.startsWith('https://cdn.saucepan.ai/images/')) {
        return url.replace('https://cdn.saucepan.ai/images/', SAUCEPAN_CDN_PROXY_BASE);
    }
    // Proxy paths from earlier builds that lack the /api prefix.
    if (url.startsWith(`${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`)) {
        return `/api${url}`;
    }
    return url;
}

// ========================================
// SEARCH / DETAIL
// ========================================

/**
 * Search Saucepan companions via the Saucepan API (proxied through cl-helper).
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=96]
 * @param {string} [opts.sort='saucepan_new']
 * @param {boolean} [opts.openDefinitionOnly=true]
 * @param {string[]} [opts.tags=[]] - Tag slugs to include (AND match)
 * @param {string[]} [opts.excludedTags=[]] - Tag slugs to exclude
 * @returns {Promise<{characters: Object[], totalCount: number, totalPages: number}>}
 */
export async function searchSaucepan(opts = {}) {
    const {
        search = '',
        page = 1,
        limit = 96,
        sort = 'saucepan_new',
        openDefinitionOnly = true,
        tags = [],
        excludedTags = [],
        // SFW by default (user opts in via the browse toggle); maps to `sus`.
        nsfw = false,
        // Off by default: exclude nothing. When true, apply Saucepan's built-in
        // content-warning exclusion list on top of any user-excluded tags.
        hideExtreme = false,
        fandomTags = [],
        excludedFandomTags = [],
        matchAllFandomTags = false,
    } = opts;
    const orderBy = SAUCEPAN_ORDER_MAP[sort] || 'created';
    const offset = Math.max(0, (page - 1) * limit);

    const baseExcluded = Array.isArray(excludedTags) ? excludedTags : [];
    const excluded = hideExtreme
        ? Array.from(new Set([...baseExcluded, ...SAUCEPAN_CW_EXTREME_TAGS]))
        : baseExcluded;

    const body = {
        text_search: search || null,
        tags: Array.isArray(tags) ? tags : [],
        excluded_tags: excluded,
        fandom_tags: Array.isArray(fandomTags) ? fandomTags : [],
        excluded_fandom_tags: Array.isArray(excludedFandomTags) ? excludedFandomTags : [],
        match_all_fandom_tags: !!matchAllFandomTags,
        limit,
        offset,
        sus: !!nsfw,
        extra_spicy: null,
        order_by: orderBy,
        asc: false,
        posted_at_from: null,
        posted_at_to: null,
        match_all_tags: true,
        hide_hidden_content: false,
        open_definition_only: openDefinitionOnly,
    };

    let response;
    try {
        response = await saucepanFetch('POST', '/api/v1/search', body);
    } catch (err) {
        throw new Error(`Saucepan search failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);

    const data = await response.json();
    const companions = data?.companions || [];
    const totalCount = data?.total_count || 0;
    const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 0;

    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount,
        totalPages,
    };
}

function normalizeSaucepanHit(hit) {
    const imageId = hit?.image?.id || '';
    // Grid thumbs take the small variant; avatarFull backs the full-screen viewer.
    const avatar = imageId ? `${SAUCEPAN_CDN_PROXY_BASE}${imageId}/${SAUCEPAN_IMG_CARD}` : '';
    const avatarFull = imageId ? `${SAUCEPAN_CDN_PROXY_BASE}${imageId}/${SAUCEPAN_IMG_FULL}` : '';
    const tags = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        character_id: hit.id,
        // name is the character's actual name; display_name is the listing title ("Title | Name").
        name: hit.name || hit.display_name || 'Unknown',
        display_name: hit.display_name || hit.name || 'Unknown',
        avatar,
        avatarFull,
        description: hit.short_description || '',
        tags,
        creator_name: hit.author_handle || '',
        creator_id: hit.author_id || '',
        createdAt: hit.posted_at || '',
        isNsfw: !!hit.sus,
        totalTokens: hit.card_token_count || 0,
        chat_count: hit.chat_count || 0,
        message_count: hit.interaction_count || 0,
        favorite_count: hit.favorite_count || 0,
        portrait_count: hit.portrait_count || 0,
        scenario_count: hit.scenario_count || 0,
        lorebook_count: hit.lorebook_count || 0,
        locked_starting_message: !!hit.locked_starting_message,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
    };
}

/**
 * Build a normalized hit from a companion-detail object (URL lookups, in-app
 * preview, the V2 builder). Mirrors the shape of normalizeSaucepanHit.
 * @param {Object|null} companion - Detail object from fetchSaucepanCompanion
 * @param {string} fallbackId - companion id to use when the detail is missing
 * @returns {Object}
 */
export function hitFromCompanion(companion, fallbackId) {
    const id = companion?.id || fallbackId;
    return {
        character_id: id,
        id,
        name: companion?.name || companion?.display_name || 'Unknown',
        display_name: companion?.display_name || companion?.name || 'Unknown',
        avatar: resolveSaucepanImageUrl(
            companion?.image?.highres_url
            || companion?.image?.url
            || saucepanCdnUrl(companion?.image?.id),
        ),
        avatarFull: resolveSaucepanImageUrl(
            companion?.image?.highres_url
            || companion?.image?.url
            || saucepanCdnUrl(companion?.image?.id, SAUCEPAN_IMG_FULL),
        ),
        description: companion?.short_description || '',
        tags: Array.isArray(companion?.tags) ? companion.tags : [],
        creator_name: companion?.author_handle || '',
        creator_id: companion?.author_id || '',
        createdAt: companion?.posted_at || '',
        isNsfw: !!companion?.sus,
        totalTokens: companion?.card_token_count || 0,
        chat_count: companion?.chat_count || 0,
        message_count: companion?.interaction_count || 0,
        favorite_count: companion?.favorite_count || 0,
        portrait_count: Array.isArray(companion?.portraits) ? companion.portraits.length : 0,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
        _fullCompanion: companion,
    };
}

/**
 * Fetch all companions authored by a Saucepan handle.
 * The endpoint returns the full list in one response (no real pagination
 * support: limit/offset are ignored server-side, total_count == count).
 * @param {string} handle - Saucepan author handle
 * @returns {Promise<{characters: Object[], totalCount: number}>}
 */
export async function fetchSaucepanCompanionsOfUser(handle) {
    if (!handle) return { characters: [], totalCount: 0 };
    let response;
    try {
        // Saucepan retired /api/v1/companions-of-user (bare 404 on every param shape); the
        // live route is v2, handle in the path. Search-side author filters are ignored, so
        // this is the only way to list one creator's companions.
        response = await saucepanFetch('GET', `/api/v2/users/${encodeURIComponent(handle)}/companions`);
    } catch (err) {
        throw new Error(`Saucepan creator fetch failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);
    const data = await response.json();
    const companions = data?.companions || [];
    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount: data?.total_count ?? companions.length,
    };
}

// Short-lived cache so the burst of companion reads when a card opens (preview
// header, link-modal stats, gallery, extraction) collapses to a single network
// round-trip. Stores the in-flight promise, so concurrent callers coalesce too.
const _saucepanCompanionCache = new Map(); // id -> { promise, ts }
const SAUCEPAN_COMPANION_TTL = 60_000;
// Companion details carry the full portrait list and every text field, so an uncapped map
// would retain every card browsed this session. Map preserves insertion order: evict oldest.
const SAUCEPAN_COMPANION_CACHE_MAX = 50;

// Cached companion fetch returning the result envelope { ok, status, companion }: the
// extraction leg needs ok/status to tell "companion leg failed" from "companion absent",
// which is what keeps greetingsUnavailable honest. Only successful payloads stay cached,
// so a failure always comes from a live request carrying its real status.
async function fetchCompanionResult(id) {
    const cached = _saucepanCompanionCache.get(id);
    if (cached && (Date.now() - cached.ts) < SAUCEPAN_COMPANION_TTL) return cached.promise;
    while (_saucepanCompanionCache.size >= SAUCEPAN_COMPANION_CACHE_MAX) {
        _saucepanCompanionCache.delete(_saucepanCompanionCache.keys().next().value);
    }
    // Companion detail lives at /api/v2/companions/<id> (Bearer-authed). The old
    // /api/v1/companion?id= form is a different endpoint and 405s on GET.
    const promise = (async () => {
        try {
            const response = await saucepanFetch('GET', `/api/v2/companions/${encodeURIComponent(id)}`);
            let data = null;
            try { data = await response.json(); } catch { /* non-JSON body */ }
            return { ok: response.ok, status: response.status, companion: data?.companion || null };
        } catch {
            return { ok: false, status: 0, companion: null };
        }
    })();
    const entry = { promise, ts: Date.now() };
    _saucepanCompanionCache.set(id, entry);
    // Don't cache misses: failures and empty payloads drop on settle so the next call retries.
    // Identity-check first, or a slow miss from a superseded request would evict a newer entry.
    promise.then(result => {
        if (!(result.ok && result.companion) && _saucepanCompanionCache.get(id) === entry) {
            _saucepanCompanionCache.delete(id);
        }
    });
    return promise;
}

/**
 * Fetch a single Saucepan companion's detail by id.
 * Returns the raw `companion` object, or null on failure.
 * The detail endpoint exposes `open_definition` (boolean), which the
 * search/listing endpoint does not include.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function fetchSaucepanCompanion(id) {
    if (!id) return null;
    return (await fetchCompanionResult(id)).companion;
}

/**
 * Fetch Saucepan's curated fandom (franchise/source-material) vocabulary.
 * Distinct from regular tags, passed to search as fandom_tags/excluded_fandom_tags.
 * @returns {Promise<Array<{id: string, name: string, description: string, searchTerms: string}>>}
 */
export async function fetchSaucepanFandoms() {
    try {
        const response = await saucepanFetch('GET', '/api/v1/fandoms');
        if (!response.ok) return [];
        const data = await response.json();
        const list = Array.isArray(data) ? data : (data?.fandoms || []);
        return list
            .filter(f => f && f.id && f.is_enabled !== false)
            .map(f => ({
                id: f.id,
                name: f.display_name || f.id,
                description: f.description || '',
                searchTerms: f.search_terms || '',
            }));
    } catch {
        return [];
    }
}

// ========================================
// NATIVE EXTRACTION
// ========================================

// Prose ships shuffled and decoy-padded; a real fragment's proof reproduces from its slot, a decoy's doesnt.
const FRAGMENT_SEED = 2166136261;
const FRAGMENT_MULTIPLIER = 16777619;

function rotateLeft32(word, bits) {
    return ((word << bits) | (word >>> (32 - bits))) >>> 0;
}

function proofFor(mask, slot, text) {
    let hash = (FRAGMENT_SEED ^ rotateLeft32(mask, 7) ^ rotateLeft32(slot, 13)) >>> 0;
    for (const byte of new TextEncoder().encode(text)) {
        hash = Math.imul(hash ^ byte, FRAGMENT_MULTIPLIER) >>> 0;
    }
    return hash;
}

// Upstream reads these fields unchecked; coming off a proxy, a bad shape is just another decoy.
function placeFragment(fragment, mask) {
    if (!fragment || typeof fragment.text !== 'string') return null;
    const slot = (fragment.key ^ mask) >>> 0;
    if (proofFor(mask, slot, fragment.text) !== (fragment.proof >>> 0)) return null;
    return { slot, text: fragment.text };
}

function unscrambleFragments(content) {
    if (!Array.isArray(content?.fragments)) return '';
    // A missing mask coerces to 0 on its own, which is the identity for the key XOR.
    const mask = content.mask >>> 0;
    const placed = [];
    for (const fragment of content.fragments) {
        const spot = placeFragment(fragment, mask);
        if (spot) placed.push(spot);
    }
    placed.sort((a, b) => a.slot - b.slot);
    return placed.map(p => p.text).join('');
}

/**
 * The public profile long-description (the creator's commentary), assembled from
 * fragments. Served for every card regardless of definition lock. '' when absent.
 * @param {Object|null} companion - Detail from fetchSaucepanCompanion
 * @returns {string}
 */
export function assembleSaucepanProfileDescription(companion) {
    if (!companion?.full_description_fragments) return '';
    return unscrambleFragments(companion.full_description_fragments);
}

/** GET a Saucepan JSON endpoint through the proxy. Returns { ok, status, data }. */
async function fetchSaucepanJson(apiPath) {
    const resp = await saucepanFetch('GET', apiPath);
    let data = null;
    try { data = await resp.json(); } catch { /* non-JSON body */ }
    return { ok: resp.ok, status: resp.status, data };
}

/**
 * Submit a Saucepan companion URL for native extraction via cl-helper.
 * Requires a Saucepan Bearer token (login or manually pasted).
 * @param {string} companionUrl - Full Saucepan companion URL
 * @returns {Promise<{success: boolean, assembled?: Object, greetings?: Object[], error?: string}>}
 */
export async function submitSaucepanExtraction(companionUrl, { allowPartial = false, allowHiddenCapture = false } = {}) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound');

    let companionId;
    try {
        const parsed = new URL(companionUrl);
        companionId = parsed.pathname.match(/^\/companion\/([a-f0-9-]{8,64})\/?$/i)?.[1];
    } catch { /* fall through */ }
    if (!companionId) return { success: false, error: 'Invalid Saucepan companion URL' };

    try {
        const id = encodeURIComponent(companionId);
        // The v2 companion supplies greetings and the Companion Core fallback; the definition
        // endpoint is authoritative for the named prose sections. The companion leg joins the
        // shared cache (an update check or preview fetched the same payload moments ago) and
        // keeps its ok/status envelope so a real leg failure still reads as one.
        const [compRes, defRes] = await Promise.all([
            fetchCompanionResult(companionId),
            fetchSaucepanJson(`/api/v1/companion/definition?companion_id=${id}`),
        ]);

        const companion = compRes.companion;
        // Locked companions can 403 the definition endpoint outright (the other lock mode
        // answers 200 with empty sections); a user-confirmed partial import continues without it.
        const partialLocked = (allowPartial || allowHiddenCapture) && companion?.open_definition === false;
        if ((!defRes.ok || !defRes.data) && !partialLocked) {
            if (!defRes.ok) {
                const msg = defRes.data?.error?.message || defRes.data?.error || `Saucepan HTTP ${defRes.status}`;
                return { success: false, error: msg };
            }
            return { success: false, error: 'Invalid JSON from Saucepan' };
        }

        const assembled = {};
        for (const section of (Array.isArray(defRes.data?.sections) ? defRes.data.sections : [])) {
            if (!section?.title || !section?.content) continue;
            assembled[section.title] = unscrambleFragments(section.content);
        }

        // The creator's long-form commentary; feeds creator_notes (the short blurb is tagline material).
        const profileDescription = assembleSaucepanProfileDescription(companion);

        // A failed greetings leg must be reported, not silently flattened to zero greetings:
        // the caller marks first_mes/alternate_greetings unavailable so an update check cannot
        // read the absence as a deletion and blank what the user holds locally.
        const greetingsUnavailable = !compRes.ok || !companion;
        if (greetingsUnavailable) {
            console.warn(`[Saucepan] companion fetch failed with HTTP ${compRes.status}; greetings marked unavailable`);
        }

        const greetings = [];
        for (const scenario of (Array.isArray(companion?.starting_scenarios_fragments) ? companion.starting_scenarios_fragments : [])) {
            const text = unscrambleFragments(scenario?.message);
            if (text && text.trim()) {
                greetings.push({ title: typeof scenario?.title === 'string' ? scenario.title : '', text });
            }
        }

        const defLocked = companion?.open_definition === false;
        let cleanupWarning = '';
        if (allowHiddenCapture && defLocked && !assembled['Companion Core'] && canUseSaucepanHiddenCapture(companion)) {
            const captureResponse = await _apiRequest(
                `${CL_HELPER_PLUGIN_BASE}/saucepan-extract-hidden`,
                'POST',
                { companionId },
            );
            let captureData = null;
            try { captureData = await captureResponse.json(); } catch { /* non-JSON helper error */ }
            if (!captureResponse.ok || !captureData?.success) {
                return {
                    success: false,
                    error: captureData?.error || `Hidden extraction failed (HTTP ${captureResponse.status})`,
                    locked: true,
                    cleanupWarning: captureData?.cleanupWarning || '',
                };
            }
            cleanupWarning = captureData.cleanupWarning || '';
            if (captureData.assembled?.['Companion Core']) {
                assembled['Companion Core'] = captureData.assembled['Companion Core'];
            }
            if (captureData.assembled?.['Example Dialogue']) {
                assembled['Example Dialogue'] = captureData.assembled['Example Dialogue'];
            }
            if (!greetings.length && typeof captureData.greeting === 'string' && captureData.greeting.trim()) {
                greetings.push({ title: '', text: captureData.greeting.trim() });
            }
        }

        // The companion's full_description is the public profile text, not the definition;
        // substituting it on a locked card silently imports wrong content.
        if (!assembled['Companion Core'] && !defLocked && profileDescription) {
            assembled['Companion Core'] = profileDescription;
        }
        const partial = defLocked && !assembled['Companion Core'];
        if (partial && !allowPartial) {
            return { success: false, error: "This companion's definition is locked by its creator", locked: true };
        }

        return {
            success: true,
            assembled,
            greetings,
            greetingsUnavailable,
            partial,
            profileDescription,
            ...(cleanupWarning ? { cleanupWarning } : {}),
        };
    } catch (e) {
        console.error('[Saucepan] submitSaucepanExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Build a V2 character card from native Saucepan extraction data.
 * Returns null when the definition carries no usable body so callers can
 * fall back to DataCat's aggregated copy instead of importing an empty card.
 *
 * Section/greeting -> V2 field mapping:
 *   'Companion Core'                  -> description (character body)
 *   'Example Dialogue'                -> mes_example
 *   'Advanced Prompt'                 -> system_prompt
 *   'Response Formatting Instructions'-> post_history_instructions
 *   greetings[0]                      -> first_mes
 *   greetings[1..]                    -> alternate_greetings
 *   full_description (assembled)      -> creator_notes (empty when the creator wrote none)
 *   short_description                 -> extensions.saucepan.tagline
 * @param {Object} hit - Normalized Saucepan hit from search/companions endpoint
 * @param {Object} extractData - Result of submitSaucepanExtraction { assembled: {...}, greetings: [{title, text}] }
 * @returns {Object|null}
 */
export function buildV2FromSaucepan(hit, extractData) {
    const assembled = extractData?.assembled;
    if (!hit || !assembled) return null;
    const description = assembled['Companion Core'] || '';
    // A user-confirmed partial import of a locked companion legitimately has no definition.
    if (!description && !extractData.partial) {
        console.warn(
            '[Saucepan] Companion Core section not found in Saucepan extraction. Available sections:',
            Object.keys(assembled).join(', ') || '(none)',
        );
        return null;
    }
    const mesExample = assembled['Example Dialogue'] || '';
    const systemPrompt = assembled['Advanced Prompt'] || '';
    const postHistory = assembled['Response Formatting Instructions'] || '';

    // Starting scenarios become greetings: the first is first_mes, the rest
    // are alternate greetings; submitSaucepanExtraction already assembled and filtered them.
    const greetingTexts = Array.isArray(extractData.greetings)
        ? extractData.greetings.map(g => g?.text || '').filter(Boolean)
        : [];
    const firstMes = greetingTexts[0] || '';
    const alternateGreetings = greetingTexts.slice(1);

    const tagNames = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            // The card gets the clean character name; the listing title travels as pageName.
            name: hit.name || hit.display_name || 'Unknown',
            description,
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: mesExample,
            system_prompt: systemPrompt,
            post_history_instructions: postHistory,
            creator_notes: extractData.profileDescription || '',
            creator: hit.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: alternateGreetings,
            extensions: {
                saucepan: {
                    id: hit.character_id || hit.id,
                    creatorId: hit.creator_id || null,
                    creatorName: hit.creator_name || null,
                    tagline: hit.description || null,
                },
            },
        },
    };
}

/**
 * Fetch a Saucepan companion's full definition and build a V2 card.
 * @param {Object} hit - Normalized Saucepan hit (must have character_id or id)
 * @returns {Promise<Object|null>} V2 card or null
 */
export async function fetchSaucepanV2Card(hit, { allowHiddenCapture = false } = {}) {
    if (!hit?.character_id && !hit?.id) return null;
    const result = await submitSaucepanExtraction(
        saucepanCompanionUrl(hit.character_id || hit.id),
        { allowHiddenCapture },
    );
    if (!result.success) {
        console.warn('[Saucepan] Native extraction failed:', result.error);
        if (allowHiddenCapture) {
            const error = new Error(result.error || 'Saucepan hidden extraction failed');
            if (result.cleanupWarning) error.cleanupWarning = result.cleanupWarning;
            throw error;
        }
        return null;
    }
    const card = buildV2FromSaucepan(hit, result);
    if (card && result.cleanupWarning) card._saucepanCleanupWarning = result.cleanupWarning;
    return card;
}
