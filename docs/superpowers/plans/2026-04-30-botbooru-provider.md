# BotBooru Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BotBooru as a public-first Online provider with anonymous browse, preview, import, update checks, and token-only favorites.

**Architecture:** `cl-helper` proxies BotBooru requests because BotBooru public endpoints do not emit browser CORS headers. Browser provider modules call a focused `botbooru-api.js` client; `botbooru-provider.js` owns provider contract behavior; `botbooru-browse.js` owns Online UI and account/favorites UX.

**Tech Stack:** SillyTavern extension ES modules, existing `BrowseView`/`ProviderBase` contracts, DOM rendering, `CoreAPI.apiRequest`, `provider-utils.js`, Font Awesome, and the existing `cl-helper` server plugin router.

---

## File Structure

- Create `modules/providers/botbooru/botbooru-api.js`: BotBooru constants, helper-proxy fetches, anonymous browse/detail/download calls, token/session helpers, normalization helpers.
- Create `modules/providers/botbooru/botbooru-provider.js`: Provider identity, link metadata, URL parsing, import, update-card fetch, link stats, in-app preview bridge.
- Create `modules/providers/botbooru/botbooru-browse.js`: Online filter bar, browse/favorites modes, card grid, preview modal, token modal, import/favorite actions, local-library badges.
- Create `modules/providers/botbooru/botbooru-browse.css`: BotBooru-specific accents and any layout fixes not covered by `browse-shared.css`.
- Modify `extras/cl-helper/index.js`: Add `bb-*` public proxy, token storage, session validation, favorites, and favorite-toggle routes.
- Modify `extras/cl-helper/package.json`: Bump helper version to `1.2.0`.
- Modify `modules/module-loader.js`: Load BotBooru CSS and register the provider.
- Modify `app/library.html`: Add BotBooru settings/help UI and provider docs/search-help entries.
- Modify `app/library.js`: Add defaults, settings wiring, helper checks, token validation/clear handlers, exclude-tag wiring, provider extension key.
- Modify `index.js`: Add `botbooru` to provider extension-key detection.
- Modify `README.md`: Document public browsing, helper requirement, token-only favorites, and URL import.

---

### Task 1: Add BotBooru Routes To cl-helper

**Files:**
- Modify: `extras/cl-helper/index.js`
- Modify: `extras/cl-helper/package.json`

- [ ] **Step 1: Add BotBooru constants and helpers after the DataCat proxy block**

Insert this section after the `/dc-proxy/*` route and before the Imgchest section:

```js
    // =================================================================
    // BotBooru - public API proxy + optional bearer-token favorites
    // =================================================================

    const BOTBOORU_BASE = 'https://botbooru.com';
    const BOTBOORU_ORIGIN = 'https://botbooru.com';

    let bbAccessToken = null;

    function bbHeaders({ json = true, auth = false } = {}) {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': json ? 'application/json' : '*/*',
            'Origin': BOTBOORU_ORIGIN,
            'Referer': BOTBOORU_ORIGIN + '/',
        };
        if (auth && bbAccessToken) {
            headers.Authorization = `Bearer ${bbAccessToken}`;
        }
        return headers;
    }

    function normalizeBbToken(token) {
        if (!token || typeof token !== 'string') return null;
        let value = token.trim();
        if (value.toLowerCase().startsWith('bearer ')) value = value.slice(7).trim();
        if (!value || value.length > 4096 || /[\r\n]/.test(value)) return null;
        return value;
    }

    const BB_ALLOWED_PATHS = [
        /^\/posts\/?$/,
        /^\/post\/\d+$/,
        /^\/download\/json\/\d+$/,
        /^\/download\/png\/\d+$/,
        /^\/images\/.+$/,
        /^\/tags\/?.*$/,
        /^\/random\/?$/,
        /^\/interactions\/\d+\/favorites$/,
    ];

    function bbIsAllowedPath(pathname) {
        return BB_ALLOWED_PATHS.some(re => re.test(pathname));
    }

    function parsePositiveInt(value) {
        const n = Number.parseInt(value, 10);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    async function bbFetchJson(path, { auth = false } = {}) {
        const targetUrl = new URL(path, BOTBOORU_BASE);
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: bbHeaders({ auth }),
            redirect: 'follow',
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        return { response, data, text };
    }

    async function bbResolveCurrentUserId() {
        if (!bbAccessToken) return null;
        const { response, data } = await bbFetchJson('/auth/me', { auth: true });
        if (!response.ok) return null;
        return data?.id || data?.user?.id || data?.user_id || null;
    }
```

- [ ] **Step 2: Add session and validation routes**

Insert directly below the helper block from Step 1:

