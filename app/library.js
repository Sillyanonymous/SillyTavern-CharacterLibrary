// SillyTavern Character Library Logic

const API_BASE = '/api'; 
let allCharacters = [];
let currentCharacters = [];

// Virtual scroll state - moved to renderGrid section
let currentScrollHandler = null;

// Edit lock state
let isEditLocked = true;
let originalValues = {};  // Form values for diff comparison
let originalRawData = {}; // Raw character data for cancel/restore
let pendingPayload = null;

// Favorites filter state
let showFavoritesOnly = false;

// ========================================
// PERFORMANCE UTILITIES
// ========================================

/**
 * Debounce function - delays execution until wait ms after last call
 * @param {Function} func - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle function - limits execution to once per wait ms
 * @param {Function} func - Function to throttle  
 * @param {number} wait - Minimum ms between calls
 * @returns {Function} Throttled function
 */
function throttle(func, wait) {
    let lastTime = 0;
    return function executedFunction(...args) {
        const now = Date.now();
        if (now - lastTime >= wait) {
            lastTime = now;
            func(...args);
        }
    };
}

// Simple cache for expensive computations
const computationCache = new Map();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
    const entry = computationCache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) {
        return entry.value;
    }
    computationCache.delete(key);
    return undefined;
}

function setCached(key, value) {
    // Evict oldest entries if cache is full
    if (computationCache.size >= CACHE_MAX_SIZE) {
        const firstKey = computationCache.keys().next().value;
        computationCache.delete(firstKey);
    }
    computationCache.set(key, { value, time: Date.now() });
}

function clearCache() {
    computationCache.clear();
}

// ========================================
// SETTINGS PERSISTENCE SYSTEM
// Uses SillyTavern's extensionSettings via main window for server-side storage
// Falls back to localStorage if main window unavailable
// ========================================

const SETTINGS_KEY = 'SillyTavernCharacterGallery';
const DEFAULT_SETTINGS = {
    chubToken: null,
    chubRememberToken: false,
    // Add more settings here as needed
    defaultSort: 'name_asc',
    // Include ChubAI gallery images in character galleries
    includeChubGallery: true,
    searchInName: true,
    searchInTags: true,
    searchInAuthor: false,
    searchInNotes: false,
    // Duplicate detection minimum score (points-based, 0-100)
    duplicateMinScore: 35,
    // Rich creator notes rendering (experimental) - uses sandboxed iframe with full CSS/HTML support
    richCreatorNotes: true,
    // Highlight/accent color (CSS color value)
    highlightColor: '#4a9eff',
    // Media Localization: Replace remote URLs with local files on-the-fly
    mediaLocalizationEnabled: true,
    // Fix filenames during localization (rename to localized_media_* format)
    fixFilenames: true,
    // Per-character overrides for media localization (avatar -> boolean)
    mediaLocalizationPerChar: {},
    // Show notification when imported chars have additional content (gallery/embedded media)
    notifyAdditionalContent: true,
    // Replace {{user}} placeholder with active persona name
    replaceUserPlaceholder: true,
    // Debug mode - enable console logging
    debugMode: false,
    // Unique Gallery Folders: Use gallery_id to create unique folder names, preventing shared galleries
    // when multiple characters share the same name
    uniqueGalleryFolders: false,
    // Show Info tab in character modal (debugging/metadata info)
    showInfoTab: false,
    // Show ChubAI tagline in character modal
    showChubTagline: true,
    // Allow rich HTML/CSS in tagline rendering (sanitized)
    allowRichTagline: false,
};

// Debug logging helper - only logs when debug mode is enabled
function debugLog(...args) {
    if (getSetting('debugMode')) {
        console.log('[Debug]', ...args);
    }
}

function debugWarn(...args) {
    if (getSetting('debugMode')) {
        console.warn('[Debug]', ...args);
    }
}

function debugError(...args) {
    // Always log errors, but add prefix when in debug mode
    if (getSetting('debugMode')) {
        console.error('[Debug]', ...args);
    } else {
        console.error(...args);
    }
}

// In-memory settings cache
let gallerySettings = { ...DEFAULT_SETTINGS };

/**
 * Get the SillyTavern context from the main window
 * @returns {object|null} The ST context or null if unavailable
 */
function getSTContext() {
    try {
        if (window.opener && !window.opener.closed && window.opener.SillyTavern?.getContext) {
            return window.opener.SillyTavern.getContext();
        }
    } catch (e) {
        console.warn('[Settings] Cannot access main window context:', e);
    }
    return null;
}

/**
 * Directly set a value in ST's extensionSettings via the opener window
 * Uses explicit property assignment to ensure cross-window write works
 * @param {string} path - Dot-separated path like 'gallery.folders'
 * @param {string} key - The key to set
 * @param {*} value - The value to set
 * @param {boolean} [immediate=false] - If true, use saveSettings() instead of saveSettingsDebounced() for critical operations
 * @returns {boolean} True if successful
 */
function setSTExtensionSetting(path, key, value, immediate = false) {
    try {
        if (!window.opener || window.opener.closed) {
            debugWarn('[ST Settings] window.opener not available');
            return false;
        }
        
        const stContext = window.opener.SillyTavern?.getContext?.();
        if (!stContext?.extensionSettings) {
            debugWarn('[ST Settings] ST context or extensionSettings unavailable');
            return false;
        }
        
        // Navigate to the path, creating objects as needed
        const parts = path.split('.');
        let current = stContext.extensionSettings;
        
        for (const part of parts) {
            if (!current[part]) {
                current[part] = {};
            }
            current = current[part];
        }
        
        // Set the value
        current[key] = value;
        
        // Trigger save - use immediate save for critical operations to avoid race conditions
        if (immediate && typeof stContext.saveSettings === 'function') {
            stContext.saveSettings();
        } else if (typeof stContext.saveSettingsDebounced === 'function') {
            stContext.saveSettingsDebounced();
        }
        
        return current[key] === value;
    } catch (e) {
        debugError('[ST Settings] Error setting value:', e);
        return false;
    }
}

/**
 * Verify that our context access matches what ST's gallery would use
 * This helps diagnose cross-window context issues
 */
function verifyContextAccess() {
    const ourContext = getSTContext();
    if (!ourContext?.extensionSettings) return false;
    
    // Ensure gallery.folders exists
    if (!ourContext.extensionSettings.gallery) {
        ourContext.extensionSettings.gallery = { folders: {} };
    }
    if (!ourContext.extensionSettings.gallery.folders) {
        ourContext.extensionSettings.gallery.folders = {};
    }
    
    // Try setting and reading back a test value
    const testKey = '__contextTest__' + Date.now();
    const testValue = 'test_' + Math.random();
    
    ourContext.extensionSettings.gallery.folders[testKey] = testValue;
    const success = ourContext.extensionSettings.gallery.folders[testKey] === testValue;
    delete ourContext.extensionSettings.gallery.folders[testKey];
    
    return success;
}

/**
 * Get the active persona name from SillyTavern
 * @returns {string} The persona name or '{{user}}' if unavailable or disabled
 */
function getPersonaName() {
    // Check if persona replacement is enabled
    if (getSetting('replaceUserPlaceholder') === false) {
        return '{{user}}';
    }
    try {
        const context = getSTContext();
        if (context) {
            // ST stores the user's name in name1 or user_name
            return context.name1 || context.user_name || '{{user}}';
        }
    } catch (e) {
        console.warn('[Persona] Cannot get persona name:', e);
    }
    return '{{user}}';
}

/**
 * Load settings from SillyTavern's settings.json on disk via API
 * Falls back to opener's in-memory extensionSettings, then localStorage
 */
async function loadGallerySettings() {
    // Try to load fresh from disk via ST's settings API (authoritative source)
    try {
        const response = await apiRequest('/settings/get', 'POST');
        if (response.ok) {
            const data = await response.json();
            // ST returns the settings field as a raw JSON string
            const parsedSettings = JSON.parse(data.settings);
            // Key in settings.json on disk is snake_case "extension_settings"
            // (ST's context API uses camelCase "extensionSettings", but the raw file doesn't)
            if (parsedSettings?.extension_settings?.[SETTINGS_KEY]) {
                gallerySettings = { ...DEFAULT_SETTINGS, ...parsedSettings.extension_settings[SETTINGS_KEY] };
                console.log('[Settings] Loaded fresh from disk via /api/settings/get', gallerySettings);
                // Also sync to opener's in-memory state so saves work correctly
                const context = getSTContext();
                if (context && context.extensionSettings) {
                    context.extensionSettings[SETTINGS_KEY] = { ...gallerySettings };
                }
                return;
            }
            console.log('[Settings] No extension settings found on disk for key:', SETTINGS_KEY, 'keys found:', Object.keys(parsedSettings?.extension_settings || {}));
        }
    } catch (e) {
        console.warn('[Settings] Failed to load from API, trying fallbacks:', e);
    }

    // Fallback: opener's in-memory extensionSettings
    const context = getSTContext();
    if (context && context.extensionSettings) {
        if (!context.extensionSettings[SETTINGS_KEY]) {
            context.extensionSettings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
        }
        gallerySettings = { ...DEFAULT_SETTINGS, ...context.extensionSettings[SETTINGS_KEY] };
        debugLog('[Settings] Loaded from SillyTavern extensionSettings (in-memory fallback)');
        return;
    }
    
    // Final fallback: localStorage
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            gallerySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
            debugLog('[Settings] Loaded from localStorage (fallback)');
        }
    } catch (e) {
        console.warn('[Settings] Failed to load from localStorage:', e);
    }
}

/**
 * Save settings to SillyTavern's extension settings (server-side)
 * Also saves to localStorage as backup
 */
function saveGallerySettings() {
    // Try to save to SillyTavern extension settings first
    const context = getSTContext();
    if (context && context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = { ...gallerySettings };
        // Trigger ST's debounced save to persist to disk
        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
            debugLog('[Settings] Saved to SillyTavern extensionSettings');
        }
    }
    
    // Also save to localStorage as backup
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(gallerySettings));
    } catch (e) {
        console.warn('[Settings] Failed to save to localStorage:', e);
    }
}

/**
 * Get a setting value
 * @param {string} key - The setting key
 * @returns {*} The setting value or undefined
 */
function getSetting(key) {
    return gallerySettings[key];
}

/**
 * Set a setting value and save
 * @param {string} key - The setting key
 * @param {*} value - The value to set
 */
function setSetting(key, value) {
    gallerySettings[key] = value;
    saveGallerySettings();
}

/**
 * Set multiple settings at once and save
 * @param {object} settings - Object with key-value pairs to set
 */
function setSettings(settings) {
    Object.assign(gallerySettings, settings);
    saveGallerySettings();
}

/**
 * Apply the highlight color to CSS variables
 * Converts hex color to RGB for glow effect
 * @param {string} color - CSS color value (hex)
 */
function applyHighlightColor(color) {
    if (!color) color = DEFAULT_SETTINGS.highlightColor;
    
    // Set the main accent color
    document.documentElement.style.setProperty('--accent', color);
    
    // Convert hex to RGB for glow effect
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.3)`);
}

/**
 * Setup the Gallery Settings Modal
 */
function setupSettingsModal() {
    const settingsBtn = document.getElementById('gallerySettingsBtn');
    const settingsModal = document.getElementById('gallerySettingsModal');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    
    // Input elements
    const chubTokenInput = document.getElementById('settingsChubToken');
    const rememberTokenCheckbox = document.getElementById('settingsRememberToken');
    const toggleTokenVisibility = document.getElementById('toggleChubTokenVisibility');
    const minScoreSlider = document.getElementById('settingsMinScore');
    const minScoreValue = document.getElementById('minScoreValue');
    
    // Search defaults
    const searchNameCheckbox = document.getElementById('settingsSearchName');
    const searchTagsCheckbox = document.getElementById('settingsSearchTags');
    const searchAuthorCheckbox = document.getElementById('settingsSearchAuthor');
    const searchNotesCheckbox = document.getElementById('settingsSearchNotes');
    const defaultSortSelect = document.getElementById('settingsDefaultSort');
    
    // Experimental features
    const richCreatorNotesCheckbox = document.getElementById('settingsRichCreatorNotes');
    
    // Media Localization
    const mediaLocalizationCheckbox = document.getElementById('settingsMediaLocalization');
    const fixFilenamesCheckbox = document.getElementById('settingsFixFilenames');
    const includeChubGalleryCheckbox = document.getElementById('settingsIncludeChubGallery');
    
    // Notifications
    const notifyAdditionalContentCheckbox = document.getElementById('settingsNotifyAdditionalContent');
    
    // Display
    const replaceUserPlaceholderCheckbox = document.getElementById('settingsReplaceUserPlaceholder');
    
    // Developer
    const debugModeCheckbox = document.getElementById('settingsDebugMode');
    const showInfoTabCheckbox = document.getElementById('settingsShowInfoTab');
    const showChubTaglineCheckbox = document.getElementById('settingsShowChubTagline');
    const allowRichTaglineCheckbox = document.getElementById('settingsAllowRichTagline');
    
    // Appearance
    const highlightColorInput = document.getElementById('settingsHighlightColor');
    
    // Unique Gallery Folders
    const uniqueGalleryFoldersCheckbox = document.getElementById('settingsUniqueGalleryFolders');
    const migrateGalleryFoldersBtn = document.getElementById('migrateGalleryFoldersBtn');
    const galleryMigrationStatus = document.getElementById('galleryMigrationStatus');
    const galleryMigrationStatusText = document.getElementById('galleryMigrationStatusText');
    const relocateSharedImagesBtn = document.getElementById('relocateSharedImagesBtn');
    const imageRelocationStatus = document.getElementById('imageRelocationStatus');
    const imageRelocationStatusText = document.getElementById('imageRelocationStatusText');
    
    if (!settingsBtn || !settingsModal) return;
    
    // Open modal
    settingsBtn.onclick = () => {
        // Load current settings into form
        chubTokenInput.value = getSetting('chubToken') || '';
        rememberTokenCheckbox.checked = getSetting('chubRememberToken') || false;
        
        const minScore = getSetting('duplicateMinScore') || 35;
        minScoreSlider.value = minScore;
        minScoreValue.textContent = minScore;
        
        // Search defaults
        searchNameCheckbox.checked = getSetting('searchInName') !== false;
        searchTagsCheckbox.checked = getSetting('searchInTags') !== false;
        searchAuthorCheckbox.checked = getSetting('searchInAuthor') || false;
        searchNotesCheckbox.checked = getSetting('searchInNotes') || false;
        defaultSortSelect.value = getSetting('defaultSort') || 'name_asc';
        
        // Experimental features
        richCreatorNotesCheckbox.checked = getSetting('richCreatorNotes') || false;
        
        // Media Localization
        if (mediaLocalizationCheckbox) {
            mediaLocalizationCheckbox.checked = getSetting('mediaLocalizationEnabled') !== false; // Default true
        }
        if (fixFilenamesCheckbox) {
            fixFilenamesCheckbox.checked = getSetting('fixFilenames') !== false; // Default true
        }
        if (includeChubGalleryCheckbox) {
            includeChubGalleryCheckbox.checked = getSetting('includeChubGallery') || false;
        }
        
        // Notifications
        if (notifyAdditionalContentCheckbox) {
            notifyAdditionalContentCheckbox.checked = getSetting('notifyAdditionalContent') !== false; // Default true
        }
        
        // Display
        if (replaceUserPlaceholderCheckbox) {
            replaceUserPlaceholderCheckbox.checked = getSetting('replaceUserPlaceholder') !== false; // Default true
        }
        
        // Developer
        if (debugModeCheckbox) {
            debugModeCheckbox.checked = getSetting('debugMode') || false;
        }
        if (showInfoTabCheckbox) {
            showInfoTabCheckbox.checked = getSetting('showInfoTab') || false;
        }
        if (showChubTaglineCheckbox) {
            showChubTaglineCheckbox.checked = getSetting('showChubTagline') !== false;
        }
        if (allowRichTaglineCheckbox) {
            allowRichTaglineCheckbox.checked = getSetting('allowRichTagline') === true;
        }
        
        // Appearance
        if (highlightColorInput) {
            highlightColorInput.value = getSetting('highlightColor') || DEFAULT_SETTINGS.highlightColor;
        }
        
        // Unique Gallery Folders
        if (uniqueGalleryFoldersCheckbox) {
            uniqueGalleryFoldersCheckbox.checked = getSetting('uniqueGalleryFolders') || false;
        }
        // Update migration status
        updateGalleryMigrationStatus();
        updateImageRelocationStatus();
        
        // Reset to first section
        switchSettingsSection('general');
        
        settingsModal.classList.remove('hidden');
    };
    
    // Settings sidebar navigation
    function switchSettingsSection(sectionName) {
        // Update nav items
        settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        // Update panels
        settingsModal.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.section === sectionName);
        });
    }
    
    // Attach click handlers to nav items
    settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            switchSettingsSection(item.dataset.section);
        });
    });
    
    // Close modal
    const closeModal = () => settingsModal.classList.add('hidden');
    closeSettingsModal.onclick = closeModal;
    settingsModal.onclick = (e) => {
        if (e.target === settingsModal) closeModal();
    };
    
    // Toggle token visibility
    toggleTokenVisibility.onclick = () => {
        const isPassword = chubTokenInput.type === 'password';
        chubTokenInput.type = isPassword ? 'text' : 'password';
        toggleTokenVisibility.innerHTML = `<i class="fa-solid fa-eye${isPassword ? '-slash' : ''}"></i>`;
    };
    
    // Slider value display
    minScoreSlider.oninput = () => {
        minScoreValue.textContent = minScoreSlider.value;
    };
    
    // Live preview highlight color
    if (highlightColorInput) {
        highlightColorInput.oninput = () => {
            applyHighlightColor(highlightColorInput.value);
        };
    }
    
    // Helper function to actually save settings
    const doSaveSettings = () => {
        const newHighlightColor = highlightColorInput ? highlightColorInput.value : DEFAULT_SETTINGS.highlightColor;
        
        setSettings({
            chubToken: chubTokenInput.value || null,
            chubRememberToken: rememberTokenCheckbox.checked,
            duplicateMinScore: parseInt(minScoreSlider.value),
            searchInName: searchNameCheckbox.checked,
            searchInTags: searchTagsCheckbox.checked,
            searchInAuthor: searchAuthorCheckbox.checked,
            searchInNotes: searchNotesCheckbox.checked,
            defaultSort: defaultSortSelect.value,
            richCreatorNotes: richCreatorNotesCheckbox.checked,
            highlightColor: newHighlightColor,
            mediaLocalizationEnabled: mediaLocalizationCheckbox ? mediaLocalizationCheckbox.checked : false,
            fixFilenames: fixFilenamesCheckbox ? fixFilenamesCheckbox.checked : false,
            includeChubGallery: includeChubGalleryCheckbox ? includeChubGalleryCheckbox.checked : false,
            notifyAdditionalContent: notifyAdditionalContentCheckbox ? notifyAdditionalContentCheckbox.checked : true,
            replaceUserPlaceholder: replaceUserPlaceholderCheckbox ? replaceUserPlaceholderCheckbox.checked : true,
            debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
            showInfoTab: showInfoTabCheckbox ? showInfoTabCheckbox.checked : false,
            showChubTagline: showChubTaglineCheckbox ? showChubTaglineCheckbox.checked : true,
            allowRichTagline: allowRichTaglineCheckbox ? allowRichTaglineCheckbox.checked : false,
            uniqueGalleryFolders: uniqueGalleryFoldersCheckbox ? uniqueGalleryFoldersCheckbox.checked : false,
        });
        
        // If unique gallery folders was just enabled, register overrides for all characters with gallery_ids
        const uniqueFoldersEnabled = uniqueGalleryFoldersCheckbox ? uniqueGalleryFoldersCheckbox.checked : false;
        if (uniqueFoldersEnabled) {
            let registeredCount = 0;
            for (const char of allCharacters) {
                if (getCharacterGalleryId(char)) {
                    if (registerGalleryFolderOverride(char)) {
                        registeredCount++;
                    }
                }
            }
            if (registeredCount > 0) {
                debugLog(`[Settings] Registered ${registeredCount} folder overrides on enable`);
            }
        }
        
        // Clear media localization cache when setting changes
        clearAllMediaLocalizationCache();
        
        // Apply highlight color
        applyHighlightColor(newHighlightColor);

        // Keep import modal defaults in sync with settings
        syncImportAutoDownloadGallery();
        syncImportAutoDownloadMedia();
        
        // Also update the current session search checkboxes
        const searchName = document.getElementById('searchName');
        const searchTags = document.getElementById('searchTags');
        const searchAuthor = document.getElementById('searchAuthor');
        const searchNotes = document.getElementById('searchNotes');
        const sortSelect = document.getElementById('sortSelect');
        if (searchName) searchName.checked = searchNameCheckbox.checked;
        if (searchTags) searchTags.checked = searchTagsCheckbox.checked;
        if (searchAuthor) searchAuthor.checked = searchAuthorCheckbox.checked;
        if (searchNotes) searchNotes.checked = searchNotesCheckbox.checked;
        if (sortSelect) sortSelect.value = defaultSortSelect.value;
        
        showToast('Settings saved', 'success');
        closeModal();
    };
    
    // Save settings
    saveSettingsBtn.onclick = () => {
        // Check if unique gallery folders is being disabled
        const wasEnabled = getSetting('uniqueGalleryFolders');
        const willBeEnabled = uniqueGalleryFoldersCheckbox ? uniqueGalleryFoldersCheckbox.checked : false;
        
        if (wasEnabled && !willBeEnabled) {
            // Feature is being disabled - show confirmation modal
            showDisableGalleryFoldersModal(
                (movedImages) => {
                    // User confirmed - save settings
                    if (movedImages) {
                        showToast('Images moved to default folders', 'success');
                    }
                    doSaveSettings();
                },
                () => {
                    // User cancelled - revert checkbox
                    if (uniqueGalleryFoldersCheckbox) {
                        uniqueGalleryFoldersCheckbox.checked = true;
                    }
                }
            );
        } else {
            // Normal save
            doSaveSettings();
        }
    };
    
    // Restore defaults - resets to default values AND saves them
    resetSettingsBtn.onclick = () => {
        // Reset form UI to defaults
        chubTokenInput.value = '';
        rememberTokenCheckbox.checked = false;
        minScoreSlider.value = DEFAULT_SETTINGS.duplicateMinScore;
        minScoreValue.textContent = String(DEFAULT_SETTINGS.duplicateMinScore);
        searchNameCheckbox.checked = DEFAULT_SETTINGS.searchInName;
        searchTagsCheckbox.checked = DEFAULT_SETTINGS.searchInTags;
        searchAuthorCheckbox.checked = DEFAULT_SETTINGS.searchInAuthor;
        searchNotesCheckbox.checked = DEFAULT_SETTINGS.searchInNotes;
        defaultSortSelect.value = DEFAULT_SETTINGS.defaultSort;
        richCreatorNotesCheckbox.checked = DEFAULT_SETTINGS.richCreatorNotes;
        if (highlightColorInput) {
            highlightColorInput.value = DEFAULT_SETTINGS.highlightColor;
        }
        if (mediaLocalizationCheckbox) {
            mediaLocalizationCheckbox.checked = DEFAULT_SETTINGS.mediaLocalizationEnabled;
        }
        if (replaceUserPlaceholderCheckbox) {
            replaceUserPlaceholderCheckbox.checked = DEFAULT_SETTINGS.replaceUserPlaceholder;
        }
        if (notifyAdditionalContentCheckbox) {
            notifyAdditionalContentCheckbox.checked = DEFAULT_SETTINGS.notifyAdditionalContent;
        }
        if (uniqueGalleryFoldersCheckbox) {
            uniqueGalleryFoldersCheckbox.checked = DEFAULT_SETTINGS.uniqueGalleryFolders;
        }
        if (showInfoTabCheckbox) {
            showInfoTabCheckbox.checked = DEFAULT_SETTINGS.showInfoTab;
        }
        if (showChubTaglineCheckbox) {
            showChubTaglineCheckbox.checked = DEFAULT_SETTINGS.showChubTagline;
        }
        
        // Apply default highlight color immediately
        applyHighlightColor(DEFAULT_SETTINGS.highlightColor);
        
        // Clear caches
        clearAllMediaLocalizationCache();
        
        // Save defaults to storage (preserving token if "remember" was checked)
        const preserveToken = getSetting('chubRememberToken') ? getSetting('chubToken') : null;
        setSettings({
            ...DEFAULT_SETTINGS,
            chubToken: preserveToken,
        });
        
        // Update current session UI
        const searchName = document.getElementById('searchName');
        const searchTags = document.getElementById('searchTags');
        const searchAuthor = document.getElementById('searchAuthor');
        const searchNotes = document.getElementById('searchNotes');
        const sortSelect = document.getElementById('sortSelect');
        if (searchName) searchName.checked = DEFAULT_SETTINGS.searchInName;
        if (searchTags) searchTags.checked = DEFAULT_SETTINGS.searchInTags;
        if (searchAuthor) searchAuthor.checked = DEFAULT_SETTINGS.searchInAuthor;
        if (searchNotes) searchNotes.checked = DEFAULT_SETTINGS.searchInNotes;
        if (sortSelect) sortSelect.value = DEFAULT_SETTINGS.defaultSort;
        
        showToast('Settings restored to defaults', 'success');
    };
    
    // Update gallery migration status display
    function updateGalleryMigrationStatus() {
        if (!galleryMigrationStatus || !galleryMigrationStatusText) return;
        
        const needsId = countCharactersNeedingGalleryId();
        const needsRegistration = countCharactersNeedingFolderRegistration();
        const total = allCharacters.length;
        const hasId = total - needsId;
        
        if (total === 0) {
            galleryMigrationStatus.style.display = 'none';
            return;
        }
        
        galleryMigrationStatus.style.display = 'block';
        
        if (needsId === 0 && needsRegistration === 0) {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-check-circle" style="color: #4caf50;"></i> All ${total} characters have gallery IDs and folder overrides registered.`;
        } else if (needsId === 0 && needsRegistration > 0) {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> All characters have IDs, but ${needsRegistration} need folder override registration.`;
        } else {
            galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${hasId}/${total} characters have gallery IDs. ${needsId} need assignment.`;
        }
    }
    
    // Batch check for updates button
    const batchCheckUpdatesBtn = document.getElementById('batchCheckUpdatesBtn');
    if (batchCheckUpdatesBtn) {
        batchCheckUpdatesBtn.onclick = () => {
            if (typeof window.checkAllCardUpdates === 'function') {
                window.checkAllCardUpdates();
            } else {
                showToast('Card updates module not loaded', 'error');
            }
        };
    }
    
    // Migration button handler
    if (migrateGalleryFoldersBtn) {
        migrateGalleryFoldersBtn.onclick = async () => {
            // Feature must be enabled to assign IDs
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Use unique gallery folder names" first!', 'error');
                return;
            }
            
            // Use gallery-sync module if available
            if (typeof window.fullGallerySync === 'function') {
                const audit = window.auditGalleryIntegrity();
                const needsId = audit.issues.missingIds;
                const needsMapping = audit.issues.missingMappings;
                
                if (needsId === 0 && needsMapping === 0) {
                    showToast('All characters already have gallery IDs and folder overrides!', 'info');
                    updateGalleryMigrationStatus();
                    return;
                }
                
                let confirmMsg = '';
                if (needsId > 0) {
                    confirmMsg = `This will assign unique gallery IDs to ${needsId} character(s).\n\n`;
                }
                if (needsMapping > 0) {
                    confirmMsg += `${needsMapping} character(s) need folder override registration.\n\n`;
                }
                confirmMsg += `• Gallery IDs are stored in character data (data.extensions.gallery_id)\n` +
                    `• Folder overrides will be registered in SillyTavern settings\n` +
                    `• Existing gallery images are NOT moved (they remain accessible)\n\n` +
                    `Continue?`;
                
                if (!confirm(confirmMsg)) return;
                
                const originalText = migrateGalleryFoldersBtn.innerHTML;
                migrateGalleryFoldersBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
                migrateGalleryFoldersBtn.disabled = true;
                
                try {
                    const result = await window.fullGallerySync({
                        assignIds: true,
                        createMappings: true,
                        cleanupOrphans: false, // Don't cleanup during initial migration
                        onProgress: (phase, current, total) => {
                            if (galleryMigrationStatusText) {
                                const phaseNames = { assignIds: 'Assigning IDs', createMappings: 'Creating mappings' };
                                galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${phaseNames[phase] || phase}... ${current}/${total}`;
                            }
                        }
                    });
                    
                    // Build result message
                    let resultMsg = '';
                    const idCount = result.assignedIds?.success || 0;
                    const mapCount = result.createdMappings?.success || 0;
                    const idErrors = result.assignedIds?.failed || 0;
                    const mapErrors = result.createdMappings?.failed || 0;
                    
                    if (idCount > 0) resultMsg += `${idCount} IDs assigned`;
                    if (mapCount > 0) resultMsg += (resultMsg ? ', ' : '') + `${mapCount} folder overrides synced`;
                    if (idErrors > 0) resultMsg += (resultMsg ? ', ' : '') + `${idErrors} ID errors`;
                    if (mapErrors > 0) resultMsg += (resultMsg ? ', ' : '') + `${mapErrors} sync failures`;
                    
                    if (idErrors === 0 && mapErrors === 0) {
                        showToast(resultMsg || 'Migration complete!', 'success');
                        setTimeout(() => {
                            showToast('⚠️ Refresh the SillyTavern page for changes to take effect in ST gallery!', 'info', 8000);
                        }, 1500);
                    } else {
                        showToast(resultMsg + '. Check console for details.', 'error');
                    }
                } catch (err) {
                    console.error('[GalleryMigration] Failed:', err);
                    showToast('Migration failed - check console', 'error');
                }
                
                migrateGalleryFoldersBtn.innerHTML = originalText;
                migrateGalleryFoldersBtn.disabled = false;
                updateGalleryMigrationStatus();
                return;
            }
            
            // Fallback to old implementation if module not loaded
            const needsId = countCharactersNeedingGalleryId();
            const needsRegistration = countCharactersNeedingFolderRegistration();
            
            if (needsId === 0 && needsRegistration === 0) {
                showToast('All characters already have gallery IDs and folder overrides!', 'info');
                return;
            }
            
            let confirmMsg = '';
            if (needsId > 0) {
                confirmMsg = `This will assign unique gallery IDs to ${needsId} character(s).\n\n`;
            }
            if (needsRegistration > 0) {
                confirmMsg += `${needsRegistration} character(s) need folder override registration.\n\n`;
            }
            confirmMsg += `• Gallery IDs are stored in character data (data.extensions.gallery_id)\n` +
                `• Folder overrides will be registered in SillyTavern settings\n` +
                `• Existing gallery images are NOT moved (they remain accessible)\n\n` +
                `Continue?`;
            
            const confirmed = confirm(confirmMsg);
            
            if (!confirmed) return;
            
            const originalText = migrateGalleryFoldersBtn.innerHTML;
            migrateGalleryFoldersBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            migrateGalleryFoldersBtn.disabled = true;
            
            let idAssignedCount = 0;
            let errorCount = 0;
            const totalToProcess = needsId;
            let processed = 0;
            
            // Step 1: Assign gallery IDs to characters that need them
            for (const char of allCharacters) {
                const hasId = getCharacterGalleryId(char);
                
                if (!hasId) {
                    const result = await assignGalleryIdToCharacter(char);
                    if (result.success) {
                        idAssignedCount++;
                    } else {
                        errorCount++;
                        console.error(`Failed to assign gallery_id to ${char.name}:`, result.error);
                    }
                    processed++;
                    
                    // Update status during processing
                    if (galleryMigrationStatusText) {
                        galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Assigning IDs... ${processed}/${totalToProcess}`;
                    }
                }
            }
            
            // Step 2: Sync ALL folder overrides to ST at once (more reliable than individual registration)
            if (galleryMigrationStatusText) {
                galleryMigrationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Syncing folder overrides to ST...`;
            }
            
            const syncResult = syncAllGalleryFolderOverrides();
            
            migrateGalleryFoldersBtn.innerHTML = originalText;
            migrateGalleryFoldersBtn.disabled = false;
            
            updateGalleryMigrationStatus();
            
            // Build result message
            let resultMsg = '';
            if (idAssignedCount > 0) resultMsg += `${idAssignedCount} IDs assigned`;
            if (syncResult.success > 0) resultMsg += (resultMsg ? ', ' : '') + `${syncResult.success} folder overrides synced`;
            if (errorCount > 0) resultMsg += (resultMsg ? ', ' : '') + `${errorCount} errors`;
            if (syncResult.failed > 0) resultMsg += (resultMsg ? ', ' : '') + `${syncResult.failed} sync failures`;
            
            if (errorCount === 0 && syncResult.failed === 0) {
                showToast(resultMsg || 'Migration complete!', 'success');
                // Important: Tell user to refresh ST
                setTimeout(() => {
                    showToast('⚠️ Refresh the SillyTavern page for changes to take effect in ST gallery!', 'info', 8000);
                }, 1500);
            } else {
                showToast(resultMsg + '. Check console for details.', 'error');
            }
        };
    }
    
    // Update image relocation status display
    function updateImageRelocationStatus() {
        if (!imageRelocationStatus || !imageRelocationStatusText) return;
        
        const { sharedNameGroups, charactersAffected } = countCharactersNeedingImageRelocation();
        
        if (sharedNameGroups === 0) {
            imageRelocationStatus.style.display = 'none';
            return;
        }
        
        imageRelocationStatus.style.display = 'block';
        imageRelocationStatusText.innerHTML = `<i class="fa-solid fa-info-circle"></i> Found ${sharedNameGroups} shared name group(s) with ${charactersAffected} characters that may have mixed gallery images.`;
    }
    
    // Image relocation button handler
    if (relocateSharedImagesBtn) {
        relocateSharedImagesBtn.onclick = async () => {
            const sharedNames = findCharactersWithSharedNames();
            
            if (sharedNames.size === 0) {
                showToast('No characters share the same name - no relocation needed!', 'info');
                return;
            }
            
            // Check if unique folders is enabled
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Unique Gallery Folders" first before relocating images.', 'error');
                return;
            }
            
            // Check that all characters have gallery IDs
            const needsId = countCharactersNeedingGalleryId();
            if (needsId > 0) {
                showToast(`Please assign gallery IDs first (${needsId} characters need IDs).`, 'error');
                return;
            }
            
            // Build description of what will happen
            let groupDescriptions = [];
            for (const [name, chars] of sharedNames) {
                const linkedCount = chars.filter(c => getChubLinkInfo(c)?.id).length;
                groupDescriptions.push(`• "${name}": ${chars.length} characters (${linkedCount} linked to Chub)`);
            }
            
            const confirmed = confirm(
                `Smart Image Relocation\n\n` +
                `This will analyze and move gallery images for characters sharing the same name:\n\n` +
                `${groupDescriptions.slice(0, 5).join('\n')}` +
                `${groupDescriptions.length > 5 ? `\n...and ${groupDescriptions.length - 5} more groups` : ''}\n\n` +
                `Process:\n` +
                `1. Download Chub gallery + embedded media to build ownership "fingerprints"\n` +
                `2. Scan shared folders and match images by content hash\n` +
                `3. Move matched images to unique folders\n\n` +
                `⚠ Images that can't be matched will remain in the shared folder.\n` +
                `⚠ This may take several minutes for many characters.\n\n` +
                `Continue?`
            );
            
            if (!confirmed) return;
            
            const originalText = relocateSharedImagesBtn.innerHTML;
            relocateSharedImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            relocateSharedImagesBtn.disabled = true;
            
            let totalMoved = 0;
            let totalUnmatched = 0;
            let totalErrors = 0;
            let groupsProcessed = 0;
            
            for (const [name, chars] of sharedNames) {
                // Update status
                if (imageRelocationStatusText) {
                    imageRelocationStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing "${name}"... (${groupsProcessed + 1}/${sharedNames.size} groups)`;
                }
                
                const result = await relocateSharedFolderImages(chars, {
                    onLog: (msg, status) => {
                        debugLog(`[Relocate] ${msg}`);
                        return msg;
                    },
                    onLogUpdate: (entry, msg, status) => {
                        debugLog(`[Relocate] ${msg}`);
                    }
                });
                
                totalMoved += result.moved;
                totalUnmatched += result.unmatched;
                totalErrors += result.errors;
                groupsProcessed++;
            }
            
            relocateSharedImagesBtn.innerHTML = originalText;
            relocateSharedImagesBtn.disabled = false;
            
            updateImageRelocationStatus();
            
            // Show summary
            const message = `Relocation complete: ${totalMoved} images moved, ${totalUnmatched} unmatched, ${totalErrors} errors`;
            if (totalErrors === 0) {
                showToast(message, 'success');
            } else {
                showToast(message, 'error');
            }
            
            console.log('[ImageRelocation] Summary:', { totalMoved, totalUnmatched, totalErrors, groupsProcessed });
        };
    }
    
    // Migrate All Images button handler (for characters with unique names)
    const migrateAllImagesBtn = document.getElementById('migrateAllImagesBtn');
    const migrateAllStatus = document.getElementById('migrateAllStatus');
    const migrateAllStatusText = document.getElementById('migrateAllStatusText');
    
    if (migrateAllImagesBtn) {
        migrateAllImagesBtn.onclick = async () => {
            // Check if unique folders is enabled
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Unique Gallery Folders" first before migrating images.', 'error');
                return;
            }
            
            // Get characters with gallery IDs (excluding those with shared names - they need fingerprinting)
            const sharedNames = findCharactersWithSharedNames();
            const sharedAvatars = new Set();
            for (const [_, chars] of sharedNames) {
                chars.forEach(c => sharedAvatars.add(c.avatar));
            }
            
            const uniqueNameChars = allCharacters.filter(c => 
                getCharacterGalleryId(c) && !sharedAvatars.has(c.avatar)
            );
            
            if (uniqueNameChars.length === 0) {
                showToast('No characters with unique names need migration.', 'info');
                return;
            }
            
            const confirmed = confirm(
                `Migrate All Images\n\n` +
                `This will move ALL existing gallery images for ${uniqueNameChars.length} characters with unique names ` +
                `from their old folder to their new unique folder.\n\n` +
                `Example:\n` +
                `• "Alice" folder → "Alice_abc123xyz" folder\n\n` +
                `Note: Characters sharing the same name (${sharedNames.size} groups) are excluded - ` +
                `use "Smart Relocate" for those.\n\n` +
                `Continue?`
            );
            
            if (!confirmed) return;
            
            const originalText = migrateAllImagesBtn.innerHTML;
            migrateAllImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Migrating...';
            migrateAllImagesBtn.disabled = true;
            
            if (migrateAllStatus) migrateAllStatus.style.display = 'block';
            
            let totalMoved = 0;
            let totalErrors = 0;
            let charsProcessed = 0;
            let charsWithImages = 0;
            
            for (const char of uniqueNameChars) {
                charsProcessed++;
                
                if (migrateAllStatusText) {
                    migrateAllStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing ${char.name}... (${charsProcessed}/${uniqueNameChars.length})`;
                }
                
                const result = await migrateCharacterImagesToUniqueFolder(char);
                
                if (result.moved > 0) {
                    charsWithImages++;
                    totalMoved += result.moved;
                }
                totalErrors += result.errors;
            }
            
            migrateAllImagesBtn.innerHTML = originalText;
            migrateAllImagesBtn.disabled = false;
            
            if (migrateAllStatusText) {
                migrateAllStatusText.innerHTML = `<i class="fa-solid fa-check"></i> Migration complete: ${totalMoved} images moved for ${charsWithImages} characters`;
            }
            
            // Show summary
            const message = `Migration complete: ${totalMoved} images moved for ${charsWithImages} characters` + 
                (totalErrors > 0 ? ` (${totalErrors} errors)` : '');
            showToast(message, totalErrors === 0 ? 'success' : 'error');
            
            console.log('[MigrateAll] Summary:', { totalMoved, totalErrors, charsProcessed, charsWithImages });
        };
    }
    
    // View Folder Mapping button handler
    const viewFolderMappingBtn = document.getElementById('viewFolderMappingBtn');
    if (viewFolderMappingBtn) {
        viewFolderMappingBtn.onclick = () => {
            showFolderMappingModal();
        };
    }
    
    // Browse Orphaned Folders button handler
    const browseOrphanedFoldersBtn = document.getElementById('browseOrphanedFoldersBtn');
    if (browseOrphanedFoldersBtn) {
        browseOrphanedFoldersBtn.onclick = () => {
            showOrphanedFoldersModal();
        };
    }
    
    // Gallery Sync - Audit button handler
    const gallerySyncAuditBtn = document.getElementById('gallerySyncAuditBtn');
    const gallerySyncFullBtn = document.getElementById('gallerySyncFullBtn');
    const gallerySyncCleanupBtn = document.getElementById('gallerySyncCleanupBtn');
    const gallerySyncStatus = document.getElementById('gallerySyncStatus');
    
    // Helper to update sync status UI
    const updateSyncStatusUI = (audit) => {
        if (!gallerySyncStatus) return;
        
        const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
        const statusClass = totalIssues === 0 ? 'healthy' : 'issues';
        
        // Build expandable details for each issue type
        const buildMissingIdsDetails = () => {
            if (audit.missingGalleryId.length === 0) return '';
            const items = audit.missingGalleryId.slice(0, 20).map(({ avatar, name }) => 
                `<div class="sync-detail-item"><span class="sync-detail-name">${escapeHtml(name)}</span><span class="sync-detail-avatar">${escapeHtml(avatar)}</span></div>`
            ).join('');
            const moreCount = audit.missingGalleryId.length - 20;
            return `<div class="sync-details-content">${items}${moreCount > 0 ? `<div class="sync-detail-more">...and ${moreCount} more</div>` : ''}</div>`;
        };
        
        const buildMissingMappingsDetails = () => {
            if (audit.missingMapping.length === 0) return '';
            const items = audit.missingMapping.slice(0, 20).map(({ avatar, name, galleryId }) => 
                `<div class="sync-detail-item"><span class="sync-detail-name">${escapeHtml(name)}</span><span class="sync-detail-id">ID: ${escapeHtml(galleryId)}</span></div>`
            ).join('');
            const moreCount = audit.missingMapping.length - 20;
            return `<div class="sync-details-content">${items}${moreCount > 0 ? `<div class="sync-detail-more">...and ${moreCount} more</div>` : ''}</div>`;
        };
        
        const buildOrphanedDetails = () => {
            if (audit.orphanedMappings.length === 0) return '';
            const items = audit.orphanedMappings.slice(0, 20).map(({ avatar, folder }) => 
                `<div class="sync-detail-item"><span class="sync-detail-avatar">${escapeHtml(avatar)}</span><span class="sync-detail-folder">→ ${escapeHtml(folder)}</span></div>`
            ).join('');
            const moreCount = audit.orphanedMappings.length - 20;
            return `<div class="sync-details-content">${items}${moreCount > 0 ? `<div class="sync-detail-more">...and ${moreCount} more</div>` : ''}</div>`;
        };
        
        gallerySyncStatus.innerHTML = `
            <div class="sync-result">
                <div class="sync-result-header ${statusClass}">
                    <i class="fa-solid ${totalIssues === 0 ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                    <span>${totalIssues === 0 ? 'All Synced' : `${totalIssues} Issue${totalIssues !== 1 ? 's' : ''} Found`}</span>
                </div>
                ${totalIssues > 0 ? `
                <div class="sync-issues-list">
                    ${audit.issues.missingIds > 0 ? `
                        <details class="sync-issue-details">
                            <summary class="sync-issue-item">
                                <i class="fa-solid fa-id-card"></i>
                                <span>${audit.issues.missingIds} missing gallery_id</span>
                                <i class="fa-solid fa-chevron-down sync-expand-icon"></i>
                            </summary>
                            ${buildMissingIdsDetails()}
                        </details>
                    ` : ''}
                    ${audit.issues.missingMappings > 0 ? `
                        <details class="sync-issue-details">
                            <summary class="sync-issue-item">
                                <i class="fa-solid fa-folder-open"></i>
                                <span>${audit.issues.missingMappings} missing folder mapping</span>
                                <i class="fa-solid fa-chevron-down sync-expand-icon"></i>
                            </summary>
                            ${buildMissingMappingsDetails()}
                        </details>
                    ` : ''}
                    ${audit.issues.orphaned > 0 ? `
                        <details class="sync-issue-details">
                            <summary class="sync-issue-item">
                                <i class="fa-solid fa-ghost"></i>
                                <span>${audit.issues.orphaned} orphaned mapping${audit.issues.orphaned !== 1 ? 's' : ''}</span>
                                <i class="fa-solid fa-chevron-down sync-expand-icon"></i>
                            </summary>
                            ${buildOrphanedDetails()}
                        </details>
                    ` : ''}
                </div>
                ` : ''}
                <div class="sync-stats">
                    <span><i class="fa-solid fa-users"></i> ${audit.totalCharacters} chars</span>
                    <span><i class="fa-solid fa-folder"></i> ${audit.totalMappings} mappings</span>
                    <span><i class="fa-solid fa-check"></i> ${audit.healthy.length} healthy</span>
                </div>
            </div>
        `;
    };
    
    if (gallerySyncAuditBtn) {
        gallerySyncAuditBtn.onclick = () => {
            if (typeof window.auditGalleryIntegrity !== 'function') {
                showToast('Gallery sync module not loaded', 'error');
                return;
            }
            
            gallerySyncStatus.innerHTML = '<div class="sync-loading"><i class="fa-solid fa-spinner fa-spin"></i> Running audit...</div>';
            
            setTimeout(() => {
                try {
                    const audit = window.auditGalleryIntegrity();
                    updateSyncStatusUI(audit);
                    showToast('Audit complete', 'success');
                } catch (err) {
                    console.error('[GallerySync] Audit failed:', err);
                    gallerySyncStatus.innerHTML = '<div class="sync-status-placeholder"><i class="fa-solid fa-circle-xmark" style="color: #e74c3c;"></i><span>Audit failed - check console</span></div>';
                    showToast('Audit failed', 'error');
                }
            }, 100);
        };
    }
    
    if (gallerySyncFullBtn) {
        gallerySyncFullBtn.onclick = async () => {
            if (typeof window.fullGallerySync !== 'function') {
                showToast('Gallery sync module not loaded', 'error');
                return;
            }
            
            // Feature must be enabled
            if (!getSetting('uniqueGalleryFolders')) {
                showToast('Enable "Use unique gallery folder names" first!', 'error');
                return;
            }
            
            // Run audit first to check scope
            const audit = window.auditGalleryIntegrity();
            const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
            
            if (totalIssues === 0) {
                showToast('Everything is already in sync!', 'info');
                updateSyncStatusUI(audit);
                return;
            }
            
            // Confirm before making changes
            const confirmMsg = `This will:\n` +
                (audit.issues.missingIds > 0 ? `• Assign gallery_id to ${audit.issues.missingIds} character(s)\n` : '') +
                (audit.issues.missingMappings > 0 ? `• Create ${audit.issues.missingMappings} folder mapping(s)\n` : '') +
                (audit.issues.orphaned > 0 ? `• Remove ${audit.issues.orphaned} orphaned mapping(s)\n` : '') +
                `\nContinue?`;
            
            if (!confirm(confirmMsg)) return;
            
            const originalText = gallerySyncFullBtn.innerHTML;
            gallerySyncFullBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
            gallerySyncFullBtn.disabled = true;
            
            gallerySyncStatus.innerHTML = '<div class="sync-loading"><i class="fa-solid fa-spinner fa-spin"></i> Running full sync...</div>';
            
            try {
                const result = await window.fullGallerySync({
                    onProgress: (phase, current, total, item) => {
                        const phaseNames = {
                            assignIds: 'Assigning IDs',
                            createMappings: 'Creating mappings'
                        };
                        gallerySyncStatus.innerHTML = `
                            <div class="sync-progress">
                                <div class="sync-progress-text">
                                    <i class="fa-solid fa-spinner fa-spin"></i> ${phaseNames[phase] || phase}: ${current}/${total}
                                </div>
                                <div class="sync-progress-bar">
                                    <div class="sync-progress-bar-fill" style="width: ${(current/total)*100}%"></div>
                                </div>
                            </div>
                        `;
                    }
                });
                
                // Build result message
                const parts = [];
                if (result.assignedIds?.success > 0) parts.push(`${result.assignedIds.success} IDs assigned`);
                if (result.createdMappings?.success > 0) parts.push(`${result.createdMappings.success} mappings created`);
                if (result.cleanedOrphans?.removed > 0) parts.push(`${result.cleanedOrphans.removed} orphans removed`);
                
                showToast(parts.length > 0 ? parts.join(', ') : 'Sync complete', 'success');
                
                // Re-run audit to show updated status
                const newAudit = window.auditGalleryIntegrity();
                updateSyncStatusUI(newAudit);
                
                // Update warning indicator in top bar
                if (typeof window.updateGallerySyncWarning === 'function') {
                    window.updateGallerySyncWarning(newAudit);
                }
                
            } catch (err) {
                console.error('[GallerySync] Full sync failed:', err);
                showToast('Sync failed - check console', 'error');
            }
            
            gallerySyncFullBtn.innerHTML = originalText;
            gallerySyncFullBtn.disabled = false;
        };
    }
    
    if (gallerySyncCleanupBtn) {
        gallerySyncCleanupBtn.onclick = () => {
            if (typeof window.cleanupOrphanedMappings !== 'function') {
                showToast('Gallery sync module not loaded', 'error');
                return;
            }
            
            // Run audit first
            const audit = window.auditGalleryIntegrity();
            
            if (audit.issues.orphaned === 0) {
                showToast('No orphaned mappings to clean up', 'info');
                updateSyncStatusUI(audit);
                return;
            }
            
            if (!confirm(`Remove ${audit.issues.orphaned} orphaned mapping(s)?\n\nThese are folder mappings for characters that no longer exist.`)) {
                return;
            }
            
            try {
                const result = window.cleanupOrphanedMappings();
                showToast(`Removed ${result.removed} orphaned mapping${result.removed !== 1 ? 's' : ''}`, 'success');
                
                // Re-run audit and update UI
                const newAudit = window.auditGalleryIntegrity();
                updateSyncStatusUI(newAudit);
                
                // Update warning indicator in top bar
                if (typeof window.updateGallerySyncWarning === 'function') {
                    window.updateGallerySyncWarning(newAudit);
                }
            } catch (err) {
                console.error('[GallerySync] Cleanup failed:', err);
                showToast('Cleanup failed', 'error');
            }
        };
    }
}

// Helper to get cookie value
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

function getQueryParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

/**
 * Get CSRF token from URL param or cookie
 * @returns {string} The CSRF token
 */
function getCSRFToken() {
    return getQueryParam('csrf') || getCookie('X-CSRF-Token');
}

// ========================================
// CORE HELPER FUNCTIONS
// Reusable utilities to reduce code duplication
// ========================================

/**
 * Make an API request with CSRF token automatically included
 * @param {string} endpoint - API endpoint (e.g., '/characters/get')
 * @param {string} method - HTTP method (default: 'GET')
 * @param {object|null} data - Request body data (will be JSON stringified)
 * @param {object} options - Additional fetch options
 * @returns {Promise<Response>} Fetch response
 */
async function apiRequest(endpoint, method = 'GET', data = null, options = {}) {
    const csrfToken = getCSRFToken();
    const config = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            ...options.headers
        },
        ...options
    };
    if (data !== null) {
        config.body = JSON.stringify(data);
    }
    return fetch(`${API_BASE}${endpoint}`, config);
}

/**
 * Shorthand event listener registration
 * @param {string} id - Element ID
 * @param {string} event - Event type (e.g., 'click')
 * @param {Function} handler - Event handler function
 * @returns {boolean} True if listener was attached
 */
function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(event, handler);
        return true;
    }
    return false;
}

/**
 * Show an element by removing 'hidden' class
 * @param {string} id - Element ID
 */
function show(id) {
    document.getElementById(id)?.classList.remove('hidden');
}

/**
 * Hide an element by adding 'hidden' class
 * @param {string} id - Element ID
 */
function hide(id) {
    document.getElementById(id)?.classList.add('hidden');
}

/**
 * Wrap an async operation with loading state on a button
 * @param {HTMLElement} button - Button element to show loading state
 * @param {string} loadingText - Text to show while loading
 * @param {Function} operation - Async function to execute
 * @returns {Promise<*>} Result of the operation
 */
async function withLoadingState(button, loadingText, operation) {
    if (!button) return operation();
    const originalHtml = button.innerHTML;
    const wasDisabled = button.disabled;
    button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${loadingText}`;
    button.disabled = true;
    try {
        return await operation();
    } finally {
        button.innerHTML = originalHtml;
        button.disabled = wasDisabled;
    }
}

/**
 * Render a loading spinner in a container
 * @param {HTMLElement|string} container - Container element or ID
 * @param {string} message - Loading message to display
 * @param {string} className - Optional custom class (default: 'loading-spinner')
 */
function renderLoadingState(container, message, className = 'loading-spinner') {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (el) {
        el.innerHTML = `<div class="${className}"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(message)}</div>`;
    }
}

/**
 * Render a simple empty state with just a message
 * @param {HTMLElement|string} container - Container element or ID
 * @param {string} message - Message to display
 * @param {string} className - Optional custom class (default: 'empty-state')
 */
function renderSimpleEmpty(container, message, className = 'empty-state') {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (el) {
        el.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
    }
}

/**
 * Get ChubAI API headers with optional authentication
 * @param {boolean} includeAuth - Whether to include Bearer token
 * @returns {object} Headers object
 */
function getChubHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const token = getSetting('chubToken');
    if (includeAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

// ========================================
// FALLBACK IMAGES
// ========================================
// SVG fallback for broken avatar images (inline data URI)
const FALLBACK_AVATAR_SVG = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>";

// ========================================
// API ENDPOINTS - Centralized path constants
// ========================================
const ENDPOINTS = {
    CHARACTERS_GET: '/characters/get',
    CHARACTERS_ALL: '/characters/all',
    CHARACTERS_CREATE: '/characters/create',
    CHARACTERS_EDIT: '/characters/edit-attribute',
    CHARACTERS_DELETE: '/characters/delete',
    CHARACTERS_CHATS: '/characters/chats',
    CHATS_GET: '/chats/get',
    CHATS_SAVE: '/chats/save',
    CHATS_DELETE: '/chats/delete',
    CHATS_EXPORT: '/chats/export',
    CHATS_GROUP_EXPORT: '/chats/group/export',
    IMAGES_LIST: '/images/list',
    IMAGES_DELETE: '/images/delete',
    IMAGES_UPLOAD: '/images/upload'
};

// ChubAI endpoints
const CHUB_API_BASE = 'https://api.chub.ai';
const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';
const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars/';

// ========================================
// UNIQUE GALLERY FOLDER SYSTEM
// Gives each character a unique gallery folder, even when multiple characters share the same name
// by using a unique gallery_id stored in character data.extensions
// ========================================

/**
 * Generate a unique gallery ID (12-character alphanumeric)
 * @returns {string} A 12-character unique ID like 'aB3xY9kLmN2p'
 */
function generateGalleryId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Get a character's gallery_id from their data.extensions
 * @param {object} char - Character object
 * @returns {string|null} The gallery_id or null if not set
 */
function getCharacterGalleryId(char) {
    return char?.data?.extensions?.gallery_id || null;
}

/**
 * Build the unique gallery folder name for a character
 * Format: "{CharacterName}_{gallery_id}"
 * @param {object} char - Character object (must have name and data.extensions.gallery_id)
 * @returns {string|null} The unique folder name or null if gallery_id not set
 */
function buildUniqueGalleryFolderName(char) {
    const galleryId = getCharacterGalleryId(char);
    if (!galleryId || !char?.name) return null;
    
    // Sanitize character name for folder use (remove/replace problematic characters)
    const safeName = char.name.replace(/[<>:"/\\|?*]/g, '_').trim();
    return `${safeName}_${galleryId}`;
}

/**
 * Register or update the gallery folder override in SillyTavern's extensionSettings
 * This tells ST to use our unique folder instead of just the character name
 * @param {object} char - Character object with avatar and gallery_id
 * @param {boolean} [immediate=false] - If true, save immediately instead of debounced (use for critical operations)
 * @returns {boolean} True if successfully registered
 */
function registerGalleryFolderOverride(char, immediate = false) {
    if (!getSetting('uniqueGalleryFolders')) return false;
    
    const avatar = char?.avatar;
    const uniqueFolder = buildUniqueGalleryFolderName(char);
    
    if (!avatar || !uniqueFolder) {
        debugWarn('[GalleryFolder] Cannot register override - missing avatar or gallery_id');
        return false;
    }
    
    const success = setSTExtensionSetting('gallery.folders', avatar, uniqueFolder, immediate);
    
    if (success) {
        debugLog(`[GalleryFolder] Registered: ${avatar} -> ${uniqueFolder}${immediate ? ' (immediate save)' : ''}`);
    } else {
        debugWarn(`[GalleryFolder] Failed to register: ${avatar}`);
    }
    
    return success;
}

/**
 * Remove a gallery folder override for a character
 * @param {string} avatar - Character avatar filename
 */
function removeGalleryFolderOverride(avatar) {
    const context = getSTContext();
    if (!context?.extensionSettings?.gallery?.folders) return;
    
    if (context.extensionSettings.gallery.folders[avatar]) {
        delete context.extensionSettings.gallery.folders[avatar];
        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
            debugLog(`[GalleryFolder] Removed folder override for: ${avatar}`);
        }
    }
}

/**
 * Show or hide the per-character gallery ID warning on the Gallery tab.
 * Displays when uniqueGalleryFolders is enabled and the character has no gallery_id.
 * Wires up the 1-click "Assign ID" button to generate + save an ID immediately.
 * @param {object} char - Character object
 */
function updateGalleryIdWarning(char) {
    const warningEl = document.getElementById('galleryIdWarning');
    const assignBtn = document.getElementById('assignGalleryIdBtn');
    if (!warningEl || !assignBtn) return;

    const needsWarning = getSetting('uniqueGalleryFolders') && !getCharacterGalleryId(char);

    if (!needsWarning) {
        warningEl.classList.add('hidden');
        return;
    }

    warningEl.classList.remove('hidden');

    // Wire up the assign button (replace handler each time to capture current char)
    assignBtn.onclick = async () => {
        assignBtn.disabled = true;
        assignBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Assigning...';

        try {
            const galleryId = generateGalleryId();
            const success = await window.applyCardFieldUpdates(char.avatar, {
                'extensions.gallery_id': galleryId
            });

            if (success) {
                // Update local char object so subsequent reads see the new ID
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions.gallery_id = galleryId;

                // Register the folder override in ST settings
                registerGalleryFolderOverride(char, true);

                // Update gallery sync warning (audit may be stale)
                if (typeof window.auditGalleryIntegrity === 'function' &&
                    typeof window.updateGallerySyncWarning === 'function') {
                    const audit = window.auditGalleryIntegrity();
                    window.updateGallerySyncWarning(audit);
                }

                // Hide warning and refresh gallery with the new unique folder
                warningEl.classList.add('hidden');
                fetchCharacterImages(char);
                showToast(`Gallery ID assigned: ${galleryId}`, 'success');
            } else {
                showToast('Failed to assign gallery ID. Check console for details.', 'error');
            }
        } catch (err) {
            console.error('[GalleryIdWarning] Error assigning gallery_id:', err);
            showToast('Error assigning gallery ID.', 'error');
        } finally {
            assignBtn.disabled = false;
            assignBtn.innerHTML = '<i class="fa-solid fa-fingerprint"></i> Assign ID';
        }
    };
}

/**
 * Get all active gallery folder overrides from ST settings
 * @returns {Array<{avatar: string, folder: string, char: object|null}>}
 */
function getActiveGalleryFolderOverrides() {
    const context = getSTContext();
    if (!context?.extensionSettings?.gallery?.folders) return [];
    
    const overrides = [];
    const folders = context.extensionSettings.gallery.folders;
    
    for (const [avatar, folder] of Object.entries(folders)) {
        const char = allCharacters.find(c => c.avatar === avatar);
        overrides.push({ avatar, folder, char });
    }
    
    return overrides;
}

/**
 * Clear ALL gallery folder overrides from ST settings
 * @returns {{cleared: number}}
 */
function clearAllGalleryFolderOverrides() {
    const context = getSTContext();
    if (!context?.extensionSettings?.gallery?.folders) {
        return { cleared: 0 };
    }
    
    const count = Object.keys(context.extensionSettings.gallery.folders).length;
    context.extensionSettings.gallery.folders = {};
    
    if (typeof context.saveSettings === 'function') {
        context.saveSettings();
    }
    
    debugLog(`[GalleryFolder] Cleared all ${count} folder overrides`);
    return { cleared: count };
}

/**
 * Move all images from unique folders back to default (character name) folders
 * @param {function} progressCallback - Optional callback(current, total, charName)
 * @returns {Promise<{moved: number, errors: number, chars: number}>}
 */
async function moveImagesToDefaultFolders(progressCallback) {
    const overrides = getActiveGalleryFolderOverrides();
    const results = { moved: 0, errors: 0, chars: 0 };
    
    for (let i = 0; i < overrides.length; i++) {
        const { avatar, folder, char } = overrides[i];
        
        // Get the default folder name (just character name)
        const defaultFolder = char?.name || folder.split('_').slice(0, -1).join('_');
        
        if (!defaultFolder || folder === defaultFolder) {
            continue;
        }
        
        if (progressCallback) {
            progressCallback(i + 1, overrides.length, char?.name || avatar);
        }
        
        // List files in the unique folder
        try {
            const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folder, type: 7 });
            if (!response.ok) continue;
            
            const files = await response.json();
            if (!files || files.length === 0) continue;
            
            results.chars++;
            
            // Move each file
            for (const fileName of files) {
                const moveResult = await moveImageToFolder(folder, defaultFolder, fileName, true);
                if (moveResult.success) {
                    results.moved++;
                } else {
                    results.errors++;
                    debugWarn(`[GalleryFolder] Failed to move ${fileName}: ${moveResult.error}`);
                }
            }
        } catch (e) {
            debugError(`[GalleryFolder] Error processing ${folder}:`, e);
        }
    }
    
    return results;
}

/**
 * Show confirmation modal when disabling unique gallery folders
 * @param {function} onConfirm - Callback when user confirms (receives moveImages boolean)
 * @param {function} onCancel - Callback when user cancels
 */
function showDisableGalleryFoldersModal(onConfirm, onCancel) {
    const overrides = getActiveGalleryFolderOverrides();
    
    // If no overrides, just confirm immediately
    if (overrides.length === 0) {
        onConfirm(false);
        return;
    }
    
    const modalHtml = `
        <div id="disableGalleryFoldersModal" class="confirm-modal">
            <div class="confirm-modal-content" style="max-width: 500px;">
                <div class="confirm-modal-header">
                    <h3><i class="fa-solid fa-triangle-exclamation" style="color: #e74c3c;"></i> Disabling Unique Gallery Folders</h3>
                    <button class="close-confirm-btn" id="closeDisableGalleryModal">&times;</button>
                </div>
                <div class="confirm-modal-body">
                    <p>
                        Found <strong>${overrides.length}</strong> character(s) with active folder mappings in SillyTavern.
                    </p>
                    
                    <p style="color: var(--text-secondary);">
                        Disabling will remove folder mappings from ST settings. ST's gallery will revert to default behavior (folders by character name).
                    </p>
                    
                    <div style="background: rgba(231, 76, 60, 0.1); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                        <p style="margin: 0; font-size: 0.9em;">
                            <i class="fa-solid fa-info-circle"></i> Characters sharing the same name will share gallery folders again. Images in unique folders won't be accessible until moved.
                        </p>
                    </div>
                    
                    <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px;">
                        <label class="disable-gallery-option">
                            <input type="radio" name="disableOption" value="move" checked>
                            <div>
                                <strong>Move images to default folders first</strong>
                                <div style="font-size: 0.85em; color: var(--text-muted);">Recommended - keeps images accessible</div>
                            </div>
                        </label>
                        <label class="disable-gallery-option">
                            <input type="radio" name="disableOption" value="skip">
                            <div>
                                <strong>Disable without moving</strong>
                                <div style="font-size: 0.85em; color: var(--text-muted);">Recover later via "Browse Orphaned Folders"</div>
                            </div>
                        </label>
                    </div>
                    
                    <div id="disableGalleryProgress" style="display: none; margin-top: 15px;">
                        <div style="display: flex; align-items: center; gap: 10px; color: var(--accent);">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span id="disableGalleryProgressText">Moving images...</span>
                        </div>
                    </div>
                </div>
                <div class="confirm-modal-footer">
                    <button id="cancelDisableGallery" class="action-btn secondary">Cancel</button>
                    <button id="confirmDisableGallery" class="action-btn danger">Disable</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById('disableGalleryFoldersModal');
    const closeBtn = document.getElementById('closeDisableGalleryModal');
    const cancelBtn = document.getElementById('cancelDisableGallery');
    const confirmBtn = document.getElementById('confirmDisableGallery');
    const progressDiv = document.getElementById('disableGalleryProgress');
    const progressText = document.getElementById('disableGalleryProgressText');
    
    const closeModal = () => {
        modal.remove();
    };
    
    closeBtn.onclick = () => {
        closeModal();
        onCancel();
    };
    
    cancelBtn.onclick = () => {
        closeModal();
        onCancel();
    };
    
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeModal();
            onCancel();
        }
    };
    
    confirmBtn.onclick = async () => {
        const moveImages = document.querySelector('input[name="disableOption"]:checked')?.value === 'move';
        
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        
        if (moveImages) {
            progressDiv.style.display = 'block';
            
            const results = await moveImagesToDefaultFolders((current, total, charName) => {
                progressText.textContent = `Moving images... ${current}/${total} (${charName})`;
            });
            
            debugLog(`[GalleryFolder] Move results:`, results);
        }
        
        // Clear all overrides
        clearAllGalleryFolderOverrides();
        
        closeModal();
        onConfirm(moveImages);
    };
}

/**
 * Debug function to verify gallery folder overrides are properly set in ST
 * @returns {{total: number, registered: number, missing: Array<string>}}
 */
function verifyGalleryFolderOverrides() {
    const context = getSTContext();
    const results = { total: 0, registered: 0, missing: [] };
    
    if (!context?.extensionSettings?.gallery?.folders) {
        debugWarn('[GalleryFolder] Cannot verify - ST context or gallery settings unavailable');
        return results;
    }
    
    const folders = context.extensionSettings.gallery.folders;
    
    for (const char of allCharacters) {
        const galleryId = getCharacterGalleryId(char);
        if (!galleryId) continue;
        
        results.total++;
        const expectedFolder = buildUniqueGalleryFolderName(char);
        const actualFolder = folders[char.avatar];
        
        if (actualFolder === expectedFolder) {
            results.registered++;
        } else {
            results.missing.push(`${char.name} (${char.avatar})`);
        }
    }
    
    debugLog(`[GalleryFolder] Verification: ${results.registered}/${results.total} overrides set`);
    
    return results;
}

/**
 * Sync all gallery folder overrides to ST - call this manually if overrides aren't working
 * This will register ALL characters with gallery_id to ST's settings
 * @returns {{success: number, failed: number, skipped: number}}
 */
function syncAllGalleryFolderOverrides() {
    if (!getSetting('uniqueGalleryFolders')) {
        return { success: 0, failed: 0, skipped: 0, error: 'Feature disabled' };
    }
    
    // Test cross-window access
    if (!verifyContextAccess()) {
        return { success: 0, failed: 0, skipped: 0, error: 'Cross-window access failed' };
    }
    
    const results = { success: 0, failed: 0, skipped: 0 };
    const charsWithGalleryId = allCharacters.filter(c => getCharacterGalleryId(c));
    
    for (const char of charsWithGalleryId) {
        const uniqueFolder = buildUniqueGalleryFolderName(char);
        if (!uniqueFolder) {
            results.skipped++;
            continue;
        }
        
        if (setSTExtensionSetting('gallery.folders', char.avatar, uniqueFolder)) {
            results.success++;
        } else {
            results.failed++;
        }
    }
    
    // Trigger an immediate save
    const ctx = getSTContext();
    if (typeof ctx?.saveSettings === 'function') {
        ctx.saveSettings();
    }
    
    debugLog(`[GalleryFolder] Sync complete: ${results.success} success, ${results.failed} failed, ${results.skipped} skipped`);
    
    return results;
}

// Expose for console access (useful for manual sync after migration)
window.syncAllGalleryFolderOverrides = syncAllGalleryFolderOverrides;

/**
 * Show a modal with folder mappings for characters sharing the same name
 * Helps users manually move unmatched images to the correct unique folder
 */
function showFolderMappingModal() {
    // Find characters with shared names
    const sharedNames = findCharactersWithSharedNames();
    
    // Also get all characters with gallery IDs for reference
    const charsWithGalleryIds = allCharacters.filter(c => getCharacterGalleryId(c));
    
    // Get orphaned mappings if gallery-sync module is available
    let orphanedMappings = [];
    if (typeof window.auditGalleryIntegrity === 'function') {
        const audit = window.auditGalleryIntegrity();
        orphanedMappings = audit.orphanedMappings || [];
    }
    
    // Build modal content
    let contentHtml = '';
    
    // Show orphaned mappings first (issues that need attention)
    if (orphanedMappings.length > 0) {
        contentHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 10px 0; color: #e74c3c; display: flex; align-items: center; gap: 8px;">
                    <i class="fa-solid fa-ghost"></i>
                    Orphaned Mappings (${orphanedMappings.length})
                </h4>
                <p style="color: var(--text-muted); font-size: 0.85em; margin-bottom: 15px;">
                    These folder mappings point to characters that no longer exist. They can be safely removed with "Cleanup Orphans" in Integrity Check.
                </p>
                <div style="max-height: 200px; overflow-y: auto; background: rgba(231, 76, 60, 0.05); border: 1px solid rgba(231, 76, 60, 0.2); border-radius: 6px; padding: 10px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
                        <thead>
                            <tr style="color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.1);">
                                <th style="text-align: left; padding: 6px;">Avatar (deleted)</th>
                                <th style="text-align: left; padding: 6px;">Folder Mapping</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${orphanedMappings.map(({ avatar, folder }) => `
                                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                    <td style="padding: 6px; color: #e74c3c; font-family: monospace; font-size: 0.85em;">${escapeHtml(avatar)}</td>
                                    <td style="padding: 6px;"><code style="background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 3px; font-size: 0.9em;">${escapeHtml(folder)}</code></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }
    
    if (sharedNames.size === 0 && charsWithGalleryIds.length === 0 && orphanedMappings.length === 0) {
        contentHtml = `
            <div class="empty-state" style="padding: 30px; text-align: center;">
                <i class="fa-solid fa-folder-open" style="font-size: 48px; color: var(--text-secondary); margin-bottom: 15px;"></i>
                <p style="color: var(--text-secondary);">No characters have unique gallery IDs assigned yet.</p>
                <p style="color: var(--text-muted); font-size: 0.9em;">Run "Assign Gallery IDs to All Characters" first.</p>
            </div>
        `;
    } else {
        // Show shared name groups first (most relevant for manual moves)
        if (sharedNames.size > 0) {
            contentHtml += `
                <div style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-users" style="color: #e74c3c;"></i>
                        Characters Sharing Names (${sharedNames.size} groups)
                    </h4>
                    <p style="color: var(--text-muted); font-size: 0.85em; margin-bottom: 15px;">
                        These characters share the same name. Use this reference to move unmatched images from the old shared folder to the correct unique folder.
                    </p>
            `;
            
            for (const [name, chars] of sharedNames) {
                contentHtml += `
                    <div style="background: rgba(231, 76, 60, 0.1); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
                        <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 8px;">
                            <i class="fa-solid fa-folder" style="color: #f39c12;"></i> 
                            Old shared folder: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px;">${escapeHtml(name)}</code>
                        </div>
                        <div style="margin-left: 20px;">
                            ${chars.map(char => {
                                const galleryId = getCharacterGalleryId(char);
                                const uniqueFolder = buildUniqueGalleryFolderName(char);
                                const chubInfo = getChubLinkInfo(char);
                                const chubLabel = chubInfo?.id ? ` <span style="color: #3498db; font-size: 0.8em;">(${chubInfo.id})</span>` : '';
                                return `
                                    <div style="margin: 6px 0; padding: 6px 8px; background: rgba(255,255,255,0.05); border-radius: 4px;">
                                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                            <img src="${getCharacterAvatarUrl(char.avatar)}" 
                                                 style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover;"
                                                 onerror="this.src='/img/ai4.png'">
                                            <span style="color: var(--text-primary);">${escapeHtml(char.name)}${chubLabel}</span>
                                            <i class="fa-solid fa-arrow-right" style="color: var(--text-muted);"></i>
                                            <code style="background: rgba(46, 204, 113, 0.2); color: #2ecc71; padding: 2px 6px; border-radius: 3px; font-size: 0.85em;">${uniqueFolder || '(no ID)'}</code>
                                            <button class="copy-folder-btn" data-folder="${escapeHtml(uniqueFolder || '')}" title="Copy folder name" style="background: none; border: none; cursor: pointer; color: var(--text-muted); padding: 4px;">
                                                <i class="fa-solid fa-copy"></i>
                                            </button>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
            contentHtml += `</div>`;
        }
        
        // Show all other characters with unique folders (collapsed by default)
        const otherChars = charsWithGalleryIds.filter(c => {
            // Exclude chars that are in sharedNames groups
            for (const [_, chars] of sharedNames) {
                if (chars.some(sc => sc.avatar === c.avatar)) return false;
            }
            return true;
        });
        
        if (otherChars.length > 0) {
            contentHtml += `
                <details style="margin-top: 15px;">
                    <summary style="cursor: pointer; color: var(--text-primary); padding: 8px; background: rgba(255,255,255,0.03); border-radius: 6px;">
                        <i class="fa-solid fa-folder-tree"></i> 
                        All Other Characters with Unique Folders (${otherChars.length})
                    </summary>
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 6px;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
                            <thead>
                                <tr style="color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.1);">
                                    <th style="text-align: left; padding: 6px;">Character</th>
                                    <th style="text-align: left; padding: 6px;">Unique Folder</th>
                                    <th style="width: 40px;"></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${otherChars.map(char => {
                                    const uniqueFolder = buildUniqueGalleryFolderName(char);
                                    return `
                                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                                            <td style="padding: 6px; color: var(--text-primary);">${escapeHtml(char.name)}</td>
                                            <td style="padding: 6px;"><code style="background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 3px; font-size: 0.9em;">${uniqueFolder}</code></td>
                                            <td style="padding: 6px;">
                                                <button class="copy-folder-btn" data-folder="${escapeHtml(uniqueFolder || '')}" title="Copy" style="background: none; border: none; cursor: pointer; color: var(--text-muted); padding: 2px;">
                                                    <i class="fa-solid fa-copy"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </details>
            `;
        }
    }
    
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'folderMappingModal';
    modal.innerHTML = `
        <div class="confirm-modal-content" style="max-width: 700px; max-height: 80vh;">
            <div class="confirm-modal-header">
                <h3 style="border: none; padding: 0; margin: 0;">
                    <i class="fa-solid fa-map"></i> Gallery Folder Mapping
                </h3>
                <button class="close-confirm-btn" id="closeFolderMappingModal">&times;</button>
            </div>
            <div class="confirm-modal-body" style="max-height: 60vh; overflow-y: auto;">
                <div style="background: rgba(52, 152, 219, 0.1); border: 1px solid rgba(52, 152, 219, 0.3); border-radius: 6px; padding: 10px; margin-bottom: 15px;">
                    <p style="margin: 0; color: var(--text-secondary); font-size: 0.9em;">
                        <i class="fa-solid fa-lightbulb" style="color: #f39c12;"></i>
                        <strong>Tip:</strong> Gallery images are stored in <code style="background: rgba(0,0,0,0.2); padding: 2px 4px; border-radius: 3px;">data/default-user/images/</code>
                        <br>Move files from the old <code>CharName</code> folder to the new <code>CharName_abc123xyz</code> folder.
                    </p>
                </div>
                ${contentHtml}
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn primary" id="closeFolderMappingBtn">
                    <i class="fa-solid fa-check"></i> Done
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Setup close handlers
    const closeModal = () => modal.remove();
    document.getElementById('closeFolderMappingModal').onclick = closeModal;
    document.getElementById('closeFolderMappingBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Setup copy buttons with fallback for non-secure contexts
    modal.querySelectorAll('.copy-folder-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const folder = btn.dataset.folder;
            if (folder) {
                let success = false;
                try {
                    // Try modern Clipboard API first
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(folder);
                        success = true;
                    }
                } catch (err) {
                    // Clipboard API failed, try fallback
                }
                
                // Fallback: use execCommand (works in more contexts)
                if (!success) {
                    try {
                        const textarea = document.createElement('textarea');
                        textarea.value = folder;
                        textarea.style.position = 'fixed';
                        textarea.style.opacity = '0';
                        document.body.appendChild(textarea);
                        textarea.select();
                        success = document.execCommand('copy');
                        document.body.removeChild(textarea);
                    } catch (err2) {
                        // Both methods failed
                    }
                }
                
                if (success) {
                    btn.innerHTML = '<i class="fa-solid fa-check" style="color: #2ecc71;"></i>';
                    setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1500);
                } else {
                    showToast('Failed to copy to clipboard', 'error');
                }
            }
        };
    });
}

/**
 * Scan for orphaned gallery folders (folders that exist but don't match any character's unique folder)
 * These are typically old-style folders or leftover folders from deleted characters
 * @returns {Promise<Array<{name: string, files: string[], isLegacy: boolean, matchingChars: Array}>>}
 */
async function scanOrphanedGalleryFolders() {
    // Build a set of all "valid" folder names:
    // 1. Unique folder names (CharName_uuid) for characters with gallery_id
    // 2. Character names for characters without gallery_id (if unique folders disabled)
    const validFolders = new Set();
    const uniqueFolderToChar = new Map(); // Map unique folder name -> character
    
    for (const char of allCharacters) {
        if (!char.name) continue;
        
        const uniqueFolder = buildUniqueGalleryFolderName(char);
        if (uniqueFolder) {
            validFolders.add(uniqueFolder);
            uniqueFolderToChar.set(uniqueFolder, char);
        }
        // Also mark plain name as potentially valid if any char uses it
        validFolders.add(char.name);
    }
    
    // Now scan all character names to find folders that might have images
    // We'll check both plain names and try to discover any _uuid folders
    const potentialFolders = new Set();
    
    // Add all character names as potential folders to check
    for (const char of allCharacters) {
        if (char.name) {
            potentialFolders.add(char.name);
        }
    }
    
    // Check each potential folder for images
    const orphanedFolders = [];
    
    for (const folderName of potentialFolders) {
        try {
            const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { 
                folder: folderName, 
                type: 7 
            });
            
            if (!response.ok) continue;
            
            const files = await response.json();
            if (!files || files.length === 0) continue;
            
            const fileNames = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
            if (fileNames.length === 0) continue;
            
            // Check if this folder is a "legacy" folder (not a unique folder)
            const isUniqueFolder = folderName.match(/_[a-zA-Z0-9]{12}$/);
            
            // Find characters that share this name
            const matchingChars = allCharacters.filter(c => c.name === folderName);
            
            // A folder is "orphaned" if:
            // 1. It's a plain name folder AND there are characters with unique folders that should use a different folder
            // 2. It doesn't match any character's current unique folder
            
            const isOrphaned = !isUniqueFolder && matchingChars.some(c => {
                const uniqueFolder = buildUniqueGalleryFolderName(c);
                return uniqueFolder && uniqueFolder !== folderName;
            });
            
            if (isOrphaned || !matchingChars.length) {
                orphanedFolders.push({
                    name: folderName,
                    files: fileNames,
                    isLegacy: !isUniqueFolder,
                    matchingChars: matchingChars
                });
            }
        } catch (e) {
            debugLog(`[OrphanedFolders] Error checking folder ${folderName}:`, e);
        }
    }
    
    return orphanedFolders;
}

/**
 * Show a modal for browsing and redistributing orphaned folder contents
 */
async function showOrphanedFoldersModal() {
    // Create initial modal with loading state
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'orphanedFoldersModal';
    modal.innerHTML = `
        <div class="confirm-modal-content orphaned-folders-modal">
            <div class="confirm-modal-header">
                <h3 style="border: none; padding: 0; margin: 0;">
                    <i class="fa-solid fa-folder-open"></i> Browse Orphaned Folders
                </h3>
                <button class="close-confirm-btn" id="closeOrphanedFoldersModal">&times;</button>
            </div>
            <div class="confirm-modal-body" id="orphanedFoldersBody" style="min-width: 600px; min-height: 300px;">
                <div class="loading-spinner">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <p>Scanning for orphaned folders...</p>
                </div>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="closeOrphanedFoldersBtn">
                    <i class="fa-solid fa-xmark"></i> Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Setup close handlers
    const closeModal = () => modal.remove();
    document.getElementById('closeOrphanedFoldersModal').onclick = closeModal;
    document.getElementById('closeOrphanedFoldersBtn').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Escape key handler
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
    
    // Scan for orphaned folders
    const orphanedFolders = await scanOrphanedGalleryFolders();
    const body = document.getElementById('orphanedFoldersBody');
    
    if (orphanedFolders.length === 0) {
        body.innerHTML = `
            <div class="empty-state" style="padding: 40px; text-align: center;">
                <i class="fa-solid fa-check-circle" style="font-size: 48px; color: #2ecc71; margin-bottom: 15px;"></i>
                <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">No Orphaned Folders Found</h4>
                <p style="color: var(--text-secondary); margin: 0;">
                    All gallery folders are properly associated with characters.
                </p>
            </div>
        `;
        return;
    }
    
    // Build list of available destination characters (those with unique folders)
    const destinationChars = allCharacters
        .filter(c => getCharacterGalleryId(c))
        .sort((a, b) => a.name.localeCompare(b.name));
    
    // Render folder selector and content area
    body.innerHTML = `
        <div class="orphaned-folders-info">
            <i class="fa-solid fa-info-circle"></i>
            <span>Found <strong>${orphanedFolders.length}</strong> legacy folder(s) with images. Select a folder to view its contents, then choose images to move to a character's unique folder.</span>
        </div>
        
        <div class="orphaned-folders-layout">
            <div class="orphaned-folders-list">
                <div class="orphaned-folders-list-header">
                    <i class="fa-solid fa-folder"></i> Legacy Folders
                </div>
                <div class="orphaned-folders-list-items">
                    ${orphanedFolders.map((folder, idx) => `
                        <div class="orphaned-folder-item ${idx === 0 ? 'active' : ''}" data-folder="${escapeHtml(folder.name)}">
                            <div class="orphaned-folder-name">
                                <i class="fa-solid fa-folder" style="color: #f39c12;"></i>
                                ${escapeHtml(folder.name)}
                            </div>
                            <div class="orphaned-folder-count">${folder.files.length} file${folder.files.length !== 1 ? 's' : ''}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            
            <div class="orphaned-folders-content">
                <div class="orphaned-content-header">
                    <div class="orphaned-content-title">
                        <span id="orphanedCurrentFolder">${escapeHtml(orphanedFolders[0].name)}</span>
                        <span class="orphaned-file-count" id="orphanedFileCount">${orphanedFolders[0].files.length} files</span>
                    </div>
                    <div class="orphaned-content-actions">
                        <button class="action-btn small" id="orphanedClearDuplicatesBtn" title="Remove files that already exist in a unique folder">
                            <i class="fa-solid fa-broom"></i> Clear Duplicates
                        </button>
                        <label class="orphaned-select-all">
                            <input type="checkbox" id="orphanedSelectAll">
                            <span>Select All</span>
                        </label>
                    </div>
                </div>
                
                <div class="orphaned-images-grid" id="orphanedImagesGrid">
                    <!-- Images will be rendered here -->
                </div>
                
                <div class="orphaned-move-section" id="orphanedMoveSection" style="display: none;">
                    <div class="orphaned-move-header">
                        <i class="fa-solid fa-truck-moving"></i>
                        Move <span id="orphanedSelectedCount">0</span> selected image(s) to:
                    </div>
                    <div class="orphaned-destination-picker">
                        <div class="orphaned-search-wrapper">
                            <i class="fa-solid fa-search"></i>
                            <input type="text" id="orphanedDestSearch" placeholder="Search characters..." autocomplete="off">
                        </div>
                        <div class="orphaned-destination-list" id="orphanedDestList">
                            ${destinationChars.map(char => {
                                const uniqueFolder = buildUniqueGalleryFolderName(char);
                                const chubInfo = getChubLinkInfo(char);
                                const chubLabel = chubInfo?.id ? `<span class="dest-chub-id">${chubInfo.id}</span>` : '';
                                return `
                                    <div class="orphaned-dest-item" data-avatar="${escapeHtml(char.avatar)}" data-folder="${escapeHtml(uniqueFolder)}" data-name="${escapeHtml(char.name.toLowerCase())}">
                                        <img src="${getCharacterAvatarUrl(char.avatar)}" class="dest-avatar" onerror="this.src='${FALLBACK_AVATAR_SVG}'">
                                        <div class="dest-info">
                                            <div class="dest-name">${escapeHtml(char.name)} ${chubLabel}</div>
                                            <div class="dest-folder">${escapeHtml(uniqueFolder)}</div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Store current state
    let currentFolder = orphanedFolders[0];
    let selectedFiles = new Set();
    
    // Render images for current folder
    function renderFolderImages(folder) {
        currentFolder = folder;
        selectedFiles.clear();
        
        const grid = document.getElementById('orphanedImagesGrid');
        const safeFolderName = sanitizeFolderName(folder.name);
        
        document.getElementById('orphanedCurrentFolder').textContent = folder.name;
        document.getElementById('orphanedFileCount').textContent = `${folder.files.length} files`;
        document.getElementById('orphanedSelectAll').checked = false;
        
        // Pre-fill destination search with folder name to show relevant characters first
        const destSearch = document.getElementById('orphanedDestSearch');
        if (destSearch) {
            destSearch.value = folder.name;
            // Trigger filtering
            const query = folder.name.toLowerCase().trim();
            document.querySelectorAll('.orphaned-dest-item').forEach(item => {
                const name = item.dataset.name || '';
                const itemFolder = item.dataset.folder?.toLowerCase() || '';
                const matches = !query || name.includes(query) || itemFolder.includes(query);
                item.style.display = matches ? '' : 'none';
            });
        }
        
        grid.innerHTML = folder.files.map(fileName => {
            // Check if it's an image file
            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
            const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext);
            const isVideo = ['mp4', 'webm', 'mov', 'avi'].includes(ext);
            
            let previewHtml;
            if (isImage) {
                previewHtml = `<img src="/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}" 
                     loading="lazy"
                     onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'orphaned-file-icon\\'><i class=\\'fa-solid fa-image\\'></i></div>';">`;
            } else if (isAudio) {
                previewHtml = `<div class="orphaned-file-icon audio"><i class="fa-solid fa-music"></i></div>`;
            } else if (isVideo) {
                previewHtml = `<div class="orphaned-file-icon video"><i class="fa-solid fa-video"></i></div>`;
            } else {
                previewHtml = `<div class="orphaned-file-icon"><i class="fa-solid fa-file"></i></div>`;
            }
            
            return `
            <div class="orphaned-image-item" data-filename="${escapeHtml(fileName)}">
                ${previewHtml}
                <div class="orphaned-image-checkbox">
                    <input type="checkbox" class="orphaned-file-checkbox" data-filename="${escapeHtml(fileName)}">
                </div>
                <div class="orphaned-image-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
            </div>`;
        }).join('');
        
        // Bind checkbox events
        grid.querySelectorAll('.orphaned-image-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const checkbox = item.querySelector('.orphaned-file-checkbox');
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });
        });
        
        grid.querySelectorAll('.orphaned-file-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const filename = checkbox.dataset.filename;
                if (checkbox.checked) {
                    selectedFiles.add(filename);
                    checkbox.closest('.orphaned-image-item').classList.add('selected');
                } else {
                    selectedFiles.delete(filename);
                    checkbox.closest('.orphaned-image-item').classList.remove('selected');
                }
                updateMoveSection();
            });
        });
        
        updateMoveSection();
    }
    
    // Update move section visibility and count
    function updateMoveSection() {
        const moveSection = document.getElementById('orphanedMoveSection');
        const countSpan = document.getElementById('orphanedSelectedCount');
        
        if (selectedFiles.size > 0) {
            moveSection.style.display = 'block';
            countSpan.textContent = selectedFiles.size;
        } else {
            moveSection.style.display = 'none';
        }
        
        // Update select all checkbox state
        const selectAllCheckbox = document.getElementById('orphanedSelectAll');
        selectAllCheckbox.checked = selectedFiles.size === currentFolder.files.length && currentFolder.files.length > 0;
        selectAllCheckbox.indeterminate = selectedFiles.size > 0 && selectedFiles.size < currentFolder.files.length;
    }
    
    // Initial render
    renderFolderImages(orphanedFolders[0]);
    
    // Folder list click handler
    body.querySelectorAll('.orphaned-folder-item').forEach(item => {
        item.addEventListener('click', () => {
            body.querySelectorAll('.orphaned-folder-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            
            const folderName = item.dataset.folder;
            const folder = orphanedFolders.find(f => f.name === folderName);
            if (folder) {
                renderFolderImages(folder);
            }
        });
    });
    
    // Select all handler
    document.getElementById('orphanedSelectAll').addEventListener('change', (e) => {
        const checkAll = e.target.checked;
        document.querySelectorAll('.orphaned-file-checkbox').forEach(checkbox => {
            checkbox.checked = checkAll;
            const filename = checkbox.dataset.filename;
            if (checkAll) {
                selectedFiles.add(filename);
                checkbox.closest('.orphaned-image-item').classList.add('selected');
            } else {
                selectedFiles.delete(filename);
                checkbox.closest('.orphaned-image-item').classList.remove('selected');
            }
        });
        updateMoveSection();
    });
    
    // Clear Duplicates handler - processes ALL orphaned folders
    document.getElementById('orphanedClearDuplicatesBtn').addEventListener('click', async () => {
        const btn = document.getElementById('orphanedClearDuplicatesBtn');
        const originalHtml = btn.innerHTML;
        
        // Confirm since this affects all folders
        if (!confirm(`Clear Duplicates\n\nThis will scan ALL ${orphanedFolders.length} orphaned folder(s) and remove any files that already exist in their matching unique folders.\n\nContinue?`)) {
            return;
        }
        
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        btn.disabled = true;
        
        let totalDeleted = 0;
        let totalKept = 0;
        let foldersProcessed = 0;
        let foldersCleared = 0;
        
        try {
            for (const folder of [...orphanedFolders]) {
                foldersProcessed++;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Folder ${foldersProcessed}/${orphanedFolders.length}...`;
                
                // Find all unique folders that match this base name
                const baseName = folder.name;
                const matchingChars = allCharacters.filter(c => c.name === baseName && getCharacterGalleryId(c));
                const matchingUniqueFolders = matchingChars
                    .map(c => buildUniqueGalleryFolderName(c))
                    .filter(f => f);
                
                console.log(`[ClearDuplicates] Folder "${baseName}": found ${matchingChars.length} matching chars, ${matchingUniqueFolders.length} unique folders:`, matchingUniqueFolders);
                
                if (matchingUniqueFolders.length === 0) {
                    // No matching unique folders - keep all files
                    console.log(`[ClearDuplicates] No unique folders found for "${baseName}", keeping ${folder.files.length} files`);
                    totalKept += folder.files.length;
                    continue;
                }
                
                // Build hash set AND filename set from all matching unique folders
                const uniqueFolderHashes = new Set();
                const uniqueFolderFilenames = new Set();
                for (const uniqueFolder of matchingUniqueFolders) {
                    const folderHashes = await scanFolderForImageHashes(uniqueFolder);
                    console.log(`[ClearDuplicates] Scanned "${uniqueFolder}": ${folderHashes.size} hashes`);
                    for (const [hash, fileName] of folderHashes) {
                        uniqueFolderHashes.add(hash);
                        uniqueFolderFilenames.add(fileName);
                    }
                }
                
                console.log(`[ClearDuplicates] Total unique hashes: ${uniqueFolderHashes.size}, filenames: ${uniqueFolderFilenames.size}`);
                
                if (uniqueFolderHashes.size === 0 && uniqueFolderFilenames.size === 0) {
                    totalKept += folder.files.length;
                    continue;
                }
                
                // Hash files in orphaned folder and find duplicates (by hash OR filename)
                const safeFolderName = sanitizeFolderName(folder.name);
                let folderDeleted = 0;
                
                for (const fileName of folder.files) {
                    // First check filename match (fast, handles re-encoded files)
                    if (uniqueFolderFilenames.has(fileName)) {
                        console.log(`[ClearDuplicates] File "${fileName}" - DUPLICATE (filename match)`);
                        const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                        await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                        folderDeleted++;
                        totalDeleted++;
                        continue;
                    }
                    
                    // Then check hash match
                    const localPath = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
                    
                    try {
                        const fileResponse = await fetch(localPath);
                        if (fileResponse.ok) {
                            const buffer = await fileResponse.arrayBuffer();
                            const hash = await calculateHash(buffer);
                            
                            const isDuplicate = uniqueFolderHashes.has(hash);
                            console.log(`[ClearDuplicates] File "${fileName}" hash: ${hash.substring(0, 16)}... isDuplicate: ${isDuplicate}`);
                            
                            if (isDuplicate) {
                                // Duplicate found - delete from orphaned folder
                                const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                                await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
                                folderDeleted++;
                                totalDeleted++;
                            } else {
                                totalKept++;
                            }
                        } else {
                            console.warn(`[ClearDuplicates] Could not fetch file "${fileName}": ${fileResponse.status}`);
                            totalKept++;
                        }
                    } catch (e) {
                        console.warn(`[ClearDuplicates] Error processing ${fileName}:`, e);
                        totalKept++;
                    }
                }
                
                // Update folder's file list
                if (folderDeleted > 0) {
                    const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folder.name, type: 7 });
                    if (response.ok) {
                        const files = await response.json();
                        folder.files = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);
                    }
                    
                    if (folder.files.length === 0) {
                        foldersCleared++;
                    }
                }
            }
            
            // Remove cleared folders from the list and update UI
            const remainingFolders = orphanedFolders.filter(f => f.files.length > 0);
            orphanedFolders.length = 0;
            orphanedFolders.push(...remainingFolders);
            
            if (orphanedFolders.length === 0) {
                // All folders cleared
                body.innerHTML = `
                    <div class="empty-state" style="padding: 40px; text-align: center;">
                        <i class="fa-solid fa-check-circle" style="font-size: 48px; color: #2ecc71; margin-bottom: 15px;"></i>
                        <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                        <p style="color: var(--text-secondary); margin: 0;">
                            Cleared ${totalDeleted} duplicate file(s) from ${foldersCleared} folder(s).
                        </p>
                    </div>
                `;
            } else {
                // Update sidebar folder list
                const folderListItems = body.querySelector('.orphaned-folders-list-items');
                if (folderListItems) {
                    folderListItems.innerHTML = orphanedFolders.map((folder, idx) => `
                        <div class="orphaned-folder-item ${idx === 0 ? 'active' : ''}" data-folder="${escapeHtml(folder.name)}">
                            <div class="orphaned-folder-name">
                                <i class="fa-solid fa-folder" style="color: #f39c12;"></i>
                                ${escapeHtml(folder.name)}
                            </div>
                            <div class="orphaned-folder-count">${folder.files.length} file${folder.files.length !== 1 ? 's' : ''}</div>
                        </div>
                    `).join('');
                    
                    // Re-bind folder click handlers
                    folderListItems.querySelectorAll('.orphaned-folder-item').forEach(item => {
                        item.addEventListener('click', () => {
                            folderListItems.querySelectorAll('.orphaned-folder-item').forEach(i => i.classList.remove('active'));
                            item.classList.add('active');
                            
                            const folderName = item.dataset.folder;
                            const folder = orphanedFolders.find(f => f.name === folderName);
                            if (folder) {
                                renderFolderImages(folder);
                            }
                        });
                    });
                }
                
                // Re-render current folder (select first one)
                currentFolder = orphanedFolders[0];
                renderFolderImages(currentFolder);
                
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
            
            showToast(`Cleared ${totalDeleted} duplicate(s) from ${foldersProcessed} folder(s), ${totalKept} unique file(s) remain`, totalDeleted > 0 ? 'success' : 'info');
            
        } catch (error) {
            console.error('[ClearDuplicates] Error:', error);
            showToast('Error clearing duplicates: ' + error.message, 'error');
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    });
    
    // Destination search handler
    document.getElementById('orphanedDestSearch').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        document.querySelectorAll('.orphaned-dest-item').forEach(item => {
            const name = item.dataset.name || '';
            const folder = item.dataset.folder?.toLowerCase() || '';
            const matches = !query || name.includes(query) || folder.includes(query);
            item.style.display = matches ? '' : 'none';
        });
    });
    
    // Destination click handler - move files
    body.querySelectorAll('.orphaned-dest-item').forEach(destItem => {
        destItem.addEventListener('click', async () => {
            if (selectedFiles.size === 0) {
                showToast('No files selected', 'error');
                return;
            }
            
            const destFolder = destItem.dataset.folder;
            const destName = destItem.querySelector('.dest-name').textContent.trim();
            
            // Confirm move
            if (!confirm(`Move ${selectedFiles.size} file(s) to "${destName}"?\n\nDestination folder: ${destFolder}`)) {
                return;
            }
            
            // Show progress
            const moveBtn = destItem;
            const originalHtml = moveBtn.innerHTML;
            moveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Moving...';
            moveBtn.style.pointerEvents = 'none';
            
            let moved = 0;
            let errors = 0;
            
            for (const fileName of selectedFiles) {
                const result = await moveImageToFolder(currentFolder.name, destFolder, fileName, true);
                if (result.success) {
                    moved++;
                } else {
                    errors++;
                    debugLog(`[OrphanedFolders] Error moving ${fileName}:`, result.error);
                }
            }
            
            moveBtn.innerHTML = originalHtml;
            moveBtn.style.pointerEvents = '';
            
            // Show result
            if (errors === 0) {
                showToast(`Moved ${moved} file(s) successfully`, 'success');
            } else {
                showToast(`Moved ${moved} file(s), ${errors} error(s)`, 'error');
            }
            
            // Refresh folder contents
            const updatedFiles = currentFolder.files.filter(f => !selectedFiles.has(f));
            currentFolder.files = updatedFiles;
            
            // Update folder item count
            const folderItem = body.querySelector(`.orphaned-folder-item[data-folder="${escapeHtml(currentFolder.name)}"]`);
            if (folderItem) {
                const countEl = folderItem.querySelector('.orphaned-folder-count');
                if (countEl) {
                    countEl.textContent = `${updatedFiles.length} file${updatedFiles.length !== 1 ? 's' : ''}`;
                }
                
                // Remove folder from list if empty
                if (updatedFiles.length === 0) {
                    folderItem.remove();
                    
                    // Select next folder or show empty state
                    const remainingFolders = body.querySelectorAll('.orphaned-folder-item');
                    if (remainingFolders.length > 0) {
                        remainingFolders[0].click();
                    } else {
                        body.innerHTML = `
                            <div class="empty-state" style="padding: 40px; text-align: center;">
                                <i class="fa-solid fa-check-circle" style="font-size: 48px; color: #2ecc71; margin-bottom: 15px;"></i>
                                <h4 style="color: var(--text-primary); margin: 0 0 10px 0;">All Done!</h4>
                                <p style="color: var(--text-secondary); margin: 0;">
                                    All orphaned folder contents have been redistributed.
                                </p>
                            </div>
                        `;
                    }
                    return;
                }
            }
            
            // Re-render images
            renderFolderImages(currentFolder);
        });
    });
}

/**
 * Get the gallery folder name to use for API calls
 * Returns unique folder if enabled and available, otherwise falls back to character name
 * @param {object} char - Character object
 * @returns {string} The folder name to use for ch_name parameter
 */
function getGalleryFolderName(char) {
    if (!char?.name) return '';
    
    // If unique folders disabled, use standard name
    if (!getSetting('uniqueGalleryFolders')) {
        return char.name;
    }
    
    // Try to use unique folder name
    const uniqueFolder = buildUniqueGalleryFolderName(char);
    if (uniqueFolder) {
        return uniqueFolder;
    }
    
    // Fallback to standard name if no gallery_id
    return char.name;
}

/**
 * Resolve the gallery folder name from various inputs
 * Use this when you might have a character object, avatar filename, or just a name
 * @param {object|string} charOrNameOrAvatar - Character object, avatar filename, or character name
 * @returns {string} The folder name to use for ch_name parameter
 */
function resolveGalleryFolderName(charOrNameOrAvatar) {
    // If it's a character object, use getGalleryFolderName directly
    if (charOrNameOrAvatar && typeof charOrNameOrAvatar === 'object' && charOrNameOrAvatar.name) {
        return getGalleryFolderName(charOrNameOrAvatar);
    }
    
    // It's a string - could be avatar or name
    const str = String(charOrNameOrAvatar);
    
    // Try to find character by avatar
    const charByAvatar = allCharacters.find(c => c.avatar === str);
    if (charByAvatar) {
        return getGalleryFolderName(charByAvatar);
    }
    
    // Try to find character by name (only if exactly one match)
    const charsByName = allCharacters.filter(c => c.name === str);
    if (charsByName.length === 1) {
        return getGalleryFolderName(charsByName[0]);
    }
    
    // Multiple matches or no matches - return the string as-is
    // For multiple matches with same name, they need to use unique folders
    // to avoid mixing. Since we can't determine which one, use the shared name.
    return str;
}

/**
 * Assign a gallery_id to a character and save it
 * Only works when uniqueGalleryFolders setting is enabled
 * @param {object} char - Character object to update
 * @returns {Promise<{success: boolean, galleryId: string|null, error?: string}>}
 */
async function assignGalleryIdToCharacter(char) {
    // Feature must be enabled
    if (!getSetting('uniqueGalleryFolders')) {
        return { success: false, galleryId: null, error: 'Feature disabled' };
    }
    
    if (!char || !char.avatar) {
        return { success: false, galleryId: null, error: 'Invalid character' };
    }
    
    // Check if already has gallery_id
    if (getCharacterGalleryId(char)) {
        debugLog(`[GalleryFolder] Character already has gallery_id: ${char.name}`);
        return { success: true, galleryId: getCharacterGalleryId(char) };
    }
    
    // Generate new ID
    const galleryId = generateGalleryId();
    
    // Prepare the extensions update
    const existingExtensions = char.data?.extensions || {};
    const updatedExtensions = {
        ...existingExtensions,
        gallery_id: galleryId
    };
    
    try {
        // Save to character via merge-attributes API
        // IMPORTANT: Spread existing data to avoid wiping other fields
        const existingData = char.data || {};
        const payload = {
            avatar: char.avatar,
            create_date: char.create_date,
            data: {
                ...existingData,
                extensions: updatedExtensions,
                create_date: char.create_date
            }
        };
        
        const response = await apiRequest('/characters/merge-attributes', 'POST', payload);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error: ${errorText}`);
        }
        
        // Update local character data
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        char.data.extensions.gallery_id = galleryId;
        
        // Also update in allCharacters array
        const charIndex = allCharacters.findIndex(c => c.avatar === char.avatar);
        if (charIndex !== -1) {
            if (!allCharacters[charIndex].data) allCharacters[charIndex].data = {};
            if (!allCharacters[charIndex].data.extensions) allCharacters[charIndex].data.extensions = {};
            allCharacters[charIndex].data.extensions.gallery_id = galleryId;
        }
        
        debugLog(`[GalleryFolder] Assigned gallery_id to ${char.name}: ${galleryId}`);
        return { success: true, galleryId };
        
    } catch (error) {
        debugError(`[GalleryFolder] Failed to assign gallery_id to ${char.name}:`, error);
        return { success: false, galleryId: null, error: error.message };
    }
}

/**
 * Check if a character needs gallery folder migration
 * (has gallery_id but folder override not registered, or has images in old folder)
 * @param {object} char - Character object
 * @returns {boolean}
 */
function needsGalleryFolderMigration(char) {
    if (!getSetting('uniqueGalleryFolders')) return false;
    if (!getCharacterGalleryId(char)) return false;
    
    const context = getSTContext();
    if (!context?.extensionSettings?.gallery?.folders) return true;
    
    const expectedFolder = buildUniqueGalleryFolderName(char);
    const currentOverride = context.extensionSettings.gallery.folders[char.avatar];
    
    return currentOverride !== expectedFolder;
}

/**
 * Get gallery image/file information for a character
 * @param {object} char - Character object
 * @returns {Promise<{folder: string, files: string[], count: number}>}
 */
async function getCharacterGalleryInfo(char) {
    const folderName = getGalleryFolderName(char);
    if (!folderName) {
        return { folder: '', files: [], count: 0 };
    }
    
    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });
        if (!response.ok) {
            return { folder: folderName, files: [], count: 0 };
        }
        const files = await response.json();
        return { folder: folderName, files: files || [], count: (files || []).length };
    } catch (e) {
        debugLog('[Gallery] Error getting gallery info:', e);
        return { folder: folderName, files: [], count: 0 };
    }
}

/**
 * Count characters that need gallery_id assignment
 * @returns {number}
 */
function countCharactersNeedingGalleryId() {
    return allCharacters.filter(c => !getCharacterGalleryId(c)).length;
}

/**
 * Count characters with gallery_id that need folder registration
 * @returns {number}
 */
function countCharactersNeedingFolderRegistration() {
    if (!getSetting('uniqueGalleryFolders')) return 0;
    return allCharacters.filter(c => needsGalleryFolderMigration(c)).length;
}

// ========================================
// SMART IMAGE RELOCATION SYSTEM
// Uses content hashes from Chub gallery + embedded URLs as "fingerprints"
// to determine which images belong to which character when migrating
// from shared folders to unique folders
// ========================================

/**
 * Build an ownership fingerprint for a character by downloading and hashing
 * their Chub gallery images and embedded media URLs (without saving).
 * This fingerprint proves which images belong to this character.
 * @param {object} char - Character object
 * @param {object} options - Progress callbacks
 * @returns {Promise<{hashes: Set<string>, errors: number, chubCount: number, embeddedCount: number}>}
 */
async function buildOwnershipFingerprint(char, options = {}) {
    const { onLog, onLogUpdate, shouldAbort } = options;
    const hashes = new Set();
    let errors = 0;
    let chubCount = 0;
    let embeddedCount = 0;
    
    // 1. Get hashes from Chub gallery images (if character is linked)
    const chubInfo = getChubLinkInfo(char);
    if (chubInfo?.id) {
        const logEntry = onLog ? onLog(`Fetching Chub gallery fingerprint for ${char.name}...`, 'pending') : null;
        
        try {
            const galleryImages = await fetchChubGalleryImages(chubInfo.id);
            
            for (const image of galleryImages) {
                if (shouldAbort && shouldAbort()) break;
                
                let downloadResult = await downloadMediaToMemory(image.imageUrl, 30000);
                if (downloadResult.success) {
                    const hash = await calculateHash(downloadResult.arrayBuffer);
                    hashes.add(hash);
                    chubCount++;
                } else {
                    errors++;
                }
                downloadResult = null; // Release immediately
            }
            
            if (onLogUpdate && logEntry) {
                onLogUpdate(logEntry, `Chub gallery: ${chubCount} hashes collected`, 'success');
            }
        } catch (e) {
            console.error('[Fingerprint] Chub gallery error:', e);
            if (onLogUpdate && logEntry) {
                onLogUpdate(logEntry, `Chub gallery error: ${e.message}`, 'error');
            }
        }
    }
    
    // 2. Get hashes from embedded media URLs
    const mediaUrls = findCharacterMediaUrls(char);
    if (mediaUrls.length > 0) {
        const logEntry = onLog ? onLog(`Fetching embedded media fingerprint (${mediaUrls.length} URLs)...`, 'pending') : null;
        
        for (const url of mediaUrls) {
            if (shouldAbort && shouldAbort()) break;
            
            try {
                let downloadResult = await downloadMediaToMemory(url, 30000);
                if (downloadResult.success) {
                    const hash = await calculateHash(downloadResult.arrayBuffer);
                    hashes.add(hash);
                    embeddedCount++;
                } else {
                    errors++;
                }
                downloadResult = null; // Release immediately
            } catch (e) {
                errors++;
            }
        }
        
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Embedded media: ${embeddedCount} hashes collected`, 'success');
        }
    }
    
    debugLog(`[Fingerprint] ${char.name}: ${hashes.size} total hashes (${chubCount} chub, ${embeddedCount} embedded, ${errors} errors)`);
    
    return { hashes, errors, chubCount, embeddedCount };
}

/**
 * Scan a folder and get hash -> filename map for all images
 * @param {string} folderName - Folder to scan
 * @returns {Promise<Map<string, string>>} Map of hash -> filename
 */
async function scanFolderForImageHashes(folderName) {
    const hashToFile = new Map();
    
    try {
        const safeFolderName = sanitizeFolderName(folderName);
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });
        
        if (!response.ok) {
            debugLog('[Migration] Could not list folder:', folderName);
            return hashToFile;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return hashToFile;
        }
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only check media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            
            try {
                const fileResponse = await fetch(localPath);
                if (fileResponse.ok) {
                    const buffer = await fileResponse.arrayBuffer();
                    const hash = await calculateHash(buffer);
                    hashToFile.set(hash, fileName);
                }
            } catch (e) {
                console.warn(`[Migration] Could not hash file: ${fileName}`);
            }
        }
    } catch (error) {
        console.error('[Migration] Error scanning folder:', error);
    }
    
    return hashToFile;
}

/**
 * Move/copy an image file from one gallery folder to another
 * Since there's no move API, we download the file and re-upload to the new folder
 * @param {string} sourceFolder - Source folder name
 * @param {string} targetFolder - Target folder name  
 * @param {string} fileName - File name to move
 * @param {boolean} deleteSource - Whether to delete from source after copying
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function moveImageToFolder(sourceFolder, targetFolder, fileName, deleteSource = true) {
    try {
        const safeSourceFolder = sanitizeFolderName(sourceFolder);
        const safeTargetFolder = sanitizeFolderName(targetFolder);
        const sourcePath = `/user/images/${encodeURIComponent(safeSourceFolder)}/${encodeURIComponent(fileName)}`;
        
        debugLog(`[MoveFile] Moving ${fileName} from ${sourceFolder} to ${targetFolder}`);
        
        // Download the file
        const response = await fetch(sourcePath);
        if (!response.ok) {
            return { success: false, error: `Could not read source file: ${response.status}` };
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        
        debugLog(`[MoveFile] Downloaded ${fileName}, size: ${arrayBuffer.byteLength}, type: ${contentType}`);
        
        // Convert to base64 directly (avoid Blob+FileReader triple-buffering)
        const base64Data = arrayBufferToBase64(arrayBuffer);
        
        // Get extension from filename
        const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase() : 'png';
        
        debugLog(`[MoveFile] Uploading ${fileName} with extension: ${ext}`);
        
        // Upload to target folder with same filename
        const uploadResponse = await apiRequest(ENDPOINTS.IMAGES_UPLOAD, 'POST', {
            image: base64Data,
            ch_name: safeTargetFolder,
            filename: fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName,
            format: ext
        });
        
        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text().catch(() => 'Unknown error');
            debugLog(`[MoveFile] Upload FAILED for ${fileName}: ${errorText}`);
            return { success: false, error: `Upload failed: ${errorText}` };
        }
        
        debugLog(`[MoveFile] Upload successful for ${fileName}`);
        
        // Delete from source folder if requested
        if (deleteSource) {
            const deletePath = `/user/images/${safeSourceFolder}/${fileName}`;
            await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
            debugLog(`[MoveFile] Deleted source file ${fileName}`);
        }
        
        return { success: true };
    } catch (error) {
        debugLog(`[MoveFile] Exception moving ${fileName}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Find characters that share the same name (and thus the same old folder)
 * @returns {Map<string, Array<object>>} Map of character name -> array of characters with that name
 */
function findCharactersWithSharedNames() {
    const nameMap = new Map();
    
    for (const char of allCharacters) {
        if (!char.name) continue;
        
        const existing = nameMap.get(char.name) || [];
        existing.push(char);
        nameMap.set(char.name, existing);
    }
    
    // Filter to only names with multiple characters
    const sharedNames = new Map();
    for (const [name, chars] of nameMap) {
        if (chars.length > 1) {
            sharedNames.set(name, chars);
        }
    }
    
    return sharedNames;
}

/**
 * Perform smart image relocation for characters sharing the same name
 * Uses fingerprinting to determine which images belong to which character
 * @param {Array<object>} characters - Characters sharing the same name
 * @param {object} options - Progress callbacks
 * @returns {Promise<{moved: number, unmatched: number, errors: number, details: Array}>}
 */
async function relocateSharedFolderImages(characters, options = {}) {
    const { onLog, onLogUpdate, onProgress, shouldAbort } = options;
    const results = { moved: 0, unmatched: 0, errors: 0, details: [] };
    
    if (characters.length < 2) {
        return results;
    }
    
    const sharedFolderName = characters[0].name;
    const logEntry = onLog ? onLog(`Analyzing shared folder: ${sharedFolderName}`, 'pending') : null;
    
    // 1. Build fingerprints for all characters sharing this name
    const fingerprints = new Map(); // char.avatar -> Set of hashes
    let totalFingerprints = 0;
    
    for (let i = 0; i < characters.length; i++) {
        if (shouldAbort && shouldAbort()) return results;
        
        const char = characters[i];
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Building fingerprint for ${char.avatar}... (${i + 1}/${characters.length})`, 'pending');
        }
        
        const fingerprint = await buildOwnershipFingerprint(char, { shouldAbort });
        fingerprints.set(char.avatar, fingerprint.hashes);
        totalFingerprints += fingerprint.hashes.size;
        
        results.details.push({
            character: char.name,
            avatar: char.avatar,
            fingerprintSize: fingerprint.hashes.size
        });
    }
    
    if (totalFingerprints === 0) {
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `No fingerprints found - characters may not be linked to Chub or have embedded media`, 'success');
        }
        return results;
    }
    
    // 2. Scan the shared folder for existing images
    if (onLogUpdate && logEntry) {
        onLogUpdate(logEntry, `Scanning shared folder for images...`, 'pending');
    }
    
    const folderImages = await scanFolderForImageHashes(sharedFolderName);
    
    if (folderImages.size === 0) {
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `No images in shared folder`, 'success');
        }
        return results;
    }
    
    // 3. Match images to characters based on hash fingerprints
    if (onLogUpdate && logEntry) {
        onLogUpdate(logEntry, `Matching ${folderImages.size} images to ${characters.length} characters...`, 'pending');
    }
    
    const imagesToMove = []; // Array of { fileName, targetChar }
    const unmatchedImages = [];
    
    for (const [hash, fileName] of folderImages) {
        let matchedChar = null;
        
        // Find which character's fingerprint contains this hash
        for (const [avatar, hashes] of fingerprints) {
            if (hashes.has(hash)) {
                matchedChar = characters.find(c => c.avatar === avatar);
                break;
            }
        }
        
        if (matchedChar) {
            imagesToMove.push({ fileName, targetChar: matchedChar, hash });
        } else {
            unmatchedImages.push(fileName);
            results.unmatched++;
        }
    }
    
    // 4. Move matched images to their unique folders
    // First, scan destination folders to avoid moving duplicates
    const destFolderHashes = new Map(); // uniqueFolder -> Set of hashes
    for (const { targetChar } of imagesToMove) {
        const uniqueFolder = buildUniqueGalleryFolderName(targetChar);
        if (uniqueFolder && !destFolderHashes.has(uniqueFolder)) {
            const existingHashes = await scanFolderForImageHashes(uniqueFolder);
            destFolderHashes.set(uniqueFolder, new Set(existingHashes.keys()));
        }
    }
    
    for (let i = 0; i < imagesToMove.length; i++) {
        if (shouldAbort && shouldAbort()) return results;
        
        const { fileName, targetChar, hash } = imagesToMove[i];
        const uniqueFolder = buildUniqueGalleryFolderName(targetChar);
        
        if (!uniqueFolder) {
            results.errors++;
            continue;
        }
        
        // Skip if already in the correct folder (shouldn't happen, but safety check)
        if (uniqueFolder === sharedFolderName) {
            continue;
        }
        
        // Check if file with same content already exists in destination
        const destHashes = destFolderHashes.get(uniqueFolder);
        if (destHashes && destHashes.has(hash)) {
            // File already exists in destination - just delete from source
            debugLog(`[Migration] File ${fileName} already exists in ${uniqueFolder}, deleting from source`);
            const deletePath = `/user/images/${sanitizeFolderName(sharedFolderName)}/${fileName}`;
            await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', { path: deletePath });
            results.moved++; // Count as successful (file is where it should be)
            continue;
        }
        
        if (onLogUpdate && logEntry) {
            onLogUpdate(logEntry, `Moving ${fileName} to ${uniqueFolder}... (${i + 1}/${imagesToMove.length})`, 'pending');
        }
        
        const moveResult = await moveImageToFolder(sharedFolderName, uniqueFolder, fileName, true);
        
        if (moveResult.success) {
            results.moved++;
        } else {
            results.errors++;
            console.error(`[Migration] Failed to move ${fileName}:`, moveResult.error);
        }
        
        if (onProgress) onProgress(i + 1, imagesToMove.length);
    }
    
    if (onLogUpdate && logEntry) {
        const status = results.errors === 0 ? 'success' : 'warning';
        onLogUpdate(logEntry, 
            `${sharedFolderName}: ${results.moved} moved, ${results.unmatched} unmatched, ${results.errors} errors`, 
            status
        );
    }
    
    if (unmatchedImages.length > 0) {
        debugLog(`[Migration] Unmatched images in ${sharedFolderName}:`, unmatchedImages);
    }
    
    return results;
}

/**
 * Count how many characters share names and could benefit from image relocation
 * @returns {{sharedNameGroups: number, charactersAffected: number}}
 */
function countCharactersNeedingImageRelocation() {
    const sharedNames = findCharactersWithSharedNames();
    let charactersAffected = 0;
    
    for (const [_, chars] of sharedNames) {
        charactersAffected += chars.length;
    }
    
    return {
        sharedNameGroups: sharedNames.size,
        charactersAffected
    };
}

/**
 * Migrate all images from a character's old name-based folder to their unique folder
 * This is a simple migration for characters with unique names (no fingerprinting needed)
 * @param {object} char - Character object with gallery_id
 * @returns {Promise<{moved: number, errors: number, skipped: boolean}>}
 */
async function migrateCharacterImagesToUniqueFolder(char) {
    const result = { moved: 0, errors: 0, skipped: false };
    
    // Must have gallery_id
    const galleryId = getCharacterGalleryId(char);
    if (!galleryId) {
        result.skipped = true;
        return result;
    }
    
    const oldFolderName = char.name;
    const uniqueFolderName = buildUniqueGalleryFolderName(char);
    
    if (!uniqueFolderName) {
        result.skipped = true;
        return result;
    }
    
    // If old and new are the same, nothing to do
    if (oldFolderName === uniqueFolderName) {
        result.skipped = true;
        return result;
    }
    
    try {
        // List files in the old folder
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: oldFolderName, type: 7 });
        
        if (!response.ok) {
            // Folder might not exist, that's fine
            return result;
        }
        
        const files = await response.json();
        
        if (!files || files.length === 0) {
            return result;
        }
        
        // Filter to media files (images, audio, video)
        const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
        const mediaFiles = files.filter(f => {
            const fileName = typeof f === 'string' ? f : f.name;
            if (!fileName) return false;
            const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
            return mediaExtensions.includes(ext);
        });
        
        if (mediaFiles.length === 0) {
            return result;
        }
        
        debugLog(`[MigrateAll] ${char.name}: Moving ${mediaFiles.length} files from "${oldFolderName}" to "${uniqueFolderName}"`);
        
        // Move each file
        for (const file of mediaFiles) {
            const fileName = typeof file === 'string' ? file : file.name;
            const moveResult = await moveImageToFolder(oldFolderName, uniqueFolderName, fileName, true);
            
            if (moveResult.success) {
                result.moved++;
            } else {
                result.errors++;
                console.warn(`[MigrateAll] Failed to move "${fileName}" from "${oldFolderName}" to "${uniqueFolderName}":`, moveResult.error);
            }
        }
        
        debugLog(`[MigrateAll] ${char.name}: Moved ${result.moved} files, ${result.errors} errors`);
        
    } catch (error) {
        debugError(`[MigrateAll] Error migrating ${char.name}:`, error);
        result.errors++;
    }
    
    return result;
}

/**
 * Handle gallery folder rename when a character's name changes
 * Moves all files from OldName_UUID folder to NewName_UUID folder
 * @param {object} char - Character object
 * @param {string} oldName - The old character name
 * @param {string} newName - The new character name  
 * @param {string} galleryId - The character's gallery_id (UUID)
 * @returns {Promise<{success: boolean, moved: number, errors: number}>}
 */
async function handleGalleryFolderRename(char, oldName, newName, galleryId) {
    const result = { success: false, moved: 0, errors: 0 };
    
    // Build old and new folder names
    const safeOldName = oldName.replace(/[<>:"/\\|?*]/g, '_').trim();
    const safeNewName = newName.replace(/[<>:"/\\|?*]/g, '_').trim();
    const oldFolderName = `${safeOldName}_${galleryId}`;
    const newFolderName = `${safeNewName}_${galleryId}`;
    
    if (oldFolderName === newFolderName) {
        result.success = true;
        return result;
    }
    
    debugLog(`[GalleryRename] Renaming folder: "${oldFolderName}" -> "${newFolderName}"`);
    
    try {
        // Check if old folder has any files
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: oldFolderName, type: 7 });
        
        if (!response.ok) {
            // Old folder doesn't exist or can't be read - might be empty, that's fine
            debugLog(`[GalleryRename] Old folder "${oldFolderName}" doesn't exist or is empty`);
            // Still update the mapping for future use
            const tempChar = { ...char, name: newName };
            registerGalleryFolderOverride(tempChar);
            result.success = true;
            return result;
        }
        
        const files = await response.json();
        
        if (!files || files.length === 0) {
            debugLog(`[GalleryRename] Old folder "${oldFolderName}" is empty`);
            const tempChar = { ...char, name: newName };
            registerGalleryFolderOverride(tempChar);
            result.success = true;
            return result;
        }
        
        // Filter to media files
        const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
        const mediaFiles = files.filter(f => {
            const fileName = typeof f === 'string' ? f : f.name;
            if (!fileName) return false;
            const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
            return mediaExtensions.includes(ext);
        });
        
        if (mediaFiles.length === 0) {
            debugLog(`[GalleryRename] No media files to move`);
            const tempChar = { ...char, name: newName };
            registerGalleryFolderOverride(tempChar);
            result.success = true;
            return result;
        }
        
        debugLog(`[GalleryRename] Moving ${mediaFiles.length} files from "${oldFolderName}" to "${newFolderName}"`);
        
        // Move each file
        for (const file of mediaFiles) {
            const fileName = typeof file === 'string' ? file : file.name;
            const moveResult = await moveImageToFolder(oldFolderName, newFolderName, fileName, true);
            
            if (moveResult.success) {
                result.moved++;
            } else {
                result.errors++;
                console.warn(`[GalleryRename] Failed to move "${fileName}":`, moveResult.error);
            }
        }
        
        // Update the folder mapping with the new folder name
        // char.name should already be updated by now, but we ensure it matches newName
        const tempChar = { ...char, name: newName };
        registerGalleryFolderOverride(tempChar);
        
        result.success = result.errors === 0;
        debugLog(`[GalleryRename] Complete: ${result.moved} moved, ${result.errors} errors`);
        
        if (result.moved > 0) {
            showToast(`Gallery folder renamed: ${result.moved} files moved`, 'success');
        }
        
    } catch (error) {
        debugError(`[GalleryRename] Error:`, error);
        result.errors++;
    }
    
    return result;
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    // Load settings first to ensure defaults are available
    await loadGallerySettings();
    
    // Apply saved highlight color
    applyHighlightColor(getSetting('highlightColor'));
    
    // Reset filters and search on page load
    resetFiltersAndSearch();
    
    // Always use API for initial load to get authoritative data from disk.
    // The opener's in-memory character list may be stale if another client
    // (e.g. mobile) imported characters since the opener last refreshed.
    await fetchCharacters(true);
    setupEventListeners();
});

// Reset all filters and search to default state
function resetFiltersAndSearch() {
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.add('hidden');
    if (sortSelect) sortSelect.value = getSetting('defaultSort') || 'name_asc';
    
    // Clear tag filters (Map)
    activeTagFilters.clear();
    
    // Reset tag filter UI
    document.querySelectorAll('.tag-filter-item .tag-state-btn').forEach(btn => {
        btn.dataset.state = 'neutral';
        updateTagStateButton(btn, undefined);
    });
    updateTagFilterButtonIndicator();
    
    // Reset search settings checkboxes
    const searchName = document.getElementById('searchName');
    const searchDesc = document.getElementById('searchDesc');
    const searchTags = document.getElementById('searchTags');
    
    if (searchName) searchName.checked = true;
    if (searchDesc) searchDesc.checked = false;
    if (searchTags) searchTags.checked = true;
}

// Toast Icons
const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 4L12 14.01l-3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" class="w-6 h-6"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// Toast Notification System
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Icon
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
    
    // Message
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    
    toast.appendChild(icon);
    toast.appendChild(msg);
    container.appendChild(toast);

    // Remove after duration
    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, duration);
}

// Sync with Main Window
async function loadCharInMain(charOrAvatar) {
    if (!window.opener || window.opener.closed) {
        showToast("Main window disconnected", "error");
        return false;
    }

    // Normalize inputs
    let avatar = (typeof charOrAvatar === 'string') ? charOrAvatar : charOrAvatar.avatar;
    let charName = (typeof charOrAvatar === 'object') ? charOrAvatar.name : null;
    let charObj = (typeof charOrAvatar === 'object') ? charOrAvatar : null;
    
    // If we only have avatar string, find the full character object
    if (!charObj && avatar) {
        charObj = allCharacters.find(c => c.avatar === avatar);
    }

    // IMPORTANT: Register the gallery folder override BEFORE loading the character
    // This ensures index.js can find the correct folder for media localization
    if (charObj && getSetting('uniqueGalleryFolders') && getCharacterGalleryId(charObj)) {
        registerGalleryFolderOverride(charObj);
    }

    debugLog(`Attempting to load character by file: ${avatar}`);

    try {
        let context = null;
        let mainCharacters = [];
        
        if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
            context = window.opener.SillyTavern.getContext();
            mainCharacters = context.characters || [];
        } else if (window.opener.characters) {
            mainCharacters = window.opener.characters;
        }

        // 1. Find character INDEX in main list (Strict Filename Match)
        // IMPORTANT: selectCharacterById takes a NUMERIC INDEX, not the avatar filename!
        const characterIndex = mainCharacters.findIndex(c => c.avatar === avatar);
        const targetChar = characterIndex !== -1 ? mainCharacters[characterIndex] : null;
        
        if (!targetChar) {
            console.warn(`Character "${avatar}" not found in main window's loaded list.`);
            showToast(`Character file "${avatar}" not found`, "error");
            return false;
        } else {
             debugLog("Found character in main list at index", characterIndex, ":", targetChar);
        }

        // Show toast immediately before attempting to load
        showToast(`Loading ${charName || avatar}...`, "success");

        // Helper: Timeout wrapper for promises
        const withTimeout = (promise, ms = 2000) => {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error("Timeout"));
                }, ms);
                promise
                    .then(value => {
                        clearTimeout(timer);
                        resolve(value);
                    })
                    .catch(reason => {
                        clearTimeout(timer);
                        reject(reason);
                    });
            });
        };

        // Method 1: context.selectCharacterById (Best API) - PASS THE NUMERIC INDEX!
        // Note: This function may not return a promise, so we call it and return immediately
        if (context && typeof context.selectCharacterById === 'function') {
             debugLog(`Trying context.selectCharacterById with index ${characterIndex}`);
             try {
                 const result = context.selectCharacterById(characterIndex);
                 // If it returns a promise, wait briefly; otherwise assume success
                 if (result && typeof result.then === 'function') {
                     await withTimeout(result, 5000);
                 }
                 return true;
             } catch (err) {
                 console.warn("selectCharacterById failed or timed out:", err);
                 // Fall through to next method
             }
        }

        // Method 2: context.loadCharacter (Alternative API)
        if (context && typeof context.loadCharacter === 'function') {
             debugLog("Trying context.loadCharacter");
             try {
                // Some versions return a promise, some don't.
                await withTimeout(Promise.resolve(context.loadCharacter(avatar)), 5000);
                return true;
             } catch (err) {
                 console.warn("context.loadCharacter failed:", err);
             }
        }

        // Method 3: Global loadCharacter (Legacy)
        if (typeof window.opener.loadCharacter === 'function') {
            debugLog("Trying global loadCharacter");
            try {
                window.opener.loadCharacter(avatar);
                return true;
            } catch (err) {
                console.warn("global loadCharacter failed:", err);
            }
        }

        // Method 4: UI Click Simulation (Virtualization Fallback)
        if (window.opener.$) {
            const $ = window.opener.$;
            let charBtn = $('.character-list-item').filter((i, el) => {
                const file = $(el).attr('data-file');
                // Check both full filename and filename without extension
                return file === avatar || file === avatar.replace(/\.[^/.]+$/, "");
            });
            
            if (charBtn.length) {
                debugLog("Loaded via jQuery click (data-file match)");
                charBtn.first().click();
                return true;
            } else {
                 console.warn("Character found in array but not in DOM (Virtualization?)");
            }
        }
        
        // Method 5: Slash Command /go (Last Resort for Unique Names only)
        // If we reached here, the API failed AND the DOM click failed.
        const isDuplicateName = mainCharacters.filter(c => c.name === charName).length > 1;
        
        if (charName && !isDuplicateName && context && context.executeSlashCommandsWithOptions) {
              const safeName = charName.replace(/"/g, '\\"');
              debugLog("Falling back to Slash Command (Unique Name)");
              context.executeSlashCommandsWithOptions(`/go "${safeName}"`, { displayCommand: false, showOutput: true });
              showToast(`Loaded ${charName} (Slash Command)`, "success");
              return true;
        }
        
        if (isDuplicateName) {
             showToast(`Duplicate name "${charName}" and exact file load failed.`, "error");
             return false;
        }
        
        console.warn("All load methods failed.");
        showToast("Could not trigger load. Try clicking manually in the main list.", "error");
        return false;
    } catch (e) {
        console.error("Access to opener failed:", e);
        showToast("Error communicating with main window", "error");
        return false;
    }
}

// Data Fetching
// forceRefresh: if true, fetch directly from API (authoritative) and refresh main window in background
async function fetchCharacters(forceRefresh = false) {
    // Clear computation cache on refresh to prevent stale token estimates, etc.
    if (forceRefresh) {
        clearCache();
    }
    
    try {
        // Method 1: Try to get data directly from the opener (Main Window)
        // Only used for non-forced fetches — the opener's in-memory data may be stale
        // after imports. forceRefresh always goes to the API for authoritative disk data.
        if (!forceRefresh && window.opener && !window.opener.closed) {
            try {
                debugLog("Attempting to read characters from window.opener...");
                let openerChars = null;
                
                if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                    const context = window.opener.SillyTavern.getContext();
                    if (context && context.characters) openerChars = context.characters;
                }
                if (!openerChars && window.opener.characters) openerChars = window.opener.characters;

                if (openerChars && Array.isArray(openerChars)) {
                    debugLog(`Loaded ${openerChars.length} characters from main window.`);
                    processAndRender(openerChars);
                    return;
                }
            } catch (err) {
                console.warn("Opener access failed:", err);
            }
        }

        if (forceRefresh) {
            debugLog('Force refresh: fetching directly from API (bypassing opener)...');
        }

        // Method 2: API Fetch — use the known correct endpoint first
        let url = ENDPOINTS.CHARACTERS_ALL;
        debugLog(`Fetching characters from: ${API_BASE}${url}`);

        let response = await apiRequest(url, 'POST', {});
        
        // Fallback: try GET if POST not supported
        if (response.status === 404 || response.status === 405) {
            debugLog("POST failed, trying GET...");
            response = await apiRequest(url, 'GET');
        }
        
        if (!response.ok) {
            const text = await response.text();
            console.error('API Error:', text);
            throw new Error(`Server returned ${response.status}: ${text}`);
        }

        let data = await response.json();
        debugLog('Gallery Data: loaded', Array.isArray(data) ? data.length : 'object');
        processAndRender(data);
        data = null; // Release reference — processAndRender has consumed it into allCharacters

    } catch (error) {
        console.error("Failed to fetch characters:", error);
        document.getElementById('loading').textContent = 'Error: ' + error.message;
    }
}

// Process and Render (extracted to be reusable)
function processAndRender(data) {
    // Store the current active character's avatar to re-link after refresh
    const activeCharAvatar = activeChar ? activeChar.avatar : null;
    
    allCharacters = Array.isArray(data) ? data : (data.data || []);
    
    // Filter valid
    allCharacters = allCharacters.filter(c => c && c.avatar);
    
    // Re-link activeChar to the new object in allCharacters if modal is open
    if (activeCharAvatar) {
        const updatedChar = allCharacters.find(c => c.avatar === activeCharAvatar);
        if (updatedChar) {
            activeChar = updatedChar;
        }
    }
    
    // Populate Tags set for the filter dropdown
    const allTags = new Set();
    allCharacters.forEach(c => {
         const tags = getTags(c);
         if (Array.isArray(tags)) {
             tags.forEach(t => allTags.add(t));
         }
    });

    populateTagFilter(allTags);
    
    currentCharacters = [...allCharacters];
    
    // Build lookup for ChubAI "in library" matching
    buildLocalLibraryLookup();
    
    // Apply current sort/filter settings and render the grid.
    // If the characters view isn't active (e.g. we're on the ChubAI view after a download),
    // the grid is hidden and rendering now would use stale dimensions. In that case just
    // sort/update currentCharacters without rendering — switchView('characters') will call
    // performSearch() again with correct dimensions when the user navigates back.
    if (currentView === 'characters') {
        performSearch();
    } else {
        // Still sort currentCharacters so the data is ready when the user switches views,
        // but don't render to a hidden grid (avoids wrong dimensions / stale virtual scroll).
        const sortSelect = document.getElementById('sortSelect');
        const sortType = sortSelect ? sortSelect.value : 'name_asc';
        currentCharacters.sort((a, b) => {
            if (sortType === 'name_asc') return a.name.localeCompare(b.name);
            if (sortType === 'name_desc') return b.name.localeCompare(a.name);
            if (sortType === 'date_new') return getCharacterDateAdded(b) - getCharacterDateAdded(a);
            if (sortType === 'date_old') return getCharacterDateAdded(a) - getCharacterDateAdded(b);
            if (sortType === 'created_new') return getCharacterCreateDate(b) - getCharacterCreateDate(a);
            if (sortType === 'created_old') return getCharacterCreateDate(a) - getCharacterCreateDate(b);
            return 0;
        });
    }
    
    document.getElementById('loading').style.display = 'none';
    
    // Sync gallery folder overrides to opener's settings after every character list refresh.
    // This ensures the opener's in-memory extensionSettings.gallery.folders is up-to-date,
    // even if another client (e.g. mobile) imported characters and the opener's settings are stale.
    if (getSetting('uniqueGalleryFolders')) {
        try {
            syncAllGalleryFolderOverrides();
        } catch (e) {
            console.warn('[processAndRender] Gallery folder sync failed:', e);
        }
    }
    
    // Re-audit and update the warning indicator AFTER sync.
    // This overwrites any stale initial audit that may have fired before syncAll completed.
    // Also clean up any orphaned mappings (e.g. from tempChar registrations with wrong avatar keys).
    try {
        if (typeof window.auditGalleryIntegrity === 'function' &&
            typeof window.updateGallerySyncWarning === 'function') {
            const freshAudit = window.auditGalleryIntegrity();
            
            // Auto-cleanup orphaned mappings silently
            if (freshAudit.issues.orphaned > 0 && typeof window.cleanupOrphanedMappings === 'function') {
                const cleanup = window.cleanupOrphanedMappings();
                if (cleanup.removed > 0) {
                    debugLog(`[processAndRender] Auto-cleaned ${cleanup.removed} orphaned mapping(s)`);
                    // Re-audit after cleanup for accurate indicator
                    const cleanAudit = window.auditGalleryIntegrity();
                    window.updateGallerySyncWarning(cleanAudit);
                } else {
                    window.updateGallerySyncWarning(freshAudit);
                }
            } else {
                window.updateGallerySyncWarning(freshAudit);
            }
            window._gallerySyncAuditDone = true; // flag so initial audit can skip
        }
    } catch (e) {
        // Module may not be loaded yet on first render — that's fine
    }
}

// Tag filter states: Map<tagName, 'include' | 'exclude'>
// undefined/not in map = neutral (unchecked)
let activeTagFilters = new Map();

function populateTagFilter(tagSet) {
    const sortedTags = Array.from(tagSet).sort((a,b) => a.localeCompare(b));
    const content = document.getElementById('tagFilterContent');
    const searchInput = document.getElementById('tagSearchInput');

    if (content) {
        // Build DOM elements once
        content.innerHTML = '';
        sortedTags.forEach(tag => {
            const item = document.createElement('div');
            item.className = 'tag-filter-item';
            item.dataset.tag = tag.toLowerCase(); // For filtering
            
            const currentState = activeTagFilters.get(tag); // 'include', 'exclude', or undefined
            
            // Create tri-state button
            const stateBtn = document.createElement('button');
            stateBtn.className = 'tag-state-btn';
            stateBtn.dataset.state = currentState || 'neutral';
            updateTagStateButton(stateBtn, currentState);
            
            const label = document.createElement('span');
            label.className = 'tag-label';
            label.textContent = tag;
            
            // Tri-state cycling: neutral -> include -> exclude -> neutral
            stateBtn.onclick = (e) => {
                e.stopPropagation();
                const current = stateBtn.dataset.state;
                let newState;
                if (current === 'neutral') {
                    newState = 'include';
                    activeTagFilters.set(tag, 'include');
                } else if (current === 'include') {
                    newState = 'exclude';
                    activeTagFilters.set(tag, 'exclude');
                } else {
                    newState = 'neutral';
                    activeTagFilters.delete(tag);
                }
                stateBtn.dataset.state = newState;
                updateTagStateButton(stateBtn, newState === 'neutral' ? undefined : newState);
                
                // Update tag button indicator
                updateTagFilterButtonIndicator();
                
                // Trigger Search/Filter update
                document.getElementById('searchInput').dispatchEvent(new Event('input'));
            };
            
            // Clicking the label also cycles
            label.onclick = (e) => {
                stateBtn.click();
            };
            
            item.appendChild(stateBtn);
            item.appendChild(label);
            content.appendChild(item);
        });

        // Filter function uses visibility instead of rebuilding
        const filterList = (filterText = "") => {
            const lowerFilter = filterText.toLowerCase();
            content.querySelectorAll('.tag-filter-item').forEach(item => {
                const matches = !filterText || item.dataset.tag.includes(lowerFilter);
                item.style.display = matches ? '' : 'none';
            });
        };

        // Search Listener
        if (searchInput) {
            searchInput.oninput = (e) => {
                filterList(e.target.value);
            };
            // Prevent popup closing when clicking search
            searchInput.onclick = (e) => e.stopPropagation();
        }
        
        // Update indicator on initial load
        updateTagFilterButtonIndicator();
    }
}

function updateTagStateButton(btn, state) {
    if (state === 'include') {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.className = 'tag-state-btn state-include';
        btn.title = 'Included - click to exclude';
    } else if (state === 'exclude') {
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.className = 'tag-state-btn state-exclude';
        btn.title = 'Excluded - click to clear';
    } else {
        btn.innerHTML = '';
        btn.className = 'tag-state-btn state-neutral';
        btn.title = 'Neutral - click to include';
    }
}

function updateTagFilterButtonIndicator() {
    const tagLabel = document.getElementById('tagFilterLabel');
    if (!tagLabel) return;
    
    const includeCount = Array.from(activeTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(activeTagFilters.values()).filter(v => v === 'exclude').length;
    
    // Update button text/indicator
    let indicator = '';
    if (includeCount > 0 || excludeCount > 0) {
        const parts = [];
        if (includeCount > 0) parts.push(`+${includeCount}`);
        if (excludeCount > 0) parts.push(`-${excludeCount}`);
        indicator = ` (${parts.join('/')})`;
    }
    
    tagLabel.textContent = `Tags${indicator}`;
}

/**
 * Clear all active tag filters
 */
function clearAllTagFilters() {
    activeTagFilters.clear();
    
    // Reset all tag state buttons in the UI
    document.querySelectorAll('.tag-filter-item .tag-state-btn').forEach(btn => {
        btn.dataset.state = 'neutral';
        updateTagStateButton(btn, undefined);
    });
    
    updateTagFilterButtonIndicator();
    
    // Trigger search update
    document.getElementById('searchInput').dispatchEvent(new Event('input'));
}

function getTags(char) {
    if (Array.isArray(char.tags)) return char.tags;
    if (char.data && Array.isArray(char.data.tags)) return char.data.tags;
    return [];
}

// ==============================================
// VIRTUAL SCROLLING SYSTEM
// Renders only visible cards + buffer for performance
// Scrollbar represents full content from the start
// ==============================================

// Virtual scroll state
let currentCharsList = [];
let activeCards = new Map(); // Track rendered cards by index
let lastRenderedStartIndex = -1;
let lastRenderedEndIndex = -1;
let isScrolling = false;
let scrollTimeout = null;
let cachedCardHeight = 0;
let cachedCardWidth = 0;
let characterGridDelegatesInitialized = false;
let currentCharByAvatar = new Map();

// Card dimensions (will be measured from actual cards)
const CARD_MIN_WIDTH = 200; // Matches CSS minmax(200px, 1fr)
const CARD_ASPECT_RATIO = 2 / 3; // width/height for portrait cards
const GRID_GAP = 20; // Matches CSS gap: 20px

/**
 * Main render function - sets up virtual scrolling
 */
function renderGrid(chars) {
    const grid = document.getElementById('characterGrid');
    const scrollContainer = document.querySelector('.gallery-content');
    
    // Store chars reference
    currentCharsList = chars;
    currentCharByAvatar = new Map();
    chars.forEach(char => {
        if (char?.avatar) currentCharByAvatar.set(char.avatar, char);
    });
    
    // Clear existing content and state
    grid.innerHTML = '';
    activeCards.clear();
    lastRenderedStartIndex = -1;
    lastRenderedEndIndex = -1;
    cachedCardHeight = 0;
    
    // Remove any existing sentinel (not needed with virtual scroll)
    const existingSentinel = document.getElementById('lazyLoadSentinel');
    if (existingSentinel) existingSentinel.remove();
    
    if (chars.length === 0) {
        renderSimpleEmpty(grid, 'No characters found');
        grid.style.minHeight = '';
        grid.style.paddingTop = '';
        return;
    }
    
    // Calculate and set total grid height
    updateGridHeight(grid);
    
    // Setup scroll listener
    setupVirtualScrollListener(grid, scrollContainer);
    
    // Initial render
    updateVisibleCards(grid, scrollContainer, true);
}

/**
 * Calculate and set the total grid height based on all items
 */
function updateGridHeight(grid) {
    const gridWidth = grid.clientWidth || 800;
    const { cols, cardHeight } = getGridMetrics(gridWidth);
    
    const totalRows = Math.ceil(currentCharsList.length / cols);
    const totalHeight = (totalRows * cardHeight) + ((totalRows - 1) * GRID_GAP);
    
    grid.style.minHeight = `${totalHeight}px`;
}

/**
 * Get grid layout metrics
 */
function getGridMetrics(gridWidth) {
    // Use cached values if available (only re-measure when explicitly invalidated)
    if (cachedCardWidth > 0 && cachedCardHeight > 0) {
        const cols = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (cachedCardWidth + GRID_GAP)));
        return { cols, cardWidth: cachedCardWidth, cardHeight: cachedCardHeight };
    }
    
    // Measure from actual card if available
    const firstCard = document.querySelector('.char-card');
    if (firstCard) {
        cachedCardWidth = firstCard.offsetWidth;
        cachedCardHeight = firstCard.offsetHeight;
    }
    
    const cardWidth = cachedCardWidth || CARD_MIN_WIDTH;
    const cardHeight = cachedCardHeight || Math.round(CARD_MIN_WIDTH / CARD_ASPECT_RATIO);
    const cols = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (cardWidth + GRID_GAP)));
    
    return { cols, cardWidth, cardHeight };
}

/**
 * Update which cards are visible and render them
 */
function updateVisibleCards(grid, scrollContainer, force = false) {
    if (currentCharsList.length === 0) return;
    
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight;
    const gridWidth = grid.clientWidth || 800;
    
    const { cols, cardHeight } = getGridMetrics(gridWidth);
    
    // Render buffer: 2 screens above and below
    const RENDER_BUFFER_PX = clientHeight * 2;
    
    // Preload buffer: 4 screens ahead for images
    const PRELOAD_BUFFER_PX = clientHeight * 4;
    
    // Calculate visible row range
    const startRow = Math.floor(Math.max(0, scrollTop - RENDER_BUFFER_PX) / (cardHeight + GRID_GAP));
    const endRow = Math.ceil((scrollTop + clientHeight + RENDER_BUFFER_PX) / (cardHeight + GRID_GAP));
    
    const startIndex = startRow * cols;
    const endIndex = Math.min(currentCharsList.length, (endRow + 1) * cols);
    
    // Skip if nothing changed
    if (!force && startIndex === lastRenderedStartIndex && endIndex === lastRenderedEndIndex) {
        return;
    }
    
    lastRenderedStartIndex = startIndex;
    lastRenderedEndIndex = endIndex;
    
    // Calculate padding to position cards correctly
    const paddingTop = startRow * (cardHeight + GRID_GAP);
    grid.style.paddingTop = `${paddingTop}px`;
    
    // Determine which indices we need
    const neededIndices = new Set();
    for (let i = startIndex; i < endIndex; i++) {
        neededIndices.add(i);
    }
    
    // Remove cards that are no longer visible
    for (const [index, card] of activeCards) {
        if (!neededIndices.has(index)) {
            card.remove();
            activeCards.delete(index);
        }
    }
    
    // Add missing cards in order
    // We need to maintain DOM order for proper grid layout
    const sortedIndices = Array.from(neededIndices).sort((a, b) => a - b);
    
    // Create any missing cards
    for (const index of sortedIndices) {
        if (!activeCards.has(index)) {
            const char = currentCharsList[index];
            if (char) {
                const card = createCharacterCard(char);
                card.dataset.virtualIndex = index;
                activeCards.set(index, card);
            }
        }
    }
    
    // Check if we need to rebuild the grid (cards added/removed, not just scrolling)
    const currentChildren = Array.from(grid.children);
    const currentIndices = currentChildren.map(c => parseInt(c.dataset.virtualIndex)).filter(i => !isNaN(i));
    const needsRebuild = currentIndices.length !== sortedIndices.length || 
                         !sortedIndices.every((idx, i) => currentIndices[i] === idx);
    
    if (needsRebuild) {
        // Only rebuild if card set has changed - preserves hover states during pure scroll
        const orderedCards = sortedIndices
            .map(i => activeCards.get(i))
            .filter(card => card);
        
        grid.innerHTML = '';
        grid.style.paddingTop = `${paddingTop}px`;
        orderedCards.forEach(card => grid.appendChild(card));
    }
    
    // Preload images only on scroll-end (force=true), not during active scrolling.
    // During fast scroll, every preload batch gets immediately aborted by the next
    // RAF frame — wasting CPU on AbortController + 12 fetch() calls per frame.
    if (force) {
        const preloadStartRow = Math.floor((scrollTop + clientHeight) / (cardHeight + GRID_GAP));
        const preloadEndRow = Math.ceil((scrollTop + clientHeight + PRELOAD_BUFFER_PX) / (cardHeight + GRID_GAP));
        const preloadStartIndex = preloadStartRow * cols;
        const preloadEndIndex = Math.min(currentCharsList.length, preloadEndRow * cols);

        preloadImages(preloadStartIndex, preloadEndIndex);
    }
}

// Abort controller for preload fetches — cancels previous batch when a new one starts
let preloadAbortController = null;

/**
 * Preload avatar images for a range of characters.
 * Uses fetch() to warm the HTTP cache without creating orphaned Image objects
 * that hold decoded bitmaps in memory indefinitely (critical for mobile).
 * Limited to a small batch to avoid memory pressure.
 * Each call aborts any pending preloads from the previous call.
 */
function preloadImages(startIndex, endIndex) {
    // Cancel any pending preloads from previous scroll to avoid accumulating
    // unconsumed response bodies in memory
    if (preloadAbortController) {
        preloadAbortController.abort();
    }
    preloadAbortController = new AbortController();
    const signal = preloadAbortController.signal;
    
    const MAX_PRELOAD = 12; // Limit concurrent preloads for mobile
    let count = 0;
    for (let i = startIndex; i < endIndex && count < MAX_PRELOAD; i++) {
        const char = currentCharsList[i];
        if (char && char.avatar) {
            // Cache-only fetch — warms browser HTTP cache without decoding image pixels.
            // Cancel the response body immediately to prevent memory accumulation.
            fetch(getCharacterAvatarUrl(char.avatar), { mode: 'no-cors', priority: 'low', signal })
                .then(r => { r.body?.cancel(); })
                .catch(() => {});
            count++;
        }
    }
}

/**
 * Setup scroll listener for virtual scrolling
 */
function setupVirtualScrollListener(grid, scrollContainer) {
    // Remove previous scroll listener if exists
    if (currentScrollHandler) {
        scrollContainer.removeEventListener('scroll', currentScrollHandler);
    }
    
    // Cancel any pending stale scroll timeout from previous render
    // (e.g. from a hidden-grid render during ChubAI download)
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
    
    // Track when the last scroll event occurred for the debounce end-check
    let lastScrollEventTime = 0;
    const SCROLL_END_DELAY = 100;

    currentScrollHandler = () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                updateVisibleCards(grid, scrollContainer, false);
                isScrolling = false;
            });
            isScrolling = true;
        }
        
        // Debounce for scroll end — uses a single persistent timeout that
        // re-checks elapsed time instead of clear+reset on every event.
        // Avoids 300+ clearTimeout/setTimeout pairs during fast scrolling.
        lastScrollEventTime = performance.now();
        if (!scrollTimeout) {
            scrollTimeout = setTimeout(function checkScrollEnd() {
                if (performance.now() - lastScrollEventTime >= SCROLL_END_DELAY) {
                    scrollTimeout = null;
                    updateVisibleCards(grid, scrollContainer, true);
                } else {
                    // Scroll still active — re-check after remaining time
                    scrollTimeout = setTimeout(checkScrollEnd,
                        SCROLL_END_DELAY - (performance.now() - lastScrollEventTime));
                }
            }, SCROLL_END_DELAY);
        }
    };
    
    scrollContainer.addEventListener('scroll', currentScrollHandler, { passive: true });
}

function setupCharacterGridDelegates() {
    if (characterGridDelegatesInitialized) return;

    const grid = document.getElementById('characterGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.char-card');
        if (!card || !grid.contains(card)) return;

        const avatar = card.dataset.avatar;
        const char = currentCharByAvatar.get(avatar);
        if (!char) return;

        // Check if multi-select mode is active (from module-loader.js)
        if (window.handleCardClickForMultiSelect && window.handleCardClickForMultiSelect(char, card)) {
            return; // Multi-select handled it
        }
        openModal(char);
    });

    characterGridDelegatesInitialized = true;
}

// Update grid height on window resize (throttled to avoid jank during drag-resize)
let resizeRAF = null;
window.addEventListener('resize', () => {
    if (resizeRAF) return; // Already scheduled
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        cachedCardHeight = 0;
        cachedCardWidth = 0;
        const grid = document.getElementById('characterGrid');
        if (grid && currentCharsList.length > 0) {
            updateGridHeight(grid);
            const scrollContainer = document.querySelector('.gallery-content');
            updateVisibleCards(grid, scrollContainer, true);
        }
    });
});

/**
 * Create a single character card element
 */
function createCharacterCard(char) {
    const card = document.createElement('div');
    card.className = 'char-card';
    
    // Check if character is a favorite
    const isFavorite = isCharacterFavorite(char);
    if (isFavorite) {
        card.classList.add('is-favorite');
    }
    
    const name = getCharacterName(char);
    char.name = name; 
    const imgPath = getCharacterAvatarUrl(char.avatar);
    const tags = getTags(char);
    
    const tagHtml = tags.slice(0, 3).map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('');
    
    // Use creator_notes as hover tooltip - extract plain text only
    // For ChubAI imports, this contains the public character description (often with HTML/CSS)
    const creatorNotes = char.data?.creator_notes || char.creator_notes || '';
    const cacheKey = 'plainText:' + char.avatar;
    let tooltipText = getCached(cacheKey);
    if (tooltipText === undefined) {
        tooltipText = extractPlainText(creatorNotes, 200);
        setCached(cacheKey, tooltipText);
    }
    if (tooltipText) {
        card.title = tooltipText;
    }
    
    // Build favorite indicator HTML
    const favoriteHtml = isFavorite ? '<div class="favorite-indicator"><i class="fa-solid fa-star"></i></div>' : '';

    card.innerHTML = `
        ${favoriteHtml}
        <img src="${imgPath}" class="card-image" loading="lazy" onerror="this.src='/img/No-Image-Placeholder.svg'">
        <div class="card-overlay">
            <div class="card-name">${escapeHtml(name)}</div>
            <div class="card-tags">${tagHtml}</div>
        </div>
    `;
    
    // Store avatar for multi-select lookup
    card.dataset.avatar = char.avatar;

    if (window.MultiSelect?.isSelected?.(char.avatar)) {
        card.classList.add('selected');
    }
    
    // Context menu is handled via event delegation in module-loader.js
    // No per-card attachment needed
    
    return card;
}

// Modal Logic
const modal = document.getElementById('charModal');
let activeChar = null;

// Cached tab element references — these are static DOM nodes, queried once
let _cachedTabButtons = null;
let _cachedTabPanes = null;

function getTabButtons() {
    if (!_cachedTabButtons) _cachedTabButtons = document.querySelectorAll('.tab-btn');
    return _cachedTabButtons;
}

function getTabPanes() {
    if (!_cachedTabPanes) _cachedTabPanes = document.querySelectorAll('.tab-pane');
    return _cachedTabPanes;
}

/** Deactivate all tab buttons and panes */
function deactivateAllTabs() {
    getTabButtons().forEach(b => b.classList.remove('active'));
    getTabPanes().forEach(p => p.classList.remove('active'));
}

/** Reset scroll positions on all tab panes (and sidebar) */
function resetTabScrollPositions() {
    getTabPanes().forEach(p => p.scrollTop = 0);
    const sidebar = document.querySelector('.modal-sidebar');
    if (sidebar) sidebar.scrollTop = 0;
}

// Fetch User Images for Character
// charOrName can be a character object or a character name string
// If unique gallery folders are enabled, we use the unique folder name
async function fetchCharacterImages(charOrName) {
    const grid = document.getElementById('spritesGrid');
    renderLoadingState(grid, 'Loading Media...');
    
    // Determine the folder name to use
    let folderName;
    let displayName;
    
    if (charOrName && typeof charOrName === 'object') {
        // It's a character object - use getGalleryFolderName for proper unique folder support
        folderName = getGalleryFolderName(charOrName);
        displayName = charOrName.name || folderName;
    } else {
        // It's a string - try to find the character and get their unique folder
        const charName = String(charOrName);
        displayName = charName;
        
        // Try to find a matching character for unique folder lookup
        // First check activeChar (most common case when viewing gallery)
        if (activeChar && activeChar.name === charName) {
            folderName = getGalleryFolderName(activeChar);
        } else {
            // Try to find by name in allCharacters
            const matchingChars = allCharacters.filter(c => c.name === charName);
            if (matchingChars.length === 1) {
                // Exactly one match - use its unique folder
                folderName = getGalleryFolderName(matchingChars[0]);
            } else {
                // Multiple or no matches - use the name as-is
                // This is the fallback for shared name scenarios
                folderName = charName;
            }
        }
    }
    
    debugLog(`[Gallery] Fetching images from folder: ${folderName} (display: ${displayName})`);
    
    // The user's images are stored in /user/images/CharacterName/...
    // We can list files in that directory using the /api/files/list endpoint or similar if it exists.
    // However, SillyTavern usually exposes content listing via directory APIs.
    // Let's try to infer if we can look up the folder directly.
    
    // Path conventions in SillyTavern:
    // data/default-user/user/images/<Name> mapped to /user/images/<Name> in URL
    
    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: folderName, type: 7 });

        if (response.ok) {
            const files = await response.json();
            renderGalleryImages(files, folderName);
        } else {
             console.warn(`[Gallery] Failed to list images: ${response.status}`);
             renderSimpleEmpty(grid, 'No user images found for this character.');
        }
    } catch (e) {
        console.error("Error fetching images:", e);
        renderSimpleEmpty(grid, 'Error loading media.');
    }
}

function renderGalleryImages(files, folderName) {
    const grid = document.getElementById('spritesGrid');
    grid.innerHTML = '';
    // Reset grid class - we'll manage layout with sections inside
    grid.className = 'gallery-media-container';
    
    if (!files || files.length === 0) {
        renderSimpleEmpty(grid, 'No media found.');
        return;
    }

    // Separate images, videos, and audio files
    const imageFiles = [];
    const videoFiles = [];
    const audioFiles = [];
    
    files.forEach(file => {
        const fileName = (typeof file === 'string') ? file : file.name;
        if (!fileName) return;
        
        if (fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i)) {
            imageFiles.push(fileName);
        } else if (fileName.match(/\.(mp4|webm|mov|avi|mkv|m4v)$/i)) {
            videoFiles.push(fileName);
        } else if (fileName.match(/\.(mp3|wav|ogg|m4a|flac|aac)$/i)) {
            audioFiles.push(fileName);
        }
    });
    
    // Trim folder name and sanitize to match SillyTavern's folder naming
    const safeFolderName = sanitizeFolderName(folderName);
    
    // Render audio files first if any exist
    if (audioFiles.length > 0) {
        const audioSection = document.createElement('div');
        audioSection.className = 'gallery-audio-section';
        audioSection.innerHTML = `<div class="gallery-section-title"><i class="fa-solid fa-music"></i> Audio Files (${audioFiles.length})</div>`;
        
        const audioGrid = document.createElement('div');
        audioGrid.className = 'audio-files-grid';
        
        audioFiles.forEach(fileName => {
            const audioUrl = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            const audioItem = document.createElement('div');
            audioItem.className = 'audio-item';
            audioItem.innerHTML = `
                <div class="audio-item-icon">
                    <i class="fa-solid fa-music"></i>
                </div>
                <div class="audio-item-info">
                    <div class="audio-item-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    <audio controls class="audio-player" preload="metadata">
                        <source src="${audioUrl}" type="audio/${fileName.split('.').pop().toLowerCase()}">
                        Your browser does not support audio playback.
                    </audio>
                </div>
            `;
            audioGrid.appendChild(audioItem);
        });
        
        audioSection.appendChild(audioGrid);
        grid.appendChild(audioSection);
    }
    
    // Combine images and videos for the visual media section
    const visualMedia = [
        ...imageFiles.map(fileName => ({ fileName, type: 'image' })),
        ...videoFiles.map(fileName => ({ fileName, type: 'video' }))
    ];
    
    // Render visual media (images + videos)
    if (visualMedia.length > 0) {
        const imagesSection = document.createElement('div');
        imagesSection.className = 'gallery-images-section';
        
        const hasOtherMedia = audioFiles.length > 0;
        const imageCount = imageFiles.length;
        const videoCount = videoFiles.length;
        
        if (hasOtherMedia) {
            // Add section title if we also have audio
            let titleText = '';
            if (imageCount > 0 && videoCount > 0) {
                titleText = `Images & Videos (${imageCount} + ${videoCount})`;
            } else if (videoCount > 0) {
                titleText = `Videos (${videoCount})`;
            } else {
                titleText = `Images (${imageCount})`;
            }
            imagesSection.innerHTML = `<div class="gallery-section-title"><i class="fa-solid fa-photo-film"></i> ${titleText}</div>`;
        }
        
        const imagesGrid = document.createElement('div');
        imagesGrid.className = 'gallery-sprites-grid';
        
        // Build media data for the viewer (images and videos together)
        const galleryMedia = visualMedia.map(({ fileName, type }) => ({
            name: fileName,
            url: `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`,
            type: type
        }));
        
        visualMedia.forEach(({ fileName, type }, index) => {
            const mediaUrl = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            const mediaContainer = document.createElement('div');
            mediaContainer.className = 'sprite-item';
            
            if (type === 'video') {
                // Video thumbnail with play icon overlay
                mediaContainer.innerHTML = `
                    <div class="video-thumbnail" title="${escapeHtml(fileName)}">
                        <video src="${mediaUrl}" preload="metadata" muted></video>
                        <div class="video-play-overlay">
                            <i class="fa-solid fa-play"></i>
                        </div>
                    </div>
                `;
                
                // Click handler to open gallery viewer at this video
                mediaContainer.querySelector('.video-thumbnail').addEventListener('click', () => {
                    if (window.openGalleryViewerWithImages) {
                        const charName = activeChar?.name || 'Gallery';
                        window.openGalleryViewerWithImages(galleryMedia, index, charName);
                    } else {
                        window.open(mediaUrl, '_blank');
                    }
                });
            } else {
                // Image thumbnail
                mediaContainer.innerHTML = `
                    <img src="${mediaUrl}" loading="lazy" title="${escapeHtml(fileName)}">
                `;
                
                // Click handler to open gallery viewer at this image
                mediaContainer.querySelector('img').addEventListener('click', () => {
                    if (window.openGalleryViewerWithImages) {
                        const charName = activeChar?.name || 'Gallery';
                        window.openGalleryViewerWithImages(galleryMedia, index, charName);
                    } else {
                        window.open(mediaUrl, '_blank');
                    }
                });
            }
            
            imagesGrid.appendChild(mediaContainer);
        });
        
        imagesSection.appendChild(imagesGrid);
        grid.appendChild(imagesSection);
    }
    
    // Show empty state if no media at all
    if (imageFiles.length === 0 && videoFiles.length === 0 && audioFiles.length === 0) {
        renderSimpleEmpty(grid, 'No media found.');
    }
}

// ========================================
// LEGACY FOLDER MIGRATION
// Helps users move images from old "CharName" folders to new "CharName_uuid" folders
// ========================================

/**
 * Check if there are files in the legacy (non-UUID) folder for a character
 * @param {object} char - Character object
 * @returns {Promise<{hasLegacy: boolean, files: string[], legacyFolder: string, currentFolder: string}>}
 */
async function checkLegacyFolder(char) {
    const result = {
        hasLegacy: false,
        files: [],
        legacyFolder: char.name,
        currentFolder: getGalleryFolderName(char)
    };
    
    // Only relevant if unique folders are enabled and character has gallery_id
    if (!getSetting('uniqueGalleryFolders')) return result;
    const galleryId = getCharacterGalleryId(char);
    if (!galleryId) return result;
    
    // If legacyFolder and currentFolder are the same, no legacy folder exists
    if (result.legacyFolder === result.currentFolder) return result;
    
    try {
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { 
            folder: result.legacyFolder, 
            type: 7 
        });
        
        if (response.ok) {
            const files = await response.json();
            if (files && files.length > 0) {
                // Filter to only image files
                result.files = files.filter(f => 
                    f.match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i)
                );
                result.hasLegacy = result.files.length > 0;
            }
        }
    } catch (e) {
        console.warn('[LegacyFolder] Error checking legacy folder:', e);
    }
    
    return result;
}

/**
 * Update the legacy folder button visibility based on whether legacy files exist
 * @param {object} char - Character object
 */
async function updateLegacyFolderButton(char) {
    const btn = document.getElementById('checkLegacyFolderBtn');
    const countSpan = document.getElementById('legacyFolderCount');
    
    if (!btn) return;
    
    // Hide by default
    btn.classList.add('hidden');
    
    // Check for legacy files
    const legacyInfo = await checkLegacyFolder(char);
    
    if (legacyInfo.hasLegacy) {
        // Show indicator with count
        if (countSpan) {
            countSpan.textContent = legacyInfo.files.length;
        }
        btn.classList.remove('hidden');
        btn.title = `${legacyInfo.files.length} image${legacyInfo.files.length > 1 ? 's' : ''} in legacy folder "${legacyInfo.legacyFolder}" - Click to migrate`;
    }
}

/**
 * Show modal with legacy folder images for selective migration
 * @param {object} char - Character object
 */
async function showLegacyFolderModal(char) {
    const legacyInfo = await checkLegacyFolder(char);
    
    if (!legacyInfo.hasLegacy) {
        showToast('No legacy images found', 'info');
        return;
    }
    
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'legacyFolderModal';
    
    const safeLegacyFolder = sanitizeFolderName(legacyInfo.legacyFolder);
    
    modal.innerHTML = `
        <div class="confirm-modal-content" style="max-width: 800px; max-height: 90vh;">
            <div class="confirm-modal-header" style="background: linear-gradient(135deg, rgba(74, 158, 255, 0.2) 0%, rgba(52, 120, 200, 0.2) 100%);">
                <h3 style="border: none; padding: 0; margin: 0;">
                    <i class="fa-solid fa-folder-tree" style="color: var(--accent-color);"></i>
                    Legacy Folder Migration
                </h3>
                <button class="close-confirm-btn" id="closeLegacyModal">&times;</button>
            </div>
            <div class="confirm-modal-body" style="padding: 15px;">
                <div style="margin-bottom: 15px; padding: 12px; background: rgba(74, 158, 255, 0.1); border-radius: 8px; border: 1px solid rgba(74, 158, 255, 0.3);">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                        <i class="fa-solid fa-info-circle" style="color: var(--accent-color);"></i>
                        <strong style="color: var(--text-primary);">Images in Old Folder Format</strong>
                    </div>
                    <p style="margin: 0; color: var(--text-secondary); font-size: 13px;">
                        These images are stored in the legacy folder <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${escapeHtml(legacyInfo.legacyFolder)}</code>. 
                        Select images to move to the new unique folder <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${escapeHtml(legacyInfo.currentFolder)}</code>.
                    </p>
                </div>
                
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-primary);">
                        <input type="checkbox" id="legacySelectAll" style="accent-color: var(--accent-color);">
                        <span>Select All (<span id="legacySelectedCount">0</span>/${legacyInfo.files.length})</span>
                    </label>
                    <div style="display: flex; gap: 8px;">
                        <button class="action-btn secondary small" id="legacyRefreshBtn" title="Refresh file list">
                            <i class="fa-solid fa-sync"></i>
                        </button>
                    </div>
                </div>
                
                <div id="legacyImagesGrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; max-height: 400px; overflow-y: auto; padding: 5px;">
                    ${legacyInfo.files.map(fileName => `
                        <div class="legacy-image-item" data-filename="${escapeHtml(fileName)}" style="position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer; border: 2px solid transparent; transition: all 0.2s;">
                            <img src="/user/images/${encodeURIComponent(safeLegacyFolder)}/${encodeURIComponent(fileName)}" 
                                 style="width: 100%; height: 100%; object-fit: cover;"
                                 loading="lazy"
                                 onerror="this.src='/img/No-Image-Placeholder.svg'">
                            <div class="legacy-checkbox" style="position: absolute; top: 5px; left: 5px; width: 22px; height: 22px; background: rgba(0,0,0,0.6); border-radius: 4px; display: flex; align-items: center; justify-content: center;">
                                <input type="checkbox" class="legacy-file-checkbox" data-filename="${escapeHtml(fileName)}" style="accent-color: var(--accent-color); width: 16px; height: 16px; cursor: pointer;">
                            </div>
                            <div style="position: absolute; bottom: 0; left: 0; right: 0; padding: 4px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); font-size: 10px; color: white; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                ${escapeHtml(fileName)}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="confirm-modal-footer" style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="action-btn secondary" id="cancelLegacyBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn primary" id="moveSelectedLegacyBtn" disabled>
                    <i class="fa-solid fa-arrow-right"></i> Move Selected
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Setup event handlers
    const closeModal = () => {
        modal.remove();
    };
    
    modal.querySelector('#closeLegacyModal').addEventListener('click', closeModal);
    modal.querySelector('#cancelLegacyBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    
    // Escape key handler
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
    
    // Update selected count
    const updateSelectedCount = () => {
        const checkboxes = modal.querySelectorAll('.legacy-file-checkbox');
        const checked = modal.querySelectorAll('.legacy-file-checkbox:checked');
        const countSpan = modal.querySelector('#legacySelectedCount');
        const moveBtn = modal.querySelector('#moveSelectedLegacyBtn');
        const selectAllCheckbox = modal.querySelector('#legacySelectAll');
        
        if (countSpan) countSpan.textContent = checked.length;
        if (moveBtn) moveBtn.disabled = checked.length === 0;
        if (selectAllCheckbox) selectAllCheckbox.checked = checked.length === checkboxes.length && checkboxes.length > 0;
        
        // Update visual selection state
        modal.querySelectorAll('.legacy-image-item').forEach(item => {
            const checkbox = item.querySelector('.legacy-file-checkbox');
            if (checkbox?.checked) {
                item.style.borderColor = 'var(--accent-color)';
                item.style.boxShadow = '0 0 10px rgba(74, 158, 255, 0.3)';
            } else {
                item.style.borderColor = 'transparent';
                item.style.boxShadow = 'none';
            }
        });
    };
    
    // Click on image item to toggle checkbox
    modal.querySelectorAll('.legacy-image-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return; // Don't double-toggle
            const checkbox = item.querySelector('.legacy-file-checkbox');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
                updateSelectedCount();
            }
        });
    });
    
    // Checkbox change events
    modal.querySelectorAll('.legacy-file-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', updateSelectedCount);
    });
    
    // Select all
    modal.querySelector('#legacySelectAll').addEventListener('change', (e) => {
        modal.querySelectorAll('.legacy-file-checkbox').forEach(cb => {
            cb.checked = e.target.checked;
        });
        updateSelectedCount();
    });
    
    // Refresh button
    modal.querySelector('#legacyRefreshBtn').addEventListener('click', async () => {
        closeModal();
        await showLegacyFolderModal(char);
    });
    
    // Move selected button
    modal.querySelector('#moveSelectedLegacyBtn').addEventListener('click', async () => {
        const selectedFiles = Array.from(modal.querySelectorAll('.legacy-file-checkbox:checked'))
            .map(cb => cb.dataset.filename);
        
        if (selectedFiles.length === 0) {
            showToast('No files selected', 'info');
            return;
        }
        
        const moveBtn = modal.querySelector('#moveSelectedLegacyBtn');
        const originalHtml = moveBtn.innerHTML;
        moveBtn.disabled = true;
        moveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Moving...';
        
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < selectedFiles.length; i++) {
            const fileName = selectedFiles[i];
            moveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${i + 1}/${selectedFiles.length}`;
            
            const result = await moveImageToFolder(
                legacyInfo.legacyFolder, 
                legacyInfo.currentFolder, 
                fileName, 
                true // delete source
            );
            
            if (result.success) {
                successCount++;
            } else {
                errorCount++;
                console.error(`Failed to move ${fileName}:`, result.error);
            }
        }
        
        closeModal();
        
        if (successCount > 0) {
            showToast(`Moved ${successCount} image${successCount > 1 ? 's' : ''} to unique folder`, 'success');
            // Refresh gallery view
            fetchCharacterImages(char);
            // Update legacy button
            updateLegacyFolderButton(char);
        }
        
        if (errorCount > 0) {
            showToast(`Failed to move ${errorCount} image${errorCount > 1 ? 's' : ''}`, 'error');
        }
    });
}

function openModal(char) {
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
        const modal = document.getElementById('charModal');
        if (modal) {
            const modalBody = modal.querySelector('.modal-body');
            if (modalBody) modalBody.scrollTop = 0;
            getTabPanes().forEach(pane => {
                pane.scrollTop = 0;
            });
        }
    }
    activeChar = char;
    // ... existing ... 
    const imgPath = getCharacterAvatarUrl(char.avatar);
    
    document.getElementById('modalImage').src = imgPath;
    document.getElementById('modalTitle').innerText = char.name;
    
    // Reset/hide legacy folder button (will be updated when Gallery tab is clicked)
    const legacyBtn = document.getElementById('checkLegacyFolderBtn');
    if (legacyBtn) {
        legacyBtn.classList.add('hidden');
    }
    
    // Update favorite button state
    updateFavoriteButtonUI(isCharacterFavorite(char));
    
    // Update per-character media localization toggle with override indicator
    const charLocalizeToggle = document.getElementById('charLocalizeToggle');
    const localizeToggleLabel = document.querySelector('.localize-toggle');
    if (charLocalizeToggle && char.avatar) {
        const status = getMediaLocalizationStatus(char.avatar);
        charLocalizeToggle.checked = status.isEnabled;
        
        // Update visual indicator for override status
        if (localizeToggleLabel) {
            localizeToggleLabel.classList.toggle('has-override', status.hasOverride);
            
            // Update tooltip to explain the status
            if (status.hasOverride) {
                const overrideType = status.isEnabled ? 'ENABLED' : 'DISABLED';
                const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
                localizeToggleLabel.title = `Override: ${overrideType} for this character (global is ${globalStatus})`;
            } else {
                const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
                localizeToggleLabel.title = `Using global setting (${globalStatus})`;
            }
        }
    }

    // Dates/Tokens
    let dateDisplay = 'Unknown';
    if (char.date_added) {
        const d = new Date(Number(char.date_added));
        if (!isNaN(d.getTime())) dateDisplay = d.toLocaleDateString();
    } else {
        const rawCreateDate = getCharacterCreateDateValue(char);
        if (rawCreateDate) {
            const d = new Date(rawCreateDate);
            if (!isNaN(d.getTime())) dateDisplay = formatDateTime(rawCreateDate);
            else if (rawCreateDate.length < 20) dateDisplay = rawCreateDate;
        }
    }
    
    document.getElementById('modalDate').innerText = dateDisplay;

    // Author
    const author = char.creator || (char.data ? char.data.creator : "") || "";
    const authContainer = document.getElementById('modalAuthorContainer');
    const authorEl = document.getElementById('modalAuthor');
    if (author && authContainer) {
        authorEl.innerText = author;
        authorEl.onclick = (e) => {
            e.preventDefault();
            modal.classList.add('hidden');
            filterLocalByCreator(author);
        };
        authContainer.style.display = 'inline';
    } else if (authContainer) {
        authContainer.style.display = 'none';
    }

    // ChubAI Link Indicator
    updateChubLinkIndicator(char);

    // ChubAI Tagline (subtle, optional)
    const taglineRow = document.getElementById('modalChubTaglineRow');
    const taglineEl = document.getElementById('modalChubTagline');
    const chubTagline = char?.data?.extensions?.chub?.tagline || char?.extensions?.chub?.tagline || '';
    if (taglineRow && taglineEl) {
        taglineRow.classList.remove('expanded');
        taglineRow.setAttribute('aria-expanded', 'false');
        taglineRow.setAttribute('role', 'button');
        taglineRow.onclick = () => {
            const isExpanded = taglineRow.classList.toggle('expanded');
            taglineRow.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        };
        const showTagline = getSetting('showChubTagline') !== false;
        if (showTagline && chubTagline) {
            taglineEl.innerHTML = sanitizeTaglineHtml(chubTagline, char.name);
            taglineRow.style.display = 'block';
        } else {
            taglineEl.textContent = '';
            taglineRow.style.display = 'none';
        }
    }

    // Creator Notes - Secure rendering with DOMPurify + sandboxed iframe
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');

    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        // Store raw content for fullscreen expand feature
        window.currentCreatorNotesContent = creatorNotes;
        // Use the shared secure rendering function
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
        // Initialize handlers for this modal instance
        initCreatorNotesHandlers();
        // Show/hide expand button based on content length
        const expandBtn = document.getElementById('creatorNotesExpandBtn');
        if (expandBtn) {
            const lineCount = (creatorNotes.match(/\n/g) || []).length + 1;
            const charCount = creatorNotes.length;
            const showExpand = lineCount >= CreatorNotesConfig.MIN_LINES_FOR_EXPAND || 
                               charCount >= CreatorNotesConfig.MIN_CHARS_FOR_EXPAND;
            expandBtn.style.display = showExpand ? 'flex' : 'none';
        }
    } else if (notesBox) {
        notesBox.style.display = 'none';
        window.currentCreatorNotesContent = null;
    }

    // Description/First Message
    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";
    
    // Store raw content for fullscreen expand feature
    window.currentDescriptionContent = desc || null;
    window.currentFirstMesContent = firstMes || null;
    
    // Details tab uses rich HTML rendering (initially without localization for instant display)
    document.getElementById('modalDescription').innerHTML = formatRichText(desc, char.name);
    document.getElementById('modalFirstMes').innerHTML = formatRichText(firstMes, char.name);

    // Alternate Greetings
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    const altBox = document.getElementById('modalAltGreetingsBox');
    
    // Store raw content for fullscreen expand feature
    window.currentAltGreetingsContent = (altGreetings && altGreetings.length > 0) ? altGreetings : null;
    
    if (altBox) {
        if (altGreetings && altGreetings.length > 0) {
            document.getElementById('altGreetingsCount').innerText = altGreetings.length;
            const listHTML = altGreetings.map((g, i) => 
                `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.1);"><strong style="color:var(--accent);">#${i+1}:</strong> <span>${formatRichText((g || '').trim(), char.name)}</span></div>`
            ).join('');
            document.getElementById('modalAltGreetings').innerHTML = listHTML;
            altBox.style.display = 'block';
        } else {
            altBox.style.display = 'none';
        }
    }
    
    // Initialize content expand handlers
    initContentExpandHandlers();
    
    // Apply media localization asynchronously (if enabled)
    // This updates the already-rendered content with localized URLs
    applyMediaLocalizationToModal(char, desc, firstMes, altGreetings, creatorNotes);
    
    // Embedded Lorebook
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    const lorebookBox = document.getElementById('modalLorebookBox');
    
    if (lorebookBox) {
        if (characterBook && characterBook.entries && characterBook.entries.length > 0) {
            document.getElementById('lorebookEntryCount').innerText = characterBook.entries.length;
            const lorebookHTML = renderLorebookEntriesHtml(characterBook.entries)
            document.getElementById('modalLorebookContent').innerHTML = lorebookHTML;
            lorebookBox.style.display = 'block';
        } else {
            lorebookBox.style.display = 'none';
        }
    }
    
    // Edit Form - Basic
    document.getElementById('editName').value = char.name;
    document.getElementById('editDescription').value = desc;
    document.getElementById('editFirstMes').value = firstMes;
    
    // Edit Form - Extended Fields
    const personality = char.personality || (char.data ? char.data.personality : "") || "";
    const scenario = char.scenario || (char.data ? char.data.scenario : "") || "";
    const mesExample = char.mes_example || (char.data ? char.data.mes_example : "") || "";
    const systemPrompt = char.system_prompt || (char.data ? char.data.system_prompt : "") || "";
    const postHistoryInstructions = char.post_history_instructions || (char.data ? char.data.post_history_instructions : "") || "";
    const creatorNotesEdit = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const charVersion = char.character_version || (char.data ? char.data.character_version : "") || "";
    
    // Tags: always store as array, never as comma-delimited string
    const rawTags = char.tags || (char.data ? char.data.tags : []) || [];
    if (Array.isArray(rawTags)) {
        _editTagsArray = [...rawTags];
    } else if (typeof rawTags === "string") {
        _editTagsArray = rawTags.split(',').map(t => t.trim()).filter(t => t);
    } else {
        _editTagsArray = [];
    }
    
    document.getElementById('editCreator').value = author;
    document.getElementById('editVersion').value = charVersion;
    document.getElementById('editPersonality').value = personality;
    document.getElementById('editScenario').value = scenario;
    document.getElementById('editMesExample').value = mesExample;
    document.getElementById('editSystemPrompt').value = systemPrompt;
    document.getElementById('editPostHistoryInstructions').value = postHistoryInstructions;
    document.getElementById('editCreatorNotes').value = creatorNotesEdit;
    
    // Populate alternate greetings editor
    populateAltGreetingsEditor(altGreetings);
    
    // Populate lorebook editor
    populateLorebookEditor(characterBook);
    
    // Store raw data for cancel/restore
    originalRawData = {
        altGreetings: altGreetings ? [...altGreetings] : [],
        characterBook: characterBook ? JSON.parse(JSON.stringify(characterBook)) : null
    };
    
    // Store original values for diff comparison
    // IMPORTANT: Read values back from the form elements to capture any browser normalization
    // (e.g., line ending changes from \r\n to \n)
    originalValues = {
        name: document.getElementById('editName').value,
        description: document.getElementById('editDescription').value,
        first_mes: document.getElementById('editFirstMes').value,
        creator: document.getElementById('editCreator').value,
        character_version: document.getElementById('editVersion').value,
        tagsArray: [..._editTagsArray], // tags stored as array only, no string intermediary
        personality: document.getElementById('editPersonality').value,
        scenario: document.getElementById('editScenario').value,
        mes_example: document.getElementById('editMesExample').value,
        system_prompt: document.getElementById('editSystemPrompt').value,
        post_history_instructions: document.getElementById('editPostHistoryInstructions').value,
        creator_notes: document.getElementById('editCreatorNotes').value,
        alternate_greetings: getAltGreetingsFromEditor(),
        character_book: getCharacterBookFromEditor()
    };
    
    // Lock edit fields by default
    setEditLock(true);
    
    // Render tags in sidebar (will be made editable when edit is unlocked)
    renderSidebarTags(getTags(char));
    
    // Reset Tabs
    deactivateAllTabs();
    document.querySelector('.tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('pane-details').classList.add('active');

    updateMobileChatButtonVisibility();
    
    // Reset scroll positions to top
    resetTabScrollPositions();

    // Trigger Image Fetch for 'Gallery' tab logic
    // We defer this slightly or just prepare it
    const galleryTabBtn = document.querySelector('.tab-btn[data-tab="gallery"]');
    if (galleryTabBtn) {
        galleryTabBtn.onclick = () => {
             // Switch tabs
            deactivateAllTabs();
            galleryTabBtn.classList.add('active');
            document.getElementById('pane-gallery').classList.add('active');
            
            // Fetch - pass character object for unique folder support
            fetchCharacterImages(char);
            
            // Check for legacy folder images (async, updates button visibility)
            updateLegacyFolderButton(char);

            // Show warning if uniqueGalleryFolders is enabled but character has no gallery_id
            updateGalleryIdWarning(char);
        };
    }
    
    // Setup legacy folder button handler
    const legacyFolderBtn = document.getElementById('checkLegacyFolderBtn');
    if (legacyFolderBtn) {
        legacyFolderBtn.onclick = () => showLegacyFolderModal(char);
    }
    
    // Chats tab logic
    const chatsTabBtn = document.querySelector('.tab-btn[data-tab="chats"]');
    if (chatsTabBtn) {
        chatsTabBtn.onclick = () => {
            // Switch tabs
            deactivateAllTabs();
            chatsTabBtn.classList.add('active');
            document.getElementById('pane-chats').classList.add('active');
            
            // Fetch chats
            fetchCharacterChats(char);
        };
    }

    // Related tab logic
    const relatedTabBtn = document.querySelector('.tab-btn[data-tab="related"]');
    if (relatedTabBtn) {
        relatedTabBtn.onclick = () => {
            // Switch tabs
            deactivateAllTabs();
            relatedTabBtn.classList.add('active');
            document.getElementById('pane-related').classList.add('active');
            
            // Find related characters
            findRelatedCharacters(char);
        };
    }

    // Info tab logic (developer/debugging feature)
    const infoTabBtn = document.getElementById('infoTabBtn');
    if (infoTabBtn) {
        // Show/hide based on setting - explicitly check for true (default is false/hidden)
        const showInfoTab = getSetting('showInfoTab') === true;
        if (showInfoTab) {
            infoTabBtn.classList.remove('hidden');
        } else {
            infoTabBtn.classList.add('hidden');
        }
        
        infoTabBtn.onclick = () => {
            // Switch tabs
            deactivateAllTabs();
            infoTabBtn.classList.add('active');
            document.getElementById('pane-info').classList.add('active');
            
            // Populate info content
            populateInfoTab(char);
        };
    }

    // Show modal
    modal.classList.remove('hidden');
    
    // Reset scroll positions after modal is visible (using setTimeout to ensure DOM is ready)
    setTimeout(() => resetTabScrollPositions(), 0);
}

function closeModal() {
    modal.classList.add('hidden');
    activeChar = null;
    // Reset edit lock state
    isEditLocked = true;
    originalValues = {};
    originalRawData = {};
    
    // Release window globals holding rich text content (can be large)
    window.currentCreatorNotesContent = null;
    window.currentDescriptionContent = null;
    window.currentFirstMesContent = null;
    window.currentAltGreetingsContent = null;
    
    // Clear alt greetings HTML
    const altGreetingsEl = document.getElementById('modalAltGreetings');
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';
    
    // Clear creator notes iframe — disconnect ResizeObserver and release its document
    const creatorNotesEl = document.getElementById('modalCreatorNotes');
    cleanupCreatorNotesContainer(creatorNotesEl);
    
    // Clear tagline content
    const taglineEl = document.getElementById('modalChubTagline');
    if (taglineEl) taglineEl.textContent = '';
    
    // Check if we need to restore duplicates modal
    if (duplicateModalState.wasOpen) {
        restoreDuplicateModalState();
        duplicateModalState.wasOpen = false; // Reset flag
    }
    // Check if we need to restore bulk summary modal
    else if (bulkSummaryModalState.wasOpen) {
        restoreBulkSummaryModalState();
        bulkSummaryModalState.wasOpen = false; // Reset flag
    }
}

// ==================== INFO TAB (Developer) ====================

/**
 * Populate the Info tab with character metadata and mappings
 * @param {Object} char - Character object
 */
function populateInfoTab(char) {
    const container = document.getElementById('infoTabContent');
    if (!container || !char) return;
    
    // Gather all the useful debug info
    const charName = char.name || char.data?.name || 'Unknown';
    const avatar = char.avatar || '';
    const galleryFolder = getGalleryFolderName(char);
    const chatsFolder = sanitizeFolderName(charName);
    const chubInfo = getChubLinkInfo(char);
    const galleryId = getCharacterGalleryId(char);
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders');
    const mediaLocStatus = char.avatar ? getMediaLocalizationStatus(char.avatar) : null;
    const isFavorite = isCharacterFavorite(char);
    
    // Get token estimate
    const tokenEstimate = estimateTokens(char);
    
    // Get embedded media URLs count
    const embeddedMediaUrls = findCharacterMediaUrls(char);
    
    // Get lorebook info
    const characterBook = char.character_book || char.data?.character_book;
    const lorebookEntries = characterBook?.entries?.length || 0;
    
    // Get alternate greetings count
    const altGreetings = char.alternate_greetings || char.data?.alternate_greetings || [];
    
    // Build HTML
    let html = '';
    
    // Section: Identity
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-user"></i> Identity</div>
        <div class="info-row">
            <span class="info-label">Display Name</span>
            <span class="info-value">${escapeHtml(charName)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Creator</span>
            <span class="info-value">${escapeHtml(char.creator || char.data?.creator || '(not set)')}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Version</span>
            <span class="info-value">${escapeHtml(char.character_version || char.data?.character_version || '(not set)')}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Favorite</span>
            <span class="info-value">${isFavorite ? '<i class="fa-solid fa-star" style="color: gold;"></i> Yes' : 'No'}</span>
        </div>
    </div>`;
    
    // Section: Files & Paths
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-folder-tree"></i> Files & Paths</div>
        <div class="info-row">
            <span class="info-label">Avatar Filename</span>
            <span class="info-value info-code">${escapeHtml(avatar) || '(none)'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Gallery Folder</span>
            <span class="info-value info-code">/characters/${escapeHtml(galleryFolder)}/</span>
        </div>
        <div class="info-row">
            <span class="info-label">Chats Folder</span>
            <span class="info-value info-code">/chats/${escapeHtml(chatsFolder)}/</span>
        </div>
    </div>`;
    
    // Section: Unique Gallery ID
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-fingerprint"></i> Unique Gallery</div>
        <div class="info-row">
            <span class="info-label">Feature Enabled</span>
            <span class="info-value">${uniqueFoldersEnabled ? '<i class="fa-solid fa-check" style="color: #2ecc71;"></i> Yes' : '<i class="fa-solid fa-times" style="color: #888;"></i> No'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Gallery ID</span>
            <span class="info-value info-code">${galleryId ? escapeHtml(galleryId) : '<span style="color: #888;">(not assigned)</span>'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Unique Folder Name</span>
            <span class="info-value info-code">${galleryId ? escapeHtml(buildUniqueGalleryFolderName(char)) : '<span style="color: #888;">(using standard name)</span>'}</span>
        </div>
    </div>`;
    
    // Section: ChubAI Link
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-link"></i> ChubAI Link</div>
        <div class="info-row">
            <span class="info-label">Linked</span>
            <span class="info-value">${chubInfo ? '<i class="fa-solid fa-check" style="color: #2ecc71;"></i> Yes' : '<i class="fa-solid fa-times" style="color: #888;"></i> No'}</span>
        </div>`;
    if (chubInfo) {
        html += `<div class="info-row">
            <span class="info-label">Full Path</span>
            <span class="info-value info-code">${escapeHtml(chubInfo.fullPath || '')}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Chub ID</span>
            <span class="info-value info-code">${escapeHtml(String(chubInfo.id || ''))}</span>
        </div>`;
    }
    html += `</div>`;
    
    // Section: Media Localization
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-images"></i> Media Localization</div>
        <div class="info-row">
            <span class="info-label">Global Setting</span>
            <span class="info-value">${mediaLocStatus?.globalEnabled ? '<i class="fa-solid fa-check" style="color: #2ecc71;"></i> Enabled' : '<i class="fa-solid fa-times" style="color: #888;"></i> Disabled'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Per-Character Override</span>
            <span class="info-value">${mediaLocStatus?.hasOverride ? (mediaLocStatus.isEnabled ? 'Force ON' : 'Force OFF') : '(none)'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Effective State</span>
            <span class="info-value">${mediaLocStatus?.isEnabled ? '<i class="fa-solid fa-check" style="color: #2ecc71;"></i> Active' : '<i class="fa-solid fa-times" style="color: #888;"></i> Inactive'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Embedded Media URLs</span>
            <span class="info-value">${embeddedMediaUrls.length} URL(s) found</span>
        </div>
    </div>`;
    
    // Section: Content Stats
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-chart-bar"></i> Content Stats</div>
        <div class="info-row">
            <span class="info-label">Est. Token Count</span>
            <span class="info-value">~${tokenEstimate.toLocaleString()} tokens</span>
        </div>
        <div class="info-row">
            <span class="info-label">Alternate Greetings</span>
            <span class="info-value">${altGreetings.length}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Lorebook Entries</span>
            <span class="info-value">${lorebookEntries}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Tags</span>
            <span class="info-value">${(getTags(char) || []).length}</span>
        </div>
    </div>`;
    
    // Section: Spec Info
    const spec = char.spec || char.data?.spec || 'unknown';
    const specVersion = char.spec_version || char.data?.spec_version || '';
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-file-code"></i> Card Spec</div>
        <div class="info-row">
            <span class="info-label">Spec</span>
            <span class="info-value info-code">${escapeHtml(spec)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Spec Version</span>
            <span class="info-value info-code">${escapeHtml(specVersion) || '(not set)'}</span>
        </div>
    </div>`;
    
    // Section: Date Info
    const createDateRaw = getCharacterCreateDateValue(char);
    const dateCreated = createDateRaw ? new Date(createDateRaw) : null;
    const dateModified = char.date_added ? new Date(Number(char.date_added)) : null;
    const dateLastChat = char.date_last_chat ? new Date(Number(char.date_last_chat)) : null;
    
    html += `<div class="info-section">
        <div class="info-section-title"><i class="fa-solid fa-calendar"></i> Dates</div>
        <div class="info-row">
            <span class="info-label">Date Created</span>
            <span class="info-value">${formatDateTime(createDateRaw)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Last Modified</span>
            <span class="info-value">${dateModified && !isNaN(dateModified.getTime()) ? formatDateTime(dateModified.getTime()) : '(not available)'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Last Chat</span>
            <span class="info-value">${dateLastChat && !isNaN(dateLastChat.getTime()) ? formatDateTime(dateLastChat.getTime()) : '(not available)'}</span>
        </div>
    </div>`;
    
    // Section: Raw Extensions (if any)
    const extensions = char.data?.extensions || char.extensions || {};
    const extensionKeys = Object.keys(extensions).filter(k => k !== 'chub'); // Exclude chub as it's shown separately
    if (extensionKeys.length > 0) {
        html += `<div class="info-section">
            <div class="info-section-title"><i class="fa-solid fa-puzzle-piece"></i> Extensions</div>`;
        for (const key of extensionKeys) {
            const value = extensions[key];
            const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
            html += `<div class="info-row">
                <span class="info-label info-code">${escapeHtml(key)}</span>
                <span class="info-value info-code" style="word-break: break-all;">${escapeHtml(displayValue.substring(0, 100))}${displayValue.length > 100 ? '...' : ''}</span>
            </div>`;
        }
        html += `</div>`;
    }
    
    // Section: Actions
    html += `<div class="info-section info-actions-section">
        <div class="info-section-title"><i class="fa-solid fa-wrench"></i> Actions</div>
        <div class="info-actions">
            <button type="button" class="action-btn secondary small" id="copyRawCardDataBtn">
                <i class="fa-solid fa-copy"></i> Copy Raw Card Data
            </button>
        </div>
    </div>`;
    
    container.innerHTML = html;
    
    // Attach event handler for copy button (use activeChar for most up-to-date reference)
    const copyBtn = document.getElementById('copyRawCardDataBtn');
    if (copyBtn) {
        copyBtn.onclick = () => copyRawCardData(activeChar);
    }
}

/**
 * Copy the raw character card data to clipboard as JSON
 * @param {Object} char - Character object (optional, falls back to activeChar)
 */
function copyRawCardData(char) {
    // Use activeChar as fallback
    const character = char || activeChar;
    
    if (!character) {
        showToast('No character data available', 'error');
        return;
    }
    
    try {
        // Build the complete card data structure
        const cardData = {
            // Include spec info
            spec: character.spec || character.data?.spec || 'chara_card_v2',
            spec_version: character.spec_version || character.data?.spec_version || '2.0',
            // Include the data object (main character definition)
            data: character.data || {
                name: character.name,
                description: character.description,
                personality: character.personality,
                scenario: character.scenario,
                first_mes: character.first_mes,
                mes_example: character.mes_example,
                creator_notes: character.creator_notes,
                system_prompt: character.system_prompt,
                post_history_instructions: character.post_history_instructions,
                alternate_greetings: character.alternate_greetings || [],
                tags: character.tags || [],
                creator: character.creator,
                character_version: character.character_version,
                extensions: character.extensions || {},
                character_book: character.character_book || null,
            },
            // Include ST-specific metadata
            _meta: {
                avatar: character.avatar,
                date_added: character.date_added,
                create_date: character.create_date,
            }
        };
        
        const jsonString = JSON.stringify(cardData, null, 2);
        
        // Try modern clipboard API first, fall back to legacy method
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonString).then(() => {
                showToast('Card data copied to clipboard', 'success');
            }).catch(err => {
                console.error('Clipboard API failed:', err);
                // Fallback to legacy method
                copyToClipboardFallback(jsonString);
            });
        } else {
            // Use fallback for older browsers or non-secure contexts
            copyToClipboardFallback(jsonString);
        }
    } catch (error) {
        console.error('Error preparing card data:', error);
        showToast('Error preparing card data', 'error');
    }
}

/**
 * Fallback clipboard copy using textarea element
 * @param {string} text - Text to copy
 */
function copyToClipboardFallback(text) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        
        if (success) {
            showToast('Card data copied to clipboard', 'success');
        } else {
            showToast('Failed to copy to clipboard', 'error');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        showToast('Failed to copy to clipboard', 'error');
    }
}

// ==================== RELATED CHARACTERS ====================

// Common English words to skip when extracting keywords (prepositions, conjunctions, etc.)
const COMMON_SKIP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'their', 
    'will', 'would', 'could', 'should', 'have', 'has', 'had', 'been', 'being', 
    'very', 'just', 'also', 'only', 'some', 'other', 'more', 'most', 'such', 
    'than', 'then', 'when', 'where', 'which', 'while', 'about', 'after', 
    'before', 'between', 'under', 'over', 'into', 'through', 'during', 
    'including', 'until', 'against', 'among', 'throughout', 'despite', 
    'towards', 'upon', 'concerning', 'like', 'what', 'they', 'them', 'there',
    'here', 'these', 'those', 'each', 'every', 'both', 'either', 'neither',
    'because', 'since', 'although', 'though', 'even', 'still', 'already'
]);

/**
 * Extract keywords from text for content-based matching
 * Extracts significant proper nouns (capitalized words) that might indicate
 * shared universe, characters, or locations
 */
function extractContentKeywords(text) {
    if (!text) return new Set();
    
    const keywords = new Set();
    
    // Extract capitalized proper nouns (likely character/place names)
    // Match sequences of capitalized words (e.g., "Genshin Impact", "Harry Potter")
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (properNouns) {
        properNouns.forEach(noun => {
            const lower = noun.toLowerCase();
            // Skip common words and very short names
            if (noun.length > 3 && !COMMON_SKIP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        });
    }
    
    return keywords;
}

// Cache for tag frequency (how many characters have each tag)
let tagFrequencyCache = null;
let tagFrequencyCacheTime = 0;
const TAG_FREQUENCY_CACHE_TTL = 60000; // 1 minute

/**
 * Build/get cached tag frequency map
 * Returns Map of tag -> count of characters with that tag
 */
function getTagFrequencies() {
    const now = Date.now();
    if (tagFrequencyCache && (now - tagFrequencyCacheTime) < TAG_FREQUENCY_CACHE_TTL) {
        return tagFrequencyCache;
    }
    
    const frequencies = new Map();
    for (const char of allCharacters) {
        const tags = getTags(char);
        for (const tag of tags) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag) {
                frequencies.set(normalizedTag, (frequencies.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    tagFrequencyCache = frequencies;
    tagFrequencyCacheTime = now;
    return frequencies;
}

/**
 * Calculate the weight of a tag based on its rarity (inverse frequency)
 * Rare tags are worth more than common tags
 * @param {string} tag - The tag to calculate weight for
 * @param {Map} frequencies - Tag frequency map
 * @param {number} totalChars - Total number of characters
 * @returns {number} Weight value (higher = rarer/more valuable)
 */
function calculateTagWeight(tag, frequencies, totalChars) {
    const count = frequencies.get(tag) || 1;
    const frequency = count / totalChars;
    
    // Inverse frequency scoring with log scaling
    // Very rare (1-2 chars): ~20-25 points
    // Rare (3-10 chars): ~12-18 points  
    // Uncommon (11-50 chars): ~6-12 points
    // Common (51-200 chars): ~3-6 points
    // Very common (200+ chars): ~1-3 points
    
    // Using inverse log: -log(frequency) gives higher scores for lower frequencies
    // Base weight + inverse frequency bonus
    const baseWeight = 2;
    const rarityBonus = Math.max(0, -Math.log10(frequency) * 6);
    
    return Math.round(baseWeight + rarityBonus);
}

/**
 * Calculate relatedness score between two characters
 * Returns object with total score and breakdown by category
 */
function calculateRelatednessScore(sourceChar, targetChar, options = {}) {
    const { useTags = true, useCreator = true, useContent = true } = options;
    
    let score = 0;
    const breakdown = { tags: 0, creator: 0, content: 0, sharedTagCount: 0, topTags: [] };
    const matchReasons = [];
    
    // 1. Tag overlap (highest weight - tags are explicit categorization)
    if (useTags) {
        const sourceTags = new Set(getTags(sourceChar).map(t => t.toLowerCase().trim()));
        const targetTags = new Set(getTags(targetChar).map(t => t.toLowerCase().trim()));
        
        const sharedTags = [...sourceTags].filter(t => t && targetTags.has(t));
        
        if (sharedTags.length > 0) {
            // Get tag frequencies for rarity-based weighting
            const frequencies = getTagFrequencies();
            const totalChars = allCharacters.length;
            
            // Calculate weighted score based on tag rarity
            let tagScore = 0;
            const tagWeights = [];
            
            for (const tag of sharedTags) {
                const weight = calculateTagWeight(tag, frequencies, totalChars);
                tagScore += weight;
                tagWeights.push({ tag, weight, count: frequencies.get(tag) || 1 });
            }
            
            // Sort by weight descending to show most significant tags first
            tagWeights.sort((a, b) => b.weight - a.weight);
            
            breakdown.tags = tagScore;
            breakdown.sharedTagCount = sharedTags.length;
            breakdown.topTags = tagWeights.slice(0, 3); // Keep top 3 for display
            score += tagScore;
            
            // Build match reason showing most significant shared tags
            if (tagWeights.length === 1) {
                const t = tagWeights[0];
                matchReasons.push(`Shared tag: ${t.tag}${t.count <= 5 ? ' (rare!)' : ''}`);
            } else {
                // Show the most specific/rare tags
                const topTagNames = tagWeights.slice(0, 2).map(t => t.tag);
                const rareCount = tagWeights.filter(t => t.count <= 5).length;
                let reason = `${sharedTags.length} shared tags`;
                if (rareCount > 0) {
                    reason += ` (${rareCount} rare)`;
                }
                reason += `: ${topTagNames.join(', ')}`;
                if (tagWeights.length > 2) reason += '...';
                matchReasons.push(reason);
            }
        }
    }
    
    // 2. Same creator (moderate weight)
    if (useCreator) {
        const sourceCreator = (getCharField(sourceChar, 'creator') || '').toLowerCase().trim();
        const targetCreator = (getCharField(targetChar, 'creator') || '').toLowerCase().trim();
        
        if (sourceCreator && targetCreator && sourceCreator === targetCreator) {
            breakdown.creator = 25;
            score += 25;
            matchReasons.push(`Same creator: ${getCharField(targetChar, 'creator')}`);
        }
    }
    
    // 3. Content/keyword similarity (looks for universe indicators)
    if (useContent) {
        // Extract keywords from source
        const sourceText = [
            getCharField(sourceChar, 'name'),
            getCharField(sourceChar, 'description'),
            getCharField(sourceChar, 'personality'),
            getCharField(sourceChar, 'scenario'),
            getCharField(sourceChar, 'first_mes')
        ].filter(Boolean).join(' ');
        
        const targetText = [
            getCharField(targetChar, 'name'),
            getCharField(targetChar, 'description'),
            getCharField(targetChar, 'personality'),
            getCharField(targetChar, 'scenario'),
            getCharField(targetChar, 'first_mes')
        ].filter(Boolean).join(' ');
        
        const sourceKeywords = extractContentKeywords(sourceText);
        const targetKeywords = extractContentKeywords(targetText);
        
        // Find shared keywords
        const sharedKeywords = [...sourceKeywords].filter(k => targetKeywords.has(k));
        
        if (sharedKeywords.length > 0) {
            // Weight based on keyword rarity/specificity
            const contentScore = Math.min(sharedKeywords.length * 10, 35);
            breakdown.content = contentScore;
            score += contentScore;
            
            // Pick the most interesting keywords to show
            const displayKeywords = sharedKeywords.slice(0, 3).join(', ');
            matchReasons.push(`Shared context: ${displayKeywords}`);
        }
    }
    
    return {
        score,
        breakdown,
        matchReasons
    };
}

/**
 * Find characters related to the given character
 */
function findRelatedCharacters(sourceChar) {
    const resultsEl = document.getElementById('relatedResults');
    if (!resultsEl) return;
    
    resultsEl.innerHTML = '<div class="related-loading"><i class="fa-solid fa-spinner fa-spin"></i> Finding related characters...</div>';
    
    // Get filter options
    const useTags = document.getElementById('relatedFilterTags')?.checked ?? true;
    const useCreator = document.getElementById('relatedFilterCreator')?.checked ?? true;
    const useContent = document.getElementById('relatedFilterContent')?.checked ?? true;
    
    // Use setTimeout to allow UI to update
    setTimeout(() => {
        const sourceAvatar = sourceChar.avatar;
        const related = [];
        
        // Compare against all other characters
        for (const targetChar of allCharacters) {
            // Skip self
            if (targetChar.avatar === sourceAvatar) continue;
            
            const result = calculateRelatednessScore(sourceChar, targetChar, { useTags, useCreator, useContent });
            
            // Only include if there's some relationship
            if (result.score > 0) {
                related.push({
                    char: targetChar,
                    score: result.score,
                    breakdown: result.breakdown,
                    matchReasons: result.matchReasons
                });
            }
        }
        
        // Sort by score descending
        related.sort((a, b) => b.score - a.score);
        
        // Take top results
        const topRelated = related.slice(0, 20);
        
        // Render results
        renderRelatedResults(topRelated, sourceChar);
    }, 10);
}

/**
 * Render the related characters results
 */
function renderRelatedResults(related, sourceChar) {
    const resultsEl = document.getElementById('relatedResults');
    if (!resultsEl) return;
    
    if (related.length === 0) {
        resultsEl.innerHTML = `
            <div class="related-empty">
                <i class="fa-solid fa-users-slash"></i>
                <p>No related characters found</p>
                <span>Try adjusting the filters above or add more tags to this character</span>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    // Group by relationship strength
    // With new scoring: 8 pts/tag, 25 pts/creator, up to 35 pts content
    // Strong: 5+ shared tags (40+), or 3+ tags + creator (49+)
    // Moderate: 2-4 shared tags (16-32), or 1 tag + creator (33)
    // Weak: 1 tag (8), or just content matches
    const strong = related.filter(r => r.score >= 32);  // 4+ shared tags
    const moderate = related.filter(r => r.score >= 16 && r.score < 32);  // 2-3 shared tags
    const weak = related.filter(r => r.score < 16);  // 1 tag or content only
    
    if (strong.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-solid fa-link"></i> Strongly Related (${strong.length})</div>`;
        html += renderRelatedCards(strong);
        html += '</div>';
    }
    
    if (moderate.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-solid fa-link-slash" style="opacity: 0.7;"></i> Moderately Related (${moderate.length})</div>`;
        html += renderRelatedCards(moderate);
        html += '</div>';
    }
    
    if (weak.length > 0) {
        html += `<div class="related-section"><div class="related-section-header"><i class="fa-regular fa-circle-dot"></i> Possibly Related (${weak.length})</div>`;
        html += renderRelatedCards(weak);
        html += '</div>';
    }
    
    resultsEl.innerHTML = html;
    
    // Setup filter change handlers
    setupRelatedFilters(sourceChar);
}

/**
 * Render related character cards
 */
function renderRelatedCards(related) {
    return `<div class="related-cards">${related.map(r => {
        const char = r.char;
        const name = getCharField(char, 'name') || 'Unknown';
        const creator = getCharField(char, 'creator') || '';
        const avatarPath = getCharacterAvatarUrl(char.avatar);
        
        // Build score breakdown pills - show tag count and rarity info
        const pills = [];
        if (r.breakdown.tags > 0) {
            const tagCount = r.breakdown.sharedTagCount || 0;
            // Check if any rare tags (used by <=5 characters)
            const hasRareTags = r.breakdown.topTags?.some(t => t.count <= 5);
            const tagClass = hasRareTags ? 'tags rare' : 'tags';
            const topTagNames = r.breakdown.topTags?.slice(0, 2).map(t => t.tag).join(', ') || '';
            pills.push(`<span class="related-pill ${tagClass}" title="${tagCount} shared tags: ${topTagNames}"><i class="fa-solid fa-tags"></i> ${tagCount}${hasRareTags ? '★' : ''}</span>`);
        }
        if (r.breakdown.creator > 0) pills.push(`<span class="related-pill creator" title="Same creator"><i class="fa-solid fa-user-pen"></i></span>`);
        if (r.breakdown.content > 0) pills.push(`<span class="related-pill content" title="Similar content"><i class="fa-solid fa-file-lines"></i></span>`);
        
        return `
            <div class="related-card" onclick="openRelatedCharacter('${escapeHtml(char.avatar)}')" title="${escapeHtml(r.matchReasons.join('\\n'))}">
                <img class="related-card-avatar" src="${avatarPath}" alt="${escapeHtml(name)}" loading="lazy" 
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <div class="related-card-info">
                    <div class="related-card-name">${escapeHtml(name)}</div>
                    ${creator ? `<div class="related-card-creator">by ${escapeHtml(creator)}</div>` : ''}
                    <div class="related-card-reasons">${r.matchReasons.slice(0, 2).join(' \u2022 ')}</div>
                </div>
                <div class="related-card-score">
                    <div class="related-score-value">${r.score}</div>
                    <div class="related-score-pills">${pills.join('')}</div>
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

/**
 * Setup filter change handlers for related tab
 */
function setupRelatedFilters(sourceChar) {
    const filterIds = ['relatedFilterTags', 'relatedFilterCreator', 'relatedFilterContent'];
    filterIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.onchange = () => findRelatedCharacters(sourceChar);
        }
    });
}

/**
 * Open a related character (close current modal, open new one)
 */
function openRelatedCharacter(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (char) {
        openModal(char);
    }
}

// Make it globally accessible
window.openRelatedCharacter = openRelatedCharacter;

// ==================== DELETE CHARACTER ====================

async function showDeleteConfirmation(char) {
    const charName = getCharacterName(char);
    const avatar = char.avatar || '';
    
    // Get gallery info for this character
    const galleryInfo = await getCharacterGalleryInfo(char);
    const hasImages = galleryInfo.count > 0;
    
    // Only offer gallery deletion when:
    // 1. Unique gallery folders feature is ENABLED
    // 2. Character has a gallery_id (unique gallery)
    // 3. Gallery has images
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders') || false;
    const hasUniqueGallery = !!getCharacterGalleryId(char);
    const canDeleteGallery = uniqueFoldersEnabled && hasImages && hasUniqueGallery;
    
    // Create delete confirmation modal
    const deleteModal = document.createElement('div');
    deleteModal.className = 'confirm-modal';
    deleteModal.id = 'deleteConfirmModal';
    deleteModal.innerHTML = `
        <div class="confirm-modal-content" style="max-width: 450px;">
            <div class="confirm-modal-header" style="background: linear-gradient(135deg, rgba(231, 76, 60, 0.2) 0%, rgba(192, 57, 43, 0.2) 100%);">
                <h3 style="border: none; padding: 0; margin: 0;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #e74c3c;"></i>
                    Delete Character
                </h3>
                <button class="close-confirm-btn" id="closeDeleteModal">&times;</button>
            </div>
            <div class="confirm-modal-body" style="text-align: center;">
                <div style="margin-bottom: 20px;">
                    <img src="${getCharacterAvatarUrl(avatar)}" 
                         alt="${escapeHtml(charName)}" 
                         style="width: 100px; height: 100px; object-fit: cover; border-radius: 12px; border: 3px solid rgba(231, 76, 60, 0.5); margin-bottom: 15px;"
                         onerror="this.src='/img/ai4.png'">
                    <h4 style="margin: 0; color: var(--text-primary);">${escapeHtml(charName)}</h4>
                </div>
                
                ${canDeleteGallery ? `
                    <div style="background: rgba(241, 196, 15, 0.15); border: 1px solid rgba(241, 196, 15, 0.4); border-radius: 8px; padding: 12px; margin-bottom: 15px;">
                        <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: #f1c40f; margin-bottom: 10px;">
                            <i class="fa-solid fa-images"></i>
                            <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px; text-align: left;">
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2);">
                                <input type="radio" name="galleryAction" value="keep" checked style="accent-color: #f1c40f;">
                                <span><strong>Keep gallery files</strong> - Leave in folder</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2);">
                                <input type="radio" name="galleryAction" value="delete" style="accent-color: #e74c3c;">
                                <span><strong>Delete gallery files</strong> - Remove all images</span>
                            </label>
                        </div>
                    </div>
                ` : (hasImages ? `
                    <div style="background: rgba(241, 196, 15, 0.15); border: 1px solid rgba(241, 196, 15, 0.4); border-radius: 8px; padding: 12px; margin-bottom: 15px;">
                        <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: #f1c40f;">
                            <i class="fa-solid fa-images"></i>
                            <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                        </div>
                        <p style="margin: 8px 0 0 0; color: var(--text-secondary); font-size: 13px;">
                            ${!uniqueFoldersEnabled 
                                ? 'Unique gallery folders feature is disabled. Gallery files will not be deleted.'
                                : 'Gallery folder will remain after deletion.'}
                        </p>
                    </div>
                ` : '')}
                
                <p style="color: var(--text-secondary); margin-bottom: 15px;">
                    Are you sure you want to delete this character? This action cannot be undone.
                </p>
                <div style="background: rgba(231, 76, 60, 0.1); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 15px;">
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary);">
                        <input type="checkbox" id="deleteChatsCheckbox" style="accent-color: #e74c3c;">
                        <span>Also delete all chat history with this character</span>
                    </label>
                </div>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="cancelDeleteBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn primary" id="confirmDeleteBtn" style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); box-shadow: 0 2px 8px rgba(231, 76, 60, 0.3);">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(deleteModal);
    
    // Event handlers
    const closeBtn = deleteModal.querySelector('#closeDeleteModal');
    const cancelBtn = deleteModal.querySelector('#cancelDeleteBtn');
    const confirmBtn = deleteModal.querySelector('#confirmDeleteBtn');
    
    const closeDeleteModal = () => {
        deleteModal.remove();
    };
    
    closeBtn.addEventListener('click', closeDeleteModal);
    cancelBtn.addEventListener('click', closeDeleteModal);
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeDeleteModal();
    });
    
    confirmBtn.addEventListener('click', async () => {
        const deleteChats = deleteModal.querySelector('#deleteChatsCheckbox').checked;
        const galleryAction = deleteModal.querySelector('input[name="galleryAction"]:checked')?.value || 'keep';
        
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
        // Delete gallery files if requested (only possible for unique galleries)
        if (canDeleteGallery && galleryAction === 'delete') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting gallery...';
            let deleted = 0;
            let errors = 0;
            
            const safeFolderName = sanitizeFolderName(galleryInfo.folder);
            for (const fileName of galleryInfo.files) {
                try {
                    const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                    const response = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
                        path: deletePath
                    });
                    if (response.ok) {
                        deleted++;
                    } else {
                        errors++;
                    }
                } catch (e) {
                    errors++;
                }
            }
            
            if (deleted > 0) {
                debugLog(`[Delete] Deleted ${deleted} gallery image${deleted !== 1 ? 's' : ''}`);
            }
        }
        
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting character...';
        const success = await deleteCharacter(char, deleteChats);
        
        if (success) {
            closeDeleteModal();
            closeModal();
            // Refresh the grid
            fetchCharacters(true);
            showToast(`Character "${charName}" deleted`, 'success');
        } else {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    });
}

async function deleteCharacter(char, deleteChats = false) {
    try {
        const avatar = char.avatar || '';
        const charName = getCharField(char, 'name') || avatar;
        
        debugLog('[Delete] Starting deletion for:', charName, 'avatar:', avatar);
        
        // Delete character via SillyTavern API
        const response = await apiRequest(ENDPOINTS.CHARACTERS_DELETE, 'POST', {
            avatar_url: avatar,
            delete_chats: deleteChats
        }, { cache: 'no-cache' });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Delete] API Error:', response.status, errorText);
            showToast('Failed to delete character', 'error');
            return false;
        }
        
        debugLog('[Delete] API call successful, cleaning up...');
        
        // Clean up gallery folder override if this character had a unique folder
        if (avatar && getCharacterGalleryId(char)) {
            removeGalleryFolderOverride(avatar);
            debugLog('[Delete] Removed gallery folder override for:', avatar);
        }
        
        // CRITICAL: Trigger character refresh in main SillyTavern window
        // This updates ST's in-memory character array and cleans up related data
        try {
            if (window.opener && !window.opener.closed) {
                // Method 1: Use SillyTavern context API if available
                if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                    const context = window.opener.SillyTavern.getContext();
                    if (context && typeof context.getCharacters === 'function') {
                        debugLog('[Delete] Triggering getCharacters() in main window...');
                        await context.getCharacters();
                    }
                }
                
                // Method 2: Try to emit the CHARACTER_DELETED event directly
                if (window.opener.eventSource && window.opener.event_types) {
                    debugLog('[Delete] Emitting CHARACTER_DELETED event...');
                    const charIndex = window.opener.characters?.findIndex(c => c.avatar === avatar);
                    if (charIndex !== undefined && charIndex >= 0) {
                        await window.opener.eventSource.emit(
                            window.opener.event_types.CHARACTER_DELETED, 
                            { id: charIndex, character: char }
                        );
                    }
                }
                
                // Method 3: Call printCharactersDebounced to refresh the UI
                if (typeof window.opener.printCharactersDebounced === 'function') {
                    debugLog('[Delete] Calling printCharactersDebounced()...');
                    window.opener.printCharactersDebounced();
                }
            }
        } catch (e) {
            console.warn('[Delete] Could not refresh main window (non-fatal):', e);
        }
        
        debugLog('[Delete] Character deleted successfully');
        return true;
        
    } catch (error) {
        console.error('[Delete] Error:', error);
        showToast('Error deleting character', 'error');
        return false;
    }
}

// Collect current edit values
function collectEditValues() {
    return {
        name: document.getElementById('editName').value,
        description: document.getElementById('editDescription').value,
        first_mes: document.getElementById('editFirstMes').value,
        creator: document.getElementById('editCreator').value,
        character_version: document.getElementById('editVersion').value,
        tagsArray: [..._editTagsArray],
        personality: document.getElementById('editPersonality').value,
        scenario: document.getElementById('editScenario').value,
        mes_example: document.getElementById('editMesExample').value,
        system_prompt: document.getElementById('editSystemPrompt').value,
        post_history_instructions: document.getElementById('editPostHistoryInstructions').value,
        creator_notes: document.getElementById('editCreatorNotes').value,
        alternate_greetings: getAltGreetingsFromEditor(),
        character_book: getCharacterBookFromEditor()
    };
}

// Generate diff between original and new values
function generateChangesDiff(original, current) {
    const changes = [];
    const fieldLabels = {
        name: 'Character Name',
        description: 'Description',
        first_mes: 'First Message',
        creator: 'Creator',
        character_version: 'Version',
        tagsArray: 'Tags',
        personality: 'Personality',
        scenario: 'Scenario',
        mes_example: 'Example Dialogue',
        system_prompt: 'System Prompt',
        post_history_instructions: 'Post-History Instructions',
        creator_notes: "Creator's Notes",
        alternate_greetings: 'Alternate Greetings',
        character_book: 'Embedded Lorebook'
    };
    
    // Helper to normalize string values for comparison
    // Handles line ending differences (\r\n vs \n) and trims whitespace
    const normalizeString = (val) => String(val || '').replace(/\r\n/g, '\n').trim();
    
    // Helper to normalize arrays of strings for comparison
    const normalizeStringArray = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr.map(s => String(s || '').replace(/\r\n/g, '\n').trim()).filter(s => s.length > 0);
    };
    
    for (const key of Object.keys(fieldLabels)) {
        let oldVal = original[key];
        let newVal = current[key];
        
        // Handle tags array comparison
        if (key === 'tagsArray') {
            const oldNorm = normalizeStringArray(oldVal || []);
            const newNorm = normalizeStringArray(newVal || []);
            // Sort for order-insensitive comparison
            const oldSorted = [...oldNorm].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            const newSorted = [...newNorm].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            if (JSON.stringify(oldSorted) !== JSON.stringify(newSorted)) {
                const added = newNorm.filter(t => !oldNorm.some(o => o.localeCompare(t, undefined, { sensitivity: 'base' }) === 0));
                const removed = oldNorm.filter(t => !newNorm.some(n => n.localeCompare(t, undefined, { sensitivity: 'base' }) === 0));
                const parts = [];
                if (added.length) parts.push(`Added: ${added.join(', ')}`);
                if (removed.length) parts.push(`Removed: ${removed.join(', ')}`);
                changes.push({
                    field: fieldLabels[key],
                    old: oldNorm.join(', ') || '(none)',
                    new: newNorm.join(', ') || '(none)',
                    detail: parts.join(' | ')
                });
            }
            continue;
        }
        
        // Handle alternate greetings array comparison
        if (key === 'alternate_greetings') {
            const oldNorm = normalizeStringArray(oldVal);
            const newNorm = normalizeStringArray(newVal);
            const oldStr = JSON.stringify(oldNorm);
            const newStr = JSON.stringify(newNorm);
            if (oldStr !== newStr) {
                changes.push({
                    field: fieldLabels[key],
                    old: oldNorm.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)',
                    new: newNorm.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'
                });
            }
            continue;
        }
        
        // Handle character_book comparison - compare only the meaningful fields
        if (key === 'character_book') {
            const normalizeBook = (book) => {
                if (!book || !book.entries || book.entries.length === 0) return null;
                // Only compare the fields that matter for equality
                return book.entries.map(e => ({
                    keys: (e.keys || []).map(k => String(k).replace(/\r\n/g, '\n').trim()).filter(k => k),
                    secondary_keys: (e.secondary_keys || []).map(k => String(k).replace(/\r\n/g, '\n').trim()).filter(k => k),
                    content: String(e.content || '').replace(/\r\n/g, '\n').trim(),
                    comment: String(e.comment || e.name || '').replace(/\r\n/g, '\n').trim(),
                    enabled: e.enabled !== false,
                    selective: e.selective || false,
                    constant: e.constant || false,
                    order: e.order ?? e.insertion_order ?? 0,
                    priority: e.priority ?? 10
                }));
            };
            
            const oldNorm = normalizeBook(oldVal);
            const newNorm = normalizeBook(newVal);
            const oldStr = JSON.stringify(oldNorm);
            const newStr = JSON.stringify(newNorm);
            
            if (oldStr !== newStr) {
                const oldCount = oldNorm?.length || 0;
                const newCount = newNorm?.length || 0;
                const oldSummary = oldCount > 0 
                    ? `${oldCount} entries: ${oldNorm.slice(0, 3).map(e => e.comment || e.keys?.[0] || 'unnamed').join(', ')}${oldCount > 3 ? '...' : ''}`
                    : '(none)';
                const newSummary = newCount > 0 
                    ? `${newCount} entries: ${newNorm.slice(0, 3).map(e => e.comment || e.keys?.[0] || 'unnamed').join(', ')}${newCount > 3 ? '...' : ''}`
                    : '(none)';
                changes.push({
                    field: fieldLabels[key],
                    old: oldSummary,
                    new: newSummary
                });
            }
            continue;
        }
        
        // String field comparison - normalize both values
        const oldNorm = normalizeString(oldVal);
        const newNorm = normalizeString(newVal);
        
        if (oldNorm !== newNorm) {
            // Get smart excerpts showing context around the changes with highlighting
            const excerpts = getChangeExcerpts(oldNorm, newNorm, 150);
            changes.push({
                field: fieldLabels[key],
                old: excerpts.old || '(empty)',
                new: excerpts.new || '(empty)',
                oldHtml: excerpts.oldHtml,
                newHtml: excerpts.newHtml
            });
        }
    }
    
    return changes;
}

/**
 * Find the first position where two strings differ
 */
function findFirstDifference(str1, str2) {
    const minLen = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLen; i++) {
        if (str1[i] !== str2[i]) return i;
    }
    // If one is longer, the difference starts at the end of the shorter one
    if (str1.length !== str2.length) return minLen;
    return -1; // Identical
}

/**
 * Find the last position where two strings differ (searching from end)
 */
function findLastDifference(str1, str2) {
    let i = str1.length - 1;
    let j = str2.length - 1;
    
    while (i >= 0 && j >= 0) {
        if (str1[i] !== str2[j]) {
            return { pos1: i, pos2: j };
        }
        i--;
        j--;
    }
    
    // One string is a prefix of the other
    if (i >= 0) return { pos1: i, pos2: -1 };
    if (j >= 0) return { pos1: -1, pos2: j };
    return { pos1: -1, pos2: -1 }; // Identical
}

/**
 * Get excerpts from old and new strings with highlighted changes
 * @param {string} oldStr - Original string
 * @param {string} newStr - New string  
 * @param {number} contextLength - How many characters to show around changes
 * @returns {{old: string, new: string, oldHtml: string, newHtml: string}} Excerpts with highlighting
 */
function getChangeExcerpts(oldStr, newStr, contextLength = 150) {
    if (!oldStr && !newStr) return { old: '(empty)', new: '(empty)', oldHtml: '(empty)', newHtml: '(empty)' };
    if (!oldStr) {
        const truncated = truncateText(newStr, contextLength);
        return { 
            old: '(empty)', 
            new: truncated,
            oldHtml: '<span class="diff-empty">(empty)</span>',
            newHtml: `<span class="diff-added">${escapeHtml(truncated)}</span>`
        };
    }
    if (!newStr) {
        const truncated = truncateText(oldStr, contextLength);
        return { 
            old: truncated, 
            new: '(empty)',
            oldHtml: `<span class="diff-removed">${escapeHtml(truncated)}</span>`,
            newHtml: '<span class="diff-empty">(empty)</span>'
        };
    }
    
    // Find where differences start and end
    const diffStart = findFirstDifference(oldStr, newStr);
    if (diffStart === -1) {
        // Identical - shouldn't happen but handle gracefully
        return { old: oldStr, new: newStr, oldHtml: escapeHtml(oldStr), newHtml: escapeHtml(newStr) };
    }
    
    const diffEnd = findLastDifference(oldStr, newStr);
    
    // Calculate the changed regions
    const oldChangeEnd = diffEnd.pos1 + 1;
    const newChangeEnd = diffEnd.pos2 + 1;
    
    // For short strings, show them entirely with highlighting
    if (oldStr.length <= contextLength && newStr.length <= contextLength) {
        const oldHtml = buildHighlightedString(oldStr, diffStart, oldChangeEnd, 'diff-removed');
        const newHtml = buildHighlightedString(newStr, diffStart, newChangeEnd, 'diff-added');
        return { old: oldStr, new: newStr, oldHtml, newHtml };
    }
    
    // For longer strings, extract context around the change
    const contextBefore = 30;
    const contextAfter = contextLength - contextBefore;
    
    const startPos = Math.max(0, diffStart - contextBefore);
    
    const oldEndPos = Math.min(oldStr.length, Math.max(oldChangeEnd, diffStart) + contextAfter);
    const newEndPos = Math.min(newStr.length, Math.max(newChangeEnd, diffStart) + contextAfter);
    
    // Extract and highlight
    const oldExcerpt = oldStr.substring(startPos, oldEndPos);
    const newExcerpt = newStr.substring(startPos, newEndPos);
    
    // Adjust highlight positions for the excerpt
    const highlightStart = diffStart - startPos;
    const oldHighlightEnd = oldChangeEnd - startPos;
    const newHighlightEnd = newChangeEnd - startPos;
    
    let oldHtml = buildHighlightedString(oldExcerpt, highlightStart, oldHighlightEnd, 'diff-removed');
    let newHtml = buildHighlightedString(newExcerpt, highlightStart, newHighlightEnd, 'diff-added');
    
    // Add ellipsis markers
    const oldPrefix = startPos > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const oldSuffix = oldEndPos < oldStr.length ? '<span class="diff-ellipsis">...</span>' : '';
    const newPrefix = startPos > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const newSuffix = newEndPos < newStr.length ? '<span class="diff-ellipsis">...</span>' : '';
    
    return {
        old: (startPos > 0 ? '...' : '') + oldExcerpt + (oldEndPos < oldStr.length ? '...' : ''),
        new: (startPos > 0 ? '...' : '') + newExcerpt + (newEndPos < newStr.length ? '...' : ''),
        oldHtml: oldPrefix + oldHtml + oldSuffix,
        newHtml: newPrefix + newHtml + newSuffix
    };
}

/**
 * Build a string with a highlighted section
 */
function buildHighlightedString(str, highlightStart, highlightEnd, className) {
    if (highlightStart < 0) highlightStart = 0;
    if (highlightEnd > str.length) highlightEnd = str.length;
    if (highlightStart >= highlightEnd) return escapeHtml(str);
    
    const before = str.substring(0, highlightStart);
    const highlighted = str.substring(highlightStart, highlightEnd);
    const after = str.substring(highlightEnd);
    
    return escapeHtml(before) + 
           `<span class="${className}">${escapeHtml(highlighted)}</span>` + 
           escapeHtml(after);
}

function truncateText(text, maxLength) {
    if (!text) return '(empty)';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// Show confirmation modal with diff
function showSaveConfirmation() {
    if (!activeChar) return;
    
    const currentValues = collectEditValues();
    const changes = generateChangesDiff(originalValues, currentValues);
    
    if (changes.length === 0) {
        showToast("No changes detected", "info");
        return;
    }
    
    // Store pending payload for actual save
    // SillyTavern's merge-attributes API expects data in the character card v2/v3 format
    // with fields both at root level (for backwards compat) and under 'data' object
    // IMPORTANT: Preserve existing extensions (like gallery_id, favorites, chub link) to avoid wiping them
    const existingExtensions = activeChar.data?.extensions || activeChar.extensions || {};
    // IMPORTANT: Preserve create_date to maintain original import timestamp
    const existingCreateDate = activeChar.create_date;
    // IMPORTANT: Preserve spec and spec_version to avoid unwanted version upgrades
    const existingSpec = activeChar.spec || activeChar.data?.spec;
    const existingSpecVersion = activeChar.spec_version || activeChar.data?.spec_version;
    // IMPORTANT: Preserve the entire original data object to keep V3 fields (assets, nickname, depth_prompt, group_only_greetings, etc.)
    const existingData = activeChar.data || {};
    
    pendingPayload = {
        avatar: activeChar.avatar,
        // Preserve spec info at root level
        ...(existingSpec && { spec: existingSpec }),
        ...(existingSpecVersion && { spec_version: existingSpecVersion }),
        name: currentValues.name,
        description: currentValues.description,
        first_mes: currentValues.first_mes,
        personality: currentValues.personality,
        scenario: currentValues.scenario,
        mes_example: currentValues.mes_example,
        system_prompt: currentValues.system_prompt,
        post_history_instructions: currentValues.post_history_instructions,
        creator_notes: currentValues.creator_notes,
        creator: currentValues.creator,
        character_version: currentValues.character_version,
        tags: currentValues.tagsArray,
        alternate_greetings: currentValues.alternate_greetings,
        character_book: currentValues.character_book,
        // Preserve original create_date
        create_date: existingCreateDate,
        // Include under 'data' for proper v2/v3 card format
        // CRITICAL: Spread existing data FIRST, then override with edited fields
        // This preserves V3 fields like assets, nickname, depth_prompt, group_only_greetings, etc.
        data: {
            ...existingData,
            // Override with edited fields
            name: currentValues.name,
            description: currentValues.description,
            first_mes: currentValues.first_mes,
            personality: currentValues.personality,
            scenario: currentValues.scenario,
            mes_example: currentValues.mes_example,
            system_prompt: currentValues.system_prompt,
            post_history_instructions: currentValues.post_history_instructions,
            creator_notes: currentValues.creator_notes,
            creator: currentValues.creator,
            character_version: currentValues.character_version,
            tags: currentValues.tagsArray,
            alternate_greetings: currentValues.alternate_greetings,
            character_book: currentValues.character_book,
            // Preserve original create_date
            create_date: existingCreateDate,
            // CRITICAL: Include existing extensions to preserve gallery_id, favorites, chub link, etc.
            extensions: existingExtensions
        }
    };
    
    // Build diff HTML
    const diffContainer = document.getElementById('changesDiff');
    diffContainer.innerHTML = changes.map(change => `
        <div class="diff-item">
            <div class="diff-item-label">${escapeHtml(change.field)}</div>
            <div class="diff-old">${change.oldHtml || escapeHtml(change.old)}</div>
            <div class="diff-arrow">↓</div>
            <div class="diff-new">${change.newHtml || escapeHtml(change.new)}</div>
        </div>
    `).join('');
    
    // Show modal
    document.getElementById('confirmSaveModal').classList.remove('hidden');
}

// Actually perform the save
async function performSave() {
    if (!activeChar || !pendingPayload) return;
    
    // Capture old name BEFORE updating for gallery folder rename
    const oldName = originalValues.name;
    const newName = pendingPayload.name;
    const nameChanged = oldName && newName && oldName !== newName;
    const galleryId = getCharacterGalleryId(activeChar);
    
    try {
        const response = await apiRequest('/characters/merge-attributes', 'POST', pendingPayload);
        
        if (response.ok) {
            showToast("Character saved successfully!", "success");
            
            // Close confirmation immediately so it doesn't wait on folder rename / grid refresh
            document.getElementById('confirmSaveModal').classList.add('hidden');
            
            // Handle gallery folder rename if name changed and character has unique gallery folder
            if (nameChanged && galleryId && getSetting('uniqueGalleryFolders')) {
                await handleGalleryFolderRename(activeChar, oldName, newName, galleryId);
            }
            
            // Update local data - update root level fields
            activeChar.name = pendingPayload.name;
            activeChar.description = pendingPayload.description;
            activeChar.first_mes = pendingPayload.first_mes;
            activeChar.personality = pendingPayload.personality;
            activeChar.scenario = pendingPayload.scenario;
            activeChar.mes_example = pendingPayload.mes_example;
            activeChar.system_prompt = pendingPayload.system_prompt;
            activeChar.post_history_instructions = pendingPayload.post_history_instructions;
            activeChar.creator_notes = pendingPayload.creator_notes;
            activeChar.creator = pendingPayload.creator;
            activeChar.character_version = pendingPayload.character_version;
            activeChar.tags = pendingPayload.tags;
            activeChar.alternate_greetings = pendingPayload.alternate_greetings;
            activeChar.character_book = pendingPayload.character_book;
            
            // Also update the data object if it exists
            if (activeChar.data) {
                // Preserve extensions (like favorites) that aren't part of the edit form
                const existingExtensions = activeChar.data.extensions;
                Object.assign(activeChar.data, pendingPayload.data);
                if (existingExtensions) {
                    activeChar.data.extensions = existingExtensions;
                }
            }
            
            // Also update the character in allCharacters array for immediate grid refresh
            const charIndex = allCharacters.findIndex(c => c.avatar === activeChar.avatar);
            if (charIndex !== -1) {
                // Copy all updated fields to the array entry
                Object.assign(allCharacters[charIndex], {
                    name: pendingPayload.name,
                    description: pendingPayload.description,
                    first_mes: pendingPayload.first_mes,
                    personality: pendingPayload.personality,
                    scenario: pendingPayload.scenario,
                    mes_example: pendingPayload.mes_example,
                    system_prompt: pendingPayload.system_prompt,
                    post_history_instructions: pendingPayload.post_history_instructions,
                    creator_notes: pendingPayload.creator_notes,
                    creator: pendingPayload.creator,
                    character_version: pendingPayload.character_version,
                    tags: pendingPayload.tags,
                    alternate_greetings: pendingPayload.alternate_greetings,
                    character_book: pendingPayload.character_book
                });
                if (allCharacters[charIndex].data) {
                    const existingExt = allCharacters[charIndex].data.extensions;
                    Object.assign(allCharacters[charIndex].data, pendingPayload.data);
                    if (existingExt) {
                        allCharacters[charIndex].data.extensions = existingExt;
                    }
                }
                // Ensure activeChar points to the array entry
                activeChar = allCharacters[charIndex];
            }

            // Update last modified timestamp locally so sort by "Last Modified" reflects the change immediately.
            const nowMs = Date.now();
            activeChar.date_added = nowMs;
            if (activeChar._meta) activeChar._meta.date_added = nowMs;
            if (charIndex !== -1) {
                allCharacters[charIndex].date_added = nowMs;
                if (allCharacters[charIndex]._meta) allCharacters[charIndex]._meta.date_added = nowMs;
            }
            
            // Update original values to reflect saved state
            originalValues = collectEditValues();
            
            // Refresh the modal display to show saved changes
            refreshModalDisplay();
            
            // Force re-render the grid to show updated data immediately
            performSearch();
            
            // Lock editing and clean up
            setEditLock(true);
            pendingPayload = null;
            
            // Also fetch from server to ensure full sync (in background)
            // Use forceRefresh to avoid stale opener data overwriting recent changes.
            fetchCharacters(true);
        } else {
            const err = await response.text();
            showToast("Error saving: " + err, "error");
        }
    } catch (e) {
        showToast("Network error saving character: " + e.message, "error");
    }
}

/**
 * Refresh the modal display with current activeChar data
 * Called after save to update the Details tab without re-opening the modal
 */
function refreshModalDisplay() {
    if (!activeChar) return;
    
    const char = activeChar;
    
    // Update modal title
    document.getElementById('modalTitle').innerText = char.name;
    
    // Update author
    const author = char.creator || (char.data ? char.data.creator : "") || "";
    const authContainer = document.getElementById('modalAuthorContainer');
    const authorEl = document.getElementById('modalAuthor');
    if (author && authContainer) {
        authorEl.innerText = author;
        authContainer.style.display = 'inline';
    } else if (authContainer) {
        authContainer.style.display = 'none';
    }
    
    // Update Creator Notes
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');
    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        // Store raw content for fullscreen expand feature
        window.currentCreatorNotesContent = creatorNotes;
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
        // Initialize handlers for this modal instance
        initCreatorNotesHandlers();
        // Show/hide expand button based on content length
        const expandBtn = document.getElementById('creatorNotesExpandBtn');
        if (expandBtn) {
            const lineCount = (creatorNotes.match(/\n/g) || []).length + 1;
            const charCount = creatorNotes.length;
            const showExpand = lineCount >= CreatorNotesConfig.MIN_LINES_FOR_EXPAND || 
                               charCount >= CreatorNotesConfig.MIN_CHARS_FOR_EXPAND;
            expandBtn.style.display = showExpand ? 'flex' : 'none';
        }
    } else if (notesBox) {
        notesBox.style.display = 'none';
        window.currentCreatorNotesContent = null;
    }

    // Update ChubAI Tagline
    const taglineRow = document.getElementById('modalChubTaglineRow');
    const taglineEl = document.getElementById('modalChubTagline');
    const chubTagline = char?.data?.extensions?.chub?.tagline || char?.extensions?.chub?.tagline || '';
    if (taglineRow && taglineEl) {
        taglineRow.classList.remove('expanded');
        taglineRow.setAttribute('aria-expanded', 'false');
        taglineRow.setAttribute('role', 'button');
        taglineRow.onclick = () => {
            const isExpanded = taglineRow.classList.toggle('expanded');
            taglineRow.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        };
        const showTagline = getSetting('showChubTagline') !== false;
        if (showTagline && chubTagline) {
            taglineEl.textContent = chubTagline;
            taglineRow.style.display = 'block';
        } else {
            taglineEl.textContent = '';
            taglineRow.style.display = 'none';
        }
    }
    
    // Update Description/First Message
    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";
    
    // Store raw content for fullscreen expand feature
    window.currentDescriptionContent = desc || null;
    window.currentFirstMesContent = firstMes || null;
    
    document.getElementById('modalDescription').innerHTML = formatRichText(desc, char.name);
    document.getElementById('modalFirstMes').innerHTML = formatRichText(firstMes, char.name);
    
    // Update Alternate Greetings
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    const altBox = document.getElementById('modalAltGreetingsBox');
    
    // Store raw content for fullscreen expand feature
    window.currentAltGreetingsContent = (altGreetings && altGreetings.length > 0) ? altGreetings : null;
    
    if (altBox) {
        if (altGreetings && altGreetings.length > 0) {
            document.getElementById('altGreetingsCount').innerText = altGreetings.length;
            const listHTML = altGreetings.map((g, i) => 
                `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.1);"><strong style="color:var(--accent);">#${i+1}:</strong> <span>${formatRichText((g || '').trim(), char.name)}</span></div>`
            ).join('');
            document.getElementById('modalAltGreetings').innerHTML = listHTML;
            altBox.style.display = 'block';
        } else {
            altBox.style.display = 'none';
        }
    }
    
    // Initialize content expand handlers
    initContentExpandHandlers();
    
    // Update Embedded Lorebook
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    const lorebookBox = document.getElementById('modalLorebookBox');
    if (lorebookBox) {
        if (characterBook && characterBook.entries && characterBook.entries.length > 0) {
            document.getElementById('lorebookEntryCount').innerText = characterBook.entries.length;
            const lorebookHTML = renderLorebookEntriesHtml(characterBook.entries)
            document.getElementById('modalLorebookContent').innerHTML = lorebookHTML;
            lorebookBox.style.display = 'block';
        } else {
            lorebookBox.style.display = 'none';
        }
    }
    
    // Update tags in sidebar
    renderSidebarTags(getTags(char), !isEditLocked);
}

// Legacy saveCharacter now shows confirmation
async function saveCharacter() {
    showSaveConfirmation();
}

// Edit Lock Functions
function setEditLock(locked) {
    isEditLocked = locked;
    
    const lockHeader = document.querySelector('.edit-lock-header');
    const lockStatus = document.getElementById('editLockStatus');
    const toggleBtn = document.getElementById('toggleEditLockBtn');
    const saveBtn = document.getElementById('saveEditBtn');
    const cancelBtn = document.getElementById('cancelEditBtn');
    const addAltGreetingBtn = document.getElementById('addAltGreetingBtn');
    const tagInputWrapper = document.getElementById('tagInputWrapper');
    const tagsContainer = document.getElementById('modalTags');
    
    // All editable inputs in the edit pane
    const editInputs = document.querySelectorAll('#pane-edit .glass-input');
    const removeGreetingBtns = document.querySelectorAll('.remove-alt-greeting-btn');
    const expandFieldBtns = document.querySelectorAll('.expand-field-btn');
    const sectionExpandBtns = document.querySelectorAll('.section-expand-btn');
    
    if (locked) {
        lockHeader?.classList.remove('unlocked');
        if (lockStatus) {
            lockStatus.innerHTML = '<i class="fa-solid fa-lock"></i><span>Fields are locked. Click unlock to edit.</span>';
        }
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Unlock Editing';
        }
        
        editInputs.forEach(input => {
            input.classList.add('locked');
            input.readOnly = true;
            if (input.tagName === 'SELECT') input.disabled = true;
        });
        
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (addAltGreetingBtn) addAltGreetingBtn.disabled = true;
        removeGreetingBtns.forEach(btn => btn.disabled = true);
        
        // Hide expand buttons when locked
        expandFieldBtns.forEach(btn => btn.classList.add('hidden'));
        sectionExpandBtns.forEach(btn => btn.classList.add('hidden'));
        
        // Lorebook editor
        const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
        if (addLorebookEntryBtn) addLorebookEntryBtn.disabled = true;
        document.querySelectorAll('.lorebook-entry-edit input, .lorebook-entry-edit textarea').forEach(input => {
            input.classList.add('locked');
            input.readOnly = true;
            if (input.type === 'checkbox') input.disabled = true;
        });
        document.querySelectorAll('.lorebook-entry-delete, .lorebook-entry-toggle').forEach(btn => {
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.5';
        });
        
        // Hide tag input and show non-editable tags
        if (tagInputWrapper) tagInputWrapper.classList.add('hidden');
        if (tagsContainer) tagsContainer.classList.remove('editable');
        renderSidebarTags(getCurrentTagsArray(), false);
    } else {
        lockHeader?.classList.add('unlocked');
        if (lockStatus) {
            lockStatus.innerHTML = '<i class="fa-solid fa-unlock"></i><span>Editing enabled. Remember to save your changes!</span>';
        }
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Lock Editing';
        }
        
        editInputs.forEach(input => {
            input.classList.remove('locked');
            input.readOnly = false;
            if (input.tagName === 'SELECT') input.disabled = false;
        });
        
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.style.display = '';
        if (addAltGreetingBtn) addAltGreetingBtn.disabled = false;
        removeGreetingBtns.forEach(btn => btn.disabled = false);
        
        // Show expand buttons when unlocked
        expandFieldBtns.forEach(btn => btn.classList.remove('hidden'));
        sectionExpandBtns.forEach(btn => btn.classList.remove('hidden'));
        
        // Lorebook editor
        const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
        if (addLorebookEntryBtn) addLorebookEntryBtn.disabled = false;
        document.querySelectorAll('.lorebook-entry-edit input, .lorebook-entry-edit textarea').forEach(input => {
            input.classList.remove('locked');
            input.readOnly = false;
            if (input.type === 'checkbox') input.disabled = false;
        });
        document.querySelectorAll('.lorebook-entry-delete, .lorebook-entry-toggle').forEach(btn => {
            btn.style.pointerEvents = '';
            btn.style.opacity = '';
        });
        
        // Show tag input and make tags editable
        if (tagInputWrapper) tagInputWrapper.classList.remove('hidden');
        if (tagsContainer) tagsContainer.classList.add('editable');
        renderSidebarTags(getCurrentTagsArray(), true);
    }
}

function cancelEditing() {
    if (!activeChar) return;
    
    // Restore original values (text fields use originalValues which are already normalized)
    document.getElementById('editName').value = originalValues.name || '';
    document.getElementById('editDescription').value = originalValues.description || '';
    document.getElementById('editFirstMes').value = originalValues.first_mes || '';
    document.getElementById('editCreator').value = originalValues.creator || '';
    document.getElementById('editVersion').value = originalValues.character_version || '';
    document.getElementById('editPersonality').value = originalValues.personality || '';
    document.getElementById('editScenario').value = originalValues.scenario || '';
    document.getElementById('editMesExample').value = originalValues.mes_example || '';
    document.getElementById('editSystemPrompt').value = originalValues.system_prompt || '';
    document.getElementById('editPostHistoryInstructions').value = originalValues.post_history_instructions || '';
    document.getElementById('editCreatorNotes').value = originalValues.creator_notes || '';
    
    // Restore tag array from original values
    _editTagsArray = [...(originalValues.tagsArray || [])];
    
    // Restore alternate greetings from raw data
    populateAltGreetingsEditor(originalRawData.altGreetings || []);
    
    // Restore lorebook from raw data
    populateLorebookEditor(originalRawData.characterBook);
    
    // Re-lock (this also re-renders sidebar tags via setEditLock)
    setEditLock(true);
    showToast("Changes discarded", "info");
}

// ==============================================
// DATE UTILITIES
// ==============================================

/**
 * Resolve a character's create_date value from any supported location.
 * Some sources store it at the top level, others under _meta or data.
 *
 * @param {object} char - Character object
 * @returns {string} Date string or empty string
 */
function getCharacterCreateDateValue(char) {
    if (!char) return '';
    const candidates = [
        char._meta?.create_date,
        char.create_date,
        char.data?.create_date,
    ].filter(Boolean);
    const withTime = candidates.find(value =>
        typeof value === 'number' || /T\d{2}:\d{2}:\d{2}/.test(String(value))
    );
    return withTime || candidates[0] || '';
}

/**
 * Parse a date string or number into a Date object.
 * Falls back to manual ISO parsing to avoid Date() misparsing in some runtimes.
 *
 * @param {string|number} rawValue - Date value
 * @returns {Date|null} Parsed Date or null
 */
function parseDateValue(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return null;
    if (typeof rawValue === 'number') {
        const d = new Date(rawValue);
        return isNaN(d.getTime()) ? null : d;
    }
    const rawString = String(rawValue).trim();
    const isoMatch = rawString.match(
        /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z)?$/
    );
    if (isoMatch) {
        const year = Number(isoMatch[1]);
        const month = Number(isoMatch[2]) - 1;
        const day = Number(isoMatch[3]);
        const hour = Number(isoMatch[4]);
        const minute = Number(isoMatch[5]);
        const second = Number(isoMatch[6]);
        const ms = isoMatch[7] ? Number(isoMatch[7].padEnd(3, '0')) : 0;
        const d = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(rawString);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date string/number into a locale date+time string.
 * Falls back to the raw value if parsing fails.
 *
 * @param {string|number} rawValue - Date value
 * @returns {string} Formatted date string
 */
function formatDateTime(rawValue) {
    if (!rawValue) return '(not available)';
    const d = parseDateValue(rawValue);
    if (!d) return String(rawValue);
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    }).format(d);
}

/**
 * Get the date a character was added to SillyTavern (file system time).
 * This changes whenever the character file is edited/rewritten.
 * 
 * @param {object} char - Character object
 * @returns {number} Timestamp in milliseconds for sorting
 */
function getCharacterDateAdded(char) {
    if (!char) return 0;
    if (char.date_added) {
        return Number(char.date_added) || 0;
    }
    return 0;
}

/**
 * Get the original creation date of a character (from PNG metadata).
 * This is stable and doesn't change when the character is edited.
 * 
 * @param {object} char - Character object
 * @returns {number} Timestamp in milliseconds for sorting
 */
function getCharacterCreateDate(char) {
    if (!char) return 0;
    const rawCreateDate = getCharacterCreateDateValue(char);
    if (rawCreateDate) {
        const d = parseDateValue(rawCreateDate);
        if (d) return d.getTime();
    }
    return 0;
}

/**
 * Get a stable date value for sorting characters.
 * Uses create_date (stored in PNG metadata) which doesn't change on edits,
 * falling back to date_added (file system ctime) if create_date is unavailable.
 * 
 * Note: date_added comes from file system ctime and changes whenever the file is rewritten.
 * create_date is stored in the PNG metadata and remains stable across edits.
 * 
 * @param {object} char - Character object
 * @returns {number} Timestamp in milliseconds for sorting
 */
function getCharacterDate(char) {
    if (!char) return 0;
    
    // Prefer create_date (stored in PNG, stable across edits)
    const rawCreateDate = getCharacterCreateDateValue(char);
    if (rawCreateDate) {
        const d = parseDateValue(rawCreateDate);
        if (d) return d.getTime();
    }
    
    // Fallback to date_added (file system ctime, changes on edit)
    if (char.date_added) {
        return Number(char.date_added) || 0;
    }
    
    return 0;
}

// ==============================================
// FAVORITES SYSTEM
// ==============================================

/**
 * Check if a character is marked as favorite
 * SillyTavern stores favorites in both root level 'fav' and data.extensions.fav
 * @param {object} char - Character object
 * @returns {boolean} True if character is a favorite
 */
function isCharacterFavorite(char) {
    if (!char) return false;
    // Check both locations - root level and spec v2 location
    // SillyTavern uses both boolean and string 'true'
    const rootFav = char.fav === true || char.fav === 'true';
    const extFav = char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true';
    return rootFav || extFav;
}

/**
 * Toggle the favorite status of a character
 * Uses SillyTavern's merge-attributes API to update the character
 * @param {object} char - Character object to toggle
 */
async function toggleCharacterFavorite(char) {
    if (!char || !char.avatar) {
        showToast('No character selected', 'error');
        return;
    }
    
    const currentFavStatus = isCharacterFavorite(char);
    const newFavStatus = !currentFavStatus;
    
    try {
        // IMPORTANT: SillyTavern reads fav from data.extensions.fav
        // Must include data object while preserving existing data fields
        const existingData = char.data || {};
        const existingExtensions = existingData.extensions || {};
        
        const response = await apiRequest('/characters/merge-attributes', 'POST', {
            avatar: char.avatar,
            fav: newFavStatus,
            create_date: char.create_date,
            data: {
                ...existingData,
                extensions: {
                    ...existingExtensions,
                    fav: newFavStatus
                }
            }
        });
        
        if (response.ok) {
            // Update local character data
            char.fav = newFavStatus;
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.fav = newFavStatus;
            
            // Also update in the main window's character list if available
            try {
                const context = getSTContext();
                if (context && context.characters) {
                    const charIndex = context.characters.findIndex(c => c.avatar === char.avatar);
                    if (charIndex !== -1) {
                        context.characters[charIndex].fav = newFavStatus;
                        if (context.characters[charIndex].data?.extensions) {
                            context.characters[charIndex].data.extensions.fav = newFavStatus;
                        }
                    }
                }
            } catch (e) {
                console.warn('[Favorites] Could not update main window:', e);
            }
            
            // Update UI
            updateFavoriteButtonUI(newFavStatus);
            updateCharacterCardFavoriteStatus(char.avatar, newFavStatus);
            
            showToast(newFavStatus ? 'Added to favorites!' : 'Removed from favorites', 'success');
            
            // If showing favorites only and just unfavorited, refresh grid
            if (showFavoritesOnly && !newFavStatus) {
                performSearch();
            }
        } else {
            const err = await response.text();
            showToast('Error updating favorite: ' + err, 'error');
        }
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    }
}

/**
 * Update the favorite button UI in the modal
 * @param {boolean} isFavorite - Whether the character is a favorite
 */
function updateFavoriteButtonUI(isFavorite) {
    const btn = document.getElementById('favoriteCharBtn');
    if (!btn) return;
    
    if (isFavorite) {
        btn.classList.add('is-favorite');
        btn.innerHTML = '<i class="fa-solid fa-star"></i>';
        btn.title = 'Remove from Favorites';
    } else {
        btn.classList.remove('is-favorite');
        btn.innerHTML = '<i class="fa-regular fa-star"></i>';
        btn.title = 'Add to Favorites';
    }
}

/**
 * Update the favorite indicator on a character card in the grid
 * @param {string} avatar - Character avatar filename
 * @param {boolean} isFavorite - Whether the character is a favorite
 */
function updateCharacterCardFavoriteStatus(avatar, isFavorite) {
    const cards = document.querySelectorAll('.char-card');
    cards.forEach(card => {
        // Find the card for this character by checking the onclick
        const img = card.querySelector('.card-image');
        if (img && img.src.includes(encodeURIComponent(avatar))) {
            if (isFavorite) {
                card.classList.add('is-favorite');
                // Add star indicator if not present
                if (!card.querySelector('.favorite-indicator')) {
                    const indicator = document.createElement('div');
                    indicator.className = 'favorite-indicator';
                    indicator.innerHTML = '<i class="fa-solid fa-star"></i>';
                    card.appendChild(indicator);
                }
            } else {
                card.classList.remove('is-favorite');
                const indicator = card.querySelector('.favorite-indicator');
                if (indicator) indicator.remove();
            }
        }
    });
}

/**
 * Toggle the favorites-only filter
 */
function toggleFavoritesFilter() {
    showFavoritesOnly = !showFavoritesOnly;
    
    const btn = document.getElementById('favoritesFilterBtn');
    if (btn) {
        if (showFavoritesOnly) {
            btn.classList.add('active');
            btn.title = 'Showing favorites only (click to show all)';
        } else {
            btn.classList.remove('active');
            btn.title = 'Show favorites only';
        }
    }
    
    performSearch();
}

// ==============================================
// Visual Tag Editing in Sidebar
// ==============================================

/**
 * Get all unique tags from all characters for autocomplete
 */
function getAllAvailableTags() {
    const tags = new Set();
    allCharacters.forEach(c => {
        const charTags = getTags(c);
        if (Array.isArray(charTags)) {
            charTags.forEach(t => tags.add(t));
        }
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

/**
 * Get current tags from the in-memory backing array
 */
let _editTagsArray = [];
function getCurrentTagsArray() {
    return [..._editTagsArray];
}

/**
 * Set tags in the backing array
 */
function setTagsFromArray(tagsArray) {
    _editTagsArray = [...tagsArray];
}

/**
 * Add a tag to the current character
 */
function addTag(tag) {
    const trimmedTag = tag.trim();
    if (!trimmedTag) return;
    
    const currentTags = getCurrentTagsArray();
    
    // Check if tag already exists (case-insensitive check)
    if (currentTags.some(t => t.toLowerCase() === trimmedTag.toLowerCase())) {
        showToast(`Tag "${trimmedTag}" already exists`, 'info');
        return;
    }
    
    currentTags.push(trimmedTag);
    setTagsFromArray(currentTags);
    renderSidebarTags(currentTags, true);
    
    // Clear sidebar input
    const tagInput = document.getElementById('tagInput');
    if (tagInput) tagInput.value = '';
    
    hideTagAutocomplete();
}

/**
 * Remove a tag from the current character
 */
function removeTag(tag) {
    const currentTags = getCurrentTagsArray();
    const newTags = currentTags.filter(t => t !== tag);
    setTagsFromArray(newTags);
    renderSidebarTags(newTags, true);
}

/**
 * Render tags in the sidebar with optional edit controls
 */
function renderSidebarTags(tags, editable = false) {
    const tagsContainer = document.getElementById('modalTags');
    if (!tagsContainer) return;
    
    if (!tags || tags.length === 0) {
        tagsContainer.innerHTML = editable 
            ? '<span class="no-tags-hint">No tags yet. Type below to add.</span>'
            : '';
        return;
    }
    
    if (editable) {
        tagsContainer.innerHTML = tags.map(t => `
            <span class="modal-tag editable">
                ${escapeHtml(t)}
                <button class="tag-remove-btn" data-tag="${escapeHtml(t)}" title="Remove tag">
                    <i class="fa-solid fa-times"></i>
                </button>
            </span>
        `).join('');
        
        // Add click handlers for remove buttons
        tagsContainer.querySelectorAll('.tag-remove-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const tagToRemove = btn.dataset.tag;
                removeTag(tagToRemove);
            };
        });
    } else {
        tagsContainer.innerHTML = tags.map(t => 
            `<span class="modal-tag">${escapeHtml(t)}</span>`
        ).join('');
    }
}

/**
 * Show tag autocomplete dropdown
 */
function showTagAutocomplete(filterText = '') {
    const autocomplete = document.getElementById('tagAutocomplete');
    if (!autocomplete) return;
    
    const allTags = getAllAvailableTags();
    const currentTags = getCurrentTagsArray().map(t => t.toLowerCase());
    const filter = filterText.toLowerCase();
    
    // Filter tags: match filter and not already added
    const suggestions = allTags.filter(tag => {
        const tagLower = tag.toLowerCase();
        return tagLower.includes(filter) && !currentTags.includes(tagLower);
    }).slice(0, 10); // Limit to 10 suggestions
    
    if (suggestions.length === 0 && filterText.trim()) {
        // Show "create new tag" option
        autocomplete.innerHTML = `
            <div class="tag-autocomplete-item create-new" data-tag="${escapeHtml(filterText.trim())}">
                <i class="fa-solid fa-plus"></i> Create "${escapeHtml(filterText.trim())}"
            </div>
        `;
        autocomplete.classList.add('visible');
    } else if (suggestions.length > 0) {
        autocomplete.innerHTML = suggestions.map(tag => `
            <div class="tag-autocomplete-item" data-tag="${escapeHtml(tag)}">
                ${escapeHtml(tag)}
            </div>
        `).join('');
        autocomplete.classList.add('visible');
    } else {
        hideTagAutocomplete();
        return;
    }
    
    // Add click handlers
    autocomplete.querySelectorAll('.tag-autocomplete-item').forEach(item => {
        item.onclick = () => {
            addTag(item.dataset.tag);
        };
    });
}

/**
 * Hide tag autocomplete dropdown
 */
function hideTagAutocomplete() {
    const autocomplete = document.getElementById('tagAutocomplete');
    if (autocomplete) {
        autocomplete.classList.remove('visible');
    }
}

// Tag Input Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    const tagInput = document.getElementById('tagInput');
    const tagAutocomplete = document.getElementById('tagAutocomplete');
    
    if (tagInput) {
        // Show autocomplete on input
        tagInput.addEventListener('input', (e) => {
            showTagAutocomplete(e.target.value);
        });
        
        // Show autocomplete on focus
        tagInput.addEventListener('focus', () => {
            showTagAutocomplete(tagInput.value);
        });
        
        // Handle Enter key to add tag
        tagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = tagInput.value.trim();
                if (value) {
                    addTag(value);
                }
            } else if (e.key === 'Escape') {
                hideTagAutocomplete();
                tagInput.blur();
            } else if (e.key === 'ArrowDown') {
                // Navigate to first autocomplete item
                const firstItem = tagAutocomplete?.querySelector('.tag-autocomplete-item');
                if (firstItem) {
                    e.preventDefault();
                    firstItem.focus();
                }
            }
        });
    }
    
    // Hide autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('tagInputWrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            hideTagAutocomplete();
        }
    });
    
    // Initialize expand field buttons
    initExpandFieldButtons();
    
    // Initialize section expand buttons (Greetings and Lorebook)
    initSectionExpandButtons();
    
    // Initialize ChubAI expand buttons
    initChubExpandButtons();

});

// ==============================================
// Expand Field Modal for Larger Text Editing
// ==============================================

/**
 * Initialize click handlers for expand field buttons
 */
function initExpandFieldButtons() {
    document.querySelectorAll('.expand-field-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const fieldId = btn.dataset.field;
            const fieldLabel = btn.dataset.label;
            openExpandedFieldEditor(fieldId, fieldLabel);
        });
    });
}

/**
 * Initialize section expand buttons for Greetings and Lorebook
 */
function initSectionExpandButtons() {
    // Greetings expand button
    const expandGreetingsBtn = document.getElementById('expandGreetingsBtn');
    if (expandGreetingsBtn) {
        expandGreetingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openGreetingsModal();
        });
    }
    
    // Lorebook expand button
    const expandLorebookBtn = document.getElementById('expandLorebookBtn');
    if (expandLorebookBtn) {
        expandLorebookBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openLorebookModal();
        });
    }
}

/**
 * Open full-screen modal for editing all greetings (First Message + Alternate Greetings)
 */
function openGreetingsModal() {
    // Get current values from the edit form
    const firstMesField = document.getElementById('editFirstMes');
    const altGreetingsContainer = document.getElementById('altGreetingsEditContainer');
    
    if (!firstMesField) {
        showToast('Greetings fields not found', 'error');
        return;
    }
    
    // Collect current alternate greetings
    const altGreetings = [];
    if (altGreetingsContainer) {
        const altInputs = altGreetingsContainer.querySelectorAll('.alt-greeting-input');
        altInputs.forEach(input => {
            altGreetings.push(input.value);
        });
    }
    
    // Build modal HTML
    let altGreetingsHtml = '';
    altGreetings.forEach((greeting, idx) => {
        const previewText = greeting ? greeting.substring(0, 100).replace(/\n/g, ' ') + (greeting.length > 100 ? '...' : '') : 'Empty greeting';
        altGreetingsHtml += `
            <div class="expanded-greeting-item" data-index="${idx}">
                <div class="expanded-greeting-header">
                    <button type="button" class="expanded-greeting-collapse-btn" title="Expand/Collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <span class="expanded-greeting-num">#${idx + 1}</span>
                    <span class="expanded-greeting-preview">${escapeHtml(previewText)}</span>
                    <button type="button" class="expanded-greeting-delete" title="Delete this greeting">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <textarea class="glass-input expanded-greeting-textarea" rows="6" placeholder="Alternate greeting message...">${escapeHtml(greeting)}</textarea>
            </div>
        `;
    });
    
    const modalHtml = `
        <div id="greetingsExpandModal" class="modal-overlay">
            <div class="modal-glass section-expand-modal" id="greetingsExpandModalInner">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-comments"></i> Edit Greetings</h2>
                    <div class="modal-header-controls">
                        <div class="display-control-btns zoom-controls" id="greetingsZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="greetingsZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button id="greetingsModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="greetingsModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body" id="greetingsExpandBody">
                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label"><i class="fa-solid fa-message"></i> First Message</h3>
                        <textarea id="expandedFirstMes" class="glass-input expanded-greeting-textarea first-message" rows="8" placeholder="Opening message from the character...">${escapeHtml(firstMesField.value)}</textarea>
                    </div>
                    
                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label">
                            <i class="fa-solid fa-layer-group"></i> Alternate Greetings
                            <div class="expanded-greetings-header-actions">
                                <button type="button" id="collapseAllGreetingsBtn" class="action-btn secondary small" title="Collapse All">
                                    <i class="fa-solid fa-compress-alt"></i>
                                </button>
                                <button type="button" id="expandAllGreetingsBtn" class="action-btn secondary small" title="Expand All">
                                    <i class="fa-solid fa-expand-alt"></i>
                                </button>
                                <button type="button" id="addExpandedGreetingBtn" class="action-btn secondary small">
                                    <i class="fa-solid fa-plus"></i> Add Greeting
                                </button>
                            </div>
                        </h3>
                        <div id="expandedAltGreetingsContainer" class="expanded-greetings-list">
                            ${altGreetingsHtml || '<div class="no-alt-greetings">No alternate greetings yet. Click "Add Greeting" to create one.</div>'}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('greetingsExpandModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('greetingsExpandModal');
    const expandedFirstMes = document.getElementById('expandedFirstMes');
    const greetingsExpandBody = document.getElementById('greetingsExpandBody');
    
    // Focus first message textarea
    setTimeout(() => expandedFirstMes.focus(), 50);
    
    // Zoom controls
    let greetingsZoom = 100;
    const greetingsZoomDisplay = document.getElementById('greetingsZoomDisplay');
    
    const updateGreetingsZoom = (zoom) => {
        greetingsZoom = Math.max(50, Math.min(200, zoom));
        greetingsZoomDisplay.textContent = `${greetingsZoom}%`;
        greetingsExpandBody.style.zoom = `${greetingsZoom}%`;
    };
    
    document.getElementById('greetingsZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateGreetingsZoom(greetingsZoom + 10);
        else if (action === 'out') updateGreetingsZoom(greetingsZoom - 10);
        else if (action === 'reset') updateGreetingsZoom(100);
    };
    
    // Close handlers
    const closeModal = () => modal.remove();
    
    document.getElementById('greetingsModalClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Escape key handler
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);
    
    // Add greeting handler
    document.getElementById('addExpandedGreetingBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');
        
        // Remove "no greetings" message if present
        const noGreetingsMsg = container.querySelector('.no-alt-greetings');
        if (noGreetingsMsg) noGreetingsMsg.remove();
        
        const idx = container.querySelectorAll('.expanded-greeting-item').length;
        const newGreetingHtml = `
            <div class="expanded-greeting-item" data-index="${idx}">
                <div class="expanded-greeting-header">
                    <button type="button" class="expanded-greeting-collapse-btn" title="Expand/Collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <span class="expanded-greeting-num">#${idx + 1}</span>
                    <span class="expanded-greeting-preview">Empty greeting</span>
                    <button type="button" class="expanded-greeting-delete" title="Delete this greeting">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <textarea class="glass-input expanded-greeting-textarea" rows="6" placeholder="Alternate greeting message..."></textarea>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', newGreetingHtml);
        
        // Add handlers to new item
        const newItem = container.lastElementChild;
        setupGreetingItemHandlers(newItem);
        
        // Focus the new textarea
        const newTextarea = newItem.querySelector('textarea');
        newTextarea.focus();
    };
    
    // Setup handlers for greeting items (delete + collapse)
    function setupGreetingItemHandlers(item) {
        const deleteBtn = item.querySelector('.expanded-greeting-delete');
        deleteBtn.onclick = () => {
            item.remove();
            renumberExpandedGreetings();
        };
        
        const collapseBtn = item.querySelector('.expanded-greeting-collapse-btn');
        if (collapseBtn) {
            collapseBtn.onclick = () => {
                const isCollapsed = item.classList.toggle('collapsed');
                collapseBtn.innerHTML = isCollapsed 
                    ? '<i class="fa-solid fa-chevron-right"></i>' 
                    : '<i class="fa-solid fa-chevron-down"></i>';
                // Update preview when collapsing
                if (isCollapsed) {
                    const preview = item.querySelector('.expanded-greeting-preview');
                    const textarea = item.querySelector('.expanded-greeting-textarea');
                    if (preview && textarea) {
                        const text = textarea.value;
                        const previewText = text ? text.substring(0, 100).replace(/\n/g, ' ') + (text.length > 100 ? '...' : '') : 'Empty greeting';
                        preview.textContent = previewText;
                    }
                }
            };
        }
    }
    
    function renumberExpandedGreetings() {
        const container = document.getElementById('expandedAltGreetingsContainer');
        const items = container.querySelectorAll('.expanded-greeting-item');
        items.forEach((item, idx) => {
            item.dataset.index = idx;
            const numSpan = item.querySelector('.expanded-greeting-num');
            if (numSpan) numSpan.textContent = `#${idx + 1}`;
        });
        
        // Show "no greetings" message if empty
        if (items.length === 0) {
            container.innerHTML = '<div class="no-alt-greetings">No alternate greetings yet. Click "Add Greeting" to create one.</div>';
        }
    }
    
    // Collapse/Expand All handlers
    document.getElementById('collapseAllGreetingsBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');
        container.querySelectorAll('.expanded-greeting-item').forEach(item => {
            item.classList.add('collapsed');
            const btn = item.querySelector('.expanded-greeting-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            // Update preview
            const preview = item.querySelector('.expanded-greeting-preview');
            const textarea = item.querySelector('.expanded-greeting-textarea');
            if (preview && textarea) {
                const text = textarea.value;
                const previewText = text ? text.substring(0, 100).replace(/\n/g, ' ') + (text.length > 100 ? '...' : '') : 'Empty greeting';
                preview.textContent = previewText;
            }
        });
    };
    
    document.getElementById('expandAllGreetingsBtn').onclick = () => {
        const container = document.getElementById('expandedAltGreetingsContainer');
        container.querySelectorAll('.expanded-greeting-item').forEach(item => {
            item.classList.remove('collapsed');
            const btn = item.querySelector('.expanded-greeting-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        });
    };
    
    // Setup handlers for initial items
    modal.querySelectorAll('.expanded-greeting-item').forEach(setupGreetingItemHandlers);
    
    // Save/Apply handler
    document.getElementById('greetingsModalSave').onclick = () => {
        // Update First Message
        const newFirstMes = document.getElementById('expandedFirstMes').value;
        const firstMesFieldCurrent = document.getElementById('editFirstMes');
        if (firstMesFieldCurrent) {
            firstMesFieldCurrent.value = newFirstMes;
            firstMesFieldCurrent.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        // Collect and update alternate greetings
        const expandedContainer = document.getElementById('expandedAltGreetingsContainer');
        const expandedGreetings = [];
        if (expandedContainer) {
            expandedContainer.querySelectorAll('.expanded-greeting-textarea').forEach(textarea => {
                expandedGreetings.push(textarea.value);
            });
        }
        
        // Clear and repopulate alt greetings container in main edit form
        const altGreetingsContainerCurrent = document.getElementById('altGreetingsEditContainer');
        if (altGreetingsContainerCurrent) {
            altGreetingsContainerCurrent.innerHTML = '';
            expandedGreetings.forEach((greeting, idx) => {
                addAltGreetingField(altGreetingsContainerCurrent, greeting, idx);
            });
        }
        
        closeModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Greetings updated', 'success');
    };
}

/**
 * Open full-screen modal for editing all lorebook entries
 */
function openLorebookModal() {
    const lorebookContainer = document.getElementById('lorebookEntriesEdit');
    
    if (!lorebookContainer) {
        showToast('Lorebook container not found', 'error');
        return;
    }
    
    // Collect current lorebook entries from the edit form
    const entries = [];
    lorebookContainer.querySelectorAll('.lorebook-entry-edit').forEach((entryEl, idx) => {
        const name = entryEl.querySelector('.lorebook-entry-name-input')?.value || '';
        const keys = entryEl.querySelector('.lorebook-keys-input')?.value || '';
        const secondaryKeys = entryEl.querySelector('.lorebook-secondary-keys-input')?.value || '';
        const content = entryEl.querySelector('.lorebook-content-input')?.value || '';
        const enabled = entryEl.querySelector('.lorebook-enabled-checkbox')?.checked ?? true;
        const selective = entryEl.querySelector('.lorebook-selective-checkbox')?.checked ?? false;
        const constant = entryEl.querySelector('.lorebook-constant-checkbox')?.checked ?? false;
        const order = entryEl.querySelector('.lorebook-order-input')?.value ?? idx;
        const priority = entryEl.querySelector('.lorebook-priority-input')?.value ?? 10;
        
        entries.push({ name, keys, secondaryKeys, content, enabled, selective, constant, order, priority });
    });
    
    // Build entries HTML
    let entriesHtml = '';
    entries.forEach((entry, idx) => {
        entriesHtml += buildExpandedLorebookEntryHtml(entry, idx);
    });
    
    const modalHtml = `
        <div id="lorebookExpandModal" class="modal-overlay">
            <div class="modal-glass section-expand-modal lorebook-expand-modal" id="lorebookExpandModalInner">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-book"></i> Edit Lorebook</h2>
                    <div class="modal-header-controls">
                        <div class="display-control-btns zoom-controls" id="lorebookZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="lorebookZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button id="lorebookModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="lorebookModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body" id="lorebookExpandBody">
                    <div class="expanded-lorebook-header">
                        <span id="expandedLorebookCount">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
                        <div class="expanded-lorebook-header-actions">
                            <button type="button" id="collapseAllLorebookBtn" class="action-btn secondary small" title="Collapse All">
                                <i class="fa-solid fa-compress-alt"></i>
                            </button>
                            <button type="button" id="expandAllLorebookBtn" class="action-btn secondary small" title="Expand All">
                                <i class="fa-solid fa-expand-alt"></i>
                            </button>
                            <button type="button" id="addExpandedLorebookEntryBtn" class="action-btn secondary small">
                                <i class="fa-solid fa-plus"></i> Add Entry
                            </button>
                        </div>
                    </div>
                    <div id="expandedLorebookContainer" class="expanded-lorebook-list">
                        ${entriesHtml || '<div class="no-lorebook-entries">No lorebook entries yet. Click "Add Entry" to create one.</div>'}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('lorebookExpandModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('lorebookExpandModal');
    const lorebookExpandBody = document.getElementById('lorebookExpandBody');
    
    // Zoom controls
    let lorebookZoom = 100;
    const lorebookZoomDisplay = document.getElementById('lorebookZoomDisplay');
    
    const updateLorebookZoom = (zoom) => {
        lorebookZoom = Math.max(50, Math.min(200, zoom));
        lorebookZoomDisplay.textContent = `${lorebookZoom}%`;
        lorebookExpandBody.style.zoom = `${lorebookZoom}%`;
    };
    
    document.getElementById('lorebookZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateLorebookZoom(lorebookZoom + 10);
        else if (action === 'out') updateLorebookZoom(lorebookZoom - 10);
        else if (action === 'reset') updateLorebookZoom(100);
    };
    
    // Close handlers
    const closeModal = () => modal.remove();
    
    document.getElementById('lorebookModalClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    
    // Escape key handler
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);
    
    // Collapse/Expand All handlers
    document.getElementById('collapseAllLorebookBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');
        container.querySelectorAll('.expanded-lorebook-entry').forEach(entry => {
            entry.classList.add('collapsed');
            const btn = entry.querySelector('.expanded-lorebook-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            // Update preview with keys
            const preview = entry.querySelector('.expanded-lorebook-preview');
            const keys = entry.querySelector('.expanded-lorebook-keys')?.value || '';
            if (preview) {
                const keysPreview = keys ? keys.substring(0, 100) + (keys.length > 100 ? '...' : '') : 'No keys';
                preview.innerHTML = `<i class="fa-solid fa-key"></i> ${keysPreview}`;
            }
        });
    };
    
    document.getElementById('expandAllLorebookBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');
        container.querySelectorAll('.expanded-lorebook-entry').forEach(entry => {
            entry.classList.remove('collapsed');
            const btn = entry.querySelector('.expanded-lorebook-collapse-btn');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        });
    };
    
    // Add entry handler
    document.getElementById('addExpandedLorebookEntryBtn').onclick = () => {
        const container = document.getElementById('expandedLorebookContainer');
        
        // Remove "no entries" message if present
        const noEntriesMsg = container.querySelector('.no-lorebook-entries');
        if (noEntriesMsg) noEntriesMsg.remove();
        
        const idx = container.querySelectorAll('.expanded-lorebook-entry').length;
        const newEntry = { name: '', keys: '', secondaryKeys: '', content: '', enabled: true, selective: false, constant: false, order: idx, priority: 10 };
        const newEntryHtml = buildExpandedLorebookEntryHtml(newEntry, idx);
        container.insertAdjacentHTML('beforeend', newEntryHtml);
        
        // Setup handlers for new entry
        const newEntryEl = container.lastElementChild;
        setupExpandedLorebookEntryHandlers(newEntryEl);
        updateExpandedLorebookCount();
        
        // Focus the name input
        const nameInput = newEntryEl.querySelector('.expanded-lorebook-name');
        nameInput.focus();
    };
    
    // Setup handlers for existing entries
    modal.querySelectorAll('.expanded-lorebook-entry').forEach(setupExpandedLorebookEntryHandlers);
    
    // Save/Apply handler
    document.getElementById('lorebookModalSave').onclick = () => {
        const expandedContainer = document.getElementById('expandedLorebookContainer');
        const newEntries = [];
        
        if (expandedContainer) {
            expandedContainer.querySelectorAll('.expanded-lorebook-entry').forEach((entryEl, idx) => {
                newEntries.push({
                    name: entryEl.querySelector('.expanded-lorebook-name')?.value || '',
                    keys: entryEl.querySelector('.expanded-lorebook-keys')?.value || '',
                    secondaryKeys: entryEl.querySelector('.expanded-lorebook-secondary-keys')?.value || '',
                    content: entryEl.querySelector('.expanded-lorebook-content')?.value || '',
                    enabled: entryEl.querySelector('.expanded-lorebook-enabled')?.checked ?? true,
                    selective: entryEl.querySelector('.expanded-lorebook-selective')?.checked ?? false,
                    constant: entryEl.querySelector('.expanded-lorebook-constant')?.checked ?? false,
                    order: parseInt(entryEl.querySelector('.expanded-lorebook-order')?.value) || idx,
                    priority: parseInt(entryEl.querySelector('.expanded-lorebook-priority')?.value) || 10
                });
            });
        }
        
        // Clear and repopulate lorebook container in main edit form
        const lorebookContainerCurrent = document.getElementById('lorebookEntriesEdit');
        if (lorebookContainerCurrent) {
            lorebookContainerCurrent.innerHTML = '';
            newEntries.forEach((entry, idx) => {
                addLorebookEntryField(lorebookContainerCurrent, {
                    comment: entry.name,
                    keys: entry.keys.split(',').map(k => k.trim()).filter(k => k),
                    secondary_keys: entry.secondaryKeys.split(',').map(k => k.trim()).filter(k => k),
                    content: entry.content,
                    enabled: entry.enabled,
                    selective: entry.selective,
                    constant: entry.constant,
                    order: entry.order,
                    priority: entry.priority
                }, idx);
            });
        }
        
        updateLorebookCount();
        closeModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Lorebook updated', 'success');
    };
}

function buildExpandedLorebookEntryHtml(entry, idx) {
    const keysPreview = entry.keys ? entry.keys.substring(0, 100) + (entry.keys.length > 100 ? '...' : '') : 'No keys';
    return `
        <div class="expanded-lorebook-entry${entry.enabled ? '' : ' disabled'}" data-index="${idx}">
            <div class="expanded-lorebook-entry-header">
                <button type="button" class="expanded-lorebook-collapse-btn" title="Expand/Collapse">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <input type="text" class="glass-input expanded-lorebook-name" placeholder="Entry name/comment" value="${escapeHtml(entry.name)}">
                <span class="expanded-lorebook-preview"><i class="fa-solid fa-key"></i> ${escapeHtml(keysPreview)}</span>
                <div class="expanded-lorebook-entry-controls">
                    <label class="expanded-lorebook-toggle ${entry.enabled ? 'enabled' : 'disabled'}" title="Toggle enabled">
                        <input type="checkbox" class="expanded-lorebook-enabled" ${entry.enabled ? 'checked' : ''} style="display: none;">
                        ${entry.enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}
                    </label>
                    <button type="button" class="expanded-lorebook-delete" title="Delete entry">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="expanded-lorebook-entry-body">
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Keys <span class="label-hint">(comma-separated)</span></label>
                        <input type="text" class="glass-input expanded-lorebook-keys" placeholder="keyword1, keyword2" value="${escapeHtml(entry.keys)}">
                    </div>
                </div>
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Secondary Keys <span class="label-hint">(optional, for selective)</span></label>
                        <input type="text" class="glass-input expanded-lorebook-secondary-keys" placeholder="secondary1, secondary2" value="${escapeHtml(entry.secondaryKeys)}">
                    </div>
                </div>
                <div class="expanded-lorebook-row">
                    <div class="form-group flex-1">
                        <label>Content</label>
                        <textarea class="glass-input expanded-lorebook-content" rows="5" placeholder="Lore content...">${escapeHtml(entry.content)}</textarea>
                    </div>
                </div>
                <div class="expanded-lorebook-options">
                    <label>
                        <input type="checkbox" class="expanded-lorebook-selective" ${entry.selective ? 'checked' : ''}>
                        <span>Selective</span>
                    </label>
                    <label>
                        <input type="checkbox" class="expanded-lorebook-constant" ${entry.constant ? 'checked' : ''}>
                        <span>Constant</span>
                    </label>
                    <div class="expanded-lorebook-number">
                        <label>Order:</label>
                        <input type="number" class="glass-input expanded-lorebook-order" value="${entry.order}">
                    </div>
                    <div class="expanded-lorebook-number">
                        <label>Priority:</label>
                        <input type="number" class="glass-input expanded-lorebook-priority" value="${entry.priority}">
                    </div>
                </div>
            </div>
        </div>
    `;
}

function setupExpandedLorebookEntryHandlers(entryEl) {
    // Collapse/expand handler
    const collapseBtn = entryEl.querySelector('.expanded-lorebook-collapse-btn');
    const entryBody = entryEl.querySelector('.expanded-lorebook-entry-body');
    const preview = entryEl.querySelector('.expanded-lorebook-preview');
    const nameInput = entryEl.querySelector('.expanded-lorebook-name');
    
    collapseBtn.onclick = () => {
        const isCollapsed = entryEl.classList.toggle('collapsed');
        collapseBtn.innerHTML = isCollapsed 
            ? '<i class="fa-solid fa-chevron-right"></i>' 
            : '<i class="fa-solid fa-chevron-down"></i>';
        // Update preview with keys when collapsing
        if (isCollapsed && preview) {
            const keys = entryEl.querySelector('.expanded-lorebook-keys')?.value || '';
            const keysPreview = keys ? keys.substring(0, 100) + (keys.length > 100 ? '...' : '') : 'No keys';
            preview.innerHTML = `<i class="fa-solid fa-key"></i> ${keysPreview}`;
        }
    };
    
    // Toggle enabled handler
    const toggleLabel = entryEl.querySelector('.expanded-lorebook-toggle');
    
    toggleLabel.onclick = (e) => {
        e.preventDefault();
        const checkbox = entryEl.querySelector('.expanded-lorebook-enabled');
        const isEnabled = checkbox.checked;
        const newEnabled = !isEnabled;
        checkbox.checked = newEnabled;
        toggleLabel.className = `expanded-lorebook-toggle ${newEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="expanded-lorebook-enabled" ${newEnabled ? 'checked' : ''} style="display: none;">${newEnabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}`;
        entryEl.classList.toggle('disabled', !newEnabled);
    };
    
    // Delete handler
    const deleteBtn = entryEl.querySelector('.expanded-lorebook-delete');
    deleteBtn.onclick = () => {
        entryEl.remove();
        renumberExpandedLorebookEntries();
        updateExpandedLorebookCount();
    };
}

function renumberExpandedLorebookEntries() {
    const container = document.getElementById('expandedLorebookContainer');
    if (!container) return;
    
    const entries = container.querySelectorAll('.expanded-lorebook-entry');
    entries.forEach((entry, idx) => {
        entry.dataset.index = idx;
    });
    
    // Show "no entries" message if empty
    if (entries.length === 0) {
        container.innerHTML = '<div class="no-lorebook-entries">No lorebook entries yet. Click "Add Entry" to create one.</div>';
    }
}

function updateExpandedLorebookCount() {
    const container = document.getElementById('expandedLorebookContainer');
    const countEl = document.getElementById('expandedLorebookCount');
    if (!container || !countEl) return;
    
    const count = container.querySelectorAll('.expanded-lorebook-entry').length;
    countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * Open expanded editor modal for a text field
 */
function openExpandedFieldEditor(fieldId, fieldLabel) {
    const originalField = document.getElementById(fieldId);
    if (!originalField) {
        showToast('Field not found', 'error');
        return;
    }
    
    const currentValue = originalField.value;
    const isCreatorNotes = fieldId === 'editCreatorNotes';
    
    // Get field-specific icon
    const fieldIcons = {
        'editDescription': 'fa-solid fa-user',
        'editPersonality': 'fa-solid fa-brain',
        'editScenario': 'fa-solid fa-map',
        'editSystemPrompt': 'fa-solid fa-terminal',
        'editPostHistoryInstructions': 'fa-solid fa-clock-rotate-left',
        'editCreatorNotes': 'fa-solid fa-feather-pointed',
        'editMesExample': 'fa-solid fa-quote-left'
    };
    const fieldIcon = fieldIcons[fieldId] || 'fa-solid fa-expand';
    
    // Preview toggle button only for Creator's Notes
    const previewToggleHtml = isCreatorNotes ? `
        <button id="expandFieldPreviewToggle" class="action-btn secondary" title="Toggle Preview">
            <i class="fa-solid fa-eye"></i> Preview
        </button>
    ` : '';
    
    // Create expand modal
    const expandModalHtml = `
        <div id="expandFieldModal" class="modal-overlay">
            <div class="modal-glass expand-field-modal">
                <div class="modal-header">
                    <h2><i class="${fieldIcon}"></i> ${escapeHtml(fieldLabel)}</h2>
                    <div class="modal-controls">
                        ${previewToggleHtml}
                        <button id="expandFieldSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="close-btn" id="expandFieldClose">&times;</button>
                    </div>
                </div>
                <div class="expand-field-body" id="expandFieldBody">
                    <textarea id="expandFieldTextarea" class="glass-input expand-field-textarea" placeholder="Enter ${escapeHtml(fieldLabel.toLowerCase())}...">${escapeHtml(currentValue)}</textarea>
                    ${isCreatorNotes ? '<div id="expandFieldPreview" class="expand-field-preview scrolling-text" style="display: none;"></div>' : ''}
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('expandFieldModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', expandModalHtml);
    
    const expandModal = document.getElementById('expandFieldModal');
    const expandTextarea = document.getElementById('expandFieldTextarea');
    
    // Focus textarea and move cursor to end
    setTimeout(() => {
        expandTextarea.focus();
        expandTextarea.setSelectionRange(expandTextarea.value.length, expandTextarea.value.length);
    }, 50);
    
    // Preview toggle for Creator's Notes
    if (isCreatorNotes) {
        const previewToggle = document.getElementById('expandFieldPreviewToggle');
        const previewDiv = document.getElementById('expandFieldPreview');
        let isPreviewMode = false;
        
        previewToggle.onclick = () => {
            isPreviewMode = !isPreviewMode;
            
            if (isPreviewMode) {
                // Switch to preview mode
                expandTextarea.style.display = 'none';
                previewDiv.style.display = 'block';
                previewDiv.innerHTML = formatRichText(expandTextarea.value, 'Character', true);
                previewToggle.innerHTML = '<i class="fa-solid fa-code"></i> Edit';
                previewToggle.title = 'Switch to Edit Mode';
            } else {
                // Switch to edit mode
                expandTextarea.style.display = 'block';
                previewDiv.style.display = 'none';
                previewToggle.innerHTML = '<i class="fa-solid fa-eye"></i> Preview';
                previewToggle.title = 'Toggle Preview';
                expandTextarea.focus();
            }
        };
    }
    
    // Close handlers
    const closeExpandModal = () => {
        expandModal.remove();
    };
    
    document.getElementById('expandFieldClose').onclick = closeExpandModal;
    expandModal.onclick = (e) => { if (e.target === expandModal) closeExpandModal(); };
    
    // Handle Escape key
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            closeExpandModal();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);
    
    // Save/Apply handler
    document.getElementById('expandFieldSave').onclick = () => {
        const newValue = expandTextarea.value;
        // Re-query the original field to ensure we have a fresh reference
        const targetField = document.getElementById(fieldId);
        if (targetField) {
            targetField.value = newValue;
            // Trigger input event so any listeners know the value changed
            targetField.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            console.error('[ExpandField] Could not find target field:', fieldId);
        }
        
        closeExpandModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Changes applied to field', 'success');
    };
}

/**
 * Open a read-only expanded view for ChubAI character preview sections
 */
function openChubExpandedView(sectionId, label, iconClass) {
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) {
        showToast('Section not found', 'error');
        return;
    }
    
    // Check if we have full content stored (for truncated sections like First Message)
    let content;
    if (sectionEl.dataset.fullContent) {
        // Use stored full content and format it
        const charName = document.getElementById('chubCharName')?.textContent || 'Character';
        content = formatRichText(sectionEl.dataset.fullContent, charName, true);
    } else {
        // Check if section contains an iframe (Creator's Notes uses secure iframe rendering)
        const existingIframe = sectionEl.querySelector('iframe');
        if (existingIframe && existingIframe.contentDocument?.body) {
            // Extract content from existing iframe
            content = existingIframe.contentDocument.body.innerHTML;
        } else {
            // Use innerHTML directly
            content = sectionEl.innerHTML;
        }
    }
    
    // Build iframe document like Creator's Notes does
    const iframeStyles = `<style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #e0e0e0;
            background: transparent;
            line-height: 1.7;
            font-size: 1rem;
            margin: 0;
            padding: 20px;
        }
        a { color: #4a9eff; }
        img, video { max-width: 100%; height: auto; border-radius: 8px; }
        pre, code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }
        blockquote { border-left: 3px solid #4a9eff; margin-left: 0; padding-left: 15px; opacity: 0.9; }
        .char-placeholder { color: #4a9eff; font-weight: 500; }
        .user-placeholder { color: #9b59b6; font-weight: 500; }
        iframe { max-width: 100%; border-radius: 8px; }
    </style>`;
    const iframeDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8">${iframeStyles}</head><body>${content}</body></html>`;
    
    // Create expanded view modal with size and zoom controls (same pattern as Creator's Notes)
    const expandModalHtml = `
        <div id="chubExpandModal" class="modal-overlay">
            <div class="modal-glass chub-expand-modal" id="chubExpandModalInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="${iconClass}"></i> ${escapeHtml(label)}</h2>
                    <div class="chub-expand-display-controls">
                        <div class="display-control-btns zoom-controls" id="chubExpandZoomControls">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="chubExpandZoomDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                        <div class="display-control-btns" id="chubExpandSizeControls">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="chubExpandClose">&times;</button>
                    </div>
                </div>
                <div class="chub-expand-body">
                    <iframe id="chubExpandIframe" sandbox="allow-same-origin"></iframe>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('chubExpandModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', expandModalHtml);
    
    const expandModal = document.getElementById('chubExpandModal');
    const modalInner = document.getElementById('chubExpandModalInner');
    const iframe = document.getElementById('chubExpandIframe');
    
    // Set iframe content
    iframe.srcdoc = iframeDoc;
    
    // Size control handlers
    document.getElementById('chubExpandSizeControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#chubExpandSizeControls .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    };
    
    // Zoom controls - apply to iframe body (same as Creator's Notes)
    let chubExpandZoom = 100;
    const zoomDisplay = document.getElementById('chubExpandZoomDisplay');
    
    const updateZoom = (zoom) => {
        chubExpandZoom = Math.max(50, Math.min(200, zoom));
        zoomDisplay.textContent = `${chubExpandZoom}%`;
        iframe.contentDocument?.body?.style.setProperty('zoom', `${chubExpandZoom}%`);
    };
    
    document.getElementById('chubExpandZoomControls').onclick = (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updateZoom(chubExpandZoom + 10);
        else if (action === 'out') updateZoom(chubExpandZoom - 10);
        else if (action === 'reset') updateZoom(100);
    };
    
    // Close handlers
    const closeExpandModal = () => expandModal.remove();
    
    document.getElementById('chubExpandClose').onclick = closeExpandModal;
    expandModal.onclick = (e) => { if (e.target === expandModal) closeExpandModal(); };
    
    // Handle Escape key
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            closeExpandModal();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Initialize ChubAI section title clicks for expand
 */
function initChubExpandButtons() {
    document.querySelectorAll('.chub-section-title').forEach(title => {
        title.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const sectionId = title.dataset.section;
            const label = title.dataset.label;
            const iconClass = title.dataset.icon;
            if (sectionId === 'chubCharAltGreetings') {
                const greetings = window.currentChubAltGreetings || [];
                const charName = document.getElementById('chubCharName')?.textContent || 'Character';
                openAltGreetingsFullscreen(greetings, charName);
                return;
            }
            openChubExpandedView(sectionId, label, iconClass);
        });
    });
}

// Chats Functions
async function fetchCharacterChats(char) {
    const chatsList = document.getElementById('chatsList');
    if (!chatsList) return;
    
    renderLoadingState(chatsList, 'Loading chats...', 'chats-loading');
    
    try {
        const response = await apiRequest(ENDPOINTS.CHARACTERS_CHATS, 'POST', { 
            avatar_url: char.avatar, 
            metadata: true 
        });
        
        if (!response.ok) {
            chatsList.innerHTML = '<div class="no-chats"><i class="fa-solid fa-exclamation-circle"></i><p>Failed to load chats</p></div>';
            return;
        }
        
        const chats = await response.json();
        
        if (chats.error || !chats.length) {
            chatsList.innerHTML = `
                <div class="no-chats">
                    <i class="fa-solid fa-comments"></i>
                    <p>No chats found for this character</p>
                </div>
            `;
            return;
        }
        
        // Sort by date (most recent first)
        chats.sort((a, b) => {
            const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
            const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
            return dateB - dateA;
        });
        
        const currentChat = char.chat;
        
        chatsList.innerHTML = chats.map(chat => {
            const isActive = chat.file_name === currentChat + '.jsonl';
            const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
            const messageCount = chat.chat_items || chat.mes_count || chat.message_count || '?';
            const chatName = chat.file_name.replace('.jsonl', '');
            
            return `
                <div class="chat-item ${isActive ? 'active' : ''}" data-chat="${escapeHtml(chat.file_name)}">
                    <div class="chat-item-icon">
                        <i class="fa-solid fa-message"></i>
                    </div>
                    <div class="chat-item-info">
                        <div class="chat-item-name">${escapeHtml(chatName)}</div>
                        <div class="chat-item-meta">
                            <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                            <span><i class="fa-solid fa-comment"></i> ${messageCount} messages</span>
                            ${isActive ? '<span style="color: var(--accent);"><i class="fa-solid fa-check-circle"></i> Current</span>' : ''}
                        </div>
                    </div>
                    <div class="chat-item-actions">
                        <button class="chat-action-btn" title="Open chat" data-action="open"><i class="fa-solid fa-arrow-right"></i></button>
                        <button class="chat-action-btn danger" title="Delete chat" data-action="delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `;
        }).join('');
        
        // Add chat item click handlers
        chatsList.querySelectorAll('.chat-item').forEach(item => {
            const chatFile = item.dataset.chat;
            
            // Main click to open
            item.addEventListener('click', (e) => {
                if (e.target.closest('.chat-action-btn')) return;
                openChat(char, chatFile);
            });
            
            // Action buttons
            item.querySelectorAll('.chat-action-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = btn.dataset.action;
                    if (action === 'open') {
                        openChat(char, chatFile);
                    } else if (action === 'delete') {
                        deleteChat(char, chatFile);
                    }
                });
            });
        });
        
    } catch (e) {
        chatsList.innerHTML = `<div class="no-chats"><i class="fa-solid fa-exclamation-triangle"></i><p>Error: ${escapeHtml(e.message)}</p></div>`;
    }
}

async function openChat(char, chatFile) {
    // Load the character with specific chat
    try {
        const chatName = chatFile.replace('.jsonl', '');
        
        // Show toast immediately
        showToast("Opening chat...", "success");
        
        // Close any open modals
        hide('chatPreviewModal');
        document.querySelector('.modal-overlay')?.classList.add('hidden');
        
        // IMPORTANT: Register the gallery folder override BEFORE opening the chat
        // This ensures index.js can find the correct folder for media localization
        // Use immediate save since we're about to switch context to main window
        if (getSetting('uniqueGalleryFolders') && getCharacterGalleryId(char)) {
            registerGalleryFolderOverride(char, true);
        }
        
        if (window.opener && !window.opener.closed) {
            let context = null;
            let mainCharacters = [];
            
            if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                context = window.opener.SillyTavern.getContext();
                mainCharacters = context.characters || [];
            } else if (window.opener.characters) {
                mainCharacters = window.opener.characters;
            }
            
            // Find character index
            const characterIndex = mainCharacters.findIndex(c => c.avatar === char.avatar);
            
            if (characterIndex !== -1 && context) {
                // First select the character
                await context.selectCharacterById(characterIndex);
                
                // Wait a short moment for character to load
                await new Promise(r => setTimeout(r, 200));
                
                // Try to open the specific chat using the chat manager
                if (context.openChat) {
                    await context.openChat(chatName);
                } else if (window.opener.jQuery) {
                    // Alternative: trigger chat selection via UI
                    const $ = window.opener.jQuery;
                    // Look for chat in the chat list and click it
                    const chatItems = $('#past_chats_popup .select_chat_block_wrapper');
                    chatItems.each(function() {
                        if ($(this).attr('file_name') === chatName) {
                            $(this).trigger('click');
                        }
                    });
                }
                
                return;
            }
        }
        
        // Fallback: open in new tab with URL params
        showToast("Opening in main window...", "info");
        if (window.opener && !window.opener.closed) {
            window.opener.location.href = `/?character=${encodeURIComponent(char.avatar)}`;
            window.opener.focus();
        }
    } catch (e) {
        console.error('openChat error:', e);
        showToast("Could not open chat: " + e.message, "error");
    }
}

async function deleteChat(char, chatFile) {
    if (!confirm(`Are you sure you want to delete this chat?\n\n${chatFile}\n\nThis cannot be undone!`)) {
        return;
    }
    
    try {
        const response = await apiRequest(ENDPOINTS.CHATS_DELETE, 'POST', {
            chatfile: chatFile,
            avatar_url: char.avatar
        });
        
        if (response.ok) {
            showToast("Chat deleted", "success");
            fetchCharacterChats(char); // Refresh list
        } else {
            showToast("Failed to delete chat", "error");
        }
    } catch (e) {
        showToast("Error deleting chat: " + e.message, "error");
    }
}

async function createNewChat(char) {
    try {
        // Load character which creates new chat
        if (await loadCharInMain(char, true)) {
            showToast("Creating new chat...", "success");
        }
    } catch (e) {
        showToast("Could not create new chat: " + e.message, "error");
    }
}

// Search and Filter Functionality (Global so it can be called from view switching)
function performSearch() {
    const rawQuery = document.getElementById('searchInput').value;
    
    const useName = document.getElementById('searchName').checked;
    const useTags = document.getElementById('searchTags').checked;
    const useAuthor = document.getElementById('searchAuthor').checked;
    const useNotes = document.getElementById('searchNotes').checked;
    
    // Check for special prefix syntaxes
    const creatorMatch = rawQuery.match(/^creator:(.+)$/i);
    const creatorFilter = creatorMatch ? creatorMatch[1].trim().toLowerCase() : null;
    
    // Check for version: prefix
    const versionMatch = rawQuery.match(/^version:(.+)$/i);
    const versionFilter = versionMatch ? versionMatch[1].trim().toLowerCase() : null;
    
    // Check for favorite: prefix (favorite:yes, favorite:no, fav:yes, fav:no)
    const favoriteMatch = rawQuery.match(/^(?:favorite|fav):(yes|no|true|false)$/i);
    const favoriteFilter = favoriteMatch ? favoriteMatch[1].toLowerCase() : null;
    const filterFavoriteYes = favoriteFilter === 'yes' || favoriteFilter === 'true';
    const filterFavoriteNo = favoriteFilter === 'no' || favoriteFilter === 'false';
    
    // Check for chub: prefix (chub:yes, chub:no, chub:linked, chub:unlinked)
    const chubMatch = rawQuery.match(/^chub:(yes|no|true|false|linked|unlinked)$/i);
    const chubFilter = chubMatch ? chubMatch[1].toLowerCase() : null;
    const filterChubLinked = chubFilter === 'yes' || chubFilter === 'true' || chubFilter === 'linked';
    const filterChubUnlinked = chubFilter === 'no' || chubFilter === 'false' || chubFilter === 'unlinked';
    
    // Clean query: remove special prefixes
    let query = rawQuery.toLowerCase();
    if (creatorFilter) query = '';
    if (versionFilter) query = '';
    if (favoriteFilter !== null) query = '';
    if (chubFilter !== null) query = '';

    const filtered = allCharacters.filter(c => {
        let matchesSearch = false;
        
        // Special creator: filter - exact creator match only
        if (creatorFilter) {
            const author = (c.creator || (c.data ? c.data.creator : "") || "").toLowerCase();
            return author === creatorFilter || author.includes(creatorFilter);
        }
        
        // Special version: filter - match character_version field
        if (versionFilter) {
            const version = (c.character_version || (c.data ? c.data.character_version : "") || "").toLowerCase();
            if (versionFilter === 'none' || versionFilter === 'empty') {
                return !version;
            }
            return version === versionFilter || version.includes(versionFilter);
        }
        
        // Special favorite: filter from search bar
        if (favoriteFilter !== null) {
            const isFav = isCharacterFavorite(c);
            if (filterFavoriteYes && !isFav) return false;
            if (filterFavoriteNo && isFav) return false;
            return true;
        }
        
        // Special chub: filter - filter by ChubAI link status
        if (chubFilter !== null) {
            const chubInfo = getChubLinkInfo(c);
            const isLinked = chubInfo && chubInfo.fullPath;
            if (filterChubLinked && !isLinked) return false;
            if (filterChubUnlinked && isLinked) return false;
            return true;
        }
        
        // Favorites-only filter (from toolbar button)
        if (showFavoritesOnly) {
            if (!isCharacterFavorite(c)) return false;
        }

        // 1. Text Search Logic
        if (!query) {
            matchesSearch = true; // No text query? Everything matches text criteria
        } else {
            // Name
            if (useName && c.name.toLowerCase().includes(query)) matchesSearch = true;
            
            // Tags (String Match)
            if (!matchesSearch && useTags) {
                 const tags = (c.tags && Array.isArray(c.tags)) ? c.tags.join(' ') : 
                              (c.data && c.data.tags) ? String(c.data.tags) : "";
                 if (tags.toLowerCase().includes(query)) matchesSearch = true;
            }
            
            // Author
            if (!matchesSearch && useAuthor) {
                const author = c.creator || (c.data ? c.data.creator : "") || "";
                if (author.toLowerCase().includes(query)) matchesSearch = true;
            }

            // Creator Notes
            if (!matchesSearch && useNotes) {
                 const notes = c.creator_notes || (c.data ? c.data.creator_notes : "") || "";
                 if (notes.toLowerCase().includes(query)) matchesSearch = true;
            }
        }

        // 2. Tag Filter Logic - Tri-state: include, exclude, neutral
        if (activeTagFilters.size > 0) {
             const charTags = getTags(c);
             
             // Get included and excluded tags
             const includedTags = [];
             const excludedTags = [];
             activeTagFilters.forEach((state, tag) => {
                 if (state === 'include') includedTags.push(tag);
                 else if (state === 'exclude') excludedTags.push(tag);
             });
             
             // If any excluded tags match, reject
             if (excludedTags.length > 0 && charTags.some(t => excludedTags.includes(t))) {
                 return false;
             }
             
             // If there are included tags, must have at least one
             if (includedTags.length > 0 && !charTags.some(t => includedTags.includes(t))) {
                 return false;
             }
        }

        return matchesSearch;
    });
    
    // Also apply current sort
    const sortSelect = document.getElementById('sortSelect');
    const sortType = sortSelect ? sortSelect.value : 'name_asc';
    const sorted = [...filtered].sort((a, b) => {
        if (sortType === 'name_asc') return a.name.localeCompare(b.name);
        if (sortType === 'name_desc') return b.name.localeCompare(a.name);
        if (sortType === 'date_new') return getCharacterDateAdded(b) - getCharacterDateAdded(a); 
        if (sortType === 'date_old') return getCharacterDateAdded(a) - getCharacterDateAdded(b);
        if (sortType === 'created_new') return getCharacterCreateDate(b) - getCharacterCreateDate(a);
        if (sortType === 'created_old') return getCharacterCreateDate(a) - getCharacterCreateDate(b);
        return 0;
    });
    
    // Keep currentCharacters in sync with sorted/filtered result
    // This ensures the sort change handler (and any other consumer) works with 
    // the same data that was just rendered, preventing stale-order bugs.
    currentCharacters = sorted;
    
    renderGrid(sorted);
}

function updateMobileChatButtonVisibility() {
    const chatBtn = document.getElementById('modalChatBtn');
    if (!chatBtn) return;

    const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile) {
        chatBtn.classList.remove('mobile-chat-hidden');
        return;
    }

    const isDetailsActive = document.querySelector('.tab-btn[data-tab="details"]')?.classList.contains('active');
    chatBtn.classList.toggle('mobile-chat-hidden', !isDetailsActive);
}

/**
 * Filter local cards view by creator name
 * Sets the search to "creator:Name" and ensures Author filter is checked
 */
function filterLocalByCreator(creatorName) {
    debugLog('[Gallery] Filtering local by creator:', creatorName);
    
    // Switch to characters view if not already there
    if (currentView !== 'characters') {
        switchView('characters');
    }
    
    // Set search input to creator filter syntax
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    if (searchInput) {
        searchInput.value = `creator:${creatorName}`;
        // Show clear button since we're populating programmatically
        if (clearSearchBtn) clearSearchBtn.classList.remove('hidden');
    }
    
    // Ensure Author checkbox is checked
    const authorCheckbox = document.getElementById('searchAuthor');
    if (authorCheckbox) {
        authorCheckbox.checked = true;
    }
    
    // Trigger search
    performSearch();
    
    showToast(`Filtering by creator: ${creatorName}`, 'info');
}

// Debounced search for better performance (150ms delay)
const debouncedSearch = debounce(performSearch, 150);

// Event Listeners
function setupEventListeners() {
    on('searchInput', 'input', debouncedSearch);

    // Filter Checkboxes
    ['searchName', 'searchTags', 'searchAuthor', 'searchNotes'].forEach(id => {
        on(id, 'change', performSearch);
    });

    // Tag Filter Toggle
    const tagBtn = document.getElementById('tagFilterBtn');
    const tagPopup = document.getElementById('tagFilterPopup');
    const clearAllTagsBtn = document.getElementById('clearAllTagsBtn');

    if (tagBtn && tagPopup) {
        tagBtn.onclick = (e) => {
            e.stopPropagation();
            tagPopup.classList.toggle('hidden');
        };
        
        // Clear all tags button
        if (clearAllTagsBtn) {
            clearAllTagsBtn.onclick = (e) => {
                e.stopPropagation();
                clearAllTagFilters();
            };
        }
        
        // Close rules
        window.addEventListener('click', (e) => {
            if (!tagPopup.classList.contains('hidden') && 
                !tagPopup.contains(e.target) && 
                e.target !== tagBtn && 
                !tagBtn.contains(e.target)) {
                tagPopup.classList.add('hidden');
            }
        });
    }

    // Settings Toggle
    const settingsBtn = document.getElementById('searchSettingsBtn');
    const settingsMenu = document.getElementById('searchSettingsMenu');
    
    if(settingsBtn && settingsMenu) {
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            settingsMenu.classList.toggle('hidden');
        };

        // Close when clicking outside
        window.addEventListener('click', (e) => {
            if (!settingsMenu.classList.contains('hidden') && 
                !settingsMenu.contains(e.target) && 
                e.target !== settingsBtn && 
                !settingsBtn.contains(e.target)) {
                settingsMenu.classList.add('hidden');
            }
        });
    }
    
    // More Options Dropdown Toggle
    const moreOptionsBtn = document.getElementById('moreOptionsBtn');
    const moreOptionsMenu = document.getElementById('moreOptionsMenu');
    
    if(moreOptionsBtn && moreOptionsMenu) {
        moreOptionsBtn.onclick = (e) => {
            e.stopPropagation();
            moreOptionsMenu.classList.toggle('hidden');
        };

        // Close when clicking outside
        window.addEventListener('click', (e) => {
            if (!moreOptionsMenu.classList.contains('hidden') && 
                !moreOptionsMenu.contains(e.target) && 
                e.target !== moreOptionsBtn && 
                !moreOptionsBtn.contains(e.target)) {
                moreOptionsMenu.classList.add('hidden');
            }
        });
        
        // Close menu when clicking any item inside
        moreOptionsMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                moreOptionsMenu.classList.add('hidden');
            });
        });
    }
    
    // Clear Search Button
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const searchInputEl = document.getElementById('searchInput');
    
    if (clearSearchBtn && searchInputEl) {
        // Show/hide clear button based on input
        searchInputEl.addEventListener('input', () => {
            clearSearchBtn.classList.toggle('hidden', searchInputEl.value.length === 0);
        });
        
        // Clear search when clicked
        clearSearchBtn.addEventListener('click', () => {
            searchInputEl.value = '';
            clearSearchBtn.classList.add('hidden');
            performSearch();
        });
    }

    // Sort — delegate to performSearch so there is ONE sort+render codepath.
    // This eliminates the dual-sort bug where the sort handler and performSearch
    // could produce different results from stale/divergent data.
    on('sortSelect', 'change', () => {
        performSearch();
    });
    
    // Favorites Filter Toggle
    on('favoritesFilterBtn', 'click', toggleFavoritesFilter);
    
    // Favorite Character Button in Modal
    const favoriteCharBtn = document.getElementById('favoriteCharBtn');
    if (favoriteCharBtn) {
        favoriteCharBtn.addEventListener('click', () => {
            if (activeChar) {
                toggleCharacterFavorite(activeChar);
            }
        });
    }

    // Refresh - preserves current filters and search
    on('refreshBtn', 'click', async () => {
        // Don't reset filters - just refresh the data
        document.getElementById('characterGrid').innerHTML = '';
        document.getElementById('loading').style.display = 'block';
        
        // Also force the opener to re-read its character list so its in-memory
        // state is current. This prevents a stale opener from overwriting
        // settings on its next save.
        try {
            if (window.opener && !window.opener.closed && window.opener.SillyTavern?.getContext) {
                const ctx = window.opener.SillyTavern.getContext();
                if (typeof ctx?.getCharacters === 'function') {
                    ctx.getCharacters().catch(e => console.warn('[Refresh] Opener refresh failed:', e));
                }
            }
        } catch (e) { /* opener unavailable */ }
        
        await fetchCharacters(true); // Force refresh from API
        // Re-apply current search/filters after fetch
        performSearch();
    });
    
    // Delete Character Button
    const deleteCharBtn = document.getElementById('deleteCharBtn');
    if (deleteCharBtn) {
        deleteCharBtn.addEventListener('click', () => {
            if (activeChar) {
                showDeleteConfirmation(activeChar);
            }
        });
    }

    // Close Modal
    on('modalClose', 'click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Tabs
    getTabButtons().forEach(btn => {
        btn.addEventListener('click', () => {
            deactivateAllTabs();
            
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            const pane = document.getElementById(`pane-${tabId}`);
            pane.classList.add('active');
            
            // Reset scroll position when switching tabs
            pane.scrollTop = 0;

            updateMobileChatButtonVisibility();
        });
    });
    
    // Chat Button
    document.getElementById('modalChatBtn').onclick = async () => {
        if (activeChar) {
            // Pass the whole character object now, just in case we need the name for slash command
            if (await loadCharInMain(activeChar)) {
                // Optional: Close gallery?
            }
        }
    };

    updateMobileChatButtonVisibility();

    setupCharacterGridDelegates();
    
    // Save Button
    document.getElementById('saveEditBtn').onclick = saveCharacter;
    
    // Cancel Edit Button
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    if (cancelEditBtn) {
        cancelEditBtn.onclick = cancelEditing;
    }
    
    // Edit Lock Toggle Button
    const toggleEditLockBtn = document.getElementById('toggleEditLockBtn');
    if (toggleEditLockBtn) {
        toggleEditLockBtn.onclick = () => setEditLock(!isEditLocked);
    }
    
    // Confirmation Modal Buttons
    const confirmSaveBtn = document.getElementById('confirmSaveBtn');
    const cancelSaveBtn = document.getElementById('cancelSaveBtn');
    const closeConfirmModal = document.getElementById('closeConfirmModal');
    const confirmModal = document.getElementById('confirmSaveModal');
    
    if (confirmSaveBtn) {
        confirmSaveBtn.onclick = performSave;
    }
    if (cancelSaveBtn) {
        cancelSaveBtn.onclick = () => confirmModal?.classList.add('hidden');
    }
    if (closeConfirmModal) {
        closeConfirmModal.onclick = () => confirmModal?.classList.add('hidden');
    }
    
    // Chats Tab Buttons
    const newChatBtn = document.getElementById('newChatBtn');
    const refreshChatsBtn = document.getElementById('refreshChatsBtn');
    
    if (newChatBtn) {
        newChatBtn.onclick = () => {
            if (activeChar) createNewChat(activeChar);
        };
    }
    if (refreshChatsBtn) {
        refreshChatsBtn.onclick = () => {
            if (activeChar) fetchCharacterChats(activeChar);
        };
    }
    
    // Gallery Settings Modal
    setupSettingsModal();
    
    // Add Alternate Greeting Button
    const addAltGreetingBtn = document.getElementById('addAltGreetingBtn');
    if (addAltGreetingBtn) {
        addAltGreetingBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            addAltGreetingField();
        };
    }
    
    // Add Lorebook Entry Button
    const addLorebookEntryBtn = document.getElementById('addLorebookEntryBtn');
    if (addLorebookEntryBtn) {
        addLorebookEntryBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            addLorebookEntryField();
            updateLorebookCount();
        };
    }

    // Upload Zone
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('imageUploadInput');
    
    if (uploadZone && fileInput) {
        uploadZone.onclick = (e) => {
            if (e.target !== fileInput) fileInput.click();
        };

        fileInput.onchange = (e) => {
            if (e.target.files.length) uploadImages(e.target.files);
            fileInput.value = ''; 
        };
        
        // Drag and drop
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = 'var(--accent)';
            uploadZone.style.backgroundColor = 'rgba(74, 158, 255, 0.1)';
        });
        
        uploadZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '';
            uploadZone.style.backgroundColor = '';
        });
        
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '';
            uploadZone.style.backgroundColor = '';
            if (e.dataTransfer.files.length) uploadImages(e.dataTransfer.files);
        });
    }
}

// Alternate Greetings Editor Functions
function populateAltGreetingsEditor(greetings) {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (greetings && greetings.length > 0) {
        greetings.forEach((greeting, index) => {
            addAltGreetingField(container, (greeting || '').trim(), index);
        });
    }
}

function addAltGreetingField(container, value = '', index = null) {
    if (!container) {
        container = document.getElementById('altGreetingsEditContainer');
    }
    if (!container) return;
    
    const idx = index !== null ? index : container.children.length;
    
    const wrapper = document.createElement('div');
    wrapper.className = 'alt-greeting-item';
    wrapper.style.cssText = 'position: relative; margin-bottom: 10px;';
    
    wrapper.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 8px;">
            <span style="color: var(--accent); font-weight: bold; padding-top: 8px;">#${idx + 1}</span>
            <textarea class="glass-input alt-greeting-input" rows="3" placeholder="Alternate greeting message..." style="flex: 1;"></textarea>
            <button type="button" class="remove-alt-greeting-btn" style="background: rgba(255,100,100,0.2); border: 1px solid rgba(255,100,100,0.3); color: #f88; padding: 8px 10px; border-radius: 6px; cursor: pointer;" title="Remove this greeting">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `;
    
    container.appendChild(wrapper);
    
    // Set the textarea value directly (not via innerHTML) to ensure .value property is set
    const textarea = wrapper.querySelector('.alt-greeting-input');
    if (textarea && value) {
        textarea.value = value;
    }
    
    // Add remove button handler
    const removeBtn = wrapper.querySelector('.remove-alt-greeting-btn');
    removeBtn.addEventListener('click', () => {
        wrapper.remove();
        renumberAltGreetings();
    });
}

function renumberAltGreetings() {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return;
    
    const items = container.querySelectorAll('.alt-greeting-item');
    items.forEach((item, idx) => {
        const numSpan = item.querySelector('span');
        if (numSpan) {
            numSpan.textContent = `#${idx + 1}`;
        }
    });
}

function getAltGreetingsFromEditor() {
    const container = document.getElementById('altGreetingsEditContainer');
    if (!container) return [];
    
    const inputs = container.querySelectorAll('.alt-greeting-input');
    const greetings = [];
    
    inputs.forEach(input => {
        const value = input.value;
        if (value.trim()) {  // Skip truly empty entries, but preserve original content
            greetings.push(value);
        }
    });
    
    return greetings;
}

// ==========================================
// Lorebook Editor Functions
// ==========================================

/**
 * Populate the lorebook editor with existing entries
 * @param {Object} characterBook - The character_book object from the character
 */
function populateLorebookEditor(characterBook) {
    const container = document.getElementById('lorebookEntriesEdit');
    const countEl = document.getElementById('lorebookEditCount');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    const entries = characterBook?.entries || [];
    
    if (countEl) {
        countEl.textContent = `(${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`;
    }
    
    entries.forEach((entry, index) => {
        addLorebookEntryField(container, entry, index);
    });
}

/**
 * Add a lorebook entry field to the editor
 * @param {HTMLElement} container - The container element
 * @param {Object} entry - The lorebook entry object (or null for new entry)
 * @param {number} index - The index of the entry
 */
function addLorebookEntryField(container, entry = null, index = null) {
    if (!container) {
        container = document.getElementById('lorebookEntriesEdit');
    }
    if (!container) return;
    
    const idx = index !== null ? index : container.children.length;
    
    // Default values for new entry
    const name = entry?.comment || entry?.name || '';
    const keys = entry?.keys || entry?.key || [];
    const keyStr = Array.isArray(keys) ? keys.join(', ') : keys;
    const secondaryKeys = entry?.secondary_keys || [];
    const secondaryKeyStr = Array.isArray(secondaryKeys) ? secondaryKeys.join(', ') : secondaryKeys;
    const content = entry?.content || '';
    const enabled = entry?.enabled !== false;
    const selective = entry?.selective || false;
    const constant = entry?.constant || false;
    const order = entry?.order ?? entry?.insertion_order ?? idx;
    const priority = entry?.priority ?? 10;
    
    const wrapper = document.createElement('div');
    wrapper.className = `lorebook-entry-edit${enabled ? '' : ' disabled'}`;
    wrapper.dataset.index = idx;
    
    wrapper.innerHTML = `
        <div class="lorebook-entry-header">
            <input type="text" class="glass-input lorebook-entry-name-input" placeholder="Entry name/comment" style="flex: 1; font-weight: 600;">
            <div class="lorebook-entry-controls">
                <label class="lorebook-entry-toggle ${enabled ? 'enabled' : 'disabled'}" title="Toggle enabled">
                    <input type="checkbox" class="lorebook-enabled-checkbox" ${enabled ? 'checked' : ''} style="display: none;">
                    ${enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}
                </label>
                <span class="lorebook-entry-delete" title="Delete entry">
                    <i class="fa-solid fa-trash"></i>
                </span>
            </div>
        </div>
        <div class="lorebook-entry-fields">
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Keys <span class="label-hint">(comma-separated)</span></label>
                    <input type="text" class="glass-input lorebook-keys-input" placeholder="keyword1, keyword2">
                </div>
            </div>
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Secondary Keys <span class="label-hint">(optional, for selective)</span></label>
                    <input type="text" class="glass-input lorebook-secondary-keys-input" placeholder="secondary1, secondary2">
                </div>
            </div>
            <div class="lorebook-entry-row">
                <div class="form-group flex-1">
                    <label>Content</label>
                    <textarea class="glass-input lorebook-content-input" rows="3" placeholder="Lore content..."></textarea>
                </div>
            </div>
            <div class="lorebook-entry-row" style="gap: 15px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" class="lorebook-selective-checkbox" ${selective ? 'checked' : ''}>
                    <span style="font-size: 0.85em;">Selective</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" class="lorebook-constant-checkbox" ${constant ? 'checked' : ''}>
                    <span style="font-size: 0.85em;">Constant</span>
                </label>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <label style="font-size: 0.85em;">Order:</label>
                    <input type="number" class="glass-input lorebook-order-input" style="width: 60px; padding: 4px 8px;">
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <label style="font-size: 0.85em;">Priority:</label>
                    <input type="number" class="glass-input lorebook-priority-input" style="width: 60px; padding: 4px 8px;">
                </div>
            </div>
        </div>
    `;
    
    container.appendChild(wrapper);
    
    // Set input values directly (not via innerHTML) to ensure .value properties are set correctly
    wrapper.querySelector('.lorebook-entry-name-input').value = name;
    wrapper.querySelector('.lorebook-keys-input').value = keyStr;
    wrapper.querySelector('.lorebook-secondary-keys-input').value = secondaryKeyStr;
    wrapper.querySelector('.lorebook-content-input').value = content;
    wrapper.querySelector('.lorebook-order-input').value = order;
    wrapper.querySelector('.lorebook-priority-input').value = priority;
    
    // Toggle enabled handler
    const toggleLabel = wrapper.querySelector('.lorebook-entry-toggle');
    toggleLabel.addEventListener('click', (e) => {
        e.preventDefault();
        const checkbox = wrapper.querySelector('.lorebook-enabled-checkbox');
        const isEnabled = checkbox.checked;
        const newEnabled = !isEnabled;
        checkbox.checked = newEnabled;
        toggleLabel.className = `lorebook-entry-toggle ${newEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="lorebook-enabled-checkbox" ${newEnabled ? 'checked' : ''} style="display: none;">${newEnabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}`;
        wrapper.classList.toggle('disabled', !newEnabled);
    });
    
    // Delete handler
    const deleteBtn = wrapper.querySelector('.lorebook-entry-delete');
    deleteBtn.addEventListener('click', () => {
        wrapper.remove();
        updateLorebookCount();
    });
}

/**
 * Update the lorebook entry count display
 */
function updateLorebookCount() {
    const container = document.getElementById('lorebookEntriesEdit');
    const countEl = document.getElementById('lorebookEditCount');
    
    if (container && countEl) {
        const count = container.children.length;
        countEl.textContent = `(${count} ${count === 1 ? 'entry' : 'entries'})`;
    }
}

/**
 * Get lorebook entries from the editor
 * @returns {Array} Array of lorebook entry objects
 */
function getLorebookFromEditor() {
    const container = document.getElementById('lorebookEntriesEdit');
    if (!container) return [];
    
    const entries = [];
    const entryEls = container.querySelectorAll('.lorebook-entry-edit');
    
    entryEls.forEach((el, idx) => {
        const name = el.querySelector('.lorebook-entry-name-input')?.value.trim() || `Entry ${idx + 1}`;
        const keysStr = el.querySelector('.lorebook-keys-input')?.value || '';
        const secondaryKeysStr = el.querySelector('.lorebook-secondary-keys-input')?.value || '';
        const content = el.querySelector('.lorebook-content-input')?.value || '';
        const enabled = el.querySelector('.lorebook-enabled-checkbox')?.checked ?? true;
        const selective = el.querySelector('.lorebook-selective-checkbox')?.checked || false;
        const constant = el.querySelector('.lorebook-constant-checkbox')?.checked || false;
        const order = parseInt(el.querySelector('.lorebook-order-input')?.value) || idx;
        const priority = parseInt(el.querySelector('.lorebook-priority-input')?.value) || 10;
        
        // Parse keys
        const keys = keysStr.split(',').map(k => k.trim()).filter(k => k);
        const secondaryKeys = secondaryKeysStr.split(',').map(k => k.trim()).filter(k => k);
        
        entries.push({
            keys: keys,
            secondary_keys: secondaryKeys,
            content: content,
            comment: name,
            enabled: enabled,
            selective: selective,
            constant: constant,
            insertion_order: order,
            order: order,
            priority: priority,
            // Standard fields expected by SillyTavern
            id: idx,
            position: 'before_char',
            case_sensitive: false,
            use_regex: false,
            extensions: {}
        });
    });
    
    return entries;
}

/**
 * Build a character_book object from editor state
 * @returns {Object|null} The character_book object or null if no entries
 */
function getCharacterBookFromEditor() {
    const entries = getLorebookFromEditor();
    
    if (entries.length === 0) {
        return null;
    }
    
    return {
        name: '',
        description: '',
        scan_depth: 2,
        token_budget: 512,
        recursive_scanning: false,
        entries: entries
    };
}

// ==============================================
// Utility Functions
// ==============================================

/**
 * Get character name with fallbacks
 * @param {Object} char - Character object
 * @param {string} fallback - Default value if no name found
 * @returns {string} Character name
 */
function getCharacterName(char, fallback = 'Unknown') {
    if (!char) return fallback;
    return char.name || char.data?.name || char.definition?.name || fallback;
}

/**
 * Get character avatar URL
 * @param {string} avatar - Avatar filename
 * @returns {string} Full avatar URL path
 */
function getCharacterAvatarUrl(avatar) {
    if (!avatar) return '';
    return `/characters/${encodeURIComponent(avatar)}`;
}

/**
 * Render a lorebook entry as HTML
 * @param {Object} entry - Lorebook entry object
 * @param {number} index - Entry index
 * @returns {string} HTML string
 */
function renderLorebookEntryHtml(entry, index) {
    const keys = entry.keys || entry.key || [];
    const keyArr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
    const secondaryKeys = entry.secondary_keys || [];
    const secondaryKeyArr = Array.isArray(secondaryKeys) ? secondaryKeys : (secondaryKeys ? [secondaryKeys] : []);
    const content = entry.content || '';
    const name = entry.comment || entry.name || `Entry ${index + 1}`;
    const enabled = entry.enabled !== false;
    const selective = entry.selective || entry.selectiveLogic;
    const constant = entry.constant;
    
    // Build status indicators for expanded area (simple icon + text)
    let statusItems = [];
    if (selective) statusItems.push('<span class="lb-stat-sel" title="Selective: triggers only when both primary AND secondary keys match"><i class="fa-solid fa-filter"></i>Selective</span>');
    if (constant) statusItems.push('<span class="lb-stat-const" title="Constant: always injected into context"><i class="fa-solid fa-thumbtack"></i>Constant</span>');
    statusItems.push(`<span class="${enabled ? 'lb-stat-on' : 'lb-stat-off'}" title="${enabled ? 'Entry is active' : 'Entry is disabled'}"><i class="fa-solid fa-${enabled ? 'circle-check' : 'circle-xmark'}"></i>${enabled ? 'Active' : 'Off'}</span>`);
    const statusRow = statusItems.join('<span style="color:#444"> · </span>');
    
    // Build key chips
    const keyChips = keyArr.length 
        ? keyArr.map(k => `<span class="lb-key-chip">${escapeHtml(k.trim())}</span>`).join('')
        : '<span class="lb-empty-keys">no keys</span>';
    
    const secondaryChips = secondaryKeyArr.length
        ? secondaryKeyArr.map(k => `<span class="lb-key-chip lb-secondary">${escapeHtml(k.trim())}</span>`).join('')
        : '';
    
    return `<details class="lb-entry${enabled ? '' : ' lb-disabled'}"><summary><i class="fa-solid fa-caret-right lb-arrow"></i><i class="fa-solid fa-file-lines lb-icon"></i><span class="lb-name">${escapeHtml(name.trim())}</span></summary><div class="lb-entry-body"><div class="lb-status-row">${statusRow}</div><div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-key"></i> Keys</div><div class="lb-keys-list">${keyChips}</div></div>${secondaryChips ? `<div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-key"></i> Secondary Keys</div><div class="lb-keys-list">${secondaryChips}</div></div>` : ''}<div class="lb-section"><div class="lb-section-header"><i class="fa-solid fa-align-left"></i> Content</div><div class="lb-content-box">${escapeHtml(content.trim()) || '<em>No content</em>'}</div></div></div></details>`;
}

/**
 * Render lorebook entries for modal display
 * @param {Array} entries - Array of lorebook entries
 * @returns {string} HTML string
 */
function renderLorebookEntriesHtml(entries) {
    if (!entries || !entries.length) return '';
    return entries.map((entry, i) => renderLorebookEntryHtml(entry, i)).join('');
}

/**
 * Hide a modal by ID
 * @param {string} modalId - Modal element ID
 */
function hideModal(modalId) {
    document.getElementById(modalId)?.classList.add('hidden');
}

// Escape HTML characters
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Sanitize a character name to match SillyTavern's folder naming convention
 * SillyTavern removes characters that are illegal in Windows folder names
 * @param {string} name - Character name
 * @returns {string} Sanitized folder name
 */
function sanitizeFolderName(name) {
    if (!name) return '';
    // Remove characters illegal in Windows folder names: \ / : * ? " < > |
    return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

/**
 * Extract plain text from HTML/CSS content for tooltips
 * Strips all styling, tags, markdown, URLs and normalizes whitespace
 */
function extractPlainText(html, maxLength = 200) {
    if (!html) return '';
    
    let text = html
        // Remove style tags and their contents
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        // Remove script tags and their contents
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        // Remove CSS blocks (sometimes inline)
        .replace(/\{[^}]*\}/g, '')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, '')
        // Remove all HTML tags
        .replace(/<[^>]+>/g, ' ')
        // Remove markdown images: ![alt](url) or ![alt]
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/!\[[^\]]*\]/g, '')
        // Remove markdown links but keep text: [text](url) -> text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Remove standalone URLs (http/https)
        .replace(/https?:\/\/[^\s<>"')\]]+/gi, '')
        // Remove data URIs
        .replace(/data:[^\s<>"')\]]+/gi, '')
        // Decode common HTML entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&apos;/gi, "'")
        // Remove any remaining CSS-like content (selectors, properties)
        .replace(/[.#][\w-]+\s*\{/g, '')
        .replace(/[\w-]+\s*:\s*[^;]+;/g, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
    
    if (text.length > maxLength) {
        // Cut at word boundary if possible
        const truncated = text.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');
        text = (lastSpace > maxLength * 0.7 ? truncated.substring(0, lastSpace) : truncated) + '...';
    }
    
    return text;
}

// Format text with rich HTML rendering (for display, not editing)
function formatRichText(text, charName = '', preserveHtml = false) {
    if (!text) return "";
    
    let processedText = text.trim();
    
    // Normalize line endings (Windows \r\n and old Mac \r to Unix \n)
    processedText = processedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Normalize whitespace: collapse multiple blank lines into max 2, trim trailing spaces
    processedText = processedText
        .replace(/[ \t]+$/gm, '')           // Remove trailing spaces/tabs from each line
        .replace(/\n{4,}/g, '\n\n\n')       // Collapse 4+ newlines to 3 (double paragraph break)
        .replace(/[ \t]{2,}/g, ' ');        // Collapse multiple spaces/tabs to single space
    
    // If preserving HTML (for creator notes with custom styling), use hybrid approach
    if (preserveHtml) {
        // Detect content type for appropriate processing
        // Ultra CSS: <style> tag near the START of content (first 200 chars) = fully styled card
        const hasStyleTagAtStart = /^[\s\S]{0,200}<style[^>]*>[\s\S]{50,}<\/style>/i.test(processedText);
        // Style tag anywhere (for later exclusion from markdown processing)
        const hasStyleTag = /<style[^>]*>[\s\S]*?<\/style>/i.test(processedText);
        const hasSignificantHtml = /<(div|table|center|font)[^>]*>/i.test(processedText);
        const hasInlineStyles = /style\s*=\s*["'][^"']*(?:display|position|flex|grid)[^"']*["']/i.test(processedText);
        
        // Ultra CSS mode: <style> tag at START with substantial CSS - touch almost nothing
        if (hasStyleTagAtStart) {
            // Only convert markdown images (safe - won't be in CSS)
            processedText = processedText.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
                // Allow http/https URLs and local paths (starting with /)
                if (!src.match(/^(https?:\/\/|\/)/i)) return match;
                const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
                return `<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`;
            });
            
            // Replace {{user}} and {{char}} placeholders (safe)
            const personaName = getPersonaName();
            processedText = processedText.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
            processedText = processedText.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
            
            return processedText;
        }
        
        // For content with <style> at the end (footer banners), extract and protect it
        let styleBlocks = [];
        if (hasStyleTag) {
            processedText = processedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (match) => {
                const placeholder = `\x00STYLEBLOCK${styleBlocks.length}\x00`;
                styleBlocks.push(match);
                return placeholder;
            });
        }
        
        // Pure CSS mode: has inline styles with layout properties - skip text formatting
        const isPureCssMode = hasInlineStyles;
        // HTML mode: has HTML structure tags  
        const isHtmlMode = hasSignificantHtml;
        
        // Convert markdown images and links (safe for all modes):
        
        // Convert linked images: [![alt](img-url)](link-url)
        processedText = processedText.replace(/\[\!\[([^\]]*)\]\(([^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)\]\(([^)]+)\)/g, (match, alt, imgSrc, linkHref) => {
            // Allow http/https URLs and local paths (starting with /)
            if (!imgSrc.match(/^(https?:\/\/|\/)/i)) return match;
            const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
            const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
            return `<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`;
        });
        
        // Convert standalone markdown images: ![alt](url) or ![alt](url =WxH) or ![alt](url "title")
        processedText = processedText.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
            // Allow http/https URLs and local paths (starting with /)
            if (!src.match(/^(https?:\/\/|\/)/i)) return match;
            const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
            return `<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`;
        });
        
        // Convert markdown links: [text](url) - but not image links we just processed
        processedText = processedText.replace(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, href) => {
            return `<a href="${href}" target="_blank" rel="noopener" class="embedded-link">${text}</a>`;
        });
        
        // Apply markdown text formatting (but not in pure CSS mode)
        if (!isPureCssMode) {
            // Bold: **text** or __text__
            processedText = processedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            processedText = processedText.replace(/__(.+?)__/g, '<strong>$1</strong>');
            
            // Italic: *text* or _text_ (careful not to match inside URLs, paths, or HTML attributes)
            // Use negative lookbehind for word chars, underscores, slashes, quotes, equals to avoid matching in URLs/paths
            processedText = processedText.replace(/(?<![\w*/"=])\*([^*\n]+?)\*(?![\w*])/g, '<em>$1</em>');
            processedText = processedText.replace(/(?<![\w_\/."'=])\s_([^_\n]+?)_(?![\w_])/g, ' <em>$1</em>');
            
            // Strikethrough: ~~text~~
            processedText = processedText.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
        }
        
        // Replace {{user}} and {{char}} placeholders
        const personaName = getPersonaName();
        processedText = processedText.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
        processedText = processedText.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
        
        // Newline handling based on mode
        // Only skip newlines if it's heavily structured HTML (many divs/tables) or has layout CSS
        const divCount = (processedText.match(/<div/gi) || []).length;
        const isHeavyHtml = divCount > 5 || /<table[^>]*>/i.test(processedText);
        
        if (isPureCssMode || isHeavyHtml) {
            // Pure CSS or heavy HTML mode: Don't convert newlines - layout handles it
        } else {
            // Mixed/Light HTML / Markdown mode: Convert newlines
            // But be careful around HTML tags - don't add breaks inside tag sequences
            processedText = processedText.replace(/\n\n+/g, '<br><br>');
            processedText = processedText.replace(/([^>])\n([^<])/g, '$1<br>$2');
        }
        
        // Restore style blocks
        styleBlocks.forEach((block, i) => {
            processedText = processedText.replace(`\x00STYLEBLOCK${i}\x00`, block);
        });
        
        return processedText;
    }
    
    // Standard mode: escape HTML for safety
    const placeholders = [];
    
    // Helper to add placeholder
    const addPlaceholder = (html) => {
        const placeholder = `__PLACEHOLDER_${placeholders.length}__`;
        placeholders.push(html);
        return placeholder;
    };
    
    // 1. Preserve existing HTML img tags (allow http/https and local paths)
    processedText = processedText.replace(/<img\s+[^>]*src=["']((?:https?:\/\/|\/)[^"']+)["'][^>]*\/?>/gi, (match, src) => {
        return addPlaceholder(`<img src="${src}" class="embedded-image" loading="lazy">`);
    });
    
    // 1b. Preserve existing HTML audio tags
    processedText = processedText.replace(/<audio[^>]*>[\s\S]*?<\/audio>/gi, (match) => {
        // Ensure it has our styling class
        if (!match.includes('audio-player')) {
            match = match.replace(/<audio/, '<audio class="audio-player embedded-audio"');
        }
        return addPlaceholder(match);
    });
    
    // 1c. Convert audio source tags to full audio players
    processedText = processedText.replace(/<source\s+[^>]*src=["']((?:https?:\/\/|\/)[^"']+\.(?:mp3|wav|ogg|m4a|flac|aac))["'][^>]*\/?>/gi, (match, src) => {
        const ext = src.split('.').pop().toLowerCase();
        return addPlaceholder(`<audio controls class="audio-player embedded-audio" preload="metadata"><source src="${src}" type="audio/${ext}">Your browser does not support audio.</audio>`);
    });
    
    // 2. Convert linked images: [![alt](img-url)](link-url)
    processedText = processedText.replace(/\[\!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (match, alt, imgSrc, linkHref) => {
        // Allow http/https URLs and local paths (starting with /)
        if (!imgSrc.match(/^(https?:\/\/|\/)/i)) return match;
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
        return addPlaceholder(`<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`);
    });
    
    // 3. Convert standalone markdown images: ![alt](url) or ![alt](url "title")
    processedText = processedText.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
        // Allow http/https URLs and local paths (starting with /)
        if (!src.match(/^(https?:\/\/|\/)/i)) return match;
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        return addPlaceholder(`<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`);
    });
    
    // 3b. Convert markdown audio links: [any text](url.mp3) or [??](url.mp3)
    processedText = processedText.replace(/\[([^\]]*)\]\(((?:https?:\/\/|\/)[^)\s]+\.(?:mp3|wav|ogg|m4a|flac|aac))(?:\s+"[^"]*)?\)/gi, (match, text, src) => {
        const ext = src.split('.').pop().toLowerCase();
        return addPlaceholder(`<audio controls class="audio-player embedded-audio" preload="metadata" title="${escapeHtml(text || 'Audio')}"><source src="${src}" type="audio/${ext}">Your browser does not support audio.</audio>`);
    });
    
    // 4. Convert markdown links: [text](url)
    processedText = processedText.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, href) => {
        return addPlaceholder(`<a href="${href}" target="_blank" rel="noopener" class="embedded-link">${escapeHtml(text)}</a>`);
    });
    
    // 5. Preserve HTML heading tags
    processedText = processedText.replace(/<(h[1-6])>([^<]*)<\/\1>/gi, (match, tag, content) => {
        return addPlaceholder(`<${tag} class="embedded-heading">${escapeHtml(content)}</${tag}>`);
    });
    
    // Escape HTML to prevent XSS
    let formatted = escapeHtml(processedText);
    
    // Restore all placeholders
    placeholders.forEach((html, i) => {
        formatted = formatted.replace(`__PLACEHOLDER_${i}__`, html);
    });
    
    // Replace {{user}} and {{char}} placeholders
    const personaName = getPersonaName();
    formatted = formatted.replace(/\{\{user\}\}/gi, `<span class="placeholder-user">${personaName}</span>`);
    formatted = formatted.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
    
    // Convert markdown-style formatting
    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    // Italic: *text* or _text_ (but not inside words or URLs)
    // Skip if underscore is part of a URL path or filename pattern
    // Require whitespace before underscore to avoid matching in file paths like localized_media_123
    formatted = formatted.replace(/(?<![\w*])\*([^*]+?)\*(?![\w*])/g, '<em>$1</em>');
    formatted = formatted.replace(/(?:^|(?<=\s))_([^_]+?)_(?![\w_])/g, '<em>$1</em>');
    
    // Quoted text: "text"
    formatted = formatted.replace(/&quot;(.+?)&quot;/g, '<span class="quoted-text">"$1"</span>');
    
    // Convert line breaks - use paragraph breaks for double newlines, single <br> for single
    // Also handle literal \n (escaped backslash-n from JSON) as actual newlines
    formatted = formatted.replace(/\\n/g, '\n');         // Convert literal \n to actual newlines first
    formatted = formatted.replace(/\n\n+/g, '</p><p>');  // Double+ newlines become paragraph breaks
    formatted = formatted.replace(/\n/g, '<br>');        // Single newlines become line breaks
    formatted = '<p>' + formatted + '</p>';              // Wrap in paragraphs
    formatted = formatted.replace(/<p><\/p>/g, '');      // Remove empty paragraphs
    
    return formatted;
}

function sanitizeTaglineHtml(content, charName) {
    if (!content) return '';

    if (getSetting('allowRichTagline') !== true) {
        return escapeHtml(content);
    }

    const formatted = formatRichText(content, charName, true);
    if (typeof DOMPurify === 'undefined') {
        return formatted;
    }

    const sanitized = DOMPurify.sanitize(formatted, {
        ALLOWED_TAGS: [
            'p', 'br', 'hr', 'div', 'span',
            'strong', 'b', 'em', 'i', 'u', 's', 'del',
            'a', 'img', 'ul', 'ol', 'li', 'blockquote',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'center', 'font'
        ],
        ALLOWED_ATTR: [
            'href', 'src', 'alt', 'title', 'target', 'rel', 'class',
            'color', 'size', 'align', 'style'
        ],
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'style', 'link'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true
    });

    return sanitizeTaglineStyles(sanitized);
}

function sanitizeTaglineStyles(html) {
    if (!html) return '';

    const container = document.createElement('div');
    container.innerHTML = html;

    const allowedProps = new Set([
        'color', 'background-color', 'font-size', 'font-weight', 'font-style',
        'text-align', 'text-decoration', 'line-height',
        'border', 'border-color', 'border-width', 'border-style', 'border-radius',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
    ]);

    const hasUnsafeValue = (value) => {
        const lower = value.toLowerCase();
        return lower.includes('expression(') || lower.includes('javascript:') || lower.includes('url(');
    };

    container.querySelectorAll('[style]').forEach(node => {
        const style = node.getAttribute('style') || '';
        const safeParts = [];
        style.split(';').forEach(part => {
            const [rawProp, rawValue] = part.split(':');
            if (!rawProp || !rawValue) return;
            const prop = rawProp.trim().toLowerCase();
            const value = rawValue.trim();
            if (!allowedProps.has(prop)) return;
            if (!value || hasUnsafeValue(value)) return;
            safeParts.push(`${prop}: ${value}`);
        });

        if (safeParts.length > 0) {
            node.setAttribute('style', safeParts.join('; '));
        } else {
            node.removeAttribute('style');
        }
    });

    return container.innerHTML;
}

/* Upload Helpers */
const toBase64 = file => file.arrayBuffer().then(buf => arrayBufferToBase64(buf));

async function uploadImages(files) {
    if (!activeChar) {
        console.warn('[Gallery] No active character for image upload');
        showToast('No character selected', 'error');
        return;
    }
    
    let uploadedCount = 0;
    let errorCount = 0;
    
    // Get the folder name (unique or standard)
    const folderName = getGalleryFolderName(activeChar);
    
    for (let file of files) {
        if (!file.type.startsWith('image/')) {
            console.warn(`[Gallery] Skipping non-image file: ${file.name}`);
            continue;
        }
        
        try {
            const base64 = await toBase64(file);
            const nameOnly = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
            const ext = file.name.includes('.') ? file.name.split('.').pop() : 'png';
            
            const res = await apiRequest(ENDPOINTS.IMAGES_UPLOAD, 'POST', {
                image: base64,
                filename: nameOnly,
                format: ext,
                ch_name: folderName
            });
            
            if (res.ok) {
                uploadedCount++;
            } else {
                const errorText = await res.text();
                console.error(`[Gallery] Upload error for ${nameOnly}:`, res.status, errorText);
                errorCount++;
            }
            
        } catch (e) {
            console.error(`[Gallery] Upload failed for ${file.name}:`, e);
            errorCount++;
        }
    }
    
    if (uploadedCount > 0) {
        showToast(`Uploaded ${uploadedCount} image(s)`, 'success');
        // Refresh the gallery - pass character object for unique folder support
        fetchCharacterImages(activeChar);
    } else if (errorCount > 0) {
        showToast(`Upload failed for ${errorCount} image(s)`, 'error');
    }
}

// ==================== CHARACTER IMPORTER ====================

const importModal = document.getElementById('importModal');
const importBtn = document.getElementById('importBtn');
const closeImportModal = document.getElementById('closeImportModal');
const startImportBtn = document.getElementById('startImportBtn');
const importUrlsInput = document.getElementById('importUrlsInput');
const importProgress = document.getElementById('importProgress');
const importProgressCount = document.getElementById('importProgressCount');
const importProgressFill = document.getElementById('importProgressFill');
const importLog = document.getElementById('importLog');
const importAutoDownloadGallery = document.getElementById('importAutoDownloadGallery');
const importAutoDownloadMedia = document.getElementById('importAutoDownloadMedia');

let isImporting = false;

// Open/close import modal
importBtn?.addEventListener('click', () => {
    importModal.classList.remove('hidden');
    importUrlsInput.value = '';
    importProgress.classList.add('hidden');
    importLog.innerHTML = '';
    startImportBtn.disabled = false;
    startImportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    startImportBtn.classList.remove('success');
    syncImportAutoDownloadGallery();
    syncImportAutoDownloadMedia();
    // Hide stats when opening fresh
    const importStats = document.getElementById('importStats');
    if (importStats) importStats.classList.add('hidden');
});

function syncImportAutoDownloadGallery() {
    if (!importAutoDownloadGallery) return;
    const includeChubGallery = getSetting('includeChubGallery');
    importAutoDownloadGallery.checked = includeChubGallery !== false;
}

function syncImportAutoDownloadMedia() {
    if (!importAutoDownloadMedia) return;
    const mediaLocalizationEnabled = getSetting('mediaLocalizationEnabled');
    importAutoDownloadMedia.checked = mediaLocalizationEnabled !== false;
}

closeImportModal?.addEventListener('click', () => {
    if (!isImporting) {
        importModal.classList.add('hidden');
    }
});

importModal?.addEventListener('click', (e) => {
    if (e.target === importModal && !isImporting) {
        importModal.classList.add('hidden');
    }
});

// Parse Chub AI URL to get fullPath
function parseChubUrl(url) {
    try {
        const urlObj = new URL(url.trim());
        // Support both chub.ai and characterhub.org
        if (!urlObj.hostname.includes('chub.ai') && !urlObj.hostname.includes('characterhub.org')) {
            return null;
        }
        // Extract the path after /characters/
        const match = urlObj.pathname.match(/\/characters\/([^\/]+\/[^\/]+)/);
        if (match) {
            return match[1]; // e.g., "author/character-name"
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Search for a character on Chub by name and creator
 * Strategy: First get author's characters, then find matching name
 * @param {string} charName - The character's name
 * @param {string} creatorName - The creator's name
 * @returns {Promise<{id: number, fullPath: string, hasGallery: boolean}|null>}
 */
async function searchChubForCharacter(charName, creatorName, localChar = null) {
    if (!charName) return null;
    
    try {
        debugLog('[ChubSearch] Searching for character:', charName, 'by', creatorName);
        
        // Strategy 1: If we have a creator, search their characters first
        if (creatorName) {
            const authorResult = await searchChubByAuthor(charName, creatorName, localChar);
            if (authorResult) return authorResult;
        }
        
        // Strategy 2: Fall back to general search with character name
        const generalResult = await searchChubGeneral(charName, creatorName, localChar);
        if (generalResult) return generalResult;
        
        debugLog('[ChubSearch] No results found');
        return null;
    } catch (error) {
        console.error('[ChubSearch] Error:', error);
        return null;
    }
}

/**
 * Search Chub by author's characters and find matching name
 */
async function searchChubByAuthor(charName, creatorName, localChar = null) {
    try {
        // Search for author's characters (no search term, just username filter)
        const params = new URLSearchParams({
            first: '100',  // Get more results to find the character
            sort: 'download_count',
            venus: 'true',
            chub: 'true',
            username: creatorName.toLowerCase()
        });
        
        debugLog('[ChubSearch] Fetching characters by author:', creatorName);
        
        const searchUrl = `${CHUB_API_BASE}/search?${params.toString()}`;
        let response;
        try {
            // Try direct fetch first
            response = await fetch(searchUrl, {
                method: 'GET',
                headers: getChubHeaders(true)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            debugLog('[ChubSearch] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${encodeURIComponent(searchUrl)}`;
            response = await fetch(proxyUrl, {
                method: 'GET',
                headers: getChubHeaders(true)
            });
            
            if (!response.ok) {
                debugLog('[ChubSearch] Author search failed:', response.status);
                return null;
            }
        }
        
        const data = await response.json();
        const nodes = extractNodes(data);
        
        if (nodes.length === 0) {
            debugLog('[ChubSearch] No characters found for author:', creatorName);
            return null;
        }
        
        debugLog(`[ChubSearch] Found ${nodes.length} characters by ${creatorName}`);
        
        // Find matching character name
        const normalizedSearchName = charName.toLowerCase().trim();
        
        // Pass 1: Exact or partial name match
        for (const node of nodes) {
            const nodeName = (node.name || '').toLowerCase().trim();
            
            // Check for exact or partial name match
            if (nodeName === normalizedSearchName || 
                nodeName.includes(normalizedSearchName) ||
                normalizedSearchName.includes(nodeName)) {
                debugLog('[ChubSearch] Found match:', node.fullPath, '(name:', node.name, ')');
                return {
                    id: node.id,
                    fullPath: node.fullPath,
                    hasGallery: node.hasGallery || false
                };
            }
        }
        
        // Pass 2: Try matching by slug in fullPath (e.g., "author/naomi" matches "Naomi")
        const normalizedSlug = charName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        for (const node of nodes) {
            const nodeSlug = (node.fullPath || '').split('/')[1]?.toLowerCase() || '';
            if (nodeSlug === normalizedSlug || nodeSlug.includes(normalizedSlug) || normalizedSlug.includes(nodeSlug)) {
                debugLog('[ChubSearch] Found match by slug:', node.fullPath);
                return {
                    id: node.id,
                    fullPath: node.fullPath,
                    hasGallery: node.hasGallery || false
                };
            }
        }
        
        // Pass 3: Content comparison if we have localChar (for tagline-as-name cases)
        if (localChar && nodes.length <= 50) {
            const localDesc = getCharField(localChar, 'description') || '';
            const localNotes = getCharField(localChar, 'creator_notes') || '';
            
            if (localDesc.length > 100 || localNotes.length > 100) {
                debugLog('[ChubSearch] Trying content comparison for', nodes.length, 'candidates');
                
                let bestMatch = null;
                let bestScore = 0;
                
                for (const node of nodes) {
                    // Fetch the character details to compare content
                    try {
                        const metadata = await fetchChubMetadata(node.fullPath);
                        if (!metadata?.definition) continue;
                        
                        const chubDesc = metadata.definition.description || '';
                        const chubNotes = metadata.definition.creator_notes || '';
                        
                        let score = 0;
                        
                        // Compare descriptions
                        if (localDesc.length > 100 && chubDesc.length > 100) {
                            const descSim = contentSimilarity(localDesc, chubDesc);
                            if (descSim >= 0.5) score += descSim * 50;
                        }
                        
                        // Compare creator notes
                        if (localNotes.length > 100 && chubNotes.length > 100) {
                            const notesSim = contentSimilarity(localNotes, chubNotes);
                            if (notesSim >= 0.5) score += notesSim * 50;
                        }
                        
                        if (score > bestScore && score >= 40) {
                            bestScore = score;
                            bestMatch = node;
                            debugLog('[ChubSearch] Content match candidate:', node.fullPath, 'score:', score);
                        }
                    } catch (e) {
                        // Skip on error
                    }
                }
                
                if (bestMatch) {
                    debugLog('[ChubSearch] Found match by content:', bestMatch.fullPath, 'score:', bestScore);
                    return {
                        id: bestMatch.id,
                        fullPath: bestMatch.fullPath,
                        hasGallery: bestMatch.hasGallery || false
                    };
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('[ChubSearch] Author search error:', error);
        return null;
    }
}

/**
 * General search on Chub with character name
 */
async function searchChubGeneral(charName, creatorName, localChar = null) {
    try {
        const params = new URLSearchParams({
            search: charName,
            first: '24',
            sort: 'download_count',
            venus: 'true',
            chub: 'true'
        });
        
        debugLog('[ChubSearch] General search for:', charName);
        
        const searchUrl = `${CHUB_API_BASE}/search?${params.toString()}`;
        let response;
        try {
            // Try direct fetch first
            response = await fetch(searchUrl, {
                method: 'GET',
                headers: getChubHeaders(true)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            debugLog('[ChubSearch] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${encodeURIComponent(searchUrl)}`;
            response = await fetch(proxyUrl, {
                method: 'GET',
                headers: getChubHeaders(true)
            });
            
            if (!response.ok) return null;
        }
        
        const data = await response.json();
        const nodes = extractNodes(data);
        
        if (nodes.length === 0) return null;
        
        const normalizedSearchName = charName.toLowerCase().trim();
        const normalizedCreator = creatorName?.toLowerCase().trim() || '';
        
        for (const node of nodes) {
            const nodeName = (node.name || '').toLowerCase().trim();
            const nodeCreator = (node.fullPath || '').split('/')[0]?.toLowerCase() || '';
            
            const nameMatch = nodeName === normalizedSearchName || 
                              nodeName.includes(normalizedSearchName) ||
                              normalizedSearchName.includes(nodeName);
            
            // If we have creator info, require both to match
            if (normalizedCreator) {
                const creatorMatch = nodeCreator === normalizedCreator ||
                                     nodeCreator.includes(normalizedCreator) ||
                                     normalizedCreator.includes(nodeCreator);
                if (nameMatch && creatorMatch) {
                    debugLog('[ChubSearch] Found match:', node.fullPath);
                    return {
                        id: node.id,
                        fullPath: node.fullPath,
                        hasGallery: node.hasGallery || false
                    };
                }
            } else if (nameMatch) {
                debugLog('[ChubSearch] Found match (name only):', node.fullPath);
                return {
                    id: node.id,
                    fullPath: node.fullPath,
                    hasGallery: node.hasGallery || false
                };
            }
        }
        
        // Content comparison fallback if localChar provided
        if (localChar && nodes.length > 0) {
            const localDesc = getCharField(localChar, 'description') || '';
            const localNotes = getCharField(localChar, 'creator_notes') || '';
            
            if (localDesc.length > 100 || localNotes.length > 100) {
                debugLog('[ChubSearch] Trying content comparison for', nodes.length, 'general search results');
                
                let bestMatch = null;
                let bestScore = 0;
                
                for (const node of nodes) {
                    try {
                        const metadata = await fetchChubMetadata(node.fullPath);
                        if (!metadata?.definition) continue;
                        
                        const chubDesc = metadata.definition.description || '';
                        const chubNotes = metadata.definition.creator_notes || '';
                        
                        let score = 0;
                        
                        if (localDesc.length > 100 && chubDesc.length > 100) {
                            const descSim = contentSimilarity(localDesc, chubDesc);
                            if (descSim >= 0.5) score += descSim * 50;
                        }
                        
                        if (localNotes.length > 100 && chubNotes.length > 100) {
                            const notesSim = contentSimilarity(localNotes, chubNotes);
                            if (notesSim >= 0.5) score += notesSim * 50;
                        }
                        
                        if (score > bestScore && score >= 40) {
                            bestScore = score;
                            bestMatch = node;
                        }
                    } catch (e) {
                        // Skip on error
                    }
                }
                
                if (bestMatch) {
                    debugLog('[ChubSearch] Found match by content:', bestMatch.fullPath, 'score:', bestScore);
                    return {
                        id: bestMatch.id,
                        fullPath: bestMatch.fullPath,
                        hasGallery: bestMatch.hasGallery || false
                    };
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('[ChubSearch] General search error:', error);
        return null;
    }
}

/**
 * Extract nodes from various Chub API response formats
 */
function extractNodes(data) {
    if (data.nodes) return data.nodes;
    if (data.data?.nodes) return data.data.nodes;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
}

// Cache for ChubAI metadata (longer TTL since it rarely changes)
const chubMetadataCache = new Map();
const CHUB_METADATA_CACHE_MAX = 3; // Keep small — full API nodes are large
const CHUB_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Fetch character metadata from Chub API (with caching)
async function fetchChubMetadata(fullPath) {
    // Check cache first
    const cached = chubMetadataCache.get(fullPath);
    if (cached && Date.now() - cached.time < CHUB_CACHE_TTL) {
        debugLog('[Chub] Using cached metadata for:', fullPath);
        return cached.value;
    }
    
    try {
        const url = `https://api.chub.ai/api/characters/${fullPath}?full=true`;
        debugLog('[Chub] Fetching metadata from:', url);
        
        let response;
        try {
            // Try direct fetch first
            response = await fetch(url, {
                headers: getChubHeaders(true)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            debugLog('[Chub] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
            response = await fetch(proxyUrl, {
                headers: getChubHeaders(true)
            });
            
            if (!response.ok) {
                if (response.status === 404) {
                    const text = await response.text();
                    if (text.includes('CORS proxy is disabled')) {
                        console.error('[Chub] CORS blocked and proxy is disabled');
                        return null;
                    }
                }
                return null;
            }
        }
        
        const data = await response.json();
        const result = data.node || null;
        
        // Cache the result (stripped to reduce memory — only fields used by buildCharacterCardFromChub + download)
        if (result) {
            const def = result.definition || {};
            const strippedResult = {
                id: result.id,
                name: result.name,
                fullPath: result.fullPath,
                topics: result.topics,
                tagline: result.tagline,
                avatar_url: result.avatar_url,
                max_res_url: result.max_res_url,
                hasGallery: result.hasGallery,
                creator: result.creator,
                definition: {
                    name: def.name,
                    personality: def.personality,
                    tavern_personality: def.tavern_personality,
                    first_message: def.first_message,
                    example_dialogs: def.example_dialogs,
                    description: def.description,
                    scenario: def.scenario,
                    system_prompt: def.system_prompt,
                    post_history_instructions: def.post_history_instructions,
                    alternate_greetings: def.alternate_greetings,
                    extensions: def.extensions,
                    character_version: def.character_version,
                    tagline: def.tagline,
                    // embedded_lorebook kept — needed for character_book in card
                    embedded_lorebook: def.embedded_lorebook,
                },
            };
            // Enforce LRU cap
            while (chubMetadataCache.size >= CHUB_METADATA_CACHE_MAX) {
                const firstKey = chubMetadataCache.keys().next().value;
                chubMetadataCache.delete(firstKey);
            }
            chubMetadataCache.set(fullPath, { value: strippedResult, time: Date.now() });
            return strippedResult;
        }
        
        return result;
    } catch (error) {
        return null;
    }
}

/**
 * Fetch Chub gallery images for a character
 * @param {number|string} characterId - The numeric character ID from Chub API (node.id)
 * @returns {Promise<Array<{uuid: string, imageUrl: string, nsfw: boolean}>>}
 */
async function fetchChubGalleryImages(characterId) {
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/gallery/project/${characterId}?limit=100&count=false`;
        debugLog('[ChubGallery] Fetching gallery from:', url);
        
        let response;
        try {
            // Try direct fetch first
            response = await fetch(url, {
                headers: getChubHeaders(true)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            debugLog('[ChubGallery] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
            response = await fetch(proxyUrl, {
                headers: getChubHeaders(true)
            });
            
            if (!response.ok) {
                debugLog('[ChubGallery] Gallery fetch failed:', response.status);
                return [];
            }
        }
        
        const data = await response.json();
        
        if (!data.nodes || !Array.isArray(data.nodes)) {
            debugLog('[ChubGallery] No nodes in response');
            return [];
        }
        
        // Map the gallery nodes to our format
        return data.nodes.map(node => ({
            uuid: node.uuid,
            imageUrl: node.primary_image_path,
            nsfw: node.nsfw_image || false
        }));
    } catch (error) {
        console.error('[ChubGallery] Error fetching gallery:', error);
        return [];
    }
}

/**
 * Download Chub gallery images for a character
 * @param {string} folderName - The gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {number|string} characterId - The numeric character ID from Chub API
 * @param {Object} options - Optional callbacks for progress/logging
 * @returns {Promise<{success: number, skipped: number, errors: number}>}
 */
async function downloadChubGalleryForCharacter(folderName, characterId, options = {}) {
    const { onProgress, onLog, onLogUpdate, shouldAbort, abortSignal } = options;
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    // Fetch gallery images first
    const logEntry = onLog ? onLog('Fetching Chub gallery list...', 'pending') : null;
    const galleryImages = await fetchChubGalleryImages(characterId);
    
    if (galleryImages.length === 0) {
        if (onLogUpdate && logEntry) onLogUpdate(logEntry, 'No gallery images found', 'success');
        return { success: 0, skipped: 0, errors: 0, aborted: false };
    }
    
    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Found ${galleryImages.length} gallery image(s)`, 'success');
    
    // Get existing files and their hashes to check for duplicates
    const existingHashMap = await getExistingFileHashes(folderName);
    debugLog(`[ChubGallery] Found ${existingHashMap.size} existing file hashes for ${folderName}`);
    
    for (let i = 0; i < galleryImages.length; i++) {
        // Check for abort signal
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            return { success: successCount, skipped: skippedCount, errors: errorCount, aborted: true };
        }
        
        const image = galleryImages[i];
        const displayUrl = image.imageUrl.length > 60 ? image.imageUrl.substring(0, 60) + '...' : image.imageUrl;
        const imgLogEntry = onLog ? onLog(`Checking ${displayUrl}`, 'pending') : null;
        
        // Download to memory first to check hash
        let downloadResult = await downloadMediaToMemory(image.imageUrl, 30000, abortSignal);
        
        if (!downloadResult.success) {
            errorCount++;
            if (onLogUpdate && imgLogEntry) onLogUpdate(imgLogEntry, `Failed: ${displayUrl} - ${downloadResult.error}`, 'error');
            downloadResult = null;
            if (onProgress) onProgress(i + 1, galleryImages.length);
            continue;
        }
        
        // Calculate hash of downloaded content
        const contentHash = await calculateHash(downloadResult.arrayBuffer);
        
        // Check if this file already exists
        const existingFile = existingHashMap.get(contentHash);
        if (existingFile) {
            skippedCount++;
            downloadResult = null; // Release downloaded data — it's a duplicate
            if (onLogUpdate && imgLogEntry) onLogUpdate(imgLogEntry, `Skipped (duplicate): ${displayUrl}`, 'success');
            debugLog(`[ChubGallery] Duplicate found: ${image.imageUrl} -> ${existingFile.fileName}`);
            if (onProgress) onProgress(i + 1, galleryImages.length);
            continue;
        }
        
        // Not a duplicate, save the file with chubgallery naming convention
        if (onLogUpdate && imgLogEntry) onLogUpdate(imgLogEntry, `Saving ${displayUrl}...`, 'pending');
        const result = await saveChubGalleryImage(downloadResult, image, folderName, contentHash);
        downloadResult = null; // Release after save
        
        if (result.success) {
            successCount++;
            // Add to hash map to avoid downloading same file twice in this session
            existingHashMap.set(contentHash, { fileName: result.filename, localPath: result.localPath });
            if (onLogUpdate && imgLogEntry) onLogUpdate(imgLogEntry, `Saved: ${result.filename}`, 'success');
        } else {
            errorCount++;
            if (onLogUpdate && imgLogEntry) onLogUpdate(imgLogEntry, `Failed: ${displayUrl} - ${result.error}`, 'error');
        }
        
        if (onProgress) onProgress(i + 1, galleryImages.length);
        
        // Yield to browser for GC between media uploads (critical for mobile)
        // Each upload peaks at ~12MB; yielding lets the engine collect before the next one
        await new Promise(r => setTimeout(r, 50));
    }
    
    return { success: successCount, skipped: skippedCount, errors: errorCount, aborted: false };
}

/**
 * Save a Chub gallery image with the proper naming convention
 * Naming: chubgallery_{hash}_{originalFilename}.{ext}
 * @param {Object} downloadResult - Result from downloadMediaToMemory
 * @param {Object} imageInfo - Image info from Chub gallery
 * @param {string} folderName - Gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {string} contentHash - Hash of the file content
 */
async function saveChubGalleryImage(downloadResult, imageInfo, folderName, contentHash) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        
        // Determine file extension from content type
        let extension = 'webp'; // Default for Chub gallery
        if (contentType) {
            const mimeToExt = {
                // Images
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'image/bmp': 'bmp',
                'image/svg+xml': 'svg',
                // Audio (in case Chub ever serves audio files)
                'audio/mpeg': 'mp3',
                'audio/mp3': 'mp3',
                'audio/wav': 'wav',
                'audio/ogg': 'ogg',
                'audio/flac': 'flac'
            };
            
            // Try exact match first
            if (mimeToExt[contentType]) {
                extension = mimeToExt[contentType];
            } else if (contentType.startsWith('audio/')) {
                // Unknown audio type - extract subtype, don't default to image extension!
                const subtype = contentType.split('/')[1].split(';')[0];
                extension = subtype.replace('x-', '') || 'audio';
            }
            // For unknown image types, 'webp' default is acceptable for Chub
        } else {
            const urlMatch = imageInfo.imageUrl.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) {
                extension = urlMatch[1].toLowerCase();
            }
        }
        
        // Extract original filename from URL
        const urlObj = new URL(imageInfo.imageUrl);
        const pathParts = urlObj.pathname.split('/');
        const originalFilename = pathParts[pathParts.length - 1] || 'gallery_image';
        const originalNameWithoutExt = originalFilename.includes('.') 
            ? originalFilename.substring(0, originalFilename.lastIndexOf('.'))
            : originalFilename;
        
        // Sanitize filename parts
        const sanitizedName = originalNameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
        const shortHash = (contentHash && contentHash.length >= 8) ? contentHash.substring(0, 8) : 'nohash00'; // First 8 chars of hash
        
        // Generate local filename: chubgallery_{hash}_{originalFilename}
        const filenameBase = `chubgallery_${shortHash}_${sanitizedName}`;
        
        // Convert arrayBuffer to base64 then release the buffer immediately.
        // This prevents holding both the raw buffer (5MB) and the base64 string (6.7MB)
        // simultaneously during the upload await — critical for mobile memory.
        let base64Data = arrayBufferToBase64(arrayBuffer);
        // Break the reference so the ArrayBuffer can be GC'd during upload
        downloadResult.arrayBuffer = null;
        
        // Build JSON body, then release the base64 string — the JSON body contains it.
        const bodyStr = JSON.stringify({
            image: base64Data,
            filename: filenameBase,
            format: extension,
            ch_name: folderName
        });
        base64Data = null; // Release — serialized into bodyStr
        
        // Use fetch directly (instead of apiRequest) so we control the body lifecycle
        const csrfToken = getCSRFToken();
        const saveResponse = await fetch(`${API_BASE}${ENDPOINTS.IMAGES_UPLOAD}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: bodyStr
        });
        // bodyStr released after fetch consumes it (engine can GC the string)
        
        if (!saveResponse.ok) {
            const errorText = await saveResponse.text();
            throw new Error(`Upload failed: ${errorText}`);
        }
        
        const saveResult = await saveResponse.json();
        
        if (!saveResult || !saveResult.path) {
            throw new Error('No path returned from upload');
        }
        
        return {
            success: true,
            localPath: saveResult.path,
            filename: `${filenameBase}.${extension}`
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error)
        };
    }
}

// Calculate CRC32 for PNG chunks
function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

// Pre-computed CRC32 table
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
}

/**
 * Convert any image (WebP, JPEG, etc.) to PNG using canvas
 * @param {ArrayBuffer} imageBuffer - The source image data
 * @returns {Promise<ArrayBuffer>} PNG image data
 */
async function convertImageToPng(imageBuffer) {
    return new Promise((resolve, reject) => {
        let blob = new Blob([imageBuffer]);
        const url = URL.createObjectURL(blob);
        const img = new Image();
        
        img.onload = () => {
            URL.revokeObjectURL(url);
            blob = null; // Release source blob — image is decoded, blob no longer needed
            
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            
            // Release decoded image bitmap
            img.src = '';
            
            canvas.toBlob((pngBlob) => {
                // Release canvas backing store (can be 10-20MB for high-res images)
                canvas.width = 0;
                canvas.height = 0;
                
                if (pngBlob) {
                    pngBlob.arrayBuffer().then(resolve).catch(reject);
                } else {
                    reject(new Error('Failed to convert image to PNG'));
                }
            }, 'image/png');
        };
        
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image for conversion'));
        };
        
        img.src = url;
    });
}

// Create a tEXt chunk for PNG
function createTextChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);
    const dataLength = keywordBytes.length + 1 + textBytes.length; // +1 for null separator
    
    // Chunk: length (4) + type (4) + data + crc (4)
    const chunk = new Uint8Array(12 + dataLength);
    const view = new DataView(chunk.buffer);
    
    // Length (big-endian)
    view.setUint32(0, dataLength, false);
    
    // Type: 'tEXt'
    chunk[4] = 0x74; // t
    chunk[5] = 0x45; // E
    chunk[6] = 0x58; // X
    chunk[7] = 0x74; // t
    
    // Keyword
    chunk.set(keywordBytes, 8);
    
    // Null separator
    chunk[8 + keywordBytes.length] = 0;
    
    // Text
    chunk.set(textBytes, 9 + keywordBytes.length);
    
    // CRC (type + data)
    const crcData = chunk.slice(4, 8 + dataLength);
    const crcValue = crc32(crcData);
    view.setUint32(8 + dataLength, crcValue, false);
    
    return chunk;
}

/**
 * Extract character card data from a PNG file
 * Reads the 'chara' tEXt/iTXt chunk and decodes the base64 JSON
 * @param {ArrayBuffer} pngBuffer - The PNG file data
 * @returns {Object|null} The parsed character card object, or null if not found/invalid
 */
function extractCharacterDataFromPng(pngBuffer) {
    try {
        const bytes = new Uint8Array(pngBuffer);
        
        // Verify PNG signature
        const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== pngSignature[i]) {
                debugLog('[PNG Extract] Invalid PNG signature');
                return null;
            }
        }
        
        // Parse chunks looking for tEXt/iTXt with 'chara' keyword
        let pos = 8;
        
        while (pos < bytes.length) {
            const view = new DataView(bytes.buffer, pos);
            const length = view.getUint32(0, false);
            const typeBytes = bytes.slice(pos + 4, pos + 8);
            const type = String.fromCharCode(...typeBytes);
            const chunkEnd = pos + 12 + length;
            
            if (type === 'tEXt' || type === 'iTXt') {
                // Check keyword (null-terminated string at start of data)
                const dataStart = pos + 8;
                let keyword = '';
                let keywordEnd = dataStart;
                
                for (let i = dataStart; i < dataStart + Math.min(20, length); i++) {
                    if (bytes[i] === 0) {
                        keywordEnd = i;
                        break;
                    }
                    keyword += String.fromCharCode(bytes[i]);
                }
                
                if (keyword === 'chara') {
                    debugLog('[PNG Extract] Found chara chunk, type:', type);
                    
                    // Extract the base64 data after the null terminator
                    let textStart = keywordEnd + 1;
                    
                    // For iTXt, skip compression flag, compression method, language tag, and translated keyword
                    if (type === 'iTXt') {
                        // Skip compression flag (1 byte) and compression method (1 byte)
                        textStart += 2;
                        // Skip language tag (null-terminated)
                        while (textStart < dataStart + length && bytes[textStart] !== 0) textStart++;
                        textStart++; // Skip the null
                        // Skip translated keyword (null-terminated)
                        while (textStart < dataStart + length && bytes[textStart] !== 0) textStart++;
                        textStart++; // Skip the null
                    }
                    
                    const textEnd = dataStart + length;
                    // Build base64 string in chunks (avoid spread operator stack overflow on large data)
                    let base64Data = '';
                    const slice = bytes.subarray(textStart, textEnd);
                    const chunkSz = 32768;
                    for (let ci = 0; ci < slice.length; ci += chunkSz) {
                        base64Data += String.fromCharCode.apply(null, slice.subarray(ci, Math.min(ci + chunkSz, slice.length)));
                    }
                    
                    try {
                        // Decode base64 to JSON
                        const jsonString = decodeURIComponent(escape(atob(base64Data)));
                        const cardData = JSON.parse(jsonString);
                        debugLog('[PNG Extract] Successfully extracted card data:', {
                            spec: cardData.spec,
                            spec_version: cardData.spec_version,
                            name: cardData.data?.name
                        });
                        return cardData;
                    } catch (decodeError) {
                        debugLog('[PNG Extract] Failed to decode chara data:', decodeError.message);
                        return null;
                    }
                }
            }
            
            pos = chunkEnd;
        }
        
        debugLog('[PNG Extract] No chara chunk found in PNG');
        return null;
        
    } catch (error) {
        debugLog('[PNG Extract] Error extracting character data:', error.message);
        return null;
    }
}

// Embed character data into PNG (removes existing chara chunk first)
function embedCharacterDataInPng(pngBuffer, characterJson) {
    const bytes = new Uint8Array(pngBuffer);
    
    // Verify PNG signature
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== pngSignature[i]) {
            throw new Error('Invalid PNG file');
        }
    }
    
    // First pass: find chunk boundaries and identify which to keep/skip.
    // Uses subarray views (zero-copy) instead of slice copies.
    const chunkRanges = []; // [{start, end, type, skip}]
    let pos = 8;
    
    while (pos < bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
        const length = view.getUint32(0, false);
        const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
        const chunkEnd = pos + 12 + length;
        
        // Check if this is a tEXt chunk with 'chara' keyword - skip it
        let skipChunk = false;
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
            const dataStart = pos + 8;
            let keyword = '';
            for (let j = dataStart; j < dataStart + Math.min(20, length); j++) {
                if (bytes[j] === 0) break;
                keyword += String.fromCharCode(bytes[j]);
            }
            if (keyword === 'chara') {
                debugLog(`[PNG] Removing existing '${type}' chunk with 'chara' keyword`);
                skipChunk = true;
            }
        }
        
        chunkRanges.push({ start: pos, end: chunkEnd, type, skip: skipChunk });
        pos = chunkEnd;
    }
    
    // Find IEND chunk index
    const iendIndex = chunkRanges.findIndex(c => c.type === 'IEND');
    if (iendIndex === -1) {
        throw new Error('Invalid PNG: IEND chunk not found');
    }
    
    // Create the tEXt chunk with base64-encoded character data
    const jsonString = JSON.stringify(characterJson);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
    const textChunk = createTextChunk('chara', base64Data);
    
    debugLog(`[PNG] Adding new chara chunk: JSON=${jsonString.length} chars, base64=${base64Data.length} chars`);
    
    // Calculate total size (no intermediate copies)
    let totalSize = 8 + textChunk.length; // PNG signature + new chara chunk
    for (const range of chunkRanges) {
        if (!range.skip) totalSize += (range.end - range.start);
    }
    
    // Build the new PNG — write directly from source using subarray views
    const result = new Uint8Array(totalSize);
    result.set(bytes.subarray(0, 8), 0); // PNG signature (view, no copy until set)
    
    let offset = 8;
    for (let i = 0; i < chunkRanges.length; i++) {
        if (i === iendIndex) {
            result.set(textChunk, offset);
            offset += textChunk.length;
        }
        const range = chunkRanges[i];
        if (!range.skip) {
            result.set(bytes.subarray(range.start, range.end), offset);
            offset += (range.end - range.start);
        }
    }
    
    return result;
}

// Build character card V2 spec from Chub API data
// IMPORTANT: The Chub API uses its OWN field names that differ from the V2 spec.
// This mapping matches EXACTLY what SillyTavern's own downloadChubCharacter() does
// in src/endpoints/content-manager.js.
function buildCharacterCardFromChub(apiData) {
    const def = apiData.definition || {};
    
    // Chub API field → V2 spec field mapping (from ST source):
    //   definition.personality      → data.description
    //   definition.tavern_personality → data.personality
    //   definition.first_message    → data.first_mes
    //   definition.example_dialogs  → data.mes_example
    //   definition.description      → data.creator_notes
    //   definition.scenario         → data.scenario (same name)
    //   definition.system_prompt    → data.system_prompt (same name)
    //   definition.post_history_instructions → data.post_history_instructions (same name)
    //   definition.alternate_greetings → data.alternate_greetings (same name)
    //   definition.extensions       → data.extensions (same name)
    //   definition.embedded_lorebook → data.character_book
    //   metadata.topics             → data.tags (NOT definition.tags)
    //   creatorName (from path)     → data.creator
    const characterCard = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || apiData.name || 'Unknown',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            creator_notes: def.description || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            alternate_greetings: def.alternate_greetings || [],
            tags: apiData.topics || [],
            creator: apiData.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            extensions: def.extensions || {},
            character_book: def.embedded_lorebook || undefined,
        }
    };
    
    return characterCard;
}

// Import a single character from Chub
// Mirrors SillyTavern's own downloadChubCharacter() approach:
// 1. Fetch character definition from API (always latest version)
// 2. Download avatar IMAGE separately (just the picture, not the card PNG)
// 3. Build V2 card from API metadata with correct field mapping
// 4. Embed card data into avatar PNG
// 5. Send to ST's import endpoint
async function importChubCharacter(fullPath) {
    try {
        // Fetch complete character data from the API (always returns latest version)
        let metadata = await fetchChubMetadata(fullPath);
        
        if (!metadata || !metadata.definition) {
            throw new Error('Could not fetch character data from API');
        }
        
        const hasGallery = metadata.hasGallery || false;
        const characterName = metadata.definition?.name || metadata.name || fullPath.split('/').pop();
        
        // Build the character card from API metadata (uses ST's exact field mapping)
        const characterCard = buildCharacterCardFromChub(metadata);
        // Capture fields we need, then release the full metadata object
        const metadataId = metadata.id || null;
        const metadataTagline = metadata.tagline || metadata.definition?.tagline || '';
        const metadataMaxResUrl = metadata.max_res_url || null;
        const metadataAvatarUrl = metadata.avatar_url || null;
        metadata = null;
        
        // Ensure extensions object exists
        if (!characterCard.data.extensions) {
            characterCard.data.extensions = {};
        }
        
        // Add ChubAI link metadata
        const existingChub = characterCard.data.extensions.chub || {};
        characterCard.data.extensions.chub = {
            ...existingChub,
            id: metadataId || existingChub.id || null,
            full_path: fullPath,
            tagline: metadataTagline || existingChub.tagline || '',
            linkedAt: new Date().toISOString()
        };
        
        // Add unique gallery_id if enabled
        if (getSetting('uniqueGalleryFolders') && !characterCard.data.extensions.gallery_id) {
            characterCard.data.extensions.gallery_id = generateGalleryId();
            debugLog('[Chub Import] Assigned gallery_id:', characterCard.data.extensions.gallery_id);
        }
        
        // Download avatar IMAGE (not the card PNG — that may have stale data)
        // Priority: max_res_url (highest quality) > avatar URLs > chara_card_v2.png (last resort)
        const imageUrls = [];
        
        // ST uses metadata.node.max_res_url for the highest quality avatar
        if (metadataMaxResUrl) {
            imageUrls.push(metadataMaxResUrl);
        }
        
        // Standard avatar URLs
        if (metadataAvatarUrl) {
            imageUrls.push(metadataAvatarUrl);
        }
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`);
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/avatar.png`);
        
        // Last resort: chara_card_v2.png (works as an image even if card data is stale)
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`);
        
        // De-duplicate URLs
        const uniqueUrls = [...new Set(imageUrls)];
        
        debugLog('[Chub Import] Will try these image URLs:', uniqueUrls);
        
        let imageBuffer = null;
        let needsConversion = false;
        
        for (const url of uniqueUrls) {
            debugLog('[Chub Import] Trying image URL:', url);
            try {
                let response = await fetch(url);
                if (!response.ok) {
                    const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
                    response = await fetch(proxyUrl);
                }
                
                if (response.ok) {
                    imageBuffer = await response.arrayBuffer();
                    const contentType = response.headers.get('content-type') || '';
                    needsConversion = url.endsWith('.webp') || contentType.includes('webp');
                    console.log('[Chub Import] Avatar downloaded from:', url.split('/').pop(), 
                        'size:', imageBuffer.byteLength, 'bytes',
                        'needsConversion:', needsConversion);
                    break;
                }
            } catch (e) {
                debugLog('[Chub Import] Failed to fetch', url, ':', e.message);
            }
        }
        
        if (!imageBuffer) {
            throw new Error('Could not download character avatar from any available URL');
        }
        
        // Convert to PNG if needed (WebP can't hold text chunks)
        let pngBuffer = imageBuffer;
        if (needsConversion) {
            console.log('[Chub Import] Converting WebP avatar to PNG');
            pngBuffer = await convertImageToPng(imageBuffer);
            imageBuffer = null; // Release original buffer
        }
        
        debugLog('[Chub Import] Character card built from API:', {
            name: characterCard.data.name,
            first_mes_length: characterCard.data.first_mes?.length,
            alternate_greetings_count: characterCard.data.alternate_greetings?.length,
            has_character_book: !!characterCard.data.character_book,
            extensions_keys: Object.keys(characterCard.data.extensions || {})
        });
        
        // Embed character card into the avatar PNG
        let embeddedPng = embedCharacterDataInPng(pngBuffer, characterCard);
        pngBuffer = null; // Release source buffer
        
        // Create file for ST import
        const fileName = fullPath.split('/').pop() + '.png';
        // Create File directly from Uint8Array (skip intermediate Blob to avoid double copy)
        let file = new File([embeddedPng], fileName, { type: 'image/png' });
        embeddedPng = null; // Release — data now lives in file
        
        let formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');
        file = null; // FormData now holds the reference
        
        const csrfToken = getCSRFToken();
        
        const importResponse = await fetch('/api/characters/import', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData
        });
        formData = null; // Release — fetch has consumed the body
        
        const responseText = await importResponse.text();
        debugLog('Import response:', importResponse.status, responseText);
        
        if (!importResponse.ok) {
            throw new Error(`Import error: ${responseText}`);
        }
        
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
        
        if (result.error) {
            throw new Error('Import failed: Server returned error');
        }
        
        // Check for embedded media URLs in the character card
        const mediaUrls = findCharacterMediaUrls(characterCard);
        const galleryId = characterCard.data.extensions?.gallery_id || null;
        
        // Release cached metadata for this character — download is done, free memory
        chubMetadataCache.delete(fullPath);
        
        return { 
            success: true, 
            fileName: result.file_name || fileName,
            hasGallery: hasGallery,
            chubId: metadataId || null,
            characterName: characterName,
            fullPath: fullPath,
            avatarUrl: `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`,
            embeddedMediaUrls: mediaUrls,
            galleryId: galleryId
        };
        
    } catch (error) {
        console.error(`Failed to import ${fullPath}:`, error);
        return { success: false, error: error.message };
    }
}

// Shared log entry icons
const LOG_ICONS = {
    success: 'fa-check-circle',
    error: 'fa-times-circle',
    pending: 'fa-spinner fa-spin',
    info: 'fa-info-circle',
    divider: 'fa-minus'
};

/**
 * Add an entry to a log container
 * @param {HTMLElement} container - The log container element
 * @param {string} message - The message to display
 * @param {string} status - Status: 'success', 'error', 'pending', 'info', or 'divider'
 * @returns {HTMLElement} The created log entry element
 */
function addLogEntry(container, message, status = 'pending') {
    const entry = document.createElement('div');
    
    // Handle divider specially
    if (status === 'divider') {
        entry.className = 'import-log-divider';
        entry.innerHTML = '<hr>';
    } else {
        entry.className = `import-log-entry ${status}`;
        entry.innerHTML = `<i class="fa-solid ${LOG_ICONS[status] || LOG_ICONS.pending}"></i>${escapeHtml(message)}`;
    }
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    return entry;
}

/**
 * Update an existing log entry
 * @param {HTMLElement} entry - The log entry element to update
 * @param {string} message - The new message
 * @param {string} status - The new status
 */
function updateLogEntryStatus(entry, message, status) {
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${LOG_ICONS[status]}"></i>${escapeHtml(message)}`;
}

// Convenience wrappers for specific logs
function addImportLogEntry(message, status = 'pending') {
    return addLogEntry(importLog, message, status);
}

function updateLogEntry(entry, message, status) {
    updateLogEntryStatus(entry, message, status);
}

// Start import process
startImportBtn?.addEventListener('click', async () => {
    // If in "Done" state, just close the modal
    if (startImportBtn.classList.contains('success')) {
        importModal.classList.add('hidden');
        return;
    }
    
    const text = importUrlsInput.value.trim();
    if (!text) {
        showToast('Please enter at least one URL', 'warning');
        return;
    }
    
    // Parse URLs
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const validUrls = [];
    
    for (const line of lines) {
        const fullPath = parseChubUrl(line);
        if (fullPath) {
            validUrls.push({ url: line, fullPath });
        }
    }
    
    if (validUrls.length === 0) {
        showToast('No valid Chub AI URLs found', 'error');
        return;
    }
    
    // Get import options
    const skipDuplicates = document.getElementById('importSkipDuplicates')?.checked ?? true;
    const autoDownloadGallery = document.getElementById('importAutoDownloadGallery')?.checked ?? false;
    const autoDownloadMedia = document.getElementById('importAutoDownloadMedia')?.checked ?? false;
    
    // Start importing
    isImporting = true;
    startImportBtn.disabled = true;
    startImportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
    importUrlsInput.disabled = true;
    
    importProgress.classList.remove('hidden');
    importLog.innerHTML = '';
    importProgressFill.style.width = '0%';
    importProgressCount.textContent = `0/${validUrls.length}`;
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let mediaDownloadCount = 0;
    
    // Get stat elements
    const importStats = document.getElementById('importStats');
    const importStatImported = document.getElementById('importStatImported');
    const importStatSkipped = document.getElementById('importStatSkipped');
    const importStatMedia = document.getElementById('importStatMedia');
    const importStatErrors = document.getElementById('importStatErrors');
    const importMediaProgress = document.getElementById('importMediaProgress');
    const importMediaProgressFill = document.getElementById('importMediaProgressFill');
    const importMediaProgressCount = document.getElementById('importMediaProgressCount');
    
    // Show stats section
    if (importStats) {
        importStats.classList.remove('hidden');
        importStatImported.textContent = '0';
        importStatSkipped.textContent = '0';
        importStatMedia.textContent = '0';
        importStatErrors.textContent = '0';
    }
    
    // Helper to update stats display
    const updateStats = () => {
        if (importStatImported) importStatImported.textContent = successCount;
        if (importStatSkipped) importStatSkipped.textContent = skippedCount;
        if (importStatMedia) importStatMedia.textContent = mediaDownloadCount;
        if (importStatErrors) importStatErrors.textContent = errorCount;
    };
    
    for (let i = 0; i < validUrls.length; i++) {
        const { url, fullPath } = validUrls[i];
        const displayName = fullPath.split('/').pop();
        
        const logEntry = addImportLogEntry(`Checking ${displayName}`, 'pending');
        
        // === PRE-IMPORT DUPLICATE CHECK ===
        if (skipDuplicates) {
            try {
                // Fetch metadata to check for duplicates
                const metadata = await fetchChubMetadata(fullPath);
                
                if (metadata && metadata.definition) {
                    const characterName = metadata.definition?.name || metadata.name || displayName;
                    const characterCreator = metadata.definition?.creator || metadata.creator || fullPath.split('/')[0] || '';
                    
                    // Check for duplicates
                    const duplicateMatches = checkCharacterForDuplicates({
                        name: characterName,
                        creator: characterCreator,
                        fullPath: fullPath,
                        definition: metadata.definition
                    });
                    
                    if (duplicateMatches.length > 0) {
                        const bestMatch = duplicateMatches[0];
                        const existingName = getCharField(bestMatch.char, 'name');
                        skippedCount++;
                        updateStats();
                        updateLogEntry(logEntry, `${displayName} skipped - already exists as "${existingName}" (${bestMatch.matchReason})`, 'info');
                        
                        // Update progress
                        const progress = ((i + 1) / validUrls.length) * 100;
                        importProgressFill.style.width = `${progress}%`;
                        importProgressCount.textContent = `${i + 1}/${validUrls.length}`;
                        continue;
                    }
                }
            } catch (e) {
                debugLog('[Import] Error checking for duplicates:', e);
                // Continue with import if duplicate check fails
            }
        }
        // === END DUPLICATE CHECK ===
        
        updateLogEntry(logEntry, `Importing ${displayName}`, 'pending');
        
        const result = await importChubCharacter(fullPath);
        
        // Yield to browser for GC + UI updates between imports (critical for mobile)
        await new Promise(r => setTimeout(r, 50));
        
        if (result.success) {
            successCount++;
            updateStats();
            updateLogEntry(logEntry, `${displayName} imported successfully`, 'success');
            
            // Determine folder name for media downloads
            // Use gallery_id if available (for unique folders), otherwise fall back to character name
            let folderName;
            if (result.galleryId) {
                // Build the unique folder name: CharacterName_uuid
                const safeName = result.characterName.replace(/[<>:"/\\|?*]/g, '_').trim();
                folderName = `${safeName}_${result.galleryId}`;
                debugLog('[Import] Using unique gallery folder:', folderName);
                // NOTE: We do NOT register a gallery folder override here with a tempChar.
                // The result.fileName from the server may not exactly match the final avatar
                // filename in allCharacters, which would create an orphaned mapping.
                // Instead, syncAllGalleryFolderOverrides() is called after fetchCharacters(true)
                // at the end of the batch import, using authoritative avatar keys.
            } else {
                // Fall back to character name-based folder
                folderName = resolveGalleryFolderName(result.fileName || result.characterName);
                debugLog('[Import] Using name-based folder:', folderName);
            }
            
            // Auto-download embedded media FIRST if enabled (takes precedence for media localization)
            if (autoDownloadMedia && result.embeddedMediaUrls && result.embeddedMediaUrls.length > 0) {
                // Show media progress
                if (importMediaProgress) {
                    importMediaProgress.classList.remove('hidden');
                    importMediaProgressFill.style.width = '0%';
                    importMediaProgressCount.textContent = `0/${result.embeddedMediaUrls.length}`;
                }
                
                const mediaLogEntry = addImportLogEntry(`  ↳ Embedded Media: downloading ${result.embeddedMediaUrls.length} file(s)...`, 'pending');
                const mediaResult = await downloadEmbeddedMediaForCharacter(folderName, result.embeddedMediaUrls, {
                    onProgress: (current, total) => {
                        if (importMediaProgressFill) {
                            importMediaProgressFill.style.width = `${(current / total) * 100}%`;
                            importMediaProgressCount.textContent = `${current}/${total}`;
                        }
                    }
                });
                mediaDownloadCount += mediaResult.success || 0;
                updateStats();
                if (mediaResult.success > 0) {
                    updateLogEntry(mediaLogEntry, `  ↳ Embedded Media: ${mediaResult.success} downloaded, ${mediaResult.skipped || 0} skipped, ${mediaResult.errors || 0} failed`, 'success');
                } else if (mediaResult.skipped > 0) {
                    updateLogEntry(mediaLogEntry, `  ↳ Embedded Media: ${mediaResult.skipped} already exist`, 'info');
                } else {
                    updateLogEntry(mediaLogEntry, `  ↳ Embedded Media: no files downloaded`, 'info');
                }
            }
            
            // Auto-download gallery SECOND if enabled (will skip duplicates already downloaded as embedded media)
            if (autoDownloadGallery && result.hasGallery && result.chubId) {
                // Show media progress
                if (importMediaProgress) {
                    importMediaProgress.classList.remove('hidden');
                    importMediaProgressFill.style.width = '0%';
                    importMediaProgressCount.textContent = `0/?`;
                }
                
                const galleryLogEntry = addImportLogEntry(`  ↳ ChubAI Gallery: downloading...`, 'pending');
                const galleryResult = await downloadChubGalleryForCharacter(folderName, result.chubId, {
                    onProgress: (current, total) => {
                        if (importMediaProgressFill) {
                            importMediaProgressFill.style.width = `${(current / total) * 100}%`;
                            importMediaProgressCount.textContent = `${current}/${total}`;
                        }
                    }
                });
                mediaDownloadCount += galleryResult.success || 0;
                updateStats();
                if (galleryResult.success > 0) {
                    updateLogEntry(galleryLogEntry, `  ↳ ChubAI Gallery: ${galleryResult.success} downloaded, ${galleryResult.skipped || 0} skipped, ${galleryResult.errors || 0} failed`, 'success');
                } else if (galleryResult.skipped > 0) {
                    updateLogEntry(galleryLogEntry, `  ↳ ChubAI Gallery: ${galleryResult.skipped} already exist`, 'info');
                } else {
                    updateLogEntry(galleryLogEntry, `  ↳ ChubAI Gallery: no images available`, 'info');
                }
            }
        } else {
            errorCount++;
            updateStats();
            updateLogEntry(logEntry, `${displayName}: ${result.error}`, 'error');
        }
        
        // Update progress
        const progress = ((i + 1) / validUrls.length) * 100;
        importProgressFill.style.width = `${progress}%`;
        importProgressCount.textContent = `${i + 1}/${validUrls.length}`;
    }
    
    // Done
    isImporting = false;
    startImportBtn.disabled = false;
    startImportBtn.innerHTML = '<i class="fa-solid fa-check"></i> Done';
    startImportBtn.classList.add('success');
    importUrlsInput.disabled = false;
    
    // Hide media progress
    if (importMediaProgress) {
        importMediaProgress.classList.add('hidden');
    }
    
    // Show summary toast
    if (successCount > 0 || skippedCount > 0) {
        const parts = [];
        if (successCount > 0) parts.push(`Imported ${successCount}`);
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
        if (mediaDownloadCount > 0) parts.push(`${mediaDownloadCount} media`);
        if (errorCount > 0) parts.push(`${errorCount} failed`);
        showToast(parts.join(', '), successCount > 0 ? 'success' : 'info');
        
        // Only refresh if we actually imported something
        if (successCount > 0) {
            // Refresh the gallery directly from API (forceRefresh=true bypasses opener)
            await fetchCharacters(true);
            
            // Register gallery folder overrides for newly imported characters
            if (getSetting('uniqueGalleryFolders')) {
                syncAllGalleryFolderOverrides();
                debugLog('[BatchImport] Synced gallery folder overrides for newly imported characters');
            }
            
            // Also refresh the main SillyTavern window's character list (fire-and-forget)
            try {
                if (window.opener && !window.opener.closed && window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                    const context = window.opener.SillyTavern.getContext();
                    if (context && typeof context.getCharacters === 'function') {
                        debugLog('Triggering character refresh in main window...');
                        context.getCharacters().catch(e => console.warn('Main window refresh failed:', e));
                    }
                }
            } catch (e) {
                console.warn('Could not refresh main window characters:', e);
            }
            
            // NOTE: Import summary modal is NOT shown here - it's only for ChubAI browser downloads
            // This modal already shows progress with stats, no need for additional popup
        }
    } else {
        showToast(`Import failed: ${errorCount} error${errorCount > 1 ? 's' : ''}`, 'error');
    }
});

// ==============================================
// Import Summary Modal
// ==============================================

// Store pending media characters for download
let pendingMediaCharacters = [];
// Store pending gallery characters for download
let pendingGalleryCharacters = [];
// Track active import-summary downloads for cancel/cleanup
let importSummaryDownloadState = {
    active: false,
    abort: false,
    controller: null
};

function getImportSummaryFolderName(charInfo) {
    if (charInfo?.galleryId) {
        const safeName = (charInfo.name || 'Unknown').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 50);
        return `${safeName}_${charInfo.galleryId}`;
    }
    return resolveGalleryFolderName(charInfo?.avatar || charInfo?.name);
}

function resetImportSummaryDownloads() {
    importSummaryDownloadState.active = false;
    importSummaryDownloadState.abort = false;
    importSummaryDownloadState.controller = null;
    pendingMediaCharacters = [];
    pendingGalleryCharacters = [];
}

function handleImportSummaryCloseRequest() {
    if (importSummaryDownloadState.active) {
        const confirmClose = confirm('Downloads are still running. Stop and close?');
        if (!confirmClose) return;
        importSummaryDownloadState.abort = true;
        importSummaryDownloadState.controller?.abort();
        importSummaryDownloadState.active = false;
        pendingMediaCharacters = [];
        pendingGalleryCharacters = [];
    } else {
        resetImportSummaryDownloads();
    }
    hideModal('importSummaryModal');
}

/**
 * Show import summary modal with 2 rows: gallery and/or embedded media
 * @param {Object} options
 * @param {Array<{name: string, fullPath: string, url: string, chubId: number}>} options.galleryCharacters - Characters with ChubAI galleries
 * @param {Array<{name: string, avatar: string, mediaUrls: string[]}>} options.mediaCharacters - Characters with embedded media
 */
function showImportSummaryModal({ galleryCharacters = [], mediaCharacters = [] }) {
    const modal = document.getElementById('importSummaryModal');
    const galleryRow = document.getElementById('importSummaryGalleryRow');
    const galleryDesc = document.getElementById('importSummaryGalleryDesc');
    const mediaRow = document.getElementById('importSummaryMediaRow');
    const mediaDesc = document.getElementById('importSummaryMediaDesc');
    const downloadAllBtn = document.getElementById('importSummaryDownloadAllBtn');
    const progressWrap = document.getElementById('importSummaryProgress');
    const progressFill = document.getElementById('importSummaryProgressFill');
    const progressLabel = document.getElementById('importSummaryProgressLabel');
    const progressCount = document.getElementById('importSummaryProgressCount');
    
    if (!modal) return;
    
    // Store media characters for download
    pendingMediaCharacters = mediaCharacters;
    // Store gallery characters for download
    pendingGalleryCharacters = galleryCharacters;
    
    // Reset rows
    galleryRow?.classList.add('hidden');
    mediaRow?.classList.add('hidden');
    
    const includeChubGallery = getSetting('includeChubGallery') !== false;

    // Show gallery row if there are gallery characters (disabled when setting off)
    if (galleryCharacters.length > 0 && galleryRow) {
        if (galleryCharacters.length === 1) {
            if (galleryDesc) {
                galleryDesc.textContent = includeChubGallery
                    ? 'Additional artwork available on ChubAI'
                    : 'Additional artwork available on ChubAI (disabled in settings)';
            }
        } else {
            if (galleryDesc) {
                galleryDesc.textContent = includeChubGallery
                    ? `${galleryCharacters.length} characters have gallery images`
                    : `${galleryCharacters.length} characters have gallery images (disabled in settings)`;
            }
        }
        galleryRow.classList.toggle('disabled', !includeChubGallery);
        galleryRow.classList.remove('hidden');
    }
    
    // Show media row if there are media characters with actual files
    if (mediaCharacters.length > 0 && mediaRow) {
        // Calculate total file count
        const totalFiles = mediaCharacters.reduce((sum, c) => sum + (c.mediaUrls?.length || 0), 0);
        
        // Only show if there are actually files to download
        if (totalFiles > 0) {
            if (mediaDesc) {
                mediaDesc.textContent = `${totalFiles} remote file${totalFiles > 1 ? 's' : ''} that can be saved locally`;
            }
            
            mediaRow.classList.remove('hidden');
        }
    }
    
    // Reset Download All button
    if (downloadAllBtn) {
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download All';
        downloadAllBtn.classList.remove('success');
    }

    if (progressWrap && progressFill && progressLabel && progressCount) {
        progressWrap.classList.add('hidden');
        progressFill.style.width = '0%';
        progressLabel.textContent = 'Preparing downloads...';
        progressCount.textContent = '0/0';
    }
    
    modal.classList.remove('hidden');
}

// Import Summary Modal Event Listeners
on('closeImportSummaryModal', 'click', handleImportSummaryCloseRequest);

// Download All button - downloads both gallery and embedded media
on('importSummaryDownloadAllBtn', 'click', async () => {
    const btn = document.getElementById('importSummaryDownloadAllBtn');
    const progressWrap = document.getElementById('importSummaryProgress');
    const progressFill = document.getElementById('importSummaryProgressFill');
    const progressLabel = document.getElementById('importSummaryProgressLabel');
    const progressCount = document.getElementById('importSummaryProgressCount');
    
    // If already done, close the modal
    if (btn.classList.contains('success')) {
        hideModal('importSummaryModal');
        pendingMediaCharacters = [];
        pendingGalleryCharacters = [];
        return;
    }
    
    const hasGallery = pendingGalleryCharacters.length > 0 && getSetting('includeChubGallery') !== false;
    const hasMedia = pendingMediaCharacters.length > 0;
    
    if (!hasGallery && !hasMedia) {
        showToast('Nothing to download', 'info');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';

    importSummaryDownloadState.active = true;
    importSummaryDownloadState.abort = false;
    importSummaryDownloadState.controller?.abort();
    importSummaryDownloadState.controller = new AbortController();
    
    let totalGallerySuccess = 0;
    let totalMediaSuccess = 0;
    let wasAborted = false;
    let processedMediaFiles = 0;
    const totalMediaFiles = pendingMediaCharacters.reduce((sum, c) => sum + (c.mediaUrls?.length || 0), 0);

    const setProgress = (label, current, total) => {
        if (!progressWrap || !progressFill || !progressLabel || !progressCount) return;
        progressWrap.classList.remove('hidden');
        progressLabel.textContent = label;
        if (typeof total === 'number' && total > 0) {
            const pct = Math.min(100, Math.round((current / total) * 100));
            progressFill.style.width = `${pct}%`;
            progressCount.textContent = `${current}/${total}`;
        } else {
            progressFill.style.width = '20%';
            progressCount.textContent = current ? String(current) : '0';
        }
    };
    
    // Download embedded media FIRST (takes precedence for media localization matching)
    if (hasMedia) {
        setProgress('Embedded media', 0, totalMediaFiles || 0);
        for (const charInfo of pendingMediaCharacters) {
            if (importSummaryDownloadState.abort) {
                wasAborted = true;
                break;
            }
            const folderName = getImportSummaryFolderName(charInfo);
            const result = await downloadEmbeddedMediaForCharacter(folderName, charInfo.mediaUrls || [], {
                shouldAbort: () => importSummaryDownloadState.abort,
                abortSignal: importSummaryDownloadState.controller.signal
                ,
                onProgress: () => {
                    processedMediaFiles++;
                    setProgress('Embedded media', processedMediaFiles, totalMediaFiles || 0);
                }
            });
            if (result.aborted) {
                wasAborted = true;
                break;
            }
            totalMediaSuccess += result.success;
        }
    }
    
    // Download gallery images SECOND (will skip duplicates already downloaded as embedded media)
    if (hasGallery && !wasAborted) {
        for (const charInfo of pendingGalleryCharacters) {
            if (importSummaryDownloadState.abort) {
                wasAborted = true;
                break;
            }
            let chubId = charInfo.chubId;
            if (!chubId && charInfo.fullPath) {
                const metadata = await fetchChubMetadata(charInfo.fullPath);
                if (metadata && metadata.id) {
                    chubId = metadata.id;
                }
            }
            if (chubId) {
                const folderName = getImportSummaryFolderName(charInfo);
                const result = await downloadChubGalleryForCharacter(folderName, chubId, {
                    shouldAbort: () => importSummaryDownloadState.abort,
                    abortSignal: importSummaryDownloadState.controller.signal,
                    onProgress: (current, total) => {
                        const labelName = charInfo.name || 'ChubAI gallery';
                        setProgress(`ChubAI gallery: ${labelName}`, current, total);
                    }
                });
                if (result.aborted) {
                    wasAborted = true;
                    break;
                }
                totalGallerySuccess += result.success;
            }
        }
    }
    
    importSummaryDownloadState.active = false;
    importSummaryDownloadState.controller = null;
    if (wasAborted) {
        showToast('Downloads cancelled', 'info');
        if (progressWrap && progressFill && progressLabel && progressCount) {
            progressWrap.classList.add('hidden');
            progressFill.style.width = '0%';
            progressLabel.textContent = 'Preparing downloads...';
            progressCount.textContent = '0/0';
        }
        resetImportSummaryDownloads();
        return;
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Done';
    btn.classList.add('success');
    
    const totalDownloaded = totalGallerySuccess + totalMediaSuccess;
    if (totalDownloaded > 0) {
        showToast(`Downloaded ${totalDownloaded} file${totalDownloaded > 1 ? 's' : ''}`, 'success');
        fetchCharacters(true);
    } else {
        showToast('All files already exist', 'info');
    }

    if (progressWrap && progressFill && progressLabel && progressCount) {
        progressWrap.classList.add('hidden');
        progressFill.style.width = '0%';
        progressLabel.textContent = 'Preparing downloads...';
        progressCount.textContent = '0/0';
    }

    resetImportSummaryDownloads();
});

// ==============================================
// ChubAI Link Feature
// ==============================================

/**
 * Get ChubAI link info from character
 * @param {Object} char - Character object
 * @returns {Object|null} - { id, fullPath } or null if not linked
 */
function getChubLinkInfo(char) {
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
 * Set ChubAI link info on character
 * @param {Object} char - Character object
 * @param {Object|null} chubInfo - { id, fullPath, linkedAt } or null to unlink
 */
function setChubLinkInfo(char, chubInfo) {
    if (!char) return;
    
    // Ensure data and extensions exist
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    
    if (chubInfo) {
        char.data.extensions.chub = {
            id: chubInfo.id,
            full_path: chubInfo.fullPath,
            linkedAt: chubInfo.linkedAt || new Date().toISOString()
        };
    } else {
        delete char.data.extensions.chub;
    }
}

/**
 * Update the ChubAI link indicator in the modal
 * @param {Object} char - Character object
 */
function updateChubLinkIndicator(char) {
    const indicator = document.getElementById('chubLinkIndicator');
    if (!indicator) return;
    
    const chubInfo = getChubLinkInfo(char);
    const textSpan = indicator.querySelector('.chub-link-text');
    
    if (chubInfo && chubInfo.fullPath) {
        indicator.classList.add('linked');
        indicator.title = `Linked to ChubAI: ${chubInfo.fullPath}`;
        if (textSpan) {
            textSpan.innerHTML = 'ChubAI <i class="fa-solid fa-check"></i>';
        }
    } else {
        indicator.classList.remove('linked');
        indicator.title = 'Click to link to ChubAI';
        if (textSpan) {
            textSpan.textContent = 'ChubAI';
        }
    }
}

/**
 * Open the ChubAI link modal
 */
function openChubLinkModal() {
    if (!activeChar) return;
    
    const modal = document.getElementById('chubLinkModal');
    const linkedState = document.getElementById('chubLinkLinkedState');
    const unlinkedState = document.getElementById('chubLinkUnlinkedState');
    const titleEl = document.getElementById('chubLinkModalTitle');
    const searchResults = document.getElementById('chubLinkSearchResults');
    
    // Populate sidebar with character info
    const avatarEl = document.getElementById('chubLinkCharAvatar');
    const charNameEl = document.getElementById('chubLinkCharName');
    const charName = activeChar.name || activeChar.data?.name || 'Character';
    
    if (avatarEl) {
        avatarEl.src = getCharacterAvatarUrl(activeChar.avatar);
        avatarEl.onerror = () => { avatarEl.src = '/img/ai4.png'; };
    }
    if (charNameEl) {
        charNameEl.textContent = charName;
        charNameEl.title = charName;
    }
    
    // Status icon on avatar
    const statusIcon = document.getElementById('chubLinkStatusIcon');
    
    const chubInfo = getChubLinkInfo(activeChar);
    
    if (chubInfo && chubInfo.fullPath) {
        // Show linked state
        linkedState.classList.remove('hidden');
        unlinkedState.classList.add('hidden');
        titleEl.textContent = 'ChubAI Link';
        
        // Update status icon
        if (statusIcon) {
            statusIcon.className = 'chub-link-status-icon linked';
            statusIcon.innerHTML = '<i class="fa-solid fa-link"></i>';
        }
        
        // Update linked path
        const pathEl = document.getElementById('chubLinkCurrentPath');
        if (pathEl) {
            pathEl.href = `https://chub.ai/characters/${chubInfo.fullPath}`;
            const pathSpan = pathEl.querySelector('span');
            if (pathSpan) pathSpan.textContent = chubInfo.fullPath;
        }
        
        // Populate stats from stored chub data if available
        const starsEl = document.getElementById('chubLinkStars');
        const favoritesEl = document.getElementById('chubLinkFavorites');
        const tokensEl = document.getElementById('chubLinkTokens');
        
        // Try to get cached info from character extensions
        // Note: ChubAI uses starCount for downloads, n_favorites for actual favorites
        const chubData = activeChar.data?.extensions?.chub || {};
        if (starsEl) starsEl.textContent = chubData.downloadCount ? formatNumber(chubData.downloadCount) : '-';
        if (favoritesEl) favoritesEl.textContent = chubData.favoritesCount ? formatNumber(chubData.favoritesCount) : '-';
        if (tokensEl) tokensEl.textContent = chubData.tokenCount ? formatNumber(chubData.tokenCount) : '-';
        
        // Fetch fresh stats from ChubAI (async, updates UI when ready)
        fetchChubLinkStats(chubInfo.fullPath);
        
    } else {
        // Show unlinked state
        linkedState.classList.add('hidden');
        unlinkedState.classList.remove('hidden');
        titleEl.textContent = 'Link to ChubAI';
        
        // Update status icon
        if (statusIcon) {
            statusIcon.className = 'chub-link-status-icon unlinked';
            statusIcon.innerHTML = '<i class="fa-solid fa-link-slash"></i>';
        }
        
        // Pre-fill search with character info
        const nameInput = document.getElementById('chubLinkSearchName');
        const creatorInput = document.getElementById('chubLinkSearchCreator');
        const urlInput = document.getElementById('chubLinkUrlInput');
        
        const creator = activeChar.creator || activeChar.data?.creator || '';
        
        if (nameInput) nameInput.value = charName;
        if (creatorInput) creatorInput.value = creator;
        if (urlInput) urlInput.value = '';
        if (searchResults) searchResults.innerHTML = '';
    }
    
    modal.classList.remove('hidden');
}

/**
 * Fetch fresh stats for linked ChubAI character
 */
async function fetchChubLinkStats(fullPath) {
    try {
        const metadata = await fetchChubMetadata(fullPath);
        if (!metadata) return;
        
        const starsEl = document.getElementById('chubLinkStars');
        const favoritesEl = document.getElementById('chubLinkFavorites');
        const tokensEl = document.getElementById('chubLinkTokens');
        
        // ChubAI's weird naming: starCount is actually downloads, n_favorites is favorites
        const downloadCount = metadata.starCount || 0;
        const favoritesCount = metadata.n_favorites || metadata.nFavorites || 0;
        const tokenCount = metadata.nTokens || metadata.n_tokens || 0;
        
        if (starsEl) starsEl.textContent = formatNumber(downloadCount);
        if (favoritesEl) favoritesEl.textContent = formatNumber(favoritesCount);
        if (tokensEl) tokensEl.textContent = formatNumber(tokenCount);
        
        // Also update the stored data on the character
        if (activeChar && activeChar.data?.extensions?.chub) {
            activeChar.data.extensions.chub.downloadCount = downloadCount;
            activeChar.data.extensions.chub.favoritesCount = favoritesCount;
            activeChar.data.extensions.chub.tokenCount = tokenCount;
        }
    } catch (e) {
        debugLog('[ChubLink] Could not fetch stats:', e.message);
    }
}

/**
 * Search ChubAI for characters matching name/creator
 */
async function searchChubForLink(name, creator) {
    const resultsContainer = document.getElementById('chubLinkSearchResults');
    if (!resultsContainer) return;
    
    if (!name.trim()) {
        resultsContainer.innerHTML = '<div class="chub-link-search-empty">Enter a character name to search</div>';
        return;
    }
    
    resultsContainer.innerHTML = '<div class="chub-link-search-loading"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';
    
    try {
        const headers = getChubHeaders(true);
        
        let allNodes = [];
        const normalizedName = name.trim().toLowerCase();
        const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 2);
        
        // Pass 1: If we have a creator, search by username filter first
        // This finds ALL characters by this author, then we filter by name
        if (creator && creator.trim()) {
            const creatorLower = creator.trim().toLowerCase();
            const authorParams = new URLSearchParams({
                first: '200', // Get many results to find even less popular characters
                sort: 'download_count',
                nsfw: 'true',
                nsfl: 'true',
                include_forks: 'true',
                username: creatorLower
            });
            
            try {
                const authorResponse = await fetch(`${CHUB_API_BASE}/search?${authorParams.toString()}`, {
                    method: 'GET',
                    headers
                });
                
                if (authorResponse.ok) {
                    const authorData = await authorResponse.json();
                    const authorNodes = extractNodes(authorData);
                    
                    // Filter to characters whose name contains or is contained by search name
                    // This handles "Ghost" matching "Ghost exorcism simulator"
                    for (const node of authorNodes) {
                        const nodeName = (node.name || '').toLowerCase().trim();
                        const nodeNameWords = nodeName.split(/\s+/).filter(w => w.length > 2);
                        
                        // Match if:
                        // 1. Exact match
                        // 2. Node name contains search name
                        // 3. Search name contains node name
                        // 4. First word matches
                        // 5. Any significant word from search is in node name
                        const firstWordMatch = nodeNameWords.length > 0 && nameWords.length > 0 && 
                            (nodeNameWords[0] === nameWords[0] || nodeNameWords[0].startsWith(nameWords[0]) || nameWords[0].startsWith(nodeNameWords[0]));
                        const anyWordMatch = nameWords.some(w => nodeName.includes(w));
                        
                        if (nodeName === normalizedName || 
                            nodeName.includes(normalizedName) ||
                            normalizedName.includes(nodeName) ||
                            firstWordMatch ||
                            anyWordMatch) {
                            allNodes.push(node);
                        }
                    }
                    
                    if (allNodes.length > 0) {
                        debugLog(`[ChubLink] Found ${allNodes.length} matches for "${name}" by author "${creator}"`);
                    }
                }
            } catch (e) {
                debugLog('[ChubLink] Author search failed, falling back to term search');
            }
        }
        
        // Pass 2: Combined search term (adds more results)
        const searchTerm = creator && creator.trim() ? `${name.trim()} ${creator.trim()}` : name.trim();
        
        const params = new URLSearchParams({
            search: searchTerm,
            first: '24',
            sort: 'download_count',
            nsfw: 'true',
            nsfl: 'true',
            include_forks: 'true',
            min_tokens: '50'
        });
        
        const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }
        
        const data = await response.json();
        let nodes = extractNodes(data);
        
        // Merge results (avoid duplicates)
        for (const node of nodes) {
            if (!allNodes.some(n => n.fullPath === node.fullPath)) {
                allNodes.push(node);
            }
        }
        
        if (allNodes.length === 0) {
            resultsContainer.innerHTML = '<div class="chub-link-search-empty"><i class="fa-solid fa-search"></i> No characters found</div>';
            return;
        }
        
        // Sort results by content similarity to the local character
        // This helps when creators use taglines as names on ChubAI
        if (activeChar) {
            allNodes = sortChubResultsByContentSimilarity(allNodes, activeChar);
        }
        
        // Render results
        resultsContainer.innerHTML = allNodes.map(node => {
            const avatarUrl = node.avatar_url || `${CHUB_AVATAR_BASE}${node.fullPath}/avatar`;
            const rating = node.rating ? node.rating.toFixed(1) : 'N/A';
            const starCount = node.starCount || 0;
            
            return `
                <div class="chub-link-search-result" data-fullpath="${escapeHtml(node.fullPath)}" data-id="${node.id || ''}">
                    <img class="chub-link-search-result-avatar" src="${avatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                    <div class="chub-link-search-result-info">
                        <div class="chub-link-search-result-name">${escapeHtml(node.name || node.fullPath.split('/').pop())}</div>
                        <div class="chub-link-search-result-creator">by ${escapeHtml(node.fullPath.split('/')[0])}</div>
                        <div class="chub-link-search-result-stats">
                            <span><i class="fa-solid fa-star"></i> ${rating}</span>
                            <span><i class="fa-solid fa-heart"></i> ${starCount}</span>
                        </div>
                    </div>
                    <button class="action-btn primary small chub-link-search-result-btn" onclick="linkToChubResult(this)">
                        <i class="fa-solid fa-link"></i> Link
                    </button>
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('[ChubLink] Search error:', error);
        resultsContainer.innerHTML = `<div class="chub-link-search-empty"><i class="fa-solid fa-exclamation-triangle"></i> Search failed: ${error.message}</div>`;
    }
}

/**
 * Link to a character from search results
 */
async function linkToChubResult(btn) {
    const resultEl = btn.closest('.chub-link-search-result');
    if (!resultEl || !activeChar) return;
    
    const fullPath = resultEl.dataset.fullpath;
    let chubId = resultEl.dataset.id;
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
        // If we don't have the ID, fetch metadata to get it
        if (!chubId) {
            const metadata = await fetchChubMetadata(fullPath);
            if (metadata && metadata.id) {
                chubId = metadata.id;
            }
        }
        
        // Save link to character
        await saveChubLink(activeChar, { id: chubId, fullPath });
        
        showToast(`Linked to ${fullPath}`, 'success');
        
        // Update indicator and close modal
        updateChubLinkIndicator(activeChar);
        hideModal('chubLinkModal');
        
    } catch (error) {
        console.error('[ChubLink] Link error:', error);
        showToast('Failed to save link', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Link';
    }
}

// Make it globally accessible for onclick handlers
window.linkToChubResult = linkToChubResult;

/**
 * Link to ChubAI using a pasted URL
 */
async function linkToChubUrl(url) {
    if (!activeChar) return;
    
    const btn = document.getElementById('chubLinkUrlBtn');
    
    // Parse URL to get fullPath
    const match = url.match(/chub\.ai\/characters\/([^\/]+\/[^\/\?#]+)/i) ||
                  url.match(/characterhub\.org\/characters\/([^\/]+\/[^\/\?#]+)/i);
    
    if (!match) {
        showToast('Invalid ChubAI URL', 'error');
        return;
    }
    
    const fullPath = match[1];
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        // Fetch metadata to get ID
        const metadata = await fetchChubMetadata(fullPath);
        if (!metadata) {
            throw new Error('Could not fetch character info');
        }
        
        // Save link
        await saveChubLink(activeChar, { id: metadata.id, fullPath });
        
        showToast(`Linked to ${fullPath}`, 'success');
        
        // Update indicator and close modal
        updateChubLinkIndicator(activeChar);
        hideModal('chubLinkModal');
        
    } catch (error) {
        console.error('[ChubLink] URL link error:', error);
        showToast(`Failed to link: ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-link"></i> Link';
        }
    }
}

/**
 * Save ChubAI link to character card
 */
async function saveChubLink(char, chubInfo) {
    if (!char || !char.avatar) throw new Error('No character or avatar');
    
    debugLog('[ChubLink] saveChubLink called for:', char.name || char.avatar, 'with:', chubInfo);
    
    // Update local object
    setChubLinkInfo(char, chubInfo);
    
    // Also update in allCharacters array if it's a different reference
    const charInArray = allCharacters.find(c => c.avatar === char.avatar);
    if (charInArray && charInArray !== char) {
        setChubLinkInfo(charInArray, chubInfo);
    }
    
    // IMPORTANT: Preserve all existing extensions when updating chub link
    const existingExtensions = char.data?.extensions || {};
    
    // Normalize to snake_case for server storage (matches native ChubAI format)
    const normalizedChubInfo = chubInfo ? {
        id: chubInfo.id,
        full_path: chubInfo.fullPath,
        linkedAt: chubInfo.linkedAt || new Date().toISOString()
    } : null;
    
    const updatedExtensions = {
        ...existingExtensions,
        chub: normalizedChubInfo
    };
    
    // Save to server via merge-attributes API
    // IMPORTANT: Spread existing data to avoid wiping other fields
    const existingData = char.data || {};
    const response = await apiRequest('/characters/merge-attributes', 'POST', {
        avatar: char.avatar,
        create_date: char.create_date,
        data: {
            ...existingData,
            extensions: updatedExtensions,
            create_date: char.create_date
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error('[ChubLink] Save failed:', response.status, errorText);
        throw new Error(`Failed to save character: ${response.status}`);
    }
    
    // Also update in the main window's character list if available
    try {
        const context = getSTContext();
        if (context && context.characters) {
            const mainChar = context.characters.find(c => c.avatar === char.avatar);
            if (mainChar) {
                setChubLinkInfo(mainChar, chubInfo);
            }
        }
    } catch (e) {
        console.warn('[ChubLink] Could not update main window:', e);
    }
    
    debugLog(`[ChubLink] Saved link for ${char.name || char.avatar}: ${chubInfo?.fullPath || 'unlinked'}`);
}

/**
 * Unlink character from ChubAI
 */
async function unlinkFromChub() {
    if (!activeChar) return;
    
    const btn = document.getElementById('chubLinkUnlinkBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        await saveChubLink(activeChar, null);
        
        showToast('Unlinked from ChubAI', 'info');
        
        // Update indicator and switch to unlinked state
        updateChubLinkIndicator(activeChar);
        openChubLinkModal(); // Re-open to show unlinked state
        
    } catch (error) {
        console.error('[ChubLink] Unlink error:', error);
        showToast('Failed to unlink', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-unlink"></i> Unlink';
        }
    }
}

/**
 * Open character on ChubAI (external link)
 */
function openOnChubExternal() {
    if (!activeChar) return;
    
    const chubInfo = getChubLinkInfo(activeChar);
    if (!chubInfo || !chubInfo.fullPath) {
        showToast('Not linked to ChubAI', 'error');
        return;
    }
    
    window.open(`https://chub.ai/characters/${chubInfo.fullPath}`, '_blank');
}

/**
 * View character in ChubAI browser within the gallery
 */
async function viewInChubGallery() {
    if (!activeChar) {
        debugLog('[ChubLink] viewInChubGallery: no activeChar');
        return;
    }
    
    const chubInfo = getChubLinkInfo(activeChar);
    if (!chubInfo || !chubInfo.fullPath) {
        showToast('Not linked to ChubAI', 'error');
        return;
    }
    
    debugLog('[ChubLink] viewInChubGallery: fetching character from Chub', chubInfo.fullPath);
    
    // Close the link modal and character modal
    hideModal('chubLinkModal');
    hideModal('charModal');
    
    // Switch to ChubAI view (data-view="chub")
    document.querySelector('[data-view="chub"]')?.click();
    
    // Show loading toast
    showToast('Loading character from ChubAI...', 'info');
    
    // Fetch the character from ChubAI and open preview
    setTimeout(async () => {
        try {
            // Fetch character metadata
            const metadata = await fetchChubMetadata(chubInfo.fullPath);
            
            if (!metadata) {
                showToast('Character not found on ChubAI', 'error');
                return;
            }
            
            // Build a char object compatible with openChubCharPreview
            // Include all fields from the metadata response
            const chubChar = {
                id: metadata.id,
                fullPath: chubInfo.fullPath,
                name: metadata.name || metadata.definition?.name,
                description: metadata.description,
                tagline: metadata.tagline,
                avatar_url: `https://avatars.charhub.io/avatars/${chubInfo.fullPath}/avatar.webp`,
                rating: metadata.rating,
                starCount: metadata.starCount || metadata.star_count,
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
            
            // Open the character preview modal
            openChubCharPreview(chubChar);
            
        } catch (error) {
            console.error('[ChubLink] Failed to fetch character:', error);
            showToast('Failed to load character from ChubAI', 'error');
        }
    }, 200);
}

/**
 * Download gallery for linked character
 */
async function downloadLinkedGallery() {
    if (!activeChar) return;
    
    const chubInfo = getChubLinkInfo(activeChar);
    if (!chubInfo || !chubInfo.id) {
        showToast('Not linked to ChubAI', 'error');
        return;
    }
    
    const btn = document.getElementById('chubLinkGalleryBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';
    }
    
    try {
        const characterName = getCharacterName(activeChar, 'unknown');
        // Use character object to get unique folder name if available
        const folderName = getGalleryFolderName(activeChar);
        const result = await downloadChubGalleryForCharacter(folderName, chubInfo.id, {});
        
        if (result.success > 0) {
            showToast(`Downloaded ${result.success} gallery image${result.success > 1 ? 's' : ''}`, 'success');
            // Refresh gallery - pass character object for unique folder support
            fetchCharacterImages(activeChar);
        } else if (result.skipped > 0) {
            showToast('All gallery images already exist', 'info');
        } else {
            showToast('No gallery images found', 'info');
        }
        
    } catch (error) {
        console.error('[ChubLink] Gallery download error:', error);
        showToast('Failed to download gallery', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-images"></i> Download Gallery';
        }
    }
}

// ChubAI Link Modal Event Handlers
on('chubLinkIndicator', 'click', openChubLinkModal);
on('closeChubLinkModal', 'click', () => hideModal('chubLinkModal'));

on('chubLinkSearchBtn', 'click', () => {
    const name = document.getElementById('chubLinkSearchName')?.value || '';
    const creator = document.getElementById('chubLinkSearchCreator')?.value || '';
    searchChubForLink(name, creator);
});

// Allow Enter key to search
document.getElementById('chubLinkSearchName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('chubLinkSearchBtn')?.click();
    }
});

document.getElementById('chubLinkSearchCreator')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('chubLinkSearchBtn')?.click();
    }
});

on('chubLinkUrlBtn', 'click', () => {
    const url = document.getElementById('chubLinkUrlInput')?.value || '';
    if (url.trim()) {
        linkToChubUrl(url.trim());
    } else {
        showToast('Please enter a ChubAI URL', 'info');
    }
});

document.getElementById('chubLinkUrlInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('chubLinkUrlBtn')?.click();
    }
});

on('chubLinkViewInGalleryBtn', 'click', viewInChubGallery);
on('chubLinkGalleryBtn', 'click', downloadLinkedGallery);
on('chubLinkUnlinkBtn', 'click', unlinkFromChub);

// ==============================================
// Bulk ChubAI Link Feature
// ==============================================

let bulkChubLinkAborted = false;
let bulkChubLinkIsScanning = false;
let bulkChubLinkResults = {
    confident: [],   // { char, chubMatch, selected: true }
    uncertain: [],   // { char, chubOptions: [], selectedOption: null }
    nomatch: []      // { char }
};
// Track scan state for persistence across modal open/close
let bulkChubLinkScanState = {
    scannedAvatars: new Set(),  // Set of character avatars that have been scanned
    scanComplete: false,        // Whether the scan finished (vs was stopped)
    lastUnlinkedCount: 0        // Track if library changed since last scan
};

/**
 * Open the Bulk ChubAI Link modal - preserves state if reopening
 */
function openBulkChubLinkModal() {
    // Hide dropdown menu
    document.getElementById('moreOptionsMenu')?.classList.add('hidden');
    
    const modal = document.getElementById('bulkChubLinkModal');
    const scanningPhase = document.getElementById('bulkChubLinkScanning');
    const resultsPhase = document.getElementById('bulkChubLinkResults');
    const applyBtn = document.getElementById('bulkChubLinkApplyBtn');
    const cancelBtn = document.getElementById('bulkChubLinkCancelBtn');
    
    // Check if we have existing results to show
    const hasResults = bulkChubLinkResults.confident.length > 0 || 
                       bulkChubLinkResults.uncertain.length > 0 || 
                       bulkChubLinkResults.nomatch.length > 0;
    
    // Count current unlinked characters
    const currentUnlinkedCount = allCharacters.filter(char => {
        const chubInfo = getChubLinkInfo(char);
        return !chubInfo || !chubInfo.fullPath;
    }).length;
    
    // If library changed significantly, reset state
    if (bulkChubLinkScanState.lastUnlinkedCount !== currentUnlinkedCount && 
        Math.abs(bulkChubLinkScanState.lastUnlinkedCount - currentUnlinkedCount) > 5) {
        // Library changed significantly - reset
        bulkChubLinkResults = { confident: [], uncertain: [], nomatch: [] };
        bulkChubLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: 0 };
    }
    
    if (hasResults) {
        // We have existing results - show them
        modal.classList.remove('hidden');
        
        if (bulkChubLinkScanState.scanComplete || bulkChubLinkAborted) {
            // Scan was finished or stopped - show results directly
            showBulkChubLinkResults();
            
            // If scan was incomplete (stopped), offer to resume
            if (!bulkChubLinkScanState.scanComplete) {
                const remaining = currentUnlinkedCount - bulkChubLinkScanState.scannedAvatars.size;
                if (remaining > 0) {
                    cancelBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
                    cancelBtn.onclick = () => {
                        // Reset abort flag and resume scanning
                        bulkChubLinkAborted = false;
                        cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
                        cancelBtn.onclick = null; // Remove custom handler
                        
                        // Show scanning UI
                        scanningPhase.classList.remove('hidden');
                        resultsPhase.classList.add('hidden');
                        applyBtn.classList.add('hidden');
                        
                        runBulkChubLinkScan();
                    };
                }
            }
        } else if (bulkChubLinkIsScanning) {
            // Scan is still running - show scanning UI
            scanningPhase.classList.remove('hidden');
            resultsPhase.classList.add('hidden');
            applyBtn.classList.add('hidden');
            cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
        }
    } else {
        // Fresh start - reset everything
        bulkChubLinkAborted = false;
        bulkChubLinkResults = { confident: [], uncertain: [], nomatch: [] };
        bulkChubLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: currentUnlinkedCount };
        
        // Reset UI
        scanningPhase.classList.remove('hidden');
        resultsPhase.classList.add('hidden');
        applyBtn.classList.add('hidden');
        cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
        cancelBtn.onclick = null;
        
        document.getElementById('bulkChubLinkScanAvatar').src = '';
        document.getElementById('bulkChubLinkScanName').textContent = 'Preparing...';
        document.getElementById('bulkChubLinkScanStatus').textContent = 'Scanning library for unlinked characters...';
        document.getElementById('bulkChubLinkScanProgress').textContent = '0/0';
        document.getElementById('bulkChubLinkScanFill').style.width = '0%';
        document.getElementById('bulkChubLinkConfidentCount').textContent = '0';
        document.getElementById('bulkChubLinkUncertainCount').textContent = '0';
        document.getElementById('bulkChubLinkNoMatchCount').textContent = '0';
        
        modal.classList.remove('hidden');
        
        // Start scanning
        runBulkChubLinkScan();
    }
}

/**
 * Run the bulk ChubAI link scan
 */
async function runBulkChubLinkScan() {
    bulkChubLinkIsScanning = true;
    bulkChubLinkScanState.scanComplete = false;
    
    // Find all characters without a chub link
    const unlinkedChars = allCharacters.filter(char => {
        const chubInfo = getChubLinkInfo(char);
        return !chubInfo || !chubInfo.fullPath;
    });
    
    if (unlinkedChars.length === 0) {
        document.getElementById('bulkChubLinkScanStatus').textContent = 'All characters are already linked!';
        document.getElementById('bulkChubLinkCancelBtn').innerHTML = '<i class="fa-solid fa-check"></i> Done';
        bulkChubLinkIsScanning = false;
        bulkChubLinkScanState.scanComplete = true;
        return;
    }
    
    // Filter out characters we've already scanned (for resume functionality)
    const charsToScan = unlinkedChars.filter(char => !bulkChubLinkScanState.scannedAvatars.has(char.avatar));
    const alreadyScanned = unlinkedChars.length - charsToScan.length;
    const total = unlinkedChars.length;
    
    if (charsToScan.length === 0) {
        // All characters already scanned
        bulkChubLinkIsScanning = false;
        bulkChubLinkScanState.scanComplete = true;
        showBulkChubLinkResults();
        return;
    }
    
    // Update initial counts from existing results
    document.getElementById('bulkChubLinkConfidentCount').textContent = bulkChubLinkResults.confident.length;
    document.getElementById('bulkChubLinkUncertainCount').textContent = bulkChubLinkResults.uncertain.length;
    document.getElementById('bulkChubLinkNoMatchCount').textContent = bulkChubLinkResults.nomatch.length;
    
    for (let i = 0; i < charsToScan.length; i++) {
        if (bulkChubLinkAborted) break;
        
        const char = charsToScan[i];
        const charName = getCharacterName(char, 'Unknown');
        const charCreator = (char.creator || char.data?.creator || '').trim();
        
        const currentProgress = alreadyScanned + i + 1;
        
        // Update UI
        document.getElementById('bulkChubLinkScanAvatar').src = getCharacterAvatarUrl(char.avatar);
        document.getElementById('bulkChubLinkScanName').textContent = charName;
        document.getElementById('bulkChubLinkScanStatus').textContent = `Searching ChubAI for "${charName}"...`;
        document.getElementById('bulkChubLinkScanProgress').textContent = `${currentProgress}/${total}`;
        document.getElementById('bulkChubLinkScanFill').style.width = `${(currentProgress / total) * 100}%`;
        
        // Search Chub API
        const searchResults = await searchChubForBulkLink(charName, charCreator);
        
        // Mark this character as scanned
        bulkChubLinkScanState.scannedAvatars.add(char.avatar);
        
        if (searchResults.length === 0) {
            // No match found
            bulkChubLinkResults.nomatch.push({ char });
            document.getElementById('bulkChubLinkNoMatchCount').textContent = bulkChubLinkResults.nomatch.length;
        } else {
            // Sort results by content similarity for better ordering in review UI
            const sortedResults = sortChubResultsByContentSimilarity(searchResults, char);
            
            // Check for confident match
            const confidentMatch = findConfidentMatch(char, sortedResults);
            
            if (confidentMatch) {
                // Find the index of the confident match in sorted results
                const confidentIdx = sortedResults.findIndex(r => r.fullPath === confidentMatch.fullPath);
                bulkChubLinkResults.confident.push({
                    char,
                    chubMatch: confidentMatch,
                    chubOptions: sortedResults.slice(0, 5), // Store top 5 sorted by content similarity
                    selectedOption: confidentIdx >= 0 && confidentIdx < 5 ? confidentIdx : 0, // Pre-select the confident match
                    selected: true
                });
                document.getElementById('bulkChubLinkConfidentCount').textContent = bulkChubLinkResults.confident.length;
            } else {
                // Multiple options, needs review - sorted by content similarity
                bulkChubLinkResults.uncertain.push({
                    char,
                    chubOptions: sortedResults.slice(0, 5), // Top 5 sorted by content similarity
                    selectedOption: null
                });
                document.getElementById('bulkChubLinkUncertainCount').textContent = bulkChubLinkResults.uncertain.length;
            }
        }
        
        // Rate limiting - wait between requests
        if (!bulkChubLinkAborted) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }
    
    bulkChubLinkIsScanning = false;
    
    // Mark scan as complete only if we weren't aborted
    if (!bulkChubLinkAborted) {
        bulkChubLinkScanState.scanComplete = true;
    }
    
    // Show results (even if aborted, show what we found so far)
    if (bulkChubLinkResults.confident.length > 0 || bulkChubLinkResults.uncertain.length > 0 || bulkChubLinkResults.nomatch.length > 0) {
        showBulkChubLinkResults();
    } else {
        // Nothing found at all
        document.getElementById('bulkChubLinkScanStatus').textContent = bulkChubLinkAborted ? 'Scan stopped - no matches found yet' : 'Scan complete - no matches found';
        document.getElementById('bulkChubLinkCancelBtn').innerHTML = '<i class="fa-solid fa-times"></i> Close';
    }
}

/**
 * Search ChubAI for bulk linking
 * Uses multiple search strategies to find the character:
 * 1. If creator is known: search by username filter first
 * 2. Fall back to name + creator search term
 * 3. Finally try name-only search
 */
async function searchChubForBulkLink(name, creator) {
    try {
        const headers = getChubHeaders(true);
        
        let allResults = [];
        const normalizedName = name.toLowerCase().trim();
        const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 2);
        
        // Pass 1: If we have a creator, search by username filter first
        // This is the most reliable way to find a character by a specific author
        if (creator && creator.trim()) {
            const creatorLower = creator.toLowerCase().trim();
            const authorParams = new URLSearchParams({
                first: '200', // Get many results to find even less popular characters
                sort: 'download_count',
                nsfw: 'true',
                nsfl: 'true',
                include_forks: 'true',
                username: creatorLower
            });
            
            try {
                const authorResponse = await fetch(`${CHUB_API_BASE}/search?${authorParams.toString()}`, {
                    method: 'GET',
                    headers
                });
                
                if (authorResponse.ok) {
                    const authorData = await authorResponse.json();
                    const authorNodes = extractNodes(authorData);
                    
                    // Filter to characters whose name contains or is contained by our search name
                    // This handles "Ghost" matching "Ghost exorcism simulator"
                    for (const node of authorNodes) {
                        const nodeName = (node.name || '').toLowerCase().trim();
                        const nodeNameWords = nodeName.split(/\s+/).filter(w => w.length > 2);
                        
                        // Match if:
                        // 1. Exact match
                        // 2. Node name contains search name (e.g., "Ghost exorcism simulator" contains "Ghost")
                        // 3. Search name contains node name
                        // 4. First word matches (e.g., "Ghost" matches first word of "Ghost exorcism simulator")
                        // 5. Any significant word from search is in node name
                        const firstWordMatch = nodeNameWords.length > 0 && nameWords.length > 0 && 
                            (nodeNameWords[0] === nameWords[0] || nodeNameWords[0].startsWith(nameWords[0]) || nameWords[0].startsWith(nodeNameWords[0]));
                        const anyWordMatch = nameWords.some(w => nodeName.includes(w));
                        
                        if (nodeName === normalizedName || 
                            nodeName.includes(normalizedName) ||
                            normalizedName.includes(nodeName) ||
                            firstWordMatch ||
                            anyWordMatch) {
                            allResults.push(node);
                        }
                    }
                    
                    if (allResults.length > 0) {
                        debugLog(`[BulkChubLink] Found ${allResults.length} matches for "${name}" by author "${creator}"`);
                        return allResults;
                    }
                }
            } catch (e) {
                debugLog('[BulkChubLink] Author search failed, falling back to term search');
            }
        }
        
        // Pass 2: Combined name + creator search term
        const searchTerm = creator ? `${name} ${creator}` : name;
        
        const params = new URLSearchParams({
            search: searchTerm,
            first: '10',
            sort: 'download_count',
            nsfw: 'true',
            nsfl: 'true',
            include_forks: 'true',
            min_tokens: '50'
        });
        
        const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) return allResults;
        
        const data = await response.json();
        const nodes = extractNodes(data);
        
        // Add any nodes not already in results
        for (const node of nodes) {
            if (!allResults.some(r => r.fullPath === node.fullPath)) {
                allResults.push(node);
            }
        }
        
        // Pass 3: If still no results and we have a creator, try name-only search
        if (allResults.length === 0 && creator) {
            const nameOnlyParams = new URLSearchParams({
                search: name,
                first: '15',
                sort: 'download_count',
                nsfw: 'true',
                nsfl: 'true',
                include_forks: 'true',
                min_tokens: '50'
            });
            
            const nameResponse = await fetch(`${CHUB_API_BASE}/search?${nameOnlyParams.toString()}`, {
                method: 'GET',
                headers
            });
            
            if (nameResponse.ok) {
                const nameData = await nameResponse.json();
                allResults = extractNodes(nameData);
            }
        }
        
        return allResults;
    } catch (error) {
        console.error('[BulkChubLink] Search error:', error);
        return [];
    }
}

/**
 * Common/generic creators that shouldn't be trusted for matching
 */
const GENERIC_CREATORS = new Set([
    'anonymous', 'anon', 'unknown', 'user', 'admin', 'test', 
    'guest', '', 'none', 'na', 'n/a', 'character'
]);

/**
 * Sort ChubAI search results by content similarity to a local character
 * Results with higher content similarity appear first
 * @param {Array} results - ChubAI search results from API
 * @param {Object} localChar - Local character to compare against
 * @returns {Array} - Results sorted by content similarity (descending)
 */
function sortChubResultsByContentSimilarity(results, localChar) {
    if (!localChar || !results || results.length === 0) return results;
    
    const charDescription = getCharField(localChar, 'description') || '';
    const charCreatorNotes = getCharField(localChar, 'creator_notes') || '';
    const charFirstMes = getCharField(localChar, 'first_mes') || '';
    const charName = getCharacterName(localChar, '').toLowerCase().trim();
    const charCreator = (localChar.creator || localChar.data?.creator || '').toLowerCase().trim();
    const charNameWords = charName.split(/\s+/).filter(w => w.length > 2);
    
    // Combine local content for matching
    const localContent = `${charDescription} ${charCreatorNotes} ${charFirstMes}`.trim();
    const hasLocalContent = localContent.length > 100;
    
    // Calculate scores for each result
    const scoredResults = results.map(result => {
        const chubName = (result.name || '').toLowerCase().trim();
        const chubCreator = (result.fullPath || '').split('/')[0].toLowerCase().trim();
        const chubTagline = result.tagline || '';
        const chubDescription = result.description || result.tagline || '';
        const chubNameWords = chubName.split(/\s+/).filter(w => w.length > 2);
        
        // Combine chub content
        const chubContent = `${chubDescription} ${chubTagline}`.trim();
        
        let score = 0;
        let matchReasons = [];
        
        // === NAME MATCHING (important for finding the right character) ===
        
        // Exact name match gets biggest boost
        if (chubName === charName) {
            score += 100;
            matchReasons.push('exact name');
        }
        // ChubAI name STARTS with local name (e.g., "Ghost Exorcism Simulator" starts with "Ghost")
        else if (chubName.startsWith(charName + ' ') || chubName.startsWith(charName + ':') || chubName.startsWith(charName + ',')) {
            score += 90;
            matchReasons.push('name prefix');
        }
        // First word exact match (e.g., "Ghost" = first word of "Ghost Exorcism Simulator")
        else if (chubNameWords.length > 0 && charNameWords.length > 0 && chubNameWords[0] === charNameWords[0]) {
            score += 85;
            matchReasons.push('first word');
        }
        // Local name is contained in ChubAI name
        else if (chubName.includes(charName) && charName.length > 3) {
            score += 75;
            matchReasons.push('name in title');
        }
        // Any significant word from local name is in ChubAI name
        else if (charNameWords.length > 0 && charNameWords.some(w => chubName.includes(w))) {
            score += 60;
            matchReasons.push('word match');
        }
        
        // === CREATOR MATCHING ===
        if (charCreator && chubCreator === charCreator) {
            score += 50;
            matchReasons.push('creator');
        }
        
        // === CONTENT SIMILARITY (heavily weighted - this is the best signal!) ===
        if (hasLocalContent && chubContent.length > 50) {
            // Compare description to description
            const descToDescSim = calculateTextSimilarity(charDescription, chubDescription);
            
            // Compare description to tagline (often very useful)
            const descToTaglineSim = calculateTextSimilarity(charDescription, chubTagline);
            
            // Compare creator_notes to tagline (creators often put tagline in notes)
            const notesToTaglineSim = charCreatorNotes ? calculateTextSimilarity(charCreatorNotes, chubTagline) : 0;
            
            // Compare creator_notes to description
            const notesToDescSim = charCreatorNotes ? calculateTextSimilarity(charCreatorNotes, chubDescription) : 0;
            
            // Compare first_mes to description (can help identify unique characters)
            const firstMesToDescSim = charFirstMes ? calculateTextSimilarity(charFirstMes, chubDescription) : 0;
            
            // Full content comparison
            const fullContentSim = calculateTextSimilarity(localContent, chubContent);
            
            // Take the best match from all comparisons
            const bestContentMatch = Math.max(
                descToDescSim, 
                descToTaglineSim, 
                notesToTaglineSim, 
                notesToDescSim,
                firstMesToDescSim,
                fullContentSim
            );
            
            // Content similarity is HUGE - up to 100 points for high match
            // This helps when names don't match but content clearly does
            if (bestContentMatch >= 0.5) {
                score += bestContentMatch * 100; // 50-100 points for good content match
                matchReasons.push(`${Math.round(bestContentMatch * 100)}% content`);
            } else if (bestContentMatch >= 0.25) {
                score += bestContentMatch * 60; // 15-30 points for partial content match
                matchReasons.push(`${Math.round(bestContentMatch * 100)}% content`);
            } else if (bestContentMatch > 0.1) {
                score += bestContentMatch * 30; // Small boost for weak match
            }
        }
        
        // Keep original API order as tiebreaker (download count)
        score += (results.length - results.indexOf(result)) * 0.01;
        
        return { result, score, matchReasons };
    });
    
    // Sort by score descending
    scoredResults.sort((a, b) => b.score - a.score);
    
    // Debug log for top results
    if (scoredResults.length > 0 && scoredResults[0].score > 50) {
        debugLog(`[ChubSearch] Top match: "${scoredResults[0].result.name}" (score: ${scoredResults[0].score.toFixed(1)}, reasons: ${scoredResults[0].matchReasons.join(', ')})`);
    }
    
    return scoredResults.map(s => s.result);
}

/**
 * Calculate word set similarity (Jaccard index) between two texts
 * Wrapper for contentSimilarity used in ChubAI matching
 */
function calculateTextSimilarity(textA, textB) {
    return contentSimilarity(textA, textB);
}

/**
 * Find a confident match for a character
 * Uses name, creator, and content similarity for matching
 * Handles generic creators like "Anonymous" by requiring content match
 */
function findConfidentMatch(char, searchResults) {
    const charName = getCharacterName(char, '').toLowerCase().trim();
    const charCreator = (char.creator || char.data?.creator || '').toLowerCase().trim();
    const charDescription = getCharField(char, 'description') || '';
    const charFirstMes = getCharField(char, 'first_mes') || '';
    const charPersonality = getCharField(char, 'personality') || '';
    
    // Combine content for matching
    const charContent = `${charDescription} ${charFirstMes} ${charPersonality}`.trim();
    
    // Is creator generic/untrustworthy?
    const isGenericCreator = GENERIC_CREATORS.has(charCreator);
    
    for (const result of searchResults) {
        const chubName = (result.name || '').toLowerCase().trim();
        const chubCreator = (result.fullPath || '').split('/')[0].toLowerCase().trim();
        const chubTagline = result.tagline || '';
        const chubDescription = result.description || result.tagline || '';
        const chubTokens = result.nTokens || result.n_tokens || 0;
        
        // Exact name match is always required
        if (chubName !== charName) continue;
        
        // Calculate content similarity using tagline/description from search results
        const contentSimilarity = calculateTextSimilarity(charDescription, chubDescription);
        const taglineSimilarity = calculateTextSimilarity(charDescription, chubTagline);
        const bestContentSimilarity = Math.max(contentSimilarity, taglineSimilarity);
        
        // Case 1: Generic creator (like "Anonymous") - require content match
        if (isGenericCreator || GENERIC_CREATORS.has(chubCreator)) {
            // For generic creators, require significant content similarity
            if (bestContentSimilarity >= 0.4) {
                debugLog(`[BulkChubLink] Content match for "${charName}": ${(bestContentSimilarity * 100).toFixed(1)}% similarity`);
                return result;
            }
            // Or if it's the top result with matching generic creator and high download count
            if (chubCreator === charCreator && searchResults.indexOf(result) === 0 && (result.downloadCount || result.starCount || 0) > 100) {
                debugLog(`[BulkChubLink] Top popular result match for "${charName}" by generic creator`);
                return result;
            }
            continue;
        }
        
        // Case 2: Specific creator - creator match is sufficient
        if (charCreator && chubCreator === charCreator) {
            debugLog(`[BulkChubLink] Creator match for "${charName}" by ${charCreator}`);
            return result;
        }
        
        // Case 3: No local creator but chub has one - use content + position
        if (!charCreator && searchResults.indexOf(result) === 0) {
            // Top result with good content match
            if (bestContentSimilarity >= 0.3) {
                debugLog(`[BulkChubLink] Top result with content match for "${charName}": ${(bestContentSimilarity * 100).toFixed(1)}%`);
                return result;
            }
        }
    }
    
    return null;
}

/**
 * Show the results phase
 */
function showBulkChubLinkResults() {
    const scanningPhase = document.getElementById('bulkChubLinkScanning');
    const resultsPhase = document.getElementById('bulkChubLinkResults');
    const applyBtn = document.getElementById('bulkChubLinkApplyBtn');
    const cancelBtn = document.getElementById('bulkChubLinkCancelBtn');
    
    scanningPhase.classList.add('hidden');
    resultsPhase.classList.remove('hidden');
    applyBtn.classList.remove('hidden');
    
    // Check if scan was incomplete (stopped early)
    const unlinkedCount = allCharacters.filter(char => {
        const chubInfo = getChubLinkInfo(char);
        return !chubInfo || !chubInfo.fullPath;
    }).length;
    const remaining = unlinkedCount - bulkChubLinkScanState.scannedAvatars.size;
    
    if (!bulkChubLinkScanState.scanComplete && remaining > 0) {
        // Scan was stopped - offer resume option
        cancelBtn.innerHTML = `<i class="fa-solid fa-play"></i> Resume (${remaining} left)`;
        cancelBtn.onclick = () => {
            bulkChubLinkAborted = false;
            cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
            cancelBtn.onclick = null;
            
            scanningPhase.classList.remove('hidden');
            resultsPhase.classList.add('hidden');
            applyBtn.classList.add('hidden');
            
            runBulkChubLinkScan();
        };
    } else {
        cancelBtn.innerHTML = '<i class="fa-solid fa-times"></i> Close';
        cancelBtn.onclick = null;
    }
    
    // Update tab counts
    document.getElementById('bulkChubLinkConfidentTabCount').textContent = bulkChubLinkResults.confident.length;
    document.getElementById('bulkChubLinkUncertainTabCount').textContent = bulkChubLinkResults.uncertain.length;
    document.getElementById('bulkChubLinkNoMatchTabCount').textContent = bulkChubLinkResults.nomatch.length;
    
    // Render lists
    renderBulkChubLinkConfidentList();
    renderBulkChubLinkUncertainList();
    renderBulkChubLinkNoMatchList();
    
    // Update selected count
    updateBulkChubLinkSelectedCount();
    
    // Show confident tab by default
    switchBulkChubLinkTab('confident');
}

/**
 * Render the confident matches list
 */
function renderBulkChubLinkConfidentList() {
    const container = document.getElementById('bulkChubLinkConfidentList');
    
    if (bulkChubLinkResults.confident.length === 0) {
        container.innerHTML = '<div class="bulk-chub-link-empty"><i class="fa-solid fa-search"></i>No confident matches found</div>';
        return;
    }
    
    container.innerHTML = bulkChubLinkResults.confident.map((item, idx) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = item.char.creator || item.char.data?.creator || '';
        const selectedOpt = item.chubOptions[item.selectedOption] || item.chubMatch;
        const selectedAvatarUrl = selectedOpt.avatar_url || `${CHUB_AVATAR_BASE}${selectedOpt.fullPath}/avatar`;
        
        // Build options HTML
        let optionsHtml = item.chubOptions.map((opt, optIdx) => {
            const optAvatarUrl = opt.avatar_url || `${CHUB_AVATAR_BASE}${opt.fullPath}/avatar`;
            const isSelected = item.selectedOption === optIdx;
            const isConfidentMatch = opt.fullPath === item.chubMatch.fullPath;
            const stars = opt.starCount || 0;
            const rating = opt.rating ? opt.rating.toFixed(1) : 'N/A';
            
            return `
                <div class="bulk-chub-link-option${isSelected ? ' selected' : ''}" onclick="selectBulkChubLinkConfidentOption(${idx}, ${optIdx})">
                    <img src="${optAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-chub-link-option-info">
                        <span class="bulk-chub-link-option-name">${escapeHtml(opt.name || opt.fullPath.split('/').pop())}${isConfidentMatch ? ' <span class="confident-badge">Exact Match</span>' : ''}</span>
                        <span class="bulk-chub-link-option-path">${escapeHtml(opt.fullPath)}</span>
                    </div>
                    <span class="bulk-chub-link-option-stats"><i class="fa-solid fa-star"></i> ${rating} | <i class="fa-solid fa-heart"></i> ${stars}</span>
                </div>
            `;
        }).join('');
        
        return `
            <div class="bulk-chub-link-item bulk-chub-link-item-confident${item.selected ? ' selected' : ''}" data-type="confident" data-idx="${idx}">
                <div class="bulk-chub-link-item-confident-header" onclick="toggleBulkChubLinkConfidentExpand(${idx})">
                    <input type="checkbox" class="bulk-chub-link-item-checkbox" ${item.selected ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleBulkChubLinkItem('confident', ${idx})">
                    <div class="bulk-chub-link-item-local">
                        <img src="${getCharacterAvatarUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-chub-link-item-local-info">
                            <span class="bulk-chub-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                            <span class="bulk-chub-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                        </div>
                    </div>
                    <i class="fa-solid fa-arrow-right bulk-chub-link-item-arrow"></i>
                    <div class="bulk-chub-link-item-chub">
                        <img src="${selectedAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-chub-link-item-chub-info">
                            <span class="bulk-chub-link-item-chub-name">${escapeHtml(selectedOpt.name || selectedOpt.fullPath.split('/').pop())}</span>
                            <span class="bulk-chub-link-item-chub-path">${escapeHtml(selectedOpt.fullPath)}</span>
                        </div>
                    </div>
                    <span class="bulk-chub-link-item-confidence high">Exact Match</span>
                    <i class="fa-solid fa-chevron-down expand-icon"></i>
                </div>
                <div class="bulk-chub-link-item-options">
                    ${optionsHtml}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the uncertain matches list
 */
function renderBulkChubLinkUncertainList() {
    const container = document.getElementById('bulkChubLinkUncertainList');
    
    if (bulkChubLinkResults.uncertain.length === 0) {
        container.innerHTML = '<div class="bulk-chub-link-empty"><i class="fa-solid fa-check-circle"></i>No uncertain matches</div>';
        return;
    }
    
    container.innerHTML = bulkChubLinkResults.uncertain.map((item, idx) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = item.char.creator || item.char.data?.creator || '';
        const hasSelection = item.selectedOption !== null;
        
        let optionsHtml = item.chubOptions.map((opt, optIdx) => {
            const optAvatarUrl = opt.avatar_url || `${CHUB_AVATAR_BASE}${opt.fullPath}/avatar`;
            const isSelected = item.selectedOption === optIdx;
            const stars = opt.starCount || 0;
            const rating = opt.rating ? opt.rating.toFixed(1) : 'N/A';
            
            return `
                <div class="bulk-chub-link-option${isSelected ? ' selected' : ''}" onclick="selectBulkChubLinkOption(${idx}, ${optIdx})">
                    <img src="${optAvatarUrl}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-chub-link-option-info">
                        <span class="bulk-chub-link-option-name">${escapeHtml(opt.name || opt.fullPath.split('/').pop())}</span>
                        <span class="bulk-chub-link-option-path">${escapeHtml(opt.fullPath)}</span>
                    </div>
                    <span class="bulk-chub-link-option-stats"><i class="fa-solid fa-star"></i> ${rating} | <i class="fa-solid fa-heart"></i> ${stars}</span>
                </div>
            `;
        }).join('');
        
        return `
            <div class="bulk-chub-link-item bulk-chub-link-item-uncertain${hasSelection ? ' selected' : ''}" data-type="uncertain" data-idx="${idx}">
                <div class="bulk-chub-link-item-uncertain-header" onclick="toggleBulkChubLinkExpand(${idx})">
                    <input type="checkbox" class="bulk-chub-link-item-checkbox" ${hasSelection ? 'checked' : ''} onclick="event.stopPropagation()" onchange="clearBulkChubLinkSelection(${idx})">
                    <div class="bulk-chub-link-item-local">
                        <img src="${getCharacterAvatarUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                        <div class="bulk-chub-link-item-local-info">
                            <span class="bulk-chub-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                            <span class="bulk-chub-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                        </div>
                    </div>
                    <i class="fa-solid fa-arrow-right bulk-chub-link-item-arrow"></i>
                    <div class="bulk-chub-link-item-chub">
                        ${hasSelection 
                            ? `<span>${escapeHtml(item.chubOptions[item.selectedOption].fullPath)}</span>` 
                            : `<span style="color: var(--text-muted);">${item.chubOptions.length} possible matches - click to select</span>`
                        }
                    </div>
                    <span class="bulk-chub-link-item-confidence medium">${item.chubOptions.length} Options</span>
                    <i class="fa-solid fa-chevron-down expand-icon"></i>
                </div>
                <div class="bulk-chub-link-item-options">
                    ${optionsHtml}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the no match list
 */
function renderBulkChubLinkNoMatchList() {
    const container = document.getElementById('bulkChubLinkNoMatchList');
    
    if (bulkChubLinkResults.nomatch.length === 0) {
        container.innerHTML = '<div class="bulk-chub-link-empty"><i class="fa-solid fa-check-circle"></i>All characters had potential matches!</div>';
        return;
    }
    
    container.innerHTML = bulkChubLinkResults.nomatch.map((item) => {
        const charName = getCharacterName(item.char, 'Unknown');
        const charCreator = item.char.creator || item.char.data?.creator || '';
        
        return `
            <div class="bulk-chub-link-item bulk-chub-link-item-nomatch">
                <div class="bulk-chub-link-item-local">
                    <img src="${getCharacterAvatarUrl(item.char.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/></svg>'">
                    <div class="bulk-chub-link-item-local-info">
                        <span class="bulk-chub-link-item-local-name" title="${escapeHtml(charName)}">${escapeHtml(charName)}</span>
                        <span class="bulk-chub-link-item-local-creator">${charCreator ? 'by ' + escapeHtml(charCreator) : 'No creator'}</span>
                    </div>
                </div>
                <i class="fa-solid fa-arrow-right bulk-chub-link-item-arrow" style="opacity: 0.3;"></i>
                <div class="bulk-chub-link-item-chub">
                    <span><i class="fa-solid fa-times-circle"></i> No matches found on ChubAI</span>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Toggle confident item selection
 */
window.toggleBulkChubLinkItem = function(type, idx) {
    if (type === 'confident') {
        bulkChubLinkResults.confident[idx].selected = !bulkChubLinkResults.confident[idx].selected;
        renderBulkChubLinkConfidentList();
    }
    updateBulkChubLinkSelectedCount();
};

/**
 * Toggle confident item expansion
 */
window.toggleBulkChubLinkConfidentExpand = function(idx) {
    const items = document.querySelectorAll('.bulk-chub-link-item-confident');
    items[idx]?.classList.toggle('expanded');
};

/**
 * Select an option for confident item
 */
window.selectBulkChubLinkConfidentOption = function(itemIdx, optionIdx) {
    bulkChubLinkResults.confident[itemIdx].selectedOption = optionIdx;
    bulkChubLinkResults.confident[itemIdx].selected = true;
    renderBulkChubLinkConfidentList();
    updateBulkChubLinkSelectedCount();
};

/**
 * Toggle uncertain item expansion
 */
window.toggleBulkChubLinkExpand = function(idx) {
    const items = document.querySelectorAll('.bulk-chub-link-item-uncertain');
    items[idx]?.classList.toggle('expanded');
};

/**
 * Select an option for uncertain item
 */
window.selectBulkChubLinkOption = function(itemIdx, optionIdx) {
    bulkChubLinkResults.uncertain[itemIdx].selectedOption = optionIdx;
    renderBulkChubLinkUncertainList();
    updateBulkChubLinkSelectedCount();
};

/**
 * Clear selection for uncertain item
 */
window.clearBulkChubLinkSelection = function(idx) {
    const checkbox = event.target;
    if (!checkbox.checked) {
        bulkChubLinkResults.uncertain[idx].selectedOption = null;
        renderBulkChubLinkUncertainList();
        updateBulkChubLinkSelectedCount();
    }
};

/**
 * Switch between tabs
 */
window.switchBulkChubLinkTab = function(tabName) {
    debugLog('[BulkChubLink] Switching to tab:', tabName);
    
    // Update tab buttons
    document.querySelectorAll('.bulk-chub-link-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update lists - show only the selected one using display style
    const confidentList = document.getElementById('bulkChubLinkConfidentList');
    const uncertainList = document.getElementById('bulkChubLinkUncertainList');
    const nomatchList = document.getElementById('bulkChubLinkNoMatchList');
    
    if (confidentList) confidentList.style.display = tabName === 'confident' ? 'flex' : 'none';
    if (uncertainList) uncertainList.style.display = tabName === 'uncertain' ? 'flex' : 'none';
    if (nomatchList) nomatchList.style.display = tabName === 'nomatch' ? 'flex' : 'none';
    
    // Show/hide actions bar (only for confident tab)
    const actionsBar = document.getElementById('bulkChubLinkConfidentActions');
    if (actionsBar) {
        actionsBar.style.display = tabName === 'confident' ? 'flex' : 'none';
    }
};

/**
 * Select all confident matches
 */
window.bulkChubLinkSelectAll = function() {
    bulkChubLinkResults.confident.forEach(item => item.selected = true);
    renderBulkChubLinkConfidentList();
    updateBulkChubLinkSelectedCount();
};

/**
 * Deselect all confident matches
 */
window.bulkChubLinkDeselectAll = function() {
    bulkChubLinkResults.confident.forEach(item => item.selected = false);
    renderBulkChubLinkConfidentList();
    updateBulkChubLinkSelectedCount();
};

/**
 * Update selected count
 */
function updateBulkChubLinkSelectedCount() {
    const confidentSelected = bulkChubLinkResults.confident.filter(i => i.selected).length;
    const uncertainSelected = bulkChubLinkResults.uncertain.filter(i => i.selectedOption !== null).length;
    const total = confidentSelected + uncertainSelected;
    
    document.getElementById('bulkChubLinkSelectedCount').textContent = total;
    
    // Disable apply button if nothing selected
    const applyBtn = document.getElementById('bulkChubLinkApplyBtn');
    applyBtn.disabled = total === 0;
}

/**
 * Apply the selected links
 */
async function applyBulkChubLinks() {
    const applyBtn = document.getElementById('bulkChubLinkApplyBtn');
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Linking...';
    
    let successCount = 0;
    let errorCount = 0;
    
    try {
        // Process confident matches
        for (const item of bulkChubLinkResults.confident) {
            if (!item.selected) continue;
            
            // Use the selected option (which may have been changed by user)
            const selectedChub = item.chubOptions[item.selectedOption] || item.chubMatch;
            
            try {
                // Need to fetch ID if we don't have it
                let chubId = selectedChub.id;
                if (!chubId) {
                    const metadata = await fetchChubMetadata(selectedChub.fullPath);
                    chubId = metadata?.id;
                }
                
                debugLog('[BulkChubLink] Linking', item.char.name, 'to', selectedChub.fullPath);
                await saveChubLink(item.char, {
                    id: chubId,
                    fullPath: selectedChub.fullPath
                });
                successCount++;
                debugLog('[BulkChubLink] Successfully linked', item.char.name);
            } catch (err) {
                console.error('[BulkChubLink] Link error for', item.char.name, ':', err);
                errorCount++;
            }
            
            // Small delay to avoid hammering the API
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Process uncertain matches with selections
        for (const item of bulkChubLinkResults.uncertain) {
            if (item.selectedOption === null) continue;
            
            const selectedChub = item.chubOptions[item.selectedOption];
            
            try {
                let chubId = selectedChub.id;
                if (!chubId) {
                    const metadata = await fetchChubMetadata(selectedChub.fullPath);
                    chubId = metadata?.id;
                }
                
                debugLog('[BulkChubLink] Linking', item.char.name, 'to', selectedChub.fullPath);
                await saveChubLink(item.char, {
                    id: chubId,
                    fullPath: selectedChub.fullPath
                });
                successCount++;
                debugLog('[BulkChubLink] Successfully linked', item.char.name);
            } catch (err) {
                console.error('[BulkChubLink] Link error for', item.char.name, ':', err);
                errorCount++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch (outerErr) {
        console.error('[BulkChubLink] Outer error:', outerErr);
    }
    
    // Show result
    if (errorCount > 0) {
        showToast(`Linked ${successCount} characters (${errorCount} errors)`, 'info');
    } else if (successCount > 0) {
        showToast(`Successfully linked ${successCount} characters to ChubAI!`, 'success');
    } else {
        showToast('No characters were linked', 'info');
    }
    
    // Close modal
    document.getElementById('bulkChubLinkModal').classList.add('hidden');
    
    // Reset state since we linked characters - they're no longer in the unlinked pool
    bulkChubLinkResults = { confident: [], uncertain: [], nomatch: [] };
    bulkChubLinkScanState = { scannedAvatars: new Set(), scanComplete: false, lastUnlinkedCount: 0 };
    
    // Rebuild lookup
    buildLocalLibraryLookup();
    
    // Reset button state in case modal is reopened
    applyBtn.disabled = false;
    applyBtn.innerHTML = '<i class="fa-solid fa-link"></i> Link Selected (<span id="bulkChubLinkSelectedCount">0</span>)';
}

// Event handlers for Bulk ChubAI Link
document.getElementById('bulkChubLinkBtn')?.addEventListener('click', openBulkChubLinkModal);
document.getElementById('closeBulkChubLinkModal')?.addEventListener('click', () => {
    // Just set abort flag and close - state is preserved for resuming
    bulkChubLinkAborted = true;
    document.getElementById('bulkChubLinkModal').classList.add('hidden');
});
document.getElementById('bulkChubLinkCancelBtn')?.addEventListener('click', () => {
    // If we're in scanning phase, just stop (let the scan loop show results)
    // If we're in results phase, close the modal
    const resultsPhase = document.getElementById('bulkChubLinkResults');
    if (resultsPhase && !resultsPhase.classList.contains('hidden')) {
        // Results phase - close modal
        document.getElementById('bulkChubLinkModal').classList.add('hidden');
    } else {
        // Scanning phase - just set abort flag, scan loop will handle showing results
        bulkChubLinkAborted = true;
        document.getElementById('bulkChubLinkScanStatus').textContent = 'Stopping...';
    }
});
document.getElementById('bulkChubLinkApplyBtn')?.addEventListener('click', applyBulkChubLinks);

// ==============================================
// Help & Tips Modal
// ==============================================

function openGalleryInfoModal() {
    document.getElementById('galleryInfoModal').classList.remove('hidden');
}

document.getElementById('galleryInfoBtn')?.addEventListener('click', openGalleryInfoModal);
document.getElementById('closeGalleryInfoModal')?.addEventListener('click', () => {
    document.getElementById('galleryInfoModal').classList.add('hidden');
});
document.getElementById('closeGalleryInfoModalBtn')?.addEventListener('click', () => {
    document.getElementById('galleryInfoModal').classList.add('hidden');
});

// ==============================================
// Media Localization Feature
// ==============================================

/**
 * Download embedded media for a character (core function used by both localize button and import summary)
 * @param {string} folderName - The gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {string[]} mediaUrls - Array of URLs to download
 * @param {Object} options - Optional callbacks for progress/logging
 * @returns {Promise<{success: number, skipped: number, errors: number, renamed: number}>}
 */
async function downloadEmbeddedMediaForCharacter(folderName, mediaUrls, options = {}) {
    const { onProgress, onLog, onLogUpdate, shouldAbort, abortSignal } = options;
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let renamedCount = 0;
    
    if (!mediaUrls || mediaUrls.length === 0) {
        return { success: 0, skipped: 0, errors: 0, renamed: 0, aborted: false };
    }
    
    // Get existing files and their hashes to check for duplicates BEFORE downloading
    const existingHashMap = await getExistingFileHashes(folderName);
    debugLog(`[EmbeddedMedia] Found ${existingHashMap.size} existing file hashes for ${folderName}`);
    
    let startIndex = Date.now(); // Use timestamp as start index for unique filenames
    
    for (let i = 0; i < mediaUrls.length; i++) {
        // Check for abort signal
        if ((shouldAbort && shouldAbort()) || abortSignal?.aborted) {
            return { success: successCount, skipped: skippedCount, errors: errorCount, renamed: renamedCount, aborted: true };
        }
        
        const url = mediaUrls[i];
        const fileIndex = startIndex + i;
        
        // Truncate URL for display
        const displayUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;
        const logEntry = onLog ? onLog(`Checking ${displayUrl}`, 'pending') : null;
        
        // Download to memory first to check hash (with 30s timeout)
        let downloadResult = await downloadMediaToMemory(url, 30000, abortSignal);
        
        if (!downloadResult.success) {
            errorCount++;
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Failed: ${displayUrl} - ${downloadResult.error}`, 'error');
            downloadResult = null;
            if (onProgress) onProgress(i + 1, mediaUrls.length);
            continue;
        }
        
        // Calculate hash of downloaded content
        const contentHash = await calculateHash(downloadResult.arrayBuffer);
        
        // Check if this file already exists
        const existingFile = existingHashMap.get(contentHash);
        if (existingFile) {
            // File exists - check if we should rename it
            // Always rename chubgallery_* files to localized_media_* (embedded takes precedence)
            // Also rename files that don't follow localized_media_* naming convention
            // Also rename if extension doesn't match actual content type (fixes corrupted files)
            const isChubGalleryFile = existingFile.fileName.startsWith('chubgallery_');
            const isAlreadyLocalized = existingFile.fileName.startsWith('localized_media_');
            
            // Check if extension matches detected content type
            let hasWrongExtension = false;
            if (downloadResult.contentType && isAlreadyLocalized) {
                const currentExt = existingFile.fileName.includes('.') 
                    ? existingFile.fileName.substring(existingFile.fileName.lastIndexOf('.') + 1).toLowerCase()
                    : '';
                const expectedExtMap = {
                    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
                    'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                    'video/mp4': 'mp4', 'video/webm': 'webm',
                    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
                    'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a'
                };
                const expectedExt = expectedExtMap[downloadResult.contentType];
                // Check if current extension mismatches expected (e.g., audio saved as .png)
                if (expectedExt && currentExt !== expectedExt) {
                    // Special case: jpg vs jpeg are equivalent
                    if (!(currentExt === 'jpeg' && expectedExt === 'jpg') && !(currentExt === 'jpg' && expectedExt === 'jpeg')) {
                        hasWrongExtension = true;
                        debugLog(`[EmbeddedMedia] Extension mismatch: ${existingFile.fileName} has .${currentExt} but content is ${downloadResult.contentType} (should be .${expectedExt})`);
                    }
                }
            }
            
            const needsRename = isChubGalleryFile || !isAlreadyLocalized || hasWrongExtension;
            
            if (needsRename) {
                // Rename to proper localized_media_* format (pass downloadResult since we have it)
                const renameResult = await renameToLocalizedFormat(existingFile, url, folderName, fileIndex, downloadResult);
                downloadResult = null; // Release after rename
                if (renameResult.success) {
                    renamedCount++;
                    const action = isChubGalleryFile ? 'Converted' : (hasWrongExtension ? 'Fixed extension' : 'Renamed');
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `${action}: ${existingFile.fileName} → ${renameResult.newName}`, 'success');
                } else {
                    skippedCount++;
                    if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (rename failed): ${displayUrl}`, 'success');
                }
            } else {
                skippedCount++;
                downloadResult = null; // Release — already localized, no action needed
                if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Skipped (already localized): ${displayUrl}`, 'success');
            }
            debugLog(`[EmbeddedMedia] Duplicate found: ${url} -> ${existingFile.fileName}`);
            if (onProgress) onProgress(i + 1, mediaUrls.length);
            continue;
        }
        
        // Not a duplicate, save the file
        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Saving ${displayUrl}...`, 'pending');
        const result = await saveMediaFromMemory(downloadResult, url, folderName, fileIndex);
        downloadResult = null; // Release after save
        
        if (result.success) {
            successCount++;
            // Add to hash map to avoid downloading same file twice in this session
            existingHashMap.set(contentHash, { fileName: result.filename, localPath: result.localPath });
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Saved: ${result.filename}`, 'success');
        } else {
            errorCount++;
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Failed: ${displayUrl} - ${result.error}`, 'error');
        }
        
        if (onProgress) onProgress(i + 1, mediaUrls.length);
        
        // Yield to browser for GC between media uploads (critical for mobile)
        await new Promise(r => setTimeout(r, 50));
    }
    
    return { success: successCount, skipped: skippedCount, errors: errorCount, renamed: renamedCount, aborted: false };
}

/**
 * Rename an existing file to localized_media_* format
 * Since there's no rename API, we delete old + save new (data already in memory)
 * @param {Object} existingFile - Existing file info
 * @param {string} originalUrl - Original URL of the media
 * @param {string} folderName - Gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {number} index - File index for naming
 * @param {Object} downloadResult - Result from downloadMediaToMemory
 */
async function renameToLocalizedFormat(existingFile, originalUrl, folderName, index, downloadResult) {
    try {
        // Save with new name using saveMediaFromMemory which determines correct extension
        // from the detected content type (via magic bytes), not the old filename
        const saveResult = await saveMediaFromMemory(downloadResult, originalUrl, folderName, index);
        
        if (!saveResult.success) {
            return { success: false, error: saveResult.error };
        }
        
        // Delete the old file - API expects full relative path like "/user/images/CharName/file.png"
        const safeFolderName = sanitizeFolderName(folderName);
        const deletePath = `/user/images/${safeFolderName}/${existingFile.fileName}`;
        const deleteResponse = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
            path: deletePath
        });
        
        if (!deleteResponse.ok) {
            console.warn(`[EmbeddedMedia] Could not delete old file ${existingFile.fileName} (path: ${deletePath}), but new file was saved`);
        } else {
            debugLog(`[EmbeddedMedia] Deleted old file: ${deletePath}`);
        }
        
        return { success: true, newName: saveResult.filename };
    } catch (error) {
        console.error('[EmbeddedMedia] Rename error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Extract image/media URLs from text content
 */
function extractMediaUrls(text) {
    if (!text) return [];
    
    const urls = [];
    
    // Match ![](url) markdown format - stop at whitespace or ) to exclude sizing params
    // Supports: ![alt](url), ![alt](url =WxH), ![alt](url "title")
    const markdownPattern = /!\[.*?\]\((https?:\/\/[^\s\)]+)/g;
    let match;
    while ((match = markdownPattern.exec(text)) !== null) {
        urls.push(match[1]);
    }
    
    // Match <img src="url"> HTML format
    const htmlPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
    while ((match = htmlPattern.exec(text)) !== null) {
        if (match[1].startsWith('http')) {
            urls.push(match[1]);
        }
    }
    
    // Match <audio src="url"> and <source src="url"> HTML format
    const audioPattern = /<(?:audio|source)[^>]+src=["']([^"']+)["'][^>]*>/g;
    while ((match = audioPattern.exec(text)) !== null) {
        if (match[1].startsWith('http')) {
            urls.push(match[1]);
        }
    }
    
    // Match raw URLs for media files
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))/gi;
    while ((match = urlPattern.exec(text)) !== null) {
        urls.push(match[1]);
    }
    
    return [...new Set(urls)]; // Remove duplicates
}

/**
 * Find all remote media URLs in a character card
 */
function findCharacterMediaUrls(character) {
    if (!character) return [];
    
    const mediaUrls = new Set();
    
    // Fields to scan for media
    const fieldsToCheck = [
        'description',
        'personality',
        'scenario',
        'first_mes',
        'mes_example',
        'creator_notes',
        'system_prompt',
        'post_history_instructions'
    ];
    
    // Check main fields - character data might be nested or flat
    const data = character.data || character;
    
    fieldsToCheck.forEach(field => {
        const value = data[field];
        if (value && typeof value === 'string') {
            const urls = extractMediaUrls(value);
            urls.forEach(url => {
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    mediaUrls.add(url);
                }
            });
        }
    });
    
    // Check alternate greetings
    const altGreetings = data.alternate_greetings;
    if (altGreetings && Array.isArray(altGreetings)) {
        altGreetings.forEach(greeting => {
            if (greeting && typeof greeting === 'string') {
                const urls = extractMediaUrls(greeting);
                urls.forEach(url => {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        mediaUrls.add(url);
                    }
                });
            }
        });
    }
    
    debugLog(`[Localize] Found ${mediaUrls.size} remote media URLs in character`);
    return Array.from(mediaUrls);
}

/**
 * Get hashes of all existing files in a character's gallery
 * @returns {Promise<Map<string, {fileName: string, localPath: string}>>} Map of hash -> file info
 */
async function getExistingFileHashes(characterName) {
    const hashMap = new Map();
    
    try {
        // Request all media types: IMAGE=1, VIDEO=2, AUDIO=4, so 7 = all
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: characterName, type: 7 });
        
        if (!response.ok) {
            debugLog('[Localize] Could not list existing files');
            return hashMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return hashMap;
        }
        
        // Sanitize folder name to match SillyTavern's folder naming convention
        const safeFolderName = sanitizeFolderName(characterName);
        
        // Calculate hash for each existing file
        // Process one at a time and null the buffer immediately to keep peak memory low
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only check media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            
            try {
                const fileResponse = await fetch(localPath);
                if (fileResponse.ok) {
                    let buffer = await fileResponse.arrayBuffer();
                    const hash = await calculateHash(buffer);
                    buffer = null; // Release immediately — critical for mobile memory
                    hashMap.set(hash, { fileName, localPath });
                }
            } catch (e) {
                console.warn(`[Localize] Could not hash existing file: ${fileName}`);
            }
        }
        
        return hashMap;
    } catch (error) {
        console.error('[Localize] Error getting existing file hashes:', error);
        return hashMap;
    }
}

/**
 * Parse MP4/M4A container to check if it contains video tracks
 * MP4 files are structured as nested "atoms" (boxes) with 4-byte size + 4-byte type
 * We scan for 'hdlr' (handler) atoms and check if any have 'vide' (video) handler type
 * @param {Uint8Array} bytes - The file bytes
 * @returns {boolean} True if video track found, false if audio-only
 */
function mp4HasVideoTrack(bytes) {
    const len = bytes.length;
    let pos = 0;
    
    // Scan through atoms looking for 'hdlr' handler atoms
    // hdlr atom structure: [4-byte size][hdlr][4-byte version/flags][4-byte predefined][4-byte handler_type]
    // handler_type at offset 16 from atom start: 'vide' for video, 'soun' for sound
    while (pos < len - 24) {
        // Read atom size (big-endian 32-bit)
        const atomSize = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        
        // Read atom type
        const atomType = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
        
        // Check for 'hdlr' atom
        if (atomType === 'hdlr' && atomSize >= 24) {
            // Handler type is at offset 16 from atom start (after size[4] + type[4] + version[4] + predefined[4])
            const handlerType = String.fromCharCode(
                bytes[pos + 16], bytes[pos + 17], bytes[pos + 18], bytes[pos + 19]
            );
            
            if (handlerType === 'vide') {
                return true; // Found video track
            }
        }
        
        // Move to next atom
        // Atom size of 0 means "extends to end of file" - stop scanning
        // Atom size of 1 means 64-bit extended size (rare, skip for simplicity)
        if (atomSize === 0 || atomSize === 1) {
            break;
        }
        
        // For container atoms (moov, trak, mdia, minf, stbl), descend into them
        // by moving just past the header (8 bytes) instead of skipping the whole atom
        const containerAtoms = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'];
        if (containerAtoms.includes(atomType)) {
            pos += 8; // Just skip the header, scan contents
        } else {
            pos += atomSize; // Skip entire atom
        }
        
        // Safety: prevent infinite loop on malformed files
        if (atomSize < 8 && !containerAtoms.includes(atomType)) {
            break;
        }
    }
    
    return false; // No video track found = audio only
}

/**
 * Download a media file to memory (ArrayBuffer) without saving
 */
/**
 * Validate that downloaded content is actually valid media by checking magic bytes
 * Returns the detected media type or null if invalid
 * @param {ArrayBuffer} arrayBuffer - The downloaded content
 * @param {string} contentType - Content-Type header from response
 * @returns {{ valid: boolean, detectedType: string|null, reason: string }}
 */
function validateMediaContent(arrayBuffer, contentType) {
    // Check minimum size
    if (!arrayBuffer || arrayBuffer.byteLength < 8) {
        return { valid: false, detectedType: null, reason: 'Content too small to be valid media' };
    }
    
    const bytes = new Uint8Array(arrayBuffer);
    
    // Check for common magic bytes
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { valid: true, detectedType: 'image/png', reason: 'Valid PNG' };
    }
    
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { valid: true, detectedType: 'image/jpeg', reason: 'Valid JPEG' };
    }
    
    // GIF: 47 49 46 38 (GIF8)
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { valid: true, detectedType: 'image/gif', reason: 'Valid GIF' };
    }
    
    // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { valid: true, detectedType: 'image/webp', reason: 'Valid WebP' };
    }
    
    // BMP: 42 4D (BM)
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { valid: true, detectedType: 'image/bmp', reason: 'Valid BMP' };
    }
    
    // MP4/M4A/M4V: ... 66 74 79 70 (....ftyp) at offset 4
    // MP4 and M4A share the same container format - we need to check for video tracks
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        // Check the major brand at bytes 8-11 first (quick check)
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        
        // Definitive audio brands - no need to scan
        if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
            return { valid: true, detectedType: 'audio/mp4', reason: 'Valid M4A audio (brand)' };
        }
        
        // For generic brands (isom, mp41, mp42, etc.), scan the file for video tracks
        // Look for 'moov' -> 'trak' -> 'mdia' -> 'hdlr' with 'vide' handler type
        const hasVideoTrack = mp4HasVideoTrack(bytes);
        
        if (hasVideoTrack) {
            return { valid: true, detectedType: 'video/mp4', reason: 'Valid MP4 video (has video track)' };
        } else {
            return { valid: true, detectedType: 'audio/mp4', reason: 'Valid M4A audio (no video track)' };
        }
    }
    
    // WebM: 1A 45 DF A3
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        return { valid: true, detectedType: 'video/webm', reason: 'Valid WebM' };
    }
    
    // MP3: ID3 tag (49 44 33) or MPEG sync word (FF FB, FF FA, FF F3, FF F2)
    if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xFF && (bytes[1] === 0xFB || bytes[1] === 0xFA || bytes[1] === 0xF3 || bytes[1] === 0xF2))) {
        return { valid: true, detectedType: 'audio/mpeg', reason: 'Valid MP3' };
    }
    
    // OGG: 4F 67 67 53 (OggS)
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return { valid: true, detectedType: 'audio/ogg', reason: 'Valid OGG' };
    }
    
    // WAV: 52 49 46 46 ... 57 41 56 45 (RIFF....WAVE)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
        return { valid: true, detectedType: 'audio/wav', reason: 'Valid WAV' };
    }
    
    // FLAC: 66 4C 61 43 (fLaC)
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
        return { valid: true, detectedType: 'audio/flac', reason: 'Valid FLAC' };
    }
    
    // SVG: Check for <?xml or <svg
    const textStart = new TextDecoder().decode(bytes.slice(0, Math.min(100, bytes.length)));
    if (textStart.includes('<?xml') || textStart.includes('<svg')) {
        return { valid: true, detectedType: 'image/svg+xml', reason: 'Valid SVG' };
    }
    
    // Check if it looks like HTML (common error page response)
    if (textStart.includes('<!DOCTYPE') || textStart.includes('<html') || textStart.includes('<HTML')) {
        return { valid: false, detectedType: 'text/html', reason: 'Content is HTML (likely error page)' };
    }
    
    // If content-type suggests media but we couldn't validate, allow it with warning
    if (contentType && (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
        debugLog(`[EmbeddedMedia] Unknown format but content-type suggests media: ${contentType}`);
        return { valid: true, detectedType: contentType, reason: 'Unknown format, trusting content-type' };
    }
    
    // Unknown format
    return { valid: false, detectedType: null, reason: 'Unknown or invalid media format' };
}

/**
 * Convert ArrayBuffer to base64 string directly without intermediate Blob/FileReader.
 * Uses chunked btoa: processes 3072-byte groups (multiple of 3 for valid base64),
 * collects chunk strings, then joins once at the end.
 *
 * Memory profile for 5MB input:
 *   - bytes view: 0 (shares buffer)
 *   - per-chunk overhead: ~7KB (3KB binary + 4KB base64), immediately GC-eligible
 *   - parts array: ~1700 string references (~14KB)
 *   - final join: ~6.67MB result string
 *   - Peak: ~18MB (buffer + parts + join result)
 *
 * Previous Array approach was ~53MB peak for the same input.
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    // 3072 bytes = 1024 triplets → 4096 base64 chars per chunk.
    // Small enough for String.fromCharCode.apply (well under stack limits).
    const GROUP = 3072;
    const parts = [];
    for (let i = 0; i < len; i += GROUP) {
        const chunk = bytes.subarray(i, Math.min(i + GROUP, len));
        parts.push(btoa(String.fromCharCode.apply(null, chunk)));
    }
    return parts.join('');
}

async function downloadMediaToMemory(url, timeoutMs = 30000, abortSignal = null) {
    try {
        let response;
        let usedProxy = false;

        // Create abort controller for timeout and external abort
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let abortListener = null;

        if (abortSignal) {
            if (abortSignal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            abortListener = () => controller.abort();
            abortSignal.addEventListener('abort', abortListener, { once: true });
        }

        try {
            // Try direct fetch first
            try {
                response = await fetch(url, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (directError) {
                if (directError.name === 'AbortError') throw directError;
                // Direct fetch failed (likely CORS), try proxy
                usedProxy = true;
                const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
                response = await fetch(proxyUrl, { signal: controller.signal });
                
                if (!response.ok) {
                    if (response.status === 404) {
                        const text = await response.text();
                        if (text.includes('CORS proxy is disabled')) {
                            throw new Error('CORS blocked and proxy is disabled');
                        }
                    }
                    throw new Error(`Proxy HTTP ${response.status}`);
                }
            }
        } finally {
            clearTimeout(timeoutId);
            if (abortSignal && abortListener) {
                abortSignal.removeEventListener('abort', abortListener);
            }
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || '';
        
        // Validate that the downloaded content is actually valid media
        // This is critical because some CDNs/servers return incorrect Content-Type headers
        // (e.g., returning "image/jpeg" for an MP3 file), which would cause files to be
        // saved with wrong extensions. Magic byte detection ensures we identify the true
        // file type regardless of what the server claims.
        const validation = validateMediaContent(arrayBuffer, contentType);
        if (!validation.valid) {
            debugLog(`[EmbeddedMedia] Invalid media from ${url}: ${validation.reason}`);
            return {
                success: false,
                error: validation.reason
            };
        }
        
        // Use detected content type if header was missing/wrong
        const finalContentType = validation.detectedType || contentType;
        
        return {
            success: true,
            arrayBuffer: arrayBuffer,
            contentType: finalContentType,
            usedProxy: usedProxy,
            detectedType: validation.detectedType
        };
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error)
        };
    }
}

/**
 * Save a media file from memory (already downloaded ArrayBuffer) to character's gallery
 * @param {Object} downloadResult - Result from downloadMediaToMemory
 * @param {string} url - Original URL of the media
 * @param {string} folderName - Gallery folder name (use getGalleryFolderName() for unique folders)
 * @param {number} index - File index for naming
 */
async function saveMediaFromMemory(downloadResult, url, folderName, index) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        
        // Determine file extension from content type (detected via magic bytes)
        let extension = 'png'; // Default for images
        if (contentType) {
            const mimeToExt = {
                // Images
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'image/bmp': 'bmp',
                'image/svg+xml': 'svg',
                // Video
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov',
                // Audio
                'audio/mpeg': 'mp3',
                'audio/mp3': 'mp3',
                'audio/wav': 'wav',
                'audio/wave': 'wav',
                'audio/x-wav': 'wav',
                'audio/ogg': 'ogg',
                'audio/flac': 'flac',
                'audio/x-flac': 'flac',
                'audio/aac': 'aac',
                'audio/mp4': 'm4a',
                'audio/x-m4a': 'm4a'
            };
            
            // Try exact match first
            if (mimeToExt[contentType]) {
                extension = mimeToExt[contentType];
            } else if (contentType.startsWith('audio/')) {
                // Unknown audio type - extract subtype as extension, don't default to png!
                const subtype = contentType.split('/')[1].split(';')[0];
                extension = subtype.replace('x-', '') || 'audio';
                debugLog(`[EmbeddedMedia] Unknown audio type '${contentType}', using extension: ${extension}`);
            } else if (contentType.startsWith('video/')) {
                // Unknown video type - extract subtype as extension
                const subtype = contentType.split('/')[1].split(';')[0];
                extension = subtype.replace('x-', '') || 'video';
                debugLog(`[EmbeddedMedia] Unknown video type '${contentType}', using extension: ${extension}`);
            }
            // For unknown image types, 'png' default is acceptable
        } else {
            const urlMatch = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) {
                extension = urlMatch[1].toLowerCase();
            }
        }
        
        // Extract original filename from URL
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const originalFilename = pathParts[pathParts.length - 1] || 'media';
        const originalNameWithoutExt = originalFilename.includes('.') 
            ? originalFilename.substring(0, originalFilename.lastIndexOf('.'))
            : originalFilename;
        
        // Sanitize filename
        const sanitizedName = originalNameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        
        // Generate local filename
        const filenameBase = `localized_media_${index}_${sanitizedName}`;
        
        // Convert arrayBuffer to base64 then release the buffer immediately.
        // This prevents holding both the raw buffer (5MB) and the base64 string (6.7MB)
        // simultaneously during the upload await — critical for mobile memory.
        let base64Data = arrayBufferToBase64(arrayBuffer);
        // Break the reference so the ArrayBuffer can be GC'd during upload
        downloadResult.arrayBuffer = null;
        
        // Build JSON body, then release the base64 string — the JSON body contains it.
        const bodyStr = JSON.stringify({
            image: base64Data,
            filename: filenameBase,
            format: extension,
            ch_name: folderName
        });
        base64Data = null; // Release — serialized into bodyStr
        
        // Use fetch directly (instead of apiRequest) so we control the body lifecycle
        const csrfToken = getCSRFToken();
        const saveResponse = await fetch(`${API_BASE}${ENDPOINTS.IMAGES_UPLOAD}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: bodyStr
        });
        
        if (!saveResponse.ok) {
            const errorText = await saveResponse.text();
            throw new Error(`Upload failed: ${errorText}`);
        }
        
        const saveResult = await saveResponse.json();
        
        if (!saveResult || !saveResult.path) {
            throw new Error('No path returned from upload');
        }
        
        return {
            success: true,
            localPath: saveResult.path,
            filename: `${filenameBase}.${extension}`
        };
        
    } catch (error) {
        return {
            success: false,
            error: error.message || String(error)
        };
    }
}

// Convenience wrappers for localize log
function addLocalizeLogEntry(message, status = 'pending') {
    return addLogEntry(localizeLog, message, status);
}

function updateLocalizeLogEntry(entry, message, status) {
    updateLogEntryStatus(entry, message, status);
}

// Localize Media Modal Elements
const localizeModal = document.getElementById('localizeModal');
const closeLocalizeModal = document.getElementById('closeLocalizeModal');
const closeLocalizeBtn = document.getElementById('closeLocalizeBtn');
const localizeStatus = document.getElementById('localizeStatus');
const localizeProgress = document.getElementById('localizeProgress');
const localizeProgressCount = document.getElementById('localizeProgressCount');
const localizeProgressFill = document.getElementById('localizeProgressFill');
const localizeLog = document.getElementById('localizeLog');
const localizeMediaBtn = document.getElementById('localizeMediaBtn');

// Per-character media localization toggle
const charLocalizeToggle = document.getElementById('charLocalizeToggle');

// Setup per-character localization toggle
charLocalizeToggle?.addEventListener('change', async () => {
    if (!activeChar?.avatar) return;
    
    const isChecked = charLocalizeToggle.checked;
    const globalEnabled = getSetting('mediaLocalizationEnabled');
    const localizeToggleLabel = document.querySelector('.localize-toggle');
    
    // If the toggle matches global setting, remove the per-char override (use global)
    // Otherwise, set a per-char override
    if (isChecked === globalEnabled) {
        setCharacterMediaLocalization(activeChar.avatar, null); // Use global
    } else {
        setCharacterMediaLocalization(activeChar.avatar, isChecked);
    }
    
    // Update visual indicator for override status
    const status = getMediaLocalizationStatus(activeChar.avatar);
    if (localizeToggleLabel) {
        localizeToggleLabel.classList.toggle('has-override', status.hasOverride);
        
        if (status.hasOverride) {
            const overrideType = status.isEnabled ? 'ENABLED' : 'DISABLED';
            const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
            localizeToggleLabel.title = `Override: ${overrideType} for this character (global is ${globalStatus})`;
        } else {
            const globalStatus = status.globalEnabled ? 'enabled' : 'disabled';
            localizeToggleLabel.title = `Using global setting (${globalStatus})`;
        }
    }
    
    // Clear cache to force re-evaluation
    clearMediaLocalizationCache(activeChar.avatar);
    
    // Re-apply localization to the currently displayed content
    if (isChecked) {
        const desc = activeChar.description || (activeChar.data ? activeChar.data.description : "") || "";
        const firstMes = activeChar.first_mes || (activeChar.data ? activeChar.data.first_mes : "") || "";
        const altGreetings = activeChar.alternate_greetings || (activeChar.data ? activeChar.data.alternate_greetings : []) || [];
        const creatorNotes = activeChar.creator_notes || (activeChar.data ? activeChar.data.creator_notes : "") || "";
        
        await applyMediaLocalizationToModal(activeChar, desc, firstMes, altGreetings, creatorNotes);
        showToast('Media localization enabled for this character', 'success');
    } else {
        // Refresh without localization - reload the modal content
        openModal(activeChar);
        showToast('Media localization disabled for this character', 'info');
    }
});

// Close localize modal handlers
closeLocalizeModal?.addEventListener('click', () => {
    localizeModal.classList.add('hidden');
});

closeLocalizeBtn?.addEventListener('click', () => {
    localizeModal.classList.add('hidden');
});

// Localize Media button click handler (embedded media + linked Chub gallery)
localizeMediaBtn?.addEventListener('click', async () => {
    if (!activeChar) {
        showToast('No character selected', 'error');
        return;
    }
    
    // Show modal
    localizeModal.classList.remove('hidden');
    localizeStatus.textContent = 'Scanning character...';
    localizeLog.innerHTML = '';
    localizeProgressFill.style.width = '0%';
    localizeProgressCount.textContent = '0/0';
    
    // Get character name for folder (use unique folder if enabled)
    const characterName = getCharacterName(activeChar, 'unknown');
    const folderName = getGalleryFolderName(activeChar);
    
    // Find all media URLs
    const mediaUrls = findCharacterMediaUrls(activeChar);
    
    // Check if character is linked to ChubAI
    const chubInfo = getChubLinkInfo(activeChar);
    const hasChubLink = chubInfo && chubInfo.id;
    
    if (mediaUrls.length === 0 && !hasChubLink) {
        localizeStatus.textContent = 'No remote media found in this character card.';
        addLocalizeLogEntry('Embedded Media: none found in character card', 'info');
        addLocalizeLogEntry('ChubAI Gallery: character not linked', 'info');
        return;
    }
    
    // Phase 1: Download embedded media first (takes precedence for duplicate detection)
    localizeStatus.textContent = mediaUrls.length > 0 
        ? `Downloading ${mediaUrls.length} embedded media file(s)...`
        : 'No embedded media, checking ChubAI gallery...';
    localizeProgressCount.textContent = `0/${mediaUrls.length}`;
    
    // Add section header for embedded media
    if (mediaUrls.length > 0) {
        addLocalizeLogEntry(`Embedded Media (${mediaUrls.length} URL(s) found)`, 'info');
    } else {
        addLocalizeLogEntry('Embedded Media: none found in character card', 'info');
    }
    
    const result = await downloadEmbeddedMediaForCharacter(folderName, mediaUrls, {
        onProgress: (current, total) => {
            const progress = (current / total) * 100;
            localizeProgressFill.style.width = `${progress}%`;
            localizeProgressCount.textContent = `${current}/${total}`;
        },
        onLog: (message, status) => addLocalizeLogEntry(message, status),
        onLogUpdate: (entry, message, status) => updateLocalizeLogEntry(entry, message, status)
    });
    
    // Done - show status
    let statusMsg = '';
    if (result.success > 0) {
        statusMsg = `Downloaded ${result.success} new file(s)`;
    }
    if (result.renamed > 0) {
        statusMsg += (statusMsg ? ', ' : '') + `renamed ${result.renamed} file(s)`;
    }
    if (result.skipped > 0) {
        statusMsg += (statusMsg ? ', ' : '') + `${result.skipped} already existed`;
    }
    if (result.errors > 0) {
        statusMsg += (statusMsg ? ', ' : '') + `${result.errors} failed`;
    }
    
    localizeStatus.textContent = statusMsg || 'No new files to download.';
    
    // Add embedded media result summary to log
    if (mediaUrls.length > 0) {
        if (result.success > 0) {
            addLocalizeLogEntry(`  ✓ ${result.success} downloaded, ${result.skipped || 0} skipped, ${result.errors || 0} failed`, 'success');
        } else if (result.skipped > 0) {
            addLocalizeLogEntry(`  ✓ ${result.skipped} already exist`, 'info');
        } else if (result.errors > 0) {
            addLocalizeLogEntry(`  ✗ ${result.errors} failed to download`, 'error');
        }
    }
    
    if (result.success > 0 || result.renamed > 0) {
        const msg = result.renamed > 0 
            ? `Downloaded ${result.success}, renamed ${result.renamed} file(s)` 
            : `Downloaded ${result.success} new media file(s)`;
        showToast(msg, 'success');
        
        // Clear the localization cache for this character so new files are picked up
        if (activeChar?.avatar) {
            clearMediaLocalizationCache(activeChar.avatar);
        }
        
        // Refresh the sprites grid to show new images - pass character object for unique folder support
        if (activeChar) {
            fetchCharacterImages(activeChar);
        }
    } else if (result.skipped > 0 && result.errors === 0) {
        showToast('All files already exist', 'info');
    } else if (result.errors > 0) {
        showToast('Some downloads failed', 'error');
    }
    
    // Mark character as complete for bulk localization if no errors (only if no Chub gallery to process)
    if (result.errors === 0 && !hasChubLink && activeChar?.avatar) {
        markMediaLocalizationComplete(activeChar.avatar);
    }
    
    // Phase 2: If character is linked to ChubAI, also download gallery
    if (hasChubLink) {
        const includeChubGallery = getSetting('includeChubGallery') !== false;
        if (!includeChubGallery) {
            addLocalizeLogEntry('', 'divider');
            addLocalizeLogEntry(`ChubAI Gallery (${chubInfo.fullPath})`, 'info');
            addLocalizeLogEntry('  ⚠ Skipped: disabled in settings (Include ChubAI Gallery)', 'warning');
            localizeStatus.textContent = 'ChubAI gallery skipped (disabled in settings).';
        } else {
        addLocalizeLogEntry('', 'divider');
        addLocalizeLogEntry(`ChubAI Gallery (${chubInfo.fullPath})`, 'info');
        localizeStatus.textContent = 'Downloading ChubAI gallery...';
        
        try {
            const galleryResult = await downloadChubGalleryForCharacter(folderName, chubInfo.id, {
                onLog: (message, status) => addLocalizeLogEntry(message, status),
                onLogUpdate: (entry, message, status) => updateLocalizeLogEntry(entry, message, status)
            });
            
            // Update totals
            result.success += galleryResult.success || 0;
            result.skipped += galleryResult.skipped || 0;
            result.errors += galleryResult.errors || 0;
            
            if (galleryResult.success > 0) {
                addLocalizeLogEntry(`  ✓ ${galleryResult.success} downloaded, ${galleryResult.skipped || 0} skipped, ${galleryResult.errors || 0} failed`, 'success');
            } else if (galleryResult.skipped > 0) {
                addLocalizeLogEntry(`  ✓ ${galleryResult.skipped} already exist`, 'info');
            } else {
                addLocalizeLogEntry('  ✗ No images available on ChubAI', 'info');
            }
        } catch (error) {
            console.error('[MediaLocalize] Chub gallery error:', error);
            addLocalizeLogEntry(`  ✗ Download failed: ${error.message}`, 'error');
            result.errors++;
        }
        
        // Update final status
        statusMsg = '';
        if (result.success > 0) statusMsg = `Downloaded ${result.success} file(s)`;
        if (result.skipped > 0) statusMsg += (statusMsg ? ', ' : '') + `${result.skipped} existed`;
        if (result.errors > 0) statusMsg += (statusMsg ? ', ' : '') + `${result.errors} failed`;
        localizeStatus.textContent = statusMsg || 'Complete';
        
        // Refresh sprites grid - pass character object for unique folder support
        if (result.success > 0 && activeChar) {
            fetchCharacterImages(activeChar);
        }
        }
    }
    
    // Mark character as complete for bulk localization if no errors
    if (result.errors === 0 && activeChar?.avatar) {
        markMediaLocalizationComplete(activeChar.avatar);
    }
});

// ==============================================
// Bulk Media Localization
// ==============================================

// Bulk Localize Modal Elements
const bulkLocalizeModal = document.getElementById('bulkLocalizeModal');
const closeBulkLocalizeModal = document.getElementById('closeBulkLocalizeModal');
const cancelBulkLocalizeBtn = document.getElementById('cancelBulkLocalizeBtn');
const bulkLocalizeCharAvatar = document.getElementById('bulkLocalizeCharAvatar');
const bulkLocalizeCharName = document.getElementById('bulkLocalizeCharName');
const bulkLocalizeStatus = document.getElementById('bulkLocalizeStatus');
const bulkLocalizeProgressCount = document.getElementById('bulkLocalizeProgressCount');
const bulkLocalizeProgressFill = document.getElementById('bulkLocalizeProgressFill');
const bulkLocalizeFileCount = document.getElementById('bulkLocalizeFileCount');
const bulkLocalizeFileFill = document.getElementById('bulkLocalizeFileFill');
const bulkStatDownloaded = document.getElementById('bulkStatDownloaded');
const bulkStatSkipped = document.getElementById('bulkStatSkipped');
const bulkStatErrors = document.getElementById('bulkStatErrors');

// Bulk Summary Modal Elements
const bulkSummaryModal = document.getElementById('bulkLocalizeSummaryModal');
const closeBulkSummaryModal = document.getElementById('closeBulkSummaryModal');
const closeBulkSummaryBtn = document.getElementById('closeBulkSummaryBtn');
const bulkSummaryOverview = document.getElementById('bulkSummaryOverview');
const bulkSummaryFilterSelect = document.getElementById('bulkSummaryFilterSelect');
const bulkSummarySearch = document.getElementById('bulkSummarySearch');
const bulkSummaryList = document.getElementById('bulkSummaryList');
const bulkSummaryPrevBtn = document.getElementById('bulkSummaryPrevBtn');
const bulkSummaryNextBtn = document.getElementById('bulkSummaryNextBtn');
const bulkSummaryPageInfo = document.getElementById('bulkSummaryPageInfo');

// Bulk localization state
let bulkLocalizeAborted = false;
let bulkLocalizeResults = [];
let bulkSummaryCurrentPage = 1;
let bulkSummaryShowRenamed = false;
const BULK_SUMMARY_PAGE_SIZE = 50;

// Close bulk localize modal
closeBulkLocalizeModal?.addEventListener('click', () => {
    bulkLocalizeAborted = true;
    bulkLocalizeModal.classList.add('hidden');
});

cancelBulkLocalizeBtn?.addEventListener('click', () => {
    bulkLocalizeAborted = true;
    cancelBulkLocalizeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stopping...';
    cancelBulkLocalizeBtn.disabled = true;
});

// Close summary modal
closeBulkSummaryModal?.addEventListener('click', () => {
    bulkSummaryModal.classList.add('hidden');
});

closeBulkSummaryBtn?.addEventListener('click', () => {
    bulkSummaryModal.classList.add('hidden');
});

// Summary filter and search handlers
bulkSummaryFilterSelect?.addEventListener('change', () => {
    bulkSummaryCurrentPage = 1;
    renderBulkSummaryList();
});

bulkSummarySearch?.addEventListener('input', () => {
    bulkSummaryCurrentPage = 1;
    renderBulkSummaryList();
});

bulkSummaryPrevBtn?.addEventListener('click', () => {
    if (bulkSummaryCurrentPage > 1) {
        bulkSummaryCurrentPage--;
        renderBulkSummaryList();
    }
});

bulkSummaryNextBtn?.addEventListener('click', () => {
    bulkSummaryCurrentPage++;
    renderBulkSummaryList();
});

/**
 * Filter bulk summary results based on current filter and search
 */
function getFilteredBulkResults() {
    const filter = bulkSummaryFilterSelect?.value || 'all';
    const search = (bulkSummarySearch?.value || '').toLowerCase().trim();
    
    return bulkLocalizeResults.filter(r => {
        // Calculate combined totals for filtering
        const totalDownloaded = (r.downloaded || 0) + (r.chubDownloaded || 0);
        const totalSkipped = (r.skipped || 0) + (r.chubSkipped || 0);
        const totalErrors = (r.errors || 0) + (r.chubErrors || 0);
        const hasAnyMedia = r.totalUrls > 0 || r.chubDownloaded > 0 || r.chubSkipped > 0 || r.chubErrors > 0;
        
        // Apply filter (includes both embedded and Chub gallery)
        if (filter === 'downloaded' && totalDownloaded === 0) return false;
        if (filter === 'skipped' && totalSkipped === 0) return false;
        if (filter === 'errors' && totalErrors === 0) return false;
        if (filter === 'incomplete' && !r.incomplete) return false;
        if (filter === 'none' && hasAnyMedia) return false;
        
        // Apply search
        if (search && !r.name.toLowerCase().includes(search)) return false;
        
        return true;
    });
}

/**
 * Save bulk summary modal state before opening character modal
 */
function saveBulkSummaryModalState() {
    const modal = bulkSummaryModal;
    bulkSummaryModalState.wasOpen = modal && !modal.classList.contains('hidden');
    bulkSummaryModalState.scrollPosition = bulkSummaryList ? bulkSummaryList.scrollTop : 0;
    bulkSummaryModalState.currentPage = bulkSummaryCurrentPage;
    bulkSummaryModalState.filterValue = bulkSummaryFilterSelect?.value || 'all';
    bulkSummaryModalState.searchValue = bulkSummarySearch?.value || '';
}

/**
 * Restore bulk summary modal state after closing character modal
 */
function restoreBulkSummaryModalState() {
    if (!bulkSummaryModalState.wasOpen) return;
    
    // Restore filter/search values
    if (bulkSummaryFilterSelect) bulkSummaryFilterSelect.value = bulkSummaryModalState.filterValue;
    if (bulkSummarySearch) bulkSummarySearch.value = bulkSummaryModalState.searchValue;
    bulkSummaryCurrentPage = bulkSummaryModalState.currentPage;
    
    // Show the modal
    bulkSummaryModal.classList.remove('hidden');
    
    // Re-render and restore scroll position
    renderBulkSummaryList();
    
    setTimeout(() => {
        if (bulkSummaryList) {
            bulkSummaryList.scrollTop = bulkSummaryModalState.scrollPosition;
        }
    }, 50);
}

/**
 * Open character modal from bulk summary list
 */
function openCharFromBulkSummary(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        showToast('Character not found', 'error');
        return;
    }
    
    // Save current bulk summary state
    saveBulkSummaryModalState();
    
    // Hide bulk summary modal
    bulkSummaryModal.classList.add('hidden');
    
    // Open character modal
    openModal(char);
}

/**
 * Render the bulk summary list with pagination
 */
function renderBulkSummaryList() {
    const filtered = getFilteredBulkResults();
    const totalPages = Math.max(1, Math.ceil(filtered.length / BULK_SUMMARY_PAGE_SIZE));
    
    // Clamp current page
    if (bulkSummaryCurrentPage > totalPages) bulkSummaryCurrentPage = totalPages;
    
    const startIdx = (bulkSummaryCurrentPage - 1) * BULK_SUMMARY_PAGE_SIZE;
    const pageResults = filtered.slice(startIdx, startIdx + BULK_SUMMARY_PAGE_SIZE);
    
    if (pageResults.length === 0) {
        bulkSummaryList.innerHTML = '<div class="bulk-summary-empty"><i class="fa-solid fa-filter-circle-xmark"></i><br>No characters match the current filter</div>';
    } else {
        bulkSummaryList.innerHTML = pageResults.map(r => {
            const hasChubStats = r.chubDownloaded > 0 || r.chubSkipped > 0 || r.chubErrors > 0;
            const totalEmbedded = (r.downloaded || 0) + (r.skipped || 0) + (r.errors || 0);
            const hasEmbeddedStats = totalEmbedded > 0;
            const hasAnyMedia = hasEmbeddedStats || hasChubStats;
            
            // Build embedded stats section
            let embeddedHtml = '';
            if (hasEmbeddedStats) {
                const parts = [];
                if (r.downloaded > 0) parts.push(`<span class="downloaded" title="${r.downloaded} new file(s) downloaded"><i class="fa-solid fa-download"></i>${r.downloaded}</span>`);
                if (r.skipped > 0) parts.push(`<span class="skipped" title="${r.skipped} file(s) already local"><i class="fa-solid fa-check"></i>${r.skipped}</span>`);
                if (r.errors > 0) parts.push(`<span class="errors" title="${r.errors} file(s) failed"><i class="fa-solid fa-xmark"></i>${r.errors}</span>`);
                if (bulkSummaryShowRenamed && r.renamed > 0) parts.push(`<span class="renamed" title="${r.renamed} file(s) renamed"><i class="fa-solid fa-file-pen"></i>${r.renamed}</span>`);
                embeddedHtml = `<div class="media-source-group embedded" title="Embedded media from character data"><i class="fa-solid fa-file-code source-icon"></i>${parts.join('')}</div>`;
            }
            
            // Build Chub gallery stats section
            let chubHtml = '';
            if (hasChubStats) {
                const parts = [];
                if (r.chubDownloaded > 0) parts.push(`<span class="downloaded" title="${r.chubDownloaded} gallery image(s) downloaded from Chub"><i class="fa-solid fa-download"></i>${r.chubDownloaded}</span>`);
                if (r.chubSkipped > 0) parts.push(`<span class="skipped" title="${r.chubSkipped} gallery image(s) already local"><i class="fa-solid fa-check"></i>${r.chubSkipped}</span>`);
                if (r.chubErrors > 0) parts.push(`<span class="errors" title="${r.chubErrors} gallery image(s) failed"><i class="fa-solid fa-xmark"></i>${r.chubErrors}</span>`);
                chubHtml = `<div class="media-source-group chub" title="ChubAI gallery images"><i class="fa-solid fa-images source-icon"></i>${parts.join('')}</div>`;
            }
            
            return `
            <div class="bulk-summary-item${r.incomplete ? ' incomplete' : ''}">
                <img src="${getCharacterAvatarUrl(r.avatar)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <a class="char-name-link" href="#" onclick="openCharFromBulkSummary('${escapeHtml(r.avatar)}'); return false;" title="Click to view ${escapeHtml(r.name)}">${escapeHtml(r.name)}</a>
                <div class="char-stats">
                    ${r.incomplete ? '<span class="incomplete-badge" title="Has errors or was interrupted"><i class="fa-solid fa-exclamation-triangle"></i></span>' : ''}
                    ${!hasAnyMedia 
                        ? '<span class="none" title="Character has no embedded remote media URLs and no Chub gallery"><i class="fa-solid fa-minus"></i> No media</span>'
                        : `${embeddedHtml}${chubHtml}`
                    }
                </div>
            </div>
        `}).join('');
    }
    
    // Update pagination
    bulkSummaryPageInfo.textContent = `Page ${bulkSummaryCurrentPage} of ${totalPages}`;
    bulkSummaryPrevBtn.disabled = bulkSummaryCurrentPage <= 1;
    bulkSummaryNextBtn.disabled = bulkSummaryCurrentPage >= totalPages;
}

/**
 * Show the bulk summary modal with results
 */
function showBulkSummary(wasAborted = false, skippedCompleted = 0) {
    // Calculate totals
    const totals = bulkLocalizeResults.reduce((acc, r) => {
        acc.characters++;
        acc.downloaded += r.downloaded || 0;
        acc.skipped += r.skipped || 0;
        acc.errors += r.errors || 0;
        acc.renamed += r.renamed || 0;
        acc.chubDownloaded += r.chubDownloaded || 0;
        acc.chubSkipped += r.chubSkipped || 0;
        acc.chubErrors += r.chubErrors || 0;
        if (r.totalUrls > 0) acc.withMedia++;
        if (r.chubDownloaded > 0 || r.chubSkipped > 0 || r.chubErrors > 0) acc.withChubGallery++;
        if (r.incomplete) acc.incomplete++;
        return acc;
    }, { characters: 0, downloaded: 0, skipped: 0, errors: 0, renamed: 0, withMedia: 0, incomplete: 0, chubDownloaded: 0, chubSkipped: 0, chubErrors: 0, withChubGallery: 0 });
    
    const hasEmbedded = totals.downloaded > 0 || totals.skipped > 0 || totals.errors > 0;
    const hasChub = totals.chubDownloaded > 0 || totals.chubSkipped > 0 || totals.chubErrors > 0;
    const totalDownloaded = totals.downloaded + totals.chubDownloaded;
    const totalSkipped = totals.skipped + totals.chubSkipped;
    const totalErrors = totals.errors + totals.chubErrors;
    
    // Build the overview with two media source sections
    bulkSummaryOverview.innerHTML = `
        <!-- Summary header row -->
        <div class="bulk-summary-header-row">
            <div class="bulk-summary-stat main" title="Characters processed in this scan">
                <span class="stat-value">${totals.characters}</span>
                <span class="stat-label"><i class="fa-solid fa-user"></i> ${wasAborted ? 'Processed' : 'Scanned'}</span>
            </div>
            ${skippedCompleted > 0 ? `
            <div class="bulk-summary-stat previously-done" title="Characters skipped because media was already localized in a previous run">
                <span class="stat-value">${skippedCompleted}</span>
                <span class="stat-label"><i class="fa-solid fa-check-double"></i> Previously Done</span>
            </div>
            ` : ''}
            ${totals.incomplete > 0 ? `
            <div class="bulk-summary-stat incomplete" title="Characters that had download errors or were interrupted mid-process">
                <span class="stat-value">${totals.incomplete}</span>
                <span class="stat-label"><i class="fa-solid fa-exclamation-triangle"></i> Incomplete</span>
            </div>
            ` : ''}
        </div>
        
        <!-- Two-column media sources -->
        <div class="bulk-summary-media-sources">
            <!-- Embedded Media Column -->
            <div class="bulk-summary-source embedded ${!hasEmbedded ? 'empty' : ''}">
                <div class="source-header">
                    <i class="fa-solid fa-file-code"></i>
                    <span>Embedded Media</span>
                    <span class="source-hint" title="Images and media URLs found within character description, personality, first message, and other text fields">?</span>
                </div>
                <div class="source-stats">
                    <div class="source-stat downloaded" title="New files downloaded from remote URLs embedded in character data and saved to gallery">
                        <i class="fa-solid fa-download"></i>
                        <span class="value">${totals.downloaded}</span>
                        <span class="label">Downloaded</span>
                    </div>
                    <div class="source-stat skipped" title="Files that were already present in the local gallery (matched by content hash)">
                        <i class="fa-solid fa-check"></i>
                        <span class="value">${totals.skipped}</span>
                        <span class="label">Already Local</span>
                    </div>
                    <div class="source-stat errors" title="Files that failed to download due to network errors, missing files, or access restrictions">
                        <i class="fa-solid fa-xmark"></i>
                        <span class="value">${totals.errors}</span>
                        <span class="label">Failed</span>
                    </div>
                    ${totals.renamed > 0 ? `
                    <div class="source-stat renamed" title="Existing gallery files that were renamed to localized_media_* format for proper hash-based lookup">
                        <i class="fa-solid fa-file-pen"></i>
                        <span class="value">${totals.renamed}</span>
                        <span class="label">Renamed</span>
                    </div>
                    ` : ''}
                </div>
                ${!hasEmbedded ? '<div class="source-empty">No embedded media found</div>' : ''}
            </div>
            
            <!-- Chub Gallery Column -->
            <div class="bulk-summary-source chub ${!hasChub ? 'empty' : ''}">
                <div class="source-header">
                    <i class="fa-solid fa-images"></i>
                    <span>Chub Gallery</span>
                    <span class="source-hint" title="Gallery images from ChubAI for characters with a chub.ai link. Downloaded from the character's public gallery page.">?</span>
                </div>
                <div class="source-stats">
                    <div class="source-stat downloaded" title="New gallery images downloaded from ChubAI and saved to the character's local gallery">
                        <i class="fa-solid fa-download"></i>
                        <span class="value">${totals.chubDownloaded}</span>
                        <span class="label">Downloaded</span>
                    </div>
                    <div class="source-stat skipped" title="Gallery images that were already present locally (matched by content hash)">
                        <i class="fa-solid fa-check"></i>
                        <span class="value">${totals.chubSkipped}</span>
                        <span class="label">Already Local</span>
                    </div>
                    <div class="source-stat errors" title="Gallery images that failed to download from ChubAI">
                        <i class="fa-solid fa-xmark"></i>
                        <span class="value">${totals.chubErrors}</span>
                        <span class="label">Failed</span>
                    </div>
                </div>
                ${!hasChub ? '<div class="source-empty">No Chub galleries processed</div>' : ''}
                ${hasChub ? `<div class="source-footer">${totals.withChubGallery} character${totals.withChubGallery !== 1 ? 's' : ''} with gallery</div>` : ''}
            </div>
        </div>
        
        <!-- Grand totals row -->
        <div class="bulk-summary-totals">
            <div class="total-item downloaded" title="Total new files downloaded from all sources">
                <i class="fa-solid fa-download"></i>
                <span class="total-value">${totalDownloaded}</span>
                <span class="total-label">Total Downloaded</span>
            </div>
            <div class="total-item skipped" title="Total files already present locally">
                <i class="fa-solid fa-check"></i>
                <span class="total-value">${totalSkipped}</span>
                <span class="total-label">Already Local</span>
            </div>
            <div class="total-item errors" title="Total files that failed to download">
                <i class="fa-solid fa-xmark"></i>
                <span class="total-value">${totalErrors}</span>
                <span class="total-label">Failed</span>
            </div>
        </div>
    `;
    
    // Reset filters
    bulkSummaryFilterSelect.value = 'all';
    bulkSummarySearch.value = '';
    bulkSummaryCurrentPage = 1;
    
    // Always show renamed column since we always rename non-localized duplicates
    bulkSummaryShowRenamed = true;
    
    // Render list
    renderBulkSummaryList();
    
    // Show modal
    bulkSummaryModal.classList.remove('hidden');
}

/**
 * Get Set of character avatars that have completed media localization
 * @returns {Set<string>} Set of avatar filenames
 */
function getCompletedMediaLocalizations() {
    const stored = getSetting('completedMediaLocalizations') || [];
    return new Set(stored);
}

/**
 * Mark a character as having completed media localization
 * @param {string} avatar - The character's avatar filename
 */
function markMediaLocalizationComplete(avatar) {
    if (!avatar) return;
    const completed = getCompletedMediaLocalizations();
    completed.add(avatar);
    setSetting('completedMediaLocalizations', [...completed]);
}

/**
 * Clear all completed media localization records
 */
function clearCompletedMediaLocalizations() {
    setSetting('completedMediaLocalizations', []);
}

/**
 * Run bulk media localization across all characters
 */
async function runBulkLocalization() {
    bulkLocalizeAborted = false;
    bulkLocalizeResults = [];
    
    // Include Chub gallery downloads for linked characters
    const includeChubGallery = getSetting('includeChubGallery') || false;
    
    // Get previously completed characters
    const completedAvatars = getCompletedMediaLocalizations();
    
    // Reset UI
    bulkLocalizeModal.classList.remove('hidden');
    bulkLocalizeCharAvatar.src = '';
    bulkLocalizeCharName.textContent = 'Preparing...';
    bulkLocalizeStatus.textContent = 'Scanning library...';
    bulkLocalizeProgressFill.style.width = '0%';
    bulkLocalizeFileFill.style.width = '0%';
    bulkLocalizeProgressCount.textContent = '0/0 characters';
    bulkLocalizeFileCount.textContent = '0/0 files';
    bulkStatDownloaded.textContent = '0';
    bulkStatSkipped.textContent = '0';
    bulkStatErrors.textContent = '0';
    cancelBulkLocalizeBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    cancelBulkLocalizeBtn.disabled = false;
    
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalRenamed = 0;
    
    const characters = [...allCharacters];
    const totalChars = characters.length;
    
    bulkLocalizeStatus.textContent = `Processing ${totalChars} characters...`;
    
    let skippedCompleted = 0;
    
    for (let i = 0; i < characters.length; i++) {
        if (bulkLocalizeAborted) {
            bulkLocalizeStatus.textContent = 'Stopping...';
            break;
        }
        
        const char = characters[i];
        const charName = getCharacterName(char, 'Unknown');
        // Get unique folder name if enabled
        const folderName = getGalleryFolderName(char);
        
        // Skip characters that already completed successfully in previous runs
        if (char.avatar && completedAvatars.has(char.avatar)) {
            skippedCompleted++;
            bulkLocalizeProgressCount.textContent = `${i + 1}/${totalChars} characters (${skippedCompleted} previously done)`;
            bulkLocalizeProgressFill.style.width = `${((i + 1) / totalChars) * 100}%`;
            continue;
        }
        
        // Update current character display
        bulkLocalizeCharAvatar.src = getCharacterAvatarUrl(char.avatar);
        bulkLocalizeCharName.textContent = charName;
        bulkLocalizeProgressCount.textContent = `${i + 1}/${totalChars} characters`;
        bulkLocalizeProgressFill.style.width = `${((i + 1) / totalChars) * 100}%`;
        
        // Find media URLs for this character
        const mediaUrls = findCharacterMediaUrls(char);
        
        const result = {
            name: charName,
            avatar: char.avatar,
            totalUrls: mediaUrls.length,
            downloaded: 0,
            skipped: 0,
            errors: 0,
            incomplete: false
        };
        
        if (mediaUrls.length > 0) {
            bulkLocalizeFileCount.textContent = `0/${mediaUrls.length} files`;
            bulkLocalizeFileFill.style.width = '0%';
            
            // Download media for this character with abort support
            const downloadResult = await downloadEmbeddedMediaForCharacter(folderName, mediaUrls, {
                onProgress: (current, total) => {
                    if (!bulkLocalizeAborted) {
                        bulkLocalizeFileCount.textContent = `${current}/${total} files`;
                        bulkLocalizeFileFill.style.width = `${(current / total) * 100}%`;
                    }
                },
                shouldAbort: () => bulkLocalizeAborted
            });
            
            result.downloaded = downloadResult.success;
            result.skipped = downloadResult.skipped;
            result.errors = downloadResult.errors;
            result.renamed = downloadResult.renamed || 0;
            
            // Mark as incomplete if aborted mid-character or had errors
            if (downloadResult.aborted || downloadResult.errors > 0) {
                result.incomplete = true;
            }
            
            totalDownloaded += downloadResult.success;
            totalSkipped += downloadResult.skipped;
            totalErrors += downloadResult.errors;
            totalRenamed += downloadResult.renamed || 0;
            
            // Update stats
            bulkStatDownloaded.textContent = totalDownloaded;
            bulkStatSkipped.textContent = totalSkipped;
            bulkStatErrors.textContent = totalErrors;
            
            // Clear cache for this character if we downloaded anything
            if (downloadResult.success > 0 && char.avatar) {
                clearMediaLocalizationCache(char.avatar);
            }
            
            // If download was aborted, stop the loop
            if (downloadResult.aborted) {
                result.incomplete = true;
                bulkLocalizeResults.push(result);
                break;
            }
        } else {
            bulkLocalizeFileCount.textContent = 'No remote media';
            bulkLocalizeFileFill.style.width = '100%';
        }
        
        // Phase 2: Chub gallery download (if enabled and character is linked)
        if (includeChubGallery && !bulkLocalizeAborted) {
            const chubData = getChubLinkInfo(char);
            if (chubData && chubData.id) {
                bulkLocalizeFileCount.textContent = 'Fetching Chub gallery...';
                bulkLocalizeFileFill.style.width = '0%';
                
                try {
                    const chubResult = await downloadChubGalleryForCharacter(folderName, chubData.id, {
                        onProgress: (current, total) => {
                            if (!bulkLocalizeAborted) {
                                bulkLocalizeFileCount.textContent = `Chub: ${current}/${total} files`;
                                bulkLocalizeFileFill.style.width = `${(current / total) * 100}%`;
                            }
                        },
                        shouldAbort: () => bulkLocalizeAborted
                    });
                    
                    // Add Chub gallery stats to result
                    result.chubDownloaded = chubResult.success;
                    result.chubSkipped = chubResult.skipped;
                    result.chubErrors = chubResult.errors;
                    
                    totalDownloaded += chubResult.success;
                    totalSkipped += chubResult.skipped;
                    totalErrors += chubResult.errors;
                    
                    // Update stats
                    bulkStatDownloaded.textContent = totalDownloaded;
                    bulkStatSkipped.textContent = totalSkipped;
                    bulkStatErrors.textContent = totalErrors;
                    
                    // Clear cache if we downloaded anything
                    if (chubResult.success > 0 && char.avatar) {
                        clearMediaLocalizationCache(char.avatar);
                    }
                    
                    if (chubResult.aborted) {
                        result.incomplete = true;
                        bulkLocalizeResults.push(result);
                        break;
                    }
                    
                    if (chubResult.errors > 0) {
                        result.incomplete = true;
                    }
                } catch (err) {
                    console.error(`[BulkLocalize] Chub gallery error for ${charName}:`, err);
                    result.chubErrors = 1;
                    totalErrors++;
                    bulkStatErrors.textContent = totalErrors;
                }
            }
        }
        
        // Mark as complete in persistent storage if no errors and not aborted
        if (!result.incomplete && char.avatar) {
            markMediaLocalizationComplete(char.avatar);
        }
        
        bulkLocalizeResults.push(result);
        
        // Small delay to prevent UI lockup and allow abort to be processed
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Hide progress modal and show summary
    bulkLocalizeModal.classList.add('hidden');
    showBulkSummary(bulkLocalizeAborted, skippedCompleted);
    
    // Show toast
    const renamedMsg = totalRenamed > 0 ? `, renamed ${totalRenamed}` : '';
    if (bulkLocalizeAborted) {
        showToast(`Bulk localization stopped. Downloaded ${totalDownloaded} files${renamedMsg}.`, 'info');
    } else {
        showToast(`Bulk localization complete. Downloaded ${totalDownloaded} files${renamedMsg}.`, 'success');
    }
}

// Bulk Localize button in settings
document.getElementById('bulkLocalizeBtn')?.addEventListener('click', () => {
    // Close settings modal
    document.getElementById('gallerySettingsModal')?.classList.add('hidden');
    
    // Confirm with user
    if (allCharacters.length === 0) {
        showToast('No characters loaded', 'error');
        return;
    }
    
    // Check how many have already been completed
    const completedAvatars = getCompletedMediaLocalizations();
    const alreadyDone = allCharacters.filter(c => c.avatar && completedAvatars.has(c.avatar)).length;
    const remaining = allCharacters.length - alreadyDone;
    
    let confirmMsg;
    if (alreadyDone > 0) {
        confirmMsg = `${alreadyDone} of ${allCharacters.length} characters were previously processed and will be skipped.\n\n${remaining} characters will be scanned for remote media.\n\nContinue?`;
    } else {
        confirmMsg = `This will scan ${allCharacters.length} characters for remote media and download any new files.\n\nThis may take a while for large libraries. Continue?`;
    }
    
    if (confirm(confirmMsg)) {
        runBulkLocalization();
    }
});

// Clear bulk localize history button
document.getElementById('clearBulkLocalizeHistoryBtn')?.addEventListener('click', () => {
    const completedAvatars = getCompletedMediaLocalizations();
    const count = completedAvatars.size;
    
    if (count === 0) {
        showToast('No processed history to clear', 'info');
        return;
    }
    
    if (confirm(`This will clear the history of ${count} processed characters.\\n\\nThe next bulk localize will scan all characters again. Continue?`)) {
        clearCompletedMediaLocalizations();
        showToast(`Cleared history of ${count} processed characters`, 'success');
    }
});

// ==============================================
// On-the-fly Media Localization (URL Replacement)
// ==============================================

/**
 * Cache for URL→LocalPath mappings per character
 * Structure: { charAvatar: { remoteUrl: localPath, ... } }
 */
const mediaLocalizationCache = {};

/**
 * Sanitize a filename the same way saveMediaFromMemory does
 * This ensures we can match remote URLs to their saved local files
 */
function sanitizeMediaFilename(filename) {
    // Remove extension if present
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    // Same sanitization as saveMediaFromMemory
    return nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}

/**
 * Extract the filename from a remote URL
 */
function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        return pathParts[pathParts.length - 1] || '';
    } catch (e) {
        // Fallback for malformed URLs
        const parts = url.split('/');
        return parts[parts.length - 1]?.split('?')[0] || '';
    }
}

/**
 * Check if media localization is enabled for a character
 * @param {string} avatar - Character avatar filename (e.g., "Rory.png")
 * @returns {boolean} Whether localization is enabled
 */
function isMediaLocalizationEnabled(avatar) {
    const globalEnabled = getSetting('mediaLocalizationEnabled') !== false; // Default true
    const perCharSettings = getSetting('mediaLocalizationPerChar') || {};
    
    // Check per-character override first
    if (avatar && avatar in perCharSettings) {
        return perCharSettings[avatar];
    }
    
    // Fall back to global setting
    return globalEnabled;
}

/**
 * Check if a character has a per-character override (not using global setting)
 * @param {string} avatar - Character avatar filename
 * @returns {object} { hasOverride: boolean, isEnabled: boolean, globalEnabled: boolean }
 */
function getMediaLocalizationStatus(avatar) {
    const globalEnabled = getSetting('mediaLocalizationEnabled') !== false; // Default true
    const perCharSettings = getSetting('mediaLocalizationPerChar') || {};
    const hasOverride = avatar && avatar in perCharSettings;
    const isEnabled = hasOverride ? perCharSettings[avatar] : globalEnabled;
    
    return { hasOverride, isEnabled, globalEnabled };
}

/**
 * Set per-character media localization setting
 * @param {string} avatar - Character avatar filename
 * @param {boolean|null} enabled - true/false to override, null to use global
 */
function setCharacterMediaLocalization(avatar, enabled) {
    const perCharSettings = getSetting('mediaLocalizationPerChar') || {};
    
    if (enabled === null) {
        // Remove override, use global
        delete perCharSettings[avatar];
    } else {
        perCharSettings[avatar] = enabled;
    }
    
    setSetting('mediaLocalizationPerChar', perCharSettings);
}

/**
 * Build URL→LocalPath mapping for a character by scanning their gallery folder
 * @param {string} characterName - Character name (folder name)
 * @param {string} avatar - Character avatar filename (for cache key)
 * @param {boolean} forceRefresh - Force rebuild cache even if exists
 * @returns {Promise<Object>} Map of { remoteUrl: localPath }
 */
async function buildMediaLocalizationMap(characterName, avatar, forceRefresh = false) {
    // Check cache first
    if (!forceRefresh && avatar && mediaLocalizationCache[avatar]) {
        return mediaLocalizationCache[avatar];
    }
    
    const urlMap = {};
    const safeFolderName = sanitizeFolderName(characterName);
    
    try {
        // Get list of files in character's gallery (all media types = 7)
        const response = await apiRequest(ENDPOINTS.IMAGES_LIST, 'POST', { folder: characterName, type: 7 });
        
        if (!response.ok) {
            debugLog('[MediaLocalize] Could not list gallery files');
            return urlMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return urlMap;
        }
        
        // Parse localized_media files to build reverse mapping
        // Format: localized_media_{index}_{sanitizedOriginalName}.{ext}
        const localizedPattern = /^localized_media_\d+_(.+)\.[^.]+$/;
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only process media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const localPath = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            
            // Method 1: Check for localized_media_* pattern
            const match = fileName.match(localizedPattern);
            if (match) {
                const sanitizedName = match[1]; // The sanitized original filename
                urlMap[`__sanitized__${sanitizedName}`] = localPath;
            }
            
            // Method 2: Also map by the raw filename (without extension)
            // This catches files that were imported with their original names
            const nameWithoutExt = fileName.includes('.') 
                ? fileName.substring(0, fileName.lastIndexOf('.'))
                : fileName;
            // Store by original filename for direct matching
            urlMap[`__filename__${nameWithoutExt}`] = localPath;
        }
        
        // Cache the mapping
        if (avatar) {
            mediaLocalizationCache[avatar] = urlMap;
        }
        
        debugLog(`[MediaLocalize] Built map for ${characterName}: ${Object.keys(urlMap).length} entries`);
        return urlMap;
        
    } catch (error) {
        console.error('[MediaLocalize] Error building localization map:', error);
        return urlMap;
    }
}

/**
 * Look up a remote URL in the localization map and return local path if found
 * @param {Object} urlMap - The localization map from buildMediaLocalizationMap
 * @param {string} remoteUrl - The remote URL to look up
 * @returns {string|null} Local path if found, null otherwise
 */
function lookupLocalizedMedia(urlMap, remoteUrl) {
    if (!urlMap || !remoteUrl) return null;
    
    // Extract filename from URL
    const filename = extractFilenameFromUrl(remoteUrl);
    if (!filename) return null;
    
    // Get filename without extension for direct matching
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    
    // Method 1: Try direct filename match first (most reliable)
    let localPath = urlMap[`__filename__${nameWithoutExt}`];
    if (localPath) return localPath;
    
    // Method 2: Try sanitized name match (for localized_media_* files)
    const sanitizedName = sanitizeMediaFilename(filename);
    localPath = urlMap[`__sanitized__${sanitizedName}`];
    
    return localPath || null;
}

/**
 * Replace remote media URLs in text with local paths
 * @param {string} text - Text containing media URLs (markdown/HTML)
 * @param {Object} urlMap - The localization map
 * @returns {string} Text with URLs replaced
 */
function replaceMediaUrlsInText(text, urlMap) {
    if (!text || !urlMap || Object.keys(urlMap).length === 0) return text;
    
    let result = text;
    
    // Replace markdown images: ![alt](url)
    result = result.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `![${alt}](${localPath})`;
        }
        return match;
    });
    
    // Replace markdown links to media: [text](url.ext)
    result = result.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))(?:\s+"[^"]*)?\)/gi, (match, text, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `[${text}](${localPath})`;
        }
        return match;
    });
    
    // Replace HTML img src: <img src="url">
    result = result.replace(/<img([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<img${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace video sources: <video src="url"> or <source src="url">
    result = result.replace(/<(video|source)([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, tag, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<${tag}${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace audio sources: <audio src="url">
    result = result.replace(/<audio([^>]+)src=["']([^"']+)["']([^>]*)>/gi, (match, before, url, after) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return `<audio${before}src="${localPath}"${after}>`;
        }
        return match;
    });
    
    // Replace raw media URLs (not already in markdown or HTML tags)
    // This handles URLs that appear as plain text
    result = result.replace(/(^|[^"'(])((https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a)))(?=[)\s<"']|$)/gi, (match, prefix, url) => {
        const localPath = lookupLocalizedMedia(urlMap, url);
        if (localPath) {
            return prefix + localPath;
        }
        return match;
    });
    
    // Final fallback: Direct string replacement for any remaining URLs
    // This catches URLs in any format the regex patterns might have missed
    // Build list of all remote URLs we have local versions for
    for (const [key, localPath] of Object.entries(urlMap)) {
        if (!key.startsWith('__sanitized__')) continue;
        const sanitizedName = key.replace('__sanitized__', '');
        
        // Find any remaining remote URLs with this filename and replace them
        // Match the filename in any imageshack/catbox/etc URL pattern
        const filenamePattern = new RegExp(
            `(https?://[^\\s"'<>]+[/=])${sanitizedName}(\\.[a-z0-9]+)`,
            'gi'
        );
        result = result.replace(filenamePattern, () => localPath);
    }
    
    return result;
}

/**
 * Apply media localization to already-rendered modal content
 * Called asynchronously after modal opens to update URLs without blocking
 * @param {Object} char - Character object
 * @param {string} desc - Original description
 * @param {string} firstMes - Original first message
 * @param {Array} altGreetings - Original alternate greetings
 * @param {string} creatorNotes - Original creator notes
 */
async function applyMediaLocalizationToModal(char, desc, firstMes, altGreetings, creatorNotes) {
    const avatar = char?.avatar;
    const charName = char?.name || char?.data?.name || '';
    // Use proper gallery folder name (may include _uuid suffix)
    const folderName = getGalleryFolderName(char);
    
    // Check if localization is enabled
    if (!avatar || !isMediaLocalizationEnabled(avatar)) {
        return;
    }
    
    // Build the URL map using the actual gallery folder
    const urlMap = await buildMediaLocalizationMap(folderName, avatar);
    
    if (Object.keys(urlMap).length === 0) {
        return; // No localized files, nothing to replace
    }
    
    debugLog(`[MediaLocalize] Applying localization to modal for ${charName}`);
    
    // Update Description
    if (desc) {
        const localizedDesc = replaceMediaUrlsInText(desc, urlMap);
        if (localizedDesc !== desc) {
            document.getElementById('modalDescription').innerHTML = formatRichText(localizedDesc, charName);
        }
    }
    
    // Update First Message
    if (firstMes) {
        const localizedFirstMes = replaceMediaUrlsInText(firstMes, urlMap);
        if (localizedFirstMes !== firstMes) {
            document.getElementById('modalFirstMes').innerHTML = formatRichText(localizedFirstMes, charName);
        }
    }
    
    // Update Alternate Greetings
    if (altGreetings && altGreetings.length > 0) {
        let anyChanged = false;
        const listHTML = altGreetings.map((g, i) => {
            const original = (g || '').trim();
            const localized = replaceMediaUrlsInText(original, urlMap);
            if (localized !== original) anyChanged = true;
            return `<div style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.1);"><strong style="color:var(--accent);">#${i+1}:</strong> <span>${formatRichText(localized, charName)}</span></div>`;
        }).join('');
        
        if (anyChanged) {
            document.getElementById('modalAltGreetings').innerHTML = listHTML;
        }
    }
    
    // Update Creator Notes (re-render if content changed)
    if (creatorNotes) {
        const localizedNotes = replaceMediaUrlsInText(creatorNotes, urlMap);
        if (localizedNotes !== creatorNotes) {
            const notesContainer = document.getElementById('modalCreatorNotes');
            if (notesContainer) {
                renderCreatorNotesSecure(localizedNotes, charName, notesContainer);
            }
        }
    }
}

/**
 * Clear the media localization cache for a character (call after downloading new media)
 */
function clearMediaLocalizationCache(avatar) {
    if (avatar && mediaLocalizationCache[avatar]) {
        delete mediaLocalizationCache[avatar];
        debugLog(`[MediaLocalize] Cleared cache for ${avatar}`);
    }
}

/**
 * Clear entire media localization cache
 */
function clearAllMediaLocalizationCache() {
    Object.keys(mediaLocalizationCache).forEach(key => delete mediaLocalizationCache[key]);
    debugLog('[MediaLocalize] Cleared all cache');
}

// ==============================================
// Duplicate Detection Feature
// ==============================================

/**
 * Simple hash function that works in non-secure contexts (HTTP)
 * Uses a combination of file size and content sampling
 */
function simpleHash(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.length;
    
    // Create a fingerprint from: size + first 1KB + last 1KB + sampled bytes
    let hash = len;
    
    // Mix in first 1024 bytes
    const firstChunk = Math.min(1024, len);
    for (let i = 0; i < firstChunk; i++) {
        hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    
    // Mix in last 1024 bytes
    const lastStart = Math.max(0, len - 1024);
    for (let i = lastStart; i < len; i++) {
        hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    
    // Sample every 4KB for large files
    if (len > 8192) {
        const step = Math.floor(len / 100);
        for (let i = 0; i < len; i += step) {
            hash = ((hash << 5) - hash + bytes[i]) | 0;
        }
    }
    
    // Convert to hex string
    return (hash >>> 0).toString(16).padStart(8, '0') + '_' + len.toString(16);
}

/**
 * Calculate hash of an ArrayBuffer - uses crypto.subtle if available, falls back to simpleHash
 */
async function calculateHash(arrayBuffer) {
    // Try crypto.subtle first (only works in secure contexts - HTTPS or localhost)
    if (window.crypto && window.crypto.subtle) {
        try {
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            debugLog('[Duplicates] crypto.subtle failed, using fallback hash');
        }
    }
    
    // Fallback to simple hash for HTTP contexts
    return simpleHash(arrayBuffer);
}

// ========================================
// CHARACTER DUPLICATE DETECTION SYSTEM
// ========================================

// Duplicate scan cache
let duplicateScanCache = {
    timestamp: 0,
    charCount: 0,
    groups: [],
    normalizedData: null // Pre-computed normalized character data
};
const DUPLICATE_CACHE_TTL = 60000; // 1 minute cache validity

// State for returning to duplicate modal after viewing a card
let duplicateModalState = {
    wasOpen: false,
    expandedGroups: new Set(),
    scrollPosition: 0
};

// State for returning to bulk summary modal after viewing a character
let bulkSummaryModalState = {
    wasOpen: false,
    scrollPosition: 0,
    currentPage: 1,
    filterValue: 'all',
    searchValue: ''
};

/**
 * Pre-compute normalized data for all characters
 * This significantly speeds up comparisons by doing normalization once
 */
function buildNormalizedCharacterData() {
    return allCharacters.map(char => {
        if (!char) return null;
        
        const name = getCharField(char, 'name') || '';
        const normalizedName = normalizeCharName(name);
        const creator = (getCharField(char, 'creator') || '').toLowerCase().trim();
        const description = getCharField(char, 'description') || '';
        const firstMes = getCharField(char, 'first_mes') || '';
        const personality = getCharField(char, 'personality') || '';
        const scenario = getCharField(char, 'scenario') || '';
        
        // Pre-extract words for content similarity (expensive operation)
        const getWords = (text) => {
            if (!text || text.length < 50) return null;
            const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
            return new Set(words);
        };
        
        return {
            avatar: char.avatar,
            char: char,
            name: name,
            nameLower: name.toLowerCase().trim(),
            normalizedName: normalizedName,
            creator: creator,
            description: description,
            firstMes: firstMes,
            personality: personality,
            scenario: scenario,
            // Pre-computed word sets for Jaccard similarity
            descWords: getWords(description),
            firstMesWords: getWords(firstMes),
            persWords: getWords(personality),
            scenWords: getWords(scenario)
        };
    }).filter(Boolean);
}

/**
 * Fast word set similarity using pre-computed word sets
 */
function wordSetSimilarity(wordsA, wordsB) {
    if (!wordsA || !wordsB) return 0;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    
    let intersection = 0;
    for (const word of wordsA) {
        if (wordsB.has(word)) intersection++;
    }
    
    const union = wordsA.size + wordsB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Fast similarity calculation using pre-normalized data
 */
function calculateFastSimilarity(normA, normB) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    
    // === NAME COMPARISON (fast path) ===
    if (normA.nameLower === normB.nameLower && normA.nameLower) {
        score += 25;
        breakdown.name = 25;
        matchReasons.push('Exact name match');
    } else if (normA.normalizedName === normB.normalizedName && normA.normalizedName.length > 2) {
        score += 20;
        breakdown.name = 20;
        matchReasons.push('Name variant match');
    } else if (normA.normalizedName.length > 2 && normB.normalizedName.length > 2) {
        const nameSim = stringSimilarity(normA.normalizedName, normB.normalizedName);
        if (nameSim >= 0.7) {
            const nameScore = Math.round(nameSim * 15);
            score += nameScore;
            breakdown.name = nameScore;
            if (nameSim >= 0.85) {
                matchReasons.push(`${Math.round(nameSim * 100)}% name similarity`);
            }
        }
    }
    
    // Early exit if names don't match at all (no point comparing content)
    if (!breakdown.name) return { score: 0, breakdown: {}, confidence: null, matchReason: '', matchReasons: [] };
    
    // === CREATOR COMPARISON ===
    if (normA.creator && normB.creator && normA.creator === normB.creator) {
        score += 20;
        breakdown.creator = 20;
        matchReasons.push('Same creator');
    }
    
    // === CONTENT COMPARISONS (using pre-computed word sets) ===
    if (normA.descWords && normB.descWords) {
        const descSim = wordSetSimilarity(normA.descWords, normB.descWords);
        if (descSim >= 0.3) {
            const descScore = Math.round(descSim * 20);
            score += descScore;
            breakdown.description = descScore;
            if (descSim >= 0.7) matchReasons.push(`${Math.round(descSim * 100)}% description match`);
        }
    } else if (normA.description && normB.description) {
        // Fallback for short descriptions
        const descSim = stringSimilarity(normA.description, normB.description);
        if (descSim >= 0.3) {
            const descScore = Math.round(descSim * 20);
            score += descScore;
            breakdown.description = descScore;
        }
    }
    
    if (normA.firstMesWords && normB.firstMesWords) {
        const fmSim = wordSetSimilarity(normA.firstMesWords, normB.firstMesWords);
        if (fmSim >= 0.3) {
            const fmScore = Math.round(fmSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
            if (fmSim >= 0.7) matchReasons.push(`${Math.round(fmSim * 100)}% first message match`);
        }
    } else if (normA.firstMes && normB.firstMes) {
        const fmSim = stringSimilarity(normA.firstMes, normB.firstMes);
        if (fmSim >= 0.3) {
            const fmScore = Math.round(fmSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
        }
    }
    
    if (normA.persWords && normB.persWords) {
        const persSim = wordSetSimilarity(normA.persWords, normB.persWords);
        if (persSim >= 0.3) {
            const persScore = Math.round(persSim * 10);
            score += persScore;
            breakdown.personality = persScore;
        }
    }
    
    if (normA.scenWords && normB.scenWords) {
        const scenSim = wordSetSimilarity(normA.scenWords, normB.scenWords);
        if (scenSim >= 0.3) {
            const scenScore = Math.round(scenSim * 5);
            score += scenScore;
            breakdown.scenario = scenScore;
        }
    }
    
    // === DETERMINE CONFIDENCE ===
    // Use configurable minimum score threshold
    const minScore = getSetting('duplicateMinScore') || 35;
    let confidence = null;
    if (score >= 60) confidence = 'high';
    else if (score >= 40) confidence = 'medium';
    else if (score >= minScore) confidence = 'low';
    
    let matchReason = matchReasons.length > 0 
        ? matchReasons.slice(0, 3).join(', ')
        : (confidence ? `${score} point similarity score` : '');
    
    return { score, breakdown, confidence, matchReason, matchReasons };
}

/**
 * Normalize a character name for comparison
 * Removes version suffixes, extra whitespace, etc.
 */
function normalizeCharName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        // Remove version suffixes like v2, v3, ver2, version 2, etc.
        .replace(/\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i, '')
        .replace(/\s*-?\s*v\d+(\.\d+)*$/i, '')
        // Remove common suffixes
        .replace(/\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup)[\)\]\}]?\s*$/i, '')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses Levenshtein distance for fuzzy matching
 */
function stringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    
    // Levenshtein distance for fuzzy matching
    const len1 = s1.length;
    const len2 = s2.length;
    
    // Quick exit for very different lengths
    if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.5) return 0;
    
    const matrix = [];
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    return 1 - (distance / maxLen);
}

/**
 * Calculate content similarity for longer text fields
 * Uses word overlap / Jaccard similarity for better performance on long texts
 */
function contentSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const t1 = text1.toLowerCase().trim();
    const t2 = text2.toLowerCase().trim();
    
    if (t1 === t2) return 1;
    if (!t1 || !t2) return 0;
    
    // For very short texts, use string similarity
    if (t1.length < 50 || t2.length < 50) {
        return stringSimilarity(t1, t2);
    }
    
    // Extract words (3+ chars) for comparison
    const getWords = (text) => {
        const words = text.match(/\b\w{3,}\b/g) || [];
        return new Set(words.map(w => w.toLowerCase()));
    };
    
    const words1 = getWords(t1);
    const words2 = getWords(t2);
    
    if (words1.size === 0 || words2.size === 0) return 0;
    
    // Jaccard similarity: intersection / union
    let intersection = 0;
    for (const word of words1) {
        if (words2.has(word)) intersection++;
    }
    
    const union = words1.size + words2.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Get character field value with fallbacks
 */
function getCharField(char, field) {
    if (!char) return '';
    return char[field] || (char.data ? char.data[field] : '') || '';
}

/**
 * Calculate token count estimate from character data (cached)
 */
function estimateTokens(char) {
    // Use avatar as cache key since it's unique per character
    const cacheKey = `tokens_${char?.avatar || char?.name || ''}`;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;
    
    const desc = getCharField(char, 'description') || '';
    const personality = getCharField(char, 'personality') || '';
    const scenario = getCharField(char, 'scenario') || '';
    const firstMes = getCharField(char, 'first_mes') || '';
    const sysprompt = getCharField(char, 'system_prompt') || '';
    
    const totalText = desc + personality + scenario + firstMes + sysprompt;
    // Rough estimate: ~4 chars per token
    const tokens = Math.round(totalText.length / 4);
    
    setCached(cacheKey, tokens);
    return tokens;
}

/**
 * Calculate a comprehensive similarity score between two characters
 * Returns { score, breakdown, confidence, matchReasons }
 * 
 * Scoring weights:
 * - Name exact match: 25 pts
 * - Name normalized match: 20 pts  
 * - Name similarity (scaled): up to 15 pts
 * - Same creator (non-empty): 20 pts
 * - Description similarity: up to 20 pts
 * - First message similarity: up to 15 pts
 * - Personality similarity: up to 10 pts
 * - Scenario similarity: up to 5 pts
 * 
 * Confidence thresholds:
 * - High: 60+ points (requires multiple strong matches)
 * - Medium: 40-59 points
 * - Low: configurable minimum (default 35) - 39 points
 * - No match: below minimum threshold
 */
function calculateCharacterSimilarity(charA, charB) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    
    // === NAME COMPARISON (reduced weight - some creators use taglines) ===
    const nameA = getCharField(charA, 'name') || '';
    const nameB = getCharField(charB, 'name') || '';
    const normalizedNameA = normalizeCharName(nameA);
    const normalizedNameB = normalizeCharName(nameB);
    
    if (nameA.toLowerCase().trim() === nameB.toLowerCase().trim() && nameA) {
        score += 20;
        breakdown.name = 20;
        matchReasons.push('Exact name match');
    } else if (normalizedNameA === normalizedNameB && normalizedNameA.length > 2) {
        score += 15;
        breakdown.name = 15;
        matchReasons.push('Name variant match');
    } else if (normalizedNameA.length > 2 && normalizedNameB.length > 2) {
        const nameSim = stringSimilarity(normalizedNameA, normalizedNameB);
        if (nameSim >= 0.7) {
            const nameScore = Math.round(nameSim * 12);
            score += nameScore;
            breakdown.name = nameScore;
            if (nameSim >= 0.85) {
                matchReasons.push(`${Math.round(nameSim * 100)}% name similarity`);
            }
        }
    }
    
    // === CREATOR COMPARISON ===
    const creatorA = getCharField(charA, 'creator') || '';
    const creatorB = getCharField(charB, 'creator') || '';
    
    if (creatorA && creatorB && creatorA.toLowerCase().trim() === creatorB.toLowerCase().trim()) {
        score += 20;
        breakdown.creator = 20;
        matchReasons.push('Same creator');
    }
    
    // === CREATOR NOTES COMPARISON (weighted heavily - often unique identifier) ===
    const notesA = getCharField(charA, 'creator_notes') || '';
    const notesB = getCharField(charB, 'creator_notes') || '';
    
    if (notesA && notesB && notesA.length > 50 && notesB.length > 50) {
        const notesSim = contentSimilarity(notesA, notesB);
        if (notesSim >= 0.25) { // Lower threshold - creator notes often have CSS/HTML differences
            const notesScore = Math.round(notesSim * 25);
            score += notesScore;
            breakdown.creator_notes = notesScore;
            if (notesSim >= 0.6) {
                matchReasons.push(`${Math.round(notesSim * 100)}% creator notes match`);
            }
        }
    }
    
    // === DESCRIPTION COMPARISON (increased weight) ===
    const descA = getCharField(charA, 'description') || '';
    const descB = getCharField(charB, 'description') || '';
    
    if (descA && descB && descA.length > 50 && descB.length > 50) {
        const descSim = contentSimilarity(descA, descB);
        if (descSim >= 0.25) { // Lower threshold
            const descScore = Math.round(descSim * 25);
            score += descScore;
            breakdown.description = descScore;
            if (descSim >= 0.6) {
                matchReasons.push(`${Math.round(descSim * 100)}% description match`);
            }
        }
    }
    
    // === FIRST MESSAGE COMPARISON ===
    const firstMesA = getCharField(charA, 'first_mes') || '';
    const firstMesB = getCharField(charB, 'first_mes') || '';
    
    if (firstMesA && firstMesB && firstMesA.length > 30 && firstMesB.length > 30) {
        const firstMesSim = contentSimilarity(firstMesA, firstMesB);
        if (firstMesSim >= 0.25) {
            const fmScore = Math.round(firstMesSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
            if (firstMesSim >= 0.6) {
                matchReasons.push(`${Math.round(firstMesSim * 100)}% first message match`);
            }
        }
    }
    
    // === PERSONALITY COMPARISON ===
    const persA = getCharField(charA, 'personality') || '';
    const persB = getCharField(charB, 'personality') || '';
    
    if (persA && persB && persA.length > 20 && persB.length > 20) {
        const persSim = contentSimilarity(persA, persB);
        if (persSim >= 0.3) {
            const persScore = Math.round(persSim * 10);
            score += persScore;
            breakdown.personality = persScore;
            if (persSim >= 0.7) {
                matchReasons.push(`${Math.round(persSim * 100)}% personality match`);
            }
        }
    }
    
    // === SCENARIO COMPARISON ===
    const scenA = getCharField(charA, 'scenario') || '';
    const scenB = getCharField(charB, 'scenario') || '';
    
    if (scenA && scenB && scenA.length > 20 && scenB.length > 20) {
        const scenSim = contentSimilarity(scenA, scenB);
        if (scenSim >= 0.3) {
            const scenScore = Math.round(scenSim * 5);
            score += scenScore;
            breakdown.scenario = scenScore;
        }
    }
    
    // === DETERMINE CONFIDENCE ===
    // Use configurable minimum score threshold
    const minScore = getSetting('duplicateMinScore') || 35;
    let confidence = null;
    if (score >= 60) {
        confidence = 'high';
    } else if (score >= 40) {
        confidence = 'medium';
    } else if (score >= minScore) {
        confidence = 'low';
    }
    
    // Build match reason string
    let matchReason = '';
    if (matchReasons.length > 0) {
        matchReason = matchReasons.slice(0, 3).join(', '); // Max 3 reasons
    } else if (confidence) {
        matchReason = `${score} point similarity score`;
    }
    
    return {
        score,
        breakdown,
        confidence,
        matchReason,
        matchReasons
    };
}

/**
 * Find all potential duplicate groups in the library (async with progress)
 * Uses caching and chunked processing to avoid blocking the browser
 */
async function findCharacterDuplicates(forceRefresh = false) {
    const now = Date.now();
    
    // Check cache validity
    if (!forceRefresh && 
        duplicateScanCache.groups.length > 0 &&
        duplicateScanCache.charCount === allCharacters.length &&
        (now - duplicateScanCache.timestamp) < DUPLICATE_CACHE_TTL) {
        debugLog('[Duplicates] Using cached results');
        return duplicateScanCache.groups;
    }
    
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    const totalChars = allCharacters.length;
    
    debugLog('[Duplicates] Scanning', totalChars, 'characters...');
    
    // Phase 1: Build normalized data (show progress)
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing character data...';
    }
    
    // Yield to UI
    await new Promise(r => setTimeout(r, 10));
    
    const normalizedData = buildNormalizedCharacterData();
    
    if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Comparing characters (0%)...';
    }
    
    // Phase 2: Compare characters in chunks
    const groups = [];
    const processed = new Set();
    const CHUNK_SIZE = 50; // Process 50 characters per chunk
    
    for (let i = 0; i < normalizedData.length; i++) {
        const normA = normalizedData[i];
        if (!normA || processed.has(normA.avatar)) continue;
        
        const duplicates = [];
        
        for (let j = i + 1; j < normalizedData.length; j++) {
            const normB = normalizedData[j];
            if (!normB || processed.has(normB.avatar)) continue;
            
            // Use fast similarity with pre-normalized data
            const similarity = calculateFastSimilarity(normA, normB);
            
            if (similarity.confidence) {
                duplicates.push({
                    char: normB.char,
                    confidence: similarity.confidence,
                    matchReason: similarity.matchReason,
                    score: similarity.score,
                    breakdown: similarity.breakdown
                });
            }
        }
        
        if (duplicates.length > 0) {
            processed.add(normA.avatar);
            duplicates.forEach(d => processed.add(d.char.avatar));
            
            const confidenceOrder = { high: 3, medium: 2, low: 1 };
            const groupConfidence = duplicates.reduce((max, d) => 
                confidenceOrder[d.confidence] > confidenceOrder[max] ? d.confidence : max
            , duplicates[0].confidence);
            
            duplicates.sort((a, b) => b.score - a.score);
            
            groups.push({
                reference: normA.char,
                duplicates,
                confidence: groupConfidence
            });
        }
        
        // Update progress and yield to UI every chunk
        if (i % CHUNK_SIZE === 0 && i > 0) {
            const percent = Math.round((i / normalizedData.length) * 100);
            if (statusEl) {
                statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Comparing characters (${percent}%)...`;
            }
            await new Promise(r => setTimeout(r, 0)); // Yield to UI
        }
    }
    
    // Sort groups
    const confidenceSort = { high: 0, medium: 1, low: 2 };
    groups.sort((a, b) => {
        const confDiff = confidenceSort[a.confidence] - confidenceSort[b.confidence];
        if (confDiff !== 0) return confDiff;
        const aMaxScore = Math.max(...a.duplicates.map(d => d.score));
        const bMaxScore = Math.max(...b.duplicates.map(d => d.score));
        return bMaxScore - aMaxScore;
    });
    
    // Update cache
    duplicateScanCache = {
        timestamp: now,
        charCount: allCharacters.length,
        groups: groups,
        normalizedData: normalizedData
    };
    
    debugLog('[Duplicates] Found', groups.length, 'potential duplicate groups');
    
    return groups;
}

/**
 * Check if a new character has potential duplicates in library
 * Returns array of potential matches
 */
function checkCharacterForDuplicates(newChar) {
    const matches = [];
    
    const newFullPath = (newChar.fullPath || newChar.full_path || '').toLowerCase();
    
    // Build a pseudo-character object for comparison
    const newCharObj = {
        name: newChar.name || newChar.definition?.name || '',
        creator: newChar.creator || newChar.definition?.creator || '',
        description: newChar.description || newChar.definition?.description || '',
        first_mes: newChar.first_mes || newChar.definition?.first_mes || '',
        personality: newChar.personality || newChar.definition?.personality || '',
        scenario: newChar.scenario || newChar.definition?.scenario || '',
        creator_notes: newChar.creator_notes || newChar.definition?.creator_notes || ''
    };
    
    for (const existing of allCharacters) {
        if (!existing) continue;
        
        // Check for ChubAI path match first (definitive match)
        const existingChubUrl = existing.data?.extensions?.chub?.url || 
                               existing.data?.extensions?.chub?.full_path ||
                               existing.chub_url || 
                               existing.source_url || '';
        if (newFullPath && existingChubUrl) {
            const match = existingChubUrl.match(/characters\/([^\/]+\/[^\/\?]+)/);
            const existingPath = match ? match[1].toLowerCase() : existingChubUrl.toLowerCase();
            if (existingPath === newFullPath || existingPath.includes(newFullPath)) {
                matches.push({
                    char: existing,
                    confidence: 'high',
                    matchReason: 'Same ChubAI character (exact path match)',
                    score: 100,
                    breakdown: { chubPath: 100 }
                });
                continue;
            }
        }
        
        // Calculate comprehensive similarity
        const similarity = calculateCharacterSimilarity(newCharObj, existing);
        
        if (similarity.confidence) {
            matches.push({
                char: existing,
                confidence: similarity.confidence,
                matchReason: similarity.matchReason,
                score: similarity.score,
                breakdown: similarity.breakdown
            });
        }
    }
    
    // Sort by score (highest first)
    matches.sort((a, b) => b.score - a.score);
    
    return matches;
}

/**
 * Render a field diff between two characters - side by side comparison
 */
function renderFieldDiff(fieldName, valueA, valueB, labelA = 'Keep', labelB = 'Duplicate') {
    valueA = valueA || '';
    valueB = valueB || '';
    
    // Normalize for comparison - handle invisible whitespace differences
    const normalizeText = (text) => {
        return text
            .replace(/\r\n/g, '\n')           // Normalize line endings
            .replace(/\r/g, '\n')             // Handle old Mac line endings
            .replace(/\u00A0/g, ' ')          // Non-breaking space to regular space
            .replace(/\u200B/g, '')           // Remove zero-width spaces
            .replace(/\t/g, '    ')           // Tabs to 4 spaces
            .replace(/ +/g, ' ')              // Multiple spaces to single
            .replace(/ *\n */g, '\n')         // Trim spaces around newlines
            .trim();
    };
    
    const normA = normalizeText(valueA);
    const normB = normalizeText(valueB);
    const isSame = normA === normB;
    
    // Check if normalization made a difference (raw values differ but normalized are same)
    const rawDiffers = valueA !== valueB;
    const normalizedAway = isSame && rawDiffers;
    
    // Both empty - don't show
    if (isSame && !normA) return { html: '', isSame: true, isEmpty: true, normalizedAway: false };
    
    // Get icon for field type
    const icons = {
        'Description': 'fa-solid fa-scroll',
        'Personality': 'fa-solid fa-brain',
        'First Message': 'fa-solid fa-comment',
        'Scenario': 'fa-solid fa-map',
        'Example Messages': 'fa-solid fa-comments',
        'System Prompt': 'fa-solid fa-terminal',
        'Creator Notes': 'fa-solid fa-sticky-note',
        'Tags': 'fa-solid fa-tags'
    };
    const icon = icons[fieldName] || 'fa-solid fa-file-alt';
    
    // Identical content (after normalization) - show once
    if (isSame) {
        const wsNote = normalizedAway ? '<span class="diff-ws-note" title="The raw text differs only in whitespace (spaces, tabs, line endings)"><i class="fa-solid fa-asterisk"></i> whitespace differs</span>' : '';
        const html = `<div class="char-dup-diff-section"><div class="char-dup-diff-label"><i class="${icon}"></i> ${escapeHtml(fieldName)} ${wsNote}</div><div class="char-dup-diff-content same"><div class="char-dup-diff-content-label">Both versions identical</div><div class="diff-text-content">${escapeHtml(normA)}</div></div></div>`;
        return { html, isSame: true, isEmpty: false, normalizedAway };
    }
    
    // Different content - show with diff highlighting
    let keepHtml, dupHtml;
    
    if (!normA) {
        keepHtml = '<span class="diff-empty">(empty)</span>';
        dupHtml = `<span class="diff-added">${escapeHtml(normB)}</span>`;
    } else if (!normB) {
        keepHtml = `<span class="diff-removed">${escapeHtml(normA)}</span>`;
        dupHtml = '<span class="diff-empty">(empty)</span>';
    } else {
        // Both have content - find and highlight differences
        const diffStart = findFirstDifference(normA, normB);
        const diffEnd = findLastDifference(normA, normB);
        
        if (diffStart === -1) {
            // No difference found (shouldn't happen since we checked isSame)
            keepHtml = escapeHtml(normA);
            dupHtml = escapeHtml(normB);
        } else {
            const oldChangeEnd = diffEnd.pos1 + 1;
            const newChangeEnd = diffEnd.pos2 + 1;
            keepHtml = buildHighlightedString(normA, diffStart, oldChangeEnd, 'diff-removed');
            dupHtml = buildHighlightedString(normB, diffStart, newChangeEnd, 'diff-added');
        }
    }
    
    const html = `<div class="char-dup-diff-section"><div class="char-dup-diff-label"><i class="${icon}"></i> ${escapeHtml(fieldName)}</div><div class="char-dup-diff-stack"><div class="char-dup-diff-content keep"><div class="char-dup-diff-content-label"><i class="fa-solid fa-check"></i> ${escapeHtml(labelA)}</div><div class="diff-text-content">${keepHtml}</div></div><div class="char-dup-diff-content duplicate"><div class="char-dup-diff-content-label"><i class="fa-solid fa-trash"></i> ${escapeHtml(labelB)}</div><div class="diff-text-content">${dupHtml}</div></div></div></div>`;
    return { html, isSame: false, isEmpty: false, normalizedAway: false };
}

/**
 * Render a tag comparison diff for duplicate detection
 * @param {Array} tagsA - Tags from the first character
 * @param {Array} tagsB - Tags from the second character
 * @returns {Object} Object with html, isSame, isEmpty flags
 */
function renderTagsDiff(tagsA, tagsB) {
    const arrA = Array.isArray(tagsA) ? tagsA.map(t => String(t).trim()).filter(t => t) : [];
    const arrB = Array.isArray(tagsB) ? tagsB.map(t => String(t).trim()).filter(t => t) : [];
    
    const setA = new Set(arrA);
    const setB = new Set(arrB);
    
    // Find differences
    const onlyInA = arrA.filter(t => !setB.has(t));
    const onlyInB = arrB.filter(t => !setA.has(t));
    const inBoth = arrA.filter(t => setB.has(t));
    
    const isSame = onlyInA.length === 0 && onlyInB.length === 0;
    const isEmpty = arrA.length === 0 && arrB.length === 0;
    
    if (isEmpty) return { html: '', isSame: true, isEmpty: true };
    
    const icon = 'fa-solid fa-tags';
    
    // Helper to render tag pills
    const renderTagPill = (tag, className = '') => 
        `<span class="dup-tag-pill ${className}">${escapeHtml(tag)}</span>`;
    
    if (isSame) {
        // All tags identical
        const tagPills = arrA.map(t => renderTagPill(t)).join('');
        const html = `
            <div class="char-dup-diff-section">
                <div class="char-dup-diff-label"><i class="${icon}"></i> Tags (${arrA.length})</div>
                <div class="char-dup-diff-content same">
                    <div class="char-dup-diff-content-label">Both versions identical</div>
                    <div class="dup-tags-container">${tagPills}</div>
                </div>
            </div>`;
        return { html, isSame: true, isEmpty: false };
    }
    
    // Tags differ - show comparison
    const keepTagsHtml = arrA.length === 0 
        ? '<span class="diff-empty">(no tags)</span>'
        : arrA.map(t => renderTagPill(t, setB.has(t) ? 'dup-tag-same' : 'dup-tag-removed')).join('');
    
    const dupTagsHtml = arrB.length === 0
        ? '<span class="diff-empty">(no tags)</span>'
        : arrB.map(t => renderTagPill(t, setA.has(t) ? 'dup-tag-same' : 'dup-tag-added')).join('');
    
    // Summary of differences
    const diffSummary = [];
    if (onlyInA.length > 0) diffSummary.push(`${onlyInA.length} only in Keep`);
    if (onlyInB.length > 0) diffSummary.push(`${onlyInB.length} only in Duplicate`);
    if (inBoth.length > 0) diffSummary.push(`${inBoth.length} shared`);
    
    const html = `
        <div class="char-dup-diff-section">
            <div class="char-dup-diff-label"><i class="${icon}"></i> Tags <span class="dup-diff-summary">(${diffSummary.join(', ')})</span></div>
            <div class="char-dup-diff-container">
                <div class="char-dup-diff-stack">
                    <div class="char-dup-diff-content keep">
                        <div class="char-dup-diff-content-label">Keep (${arrA.length})</div>
                        <div class="dup-tags-container">${keepTagsHtml}</div>
                    </div>
                    <div class="char-dup-diff-content duplicate">
                        <div class="char-dup-diff-content-label">Duplicate (${arrB.length})</div>
                        <div class="dup-tags-container">${dupTagsHtml}</div>
                    </div>
                </div>
            </div>
        </div>`;
    
    return { html, isSame: false, isEmpty: false };
}

/**
 * Compare two characters and return difference indicators
 * @param {Object} refChar - Reference character
 * @param {Object} dupChar - Duplicate character to compare
 * @returns {Object} Object with diff flags for each field
 */
function compareCharacterDifferences(refChar, dupChar) {
    const refName = getCharField(refChar, 'name') || '';
    const dupName = getCharField(dupChar, 'name') || '';
    const refCreator = getCharField(refChar, 'creator') || '';
    const dupCreator = getCharField(dupChar, 'creator') || '';
    const refTokens = estimateTokens(refChar);
    const dupTokens = estimateTokens(dupChar);
    
    // Get dates
    let refDate = null, dupDate = null;
    if (refChar.date_added) refDate = new Date(Number(refChar.date_added));
    else if (refChar.create_date) refDate = new Date(refChar.create_date);
    if (dupChar.date_added) dupDate = new Date(Number(dupChar.date_added));
    else if (dupChar.create_date) dupDate = new Date(dupChar.create_date);
    
    // Compare content fields
    const refDesc = (getCharField(refChar, 'description') || '').trim();
    const dupDesc = (getCharField(dupChar, 'description') || '').trim();
    const refFirstMes = (getCharField(refChar, 'first_mes') || '').trim();
    const dupFirstMes = (getCharField(dupChar, 'first_mes') || '').trim();
    const refPers = (getCharField(refChar, 'personality') || '').trim();
    const dupPers = (getCharField(dupChar, 'personality') || '').trim();
    const refScenario = (getCharField(refChar, 'scenario') || '').trim();
    const dupScenario = (getCharField(dupChar, 'scenario') || '').trim();
    
    // Compare tags
    const refTags = getTags(refChar);
    const dupTags = getTags(dupChar);
    const refTagSet = new Set(refTags.map(t => String(t).toLowerCase().trim()));
    const dupTagSet = new Set(dupTags.map(t => String(t).toLowerCase().trim()));
    const tagsMatch = refTagSet.size === dupTagSet.size && [...refTagSet].every(t => dupTagSet.has(t));
    const tagDiff = dupTags.length - refTags.length;
    // Count tags that are different (unique to each side)
    const tagsOnlyInRef = [...refTagSet].filter(t => !dupTagSet.has(t)).length;
    const tagsOnlyInDup = [...dupTagSet].filter(t => !refTagSet.has(t)).length;
    
    // Token difference threshold (consider different if >5% difference)
    const tokenDiffPercent = refTokens > 0 ? Math.abs(refTokens - dupTokens) / refTokens : 0;
    
    return {
        name: refName.toLowerCase() !== dupName.toLowerCase(),
        creator: refCreator.toLowerCase() !== dupCreator.toLowerCase(),
        tokens: tokenDiffPercent > 0.05,
        date: refDate && dupDate && refDate.toDateString() !== dupDate.toDateString(),
        description: refDesc !== dupDesc,
        firstMessage: refFirstMes !== dupFirstMes,
        personality: refPers !== dupPers,
        scenario: refScenario !== dupScenario,
        // Which is newer
        isNewer: dupDate && refDate && dupDate > refDate,
        isOlder: dupDate && refDate && dupDate < refDate,
        hasMoreTokens: dupTokens > refTokens,
        hasLessTokens: dupTokens < refTokens,
        tags: !tagsMatch,
        tagDiff: tagDiff,  // positive = more tags, negative = fewer tags
        tagsOnlyInKeep: tagsOnlyInRef,  // tags unique to keep/reference
        tagsOnlyInDup: tagsOnlyInDup    // tags unique to duplicate
    };
}

function renderCharDupCard(char, type, groupIdx, charIdx = 0, diffs = null) {
    const name = getCharField(char, 'name') || 'Unknown';
    const creator = getCharField(char, 'creator') || 'Unknown creator';
    const avatarPath = getCharacterAvatarUrl(char.avatar);
    const tokens = estimateTokens(char);
    
    // Date
    let dateStr = 'Unknown';
    if (char.date_added) {
        const d = new Date(Number(char.date_added));
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString();
    } else if (char.create_date) {
        const d = new Date(char.create_date);
        if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString();
    }
    
    const isReference = type === 'reference';
    const label = isReference ? 'Keep' : 'Potential Duplicate';
    
    // Build difference badges for duplicate cards
    let diffBadges = '';
    if (diffs && !isReference) {
        const badges = [];
        if (diffs.isNewer) badges.push('<span class="diff-badge newer" title="This version is newer"><i class="fa-solid fa-arrow-up"></i> Newer</span>');
        if (diffs.isOlder) badges.push('<span class="diff-badge older" title="This version is older"><i class="fa-solid fa-arrow-down"></i> Older</span>');
        if (diffs.hasMoreTokens) badges.push('<span class="diff-badge more-tokens" title="Has more content"><i class="fa-solid fa-plus"></i> More</span>');
        if (diffs.hasLessTokens) badges.push('<span class="diff-badge less-tokens" title="Has less content"><i class="fa-solid fa-minus"></i> Less</span>');
        if (diffs.description) badges.push('<span class="diff-badge content-diff" title="Description differs"><i class="fa-solid fa-file-alt"></i> Desc</span>');
        if (diffs.firstMessage) badges.push('<span class="diff-badge content-diff" title="First message differs"><i class="fa-solid fa-comment"></i> 1st Msg</span>');
        if (diffs.personality) badges.push('<span class="diff-badge content-diff" title="Personality differs"><i class="fa-solid fa-brain"></i> Pers</span>');
        if (diffs.scenario) badges.push('<span class="diff-badge content-diff" title="Scenario differs"><i class="fa-solid fa-map"></i> Scen</span>');
        if (diffs.tags) {
            let tagTooltip;
            if (diffs.tagDiff > 0) {
                tagTooltip = `Has ${diffs.tagDiff} more tag${diffs.tagDiff !== 1 ? 's' : ''}`;
            } else if (diffs.tagDiff < 0) {
                tagTooltip = `Has ${Math.abs(diffs.tagDiff)} fewer tag${Math.abs(diffs.tagDiff) !== 1 ? 's' : ''}`;
            } else {
                // Same count but different tags - show breakdown
                tagTooltip = `${diffs.tagsOnlyInDup} unique here, ${diffs.tagsOnlyInKeep} unique in Keep`;
            }
            badges.push(`<span class="diff-badge tags-diff" title="${tagTooltip}"><i class="fa-solid fa-tags"></i> Tags</span>`);
        }
        
        if (badges.length > 0) {
            diffBadges = `<div class="char-dup-card-diffs">${badges.join('')}</div>`;
        }
    }
    
    // Highlight differing fields
    const dateClass = diffs && diffs.date ? 'diff-highlight' : '';
    const tokenClass = diffs && diffs.tokens ? 'diff-highlight' : '';
    
    // Create a unique ID for this card's gallery count element
    const galleryCountId = `gallery-count-${char.avatar.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    return `
        <div class="char-dup-card ${type}" data-avatar="${escapeHtml(char.avatar)}">
            <div class="char-dup-card-label">${label}</div>
            ${diffBadges}
            <div class="char-dup-card-header">
                <img class="char-dup-card-avatar" src="${avatarPath}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <div class="char-dup-card-title">
                    <div class="char-dup-card-name">${escapeHtml(name)}</div>
                    <div class="char-dup-card-creator">by ${escapeHtml(creator)}</div>
                </div>
            </div>
            <div class="char-dup-card-meta">
                <div class="char-dup-card-meta-item ${dateClass}"><i class="fa-solid fa-calendar"></i> ${dateStr}</div>
                <div class="char-dup-card-meta-item ${tokenClass}"><i class="fa-solid fa-code"></i> ~${tokens} tokens</div>
                <div class="char-dup-card-meta-item gallery-count-item" id="${galleryCountId}" data-avatar="${escapeHtml(char.avatar)}" onclick="viewDupCharGallery(this)" title="Gallery images"><i class="fa-solid fa-images"></i> <span class="gallery-count-value">...</span></div>
            </div>
            <div class="char-dup-card-actions">
                <button class="action-btn secondary small" onclick="viewCharFromDuplicates('${escapeHtml(char.avatar)}')">
                    <i class="fa-solid fa-eye"></i> View
                </button>
                <button class="action-btn secondary small" style="color: #e74c3c;" onclick="deleteDuplicateChar('${escapeHtml(char.avatar)}', ${groupIdx})">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
}

/**
 * Render duplicate groups in the modal
 */
function renderDuplicateGroups(groups) {
    const resultsEl = document.getElementById('charDuplicatesResults');
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    
    if (groups.length === 0) {
        statusEl.innerHTML = '<i class="fa-solid fa-check-circle"></i> No duplicates found in your library!';
        statusEl.className = 'char-duplicates-status no-results';
        resultsEl.innerHTML = '';
        return;
    }
    
    let totalDuplicates = groups.reduce((sum, g) => sum + g.duplicates.length, 0);
    statusEl.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i> Found ${totalDuplicates} potential duplicate(s) in ${groups.length} group(s)`;
    statusEl.className = 'char-duplicates-status complete';
    
    let html = '';
    
    groups.forEach((group, idx) => {
        const ref = group.reference;
        const refName = getCharField(ref, 'name') || 'Unknown';
        const refAvatar = getCharacterAvatarUrl(ref.avatar);
        const maxScore = Math.max(...group.duplicates.map(d => d.score || 0));
        
        html += `
            <div class="char-dup-group" id="dup-group-${idx}">
                <div class="char-dup-group-header" onclick="toggleDupGroup(${idx})">
                    <i class="fa-solid fa-chevron-right char-dup-group-toggle"></i>
                    <img class="char-dup-group-avatar" src="${refAvatar}" alt="${escapeHtml(refName)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                    <div class="char-dup-group-info">
                        <div class="char-dup-group-name">${escapeHtml(refName)}</div>
                        <div class="char-dup-group-meta">
                            <span>${group.duplicates.length} potential duplicate(s)</span>
                            <span style="opacity: 0.7;">\u2022 Score: ${maxScore} pts</span>
                        </div>
                    </div>
                    <div class="char-dup-group-confidence ${group.confidence}">${group.confidence}</div>
                </div>
                <div class="char-dup-group-content">
        `;
        
        // Render comparison for each duplicate
        group.duplicates.forEach((dup, dupIdx) => {
            const dupChar = dup.char;
            
            // Calculate differences between reference and duplicate
            const diffs = compareCharacterDifferences(ref, dupChar);
            
            // Build score breakdown display
            let scoreBreakdown = '';
            if (dup.breakdown) {
                const parts = [];
                if (dup.breakdown.name) parts.push(`Name: ${dup.breakdown.name}`);
                if (dup.breakdown.creator) parts.push(`Creator: ${dup.breakdown.creator}`);
                if (dup.breakdown.description) parts.push(`Desc: ${dup.breakdown.description}`);
                if (dup.breakdown.first_mes) parts.push(`1st Msg: ${dup.breakdown.first_mes}`);
                if (dup.breakdown.personality) parts.push(`Pers: ${dup.breakdown.personality}`);
                if (dup.breakdown.scenario) parts.push(`Scen: ${dup.breakdown.scenario}`);
                if (parts.length > 0) {
                    scoreBreakdown = `<div class="match-breakdown">${parts.join(' • ')}</div>`;
                }
            }
            
            // Build diff sections - now returns objects with html and isSame
            // Compare more fields for better coverage
            const descDiff = renderFieldDiff('Description', 
                getCharField(ref, 'description'), 
                getCharField(dupChar, 'description'));
            const persDiff = renderFieldDiff('Personality', 
                getCharField(ref, 'personality'), 
                getCharField(dupChar, 'personality'));
            const firstMesDiff = renderFieldDiff('First Message', 
                getCharField(ref, 'first_mes'), 
                getCharField(dupChar, 'first_mes'));
            const scenarioDiff = renderFieldDiff('Scenario', 
                getCharField(ref, 'scenario'), 
                getCharField(dupChar, 'scenario'));
            const mesExampleDiff = renderFieldDiff('Example Messages', 
                getCharField(ref, 'mes_example'), 
                getCharField(dupChar, 'mes_example'));
            const systemPromptDiff = renderFieldDiff('System Prompt', 
                getCharField(ref, 'system_prompt'), 
                getCharField(dupChar, 'system_prompt'));
            const creatorNotesDiff = renderFieldDiff('Creator Notes', 
                getCharField(ref, 'creator_notes'), 
                getCharField(dupChar, 'creator_notes'));
            const tagsDiff = renderTagsDiff(
                getTags(ref), 
                getTags(dupChar));
            
            // Separate into identical and different fields
            const allDiffs = [descDiff, persDiff, scenarioDiff, firstMesDiff, mesExampleDiff, systemPromptDiff, creatorNotesDiff, tagsDiff];
            const identicalFields = allDiffs.filter(d => d.isSame && !d.isEmpty).map(d => d.html).join('');
            const differentFields = allDiffs.filter(d => !d.isSame && !d.isEmpty).map(d => d.html).join('');
            
            // Count fields
            const identicalCount = allDiffs.filter(d => d.isSame && !d.isEmpty).length;
            const differentCount = allDiffs.filter(d => !d.isSame && !d.isEmpty).length;
            
            // Check if any fields had whitespace-only differences that were normalized away
            const wsNormalizedCount = allDiffs.filter(d => d.normalizedAway).length;
            
            // Build the diff summary message when all content is identical
            let diffSummary = '';
            if (differentCount === 0 && identicalCount > 0) {
                // All content is identical - explain what differs (file/metadata)
                const refAvatar = ref.avatar || '';
                const dupAvatar = dupChar.avatar || '';
                const refDate = ref.date_added ? new Date(Number(ref.date_added)) : (ref.create_date ? new Date(ref.create_date) : null);
                const dupDate = dupChar.date_added ? new Date(Number(dupChar.date_added)) : (dupChar.create_date ? new Date(dupChar.create_date) : null);
                
                const metaDiffs = [];
                if (refAvatar !== dupAvatar) {
                    metaDiffs.push(`<div class="meta-diff-item"><i class="fa-solid fa-file-image"></i> <strong>Different files:</strong> <code>${escapeHtml(refAvatar)}</code> vs <code>${escapeHtml(dupAvatar)}</code></div>`);
                }
                if (refDate && dupDate && refDate.getTime() !== dupDate.getTime()) {
                    const formatDate = (d) => d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    metaDiffs.push(`<div class="meta-diff-item"><i class="fa-solid fa-calendar"></i> <strong>Added:</strong> ${formatDate(refDate)} vs ${formatDate(dupDate)}</div>`);
                }
                
                // Note about whitespace differences
                const wsNote = wsNormalizedCount > 0 
                    ? `<div class="ws-diff-note"><i class="fa-solid fa-asterisk"></i> ${wsNormalizedCount} field${wsNormalizedCount !== 1 ? 's have' : ' has'} minor whitespace differences (extra spaces, line endings)</div>` 
                    : '';
                
                diffSummary = `
                    <div class="char-dup-identical-notice">
                        <div class="identical-notice-header">
                            <i class="fa-solid fa-clone"></i>
                            <strong>Content Identical</strong> — These are duplicate files with the same character data
                        </div>
                        ${wsNote}
                        ${metaDiffs.length > 0 ? `<div class="meta-diffs">${metaDiffs.join('')}</div>` : ''}
                        <div class="identical-notice-hint">
                            <i class="fa-solid fa-lightbulb"></i>
                            You can safely delete one. Check gallery images before deciding which to keep.
                        </div>
                    </div>
                `;
            }
            
            html += `
                <div class="char-dup-comparison" data-dup-idx="${dupIdx}">
                    ${renderCharDupCard(ref, 'reference', idx)}
                    <div class="char-dup-divider">
                        <i class="fa-solid fa-arrows-left-right"></i>
                        <div class="char-dup-group-confidence ${dup.confidence} match-score">
                            ${dup.score || 0} pts
                        </div>
                        <div class="match-reason">
                            ${dup.matchReason}
                        </div>
                        ${scoreBreakdown}
                    </div>
                    ${renderCharDupCard(dupChar, 'duplicate', idx, dupIdx, diffs)}
                </div>
                ${diffSummary}
                ${differentFields ? `
                    <div class="char-dup-diff-container">
                        <div class="char-dup-diff differs">
                            <details open>
                                <summary>
                                    <i class="fa-solid fa-triangle-exclamation"></i> 
                                    Different Fields
                                    <span class="diff-count">${differentCount}</span>
                                </summary>
                                ${differentFields}
                            </details>
                        </div>
                    </div>
                ` : ''}
                ${identicalFields && differentCount > 0 ? `
                    <div class="char-dup-diff-container">
                        <div class="char-dup-diff identical">
                            <details>
                                <summary>
                                    <i class="fa-solid fa-check-circle"></i> 
                                    Identical Fields
                                    <span class="diff-count">${identicalCount}</span>
                                </summary>
                                ${identicalFields}
                            </details>
                        </div>
                    </div>
                ` : ''}
            `;
        });
        
        html += `
                </div>
            </div>
        `;
    });
    
    resultsEl.innerHTML = html;
    
    // Load gallery counts asynchronously after rendering
    loadDuplicateGalleryCounts(groups);
}

/**
 * Open the gallery viewer for a character from the duplicate scanner
 * @param {HTMLElement} el - The clicked gallery-count-item element
 */
async function viewDupCharGallery(el) {
    const avatar = el?.dataset?.avatar;
    if (!avatar) return;

    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        showToast('Character not found', 'error');
        return;
    }

    const countValue = el.querySelector('.gallery-count-value');
    const count = parseInt(countValue?.textContent, 10);
    if (!count || count <= 0) {
        showToast('No gallery images for this character', 'info');
        return;
    }

    try {
        const info = await getCharacterGalleryInfo(char);
        if (!info.files || info.files.length === 0) {
            showToast('No gallery images found', 'info');
            return;
        }

        const images = info.files.map(fileName => ({
            name: fileName,
            url: `/user/images/${encodeURIComponent(info.folder)}/${encodeURIComponent(fileName)}`
        }));

        if (window.openGalleryViewerWithImages) {
            window.openGalleryViewerWithImages(images, 0, char.name || 'Gallery');
        } else {
            showToast('Gallery viewer not available', 'error');
        }
    } catch (err) {
        console.error('[Duplicates] Error opening gallery:', err);
        showToast('Failed to load gallery', 'error');
    }
}
window.viewDupCharGallery = viewDupCharGallery;

/**
 * Load and display gallery image counts for all characters in duplicate groups
 * @param {Array} groups - The duplicate groups
 */
async function loadDuplicateGalleryCounts(groups) {
    // Collect all unique characters from groups
    const characters = new Map();
    
    groups.forEach(group => {
        characters.set(group.reference.avatar, group.reference);
        group.duplicates.forEach(dup => {
            characters.set(dup.char.avatar, dup.char);
        });
    });
    
    // Load counts in parallel with a limit to avoid overloading
    const BATCH_SIZE = 5;
    const avatars = Array.from(characters.keys());
    
    for (let i = 0; i < avatars.length; i += BATCH_SIZE) {
        const batch = avatars.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (avatar) => {
            const char = characters.get(avatar);
            try {
                const galleryInfo = await getCharacterGalleryInfo(char);
                const countEl = document.getElementById(`gallery-count-${avatar.replace(/[^a-zA-Z0-9]/g, '_')}`);
                if (countEl) {
                    const countValue = countEl.querySelector('.gallery-count-value');
                    if (countValue) {
                        countValue.textContent = galleryInfo.count.toString();
                        // Highlight if has images (yellow for warning about deletion)
                        if (galleryInfo.count > 0) {
                            countEl.classList.add('has-images');
                            countEl.title = `${galleryInfo.count} gallery image${galleryInfo.count !== 1 ? 's' : ''} - will be deleted if character is removed`;
                        } else {
                            countEl.title = 'No gallery images';
                        }
                    }
                }
            } catch (e) {
                debugLog(`[Gallery] Error loading count for ${avatar}:`, e);
            }
        }));
    }
}

/**
 * Toggle duplicate group expansion
 */
function toggleDupGroup(idx) {
    const group = document.getElementById(`dup-group-${idx}`);
    if (group) {
        const wasExpanded = group.classList.contains('expanded');
        group.classList.toggle('expanded');
        
        // Track expanded state for restoration
        if (wasExpanded) {
            duplicateModalState.expandedGroups.delete(idx);
        } else {
            duplicateModalState.expandedGroups.add(idx);
        }
    }
}

/**
 * Save current duplicate modal state for restoration
 */
function saveDuplicateModalState() {
    const modal = document.getElementById('charDuplicatesModal');
    const resultsEl = document.getElementById('charDuplicatesResults');
    
    duplicateModalState.wasOpen = modal && !modal.classList.contains('hidden');
    duplicateModalState.scrollPosition = resultsEl ? resultsEl.scrollTop : 0;
    
    // Track which groups are expanded
    duplicateModalState.expandedGroups = new Set();
    document.querySelectorAll('.char-dup-group.expanded').forEach(el => {
        const match = el.id.match(/dup-group-(\d+)/);
        if (match) duplicateModalState.expandedGroups.add(parseInt(match[1]));
    });
}

/**
 * Restore duplicate modal state after viewing a card
 */
function restoreDuplicateModalState() {
    if (!duplicateModalState.wasOpen) return;
    
    const modal = document.getElementById('charDuplicatesModal');
    const resultsEl = document.getElementById('charDuplicatesResults');
    
    // Show the modal
    modal.classList.remove('hidden');
    
    // Restore expanded groups
    duplicateModalState.expandedGroups.forEach(idx => {
        const group = document.getElementById(`dup-group-${idx}`);
        if (group) group.classList.add('expanded');
    });
    
    // Restore scroll position
    if (resultsEl) {
        setTimeout(() => {
            resultsEl.scrollTop = duplicateModalState.scrollPosition;
        }, 50);
    }
}

/**
 * View a character from the duplicates modal
 * Hides duplicates modal, shows character modal, and allows returning
 */
function viewCharFromDuplicates(avatar) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) return;
    
    // Save current modal state
    saveDuplicateModalState();
    
    // Hide duplicates modal
    document.getElementById('charDuplicatesModal').classList.add('hidden');
    
    // Open character modal
    openModal(char);
}

/**
 * Delete a duplicate character with option to transfer gallery images
 */
async function deleteDuplicateChar(avatar, groupIdx) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) return;
    
    const name = getCharField(char, 'name') || avatar;
    const avatarPath = getCharacterAvatarUrl(avatar);
    
    // Get gallery info for this character
    const galleryInfo = await getCharacterGalleryInfo(char);
    const hasImages = galleryInfo.count > 0;
    
    // Only offer gallery deletion/transfer for unique galleries (with gallery_id)
    // Shared galleries should NOT be modified as they may contain other characters' images
    const hasUniqueGallery = !!getCharacterGalleryId(char);
    
    // Find other characters this could be transferred to (same name or in same duplicate group)
    const currentGroup = duplicateScanCache.groups?.[groupIdx];
    const transferTargets = [];
    
    if (currentGroup) {
        // Add reference character
        if (currentGroup.reference.avatar !== avatar) {
            transferTargets.push(currentGroup.reference);
        }
        // Add other duplicates
        currentGroup.duplicates.forEach(d => {
            if (d.char.avatar !== avatar) {
                transferTargets.push(d.char);
            }
        });
    }
    
    // Create enhanced delete confirmation modal
    const deleteModal = document.createElement('div');
    deleteModal.className = 'confirm-modal';
    deleteModal.id = 'deleteDuplicateModal';
    
    // Only allow gallery modification when:
    // 1. Unique gallery folders feature is ENABLED
    // 2. Character has a gallery_id (unique gallery)
    const uniqueFoldersEnabled = getSetting('uniqueGalleryFolders') || false;
    const canModifyGallery = uniqueFoldersEnabled && hasUniqueGallery;
    
    // Build transfer targets HTML with more details
    let transferTargetsHtml = '';
    if (hasImages && canModifyGallery && transferTargets.length > 0) {
        // Has unique gallery AND transfer targets - show all options
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-image-options">
                    <label class="dup-delete-option-radio selected" data-action="transfer">
                        <input type="radio" name="imageAction" value="transfer" checked>
                        <div class="option-content">
                            <i class="fa-solid fa-arrow-right-arrow-left"></i>
                            <div class="option-text">
                                <strong>Transfer images</strong>
                                <span>Move to another character's gallery</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="delete">
                        <input type="radio" name="imageAction" value="delete">
                        <div class="option-content">
                            <i class="fa-solid fa-trash-can"></i>
                            <div class="option-text">
                                <strong>Delete images</strong>
                                <span>Permanently remove all gallery images</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="keep">
                        <input type="radio" name="imageAction" value="keep">
                        <div class="option-content">
                            <i class="fa-solid fa-folder-open"></i>
                            <div class="option-text">
                                <strong>Keep images</strong>
                                <span>Leave in folder (can reassign later)</span>
                            </div>
                        </div>
                    </label>
                </div>
                <div class="dup-delete-transfer-target" id="transferTargetWrapper">
                    <label>Transfer to:</label>
                    <div class="dup-delete-transfer-select-wrapper">
                        ${transferTargets.map((t, idx) => {
                            const tName = getCharField(t, 'name') || t.avatar;
                            const tAvatar = getCharacterAvatarUrl(t.avatar);
                            return `
                                <label class="dup-delete-transfer-radio ${idx === 0 ? 'selected' : ''}" data-avatar="${escapeHtml(t.avatar)}">
                                    <input type="radio" name="transferTarget" value="${escapeHtml(t.avatar)}" ${idx === 0 ? 'checked' : ''}>
                                    <img src="${tAvatar}" onerror="this.src='/img/ai4.png'" alt="">
                                    <span>${escapeHtml(tName)}</span>
                                </label>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;
    } else if (hasImages && canModifyGallery) {
        // Has unique gallery but no transfer targets - show delete/keep options
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section warning-only">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-image-options">
                    <label class="dup-delete-option-radio selected" data-action="keep">
                        <input type="radio" name="imageAction" value="keep" checked>
                        <div class="option-content">
                            <i class="fa-solid fa-folder-open"></i>
                            <div class="option-text">
                                <strong>Keep images</strong>
                                <span>Leave in folder (can reassign later)</span>
                            </div>
                        </div>
                    </label>
                    <label class="dup-delete-option-radio" data-action="delete">
                        <input type="radio" name="imageAction" value="delete">
                        <div class="option-content">
                            <i class="fa-solid fa-trash-can"></i>
                            <div class="option-text">
                                <strong>Delete images</strong>
                                <span>Permanently remove all gallery images</span>
                            </div>
                        </div>
                    </label>
                </div>
            </div>
        `;
    } else if (hasImages) {
        // Shared/unmanaged gallery - just show info, no delete option
        const reason = !uniqueFoldersEnabled 
            ? 'Unique gallery folders feature is disabled.'
            : "This character doesn't have a unique gallery ID.";
        transferTargetsHtml = `
            <div class="dup-delete-transfer-section warning-only">
                <div class="dup-delete-transfer-header">
                    <i class="fa-solid fa-images"></i>
                    <strong>Gallery Contains ${galleryInfo.count} File${galleryInfo.count !== 1 ? 's' : ''}</strong>
                </div>
                <div class="dup-delete-shared-warning">
                    <i class="fa-solid fa-info-circle"></i>
                    <span>${reason} Gallery files will not be deleted.</span>
                </div>
            </div>
        `;
    }
    
    deleteModal.innerHTML = `
        <div class="confirm-modal-content dup-delete-modal-content">
            <div class="confirm-modal-header dup-delete-header">
                <h3>
                    <i class="fa-solid fa-trash"></i>
                    Delete Character
                </h3>
                <button class="close-confirm-btn" id="closeDuplicateDeleteModal">&times;</button>
            </div>
            <div class="confirm-modal-body">
                <div class="dup-delete-char-info">
                    <img src="${avatarPath}" 
                         alt="${escapeHtml(name)}" 
                         class="dup-delete-avatar"
                         onerror="this.src='/img/ai4.png'">
                    <div class="dup-delete-char-details">
                        <h4>${escapeHtml(name)}</h4>
                        <p>by ${escapeHtml(getCharField(char, 'creator') || 'Unknown')}</p>
                    </div>
                </div>
                
                ${transferTargetsHtml}
                
                <p class="dup-delete-confirm-text">
                    <i class="fa-solid fa-exclamation-circle"></i>
                    Are you sure you want to delete this character? This cannot be undone.
                </p>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="cancelDuplicateDeleteBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn danger" id="confirmDuplicateDeleteBtn">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(deleteModal);
    
    // Setup event handlers
    const closeModal = () => deleteModal.remove();
    
    deleteModal.querySelector('#closeDuplicateDeleteModal').addEventListener('click', closeModal);
    deleteModal.querySelector('#cancelDuplicateDeleteBtn').addEventListener('click', closeModal);
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeModal();
    });
    
    // Image action radio button handling
    const confirmBtn = deleteModal.querySelector('#confirmDuplicateDeleteBtn');
    const transferTargetWrapper = deleteModal.querySelector('#transferTargetWrapper');
    
    const updateButtonText = () => {
        const selectedAction = deleteModal.querySelector('input[name="imageAction"]:checked')?.value;
        if (selectedAction === 'transfer') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete & Transfer';
        } else if (selectedAction === 'delete') {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete All';
        } else {
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    };
    
    deleteModal.querySelectorAll('.dup-delete-option-radio').forEach(option => {
        option.addEventListener('click', () => {
            deleteModal.querySelectorAll('.dup-delete-option-radio').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            option.querySelector('input').checked = true;
            
            // Show/hide transfer target selector
            if (transferTargetWrapper) {
                transferTargetWrapper.style.display = option.dataset.action === 'transfer' ? 'block' : 'none';
            }
            updateButtonText();
        });
    });
    
    // Initialize button text
    updateButtonText();
    
    // Radio button selection styling for transfer targets
    deleteModal.querySelectorAll('.dup-delete-transfer-radio').forEach(radio => {
        radio.addEventListener('click', () => {
            deleteModal.querySelectorAll('.dup-delete-transfer-radio').forEach(r => r.classList.remove('selected'));
            radio.classList.add('selected');
            radio.querySelector('input').checked = true;
        });
    });
    
    // Handle delete confirmation
    deleteModal.querySelector('#confirmDuplicateDeleteBtn').addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        
        const imageAction = deleteModal.querySelector('input[name="imageAction"]:checked')?.value || 'keep';
        
        // Handle images based on selected action (only possible for unique galleries)
        if (hasUniqueGallery && imageAction === 'transfer') {
            // Transfer images to selected target
            const selectedRadio = deleteModal.querySelector('input[name="transferTarget"]:checked');
            if (selectedRadio?.value) {
                const targetAvatar = selectedRadio.value;
                const targetChar = allCharacters.find(c => c.avatar === targetAvatar);
                
                if (targetChar) {
                    const targetFolder = getGalleryFolderName(targetChar);
                    let transferred = 0;
                    let errors = 0;
                    
                    confirmBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Transferring images...`;
                    
                    for (const fileName of galleryInfo.files) {
                        const result = await moveImageToFolder(galleryInfo.folder, targetFolder, fileName, true);
                        if (result.success) {
                            transferred++;
                        } else {
                            errors++;
                            debugLog(`[Transfer] Failed to transfer ${fileName}: ${result.error}`);
                        }
                    }
                    
                    if (transferred > 0) {
                        showToast(`Transferred ${transferred} image${transferred !== 1 ? 's' : ''} to ${getCharField(targetChar, 'name')}`, 'success');
                    }
                    if (errors > 0) {
                        showToast(`Failed to transfer ${errors} image${errors !== 1 ? 's' : ''}`, 'error');
                    }
                }
            }
        } else if (hasUniqueGallery && imageAction === 'delete') {
            // Delete all gallery images (only for unique galleries)
            confirmBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deleting images...`;
            let deleted = 0;
            let errors = 0;
            
            const safeFolderName = sanitizeFolderName(galleryInfo.folder);
            for (const fileName of galleryInfo.files) {
                try {
                    const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                    const response = await apiRequest(ENDPOINTS.IMAGES_DELETE, 'POST', {
                        path: deletePath
                    });
                    if (response.ok) {
                        deleted++;
                    } else {
                        errors++;
                        debugLog(`[Delete] Failed to delete ${fileName}: ${response.status}`);
                    }
                } catch (e) {
                    errors++;
                    debugLog(`[Delete] Failed to delete ${fileName}:`, e);
                }
            }
            
            if (deleted > 0) {
                showToast(`Deleted ${deleted} image${deleted !== 1 ? 's' : ''}`, 'info');
            }
            if (errors > 0) {
                showToast(`Failed to delete ${errors} image${errors !== 1 ? 's' : ''}`, 'error');
            }
        }
        // If imageAction === 'keep', do nothing with images
        
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
        // Use the main deleteCharacter function which handles ST sync
        const success = await deleteCharacter(char, false);
        
        if (success) {
            showToast(`Deleted "${name}"`, 'success');
            closeModal();
            
            // Invalidate cache
            duplicateScanCache.timestamp = 0;
            
            // Refresh the gallery
            await fetchCharacters(true);
            
            // Re-run duplicate scan with new data
            const groups = await findCharacterDuplicates(true);
            renderDuplicateGroups(groups);
        } else {
            showToast(`Failed to delete "${name}"`, 'error');
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }
    });
}

/**
 * Open the character duplicates scanner modal
 */
async function openCharDuplicatesModal(useCache = true) {
    const modal = document.getElementById('charDuplicatesModal');
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    const resultsEl = document.getElementById('charDuplicatesResults');
    
    // Reset state
    statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scanning library for duplicates...';
    statusEl.className = 'char-duplicates-status';
    resultsEl.innerHTML = '';
    
    modal.classList.remove('hidden');
    
    // Run scan (async)
    await new Promise(r => setTimeout(r, 50)); // Let modal render
    const groups = await findCharacterDuplicates(!useCache);
    renderDuplicateGroups(groups);
}

// Character Duplicates Modal Event Listeners
on('checkDuplicatesBtn', 'click', () => openCharDuplicatesModal());

on('closeCharDuplicatesModal', 'click', () => hideModal('charDuplicatesModal'));

on('closeCharDuplicatesModalBtn', 'click', () => hideModal('charDuplicatesModal'));

// ========================================
// PRE-IMPORT DUPLICATE CHECK
// ========================================

let preImportPendingChar = null; // Character data waiting to be imported
let preImportMatches = []; // Matching existing characters
let preImportResolveCallback = null; // Promise resolver

/**
 * Show the pre-import duplicate warning modal
 * Returns a promise that resolves with the user's choice
 */
function showPreImportDuplicateWarning(newCharInfo, matches) {
    return new Promise((resolve) => {
        preImportPendingChar = newCharInfo;
        preImportMatches = matches;
        preImportResolveCallback = resolve;
        
        const modal = document.getElementById('preImportDuplicateModal');
        const infoEl = document.getElementById('preImportDuplicateInfo');
        const matchesEl = document.getElementById('preImportDuplicateMatches');
        
        // Render importing character info
        const name = newCharInfo.name || newCharInfo.definition?.name || 'Unknown';
        const creator = newCharInfo.creator || newCharInfo.definition?.creator || 'Unknown';
        const avatarUrl = newCharInfo.avatarUrl || `https://avatars.charhub.io/avatars/${newCharInfo.fullPath}/avatar.webp`;
        
        infoEl.innerHTML = `
            <img class="pre-import-info-avatar" src="${avatarUrl}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">
            <div class="pre-import-info-text">
                <h4><i class="fa-solid fa-download"></i> Importing: ${escapeHtml(name)}</h4>
                <p>by ${escapeHtml(creator)} &bull; This character may already exist in your library</p>
            </div>
        `;
        
        // Render existing matches
        let matchesHtml = `<div class="pre-import-matches-header">Found ${matches.length} potential match(es):</div>`;
        
        matches.forEach((match, idx) => {
            const existingChar = match.char;
            const existingName = getCharField(existingChar, 'name');
            const existingCreator = getCharField(existingChar, 'creator');
            const existingAvatar = getCharacterAvatarUrl(existingChar.avatar);
            const tokens = estimateTokens(existingChar);
            
            matchesHtml += `
                <div class="char-dup-card" style="margin-bottom: 10px; border-color: var(--glass-border);">
                    <div class="char-dup-card-header">
                        <img class="char-dup-card-avatar" src="${existingAvatar}" alt="${escapeHtml(existingName)}" loading="lazy">
                        <div class="char-dup-card-title">
                            <div class="char-dup-card-name">${escapeHtml(existingName)}</div>
                            <div class="char-dup-card-creator">by ${escapeHtml(existingCreator)}</div>
                        </div>
                        <div class="char-dup-group-confidence ${match.confidence}" style="font-size: 0.7rem;">
                            ${match.matchReason}
                        </div>
                    </div>
                    <div class="char-dup-card-meta">
                        <div class="char-dup-card-meta-item"><i class="fa-solid fa-code"></i> ~${tokens} tokens</div>
                    </div>
                </div>
            `;
        });
        
        matchesEl.innerHTML = matchesHtml;
        
        // Show modal
        modal.classList.remove('hidden');
    });
}

/**
 * Hide the pre-import modal and resolve with user choice
 */
function resolvePreImportChoice(choice) {
    document.getElementById('preImportDuplicateModal').classList.add('hidden');
    
    if (preImportResolveCallback) {
        preImportResolveCallback({
            choice,
            pendingChar: preImportPendingChar,
            matches: preImportMatches
        });
        preImportResolveCallback = null;
    }
    
    preImportPendingChar = null;
    preImportMatches = [];
}

// Pre-Import Modal Event Listeners
on('closePreImportDuplicateModal', 'click', () => resolvePreImportChoice('skip'));

on('preImportSkipBtn', 'click', () => resolvePreImportChoice('skip'));

on('preImportAnyway', 'click', () => resolvePreImportChoice('import'));

on('preImportReplaceBtn', 'click', () => resolvePreImportChoice('replace'));

// ========================================
// CHATS VIEW - Global Chats Browser
// ========================================

let currentView = 'characters'; // 'characters' or 'chats'
let allChats = [];
let currentGrouping = 'flat'; // 'flat' or 'grouped'
let currentChatSort = 'recent';
let currentPreviewChat = null;
let currentPreviewChar = null;

// Initialize Chats View handlers after DOM is ready
function initChatsView() {
    // View Toggle Handlers
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const view = btn.dataset.view;
            debugLog('View toggle clicked:', view);
            switchView(view);
        });
    });
    
    // Chats Sort Select
    on('chatsSortSelect', 'change', (e) => {
        currentChatSort = e.target.value;
        renderChats();
    });
    
    // Grouping Toggle
    // Grouping Toggle - just re-render, don't reload
    document.querySelectorAll('.grouping-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.grouping-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentGrouping = btn.dataset.group;
            renderChats(); // Just re-render from cached data
        });
    });
    
    // Refresh Chats Button - force full refresh
    on('refreshChatsViewBtn', 'click', () => {
        clearChatCache();
        allChats = [];
        loadAllChats(true); // Force refresh
    });
    
    // Chat Preview Modal handlers
    on('chatPreviewClose', 'click', () => hideModal('chatPreviewModal'));
    
    on('chatPreviewOpenBtn', 'click', () => {
        if (currentPreviewChat) {
            openChatInST(currentPreviewChat);
        }
    });
    
    on('chatPreviewDeleteBtn', 'click', () => {
        if (currentPreviewChat) {
            deleteChatFromView(currentPreviewChat);
        }
    });
    
    // Close modal on overlay click
    on('chatPreviewModal', 'click', (e) => {
        if (e.target.id === 'chatPreviewModal') {
            hideModal('chatPreviewModal');
        }
    });
    
    debugLog('Chats view initialized');
}

// Call init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatsView);
} else {
    initChatsView();
}

function switchView(view) {
    debugLog('[View] Switching to:', view);
    currentView = view;
    
    // Update toggle buttons
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    
    // Update search placeholder
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        if (view === 'characters') {
            searchInput.placeholder = 'Search characters...';
        } else if (view === 'chats') {
            searchInput.placeholder = 'Search chats...';
        } else {
            searchInput.placeholder = 'Search library...';
        }
    }
    
    // Get elements
    const charFilters = document.getElementById('filterArea');
    const chatFilters = document.getElementById('chatsFilterArea');
    const chubFilters = document.getElementById('chubFilterArea');
    const importBtn = document.getElementById('importBtn');
    const searchSettings = document.querySelector('.search-settings-container');
    const mainSearch = document.querySelector('.search-area');
    
    // Hide all views first
    hide('characterGrid');
    hide('chatsView');
    hide('chubView');
    
    // Reset scroll position when switching views
    const scrollContainer = document.querySelector('.gallery-content');
    if (scrollContainer) {
        scrollContainer.scrollTop = 0;
    }
    
    // Hide all filter areas using display:none for cleaner switching
    if (charFilters) charFilters.style.display = 'none';
    if (chatFilters) chatFilters.style.display = 'none';
    if (chubFilters) chubFilters.style.display = 'none';
    
    if (view === 'characters') {
        if (charFilters) charFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = '';
        if (searchSettings) searchSettings.style.display = '';
        // Use visibility to maintain space for search area
        if (mainSearch) {
            mainSearch.style.visibility = 'visible';
            mainSearch.style.pointerEvents = '';
        }
        show('characterGrid');
        
        // Re-apply current filters and sort when returning to characters view.
        // Defer to next animation frame so the grid has fully reflowed after
        // removing the 'hidden' class — otherwise clientWidth/clientHeight can
        // still report 0 and the virtual scroll renders nothing.
        requestAnimationFrame(() => performSearch());
    } else if (view === 'chats') {
        if (chatFilters) chatFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = 'none';
        if (searchSettings) searchSettings.style.display = 'none';
        // Use visibility to maintain space for search area
        if (mainSearch) {
            mainSearch.style.visibility = 'visible';
            mainSearch.style.pointerEvents = '';
        }
        show('chatsView');
        
        // Load chats if not loaded
        if (allChats.length === 0) {
            loadAllChats();
        }
    } else if (view === 'chub') {
        if (chubFilters) chubFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = 'none';
        if (searchSettings) searchSettings.style.display = 'none';
        // Hide search visually but maintain its space to prevent layout shift
        if (mainSearch) {
            mainSearch.style.visibility = 'hidden';
            mainSearch.style.pointerEvents = 'none';
        }
        show('chubView');
        
        // Load ChubAI characters if not loaded
        if (chubCharacters.length === 0) {
            loadChubCharacters();
        }
    }
}

// ========================================
// CHATS CACHING
// ========================================
const CHATS_CACHE_KEY = 'st_gallery_chats_cache';
const CHATS_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes before background refresh

function getCachedChats() {
    try {
        const cached = localStorage.getItem(CHATS_CACHE_KEY);
        if (!cached) return null;
        
        const data = JSON.parse(cached);
        return data;
    } catch (e) {
        console.warn('[ChatsCache] Failed to read cache:', e);
        return null;
    }
}

function saveChatCache(chats) {
    try {
        const cacheData = {
            timestamp: Date.now(),
            chats: chats.map(c => ({
                file_name: c.file_name,
                last_mes: c.last_mes,
                chat_items: c.chat_items || c.mes_count || 0,
                charName: c.charName,
                charAvatar: c.charAvatar,
                preview: c.preview
            }))
        };
        localStorage.setItem(CHATS_CACHE_KEY, JSON.stringify(cacheData));
        debugLog(`[ChatsCache] Saved ${chats.length} chats to cache`);
    } catch (e) {
        console.warn('[ChatsCache] Failed to save cache:', e);
    }
}

function clearChatCache() {
    localStorage.removeItem(CHATS_CACHE_KEY);
}

// Fetch all chats from all characters
async function loadAllChats(forceRefresh = false) {
    const chatsView = document.getElementById('chatsView');
    const chatsGrid = document.getElementById('chatsGrid');
    
    // Try to show cached data first for instant UI
    const cached = getCachedChats();
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    const isCacheValid = cached && cached.chats && cached.chats.length > 0;
    
    if (isCacheValid && !forceRefresh) {
        debugLog(`[ChatsCache] Using cached data (${Math.round(cacheAge/1000)}s old, ${cached.chats.length} chats)`);
        
        // Reconstruct allChats from cache with character references
        allChats = cached.chats.map(cachedChat => {
            const char = allCharacters.find(c => c.avatar === cachedChat.charAvatar);
            if (!char) return null;
            return {
                ...cachedChat,
                character: char,
                mes_count: cachedChat.chat_items
            };
        }).filter(Boolean);
        
        // Render immediately from cache
        renderChats();
        
        // If cache is old, do background refresh
        if (cacheAge > CHATS_CACHE_MAX_AGE) {
            debugLog('[ChatsCache] Cache is stale, refreshing in background...');
            showRefreshIndicator(true);
            await fetchFreshChats(true); // background mode
            showRefreshIndicator(false);
        }
        
        return;
    }
    
    // No cache or force refresh - do full load
    renderLoadingState(chatsGrid, 'Loading all chats...', 'chats-loading');
    await fetchFreshChats(false);
}

function showRefreshIndicator(show) {
    let indicator = document.getElementById('chatsRefreshIndicator');
    if (show) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'chatsRefreshIndicator';
            indicator.className = 'chats-refresh-indicator';
            indicator.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Checking for updates...';
            document.getElementById('chatsView')?.prepend(indicator);
        }
    } else {
        indicator?.remove();
    }
}

async function fetchFreshChats(isBackground = false) {
    const chatsGrid = document.getElementById('chatsGrid');
    
    try {
        const newChats = [];
        
        // Get chats for each character that has chats
        for (const char of allCharacters) {
            try {
                const response = await apiRequest(ENDPOINTS.CHARACTERS_CHATS, 'POST', { 
                    avatar_url: char.avatar, 
                    metadata: true 
                });
                
                if (response.ok) {
                    const chats = await response.json();
                    if (chats && chats.length && !chats.error) {
                        chats.forEach(chat => {
                            // Check if we have a cached preview for this chat
                            const cachedChat = allChats.find(c => 
                                c.file_name === chat.file_name && c.charAvatar === char.avatar
                            );
                            
                            // Reuse preview if message count hasn't changed
                            const cachedMsgCount = cachedChat?.chat_items || cachedChat?.mes_count || 0;
                            const newMsgCount = chat.chat_items || chat.mes_count || 0;
                            const canReusePreview = cachedChat?.preview && cachedMsgCount === newMsgCount;
                            
                            newChats.push({
                                ...chat,
                                character: char,
                                charName: char.name,
                                charAvatar: char.avatar,
                                preview: canReusePreview ? cachedChat.preview : null
                            });
                        });
                    }
                }
            } catch (e) {
                console.warn(`Failed to load chats for ${char.name}:`, e);
            }
        }
        
        if (newChats.length === 0 && !isBackground) {
            chatsGrid.innerHTML = `
                <div class="chats-empty">
                    <i class="fa-solid fa-comments"></i>
                    <h3>No Chats Found</h3>
                    <p>Start a conversation with a character to see it here.</p>
                </div>
            `;
            return;
        }
        
        // Update allChats
        allChats = newChats;
        
        // Render chats
        renderChats();
        
        // Find chats that need preview loading
        const chatsNeedingPreviews = allChats.filter(c => c.preview === null);
        debugLog(`[ChatsCache] ${chatsNeedingPreviews.length} of ${allChats.length} chats need preview loading`);
        
        if (chatsNeedingPreviews.length > 0) {
            await loadChatPreviews(chatsNeedingPreviews);
        }
        
        // Save to cache
        saveChatCache(allChats);
        
    } catch (e) {
        console.error('Failed to load chats:', e);
        if (!isBackground) {
            chatsGrid.innerHTML = `
                <div class="chats-empty">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Error Loading Chats</h3>
                    <p>${escapeHtml(e.message)}</p>
                </div>
            `;
        }
    }
}

// Fetch chat previews in parallel batches
async function loadChatPreviews(chatsToLoad = null) {
    const BATCH_SIZE = 5; // Fetch 5 at a time to avoid overwhelming the server
    const targetChats = chatsToLoad || allChats;
    debugLog(`[ChatPreviews] Starting to load previews for ${targetChats.length} chats`);
    
    for (let i = 0; i < targetChats.length; i += BATCH_SIZE) {
        const batch = targetChats.slice(i, i + BATCH_SIZE);
        debugLog(`[ChatPreviews] Processing batch ${i/BATCH_SIZE + 1}, chats ${i} to ${i + batch.length}`);
        
        await Promise.all(batch.map(async (chat) => {
            try {
                // Try the file_name without .jsonl extension
                const chatFileName = chat.file_name.replace('.jsonl', '');
                
                const response = await apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
                    ch_name: chat.character.name,
                    file_name: chatFileName,
                    avatar_url: chat.character.avatar
                });
                
                debugLog(`[ChatPreviews] ${chat.file_name}: response status ${response.status}`);
                
                if (response.ok) {
                    const messages = await response.json();
                    debugLog(`[ChatPreviews] ${chat.file_name}: got ${messages?.length || 0} messages`);
                    
                    if (messages && messages.length > 0) {
                        // Get last non-system message as preview
                        const lastMsg = [...messages].reverse().find(m => !m.is_system && m.mes);
                        if (lastMsg) {
                            const previewText = lastMsg.mes.substring(0, 150);
                            chat.preview = (lastMsg.is_user ? 'You: ' : '') + previewText + (lastMsg.mes.length > 150 ? '...' : '');
                            
                            // Update the card in DOM if it exists
                            updateChatCardPreview(chat);
                        } else {
                            chat.preview = '';
                            updateChatCardPreview(chat);
                        }
                    } else {
                        chat.preview = '';
                        updateChatCardPreview(chat);
                    }
                } else {
                    console.warn(`[ChatPreviews] ${chat.file_name}: HTTP error ${response.status}`);
                    chat.preview = '';
                    updateChatCardPreview(chat);
                }
            } catch (e) {
                console.warn(`[ChatPreviews] ${chat.file_name}: Exception:`, e);
                chat.preview = '';
                updateChatCardPreview(chat);
            }
        }));
    }
    
    debugLog(`[ChatPreviews] Finished loading all previews`);
}

// Update a chat card's preview text in the DOM
function updateChatCardPreview(chat) {
    const card = document.querySelector(`.chat-card[data-chat-file="${CSS.escape(chat.file_name)}"][data-char-avatar="${CSS.escape(chat.charAvatar)}"]`);
    if (card) {
        const previewEl = card.querySelector('.chat-card-preview');
        if (previewEl && chat.preview) {
            previewEl.textContent = chat.preview;
        }
    }
    
    // Also update in grouped view
    const groupItem = document.querySelector(`.chat-group-item[data-chat-file="${CSS.escape(chat.file_name)}"]`);
    if (groupItem) {
        // Could add preview to grouped items too if desired
    }
}

function renderChats() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
    let filteredChats = allChats;
    
    // Apply search filter
    if (searchTerm) {
        filteredChats = allChats.filter(chat => {
            const chatName = (chat.file_name || '').toLowerCase();
            const charName = (chat.charName || '').toLowerCase();
            return chatName.includes(searchTerm) || charName.includes(searchTerm);
        });
    }
    
    // Apply sorting
    filteredChats = sortChats(filteredChats);
    
    if (currentGrouping === 'flat') {
        renderFlatChats(filteredChats);
    } else {
        renderGroupedChats(filteredChats);
    }
}

function sortChats(chats) {
    const sorted = [...chats];
    
    switch (currentChatSort) {
        case 'recent':
            sorted.sort((a, b) => {
                const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
                const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
                return dateB - dateA;
            });
            break;
        case 'oldest':
            sorted.sort((a, b) => {
                const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
                const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
                return dateA - dateB;
            });
            break;
        case 'char_asc':
            sorted.sort((a, b) => (a.charName || '').localeCompare(b.charName || ''));
            break;
        case 'char_desc':
            sorted.sort((a, b) => (b.charName || '').localeCompare(a.charName || ''));
            break;
        case 'most_messages':
            sorted.sort((a, b) => (b.chat_items || b.mes_count || 0) - (a.chat_items || a.mes_count || 0));
            break;
        case 'least_messages':
            sorted.sort((a, b) => (a.chat_items || a.mes_count || 0) - (b.chat_items || b.mes_count || 0));
            break;
        case 'longest_chat':
            // Longest by estimated content (messages * avg length)
            sorted.sort((a, b) => (b.chat_items || b.mes_count || 0) - (a.chat_items || a.mes_count || 0));
            break;
        case 'shortest_chat':
            sorted.sort((a, b) => (a.chat_items || a.mes_count || 0) - (b.chat_items || b.mes_count || 0));
            break;
        case 'most_chats':
            // Group by character and sort by chat count
            const charChatCounts = {};
            sorted.forEach(c => {
                charChatCounts[c.charAvatar] = (charChatCounts[c.charAvatar] || 0) + 1;
            });
            sorted.sort((a, b) => (charChatCounts[b.charAvatar] || 0) - (charChatCounts[a.charAvatar] || 0));
            break;
    }
    
    return sorted;
}

function renderFlatChats(chats) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');
    
    chatsGrid.classList.remove('hidden');
    groupedView.classList.add('hidden');
    
    if (chats.length === 0) {
        chatsGrid.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Matching Chats</h3>
                <p>Try a different search term.</p>
            </div>
        `;
        return;
    }
    
    chatsGrid.innerHTML = chats.map(chat => createChatCard(chat)).join('');
    
    // Add event listeners
    chatsGrid.querySelectorAll('.chat-card').forEach(card => {
        const chatFile = card.dataset.chatFile;
        const charAvatar = card.dataset.charAvatar;
        const chat = chats.find(c => c.file_name === chatFile && c.charAvatar === charAvatar);
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.chat-card-action')) return;
            openChatPreview(chat);
        });
        
        card.querySelector('.chat-card-action[data-action="open"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChatInST(chat);
        });
        
        card.querySelector('.chat-card-action[data-action="delete"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteChatFromView(chat);
        });
        
        // Character name click to open details modal
        card.querySelector('.clickable-char-name')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openCharacterDetailsFromChats(chat.character);
        });
    });
}

function renderGroupedChats(chats) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');
    
    chatsGrid.classList.add('hidden');
    groupedView.classList.remove('hidden');
    
    // Group by character
    const groups = {};
    chats.forEach(chat => {
        const key = chat.charAvatar;
        if (!groups[key]) {
            groups[key] = {
                character: chat.character,
                chats: []
            };
        }
        groups[key].chats.push(chat);
    });
    
    // Sort groups by most chats if that sort is selected
    let groupKeys = Object.keys(groups);
    if (currentChatSort === 'most_chats') {
        groupKeys.sort((a, b) => groups[b].chats.length - groups[a].chats.length);
    } else if (currentChatSort === 'char_asc') {
        groupKeys.sort((a, b) => (groups[a].character.name || '').localeCompare(groups[b].character.name || ''));
    } else if (currentChatSort === 'char_desc') {
        groupKeys.sort((a, b) => (groups[b].character.name || '').localeCompare(groups[a].character.name || ''));
    }
    
    if (groupKeys.length === 0) {
        groupedView.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Matching Chats</h3>
                <p>Try a different search term.</p>
            </div>
        `;
        return;
    }
    
    groupedView.innerHTML = groupKeys.map(key => {
        const group = groups[key];
        const char = group.character;
        const avatarUrl = getCharacterAvatarUrl(char.avatar);
        
        // Avatar with fallback
        const avatarHtml = avatarUrl 
            ? `<img src="${avatarUrl}" alt="${escapeHtml(char.name)}" class="chat-group-avatar" onerror="this.src='/img/ai4.png'">`
            : `<div class="chat-group-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
        
        return `
            <div class="chat-group" data-char-avatar="${escapeHtml(char.avatar)}">
                <div class="chat-group-header">
                    ${avatarHtml}
                    <div class="chat-group-info">
                        <div class="chat-group-name clickable-char-name" data-char-avatar="${escapeHtml(char.avatar)}" title="View character details">${escapeHtml(char.name)}</div>
                        <div class="chat-group-count">${group.chats.length} chat${group.chats.length !== 1 ? 's' : ''}</div>
                    </div>
                    <i class="fa-solid fa-chevron-down chat-group-toggle"></i>
                </div>
                <div class="chat-group-content">
                    ${group.chats.map(chat => createGroupedChatItem(chat)).join('')}
                </div>
            </div>
        `;
    }).join('');
    
    // Add event listeners for groups
    groupedView.querySelectorAll('.chat-group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // Don't toggle if clicking on character name
            if (e.target.closest('.clickable-char-name')) return;
            header.closest('.chat-group').classList.toggle('collapsed');
        });
        
        // Character name click to open details modal
        header.querySelector('.clickable-char-name')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const charAvatar = header.closest('.chat-group').dataset.charAvatar;
            const char = allCharacters.find(c => c.avatar === charAvatar);
            if (char) openCharacterDetailsFromChats(char);
        });
    });
    
    groupedView.querySelectorAll('.chat-group-item').forEach(item => {
        const chatFile = item.dataset.chatFile;
        const charAvatar = item.closest('.chat-group').dataset.charAvatar;
        const chat = chats.find(c => c.file_name === chatFile && c.charAvatar === charAvatar);
        
        item.addEventListener('click', (e) => {
            if (e.target.closest('.chat-card-action')) return;
            openChatPreview(chat);
        });
        
        item.querySelector('.chat-card-action[data-action="open"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChatInST(chat);
        });
        
        item.querySelector('.chat-card-action[data-action="delete"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteChatFromView(chat);
        });
    });
}

function createChatCard(chat) {
    const char = chat.character;
    const avatarUrl = getCharacterAvatarUrl(char.avatar);
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    const messageCount = chat.chat_items || chat.mes_count || chat.message_count || 0;
    const isActive = char.chat === chatName;
    
    // Preview: show loading if null, actual preview if available
    let previewHtml;
    if (chat.preview === null) {
        previewHtml = '<i class="fa-solid fa-spinner fa-spin" style="opacity: 0.5;"></i> <span style="opacity: 0.5;">Loading preview...</span>';
    } else if (chat.preview) {
        previewHtml = escapeHtml(chat.preview);
    } else {
        previewHtml = '<span style="opacity: 0.5;">No messages</span>';
    }
    
    // Avatar with fallback
    const avatarHtml = avatarUrl 
        ? `<img src="${avatarUrl}" alt="${escapeHtml(char.name)}" class="chat-card-avatar" onerror="this.src='/img/ai4.png'">`
        : `<div class="chat-card-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
    
    return `
        <div class="chat-card ${isActive ? 'active' : ''}" data-chat-file="${escapeHtml(chat.file_name)}" data-char-avatar="${escapeHtml(char.avatar)}">
            <div class="chat-card-header">
                ${avatarHtml}
                <div class="chat-card-char-info">
                    <div class="chat-card-char-name clickable-char-name" data-char-avatar="${escapeHtml(char.avatar)}" title="View character details">${escapeHtml(char.name)}</div>
                    <div class="chat-card-chat-name">${escapeHtml(chatName)}</div>
                </div>
            </div>
            <div class="chat-card-body">
                <div class="chat-card-preview">${previewHtml}</div>
            </div>
            <div class="chat-card-footer">
                <div class="chat-card-meta">
                    <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                    <span><i class="fa-solid fa-comment"></i> ${messageCount}</span>
                </div>
                <div class="chat-card-actions">
                    <button class="chat-card-action" data-action="open" title="Open in SillyTavern">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </button>
                    <button class="chat-card-action danger" data-action="delete" title="Delete chat">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function createGroupedChatItem(chat) {
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    const messageCount = chat.chat_items || chat.mes_count || chat.message_count || 0;
    
    // Preview text
    let previewText;
    if (chat.preview === null) {
        previewText = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    } else if (chat.preview) {
        previewText = escapeHtml(chat.preview);
    } else {
        previewText = '<span class="no-preview">No messages</span>';
    }
    
    return `
        <div class="chat-group-item" data-chat-file="${escapeHtml(chat.file_name)}">
            <div class="chat-group-item-icon"><i class="fa-solid fa-message"></i></div>
            <div class="chat-group-item-info">
                <div class="chat-group-item-name">${escapeHtml(chatName)}</div>
                <div class="chat-group-item-preview">${previewText}</div>
                <div class="chat-group-item-meta">
                    <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                    <span><i class="fa-solid fa-comment"></i> ${messageCount}</span>
                </div>
            </div>
            <div class="chat-group-item-actions">
                <button class="chat-card-action" data-action="open" title="Open in SillyTavern">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </button>
                <button class="chat-card-action danger" data-action="delete" title="Delete chat">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

// Chat Preview Modal
async function openChatPreview(chat) {
    currentPreviewChat = chat;
    currentPreviewChar = chat.character;
    
    const modal = document.getElementById('chatPreviewModal');
    const avatarImg = document.getElementById('chatPreviewAvatar');
    const title = document.getElementById('chatPreviewTitle');
    const charName = document.getElementById('chatPreviewCharName');
    const messageCount = document.getElementById('chatPreviewMessageCount');
    const date = document.getElementById('chatPreviewDate');
    const messagesContainer = document.getElementById('chatPreviewMessages');
    
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const avatarUrl = getCharacterAvatarUrl(chat.character.avatar) || '/img/ai4.png';
    
    avatarImg.src = avatarUrl;
    title.textContent = chatName;
    charName.textContent = chat.character.name;
    charName.className = 'clickable-char-name';
    charName.title = 'View character details';
    charName.style.cursor = 'pointer';
    charName.onclick = (e) => {
        e.preventDefault();
        openCharacterDetailsFromChats(chat.character);
    };
    messageCount.textContent = chat.chat_items || chat.mes_count || '?';
    date.textContent = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    
    renderLoadingState(messagesContainer, 'Loading messages...', 'chats-loading');
    
    modal.classList.remove('hidden');
    
    // Load chat content
    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        
        debugLog(`[ChatPreview] Loading chat: ${chatFileName} for ${chat.character.name}`);
        
        const response = await apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
            ch_name: chat.character.name,
            file_name: chatFileName,
            avatar_url: chat.character.avatar
        });
        
        debugLog(`[ChatPreview] Response status: ${response.status}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ChatPreview] Error response:`, errorText);
            throw new Error(`HTTP ${response.status}`);
        }
        
        const messages = await response.json();
        debugLog(`[ChatPreview] Got ${messages?.length || 0} messages`);
        renderChatMessages(messages, chat.character);
        
    } catch (e) {
        console.error('Failed to load chat:', e);
        messagesContainer.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Could Not Load Chat</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

// Store current messages for editing
let currentChatMessages = [];

function renderChatMessages(messages, character) {
    const container = document.getElementById('chatPreviewMessages');
    
    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>Empty Chat</h3>
                <p>This chat has no messages.</p>
            </div>
        `;
        currentChatMessages = [];
        return;
    }
    
    // Store messages for editing
    currentChatMessages = messages;
    
    const avatarUrl = getCharacterAvatarUrl(character.avatar) || '/img/ai4.png';
    
    container.innerHTML = messages.map((msg, index) => {
        const isUser = msg.is_user;
        const isSystem = msg.is_system;
        const name = msg.name || (isUser ? 'User' : character.name);
        const text = msg.mes || '';
        const time = msg.send_date ? new Date(msg.send_date).toLocaleString() : '';
        
        // Format message text with rich text (italics, bold, HTML tags, etc.)
        const formattedText = formatRichText(text, character.name, true);
        
        // Skip rendering metadata-only messages (chat header)
        if (index === 0 && msg.chat_metadata && !msg.mes) {
            return ''; // Don't render the metadata header as a message
        }
        
        // Action buttons for edit/delete (hide for metadata entries)
        const isMetadata = msg.chat_metadata !== undefined;
        const actionButtons = isMetadata ? '' : `
            <div class="chat-message-actions">
                <button class="chat-msg-action-btn" data-action="edit" data-index="${index}" title="Edit message">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="chat-msg-action-btn danger" data-action="delete" data-index="${index}" title="Delete message">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
        
        if (isSystem) {
            return `
                <div class="chat-message system" data-msg-index="${index}">
                    <div class="chat-message-content">
                        <div class="chat-message-text">${formattedText}</div>
                    </div>
                    ${actionButtons}
                </div>
            `;
        }
        
        return `
            <div class="chat-message ${isUser ? 'user' : 'assistant'}" data-msg-index="${index}">
                ${!isUser ? `<img src="${avatarUrl}" alt="" class="chat-message-avatar" onerror="this.style.display='none'">` : ''}
                <div class="chat-message-content">
                    <div class="chat-message-name">${escapeHtml(name)}</div>
                    <div class="chat-message-text">${formattedText}</div>
                    ${time ? `<div class="chat-message-time">${time}</div>` : ''}
                </div>
                ${actionButtons}
            </div>
        `;
    }).join('');
    
    // Add event listeners for message actions
    container.querySelectorAll('.chat-msg-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const index = parseInt(btn.dataset.index, 10);
            
            if (action === 'edit') {
                editChatMessage(index);
            } else if (action === 'delete') {
                deleteChatMessage(index);
            }
        });
    });
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

async function openChatInST(chat) {
    openChat(chat.character, chat.file_name);
}

async function deleteChatFromView(chat) {
    if (!confirm(`Delete this chat?\n\n${chat.file_name}\n\nThis cannot be undone!`)) {
        return;
    }
    
    try {
        const response = await apiRequest(ENDPOINTS.CHATS_DELETE, 'POST', {
            chatfile: chat.file_name,
            avatar_url: chat.character.avatar
        });
        
        if (response.ok) {
            showToast('Chat deleted', 'success');
            
            // Remove from allChats
            const idx = allChats.findIndex(c => c.file_name === chat.file_name && c.charAvatar === chat.charAvatar);
            if (idx !== -1) {
                allChats.splice(idx, 1);
            }
            
            // Close preview modal if open
            if (currentPreviewChat === chat) {
                document.getElementById('chatPreviewModal').classList.add('hidden');
            }
            
            // Re-render
            renderChats();
        } else {
            showToast('Failed to delete chat', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

/**
 * Open character details modal from the Chats view
 * This opens the modal without switching away from chats view
 */
function openCharacterDetailsFromChats(char) {
    if (!char) return;
    openModal(char);
}

/**
 * Edit a specific message in the current chat
 */
async function editChatMessage(messageIndex) {
    if (!currentPreviewChat || !currentChatMessages[messageIndex]) {
        showToast('Message not found', 'error');
        return;
    }
    
    const msg = currentChatMessages[messageIndex];
    const currentText = msg.mes || '';
    
    // Create edit modal
    const editModalHtml = `
        <div id="editMessageModal" class="modal-overlay">
            <div class="modal-glass" style="max-width: 600px; width: 90%;">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-pen"></i> Edit Message</h2>
                    <button class="close-btn" id="editMessageClose">&times;</button>
                </div>
                <div style="padding: 20px;">
                    <div class="edit-message-info" style="margin-bottom: 15px; font-size: 0.85rem; color: var(--text-secondary);">
                        <span><strong>${escapeHtml(msg.name || (msg.is_user ? 'User' : currentPreviewChar?.name || 'Character'))}</strong></span>
                        ${msg.send_date ? `<span> \u2022 ${new Date(msg.send_date).toLocaleString()}</span>` : ''}
                    </div>
                    <textarea id="editMessageText" class="glass-input" style="width: 100%; min-height: 200px; resize: vertical;">${escapeHtml(currentText)}</textarea>
                    <div style="display: flex; gap: 10px; margin-top: 15px; justify-content: flex-end;">
                        <button id="editMessageCancel" class="action-btn secondary">Cancel</button>
                        <button id="editMessageSave" class="action-btn primary"><i class="fa-solid fa-save"></i> Save</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Add modal to DOM
    const existingModal = document.getElementById('editMessageModal');
    if (existingModal) existingModal.remove();
    document.body.insertAdjacentHTML('beforeend', editModalHtml);
    
    const editModal = document.getElementById('editMessageModal');
    const textarea = document.getElementById('editMessageText');
    
    // Focus textarea
    setTimeout(() => textarea.focus(), 50);
    
    // Close handlers
    const closeEditModal = () => editModal.remove();
    
    document.getElementById('editMessageClose').onclick = closeEditModal;
    document.getElementById('editMessageCancel').onclick = closeEditModal;
    editModal.onclick = (e) => { if (e.target === editModal) closeEditModal(); };
    
    // Save handler
    document.getElementById('editMessageSave').onclick = async () => {
        const newText = textarea.value;
        if (newText === currentText) {
            closeEditModal();
            return;
        }
        
        try {
            // Update the message in local array
            currentChatMessages[messageIndex].mes = newText;
            
            // Save the entire chat
            const success = await saveChatToServer(currentPreviewChat, currentChatMessages);
            
            if (success) {
                showToast('Message updated', 'success');
                closeEditModal();
                renderChatMessages(currentChatMessages, currentPreviewChat.character);
                clearChatCache();
            } else {
                // Revert local change on failure
                currentChatMessages[messageIndex].mes = currentText;
                showToast('Failed to save changes', 'error');
            }
        } catch (e) {
            // Revert local change on error
            currentChatMessages[messageIndex].mes = currentText;
            showToast('Error: ' + e.message, 'error');
        }
    };
}

/**
 * Delete a specific message from the current chat
 */
async function deleteChatMessage(messageIndex) {
    if (!currentPreviewChat || !currentChatMessages[messageIndex]) {
        showToast('Message not found', 'error');
        return;
    }
    
    // Prevent deleting the first message (chat metadata header)
    if (messageIndex === 0 && currentChatMessages[0]?.chat_metadata) {
        showToast('Cannot delete chat metadata header', 'error');
        return;
    }
    
    const msg = currentChatMessages[messageIndex];
    const previewText = (msg.mes || '').substring(0, 100) + (msg.mes?.length > 100 ? '...' : '');
    
    if (!confirm(`Delete this message?\n\n"${previewText}"\n\nThis cannot be undone!`)) {
        return;
    }
    
    try {
        // Store the message in case we need to restore
        const deletedMsg = currentChatMessages[messageIndex];
        
        // Remove from local array
        currentChatMessages.splice(messageIndex, 1);
        
        // Save the entire chat
        const success = await saveChatToServer(currentPreviewChat, currentChatMessages);
        
        if (success) {
            showToast('Message deleted', 'success');
            renderChatMessages(currentChatMessages, currentPreviewChat.character);
            
            // Update message count in preview
            const countEl = document.getElementById('chatPreviewMessageCount');
            if (countEl) {
                countEl.textContent = currentChatMessages.length;
            }
            
            clearChatCache();
        } else {
            // Restore the message on failure
            currentChatMessages.splice(messageIndex, 0, deletedMsg);
            showToast('Failed to delete message', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    }
}

/**
 * Save the entire chat array to the server
 */
async function saveChatToServer(chat, messages) {
    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        
        const response = await apiRequest(ENDPOINTS.CHATS_SAVE, 'POST', {
            ch_name: chat.character.name,
            file_name: chatFileName,
            avatar_url: chat.character.avatar,
            chat: messages
        });
        
        if (response.ok) {
            const result = await response.json();
            return result.ok === true;
        } else {
            const err = await response.text();
            console.error('Failed to save chat:', err);
            return false;
        }
    } catch (e) {
        console.error('Error saving chat:', e);
        return false;
    }
}

// Search input should also filter chats when in chats view (debounced)
const searchInputForChats = document.getElementById('searchInput');
if (searchInputForChats) {
    searchInputForChats.addEventListener('input', debounce(() => {
        if (currentView === 'chats') {
            renderChats();
        }
    }, 150));
}

// ========================================
// CHUBAI BROWSER
// ========================================

// CHUB_API_BASE and CHUB_AVATAR_BASE defined in CORE HELPER FUNCTIONS section
const CHUB_CACHE_KEY = 'st_gallery_chub_cache';
const CHUB_TOKEN_KEY = 'st_gallery_chub_urql_token';

let chubCharacters = [];
let chubCurrentPage = 1;
let chubHasMore = true;
let chubIsLoading = false;
let chubDiscoveryPreset = 'popular_week'; // Combined sort + time preset
let chubNsfwEnabled = true; // Default to NSFW enabled
let chubCurrentSearch = '';
let chubSelectedChar = null;
let chubToken = null; // URQL_TOKEN from chub.ai localStorage for Authorization Bearer

// Discovery preset definitions (sort + time combinations)
const CHUB_DISCOVERY_PRESETS = {
    'popular_week':  { sort: 'download_count', days: 7 },
    'popular_month': { sort: 'download_count', days: 30 },
    'popular_all':   { sort: 'download_count', days: 0 },
    'rated_week':    { sort: 'star_count', days: 7 },
    'rated_all':     { sort: 'star_count', days: 0 },
    'newest':        { sort: 'id', days: 30 }, // Last 30 days of new chars (id = creation order)
    'updated':       { sort: 'last_activity_at', days: 0 }, // Recently updated characters
    'recent_hits':   { sort: 'default', days: 0, special_mode: 'newcomer' }, // Recent hits - new characters getting lots of activity
    'random':        { sort: 'random', days: 0 }
};

// Additional ChubAI filters
let chubFilterImages = false;
let chubFilterLore = false;
let chubFilterExpressions = false;
let chubFilterGreetings = false;
let chubFilterFavorites = false;
let chubFilterHideOwned = false;

// Advanced ChubAI filters (Tags dropdown)
let chubTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>
let chubSortAscending = false; // false = descending (default), true = ascending
let chubMinTokens = 50; // Minimum tokens (API default)
let chubMaxTokens = 100000; // Maximum tokens

// ChubAI View mode and author filter
let chubViewMode = 'browse'; // 'browse' or 'timeline'
let chubAuthorFilter = null; // Username to filter by
let chubAuthorSort = 'id'; // Sort for author view (id = newest)
let chubTimelineCharacters = [];
let chubTimelinePage = 1;
let chubTimelineCursor = null; // Cursor for pagination
let chubTimelineHasMore = true;
let chubTimelineSort = 'newest'; // Sort for timeline view (client-side)
let chubFollowedAuthors = []; // Cache of followed author usernames
let chubUserFavoriteIds = new Set(); // Cache of user's favorited character IDs
let chubCurrentUsername = null; // Current logged-in username
let chubCardLookup = new Map();
let chubTimelineLookup = new Map();
let chubDelegatesInitialized = false;
let chubDetailFetchController = null; // AbortController for in-flight detail fetches
const chubDetailCache = new Map();
const CHUB_DETAIL_CACHE_MAX = 5; // LRU cap — keep small for mobile memory (stripped entries only)

// Local library lookup for marking characters as "In Library"
let localLibraryLookup = {
    byName: new Set(),           // Lowercase names
    byNameAndCreator: new Set(), // "name|creator" combos
    byChubPath: new Set()        // ChubAI fullPath if stored
};

// Build local library lookup from allCharacters
function buildLocalLibraryLookup() {
    localLibraryLookup.byName.clear();
    localLibraryLookup.byNameAndCreator.clear();
    localLibraryLookup.byChubPath.clear();
    
    for (const char of allCharacters) {
        if (!char) continue;
        
        // Add lowercase name
        const name = (char.name || '').toLowerCase().trim();
        if (name) {
            localLibraryLookup.byName.add(name);
        }
        
        // Add name + creator combo if creator exists
        const creator = (char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) {
            localLibraryLookup.byNameAndCreator.add(`${name}|${creator}`);
        }
        
        // Check for ChubAI source in extensions data
        const chubData = char.data?.extensions?.chub;
        const chubPath = chubData?.fullPath || chubData?.full_path || '';
        const chubUrl = chubData?.url || char.chub_url || char.source_url || '';
        
        // Direct fullPath from our link feature
        if (chubPath) {
            localLibraryLookup.byChubPath.add(chubPath.toLowerCase());
        }
        
        // Also check URL-based sources
        if (chubUrl) {
            // Extract path from URL like "https://chub.ai/characters/username/slug"
            const match = chubUrl.match(/characters\/([^\/]+\/[^\/\?]+)/);
            if (match) {
                localLibraryLookup.byChubPath.add(match[1].toLowerCase());
            } else if (chubUrl.includes('/')) {
                // Might be just "username/slug"
                localLibraryLookup.byChubPath.add(chubUrl.toLowerCase());
            }
        }
    }
    
    debugLog('[LocalLibrary] Built lookup:', 
        'names:', localLibraryLookup.byName.size,
        'name+creator:', localLibraryLookup.byNameAndCreator.size,
        'chubPaths:', localLibraryLookup.byChubPath.size);
}

// Check if a ChubAI character exists in local library
function isCharInLocalLibrary(chubChar) {
    const fullPath = (chubChar.fullPath || chubChar.full_path || '').toLowerCase();
    const name = (chubChar.name || '').toLowerCase().trim();
    const creator = fullPath.split('/')[0] || '';
    
    // Best match: exact ChubAI path
    if (fullPath && localLibraryLookup.byChubPath.has(fullPath)) {
        return true;
    }
    
    // Good match: name + creator combo
    if (name && creator && localLibraryLookup.byNameAndCreator.has(`${name}|${creator}`)) {
        return true;
    }
    
    // Acceptable match: just name (might have false positives for common names)
    // Only use this if name is reasonably unique (length > 3)
    if (name && name.length > 3 && localLibraryLookup.byName.has(name)) {
        return true;
    }
    
    return false;
}

function getChubFullPath(char) {
    return char.fullPath || char.full_path || '';
}

function buildChubLookup(targetMap, characters) {
    targetMap.clear();
    for (const char of characters) {
        const path = getChubFullPath(char);
        if (path) targetMap.set(path, char);
    }
}

// Dynamic tags - populated from ChubAI API
let chubPopularTags = [];
let chubTagsLoading = false;
let chubTagsLoaded = false;

/**
 * Render creator notes with simple sanitized HTML (no iframe, no custom CSS)
 * This is the fallback when rich rendering is disabled
 * @param {string} content - The creator notes content
 * @param {string} charName - Character name for placeholder replacement
 * @param {HTMLElement} container - Container element to render into
 */
function renderCreatorNotesSimple(content, charName, container) {
    if (!content || !container) return;
    
    // Use formatRichText without preserveHtml to get basic markdown formatting
    const formattedNotes = formatRichText(content, charName, false);
    
    // Strict DOMPurify sanitization - no style tags, minimal allowed elements
    const sanitizedNotes = typeof DOMPurify !== 'undefined' 
        ? DOMPurify.sanitize(formattedNotes, {
            ALLOWED_TAGS: [
                'p', 'br', 'hr', 'div', 'span',
                'strong', 'b', 'em', 'i', 'u', 's', 'del',
                'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'tr', 'td', 'th', 'thead', 'tbody'
            ],
            ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'class'],
            ADD_ATTR: ['target'],
            FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'style', 'link'],
            FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style'],
            ALLOW_UNKNOWN_PROTOCOLS: false,
            KEEP_CONTENT: true
        })
        : escapeHtml(formattedNotes);
    
    container.innerHTML = sanitizedNotes;
}

// ============================================================================
// CREATOR NOTES MODULE - Secure iframe-based rich content rendering
// ============================================================================

/**
 * Configuration for Creator Notes rendering
 */
const CreatorNotesConfig = {
    MIN_HEIGHT: 50,
    MAX_HEIGHT: 600,  // Height before scrollbar kicks in
    MIN_LINES_FOR_EXPAND: 10, // Show expand button when content has at least this many lines
    MIN_CHARS_FOR_EXPAND: 500, // Or when content exceeds this character count
    BODY_PADDING: 10, // 5px top + 5px bottom
    RESIZE_DEBOUNCE: 16, // ~60fps
};

/**
 * Sanitize CSS content to remove dangerous patterns
 * @param {string} content - Raw CSS/HTML content
 * @returns {string} - Sanitized content
 */
function sanitizeCreatorNotesCSS(content) {
    const dangerousPatterns = [
        /position\s*:\s*(fixed|sticky)/gi,
        /z-index\s*:\s*(\d{4,}|[5-9]\d{2})/gi,
        /-moz-binding\s*:/gi,
        /behavior\s*:/gi,
        /expression\s*\(/gi,
        /@import\s+(?!url\s*\()/gi,
        /javascript\s*:/gi,
        /vbscript\s*:/gi,
    ];
    
    let sanitized = content;
    dangerousPatterns.forEach(pattern => {
        sanitized = sanitized.replace(pattern, '/* blocked */ ');
    });
    return sanitized;
}

/**
 * Sanitize HTML content with DOMPurify (permissive for rich styling)
 * @param {string} content - Raw HTML content
 * @returns {string} - Sanitized HTML
 */
function sanitizeCreatorNotesHTML(content) {
    if (typeof DOMPurify === 'undefined') {
        return escapeHtml(content);
    }
    
    return DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
            'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
            'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
            'table', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col',
            'center', 'font', 'sub', 'sup', 'small', 'big',
            'details', 'summary', 'abbr', 'cite', 'q', 'dl', 'dt', 'dd',
            'figure', 'figcaption', 'article', 'section', 'aside', 'header', 'footer', 'nav', 'main',
            'address', 'time', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
            'style'
        ],
        ALLOWED_ATTR: [
            'href', 'src', 'alt', 'title', 'class', 'id', 'style', 'target',
            'width', 'height', 'align', 'valign', 'border', 'cellpadding', 'cellspacing',
            'colspan', 'rowspan', 'color', 'face', 'size', 'name', 'rel',
            'bgcolor', 'background', 'start', 'type', 'value', 'reversed',
            'dir', 'lang', 'translate', 'hidden', 'tabindex', 'accesskey',
            'data-*'
        ],
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'link', 'base', 'noscript'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onmouseout', 'onmousedown', 'onmouseup', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress'],
        ALLOW_DATA_ATTR: true,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true
    });
}

/**
 * Add referrer policy to media elements for privacy
 * @param {string} content - HTML content
 * @returns {string} - Hardened HTML
 */
function hardenCreatorNotesMedia(content) {
    return content
        .replace(/<img\s/gi, '<img referrerpolicy="no-referrer" ')
        .replace(/<video\s/gi, '<video referrerpolicy="no-referrer" ')
        .replace(/<audio\s/gi, '<audio referrerpolicy="no-referrer" ');
}

/**
 * Generate the base CSS styles for iframe content
 * @returns {string} - CSS style block
 */
function getCreatorNotesBaseStyles() {
    return `
        <style>
            * { box-sizing: border-box; }
            html {
                margin: 0;
                padding: 0;
            }
            body {
                margin: 0;
                padding: 5px;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                color: #e0e0e0;
                background: transparent;
                line-height: 1.5;
                overflow-wrap: break-word;
                word-wrap: break-word;
                font-size: 14px;
            }
            #content-wrapper {
                display: block;
                width: 100%;
            }
            
            img, video, canvas, svg {
                max-width: 100% !important;
                height: auto !important;
                display: block;
                margin: 10px auto;
                border-radius: 8px;
            }
            
            a { color: #4a9eff; text-decoration: none; }
            a:hover { text-decoration: underline; }
            
            h1 { color: #4a9eff; margin: 12px 0 8px 0; font-size: 1.6em; }
            h2 { color: #4a9eff; margin: 12px 0 8px 0; font-size: 1.4em; }
            h3 { color: #4a9eff; margin: 10px 0 6px 0; font-size: 1.2em; }
            h4, h5, h6 { color: #4a9eff; margin: 8px 0 4px 0; font-size: 1.1em; }
            
            strong, b { color: #fff; }
            em, i { color: #ddd; font-style: italic; }
            
            p { margin: 0 0 0.8em 0; }
            
            blockquote {
                margin: 10px 0;
                padding: 10px 15px;
                border-left: 3px solid #4a9eff;
                background: rgba(74, 158, 255, 0.1);
                border-radius: 0 8px 8px 0;
            }
            
            pre {
                background: rgba(0,0,0,0.3);
                padding: 10px;
                border-radius: 6px;
                overflow-x: auto;
                white-space: pre-wrap;
                word-wrap: break-word;
            }
            
            code {
                background: rgba(0,0,0,0.3);
                padding: 2px 6px;
                border-radius: 4px;
                font-family: 'Consolas', 'Monaco', monospace;
            }
            
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 10px 0;
                background: rgba(0,0,0,0.2);
                border-radius: 8px;
                overflow: hidden;
            }
            td, th {
                padding: 8px 12px;
                border: 1px solid rgba(255,255,255,0.1);
            }
            th {
                background: rgba(74, 158, 255, 0.2);
                color: #4a9eff;
            }
            
            hr {
                border: none;
                border-top: 1px solid rgba(255,255,255,0.15);
                margin: 15px 0;
            }
            
            ul, ol { padding-left: 25px; margin: 8px 0; }
            li { margin: 4px 0; }
            
            .embedded-image {
                max-width: 100% !important;
                height: auto !important;
                border-radius: 8px;
                margin: 10px auto;
                display: block;
            }
            
            .embedded-link { color: #4a9eff; }
            
            .audio-player,
            .embedded-audio {
                width: 100%;
                max-width: 400px;
                height: 40px;
                margin: 10px 0;
                display: block;
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.3);
            }
            .audio-player::-webkit-media-controls-panel {
                background: rgba(255, 255, 255, 0.1);
            }
            .audio-player::-webkit-media-controls-play-button,
            .audio-player::-webkit-media-controls-mute-button {
                filter: invert(1);
            }
            
            .placeholder-user { color: #2ecc71; font-weight: bold; }
            .placeholder-char { color: #e74c3c; font-weight: bold; }
            
            /* Neutralize dangerous positioning from user CSS */
            [style*="position: fixed"], [style*="position:fixed"],
            [style*="position: sticky"], [style*="position:sticky"] {
                position: static !important;
            }
            [style*="z-index"] {
                z-index: auto !important;
            }
        </style>
    `;
}

/**
 * Build complete iframe HTML document
 * @param {string} content - Sanitized content
 * @returns {string} - Complete HTML document
 */
function buildCreatorNotesIframeDoc(content) {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src * data:;">`;
    const styles = getCreatorNotesBaseStyles();
    
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">${csp}${styles}</head><body><div id="content-wrapper">${content}</div></body></html>`;
}

/**
 * Create and configure the sandboxed iframe
 * @param {string} srcdoc - The iframe document content
 * @returns {HTMLIFrameElement} - Configured iframe element
 */
function createCreatorNotesIframe(srcdoc) {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
    iframe.style.cssText = `
        width: 100%;
        height: ${CreatorNotesConfig.MIN_HEIGHT}px;
        min-height: ${CreatorNotesConfig.MIN_HEIGHT}px;
        max-height: none;
        border: none;
        background: transparent;
        border-radius: 8px;
        display: block;
    `;
    iframe.srcdoc = srcdoc;
    return iframe;
}

/**
 * Setup auto-resize behavior for creator notes iframe
 * Handles both short content (auto-fit) and long content (scrollable)
 * @param {HTMLIFrameElement} iframe - The iframe element
 */
function setupCreatorNotesResize(iframe) {
    iframe.onload = () => {
        try {
            const doc = iframe.contentDocument;
            const wrapper = doc?.getElementById('content-wrapper');
            
            if (!doc || !wrapper) {
                iframe.style.height = '200px';
                return;
            }
            
            let currentHeight = 0;
            let resizeObserver = null;
            
            const measureAndApply = () => {
                if (!wrapper) return;
                
                const rect = wrapper.getBoundingClientRect();
                const contentHeight = Math.ceil(rect.height) + CreatorNotesConfig.BODY_PADDING;
                
                // If content fits within max height, show it all (no scroll)
                // If content exceeds max height, cap at max and enable scrolling
                const needsScroll = contentHeight > CreatorNotesConfig.MAX_HEIGHT;
                const targetHeight = needsScroll 
                    ? CreatorNotesConfig.MAX_HEIGHT 
                    : Math.max(CreatorNotesConfig.MIN_HEIGHT, contentHeight);
                
                // Apply overflow based on whether we need scrolling
                doc.body.style.overflowY = needsScroll ? 'auto' : 'hidden';
                doc.body.style.overflowX = 'hidden';
                
                // Only update if changed significantly
                if (Math.abs(targetHeight - currentHeight) > 3) {
                    currentHeight = targetHeight;
                    iframe.style.height = targetHeight + 'px';
                }
            };
            
            // Use ResizeObserver for dynamic content
            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(measureAndApply);
                resizeObserver.observe(wrapper);
                // Store on iframe so cleanup can disconnect it
                iframe._resizeObserver = resizeObserver;
            }
            
            // Handle lazy-loaded images
            doc.querySelectorAll('img').forEach(img => {
                if (!img.complete) {
                    img.addEventListener('load', measureAndApply);
                    img.addEventListener('error', measureAndApply);
                }
            });
            
            // Initial measurements with delays for CSS parsing
            measureAndApply();
            setTimeout(measureAndApply, 50);
            setTimeout(measureAndApply, 150);
            setTimeout(measureAndApply, 400);
            
        } catch (e) {
            console.error('Creator notes resize error:', e);
            iframe.style.height = '200px';
        }
    };
}

/**
 * Render creator notes in a sandboxed iframe with full CSS support
 * Main entry point for rich creator notes rendering
 * @param {string} content - The creator notes content
 * @param {string} charName - Character name for placeholder replacement
 * @param {HTMLElement} container - Container element to render into
 */
/**
 * Clean up an existing creator notes iframe — disconnect observer, blank src, remove DOM
 * @param {HTMLElement} container - The container holding the iframe
 */
function cleanupCreatorNotesContainer(container) {
    if (!container) return;
    const iframe = container.querySelector('iframe');
    if (iframe) {
        // Disconnect the ResizeObserver to break circular references
        if (iframe._resizeObserver) {
            try { iframe._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
            iframe._resizeObserver = null;
        }
        // Clear onload to prevent stale closure from firing
        iframe.onload = null;
        try { iframe.src = 'about:blank'; } catch (e) { /* ignore */ }
    }
    container.innerHTML = '';
}

function renderCreatorNotesSecure(content, charName, container) {
    if (!content || !container) return;
    
    // Clean up any existing iframe + ResizeObserver before creating a new one
    cleanupCreatorNotesContainer(container);
    
    // Check if rich rendering is enabled
    if (!getSetting('richCreatorNotes')) {
        renderCreatorNotesSimple(content, charName, container);
        return;
    }
    
    // Process pipeline: format -> sanitize HTML -> sanitize CSS -> harden media
    const formatted = formatRichText(content, charName, true);
    const sanitizedHTML = sanitizeCreatorNotesHTML(formatted);
    const sanitizedCSS = sanitizeCreatorNotesCSS(sanitizedHTML);
    const hardened = hardenCreatorNotesMedia(sanitizedCSS);
    
    // Build and insert iframe
    const iframeDoc = buildCreatorNotesIframeDoc(hardened);
    const iframe = createCreatorNotesIframe(iframeDoc);
    
    container.appendChild(iframe);
    
    // Setup resize behavior
    setupCreatorNotesResize(iframe);
}

/**
 * Open creator notes in a fullscreen modal
 * Shows content with more vertical space for reading
 * @param {string} content - The creator notes content  
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openCreatorNotesFullscreen(content, charName, urlMap) {
    if (!content) {
        showToast('No creator notes to display', 'warning');
        return;
    }
    
    // Apply media localization if urlMap is provided
    let localizedContent = content;
    if (urlMap && Object.keys(urlMap).length > 0) {
        localizedContent = replaceMediaUrlsInText(content, urlMap);
    }
    
    // Process content through the same pipeline
    const formatted = formatRichText(localizedContent, charName, true);
    const sanitizedHTML = sanitizeCreatorNotesHTML(formatted);
    const sanitizedCSS = sanitizeCreatorNotesCSS(sanitizedHTML);
    const hardened = hardenCreatorNotesMedia(sanitizedCSS);
    
    // Build simple iframe document - content fills width naturally
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src * data:;">`;
    const styles = getCreatorNotesBaseStyles();
    const iframeDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8">${csp}${styles}</head><body style="overflow-y: auto; overflow-x: hidden; height: 100%; padding: 15px;"><div id="content-wrapper">${hardened}</div></body></html>`;
    
    // Build simple fullscreen modal - size and zoom buttons
    const modalHtml = `
        <div id="creatorNotesFullscreenModal" class="modal-overlay">
            <div class="modal-glass creator-notes-fullscreen-modal" id="creatorNotesFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-feather-pointed"></i> Creator's Notes</h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns zoom-controls" id="zoomControlBtns">
                            <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                                <i class="fa-solid fa-minus"></i>
                            </button>
                            <span class="zoom-level" id="zoomLevelDisplay">100%</span>
                            <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        </div>
                        <div class="display-control-btns" id="sizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="creatorNotesFullscreenClose">&times;</button>
                    </div>
                </div>
                <div class="creator-notes-fullscreen-body">
                    <iframe 
                        id="creatorNotesFullscreenIframe"
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    ></iframe>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('creatorNotesFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('creatorNotesFullscreenModal');
    const modalInner = document.getElementById('creatorNotesFullscreenInner');
    const iframe = document.getElementById('creatorNotesFullscreenIframe');
    
    // Set iframe content
    iframe.srcdoc = iframeDoc;
    
    // Size control handlers - just toggle class on modal
    on('sizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#sizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Zoom control handlers for iframe content
    let currentZoom = 100;
    const zoomDisplay = document.getElementById('zoomLevelDisplay');
    
    const updateIframeZoom = (zoom) => {
        currentZoom = Math.max(50, Math.min(200, zoom));
        zoomDisplay.textContent = `${currentZoom}%`;
        const scale = currentZoom / 100;
        
        const applyZoom = () => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc && iframeDoc.body) {
                    const wrapper = iframeDoc.getElementById('content-wrapper');
                    if (wrapper) {
                        // Use transform on wrapper - scales everything including images
                        wrapper.style.transform = `scale(${scale})`;
                        // Use top center origin to keep content horizontally centered
                        wrapper.style.transformOrigin = 'top center';
                        // Adjust wrapper width so scaled content fits properly
                        wrapper.style.width = scale <= 1 ? '100%' : `${100 / scale}%`;
                        // Center the wrapper itself
                        wrapper.style.margin = '0 auto';
                    }
                    // Also try CSS zoom as fallback for browsers that support it
                    iframeDoc.body.style.zoom = scale;
                }
            } catch (e) {
                console.warn('Could not apply zoom to iframe:', e);
            }
        };
        
        applyZoom();
    };
    
    // Apply zoom after iframe content loads
    iframe.addEventListener('load', () => {
        // Small delay to ensure content is fully rendered
        setTimeout(() => updateIframeZoom(currentZoom), 50);
    });
    
    on('zoomControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        
        const action = btn.dataset.zoom;
        if (action === 'in') updateIframeZoom(currentZoom + 10);
        else if (action === 'out') updateIframeZoom(currentZoom - 10);
        else if (action === 'reset') updateIframeZoom(100);
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('creatorNotesFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Initialize creator notes event handlers
 * Call this after modal content is loaded
 */
function initCreatorNotesHandlers() {
    const expandBtn = document.getElementById('creatorNotesExpandBtn');
    
    // Expand button opens fullscreen modal
    // Use a named handler reference to prevent listener accumulation across modal opens
    if (expandBtn) {
        // Remove any previously attached handler before adding a new one
        if (expandBtn._creatorNotesHandler) {
            expandBtn.removeEventListener('click', expandBtn._creatorNotesHandler);
        }
        expandBtn._creatorNotesHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent toggling the details
            
            // Get the current creator notes content from the stored data
            const charName = document.getElementById('modalCharName')?.textContent || 'Character';
            
            // We need to get the raw content - check if it's stored
            if (window.currentCreatorNotesContent) {
                // Build localization map if enabled for this character
                let urlMap = null;
                if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                    const folderName = getGalleryFolderName(activeChar);
                    urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
                }
                openCreatorNotesFullscreen(window.currentCreatorNotesContent, charName, urlMap);
            } else {
                showToast('Creator notes not available', 'warning');
            }
        };
        expandBtn.addEventListener('click', expandBtn._creatorNotesHandler);
    }
}

/**
 * Open content in a fullscreen modal
 * Generic fullscreen viewer for description, first message, etc.
 * @param {string} content - Raw content to display
 * @param {string} title - Modal title
 * @param {string} icon - FontAwesome icon class (e.g., 'fa-message')
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openContentFullscreen(content, title, icon, charName, urlMap) {
    if (!content) {
        showToast('No content to display', 'warning');
        return;
    }
    
    // Apply media localization if urlMap is provided
    let localizedContent = content;
    if (urlMap && Object.keys(urlMap).length > 0) {
        localizedContent = replaceMediaUrlsInText(content, urlMap);
    }
    
    // Format and sanitize content
    const formatted = formatRichText(localizedContent, charName);
    const sanitized = DOMPurify.sanitize(formatted, {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 
                       'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
                       'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr', 'table', 
                       'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'width', 'height'],
        ALLOW_DATA_ATTR: false
    });
    
    const modalHtml = `
        <div id="contentFullscreenModal" class="modal-overlay">
            <div class="modal-glass content-fullscreen-modal" id="contentFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid ${icon}"></i> ${escapeHtml(title)}</h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns" id="contentSizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="contentFullscreenClose">&times;</button>
                    </div>
                </div>
                <div class="content-fullscreen-body">
                    <div class="content-wrapper">${sanitized}</div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('contentFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('contentFullscreenModal');
    const modalInner = document.getElementById('contentFullscreenInner');
    
    // Size control handlers
    on('contentSizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#contentSizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('contentFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Open alternate greetings in a fullscreen modal with navigation
 * @param {Array} greetings - Array of greeting strings
 * @param {string} charName - Character name for placeholder replacement
 * @param {Object} [urlMap] - Pre-built localization map (optional)
 */
function openAltGreetingsFullscreen(greetings, charName, urlMap) {
    if (!greetings || greetings.length === 0) {
        showToast('No alternate greetings to display', 'warning');
        return;
    }
    
    // Only format the first greeting now; others lazily when navigated to
    const formatGreeting = (text) => {
        let content = (text || '').trim();
        if (urlMap && Object.keys(urlMap).length > 0) {
            content = replaceMediaUrlsInText(content, urlMap);
        }
        const formatted = formatRichText(content, charName);
        return DOMPurify.sanitize(formatted, {
            ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 
                           'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
                           'ul', 'ol', 'li', 'a', 'img', 'span', 'div', 'hr', 'table', 
                           'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'details', 'summary'],
            ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'width', 'height'],
            ALLOW_DATA_ATTR: false
        });
    };
    
    // Build navigation dots
    const navHtml = greetings.map((g, i) => 
        `<button type="button" class="greeting-nav-btn${i === 0 ? ' active' : ''}" data-index="${i}" title="Greeting #${i + 1}">${i + 1}</button>`
    ).join('');
    
    // Build greeting cards — only the first card has content, others render lazily
    const cardsHtml = greetings.map((g, i) => `
        <div class="greeting-card" data-greeting-index="${i}" style="${i !== 0 ? 'display: none;' : ''}">
            <div class="greeting-header">
                <div class="greeting-number">${i + 1}</div>
                <div class="greeting-label">Alternate Greeting</div>
            </div>
            <div class="greeting-content">${i === 0 ? formatGreeting(g) : ''}</div>
        </div>
    `).join('');
    
    const modalHtml = `
        <div id="altGreetingsFullscreenModal" class="modal-overlay">
            <div class="modal-glass content-fullscreen-modal" id="altGreetingsFullscreenInner" data-size="normal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-comments"></i> Alternate Greetings <span style="color: #888; font-weight: 400; font-size: 0.9rem;">(${greetings.length})</span></h2>
                    <div class="creator-notes-display-controls">
                        <div class="display-control-btns" id="altGreetingsSizeControlBtns">
                            <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                            <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                                <i class="fa-regular fa-window-maximize"></i>
                            </button>
                            <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                        </div>
                    </div>
                    <div class="modal-controls">
                        <button class="close-btn" id="altGreetingsFullscreenClose">&times;</button>
                    </div>
                </div>
                ${greetings.length > 1 ? `<div class="greeting-nav" id="greetingNav">${navHtml}</div>` : ''}
                <div class="content-fullscreen-body">
                    ${cardsHtml}
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('altGreetingsFullscreenModal');
    if (existingModal) existingModal.remove();
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('altGreetingsFullscreenModal');
    const modalInner = document.getElementById('altGreetingsFullscreenInner');
    
    // Navigation handlers
    const greetingNav = document.getElementById('greetingNav');
    if (greetingNav) {
        greetingNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.greeting-nav-btn[data-index]');
            if (!btn) return;
            
            const index = parseInt(btn.dataset.index);
            
            // Update nav buttons
            greetingNav.querySelectorAll('.greeting-nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Show selected greeting, hide others — lazy-render on first view
            modal.querySelectorAll('.greeting-card').forEach((card, i) => {
                if (i === index) {
                    card.style.display = '';
                    // Lazy-render if content is empty
                    const contentEl = card.querySelector('.greeting-content');
                    if (contentEl && !contentEl.innerHTML.trim()) {
                        contentEl.innerHTML = formatGreeting(greetings[i]);
                    }
                } else {
                    card.style.display = 'none';
                }
            });
        });
    }
    
    // Size control handlers
    on('altGreetingsSizeControlBtns', 'click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        
        const size = btn.dataset.size;
        document.querySelectorAll('#altGreetingsSizeControlBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalInner.dataset.size = size;
    });
    
    // Close handlers
    const closeModal = () => {
        modal.remove();
        document.removeEventListener('keydown', handleKeydown);
    };
    
    const handleKeydown = (e) => {
        if (e.key === 'Escape') closeModal();
    };
    
    document.getElementById('altGreetingsFullscreenClose').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    document.addEventListener('keydown', handleKeydown);
}

/**
 * Initialize content expand button handlers
 * Call this after modal content is loaded
 */
function initContentExpandHandlers() {
    const charName = document.getElementById('modalCharName')?.textContent || 'Character';
    
    // First Message expand - clickable title
    // Use stored handler references to prevent listener accumulation across modal opens
    const firstMesTitleExpand = document.getElementById('firstMesTitleExpand');
    if (firstMesTitleExpand) {
        if (firstMesTitleExpand._expandHandler) {
            firstMesTitleExpand.removeEventListener('click', firstMesTitleExpand._expandHandler);
        }
        firstMesTitleExpand._expandHandler = async () => {
            const content = window.currentFirstMesContent;
            if (!content) {
                showToast('No first message to display', 'warning');
                return;
            }
            
            let urlMap = null;
            if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                const folderName = getGalleryFolderName(activeChar);
                urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
            }
            openContentFullscreen(content, 'First Message', 'fa-message', charName, urlMap);
        };
        firstMesTitleExpand.addEventListener('click', firstMesTitleExpand._expandHandler);
    }
    
    // Alt Greetings expand button
    const altGreetingsExpandBtn = document.getElementById('altGreetingsExpandBtn');
    if (altGreetingsExpandBtn) {
        if (altGreetingsExpandBtn._expandHandler) {
            altGreetingsExpandBtn.removeEventListener('click', altGreetingsExpandBtn._expandHandler);
        }
        altGreetingsExpandBtn._expandHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent toggling the details
            
            const greetings = window.currentAltGreetingsContent;
            if (!greetings || greetings.length === 0) {
                showToast('No alternate greetings to display', 'warning');
                return;
            }
            
            let urlMap = null;
            if (activeChar && activeChar.avatar && isMediaLocalizationEnabled(activeChar.avatar)) {
                const folderName = getGalleryFolderName(activeChar);
                urlMap = await buildMediaLocalizationMap(folderName, activeChar.avatar);
            }
            openAltGreetingsFullscreen(greetings, charName, urlMap);
        };
        altGreetingsExpandBtn.addEventListener('click', altGreetingsExpandBtn._expandHandler);
    }
}

async function initChubView() {
    // Ensure settings are loaded before reading token/state.
    await loadGallerySettings();
    // Sync dropdown values with JS state (browser may cache old form values)
    const discoveryPresetEl = document.getElementById('chubDiscoveryPreset');
    const timelineSortEl = document.getElementById('chubTimelineSortHeader');
    const authorSortEl = document.getElementById('chubAuthorSortSelect');
    
    if (discoveryPresetEl) discoveryPresetEl.value = chubDiscoveryPreset;
    if (timelineSortEl) timelineSortEl.value = chubTimelineSort;
    if (authorSortEl) authorSortEl.value = chubAuthorSort;
    
    // Also sync NSFW toggle state
    updateNsfwToggleState();

    setupChubGridDelegates();
    
    // Favorite button in character modal
    on('chubCharFavoriteBtn', 'click', toggleChubCharFavorite);
    
    // View mode toggle (Browse/Timeline)
    document.querySelectorAll('.chub-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.chubView;
            if (newMode === chubViewMode) return;
            
            // Timeline requires token
            if (newMode === 'timeline' && !chubToken) {
                showToast('URQL token required for Timeline. Click the key icon to add your ChubAI token.', 'warning');
                openChubTokenModal();
                return;
            }
            
            switchChubViewMode(newMode);
        });
    });
    
    // Author filter clear button
    on('chubClearAuthorBtn', 'click', () => {
        clearAuthorFilter();
    });
    
    // Follow author button
    on('chubFollowAuthorBtn', 'click', () => {
        toggleFollowAuthor();
    });
    
    // Timeline load more button (uses cursor-based pagination)
    on('chubTimelineLoadMoreBtn', 'click', () => {
        if (chubTimelineCursor) {
            chubTimelinePage++;
            loadChubTimeline(false);
        }
    });
    
    // Search handlers
    on('chubSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubSearch();
        }
    });
    
    // Show/hide clear button based on input content
    on('chubSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('chubClearSearchBtn');
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !e.target.value.trim());
        }
    });
    
    on('chubSearchBtn', 'click', () => performChubSearch());
    
    // Clear search button
    on('chubClearSearchBtn', 'click', () => {
        const input = document.getElementById('chubSearchInput');
        if (input) {
            input.value = '';
            input.focus();
        }
        // Hide the clear button
        document.getElementById('chubClearSearchBtn')?.classList.add('hidden');
        // Perform search (will show default results)
        performChubSearch();
    });
    
    // Creator search handlers
    on('chubCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubCreatorSearch();
        }
    });
    
    on('chubCreatorSearchBtn', 'click', () => performChubCreatorSearch());
    
    // Discovery preset select (combined sort + time)
    on('chubDiscoveryPreset', 'change', (e) => {
        chubDiscoveryPreset = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    });
    
    // More filters dropdown toggle
    on('chubFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        // Close Tags dropdown when opening Features
        document.getElementById('chubTagsDropdown')?.classList.add('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.toggle('hidden');
    });
    
    // Close filters dropdown when clicking elsewhere
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('chubFiltersDropdown');
        const btn = document.getElementById('chubFiltersBtn');
        if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
            dropdown.classList.add('hidden');
        }
    });
    
    // Filter checkboxes - with getter for syncing
    const filterCheckboxes = [
        { id: 'chubFilterImages', setter: (v) => chubFilterImages = v, getter: () => chubFilterImages },
        { id: 'chubFilterLore', setter: (v) => chubFilterLore = v, getter: () => chubFilterLore },
        { id: 'chubFilterExpressions', setter: (v) => chubFilterExpressions = v, getter: () => chubFilterExpressions },
        { id: 'chubFilterGreetings', setter: (v) => chubFilterGreetings = v, getter: () => chubFilterGreetings },
        { id: 'chubFilterFavorites', setter: (v) => chubFilterFavorites = v, getter: () => chubFilterFavorites },
        { id: 'chubFilterHideOwned', setter: (v) => chubFilterHideOwned = v, getter: () => chubFilterHideOwned }
    ];
    
    // Sync checkbox states with JS variables (browser may cache old form values)
    filterCheckboxes.forEach(({ id, getter }) => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = getter();
    });
    updateChubFiltersButtonState();
    
    filterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', async (e) => {
            // Special handling for favorites - requires token
            if (id === 'chubFilterFavorites' && e.target.checked && !chubToken) {
                e.target.checked = false;
                showToast('URQL token required for favorites. Click the key icon to add your ChubAI token.', 'warning');
                show('chubLoginModal');
                return;
            }
            setter(e.target.checked);
            debugLog(`Filter ${id} set to:`, e.target.checked);
            updateChubFiltersButtonState();
            
            // For timeline mode with favorites filter, fetch favorite IDs first
            if (chubViewMode === 'timeline') {
                if (id === 'chubFilterFavorites' && e.target.checked) {
                    // Fetch favorite IDs for filtering
                    await fetchChubUserFavoriteIds();
                }
                renderChubTimeline();
            } else {
                // For browse mode, always reload from API when changing filters
                // This ensures we get fresh data and don't mix old results
                chubCharacters = [];
                chubCurrentPage = 1;
                loadChubCharacters();
            }
        });
    });
    
    // === Tags Dropdown Handlers ===
    initChubTagsDropdown();
    
    // NSFW toggle - single button toggle
    on('chubNsfwToggle', 'click', () => {
        chubNsfwEnabled = !chubNsfwEnabled;
        updateNsfwToggleState();
        
        // Refresh the appropriate view based on current mode
        if (chubViewMode === 'timeline') {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
            loadChubTimeline(true);
        } else {
            chubCharacters = [];
            chubCurrentPage = 1;
            loadChubCharacters();
        }
    });
    
    // Refresh button - works for both Browse and Timeline modes
    on('refreshChubBtn', 'click', () => {
        if (chubViewMode === 'timeline') {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
            loadChubTimeline(true);
        } else {
            chubCharacters = [];
            chubCurrentPage = 1;
            loadChubCharacters(true);
        }
    });
    
    // Load more button
    on('chubLoadMoreBtn', 'click', () => {
        chubCurrentPage++;
        loadChubCharacters();
    });
    
    // Timeline sort dropdown (header only)
    on('chubTimelineSortHeader', 'change', (e) => {
        chubTimelineSort = e.target.value;
        debugLog('[ChubTimeline] Sort changed to:', chubTimelineSort);
        renderChubTimeline();
    });
    
    // Author sort dropdown
    on('chubAuthorSortSelect', 'change', (e) => {
        chubAuthorSort = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters(); // Reload with new sort (server-side sorting)
    });
    
    // Character modal handlers
    on('chubCharClose', 'click', () => {
        abortChubDetailFetch();
        cleanupChubCharModal();
        hideModal('chubCharModal');
    });
    
    on('chubDownloadBtn', 'click', () => downloadChubCharacter());
    
    on('chubCharModal', 'click', (e) => {
        if (e.target.id === 'chubCharModal') {
            abortChubDetailFetch();
            cleanupChubCharModal();
            hideModal('chubCharModal');
        }
    });
    
    // API Key modal handlers
    on('chubLoginBtn', 'click', () => openChubTokenModal());
    on('chubLoginClose', 'click', () => hideModal('chubLoginModal'));
    on('chubLoginModal', 'click', (e) => {
        if (e.target.id === 'chubLoginModal') {
            hideModal('chubLoginModal');
        }
    });
    
    // Token save/clear buttons
    on('chubSaveKeyBtn', 'click', saveChubToken);
    on('chubClearKeyBtn', 'click', clearChubToken);
    
    // Load saved token on init
    loadChubToken();
    
    // Initialize NSFW toggle state (defaults to enabled)
    updateNsfwToggleState();
    
    debugLog('ChubAI view initialized');
}

// ============================================================================
// CHUB TOKEN MANAGEMENT (URQL_TOKEN)
// Uses the gallery settings system for persistent storage
// ============================================================================

function loadChubToken() {
    // Gallery settings are already loaded by DOMContentLoaded init
    
    // Get token from settings (server-side persistent)
    const savedToken = getSetting('chubToken');
    if (savedToken) {
        chubToken = savedToken;
        debugLog('[ChubToken] Loaded from gallery settings');
        
        // Populate input field if it exists
        const tokenInput = document.getElementById('chubApiKeyInput');
        if (tokenInput) tokenInput.value = savedToken;
        
        const rememberCheckbox = document.getElementById('chubRememberKey');
        if (rememberCheckbox) rememberCheckbox.checked = true;
        
        return;
    }
    
    // Migration: Check old localStorage key and migrate to new system
    try {
        const oldToken = localStorage.getItem(CHUB_TOKEN_KEY);
        if (oldToken) {
            debugLog('[ChubToken] Migrating from localStorage to settings system');
            chubToken = oldToken;
            setSetting('chubToken', oldToken);
            setSetting('chubRememberToken', true);
            // Remove old key after migration
            localStorage.removeItem(CHUB_TOKEN_KEY);
        }
    } catch (e) {
        console.warn('[ChubToken] Migration check failed:', e);
    }
}

function saveChubToken() {
    const tokenInput = document.getElementById('chubApiKeyInput');
    const rememberCheckbox = document.getElementById('chubRememberKey');
    
    if (!tokenInput) return;
    
    const token = tokenInput.value.trim();
    if (!token) {
        alert('Please enter your URQL token');
        return;
    }
    
    chubToken = token;
    
    // Always save to persistent settings (server-side via ST extensionSettings)
    setSettings({
        chubToken: token,
        chubRememberToken: rememberCheckbox?.checked ?? true
    });
    debugLog('[ChubToken] Saved to gallery settings (persistent)');
    
    // Close modal
    const modal = document.getElementById('chubLoginModal');
    if (modal) modal.classList.add('hidden');
    
    // Show success feedback
    showToast('Token saved! Your token is now stored persistently.', 'success');
    
    // Refresh if we have filters that need the token
    if (chubFilterFavorites) {
        loadChubCharacters();
    }
}

function clearChubToken() {
    chubToken = null;
    
    // Clear from persistent settings
    setSettings({
        chubToken: null,
        chubRememberToken: false
    });
    debugLog('[ChubToken] Cleared from gallery settings');
    
    // Also clear old localStorage key if it exists
    try {
        localStorage.removeItem(CHUB_TOKEN_KEY);
    } catch (e) {
        // Ignore
    }
    
    // Clear input
    const tokenInput = document.getElementById('chubApiKeyInput');
    if (tokenInput) tokenInput.value = '';
    
    const rememberCheckbox = document.getElementById('chubRememberKey');
    if (rememberCheckbox) rememberCheckbox.checked = false;
    
    // Reset favorites filter if active
    if (chubFilterFavorites) {
        chubFilterFavorites = false;
        const favCheckbox = document.getElementById('chubFilterFavorites');
        if (favCheckbox) favCheckbox.checked = false;
        updateChubFiltersButtonState();
    }
    
    showToast('Token cleared', 'info');
}

function openChubTokenModal() {
    const modal = document.getElementById('chubLoginModal');
    if (!modal) return;
    
    // Pre-fill input if token exists
    const tokenInput = document.getElementById('chubApiKeyInput');
    const clearBtn = document.getElementById('chubClearKeyBtn');
    
    if (tokenInput && chubToken) {
        tokenInput.value = chubToken;
    }
    
    // Show/hide clear button based on whether token exists
    if (clearBtn) {
        clearBtn.style.display = chubToken ? '' : 'none';
    }
    
    // Use classList.remove('hidden') to match how the modal is closed
    modal.classList.remove('hidden');
    
    // Fetch popular tags from ChubAI if not already loaded
    if (!chubTagsLoaded && !chubTagsLoading) {
        fetchChubPopularTags();
    }
}

/**
 * Fetch popular tags from ChubAI API by aggregating tags from top characters
 * Uses multiple requests to get a diverse set of tags from different character rankings
 */
async function fetchChubPopularTags() {
    if (chubTagsLoading || chubTagsLoaded) return;
    
    chubTagsLoading = true;
    
    try {
        const headers = getChubHeaders(true);
        const tagCounts = new Map();
        
        // Fetch from multiple sort orders to get diverse tags
        const sortOrders = ['download_count', 'id', 'rating', 'default'];
        
        for (const sortOrder of sortOrders) {
            try {
                const params = new URLSearchParams({
                    search: '',
                    first: '500',
                    sort: sortOrder,
                    nsfw: 'true',
                    nsfl: 'true',
                    include_forks: 'false',
                    min_tokens: '50'
                });
                
                const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                    method: 'GET',
                    headers
                });
                
                if (!response.ok) continue;
                
                const data = await response.json();
                const characters = extractNodes(data);
                
                // Aggregate tags from these characters
                for (const char of characters) {
                    const topics = char.topics || [];
                    for (const tag of topics) {
                        const normalizedTag = tag.toLowerCase().trim();
                        if (normalizedTag && normalizedTag.length > 1 && normalizedTag.length < 40) {
                            tagCounts.set(normalizedTag, (tagCounts.get(normalizedTag) || 0) + 1);
                        }
                    }
                }
                
                debugLog(`[ChubTags] Fetched tags from ${characters.length} characters (sort: ${sortOrder})`);
                
                // Small delay between requests
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.warn(`[ChubTags] Failed to fetch with sort ${sortOrder}:`, err);
            }
        }
        
        // Sort by frequency and take top 500 tags
        const sortedTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 500)
            .map(([tag]) => tag);
        
        if (sortedTags.length > 0) {
            chubPopularTags = sortedTags;
            chubTagsLoaded = true;
        }
        
        debugLog(`[ChubTags] Loaded ${chubPopularTags.length} unique tags total`);
        
    } catch (error) {
        console.error('[ChubTags] Error fetching popular tags:', error);
    } finally {
        chubTagsLoading = false;
    }
}

/**
 * Extract popular tags from ChubAI search results
 * Supplements existing tags if not fully loaded yet
 */
function extractChubTagsFromResults(characters) {
    // If we already have 250+ tags loaded from API, don't update
    if (chubTagsLoaded && chubPopularTags.length >= 250) return;
    
    const tagCounts = new Map();
    
    // Start with existing tag counts
    for (const tag of chubPopularTags) {
        tagCounts.set(tag, 10); // Give existing tags a baseline
    }
    
    for (const char of characters) {
        const topics = char.topics || [];
        for (const tag of topics) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag && normalizedTag.length > 1 && normalizedTag.length < 30) {
                tagCounts.set(normalizedTag, (tagCounts.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    // Sort by frequency and take top 300 tags
    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300)
        .map(([tag]) => tag);
    
    if (sortedTags.length > chubPopularTags.length) {
        chubPopularTags = sortedTags;
    }
}

function updateChubFiltersButtonState() {
    const btn = document.getElementById('chubFiltersBtn');
    if (!btn) return;
    
    const hasActiveFilters = chubFilterImages || chubFilterLore || 
                             chubFilterExpressions || chubFilterGreetings || 
                             chubFilterFavorites || chubFilterHideOwned;
    
    btn.classList.toggle('has-filters', hasActiveFilters);
    
    // Update button text to show active filter count
    const count = [chubFilterImages, chubFilterLore, chubFilterExpressions, 
                   chubFilterGreetings, chubFilterFavorites, chubFilterHideOwned].filter(Boolean).length;
    
    if (count > 0) {
        btn.innerHTML = `<i class="fa-solid fa-sliders"></i> Features (${count})`;
    } else {
        btn.innerHTML = `<i class="fa-solid fa-sliders"></i> Features`;
    }
}

function updateNsfwToggleState() {
    const btn = document.getElementById('chubNsfwToggle');
    if (!btn) return;
    
    if (chubNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ============================================================================
// CHUBAI TAGS DROPDOWN (Tri-state tag filters + advanced options)
// ============================================================================

/**
 * Initialize the Tags dropdown with event handlers
 */
function initChubTagsDropdown() {
    const btn = document.getElementById('chubTagsBtn');
    const dropdown = document.getElementById('chubTagsDropdown');
    const searchInput = document.getElementById('chubTagsSearchInput');
    const clearBtn = document.getElementById('chubTagsClearBtn');
    
    if (!btn || !dropdown) return;
    
    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = dropdown.classList.contains('hidden');
        // Close Features dropdown when opening Tags
        document.getElementById('chubFiltersDropdown')?.classList.add('hidden');
        dropdown.classList.toggle('hidden');
        
        // Populate tags when opening
        if (wasHidden) {
            renderChubTagsDropdownList();
            searchInput?.focus();
        }
    });
    
    // Close when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
    
    // Prevent dropdown from closing when clicking inside
    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // Tag search filtering
    searchInput?.addEventListener('input', debounce(() => {
        renderChubTagsDropdownList(searchInput.value);
    }, 150));
    
    // Clear all tag filters
    clearBtn?.addEventListener('click', () => {
        chubTagFilters.clear();
        // Also clear the search input
        if (searchInput) searchInput.value = '';
        renderChubTagsDropdownList('');
        updateChubTagsButtonState();
        triggerChubReload();
    });
    
    // Advanced options handlers
    const sortDir = document.getElementById('chubSortDirection');
    const minTokens = document.getElementById('chubMinTokens');
    const maxTokens = document.getElementById('chubMaxTokens');
    
    sortDir?.addEventListener('change', (e) => {
        chubSortAscending = e.target.value === 'asc';
        triggerChubReload();
    });
    
    minTokens?.addEventListener('change', (e) => {
        chubMinTokens = parseInt(e.target.value) || 50;
        triggerChubReload();
    });
    
    maxTokens?.addEventListener('change', (e) => {
        chubMaxTokens = parseInt(e.target.value) || 100000;
        triggerChubReload();
    });
}

/**
 * Trigger a reload of ChubAI characters
 */
function triggerChubReload() {
    if (chubViewMode === 'timeline') {
        renderChubTimeline();
    } else {
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    }
}

// Debounce timeout for tag filter changes
let chubTagFilterDebounceTimeout = null;

/**
 * Debounced version of triggerChubReload for tag filtering
 * Waits 500ms after the last change before reloading
 */
function triggerChubReloadDebounced() {
    if (chubTagFilterDebounceTimeout) {
        clearTimeout(chubTagFilterDebounceTimeout);
    }
    chubTagFilterDebounceTimeout = setTimeout(() => {
        chubTagFilterDebounceTimeout = null;
        triggerChubReload();
    }, 500);
}

/**
 * Render the tag list in the dropdown with tri-state buttons
 */
function renderChubTagsDropdownList(filter = '') {
    const container = document.getElementById('chubTagsList');
    if (!container) return;
    
    // Show loading if tags not loaded
    if (chubTagsLoading) {
        container.innerHTML = '<div class="chub-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }
    
    // Try to load tags if not available
    if (chubPopularTags.length === 0) {
        if (!chubTagsLoaded) {
            fetchChubPopularTags().then(() => renderChubTagsDropdownList(filter));
        } else {
            container.innerHTML = '<div class="chub-tags-empty">No tags available</div>';
        }
        return;
    }
    
    // Filter tags
    const filterLower = filter.toLowerCase();
    const filteredTags = filter 
        ? chubPopularTags.filter(tag => tag.toLowerCase().includes(filterLower))
        : chubPopularTags;
    
    if (filteredTags.length === 0) {
        container.innerHTML = '<div class="chub-tags-empty">No matching tags</div>';
        return;
    }
    
    // Sort: active filters first, then alphabetically
    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = chubTagFilters.get(a);
        const bState = chubTagFilters.get(b);
        // Active filters (include/exclude) come first
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        // Then sort alphabetically
        return a.localeCompare(b);
    });
    
    container.innerHTML = sortedTags.map(tag => {
        const state = chubTagFilters.get(tag) || 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>' 
                        : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>' 
                        : '';
        const stateTitle = state === 'include' ? 'Included - click to exclude'
                        : state === 'exclude' ? 'Excluded - click to clear'
                        : 'Neutral - click to include';
        
        return `
            <div class="chub-tag-filter-item" data-tag="${escapeHtml(tag)}">
                <button class="chub-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag)}</span>
            </div>
        `;
    }).join('');
    
    // Attach click handlers
    container.querySelectorAll('.chub-tag-filter-item').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.chub-tag-state-btn');
        const label = item.querySelector('.tag-label');
        
        const cycleState = () => {
            const current = chubTagFilters.get(tag) || 'neutral';
            let newState;
            
            // Cycle: neutral -> include -> exclude -> neutral
            if (current === 'neutral') {
                newState = 'include';
                chubTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                newState = 'exclude';
                chubTagFilters.set(tag, 'exclude');
            } else {
                newState = 'neutral';
                chubTagFilters.delete(tag);
            }
            
            // Update button appearance
            updateChubTagStateButton(stateBtn, newState);
            updateChubTagsButtonState();
            triggerChubReloadDebounced();
        };
        
        stateBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleState();
        });
        
        label?.addEventListener('click', cycleState);
    });
}

/**
 * Update a single tag state button's appearance
 */
function updateChubTagStateButton(btn, state) {
    if (!btn) return;
    
    btn.className = 'chub-tag-state-btn';
    if (state === 'include') {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.title = 'Included - click to exclude';
    } else if (state === 'exclude') {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded - click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Neutral - click to include';
    }
}

/**
 * Update the Tags button to show active filter count
 */
function updateChubTagsButtonState() {
    const btn = document.getElementById('chubTagsBtn');
    const label = document.getElementById('chubTagsBtnLabel');
    if (!btn || !label) return;
    
    const includeCount = Array.from(chubTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(chubTagFilters.values()).filter(v => v === 'exclude').length;
    
    // Check if any advanced options are non-default
    const hasAdvanced = chubSortAscending || chubMinTokens !== 50 || chubMaxTokens !== 100000;
    
    // Build label
    let text = 'Tags';
    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);
    if (parts.length > 0) {
        text += ` (${parts.join('/')})`;
    }
    
    label.textContent = text;
    
    // Visual indicator for active filters
    const hasFilters = includeCount > 0 || excludeCount > 0 || hasAdvanced;
    btn.classList.toggle('has-filters', hasFilters);
}

// ============================================================================
// CHUBAI VIEW MODE SWITCHING (Browse/Timeline)
// ============================================================================

async function switchChubViewMode(mode) {
    chubViewMode = mode;
    
    // Update toggle buttons
    document.querySelectorAll('.chub-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.chubView === mode);
    });
    
    // Show/hide sections
    const browseSection = document.getElementById('chubBrowseSection');
    const timelineSection = document.getElementById('chubTimelineSection');
    
    if (mode === 'browse') {
        browseSection?.classList.remove('hidden');
        timelineSection?.classList.add('hidden');
        
        // Show browse-specific filters, hide timeline sort
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        const timelineSortHeader = document.getElementById('chubTimelineSortHeader');
        const tagsDropdownContainer = document.querySelector('.chub-tags-dropdown-container');
        if (discoveryPreset) discoveryPreset.classList.remove('chub-filter-hidden');
        if (timelineSortHeader) timelineSortHeader.classList.add('chub-filter-hidden');
        if (tagsDropdownContainer) tagsDropdownContainer.classList.remove('chub-filter-hidden');
        
        // Clear the browse grid immediately and show loading state
        const grid = document.getElementById('chubGrid');
        if (grid) {
            renderLoadingState(grid, 'Loading ChubAI characters...', 'chub-loading');
        }
        
        // Always reload browse data when switching to it to avoid stale/mixed data
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    } else if (mode === 'timeline') {
        browseSection?.classList.add('hidden');
        timelineSection?.classList.remove('hidden');
        
        // Hide browse-specific filters, show timeline sort in header
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        const timelineSortHeader = document.getElementById('chubTimelineSortHeader');
        const tagsDropdownContainer = document.querySelector('.chub-tags-dropdown-container');
        if (discoveryPreset) discoveryPreset.classList.add('chub-filter-hidden');
        if (timelineSortHeader) timelineSortHeader.classList.remove('chub-filter-hidden');
        if (tagsDropdownContainer) tagsDropdownContainer.classList.add('chub-filter-hidden');
        
        // If favorites filter is enabled, fetch the favorite IDs first
        if (chubFilterFavorites && chubToken) {
            await fetchChubUserFavoriteIds();
        }
        
        // Load timeline if not loaded, otherwise just re-render with current filters
        if (chubTimelineCharacters.length === 0) {
            loadChubTimeline();
        } else {
            // Re-render to apply any active filters (like favorites)
            renderChubTimeline();
        }
    }
}

// ============================================================================
// CHUBAI TIMELINE (New from followed authors)
// ============================================================================

async function loadChubTimeline(forceRefresh = false) {
    if (!chubToken) {
        renderTimelineEmpty('login');
        return;
    }
    
    const grid = document.getElementById('chubTimelineGrid');
    const loadMoreContainer = document.getElementById('chubTimelineLoadMore');
    
    if (forceRefresh || (!chubTimelineCursor && chubTimelineCharacters.length === 0)) {
        renderLoadingState(grid, 'Loading timeline...', 'chub-loading');
        if (forceRefresh) {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
        }
    }
    
    try {
        // Use the dedicated timeline endpoint which returns updates from followed authors
        // This API uses cursor-based pagination, not page-based
        const params = new URLSearchParams();
        params.set('first', '50'); // Request more items per page
        params.set('nsfw', chubNsfwEnabled.toString());
        params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
        params.set('count', 'true'); // Request total count for better pagination info
        
        // Use cursor for pagination if we have one (for loading more)
        if (chubTimelineCursor) {
            params.set('cursor', chubTimelineCursor);
            debugLog('[ChubTimeline] Loading next page with cursor');
        }
        
        const headers = getChubHeaders(true);
        
        debugLog('[ChubTimeline] Loading timeline, nsfw:', chubNsfwEnabled);
        
        const response = await fetch(`${CHUB_API_BASE}/api/timeline/v1?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubTimeline] Error response:', response.status, errorText);
            
            if (response.status === 401) {
                renderTimelineEmpty('login');
                return;
            }
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Extract response data (may be nested under 'data')
        const responseData = data.data || data;
        
        // Extract total count if available
        const totalCount = responseData.count ?? null;
        
        // Extract cursor for next page
        const nextCursor = responseData.cursor || null;
        
        // Extract nodes from response
        let nodes = [];
        if (responseData.nodes) {
            nodes = responseData.nodes;
        } else if (Array.isArray(responseData)) {
            nodes = responseData;
        }
        
        debugLog('[ChubTimeline] Got', nodes.length, 'items from API');
        
        // Filter to only include characters (not lorebooks, posts, etc.)
        // Timeline API returns paths without "characters/" prefix, so check for:
        // - Has a fullPath with username/slug format (not lorebooks/ or posts/)
        // - OR has character-specific fields like tagline, topics, etc.
        const characterNodes = nodes.filter(node => {
            const fullPath = node.fullPath || node.full_path || '';
            
            // Skip if explicitly a lorebook or post
            if (fullPath.startsWith('lorebooks/') || fullPath.startsWith('posts/')) {
                return false;
            }
            
            // If it has entries array, it's a lorebook
            if (node.entries && Array.isArray(node.entries)) {
                return false;
            }
            
            // Check for character-specific properties that indicate this is a character
            // Characters have: tagline, first_mes/definition, topics, etc.
            const hasCharacterProperties = node.tagline !== undefined || 
                                          node.definition !== undefined ||
                                          node.first_mes !== undefined ||
                                          node.topics !== undefined ||
                                          (node.labels && Array.isArray(node.labels));
            
            // If fullPath has format "characters/user/slug" or "user/slug" it's likely a character
            // Also accept if it has character-like properties
            const hasCharPath = fullPath.startsWith('characters/') || 
                               (fullPath.includes('/') && !fullPath.startsWith('lorebooks/') && !fullPath.startsWith('posts/'));
            
            const isCharacter = hasCharPath || hasCharacterProperties;
            
            return isCharacter;
        });
        
        // Add new characters (dedupe by fullPath)
        if (chubTimelineCharacters.length === 0) {
            chubTimelineCharacters = characterNodes;
        } else {
            const existingPaths = new Set(chubTimelineCharacters.map(c => c.fullPath || c.full_path));
            // Push new items instead of spread-copying the entire array
            for (const c of characterNodes) {
                const fp = c.fullPath || c.full_path;
                if (!existingPaths.has(fp)) {
                    chubTimelineCharacters.push(c);
                    existingPaths.add(fp);
                }
            }
        }
        
        debugLog('[ChubTimeline] Total characters:', chubTimelineCharacters.length);
        
        // Update cursor for next page
        chubTimelineCursor = nextCursor;
        
        // Determine if there's more data available
        const gotItems = nodes.length > 0;
        chubTimelineHasMore = gotItems && nextCursor;
        
        // Check how recent the oldest item in this batch is
        let oldestInBatch = null;
        if (nodes.length > 0) {
            const lastNode = nodes[nodes.length - 1];
            oldestInBatch = lastNode.createdAt || lastNode.created_at;
        }
        
        // Auto-load more pages to get recent content
        // Keep loading if we have a cursor and:
        // 1. We filtered out all items (lorebooks etc)
        // 2. Or we want more characters (up to 96 for good coverage)
        // 3. The oldest item is still recent (less than 14 days old)
        let shouldAutoLoad = false;
        if (nextCursor) {
            if (characterNodes.length === 0) {
                shouldAutoLoad = true; // All filtered out
            } else if (chubTimelineCharacters.length < 96) {
                // Check age of oldest item - keep loading if less than 14 days old
                if (oldestInBatch) {
                    const oldestDate = new Date(oldestInBatch);
                    const daysSinceOldest = (Date.now() - oldestDate.getTime()) / (1000 * 60 * 60 * 24);
                    shouldAutoLoad = daysSinceOldest < 14;
                } else {
                    shouldAutoLoad = true;
                }
            }
        }
        
        // Limit auto-loading to prevent infinite loops (max 8 pages)
        if (shouldAutoLoad && chubTimelinePage < 8) {
            debugLog('[ChubTimeline] Auto-loading next page... (have', chubTimelineCharacters.length, 'chars so far)');
            chubTimelinePage++;
            await loadChubTimeline(false);
            return;
        }
        
        // Timeline API is unreliable - supplement with direct author fetches
        // Only do this on first load (no cursor yet used)
        if (!chubTimelineCursor && chubTimelinePage === 1) {
            debugLog('[ChubTimeline] Supplementing with direct author fetches...');
            await supplementTimelineWithAuthorFetches();
        }
        
        if (chubTimelineCharacters.length === 0) {
            renderTimelineEmpty('empty');
        } else {
            renderChubTimeline();
        }
        
        // Show/hide load more button
        if (loadMoreContainer) {
            loadMoreContainer.style.display = chubTimelineHasMore ? 'flex' : 'none';
        }
        
    } catch (e) {
        console.error('[ChubTimeline] Load error:', e);
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Failed to Load Timeline</h3>
                <p>${escapeHtml(e.message)}</p>
                <button class="action-btn primary" onclick="loadChubTimeline(true)">
                    <i class="fa-solid fa-refresh"></i> Retry
                </button>
            </div>
        `;
    }
}

/**
 * Supplement timeline with direct fetches from followed authors
 * This works around the broken timeline API that doesn't return all items
 */
async function supplementTimelineWithAuthorFetches() {
    try {
        // Get list of followed authors
        const followedAuthors = await fetchMyFollowsList();
        if (!followedAuthors || followedAuthors.size === 0) {
            debugLog('[ChubTimeline] No followed authors to fetch from');
            return;
        }
        
        debugLog('[ChubTimeline] Fetching recent chars from', followedAuthors.size, 'followed authors');
        
        // Get existing paths to avoid duplicates
        const existingPaths = new Set(chubTimelineCharacters.map(c => 
            (c.fullPath || c.full_path || '').toLowerCase()
        ));
        
        // Fetch recent characters from each author (limit to first 10 authors to avoid rate limits)
        const authorsToFetch = [...followedAuthors].slice(0, 15);
        
        // Fetch in parallel with small batches
        const batchSize = 5;
        for (let i = 0; i < authorsToFetch.length; i += batchSize) {
            const batch = authorsToFetch.slice(i, i + batchSize);
            
            const promises = batch.map(async (author) => {
                try {
                    const params = new URLSearchParams();
                    params.set('username', author);
                    params.set('first', '12'); // Get 12 most recent from each author
                    params.set('sort', 'id'); // Use 'id' for most recent (higher id = newer)
                    params.set('nsfw', chubNsfwEnabled.toString());
                    params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
                    params.set('include_forks', 'true'); // Include forked characters
                    
                    const url = `${CHUB_API_BASE}/search?${params.toString()}`;
                    
                    const response = await fetch(url, {
                        headers: getChubHeaders(true)
                    });
                    
                    if (!response.ok) {
                        debugLog(`[ChubTimeline] Error from ${author}: ${response.status}`);
                        return [];
                    }
                    
                    const data = await response.json();
                    const nodes = data.nodes || data.data?.nodes || [];
                    return nodes;
                } catch (e) {
                    debugLog(`[ChubTimeline] Error fetching from ${author}:`, e.message);
                    return [];
                }
            });
            
            const results = await Promise.all(promises);
            
            // Merge results, avoiding duplicates
            for (const authorChars of results) {
                for (const char of authorChars) {
                    const path = (char.fullPath || char.full_path || '').toLowerCase();
                    if (path && !existingPaths.has(path)) {
                        existingPaths.add(path);
                        chubTimelineCharacters.push(char);
                    }
                }
            }
        }
        
        debugLog('[ChubTimeline] After supplement, have', chubTimelineCharacters.length, 'total characters');
        
    } catch (e) {
        console.error('[ChubTimeline] Error supplementing timeline:', e);
    }
}

function renderTimelineEmpty(reason) {
    const grid = document.getElementById('chubTimelineGrid');
    
    if (reason === 'login') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Token Required</h3>
                <p>Add your ChubAI URQL token to see new characters from authors you follow.</p>
                <button class="action-btn primary" onclick="openChubTokenModal()">
                    <i class="fa-solid fa-key"></i> Add Token
                </button>
            </div>
        `;
    } else if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Authors</h3>
                <p>Follow some character creators on ChubAI to see their new characters here!</p>
                <a href="https://chub.ai" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Find Authors on ChubAI
                </a>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No New Characters</h3>
                <p>Authors you follow haven't posted new characters recently.</p>
                <a href="https://chub.ai" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Browse ChubAI
                </a>
            </div>
        `;
    }
}

/**
 * Sort timeline characters based on the current sort option (client-side)
 */
function sortTimelineCharacters(characters) {
    switch (chubTimelineSort) {
        case 'newest':
            // Sort by created_at or id descending (newest first)
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'updated':
            // Sort by last_activity_at or updated_at descending (recently updated first)
            return characters.sort((a, b) => {
                const dateA = a.lastActivityAt || a.last_activity_at || a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0;
                const dateB = b.lastActivityAt || b.last_activity_at || b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'oldest':
            // Sort by created_at or id ascending (oldest first)
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateA) - new Date(dateB);
                }
                return dateA - dateB;
            });
        case 'name_asc':
            // Sort by name A-Z
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });
        case 'name_desc':
            // Sort by name Z-A
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameB.localeCompare(nameA);
            });
        case 'downloads':
            // Sort by download count descending
            // ChubAI's weird naming: starCount is actually downloads
            return characters.sort((a, b) => {
                const dlA = a.starCount || 0;
                const dlB = b.starCount || 0;
                return dlB - dlA;
            });
        case 'rating':
            // Sort by rating descending (1-5 star rating)
            return characters.sort((a, b) => {
                const ratingA = a.rating || 0;
                const ratingB = b.rating || 0;
                return ratingB - ratingA;
            });
        case 'favorites':
            // Sort by favorites count descending (the heart/favorite count)
            return characters.sort((a, b) => {
                const favA = a.n_favorites || a.nFavorites || 0;
                const favB = b.n_favorites || b.nFavorites || 0;
                return favB - favA;
            });
        default:
            return characters;
    }
}

function renderChubTimeline() {
    const grid = document.getElementById('chubTimelineGrid');
    
    // Apply client-side filtering (use slice instead of spread to avoid deopt on large arrays)
    let filteredCharacters = chubTimelineCharacters.slice();
    
    // Feature filters (client-side for timeline)
    if (chubFilterImages) {
        filteredCharacters = filteredCharacters.filter(c => c.hasGallery || c.has_gallery);
    }
    if (chubFilterLore) {
        filteredCharacters = filteredCharacters.filter(c => c.has_lore || c.related_lorebooks?.length > 0);
    }
    if (chubFilterExpressions) {
        filteredCharacters = filteredCharacters.filter(c => c.has_expression_pack);
    }
    if (chubFilterGreetings) {
        filteredCharacters = filteredCharacters.filter(c => c.alternate_greetings?.length > 0 || c.n_greetings > 1);
    }
    if (chubFilterHideOwned) {
        filteredCharacters = filteredCharacters.filter(c => !isCharInLocalLibrary(c));
    }
    // Favorites filter - use cached favorite IDs
    if (chubFilterFavorites && chubUserFavoriteIds.size > 0) {
        filteredCharacters = filteredCharacters.filter(c => {
            const charId = c.id || c.project_id;
            return chubUserFavoriteIds.has(charId);
        });
    }
    
    // Sort the characters based on chubTimelineSort
    const sortedCharacters = sortTimelineCharacters(filteredCharacters);
    
    // Check if filtering resulted in no characters
    if (sortedCharacters.length === 0 && chubTimelineCharacters.length > 0) {
        chubTimelineLookup.clear();
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting the filters.</p>
            </div>
        `;
        return;
    }

    buildChubLookup(chubTimelineLookup, sortedCharacters);
    grid.innerHTML = sortedCharacters.map(char => createChubCard(char, true)).join('');
}

// ============================================================================
// AUTHOR FILTERING
// ============================================================================

/**
 * Search for a creator from the creator search input
 */
function performChubCreatorSearch() {
    const creatorInput = document.getElementById('chubCreatorSearchInput');
    const creatorName = creatorInput?.value.trim();
    
    if (!creatorName) {
        showToast('Please enter a creator name', 'warning');
        return;
    }
    
    // Clear the input after search
    creatorInput.value = '';
    
    // Use existing filterByAuthor function
    filterByAuthor(creatorName);
}

function filterByAuthor(authorName) {
    // Switch to browse mode
    if (chubViewMode !== 'browse') {
        switchChubViewMode('browse');
    }
    
    // Set author filter
    chubAuthorFilter = authorName;
    
    // Reset author sort to newest (most useful default when viewing an author)
    chubAuthorSort = 'id'; // 'id' gives newest/most recently updated
    const sortSelect = document.getElementById('chubAuthorSortSelect');
    if (sortSelect) sortSelect.value = 'id';
    
    // Show author banner
    const banner = document.getElementById('chubAuthorBanner');
    const bannerName = document.getElementById('chubAuthorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = authorName;
        banner.classList.remove('hidden');
    }
    
    // Update follow button state
    updateFollowAuthorButton(authorName);
    
    // Clear search and reset
    document.getElementById('chubSearchInput').value = '';
    chubCurrentSearch = '';
    chubCharacters = [];
    chubCurrentPage = 1;
    
    // Load characters by this author
    loadChubCharacters();
}

// Track if we're following the current author
let chubIsFollowingCurrentAuthor = false;
let chubMyFollowsList = null; // Cache of who we follow

// Fetch list of users we follow (cached)
async function fetchMyFollowsList(forceRefresh = false) {
    if (chubMyFollowsList && !forceRefresh) {
        return chubMyFollowsList;
    }
    
    if (!chubToken) return [];
    
    try {
        // First get our own username from account
        const accountResp = await fetch(`${CHUB_API_BASE}/api/account`, {
            headers: getChubHeaders(true)
        });
        
        if (!accountResp.ok) {
            debugLog('[ChubFollow] Could not get account info');
            return [];
        }
        
        const accountData = await accountResp.json();
        
        // API returns user_name (with underscore), not username
        const myUsername = accountData.user_name || accountData.name || accountData.username || 
                          accountData.data?.user_name || accountData.data?.name;
        
        if (!myUsername) {
            debugLog('[ChubFollow] No username found in account data');
            return [];
        }
        
        // Now get who we follow
        const followsResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=1`, {
            headers: getChubHeaders(true)
        });
        
        if (!followsResp.ok) {
            debugLog('[ChubFollow] Could not get follows list');
            return [];
        }
        
        const followsData = await followsResp.json();
        
        // Extract usernames from the follows list
        // API returns "follows" array, not "nodes"
        const followsList = followsData.follows || followsData.nodes || followsData.data?.follows || followsData.data?.nodes || [];
        const followedUsernames = new Set();
        
        for (const node of followsList) {
            // The node might be a user object or have username in different places
            // API uses user_name (with underscore)
            const username = node.user_name || node.username || node.name || node.user?.user_name || node.user?.username;
            if (username) {
                followedUsernames.add(username.toLowerCase());
            }
        }
        
        // Fetch more pages if needed (count tells us total)
        const totalCount = followsData.count || 0;
        let page = 2;
        while (followedUsernames.size < totalCount && page <= 20) {
            const moreResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=${page}`, {
                headers: getChubHeaders(true)
            });
            
            if (!moreResp.ok) break;
            
            const moreData = await moreResp.json();
            const moreFollows = moreData.follows || moreData.nodes || moreData.data?.follows || [];
            
            if (moreFollows.length === 0) break;
            
            for (const node of moreFollows) {
                const username = node.user_name || node.username || node.name || node.user?.user_name;
                if (username) {
                    followedUsernames.add(username.toLowerCase());
                }
            }
            page++;
        }
        
        chubMyFollowsList = followedUsernames;
        debugLog('[ChubFollow] Following', followedUsernames.size, 'users:', [...followedUsernames]);
        return followedUsernames;
        
    } catch (e) {
        console.error('[ChubFollow] Error fetching follows:', e);
        return [];
    }
}

// Update the follow button based on whether we're already following this author
async function updateFollowAuthorButton(authorName) {
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (!followBtn) return;
    
    // Show/hide based on whether we have a token
    if (!chubToken) {
        followBtn.style.display = 'none';
        return;
    }
    
    followBtn.style.display = '';
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    // Check if we're following this author
    try {
        const followsList = await fetchMyFollowsList();
        chubIsFollowingCurrentAuthor = followsList && followsList.has(authorName.toLowerCase());
        debugLog('[ChubFollow] Checking if following', authorName, ':', chubIsFollowingCurrentAuthor);
    } catch (e) {
        debugLog('[ChubFollow] Could not check follow status:', e);
        chubIsFollowingCurrentAuthor = false;
    }
    
    // Update button state
    followBtn.disabled = false;
    if (chubIsFollowingCurrentAuthor) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = `Unfollow ${authorName} on ChubAI`;
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = `Follow ${authorName} on ChubAI`;
    }
}

// Follow/unfollow the currently viewed author
async function toggleFollowAuthor() {
    if (!chubAuthorFilter || !chubToken) {
        showToast('Login required to follow authors', 'warning');
        return;
    }
    
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        // ChubAI follow API: POST to follow, DELETE to unfollow
        // Correct endpoint: /api/follow/{username}
        const method = chubIsFollowingCurrentAuthor ? 'DELETE' : 'POST';
        const headers = getChubHeaders(true);
        headers['Content-Type'] = 'application/json';
        
        const response = await fetch(`${CHUB_API_BASE}/api/follow/${chubAuthorFilter}`, {
            method: method,
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubFollow] Error:', response.status, errorText);
            throw new Error(`Failed: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('[ChubFollow] Response:', data);
        
        // Toggle state and update cache
        chubIsFollowingCurrentAuthor = !chubIsFollowingCurrentAuthor;
        
        // Update the cached follows list
        if (chubMyFollowsList) {
            const authorLower = chubAuthorFilter.toLowerCase();
            if (chubIsFollowingCurrentAuthor) {
                chubMyFollowsList.add(authorLower);
            } else {
                chubMyFollowsList.delete(authorLower);
            }
        }
        
        if (chubIsFollowingCurrentAuthor) {
            showToast(`Now following ${chubAuthorFilter}!`, 'success');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
                followBtn.classList.add('following');
            }
        } else {
            showToast(`Unfollowed ${chubAuthorFilter}`, 'info');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
                followBtn.classList.remove('following');
            }
        }
        
        if (followBtn) followBtn.disabled = false;
        
    } catch (e) {
        console.error('[ChubFollow] Error:', e);
        showToast(`Failed: ${e.message}`, 'error');
        
        if (followBtn) {
            followBtn.disabled = false;
            // Restore previous state
            if (chubIsFollowingCurrentAuthor) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
            } else {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            }
        }
    }
}

function clearAuthorFilter() {
    chubAuthorFilter = null;
    
    // Hide banner
    hide('chubAuthorBanner');
    
    // Reload without author filter
    chubCharacters = [];
    chubCurrentPage = 1;
    loadChubCharacters();
}

function performChubSearch() {
    const searchInput = document.getElementById('chubSearchInput');
    chubCurrentSearch = searchInput.value.trim();
    // Clear author filter when doing a new search
    if (chubAuthorFilter) {
        chubAuthorFilter = null;
        hide('chubAuthorBanner');
    }
    chubCharacters = [];
    chubCurrentPage = 1;
    loadChubCharacters();
}

async function loadChubCharacters(forceRefresh = false) {
    if (chubIsLoading) return;
    
    const grid = document.getElementById('chubGrid');
    const loadMoreContainer = document.getElementById('chubLoadMore');
    
    // Special handling for favorites filter - use gateway API directly
    if (chubFilterFavorites && chubToken) {
        await loadChubFavorites(forceRefresh);
        return;
    }
    
    if (chubCurrentPage === 1) {
        renderLoadingState(grid, 'Loading ChubAI characters...', 'chub-loading');
    }
    
    chubIsLoading = true;
    
    try {
        // Build query parameters - ChubAI uses query params even with POST
        const params = new URLSearchParams();
        params.set('first', '24');
        // Get sort and time from discovery preset
        const preset = CHUB_DISCOVERY_PRESETS[chubDiscoveryPreset] || CHUB_DISCOVERY_PRESETS['popular_week'];
        
        params.set('page', chubCurrentPage.toString());
        params.set('nsfw', chubNsfwEnabled.toString());
        params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
        params.set('include_forks', 'true'); // Include forked characters
        params.set('venus', 'false');
        
        if (chubCurrentSearch) {
            params.set('search', chubCurrentSearch);
        }
        
        // Author filter - use 'username' parameter
        if (chubAuthorFilter) {
            params.set('username', chubAuthorFilter);
            // Use author-specific sort instead of preset sort
            params.set('sort', chubAuthorSort);
            // Don't apply time period filter when viewing an author's profile
            // We want to see all their characters, not just recent ones
        } else {
            // Use preset sort for general browsing
            if (preset.sort !== 'default') {
                params.set('sort', preset.sort);
            }
            // Add special_mode filter if preset has one (e.g., newcomer for recent hits)
            if (preset.special_mode) {
                params.set('special_mode', preset.special_mode);
            }
            // Add time period filter from preset (max_days_ago) only for general browsing
            if (preset.days > 0) {
                params.set('max_days_ago', preset.days.toString());
            }
        }
        
        // Add additional filters
        if (chubFilterImages) {
            params.set('require_images', 'true');
        }
        if (chubFilterLore) {
            params.set('require_lore', 'true');
        }
        if (chubFilterExpressions) {
            params.set('require_expressions', 'true');
        }
        if (chubFilterGreetings) {
            params.set('require_alternate_greetings', 'true');
        }
        
        // === Advanced Tag Filters ===
        // Include tags (topics)
        const includeTags = [];
        const excludeTags = [];
        for (const [tag, state] of chubTagFilters) {
            if (state === 'include') includeTags.push(tag);
            else if (state === 'exclude') excludeTags.push(tag);
        }
        if (includeTags.length > 0) {
            params.set('topics', includeTags.join(','));
        }
        if (excludeTags.length > 0) {
            params.set('excludetopics', excludeTags.join(','));
        }
        
        // Sort direction
        if (chubSortAscending) {
            params.set('asc', 'true');
        }
        
        // Token limits (only set if different from defaults)
        if (chubMinTokens !== 50) {
            params.set('min_tokens', chubMinTokens.toString());
        } else {
            params.set('min_tokens', '50');
        }
        if (chubMaxTokens !== 100000) {
            params.set('max_tokens', chubMaxTokens.toString());
        }
        
        // Note: Favorites filter is now handled by loadChubFavorites() using gateway API
        
        debugLog('[ChubAI] Search params:', params.toString());
        
        const headers = getChubHeaders(true);
        
        const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('ChubAI response:', errorText);
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Handle different response formats
        let nodes = [];
        if (data.nodes) {
            nodes = data.nodes;
        } else if (data.data?.nodes) {
            nodes = data.data.nodes;
        } else if (Array.isArray(data.data)) {
            nodes = data.data;
        } else if (Array.isArray(data)) {
            nodes = data;
        }
        
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
            // Extract popular tags from search results on first page
            extractChubTagsFromResults(nodes);
        } else {
            // Push new items instead of spread-copying the entire array
            // (spread creates a full copy of all existing items on every "load more")
            for (const node of nodes) chubCharacters.push(node);
        }
        
        chubHasMore = nodes.length >= 24;
        
        renderChubGrid();
        
        // Show/hide load more button
        if (loadMoreContainer) {
            loadMoreContainer.style.display = chubHasMore ? 'flex' : 'none';
        }
        
    } catch (e) {
        console.error('ChubAI load error:', e);
        if (chubCurrentPage === 1) {
            grid.innerHTML = `
                <div class="chub-error">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load ChubAI</h3>
                    <p>${escapeHtml(e.message)}</p>
                    <button class="action-btn primary" onclick="loadChubCharacters(true)">
                        <i class="fa-solid fa-refresh"></i> Retry
                    </button>
                </div>
            `;
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        chubIsLoading = false;
    }
}

/**
 * Fetch and cache user's favorite character IDs
 * Used for filtering in timeline view
 */
async function fetchChubUserFavoriteIds() {
    if (!chubToken) {
        chubUserFavoriteIds = new Set();
        return;
    }
    
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?first=500`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const nodes = data.nodes || data.data || [];
            chubUserFavoriteIds = new Set(nodes.map(n => n.id || n.project_id).filter(Boolean));
            debugLog('[ChubAI] Cached', chubUserFavoriteIds.size, 'favorite IDs');
        }
    } catch (e) {
        debugLog('[ChubAI] Failed to fetch favorite IDs:', e.message);
    }
}

/**
 * Load user's favorites from ChubAI gateway API
 * This uses a different endpoint than the search API
 */
async function loadChubFavorites(forceRefresh = false) {
    const grid = document.getElementById('chubGrid');
    const loadMoreContainer = document.getElementById('chubLoadMore');
    
    if (chubCurrentPage === 1) {
        renderLoadingState(grid, 'Loading your favorites...', 'chub-loading');
    }
    
    chubIsLoading = true;
    
    try {
        // Use gateway API to fetch favorites directly
        const params = new URLSearchParams();
        params.set('first', '100'); // Get more items per page from favorites
        
        if (chubCurrentPage > 1) {
            params.set('page', chubCurrentPage.toString());
        }
        
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?${params.toString()}`;
        debugLog('[ChubAI] Loading favorites from:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load favorites: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('[ChubAI] Favorites response:', data);
        
        // Extract nodes from response
        let nodes = data.nodes || data.data || [];
        
        // Apply additional filters client-side
        if (chubFilterImages) {
            nodes = nodes.filter(c => c.hasGallery || c.has_gallery);
        }
        if (chubFilterLore) {
            nodes = nodes.filter(c => c.has_lore || c.related_lorebooks?.length > 0);
        }
        if (chubFilterExpressions) {
            nodes = nodes.filter(c => c.has_expression_pack);
        }
        if (chubFilterGreetings) {
            nodes = nodes.filter(c => c.alternate_greetings?.length > 0 || c.n_greetings > 1);
        }
        if (chubFilterHideOwned) {
            nodes = nodes.filter(c => !isCharInLocalLibrary(c));
        }
        
        // Apply NSFW filter
        if (!chubNsfwEnabled) {
            nodes = nodes.filter(c => !c.nsfw);
        }
        
        // Apply search filter if any
        if (chubCurrentSearch) {
            const search = chubCurrentSearch.toLowerCase();
            nodes = nodes.filter(c => {
                const name = (c.name || '').toLowerCase();
                const creator = (c.fullPath?.split('/')[0] || '').toLowerCase();
                const tagline = (c.tagline || '').toLowerCase();
                return name.includes(search) || creator.includes(search) || tagline.includes(search);
            });
        }
        
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
        } else {
            // Push new items instead of spread-copying the entire array
            for (const node of nodes) chubCharacters.push(node);
        }
        
        // Check if there's more data
        chubHasMore = data.cursor !== null && nodes.length > 0;
        
        renderChubGrid();
        
        // Show/hide load more button
        if (loadMoreContainer) {
            loadMoreContainer.style.display = chubHasMore ? 'flex' : 'none';
        }
        
    } catch (e) {
        console.error('[ChubAI] Favorites load error:', e);
        if (chubCurrentPage === 1) {
            grid.innerHTML = `
                <div class="chub-empty-state">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load favorites</h3>
                    <p>${escapeHtml(e.message)}</p>
                    <button class="action-btn primary" onclick="loadChubCharacters(true)">
                        <i class="fa-solid fa-refresh"></i> Retry
                    </button>
                </div>
            `;
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        chubIsLoading = false;
    }
}

function renderChubGrid() {
    const grid = document.getElementById('chubGrid');
    
    // Apply client-side "hide owned" filter (other filters are server-side)
    let displayCharacters = chubCharacters;
    if (chubFilterHideOwned) {
        displayCharacters = chubCharacters.filter(c => !isCharInLocalLibrary(c));
    }
    
    if (displayCharacters.length === 0) {
        chubCardLookup.clear();
        const message = chubCharacters.length > 0 && chubFilterHideOwned
            ? 'All characters in this view are already in your library.'
            : 'Try a different search term or adjust your filters.';
        grid.innerHTML = `
            <div class="chub-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Characters Found</h3>
                <p>${message}</p>
            </div>
        `;
        return;
    }

    buildChubLookup(chubCardLookup, displayCharacters);
    grid.innerHTML = displayCharacters.map(char => createChubCard(char)).join('');
}

function setupChubGridDelegates() {
    if (chubDelegatesInitialized) return;

    const grid = document.getElementById('chubGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.chub-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.chub-card');
            if (!card) return;
            const fullPath = card.dataset.fullPath;
            const char = chubCardLookup.get(fullPath) || chubCharacters.find(c => getChubFullPath(c) === fullPath);
            if (char) openChubCharPreview(char);
        });
    }

    const timelineGrid = document.getElementById('chubTimelineGrid');
    if (timelineGrid) {
        timelineGrid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.chub-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.chub-card');
            if (!card) return;
            const fullPath = card.dataset.fullPath;
            const char = chubTimelineLookup.get(fullPath) || chubTimelineCharacters.find(c => getChubFullPath(c) === fullPath);
            if (char) openChubCharPreview(char);
        });
    }

    chubDelegatesInitialized = true;
}

function createChubCard(char, isTimeline = false) {
    const name = char.name || 'Unknown';
    const fullPath = getChubFullPath(char);
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    const rating = char.rating ? char.rating.toFixed(1) : '0.0';
    const ratingCount = char.ratingCount || 0;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloads = formatNumber(char.starCount || 0);
    const favorites = formatNumber(char.n_favorites || char.nFavorites || 0);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/ai4.png');
    
    // Check if this character is in local library
    const inLibrary = isCharInLocalLibrary(char);
    
    // Get up to 3 tags
    const tags = (char.topics || []).slice(0, 3);
    
    // Build feature badges
    const badges = [];
    if (inLibrary) {
        badges.push('<span class="chub-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (char.hasGallery) {
        badges.push('<span class="chub-feature-badge gallery" title="Has Gallery"><i class="fa-solid fa-images"></i></span>');
    }
    if (char.has_lore || char.related_lorebooks?.length > 0) {
        badges.push('<span class="chub-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }
    if (char.has_expression_pack) {
        badges.push('<span class="chub-feature-badge" title="Has Expressions"><i class="fa-solid fa-face-smile"></i></span>');
    }
    if (char.alternate_greetings?.length > 0 || char.n_greetings > 1) {
        badges.push('<span class="chub-feature-badge" title="Alt Greetings"><i class="fa-solid fa-comment-dots"></i></span>');
    }
    if (char.recommended || char.verified) {
        badges.push('<span class="chub-feature-badge verified" title="Verified"><i class="fa-solid fa-check-circle"></i></span>');
    }
    
    // Show date on cards - createdAt for all cards
    const createdDate = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="chub-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    
    // Add "in library" class to card for potential styling
    const cardClass = inLibrary ? 'chub-card in-library' : 'chub-card';
    
    // Tagline for hover tooltip (escape for HTML attribute)
    const taglineTooltip = char.tagline ? escapeHtml(char.tagline) : '';
    
    return `
        <div class="${cardClass}" data-full-path="${escapeHtml(fullPath)}" ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="chub-card-image">
                <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.src='/img/ai4.png'">
                ${char.nsfw ? '<span class="chub-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="chub-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="chub-card-body">
                <div class="chub-card-name">${escapeHtml(name)}</div>
                <span class="chub-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                <div class="chub-card-tags">
                    ${tags.map(t => `<span class="chub-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="chub-card-footer">
                <span class="chub-card-stat" title="${ratingCount} rating${ratingCount !== 1 ? 's' : ''}"><i class="fa-solid fa-star"></i> ${rating}</span>
                <span class="chub-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${downloads}</span>
                <span class="chub-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${favorites}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

function applyChubTagsClamp(tagsEl) {
    if (!tagsEl) return;

    const existingToggle = tagsEl.querySelector('.chub-tags-more');
    if (existingToggle) existingToggle.remove();

    tagsEl.querySelectorAll('.chub-tag-hidden').forEach(tag => {
        tag.classList.remove('chub-tag-hidden');
    });

    tagsEl.classList.remove('chub-tags-collapsed', 'chub-tags-expanded');

    const tags = Array.from(tagsEl.querySelectorAll('.chub-tag'));
    if (!tags.length) return;

    tagsEl.classList.add('chub-tags-collapsed');

    const maxHeightValue = getComputedStyle(tagsEl).getPropertyValue('--chub-tags-max-height').trim();
    const maxHeight = parseFloat(maxHeightValue) || tagsEl.clientHeight || 64;

    let overflowIndex = -1;
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const tagBottom = tag.offsetTop + tag.offsetHeight;
        if (tagBottom > maxHeight + 2) {
            overflowIndex = i;
            break;
        }
    }

    if (overflowIndex === -1) {
        tagsEl.classList.remove('chub-tags-collapsed');
        return;
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chub-tag chub-tags-more';
    toggle.textContent = '...';
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isCollapsed = tagsEl.classList.contains('chub-tags-collapsed');
        if (isCollapsed) {
            tagsEl.classList.remove('chub-tags-collapsed');
            tagsEl.classList.add('chub-tags-expanded');
            tagsEl.querySelectorAll('.chub-tag-hidden').forEach(tag => tag.classList.remove('chub-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyChubTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) {
        tags[i].classList.add('chub-tag-hidden');
    }
}

function abortChubDetailFetch() {
    if (chubDetailFetchController) {
        try { chubDetailFetchController.abort(); } catch (e) { /* ignore */ }
        chubDetailFetchController = null;
    }
}

async function openChubCharPreview(char) {
    // Abort any in-flight detail fetch from a previous preview
    abortChubDetailFetch();
    chubSelectedChar = char;
    
    const modal = document.getElementById('chubCharModal');
    const avatarImg = document.getElementById('chubCharAvatar');
    const nameEl = document.getElementById('chubCharName');
    const creatorLink = document.getElementById('chubCharCreator');
    const ratingEl = document.getElementById('chubCharRating');
    const downloadsEl = document.getElementById('chubCharDownloads');
    const tagsEl = document.getElementById('chubCharTags');
    const tokensEl = document.getElementById('chubCharTokens');
    const dateEl = document.getElementById('chubCharDate');
    const descEl = document.getElementById('chubCharDescription');
    const taglineSection = document.getElementById('chubCharTaglineSection');
    const taglineEl = document.getElementById('chubCharTagline');
    const openInBrowserBtn = document.getElementById('chubOpenInBrowserBtn');
    
    // Creator's Notes (public ChubAI description - always visible at top)
    const creatorNotesEl = document.getElementById('chubCharCreatorNotes');
    
    // Definition sections (from detailed fetch)
    const greetingsStat = document.getElementById('chubCharGreetingsStat');
    const greetingsCount = document.getElementById('chubCharGreetingsCount');
    const lorebookStat = document.getElementById('chubCharLorebookStat');
    const descSection = document.getElementById('chubCharDescriptionSection');
    // descEl already defined above
    const personalitySection = document.getElementById('chubCharPersonalitySection');
    const personalityEl = document.getElementById('chubCharPersonality');
    const scenarioSection = document.getElementById('chubCharScenarioSection');
    const scenarioEl = document.getElementById('chubCharScenario');
    const firstMsgSection = document.getElementById('chubCharFirstMsgSection');
    const firstMsgEl = document.getElementById('chubCharFirstMsg');
    const altGreetingsSection = document.getElementById('chubCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('chubCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('chubCharAltGreetingsCount');
    
    const fullPath = getChubFullPath(char);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/ai4.png');
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    nameEl.textContent = char.name || 'Unknown';
    creatorLink.textContent = creatorName;
    creatorLink.href = '#'; // In-app filter action
    creatorLink.title = `Click to see all characters by ${creatorName}`;
    creatorLink.onclick = (e) => {
        e.preventDefault();
        modal.classList.add('hidden');
        filterByAuthor(creatorName);
    };
    // External link to author's ChubAI profile
    const creatorExternal = document.getElementById('chubCreatorExternal');
    if (creatorExternal) {
        creatorExternal.href = `https://chub.ai/users/${creatorName}`;
    }
    openInBrowserBtn.href = `https://chub.ai/characters/${fullPath}`;
    const ratingCount = char.ratingCount || 0;
    ratingEl.innerHTML = `<i class="fa-solid fa-star"></i> ${char.rating ? char.rating.toFixed(1) : '0.0'}`;
    ratingEl.title = `${ratingCount} rating${ratingCount !== 1 ? 's' : ''}`;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloadCount = char.starCount || 0;
    const favoritesCount = char.n_favorites || char.nFavorites || 0;
    downloadsEl.innerHTML = `<i class="fa-solid fa-download"></i> ${formatNumber(downloadCount)}`;
    downloadsEl.title = 'Downloads';
    
    // Tags
    const tags = char.topics || [];
    tagsEl.innerHTML = tags.map(t => `<span class="chub-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyChubTagsClamp(tagsEl));
    
    // Stats
    tokensEl.textContent = formatNumber(char.nTokens || 0);
    dateEl.textContent = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : 'Unknown';
    
    // Favorite button - n_favorites is the actual favorite count
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    favoriteCountEl.textContent = formatNumber(favoritesCount);
    
    // Check if user has favorited this character (requires token)
    updateChubFavoriteButton(char);
    
    // Creator's Notes (public ChubAI listing description) - use secure iframe renderer
    renderCreatorNotesSecure(char.description || char.tagline || 'No description available.', char.name, creatorNotesEl);
    
    // Tagline
    if (char.tagline && char.tagline !== char.description) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = sanitizeTaglineHtml(char.tagline, char.name);
    } else {
        taglineSection.style.display = 'none';
    }
    
    // Greetings count
    const numGreetings = char.n_greetings || (char.alternate_greetings?.length ? char.alternate_greetings.length + 1 : 1);
    if (numGreetings > 1) {
        greetingsStat.style.display = 'flex';
        greetingsCount.textContent = numGreetings;
    } else {
        greetingsStat.style.display = 'none';
    }
    
    // Lorebook indicator
    if (char.has_lore || char.related_lorebooks?.length > 0) {
        lorebookStat.style.display = 'flex';
    } else {
        lorebookStat.style.display = 'none';
    }
    
    // Reset definition sections (will be filled from detailed fetch)
    descSection.style.display = 'none';
    personalitySection.style.display = 'none';
    scenarioSection.style.display = 'none';
    firstMsgSection.style.display = 'none';
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';
    
    modal.classList.remove('hidden');
    
    const renderAltGreetings = (greetings) => {
        if (!altGreetingsSection || !altGreetingsEl) return;
        if (!Array.isArray(greetings) || greetings.length === 0) {
            altGreetingsSection.style.display = 'none';
            altGreetingsEl.innerHTML = '';
            if (altGreetingsCountEl) altGreetingsCountEl.textContent = '';
            window.currentChubAltGreetings = [];
            return;
        }
        const buildPreview = (text) => {
            const cleaned = (text || '').replace(/\s+/g, ' ').trim();
            if (!cleaned) return 'No content';
            return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
        };
        altGreetingsSection.style.display = 'block';
        // Build HTML with empty bodies — content is rendered lazily on toggle to save memory
        altGreetingsEl.innerHTML = greetings.map((greeting, idx) => {
            const label = `#${idx + 1}`;
            const preview = escapeHtml(buildPreview(greeting));
            return `
                <details class="chub-alt-greeting" data-greeting-idx="${idx}">
                    <summary>
                        <span class="chub-alt-greeting-index">${label}</span>
                        <span class="chub-alt-greeting-preview">${preview}</span>
                        <span class="chub-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                    </summary>
                    <div class="chub-alt-greeting-body"></div>
                </details>
            `;
        }).join('');
        // Lazy-render greeting body on first open (avoids formatRichText for ALL greetings at once)
        altGreetingsEl.querySelectorAll('details.chub-alt-greeting').forEach(details => {
            details.addEventListener('toggle', function onToggle() {
                if (!details.open) return;
                const body = details.querySelector('.chub-alt-greeting-body');
                if (body && !body.dataset.rendered) {
                    const idx = parseInt(details.dataset.greetingIdx, 10);
                    if (greetings[idx] != null) {
                        body.innerHTML = formatRichText(greetings[idx], char.name, true);
                    }
                    body.dataset.rendered = '1';
                }
            }, { once: true });
        });
        if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${greetings.length})`;
        window.currentChubAltGreetings = greetings;
    };

    // Render from basic data if already present
    renderAltGreetings(char.alternate_greetings || []);

    const applyDetailData = (node) => {
        if (!node) return;
        const def = node.definition || {};

        // Update Creator's Notes if node has better/different description than search result
        // node.description is the PUBLIC listing description (Creator's Notes)
        if (node.description && node.description !== char.description) {
            renderCreatorNotesSecure(node.description, char.name, creatorNotesEl);
        }

        // Character Definition (def.personality in ChubAI API = character description/definition for prompt)
        // This is confusingly named in ChubAI's API - "personality" is actually the main character definition
        if (def.personality) {
            descSection.style.display = 'block';
            descEl.innerHTML = formatRichText(def.personality, char.name, true);
            descEl.dataset.fullContent = def.personality;
        }

        // Scenario
        if (def.scenario) {
            scenarioSection.style.display = 'block';
            scenarioEl.innerHTML = formatRichText(def.scenario, char.name, true);
            scenarioEl.dataset.fullContent = def.scenario;
        }

        // First message - ChubAI uses first_message, not first_mes
        const firstMsg = def.first_message || def.first_mes;
        if (firstMsg) {
            firstMsgSection.style.display = 'block';
            firstMsgEl.innerHTML = formatRichText(firstMsg, char.name, true);
            firstMsgEl.dataset.fullContent = firstMsg;
        }

        // Update greetings count if we have better data
        if (def.alternate_greetings?.length > 0) {
            greetingsStat.style.display = 'flex';
            greetingsCount.textContent = def.alternate_greetings.length + 1;
        }

        // Alternate greetings list
        if (def.alternate_greetings) {
            renderAltGreetings(def.alternate_greetings);
        }
    };

    const cachedDetail = fullPath ? chubDetailCache.get(fullPath) : null;
    if (cachedDetail) {
        // LRU refresh: move to end of Map insertion order
        chubDetailCache.delete(fullPath);
        chubDetailCache.set(fullPath, cachedDetail);
        applyDetailData(cachedDetail);
    }

    if (!cachedDetail && fullPath) {
        // Try to fetch detailed character info
        chubDetailFetchController = new AbortController();
        const fetchSignal = chubDetailFetchController.signal;
        try {
            const detailUrl = `https://api.chub.ai/api/characters/${fullPath}?full=true`;

            const response = await fetch(detailUrl, { signal: fetchSignal });
            if (response.ok) {
                const detailData = await response.json();
                // If modal was closed or a different character was opened while 
                // we were fetching, discard the result to avoid stale rendering
                if (fetchSignal.aborted || chubSelectedChar !== char) {
                    debugLog('[ChubAI] Detail fetch completed but modal moved on — discarding');
                } else {
                    const node = detailData.node || detailData;
                    // Strip heavy data we never display — character_book (lorebook) can be
                    // 100KB-1MB by itself, mes_example and extensions add more.
                    // Only keep fields actually used in applyDetailData.
                    const stripped = {
                        description: node.description,
                        definition: node.definition ? {
                            personality: node.definition.personality,
                            scenario: node.definition.scenario,
                            first_message: node.definition.first_message,
                            first_mes: node.definition.first_mes,
                            alternate_greetings: node.definition.alternate_greetings,
                        } : undefined,
                    };
                    // Enforce LRU cap — evict oldest entries
                    while (chubDetailCache.size >= CHUB_DETAIL_CACHE_MAX) {
                        const oldestKey = chubDetailCache.keys().next().value;
                        chubDetailCache.delete(oldestKey);
                    }
                    chubDetailCache.set(fullPath, stripped);
                    applyDetailData(stripped);
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                debugLog('[ChubAI] Detail fetch aborted (modal closed)');
            } else {
                debugLog('[ChubAI] Could not fetch detailed character info:', e.message);
            }
            // Modal still works with basic info
        }
    }
}

/**
 * Update the favorite button state for ChubAI character
 */
async function updateChubFavoriteButton(char) {
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    if (!favoriteBtn) return;
    
    // Reset state
    favoriteBtn.classList.remove('favorited', 'loading');
    favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
    
    // If no token, show but disable with tooltip
    if (!chubToken) {
        favoriteBtn.title = 'Login to ChubAI to add favorites';
        return;
    }
    
    favoriteBtn.title = 'Add to favorites on ChubAI';
    
    // If we already know the favorited state (from previous check or toggle), use it
    if (char._isFavorited === true) {
        favoriteBtn.classList.add('favorited');
        favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
        favoriteBtn.title = 'Remove from favorites on ChubAI';
        return;
    } else if (char._isFavorited === false) {
        // Already checked and not favorited
        return;
    }
    
    // Check if user has favorited this character via API
    try {
        const charId = char.id || char.project_id;
        if (!charId) {
            debugLog('[ChubAI] Cannot check favorite status: no character id');
            return;
        }
        
        favoriteBtn.classList.add('loading');
        
        // Try to get user's favorites list and check if this char is in it
        // The gateway endpoint might not support GET for single item, so we check differently
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?first=500`;
        debugLog('[ChubAI] Checking favorites list for:', charId);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        favoriteBtn.classList.remove('loading');
        
        if (response.ok) {
            const data = await response.json();
            debugLog('[ChubAI] Favorites response:', data);
            
            // Check if this character's ID is in the favorites list
            let isFavorited = false;
            const nodes = data.nodes || data.data || data || [];
            if (Array.isArray(nodes)) {
                isFavorited = nodes.some(fav => {
                    const favId = fav.id || fav.project_id || fav.node?.id;
                    return favId === charId || String(favId) === String(charId);
                });
            }
            
            // Store state on character for persistence
            char._isFavorited = isFavorited;
            
            if (isFavorited) {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
                favoriteBtn.title = 'Remove from favorites on ChubAI';
                debugLog('[ChubAI] Character is in favorites');
            } else {
                char._isFavorited = false;
                debugLog('[ChubAI] Character is NOT in favorites');
            }
        } else {
            debugLog('[ChubAI] Favorites check failed:', response.status);
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        debugLog('[ChubAI] Could not check favorite status:', e.message);
    }
}

/**
 * Toggle favorite for the currently selected ChubAI character
 */
async function toggleChubCharFavorite() {
    if (!chubSelectedChar || !chubToken) {
        if (!chubToken) {
            showToast('Login to ChubAI to add favorites', 'info');
            openChubTokenModal();
        }
        return;
    }
    
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    if (!favoriteBtn) return;
    
    // ChubAI favorites API uses numeric project id at gateway.chub.ai
    const charId = chubSelectedChar.id || chubSelectedChar.project_id;
    if (!charId) {
        showToast('Cannot favorite this character - missing ID', 'error');
        return;
    }
    
    const isCurrentlyFavorited = favoriteBtn.classList.contains('favorited');
    
    favoriteBtn.classList.add('loading');
    
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites/${charId}`;
        debugLog('[ChubAI] Toggle favorite:', isCurrentlyFavorited ? 'DELETE' : 'POST', url);
        
        const response = await fetch(url, {
            method: isCurrentlyFavorited ? 'DELETE' : 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            },
            body: '{}'  // ChubAI expects empty JSON body
        });
        
        favoriteBtn.classList.remove('loading');
        
        debugLog('[ChubAI] Favorite toggle response:', response.status, response.statusText);
        
        if (response.ok) {
            const responseData = await response.json().catch(() => ({}));
            debugLog('[ChubAI] Favorite toggle success data:', responseData);
            
            if (isCurrentlyFavorited) {
                favoriteBtn.classList.remove('favorited');
                favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
                favoriteBtn.title = 'Add to favorites on ChubAI';
                // Update stored state
                chubSelectedChar._isFavorited = false;
                // Decrement count
                const currentCount = parseInt(favoriteCountEl.textContent.replace(/[KM]/g, '')) || 0;
                if (currentCount > 0) {
                    chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 1) - 1;
                    favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                }
                showToast('Removed from ChubAI favorites', 'info');
            } else {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
                favoriteBtn.title = 'Remove from favorites on ChubAI';
                // Update stored state
                chubSelectedChar._isFavorited = true;
                // Increment count
                chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 0) + 1;
                favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                showToast('Added to ChubAI favorites!', 'success');
            }
        } else {
            const errorText = await response.text().catch(() => '');
            console.error('[ChubAI] Favorite toggle error response:', response.status, errorText);
            const errorData = JSON.parse(errorText || '{}');
            showToast(errorData.message || `Failed to update favorite (${response.status})`, 'error');
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        console.error('[ChubAI] Favorite toggle error:', e);
        showToast('Failed to update favorite', 'error');
    }
}

/**
 * Clean up memory held by the ChubAI character modal.
 * Releases window globals, dataset.fullContent, alt greetings HTML, and iframe content.
 * Critical for mobile where memory is limited.
 */
function cleanupChubCharModal() {
    // Release window globals
    window.currentChubAltGreetings = null;
    
    const modal = document.getElementById('chubCharModal');
    if (modal) {
        // Clear heavy dataset.fullContent stored on DOM elements
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });
        
        // Clear all rendered section content (can hold large formatRichText HTML)
        const sectionIds = [
            'chubCharAltGreetings',   // alt greetings list (was wrong ID before!)
            'chubCharDescription',    // character description
            'chubCharScenario',       // scenario
            'chubCharFirstMsg',       // first message
            'chubCharTagline',        // tagline
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        
        // Clear creator notes iframe — disconnect ResizeObserver and release its document
        const creatorNotesEl = document.getElementById('chubCreatorNotes');
        cleanupCreatorNotesContainer(creatorNotesEl);
    }
}

async function downloadChubCharacter() {
    if (!chubSelectedChar) return;
    
    // Abort any in-flight detail fetch — we're downloading now, no need for preview data
    abortChubDetailFetch();
    
    const downloadBtn = document.getElementById('chubDownloadBtn');
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    downloadBtn.disabled = true;
    
    // Will be set if we're replacing an existing character, to inherit their gallery folder
    let inheritedGalleryId = null;
    
    try {
        // Free heavy caches before download to maximize available memory (critical for mobile)
        chubDetailCache.clear();
        chubMetadataCache.clear();
        // Yield to browser for GC of cleared caches before allocating download buffers
        await new Promise(r => setTimeout(r, 100));
        
        // Use the same method as the working importChubCharacter function
        const fullPath = chubSelectedChar.fullPath;
        
        // Fetch complete character data from the API
        let metadata = await fetchChubMetadata(fullPath);
        
        if (!metadata || !metadata.definition) {
            throw new Error('Could not fetch character data from API');
        }
        
        const characterName = metadata.definition?.name || metadata.name || fullPath.split('/').pop();
        const characterCreator = metadata.definition?.creator || metadata.creator || fullPath.split('/')[0] || '';
        
        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = checkCharacterForDuplicates({
            name: characterName,
            creator: characterCreator,
            fullPath: fullPath,
            definition: metadata.definition
        });
        
        if (duplicateMatches.length > 0) {
            // Show duplicate warning and wait for user choice
            downloadBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';
            
            const result = await showPreImportDuplicateWarning({
                name: characterName,
                creator: characterCreator,
                fullPath: fullPath,
                avatarUrl: `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`
            }, duplicateMatches);
            
            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                return;
            }
            
            if (result.choice === 'replace') {
                // Delete the first (highest confidence) match before importing
                const toReplace = duplicateMatches[0].char;
                
                // IMPORTANT: Capture the existing character's gallery_id BEFORE deleting
                // so we can inherit it and keep using the same gallery folder
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (inheritedGalleryId) {
                    debugLog('[ChubDownload] Inheriting gallery_id from replaced character:', inheritedGalleryId);
                }
                
                downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                
                // Use the proper delete function that syncs with ST
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (deleteSuccess) {
                    debugLog('[ChubDownload] Deleted existing character:', toReplace.avatar);
                } else {
                    console.warn('[ChubDownload] Could not delete existing character, proceeding with import anyway');
                }
            }
            // If choice is 'import', continue with import normally
        }
        // === END DUPLICATE CHECK ===
        
        downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';
        
        // Build the character card from API metadata (uses ST's exact field mapping)
        // This always has the LATEST version data, unlike chara_card_v2.png which may be stale
        const characterCard = buildCharacterCardFromChub(metadata);
        // Capture fields we need after the card is built, then release the full metadata
        const metadataHasGallery = metadata.hasGallery || false;
        const metadataId = metadata.id || null;
        const metadataTagline = metadata.tagline || metadata.definition?.tagline || '';
        const metadataMaxResUrl = metadata.max_res_url || null;
        const metadataAvatarUrl = metadata.avatar_url || null;
        metadata = null;
        
        // Ensure extensions object exists
        if (!characterCard.data.extensions) {
            characterCard.data.extensions = {};
        }
        
        // Add ChubAI link metadata
        const existingChub = characterCard.data.extensions.chub || {};
        characterCard.data.extensions.chub = {
            ...existingChub,
            id: metadataId || existingChub.id || null,
            full_path: fullPath,
            tagline: metadataTagline || existingChub.tagline || '',
            linkedAt: new Date().toISOString()
        };
        
        // Add unique gallery_id if enabled (inherit from replaced character if available)
        if (getSetting('uniqueGalleryFolders')) {
            if (inheritedGalleryId) {
                characterCard.data.extensions.gallery_id = inheritedGalleryId;
                debugLog('[ChubDownload] Using inherited gallery_id:', inheritedGalleryId);
            } else if (!characterCard.data.extensions.gallery_id) {
                characterCard.data.extensions.gallery_id = generateGalleryId();
                debugLog('[ChubDownload] Assigned new gallery_id:', characterCard.data.extensions.gallery_id);
            }
        }
        
        // Download avatar IMAGE (not the card PNG — that may have stale data)
        // Priority: max_res_url > avatar URLs > chara_card_v2.png (last resort)
        const imageUrls = [];
        
        // ST uses metadata.node.max_res_url for highest quality avatar
        if (metadataMaxResUrl) {
            imageUrls.push(metadataMaxResUrl);
        }
        
        // Add avatar URL from selected character if available
        if (chubSelectedChar.avatar_url) {
            imageUrls.push(chubSelectedChar.avatar_url);
        }
        
        // Add avatar URL from metadata if available
        if (metadataAvatarUrl) {
            imageUrls.push(metadataAvatarUrl);
        }
        
        // Add standard avatar URLs as fallback
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`);
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/avatar.png`);
        
        // Last resort: chara_card_v2.png (works as an image)
        imageUrls.push(`https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`);
        
        // De-duplicate URLs
        const uniqueUrls = [...new Set(imageUrls)];
        
        debugLog('[ChubDownload] Will try these image URLs:', uniqueUrls);
        
        let imageBuffer = null;
        let needsConversion = false;
        
        for (const url of uniqueUrls) {
            debugLog('[ChubDownload] Trying image URL:', url);
            try {
                let response = await fetch(url);
                if (!response.ok) {
                    const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
                    response = await fetch(proxyUrl);
                }
                
                if (response.ok) {
                    imageBuffer = await response.arrayBuffer();
                    needsConversion = url.endsWith('.webp') || response.headers.get('content-type')?.includes('webp');
                    debugLog('[ChubDownload] Avatar fetched from:', url.split('/').pop(), 'size:', imageBuffer.byteLength, 'needsConversion:', needsConversion);
                    break;
                }
            } catch (e) {
                debugLog('[ChubDownload] Failed to fetch', url, ':', e.message);
            }
        }
        
        if (!imageBuffer) {
            throw new Error('Could not download character avatar from any available URL');
        }
        
        // Convert to PNG if needed (WebP can't hold text chunks)
        let pngBuffer = imageBuffer;
        if (needsConversion) {
            debugLog('[ChubDownload] Converting WebP avatar to PNG...');
            pngBuffer = await convertImageToPng(imageBuffer);
            imageBuffer = null; // Release original buffer — pngBuffer is now the source
        }
        
        debugLog('[ChubDownload] Character card built from API:', {
            name: characterCard.data.name,
            first_mes_length: characterCard.data.first_mes?.length,
            alternate_greetings_count: characterCard.data.alternate_greetings?.length,
            has_character_book: !!characterCard.data.character_book,
            gallery_id: characterCard.data.extensions?.gallery_id
        });
        
        // Embed character card into avatar PNG
        let embeddedPng = embedCharacterDataInPng(pngBuffer, characterCard);
        pngBuffer = null; // Release source buffer after embedding
        
        // Create file for ST import
        const fileName = fullPath.split('/').pop() + '.png';
        // Create File directly from Uint8Array (skip intermediate Blob to avoid double copy)
        let file = new File([embeddedPng], fileName, { type: 'image/png' });
        embeddedPng = null; // Release — data now lives in file
        
        let formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');
        file = null; // FormData now holds the reference
        
        const csrfToken = getCSRFToken();
        
        const importResponse = await fetch('/api/characters/import', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData
        });
        formData = null; // Release — fetch has consumed the body
        
        const responseText = await importResponse.text();
        debugLog('[ChubDownload] Import response:', importResponse.status, responseText);
        
        if (!importResponse.ok) {
            throw new Error(`Import error: ${responseText}`);
        }
        
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
        
        if (result.error) {
            throw new Error('Import failed: Server returned error');
        }
        
        // Close the character modal and free download metadata
        cleanupChubCharModal();
        document.getElementById('chubCharModal').classList.add('hidden');
        // Remove the just-imported entry — it's no longer needed and frees memory
        chubMetadataCache.delete(fullPath);
        
        showToast(`Downloaded "${characterName}" successfully!`, 'success');
        
        // Get the local avatar filename from the import result
        const localAvatarFileName = result.file_name || fileName;
        const assignedGalleryId = characterCard.data.extensions?.gallery_id || null;
        
        const mediaUrls = findCharacterMediaUrls(characterCard);
        const hasGallery = metadataHasGallery;
        const hasMedia = mediaUrls.length > 0;
        
        if ((hasGallery || hasMedia) && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                galleryCharacters: hasGallery ? [{
                    name: characterName,
                    fullPath: fullPath,
                    chubId: metadataId,
                    url: `https://chub.ai/characters/${fullPath}`,
                    avatar: localAvatarFileName,
                    galleryId: assignedGalleryId
                }] : [],
                mediaCharacters: hasMedia ? [{
                    name: characterName,
                    avatar: localAvatarFileName,
                    avatarUrl: `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`,
                    mediaUrls: mediaUrls,
                    galleryId: assignedGalleryId
                }] : []
            });
        }
        
        // === REFRESH + SYNC ===
        // Yield to browser for GC before heavy refresh (critical for mobile memory).
        // 500ms gives mobile browsers enough time to collect the download pipeline garbage
        // (embeddedPng, canvas backing stores, Blob internals, etc.) before allocating
        // the full character list reload.
        await new Promise(r => setTimeout(r, 500));
        await fetchCharacters(true);
        
        // Register gallery folder mappings using actual avatar filenames.
        if (getSetting('uniqueGalleryFolders') && assignedGalleryId) {
            syncAllGalleryFolderOverrides();
            debugLog('[ChubDownload] Synced gallery folder overrides after refresh');
        }
        
        // Also refresh main ST window's character list (fire-and-forget)
        try {
            if (window.opener && !window.opener.closed && window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                const context = window.opener.SillyTavern.getContext();
                if (context && typeof context.getCharacters === 'function') {
                    debugLog('[ChubDownload] Triggering character refresh in main window...');
                    context.getCharacters().catch(e => console.warn('[ChubDownload] Main window refresh failed:', e));
                }
            }
        } catch (e) {
            console.warn('[ChubDownload] Could not access main window:', e);
        }
        
    } catch (e) {
        console.error('[ChubDownload] Download error:', e);
        showToast('Download failed: ' + e.message, 'error');
    } finally {
        downloadBtn.innerHTML = originalHtml;
        downloadBtn.disabled = false;
    }
}

// Initialize ChubAI view when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChubView);
} else {
    initChubView();
}

// ==============================================
// Keyboard Navigation
// ==============================================

document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return;
    }
    
    // Don't intercept if a modal is open
    const charModal = document.getElementById('charModal');
    const chubModal = document.getElementById('chubCharModal');
    if ((charModal && !charModal.classList.contains('hidden')) ||
        (chubModal && !chubModal.classList.contains('hidden'))) {
        // Escape to close modals is handled elsewhere
        return;
    }
    
    const scrollContainer = document.querySelector('.gallery-content');
    if (!scrollContainer) return;
    
    const scrollAmount = scrollContainer.clientHeight * 0.8; // 80% of visible height
    
    switch (e.key) {
        case 'PageDown':
            e.preventDefault();
            scrollContainer.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            break;
        case 'PageUp':
            e.preventDefault();
            scrollContainer.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
            break;
        case 'Home':
            e.preventDefault();
            scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
            break;
        case 'End':
            e.preventDefault();
            scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
            break;
    }
});

// ========================================
// CORE API BRIDGE - DO NOT USE DIRECTLY FROM MODULES
// ========================================
// 
// ARCHITECTURE NOTE:
// These window.* properties are the BRIDGE between library.js (monolith) and CoreAPI.
// 
// ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
// │   library.js    │ --> │ window.* bridge │ <-- │    core-api.js  │ <-- modules
// │   (monolith)    │     │ (this section)  │     │ (abstraction)   │
// └─────────────────┘     └─────────────────┘     └─────────────────┘
//
// MODULES MUST NOT:
// - Import from library.js directly
// - Access window.* properties directly (except through CoreAPI)
// - Use dependencies.* pattern
//
// MODULES MUST:
// - Import from core-api.js for all library functionality
// - Import from shared-styles.js for CSS injection
//
// When adding new functionality for modules:
// 1. Expose the function here on window.*
// 2. Add a wrapper function in core-api.js
// 3. Export it from CoreAPI
// 4. Use CoreAPI.functionName() in modules
//
// This prevents modules from becoming tightly coupled to library.js internals,
// making future refactoring possible without breaking all modules.
// ========================================

// API & Utilities
window.apiRequest = apiRequest;
window.showToast = showToast;
window.escapeHtml = escapeHtml;
window.getCSRFToken = getCSRFToken;
window.sanitizeFolderName = sanitizeFolderName;

// Character Data
window.fetchCharacters = fetchCharacters;
window.getTags = getTags;
window.getAllAvailableTags = getAllAvailableTags;
window.getGalleryFolderName = getGalleryFolderName;
window.getCharacterGalleryInfo = getCharacterGalleryInfo;
window.getCharacterGalleryId = getCharacterGalleryId;
window.removeGalleryFolderOverride = removeGalleryFolderOverride;

// UI / Modals
window.openModal = openModal;
window.closeModal = closeModal;
window.openChubLinkModal = openChubLinkModal;

// Settings
window.getSetting = getSetting;
window.setSetting = setSetting;

// ChubAI Integration
window.fetchChubMetadata = fetchChubMetadata;
window.extractCharacterDataFromPng = extractCharacterDataFromPng;

/**
 * Apply field updates to a character card
 * Used by card-updates module to apply selective field changes
 * @param {string} avatar - Character avatar filename
 * @param {Object} fieldUpdates - Object with field paths as keys (supports dot notation like 'depth_prompt.prompt')
 * @returns {Promise<boolean>} Success status
 */
window.applyCardFieldUpdates = async function(avatar, fieldUpdates) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) {
        console.error('[applyCardFieldUpdates] Character not found:', avatar);
        return false;
    }
    
    try {
        // Build update payload preserving all existing data
        const oldName = char.data?.name || char.name || '';
        const existingExtensions = char.data?.extensions || char.extensions || {};
        const existingCreateDate = char.create_date;
        const existingSpec = char.spec || char.data?.spec;
        const existingSpecVersion = char.spec_version || char.data?.spec_version;
        const existingData = char.data || {};
        
        // Helper to set nested value
        const setNestedValue = (obj, path, value) => {
            const keys = path.split('.');
            const lastKey = keys.pop();
            const target = keys.reduce((o, k) => {
                if (o[k] === undefined) o[k] = {};
                return o[k];
            }, obj);
            target[lastKey] = value;
        };
        
        // Start with existing data
        const updatedData = { ...existingData };
        
        // Apply each field update
        for (const [field, value] of Object.entries(fieldUpdates)) {
            setNestedValue(updatedData, field, value);
        }
        
        // Ensure extensions are preserved
        updatedData.extensions = { ...existingExtensions, ...(updatedData.extensions || {}) };
        
        const payload = {
            avatar: avatar,
            ...(existingSpec && { spec: existingSpec }),
            ...(existingSpecVersion && { spec_version: existingSpecVersion }),
            name: updatedData.name,
            description: updatedData.description,
            first_mes: updatedData.first_mes,
            personality: updatedData.personality,
            scenario: updatedData.scenario,
            mes_example: updatedData.mes_example,
            system_prompt: updatedData.system_prompt,
            post_history_instructions: updatedData.post_history_instructions,
            creator_notes: updatedData.creator_notes,
            creator: updatedData.creator,
            character_version: updatedData.character_version,
            tags: updatedData.tags,
            alternate_greetings: updatedData.alternate_greetings,
            character_book: updatedData.character_book,
            create_date: existingCreateDate,
            data: updatedData
        };
        
        const response = await apiRequest('/characters/merge-attributes', 'POST', payload);
        
        if (response.ok) {
            // Update local data
            const charIndex = allCharacters.findIndex(c => c.avatar === avatar);
            if (charIndex !== -1) {
                // Update the data object
                allCharacters[charIndex].data = updatedData;
                
                // Also update root-level fields for compatibility
                for (const [field, value] of Object.entries(fieldUpdates)) {
                    if (!field.includes('.')) {
                        allCharacters[charIndex][field] = value;
                    }
                }
            }

            const newName = updatedData.name || oldName;
            const nameChanged = oldName && newName && oldName !== newName;
            const galleryId = getCharacterGalleryId(char);
            if (nameChanged && galleryId && getSetting('uniqueGalleryFolders')) {
                await handleGalleryFolderRename(char, oldName, newName, galleryId);
            }
            
            console.log('[applyCardFieldUpdates] Updated', Object.keys(fieldUpdates).length, 'fields for:', avatar);
            return true;
        } else {
            console.error('[applyCardFieldUpdates] API error:', response.status);
            return false;
        }
    } catch (error) {
        console.error('[applyCardFieldUpdates] Error:', error);
        return false;
    }
};

// Expose allCharacters as a getter so CoreAPI always gets current value
Object.defineProperty(window, 'allCharacters', {
    get: () => allCharacters,
    configurable: true
});

// Expose currentCharacters as a getter for filtered/displayed characters
Object.defineProperty(window, 'currentCharacters', {
    get: () => currentCharacters,
    configurable: true
});

// Expose activeChar with getter/setter for CoreAPI (used by openChubLinkModal)
Object.defineProperty(window, 'activeChar', {
    get: () => activeChar,
    set: (char) => { activeChar = char; },
    configurable: true
});
