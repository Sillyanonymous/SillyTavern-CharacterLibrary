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
// SETTINGS PERSISTENCE SYSTEM
// Uses SillyTavern's extensionSettings via main window for server-side storage
// Falls back to localStorage if main window unavailable
// ========================================

const SETTINGS_KEY = 'SillyTavernCharacterGallery';
const DEFAULT_SETTINGS = {
    chubToken: null,
    chubRememberToken: false,
    // Add more settings here as needed
    lastUsedSort: 'name_asc',
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
};

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
 * Load settings from SillyTavern's extension settings (server-side)
 * Falls back to localStorage if ST unavailable
 */
function loadGallerySettings() {
    // Try to load from SillyTavern extension settings first
    const context = getSTContext();
    if (context && context.extensionSettings) {
        if (!context.extensionSettings[SETTINGS_KEY]) {
            // Initialize settings in ST if not present
            context.extensionSettings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
        }
        gallerySettings = { ...DEFAULT_SETTINGS, ...context.extensionSettings[SETTINGS_KEY] };
        console.log('[Settings] Loaded from SillyTavern extensionSettings');
        return;
    }
    
    // Fallback to localStorage
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            gallerySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
            console.log('[Settings] Loaded from localStorage (fallback)');
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
            console.log('[Settings] Saved to SillyTavern extensionSettings');
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
    
    // Appearance
    const highlightColorInput = document.getElementById('settingsHighlightColor');
    
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
        
        // Appearance
        if (highlightColorInput) {
            highlightColorInput.value = getSetting('highlightColor') || DEFAULT_SETTINGS.highlightColor;
        }
        
        settingsModal.classList.remove('hidden');
    };
    
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
    
    // Save settings
    saveSettingsBtn.onclick = () => {
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
        });
        
        // Apply highlight color
        applyHighlightColor(newHighlightColor);
        
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
        defaultSortSelect.value = DEFAULT_SETTINGS.lastUsedSort;
        richCreatorNotesCheckbox.checked = DEFAULT_SETTINGS.richCreatorNotes;
        if (highlightColorInput) {
            highlightColorInput.value = DEFAULT_SETTINGS.highlightColor;
        }
        
        // Apply default highlight color immediately
        applyHighlightColor(DEFAULT_SETTINGS.highlightColor);
        
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
        if (sortSelect) sortSelect.value = DEFAULT_SETTINGS.lastUsedSort;
        
        showToast('Settings restored to defaults', 'success');
    };
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

// Init
document.addEventListener('DOMContentLoaded', async () => {
    // Load settings first to ensure defaults are available
    loadGallerySettings();
    
    // Apply saved highlight color
    applyHighlightColor(getSetting('highlightColor'));
    
    // Reset filters and search on page load
    resetFiltersAndSearch();
    
    await fetchCharacters();
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

    console.log(`Attempting to load character by file: ${avatar}`);

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
             console.log("Found character in main list at index", characterIndex, ":", targetChar);
        }

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
        if (context && typeof context.selectCharacterById === 'function') {
             console.log(`Trying context.selectCharacterById with index ${characterIndex}`);
             try {
                 await withTimeout(context.selectCharacterById(characterIndex), 3000);
                 showToast(`Loading ${charName || avatar}...`, "success");
                 return true;
             } catch (err) {
                 console.warn("selectCharacterById failed or timed out:", err);
                 // Fall through to next method
             }
        }

        // Method 2: context.loadCharacter (Alternative API)
        if (context && typeof context.loadCharacter === 'function') {
             console.log("Trying context.loadCharacter");
             try {
                // Some versions return a promise, some don't.
                await withTimeout(Promise.resolve(context.loadCharacter(avatar)), 3000);
                showToast(`Loading ${charName || avatar}...`, "success");
                return true;
             } catch (err) {
                 console.warn("context.loadCharacter failed:", err);
             }
        }

        // Method 3: Global loadCharacter (Legacy)
        if (typeof window.opener.loadCharacter === 'function') {
            console.log("Trying global loadCharacter");
            try {
                window.opener.loadCharacter(avatar);
                showToast(`Loading (Legacy)...`, "success");
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
                console.log("Loaded via jQuery click (data-file match)");
                charBtn.first().click();
                showToast(`Selected ${charName || avatar}`, "success");
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
              console.log("Falling back to Slash Command (Unique Name)");
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
// forceRefresh: if true, skip window.opener cache and fetch directly from API
async function fetchCharacters(forceRefresh = false) {
    try {
        // Method 1: Try to get data directly from the opener (Main Window)
        // Skip if forceRefresh is requested (e.g., after importing new characters)
        if (!forceRefresh && window.opener && !window.opener.closed) {
            try {
                console.log("Attempting to read characters from window.opener...");
                let openerChars = null;
                if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                    const context = window.opener.SillyTavern.getContext();
                    if (context && context.characters) openerChars = context.characters;
                }
                if (!openerChars && window.opener.characters) openerChars = window.opener.characters;

                if (openerChars && Array.isArray(openerChars)) {
                    console.log(`Loaded ${openerChars.length} characters from main window.`);
                    processAndRender(openerChars);
                    return;
                }
            } catch (err) {
                console.warn("Opener access failed:", err);
            }
        }

        // Method 2: Fallback to API Fetch
        let csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        const headers = { 
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
        };

        // Try standard endpoint
        let url = `${API_BASE}/characters`;
        console.log(`Fetching characters from: ${url}`);

        let response = await fetch(url, {
            method: 'GET', 
            headers: headers
        });
        
        // Fallbacks
        if (response.status === 404 || response.status === 405) {
            console.log("GET failed, trying POST...");
            response = await fetch(url, {
                method: 'POST', 
                headers: headers,
                body: JSON.stringify({}) 
            });
        }

        // Second fallback: try /api/characters/all (some forks/versions)
        if (response.status === 404) {
            console.log("POST failed, trying /api/characters/all...");
            url = `${API_BASE}/characters/all`;
            response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({})
            });
        }
        
        // Third fallback: try GET /api/characters/all
        if (response.status === 404 || response.status === 405) {
             console.log("POST /all failed, trying GET /api/characters/all...");
             response = await fetch(url, {
                 method: 'GET',
                 headers: headers
             });
        }
        
        if (!response.ok) {
            const text = await response.text();
            console.error('API Error:', text);
            throw new Error(`Server returned ${response.status}: ${text}`);
        }

        let data = await response.json();
        console.log('Gallery Data:', data);
        processAndRender(data);

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
    
    // Use performSearch to apply current sort/filter settings instead of rendering unsorted
    performSearch();
    
    document.getElementById('loading').style.display = 'none';
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
        grid.innerHTML = '<div class="empty-state">No characters found</div>';
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
    // Use cached values if available
    let cardWidth = cachedCardWidth || CARD_MIN_WIDTH;
    let cardHeight = cachedCardHeight || Math.round(CARD_MIN_WIDTH / CARD_ASPECT_RATIO);
    
    // Measure from actual card if available
    const firstCard = document.querySelector('.char-card');
    if (firstCard) {
        cachedCardWidth = firstCard.offsetWidth;
        cachedCardHeight = firstCard.offsetHeight;
        cardWidth = cachedCardWidth;
        cardHeight = cachedCardHeight;
    }
    
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
    const fragment = document.createDocumentFragment();
    const sortedIndices = Array.from(neededIndices).sort((a, b) => a - b);
    
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
    
    // Rebuild grid content in correct order
    // This is simpler than trying to insert at correct positions
    const orderedCards = sortedIndices
        .map(i => activeCards.get(i))
        .filter(card => card);
    
    grid.innerHTML = '';
    grid.style.paddingTop = `${paddingTop}px`;
    orderedCards.forEach(card => grid.appendChild(card));
    
    // Preload images further ahead
    const preloadStartRow = Math.floor((scrollTop + clientHeight) / (cardHeight + GRID_GAP));
    const preloadEndRow = Math.ceil((scrollTop + clientHeight + PRELOAD_BUFFER_PX) / (cardHeight + GRID_GAP));
    const preloadStartIndex = preloadStartRow * cols;
    const preloadEndIndex = Math.min(currentCharsList.length, preloadEndRow * cols);
    
    preloadImages(preloadStartIndex, preloadEndIndex);
}

/**
 * Preload avatar images for a range of characters
 */
function preloadImages(startIndex, endIndex) {
    for (let i = startIndex; i < endIndex; i++) {
        const char = currentCharsList[i];
        if (char && char.avatar) {
            const img = new Image();
            img.src = `/characters/${encodeURIComponent(char.avatar)}`;
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
    
    currentScrollHandler = () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                updateVisibleCards(grid, scrollContainer, false);
                isScrolling = false;
            });
            isScrolling = true;
        }
        
        // Debounce for scroll end
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVisibleCards(grid, scrollContainer, true);
        }, 100);
    };
    
    scrollContainer.addEventListener('scroll', currentScrollHandler, { passive: true });
}

// Update grid height on window resize
window.addEventListener('resize', () => {
    cachedCardHeight = 0;
    cachedCardWidth = 0;
    const grid = document.getElementById('characterGrid');
    if (grid && currentCharsList.length > 0) {
        updateGridHeight(grid);
        const scrollContainer = document.querySelector('.gallery-content');
        updateVisibleCards(grid, scrollContainer, true);
    }
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
    
    const name = char.name || "Unknown";
    char.name = name; 
    const avatar = char.avatar; 
    const imgPath = `/characters/${encodeURIComponent(avatar)}`;
    const tags = getTags(char);
    
    const tagHtml = tags.slice(0, 3).map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('');
    
    // Use creator_notes as hover tooltip - extract plain text only
    // For ChubAI imports, this contains the public character description (often with HTML/CSS)
    const creatorNotes = char.data?.creator_notes || char.creator_notes || '';
    const tooltipText = extractPlainText(creatorNotes, 200);
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
    
    card.onclick = () => openModal(char);
    return card;
}

// Modal Logic
const modal = document.getElementById('charModal');
let activeChar = null;

// Fetch User Images for Character
async function fetchCharacterImages(charName) {
    const grid = document.getElementById('spritesGrid');
    grid.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Loading Media...</div>';
    
    // The user's images are stored in /user/images/CharacterName/...
    // We can list files in that directory using the /api/files/list endpoint or similar if it exists.
    // However, SillyTavern usually exposes content listing via directory APIs.
    // Let's try to infer if we can look up the folder directly.
    
    // Path conventions in SillyTavern:
    // data/default-user/user/images/<Name> mapped to /user/images/<Name> in URL
    
    try {
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        console.log(`[Gallery] Fetching media via /api/images/list for folder: ${charName}`);
        
        // Request all media types: IMAGE=1, VIDEO=2, AUDIO=4, so 7 = all
        const response = await fetch(`${API_BASE}/images/list`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ folder: charName, type: 7 })
        });

        if (response.ok) {
            const files = await response.json();
            console.log(`[Gallery] Found ${files.length} images.`);
            renderGalleryImages(files, charName);
        } else {
             console.warn(`[Gallery] Failed to list images: ${response.status}`);
             grid.innerHTML = '<div class="empty-state">No user images found for this character.</div>';
        }
    } catch (e) {
        console.error("Error fetching images:", e);
        grid.innerHTML = '<div class="empty-state">Error loading media.</div>';
    }
}

