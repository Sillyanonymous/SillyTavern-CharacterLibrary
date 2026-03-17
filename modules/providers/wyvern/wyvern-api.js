// Shared Wyvern API utilities — used by wyvern-provider.js and wyvern-browse.js
//
// Contains constants, auth headers, metadata fetch, the V2 card builder,
// and the metadata cache. Initialized once via initWyvernApi() which
// receives getSetting + debugLog from CoreAPI.

// ========================================
// CONSTANTS
// ========================================

export const WYVERN_API_BASE = 'https://api.wyvern.chat';
export const WYVERN_SITE_BASE = 'https://app.wyvern.chat';
export const WYVERN_IMAGE_BASE = 'https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/';

const FIREBASE_API_KEY = 'AIzaSyCqumrbjUy-EoMpfN4Ev0ppnqjkdpnOTTw';
const FIREBASE_SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

// Sort options accepted by /exploreSearch/characters
const WYVERN_SORT_OPTIONS = {
    popular: 'Popular',
    'nsfw-popular': 'Popular NSFW',
    recommended: 'Recommended',
    created_at: 'New',
    votes: 'Most Likes',
    messages: 'Most Messages',
};

// ========================================
// INITIALIZATION
// ========================================

let _getSetting = null;
let _debugLog = null;

/**
 * Must be called once before any other export is used.
 * Typically called from WyvernProvider.init(coreAPI).
 * @param {{ getSetting: Function, debugLog: Function }} deps
 */
