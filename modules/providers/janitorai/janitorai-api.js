// JanitorAI API helpers

import { slugify, stripHtml, decodeHtmlEntities, CL_HELPER_PLUGIN_BASE, classifyErrorPage } from '../provider-utils.js';
import { getValidJanitoraiToken, janitoraiForceRefresh } from '../janitor-session.js';
import CoreAPI from '../../core-api.js';

export { slugify, stripHtml, decodeHtmlEntities };

// ========================================
// CONSTANTS
// ========================================

export const JANITORAI_SITE_BASE = 'https://janitorai.com';
export const HAMPTER_API_BASE = `${JANITORAI_SITE_BASE}/hampter`;
export const JANITORAI_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

// Server-fixed; any page-size param is ignored.
export const HAMPTER_PAGE_SIZE = 34;

export const HAMPTER_SORTS = ['latest', 'trending', 'trending24', 'popular', 'relevance'];
export const HAMPTER_MODES = ['all', 'sfw', 'nsfw'];

/**
 * @param {Object} hit - listing row or detail payload
 * @param {number} [opts.width] - resized variant for grid cards; omit for full size
 * @returns {string|null}
 */
export function resolveJanitoraiAvatarUrl(hit, opts = {}) {
    // raw_avatar is often absent; a preference, not a requirement.
    const name = (opts.preferOriginal && hit?.raw_avatar) || hit?.avatar || '';
    if (!name || typeof name !== 'string') return null;
    let url = /^https?:\/\//i.test(name) ? name : `${JANITORAI_IMAGE_BASE}${name}`;
    const safety = CoreAPI.isUrlSafeForDownload(url);
    if (!safety.ok) return null;
    // Full-size avatars stall the grid; request a resized variant.
    if (opts.width) url += (url.includes('?') ? '&' : '?') + `width=${opts.width}`;
    return url;
}

export function janitoraiCharacterUrl(id, name) {
    const slug = slugify(name || '') || 'character';
    return `${JANITORAI_SITE_BASE}/characters/${id}_${slug}`;
}

// ========================================
// TRANSPORT
// ========================================

function hampterError(message, code, status) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    return err;
}

function gatedError(hadToken, status) {
    return hadToken
        ? hampterError('JanitorAI session expired', 'HAMPTER_TOKEN_EXPIRED', status)
        : hampterError('JanitorAI requires signing in for this request', 'HAMPTER_LOGIN_REQUIRED', status);
}

/**
 * Retries once on a 401 with a token, so callers need not handle mid-flight expiry.
 * @param {string} path - under /hampter, leading slash included (eg. '/characters?page=1')
 * @param {boolean} [opts.anon=false] - send no Authorization header
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Object>} parsed JSON
 * @throws {Error} code HAMPTER_LOGIN_REQUIRED | HAMPTER_TOKEN_EXPIRED | HAMPTER_RATE_LIMITED | HAMPTER_BLOCKED
 */
export async function hampterFetch(path, opts = {}) {
    const { anon = false, signal, method, jsonBody } = opts;
    const wire = { method, jsonBody };
    const token = anon ? '' : ((await getValidJanitoraiToken()) || '');
    let res = await paced(path, token, signal, wire);
    if (res.status === 401 && token) {
        const fresh = (await janitoraiForceRefresh()) || '';
        if (fresh) {
            const retry = await paced(path, fresh, signal, wire);
            return finishHampter(retry, fresh);
        }
    }
    return finishHampter(res, token);
}

const HAMPTER_RETRIES = 2;
const HAMPTER_BACKOFF_MS = [1500, 4000];
// Cap the server's Retry-After, or it could park the UI for minutes.
const HAMPTER_MAX_WAIT_MS = 15000;

/** Retry-After is legally delta-seconds or an HTTP-date. @returns {number|null} ms, null if absent */
function parseRetryAfter(raw) {
    const v = String(raw || '').trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) return Number(v) * 1000;
    const when = Date.parse(v);
    if (Number.isNaN(when)) return null;
    return Math.max(0, when - Date.now());
}