function renderGalleryImages(files, folderName) {
    const grid = document.getElementById('spritesGrid');
    grid.innerHTML = '';
    // Reset grid class - we'll manage layout with sections inside
    grid.className = 'gallery-media-container';
    
    if (!files || files.length === 0) {
        grid.innerHTML = '<div class="empty-state">No media found.</div>';
        return;
    }

    // Separate images and audio files
    const imageFiles = [];
    const audioFiles = [];
    
    files.forEach(file => {
        const fileName = (typeof file === 'string') ? file : file.name;
        if (!fileName) return;
        
        if (fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i)) {
            imageFiles.push(fileName);
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
    
    // Render images
    if (imageFiles.length > 0) {
        const imagesSection = document.createElement('div');
        imagesSection.className = 'gallery-images-section';
        
        if (audioFiles.length > 0) {
            // Add images section title if we also have audio
            imagesSection.innerHTML = `<div class="gallery-section-title"><i class="fa-solid fa-images"></i> Images (${imageFiles.length})</div>`;
        }
        
        const imagesGrid = document.createElement('div');
        imagesGrid.className = 'gallery-sprites-grid';
        
        imageFiles.forEach(fileName => {
            const imgUrl = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            const imgContainer = document.createElement('div');
            imgContainer.className = 'sprite-item';
            imgContainer.innerHTML = `
                <img src="${imgUrl}" loading="lazy" onclick="window.open(this.src, '_blank')" title="${escapeHtml(fileName)}">
            `;
            imagesGrid.appendChild(imgContainer);
        });
        
        imagesSection.appendChild(imagesGrid);
        grid.appendChild(imagesSection);
    }
    
    // Show empty state if no media at all
    if (imageFiles.length === 0 && audioFiles.length === 0) {
        grid.innerHTML = '<div class="empty-state">No media found.</div>';
    }
}

function openModal(char) {
    activeChar = char;
    // ... existing ... 
    const imgPath = `/characters/${encodeURIComponent(char.avatar)}`;
    
    document.getElementById('modalImage').src = imgPath;
    document.getElementById('modalTitle').innerText = char.name;
    
    // Update favorite button state
    updateFavoriteButtonUI(isCharacterFavorite(char));

    // ... existing date logic ...
    // Dates/Tokens
    // ... (restored previous logic in your mind, but I'll write the essential parts to match existing file structure) ...
    let dateDisplay = 'Unknown';
    if (char.date_added) {
        const d = new Date(Number(char.date_added));
        if (!isNaN(d.getTime())) dateDisplay = d.toLocaleDateString();
    } else if (char.create_date) {
        const d = new Date(char.create_date);
         if (!isNaN(d.getTime())) dateDisplay = d.toLocaleDateString();
         else if (char.create_date.length < 20) dateDisplay = char.create_date;
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

    // Creator Notes - Secure rendering with DOMPurify + sandboxed iframe
    const creatorNotes = char.creator_notes || (char.data ? char.data.creator_notes : "") || "";
    const notesBox = document.getElementById('modalCreatorNotesBox');
    const notesContainer = document.getElementById('modalCreatorNotes');

    if (creatorNotes && notesBox && notesContainer) {
        notesBox.style.display = 'block';
        // Use the shared secure rendering function
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
    } else if (notesBox) {
        notesBox.style.display = 'none';
    }

    // Description/First Message
    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";
    
    // Details tab uses rich HTML rendering
    document.getElementById('modalDescription').innerHTML = formatRichText(desc, char.name);
    document.getElementById('modalFirstMes').innerHTML = formatRichText(firstMes, char.name);

    // Alternate Greetings
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    const altBox = document.getElementById('modalAltGreetingsBox');
    
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
    
    // Embedded Lorebook
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    const lorebookBox = document.getElementById('modalLorebookBox');
    
    if (lorebookBox) {
        if (characterBook && characterBook.entries && characterBook.entries.length > 0) {
            document.getElementById('lorebookEntryCount').innerText = characterBook.entries.length;
            const lorebookHTML = characterBook.entries.map((entry, i) => {
                const keys = entry.keys || entry.key || [];
                const keyStr = Array.isArray(keys) ? keys.join(', ') : keys;
                const content = entry.content || '';
                const name = entry.comment || entry.name || `Entry ${i + 1}`;
                const enabled = entry.enabled !== false;
                
                return `<div class="lorebook-entry" style="margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; border-left: 3px solid ${enabled ? 'var(--accent)' : '#666'};"><div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"><strong style="color: ${enabled ? 'var(--accent)' : '#888'};">${escapeHtml(name.trim())}</strong><span style="font-size: 0.8em; color: ${enabled ? '#8f8' : '#f88'};">${enabled ? '✓ Enabled' : '✗ Disabled'}</span></div><div style="font-size: 0.85em; color: #aaa; margin-bottom: 6px;"><i class="fa-solid fa-key"></i> ${escapeHtml(keyStr) || '(no keys)'}</div><div style="font-size: 0.9em; white-space: pre-wrap; max-height: 100px; overflow-y: auto;">${escapeHtml(content.trim().substring(0, 300))}${content.length > 300 ? '...' : ''}</div></div>`;
            }).join('');
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
    
    // Tags can be array or string
    let tagsValue = "";
    const rawTags = char.tags || (char.data ? char.data.tags : []) || [];
    if (Array.isArray(rawTags)) {
        tagsValue = rawTags.join(", ");
    } else if (typeof rawTags === "string") {
        tagsValue = rawTags;
    }
    
    document.getElementById('editCreator').value = author;
    document.getElementById('editVersion').value = charVersion;
    document.getElementById('editTags').value = tagsValue;
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
        tags: document.getElementById('editTags').value,
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
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('pane-details').classList.add('active');
    
    // Reset scroll positions to top
    document.querySelectorAll('.tab-pane').forEach(p => p.scrollTop = 0);
    const sidebar = document.querySelector('.modal-sidebar');
    if (sidebar) sidebar.scrollTop = 0;

    // Trigger Image Fetch for 'Gallery' tab logic
    // We defer this slightly or just prepare it
    const galleryTabBtn = document.querySelector('.tab-btn[data-tab="gallery"]');
    if (galleryTabBtn) {
        galleryTabBtn.onclick = () => {
             // Switch tabs
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            galleryTabBtn.classList.add('active');
            document.getElementById('pane-gallery').classList.add('active');
            
            // Fetch
            fetchCharacterImages(char.name);
        };
    }
    
    // Chats tab logic
    const chatsTabBtn = document.querySelector('.tab-btn[data-tab="chats"]');
    if (chatsTabBtn) {
        chatsTabBtn.onclick = () => {
            // Switch tabs
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
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
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            relatedTabBtn.classList.add('active');
            document.getElementById('pane-related').classList.add('active');
            
            // Find related characters
            findRelatedCharacters(char);
        };
    }

    // Show modal
    modal.classList.remove('hidden');
    
    // Reset scroll positions after modal is visible (using setTimeout to ensure DOM is ready)
    setTimeout(() => {
        document.querySelectorAll('.tab-pane').forEach(p => p.scrollTop = 0);
        const sidebar = document.querySelector('.modal-sidebar');
        if (sidebar) sidebar.scrollTop = 0;
    }, 0);
}

function closeModal() {
    modal.classList.add('hidden');
    activeChar = null;
    // Reset edit lock state
    isEditLocked = true;
    originalValues = {};
    
    // Check if we need to restore duplicates modal
    if (duplicateModalState.wasOpen) {
        restoreDuplicateModalState();
        duplicateModalState.wasOpen = false; // Reset flag
    }
}

// ==================== RELATED CHARACTERS ====================

/**
 * Extract keywords from text for content-based matching
 * Looks for franchise names, universe keywords, and significant proper nouns
 */
function extractContentKeywords(text) {
    if (!text) return new Set();
    
    // Common franchise/universe indicators to look for
    const franchisePatterns = [
        // Anime/Manga
        /\b(genshin|impact|honkai|star rail|hoyoverse)\b/gi,
        /\b(fate|grand order|fgo|nasuverse|type-moon)\b/gi,
        /\b(naruto|konoha|chakra|shinobi|hokage)\b/gi,
        /\b(one piece|straw hat|devil fruit|pirate king)\b/gi,
        /\b(dragon ball|saiyan|kamehameha|capsule corp)\b/gi,
        /\b(pokemon|pokémon|trainer|gym leader|paldea|kanto)\b/gi,
        /\b(attack on titan|aot|titan shifter|survey corps|marley)\b/gi,
        /\b(jujutsu kaisen|cursed energy|sorcerer)\b/gi,
        /\b(demon slayer|hashira|breathing style)\b/gi,
        /\b(my hero academia|mha|quirk|u\.?a\.? high)\b/gi,
        /\b(hololive|vtuber|nijisanji)\b/gi,
        /\b(touhou|gensokyo|reimu|marisa)\b/gi,
        /\b(persona|phantom thieves|velvet room)\b/gi,
        /\b(final fantasy|ff7|ff14|moogle|chocobo)\b/gi,
        /\b(league of legends|lol|runeterra|summoner)\b/gi,
        /\b(overwatch|talon|overwatch 2)\b/gi,
        /\b(valorant|radiant|radianite)\b/gi,
        /\b(elden ring|tarnished|lands between)\b/gi,
        /\b(dark souls|undead|firelink|chosen undead)\b/gi,
        /\b(zelda|hyrule|triforce|link)\b/gi,
        /\b(resident evil|umbrella|raccoon city|bioweapon)\b/gi,
        /\b(metal gear|solid snake|big boss|foxhound)\b/gi,
        // Western
        /\b(marvel|avengers|x-men|mutant|stark|shield)\b/gi,
        /\b(dc comics|batman|gotham|justice league|krypton)\b/gi,
        /\b(star wars|jedi|sith|force|lightsaber|galactic)\b/gi,
        /\b(star trek|starfleet|federation|vulcan|klingon)\b/gi,
        /\b(harry potter|hogwarts|wizard|muggle|ministry of magic)\b/gi,
        /\b(lord of the rings|lotr|middle.?earth|mordor|hobbit)\b/gi,
        /\b(game of thrones|westeros|iron throne|seven kingdoms)\b/gi,
        /\b(warhammer|40k|imperium|chaos|space marine)\b/gi,
        /\b(dungeons|dragons|d&d|dnd|forgotten realms)\b/gi,
        /\b(fallout|wasteland|vault|brotherhood of steel)\b/gi,
        /\b(cyberpunk|night city|netrunner|arasaka)\b/gi,
        /\b(mass effect|normandy|citadel|reapers|shepard)\b/gi,
        /\b(witcher|geralt|kaer morhen|nilfgaard)\b/gi,
    ];
    
    const keywords = new Set();
    const lowerText = text.toLowerCase();
    
    // Extract franchise keywords
    for (const pattern of franchisePatterns) {
        const matches = text.match(pattern);
        if (matches) {
            matches.forEach(m => keywords.add(m.toLowerCase().trim()));
        }
    }
    
    // Extract capitalized proper nouns (likely character/place names)
    // Match sequences of capitalized words
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (properNouns) {
        properNouns.forEach(noun => {
            // Skip common words and very short names
            const lower = noun.toLowerCase();
            const skipWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'their', 'will', 'would', 'could', 'should', 'have', 'has', 'had', 'been', 'being', 'very', 'just', 'also', 'only', 'some', 'other', 'more', 'most', 'such', 'than', 'then', 'when', 'where', 'which', 'while', 'about', 'after', 'before', 'between', 'under', 'over', 'into', 'through', 'during', 'including', 'until', 'against', 'among', 'throughout', 'despite', 'towards', 'upon', 'concerning']);
            if (noun.length > 3 && !skipWords.has(lower)) {
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
        const avatarPath = `/characters/${encodeURIComponent(char.avatar)}`;
        
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
        if (r.breakdown.creator > 0) pills.push(`<span class="related-pill creator"><i class="fa-solid fa-user-pen"></i> ✓</span>`);
        if (r.breakdown.content > 0) pills.push(`<span class="related-pill content"><i class="fa-solid fa-file-lines"></i> ✓</span>`);
        
        return `
            <div class="related-card" onclick="openRelatedCharacter('${escapeHtml(char.avatar)}')" title="${escapeHtml(r.matchReasons.join('\\n'))}">
                <img class="related-card-avatar" src="${avatarPath}" alt="${escapeHtml(name)}" loading="lazy" 
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2240%22>?</text></svg>'">
                <div class="related-card-info">
                    <div class="related-card-name">${escapeHtml(name)}</div>
                    ${creator ? `<div class="related-card-creator">by ${escapeHtml(creator)}</div>` : ''}
                    <div class="related-card-reasons">${r.matchReasons.slice(0, 2).join(' • ')}</div>
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

function showDeleteConfirmation(char) {
    const charName = char.name || char.data?.name || 'Unknown';
    const avatar = char.avatar || '';
    
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
                    <img src="/characters/${encodeURIComponent(avatar)}" 
                         alt="${escapeHtml(charName)}" 
                         style="width: 100px; height: 100px; object-fit: cover; border-radius: 12px; border: 3px solid rgba(231, 76, 60, 0.5); margin-bottom: 15px;"
                         onerror="this.src='/img/ai4.png'">
                    <h4 style="margin: 0; color: var(--text-primary);">${escapeHtml(charName)}</h4>
                </div>
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
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const avatar = char.avatar || '';
        const charName = getCharField(char, 'name') || avatar;
        
        console.log('[Delete] Starting deletion for:', charName, 'avatar:', avatar);
        
        // Delete character via SillyTavern API
        const response = await fetch('/api/characters/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                avatar_url: avatar,
                delete_chats: deleteChats
            }),
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Delete] API Error:', response.status, errorText);
            showToast('Failed to delete character', 'error');
            return false;
        }
        
        console.log('[Delete] API call successful, triggering ST refresh...');
        
        // CRITICAL: Trigger character refresh in main SillyTavern window
        // This updates ST's in-memory character array and cleans up related data
        try {
            if (window.opener && !window.opener.closed) {
                // Method 1: Use SillyTavern context API if available
                if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                    const context = window.opener.SillyTavern.getContext();
                    if (context && typeof context.getCharacters === 'function') {
                        console.log('[Delete] Triggering getCharacters() in main window...');
                        await context.getCharacters();
                    }
                }
                
                // Method 2: Try to emit the CHARACTER_DELETED event directly
                if (window.opener.eventSource && window.opener.event_types) {
                    console.log('[Delete] Emitting CHARACTER_DELETED event...');
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
                    console.log('[Delete] Calling printCharactersDebounced()...');
                    window.opener.printCharactersDebounced();
                }
            }
        } catch (e) {
            console.warn('[Delete] Could not refresh main window (non-fatal):', e);
        }
        
        console.log('[Delete] Character deleted successfully');
        return true;
        
    } catch (error) {
        console.error('[Delete] Error:', error);
        showToast('Error deleting character', 'error');
        return false;
    }
}

// Collect current edit values
function collectEditValues() {
    const newTagsRaw = document.getElementById('editTags').value;
    const newTags = newTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);
    
    return {
        name: document.getElementById('editName').value,
        description: document.getElementById('editDescription').value,
        first_mes: document.getElementById('editFirstMes').value,
        creator: document.getElementById('editCreator').value,
        character_version: document.getElementById('editVersion').value,
        tags: newTagsRaw,
        tagsArray: newTags,
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
        tags: 'Tags',
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
    // SillyTavern's merge-attributes API expects data in the character card v2 format
    // with fields both at root level (for backwards compat) and under 'data' object
    pendingPayload = {
        avatar: activeChar.avatar,
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
        // Also include under 'data' for proper v2 card format
        data: {
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
    
    try {
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const response = await fetch(`${API_BASE}/characters/merge-attributes`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify(pendingPayload)
        });
        
        if (response.ok) {
            showToast("Character saved successfully!", "success");
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
            
            // Update original values to reflect saved state
            originalValues = collectEditValues();
            
            // Refresh the modal display to show saved changes
            refreshModalDisplay();
            
            // Force re-render the grid to show updated data immediately
            performSearch();
            
            // Close confirmation and lock editing
            document.getElementById('confirmSaveModal').classList.add('hidden');
            setEditLock(true);
            pendingPayload = null;
            
            // Also fetch from server to ensure full sync (in background)
            fetchCharacters();
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
        renderCreatorNotesSecure(creatorNotes, char.name, notesContainer);
    } else if (notesBox) {
        notesBox.style.display = 'none';
    }
    
    // Update Description/First Message
    const desc = char.description || (char.data ? char.data.description : "") || "";
    const firstMes = char.first_mes || (char.data ? char.data.first_mes : "") || "";
    document.getElementById('modalDescription').innerHTML = formatRichText(desc, char.name);
    document.getElementById('modalFirstMes').innerHTML = formatRichText(firstMes, char.name);
    
    // Update Alternate Greetings
    const altGreetings = char.alternate_greetings || (char.data ? char.data.alternate_greetings : []) || [];
    const altBox = document.getElementById('modalAltGreetingsBox');
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
    
    // Update Embedded Lorebook
    const characterBook = char.character_book || (char.data ? char.data.character_book : null);
    const lorebookBox = document.getElementById('modalLorebookBox');
    if (lorebookBox) {
        if (characterBook && characterBook.entries && characterBook.entries.length > 0) {
            document.getElementById('lorebookEntryCount').innerText = characterBook.entries.length;
            const lorebookHTML = characterBook.entries.map((entry, i) => {
                const keys = entry.keys || entry.key || [];
                const keyStr = Array.isArray(keys) ? keys.join(', ') : keys;
                const content = entry.content || '';
                const name = entry.comment || entry.name || `Entry ${i + 1}`;
                const enabled = entry.enabled !== false;
                
                return `<div class="lorebook-entry" style="margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; border-left: 3px solid ${enabled ? 'var(--accent)' : '#666'};"><div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"><strong style="color: ${enabled ? 'var(--accent)' : '#888'};">${escapeHtml(name.trim())}</strong><span style="font-size: 0.8em; color: ${enabled ? '#8f8' : '#f88'};">${enabled ? '✓ Enabled' : '✗ Disabled'}</span></div><div style="font-size: 0.85em; color: #aaa; margin-bottom: 6px;"><i class="fa-solid fa-key"></i> ${escapeHtml(keyStr) || '(no keys)'}</div><div style="font-size: 0.9em; white-space: pre-wrap; max-height: 100px; overflow-y: auto;">${escapeHtml(content.trim().substring(0, 300))}${content.length > 300 ? '...' : ''}</div></div>`;
            }).join('');
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
    document.getElementById('editTags').value = originalValues.tags || '';
    document.getElementById('editPersonality').value = originalValues.personality || '';
    document.getElementById('editScenario').value = originalValues.scenario || '';
    document.getElementById('editMesExample').value = originalValues.mes_example || '';
    document.getElementById('editSystemPrompt').value = originalValues.system_prompt || '';
    document.getElementById('editPostHistoryInstructions').value = originalValues.post_history_instructions || '';
    document.getElementById('editCreatorNotes').value = originalValues.creator_notes || '';
    
    // Restore alternate greetings from raw data
    populateAltGreetingsEditor(originalRawData.altGreetings || []);
    
    // Restore lorebook from raw data
    populateLorebookEditor(originalRawData.characterBook);
    
    // Re-lock
    setEditLock(true);
    showToast("Changes discarded", "info");
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const response = await fetch(`${API_BASE}/characters/merge-attributes`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                avatar: char.avatar,
                fav: newFavStatus,
                data: {
                    extensions: {
                        fav: newFavStatus
                    }
                }
            })
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
 * Get current tags from the editTags input as an array
 */
function getCurrentTagsArray() {
    const input = document.getElementById('editTags');
    if (!input || !input.value.trim()) return [];
    return input.value.split(',').map(t => t.trim()).filter(t => t);
}

/**
 * Set tags in the editTags input from an array
 */
function setTagsFromArray(tagsArray) {
    const input = document.getElementById('editTags');
    if (input) {
        input.value = tagsArray.join(', ');
    }
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
    
    // Clear input
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
        altGreetingsHtml += `
            <div class="expanded-greeting-item" data-index="${idx}">
                <div class="expanded-greeting-header">
                    <span class="expanded-greeting-num">#${idx + 1}</span>
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
            <div class="modal-glass section-expand-modal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-comments"></i> Edit Greetings</h2>
                    <div class="modal-controls">
                        <button id="greetingsModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="greetingsModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body">
                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label"><i class="fa-solid fa-message"></i> First Message</h3>
                        <textarea id="expandedFirstMes" class="glass-input expanded-greeting-textarea first-message" rows="8" placeholder="Opening message from the character...">${escapeHtml(firstMesField.value)}</textarea>
                    </div>
                    
                    <div class="expanded-greeting-section">
                        <h3 class="expanded-section-label">
                            <i class="fa-solid fa-layer-group"></i> Alternate Greetings
                            <button type="button" id="addExpandedGreetingBtn" class="action-btn secondary small" style="margin-left: auto;">
                                <i class="fa-solid fa-plus"></i> Add Greeting
                            </button>
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
    
    // Focus first message textarea
    setTimeout(() => expandedFirstMes.focus(), 50);
    
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
                    <span class="expanded-greeting-num">#${idx + 1}</span>
                    <button type="button" class="expanded-greeting-delete" title="Delete this greeting">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <textarea class="glass-input expanded-greeting-textarea" rows="6" placeholder="Alternate greeting message..."></textarea>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', newGreetingHtml);
        
        // Add delete handler to new item
        const newItem = container.lastElementChild;
        setupGreetingDeleteHandler(newItem);
        
        // Focus the new textarea
        const newTextarea = newItem.querySelector('textarea');
        newTextarea.focus();
    };
    
    // Setup delete handlers for existing items
    function setupGreetingDeleteHandler(item) {
        const deleteBtn = item.querySelector('.expanded-greeting-delete');
        deleteBtn.onclick = () => {
            item.remove();
            renumberExpandedGreetings();
        };
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
    
    // Setup delete handlers for initial items
    modal.querySelectorAll('.expanded-greeting-item').forEach(setupGreetingDeleteHandler);
    
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
            <div class="modal-glass section-expand-modal lorebook-expand-modal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-book"></i> Edit Lorebook</h2>
                    <div class="modal-controls">
                        <button id="lorebookModalSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply All</button>
                        <button class="close-btn" id="lorebookModalClose">&times;</button>
                    </div>
                </div>
                <div class="section-expand-body">
                    <div class="expanded-lorebook-header">
                        <span id="expandedLorebookCount">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
                        <button type="button" id="addExpandedLorebookEntryBtn" class="action-btn secondary small">
                            <i class="fa-solid fa-plus"></i> Add Entry
                        </button>
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
    return `
        <div class="expanded-lorebook-entry${entry.enabled ? '' : ' disabled'}" data-index="${idx}">
            <div class="expanded-lorebook-entry-header">
                <input type="text" class="glass-input expanded-lorebook-name" placeholder="Entry name/comment" value="${escapeHtml(entry.name)}">
                <div class="expanded-lorebook-entry-controls">
                    <label class="expanded-lorebook-toggle ${entry.enabled ? 'enabled' : 'disabled'}" title="Toggle enabled">
                        <input type="checkbox" class="expanded-lorebook-enabled" ${entry.enabled ? 'checked' : ''} style="display: none;">
                        ${entry.enabled ? '✓ On' : '✗ Off'}
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
    // Toggle enabled handler
    const toggleLabel = entryEl.querySelector('.expanded-lorebook-toggle');
    const enabledCheckbox = entryEl.querySelector('.expanded-lorebook-enabled');
    
    toggleLabel.onclick = () => {
        const isEnabled = enabledCheckbox.checked;
        enabledCheckbox.checked = !isEnabled;
        toggleLabel.className = `expanded-lorebook-toggle ${!isEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="expanded-lorebook-enabled" ${!isEnabled ? 'checked' : ''} style="display: none;">${!isEnabled ? '✓ On' : '✗ Off'}`;
        entryEl.classList.toggle('disabled', isEnabled);
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
    
    // Create expand modal
    const expandModalHtml = `
        <div id="expandFieldModal" class="modal-overlay">
            <div class="modal-glass expand-field-modal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-expand"></i> ${escapeHtml(fieldLabel)}</h2>
                    <div class="modal-controls">
                        <button id="expandFieldSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="close-btn" id="expandFieldClose">&times;</button>
                    </div>
                </div>
                <div class="expand-field-body">
                    <textarea id="expandFieldTextarea" class="glass-input expand-field-textarea" placeholder="Enter ${escapeHtml(fieldLabel.toLowerCase())}...">${escapeHtml(currentValue)}</textarea>
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
        originalField.value = newValue;
        
        // Trigger input event so any listeners know the value changed
        originalField.dispatchEvent(new Event('input', { bubbles: true }));
        
        closeExpandModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Changes applied to field', 'success');
    };
}

/**
 * Open expanded editor modal for a textarea element (for dynamically created fields like lorebook)
 */
function openExpandedFieldEditorForElement(textareaElement, fieldLabel) {
    if (!textareaElement) {
        showToast('Field not found', 'error');
        return;
    }
    
    const currentValue = textareaElement.value;
    
    // Create expand modal
    const expandModalHtml = `
        <div id="expandFieldModal" class="modal-overlay">
            <div class="modal-glass expand-field-modal">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-expand"></i> ${escapeHtml(fieldLabel)}</h2>
                    <div class="modal-controls">
                        <button id="expandFieldSave" class="action-btn primary"><i class="fa-solid fa-check"></i> Apply</button>
                        <button class="close-btn" id="expandFieldClose">&times;</button>
                    </div>
                </div>
                <div class="expand-field-body">
                    <textarea id="expandFieldTextarea" class="glass-input expand-field-textarea" placeholder="Enter content...">${escapeHtml(currentValue)}</textarea>
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
        textareaElement.value = newValue;
        
        // Trigger input event so any listeners know the value changed
        textareaElement.dispatchEvent(new Event('input', { bubbles: true }));
        
        closeExpandModal();
        document.removeEventListener('keydown', handleKeydown);
        showToast('Changes applied to field', 'success');
    };
}

// Chats Functions
async function fetchCharacterChats(char) {
    const chatsList = document.getElementById('chatsList');
    if (!chatsList) return;
    
    chatsList.innerHTML = '<div class="chats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats...</div>';
    
    try {
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const response = await fetch(`${API_BASE}/characters/chats`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ avatar_url: char.avatar, metadata: true })
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
        document.getElementById('chatPreviewModal')?.classList.add('hidden');
        document.querySelector('.modal-overlay')?.classList.add('hidden');
        
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const response = await fetch(`${API_BASE}/chats/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                chatfile: chatFile,
                avatar_url: char.avatar
            })
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
    
    // Check for favorite: prefix (favorite:yes, favorite:no, fav:yes, fav:no)
    const favoriteMatch = rawQuery.match(/^(?:favorite|fav):(yes|no|true|false)$/i);
    const favoriteFilter = favoriteMatch ? favoriteMatch[1].toLowerCase() : null;
    const filterFavoriteYes = favoriteFilter === 'yes' || favoriteFilter === 'true';
    const filterFavoriteNo = favoriteFilter === 'no' || favoriteFilter === 'false';
    
    // Clean query: remove special prefixes
    let query = rawQuery.toLowerCase();
    if (creatorFilter) query = '';
    if (favoriteFilter !== null) query = '';

    const filtered = allCharacters.filter(c => {
        let matchesSearch = false;
        
        // Special creator: filter - exact creator match only
        if (creatorFilter) {
            const author = (c.creator || (c.data ? c.data.creator : "") || "").toLowerCase();
            return author === creatorFilter || author.includes(creatorFilter);
        }
        
        // Special favorite: filter from search bar
        if (favoriteFilter !== null) {
            const isFav = isCharacterFavorite(c);
            if (filterFavoriteYes && !isFav) return false;
            if (filterFavoriteNo && isFav) return false;
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
        if (sortType === 'date_new') return (b.date_added || 0) - (a.date_added || 0); 
        if (sortType === 'date_old') return (a.date_added || 0) - (b.date_added || 0);
        return 0;
    });
    
    renderGrid(sorted);
}

/**
 * Filter local cards view by creator name
 * Sets the search to "creator:Name" and ensures Author filter is checked
 */
function filterLocalByCreator(creatorName) {
    console.log('[Gallery] Filtering local by creator:', creatorName);
    
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

// Event Listeners
function setupEventListeners() {
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', performSearch);

    // Filter Checkboxes
    ['searchName', 'searchTags', 'searchAuthor', 'searchNotes'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('change', performSearch);
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

    // Sort - updates currentCharacters to keep filter/sort state in sync
    const sortSelect = document.getElementById('sortSelect');
    sortSelect.addEventListener('change', (e) => {
        const type = e.target.value;
        currentCharacters.sort((a, b) => {
            if (type === 'name_asc') return a.name.localeCompare(b.name);
            if (type === 'name_desc') return b.name.localeCompare(a.name);
            if (type === 'date_new') return (b.date_added || 0) - (a.date_added || 0); 
            if (type === 'date_old') return (a.date_added || 0) - (b.date_added || 0);
            return 0;
        });
        renderGrid(currentCharacters);
    });
    
    // Favorites Filter Toggle
    const favoritesFilterBtn = document.getElementById('favoritesFilterBtn');
    if (favoritesFilterBtn) {
        favoritesFilterBtn.addEventListener('click', toggleFavoritesFilter);
    }
    
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
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        // Don't reset filters - just refresh the data
        document.getElementById('characterGrid').innerHTML = '';
        document.getElementById('loading').style.display = 'block';
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
    document.getElementById('modalClose').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            const pane = document.getElementById(`pane-${tabId}`);
            pane.classList.add('active');
            
            // Reset scroll position when switching tabs
            pane.scrollTop = 0;
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
        const value = input.value.trim();
        if (value) {
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
                    ${enabled ? '✓ On' : '✗ Off'}
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
    const enabledCheckbox = wrapper.querySelector('.lorebook-enabled-checkbox');
    toggleLabel.addEventListener('click', () => {
        const isEnabled = enabledCheckbox.checked;
        enabledCheckbox.checked = !isEnabled;
        toggleLabel.className = `lorebook-entry-toggle ${!isEnabled ? 'enabled' : 'disabled'}`;
        toggleLabel.innerHTML = `<input type="checkbox" class="lorebook-enabled-checkbox" ${!isEnabled ? 'checked' : ''} style="display: none;">${!isEnabled ? '✓ On' : '✗ Off'}`;
        wrapper.classList.toggle('disabled', isEnabled);
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

// Utils
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
 * Encode a path that may contain slashes (like character names with "/" in them)
 * Encodes each path segment separately to preserve the path structure
 * @param {string} path - Path that may contain forward slashes
 * @returns {string} URL-safe path with each segment encoded
 */
function encodePathSegments(path) {
    if (!path) return '';
    // Split by /, encode each segment, rejoin with /
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
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
                if (!src.match(/^https?:\/\//i)) return match;
                const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
                return `<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`;
            });
            
            // Replace {{user}} and {{char}} placeholders (safe)
            processedText = processedText.replace(/\{\{user\}\}/gi, '<span class="placeholder-user">{{user}}</span>');
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
            if (!imgSrc.match(/^https?:\/\//i)) return match;
            const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
            const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
            return `<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`;
        });
        
        // Convert standalone markdown images: ![alt](url) or ![alt](url =WxH) or ![alt](url "title")
        processedText = processedText.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s*=[^)]*)?(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
            if (!src.match(/^https?:\/\//i)) return match;
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
            
            // Italic: *text* or _text_ (careful not to match inside URLs or HTML)
            processedText = processedText.replace(/(?<![\\w*/"=])\*([^*\n]+?)\*(?![\\w*])/g, '<em>$1</em>');
            processedText = processedText.replace(/(?<![\\w_/"=])_([^_\n]+?)_(?![\\w_])/g, '<em>$1</em>');
            
            // Strikethrough: ~~text~~
            processedText = processedText.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
        }
        
        // Replace {{user}} and {{char}} placeholders
        processedText = processedText.replace(/\{\{user\}\}/gi, '<span class="placeholder-user">{{user}}</span>');
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
    
    // 1. Preserve existing HTML img tags (only allow http/https src)
    processedText = processedText.replace(/<img\s+[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*\/?>/gi, (match, src) => {
        return addPlaceholder(`<img src="${src}" class="embedded-image" loading="lazy">`);
    });
    
    // 2. Convert linked images: [![alt](img-url)](link-url)
    processedText = processedText.replace(/\[\!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (match, alt, imgSrc, linkHref) => {
        if (!imgSrc.match(/^https?:\/\//i)) return match; // Only allow http/https
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        const safeLink = linkHref.match(/^https?:\/\//i) ? linkHref : '#';
        return addPlaceholder(`<a href="${safeLink}" target="_blank" rel="noopener"><img src="${imgSrc}"${altAttr} class="embedded-image" loading="lazy"></a>`);
    });
    
    // 3. Convert standalone markdown images: ![alt](url) or ![alt](url "title")
    processedText = processedText.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, src) => {
        if (!src.match(/^https?:\/\//i)) return match; // Only allow http/https
        const altAttr = alt ? ` alt="${alt.replace(/"/g, '&quot;')}"` : '';
        return addPlaceholder(`<img src="${src}"${altAttr} class="embedded-image" loading="lazy">`);
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
    formatted = formatted.replace(/\{\{user\}\}/gi, '<span class="placeholder-user">{{user}}</span>');
    formatted = formatted.replace(/\{\{char\}\}/gi, `<span class="placeholder-char">${charName || '{{char}}'}</span>`);
    
    // Convert markdown-style formatting
    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    // Italic: *text* or _text_ (but not inside words)
    formatted = formatted.replace(/(?<![\w*])\*([^*]+?)\*(?![\w*])/g, '<em>$1</em>');
    formatted = formatted.replace(/(?<![\w_])_([^_]+?)_(?![\w_])/g, '<em>$1</em>');
    
    // Quoted text: "text"
    formatted = formatted.replace(/&quot;(.+?)&quot;/g, '<span class="quoted-text">"$1"</span>');
    
    // Convert line breaks - use paragraph breaks for double newlines, single <br> for single
    formatted = formatted.replace(/\n\n+/g, '</p><p>');  // Double+ newlines become paragraph breaks
    formatted = formatted.replace(/\n/g, '<br>');        // Single newlines become line breaks
    formatted = '<p>' + formatted + '</p>';              // Wrap in paragraphs
    formatted = formatted.replace(/<p><\/p>/g, '');      // Remove empty paragraphs
    
    return formatted;
}

/* Upload Helpers */
const toBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = error => reject(error);
});

async function uploadImages(files) {
    if (!activeChar) {
        console.warn('[Gallery] No active character for image upload');
        showToast('No character selected', 'error');
        return;
    }
    
    const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
    let uploadedCount = 0;
    let errorCount = 0;
    
    console.log(`[Gallery] Uploading ${files.length} file(s) to character: ${activeChar.name}`);
    
    for (let file of files) {
        if (!file.type.startsWith('image/')) {
            console.warn(`[Gallery] Skipping non-image file: ${file.name}`);
            continue;
        }
        
        try {
            const base64 = await toBase64(file);
            const nameOnly = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
            const ext = file.name.includes('.') ? file.name.split('.').pop() : 'png';

            console.log(`[Gallery] Uploading: ${nameOnly}.${ext}`);
            
            const res = await fetch('/api/images/upload', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    image: base64,
                    filename: nameOnly,
                    format: ext,
                    ch_name: activeChar.name
                })
            });
            
            if (res.ok) {
                uploadedCount++;
                console.log(`[Gallery] Upload success: ${nameOnly}`);
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
        // Refresh the gallery
        fetchCharacterImages(activeChar.name);
    } else if (errorCount > 0) {
        showToast(`Upload failed for ${errorCount} image(s)`, 'error');
    }
}

// ==================== CHARACTER IMPORTER ====================

const importModal = document.getElementById('importModal');
const importBtn = document.getElementById('importBtn');
const closeImportModal = document.getElementById('closeImportModal');
const cancelImportBtn = document.getElementById('cancelImportBtn');
const startImportBtn = document.getElementById('startImportBtn');
const importUrlsInput = document.getElementById('importUrlsInput');
const importProgress = document.getElementById('importProgress');
const importProgressCount = document.getElementById('importProgressCount');
const importProgressFill = document.getElementById('importProgressFill');
const importLog = document.getElementById('importLog');

let isImporting = false;

// Open/close import modal
importBtn?.addEventListener('click', () => {
    importModal.classList.remove('hidden');
    importUrlsInput.value = '';
    importProgress.classList.add('hidden');
    importLog.innerHTML = '';
    startImportBtn.disabled = false;
    startImportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
});

closeImportModal?.addEventListener('click', () => {
    if (!isImporting) {
        importModal.classList.add('hidden');
    }
});

cancelImportBtn?.addEventListener('click', () => {
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

// Fetch character metadata from Chub API
async function fetchChubMetadata(fullPath) {
    try {
        const url = `https://api.chub.ai/api/characters/${fullPath}?full=true`;
        console.log('[Chub] Fetching metadata from:', url);
        
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
            console.warn('[Chub] Metadata fetch failed:', response.status);
            return null;
        }
        const data = await response.json();
        
        // Debug logging
        if (data.node) {
            console.log('[Chub] Metadata received:', {
                name: data.node.name,
                hasDefinition: !!data.node.definition,
                first_message_length: data.node.definition?.first_message?.length,
                alternate_greetings_count: data.node.definition?.alternate_greetings?.length,
                personality_length: data.node.definition?.personality?.length
            });
        }
        
        return data.node || null;
    } catch (error) {
        console.warn(`[Chub] Could not fetch metadata for ${fullPath}:`, error);
        return null;
    }
}

// Convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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
    
    // Parse all chunks, removing any existing 'tEXt' chunks with 'chara' keyword
    const chunks = [];
    let pos = 8;
    
    while (pos < bytes.length) {
        const view = new DataView(bytes.buffer, pos);
        const length = view.getUint32(0, false);
        const typeBytes = bytes.slice(pos + 4, pos + 8);
        const type = String.fromCharCode(...typeBytes);
        const chunkEnd = pos + 12 + length;
        
        // Check if this is a tEXt chunk with 'chara' keyword - skip it
        let skipChunk = false;
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
            // Check keyword (null-terminated string at start of data)
            const dataStart = pos + 8;
            let keyword = '';
            for (let i = dataStart; i < dataStart + Math.min(20, length); i++) {
                if (bytes[i] === 0) break;
                keyword += String.fromCharCode(bytes[i]);
            }
            if (keyword === 'chara') {
                console.log(`[PNG] Removing existing '${type}' chunk with 'chara' keyword`);
                skipChunk = true;
            }
        }
        
        if (!skipChunk) {
            chunks.push({
                type: type,
                data: bytes.slice(pos, chunkEnd)
            });
        }
        
        pos = chunkEnd;
    }
    
    // Find IEND chunk index
    const iendIndex = chunks.findIndex(c => c.type === 'IEND');
    if (iendIndex === -1) {
        throw new Error('Invalid PNG: IEND chunk not found');
    }
    
    // Create the tEXt chunk with base64-encoded character data
    const jsonString = JSON.stringify(characterJson);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
    const textChunk = createTextChunk('chara', base64Data);
    
    console.log(`[PNG] Adding new chara chunk: JSON=${jsonString.length} chars, base64=${base64Data.length} chars`);
    
    // Calculate total size
    let totalSize = 8; // PNG signature
    for (let i = 0; i < chunks.length; i++) {
        if (i === iendIndex) {
            totalSize += textChunk.length; // Insert before IEND
        }
        totalSize += chunks[i].data.length;
    }
    
    // Build the new PNG
    const result = new Uint8Array(totalSize);
    result.set(bytes.slice(0, 8), 0); // PNG signature
    
    let offset = 8;
    for (let i = 0; i < chunks.length; i++) {
        if (i === iendIndex) {
            result.set(textChunk, offset);
            offset += textChunk.length;
        }
        result.set(chunks[i].data, offset);
        offset += chunks[i].data.length;
    }
    
    return result;
}

