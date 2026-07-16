// Core API - proxy layer between modules and the library monolith

import ProviderRegistry from './providers/provider-registry.js';

// ========================================
// HOST WINDOW / EMBEDDED MODE
// ========================================

export function getHostWindow() {
    return window.getHostWindow?.() || null;
}

export function getSTContext() {
    return window.getSTContext?.() || null;
}

export function getIsEmbedded() {
    return window.isEmbedded || false;
}

export function closeEmbeddedPanel() {
    return window.closeEmbeddedPanel?.();
}

export function resolveProxyForProfile(profile) {
    return window.resolveProxyForProfile?.(profile);
}

// Shared LLM client (see library.js "SHARED LLM CLIENT"). Each AI module passes its own
// resolved profile + the per-feature options; the body/proxy/parse logic is centralized.
export function getLlmSettings() {
    return window.getLlmSettings?.() ?? Promise.resolve({ profiles: [], activeSource: '', activeModel: '', activePreset: null, selectedProfileId: '', hasProfiles: false, error: true });
}

export function callLLM(messages, opts) {
    return window.callLLM?.(messages, opts);
}

export function callCustomLLM(messages, opts) {
    return window.callCustomLLM?.(messages, opts);
}

export function extractLlmContent(data, opts) {
    return window.extractLlmContent?.(data, opts);
}

// ========================================
// STATE ACCESS
// ========================================

// ---- View Management (proxies to library.js implementation) ----

/**
 * Switch between top-level views (characters, chats, online).
 * @param {string} view - 'characters' | 'chats' | 'online'
 */
export function switchView(view) {
    window.switchView?.(view);
}

/**
 * Get current active view
 * @returns {string} 'characters' | 'chats' | 'online'
 */
export function getCurrentView() {
    return window.getCurrentView?.() || 'characters';
}

/**
 * Register a callback to run each time a specific view becomes active.
 * Modules use this for lazy-loading (e.g. chats loads on first visit).
 * @param {string} view - View name ('characters', 'chats', 'online')
 * @param {function} callback - Function to call when view is entered
 */
export function onViewEnter(view, callback) {
    window.onViewEnter?.(view, callback);
}

/**
 * @param {string} view - View name ('characters', 'chats', 'online')
 * @param {function} callback - Function to call when view is exited
 */
export function onViewExit(view, callback) {
    window.onViewExit?.(view, callback);
}

/**
 * Get all loaded characters
 * @returns {Array} All character objects
 */
export function getAllCharacters() {
    return window.getAllCharacters?.() || [];
}

/**
 * Get currently filtered/displayed characters
 * @returns {Array} Current character objects
 */
export function getCurrentCharacters() {
    return window.getCurrentCharacters?.() || [];
}

/**
 * Find a character by avatar filename
 * @param {string} avatar - Avatar filename
 * @returns {Object|undefined} Character object or undefined
 */
export function getCharacterByAvatar(avatar) {
    return window.getCharacterByAvatar?.(avatar);
}

/**
 * Get a gallery setting
 * @param {string} key - Setting key
 * @returns {*} Setting value
 */
export function getSetting(key) {
    return window.getSetting?.(key);
}

/**
 * Set a gallery setting
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 */
export function setSetting(key, value) {
    window.setSetting?.(key, value);
}

/**
 * Batch-set multiple settings at once
 * @param {Object} settingsObj - Key/value pairs
 */
export function setSettings(settingsObj) {
    window.setSettings?.(settingsObj);
}

export function getProviderExcludeTags(providerId) {
    return window.getProviderExcludeTags?.(providerId) || [];
}

/**
 * Apply the current custom CSS (reads mode + content from settings, writes to live <style> tag)
 */
export function applyCustomCSS() {
    window.applyCustomCSS?.();
}

/**
 * Maximum byte size of the emitted custom CSS (raw blob or concatenated snippets)
 */
export function getCustomCSSMaxBytes() {
    return window.CUSTOM_CSS_MAX_BYTES || 65536;
}

export function setProviderExcludeTags(providerId, tags) {
    window.setProviderExcludeTags?.(providerId, tags);
}

// ========================================
// UI ACTIONS
// ========================================

/**
 * Open the character detail modal
 * @param {Object} char - Character object
 */
export function openCharacterModal(...args) {
    return window.openModal?.(...args);
}

/**
 * Open character detail modal elevated above other open modals (confirm or cl-modal).
 * @param {Object} char - Character object
 */
export function openCharModalElevated(char, navList) {
    return window.openCharModalElevated?.(char, navList);
}

/**
 * Open the provider link modal for a character
 * Sets the active character and opens the modal
 * @param {Object} char - Character object
 */
