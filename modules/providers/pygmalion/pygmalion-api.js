// Pygmalion API utilities — used by both pygmalion-provider.js and pygmalion-browse.js
//
// Connect RPC protocol over HTTPS to server.pygmalion.chat.
// Public endpoints — no auth required for character search/detail.
// Authenticated endpoints — require Bearer token for follow/user operations.

// ========================================
// CONSTANTS
// ========================================

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
export { CL_HELPER_PLUGIN_BASE };

export const PYGMALION_API_BASE = 'https://server.pygmalion.chat/galatea.v1.PublicCharacterService';
export const PYGMALION_USER_API_BASE = 'https://server.pygmalion.chat/galatea.v1.UserService';
export const PYGMALION_SITE_BASE = 'https://pygmalion.chat';
export const PYGMALION_ASSETS_BASE = 'https://assets.pygmalion.chat';

// ========================================
// NETWORK
// ========================================

import { fetchWithProxy } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Build a Connect RPC unary GET URL with JSON-encoded message in query.
 * @param {string} method - RPC method name
 * @param {Object} message - request payload
 * @returns {string}
 */
function buildGetUrl(method, message) {
    const params = new URLSearchParams({
        connect: 'v1',
        encoding: 'json',
        message: JSON.stringify(message)
    });
    return `${PYGMALION_API_BASE}/${method}?${params}`;
}

/**
 * Search for characters on Pygmalion.
 * When a token is provided, uses authenticated POST (required for sensitive content).
 * Without a token, uses unauthenticated GET (SFW-only results).
 * @param {Object} opts
 * @param {string} [opts.query='']
 * @param {string} [opts.orderBy='downloads'] - Sort field
 * @param {boolean} [opts.orderDescending=true]
 * @param {boolean} [opts.includeSensitive=false]
 * @param {string} [opts.token] - Bearer token (required for sensitive results)
 * @param {number} [opts.pageSize=24]
 * @param {number} [opts.page=0] - 0-indexed
 * @param {string[]} [opts.tagsNamesInclude] - Tag names to require
 * @param {string[]} [opts.tagsNamesExclude] - Tag names to exclude
 * @returns {Promise<{totalItems: string, characters: Array}>}
 */
