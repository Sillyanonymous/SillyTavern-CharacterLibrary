// Shared ChubAI API utilities — used by chub-provider.js and chub-browse.js
//
// Contains constants, auth headers, metadata/lorebook/gallery fetch,
// the V2 card builder, and the metadata cache. Initialized once via
// initChubApi() which receives getSetting + debugLog from CoreAPI.

// ========================================
// CONSTANTS
// ========================================

export const CHUB_API_BASE = 'https://api.chub.ai';
export const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';
export const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars/';

// ========================================
// INITIALIZATION
// ========================================

let _getSetting = null;
let _debugLog = null;

/**
 * Must be called once before any other export is used.
 * Typically called from ChubProvider.init(coreAPI).
 * @param {{ getSetting: Function, debugLog: Function }} deps
 */
export function initChubApi(deps) {
    _getSetting = deps.getSetting;
    _debugLog = deps.debugLog;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

// ========================================
// NETWORK
// ========================================

/**
 * Build Chub API headers with optional Bearer token.
 * @param {boolean} includeAuth
 * @returns {Object}
 */
export function getChubHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const token = _getSetting?.('chubToken');
    if (includeAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

export { fetchWithProxy } from '../provider-utils.js';

// ========================================
// RESPONSE HELPERS
// ========================================

/**
 * Extract nodes from various Chub API response envelope formats.
 */
export function extractNodes(data) {
    if (data.nodes) return data.nodes;
    if (data.data?.nodes) return data.data.nodes;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
}

// ========================================
// METADATA CACHE
// ========================================

export const chubMetadataCache = new Map();
const CHUB_METADATA_CACHE_MAX = 3;
const CHUB_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch character metadata from the Chub REST API (with LRU cache).
 * Returns a stripped-down node object containing only fields used by
 * the import pipeline, card builder, and browse view.
 * @param {string} fullPath - e.g. "creator/slug"
 * @returns {Promise<Object|null>}
 */
export async function fetchChubMetadata(fullPath) {
    const cached = chubMetadataCache.get(fullPath);
    if (cached && Date.now() - cached.time < CHUB_CACHE_TTL) {
        debugLog('[Chub] Using cached metadata for:', fullPath);
        return cached.value;
    }

    try {
        const url = `${CHUB_API_BASE}/api/characters/${fullPath}?full=true`;
        debugLog('[Chub] Fetching metadata from:', url);

        let response;
        try {
            response = await fetch(url, { headers: getChubHeaders(true) });
        } catch (directError) {
            debugLog('[Chub] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
            response = await fetch(proxyUrl, { headers: getChubHeaders(true) });
        }

        if (!response.ok) {
            if (response.status === 404) {
                const text = await response.text();
                if (text.includes('CORS proxy is disabled')) {
                    console.error('[Chub] CORS blocked and proxy is disabled');
                    return null;
                }
            }
            return null;
        }

        const data = await response.json();
        const result = data.node || null;

        if (result) {
            const def = result.definition || {};
            const strippedResult = {
                id: result.id,
                name: result.name,
                fullPath: result.fullPath,
                topics: result.topics,
                tagline: result.tagline,
                avatar_url: result.avatar_url,
                max_res_url: result.max_res_url,
                hasGallery: result.hasGallery,
                creator: result.creator,
                definition: {
                    name: def.name,
                    personality: def.personality,
                    tavern_personality: def.tavern_personality,
                    first_message: def.first_message,
                    example_dialogs: def.example_dialogs,
                    description: def.description,
                    scenario: def.scenario,
                    system_prompt: def.system_prompt,
                    post_history_instructions: def.post_history_instructions,
                    alternate_greetings: def.alternate_greetings,
                    extensions: def.extensions,
                    character_version: def.character_version,
                    tagline: def.tagline,
                    embedded_lorebook: def.embedded_lorebook,
                },
                related_lorebooks: result.related_lorebooks || [],
                lastActivityAt: result.lastActivityAt || result.last_activity_at || null,
                createdAt: result.createdAt || result.created_at || null,
                starCount: result.starCount || result.star_count || 0,
                rating: result.rating || 0,
                nTokens: result.nTokens || result.n_tokens || 0,
            };

            while (chubMetadataCache.size >= CHUB_METADATA_CACHE_MAX) {
                const firstKey = chubMetadataCache.keys().next().value;
                chubMetadataCache.delete(firstKey);
            }
            chubMetadataCache.set(fullPath, { value: strippedResult, time: Date.now() });
            return strippedResult;
        }

        return result;
    } catch (error) {
        return null;
    }
}

// ========================================
// LOREBOOK FETCH
// ========================================

/**
 * Fetch a linked (non-embedded) lorebook via the V4 Git API.
 * Chub characters can have lorebooks in separate projects that are
 * only resolved in the exported card.json.
 * @param {number} projectId - Chub project/character numeric ID
 * @returns {Promise<Object|null>} character_book object or null
 */
export async function fetchChubLinkedLorebook(projectId) {
    if (!projectId) return null;
    const headers = getChubHeaders(true);
    try {
        const commitsUrl = `${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/commits`;
        let commitsResp;
        try {
            commitsResp = await fetch(commitsUrl, { headers });
            if (!commitsResp.ok) throw new Error(`HTTP ${commitsResp.status}`);
        } catch (_) {
            commitsResp = await fetch(`/proxy/${encodeURIComponent(commitsUrl)}`, { headers });
            if (!commitsResp.ok) return null;
        }
        const commits = await commitsResp.json();
        const ref = Array.isArray(commits) && commits[0]?.id;
        if (!ref) return null;

        const cardUrl = `${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`;
        let cardResp;
        try {
            cardResp = await fetch(cardUrl, { headers });
            if (!cardResp.ok) throw new Error(`HTTP ${cardResp.status}`);
        } catch (_) {
            cardResp = await fetch(`/proxy/${encodeURIComponent(cardUrl)}`, { headers });
            if (!cardResp.ok) return null;
        }
        const card = await cardResp.json();
        const book = card?.data?.character_book || card?.character_book || null;
        if (book) {
            debugLog('[Chub] Resolved linked lorebook from V4 Git API for project', projectId, `— ${book.entries?.length ?? 0} entries`);
        }
        return book;
    } catch (e) {
        console.error('[Chub] fetchChubLinkedLorebook failed for project', projectId, e);
        return null;
    }
}

// ========================================
// GALLERY FETCH
// ========================================

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from Chub API metadata.
 *
 * The Chub API uses its OWN field names that differ from the V2 spec.
 * This mapping matches SillyTavern's downloadChubCharacter() in
 * src/endpoints/content-manager.js:
 *
 *   definition.personality           → data.description
 *   definition.tavern_personality    → data.personality
 *   definition.first_message         → data.first_mes
 *   definition.example_dialogs       → data.mes_example
 *   definition.description           → data.creator_notes
 *   definition.embedded_lorebook     → data.character_book
 *   metadata.topics                  → data.tags
 *
 * Resolves linked lorebooks (separate Chub projects) via the V4 Git API
 * when related_lorebooks is present.
 *
 * @param {Object} apiData - Metadata object from fetchChubMetadata()
 * @returns {Promise<Object>} V2-spec character card { spec, spec_version, data }
 */
export async function buildCharacterCardFromChub(apiData) {
    const def = apiData.definition || {};

    let characterBook = def.embedded_lorebook || undefined;
    if (apiData.related_lorebooks?.length > 0 && apiData.id) {
        try {
            debugLog('[Chub] Resolving linked lorebook for import via V4 Git API');
            const linked = await fetchChubLinkedLorebook(apiData.id);
            if (linked?.entries?.length > 0) characterBook = linked;
        } catch (e) {
            console.warn('[Chub] Failed to fetch linked lorebook for', apiData.fullPath, e);
        }
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || apiData.name || 'Unknown',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            creator_notes: def.description || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            alternate_greetings: def.alternate_greetings || [],
            tags: apiData.topics || [],
            creator: apiData.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: apiData.tagline || def.tagline || ''
                }
            },
            character_book: characterBook,
        }
    };
}