export function openProviderLinkModal(char) {
    window.openProviderLinkModal?.(char);
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - 'success' | 'error' | 'warning' | 'info'
 * @param {number} duration - Duration in ms (default 3000)
 */
export function showToast(message, type = 'info', duration = 3000) {
    window.showToast?.(message, type, duration);
}

export function hapticFeedback(pattern) {
    window.hapticFeedback?.(pattern);
}

/**
 * Show a canonical confirmation dialog. Returns Promise<boolean>.
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message] - Plain text message (escaped)
 * @param {string} [opts.messageHtml] - HTML message (overrides `message`)
 * @param {string} [opts.icon] - FontAwesome class string for the title icon
 * @param {string} [opts.iconColor] - CSS color for the title icon
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {boolean} [opts.danger] - Style confirm button as danger (red)
 * @returns {Promise<boolean>}
 */
export function showConfirm(opts) {
    return window.showConfirm?.(opts) ?? Promise.resolve(false);
}

/**
 * Shared "save preset" picker: type a name to create, or pick an existing preset to overwrite (confirmed).
 * @param {string} title - Dialog title
 * @param {Array<{name: string}>} presets - Existing presets (only `name` is read for the list)
 * @returns {Promise<{name: string, overwriteIndex: number} | null>} overwriteIndex -1 = new, null = cancel
 */
export function savePresetPicker(title, presets) {
    return window.savePresetPicker?.(title, presets) ?? Promise.resolve(null);
}

/**
 * Refresh the character list from server
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Array>} Updated characters
 */
export function refreshCharacters(forceRefresh = false) {
    return window.fetchCharacters?.(forceRefresh) || Promise.resolve([]);
}

// ========================================
// GALLERY FUNCTIONS
// ========================================

/**
 * Get the gallery folder name for a character
 * Handles unique gallery folder names if enabled in settings
 * @param {Object} char - Character object
 * @returns {string} Gallery folder name
 */
export function getGalleryFolderName(char) {
    return window.getGalleryFolderName?.(char) ?? '';
}

export function getGalleryThumbUrl(folderName, fileName) {
    return window.getGalleryThumbUrl?.(folderName, fileName) ?? null;
}

/**
 * Capped-concurrency thumbnail loader factory; each surface owns its instance
 * @param {Object} opts - { concurrency, onSettled }
 * @returns {{ enqueue: Function, reset: Function }|undefined}
 */
export function createThumbLoader(...args) {
    return window.createThumbLoader?.(...args);
}

export function isMediaLocalizationEnabled(avatar) {
    return window.isMediaLocalizationEnabled?.(avatar) ?? false;
}

export function buildMediaLocalizationMap(folderName, avatar, forceRefresh = false) {
    return window.buildMediaLocalizationMap?.(folderName, avatar, forceRefresh) ?? Promise.resolve({});
}

export function replaceMediaUrlsInText(text, urlMap) {
    return window.replaceMediaUrlsInText?.(text, urlMap) ?? text;
}

/**
 * Sanitize a folder name for safe use in paths
 * Removes illegal characters for Windows/file systems
 * @param {string} name - Folder name to sanitize
 * @returns {string} Sanitized folder name
 */
export function sanitizeFolderName(name) {
    return window.sanitizeFolderName?.(name) ?? '';
}

/**
 * Get gallery info for a character (folder name, files, count)
 * @param {Object} char - Character object
 * @returns {Promise<{folder: string, files: string[], count: number}>}
 */
export function getCharacterGalleryInfo(char) {
    return window.getCharacterGalleryInfo?.(char) || Promise.resolve({ folder: '', files: [], count: 0 });
}

/**
 * Get the unique gallery ID for a character (if assigned)
 * @param {Object} char - Character object
 * @returns {string|null} The gallery_id or null if not set
 */
export function getCharacterGalleryId(char) {
    return window.getCharacterGalleryId?.(char) ?? null;
}

/**
 * List existing gallery folder names without the IMAGES_LIST mkdir side effect
 * @returns {Promise<Set<string>>} Folder names on disk
 */
export function getExistingImageFolders() {
    return window.getExistingImageFolders?.() || Promise.resolve(new Set());
}

// ========================================
// API REQUESTS
// ========================================

/**
 * Make an API request to SillyTavern server
 * @param {string} endpoint - API endpoint (without /api prefix)
 * @param {string} method - HTTP method
 * @param {Object} data - Request body
 * @param {Object} options - Additional fetch options
 * @returns {Promise<Response>} Fetch response
 */
export function apiRequest(endpoint, method = 'GET', data = null, options = {}) {
    return window.apiRequest?.(endpoint, method, data, options);
}

/**
 * Get CSRF token for API requests
 * @returns {string} CSRF token
 */
export function getCSRFToken() {
    return window.getCSRFToken?.() || '';
}

// ========================================
// MULTI-SELECT SYSTEM
// ========================================

/**
 * Check if multi-select mode is enabled
 * @returns {boolean}
 */
export function isMultiSelectEnabled() {
    return window.isMultiSelectEnabled?.() ?? false;
}

/**
 * Enable multi-select mode
 */
export function enableMultiSelect() {
    window.MultiSelect?.enable();
}

/**
 * Get all selected characters
 * @returns {Array} Selected character objects
 */
export function getSelectedCharacters() {
    return window.MultiSelect?.getSelected() || [];
}

/**
 * Get count of selected characters
 * @returns {number}
 */
export function getSelectionCount() {
    return window.MultiSelect?.getCount() || 0;
}

/**
 * Check if a character is selected
 * @param {string} avatar - Character avatar
 * @returns {boolean}
 */
export function isCharacterSelected(avatar) {
    return window.MultiSelect?.isSelected(avatar) || false;
}

/**
 * Toggle selection of a character
 * @param {Object} char - Character object
 * @param {HTMLElement} cardElement - Card DOM element
 */
export function toggleCharacterSelection(char, cardElement) {
    window.MultiSelect?.toggle(char, cardElement);
}

/**
 * Clear all selections
 */
export function clearSelection() {
    window.MultiSelect?.clearSelection();
}

// ========================================
// MODULE SYSTEM
// ========================================

/**
 * Get a loaded module by name
 * @param {string} name - Module name
 * @returns {Object|null} Module instance or null
 */
export function getModule(name) {
    return window.ModuleLoader?.get(name) || null;
}

// ========================================
// UTILITIES
// ========================================

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
    return window.escapeHtml?.(text) ?? '';
}