export function initWyvernApi(deps) {
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
 * Build Wyvern API headers with optional Bearer token.
 * @param {boolean} includeAuth
 * @returns {Object}
 */
export function getWyvernHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const token = _getSetting?.('wyvernToken');
    if (includeAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

export { fetchWithProxy } from '../provider-utils.js';

// ========================================
// FIREBASE AUTH
// ========================================

/**
 * Sign in with email/password via Firebase Identity Toolkit.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{idToken: string, refreshToken: string, expiresIn: string}>}
 */
export async function firebaseSignIn(email, password) {
    const response = await fetch(FIREBASE_SIGN_IN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const data = await response.json();
    if (!response.ok) {
        const msg = data?.error?.message || 'Authentication failed';
        throw new Error(msg.replace(/_/g, ' ').toLowerCase());
    }
    return data;
}

/**
 * Refresh an expired Firebase ID token.
 * @param {string} refreshToken
 * @returns {Promise<{id_token: string, refresh_token: string, expires_in: string}>}
 */
export async function firebaseRefreshToken(refreshToken) {
    const response = await fetch(FIREBASE_REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data?.error?.message || 'Token refresh failed');
    }
    return data;
}

/**
 * Decode a Firebase JWT and return seconds until expiry.
 * @param {string} token - Firebase ID token (JWT)
 * @returns {number} seconds remaining, or 0 if expired/invalid
 */
export function getTokenTTL(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const exp = payload.exp;
        if (!exp) return 0;
        return Math.max(0, exp - Math.floor(Date.now() / 1000));
    } catch {
        return 0;
    }
}

// ========================================
// METADATA CACHE
// ========================================

export const wyvernMetadataCache = new Map();
const WYVERN_METADATA_CACHE_MAX = 3;
const WYVERN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch character metadata from the Wyvern REST API (with LRU cache).
 * @param {string} charId - Wyvern character nanoid (e.g. "_LbhnWCqY3xnBnpaAa8qYt")
 * @returns {Promise<Object|null>}
 */
export async function fetchWyvernMetadata(charId) {
    const cached = wyvernMetadataCache.get(charId);
    if (cached && Date.now() - cached.time < WYVERN_CACHE_TTL) {
        debugLog('[Wyvern] Using cached metadata for:', charId);
        return cached.value;
    }

    try {
        const url = `${WYVERN_API_BASE}/characters/${charId}`;
        debugLog('[Wyvern] Fetching metadata from:', url);

        const { fetchWithProxy: fwp } = await import('../provider-utils.js');
        const response = await fwp(url, { headers: getWyvernHeaders(true) });

        const result = await response.json();
        if (!result) return null;

        while (wyvernMetadataCache.size >= WYVERN_METADATA_CACHE_MAX) {
            const firstKey = wyvernMetadataCache.keys().next().value;
            wyvernMetadataCache.delete(firstKey);
        }
        wyvernMetadataCache.set(charId, { value: result, time: Date.now() });
        return result;
    } catch (error) {
        return null;
    }
}

// ========================================
// URL HELPERS
// ========================================

/**
 * Build an avatar URL from a Wyvern character's avatar field.
 * The avatar field is already a full imagedelivery.net CDN URL.
 * @param {Object} char - Wyvern character object
 * @returns {string}
 */
export function getAvatarUrl(char) {
    const src = char.avatar_url || char.avatar;
    if (src && src.startsWith('http')) return src;
    if (src) return `${WYVERN_IMAGE_BASE}${src}/public`;
    return '/img/ai4.png';
}

/**
 * Build the public URL for a character on Wyvern.
 * @param {string} charId
 * @returns {string}
 */
export function getCharacterPageUrl(charId) {
    return `${WYVERN_SITE_BASE}/characters/${charId}`;
}

/**
 * Parse a Wyvern URL and extract the character ID.
 * Matches: app.wyvern.chat/characters/{id}
 * @param {string} url
 * @returns {string|null} character ID or null
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?app\.wyvern\.chat$/i.test(u.hostname)) return null;
        const match = u.pathname.match(/^\/characters\/([^/]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from Wyvern API metadata.
 *
 * @param {Object} apiData - Character object from the Wyvern API
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildCharacterCardFromWyvern(apiData) {
    const creatorName = apiData.creator?.displayName || apiData.creator?.username || '';
    const tags = Array.isArray(apiData.tags) ? apiData.tags : [];

    // shared_info is supplementary character context — append to description
    let description = apiData.description || '';
    if (apiData.shared_info) {
        description = description
            ? description + '\n\n---\n\n' + apiData.shared_info
            : apiData.shared_info;
    }

    // character_note → depth_prompt (ST's "Character Note" injected at depth)
    let depthPrompt;
    if (apiData.character_note) {
        depthPrompt = { prompt: apiData.character_note, depth: 4, role: 'system' };
    }

    // lorebooks → character_book (V2 format — Wyvern entries are nearly 1:1)
    const characterBook = convertWyvernLorebook(apiData.lorebooks);

    const wyvernExt = {
        id: apiData.id || null,
        tagline: apiData.tagline || '',
        linkedAt: new Date().toISOString()
    };
    if (apiData.visual_description) {
        wyvernExt.visual_description = apiData.visual_description;
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: apiData.name || 'Unknown',
            description,
            personality: apiData.personality || '',
            scenario: apiData.scenario || '',
            first_mes: apiData.first_mes || '',
            mes_example: apiData.mes_example || '',
            creator_notes: apiData.creator_notes || '',
            system_prompt: apiData.pre_history_instructions || '',
            post_history_instructions: apiData.post_history_instructions || '',
            alternate_greetings: apiData.alternate_greetings || [],
            tags: tags,
            creator: creatorName,
            character_version: '',
            extensions: {
                wyvern: wyvernExt,
                ...(depthPrompt && { depth_prompt: depthPrompt }),
            },
            character_book: characterBook,
        }
    };
}

/**
 * Convert Wyvern lorebook(s) to V2 character_book format.
 * Takes the first lorebook if multiple exist (V2 only supports one).
 * @param {Array|null} lorebooks
 * @returns {Object|undefined}
 */
function convertWyvernLorebook(lorebooks) {
    if (!Array.isArray(lorebooks) || lorebooks.length === 0) return undefined;
    const lb = lorebooks[0];
    const entriesArray = Array.isArray(lb.entries) ? lb.entries
        : (lb.entries && typeof lb.entries === 'object') ? Object.values(lb.entries)
        : [];
    if (entriesArray.length === 0) return undefined;

    return {
        name: lb.name || '',
        description: lb.description || '',
        scan_depth: Number(lb.scan_depth) || 2,
        token_budget: Number(lb.token_budget) || 500,
        recursive_scanning: !!lb.recursive_scanning,
        extensions: lb.extensions || {},
        entries: entriesArray.map((e, i) => ({
            id: Number(e.entry_id) || i,
            keys: Array.isArray(e.keys) ? e.keys : [],
            secondary_keys: Array.isArray(e.secondary_keys) ? e.secondary_keys : [],
            content: e.content || '',
            comment: e.comment || e.name || '',
            enabled: e.enabled !== false,
            selective: !!e.selective,
            constant: !!e.constant,
            case_sensitive: !!e.case_sensitive,
            insertion_order: Number(e.insertion_order) || 100,
            priority: Number(e.priority) || 10,
            position: e.position === 'after_char' ? 'after_char' : 'before_char',
            extensions: e.extensions || {},
        }))
    };
}
