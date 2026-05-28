// Custom CSS module: snippet manager + raw blob editor.

import CoreAPI from './core-api.js';

const MODE_RAW = 'raw';
const MODE_SNIPPETS = 'snippets';
const SNIPPETS_FILE = '_cl_custom_css.json';
const STORAGE_VERSION = 1;

// ========================================
// FILE I/O
// ========================================

function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

async function fileUpload(name, data) {
    const base64 = toBase64(JSON.stringify(data));
    const resp = await CoreAPI.apiRequest('/files/upload', 'POST', { name, data: base64 });
    if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`Snippet file upload failed (${resp.status}): ${err}`);
    }
    return resp.json();
}

async function fileRead(name) {
    try {
        const resp = await fetch(`/user/files/${name}`);
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// ========================================
// SNIPPET STORE
// ========================================

let snippetsData = null;       // { version, snippets: [...], order: [...] }
let loaded = false;
let saving = false;
let saveQueued = false;
let _loadingPromise = null;

function createEmptyData() {
    return { version: STORAGE_VERSION, snippets: [], order: [] };
}

function genId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let uid = '';
    for (let i = 0; i < 12; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    return uid;
}

async function loadSnippets() {
    if (loaded) return snippetsData;
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
        const data = await fileRead(SNIPPETS_FILE);
        if (data && data.version && Array.isArray(data.snippets)) {
            snippetsData = {
                version: STORAGE_VERSION,
                snippets: data.snippets,
                order: Array.isArray(data.order) ? data.order : [],
            };
            const ids = new Set(snippetsData.snippets.map(s => s.id));
            const orderSet = new Set(snippetsData.order);
            for (const id of ids) {
                if (!orderSet.has(id)) snippetsData.order.push(id);
            }
            snippetsData.order = snippetsData.order.filter(id => ids.has(id));
        } else {
            snippetsData = createEmptyData();
        }
        loaded = true;
        _loadingPromise = null;
        return snippetsData;
    })();
    return _loadingPromise;
}

async function saveSnippetsFile() {
    if (!snippetsData) return;
    if (saving) {
        saveQueued = true;
        return;
    }
    saving = true;
    try {
        await fileUpload(SNIPPETS_FILE, snippetsData);
    } catch (e) {
        console.error('[CustomCSS] Save failed:', e.message);
        CoreAPI.showToast?.('Failed to save snippets', 'error');
    } finally {
        saving = false;
        if (saveQueued) {
            saveQueued = false;
            saveSnippetsFile();
        }
    }
}

function getOrderedSnippets() {
    if (!snippetsData) return [];
    const byId = new Map(snippetsData.snippets.map(s => [s.id, s]));
    const seen = new Set();
    const ordered = [];
    for (const id of snippetsData.order) {
        const s = byId.get(id);
        if (s) { ordered.push(s); seen.add(id); }
    }
    for (const s of snippetsData.snippets) {
        if (!seen.has(s.id)) ordered.push(s);
    }
    return ordered;
}

function findSnippet(id) {
    return snippetsData ? snippetsData.snippets.find(s => s.id === id) || null : null;
}

function buildEnabledBundle() {
    return getOrderedSnippets()
        .filter(s => s.enabled && typeof s.css === 'string' && s.css.trim())
        .map(s => `/* === ${(s.name || 'Snippet').replace(/\*\//g, '* /')} === */\n${s.css}`)
        .join('\n\n');
}

async function updateSnippet(id, patch) {
    await loadSnippets();
    const idx = snippetsData.snippets.findIndex(s => s.id === id);
    if (idx === -1) return null;
    snippetsData.snippets[idx] = { ...snippetsData.snippets[idx], ...patch, modified: Date.now() };
    await saveSnippetsFile();
    return snippetsData.snippets[idx];
}

async function createSnippet(nameOrOpts = 'New Snippet') {
    await loadSnippets();
    const opts = typeof nameOrOpts === 'string' ? { name: nameOrOpts } : (nameOrOpts || {});
    const snippet = {
        id: genId(),
        name: opts.name || 'New Snippet',
        notes: opts.notes || '',
        enabled: !!opts.enabled,
        css: typeof opts.css === 'string' ? opts.css : '',
        created: Date.now(),
        modified: Date.now(),
    };
    snippetsData.snippets.push(snippet);
    snippetsData.order.push(snippet.id);
    await saveSnippetsFile();
    return snippet;
}

async function deleteSnippetById(id) {
    await loadSnippets();
    snippetsData.snippets = snippetsData.snippets.filter(s => s.id !== id);
    snippetsData.order = snippetsData.order.filter(x => x !== id);
    await saveSnippetsFile();
}

async function clearAllSnippets() {
    await loadSnippets();
    snippetsData.snippets = [];
    snippetsData.order = [];
    await saveSnippetsFile();
}