/**
 * Encode a UTF-8 string to base64 for Files-API JSON uploads.
 * @param {string} str
 * @returns {string} base64
 */
export function utf8ToBase64(str) {
    return window.utf8ToBase64?.(str) ?? '';
}

/**
 * Sanitize HTML safely. Falls back to escapeHtml if DOMPurify is unavailable
 * and forces rel="noopener noreferrer" on links with target attributes.
 * @param {string} html - HTML to sanitize
 * @param {object} [config] - DOMPurify config
 * @returns {string} Sanitized HTML
 */
export function safePurify(html, config) {
    return window.safePurify?.(html, config) ?? '';
}

/**
 * Sanitize a tagline HTML string (strips dangerous elements, keeps safe formatting)
 * @param {string} html - Raw tagline HTML from external data
 * @returns {string} Sanitized HTML
 */
export function sanitizeTaglineHtml(...args) {
    return window.sanitizeTaglineHtml?.(...args) || '';
}

/**
 * @returns {boolean} Whether extensions recovery is in progress
 */
export function isExtensionsRecoveryInProgress() {
    return window.isExtensionsRecoveryInProgress?.() ?? false;
}

/**
 * Create a debounced version of a function
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in ms
 * @returns {Function} Debounced function
 */
export function debounce(fn, delay) {
    return window.debounce?.(fn, delay) ?? fn;
}

/**
 * Truncate a string to a maximum length, appending '...' if truncated
 * @param {string} str - String to truncate
 * @param {number} max - Maximum length
 * @returns {string} Truncated string
 */
export function truncate(str, max) {
    return window.truncate?.(str, max) ?? '';
}

/**
 * Live mobile-mode check (html.cl-mobile). Evaluate at event time; the mode can flip mid-session.
 * @returns {boolean} Whether mobile mode is active
 */
export function isMobileMode() {
    return window.isMobileMode?.() ?? false;
}

/**
 * Get tags for a character (normalized)
 * @param {Object} char - Character object
 * @returns {Array<string>} Tags array
 */
export function getCharacterTags(char) {
    return window.getTags?.(char) || [];
}

/**
 * Get all unique tags across all characters
 * @returns {Array<string>} Sorted array of all unique tags
 */
export function getAllTags() {
    return window.getAllAvailableTags?.() || [];
}

// ========================================
// DOM HELPERS
// ========================================

/**
 * Find a character card element by avatar
 * @param {string} avatar - Character avatar
 * @returns {HTMLElement|null}
 */
export function findCardElement(avatar) {
    return window.findCardElement?.(avatar) ?? null;
}

/**
 * Show an element by removing 'hidden' class
 * @param {string} id - Element ID
 */
export function showElement(id) {
    window.showElement?.(id);
}

/**
 * Hide an element by adding 'hidden' class
 * @param {string} id - Element ID
 */
export function hideElement(id) {
    window.hideElement?.(id);
}

/**
 * Hide a modal (adds 'hidden' class, cleans up overlay)
 * @param {string} modalId - Modal element ID
 */
export function hideModal(modalId) {
    window.hideModal?.(modalId);
}

/**
 * Bind an event listener to an element by ID
 * @param {string} id - Element ID
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {boolean} Whether the element was found
 */
export function onElement(id, event, handler) {
    return window.onElement?.(id, event, handler) ?? false;
}

/**
 * Convert a native <select> into the styled custom dropdown.
 * @param {HTMLSelectElement} selectEl - The <select> element to transform
 */
export function initCustomSelect(selectEl) {
    window.initCustomSelect?.(selectEl);
}

// ========================================
// RENDERING HELPERS
// ========================================

/**
 * Render a loading spinner inside a container
 * @param {HTMLElement} container - Container element
 * @param {string} message - Loading message
 * @param {string} className - CSS class name
 */
export function renderLoadingState(container, message, className = 'loading-spinner') {
    window.renderLoadingState?.(container, message, className);
}

export function renderSkeletonGrid(...args) {
    window.renderSkeletonGrid?.(...args);
}

export function renderEmptyState(container, opts) {
    window.renderEmptyState?.(container, opts);
}

export function getCharacterAvatarStThumbUrl(avatar) {
    return window.getCharacterAvatarStThumbUrl?.(avatar) ?? '';
}

/**
 * @param {Object} char
 * @returns {string|null}
 */
export function getListingNameFromExtensions(char) {
    return window.getListingNameFromExtensions?.(char) ?? null;
}

export function bumpAvatarCacheBust(...args) {
    return window.bumpAvatarCacheBust?.(...args);
}

export function getDisplayTagline(...args) {
    return window.getDisplayTagline?.(...args) ?? '';
}

export function getCharacterName(...args) {
    return window.getCharacterName?.(...args) ?? args[0]?.name ?? '';
}

/**
 * Format rich text (markdown-like formatting for chat messages)
 * @param {string} text - Raw text
 * @param {string} charName - Character name for substitution
 * @param {boolean} preserveHtml - Whether to preserve existing HTML
 * @returns {string} Formatted HTML
 */
export function formatRichText(text, charName = '', preserveHtml = false) {
    return window.formatRichText?.(text, charName, preserveHtml) ?? '';
}

// ========================================
// CHARACTER ACTIONS
// ========================================

/**
 * Load a character in the main SillyTavern window
 * @param {Object|string} charOrAvatar - Character object or avatar filename
 * @param {boolean} newChat - Whether to start a new chat
 * @returns {Promise<boolean>} Success status
 */