async function paced(path, token, signal, wire) {
    let res = await hampterAttempt(path, token, signal, wire);
    for (let attempt = 0; res.status === 429 && attempt < HAMPTER_RETRIES; attempt++) {
        const asked = parseRetryAfter(res.retryAfter);
        const wait = asked === null ? HAMPTER_BACKOFF_MS[attempt] : asked;
        if (wait > HAMPTER_MAX_WAIT_MS) break;
        await sleep(wait, signal);
        res = await hampterAttempt(path, token, signal, wire);
    }
    return res;
}

/** Abortable so a cancelled browse doesn't sit out the backoff. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        function onAbort() { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** The waiting-room page inlines its own estimate; the number sits past the snippet cap so parse the full body. */
function parseQueueWait(body) {
    const m = /const\s+waitTime\s*=\s*(\d+)/.exec(body || '');
    if (!m || /waitTimeKnown\s*=\s*false/.test(body || '')) return null;
    return Number(m[1]);
}

function classifiedHampterError(fallback, res) {
    const classified = classifyErrorPage(res.body, res.status);
    const err = hampterError(classified || fallback, 'HAMPTER_BLOCKED', res.status);
    err.classified = !!classified;
    err.bodySnippet = (res.body || '').slice(0, 300);
    err.browserError = res.browserError || '';
    if (classified && /waiting room/i.test(classified)) err.queueWaitMinutes = parseQueueWait(res.body);
    return err;
}

function finishHampter(res, token) {
    if (res.status === 401) throw gatedError(!!token, 401);
    // Its own code, or the generic branch below would call it a Cloudflare block.
    if (res.status === 429) throw hampterError('JanitorAI is rate limiting this session', 'HAMPTER_RATE_LIMITED', 429);
    // Without classifying, a Cloudflare interstitial arrives as a bare status code.
    if (!res.ok) {
        throw classifiedHampterError(res.status ? `JanitorAI HTTP ${res.status}` : 'JanitorAI request failed', res);
    }
    // /following/unfollow answers 201 with an empty body; parsing that would read as a failure.
    if (!res.body) return null;
    try {
        return JSON.parse(res.body);
    } catch {
        // A 200 carrying HTML is the challenge, served through a transport that did not flag it.
        throw classifiedHampterError('JanitorAI returned a non-JSON body', res);
    }
}

async function hampterAttempt(path, token, signal, wire = {}) {
    const url = `${HAMPTER_API_BASE}${path}`;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Browser first: it carries the cf_clearance cookie. browserError is kept for the fall-through message.
    let browserError = '';
    if (hasBrowserEndpoint()) {
        let res = null;
        try { res = await browserFetch(path, token, undefined, wire); } catch (e) { browserError = e?.message || 'unreachable'; res = null; }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (res) return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body, retryAfter: res.retryAfter || '' };
    }

    // Deliberately not fetchWithProxy: the /proxy/ leg is server-side and never passes this gate.
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init = { headers, signal, method: wire.method || 'GET' };
    if (wire.jsonBody !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(wire.jsonBody);
    }
    let response = null;
    try {
        response = await fetch(url, init);
    } catch (e) {
        // Abort is caller intent, not a transport failure; let it propagate.
        if (e?.name === 'AbortError') throw e;
        response = null;
    }
    if (!response) return { ok: false, status: 0, body: '', browserError };
    const body = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, body, retryAfter: response.headers.get('retry-after') || '', browserError };
}

// ========================================
// BROWSE / SEARCH
// ========================================

/**
 * @param {string} [opts.sort='popular'] - one of HAMPTER_SORTS
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {string} [opts.mode='all'] - one of HAMPTER_MODES
 * @param {number[]} [opts.tagIds] - AND-combined
 * @param {number[]} [opts.excludeTagIds]
 * @param {string[]} [opts.creatorIds] - OR-combined
 * @param {boolean} [opts.following] - followed-creators feed
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchJanitoraiCharacters(opts = {}) {
    const {
        sort = 'popular', page = 1, search = '', mode = 'all',
        tagIds = [], excludeTagIds = [], creatorIds = [], following = false, signal,
    } = opts;

    const params = new URLSearchParams();
    params.set('page', String(page));
    if (following) {
        // following=true is its own filter and carries NO sort (ranked sorts would gut the feed).
        params.set('language', 'en');
        params.set('following', 'true');
        params.set('mode', HAMPTER_MODES.includes(mode) ? mode : 'all');
    } else {
        // Clamp: an unknown sort/mode is a 400, and a persisted retired option would break the view.
        params.set('sort', HAMPTER_SORTS.includes(sort) ? sort : 'popular');
        params.set('mode', HAMPTER_MODES.includes(mode) ? mode : 'all');
        if (search) params.set('search', search);
        for (const id of tagIds) params.append('tag_id[]', String(id));
        for (const id of excludeTagIds) params.append('excluded_tag_id[]', String(id));
        for (const id of creatorIds) params.append('user_id[]', String(id));
    }

    const data = await hampterFetch(`/characters?${params}`, { signal });
    return {
        characters: (data?.data || []).map(normalizeHampterHit),
        total: data?.total || 0,
        page: data?.page || page,
        pageSize: data?.size || HAMPTER_PAGE_SIZE,
    };
}

/**
 * @param {string} id
 * @returns {Promise<Object|null>} raw detail payload, or null when gone/unreadable
 */
