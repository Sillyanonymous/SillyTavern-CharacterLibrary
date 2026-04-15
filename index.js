const EXTENSION_NAME = "Character Library";
const EXTENSION_DIR = "SillyTavern-CharacterLibrary";
const CL_SETTINGS_KEY = 'SillyTavernCharacterGallery';

// Helper to get the correct path for this extension
function getExtensionUrl() {
    // Try to find the script tag that loaded this extension to get the base path
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.includes(EXTENSION_DIR)) {
            const path = scripts[i].src;
            // Return the directory containing index.js
            return path.substring(0, path.lastIndexOf('/'));
        }
    }
    // Fallback if script tag search fails (e.g. if loaded via eval or blob)
    return `scripts/extensions/third-party/${EXTENSION_DIR}`;
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

let _csrfToken = null;

async function getCsrfToken() {
    try {
        const response = await fetch('/csrf-token');
        if (response.ok) {
            const data = await response.json();
            return data.token;
        }
    } catch (e) {
        console.error('Failed to fetch CSRF token', e);
    }
    return getCookie('X-CSRF-Token');
}

// Pre-fetch at load time — token is stable for the session
getCsrfToken().then(t => { _csrfToken = t; });

// ==============================================
// Display Mode Setting
// ==============================================

function getDisplayMode() {
    try {
        const context = SillyTavern?.getContext?.();
        return context?.extensionSettings?.[CL_SETTINGS_KEY]?.displayMode || 'tab';
    } catch { return 'tab'; }
}

function setDisplayMode(mode) {
    try {
        const context = SillyTavern?.getContext?.();
        if (!context?.extensionSettings) return;
        if (!context.extensionSettings[CL_SETTINGS_KEY]) {
            context.extensionSettings[CL_SETTINGS_KEY] = {};
        }
        context.extensionSettings[CL_SETTINGS_KEY].displayMode = mode;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Failed to save display mode:`, e);
    }
}

function getLaunchOnBoot() {
    try {
        const context = SillyTavern?.getContext?.();
        return context?.extensionSettings?.[CL_SETTINGS_KEY]?.launchOnBoot === true;
    } catch { return false; }
}

function setLaunchOnBoot(enabled) {
    try {
        const context = SillyTavern?.getContext?.();
        if (!context?.extensionSettings) return;
        if (!context.extensionSettings[CL_SETTINGS_KEY]) {
            context.extensionSettings[CL_SETTINGS_KEY] = {};
        }
        context.extensionSettings[CL_SETTINGS_KEY].launchOnBoot = enabled;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Failed to save launchOnBoot:`, e);
    }
}

function getShowTopBar() {
    try {
        const context = SillyTavern?.getContext?.();
        return context?.extensionSettings?.[CL_SETTINGS_KEY]?.showTopBar === true;
    } catch { return false; }
}

function shouldHideTopBar() {
    return !getShowTopBar();
}

function setShowTopBar(enabled) {
    try {
        const context = SillyTavern?.getContext?.();
        if (!context?.extensionSettings) return;
        if (!context.extensionSettings[CL_SETTINGS_KEY]) {
            context.extensionSettings[CL_SETTINGS_KEY] = {};
        }
        context.extensionSettings[CL_SETTINGS_KEY].showTopBar = enabled;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Failed to save showTopBar:`, e);
    }
}

function getShowDropdownInEmbedded() {
    try {
        const context = SillyTavern?.getContext?.();
        return context?.extensionSettings?.[CL_SETTINGS_KEY]?.showDropdownInEmbedded === true;
    } catch { return false; }
}

function setShowDropdownInEmbedded(enabled) {
    try {
        const context = SillyTavern?.getContext?.();
        if (!context?.extensionSettings) return;
        if (!context.extensionSettings[CL_SETTINGS_KEY]) {
            context.extensionSettings[CL_SETTINGS_KEY] = {};
        }
        context.extensionSettings[CL_SETTINGS_KEY].showDropdownInEmbedded = enabled;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Failed to save showDropdownInEmbedded:`, e);
    }
}

function getExclusivePanes() {
    try {
        const context = SillyTavern?.getContext?.();
        return context?.extensionSettings?.[CL_SETTINGS_KEY]?.exclusivePanes === true;
    } catch { return false; }
}

