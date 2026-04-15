// Pygmalion Provider — implementation for pygmalion.chat character source
//
// Uses Connect RPC API (public, no auth required for read operations).
// Supports gallery (altAvatars + altImages + chatBackground).
// Supports version list (via the versions array in character detail).

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import pygmalionBrowseView from './pygmalion-browse.js';
import {
    PYGMALION_SITE_BASE,
    searchCharacters,
    fetchCharacterDetail,
    getAvatarUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    getGalleryImages,
    fetchWithProxy,
    slugify,
    getFollowedUsers,
    toggleFollowUser,
} from './pygmalion-api.js';

let api = null;

// ========================================
// V2 CARD BUILDING
// ========================================

/**
 * Build a V2 character card from a Pygmalion full character response.
 *
 * Pygmalion field mapping:
 *   personality.persona     → V2 description
 *   personality.greeting    → V2 first_mes
 *   personality.mesExample  → V2 mes_example
 *   personality.characterNotes → V2 creator_notes
 *   personality.creator     → V2 creator
 *   personality.name        → V2 name
 *   description             → short tagline (stored in extensions)
 *   alternateGreetings      → V2 alternate_greetings
 *   tags                    → V2 tags
 */
function buildV2FromDetail(char) {
    const p = char.personality || {};
    const owner = char.owner || {};

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: p.name || char.displayName || 'Unnamed',
            description: p.persona || '',
            personality: '',
            scenario: '',
            first_mes: p.greeting || '',
            mes_example: p.mesExample || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: p.characterNotes || '',
            creator: p.creator || owner.username || owner.displayName || '',
            character_version: char.versionLabel || '',
            tags: Array.isArray(char.tags) ? char.tags : [],
            alternate_greetings: Array.isArray(p.alternateGreetings) ? p.alternateGreetings.filter(Boolean) : [],
            extensions: {
                pygmalion: {
                    id: char.id,
                    versionId: char.versionId || null,
                    source: char.source || null,
                    ownerId: char.ownerId || null,
                    ownerUsername: owner.username || null,
                    tagline: char.description || '',
                    stars: char.stars || 0,
                    views: char.views || 0,
                    downloads: char.downloads || 0,
                    chatCount: char.chatCount || 0,
                }
            },
            character_book: undefined,
        }
    };
}

/**
 * Build a minimal V2 card from a search result (no personality fields).
 * Used as last-resort fallback when full detail fetch fails.
 */