// Build character card V2 spec from Chub API data
function buildCharacterCardFromChub(apiData) {
    const def = apiData.definition || {};
    
    // Build V2 spec character card
    const characterCard = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || apiData.name || 'Unknown',
            description: def.personality || '',
            personality: '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            creator_notes: def.description || apiData.description || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            alternate_greetings: def.alternate_greetings || [],
            tags: apiData.topics || [],
            creator: apiData.fullPath?.split('/')[0] || '',
            character_version: '',
            extensions: def.extensions || {},
        }
    };
    
    // Handle embedded lorebook if present
    if (def.embedded_lorebook) {
        characterCard.data.character_book = def.embedded_lorebook;
    }
    
    return characterCard;
}

// Import a single character from Chub
async function importChubCharacter(fullPath) {
    // Avatar image URL (just the image, not the full card)
    const avatarUrl = `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`;
    // Fallback to PNG card URL
    const pngUrl = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
    
    try {
        // Fetch complete character data from the API
        const metadata = await fetchChubMetadata(fullPath);
        
        if (!metadata || !metadata.definition) {
            throw new Error('Could not fetch character data from API');
        }
        
        const hasGallery = metadata.hasGallery || false;
        const characterName = metadata.definition?.name || metadata.name || fullPath.split('/').pop();
        
        // Build the character card JSON from API data
        const characterCard = buildCharacterCardFromChub(metadata);
        
        console.log('[Chub Import] Character card built:', {
            name: characterCard.data.name,
            first_mes_length: characterCard.data.first_mes?.length,
            alternate_greetings_count: characterCard.data.alternate_greetings?.length,
            description_length: characterCard.data.description?.length,
            full_card: characterCard
        });
        
        // Verify the data before embedding
        if (!characterCard.data.first_mes || characterCard.data.first_mes.length < 100) {
            console.warn('[Chub Import] WARNING: first_mes seems too short:', characterCard.data.first_mes?.length);
        }
        
        // Fetch the PNG image
        const response = await fetch(pngUrl);
        
        if (!response.ok) {
            throw new Error(`Image download failed: ${response.status}`);
        }
        
        // Get the PNG as ArrayBuffer
        const pngBuffer = await response.arrayBuffer();
        
        // Embed character data into PNG
        const embeddedPng = embedCharacterDataInPng(pngBuffer, characterCard);
        
        console.log('[Chub Import] PNG embedded, size:', embeddedPng.length, 'bytes');
        
        // Create a Blob and File from the embedded PNG
        const blob = new Blob([embeddedPng], { type: 'image/png' });
        const fileName = fullPath.split('/').pop() + '.png';
        const file = new File([blob], fileName, { type: 'image/png' });
        
        // Create FormData for SillyTavern import
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');
        
        // Get CSRF token
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        // Import to SillyTavern
        const importResponse = await fetch('/api/characters/import', {
            method: 'POST',
            headers: {
                'X-CSRF-Token': csrfToken
            },
            body: formData
        });
        
        const responseText = await importResponse.text();
        console.log('Import response:', importResponse.status, responseText);
        
        if (!importResponse.ok) {
            throw new Error(`Import error: ${responseText}`);
        }
        
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
        
        // Check for error in response body
        if (result.error) {
            throw new Error('Import failed: Server returned error');
        }
        
        return { 
            success: true, 
            fileName: result.file_name || fileName,
            hasGallery: hasGallery,
            characterName: characterName,
            fullPath: fullPath
        };
        
    } catch (error) {
        console.error(`Failed to import ${fullPath}:`, error);
        return { success: false, error: error.message };
    }
}