// Pause all enabled snippets in one load+save. Used by Apply Raw.
async function disableAllEnabledSnippets() {
    await loadSnippets();
    const now = Date.now();
    let count = 0;
    for (const s of snippetsData.snippets) {
        if (s.enabled) {
            s.enabled = false;
            s.modified = now;
            count++;
        }
    }
    if (count > 0) await saveSnippetsFile();
    return count;
}

async function reorderSnippets(newOrderIds) {
    await loadSnippets();
    const ids = new Set(snippetsData.snippets.map(s => s.id));
    const seen = new Set();
    const next = [];
    for (const id of newOrderIds) {
        if (ids.has(id) && !seen.has(id)) {
            next.push(id);
            seen.add(id);
        }
    }
    for (const s of snippetsData.snippets) {
        if (!seen.has(s.id)) next.push(s.id);
    }
    snippetsData.order = next;
    await saveSnippetsFile();
}

// ========================================
// MODE
// ========================================

function getMode() {
    const m = CoreAPI.getSetting('customCSSMode');
    return m === MODE_SNIPPETS ? MODE_SNIPPETS : MODE_RAW;
}

function setMode(mode) {
    CoreAPI.setSetting('customCSSMode', mode === MODE_SNIPPETS ? MODE_SNIPPETS : MODE_RAW);
}

// ========================================
// UTILITIES
// ========================================

function byteSize(str) {
    return new Blob([typeof str === 'string' ? str : '']).size;
}

