// ChubAI Provider — full implementation for the Chub character source
//
// Handles browsing, linking, metadata fetching, update checking, and
// version history against ChubAI's APIs (REST metadata + V4 Git).

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, slugify } from '../provider-utils.js';
import chubBrowseView, { openChubTokenModal } from './chub-browse.js';
import {
    initChubApi,
    CHUB_API_BASE,
    CHUB_GATEWAY_BASE,
    CHUB_AVATAR_BASE,
    fetchWithProxy,
    extractNodes,
    chubMetadataCache,
    fetchChubMetadata,
    fetchChubLinkedLorebook,
    buildCharacterCardFromChub,
} from './chub-api.js';

let api = null; // CoreAPI reference

// Cached state for version history session
let _metadata = null;
let _projectId = null;
let _metadataPath = null;

// Cached raw API node from fetchLinkStats — reused by "View on" button
let _cachedLinkNode = null;

/**
 * Normalize a raw Chub definition (non-V2) into V2 card format.
 * Handles both Chub API field names and partial V2 objects.
 */
function normalizeToV2(def, metadata) {
    if (!def) return null;
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || metadata?.name || '',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            creator_notes: def.description || '',
            creator: metadata?.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            tags: metadata?.topics || [],
            alternate_greetings: def.alternate_greetings || [],
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: metadata?.tagline || ''
                }
            },
            character_book: def.embedded_lorebook || def.character_book || undefined,
        }
    };
}

/**
 * Flatten a card (possibly V2-wrapped) into a flat field object for diff display.
 * Preserves avatar URL in _avatarUrl.
 */
function flattenCard(def) {
    if (!def) return {};
    if (def.spec === 'chara_card_v2' && def.data) {
        const out = { ...def.data };
        if (def.data.avatar) out._avatarUrl = def.data.avatar;
        return out;
    }
    if (def.data && (def.data.description !== undefined || def.data.first_mes !== undefined)) {
        const out = { ...def.data };
        if (def.data.avatar) out._avatarUrl = def.data.avatar;
        return out;
    }
    return {
        name: def.name || '',
        description: def.personality || '',
        personality: def.tavern_personality || '',
        scenario: def.scenario || '',
        first_mes: def.first_message || '',
        mes_example: def.example_dialogs || '',
        system_prompt: def.system_prompt || '',
        post_history_instructions: def.post_history_instructions || '',
        creator_notes: def.description || '',
        creator: def.creator || '',
        character_version: def.character_version || '',
        tags: def.tags || def.topics || [],
        alternate_greetings: def.alternate_greetings || [],
        character_book: def.embedded_lorebook || def.character_book || undefined,
        extensions: def.extensions || {},
    };
}

class ChubProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'chub'; }
    get name() { return 'ChubAI'; }
    get icon() { return 'fa-solid fa-cloud-arrow-down'; }
    get iconUrl() { return 'https://avatars.charhub.io/icons/assets/full_logo.png'; }
    get browseView() { return chubBrowseView; }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initChubApi({ getSetting: coreAPI.getSetting, debugLog: coreAPI.debugLog });
    }

    async activate(container, options = {}) {
        chubBrowseView.activate(container, options);
    }

    deactivate() {
        chubBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return chubBrowseView.renderFilterBar(); }
    renderView() { return chubBrowseView.renderView(); }
    renderModals() { return chubBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const chub = extensions?.chub;
        if (!chub) return null;

        const fullPath = chub.fullPath || chub.full_path;
        if (!fullPath) return null;

        return {
            providerId: 'chub',
            id: chub.id || null,
            fullPath,
            linkedAt: chub.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.chub || {};
            char.data.extensions.chub = {
                id: linkInfo.id,
                full_path: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.chub;
        }
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        return `https://chub.ai/characters/${linkInfo.fullPath}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const metadata = this.getCachedLinkNode();
        if (!metadata) return null;

        const previewChar = {
            id: metadata.id,
            fullPath: linkInfo.fullPath,
            name: metadata.name || metadata.definition?.name,
            description: metadata.description,
            tagline: metadata.tagline,
            avatar_url: `https://avatars.charhub.io/avatars/${linkInfo.fullPath}/avatar.webp`,
            rating: metadata.rating,
            ratingCount: metadata.ratingCount || metadata.rating_count,
            starCount: metadata.starCount || metadata.star_count,
            n_favorites: metadata.n_favorites || metadata.nFavorites,
            nDownloads: metadata.nDownloads || metadata.n_downloads || metadata.downloadCount,
            nTokens: metadata.nTokens || metadata.n_tokens,
            n_greetings: metadata.n_greetings || metadata.nGreetings,
            has_lore: metadata.has_lore || metadata.hasLore,
            topics: metadata.topics || [],
            related_lorebooks: metadata.related_lorebooks || metadata.relatedLorebooks || [],
            createdAt: metadata.createdAt || metadata.created_at,
            lastActivityAt: metadata.lastActivityAt || metadata.last_activity_at,
            definition: metadata.definition,
            alternate_greetings: metadata.definition?.alternate_greetings || []
        };

        this.clearCachedLinkNode();
        return previewChar;
    }

    openPreview(previewChar) {
        window.openChubCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.chub;
        const fullPath = ext?.fullPath || ext?.full_path;
        if (!ext?.id && !fullPath) return null;

        return {
            cardData,
            providerInfo: {
                providerId: 'chub',
                charId: ext.id || null,
                fullPath: fullPath || null,
                hasGallery: !!ext.id,
                avatarUrl: fullPath ? `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp` : null
            }
        };
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        return fetchChubMetadata(fullPath);
    }

    /**
     * Fetch the remote card for update comparison.
     * Returns V2-wrapped format: { spec, spec_version, data }.
     *
     * Pipeline:
     *   1. V4 Git card.json (if chubUseV4Api enabled)
     *   2. Metadata API + field mapping
     *   3. PNG extraction fallback
     */
    async fetchRemoteCard(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        const useV4 = api?.getSetting('chubUseV4Api') || false;

        try {
            const metadata = await this.fetchMetadata(fullPath);
            const projectId = metadata?.id;

            const _listingName = this.getListingName(metadata);

            // V4 Git card.json — canonical exported state
            if (useV4 && projectId) {
                const cardJson = await this._fetchCardFromV4(projectId);
                if (cardJson) {
                    if (cardJson.data) {
                        if (metadata.topics && !cardJson.data.tags?.length)
                            cardJson.data.tags = metadata.topics;
                        if (metadata.tagline) {
                            cardJson.data.extensions = cardJson.data.extensions || {};
                            cardJson.data.extensions.chub = cardJson.data.extensions.chub || {};
                            if (!cardJson.data.extensions.chub.tagline)
                                cardJson.data.extensions.chub.tagline = metadata.tagline;
                        }
                        cardJson._listingName = _listingName;
                        return cardJson;
                    }
                    const result = normalizeToV2(cardJson, metadata);
                    if (result) result._listingName = _listingName;
                    return result;
                }
            }

            // Metadata API path
            if (metadata?.definition) {
                const result = await this._buildCardFromMetadata(metadata);
                if (result) result._listingName = _listingName;
                return result;
            }

            // Last resort: PNG extraction
            const pngUrl = `${CHUB_AVATAR_BASE}${fullPath}/chara_card_v2.png`;
            let response;
            try { response = await fetch(pngUrl); }
            catch { response = await fetch(`/proxy/${encodeURIComponent(pngUrl)}`); }
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                const cardData = api?.extractCharacterDataFromPng?.(buffer);
                if (cardData) return cardData;
            }
            return null;
        } catch (e) {
            console.error('[ChubProvider] fetchRemoteCard failed:', fullPath, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return normalizeToV2(rawData);
    }

    async fetchLorebook(linkInfo) {
        if (!linkInfo?.id) return null;
        return fetchChubLinkedLorebook(linkInfo.id);
    }

    // ── Link Stats ──────────────────────────────────────────

    /**
     * Fetch live stats (downloads, favorites, tokens) for the link modal.
     * Caches the full raw API node for reuse by getCachedLinkNode().
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<{downloads: number, favorites: number, tokens: number}|null>}
     */
    async fetchLinkStats(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        try {
            const url = `${CHUB_API_BASE}/api/characters/${fullPath}?full=true`;
            const response = await fetchWithProxy(url, { headers: this._getHeaders() });
            const data = await response.json();
            const node = data.node;
            if (!node) return null;

            _cachedLinkNode = node;

            return {
                stat1: node.starCount || 0,
                stat2: node.n_favorites || node.nFavorites || 0,
                stat3: node.nTokens || node.n_tokens || 0
            };
        } catch (e) {
            api?.debugLog?.('[ChubProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    /**
     * Return the raw API node cached by the last fetchLinkStats() call.
     * Used by the link modal's "View on ChubAI" action.
     */
    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    /**
     * Clear the cached link node (e.g. after it's been consumed).
     */
    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.chub.tagline',
                label: 'Chub Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Version History ─────────────────────────────────────

    get supportsVersionHistory() { return true; }

    get supportsRemotePageVersion() { return true; }

    get remoteVersionLabel() { return 'Chub Page'; }

    /**
     * Fetch commit list from V4 Git API.
     * Caches the project ID and metadata for use by fetchVersionData / fetchRemotePageCard.
     * @returns {ProviderVersionEntry[]}
     */
    async fetchVersionList(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return [];

        // Resolve project ID via metadata (also caches metadata for page entry)
        const id = await this._getProjectId(fullPath);
        if (!id) return [];

        const r = await fetchWithProxy(
            `${CHUB_API_BASE}/api/v4/projects/${id}/repository/commits`,
            { headers: this._getHeaders() }
        );
        const commits = await r.json();
        if (!Array.isArray(commits)) return [];

        return commits.map(c => ({
            ref: c.id,
            date: c.committed_date || c.created_at,
            message: c.message || c.title || '',
            author: c.author_name || c.committer_name || ''
        }));
    }

    /**
     * Fetch the card.json at a specific commit ref.
     * Returns flat card fields for diff display (unwrapped from V2 if needed).
     */
    async fetchVersionData(linkInfo, ref) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;

        // Ensure cached projectId belongs to the requested character
        if (!_projectId || _metadataPath !== fullPath) {
            await this._getProjectId(fullPath);
        }
        if (!_projectId) return null;
        const url = `${CHUB_API_BASE}/api/v4/projects/${_projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`;
        try {
            const r = await fetchWithProxy(url, { headers: this._getHeaders() });
            const d = await r.json();
            return flattenCard(d);
        } catch (e) {
            console.error('[ChubProvider] fetchVersionData:', ref, e);
            return null;
        }
    }

    /**
     * Build a flat card from the cached metadata API response.
     * This represents the current published state on the Chub website,
     * which may differ from Git-exported versions.
     */
    async fetchRemotePageCard(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;

        // Ensure cached metadata belongs to the requested character
        if (!_metadata?.definition || _metadataPath !== fullPath) {
            await this._getProjectId(fullPath);
        }
        if (!_metadata?.definition) return null;

        const def = _metadata.definition;
        const enriched = { ...def };
        if (!enriched.tags && _metadata.topics) enriched.tags = _metadata.topics;
        if (_metadata.tagline) {
            enriched.extensions = enriched.extensions || {};
            enriched.extensions.chub = enriched.extensions.chub || {};
            if (!enriched.extensions.chub.tagline) enriched.extensions.chub.tagline = _metadata.tagline;
        }
        if (!enriched.creator && _metadata.fullPath) {
            enriched.creator = _metadata.fullPath.split('/')[0] || '';
        }

        const card = flattenCard(enriched);

        // Resolve linked lorebook
        const embeddedCount = card.character_book?.entries?.length || 0;
        if (_metadata.related_lorebooks?.length > 0 && _metadata.id) {
            try {
                const linked = await this.fetchLorebook({ id: _metadata.id });
                if (linked?.entries?.length > 0) {
                    card._metaLorebookEntries = embeddedCount;
                    card._linkedLorebook = true;
                    card.character_book = linked;
                }
            } catch (e) {
                console.warn('[ChubProvider] Failed to resolve linked lorebook for page entry', e);
            }
        }
        return card;
    }

    getRemotePageInfo() {
        if (!_metadata) return null;
        return {
            date: _metadata.last_activity_at || _metadata.updated_at || null,
            description: 'Current state from the ChubAI metadata API. May differ from Git-exported versions if the creator edited via the website without committing a new export.'
        };
    }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() {
        return !!(api?.getSetting('chubToken'));
    }

    openAuthUI() {
        // Existing token modal in library.html
        const modal = document.getElementById('chubLoginModal');
        if (modal) {
            modal.classList.remove('hidden');
            openChubTokenModal();
        }
    }

    getAuthHeaders() {
        const token = api?.getSetting('chubToken');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?chub\.ai$/i.test(u.hostname)
                || /^(www\.)?characterhub\.org$/i.test(u.hostname)
                || /^venus\.chub\.ai$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Paths like /characters/creator/slug or /creator/slug
            const parts = u.pathname.replace(/^\/characters\//, '/').split('/').filter(Boolean);
            if (parts.length >= 2) {
                return `${parts[0]}/${parts[1]}`;
            }
        } catch { /* ignore */ }
        return null;
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [
            {
                key: 'chubToken',
                label: 'URQL Token',
                type: 'password',
                defaultValue: null,
                hint: 'Token for ChubAI API authentication',
                section: 'Authentication'
            },
            {
                key: 'chubRememberToken',
                label: 'Remember token between sessions',
                type: 'checkbox',
                defaultValue: false,
                section: 'Authentication'
            },
            {
                key: 'includeProviderGallery',
                label: 'Include provider gallery images',
                type: 'checkbox',
                defaultValue: true,
                section: 'Media'
            },
            {
                key: 'showProviderTagline',
                label: 'Show Chub tagline in character details',
                type: 'checkbox',
                defaultValue: true,
                section: 'Display'
            },
            {
                key: 'chubUseV4Api',
                label: 'Use V4 Git API for card updates',
                type: 'checkbox',
                defaultValue: false,
                hint: 'More accurate but slower. Uses the Git repository directly.',
                section: 'Updates'
            }
        ];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    /**
     * Search ChubAI for characters matching name/creator.
     * Uses multiple strategies: author filter, combined term, name-only fallback.
     * Returns normalized result objects with { id, fullPath, name, avatarUrl, ... }.
     */
    async searchForBulkLink(name, creator) {
        // Use module-level constants from chub-api.js
        try {
            const headers = this._getHeaders();
            let allResults = [];
            const normalizedName = name.toLowerCase().trim();
            const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 2);

            // Pass 1: author filter — most reliable when creator is known
            if (creator && creator.trim()) {
                const creatorLower = creator.toLowerCase().trim();
                const authorParams = new URLSearchParams({
                    first: '200',
                    sort: 'download_count',
                    nsfw: 'true',
                    nsfl: 'true',
                    include_forks: 'true',
                    username: creatorLower
                });
                try {
                    const authorResp = await fetch(`${CHUB_API_BASE}/search?${authorParams}`, { method: 'GET', headers });
                    if (authorResp.ok) {
                        const authorData = await authorResp.json();
                        const authorNodes = this._extractNodes(authorData);
                        for (const node of authorNodes) {
                            const nodeName = (node.name || '').toLowerCase().trim();
                            const nodeWords = nodeName.split(/\s+/).filter(w => w.length > 2);
                            const firstWordMatch = nodeWords.length > 0 && nameWords.length > 0 &&
                                (nodeWords[0] === nameWords[0] || nodeWords[0].startsWith(nameWords[0]) || nameWords[0].startsWith(nodeWords[0]));
                            const anyWordMatch = nameWords.some(w => nodeName.includes(w));
                            if (nodeName === normalizedName || nodeName.includes(normalizedName) ||
                                normalizedName.includes(nodeName) || firstWordMatch || anyWordMatch) {
                                allResults.push(this._normalizeSearchResult(node, CHUB_AVATAR_BASE));
                            }
                        }
                        if (allResults.length > 0) {
                            api?.debugLog?.(`[ChubProvider] Bulk search: ${allResults.length} matches for "${name}" by "${creator}"`);
                            return allResults;
                        }
                    }
                } catch (e) {
                    api?.debugLog?.('[ChubProvider] Author search failed, falling back');
                }
            }

            // Pass 2: combined name + creator search term
            const searchTerm = creator ? `${name} ${creator}` : name;
            const params = new URLSearchParams({
                search: searchTerm, first: '10', sort: 'download_count',
                nsfw: 'true', nsfl: 'true', include_forks: 'true', min_tokens: '50'
            });
            const resp = await fetch(`${CHUB_API_BASE}/search?${params}`, { method: 'GET', headers });
            if (resp.ok) {
                const data = await resp.json();
                for (const node of this._extractNodes(data)) {
                    if (!allResults.some(r => r.fullPath === node.fullPath)) {
                        allResults.push(this._normalizeSearchResult(node, CHUB_AVATAR_BASE));
                    }
                }
            }

            // Pass 3: name-only fallback
            if (allResults.length === 0 && creator) {
                const nameParams = new URLSearchParams({
                    search: name, first: '15', sort: 'download_count',
                    nsfw: 'true', nsfl: 'true', include_forks: 'true', min_tokens: '50'
                });
                const nameResp = await fetch(`${CHUB_API_BASE}/search?${nameParams}`, { method: 'GET', headers });
                if (nameResp.ok) {
                    const nameData = await nameResp.json();
                    allResults = this._extractNodes(nameData).map(n => this._normalizeSearchResult(n, CHUB_AVATAR_BASE));
                }
            }

            return allResults;
        } catch (error) {
            console.error('[ChubProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || `${CHUB_AVATAR_BASE}${result.fullPath}/avatar`;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    async importCharacter(fullPath, hitData, options = {}) {
        try {
            let metadata = await this.fetchMetadata(fullPath);
            if (!metadata || !metadata.definition) {
                throw new Error('Could not fetch character data from API');
            }

            const hasGallery = metadata.hasGallery || false;
            const characterName = metadata.definition?.name || metadata.name || fullPath.split('/').pop();
            const characterCard = await this._buildCardFromMetadata(metadata);

            const metadataId = metadata.id || null;
            const metadataTagline = metadata.tagline || metadata.definition?.tagline || '';
            const metadataListingName = this.getListingName(metadata);
            const metadataMaxResUrl = metadata.max_res_url || null;
            const metadataAvatarUrl = metadata.avatar_url || null;
            metadata = null;

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existingChub = characterCard.data.extensions.chub || {};
            characterCard.data.extensions.chub = {
                ...existingChub,
                id: metadataId || existingChub.id || null,
                full_path: fullPath,
                tagline: metadataTagline || existingChub.tagline || '',
                pageName: metadataListingName || existingChub.pageName || null,
                linkedAt: new Date().toISOString()
            };

            assignGalleryId(characterCard, options, api);

            // Avatar download — priority chain
            const imageUrls = [];
            if (metadataMaxResUrl) imageUrls.push(metadataMaxResUrl);
            if (hitData?.avatar_url) imageUrls.push(hitData.avatar_url);
            if (metadataAvatarUrl) imageUrls.push(metadataAvatarUrl);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/avatar.png`);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/chara_card_v2.png`);
            const uniqueUrls = [...new Set(imageUrls)];

            let imageBuffer = null;
            for (const url of uniqueUrls) {
                try {
                    const resp = await fetchWithProxy(url);
                    imageBuffer = await resp.arrayBuffer();
                    break;
                } catch { /* try next */ }
            }

            chubMetadataCache.delete(fullPath);

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `chub_${slugify(characterName)}.png`,
                characterName, hasGallery,
                providerCharId: metadataId,
                fullPath,
                avatarUrl: `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`,
                api
            });
        } catch (error) {
            console.error(`[ChubProvider] importCharacter failed for ${fullPath}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Gallery Download ────────────────────────────────────

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        // Use module-level CHUB_GATEWAY_BASE from chub-api.js
        try {
            const url = `${CHUB_GATEWAY_BASE}/api/gallery/project/${linkInfo.id}?limit=100&count=false`;
            const response = await fetchWithProxy(url, { headers: this._getHeaders() });
            const data = await response.json();
            if (!data.nodes || !Array.isArray(data.nodes)) return [];
            return data.nodes.map(node => ({
                url: node.primary_image_path,
                id: node.uuid,
                nsfw: node.nsfw_image || false
            }));
        } catch (e) {
            console.error('[ChubProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator, localChar) {
        if (!name) return null;
        try {
            // Reuse searchForBulkLink which already has multi-pass search
            const results = await this.searchForBulkLink(name, creator || '');
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            for (const r of results) {
                const rName = (r.name || '').toLowerCase().trim();
                if (rName === normalizedName || rName.includes(normalizedName) || normalizedName.includes(rName)) {
                    return { id: r.id, fullPath: r.fullPath, hasGallery: false };
                }
            }

            // Return best match if available
            return { id: results[0].id, fullPath: results[0].fullPath, hasGallery: false };
        } catch (e) {
            console.error('[ChubProvider] searchForImportMatch:', e);
            return null;
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _getHeaders() {
        const auth = this.getAuthHeaders();
        return { Accept: 'application/json', ...auth };
    }

    /**
     * Extract nodes from Chub API response (various envelope formats).
     */
    _extractNodes(data) {
        return extractNodes(data);
    }

    /**
     * Normalize a raw Chub search result node into the standard bulk-link format.
     */
    _normalizeSearchResult(node, avatarBase) {
        return {
            id: node.id || null,
            fullPath: node.fullPath || '',
            name: node.name || node.fullPath?.split('/').pop() || '',
            avatarUrl: node.avatar_url || `${avatarBase}${node.fullPath}/avatar`,
            rating: node.rating || 0,
            starCount: node.starCount || 0,
            description: node.description || node.tagline || '',
            tagline: node.tagline || '',
            nTokens: node.nTokens || node.n_tokens || 0,
        };
    }

    async _getProjectId(fullPath) {
        try {
            const m = await this.fetchMetadata(fullPath);
            _metadata = m || null;
            _projectId = m?.id || null;
            _metadataPath = fullPath;
            return _projectId;
        } catch {
            _metadata = null;
            _projectId = null;
            _metadataPath = null;
            return null;
        }
    }

    /**
     * Fetch latest card.json from V4 Git API (latest commit).
     * Returns raw JSON (may or may not be V2-wrapped).
     */
    async _fetchCardFromV4(projectId) {
        if (!projectId) return null;
        try {
            const commitsResp = await fetchWithProxy(
                `${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/commits`,
                { headers: this._getHeaders() }
            );
            const commits = await commitsResp.json();
            const ref = Array.isArray(commits) && commits[0]?.id;
            if (!ref) return null;

            const cardResp = await fetchWithProxy(
                `${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`,
                { headers: this._getHeaders() }
            );
            return await cardResp.json() || null;
        } catch (e) {
            console.warn('[ChubProvider] V4 Git card.json fetch failed for project', projectId, e.message);
            return null;
        }
    }

    /**
     * Build a V2 card from metadata API response.
     * Delegates to the canonical builder in chub-api.js.
     */
    async _buildCardFromMetadata(metadata) {
        return buildCharacterCardFromChub(metadata);
    }
}

// Singleton instance
const chubProvider = new ChubProvider();
export default chubProvider;