export async function fetchJanitoraiCharacter(id, opts = {}) {
    if (!id) return null;
    try {
        return await hampterFetch(`/characters/${encodeURIComponent(id)}`, opts);
    } catch (err) {
        // Auth and rate-limit problems are the caller's business; a plain 404 is not.
        if (err?.status === 404) return null;
        throw err;
    }
}

/**
 * @param {string} name
 * @returns {Promise<Array<{id,name,username,avatar,characterCount,followersCount,verified}>>}
 */
export async function searchJanitoraiCreators(name, opts = {}) {
    const q = (name || '').trim();
    if (!q) return [];
    const params = new URLSearchParams({ mode: 'foryou', page: '1', search: q });
    const data = await hampterFetch(`/profiles/search?${params}`, { signal: opts.signal });
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.filter(r => r && r.id).map(r => ({
        id: r.id,
        name: decodeHtmlEntities(r.user_name || ''),
        username: r.user_name || '',
        avatar: r.avatar || '',
        characterCount: r.character_count || 0,
        followersCount: r.followers_count || 0,
        verified: !!r.is_verified,
    }));
}

/** Pass a detail payload, not a listing row: listing showdefinition is always false. */
export function hasHiddenDefinition(detail) {
    if (!detail) return false;
    return !detail.personality;
}

/**
 * Locked definition AND no proxy: the state the prompt capture cannot reach, because proxy mode
 * is the only mode janitorai hands the assembled prompt back in. The character DETAIL names the
 * flag `allow_proxy`; a listing ROW names it `is_proxy_enabled`. Check both on both sources so the
 * grid banner (has the row) and import (has only the detail) agree. Confirmed correlation, not
 * advisory: these cards were seen to fail extraction with "proxies are forbidden".
 */
export function isLockedNoProxy(detail, hit) {
    if (!hasHiddenDefinition(detail)) return false;
    const proxy = detail?.is_proxy_enabled ?? detail?.allow_proxy
        ?? hit?.is_proxy_enabled ?? hit?.allow_proxy;
    return proxy === false;
}

function normalizeHampterHit(hit) {
    const tagNames = [
        ...(hit.tags || []).map(t => ({ name: t.name, slug: t.slug || t.name?.toLowerCase(), id: t.id })),
        ...(hit.custom_tags || []).map(t => typeof t === 'string'
            ? { name: t, slug: t.toLowerCase() }
            : { name: t.name || '', slug: t.slug || '' }),
    ];

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.chat_name || hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        raw_avatar: hit.raw_avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creator_name || ''),
        creator_id: hit.creator_id || '',
        created_at: hit.created_at || hit.first_published_at || '',
        is_nsfw: hit.is_nsfw || false,
        chat_count: hit.stats?.chat || 0,
        message_count: hit.stats?.message || 0,
        total_tokens: hit.total_tokens || hit.token_counts?.total_tokens || 0,
        // Kept raw, not defaulted: absent and false mean different things to isLockedNoProxy, and
        // the row is the only place this is believable (a row's showdefinition always lies).
        is_proxy_enabled: hit.is_proxy_enabled,
    };
}

// ========================================
// TAGS
// ========================================

let _tagCatalogue = null;
let _tagCatalogueInFlight = null;

/**
 * Cached for the session; the catalogue is effectively static.
 * @returns {Promise<Array<{id:number,name:string,slug:string,description:string}>>}
 */
