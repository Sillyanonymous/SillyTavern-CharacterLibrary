// Saucepan (saucepan.ai) client API - used by the Saucepan provider, and by
// DataCat for its Saucepan-sourced index rows (creator lookups, CDN images).
//
// All calls go through cl-helper (/plugins/cl-helper/saucepan-*), never ST's
// /proxy/: Saucepan responds with zstd-compressed bodies that ST's proxy
// forwards without a Content-Encoding header, leaving the browser unable to
// decode them. cl-helper negotiates gzip/br/deflate (falling back to native
// zstd) and performs the auth'd definition fetch + fragment reassembly.

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

const SAUCEPAN_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/saucepan-proxy`;

// Saucepan CDN images can't be hotlinked: the CDN answers with
// Cross-Origin-Resource-Policy: same-origin, so the browser refuses to render
// them from our origin. Route them through cl-helper's proxy instead. Images
// live at saucepan.ai/cdn/{imageId}/card; plugin routes are prefixed with /api.
export const SAUCEPAN_CDN_PROXY_BASE = `/api${CL_HELPER_PLUGIN_BASE}/saucepan-proxy/cdn/`;

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

// Saucepan's own default "content warning" exclusion list — the extreme-content
// tags the site hides by default (the "CW" toggle). We leave these INCLUDED by
// default (this audience wants the harder content) and only apply them when the
// user opts into hiding via the "Hide extreme content" toggle.
export const SAUCEPAN_CW_EXTREME_TAGS = [
    'noncon_dubcon', 'incest_stepcest', 'gore', 'body_horror', 'slur_usage',
    'self_harm_suicide', 'vore', 'cannibalism', 'feral', 'user_harm',
    'eating_disorder', 'amputation', 'miscarriage',
];

// ========================================
// TRANSPORT
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

async function saucepanFetch(method, apiPath, body) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound (cl-helper required)');
    const url = `${SAUCEPAN_PROXY_BASE}${apiPath}`;
    return method === 'POST'
        ? _apiRequest(url, 'POST', body)
        : _apiRequest(url);
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
        // NSFW on by default (this audience wants adult content); maps to `sus`.
        nsfw = true,
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
    const avatar = imageId ? `${SAUCEPAN_CDN_PROXY_BASE}${imageId}/card` : '';
    const tags = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        character_id: hit.id,
        name: hit.display_name || hit.name || 'Unknown',
        avatar,
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
        name: companion?.display_name || companion?.name || 'Unknown',
        display_name: companion?.display_name || companion?.name || 'Unknown',
        avatar: resolveSaucepanImageUrl(
            companion?.image?.highres_url
            || companion?.image?.url
            || (companion?.image?.id ? `https://saucepan.ai/cdn/${companion.image.id}/card` : ''),
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
        response = await saucepanFetch('GET', `/api/v1/companions-of-user?handle=${encodeURIComponent(handle)}`);
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

/**
 * Fetch a single Saucepan companion's detail by id.
 * Returns the raw `companion` object, or null on failure.
 * The detail endpoint exposes `open_definition` (boolean), which the
 * search/listing endpoint does not include.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
// Short-lived cache so the burst of companion reads when a card opens (preview
// header, link-modal stats, gallery) collapses to a single network round-trip.
// Stores the in-flight promise, so concurrent callers coalesce too. Pass
// { force: true } to bypass it (update checks want live data).
const _saucepanCompanionCache = new Map(); // id -> { promise, ts }
const SAUCEPAN_COMPANION_TTL = 60_000;

/** Drop a cached companion (or all) — e.g. after applying an update. */
export function clearSaucepanCompanionCache(id) {
    if (id) _saucepanCompanionCache.delete(id);
    else _saucepanCompanionCache.clear();
}

export async function fetchSaucepanCompanion(id, { force = false } = {}) {
    if (!id) return null;
    if (!force) {
        const hit = _saucepanCompanionCache.get(id);
        if (hit && (Date.now() - hit.ts) < SAUCEPAN_COMPANION_TTL) return hit.promise;
    }
    // Companion detail lives at /api/v2/companions/<id> (Bearer-authed). The old
    // /api/v1/companion?id= form is a different endpoint and 405s on GET.
    const promise = (async () => {
        try {
            const response = await saucepanFetch('GET', `/api/v2/companions/${encodeURIComponent(id)}`);
            if (!response.ok) return null;
            const data = await response.json();
            return data?.companion || null;
        } catch {
            return null;
        }
    })();
    _saucepanCompanionCache.set(id, { promise, ts: Date.now() });
    // Don't cache misses: if it resolves null, drop it so the next call retries.
    promise.then(companion => { if (!companion) _saucepanCompanionCache.delete(id); });
    return promise;
}

