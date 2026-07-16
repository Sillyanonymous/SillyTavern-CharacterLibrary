// Shared DataCat API utilities - used by datacat-provider.js and datacat-browse.js
//
// Sections: Network, Metadata, Browse/Search, Tags, V2 Card Builder, Extraction, MeiliSearch

import CoreAPI from '../../core-api.js';
import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml, fetchWithProxy } from '../provider-utils.js';
import { getSearchToken, JANNY_SEARCH_URL, JANNY_SITE_BASE, TAG_MAP as JANNY_TAG_MAP } from '../janny/janny-api.js';
import { resolveSaucepanImageUrl, SAUCEPAN_CDN_PROXY_BASE } from '../saucepan/saucepan-api.js';

export { slugify, stripHtml, JANNY_TAG_MAP };

/**
 * Decode common HTML entities. JanitorAI's listing endpoints (Meili + Hampter)
 * return creator-notes HTML escaped (&lt;p&gt;...&lt;/p&gt;) rather than raw,
 * so consumers expecting real HTML must decode first.
 */
function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

// ========================================
// CONSTANTS
// ========================================

export const DATACAT_API_BASE = 'https://datacat.run';

// DataCat aggregates from multiple sources. Each has its own avatar URL convention:
//   - JanitorAI: bare filename, served from ella.janitorai.com
//   - Saucepan: full https URL (saucepan.ai/cdn/...) embedded in the avatar field
// Future sources should be added here. Use resolveDatacatAvatarUrl() to get a usable URL.
export const DATACAT_JANITOR_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

/**
 * Resolve a character's avatar URL based on its source.
 * Saucepan and other future sources embed full URLs in the avatar field;
 * JanitorAI uses bare filenames that need the ella.janitorai.com prefix.
 * @param {Object} hit - DataCat character object (listing or detail)
 * @returns {string|null} Full URL (or local proxy path) or null if no avatar
 */
export function resolveDatacatAvatarUrl(hit) {
    const avatar = hit?.avatar;
    if (!avatar || typeof avatar !== 'string') return null;
    const proxied = resolveSaucepanImageUrl(avatar);
    // Covers freshly rewritten URLs and already-proxied paths alike.
    if (proxied.startsWith(SAUCEPAN_CDN_PROXY_BASE)) return proxied;
    const url = /^https?:\/\//i.test(avatar) ? avatar : `${DATACAT_JANITOR_IMAGE_BASE}${avatar}`;
    const safety = CoreAPI.isUrlSafeForDownload(url);
    if (!safety.ok) return null;
    return url;
}

// Minimum token threshold for quality filtering (matches DataCat's own frontend default)
export const MIN_TOTAL_TOKENS = 889;

// ========================================
// NETWORK
// ========================================

const DC_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/dc-proxy`;

let _apiRequest = null;
let _getSavedToken = null;
let _bootstrapInFlight = null;

/**
 * Bind the CoreAPI.apiRequest function for use in proxied requests.
 * Called once from the provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter that returns the persisted DataCat session token (or null).
 * Lets dcFetch lazy-bootstrap a session for out-of-browse-view callers
 * (link modal preview, gallery download, gallery-sync) without coupling
 * the api file to CoreAPI/settings directly. Called once from init().
 */
export function setSavedTokenGetter(fn) { _getSavedToken = fn; }

/**
 * Push the saved token (or a fresh anonymous one) into cl-helper. Returns
 * true if a usable session is now active. Concurrent callers share the
 * in-flight bootstrap promise so we never run more than one /dc-init at
 * a time. Reset on completion so a future 401 can re-arm.
 */
async function tryBootstrapSession() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try {
            const savedToken = _getSavedToken?.() ?? null;
            return !!(await initDcSession(savedToken));
        } catch {
            return false;
        } finally {
            _bootstrapInFlight = null;
        }
    })();
    return _bootstrapInFlight;
}

/**
 * Fetch a DataCat API path through the cl-helper plugin proxy.
 * On 401/403, attempts to bootstrap a session once and retries.
 * @param {string} apiPath - Path relative to datacat.run (e.g. /api/characters/recent-public?...)
 * @returns {Promise<Response>}
 */
async function dcFetch(apiPath) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound (cl-helper required)');
    let resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
    if (resp.status === 401 || resp.status === 403) {
        if (await tryBootstrapSession()) {
            resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
        }
    }
    if (!resp.ok) {
        let body = '';
        try { body = await resp.clone().text(); } catch { /* ignore */ }
        console.warn(`[DataCat] dcFetch ${resp.status} for ${apiPath}`, body.slice(0, 500));
    }
    return resp;
}

/**
 * Check if the cl-helper plugin is available.
 * @returns {Promise<boolean>}
 */
export async function checkDcPluginAvailable() {
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

/**
 * Try to restore a saved DataCat session token via cl-helper.
 * Pushes the saved token to cl-helper and validates it.
 * @param {string} savedToken - Previously saved session token
 * @returns {Promise<boolean>} true if the saved token is still valid
 */
async function restoreSavedToken(savedToken) {
    if (!savedToken || typeof savedToken !== 'string') return false;
    try {
        const setResp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-set-token`, 'POST', { token: savedToken })
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-set-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: savedToken }),
            });
        if (!setResp.ok) return false;

        const valResp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!valResp.ok) return false;
        const data = await valResp.json();
        return data?.valid === true;
    } catch {
        return false;
    }
}

