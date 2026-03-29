

import * as CoreAPI from './core-api.js';

let isInitialized = false;

const MultiSelect = {
    enabled: false,
    selectedCharacters: new Map(), // avatar -> character object

    enable() {
        this.enabled = true;
        document.body.classList.add('multi-select-mode');

        document.getElementById('multiSelectToggleBtn')?.classList.add('active');

        this.updateToolbar();
        CoreAPI.debugLog('[MultiSelect] Mode enabled');
    },

    disable() {
        this.enabled = false;
        this.selectedCharacters.clear();
        document.body.classList.remove('multi-select-mode');

        document.querySelectorAll('.char-card.selected').forEach(card => {
            card.classList.remove('selected');
        });

        document.getElementById('multiSelectToggleBtn')?.classList.remove('active');

        this.updateToolbar();
        CoreAPI.debugLog('[MultiSelect] Mode disabled');
    },

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

    clearSelection() {
        this.selectedCharacters.clear();
        document.querySelectorAll('.char-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        this.updateToolbar();
    },

    getSelected() {
        return Array.from(this.selectedCharacters.values());
    },

    getCount() {
        return this.selectedCharacters.size;
    },

    updateToolbar() {
        const toolbar = document.getElementById('multiSelectToolbar');
        const countEl = document.getElementById('multiSelectCount');

        if (!toolbar) return;

        if (this.enabled) {
            toolbar.classList.remove('hidden');
            if (countEl) {
                countEl.textContent = this.selectedCharacters.size;
            }
            updateFavoriteToggleState();
        } else {
            toolbar.classList.add('hidden');
        }
    },

    isSelected(avatar) {
        return this.selectedCharacters.has(avatar);
    }
};

function areAllSelectedFavorited() {
    const selected = MultiSelect.getSelected();
    if (selected.length === 0) return false;

    return selected.every(char => {
        return char.fav === true || char.fav === 'true' ||
               char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true';
    });
}

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
            <button id="multiSelectCheckUpdatesBtn" class="ms-btn" title="Check selected characters for updates from linked providers">
                <i class="fa-solid fa-arrows-rotate"></i>
                <span>Updates</span>
            </button>
            <button id="multiSelectPlaylistBtn" class="ms-btn" title="Add selected characters to a playlist">
                <i class="fa-solid fa-list-ul"></i>
                <span>Playlist</span>
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

    document.getElementById('multiSelectPlaylistBtn')?.addEventListener('click', () => {
        const avatars = Array.from(MultiSelect.selectedCharacters.keys());
        if (avatars.length) CoreAPI.openPlaylistPicker(avatars);
    });
}

function injectMultiSelectToggle() {
    const filterArea = document.getElementById('filterArea');
    const gallerySyncContainer = filterArea?.querySelector('.gallery-sync-container');

    if (!filterArea || !gallerySyncContainer) {
        console.warn('[MultiSelect] Could not find filter area or gallery sync container');
        return;
    }

    if (document.getElementById('multiSelectToggleBtn')) return;

    const toggleHtml = `
    <button id="multiSelectToggleBtn" class="glass-btn icon-only" title="Multi-select mode (Space to toggle, Esc to exit)">
        <i class="fa-solid fa-object-group"></i>
    </button>`;

    gallerySyncContainer.insertAdjacentHTML('afterend', toggleHtml);

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



function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in input/textarea
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        // Only activate in Characters view
        if (CoreAPI.getCurrentView() !== 'characters') return;

        if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();

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
    CoreAPI.debugLog('[MultiSelect] Module initialized');
}

export default {
    init
};