function setExclusivePanes(enabled) {
    try {
        const context = SillyTavern?.getContext?.();
        if (!context?.extensionSettings) return;
        if (!context.extensionSettings[CL_SETTINGS_KEY]) {
            context.extensionSettings[CL_SETTINGS_KEY] = {};
        }
        context.extensionSettings[CL_SETTINGS_KEY].exclusivePanes = enabled;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Failed to save exclusivePanes:`, e);
    }
}

function migrateSettings() {
    try {
        const context = SillyTavern?.getContext?.();
        const settings = context?.extensionSettings?.[CL_SETTINGS_KEY];
        if (!settings) return;
        if ('hideTopBar' in settings) {
            settings.showTopBar = !settings.hideTopBar;
            delete settings.hideTopBar;
            if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
        }
    } catch { /* not critical */ }
}

// ==============================================
// Embedded Iframe Management
// ==============================================

let _iframeContainer = null;
let _iframe = null;
let _embeddedVisible = false;

function isEmbeddedActive() {
    return _embeddedVisible;
}

function buildIframeUrl() {
    const baseUrl = getExtensionUrl();
    const token = _csrfToken || '';
    let url = `${baseUrl}/app/library.html?csrf=${encodeURIComponent(token)}&embedded=1`;
    if (getShowTopBar()) url += '&showTopBar=1';
    return url;
}

function createEmbeddedContainer() {
    if (_iframeContainer) return;

    const container = document.createElement('div');
    container.id = 'charlib-embedded-container';
    Object.assign(container.style, {
        position: 'fixed',
        top: 'var(--topBarBlockSize, 37px)',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '2999',
        display: 'none',
        background: '#1a1a2e',
    });

    const iframe = document.createElement('iframe');
    iframe.id = 'charlib-embedded-iframe';
    iframe.src = buildIframeUrl();
    iframe.setAttribute('allow', 'clipboard-write');
    Object.assign(iframe.style, {
        width: '100%',
        height: '100%',
        border: 'none',
    });

    container.appendChild(iframe);
    document.body.appendChild(container);

    _iframeContainer = container;
    _iframe = iframe;
}

function closeAllSTDrawers() {
    const sheld = document.getElementById('sheld');
    if (sheld) sheld.click();

    // Some top-bar panes are not tied to #sheld and track state via openDrawer.
    // Toggle any open pane controls off so embedded CL becomes exclusive.
    const openPaneControls = document.querySelectorAll(
        '#top-bar .openDrawer.interactable, #top-settings-holder .openDrawer.interactable, #top-bar .menu_button.openDrawer, #top-settings-holder .menu_button.openDrawer'
    );
    openPaneControls.forEach((el) => {
        if (typeof el.click === 'function') el.click();
    });

    // Final fallback for panes that listen to Escape for close.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function showEmbedded() {
    if (!_iframeContainer) createEmbeddedContainer();
    if (getExclusivePanes()) closeAllSTDrawers();
    _iframeContainer.style.display = 'block';
    _embeddedVisible = true;
    if (shouldHideTopBar()) {
        _iframeContainer.style.top = '0';
        _iframeContainer.style.height = '100dvh';
        for (const id of ['top-bar', 'top-settings-holder']) {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        }
    } else {
        _iframeContainer.style.top = 'var(--topBarBlockSize, 37px)';
        _iframeContainer.style.height = 'calc(100dvh - var(--topBarBlockSize, 37px))';
    }
}

function hideEmbedded() {
    if (!_iframeContainer) return;
    _iframeContainer.style.display = 'none';
    _embeddedVisible = false;
    _iframeContainer.style.top = 'var(--topBarBlockSize, 37px)';
    _iframeContainer.style.height = '';
    for (const id of ['top-bar', 'top-settings-holder']) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    }
}

let _exclusivePanesObserver = null;

function setupExclusivePanesWatcher() {
    if (_exclusivePanesObserver) return;
    _exclusivePanesObserver = new MutationObserver((mutations) => {
        if (!isEmbeddedActive() || !getExclusivePanes()) return;
        for (const m of mutations) {
            if (m.target.id && m.target.classList?.contains('openDrawer')) {
                hideEmbedded();
                return;
            }
        }
    });
    _exclusivePanesObserver.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });
}

function toggleEmbedded() {
    if (_embeddedVisible) {
        hideEmbedded();
    } else {
        showEmbedded();
    }
}

// ==============================================
// PostMessage Bridge (CL iframe -> ST)
// ==============================================

function setupPostMessageBridge() {
    window.addEventListener('message', async (e) => {
        if (e.origin !== window.location.origin) return;
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || msg.source !== 'character-library') return;

        switch (msg.type) {
            case 'cl-close': {
                hideEmbedded();
                break;
            }
            case 'cl-open-character': {
                if (!msg.avatar) break;
                hideEmbedded();
                try {
                    const context = SillyTavern?.getContext?.();
                    if (!context) break;
                    const idx = (context.characters || []).findIndex(c => c.avatar === msg.avatar);
                    if (idx !== -1 && typeof context.selectCharacterById === 'function') {
                        await context.selectCharacterById(idx);
                    }
                } catch (err) {
                    console.error(`${EXTENSION_NAME}: Failed to open character:`, err);
                }
                break;
            }
        }
    });
}

// ==============================================
// Open Gallery (branches on display mode)
// ==============================================

function openGallery() {
    const mode = getDisplayMode();

    if (mode === 'embedded') {
        toggleEmbedded();
        return;
    }

    // Default: new tab
    const baseUrl = getExtensionUrl();
    if (_csrfToken) {
        const url = `${baseUrl}/app/library.html?csrf=${encodeURIComponent(_csrfToken)}`;
        window.open(url, '_blank');
        return;
    }
    // Token not yet available (rare)
    const tab = window.open('about:blank', '_blank');
    if (tab) {
        try {
            tab.document.open();
            tab.document.write(
                '<html><head><title>Character Library</title>' +
                '<style>body{margin:0;background:#1a1a2e;display:flex;align-items:center;' +
                'justify-content:center;height:100vh;font-family:system-ui,sans-serif}' +
                '.s{color:rgba(255,255,255,.45);font-size:14px;display:flex;align-items:center;gap:10px}' +
                '.s::before{content:"";width:18px;height:18px;border:2px solid rgba(255,255,255,.15);' +
                'border-top-color:rgba(255,255,255,.5);border-radius:50%;' +
                'animation:r .7s linear infinite}' +
                '@keyframes r{to{transform:rotate(360deg)}}</style></head>' +
                '<body><div class="s">Loading…</div></body></html>'
            );
            tab.document.close();
        } catch { /* cross-origin write blocked */ }
    }
    getCsrfToken().then(token => {
        _csrfToken = token;
        const url = `${baseUrl}/app/library.html?csrf=${encodeURIComponent(token)}`;
        if (tab) {
            tab.location.href = url;
        } else {
            window.open(url, '_blank');
        }
    });
}

// ==============================================
// Launcher Dropdown — hijacks ST's Characters button, offers both native characters and characterlibrary options
// ==============================================

function injectLauncherStyles() {
    if (document.getElementById('charlib-launcher-styles')) return;
    const style = document.createElement('style');
    style.id = 'charlib-launcher-styles';
    style.textContent = `
        /* ---- Embedded container mobile override ---- */
        @media screen and (max-width: 1000px) {
            #charlib-embedded-container {
                left: 0 !important;
                right: 0 !important;
                width: 100vw !important;
            }
        }
        /* ---- Launcher dropdown ---- */
        .charlib-launcher-dropdown {
            position: fixed;
            z-index: 30000;
            min-width: 210px;
            background: var(--SmartThemeBlurTintColor, rgba(20, 22, 28, 0.95));
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.55);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            padding: 6px;
            opacity: 0;
            transform: translateY(-8px) scale(0.96);
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .charlib-launcher-dropdown.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }
        .charlib-launcher-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 7px;
            cursor: pointer;
            color: var(--SmartThemeBodyColor, #dcdfe4);
            font-size: 13.5px;
            font-family: inherit;
            transition: background 0.14s ease;
            user-select: none;
            white-space: nowrap;
        }
        .charlib-launcher-item:hover {
            background: rgba(255,255,255,0.08);
        }
        .charlib-launcher-item:active {
            background: rgba(255,255,255,0.13);
        }
        .charlib-launcher-item i {
            width: 20px;
            text-align: center;
            font-size: 15px;
            opacity: 0.85;
        }
        .charlib-launcher-item[data-action="library"] i {
            color: var(--SmartThemeQuoteColor, #b4a0ff);
        }
        .charlib-launcher-divider {
            height: 1px;
            margin: 4px 8px;
            background: rgba(255,255,255,0.08);
        }
        /* Small chevron badge on the Characters icon */
        .charlib-chevron-badge {
            position: absolute;
            bottom: 2px;
            right: 0px;
            font-size: 7px;
            opacity: 0.5;
            pointer-events: none;
            color: var(--SmartThemeBodyColor, #dcdfe4);
        }
        /* Scrim overlay */
        .charlib-launcher-scrim {
            position: fixed;
            inset: 0;
            z-index: 29999;
            display: none;
        }
        .charlib-launcher-scrim.visible {
            display: block;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Attempt to hijack ST's Characters button with a launcher dropdown.
 * Returns true if successful, false if the Characters button wasn't found.
 */
function setupLauncherDropdown() {
    const drawerToggle = document.getElementById('unimportantYes');
    const drawerIcon = document.getElementById('rightNavDrawerIcon');

    if (!drawerToggle || !drawerIcon) {
        console.warn(`${EXTENSION_NAME}: Characters button not found, falling back to standalone button`);
        return false;
    }

    injectLauncherStyles();

    // ---- Build dropdown DOM ----
    const dropdown = document.createElement('div');
    dropdown.id = 'charlib-launcher-dropdown';
    dropdown.className = 'charlib-launcher-dropdown';
    dropdown.innerHTML = `
        <div class="charlib-launcher-item" data-action="native">
            <i class="fa-solid fa-address-card"></i>
            <span>Character Management</span>
        </div>
        <div class="charlib-launcher-divider"></div>
        <div class="charlib-launcher-item" data-action="library">
            <i class="fa-solid fa-photo-film"></i>
            <span>Character Library</span>
        </div>
    `;

    const scrim = document.createElement('div');
    scrim.className = 'charlib-launcher-scrim';

    document.body.appendChild(scrim);
    document.body.appendChild(dropdown);

    // ---- Add chevron indicator to the icon (tab mode only) ----
    if (getComputedStyle(drawerIcon).position === 'static') {
        drawerIcon.style.position = 'relative';
    }
    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-caret-down charlib-chevron-badge';
    if (getDisplayMode() === 'embedded' && !getShowDropdownInEmbedded()) {
        chevron.style.display = 'none';
    }
    drawerIcon.appendChild(chevron);

    // ---- State ----
    let isOpen = false;
    let bypassIntercept = false;

    function positionDropdown() {
        const rect = drawerIcon.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 6) + 'px';
        // Right-align so it doesn't overflow off-screen
        dropdown.style.right = Math.max(8, window.innerWidth - rect.right - 10) + 'px';
        dropdown.style.left = 'auto';
    }

    function show() {
        positionDropdown();
        scrim.classList.add('visible');
        dropdown.classList.add('visible');
        isOpen = true;
    }

    function hide() {
        scrim.classList.remove('visible');
        dropdown.classList.remove('visible');
        isOpen = false;
    }

    // ---- Intercept clicks on the Characters drawer toggle ----
    // Uses capturing phase at the document level so we fire before ST's handlers.
    const rightNavPanel = document.getElementById('right-nav-panel');

    document.addEventListener('click', (e) => {
        if (!drawerToggle.contains(e.target)) return;        // Not our button

        if (bypassIntercept) {
            bypassIntercept = false;
            return;                                          // Let through to ST
        }

        // Embedded mode without dropdown: toggle CL directly
        if (getDisplayMode() === 'embedded' && !getShowDropdownInEmbedded()) {
            e.stopPropagation();
            e.preventDefault();
            if (isOpen) hide();
            toggleEmbedded();
            return;
        }

        // If ST's character panel is already open, let the click through so ST
        // can close it.  Without this, mobile users get stuck with the panel
        // open because our dropdown intercepts the "close" click.
        if (rightNavPanel && rightNavPanel.classList.contains('openDrawer')) {
            if (isOpen) hide();                              // Close our dropdown too
            return;                                          // Let through to ST
        }

        e.stopPropagation();
        e.preventDefault();

        // Show/hide the launcher dropdown
        if (isOpen) {
            hide();
        } else {
            show();
        }
    }, true);   // true = capture phase

    // ---- Scrim click closes dropdown ----
    scrim.addEventListener('click', () => hide());

    // ---- Handle dropdown item selection ----
    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;

        e.stopPropagation();
        hide();

        if (item.dataset.action === 'native') {
            // Close embedded CL if it's open, then show ST's character panel
            if (isEmbeddedActive()) hideEmbedded();
            bypassIntercept = true;
            drawerToggle.click();               // Replay click to ST's handler
        } else if (item.dataset.action === 'library') {
            openGallery();
        }
    });

    // ---- Escape key closes dropdown ----
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) {
            e.stopPropagation();
            hide();
        }
    });

    console.log(`${EXTENSION_NAME}: Launcher dropdown attached to Characters button`);
    return true;
}

