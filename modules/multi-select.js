/**
 * Multi-Select Module for SillyTavern Character Library
 * Handles multi-select mode, toolbar UI, and keyboard shortcuts
 *
 * @module MultiSelect
 * @version 1.0.0
 */

import * as CoreAPI from './core-api.js';

let isInitialized = false;

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
     * Select all currently filtered characters
     */
    selectAll() {
        if (!this.enabled) return;

        const filteredCharacters = CoreAPI.getCurrentCharacters();
        this.selectedCharacters.clear();

        filteredCharacters.forEach(char => {
            if (char?.avatar) {
                this.selectedCharacters.set(char.avatar, char);
            }
        });

        document.querySelectorAll('.char-card').forEach(card => {
            const avatar = card.dataset.avatar;
            if (!avatar) return;
            if (this.selectedCharacters.has(avatar)) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
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
            <button id="multiSelectAllBtn" class="ms-btn ms-btn-ghost" title="Select all filtered characters">
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
            <button id="multiSelectCheckUpdatesBtn" class="ms-btn" title="Check selected characters for updates on ChubAI">
                <i class="fa-solid fa-arrows-rotate"></i>
                <span>Updates</span>
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
        const batchTagging = CoreAPI.getModule('batch-tagging');
        if (batchTagging?.openModal) {
            batchTagging.openModal();
        }
    });

    // Bulk actions - delegate to context-menu module
    document.getElementById('multiSelectFavToggleBtn')?.addEventListener('click', () => {
        const contextMenu = CoreAPI.getModule('context-menu');
        const allFavorited = areAllSelectedFavorited();
        contextMenu?.bulkToggleFavorites?.(!allFavorited);
    });

    document.getElementById('multiSelectExportBtn')?.addEventListener('click', () => {
        const contextMenu = CoreAPI.getModule('context-menu');
        contextMenu?.bulkExport?.();
    });

    document.getElementById('multiSelectDeleteBtn')?.addEventListener('click', () => {
        const contextMenu = CoreAPI.getModule('context-menu');
        contextMenu?.bulkDelete?.();
    });

    document.getElementById('multiSelectCheckUpdatesBtn')?.addEventListener('click', () => {
        const cardUpdates = CoreAPI.getModule('card-updates');
        if (cardUpdates?.checkSelectedCharacters) {
            cardUpdates.checkSelectedCharacters();
        }
    });
}

function injectMultiSelectToggle() {
    // Add toggle button to filter area (next to refresh button)
    const filterArea = document.getElementById('filterArea');
    const refreshBtn = document.getElementById('refreshBtn');

    if (!filterArea || !refreshBtn) {
        console.warn('[MultiSelect] Could not find filter area or refresh button');
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
            flex-wrap: nowrap;
            overflow-x: auto;
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
            flex-wrap: nowrap;
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

        @media (max-width: 600px) {
            .multi-select-toolbar {
                padding: 8px 10px;
                gap: 8px;
            }
            .multi-select-actions {
                gap: 4px;
            }
            .ms-btn {
                padding: 7px 8px;
                font-size: 0.8em;
            }
            .ms-divider {
                margin: 0 2px;
                height: 20px;
            }
            .multi-select-badge {
                padding: 5px 10px;
                font-size: 0.85em;
                gap: 6px;
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

// Setup keyboard shortcut for Space to toggle selection
function setupKeyboardShortcuts() {
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

function init() {
    if (isInitialized) {
        console.warn('[MultiSelect] Already initialized');
        return;
    }

    injectMultiSelectStyles();
    injectMultiSelectToolbar();
    injectMultiSelectToggle();
    setupKeyboardShortcuts();

    window.MultiSelect = MultiSelect;
    window.handleCardClickForMultiSelect = function(char, cardElement) {
        if (MultiSelect.enabled) {
            MultiSelect.toggle(char, cardElement);
            return true;
        }
        return false;
    };

    isInitialized = true;
    console.log('[MultiSelect] Module initialized');
}

export default {
    init
};