// Add log entry
function addImportLogEntry(message, status = 'pending') {
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        pending: 'fa-spinner fa-spin'
    };
    
    const entry = document.createElement('div');
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${icons[status]}"></i>${escapeHtml(message)}`;
    importLog.appendChild(entry);
    importLog.scrollTop = importLog.scrollHeight;
    return entry;
}

// Update log entry status
function updateLogEntry(entry, message, status) {
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        pending: 'fa-spinner fa-spin'
    };
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${icons[status]}"></i>${escapeHtml(message)}`;
}

// Start import process
startImportBtn?.addEventListener('click', async () => {
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
    
    // Start importing
    isImporting = true;
    startImportBtn.disabled = true;
    startImportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
    cancelImportBtn.disabled = true;
    importUrlsInput.disabled = true;
    
    importProgress.classList.remove('hidden');
    importLog.innerHTML = '';
    importProgressFill.style.width = '0%';
    importProgressCount.textContent = `0/${validUrls.length}`;
    
    let successCount = 0;
    let errorCount = 0;
    const charactersWithGallery = [];
    
    for (let i = 0; i < validUrls.length; i++) {
        const { url, fullPath } = validUrls[i];
        const displayName = fullPath.split('/').pop();
        
        const logEntry = addImportLogEntry(`Importing ${displayName}...`, 'pending');
        
        const result = await importChubCharacter(fullPath);
        
        if (result.success) {
            successCount++;
            updateLogEntry(logEntry, `${displayName} imported successfully`, 'success');
            
            // Track characters with galleries
            if (result.hasGallery) {
                charactersWithGallery.push({
                    name: result.characterName,
                    fullPath: result.fullPath,
                    url: `https://chub.ai/characters/${result.fullPath}`
                });
            }
        } else {
            errorCount++;
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
    startImportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    cancelImportBtn.disabled = false;
    importUrlsInput.disabled = false;
    
    // Show summary toast
    if (successCount > 0) {
        showToast(`Imported ${successCount} character${successCount > 1 ? 's' : ''}${errorCount > 0 ? ` (${errorCount} failed)` : ''}`, 'success');
        
        // Try to refresh the main SillyTavern window's character list
        try {
            if (window.opener && !window.opener.closed && window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                const context = window.opener.SillyTavern.getContext();
                if (context && typeof context.getCharacters === 'function') {
                    console.log('Triggering character refresh in main window...');
                    await context.getCharacters();
                }
            }
        } catch (e) {
            console.warn('Could not refresh main window characters:', e);
        }
        
        // Refresh the gallery (force API fetch since we just imported)
        fetchCharacters(true);
        
        // Show gallery info modal if any characters have galleries
        if (charactersWithGallery.length > 0) {
            showChubGalleryModal(charactersWithGallery);
        }
    } else {
        showToast(`Import failed: ${errorCount} error${errorCount > 1 ? 's' : ''}`, 'error');
    }
});

// ==============================================
// Chub Gallery Info Feature
// ==============================================

/**
 * Show modal with information about characters that have galleries on Chub
 */
function showChubGalleryModal(characters) {
    const modal = document.getElementById('chubGalleryModal');
    const list = document.getElementById('chubGalleryList');
    
    if (!modal || !list) return;
    
    list.innerHTML = '';
    
    characters.forEach(char => {
        // Support both {name, fullPath, url} and {characterName, fullPath} formats
        const charName = char.name || char.characterName || 'Unknown';
        const charFullPath = char.fullPath || '';
        const charUrl = char.url || (charFullPath ? `https://chub.ai/characters/${charFullPath}` : '');
        
        // Extract creator from fullPath (format: "creator/character-name")
        const creatorName = charFullPath.split('/')[0] || '';
        
        // Avatar URL
        const avatarUrl = charFullPath ? `https://avatars.charhub.io/avatars/${charFullPath}/avatar.webp` : '';
        
        const item = document.createElement('div');
        item.className = 'chub-gallery-item';
        item.innerHTML = `
            ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(charName)}" class="chub-gallery-item-avatar" onerror="this.style.display='none'">` : ''}
            <div class="chub-gallery-item-info">
                <span class="chub-gallery-item-name">${escapeHtml(charName)}</span>
                ${creatorName ? `<span class="chub-gallery-item-creator">by ${escapeHtml(creatorName)}</span>` : ''}
            </div>
            <a href="${charUrl}" target="_blank" rel="noopener noreferrer" class="action-btn secondary chub-gallery-link">
                <i class="fa-solid fa-external-link-alt"></i> View Gallery
            </a>
        `;
        list.appendChild(item);
    });
    
    modal.classList.remove('hidden');
}

// Chub Gallery Modal Event Listeners
document.getElementById('closeChubGalleryModal')?.addEventListener('click', () => {
    document.getElementById('chubGalleryModal').classList.add('hidden');
});

document.getElementById('closeChubGalleryBtn')?.addEventListener('click', () => {
    document.getElementById('chubGalleryModal').classList.add('hidden');
});

// ==============================================
// Media Localization Feature
// ==============================================

/**
 * Extract image/media URLs from text content
 */
function extractMediaUrls(text) {
    if (!text) return [];
    
    const urls = [];
    
    // Match ![](url) markdown format
    const markdownPattern = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;
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
    
    // Match raw URLs for media files
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg))/gi;
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
    
    console.log(`[Localize] Found ${mediaUrls.size} remote media URLs in character`);
    return Array.from(mediaUrls);
}

/**
 * Get hashes of all existing files in a character's gallery
 */
async function getExistingFileHashes(characterName) {
    const hashes = new Set();
    const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
    
    try {
        // Request all media types: IMAGE=1, VIDEO=2, AUDIO=4, so 7 = all
        const response = await fetch(`${API_BASE}/images/list`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ folder: characterName, type: 7 })
        });
        
        if (!response.ok) {
            console.log('[Localize] Could not list existing files');
            return hashes;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            return hashes;
        }
        
        // Sanitize folder name to match SillyTavern's folder naming convention
        const safeFolderName = sanitizeFolderName(characterName);
        
        // Calculate hash for each existing file
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            // Only check media files
            if (!fileName.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|mp4|webm)$/i)) continue;
            
            const fileUrl = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            
            try {
                const fileResponse = await fetch(fileUrl);
                if (fileResponse.ok) {
                    const buffer = await fileResponse.arrayBuffer();
                    const hash = await calculateHash(buffer);
                    hashes.add(hash);
                }
            } catch (e) {
                console.warn(`[Localize] Could not hash existing file: ${fileName}`);
            }
        }
        
        return hashes;
    } catch (error) {
        console.error('[Localize] Error getting existing file hashes:', error);
        return hashes;
    }
}

/**
 * Download a media file to memory (ArrayBuffer) without saving
 */
async function downloadMediaToMemory(url) {
    try {
        let response;
        let usedProxy = false;
        
        // Try direct fetch first
        try {
            response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            usedProxy = true;
            const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
            response = await fetch(proxyUrl);
            
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
        
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || '';
        
        return {
            success: true,
            arrayBuffer: arrayBuffer,
            contentType: contentType,
            usedProxy: usedProxy
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
 */
async function saveMediaFromMemory(downloadResult, url, characterName, index) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        const blob = new Blob([arrayBuffer], { type: contentType });
        
        // Determine file extension
        let extension = 'png'; // Default
        if (contentType) {
            const mimeToExt = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'image/bmp': 'bmp',
                'image/svg+xml': 'svg',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov',
                'audio/mpeg': 'mp3',
                'audio/wav': 'wav',
                'audio/ogg': 'ogg'
            };
            extension = mimeToExt[contentType] || extension;
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
        
        // Convert blob to base64
        const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result;
                const base64 = result.includes(',') ? result.split(',')[1] : result;
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        
        // Get CSRF token
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        // Save file
        const saveResponse = await fetch('/api/images/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                image: base64Data,
                filename: filenameBase,
                format: extension,
                ch_name: characterName
            })
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

/**
 * Download a media file and save it to character's gallery
 * Tries direct fetch first, falls back to CORS proxy if blocked
 */
async function downloadAndSaveMedia(url, characterName, index) {
    try {
        console.log(`[Localize] Downloading: ${url}`);
        
        let response;
        let usedProxy = false;
        
        // Try direct fetch first
        try {
            response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (directError) {
            // Direct fetch failed (likely CORS), try proxy
            console.log(`[Localize] Direct fetch failed, trying CORS proxy...`);
            usedProxy = true;
            
            const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
            response = await fetch(proxyUrl);
            
            if (!response.ok) {
                // Check if proxy is disabled
                if (response.status === 404) {
                    const text = await response.text();
                    if (text.includes('CORS proxy is disabled')) {
                        throw new Error('CORS blocked and proxy is disabled. Enable corsProxy in config.yaml');
                    }
                }
                throw new Error(`Proxy HTTP ${response.status}: ${response.statusText}`);
            }
        }
        
        if (usedProxy) {
            console.log(`[Localize] Successfully fetched via proxy`);
        }
        
        const blob = await response.blob();
        
        // Determine file extension from blob type or URL
        let extension = 'jpg';
        if (blob.type) {
            const mimeToExt = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/jpg': 'jpg',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'image/svg+xml': 'svg',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov',
                'audio/mpeg': 'mp3',
                'audio/wav': 'wav',
                'audio/ogg': 'ogg'
            };
            extension = mimeToExt[blob.type] || extension;
        } else {
            // Fallback to URL extension
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
        
        // Convert blob to base64
        const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result;
                const base64 = result.includes(',') ? result.split(',')[1] : result;
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        
        // Get CSRF token
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        // Save file using SillyTavern's /api/images/upload endpoint
        console.log(`[Localize] Saving: ${filenameBase}.${extension}`);
        const saveResponse = await fetch('/api/images/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                image: base64Data,
                filename: filenameBase,
                format: extension,
                ch_name: characterName
            })
        });
        
        if (!saveResponse.ok) {
            const errorText = await saveResponse.text();
            throw new Error(`Upload failed: ${errorText}`);
        }
        
        const saveResult = await saveResponse.json();
        
        if (!saveResult || !saveResult.path) {
            throw new Error('No path returned from upload');
        }
        
        console.log(`[Localize] Saved successfully: ${saveResult.path}`);
        
        return {
            success: true,
            url: url,
            localPath: saveResult.path,
            filename: `${filenameBase}.${extension}`
        };
        
    } catch (error) {
        console.error(`[Localize] Failed to download: ${url}`, error);
        return {
            success: false,
            url: url,
            error: error.message || String(error)
        };
    }
}

/**
 * Add entry to localize log
 */
function addLocalizeLogEntry(message, status = 'pending') {
    const localizeLog = document.getElementById('localizeLog');
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        pending: 'fa-spinner fa-spin'
    };
    
    const entry = document.createElement('div');
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${icons[status]}"></i>${escapeHtml(message)}`;
    localizeLog.appendChild(entry);
    localizeLog.scrollTop = localizeLog.scrollHeight;
    return entry;
}

/**
 * Update a localize log entry
 */
function updateLocalizeLogEntry(entry, message, status) {
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-times-circle',
        pending: 'fa-spinner fa-spin'
    };
    entry.className = `import-log-entry ${status}`;
    entry.innerHTML = `<i class="fa-solid ${icons[status]}"></i>${escapeHtml(message)}`;
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

// Close localize modal handlers
closeLocalizeModal?.addEventListener('click', () => {
    localizeModal.classList.add('hidden');
});

closeLocalizeBtn?.addEventListener('click', () => {
    localizeModal.classList.add('hidden');
});

// Localize Media button click handler
localizeMediaBtn?.addEventListener('click', async () => {
    if (!activeChar) {
        showToast('No character selected', 'error');
        return;
    }
    
    // Show modal
    localizeModal.classList.remove('hidden');
    localizeStatus.textContent = 'Scanning character for remote media...';
    localizeLog.innerHTML = '';
    localizeProgressFill.style.width = '0%';
    localizeProgressCount.textContent = '0/0';
    
    // Get character name for folder
    const characterName = activeChar.name || activeChar.data?.name || 'unknown';
    
    // Find all media URLs
    const mediaUrls = findCharacterMediaUrls(activeChar);
    
    if (mediaUrls.length === 0) {
        localizeStatus.textContent = 'No remote media found in this character card.';
        addLocalizeLogEntry('No remote media URLs detected', 'success');
        return;
    }
    
    localizeStatus.textContent = `Found ${mediaUrls.length} remote media file(s). Checking for existing files...`;
    
    // Get existing files and their hashes to check for duplicates BEFORE downloading
    const existingHashes = await getExistingFileHashes(characterName);
    console.log(`[Localize] Found ${existingHashes.size} existing file hashes`);
    
    localizeStatus.textContent = `Found ${mediaUrls.length} remote media file(s). Downloading new files...`;
    localizeProgressCount.textContent = `0/${mediaUrls.length}`;
    
    // Download each media file
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let startIndex = Date.now(); // Use timestamp as start index for unique filenames
    
    for (let i = 0; i < mediaUrls.length; i++) {
        const url = mediaUrls[i];
        const fileIndex = startIndex + i;
        
        // Truncate URL for display
        const displayUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;
        const logEntry = addLocalizeLogEntry(`Checking ${displayUrl}...`, 'pending');
        
        // Download to memory first to check hash
        const downloadResult = await downloadMediaToMemory(url);
        
        if (!downloadResult.success) {
            errorCount++;
            updateLocalizeLogEntry(logEntry, `Failed: ${displayUrl} - ${downloadResult.error}`, 'error');
            // Update progress
            const progress = ((i + 1) / mediaUrls.length) * 100;
            localizeProgressFill.style.width = `${progress}%`;
            localizeProgressCount.textContent = `${i + 1}/${mediaUrls.length}`;
            continue;
        }
        
        // Calculate hash of downloaded content
        const contentHash = await calculateHash(downloadResult.arrayBuffer);
        
        // Check if this file already exists
        if (existingHashes.has(contentHash)) {
            skippedCount++;
            updateLocalizeLogEntry(logEntry, `Skipped (duplicate): ${displayUrl}`, 'success');
            console.log(`[Localize] Skipping duplicate: ${url}`);
            // Update progress
            const progress = ((i + 1) / mediaUrls.length) * 100;
            localizeProgressFill.style.width = `${progress}%`;
            localizeProgressCount.textContent = `${i + 1}/${mediaUrls.length}`;
            continue;
        }
        
        // Not a duplicate, save the file
        updateLocalizeLogEntry(logEntry, `Saving ${displayUrl}...`, 'pending');
        const result = await saveMediaFromMemory(downloadResult, url, characterName, fileIndex);
        
        if (result.success) {
            successCount++;
            existingHashes.add(contentHash); // Add to known hashes to avoid downloading same file twice
            updateLocalizeLogEntry(logEntry, `Saved: ${result.filename}`, 'success');
        } else {
            errorCount++;
            updateLocalizeLogEntry(logEntry, `Failed: ${displayUrl} - ${result.error}`, 'error');
        }
        
        // Update progress
        const progress = ((i + 1) / mediaUrls.length) * 100;
        localizeProgressFill.style.width = `${progress}%`;
        localizeProgressCount.textContent = `${i + 1}/${mediaUrls.length}`;
    }
    
    // Done
    let statusMsg = '';
    if (successCount > 0) {
        statusMsg = `Downloaded ${successCount} new file(s)`;
    }
    if (skippedCount > 0) {
        statusMsg += (statusMsg ? ', ' : '') + `${skippedCount} already existed`;
    }
    if (errorCount > 0) {
        statusMsg += (statusMsg ? ', ' : '') + `${errorCount} failed`;
    }
    
    localizeStatus.textContent = statusMsg || 'No new files to download.';
    
    if (successCount > 0) {
        showToast(`Downloaded ${successCount} new media file(s)`, 'success');
        
        // Refresh the sprites grid to show new images
        if (activeChar) {
            fetchCharacterImages(activeChar.name || activeChar.data?.name);
        }
    } else if (skippedCount > 0 && errorCount === 0) {
        showToast('All files already exist', 'info');
    } else if (errorCount > 0) {
        showToast('Some downloads failed', 'error');
    }
});

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
            console.log('[Duplicates] crypto.subtle failed, using fallback hash');
        }
    }
    
    // Fallback to simple hash for HTTP contexts
    return simpleHash(arrayBuffer);
}