/**
 * Fallback: create a standalone gallery button in the top bar
 */
function createStandaloneGalleryButton() {
    const galleryBtn = $(`
    <div id="st-gallery-btn" class="interactable" title="Open Character Library" style="cursor: pointer; display: flex; align-items: center; justify-content: center; height: 100%; padding: 0 10px;">
        <i class="fa-solid fa-photo-film" style="font-size: 1.2em;"></i>
    </div>
    `);

    galleryBtn.on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openGallery();
    });

    let injected = false;
    
    const rightNavHolder = $('#rightNavHolder');
    if (rightNavHolder.length) {
        rightNavHolder.after(galleryBtn);
        console.log(`${EXTENSION_NAME}: Standalone button added after #rightNavHolder`);
        injected = true;
    }
    
    if (!injected) {
        const fallbackTargets = ['#top-settings-holder', '#top-bar'];
        for (const selector of fallbackTargets) {
            const target = $(selector);
            if (target.length) {
                const children = target.children();
                if (children.length > 1) {
                    $(children[Math.floor(children.length / 2)]).after(galleryBtn);
                } else {
                    target.append(galleryBtn);
                }
                console.log(`${EXTENSION_NAME}: Standalone button added to ${selector}`);
                injected = true;
                break;
            }
        }
    }
    
    if (!injected) {
        console.warn(`${EXTENSION_NAME}: Could not find Top Bar. Creating floating button.`);
        galleryBtn.css({
            position: 'fixed', top: '2px', right: '250px', 'z-index': '20000',
            background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)',
            padding: '5px', height: '40px', width: '40px',
            display: 'flex', 'align-items': 'center', 'justify-content': 'center',
            'border-radius': '5px'
        });
        $('body').append(galleryBtn);
    }
}

