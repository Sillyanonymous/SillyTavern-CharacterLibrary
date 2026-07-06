// Shared DataCat API utilities - used by datacat-provider.js and datacat-browse.js
//
// Sections: Network, Metadata, Browse/Search, Tags, V2 Card Builder, Extraction, MeiliSearch

import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml, fetchWithProxy } from '../provider-utils.js';
import { getSearchToken, JANNY_SEARCH_URL, JANNY_SITE_BASE, TAG_MAP as JANNY_TAG_MAP } from '../janny/janny-api.js';
import { resolveSaucepanImageUrl, SAUCEPAN_CDN_PROXY_BASE } from './saucepan-api.js';

export { slugify, stripHtml, JANNY_TAG_MAP };

/**
 * Decode common HTML entities. JanitorAI's listing endpoints (Meili + Hampter)
 * return creator-notes HTML escaped (&lt;p&gt;...&lt;/p&gt;) rather than raw,
 * so consumers expecting real HTML must decode first.
 */
function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

// ========================================
// CONSTANTS
// ========================================

export const DATACAT_API_BASE = 'https://datacat.run';

// DataCat aggregates from multiple sources. Each has its own avatar URL convention:
//   - JanitorAI: bare filename, served from ella.janitorai.com
//   - Saucepan: full https URL (saucepan.ai/cdn/...) embedded in the avatar field
// Future sources should be added here. Use resolveDatacatAvatarUrl() to get a usable URL.
export const DATACAT_JANITOR_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

/**
 * Resolve a character's avatar URL based on its source.
 * Saucepan and other future sources embed full URLs in the avatar field;
 * JanitorAI uses bare filenames that need the ella.janitorai.com prefix.
 * @param {Object} hit - DataCat character object (listing or detail)
 * @returns {string|null} Full URL (or local proxy path) or null if no avatar
 */
export function resolveDatacatAvatarUrl(hit) {
    const avatar = hit?.avatar;
    if (!avatar || typeof avatar !== 'string') return null;
    const proxied = resolveSaucepanImageUrl(avatar);
    // Covers freshly rewritten URLs and already-proxied paths alike.
    if (proxied.startsWith(SAUCEPAN_CDN_PROXY_BASE)) return proxied;
    const url = /^https?:\/\//i.test(avatar) ? avatar : `${DATACAT_JANITOR_IMAGE_BASE}${avatar}`;
    const safety = window.isUrlSafeForDownload?.(url);
    if (safety && !safety.ok) return null;
    return url;
}

// Minimum token threshold for quality filtering (matches DataCat's own frontend default)
export const MIN_TOTAL_TOKENS = 889;

// ========================================
// NETWORK
// ========================================

