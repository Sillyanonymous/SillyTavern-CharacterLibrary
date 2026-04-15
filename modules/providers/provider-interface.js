// Provider Interface — contract for external character sources

import { saveGalleryImage } from './provider-utils.js';

/**
 * @typedef {Object} ProviderLinkInfo
 * @property {string} providerId   — which provider owns this link (e.g. 'chub')
 * @property {string|number} id    — provider-internal numeric/string ID
 * @property {string} fullPath     — canonical path on the provider (e.g. 'creator/slug')
 * @property {string} [linkedAt]   — ISO timestamp of when the link was created
 */

/**
 * @typedef {Object} ProviderSettingDescriptor
 * @property {string} key          — setting key stored in library settings
 * @property {string} label        — human-readable label
 * @property {'text'|'password'|'checkbox'|'number'} type
 * @property {*} defaultValue      — value when unset
 * @property {string} [hint]       — helper text shown below the control
 * @property {string} [section]    — grouping label inside the settings panel
 */

/**
 * @typedef {Object} ProviderUpdateResult
 * @property {string} avatar       — character avatar filename
 * @property {boolean} hasUpdate   — whether an update is available
 * @property {Object} [remoteCard] — full remote card data if fetched
 * @property {string} [error]      — error message if check failed
 */

/**
 * @typedef {Object} ProviderVersionEntry
 * @property {string} ref          — version identifier (commit hash, revision ID, etc.)
 * @property {string} date         — ISO timestamp
 * @property {string} [message]    — commit message or version label
 * @property {string} [author]     — author name if available
 */

/**
 * @typedef {Object} ProviderComparableField
 * @property {string} path         — dot-notation field path (e.g. 'extensions.chub.tagline')
 * @property {string} label        — human-readable column label
 * @property {string} [icon]       — Font Awesome icon class
 * @property {boolean} [optional]  — if true, excluded from diff by default
 */

/**
 * Base class for external character source providers.
 *
 * Subclasses MUST implement methods marked @abstract.
 * Optional methods have sensible defaults and can be overridden.
 */
export class ProviderBase {
    // ── Identity ────────────────────────────────────────────

    /** Unique machine key (e.g. 'chub'). @abstract @returns {string} */
    get id() { throw new Error('Provider must implement get id()'); }

    /** Human display name (e.g. 'ChubAI'). @abstract @returns {string} */
    get name() { throw new Error('Provider must implement get name()'); }

    /** Font Awesome icon class for the tab/pill. @returns {string} */
    get icon() { return 'fa-solid fa-globe'; }

    /** URL to a provider logo/favicon for richer display. @returns {string|null} */
    get iconUrl() { return null; }

    /** Whether this provider is in beta. Shows a badge in UI. @returns {boolean} */
    get beta() { return false; }

    /** Whether this provider should be disabled on first run. @returns {boolean} */
    get disabledByDefault() { return false; }

    /** Warning message shown when enabling this provider. Null = no warning. @returns {string|null} */
    get enableWarning() { return null; }

    /** Reference to this provider's BrowseView subclass instance, if any. @returns {import('./browse-view.js').BrowseView|null} */
    get browseView() { return null; }

    // ── Lifecycle ───────────────────────────────────────────

    /**
     * Called once when the provider is registered. Receives the full CoreAPI
     * object so the provider can call back into the library.
     * @param {Object} coreAPI
     */
    async init(coreAPI) {
        this._coreAPI = coreAPI;
    }

    /**
     * Called when the Online tab switches TO this provider.
     * The provider should render/refresh its UI inside `container`.
     * @param {HTMLElement} container — the provider's content div
     * @param {Object} [options]
     * @param {boolean} [options.domRecreated] — true when the registry has
     *   destroyed and rebuilt the view HTML (provider switch). Signals that
     *   event listeners must be re-attached.
     */
    async activate(container, options = {}) { /* optional */ }

    /**
     * Called when the Online tab switches AWAY from this provider.
     * Clean up observers, abort in-flight fetches, etc.
     */
    deactivate() { /* optional */ }