function formatKB(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

// ========================================
// MODAL STATE
// ========================================

let modalInjected = false;
let activeSnippetId = null;
let editorDirty = false;
// Mobile teleports scrim + sidebar to body so position:fixed escapes th emodal's
// transform containing block. Refs let us restore on close.
let drawerIsOpen = false;
let drawerScrimOriginalParent = null;
let drawerScrimOriginalNextSibling = null;
let drawerSidebarOriginalParent = null;
let drawerSidebarOriginalNextSibling = null;
let snippetsDirty = false;

// ========================================
// HTML
// ========================================

function buildModalHTML() {
    return `
    <div class="cl-modal custom-css-modal" id="customCssModal">
        <div class="cl-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-paintbrush"></i> Custom CSS</h3>
                <button class="cl-modal-close" id="ccssCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body ccss-body">
                <div class="ccss-toolbar">
                    <div class="ccss-mode-toggle" role="tablist">
                        <button class="ccss-mode-btn" data-mode="snippets" role="tab"><i class="fa-solid fa-layer-group"></i> Snippets</button>
                        <button class="ccss-mode-btn" data-mode="raw" role="tab"><i class="fa-solid fa-code"></i> Raw</button>
                    </div>
                    <div class="ccss-toolbar-spacer"></div>
                    <span id="ccssDirtyIndicator" class="ccss-dirty-indicator" hidden><i class="fa-solid fa-circle"></i> Unapplied changes</span>
                </div>

                <details class="custom-css-guidelines">
                    <summary>Guidelines &amp; tips</summary>
                    <div class="custom-css-guidelines-body">
                        <p>The active CSS on the page is whatever you last <strong>Applied</strong>, regardless of which mode produced it. Switching modes does not change what's on the page until you click Apply.</p>

                        <p><strong>Recommended approach: token overrides on <code>:root</code>.</strong> Re-themes the whole app without targeting specific classes:</p>
<pre>:root {
    --accent: #ff6b9d;
    --accent-rgb: 255, 107, 157;
    --cl-accent-rgb: 255, 107, 157;
    --bg-primary: #1a1a2e;
    --space-md: 12px;
}</pre>
                        <p class="custom-css-tip-note">For a full accent retheme, set both <code>--accent</code> (with its <code>--accent-rgb</code>) and <code>--cl-accent-rgb</code>. They drive parallel paths: <code>--accent</code> powers most app surfaces, <code>--cl-accent-rgb</code> powers the module dialog button family.</p>

                        <p><strong>Surface backgrounds.</strong> Five different tokens, each for a different layer:</p>
                        <ul class="custom-css-token-list">
                            <li><code>--bg-primary</code> / <code>--bg-secondary</code>: page chrome (body, sidebars, settings panels).</li>
                            <li><code>--glass-bg</code>: translucent (alpha 0.6) for overlays where the page should bleed through: topbar, dropdowns, glass buttons.</li>
                            <li><code>--cl-glass-bg</code>: near-opaque (alpha 0.95) for module dialog bodies (custom CSS editor, card updates, batch tagging, playlists, AI assistant). Reads as a solid surface.</li>
                            <li><code>--modal-bg</code>: full-screen detail modal background (character detail, creator, chat preview).</li>
                            <li><code>--card-bg</code>: character grid card background.</li>
                        </ul>

                        <p><strong>Modal scrim.</strong> The dimming layer <em>behind</em> a modal (the dark sheet that covers the rest of the page while the modal is open). Separate from the modal&rsquo;s own background; three tiers picked by gesture:</p>
                        <ul class="custom-css-token-list">
                            <li><code>--cl-modal-scrim-light</code> (alpha 0.6): gentle overlays like the image / gallery viewer.</li>
                            <li><code>--cl-modal-scrim</code> (alpha 0.7): standard modals like settings and the character detail.</li>
                            <li><code>--cl-modal-scrim-heavy</code> (alpha 0.8): destructive confirms (delete, &ldquo;really do this?&rdquo;).</li>
                        </ul>
                        <p class="custom-css-tip-note">These are full <code>rgba()</code> values, not just an alpha knob, so you can tint the scrim too (e.g. <code>rgba(20, 0, 40, 0.7)</code> for a purple-tinted dimming on a synthwave theme).</p>

                        <p><strong>Other useful token families:</strong></p>
                        <ul class="custom-css-token-list">
                            <li><code>--text-primary</code> / <code>--text-secondary</code> / <code>--text-faint</code> / <code>--text-muted</code>: text colour tiers (lightest to faintest).</li>
                            <li><code>--cl-success</code> / <code>--cl-error</code> / <code>--cl-warning</code> / <code>--cl-info</code>: muted status colours; each has a <code>-bright</code> variant for hero alerts and a <code>-pale</code> variant for text on translucent backgrounds.</li>
                            <li><code>--cl-favorite-gold</code> (with <code>-rgb</code>): gold accent for favorite indicators and the favorite-button hover treatment.</li>
                            <li><code>--space-2xs</code> through <code>--space-2xl</code>: spacing scale (use for padding, gap, margin).</li>
                            <li><code>--radius-2xs</code> through <code>--radius-4xl</code>, plus <code>--radius-circle</code> and <code>--radius-pill</code>: border-radius scale.</li>
                            <li><code>--font-4xs</code> through <code>--font-3xl</code>: typography scale.</li>
                        </ul>

                        <p class="custom-css-tip-note"><strong>Accent override warning.</strong> If you set any <code>--accent*</code> token in your applied CSS, a yellow warning appears next to the Accent Color picker in Settings &rarr; Appearance. Your CSS always wins over the picker (later in the cascade), so the picker silently does nothing until you remove the override. Clear the override to re-enable the picker.</p>

                        <p><strong>What to avoid:</strong></p>
                        <ul>
                            <li><strong>Class selectors are not a stable API.</strong> Targeting specific classes (e.g. <code>.char-card</code>) may break between versions. Prefer <code>:root</code> token overrides.</li>
                            <li><strong>No JavaScript.</strong> CSS only. <code>&lt;script&gt;</code> and <code>&lt;style&gt;</code> tags are stripped.</li>
                            <li><strong>External resources.</strong> <code>url(...)</code> and <code>@import</code> hit the network from your browser. Only paste CSS from sources you trust.</li>
                            <li><strong>Size limit:</strong> 64&nbsp;KB on the applied CSS.</li>
                        </ul>

                        <p><strong>If something breaks:</strong> click Clear in the offending mode, run <code>clResetCSS()</code> in the browser console (F12), or use Clear Custom CSS in SillyTavern&rsquo;s Extensions &rarr; Character Library panel. Your snippets are preserved.</p>
                    </div>
                </details>

                <!-- SNIPPETS MODE -->
                <div class="ccss-pane ccss-pane-snippets">
                    <!-- Mobile-only: backdrop scrim sits behind the bottom sheet. Hidden by
                         default; mobile CSS positions it fixed when the drawer opens. -->
                    <div class="ccss-drawer-scrim" id="ccssDrawerScrim" hidden></div>
                    <div class="ccss-snippets-layout">
                        <div class="ccss-sidebar" id="ccssSidebar">
                            <div class="mobile-sheet-handle"></div>
                            <div class="ccss-sidebar-header">
                                <span class="ccss-drawer-title">Snippets</span>
                                <button class="ccss-drawer-close" id="ccssDrawerCloseBtn" title="Close" aria-label="Close snippets drawer"><i class="fa-solid fa-xmark"></i></button>
                                <button class="cl-btn cl-btn-primary ccss-sidebar-new" id="ccssNewBtn"><i class="fa-solid fa-plus"></i> New</button>
                            </div>
                            <div class="ccss-snippet-list" id="ccssSnippetList"></div>
                            <div class="ccss-sidebar-empty" id="ccssSidebarEmpty">No snippets yet. Click <strong>New</strong> to create one.</div>
                        </div>
                        <div class="ccss-editor">
                            <!-- Mobile-only drawer trigger; shows the active snippet name -->
                            <button class="ccss-drawer-trigger" id="ccssDrawerTrigger" type="button">
                                <i class="fa-solid fa-bars"></i>
                                <span class="ccss-drawer-trigger-label" id="ccssDrawerTriggerLabel">Snippets</span>
                            </button>
                            <div class="ccss-editor-form" id="ccssEditorForm" hidden>
                                <div class="ccss-editor-meta">
                                    <input type="text" id="ccssSnippetName" class="glass-input" placeholder="Snippet name" maxlength="80">
                                    <label class="ccss-editor-enabled">
                                        <input type="checkbox" id="ccssSnippetEnabled"> Enabled
                                    </label>
                                    <button class="cl-btn cl-btn-sm cl-btn-danger ccss-editor-delete" id="ccssDeleteBtn" title="Delete this snippet"><i class="fa-solid fa-trash"></i></button>
                                    <button class="cl-btn cl-btn-sm" id="ccssRevertBtn"><i class="fa-solid fa-rotate-left"></i> Revert</button>
                                    <button class="cl-btn cl-btn-sm cl-btn-primary" id="ccssSaveSnippetBtn"><i class="fa-solid fa-floppy-disk"></i> Save Snippet</button>
                                </div>
                                <textarea id="ccssSnippetCss" class="custom-css-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="/* Snippet CSS */"></textarea>
                                <div class="custom-css-meta">
                                    <span id="ccssSnippetSizeLabel" class="custom-css-size">0 KB</span>
                                    <span id="ccssSnippetStatusLabel" class="custom-css-status"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- RAW MODE -->
                <div class="ccss-pane ccss-pane-raw" hidden>
                    <textarea id="ccssRawTextarea" class="custom-css-textarea ccss-raw-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="/* Your raw CSS */
:root {
    --accent: #ff6b9d;
}"></textarea>
                    <div class="custom-css-meta">
                        <span id="ccssRawSizeLabel" class="custom-css-size">0 KB</span>
                        <span id="ccssRawStatusLabel" class="custom-css-status"></span>
                    </div>
                </div>
            </div>
            <div class="cl-modal-footer ccss-footer">
                <span class="ccss-footer-hint" id="ccssFooterHint">Apply combines all enabled snippets and publishes them as the active CSS.</span>
                <div class="ccss-footer-actions">
                    <button class="cl-btn cl-btn-danger cl-hidden" id="ccssRawDisableBtn"><i class="fa-solid fa-eraser"></i> Clear</button>
                    <button class="cl-btn" id="ccssCloseFooterBtn">Close</button>
                    <button class="cl-btn cl-hidden" id="ccssRawSaveAsSnippetBtn"><i class="fa-solid fa-floppy-disk"></i> Save as Snippet</button>
                    <button class="cl-btn cl-btn-primary" id="ccssApplySnippetsBtn"><i class="fa-solid fa-check"></i> Apply Snippets</button>
                    <button class="cl-btn cl-btn-primary cl-hidden" id="ccssRawApplyBtn"><i class="fa-solid fa-check"></i> Apply Raw</button>
                </div>
            </div>
        </div>
    </div>`;
}

// ========================================
// DIRTY INDICATOR
// ========================================

function setSnippetsDirty(value) {
    snippetsDirty = !!value;
    const ind = document.getElementById('ccssDirtyIndicator');
    if (ind) ind.hidden = !snippetsDirty;
}

// Empty bundle means Apply Snippets has nothing to do, so the indicator stays
// quiet even when Raw owns the customCSS slot.
function computeSnippetsDirty() {
    const bundle = buildEnabledBundle();
    if (!bundle) return false;
    const applied = CoreAPI.getSetting('customCSS') || '';
    return bundle !== applied;
}

// ========================================
// MODE SWITCHING
// ========================================

function setActiveMode(mode) {
    const modal = document.getElementById('customCssModal');
    if (!modal) return;
    setMode(mode);
    modal.querySelectorAll('.ccss-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
        btn.setAttribute('aria-selected', btn.dataset.mode === mode ? 'true' : 'false');
    });
    modal.querySelector('.ccss-pane-snippets').hidden = mode !== MODE_SNIPPETS;
    modal.querySelector('.ccss-pane-raw').hidden = mode !== MODE_RAW;
    if (mode !== MODE_SNIPPETS) closeDrawer();

    const isSnippets = mode === MODE_SNIPPETS;
    document.getElementById('ccssApplySnippetsBtn')?.classList.toggle('cl-hidden', !isSnippets);
    document.getElementById('ccssRawApplyBtn')?.classList.toggle('cl-hidden', isSnippets);
    document.getElementById('ccssRawDisableBtn')?.classList.toggle('cl-hidden', isSnippets);
    document.getElementById('ccssRawSaveAsSnippetBtn')?.classList.toggle('cl-hidden', isSnippets);
    const hint = document.getElementById('ccssFooterHint');
    if (hint) {
        hint.textContent = isSnippets
            ? 'Apply combines all enabled snippets and publishes them as the active CSS.'
            : 'Apply publishes the raw CSS as the active stylesheet.';
    }
}