const DC_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/dc-proxy`;

let _apiRequest = null;
let _getSavedToken = null;
let _bootstrapInFlight = null;

/**
 * Bind the CoreAPI.apiRequest function for use in proxied requests.
 * Called once from the provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter that returns the persisted DataCat session token (or null).
 * Lets dcFetch lazy-bootstrap a session for out-of-browse-view callers
 * (link modal preview, gallery download, gallery-sync) without coupling
 * the api file to CoreAPI/settings directly. Called once from init().
 */
export function setSavedTokenGetter(fn) { _getSavedToken = fn; }

/**
 * Push the saved token (or a fresh anonymous one) into cl-helper. Returns
 * true if a usable session is now active. Concurrent callers share the
 * in-flight bootstrap promise so we never run more than one /dc-init at
 * a time. Reset on completion so a future 401 can re-arm.
 */
async function tryBootstrapSession() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try {
            const savedToken = _getSavedToken?.() ?? null;
            return !!(await initDcSession(savedToken));
        } catch {
            return false;
        } finally {
            _bootstrapInFlight = null;
        }
    })();
    return _bootstrapInFlight;
}

/**
 * Fetch a DataCat API path through the cl-helper plugin proxy.
 * On 401/403, attempts to bootstrap a session once and retries.
 * @param {string} apiPath - Path relative to datacat.run (e.g. /api/characters/recent-public?...)
 * @returns {Promise<Response>}
 */
async function dcFetch(apiPath) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound (cl-helper required)');
    let resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
    if (resp.status === 401 || resp.status === 403) {
        if (await tryBootstrapSession()) {
            resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
        }
    }
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
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint; required for freshly-extracted chars
 * @returns {Promise<Object|null>} character object or null
 */
export async function fetchDatacatCharacter(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const qs = sourceKind ? `?sourceKind=${encodeURIComponent(sourceKind)}` : '';
        const response = await dcFetch(`/api/characters/${characterId}${qs}`);
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
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint
 * @returns {Promise<Object|null>} { data: { name, tags, avatar, ... } }
 */
export async function fetchDatacatDownload(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const params = new URLSearchParams({ t: String(Date.now()) });
        if (sourceKind) params.set('sourceKind', sourceKind);
        const response = await dcFetch(`/api/characters/${characterId}/download?${params.toString()}`);
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
 * Extract plain tag names from DataCat tags.
 * Tags shape varies by source:
 *   - JanitorAI: array of { id, name, slug } objects with emoji-prefixed names
 *   - Saucepan: array of plain slug strings
 * @param {Array<{name: string, slug: string}|string>} tags
 * @returns {string[]}
 */
export function resolveTagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => {
        if (typeof t === 'string') return t.trim();
        const name = t?.name || t?.slug || '';
        return name.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || name;
    }).filter(Boolean);
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Pick the active server-side recovery variant from a DataCat character row.
 *
 * For Saucepan characters with hidden definitions, DataCat runs a server-side
 * "Character Repair" job and exposes the recovered body via
 * `content_variants[primary].content`. The variant's `description` field is
 * overloaded to carry the repaired body text; the row's top-level fields
 * (`personality`, `description`) remain the empty original / short blurb.
 *
 * @returns {Object|null} The variant content object, or null when no
 *   non-placeholder primary variant is present.
 */
export function pickRecoveryVariant(character) {
    const variants = character?.content_variants;
    if (!Array.isArray(variants) || !variants.length) return null;
    const primary = variants.find(v => v && v.isPrimary && !v.isRecoveryPlaceholder);
    return primary?.content || null;
}

// Extract V2 character_book from character.scripts[]. DataCat stores lorebook
// entries JSON-encoded in script.script; private scripts are metadata stubs.
// Multi-script merge: first script's title/settings win, entries concatenate.
export function extractCharacterBookFromScripts(character) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts) || !scripts.length) return null;
    const usable = scripts.filter(s => s && s.type === 'lorebook' && s.is_public && s.script);
    if (!usable.length) return null;

    const allEntries = [];
    for (const s of usable) {
        let parsed;
        try { parsed = JSON.parse(s.script); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        for (const e of parsed) {
            if (!e || typeof e !== 'object') continue;
            const keys = Array.isArray(e.key)
                ? e.key
                : (e.keysRaw ? String(e.keysRaw).split(/,\s*/).filter(Boolean) : []);
            allEntries.push({
                keys,
                secondary_keys: [],
                content: e.content || '',
                extensions: {},
                enabled: e.enabled !== false,
                insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : (e.priority || 100),
                case_sensitive: false,
                name: e.name || '',
                priority: typeof e.priority === 'number' ? e.priority : 10,
                id: e.id ?? allEntries.length,
                comment: '',
                selective: false,
                constant: e.constant === true,
                position: 'before_char',
            });
        }
    }
    if (!allEntries.length) return null;

    const first = usable[0];
    let scanDepth = 4;
    try {
        const settings = first.settings ? JSON.parse(first.settings) : null;
        if (settings && typeof settings.depth === 'number') scanDepth = settings.depth;
    } catch { /* default */ }

    return {
        name: first.title || 'Lorebook',
        description: first.description || '',
        scan_depth: scanDepth,
        token_budget: 0,
        recursive_scanning: false,
        extensions: {},
        entries: allEntries,
    };
}

/**
 * Build a V2 character card from the character endpoint payload.
 *
 * Field mapping is source-dependent. DataCat aggregates multiple sources, each
 * with different conventions for which field carries the character's body:
 *
 *   JanitorAI (default):
 *     character.personality   -> data.description (main character definition)
 *     character.description   -> data.creator_notes (website blurb)
 *
 *   Saucepan (open definition):
 *     character.description   -> data.description (main character definition)
 *     character.personality   -> usually null
 *     companion_snapshot.full_description
 *       (or chara_card_v2_json.data.creator_notes)
 *                             -> data.creator_notes (formatted blurb/notes)
 *
 *   Saucepan (hidden definition):
 *     `content_variants[primary].content` carries the repaired body via
 *     the `description` field. /download returns empty in this case.
 *     The blurb still lives in `companion_snapshot.full_description`.
 *
 *   Common across sources:
 *     character.scenario      -> data.scenario
 *     character.first_message -> data.first_mes
 *     character.tags          -> data.tags (array of tag name strings)
 *     character.creator_name  -> data.creator
 *
 * @param {Object} character - Character object from /api/characters/:id
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildV2FromDatacat(character) {
    if (!character) return null;

    const tagNames = resolveTagNames(character.tags);
    const recovered = pickRecoveryVariant(character);
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;

    // Recovery variant takes precedence: for Saucepan-with-repair items, this
    // is the only source of the body text. Otherwise body source differs by
    // row kind: JanitorAI puts the body in `personality`; Saucepan puts it
    // in `description` (open definition) and exposes a correctly-mapped V2
    // in `chara_card_v2_json.data`.
    const description = recovered?.description
        || recovered?.personality
        || (isSaucepan ? (v2Data?.description || character.description || '') : (character.personality || ''));
    const scenario = recovered?.scenario || character.scenario || (isSaucepan ? (v2Data?.scenario || '') : '');
    const firstMessage = recovered?.first_message || character.first_message || (isSaucepan ? (v2Data?.first_mes || '') : '');
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || '')
        : (character.description || '');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: character.chat_name || character.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMessage,
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: creatorNotes,
            creator: character.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: [],
            extensions: {
                datacat: {
                    id: character.character_id,
                    sourceKind: character.primary_content_source_kind || null,
                    creatorId: character.creator_id || null,
                    creatorName: character.creator_name || null
                }
            },
            character_book: extractCharacterBookFromScripts(character) || undefined
        }
    };
}

/**
 * Build a V2 character card from the /download endpoint response.
 * The download format is already close to V2 but needs wrapping.
 *
 * For Saucepan-with-hidden-definition cards, /download returns empty body
 * fields. When a `character` object is supplied and contains an active
 * recovery variant (`content_variants[primary].content`), we fall back to it
 * for description, scenario, and first_mes. This keeps imports and update
 * checks working for repaired Saucepan cards.
 *
 * @param {Object} downloadData - Response from /api/characters/:id/download
 * @param {Object} [character] - Optional character metadata for enrichment
 * @returns {Object|null}
 */
export function buildV2FromDownload(downloadData, character) {
    const d = downloadData?.data;
    if (!d) return null;

    const recovered = character ? pickRecoveryVariant(character) : null;
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;
    const description = d.personality || d.description
        || recovered?.description || recovered?.personality
        || (isSaucepan ? (v2Data?.description || character?.description || '') : '');
    const scenario = d.scenario || recovered?.scenario || '';
    const firstMes = d.first_mes || recovered?.first_message || '';
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || d.creator_notes
            || '')
        : (character?.description || d.creator_notes || '');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name || character?.chat_name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMes,
            mes_example: d.mes_example || '',
            system_prompt: d.system_prompt || '',
            post_history_instructions: d.post_history_instructions || '',
            creator_notes: creatorNotes,
            creator: character?.creator_name || d.creator || '',
            character_version: d.character_version || '1.0',
            tags: d.tags || [],
            alternate_greetings: d.alternate_greetings || [],
            extensions: {
                ...(d.extensions || {}),
                datacat: {
                    id: character?.character_id || null,
                    sourceKind: character?.primary_content_source_kind || null,
                    creatorId: character?.creator_id || null,
                    creatorName: character?.creator_name || null
                }
            },
            // Download's character_book is often present-but-empty; fall through to scripts.
            character_book: (d.character_book?.entries?.length ? d.character_book : null)
                || extractCharacterBookFromScripts(character)
                || undefined
        }
    };
}

// ========================================
// EXTRACTION
// ========================================

/**
 * Submit a JanitorAI character URL for extraction via DataCat's cloud browser.
 * @param {string} janitorUrl - Full JanitorAI character URL
 * @param {Object} [opts]
 * @param {boolean} [opts.publicFeed=true]
 * @param {boolean} [opts.alwaysReextract=false] - force re-extraction even if DataCat already has the character
 * @returns {Promise<{success: boolean, queued?: boolean, started?: boolean, queuePosition?: number, requestId?: string, error?: string, errorCode?: string}>}
 */
export async function submitExtraction(janitorUrl, { publicFeed = true, alwaysReextract = false } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed, alwaysReextract });
        if (!resp.ok) {
            const errText = await resp.text();
            console.error('[DataCat] dc-extract error:', resp.status, errText.substring(0, 200));
            return { success: false, error: `Server returned ${resp.status}: ${errText.substring(0, 100)}` };
        }
        try {
            return await resp.json();
        } catch {
            return { success: false, error: 'Invalid JSON response from cl-helper' };
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
        const resp = await dcFetch('/api/extraction/status-projection');
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
const FLARESOLVERR_FETCH_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-fetch`;
const FLARESOLVERR_SESSION_CREATE_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-create`;
const FLARESOLVERR_SESSION_DESTROY_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-destroy`;

