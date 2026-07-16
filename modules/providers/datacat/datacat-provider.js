// DataCat Provider - implementation for datacat.run character source
//
// DataCat aggregates JanitorAI characters with its own REST API layer
// and AI-powered character scoring. Uses ella.janitorai.com CDN for images.
// No version history. No authentication required.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy, CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
import datacatBrowseView from './datacat-browse.js';
import {
    DATACAT_API_BASE,
    resolveDatacatAvatarUrl,
    setApiRequest,
    setSavedTokenGetter,
    slugify,
    stripHtml,
    resolveTagNames,
    fetchDatacatCharacter,
    fetchDatacatDownload,
    validateDcSession,
    clearDcSession,
    initDcSession,
    checkDcPluginAvailable,
    buildV2FromDatacat,
    buildV2FromDownload,
    extractCharacterBookFromScripts,
    hydrateDatacatScripts,
    hasUnfetchedLorebook,
    submitExtraction,
    fetchExtractionStatus,
    parseJanitoraiSession,
    janitoraiRefreshGrant,
    janitoraiVerifyToken,
    decodeJanitoraiClaims,
} from './datacat-api.js';
import {
    setApiRequest as setSaucepanApiRequest,
    setSaucepanTokenGetter,
    hasSaucepanToken,
    fetchSaucepanCompanion,
    submitSaucepanExtraction,
    buildV2FromSaucepan,
} from '../saucepan/saucepan-api.js';

let api = null;

// Saucepan-source DataCat characters expose extra portraits in
// `character.companion_snapshot.portraits[]`. Each entry has
// `image.highres_url` pointing at the saucepan CDN. Avatar lives at
// `companion_snapshot.image.highres_url` and is downloaded separately
// during import, so it's excluded here.
function extractSaucepanGalleryImages(character) {
    const portraits = character?.companion_snapshot?.portraits;
    if (!Array.isArray(portraits) || portraits.length === 0) return [];
    const out = [];
    for (const p of portraits) {
        const url = p?.image?.highres_url;
        if (!url) continue;
        out.push({ url, id: p.image.id || null });
    }
    return out;
}

// ========================================
// PROVIDER CLASS
// ========================================

class DatacatProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'datacat'; }
    get name() { return 'DataCat'; }
    get icon() { return 'fa-solid fa-cat'; }
    get iconUrl() { return 'https://datacat.run/catgif.gif'; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() { return 'DataCat is an experimental source. Its API is barebones and some features (creator listings, search) may return incomplete or unavailable results. Expect rough edges.'; }
    get browseView() { return datacatBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-envelope', label: 'Messages' },
            stat3: null,
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setApiRequest(coreAPI.apiRequest);
        setSaucepanApiRequest(coreAPI.apiRequest);
        setSavedTokenGetter(() => coreAPI.getSetting('datacatToken') || null);
        setSaucepanTokenGetter(() => coreAPI.getSetting('saucepanToken') || null);

        // Push any persisted Saucepan token into cl-helper so search and
        // other stateless proxy calls are authenticated without requiring a
        // manual login after every server restart.
        const saucepanToken = coreAPI.getSetting('saucepanToken');
        if (saucepanToken) {
            try {
                await coreAPI.apiRequest(
                    `${CL_HELPER_PLUGIN_BASE}/saucepan-set-token`,
                    'POST',
                    { token: saucepanToken },
                );
            } catch (e) {
                console.warn(
                    '[DatacatProvider] Failed to push Saucepan token:',
                    e.message,
                );
            }
        }
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return datacatBrowseView.renderFilterBar(); }
    renderView() { return datacatBrowseView.renderView(); }
    renderModals() { return datacatBrowseView.renderModals(); }

    async activate(container, options = {}) {
        datacatBrowseView.activate(container, options);
    }

    deactivate() {
        datacatBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const dc = extensions?.datacat;
        if (!dc) return null;
        // Saucepan-sourced cards (legacy combined-build namespace) are owned by the
        // standalone Saucepan provider now. If DataCat claimed them, getCharacterProvider
        // would resolve them here first (DataCat registers before Saucepan) and
        // "View on Saucepan" would fail with "character not found on DataCat".
        if (dc.sourceKind === 'saucepan') return null;

        const id = dc.id;
        if (!id) return null;

        return {
            providerId: 'datacat',
            id,
            fullPath: String(id),
            sourceKind: dc.sourceKind || null,
            linkedAt: dc.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.datacat || {};
            char.data.extensions.datacat = {
                id: linkInfo.id,
                sourceKind: linkInfo.sourceKind || existing.sourceKind || null,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.datacat;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            if (!character) return null;

            api?.debugLog?.('[DatacatProvider] fetchLinkStats raw keys:', Object.keys(character).join(', '));
            api?.debugLog?.('[DatacatProvider] chatCount:', character.chatCount, 'chat_count:', character.chat_count, 'stats:', JSON.stringify(character.stats));

            const chats = parseInt(character.chatCount || character.chat_count || character.stats?.chat, 10) || 0;
            const messages = parseInt(character.messageCount || character.message_count || character.stats?.message, 10) || 0;
            return { stat1: chats, stat2: messages, stat3: null };
        } catch (e) {
            api?.debugLog?.('[DatacatProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(characterId) {
        const char = await fetchDatacatCharacter(characterId);
        if (!char) return null;
        // Normalize: library.js reads metadata.id as the link identifier.
        // DataCat API returns numeric auto-increment as `id` and UUID as `character_id`.
        // URLs and all API calls use the UUID, so expose it as `id`.
        return { ...char, id: char.character_id || char.id };
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        const sk = linkInfo.sourceKind || null;
        try {
            // For Saucepan, try native extraction first if a token is available.
            if (sk === 'saucepan' && hasSaucepanToken()) {
                const companion = await fetchSaucepanCompanion(linkInfo.id);
                if (companion) {
                    const hit = {
                        id: companion.id || linkInfo.id,
                        character_id: companion.id || linkInfo.id,
                        name: companion.name || 'Unknown',
                        display_name: companion.display_name || companion.name || 'Unknown',
                        avatar: companion.image?.highres_url || companion.image?.url || '',
                        description: companion.short_description || '',
                        tags: Array.isArray(companion.tags) ? companion.tags : [],
                        creator_name: companion.author_handle || '',
                        creator_id: companion.author_id || '',
                    };
                    const extractResult = await submitSaucepanExtraction(
                        `https://saucepan.ai/companion/${linkInfo.id}`,
                    );
                    if (extractResult.success) {
                        const result = buildV2FromSaucepan(hit, extractResult);
                        if (result) {
                            result._listingName = this.getListingName(hit);
                            return result;
                        }
                    } else {
                        api?.debugLog?.(
                            '[DatacatProvider] native Saucepan extraction failed:',
                            extractResult.error,
                        );
                    }
                }
            }

            // Try the download endpoint first (closest to V2 format)
            const downloadData = await fetchDatacatDownload(linkInfo.id, sk);
            if (downloadData?.data) {
                const character = await fetchDatacatCharacter(linkInfo.id, sk);
                if (character) await hydrateDatacatScripts(character);
                const result = buildV2FromDownload(downloadData, character);
                if (result) {
                    result._listingName = this.getListingName(character);
                    // Unknown-not-removed: stops the update check offering a phantom "lorebook removed"
                    if (hasUnfetchedLorebook(character)) result._lorebookUnavailable = true;
                }
                return result;
            }

            // Fallback to building from character metadata
            const character = await fetchDatacatCharacter(linkInfo.id, sk);
            if (character) {
                await hydrateDatacatScripts(character);
                const result = buildV2FromDatacat(character);
                if (result) {
                    result._listingName = this.getListingName(character);
                    if (hasUnfetchedLorebook(character)) result._lorebookUnavailable = true;
                }
                return result;
            }

            return null;
        } catch (e) {
            console.error('[DatacatProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2') return rawData;
        const card = buildV2FromDatacat(rawData);
        if (card && hasUnfetchedLorebook(rawData)) card._lorebookUnavailable = true;
        return card;
    }

    async fetchLorebook(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            if (character) await hydrateDatacatScripts(character);
            return extractCharacterBookFromScripts(character);
        } catch (e) {
            console.error('[DatacatProvider] fetchLorebook failed:', linkInfo.id, e);
            return null;
        }
    }

    async refreshRemoteData(linkInfo, options = {}) {
        if (!linkInfo?.id) return;
        if (CoreAPI.getSetting('datacatReextractOnUpdate') !== true) return;

        const report = options?.onStatus;

        try {
            report?.('Checking cl-helper plugin...');
            const pluginOk = await checkDcPluginAvailable();
            if (!pluginOk) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: cl-helper not available, skipping re-extraction');
                return;
            }

            report?.('Validating DataCat session...');
            const sessionOk = await validateDcSession();
            if (!sessionOk) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: no active DataCat session, skipping re-extraction');
                return;
            }

            // Backfill from probe for older cards; the post-extract fetch will persist via buildV2*.
            let sourceKind = linkInfo.sourceKind;
            if (!sourceKind) {
                const probe = await fetchDatacatCharacter(linkInfo.id);
                sourceKind = probe?.primary_content_source_kind || 'janitor';
            }

            const upstreamUrl = sourceKind === 'saucepan'
                ? `https://saucepan.ai/companion/${linkInfo.id}`
                : `https://janitorai.com/characters/${linkInfo.id}`;
            const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;

            report?.('Submitting re-extraction request...');
            const result = await submitExtraction(upstreamUrl, { publicFeed, alwaysReextract: true });
            if (!result?.success && !result?.queued && !result?.started) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction submit failed:', result?.error);
                return;
            }

            const submitRequestId = result?.requestId || null;

            if (result?.queued) {
                const pos = result.queuePosition ? ` (position ${result.queuePosition})` : '';
                report?.(`Queued for re-extraction${pos}...`);
            } else {
                report?.('Re-extraction started...');
            }

            const signal = options?.signal;
            const POLL_INTERVAL = 3000;
            const MAX_POLLS = 60;
            for (let i = 0; i < MAX_POLLS; i++) {
                if (signal?.aborted) return;
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                if (signal?.aborted) return;
                const status = await fetchExtractionStatus();
                if (!status) continue;

                // Match by requestId (v0.91+ history accumulates entries per char); fall back to characterId.
                const done = status.history?.find(h => {
                    if (submitRequestId && h.requestId) return h.requestId === submitRequestId;
                    return h.characterId === linkInfo.id || h.character_id === linkInfo.id;
                });
                if (done) {
                    report?.('Re-extraction complete');
                    api?.debugLog?.('[DatacatProvider] refreshRemoteData: re-extraction complete for', linkInfo.id);
                    return;
                }

                if (status.inProgress) {
                    const phase = status.inProgress.status;
                    const PHASE_LABELS = {
                        opening_page: 'Opening page',
                        preparing: 'Preparing',
                        initiating: 'Initiating',
                        pulling: 'Pulling data',
                        post_extract: 'Finalizing',
                        complete: 'Completing',
                    };
                    report?.(PHASE_LABELS[phase] || `Extracting (${phase})...`);
                } else if (!status.queue || status.queue.length === 0) {
                    api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction finished (no longer in progress)');
                    report?.('Re-extraction complete');
                    return;
                }
            }
            report?.('Re-extraction timed out, using cached data');
            api?.debugLog?.('[DatacatProvider] refreshRemoteData: re-extraction timed out after', MAX_POLLS * POLL_INTERVAL / 1000, 'seconds');
        } catch (err) {
            console.error('[DatacatProvider] refreshRemoteData failed, continuing with cached data:', err);
        }
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [];
    }

    // ── Version History ─────────────────────────────────────

    get supportsVersionHistory() { return false; }

    // ── Gallery ──────────────────────────────────────────────
    //
    // Saucepan-source characters carry extra portraits in
    // `character.companion_snapshot.portraits[]`, each with an `image.highres_url`
    // pointing at the saucepan CDN. JanitorAI-source characters have no
    // gallery field on DataCat, so this returns [] for them.

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            return extractSaucepanGalleryImages(character);
        } catch (e) {
            console.error('[DatacatProvider] fetchGalleryImages failed:', linkInfo.id, e);
            return [];
        }
    }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        // Saucepan characters (especially natively-extracted ones) may not
        // exist on DataCat, so link to their actual source page.
        if (linkInfo.sourceKind === 'saucepan') {
            return `https://saucepan.ai/companion/${linkInfo.id}`;
        }
        return `https://datacat.run/characters/${linkInfo.id}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        try {
            const character = await fetchDatacatCharacter(charId, linkInfo.sourceKind || null);
            if (!character) return null;

            const preview = {
                id: character.character_id || character.characterId,
                name: character.name,
                chat_name: character.chat_name,
                description: character.description,
                avatar: character.avatar,
                tags: character.tags || [],
                custom_tags: character.custom_tags || [],
                is_nsfw: character.is_nsfw,
                creator_id: character.creator_id,
                creator_name: character.creator_name,
                created_at: character.created_at,
                chat_count: character.chat_count ?? character.chatCount ?? character.stats?.chat,
                message_count: character.message_count ?? character.messageCount ?? character.stats?.message,
                primary_content_source_kind: character.primary_content_source_kind || null,
            };
            // Full row rides along so the preview skips its refetch and keeps the right source kind.
            preview._fullCharacter = character;
            return preview;
        } catch (e) {
            console.warn('[DatacatProvider] buildPreviewObject failed:', e.message);
        }

        // Fallback to local data
        const dcData = char?.data?.extensions?.datacat || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: dcData.avatar || '',
            tags: [],
            is_nsfw: false,
            creator_name: char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openDatacatCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.datacat;
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'datacat',
                    charId: ext.id,
                    fullPath: String(ext.id),
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        }

        // No datacat extensions - cannot auto-enrich without a search API
        return null;
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return false; }
    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?datacat\.run$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Extract UUID from any path containing it (e.g. /characters/recent/:uuid)
            const match = u.pathname.match(/\/characters?\/(?:[^/]+\/)*([a-f0-9-]{36})/i);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from DataCat.
     * @param {string} identifier - character UUID
     * @param {Object} [hitData] - Optional pre-fetched character data
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const charId = String(identifier);

            // Fetch full character data; browse hits carry the full row as _fullCharacter.
            let character = hitData?._fullCharacter || hitData || await fetchDatacatCharacter(charId);
            if (!character) throw new Error('Could not fetch character data from DataCat');

            const characterName = character.chat_name || character.chatName || character.name || 'Unnamed';

            let characterCard;
            const sourceKind = character.primary_content_source_kind
                ? (character.primary_content_source_kind === 'saucepan' ? 'saucepan' : 'janitor')
                : null;
            if (character._source === 'saucepan' && character.chara_card_v2_json?.data) {
                // Natively-extracted Saucepan cards already carry a fully-built V2
                // card (body, greetings, example dialogue, prompts). DataCat has no
                // copy to download, so use it directly rather than rebuilding.
                characterCard = character.chara_card_v2_json;
            } else {
                // Download-first for the best V2 mapping; the sourceKind hint keeps
                // freshly-extracted chars from 404ing into the metadata fallback.
                const downloadData = await fetchDatacatDownload(charId, sourceKind);
                // Listing-shaped hits carry no body source at all; the metadata build needs the full row.
                if (!downloadData?.data && !character.chara_card_v2_json && !character.content_variants && !character.personality) {
                    character = await fetchDatacatCharacter(charId, sourceKind) || character;
                }
                // Lorebook content moved behind a per-script hampter fetch; hydrate before building.
                await hydrateDatacatScripts(character);
                if (downloadData?.data) {
                    characterCard = buildV2FromDownload(downloadData, character);
                } else {
                    characterCard = buildV2FromDatacat(character);
                }
            }

            if (!characterCard?.data) throw new Error('Failed to build character card');

            // Ensure datacat extension is set. sourceKind persists normalized ('janitor'/'saucepan', the API hint values), not the raw row kind.
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.datacat = {
                ...(characterCard.data.extensions.datacat || {}),
                id: charId,
                sourceKind: sourceKind || characterCard.data.extensions.datacat?.sourceKind || null,
                creatorId: character.creator_id || character.creatorId || null,
                creatorName: character.creator_name || character.creatorName || null,
                pageName: this.getListingName(character),
                linkedAt: new Date().toISOString()
            };

            assignGalleryId(characterCard, options, api);

            // Download avatar
            const avatarUrl = resolveDatacatAvatarUrl(character);
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[DatacatProvider] Avatar download failed:', e.message);
                }
            }

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `datacat_${slugify(characterName)}.png`,
                characterName,
                hasGallery: extractSaucepanGalleryImages(character).length > 0,
                providerCharId: charId,
                fullPath: charId,
                avatarUrl: avatarUrl || null,
                api
            });
        } catch (error) {
            console.error(`[DatacatProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return false; }
}