export function loadCharInMain(charOrAvatar, newChat = false) {
    return window.loadCharInMain?.(charOrAvatar, newChat) || Promise.resolve(false);
}

/**
 * Delete a character from the local library
 * @param {Object|string} charOrAvatar - Character object or avatar filename
 * @param {boolean} [deleteChats=false] - Also delete associated chats
 * @returns {Promise<boolean>} Success
 */
export function deleteCharacter(charOrAvatar, deleteChats) {
    return window.deleteCharacter?.(charOrAvatar, deleteChats) || Promise.resolve(false);
}

/**
 * Open the single-character delete confirmation dialog (gallery + chat-delete options, ST sync).
 * @param {Object} char
 */
export function showDeleteConfirmation(char) {
    return window.showDeleteConfirmation?.(char);
}

/**
 * Fetch character list from the server
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Array>} Character array
 */
export function fetchCharacters(forceRefresh = false) {
    return window.fetchCharacters?.(forceRefresh) || Promise.resolve([]);
}

/**
 * @param {...*} args - avatarFileName, options
 * @returns {Promise<Object|null>}
 */
export function fetchAndAddCharacter(...args) {
    return window.fetchAndAddCharacter?.(...args) ?? Promise.resolve(null);
}

/**
 * @param {string} avatar
 */
export function notifySTCharacterAdded(avatar) {
    return window.notifySTCharacterAdded?.(avatar);
}

/**
 * Fetch heavy fields for a slim character object (no-op if already hydrated).
 * @param {Object} char - Character object (may be slim)
 * @returns {Promise<Object>} The same char with heavy fields populated
 */
export function hydrateCharacter(char) {
    return window.hydrateCharacter?.(char) || Promise.resolve(char);
}

/**
 * Run the current search/filter/sort pipeline and re-render the grid
 */
export function performSearch() {
    window.performSearch?.();
}

/**
 * Which grid filters are active: { fav, tag, playlist } booleans
 */
export function getActiveFilterState(...args) {
    return window.getActiveFilterState?.(...args) ?? { fav: false, tag: false, playlist: false };
}

/**
 * Toggle a character's favorite status (write + ST sync + grid badge + toasts)
 * @param {Object} char - Character object
 */
export function toggleCharacterFavorite(...args) {
    return window.toggleCharacterFavorite?.(...args);
}

/**
 * Set the favorite star badge on a character's grid card
 * @param {string} avatar - Character avatar filename
 * @param {boolean} isFavorite - Whether the character is a favorite
 */
export function updateCharacterCardFavoriteStatus(...args) {
    return window.updateCharacterCardFavoriteStatus?.(...args);
}

/**
 * Download a Blob as a file via anchor click
 * @param {Blob} blob - Content to download
 * @param {string} filename - Suggested filename
 */
export function downloadBlobAsFile(...args) {
    return window.downloadBlobAsFile?.(...args);
}

/**
 * CRC32 checksum of a byte array
 * @param {Uint8Array} data - Bytes to checksum
 * @returns {number} Unsigned 32-bit CRC
 */
export function crc32(...args) {
    return window.crc32?.(...args) ?? 0;
}

/**
 * Search-filter a row list with an inline "Create <query>" row on no exact match
 * @param {Object} cfg - { searchId, listId, rowSel, nameOf, createRowClass, createRowHtml, onCreate, emptyId? }
 */
export function filterListWithInlineCreate(...args) {
    return window.filterListWithInlineCreate?.(...args);
}

export function evaluateChatAdvancedFilters(chat) {
    return window.evaluateChatAdvancedFilters?.(chat) ?? true;
}

export function resetChatFilterCaches() {
    window.resetChatFilterCaches?.();
}

export function getAdvFilterRulesForChats() {
    return window.getAdvFilterRulesForChats?.() ?? [];
}

export function getGallerySyncAuditDone() {
    return window.getGallerySyncAuditDone?.() ?? false;
}

export function setGallerySyncAuditDone(v) {
    window.setGallerySyncAuditDone?.(v);
}

/**
 * Generate a unique gallery ID for a character
 * @param {Object} char - Character object
 * @returns {string} Gallery ID
 */
export function generateGalleryId(...args) {
    return window.generateGalleryId?.(...args) || '';
}

// ========================================
// LOGGING
// ========================================

/**
 * Debug log (only outputs when debug mode is enabled)
 * @param {...*} args - Arguments to log
 */
export function debugLog(...args) {
    window.debugLog?.(...args);
}

// ========================================
// CREATOR NOTES
// ========================================

/**
 * Render creator notes into a container with safe HTML handling
 * @param {string} content - Raw creator notes content
 * @param {string} charName - Character name
 * @param {HTMLElement} container - Target container
 */
export function renderCreatorNotesSecure(content, charName, container) {
    window.renderCreatorNotesSecure?.(content, charName, container);
}

/**
 * Clean up a creator notes container (remove event listeners, observers, etc.)
 * @param {HTMLElement} container - Container to clean up
 */
export function cleanupCreatorNotesContainer(container) {
    window.cleanupCreatorNotesContainer?.(container);
}

export async function autoSnapshotBeforeChange(char, reason, opts) {
    return window.autoSnapshotBeforeChange?.(char, reason, opts);
}

// ========================================
// IMPORT / DOWNLOAD PIPELINE
// ========================================