```js
    router.post('/bb-set-token', async (req, res) => {
        const token = normalizeBbToken(req.body?.token);
        if (!token) {
            return res.status(400).json({ error: 'token string is required' });
        }

        bbAccessToken = token;
        console.log('[cl-helper] BotBooru token stored');
        res.json({ ok: true });
    });

    router.post('/bb-clear-token', (_req, res) => {
        bbAccessToken = null;
        console.log('[cl-helper] BotBooru token cleared');
        res.json({ ok: true });
    });

    router.get('/bb-session', (_req, res) => {
        res.json({ active: !!bbAccessToken });
    });

    router.get('/bb-validate', async (_req, res) => {
        if (!bbAccessToken) {
            return res.json({ valid: false, reason: 'no token stored' });
        }

        try {
            const { response, data, text } = await bbFetchJson('/auth/me', { auth: true });
            if (!response.ok) {
                return res.json({ valid: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` });
            }
            res.json({
                valid: true,
                user: {
                    id: data?.id || data?.user?.id || data?.user_id || null,
                    username: data?.username || data?.user?.username || data?.name || null,
                },
            });
        } catch (err) {
            console.error('[cl-helper] BotBooru validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });
```

- [ ] **Step 3: Add public proxy and favorites routes**

Insert below the validation routes:

```js
    router.get('/bb-proxy/*', async (req, res) => {
        const targetPath = '/' + req.params[0];
        const targetUrl = new URL(targetPath, BOTBOORU_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        if (targetUrl.hostname !== 'botbooru.com') {
            return res.status(403).json({ error: 'Proxy target must be botbooru.com' });
        }
        if (!bbIsAllowedPath(targetUrl.pathname)) {
            console.warn(`[cl-helper] BotBooru proxy blocked: ${targetUrl.pathname}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        try {
            const wantsJson = !targetUrl.pathname.startsWith('/download/png/') && !targetUrl.pathname.startsWith('/images/');
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: bbHeaders({ json: wantsJson, auth: !!bbAccessToken }),
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json') || contentType.startsWith('text/')) {
                res.send(await response.text());
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] BotBooru proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach BotBooru' });
        }
    });

    router.get('/bb-favorites', async (req, res) => {
        if (!bbAccessToken) {
            return res.status(401).json({ error: 'No BotBooru token configured' });
        }

        const userId = await bbResolveCurrentUserId();
        if (!userId) {
            return res.status(401).json({ error: 'BotBooru token is invalid or expired' });
        }

        const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '48', 10) || 48, 1), 100);
        const offset = Math.max(Number.parseInt(req.query.offset || '0', 10) || 0, 0);
        const sfwOnly = req.query.sfw_only === 'true' ? 'true' : 'false';
        const q = typeof req.query.q === 'string' && req.query.q.trim()
            ? `&q=${encodeURIComponent(req.query.q.trim())}`
            : '';

        try {
            const path = `/api/users/${userId}/favorites?limit=${limit}&offset=${offset}&sfw_only=${sfwOnly}${q}`;
            const { response, data, text } = await bbFetchJson(path, { auth: true });
            res.status(response.status).json(data ?? { error: text });
        } catch (err) {
            console.error('[cl-helper] BotBooru favorites error:', err.message);
            res.status(502).json({ error: 'Failed to reach BotBooru favorites' });
        }
    });

    router.get('/bb-favorites/:postId', async (req, res) => {
        const postId = parsePositiveInt(req.params.postId);
        if (!postId) return res.status(400).json({ error: 'Invalid post id' });

        try {
            const { response, data, text } = await bbFetchJson(`/interactions/${postId}/favorites`, { auth: !!bbAccessToken });
            res.status(response.status).json(data ?? { error: text });
        } catch (err) {
            console.error('[cl-helper] BotBooru favorite-state error:', err.message);
            res.status(502).json({ error: 'Failed to reach BotBooru favorite state' });
        }
    });

    router.post('/bb-favorite/:postId', async (req, res) => {
        if (!bbAccessToken) {
            return res.status(401).json({ error: 'No BotBooru token configured' });
        }
        const postId = parsePositiveInt(req.params.postId);
        if (!postId) return res.status(400).json({ error: 'Invalid post id' });

        try {
            const response = await fetch(`${BOTBOORU_BASE}/interactions/${postId}/favorite`, {
                method: 'POST',
                headers: bbHeaders({ auth: true }),
                redirect: 'follow',
            });
            const text = await response.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
            res.status(response.status).json(data ?? { ok: response.ok });
        } catch (err) {
            console.error('[cl-helper] BotBooru favorite-toggle error:', err.message);
            res.status(502).json({ error: 'Failed to toggle BotBooru favorite' });
        }
    });
```

- [ ] **Step 4: Bump helper package version**

Change `extras/cl-helper/package.json`:

```json
{
    "name": "cl-helper",
    "version": "1.2.0",
    "description": "Server-side helper plugin for SillyTavern Character Library. Provides auth proxying for providers that require custom request headers.",
    "main": "index.js",
    "type": "module"
}
```

- [ ] **Step 5: Verify helper syntax**

Run:

```powershell
node --check extras/cl-helper/index.js
```

Expected: exit code `0` and no syntax error output.

- [ ] **Step 6: Commit helper routes**

Run:

```powershell
git add extras/cl-helper/index.js extras/cl-helper/package.json
git commit -m "Add BotBooru helper proxy routes"
```

---

### Task 2: Create BotBooru API Client

**Files:**
- Create: `modules/providers/botbooru/botbooru-api.js`

- [ ] **Step 1: Create constants, request binding, helper fetches, and normalization**

Create `modules/providers/botbooru/botbooru-api.js` with:

```js
import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml } from '../provider-utils.js';

export { slugify, stripHtml };

export const BOTBOORU_SITE_BASE = 'https://botbooru.com';
export const BOTBOORU_PROVIDER_ID = 'botbooru';
export const BOTBOORU_PAGE_RE = /^\/(?:character|post)\/(\d+)/i;

const BB_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/bb-proxy`;

let _apiRequest = null;

export function setApiRequest(fn) {
    _apiRequest = fn;
}

function requireApiRequest() {
    if (!_apiRequest) throw new Error('BotBooru: apiRequest not bound');
    return _apiRequest;
}

function buildProxyPath(path, params = null) {
    const qs = params ? params.toString() : '';
    return `${BB_PROXY_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function bbProxyFetch(path, params = null, options = {}) {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(buildProxyPath(path, params), options.method || 'GET', options.body || null);
    if (!resp.ok) {
        let body = '';
        try { body = await resp.clone().text(); } catch { /* ignore */ }
        throw new Error(`BotBooru HTTP ${resp.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
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
    return buildProxyPath(`/images/preview/480/${encodeURIComponent(filename)}`);
}

export function getBotbooruImageUrl(filename) {
    if (!filename) return null;
    return buildProxyPath(`/images/${encodeURIComponent(filename)}`);
}

export function getTagNames(tags) {
    return (Array.isArray(tags) ? tags : [])
        .map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter(Boolean)
        .map(tag => String(tag).trim())
        .filter(Boolean);
}

export function getRating(tags) {
    const names = getTagNames(tags).map(t => t.toLowerCase());
    if (names.includes('nsfl')) return 'nsfl';
    if (names.includes('nsfw')) return 'nsfw';
    if (names.includes('sfw')) return 'sfw';
    return 'unrated';
}

export function normalizeBotbooruPost(post) {
    if (!post) return null;
    const tags = getTagNames(post.tags || post.embedded_card_tags);
    const id = Number.parseInt(post.id, 10);
    return {
        ...post,
        id,
        fullPath: String(id),
        name: post.character_name || post.name || post.data?.name || `BotBooru ${id}`,
        creator: post.uploader_name || post.creator || post.data?.creator || 'Unknown',
        tags,
        rating: getRating(tags),
        avatar_url: getBotbooruPreviewUrl(post.filename),
        image_url: getBotbooruImageUrl(post.filename),
        page_url: getBotbooruPostUrl(id),
        views: Number.parseInt(post.views, 10) || 0,
        downloads: Number.parseInt(post.downloads, 10) || 0,
        favorites: Number.parseInt(post.favorites || post.favorite_count || post.fav_count, 10) || 0,
        createdAt: post.created_at || post.createdAt || null,
    };
}
```

- [ ] **Step 2: Add public data and download functions**

Append:

```js
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
    return {
        total: Number.parseInt(data?.total, 10) || 0,
        posts: (data?.posts || []).map(normalizeBotbooruPost).filter(Boolean),
    };
}

export async function fetchBotbooruPost(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return null;
    const resp = await bbProxyFetch(`/post/${postId}`);
    return normalizeBotbooruPost(await resp.json());
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
```

- [ ] **Step 3: Add token and favorites helpers**

Append:

```js
export async function setBotbooruToken(token) {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-set-token`, 'POST', { token });
    if (!resp.ok) return false;
    return true;
}

export async function clearBotbooruToken() {
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-clear-token`, 'POST');
    return resp.ok;
}

export async function validateBotbooruSession(token = null) {
    try {
        if (token) {
            const setOk = await setBotbooruToken(token);
            if (!setOk) return { valid: false, reason: 'token rejected by helper' };
        }
        const apiRequest = requireApiRequest();
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-validate`);
        if (!resp.ok) return { valid: false, reason: `HTTP ${resp.status}` };
        return await resp.json();
    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

export async function fetchBotbooruFavorites({ limit = 48, offset = 0, q = '', sfwOnly = false } = {}) {
    const apiRequest = requireApiRequest();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('sfw_only', sfwOnly ? 'true' : 'false');
    if (q && q.trim()) params.set('q', q.trim());
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorites?${params.toString()}`);
    if (!resp.ok) throw new Error(`Favorites require BotBooru login (${resp.status})`);
    const data = await resp.json();
    const rawPosts = data?.posts || data?.favorites || data?.items || data?.list || [];
    return {
        total: Number.parseInt(data?.total || data?.total_count, 10) || rawPosts.length,
        posts: rawPosts.map(item => normalizeBotbooruPost(item.post || item)).filter(Boolean),
    };
}

export async function fetchBotbooruFavoriteState(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) return { count: 0, favorited: false };
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorites/${postId}`);
    if (!resp.ok) return { count: 0, favorited: false };
    const data = await resp.json();
    return {
        count: Number.parseInt(data?.count, 10) || 0,
        favorited: data?.favorited === true,
    };
}

export async function toggleBotbooruFavorite(id) {
    const postId = Number.parseInt(id, 10);
    if (!postId) throw new Error('Missing BotBooru post id');
    const apiRequest = requireApiRequest();
    const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/bb-favorite/${postId}`, 'POST');
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
    }
    return await resp.json();
}
```

- [ ] **Step 4: Verify API module syntax**

Run:

```powershell
node --check modules/providers/botbooru/botbooru-api.js
```

Expected: exit code `0` and no syntax error output.

- [ ] **Step 5: Commit API client**

Run:

```powershell
git add modules/providers/botbooru/botbooru-api.js
git commit -m "Add BotBooru API client"
```

---

### Task 3: Create BotBooru Provider Contract Implementation

**Files:**
- Create: `modules/providers/botbooru/botbooru-provider.js`

- [ ] **Step 1: Create provider identity, lifecycle, browse bridges, and link metadata**

Create `modules/providers/botbooru/botbooru-provider.js` with:

```js
import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import botbooruBrowseView from './botbooru-browse.js';
import {
    BOTBOORU_PAGE_RE,
    getBotbooruPostUrl,
    normalizeBotbooruPost,
    setApiRequest,
    slugify,
    fetchBotbooruPost,
    fetchBotbooruCardJson,
    fetchBotbooruCardPng,
} from './botbooru-api.js';

let api = null;

function ensureBotbooruExtension(card, id, post = null) {
    if (!card.data) card.data = {};
    if (!card.data.extensions) card.data.extensions = {};
    const existing = card.data.extensions.botbooru || {};
    card.data.extensions.botbooru = {
        ...existing,
        id: Number.parseInt(id, 10),
        linkedAt: existing.linkedAt || new Date().toISOString(),
        pageName: post?.name || post?.character_name || card.data.name || existing.pageName || null,
    };
    return card;
}

class BotbooruProvider extends ProviderBase {
    get id() { return 'botbooru'; }
    get name() { return 'BotBooru'; }
    get icon() { return 'fa-solid fa-robot'; }
    get iconUrl() { return 'https://botbooru.com/favicon.ico'; }
    get browseView() { return botbooruBrowseView; }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setApiRequest(coreAPI.apiRequest);
    }

    get hasView() { return true; }
    renderFilterBar() { return botbooruBrowseView.renderFilterBar(); }
    renderView() { return botbooruBrowseView.renderView(); }
    renderModals() { return botbooruBrowseView.renderModals(); }
    async activate(container, options = {}) { botbooruBrowseView.activate(container, options); }
    deactivate() { botbooruBrowseView.deactivate(); }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-eye', label: 'Views' },
            stat2: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat3: { icon: 'fa-solid fa-heart', label: 'Favorites' },
        };
    }

    getLinkInfo(char) {
        const extensions = char?.data?.extensions || char?.extensions;
        const bb = extensions?.botbooru;
        const id = Number.parseInt(bb?.id, 10);
        if (!id) return null;
        return {
            providerId: 'botbooru',
            id,
            fullPath: String(id),
            linkedAt: bb.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.botbooru || {};
            char.data.extensions.botbooru = {
                id: Number.parseInt(linkInfo.id, 10),
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.botbooru;
        }
    }

    getCharacterUrl(linkInfo) {
        const id = Number.parseInt(linkInfo?.id || linkInfo?.fullPath, 10);
        return id ? getBotbooruPostUrl(id) : null;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }
```

- [ ] **Step 2: Add remote data, preview, URL handling, and import**

Append inside the class:

```js
    get supportsInAppPreview() { return true; }

    async buildPreviewObject(_char, linkInfo) {
        const post = await this.fetchMetadata(linkInfo?.id);
        return post ? normalizeBotbooruPost(post) : null;
    }

    openPreview(previewChar) {
        window.openBotbooruCharPreview?.(previewChar);
    }

    async fetchMetadata(id) {
        return fetchBotbooruPost(id);
    }

    async fetchRemoteCard(linkInfo) {
        const id = Number.parseInt(linkInfo?.id || linkInfo?.fullPath, 10);
        if (!id) return null;
        const card = await fetchBotbooruCardJson(id);
        return card ? ensureBotbooruExtension(card, id) : null;
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2' && rawData?.data) return rawData;
        return null;
    }

    async fetchLinkStats(linkInfo) {
        const post = await this.fetchMetadata(linkInfo?.id || linkInfo?.fullPath);
        if (!post) return null;
        return {
            stat1: Number.parseInt(post.views, 10) || 0,
            stat2: Number.parseInt(post.downloads, 10) || 0,
            stat3: Number.parseInt(post.favorites || post.favorite_count || post.fav_count, 10) || 0,
        };
    }

    getListingName(hitData) {
        return hitData?.character_name || hitData?.name || null;
    }

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?botbooru\.com$/i.test(u.hostname) && BOTBOORU_PAGE_RE.test(u.pathname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            if (!/^(www\.)?botbooru\.com$/i.test(u.hostname)) return null;
            const match = u.pathname.match(BOTBOORU_PAGE_RE);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    async importCharacter(id, hitData = null, options = {}) {
        try {
            const postId = Number.parseInt(id, 10);
            if (!postId) throw new Error('Missing BotBooru post id');

            const [post, card, imageBuffer] = await Promise.all([
                hitData ? Promise.resolve(normalizeBotbooruPost(hitData)) : fetchBotbooruPost(postId),
                fetchBotbooruCardJson(postId),
                fetchBotbooruCardPng(postId),
            ]);

            if (!card?.data) throw new Error('BotBooru did not return a V2 card');
            ensureBotbooruExtension(card, postId, post);
            assignGalleryId(card, options, api);

            const characterName = card.data.name || post?.name || `BotBooru ${postId}`;
            const fileName = `botbooru_${postId}_${slugify(characterName)}.png`;
            return await importFromPng({
                characterCard: card,
                imageBuffer,
                fileName,
                characterName,
                hasGallery: false,
                providerCharId: postId,
                fullPath: String(postId),
                avatarUrl: post?.avatar_url || null,
                api,
            });
        } catch (error) {
            console.error(`[BotbooruProvider] importCharacter failed for ${id}:`, error);
            return { success: false, error: error.message };
        }
    }
}

export default new BotbooruProvider();
```

- [ ] **Step 3: Verify provider syntax**

Run:

```powershell
node --check modules/providers/botbooru/botbooru-provider.js
```

Expected: exit code `0` and no syntax error output.

- [ ] **Step 4: Commit provider contract**

Run:

```powershell
git add modules/providers/botbooru/botbooru-provider.js
git commit -m "Add BotBooru provider contract"
```

---

### Task 4: Build BotBooru Browse UI

**Files:**
- Create: `modules/providers/botbooru/botbooru-browse.js`
- Create: `modules/providers/botbooru/botbooru-browse.css`

- [ ] **Step 1: Create browse module imports, state, and helpers**

Create the first section of `modules/providers/botbooru/botbooru-browse.js`:

```js
import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    checkBotbooruPluginAvailable,
    clearBotbooruToken,
    fetchBotbooruFavoriteState,
    fetchBotbooruFavorites,
    fetchBotbooruPost,
    fetchBotbooruPosts,
    getBotbooruPostUrl,
    setBotbooruToken,
    toggleBotbooruFavorite,
    validateBotbooruSession,
} from './botbooru-api.js';

const {
    showToast,
    getSetting,
    setSetting,
    escapeHtml,
    showPreImportDuplicateWarning,
    showImportSummaryModal,
    getCharacterGalleryId,
    getProviderExcludeTags,
} = CoreAPI;

const SORT_OPTIONS = [
    ['latest', 'Latest'],
    ['favorites', 'Most Favorited'],
    ['views', 'Most Viewed'],
    ['downloads', 'Most Downloaded'],
    ['curated', 'Curated'],
    ['random', 'Random'],
];

let botbooruCharacters = [];
let botbooruOffset = 0;
let botbooruTotal = 0;
let botbooruHasMore = true;
let botbooruIsLoading = false;
let botbooruLoadToken = 0;
let botbooruSelectedChar = null;
let botbooruViewMode = 'browse';
let botbooruSort = 'latest';
let botbooruSearch = '';
let botbooruNsfw = true;
let botbooruPluginOk = false;
let botbooruToken = null;

function isBotbooruLinked(localChar, id) {
    const ext = localChar?.data?.extensions?.botbooru || localChar?.extensions?.botbooru;
    return Number.parseInt(ext?.id, 10) === Number.parseInt(id, 10);
}

function getProvider() {
    return window.ProviderRegistry?.getProvider('botbooru');
}

function getGrid() {
    return document.getElementById('botbooruGrid');
}

function buildSortOptionsHtml() {
    return SORT_OPTIONS.map(([value, label]) =>
        `<option value="${value}" ${value === botbooruSort ? 'selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');
}

function applyPersistentExcludeTags(posts) {
    const excludes = new Set((getProviderExcludeTags?.('botbooru') || []).map(t => t.toLowerCase()));
    if (excludes.size === 0) return posts;
    return posts.filter(post => !(post.tags || []).some(tag => excludes.has(String(tag).toLowerCase())));
}
```

- [ ] **Step 2: Add loading, rendering, and preview functions**

Append:

```js
function renderLoadingState(message = 'Loading BotBooru...') {
    const grid = getGrid();
    if (!grid) return;
    grid.innerHTML = `
        <div class="browse-loading-overlay" style="grid-column: 1 / -1;">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <p>${escapeHtml(message)}</p>
        </div>`;
}

function renderEmptyState(message, actionHtml = '') {
    const grid = getGrid();
    if (!grid) return;
    grid.innerHTML = `
        <div class="browse-empty-state" style="grid-column: 1 / -1;">
            <i class="fa-solid fa-robot"></i>
            <h3>${escapeHtml(message)}</h3>
            ${actionHtml}
        </div>`;
}

function renderBotbooruCard(char) {
    const ratingBadge = char.rating && char.rating !== 'sfw'
        ? `<span class="browse-nsfw-badge">${escapeHtml(char.rating.toUpperCase())}</span>`
        : '';
    const tags = (char.tags || []).slice(0, 6);
    return `
        <div class="browse-card botbooru-card" data-botbooru-id="${char.id}">
            <div class="browse-card-image">
                <img data-src="${escapeHtml(char.avatar_url || IMG_PLACEHOLDER)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(char.name)}" decoding="async" loading="lazy" onerror="this.src='/img/ai4.png'">
                ${ratingBadge}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(char.name)}</div>
                <span class="browse-card-creator-link">${escapeHtml(char.creator || 'Unknown')}</span>
                <div class="browse-card-tags">
                    ${tags.map(tag => `<span class="browse-card-tag">${escapeHtml(tag)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Views"><i class="fa-solid fa-eye"></i> ${formatNumber(char.views || 0)}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(char.downloads || 0)}</span>
                <span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${formatNumber(char.favorites || 0)}</span>
            </div>
        </div>`;
}

function renderBotbooruGrid({ append = false } = {}) {
    const grid = getGrid();
    if (!grid) return;
    const html = botbooruCharacters.map(renderBotbooruCard).join('');
    grid.innerHTML = html || '';
    botbooruBrowseView.observeImages(grid);
    botbooruBrowseView.refreshInLibraryBadges();
    const count = document.getElementById('botbooruResultCount');
    if (count) count.textContent = `${botbooruCharacters.length} / ${botbooruTotal || botbooruCharacters.length}`;
    const moreBtn = document.getElementById('botbooruLoadMoreBtn');
    if (moreBtn) moreBtn.classList.toggle('hidden', !botbooruHasMore);
}
```

- [ ] **Step 3: Add data loading and import/favorite actions**

Append:

```js
async function loadBotbooruCharacters({ reset = false } = {}) {
    if (botbooruIsLoading) return;
    const grid = getGrid();
    if (!grid) return;

    botbooruIsLoading = true;
    const loadToken = ++botbooruLoadToken;
    if (reset) {
        botbooruOffset = 0;
        botbooruCharacters = [];
        renderLoadingState(botbooruViewMode === 'favorites' ? 'Loading your BotBooru favorites...' : 'Loading BotBooru...');
    }

    try {
        botbooruPluginOk = await checkBotbooruPluginAvailable();
        if (!botbooruPluginOk) {
            renderEmptyState('cl-helper is required for BotBooru browsing', '<p>Install or update the cl-helper server plugin, then reload Character Library.</p>');
            return;
        }

        const params = {
            limit: 48,
            offset: botbooruOffset,
            q: botbooruSearch,
            sfwOnly: !botbooruNsfw,
        };
        const result = botbooruViewMode === 'favorites'
            ? await fetchBotbooruFavorites(params)
            : await fetchBotbooruPosts({ ...params, sort: botbooruSort });

        if (loadToken !== botbooruLoadToken) return;

        const posts = applyPersistentExcludeTags(result.posts || []);
        botbooruTotal = result.total || posts.length;
        botbooruCharacters = reset ? posts : botbooruCharacters.concat(posts);
        botbooruOffset += result.posts?.length || 0;
        botbooruHasMore = (result.posts?.length || 0) >= 48 && botbooruCharacters.length < botbooruTotal;

        if (botbooruCharacters.length === 0) {
            renderEmptyState(botbooruViewMode === 'favorites' ? 'No favorites found' : 'No BotBooru characters found');
        } else {
            renderBotbooruGrid();
        }
    } catch (err) {
        if (botbooruViewMode === 'favorites') {
            renderEmptyState('BotBooru favorites require a token', '<button class="action-btn primary botbooru-open-token-btn"><i class="fa-solid fa-key"></i> Add Token</button>');
        } else {
            grid.innerHTML = `<div class="browse-error-state" style="grid-column: 1 / -1;"><h3>Failed to load BotBooru</h3><p>${escapeHtml(err.message)}</p></div>`;
        }
    } finally {
        botbooruIsLoading = false;
    }
}

async function openBotbooruCharPreview(char) {
    const detail = char?._fullDetail ? char : await fetchBotbooruPost(char.id);
    botbooruSelectedChar = { ...char, ...detail, _fullDetail: true };
    const modal = document.getElementById('botbooruCharModal');
    if (!modal) return;

    document.getElementById('botbooruCharName').textContent = botbooruSelectedChar.name || 'BotBooru Character';
    document.getElementById('botbooruCharCreator').textContent = botbooruSelectedChar.creator || 'Unknown';
    document.getElementById('botbooruCharAvatar').src = botbooruSelectedChar.image_url || botbooruSelectedChar.avatar_url || '/img/ai4.png';
    document.getElementById('botbooruOpenInBrowserBtn').href = getBotbooruPostUrl(botbooruSelectedChar.id);
    document.getElementById('botbooruCharDescription').textContent = botbooruSelectedChar.description || '';
    document.getElementById('botbooruCharFirstMsg').textContent = botbooruSelectedChar.first_mes || '';
    document.getElementById('botbooruCharTags').innerHTML = (botbooruSelectedChar.tags || []).map(tag => `<span class="browse-tag">${escapeHtml(tag)}</span>`).join('');

    const state = await fetchBotbooruFavoriteState(botbooruSelectedChar.id);
    updateFavoriteButton(state);
    modal.classList.remove('hidden');
}

function updateFavoriteButton(state) {
    const btn = document.getElementById('botbooruFavoriteBtn');
    const count = document.getElementById('botbooruFavoriteCount');
    if (!btn || !count) return;
    btn.classList.toggle('favorited', state.favorited === true);
    btn.title = state.favorited ? 'Remove from BotBooru favorites' : 'Add to BotBooru favorites';
    btn.querySelector('i').className = state.favorited ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    count.textContent = formatNumber(state.count || 0);
}

async function importSelectedBotbooruCharacter() {
    if (!botbooruSelectedChar) return;
    const provider = getProvider();
    const importBtn = document.getElementById('botbooruImportBtn');
    if (!provider || !importBtn) return;

    importBtn.disabled = true;
    importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
    try {
        let inheritedGalleryId = null;
        const duplicateMatches = CoreAPI.findDuplicateCharacters?.(botbooruSelectedChar.name, botbooruSelectedChar.creator) || [];
        if (duplicateMatches.length > 0 && showPreImportDuplicateWarning) {
            const result = await showPreImportDuplicateWarning({
                name: botbooruSelectedChar.name,
                creator: botbooruSelectedChar.creator,
                fullPath: String(botbooruSelectedChar.id),
                avatarUrl: botbooruSelectedChar.avatar_url,
            }, duplicateMatches);
            if (result.choice === 'skip') return;
            if (result.choice === 'replace') inheritedGalleryId = getCharacterGalleryId(duplicateMatches[0].char);
        }

        const result = await provider.importCharacter(botbooruSelectedChar.id, botbooruSelectedChar, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');
        showToast(`Imported ${result.characterName || botbooruSelectedChar.name}`, 'success');
        showImportSummaryModal?.({ galleryCharacters: [], mediaCharacters: [] });
        botbooruBrowseView.buildLocalLibraryLookup();
        botbooruBrowseView.refreshInLibraryBadges();
    } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
    } finally {
        importBtn.disabled = false;
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    }
}

async function toggleSelectedFavorite() {
    if (!botbooruSelectedChar) return;
    if (!botbooruToken) {
        showToast('BotBooru token required for favorites', 'info');
        openBotbooruTokenModal();
        return;
    }
    await toggleBotbooruFavorite(botbooruSelectedChar.id);
    updateFavoriteButton(await fetchBotbooruFavoriteState(botbooruSelectedChar.id));
}
```

- [ ] **Step 4: Add token modal behavior and BrowseView subclass**

Append:

```js
export function openBotbooruTokenModal() {
    const modal = document.getElementById('botbooruTokenModal');
    const input = document.getElementById('botbooruTokenInput');
    if (!modal || !input) return;
    input.value = botbooruToken || getSetting('botbooruToken') || '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
}

async function saveBotbooruTokenFromModal() {
    const input = document.getElementById('botbooruTokenInput');
    const token = input?.value?.trim();
    if (!token) {
        showToast('Paste a BotBooru token first', 'warning');
        return;
    }
    const result = await validateBotbooruSession(token);
    if (!result.valid) {
        showToast(`BotBooru token invalid: ${result.reason || 'Unknown error'}`, 'error');
        return;
    }
    botbooruToken = token;
    setSetting('botbooruToken', token);
    showToast('BotBooru token saved', 'success');
    document.getElementById('botbooruTokenModal')?.classList.add('hidden');
    if (botbooruViewMode === 'favorites') loadBotbooruCharacters({ reset: true });
}

const botbooruBrowseView = new (class BotbooruBrowseView extends BrowseView {
    constructor() {
        super('botbooru', {
            importBtnSelector: '#botbooruImportBtn',
            gridSelector: '#botbooruGrid',
            cardSelector: '.botbooru-card',
            previewModalId: 'botbooruCharModal',
        });
    }

    get previewModalId() { return 'botbooruCharModal'; }
    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: SORT_OPTIONS.map(([value, label]) => ({ value, label })),
            defaultBrowseSort: 'latest',
            modes: [
                { value: 'browse', label: 'Browse' },
                { value: 'favorites', label: 'My Favorites' },
            ],
        };
    }

    get mobileFilterIds() {
        return {
            sort: 'botbooruSortSelect',
            nsfw: 'botbooruNsfwToggle',
            refresh: 'botbooruRefreshBtn',
            modeBrowseSelector: '.botbooru-view-btn[data-botbooru-view="browse"]',
            modeFollowSelector: '.botbooru-view-btn[data-botbooru-view="favorites"]',
        };
    }

    renderFilterBar() {
        return `
            <div class="chub-view-toggle">
                <button class="botbooru-view-btn active" data-botbooru-view="browse" title="Browse BotBooru">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="botbooru-view-btn" data-botbooru-view="favorites" title="Your BotBooru favorites">
                    <i class="fa-solid fa-heart"></i> <span>Favorites</span>
                </button>
            </div>
            <div class="browse-sort-container">
                <select id="botbooruSortSelect" class="glass-select" title="Sort order">${buildSortOptionsHtml()}</select>
            </div>
            <button id="botbooruNsfwToggle" class="filter-toggle active" title="Toggle NSFW results">
                <i class="fa-solid fa-eye"></i> NSFW
            </button>
            <button id="botbooruRefreshBtn" class="glass-btn icon-only" title="Refresh BotBooru">
                <i class="fa-solid fa-rotate"></i>
            </button>`;
    }

    renderView() {
        return `
            <div id="botbooruBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="botbooruSearchInput" placeholder="Search BotBooru by name or tag..." autocomplete="off">
                        <button id="botbooruClearSearchBtn" class="browse-search-clear hidden" title="Clear search"><i class="fa-solid fa-xmark"></i></button>
                        <button id="botbooruSearchBtn" class="browse-search-submit" title="Search"><i class="fa-solid fa-arrow-right"></i></button>
                    </div>
                    <div id="botbooruResultCount" class="browse-result-count"></div>
                </div>
                <div id="botbooruGrid" class="browse-grid"></div>
                <button id="botbooruLoadMoreBtn" class="action-btn secondary browse-load-more hidden">
                    <i class="fa-solid fa-plus"></i> Load More
                </button>
            </div>`;
    }

    renderModals() {
        return `
            <div id="botbooruCharModal" class="modal-overlay hidden">
                <div class="modal-glass browse-char-modal">
                    <div class="modal-header">
                        <div class="browse-char-header-info">
                            <img id="botbooruCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                            <div>
                                <h2 id="botbooruCharName">Character Name</h2>
                                <p class="browse-char-meta">by <span id="botbooruCharCreator">Unknown</span></p>
                            </div>
                        </div>
                        <div class="modal-controls">
                            <button id="botbooruFavoriteBtn" class="action-btn secondary botbooru-favorite-btn" title="Favorite on BotBooru"><i class="fa-regular fa-heart"></i> <span id="botbooruFavoriteCount">0</span></button>
                            <a id="botbooruOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on BotBooru"><i class="fa-solid fa-external-link"></i> Open</a>
                            <button id="botbooruImportBtn" class="action-btn primary" title="Import to SillyTavern"><i class="fa-solid fa-download"></i> Import</button>
                            <button class="close-btn" id="botbooruCharClose">&times;</button>
                        </div>
                    </div>
                    <div class="browse-char-body">
                        <div class="browse-char-section"><h3>Description</h3><div id="botbooruCharDescription" class="scrolling-text"></div></div>
                        <div class="browse-char-section"><h3>First Message</h3><div id="botbooruCharFirstMsg" class="scrolling-text first-message-preview"></div></div>
                        <div class="browse-char-section"><h3>Tags</h3><div id="botbooruCharTags" class="browse-tags"></div></div>
                    </div>
                </div>
            </div>
            <div id="botbooruTokenModal" class="modal-overlay hidden">
                <div class="modal-glass" style="max-width: 560px;">
                    <div class="modal-header">
                        <h3><i class="fa-solid fa-key"></i> BotBooru Token</h3>
                        <button class="close-btn" id="botbooruTokenClose">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p class="settings-hint">Browsing and importing BotBooru is public. Add a token only for your favorites and favorite/unfavorite actions.</p>
                        <input id="botbooruTokenInput" type="password" class="glass-input" placeholder="Paste BotBooru bearer token" autocomplete="off" data-sensitive="true">
                        <div class="modal-actions">
                            <button id="botbooruSaveTokenBtn" class="action-btn primary"><i class="fa-solid fa-check"></i> Save Token</button>
                            <button id="botbooruClearTokenBtn" class="action-btn secondary"><i class="fa-solid fa-trash-can"></i> Clear</button>
                        </div>
                    </div>
                </div>
            </div>`;
    }
```

- [ ] **Step 5: Add activation, event wiring, badge refresh, and export**

Append:

```js
    activate(container, options = {}) {
        if (options.domRecreated) {
            botbooruCharacters = [];
            botbooruOffset = 0;
            botbooruTotal = 0;
            botbooruHasMore = true;
            botbooruViewMode = 'browse';
        }
        botbooruToken = getSetting('botbooruToken') || null;
        botbooruNsfw = getSetting('botbooruNsfw') !== false;
        const defaults = options.defaults || {};
        if (defaults.browseSort) botbooruSort = defaults.browseSort;
        super.activate(container, options);
    }

    attachEventListeners() {
        const on = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler);

        document.querySelectorAll('.botbooru-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.botbooruView;
                if (!mode || mode === botbooruViewMode) return;
                botbooruViewMode = mode;
                document.querySelectorAll('.botbooru-view-btn').forEach(b => b.classList.toggle('active', b === btn));
                loadBotbooruCharacters({ reset: true });
            });
        });

        on('botbooruSortSelect', 'change', e => {
            botbooruSort = e.target.value || 'latest';
            loadBotbooruCharacters({ reset: true });
        });
        on('botbooruNsfwToggle', 'click', e => {
            botbooruNsfw = !botbooruNsfw;
            setSetting('botbooruNsfw', botbooruNsfw);
            e.currentTarget.classList.toggle('active', botbooruNsfw);
            loadBotbooruCharacters({ reset: true });
        });
        on('botbooruRefreshBtn', 'click', () => loadBotbooruCharacters({ reset: true }));
        on('botbooruSearchBtn', 'click', () => {
            botbooruSearch = document.getElementById('botbooruSearchInput')?.value?.trim() || '';
            loadBotbooruCharacters({ reset: true });
        });
        on('botbooruSearchInput', 'keydown', e => {
            if (e.key === 'Enter') document.getElementById('botbooruSearchBtn')?.click();
        });
        on('botbooruClearSearchBtn', 'click', () => {
            const input = document.getElementById('botbooruSearchInput');
            if (input) input.value = '';
            botbooruSearch = '';
            loadBotbooruCharacters({ reset: true });
        });
        on('botbooruLoadMoreBtn', 'click', () => loadBotbooruCharacters({ reset: false }));
        on('botbooruImportBtn', 'click', importSelectedBotbooruCharacter);
        on('botbooruFavoriteBtn', 'click', toggleSelectedFavorite);
        on('botbooruCharClose', 'click', () => document.getElementById('botbooruCharModal')?.classList.add('hidden'));
        on('botbooruTokenClose', 'click', () => document.getElementById('botbooruTokenModal')?.classList.add('hidden'));
        on('botbooruSaveTokenBtn', 'click', saveBotbooruTokenFromModal);
        on('botbooruClearTokenBtn', 'click', async () => {
            botbooruToken = null;
            setSetting('botbooruToken', null);
            await clearBotbooruToken();
            document.getElementById('botbooruTokenInput').value = '';
            showToast('BotBooru token cleared', 'success');
        });

        const grid = getGrid();
        grid?.addEventListener('click', e => {
            if (e.target.closest('.botbooru-open-token-btn')) {
                openBotbooruTokenModal();
                return;
            }
            const card = e.target.closest('.botbooru-card');
            if (!card) return;
            const id = Number.parseInt(card.dataset.botbooruId, 10);
            const char = botbooruCharacters.find(c => Number.parseInt(c.id, 10) === id);
            if (char) openBotbooruCharPreview(char);
        });

        if (botbooruCharacters.length === 0) loadBotbooruCharacters({ reset: true });
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = Number.parseInt(card.dataset.botbooruId, 10);
            return CoreAPI.getAllCharacters?.().some(char => isBotbooruLinked(char, id));
        });
    }

    deactivate() {
        botbooruLoadToken++;
        super.deactivate();
        this.disconnectImageObserver();
    }
})();

