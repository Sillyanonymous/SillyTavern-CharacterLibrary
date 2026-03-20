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
        return fetchDatacatCharacter(characterId);
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
            // Path: /characters/:uuid or /character/:uuid
            const match = u.pathname.match(/\/characters?\/([a-f0-9-]{36})/i);
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