// ========================================
// SIDEBAR
// ========================================

function renderSidebar() {
    const list = document.getElementById('ccssSnippetList');
    const empty = document.getElementById('ccssSidebarEmpty');
    if (!list || !empty) return;
    const snippets = getOrderedSnippets();
    if (snippets.length === 0) {
        list.innerHTML = '';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    list.innerHTML = snippets.map(s => `
        <div class="ccss-snippet-item${s.id === activeSnippetId ? ' active' : ''}" data-id="${s.id}" draggable="true">
            <span class="ccss-snippet-drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <label class="ccss-snippet-toggle" title="Enable/disable this snippet">
                <input type="checkbox" class="ccss-snippet-enable" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
            </label>
            <button class="ccss-snippet-name" data-id="${s.id}">${escapeHtml(s.name || 'Untitled')}</button>
            <button class="ccss-snippet-wand" data-id="${s.id}" title="Open AI assistant"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        </div>
    `).join('');
}

// ========================================
// EDITOR
// ========================================

function refreshSnippetsView() {
    const ordered = getOrderedSnippets();
    if (ordered.length === 0) {
        activeSnippetId = null;
        loadSnippetIntoEditor(null);
        return;
    }
    const existing = ordered.find(s => s.id === activeSnippetId);
    loadSnippetIntoEditor(existing ? existing.id : ordered[0].id);
}

function loadSnippetIntoEditor(id) {
    activeSnippetId = id;
    const form = document.getElementById('ccssEditorForm');
    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const statusLabel = document.getElementById('ccssSnippetStatusLabel');

    if (!id) {
        form.hidden = true;
        editorDirty = false;
        updateDrawerTriggerLabel(null);
        renderSidebar();
        return;
    }
    const snippet = findSnippet(id);
    if (!snippet) {
        activeSnippetId = null;
        form.hidden = true;
        updateDrawerTriggerLabel(null);
        renderSidebar();
        return;
    }
    form.hidden = false;
    nameInput.value = snippet.name || '';
    enabledInput.checked = !!snippet.enabled;
    cssTextarea.value = snippet.css || '';
    statusLabel.textContent = '';
    editorDirty = false;
    updateEditorSizeLabel();
    updateDrawerTriggerLabel(snippet.name);
    renderSidebar();
}

function updateDrawerTriggerLabel(name) {
    const label = document.getElementById('ccssDrawerTriggerLabel');
    if (!label) return;
    label.textContent = name && name.trim() ? name : 'Snippets';
}

// ========================================
// MOBILE DRAWER
// ========================================

function teleportDrawerToBody() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    drawerScrimOriginalParent = scrim.parentElement;
    drawerScrimOriginalNextSibling = scrim.nextSibling;
    drawerSidebarOriginalParent = sidebar.parentElement;
    drawerSidebarOriginalNextSibling = sidebar.nextSibling;
    document.body.appendChild(scrim);
    document.body.appendChild(sidebar);
}