/**
 * Fetch a file and calculate its hash
 */
async function getFileHash(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        return await calculateHash(buffer);
    } catch (error) {
        console.error(`[Duplicates] Error hashing ${url}:`, error);
        return null;
    }
}

/**
 * Check for duplicate files in the character's gallery
 */
async function checkForDuplicates(characterName) {
    const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
    
    try {
        // Get list of all files in the gallery (all media types)
        const response = await fetch(`${API_BASE}/images/list`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ folder: characterName, type: 7 })
        });
        
        if (!response.ok) {
            console.log('[Duplicates] Could not list media files');
            return;
        }
        
        const files = await response.json();
        if (!files || files.length < 2) {
            console.log('[Duplicates] Not enough files to check for duplicates');
            localizeStatus.textContent += ' No duplicates found.';
            return;
        }
        
        localizeStatus.textContent = `Checking ${files.length} files for duplicates...`;
        
        // Filter for media files (images and audio)
        const mediaFiles = files
            .map(f => typeof f === 'string' ? f : f.name)
            .filter(f => f && f.match(/\.(png|jpg|jpeg|webp|gif|bmp|mp3|wav|ogg|m4a|flac|aac)$/i));
        
        if (mediaFiles.length < 2) {
            localizeStatus.textContent += ' No duplicates found.';
            return;
        }
        
        // Calculate hash for each file
        const fileHashes = [];
        const safeFolderName = sanitizeFolderName(characterName);
        
        for (let i = 0; i < mediaFiles.length; i++) {
            const fileName = mediaFiles[i];
            const fileUrl = `/user/images/${encodeURIComponent(safeFolderName)}/${encodeURIComponent(fileName)}`;
            
            localizeStatus.textContent = `Hashing file ${i + 1}/${mediaFiles.length}...`;
            
            const hash = await getFileHash(fileUrl);
            if (hash) {
                fileHashes.push({
                    filename: fileName,
                    url: fileUrl,
                    hash: hash
                });
            }
        }
        
        // Find duplicates (same hash)
        const hashGroups = {};
        fileHashes.forEach(file => {
            if (!hashGroups[file.hash]) {
                hashGroups[file.hash] = [];
            }
            hashGroups[file.hash].push(file);
        });
        
        // Get duplicate groups (more than one file with same hash)
        const duplicateGroups = Object.values(hashGroups).filter(group => group.length > 1);
        
        if (duplicateGroups.length === 0) {
            localizeStatus.textContent += ' No duplicates found.';
            console.log('[Duplicates] No duplicates found');
            return;
        }
        
        console.log(`[Duplicates] Found ${duplicateGroups.length} duplicate group(s)`);
        
        // Show duplicates modal
        showDuplicatesModal(duplicateGroups, characterName);
        
    } catch (error) {
        console.error('[Duplicates] Error checking duplicates:', error);
        localizeStatus.textContent += ' Error checking duplicates.';
    }
}

/**
 * Show the duplicates modal with found duplicates
 */
function showDuplicatesModal(duplicateGroups, characterName) {
    const duplicatesModal = document.getElementById('duplicatesModal');
    const duplicatesList = document.getElementById('duplicatesList');
    const duplicatesStatus = document.getElementById('duplicatesStatus');
    
    // Count total duplicates
    let totalDuplicates = 0;
    duplicateGroups.forEach(group => totalDuplicates += group.length - 1);
    
    duplicatesStatus.textContent = `Found ${totalDuplicates} duplicate file(s) in ${duplicateGroups.length} group(s). Select files to delete:`;
    
    duplicatesList.innerHTML = '';
    
    duplicateGroups.forEach((group, groupIdx) => {
        // Sort by filename to determine which is "newer" (localized files have specific naming)
        // Files with "localized_media_" are newer downloads
        const sorted = [...group].sort((a, b) => {
            const aIsLocalized = a.filename.includes('localized_media_');
            const bIsLocalized = b.filename.includes('localized_media_');
            if (aIsLocalized && !bIsLocalized) return 1; // a is newer
            if (!aIsLocalized && bIsLocalized) return -1; // b is newer
            return a.filename.localeCompare(b.filename);
        });
        
        const older = sorted[0];
        const newer = sorted.slice(1); // Could be multiple newer duplicates
        
        newer.forEach((newerFile, newerIdx) => {
            const item = document.createElement('div');
            item.className = 'duplicate-item';
            item.dataset.filename = newerFile.filename;
            item.dataset.folder = characterName;
            
            item.innerHTML = `
                <input type="checkbox" class="duplicate-checkbox" checked>
                <div class="duplicate-images">
                    <div class="duplicate-img-container older">
                        <img src="${older.url}" alt="Original" loading="lazy">
                        <span class="duplicate-img-label older">Keep</span>
                    </div>
                    <i class="fa-solid fa-equals duplicate-arrow"></i>
                    <div class="duplicate-img-container newer">
                        <img src="${newerFile.url}" alt="Duplicate" loading="lazy">
                        <span class="duplicate-img-label newer">Delete</span>
                    </div>
                </div>
                <div class="duplicate-info">
                    <div class="duplicate-filename">${escapeHtml(newerFile.filename)}</div>
                    <div class="duplicate-meta">Duplicate of: ${escapeHtml(older.filename)}</div>
                    <div class="duplicate-hash">SHA-256: ${newerFile.hash.substring(0, 16)}...</div>
                </div>
            `;
            
            // Toggle selection on checkbox change
            const checkbox = item.querySelector('.duplicate-checkbox');
            checkbox.addEventListener('change', () => {
                item.classList.toggle('selected', checkbox.checked);
            });
            item.classList.add('selected'); // Initially selected
            
            duplicatesList.appendChild(item);
        });
    });
    
    duplicatesModal.classList.remove('hidden');
    
    // Update localize status
    localizeStatus.textContent = `Found ${totalDuplicates} duplicate(s). Review in popup.`;
}

/**
 * Delete selected duplicate files
 */
async function deleteSelectedDuplicates() {
    const duplicatesList = document.getElementById('duplicatesList');
    const selectedItems = duplicatesList.querySelectorAll('.duplicate-item.selected');
    
    if (selectedItems.length === 0) {
        showToast('No duplicates selected', 'info');
        return;
    }
    
    const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
    let deleted = 0;
    let failed = 0;
    
    for (const item of selectedItems) {
        const filename = item.dataset.filename;
        const folder = item.dataset.folder;
        // Build the path as expected by the API: user/images/CharacterName/filename.ext
        const imagePath = `user/images/${folder}/${filename}`;
        
        try {
            // Use SillyTavern's image delete API - expects 'path' parameter
            const response = await fetch(`${API_BASE}/images/delete`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    path: imagePath
                })
            });
            
            if (response.ok) {
                deleted++;
                item.remove();
            } else {
                failed++;
                console.error(`[Duplicates] Failed to delete ${filename}: ${response.status}`);
            }
        } catch (error) {
            failed++;
            console.error(`[Duplicates] Error deleting ${filename}:`, error);
        }
    }
    
    if (deleted > 0) {
        showToast(`Deleted ${deleted} duplicate(s)${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
        
        // Refresh gallery
        if (activeChar) {
            fetchCharacterImages(activeChar.name || activeChar.data?.name);
        }
    } else {
        showToast(`Failed to delete duplicates`, 'error');
    }
    
    // Close modal if all deleted
    const remaining = duplicatesList.querySelectorAll('.duplicate-item');
    if (remaining.length === 0) {
        document.getElementById('duplicatesModal').classList.add('hidden');
    }
}

// Duplicates Modal Event Listeners
document.getElementById('closeDuplicatesModal')?.addEventListener('click', () => {
    document.getElementById('duplicatesModal').classList.add('hidden');
});

document.getElementById('keepAllDuplicatesBtn')?.addEventListener('click', () => {
    document.getElementById('duplicatesModal').classList.add('hidden');
    showToast('Keeping all files', 'info');
});

document.getElementById('deleteSelectedDuplicatesBtn')?.addEventListener('click', () => {
    deleteSelectedDuplicates();
});

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
 * Calculate token count estimate from character data
 */
function estimateTokens(char) {
    const desc = getCharField(char, 'description') || '';
    const personality = getCharField(char, 'personality') || '';
    const scenario = getCharField(char, 'scenario') || '';
    const firstMes = getCharField(char, 'first_mes') || '';
    const sysprompt = getCharField(char, 'system_prompt') || '';
    
    const totalText = desc + personality + scenario + firstMes + sysprompt;
    // Rough estimate: ~4 chars per token
    return Math.round(totalText.length / 4);
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
    
    // === NAME COMPARISON ===
    const nameA = getCharField(charA, 'name') || '';
    const nameB = getCharField(charB, 'name') || '';
    const normalizedNameA = normalizeCharName(nameA);
    const normalizedNameB = normalizeCharName(nameB);
    
    if (nameA.toLowerCase().trim() === nameB.toLowerCase().trim() && nameA) {
        score += 25;
        breakdown.name = 25;
        matchReasons.push('Exact name match');
    } else if (normalizedNameA === normalizedNameB && normalizedNameA.length > 2) {
        score += 20;
        breakdown.name = 20;
        matchReasons.push('Name variant match');
    } else if (normalizedNameA.length > 2 && normalizedNameB.length > 2) {
        const nameSim = stringSimilarity(normalizedNameA, normalizedNameB);
        if (nameSim >= 0.7) {
            const nameScore = Math.round(nameSim * 15);
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
    
    // === DESCRIPTION COMPARISON ===
    const descA = getCharField(charA, 'description') || '';
    const descB = getCharField(charB, 'description') || '';
    
    if (descA && descB) {
        const descSim = contentSimilarity(descA, descB);
        if (descSim >= 0.3) { // Only count if somewhat similar
            const descScore = Math.round(descSim * 20);
            score += descScore;
            breakdown.description = descScore;
            if (descSim >= 0.7) {
                matchReasons.push(`${Math.round(descSim * 100)}% description match`);
            }
        }
    }
    
    // === FIRST MESSAGE COMPARISON ===
    const firstMesA = getCharField(charA, 'first_mes') || '';
    const firstMesB = getCharField(charB, 'first_mes') || '';
    
    if (firstMesA && firstMesB) {
        const firstMesSim = contentSimilarity(firstMesA, firstMesB);
        if (firstMesSim >= 0.3) {
            const fmScore = Math.round(firstMesSim * 15);
            score += fmScore;
            breakdown.first_mes = fmScore;
            if (firstMesSim >= 0.7) {
                matchReasons.push(`${Math.round(firstMesSim * 100)}% first message match`);
            }
        }
    }
    
    // === PERSONALITY COMPARISON ===
    const persA = getCharField(charA, 'personality') || '';
    const persB = getCharField(charB, 'personality') || '';
    
    if (persA && persB) {
        const persSim = contentSimilarity(persA, persB);
        if (persSim >= 0.3) {
            const persScore = Math.round(persSim * 10);
            score += persScore;
            breakdown.personality = persScore;
            if (persSim >= 0.8) {
                matchReasons.push(`${Math.round(persSim * 100)}% personality match`);
            }
        }
    }
    
    // === SCENARIO COMPARISON ===
    const scenA = getCharField(charA, 'scenario') || '';
    const scenB = getCharField(charB, 'scenario') || '';
    
    if (scenA && scenB) {
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
        console.log('[Duplicates] Using cached results');
        return duplicateScanCache.groups;
    }
    
    const statusEl = document.getElementById('charDuplicatesScanStatus');
    const totalChars = allCharacters.length;
    
    console.log('[Duplicates] Scanning', totalChars, 'characters...');
    
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
    
    console.log('[Duplicates] Found', groups.length, 'potential duplicate groups');
    
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
        scenario: newChar.scenario || newChar.definition?.scenario || ''
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
 * Render a field diff between two characters
 */
function renderFieldDiff(fieldName, valueA, valueB, labelA = 'Original', labelB = 'Duplicate') {
    valueA = valueA || '';
    valueB = valueB || '';
    
    const isSame = valueA.trim() === valueB.trim();
    const truncateLength = 200;
    
    const truncate = (text) => {
        if (text.length <= truncateLength) return escapeHtml(text);
        return escapeHtml(text.substring(0, truncateLength)) + '...';
    };
    
    if (isSame && !valueA) return ''; // Both empty, don't show
    
    if (isSame) {
        return `
            <div class="char-dup-diff-section">
                <div class="char-dup-diff-label">${escapeHtml(fieldName)} (identical)</div>
                <div class="char-dup-diff-content same">${truncate(valueA)}</div>
            </div>
        `;
    }
    
    let html = `<div class="char-dup-diff-section"><div class="char-dup-diff-label">${escapeHtml(fieldName)}</div>`;
    
    if (valueA) {
        html += `<div class="char-dup-diff-content" style="margin-bottom: 5px;"><strong>${escapeHtml(labelA)}:</strong> ${truncate(valueA)}</div>`;
    }
    if (valueB) {
        html += `<div class="char-dup-diff-content"><strong>${escapeHtml(labelB)}:</strong> ${truncate(valueB)}</div>`;
    }
    
    html += '</div>';
    return html;
}

/**
 * Render a character comparison card
 */
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
        // Which is newer
        isNewer: dupDate && refDate && dupDate > refDate,
        isOlder: dupDate && refDate && dupDate < refDate,
        hasMoreTokens: dupTokens > refTokens,
        hasLessTokens: dupTokens < refTokens
    };
}

function renderCharDupCard(char, type, groupIdx, charIdx = 0, diffs = null) {
    const name = getCharField(char, 'name') || 'Unknown';
    const creator = getCharField(char, 'creator') || 'Unknown creator';
    const avatarPath = `/characters/${encodeURIComponent(char.avatar)}`;
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
        
        if (badges.length > 0) {
            diffBadges = `<div class="char-dup-card-diffs">${badges.join('')}</div>`;
        }
    }
    
    // Highlight differing fields
    const dateClass = diffs && diffs.date ? 'diff-highlight' : '';
    const tokenClass = diffs && diffs.tokens ? 'diff-highlight' : '';
    
    return `
        <div class="char-dup-card ${type}">
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
            </div>
            <div class="char-dup-card-actions">
                ${isReference ? `
                    <button class="action-btn secondary small" onclick="viewCharFromDuplicates('${escapeHtml(char.avatar)}')">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                ` : `
                    <button class="action-btn secondary small" onclick="viewCharFromDuplicates('${escapeHtml(char.avatar)}')">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="action-btn secondary small" style="color: #e74c3c;" onclick="deleteDuplicateChar('${escapeHtml(char.avatar)}', ${groupIdx})">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                `}
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
        const refAvatar = `/characters/${encodeURIComponent(ref.avatar)}`;
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
                            <span style="opacity: 0.7;">• Score: ${maxScore} pts</span>
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
                    scoreBreakdown = `<div style="font-size: 0.6rem; color: var(--text-secondary); margin-top: 3px;">${parts.join(' • ')}</div>`;
                }
            }
            
            // Build diff sections
            const descDiff = renderFieldDiff('Description', 
                getCharField(ref, 'description'), 
                getCharField(dupChar, 'description'));
            const persDiff = renderFieldDiff('Personality', 
                getCharField(ref, 'personality'), 
                getCharField(dupChar, 'personality'));
            const firstMesDiff = renderFieldDiff('First Message', 
                getCharField(ref, 'first_mes'), 
                getCharField(dupChar, 'first_mes'));
            
            html += `
                <div class="char-dup-comparison" data-dup-idx="${dupIdx}">
                    ${renderCharDupCard(ref, 'reference', idx)}
                    <div class="char-dup-divider">
                        <i class="fa-solid fa-arrows-left-right"></i>
                        <div class="char-dup-group-confidence ${dup.confidence}" style="font-size: 0.65rem;">
                            ${dup.score || 0} pts
                        </div>
                        <div style="font-size: 0.6rem; color: var(--text-secondary); text-align: center; max-width: 120px;">
                            ${dup.matchReason}
                        </div>
                        ${scoreBreakdown}
                    </div>
                    ${renderCharDupCard(dupChar, 'duplicate', idx, dupIdx, diffs)}
                </div>
                ${(descDiff || persDiff || firstMesDiff) ? `
                    <div class="char-dup-diff" style="padding: 0 15px 15px;">
                        <details>
                            <summary style="cursor: pointer; color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 10px;">
                                <i class="fa-solid fa-code-compare"></i> Show Field Comparison
                            </summary>
                            ${descDiff}
                            ${persDiff}
                            ${firstMesDiff}
                        </details>
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
 * Delete a duplicate character
 */
