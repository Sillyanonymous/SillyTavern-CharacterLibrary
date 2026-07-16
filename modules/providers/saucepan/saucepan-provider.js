// Saucepan Provider - implementation for saucepan.ai character source
//
// Saucepan exposes companion definitions through an authenticated REST API
// (proxied via cl-helper). Unlike JanitorAI, extraction is a direct, exact pull
// of the definition — the body ships as shuffled + decoy-padded fragments that
// cl-helper validates and reassembles. A Bearer token (login or paste) is
// required for the definition/greeting fetch; search is anonymous.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy, CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
import saucepanBrowseView from './saucepan-browse.js';
import {
    setApiRequest as setSaucepanApiRequest,
    setSaucepanTokenGetter,
    hasSaucepanToken,
    resolveSaucepanImageUrl,
    fetchSaucepanCompanion,
    submitSaucepanExtraction,
    buildV2FromSaucepan,
} from './saucepan-api.js';

let api = null;

/** Lightweight slug for import filenames (kept local to avoid a cross-provider import). */
function slugify(name) {
    return String(name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'character';
}

/**
 * Build a normalized Saucepan "hit" from a companion detail object, so the V2
 * builder (which expects the search-hit shape) can consume native detail data.
 */
function hitFromCompanion(companion, fallbackId) {
    return {
        id: companion?.id || fallbackId,
        character_id: companion?.id || fallbackId,
        name: companion?.name || 'Unknown',
        display_name: companion?.display_name || companion?.name || 'Unknown',
        avatar: resolveSaucepanImageUrl(companion?.image?.highres_url || companion?.image?.url || ''),
        description: companion?.short_description || '',
        tags: Array.isArray(companion?.tags) ? companion.tags : [],
        creator_name: companion?.author_handle || '',
        creator_id: companion?.author_id || '',
    };
}

/** Pull gallery portraits off a companion detail object. */
function extractSaucepanPortraits(companion) {
    const portraits = companion?.portraits;
    if (!Array.isArray(portraits) || portraits.length === 0) return [];
    const out = [];
    for (const p of portraits) {
        const url = p?.image?.highres_url || p?.image?.url;
        if (!url) continue;
        out.push({ url: resolveSaucepanImageUrl(url), id: p.image?.id || null });
    }
    return out;
}

// ========================================
// PROVIDER CLASS
// ========================================

class SaucepanProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'saucepan'; }
    get name() { return 'Saucepan'; }
    get icon() { return 'fa-solid fa-utensils'; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() { return 'Saucepan is an experimental source. Native definition extraction requires a Saucepan account (Bearer token) configured in this provider\'s settings.'; }
    get browseView() { return saucepanBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Favorites' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setSaucepanApiRequest(coreAPI.apiRequest);
        setSaucepanTokenGetter(() => coreAPI.getSetting('saucepanToken') || null);

        // Push any persisted Saucepan token into cl-helper so search and other
        // stateless proxy calls are authenticated without a manual login after
        // every server restart (cl-helper only holds the token in memory).
        const saucepanToken = coreAPI.getSetting('saucepanToken');
        if (saucepanToken) {
            try {
                await coreAPI.apiRequest(
                    `${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`,
                    'POST',
                    { token: saucepanToken },
                );
            } catch (e) {
                console.warn('[SaucepanProvider] Failed to push Saucepan token:', e.message);
            }
        }
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return saucepanBrowseView.renderFilterBar(); }
    renderView() { return saucepanBrowseView.renderView(); }
    renderModals() { return saucepanBrowseView.renderModals(); }

    async activate(container, options = {}) {
        saucepanBrowseView.activate(container, options);
    }

    deactivate() {
        saucepanBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        // Native namespace.
        const sp = extensions?.saucepan;
        if (sp?.id) {
            return {
                providerId: 'saucepan',
                id: sp.id,
                fullPath: String(sp.id),
                linkedAt: sp.linkedAt || null,
            };
        }
        // Back-compat: cards imported while Saucepan lived inside DataCat carry
        // extensions.datacat with sourceKind === 'saucepan'.
        const dc = extensions?.datacat;
        if (dc?.id && dc.sourceKind === 'saucepan') {
            return {
                providerId: 'saucepan',
                id: dc.id,
                fullPath: String(dc.id),
                linkedAt: dc.linkedAt || null,
            };
        }
        return null;
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.saucepan || {};
            char.data.extensions.saucepan = {
                id: linkInfo.id,
                linkedAt: linkInfo.linkedAt || existing.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.saucepan;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const companion = await fetchSaucepanCompanion(linkInfo.id);
            if (!companion) return null;
            const chats = parseInt(companion.chat_count, 10) || 0;
            const favorites = parseInt(companion.favorite_count, 10) || 0;
            const tokens = parseInt(companion.card_token_count, 10) || 0;
            return { stat1: chats, stat2: favorites, stat3: tokens };
        } catch (e) {
            api?.debugLog?.('[SaucepanProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(characterId) {
        const companion = await fetchSaucepanCompanion(characterId);
        if (!companion) return null;
        return { ...companion, id: companion.id || characterId };
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const companion = await fetchSaucepanCompanion(linkInfo.id);
            const hit = hitFromCompanion(companion, linkInfo.id);
            const extractResult = await submitSaucepanExtraction(
                `https://saucepan.ai/companion/${linkInfo.id}`,
            );
            if (!extractResult.success) {
                api?.debugLog?.('[SaucepanProvider] native extraction failed:', extractResult.error);
                return null;
            }
            const result = buildV2FromSaucepan(hit, extractResult);
            if (result) result._listingName = this.getListingName(hit);
            return result;
        } catch (e) {
            console.error('[SaucepanProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2') return rawData;
        return rawData;
    }

    // Native extraction is always fresh (it re-pulls the definition), so there is
    // nothing to pre-refresh before an update check.
    async refreshRemoteData() { /* no-op: extraction is always live */ }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() { return []; }
    get supportsVersionHistory() { return false; }

    // ── Gallery ──────────────────────────────────────────────

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const companion = await fetchSaucepanCompanion(linkInfo.id);
            return extractSaucepanPortraits(companion);
        } catch (e) {
            console.error('[SaucepanProvider] fetchGalleryImages failed:', linkInfo.id, e);
            return [];
        }
    }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return `https://saucepan.ai/companion/${linkInfo.id}`;
    }

    getListingName(hitData) {
        return hitData?.display_name || hitData?.name || null;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;
        // Prefer the live companion detail (real stats, portraits, tags, image) from
        // /api/v2/companions/<id>; openPreview turns it into a full hit via hitFromCompanion.
        const companion = await fetchSaucepanCompanion(charId);
        if (companion) return { id: charId, _companion: companion };
        // Fallback to the locally-imported card when offline / the fetch fails, so the
        // preview still opens (the definition then loads live via native extraction).
        const data = char?.data || {};
        const sp = data.extensions?.saucepan || {};
        const tags = Array.isArray(data.tags)
            ? data.tags
            : (Array.isArray(char?.tags) ? char.tags : []);
        return {
            id: charId,
            name: char?.name || data.name || 'Unknown',
            description: data.creator_notes || data.description || '',
            avatar: char?.avatar
                ? `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`
                : '',
            tags,
            is_nsfw: false,
            creator_name: sp.creatorName || data.creator || '',
            creator_id: sp.creatorId || '',
        };
    }

    openPreview(previewChar) {
        saucepanBrowseView.openPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.saucepan;
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'saucepan',
                    charId: ext.id,
                    fullPath: String(ext.id),
                    hasGallery: false,
                    avatarUrl: null,
                },
            };
        }
        return null;
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }
    get isAuthenticated() { return hasSaucepanToken(); }

    getAuthHeaders() {
        const token = api?.getSetting?.('saucepanToken') || null;
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    openAuthUI() {
        // Full login/token modal is wired in a later step; the token can also be
        // set declaratively via getSettings().
        saucepanBrowseView.openAuthUI?.();
    }

    getSettings() {
        return [
            {
                key: 'saucepanToken',
                label: 'Saucepan Bearer Token',
                type: 'password',
                defaultValue: null,
                hint: 'Required for native definition extraction. Get it by logging in, or paste a token from your Saucepan session.',
                section: 'Saucepan',
            },
        ];
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?saucepan\.ai$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            const match = u.pathname.match(/\/companion\/([a-f0-9-]{36})/i);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a companion by id via native extraction.
     * @param {string} identifier - companion UUID
     * @param {Object} [hitData] - optional pre-fetched normalized hit
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const charId = String(identifier);
            const companionUrl = `https://saucepan.ai/companion/${charId}`;

            // Prefer a supplied hit (from the browse grid); otherwise fetch detail.
            let hit = hitData;
            let companion = null;
            if (!hit) {
                companion = await fetchSaucepanCompanion(charId);
                hit = hitFromCompanion(companion, charId);
            }

            const extractResult = await submitSaucepanExtraction(companionUrl);
            if (!extractResult.success) {
                throw new Error(extractResult.error || 'Saucepan extraction failed');
            }
            const characterCard = buildV2FromSaucepan(hit, extractResult);
            if (!characterCard?.data) throw new Error('Failed to build character card (empty definition)');

            const characterName = characterCard.data.name || hit.name || 'Unnamed';

            // Ensure the saucepan extension is set.
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.saucepan = {
                ...(characterCard.data.extensions.saucepan || {}),
                id: charId,
                creatorId: hit.creator_id || null,
                creatorName: hit.creator_name || null,
                pageName: this.getListingName(hit),
                linkedAt: new Date().toISOString(),
            };

            assignGalleryId(characterCard, options, api);

            // Download avatar through the proxy.
            const avatarUrl = resolveSaucepanImageUrl(hit.avatar || companion?.image?.highres_url || '');
            let imageBuffer = null;
            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[SaucepanProvider] Avatar download failed:', e.message);
                }
            }

            const hasGallery = companion ? extractSaucepanPortraits(companion).length > 0
                : (hit.portrait_count || 0) > 0;

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `saucepan_${slugify(characterName)}.png`,
                characterName,
                hasGallery,
                providerCharId: charId,
                fullPath: charId,
                avatarUrl: avatarUrl || null,
                api,
            });
        } catch (error) {
            console.error(`[SaucepanProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return false; }
}

const saucepanProvider = new SaucepanProvider();
export default saucepanProvider;

// ── Window-exposed session management ───────────────────────
// The token is persisted in the 'saucepanToken' setting (what hasSaucepanToken()
// and native extraction key off) and mirrored into cl-helper's in-memory store
// for proxy auth. These are invoked by the provider's auth UI.

window.saucepanLogin = async (handle, password) => {
    try {
        const resp = await api.apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-login`,
            'POST',
            { handle, password },
        );
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
        }
        const data = await resp.json();
        if (data?.ok && data.token) {
            CoreAPI.setSetting('saucepanToken', data.token);
        }
        return data;
    } catch (e) {
        return { ok: false, error: e.message };
    }
};

window.saucepanSetToken = async (token) => {
    const trimmed = (token || '').trim();
    if (!trimmed) return { ok: false, error: 'Token is empty' };
    CoreAPI.setSetting('saucepanToken', trimmed);
    try {
        const resp = await api.apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`,
            'POST',
            { token: trimmed },
        );
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
        }
        return await resp.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
};

window.saucepanValidateSession = async () => {
    try {
        // Resync the persisted token first: cl-helper only holds it in memory.
        const saved = CoreAPI.getSetting('saucepanToken');
        if (saved) {
            try {
                await api.apiRequest(
                    `${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`,
                    'POST',
                    { token: saved },
                );
            } catch { /* validate reports the failure */ }
        }
        const resp = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-validate`);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { valid: false, reason: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
        }
        return await resp.json();
    } catch (e) {
        return { valid: false, reason: e.message };
    }
};

window.saucepanClearSession = async () => {
    CoreAPI.setSetting('saucepanToken', null);
    try {
        const resp = await api.apiRequest(`${CL_HELPER_PLUGIN_BASE}/saucepan-clear-token`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
};