export async function searchCharacters(opts = {}) {
    const {
        query = '',
        orderBy = 'downloads',
        orderDescending = true,
        includeSensitive = false,
        token,
        pageSize = 24,
        page = 0,
        tagsNamesInclude,
        tagsNamesExclude,
    } = opts;

    const message = { query, orderBy, orderDescending, pageSize, page };
    if (includeSensitive) message.includeSensitive = true;
    if (tagsNamesInclude?.length) message.tagsNamesInclude = tagsNamesInclude;
    if (tagsNamesExclude?.length) message.tagsNamesExclude = tagsNamesExclude;

    if (token) {
        try {
            const resp = await fetchWithProxy(`${PYGMALION_API_BASE}/CharacterSearch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(message)
            });
            if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
            return resp.json();
        } catch (e) {
            const err = new Error(e.message);
            err.authFailed = true;
            throw err;
        }
    }

    const url = buildGetUrl('CharacterSearch', message);
    const resp = await fetchWithProxy(url, {
        headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
    return resp.json();
}

/**
 * Fetch full character detail from Pygmalion.
 * @param {string} characterMetaId - UUID
 * @param {string} [characterVersionId] - Optional version UUID
 * @param {string} [token] - Bearer token (required for sensitive/NSFW characters)
 * @returns {Promise<{character: Object, versions: Array}>}
 */
export async function fetchCharacterDetail(characterMetaId, characterVersionId, token) {
    const message = { characterMetaId };
    if (characterVersionId) message.characterVersionId = characterVersionId;

    if (token) {
        const resp = await fetchWithProxy(`${PYGMALION_API_BASE}/Character`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(message)
        });
        if (!resp.ok) throw new Error(`Character fetch failed (${resp.status})`);
        return resp.json();
    }

    const url = buildGetUrl('Character', message);
    const resp = await fetchWithProxy(url, {
        headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Character fetch failed (${resp.status})`);
    return resp.json();
}

/**
 * Fetch characters by owner on Pygmalion.
 * @param {string} userId - Owner UUID
 * @param {string} [orderBy='approved_at']
 * @param {number} [page=0]
 * @param {string} [token] - Bearer token (required for sensitive/NSFW characters)
 * @returns {Promise<Object>}
 */
export async function fetchCharactersByOwner(userId, orderBy = 'approved_at', page = 0, token) {
    const message = { userId, orderBy, page };

    if (token) {
        const resp = await fetchWithProxy(`${PYGMALION_API_BASE}/CharactersByOwnerID`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(message)
        });
        if (!resp.ok) throw new Error(`Owner characters fetch failed (${resp.status})`);
        return resp.json();
    }

    const url = buildGetUrl('CharactersByOwnerID', message);
    const resp = await fetchWithProxy(url, {
        headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Owner characters fetch failed (${resp.status})`);
    return resp.json();
}

/**
 * Build an avatar URL from a Pygmalion assets UUID or full URL.
 * @param {string} avatarUrlOrUuid - Full URL or just UUID
 * @returns {string}
 */
export function getAvatarUrl(avatarUrlOrUuid) {
    if (!avatarUrlOrUuid) return '';
    if (avatarUrlOrUuid.startsWith('http')) return avatarUrlOrUuid;
    return `${PYGMALION_ASSETS_BASE}/${avatarUrlOrUuid}`;
}

/**
 * Build the Pygmalion character page URL.
 * @param {string} characterId - Character UUID
 * @returns {string}
 */
export function getCharacterPageUrl(characterId) {
    return `${PYGMALION_SITE_BASE}/character/${characterId}`;
}

/**
 * Parse a Pygmalion character URL into a character UUID.
 * Supports: pygmalion.chat/character/{uuid}
 * @param {string} url
 * @returns {string|null}
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        const match = u.pathname.match(/\/character\/([a-f0-9-]{36})/i);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Extract all gallery image URLs from a character detail response.
 * Combines: altAvatars (alternate avatar images) + altImages (gallery/scene images).
 * @param {Object} char - Character object from detail API
 * @returns {Array<{url: string}>}
 */
export function getGalleryImages(char) {
    if (!char) return [];
    const urls = [];

    if (Array.isArray(char.altAvatars)) {
        for (const url of char.altAvatars) {
            if (url) urls.push({ url: getAvatarUrl(url) });
        }
    }
    if (Array.isArray(char.altImages)) {
        for (const url of char.altImages) {
            if (url) urls.push({ url: getAvatarUrl(url) });
        }
    }

    // Include chat background if present
    if (char.chatBackgroundUrl) {
        urls.push({ url: getAvatarUrl(char.chatBackgroundUrl) });
    }

    return urls;
}

// ========================================
// AUTHENTICATED API FUNCTIONS (UserService)
// ========================================

/**
 * Fetch the list of users the authenticated user is following.
 * @param {string} token - Bearer token
 * @param {Object} [opts]
 * @param {number} [opts.pageNumber=0]
 * @param {number} [opts.pageSize=50]
 * @param {string} [opts.queryName]
 * @returns {Promise<{users: Array, totalItems: number}>}
 */
export async function getFollowedUsers(token, opts = {}) {
    const { pageNumber = 0, pageSize = 50, queryName } = opts;
    const message = { pageNumber, pageSize };
    if (queryName) message.queryName = queryName;

    try {
        const resp = await fetchWithProxy(`${PYGMALION_USER_API_BASE}/GetFollowedUsers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(message)
        });
        return resp.json();
    } catch (e) {
        const err = new Error(e.message);
        err.authFailed = true;
        throw err;
    }
}

/**
 * Toggle follow/unfollow a user.
 * @param {string} token - Bearer token
 * @param {string} userId - Target user UUID
 * @returns {Promise<{isFollowing: boolean}>}
 */
export async function toggleFollowUser(token, userId) {
    try {
        const resp = await fetchWithProxy(`${PYGMALION_USER_API_BASE}/ToggleFollowUser`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId })
        });
        return resp.json();
    } catch (e) {
        const err = new Error(e.message);
        err.authFailed = true;
        throw err;
    }
}

// ========================================
// CL-HELPER PLUGIN (server-side auth proxy)
// ========================================

/**
 * Check if the cl-helper server plugin is available.
 * @param {Function} [apiRequest] - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkPluginAvailable(apiRequest) {
    try {
        const resp = apiRequest
            ? await apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Decode a JWT payload without verification.
 * @param {string} token - JWT string
 * @returns {Object|null} Decoded payload or null
 */
export function decodeJwtPayload(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
        return null;
    }
}

/**
 * Get the remaining lifetime of a JWT in seconds.
 * @param {string} token - JWT string
 * @returns {number} Seconds until expiry (negative if expired, Infinity if no exp)
 */
export function getTokenTTL(token) {
    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return Infinity;
    return payload.exp - Math.floor(Date.now() / 1000);
}
