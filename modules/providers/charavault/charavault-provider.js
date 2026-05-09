// CharaVault Provider - character source backed by charavault.net

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, slugify } from '../provider-utils.js';
import charavaultBrowseView, { markCvCardImported } from './charavault-browse.js';
import {
    initCvApi,
    getCvHeaders,
    cvThumbUrl,
    cvDownloadUrl,
    cvFullPath,
    splitCvPath,
    fetchCvCards,
    fetchCvCardDetail,
    buildCvCharacterCard,
    cvMetadataCache,
} from './charavault-api.js';

let api = null;

// Cached raw API node from fetchLinkStats - reused by getCachedLinkNode
let _cachedLinkNode = null;

class CharaVaultProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'charavault'; }
    get name() { return 'CharaVault'; }
    get icon() { return 'fa-solid fa-vault'; }
    get browseView() { return charavaultBrowseView; }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initCvApi({ getSetting: coreAPI.getSetting, debugLog: coreAPI.debugLog });
        // Expose import function for the browse modal download button
        window.cvImportCharacter = (fullPath, hitData, options) =>
            this.importCharacter(fullPath, hitData, options);
    }

    async activate(container, options = {}) {
        charavaultBrowseView.activate(container, options);
    }

    deactivate() {
        charavaultBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return charavaultBrowseView.renderFilterBar(); }
    renderView() { return charavaultBrowseView.renderView(); }
    renderModals() { return charavaultBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const ext = char.data?.extensions?.charavault;
        if (!ext?.full_path) return null;
        return {
            providerId: 'charavault',
            id: ext.full_path,
            fullPath: ext.full_path,
            linkedAt: ext.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        if (linkInfo) {
            const existing = char.data.extensions.charavault || {};
            char.data.extensions.charavault = {
                ...existing,
                full_path: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
            };
        } else {
            delete char.data.extensions.charavault;
        }
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        const { folder, file } = splitCvPath(linkInfo.fullPath);
        return `https://charavault.net/cards/preview/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        const detail = await fetchCvCardDetail(fullPath);
        return detail?.entry || null;
    }

    async fetchRemoteCard(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(fullPath);
            if (!detail) return null;
            const card = buildCvCharacterCard(detail, fullPath, null);
            return card;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchRemoteCard:', e.message);
            return null;
        }
    }

    async fetchLinkStats(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(fullPath);
            const entry = detail?.entry;
            if (!entry) return null;
            _cachedLinkNode = entry;
            return {
                stat1: entry.avg_rating ? parseFloat(entry.avg_rating.toFixed(1)) : 0,
                stat2: entry.rating_count || 0,
                stat3: entry.token_count || 0,
            };
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-star', label: 'Avg Rating' },
            stat2: { icon: 'fa-solid fa-users', label: 'Ratings' },
            stat3: { icon: 'fa-solid fa-message', label: 'Tokens' },
        };
    }

    getCachedLinkNode() { return _cachedLinkNode; }
    clearCachedLinkNode() { _cachedLinkNode = null; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?charavault\.net$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Paths: /cards/preview/{folder}/{file} or /cards/{folder}/{file}
            const match = u.pathname.match(/\/cards(?:\/(?:preview|thumb|download))?\/([^/]+)\/(.+)/);
            if (match) return cvFullPath(match[1], match[2]);
        } catch { /* ignore */ }
        return null;
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [
            {
                key: 'charavaultGatewayUrl',
                label: 'Gateway URL (optional)',
                type: 'text',
                defaultValue: '',
                hint: 'Leave empty to talk to charavault.net directly. Only set this if you proxy CharaVault through your own gateway.',
                section: 'CharaVault',
            },
            {
                key: 'charavaultGatewayKey',
                label: 'Gateway API Key (optional)',
                type: 'password',
                defaultValue: '',
                hint: 'Bearer token sent to your gateway. Ignored when Gateway URL is empty.',
                section: 'CharaVault',
            },
            {
                key: 'charavaultAppPassword',
                label: 'App Password',
                type: 'password',
                defaultValue: null,
                hint: 'CharaVault app password (cv_...). Optional - required only for higher rate limits and downloads.',
                section: 'CharaVault',
            },
        ];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, creator) {
        try {
            const results = [];

            // Search by creator first if available (most precise)
            if (creator && creator.trim()) {
                const creatorData = await fetchCvCards({
                    creator: creator.trim(),
                    q: name,
                    limit: 20,
                    sort: 'most_downloaded',
                });
                for (const r of (creatorData.results || [])) {
                    r.fullPath = cvFullPath(r.folder, r.file);
                    results.push(this._normalizeSearchResult(r));
                }
                if (results.length > 0) return results;
            }

            // Name-only fallback
            const data = await fetchCvCards({ q: name, limit: 15, sort: 'most_downloaded' });
            for (const r of (data.results || [])) {
                r.fullPath = cvFullPath(r.folder, r.file);
                if (!results.some(x => x.fullPath === r.fullPath)) {
                    results.push(this._normalizeSearchResult(r));
                }
            }
            return results;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] searchForBulkLink:', e.message);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        const fp = result.fullPath || '';
        const slash = fp.indexOf('/');
        if (slash < 0) return '';
        const folder = fp.slice(0, slash);
        const file = fp.slice(slash + 1);
        return cvThumbUrl(folder, file);
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from CharaVault by fullPath.
     * Downloads the PNG card directly; the PNG already has the character
     * data embedded, so we extract it, rebuild with our extension metadata,
     * then re-embed and upload to SillyTavern.
     */
    async importCharacter(fullPath, hitData, options = {}) {
        try {
            const detail = await fetchCvCardDetail(fullPath);
            if (!detail) throw new Error('Could not fetch character metadata');

            // hitData is the search-list row passed from the browse modal -
            // it carries `has_lorebook` which is missing from the detail entry.
            const characterCard = buildCvCharacterCard(detail, fullPath, hitData);
            const characterName = characterCard.data.name || fullPath.split('/').pop().replace(/\.png$/i, '');

            assignGalleryId(characterCard, options, api);

            const { folder, file } = splitCvPath(fullPath);
            const pngUrl = cvDownloadUrl(folder, file);
            let imageBuffer = null;
            try {
                const resp = await fetch(pngUrl, { headers: getCvHeaders() });
                if (resp.ok) {
                    imageBuffer = await resp.arrayBuffer();
                }
            } catch (e) {
                api?.debugLog?.('[CharaVaultProvider] PNG download:', e.message);
            }

            // Fall back to thumbnail if PNG download failed
            if (!imageBuffer) {
                try {
                    const thumbUrl = cvThumbUrl(folder, file);
                    const resp = await fetch(thumbUrl, { headers: getCvHeaders() });
                    if (resp.ok) imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    api?.debugLog?.('[CharaVaultProvider] thumb fallback:', e.message);
                }
            }

            cvMetadataCache.delete(fullPath);

            const result = await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `cv_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: fullPath,
                fullPath,
                avatarUrl: cvThumbUrl(folder, file),
                api,
            });

            if (result.success) {
                markCvCardImported(fullPath);
            }
            return result;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] importCharacter:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator) {
        if (!name) return null;
        try {
            const results = await this.searchForBulkLink(name, creator || '');
            if (results.length === 0) return null;
            const norm = name.toLowerCase().trim();
            for (const r of results) {
                if ((r.name || '').toLowerCase().trim() === norm) {
                    return { id: r.fullPath, fullPath: r.fullPath, hasGallery: false };
                }
            }
            return { id: results[0].fullPath, fullPath: results[0].fullPath, hasGallery: false };
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] searchForImportMatch:', e.message);
            return null;
        }
    }

    // ── Private ─────────────────────────────────────────────

    _normalizeSearchResult(r) {
        return {
            id: r.fullPath,
            fullPath: r.fullPath,
            name: r.name || r.file || '',
            avatarUrl: cvThumbUrl(r.folder || r.fullPath.split('/')[0], r.file || r.fullPath.split('/').pop()),
            rating: r.avg_rating || 0,
            starCount: r.rating_count || 0,
            description: r.description_preview || '',
            tagline: (r.tags || []).slice(0, 4).join(', '),
            nTokens: r.token_count || 0,
        };
    }
}

const charavaultProvider = new CharaVaultProvider();
export default charavaultProvider;
