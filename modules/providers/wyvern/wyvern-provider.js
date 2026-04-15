// Wyvern Provider — implementation for the Wyvern character source
//
// Handles browsing, linking, metadata fetching, and update checking
// against Wyvern's REST API (api.wyvern.chat).

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy, slugify } from '../provider-utils.js';
import wyvernBrowseView from './wyvern-browse.js';
import {
    initWyvernApi,
    WYVERN_API_BASE,
    WYVERN_SITE_BASE,
    getWyvernHeaders,
    wyvernMetadataCache,
    fetchWyvernMetadata,
    buildCharacterCardFromWyvern,
    getAvatarUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    firebaseSignIn,
} from './wyvern-api.js';

let api = null; // CoreAPI reference

// Cached raw API result from fetchLinkStats — reused by "View on" button
let _cachedLinkNode = null;

class WyvernProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'wyvern'; }
    get name() { return 'Wyvern'; }
    get icon() { return 'fa-solid fa-dragon'; }
    get iconUrl() { return `${WYVERN_SITE_BASE}/icon.png`; }
    get browseView() { return wyvernBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-eye', label: 'Views' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Likes' },
            stat3: null,
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initWyvernApi({ getSetting: coreAPI.getSetting, debugLog: coreAPI.debugLog });
    }

    async activate(container, options = {}) {
        await wyvernBrowseView.activate(container, options);
    }

    deactivate() {
        wyvernBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return wyvernBrowseView.renderFilterBar(); }
    renderView() { return wyvernBrowseView.renderView(); }
    renderModals() { return wyvernBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const wyvern = extensions?.wyvern;
        if (!wyvern) return null;

        const charId = wyvern.id;
        if (!charId) return null;

        return {
            providerId: 'wyvern',
            id: charId,
            fullPath: charId,
            linkedAt: wyvern.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.wyvern || {};
            char.data.extensions.wyvern = {
                id: linkInfo.id || linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.wyvern;
        }
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id && !linkInfo?.fullPath) return null;
        return getCharacterPageUrl(linkInfo.id || linkInfo.fullPath);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        let metadata = this.getCachedLinkNode();
        if (!metadata) {
            const charId = linkInfo?.id || linkInfo?.fullPath;
            if (!charId) return null;
            try {
                const url = `${WYVERN_API_BASE}/characters/${charId}`;
                const response = await fetchWithProxy(url, { headers: this._getHeaders() });
                metadata = await response.json();
            } catch (e) {
                return null;
            }
            if (!metadata) return null;
            _cachedLinkNode = metadata;
        } else {
            this.clearCachedLinkNode();
        }

        return metadata;
    }

    openPreview(previewChar) {
        window.openWyvernCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.wyvern;
        if (!ext?.id) return null;

        return {
            cardData,
            providerInfo: {
                providerId: 'wyvern',
                charId: ext.id,
                fullPath: ext.id,
                hasGallery: true,
                avatarUrl: null
            }
        };
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(charId) {
        return fetchWyvernMetadata(charId);
    }

    /**
     * Fetch the remote card for update comparison.
     * Returns V2-wrapped format: { spec, spec_version, data }.
     */
    async fetchRemoteCard(linkInfo) {
        const charId = linkInfo?.id || linkInfo?.fullPath;
        if (!charId) return null;

        try {
            const metadata = await this.fetchMetadata(charId);
            if (!metadata) return null;
            const result = buildCharacterCardFromWyvern(metadata);
            if (result) result._listingName = this.getListingName(metadata);
            return result;
        } catch (e) {
            console.error('[WyvernProvider] fetchRemoteCard failed:', charId, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (!rawData) return null;
        if (rawData.spec === 'chara_card_v2') return rawData;
        return buildCharacterCardFromWyvern(rawData);
    }

    // ── Link Stats ──────────────────────────────────────────

    /**
     * Fetch live stats for the link modal.
     * Caches the full raw API result for reuse by getCachedLinkNode().
     */
    async fetchLinkStats(linkInfo) {
        const charId = linkInfo?.id || linkInfo?.fullPath;
        if (!charId) return null;
        try {
            const url = `${WYVERN_API_BASE}/characters/${charId}`;
            const response = await fetchWithProxy(url, { headers: this._getHeaders() });
            const node = await response.json();
            if (!node) return null;

            _cachedLinkNode = node;

            const sr = node.statistics_record || node.entity_statistics || {};
            return {
                stat1: sr.views || sr.total_views || node.views || 0,
                stat2: sr.likes || sr.total_likes || node.likes || 0,
                stat3: null
            };
        } catch (e) {
            api?.debugLog?.('[WyvernProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.wyvern.tagline',
                label: 'Wyvern Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() {
        return !!(api?.getSetting('wyvernToken'));
    }

    openAuthUI() {
        window.openWyvernLoginModal?.();
    }

    getAuthHeaders() {
        const token = api?.getSetting('wyvernToken');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?app\.wyvern\.chat$/i.test(u.hostname);
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
                key: 'wyvernToken',
                label: 'Auth Token',
                type: 'password',
                defaultValue: null,
                hint: 'Firebase ID token (managed by login — no manual entry needed)',
                section: 'Authentication'
            },
            {
                key: 'wyvernRefreshToken',
                label: 'Refresh Token',
                type: 'password',
                defaultValue: null,
                hint: 'Used for automatic token renewal',
                section: 'Authentication'
            },
            {
                key: 'wyvernRememberToken',
                label: 'Remember credentials between sessions',
                type: 'checkbox',
                defaultValue: false,
                section: 'Authentication'
            },
            {
                key: 'wyvernNsfw',
                label: 'Show NSFW content',
                type: 'checkbox',
                defaultValue: false,
                section: 'Display'
            },
            {
                key: 'showWyvernTagline',
                label: 'Show Wyvern tagline in character details',
                type: 'checkbox',
                defaultValue: true,
                section: 'Display'
            }
        ];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    /**
     * Search Wyvern for characters matching name/creator.
     */
    async searchForBulkLink(name, creator) {
        try {
            const headers = this._getHeaders();
            const normalizedName = name.toLowerCase().trim();
            const normalizedCreator = creator ? creator.toLowerCase().trim() : '';

            const params = new URLSearchParams({
                limit: '50',
                sort: 'votes',
                order: 'DESC',
                q: name.trim(),
            });
            const resp = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, { headers });
            const data = await resp.json();
            const characters = data.results || [];

            const results = [];
            for (const char of characters) {
                const charName = (char.name || '').toLowerCase().trim();
                const charCreator = (char.creator?.displayName || char.creator?.username || '').toLowerCase().trim();
                const nameMatch = charName === normalizedName || charName.includes(normalizedName) || normalizedName.includes(charName);
                const creatorMatch = !normalizedCreator || charCreator.includes(normalizedCreator);
                if (nameMatch && creatorMatch) {
                    results.push(this._normalizeSearchResult(char));
                }
            }

            return results;
        } catch (error) {
            console.error('[WyvernProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '/img/ai4.png';
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    async importCharacter(charId, hitData, options = {}) {
        try {
            const metadata = await this.fetchMetadata(charId);
            if (!metadata) {
                throw new Error('Could not fetch character data from API');
            }

            const characterName = metadata.name || 'Unknown';
            const characterCard = buildCharacterCardFromWyvern(metadata);

            const metadataId = metadata.id;
            const metadataTagline = metadata.tagline || '';

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.wyvern = {
                id: metadataId,
                tagline: metadataTagline,
                pageName: this.getListingName(metadata),
                linkedAt: new Date().toISOString()
            };

            assignGalleryId(characterCard, options, api);

            // Avatar download
            const avatarUrl = getAvatarUrl(metadata);
            let imageBuffer = null;
            if (avatarUrl && avatarUrl !== '/img/ai4.png') {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch { /* placeholder will be generated */ }
            }

            wyvernMetadataCache.delete(charId);

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `wyvern_${slugify(characterName)}.png`,
                characterName,
                hasGallery: !!(metadata.gallery?.length),
                providerCharId: metadataId,
                fullPath: metadataId,
                avatarUrl,
                api
            });
        } catch (error) {
            console.error(`[WyvernProvider] importCharacter failed for ${charId}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator, localChar) {
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
            console.error('[WyvernProvider] searchForImportMatch:', e);
            return null;
        }
    }

    // ── Gallery Download ────────────────────────────────────

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        try {
            const data = await fetchWyvernMetadata(linkInfo.id);
            if (!data?.gallery?.length) return [];

            return data.gallery.map(img => ({
                url: img.imageURL,
                id: img.id
            }));
        } catch (e) {
            console.error('[WyvernProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _getHeaders() {
        const auth = this.getAuthHeaders();
        return { Accept: 'application/json', ...auth };
    }

    _normalizeSearchResult(char) {
        return {
            id: char.id || null,
            fullPath: char.id || '',
            name: char.name || '',
            avatarUrl: getAvatarUrl(char),
            rating: 0,
            starCount: char.likes || 0,
            description: char.tagline || '',
            tagline: char.tagline || '',
            nTokens: 0,
        };
    }
}

// Singleton instance
const wyvernProvider = new WyvernProvider();

window.wyvernLoginCheck = async (email, password) => {
    try {
        if (!email || !password) return { ok: false, error: 'Email and password required' };
        const result = await firebaseSignIn(email, password);
        if (result.idToken) return { ok: true, token: result.idToken };
        return { ok: false, error: 'No token returned' };
    } catch (err) {
        return { ok: false, error: err.message || 'Authentication failed' };
    }
};

export default wyvernProvider;
