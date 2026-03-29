/* ========================================
   SillyTavern Character Library - Mobile JS
   Clean mobile enhancements - no main code changes
   ======================================== */

/* ========================================
   DATE COMPATIBILITY FIX
   Mobile Chromium (Samsung Internet, Brave) rejects date
   strings that desktop Chrome accepts.
   Three-layer fix:
     1. SmartDate constructor (best effort, may not stick on all engines)
     2. toLocaleDateString safety net (prevents "Invalid Date" text)
     3. DOM-level date fixer reads raw last_mes from localStorage
        chat cache and patches "Unknown" text in chat cards using
        a fully manual regex-based parser — ZERO reliance on Date().
   NO Response/fetch/JSON.parse patching — those break imports.
   ======================================== */
(function datePatch() {
    var OrigDate = Date;

    // ── Month name lookup (for manual parser) ──
    var MONTHS = {
        jan:0, january:0, feb:1, february:1, mar:2, march:2,
        apr:3, april:3, may:4, jun:5, june:5, jul:6, july:6,
        aug:7, august:7, sep:8, sept:8, september:8,
        oct:9, october:9, nov:10, november:10, dec:11, december:11
    };

    // ── Manual regex-based date parser ──
    // Handles ALL known SillyTavern send_date formats WITHOUT
    // relying on Date constructor (which varies by browser).
    function manualParse(s) {
        if (typeof s !== 'string') return null;
        s = s.trim();
        if (!s) return null;

        var y, m, d;

        // 1) Numeric epoch (string of digits)
        if (/^\d{10,13}(\.\d+)?$/.test(s)) {
            var n = Number(s);
            if (n > 0 && n < 1e10) n *= 1000;
            var dt = new OrigDate(n);
            return isNaN(dt.getTime()) ? null : dt;
        }

        // 2) "YYYY-MM-DD..." or "YYYY/MM/DD..." (with optional time, @ separator, T separator)
        //    e.g. "2024-07-19 @ 16h57m30s", "2024-07-19T16:57:30", "2024-07-19 16:57:30"
        var isoMatch = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
        if (isoMatch) {
            y = parseInt(isoMatch[1], 10);
            m = parseInt(isoMatch[2], 10) - 1;
            d = parseInt(isoMatch[3], 10);
            if (y > 1970 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
                return new OrigDate(y, m, d);
            }
        }

        // 3) "Month DD, YYYY..." e.g. "July 19, 2024 4:57:30 PM"
        var longMatch = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
        if (longMatch) {
            var mName = longMatch[1].toLowerCase();
            if (mName in MONTHS) {
                y = parseInt(longMatch[3], 10);
                m = MONTHS[mName];
                d = parseInt(longMatch[2], 10);
                if (y > 1970 && d >= 1 && d <= 31) {
                    return new OrigDate(y, m, d);
                }
            }
        }

        // 4) "DD Month YYYY" e.g. "19 July 2024"
        var dmyMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
        if (dmyMatch) {
            var mName2 = dmyMatch[2].toLowerCase();
            if (mName2 in MONTHS) {
                y = parseInt(dmyMatch[3], 10);
                m = MONTHS[mName2];
                d = parseInt(dmyMatch[1], 10);
                if (y > 1970 && d >= 1 && d <= 31) {
                    return new OrigDate(y, m, d);
                }
            }
        }

        // 5) "MM/DD/YYYY" US date format
        var usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (usMatch) {
            y = parseInt(usMatch[3], 10);
            m = parseInt(usMatch[1], 10) - 1;
            d = parseInt(usMatch[2], 10);
            if (y > 1970 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
                return new OrigDate(y, m, d);
            }
        }

        return null;
    }

    // ── Fix mobile-incompatible date strings for SmartDate constructor ──
    function fixDateString(s) {
        if (typeof s !== 'string') return s;
        s = s.trim();
        if (s === '') return s;

        // Numeric string → epoch ms
        if (/^\d+(\.\d+)?$/.test(s)) {
            var n = Number(s);
            return (n > 0 && n < 1e10) ? n * 1000 : n;
        }

        // Strip @ and everything after for SillyTavern datetime strings
        var at = s.indexOf('@');
        if (at > 0) s = s.substring(0, at).trim();

        // "YYYY-MM-DD ..." (no T) → slash separators for mobile compat
        if (/^\d{4}-\d{1,2}-\d{1,2}(\s|$)/.test(s)) {
            s = s.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, '$1/$2/$3');
        }

        return s;
    }

    // ── Combined parser: manual first, then Date constructor fallback ──
    function parseDate(v) {
        if (v == null || v === '') return null;

        // Handle numbers directly
        if (typeof v === 'number') {
            var d = new OrigDate(v > 0 && v < 1e10 ? v * 1000 : v);
            return isNaN(d.getTime()) ? null : d;
        }

        // Manual parser — guaranteed to work on all browsers
        var manual = manualParse(String(v));
        if (manual) return manual;

        // Last resort: try Date constructor with fixDateString
        try {
            var fixed = fixDateString(v);
            if (typeof fixed === 'number') {
                d = new OrigDate(fixed);
                if (!isNaN(d.getTime())) return d;
            }
            d = new OrigDate(fixed);
            if (!isNaN(d.getTime())) return d;
            d = new OrigDate(v);
            if (!isNaN(d.getTime())) return d;
        } catch (e) {}

        return null;
    }

    // ── Format a Date to locale string without relying on toLocaleDateString ──
    function formatDate(d) {
        if (!d || isNaN(d.getTime())) return null;
        // Manual formatting: M/D/YYYY
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }

    // ── Replace Date constructor (best effort) ──
    try {
        function SmartDate(a, b, c, d, e, f, g) {
            var len = arguments.length;
            if (!(this instanceof SmartDate)) return OrigDate();
            if (len === 0) return new OrigDate();
            if (len === 1) {
                if (typeof a === 'string') {
                    // Try manual parse first, then fixDateString
                    var mp = manualParse(a);
                    if (mp) return mp;
                    return new OrigDate(fixDateString(a));
                }
                return new OrigDate(a);
            }
            if (len === 2) return new OrigDate(a, b);
            if (len === 3) return new OrigDate(a, b, c);
            if (len === 4) return new OrigDate(a, b, c, d);
            if (len === 5) return new OrigDate(a, b, c, d, e);
            if (len === 6) return new OrigDate(a, b, c, d, e, f);
            return new OrigDate(a, b, c, d, e, f, g);
        }
        SmartDate.prototype = OrigDate.prototype;
        SmartDate.now = OrigDate.now;
        SmartDate.parse = function (s) {
            if (typeof s === 'string') {
                var mp = manualParse(s);
                if (mp) return mp.getTime();
                return OrigDate.parse(fixDateString(s));
            }
            return OrigDate.parse(s);
        };
        SmartDate.UTC = function () { return OrigDate.UTC.apply(OrigDate, arguments); };
        try { Object.defineProperty(SmartDate, 'length', { value: 7 }); } catch (e) {}
        try { Object.defineProperty(SmartDate, 'name', { value: 'Date' }); } catch (e) {}

        // Multiple assignment strategies — at least one must stick
        try { window.Date = SmartDate; } catch (e) {}
        try { Date = SmartDate; } catch (e) {}
        try {
            Object.defineProperty(window, 'Date', {
                value: SmartDate, writable: true, configurable: true
            });
        } catch (e) {}
    } catch (e) {}

    // ── Safety net: toLocaleDateString returns 'Unknown' for invalid ──
    try {
        var OrigToLocale = OrigDate.prototype.toLocaleDateString;
        OrigDate.prototype.toLocaleDateString = function () {
            try { if (isNaN(this.getTime())) return 'Unknown'; } catch (ex) { return 'Unknown'; }
            try { return OrigToLocale.apply(this, arguments); } catch (ex2) {
                return formatDate(this) || 'Unknown';
            }
        };
    } catch (e) {}

    // ── Expose parseDate + formatDate for DOM fixer ──
    window.__mobileDateParse = parseDate;
    window.__mobileDateFormat = formatDate;
    console.log('[MobileDatePatch] v3 loaded — manual parser active');
})();

/* ========================================
   OVERLAY REGISTRY
   Modules call window.registerOverlay(config) to register overlays.
   The back-button stack (mobile) and global Escape handler (all platforms)
   both read from this registry so new overlays don't require editing
   library-mobile.js or wiring their own Escape listeners.

   Config shape:
     id        {string}   — DOM element ID
     tier      {number}   — z-order priority (lower number = closes first = higher z-index)
     close     {function} — called with the element to close it
     static    {boolean}  — protect from catch-all el.remove() (default: true)
     escape    {boolean}  — respond to Escape key (default: true)
     visible   {function} — optional override: (el) => bool. Default: !el.classList.contains('hidden')
   ======================================== */
window._overlayRegistry = [];
window.registerOverlay = function(cfg) {
    window._overlayRegistry.push(cfg);
};

/* ========================================
   MAIN MOBILE ENHANCEMENTS IIFE
   ======================================== */
