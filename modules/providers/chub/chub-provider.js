// ChubAI Provider — full implementation for the Chub character source
//
// Handles browsing, linking, metadata fetching, update checking, and
// version history against ChubAI's APIs (REST metadata + V4 Git).

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import chubBrowseView, { openChubTokenModal } from './chub-browse.js';
import {
    initChubApi,
    CHUB_API_BASE,
    CHUB_GATEWAY_BASE,
    CHUB_AVATAR_BASE,
    getChubHeaders,
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
            char.data.extensions.chub = {
                id: linkInfo.id,
                full_path: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString()
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
                        return cardJson;
                    }
                    return normalizeToV2(cardJson, metadata);
                }
            }

            // Metadata API path
            if (metadata?.definition) {
                return await this._buildCardFromMetadata(metadata);
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
                downloads: node.starCount || 0,
                favorites: node.n_favorites || node.nFavorites || 0,
                tokens: node.nTokens || node.n_tokens || 0
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
                        allResults.push(this._normalizeSearchResult(node, AVATAR_BASE));
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

    /**
     * Import a character from ChubAI by its full path (e.g. "creator/slug").
     * Mirrors SillyTavern's own downloadChubCharacter() approach:
     * 1. Fetch character definition from API
     * 2. Download avatar IMAGE separately
     * 3. Build V2 card from API metadata with correct field mapping
     * 4. Embed card data into avatar PNG
     * 5. Send to ST's import endpoint
     */
    async importCharacter(fullPath) {
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
                linkedAt: new Date().toISOString()
            };

            if (api.getSetting?.('uniqueGalleryFolders') && !characterCard.data.extensions.gallery_id) {
                characterCard.data.extensions.gallery_id = api.generateGalleryId?.();
            }

            // Avatar download — priority chain
            const imageUrls = [];
            if (metadataMaxResUrl) imageUrls.push(metadataMaxResUrl);
            if (metadataAvatarUrl) imageUrls.push(metadataAvatarUrl);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/avatar.png`);
            imageUrls.push(`${CHUB_AVATAR_BASE}${fullPath}/chara_card_v2.png`);
            const uniqueUrls = [...new Set(imageUrls)];

            let imageBuffer = null;
            let needsConversion = false;
            for (const url of uniqueUrls) {
                try {
                    let response = await fetch(url);
                    if (!response.ok) response = await fetch(`/proxy/${encodeURIComponent(url)}`);
                    if (response.ok) {
                        imageBuffer = await response.arrayBuffer();
                        const ct = response.headers.get('content-type') || '';
                        needsConversion = url.endsWith('.webp') || ct.includes('webp');
                        break;
                    }
                } catch { /* try next */ }
            }

            if (!imageBuffer) throw new Error('Could not download character avatar from any available URL');

            let pngBuffer = imageBuffer;
            if (needsConversion) {
                pngBuffer = await api.convertImageToPng(imageBuffer);
                imageBuffer = null;
            }

            let embeddedPng = api.embedCharacterDataInPng(pngBuffer, characterCard);
            pngBuffer = null;

            const fileName = fullPath.split('/').pop() + '.png';
            let file = new File([embeddedPng], fileName, { type: 'image/png' });
            embeddedPng = null;

            let formData = new FormData();
            formData.append('avatar', file);
            formData.append('file_type', 'png');
            file = null;

            const csrfToken = api.getCSRFToken?.();
            const importResponse = await fetch('/api/characters/import', {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken },
                body: formData
            });
            formData = null;

            const responseText = await importResponse.text();
            if (!importResponse.ok) throw new Error(`Import error: ${responseText}`);

            let result;
            try { result = JSON.parse(responseText); }
            catch { throw new Error(`Invalid JSON response: ${responseText}`); }
            if (result.error) throw new Error('Import failed: Server returned error');

            const mediaUrls = api.findCharacterMediaUrls?.(characterCard) || [];
            const galleryId = characterCard.data.extensions?.gallery_id || null;

            // Release cached metadata
            chubMetadataCache.delete(fullPath);

            return {
                success: true,
                fileName: result.file_name || fileName,
                characterName,
                hasGallery,
                providerCharId: metadataId,
                fullPath,
                avatarUrl: `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`,
                embeddedMediaUrls: mediaUrls,
                galleryId
            };
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

    async downloadGallery(linkInfo, folderName, options = {}) {
        const { onProgress, onLog, onLogUpdate, shouldAbort, abortSignal } = options;
        let successCount = 0, errorCount = 0, skippedCount = 0;
        let filenameSkippedCount = 0;

        const logEntry = onLog?.('Fetching gallery list...', 'pending') ?? null;
        const galleryImages = await this.fetchGalleryImages(linkInfo);

        if (galleryImages.length === 0) {
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, 'No gallery images found', 'success');
            return { success: 0, skipped: 0, errors: 0, filenameSkipped: 0, aborted: false };
        }
        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Found ${galleryImages.length} gallery image(s)`, 'success');

        const useFastSkip = api.getSetting?.('fastFilenameSkip') || false;
        const validateHeaders = useFastSkip && (api.getSetting?.('fastSkipValidateHeaders') || false);
        let fileNameIndex = null;
        let existingHashMap = null;

        if (useFastSkip) {
            fileNameIndex = await api.getExistingFileIndex?.(folderName) || new Map();
        } else {
            existingHashMap = await api.getExistingFileHashes?.(folderName) || new Map();
        }

        async function ensureHashMap() {
            if (!existingHashMap) {
                existingHashMap = await api.getExistingFileHashes?.(folderName) || new Map();
            }
            return existingHashMap;
        }

        for (let i = 0; i < galleryImages.length; i++) {
            if ((shouldAbort?.()) || abortSignal?.aborted) {
                return { success: successCount, skipped: skippedCount, errors: errorCount, filenameSkipped: filenameSkippedCount, aborted: true };
            }

            const image = galleryImages[i];
            const displayUrl = image.url.length > 60 ? image.url.substring(0, 60) + '...' : image.url;
            const imgLog = onLog?.(`Checking ${displayUrl}`, 'pending') ?? null;

            // Fast filename skip
            if (useFastSkip && fileNameIndex) {
                const sanitizedName = api.extractSanitizedUrlName?.(image.url) || '';
                if (sanitizedName.length >= 4) {
                    const match = fileNameIndex.get(sanitizedName.toLowerCase());
                    if (match) {
                        let valid = true;
                        if (validateHeaders) {
                            try {
                                const resp = await fetch(match.localPath, { method: 'HEAD' });
                                const size = parseInt(resp.headers.get('Content-Length') || '0', 10);
                                valid = resp.ok && size >= 1024;
                            } catch { valid = false; }
                            if (!valid) api.debugLog?.('[ChubGallery] Fast skip rejected (HEAD validation):', match.fileName);
                        }
                        if (valid) {
                            skippedCount++;
                            filenameSkippedCount++;
                            if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Skipped (filename match): ${match.fileName}`, 'success');
                            onProgress?.(i + 1, galleryImages.length);
                            continue;
                        }
                    }
                }
            }

            let dl = await api.downloadMediaToMemory?.(image.url, 30000, abortSignal);
            if (!dl?.success) {
                errorCount++;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Failed: ${displayUrl} - ${dl?.error || 'unknown'}`, 'error');
                dl = null;
                onProgress?.(i + 1, galleryImages.length);
                continue;
            }

            const hashMap = await ensureHashMap();
            const contentHash = await api.calculateHash?.(dl.arrayBuffer);
            if (hashMap.has(contentHash)) {
                skippedCount++;
                dl = null;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Skipped (duplicate): ${displayUrl}`, 'success');
                onProgress?.(i + 1, galleryImages.length);
                continue;
            }

            if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Saving ${displayUrl}...`, 'pending');
            const saveResult = await this._saveGalleryImage(dl, image, folderName, contentHash);
            dl = null;

            if (saveResult.success) {
                successCount++;
                hashMap.set(contentHash, { fileName: saveResult.filename });
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Saved: ${saveResult.filename}`, 'success');
            } else {
                errorCount++;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Failed: ${displayUrl} - ${saveResult.error}`, 'error');
            }

            onProgress?.(i + 1, galleryImages.length);
            await new Promise(r => setTimeout(r, 50));
        }

        return { success: successCount, skipped: skippedCount, errors: errorCount, filenameSkipped: filenameSkippedCount, aborted: false };
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
            return _projectId;
        } catch {
            _metadata = null;
            _projectId = null;
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

    /**
     * Save a gallery image with the {prefix}_{hash}_{name} naming convention.
     */
    async _saveGalleryImage(downloadResult, imageInfo, folderName, contentHash) {
        try {
            const { arrayBuffer, contentType } = downloadResult;
            let extension = 'webp';
            if (contentType) {
                const mimeMap = {
                    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                    'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
                    'audio/ogg': 'ogg', 'audio/flac': 'flac'
                };
                if (mimeMap[contentType]) extension = mimeMap[contentType];
                else if (contentType.startsWith('audio/')) extension = contentType.split('/')[1].split(';')[0].replace('x-', '') || 'audio';
            } else {
                const urlMatch = imageInfo.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
                if (urlMatch) extension = urlMatch[1].toLowerCase();
            }

            const urlObj = new URL(imageInfo.url);
            const pathParts = urlObj.pathname.split('/');
            const originalFilename = pathParts[pathParts.length - 1] || 'gallery_image';
            const originalNameNoExt = originalFilename.includes('.')
                ? originalFilename.substring(0, originalFilename.lastIndexOf('.'))
                : originalFilename;
            const sanitizedName = originalNameNoExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
            const shortHash = (contentHash?.length >= 8) ? contentHash.substring(0, 8) : 'nohash00';
            const filenameBase = `${this.galleryFilePrefix}_${shortHash}_${sanitizedName}`;

            let base64Data = api.arrayBufferToBase64?.(arrayBuffer);
            downloadResult.arrayBuffer = null;

            const bodyStr = JSON.stringify({
                image: base64Data,
                filename: filenameBase,
                format: extension,
                ch_name: folderName
            });
            base64Data = null;

            const csrfToken = api.getCSRFToken?.();
            const resp = await fetch(`/api${api.getEndpoints?.()?.IMAGES_UPLOAD || '/images/upload'}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                body: bodyStr
            });

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`Upload failed: ${errText}`);
            }

            const saveResult = await resp.json();
            if (!saveResult?.path) throw new Error('No path returned from upload');

            return { success: true, localPath: saveResult.path, filename: `${filenameBase}.${extension}` };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }
}

// Singleton instance
const chubProvider = new ChubProvider();
export default chubProvider;