/**
 * Async duplicate check with hydration for cross-provider matching
 * @param {Object} card - Character card to check
 * @returns {Promise<Array>} Duplicate matches sorted by score
 */
export function checkCharacterForDuplicatesAsync(card) {
    return window.checkCharacterForDuplicatesAsync?.(card) || Promise.resolve([]);
}

/**
 * Show a pre-import duplicate warning modal
 * @param {Object} newCharInfo - Info about the character being imported
 * @param {Array} matches - Duplicate matches from checkCharacterForDuplicates
 * @returns {Promise<{choice: string}>} User's choice ('import' | 'replace' | 'skip')
 */
export function showPreImportDuplicateWarning(newCharInfo, matches) {
    return window.showPreImportDuplicateWarning?.(newCharInfo, matches) || Promise.resolve({ choice: 'skip' });
}

/**
 * Find all referenced media URLs in a character card's fields
 * @param {Object} card - Character card
 * @returns {Array<string>} Media URLs found
 */
export function findCharacterMediaUrls(...args) {
    return window.findCharacterMediaUrls?.(...args) || [];
}

/**
 * All scannable text chunks of a hydrated card, lorebook separate
 * @param {Object} character
 * @returns {{ main: string[], lorebook: string[] }}
 */
export function collectCardTextChunks(...args) {
    return window.collectCardTextChunks?.(...args) ?? { main: [], lorebook: [] };
}

/**
 * Lazy-load the gallery extractors (no-op once loaded)
 * @returns {Promise<void>}
 */
export function ensureExtractorsLoaded(...args) {
    return window.ensureExtractorsLoaded?.(...args) ?? Promise.resolve();
}

/**
 * Gallery page URLs found in a card's text (empty until extractors are loaded)
 * @param {Object} character
 * @returns {Array<string>}
 */
export function findCharacterGalleryUrls(...args) {
    return window.findCharacterGalleryUrls?.(...args) ?? [];
}

/**
 * Show the import summary modal after downloading a character
 * @param {Object} summaryData - Import summary details
 */
export function showImportSummaryModal(summaryData) {
    window.showImportSummaryModal?.(summaryData);
}

/**
 * Queue background media-download jobs for freshly imported characters
 * @param {Object} summaryData - Same {galleryCharacters, mediaCharacters} shape as the summary modal
 * @returns {number} count of queued jobs
 */
export function queueImportMediaJobs(...args) {
    return window.queueImportMediaJobs?.(...args) ?? 0;
}

/**
 * Collapse all sections of a browse preview modal (fresh-open state)
 * @param {HTMLElement} modal
 */
export function resetBrowseSectionCollapseState(...args) {
    return window.resetBrowseSectionCollapseState?.(...args);
}

/**
 * Publish the open browse preview's alt greetings for the fullscreen expander
 * @param {Array<string>|null} greetings
 */
export function setBrowseAltGreetings(...args) {
    return window.setBrowseAltGreetings?.(...args);
}

/**
 * Convert an image (any format) to PNG
 * @param {Blob|ArrayBuffer} imageData - Source image
 * @returns {Promise<Blob>} PNG blob
 */
export function convertImageToPng(imageData) {
    return window.convertImageToPng?.(imageData) || Promise.resolve(null);
}

/**
 * Embed character JSON data into a PNG file's tEXt chunk
 * @param {Blob|ArrayBuffer} pngData - PNG image data
 * @param {Object} charData - Character data to embed
 * @returns {Promise<Blob>} PNG with embedded data
 */
export function embedCharacterDataInPng(pngData, charData) {
    return window.embedCharacterDataInPng?.(pngData, charData) || Promise.resolve(null);
}

// ========================================
// GALLERY MEDIA PIPELINE
// ========================================

/**
 * Get existing file hashes for a gallery folder (dedup check)
 * @param {string} folderName - Gallery folder name
 * @returns {Promise<Map>} Map of hash → filename
 */
export function getExistingFileHashes(folderName) {
    return window.getExistingFileHashes?.(folderName) || Promise.resolve(new Map());
}

/**
 * @param {string} folderName
 * @returns {Promise<Map<string, {fileName: string, localPath: string}>>}
 */
export function getExistingFileIndex(folderName) {
    return window.getExistingFileIndex?.(folderName) || Promise.resolve(new Map());
}

/**
 * @param {string} url
 * @returns {string}
 */
export function extractSanitizedUrlName(url) {
    return window.extractSanitizedUrlName?.(url) || '';
}

/**
 * Build shared dedup state for a gallery folder. Call once, pass to all download phases.
 * @param {string} folderName
 * @returns {Promise<Object>}
 */
export function buildDedupState(folderName) {
    return window.buildDedupState?.(folderName);
}

/**
 * Unified media download pipeline. Downloads all applicable media for a character.
 * @param {Object} character
 * @param {string} folderName
 * @param {Object} [options]
 * @returns {Promise<Object>} PipelineResult
 */
export function downloadCharacterMedia(character, folderName, options) {
    return window.downloadCharacterMedia?.(character, folderName, options);
}

/** Mark a character's media localization as complete (Files-API set). */
export function markMediaLocalizationComplete(...args) {
    return window.markMediaLocalizationComplete?.(...args);
}

/** Contribute a section to the topbar notifications dropdown. */
export function registerNotificationSection(...args) {
    return window.registerNotificationSection?.(...args);
}

/** Recompute the notifications button icon/badge/visibility from all sections. */
export function refreshNotificationsUI(...args) {
    return window.refreshNotificationsUI?.(...args);
}

