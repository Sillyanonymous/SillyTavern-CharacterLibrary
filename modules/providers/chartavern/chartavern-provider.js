// CharacterTavern Provider — implementation for character-tavern.com character source
//
// Uses the CT REST API for search and character details. Cards are served as
// PNG files with embedded V2 data via their CDN. No version history or gallery support.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import chartavernBrowseView from './chartavern-browse.js';
import {
    CT_SITE_BASE,
    fetchWithProxy,
    searchCards,
    fetchCharacterDetail,
    getAvatarUrl,
    getCardPngUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    slugify,
    stripHtml,
    parseTags,
    checkCtSession,
    isCtSessionActive,
    ctSetCookie,
    ctValidateSession,
} from './chartavern-api.js';

let api = null;

// ========================================
// V2 CARD BUILDING
// ========================================

/**
 * Build V2 card from the detail API response (/api/character/{author}/{slug}).
 * Field mapping:
 *   definition_character_description → V2 description
 *   definition_first_message        → V2 first_mes
 *   definition_example_messages     → V2 mes_example
 *   definition_personality          → V2 personality
 *   definition_scenario             → V2 scenario
 *   definition_system_prompt        → V2 system_prompt
 *   definition_post_history_prompt  → V2 post_history_instructions
 *   tagline / description           → V2 creator_notes
 */
function buildV2FromDetail(card, authorName, altGreetings) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || 'Unnamed',
            description: card.definition_character_description || '',
            personality: card.definition_personality || '',
            scenario: card.definition_scenario || '',
            first_mes: card.definition_first_message || '',
            mes_example: card.definition_example_messages || '',
            system_prompt: card.definition_system_prompt || '',
            post_history_instructions: card.definition_post_history_prompt || '',
            creator_notes: card.description || '',
            creator: authorName || '',
            character_version: '',
            tags: card.tags ? parseTags(card.tags) : [],
            alternate_greetings: Array.isArray(altGreetings) ? altGreetings.filter(Boolean) : [],
            extensions: {
                chartavern: {
                    id: card.id || null,
                    path: card.path || null,
                    tagline: card.tagline || ''
                }
            },
            character_book: undefined,
        }
    };
}

/**
 * Build V2 card from a search hit (less detailed than the full API response).
 * Search hits include the actual character definitions.
 */
