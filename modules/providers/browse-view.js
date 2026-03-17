// BrowseView — base class for provider browse views in the Online tab

import CoreAPI from '../core-api.js';

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
        this._scrollHandler = null;
        this._scrollIndicator = null;
        this._prefetching = false;
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
        // Apply saved defaults on first activation with DOM rebuild
        if (options.domRecreated && options.defaults) {
            this.applyDefaults(options.defaults);
        }
        // Re-register dropdown dismiss after deactivate removed it
        if (this._dropdownDismissPairs && !this._dropdownCloseHandler) {
            this._registerDropdownDismiss(this._dropdownDismissPairs);
        }
        // Attach infinite scroll listener
        this._attachScrollListener();
    }

    /**
     * Apply saved default view/sort settings from the settings modal.
     * Called once on first activation when domRecreated is true.
     * Subclasses override to set their specific selects/toggles.
     * Sort-only providers set the sort variable + DOM element.
     * View+sort providers set the view mode variable (the activate()
     * continuation uses it for data loading) and sort.
     * @param {Object} defaults - { view?: string, sort?: string }
     */
    applyDefaults(defaults) {
        // Base implementation — no-op. Subclasses override.
    }

    /**
     * Called when leaving this provider's view.
     * Disconnect observers, abort fetches, etc.
     * Subclasses should call super.deactivate().
     */
    deactivate() {
        this._removeDropdownDismiss();
        this._detachScrollListener();
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
                    BrowseView.adjustPortraitPosition(img);
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
            this.eagerPreloadImages(container);
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
                if (realSrc && img.src !== realSrc) {
                    img.src = realSrc;
                    BrowseView.adjustPortraitPosition(img);
                }
            }
        }
    }

    /**
     * Preload a batch of images beyond the viewport for smoother scrolling.
     * @param {HTMLElement} container
     */
    eagerPreloadImages(container) {
        if (!container) return;
        const images = container.querySelectorAll('.browse-card-image img[data-src]');
        let loaded = 0;
        for (const img of images) {
            if (loaded >= 48) break;
            if (img.dataset.failed) continue;
            const realSrc = img.dataset.src;
            if (realSrc && img.src !== realSrc) {
                img.src = realSrc;
                BrowseView.adjustPortraitPosition(img);
                loaded++;
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

    // ── Infinite Scroll ───────────────────────────────────

    /**
     * Whether this view can load more results right now.
     * Subclasses override to check their hasMore + !isLoading state.
     * @returns {boolean}
     */
    canLoadMore() { return false; }

    /**
     * Trigger the next page load (append mode).
     * Subclasses override to increment page and call their load function.
     */
    loadMore() {}

    /**
     * Whether infinite scroll is active for this provider.
     * Reads from the per-provider setting with global fallback.
     * @returns {boolean}
     */
    isInfiniteScrollEnabled() {
        const perProvider = CoreAPI.getSetting('infiniteScroll');
        const id = this.provider?.id;
        if (id && perProvider && typeof perProvider === 'object' && id in perProvider) {
            return perProvider[id];
        }
        return true;
    }

    /**
     * Attach the scroll listener for infinite loading + prefetch.
     * Listens on .gallery-content (the scrollable parent of #onlineView).
     */
    _attachScrollListener() {
        this._detachScrollListener();
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        this._scrollHandler = () => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;

            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            if (distanceFromBottom < 1500) {
                this._prefetching = true;
                this._setScrollIndicator('loading');
                this.loadMore();
                setTimeout(() => { this._prefetching = false; }, 300);
            }
        };

        scrollContainer.addEventListener('scroll', this._scrollHandler, { passive: true });
    }

    /**
     * Remove the scroll listener.
     */
    _detachScrollListener() {
        if (this._scrollHandler) {
            document.querySelector('.gallery-content')?.removeEventListener('scroll', this._scrollHandler);
            this._scrollHandler = null;
        }
        this._prefetching = false;
        this._removeScrollIndicator();
    }

    /**
     * Update the visibility of the load-more button container.
     * When infinite scroll is enabled, hides the button.
     * Subclasses call this from their updateLoadMore() or renderGrid().
     * @param {string} loadMoreContainerId - DOM ID of the load-more container div
     * @param {boolean} hasMore - whether more results are available
     * @param {boolean} hasResults - whether any results exist
     */
    updateLoadMoreVisibility(loadMoreContainerId, hasMore, hasResults) {
        const el = document.getElementById(loadMoreContainerId);
        if (!el) return;
        if (this.isInfiniteScrollEnabled()) {
            el.style.display = 'none';
            this._setScrollIndicator(hasMore ? 'hidden' : 'end');
        } else {
            el.style.display = hasMore && hasResults ? 'flex' : 'none';
        }
    }

    _ensureScrollIndicator() {
        if (this._scrollIndicator?.isConnected) return this._scrollIndicator;
        const container = document.getElementById('onlineView');
        if (!container) return null;
        const el = document.createElement('div');
        el.className = 'browse-scroll-indicator';
        container.appendChild(el);
        this._scrollIndicator = el;
        return el;
    }

    _setScrollIndicator(state) {
        if (!this.isInfiniteScrollEnabled()) return;
        const el = this._ensureScrollIndicator();
        if (!el) return;
        el.classList.remove('loading', 'end');
        if (state === 'hidden') {
            el.style.display = 'none';
        } else {
            el.style.display = '';
            el.classList.add(state);
        }
    }

    _removeScrollIndicator() {
        this._scrollIndicator?.remove();
        this._scrollIndicator = null;
    }

    // ── Dropdown Dismiss ────────────────────────────────────

    /**
     * Close all registered dropdowns for this browse view.
     * Called by the registry when topbar dropdowns open or on provider switch.
     */
    closeDropdowns() {
        if (this._dropdownDismissPairs) {
            for (const { dropdownId } of this._dropdownDismissPairs) {
                document.getElementById(dropdownId)?.classList.add('hidden');
            }
        }
    }

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
     * Return sort/view config for the settings modal.
     * @returns {{ browseSortOptions: Array<{value:string, label:string}>, followingSortOptions: Array<{value:string, label:string}>, viewModes: Array<{value:string, label:string}> }}
     */
    getSettingsConfig() {
        return { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
    }

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
     * If `gallery` array is provided, enables prev/next navigation.
     * @param {string} src
     * @param {string} [fallbackSrc]
     * @param {string[]} [gallery] - Array of image URLs
     * @param {number} [startIndex] - Starting index in gallery
     */
    static openAvatarViewer(src, fallbackSrc, gallery, startIndex) {
        if (!src) return;
        BrowseView.closeAvatarViewer();

        const images = gallery && gallery.length > 1 ? gallery : null;
        let currentIndex = images ? (startIndex ?? 0) : 0;

        const overlay = document.createElement('div');
        overlay.className = 'browse-avatar-viewer';
        if (images) overlay.classList.add('has-gallery');

        const img = document.createElement('img');
        img.className = 'browse-av-image';
        img.alt = 'Image';
        img.onerror = () => { img.onerror = null; if (fallbackSrc) img.src = fallbackSrc; else img.style.display = 'none'; };
        img.src = src;
        overlay.appendChild(img);

        // Navigation UI (only for multi-image galleries)
        let prevBtn, nextBtn, counter;
        if (images) {
            prevBtn = document.createElement('button');
            prevBtn.className = 'browse-av-nav browse-av-prev';
            prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
            prevBtn.title = 'Previous';

            nextBtn = document.createElement('button');
            nextBtn.className = 'browse-av-nav browse-av-next';
            nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            nextBtn.title = 'Next';

            counter = document.createElement('div');
            counter.className = 'browse-av-counter';

            overlay.appendChild(prevBtn);
            overlay.appendChild(nextBtn);
            overlay.appendChild(counter);
        }

        function showImage(index) {
            if (!images) return;
            currentIndex = ((index % images.length) + images.length) % images.length;
            img.onerror = () => { img.onerror = null; img.style.display = 'none'; };
            img.style.display = '';
            img.src = images[currentIndex];
            if (counter) counter.textContent = `${currentIndex + 1} / ${images.length}`;
        }

        if (images) {
            showImage(currentIndex);

            prevBtn.addEventListener('click', (e) => { e.stopPropagation(); showImage(currentIndex - 1); });
            nextBtn.addEventListener('click', (e) => { e.stopPropagation(); showImage(currentIndex + 1); });
        }

        // Close on backdrop click (not on image or nav buttons)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) BrowseView.closeAvatarViewer();
        });
        // Close on image click only if no gallery navigation
        if (!images) {
            img.addEventListener('click', () => BrowseView.closeAvatarViewer());
        }

        const onKey = (e) => {
            if (e.key === 'Escape') { BrowseView.closeAvatarViewer(); return; }
            if (!images) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); showImage(currentIndex - 1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); showImage(currentIndex + 1); }
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

    // ── Portrait-aware position ─────────────────────────────

    static adjustPortraitPosition(img) {
        img.style.objectPosition = '';
        const apply = () => {
            const { naturalWidth: w, naturalHeight: h } = img;
            if (w > 0 && h > 0 && h / w > 1.3) {
                img.style.objectPosition = 'center 10%';
            }
        };
        if (img.complete && img.naturalWidth > 0) {
            apply();
        } else {
            img.addEventListener('load', function handler() {
                img.removeEventListener('load', handler);
                apply();
            });
        }
    }
}

export default BrowseView;
