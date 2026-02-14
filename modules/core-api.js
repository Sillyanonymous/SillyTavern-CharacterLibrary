// Core API — proxy layer between modules and the library monolith

// ========================================
// STATE ACCESS
// ========================================

// ---- View Management (proxies to library.js implementation) ----

/**
 * Switch between top-level views (characters, chats, chub).
 * @param {string} view - 'characters' | 'chats' | 'chub'
 */
export function switchView(view) {
    window.switchView?.(view);
}

/**
 * Get current active view
 * @returns {string} 'characters' | 'chats' | 'chub'
 */
export function getCurrentView() {
    return window.getCurrentView?.() || 'characters';
}

/**
 * Register a callback to run each time a specific view becomes active.
 * Modules use this for lazy-loading (e.g. chats loads on first visit).
 * @param {string} view - View name ('characters', 'chats', 'chub')
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
    return window.allCharacters || [];
}

/**
 * Get currently filtered/displayed characters
 * @returns {Array} Current character objects
 */
export function getCurrentCharacters() {
    return window.currentCharacters || [];
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

// ========================================
// UI ACTIONS
// ========================================

/**
 * Open the character detail modal
 * @param {Object} char - Character object
 */
export function openCharacterModal(char) {
    window.openModal?.(char);
}

/**
 * Close the character detail modal
 */
export function closeCharacterModal() {
    window.closeModal?.();
}

/**
 * Open the ChubAI link modal for a character
 * Sets the active character and opens the modal
 * @param {Object} char - Character object
 */
export function openChubLinkModal(char) {
    if (char) {
        window.activeChar = char;
    }
    window.openChubLinkModal?.();
}

/**
 * Get the currently active character (in modal view)
 * @returns {Object|null} Active character or null
 */
export function getActiveChar() {
    return window.activeChar || null;
}

/**
 * Set the active character (for modal operations)
 * @param {Object} char - Character object
 */
export function setActiveChar(char) {
    window.activeChar = char;
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
 * Disable multi-select mode
 */
export function disableMultiSelect() {
    window.MultiSelect?.disable();
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

/**
 * Select all filtered characters
 */
export function selectAllVisible() {
    window.MultiSelect?.selectAll();
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

/**
 * Check if a module is loaded
 * @param {string} name - Module name
 * @returns {boolean}
 */
export function hasModule(name) {
    return getModule(name) !== null;
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
 * Find all currently rendered card elements
 * @returns {NodeList}
 */
export function findAllCardElements() {
    return document.querySelectorAll('.char-card');
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
// EVENT SYSTEM (Future expansion)
// ========================================

const eventListeners = new Map();

/**
 * Subscribe to a core event
 * @param {string} event - Event name
 * @param {Function} callback - Event handler
 * @returns {Function} Unsubscribe function
 */
export function on(event, callback) {
    if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
    }
    eventListeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => eventListeners.get(event)?.delete(callback);
}

/**
 * Emit a core event
 * @param {string} event - Event name
 * @param {*} data - Event data
 */
export function emit(event, data) {
    const listeners = eventListeners.get(event);
    if (listeners) {
        listeners.forEach(cb => {
            try {
                cb(data);
            } catch (err) {
                console.error(`[CoreAPI] Event handler error for "${event}":`, err);
            }
        });
    }
}

// ========================================
// KNOWN EVENTS (documentation)
// ========================================
/**
 * Events that can be emitted:
 * - 'characters:loaded' - Characters fetched from server
 * - 'characters:refreshed' - Character list updated
 * - 'character:selected' - Character selected in multi-select
 * - 'character:deselected' - Character deselected
 * - 'character:updated' - Character data modified
 * - 'character:deleted' - Character removed
 * - 'modal:opened' - Character modal opened
 * - 'modal:closed' - Character modal closed
 * - 'selection:changed' - Multi-select selection changed
 */

// ========================================
// CHUB INTEGRATION
// ========================================

/**
 * Get Chub link info for a character
 * @param {Object} char - Character object
 * @returns {Object|null} { id, fullPath, linkedAt } or null if not linked
 */
export function getChubLinkInfo(char) {
    if (!char) return null;
    const extensions = char.data?.extensions || char.extensions;
    const chub = extensions?.chub;
    if (!chub) return null;
    
    // Normalize: native ChubAI cards use full_path (snake_case), we use fullPath (camelCase)
    const fullPath = chub.fullPath || chub.full_path;
    if (!fullPath) return null;
    
    return {
        id: chub.id || null,
        fullPath: fullPath,
        linkedAt: chub.linkedAt || null
    };
}

/**
 * Get all characters linked to ChubAI
 * @returns {Array} Characters with Chub links
 */
export function getChubLinkedCharacters() {
    return getAllCharacters().filter(c => getChubLinkInfo(c)?.fullPath);
}

/**
 * Fetch ChubAI metadata for a character
 * @param {string} fullPath - Chub full path (creator/slug)
 * @returns {Promise<Object|null>} Chub metadata or null
 */
export function fetchChubMetadata(fullPath) {
    return window.fetchChubMetadata?.(fullPath) || Promise.resolve(null);
}

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
 * Get Chub API headers (with optional auth token)
 * @returns {Object} Headers object
 */
export function getChubHeaders() {
    return window.getChubHeaders?.() || { 'Accept': 'application/json' };
}

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
    
    // View management
    switchView,
    getCurrentView,
    onViewEnter,
    
    // UI
    openCharacterModal,
    closeCharacterModal,
    openChubLinkModal,
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
    
    // Multi-select
    isMultiSelectEnabled,
    enableMultiSelect,
    disableMultiSelect,
    getSelectedCharacters,
    getSelectionCount,
    isCharacterSelected,
    toggleCharacterSelection,
    clearSelection,
    selectAllVisible,
    
    // Modules
    getModule,
    hasModule,
    
    // Utils
    escapeHtml,
    getCharacterTags,
    getAllTags,
    findCardElement,
    findAllCardElements,
    
    // DOM helpers
    showElement,
    hideElement,
    hideModal,
    onElement,
    
    // Rendering
    renderLoadingState,
    getCharacterAvatarUrl,
    formatRichText,
    
    // Character actions
    loadCharInMain,
    registerGalleryFolderOverride,
    
    // Logging
    debugLog,
    
    // Events
    on,
    emit,
    
    // Chub
    getChubLinkInfo,
    getChubLinkedCharacters,
    fetchChubMetadata,
    extractCharacterDataFromPng,
    applyCardFieldUpdates,
    getChubHeaders
};
