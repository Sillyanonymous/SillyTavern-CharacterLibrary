// Core API — proxy layer between modules and the library monolith

import ProviderRegistry from './providers/provider-registry.js';

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
    return getAllCharacters().find(c => c.avatar === avatar);
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

// ========================================
// UI ACTIONS
// ========================================

/**
 * Open the character detail modal
 * @param {Object} char - Character object
 */
export function openCharacterModal(char) {
    return window.openModal?.(char);
}

/**
 * Open character detail modal elevated above confirm-modals
 * @param {Object} char - Character object
 */
export function openCharModalElevated(char) {
    return window.openCharModalElevated?.(char);
}

/**
 * Close the character detail modal
 */
export function closeCharacterModal() {
    window.closeModal?.();
}

/**
 * Open the provider link modal for a character
 * Sets the active character and opens the modal
 * @param {Object} char - Character object
 */
export function openProviderLinkModal(char) {
    if (char) {
        window.activeChar = char;
    }
    window.openProviderLinkModal?.();
}

/**
 * Get the currently active character (in modal view)
 * @returns {Object|null} Active character or null
 */
export function getActiveChar() {
    return window.getActiveChar?.() || null;
}

/**
 * Set the active character (for modal operations)
 * @param {Object} char - Character object
 */
export function setActiveChar(char) {
    window.setActiveChar?.(char);
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
    return window.getGalleryFolderName?.(char) || char?.name || '';
}

/**
 * Sanitize a folder name for safe use in paths
 * Removes illegal characters for Windows/file systems
 * @param {string} name - Folder name to sanitize
 * @returns {string} Sanitized folder name
 */