// ==============================================
// Extension Settings UI (injected into ST's Extensions panel)
// ==============================================

function injectExtensionSettings() {
    if (document.getElementById('charlib-settings-injected')) return;

    const attach = () => {
        // Find ST's extensions settings container
        const container = document.querySelector('#extensions_settings')
            || document.querySelector('#extensions-settings')
            || document.querySelector('#extensions_settings2');
        if (!container) return false;
        if (document.getElementById('charlib-settings-injected')) return true;

        const currentMode = getDisplayMode();

        const panel = document.createElement('div');
        panel.id = 'charlib-settings-injected';
        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>${EXTENSION_NAME}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="font-size: 13px;">
                    <div style="display: flex; align-items: center; gap: 10px; padding: 4px 0;">
                        <label for="charlib-display-mode" style="white-space: nowrap;">Display Mode</label>
                        <select id="charlib-display-mode" class="text_pole" style="flex: 1;">
                            <option value="tab"${currentMode === 'tab' ? ' selected' : ''}>New Tab</option>
                            <option value="embedded"${currentMode === 'embedded' ? ' selected' : ''}>Embedded Panel</option>
                        </select>
                    </div>
                    <div id="charlib-embedded-options" style="${currentMode === 'embedded' ? '' : 'display: none;'}">
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;" title="Automatically open the embedded panel when SillyTavern loads">
                        <input type="checkbox" id="charlib-launch-on-boot"${getLaunchOnBoot() ? ' checked' : ''} />
                        <span>Launch on startup</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;" title="Keep SillyTavern's top navigation bar visible above the panel. When off, the panel takes the full viewport height and a Back button inside the panel returns you to your chat.">
                        <input type="checkbox" id="charlib-show-topbar"${getShowTopBar() ? ' checked' : ''} />
                        <span>Show SillyTavern top bar</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;" title="Show the choice dropdown (Character Management vs. Character Library) instead of toggling the panel directly. Useful if you frequently switch between both.">
                        <input type="checkbox" id="charlib-show-dropdown"${getShowDropdownInEmbedded() ? ' checked' : ''} />
                        <span>Show launcher dropdown</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer;" title="Opening the embedded panel closes any open SillyTavern drawers, and opening an ST drawer closes the panel. Prevents panels from overlapping.">
                        <input type="checkbox" id="charlib-exclusive-panes"${getExclusivePanes() ? ' checked' : ''} />
                        <span>Exclusive panels</span>
                    </label>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(panel);

        document.getElementById('charlib-launch-on-boot').addEventListener('change', (e) => {
            setLaunchOnBoot(e.target.checked);
        });

        document.getElementById('charlib-show-topbar').addEventListener('change', (e) => {
            setShowTopBar(e.target.checked);
            if (_iframe?.contentWindow) {
                _iframe.contentWindow.postMessage(
                    { source: 'character-library-host', type: 'cl-show-topbar', value: e.target.checked },
                    window.location.origin
                );
            }
            if (isEmbeddedActive()) {
                if (e.target.checked) {
                    _iframeContainer.style.top = 'var(--topBarBlockSize, 37px)';
                    _iframeContainer.style.height = 'calc(100dvh - var(--topBarBlockSize, 37px))';
                    for (const id of ['top-bar', 'top-settings-holder']) {
                        const el = document.getElementById(id);
                        if (el) el.style.display = '';
                    }
                } else {
                    _iframeContainer.style.top = '0';
                    _iframeContainer.style.height = '100dvh';
                    for (const id of ['top-bar', 'top-settings-holder']) {
                        const el = document.getElementById(id);
                        if (el) el.style.display = 'none';
                    }
                }
            }
        });

        document.getElementById('charlib-show-dropdown').addEventListener('change', (e) => {
            setShowDropdownInEmbedded(e.target.checked);
            const chev = document.querySelector('.charlib-chevron-badge');
            if (chev) {
                chev.style.display = (getDisplayMode() === 'embedded' && !e.target.checked) ? 'none' : '';
            }
        });

        document.getElementById('charlib-exclusive-panes').addEventListener('change', (e) => {
            setExclusivePanes(e.target.checked);
        });

        document.getElementById('charlib-display-mode').addEventListener('change', (e) => {
            const mode = e.target.value;
            setDisplayMode(mode);

            // Show/hide embedded-specific options
            const embeddedOpts = document.getElementById('charlib-embedded-options');
            if (embeddedOpts) embeddedOpts.style.display = mode === 'embedded' ? '' : 'none';

            // Update chevron visibility
            const chev = document.querySelector('.charlib-chevron-badge');
            if (chev) {
                chev.style.display = (mode === 'embedded' && !getShowDropdownInEmbedded()) ? 'none' : '';
            }

            if (mode !== 'embedded' && isEmbeddedActive()) {
                hideEmbedded();
            }

            if (mode === 'tab' && _iframeContainer) {
                _iframeContainer.remove();
                _iframeContainer = null;
                _iframe = null;
                _embeddedVisible = false;
            }
        });

        return true;
    };

    if (attach()) return;

    // Extensions panel may not be rendered yet; watch for it
    const observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
}

// ==============================================
// Main Init
// ==============================================