function restoreDrawerToOriginal() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (drawerScrimOriginalParent && scrim) {
        drawerScrimOriginalParent.insertBefore(scrim, drawerScrimOriginalNextSibling);
    }
    if (drawerSidebarOriginalParent && sidebar) {
        drawerSidebarOriginalParent.insertBefore(sidebar, drawerSidebarOriginalNextSibling);
    }
    drawerScrimOriginalParent = null;
    drawerScrimOriginalNextSibling = null;
    drawerSidebarOriginalParent = null;
    drawerSidebarOriginalNextSibling = null;
}

function openDrawer() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    if (!drawerIsOpen) {
        teleportDrawerToBody();
        drawerIsOpen = true;
    }
    scrim.hidden = false;
    requestAnimationFrame(() => sidebar.classList.add('drawer-open'));
}

function closeDrawer({ immediate = false } = {}) {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    sidebar.classList.remove('drawer-open');
    const finalize = () => {
        // If openDrawer was called again between this close and the deferred finalize,
        // the sidebar will have the open class back; abandon cleanup.
        if (sidebar.classList.contains('drawer-open')) return;
        scrim.hidden = true;
        if (drawerIsOpen) {
            restoreDrawerToOriginal();
            drawerIsOpen = false;
        }
    };
    if (immediate) {
        finalize();
    } else {
        // Wait for the slide-down so the backdrop fade tracks the sheet.
        setTimeout(finalize, 300);
    }
}

function updateEditorSizeLabel() {
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const sizeLabel = document.getElementById('ccssSnippetSizeLabel');
    if (!cssTextarea || !sizeLabel) return;
    const size = byteSize(cssTextarea.value);
    sizeLabel.textContent = formatKB(size);
    sizeLabel.classList.toggle('over-limit', size > CoreAPI.getCustomCSSMaxBytes());
}