    /**
     * Full teardown (tab closed, page unload). Release everything.
     */
    destroy() { /* optional */ }

    // ── View ────────────────────────────────────────────────

    /**
     * Whether this provider has a browsable view in the Online tab.
     * @returns {boolean}
     */
    get hasView() { return true; }

    /**
     * Return the HTML string for the filter bar that sits in the topbar
     * filters-wrapper area when this provider is active. Called once; the
     * provider is responsible for attaching event listeners in activate().
     * @returns {string} HTML string
     */
    renderFilterBar() { return ''; }

    /**
     * Return the HTML string for the main view area. Called once; updated
     * incrementally by the provider in activate().
     * @returns {string} HTML string
     */
    renderView() { return ''; }

    // ── Character Linking ───────────────────────────────────

    /**
     * Inspect a character's extension metadata and return link info if this
     * provider recognises the card. This is how the library decides which
     * provider "owns" a character for updates, version history, etc.
     *
     * @param {Object} char — character object (has .data.extensions)
     * @returns {ProviderLinkInfo|null}
     */
    getLinkInfo(char) { return null; }

    /**
     * Write provider link metadata onto a character object. The caller is
     * responsible for persisting the change to the server afterward.
     *
     * @param {Object} char — character object
     * @param {ProviderLinkInfo|null} linkInfo — null to unlink
     */
    setLinkInfo(char, linkInfo) { /* optional, some providers are read-only */ }

    /**
     * Extract the listing/page name from provider hit or metadata.
     * This is the name shown on the provider's website, which may differ
     * from the card's internal data.name.
     * @param {Object} hitData — provider metadata or search hit object
     * @returns {string|null}
     */
    getListingName(hitData) { return hitData?.name || null; }

    /**
     * Return all characters in the local library that are linked to this provider.
     * Default implementation filters allCharacters through getLinkInfo().
     * @param {Array} allCharacters
     * @returns {Array}
     */
    getLinkedCharacters(allCharacters) {
        return allCharacters.filter(c => this.getLinkInfo(c) !== null);
    }

    /**
     * Return the full URL for viewing a character on this provider's website.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {string|null}
     */
    getCharacterUrl(linkInfo) { return null; }

    /**
     * Whether this provider supports viewing a character in-app via its browse view.
     * When true, the "View on Provider" button opens the provider's preview modal
     * instead of navigating to an external URL.
     * @returns {boolean}
     */
    get supportsInAppPreview() { return false; }

    /**
     * Build a preview character object from a local character's metadata.
     * Called by viewOnLinkedProvider() when supportsInAppPreview is true.
     * @param {Object} char — local character object
     * @param {ProviderLinkInfo} linkInfo — link info for this character
     * @returns {Promise<Object|null>} provider-specific char object for openPreview()
     */
    async buildPreviewObject(char, linkInfo) { return null; }

    /**
     * Open the provider's browse preview modal for a character.
     * @param {Object} previewChar — object returned by buildPreviewObject()
     */
    openPreview(previewChar) { /* optional */ }

    /**
     * Open the link/unlink UI for a single character. Context menus and
     * detail panels call this to let the user manage a character's link
     * to this provider.
     * @param {Object} char — character object
     */
    openLinkUI(char) { /* optional */ }

    // ── Remote Data ─────────────────────────────────────────

    /**
     * Refresh/re-extract remote data before an update check.
     * Providers that cache or aggregate stale data (e.g. DataCat) can
     * override this to trigger a re-extraction so fetchRemoteCard()
     * returns fresh data.
     * @param {ProviderLinkInfo} linkInfo
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] — abort signal to cancel long-running operations
     * @param {function(string):void} [options.onStatus] — progress callback for UI updates
     * @returns {Promise<void>}
     */
    async refreshRemoteData(linkInfo, options = {}) { return; }

    /**
     * Fetch full remote metadata for a linked character.
     * @param {string} fullPath — provider-specific canonical path
     * @returns {Promise<Object|null>} provider-specific metadata blob
     */
    async fetchMetadata(fullPath) { return null; }