/**
 * Create a FlareSolverr session. Sessions keep a Chromium instance hot, so
 * subsequent fetches reuse the cached cf_clearance cookie and skip the
 * challenge - dropping each request from ~5-15s to ~1-3s.
 * @param {string} flareUrl
 * @returns {Promise<string>} the created session ID
 */
export async function createFlareSolverrSession(flareUrl) {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const resp = await _apiRequest(FLARESOLVERR_SESSION_CREATE_PATH, 'POST', { flareUrl });
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok || payload?.status !== 'ok' || !payload?.session) {
        throw new Error(payload?.error || payload?.message || 'Failed to create FlareSolverr session');
    }
    return payload.session;
}

/**
 * Destroy a FlareSolverr session. Best-effort; does not throw on failure.
 * @param {string} flareUrl
 * @param {string} sessionId
 */
export async function destroyFlareSolverrSession(flareUrl, sessionId) {
    if (!_apiRequest || !sessionId) return;
    try {
        await _apiRequest(FLARESOLVERR_SESSION_DESTROY_PATH, 'POST', { flareUrl, sessionId });
    } catch (err) {
        console.warn('[DatacatAPI] FlareSolverr session destroy failed:', err.message);
    }
}

/**
 * Fetch a URL via the user's configured FlareSolverr instance through cl-helper.
 * Returns the response body as text on success, or throws on failure.
 * @param {string} flareUrl - User-configured FlareSolverr endpoint (e.g. http://localhost:8191/v1)
 * @param {string} targetUrl - Target URL to fetch through FlareSolverr
 * @param {string} [sessionId] - Optional session ID to reuse a hot Chromium instance
 * @returns {Promise<string>}
 */