window.openBotbooruCharPreview = openBotbooruCharPreview;
window.openBotbooruTokenModal = openBotbooruTokenModal;
window.botbooruValidateSession = validateBotbooruSession;
window.botbooruClearSession = clearBotbooruToken;
window.botbooruSetToken = setBotbooruToken;

export default botbooruBrowseView;
```

- [ ] **Step 6: Add BotBooru CSS**

Create `modules/providers/botbooru/botbooru-browse.css`:

```css
.botbooru-card .browse-card-footer .fa-heart,
.botbooru-favorite-btn.favorited {
    color: #e85d75;
}

.botbooru-favorite-btn.favorited {
    border-color: rgba(232, 93, 117, 0.5);
}

.botbooru-view-btn {
    min-width: 96px;
}

.botbooru-card .browse-card-image img {
    object-position: center 20%;
}
```

- [ ] **Step 7: Verify browse module syntax**

Run:

```powershell
node --check modules/providers/botbooru/botbooru-browse.js
```

Expected: exit code `0` and no syntax error output.

- [ ] **Step 8: Commit browse UI**

Run:

```powershell
git add modules/providers/botbooru/botbooru-browse.js modules/providers/botbooru/botbooru-browse.css
git commit -m "Add BotBooru browse UI"
```

---

### Task 5: Register BotBooru In The Host Extension

**Files:**
- Modify: `modules/module-loader.js`
- Modify: `app/library.html`
- Modify: `app/library.js`
- Modify: `index.js`

- [ ] **Step 1: Register CSS and provider import**

In `modules/module-loader.js`, add:

```js
    loadModuleCSS('./providers/botbooru/botbooru-browse.css');
