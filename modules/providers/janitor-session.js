// JanitorAI account session (Supabase GoTrue).
// JANITORAI_ANON_KEY is JanitorAI's public publishable key, safe to ship in client code.

import CoreAPI from '../core-api.js';

const JANITORAI_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const JANITORAI_AUTH_BASE = 'https://mcmzxtzommpnxkynddbo.supabase.co/auth/v1';
const JANITORAI_TOKEN_URL = `${JANITORAI_AUTH_BASE}/token`;

function janitoraiAuthHeaders() {
    return { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${JANITORAI_ANON_KEY}`, 'Content-Type': 'application/json' };
}

export function decodeJanitoraiClaims(jwt) {
    try {
        const p = JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return { email: p.email || '', expMs: (p.exp || 0) * 1000 };
    } catch { return { email: '', expMs: 0 }; }
}

// Seeded from a pasted session cookie: direct login is captcha-gated and unusable from this origin.

function janitoraiB64decode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
}

/** @returns {{access_token: string, refresh_token: string}|null} */
export function parseJanitoraiSession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s.startsWith('base64-')) s = s.slice('base64-'.length);
    let json = null;
    try {
        const dec = janitoraiB64decode(s);
        if (dec.includes('access_token')) json = JSON.parse(dec);
    } catch {}
    if (!json && s.startsWith('{')) {
        try { json = JSON.parse(s); } catch {}
    }
    if (json?.access_token) {
        return { access_token: json.access_token, refresh_token: json.refresh_token || '' };
    }
    const jm = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jm ? { access_token: jm[0], refresh_token: '' } : null;
}

/**
 * `dead` marks a definitively revoked/expired refresh token so the caller clears the stored session.
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
 * Verified against the auth service, not a Cloudflare-gated endpoint, so a blocked preflight cant read as a bad token.
 * @returns {Promise<{valid: boolean, transient?: boolean}>} transient = auth service unreachable/erroring (429/5xx)
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
// STATEFUL SESSION
// ========================================
// One shared in-flight refresh: the refresh token is single-use, so concurrent loads must not race it.

let _refreshInFlight = null;

async function doRefresh() {
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = (async () => {
        const rt = CoreAPI.getSetting('janitoraiRefreshToken');
        const res = await janitoraiRefreshGrant(rt);
        if (res.access_token) {
            CoreAPI.setSetting('janitoraiToken', res.access_token);
            if (res.refresh_token) CoreAPI.setSetting('janitoraiRefreshToken', res.refresh_token);
            return res.access_token;
        }
        // Wipe the stored session only when the refresh token is definitively dead, never on a transient blip.
        if (res.dead) {
            CoreAPI.setSetting('janitoraiToken', null);
            CoreAPI.setSetting('janitoraiRefreshToken', null);
        }
        return '';
    })();
    try { return await _refreshInFlight; }
    finally { _refreshInFlight = null; }
}

export async function getValidJanitoraiToken() {
    const tok = CoreAPI.getSetting('janitoraiToken') || '';
    if (!tok) return '';
    const { expMs } = decodeJanitoraiClaims(tok);
    if (expMs && expMs - Date.now() > 120000) return tok;
    return (await doRefresh()) || '';
}

export async function janitoraiForceRefresh() {
    return doRefresh();
}

export async function janitoraiSetSession(pasted) {
    const pair = parseJanitoraiSession(pasted);
    if (!pair) return { ok: false, error: 'Could not find a session in that value. Copy the whole sb-...-auth-token cookie.' };
    const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
    let token = pair.access_token;
    if ((!expMs || expMs - Date.now() < 120000) && pair.refresh_token) {
        const r = await janitoraiRefreshGrant(pair.refresh_token);
        if (!r.access_token) {
            return { ok: false, error: r.dead
                ? 'That session is expired or invalid. Copy a fresh cookie after logging in again.'
                : 'Could not reach the JanitorAI auth service. Try again in a moment.' };
        }
        // A successful grant is proof enough; the single-use pasted token is already consumed.
        token = r.access_token;
        pair.refresh_token = r.refresh_token;
    } else {
        // No rotation ran, nothing consumed yet: confirm the pasted token before storing.
        const v = await janitoraiVerifyToken(token);
        if (!v.valid) {
            return { ok: false, error: v.transient
                ? 'Could not reach the JanitorAI auth service. Try again in a moment.'
                : 'That session is expired or invalid. Copy a fresh cookie after logging in again.' };
        }
    }
    CoreAPI.setSetting('janitoraiToken', token);
    CoreAPI.setSetting('janitoraiRefreshToken', pair.refresh_token || null);
    return { ok: true, email: decodeJanitoraiClaims(token).email || email, hasRefresh: !!pair.refresh_token };
}

export function janitoraiLogout() {
    CoreAPI.setSetting('janitoraiToken', null);
    CoreAPI.setSetting('janitoraiRefreshToken', null);
}

export function janitoraiSessionStatus() {
    const tok = CoreAPI.getSetting('janitoraiToken') || '';
    if (!tok) return { loggedIn: false };
    const { email, expMs } = decodeJanitoraiClaims(tok);
    return { loggedIn: true, email, expMs, hasRefresh: !!CoreAPI.getSetting('janitoraiRefreshToken') };
}

let initialized = false;

/** Idempotent: any provider can call from its own init() without ordering assumptions. */
export function initJanitorSession() {
    if (initialized) return;
    initialized = true;
    window.janitoraiSetSession = janitoraiSetSession;
    window.janitoraiLogout = janitoraiLogout;
    window.janitoraiSessionStatus = janitoraiSessionStatus;
}