export async function fetchJanitoraiTags() {
    if (_tagCatalogue) return _tagCatalogue;
    if (_tagCatalogueInFlight) return _tagCatalogueInFlight;
    _tagCatalogueInFlight = (async () => {
        try {
            const data = await hampterFetch('/tags', { anon: true });
            const list = Array.isArray(data) ? data : (data?.data || []);
            _tagCatalogue = list
                .filter(t => t && typeof t.id === 'number')
                .map(t => ({ id: t.id, name: t.name || '', slug: t.slug || '', description: t.description || '' }));
            return _tagCatalogue;
        } catch {
            return [];   // a missing catalogue degrades filters to client-side, never breaks browse
        } finally {
            _tagCatalogueInFlight = null;
        }
    })();
    return _tagCatalogueInFlight;
}

/** One cheap poll through the live transport; the request itself refreshes the waiting-room cookie. */
export async function pingHampterQueue() {
    try {
        await hampterFetch('/tags', { anon: true });
        return { through: true, waitMinutes: null };
    } catch (e) {
        // Any non-queue failure also ends the wait: reloading then surfaces the new truth.
        const queued = /waiting room/i.test(e?.message || '');
        return { through: !queued, waitMinutes: queued ? (e?.queueWaitMinutes ?? null) : null, error: e };
    }
}


/** Strip the leading emoji + space the site prefixes onto display names ("👨 Male" -> "male"). */
export function tagKey(s) {
    return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
}

/**
 * @param {string[]} names
 * @returns {Promise<{ids: number[], unresolved: string[]}>} unresolved must be filtered
 *   client-side; custom tags are free text and have no id.
 */
export async function resolveJanitoraiTagIds(names) {
    const wanted = (names || []).map(n => String(n || '').trim()).filter(Boolean);
    if (!wanted.length) return { ids: [], unresolved: [] };
    const cat = await fetchJanitoraiTags();
    const byKey = new Map();
    for (const t of cat) {
        byKey.set(tagKey(t.name), t.id);
        if (t.slug) byKey.set(tagKey(t.slug), t.id);
    }
    const ids = [];
    const unresolved = [];
    for (const n of wanted) {
        const id = byKey.get(tagKey(n));
        if (id === undefined) unresolved.push(n);
        else if (!ids.includes(id)) ids.push(id);
    }
    return { ids, unresolved };
}

// ========================================
// FOLLOWING
// ========================================

/**
 * @returns {Promise<Array<{id:string,name:string,avatar:string}>>}
 */
export async function fetchJanitoraiFollowing() {
    const data = await hampterFetch('/following/v2/myfollowing');
    const list = Array.isArray(data) ? data : (data?.data || data?.following || []);
    return list
        .filter(u => u && u.user_id)
        .map(u => ({
            id: u.user_id,
            name: decodeHtmlEntities(u.user_name || u.username || ''),
            avatar: u.avatar || '',
        }));
}

/**
 * @param {string} userId - creator uuid
 * @param {boolean} follow
 * @returns {Promise<boolean>}
 */
export async function setJanitoraiFollow(userId, follow) {
    if (!userId) return false;
    await hampterFetch(follow ? '/following/follow' : '/following/unfollow', {
        method: 'POST',
        jsonBody: { userId: String(userId) },
    });
    return true;
}

// ========================================
// BROWSER ENDPOINT (hidden-definition recovery)
// ========================================

export function getBrowserMode() {
    return CoreAPI.getSetting('janitoraiBrowserMode') || 'managed';
}

export function getBrowserEndpoint() {
    return (CoreAPI.getSetting('janitoraiBrowserEndpoint') || '').trim();
}

/** Whether a browser is configurable, not whether one is up: managed mode starts it lazily. */
export function hasBrowserEndpoint() {
    return getBrowserMode() === 'managed' ? true : !!getBrowserEndpoint();
}

/** managed:true lets cl-helper own the lazy browser start. */
function browserTarget(endpoint) {
    if (endpoint) return { endpoint };
    if (getBrowserMode() === 'managed') return { managed: true };
    return { endpoint: getBrowserEndpoint() };
}

