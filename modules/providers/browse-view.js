// BrowseView — base class for provider browse views in the Online tab

/**
 * Base class for Online tab browse views.
 * Subclasses MUST override at least renderView().
 */
export class BrowseView {
    /**
     * @param {import('./provider-interface.js').ProviderBase} provider
     */
    constructor(provider) {
        this.provider = provider;
        this._initialized = false;
        this._modalsInjected = false;
    }

    // ── HTML Rendering ──────────────────────────────────────

    /**
     * Return filter bar HTML for the topbar filters-wrapper area.
     * Called once; injected into #onlineFilterArea by the registry.
     * @returns {string}
     */
    renderFilterBar() { return ''; }

    /**
     * Return main view HTML (grids, search bars, etc.).
     * Called once; injected into #onlineView by the registry.
     * @returns {string}
     */
    renderView() { return ''; }

    /**
     * Return modal HTML to append to document.body.
     * Called once during first activation.
     * @returns {string}
     */
    renderModals() { return ''; }

    // ── Lifecycle ───────────────────────────────────────────

    /**
     * One-time setup after HTML has been injected into the DOM.
     * Subclasses attach event handlers here.
     */
    init() {
        this._initialized = true;
    }

    /**
     * Called every time the Online tab shows this provider's view.
     * First call should trigger init() if not yet done.
     * @param {HTMLElement} container — #onlineView element
     * @param {Object} [options]
     * @param {boolean} [options.domRecreated] — true when the DOM was
     *   destroyed and rebuilt by the registry (provider switch).
     */
    activate(container, options = {}) {
        if (options.domRecreated) {
            this._initialized = false;
        }
        if (!this._initialized) {
            this.injectModals();
            this.init();
        }
    }

    /**
     * Called when leaving this provider's view.
     * Disconnect observers, abort fetches, etc.
     */
    deactivate() {}

    // ── Library Lookup ───────────────────────────────────────

    /**
     * Rebuild the In Library lookup from allCharacters.
     * Called after extensions recovery or character list changes.
     */
    rebuildLocalLibraryLookup() {}

    /**
     * Re-evaluate In Library badges on already-rendered browse cards.
     * Called after the lookup has been rebuilt to fix stale badges.
     */
    refreshInLibraryBadges() {}

    // ── Image Observer Management ───────────────────────────

    /**
     * Disconnect the image lazy-load observer.
     */
    disconnectImageObserver() {}

    /**
     * Reconnect the image observer after disconnect.
     * Should re-observe images in the currently visible grid.
     */
    reconnectImageObserver() {}

    // ── Mobile Integration ──────────────────────────────────

    /**
     * DOM ID of this provider's preview modal (e.g. 'chubCharModal').
     * Used by the mobile back-button handler and STATIC_OVERLAYS set.
     * @returns {string|null}
     */
    get previewModalId() { return null; }

    /**
     * Close the preview modal with proper cleanup (abort fetches, release memory, etc.).
     * Called by the mobile back-button handler. Default hides the modal by ID.
     */
    closePreview() {
        const id = this.previewModalId;
        if (id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        }
    }

    /**
     * Element IDs for the provider's filter bar controls.
     * The mobile settings sheet queries these to build the online section dynamically.
     * @returns {{ sort: string|null, tags: string|null, filters: string|null, nsfw: string|null, refresh: string|null }}
     */
    get mobileFilterIds() {
        return { sort: null, tags: null, filters: null, nsfw: null, refresh: null };
    }

    /**
     * Whether this provider has a mode toggle (e.g. Browse/Following).
     * Providers returning true should provide mobileModeSections for the settings sheet.
     * @returns {boolean}
     */
    get hasModeToggle() { return false; }

    /**
     * Full teardown — page unload.
     */
    destroy() {
        this.deactivate();
    }

    // ── Modal Injection ─────────────────────────────────────

    /**
     * Inject modal HTML into document.body (once).
     * Call from activate() on first run.
     */
    injectModals() {
        if (this._modalsInjected) return;
        const html = this.renderModals();
        if (html) {
            document.body.insertAdjacentHTML('beforeend', html);
        }
        this._modalsInjected = true;
    }

    // ── Avatar Quick-View ───────────────────────────────────

    /**
     * Open a full-screen overlay displaying the given image.
     * Falls back to fallbackSrc on load error.
     */
    static openAvatarViewer(src, fallbackSrc) {
        if (!src) return;
        BrowseView.closeAvatarViewer();

        const overlay = document.createElement('div');
        overlay.className = 'browse-avatar-viewer';

        const img = document.createElement('img');
        img.alt = 'Avatar';
        if (fallbackSrc) {
            img.onerror = () => { img.onerror = null; img.src = fallbackSrc; };
        }
        img.src = src;

        overlay.appendChild(img);
        overlay.addEventListener('click', () => BrowseView.closeAvatarViewer());

        const onKey = (e) => {
            if (e.key === 'Escape') { BrowseView.closeAvatarViewer(); }
        };
        document.addEventListener('keydown', onKey);
        overlay._onKey = onKey;

        document.body.appendChild(overlay);
    }

    static closeAvatarViewer() {
        const viewer = document.querySelector('.browse-avatar-viewer');
        if (!viewer) return;
        if (viewer._onKey) document.removeEventListener('keydown', viewer._onKey);
        viewer.remove();
    }
}

export default BrowseView;