jQuery(async () => {
    // Delay to ensure ST's UI is fully loaded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Migrate legacy settings before anything reads them
    migrateSettings();

    // Set up the postMessage bridge for embedded mode
    setupPostMessageBridge();

    // Watch for ST drawer panels opening (mutual exclusion with CL)
    setupExclusivePanesWatcher();

    // Inject extension settings into ST's Extensions panel
    injectExtensionSettings();

    // Try to hijack ST's Characters button with a launcher dropdown
    const hijacked = setupLauncherDropdown();
    
    if (!hijacked) {
        // Fallback: standalone button in the top bar
        createStandaloneGalleryButton();
    }
    
    // Slash command fallback
    if (window.SlashCommandParser) {
        try {
            window.SlashCommandParser.addCommandObject(window.SlashCommandParser.SlashCommand?.fromProps?.({
                name: 'gallery',
                helpString: 'Open the Character Library',
                callback: openGallery
            }) ?? { name: 'gallery', callback: openGallery, helpString: 'Open the Character Library' });
        } catch (e) {
            console.warn('[CharLibrary] Could not register /gallery slash command:', e.message);
        }
    }
    
    // ==============================================
    // Media Localization in SillyTavern Chat
    // ==============================================
    
    // Initialize media localization for chat messages
    initMediaLocalizationInChat();

    // Initialize display name override for chat messages
    initDisplayNameOverride();

    // Protect ST's native gallery from crashing on large image folders
    initGalleryImageLimit();

    // Auto-launch embedded CL if enabled
    if (getDisplayMode() === 'embedded' && getLaunchOnBoot()) {
        openGallery();
    }
    
    console.log(`${EXTENSION_NAME}: Loaded successfully.`);
});

// ==============================================
// Media Localization Functions for SillyTavern Chat
// ==============================================

const SETTINGS_KEY = 'SillyTavernCharacterGallery';

// Cache for URL→LocalPath mappings per character avatar
const chatMediaLocalizationCache = {};
const REMOTE_MEDIA_SELECTOR = 'img[src^="http"], video source[src^="http"], audio source[src^="http"], video[src^="http"], audio[src^="http"]';

/**
 * Get our extension settings from SillyTavern's context
 */
function getExtensionSettings() {
    try {
        const context = SillyTavern?.getContext?.();
        if (context?.extensionSettings?.[SETTINGS_KEY]) {
            return context.extensionSettings[SETTINGS_KEY];
        }
    } catch (e) {
        console.warn('[CharLib] Could not access extension settings:', e);
    }
    return {};
}

/**
 * Check if media localization is enabled for a character
 */
function isMediaLocalizationEnabledForChat(avatar) {
    const settings = getExtensionSettings();
    // Default to true if not explicitly set (matching gallery.js DEFAULT_SETTINGS)
    const globalEnabled = settings.mediaLocalizationEnabled !== false;
    const perCharSettings = settings.mediaLocalizationPerChar || {};
    
    // Check per-character override first
    if (avatar && avatar in perCharSettings) {
        return perCharSettings[avatar];
    }
    
    return globalEnabled;
}

/**
 * Sanitize folder name to match SillyTavern's folder naming convention
 */
function sanitizeFolderName(name) {
    if (!name) return '';
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

/**
 * Get the gallery folder name for a character
 * Checks for unique folder override first, then falls back to character name
 * @param {object} character - Character object with name and avatar
 * @returns {string} The folder name to use
 */
function getGalleryFolderForCharacter(character) {
    if (!character) return '';
    
    try {
        const context = SillyTavern?.getContext?.();
        
        // Check for gallery folder override (unique folder)
        const overrideFolders = context?.extensionSettings?.gallery?.folders;
        if (overrideFolders && character.avatar && overrideFolders[character.avatar]) {
            return overrideFolders[character.avatar];
        }
    } catch (e) {
        // Fall through to default
    }
    
    // Default to character name
    return sanitizeFolderName(character.name || '');
}

/**
 * Sanitize media filename the same way gallery.js does
 */
function sanitizeMediaFilename(filename) {
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    return nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

/**
 * Extract filename from URL
 */
function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        return pathParts[pathParts.length - 1] || '';
    } catch (e) {
        const parts = url.split('/');
        return parts[parts.length - 1]?.split('?')[0] || '';
    }
}

/**
 * Build URL→LocalPath mapping for a character by scanning their gallery folder
 * @param {object} character - Full character object
 */
async function buildChatMediaLocalizationMap(character) {
    const avatar = character?.avatar;
    
    // Get the correct folder name (may be unique folder with UUID suffix)
    const folderName = getGalleryFolderForCharacter(character);
    if (!folderName) {
        return {};
    }
    
    // Cache key includes folder name to handle cases where override is registered after first call
    const cacheKey = avatar ? `${avatar}::${folderName}` : null;
    
    // Check cache first
    if (cacheKey && chatMediaLocalizationCache[cacheKey]) {
        return chatMediaLocalizationCache[cacheKey];
    }
    
    const urlMap = {};
    
    try {
        const csrfToken = await getCsrfToken();
        
        // Get list of files in character's gallery
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
                'X-CL-Bypass-Limit': '1'
            },
            body: JSON.stringify({ folder: folderName, type: 7 }) // 7 = all media types
        });
        
        if (!response.ok) {
            return urlMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            // Don't cache empty results - folder override may not be registered yet
            return urlMap;
        }
        
        // Parse localized/lorebook/provider-gallery media files
        // Format: {localized_media|lorebook_media}_{index}_{sanitizedName}.{ext}
        // Format: {provider}gallery_{hash8}_{sanitizedName}.{ext}
        const localizedPattern = /^(?:(?:localized_media|lorebook_media)_\d+|[a-z]+gallery_[a-f0-9]+)_(.+)\.[^.]+$/;
        let localizedCount = 0;
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            const match = fileName.match(localizedPattern);
            if (match) {
                const sanitizedName = match[1];
                const localPath = `/user/images/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`;
                urlMap[`__sanitized__${sanitizedName}`] = localPath;
                localizedCount++;
            }
        }
        
        // Only cache if we found localized files - don't cache empty results
        if (cacheKey && localizedCount > 0) {
            chatMediaLocalizationCache[cacheKey] = urlMap;
        }
        
        return urlMap;
        
    } catch (error) {
        console.error('[CharLib] Error building localization map:', error);
        return urlMap;
    }
}