```

after the DataCat CSS load, and add:

```js
            { name: 'botbooru', load: () => import('./providers/botbooru/botbooru-provider.js') },
```

after the DataCat provider import.

- [ ] **Step 2: Add settings defaults**

In `app/library.js`, update `DEFAULT_SETTINGS`:

```js
    botbooruToken: null,
```

in the credentials block, and:

```js
    botbooruNsfw: true,
```

in the NSFW toggle block.

- [ ] **Step 3: Add BotBooru settings DOM references**

In `setupSettingsModal()`, near the DataCat references, add:

```js
    const botbooruTokenInput = document.getElementById('settingsBotbooruToken');
    const toggleBotbooruTokenVisibility = document.getElementById('toggleBotbooruTokenVisibility');
    const botbooruPluginBanner = document.getElementById('botbooruPluginBanner');
    const botbooruSettingsFields = document.getElementById('botbooruSettingsFields');
    const botbooruSessionStatus = document.getElementById('botbooruSessionStatus');
    const botbooruNsfwDefaultCheckbox = document.getElementById('settingsBotbooruNsfw');
```

- [ ] **Step 4: Add BotBooru exclude tags**

In `EXCLUDE_TAG_PROVIDERS`, add:

```js
        { id: 'botbooru', inputId: 'botbooruExcludeTagsInput', pillsId: 'botbooruExcludeTagsPills' },