    /**
     * Fetch the remote V2 card JSON for a character (for update comparison).
     * The returned object should already be normalized to V2 spec — providers
     * are responsible for mapping their own field names.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>} V2-spec card data or null
     */
    async fetchRemoteCard(linkInfo) { return null; }

    /**
     * Normalize raw remote data into V2 card spec. Called internally by
     * fetchRemoteCard() implementations. Override to map provider-specific
     * field names (e.g. Chub's 'personality' → V2 'description').
     * @param {Object} rawData — raw API response
     * @returns {Object} V2-spec card data
     */
    normalizeRemoteCard(rawData) { return rawData; }

    /**
     * Fetch the associated lorebook/world for a character (if any).
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>} V2 character_book object or null
     */
    async fetchLorebook(linkInfo) { return null; }

    /**
     * Fetch live stats for the link modal.
     * Only providers with public stats APIs need to override this.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<{stat1: number|null, stat2: number|null, stat3: number|null}|null>}
     */
    async fetchLinkStats(linkInfo) { return null; }

    /**
     * Define the label and icon for each link stat slot.
     * Override to customize stat display in the link modal.
     * @returns {{stat1: {icon: string, label: string}, stat2: {icon: string, label: string}, stat3: {icon: string, label: string}}}
     */
    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Favorites' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    /**
     * Return a provider-specific cached data node from the last fetchLinkStats()
     * call. Used by the "View on" action to avoid a redundant fetch.
     * @returns {Object|null}
     */
    getCachedLinkNode() { return null; }

    /** Clear the cached link node after consumption. */
    clearCachedLinkNode() { /* no-op */ }

    // ── Update Checking ─────────────────────────────────────

    /**
     * Check one character for available updates.
     * @param {Object} char — local character object
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<ProviderUpdateResult>}
     */
    async checkForUpdate(char, linkInfo) {
        return { avatar: char.avatar, hasUpdate: false };
    }

