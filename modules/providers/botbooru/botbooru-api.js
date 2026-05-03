import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml } from '../provider-utils.js';

export { slugify, stripHtml };

export const BOTBOORU_SITE_BASE = 'https://botbooru.com';
export const BOTBOORU_PROVIDER_ID = 'botbooru';
export const BOTBOORU_PAGE_RE = /^\/(?:character|post)\/(\d+)/i;
export const BB_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/bb-proxy`;
export const BB_PROXY_ASSET_BASE = `/api${BB_PROXY_BASE}`;

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

export function buildProxyAssetUrl(path, params = null) {
    const safePath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
    const qs = params ? new URLSearchParams(params).toString() : '';
    return `${BB_PROXY_ASSET_BASE}${safePath}${qs ? `?${qs}` : ''}`;
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
    return buildProxyAssetUrl(`/images/preview/480/${encodeURIComponent(String(filename))}`);
}

export function getBotbooruImageUrl(filename) {
    if (!filename) return null;
    return buildProxyAssetUrl(`/images/${encodeURIComponent(String(filename))}`);
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

const TAG_CATEGORY_ALIASES = {
    char: 'Characters',
    character: 'Characters',
    characters: 'Characters',
    artist: 'Artist',
    writer: 'Writer',
    scen: 'Scenarios',
    scens: 'Scenarios',
    scenario: 'Scenarios',
    scenarios: 'Scenarios',
    copy: 'Copyright',
    copyright: 'Copyright',
    meta: 'Meta',
    nsfl: 'NSFL',
    language: 'Language',
    lang: 'Language',
    general: 'General',
};

export function parseBotbooruTagInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return { error: 'Please enter a tag.' };

    let category = 'General';
    let tagPart = raw;
    if (raw.includes(':')) {
        const [prefix, ...rest] = raw.split(':');
        const alias = prefix.trim().toLowerCase();
        tagPart = rest.join(':');
        category = TAG_CATEGORY_ALIASES[alias] || (alias ? alias.charAt(0).toUpperCase() + alias.slice(1) : 'General');
    }

    const tagName = tagPart.trim().toLowerCase().replace(/\s+/g, '_');
    if (!tagName) return { error: 'Please enter a tag.' };

    const maxLength = category === 'Copyright' || category === 'Writer' || category === 'Characters' ? 30 : 20;
    if (tagName.length < 2) return { error: 'Tag must be at least 2 characters.' };
    if (tagName.length > maxLength) return { error: 'Tag name is too long for this category.' };

    return { tag_name: tagName, category };
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

async function clearBotbooruTokenQuietly() {
    try {
        await clearBotbooruToken();
    } catch {
        // Preserve the validation error; token cleanup is best-effort here.
    }
}

export async function validateBotbooruSession(token = null) {
    let tokenWasSet = false;
    try {
        if (token) {
            await setBotbooruToken(token);
            tokenWasSet = true;
        }

        const apiRequest = requireApiRequest();
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-validate`);
        if (!resp.ok) {
            const body = await readBodySnippet(resp);
            if (tokenWasSet) await clearBotbooruTokenQuietly();
            return { valid: false, reason: `HTTP ${resp.status}${body ? `: ${body}` : ''}` };
        }
        const result = await resp.json();
        if (tokenWasSet && result?.valid !== true) await clearBotbooruTokenQuietly();
        return result;
    } catch (err) {
        if (tokenWasSet) await clearBotbooruTokenQuietly();
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
    const rawPosts = Array.isArray(data)
        ? data
        : data?.posts || data?.favorites || data?.items || data?.list || [];
    return {
        total: toInt(data?.total ?? data?.total_count, rawPosts.length),
        posts: rawPosts.map(item => normalizeBotbooruPost(item?.post || item)).filter(Boolean),
    };
}

function normalizeBotbooruFollowedTag(item) {
    if (!item) return null;
    const id = Number.parseInt(item.id, 10);
    const tagName = String(item.tag_name || item.name || '').trim();
    if (!Number.isFinite(id) || !tagName) return null;
    return {
        ...item,
        id,
        tag_name: tagName,
        category: item.category || 'General',
    };
}

export async function fetchBotbooruFollowedTags() {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-followed-tags`);
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru followed tags failed (${resp.status})${body ? `: ${body}` : ''}`);
    }
    const data = await resp.json();
    const rawTags = Array.isArray(data)
        ? data
        : data?.tags || data?.items || data?.followed_tags || [];
    return rawTags.map(normalizeBotbooruFollowedTag).filter(Boolean);
}

export async function followBotbooruTag(input) {
    const parsed = typeof input === 'string' ? parseBotbooruTagInput(input) : input;
    if (!parsed || parsed.error) throw new Error(parsed?.error || 'Invalid BotBooru tag');

    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-followed-tags`, 'POST', {
        tag_name: parsed.tag_name,
        category: parsed.category || 'General',
    });
    if (!resp.ok) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru follow tag failed (${resp.status})${body ? `: ${body}` : ''}`);
    }
    return normalizeBotbooruFollowedTag(await resp.json());
}

export async function unfollowBotbooruTag(entryId) {
    const id = Number.parseInt(entryId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid followed tag id');

    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-followed-tags/${id}`, 'DELETE');
    if (!resp.ok && resp.status !== 404) {
        const body = await readBodySnippet(resp);
        throw new Error(`BotBooru unfollow tag failed (${resp.status})${body ? `: ${body}` : ''}`);
    }
    return true;
}

function toBooleanFlag(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    }
    return false;
}

function normalizeFavoriteState(data) {
    return {
        count: toInt(data?.count ?? data?.favorites ?? data?.favorite_count ?? data?.fav_count),
        favorited: toBooleanFlag(data?.favorited ?? data?.is_favorited ?? data?.has_favorited ?? data?.active),
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
