/**
 * Module Loader for SillyTavern Character Library
 * Handles initialization of external modules and provides bridge to gallery.js
 * 
 * This file is loaded after gallery.js and initializes additional feature modules
 */

import * as CoreAPI from './core-api.js';

// ========================================
// MODULE REGISTRY
// ========================================

const ModuleLoader = {
    modules: {},
    initialized: false,
    
    /**
     * Register a module
     * @param {string} name - Module name
     * @param {Object} module - Module object with init function
     */
    register(name, module) {
        this.modules[name] = module;
        console.log(`[ModuleLoader] Registered module: ${name}`);
    },
    
    /**
     * Initialize all registered modules
     * @param {Object} dependencies - Shared dependencies from gallery.js
     */
    async initAll(dependencies) {
        for (const [name, module] of Object.entries(this.modules)) {
            try {
                if (module.init) {
                    await module.init(dependencies);
                    console.log(`[ModuleLoader] Initialized module: ${name}`);
                }
            } catch (err) {
                console.error(`[ModuleLoader] Failed to initialize module: ${name}`, err);
            }
        }
        this.initialized = true;
    },
    
    /**
     * Get a registered module
     * @param {string} name - Module name
     * @returns {Object|null} Module or null if not found
     */
    get(name) {
        return this.modules[name] || null;
    }
};

// ========================================
// MULTI-SELECT SYSTEM
// ========================================