/**
 * Initialize a DataCat session via cl-helper.
 * If a saved token is provided, tries to restore it first.
 * Otherwise (or if saved token is invalid), requests a fresh session.
 * Returns the active token string on success so the caller can persist it.
 * @param {string} [savedToken] - Previously saved session token to try first
 * @param {boolean} [force] - Force a new token even if one is cached
 * @returns {Promise<string|null>} The active session token, or null on failure
 */
export async function initDcSession(savedToken, force = false) {
    try {
        // Try restoring a saved token first (unless forcing refresh)
        if (savedToken && !force) {
            const restored = await restoreSavedToken(savedToken);
            if (restored) return savedToken;
        }

        const body = force ? JSON.stringify({ force: true }) : undefined;
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-init`, 'POST', force ? { force: true } : undefined)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-init`, {
                method: 'POST',
                ...(force ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
            });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.ok && data?.token) return data.token;
        return null;
    } catch {
        return null;
    }
}

/**
 * Validate the current DataCat session on cl-helper.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateDcSession() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!resp.ok) return { valid: false, reason: 'request failed' };
        return await resp.json();
    } catch {
        return { valid: false, reason: 'network error' };
    }
}

/**
 * Clear the DataCat session token from cl-helper.
 * @returns {Promise<boolean>}
 */
export async function clearDcSession() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-clear-token`, 'POST')
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/dc-clear-token`, { method: 'POST' });
        return resp.ok;
    } catch {
        return false;
    }
}

// ========================================
// JANITORAI ACCOUNT AUTH (Supabase GoTrue)
// ========================================
// Unlocks page 2+ of the Hampter Trending/Popular sorts. JanitorAI auth is Supabase; the
// anon key below is their PUBLIC publishable key (role:anon), shipped in the janitorai
// frontend bundle, safe to embed. Login/refresh hit supabase.co directly (CORS *, and it is
// NOT behind JanitorAI's Cloudflare bot gate), so the whole flow is client-side, no cl-helper.
// Access tokens live ~3h; the refresh token rotates on every use, so callers must persist the
// new one each refresh. Pure HTTP here; the stateful session layer lives in datacat-provider.

const JANITORAI_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const JANITORAI_AUTH_BASE = 'https://mcmzxtzommpnxkynddbo.supabase.co/auth/v1';
const JANITORAI_TOKEN_URL = `${JANITORAI_AUTH_BASE}/token`;

function janitoraiAuthHeaders() {
    return { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${JANITORAI_ANON_KEY}`, 'Content-Type': 'application/json' };
}

/** Decode a JanitorAI access-token JWT's claims (email + exp ms). Empty on failure. */
export function decodeJanitoraiClaims(jwt) {
    try {
        const p = JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return { email: p.email || '', expMs: (p.exp || 0) * 1000 };
    } catch { return { email: '', expMs: 0 }; }
}

// Direct password login is not usable: JanitorAI gates it behind Cloudflare Turnstile,
// whose sitekey is domain-locked to janitorai.com and cant be solved from CL's origin. So the
// session is seeded from the sb-auth-auth-token cookie (grabbed once from a real browser login,
// where the user already solved Turnstile), and kept alive by the captcha-free refresh grant.

function janitoraiB64decode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
}

/**
 * Extract the token pair from a pasted JanitorAI session: the sb-auth-auth-token cookie value
 * (base64-<json>), a raw session JSON, or a bare access-token JWT (no refresh; short-lived).
 * @returns {{access_token: string, refresh_token: string}|null}
 */
export function parseJanitoraiSession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s.startsWith('base64-')) s = s.slice('base64-'.length);
    let json = null;
    try {
        const dec = janitoraiB64decode(s);
        if (dec.includes('access_token')) json = JSON.parse(dec);
    } catch { /* not base64 json */ }
    if (!json && s.startsWith('{')) {
        try { json = JSON.parse(s); } catch { /* not json */ }
    }
    if (json?.access_token) {
        return { access_token: json.access_token, refresh_token: json.refresh_token || '' };
    }
    const jm = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jm ? { access_token: jm[0], refresh_token: '' } : null;
}

/**
 * Exchange a (single-use, rotating) refresh token for a fresh pair. `dead` marks a
 * revoked/expired refresh token so the caller can clear the stored session.
 * @returns {Promise<{access_token: string, refresh_token: string, dead?: boolean}>}
 */
export async function janitoraiRefreshGrant(refreshToken) {
    if (!refreshToken) return { access_token: '', refresh_token: '', dead: true };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_TOKEN_URL}?grant_type=refresh_token`, {
            method: 'POST', headers: janitoraiAuthHeaders(), body: JSON.stringify({ refresh_token: refreshToken }),
        });
    } catch (e) {
        return { access_token: '', refresh_token: '', dead: false }; // transient; keep the token for retry
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
        const dead = resp.status === 400 || resp.status === 401;
        return { access_token: '', refresh_token: '', dead };
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken };
}