function buildV2FromSearchHit(hit) {
    const owner = hit.owner || {};
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: hit.displayName || 'Unnamed',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: '',
            creator: owner.username || owner.displayName || '',
            character_version: '',
            tags: Array.isArray(hit.tags) ? hit.tags : [],
            alternate_greetings: [],
            extensions: {
                pygmalion: {
                    id: hit.id,
                    versionId: hit.versionId || null,
                    source: hit.source || null,
                    ownerId: hit.ownerId || null,
                    ownerUsername: owner.username || null,
                    tagline: hit.description || '',
                    stars: hit.stars || 0,
                    views: hit.views || 0,
                    downloads: hit.downloads || 0,
                    chatCount: hit.chatCount || 0,
                }
            },
            character_book: undefined,
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class PygmalionProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'pygmalion'; }
    get name() { return 'Pygmalion'; }
    get icon() { return 'fa-solid fa-fire'; }
    get iconUrl() { return `${PYGMALION_SITE_BASE}/icons/favicon-32x32.png`; }
    get browseView() { return pygmalionBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-star', label: 'Stars' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return pygmalionBrowseView.renderFilterBar(); }
    renderView() { return pygmalionBrowseView.renderView(); }
    renderModals() { return pygmalionBrowseView.renderModals(); }

    async activate(container, options = {}) {
        await pygmalionBrowseView.activate(container, options);
    }

    deactivate() {
        pygmalionBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const pyg = extensions?.pygmalion;
        if (!pyg) return null;

        const id = pyg.id;
        if (!id) return null;

        return {
            providerId: 'pygmalion',
            id,
            fullPath: id,
            linkedAt: pyg.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.pygmalion || {};
            char.data.extensions.pygmalion = {
                id: linkInfo.id,
                versionId: linkInfo.versionId || null,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.pygmalion;
        }
    }

    getListingName(hitData) {
        return hitData?.displayName || hitData?.name || null;
    }

    // ── Link Stats ───────────────────────────────────────────

    _cachedLinkData = null;

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            const char = data?.character;
            if (!char) return null;

            this._cachedLinkData = char;
            return {
                stat1: char.downloads || 0,
                stat2: char.stars || 0,
                stat3: char.personalityTokenCount || 0
            };
        } catch (e) {
            api?.debugLog?.('[PygmalionProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    getCachedLinkNode() { return this._cachedLinkData; }
    clearCachedLinkNode() { this._cachedLinkData = null; }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const data = await fetchCharacterDetail(fullPath, undefined, this.getToken());
            return data?.character || null;
        } catch (e) {
            console.error('[PygmalionProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (data?.character) {
                const result = buildV2FromDetail(data.character);
                if (result) result._listingName = this.getListingName(data.character);
                return result;
            }
            return null;
        } catch (e) {
            console.error('[PygmalionProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return buildV2FromDetail(rawData);
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.pygmalion.tagline',
                label: 'Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Version History ─────────────────────────────────────

    get supportsVersionHistory() { return false; }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return getCharacterPageUrl(linkInfo.id);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (data?.character) return data.character;
        } catch (e) {
            console.warn('[PygmalionProvider] buildPreviewObject failed:', e.message);
        }
        return null;
    }

    openPreview(previewChar) {
        window.openPygmalionCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.pygmalion;

        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'pygmalion',
                    charId: ext.id,
                    fullPath: ext.id,
                    hasGallery: true,
                    avatarUrl: null
                }
            };
        }

        // No Pygmalion extensions — try to find this character on Pygmalion
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            const match = results.find(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (!match) return null;

            // Verify creator if both are available
            if (creator && match.creator) {
                if (creator.toLowerCase() !== match.creator.toLowerCase()) return null;
            }

            // Fetch full detail for proper V2 field mapping
            const detail = await fetchCharacterDetail(match.id, undefined, this.getToken());
            if (!detail?.character) return null;

            const enrichedCard = buildV2FromDetail(detail.character);

            if (!enrichedCard.data.extensions) enrichedCard.data.extensions = {};
            enrichedCard.data.extensions.pygmalion = {
                ...(enrichedCard.data.extensions.pygmalion || {}),
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(detail.character),
            };

            // Preserve gallery_id from original card
            if (cardData.data?.extensions?.gallery_id) {
                enrichedCard.data.extensions.gallery_id = cardData.data.extensions.gallery_id;
            }

            const galleryImages = getGalleryImages(detail.character);
            return {
                cardData: enrichedCard,
                providerInfo: {
                    providerId: 'pygmalion',
                    charId: match.id,
                    fullPath: match.id,
                    hasGallery: galleryImages.length > 0,
                    avatarUrl: detail.character.avatarUrl || null
                }
            };
        } catch (e) {
            console.warn('[PygmalionProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() {
        return !!(api?.getSetting('pygmalionToken'));
    }

    openAuthUI() {
        window.openPygmalionTokenModal?.();
    }

    getAuthHeaders() {
        const token = api?.getSetting('pygmalionToken');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    getToken() {
        return api?.getSetting('pygmalionToken') || null;
    }

    async getFollowedUsers(opts = {}) {
        const token = this.getToken();
        if (!token) return { users: [], totalItems: 0 };
        return getFollowedUsers(token, opts);
    }

    async toggleFollowUser(userId) {
        const token = this.getToken();
        if (!token) throw new Error('Not authenticated');
        return toggleFollowUser(token, userId);
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?pygmalion\.chat$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        return parseCharacterUrl(url);
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [
            {
                key: 'pygmalionEmail',
                label: 'Email',
                type: 'text',
                defaultValue: null,
                hint: 'Pygmalion account email (requires cl-helper plugin)',
                section: 'Login'
            },
            {
                key: 'pygmalionPassword',
                label: 'Password',
                type: 'password',
                defaultValue: null,
                hint: 'Pygmalion account password (stored locally, never sent to third parties)',
                section: 'Login'
            },
            {
                key: 'pygmalionRememberCredentials',
                label: 'Remember credentials (auto-refresh token)',
                type: 'checkbox',
                defaultValue: false,
                section: 'Login'
            },
        ];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, _creator) {
        try {
            const data = await searchCharacters({ query: name, orderBy: 'downloads', pageSize: 15, page: 0 });
            return (data?.characters || []).map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[PygmalionProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from Pygmalion.
     * @param {string} characterId - Character UUID
     * @param {Object} [hitData] - Optional pre-fetched character data
     */
    async importCharacter(characterId, hitData, options = {}) {
        try {
            let char = null;

            // Try to use pre-fetched full detail first
            if (hitData?.personality) {
                char = hitData;
            }

            // Fetch full detail from API
            if (!char) {
                try {
                    const data = await fetchCharacterDetail(characterId, undefined, this.getToken());
                    char = data?.character;
                } catch (e) {
                    console.warn('[PygmalionProvider] Detail fetch failed:', e.message);
                }
            }

            // Fall back to search hit data (definitions will be empty)
            if (!char && hitData) {
                console.warn('[PygmalionProvider] Using search hit as last resort — definitions will be incomplete');
                char = hitData;
            }
            if (!char) throw new Error('Could not fetch character data from Pygmalion');

            const characterName = char.personality?.name || char.displayName || 'Unnamed';

            // Build V2 card
            const characterCard = char.personality
                ? buildV2FromDetail(char)
                : buildV2FromSearchHit(char);

            // Ensure link metadata
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.pygmalion = {
                ...(characterCard.data.extensions.pygmalion || {}),
                id: char.id || characterId,
                versionId: char.versionId || null,
                source: char.source || null,
                ownerId: char.ownerId || null,
                ownerUsername: char.owner?.username || null,
                linkedAt: new Date().toISOString(),
                tagline: char.description || '',
                pageName: this.getListingName(char),
                stars: char.stars || 0,
                views: char.views || 0,
                downloads: char.downloads || 0,
                chatCount: char.chatCount || 0,
            };

            assignGalleryId(characterCard, options, api);

            // Download avatar
            const avatarUrl = char.avatarUrl ? getAvatarUrl(char.avatarUrl) : null;
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[PygmalionProvider] Avatar download failed:', e.message);
                }
            }

            const galleryImages = getGalleryImages(char);

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `pyg_${slugify(characterName)}.png`,
                characterName,
                hasGallery: galleryImages.length > 0,
                providerCharId: char.id || characterId,
                fullPath: char.id || characterId,
                avatarUrl: avatarUrl || null,
                api
            });
        } catch (error) {
            console.error(`[PygmalionProvider] importCharacter failed for ${characterId}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Gallery ─────────────────────────────────────────────

    get supportsGallery() { return true; }
    get galleryFilePrefix() { return 'pygmaliongallery'; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (!data?.character) return [];
            return getGalleryImages(data.character);
        } catch (e) {
            console.error('[PygmalionProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator, _localChar) {
        if (!name) return null;
        try {
            const results = await this.searchForBulkLink(name, creator || '');
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            for (const r of results) {
                const rName = (r.name || '').toLowerCase().trim();
                if (rName === normalizedName || rName.includes(normalizedName) || normalizedName.includes(rName)) {
                    return { id: r.id, fullPath: r.id, hasGallery: true };
                }
            }
            return { id: results[0].id, fullPath: results[0].id, hasGallery: true };
        } catch (e) {
            console.error('[PygmalionProvider] searchForImportMatch:', e);
            return null;
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _normalizeSearchResult(hit) {
        const owner = hit.owner || {};
        return {
            id: hit.id || null,
            fullPath: hit.id || '',
            name: hit.displayName || 'Unnamed',
            avatarUrl: hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '',
            rating: 0,
            starCount: hit.stars || 0,
            description: hit.description || '',
            tagline: hit.description || '',
            nTokens: hit.personalityTokenCount || 0,
            creator: owner.username || owner.displayName || '',
        };
    }
}

const pygmalionProvider = new PygmalionProvider();

// Helper for Settings UI
window.pygmalionLoginCheck = async (email, password) => {
    try {
        if (!email || !password) return { ok: false, error: 'Email and password required' };
        
        const CL_HELPER_BASE = '/plugins/cl-helper';
        
        const resp = await CoreAPI.apiRequest(`${CL_HELPER_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.ok) {
            const data = await resp.json();
            const token = data?.result?.id_token || data.token;
            if (token) return { ok: true, token };
            return { ok: false, error: 'No token returned' };
        } 
        
        if (resp.status === 404) {
             return { ok: false, error: 'cl-helper plugin not installed or outdated' };
        }

        let errorMessage = `HTTP ${resp.status}`;
        try {
            const text = await resp.text();
            try {
                const errorJson = JSON.parse(text);
                if (errorJson.error) errorMessage = errorJson.error;
            } catch {
                if (text) errorMessage = `${resp.status} ${text}`;
            }
        } catch { /* body unreadable */ }
        
        return { ok: false, error: errorMessage };
    } catch (err) {
        return { ok: false, error: err.message || 'Unknown network error' };
    }
}

export default pygmalionProvider;