// Duplicated from library.js (extractSanitizedUrlName). keep in sync
const CDN_VARIANT_NAMES = new Set(['public', 'original', 'raw', 'full', 'thumbnail', 'thumb',
    'medium', 'small', 'large', 'xl', 'default', 'image', 'photo', 'download', 'view']);

/**
 * Extract a CDN-aware sanitized name from a URL (matches extractSanitizedUrlName in library.js)
 */
function extractSanitizedUrlNameForChat(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length === 0) return '';

        const lastPart = pathParts[pathParts.length - 1];
        const nameWithoutExt = lastPart.includes('.')
            ? lastPart.substring(0, lastPart.lastIndexOf('.'))
            : lastPart;
        const sanitized = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);

        if (pathParts.length >= 2 && CDN_VARIANT_NAMES.has(sanitized.toLowerCase())) {
            const parent = pathParts[pathParts.length - 2]
                .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
            if (parent.length >= 4) {
                return `${parent}_${sanitized}`.substring(0, 40);
            }
        }

        return sanitized;
    } catch {
        return '';
    }
}

/**
 * Look up a remote URL and return local path if found
 */
function lookupLocalizedMediaForChat(urlMap, remoteUrl) {
    if (!urlMap || !remoteUrl) return null;
    
    const filename = extractFilenameFromUrl(remoteUrl);
    if (!filename) return null;
    
    const sanitizedName = sanitizeMediaFilename(filename);
    const localPath = urlMap[`__sanitized__${sanitizedName}`];
    if (localPath) return localPath;

    // CDN-aware fallback — files saved with parent+variant naming
    const cdnAwareName = extractSanitizedUrlNameForChat(remoteUrl);
    if (cdnAwareName && cdnAwareName !== sanitizedName) {
        return urlMap[`__sanitized__${cdnAwareName}`] || null;
    }

    return null;
}

/**
 * Replace remote URLs in inline style attributes and <style> blocks within a DOM subtree.
 * Handles CSS background-image: url(...), content: url(...), etc.
 */
function localizeCssUrlsInElement(element, urlMap) {
    if (!element || !urlMap) return;

    const cssUrlRe = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/g;

    // Inline style attributes
    const allElements = element.querySelectorAll('[style]');
    const targets = element.hasAttribute?.('style') ? [element, ...allElements] : allElements;

    for (const el of targets) {
        const style = el.getAttribute('style');
        if (!style || !style.includes('url(')) continue;

        const replaced = style.replace(cssUrlRe, (match, quote, url) => {
            const localPath = lookupLocalizedMediaForChat(urlMap, url);
            if (localPath) return `url(${quote}${localPath}${quote})`;
            return match;
        });

        if (replaced !== style) {
            el.setAttribute('style', replaced);
        }
    }

    // <style> blocks (character cards can embed these)
    const styleBlocks = element.querySelectorAll('style');
    for (const styleEl of styleBlocks) {
        const css = styleEl.textContent;
        if (!css || !css.includes('url(')) continue;

        const replaced = css.replace(cssUrlRe, (match, quote, url) => {
            const localPath = lookupLocalizedMediaForChat(urlMap, url);
            if (localPath) return `url(${quote}${localPath}${quote})`;
            return match;
        });

        if (replaced !== css) {
            styleEl.textContent = replaced;
        }
    }
}

/**
 * Apply media localization to a rendered message element
 */
async function localizeMediaInMessage(messageElement, character) {
    if (!character?.avatar || !messageElement) return;
    
    // Check if localization is enabled
    if (!isMediaLocalizationEnabledForChat(character.avatar)) return;
    
    const urlMap = await buildChatMediaLocalizationMap(character);
    
    if (Object.keys(urlMap).length === 0) return; // No localized files
    
    // Find all media elements with remote URLs
    const mediaElements = messageElement.querySelectorAll(REMOTE_MEDIA_SELECTOR);
    
    let replacedCount = 0;
    
    for (const el of mediaElements) {
        const src = el.getAttribute('src');
        if (!src) continue;
        
        const localPath = lookupLocalizedMediaForChat(urlMap, src);
        if (localPath) {
            el.setAttribute('src', localPath);
            replacedCount++;
        }
    }

    // Also replace remote URLs in CSS inline styles (background-image, content, etc.)
    localizeCssUrlsInElement(messageElement, urlMap);
}

/**
 * Sweep all currently-rendered chat messages and apply media localization.
 * Catches messages that were rendered before event listeners were attached,
 * or that were missed due to timing/event ordering.
 */
async function localizeAllVisibleMessages() {
    try {
        const context = SillyTavern.getContext?.();
        if (!context) return;

        const charId = context.characterId;
        if (charId === undefined || charId === null) return;

        const character = context.characters?.[charId];
        if (!character?.avatar) return;

        if (!isMediaLocalizationEnabledForChat(character.avatar)) return;

        const urlMap = await buildChatMediaLocalizationMap(character);
        if (Object.keys(urlMap).length === 0) return;

        const allMessages = document.querySelectorAll('.mes .mes_text');

        for (const mesText of allMessages) {
            const mediaElements = mesText.querySelectorAll(REMOTE_MEDIA_SELECTOR);
            for (const el of mediaElements) {
                const src = el.getAttribute('src');
                if (!src) continue;
                const localPath = lookupLocalizedMediaForChat(urlMap, src);
                if (localPath) {
                    el.setAttribute('src', localPath);
                }
            }
            localizeCssUrlsInElement(mesText, urlMap);
        }
    } catch (e) {
        console.error('[CharLib] Error in localizeAllVisibleMessages:', e);
    }
}

let chatLocalizationObserver = null;

/**
 * Initialize media localization hooks for SillyTavern chat
 */
