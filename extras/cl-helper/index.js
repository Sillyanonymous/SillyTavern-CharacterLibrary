// cl-helper — SillyTavern server plugin for Character Library
//
// Provides server-side request proxying for providers that require
// custom headers (like Origin) that browsers forbid setting.
// Also provides gallery thumbnail generation via ST's bundled jimp.

import { randomUUID } from 'node:crypto';
import { join, resolve, sep, dirname } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'cl-helper',
    name: 'Character Library Helper',
    description: 'Auth and request proxying for the Character Library extension.',
};

const PYGMALION_AUTH_URL = 'https://auth.pygmalion.chat/session';
const PYGMALION_ORIGIN = 'https://pygmalion.chat';

// =========================================================
// Gallery thumbnail generation
// =========================================================

const THUMB_QUALITY = 82;
const THUMB_MAX_SIZE = 1024;
const THUMB_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
const THUMB_CONCURRENCY = 2;

let _cacheDir = null;
let _Jimp = null;
let _imagesDir = null;
let _thumbsReady = false;
let _thumbActive = 0;
let _thumbQueue = [];

function _thumbSemaphore() {
    if (_thumbActive < THUMB_CONCURRENCY) {
        _thumbActive++;
        return Promise.resolve();
    }
    return new Promise(resolve => _thumbQueue.push(resolve));
}

function _thumbRelease() {
    if (_thumbQueue.length > 0) {
        _thumbQueue.shift()();
    } else {
        _thumbActive--;
    }
}

function resolveImagesDir() {
    const stRoot = process.cwd();
    const dataDir = join(stRoot, 'data');
    if (!existsSync(dataDir)) return null;

    const defaultPath = join(dataDir, 'default-user', 'user', 'images');
    if (existsSync(defaultPath)) return defaultPath;

    try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const candidate = join(dataDir, entry.name, 'user', 'images');
            if (existsSync(candidate)) return candidate;
        }
    } catch {}

    return null;
}

