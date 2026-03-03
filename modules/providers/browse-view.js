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
        this._imageObserver = null;
        this._dropdownCloseHandler = null;
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
        // Re-register dropdown dismiss after deactivate removed it
        if (this._dropdownDismissPairs && !this._dropdownCloseHandler) {
            this._registerDropdownDismiss(this._dropdownDismissPairs);
        }
    }

    /**
     * Called when leaving this provider's view.
     * Disconnect observers, abort fetches, etc.
     * Subclasses should call super.deactivate().
     */
    deactivate() {
        this._removeDropdownDismiss();
    }

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

    // ── Image Observer ──────────────────────────────────────

    /**
     * Grid element IDs this view uses for card rendering.
     * Used by reconnectImageObserver() to find and re-observe images.
     * @returns {string[]}
     */
    _getImageGridIds() { return []; }

    /**
     * Create the shared IntersectionObserver (once). Subclasses normally
     * don't need to call this directly — observeImages() auto-initializes.
     */
    _initImageObserver() {
        if (this._imageObserver) return;
        this._imageObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                const realSrc = img.dataset.src;
                if (realSrc && !img.dataset.failed && img.src !== realSrc) {
                    img.src = realSrc;
                }
            }
        }, { rootMargin: '600px' });
    }

    /**
     * Observe card images in a container for lazy loading.
     * Calls eagerLoadVisibleImages() first, then batches the rest
     * through IntersectionObserver.
     * @param {HTMLElement} container
     */
    observeImages(container) {
        if (!container) return;
        if (!this._imageObserver) this._initImageObserver();
        requestAnimationFrame(() => {
            this.eagerLoadVisibleImages(container);
            const images = Array.from(
                container.querySelectorAll('.browse-card-image img')
            ).filter(img => !img.dataset.observed);
            if (images.length === 0) return;

            if (images.length > 120) {
                const batchSize = 80;
                let index = 0;
                const observeBatch = () => {
                    const end = Math.min(index + batchSize, images.length);
                    for (let i = index; i < end; i++) {
                        images[i].dataset.observed = '1';
                        this._imageObserver.observe(images[i]);
                    }
                    index = end;
                    if (index < images.length) requestAnimationFrame(observeBatch);
                };
                observeBatch();
                return;
            }

            for (const img of images) {
                img.dataset.observed = '1';
                this._imageObserver.observe(img);
            }
        });
    }

    /**
     * Synchronously load images that are already in/near the viewport.
     * Called at the start of observeImages() for instant display.
     * @param {HTMLElement} container
     */
    eagerLoadVisibleImages(container) {
        if (!container) return;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const preloadBottom = viewportHeight + 700;
        const images = container.querySelectorAll('.browse-card-image img[data-src]');
        for (const img of images) {
            if (img.dataset.failed) continue;
            const rect = img.getBoundingClientRect();
            if (rect.bottom > -160 && rect.top < preloadBottom) {
                const realSrc = img.dataset.src;
                if (realSrc && img.src !== realSrc) img.src = realSrc;
            }
        }
    }

    /**
     * Disconnect the image lazy-load observer.
     */
    disconnectImageObserver() {
        this._imageObserver?.disconnect();
    }

    /**
     * Reconnect the image observer after disconnect.
     * Clears data-observed flags and re-observes images in all grid containers.
     */
    reconnectImageObserver() {
        for (const gridId of this._getImageGridIds()) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;
            this.eagerLoadVisibleImages(grid);
            const imgs = grid.querySelectorAll('.browse-card-image img[data-observed]');
            for (const img of imgs) delete img.dataset.observed;
            this.observeImages(grid);
        }
    }

    // ── Dropdown Dismiss ────────────────────────────────────

    /**
     * Register a document-level click handler that closes dropdowns when
     * clicking outside. Replaces per-provider boilerplate.
     * @param {Array<{dropdownId: string, buttonId: string}>} pairs
     */
    _registerDropdownDismiss(pairs) {
        this._removeDropdownDismiss();
        this._dropdownDismissPairs = pairs;
        this._dropdownCloseHandler = (e) => {
            for (const { dropdownId, buttonId } of pairs) {
                const dropdown = document.getElementById(dropdownId);
                const btn = document.getElementById(buttonId);
                if (dropdown && !dropdown.classList.contains('hidden')) {
                    if (!dropdown.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        dropdown.classList.add('hidden');
                    }
                }
            }
        };
        document.addEventListener('click', this._dropdownCloseHandler);
    }

    /**
     * Remove the dropdown dismiss handler. Called automatically from deactivate().
     */
    _removeDropdownDismiss() {
        if (this._dropdownCloseHandler) {
            document.removeEventListener('click', this._dropdownCloseHandler);
            this._dropdownCloseHandler = null;
        }
    }

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