async function saveActiveSnippet() {
    if (!activeSnippetId) return;
    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const statusLabel = document.getElementById('ccssSnippetStatusLabel');
    const max = CoreAPI.getCustomCSSMaxBytes();
    if (byteSize(cssTextarea.value) > max) {
        CoreAPI.showToast?.(`Snippet exceeds ${formatKB(max)} limit`, 'error');
        return;
    }
    await updateSnippet(activeSnippetId, {
        name: nameInput.value.trim() || 'Untitled',
        enabled: enabledInput.checked,
        css: cssTextarea.value,
    });
    editorDirty = false;
    setSnippetsDirty(true);
    statusLabel.textContent = 'Saved (click Apply to publish)';
    renderSidebar();
    CoreAPI.showToast?.('Snippet saved', 'success', 1500);
}

function confirmDiscardIfDirty() {
    if (!editorDirty) return true;
    if (!window.confirm('Discard unsaved changes to this snippet?')) return false;
    // Actually discard: reload textarea from disk so stale edits don't linger.
    if (activeSnippetId) loadSnippetIntoEditor(activeSnippetId);
    editorDirty = false;
    return true;
}

// ========================================
// RAW MODE
// ========================================

function loadRawIntoEditor() {
    const textarea = document.getElementById('ccssRawTextarea');
    const statusLabel = document.getElementById('ccssRawStatusLabel');
    if (!textarea) return;
    textarea.value = CoreAPI.getSetting('customCSS') || '';
    statusLabel.textContent = '';
    updateRawSizeLabel();
}

function updateRawSizeLabel() {
    const textarea = document.getElementById('ccssRawTextarea');
    const sizeLabel = document.getElementById('ccssRawSizeLabel');
    if (!textarea || !sizeLabel) return;
    const size = byteSize(textarea.value);
    sizeLabel.textContent = formatKB(size);
    sizeLabel.classList.toggle('over-limit', size > CoreAPI.getCustomCSSMaxBytes());
}

// ========================================
// MODAL LIFECYCLE
// ========================================