/** @returns {Set<string>} avatars with completed media localization */
export function getCompletedMediaLocalizations(...args) {
    return window.getCompletedMediaLocalizations?.(...args);
}

/**
 * Download a remote media file into memory
 * @param {string} url - Media URL
 * @param {number} timeout - Timeout in ms
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Object>} { arrayBuffer, contentType, filename }
 */
export function downloadMediaToMemory(url, timeout, signal) {
    return window.downloadMediaToMemory?.(url, timeout, signal) || Promise.resolve(null);
}

/**
 * Check if a URL is safe to download from (rejects private IPs, internal hostnames, non-http schemes).
 * @param {string} url
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isUrlSafeForDownload(url) {
    return window.isUrlSafeForDownload?.(url) || { ok: false, reason: 'safety check unavailable' };
}

/**
 * Calculate a SHA-256 hash of an ArrayBuffer
 * @param {ArrayBuffer} arrayBuffer - Data to hash
 * @returns {Promise<string>} Hex hash string
 */
export function calculateHash(arrayBuffer) {
    return window.calculateHash?.(arrayBuffer) || Promise.resolve('');
}

/**
 * Convert an ArrayBuffer to a base64 string
 * @param {ArrayBuffer} buf - ArrayBuffer to convert
 * @returns {string} Base64-encoded string
 */
export function arrayBufferToBase64(buf) {
    return window.arrayBufferToBase64?.(buf) || '';
}

/**
 * Get the API endpoints constant object
 * @returns {Object} Endpoints map (e.g. { IMAGES_UPLOAD: '/images/upload', ... })
 */
export function getEndpoints() {
    return window.ENDPOINTS || {};
}

// ========================================
// PROVIDER LINK UI
// ========================================

/**
 * Open the bulk auto-link modal
 */
export function openBulkAutoLinkModal() {
    window.openBulkAutoLinkModal?.();
}

// ========================================
// CARD DATA
// ========================================

/**
 * Extract character data from PNG buffer
 * @param {ArrayBuffer} pngBuffer - PNG file data
 * @returns {Object|null} Parsed character card or null
 */
export function extractCharacterDataFromPng(pngBuffer) {
    return window.extractCharacterDataFromPng?.(pngBuffer) || null;
}

/**
 * Apply field updates to a character card. Convenience wrapper around writeCardFields:
 * looks up the char by avatar, runs the write, then triggers gallery folder rename
 * (if name changed) + ST main window notify.
 *
 * If your caller already has the char ref AND wants to handle gallery rename / ST notify
 * itself, use writeCardFields instead to avoid duplicate side effects.
 *
 * @param {string} avatar - Character avatar filename
 * @param {Object} fieldUpdates - Object with field paths as keys and new values
 * @param {Object} [opts] - awaitNotify: await the ST resync before returning, so a follow-on implicit card save cannot clobber this write. rootFields: payload-root key/values for fields ST keeps outside data (chat, fav, create_date).
 * @returns {Promise<boolean>} Success status
 */
export function applyCardFieldUpdates(...args) {
    return window.applyCardFieldUpdates?.(...args) || Promise.resolve(false);
}

/**
 * Primitive card-write operation: hydrate, preflight pollution cleanup, build payload,
 * send merge-attributes, sync in-memory state on the passed char + the matching
 * allCharacters entry. No convenience side effects (no gallery folder rename, no ST notify).
 *
 * Use this when you have the char ref and want to handle post-write orchestration yourself.
 * Pass ST_UNSET_SENTINEL (via getExtensionDeleteValue) as a value to delete an extension key.
 *
 * @param {Object} char - the character object (live ref, mutated in place)
 * @param {Object} fieldUpdates - Object with dot-path keys to values
 * @param {Object} [opts] - rootFields: payload-root key/values for fields ST keeps outside data
 * @returns {Promise<{ok: boolean, response?: Response}>}
 */
export function writeCardFields(...args) {
    return window.writeCardFields?.(...args) || Promise.resolve({ ok: false });
}

/**
 * Returns the value to write for "delete this extension key" intent in merge-attributes payloads.
 * Sentinel string '__@@UNSET@@__' on ST >= 1.13.5 (which actually deletes), null fallback otherwise (broken on older ST but no regression vs the pre-fix behavior).
 * @returns {Promise<string|null>}
 */
export function getExtensionDeleteValue() {
    return window.getExtensionDeleteValue?.() ?? Promise.resolve(null);
}

/**
 * Get the linked world info name for a character
 * @param {string} avatar - Character avatar filename
 * @returns {string|null} The world info name or null
 */
export function getCharacterWorldName(avatar) {
    return window.getCharacterWorldName?.(avatar) || null;
}

/**
 * Fetch world info data from ST
 * @param {string} worldName - The world name to fetch
 * @returns {Promise<Object|null>} World info data or null
 */
export function getWorldInfoData(worldName) {
    return window.getWorldInfoData?.(worldName) || Promise.resolve(null);
}

/**
 * Save world info data to ST
 * @param {string} worldName - The world name to save
 * @param {Object} data - World info data object
 * @returns {Promise<boolean>} Success
 */
export function saveWorldInfoData(worldName, data) {
    return window.saveWorldInfoData?.(worldName, data) || Promise.resolve(false);
}

/**
 * List all world info files available on the server.
 * @returns {Promise<Array<{file_id: string, name: string, extensions: Object}>>}
 */
export function listWorldInfoFiles() {
    return window.listWorldInfoFiles?.() || Promise.resolve([]);
}

