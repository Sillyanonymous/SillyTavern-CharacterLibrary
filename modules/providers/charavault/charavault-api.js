// CharaVault API utilities

// ========================================
// CONSTANTS & RUNTIME HELPERS
// ========================================

const CV_DEFAULT_API = 'https://charavault.net/api';
const CV_DEFAULT_CDN = 'https://charavault.net';

export function getCvApiBase() {
    const gw = (_getSetting?.('charavaultGatewayUrl') || '').trim().replace(/\/+$/, '');
    return gw || CV_DEFAULT_API;
}

export function getCvCdnBase() {
    const gw = (_getSetting?.('charavaultGatewayCdnUrl') || '').trim().replace(/\/+$/, '');
    return gw || CV_DEFAULT_CDN;
}

// ========================================
// INITIALIZATION
// ========================================

let _getSetting = null;
let _debugLog = null;

/**
 * Must be called once before any other export is used.
 * @param {{ getSetting: Function, debugLog: Function }} deps
 */
export function initCvApi(deps) {
    _getSetting = deps.getSetting;
    _debugLog = deps.debugLog;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

// ========================================
// HEADERS
// ========================================

export function getCvHeaders() {
    const headers = { 'Accept': 'application/json' };
    const gwKey = _getSetting?.('charavaultGatewayKey');
    if (gwKey) headers['Authorization'] = `Bearer ${gwKey}`;
    const appPw = _getSetting?.('charavaultAppPassword');
    if (appPw) headers['X-App-Password'] = appPw;
    return headers;
}

// ========================================
// URL HELPERS
// ========================================

/**
 * Build the thumbnail URL for a card via the cv-cdn route.
 * CharaVault serves pre-rendered thumbnails at /cards/thumb/{folder}/{filename}.
 * @param {string} folder
 * @param {string} file
 * @returns {string}
 */
export function cvThumbUrl(folder, file) {
    return `${getCvCdnBase()}/cards/thumb/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/**
 * Build the full PNG download URL for a card via the cv API route.
 * @param {string} folder
 * @param {string} file
 * @returns {string}
 */
export function cvDownloadUrl(folder, file) {
    return `${getCvApiBase()}/cards/download/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/**
 * Build a stable provider fullPath from folder + file.
 * Used as the canonical identifier stored in card extensions.
 * @param {string} folder
 * @param {string} file
 * @returns {string}  e.g. "cards/Adley_5412114.png"
 */
export function cvFullPath(folder, file) {
    return `${folder}/${file}`;
}

/**
 * Split a fullPath back into { folder, file }.
 * @param {string} fullPath
 * @returns {{ folder: string, file: string }}
 */
export function splitCvPath(fullPath) {
    const idx = fullPath.indexOf('/');
    if (idx < 0) return { folder: 'cards', file: fullPath };
    return { folder: fullPath.slice(0, idx), file: fullPath.slice(idx + 1) };
}

// ========================================
// METADATA CACHE
// ========================================

export const cvMetadataCache = new Map();
const CV_METADATA_CACHE_MAX = 10;
const CV_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ========================================
// CARD LIST FETCH
// ========================================

/**
 * Fetch a page of cards from the CharaVault browse API.
 * @param {Object} params
 * @param {string} [params.q]          - Search query
 * @param {string} [params.tags]       - Comma-separated tag filter
 * @param {string} [params.creator]    - Filter by creator username
 * @param {boolean|null} [params.nsfw] - true = include NSFW only; false = SFW only; null = all (omit param)
 * @param {boolean} [params.has_book]  - Filter to cards with lorebooks
 * @param {string} [params.sort]       - Sort mode
 * @param {number} [params.limit]      - Page size (default 48)
 * @param {number} [params.offset]     - Page offset
 * @returns {Promise<{total: number, results: Array}>}
 */
export async function fetchCvCards({
    q = '',
    tags = '',
    creator = '',
    nsfw = false,
    has_book = false,
    sort = 'most_downloaded',
    limit = 48,
    offset = 0,
} = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (tags) p.set('tags', tags);
    if (creator) p.set('creator', creator);
    if (nsfw !== null && nsfw !== undefined) p.set('nsfw', String(nsfw));
    if (has_book) p.set('has_book', 'true');
    p.set('sort', sort);
    p.set('limit', String(limit));
    p.set('offset', String(offset));

    const url = `${getCvApiBase()}/cards?${p}`;

    const resp = await fetch(url, { headers: getCvHeaders() });
    if (!resp.ok) throw new Error(`CharaVault API error: ${resp.status}`);
    return await resp.json();
}

// ========================================
// CARD DETAIL FETCH
// ========================================

/**
 * Fetch full metadata for a single card (with LRU cache).
 * Returns the card entry plus full_metadata containing the V2 card fields.
 * @param {string} fullPath - e.g. "cards/Adley_5412114.png"
 * @returns {Promise<Object|null>}
 */
export async function fetchCvCardDetail(fullPath) {
    const cached = cvMetadataCache.get(fullPath);
    if (cached && Date.now() - cached.time < CV_CACHE_TTL) {
        debugLog('[CharaVault] Using cached metadata for:', fullPath);
        return cached.value;
    }

    const { folder, file } = splitCvPath(fullPath);
    const url = `${getCvApiBase()}/cards/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;

    try {
        const resp = await fetch(url, { headers: getCvHeaders() });
        if (!resp.ok) {
            return null;
        }
        const data = await resp.json();
        const result = {
            entry: data.entry || null,
            fullMetadata: data.full_metadata || null,
        };

        while (cvMetadataCache.size >= CV_METADATA_CACHE_MAX) {
            const firstKey = cvMetadataCache.keys().next().value;
            cvMetadataCache.delete(firstKey);
        }
        cvMetadataCache.set(fullPath, { value: result, time: Date.now() });
        return result;
    } catch (e) {
        debugLog('[CharaVault] fetchCvCardDetail:', e.message);
        return null;
    }
}

// ========================================
// LIVE RATING FETCH (per-card)
// ========================================

/**
 * Fetch live rating for a single card. Cheaper than full detail and used
 * for the modal stat row.
 * @param {string} fullPath
 * @returns {Promise<{avg_rating:number, rating_count:number, user_rating:number|null}|null>}
 */
export async function fetchCvRating(fullPath) {
    const url = `${getCvApiBase()}/cards/rating?path=${encodeURIComponent(fullPath)}`;
    try {
        const resp = await fetch(url, { headers: getCvHeaders() });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        debugLog('[CharaVault] fetchCvRating error:', e.message);
        return null;
    }
}

// ========================================
// LINKED LOREBOOKS (per-card)
// ========================================

/**
 * Fetch lorebooks linked to a card. Returns { card_name, lorebooks: [...] }
 * or null on error. Always returns gracefully on 404 / network failure.
 * @param {string} fullPath
 * @returns {Promise<{card_name:string, lorebooks:Array}|null>}
 */
export async function fetchCvLinkedLorebooks(fullPath) {
    const { folder, file } = splitCvPath(fullPath);
    const url = `${getCvApiBase()}/cards/${encodeURIComponent(folder)}/${encodeURIComponent(file)}/lorebooks`;
    try {
        const resp = await fetch(url, { headers: getCvHeaders() });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        debugLog('[CharaVault] fetchCvLinkedLorebooks error:', e.message);
        return null;
    }
}

// ========================================
// SIMILAR CARDS (visual hash)
// ========================================

/**
 * Fetch visually similar cards (image-hash based).
 *
 * IMPORTANT: the `path` query parameter is the **server-side absolute path**
 * stored in entry.path (e.g. "/mnt/sde2/CharacterCards/..."), NOT our
 * canonical folder/file fullPath. The public docs are misleading: the form
 * "folder/file" gives 404 'Source card not found' for every card.
 *
 * The site UI also passes `threshold=20`. We mirror that.
 *
 * Returns an object so the caller can distinguish:
 *   - { ok: true, results: [...] }                       success
 *   - { ok: false, reason: 'no_path', results: [] }      caller passed no diskPath
 *   - { ok: false, reason: 'no_hash', results: [] }      404 "Source card not found"
 *   - { ok: false, reason: 'http', status, results: [] } any other non-2xx
 *   - { ok: false, reason: 'error', error, results: [] } network failure
 *
 * @param {string} diskPath - absolute server-side path from entry.path
 * @param {number} [limit=24]
 * @param {number} [threshold=20]
 * @returns {Promise<{ok:boolean, results:Array, reason?:string, status?:number, error?:string}>}
 */
export async function fetchCvSimilar(diskPath, threshold = 20) {
    if (!diskPath) {
        return { ok: false, reason: 'no_path', results: [] };
    }
    const p = new URLSearchParams({
        path: diskPath,
        threshold: String(threshold),
    });
    const url = `${getCvApiBase()}/cards/similar?${p}`;
    try {
        const resp = await fetch(url, { headers: getCvHeaders() });
        if (resp.status === 404) {
            return { ok: false, reason: 'no_hash', results: [] };
        }
        if (!resp.ok) {
            return { ok: false, reason: 'http', status: resp.status, results: [] };
        }
        const data = await resp.json();
        // Backend returns { source, similar_count, similar: [...] }.
        // Older deployments may have used { results: [...] } - handle both.
        const results = data.similar || data.results
            || (Array.isArray(data) ? data : []);
        return { ok: true, results };
    } catch (e) {
        debugLog('[CharaVault] fetchCvSimilar error:', e.message);
        return { ok: false, reason: 'error', error: e.message, results: [] };
    }
}

// ========================================
// TAGS FETCH
// ========================================

/**
 * Fetch popular tags from the public CV endpoint.
 * Returns an array of [tagName, count] pairs.
 * @returns {Promise<Array<[string, number]>>}
 */
export async function fetchCvTags() {
    try {
        const resp = await fetch(`${getCvApiBase()}/tags`, { headers: getCvHeaders() });
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data.tags) ? data.tags : [];
    } catch (e) {
        debugLog('[CharaVault] fetchCvTags:', e.message);
        return [];
    }
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from a CharaVault card detail response.
 *
 * CharaVault's full_metadata.data is already V2-compatible:
 *   data.description     -> V2 description  (character "personality" definition)
 *   data.personality     -> V2 personality
 *   data.first_mes       -> V2 first_mes
 *   data.mes_example     -> V2 mes_example
 *   data.creator_notes   -> V2 creator_notes
 *   data.system_prompt   -> V2 system_prompt
 *   data.post_history_instructions -> V2 post_history_instructions
 *   data.alternate_greetings       -> V2 alternate_greetings
 *   data.tags            -> V2 tags
 *   data.creator         -> V2 creator
 *
 * Note: detail-API entry lacks `has_lorebook` (only the search-list entry
 * carries it). Pass `searchEntry` (the original list-row) so we can
 * preserve that flag in the embedded extension metadata.
 *
 * @param {Object} detail  - Object returned by fetchCvCardDetail()
 * @param {string} fullPath - provider fullPath for the card
 * @param {Object} [searchEntry] - the original search-list row, if available
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildCvCharacterCard(detail, fullPath, searchEntry = null) {
    const entry = detail?.entry || {};
    const metaData = detail?.fullMetadata?.data || {};

    const tags = metaData.tags?.length ? metaData.tags : (entry.tags || []);
    const name = metaData.name || entry.name || fullPath.split('/').pop().replace(/\.png$/i, '');
    const creator = metaData.creator || entry.creator || '';

    // has_lorebook lives only in the search-list entry, not in the detail
    // entry. Prefer search row, fall back to detail just in case.
    const hasLorebook = (searchEntry?.has_lorebook ?? entry.has_lorebook) || false;

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: metaData.description || '',
            personality: metaData.personality || '',
            scenario: metaData.scenario || '',
            first_mes: metaData.first_mes || '',
            mes_example: metaData.mes_example || '',
            creator_notes: metaData.creator_notes || '',
            system_prompt: metaData.system_prompt || '',
            post_history_instructions: metaData.post_history_instructions || '',
            alternate_greetings: metaData.alternate_greetings || [],
            tags,
            creator,
            character_version: metaData.character_version || '',
            extensions: {
                ...(metaData.extensions || {}),
                charavault: {
                    full_path: fullPath,
                    content_hash: entry.content_hash || '',
                    avg_rating: entry.avg_rating || 0,
                    rating_count: entry.rating_count || 0,
                    download_count: entry.download_count || 0,
                    has_lorebook: hasLorebook,
                    card_style: entry.card_style || null,
                    recommended_tier: entry.recommended_tier ?? null,
                    linkedAt: new Date().toISOString(),
                },
            },
        },
    };
}
