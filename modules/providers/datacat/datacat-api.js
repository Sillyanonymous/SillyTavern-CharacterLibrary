// Shared DataCat API utilities — used by datacat-provider.js and datacat-browse.js
//
// Sections: Network, Metadata, Browse/Search, Tags, V2 Card Builder, Extraction, MeiliSearch

import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml, fetchWithProxy } from '../provider-utils.js';
import { getSearchToken, JANNY_SEARCH_URL, JANNY_SITE_BASE, TAG_MAP as JANNY_TAG_MAP } from '../janny/janny-api.js';

export { slugify, stripHtml, JANNY_TAG_MAP };

// ========================================
// CONSTANTS
// ========================================

export const DATACAT_API_BASE = 'https://datacat.run';
export const DATACAT_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

// Minimum token threshold for quality filtering (matches DataCat's own frontend default)
export const MIN_TOTAL_TOKENS = 889;

// ========================================
// NETWORK
// ========================================

const DC_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/dc-proxy`;

let _apiRequest = null;

/**
 * Bind the CoreAPI.apiRequest function for use in proxied requests.
 * Called once from the provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Fetch a DataCat API path through the cl-helper plugin proxy.
 * @param {string} apiPath - Path relative to datacat.run (e.g. /api/characters/recent-public?...)
 * @returns {Promise<Response>}
 */
async function dcFetch(apiPath) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound (cl-helper required)');
    const resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
    if (!resp.ok) {
        let body = '';
        try { body = await resp.clone().text(); } catch { /* ignore */ }
        console.warn(`[DataCat] dcFetch ${resp.status} for ${apiPath}`, body.slice(0, 500));
    }
    return resp;
}

/**
 * Check if the cl-helper plugin is available.
 * @returns {Promise<boolean>}
 */
export async function checkDcPluginAvailable() {
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

/**
 * Try to restore a saved DataCat session token via cl-helper.
 * Pushes the saved token to cl-helper and validates it.
 * @param {string} savedToken - Previously saved session token
 * @returns {Promise<boolean>} true if the saved token is still valid
 */
async function restoreSavedToken(savedToken) {
    if (!savedToken || typeof savedToken !== 'string') return false;
    try {
        const setResp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-set-token`, 'POST', { token: savedToken })
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-set-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: savedToken }),
            });
        if (!setResp.ok) return false;

        const valResp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!valResp.ok) return false;
        const data = await valResp.json();
        return data?.valid === true;
    } catch {
        return false;
    }
}

/**
 * Initialize a DataCat session via cl-helper.
 * If a saved token is provided, tries to restore it first.
 * Otherwise (or if saved token is invalid), requests a fresh session.
 * Returns the active token string on success so the caller can persist it.
 * @param {string} [savedToken] - Previously saved session token to try first
 * @param {boolean} [force] - Force a new token even if one is cached
 * @returns {Promise<string|null>} The active session token, or null on failure
 */
export async function initDcSession(savedToken, force = false) {
    try {
        // Try restoring a saved token first (unless forcing refresh)
        if (savedToken && !force) {
            const restored = await restoreSavedToken(savedToken);
            if (restored) return savedToken;
        }

        const body = force ? JSON.stringify({ force: true }) : undefined;
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-init`, 'POST', force ? { force: true } : undefined)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-init`, {
                method: 'POST',
                ...(force ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
            });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.ok && data?.token) return data.token;
        return null;
    } catch {
        return null;
    }
}

/**
 * Validate the current DataCat session on cl-helper.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateDcSession() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!resp.ok) return { valid: false, reason: 'request failed' };
        return await resp.json();
    } catch {
        return { valid: false, reason: 'network error' };
    }
}

/**
 * Clear the DataCat session token from cl-helper.
 * @returns {Promise<boolean>}
 */
export async function clearDcSession() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-clear-token`, 'POST')
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-clear-token`, { method: 'POST' });
        return resp.ok;
    } catch {
        return false;
    }
}

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch full character data from the DataCat REST API.
 * @param {string} characterId - UUID
 * @returns {Promise<Object|null>} character object or null
 */
