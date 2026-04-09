// cl-helper — SillyTavern server plugin for Character Library
//
// Provides server-side request proxying for providers that require
// custom headers (like Origin) that browsers forbid setting.

import { randomUUID } from 'node:crypto';

export const info = {
    id: 'cl-helper',
    name: 'Character Library Helper',
    description: 'Auth and request proxying for the Character Library extension.',
};

const PYGMALION_AUTH_URL = 'https://auth.pygmalion.chat/session';
const PYGMALION_ORIGIN = 'https://pygmalion.chat';

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    router.get('/health', (_req, res) => {
        res.json({ ok: true, version: '1.0.0' });
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

    console.log('[cl-helper] Character Library helper plugin loaded');
}
