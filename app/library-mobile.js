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
        a fully manual regex-based parser - ZERO reliance on Date().
   NO Response/fetch/JSON.parse patching - those break imports.
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

        // Manual parser - guaranteed to work on all browsers
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

        // Multiple assignment strategies - at least one must stick
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
    console.log('[MobileDatePatch] v3 loaded, manual parser active');
})();

/* ========================================
   OVERLAY REGISTRY
   Modules call window.registerOverlay(config) to register overlays.
   The back-button stack (mobile) and global Escape handler (all platforms)
   both read from this registry so new overlays don't require editing
   library-mobile.js or wiring their own Escape listeners.

   Config shape:
     id        {string}   - DOM element ID
     tier      {number}   - z-order priority (lower number = closes first = higher z-index)
     close     {function} - called with the element to close it
     static    {boolean}  - protect from catch-all el.remove() (default: true)
     escape    {boolean}  - respond to Escape key (default: true)
     visible   {function} - optional override: (el) => bool. Default auto-detects: cl-modal uses .visible, others use !.hidden.
   ======================================== */
window._overlayRegistry = window._overlayRegistry || [];
// Replace-by-id (mirrors the library.js bootstrap, which normally wins the || race)
window.registerOverlay = window.registerOverlay || function(cfg) {
    const i = window._overlayRegistry.findIndex(r => r.id === cfg.id);
    if (i !== -1) window._overlayRegistry[i] = cfg;
    else window._overlayRegistry.push(cfg);
};

/* ========================================
   MAIN MOBILE ENHANCEMENTS IIFE
   ======================================== */