function injectModal() {
    if (modalInjected) return;
    modalInjected = true;
    document.body.insertAdjacentHTML('beforeend', buildModalHTML());

    const modal = document.getElementById('customCssModal');

    document.getElementById('ccssCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('ccssCloseFooterBtn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    modal.querySelectorAll('.ccss-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.mode;
            if (target === getMode()) return;
            if (!confirmDiscardIfDirty()) return;
            setActiveMode(target);
            if (target === MODE_RAW) loadRawIntoEditor();
            else refreshSnippetsView();
        });
    });

    const list = document.getElementById('ccssSnippetList');
    list.addEventListener('click', (e) => {
        const wandBtn = e.target.closest('.ccss-snippet-wand');
        if (wandBtn) {
            e.stopPropagation();
            const id = wandBtn.dataset.id;
            // Accepting an AI Update would silently overwrite unsaved edits on this snippet.
            if (editorDirty && activeSnippetId === id) {
                if (!window.confirm('You have unsaved edits to this snippet. The AI assistant may overwrite them if you accept an Update. Continue anyway?')) return;
            }
            // Close the mobile snippets drawer if open so the assistant modal isn't buried under it
            closeDrawer({ immediate: true });
            if (typeof window.openCssAssistant === 'function') {
                window.openCssAssistant({ snippetId: id });
            } else {
                CoreAPI.showToast?.('AI assistant not loaded yet, try again in a moment', 'warning');
            }
            return;
        }
        const nameBtn = e.target.closest('.ccss-snippet-name');
        if (nameBtn) {
            const id = nameBtn.dataset.id;
            if (id === activeSnippetId) {
                closeDrawer();
                return;
            }
            if (!confirmDiscardIfDirty()) return;
            loadSnippetIntoEditor(id);
            closeDrawer();
        }
    });
    list.addEventListener('change', async (e) => {
        const checkbox = e.target.closest('.ccss-snippet-enable');
        if (checkbox) {
            const id = checkbox.dataset.id;
            await updateSnippet(id, { enabled: checkbox.checked });
            setSnippetsDirty(true);
            if (id === activeSnippetId) {
                const enabledInput = document.getElementById('ccssSnippetEnabled');
                if (enabledInput) enabledInput.checked = checkbox.checked;
            }
        }
    });

    // Drag-to-reorder: desktop (HTML5 drag events) + touch (manual handling)
    let dragItem = null;
    const persistOrderFromDOM = async () => {
        const ids = [...list.querySelectorAll('.ccss-snippet-item')].map(el => el.dataset.id);
        await reorderSnippets(ids);
        setSnippetsDirty(true);
    };

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.ccss-snippet-item');
        if (!item) return;
        dragItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.id);
    });
    list.addEventListener('dragend', () => {
        if (dragItem) dragItem.classList.remove('dragging');
        dragItem = null;
        list.querySelectorAll('.ccss-snippet-item').forEach(el => el.classList.remove('drag-over'));
    });
    list.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const target = e.target.closest('.ccss-snippet-item');
        if (!target || target === dragItem) return;
        list.querySelectorAll('.ccss-snippet-item').forEach(el => el.classList.remove('drag-over'));
        target.classList.add('drag-over');
    });
    list.addEventListener('dragleave', (e) => {
        const target = e.target.closest('.ccss-snippet-item');
        if (target) target.classList.remove('drag-over');
    });
    list.addEventListener('drop', async (e) => {
        e.preventDefault();
        const target = e.target.closest('.ccss-snippet-item');
        if (!target || !dragItem || target === dragItem) return;
        target.classList.remove('drag-over');
        list.insertBefore(dragItem, target);
        await persistOrderFromDOM();
    });

    // Touch drag (mobile): initiated only when grabbing the handle to avoid hijacking taps
    let touchItem = null;
    list.addEventListener('touchstart', (e) => {
        const handle = e.target.closest('.ccss-snippet-drag-handle');
        if (!handle) return;
        const item = handle.closest('.ccss-snippet-item');
        if (!item) return;
        touchItem = item;
        item.classList.add('dragging');
    }, { passive: true });
    list.addEventListener('touchmove', (e) => {
        if (!touchItem) return;
        e.preventDefault();
        const y = e.touches[0].clientY;
        const items = [...list.querySelectorAll('.ccss-snippet-item')];
        items.forEach(el => el.classList.remove('drag-over'));
        for (const item of items) {
            if (item === touchItem) continue;
            const rect = item.getBoundingClientRect();
            if (y >= rect.top && y <= rect.bottom) {
                item.classList.add('drag-over');
                break;
            }
        }
    }, { passive: false });
    list.addEventListener('touchend', async () => {
        if (!touchItem) return;
        const overItem = list.querySelector('.ccss-snippet-item.drag-over');
        if (overItem && overItem !== touchItem) {
            list.insertBefore(touchItem, overItem);
            await persistOrderFromDOM();
        }
        touchItem.classList.remove('dragging');
        list.querySelectorAll('.ccss-snippet-item').forEach(el => el.classList.remove('drag-over'));
        touchItem = null;
    });
    list.addEventListener('touchcancel', () => {
        if (!touchItem) return;
        touchItem.classList.remove('dragging');
        list.querySelectorAll('.ccss-snippet-item').forEach(el => el.classList.remove('drag-over'));
        touchItem = null;
    });

    document.getElementById('ccssNewBtn')?.addEventListener('click', async () => {
        if (!confirmDiscardIfDirty()) return;
        const snippet = await createSnippet('New Snippet');
        setSnippetsDirty(true);
        loadSnippetIntoEditor(snippet.id);
        closeDrawer();
    });

    document.getElementById('ccssDrawerTrigger')?.addEventListener('click', openDrawer);
    document.getElementById('ccssDrawerCloseBtn')?.addEventListener('click', () => closeDrawer());
    document.getElementById('ccssDrawerScrim')?.addEventListener('click', () => closeDrawer());

    // Crossing back to desktop while the drawer is open at body level needs a force-restore.
    const mqMobile = window.matchMedia('(max-width: 768px)');
    mqMobile.addEventListener('change', (e) => {
        if (!e.matches && drawerIsOpen) closeDrawer({ immediate: true });
    });

    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const onDirty = () => {
        editorDirty = true;
        const status = document.getElementById('ccssSnippetStatusLabel');
        if (status) status.textContent = 'Unsaved';
    };
    nameInput.addEventListener('input', onDirty);
    enabledInput.addEventListener('change', onDirty);
    cssTextarea.addEventListener('input', () => {
        onDirty();
        updateEditorSizeLabel();
    });

    document.getElementById('ccssSaveSnippetBtn')?.addEventListener('click', saveActiveSnippet);
    document.getElementById('ccssRevertBtn')?.addEventListener('click', () => {
        if (!activeSnippetId) return;
        loadSnippetIntoEditor(activeSnippetId);
    });
    document.getElementById('ccssDeleteBtn')?.addEventListener('click', async () => {
        if (!activeSnippetId) return;
        const snippet = findSnippet(activeSnippetId);
        if (!snippet) return;
        if (!window.confirm(`Delete "${snippet.name || 'Untitled'}"? This cannot be undone.`)) return;
        const id = activeSnippetId;
        const wasEnabled = snippet.enabled;
        activeSnippetId = null;
        editorDirty = false;
        await deleteSnippetById(id);
        if (wasEnabled) setSnippetsDirty(true);
        loadSnippetIntoEditor(null);
        CoreAPI.showToast?.('Snippet deleted', 'info', 1500);
    });

    document.getElementById('ccssApplySnippetsBtn')?.addEventListener('click', () => {
        if (!confirmDiscardIfDirty()) return;
        const bundle = buildEnabledBundle();
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(bundle) > max) {
            CoreAPI.showToast?.(`Combined snippets exceed ${formatKB(max)} limit`, 'error');
            return;
        }
        CoreAPI.setSetting('customCSS', bundle);
        CoreAPI.applyCustomCSS();
        setSnippetsDirty(false);
        CoreAPI.showToast?.('Snippets applied', 'success', 1500);
    });

    const rawTextarea = document.getElementById('ccssRawTextarea');
    rawTextarea.addEventListener('input', () => {
        updateRawSizeLabel();
        const status = document.getElementById('ccssRawStatusLabel');
        if (status) status.textContent = '';
    });
    document.getElementById('ccssRawApplyBtn')?.addEventListener('click', async () => {
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(rawTextarea.value) > max) {
            CoreAPI.showToast?.(`Raw CSS exceeds ${formatKB(max)} limit`, 'error');
            return;
        }
        const enabledCount = getOrderedSnippets().filter(s => s.enabled).length;
        if (enabledCount > 0) {
            const noun = enabledCount === 1 ? 'snippet' : 'snippets';
            if (!window.confirm(`Applying Raw will pause ${enabledCount} enabled ${noun}. Continue?`)) return;
        }
        CoreAPI.setSetting('customCSS', rawTextarea.value);
        CoreAPI.applyCustomCSS();
        const paused = await disableAllEnabledSnippets();
        renderSidebar();
        setSnippetsDirty(computeSnippetsDirty());
        document.getElementById('ccssRawStatusLabel').textContent = 'Applied';
        const msg = paused > 0
            ? `Raw CSS applied. ${paused} ${paused === 1 ? 'snippet' : 'snippets'} paused.`
            : 'Raw CSS applied';
        CoreAPI.showToast?.(msg, 'success', 2000);
    });
    document.getElementById('ccssRawSaveAsSnippetBtn')?.addEventListener('click', async () => {
        if (!rawTextarea.value.trim()) {
            CoreAPI.showToast?.('Raw CSS is empty', 'warning', 1500);
            return;
        }
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(rawTextarea.value) > max) {
            CoreAPI.showToast?.(`Raw CSS exceeds ${formatKB(max)} limit`, 'error');
            return;
        }
        const input = window.prompt('Save as snippet (enter a name):', 'Raw Snippet');
        if (input === null) return;
        const name = input.trim() || 'Raw Snippet';
        await createSnippet({ name, css: rawTextarea.value, enabled: false });
        renderSidebar();
        CoreAPI.showToast?.(`Snippet "${name}" saved (disabled)`, 'success', 2000);
    });
    document.getElementById('ccssRawDisableBtn')?.addEventListener('click', () => {
        if (!window.confirm('Clear the raw CSS blob?')) return;
        rawTextarea.value = '';
        updateRawSizeLabel();
        CoreAPI.setSetting('customCSS', '');
        CoreAPI.applyCustomCSS();
        document.getElementById('ccssRawStatusLabel').textContent = 'Cleared';
        CoreAPI.showToast?.('Raw CSS cleared', 'info', 1500);
    });

    window.registerOverlay?.({
        id: 'customCssModal',
        tier: 5,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });

    // Mobile drawer as sub-overlay so back/Escape pops it before the parent modal.
    window.registerOverlay?.({
        id: 'ccssSidebar',
        tier: 3,
        close: () => closeDrawer(),
        visible: () => drawerIsOpen,
    });
}

async function openModal() {
    injectModal();
    await loadSnippets();
    setSnippetsDirty(computeSnippetsDirty());
    const mode = getMode();
    setActiveMode(mode);
    // Render sidebar even if booting in Raw so the Snippets tab isn't phantom-empty.
    refreshSnippetsView();
    if (mode === MODE_RAW) {
        loadRawIntoEditor();
    }
    document.getElementById('customCssModal').classList.add('visible');
}

function closeModal() {
    if (!confirmDiscardIfDirty()) return;
    if (drawerIsOpen) closeDrawer({ immediate: true });
    document.getElementById('customCssModal')?.classList.remove('visible');
}

function init() {}

function getActiveSnippetId() {
    return activeSnippetId;
}

export { openModal, closeModal, loadSnippets, buildEnabledBundle, clearAllSnippets, createSnippet, updateSnippet, renderSidebar, setSnippetsDirty, loadSnippetIntoEditor, getActiveSnippetId };
export default { init, openModal, closeModal };