export async function fetchDatacatCharacter(characterId) {
    if (!characterId) return null;
    try {
        const response = await dcFetch(`/api/characters/${characterId}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.character || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCharacter failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch the V2-like download payload for a character.
 * @param {string} characterId - UUID
 * @returns {Promise<Object|null>} { data: { name, tags, avatar, ... } }
 */
export async function fetchDatacatDownload(characterId) {
    if (!characterId) return null;
    try {
        const response = await dcFetch(`/api/characters/${characterId}/download?t=${Date.now()}`);
        if (!response.ok) return null;
        return response.json();
    } catch (e) {
        console.error('[DataCat] fetchDatacatDownload failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch creator profile.
 * @param {string} creatorId - UUID
 * @returns {Promise<Object|null>}
 */
export async function fetchDatacatCreator(creatorId) {
    if (!creatorId) return null;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.creator || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreator failed:', creatorId, e);
        return null;
    }
}

/**
 * Fetch a creator's character list (paginated).
 * @param {string} creatorId - UUID
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sortBy='chat_count']
 * @returns {Promise<{total: number, list: Object[]}|null>}
 */
export async function fetchDatacatCreatorCharacters(creatorId, opts = {}) {
    if (!creatorId) return null;
    const { limit = 24, offset = 0, sortBy = 'chat_count' } = opts;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}/characters?limit=${limit}&offset=${offset}&sortBy=${sortBy}`);
        if (!response.ok) return null;
        const data = await response.json();
        return { total: data.total || 0, list: data.list || [] };
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreatorCharacters failed:', creatorId, e);
        return null;
    }
}

// ========================================
// BROWSE / SEARCH
// ========================================

/**
 * Fetch recent public characters (the main browse endpoint).
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {number[]} [opts.tagIds] - Active tag ID filters
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{totalCount: number, characters: Object[]}|null>}
 */