/**
 * Fetch Saucepan's curated fandom (franchise/source-material) vocabulary.
 * Distinct from regular tags — passed to search as fandom_tags/excluded_fandom_tags.
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

/**
 * Submit a Saucepan companion URL for native extraction via cl-helper.
 * Requires a Saucepan Bearer token (login or manually pasted).
 * @param {string} companionUrl - Full Saucepan companion URL
 * @returns {Promise<{success: boolean, companionId?: string, assembled?: Object, greetings?: Object[], meta?: Object, error?: string}>}
 */
export async function submitSaucepanExtraction(companionUrl) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound');
    // Send the persisted token when we have one; cl-helper falls back to its
    // own stored token (e.g. from a login this session) and 401s if neither
    // side has one.
    const token = _getSaucepanToken?.() ?? null;
    try {
        const resp = await _apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-extract`,
            'POST',
            token ? { url: companionUrl, token } : { url: companionUrl },
        );
        if (!resp.ok) {
            const errText = await resp.text();
            console.error(
                '[Saucepan] saucepan-extract error:',
                resp.status,
                errText.substring(0, 200),
            );
            return {
                success: false,
                error: `Server returned ${resp.status}: ${errText.substring(0, 100)}`,
            };
        }
        const data = await resp.json();
        if (data?.error) {
            return { success: false, error: data.error };
        }
        return {
            success: true,
            companionId: data.companionId,
            assembled: data.assembled,
            greetings: data.greetings,
            // { updated_at, card_token_count } baseline signals for the cheap
            // update pre-check; absent from older cl-helper deploys.
            meta: data.meta || null,
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
 * @param {Object} hit - Normalized Saucepan hit from search/companions endpoint
 * @param {Object} extractData - Response from /saucepan-extract { assembled: {...}, greetings: [{title, text}] }
 * @returns {Object|null}
 */
export function buildV2FromSaucepan(hit, extractData) {
    const assembled = extractData?.assembled;
    if (!hit || !assembled) return null;
    const description = assembled['Companion Core'] || '';
    if (!description) {
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
    // are alternate greetings. cl-helper already assembled and filtered them.
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
            name: hit.display_name || hit.name || 'Unknown',
            description,
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: mesExample,
            system_prompt: systemPrompt,
            post_history_instructions: postHistory,
            creator_notes: hit.description || '',
            creator: hit.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: alternateGreetings,
            extensions: {
                saucepan: {
                    id: hit.character_id || hit.id,
                    creatorId: hit.creator_id || null,
                    creatorName: hit.creator_name || null,
                    // Baselines for cheap update checks (hasRemoteChanged).
                    // updatedAt is the primary signal: it flips on any
                    // definition edit. tokenCount prefers the fresh extract
                    // meta over the possibly-stale search hit (kept as a
                    // fallback for older cl-helper deploys without meta); it's
                    // a non-injective sum (offsetting edits can preserve it),
                    // so it can miss edits.
                    updatedAt: extractData?.meta?.updated_at || null,
                    tokenCount: extractData?.meta?.card_token_count || hit.totalTokens || null,
                },
            },
        },
    };
}

/**
 * Build a DataCat-compatible character object from a Saucepan hit + native extraction.
 * This lets the browse preview modal render native-extracted Saucepan cards the same
 * way it renders DataCat-aggregated ones.
 * @param {Object} hit - Normalized Saucepan hit
 * @param {Object} v2Card - V2 card from buildV2FromSaucepan
 * @returns {Object}
 */
export function buildSaucepanCharacterFromHit(hit, v2Card) {
    const description = v2Card?.data?.description || '';
    return {
        character_id: hit.character_id || hit.id,
        name: hit.display_name || hit.name || 'Unknown',
        avatar: hit.avatar || '',
        description,
        short_description: hit.description || '',
        tags: hit.tags || [],
        creator_name: hit.creator_name || '',
        creator_id: hit.creator_id || '',
        primary_content_source_kind: 'saucepan',
        companion_snapshot: {
            full_description: hit.description || '',
        },
        chara_card_v2_json: v2Card,
        chat_count: hit.chat_count || 0,
        message_count: hit.message_count || 0,
        totalTokens: hit.totalTokens || 0,
        _source: 'saucepan',
    };
}

/**
 * Fetch a Saucepan companion's full definition and build a V2 card.
 * @param {Object} hit - Normalized Saucepan hit (must have character_id or id)
 * @returns {Promise<Object|null>} V2 card or null
 */
export async function fetchSaucepanV2Card(hit) {
    if (!hit?.character_id && !hit?.id) return null;
    const result = await submitSaucepanExtraction(saucepanCompanionUrl(hit.character_id || hit.id));
    if (!result.success) {
        console.warn('[Saucepan] Native extraction failed:', result.error);
        return null;
    }
    return buildV2FromSaucepan(hit, result);
}