const datacatProvider = new DatacatProvider();
export default datacatProvider;

// Window-exposed session management (called by settings panel in library.js)
window.datacatValidateSession = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { valid: false, reason: 'cl-helper plugin not available' };
    return validateDcSession();
};

window.datacatRefreshToken = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return null;
    return initDcSession(null, true);
};

window.datacatClearSession = async () => {
    return clearDcSession();
};

// Window-exposed Saucepan session management (called by settings panel in library.js).
// The token is persisted in the 'saucepanToken' setting — that setting is what
// hasSaucepanToken()/native extraction key off — and mirrored into cl-helper's
// in-memory store for proxy auth.
window.saucepanLogin = async (handle, password) => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { ok: false, error: 'cl-helper plugin not available' };
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
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { ok: false, error: 'Saved locally, but cl-helper plugin not available' };
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
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk)
        return { valid: false, reason: 'cl-helper plugin not available' };
    try {
        // Resync the persisted token first: cl-helper only holds it in
        // memory, so a plugin reload or ST restart loses it.
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
        const resp = await api.apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-validate`,
        );
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return {
                valid: false,
                reason: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
            };
        }
        return await resp.json();
    } catch (e) {
        return { valid: false, reason: e.message };
    }
};

window.saucepanClearSession = async () => {
    // Drop the persisted token even when cl-helper is unreachable.
    CoreAPI.setSetting('saucepanToken', null);
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return false;
    try {
        const resp = await api.apiRequest(
            `${CL_HELPER_PLUGIN_BASE}/saucepan-clear-token`,
            'POST',
        );
        return resp.ok;
    } catch {
        return false;
    }
};

// ── JanitorAI account session (Supabase; unlocks Hampter pagination) ──────────
// Stateful layer over the pure grant helpers: persists the access token + rotating
// refresh token in settings, refreshes proactively, and shares one in-flight refresh
// so concurrent Hampter loads cant race the single-use refresh token.
let _janitoraiRefreshInFlight = null;

async function janitoraiDoRefresh() {
    if (_janitoraiRefreshInFlight) return _janitoraiRefreshInFlight;
    _janitoraiRefreshInFlight = (async () => {
        const rt = CoreAPI.getSetting('janitoraiRefreshToken');
        const res = await janitoraiRefreshGrant(rt);
        if (res.access_token) {
            CoreAPI.setSetting('janitoraiToken', res.access_token);
            if (res.refresh_token) CoreAPI.setSetting('janitoraiRefreshToken', res.refresh_token);
            return res.access_token;
        }
        // Only wipe the stored session when the refresh token is definitively dead,
        // never on a transient network blip (keeps the user logged in across hiccups).
        if (res.dead) {
            CoreAPI.setSetting('janitoraiToken', null);
            CoreAPI.setSetting('janitoraiRefreshToken', null);
        }
        return '';
    })();
    try { return await _janitoraiRefreshInFlight; }
    finally { _janitoraiRefreshInFlight = null; }
}

// Current valid access token, refreshing within 2min of expiry. '' when logged out / refresh failed.
window.getValidJanitoraiToken = async () => {
    const tok = CoreAPI.getSetting('janitoraiToken') || '';
    if (!tok) return '';
    const { expMs } = decodeJanitoraiClaims(tok);
    if (expMs && expMs - Date.now() > 120000) return tok;
    return (await janitoraiDoRefresh()) || '';
};

// Force a refresh (reactive path after an unexpected 401). Returns the new token or ''.
window.janitoraiForceRefresh = async () => janitoraiDoRefresh();

// Seed the session from a pasted sb-auth-auth-token cookie (or session JSON / bare JWT).
// Verification stays off Cloudflare-gated hampter: its preflight can 403 on a perfectly
// good token, and failing after the up-front rotation would strand the fresh pair.
window.janitoraiSetSession = async (pasted) => {
    const pair = parseJanitoraiSession(pasted);
    if (!pair) return { ok: false, error: 'Could not find a session in that value. Copy the whole sb-auth-auth-token cookie.' };
    const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
    let token = pair.access_token;
    // If the pasted access token is already stale but a refresh token came with it, rotate up front.
    if ((!expMs || expMs - Date.now() < 120000) && pair.refresh_token) {
        const r = await janitoraiRefreshGrant(pair.refresh_token);
        if (!r.access_token) {
            return { ok: false, error: r.dead
                ? 'That session is expired or invalid. Copy a fresh cookie after logging in again.'
                : 'Could not reach the JanitorAI auth service. Try again in a moment.' };
        }
        // A successful grant is itself the proof; the rotation consumed the single-use pasted
        // token, so proceed straight to persist.
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
};

window.janitoraiLogout = () => {
    CoreAPI.setSetting('janitoraiToken', null);
    CoreAPI.setSetting('janitoraiRefreshToken', null);
};

window.janitoraiSessionStatus = () => {
    const tok = CoreAPI.getSetting('janitoraiToken') || '';
    if (!tok) return { loggedIn: false };
    const { email, expMs } = decodeJanitoraiClaims(tok);
    return { loggedIn: true, email, expMs, hasRefresh: !!CoreAPI.getSetting('janitoraiRefreshToken') };
};