(function MobileEnhancements() {
    'use strict';

    // Only run in mobile mode (html.cl-mobile, owned by the boot policy + the mode-sync block below)
    function isMobile() {
        return document.documentElement.classList.contains('cl-mobile');
    }

    // Shared signal: card-swipe sets this true when it commits to a horizontal
    // gesture so pull-to-refresh and view-swipe back off in the same touch.
    let activeCardSwipe = false;

    function fixViewport() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (meta && meta.content.indexOf('viewport-fit') === -1) {
            meta.content += ', viewport-fit=cover';
        }
    }

    // ---- Lifecycle: run/teardown so a live mode flip re-inits cleanly ----
    // mobileLive holds the active session, or null when the mobile layer is torn down. setup() captures
    // everything it attaches/mutates into the session (see the capture block in setup() below), so
    // teardown reverses it all: listeners removed, observers disconnected, timers cleared, created nodes
    // removed, reparents + globals + body/meta restored.
    let mobileLive = null;

    function runMobile() {
        if (mobileLive) return; // already active
        const ctx = mobileLive = {
            capturing: false, // gate: wrappers record into ctx only while true (setup + armed callbacks)
            uninstall: null,  // removes the session patches; called first in teardown
            captured: [],  // [target, type, handler, opts] from setup + armed observer callbacks
            adds: [],      // nodes the layer created (no prior parent) -> removed on teardown
            moves: [],     // nodes the layer reparented (had a prior parent) -> moved back on teardown
            observers: [],
            timers: [],
            restore: [],   // explicit undo fns: globals, viewport meta, body styles
        };
        // Snapshot the true viewport baseline before fixViewport() mutates it, so teardown restores the
        // real desktop value rather than the viewport-fit=cover-polluted one.
        const vp = document.querySelector('meta[name="viewport"]');
        if (vp) { const vpBefore = vp.content; ctx.restore.push(() => { vp.content = vpBefore; }); }
        ctx.uninstall = installSessionPatches(ctx);
        fixViewport();
        setup(ctx);
    }

    function teardownMobile() {
        const ctx = mobileLive;
        if (!ctx) return;
        mobileLive = null;
        try { ctx.uninstall?.(); } catch {} // restore the real globals before anything else runs
        ctx.observers.forEach(o => { try { o.disconnect(); } catch {} }); // before the moves, so they don't react to them
        ctx.timers.forEach(t => { try { clearInterval(t); } catch {} });
        ctx.captured.forEach(([t, ty, h, o]) => { try { t.removeEventListener(ty, h, o); } catch {} });
        ctx.adds.forEach(n => { try { n.remove(); } catch {} });
        ctx.moves.reverse().forEach(({ node, parent, next }) => {
            try {
                if (!parent) return;
                // The captured nextSibling anchor can be gone by restore time (eg. it was a
                // mobile-created node removed by the adds sweep above); a stale anchor makes
                // insertBefore throw and silently strands the node wherever mobile left it.
                if (next && next.parentNode !== parent) next = null;
                parent.insertBefore(node, next);
            } catch {}
        });
        while (ctx.restore.length) { try { ctx.restore.pop()(); } catch {} } // globals, viewport meta, body styles
        // Reset guard flags + residual classes so a re-run re-applies relocations / swipe wiring cleanly.
        document.querySelectorAll('[data-relocated], [data-swipe-init], .mobile-reparented').forEach(el => {
            el.removeAttribute('data-relocated');
            el.removeAttribute('data-swipe-init');
            el.classList.remove('mobile-reparented');
        });
        document.documentElement.classList.remove('cl-keyboard-open');
    }

    // ---- Mode sync: this block + the boot policy are the only writers of html.cl-mobile ----
    // The class flips immediately on an input change so CSS and event-time readers track the live
    // mode; the heavy run/teardown stays debounced so dragging a window across the boundary doesn't
    // thrash. teardown fully reverses the layer, so a desktop session is clean and a re-entry to
    // mobile rebuilds from scratch.
    const mq = window.matchMedia('(max-width: 768px)');
    function syncModeClass() {
        const mobile = window.computeMobileMode ? window.computeMobileMode() : mq.matches;
        document.documentElement.classList.toggle('cl-mobile', mobile);
        return mobile;
    }
    let crossTimer = 0;
    let appliedMode = null;
    function onModeInputChange() {
        syncModeClass();
        clearTimeout(crossTimer);
        crossTimer = setTimeout(() => {
            const mobile = syncModeClass();
            if (mobile === appliedMode) return;
            appliedMode = mobile;
            mobile ? runMobile() : teardownMobile();
            document.dispatchEvent(new CustomEvent('cl-mobile-mode-change', { detail: { mobile } }));
            // Chrome rebuild + mode-change subscribers (eg. UI-scale zoom) change layout after the
            // triggering resize already settled; nudge the virtual-scroll grid to re-measure last or
            // it keeps stale column math (dead right/bottom space).
            window.dispatchEvent(new Event('resize'));
        }, 250);
    }
    if (mq.addEventListener) mq.addEventListener('change', onModeInputChange);
    else if (mq.addListener) mq.addListener(onModeInputChange); // older Safari/iOS
    // The other two policy inputs: touch capability (eg. a convertible losing its keyboard) and
    // the per-device settings override.
    const touchMq = window.matchMedia('(pointer: coarse) and (hover: none)');
    if (touchMq.addEventListener) touchMq.addEventListener('change', onModeInputChange);
    else if (touchMq.addListener) touchMq.addListener(onModeInputChange); // older Safari/iOS
    document.addEventListener('cl-mobile-override-changed', onModeInputChange);

    // First load: run only on mobile, after a short delay so library.js finishes its own init.
    function init() {
        appliedMode = syncModeClass();
        if (isMobile()) setTimeout(runMobile, 200);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function recordInsert(ctx, node) {
        if (!node || node.nodeType !== 1) return;
        // A node that already has a parent is being REPARENTED (restore its origin on teardown); a
        // freshly-created node (no parent) is created chrome (remove on teardown).
        if (node.parentNode) ctx.moves.push({ node, parent: node.parentNode, next: node.nextSibling });
        else ctx.adds.push(node);
    }

    // Flip capture on for the duration of an observer callback: lazy wire/attach paths fire after setup
    // finished, and uncaptured attachments would leak past teardown / double-attach on re-cross.
    function armObserverCb(ctx, cb) {
        return function (...args) {
            if (mobileLive !== ctx) return cb.apply(this, args); // session ended/replaced; don't capture
            const prev = ctx.capturing;
            const before = ctx.captured.length + ctx.adds.length;
            ctx.capturing = true;
            try { return cb.apply(this, args); } finally {
                ctx.capturing = prev;
                if (ctx.captured.length + ctx.adds.length !== before) {
                    // This fire captured something; drop entries whose node left the DOM (transient
                    // viewers are create-per-open) so long sessions dont pin detached trees.
                    ctx.captured = ctx.captured.filter(([t]) => !(t instanceof Node) || t.isConnected);
                    ctx.adds = ctx.adds.filter(n => n.isConnected);
                }
            }
        };
    }

    // Patch the globals this layer uses so everything it attaches/mutates is recorded into ctx; returns
    // the uninstaller. Installed ONCE per mobile session and gated on ctx.capturing (true only during
    // setup and armed observer callbacks): repeatedly swapping prototype methods per observer fire would
    // invalidate engine inline caches on the virtual-scroll hot path, a flag check doesn't.
    //   - addEventListener -> captured for removeEventListener
    //   - MutationObserver  -> registered for disconnect, callback armed so its own lazy work is captured
    //   - appendChild/insertBefore/insertAdjacentElement -> reparent (restore origin) vs created (remove)
    function installSessionPatches(ctx) {
        const realAEL = EventTarget.prototype.addEventListener;
        const realMO = window.MutationObserver;
        const realAppend = Node.prototype.appendChild;
        const realInsert = Node.prototype.insertBefore;
        const realIAE = Element.prototype.insertAdjacentElement; // lives on Element, not Node
        EventTarget.prototype.addEventListener = function (type, handler, opts) {
            if (ctx.capturing) ctx.captured.push([this, type, handler, opts]);
            return realAEL.call(this, type, handler, opts);
        };
        window.MutationObserver = function (cb) {
            const o = new realMO(ctx.capturing ? armObserverCb(ctx, cb) : cb);
            if (ctx.capturing) ctx.observers.push(o);
            return o;
        };
        window.MutationObserver.prototype = realMO.prototype;
        Node.prototype.appendChild = function (node) { if (ctx.capturing) recordInsert(ctx, node); return realAppend.call(this, node); };
        Node.prototype.insertBefore = function (node, ref) { if (ctx.capturing) recordInsert(ctx, node); return realInsert.call(this, node, ref); };
        Element.prototype.insertAdjacentElement = function (pos, el) { if (ctx.capturing) recordInsert(ctx, el); return realIAE.call(this, pos, el); };
        return function uninstallSessionPatches() {
            EventTarget.prototype.addEventListener = realAEL;
            window.MutationObserver = realMO;
            Node.prototype.appendChild = realAppend;
            Node.prototype.insertBefore = realInsert;
            Element.prototype.insertAdjacentElement = realIAE;
        };
    }

    function setup(ctx) {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;

        // Snapshot the globals this layer assigns or re-wraps; restore on teardown. pushOverlayGuard is
        // called by the browse views too, so a stale one would push orphan hash guards on desktop.
        const g = {
            switchView: window.switchView, addTag: window.addTag,
            removeTag: window.removeTag, showSheetAutocomplete: window.showSheetAutocomplete,
            pushOverlayGuard: window.pushOverlayGuard,
        };
        ctx.restore.push(() => { Object.keys(g).forEach(k => { try { window[k] = g[k]; } catch {} }); });

        // setup() runs fully synchronously, so capture sees only this layer's setup-time work.
        ctx.capturing = true;
        try {
            applySetup(topbar);
        } finally {
            ctx.capturing = false;
        }
    }

    function applySetup(topbar) {
        // Isolated so one failing step cant silently kill every later one; failures log the step name.
        [
            createSearchButton, createSettingsButton, createMenuButton, createProviderQuickSwitch,
            setupBottomNav, migrateTopbarToBottomNav, setupHideTopbarOnScroll, setupBottomSheetDismiss,
            setupPullToRefresh, setupCardSwipeGestures, setupOnlineSearchOverlay, setupModalAvatar,
            setupGallerySwipe, setupGreetingsSwipe, setupTabSwipe,
            setupCharModalNavSwipe, setupViewSwipe, setupContextMenu, setupViewportFix,
            relocateTagPopup, relocatePlaylistPopup, relocateAdvFilterPanel, setDefaultExpandZoom,
            setupLorebookModalToolbar, fixInvalidDateText, setupChubFilterArea, setupGallerySyncDropdown,
            fixRefreshLoadingStuck, preventAutoFocusOnOpen, setupMobileTagEditor, setupModalHeaderCollapse,
            setupTitleScrollReveal, setupMultiSelectConfirm, setupBrowseModalActionsMenu, setupBackButton,
        ].forEach(step => {
            try { step(topbar); } catch (e) { console.error('[CL mobile] setup step failed:', step.name, e); }
        });
    }

    /* ========== BOTTOM NAVIGATION + FAB ========== */

    function setupBottomNav() {
        const bottomNav = document.getElementById('mobileBottomNav');
        const fab = document.getElementById('mobileFab');
        if (!bottomNav) return;

        const tabs = bottomNav.querySelectorAll('.mobile-bottom-nav-tab');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const view = tab.dataset.view;
                if (typeof window.switchView === 'function') {
                    window.switchView(view);
                }
                window.hapticFeedback?.(8);
            });
        });

        // Mirror .view-toggle.active so library.js doesn't need to know about us
        const desktopToggle = document.querySelector('.view-toggle');
        if (desktopToggle) {
            const syncBottomNav = () => {
                const activeBtn = desktopToggle.querySelector('.view-toggle-btn.active');
                if (!activeBtn) return;
                const activeView = activeBtn.dataset.view;
                tabs.forEach(t => t.classList.toggle('active', t.dataset.view === activeView));
                updateFab(activeView);
            };
            const observer = new MutationObserver(syncBottomNav);
            observer.observe(desktopToggle, {
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
            });
            syncBottomNav();
        }

        // Soft keyboard open: hide nav so it doesnt stack above the keyboard
        if (window.visualViewport) {
            const KEYBOARD_THRESHOLD = 150; // px of viewport reduction = keyboard
            const checkKeyboard = () => {
                const reduction = window.innerHeight - window.visualViewport.height;
                const open = reduction > KEYBOARD_THRESHOLD;
                bottomNav.classList.toggle('hidden-by-keyboard', open);
                if (fab) fab.classList.toggle('hidden-by-keyboard', open);
                document.documentElement.classList.toggle('cl-keyboard-open', open);
            };
            window.visualViewport.addEventListener('resize', checkKeyboard);
        }
    }

    /* ========== TOPBAR MIGRATION (mobile only) ========== */

    function migrateTopbarToBottomNav() {
        const filtersBtn = document.getElementById('mobileNavFiltersBtn');
        const moreBtn = document.getElementById('mobileNavMoreBtn');

        if (filtersBtn) {
            filtersBtn.addEventListener('click', () => {
                window.hapticFeedback?.(8);
                document.getElementById('mobileSettingsBtn')?.click();
            });
        }
        if (moreBtn) {
            moreBtn.addEventListener('click', () => {
                window.hapticFeedback?.(8);
                document.getElementById('mobileMenuBtn')?.click();
            });
        }

        // Reparent as a SIBLING of #onlineView (not child); activateProvider
        // does container.innerHTML = renderView() and would wipe a child.
        const onlineFilterArea = document.getElementById('onlineFilterArea');
        const onlineView = document.getElementById('onlineView');
        if (onlineFilterArea && onlineView && onlineFilterArea.parentElement !== onlineView.parentElement) {
            onlineView.parentNode.insertBefore(onlineFilterArea, onlineView);
            onlineFilterArea.classList.add('mobile-reparented');
        }

    }

    /* ========== HIDE TOPBAR ON SCROLL ========== */

    function setupHideTopbarOnScroll() {
        const topbar = document.querySelector('.topbar');
        const gallery = document.querySelector('.gallery-content');
        if (!topbar || !gallery) return;

        const HIDE_THRESHOLD = 80;   // scrollTop < this -> always show
        const DELTA_THRESHOLD = 6;   // ignore micro-deltas (touch jitter)
        let lastY = gallery.scrollTop;
        let ticking = false;

        function getFab() { return document.querySelector('.mobile-fab'); }

        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const curY = gallery.scrollTop;
                const delta = curY - lastY;
                const fab = getFab();

                if (curY < HIDE_THRESHOLD) {
                    topbar.classList.remove('topbar-hidden-on-scroll');
                    fab?.classList.remove('fab-hidden-on-scroll');
                } else if (Math.abs(delta) > DELTA_THRESHOLD) {
                    if (delta > 0) {
                        topbar.classList.add('topbar-hidden-on-scroll');
                        fab?.classList.add('fab-hidden-on-scroll');
                    } else {
                        topbar.classList.remove('topbar-hidden-on-scroll');
                        fab?.classList.remove('fab-hidden-on-scroll');
                    }
                }

                lastY = curY;
                ticking = false;
            });
        }

        gallery.addEventListener('scroll', onScroll, { passive: true });

        const desktopToggle = document.querySelector('.view-toggle');
        if (desktopToggle) {
            new MutationObserver(() => {
                topbar.classList.remove('topbar-hidden-on-scroll');
                getFab()?.classList.remove('fab-hidden-on-scroll');
                lastY = 0;
            }).observe(desktopToggle, {
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
            });
        }
    }

    /* ========== BOTTOM-SHEET DRAG-TO-DISMISS ========== */

    function setupBottomSheetDismiss() {
        const DRAG_ZONE_HEIGHT = 80;     // upper area where drag activates
        const DISMISS_THRESHOLD = 100;   // px of downward drag = dismiss
        let activeSheet = null;
        let startY = 0;
        let currentY = 0;
        let dragging = false;

        const DRAGGABLE_SHEET_SELECTOR = [
            '.cl-confirm-overlay:not(.hidden) .confirm-modal-content',
            '.cl-modal.cl-modal-drawer.visible .cl-modal-content',
            '.mobile-sheet-overlay:not(.hidden) .mobile-sheet',
            '.mobile-fixed-popup:not(.hidden)',
        ].join(', ');

        document.addEventListener('touchstart', (e) => {
            const sheet = e.target.closest(DRAGGABLE_SHEET_SELECTOR);
            if (!sheet) return;
            // Don't hijack touches on interactive controls (buttons, inputs).
            if (e.target.closest('button, a, input, textarea, select, label')) return;
            const rect = sheet.getBoundingClientRect();
            const offsetY = e.touches[0].clientY - rect.top;
            if (offsetY > DRAG_ZONE_HEIGHT) return;
            // Only start a dismiss-drag when the content under the touch is at the top.
            // A scrolled-down list/sheet should scroll up, not drag the sheet shut.
            for (let n = e.target; n && n !== sheet.parentElement; n = n.parentElement) {
                if (n.scrollTop > 0) return;
            }
            activeSheet = sheet;
            startY = e.touches[0].clientY;
            currentY = startY;
            dragging = true;
            sheet.style.transition = 'none';
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!dragging || !activeSheet) return;
            currentY = e.touches[0].clientY;
            const delta = Math.max(0, currentY - startY);
            activeSheet.style.transform = `translateY(${delta}px)`;
            // Non-passive: stop the browser co-opting the downward drag for
            // pull-to-refresh / overscroll while a sheet is being dismissed.
            if (e.cancelable) e.preventDefault();
        }, { passive: false });

        // Route drag-close through each sheet's own close so its cleanup (picker state, back-guards, checkbox revert) runs.
        function closeDraggedSheet(overlay) {
            if (!overlay) return;
            if (typeof overlay._closeFn === 'function') {
                overlay._closeFn(overlay);
            } else {
                const reg = (window._overlayRegistry || []).find(o => o.id && o.id === overlay.id && typeof o.close === 'function');
                if (reg) reg.close(overlay);
                // Legacy fallback for any unregistered drawer: toggle the family's own class.
                else if (overlay.classList.contains('cl-modal')) overlay.classList.remove('visible');
                else overlay.classList.add('hidden');
            }
            overlay._resolve?.(false);
        }

        function endDrag() {
            if (!dragging || !activeSheet) return;
            const delta = currentY - startY;
            const sheet = activeSheet;
            // For .mobile-fixed-popup the panel IS the toggled element; the others wrap it.
            const overlay = sheet.closest('.cl-confirm-overlay, .cl-modal, .mobile-sheet-overlay') || sheet;
            sheet.style.transition = 'transform 0.22s var(--ease-drawer)';

            if (delta > DISMISS_THRESHOLD) {
                sheet.style.transform = 'translateY(100%)';
                setTimeout(() => {
                    closeDraggedSheet(overlay);
                    sheet.style.transition = '';
                    sheet.style.transform = '';
                }, 220);
            } else {
                sheet.style.transform = '';
                setTimeout(() => { sheet.style.transition = ''; }, 220);
            }
            activeSheet = null;
            dragging = false;
        }

        document.addEventListener('touchend', endDrag);
        document.addEventListener('touchcancel', endDrag);
    }

    /* ========== PULL TO REFRESH ========== */

    function setupPullToRefresh() {
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        const indicator = document.createElement('div');
        indicator.className = 'mobile-pull-refresh-indicator';
        const ICON_PULL = '<i class="fa-solid fa-arrow-down"></i>';
        const ICON_LOAD = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
        indicator.innerHTML = ICON_PULL;
        scrollContainer.style.position = scrollContainer.style.position || 'relative';
        scrollContainer.appendChild(indicator);

        const PULL_THRESHOLD = 80;     // px past which release triggers refresh
        const MAX_PULL = 140;          // px upper clamp on visual travel
        const REST_POSITION = 36;      // px the indicator parks at while refreshing
        let startY = 0;
        let curY = 0;
        let pullDist = 0;
        let pulling = false;
        let refreshing = false;

        scrollContainer.addEventListener('touchstart', (e) => {
            if (refreshing) return;
            if (scrollContainer.scrollTop > 0) return;
            startY = e.touches[0].clientY;
            curY = startY;
            pulling = true;
        }, { passive: true });

        scrollContainer.addEventListener('touchmove', (e) => {
            if (!pulling || refreshing) return;
            if (activeCardSwipe) {
                // Card swipe has committed horizontally; release pull state cleanly.
                pulling = false;
                pullDist = 0;
                indicator.style.transform = 'translateY(-100%)';
                indicator.classList.remove('ready');
                return;
            }
            if (scrollContainer.scrollTop > 0) { pulling = false; return; }
            curY = e.touches[0].clientY;
            const raw = curY - startY;
            if (raw <= 0) {
                pullDist = 0;
                indicator.style.transform = 'translateY(-100%)';
                indicator.classList.remove('ready');
                return;
            }
            // dampened pull: resistance grows with distance
            pullDist = Math.min(MAX_PULL, raw * 0.6);
            indicator.style.transform = `translateY(${pullDist}px)`;
            indicator.style.opacity = String(Math.min(1, pullDist / 40));
            indicator.classList.toggle('ready', pullDist >= PULL_THRESHOLD);
        }, { passive: true });

        async function endPull() {
            if (!pulling || refreshing) {
                pulling = false;
                return;
            }
            pulling = false;

            if (pullDist >= PULL_THRESHOLD) {
                refreshing = true;
                indicator.classList.remove('ready');
                indicator.classList.add('refreshing');
                indicator.innerHTML = ICON_LOAD;
                indicator.style.transition = 'transform 0.22s var(--ease-drawer), opacity 0.22s ease';
                indicator.style.transform = `translateY(${REST_POSITION}px)`;
                window.hapticFeedback?.(15);

                try {
                    await triggerViewRefresh();
                } finally {
                    indicator.classList.remove('refreshing');
                    indicator.style.transition = 'transform 0.22s var(--ease-drawer), opacity 0.18s ease';
                    indicator.style.transform = 'translateY(-100%)';
                    indicator.style.opacity = '0';
                    setTimeout(() => {
                        indicator.innerHTML = ICON_PULL;
                        indicator.style.transition = '';
                        refreshing = false;
                    }, 240);
                }
            } else {
                indicator.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
                indicator.style.transform = 'translateY(-100%)';
                indicator.style.opacity = '0';
                setTimeout(() => {
                    indicator.style.transition = '';
                }, 180);
            }
            pullDist = 0;
        }

        scrollContainer.addEventListener('touchend', endPull);
        scrollContainer.addEventListener('touchcancel', endPull);
    }

    async function triggerViewRefresh() {
        const activeBtn = document.querySelector('.view-toggle-btn.active');
        const view = activeBtn?.dataset.view || 'characters';

        if (view === 'characters') {
            if (typeof window.fetchCharacters === 'function') {
                await window.fetchCharacters(true);
            }
            return;
        }

        if (view === 'chats') {
            document.getElementById('refreshChatsViewBtn')?.click();
            await new Promise(r => setTimeout(r, 600));
            return;
        }

        if (view === 'online') {
            const reg = window.ProviderRegistry;
            const provider = reg?.getActiveProvider?.();
            if (provider?.browseView) {
                const container = document.getElementById('onlineView');
                try {
                    provider.browseView.deactivate?.();
                    provider.browseView.activate?.(container, { domRecreated: false });
                } catch (err) {
                    console.warn('[PullToRefresh] online refresh failed:', err);
                }
            }
            await new Promise(r => setTimeout(r, 600));
        }
    }

    /* ========== CARD SWIPE GESTURES ========== */

    function setupCardSwipeGestures() {
        const grid = document.getElementById('characterGrid');
        if (!grid) return;

        const HORIZONTAL_INTENT = 10;    // px to commit to horizontal swipe
        const TRIGGER_THRESHOLD = 60;    // px of damped drag to fire action
        const DAMP = 0.7;                // resistance factor on the drag
        // Card-edge dead zones so a tab swipe starting on a card edge yields to view-swipe instead of triggering favorite/menu.
        const EDGE_DEAD_ZONE = 0.12;     // outer 12% of card width per side
        const BOTTOM_DEAD_ZONE = 0.75;   // touches below 75% of card height yield
        let card = null;
        let chip = null;
        let startX = 0;
        let startY = 0;
        let curX = 0;
        let direction = 0;               // -1 left, 1 right
        let swiping = false;
        let effectiveThreshold = TRIGGER_THRESHOLD;
        let swipedRecently = false;      // suppress synthesized click

        grid.addEventListener('touchstart', (e) => {
            // Re-checked every interaction so the setting toggle takes effect live.
            if (window.getSetting?.('mobileSwipeGestures') === false) return;
            if (e.touches.length > 1) return;
            const target = e.target.closest('.char-card');
            if (!target) return;
            // Don't engage on interactive controls inside the card.
            if (e.target.closest('button, a, .favorite-indicator')) return;
            // Spatial dead zone: edges + bottom overlay belong to view-swipe, only the central card hero engages card-swipe.
            const rect = target.getBoundingClientRect();
            const xFrac = (e.touches[0].clientX - rect.left) / rect.width;
            const yFrac = (e.touches[0].clientY - rect.top) / rect.height;
            if (xFrac < EDGE_DEAD_ZONE || xFrac > 1 - EDGE_DEAD_ZONE || yFrac > BOTTOM_DEAD_ZONE) return;
            card = target;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            curX = startX;
            direction = 0;
            swiping = false;
        }, { passive: true });

        grid.addEventListener('touchmove', (e) => {
            if (!card) return;
            curX = e.touches[0].clientX;
            const dx = curX - startX;
            const dy = e.touches[0].clientY - startY;

            if (!swiping) {
                if (Math.abs(dx) > HORIZONTAL_INTENT && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    swiping = true;
                    activeCardSwipe = true;
                    direction = dx > 0 ? 1 : -1;
                    // Edge-aware: cap threshold to what the user can physically reach.
                    // Available travel from startX to the screen edge, minus 8px margin, damped.
                    const reach = (direction > 0 ? window.innerWidth - startX : startX) - 8;
                    effectiveThreshold = Math.max(28, Math.min(TRIGGER_THRESHOLD, reach * DAMP * 0.85));
                    card.classList.add('swiping');
                    chip = document.createElement('div');
                    chip.className = `char-card-swipe-chip ${direction > 0 ? 'right' : 'left'}`;
                    chip.innerHTML = direction > 0
                        ? '<i class="fa-solid fa-star"></i>'
                        : '<i class="fa-solid fa-ellipsis-vertical"></i>';
                    card.appendChild(chip);
                } else if (Math.abs(dy) > HORIZONTAL_INTENT) {
                    // Vertical intent: abort swipe candidate, let scroll handle it.
                    card = null;
                    return;
                }
            } else if (chip) {
                // Mid-swipe direction reversal: thumb crossed zero and committed
                // the other way. Swap chip side/icon + recompute edge-aware threshold.
                const wantsDir = dx > HORIZONTAL_INTENT ? 1 : dx < -HORIZONTAL_INTENT ? -1 : 0;
                if (wantsDir !== 0 && wantsDir !== direction) {
                    direction = wantsDir;
                    const reach = (direction > 0 ? window.innerWidth - startX : startX) - 8;
                    effectiveThreshold = Math.max(28, Math.min(TRIGGER_THRESHOLD, reach * DAMP * 0.85));
                    chip.classList.remove('right', 'left', 'armed');
                    chip.classList.add(direction > 0 ? 'right' : 'left');
                    chip.innerHTML = direction > 0
                        ? '<i class="fa-solid fa-star"></i>'
                        : '<i class="fa-solid fa-ellipsis-vertical"></i>';
                }
            }

            if (swiping) {
                const damped = dx * DAMP;
                card.style.transform = `translateX(${damped}px)`;
                // Only arm when drag sign matches the committed direction.
                const armed = Math.sign(dx) === direction && Math.abs(damped) >= effectiveThreshold;
                if (chip) chip.classList.toggle('armed', armed);
            }
        }, { passive: true });

        function endSwipe() {
            if (!card) return;
            const cardRef = card;
            const chipRef = chip;
            const wasSwipe = swiping;
            const dx = curX - startX;
            const dir = direction;
            const armed = Math.sign(dx) === direction && Math.abs(dx * DAMP) >= effectiveThreshold;

            card = null;
            chip = null;
            swiping = false;
            activeCardSwipe = false;
            direction = 0;

            if (!wasSwipe) return;

            cardRef.classList.remove('swiping');
            cardRef.classList.add('swiping-released');

            if (armed) {
                const avatar = cardRef.dataset.avatar;
                const char = avatar && typeof window.getCharacterByAvatar === 'function'
                    ? window.getCharacterByAvatar(avatar)
                    : null;
                window.hapticFeedback?.(20);
                if (dir > 0 && char && typeof window.toggleCharacterFavorite === 'function') {
                    window.toggleCharacterFavorite(char);
                } else if (dir < 0) {
                    // Fire a contextmenu event on the card to open the existing
                    // mobile context sheet (long-press path already wired).
                    const rect = cardRef.getBoundingClientRect();
                    cardRef.dispatchEvent(new MouseEvent('contextmenu', {
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2,
                    }));
                }
            }

            cardRef.style.transform = '';
            if (chipRef) {
                chipRef.style.opacity = '0';
                setTimeout(() => chipRef.remove(), 200);
            }
            swipedRecently = true;
            setTimeout(() => {
                cardRef.classList.remove('swiping-released');
                swipedRecently = false;
            }, 240);
        }

        grid.addEventListener('touchend', endSwipe);
        grid.addEventListener('touchcancel', endSwipe);

        // Suppress the synthesized click after a swipe so the card doesn't open.
        grid.addEventListener('click', (e) => {
            if (swipedRecently) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
    }

    function updateFab(view) {
        const fab = document.getElementById('mobileFab');
        if (!fab) return;
        const icon = fab.querySelector('i');

        // Reset before reconfiguring
        fab.onclick = null;

        // Shared trigger: clicks the topbar's mobileSearchBtn which opens the
        // standard search overlay. Same input drives chars and chats filters
        // (chats module also listens to 'input' on #searchInput).
        const triggerSharedSearch = () => {
            window.hapticFeedback?.(8);
            const mobileSearch = document.getElementById('mobileSearchBtn');
            if (mobileSearch) {
                mobileSearch.click();
            } else {
                document.getElementById('searchInput')?.focus();
            }
        };

        const triggerOnlineSearch = () => {
            window.hapticFeedback?.(8);
            openOnlineSearchOverlay();
        };

        switch (view) {
            case 'characters':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search characters');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerSharedSearch;
                break;
            case 'chats':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search chats');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerSharedSearch;
                break;
            case 'online':
                fab.classList.remove('hidden');
                fab.setAttribute('aria-label', 'Search online');
                if (icon) icon.className = 'fa-solid fa-magnifying-glass';
                fab.onclick = triggerOnlineSearch;
                break;
            default:
                fab.classList.add('hidden');
                break;
        }
    }

    /* ========== MOBILE ONLINE SEARCH OVERLAY ========== */

    function getActiveBrowseView() {
        const provider = window.ProviderRegistry?.getActiveProvider?.();
        return provider?.browseView || null;
    }

    function _hideSearchOverlayUI() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.querySelector('.mobile-online-search-input')?.blur();
    }

    function openOnlineSearchOverlay() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;
        const browseView = getActiveBrowseView();
        const modes = browseView?.getSearchModes?.() || ['character'];
        const modesContainer = overlay.querySelector('.mobile-online-search-modes');
        const modeButtons = overlay.querySelectorAll('.mobile-online-search-mode');
        const input = overlay.querySelector('.mobile-online-search-input');
        const title = overlay.querySelector('.mobile-online-search-title');
        const providerName = window.ProviderRegistry?.getActiveProvider?.()?.name || 'online';

        if (modes.length > 1) {
            modesContainer.hidden = false;
            modeButtons.forEach(btn => {
                const mode = btn.dataset.mode;
                btn.classList.toggle('active', mode === modes[0]);
                btn.style.display = modes.includes(mode) ? '' : 'none';
                // Per-provider tab label (eg. botbooru calls its creators Uploaders); keep the icon
                const label = browseView?.getSearchModeLabel?.(mode);
                if (label) {
                    const icon = btn.querySelector('i')?.outerHTML || '';
                    btn.innerHTML = `${icon} ${label}`;
                }
            });
        } else {
            modesContainer.hidden = true;
        }

        const initialMode = modes[0];
        title.textContent = `Search ${providerName}`;
        input.placeholder = browseView?.getSearchPlaceholder?.(initialMode)
            || (initialMode === 'creator' ? 'Creator name...' : 'Character name...');
        input.dataset.activeMode = initialMode;
        input.value = '';
        overlay.querySelector('.mobile-online-search-clear').classList.add('hidden');

        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');

        // Tier 1.55 in setupBackButton handles the rest
        window.pushOverlayGuard?.();

        // iOS only surfaces the keyboard if focus lands on the next frame
        requestAnimationFrame(() => input.focus());
    }

    function closeOnlineSearchOverlay() {
        _hideSearchOverlayUI();
    }

    function setupOnlineSearchOverlay() {
        const overlay = document.getElementById('mobileOnlineSearchOverlay');
        if (!overlay) return;

        const modeButtons = overlay.querySelectorAll('.mobile-online-search-mode');
        const form = overlay.querySelector('.mobile-online-search-form');
        const input = overlay.querySelector('.mobile-online-search-input');
        const clearBtn = overlay.querySelector('.mobile-online-search-clear');

        // Scrim tap dismisses (close button is hidden via CSS, scrim + back are the dismissal paths)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOnlineSearchOverlay();
        });

        modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                modeButtons.forEach(b => b.classList.toggle('active', b === btn));
                input.dataset.activeMode = mode;
                input.placeholder = getActiveBrowseView()?.getSearchPlaceholder?.(mode)
                    || (mode === 'creator' ? 'Creator name...' : 'Character name...');
                input.focus();
            });
        });

        input.addEventListener('input', () => {
            clearBtn.classList.toggle('hidden', input.value.length === 0);
        });
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.classList.add('hidden');
            input.focus();
        });

        // Submit proxies to the provider's inline search via performSearch.
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const mode = input.dataset.activeMode || 'character';
            const query = input.value.trim();
            const browseView = getActiveBrowseView();
            if (!browseView) return;
            window.hapticFeedback?.(10);
            browseView.performSearch?.(mode, query);
            closeOnlineSearchOverlay();
        });

        // Escape only; back-button handled by Tier 1.55 in setupBackButton
        window.registerOverlay?.({
            id: 'mobileOnlineSearchOverlay',
            tier: 2,
            close: closeOnlineSearchOverlay,
        });
    }

    /* ========== ANDROID BACK BUTTON ========== */
    function setupBackButton() {
        // Built lazily; ProviderRegistry may not exist yet at setup time
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

        const stack = [
            // Tier 0 - avatar/gallery quick-view (highest z-index)
            ['#browseAvatarViewer', el => el.remove()],
            ['.mobile-avatar-viewer', () => closeAvatarViewer()],

            // Tier 1 - top z-index overlays
            ['#galleryViewerModal.visible',    () => window.closeGalleryViewer?.()],
            ['#clContextMenu.visible',         el => el.classList.remove('visible')],
            ['.custom-select-menu:not(.hidden)', el => el.classList.add('hidden')],

            // When char details is stacked above another modal, unwind its layers first
            () => {
                if (!document.body.classList.contains('char-modal-above')) return false;
                // Close the topmost non-pinned modal first (eg. preImportDuplicateModal
                // or localizeModal opened on top of charModal). Covers both class
                // systems since the pinned-z-index marker is the same trick for both.
                const visible = [...document.querySelectorAll('.confirm-modal:not(.hidden), .cl-modal.visible')];
                const unpinned = visible.filter(m => !m.style.getPropertyPriority('z-index'));
                if (unpinned.length > 0) {
                    const top = unpinned[unpinned.length - 1];
                    if (top.classList.contains('cl-modal')) top.classList.remove('visible');
                    else top.classList.add('hidden');
                    return true;
                }
                const charModal = document.getElementById('charModal');
                if (charModal && !charModal.classList.contains('hidden')) { window.maybeCloseModal?.(); return true; }
                return false;
            },

            // Tier 1.5 - catch-all for dynamic modal-overlays
            () => {
                for (const el of document.querySelectorAll('.modal-overlay:not(.hidden)')) {
                    if (!getStaticOverlays().has(el.id)) {
                        el.remove();
                        return true;
                    }
                }
                return false;
            },

            // Tier 1.55 - online search overlay (close + rearm in one shot)
            // Must run before Tier 1.6 so the rearm isn't bypassed
            () => {
                const ov = document.getElementById('mobileOnlineSearchOverlay');
                if (!ov || ov.classList.contains('hidden')) return false;
                const reg = (window._overlayRegistry || []).find(r => r.id === 'mobileOnlineSearchOverlay');
                if (reg?.close) reg.close(ov);
                else ov.classList.add('hidden');
                // Rearm if provider query active so next back pops Tier 7
                const provider = window.ProviderRegistry?.getActiveProvider?.();
                const browseView = provider?.browseView;
                if (browseView) {
                    const modes = browseView.getSearchModes?.() || ['character'];
                    for (const mode of modes) {
                        const inputId = browseView.getSearchInputId?.(mode);
                        if (!inputId) continue;
                        const input = document.getElementById(inputId);
                        if (input && input.value.trim()) { pushGuard(); break; }
                    }
                }
                return true;
            },

            // Tier 1.56 - mobile chars search overlay (close only; rearm comes from input listener)
            () => {
                const ov = document.querySelector('.mobile-search-overlay:not(.hidden)');
                if (!ov) return false;
                ov.classList.add('hidden');
                const searchBox = document.querySelector('.search-box');
                const searchArea = document.querySelector('.search-area');
                if (searchBox && searchArea) searchArea.insertBefore(searchBox, searchArea.firstChild);
                return true;
            },

            // Tier 1.6 - registered overlays. Must close before Tier 2 confirm modals.
            () => {
                const regs = [...(window._overlayRegistry || [])]
                    .sort((a, b) => a.tier - b.tier);
                for (const reg of regs) {
                    const el = document.getElementById(reg.id);
                    if (!el) continue;
                    const visible = reg.visible
                        ? reg.visible(el)
                        : el.classList.contains('cl-modal')
                            ? el.classList.contains('visible')
                            : !el.classList.contains('hidden');
                    if (visible) { reg.close(el); return true; }
                }
                return false;
            },

            // Tier 2 - confirm/dialog modals (z-2000+)
            ['#disableGalleryFoldersModal',          el => el.remove()],
            // Tier 2.5 - mobile sheets & overlays (.mobile-search-overlay lives in Tier 1.56).
            ['.mobile-sheet-overlay:not(.hidden)', () => {
                const overlays = document.querySelectorAll('.mobile-sheet-overlay:not(.hidden)');
                const el = overlays[overlays.length - 1];
                el.querySelector('.mobile-sheet')?.classList.remove('open');
                setTimeout(() => el.classList.add('hidden'), 300);
            }],
            ['#tagFilterPopup:not(.hidden)', el => el.classList.add('hidden')],
            ['#playlistFilterPopup:not(.hidden)', el => el.classList.add('hidden')],

            // Tier 3 - tag editor sheet
            ['.tag-editor-sheet:not(.hidden)', el => { el.classList.add('hidden'); document.getElementById('tagEditorSheetAutocomplete')?.classList.add('hidden'); }],

            // Tier 3 - full-screen modals
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

            // Tier 4 - in-modal sub-views
            ['.vt-container.vt-detail-open', el => el.classList.remove('vt-detail-open')],

            // Tier 5 - main modals (lowest priority full-screen)
            ['#charModal:not(.hidden)',    () => window.maybeCloseModal?.()],
            ['#creatorModal:not(.hidden)', () => window.closeCharacterCreator?.()],

            // Tier 6 - dropdowns (browse filter dropdowns are relocated to body on mobile)
            ['#moreOptionsMenu:not(.hidden)',     el => el.classList.add('hidden')],
            ['#settingsMenu:not(.hidden)',        el => el.classList.add('hidden')],
            () => {
                // .browse-tags-dropdown and .browse-features-dropdown are also .dropdown-menu,
                // so this single query catches all three.
                const dd = document.querySelector('body > .dropdown-menu[data-mobile-relocated]:not(.hidden)');
                if (dd) { dd.classList.add('hidden'); return true; }
                return false;
            },

            // Tier 7 - active text search on characters / chats view
            // (both views share #searchInput; chats listens to 'input' for re-render)
            () => {
                const view = window.getCurrentView?.();
                if (view !== 'characters' && view !== 'chats') return false;
                const input = document.getElementById('searchInput');
                if (!input || !input.value.trim()) return false;
                input.value = '';
                document.getElementById('clearSearchBtn')?.classList.add('hidden');
                if (view === 'characters') window.performSearch?.();
                // Always fire input event so the chats module (and any other
                // input listeners) pick up the cleared state too.
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            },

            // Tier 7 - active search on online view (current provider, any mode)
            () => {
                if (window.getCurrentView?.() !== 'online') return false;
                const provider = window.ProviderRegistry?.getActiveProvider?.();
                const browseView = provider?.browseView;
                if (!browseView) return false;
                const modes = browseView.getSearchModes?.() || ['character'];
                let cleared = false;
                for (const mode of modes) {
                    const inputId = browseView.getSearchInputId?.(mode);
                    if (!inputId) continue;
                    const input = document.getElementById(inputId);
                    if (input && input.value.trim()) {
                        browseView.performSearch?.(mode, '');
                        cleared = true;
                    }
                }
                return cleared;
            },
        ];

        // location.hash guards. Chromium / Brave silently skip pushState
        // entries during back-button traversal (the "history manipulation
        // intervention"); hash assignments survive. Each modal open pushes
        // one guard, each back press consumes one and closes one layer.
        let guardId = 0;
        let processedHash = null;

        function pushGuard() {
            guardId++;
            processedHash = null;
            location.hash = 'g' + guardId;
        }
        window.pushOverlayGuard = pushGuard;

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
                if (typeof entry === 'function') continue;
                const [selector] = entry;
                if (document.querySelector(selector)) return true;
            }
            for (const reg of (window._overlayRegistry || [])) {
                const el = document.getElementById(reg.id);
                if (!el) continue;
                const visible = reg.visible
                    ? reg.visible(el)
                    : el.classList.contains('cl-modal')
                        ? el.classList.contains('visible')
                        : !el.classList.contains('hidden');
                if (visible) return true;
            }
            return false;
        }

        const classObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const el = m.target;
                const oldClasses = m.oldValue || '';

                if (el.classList.contains('modal-overlay') || el.classList.contains('confirm-modal') ||
                    el.classList.contains('ai-studio-overlay') || el.classList.contains('creator-import-overlay')) {
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
                // Browse filter drawers (relocated to body on mobile, bottom-sheet styled).
                // They sit outside the modal classes so they need their own watcher.
                if (el.classList.contains('browse-tags-dropdown') || el.classList.contains('browse-features-dropdown')) {
                    const wasHidden = oldClasses.includes('hidden');
                    const isHidden = el.classList.contains('hidden');
                    if (wasHidden && !isHidden) {
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

        document.querySelectorAll('.modal-overlay, .cl-modal, .gv-modal, .confirm-modal, .browse-tags-dropdown, .browse-features-dropdown').forEach(el => {
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
                        node.classList.contains('creator-import-overlay')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                        // Inject + show fire same tick; push guard if already visible
                        if (!node.classList.contains('hidden')) pushGuard();
                    }
                    // Filter dropdowns get appendChild-relocated to body on mobile.
                    // Observe them so .hidden toggles emit a guard.
                    if (node.classList.contains('browse-tags-dropdown') || node.classList.contains('browse-features-dropdown')) {
                        classObserver.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
                        if (!node.classList.contains('hidden')) pushGuard();
                    }
                }
            }
        });
        childObserver.observe(document.body, { childList: true });

        // ── Back-press handler ──
        function onBack() {
            const h = location.hash;
            if (h === '#g' + guardId || (processedHash !== null && h === processedHash)) return;
            processedHash = h;
            if (closeTopLayer() && !location.hash && hasOpenModals()) {
                pushGuard();
            }
        }

        window.addEventListener('hashchange', onBack);
        window.addEventListener('popstate', onBack);

        // Safety net for Android skipping our guards: show "Leave site?" instead of dropping the tab.
        window.addEventListener('beforeunload', function(e) {
            if (hasOpenModals()) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        });
    }

    /* ========== SEARCH OVERLAY ========== */
    function createSearchButton(topbar) {
        const searchArea = topbar.querySelector('.search-area');
        if (!searchArea) return;

        const btn = document.createElement('button');
        btn.id = 'mobileSearchBtn';
        btn.innerHTML = '<i class="fa-solid fa-search"></i>';
        btn.title = 'Search';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        searchArea.appendChild(btn);

        const overlay = document.createElement('div');
        overlay.className = 'mobile-search-overlay hidden';

        const container = document.createElement('div');
        container.className = 'mobile-search-container';

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        const searchBox = searchArea.querySelector('.search-box');

        // Brave/Chrome mobile drop hash pushes made from inside hashchange/popstate;
        // rearm from the input event (a fresh task). Resets on overlay close.
        let filterGuardPushed = false;

        // Lock the underlying grid scroll while search is open so soft-keyboard transitions on Android dont drift the character list. Save on open, restore any drift via a scroll listener, release on close.
        let scrollLock = null;
        // Keyboard tracker: layout viewport stays full-size (interactive-widget=overlays-content + lvh body) so the OSK is just an overlay; visualViewport tells us how tall it is and we lift the search overlays bottom edge by that amount.
        let viewportTracker = null;
        function openSearch() {
            if (searchBox) {
                container.appendChild(searchBox);
            }
            overlay.style.top = `${topbar.offsetHeight}px`;
            overlay.classList.remove('hidden');

            const galleryContent = document.querySelector('.gallery-content');
            if (galleryContent) {
                const savedTop = galleryContent.scrollTop;
                const onScroll = () => { if (galleryContent.scrollTop !== savedTop) galleryContent.scrollTop = savedTop; };
                galleryContent.addEventListener('scroll', onScroll, { passive: true });
                scrollLock = { galleryContent, onScroll };
            }

            if (window.visualViewport) {
                const sync = () => {
                    const vv = window.visualViewport;
                    const keyboardH = Math.max(0, window.innerHeight - vv.height);
                    overlay.style.bottom = keyboardH > 0 ? `${keyboardH}px` : '';
                };
                window.visualViewport.addEventListener('resize', sync);
                window.visualViewport.addEventListener('scroll', sync);
                viewportTracker = sync;
                sync();
            }

            window.pushOverlayGuard?.();

            setTimeout(() => {
                const input = document.getElementById('searchInput');
                // preventScroll: true tells the browser not to auto-scrollIntoView when focusing; some Android Chromes use that path to scroll the nearest scrollable container (.gallery-content, even as a sibling), drifting the grid.
                if (input) input.focus({ preventScroll: true });
            }, 50);
        }

        function closeSearch() {
            overlay.classList.add('hidden');
            overlay.style.bottom = '';
            if (searchBox) {
                searchArea.insertBefore(searchBox, searchArea.firstChild);
            }
            if (scrollLock) {
                scrollLock.galleryContent.removeEventListener('scroll', scrollLock.onScroll);
                scrollLock = null;
            }
            if (viewportTracker && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', viewportTracker);
                window.visualViewport.removeEventListener('scroll', viewportTracker);
                viewportTracker = null;
            }
        }

        btn.addEventListener('click', openSearch);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSearch();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                closeSearch();
            }
        });

        const searchInputForGuard = document.getElementById('searchInput');
        if (searchInputForGuard) {
            searchInputForGuard.addEventListener('input', () => {
                if (overlay.classList.contains('hidden')) return;
                const hasValue = !!searchInputForGuard.value.trim();
                if (hasValue && !filterGuardPushed) {
                    window.pushOverlayGuard?.();
                    filterGuardPushed = true;
                }
            });
        }

        new MutationObserver(() => {
            if (overlay.classList.contains('hidden')) filterGuardPushed = false;
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    /* ========== SETTINGS BOTTOM SHEET (view-aware) ========== */
    function createSettingsButton(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileSettingsBtn';
        btn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        btn.title = 'Settings';
        btn.style.cssText = 'display:flex!important;align-items:center;justify-content:center';
        topbar.appendChild(btn);

        const { overlay, sheet, close } = createBottomSheet();

        addSheetHandle(sheet);

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
        const sortChip = createSettingsSelectChip(() => document.getElementById('sortSelect'), 'Sort By');
        sortSection.appendChild(sortChip);
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

        function syncCharFilterChips() {
            const s = window.getActiveFilterState?.() || {};
            favChip.classList.toggle('active', !!s.fav);
            tagChip.classList.toggle('active', !!s.tag);
            playlistChip.classList.toggle('active', !!s.playlist);
        }

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
         { id: 'searchAuthor', label: 'Author' }, { id: 'searchNotes', label: 'Notes' },
         { id: 'searchTagline', label: 'Tagline' }]
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
            // Wyvern has no Following-mode sort; gate the whole Sort By section so it doesnt show empty.
            const hasFollowSort = !!getIds()?.timelineSort;
            mtBrowseSortChip.style.display = isFollowing ? 'none' : '';
            mtFollowSortChip.style.display = (isFollowing && hasFollowSort) ? '' : 'none';
            mtSortSection.style.display = (isFollowing && !hasFollowSort) ? 'none' : '';
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

        // Sort - browse sort + following sort chips, toggled by mode
        const mtSortSection = createSection('Sort By');

        const mtBrowseSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.sort ? document.getElementById(ids.sort) : null; },
            'Sort By',
            () => syncSubSort(),
        );
        mtSortSection.appendChild(mtBrowseSortChip);

        // Optional sub-sort (eg. botbooru): mirror the real select's browse-filter-hidden, which encodes the gating.
        const mtSubSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.subSort ? document.getElementById(ids.subSort) : null; },
            'Sort By',
        );
        mtSubSortChip.style.display = 'none';
        mtSubSortChip.style.marginTop = 'var(--space-sm)';
        mtSortSection.appendChild(mtSubSortChip);

        function syncSubSort() {
            const ids = getIds();
            const real = ids?.subSort ? document.getElementById(ids.subSort) : null;
            const realTarget = real ? (real._customSelect?.container || real) : null;
            const show = !!realTarget && !realTarget.classList.contains('browse-filter-hidden');
            if (show) mtSubSortChip._syncLabel();
            mtSubSortChip.style.display = show ? '' : 'none';
        }

        const mtFollowSortChip = createSettingsSelectChip(
            () => { const ids = getIds(); return ids?.timelineSort ? document.getElementById(ids.timelineSort) : null; },
            'Sort By',
        );
        mtFollowSortChip.style.display = 'none';
        mtSortSection.appendChild(mtFollowSortChip);
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

        // ===== GENERIC PROVIDER SECTION (no mode toggle - Janny, CT, future providers) =====
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
        const genericSortChip = createSettingsSelectChip(
            () => { const ids = window.ProviderRegistry?.getActiveMobileFilterIds?.(); return ids?.sort ? document.getElementById(ids.sort) : null; },
            'Sort By',
        );
        genericSortSection.appendChild(genericSortChip);
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
        const chatsSortChip = createSettingsSelectChip(() => document.getElementById('chatsSortSelect'), 'Sort By');
        chatsSortSection.appendChild(chatsSortChip);
        chatsSection.appendChild(chatsSortSection);

        // Card density; mirrors the real control's hidden state (flat list only, hidden in grouped view)
        const chatsDensitySection = createSection('Card Density');
        const chatsDensityChip = createSettingsSelectChip(() => document.getElementById('chatsDensitySelect'), 'Card Density');
        chatsDensitySection.appendChild(chatsDensityChip);
        chatsSection.appendChild(chatsDensitySection);

        function syncChatsDensity() {
            const real = document.getElementById('chatsDensitySelect');
            const holder = real ? (real._customSelect?.container || real) : null;
            const show = !!holder && !holder.classList.contains('hidden');
            if (show) chatsDensityChip._syncLabel();
            chatsDensitySection.style.display = show ? '' : 'none';
        }

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
            syncChatsDensity();
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

            body.querySelectorAll('.mobile-settings-view-section').forEach(s => {
                s.style.display = s.dataset.view === activeView ? '' : 'none';
            });

            if (activeView === 'online') {
                const reg = window.ProviderRegistry;
                const hasModeToggle = reg?.activeProviderHasModeToggle?.() || false;
                const ids = reg?.getActiveMobileFilterIds?.();

                modeToggleSection.style.display = hasModeToggle ? '' : 'none';
                genericSection.style.display = hasModeToggle ? 'none' : '';

                if (!hasModeToggle) {
                    const prov = reg?.getActiveProvider?.();
                    genericProviderLabel.textContent = prov ? prov.name : 'Online';
                    genericSortChip._syncLabel();
                    syncGenericNsfwState();
                }

                if (hasModeToggle) {
                    // Chips read options live from the real selects at open time; only labels + per-mode visibility refresh here.
                    mtBrowseSortChip._syncLabel();
                    mtFollowSortChip._syncLabel();
                    syncMode();
                    syncMtNsfwState();
                    syncSort();
                    syncSubSort();
                }
            } else if (activeView === 'chats') {
                syncGrouping();
                chatsSortChip._syncLabel();
            } else {
                sortChip._syncLabel();
                syncCharFilterChips();
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

    function createSettingsSelectChip(getRealSelect, title, afterSelect) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mobile-settings-select';
        chip.innerHTML = '<span class="mobile-settings-select-text"></span><i class="fa-solid fa-chevron-down mobile-settings-select-arrow"></i>';
        chip._syncLabel = () => {
            const real = getRealSelect();
            chip.querySelector('.mobile-settings-select-text').textContent =
                real ? (real.options[real.selectedIndex]?.textContent || '') : '';
        };
        chip.addEventListener('click', () => {
            const real = getRealSelect();
            if (!real) return;
            window.openSelectorSheetFromSelect?.(real, {
                title,
                onSelect: () => { chip._syncLabel(); afterSelect?.(); },
            });
        });
        return chip;
    }

    // <label for=id> text (settings rows) as a drawer-title fallback; strips trailing colon.
    function selectLabelText(select) {
        if (!select.id) return '';
        const lbl = document.querySelector(`label[for="${select.id}"]`);
        return lbl ? lbl.textContent.replace(/\s*:\s*$/, '').trim() : '';
    }

    let _selectorSheet = null;
    function openSelectorSheetFromSelect(select, opts = {}) {
        if (!select) return;
        if (!_selectorSheet) {
            _selectorSheet = createBottomSheet();
            document.body.appendChild(_selectorSheet.overlay);
        }
        const { overlay, sheet, close } = _selectorSheet;
        sheet.innerHTML = '';

        addSheetHandle(sheet);

        const title = opts.title || select.title || select.getAttribute('aria-label') || selectLabelText(select);
        if (title) {
            const t = document.createElement('div');
            t.className = 'mobile-sheet-title';
            t.textContent = title;
            sheet.appendChild(t);
        }

        const current = select.value;

        const addOption = (opt) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mobile-sheet-item';
            const selected = opt.value === current;
            if (selected) item.classList.add('active');
            if (opt.disabled) item.disabled = true;
            if (opt.dataset.iconUrl) {
                const img = document.createElement('img');
                img.src = opt.dataset.iconUrl;
                img.className = 'item-icon-img';
                img.alt = '';
                item.appendChild(img);
            } else if (opt.dataset.icon) {
                const i = document.createElement('i');
                i.className = opt.dataset.icon;
                item.appendChild(i);
            }
            const label = document.createElement('span');
            label.className = 'mobile-sheet-item-label';
            label.textContent = opt.textContent;
            item.appendChild(label);
            if (selected) {
                const chk = document.createElement('i');
                chk.className = 'fa-solid fa-check mobile-sheet-check';
                item.appendChild(chk);
            }
            item.addEventListener('click', () => {
                if (opt.disabled) return;
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                close();
                opts.onSelect?.(select);
            });
            sheet.appendChild(item);
        };

        for (const child of select.children) {
            if (child.tagName === 'OPTGROUP') {
                const gt = document.createElement('div');
                gt.className = 'mobile-sheet-group-title';
                gt.textContent = child.label;
                sheet.appendChild(gt);
                for (const o of child.children) if (o.tagName === 'OPTION') addOption(o);
            } else if (child.tagName === 'OPTION') {
                addOption(child);
            }
        }

        openSheet(overlay, sheet);
    }
    window.openSelectorSheetFromSelect = openSelectorSheetFromSelect;

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

        addSheetHandle(sheet);

        // Clone items from the desktop menu
        const moreOptionsMenu = document.getElementById('moreOptionsMenu');
        if (moreOptionsMenu) {
            const items = moreOptionsMenu.querySelectorAll('.dropdown-item');
            items.forEach(item => {
                // Skip desktop-only responsive overflow items - they belong to the
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

        // Notifications - directly toggle dropdown (the real button is in a hidden container)
        const syncDropdown = document.getElementById('notificationsDropdown');
        if (syncDropdown) {
            const syncItem = document.createElement('button');
            syncItem.className = 'mobile-sheet-item';
            syncItem.innerHTML = '<i class="fa-solid fa-bell"></i> Notifications';
            syncItem.addEventListener('click', () => {
                close();
                // Small delay so the sheet closes first
                setTimeout(() => openGallerySyncDropdown(syncDropdown), 350);
            });
            syncItem.dataset.gallerySyncItem = 'true';
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

        // Embedded-mode escape hatch: when CL is embedded in a SillyTavern pane
        // and the ST topbar is hidden, the desktop puts a back-arrow on the
        // logo area. On mobile we drop a sheet entry at the bottom instead
        // (the desktop arrow is hidden via mobile CSS).
        const backToSTItem = document.createElement('button');
        backToSTItem.className = 'mobile-sheet-item';
        backToSTItem.id = 'mobileBackToSTItem';
        backToSTItem.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to SillyTavern';
        backToSTItem.style.display = (window.isEmbedded && !window.embeddedShowTopBar) ? '' : 'none';
        backToSTItem.addEventListener('click', () => {
            close();
            window.closeEmbeddedPanel?.();
        });
        sheet.appendChild(backToSTItem);

        // ST host may toggle the topbar at runtime; mirror the desktop back-arrow logic.
        window.addEventListener('message', (e) => {
            if (e.origin !== window.location.origin) return;
            const msg = e.data;
            if (!msg || msg.source !== 'character-library-host') return;
            if (msg.type === 'cl-show-topbar') {
                backToSTItem.style.display = (window.isEmbedded && !msg.value) ? '' : 'none';
            }
        });

        btn.addEventListener('click', () => {
            const isOnline = getActiveView() === 'online';
            providerSwitchItem.style.display = isOnline ? '' : 'none';

            openSheet(overlay, sheet);
        });
        document.body.appendChild(overlay);
    }

    /* ========================================
       PROVIDER QUICK SWITCH BUTTON
       ======================================== */
    function createProviderQuickSwitch(topbar) {
        const btn = document.createElement('button');
        btn.id = 'mobileProviderQuickSwitch';
        btn.className = 'mobile-provider-quick-switch hidden';
        btn.title = 'Switch Provider';
        btn.innerHTML = '<i class="fa-solid fa-globe"></i>';
        btn.style.cssText = 'touch-action:manipulation';

        const viewToggle = topbar.querySelector('.view-toggle');
        if (viewToggle && viewToggle.nextSibling) {
            topbar.insertBefore(btn, viewToggle.nextSibling);
        } else {
            topbar.appendChild(btn);
        }

        function updateIcon() {
            if (!window.ProviderRegistry) return;
            const activeId = window.ProviderRegistry.getActiveProviderId();
            const providers = window.ProviderRegistry.getViewProviders();
            const active = providers.find(p => p.id === activeId);
            if (!active) return;

            if (active.iconUrl) {
                btn.innerHTML = '';
                const img = document.createElement('img');
                img.src = active.iconUrl;
                img.alt = active.name;
                img.className = 'mobile-provider-quick-switch-icon';
                btn.appendChild(img);
            } else {
                btn.innerHTML = '<i class="' + active.icon + '"></i>';
            }
            btn.title = active.name;
        }

        function updateVisibility() {
            const isOnline = getActiveView() === 'online';
            const enabled = window.getSetting?.('mobileProviderQuickSwitch') !== false;
            btn.classList.toggle('hidden', !isOnline || !enabled);
            if (isOnline) updateIcon();
        }

        // Track view changes by wrapping switchView
        const origSwitch = window.switchView;
        if (origSwitch) {
            window.switchView = function(view) {
                origSwitch.call(this, view);
                updateVisibility();
            };
        }

        // Also listen to view toggle clicks for redundancy
        document.querySelectorAll('.view-toggle-btn').forEach(b => {
            b.addEventListener('click', () => setTimeout(updateVisibility, 50));
        });

        // Bottom sheet for provider selection
        const { overlay, sheet, close } = createBottomSheet();

        function populateSheet() {
            if (!window.ProviderRegistry) return;
            const providers = window.ProviderRegistry.getViewProviders();
            const activeId = window.ProviderRegistry.getActiveProviderId();
            sheet.innerHTML = '';

            addSheetHandle(sheet);

            const title = document.createElement('div');
            title.className = 'mobile-provider-sheet-title';
            title.textContent = 'Switch Provider';
            sheet.appendChild(title);

            providers.forEach(p => {
                const item = document.createElement('button');
                item.className = 'mobile-sheet-item';
                if (p.id === activeId) item.style.color = 'var(--accent)';

                if (p.iconUrl) {
                    const img = document.createElement('img');
                    img.src = p.iconUrl;
                    img.alt = p.name;
                    img.className = 'mobile-provider-sheet-icon';
                    item.appendChild(img);
                } else {
                    const icon = document.createElement('i');
                    icon.className = p.icon;
                    item.appendChild(icon);
                }

                const name = document.createTextNode(' ' + p.name);
                item.appendChild(name);

                if (p.id === activeId) {
                    const check = document.createElement('i');
                    check.className = 'fa-solid fa-check';
                    check.style.cssText = 'margin-left:auto;font-size:0.8rem;';
                    item.appendChild(check);
                }

                item.addEventListener('click', () => {
                    if (p.id !== activeId) {
                        const select = document.getElementById('providerSelect');
                        if (select) {
                            select.value = p.id;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    close();
                    setTimeout(updateIcon, 100);
                });
                sheet.appendChild(item);
            });
        }

        btn.addEventListener('click', () => {
            populateSheet();
            openSheet(overlay, sheet);
        });

        document.body.appendChild(overlay);

        // Initial state
        setTimeout(updateVisibility, 300);
    }

    /* ========================================
       BOTTOM SHEET HELPERS
       ======================================== */
    // Separate from createBottomSheet because builders re-clear the sheet after creating it.
    function addSheetHandle(sheet) {
        const h = document.createElement('div');
        h.className = 'mobile-sheet-handle';
        sheet.appendChild(h);
        return h;
    }

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
        overlay._closeFn = close;   // drag-to-dismiss routes through the canonical close

        return { overlay, sheet, close };
    }

    function openSheet(overlay, sheet) {
        overlay.classList.remove('hidden');
        // lift the sheet above whatever's currently on top (eg. the AI Studio pool selector opens over the 10001 studio overlay) so it isnt buried at the 1200 sheet layer
        let topZ = 0;
        document.querySelectorAll('.cl-modal.visible, .modal-glass:not(.hidden), .ai-studio-overlay:not(.hidden), .creator-modal-glass:not(.hidden), .confirm-modal:not(.hidden), .cl-confirm-overlay:not(.hidden), .mobile-sheet-overlay:not(.hidden)').forEach(el => {
            if (el === overlay) return;
            const z = parseInt(getComputedStyle(el).zIndex, 10);
            if (Number.isFinite(z) && z > topZ) topZ = z;
        });
        overlay.style.zIndex = topZ >= 1200 ? String(topZ + 1) : '';
        // Force reflow then animate
        sheet.offsetHeight; // eslint-disable-line no-unused-expressions
        requestAnimationFrame(() => sheet.classList.add('open'));
        // Every mobile bottom-sheet flows through here; push a back-guard so
        // Android back closes the sheet instead of falling through to nav.
        window.pushOverlayGuard?.();
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
            let collapsedAt = 0;
            // Suppresses scroll-driven header toggles while layout settles.
            let toggleCooldownUntil = 0;

            function handleScroll() {
                if (!scrollBody) return;
                const y = scrollBody.scrollTop;
                const isBrowse = glass.classList.contains('browse-char-modal');

                if (isBrowse && window.getSetting?.('browseSnapSections') !== false) {
                    const hasSnap = scrollBody.classList.contains('snap-active');
                    if (y > 50 && !hasSnap) scrollBody.classList.add('snap-active');
                    else if (y <= 50 && hasSnap) scrollBody.classList.remove('snap-active');
                }

                if (Date.now() < toggleCooldownUntil) {
                    lastScrollY = y;
                    return;
                }

                // No scroll runway: keep the header revealed.
                const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
                if (maxScroll < 80) {
                    if (glass.classList.contains('header-collapsed')) {
                        glass.classList.remove('header-collapsed');
                        toggleCooldownUntil = Date.now() + 250;
                    }
                    lastScrollY = y;
                    return;
                }

                const isCollapsed = glass.classList.contains('header-collapsed');
                const topZone = isCollapsed
                    ? (isBrowse ? 12 : 2)
                    : (isBrowse ? 20 : 10);
                const upDelta = isBrowse ? -3 : -4;

                let changed = false;
                if (y <= topZone) {
                    if (isCollapsed) { glass.classList.remove('header-collapsed'); changed = true; }
                } else if (y > lastScrollY + 2) {
                    if (!isCollapsed) { collapsedAt = Date.now(); glass.classList.add('header-collapsed'); changed = true; }
                } else if (y < lastScrollY + upDelta && Date.now() - collapsedAt > 300) {
                    if (isCollapsed) { glass.classList.remove('header-collapsed'); changed = true; }
                }
                lastScrollY = y;
                if (changed) toggleCooldownUntil = Date.now() + 250;
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

            overlay.addEventListener('click', (e) => {
                if (e.target.closest('.browse-section-inline-toggle, .browse-section-title, .expandable-section-title')) {
                    toggleCooldownUntil = Date.now() + 400;
                    setTimeout(() => {
                        if (!scrollBody) return;
                        const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
                        if (maxScroll < 80) {
                            glass.classList.remove('header-collapsed');
                            lastScrollY = scrollBody.scrollTop;
                        }
                    }, 420);
                }
            }, true);

            new MutationObserver(() => {
                const isOpen = !overlay.classList.contains('hidden');
                if (isOpen) attach();
                else detach();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
            // Already-open modal on a desktop->mobile cross: attach now, no mutation will fire
            if (!overlay.classList.contains('hidden')) attach();
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

        // 32x32 target, so use ST's /thumbnail (96x144) and only fall back to the hero src for blob/data URLs (pending avatar previews where no server thumbnail exists yet).
        const thumbSrcFor = (heroSrc) => {
            if (!heroSrc) return heroSrc;
            const m = /\/characters\/([^?#]+)(\?[^#]*)?/.exec(heroSrc);
            if (!m) return heroSrc;
            // the hero's ?v= cache-bust has to ride as &v= here or ST's thumbnail file param 403s on the stray '?'
            return `/thumbnail?type=avatar&file=${m[1]}${m[2] ? '&' + m[2].slice(1) : ''}`;
        };

        const injectAvatar = () => {
            if (modal.classList.contains('hidden')) return;

            const header = modal.querySelector('.modal-header');
            const modalImg = document.getElementById('modalImage');
            if (!header || !modalImg) return;

            const existing = header.querySelector('.mobile-header-avatar');
            if (existing) {
                // Always update to current character's avatar
                existing.src = thumbSrcFor(modalImg.src);
                return;
            }

            const avatar = document.createElement('img');
            avatar.className = 'mobile-header-avatar';
            avatar.src = thumbSrcFor(modalImg.src);
            avatar.alt = 'Avatar';
            avatar.addEventListener('click', (e) => {
                e.stopPropagation();
                // When edit lock is unlocked, tapping the avatar opens the
                // file picker (matches the desktop hover-overlay behavior).
                if (modal.classList.contains('editing-unlocked')) {
                    const fileInput = document.getElementById('editAvatarFileInput');
                    if (fileInput) {
                        fileInput.click();
                        return;
                    }
                }
                // View mode: open the gallery viewer with the avatar + gallery images, same helper the desktop hover overlay uses.
                const char = window.getActiveChar?.();
                if (char) window.openAvatarInGalleryViewer?.(char);
            });
            // Insert before the title h2
            header.insertBefore(avatar, header.firstChild);
        };

        new MutationObserver(injectAvatar).observe(modal, { attributes: true, attributeFilter: ['class'] });
        // The modal can already be open when crossing into mobile; no class mutation will fire then
        injectAvatar();

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
            } else if (target.id === 'datacatCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                openAvatarViewer(target.src);
            } else if (target.id === 'botbooruCharAvatar') {
                if (target.src.endsWith('/img/ai4.png')) return;
                e.stopPropagation();
                // The browse view stashes the card PNG url on the element
                openAvatarViewer(target.dataset.full || target.src, target.src);
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
       TITLE SCROLL-REVEAL
       ======================================== */
    function setupTitleScrollReveal() {
        function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
        function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

        function wireTitle(titleEl, overlayEl, glassEl) {
            let _anim = null;

            function unwrap() {
                const inner = titleEl.querySelector('.title-scroll-inner');
                if (inner) titleEl.textContent = inner.textContent;
            }

            function cancel() {
                if (!_anim) return;
                cancelAnimationFrame(_anim.raf);
                clearTimeout(_anim.timeout);
                _anim = null;
                unwrap();
                titleEl.classList.remove('title-scrolling', 'title-scroll-start', 'title-scroll-end');
            }

            function animate(inner, from, to, duration, easeFn) {
                return new Promise(resolve => {
                    const t0 = performance.now();
                    function step(now) {
                        if (!_anim) return;
                        const p = Math.min((now - t0) / duration, 1);
                        inner.style.transform = `translateX(${from + (to - from) * easeFn(p)}px)`;
                        if (p < 1) _anim.raf = requestAnimationFrame(step);
                        else resolve();
                    }
                    _anim.raf = requestAnimationFrame(step);
                });
            }

            titleEl.addEventListener('click', async () => {
                if (_anim) { cancel(); return; }

                const distance = titleEl.scrollWidth - titleEl.clientWidth;
                if (distance <= 0) return;

                const inner = document.createElement('span');
                inner.className = 'title-scroll-inner';
                inner.textContent = titleEl.textContent;
                titleEl.textContent = '';
                titleEl.appendChild(inner);

                const speed = 75;
                const fwdMs = Math.max(600, (distance / speed) * 1000);
                const retMs = Math.max(400, fwdMs * 0.6);

                _anim = { raf: 0, timeout: 0 };
                titleEl.classList.add('title-scrolling', 'title-scroll-start');

                await animate(inner, 0, -distance, fwdMs, easeOut);
                if (!_anim) return;

                titleEl.classList.remove('title-scroll-start');
                titleEl.classList.add('title-scroll-end');

                await new Promise(r => { _anim.timeout = setTimeout(r, 1400); });
                if (!_anim) return;

                titleEl.classList.remove('title-scroll-end');

                await animate(inner, -distance, 0, retMs, easeInOut);
                if (_anim) {
                    _anim = null;
                    unwrap();
                    titleEl.classList.remove('title-scrolling');
                }
            });

            if (overlayEl) {
                new MutationObserver(() => {
                    if (overlayEl.classList.contains('hidden')) cancel();
                }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
            }

            if (glassEl) {
                new MutationObserver(() => {
                    if (glassEl.classList.contains('header-collapsed')) cancel();
                }).observe(glassEl, { attributes: true, attributeFilter: ['class'] });
            }
        }

        // charModal
        const charModal = document.getElementById('charModal');
        const modalTitle = document.getElementById('modalTitle');
        if (charModal && modalTitle) {
            wireTitle(modalTitle, charModal, charModal.querySelector('.modal-glass'));
        }

        // chatPreviewModal: same long-title-tap-to-scroll behaviour
        const chatPreviewModal = document.getElementById('chatPreviewModal');
        const chatPreviewTitle = document.getElementById('chatPreviewTitle');
        if (chatPreviewModal && chatPreviewTitle) {
            wireTitle(chatPreviewTitle, chatPreviewModal, chatPreviewModal.querySelector('.modal-glass'));
        }

        // Browse preview modals (lazy discovery)
        const wiredTitles = new WeakSet();
        function scanBrowseTitles() {
            document.querySelectorAll('.modal-overlay').forEach(overlay => {
                const glass = overlay.querySelector('.browse-char-modal');
                if (!glass) return;
                const h2 = glass.querySelector('.browse-char-header-info h2');
                if (!h2 || wiredTitles.has(h2)) return;
                wiredTitles.add(h2);
                wireTitle(h2, overlay, glass);
            });
        }
        scanBrowseTitles();
        new MutationObserver(scanBrowseTitles).observe(document.body, { childList: true });
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

        // iOS multitasking gesture / incoming call cancels touches without firing touchend.
        tabContainer.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       CHAR DETAIL MODAL: PREV/NEXT SWIPE
       Bound to .modal-header only so it doesnt collide with .modal-content-tabs's tab swipe.
       ======================================== */
    function setupCharModalNavSwipe() {
        const modal = document.getElementById('charModal');
        if (!modal) return;
        const header = modal.querySelector('.modal-header');
        if (!header) return;

        let startX = 0, startY = 0, tracking = false, swiping = false;
        const SWIPE_THRESHOLD = 50, LOCK_THRESHOLD = 10;

        function isInteractive(el) {
            return !!(el && el.closest && el.closest('button, input, textarea, select, a, .action-btn, .close-btn'));
        }

        header.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (isInteractive(e.target)) return;
            if (window.getSetting?.('enableCharDetailNav') === false) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            swiping = false;
        }, { passive: true });

        header.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!swiping && Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
            }
            if (swiping) e.preventDefault();
        }, { passive: false });

        header.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!swiping) return;
            const dx = (e.changedTouches[0]?.clientX || 0) - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;
            // Swipe-left goes to NEXT, swipe-right goes to PREVIOUS (standard pager convention).
            window.navigateModal?.(dx < 0 ? 1 : -1);
        }, { passive: true });

        // iOS multitasking gesture / incoming call cancels touches without firing touchend.
        header.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
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

        // iOS may cancel touches mid-swipe (system gestures, calls); reset state.
        body.addEventListener('touchcancel', () => {
            tracking = false;
            swiping = false;
        }, { passive: true });
    }

    /* ========================================
       GALLERY SWIPE NAVIGATION
       ======================================== */
    function setupGallerySwipe() {
        // Wait for the gallery viewer to be injected into the DOM
        // Scan-then-observe: #galleryViewerContent is injected once and never re-added, so a re-cross
        // must wire an already-present viewer immediately, then watch for future injections.
        const scan = () => {
            const content = document.getElementById('galleryViewerContent');
            if (content && !content.dataset.swipeInit) {
                content.dataset.swipeInit = 'true';
                attachSwipeHandlers(content);
            }
        };
        scan();
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
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
        // that navigates prev/next - we must suppress it so pinch/double-tap work.
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
            img.style.transition = 'none';

            // Clear any residual swipe transform on the container
            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'none';
                imageContainer.style.transform = '';
                imageContainer.style.opacity = '';
            }

            if (e.touches.length !== 1) return;

            gestureOccurred = false; // reset - will be set true if finger moves

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

            // Slide the container, dim the image
            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'none';
                imageContainer.style.transform = `translateX(${dx}px)`;
                imageContainer.style.opacity = Math.max(0.6, 1 - Math.abs(dx) / 400);
            }
        }, { passive: false });

        container.addEventListener('touchend', (e) => {
            const img = getImageEl();

            // Pan end - single tap while zoomed resets to 1x
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
            const imageContainer = container.querySelector('.gv-image-container');

            if (swiping && Math.abs(currentX) >= SWIPE_THRESHOLD) {
                const dir = currentX < 0 ? -1 : 1;

                // Animate the container off-screen in the swipe direction
                if (imageContainer) {
                    imageContainer.style.transition = 'transform 0.15s ease-in, opacity 0.15s ease-in';
                    imageContainer.style.transform = `translateX(${dir * 120}px)`;
                    imageContainer.style.opacity = '0';
                }

                // After the exit animation, navigate and slide the new content in
                setTimeout(() => {
                    recentTouch = false;
                    if (currentX < 0 && nextBtn) nextBtn.click();
                    else if (currentX > 0 && prevBtn) prevBtn.click();

                    if (imageContainer) {
                        imageContainer.style.transition = 'none';
                        imageContainer.style.transform = `translateX(${-dir * 80}px)`;
                        imageContainer.style.opacity = '1';
                        requestAnimationFrame(() => {
                            imageContainer.style.transition = 'transform 0.15s ease-out';
                            imageContainer.style.transform = 'translateX(0)';
                        });
                    }
                }, 150);
            } else {
                // Below threshold - snap back
                if (imageContainer) {
                    imageContainer.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
                    imageContainer.style.transform = 'translateX(0)';
                    imageContainer.style.opacity = '1';
                }
            }
            swiping = false;
            // Clear recentTouch after the browser fires its synthetic click
            setTimeout(() => { recentTouch = false; }, 400);
        }, { passive: true });

        // Snap back + reset on iOS system-canceled touches so the image isnt
        // left mid-drag with stale tracking flags.
        container.addEventListener('touchcancel', () => {
            const imageContainer = container.querySelector('.gv-image-container');
            if (imageContainer) {
                imageContainer.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                imageContainer.style.transform = 'translateX(0)';
                imageContainer.style.opacity = '1';
            }
            tracking = false;
            swiping = false;
            isPanning = false;
            recentTouch = false;
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
                // Initial character fetch not done; same gate as view-toggle.
                document.documentElement.classList.contains('cl-initial-loading') ||
                document.querySelector('.modal-overlay:not(.hidden)') ||
                document.querySelector('.cl-modal.visible') ||
                document.querySelector('.confirm-modal:not(.hidden)') ||
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
            if (activeCardSwipe) {
                // Per-card swipe owns horizontal intent on this touch.
                locked = true;
                if (dragging) clearDrag();
                return;
            }
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

            // Defer switchView a frame so the slide-back transition starts before its sync cost lands.
            transitioning = true;
            const startShift = dx < 0 ? '5%' : '-5%';
            surface.style.willChange = 'transform, opacity';
            surface.style.transition = 'none';
            surface.style.transform = `translateX(${startShift})`;
            surface.style.opacity = '0.86';
            void surface.offsetWidth;
            surface.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
            surface.style.transform = 'translateX(0)';
            surface.style.opacity = '1';

            requestAnimationFrame(() => {
                window.switchView(VIEW_ORDER[nextIdx]);
            });

            surface.addEventListener('transitionend', () => {
                surface.style.transition = '';
                clearDrag();
                transitioning = false;
            }, { once: true });
        }, { passive: true });

        // Cancelled touches (iOS multitasking gesture, incoming call) skip
        // touchend; snap back so the surface isnt stuck mid-drag.
        surface.addEventListener('touchcancel', () => {
            if (!active) return;
            active = false;
            locked = false;
            if (dragging) {
                surface.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                clearDrag();
                surface.addEventListener('transitionend', () => { surface.style.transition = ''; }, { once: true });
            }
        }, { passive: true });
    }

    /* ===== RELOCATE FILTER POPUP -> bottom sheet ===== */
    function relocatePopupAsSheet(id, opts = {}) {
        const popup = document.getElementById(id);
        if (!popup || popup.dataset.relocated) return;
        popup.dataset.relocated = 'true';
        document.body.appendChild(popup);
        popup.classList.add('mobile-fixed-popup');

        const scrim = document.createElement('div');
        scrim.className = 'mobile-popup-scrim' + (opts.topScrim ? ' is-top' : '');
        scrim.style.display = 'none';
        document.body.appendChild(scrim);

        const handle = document.createElement('div');
        handle.className = 'mobile-sheet-handle';
        popup.insertBefore(handle, popup.firstChild);

        function close() {
            popup.classList.add('hidden');
            scrim.style.display = 'none';
        }
        scrim.addEventListener('click', close);
        popup._closeFn = close;   // drag-to-dismiss + scrim tap both route here

        const obs = new MutationObserver(() => {
            scrim.style.display = popup.classList.contains('hidden') ? 'none' : 'block';
        });
        obs.observe(popup, { attributes: true, attributeFilter: ['class'] });
    }

    function relocateTagPopup() { relocatePopupAsSheet('tagFilterPopup'); }
    function relocatePlaylistPopup() { relocatePopupAsSheet('playlistFilterPopup'); }
    function relocateAdvFilterPanel() { relocatePopupAsSheet('advFilterPanel', { topScrim: true }); }

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

            addSheetHandle(sheet);

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

    /* ========== BROWSE PREVIEW MODAL: KEBAB / QUICK-IMPORT ========== */
    function setupBrowseModalActionsMenu() {
        let openMenu = null;
        let openTriggerBtn = null;

        function closeMenu() {
            if (!openMenu) return;
            openMenu.remove();
            openMenu = null;
            openTriggerBtn = null;
        }

        function openMenuFor(triggerBtn, controls) {
            closeMenu();

            const menu = document.createElement('div');
            menu.className = 'mobile-more-actions-menu';

            const originals = controls.querySelectorAll(
                '.action-btn:not(.mobile-more-actions-btn)'
            );
            originals.forEach(orig => {
                if (orig.classList.contains('close-btn')) return;

                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'mobile-more-actions-item';
                item.innerHTML = orig.innerHTML;
                item.title = orig.title || orig.getAttribute('aria-label') || '';
                if (orig.disabled || orig.classList.contains('disabled')) {
                    item.disabled = true;
                    item.classList.add('disabled');
                    item.style.opacity = '0.5';
                    item.style.pointerEvents = 'none';
                }
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    closeMenu();
                    orig.click();
                });
                menu.appendChild(item);
            });

            // The favorite heart lives in the header meta line, which is hidden on
            // mobile; providers that support favoriting mark it with .browse-fav-toggle
            const favBtn = controls.closest('.browse-char-modal')?.querySelector('.browse-fav-toggle');
            if (favBtn) {
                const faved = favBtn.classList.contains('favorited');
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'mobile-more-actions-item';
                item.innerHTML = `<i class="fa-${faved ? 'solid' : 'regular'} fa-heart"></i> ${faved ? 'Unfavorite' : 'Favorite'}`;
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    closeMenu();
                    favBtn.click();
                });
                menu.appendChild(item);
            }

            if (!menu.children.length) return;

            document.body.appendChild(menu);
            const rect = triggerBtn.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            let top = rect.bottom + 6;
            if (top + menuRect.height > window.innerHeight - 12) {
                top = Math.max(12, rect.top - menuRect.height - 6);
            }
            let left = rect.right - menuRect.width;
            if (left < 12) left = 12;
            menu.style.top = `${top}px`;
            menu.style.left = `${left}px`;

            openMenu = menu;
            openTriggerBtn = triggerBtn;
        }

        function findPrimarySourceBtn(controls) {
            const candidates = controls.querySelectorAll('.action-btn');
            for (const c of candidates) {
                if (/(?:Download|Import|Extract)Btn$/i.test(c.id || '')) return c;
            }
            for (const c of candidates) {
                if (!c.classList.contains('secondary')) return c;
            }
            return null;
        }

        function syncQuickImportState(quickBtn, sourceBtn) {
            if (!sourceBtn) {
                quickBtn.setAttribute('data-state', 'primary');
                quickBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
                quickBtn.disabled = false;
                return;
            }
            let state = 'primary';
            if (sourceBtn.classList.contains('warning')) state = 'warning';
            else if (sourceBtn.classList.contains('secondary')) state = 'secondary';
            quickBtn.setAttribute('data-state', state);
            const icon = sourceBtn.querySelector('i');
            if (icon) {
                quickBtn.innerHTML = '';
                const clone = icon.cloneNode(true);
                clone.removeAttribute('style');
                quickBtn.appendChild(clone);
            } else {
                quickBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
            }
            quickBtn.disabled = !!sourceBtn.disabled;
            const title = sourceBtn.title || sourceBtn.textContent.trim();
            if (title) quickBtn.title = title.replace(/\s+/g, ' ');
        }

        function injectKebabIntoModal(modal) {
            const controls = modal.querySelector('.modal-controls');
            if (!controls) return;

            if (!controls.querySelector('.mobile-more-actions-btn')) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mobile-more-actions-btn';
                btn.setAttribute('aria-label', 'More actions');
                btn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';

                const closeBtn = controls.querySelector('.close-btn');
                if (closeBtn) controls.insertBefore(btn, closeBtn);
                else controls.appendChild(btn);

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (openTriggerBtn === btn) closeMenu();
                    else openMenuFor(btn, controls);
                });
            }

            if (!controls.querySelector('.mobile-quick-import-btn')) {
                const sourceBtn = findPrimarySourceBtn(controls);
                const quickBtn = document.createElement('button');
                quickBtn.type = 'button';
                quickBtn.className = 'mobile-quick-import-btn';
                quickBtn.setAttribute('aria-label', 'Import');
                syncQuickImportState(quickBtn, sourceBtn);

                const closeBtn = controls.querySelector('.close-btn');
                if (closeBtn) controls.insertBefore(quickBtn, closeBtn);
                else controls.appendChild(quickBtn);

                quickBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Re-find each click; providers swap source-btn class on state change (ie. in-library)
                    const src = findPrimarySourceBtn(controls);
                    src?.click();
                });

                if (sourceBtn) {
                    new MutationObserver(() => {
                        const src = findPrimarySourceBtn(controls);
                        syncQuickImportState(quickBtn, src);
                    }).observe(sourceBtn, {
                        attributes: true,
                        attributeFilter: ['class', 'disabled', 'title'],
                        childList: true,
                        subtree: true,
                    });
                }
            }
        }

        /* Identity mirror: the header meta line (creator / uploader) is display:none
           on mobile, so elements marked .browse-meta-identity get mirrored into the
           stats block as mobile-only rows (CSS hides them on desktop). The mirror
           re-syncs on meta mutations since providers populate it async, and taps
           proxy to the original element so each provider's own handler runs. */
        const mirrorArmed = new WeakSet(); // per-session: re-setup after teardown re-arms

        function syncIdentityMirror(modal) {
            const meta = modal.querySelector('.browse-char-meta');
            const stats = modal.querySelector('.browse-char-stats');
            if (!meta || !stats) return;
            stats.querySelectorAll('.browse-stat-identity').forEach(n => n.remove());
            meta.querySelectorAll('.browse-meta-identity').forEach(src => {
                const name = (src.textContent || '').trim();
                if (!name) return;
                // Providers toggle identity rows via inline display on a wrapper span
                for (let el = src; el && el !== meta; el = el.parentElement) {
                    if (el.style?.display === 'none') return;
                }
                const stat = document.createElement('div');
                stat.className = 'browse-stat browse-stat-identity';
                stat.title = src.title || 'Creator';
                const icon = document.createElement('i');
                icon.className = src.dataset.identityIcon || 'fa-solid fa-user-pen';
                const label = document.createElement('span');
                label.textContent = name;
                stat.append(icon, label);
                stat.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    src.click();
                });
                stats.appendChild(stat);
            });
        }

        function armIdentityMirror(modal) {
            if (!modal.querySelector('.browse-meta-identity')) return;
            if (mirrorArmed.has(modal)) return;
            mirrorArmed.add(modal);
            const meta = modal.querySelector('.browse-char-meta');
            if (!meta) return;
            let queued = false;
            const queue = () => {
                if (queued) return;
                queued = true;
                requestAnimationFrame(() => { queued = false; syncIdentityMirror(modal); });
            };
            new MutationObserver(queue).observe(meta, {
                childList: true,
                characterData: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'title'],
            });
            syncIdentityMirror(modal);
        }

        function scan() {
            document.querySelectorAll('.browse-char-modal').forEach(m => {
                injectKebabIntoModal(m);
                armIdentityMirror(m);
            });
        }

        scan();
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('.browse-char-modal')) { injectKebabIntoModal(node); armIdentityMirror(node); }
                    node.querySelectorAll?.('.browse-char-modal').forEach(n => { injectKebabIntoModal(n); armIdentityMirror(n); });
                }
            }
        }).observe(document.body, { childList: true, subtree: true });

        document.addEventListener('click', (e) => {
            if (!openMenu) return;
            if (openMenu.contains(e.target)) return;
            if (e.target === openTriggerBtn || openTriggerBtn?.contains(e.target)) return;
            closeMenu();
        }, true);

        const modalClassObs = new MutationObserver(() => {
            if (!openMenu) return;
            const overlay = openTriggerBtn?.closest('.modal-overlay');
            if (overlay && overlay.classList.contains('hidden')) closeMenu();
        });
        document.querySelectorAll('.modal-overlay').forEach(o => {
            modalClassObs.observe(o, { attributes: true, attributeFilter: ['class'] });
        });
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('.modal-overlay')) {
                        modalClassObs.observe(node, { attributes: true, attributeFilter: ['class'] });
                    }
                }
            }
        }).observe(document.body, { childList: true });
    }

    /* ========================================
       CONTEXT MENU → BOTTOM SHEET
       ======================================== */
    function setupContextMenu() {
        // Long-press fires 'contextmenu' → module renders its popup; we hijack it into a bottom sheet.

        let ctxSheet = null; // { overlay, sheet, close } from createBottomSheet, reused

        function showCtxSheet(menuEl) {
            if (!ctxSheet) {
                ctxSheet = createBottomSheet();
                document.body.appendChild(ctxSheet.overlay);
            }
            const { overlay, sheet, close } = ctxSheet;
            sheet.innerHTML = '';

            addSheetHandle(sheet);

            const children = Array.from(menuEl.children);
            const clones = children.map(child => {
                const clone = child.cloneNode(true);
                if (child.classList.contains('cl-context-menu-item') && !child.classList.contains('disabled')) {
                    clone.addEventListener('click', () => { close(); child.click(); });
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

            clones.forEach(c => { delete c._origChild; sheet.appendChild(c); });

            openSheet(overlay, sheet);
        }

        // After the desktop context menu module renders and shows its popup,
        // we detect that via MutationObserver and hijack it.
        const waitForMenu = () => {
            const menuEl = document.getElementById('clContextMenu');
            if (!menuEl) {
                // Not created yet, keep watching
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
                // Check mode at event time: this observer can outlive a flip to desktop and must no-op there.
                if (!isMobile()) return;
                if (menuEl.classList.contains('visible')) {
                    menuEl.classList.remove('visible');
                    showCtxSheet(menuEl);
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
        const root = document.documentElement;
        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            document.head.appendChild(viewport);
        }
        // Capture prior inline styles so teardown lets desktop scroll again. (The viewport meta baseline
        // is captured in runMobile, before fixViewport touches it.)
        if (mobileLive) {
            const prev = {
                rOX: root.style.overflowX, bOX: document.body.style.overflowX,
                rMW: root.style.maxWidth, bMW: document.body.style.maxWidth,
            };
            mobileLive.restore.push(() => {
                root.style.overflowX = prev.rOX; document.body.style.overflowX = prev.bOX;
                root.style.maxWidth = prev.rMW; document.body.style.maxWidth = prev.bMW;
            });
        }
        // Prevent horizontal scrolling + lock scale on mobile
        root.style.overflowX = 'hidden';
        document.body.style.overflowX = 'hidden';
        root.style.maxWidth = '100vw';
        document.body.style.maxWidth = '100vw';
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
        const live = mobileLive; // register both timers into the session so teardown clears them
        const fastSweep = setInterval(() => {
            sweep();
            if (++sweepCount >= 20) { // 20 × 500ms = 10s
                clearInterval(fastSweep);
                const slow = setInterval(sweep, 3000); // then every 3s
                if (live) live.timers.push(slow);
            }
        }, 500);
        if (live) live.timers.push(fastSweep);
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
    }

    /* ========================================
       GALLERY SYNC DROPDOWN
       The sync container is hidden on mobile (display:none).
       Move the dropdown to body and manage it with a scrim
       overlay so it displays as a bottom-sheet-style panel.
       ======================================== */
    function setupGallerySyncDropdown() {
        const dropdown = document.getElementById('notificationsDropdown');
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

        // The notifications shell renders every visible section (gallery sync
        // audit included); fall back to a bare un-hide if it isnt loaded yet
        if (typeof window.openNotificationsDropdown === 'function') {
            window.openNotificationsDropdown();
        } else {
            dropdown.classList.remove('hidden');
        }
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
            // Sync once for a modal already open at cross time (no mutation fires for it)
            if (!charModal.classList.contains('hidden')) {
                const tags = typeof getCurrentTagsArray === 'function' ? getCurrentTagsArray() : [];
                renderEditTagsPreview(tags);
                const btn = document.getElementById('editTagsBtn');
                if (btn) btn.disabled = !document.querySelector('.edit-lock-header.unlocked');
            }
        }
    }

})();