async function deleteDuplicateChar(avatar, groupIdx) {
    const char = allCharacters.find(c => c.avatar === avatar);
    if (!char) return;
    
    const name = getCharField(char, 'name') || avatar;
    
    if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis action cannot be undone.`)) {
        return;
    }
    
    // Use the main deleteCharacter function which handles ST sync
    const success = await deleteCharacter(char, false);
    
    if (success) {
        showToast(`Deleted "${name}"`, 'success');
        
        // Invalidate cache
        duplicateScanCache.timestamp = 0;
        
        // Refresh the gallery
        await fetchCharacters(true);
        
        // Re-run duplicate scan with new data
        const groups = await findCharacterDuplicates(true);
        renderDuplicateGroups(groups);
    } else {
        showToast(`Failed to delete "${name}"`, 'error');
    }
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
document.getElementById('checkDuplicatesBtn')?.addEventListener('click', () => {
    openCharDuplicatesModal();
});

document.getElementById('closeCharDuplicatesModal')?.addEventListener('click', () => {
    document.getElementById('charDuplicatesModal').classList.add('hidden');
});

document.getElementById('closeCharDuplicatesModalBtn')?.addEventListener('click', () => {
    document.getElementById('charDuplicatesModal').classList.add('hidden');
});

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
            const existingAvatar = `/characters/${encodeURIComponent(existingChar.avatar)}`;
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
document.getElementById('closePreImportDuplicateModal')?.addEventListener('click', () => {
    resolvePreImportChoice('skip');
});

document.getElementById('preImportSkipBtn')?.addEventListener('click', () => {
    resolvePreImportChoice('skip');
});

document.getElementById('preImportAnyway')?.addEventListener('click', () => {
    resolvePreImportChoice('import');
});

document.getElementById('preImportReplaceBtn')?.addEventListener('click', () => {
    resolvePreImportChoice('replace');
});

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
            console.log('View toggle clicked:', view);
            switchView(view);
        });
    });
    
    // Chats Sort Select
    document.getElementById('chatsSortSelect')?.addEventListener('change', (e) => {
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
    document.getElementById('refreshChatsViewBtn')?.addEventListener('click', () => {
        clearChatCache();
        allChats = [];
        loadAllChats(true); // Force refresh
    });
    
    // Chat Preview Modal handlers
    document.getElementById('chatPreviewClose')?.addEventListener('click', () => {
        document.getElementById('chatPreviewModal').classList.add('hidden');
    });
    
    document.getElementById('chatPreviewOpenBtn')?.addEventListener('click', () => {
        if (currentPreviewChat) {
            openChatInST(currentPreviewChat);
        }
    });
    
    document.getElementById('chatPreviewDeleteBtn')?.addEventListener('click', () => {
        if (currentPreviewChat) {
            deleteChatFromView(currentPreviewChat);
        }
    });
    
    // Close modal on overlay click
    document.getElementById('chatPreviewModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'chatPreviewModal') {
            document.getElementById('chatPreviewModal').classList.add('hidden');
        }
    });
    
    console.log('Chats view initialized');
}

// Call init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatsView);
} else {
    initChatsView();
}

function switchView(view) {
    console.log('Switching to view:', view);
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
    document.getElementById('characterGrid')?.classList.add('hidden');
    document.getElementById('chatsView')?.classList.add('hidden');
    document.getElementById('chubView')?.classList.add('hidden');
    
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
        document.getElementById('characterGrid')?.classList.remove('hidden');
        
        // Re-apply current filters and sort when returning to characters view
        performSearch();
    } else if (view === 'chats') {
        if (chatFilters) chatFilters.style.display = 'flex';
        if (importBtn) importBtn.style.display = 'none';
        if (searchSettings) searchSettings.style.display = 'none';
        // Use visibility to maintain space for search area
        if (mainSearch) {
            mainSearch.style.visibility = 'visible';
            mainSearch.style.pointerEvents = '';
        }
        document.getElementById('chatsView')?.classList.remove('hidden');
        
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
        document.getElementById('chubView')?.classList.remove('hidden');
        
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
        console.log(`[ChatsCache] Saved ${chats.length} chats to cache`);
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
        console.log(`[ChatsCache] Using cached data (${Math.round(cacheAge/1000)}s old, ${cached.chats.length} chats)`);
        
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
            console.log('[ChatsCache] Cache is stale, refreshing in background...');
            showRefreshIndicator(true);
            await fetchFreshChats(true); // background mode
            showRefreshIndicator(false);
        }
        
        return;
    }
    
    // No cache or force refresh - do full load
    chatsGrid.innerHTML = '<div class="chats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading all chats...</div>';
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const newChats = [];
        
        // Get chats for each character that has chats
        for (const char of allCharacters) {
            try {
                const response = await fetch(`${API_BASE}/characters/chats`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify({ avatar_url: char.avatar, metadata: true })
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
        console.log(`[ChatsCache] ${chatsNeedingPreviews.length} of ${allChats.length} chats need preview loading`);
        
        if (chatsNeedingPreviews.length > 0) {
            await loadChatPreviews(csrfToken, chatsNeedingPreviews);
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
async function loadChatPreviews(csrfToken, chatsToLoad = null) {
    const BATCH_SIZE = 5; // Fetch 5 at a time to avoid overwhelming the server
    const targetChats = chatsToLoad || allChats;
    console.log(`[ChatPreviews] Starting to load previews for ${targetChats.length} chats`);
    
    for (let i = 0; i < targetChats.length; i += BATCH_SIZE) {
        const batch = targetChats.slice(i, i + BATCH_SIZE);
        console.log(`[ChatPreviews] Processing batch ${i/BATCH_SIZE + 1}, chats ${i} to ${i + batch.length}`);
        
        await Promise.all(batch.map(async (chat) => {
            try {
                // Try the file_name without .jsonl extension
                const chatFileName = chat.file_name.replace('.jsonl', '');
                
                const response = await fetch(`${API_BASE}/chats/get`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify({
                        ch_name: chat.character.name,
                        file_name: chatFileName,
                        avatar_url: chat.character.avatar
                    })
                });
                
                console.log(`[ChatPreviews] ${chat.file_name}: response status ${response.status}`);
                
                if (response.ok) {
                    const messages = await response.json();
                    console.log(`[ChatPreviews] ${chat.file_name}: got ${messages?.length || 0} messages`);
                    
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
    
    console.log(`[ChatPreviews] Finished loading all previews`);
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
        const avatarUrl = char.avatar ? `/characters/${encodeURIComponent(char.avatar)}` : '';
        
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
    const avatarUrl = char.avatar ? `/characters/${encodeURIComponent(char.avatar)}` : '';
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
    const avatarUrl = chat.character.avatar ? `/characters/${encodeURIComponent(chat.character.avatar)}` : '/img/ai4.png';
    
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
    
    messagesContainer.innerHTML = '<div class="chats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading messages...</div>';
    
    modal.classList.remove('hidden');
    
    // Load chat content
    try {
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        
        console.log(`[ChatPreview] Loading chat: ${chatFileName} for ${chat.character.name}`);
        
        const response = await fetch(`${API_BASE}/chats/get`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                ch_name: chat.character.name,
                file_name: chatFileName,
                avatar_url: chat.character.avatar
            })
        });
        
        console.log(`[ChatPreview] Response status: ${response.status}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ChatPreview] Error response:`, errorText);
            throw new Error(`HTTP ${response.status}`);
        }
        
        const messages = await response.json();
        console.log(`[ChatPreview] Got ${messages?.length || 0} messages`);
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
    
    const avatarUrl = character.avatar ? `/characters/${encodeURIComponent(character.avatar)}` : '/img/ai4.png';
    
    container.innerHTML = messages.map((msg, index) => {
        const isUser = msg.is_user;
        const isSystem = msg.is_system;
        const name = msg.name || (isUser ? 'User' : character.name);
        const text = msg.mes || '';
        const time = msg.send_date ? new Date(msg.send_date).toLocaleString() : '';
        
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
                        <div class="chat-message-text">${escapeHtml(text)}</div>
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
                    <div class="chat-message-text">${escapeHtml(text)}</div>
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const response = await fetch(`${API_BASE}/chats/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                chatfile: chat.file_name,
                avatar_url: chat.character.avatar
            })
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
                        ${msg.send_date ? `<span> • ${new Date(msg.send_date).toLocaleString()}</span>` : ''}
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
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        
        const response = await fetch(`${API_BASE}/chats/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                ch_name: chat.character.name,
                file_name: chatFileName,
                avatar_url: chat.character.avatar,
                chat: messages
            })
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

// Search input should also filter chats when in chats view
const searchInputForChats = document.getElementById('searchInput');
if (searchInputForChats) {
    searchInputForChats.addEventListener('input', () => {
        if (currentView === 'chats') {
            renderChats();
        }
    });
}

// ========================================
// CHUBAI BROWSER
// ========================================

const CHUB_API_BASE = 'https://api.chub.ai';
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
let chubFilterVerified = false;
let chubFilterFavorites = false;

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
let chubCurrentUsername = null; // Current logged-in username

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
        const chubUrl = char.data?.extensions?.chub?.url || 
                       char.data?.extensions?.chub?.full_path ||
                       char.chub_url || 
                       char.source_url || '';
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
    
    console.log('[LocalLibrary] Built lookup:', 
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

// Dynamic tags - populated from ChubAI search results
let chubPopularTags = [];
const CHUB_FALLBACK_TAGS = [
    'female', 'male', 'fantasy', 'anime', 'original', 'rpg', 
    'romance', 'adventure', 'sci-fi', 'game', 'cute', 'monster'
];

// Helper function to format text with basic markdown and {{char}} placeholders
function formatTextWithBasicMarkdown(text, charName = 'Character') {
    if (!text) return '';
    
    // Escape HTML first
    let formatted = escapeHtml(text);
    
    // Replace {{char}} and {{user}} placeholders
    formatted = formatted.replace(/\{\{char\}\}/gi, `<span class="char-placeholder">${escapeHtml(charName)}</span>`);
    formatted = formatted.replace(/\{\{user\}\}/gi, '<span class="user-placeholder">You</span>');
    
    // Basic markdown formatting
    // Bold: **text** or __text__
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    // Italic: *text* or _text_
    formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/_([^_]+)_/g, '<em>$1</em>');
    
    // Line breaks
    formatted = formatted.replace(/\n/g, '<br>');
    
    return formatted;
}

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

/**
 * Render creator notes in a sandboxed iframe with full CSS support
 * This is used for both local and ChubAI character modals
 * @param {string} content - The creator notes content
 * @param {string} charName - Character name for placeholder replacement
 * @param {HTMLElement} container - Container element to render into
 */
function renderCreatorNotesSecure(content, charName, container) {
    if (!content || !container) return;
    
    // Check if rich rendering is enabled
    const useRichRendering = getSetting('richCreatorNotes') || false;
    
    if (!useRichRendering) {
        // Use simple sanitized HTML rendering
        renderCreatorNotesSimple(content, charName, container);
        return;
    }
    
    // Rich rendering path - use sandboxed iframe with full CSS support
    // Process creator notes - convert markdown images to HTML
    const formattedNotes = formatRichText(content, charName, true);
    
    // Sanitize with DOMPurify (defense in depth) - permissive for creator styling
    const sanitizedNotes = typeof DOMPurify !== 'undefined' 
        ? DOMPurify.sanitize(formattedNotes, {
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
        })
        : escapeHtml(formattedNotes);
    
    // CSS Sanitization
    const sanitizeCSS = (content) => {
        const dangerousPatterns = [
            /position\s*:\s*(fixed|sticky)/gi,
            /z-index\s*:\s*(\d{4,}|[5-9]\d{2})/gi,
            /-moz-binding\s*:/gi,
            /behavior\s*:/gi,
            /expression\s*\(/gi,
            // Allow @import for fonts/CSS but block others - only block @import without url()
            /@import\s+(?!url\s*\()/gi,
            /javascript\s*:/gi,
            /vbscript\s*:/gi,
        ];
        
        let sanitized = content;
        dangerousPatterns.forEach(pattern => {
            sanitized = sanitized.replace(pattern, '/* blocked */ ');
        });
        return sanitized;
    };
    
    // Add referrer policy for privacy
    const hardenImages = (content) => {
        return content
            .replace(/<img\s/gi, '<img referrerpolicy="no-referrer" ')
            .replace(/<video\s/gi, '<video referrerpolicy="no-referrer" ')
            .replace(/<audio\s/gi, '<audio referrerpolicy="no-referrer" ');
    };
    
    const hardenedNotes = hardenImages(sanitizeCSS(sanitizedNotes));
    
    // Build the sandboxed iframe content
    const iframeStyles = `
        <style>
            * { box-sizing: border-box; }
            html, body {
                margin: 0;
                padding: 0;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                color: #e0e0e0;
                background: transparent;
                line-height: 1.5;
                overflow-wrap: break-word;
                word-wrap: break-word;
                font-size: 14px;
            }
            body { padding: 5px; }
            
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
            
            ul, ol { 
                padding-left: 25px; 
                margin: 8px 0;
            }
            li { margin: 4px 0; }
            
            .embedded-image {
                max-width: 100% !important;
                height: auto !important;
                border-radius: 8px;
                margin: 10px auto;
                display: block;
            }
            
            .embedded-link { color: #4a9eff; }
            
            .placeholder-user { color: #2ecc71; font-weight: bold; }
            .placeholder-char { color: #e74c3c; font-weight: bold; }
            
            [style*="position: fixed"], [style*="position:fixed"],
            [style*="position: sticky"], [style*="position:sticky"] {
                position: static !important;
            }
            [style*="z-index"] {
                z-index: auto !important;
            }
        </style>
    `;
    
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src * data:;">`;
    
    const iframeContent = `<!DOCTYPE html><html><head><meta charset="UTF-8">${cspMeta}${iframeStyles}</head><body>${hardenedNotes}</body></html>`;
    
    // Create sandboxed iframe
    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
    // Minimal styling - iframe auto-sizes to content
    iframe.style.cssText = 'width: 100%; min-height: 30px; border: none; background: transparent; border-radius: 8px;';
    iframe.srcdoc = iframeContent;
    
    // Auto-resize iframe to fit content exactly
    iframe.onload = () => {
        try {
            const resizeIframe = () => {
                if (iframe.contentDocument && iframe.contentDocument.body) {
                    // Force reflow to get accurate measurement
                    iframe.contentDocument.body.style.overflow = 'hidden';
                    const height = iframe.contentDocument.body.scrollHeight;
                    // Set to exact content height with minimal padding
                    iframe.style.height = Math.max(height, 30) + 'px';
                }
            };
            // Small delay to ensure content is fully rendered
            setTimeout(resizeIframe, 10);
            if (iframe.contentDocument) {
                const images = iframe.contentDocument.querySelectorAll('img');
                images.forEach(img => {
                    img.addEventListener('load', () => setTimeout(resizeIframe, 10));
                    img.addEventListener('error', () => setTimeout(resizeIframe, 10));
                });
            }
        } catch (e) {
            iframe.style.height = '150px';
        }
    };
    
    container.appendChild(iframe);
}

function initChubView() {
    // Render popular tags
    renderChubPopularTags();
    
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
    document.getElementById('chubClearAuthorBtn')?.addEventListener('click', () => {
        clearAuthorFilter();
    });
    
    // Follow author button
    document.getElementById('chubFollowAuthorBtn')?.addEventListener('click', () => {
        toggleFollowAuthor();
    });
    
    // Timeline load more button (uses cursor-based pagination)
    document.getElementById('chubTimelineLoadMoreBtn')?.addEventListener('click', () => {
        if (chubTimelineCursor) {
            chubTimelinePage++;
            loadChubTimeline(false);
        }
    });
    
    // Search handlers
    document.getElementById('chubSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performChubSearch();
        }
    });
    
    document.getElementById('chubSearchBtn')?.addEventListener('click', () => {
        performChubSearch();
    });
    
    // Creator search handlers
    document.getElementById('chubCreatorSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performChubCreatorSearch();
        }
    });
    
    document.getElementById('chubCreatorSearchBtn')?.addEventListener('click', () => {
        performChubCreatorSearch();
    });
    
    // Discovery preset select (combined sort + time)
    document.getElementById('chubDiscoveryPreset')?.addEventListener('change', (e) => {
        chubDiscoveryPreset = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    });
    
    // More filters dropdown toggle
    document.getElementById('chubFiltersBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
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
    
    // Filter checkboxes
    const filterCheckboxes = [
        { id: 'chubFilterImages', setter: (v) => chubFilterImages = v },
        { id: 'chubFilterLore', setter: (v) => chubFilterLore = v },
        { id: 'chubFilterExpressions', setter: (v) => chubFilterExpressions = v },
        { id: 'chubFilterGreetings', setter: (v) => chubFilterGreetings = v },
        { id: 'chubFilterVerified', setter: (v) => chubFilterVerified = v },
        { id: 'chubFilterFavorites', setter: (v) => chubFilterFavorites = v }
    ];
    
    filterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            // Special handling for favorites - requires token
            if (id === 'chubFilterFavorites' && e.target.checked && !chubToken) {
                e.target.checked = false;
                showToast('URQL token required for favorites. Click the key icon to add your ChubAI token.', 'warning');
                document.getElementById('chubLoginModal')?.classList.remove('hidden');
                return;
            }
            setter(e.target.checked);
            console.log(`Filter ${id} set to:`, e.target.checked);
            updateChubFiltersButtonState();
            chubCharacters = [];
            chubCurrentPage = 1;
            loadChubCharacters();
        });
    });
    
    // NSFW toggle - single button toggle
    document.getElementById('chubNsfwToggle')?.addEventListener('click', () => {
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
    document.getElementById('refreshChubBtn')?.addEventListener('click', () => {
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
    document.getElementById('chubLoadMoreBtn')?.addEventListener('click', () => {
        chubCurrentPage++;
        loadChubCharacters();
    });
    
    // Timeline sort dropdown
    document.getElementById('chubTimelineSortSelect')?.addEventListener('change', (e) => {
        chubTimelineSort = e.target.value;
        console.log('[ChubTimeline] Sort changed to:', chubTimelineSort);
        renderChubTimeline(); // Re-render with new sort (client-side sorting)
    });
    
    // Author sort dropdown
    document.getElementById('chubAuthorSortSelect')?.addEventListener('change', (e) => {
        chubAuthorSort = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters(); // Reload with new sort (server-side sorting)
    });
    
    // Character modal handlers
    document.getElementById('chubCharClose')?.addEventListener('click', () => {
        document.getElementById('chubCharModal').classList.add('hidden');
    });
    
    document.getElementById('chubDownloadBtn')?.addEventListener('click', () => {
        downloadChubCharacter();
    });
    
    document.getElementById('chubCharModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'chubCharModal') {
            document.getElementById('chubCharModal').classList.add('hidden');
        }
    });
    
    // API Key modal handlers
    document.getElementById('chubLoginBtn')?.addEventListener('click', () => {
        openChubTokenModal();
    });
    document.getElementById('chubLoginClose')?.addEventListener('click', () => {
        document.getElementById('chubLoginModal')?.classList.add('hidden');
    });
    document.getElementById('chubLoginModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'chubLoginModal') {
            document.getElementById('chubLoginModal')?.classList.add('hidden');
        }
    });
    
    // Token save/clear buttons
    document.getElementById('chubSaveKeyBtn')?.addEventListener('click', saveChubToken);
    document.getElementById('chubClearKeyBtn')?.addEventListener('click', clearChubToken);
    
    // Load saved token on init
    loadChubToken();
    
    // Initialize NSFW toggle state (defaults to enabled)
    updateNsfwToggleState();
    
    console.log('ChubAI view initialized');
}