    /**
     * Batch-check multiple characters. Default calls checkForUpdate() in
     * parallel with concurrency control. Override for provider-native batch APIs.
     * @param {Array<{char: Object, linkInfo: ProviderLinkInfo}>} items
     * @param {function} [onProgress] — called with (completed, total)
     * @returns {Promise<ProviderUpdateResult[]>}
     */
    async checkForUpdates(items, onProgress) {
        const results = [];
        const CONCURRENCY = 3;
        let idx = 0;

        const next = async () => {
            while (idx < items.length) {
                const i = idx++;
                const { char, linkInfo } = items[i];
                try {
                    results[i] = await this.checkForUpdate(char, linkInfo);
                } catch (err) {
                    results[i] = { avatar: char.avatar, hasUpdate: false, error: err.message };
                }
                onProgress?.(results.filter(Boolean).length, items.length);
            }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, next));
        return results;
    }

    /**
     * Return provider-specific fields that the update diff engine should
     * compare. These supplement the built-in V2 fields in card-updates.js.
     * @returns {ProviderComparableField[]}
     */
    getComparableFields() { return []; }

    // ── Version History ─────────────────────────────────────

    /**
     * Whether this provider supports remote version/commit history.
     * @returns {boolean}
     */
    get supportsVersionHistory() { return false; }

    /**
     * Fetch the list of remote versions (commits, revisions) for a character.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<ProviderVersionEntry[]>}
     */
    async fetchVersionList(linkInfo) { return []; }

    /**
     * Fetch the V2 card JSON for a specific historical version.
     * @param {ProviderLinkInfo} linkInfo
     * @param {string} ref — version identifier from fetchVersionList()
     * @returns {Promise<Object|null>} V2-spec card data or null
     */
    async fetchVersionData(linkInfo, ref) { return null; }

    /**
     * Human-readable label for the provider's "current remote state" entry
     * shown at the top of the version list (e.g. "Chub Page", "Janitor Live").
     * @returns {string}
     */
    get remoteVersionLabel() { return `${this.name} Current`; }

    /**
     * Whether this provider supports a "current remote page" pseudo-version
     * that shows the live state from the provider's API (which may differ
     * from the latest committed version).
     * @returns {boolean}
     */
    get supportsRemotePageVersion() { return false; }

    /**
     * Return metadata about the remote page entry for the version list.
     * @returns {{ date: string|null, description: string }|null}
     */
    getRemotePageInfo() { return null; }

    /**
     * Build and return the live remote card data for the "page" pseudo-version.
     * Returns flat card fields (not V2-wrapped).
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>}
     */
    async fetchRemotePageCard(linkInfo) { return null; }

    // ── Authentication (optional) ───────────────────────────

    /** Whether this provider supports auth. @returns {boolean} */
    get hasAuth() { return false; }

    /** Whether the user is currently authenticated. @returns {boolean} */
    get isAuthenticated() { return false; }

    /**
     * Open the provider's login/token UI.
     * Providers manage their own modal or inline UX.
     */
    openAuthUI() { /* optional */ }

    /**
     * Return auth headers for API requests. The core never hard-codes
     * bearer tokens — it calls this on the relevant provider.
     * @returns {Object} headers object (e.g. { Authorization: 'Bearer ...' })
     */
    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    /**
     * Test whether a URL belongs to this provider. Used by the import system
     * to route URL-based imports to the correct provider.
     * @param {string} url
     * @returns {boolean}
     */
    canHandleUrl(url) { return false; }

    /**
     * Parse a URL into a provider-specific identifier (e.g. 'creator/slug').
     * @param {string} url
     * @returns {string|null}
     */
    parseUrl(url) { return null; }

    // ── Settings ────────────────────────────────────────────

    /**
     * Return an array of setting descriptors for the settings panel.
     * The core renders these automatically — the provider doesn't build DOM.
     * @returns {ProviderSettingDescriptor[]}
     */
    getSettings() { return []; }

    // ── Bulk Linking ────────────────────────────────────────

    /**
     * Whether this provider supports automatic bulk-linking of local
     * characters to their remote counterparts.
     * @returns {boolean}
     */
    get supportsBulkLink() { return false; }

    /**
     * Open the bulk link UI for this provider.
     */
    openBulkLinkUI() { /* optional */ }
    /**
     * Search the provider for characters matching a local character's name/creator.
     * Used by the bulk auto-link scan to find remote matches.
     *
     * Returned objects must have at minimum:
     *   { id, fullPath, name, avatarUrl, rating, starCount, description, tagline }
     *
     * @param {string} name    — local character name
     * @param {string} creator — local character creator (may be empty)
     * @returns {Promise<Array<Object>>} search results
     */
    async searchForBulkLink(name, creator) { return []; }

    /**
     * Get an avatar URL for a search result returned by searchForBulkLink().
     * Default just returns result.avatarUrl. Override if the provider needs
     * to construct the URL from result fields (e.g. CDN path + fullPath).
     * @param {Object} result — a search result object
     * @returns {string}
     */
    getResultAvatarUrl(result) { return result.avatarUrl || ''; }

    // ── Import Pipeline ─────────────────────────────────────

    /**
     * Whether this provider supports URL-based character import.
     * If true, canHandleUrl() + parseUrl() + importCharacter() must work.
     * @returns {boolean}
     */
    get supportsImport() { return false; }

    /**
     * Import a character from this provider by its identifier.
     * Full pipeline: fetch metadata → build V2 card → download avatar →
     * embed card in PNG → upload to SillyTavern's /api/characters/import.
     *
     * Use the CoreAPI reference (from init()) for PNG/image utilities:
     *   api.convertImageToPng(buffer)
     *   api.embedCharacterDataInPng(pngBuffer, cardData)
     *   api.generateGalleryId()
     *   api.getSetting(key)
     *   api.getCSRFToken()
     *   api.findCharacterMediaUrls(cardData)
     *
     * @param {string} identifier — provider-specific ID from parseUrl()
     * @returns {Promise<ProviderImportResult>}
     */
    async importCharacter(identifier) {
        return { success: false, error: 'Provider does not support import' };
    }

    /**
     * @typedef {Object} ProviderImportResult
     * @property {boolean} success
     * @property {string} [error]          — error message if !success
     * @property {string} [fileName]       — avatar filename on ST server
     * @property {string} [characterName]  — display name
     * @property {boolean} [hasGallery]    — whether gallery images are available
     * @property {string|number} [providerCharId] — provider-side numeric/string ID (for gallery fetch)
     * @property {string} [fullPath]       — canonical path on provider
     * @property {string} [avatarUrl]      — remote avatar URL for display
     * @property {string[]} [embeddedMediaUrls] — media found in card fields
     * @property {string} [galleryId]      — unique gallery folder ID if assigned
     */

    // ── Gallery Download ────────────────────────────────────

    /**
     * Whether this provider has downloadable gallery images.
     * @returns {boolean}
     */
    get supportsGallery() { return false; }

    /**
     * Fetch the list of gallery images available for a character.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Array<{url: string, id?: string, nsfw?: boolean}>>}
     */
    async fetchGalleryImages(linkInfo) { return []; }

    /**
     * Download gallery images to a local folder with dedup and progress.
     * Default implementation calls fetchGalleryImages() then uses
     * CoreAPI download helpers (via the api reference from init()).
     * Providers can override
     * for custom naming conventions or CDN-specific handling.
     *
     * @param {ProviderLinkInfo} linkInfo
     * @param {string} folderName — gallery folder name (already resolved)
     * @param {Object} [options]
     * @param {function} [options.onProgress] — (current, total)
     * @param {function} [options.onLog]      — (message, status) → entry
     * @param {function} [options.onLogUpdate] — (entry, message, status)
     * @param {function} [options.shouldAbort] — () → boolean
     * @param {AbortSignal} [options.abortSignal]
     * @returns {Promise<{success: number, skipped: number, errors: number, aborted: boolean}>}
     */
    async downloadGallery(linkInfo, folderName, options = {}) {
        const api = this._coreAPI;
        if (!api) return { success: 0, skipped: 0, errors: 0, filenameSkipped: 0, aborted: false };

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
                            if (!valid) api.debugLog?.('[Gallery] Fast skip rejected (HEAD validation):', match.fileName);
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
            const saveResult = await saveGalleryImage(dl, image, folderName, contentHash, this.galleryFilePrefix, api);
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

    /**
     * Return the gallery naming prefix for files downloaded from this provider.
     * Used by the generic save helper to tag gallery images by source.
     * @returns {string} e.g. 'chubgallery', 'chartaverngallery'
     */
    get galleryFilePrefix() { return `${this.id}gallery`; }

    // ── Import Duplicate Detection ──────────────────────────

    /**
     * Search the provider for a character that matches a local card being imported.
     * Used during the import pipeline to auto-discover remote matches (e.g., for
     * gallery ID, duplicate detection). More thorough than searchForBulkLink().
     *
     * @param {string} name    — character name
     * @param {string} creator — creator name
     * @param {Object} [localChar] — full local character for content comparison
     * @returns {Promise<{id: string|number, fullPath: string, hasGallery: boolean}|null>}
     */
    async searchForImportMatch(name, creator, localChar) { return null; }

    /**
     * Detect and enrich a locally-imported PNG card.
     * Called during local import with extracted V2 card data. Each provider:
     *   1. Checks if the card has this provider's extension metadata (instant)
     *   2. Optionally searches its API to auto-detect and enrich unlinked cards
     *
     * If the provider claims the card, it returns enriched data with proper field
     * mapping, tags, and link metadata. The caller will re-embed the card into
     * the PNG before uploading to ST.
     *
     * @param {Object} cardData - Extracted V2 card data ({ spec, data })
     * @param {string} fileName - Original filename of the PNG
     * @returns {Promise<{cardData: Object, providerInfo: {providerId: string, charId: string|null, fullPath: string|null, hasGallery: boolean, avatarUrl: string|null}}|null>}
     */
    async enrichLocalImport(cardData, fileName) { return null; }
}

export default ProviderBase;