/**
 * Create a new (empty) world info file.
 * @param {string} worldName
 * @returns {Promise<boolean>} Success
 */
export function createWorldInfo(worldName) {
    return window.createWorldInfo?.(worldName) || Promise.resolve(false);
}

/**
 * Delete a world info file.
 * @param {string} worldName
 * @returns {Promise<boolean>} Success
 */
export function deleteWorldInfo(worldName) {
    return window.deleteWorldInfo?.(worldName) || Promise.resolve(false);
}

/**
 * Rename a world info file (copy-new + delete-old).
 * @param {string} oldName
 * @param {string} newName
 * @returns {Promise<boolean>} Success
 */
export function renameWorldInfo(oldName, newName) {
    return window.renameWorldInfo?.(oldName, newName) || Promise.resolve(false);
}

/**
 * Import a native ST world JSON object under a destination name.
 * @param {string} worldName
 * @param {Object} worldData - must contain an `entries` object
 * @returns {Promise<boolean>} Success
 */
export function importWorldInfoData(worldName, worldData) {
    return window.importWorldInfoData?.(worldName, worldData) || Promise.resolve(false);
}

/**
 * Merge remote V2 lorebook entries into the character's linked /worlds file.
 * Matched entries get updated; new entries are added; user entries are preserved.
 * @param {string} avatar - Character avatar filename
 * @param {Object} remoteBook - Remote V2 character_book object
 * @returns {Promise<boolean>} Success
 */
export function mergeRemoteLorebookIntoWorldFile(avatar, remoteBook) {
    return window.mergeRemoteLorebookIntoWorldFile?.(avatar, remoteBook) || Promise.resolve(false);
}

/**
 * Set/clear a single-character chat's bound lorebook (chat_metadata.world_info).
 * Owned by the chats module; proxied here for the Lorebook Manager.
 * @param {Object} char - { avatar, name }
 * @param {string} chatFile - chat file name
 * @param {string|null} worldName - world to bind, or null/'' to clear
 * @returns {Promise<boolean>} Success
 */
export function setChatBoundWorld(char, chatFile, worldName) {
    return window.chatsModule?.setChatBoundWorld?.(char, chatFile, worldName) || Promise.resolve(false);
}

/**
 * List a character's chats WITH chat_metadata (each entry exposes its bound lorebook).
 * @param {Object} char - { avatar, name }
 * @returns {Promise<Array>} chat entries
 */
export function listCharacterChatsWithMeta(char) {
    return window.chatsModule?.listCharacterChatsWithMeta?.(char) || Promise.resolve([]);
}

/**
 * List ALL single-character chats (across every character) that bind a lorebook.
 * @returns {Promise<Array<{avatar, charName, char, file_name, world}>>}
 */
export function listAllChatsWithMeta() {
    return window.chatsModule?.listAllChatsWithMeta?.() || Promise.resolve([]);
}

// ========================================
// PROVIDER REGISTRY
// Generic provider-agnostic functions for linking, updates, etc.
// ========================================

/**
 * Get all registered providers.
 * @returns {import('./providers/provider-interface.js').ProviderBase[]}
 */
export function getAllProviders() {
    return ProviderRegistry.getAllProviders();
}

/**
 * Get a specific provider by ID.
 * @param {string} id
 * @returns {import('./providers/provider-interface.js').ProviderBase|undefined}
 */
export function getProvider(providerId) {
    return ProviderRegistry.getProvider(providerId);
}

/**
 * Find which provider owns a character (checks all registered providers).
 * @param {Object} char - Character object
 * @returns {{ provider: Object, linkInfo: Object }|null}
 */
export function getCharacterProvider(char) {
    return ProviderRegistry.getCharacterProvider(char);
}

/**
 * Get link info for a character from any provider.
 * Generic replacement for getChubLinkInfo().
 * @param {Object} char
 * @returns {Object|null} ProviderLinkInfo
 */
export function getProviderLinkInfo(char) {
    return ProviderRegistry.getLinkInfo(char);
}

/**
 * Get all characters linked to ANY provider.
 * @returns {Array<{char: Object, provider: Object, linkInfo: Object}>}
 */
export function getAllLinkedCharacters() {
    return ProviderRegistry.getAllLinkedCharacters(getAllCharacters());
}

/**
 * Which extensions namespace carries the display tagline: provider id when linked, 'cl' otherwise.
 * @param {Object} char
 * @returns {string}
 */
export function getActiveTaglineNamespace(char) {
    return ProviderRegistry.getActiveTaglineNamespace(char);
}

// ========================================
// UPDATE LOCK
// ========================================

export function isUpdateLocked(char) { return window.isUpdateLocked?.(char) ?? false; }
export function setUpdateLocked(...args) { return window.setUpdateLocked?.(...args); }

// ========================================
// PLAYLISTS
// ========================================

export function playlistsLoadPlaylists() { return window.playlistsLoadPlaylists?.(); }
export function playlistsGetAll() { return window.playlistsGetAll?.(); }
export function playlistsGetCharacters(...args) { return window.playlistsGetCharacters?.(...args); }
export function playlistsGetAvatarSet(...args) { return window.playlistsGetAvatarSet?.(...args); }
export function playlistsOnCharDeleted(...args) { return window.playlistsOnCharDeleted?.(...args); }
export function openPlaylistPicker(...args) { return window.openPlaylistPicker?.(...args); }
export function refreshPlaylistFilterIfActive(...args) { return window.refreshPlaylistFilterIfActive?.(...args); }
export function refreshPlaylistBadges() { return window.refreshPlaylistBadges?.(); }
export function closeAllTopbarDropdowns(...args) { return window.closeAllTopbarDropdowns?.(...args); }
export function openGalleryViewerWithImages(...args) { return window.openGalleryViewerWithImages?.(...args); }