(function MobileEnhancements() {
    'use strict';

    // Only run on mobile viewports
    function isMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    if (!isMobile()) return;

    // Ensure viewport-fit=cover for safe-area-inset to work
    (function fixViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (meta && meta.content.indexOf('viewport-fit') === -1) {
            meta.content += ', viewport-fit=cover';
        }
    })();

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        // Small delay to let library.js finish initialization
        setTimeout(setup, 200);
    }

    function setup() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;

        createSearchButton(topbar);
        createSettingsButton(topbar);
        createMenuButton(topbar);
        setupModalAvatar();
        setupGallerySwipe();
        setupBrowseGallerySwipe();
        setupGreetingsSwipe();
        setupTabSwipe();
        setupViewSwipe();
        setupContextMenu();
        setupViewportFix();
        relocateTagPopup();
        relocatePlaylistPopup();
        setDefaultExpandZoom();
        setupLorebookModalToolbar();
        fixInvalidDateText();
        setupChubFilterArea();
        setupGallerySyncDropdown();
        fixRefreshLoadingStuck();
        preventAutoFocusOnOpen();
        setupMobileTagEditor();
        setupModalHeaderCollapse();
        setupMultiSelectConfirm();
        setupBackButton();
    }

    /* ========================================
       ANDROID BACK BUTTON
       ======================================== */
    function setupBackButton() {
        // Built lazily — ProviderRegistry may not exist yet at setup time
        // (ES modules load async, this runs 200ms after DOMContentLoaded)
        const BASE_STATIC_HARDCODED = ['charModal', 'chatPreviewModal', 'chubLoginModal', 'creatorModal'];
        let _staticOverlays = null;
        function getStaticOverlays() {
            if (!_staticOverlays) {
                const providerIds = window.ProviderRegistry?.getPreviewModalIds?.() || [];
                const registryIds = (window._overlayRegistry || [])
                    .filter(r => r.static !== false)
                    .map(r => r.id);
                if (providerIds.length > 0 || registryIds.length > 0) {
                    _staticOverlays = new Set([...BASE_STATIC_HARDCODED, ...providerIds, ...registryIds]);
                }
            }
            return _staticOverlays || new Set([...BASE_STATIC_HARDCODED,
                ...(window._overlayRegistry || []).filter(r => r.static !== false).map(r => r.id)]);
        }

        const multiSelectHandler = () => {
            if (window.MultiSelect?.enabled) {
                window.MultiSelect.disable();
                return true;
            }
            return false;
        };

        const stack = [
            // Tier 0 — avatar/gallery quick-view (highest z-index)
            ['#browseAvatarViewer', el => {
                if (el._onKey) document.removeEventListener('keydown', el._onKey);
                el.remove();
            }],
            ['.mobile-avatar-viewer', () => closeAvatarViewer()],

            // Tier 1 — top z-index overlays
            ['#galleryViewerModal.visible',    () => window.closeGalleryViewer?.()],
            ['.mobile-ctx-sheet.visible',      () => { document.querySelector('.mobile-ctx-sheet')?.classList.remove('visible'); document.querySelector('.mobile-ctx-scrim')?.classList.remove('visible'); }],
            ['#clContextMenu.visible',         el => el.classList.remove('visible')],
            ['.custom-select-menu:not(.hidden)', el => el.classList.add('hidden')],
            ['#batchTagModal.visible',         el => el.classList.remove('visible')],

            // When char details is stacked above another modal, unwind its layers first
            () => {
                if (!document.body.classList.contains('char-modal-above')) return false;
                // Close the topmost non-pinned confirm-modal first (e.g. localizeModal over charModal)
                const visibleConfirms = [...document.querySelectorAll('.confirm-modal:not(.hidden)')];
                const unpinned = visibleConfirms.filter(m => !m.style.getPropertyPriority('z-index'));
                if (unpinned.length > 0) { unpinned[unpinned.length - 1].classList.add('hidden'); return true; }
                const charModal = document.getElementById('charModal');
                if (charModal && !charModal.classList.contains('hidden')) { window.closeModal?.(); return true; }
                return false;
            },

            ['#cardUpdateSingleModal.visible', el => el.classList.remove('visible')],
            ['#cardUpdateBatchModal.visible',  el => el.classList.remove('visible')],

            // Tier 1.5 — catch-all for dynamic modal-overlays
            () => {
                for (const el of document.querySelectorAll('.modal-overlay:not(.hidden)')) {
                    if (!getStaticOverlays().has(el.id)) {
                        el.remove();
                        return true;
                    }
                }
                return false;
            },

            // Tier 2 — confirm/dialog modals (z-2000+)
            ['#disableGalleryFoldersModal',          el => el.remove()],
            ['#confirmSaveModal:not(.hidden)',        el => el.classList.add('hidden')],
            ['#preImportDuplicateModal:not(.hidden)', el => el.classList.add('hidden')],
            ['#providerLinkModal:not(.hidden)',           el => el.classList.add('hidden')],
            ['#bulkAutoLinkModal:not(.hidden)',       el => el.classList.add('hidden')],
            ['#galleryInfoModal:not(.hidden)',        el => el.classList.add('hidden')],
            ['#gallerySettingsModal:not(.hidden)',    el => el.classList.add('hidden')],
            ['#localizeModal:not(.hidden)',           el => el.classList.add('hidden')],
            ['#bulkLocalizeModal:not(.hidden)',       el => el.classList.add('hidden')],
            ['#bulkLocalizeSummaryModal:not(.hidden)', el => el.classList.add('hidden')],
            ['#charDuplicatesModal:not(.hidden)',     el => el.classList.add('hidden')],
            ['#importSummaryModal:not(.hidden)',      el => el.classList.add('hidden')],
            ['#recommenderModal:not(.hidden)',        el => el.classList.add('hidden')],
            ['#importModal:not(.hidden)',             el => el.classList.add('hidden')],
            ['#deleteConfirmModal',                   el => el.remove()],
            ['#deleteDuplicateModal',                 el => el.remove()],
            ['#legacyFolderModal',                    el => el.remove()],
            ['#folderMappingModal',                   el => el.remove()],
            ['#orphanedFoldersModal',                 el => el.remove()],
            ['#playlistPickerModal.visible',          el => window.closePlaylistPicker?.()],
            ['#playlistManageModal.visible',          el => window.closePlaylistManager?.()],

            // Tier 2.5 — mobile sheets & overlays
            ['.mobile-search-overlay:not(.hidden)', () => {
                const overlay = document.querySelector('.mobile-search-overlay');
                if (overlay) overlay.classList.add('hidden');
                const searchBox = document.querySelector('.search-box');
                const searchArea = document.querySelector('.search-area');
                if (searchBox && searchArea) searchArea.insertBefore(searchBox, searchArea.firstChild);
            }],
            ['.mobile-sheet-overlay:not(.hidden)', el => {
                el.querySelector('.mobile-sheet')?.classList.remove('open');
                setTimeout(() => el.classList.add('hidden'), 300);
            }],
            ['#tagFilterPopup:not(.hidden)', el => el.classList.add('hidden')],
            ['#playlistFilterPopup:not(.hidden)', el => el.classList.add('hidden')],

            // Tier 3 — tag editor sheet
            ['.tag-editor-sheet:not(.hidden)', el => { el.classList.add('hidden'); document.getElementById('tagEditorSheetAutocomplete')?.classList.add('hidden'); }],

            // Tier 3.5 — registered overlays (populated via window.registerOverlay)
            () => {
                const regs = [...(window._overlayRegistry || [])]
                    .sort((a, b) => a.tier - b.tier);
                for (const reg of regs) {
                    const el = document.getElementById(reg.id);
                    if (!el) continue;
                    const visible = reg.visible ? reg.visible(el) : !el.classList.contains('hidden');
                    if (visible) { reg.close(el); return true; }
                }
                return false;
            },

            // Tier 3 — full-screen modals
            ['#chatPreviewModal:not(.hidden)',  el => el.classList.add('hidden')],
            ['#chubLoginModal:not(.hidden)',    el => el.classList.add('hidden')],
            () => {
                const reg = window.ProviderRegistry;
                const ids = reg?.getPreviewModalIds?.() || [];
                for (const id of ids) {
                    const el = document.getElementById(id);
                    if (el && !el.classList.contains('hidden')) {
                        reg.closeActivePreviewModal();
                        return true;
                    }
                }
                return false;
            },

            // Tier 4 — in-modal sub-views
            ['.vt-container.vt-detail-open', el => el.classList.remove('vt-detail-open')],

            // Tier 5 — main modals (lowest priority full-screen)
            ['#charModal:not(.hidden)',    () => window.closeModal?.()],
            ['#creatorModal:not(.hidden)', () => window.closeCharacterCreator?.()],

            // Tier 5.5 — multi-select mode
            multiSelectHandler,

            // Tier 6 — dropdowns (browse filter dropdowns are relocated to body on mobile)
            ['#moreOptionsMenu:not(.hidden)',     el => el.classList.add('hidden')],
            ['#settingsMenu:not(.hidden)',        el => el.classList.add('hidden')],
            () => {
                const dd = document.querySelector('body > .dropdown-menu[data-mobile-relocated]:not(.hidden)');
                if (dd) { dd.classList.add('hidden'); return true; }
                const tags = document.querySelector('body > .browse-tags-dropdown[data-mobile-relocated]:not(.hidden)');
                if (tags) { tags.classList.add('hidden'); return true; }
                return false;
            },

            // Tier 7 — active text search on characters view
            () => {
                if (window.getCurrentView?.() !== 'characters') return false;
                const input = document.getElementById('searchInput');
                if (!input || !input.value.trim()) return false;
                input.value = '';
                document.getElementById('clearSearchBtn')?.classList.add('hidden');
                window.performSearch?.();
                return true;
            },
        ];

        // ── location.hash guards ──
        // Chromium (and especially Brave) silently skips pushState entries
        // during back-button traversal via the "history manipulation
        // intervention." Using location.hash creates real same-document
        // navigation entries that browsers treat as genuine history.
        //
        // Strategy: each modal open pushes one guard. Each back press
        // consumes one guard and closes one layer. If the browser skips
        // intermediate guards (landing on '' with modals still open), a
        // new guard is pushed so remaining modals can still be closed.
        let guardId = 0;
        let processedHash = null;

        function pushGuard() {
            guardId++;
            processedHash = null;
            location.hash = 'g' + guardId;
        }

        function closeTopLayer() {
            for (let i = 0; i < stack.length; i++) {
                const entry = stack[i];
                if (typeof entry === 'function') {
                    if (entry()) return true;
                    continue;
                }
                const [selector, closeFn] = entry;
                const el = document.querySelector(selector);
                if (el) { closeFn(el); return true; }
            }
            return false;
        }

        function hasOpenModals() {
            for (let i = 0; i < stack.length; i++) {
                const entry = stack[i];
                if (typeof entry === 'function') {
                    if (entry === multiSelectHandler) {
                        if (window.MultiSelect?.enabled) return true;
                    }
                    continue;
                }
                const [selector] = entry;
                if (document.querySelector(selector)) return true;
            }
            return false;
        }

        const classObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const el = m.target;
                const oldClasses = m.oldValue || '';

                if (el.classList.contains('modal-overlay') || el.classList.contains('confirm-modal') ||
                    el.classList.contains('ai-studio-overlay') || el.classList.contains('creator-import-overlay') ||
                    el.classList.contains('creator-saveas-diff-overlay')) {
                    const wasHidden = oldClasses.includes('hidden');
                    const isHidden = el.classList.contains('hidden');
                    if (wasHidden && !isHidden) {
                        pushGuard();
                        return;
                    }
                }
                if (el.classList.contains('gv-modal') || el.classList.contains('cl-modal')) {
                    const wasVisible = oldClasses.includes('visible');
                    const isVisible = el.classList.contains('visible');
                    if (!wasVisible && isVisible) {
                        pushGuard();
                        return;
                    }
                }
                if (el === document.body) {
                    const had = oldClasses.includes('multi-select-mode');
                    const has = el.classList.contains('multi-select-mode');
                    if (!had && has) { pushGuard(); return; }
                }
            }
        });

        document.querySelectorAll('.modal-overlay, .cl-modal, .gv-modal, .confirm-modal').forEach(el => {
            classObserver.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        });
        classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

        const childObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList.contains('modal-overlay') ||
                        node.classList.contains('confirm-modal') ||
                        node.classList.contains('mobile-avatar-viewer') ||
                        node.classList.contains('browse-avatar-viewer')) {
                        if (!node.classList.contains('hidden')) pushGuard();
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                    }
                    if (node.classList.contains('gv-modal') || node.classList.contains('cl-modal')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                    }
                    if (node.classList.contains('ai-studio-overlay') ||
                        node.classList.contains('creator-import-overlay') ||
                        node.classList.contains('creator-saveas-diff-overlay')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                        // Inject + show often happen in the same sync block — by the time
                        // childObserver fires, 'hidden' is already gone. Push now if visible.
                        if (!node.classList.contains('hidden')) pushGuard();
                    }
                }
            }
        });
        childObserver.observe(document.body, { childList: true });

        // ── Back-press handler ──
        function onBack() {
            const h = location.hash;
            // Ignore our own guard pushes, and deduplicate hashchange+popstate
            // firing for the same back press (both see the same hash value).
            // processedHash is null (not '') so it never collides with the base URL.
            if (h === '#g' + guardId || (processedHash !== null && h === processedHash)) return;
            processedHash = h;
            if (closeTopLayer() && !location.hash && hasOpenModals()) {
                // Browser skipped intermediate guards and landed at the base URL
                // while modals are still open — replenish so the next press closes
                // the remaining layer instead of letting the tab navigate away.
                pushGuard();
            }
        }

        window.addEventListener('hashchange', onBack);
        window.addEventListener('popstate', onBack);

        // ── Safety net: prevent tab close when modals are open ──
        // On Android, if hash guards are exhausted or skipped by the
        // browser, this shows a native "Leave site?" dialog instead of
        // silently killing the tab.
        window.addEventListener('beforeunload', function(e) {
            if (hasOpenModals()) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        });
    }

    /* ========================================
       SEARCH OVERLAY
       ======================================== */
    function createSearchButton(topbar) {
        const searchArea = topbar.querySelector('.search-area');
        if (!searchArea) return;

        // Create the search button
        const btn = document.createElement('button');
        btn.id = 'mobileSearchBtn';
        btn.innerHTML = '<i class="fa-solid fa-search"></i>';
        btn.title = 'Search';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        searchArea.appendChild(btn);

        // Build overlay (starts hidden)
        const overlay = document.createElement('div');
        overlay.className = 'mobile-search-overlay hidden';

        const container = document.createElement('div');
        container.className = 'mobile-search-container';

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        // Get the original search box (with all its event bindings intact)
        const searchBox = searchArea.querySelector('.search-box');

        function openSearch() {
            if (searchBox) {
                // Move original search box into the overlay to preserve bindings
                container.appendChild(searchBox);
            }
            overlay.style.top = `${topbar.offsetHeight}px`;
            overlay.classList.remove('hidden');
            // Focus after transition
            setTimeout(() => {
                const input = document.getElementById('searchInput');
                if (input) input.focus();
            }, 50);
        }

        function closeSearch() {
            overlay.classList.add('hidden');
            if (searchBox) {
                // Move search box back to its original parent
                searchArea.insertBefore(searchBox, searchArea.firstChild);
            }
        }

        btn.addEventListener('click', openSearch);
        // Close on backdrop tap (but not on the container itself)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSearch();
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                closeSearch();
            }
        });
    }

    /* ========================================
       SETTINGS BOTTOM SHEET (view-aware)
       Shows different controls based on active view
       ======================================== */
    function createSettingsButton(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileSettingsBtn';
        btn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        btn.title = 'Settings';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        topbar.appendChild(btn);

        const { overlay, sheet, close } = createBottomSheet();

        const handle = document.createElement('div');
        handle.className = 'mobile-sheet-handle';
        sheet.appendChild(handle);

        const body = document.createElement('div');
        body.className = 'mobile-settings-body';
        sheet.appendChild(body);

        // ===== CHARACTERS SECTION =====
        const charSection = document.createElement('div');
        charSection.className = 'mobile-settings-view-section';
        charSection.dataset.view = 'characters';
        body.appendChild(charSection);

        // Sort
        const sortSection = createSection('Sort By');
        const sortSelect = document.createElement('select');
        sortSelect.className = 'mobile-settings-select';
        const realSort = document.getElementById('sortSelect');
        if (realSort) {
            Array.from(realSort.options).forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.textContent;
                o.selected = opt.selected;
                sortSelect.appendChild(o);
            });
            sortSelect.addEventListener('change', () => {
                realSort.value = sortSelect.value;
                realSort.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        sortSection.appendChild(sortSelect);
        charSection.appendChild(sortSection);

        // Filters
        const filterSection = createSection('Filters');
        const filterRow = document.createElement('div');
        filterRow.className = 'mobile-settings-row';

        const favChip = createChip('<i class="fa-solid fa-star"></i> Favorites');
        const favCheckbox = document.getElementById('searchFavoritesOnly');
        if (favCheckbox && favCheckbox.checked) favChip.classList.add('active');
        favChip.addEventListener('click', () => {
            const cb = document.getElementById('searchFavoritesOnly');
            const newState = cb ? !cb.checked : true;
            if (typeof window.toggleFavoritesFilter === 'function') {
                window.toggleFavoritesFilter(newState);
            }
            setTimeout(() => {
                const cbNow = document.getElementById('searchFavoritesOnly');
                favChip.classList.toggle('active', cbNow ? cbNow.checked : false);
            }, 50);
        });

        const tagChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        tagChip.addEventListener('click', () => {
            const tagBtn = document.getElementById('tagFilterBtn');
            if (tagBtn) { close(); setTimeout(() => tagBtn.click(), 300); }
        });

        const playlistChip = createChip('<i class="fa-solid fa-list-ul"></i> Playlists');
        playlistChip.addEventListener('click', () => {
            const plBtn = document.getElementById('playlistFilterBtn');
            if (plBtn) { close(); setTimeout(() => plBtn.click(), 300); }
        });

        filterRow.appendChild(favChip);
        filterRow.appendChild(tagChip);
        filterRow.appendChild(playlistChip);
        filterSection.appendChild(filterRow);
        charSection.appendChild(filterSection);

        // Search In
        const searchSection = createSection('Search in');
        const checksGrid = document.createElement('div');
        checksGrid.className = 'mobile-settings-checks';
        [{ id: 'searchName', label: 'Name' }, { id: 'searchTags', label: 'Tags' },
         { id: 'searchAuthor', label: 'Author' }, { id: 'searchNotes', label: 'Notes' }]
        .forEach(field => {
            const realCb = document.getElementById(field.id);
            if (!realCb) return;
            const lbl = document.createElement('label');
            lbl.className = 'mobile-check-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = realCb.checked;
            cb.addEventListener('change', () => {
                realCb.checked = cb.checked;
                realCb.dispatchEvent(new Event('change', { bubbles: true }));
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(field.label));
            checksGrid.appendChild(lbl);
        });
        searchSection.appendChild(checksGrid);
        charSection.appendChild(searchSection);

        // Refresh
        const charRefresh = createSection('');
        const charRefreshBtn = createChip('<i class="fa-solid fa-sync"></i> Refresh Characters');
        charRefreshBtn.style.width = '100%';
        charRefreshBtn.addEventListener('click', () => {
            const r = document.getElementById('menuRefreshBtn');
            if (r) r.click();
            close();
        });
        charRefresh.appendChild(charRefreshBtn);
        charSection.appendChild(charRefresh);

        // ===== MODE-TOGGLE PROVIDER SECTION (Chub, Pyg, any provider with hasModeToggle) =====
        const modeToggleSection = document.createElement('div');
        modeToggleSection.className = 'mobile-settings-view-section';
        modeToggleSection.dataset.view = 'online';
        body.appendChild(modeToggleSection);

        let _lastModeToggleProviderId = null;

        // Mode toggle (Browse / Following)
        const modeSection = createSection('Mode');
        const modeRow = document.createElement('div');
        modeRow.className = 'mobile-settings-row';

        const browseChip = createChip('<i class="fa-solid fa-compass"></i> Browse');
        const followChip = createChip('<i class="fa-solid fa-users"></i> Following');
        browseChip.classList.add('active');

        function getIds() {
            return window.ProviderRegistry?.getActiveMobileFilterIds?.();
        }

        function syncMode() {
            const ids = getIds();
            if (!ids?.modeBrowseSelector) return;
            const browseBtn = document.querySelector(ids.modeBrowseSelector);
            const followBtn = document.querySelector(ids.modeFollowSelector);
            if (browseBtn) browseChip.classList.toggle('active', browseBtn.classList.contains('active'));
            if (followBtn) followChip.classList.toggle('active', followBtn.classList.contains('active'));
        }

        function syncSort() {
            const isFollowing = followChip.classList.contains('active');
            mtBrowseSortSelect.style.display = isFollowing ? 'none' : '';
            mtFollowSortSelect.style.display = isFollowing ? '' : 'none';
        }

        browseChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.modeBrowseSelector ? document.querySelector(ids.modeBrowseSelector) : null;
            if (realBtn) { realBtn.click(); setTimeout(() => { syncMode(); syncSort(); }, 100); }
            close();
        });
        followChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.modeFollowSelector ? document.querySelector(ids.modeFollowSelector) : null;
            if (realBtn) { realBtn.click(); setTimeout(() => { syncMode(); syncSort(); }, 100); }
            close();
        });

        modeRow.appendChild(browseChip);
        modeRow.appendChild(followChip);
        modeSection.appendChild(modeRow);
        modeToggleSection.appendChild(modeSection);

        // Sort — two selects: Browse sort + Following sort, toggled by mode
        const mtSortSection = createSection('Sort By');

        const mtBrowseSortSelect = document.createElement('select');
        mtBrowseSortSelect.className = 'mobile-settings-select';
        mtBrowseSortSelect.addEventListener('change', () => {
            const ids = getIds();
            const real = ids?.sort ? document.getElementById(ids.sort) : null;
            if (real) {
                real.value = mtBrowseSortSelect.value;
                real.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        mtSortSection.appendChild(mtBrowseSortSelect);

        const mtFollowSortSelect = document.createElement('select');
        mtFollowSortSelect.className = 'mobile-settings-select';
        mtFollowSortSelect.style.display = 'none';
        mtFollowSortSelect.addEventListener('change', () => {
            const ids = getIds();
            const real = ids?.timelineSort ? document.getElementById(ids.timelineSort) : null;
            if (real) {
                real.value = mtFollowSortSelect.value;
                real.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        mtSortSection.appendChild(mtFollowSortSelect);
        modeToggleSection.appendChild(mtSortSection);

        // Filters row (Tags, Features, NSFW)
        const mtFilterSection = createSection('Filters');
        const mtFilterRow = document.createElement('div');
        mtFilterRow.className = 'mobile-settings-row';
        mtFilterRow.style.flexWrap = 'wrap';

        const mtTagsChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        mtTagsChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.tags ? document.getElementById(ids.tags) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const mtFeaturesChip = createChip('<i class="fa-solid fa-sliders"></i> Features');
        mtFeaturesChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.filters ? document.getElementById(ids.filters) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const mtNsfwChip = createChip('<i class="fa-solid fa-shield-halved"></i> SFW Only');
        function syncMtNsfwState() {
            const ids = getIds();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) {
                const span = realBtn.querySelector('span');
                const label = span ? span.textContent.trim() : 'SFW Only';
                mtNsfwChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + label;
                mtNsfwChip.classList.toggle('active', realBtn.classList.contains('active'));
            }
        }
        mtNsfwChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncMtNsfwState, 100); }
        });

        mtFilterRow.appendChild(mtTagsChip);
        mtFilterRow.appendChild(mtFeaturesChip);
        mtFilterRow.appendChild(mtNsfwChip);
        mtFilterSection.appendChild(mtFilterRow);
        modeToggleSection.appendChild(mtFilterSection);

        // Refresh
        const mtActionsSection = createSection('');
        const mtActionsRow = document.createElement('div');
        mtActionsRow.className = 'mobile-settings-row';

        const mtRefreshChip = createChip('<i class="fa-solid fa-sync"></i> Refresh');
        mtRefreshChip.style.width = '100%';
        mtRefreshChip.addEventListener('click', () => {
            const ids = getIds();
            const realBtn = ids?.refresh ? document.getElementById(ids.refresh) : null;
            if (realBtn) { realBtn.click(); close(); }
        });

        mtActionsRow.appendChild(mtRefreshChip);
        mtActionsSection.appendChild(mtActionsRow);
        modeToggleSection.appendChild(mtActionsSection);

        // ===== GENERIC PROVIDER SECTION (no mode toggle — Janny, CT, future providers) =====
        const genericSection = document.createElement('div');
        genericSection.className = 'mobile-settings-view-section';
        genericSection.dataset.view = 'online';
        genericSection.style.display = 'none';

        const genericProviderLabel = document.createElement('div');
        genericProviderLabel.className = 'mobile-settings-label';
        genericProviderLabel.id = 'mobileProviderName';
        genericProviderLabel.textContent = '';

        // Sort
        const genericSortSection = createSection('Sort By');
        const genericSortSelect = document.createElement('select');
        genericSortSelect.className = 'mobile-settings-select';
        genericSortSelect.addEventListener('change', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const real = ids?.sort ? document.getElementById(ids.sort) : null;
            if (real) {
                real.value = genericSortSelect.value;
                real.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        genericSortSection.appendChild(genericSortSelect);
        genericSection.appendChild(genericProviderLabel);
        genericSection.appendChild(genericSortSection);

        // Filters row (Tags, Features, NSFW)
        const genericFilterSection = createSection('Filters');
        const genericFilterRow = document.createElement('div');
        genericFilterRow.className = 'mobile-settings-row';
        genericFilterRow.style.flexWrap = 'wrap';

        const genericTagsChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        genericTagsChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.tags ? document.getElementById(ids.tags) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const genericFeaturesChip = createChip('<i class="fa-solid fa-sliders"></i> Features');
        genericFeaturesChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.filters ? document.getElementById(ids.filters) : null;
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const genericNsfwChip = createChip('<i class="fa-solid fa-shield-halved"></i> SFW Only');
        function syncGenericNsfwState() {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) {
                const span = realBtn.querySelector('span');
                const label = span ? span.textContent.trim() : 'SFW Only';
                genericNsfwChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + label;
                genericNsfwChip.classList.toggle('active', realBtn.classList.contains('active'));
            }
        }
        genericNsfwChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.nsfw ? document.getElementById(ids.nsfw) : null;
            if (realBtn) { realBtn.click(); setTimeout(syncGenericNsfwState, 100); }
        });

        genericFilterRow.appendChild(genericTagsChip);
        genericFilterRow.appendChild(genericFeaturesChip);
        genericFilterRow.appendChild(genericNsfwChip);
        genericFilterSection.appendChild(genericFilterRow);
        genericSection.appendChild(genericFilterSection);

        // Refresh
        const genericActionsSection = createSection('');
        const genericRefreshChip = createChip('<i class="fa-solid fa-sync"></i> Refresh');
        genericRefreshChip.style.width = '100%';
        genericRefreshChip.addEventListener('click', () => {
            const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.();
            const realBtn = ids?.refresh ? document.getElementById(ids.refresh) : null;
            if (realBtn) { realBtn.click(); close(); }
        });
        genericActionsSection.appendChild(genericRefreshChip);
        genericSection.appendChild(genericActionsSection);
        body.appendChild(genericSection);

        // ===== CHATS SECTION =====
        const chatsSection = document.createElement('div');
        chatsSection.className = 'mobile-settings-view-section';
        chatsSection.dataset.view = 'chats';
        body.appendChild(chatsSection);

        // Sort
        const chatsSortSection = createSection('Sort By');
        const chatsSortSelect = document.createElement('select');
        chatsSortSelect.className = 'mobile-settings-select';
        const realChatsSort = document.getElementById('chatsSortSelect');
        if (realChatsSort) {
            Array.from(realChatsSort.options).forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.textContent;
                o.selected = opt.selected;
                chatsSortSelect.appendChild(o);
            });
            chatsSortSelect.addEventListener('change', () => {
                realChatsSort.value = chatsSortSelect.value;
                realChatsSort.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        chatsSortSection.appendChild(chatsSortSelect);
        chatsSection.appendChild(chatsSortSection);

        // Grouping toggle
        const groupSection = createSection('View');
        const groupRow = document.createElement('div');
        groupRow.className = 'mobile-settings-row';

        const flatChip = createChip('<i class="fa-solid fa-list"></i> Flat List');
        const groupedChip = createChip('<i class="fa-solid fa-layer-group"></i> Grouped');
        flatChip.classList.add('active');

        function syncGrouping() {
            const realBtns = document.querySelectorAll('.grouping-btn');
            realBtns.forEach(b => {
                if (b.dataset.group === 'flat') {
                    flatChip.classList.toggle('active', b.classList.contains('active'));
                } else if (b.dataset.group === 'grouped') {
                    groupedChip.classList.toggle('active', b.classList.contains('active'));
                }
            });
        }

        flatChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.grouping-btn[data-group="flat"]');
            if (realBtn) { realBtn.click(); setTimeout(syncGrouping, 100); }
        });
        groupedChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.grouping-btn[data-group="grouped"]');
            if (realBtn) { realBtn.click(); setTimeout(syncGrouping, 100); }
        });

        groupRow.appendChild(flatChip);
        groupRow.appendChild(groupedChip);
        groupSection.appendChild(groupRow);
        chatsSection.appendChild(groupSection);

        // Refresh
        const chatsRefresh = createSection('');
        const chatsRefreshBtn = createChip('<i class="fa-solid fa-sync"></i> Refresh Chats');
        chatsRefreshBtn.style.width = '100%';
        chatsRefreshBtn.addEventListener('click', () => {
            const r = document.getElementById('refreshChatsViewBtn');
            if (r) r.click();
            close();
        });
        chatsRefresh.appendChild(chatsRefreshBtn);
        chatsSection.appendChild(chatsRefresh);

        // ===== VIEW-AWARE OPEN LOGIC =====
        btn.addEventListener('click', () => {
            const activeView = getActiveView();

            // Show/hide sections based on active view
            body.querySelectorAll('.mobile-settings-view-section').forEach(s => {
                s.style.display = s.dataset.view === activeView ? '' : 'none';
            });

            // Sync state before opening
            if (activeView === 'online') {
                const reg = window.ProviderRegistry;
                const hasModeToggle = reg?.activeProviderHasModeToggle?.() || false;
                const ids = reg?.getActiveMobileFilterIds?.();

                // Toggle mode-toggle section vs generic section
                modeToggleSection.style.display = hasModeToggle ? '' : 'none';
                genericSection.style.display = hasModeToggle ? 'none' : '';

                if (!hasModeToggle) {
                    const prov = reg?.getActiveProvider?.();
                    genericProviderLabel.textContent = prov ? prov.name : 'Online';

                    const realSort = ids?.sort ? document.getElementById(ids.sort) : null;
                    if (realSort) {
                        genericSortSelect.innerHTML = realSort.innerHTML;
                        genericSortSelect.value = realSort.value;
                    }
                    syncGenericNsfwState();
                }

                if (hasModeToggle) {
                    const realBrowseSort = ids?.sort ? document.getElementById(ids.sort) : null;
                    if (realBrowseSort) {
                        const curProviderId = reg?.getActiveProvider?.()?.id;
                        if (curProviderId !== _lastModeToggleProviderId) {
                            mtBrowseSortSelect.innerHTML = realBrowseSort.innerHTML;
                            _lastModeToggleProviderId = curProviderId;
                        }
                        mtBrowseSortSelect.value = realBrowseSort.value;
                    }

                    const realTimelineSort = ids?.timelineSort ? document.getElementById(ids.timelineSort) : null;
                    if (realTimelineSort) {
                        const curProviderId = reg?.getActiveProvider?.()?.id;
                        if (mtFollowSortSelect.options.length === 0 || mtFollowSortSelect.dataset.providerId !== curProviderId) {
                            mtFollowSortSelect.innerHTML = '';
                            Array.from(realTimelineSort.options).forEach(opt => {
                                const o = document.createElement('option');
                                o.value = opt.value;
                                o.textContent = opt.textContent;
                                mtFollowSortSelect.appendChild(o);
                            });
                            mtFollowSortSelect.dataset.providerId = curProviderId;
                        }
                        mtFollowSortSelect.value = realTimelineSort.value;
                    }

                    syncMode();
                    syncMtNsfwState();
                    syncSort();
                }
            } else if (activeView === 'chats') {
                syncGrouping();
                if (realChatsSort) chatsSortSelect.value = realChatsSort.value;
            } else {
                if (realSort) sortSelect.value = realSort.value;
            }

            openSheet(overlay, sheet);
        });

        document.body.appendChild(overlay);
    }

    function getActiveView() {
        const onlineView = document.getElementById('onlineView');
        const chatsView = document.getElementById('chatsView');
        if (onlineView && !onlineView.classList.contains('hidden')) return 'online';
        if (chatsView && !chatsView.classList.contains('hidden')) return 'chats';
        return 'characters';
    }

    function createChip(html) {
        const chip = document.createElement('button');
        chip.className = 'mobile-filter-chip';
        chip.innerHTML = html;
        return chip;
    }

    /* ========================================
       MENU BOTTOM SHEET
       ======================================== */
    function createMenuButton(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileMenuBtn';
        btn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        btn.title = 'More';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        topbar.appendChild(btn);

        const { overlay, sheet, close } = createBottomSheet();

        const handle = document.createElement('div');
        handle.className = 'mobile-sheet-handle';
        sheet.appendChild(handle);

        // Clone items from the desktop menu
        const moreOptionsMenu = document.getElementById('moreOptionsMenu');
        if (moreOptionsMenu) {
            const items = moreOptionsMenu.querySelectorAll('.dropdown-item');
            items.forEach(item => {
                // Skip desktop-only responsive overflow items — they belong to the
                // progressive topbar collapse and have their own mobile equivalents
                if (item.classList.contains('topbar-overflow-item') ||
                    item.classList.contains('topbar-overflow-item-narrow')) return;

                const mobileItem = document.createElement('button');
                mobileItem.className = 'mobile-sheet-item';

                const icon = item.querySelector('i');
                if (icon) {
                    const iconClone = icon.cloneNode(true);
                    mobileItem.appendChild(iconClone);
                }

                const text = item.textContent.trim();
                mobileItem.appendChild(document.createTextNode(text));

                // Click the real button
                mobileItem.addEventListener('click', () => {
                    item.click();
                    close();
                });

                sheet.appendChild(mobileItem);
            });
        }

        // Gallery sync status — directly toggle dropdown (the real button is in a hidden container)
        const syncDropdown = document.getElementById('gallerySyncDropdown');
        if (syncDropdown) {
            const syncItem = document.createElement('button');
            syncItem.className = 'mobile-sheet-item';
            syncItem.innerHTML = '<i class="fa-solid fa-circle-info"></i> Gallery Sync Status';
            syncItem.addEventListener('click', () => {
                close();
                // Small delay so the sheet closes first
                setTimeout(() => openGallerySyncDropdown(syncDropdown), 350);
            });
            syncItem.dataset.gallerySyncItem = 'true';
            if (!window.getSetting?.('uniqueGalleryFolders')) syncItem.style.display = 'none';
            sheet.appendChild(syncItem);
        }

        // Provider switcher button (shown only when online view is active)
        const providerSwitchItem = document.createElement('button');
        providerSwitchItem.className = 'mobile-sheet-item';
        providerSwitchItem.style.display = 'none';
        providerSwitchItem.innerHTML = '<i class="fa-solid fa-shuffle"></i> Switch Provider <i class="fa-solid fa-chevron-right" style="margin-left:auto;font-size:0.7rem;opacity:0.5;"></i>';
        sheet.appendChild(providerSwitchItem);

        // Sub-drawer for provider selection
        const { overlay: provSubOverlay, sheet: provSubSheet, close: closeProvSub } = createBottomSheet();

        providerSwitchItem.addEventListener('click', () => {
            if (!window.ProviderRegistry) return;
            const providers = window.ProviderRegistry.getViewProviders();
            const activeId = window.ProviderRegistry.getActiveProviderId();
            provSubSheet.innerHTML = '';

            const subTitle = document.createElement('div');
            subTitle.style.cssText = 'font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; padding: 16px 20px 8px;';
            subTitle.textContent = 'Switch Provider';
            provSubSheet.appendChild(subTitle);

            providers.forEach(p => {
                const item = document.createElement('button');
                item.className = 'mobile-sheet-item';
                if (p.id === activeId) item.style.color = 'var(--accent)';
                const check = p.id === activeId ? ' <i class="fa-solid fa-check" style="margin-left:auto;font-size:0.8rem;"></i>' : '';
                item.innerHTML = '<i class="' + p.icon + '"></i> ' + p.name + check;
                item.addEventListener('click', () => {
                    if (p.id !== activeId) {
                        const select = document.getElementById('providerSelect');
                        if (select) {
                            select.value = p.id;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    closeProvSub();
                });
                provSubSheet.appendChild(item);
            });

            // Close the main menu before opening the sub-drawer
            close();
            // Small delay so the main sheet animates out first
            setTimeout(() => openSheet(provSubOverlay, provSubSheet), 180);
        });

        document.body.appendChild(provSubOverlay);

        btn.addEventListener('click', () => {
            const isOnline = getActiveView() === 'online';
            providerSwitchItem.style.display = isOnline ? '' : 'none';

            openSheet(overlay, sheet);
        });
        document.body.appendChild(overlay);
    }

    /* ========================================
       BOTTOM SHEET HELPERS
       ======================================== */
    function createBottomSheet() {
        const overlay = document.createElement('div');
        overlay.className = 'mobile-sheet-overlay hidden';

        const backdrop = document.createElement('div');
        backdrop.className = 'mobile-sheet-backdrop';

        const sheet = document.createElement('div');
        sheet.className = 'mobile-sheet';

        overlay.appendChild(backdrop);
        overlay.appendChild(sheet);

        function close() {
            sheet.classList.remove('open');
            setTimeout(() => overlay.classList.add('hidden'), 300);
        }

        backdrop.addEventListener('click', close);

        return { overlay, sheet, close };
    }

    function openSheet(overlay, sheet) {
        overlay.classList.remove('hidden');
        // Force reflow then animate
        sheet.offsetHeight; // eslint-disable-line no-unused-expressions
        requestAnimationFrame(() => sheet.classList.add('open'));
    }

    function createSection(label) {
        const section = document.createElement('div');
        section.className = 'mobile-settings-section';
        if (label) {
            const lbl = document.createElement('div');
            lbl.className = 'mobile-settings-label';
            lbl.textContent = label;
            section.appendChild(lbl);
        }
        return section;
    }

    /* ========================================
       MODAL HEADER COLLAPSE ON SCROLL
       ======================================== */
    function setupModalHeaderCollapse() {
        const wired = new WeakSet();

        function wireOverlay(overlay, glass, getScrollBody, resetSelector) {
            if (wired.has(overlay)) return;
            wired.add(overlay);

            let lastScrollY = 0;
            let attached = false;
            let scrollBody = null;
            let snapEnabled = false;
            let collapsedAt = 0;

            function handleScroll() {
                if (!scrollBody) return;
                const y = scrollBody.scrollTop;
                const isBrowse = glass.classList.contains('browse-char-modal');
                if (!snapEnabled && isBrowse && y > 5 && window.getSetting?.('browseSnapSections') !== false) {
                    snapEnabled = true;
                    scrollBody.classList.add('snap-active');
                }
                const isCollapsed = glass.classList.contains('header-collapsed');
                const topZone = isCollapsed ? 2 : (isBrowse ? 3 : 10);
                if (y <= topZone) {
                    glass.classList.remove('header-collapsed');
                } else if (y > lastScrollY + 2) {
                    if (!isCollapsed) collapsedAt = Date.now();
                    glass.classList.add('header-collapsed');
                } else if (y < lastScrollY - 4 && Date.now() - collapsedAt > 300) {
                    glass.classList.remove('header-collapsed');
                }
                lastScrollY = y;
            }

            function attach() {
                if (attached) return;
                scrollBody = getScrollBody();
                if (!scrollBody) return;
                lastScrollY = scrollBody.scrollTop;
                scrollBody.addEventListener('scroll', handleScroll, { passive: true });
                attached = true;
            }

            function detach() {
                if (!attached) return;
                if (scrollBody) {
                    scrollBody.removeEventListener('scroll', handleScroll);
                    scrollBody.classList.remove('snap-active');
                }
                glass.classList.remove('header-collapsed');
                snapEnabled = false;
                lastScrollY = 0;
                attached = false;
                scrollBody = null;
            }

            if (resetSelector) {
                overlay.addEventListener('click', (e) => {
                    if (e.target.closest(resetSelector)) {
                        setTimeout(() => {
                            glass.classList.remove('header-collapsed');
                            if (scrollBody) scrollBody.scrollTop = 0;
                            lastScrollY = 0;
                        }, 20);
                    }
                });
            }

            new MutationObserver(() => {
                const isOpen = !overlay.classList.contains('hidden');
                if (isOpen) attach();
                else detach();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }

        // charModal (local character details)
        const charModal = document.getElementById('charModal');
        if (charModal) {
            const glass = charModal.querySelector('.modal-glass');
            if (glass) wireOverlay(charModal, glass, () => charModal.querySelector('.modal-body'), '.tab-btn');
        }

        // Browse preview modals (injected lazily by providers)
        function scanBrowseModals() {
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                const glass = overlay.querySelector('.browse-char-modal');
                if (glass) wireOverlay(overlay, glass, () => glass.querySelector('.browse-char-body'));
            });
        }
        scanBrowseModals();
        new MutationObserver(scanBrowseModals).observe(document.body, { childList: true });
    }

    /* ========================================
       MODAL AVATAR IN HEADER
       ======================================== */
    function setupModalAvatar() {
        // Watch for the character modal becoming visible and inject avatar into header
        const modal = document.getElementById('charModal');
        if (!modal) return;

        const observer = new MutationObserver(() => {
            if (modal.classList.contains('hidden')) return;

            const header = modal.querySelector('.modal-header');
            const modalImg = document.getElementById('modalImage');
            if (!header || !modalImg) return;

            const existing = header.querySelector('.mobile-header-avatar');
            if (existing) {
                // Always update to current character's avatar
                existing.src = modalImg.src;
                return;
            }

            const avatar = document.createElement('img');
            avatar.className = 'mobile-header-avatar';
            avatar.src = modalImg.src;
            avatar.alt = 'Avatar';
            avatar.addEventListener('click', (e) => {
                e.stopPropagation();
                openAvatarViewer(avatar.src);
            });
            // Insert before the title h2
            header.insertBefore(avatar, header.firstChild);
        });

        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

        // Browse-view avatar tap → full-size image viewer (delegated because
        // modal elements are injected lazily when the Online tab first activates)
        document.addEventListener('click', (e) => {
            const target = e.target.closest('.browse-char-avatar');
            if (!target || !target.src) return;

            if (target.id === 'chubCharAvatar') {
                e.stopPropagation();
                const fullSrc = target.src.replace(/\/avatar\.webp$/, '/chara_card_v2.png');
                openAvatarViewer(fullSrc, target.src);
            } else if (target.id === 'jannyCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                openAvatarViewer(target.src);
            } else if (target.id === 'ctCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                const fullSrc = target.src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
                openAvatarViewer(fullSrc, target.src);
            } else if (target.id === 'pygCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                openAvatarViewer(target.src);
            } else if (target.id === 'wyvernCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                openAvatarViewer(target.src);
            }
        });
    }

    /* ========================================
       AVATAR QUICK-VIEW OVERLAY
       ======================================== */
    function openAvatarViewer(src, fallbackSrc) {
        if (!src) return;
        const existing = document.querySelector('.mobile-avatar-viewer');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'mobile-avatar-viewer';

        const img = document.createElement('img');
        img.alt = 'Avatar';
        if (fallbackSrc) {
            img.onerror = () => { img.onerror = null; img.src = fallbackSrc; };
        }
        img.src = src;

        overlay.appendChild(img);
        overlay.addEventListener('click', () => closeAvatarViewer());
        document.body.appendChild(overlay);
        // Guard is pushed automatically by childObserver detecting the added element
    }

    function closeAvatarViewer() {
        const viewer = document.querySelector('.mobile-avatar-viewer');
        if (viewer) viewer.remove();
    }

    /* ========================================
       CHARACTER DETAILS TAB SWIPE
       ======================================== */
    function setupTabSwipe() {
        const modal = document.getElementById('charModal');
        if (!modal) return;

        const tabContainer = modal.querySelector('.modal-content-tabs');
        if (!tabContainer) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        function getVisibleTabs() {
            return [...modal.querySelectorAll('.tab-btn')].filter(b => !b.classList.contains('hidden'));
        }

        function isInteractiveTarget(el) {
            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                // Allow swipe over locked/readonly fields
                if (el.readOnly || el.disabled || el.classList.contains('locked')) return false;
                return true;
            }
            return false;
        }

        tabContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (isInteractiveTarget(e.target)) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        tabContainer.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        tabContainer.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;

            const tabs = getVisibleTabs();
            const activeIdx = tabs.findIndex(b => b.classList.contains('active'));
            if (activeIdx === -1) return;

            const nextIdx = dx < 0 ? activeIdx + 1 : activeIdx - 1;
            if (nextIdx >= 0 && nextIdx < tabs.length) {
                tabs[nextIdx].click();

                // Slide-in animation on the newly active pane
                const paneId = 'pane-' + tabs[nextIdx].dataset.tab;
                const pane = document.getElementById(paneId);
                if (pane) {
                    const cls = dx < 0 ? 'slide-from-right' : 'slide-from-left';
                    pane.classList.remove('slide-from-right', 'slide-from-left');
                    void pane.offsetWidth;
                    pane.classList.add(cls);
                    pane.addEventListener('animationend', () => pane.classList.remove(cls), { once: true });
                }
            }
        }, { passive: true });
    }

    /* ========================================
       ALT GREETINGS SWIPE NAVIGATION
       ======================================== */
    function setupGreetingsSwipe() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.id === 'altGreetingsFullscreenModal') {
                        attachGreetingsSwipe(node);
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
    }

    function attachGreetingsSwipe(modal) {
        const body = modal.querySelector('.content-fullscreen-body');
        if (!body) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        body.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        body.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        body.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;

            const nav = modal.querySelector('#greetingNav');
            if (!nav) return;
            const btns = [...nav.querySelectorAll('.greeting-nav-btn')];
            const activeIdx = btns.findIndex(b => b.classList.contains('active'));
            const nextIdx = dx < 0 ? activeIdx + 1 : activeIdx - 1;
            if (nextIdx >= 0 && nextIdx < btns.length) {
                btns[nextIdx].click();
            }
        }, { passive: true });
    }

    /* ========================================
       GALLERY SWIPE NAVIGATION
       ======================================== */
    function setupGallerySwipe() {
        // Wait for the gallery viewer to be injected into the DOM
        const observer = new MutationObserver(() => {
            const content = document.getElementById('galleryViewerContent');
            if (content && !content.dataset.swipeInit) {
                content.dataset.swipeInit = 'true';
                attachSwipeHandlers(content);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function attachSwipeHandlers(container) {
        let startX = 0, startY = 0, currentX = 0;
        let tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 40, LOCK_THRESHOLD = 8;

        // Double-tap state
        let lastTapTime = 0;
        let lastTapX = 0, lastTapY = 0;
        const DOUBLE_TAP_DELAY = 300;
        const DOUBLE_TAP_DIST = 40;

        // Pan state (when zoomed)
        let panX = 0, panY = 0, panStartX = 0, panStartY = 0;
        let imgPanStartX = 0, imgPanStartY = 0;
        let isPanning = false;

        // Track whether a meaningful gesture occurred (to distinguish tap from drag)
        let gestureOccurred = false;

        // Block desktop click-to-navigate on the image (left/right half tap).
        // The desktop gallery-viewer.js adds a click handler on #galleryViewerImage
        // that navigates prev/next — we must suppress it so pinch/double-tap work.
        const viewerImg = document.getElementById('galleryViewerImage');
        if (viewerImg) {
            viewerImg.addEventListener('click', (e) => {
                e.stopImmediatePropagation();
                e.preventDefault();
            }, true);
        }
        // Also suppress clicks on the content area that would close the viewer
        // when the user is just finishing a touch gesture
        let recentTouch = false;
        container.addEventListener('click', (e) => {
            if (recentTouch) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        }, true);

        const getImageEl = () => container.querySelector('.gv-image, .gv-video');

        function getZoom() {
            const img = getImageEl();
            if (!img) return 1;
            const m = img.style.transform.match(/scale\(([\d.]+)\)/);
            return m ? parseFloat(m[1]) : 1;
        }

        function setTransform(img, scale, tx, ty) {
            const s = Math.round(scale * 100) / 100;
            img.style.transform = `scale(${s}) translate(${tx}px, ${ty}px)`;
            panX = tx;
            panY = ty;
        }

        function resetTransform(img) {
            img.style.transition = 'transform 0.25s ease-out';
            setTransform(img, 1, 0, 0);
            setTimeout(() => { img.style.transition = ''; }, 260);
        }

        function showZoom(scale) {
            const ind = document.getElementById('galleryViewerZoomIndicator');
            if (ind) {
                ind.textContent = Math.round(scale * 100) + '%';
                ind.classList.add('visible');
                clearTimeout(ind._hideTimer);
                ind._hideTimer = setTimeout(() => ind.classList.remove('visible'), 1000);
            }
        }

        container.addEventListener('touchstart', (e) => {
            recentTouch = true;
            const img = getImageEl();
            if (!img) return;
            img.style.transition = '';

            if (e.touches.length !== 1) return;

            gestureOccurred = false; // reset — will be set true if finger moves

            const tapX = e.touches[0].clientX;
            const tapY = e.touches[0].clientY;

            const curZoom = getZoom();
            if (curZoom > 1.05) {
                // Start panning
                isPanning = true;
                panStartX = tapX;
                panStartY = tapY;
                imgPanStartX = panX;
                imgPanStartY = panY;
            } else {
                // Double-tap detection (only at 1x zoom)
                const now = Date.now();
                const dt = now - lastTapTime;
                const dd = Math.sqrt((tapX - lastTapX) ** 2 + (tapY - lastTapY) ** 2);

                if (dt < DOUBLE_TAP_DELAY && dd < DOUBLE_TAP_DIST) {
                    e.preventDefault();
                    lastTapTime = 0;
                    gestureOccurred = true;
                    img.style.transition = 'transform 0.25s ease-out';
                    setTransform(img, 2.5, 0, 0);
                    showZoom(2.5);
                    setTimeout(() => { img.style.transition = ''; }, 260);
                    return;
                }
                lastTapTime = now;
                lastTapX = tapX;
                lastTapY = tapY;

                // Start swipe tracking
                startX = tapX;
                startY = tapY;
                currentX = 0;
                tracking = true;
                swiping = false;
            }
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
            const img = getImageEl();
            if (!img) return;

            // Pan when zoomed
            if (isPanning) {
                const moveThreshold = 5;
                const dx = e.touches[0].clientX - panStartX;
                const dy = e.touches[0].clientY - panStartY;
                if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
                    gestureOccurred = true;
                }
                e.preventDefault();
                const curZoom = getZoom();
                setTransform(img, curZoom, imgPanStartX + dx / Math.sqrt(curZoom), imgPanStartY + dy / Math.sqrt(curZoom));
                return;
            }

            // Swipe
            if (!tracking) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            const absDx = Math.abs(dx), absDy = Math.abs(dy);

            if (!swiping && absDx < LOCK_THRESHOLD && absDy < LOCK_THRESHOLD) return;
            if (!swiping) {
                swiping = absDx > absDy;
                if (!swiping) { tracking = false; return; }
            }
            e.preventDefault();
            currentX = dx;

            const resistance = Math.abs(dx) > 120 ? 0.3 : 1;
            const offset = dx * resistance;
            const opacity = 1 - Math.min(Math.abs(offset) / 300, 0.4);
            img.style.transform = `translateX(${offset}px)`;
            img.style.opacity = opacity;
        }, { passive: false });

        container.addEventListener('touchend', (e) => {
            const img = getImageEl();

            // Pan end — single tap while zoomed resets to 1x
            if (isPanning) {
                isPanning = false;
                if (!gestureOccurred && img && getZoom() > 1.05) {
                    // Single tap while zoomed → reset
                    resetTransform(img);
                    showZoom(1);
                }
                return;
            }

            if (!tracking) return;
            tracking = false;

            const prevBtn = document.getElementById('galleryViewerPrev');
            const nextBtn = document.getElementById('galleryViewerNext');

            if (swiping && Math.abs(currentX) >= SWIPE_THRESHOLD) {
                if (img) {
                    const dir = currentX < 0 ? -1 : 1;
                    img.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                    img.style.transform = `translateX(${dir * window.innerWidth}px)`;
                    img.style.opacity = '0';
                }
                setTimeout(() => {
                    recentTouch = false; // Allow programmatic click through
                    if (currentX < 0 && nextBtn) nextBtn.click();
                    else if (currentX > 0 && prevBtn) prevBtn.click();
                    if (img) { img.style.transition = 'none'; img.style.transform = ''; img.style.opacity = ''; }
                    requestAnimationFrame(() => {
                        const newImg = getImageEl();
                        if (newImg) {
                            newImg.style.transition = 'none';
                            const fromDir = currentX < 0 ? 1 : -1;
                            newImg.style.transform = `translateX(${fromDir * 60}px)`;
                            newImg.style.opacity = '0.5';
                            requestAnimationFrame(() => {
                                newImg.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                                newImg.style.transform = 'translateX(0)';
                                newImg.style.opacity = '1';
                            });
                        }
                    });
                }, 180);
            } else {
                if (img) {
                    img.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                    img.style.transform = 'translateX(0)';
                    img.style.opacity = '1';
                }
            }
            swiping = false;
            // Clear recentTouch after the browser fires its synthetic click
            setTimeout(() => { recentTouch = false; }, 400);
        }, { passive: true });
    }

    /* ========================================
       BROWSE GALLERY SWIPE NAVIGATION
       Swipe left/right on browse-avatar-viewer to navigate gallery images
       ======================================== */
    function setupBrowseGallerySwipe() {
        const observer = new MutationObserver(() => {
            const viewer = document.querySelector('.browse-avatar-viewer.has-gallery');
            if (viewer && !viewer.dataset.swipeInit) {
                viewer.dataset.swipeInit = 'true';
                attachBrowseGallerySwipe(viewer);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function attachBrowseGallerySwipe(overlay) {
        let startX = 0, startY = 0, currentX = 0;
        let tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 40, LOCK_THRESHOLD = 8;

        const getImg = () => overlay.querySelector('.browse-av-image');
        const getPrev = () => overlay.querySelector('.browse-av-prev');
        const getNext = () => overlay.querySelector('.browse-av-next');

        overlay.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentX = 0;
            tracking = true;
            swiping = false;
            const img = getImg();
            if (img) img.style.transition = '';
        }, { passive: true });

        overlay.addEventListener('touchmove', (e) => {
            if (!tracking) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            const absDx = Math.abs(dx), absDy = Math.abs(dy);

            if (!swiping && absDx < LOCK_THRESHOLD && absDy < LOCK_THRESHOLD) return;
            if (!swiping) {
                swiping = absDx > absDy;
                if (!swiping) { tracking = false; return; }
            }
            e.preventDefault();
            currentX = dx;

            const img = getImg();
            if (img) {
                const offset = dx;
                const opacity = 1 - Math.min(Math.abs(offset) / 300, 0.4);
                img.style.transform = `translateX(${offset}px)`;
                img.style.opacity = opacity;
            }
        }, { passive: false });

        overlay.addEventListener('touchend', () => {
            if (!tracking) return;
            tracking = false;
            const img = getImg();

            if (swiping && Math.abs(currentX) >= SWIPE_THRESHOLD) {
                const goNext = currentX < 0;
                const goPrev = currentX > 0;

                if (img) {
                    const dir = currentX < 0 ? -1 : 1;
                    img.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                    img.style.transform = `translateX(${dir * window.innerWidth}px)`;
                    img.style.opacity = '0';
                }
                setTimeout(() => {
                    const btn = goNext ? getNext() : getPrev();
                    if (btn) btn.click();
                    if (img) { img.style.transition = 'none'; img.style.transform = ''; img.style.opacity = ''; }
                    requestAnimationFrame(() => {
                        const newImg = getImg();
                        if (newImg) {
                            newImg.style.transition = 'none';
                            const fromDir = currentX < 0 ? 1 : -1;
                            newImg.style.transform = `translateX(${fromDir * 60}px)`;
                            newImg.style.opacity = '0.5';
                            requestAnimationFrame(() => {
                                newImg.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                                newImg.style.transform = 'translateX(0)';
                                newImg.style.opacity = '1';
                            });
                        }
                    });
                }, 180);
            } else {
                // Below threshold, snap back
                if (img) {
                    img.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                    img.style.transform = 'translateX(0)';
                    img.style.opacity = '1';
                }
            }
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       VIEW SWIPE NAVIGATION
       Swipe left/right on main content to switch
       between Characters ↔ Chats ↔ Online views
       ======================================== */
    function setupViewSwipe() {
        const surface = document.querySelector('.gallery-content');
        if (!surface) return;

        const VIEW_ORDER = ['characters', 'chats', 'online'];
        const SWIPE_THRESHOLD = 45;
        const VELOCITY_THRESHOLD = 0.4;
        const VELOCITY_MIN_DX = 25;
        const MAX_VERTICAL = 60;
        const DRAG_FACTOR = 0.12;
        const DRAG_OPACITY_MIN = 0.85;
        let startX = 0, startY = 0, startScroll = 0, startTime = 0;
        let active = false, dragging = false, locked = false, transitioning = false;

        function hasBlockingUI() {
            return !!(
                document.querySelector('.modal-overlay:not(.hidden)') ||
                document.querySelector('.cl-modal.visible') ||
                document.querySelector('.confirm-modal:not(.hidden)') ||
                document.querySelector('.mobile-ctx-sheet.visible') ||
                document.querySelector('.mobile-avatar-viewer') ||
                document.querySelector('.browse-avatar-viewer') ||
                document.querySelector('.mobile-search-overlay:not(.hidden)') ||
                document.querySelector('.mobile-sheet-overlay:not(.hidden)') ||
                document.querySelector('.tag-editor-sheet:not(.hidden)') ||
                document.querySelector('#tagFilterPopup:not(.hidden)') ||
                document.querySelector('.custom-select-menu:not(.hidden)') ||
                document.querySelector('#galleryViewerModal.visible') ||
                document.querySelector('#moreOptionsMenu:not(.hidden)') ||
                document.querySelector('#settingsMenu:not(.hidden)') ||
                document.querySelector('body > .dropdown-menu[data-mobile-relocated]:not(.hidden)') ||
                document.querySelector('body > .browse-tags-dropdown[data-mobile-relocated]:not(.hidden)') ||
                window.MultiSelect?.enabled
            );
        }

        function canSwipeDirection(dx) {
            const current = window.getCurrentView?.() || 'characters';
            const idx = VIEW_ORDER.indexOf(current);
            if (idx === -1) return false;
            return dx < 0 ? idx < VIEW_ORDER.length - 1 : idx > 0;
        }

        function clearDrag() {
            surface.style.transform = '';
            surface.style.opacity = '';
            surface.style.willChange = '';
            dragging = false;
        }

        surface.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { active = false; return; }
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startScroll = surface.scrollTop;
            startTime = Date.now();
            active = !transitioning;
            dragging = false;
            locked = false;
        }, { passive: true });

        surface.addEventListener('touchmove', (e) => {
            if (!active || locked || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);

            if (!dragging && absDx < 10 && absDy < 10) return;

            // Lock to vertical if scroll-dominant
            if (!dragging && absDy > absDx) { locked = true; return; }

            if (!canSwipeDirection(dx)) { clearDrag(); return; }

            dragging = true;
            if (!surface.style.willChange) surface.style.willChange = 'transform, opacity';
            const shift = dx * DRAG_FACTOR;
            const opacity = Math.max(DRAG_OPACITY_MIN, 1 - (absDx * 0.0008));
            surface.style.transform = `translateX(${shift}px)`;
            surface.style.opacity = opacity;
        }, { passive: true });

        surface.addEventListener('touchend', (e) => {
            if (!active) return;
            active = false;

            const dx = (e.changedTouches[0]?.clientX ?? 0) - startX;
            const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
            const scrollDelta = Math.abs(surface.scrollTop - startScroll);
            const elapsed = Math.max(Date.now() - startTime, 1);
            const velocity = Math.abs(dx) / elapsed;

            // Snap back if not a valid swipe
            const absDx = Math.abs(dx);
            const isSwipe = absDx >= SWIPE_THRESHOLD || (velocity >= VELOCITY_THRESHOLD && absDx >= VELOCITY_MIN_DX);
            if (!isSwipe || Math.abs(dy) > MAX_VERTICAL || scrollDelta > 10 || hasBlockingUI()) {
                if (dragging) {
                    surface.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                    clearDrag();
                    surface.addEventListener('transitionend', () => { surface.style.transition = ''; }, { once: true });
                }
                return;
            }

            const current = window.getCurrentView?.() || 'characters';
            const idx = VIEW_ORDER.indexOf(current);
            if (idx === -1) { clearDrag(); return; }

            const nextIdx = dx < 0 ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= VIEW_ORDER.length) { clearDrag(); return; }

            // Transition: set start offset, switch view, then transition to neutral
            transitioning = true;
            const startShift = dx < 0 ? '5%' : '-5%';
            surface.style.willChange = 'transform, opacity';
            surface.style.transition = 'none';
            window.switchView(VIEW_ORDER[nextIdx]);
            surface.style.transform = `translateX(${startShift})`;
            surface.style.opacity = '0.86';
            void surface.offsetWidth;
            surface.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
            surface.style.transform = 'translateX(0)';
            surface.style.opacity = '1';
            surface.addEventListener('transitionend', () => {
                surface.style.transition = '';
                clearDrag();
                transitioning = false;
            }, { once: true });
        }, { passive: true });
    }

    /* ========================================
       RELOCATE TAG POPUP
       Move #tagFilterPopup out of hidden .filter-area
       and add a scrim + close mechanism
       ======================================== */
    function relocateTagPopup() {
        const popup = document.getElementById('tagFilterPopup');
        if (!popup || popup.dataset.relocated) return;
        popup.dataset.relocated = 'true';

        // Move out of hidden .filter-area
        if (popup.closest('.filter-area')) {
            document.body.appendChild(popup);
        }

        // Create scrim (backdrop)
        const scrim = document.createElement('div');
        scrim.className = 'mobile-tag-scrim';
        scrim.style.display = 'none';
        document.body.appendChild(scrim);

        // Add a handle/close bar at top of popup
        const handle = document.createElement('div');
        handle.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:10px;cursor:pointer;';
        const bar = document.createElement('div');
        bar.style.cssText = 'width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,0.3);';
        handle.appendChild(bar);
        popup.insertBefore(handle, popup.firstChild);

        function closeTagPopup() {
            popup.classList.add('hidden');
            scrim.style.display = 'none';
        }

        // Tap scrim to close
        scrim.addEventListener('click', closeTagPopup);
        // Tap handle to close
        handle.addEventListener('click', closeTagPopup);

        // Watch for popup visibility changes to sync scrim
        const obs = new MutationObserver(() => {
            scrim.style.display = popup.classList.contains('hidden') ? 'none' : 'block';
        });
        obs.observe(popup, { attributes: true, attributeFilter: ['class'] });
    }

    /* ========================================
       RELOCATE PLAYLIST POPUP
       Same pattern as tag popup — move to body,
       add scrim + handle
       ======================================== */
    function relocatePlaylistPopup() {
        const popup = document.getElementById('playlistFilterPopup');
        if (!popup || popup.dataset.relocated) return;
        popup.dataset.relocated = 'true';

        if (popup.closest('.filter-area')) {
            document.body.appendChild(popup);
        }

        const scrim = document.createElement('div');
        scrim.className = 'mobile-playlist-scrim';
        scrim.style.display = 'none';
        document.body.appendChild(scrim);

        const handle = document.createElement('div');
        handle.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:10px;cursor:pointer;';
        const bar = document.createElement('div');
        bar.style.cssText = 'width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,0.3);';
        handle.appendChild(bar);
        popup.insertBefore(handle, popup.firstChild);

        function closePlaylistPopup() {
            popup.classList.add('hidden');
            scrim.style.display = 'none';
        }

        scrim.addEventListener('click', closePlaylistPopup);
        handle.addEventListener('click', closePlaylistPopup);

        const obs = new MutationObserver(() => {
            scrim.style.display = popup.classList.contains('hidden') ? 'none' : 'block';
        });
        obs.observe(popup, { attributes: true, attributeFilter: ['class'] });
    }

    /* ========================================
       MULTI-SELECT CONFIRM SHEETS
       ======================================== */
    function setupMultiSelectConfirm() {
        const btnConfigs = {
            multiSelectFavToggleBtn: {
                getTitle: () => {
                    const selected = window.MultiSelect?.getSelected?.() || [];
                    const allFav = selected.length > 0 && selected.every(c =>
                        c.fav === true || c.fav === 'true' ||
                        c.data?.extensions?.fav === true || c.data?.extensions?.fav === 'true'
                    );
                    return allFav ? 'Remove from Favorites' : 'Add to Favorites';
                },
                getDesc: () => {
                    const count = window.MultiSelect?.selectedCharacters?.size || 0;
                    return `${count} character${count !== 1 ? 's' : ''} will be updated`;
                },
                icon: 'fa-solid fa-star',
                confirmLabel: 'Confirm'
            },
            multiSelectExportBtn: {
                getTitle: () => 'Export Characters',
                getDesc: () => {
                    const count = window.MultiSelect?.selectedCharacters?.size || 0;
                    return `Download ${count} character${count !== 1 ? 's' : ''} as PNG files`;
                },
                icon: 'fa-solid fa-download',
                confirmLabel: 'Export'
            },
            multiSelectCheckUpdatesBtn: {
                getTitle: () => 'Check for Updates',
                getDesc: () => {
                    const count = window.MultiSelect?.selectedCharacters?.size || 0;
                    return `Check ${count} character${count !== 1 ? 's' : ''} for provider updates`;
                },
                icon: 'fa-solid fa-arrows-rotate',
                confirmLabel: 'Check'
            },
            multiSelectAllBtn: {
                getTitle: () => 'Select All',
                getDesc: () => {
                    const total = window.currentCharacters?.length || 0;
                    return `Select all ${total} filtered character${total !== 1 ? 's' : ''}`;
                },
                icon: 'fa-solid fa-check-double',
                confirmLabel: 'Select All'
            },
            multiSelectBatchTagBtn: {
                getTitle: () => 'Batch Tagging',
                getDesc: () => {
                    const count = window.MultiSelect?.selectedCharacters?.size || 0;
                    return `Edit tags on ${count} selected character${count !== 1 ? 's' : ''}`;
                },
                icon: 'fa-solid fa-tags',
                confirmLabel: 'Open'
            }
        };

        let confirmed = false;

        document.addEventListener('click', (e) => {
            const btn = e.target.closest('#multiSelectFavToggleBtn, #multiSelectExportBtn, #multiSelectCheckUpdatesBtn, #multiSelectAllBtn, #multiSelectBatchTagBtn');
            if (!btn) return;
            const cfg = btnConfigs[btn.id];
            if (!cfg) return;
            if (confirmed) { confirmed = false; return; }
            e.stopImmediatePropagation();
            e.preventDefault();
            showConfirmSheet(cfg, btn);
        }, true);

        function showConfirmSheet(cfg, originalBtn) {
            const { overlay, sheet, close } = createBottomSheet();

            const handle = document.createElement('div');
            handle.className = 'mobile-sheet-handle';
            sheet.appendChild(handle);

            const body = document.createElement('div');
            body.className = 'mobile-confirm-body';
            body.innerHTML = `
                <div class="mobile-confirm-icon"><i class="${cfg.icon}"></i></div>
                <div class="mobile-confirm-title">${cfg.getTitle()}</div>
                <div class="mobile-confirm-desc">${cfg.getDesc()}</div>
            `;
            sheet.appendChild(body);

            const actions = document.createElement('div');
            actions.className = 'mobile-confirm-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'mobile-confirm-cancel';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                close();
                setTimeout(() => overlay.remove(), 350);
            });

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'mobile-confirm-ok';
            confirmBtn.textContent = cfg.confirmLabel;
            confirmBtn.addEventListener('click', () => {
                close();
                setTimeout(() => {
                    overlay.remove();
                    confirmed = true;
                    originalBtn.click();
                }, 350);
            });

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            sheet.appendChild(actions);

            document.body.appendChild(overlay);
            openSheet(overlay, sheet);
        }
    }

    /* ========================================
       CONTEXT MENU → BOTTOM SHEET
       ======================================== */
    function setupContextMenu() {
        // Intercept the context-menu module's show logic.
        // Long-press on cards fires 'contextmenu' → module renders its popup.
        // We capture that, hide the popup, and present a bottom-sheet instead.

        let sheetEl = null, scrimEl = null;

        function buildSheet() {
            if (sheetEl) return;
            scrimEl = document.createElement('div');
            scrimEl.className = 'mobile-ctx-scrim';
            document.body.appendChild(scrimEl);

            sheetEl = document.createElement('div');
            sheetEl.className = 'mobile-ctx-sheet';
            document.body.appendChild(sheetEl);

            scrimEl.addEventListener('click', closeSheet);
        }

        function openSheet(menuEl) {
            buildSheet();
            // Clone items from desktop context menu into our sheet
            sheetEl.innerHTML = '';

            // Handle bar
            const handle = document.createElement('div');
            handle.className = 'mobile-ctx-handle';
            handle.innerHTML = '<div class="mobile-ctx-handle-bar"></div>';
            handle.addEventListener('click', closeSheet);
            sheetEl.appendChild(handle);

            // Copy every child from the desktop context menu
            const children = Array.from(menuEl.children);
            const clones = children.map(child => {
                const clone = child.cloneNode(true);
                if (child.classList.contains('cl-context-menu-item') && !child.classList.contains('disabled')) {
                    clone.addEventListener('click', () => {
                        closeSheet();
                        child.click();
                    });
                }
                clone._origChild = child;
                return clone;
            });

            // Move "Select for Batch" / "Deselect" to right after the header
            const selectIdx = clones.findIndex(c => c._origChild?.querySelector?.('.fa-square-check, .fa-square-minus'));
            if (selectIdx > 1) {
                const [selectClone] = clones.splice(selectIdx, 1);
                // Remove the separator that was before it if it's now orphaned
                if (selectIdx > 0 && clones[selectIdx - 1]?._origChild?.classList?.contains('cl-context-menu-separator')) {
                    clones.splice(selectIdx - 1, 1);
                }
                // Insert after header (index 0) with a separator after it
                const sep = document.createElement('div');
                sep.className = 'cl-context-menu-separator';
                clones.splice(1, 0, selectClone, sep);
            }

            clones.forEach(c => { delete c._origChild; sheetEl.appendChild(c); });

            scrimEl.classList.add('visible');
            sheetEl.classList.add('visible');
        }

        function closeSheet() {
            if (sheetEl) sheetEl.classList.remove('visible');
            if (scrimEl) scrimEl.classList.remove('visible');
        }

        // After the desktop context menu module renders and shows its popup,
        // we detect that via MutationObserver and hijack it.
        const waitForMenu = () => {
            const menuEl = document.getElementById('clContextMenu');
            if (!menuEl) {
                // Not created yet – keep watching
                const bodyObs = new MutationObserver(() => {
                    const m = document.getElementById('clContextMenu');
                    if (m) { bodyObs.disconnect(); attachObserver(m); }
                });
                bodyObs.observe(document.body, { childList: true });
            } else {
                attachObserver(menuEl);
            }
        };

        function attachObserver(menuEl) {
            const obs = new MutationObserver(() => {
                if (menuEl.classList.contains('visible')) {
                    // Desktop context menu just appeared – hijack it
                    menuEl.classList.remove('visible');
                    menuEl.style.display = 'none';
                    openSheet(menuEl);
                }
            });
            obs.observe(menuEl, { attributes: true, attributeFilter: ['class'] });
        }

        waitForMenu();
    }

    /* ========================================
       VIEWPORT FIX
       ======================================== */
    function setupViewportFix() {
        // Prevent horizontal scrolling
        document.documentElement.style.overflowX = 'hidden';
        document.body.style.overflowX = 'hidden';
        document.documentElement.style.maxWidth = '100vw';
        document.body.style.maxWidth = '100vw';

        // Set viewport meta for mobile
        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            document.head.appendChild(viewport);
        }
        viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    }

    /* ========================================
       FIX: CHAT DATES VIA DOM + LOCALSTORAGE CACHE
       SmartDate constructor may not stick on all mobile
       engines. This fixer reads raw last_mes strings from
       the localStorage chat cache, parses them with our
       manual regex parser (ZERO Date constructor reliance),
       and patches "Unknown" / "Invalid Date" text directly.
       ======================================== */
    function fixInvalidDateText() {
        const parseDate = window.__mobileDateParse;
        const fmtDate  = window.__mobileDateFormat;
        const CACHE_KEY = 'st_gallery_chats_cache';
        let dateMap = null;   // file_name → last_mes
        let cacheStamp = 0;   // track when cache was last read

        // Build a lookup from localStorage cache
        function refreshDateMap() {
            try {
                const raw = localStorage.getItem(CACHE_KEY);
                if (!raw) { dateMap = null; return; }
                const stamp = raw.length; // cheap change-detect
                if (dateMap && stamp === cacheStamp) return;
                const data = JSON.parse(raw);
                if (data && Array.isArray(data.chats)) {
                    const map = {};
                    for (let i = 0; i < data.chats.length; i++) {
                        const c = data.chats[i];
                        if (c.file_name && c.last_mes != null) {
                            map[c.file_name] = c.last_mes;
                        }
                    }
                    dateMap = map;
                    cacheStamp = stamp;
                }
            } catch (e) { dateMap = null; }
        }

        // Fix the date text inside a single chat card / group item
        function fixCardDate(card) {
            // Skip already-fixed cards
            if (card.dataset.dateFixed) return;

            const meta = card.querySelector('.chat-card-meta, .chat-group-item-meta');
            if (!meta) return;
            // Find the span containing the calendar icon
            const spans = meta.querySelectorAll('span');
            let dateSpan = null;
            for (let i = 0; i < spans.length; i++) {
                if (spans[i].querySelector('.fa-calendar')) {
                    dateSpan = spans[i];
                    break;
                }
            }
            if (!dateSpan) return;
            const text = dateSpan.textContent.trim();
            // Only fix broken dates
            if (text !== 'Unknown' && text.indexOf('Invalid Date') === -1) {
                card.dataset.dateFixed = '1'; // date is already valid
                return;
            }

            const fileName = card.dataset.chatFile;
            if (!fileName || !dateMap || !(fileName in dateMap)) return;

            const parsed = parseDate(dateMap[fileName]);
            if (!parsed) return;

            // Format using our manual formatter (no toLocaleDateString dependency)
            const formatted = fmtDate(parsed);
            if (!formatted) return;

            // Preserve the <i> icon, replace text
            const icon = dateSpan.querySelector('i');
            dateSpan.textContent = ' ' + formatted;
            if (icon) dateSpan.insertBefore(icon, dateSpan.firstChild);
            card.dataset.dateFixed = '1';
        }

        // Sweep all visible chat cards
        function sweep() {
            refreshDateMap();
            if (!dateMap) return;
            const cards = document.querySelectorAll(
                '.chat-card[data-chat-file]:not([data-date-fixed]), .chat-group-item[data-chat-file]:not([data-date-fixed])'
            );
            for (let i = 0; i < cards.length; i++) fixCardDate(cards[i]);
        }

        // Also replace raw "Invalid Date" text anywhere (safety net)
        function sweepInvalidText(root) {
            if (!root) return;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue && node.nodeValue.indexOf('Invalid Date') !== -1) {
                    node.nodeValue = node.nodeValue.replace(/Invalid Date/g, 'Unknown');
                }
            }
        }

        // MutationObserver for real-time catching
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        // Check if the node itself or children are chat cards
                        if (node.matches && node.matches('.chat-card[data-chat-file], .chat-group-item[data-chat-file]')) {
                            refreshDateMap();
                            fixCardDate(node);
                        } else if (node.querySelectorAll) {
                            const cards = node.querySelectorAll('.chat-card[data-chat-file], .chat-group-item[data-chat-file]');
                            if (cards.length) {
                                refreshDateMap();
                                cards.forEach(fixCardDate);
                            }
                        }
                        sweepInvalidText(node);
                    } else if (node.nodeType === 3 && node.nodeValue && node.nodeValue.indexOf('Invalid Date') !== -1) {
                        node.nodeValue = node.nodeValue.replace(/Invalid Date/g, 'Unknown');
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Aggressive sweep: fast for first 10s, then slow
        let sweepCount = 0;
        const fastSweep = setInterval(() => {
            sweep();
            if (++sweepCount >= 20) { // 20 × 500ms = 10s
                clearInterval(fastSweep);
                setInterval(sweep, 3000); // then every 3s
            }
        }, 500);
    }

    /* ========================================
       ONLINE FILTER AREA SETUP
       Move dropdowns out of scrollable filter strip
       and manage topbar wrapping class
       ======================================== */
    function setupChubFilterArea() {
        const topbar = document.querySelector('.topbar');
        const onlineFilters = document.getElementById('onlineFilterArea');
        const filterContent = document.getElementById('onlineFilterContent');
        if (!topbar || !onlineFilters || !filterContent) return;

        // Move fixed-position dropdowns to body so they aren't
        // clipped by the filter strip's overflow-x: auto.
        // Runs once initially and re-runs whenever the filter bar DOM is recreated
        // (provider switches destroy+rebuild the filter content).
        function relocateDropdowns() {
            // Remove any previously-relocated orphans from body
            document.querySelectorAll('body > .browse-tags-dropdown[data-mobile-relocated]').forEach(el => el.remove());
            document.querySelectorAll('body > .browse-features-dropdown[data-mobile-relocated]').forEach(el => el.remove());

            // Move all browse dropdown panels (tags, features) from filter bar to body
            const dropdowns = filterContent.querySelectorAll('.browse-tags-dropdown, .browse-features-dropdown');
            dropdowns.forEach(dd => {
                dd.setAttribute('data-mobile-relocated', '');
                document.body.appendChild(dd);
            });
        }

        relocateDropdowns();

        // Re-run whenever provider switch rebuilds the filter bar content
        new MutationObserver(() => relocateDropdowns())
            .observe(filterContent, { childList: true });

        // Toggle topbar wrapping when online filter area is visible
        function syncTopbar() {
            const visible = onlineFilters.style.display && onlineFilters.style.display !== 'none';
            topbar.classList.toggle('chub-active', visible);
        }

        new MutationObserver(syncTopbar).observe(onlineFilters, {
            attributes: true, attributeFilter: ['style']
        });
        syncTopbar();
    }

    /* ========================================
       GALLERY SYNC DROPDOWN
       The sync container is hidden on mobile (display:none).
       Move the dropdown to body and manage it with a scrim
       overlay so it displays as a bottom-sheet-style panel.
       ======================================== */
    function setupGallerySyncDropdown() {
        const dropdown = document.getElementById('gallerySyncDropdown');
        if (!dropdown) return;

        // Move dropdown to body so it escapes the hidden container
        document.body.appendChild(dropdown);

        // Create a scrim behind the dropdown for dismissal
        const scrim = document.createElement('div');
        scrim.className = 'mobile-sync-scrim';
        scrim.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1099;';
        document.body.appendChild(scrim);

        scrim.addEventListener('click', () => {
            dropdown.classList.add('hidden');
            scrim.style.display = 'none';
        });

        // Auto-hide scrim whenever dropdown gets hidden by any means
        // (gallery-sync.js close-on-outside-click, internal buttons, etc.)
        new MutationObserver(() => {
            if (dropdown.classList.contains('hidden')) {
                scrim.style.display = 'none';
            }
        }).observe(dropdown, { attributes: true, attributeFilter: ['class'] });

        // Store scrim reference
        dropdown._mobileScrim = scrim;
    }

    function openGallerySyncDropdown(dropdown) {
        if (!dropdown) return;

        // Show scrim
        if (dropdown._mobileScrim) dropdown._mobileScrim.style.display = 'block';

        // Show loading state
        const content = dropdown.querySelector('.sync-dropdown-content');
        if (content) {
            content.innerHTML = '<div class="sync-dropdown-loading"><i class="fa-solid fa-spinner fa-spin"></i> Checking...</div>';
        }
        dropdown.classList.remove('hidden');

        // Run audit using globally exposed functions (set by module-loader.js)
        setTimeout(async () => {
            try {
                if (typeof window.auditGalleryIntegrity === 'function') {
                    const audit = await window.auditGalleryIntegrity();
                    // updateGallerySyncWarning is updateWarningIndicator — updates dropdown content
                    if (typeof window.updateGallerySyncWarning === 'function') {
                        window.updateGallerySyncWarning(audit);
                    }
                } else if (content) {
                    content.innerHTML = '<div class="sync-dropdown-loading">Gallery sync module not loaded</div>';
                }
            } catch (err) {
                console.error('[MobileSync] Audit failed:', err);
                if (content) {
                    content.innerHTML = '<div class="sync-dropdown-loading">Error running audit</div>';
                }
            }
        }, 50);
    }

    /* ========================================
       REFRESH LOADING SAFETY NET
       Ensures the #loading overlay is hidden once
       the character grid is populated, in case the
       normal hide logic is skipped due to errors.
       ======================================== */
    function fixRefreshLoadingStuck() {
        const loading = document.getElementById('loading');
        const grid = document.getElementById('characterGrid');
        if (!loading || !grid) return;

        new MutationObserver(() => {
            if (grid.children.length > 0 && loading.style.display !== 'none') {
                loading.style.display = 'none';
            }
        }).observe(grid, { childList: true });
    }

    /* ========================================
       LOREBOOK MODAL TOOLBAR REWORK
       Moves collapse-all / expand-all / add-entry buttons
       from the body sub-header into the modal header bar,
       replacing the hidden zoom controls on mobile.
       ======================================== */
    function setupLorebookModalToolbar() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const modal = (node.id === 'lorebookExpandModal')
                        ? node
                        : node.querySelector?.('#lorebookExpandModal');
                    if (!modal) continue;

                    const headerControls = modal.querySelector('.modal-header-controls');
                    const actionsDiv = modal.querySelector('.expanded-lorebook-header-actions');
                    if (!headerControls || !actionsDiv) continue;

                    // Move actions into the header controls area
                    headerControls.appendChild(actionsDiv);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /* ========================================
       DEFAULT ZOOM FOR EXPANDED MODALS
       Pure CSS approach: zoom is set in library-mobile.css.
       We only need to update the zoom display label to match.
       No button clicking, no visibility toggling, no flash.
       ======================================== */
    function setDefaultExpandZoom() {
        // Map zoom control IDs to their desired default zoom %
        const zoomDefaults = {
            'greetingsZoomControls': 80,
            'lorebookZoomControls': 80,
            'chubExpandZoomControls': 80,
            'zoomControlBtns': 90
        };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    for (const [id, defaultZoom] of Object.entries(zoomDefaults)) {
                        const controls = (node.id === id) ? node : node.querySelector?.('#' + id);
                        if (controls) {
                            // Update the label text to reflect CSS zoom
                            const label = controls.querySelector('.zoom-level');
                            if (label) label.textContent = `${defaultZoom}%`;
                        }
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
    }

    /* ========================================
       PREVENT AUTO-FOCUS ON MODAL / SHEET OPEN
       On mobile, auto-focusing inputs inside modals causes
       the virtual keyboard to pop open immediately which is
       jarring and hides content. We blur any input that gets
       focused inside a modal/sheet within the first 400ms
       after the container becomes visible.
       ======================================== */
    function preventAutoFocusOnOpen() {
        // Selectors for containers whose auto-focus we want to suppress
        const containerSelectors = [
            '#tagEditorSheet',           // Tag Editor Sheet
            '#greetingsExpandModal',     // Greetings Expand Modal
            '#expandedFieldEditor',      // Expanded Field Editor
            '#editMessageModal',         // Edit Message Modal
            '.browse-tags-dropdown'      // Browse tags dropdown
        ];

        // Use focusin (bubbles) on document to catch programmatic .focus() calls
        let suppressUntil = 0;

        // Observe class/attribute changes that signal a container opening
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'attributes') continue;
                const target = mutation.target;
                for (const sel of containerSelectors) {
                    if (target.matches?.(sel)) {
                        // Container just became visible (hidden class removed or display changed)
                        const wasHidden = mutation.oldValue?.includes('hidden') ||
                                          mutation.oldValue?.includes('display: none') ||
                                          mutation.oldValue?.includes('display:none');
                        const isNowVisible = !target.classList.contains('hidden') &&
                                             target.style.display !== 'none';
                        if (wasHidden && isNowVisible) {
                            suppressUntil = Date.now() + 400;
                        }
                    }
                }
            }
        });

        // Observe class and style changes on the containers once they exist
        function observeContainers() {
            for (const sel of containerSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    observer.observe(el, {
                        attributes: true,
                        attributeFilter: ['class', 'style'],
                        attributeOldValue: true
                    });
                }
            }
        }

        // Initial observation + re-observe when new nodes appear (lazy-created modals)
        observeContainers();
        const bodyObserver = new MutationObserver(() => observeContainers());
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        // Intercept focus events during the suppression window
        document.addEventListener('focusin', (e) => {
            if (Date.now() > suppressUntil) return;
            const target = e.target;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                // Check if this input is inside one of our containers
                for (const sel of containerSelectors) {
                    if (target.closest(sel)) {
                        target.blur();
                        return;
                    }
                }
            }
        }, true);
    }

    /* ========================================
       MOBILE TAG EDITOR
       Complete slide-up tag editor sheet with inline
       suggestion pills. Injects DOM, wires events,
       and hooks into addTag/removeTag/setEditLock from
       the main library.js.
       ======================================== */
    function setupMobileTagEditor() {

        // ---- 1. Inject editTagsRow into Edit tab ----
        const versionField = document.getElementById('editVersion');
        const formRowParent = versionField?.closest('.form-row');
        const editSection = formRowParent?.closest('.edit-section');
        if (editSection) {
            const row = document.createElement('div');
            row.className = 'form-group edit-tags-row';
            row.id = 'editTagsRow';
            row.innerHTML = `
                <label><i class="fa-solid fa-tags" style="margin-right:4px; opacity:0.7;"></i>Tags</label>
                <div class="edit-tags-preview" id="editTagsPreview"></div>
                <button type="button" id="editTagsBtn" class="action-btn secondary small edit-tags-btn" disabled>
                    <i class="fa-solid fa-pen"></i> Edit Tags
                </button>
            `;
            // Insert after the form-row (name/version row)
            formRowParent.insertAdjacentElement('afterend', row);
        }

        // ---- 2. Inject Tag Editor Sheet ----
        const sheet = document.createElement('div');
        sheet.id = 'tagEditorSheet';
        sheet.className = 'tag-editor-sheet hidden';
        sheet.innerHTML = `
            <div class="tag-editor-sheet-backdrop"></div>
            <div class="tag-editor-sheet-panel">
                <div class="tag-editor-sheet-header">
                    <h3><i class="fa-solid fa-tags"></i> Edit Tags</h3>
                    <button type="button" class="close-btn" id="tagEditorSheetClose">&times;</button>
                </div>
                <div class="tag-editor-sheet-body">
                    <div class="tag-editor-sheet-tags" id="tagEditorSheetTags"></div>
                    <div class="tag-editor-sheet-input-row">
                        <input type="text" id="tagEditorSheetInput" class="glass-input tag-input" placeholder="Type a tag and press Enter...">
                        <div id="tagEditorSheetAutocomplete" class="tag-autocomplete hidden"></div>
                    </div>
                </div>
                <div class="tag-editor-sheet-footer">
                    <button type="button" id="tagEditorSheetDone" class="action-btn primary small"><i class="fa-solid fa-check"></i> Done</button>
                </div>
            </div>
        `;
        document.body.appendChild(sheet);

        // ---- 3. Local rendering helpers ----
        function esc(text) {
            return typeof escapeHtml === 'function' ? escapeHtml(text) : text
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function renderEditTagsPreview(tags) {
            const container = document.getElementById('editTagsPreview');
            if (!container) return;
            container.innerHTML = (!tags || tags.length === 0) ? '' :
                tags.map(t => `<span class="modal-tag">${esc(t)}</span>`).join('');
        }

        function renderSheetTags(tags) {
            const container = document.getElementById('tagEditorSheetTags');
            if (!container) return;
            if (!tags || tags.length === 0) { container.innerHTML = ''; return; }
            container.innerHTML = tags.map(t => `
                <span class="modal-tag editable">
                    ${esc(t)}
                    <button class="tag-remove-btn" data-tag="${esc(t)}" title="Remove tag">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </span>
            `).join('');
            container.querySelectorAll('.tag-remove-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (typeof removeTag === 'function') removeTag(btn.dataset.tag);
                };
            });
        }

        function showSheetAutocomplete(filterText) {
            filterText = filterText || '';
            const autocomplete = document.getElementById('tagEditorSheetAutocomplete');
            if (!autocomplete) return;

            const allTags = typeof getAllAvailableTags === 'function' ? getAllAvailableTags() : [];
            const currentTags = (typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [])
                .map(t => t.toLowerCase());
            const filter = filterText.toLowerCase();

            const suggestions = allTags.filter(tag => {
                const lo = tag.toLowerCase();
                return lo.includes(filter) && !currentTags.includes(lo);
            }).slice(0, 10);

            if (suggestions.length === 0 && filterText.trim()) {
                autocomplete.innerHTML = `
                    <div class="tag-autocomplete-item create-new" data-tag="${esc(filterText.trim())}">
                        <i class="fa-solid fa-plus"></i> Create "${esc(filterText.trim())}"
                    </div>`;
                autocomplete.classList.add('visible');
            } else if (suggestions.length > 0) {
                autocomplete.innerHTML = suggestions.map(tag =>
                    `<div class="tag-autocomplete-item" data-tag="${esc(tag)}">${esc(tag)}</div>`
                ).join('');
                autocomplete.classList.add('visible');
            } else {
                hideSheetAutocomplete();
                return;
            }

            autocomplete.querySelectorAll('.tag-autocomplete-item').forEach(item => {
                item.onclick = () => {
                    if (typeof addTag === 'function') addTag(item.dataset.tag);
                    // Re-show suggestions immediately (chip-selector pattern)
                    requestAnimationFrame(() => showSheetAutocomplete(''));
                };
            });
        }

        function hideSheetAutocomplete() {
            const ac = document.getElementById('tagEditorSheetAutocomplete');
            if (ac) ac.classList.remove('visible');
        }

        function openTagEditorSheet() {
            sheet.classList.remove('hidden');
            const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
            renderSheetTags(tags);
            showSheetAutocomplete('');
        }

        function closeTagEditorSheet() {
            sheet.classList.add('hidden');
            hideSheetAutocomplete();
        }

        // Make showSheetAutocomplete available globally for the suggestion flow
        window.showSheetAutocomplete = showSheetAutocomplete;

        // ---- 4. Wire event listeners ----
        const editTagsBtn = document.getElementById('editTagsBtn');
        if (editTagsBtn) {
            editTagsBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openTagEditorSheet();
            });
        }

        document.getElementById('tagEditorSheetClose')
            ?.addEventListener('click', closeTagEditorSheet);
        document.getElementById('tagEditorSheetDone')
            ?.addEventListener('click', closeTagEditorSheet);
        sheet.querySelector('.tag-editor-sheet-backdrop')
            ?.addEventListener('click', closeTagEditorSheet);

        const sheetInput = document.getElementById('tagEditorSheetInput');
        if (sheetInput) {
            sheetInput.addEventListener('input', (e) => showSheetAutocomplete(e.target.value));
            sheetInput.addEventListener('focus', () => showSheetAutocomplete(sheetInput.value));
            sheetInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = sheetInput.value.trim();
                    if (v && typeof addTag === 'function') addTag(v);
                    sheetInput.value = '';
                    requestAnimationFrame(() => showSheetAutocomplete(''));
                } else if (e.key === 'Escape') {
                    hideSheetAutocomplete();
                    sheetInput.blur();
                }
            });

            // Hide autocomplete when tapping outside input row
            document.addEventListener('click', (e) => {
                const inputRow = sheet.querySelector('.tag-editor-sheet-input-row');
                if (inputRow && !inputRow.contains(e.target)) {
                    hideSheetAutocomplete();
                }
            });
        }

        // ---- 5. Hook into addTag / removeTag ----
        // Monkey-patch to also update mobile UI
        const origAddTag = window.addTag;
        if (typeof origAddTag === 'function') {
            window.addTag = function(tag) {
                origAddTag(tag);
                const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
                renderEditTagsPreview(tags);
                renderSheetTags(tags);
                // Clear sheet input
                const si = document.getElementById('tagEditorSheetInput');
                if (si) si.value = '';
            };
        }

        const origRemoveTag = window.removeTag;
        if (typeof origRemoveTag === 'function') {
            window.removeTag = function(tag) {
                origRemoveTag(tag);
                const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
                renderEditTagsPreview(tags);
                renderSheetTags(tags);
            };
        }

        // ---- 6. Hook into setEditLock ----
        // Observe the lock status DOM changes to sync the edit-tags button
        const lockObserver = new MutationObserver(() => {
            const btn = document.getElementById('editTagsBtn');
            if (!btn) return;
            const lockStatus = document.getElementById('editLockStatus');
            const isLocked = lockStatus?.textContent?.includes('locked') ||
                             !document.querySelector('.edit-lock-header.unlocked');
            btn.disabled = isLocked;
            const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
            renderEditTagsPreview(tags);
        });
        const lockHeader = document.querySelector('.edit-lock-header');
        if (lockHeader) {
            lockObserver.observe(lockHeader, { attributes: true, attributeFilter: ['class'] });
        }

        // ---- 7. Sync preview when modal opens ----
        const modalObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.target.id === 'charModal' && !m.target.classList.contains('hidden')) {
                    const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
                    renderEditTagsPreview(tags);
                    const btn = document.getElementById('editTagsBtn');
                    if (btn) {
                        const isLocked = !document.querySelector('.edit-lock-header.unlocked');
                        btn.disabled = isLocked;
                    }
                }
            }
        });
        const charModal = document.getElementById('charModal');
        if (charModal) {
            modalObserver.observe(charModal, { attributes: true, attributeFilter: ['class'] });
        }
    }

})();