export function sanitizeFolderName(name) {
    if (window.sanitizeFolderName) {
        return window.sanitizeFolderName(name);
    }
    // Fallback: remove illegal Windows path characters
    return (name || '').replace(/[\\/:*?"<>|]/g, '').trim();
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
    return window.getCharacterGalleryId?.(char) || char?.data?.extensions?.gallery_id || null;
}

/**
 * Remove a gallery folder override for a character
 * Cleans up the extensionSettings.gallery.folders mapping when a character is deleted
 * @param {string} avatar - Character avatar filename
 */
export function removeGalleryFolderOverride(avatar) {
    window.removeGalleryFolderOverride?.(avatar);
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
    if (window.apiRequest) {
        return window.apiRequest(endpoint, method, data, options);
    }
    
    // Fallback implementation
    return fetch(`/api${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCSRFToken()
        },
        body: data ? JSON.stringify(data) : undefined,
        ...options
    });
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
    return window.MultiSelect?.enabled || false;
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
    if (window.escapeHtml) {
        return window.escapeHtml(text);
    }
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Sanitize a tagline HTML string (strips dangerous elements, keeps safe formatting)
 * @param {string} html - Raw tagline HTML from external data
 * @returns {string} Sanitized HTML
 */
export function sanitizeTaglineHtml(html) {
    return window.sanitizeTaglineHtml?.(html) || '';
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
    return window.debounce?.(fn, delay) || fn;
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
    return document.querySelector(`.char-card[data-avatar="${avatar}"]`);
}

/**
 * Show an element by removing 'hidden' class
 * @param {string} id - Element ID
 */
export function showElement(id) {
    document.getElementById(id)?.classList.remove('hidden');
}

/**
 * Hide an element by adding 'hidden' class
 * @param {string} id - Element ID
 */
export function hideElement(id) {
    document.getElementById(id)?.classList.add('hidden');
}

/**
 * Hide a modal (adds 'hidden' class, cleans up overlay)
 * @param {string} modalId - Modal element ID
 */
export function hideModal(modalId) {
    if (window.hideModal) {
        return window.hideModal(modalId);
    }
    document.getElementById(modalId)?.classList.add('hidden');
}

/**
 * Bind an event listener to an element by ID
 * @param {string} id - Element ID
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {boolean} Whether the element was found
 */
export function onElement(id, event, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(event, handler);
        return true;
    }
    return false;
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
    if (window.renderLoadingState) {
        return window.renderLoadingState(container, message, className);
    }
    if (container) {
        container.innerHTML = `<div class="${className}"><i class="fa-solid fa-spinner fa-spin"></i><p>${message}</p></div>`;
    }
}

/**
 * Get avatar URL for a character
 * @param {string} avatar - Avatar filename
 * @returns {string} Avatar URL
 */
export function getCharacterAvatarUrl(avatar) {
    if (window.getCharacterAvatarUrl) {
        return window.getCharacterAvatarUrl(avatar);
    }
    return avatar ? `/characters/${avatar}` : '/img/ai4.png';
}

/**
 * Format rich text (markdown-like formatting for chat messages)
 * @param {string} text - Raw text
 * @param {string} charName - Character name for substitution
 * @param {boolean} preserveHtml - Whether to preserve existing HTML
 * @returns {string} Formatted HTML
 */
export function formatRichText(text, charName = '', preserveHtml = false) {
    if (window.formatRichText) {
        return window.formatRichText(text, charName, preserveHtml);
    }
    // Minimal fallback
    return escapeHtml(text);
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
 * Register a gallery folder override for media localization
 * @param {Object} char - Character object
 * @param {boolean} immediate - Save immediately
 */
export function registerGalleryFolderOverride(char, immediate = false) {
    window.registerGalleryFolderOverride?.(char, immediate);
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
 * Fetch character list from the server
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Array>} Character array
 */
export function fetchCharacters(forceRefresh = false) {
    return window.fetchCharacters?.(forceRefresh) || Promise.resolve([]);
}

/**
 * @param {string} avatarFileName
 * @returns {Promise<boolean>}
 */
export function fetchAndAddCharacter(avatarFileName) {
    return window.fetchAndAddCharacter?.(avatarFileName) || Promise.resolve(false);
}

/**
 * @param {string} avatar
 */
export function removeCharacterFromList(avatar) {
    window.removeCharacterFromList?.(avatar);
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
 * Sync all gallery folder overrides with the server
 */
export function syncAllGalleryFolderOverrides() {
    window.syncAllGalleryFolderOverrides?.();
}

/**
 * Generate a unique gallery ID for a character
 * @param {Object} char - Character object
 * @returns {string} Gallery ID
 */
export function generateGalleryId(char) {
    return window.generateGalleryId?.(char) || '';
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
 * @param {HTMLElement} container - Target container
 * @param {string} notes - Raw creator notes content
 * @param {Object} options - Rendering options
 */
export function renderCreatorNotesSecure(container, notes, options) {
    window.renderCreatorNotesSecure?.(container, notes, options);
}

/**
 * Clean up a creator notes container (remove event listeners, observers, etc.)
 * @param {HTMLElement} container - Container to clean up
 */
export function cleanupCreatorNotesContainer(container) {
    window.cleanupCreatorNotesContainer?.(container);
}

/**
 * Initialize creator notes interaction handlers (copy, links, etc.)
 * @param {HTMLElement} container - Container element
 */
export function initCreatorNotesHandlers(container) {
    window.initCreatorNotesHandlers?.(container);
}

/**
 * Initialize content expand/collapse handlers for long text sections
 * @param {HTMLElement} container - Container element
 */
export function initContentExpandHandlers(container) {
    window.initContentExpandHandlers?.(container);
}

// ========================================
// IMPORT / DOWNLOAD PIPELINE
// ========================================

/**
 * Check if a character (by name/content) already exists in the local library
 * @param {Object} card - Character card to check
 * @returns {Object|null} Duplicate info or null
 */
export function checkCharacterForDuplicates(card) {
    return window.checkCharacterForDuplicates?.(card) || null;
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
export function findCharacterMediaUrls(card) {
    return window.findCharacterMediaUrls?.(card) || [];
}

/**
 * Show the import summary modal after downloading a character
 * @param {Object} summaryData - Import summary details
 */
export function showImportSummaryModal(summaryData) {
    window.showImportSummaryModal?.(summaryData);
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
 * Apply field updates to a character card
 * @param {string} avatar - Character avatar filename
 * @param {Object} fieldUpdates - Object with field paths as keys and new values
 * @returns {Promise<boolean>} Success status
 */
export function applyCardFieldUpdates(avatar, fieldUpdates) {
    return window.applyCardFieldUpdates?.(avatar, fieldUpdates) || Promise.resolve(false);
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
 * List all world info file names available on the server.
 * @returns {Promise<string[]>} Array of world info names
 */
export function listWorldInfoFiles() {
    return window.listWorldInfoFiles?.() || Promise.resolve([]);
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

// ========================================
// PROVIDER REGISTRY
// Generic provider-agnostic functions for linking, updates, etc.
// ========================================

/**
 * Get the provider registry module.
 * @returns {Object} ProviderRegistry
 */
export function getProviderRegistry() {
    return ProviderRegistry;
}

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
 * Find which provider can handle a URL.
 * @param {string} url
 * @returns {Object|null} Provider or null
 */
export function getProviderForUrl(url) {
    return ProviderRegistry.getProviderForUrl(url);
}

// ========================================
// PLAYLISTS
// ========================================

export function playlistsLoadPlaylists() { return window.playlistsLoadPlaylists?.(); }
export function playlistsCreatePlaylist(...args) { return window.playlistsCreatePlaylist?.(...args); }
export function playlistsDeletePlaylist(...args) { return window.playlistsDeletePlaylist?.(...args); }
export function playlistsUpdatePlaylist(...args) { return window.playlistsUpdatePlaylist?.(...args); }
export function playlistsAddToPlaylist(...args) { return window.playlistsAddToPlaylist?.(...args); }
export function playlistsRemoveFromPlaylist(...args) { return window.playlistsRemoveFromPlaylist?.(...args); }
export function playlistsReorderPlaylists(...args) { return window.playlistsReorderPlaylists?.(...args); }
export function playlistsGetAll() { return window.playlistsGetAll?.(); }
export function playlistsGetPlaylist(...args) { return window.playlistsGetPlaylist?.(...args); }
export function playlistsGetCharacters(...args) { return window.playlistsGetCharacters?.(...args); }
export function playlistsGetAvatarSet(...args) { return window.playlistsGetAvatarSet?.(...args); }
export function playlistsGetForChar(...args) { return window.playlistsGetForChar?.(...args); }
export function playlistsIsCharInPlaylist(...args) { return window.playlistsIsCharInPlaylist?.(...args); }
export function playlistsIsCharInAny(...args) { return window.playlistsIsCharInAny?.(...args); }
export function playlistsOnCharDeleted(...args) { return window.playlistsOnCharDeleted?.(...args); }
export function openPlaylistPicker(...args) { return window.openPlaylistPicker?.(...args); }
export function closePlaylistPicker() { return window.closePlaylistPicker?.(); }
export function setPlaylistFilter(...args) { return window.setPlaylistFilter?.(...args); }
export function clearPlaylistFilter() { return window.clearPlaylistFilter?.(); }
export function openPlaylistManager() { return window.openPlaylistManager?.(); }
export function closePlaylistManager() { return window.closePlaylistManager?.(); }
export function refreshPlaylistBadges() { return window.refreshPlaylistBadges?.(); }
export function closeAllTopbarDropdowns(...args) { return window.closeAllTopbarDropdowns?.(...args); }

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
    
    // View management
    switchView,
    getCurrentView,
    onViewEnter,
    
    // UI
    openCharacterModal,
    openCharModalElevated,
    closeCharacterModal,
    getActiveChar,
    setActiveChar,
    showToast,
    refreshCharacters,
    
    // API
    apiRequest,
    getCSRFToken,
    
    // Gallery
    getGalleryFolderName,
    sanitizeFolderName,
    getCharacterGalleryInfo,
    getCharacterGalleryId,
    removeGalleryFolderOverride,
    generateGalleryId,
    syncAllGalleryFolderOverrides,
    
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
    sanitizeTaglineHtml,
    isExtensionsRecoveryInProgress,
    debounce,
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
    getCharacterAvatarUrl,
    formatRichText,
    
    // Character actions
    loadCharInMain,
    registerGalleryFolderOverride,
    deleteCharacter,
    fetchCharacters,
    fetchAndAddCharacter,
    removeCharacterFromList,
    hydrateCharacter,
    performSearch,
    
    // Creator Notes
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    initCreatorNotesHandlers,
    initContentExpandHandlers,
    
    // Import / Download Pipeline
    checkCharacterForDuplicates,
    showPreImportDuplicateWarning,
    findCharacterMediaUrls,
    showImportSummaryModal,
    convertImageToPng,
    embedCharacterDataInPng,
    
    // Gallery Media Pipeline
    getExistingFileHashes,
    getExistingFileIndex,
    extractSanitizedUrlName,
    downloadMediaToMemory,
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
    getCharacterWorldName,
    getWorldInfoData,
    saveWorldInfoData,
    listWorldInfoFiles,
    mergeRemoteLorebookIntoWorldFile,

    // Provider Registry (generic)
    getProviderRegistry,
    getAllProviders,
    getProvider,
    getCharacterProvider,
    getProviderLinkInfo,
    getAllLinkedCharacters,
    getProviderForUrl,
    // Playlists
    playlistsLoadPlaylists,
    playlistsCreatePlaylist,
    playlistsDeletePlaylist,
    playlistsUpdatePlaylist,
    playlistsAddToPlaylist,
    playlistsRemoveFromPlaylist,
    playlistsReorderPlaylists,
    playlistsGetAll,
    playlistsGetPlaylist,
    playlistsGetCharacters,
    playlistsGetAvatarSet,
    playlistsGetForChar,
    playlistsIsCharInPlaylist,
    playlistsIsCharInAny,
    playlistsOnCharDeleted,
    openPlaylistPicker,
    closePlaylistPicker,
    setPlaylistFilter,
    clearPlaylistFilter,
    openPlaylistManager,
    closePlaylistManager,
    refreshPlaylistBadges,
    closeAllTopbarDropdowns,
};
