// BrowseView — base class for provider browse views in the Online tab

import CoreAPI from '../core-api.js';
import { normalizeBrowseName } from './provider-utils.js';

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
        this._preloadLimit = 48;
        this._lookup = {
            byNameAndCreator: new Set(),
            byProviderId: new Set(),
            byNormalizedName: new Map(), // normalized name → Set<normalized creator>
        };
        // Following manager state
        this._mgrOpen = false;
        this._mgrCreators = [];
        this._mgrFilter = '';
        this._mgrSort = 'name_asc';
        this._mgrDebounceTimer = null;
        this._mgrConfirmTimer = null;
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
        if (this.supportsFollowingManager) {
            this._initFollowingManager();
        }
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
        // Reset manager state for clean re-activation
        this._mgrOpen = false;
        clearTimeout(this._mgrDebounceTimer);
        clearTimeout(this._mgrConfirmTimer);
        // Reset any in-progress unfollow confirmation
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            for (const btn of list.querySelectorAll('.follow-mgr-unfollow-btn[data-confirming]')) {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }
        }
    }

    // ── Library Lookup ───────────────────────────────────────

    /**
     * Populate _lookup Sets from the current allCharacters list.
     * Handles byNameAndCreator + byNormalizedName universally;
     * delegates provider-specific ID extraction to _extractProviderIds().
     */
    buildLocalLibraryLookup() {
        const { byNameAndCreator, byProviderId, byNormalizedName } = this._lookup;
        byNameAndCreator.clear();
        byProviderId.clear();
        byNormalizedName.clear();

        for (const char of CoreAPI.getAllCharacters()) {
            if (!char) continue;

            const name = (char.name || '').toLowerCase().trim();
            const creator = String(char.creator || char.data?.creator || '').toLowerCase().trim();
            if (name && creator) byNameAndCreator.add(`${name}|${creator}`);

            this._extractProviderIds(char, byProviderId);

            for (const variant of this._nameVariants(char.name || '')) {
                let creatorSet = byNormalizedName.get(variant);
                if (!creatorSet) {
                    creatorSet = new Set();
                    byNormalizedName.set(variant, creatorSet);
                }
                if (creator) creatorSet.add(creator);
            }
        }

        CoreAPI.debugLog(`[${this.provider.name}] Library lookup built:`,
            'nameCreators:', byNameAndCreator.size,
            'providerIds:', byProviderId.size,
            'normalizedNames:', byNormalizedName.size);
    }

    /**
     * Extract provider-specific IDs from a local character into the Set.
     * Subclasses override to read their extension key.
     * @param {Object} char - local character from allCharacters
     * @param {Set} idSet - the byProviderId Set to add to
     */
    _extractProviderIds(char, idSet) {}

    /**
     * Check if a browse card name+creator is a possible match (cross-provider).
     * @param {string} name - resolved display name from the browse card
     * @param {string} [creator] - creator/author name from the browse card
     * @returns {boolean}
     */
    isCharPossibleMatch(name, creator) {
        const browseCreator = (creator || '').toLowerCase().trim();
        const variants = this._nameVariants(name);

        for (const variant of variants) {
            const creatorSet = this._lookup.byNormalizedName.get(variant);
            if (!creatorSet) continue;

            if (!browseCreator || creatorSet.size === 0) return true;

            for (const libCreator of creatorSet) {
                if (this._isCreatorMatch(browseCreator, libCreator)) return true;
            }
        }

        // Prefix fallback: check all browse variants against all library names
        for (const variant of variants) {
            if (variant.length < 4) continue;
            for (const [libName, creatorSet] of this._lookup.byNormalizedName) {
                if (libName.length < 4) continue;
                if (this._isNamePrefixMatch(variant, libName)) {
                    if (!browseCreator || creatorSet.size === 0) return true;
                    for (const libCreator of creatorSet) {
                        if (this._isCreatorMatch(browseCreator, libCreator)) return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Check if one name is a word-boundary prefix of the other.
     * "scar" matches "scar - the dark king" but NOT "scarlett".
     * @param {string} a - normalized name
     * @param {string} b - normalized name
     * @returns {boolean}
     */
    _isNamePrefixMatch(a, b) {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length <= b.length ? b : a;
        if (shorter.length === longer.length) return false;
        if (!longer.startsWith(shorter)) return false;
        return /[\s\-|:,.]/.test(longer[shorter.length]);
    }

    /**
     * Generate normalized name variants for cross-provider matching.
     * Splits on || separators so "Scar || Dark King" matches "Scar".
     * @param {string} rawName
     * @returns {string[]} unique normalized variants with length >= 4
     */
    _nameVariants(rawName) {
        const full = normalizeBrowseName(rawName);
        const variants = new Set();
        if (full.length >= 4) variants.add(full);

        if (rawName.includes('||')) {
            const primary = normalizeBrowseName(rawName.split('||')[0]);
            if (primary.length >= 4) variants.add(primary);
        }

        return variants;
    }

    /**
     * Lightweight fuzzy match for creator names across providers.
     * Handles case differences, prefixes, and small edits.
     * @param {string} a - normalized (lowered+trimmed) creator name
     * @param {string} b - normalized (lowered+trimmed) creator name
     * @returns {boolean}
     */
    _isCreatorMatch(a, b) {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;

        const aCompact = a.replace(/[\s_-]/g, '');
        const bCompact = b.replace(/[\s_-]/g, '');
        if (aCompact && aCompact === bCompact) return true;

        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) return false;
        if (Math.abs(a.length - b.length) > maxLen * 0.4) return false;

        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const curr = [i];
            for (let j = 1; j <= b.length; j++) {
                curr[j] = Math.min(
                    prev[j] + 1,
                    curr[j - 1] + 1,
                    prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                );
            }
            prev = curr;
        }

        return (1 - prev[b.length] / maxLen) >= 0.75;
    }

    /**
     * Rebuild the In Library lookup from allCharacters.
     * Called after extensions recovery or character list changes.
     */
    rebuildLocalLibraryLookup() {
        this.buildLocalLibraryLookup();
    }

    /**
     * Re-evaluate In Library badges on already-rendered browse cards.
     * Called after the lookup has been rebuilt to fix stale badges.
     * @param {function(HTMLElement): boolean} checkCard - Returns true if the card is in the local library
     * @param {string[]} [gridIds] - Grid element IDs to scan (defaults to _getImageGridIds())
     */
    refreshInLibraryBadges(checkCard, gridIds) {
        if (!checkCard) return;
        for (const gridId of (gridIds || this._getImageGridIds())) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;

            for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
                if (!checkCard(card)) continue;
                card.classList.add('in-library');
                card.classList.remove('possible-library');
                let badgesEl = card.querySelector('.browse-feature-badges');
                if (!badgesEl) {
                    const imgWrap = card.querySelector('.browse-card-image');
                    if (imgWrap) {
                        imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                        badgesEl = imgWrap.querySelector('.browse-feature-badges');
                    }
                }
                if (badgesEl) {
                    badgesEl.querySelector('.possible-library')?.remove();
                    if (!badgesEl.querySelector('.in-library')) {
                        badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
                    }
                }
            }

            for (const card of grid.querySelectorAll('.browse-card:not(.in-library):not(.possible-library)')) {
                const name = card.querySelector('.browse-card-name')?.textContent || '';
                const creatorEl = card.querySelector('.browse-card-creator-link');
                const creator = creatorEl?.dataset.author || creatorEl?.dataset.creatorName || '';
                if (!this.isCharPossibleMatch(name, creator)) continue;
                card.classList.add('possible-library');
                let badgesEl = card.querySelector('.browse-feature-badges');
                if (!badgesEl) {
                    const imgWrap = card.querySelector('.browse-card-image');
                    if (imgWrap) {
                        imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                        badgesEl = imgWrap.querySelector('.browse-feature-badges');
                    }
                }
                if (badgesEl && !badgesEl.querySelector('.possible-library')) {
                    badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
                }
            }
        }
    }

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
            if (loaded >= this._preloadLimit) break;
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

    _triggerLoadMore() {
        this._prefetching = true;
        this._setScrollIndicator('loading');
        const result = this.loadMore();
        if (result && typeof result.then === 'function') {
            result.then(() => { this._prefetching = false; }, () => { this._prefetching = false; });
        } else {
            setTimeout(() => { this._prefetching = false; }, 300);
        }
    }

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
    _getScrollThreshold() {
        const zoom = parseFloat(document.body.style.zoom) || 1;
        return 1500 / zoom;
    }

    _attachScrollListener() {
        this._detachScrollListener();
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        this._scrollHandler = () => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;

            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
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
            if (hasMore) this._deferredScrollCheck();
        } else {
            el.style.display = hasMore && hasResults ? 'flex' : 'none';
        }
    }

    _deferredScrollCheck() {
        requestAnimationFrame(() => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;
            const sc = document.querySelector('.gallery-content');
            if (!sc) return;
            const distanceFromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
            }
        });
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

    // ── Following Manager (Abstract) ────────────────────────

    /** @returns {boolean} */
    get supportsFollowingManager() { return false; }

    /**
     * Fetch followed creators in normalized form.
     * @returns {Promise<Array<{id: string, name: string, username?: string, avatar?: string, characterCount?: number}>>}
     */
    async getFollowedCreators() { return []; }

    /**
     * Follow a creator by query (name, URL, or UUID).
     * @param {string} query
     * @returns {Promise<{id: string, name: string}|null>}
     */
    async followCreator(query) { return null; }

    /**
     * Unfollow a creator by normalized ID.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async unfollowCreator(id) { return false; }

    /**
     * @param {{id: string, avatar?: string}} creator
     * @returns {string}
     */
    getCreatorAvatarUrl(creator) { return creator.avatar || ''; }

    _getInitialsColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const hue = ((hash % 360) + 360) % 360;
        return `hsl(${hue}, 50%, 35%)`;
    }

    /**
     * Navigate to this creator's characters in the browse grid.
     * Should close the manager panel and switch to browse mode.
     * @param {{id: string, name: string}} creator
     */
    browseCreatorFromManager(creator) {}

    /**
     * Provider-specific sort options for the manager list.
     * @returns {Array<{value: string, label: string}>}
     */
    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
        ];
    }

    // ── Following Manager (Shared UI) ───────────────────────

    /**
     * Render the manager panel HTML. Include in renderView() after the timeline header.
     * @returns {string}
     */
    renderFollowingManagerPanel() {
        if (!this.supportsFollowingManager) return '';
        const pid = this.provider.id;
        const sortOptions = this.getFollowingManagerSortOptions();
        const sortHtml = sortOptions.map(o =>
            `<option value="${o.value}">${o.label}</option>`
        ).join('');

        return `
            <div class="follow-mgr-panel hidden" id="${pid}FollowMgr">
                <div class="follow-mgr-toolbar">
                    <div class="follow-mgr-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="follow-mgr-search glass-input"
                               id="${pid}FollowMgrSearch" placeholder="Filter creators...">
                    </div>
                    <div class="follow-mgr-toolbar-actions">
                        <select class="follow-mgr-sort" id="${pid}FollowMgrSort">
                            ${sortHtml}
                        </select>
                    </div>
                </div>
                <div class="follow-mgr-list" id="${pid}FollowMgrList"></div>
                <div class="follow-mgr-empty hidden" id="${pid}FollowMgrEmpty">
                    <i class="fa-solid fa-user-group"></i>
                    <p>No followed creators</p>
                </div>
                <div class="follow-mgr-add">
                    <input type="search" class="follow-mgr-add-input glass-input"
                           id="${pid}FollowMgrAddInput" placeholder="Follow by name or URL...">
                    <button class="follow-mgr-add-btn glass-btn" id="${pid}FollowMgrAddBtn"
                            title="Follow creator">
                        <i class="fa-solid fa-user-plus"></i>
                    </button>
                </div>
            </div>`;
    }

    /**
     * Attach event listeners for the manager panel. Auto-called from init().
     */
    _initFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        if (!panel) return;

        const sortEl = document.getElementById(`${pid}FollowMgrSort`);
        if (sortEl) {
            CoreAPI.initCustomSelect?.(sortEl);
            sortEl.addEventListener('change', () => {
                this._mgrSort = sortEl.value;
                this._renderManagerCreators();
            });
        }

        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                clearTimeout(this._mgrDebounceTimer);
                this._mgrDebounceTimer = setTimeout(() => {
                    this._mgrFilter = searchEl.value.trim().toLowerCase();
                    this._renderManagerCreators();
                }, 150);
            });
        }

        const addInput = document.getElementById(`${pid}FollowMgrAddInput`);
        const addBtn = document.getElementById(`${pid}FollowMgrAddBtn`);
        const handleAdd = async () => {
            const query = addInput?.value?.trim();
            if (!query) return;
            addBtn?.classList.add('loading');
            try {
                const creator = await this.followCreator(query);
                if (creator) {
                    addInput.value = '';
                    await this._loadManagerCreators();
                    this._renderManagerCreators();
                }
            } catch (e) {
                console.error('[FollowingManager] Follow failed:', e);
                CoreAPI.showToast?.('Failed to follow creator', 'error');
            } finally {
                addBtn?.classList.remove('loading');
            }
        };
        if (addBtn) addBtn.addEventListener('click', handleAdd);
        if (addInput) addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
        });

        // Delegation on the list container
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            list.addEventListener('click', (e) => {
                const card = e.target.closest('.follow-mgr-card');
                if (!card) return;
                const creatorId = card.dataset.creatorId;
                const creator = this._mgrCreators.find(c => c.id === creatorId);
                if (!creator) return;

                // Unfollow button
                const unfollowBtn = e.target.closest('.follow-mgr-unfollow-btn');
                if (unfollowBtn) {
                    this._handleManagerUnfollow(unfollowBtn, card, creator);
                    return;
                }

                // Card click = browse creator
                this.closeFollowingManager();
                this.browseCreatorFromManager(creator);
            });
        }

        // Toggle button
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleFollowingManager());
        }
    }

    toggleFollowingManager() {
        if (this._mgrOpen) {
            this.closeFollowingManager();
        } else {
            this.openFollowingManager();
        }
    }

    async openFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = true;
        toggleBtn?.classList.add('active');
        panel.classList.remove('hidden');

        await this._loadManagerCreators();
        this._renderManagerCreators();
    }

    closeFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = false;
        toggleBtn?.classList.remove('active');
        panel.classList.add('hidden');

        clearTimeout(this._mgrDebounceTimer);
        this._mgrFilter = '';
        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) searchEl.value = '';
    }

    async _loadManagerCreators() {
        this._mgrCreators = await this.getFollowedCreators();
    }

    _renderManagerCreators() {
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        const empty = document.getElementById(`${pid}FollowMgrEmpty`);
        if (!list) return;

        let creators = [...this._mgrCreators];

        // Filter
        if (this._mgrFilter) {
            const q = this._mgrFilter;
            creators = creators.filter(c =>
                c.name.toLowerCase().includes(q) ||
                (c.username && c.username.toLowerCase().includes(q))
            );
        }

        // Sort
        this._sortCreators(creators, this._mgrSort);

        if (creators.length === 0) {
            list.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }

        empty?.classList.add('hidden');
        list.innerHTML = creators.map((c, i) =>
            this._renderManagerCreatorCard(c, i)
        ).join('');
    }

    _renderManagerCreatorCard(creator, index) {
        const avatarUrl = this.getCreatorAvatarUrl(creator);
        const name = CoreAPI.escapeHtml?.(creator.name) || creator.name;
        const username = creator.username ? CoreAPI.escapeHtml?.(creator.username) || creator.username : '';
        const charCount = creator.characterCount != null ? creator.characterCount : -1;
        const initial = (creator.name || '?').charAt(0).toUpperCase();
        const initialsColor = this._getInitialsColor(creator.name || creator.id || '');

        return `
            <div class="follow-mgr-card" data-creator-id="${creator.id}"
                 style="animation-delay: ${index * 0.04}s">
                <div class="follow-mgr-card-avatar">
                    ${avatarUrl
                        ? `<img src="${avatarUrl}" alt="" loading="lazy"
                               onerror="this.style.display='none';this.parentElement.querySelector('.follow-mgr-card-avatar-fallback').style.display='flex'">`
                        : ''}
                    <div class="follow-mgr-card-avatar-fallback"
                         style="${avatarUrl ? 'display:none;' : ''}background-color:${initialsColor}">
                        ${initial}
                    </div>
                </div>
                <div class="follow-mgr-card-info">
                    <div class="follow-mgr-card-name">${name}</div>
                    <div class="follow-mgr-card-meta">
                        ${username ? `<span class="follow-mgr-card-handle">@${username}</span>` : ''}
                        ${charCount >= 0 ? `<span class="follow-mgr-card-count">${charCount} char${charCount !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                </div>
                <div class="follow-mgr-card-actions">
                    <button class="follow-mgr-unfollow-btn glass-btn icon-only"
                            title="Unfollow">
                        <i class="fa-solid fa-user-minus"></i>
                    </button>
                </div>
            </div>`;
    }

    _sortCreators(creators, sort) {
        switch (sort) {
            case 'name_asc':
                creators.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'name_desc':
                creators.sort((a, b) => b.name.localeCompare(a.name));
                break;
            case 'recent':
                creators.sort((a, b) => (b.followedAt || 0) - (a.followedAt || 0));
                break;
            case 'chars':
                creators.sort((a, b) => (b.characterCount || 0) - (a.characterCount || 0));
                break;
        }
    }

    async _handleManagerUnfollow(btn, card, creator) {
        // Two-phase confirm
        if (!btn.dataset.confirming) {
            btn.dataset.confirming = '1';
            btn.classList.add('confirming');
            btn.title = 'Click again to confirm';
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            this._mgrConfirmTimer = setTimeout(() => {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }, 3000);
            return;
        }

        clearTimeout(this._mgrConfirmTimer);
        card.classList.add('removing');
        let success = false;
        try {
            success = await this.unfollowCreator(creator.id);
        } catch (e) {
            console.error('[FollowingManager] Unfollow failed:', e);
            CoreAPI.showToast?.('Failed to unfollow creator', 'error');
        }
        if (success) {
            card.addEventListener('animationend', () => {
                this._mgrCreators = this._mgrCreators.filter(c => c.id !== creator.id);
                this._renderManagerCreators();
            }, { once: true });
        } else {
            card.classList.remove('removing');
            delete btn.dataset.confirming;
            btn.classList.remove('confirming');
            btn.title = 'Unfollow';
            btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
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
        overlay.id = 'browseAvatarViewer';
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

        if (images) {
            const onKey = (e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); showImage(currentIndex - 1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); showImage(currentIndex + 1); }
            };
            document.addEventListener('keydown', onKey);
            overlay._onKey = onKey;
        }

        document.body.appendChild(overlay);
    }

    static closeAvatarViewer() {
        const viewer = document.getElementById('browseAvatarViewer');
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

window.registerOverlay?.({
    id: 'browseAvatarViewer',
    tier: 0,
    static: false,
    close: () => BrowseView.closeAvatarViewer(),
});

export default BrowseView;