const MultiSelect = {
    enabled: false,
    selectedCharacters: new Map(), // avatar -> character object
    
    /**
     * Enable multi-select mode
     */
    enable() {
        this.enabled = true;
        document.body.classList.add('multi-select-mode');
        
        // Add active state to toggle button
        document.getElementById('multiSelectToggleBtn')?.classList.add('active');
        
        this.updateToolbar();
        console.log('[MultiSelect] Mode enabled');
    },
    
    /**
     * Disable multi-select mode and clear selection
     */
    disable() {
        this.enabled = false;
        this.selectedCharacters.clear();
        document.body.classList.remove('multi-select-mode');
        
        // Remove selection UI from all cards
        document.querySelectorAll('.char-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        
        // Remove active state from toggle button
        document.getElementById('multiSelectToggleBtn')?.classList.remove('active');
        
        this.updateToolbar();
        console.log('[MultiSelect] Mode disabled');
    },
    
    /**
     * Toggle selection of a character
     * @param {Object} char - Character object
     * @param {HTMLElement} cardElement - The card DOM element
     */
    toggle(char, cardElement) {
        if (!this.enabled) return;
        
        const avatar = char.avatar;
        
        if (this.selectedCharacters.has(avatar)) {
            this.selectedCharacters.delete(avatar);
            cardElement?.classList.remove('selected');
        } else {
            this.selectedCharacters.set(avatar, char);
            cardElement?.classList.add('selected');
        }
        
        this.updateToolbar();
    },
    
    /**
     * Select all currently visible characters
     */
    selectAll() {
        if (!this.enabled) return;
        
        document.querySelectorAll('.char-card').forEach(card => {
            const avatar = card.dataset.avatar;
            if (avatar) {
                const char = CoreAPI.getCharacterByAvatar(avatar);
                if (char && !this.selectedCharacters.has(avatar)) {
                    this.selectedCharacters.set(avatar, char);
                    card.classList.add('selected');
                }
            }
        });
        
        this.updateToolbar();
    },
    
    /**
     * Clear all selections
     */
    clearSelection() {
        this.selectedCharacters.clear();
        document.querySelectorAll('.char-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        this.updateToolbar();
    },
    
    /**
     * Get array of selected characters
     * @returns {Array} Selected character objects
     */
    getSelected() {
        return Array.from(this.selectedCharacters.values());
    },
    
    /**
     * Get count of selected characters
     * @returns {number} Selection count
     */
    getCount() {
        return this.selectedCharacters.size;
    },
    
    /**
     * Update the multi-select toolbar UI
     */
    updateToolbar() {
        const toolbar = document.getElementById('multiSelectToolbar');
        const countEl = document.getElementById('multiSelectCount');
        
        if (!toolbar) return;
        
        if (this.enabled) {
            toolbar.classList.remove('hidden');
            if (countEl) {
                countEl.textContent = this.selectedCharacters.size;
            }
            // Update favorite toggle button state
            updateFavoriteToggleState();
        } else {
            toolbar.classList.add('hidden');
        }
    },
    
    /**
     * Check if a character is selected
     * @param {string} avatar - Character avatar
     * @returns {boolean} Whether selected
     */
    isSelected(avatar) {
        return this.selectedCharacters.has(avatar);
    }
};

/**
 * Check if all selected characters are favorited
 * @returns {boolean} True if all selected are favorites
 */
function areAllSelectedFavorited() {
    const selected = MultiSelect.getSelected();
    if (selected.length === 0) return false;
    
    return selected.every(char => {
        return char.fav === true || char.fav === 'true' ||
               char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true';
    });
}

/**
 * Update the favorite toggle button appearance based on selection state
 */
function updateFavoriteToggleState() {
    const btn = document.getElementById('multiSelectFavToggleBtn');
    if (!btn) return;
    
    const selected = MultiSelect.getSelected();
    if (selected.length === 0) {
        // No selection - show default "Favorite" state
        btn.innerHTML = '<i class="fa-solid fa-star"></i><span>Favorite</span>';
        btn.title = 'Add all to favorites';
        btn.classList.remove('ms-btn-ghost');
        return;
    }
    
    const allFavorited = areAllSelectedFavorited();
    
    if (allFavorited) {
        // All are favorited - show "Unfavorite" state
        btn.innerHTML = '<i class="fa-regular fa-star"></i><span>Unfavorite</span>';
        btn.title = 'Remove all from favorites';
        btn.classList.add('ms-btn-ghost');
    } else {
        // Some or none are favorited - show "Favorite" state
        btn.innerHTML = '<i class="fa-solid fa-star"></i><span>Favorite</span>';
        btn.title = 'Add all to favorites';
        btn.classList.remove('ms-btn-ghost');
    }
}

// ========================================
// TOOLBAR INJECTION
// ========================================

function injectMultiSelectToolbar() {
    // Check if already injected
    if (document.getElementById('multiSelectToolbar')) return;
    
    const toolbarHtml = `
    <div id="multiSelectToolbar" class="multi-select-toolbar hidden">
        <div class="multi-select-left">
            <div class="multi-select-badge">
                <i class="fa-solid fa-layer-group"></i>
                <span id="multiSelectCount">0</span>
            </div>
            <span class="multi-select-label">characters selected</span>
        </div>
        
        <div class="multi-select-actions">
            <button id="multiSelectAllBtn" class="ms-btn ms-btn-ghost" title="Select all visible characters">
                <i class="fa-solid fa-check-double"></i>
                <span>Select All</span>
            </button>
            
            <div class="ms-divider"></div>
            
            <button id="multiSelectBatchTagBtn" class="ms-btn" title="Edit tags on selected characters">
                <i class="fa-solid fa-tags"></i>
                <span>Tags</span>
            </button>
            <button id="multiSelectFavToggleBtn" class="ms-btn" title="Toggle favorites">
                <i class="fa-solid fa-star"></i>
                <span>Favorite</span>
            </button>
            <button id="multiSelectExportBtn" class="ms-btn" title="Export all selected characters">
                <i class="fa-solid fa-download"></i>
                <span>Export</span>
            </button>
            
            <div class="ms-divider"></div>
            
            <button id="multiSelectDeleteBtn" class="ms-btn ms-btn-danger" title="Delete all selected characters">
                <i class="fa-solid fa-trash"></i>
                <span>Delete</span>
            </button>
        </div>
        
        <div class="multi-select-right">
            <button id="multiSelectExitBtn" class="ms-btn ms-btn-exit" title="Exit multi-select mode (Esc)">
                <i class="fa-solid fa-arrow-right-from-bracket"></i>
            </button>
        </div>
    </div>`;
    
    // Insert before the main gallery content (after header)
    const galleryContent = document.querySelector('.gallery-content');
    if (galleryContent) {
        galleryContent.insertAdjacentHTML('beforebegin', toolbarHtml);
    } else {
        // Fallback: insert after header
        const header = document.querySelector('header.topbar');
        if (header) {
            header.insertAdjacentHTML('afterend', toolbarHtml);
        } else {
            document.body.insertAdjacentHTML('afterbegin', toolbarHtml);
        }
    }
    
    // Setup event listeners
    document.getElementById('multiSelectAllBtn')?.addEventListener('click', () => MultiSelect.selectAll());
    document.getElementById('multiSelectExitBtn')?.addEventListener('click', () => MultiSelect.disable());
    
    document.getElementById('multiSelectBatchTagBtn')?.addEventListener('click', () => {
        const batchTagging = ModuleLoader.get('batch-tagging');
        if (batchTagging && batchTagging.openModal) {
            batchTagging.openModal();
        }
    });
    
    // Bulk actions - delegate to context-menu module
    document.getElementById('multiSelectFavToggleBtn')?.addEventListener('click', () => {
        const contextMenu = ModuleLoader.get('context-menu');
        // Check if all selected are favorited - if so, unfavorite; otherwise favorite all
        const allFavorited = areAllSelectedFavorited();
        contextMenu?.bulkToggleFavorites?.(!allFavorited);
    });
    
    document.getElementById('multiSelectExportBtn')?.addEventListener('click', () => {
        const contextMenu = ModuleLoader.get('context-menu');
        contextMenu?.bulkExport?.();
    });
    
    document.getElementById('multiSelectDeleteBtn')?.addEventListener('click', () => {
        const contextMenu = ModuleLoader.get('context-menu');
        contextMenu?.bulkDelete?.();
    });
}

function injectMultiSelectToggle() {
    // Add toggle button to filter area (next to refresh button)
    const filterArea = document.getElementById('filterArea');
    const refreshBtn = document.getElementById('refreshBtn');
    
    if (!filterArea || !refreshBtn) {
        console.warn('[ModuleLoader] Could not find filter area or refresh button');
        return;
    }
    
    // Check if already exists
    if (document.getElementById('multiSelectToggleBtn')) return;
    
    const toggleHtml = `
    <button id="multiSelectToggleBtn" class="glass-btn icon-only" title="Multi-select mode (Space to toggle, Esc to exit)">
        <i class="fa-solid fa-object-group"></i>
    </button>`;
    
    // Insert after the refresh button
    refreshBtn.insertAdjacentHTML('afterend', toggleHtml);
    
    document.getElementById('multiSelectToggleBtn')?.addEventListener('click', () => {
        const btn = document.getElementById('multiSelectToggleBtn');
        if (MultiSelect.enabled) {
            MultiSelect.disable();
            btn?.classList.remove('active');
        } else {
            MultiSelect.enable();
            btn?.classList.add('active');
        }
    });
}

function injectMultiSelectStyles() {
    if (document.getElementById('multi-select-styles')) return;
    
    const styles = `
    <style id="multi-select-styles">
        /* Multi-select mode indicator */
        body.multi-select-mode .char-card {
            cursor: pointer;
            position: relative;
        }
        
        body.multi-select-mode .char-card::before {
            content: '';
            position: absolute;
            top: 8px;
            left: 8px;
            width: 24px;
            height: 24px;
            border: 2px solid rgba(255, 255, 255, 0.5);
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.3);
            z-index: 10;
            transition: all 0.2s;
        }
        
        body.multi-select-mode .char-card.selected::before {
            background: var(--SmartThemeQuoteColor, #4a9eff);
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        
        body.multi-select-mode .char-card.selected::after {
            content: '✓';
            position: absolute;
            top: 8px;
            left: 8px;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 14px;
            z-index: 11;
        }
        
        body.multi-select-mode .char-card:hover::before {
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        
        /* Multi-select toolbar */
        .multi-select-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            background: linear-gradient(135deg, rgba(26, 26, 46, 0.95) 0%, rgba(30, 30, 50, 0.95) 100%);
            border-bottom: 1px solid rgba(74, 158, 255, 0.2);
            gap: 16px;
            backdrop-filter: blur(10px);
            box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
        }
        
        .multi-select-toolbar.hidden {
            display: none;
        }
        
        .multi-select-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .multi-select-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            background: linear-gradient(135deg, var(--SmartThemeQuoteColor, #4a9eff) 0%, #6366f1 100%);
            padding: 6px 12px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.95em;
            color: white;
            box-shadow: 0 2px 8px rgba(74, 158, 255, 0.3);
        }
        
        .multi-select-badge i {
            font-size: 0.9em;
            opacity: 0.9;
        }
        
        .multi-select-label {
            color: var(--SmartThemeBodyColor, #aaa);
            font-size: 0.9em;
        }
        
        .multi-select-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex: 1;
            justify-content: center;
        }
        
        .multi-select-right {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .ms-divider {
            width: 1px;
            height: 24px;
            background: rgba(255, 255, 255, 0.15);
            margin: 0 6px;
        }
        
        .ms-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            border-radius: 8px;
            border: 1px solid transparent;
            background: rgba(255, 255, 255, 0.08);
            color: var(--SmartThemeBodyColor, #eee);
            cursor: pointer;
            font-size: 0.85em;
            font-weight: 500;
            transition: all 0.2s ease;
            white-space: nowrap;
        }
        
        .ms-btn:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.1);
            transform: translateY(-1px);
        }
        
        .ms-btn:active {
            transform: translateY(0);
        }
        
        .ms-btn i {
            font-size: 0.95em;
        }
        
        .ms-btn-ghost {
            background: transparent;
        }
        
        .ms-btn-ghost:hover {
            background: rgba(255, 255, 255, 0.08);
        }
        
        .ms-btn-danger {
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
            border-color: rgba(239, 68, 68, 0.2);
        }
        
        .ms-btn-danger:hover {
            background: rgba(239, 68, 68, 0.25);
            border-color: rgba(239, 68, 68, 0.4);
        }
        
        .ms-btn-exit {
            background: rgba(100, 100, 120, 0.3);
            padding: 8px 10px;
        }
        
        .ms-btn-exit:hover {
            background: rgba(100, 100, 120, 0.5);
        }
        
        /* Hide text on smaller screens */
        @media (max-width: 900px) {
            .ms-btn span {
                display: none;
            }
            .ms-btn {
                padding: 8px 10px;
            }
            .multi-select-label {
                display: none;
            }
        }
        
        /* Toggle button active state */
        #multiSelectToggleBtn.active {
            background: linear-gradient(135deg, var(--SmartThemeQuoteColor, #4a9eff) 0%, #6366f1 100%);
            color: white;
            box-shadow: 0 2px 8px rgba(74, 158, 255, 0.3);
        }
    </style>`;
    
    document.head.insertAdjacentHTML('beforeend', styles);
}

// ========================================
// INITIALIZATION
// ========================================

async function initModuleSystem() {
    console.log('[ModuleLoader] Initializing module system...');
    
    // Inject multi-select UI
    injectMultiSelectStyles();
    injectMultiSelectToolbar();
    injectMultiSelectToggle();
    
    // Setup keyboard shortcuts (Space for selection)
    setupKeyboardShortcuts();
    
    // Modules now use CoreAPI directly, but we still pass a minimal deps object
    // for backwards compatibility during transition
    const dependencies = {};
    
    // Dynamically import modules
    try {
        const batchTaggingModule = await import('./batch-tagging.js');
        ModuleLoader.register('batch-tagging', batchTaggingModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load batch-tagging module:', err);
    }
    
    try {
        const contextMenuModule = await import('./context-menu.js');
        ModuleLoader.register('context-menu', contextMenuModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load context-menu module:', err);
    }
    
    try {
        const galleryViewerModule = await import('./gallery-viewer.js');
        ModuleLoader.register('gallery-viewer', galleryViewerModule.default);
        
        // Expose gallery viewer functions for library.js to use
        window.openGalleryViewer = galleryViewerModule.openViewer;
        window.openGalleryViewerWithImages = galleryViewerModule.openViewerWithImages;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-viewer module:', err);
    }
    
    try {
        const cardUpdatesModule = await import('./card-updates.js');
        ModuleLoader.register('card-updates', cardUpdatesModule.default);
        
        // Expose card updates functions for library.js to use
        window.checkCardUpdates = cardUpdatesModule.checkSingleCharacter;
        window.checkAllCardUpdates = cardUpdatesModule.checkAllLinkedCharacters;
        window.checkSelectedCardUpdates = cardUpdatesModule.checkSelectedCharacters;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load card-updates module:', err);
    }
    
    try {
        const gallerySyncModule = await import('./gallery-sync.js');
        ModuleLoader.register('gallery-sync', gallerySyncModule.default);
        
        // Expose gallery sync functions for library.js to use
        window.auditGalleryIntegrity = gallerySyncModule.auditGalleryIntegrity;
        window.fullGallerySync = gallerySyncModule.fullSync;
        window.cleanupOrphanedMappings = gallerySyncModule.cleanupOrphanedMappings;
        window.updateGallerySyncWarning = gallerySyncModule.updateWarningIndicator;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-sync module:', err);
    }
    
    // Initialize all modules
    await ModuleLoader.initAll(dependencies);
    
    console.log('[ModuleLoader] Module system ready');
}

// ========================================
// CARD CLICK HANDLER INTEGRATION
// ========================================

// This function should be called from gallery.js when a card is clicked
// We'll need to modify gallery.js to check for multi-select mode
window.handleCardClickForMultiSelect = function(char, cardElement) {
    if (MultiSelect.enabled) {
        MultiSelect.toggle(char, cardElement);
        return true; // Handled, don't open modal
    }
    return false; // Not in multi-select mode, proceed with normal behavior
};

// Track last hovered/focused card for keyboard selection
let lastHoveredCard = null;

// Setup keyboard shortcut for Space to toggle selection
function setupKeyboardShortcuts() {
    // Track hovered cards
    document.addEventListener('mouseover', (e) => {
        const card = e.target.closest('.char-card');
        if (card) {
            lastHoveredCard = card;
        }
    });
    
    // Space to toggle multi-select mode
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in input/textarea
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        
        // Space key to toggle multi-select mode
        if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
            
            // Toggle multi-select mode on/off
            if (MultiSelect.enabled) {
                MultiSelect.disable();
            } else {
                MultiSelect.enable();
            }
        }
        
        // Escape to exit multi-select mode
        if (e.key === 'Escape' && MultiSelect.enabled) {
            // Only if no modal is open
            const anyModalOpen = document.querySelector('.modal-overlay:not(.hidden), .cl-modal.visible');
            if (!anyModalOpen) {
                MultiSelect.disable();
                e.preventDefault();
            }
        }
    });
}

// Attach context menu to a card - call from gallery.js when creating cards
window.attachCardContextMenu = function(cardElement, char) {
    const contextMenu = ModuleLoader.get('context-menu');
    if (contextMenu?.attachToCard) {
        contextMenu.attachToCard(cardElement, char);
    }
};

// Expose MultiSelect for gallery.js integration
window.MultiSelect = MultiSelect;
window.ModuleLoader = ModuleLoader;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModuleSystem);
} else {
    // DOM already loaded, init immediately
    setTimeout(initModuleSystem, 100); // Small delay to ensure gallery.js is ready
}