/**
 * Check an access token server-side against the auth service. Kept off Cloudflare on
 * purpose: a hampter probe cant tell a bad token from a blocked preflight.
 * @returns {Promise<{valid: boolean, transient?: boolean}>} transient = auth service unreachable or erroring (429/5xx)
 */
export async function janitoraiVerifyToken(accessToken) {
    if (!accessToken) return { valid: false };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_AUTH_BASE}/user`, {
            headers: { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
        });
    } catch {
        return { valid: false, transient: true };
    }
    if (resp.ok) return { valid: true };
    return { valid: false, transient: resp.status === 429 || resp.status >= 500 };
}

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch full character data from the DataCat REST API.
 * @param {string} characterId - UUID
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint; required for freshly-extracted chars
 * @returns {Promise<Object|null>} character object or null
 */
export async function fetchDatacatCharacter(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const qs = sourceKind ? `?sourceKind=${encodeURIComponent(sourceKind)}` : '';
        const response = await dcFetch(`/api/characters/${characterId}${qs}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.character || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCharacter failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch the V2-like download payload for a character.
 * @param {string} characterId - UUID
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint
 * @returns {Promise<Object|null>} { data: { name, tags, avatar, ... } }
 */
export async function fetchDatacatDownload(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const params = new URLSearchParams({ t: String(Date.now()) });
        if (sourceKind) params.set('sourceKind', sourceKind);
        const response = await dcFetch(`/api/characters/${characterId}/download?${params.toString()}`);
        if (!response.ok) return null;
        return response.json();
    } catch (e) {
        console.error('[DataCat] fetchDatacatDownload failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch creator profile.
 * @param {string} creatorId - UUID
 * @returns {Promise<Object|null>}
 */
export async function fetchDatacatCreator(creatorId) {
    if (!creatorId) return null;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.creator || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreator failed:', creatorId, e);
        return null;
    }
}

/**
 * Fetch a creator's character list (paginated).
 * @param {string} creatorId - UUID
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sortBy='chat_count']
 * @returns {Promise<{total: number, list: Object[]}|null>}
 */
export async function fetchDatacatCreatorCharacters(creatorId, opts = {}) {
    if (!creatorId) return null;
    const { limit = 24, offset = 0, sortBy = 'chat_count' } = opts;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}/characters?limit=${limit}&offset=${offset}&sortBy=${sortBy}`);
        if (!response.ok) return null;
        const data = await response.json();
        return { total: data.total || 0, list: data.list || [] };
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreatorCharacters failed:', creatorId, e);
        return null;
    }
}

// ========================================
// BROWSE / SEARCH
// ========================================

/**
 * Fetch recent public characters (the main browse endpoint).
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {number[]} [opts.tagIds] - Active tag ID filters
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{totalCount: number, characters: Object[]}|null>}
 */
export async function fetchRecentPublic(opts = {}) {
    const { limit = 24, offset = 0, tagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/characters/recent-public?limit=${limit}&offset=${offset}&summary=1&minTotalTokens=${minTotalTokens}`;
        if (tagIds.length > 0) path += `&tagIds=${tagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { totalCount: data.totalCount || 0, characters: data.characters || [] };
    } catch (e) {
        console.error('[DataCat] fetchRecentPublic failed:', e);
        return null;
    }
}

/**
 * Fetch fresh/sorted characters from the /fresh endpoint.
 * Returns two time windows: last24h and thisWeek.
 * @param {Object} [opts]
 * @param {string} [opts.sortBy='score'] - 'score' | 'fresh' | 'chat_count'
 * @param {number} [opts.limit24=80] - Max characters for last-24h window
 * @param {number} [opts.limitWeek=20] - Max characters for this-week window
 * @returns {Promise<{sortBy: string, last24h: Object[], thisWeek: Object[]}|null>}
 */
export async function fetchFreshCharacters(opts = {}) {
    const { sortBy = 'score', limit24 = 80, limitWeek = 20 } = opts;
    try {
        const path = `/api/characters/fresh?summary=1&sortBy=${sortBy}&limit24=${limit24}&limitWeek=${limitWeek}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        const w = data.windows || {};
        return {
            sortBy: data.sortBy || sortBy,
            last24h: w.last24h?.characters || [],
            thisWeek: w.thisWeek?.characters || [],
        };
    } catch (e) {
        console.error('[DataCat] fetchFreshCharacters failed:', e);
        return null;
    }
}

