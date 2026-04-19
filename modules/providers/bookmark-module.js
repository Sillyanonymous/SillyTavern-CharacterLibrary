// bookmark-module.js — local-only bookmark feature shared across providers.
//
// Factory returns a pre-configured bundle of helpers + renderers + event
// wirings, keyed to a single provider's conventions. Each call gets its own
// isolated state (Map of snapshots, filter flag, load guard).
//
// Providers that use this: Janny, DataCat, Character Tavern. All three
// previously shipped ~90% byte-identical implementations before this
// extraction. See BOOKMARKS-SYNC-NOTES.md under janny/ for future sync
// research (all three remain local-only today).

import CoreAPI from '../core-api.js';

const {
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
} = CoreAPI;

const BOOKMARK_CLASS = 'cl-bookmark-btn';

function camelToKebab(s) {
    return String(s).replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Create a per-provider bookmark module.
 *
 * @param {object} config
 * @param {string} config.prefix            Short provider tag, e.g. 'janny'.
 * @param {string} config.settingsKey       Settings key, e.g. 'jannyBookmarks'.
 * @param {string} config.logLabel          Debug log label, e.g. '[JannyBrowse]'.
 * @param {(hit: object) => string} config.getId
 *     Returns the canonical ID string for a hit object.
 * @param {string} config.dataAttrKey       camelCase dataset key, e.g. 'jannyId'.
 * @param {string} config.gridId            e.g. 'jannyGrid' (for empty-state render).
 * @param {string} config.modalBtnId        e.g. 'jannyCharBookmarkBtn'.
 * @param {string} config.checkboxId        e.g. 'jannyFilterMyBookmarks'.
 * @param {(hit: object) => object} config.buildSnapshot
 *     Returns the provider-specific snapshot object. Factory appends bookmarkedAt.
 * @param {Object<string, (a: object, b: object) => number>} [config.sortModes]
 *     Map of mode → comparator. Missing modes fall back to bookmarkedAt desc.
 * @param {() => string} config.getSortMode Returns the provider's current sort value.
 * @param {() => object|null} config.getSelectedChar
 *     Returns the current modal-selected character (or null).
 * @param {(sorted: object[]) => void} config.resetBookmarkState
 *     Provider resets its local state: xCharacters = sorted, xHasMore = false,
 *     pagination reset, xGridRenderedCount = 0.
 * @param {(items: object[]) => void} config.renderGrid
 *     Delegates to the provider's existing renderGrid(items, false).
 * @param {() => void} [config.onEmpty]
 *     Optional; called after the empty-state HTML is rendered so the provider
 *     can run its updateLoadMore() (or any cleanup).
 * @param {(isOn: boolean) => void} config.onFilterToggle
 *     Called after the filter checkbox changes. Provider updates its filters
 *     button, resets pagination, and triggers either renderBookmarksView() or
 *     its regular load.
 */
export function createBookmarkModule(config) {
    const {
        prefix,
        settingsKey,
        logLabel,
        getId,
        dataAttrKey,
        gridId,
        modalBtnId,
        checkboxId,
        buildSnapshot,
        sortModes = {},
        getSortMode,
        getSelectedChar,
        resetBookmarkState,
        renderGrid,
        onEmpty,
        onFilterToggle,
    } = config;

    const dataAttrKebab = camelToKebab(dataAttrKey);
    const legacyClass = `${prefix}-bookmark-btn`;

    const state = {
        bookmarks: new Map(),
        filterMyBookmarks: false,
        loaded: false,
    };

    function load() {
        if (state.loaded) return;
        const saved = getSetting(settingsKey) || [];
        state.bookmarks = new Map();
        if (Array.isArray(saved)) {
            for (const entry of saved) {
                const id = entry && getId(entry);
                if (id) state.bookmarks.set(String(id), entry);
            }
        }
        state.loaded = true;
        debugLog(logLabel, 'Loaded', state.bookmarks.size, 'bookmarks from settings');
    }

    function persist() {
        setSetting(settingsKey, Array.from(state.bookmarks.values()));
    }

    function isBookmarked(id) {
        load();
        return !!(id && state.bookmarks.has(String(id)));
    }

    function snapshot(hit) {
        return { ...buildSnapshot(hit), bookmarkedAt: Date.now() };
    }

    function syncUI(id, favorited) {
        const safeId = String(id);
        const selector = `.${legacyClass}[data-${dataAttrKebab}="${CSS.escape(safeId)}"]`;
        document.querySelectorAll(selector).forEach(btn => {
            btn.classList.toggle('favorited', favorited);
            const icon = btn.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-solid', favorited);
                icon.classList.toggle('fa-regular', !favorited);
            }
        });

        const sel = getSelectedChar?.();
        if (sel && String(getId(sel)) === safeId) {
            const modalBtn = document.getElementById(modalBtnId);
            if (modalBtn) {
                modalBtn.classList.toggle('favorited', favorited);
                const icon = modalBtn.querySelector('i');
                if (icon) {
                    icon.classList.toggle('fa-solid', favorited);
                    icon.classList.toggle('fa-regular', !favorited);
                }
            }
        }
    }

    function syncModalState(hit) {
        const modalBtn = document.getElementById(modalBtnId);
        if (!modalBtn) return;
        const fav = isBookmarked(getId(hit));
        modalBtn.classList.toggle('favorited', fav);
        modalBtn.title = fav ? 'Remove bookmark' : 'Bookmark this character';
        const icon = modalBtn.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-solid', fav);
            icon.classList.toggle('fa-regular', !fav);
        }
    }

    function toggle(hitOrId) {
        load();

        const id = String(
            (hitOrId && typeof hitOrId === 'object' ? getId(hitOrId) : hitOrId) || ''
        );
        if (!id) return false;

        if (state.bookmarks.has(id)) {
            state.bookmarks.delete(id);
            persist();
            showToast('Removed from bookmarks', 'info');
            syncUI(id, false);
            if (state.filterMyBookmarks) renderBookmarksView();
            return false;
        }

        const hit = (typeof hitOrId === 'object' && hitOrId) ? hitOrId : null;
        if (!hit) {
            showToast('Could not bookmark: character data missing', 'error');
            return false;
        }

        state.bookmarks.set(id, snapshot(hit));
        persist();
        showToast('Bookmarked', 'success');
        syncUI(id, true);
        return true;
    }

    function sortSnapshots(list, mode) {
        const sorted = list.slice();
        const cmp = sortModes[mode];
        if (cmp) sorted.sort(cmp);
        else sorted.sort((a, b) => (b.bookmarkedAt || 0) - (a.bookmarkedAt || 0));
        return sorted;
    }

    function renderBookmarksView() {
        load();
        const snapshots = Array.from(state.bookmarks.values());
        const sorted = sortSnapshots(snapshots, getSortMode());

        resetBookmarkState(sorted);

        const grid = document.getElementById(gridId);
        if (!grid) return;

        if (sorted.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-regular fa-bookmark" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">No bookmarks yet. Click the bookmark icon on any character to save it here.</p>
                </div>
            `;
            onEmpty?.();
            return;
        }

        renderGrid(sorted);
    }

    function renderCardBtn(hit) {
        const id = getId(hit);
        if (!id) return '';
        const fav = isBookmarked(id);
        return `<span class="browse-card-stat ${BOOKMARK_CLASS} ${legacyClass}${fav ? ' favorited' : ''}" data-${dataAttrKebab}="${escapeHtml(String(id))}" title="${fav ? 'Remove bookmark' : 'Bookmark this character'}"><i class="${fav ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i></span>`;
    }

    function renderModalBtn() {
        return `<button id="${modalBtnId}" class="action-btn secondary ${BOOKMARK_CLASS} ${legacyClass}" title="Bookmark this character"><i class="fa-regular fa-bookmark"></i></button>`;
    }

    function renderFilterCheckbox() {
        return `<label class="filter-checkbox"><input type="checkbox" id="${checkboxId}" ${state.filterMyBookmarks ? 'checked' : ''}> <i class="fa-solid fa-bookmark" style="color: #ff6b6b;"></i> My Bookmarks</label>`;
    }

    /**
     * Caller uses this inside its grid click delegation:
     *   if (bookmarks.handleGridClick(e, jannyCharacters)) return;
     * Returns true if the click was a bookmark click (and was handled).
     */
    function handleGridClick(e, charsArray) {
        const btn = e.target.closest(`.${legacyClass}`);
        if (!btn) return false;
        e.stopPropagation();
        const id = btn.dataset[dataAttrKey];
        if (!id) return true;
        const hit = (Array.isArray(charsArray)
            ? charsArray.find(c => String(getId(c)) === id)
            : null) || null;
        toggle(hit || id);
        return true;
    }

    function attachModalBtn() {
        const btn = document.getElementById(modalBtnId);
        if (!btn) return;
        btn.addEventListener('click', () => {
            const sel = getSelectedChar?.();
            if (sel) toggle(sel);
        });
    }

    function attachFilterCheckbox() {
        const cb = document.getElementById(checkboxId);
        if (!cb) return;
        cb.addEventListener('change', () => {
            state.filterMyBookmarks = cb.checked;
            onFilterToggle(state.filterMyBookmarks);
        });
    }

    return {
        load,
        persist,
        isBookmarked,
        snapshot,
        toggle,
        syncUI,
        syncModalState,
        sortSnapshots,
        renderBookmarksView,
        renderCardBtn,
        renderModalBtn,
        renderFilterCheckbox,
        handleGridClick,
        attachModalBtn,
        attachFilterCheckbox,
        get filterMyBookmarks() { return state.filterMyBookmarks; },
        set filterMyBookmarks(v) { state.filterMyBookmarks = !!v; },
        get size() { return state.bookmarks.size; },
    };
}
