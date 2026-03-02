// Shared CharacterTavern API utilities — used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for the
// character-tavern.com API.

// ========================================
// CONSTANTS
// ========================================

export const CT_API_BASE = 'https://character-tavern.com/api';
export const CT_SITE_BASE = 'https://character-tavern.com';
export const CT_CARDS_CDN = 'https://cards.character-tavern.com';

// Sort options accepted by /api/search/cards
export const CT_SORT_OPTIONS = {
    most_popular: 'Most Popular',
    trending: 'Trending',
    newest: 'Newest',
    oldest: 'Oldest',
    most_likes: 'Most Liked'
};

// ========================================
// NETWORK
// ========================================

const _proxyOrigins = new Set();

export async function fetchWithProxy(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!_proxyOrigins.has(origin)) {
        try {
            const r = await fetch(url, opts);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r;
        } catch (_) {
            _proxyOrigins.add(origin);
        }
    }
    const r = await fetch(`/proxy/${encodeURIComponent(url)}`, opts);
    if (!r.ok) {
        if (r.status === 404) {
            const t = await r.text();
            if (t.includes('CORS proxy is disabled'))
                throw new Error('CORS proxy is disabled in SillyTavern settings');
        }
        throw new Error(`HTTP ${r.status}`);
    }
    return r;
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search characters via /api/search/cards
 * @param {Object} opts
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number}>}
 */
export async function searchCards(opts = {}) {
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

    // CT API has no explicit NSFW toggle — exclude_tags is used instead
    if (!nsfw) {
        const existing = excludeTags ? excludeTags.split(',').map(t => t.trim()) : [];
        if (!existing.includes('nsfw')) existing.push('nsfw');
        params.set('exclude_tags', existing.join(','));
    }

    const url = `${CT_API_BASE}/search/cards?${params}`;
    const resp = await fetchWithProxy(url);
    return resp.json();
}

/**
 * Fetch full character details via /api/character/{author}/{slug}
 * @param {string} author
 * @param {string} slug
 * @returns {Promise<Object>} { card: {...}, ownerCTId: ... }
 */
export async function fetchCharacterDetail(author, slug) {
    const url = `${CT_API_BASE}/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
    const resp = await fetchWithProxy(url);
    return resp.json();
}

/**
 * Fetch top tags from /api/catalog/top-tags
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags() {
    const url = `${CT_API_BASE}/catalog/top-tags`;
    const resp = await fetchWithProxy(url);
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
    return `${CT_CARDS_CDN}/cdn-cgi/image/format=auto,width=${width},quality=85/${path}.png`;
}

/**
 * Build full-size card PNG URL (for download / import).
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCardPngUrl(path) {
    return `${CT_CARDS_CDN}/${path}.png`;
}

/**
 * Build the web page URL for a character.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCharacterPageUrl(path) {
    return `${CT_SITE_BASE}/character/${path}`;
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
// TEXT UTILITIES
// ========================================

export function slugify(name) {
    return (name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

export function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

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

export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}
