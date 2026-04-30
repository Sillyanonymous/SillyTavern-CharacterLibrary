import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml } from '../provider-utils.js';

export { slugify, stripHtml };

export const BOTBOORU_SITE_BASE = 'https://botbooru.com';
export const BOTBOORU_PROVIDER_ID = 'botbooru';
export const BOTBOORU_PAGE_RE = /^\/(?:character|post)\/(\d+)/i;
export const BB_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/bb-proxy`;

let _apiRequest = null;

export function setApiRequest(fn) {
    _apiRequest = fn;
}

export function requireApiRequest() {
    if (!_apiRequest) throw new Error('BotBooru: apiRequest not bound');
    return _apiRequest;
}

export function buildProxyPath(path, params = null) {
    const safePath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
    const qs = params ? new URLSearchParams(params).toString() : '';
    return `${BB_PROXY_BASE}${safePath}${qs ? `?${qs}` : ''}`;
}

async function readBodySnippet(resp, maxLength = 200) {
    try {
        return (await resp.clone().text()).slice(0, maxLength);
    } catch {
        return '';
    }
}

export async function bbProxyFetch(path, params = null, options = {}) {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(
        buildProxyPath(path, params),
        options.method || 'GET',
        options.body || null
    );
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru HTTP ${resp.status}${body ? `: ${body}` : ''}`);
    }
    return resp;
}

export async function checkBotbooruPluginAvailable() {
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

export function getBotbooruPostUrl(id) {
    return `${BOTBOORU_SITE_BASE}/character/${encodeURIComponent(String(id))}`;
}

export function getBotbooruPreviewUrl(filename) {
    if (!filename) return null;
    return buildProxyPath(`/images/preview/480/${encodeURIComponent(String(filename))}`);
}

export function getBotbooruImageUrl(filename) {
    if (!filename) return null;
    return buildProxyPath(`/images/${encodeURIComponent(String(filename))}`);
}

export function getTagNames(tags) {
    return (Array.isArray(tags) ? tags : [])
        .map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter(Boolean)
        .map(tag => String(tag).trim())
        .filter(Boolean);
}

export function getRating(tags) {
    const names = getTagNames(tags).map(tag => tag.toLowerCase());
    if (names.includes('nsfl')) return 'nsfl';
    if (names.includes('nsfw')) return 'nsfw';
    if (names.includes('sfw')) return 'sfw';
    return 'unrated';
}

function toInt(value, fallback = 0) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function getPostFilename(post) {
    return post?.filename || post?.file_name || post?.image_filename || post?.preview_filename || null;
}

export function normalizeBotbooruPost(post) {
    if (!post) return null;

    const tags = getTagNames(post.tags || post.embedded_card_tags);
    const parsedId = Number.parseInt(post.id, 10);
    const id = Number.isFinite(parsedId) ? parsedId : post.id;
    const filename = getPostFilename(post);

    return {
        ...post,
        id,
        fullPath: String(id),
        name: post.character_name || post.name || post.data?.name || `BotBooru ${id}`,
        creator: post.uploader_name || post.creator || post.data?.creator || 'Unknown',
        tags,
        rating: getRating(tags),
        avatar_url: getBotbooruPreviewUrl(filename),
        image_url: getBotbooruImageUrl(filename),
        page_url: getBotbooruPostUrl(id),
        views: toInt(post.views),
        downloads: toInt(post.downloads),
        favorites: toInt(post.favorites ?? post.favorite_count ?? post.fav_count),
        createdAt: post.created_at || post.createdAt || null,
    };
}

export async function fetchBotbooruPosts({
    sort = 'latest',
    q = '',
    limit = 48,
    offset = 0,
    sfwOnly = false,
} = {}) {
    const params = new URLSearchParams();
    params.set('sort', sort);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('sfw_only', sfwOnly ? 'true' : 'false');
    if (q && q.trim()) params.set('q', q.trim());

    const resp = await bbProxyFetch('/posts/', params);
    const data = await resp.json();
    const rawPosts = data?.posts || data?.items || data?.list || [];

    return {
        total: toInt(data?.total ?? data?.total_count, rawPosts.length),
        posts: rawPosts.map(normalizeBotbooruPost).filter(Boolean),
    };
}

export async function fetchBotbooruPost(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return null;
    const resp = await bbProxyFetch(`/post/${postId}`);
    const data = await resp.json();
    return normalizeBotbooruPost(data?.post || data);
}

export async function fetchBotbooruCardJson(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return null;
    const resp = await bbProxyFetch(`/download/json/${postId}`);
    const card = await resp.json();
    if (card?.spec === 'chara_card_v2' && card?.data) return card;
    return null;
}

export async function fetchBotbooruCardPng(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return null;
    const resp = await bbProxyFetch(`/download/png/${postId}`);
    return await resp.arrayBuffer();
}

export async function setBotbooruToken(token) {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-set-token`, 'POST', { token });
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru token rejected (${resp.status})${body ? `: ${body}` : ''}`);
    }
    return true;
}

export async function clearBotbooruToken() {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-clear-token`, 'POST');
    return resp.ok;
}

export async function validateBotbooruSession(token = null) {
    try {
        if (token) await setBotbooruToken(token);

        const apiRequest = requireApiRequest();
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-validate`);
        if (!resp.ok) {
            const body = await readBodySnippet(resp);
            return { valid: false, reason: `HTTP ${resp.status}${body ? `: ${body}` : ''}` };
        }
        return await resp.json();
    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

export async function fetchBotbooruFavorites({
    limit = 48,
    offset = 0,
    q = '',
    sfwOnly = false,
} = {}) {
    const apiRequest = requireApiRequest();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('sfw_only', sfwOnly ? 'true' : 'false');
    if (q && q.trim()) params.set('q', q.trim());

    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorites?${params.toString()}`);
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`Favorites require BotBooru login (${resp.status})${body ? `: ${body}` : ''}`);
    }

    const data = await resp.json();
    const rawPosts = data?.posts || data?.favorites || data?.items || data?.list || [];
    return {
        total: toInt(data?.total ?? data?.total_count, rawPosts.length),
        posts: rawPosts.map(item => normalizeBotbooruPost(item?.post || item)).filter(Boolean),
    };
}

function normalizeFavoriteState(data) {
    return {
        count: toInt(data?.count ?? data?.favorites ?? data?.favorite_count ?? data?.fav_count),
        favorited: Boolean(data?.favorited ?? data?.is_favorited ?? data?.has_favorited ?? data?.active),
    };
}

export async function fetchBotbooruFavoriteState(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return { count: 0, favorited: false };

    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorites/${postId}`);
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru favorite state failed (${resp.status})${body ? `: ${body}` : ''}`);
    }
    return normalizeFavoriteState(await resp.json());
}

export async function toggleBotbooruFavorite(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return { count: 0, favorited: false };

    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorite/${postId}`, 'POST');
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru favorite toggle failed (${resp.status})${body ? `: ${body}` : ''}`);
    }
    return normalizeFavoriteState(await resp.json());
}