function buildV2FromSearchHit(hit) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: hit.name || 'Unnamed',
            description: hit.characterDefinition || '',
            personality: hit.characterPersonality || '',
            scenario: hit.characterScenario || '',
            first_mes: hit.characterFirstMessage || '',
            mes_example: hit.characterExampleMessages || '',
            system_prompt: '',
            post_history_instructions: hit.characterPostHistoryPrompt || '',
            creator_notes: hit.pageDescription || '',
            creator: hit.author || '',
            character_version: '',
            tags: hit.tags ? parseTags(hit.tags) : [],
            alternate_greetings: Array.isArray(hit.alternativeFirstMessage) ? hit.alternativeFirstMessage.filter(Boolean) : [],
            extensions: {
                chartavern: {
                    id: hit.id || null,
                    path: hit.path || null,
                    tagline: hit.tagline || ''
                }
            },
            character_book: undefined,
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class ChartavernProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'chartavern'; }
    get name() { return 'CharacterTavern'; }
    get icon() { return 'fa-solid fa-beer-mug-empty'; }
    get iconUrl() { return `${CT_SITE_BASE}/favicon.ico`; }
    get browseView() { return chartavernBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Likes' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    async activate(container, options = {}) {
        chartavernBrowseView.activate(container, options);
    }

    deactivate() {
        chartavernBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return chartavernBrowseView.renderFilterBar(); }
    renderView() { return chartavernBrowseView.renderView(); }
    renderModals() { return chartavernBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const ct = extensions?.chartavern;
        if (!ct) return null;

        const path = ct.path;
        if (!path) return null;

        return {
            providerId: 'chartavern',
            id: ct.id || null,
            fullPath: path,
            linkedAt: ct.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.chartavern || {};
            char.data.extensions.chartavern = {
                id: linkInfo.id || null,
                path: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.chartavern;
        }
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        return getCharacterPageUrl(linkInfo.fullPath);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const path = linkInfo?.fullPath;
        if (!path) return null;

        // Find this character via the search API to get the same hit shape the browse view uses
        const slug = path.split('/')[1] || '';
        try {
            const data = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, api?.apiRequest);
            const hits = data?.hits || [];
            const match = hits.find(h => h.path === path);
            if (match) return match;
        } catch (e) {
            console.warn('[ChartavernProvider] buildPreviewObject search failed:', e.message);
        }

        // Fallback to local data if remote fetch failed
        const ctData = char?.data?.extensions?.chartavern || {};
        return {
            id: ctData.id || linkInfo.id,
            name: char?.name || 'Unknown',
            path: path,
            author: path.split('/')[0] || char?.data?.creator || '',
            tagline: ctData.tagline || '',
            tags: char?.data?.tags || [],
            totalTokens: char?.data?.extensions?.total_tokens || 0,
            createdAt: 0
        };
    }

    openPreview(previewChar) {
        window.openCtCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.chartavern;

        // Card already has CT metadata (previously imported via our app)
        if (ext?.path) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'chartavern',
                    charId: ext.id || null,
                    fullPath: ext.path,
                    hasGallery: false,
                    avatarUrl: ext.path ? getAvatarUrl(ext.path) : null
                }
            };
        }

        // No CT extensions — try to find on CharacterTavern
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            const nameMatches = results.filter(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (nameMatches.length === 0) return null;

            // Prefer match by same creator when multiple cards share the same name
            let match = nameMatches[0];
            if (creator && nameMatches.length > 1) {
                const creatorLower = creator.toLowerCase();
                const creatorMatch = nameMatches.find(r => r.fullPath?.toLowerCase().startsWith(creatorLower + '/'));
                if (creatorMatch) match = creatorMatch;
            }

            // Fetch details for tag/tagline enrichment
            const parts = match.fullPath.split('/');
            let detailData = null;
            if (parts.length >= 2) {
                try {
                    const detail = await fetchCharacterDetail(parts[0], parts[1], api?.apiRequest);
                    detailData = detail?.card || null;
                } catch (_) { /* best-effort */ }
            }

            // Add CT link metadata
            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.chartavern = {
                id: detailData?.id || match.id || null,
                path: match.fullPath,
                linkedAt: new Date().toISOString(),
                tagline: detailData?.tagline || match.tagline || '',
                pageName: this.getListingName(detailData || match),
            };

            // Enrich tags if missing
            if (!cardData.data.tags?.length && detailData?.tags) {
                cardData.data.tags = parseTags(detailData.tags);
            }

            return {
                cardData,
                providerInfo: {
                    providerId: 'chartavern',
                    charId: match.id || null,
                    fullPath: match.fullPath,
                    hasGallery: false,
                    avatarUrl: match.avatarUrl || null
                }
            };
        } catch (e) {
            console.warn('[ChartavernProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        const path = linkInfo?.fullPath;
        if (!path) return null;
        try {
            const parts = path.split('/');
            if (parts.length < 2) return null;

            // Detail API uses different field names than search: analytics_downloads, tokenTotal.
            // It has no likes/favorites field, so fall back to a search query for that.
            const data = await fetchCharacterDetail(parts[0], parts[1], api?.apiRequest);
            const card = data?.card;
            if (!card) return null;

            // Try to get likes from a search hit matched by path
            let likes = null;
            try {
                const slug = parts[1];
                const searchData = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, api?.apiRequest);
                const match = (searchData?.hits || []).find(h => h.path === path);
                if (match) likes = match.likes ?? null;
            } catch (_) { /* search is best-effort */ }

            return {
                stat1: card.analytics_downloads ?? null,
                stat2: likes,
                stat3: card.tokenTotal ?? null
            };
        } catch (e) {
            api?.debugLog?.('[ChartavernProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const parts = fullPath.split('/');
            if (parts.length < 2) return null;
            const data = await fetchCharacterDetail(parts[0], parts[1], api?.apiRequest);
            return data?.card || null;
        } catch (e) {
            console.error('[ChartavernProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        try {
            const parts = linkInfo.fullPath.split('/');
            if (parts.length < 2) return null;

            // Primary: extract full V2 card from CDN PNG (canonical source with alt greetings).
            // The CT detail API doesn't return alternate_greetings, but the PNG embeds the complete card.
            const pngUrl = getCardPngUrl(linkInfo.fullPath);
            try {
                const resp = await fetchWithProxy(pngUrl);
                const buffer = await resp.arrayBuffer();
                const cardData = api?.extractCharacterDataFromPng?.(buffer);
                if (cardData?.data) {
                    // Enrich with detail-API-only fields (tagline, system_prompt, etc.)
                    try {
                        const detail = await fetchCharacterDetail(parts[0], parts[1], api?.apiRequest);
                        if (detail?.card) {
                            if (!cardData.data.system_prompt && detail.card.definition_system_prompt)
                                cardData.data.system_prompt = detail.card.definition_system_prompt;
                            if (!cardData.data.extensions) cardData.data.extensions = {};
                            if (!cardData.data.extensions.chartavern) cardData.data.extensions.chartavern = {};
                            cardData.data.extensions.chartavern.tagline = detail.card.tagline || '';
                        }
                    } catch (_) { /* detail enrichment is best-effort */ }
                    cardData._listingName = this.getListingName(detail?.card);
                    return cardData;
                }
            } catch (e) {
                console.warn('[ChartavernProvider] PNG extraction failed, falling back to detail API:', e.message);
            }

            // Fallback: detail API only (alternate_greetings will be empty)
            const data = await fetchCharacterDetail(parts[0], parts[1], api?.apiRequest);
            if (!data?.card) return null;
            const result = buildV2FromDetail(data.card, parts[0]);
            if (result) result._listingName = this.getListingName(data.card);
            return result;
        } catch (e) {
            console.error('[ChartavernProvider] fetchRemoteCard failed:', linkInfo.fullPath, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return buildV2FromDetail(rawData, '');
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.chartavern.tagline',
                label: 'CT Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Version History ─────────────────────────────────────

    // CharacterTavern has no public version/commit history API
    get supportsVersionHistory() { return false; }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() {
        return isCtSessionActive();
    }

    openAuthUI() {
        window.openCtLoginModal?.();
    }

    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?character-tavern\.com$/i.test(u.hostname);
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
                key: 'ctCookie',
                label: 'Session Cookies',
                type: 'textarea',
                defaultValue: null,
                hint: 'Paste your CharacterTavern cookie string from browser DevTools (requires cl-helper plugin)',
                section: 'Authentication'
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
            // CT search indexes card names/descriptions, not creator usernames
            const data = await searchCards({ query: name, sort: 'most_popular', page: 1, limit: 15 }, api?.apiRequest);
            return (data?.hits || []).map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[ChartavernProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from CharacterTavern.
     * CT serves PNG cards with embedded V2 data, so the primary approach is:
     * 1. Download the full PNG from the CDN (already has card data embedded)
     * 2. Upload to ST's import endpoint
     * 3. Patch in our link metadata afterward
     *
     * @param {string} path - "author/slug" format
     * @param {Object} [hitData] - Optional pre-fetched search hit data
     */
    async importCharacter(path, hitData, options = {}) {
        try {
            const parts = String(path).split('/');
            if (parts.length < 2) throw new Error('Invalid character path');
            const author = parts[0];
            const slug = parts[1];

            // Fetch full details for richer V2 card
            let cardData = null;
            try {
                const detail = await fetchCharacterDetail(author, slug, api?.apiRequest);
                if (detail?.card) cardData = detail.card;
            } catch (e) {
                console.warn('[ChartavernProvider] Detail fetch failed, falling back to hit data:', e.message);
            }

            const characterName = cardData?.name || hitData?.name || slug;

            // Build the V2 card from the best available data
            const altGreetings = Array.isArray(hitData?.alternativeFirstMessage) ? hitData.alternativeFirstMessage : [];
            let characterCard;
            if (cardData) {
                characterCard = buildV2FromDetail(cardData, author, altGreetings);
                // Backfill tags from hitData or search if detail API returned none
                if (!characterCard.data.tags?.length) {
                    if (hitData?.tags) {
                        characterCard.data.tags = parseTags(hitData.tags);
                    } else {
                        try {
                            const searchData = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, api?.apiRequest);
                            const match = (searchData?.hits || []).find(h => h.path === path);
                            if (match?.tags) characterCard.data.tags = parseTags(match.tags);
                        } catch (_) { /* search fallback is best-effort */ }
                    }
                }
            } else if (hitData) {
                characterCard = buildV2FromSearchHit(hitData);
            } else {
                throw new Error('Could not fetch character data from CharacterTavern');
            }

            // Ensure link metadata
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.chartavern = {
                ...(characterCard.data.extensions.chartavern || {}),
                id: cardData?.id || hitData?.id || null,
                path: path,
                linkedAt: new Date().toISOString(),
                tagline: cardData?.tagline || hitData?.tagline || '',
                pageName: this.getListingName(cardData || hitData)
            };

            assignGalleryId(characterCard, options, api);

            // Download the PNG card from CDN (already has card data embedded)
            const pngUrl = getCardPngUrl(path);
            let imageBuffer = null;
            try {
                const resp = await fetchWithProxy(pngUrl);
                imageBuffer = await resp.arrayBuffer();
            } catch (e) {
                console.warn('[ChartavernProvider] PNG download failed:', e.message);
            }

            // Extract fields from PNG card data that the detail API omits
            // (alt greetings, tags, character_book/lorebook)
            if (imageBuffer) {
                try {
                    const pngCard = api.extractCharacterDataFromPng?.(imageBuffer);
                    if (pngCard?.data) {
                        if (!characterCard.data.alternate_greetings?.length && pngCard.data.alternate_greetings?.length) {
                            characterCard.data.alternate_greetings = pngCard.data.alternate_greetings;
                        }
                        if (!characterCard.data.tags?.length && pngCard.data.tags?.length) {
                            characterCard.data.tags = pngCard.data.tags;
                        }
                        if (pngCard.data.character_book && !characterCard.data.character_book) {
                            characterCard.data.character_book = pngCard.data.character_book;
                        }
                    }
                } catch (_) { /* PNG extraction is best-effort */ }
            }

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `ct_${slugify(characterName)}.png`,
                characterName, hasGallery: false,
                providerCharId: cardData?.id || hitData?.id || null,
                fullPath: path,
                avatarUrl: getAvatarUrl(path),
                api
            });
        } catch (error) {
            console.error(`[ChartavernProvider] importCharacter failed for ${path}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Gallery ─────────────────────────────────────────────

    // CT doesn't have a gallery API
    get supportsGallery() { return false; }

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
                    return { id: r.id, fullPath: r.fullPath, hasGallery: false };
                }
            }
            return { id: results[0].id, fullPath: results[0].fullPath, hasGallery: false };
        } catch (e) {
            console.error('[ChartavernProvider] searchForImportMatch:', e);
            return null;
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _normalizeSearchResult(hit) {
        return {
            id: hit.id || null,
            fullPath: hit.path || '',
            name: hit.name || 'Unnamed',
            avatarUrl: hit.path ? getAvatarUrl(hit.path) : '',
            rating: 0,
            starCount: hit.likes || 0,
            description: stripHtml(hit.pageDescription || hit.tagline || ''),
            tagline: hit.tagline || '',
            nTokens: hit.totalTokens || 0,
        };
    }
}

const chartavernProvider = new ChartavernProvider();

window.ctValidateSession = async (cookieString) => {
    if (cookieString) {
        const setResp = await ctSetCookie(CoreAPI.apiRequest, cookieString);
        if (!setResp.ok) {
            return { valid: false, reason: setResp.error || 'Failed to set cookie' };
        }
    }
    return ctValidateSession(CoreAPI.apiRequest);
};

export default chartavernProvider;