export async function fetchRecentPublic(opts = {}) {
    const { limit = 24, offset = 0, tagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/characters/recent-public?limit=${limit}&offset=${offset}&summary=1&minTotalTokens=${minTotalTokens}`;
        if (tagIds.length > 0) path += `&tagIds=${tagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { totalCount: data.totalCount || 0, characters: data.characters || [] };
    } catch (e) {
        console.error('[DataCat] fetchRecentPublic failed:', e);
        return null;
    }
}

/**
 * Fetch fresh/sorted characters from the /fresh endpoint.
 * Returns two time windows: last24h and thisWeek.
 * @param {Object} [opts]
 * @param {string} [opts.sortBy='score'] - 'score' | 'fresh' | 'chat_count'
 * @param {number} [opts.limit24=80] - Max characters for last-24h window
 * @param {number} [opts.limitWeek=20] - Max characters for this-week window
 * @returns {Promise<{sortBy: string, last24h: Object[], thisWeek: Object[]}|null>}
 */
export async function fetchFreshCharacters(opts = {}) {
    const { sortBy = 'score', limit24 = 80, limitWeek = 20 } = opts;
    try {
        const path = `/api/characters/fresh?summary=1&sortBy=${sortBy}&limit24=${limit24}&limitWeek=${limitWeek}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        const w = data.windows || {};
        return {
            sortBy: data.sortBy || sortBy,
            last24h: w.last24h?.characters || [],
            thisWeek: w.thisWeek?.characters || [],
        };
    } catch (e) {
        console.error('[DataCat] fetchFreshCharacters failed:', e);
        return null;
    }
}

/**
 * Fetch faceted tag list with counts (optionally narrowed by active tags).
 * @param {Object} [opts]
 * @param {number[]} [opts.activeTagIds] - Currently selected tag IDs (adjusts counts)
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{groups: Object[], tags: Object[]}|null>}
 */
export async function fetchFacetedTags(opts = {}) {
    const { activeTagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/tags/faceted?mode=recent&minTotalTokens=${minTotalTokens}`;
        if (activeTagIds.length > 0) path += `&activeTagIds=${activeTagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { groups: data.groups || [], tags: data.tags || [] };
    } catch (e) {
        console.error('[DataCat] fetchFacetedTags failed:', e);
        return null;
    }
}

// ========================================
// TAG HELPERS
// ========================================

/**
 * Extract plain tag names from DataCat tag objects.
 * DataCat tags have emoji prefixes (e.g. "👨 Male") — strip them for clean display.
 * @param {Array<{name: string, slug: string}>} tags
 * @returns {string[]}
 */
export function resolveTagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => {
        const name = t.name || t.slug || '';
        return name.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || name;
    });
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from DataCat character data.
 *
 * DataCat field mapping to V2 spec:
 *   character.description   → data.creator_notes (website blurb / creator's notes)
 *   character.personality   → data.description (main character definition)
 *   character.scenario      → data.scenario
 *   character.first_message → data.first_mes
 *   character.tags          → data.tags (array of tag name strings)
 *   character.creator_name  → data.creator
 *
 * @param {Object} character - Character object from /api/characters/:id
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildV2FromDatacat(character) {
    if (!character) return null;

    const rawDesc = character.description || '';
    const plainDesc = stripHtml(rawDesc) || '';
    const tagNames = resolveTagNames(character.tags);

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: character.chat_name || character.name || 'Unknown',
            description: character.personality || '',
            personality: '',
            scenario: character.scenario || '',
            first_mes: character.first_message || '',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: rawDesc,
            creator: character.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: [],
            extensions: {
                datacat: {
                    id: character.character_id,
                    creatorId: character.creator_id || null,
                    creatorName: character.creator_name || null
                }
            },
            character_book: undefined
        }
    };
}

/**
 * Build a V2 character card from the /download endpoint response.
 * The download format is already close to V2 but needs wrapping.
 * @param {Object} downloadData - Response from /api/characters/:id/download
 * @param {Object} [character] - Optional character metadata for enrichment
 * @returns {Object|null}
 */
export function buildV2FromDownload(downloadData, character) {
    const d = downloadData?.data;
    if (!d) return null;

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name || character?.chat_name || 'Unknown',
            description: d.personality || d.description || '',
            personality: '',
            scenario: d.scenario || '',
            first_mes: d.first_mes || '',
            mes_example: d.mes_example || '',
            system_prompt: d.system_prompt || '',
            post_history_instructions: d.post_history_instructions || '',
            creator_notes: character?.description || d.creator_notes || '',
            creator: character?.creator_name || d.creator || '',
            character_version: d.character_version || '1.0',
            tags: d.tags || [],
            alternate_greetings: d.alternate_greetings || [],
            extensions: {
                ...(d.extensions || {}),
                datacat: {
                    id: character?.character_id || null,
                    creatorId: character?.creator_id || null,
                    creatorName: character?.creator_name || null
                }
            },
            character_book: d.character_book || undefined
        }
    };
}

// ========================================
// EXTRACTION
// ========================================

/**
 * Submit a JanitorAI character URL for extraction via DataCat's cloud browser.
 * @param {string} janitorUrl - Full JanitorAI character URL
 * @returns {Promise<{success: boolean, queued?: boolean, started?: boolean, queuePosition?: number, error?: string, errorCode?: string}>}
 */
export async function submitExtraction(janitorUrl, { publicFeed = true } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            console.error('[DataCat] dc-extract returned non-JSON:', resp.status, text.substring(0, 200));
            return { success: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
    } catch (e) {
        console.error('[DataCat] submitExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Poll extraction status from DataCat.
 * @returns {Promise<{inProgress: Object|null, queueLength: number, queue: Array, history: Array}|null>}
 */
export async function fetchExtractionStatus() {
    try {
        const resp = await dcFetch('/api/extraction/status');
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('[DataCat] fetchExtractionStatus failed:', e);
        return null;
    }
}

// ========================================
// MEILISEARCH (JanitorAI index)
// ========================================

const MEILI_SORT_MAP = {
    janny_newest: ['createdAtStamp:desc'],
    janny_oldest: ['createdAtStamp:asc'],
    janny_tokens_desc: ['totalToken:desc'],
    janny_tokens_asc: ['totalToken:asc'],
    janny_relevant: [],
};

/**
 * Search JanitorAI characters via MeiliSearch.
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80]
 * @param {string} [opts.sort='janny_newest']
 * @param {boolean} [opts.nsfw=true]
 * @param {Set<number>} [opts.includeTags] - JanitorAI tag IDs to require
 * @returns {Promise<{characters: Object[], totalHits: number, totalPages: number}>}
 */
export async function searchMeiliJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'janny_newest', nsfw = true, includeTags = new Set() } = opts;

    const filters = [];
    if (!nsfw) filters.push('isNsfw = false');
    if (includeTags.size > 0) {
        const tagClauses = [...includeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    const sortArr = MEILI_SORT_MAP[sort] || MEILI_SORT_MAP.janny_newest;

    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isNsfw', 'tagIds'],
            filter: filters,
            hitsPerPage: limit,
            page,
        }]
    };

    if (sortArr.length > 0) body.queries[0].sort = sortArr;

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MeiliSearch error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    const result = data?.results?.[0] || {};
    const hits = result.hits || [];

    const characters = hits.map(normalizeMeiliHit);

    return {
        characters,
        totalHits: result.totalHits || 0,
        totalPages: result.totalPages || 0,
    };
}

// ========================================
// HAMPTER (JanitorAI internal API)
// ========================================

const HAMPTER_API_BASE = 'https://janitorai.com/hampter/characters';

/**
 * Fetch characters from JanitorAI's Hampter API (trending/popular sort).
 * @param {Object} opts
 * @param {string} [opts.sort='trending'] - 'trending' or 'popular'
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {boolean} [opts.nsfw=true] - false adds mode=sfw
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchHampterCharacters(opts = {}) {
    const { sort = 'trending', page = 1, search = '', nsfw = true } = opts;
    const params = new URLSearchParams({ sort, page: String(page) });
    if (search) params.set('search', search);
    if (!nsfw) params.set('mode', 'sfw');

    const url = `${HAMPTER_API_BASE}?${params}`;
    const response = await fetchWithProxy(url);
    const data = await response.json();

    return {
        characters: (data.data || []).map(normalizeHampterHit),
        total: data.total || 0,
        page: data.page || page,
        pageSize: data.size || 34,
    };
}

function normalizeHampterHit(hit) {
    const tagNames = [
        ...(hit.tags || []).map(t => ({ name: t.name, slug: t.slug || t.name?.toLowerCase() })),
        ...(hit.custom_tags || []).map(t => typeof t === 'string' ? { name: t, slug: t.toLowerCase() } : { name: t.name || '', slug: t.slug || '' }),
    ];

    return {
        character_id: hit.id,
        name: hit.name || 'Unknown',
        avatar: hit.avatar || '',
        description: hit.description || '',
        tags: tagNames,
        creator_name: hit.creator_name || '',
        creator_id: hit.creator_id || '',
        created_at: hit.created_at || hit.first_published_at || '',
        is_nsfw: hit.is_nsfw || false,
        chat_count: hit.stats?.chat || 0,
        message_count: hit.stats?.message || 0,
        total_tokens: hit.total_tokens || 0,
        _source: 'hampter',
    };
}

/**
 * Normalize a MeiliSearch hit to match the shape expected by DataCat card rendering.
 */
function normalizeMeiliHit(hit) {
    const tagNames = (hit.tagIds || []).map(id => {
        const name = JANNY_TAG_MAP[id];
        return name ? { name, slug: name.toLowerCase() } : { name: `Tag ${id}`, slug: `tag-${id}` };
    });

    return {
        character_id: hit.id,
        name: hit.name || 'Unknown',
        avatar: hit.avatar || '',
        description: hit.description || '',
        tags: tagNames,
        creator_name: hit.creatorUsername || '',
        creator_id: hit.creatorId || '',
        createdAt: hit.createdAt || (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toISOString() : ''),
        isNsfw: hit.isNsfw || false,
        totalTokens: hit.totalToken || 0,
        _source: 'meilisearch',
    };
}