// ============================================================================
// CHUB TOKEN MANAGEMENT (URQL_TOKEN)
// Uses the gallery settings system for persistent storage
// ============================================================================

function loadChubToken() {
    // First ensure gallery settings are loaded
    loadGallerySettings();
    
    // Get token from settings (server-side persistent)
    const savedToken = getSetting('chubToken');
    if (savedToken) {
        chubToken = savedToken;
        console.log('[ChubToken] Loaded from gallery settings');
        
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
            console.log('[ChubToken] Migrating from localStorage to settings system');
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
    console.log('[ChubToken] Saved to gallery settings (persistent)');
    
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
    console.log('[ChubToken] Cleared from gallery settings');
    
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
}

function renderChubPopularTags() {
    const container = document.getElementById('chubPopularTags');
    if (!container) return;
    
    // Use dynamic tags if available, otherwise fallback
    const tagsToShow = chubPopularTags.length > 0 ? chubPopularTags.slice(0, 12) : CHUB_FALLBACK_TAGS;
    
    container.innerHTML = `
        ${tagsToShow.map(tag => 
            `<button class="chub-tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
        ).join('')}
        <button class="chub-tag-btn chub-more-tags-btn" title="Browse all tags">
            <i class="fa-solid fa-ellipsis"></i> More
        </button>
    `;
    
    container.querySelectorAll('.chub-tag-btn:not(.chub-more-tags-btn)').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('chubSearchInput').value = btn.dataset.tag;
            performChubSearch();
        });
    });
    
    // More tags button opens the tag browser popup
    container.querySelector('.chub-more-tags-btn')?.addEventListener('click', () => {
        openChubTagsPopup();
    });
}

/**
 * Extract popular tags from ChubAI search results
 * Aggregates tags from characters and sorts by frequency
 */
function extractChubTagsFromResults(characters) {
    const tagCounts = new Map();
    
    for (const char of characters) {
        const topics = char.topics || [];
        for (const tag of topics) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag && normalizedTag.length > 1) {
                tagCounts.set(normalizedTag, (tagCounts.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    // Sort by frequency and take top tags
    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([tag]) => tag);
    
    if (sortedTags.length > 0) {
        chubPopularTags = sortedTags;
        renderChubPopularTags();
    }
}

/**
 * Open a popup to browse all ChubAI tags
 */
function openChubTagsPopup() {
    // Remove existing popup if any
    document.getElementById('chubTagsPopup')?.remove();
    
    const tagsToShow = chubPopularTags.length > 0 ? chubPopularTags : CHUB_FALLBACK_TAGS;
    
    const popup = document.createElement('div');
    popup.id = 'chubTagsPopup';
    popup.className = 'chub-tags-popup';
    popup.innerHTML = `
        <div class="chub-tags-popup-content">
            <div class="chub-tags-popup-header">
                <h3><i class="fa-solid fa-tags"></i> Browse Tags</h3>
                <button class="close-btn" id="chubTagsPopupClose">&times;</button>
            </div>
            <div class="chub-tags-popup-search">
                <input type="text" id="chubTagsPopupSearch" placeholder="Filter tags...">
            </div>
            <div class="chub-tags-popup-list" id="chubTagsPopupList">
                ${tagsToShow.map(tag => 
                    `<button class="chub-popup-tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
                ).join('')}
            </div>
        </div>
    `;
    
    document.body.appendChild(popup);
    
    // Close button
    popup.querySelector('#chubTagsPopupClose').addEventListener('click', () => {
        popup.remove();
    });
    
    // Click outside to close
    popup.addEventListener('click', (e) => {
        if (e.target === popup) {
            popup.remove();
        }
    });
    
    // Tag buttons
    popup.querySelectorAll('.chub-popup-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('chubSearchInput').value = btn.dataset.tag;
            popup.remove();
            performChubSearch();
        });
    });
    
    // Filter tags as user types
    const searchInput = popup.querySelector('#chubTagsPopupSearch');
    searchInput.addEventListener('input', (e) => {
        const filter = e.target.value.toLowerCase();
        popup.querySelectorAll('.chub-popup-tag-btn').forEach(btn => {
            const tag = btn.dataset.tag.toLowerCase();
            btn.style.display = tag.includes(filter) ? '' : 'none';
        });
    });
    
    searchInput.focus();
}

function updateChubFiltersButtonState() {
    const btn = document.getElementById('chubFiltersBtn');
    if (!btn) return;
    
    const hasActiveFilters = chubFilterImages || chubFilterLore || 
                             chubFilterExpressions || chubFilterGreetings || 
                             chubFilterVerified || chubFilterFavorites;
    
    btn.classList.toggle('has-filters', hasActiveFilters);
    
    // Update button text to show active filter count
    const count = [chubFilterImages, chubFilterLore, chubFilterExpressions, 
                   chubFilterGreetings, chubFilterVerified, chubFilterFavorites].filter(Boolean).length;
    
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
// CHUBAI VIEW MODE SWITCHING (Browse/Timeline)
// ============================================================================

function switchChubViewMode(mode) {
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
        
        // Show browse-specific filters
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        if (discoveryPreset) discoveryPreset.style.display = '';
        document.getElementById('chubFiltersBtn')?.parentElement?.style.setProperty('display', '');
    } else if (mode === 'timeline') {
        browseSection?.classList.add('hidden');
        timelineSection?.classList.remove('hidden');
        
        // Hide browse-specific filters (not relevant for timeline)
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        if (discoveryPreset) discoveryPreset.style.display = 'none';
        document.getElementById('chubFiltersBtn')?.parentElement?.style.setProperty('display', 'none');
        
        // Load timeline if not loaded
        if (chubTimelineCharacters.length === 0) {
            loadChubTimeline();
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
        grid.innerHTML = '<div class="chub-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading timeline...</div>';
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
            console.log('[ChubTimeline] Loading next page with cursor');
        }
        
        const headers = {
            'Accept': 'application/json',
            'Authorization': `Bearer ${chubToken}`
        };
        
        console.log('[ChubTimeline] Loading timeline, nsfw:', chubNsfwEnabled);
        
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
        
        console.log('[ChubTimeline] Got', nodes.length, 'items from API');
        
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
            const newChars = characterNodes.filter(c => !existingPaths.has(c.fullPath || c.full_path));
            chubTimelineCharacters = [...chubTimelineCharacters, ...newChars];
        }
        
        console.log('[ChubTimeline] Total characters:', chubTimelineCharacters.length);
        
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
        
        // Limit auto-loading to prevent infinite loops (max 15 pages)
        if (shouldAutoLoad && chubTimelinePage < 15) {
            console.log('[ChubTimeline] Auto-loading next page... (have', chubTimelineCharacters.length, 'chars so far)');
            chubTimelinePage++;
            await loadChubTimeline(false);
            return;
        }
        
        // Timeline API is unreliable - supplement with direct author fetches
        // Only do this on first load (no cursor yet used)
        if (!chubTimelineCursor && chubTimelinePage === 1) {
            console.log('[ChubTimeline] Supplementing with direct author fetches...');
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
 * Debug function to test fetching a specific character or author
 * Call from console: debugChubFetch('AdventureTales')
 * Or: debugChubFetch('AdventureTales', 'a-yandere-s-love-755554160743')
 */
window.debugChubFetch = async function(author, charSlug = null) {
    console.log('=== DEBUG CHUB FETCH ===');
    console.log('Author:', author, 'Slug:', charSlug);
    console.log('NSFW enabled:', chubNsfwEnabled);
    console.log('Token present:', !!chubToken);
    
    try {
        // If slug provided, try to fetch the specific character
        if (charSlug) {
            const fullPath = `${author}/${charSlug}`;
            console.log('Fetching specific character:', fullPath);
            
            const charUrl = `${CHUB_API_BASE}/api/characters/${fullPath}`;
            console.log('URL:', charUrl);
            
            const charResp = await fetch(charUrl, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': chubToken ? `Bearer ${chubToken}` : ''
                }
            });
            
            console.log('Response status:', charResp.status);
            const charData = await charResp.json();
            console.log('Character data:', charData);
            
            // Data is nested under 'node'
            const node = charData.node || charData.data?.node || charData;
            
            // Check for visibility/nsfw settings
            if (node) {
                console.log('--- Character Details ---');
                console.log('Name:', node.name);
                console.log('ID:', node.id);
                console.log('NSFW:', node.nsfw);
                console.log('NSFL:', node.nsfl);
                console.log('Public:', node.public);
                console.log('Unlisted:', node.unlisted);  // THIS IS THE KEY!
                console.log('Private:', node.private);
                console.log('Created:', node.createdAt || node.created_at);
                console.log('Full node:', node);
            }
        }
        
        // Also search for the author's characters
        console.log('\n--- Searching author characters ---');
        const params = new URLSearchParams();
        params.set('username', author);
        params.set('first', '50'); // Get more to see full list
        params.set('sort', 'id');
        params.set('nsfw', 'true'); // Force true to see all
        params.set('nsfl', 'true'); // Force true to see all
        params.set('include_forks', 'true'); // Include forked characters
        
        const searchUrl = `${CHUB_API_BASE}/search?${params.toString()}`;
        console.log('Search URL:', searchUrl);
        
        const searchResp = await fetch(searchUrl, {
            headers: {
                'Accept': 'application/json',
                'Authorization': chubToken ? `Bearer ${chubToken}` : ''
            }
        });
        
        console.log('Search status:', searchResp.status);
        const searchData = await searchResp.json();
        console.log('Total count:', searchData.count || searchData.data?.count);
        
        const nodes = searchData.nodes || searchData.data?.nodes || [];
        console.log('Returned nodes:', nodes.length);
        
        // List all characters
        console.log('\nAll characters from', author + ':');
        nodes.forEach((n, i) => {
            console.log(`  ${i}: "${n.name}" id=${n.id} path=${n.fullPath} created=${n.createdAt || n.created_at}`);
        });
        
        // Check if the specific character is in the list
        if (charSlug) {
            const found = nodes.find(n => (n.fullPath || '').toLowerCase().includes(charSlug.toLowerCase()));
            console.log('\nTarget character in search results:', found ? 'YES' : 'NO');
            if (found) console.log('Found:', found);
        }
        
    } catch (e) {
        console.error('Debug fetch error:', e);
    }
};