```

- [ ] **Step 5: Populate BotBooru settings and helper status on modal open**

In `settingsBtn.onclick`, after DataCat token population, add:

```js
        if (botbooruTokenInput) botbooruTokenInput.value = getSetting('botbooruToken') || '';
        if (botbooruNsfwDefaultCheckbox) botbooruNsfwDefaultCheckbox.checked = getSetting('botbooruNsfw') !== false;
```

In the `checkClHelperPlugin(...)` call, add:

```js
            botbooruPluginBanner, botbooruSettingsFields,
```

Then in the `.then(available => { ... })` block, add:

```js
            if (botbooruSessionStatus) {
                if (!available) {
                    botbooruSessionStatus.className = 'settings-status-badge inactive';
                    botbooruSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Plugin missing';
                } else if (!window.botbooruValidateSession) {
                    botbooruSessionStatus.className = 'settings-status-badge inactive';
                    botbooruSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Module not loaded';
                } else {
                    botbooruSessionStatus.className = 'settings-status-badge inactive';
                    botbooruSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Public browse active';
                }
            }
```

- [ ] **Step 6: Save BotBooru settings**

In `doSaveSettings()`, add:

```js
            botbooruToken: botbooruTokenInput ? (botbooruTokenInput.value?.trim() || null) : null,
            botbooruNsfw: botbooruNsfwDefaultCheckbox ? botbooruNsfwDefaultCheckbox.checked : true,
