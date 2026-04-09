// DataCat Provider — implementation for datacat.run character source
//
// DataCat aggregates JanitorAI characters with its own REST API layer
// and AI-powered character scoring. Uses ella.janitorai.com CDN for images.
// No version history. No authentication required.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy } from '../provider-utils.js';
import datacatBrowseView from './datacat-browse.js';
import {
    DATACAT_API_BASE,
    DATACAT_IMAGE_BASE,
    setApiRequest,
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
    submitExtraction,
    fetchExtractionStatus,
} from './datacat-api.js';

let api = null;

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

        const id = dc.id;
        if (!id) return null;

        return {
            providerId: 'datacat',
            id,
            fullPath: String(id),
            linkedAt: dc.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            char.data.extensions.datacat = {
                id: linkInfo.id,
                linkedAt: linkInfo.linkedAt || new Date().toISOString()
            };
        } else {
            delete char.data.extensions.datacat;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id);
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
        try {
            // Try the download endpoint first (closest to V2 format)
            const downloadData = await fetchDatacatDownload(linkInfo.id);
            if (downloadData?.data) {
                const character = await fetchDatacatCharacter(linkInfo.id);
                return buildV2FromDownload(downloadData, character);
            }

            // Fallback to building from character metadata
            const character = await fetchDatacatCharacter(linkInfo.id);
            if (character) return buildV2FromDatacat(character);

            return null;
        } catch (e) {
            console.error('[DatacatProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2') return rawData;
        return buildV2FromDatacat(rawData);
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

            const janitorUrl = `https://janitorai.com/characters/${linkInfo.id}`;
            const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;

            report?.('Submitting extraction request...');
            const result = await submitExtraction(janitorUrl, { publicFeed });
            if (!result?.success && !result?.queued && !result?.started) {
                api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction submit failed:', result?.error);
                return;
            }

            if (result?.queued) {
                const pos = result.queuePosition ? ` (position ${result.queuePosition})` : '';
                report?.(`Queued for extraction${pos}...`);
            } else {
                report?.('Extraction started...');
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

                const done = status.history?.find(h =>
                    h.characterId === linkInfo.id || h.character_id === linkInfo.id
                );
                if (done) {
                    report?.('Extraction complete');
                    api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction complete for', linkInfo.id);
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
                    report?.('Extraction complete');
                    return;
                }
            }
            report?.('Extraction timed out, using cached data');
            api?.debugLog?.('[DatacatProvider] refreshRemoteData: extraction timed out after', MAX_POLLS * POLL_INTERVAL / 1000, 'seconds');
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

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
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
            const character = await fetchDatacatCharacter(charId);
            if (!character) return null;

            return {
                id: character.character_id,
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
                chat_count: character.chat_count,
                message_count: character.message_count,
            };
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

        // No datacat extensions — cannot auto-enrich without a search API
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

            // Fetch full character data
            let character = hitData || await fetchDatacatCharacter(charId);
            if (!character) throw new Error('Could not fetch character data from DataCat');

            const characterName = character.chat_name || character.name || 'Unnamed';

            // Try download endpoint for best V2 mapping
            let characterCard;
            const downloadData = await fetchDatacatDownload(charId);
            if (downloadData?.data) {
                characterCard = buildV2FromDownload(downloadData, character);
            } else {
                characterCard = buildV2FromDatacat(character);
            }

            if (!characterCard?.data) throw new Error('Failed to build character card');

            // Ensure datacat extension is set
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.datacat = {
                ...(characterCard.data.extensions.datacat || {}),
                id: charId,
                creatorId: character.creator_id || null,
                creatorName: character.creator_name || null,
                linkedAt: new Date().toISOString()
            };

            assignGalleryId(characterCard, options, api);

            // Download avatar
            const avatarUrl = character.avatar ? `${DATACAT_IMAGE_BASE}${character.avatar}` : null;
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
                characterName, hasGallery: false,
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

    // TODO: No search API discovered yet — bulk link disabled until we find one
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