/**
 * Fetch faceted tag list with counts (optionally narrowed by active tags).
 * @param {Object} [opts]
 * @param {number[]} [opts.activeTagIds] - Currently selected tag IDs (adjusts counts)
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{groups: Object[], tags: Object[]}|null>}
 */
export async function fetchFacetedTags(opts = {}) {
    const { activeTagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/tags/faceted?mode=recent&minTotalTokens=${minTotalTokens}`;
        if (activeTagIds.length > 0) path += `&activeTagIds=${activeTagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { groups: data.groups || [], tags: data.tags || [] };
    } catch (e) {
        console.error('[DataCat] fetchFacetedTags failed:', e);
        return null;
    }
}

// ========================================
// TAG HELPERS
// ========================================

/**
 * Extract plain tag names from DataCat tags.
 * Tags shape varies by source:
 *   - JanitorAI: array of { id, name, slug } objects with emoji-prefixed names
 *   - Saucepan: array of plain slug strings
 * @param {Array<{name: string, slug: string}|string>} tags
 * @returns {string[]}
 */
export function resolveTagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => {
        if (typeof t === 'string') return t.trim();
        const name = t?.name || t?.slug || '';
        return name.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || name;
    }).filter(Boolean);
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Pick the active server-side content variant from a DataCat character row.
 *
 * For Saucepan characters with hidden definitions, DataCat's "Character Repair"
 * job exposes the recovered body via `content_variants[primary].content` with
 * the `description` field overloaded to carry the repaired body text.
 *
 * Since the jannyai-recovery release, essentially every JanitorAI row ALSO
 * carries a primary `janitor_core` variant, and that one uses plain janitor
 * conventions instead (description = site blurb, personality = definition).
 * Consumers must map the variant by source kind; treating `description` as
 * the body is only correct for Saucepan repair variants.
 *
 * @returns {Object|null} The variant content object, or null when no
 *   non-placeholder primary variant is present.
 */
export function pickRecoveryVariant(character) {
    const variants = character?.content_variants;
    if (!Array.isArray(variants) || !variants.length) return null;
    const primary = variants.find(v => v && v.isPrimary && !v.isRecoveryPlaceholder);
    return primary?.content || null;
}

// Recovery-sourced chara_card_v2_json bodies carry edge ##DESCRIPTION START##-style delimiter lines; /download bodies never do.
export function stripDatacatMarkers(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text
        .replace(/^\s*##[A-Z _]*(?:START|END)##[ \t]*\r?\n?/, '')
        .replace(/\r?\n?[ \t]*##[A-Z _]*(?:START|END)##\s*$/, '')
        .trim();
}

const HAMPTER_SCRIPT_PATH_RE = /^\/hampter\/script\/[a-f0-9-]{36}$/i;

/** True when the row advertises a public lorebook whose content wasnt obtained. */
export function hasUnfetchedLorebook(character) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts)) return false;
    return scripts.some(s => s && s.type === 'lorebook' && s.is_public && !s.script);
}

/**
 * Fetch missing lorebook script content from janitorai's hampter endpoint and merge it
 * onto the row's script entries in place. DataCat dropped the inline `script` field from
 * rows; the content lives at `api_path` on janitorai.com (CORS *).
 *
 * Deliberately a plain direct fetch, NOT fetchWithProxy: the endpoint only accepts
 * browser TLS fingerprints, so the /proxy/ fallback (undici) is a guaranteed 403, and a
 * poisoned _proxyOrigins entry for janitorai.com would skip the working direct attempt.
 *
 * @returns {Promise<boolean>} true when no public lorebook is left unfetched
 */