async function callHelper(route, body, { timeoutMs = 180000, signal = null } = {}) {
    // apiRequest has no timeout; the abort signal is the only bound on a wedged browser.
    // Pass only `signal`: a `headers` opt would clobber the injected CSRF token.
    let resp;
    try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        resp = await CoreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}${route}`, 'POST', body, {
            signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
        });
    } catch (e) {
        // The reader's own cancel is not a service failure and must not be reported as one.
        if (signal?.aborted) { const err = new Error('Cancelled'); err.cancelled = true; throw err; }
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error('The browser endpoint did not answer in time.');
        }
        throw new Error('Could not reach cl-helper. Is the plugin installed and SillyTavern restarted?');
    }
    if (!resp) throw new Error('cl-helper did not respond. Is the plugin installed and SillyTavern restarted?');
    let data = null;
    try { data = await resp.json(); } catch { /* non-JSON body */ }
    if (!resp.ok || data?.ok === false) {
        throw new Error(data?.error || `cl-helper returned HTTP ${resp.status}`);
    }
    return data;
}

/**
 * @returns {Promise<{ok: boolean, checks: Array<{key,label,ok,detail,optional?}>, browser?: string}>}
 */
export async function testBrowserEndpoint(endpoint) {
    // Not callHelper: it throws on { ok: false } and discards the body, but the per-check list must survive a failed probe.
    let resp;
    try {
        resp = await CoreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}/janitorai-browser-test`, 'POST',
            browserTarget(endpoint), { signal: AbortSignal.timeout(120000) });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            return { ok: false, checks: [], error: 'The browser did not answer in time.' };
        }
        return { ok: false, checks: [], error: 'Could not reach cl-helper. Is the plugin installed and SillyTavern restarted?' };
    }
    const data = await resp?.json().catch(() => null);
    return data || { ok: false, checks: [], error: `cl-helper returned HTTP ${resp?.status ?? 0}` };
}

/**
 * Turnstile is domain-locked to janitorai.com, so login must run in the hosted browser.
 * @returns {Promise<{session: string}>} the raw sb-...-auth-token cookie value
 */
export async function browserLogin(email, password, endpoint) {
    return callHelper('/janitorai-browser-login', {
        ...browserTarget(endpoint), email, password,
    }, { timeoutMs: 120000 });
}

/** Signs the browser in with a session we already hold, so extraction works after a pasted token. */
export async function browserSetSession(endpoint) {
    const token = (await getValidJanitoraiToken()) || '';
    if (!token) return { ok: false, error: 'No JanitorAI session is stored' };
    return callHelper('/janitorai-browser-session', {
        ...browserTarget(endpoint),
        token,
        refreshToken: CoreAPI.getSetting('janitoraiRefreshToken') || '',
    }, { timeoutMs: 90000 });
}

/** Drops the account cookies from the browser, keeping its Cloudflare pass. */
export async function browserLogout(endpoint) {
    return callHelper('/janitorai-browser-logout', browserTarget(endpoint), { timeoutMs: 60000 });
}

/**
 * Public definitions land on `detail` (extracted:false); withheld ones on `definition` (extracted:true).
 * @returns {Promise<{detail: Object, definition: string, extracted: boolean}>}
 */
export async function extractViaBrowser(characterId, endpoint, { signal } = {}) {
    // Refresh token rides along so cl-helper can rebuild a session cookie for the chat UI.
    const token = (await getValidJanitoraiToken()) || '';
    const refreshToken = CoreAPI.getSetting('janitoraiRefreshToken') || '';
    return callHelper('/janitorai-extract', {
        ...browserTarget(endpoint),
        characterId,
        token: token || undefined,
        refreshToken: refreshToken || undefined,
    }, { timeoutMs: 240000, signal });
}

// Button-sized. The detail belongs in the progress banner, not in a control that has to stay short.
export function recoverPhaseLabel(phase) {
    return {
        setup: 'Opening a chat...',
        definition: 'Extracting...',
        extras: 'Extracting...',
        done: 'Building the card...',
    }[phase] || 'Extracting...';
}