```

- [ ] **Step 7: Add token visibility and validation handlers**

Near the other session validation handlers, add:

```js
    if (toggleBotbooruTokenVisibility && botbooruTokenInput) {
        toggleBotbooruTokenVisibility.onclick = () => {
            botbooruTokenInput.type = botbooruTokenInput.type === 'password' ? 'text' : 'password';
        };
    }

    const validateBotbooruBtn = document.getElementById('validateBotbooruBtn');
    if (validateBotbooruBtn && botbooruTokenInput) {
        validateBotbooruBtn.onclick = async (e) => {
            e.preventDefault();
            validateBotbooruBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateBotbooruBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateBotbooruBtn.disabled = true;
            try {
                if (!window.botbooruValidateSession) throw new Error('BotBooru module not ready');
                const token = botbooruTokenInput.value?.trim();
                if (!token) {
                    showToast('BotBooru browsing works without a token. Paste a token only for favorites.', 'info');
                    validateBotbooruBtn.classList.add('success');
                } else {
                    const result = await window.botbooruValidateSession(token);
                    if (!result.valid) throw new Error(result.reason || 'Invalid token');
                    showToast('BotBooru token valid', 'success');
                    validateBotbooruBtn.classList.add('success');
                    if (botbooruSessionStatus) {
                        botbooruSessionStatus.className = 'settings-status-badge active';
                        botbooruSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Authenticated';
                    }
                }
            } catch (err) {
                showToast(`BotBooru validation failed: ${err.message}`, 'error');
                validateBotbooruBtn.classList.add('error');
                validateBotbooruBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
            } finally {
                validateBotbooruBtn.disabled = false;
                if (validateBotbooruBtn.classList.contains('success')) {
                    validateBotbooruBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validateBotbooruBtn.classList.remove('success', 'error');
                    validateBotbooruBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    const clearBotbooruTokenBtn = document.getElementById('clearBotbooruTokenBtn');
    if (clearBotbooruTokenBtn && botbooruTokenInput) {
        clearBotbooruTokenBtn.onclick = async (e) => {
            e.preventDefault();
            botbooruTokenInput.value = '';
            setSetting('botbooruToken', null);
            await window.botbooruClearSession?.();
            showToast('BotBooru token cleared', 'success');
        };
    }
```

- [ ] **Step 8: Add BotBooru settings HTML**

In `app/library.html`, insert this provider section after ChubAI or before DataCat:

```html
                        <!-- BotBooru provider settings -->
                        <details class="settings-provider-section" id="settingsBotbooruSection">
                            <summary>
                                <i class="fa-solid fa-robot provider-icon"></i> BotBooru
                                <i class="fa-solid fa-chevron-right provider-chevron"></i>
                            </summary>
                            <div class="settings-provider-body">
                                <div class="cl-helper-banner cl-hidden" id="botbooruPluginBanner">
                                    <i class="fa-solid fa-puzzle-piece"></i>
                                    <div>
                                        <strong>cl-helper plugin required</strong>
                                        <span>BotBooru browsing and downloads are public, but browser CORS requires the cl-helper server plugin to proxy requests.</span>
                                    </div>
                                </div>
                                <div class="settings-group" id="botbooruSettingsFields">
                                    <div class="settings-group-title"><i class="fa-solid fa-key"></i> Account Features</div>
                                    <div class="settings-row">
                                        <label>Status:</label>
                                        <div class="settings-input-group">
                                            <span id="botbooruSessionStatus" class="settings-status-badge inactive"><i class="fa-solid fa-circle"></i> Public browse active</span>
                                        </div>
                                    </div>
                                    <div class="settings-row">
                                        <label for="settingsBotbooruToken">Bearer Token:</label>
                                        <div class="settings-input-group">
                                            <input type="password" id="settingsBotbooruToken" placeholder="Optional: paste BotBooru token for favorites" autocomplete="off" data-sensitive="true">
                                            <button id="toggleBotbooruTokenVisibility" class="glass-btn icon-only" title="Show/Hide">
                                                <i class="fa-solid fa-eye"></i>
                                            </button>
                                            <button id="validateBotbooruBtn" class="settings-verify-btn" title="Validate Token">
                                                <i class="fa-solid fa-check"></i>
                                            </button>
                                        </div>
                                        <span class="settings-hint">Token is optional. It unlocks My Favorites and favorite/unfavorite actions only.</span>
                                    </div>
                                    <div class="settings-row" style="gap: 8px;">
                                        <button id="clearBotbooruTokenBtn" class="settings-action-btn danger">
                                            <i class="fa-solid fa-trash-can"></i> Clear Token
                                        </button>
                                    </div>
                                </div>
                                <div class="settings-group">
                                    <div class="settings-group-title"><i class="fa-solid fa-eye"></i> Browse Defaults</div>
                                    <div class="settings-row">
                                        <label class="settings-checkbox-label">
                                            <input type="checkbox" id="settingsBotbooruNsfw" checked>
                                            <span>Show NSFW by default</span>
                                        </label>
                                        <span class="settings-hint">When enabled, BotBooru uses sfw_only=false. Users can toggle this in the Online browse bar.</span>
                                    </div>
                                </div>
                                <div class="settings-group">
                                    <div class="settings-group-title"><i class="fa-solid fa-ban"></i> Exclude Tags</div>
                                    <div class="settings-row">
                                        <div class="provider-exclude-tags-container">
                                            <div class="provider-exclude-tags-pills" id="botbooruExcludeTagsPills"></div>
                                            <input type="text" class="glass-input provider-exclude-tags-input" id="botbooruExcludeTagsInput" placeholder="Type a tag and press Enter" autocomplete="off">
                                        </div>
                                        <span class="settings-hint">Tags entered here are always excluded from BotBooru browse results.</span>
                                    </div>
                                </div>
                            </div>
                        </details>
```

- [ ] **Step 9: Add provider extension keys**

In both `app/library.js` and `index.js`, change:

```js
const PROVIDER_EXT_KEYS = ['chub', 'jannyai', 'pygmalion', 'wyvern', 'chartavern', 'datacat'];
```

to:

```js
const PROVIDER_EXT_KEYS = ['chub', 'jannyai', 'pygmalion', 'wyvern', 'chartavern', 'datacat', 'botbooru'];
```

- [ ] **Step 10: Verify host syntax**

Run:

```powershell
node --check modules/module-loader.js
node --check app/library.js
node --check index.js
```

Expected: each command exits `0` with no syntax error output.

- [ ] **Step 11: Commit host integration**

Run:

```powershell
git add modules/module-loader.js app/library.html app/library.js index.js
git commit -m "Register BotBooru in Character Library"
```

---

### Task 6: Document And Verify End-To-End

**Files:**
- Modify: `README.md`
- Read: `docs/superpowers/specs/2026-04-30-botbooru-provider-design.md`

- [ ] **Step 1: Update README provider documentation**

Add a BotBooru section near other provider docs:

```markdown
### BotBooru

BotBooru is available in the Online tab as a public-first provider. Browsing, previewing, importing, URL import, and update checks work without a BotBooru token. The `cl-helper` server plugin is still required because BotBooru does not expose browser CORS headers for its public JSON and PNG endpoints.

Optional account features:

- Paste a BotBooru bearer token in Settings -> Online Providers -> BotBooru to enable My Favorites.
- Favorite and unfavorite actions require the token.
- Normal browsing remains available after clearing the token.

Supported URLs:

- `https://botbooru.com/character/1234`
- `https://botbooru.com/post/1234`
```

- [ ] **Step 2: Run syntax checks for every touched JavaScript file**

Run:

```powershell
node --check extras/cl-helper/index.js
node --check modules/providers/botbooru/botbooru-api.js
node --check modules/providers/botbooru/botbooru-provider.js
node --check modules/providers/botbooru/botbooru-browse.js
node --check modules/module-loader.js
node --check app/library.js
node --check index.js
```

Expected: all commands exit `0` with no syntax error output.

- [ ] **Step 3: Run whitespace/diff sanity checks**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits `0`; `git status --short` shows only intended files before the final commit.

- [ ] **Step 4: Manual browser verification inside SillyTavern**

Start or use the existing SillyTavern instance with this extension loaded, then verify:

```text
1. Open Character Library -> Online.
2. Confirm BotBooru appears in the provider selector and is enabled by default.
3. Confirm the first BotBooru request loads cards with no token saved.
4. Confirm NSFW is active by default and the request uses sfw_only=false through cl-helper.
5. Toggle NSFW off and confirm the next request uses sfw_only=true.
6. Open a BotBooru card preview.
7. Confirm favorite count appears without a token.
8. Click favorite without a token and confirm the token modal opens.
9. Import a public BotBooru card and confirm the local card has data.extensions.botbooru.id.
10. Paste a BotBooru URL into Import by URL and confirm it imports.
11. Run update check on the imported card and confirm remote JSON is fetched without a token.
```

- [ ] **Step 5: Commit docs and verification fixes**

Run:

```powershell
git add README.md
git commit -m "Document BotBooru provider"
```

If manual verification requires code fixes, include the exact fixed files in the same commit only when the fix is directly tied to BotBooru verification.

---

## Self-Review Checklist

- Spec coverage: Tasks cover public helper proxy, anonymous browse/detail/download, token-only favorites, provider link metadata, URL import, update checks, settings HTML/JS, default NSFW on, docs, and verification.
- Placeholder scan: This plan intentionally avoids placeholder terms and includes concrete paths, snippets, commands, and expected results.
- Type consistency: Provider id is `botbooru`, extension key is `extensions.botbooru`, token setting is `botbooruToken`, NSFW default setting is `botbooruNsfw`, helper route prefix is `/plugins/cl-helper/bb-*`.