export async function hydrateDatacatScripts(character, { signal } = {}) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts) || !scripts.length) return true;
    for (const s of scripts) {
        if (!s || s.type !== 'lorebook' || !s.is_public || s.script) continue;
        // Listed publicly but the creator locked the content; hampter serves metadata only.
        if (s.is_code_public === false) continue;
        if (typeof s.api_path !== 'string' || !HAMPTER_SCRIPT_PATH_RE.test(s.api_path)) continue;
        try {
            const resp = await fetch(`https://janitorai.com${s.api_path}`, {
                signal,
                headers: { 'Accept': 'application/json' },
            });
            if (!resp.ok) {
                console.warn('[DataCat] script hydration got HTTP', resp.status, 'for', s.api_path);
                continue;
            }
            const full = await resp.json();
            if (typeof full?.script === 'string' && full.script) {
                s.script = full.script;
                if (!s.settings && typeof full.settings === 'string') s.settings = full.settings;
            } else {
                console.warn('[DataCat] script hydration returned no content for', s.api_path);
            }
        } catch (e) {
            // leave unfetched; consumers flag it via hasUnfetchedLorebook
            console.warn('[DataCat] script hydration failed for', s.api_path, e?.message || e);
        }
    }
    return !hasUnfetchedLorebook(character);
}

// Extract V2 character_book from character.scripts[]. DataCat stores lorebook
// entries JSON-encoded in script.script; private scripts are metadata stubs.
// Multi-script merge: first script's title/settings win, entries concatenate.
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
 * Build a V2 character card from the character endpoint payload.
 *
 * Field mapping is source-dependent. DataCat aggregates multiple sources, each
 * with different conventions for which field carries the character's body:
 *
 *   JanitorAI (default):
 *     character.personality   -> data.description (main character definition)
 *     character.description   -> data.creator_notes (website blurb)
 *     Newer rows leave `personality` empty and carry the body only in
 *     `chara_card_v2_json.data.description` (may be delimiter-wrapped) and
 *     the /download payload; the primary variant mirrors the row.
 *
 *   Saucepan (open definition):
 *     character.description   -> data.description (main character definition)
 *     character.personality   -> usually null
 *     companion_snapshot.full_description
 *       (or chara_card_v2_json.data.creator_notes)
 *                             -> data.creator_notes (formatted blurb/notes)
 *
 *   Saucepan (hidden definition):
 *     `content_variants[primary].content` carries the repaired body via
 *     the `description` field. /download returns empty in this case.
 *     The blurb still lives in `companion_snapshot.full_description`.
 *
 *   Common across sources:
 *     character.scenario      -> data.scenario
 *     character.first_message -> data.first_mes
 *     character.tags          -> data.tags (array of tag name strings)
 *     character.creator_name  -> data.creator
 *
 * @param {Object} character - Character object from /api/characters/:id
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildV2FromDatacat(character) {
    if (!character) return null;

    const tagNames = resolveTagNames(character.tags);
    const recovered = pickRecoveryVariant(character);
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;

    // Only Saucepan repair variants overload description with the body; janitor variants mirror the row blurb, never the body.
    const description = isSaucepan
        ? (recovered?.description || recovered?.personality || v2Data?.description || character.description || '')
        : (character.personality || recovered?.personality || stripDatacatMarkers(v2Data?.description) || '');
    const scenario = isSaucepan
        ? (recovered?.scenario || character.scenario || v2Data?.scenario || '')
        : (character.scenario || recovered?.scenario || v2Data?.scenario || '');
    const firstMessage = isSaucepan
        ? (recovered?.first_message || character.first_message || v2Data?.first_mes || '')
        : (character.first_message || recovered?.first_message || v2Data?.first_mes || '');
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || '')
        : (character.description || recovered?.description || v2Data?.creator_notes || '');
    const altGreetings = [character.alternate_greetings, recovered?.alternate_greetings, v2Data?.alternate_greetings]
        .find(a => Array.isArray(a) && a.length) || [];

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: character.chat_name || character.chatName || character.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMessage,
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: creatorNotes,
            creator: character.creator_name || character.creatorName || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: altGreetings,
            extensions: {
                datacat: {
                    id: character.character_id || character.characterId,
                    sourceKind: character.primary_content_source_kind || null,
                    creatorId: character.creator_id || character.creatorId || null,
                    creatorName: character.creator_name || character.creatorName || null
                }
            },
            character_book: extractCharacterBookFromScripts(character) || undefined
        }
    };
}