// Banner-sized: the live count is what distinguishes slow from hung on a multi-minute turn.
export function recoverProgressText(phase, detail = null) {
    const base = {
        setup: 'Opening a throwaway chat with this character.',
        definition: 'Asking the JanitorAI model to repeat its definition. This is the slow part.',
        extras: 'Recovering the remaining sections.',
        done: 'Building the card.',
    }[phase] || 'Recovering.';
    if (phase !== 'definition' && phase !== 'extras') return base;

    const bits = [];
    if (detail?.chars > 0) bits.push(`${detail.chars.toLocaleString()} characters so far`);
    if (detail?.elapsedMs >= 5000) {
        const s = Math.round(detail.elapsedMs / 1000);
        bits.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} elapsed`);
    }
    return bits.length ? `${base} ${bits.join(', ')}.` : base;
}

/**
 * Best effort for a locked definition whose creator forbids proxies. Returns MODEL OUTPUT under
 * janitorai's own field names; callers must keep it labelled as recovered, never treat it as the
 * creator's file. `onProgress(phase, detail)` receives coarse phases
 * ('setup'|'definition'|'extras'|'done') plus `{chars, elapsedMs}` on every poll tick, for a
 * progress hint; it is best-effort and never blocks the result.
 * @returns {Promise<{personality: string, scenario: string, exampleDialogs: string, firstMessage: string, recovered: string}>}
 */
export async function recoverViaBrowser(characterId, endpoint, onProgress, { signal } = {}) {
    const token = (await getValidJanitoraiToken()) || '';
    const refreshToken = CoreAPI.getSetting('janitoraiRefreshToken') || '';
    const jobId = `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    // Aborting the POST alone only hangs up on the run; the server keeps driving the account. Tell
    // it to stop so it deletes the throwaway chat and persona on its way out.
    const onAbort = () => {
        CoreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}/janitorai-recover-cancel`, 'POST', { jobId })
            .catch(() => { /* best effort; the run also stops when the page goes */ });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Poll the coarse phase while the long POST runs. Best-effort, stops when it settles.
    let polling = !!onProgress;
    const pollLoop = (async () => {
        const startedAt = Date.now();
        let phaseAt = startedAt;
        let last = null;
        while (polling) {
            await new Promise(r => setTimeout(r, 2500));
            if (!polling) break;
            try {
                const r = await CoreAPI.apiRequest(
                    `${CL_HELPER_PLUGIN_BASE}/janitorai-recover-progress?job=${encodeURIComponent(jobId)}`, 'GET');
                const j = await r.json();
                if (!j?.phase) continue;
                if (j.phase !== last) { last = j.phase; phaseAt = Date.now(); }
                // Every tick, not just on a phase change: a label that never moves reads as a hang.
                onProgress(j.phase, { chars: j.chars || 0, elapsedMs: Date.now() - phaseAt });
            } catch { /* progress is a hint, not a requirement */ }
        }
    })();

    try {
        // One turn per field plus continuations, and a single turn can legitimately stream for
        // minutes: budget for the whole run, not for one turn.
        return await callHelper('/janitorai-recover', {
            ...browserTarget(endpoint),
            characterId,
            jobId,
            token: token || undefined,
            refreshToken: refreshToken || undefined,
        }, { timeoutMs: 2700000, signal });
    } finally {
        polling = false;
        signal?.removeEventListener('abort', onAbort);
        await pollLoop.catch(() => {});
    }
}

/**
 * `path` is hampter-relative; the /hampter prefix is added here because cl-helper validates an
 * origin-relative path.
 * @returns {Promise<{status: number, body: string}>}
 */
export async function browserFetch(path, token, endpoint, opts = {}) {
    const data = await callHelper('/janitorai-browser-fetch', {
        ...browserTarget(endpoint),
        path: `/hampter${path}`,
        token: token || undefined,
        method: opts.method || undefined,
        jsonBody: opts.jsonBody,
    }, { timeoutMs: 90000 });
    return { status: data.status || 0, body: data.body || '', retryAfter: data.retryAfter || '' };
}

// ========================================
// V2 CARD BUILDER
// ========================================

const HAMPTER_SCRIPT_PATH_RE = /^\/hampter\/script\/[a-f0-9-]{36}$/i;
const UUID_RE = /^[a-f0-9-]{36}$/i;

export function hasUnfetchedLorebook(character) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts)) return false;
    return scripts.some(s => s && s.type === 'lorebook' && s.is_public && !s.script);
}

/**
 * Lorebooks arrive as stubs; content lives behind a per-script fetch keyed by `api_path` or `id`.
 * @param {Object} character - anything carrying a `scripts` array
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<boolean>} true when every listed lorebook now has content
 */
export async function hydrateJanitoraiScripts(character, { signal } = {}) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts) || !scripts.length) return true;
    for (const s of scripts) {
        if (!s || s.type !== 'lorebook' || !s.is_public || s.script) continue;
        // Listed publicly but the creator locked the content; hampter serves metadata only.
        if (s.is_code_public === false) continue;
        let path = null;
        if (typeof s.api_path === 'string' && HAMPTER_SCRIPT_PATH_RE.test(s.api_path)) path = s.api_path.replace('/hampter', '');
        else if (typeof s.id === 'string' && UUID_RE.test(s.id)) path = `/script/${s.id}`;
        if (!path) continue;
        try {
            // One locked lorebook must not fail the whole card.
            const full = await hampterFetch(path, { signal, anon: true });
            if (typeof full?.script === 'string' && full.script) {
                s.script = full.script;
                if (!s.settings && typeof full.settings === 'string') s.settings = full.settings;
            }
        } catch { /* leave unfetched */ }
    }
    return !hasUnfetchedLorebook(character);
}

/**
 * Requires content: run hydrateJanitoraiScripts first, or a stub-only card yields null.
 * @param {Object} character - anything carrying a `scripts` array
 * @returns {Object|null}
 */
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
 * JanitorAI mislabels fields: `personality` is the definition body, `description` the public
 * blurb, so they map to V2 description and creator_notes.
 * @param {Object} detail - /hampter/characters/{id} payload
 * @param {string} [opts.definition] - recovered by extraction, overrides an empty `personality`
 * @param {string} [opts.firstMessage] - likewise; a withheld definition withholds this too
 * @returns {Object|null} V2-wrapped card
 */
export function buildV2FromJanitorai(detail, opts = {}) {
    if (!detail) return null;

    const tagNames = [
        ...(detail.tags || []).map(t => (typeof t === 'string' ? t : t?.name || '')),
        ...(detail.custom_tags || []).map(t => (typeof t === 'string' ? t : t?.name || '')),
    ].map(t => decodeHtmlEntities(t)).filter(Boolean);

    // A no-proxy recovery arrives under janitorai's own field names and is MODEL OUTPUT, so it
    // lands on its own branch: every field comes from the recovery, and the card is stamped.
    const rec = opts.recovered || null;
    const description = rec?.personality || opts.definition || detail.personality || '';
    // Padded with nulls and invisible-character placeholders that would import as blank greetings.
    // A LOCKED card strips greetings from the standalone character endpoint, so a no-proxy recovery
    // supplies them from the chat read instead; ordinary hidden cards keep first_messages[] ungated.
    const greetingSource = (detail.first_messages && detail.first_messages.length)
        ? detail.first_messages
        : (rec?.firstMessages || []);
    const rawGreetings = greetingSource
        .map(g => (typeof g === 'string' ? g : g?.first_message || g?.message || ''))
        .filter(g => g && /[\p{L}\p{N}]/u.test(g));
    const firstMes = detail.first_message || opts.firstMessage || rec?.firstMessage || rawGreetings[0] || '';
    const altGreetings = rawGreetings.filter(g => g !== firstMes);

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: decodeHtmlEntities(detail.chat_name || detail.name || 'Unknown'),
            description,
            personality: '',
            scenario: detail.scenario || rec?.scenario || '',
            first_mes: firstMes,
            mes_example: detail.example_dialogs || rec?.exampleDialogs || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: decodeHtmlEntities(detail.description || ''),
            creator: decodeHtmlEntities(detail.creator_name || ''),
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: altGreetings,
            extensions: {
                janitorai: {
                    id: detail.id,
                    creatorId: detail.creator_id || null,
                    creatorName: decodeHtmlEntities(detail.creator_name || '') || null,
                    definitionHidden: hasHiddenDefinition(detail) || undefined,
                    extracted: opts.definition ? true : undefined,
                    // Provenance travels with the card: this text came from the site's model, not
                    // the creator's file, so update checks can refuse to diff it and a later real
                    // extraction can supersede it.
                    recovered: rec ? 'jllm' : undefined,
                    recoveredAt: rec ? new Date().toISOString() : undefined,
                },
            },
            character_book: extractCharacterBookFromScripts(detail) || undefined,
        },
    };
}