function initMediaLocalizationInChat() {
    try {
        // Check if SillyTavern global is available
        if (typeof SillyTavern === 'undefined') {
            setTimeout(initMediaLocalizationInChat, 1000);
            return;
        }
        
        const context = SillyTavern.getContext?.();
        if (!context || !context.eventSource || !context.event_types) {
            setTimeout(initMediaLocalizationInChat, 1000);
            return;
        }
        
        const { eventSource, event_types } = context;

        // Helper: get current character or null
        function getCurrentCharacter() {
            const ctx = SillyTavern.getContext();
            const charId = ctx.characterId;
            if (charId === undefined || charId === null) return null;
            return ctx.characters?.[charId] || null;
        }

        // Cancellable retry timers per message
        const _messageTimers = new Map();

        function scheduleLocalize(messageId, delays) {
            cancelLocalize(messageId);
            const timers = delays.map(ms =>
                setTimeout(() => localizeMessageById(messageId), ms)
            );
            _messageTimers.set(messageId, timers);
        }

        function cancelLocalize(messageId) {
            const timers = _messageTimers.get(messageId);
            if (timers) {
                for (const t of timers) clearTimeout(t);
                _messageTimers.delete(messageId);
            }
        }

        function cancelAllLocalize() {
            for (const timers of _messageTimers.values()) {
                for (const t of timers) clearTimeout(t);
            }
            _messageTimers.clear();
        }

        // Helper: localize a single message element by mesid
        async function localizeMessageById(messageId) {
            const character = getCurrentCharacter();
            if (!character) return;
            const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
            if (!messageElement) return;
            await localizeMediaInMessage(messageElement.querySelector('.mes_text'), character);
        }
        
        // Listen for character messages being rendered
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            try {
                await localizeMessageById(messageId);
                scheduleLocalize(messageId, [200, 500]);
            } catch (e) {
                console.error('[CharLib] Error in CHARACTER_MESSAGE_RENDERED handler:', e);
            }
        });
        
        // Also listen for user messages (in case they contain media)
        eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
            try {
                await localizeMessageById(messageId);
                scheduleLocalize(messageId, [200]);
            } catch (e) {
                console.error('[CharLib] Error in USER_MESSAGE_RENDERED handler:', e);
            }
        });
        
        // Listen for chat changes to clear cache and re-localize all visible messages
        eventSource.on(event_types.CHAT_CHANGED, () => {
            Object.keys(chatMediaLocalizationCache).forEach(key => delete chatMediaLocalizationCache[key]);
            cancelAllLocalize();

            // Sweep visible messages after ST finishes rendering the new chat
            setTimeout(() => {
                localizeAllVisibleMessages();
                localizeCharacterInfoPanels();
            }, 500);
        });
        
        // Listen for message swipes to re-localize the swiped content
        eventSource.on(event_types.MESSAGE_SWIPED, async (messageId) => {
            try {
                scheduleLocalize(messageId, [50, 150, 300, 600]);
            } catch (e) {
                console.error('[CharLib] Error in MESSAGE_SWIPED handler:', e);
            }
        });
        
        // Listen for character selected event to localize info panels
        if (event_types.CHARACTER_EDITED) {
            eventSource.on(event_types.CHARACTER_EDITED, () => {
                setTimeout(() => localizeCharacterInfoPanels(), 300);
            });
        }

        // MutationObserver fallback: catch img elements added after
        // CHARACTER_MESSAGE_RENDERED fires (lazy-loaded images, markdown re-renders)
        const chatContainer = document.getElementById('chat');
        if (chatContainer && !chatLocalizationObserver) {
            let sweepScheduled = false;
            chatLocalizationObserver = new MutationObserver((mutations) => {
                if (sweepScheduled) return;
                let hasNewMedia = false;
                const mediaSelector = 'img[src^="http"], video[src^="http"], audio[src^="http"]';
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes') {
                        const el = mutation.target;
                        const src = el.getAttribute?.('src') || '';
                        if (src.startsWith('http')) {
                            hasNewMedia = true;
                            break;
                        }
                        continue;
                    }
                    if (mutation.type === 'childList') {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType !== Node.ELEMENT_NODE) continue;
                            if (node.matches?.(mediaSelector) || node.querySelector?.(mediaSelector)) {
                                hasNewMedia = true;
                                break;
                            }
                            // Check for CSS url() in inline styles
                            const style = node.getAttribute?.('style') || '';
                            if (style.includes('url(') && /url\(['"]?https?:\/\//.test(style)) {
                                hasNewMedia = true;
                                break;
                            }
                            if (node.querySelector?.('[style*="url("]')) {
                                hasNewMedia = true;
                                break;
                            }
                        }
                    }
                    if (hasNewMedia) break;
                }
                if (hasNewMedia) {
                    sweepScheduled = true;
                    setTimeout(() => {
                        sweepScheduled = false;
                        localizeAllVisibleMessages();
                    }, 200);
                }
            });
            chatLocalizationObserver.observe(chatContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        }

        // Initial sweep: localize messages already rendered before we attached listeners
        setTimeout(() => localizeAllVisibleMessages(), 300);
        
    } catch (e) {
        console.error('[CharLib] Failed to initialize media localization:', e);
    }
}

/**
 * Localize media in character info panels (creator's notes, description, etc.)
 * These are displayed outside of chat messages in various UI panels
 */
async function localizeCharacterInfoPanels() {
    try {
        const context = SillyTavern.getContext?.();
        if (!context) return;
        
        const charId = context.characterId;
        if (charId === undefined || charId === null) return;
        
        const character = context.characters?.[charId];
        if (!character?.avatar) return;
        
        // Check if localization is enabled for this character
        if (!isMediaLocalizationEnabledForChat(character.avatar)) return;
        
        // Build the URL map
        const urlMap = await buildChatMediaLocalizationMap(character);
        if (Object.keys(urlMap).length === 0) return;
        
        // Selectors for ST panels that might contain character info with images
        const panelSelectors = [
            '.inline-drawer-content',     // Content drawers (creator notes, etc.)
            '#description_div',
            '#creator_notes_div',
            '#character_popup',
            '#char_notes',
            '#firstmessage_div',
            '.character_description',
            '.creator_notes',
            '#mes_example_div',
            '.mes_narration',
            '.swipe_right',               // Alternate greetings swipe area
            '#alternate_greetings',       // Alt greetings container
            '.alternate_greeting',        // Individual alt greeting
            '.greeting_text',             // Greeting text content
        ];
        
        for (const selector of panelSelectors) {
            const panels = document.querySelectorAll(selector);
            for (const panel of panels) {
                if (!panel) continue;
                
                // Find all remote media in this panel
                const mediaElements = panel.querySelectorAll(REMOTE_MEDIA_SELECTOR);
                
                for (const el of mediaElements) {
                    const src = el.getAttribute('src');
                    if (!src) continue;
                    
                    const localPath = lookupLocalizedMediaForChat(urlMap, src);
                    if (localPath) {
                        el.setAttribute('src', localPath);
                    }
                }

                // Also replace CSS url() in inline styles
                localizeCssUrlsInElement(panel, urlMap);
            }
        }
    } catch (e) {
        console.error('[CharLib] Error localizing character info panels:', e);
    }
}