async function fetchViaFlareSolverr(flareUrl, targetUrl, sessionId = '') {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const body = { flareUrl, targetUrl };
    if (sessionId) body.sessionId = sessionId;
    const resp = await _apiRequest(FLARESOLVERR_FETCH_PATH, 'POST', body);
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok) {
        const msg = payload?.error || `FlareSolverr request failed (HTTP ${resp.status})`;
        const err = new Error(msg);
        if (payload?.message && /session/i.test(payload.message)) err.sessionInvalid = true;
        throw err;
    }
    if (payload?.status !== 'ok' || !payload?.solution) {
        const msg = payload?.message || 'FlareSolverr did not return a solution';
        const err = new Error(msg);
        if (msg && /session/i.test(msg)) err.sessionInvalid = true;
        throw err;
    }
    const upstreamStatus = payload.solution.status;
    if (typeof upstreamStatus === 'number' && upstreamStatus >= 400) {
        const err = new Error(`Upstream HTTP ${upstreamStatus}`);
        err.status = upstreamStatus;
        throw err;
    }
    return payload.solution.response || '';
}

/**
 * Fetch characters from JanitorAI's Hampter API (trending/popular sort).
 * @param {Object} opts
 * @param {string} [opts.sort='trending'] - 'trending' or 'popular'
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {boolean} [opts.nsfw=true] - false adds mode=sfw
 * @param {string} [opts.flareSolverrUrl] - When set, route the request through this FlareSolverr instance
 * @param {string} [opts.flareSessionId] - Reuse this FlareSolverr session for hot-Chromium speedup
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchHampterCharacters(opts = {}) {
    const { sort = 'trending', page = 1, search = '', nsfw = true, flareSolverrUrl = '', flareSessionId = '' } = opts;
    const params = new URLSearchParams({ sort, page: String(page) });
    if (search) params.set('search', search);
    if (!nsfw) params.set('mode', 'sfw');

    const url = `${HAMPTER_API_BASE}?${params}`;
    let data;

    if (flareSolverrUrl) {
        try {
            const text = await fetchViaFlareSolverr(flareSolverrUrl, url, flareSessionId);
            // FlareSolverr wraps JSON responses in HTML <pre> tags. Strip them.
            const cleaned = text.replace(/^[\s\S]*?<pre[^>]*>/i, '').replace(/<\/pre>[\s\S]*$/i, '').trim();
            try {
                data = JSON.parse(cleaned || text);
            } catch {
                throw new Error('FlareSolverr returned non-JSON body');
            }
        } catch (err) {
            if (err.status === 401 || err.status === 403) {
                const blocked = new Error(`Hampter HTTP ${err.status}`);
                blocked.code = 'HAMPTER_BLOCKED';
                blocked.status = err.status;
                throw blocked;
            }
            const wrapped = new Error(`FlareSolverr: ${err.message}`);
            wrapped.code = 'FLARESOLVERR_ERROR';
            if (err.sessionInvalid) wrapped.sessionInvalid = true;
            throw wrapped;
        }
    } else {
        let response;
        try {
            response = await fetchWithProxy(url);
        } catch (err) {
            const m = /HTTP (\d+)/.exec(err?.message || '');
            const status = m ? parseInt(m[1], 10) : 0;
            if (status === 401 || status === 403) {
                const blocked = new Error(`Hampter HTTP ${status}`);
                blocked.code = 'HAMPTER_BLOCKED';
                blocked.status = status;
                throw blocked;
            }
            throw err;
        }
        data = await response.json();
    }

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
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creator_name || ''),
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
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creatorUsername || ''),
        creator_id: hit.creatorId || '',
        createdAt: hit.createdAt || (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toISOString() : ''),
        isNsfw: hit.isNsfw || false,
        totalTokens: hit.totalToken || 0,
        _source: 'meilisearch',
    };
}