/**
 * Build a V2 character card from the /download endpoint response.
 * The download format is already close to V2 but needs wrapping.
 *
 * For Saucepan-with-hidden-definition cards, /download returns empty body
 * fields. When a `character` object is supplied and contains an active
 * recovery variant (`content_variants[primary].content`), we fall back to it
 * for description, scenario, and first_mes. This keeps imports and update
 * checks working for repaired Saucepan cards.
 *
 * @param {Object} downloadData - Response from /api/characters/:id/download
 * @param {Object} [character] - Optional character metadata for enrichment
 * @returns {Object|null}
 */
export function buildV2FromDownload(downloadData, character) {
    const d = downloadData?.data;
    if (!d) return null;

    const recovered = character ? pickRecoveryVariant(character) : null;
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;
    // Old downloads carry the janitor body in personality, new ones are proper V2 (personality empty), so the || order covers both shapes, dont reorder.
    const description = d.personality || d.description
        || (isSaucepan
            ? (recovered?.description || recovered?.personality || v2Data?.description || character?.description || '')
            : (character?.personality || recovered?.personality || stripDatacatMarkers(v2Data?.description) || ''));
    const scenario = d.scenario || recovered?.scenario || '';
    const firstMes = d.first_mes || recovered?.first_message || '';
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || d.creator_notes
            || '')
        : (d.creator_notes || character?.description || '');
    // New downloads ship URLs in creator/character_version; the real creator name lives in download metadata.
    const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
    const creatorName = character?.creator_name || character?.creatorName
        || downloadData?.metadata?.janitor_creator_name
        || (isUrl(d.creator) ? '' : (d.creator || ''));
    const cardVersion = (d.character_version && !isUrl(d.character_version)) ? d.character_version : '1.0';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name || character?.chat_name || character?.chatName || character?.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMes,
            mes_example: d.mes_example || '',
            system_prompt: d.system_prompt || '',
            post_history_instructions: d.post_history_instructions || '',
            creator_notes: creatorNotes,
            creator: creatorName,
            character_version: cardVersion,
            tags: d.tags || [],
            alternate_greetings: d.alternate_greetings || [],
            extensions: {
                ...(d.extensions || {}),
                datacat: {
                    id: character?.character_id || character?.characterId || null,
                    sourceKind: character?.primary_content_source_kind || null,
                    creatorId: character?.creator_id || character?.creatorId || null,
                    creatorName: character?.creator_name || character?.creatorName || null
                }
            },
            // Download's character_book is often present-but-empty; fall through to scripts.
            character_book: (d.character_book?.entries?.length ? d.character_book : null)
                || extractCharacterBookFromScripts(character)
                || undefined
        }
    };
}

// ========================================
// EXTRACTION
// ========================================

/**
 * Submit a JanitorAI character URL for extraction via DataCat's cloud browser.
 * @param {string} janitorUrl - Full JanitorAI character URL
 * @param {Object} [opts]
 * @param {boolean} [opts.publicFeed=true]
 * @param {boolean} [opts.alwaysReextract=false] - force re-extraction even if DataCat already has the character
 * @returns {Promise<{success: boolean, queued?: boolean, started?: boolean, queuePosition?: number, requestId?: string, error?: string, errorCode?: string}>}
 */
export async function submitExtraction(janitorUrl, { publicFeed = true, alwaysReextract = false } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed, alwaysReextract });
        if (!resp.ok) {
            const errText = await resp.text();
            console.error('[DataCat] dc-extract error:', resp.status, errText.substring(0, 200));
            return { success: false, error: `Server returned ${resp.status}: ${errText.substring(0, 100)}` };
        }
        try {
            return await resp.json();
        } catch {
            return { success: false, error: 'Invalid JSON response from cl-helper' };
        }
    } catch (e) {
        console.error('[DataCat] submitExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Poll extraction status from DataCat.
 * @returns {Promise<{inProgress: Object|null, queueLength: number, queue: Array, history: Array}|null>}
 */
export async function fetchExtractionStatus() {
    try {
        const resp = await dcFetch('/api/extraction/status-projection');
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('[DataCat] fetchExtractionStatus failed:', e);
        return null;
    }
}

// ========================================
// MEILISEARCH (JanitorAI index)
// ========================================

const MEILI_SORT_MAP = {
    janny_newest: ['createdAtStamp:desc'],
    janny_oldest: ['createdAtStamp:asc'],
    janny_tokens_desc: ['totalToken:desc'],
    janny_tokens_asc: ['totalToken:asc'],
    janny_relevant: [],
};

/**
 * Search JanitorAI characters via MeiliSearch.
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80]
 * @param {string} [opts.sort='janny_newest']
 * @param {boolean} [opts.nsfw=true]
 * @param {Set<number>} [opts.includeTags] - JanitorAI tag IDs to require
 * @returns {Promise<{characters: Object[], totalHits: number, totalPages: number}>}
 */
export async function searchMeiliJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'janny_newest', nsfw = true, includeTags = new Set() } = opts;

    const filters = [];
    if (!nsfw) filters.push('isNsfw = false');
    if (includeTags.size > 0) {
        const tagClauses = [...includeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    const sortArr = MEILI_SORT_MAP[sort] || MEILI_SORT_MAP.janny_newest;

    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isNsfw', 'tagIds'],
            filter: filters,
            hitsPerPage: limit,
            page,
        }]
    };

    if (sortArr.length > 0) body.queries[0].sort = sortArr;

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MeiliSearch error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    const result = data?.results?.[0] || {};
    const hits = result.hits || [];

    const characters = hits.map(normalizeMeiliHit);

    return {
        characters,
        totalHits: result.totalHits || 0,
        totalPages: result.totalPages || 0,
    };
}

