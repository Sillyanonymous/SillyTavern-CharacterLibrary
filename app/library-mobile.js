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
        setupContextMenu();
        setupViewportFix();
        relocateTagPopup();
        fixInitialGridRender();
        setDefaultExpandZoom();
        setupLorebookModalToolbar();
        fixInvalidDateText();
        setupChubFilterArea();
        setupGallerySyncDropdown();
        fixRefreshLoadingStuck();
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
        const realFavBtn = document.getElementById('favoritesFilterBtn');
        if (realFavBtn && realFavBtn.classList.contains('active')) favChip.classList.add('active');
        favChip.addEventListener('click', () => {
            if (realFavBtn) {
                realFavBtn.click();
                setTimeout(() => favChip.classList.toggle('active', realFavBtn.classList.contains('active')), 50);
            }
        });

        const tagChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        tagChip.addEventListener('click', () => {
            const tagBtn = document.getElementById('tagFilterBtn');
            if (tagBtn) { close(); setTimeout(() => tagBtn.click(), 300); }
        });

        filterRow.appendChild(favChip);
        filterRow.appendChild(tagChip);
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
            const r = document.getElementById('refreshBtn');
            if (r) r.click();
            close();
        });
        charRefresh.appendChild(charRefreshBtn);
        charSection.appendChild(charRefresh);

        // ===== CHUBAI SECTION =====
        const chubSection = document.createElement('div');
        chubSection.className = 'mobile-settings-view-section';
        chubSection.dataset.view = 'chub';
        body.appendChild(chubSection);

        // Mode toggle (Browse / Following)
        const modeSection = createSection('Mode');
        const modeRow = document.createElement('div');
        modeRow.className = 'mobile-settings-row';

        const browseChip = createChip('<i class="fa-solid fa-compass"></i> Browse');
        const followChip = createChip('<i class="fa-solid fa-users"></i> Following');
        browseChip.classList.add('active');

        function syncChubMode() {
            const realBtns = document.querySelectorAll('.chub-view-btn');
            realBtns.forEach(b => {
                if (b.dataset.chubView === 'browse') {
                    browseChip.classList.toggle('active', b.classList.contains('active'));
                } else if (b.dataset.chubView === 'timeline') {
                    followChip.classList.toggle('active', b.classList.contains('active'));
                }
            });
        }

        function syncChubSort() {
            const isFollowing = followChip.classList.contains('active');
            chubBrowseSortSelect.style.display = isFollowing ? 'none' : '';
            chubFollowSortSelect.style.display = isFollowing ? '' : 'none';
        }

        browseChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.chub-view-btn[data-chub-view="browse"]');
            if (realBtn) { realBtn.click(); setTimeout(() => { syncChubMode(); syncChubSort(); }, 100); }
        });
        followChip.addEventListener('click', () => {
            const realBtn = document.querySelector('.chub-view-btn[data-chub-view="timeline"]');
            if (realBtn) { realBtn.click(); setTimeout(() => { syncChubMode(); syncChubSort(); }, 100); }
        });

        modeRow.appendChild(browseChip);
        modeRow.appendChild(followChip);
        modeSection.appendChild(modeRow);
        chubSection.appendChild(modeSection);

        // Sort — two selects: Browse preset + Following sort, toggled by mode
        const chubSortSection = createSection('Sort By');

        const chubBrowseSortSelect = document.createElement('select');
        chubBrowseSortSelect.className = 'mobile-settings-select';
        const realChubSort = document.getElementById('chubDiscoveryPreset');
        if (realChubSort) {
            chubBrowseSortSelect.innerHTML = realChubSort.innerHTML;
            chubBrowseSortSelect.value = realChubSort.value;
            chubBrowseSortSelect.addEventListener('change', () => {
                realChubSort.value = chubBrowseSortSelect.value;
                realChubSort.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        chubSortSection.appendChild(chubBrowseSortSelect);

        const chubFollowSortSelect = document.createElement('select');
        chubFollowSortSelect.className = 'mobile-settings-select';
        chubFollowSortSelect.style.display = 'none';
        const realTimelineSort = document.getElementById('chubTimelineSortHeader');
        if (realTimelineSort) {
            Array.from(realTimelineSort.options).forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.textContent;
                o.selected = opt.selected;
                chubFollowSortSelect.appendChild(o);
            });
            chubFollowSortSelect.addEventListener('change', () => {
                realTimelineSort.value = chubFollowSortSelect.value;
                realTimelineSort.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        chubSortSection.appendChild(chubFollowSortSelect);
        chubSection.appendChild(chubSortSection);

        // Filters row (Tags, Features, NSFW)
        const chubFilterSection = createSection('Filters');
        const chubFilterRow = document.createElement('div');
        chubFilterRow.className = 'mobile-settings-row';
        chubFilterRow.style.flexWrap = 'wrap';

        const chubTagsChip = createChip('<i class="fa-solid fa-tags"></i> Tags');
        chubTagsChip.addEventListener('click', () => {
            const realBtn = document.getElementById('chubTagsBtn');
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const chubFeaturesChip = createChip('<i class="fa-solid fa-sliders"></i> Features');
        chubFeaturesChip.addEventListener('click', () => {
            const realBtn = document.getElementById('chubFiltersBtn');
            if (realBtn) { close(); setTimeout(() => realBtn.click(), 300); }
        });

        const chubNsfwChip = createChip('<i class="fa-solid fa-shield-halved"></i> SFW Only');
        function syncNsfwState() {
            const realBtn = document.getElementById('chubNsfwToggle');
            if (realBtn) {
                const span = realBtn.querySelector('span');
                const label = span ? span.textContent.trim() : 'SFW Only';
                chubNsfwChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + label;
                chubNsfwChip.classList.toggle('active', realBtn.classList.contains('active'));
            }
        }
        chubNsfwChip.addEventListener('click', () => {
            const realBtn = document.getElementById('chubNsfwToggle');
            if (realBtn) { realBtn.click(); setTimeout(syncNsfwState, 100); }
        });

        chubFilterRow.appendChild(chubTagsChip);
        chubFilterRow.appendChild(chubFeaturesChip);
        chubFilterRow.appendChild(chubNsfwChip);
        chubFilterSection.appendChild(chubFilterRow);
        chubSection.appendChild(chubFilterSection);

        // Account + Refresh row
        const chubActionsSection = createSection('');
        const chubActionsRow = document.createElement('div');
        chubActionsRow.className = 'mobile-settings-row';

        const chubLoginChip = createChip('<i class="fa-solid fa-user-circle"></i> Login');
        chubLoginChip.addEventListener('click', () => {
            const realBtn = document.getElementById('chubLoginBtn');
            if (realBtn) { realBtn.click(); close(); }
        });

        const chubRefreshChip = createChip('<i class="fa-solid fa-sync"></i> Refresh');
        chubRefreshChip.addEventListener('click', () => {
            const realBtn = document.getElementById('refreshChubBtn');
            if (realBtn) { realBtn.click(); close(); }
        });

        chubActionsRow.appendChild(chubLoginChip);
        chubActionsRow.appendChild(chubRefreshChip);
        chubActionsSection.appendChild(chubActionsRow);
        chubSection.appendChild(chubActionsSection);

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
            if (activeView === 'chub') {
                syncChubMode();
                syncNsfwState();
                syncChubSort();
                if (realChubSort) chubBrowseSortSelect.value = realChubSort.value;
                if (realTimelineSort) chubFollowSortSelect.value = realTimelineSort.value;
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
        const chubView = document.getElementById('chubView');
        const chatsView = document.getElementById('chatsView');
        if (chubView && !chubView.classList.contains('hidden')) return 'chub';
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
            sheet.appendChild(syncItem);
        }

        btn.addEventListener('click', () => openSheet(overlay, sheet));
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
            // Insert before the title h2
            header.insertBefore(avatar, header.firstChild);
        });

        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
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

        // Pinch zoom state
        let lastPinchDist = 0;
        let isPinching = false;
        let pinchMidX = 0, pinchMidY = 0;

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

        function pinchDist(t) {
            const dx = t[0].clientX - t[1].clientX;
            const dy = t[0].clientY - t[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        container.addEventListener('touchstart', (e) => {
            recentTouch = true;
            const img = getImageEl();
            if (!img) return;
            img.style.transition = '';

            if (e.touches.length === 2) {
                // Pinch start
                isPinching = true;
                tracking = false;
                swiping = false;
                gestureOccurred = true;
                lastPinchDist = pinchDist(e.touches);
                pinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                pinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                return;
            }

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

            // Pinch zoom — incremental per-frame
            if (isPinching && e.touches.length === 2) {
                e.preventDefault();
                const dist = pinchDist(e.touches);
                if (lastPinchDist > 0 && dist > 0) {
                    const frameRatio = dist / lastPinchDist;
                    // Dampen: only apply 30% of the per-frame delta
                    const dampened = 1 + (frameRatio - 1) * 0.3;
                    const curScale = getZoom();
                    const newScale = Math.max(1, Math.min(3, curScale * dampened));
                    setTransform(img, newScale, panX, panY);
                    showZoom(newScale);
                }
                lastPinchDist = dist;
                return;
            }

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
                setTransform(img, curZoom, imgPanStartX + dx / curZoom, imgPanStartY + dy / curZoom);
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

            // Pinch end
            if (isPinching) {
                isPinching = false;
                lastPinchDist = 0;
                if (img) {
                    const z = getZoom();
                    if (z < 1.05) resetTransform(img);
                }
                return;
            }

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
       RELOCATE TAG POPUP
       Move #tagFilterPopup out of hidden .filter-area
       and add a scrim + close mechanism
       ======================================== */
    function relocateTagPopup() {
        const popup = document.getElementById('tagFilterPopup');
        if (!popup) return;

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
            Array.from(menuEl.children).forEach(child => {
                const clone = child.cloneNode(true);
                // Re-attach click handler for action items
                if (child.classList.contains('cl-context-menu-item') && !child.classList.contains('disabled')) {
                    clone.addEventListener('click', () => {
                        closeSheet();
                        child.click(); // Trigger the original handler
                    });
                }
                sheetEl.appendChild(clone);
            });

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
       FIX: INITIAL GRID RENDER
       Force virtual scroll recalculation after first cards appear
       so the real cardHeight is used instead of fallback 300px
       ======================================== */
    function fixInitialGridRender() {
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        // Wait for actual cards to appear, then force recalc
        const observer = new MutationObserver(() => {
            const card = document.querySelector('.char-card');
            if (card) {
                observer.disconnect();
                // Small delay to ensure browser has laid out the card
                setTimeout(() => {
                    // Dispatch a resize to clear cached dimensions and re-render
                    window.dispatchEvent(new Event('resize'));
                }, 50);
            }
        });
        const grid = document.getElementById('characterGrid');
        if (grid) {
            observer.observe(grid, { childList: true, subtree: true });
        }
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
       CHUB FILTER AREA SETUP
       Move dropdowns out of scrollable filter strip
       and manage topbar wrapping class
       ======================================== */
    function setupChubFilterArea() {
        const topbar = document.querySelector('.topbar');
        const chubFilters = document.getElementById('chubFilterArea');
        if (!topbar || !chubFilters) return;

        // Move fixed-position dropdowns to body so they aren't
        // clipped by the filter strip's overflow-x: auto
        const tagsDropdown = document.getElementById('chubTagsDropdown');
        const filtersDropdown = document.getElementById('chubFiltersDropdown');
        if (tagsDropdown) document.body.appendChild(tagsDropdown);
        if (filtersDropdown) document.body.appendChild(filtersDropdown);

        // Toggle topbar wrapping when ChubAI filter area is visible
        function syncTopbar() {
            const visible = chubFilters.style.display && chubFilters.style.display !== 'none';
            topbar.classList.toggle('chub-active', visible);
        }

        new MutationObserver(syncTopbar).observe(chubFilters, {
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
        setTimeout(() => {
            try {
                if (typeof window.auditGalleryIntegrity === 'function') {
                    const audit = window.auditGalleryIntegrity();
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

})();