// ========================================
// DEFAULT EXPORT - Convenience object
// ========================================

export default {
    // State
    getAllCharacters,
    getCurrentCharacters,
    getCharacterByAvatar,
    getSetting,
    setSetting,
    setSettings,
    getProviderExcludeTags,
    setProviderExcludeTags,
    applyCustomCSS,
    getCustomCSSMaxBytes,

    // View management
    switchView,
    getCurrentView,
    onViewEnter,
    onViewExit,
    
    // UI
    openCharacterModal,
    openCharModalElevated,
    showToast,
    hapticFeedback,
    showConfirm,
    savePresetPicker,
    refreshCharacters,
    
    // API
    apiRequest,
    getCSRFToken,
    
    // Gallery
    openGalleryViewerWithImages,
    getGalleryFolderName,
    isMediaLocalizationEnabled,
    buildMediaLocalizationMap,
    replaceMediaUrlsInText,
    getGalleryThumbUrl,
    createThumbLoader,
    sanitizeFolderName,
    getCharacterGalleryInfo,
    getCharacterGalleryId,
    getExistingImageFolders,
    generateGalleryId,
    getGallerySyncAuditDone,
    setGallerySyncAuditDone,
    
    // Multi-select
    isMultiSelectEnabled,
    enableMultiSelect,
    getSelectedCharacters,
    getSelectionCount,
    isCharacterSelected,
    toggleCharacterSelection,
    clearSelection,
    
    // Modules
    getModule,
    
    // Utils
    escapeHtml,
    utf8ToBase64,
    safePurify,
    sanitizeTaglineHtml,
    isExtensionsRecoveryInProgress,
    debounce,
    truncate,
    isMobileMode,
    getCharacterTags,
    getAllTags,
    findCardElement,
    
    // DOM helpers
    showElement,
    hideElement,
    hideModal,
    onElement,
    initCustomSelect,
    
    // Rendering
    renderLoadingState,
    renderSkeletonGrid,
    renderEmptyState,
    getCharacterAvatarStThumbUrl,
    getListingNameFromExtensions,
    bumpAvatarCacheBust,
    getDisplayTagline,
    getCharacterName,
    formatRichText,
    
    // Character actions
    loadCharInMain,
    deleteCharacter,
    showDeleteConfirmation,
    fetchCharacters,
    fetchAndAddCharacter,
    notifySTCharacterAdded,
    hydrateCharacter,
    performSearch,
    getActiveFilterState,
    toggleCharacterFavorite,
    updateCharacterCardFavoriteStatus,
    downloadBlobAsFile,
    crc32,
    filterListWithInlineCreate,
    evaluateChatAdvancedFilters,
    resetChatFilterCaches,
    getAdvFilterRulesForChats,
    
    // Creator Notes
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    autoSnapshotBeforeChange,
    
    // Import / Download Pipeline
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    findCharacterMediaUrls,
    collectCardTextChunks,
    ensureExtractorsLoaded,
    findCharacterGalleryUrls,
    showImportSummaryModal,
    queueImportMediaJobs,
    resetBrowseSectionCollapseState,
    setBrowseAltGreetings,
    convertImageToPng,
    embedCharacterDataInPng,
    
    // Gallery Media Pipeline
    getExistingFileHashes,
    getExistingFileIndex,
    extractSanitizedUrlName,
    buildDedupState,
    downloadCharacterMedia,
    markMediaLocalizationComplete,
    getCompletedMediaLocalizations,
    registerNotificationSection,
    refreshNotificationsUI,
    downloadMediaToMemory,
    isUrlSafeForDownload,
    calculateHash,
    arrayBufferToBase64,
    getEndpoints,
    
    // Provider Link UI
    openProviderLinkModal,
    openBulkAutoLinkModal,
    
    // Logging
    debugLog,
    
    // Card data
    extractCharacterDataFromPng,
    applyCardFieldUpdates,
    writeCardFields,
    getExtensionDeleteValue,
    getCharacterWorldName,
    getWorldInfoData,
    saveWorldInfoData,
    listWorldInfoFiles,
    createWorldInfo,
    deleteWorldInfo,
    renameWorldInfo,
    importWorldInfoData,
    mergeRemoteLorebookIntoWorldFile,
    setChatBoundWorld,
    listCharacterChatsWithMeta,
    listAllChatsWithMeta,

    // Provider Registry (generic)
    getAllProviders,
    getProvider,
    getCharacterProvider,
    getProviderLinkInfo,
    getAllLinkedCharacters,
    getActiveTaglineNamespace,
    // Update Lock
    isUpdateLocked,
    setUpdateLocked,
    // Playlists
    playlistsLoadPlaylists,
    playlistsGetAll,
    playlistsGetCharacters,
    playlistsGetAvatarSet,
    playlistsOnCharDeleted,
    openPlaylistPicker,
    refreshPlaylistFilterIfActive,
    refreshPlaylistBadges,
    closeAllTopbarDropdowns,

    // Host window / Embedded mode
    getHostWindow,
    getSTContext,
    getIsEmbedded,
    closeEmbeddedPanel,
    resolveProxyForProfile,
    getLlmSettings,
    callLLM,
    callCustomLLM,
    extractLlmContent,
};