// ========================================
// HAMPTER (JanitorAI internal API)
// ========================================

const HAMPTER_API_BASE = 'https://janitorai.com/hampter/characters';
const FLARESOLVERR_FETCH_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-fetch`;
const FLARESOLVERR_SESSION_CREATE_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-create`;
const FLARESOLVERR_SESSION_DESTROY_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-destroy`;

/**
 * Create a FlareSolverr session. Sessions keep a Chromium instance hot, so
 * subsequent fetches reuse the cached cf_clearance cookie and skip the
 * challenge - dropping each request from ~5-15s to ~1-3s.
 * @param {string} flareUrl
 * @returns {Promise<string>} the created session ID
 */
export async function createFlareSolverrSession(flareUrl) {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const resp = await _apiRequest(FLARESOLVERR_SESSION_CREATE_PATH, 'POST', { flareUrl });
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok || payload?.status !== 'ok' || !payload?.session) {
        throw new Error(payload?.error || payload?.message || 'Failed to create FlareSolverr session');
    }
    return payload.session;
}

/**
 * Destroy a FlareSolverr session. Best-effort; does not throw on failure.
 * @param {string} flareUrl
 * @param {string} sessionId
 */
export async function destroyFlareSolverrSession(flareUrl, sessionId) {
    if (!_apiRequest || !sessionId) return;
    try {
        await _apiRequest(FLARESOLVERR_SESSION_DESTROY_PATH, 'POST', { flareUrl, sessionId });
    } catch (err) {
        console.warn('[DatacatAPI] FlareSolverr session destroy failed:', err.message);
    }
}

/**
 * Fetch a URL via the user's configured FlareSolverr instance through cl-helper.
 * Returns the response body as text on success, or throws on failure.
 * @param {string} flareUrl - User-configured FlareSolverr endpoint (e.g. http://localhost:8191/v1)
 * @param {string} targetUrl - Target URL to fetch through FlareSolverr
 * @param {string} [sessionId] - Optional session ID to reuse a hot Chromium instance
 * @returns {Promise<string>}
 */
async function fetchViaFlareSolverr(flareUrl, targetUrl, sessionId = '') {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const body = { flareUrl, targetUrl };
    if (sessionId) body.sessionId = sessionId;
    const resp = await _apiRequest(FLARESOLVERR_FETCH_PATH, 'POST', body);
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok) {
        const msg = payload?.error || `FlareSolverr request failed (HTTP ${resp.status})`;
        const err = new Error(msg);
        if (payload?.message && /session/i.test(payload.message)) err.sessionInvalid = true;
        throw err;
    }
    if (payload?.status !== 'ok' || !payload?.solution) {
        const msg = payload?.message || 'FlareSolverr did not return a solution';
        const err = new Error(msg);
        if (msg && /session/i.test(msg)) err.sessionInvalid = true;
        throw err;
    }
    const upstreamStatus = payload.solution.status;
    if (typeof upstreamStatus === 'number' && upstreamStatus >= 400) {
        const err = new Error(`Upstream HTTP ${upstreamStatus}`);
        err.status = upstreamStatus;
        throw err;
    }
    return payload.solution.response || '';
}

/**
 * Fetch characters from JanitorAI's Hampter API (trending/popular sort).
 * @param {Object} opts
 * @param {string} [opts.sort='trending'] - 'trending' or 'popular'
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {boolean} [opts.nsfw=true] - false adds mode=sfw
 * @param {string} [opts.flareSolverrUrl] - Fallback: route through this FlareSolverr instance (only when the direct fetch was blocked)
 * @param {string} [opts.flareSessionId] - Reuse this FlareSolverr session for hot-Chromium speedup
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchHampterCharacters(opts = {}) {
    const { sort = 'trending', page = 1, search = '', nsfw = true, flareSolverrUrl = '', flareSessionId = '', authToken = '' } = opts;
    const params = new URLSearchParams({ sort, page: String(page) });
    if (search) params.set('search', search);
    if (!nsfw) params.set('mode', 'sfw');

    const url = `${HAMPTER_API_BASE}?${params}`;
    let data;

    if (flareSolverrUrl) {
        try {
            const text = await fetchViaFlareSolverr(flareSolverrUrl, url, flareSessionId);
            // FlareSolverr wraps JSON responses in HTML <pre> tags. Strip them.
            const cleaned = text.replace(/^[\s\S]*?<pre[^>]*>/i, '').replace(/<\/pre>[\s\S]*$/i, '').trim();
            try {
                data = JSON.parse(cleaned || text);
            } catch {
                throw new Error('FlareSolverr returned non-JSON body');
            }
        } catch (err) {
            if (err.status === 401) {
                // App-level login gate (page 2+ anonymously); no client can pass it, dont retry.
                const gated = new Error('JanitorAI requires signing in for this request');
                gated.code = 'HAMPTER_LOGIN_REQUIRED';
                gated.status = 401;
                throw gated;
            }
            if (err.status === 403) {
                const blocked = new Error(`Hampter HTTP ${err.status}`);
                blocked.code = 'HAMPTER_BLOCKED';
                blocked.status = err.status;
                throw blocked;
            }
            const wrapped = new Error(`FlareSolverr: ${err.message}`);
            wrapped.code = 'FLARESOLVERR_ERROR';
            if (err.sessionInvalid) wrapped.sessionInvalid = true;
            throw wrapped;
        }
    } else {
        // Direct browser fetch: hampter serves CORS * and browser TLS passes the bot gate that
        // 403s every server-side client. Deliberately not fetchWithProxy (the /proxy/ leg cant
        // pass, and a poisoned _proxyOrigins entry would skip the working direct attempt).
        // A JanitorAI bearer (Authorization is CORS-allowed here) unlocks page 2+ of these sorts.
        const headers = { 'Accept': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        let response = null;
        try {
            response = await fetch(url, { headers });
        } catch { response = null; }
        if (!response || !response.ok) {
            const status = response?.status ?? 0;
            if (status === 401) {
                // With a token, 401 means it expired/was rejected; without, its the anon page-1 wall.
                const gated = new Error(authToken ? 'JanitorAI session expired' : 'JanitorAI requires signing in for this request');
                gated.code = authToken ? 'HAMPTER_TOKEN_EXPIRED' : 'HAMPTER_LOGIN_REQUIRED';
                gated.status = 401;
                throw gated;
            }
            const blocked = new Error(status ? `Hampter HTTP ${status}` : 'Hampter direct fetch failed');
            blocked.code = 'HAMPTER_BLOCKED';
            blocked.status = status;
            throw blocked;
        }
        data = await response.json();
    }

    return {
        characters: (data.data || []).map(normalizeHampterHit),
        total: data.total || 0,
        page: data.page || page,
        pageSize: data.size || 34,
    };
}

function normalizeHampterHit(hit) {
    const tagNames = [
        ...(hit.tags || []).map(t => ({ name: t.name, slug: t.slug || t.name?.toLowerCase() })),
        ...(hit.custom_tags || []).map(t => typeof t === 'string' ? { name: t, slug: t.toLowerCase() } : { name: t.name || '', slug: t.slug || '' }),
    ];

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creator_name || ''),
        creator_id: hit.creator_id || '',
        created_at: hit.created_at || hit.first_published_at || '',
        is_nsfw: hit.is_nsfw || false,
        chat_count: hit.stats?.chat || 0,
        message_count: hit.stats?.message || 0,
        total_tokens: hit.total_tokens || 0,
        _source: 'hampter',
    };
}

/**
 * Normalize a MeiliSearch hit to match the shape expected by DataCat card rendering.
 */
function normalizeMeiliHit(hit) {
    const tagNames = (hit.tagIds || []).map(id => {
        const name = JANNY_TAG_MAP[id];
        return name ? { name, slug: name.toLowerCase() } : { name: `Tag ${id}`, slug: `tag-${id}` };
    });

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creatorUsername || ''),
        creator_id: hit.creatorId || '',
        createdAt: hit.createdAt || (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toISOString() : ''),
        isNsfw: hit.isNsfw || false,
        totalTokens: hit.totalToken || 0,
        _source: 'meilisearch',
    };
}