/**
 * Debug function to test different timeline API parameters
 * Call from console: debugTimelineAPI()
 */
window.debugTimelineAPI = async function() {
    console.log('=== DEBUG TIMELINE API ===');
    console.log('Token present:', !!chubToken);
    
    if (!chubToken) {
        console.log('No token - cannot test authenticated endpoints');
        return;
    }
    
    // Test different endpoints and parameters
    const tests = [
        { name: 'timeline/v1 default', url: '/api/timeline/v1?first=50&nsfw=true&count=true' },
        { name: 'timeline/v1 with unlisted', url: '/api/timeline/v1?first=50&nsfw=true&include_unlisted=true&count=true' },
        { name: 'timeline/v1 with visibility', url: '/api/timeline/v1?first=50&nsfw=true&visibility=all&count=true' },
        { name: 'feed endpoint', url: '/api/feed?first=50&nsfw=true' },
        { name: 'notifications', url: '/api/notifications?first=50' },
        { name: 'activity', url: '/api/activity?first=50' },
    ];
    
    for (const test of tests) {
        console.log(`\n--- Testing: ${test.name} ---`);
        console.log('URL:', CHUB_API_BASE + test.url);
        
        try {
            const resp = await fetch(CHUB_API_BASE + test.url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${chubToken}`
                }
            });
            
            console.log('Status:', resp.status);
            
            if (resp.ok) {
                const data = await resp.json();
                console.log('Response:', data);
                
                const nodes = data.nodes || data.data?.nodes || [];
                console.log('Nodes count:', nodes.length);
                
                // Check if our target character is in there
                const hasYandere = nodes.some(n => 
                    (n.name || '').toLowerCase().includes('yandere') ||
                    (n.fullPath || '').toLowerCase().includes('yandere')
                );
                console.log('Contains "Yandere" character:', hasYandere ? 'YES!' : 'no');
                
                if (hasYandere) {
                    const yandere = nodes.find(n => 
                        (n.name || '').toLowerCase().includes('yandere') ||
                        (n.fullPath || '').toLowerCase().includes('yandere')
                    );
                    console.log('Found:', yandere);
                }
            } else {
                const text = await resp.text();
                console.log('Error response:', text.substring(0, 200));
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
    }
};

/**
 * Supplement timeline with direct fetches from followed authors
 * This works around the broken timeline API that doesn't return all items
 */
async function supplementTimelineWithAuthorFetches() {
    try {
        // Get list of followed authors
        const followedAuthors = await fetchMyFollowsList();
        if (!followedAuthors || followedAuthors.size === 0) {
            console.log('[ChubTimeline] No followed authors to fetch from');
            return;
        }
        
        console.log('[ChubTimeline] Fetching recent chars from', followedAuthors.size, 'followed authors');
        
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
                        headers: {
                            'Accept': 'application/json',
                            'Authorization': `Bearer ${chubToken}`
                        }
                    });
                    
                    if (!response.ok) {
                        console.log(`[ChubTimeline] Error from ${author}: ${response.status}`);
                        return [];
                    }
                    
                    const data = await response.json();
                    const nodes = data.nodes || data.data?.nodes || [];
                    return nodes;
                } catch (e) {
                    console.log(`[ChubTimeline] Error fetching from ${author}:`, e.message);
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
        
        console.log('[ChubTimeline] After supplement, have', chubTimelineCharacters.length, 'total characters');
        
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
            return characters.sort((a, b) => {
                const dlA = a.nDownloads || a.n_downloads || a.downloadCount || a.download_count || 0;
                const dlB = b.nDownloads || b.n_downloads || b.downloadCount || b.download_count || 0;
                return dlB - dlA;
            });
        case 'rating':
            // Sort by star count descending
            return characters.sort((a, b) => {
                const starsA = a.starCount || a.star_count || a.nStars || a.n_stars || 0;
                const starsB = b.starCount || b.star_count || b.nStars || b.n_stars || 0;
                return starsB - starsA;
            });
        default:
            return characters;
    }
}

function renderChubTimeline() {
    const grid = document.getElementById('chubTimelineGrid');
    
    // Sort the characters based on chubTimelineSort
    const sortedCharacters = sortTimelineCharacters([...chubTimelineCharacters]);
    
    grid.innerHTML = sortedCharacters.map(char => createChubCard(char, true)).join('');
    
    // Add click handlers
    grid.querySelectorAll('.chub-card').forEach(card => {
        const fullPath = card.dataset.fullPath;
        const char = sortedCharacters.find(c => c.fullPath === fullPath);
        
        card.addEventListener('click', (e) => {
            // Don't open preview if clicking on author link
            if (e.target.closest('.chub-card-creator-link')) return;
            openChubCharPreview(char);
        });
        
        // Author click handler
        card.querySelector('.chub-card-creator-link')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const author = e.target.dataset.author;
            if (author) {
                filterByAuthor(author);
            }
        });
    });
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
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${chubToken}`
            }
        });
        
        if (!accountResp.ok) {
            console.log('[ChubFollow] Could not get account info');
            return [];
        }
        
        const accountData = await accountResp.json();
        
        // API returns user_name (with underscore), not username
        const myUsername = accountData.user_name || accountData.name || accountData.username || 
                          accountData.data?.user_name || accountData.data?.name;
        
        if (!myUsername) {
            console.log('[ChubFollow] No username found in account data');
            return [];
        }
        
        // Now get who we follow
        const followsResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=1`, {
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${chubToken}`
            }
        });
        
        if (!followsResp.ok) {
            console.log('[ChubFollow] Could not get follows list');
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
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${chubToken}`
                }
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
        console.log('[ChubFollow] Following', followedUsernames.size, 'users:', [...followedUsernames]);
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
        console.log('[ChubFollow] Checking if following', authorName, ':', chubIsFollowingCurrentAuthor);
    } catch (e) {
        console.log('[ChubFollow] Could not check follow status:', e);
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
        const response = await fetch(`${CHUB_API_BASE}/api/follow/${chubAuthorFilter}`, {
            method: method,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${chubToken}`
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubFollow] Error:', response.status, errorText);
            throw new Error(`Failed: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[ChubFollow] Response:', data);
        
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
    document.getElementById('chubAuthorBanner')?.classList.add('hidden');
    
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
        document.getElementById('chubAuthorBanner')?.classList.add('hidden');
    }
    chubCharacters = [];
    chubCurrentPage = 1;
    loadChubCharacters();
}

async function loadChubCharacters(forceRefresh = false) {
    if (chubIsLoading) return;
    
    const grid = document.getElementById('chubGrid');
    const loadMoreContainer = document.getElementById('chubLoadMore');
    
    if (chubCurrentPage === 1) {
        grid.innerHTML = '<div class="chub-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading ChubAI characters...</div>';
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
        params.set('min_tokens', '50');
        
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
        if (chubFilterVerified) {
            params.set('recommended_verified', 'true');
        }
        
        // Favorites filter (requires URQL token)
        // API uses 'my_favorites' parameter per OpenAPI spec
        if (chubFilterFavorites && chubToken) {
            params.set('my_favorites', 'true');
        }
        
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        };
        
        // Add Authorization header if token available (URQL_TOKEN from chub.ai)
        if (chubToken) {
            headers['Authorization'] = `Bearer ${chubToken}`;
        }
        
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
            chubCharacters = [...chubCharacters, ...nodes];
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

function renderChubGrid() {
    const grid = document.getElementById('chubGrid');
    
    if (chubCharacters.length === 0) {
        grid.innerHTML = `
            <div class="chub-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Characters Found</h3>
                <p>Try a different search term or adjust your filters.</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = chubCharacters.map(char => createChubCard(char)).join('');
    
    // Add click handlers
    grid.querySelectorAll('.chub-card').forEach(card => {
        const fullPath = card.dataset.fullPath;
        const char = chubCharacters.find(c => c.fullPath === fullPath);
        
        card.addEventListener('click', (e) => {
            // Don't open preview if clicking on author link
            if (e.target.closest('.chub-card-creator-link')) return;
            openChubCharPreview(char);
        });
        
        // Author click handler
        card.querySelector('.chub-card-creator-link')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const author = e.target.dataset.author;
            if (author) {
                filterByAuthor(author);
            }
        });
    });
}

function createChubCard(char, isTimeline = false) {
    const name = char.name || 'Unknown';
    const creatorName = char.fullPath?.split('/')[0] || 'Unknown';
    const rating = char.rating ? char.rating.toFixed(1) : '0.0';
    const downloads = formatNumber(char.starCount || 0);
    const avatarUrl = char.avatar_url || `https://avatars.charhub.io/avatars/${char.fullPath}/avatar.webp`;
    
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
        <div class="${cardClass}" data-full-path="${escapeHtml(char.fullPath || '')}" ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="chub-card-image">
                <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.src='/img/ai4.png'">
                ${char.nsfw ? '<span class="chub-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="chub-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="chub-card-body">
                <div class="chub-card-name">${escapeHtml(name)}</div>
                <span class="chub-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                <div class="chub-card-tags">
                    ${tags.map(t => `<span class="chub-card-tag">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="chub-card-footer">
                <span class="chub-card-stat"><i class="fa-solid fa-star"></i> ${rating}</span>
                <span class="chub-card-stat"><i class="fa-solid fa-download"></i> ${downloads}</span>
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

async function openChubCharPreview(char) {
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
    
    const avatarUrl = char.avatar_url || `https://avatars.charhub.io/avatars/${char.fullPath}/avatar.webp`;
    const creatorName = char.fullPath?.split('/')[0] || 'Unknown';
    
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
    openInBrowserBtn.href = `https://chub.ai/characters/${char.fullPath}`;
    ratingEl.innerHTML = `<i class="fa-solid fa-star"></i> ${char.rating ? char.rating.toFixed(1) : '0.0'}`;
    downloadsEl.innerHTML = `<i class="fa-solid fa-download"></i> ${formatNumber(char.starCount || 0)}`;
    
    // Tags
    const tags = char.topics || [];
    tagsEl.innerHTML = tags.map(t => `<span class="chub-tag">${escapeHtml(t)}</span>`).join('');
    
    // Stats
    tokensEl.textContent = formatNumber(char.nTokens || 0);
    dateEl.textContent = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : 'Unknown';
    
    // Creator's Notes (public ChubAI listing description) - use secure iframe renderer
    renderCreatorNotesSecure(char.description || char.tagline || 'No description available.', char.name, creatorNotesEl);
    
    // Tagline
    if (char.tagline && char.tagline !== char.description) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = formatRichText(char.tagline, char.name);
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
    
    modal.classList.remove('hidden');
    
    // Try to fetch detailed character info
    try {
        const detailUrl = `https://api.chub.ai/api/characters/${char.fullPath}?full=true`;
        
        const response = await fetch(detailUrl);
        if (response.ok) {
            const detailData = await response.json();
            const node = detailData.node || detailData;
            const def = node.definition || node;
            
            // Update Creator's Notes if node has better/different description than search result
            if (node.description && node.description !== char.description) {
                renderCreatorNotesSecure(node.description, char.name, creatorNotesEl);
            }
            
            // Definition Description (character definition that goes into prompt)
            if (def.description) {
                descSection.style.display = 'block';
                descEl.innerHTML = formatRichText(def.description, char.name);
            }
            
            // Personality
            if (def.personality) {
                personalitySection.style.display = 'block';
                personalityEl.innerHTML = formatRichText(def.personality, char.name);
            }
            
            // Scenario  
            if (def.scenario) {
                scenarioSection.style.display = 'block';
                scenarioEl.innerHTML = formatRichText(def.scenario, char.name);
            }
            
            // First message preview (truncated)
            if (def.first_mes) {
                firstMsgSection.style.display = 'block';
                const truncatedMsg = def.first_mes.length > 800 
                    ? def.first_mes.substring(0, 800) + '...' 
                    : def.first_mes;
                firstMsgEl.innerHTML = formatRichText(truncatedMsg, char.name);
            }
            
            // Update greetings count if we have better data
            if (def.alternate_greetings?.length > 0) {
                greetingsStat.style.display = 'flex';
                greetingsCount.textContent = def.alternate_greetings.length + 1;
            }
        }
    } catch (e) {
        console.log('[ChubAI] Could not fetch detailed character info:', e.message);
        // Modal still works with basic info
    }
}

async function downloadChubCharacter() {
    if (!chubSelectedChar) return;
    
    const downloadBtn = document.getElementById('chubDownloadBtn');
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    downloadBtn.disabled = true;
    
    try {
        // Use the same method as the working importChubCharacter function
        const fullPath = chubSelectedChar.fullPath;
        
        // Fetch complete character data from the API
        const metadata = await fetchChubMetadata(fullPath);
        
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
                
                downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                
                // Use the proper delete function that syncs with ST
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (deleteSuccess) {
                    console.log('[ChubDownload] Deleted existing character:', toReplace.avatar);
                } else {
                    console.warn('[ChubDownload] Could not delete existing character, proceeding with import anyway');
                }
            }
            // If choice is 'import', continue with import normally
        }
        // === END DUPLICATE CHECK ===
        
        downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';
        
        // Build the character card JSON from API data
        const characterCard = buildCharacterCardFromChub(metadata);
        
        console.log('[ChubDownload] Character card built:', {
            name: characterCard.data.name,
            first_mes_length: characterCard.data.first_mes?.length,
            description_length: characterCard.data.description?.length
        });
        
        // Fetch the PNG image from avatars CDN
        const pngUrl = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
        const response = await fetch(pngUrl);
        
        if (!response.ok) {
            throw new Error(`Image download failed: ${response.status}`);
        }
        
        // Get the PNG as ArrayBuffer
        const pngBuffer = await response.arrayBuffer();
        
        // Embed character data into PNG
        const embeddedPng = embedCharacterDataInPng(pngBuffer, characterCard);
        
        console.log('[ChubDownload] PNG embedded, size:', embeddedPng.length, 'bytes');
        
        // Create a Blob and File from the embedded PNG (match importChubCharacter exactly)
        const blob = new Blob([embeddedPng], { type: 'image/png' });
        const fileName = fullPath.split('/').pop() + '.png';
        const file = new File([blob], fileName, { type: 'image/png' });
        
        // Create FormData for SillyTavern import
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');
        
        // Get CSRF token
        const csrfToken = getQueryParam('csrf') || getCookie('X-CSRF-Token');
        
        // Import to SillyTavern (use exact same endpoint as importChubCharacter)
        const importResponse = await fetch('/api/characters/import', {
            method: 'POST',
            headers: {
                'X-CSRF-Token': csrfToken
            },
            body: formData
        });
        
        // Read response as text first, then parse (same as importChubCharacter)
        const responseText = await importResponse.text();
        console.log('[ChubDownload] Import response:', importResponse.status, responseText);
        
        if (!importResponse.ok) {
            throw new Error(`Import error: ${responseText}`);
        }
        
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Invalid JSON response: ${responseText}`);
        }
        
        // Check for error in response body
        if (result.error) {
            throw new Error('Import failed: Server returned error');
        }
        
        // Close the character modal
        document.getElementById('chubCharModal').classList.add('hidden');
        
        // Check if character has gallery
        const hasGallery = metadata.hasGallery || false;
        
        showToast(`Downloaded "${characterName}" successfully!`, 'success');
        
        // Try to refresh the main SillyTavern window's character list
        try {
            if (window.opener && !window.opener.closed && window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                const context = window.opener.SillyTavern.getContext();
                if (context && typeof context.getCharacters === 'function') {
                    console.log('[ChubDownload] Triggering character refresh in main window...');
                    await context.getCharacters();
                }
            }
        } catch (e) {
            console.warn('[ChubDownload] Could not refresh main window characters:', e);
        }
        
        // Refresh the gallery (force API fetch since we just imported)
        fetchCharacters(true);
        
        // Show gallery info modal if the character has a gallery
        if (hasGallery) {
            showChubGalleryModal([{
                success: true,
                characterName: characterName,
                fullPath: fullPath,
                hasGallery: true
            }]);
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