// ==============================================
// Display Name Override in SillyTavern Chat
// ==============================================

const PROVIDER_EXT_KEYS = ['chub', 'jannyai', 'pygmalion', 'wyvern', 'chartavern', 'datacat'];

function getListingName(character) {
    const ext = character?.data?.extensions;
    if (!ext) return null;
    for (const key of PROVIDER_EXT_KEYS) {
        const pageName = ext[key]?.pageName;
        if (pageName?.trim()) return pageName.trim();
    }
    return null;
}

function getDisplayNameForCharacter(character) {
    if (!character) return null;
    const settings = getExtensionSettings();
    if (settings.displayNameOverrideEnabled === false) return null;
    const perChar = settings.namePreferences || {};
    const pref = perChar[character.avatar]
        || settings.displayNamePreference
        || 'card';
    if (pref === 'listing') {
        return getListingName(character) || null;
    }
    return null;
}

function applyNameToMessage(messageElement, displayName) {
    if (!messageElement || !displayName) return;
    const nameEl = messageElement.querySelector('.ch_name .name_text')
        || messageElement.querySelector('.name_text');
    if (nameEl && nameEl.textContent !== displayName) {
        nameEl.textContent = displayName;
    }
}

function initDisplayNameOverride() {
    try {
        if (typeof SillyTavern === 'undefined') {
            setTimeout(initDisplayNameOverride, 1000);
            return;
        }

        const context = SillyTavern.getContext?.();
        if (!context?.eventSource || !context?.event_types) {
            setTimeout(initDisplayNameOverride, 1000);
            return;
        }

        const { eventSource, event_types } = context;

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            try {
                const ctx = SillyTavern.getContext();
                const charId = ctx?.characterId;
                if (charId === undefined || charId === null) return;
                const character = ctx.characters[charId];
                const displayName = getDisplayNameForCharacter(character);
                if (!displayName) return;
                const el = document.querySelector(`.mes[mesid="${messageId}"]`);
                applyNameToMessage(el, displayName);
            } catch (e) {
                console.error('[CharLib] Display name override error:', e);
            }
        });

        const applyDisplayNameToUI = () => {
            try {
                const ctx = SillyTavern.getContext();
                const charId = ctx?.characterId;
                if (charId === undefined || charId === null) return;
                const character = ctx.characters[charId];
                const displayName = getDisplayNameForCharacter(character);
                if (!displayName) return;
                document.querySelectorAll('#chat .mes:not([is_user])').forEach(el => {
                    applyNameToMessage(el, displayName);
                });
                const headerEl = document.querySelector('#rm_button_selected_ch h2');
                if (headerEl && headerEl.textContent !== displayName) {
                    headerEl.textContent = displayName;
                }
            } catch (e) {
                console.error('[CharLib] Display name override error:', e);
            }
        };

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(applyDisplayNameToUI, 300);
        });

        if (event_types.CHARACTER_EDITOR_OPENED) {
            eventSource.on(event_types.CHARACTER_EDITOR_OPENED, () => {
                setTimeout(applyDisplayNameToUI, 100);
            });
        }

        console.log('[CharLib] Display name override initialized');
    } catch (e) {
        console.error('[CharLib] Failed to initialize display name override:', e);
    }
}

// ==============================================
// ST Native Gallery Image Limit
// ==============================================

const ST_GALLERY_IMAGE_LIMIT = 500;

function initGalleryImageLimit() {
    const originalFetch = window.fetch;

    window.fetch = function (input, init) {
        const url = (typeof input === 'string') ? input : input?.url;

        if (!url?.endsWith('/api/images/list') || init?.method?.toUpperCase() !== 'POST') {
            return originalFetch.apply(this, arguments);
        }

        // Skip truncation for our own internal calls
        const hdrs = init?.headers;
        if (hdrs?.['X-CL-Bypass-Limit'] || (hdrs instanceof Headers && hdrs.get('X-CL-Bypass-Limit'))) {
            return originalFetch.apply(this, arguments);
        }

        return originalFetch.apply(this, arguments).then(async (response) => {
            if (!response.ok) return response;

            const cloned = response.clone();
            const data = await cloned.json();
            if (!Array.isArray(data) || data.length <= ST_GALLERY_IMAGE_LIMIT) {
                return response;
            }

            const totalCount = data.length;
            const truncated = data.slice(0, ST_GALLERY_IMAGE_LIMIT);

            // Inject notice into ST's gallery after nanogallery2 renders
            setTimeout(() => injectGalleryLimitNotice(totalCount), 600);

            return new Response(JSON.stringify(truncated), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        });
    };
}

function injectGalleryLimitNotice(totalCount) {
    const gallery = document.getElementById('dragGallery');
    if (!gallery) return;

    const existing = gallery.querySelector('.cl-gallery-limit-notice');
    if (existing) existing.remove();

    const notice = document.createElement('div');
    notice.className = 'cl-gallery-limit-notice';
    notice.style.cssText = 'padding:10px 16px;margin:8px 0;background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.3);border-radius:8px;color:#eee;font-size:13px;display:flex;align-items:center;gap:10px;justify-content:space-between;';

    const text = document.createElement('span');
    text.textContent = `Showing ${ST_GALLERY_IMAGE_LIMIT} of ${totalCount} images. Open the full gallery in Character Library for better performance.`;

    const btn = document.createElement('button');
    btn.textContent = 'Open Full Gallery';
    btn.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#fff;padding:4px 12px;cursor:pointer;white-space:nowrap;font-size:12px;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
    btn.addEventListener('click', () => openGallery());

    notice.append(text, btn);
    gallery.parentElement.insertBefore(notice, gallery);
}