async function initImageLib() {
    const stModules = join(process.cwd(), 'node_modules');
    const stImport = async (pkg) => {
        const pj = JSON.parse(await readFile(join(stModules, pkg, 'package.json'), 'utf8'));
        const entry = pj.exports?.['.']?.import?.default || pj.module || 'index.js';
        return import(pathToFileURL(join(stModules, pkg, entry)).href);
    };

    try {
        const { createJimp } = await stImport('@jimp/core');
        const jpeg = (await stImport('@jimp/wasm-jpeg')).default;
        const png = (await stImport('@jimp/wasm-png')).default;
        const resize = await stImport('@jimp/plugin-resize');
        const crop = await stImport('@jimp/plugin-crop');
        const cover = await stImport('@jimp/plugin-cover');

        const formats = [jpeg, png];
        try { formats.push((await stImport('@jimp/wasm-webp')).default); } catch (e) { console.log('[cl-helper] webp not available:', e.message); }
        try { formats.push((await stImport('@jimp/js-gif')).default); } catch (e) { console.log('[cl-helper] gif not available:', e.message); }

        _Jimp = createJimp({
            plugins: [resize.methods, crop.methods, cover.methods],
            formats,
        });
        return true;
    } catch (err) {
        console.log('[cl-helper] jimp not available:', err.message);
        return false;
    }
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    // ---- All routes registered synchronously (before any awaits) ----

    router.get('/health', (_req, res) => {
        res.json({ ok: true, version: '1.1.0', thumbnails: _thumbsReady });
    });

    // =================================================================
    // Gallery thumbnail endpoint
    // =================================================================

    router.get('/gallery-thumb/:folder/:file', async (req, res) => {
        if (!_Jimp || !_imagesDir) {
            return res.status(503).json({ error: 'Thumbnails not available' });
        }

        const { folder, file } = req.params;
        const size = Math.min(Math.max(parseInt(req.query.s) || 384, 64), THUMB_MAX_SIZE);

        if (!folder || !file
            || folder.includes('..') || file.includes('..')
            || folder.includes('/') || folder.includes('\\')
            || file.includes('/') || file.includes('\\')) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        if (!THUMB_EXTENSIONS.test(file)) {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        const originalPath = resolve(_imagesDir, folder, file);
        if (!originalPath.startsWith(_imagesDir + sep)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        let origStat;
        try {
            origStat = await stat(originalPath);
        } catch {
            console.log(`[cl-helper] 404: ${originalPath}`);
            return res.status(404).json({ error: 'Not found' });
        }

        const cacheFolder = join(_cacheDir, folder);
        const cachePath = join(cacheFolder, `${file}_${size}.jpg`);

        try {
            const cacheStat = await stat(cachePath);
            if (cacheStat.mtimeMs > origStat.mtimeMs) {
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(await readFile(cachePath));
            }
        } catch { /* cache miss */ }

        try {
            await _thumbSemaphore();
            const image = await _Jimp.read(originalPath);
            image.cover({ w: size, h: size });
            const buffer = await image.getBuffer('image/jpeg', { quality: THUMB_QUALITY, jpegColorSpace: 'ycbcr' });
            _thumbRelease();

            mkdirSync(cacheFolder, { recursive: true });
            writeFile(cachePath, buffer).catch(() => {});

            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } catch (err) {
            _thumbRelease();
            console.error(`[cl-helper] Thumb error ${folder}/${file}:`, err.message);
            res.status(500).json({ error: 'Generation failed' });
        }
    });

    // =================================================================
    // Thumbnail cache cleanup (per folder)
    // =================================================================

    router.post('/gallery-thumb-cleanup/:folder', (req, res) => {
        if (!_cacheDir) {
            return res.status(503).json({ error: 'Thumbnails not available' });
        }

        const { folder } = req.params;
        if (!folder || folder.includes('..') || folder.includes('/') || folder.includes('\\')) {
            return res.status(400).json({ error: 'Invalid folder' });
        }

        const cacheFolder = resolve(_cacheDir, folder);
        if (!cacheFolder.startsWith(_cacheDir + sep)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (existsSync(cacheFolder)) {
                rmSync(cacheFolder, { recursive: true, force: true });
                console.log(`[cl-helper] Cleaned thumb cache: ${folder}`);
                res.json({ ok: true, deleted: true });
            } else {
                res.json({ ok: true, deleted: false });
            }
        } catch (err) {
            console.error(`[cl-helper] Cache cleanup error ${folder}:`, err.message);
            res.status(500).json({ error: 'Cleanup failed' });
        }
    });

    router.post('/pyg-login', async (req, res) => {
        const { username, password } = req.body ?? {};

        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        if (typeof username !== 'string' || typeof password !== 'string'
            || username.length > 256 || password.length > 256) {
            return res.status(400).json({ error: 'Invalid credentials format' });
        }

        try {
            const body = new URLSearchParams({ username, password }).toString();

            const response = await fetch(PYGMALION_AUTH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': PYGMALION_ORIGIN,
                    'Referer': PYGMALION_ORIGIN + '/',
                },
                body,
            });

            const text = await response.text();

            res.status(response.status);
            res.set('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            console.error('[cl-helper] Pygmalion login proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Pygmalion auth server' });
        }
    });

    // =================================================================
    // CharacterTavern — cookie-based session auth
    // =================================================================

    // In-memory session store (cookies persist until logout or server restart)
    let ctSessionCookies = null; // string — raw cookie header value

    /**
     * POST /ct-set-cookie
     * Body: { cookie: "session=VALUE" } or { cookie: "VALUE" }
     *
     * Stores the provided session cookie for use in proxied requests.
     * Only the `session` cookie is accepted — rejects input containing
     * multiple cookies or unexpected keys to limit stored scope.
     */
    router.post('/ct-set-cookie', async (req, res) => {
        const { cookie } = req.body ?? {};

        if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
            return res.status(400).json({ error: 'cookie string is required' });
        }

        let value = cookie.trim();

        // Normalize: accept bare value or session=VALUE
        if (value.startsWith('session=')) {
            value = value.slice('session='.length).trim();
        }

        // Reject if it looks like multiple cookies or contains suspicious characters
        if (value.includes(';') || value.length > 4096) {
            return res.status(400).json({ error: 'Invalid cookie value. Paste only the session cookie value.' });
        }

        if (!value) {
            return res.status(400).json({ error: 'Empty cookie value' });
        }

        ctSessionCookies = `session=${value}`;
        console.log('[cl-helper] CT session cookie stored');
        res.json({ ok: true });
    });

    /**
     * GET /ct-validate
     * Makes a test request to CT with stored cookies to verify they work.
     * Returns { valid: true/false }.
     */
    router.get('/ct-validate', async (_req, res) => {
        if (!ctSessionCookies) {
            return res.json({ valid: false, reason: 'no cookies stored' });
        }

        try {
            // Search a term that returns both SFW and NSFW results when authenticated
            const response = await fetch('https://character-tavern.com/api/search/cards?query=sara+lane&limit=5', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
                    'Accept': 'application/json',
                    'Cookie': ctSessionCookies,
                },
            });

            if (response.ok) {
                const data = await response.json();
                const hits = data?.hits || [];
                // Authenticated sessions return NSFW results (isNSFW=true, contentWarnings populated)
                const hasNsfw = hits.some(h => h.isNSFW === true);
                
                // Check if server rejected the cookie (by setting it to empty/expired)
                const setCookie = response.headers.get('set-cookie');
                const isRejected = setCookie && (setCookie.includes('session=;') || setCookie.includes('Max-Age=0'));
                
                if (isRejected) {
                    console.warn('[cl-helper] CT session rejected (Set-Cookie deletion detected)');
                    ctSessionCookies = null; // Clear our invalid cookie
                    res.json({ valid: false, reason: 'Session rejected/expired by server' });
                    return;
                }

                console.log(`[cl-helper] CT validate: ${hits.length} hits, totalHits=${data?.totalHits}, hasNSFW=${hasNsfw}`);
                res.json({ valid: true, hasNsfw });
            } else if (response.status === 403) {
                ctSessionCookies = null;
                res.json({ valid: false, reason: 'rejected (cookies expired or invalid)' });
            } else {
                res.json({ valid: false, reason: `HTTP ${response.status}` });
            }
        } catch (err) {
            console.error('[cl-helper] CT validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    /**
     * POST /ct-logout
     * Clears stored session cookies.
     */
    router.post('/ct-logout', (_req, res) => {
        ctSessionCookies = null;
        console.log('[cl-helper] CT session cleared');
        res.json({ ok: true });
    });

    /**
     * GET /ct-session
     * Returns whether a CT session is active.
     */
    router.get('/ct-session', (_req, res) => {
        res.json({ active: !!ctSessionCookies });
    });

    // CT API paths the proxy is allowed to forward (read-only endpoints only)
    const CT_ALLOWED_PATHS = [
        /^\/api\/search\/cards\b/,
        /^\/api\/character\/[^/]+\/[^/]+$/,
        /^\/api\/catalog\/top-tags$/,
    ];

    /**
     * GET /ct-proxy/*
     * Read-only proxy to character-tavern.com with stored session cookies.
     * Path-allowlisted to prevent abuse as an open relay.
     */
    router.get('/ct-proxy/*', async (req, res) => {
        const targetPath = '/' + req.params[0]; // everything after /ct-proxy/

        // Normalize and allowlist check — only known read-only API paths
        const normalizedPath = new URL(targetPath, 'https://character-tavern.com/').pathname;
        if (!CT_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] CT proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, 'https://character-tavern.com/');
        // Preserve query string from the original request
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        // Verify resolved URL still points at CT (prevents open-redirect via path tricks)
        if (targetUrl.hostname !== 'character-tavern.com') {
            return res.status(403).json({ error: 'Proxy target must be character-tavern.com' });
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
        };
        if (ctSessionCookies) {
            headers['Cookie'] = ctSessionCookies;
        }

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers,
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                const text = await response.text();
                res.send(text);
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] CT proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach CharacterTavern' });
        }
    });

    // =================================================================
    // DataCat — token-based session + read-only API proxy
    // =================================================================

    const DATACAT_BASE = 'https://datacat.run';
    const DATACAT_ORIGIN = 'https://datacat.run';

    let dcSessionToken = null;

    function dcHeaders(token) {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': DATACAT_ORIGIN,
            'Referer': DATACAT_ORIGIN + '/',
            'X-Session-Token': token,
        };
    }

    async function testDcToken(token) {
        const response = await fetch(`${DATACAT_BASE}/api/characters/recent-public?limit=1&offset=0&summary=1&minTotalTokens=889`, {
            headers: dcHeaders(token),
        });
        return response;
    }

    router.post('/dc-init', async (req, res) => {
        const { force } = req.body ?? {};

        // If we already have a token and not forcing refresh, verify it still works
        if (dcSessionToken && !force) {
            try {
                const check = await testDcToken(dcSessionToken);
                if (check.ok) {
                    return res.json({ ok: true, cached: true, token: dcSessionToken });
                }
            } catch { /* fall through to create new */ }
            dcSessionToken = null;
        }

        // Create anonymous session via the Liberator identify endpoint
        const deviceToken = randomUUID();
        try {
            const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': DATACAT_ORIGIN,
                    'Referer': DATACAT_ORIGIN + '/',
                },
                body: JSON.stringify({ deviceToken }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.warn(`[cl-helper] DC identify failed: HTTP ${response.status}`);
                return res.json({ ok: false, reason: `identify returned ${response.status}: ${text.slice(0, 200)}` });
            }

            const data = await response.json();
            if (data?.success && data?.sessionToken) {
                dcSessionToken = data.sessionToken;
                console.log('[cl-helper] DC anonymous session initialized');
                return res.json({ ok: true, token: dcSessionToken });
            }

            console.warn('[cl-helper] DC identify returned unexpected shape:', JSON.stringify(data).slice(0, 300));
            res.json({ ok: false, reason: 'identify response missing sessionToken' });
        } catch (err) {
            console.error('[cl-helper] DC auto-init error:', err.message);
            res.json({ ok: false, reason: err.message });
        }
    });

    router.post('/dc-set-token', async (req, res) => {
        const { token } = req.body ?? {};

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: 'token string is required' });
        }

        const value = token.trim();
        if (value.length > 256) {
            return res.status(400).json({ error: 'Token too long' });
        }

        dcSessionToken = value;
        console.log('[cl-helper] DC session token stored');
        res.json({ ok: true });
    });

    router.post('/dc-clear-token', (_req, res) => {
        dcSessionToken = null;
        console.log('[cl-helper] DC session token cleared');
        res.json({ ok: true });
    });

    router.get('/dc-session', (_req, res) => {
        res.json({ active: !!dcSessionToken });
    });

    router.get('/dc-validate', async (_req, res) => {
        if (!dcSessionToken) {
            return res.json({ valid: false, reason: 'no token stored' });
        }

        try {
            const response = await testDcToken(dcSessionToken);

            if (response.ok) {
                const data = await response.json();
                const count = data?.totalCount || 0;
                console.log(`[cl-helper] DC validate: ${count} total chars available`);
                res.json({ valid: true, totalCount: count });
            } else {
                const text = await response.text();
                console.warn(`[cl-helper] DC validate failed: HTTP ${response.status}`);
                res.json({ valid: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` });
            }
        } catch (err) {
            console.error('[cl-helper] DC validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    const DC_ALLOWED_PATHS = [
        /^\/api\/characters\/fresh\b/,
        /^\/api\/characters\/recent-public\b/,
        /^\/api\/characters\/[a-f0-9-]+$/,
        /^\/api\/characters\/[a-f0-9-]+\/download\b/,
        /^\/api\/creators\/[a-f0-9-]+$/,
        /^\/api\/creators\/[a-f0-9-]+\/characters\b/,
        /^\/api\/tags\/faceted\b/,
        /^\/api\/extraction\/status$/,
    ];

    // Fetch a usable public session ID for extraction
    async function getPublicSessionId(token) {
        try {
            const resp = await fetch(`${DATACAT_BASE}/api/users`, {
                headers: dcHeaders(token),
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            const publicUser = (data.users || []).find(u => u.isPublic);
            if (!publicUser?.sessions) return null;
            // Pick a non-background, logged_in session
            const session = publicUser.sessions.find(
                s => s.purpose !== 'BACKGROUND_SCRAPER' && s.status === 'logged_in'
            );
            return session?.id || null;
        } catch {
            return null;
        }
    }

    // POST-only: submit extraction request to DataCat
    router.post('/dc-extract', async (req, res) => {
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const { url } = req.body ?? {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url string is required' });
        }
        if (url.length > 512) {
            return res.status(400).json({ error: 'URL too long' });
        }

        // Only allow JanitorAI character URLs
        try {
            const parsed = new URL(url);
            if (!/^(www\.)?janitorai\.com$/i.test(parsed.hostname) && !/^(www\.)?jannyai\.com$/i.test(parsed.hostname)) {
                return res.status(400).json({ error: 'Only JanitorAI character URLs are supported' });
            }
            if (!/^\/characters\/[a-f0-9-]+/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const requestId = randomUUID();
        const wantPublicFeed = req.body.publicFeed !== false;

        // Resolve a public session ID when public feed is requested
        let sessionId = null;
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(dcSessionToken);
        }

        try {
            const response = await fetch(`${DATACAT_BASE}/api/character/smart-extract-v2`, {
                method: 'POST',
                headers: {
                    ...dcHeaders(dcSessionToken),
                    'Content-Type': 'application/json',
                    'X-Request-Id': requestId,
                },
                body: JSON.stringify({
                    url,
                    sessionId,
                    appearOnPublicFeed: wantPublicFeed && !!sessionId,
                    useSeparateWorkerServer: true,
                    inlinePostExtractCreatorProfile: true,
                    idempotencyKey: requestId,
                }),
            });

            const data = await response.json();
            res.status(response.status).json(data);
        } catch (err) {
            console.error('[cl-helper] DC extract error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.get('/dc-proxy/*', async (req, res) => {
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const targetPath = '/' + req.params[0];

        const normalizedPath = new URL(targetPath, DATACAT_BASE).pathname;
        if (!DC_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] DC proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, DATACAT_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        if (targetUrl.hostname !== 'datacat.run') {
            return res.status(403).json({ error: 'Proxy target must be datacat.run' });
        }

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: dcHeaders(dcSessionToken),
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                res.send(await response.text());
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] DC proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    // =================================================================
    // Imgchest — password-protected gallery unlock
    // =================================================================

    const IMGCHEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    function extractImgchestCookies(headers) {
        const result = { xsrfToken: null, session: null };
        const setCookies = typeof headers.getSetCookie === 'function'
            ? headers.getSetCookie()
            : (headers.get('set-cookie') || '').split(/,\s*(?=[A-Z])/);
        for (const sc of setCookies) {
            const xsrf = sc.match(/XSRF-TOKEN=([^;]+)/);
            if (xsrf) result.xsrfToken = xsrf[1];
            const sess = sc.match(/image_chest_session=([^;]+)/);
            if (sess) result.session = sess[1];
        }
        return result;
    }

    function parseImgchestImages(html) {
        const match = html.match(/data-page="([^"]+)"/);
        if (!match) return [];
        try {
            const decoded = match[1]
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&#039;/g, "'");
            const data = JSON.parse(decoded);
            const files = data?.props?.post?.files;
            if (!Array.isArray(files)) return [];
            return files
                .filter(f => f.link && typeof f.link === 'string')
                .map(f => ({ url: f.link, filename: f.link.split('/').pop() }));
        } catch {
            return [];
        }
    }

    /**
     * POST /imgchest-unlock
     * Body: { url: "https://imgchest.com/p/{id}", password: "..." }
     * Returns: { images: [{url, filename}] } or { error: "..." }
     *
     * Three-step flow:
     * 1. GET /p/{id}/validate — obtain XSRF + session cookies
     * 2. POST /p/{id}/validate — submit password, receive authenticated cookies
     * 3. GET /p/{id} — fetch unlocked page, extract images from data-page JSON
     */
    router.post('/imgchest-unlock', async (req, res) => {
        const { url, password } = req.body ?? {};

        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
        if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required' });
        if (url.length > 512) return res.status(400).json({ error: 'URL too long' });
        if (password.length > 256) return res.status(400).json({ error: 'Password too long' });

        let postId;
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== 'imgchest.com') {
                return res.status(400).json({ error: 'Only imgchest.com URLs are supported' });
            }
            const m = parsed.pathname.match(/^\/p\/([a-zA-Z0-9]+)/);
            if (!m) return res.status(400).json({ error: 'Invalid imgchest post URL' });
            postId = m[1];
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const validateUrl = `https://imgchest.com/p/${postId}/validate`;
        const postUrl = `https://imgchest.com/p/${postId}`;

        try {
            // Step 1: GET validate page for cookies + XSRF token
            const step1 = await fetch(validateUrl, {
                headers: { 'User-Agent': IMGCHEST_UA, 'Accept': 'text/html' },
            });
            if (!step1.ok) {
                return res.json({ error: `Validate page returned HTTP ${step1.status}` });
            }

            const cookies1 = extractImgchestCookies(step1.headers);
            if (!cookies1.xsrfToken || !cookies1.session) {
                return res.json({ error: 'Failed to obtain session from imgchest' });
            }

            const html1 = await step1.text();
            let inertiaVersion = '';
            const dataPageMatch = html1.match(/data-page="([^"]+)"/);
            if (dataPageMatch) {
                const decoded = dataPageMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                const vm = decoded.match(/"version":"([^"]+)"/);
                if (vm) inertiaVersion = vm[1];
            }

            // Step 2: POST password
            const step2 = await fetch(validateUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': IMGCHEST_UA,
                    'Content-Type': 'application/json',
                    'Accept': 'text/html, application/xhtml+xml',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-Inertia': 'true',
                    ...(inertiaVersion ? { 'X-Inertia-Version': inertiaVersion } : {}),
                    'X-XSRF-TOKEN': decodeURIComponent(cookies1.xsrfToken),
                    'Cookie': `XSRF-TOKEN=${cookies1.xsrfToken}; image_chest_session=${cookies1.session}`,
                    'Origin': 'https://imgchest.com',
                    'Referer': validateUrl,
                },
                body: JSON.stringify({ password }),
                redirect: 'manual',
            });

            if (step2.status === 422) {
                return res.json({ error: 'Wrong password' });
            }
            if (step2.status !== 302) {
                await step2.text().catch(() => {});
                return res.json({ error: `Password validation failed (HTTP ${step2.status})` });
            }

            const cookies2 = extractImgchestCookies(step2.headers);
            const finalXsrf = cookies2.xsrfToken || cookies1.xsrfToken;
            const finalSession = cookies2.session || cookies1.session;

            // Step 3: GET the unlocked post page
            const step3 = await fetch(postUrl, {
                headers: {
                    'User-Agent': IMGCHEST_UA,
                    'Accept': 'text/html',
                    'Cookie': `XSRF-TOKEN=${finalXsrf}; image_chest_session=${finalSession}`,
                },
            });

            if (!step3.ok) {
                return res.json({ error: `Failed to fetch unlocked post (HTTP ${step3.status})` });
            }

            const images = parseImgchestImages(await step3.text());
            if (images.length === 0) {
                return res.json({ error: 'No images found after password validation' });
            }

            console.log(`[cl-helper] Imgchest unlocked ${postId}: ${images.length} images`);
            res.json({ images });
        } catch (err) {
            console.error('[cl-helper] Imgchest unlock error:', err.message);
            res.status(502).json({ error: 'Failed to reach imgchest' });
        }
    });

    console.log('[cl-helper] Character Library helper plugin loaded');

    // ---- Async: discover image processing library (after all routes registered) ----
    _imagesDir = resolveImagesDir();
    if (_imagesDir) {
        _cacheDir = join(_imagesDir, '..', 'cl_thumbs');
        const ok = await initImageLib();
        _thumbsReady = ok;
        if (ok) {
            console.log(`[cl-helper] Gallery thumbnails enabled (images: ${_imagesDir})`);
        } else {
            console.log('[cl-helper] Gallery thumbnails disabled (jimp not available)');
        }
    } else {
        console.log('[cl-helper] Gallery thumbnails disabled (images directory not found)');
    }
}
