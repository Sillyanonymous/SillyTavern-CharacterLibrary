// Lorebook Manager: full-screen manager for standalone World Info files (list/edit/create/rename/
// duplicate/import/export) via ST's /worldinfo helpers. Character-embedded books edit in the detail modal.

import CoreAPI from './core-api.js';
import { proxyEncode } from './providers/provider-utils.js';

const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));

// ========================================
// ST WORLD-INFO SCHEMA (verified against ST release world-info.js newWorldInfoEntryDefinition)
// ========================================

const POSITION_OPTIONS = [
    [0, 'Before Character Defs'],
    [1, 'After Character Defs'],
    [2, "Top of Author's Note"],
    [3, "Bottom of Author's Note"],
    [4, '@ Depth'],
    [5, 'Top of Example Msgs'],
    [6, 'Bottom of Example Msgs'],
    [7, 'Outlet (named macro)'],
];

const LOGIC_OPTIONS = [
    [0, 'AND ANY'],
    [3, 'AND ALL'],
    [2, 'NOT ANY'],
    [1, 'NOT ALL'],
];

const ROLE_OPTIONS = [
    [0, 'System'],
    [1, 'User'],
    [2, 'Assistant'],
];

const TRISTATE_OPTIONS = [
    ['', 'Use global'],
    ['true', 'Yes'],
    ['false', 'No'],
];

// Matching-source toggles ST scans beyond the chat log (newer WI feature).
const MATCH_SOURCES = [
    ['matchPersonaDescription', 'Persona description'],
    ['matchCharacterDescription', 'Character description'],
    ['matchCharacterPersonality', 'Character personality'],
    ['matchCharacterDepthPrompt', 'Character depth prompt'],
    ['matchScenario', 'Scenario'],
    ['matchCreatorNotes', 'Creator notes'],
];

// Nullable numeric fields: empty input means "inherit the global WI setting".
const NULLABLE_NUMBERS = new Set(['scanDepth', 'sticky', 'cooldown', 'delay']);

// Mirror ST's on-disk world naming so CL's file_id matches what the server writes: ST does
// sanitize(`${name}.json`) then path.parse().name. Tracking the raw typed name instead breaks the
// active-row highlight, the count cache, and the name-collision guard.
function sanitizeWorldName(name) {
    let s = `${(name ?? '').trim()}.json`
        .replace(/[\/\?<>\\:\*\|"]/g, '')   // illegal
        .replace(/[\x00-\x1f\x80-\x9f]/g, '') // control
        .replace(/^\.+$/, '')                // reserved dot-only
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '') // windows reserved
        .replace(/[\. ]+$/, '');             // trailing dots/spaces
    // ST truncates to 255 UTF-8 bytes; world names never approach that, so a char cap is fine.
    if (s.length > 255) s = s.slice(0, 255);
    // path.parse().name strips the trailing .json extension we appended.
    return s.replace(/\.json$/i, '');
}

function newEntry(uid, displayIndex) {
    return {
        uid,
        key: [], keysecondary: [],
        comment: '', content: '',
        constant: false, vectorized: false,
        selective: true, selectiveLogic: 0,
        addMemo: false,
        order: 100, position: 0,
        disable: false, ignoreBudget: false,
        excludeRecursion: false, preventRecursion: false,
        matchPersonaDescription: false, matchCharacterDescription: false,
        matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
        matchScenario: false, matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100, useProbability: true,
        depth: 4, outletName: '',
        group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: 0,
        sticky: null, cooldown: null, delay: null,
        triggers: [],
        displayIndex,
    };
}

// Port of ST's convertCharacterBook: embedded character_book (entries ARRAY) -> native
// world file (entries OBJECT keyed by id). Lets the user import a card's V2/V3 JSON directly.
function convertCharacterBookToNative(book) {
    const result = { entries: {} };
    const list = Array.isArray(book?.entries) ? book.entries : [];
    list.forEach((entry, index) => {
        const id = entry.id === undefined ? index : entry.id;
        const ext = entry.extensions || {};
        const posFromString = entry.position === 'before_char' ? 0 : 1;
        result.entries[id] = {
            ...newEntry(id, ext.display_index ?? index),
            key: Array.isArray(entry.keys) ? entry.keys : [],
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content || '',
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order ?? 100,
            position: ext.position ?? posFromString,
            excludeRecursion: ext.exclude_recursion ?? false,
            preventRecursion: ext.prevent_recursion ?? false,
            delayUntilRecursion: ext.delay_until_recursion ?? 0,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            probability: ext.probability ?? 100,
            useProbability: ext.useProbability ?? true,
            depth: ext.depth ?? 4,
            selectiveLogic: ext.selectiveLogic ?? 0,
            group: ext.group ?? '',
            groupOverride: ext.group_override ?? false,
            groupWeight: ext.group_weight ?? 100,
            scanDepth: ext.scan_depth ?? null,
            caseSensitive: ext.case_sensitive ?? null,
            matchWholeWords: ext.match_whole_words ?? null,
            useGroupScoring: ext.use_group_scoring ?? null,
            automationId: ext.automation_id ?? '',
            role: ext.role ?? 0,
            vectorized: ext.vectorized ?? false,
            sticky: ext.sticky ?? null,
            cooldown: ext.cooldown ?? null,
            delay: ext.delay ?? null,
            outletName: ext.outlet_name ?? '',
            ignoreBudget: ext.ignore_budget ?? false,
            triggers: ext.triggers ?? [],
            matchPersonaDescription: ext.match_persona_description ?? false,
            matchCharacterDescription: ext.match_character_description ?? false,
            matchCharacterPersonality: ext.match_character_personality ?? false,
            matchCharacterDepthPrompt: ext.match_character_depth_prompt ?? false,
            matchScenario: ext.match_scenario ?? false,
            matchCreatorNotes: ext.match_creator_notes ?? false,
        };
    });
    return result;
}

// ========================================
// MODULE STATE
// ========================================

let isInitialized = false;
let eventsAttached = false;

let worldsList = [];          // [{ file_id, name, extensions }]
let linkedMap = new Map();    // file_id -> [{ avatar, name, char }]  (character primary links)

// "Used by" lens: 'characters' (card extensions.world) | 'chats' (chat_metadata.world_info).
// Governs the sidebar badges + sort and the editor's usage section. Per manager session.
let usedByMode = 'characters';
// world file_id -> [{ avatar, charName, char, file_name }] of chats bound to it.
let chatBoundMap = new Map();
let chatIndexLoaded = false;     // has the reverse index been built this session?
let chatIndexLoading = false;

let currentWorld = null;      // file_id of the open world
let workingWorld = null;      // deep-cloned working copy { entries: {...}, ... }
let originalSnapshot = '';    // JSON of workingWorld at load/save, for dirty compare
let dirty = false;

let worldSearch = '';
let worldSort = 'name';
let entrySearch = '';
let entrySort = 'order';
let creatingNew = false;

const expandedUids = new Set();
const advancedUids = new Set();

// Link-to-characters picker state
let linkSelection = new Set();   // avatars (characters mode) OR chat file_names (chats mode)
let linkSearch = '';
let linkHideLinked = false;
let linkPlaylistUid = '';        // '' = all characters
let linkPlaylistSet = null;      // Set<avatar> of the active playlist filter
let linkPlaylistAvailable = false; // any playlists exist (hides the filter when none)
let linkBook = null;             // file_id the picker is linking
let linkMode = 'characters';     // 'characters' | 'chats'
let linkManageMode = false;      // true = "manage links" view (show only linked, action = unlink)
let manageChatList = [];         // chats mode + manage: the book's bound chats (cross-character)
let linkChatChar = null;         // chats mode: the character whose chats we're picking
let linkChatList = [];           // chats mode: that character's chats (with chat_metadata)
let linkChatsLoading = false;
// Link-picker perf state. The character lists are unbounded,
// so they are virtualized: base list sorted once and cached, search filters the cache,
// and only the rows in view are built into the DOM.
let linkFiltered = [];           // current filtered+sorted candidate array (the "shown" set)
let linkBaseSorted = null;       // cached world/mode-filtered + name-sorted base; null = dirty
let linkRowStride = 0;           // measured row height + gap (px); 0 = remeasure on next render
let vlistActive = false;         // is the link list currently windowed
let vlistData = null;            // { items, rowFn } for the active window
let vlistRaf = 0;                // rAF handle coalescing scroll repaints
let vlistListOffset = 0;         // px from the scroll container's top to the list's content (0 when the list scrolls itself)
let linkSearchTimer = 0;         // debounce handle for the picker search box

// Cache of entry counts by file_id. /worldinfo/list doesn't return counts, so we
// backfill them lazily in the background (bounded concurrency) and cache for the session.
const entryCountCache = new Map();
let countFetchToken = 0;

// ========================================
// MODAL SHELL
// ========================================

function createModal() {
    const html = `
    <div id="lorebookModal" class="modal-overlay hidden">
        <div class="modal-glass lb-modal-glass">
            <div class="modal-header lb-header">
                <h2><i class="fa-solid fa-book-atlas"></i> Lorebooks</h2>
                <div class="modal-controls">
                    <button class="close-btn" id="lbCloseBtn" title="Close">&times;</button>
                </div>
            </div>

            <div class="modal-body lb-body">
                <aside class="lb-sidebar">
                    <div class="lb-sidebar-actions">
                        <div class="lb-split-btn">
                            <button class="lb-newbook-btn" id="lbNewBtn" title="Create a new blank lorebook">
                                <i class="fa-solid fa-plus"></i> New
                            </button>
                            <button class="lb-newbook-btn lb-split-caret" id="lbNewCaret" title="More ways to create" aria-label="More ways to create">
                                <i class="fa-solid fa-caret-down"></i>
                            </button>
                            <div class="lb-split-menu hidden" id="lbNewMenu">
                                <button class="dropdown-item" id="lbAiBtn">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate with AI
                                </button>
                            </div>
                        </div>
                        <button class="lb-import-btn" id="lbImportBtn" title="Import a lorebook file (.json)">
                            <i class="fa-solid fa-file-import"></i> Import
                        </button>
                        <input type="file" id="lbImportInput" accept=".json,application/json" multiple style="display:none;">
                    </div>
                    <div class="lb-sidebar-tools">
                        <div class="lb-search-wrap">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input type="search" id="lbWorldSearch" class="cl-input" placeholder="Search lorebooks or characters..." autocomplete="off">
                        </div>
                        <div class="lb-tools-row">
                            <div class="lb-usedby-seg" role="group" aria-label="Used-by view">
                                <button class="lb-usedby-opt active" data-action="usedby-mode" data-mode="characters" title="Used by characters (primary links)" aria-label="Used by characters"><i class="fa-solid fa-user"></i></button>
                                <button class="lb-usedby-opt" data-action="usedby-mode" data-mode="chats" title="Used by chats (chat-bound)" aria-label="Used by chats"><i class="fa-solid fa-comment-dots"></i></button>
                            </div>
                            <select id="lbWorldSort" class="lb-sort-select">
                                <option value="name">Name A-Z</option>
                                <option value="name_desc">Name Z-A</option>
                                <option value="entries">Most entries</option>
                                <option value="linked">Most linked</option>
                            </select>
                        </div>
                    </div>
                    <div class="lb-world-list" id="lbWorldList"></div>
                </aside>

                <section class="lb-content" id="lbContent">
                    <div class="lb-empty">
                        <i class="fa-solid fa-book-atlas"></i>
                        <p>Select a lorebook to edit, or create a new one.</p>
                    </div>
                </section>
            </div>
        </div>
    </div>

    <div id="lbLinkModal" class="cl-modal">
        <div class="cl-modal-content lb-link-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-link cl-modal-header-icon"></i> <span id="lbLinkVerb">Link</span> <strong id="lbLinkBookName"></strong></h3>
                <button class="cl-modal-close" id="lbLinkCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-link-body">
                <div class="lb-link-mode-hint" id="lbLinkModeHint"></div>

                <div class="lb-link-head" id="lbLinkHead">
                    <div class="lb-link-head-inner">
                        <div class="lb-link-tools">
                            <div class="lb-search-wrap">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="search" id="lbLinkSearch" class="cl-input" placeholder="Search characters..." autocomplete="off">
                            </div>
                            <div class="lb-link-playlist-wrap" id="lbLinkPlaylistWrap" style="display: none;">
                                <select id="lbLinkPlaylistFilter" class="cl-select-fluid" title="Filter by playlist">
                                    <option value="">All characters</option>
                                </select>
                            </div>
                        </div>

                        <div class="lb-link-selectbar">
                            <button class="lb-icon-btn" id="lbLinkSelectToggle" data-action="link-toggle-select" title="Select all shown"><i class="fa-solid fa-square-check"></i></button>
                            <label class="lb-link-filter-toggle" id="lbLinkHideLinkedWrap">
                                <input type="checkbox" id="lbLinkHideLinked">
                                <span>Hide already-linked</span>
                            </label>
                            <span class="lb-link-count" id="lbLinkCount">0 selected</span>
                        </div>
                    </div>
                </div>

                <div class="lb-link-list" id="lbLinkList"></div>
            </div>
            <div class="cl-modal-footer lb-link-footer">
                <button class="cl-btn" id="lbLinkCancelBtn">Cancel</button>
                <button class="cl-btn cl-btn-primary" id="lbLinkApplyBtn" disabled><i class="fa-solid fa-link"></i> Link <span id="lbLinkApplyCount"></span></button>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    Array.from(wrap.children).forEach(el => document.body.appendChild(el));
}

// ========================================
// OPEN / CLOSE
// ========================================

async function openModal(focusWorld) {
    let modal = document.getElementById('lorebookModal');
    if (!modal) {
        createModal();
        modal = document.getElementById('lorebookModal');
        attachEvents();
        const sortSel = document.getElementById('lbWorldSort');
        if (sortSel) CoreAPI.initCustomSelect(sortSel);
    }
    modal.classList.remove('hidden');
    // Sync the persistent toggle DOM + placeholder to the (reset) Characters lens on each open.
    document.querySelectorAll('.lb-usedby-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === usedByMode));
    const wsEl = document.getElementById('lbWorldSearch');
    if (wsEl) wsEl.placeholder = usedByMode === 'chats' ? 'Search lorebooks or chats...' : 'Search lorebooks or characters...';
    // focusWorld may arrive as an event object when wired directly to a listener; ignore non-strings.
    const target = typeof focusWorld === 'string' ? focusWorld : null;
    await refreshList({ keepSelection: !target });
    if (target && worldsList.some(w => w.file_id === target)) {
        await selectWorld(target);
    } else if (target) {
        CoreAPI.showToast(`Lorebook "${target}" not found`, 'warning');
    }
}

function closeModal() {
    if (dirty) {
        CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        }).then(ok => { if (ok) forceClose(); });
        return;
    }
    forceClose();
}

function forceClose() {
    document.getElementById('lorebookModal')?.classList.add('hidden');
    // Release the heavy buffers so a closed manager doesn't pin a full world file + string snapshot
    // + live char refs for the session (the back-to-list and delete paths already did; desktop close was the gap).
    workingWorld = null;
    originalSnapshot = '';
    currentWorld = null;
    dirty = false;
    expandedUids.clear();
    advancedUids.clear();
    linkedMap = new Map();
    linkSelection = new Set();
    linkChatList = [];
    linkChatChar = null;
    // Drop the chat reverse index (can be large); it rebuilds lazily on next Chats toggle.
    invalidateChatIndex();
    // Reset the lens to match the freshly-built toggle DOM (defaults to Characters) on reopen.
    usedByMode = 'characters';
}

// ========================================
// DATA LOADING
// ========================================

async function refreshList({ keepSelection = false } = {}) {
    // No first-load loader: the list paints as soon as the fetch resolves; the loading
    // animation was more distracting than the brief empty state it replaced.
    worldsList = await CoreAPI.listWorldInfoFiles();
    buildLinkedMap();
    renderWorldList();
    if (keepSelection && currentWorld && worldsList.some(w => w.file_id === currentWorld)) {
        // working copy already in memory; keep the editor, re-assert mobile editing view
        setEditingMode(true);
    } else if (!currentWorld) {
        renderEmptyContent();
    }
    backfillEntryCounts();
}

// Lazily fetch entry counts for worlds we haven't counted yet, a few at a time, so the
// sidebar fills in "N entries" without blocking render or hammering the server.
async function backfillEntryCounts() {
    const token = ++countFetchToken;
    const pending = worldsList.filter(w => !entryCountCache.has(w.file_id) && w.file_id !== currentWorld);
    const CONCURRENCY = 4;
    let i = 0;
    const worker = async () => {
        while (i < pending.length) {
            if (token !== countFetchToken) return; // a newer refresh superseded us
            const w = pending[i++];
            try {
                const data = await CoreAPI.getWorldInfoData(w.file_id);
                entryCountCache.set(w.file_id, data?.entries ? Object.keys(data.entries).length : 0);
            } catch {
                entryCountCache.set(w.file_id, null);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    if (token === countFetchToken) renderWorldList();
}

function buildLinkedMap() {
    linkedMap = new Map();
    const chars = CoreAPI.getAllCharacters() || [];
    for (const char of chars) {
        const world = char?.data?.extensions?.world;
        if (!world) continue;
        if (!linkedMap.has(world)) linkedMap.set(world, []);
        linkedMap.get(world).push({ avatar: char.avatar, name: char.name || char.avatar, char });
    }
}

function entryCountOf(world) {
    // The open world is exact from the working copy; others come from the lazy count cache.
    if (world.file_id === currentWorld && workingWorld) {
        return Object.keys(workingWorld.entries || {}).length;
    }
    return entryCountCache.has(world.file_id) ? entryCountCache.get(world.file_id) : null;
}

// "Used by" count for a world under the active lens. Characters: char-link count (in memory).
// Chats: chat-bind count from the reverse index (null until the index is built -> shows "...").
function usedByCount(fileId) {
    if (usedByMode === 'chats') {
        if (!chatIndexLoaded) return null;
        return (chatBoundMap.get(fileId) || []).length;
    }
    return (linkedMap.get(fileId) || []).length;
}

// Build world file_id -> bound chats, from one /chats/recent (all chats, with metadata).
// Lazy: only when the user first flips to Chats mode. Cached for the session; invalidated
// on bind/unbind. Re-renders the sidebar when ready so badges fill in.
async function ensureChatIndex() {
    if (chatIndexLoaded || chatIndexLoading) return;
    chatIndexLoading = true;
    renderWorldList(); // show "..." placeholders immediately
    try {
        const all = await CoreAPI.listAllChatsWithMeta();
        chatBoundMap = new Map();
        for (const c of all) {
            if (!chatBoundMap.has(c.world)) chatBoundMap.set(c.world, []);
            chatBoundMap.get(c.world).push({ avatar: c.avatar, charName: c.charName, char: c.char, file_name: c.file_name });
        }
        chatIndexLoaded = true;
    } catch (e) {
        console.error('[Lorebooks] chat index build failed', e);
    } finally {
        chatIndexLoading = false;
        renderWorldList();
        if (currentWorld) renderEditor();
    }
}

function invalidateChatIndex() {
    chatIndexLoaded = false;
    chatBoundMap = new Map();
}

function setUsedByMode(mode) {
    if (mode !== 'characters' && mode !== 'chats') return;
    if (mode === usedByMode) return;
    usedByMode = mode;
    document.querySelectorAll('.lb-usedby-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const searchEl = document.getElementById('lbWorldSearch');
    if (searchEl) searchEl.placeholder = mode === 'chats' ? 'Search lorebooks or chats...' : 'Search lorebooks or characters...';
    renderWorldList();
    if (currentWorld) renderEditor();
    if (mode === 'chats') ensureChatIndex(); // lazy build on first switch
}

// ========================================
// WORLD LIST (SIDEBAR)
// ========================================

// Names (character names) under the active lens whose value matches the query, used to
// surface "I know the character/chat, not the book". Characters lens -> linked char names;
// Chats lens -> the character names of chats bound to this world.
function matchedNamesFor(fileId, q) {
    if (!q) return [];
    if (usedByMode === 'chats') {
        return (chatBoundMap.get(fileId) || [])
            .filter(c => (c.charName || '').toLowerCase().includes(q))
            .map(c => c.charName);
    }
    return (linkedMap.get(fileId) || []).filter(l => l.name.toLowerCase().includes(q)).map(l => l.name);
}

function worldMatchesQuery(w, q) {
    if (!q) return true;
    // Match on file_id only: ST identifies + displays world files by filename, not the (often stale)
    // internal JSON "name" field, so we mirror that everywhere.
    if (w.file_id.toLowerCase().includes(q)) return true;
    return matchedNamesFor(w.file_id, q).length > 0;
}

function filteredSortedWorlds() {
    const q = worldSearch.trim().toLowerCase();
    let list = worldsList.filter(w => worldMatchesQuery(w, q));
    const usedCount = (w) => usedByCount(w.file_id) ?? 0;
    switch (worldSort) {
        case 'name_desc':
            list.sort((a, b) => b.file_id.localeCompare(a.file_id)); break;
        case 'entries':
            list.sort((a, b) => (entryCountOf(b) ?? -1) - (entryCountOf(a) ?? -1)); break;
        case 'linked':
            list.sort((a, b) => usedCount(b) - usedCount(a) || a.file_id.localeCompare(b.file_id)); break;
        default:
            list.sort((a, b) => a.file_id.localeCompare(b.file_id));
    }
    return list;
}

function renderWorldList() {
    const listEl = document.getElementById('lbWorldList');
    if (!listEl) return;

    const list = filteredSortedWorlds();
    let html = '';

    if (creatingNew) {
        html += `
            <div class="lb-newbook-row">
                <i class="fa-solid fa-book"></i>
                <input type="text" id="lbNewNameInput" class="lb-newbook-input" placeholder="Lorebook name..." autocomplete="off">
            </div>`;
    }

    if (list.length === 0 && !creatingNew) {
        html += worldsList.length === 0
            ? `<div class="lb-list-empty">No lorebooks yet.<br>Create or import one to start.</div>`
            : `<div class="lb-list-empty">No matches for "${esc(worldSearch)}".</div>`;
    }

    const q = worldSearch.trim().toLowerCase();
    const usingChats = usedByMode === 'chats';
    for (const w of list) {
        const used = usedByCount(w.file_id); // null while chat index loads
        const count = entryCountOf(w);
        const active = w.file_id === currentWorld ? ' active' : '';
        // Only flag a linked-character match when the query didn't already hit the book name (file_id).
        const nameHit = q && w.file_id.toLowerCase().includes(q);
        const nameHits = nameHit ? [] : matchedNamesFor(w.file_id, q);
        const meta = [];
        if (count === null) meta.push('...');
        else meta.push(`${count} ${count === 1 ? 'entry' : 'entries'}`);
        if (used === null) meta.push('...');
        else if (used > 0) meta.push(usingChats ? `${used} chat${used === 1 ? '' : 's'}` : `${used} linked`);
        const viaLine = nameHits.length
            ? `<span class="lb-world-via" title="${esc(nameHits.join(', '))}"><i class="fa-solid fa-${usingChats ? 'comments' : 'user'}"></i> via ${esc(nameHits.join(', '))}</span>`
            : '';
        const badge = (used && used > 0)
            ? `<span class="lb-world-linked-badge" title="${used} ${usingChats ? `bound chat${used === 1 ? '' : 's'}` : `linked character${used === 1 ? '' : 's'}`}"><i class="fa-solid fa-${usingChats ? 'comments' : 'link'}"></i>${used}</span>`
            : '';
        html += `
            <button class="lb-world-row${active}${nameHits.length ? ' char-match' : ''}" data-action="select-world" data-world="${esc(w.file_id)}" title="${esc(w.file_id)}">
                <i class="fa-solid fa-book lb-world-icon"></i>
                <span class="lb-world-info">
                    <span class="lb-world-name">${esc(w.file_id)}</span>
                    <span class="lb-world-meta">${esc(meta.join('  ·  '))}</span>
                    ${viaLine}
                </span>
                ${badge}
            </button>`;
    }

    listEl.innerHTML = html;

    if (creatingNew) {
        const input = document.getElementById('lbNewNameInput');
        input?.focus();
    }
}

// ========================================
// CONTENT PANE
// ========================================

// Mobile: toggle a class on .lb-body so CSS can swap between the world list and the editor.
function setEditingMode(on) {
    document.querySelector('#lorebookModal .lb-body')?.classList.toggle('lb-editing', !!on);
}

function renderEmptyContent() {
    setEditingMode(false);
    const el = document.getElementById('lbContent');
    if (!el) return;
    el.innerHTML = worldsList.length === 0
        ? `<div class="lb-empty">
                <i class="fa-solid fa-book-atlas"></i>
                <p>You don't have any lorebooks yet.</p>
                <div class="lb-empty-actions">
                    <button class="lb-newbook-btn" data-action="empty-new"><i class="fa-solid fa-plus"></i> New Lorebook</button>
                    <button class="lb-import-btn" data-action="empty-import"><i class="fa-solid fa-file-import"></i> Import</button>
                </div>
           </div>`
        : `<div class="lb-empty">
                <i class="fa-solid fa-book-atlas"></i>
                <p>Select a lorebook to edit, or create a new one.</p>
           </div>`;
}

async function selectWorld(fileId) {
    if (fileId === currentWorld) return;
    if (dirty) {
        const ok = await CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them and switch?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        });
        if (!ok) return;
    }

    // No loader on switch: the load is sub-second, so the previous content simply stays until
    // the editor re-renders, which is smoother than flashing a spinner.
    const data = await CoreAPI.getWorldInfoData(fileId);
    if (!data) {
        CoreAPI.showToast('Failed to load lorebook', 'error');
        renderEmptyContent();
        return;
    }
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};

    currentWorld = fileId;
    workingWorld = JSON.parse(JSON.stringify(data));
    originalSnapshot = JSON.stringify(workingWorld);
    dirty = false;
    expandedUids.clear();
    advancedUids.clear();
    entrySearch = '';
    entrySort = 'order';

    setEditingMode(true);
    renderEditor();
    // Barely-there settle so the swap doesn't snap. Scoped here (the switch path), not in
    // renderEditor, so it doesn't replay on every edit-driven re-render.
    document.getElementById('lbContent')?.animate(
        [{ opacity: 0.5 }, { opacity: 1 }],
        { duration: 150, easing: 'ease-out' },
    );
    renderWorldList();
}

// ========================================
// LOREBOOK LIST KEYBOARD NAV (up/down through the sidebar)
// ========================================

// Manager is the frontmost keyboard context (open, nothing on top owning the keys).
function lbNavAllowed() {
    const modal = document.getElementById('lorebookModal');
    if (!modal || modal.classList.contains('hidden')) return false;
    if (document.querySelector('.cl-modal.visible, .confirm-modal:not(.hidden)')) return false;
    const cm = document.getElementById('charModal');
    if (cm && !cm.classList.contains('hidden')) return false;
    return true;
}

// Up/down load the prev/next lorebook (clamped; first press picks an end); selectWorld owns the
// unsaved-edits guard. After it switches, keep the now-active sidebar row in view.
function moveActiveWorld(dir) {
    const worlds = filteredSortedWorlds();
    if (!worlds.length) return;
    let idx = worlds.findIndex(w => w.file_id === currentWorld);
    if (idx === -1) idx = dir > 0 ? 0 : worlds.length - 1;
    else idx = Math.max(0, Math.min(worlds.length - 1, idx + dir));
    const target = worlds[idx];
    if (!target || target.file_id === currentWorld) return;
    Promise.resolve(selectWorld(target.file_id)).then(() => {
        document.querySelector('#lbWorldList .lb-world-row.active')?.scrollIntoView({ block: 'nearest' });
    });
}

// ========================================
// EDITOR RENDER
// ========================================

function sortedEntries() {
    const list = Object.values(workingWorld.entries).filter(e => e && typeof e === 'object');
    const q = entrySearch.trim().toLowerCase();
    let filtered = list;
    if (q) {
        filtered = list.filter(e =>
            (e.comment || '').toLowerCase().includes(q) ||
            (e.content || '').toLowerCase().includes(q) ||
            (Array.isArray(e.key) ? e.key.join(' ') : '').toLowerCase().includes(q) ||
            (Array.isArray(e.keysecondary) ? e.keysecondary.join(' ') : '').toLowerCase().includes(q)
        );
    }
    switch (entrySort) {
        case 'title':
            filtered.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')); break;
        case 'added':
            filtered.sort((a, b) => Number(a.uid) - Number(b.uid)); break;
        case 'added_desc':
            filtered.sort((a, b) => Number(b.uid) - Number(a.uid)); break;
        default: // order ascending (lower order inserts higher)
            filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || Number(a.uid) - Number(b.uid));
    }
    return filtered;
}

function renderEditor() {
    const el = document.getElementById('lbContent');
    if (!el || !workingWorld) return;

    const entries = sortedEntries();
    const total = Object.keys(workingWorld.entries).length;
    const displayName = currentWorld; // the filename (file_id) is the canonical name, matching ST
    const usingChats = usedByMode === 'chats';

    el.innerHTML = `
        <div class="lb-editor">
            <div class="lb-editor-head">
                <div class="lb-editor-title-row">
                    <h3 class="lb-editor-title" id="lbWorldTitle" title="${esc(displayName)}">${esc(displayName)}</h3>
                    <div class="lb-editor-actions">
                        <button class="lb-save-btn${dirty ? ' dirty' : ''}" id="lbSaveBtn" data-action="save" ${dirty ? '' : 'disabled'} title="Save changes">
                            <i class="fa-solid fa-floppy-disk"></i> <span>${dirty ? 'Save *' : 'Saved'}</span>
                        </button>
                        <button class="lb-link-btn lb-action-desktop" data-action="${usingChats ? 'bind-chats' : 'link-chars'}" title="${usingChats ? 'Bind this lorebook to chats' : 'Link this lorebook to characters'}">
                            <i class="fa-solid fa-${usingChats ? 'comments' : 'link'}"></i> <span>${usingChats ? 'Bind' : 'Link'}</span>
                        </button>
                        <button class="lb-icon-btn lb-action-desktop" data-action="rename-world" title="Rename"><i class="fa-solid fa-pen"></i></button>
                        <button class="lb-icon-btn lb-action-desktop" data-action="duplicate-world" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
                        <button class="lb-icon-btn lb-action-desktop" data-action="export-world" title="Export JSON"><i class="fa-solid fa-file-export"></i></button>
                        <button class="lb-icon-btn danger lb-action-desktop" data-action="delete-world" title="Delete"><i class="fa-solid fa-trash"></i></button>
                        <div class="lb-editor-overflow lb-action-mobile">
                            <button class="lb-icon-btn" data-action="editor-overflow" aria-label="More actions" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                            <div class="lb-split-menu lb-editor-overflow-menu hidden" id="lbEditorOverflowMenu">
                                <button class="dropdown-item" data-action="${usingChats ? 'bind-chats' : 'link-chars'}"><i class="fa-solid fa-${usingChats ? 'comments' : 'link'}"></i> ${usingChats ? 'Bind to chats' : 'Link to characters'}</button>
                                <button class="dropdown-item" data-action="rename-world"><i class="fa-solid fa-pen"></i> Rename</button>
                                <button class="dropdown-item" data-action="duplicate-world"><i class="fa-solid fa-clone"></i> Duplicate</button>
                                <button class="dropdown-item" data-action="export-world"><i class="fa-solid fa-file-export"></i> Export JSON</button>
                                <button class="dropdown-item lb-overflow-danger" data-action="delete-world"><i class="fa-solid fa-trash"></i> Delete</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="lb-editor-meta">
                    <span class="lb-meta-pill"><i class="fa-solid fa-list"></i> ${total} ${total === 1 ? 'entry' : 'entries'}</span>
                    ${usingChats ? renderBoundChatChips() : renderLinkedChips(linkedMap.get(currentWorld) || [])}
                </div>
            </div>

            <div class="lb-entries-toolbar">
                <div class="lb-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" id="lbEntrySearch" class="cl-input" placeholder="Search entries..." value="${esc(entrySearch)}" autocomplete="off">
                </div>
                <select id="lbEntrySort" class="lb-sort-select">
                    <option value="order"${entrySort === 'order' ? ' selected' : ''}>By Order</option>
                    <option value="title"${entrySort === 'title' ? ' selected' : ''}>By Title</option>
                    <option value="added"${entrySort === 'added' ? ' selected' : ''}>Oldest first</option>
                    <option value="added_desc"${entrySort === 'added_desc' ? ' selected' : ''}>Newest first</option>
                </select>
                <div class="lb-toolbar-spacer"></div>
                ${(() => {
                    const allExpanded = entries.length > 0 && entries.every(e => expandedUids.has(e.uid));
                    return `<button class="lb-icon-btn" data-action="toggle-all" title="${allExpanded ? 'Collapse all' : 'Expand all'}"><i class="fa-solid ${allExpanded ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center fa-rotate-90'}"></i></button>`;
                })()}
                <button class="lb-ai-entry-btn" data-action="ai-generate" title="Generate entries with AI"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="lb-ai-entry-label">AI</span></button>
                <button class="lb-add-entry-btn" data-action="add-entry" title="Add entry"><i class="fa-solid fa-plus"></i><span class="lb-add-full">Add Entry</span><span class="lb-add-short">Add</span></button>
            </div>

            <div class="lb-entries" id="lbEntries">
                ${entries.length ? entries.map(e => renderEntryRow(e)).join('') : renderNoEntries(total)}
            </div>
        </div>`;

    const sortSel = document.getElementById('lbEntrySort');
    if (sortSel) CoreAPI.initCustomSelect(sortSel);
    growVisibleContentFields(); // fit each open entry's content field to its text
}

function renderNoEntries(total) {
    return total === 0
        ? `<div class="lb-entries-empty">
                <i class="fa-solid fa-feather"></i>
                <p>This lorebook is empty.</p>
                <button class="lb-add-entry-btn" data-action="add-entry"><i class="fa-solid fa-plus"></i> Add your first entry</button>
           </div>`
        : `<div class="lb-entries-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No entries match "${esc(entrySearch)}".</p></div>`;
}

function renderLinkedChips(linked) {
    if (!linked.length) return `<span class="lb-meta-pill subtle"><i class="fa-solid fa-link-slash"></i> No linked characters</span>`;
    const chips = linked.slice(0, 8).map(l => `
        <span class="lb-linked-chip">
            <button class="lb-linked-chip-open" data-action="open-char" data-avatar="${esc(l.avatar)}" title="Open ${esc(l.name)}">
                <img src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(l.avatar))}" alt="" loading="lazy">
                <span>${esc(l.name)}</span>
            </button>
            <button class="lb-linked-chip-x" data-action="unlink-char" data-avatar="${esc(l.avatar)}" title="Unlink this lorebook from ${esc(l.name)}">&times;</button>
        </span>`).join('');
    const more = linked.length > 8 ? `<button class="lb-linked-more" data-action="manage-links" title="See all ${linked.length} linked characters">+${linked.length - 8} more</button>` : '';
    return `<span class="lb-linked-chips">${chips}${more}</span>`;
}

// Chats-lens equivalent of renderLinkedChips: the chats bound to the current world.
function renderBoundChatChips() {
    if (!chatIndexLoaded) return `<span class="lb-meta-pill subtle"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats...</span>`;
    const bound = chatBoundMap.get(currentWorld) || [];
    if (!bound.length) return `<span class="lb-meta-pill subtle"><i class="fa-solid fa-link-slash"></i> No chats use this lorebook</span>`;
    const chips = bound.slice(0, 8).map((c, i) => {
        const chatName = (c.file_name || '').replace(/\.jsonl$/i, '');
        const label = `${c.charName}: ${chatName}`;
        return `
        <span class="lb-linked-chip">
            <button class="lb-linked-chip-open" data-action="open-bound-chat" data-idx="${i}" title="Open ${esc(c.charName)}">
                <img src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy">
                <span>${esc(label)}</span>
            </button>
            <button class="lb-linked-chip-x" data-action="unbind-chat" data-idx="${i}" title="Unbind this lorebook from the chat">&times;</button>
        </span>`;
    }).join('');
    const more = bound.length > 8 ? `<button class="lb-linked-more" data-action="manage-links" title="See all ${bound.length} bound chats">+${bound.length - 8} more</button>` : '';
    return `<span class="lb-linked-chips">${chips}${more}</span>`;
}

// ========================================
// ENTRY ROW
// ========================================

function entryTitle(e) {
    return e.comment?.trim() || (Array.isArray(e.key) && e.key.length ? e.key.join(', ') : 'Untitled Entry');
}

function entryRowHtml(e) {
    const expanded = expandedUids.has(e.uid);
    const isConstant = !!e.constant;
    const keysPreview = isConstant
        ? 'always on'
        : (Array.isArray(e.key) && e.key.length ? e.key.join(', ') : '(no keys)');
    const badges = [];
    if (isConstant) badges.push(`<span class="lb-badge constant" title="Constant: always sent"><i class="fa-solid fa-anchor"></i></span>`);
    if (e.vectorized) badges.push(`<span class="lb-badge vector" title="Vectorized: vector-similarity match"><i class="fa-solid fa-cube"></i></span>`);
    if (!isConstant && Array.isArray(e.keysecondary) && e.keysecondary.length) badges.push(`<span class="lb-badge selective" title="Has an optional secondary-key filter"><i class="fa-solid fa-filter"></i></span>`);
    const posLabel = (POSITION_OPTIONS.find(p => p[0] === Number(e.position)) || [0, ''])[1];

    return `
        <div class="lb-entry-head" data-action="toggle-entry" data-uid="${esc(e.uid)}">
            <label class="lb-switch" title="${e.disable ? 'Disabled' : 'Enabled'}" data-stop>
                <input type="checkbox" data-field="disable" data-uid="${esc(e.uid)}" data-type="bool-inv" ${e.disable ? '' : 'checked'}>
                <span class="lb-switch-track"></span>
            </label>
            <div class="lb-entry-summary">
                <div class="lb-entry-title-line">
                    <span class="lb-entry-title">${esc(entryTitle(e))}</span>
                    <span class="lb-entry-badges">${badges.join('')}</span>
                </div>
                <div class="lb-entry-sub">
                    <span class="lb-entry-keys" title="${esc(keysPreview)}"><i class="fa-solid fa-key"></i> ${esc(keysPreview)}</span>
                    <span class="lb-entry-pos" title="Insertion position"><i class="fa-solid fa-location-dot"></i> ${esc(posLabel)}</span>
                    <span class="lb-entry-order" title="Insertion order">#${esc(e.order ?? 100)}</span>
                </div>
            </div>
            <div class="lb-entry-head-actions">
                <button class="lb-icon-btn small" data-action="duplicate-entry" data-uid="${esc(e.uid)}" title="Duplicate entry"><i class="fa-solid fa-clone"></i></button>
                <button class="lb-icon-btn small danger" data-action="delete-entry" data-uid="${esc(e.uid)}" title="Delete entry"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-down lb-entry-chevron${expanded ? ' open' : ''}"></i>
            </div>
        </div>
        ${expanded ? `<div class="lb-entry-body">${renderEntryBody(e)}</div>` : ''}`;
}

function renderEntryRow(e) {
    const expanded = expandedUids.has(e.uid);
    return `<div class="lb-entry${expanded ? ' expanded' : ''}${e.disable ? ' disabled' : ''}" id="lbEntry-${esc(e.uid)}">${entryRowHtml(e)}</div>`;
}

function refreshRow(uid) {
    const e = workingWorld.entries[uid];
    const rowEl = document.getElementById(`lbEntry-${uid}`);
    if (!e || !rowEl) return;
    const expanded = expandedUids.has(uid);
    rowEl.className = `lb-entry${expanded ? ' expanded' : ''}${e.disable ? ' disabled' : ''}`;
    rowEl.innerHTML = entryRowHtml(e);
    if (expanded) growVisibleContentFields(rowEl);
}

// Update only the collapsed-summary header bits in place (keeps text-field focus while typing).
function refreshRowHeader(uid) {
    const e = workingWorld.entries[uid];
    const rowEl = document.getElementById(`lbEntry-${uid}`);
    if (!e || !rowEl) return;
    const titleEl = rowEl.querySelector('.lb-entry-title');
    if (titleEl) titleEl.textContent = entryTitle(e);
    const keysEl = rowEl.querySelector('.lb-entry-keys');
    if (keysEl) {
        const preview = Array.isArray(e.key) && e.key.length ? e.key.join(', ') : '(no keys)';
        keysEl.innerHTML = `<i class="fa-solid fa-key"></i> ${esc(preview)}`;
        keysEl.title = preview;
    }
    const orderEl = rowEl.querySelector('.lb-entry-order');
    if (orderEl) orderEl.textContent = `#${e.order ?? 100}`;
}

// Grow a content textarea to fit its text; rows="5" stays the floor (height:auto reverts to it),
// CSS max-height caps it.
function autoGrowLb(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
}

// Fit every open entry's content field to its text. Batched (reset all, read all, then write all)
// so expanding many entries at once doesn't thrash layout per textarea.
function growVisibleContentFields(scope) {
    const tas = (scope || document.getElementById('lbEntries'))?.querySelectorAll('textarea.lb-textarea');
    if (!tas || !tas.length) return;
    tas.forEach(ta => { ta.style.height = 'auto'; });
    const heights = Array.from(tas, ta => ta.scrollHeight);
    tas.forEach((ta, i) => { ta.style.height = `${heights[i]}px`; });
}

// ========================================
// ENTRY EDITOR BODY (fields)
// ========================================

function fieldId(uid, field) { return `lbf-${uid}-${field}`; }

function textInput(uid, field, value, { placeholder = '', type = 'string' } = {}) {
    return `<input class="cl-input" id="${fieldId(uid, field)}" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off">`;
}

function numberInput(uid, field, value, { placeholder = '', min, max, step } = {}) {
    const type = NULLABLE_NUMBERS.has(field) ? 'number-null' : 'number';
    const attrs = [
        min !== undefined ? `min="${min}"` : '',
        max !== undefined ? `max="${max}"` : '',
        step !== undefined ? `step="${step}"` : '',
    ].join(' ');
    const v = value === null || value === undefined ? '' : value;
    return `<input class="cl-input lb-input-num" type="number" id="${fieldId(uid, field)}" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}" value="${esc(v)}" placeholder="${esc(placeholder)}" ${attrs} autocomplete="off">`;
}

function toggle(uid, field, value, label, { inverted = false } = {}) {
    const checked = inverted ? !value : !!value;
    return `
        <label class="lb-check">
            <input type="checkbox" data-field="${field}" data-uid="${esc(uid)}" data-type="${inverted ? 'bool-inv' : 'bool'}" ${checked ? 'checked' : ''}>
            <span class="lb-check-box"></span>
            <span class="lb-check-label">${esc(label)}</span>
        </label>`;
}

function selectInput(uid, field, value, options, { type = 'int' } = {}) {
    const opts = options.map(([v, label]) =>
        `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<select class="cl-input lb-select" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}">${opts}</select>`;
}

function pillField(uid, field, values) {
    const arr = Array.isArray(values) ? values : [];
    const pills = arr.map((k, i) => `
        <span class="lb-pill">${esc(k)}<button class="lb-pill-x" data-action="remove-key" data-uid="${esc(uid)}" data-field="${field}" data-index="${i}" title="Remove">&times;</button></span>`).join('');
    return `
        <div class="lb-pill-field" data-pillfield="${field}" data-uid="${esc(uid)}">
            ${pills}
            <input type="text" class="lb-pill-input" data-action="add-key" data-uid="${esc(uid)}" data-field="${field}" placeholder="${arr.length ? '' : 'Type a keyword, Enter to add'}" autocomplete="off">
        </div>`;
}

function fieldGroup(label, control, hint = '') {
    return `<div class="lb-field"><label class="lb-field-label">${esc(label)}</label>${control}${hint ? `<span class="lb-field-hint">${esc(hint)}</span>` : ''}</div>`;
}

function entryState(e) {
    // ST treats constant/normal/vectorized as one mutually-exclusive state, not 3 toggles.
    return e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'normal';
}

function renderEntryBody(e) {
    const uid = e.uid;
    const advOpen = advancedUids.has(uid);
    const atDepth = Number(e.position) === 4;
    const isOutlet = Number(e.position) === 7;
    const state = entryState(e);
    const keyDriven = state !== 'constant'; // constant always fires, keywords are irrelevant

    const stateSeg = `
        <div class="lb-state-seg" role="group" aria-label="Entry status">
            <button class="lb-state-opt${state === 'normal' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="normal" title="Activates when a keyword is found in chat">
                <i class="fa-solid fa-circle"></i> Normal
            </button>
            <button class="lb-state-opt${state === 'constant' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="constant" title="Always inserted into the prompt">
                <i class="fa-solid fa-anchor"></i> Constant
            </button>
            <button class="lb-state-opt${state === 'vectorized' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="vectorized" title="Activates when the message matches by vector similarity">
                <i class="fa-solid fa-cube"></i> Vectorized
            </button>
        </div>`;

    const main = `
        <div class="lb-body-section">
            <div class="lb-field-grid two">
                ${fieldGroup('Title / Memo', textInput(uid, 'comment', e.comment, { placeholder: 'A label for this entry' }))}
                ${fieldGroup('Status', stateSeg, state === 'constant'
                    ? 'Always sent to the AI, regardless of keywords.'
                    : state === 'vectorized'
                        ? 'Activated by vector similarity. Keywords below are the vector source.'
                        : 'Activated when a primary keyword appears in chat.')}
            </div>
            ${fieldGroup('Content', `<textarea class="cl-input lb-textarea" data-field="content" data-uid="${esc(uid)}" data-type="string" rows="5" placeholder="The lore text injected when this entry triggers...">${esc(e.content)}</textarea>`)}
        </div>`;

    const keywordRow = keyDriven ? `
            <div class="lb-keys-row">
                <div class="lb-keys-primary">
                    ${fieldGroup(state === 'vectorized' ? 'Keywords (vector source)' : 'Primary Keywords', pillField(uid, 'key', e.key))}
                </div>
                <div class="lb-keys-logic">
                    ${fieldGroup('Logic', selectInput(uid, 'selectiveLogic', e.selectiveLogic, LOGIC_OPTIONS))}
                </div>
                <div class="lb-keys-secondary">
                    ${fieldGroup('Optional Filter', pillField(uid, 'keysecondary', e.keysecondary), 'Refines the match; ignored when empty')}
                </div>
            </div>` : '';

    const logic = `
        <div class="lb-body-section">
            <div class="lb-section-title">Activation</div>
            ${keywordRow}
            <div class="lb-field-grid ${atDepth ? 'three' : 'two'}">
                ${fieldGroup('Position', selectInput(uid, 'position', e.position, POSITION_OPTIONS))}
                ${atDepth ? fieldGroup('Depth', numberInput(uid, 'depth', e.depth, { placeholder: '4', min: 0 })) : ''}
                ${atDepth ? fieldGroup('Role', selectInput(uid, 'role', e.role, ROLE_OPTIONS)) : ''}
                ${isOutlet ? fieldGroup('Outlet Name', textInput(uid, 'outletName', e.outletName, { placeholder: 'macro name' })) : ''}
            </div>
            <div class="lb-field-grid three">
                ${fieldGroup('Insertion Order', numberInput(uid, 'order', e.order, { placeholder: '100' }), 'Lower inserts higher')}
                ${fieldGroup('Trigger %', numberInput(uid, 'probability', e.probability, { placeholder: '100', min: 0, max: 100 }))}
                <div class="lb-field lb-field-inline"><label class="lb-field-label lb-field-label-spacer" aria-hidden="true">&nbsp;</label>${toggle(uid, 'useProbability', e.useProbability, 'Use trigger %')}</div>
            </div>
        </div>`;

    const advanced = `
        <div class="lb-advanced">
            <button class="lb-advanced-toggle" data-action="toggle-advanced" data-uid="${esc(uid)}">
                <i class="fa-solid fa-chevron-${advOpen ? 'down' : 'right'}"></i> Advanced
            </button>
            ${advOpen ? `
            <div class="lb-advanced-body">
                <div class="lb-section-title">Recursion</div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'excludeRecursion', e.excludeRecursion, 'Non-recursable (won\'t be activated by others)')}
                    ${toggle(uid, 'preventRecursion', e.preventRecursion, 'Prevent further recursion')}
                </div>
                <div class="lb-field-grid two">
                    ${fieldGroup('Delay until recursion', numberInput(uid, 'delayUntilRecursion', e.delayUntilRecursion, { placeholder: '0', min: 0 }))}
                    <div></div>
                </div>

                <div class="lb-section-title">Inclusion Group</div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Group label(s)', textInput(uid, 'group', e.group, { placeholder: 'comma,separated' }))}
                    ${fieldGroup('Group weight', numberInput(uid, 'groupWeight', e.groupWeight, { placeholder: '100', min: 0 }))}
                    ${fieldGroup('Use group scoring', selectInput(uid, 'useGroupScoring', tristateValue(e.useGroupScoring), TRISTATE_OPTIONS, { type: 'tristate' }))}
                </div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'groupOverride', e.groupOverride, 'Prioritize (group override)')}
                </div>

                <div class="lb-section-title">Scan Overrides <span class="lb-section-sub">(blank = use global)</span></div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Scan depth', numberInput(uid, 'scanDepth', e.scanDepth, { placeholder: 'global', min: 0 }))}
                    ${fieldGroup('Case-sensitive', selectInput(uid, 'caseSensitive', tristateValue(e.caseSensitive), TRISTATE_OPTIONS, { type: 'tristate' }))}
                    ${fieldGroup('Match whole words', selectInput(uid, 'matchWholeWords', tristateValue(e.matchWholeWords), TRISTATE_OPTIONS, { type: 'tristate' }))}
                </div>

                <div class="lb-section-title">Timed Effects <span class="lb-section-sub">(blank = off)</span></div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Sticky', numberInput(uid, 'sticky', e.sticky, { placeholder: 'off', min: 0 }))}
                    ${fieldGroup('Cooldown', numberInput(uid, 'cooldown', e.cooldown, { placeholder: 'off', min: 0 }))}
                    ${fieldGroup('Delay', numberInput(uid, 'delay', e.delay, { placeholder: 'off', min: 0 }))}
                </div>

                <div class="lb-section-title">Additional Matching Sources</div>
                <div class="lb-toggle-grid">
                    ${MATCH_SOURCES.map(([f, label]) => toggle(uid, f, e[f], label)).join('')}
                </div>

                <div class="lb-section-title">Misc</div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'ignoreBudget', e.ignoreBudget, 'Ignore token budget')}
                </div>
                <div class="lb-field-grid two">
                    ${fieldGroup('Automation ID', textInput(uid, 'automationId', e.automationId, { placeholder: 'optional' }))}
                    <div></div>
                </div>
            </div>` : ''}
        </div>`;

    return main + logic + advanced;
}

function tristateValue(v) {
    if (v === null || v === undefined) return '';
    return v ? 'true' : 'false';
}

// ========================================
// MUTATIONS
// ========================================

function markDirty() {
    // Once dirty, stay dirty until save resets the snapshot. Skips a full
    // JSON.stringify of the working copy on every keystroke for large books.
    if (dirty) return;
    dirty = JSON.stringify(workingWorld) !== originalSnapshot;
    if (dirty) updateSaveButton();
}

function updateSaveButton() {
    const btn = document.getElementById('lbSaveBtn');
    if (!btn) return;
    btn.disabled = !dirty;
    btn.classList.toggle('dirty', dirty);
    const label = btn.querySelector('span');
    if (label) label.textContent = dirty ? 'Save *' : 'Saved';
}

function nextUid() {
    const uids = Object.keys(workingWorld.entries).map(Number).filter(n => !isNaN(n));
    return uids.length ? Math.max(...uids) + 1 : 0;
}

function coerceStore(uid, field, type, rawValue) {
    const e = workingWorld.entries[uid];
    if (!e) return;
    let value;
    switch (type) {
        case 'bool': value = !!rawValue; break;
        case 'bool-inv': value = !rawValue; break;
        case 'number': value = rawValue === '' ? 0 : Number(rawValue); break;
        case 'number-null': value = rawValue === '' ? null : Number(rawValue); break;
        case 'int': value = Number(rawValue); break;
        case 'tristate': value = rawValue === '' ? null : rawValue === 'true'; break;
        default: value = rawValue;
    }
    e[field] = value;
    if (field === 'comment') e.addMemo = !!String(value).trim();
}

function addEntry() {
    const uid = nextUid();
    workingWorld.entries[uid] = newEntry(uid, uid);
    expandedUids.add(uid);
    markDirty();
    renderEditor();
    // Scroll the new entry into view
    requestAnimationFrame(() => {
        document.getElementById(`lbEntry-${uid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}

function duplicateEntry(uid) {
    const src = workingWorld.entries[uid];
    if (!src) return;
    const newId = nextUid();
    const clone = JSON.parse(JSON.stringify(src));
    clone.uid = newId;
    clone.displayIndex = newId;
    clone.comment = (clone.comment || 'Untitled') + ' (copy)';
    workingWorld.entries[newId] = clone;
    expandedUids.add(newId);
    markDirty();
    renderEditor();
}

async function deleteEntry(uid) {
    const e = workingWorld.entries[uid];
    if (!e) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete entry?',
        message: `Delete "${entryTitle(e)}" from this lorebook?`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    delete workingWorld.entries[uid];
    expandedUids.delete(uid);
    advancedUids.delete(uid);
    markDirty();
    renderEditor();
}

async function saveWorld() {
    if (!dirty || !currentWorld) return;
    // An entry with secondary keys is selective in the V2/V3 spec; keep the flag in sync on save.
    for (const e of Object.values(workingWorld.entries || {})) {
        if (e && Array.isArray(e.keysecondary) && e.keysecondary.length && !e.selective) {
            e.selective = true;
        }
    }
    const btn = document.getElementById('lbSaveBtn');
    if (btn) { btn.disabled = true; btn.classList.add('saving'); }
    const ok = await CoreAPI.saveWorldInfoData(currentWorld, workingWorld);
    if (btn) btn.classList.remove('saving');
    if (ok) {
        originalSnapshot = JSON.stringify(workingWorld);
        dirty = false;
        entryCountCache.set(currentWorld, Object.keys(workingWorld.entries).length);
        updateSaveButton();
        renderWorldList();
        CoreAPI.showToast('Lorebook saved. Reload SillyTavern or re-select the character to apply.', 'success', 5000);
    } else {
        if (btn) btn.disabled = false;
        CoreAPI.showToast('Failed to save lorebook', 'error');
    }
}

// ========================================
// WORLD-LEVEL OPS
// ========================================

function startCreate() {
    creatingNew = true;
    renderWorldList();
}

async function commitCreate(name) {
    creatingNew = false;
    // Use the name ST will actually store on disk, so our state and the server agree.
    const fileId = sanitizeWorldName(name);
    if (!fileId) {
        if ((name || '').trim()) CoreAPI.showToast('That name has no usable filename characters', 'warning');
        renderWorldList();
        return;
    }
    if (worldsList.some(w => w.file_id.toLowerCase() === fileId.toLowerCase())) {
        CoreAPI.showToast('A lorebook with that name already exists', 'warning');
        renderWorldList();
        return;
    }
    const ok = await CoreAPI.createWorldInfo(fileId);
    if (!ok) { CoreAPI.showToast('Failed to create lorebook', 'error'); renderWorldList(); return; }
    await refreshList();
    await selectWorld(fileId);
    CoreAPI.showToast(`Created "${fileId}"`, 'success');
}

function startRename() {
    const titleEl = document.getElementById('lbWorldTitle');
    if (!titleEl || titleEl.querySelector('input')) return;
    const current = currentWorld;
    titleEl.innerHTML = `<input type="text" class="lb-rename-input" id="lbRenameInput" value="${esc(current)}" autocomplete="off">`;
    const input = document.getElementById('lbRenameInput');
    input?.focus();
    input?.select();
    // Enter and blur both commit; the guard stops the post-Enter blur from double-firing.
    let done = false;
    const commit = async () => {
        if (done) return;
        done = true;
        const newName = sanitizeWorldName(input.value);
        if (!newName || newName === current) { renderEditor(); return; }
        if (worldsList.some(w => w.file_id.toLowerCase() === newName.toLowerCase())) {
            CoreAPI.showToast('A lorebook with that name already exists', 'warning');
            renderEditor();
            return;
        }
        await doRename(current, newName);
    };
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); done = true; renderEditor(); }
    });
    input?.addEventListener('blur', commit, { once: true });
}

async function doRename(oldName, newName) {
    // Persist any pending edits into the new file as part of the rename copy.
    if (dirty) {
        const saved = await CoreAPI.saveWorldInfoData(oldName, workingWorld);
        if (saved) { originalSnapshot = JSON.stringify(workingWorld); dirty = false; }
    }
    // Snapshot the characters linked to the OLD name before the rename, so we can
    // offer to re-point them (ST's own rename does this; copy+delete alone dangles them).
    const linkedBefore = (linkedMap.get(oldName) || []).slice();

    const ok = await CoreAPI.renameWorldInfo(oldName, newName);
    if (!ok) { CoreAPI.showToast('Rename failed', 'error'); renderEditor(); return; }
    currentWorld = newName;

    // Chat-bound links (chat_metadata.world_info) aren't swept on rename; the success toast warns
    // the user to rebind. Suppressed only when the Chats index is built and shows zero (no scan here).
    const knownZeroChats = chatIndexLoaded && !(chatBoundMap.get(oldName) || []).length;
    const chatCaveat = knownZeroChats ? '' : ' Bound chats keep the old name, rebind from the Chats lens.';

    // Re-point primary character links (data.extensions.world) from old to new name.
    if (linkedBefore.length) {
        const confirmRelink = await CoreAPI.showConfirm({
            title: 'Update linked characters?',
            message: `${linkedBefore.length} character${linkedBefore.length === 1 ? '' : 's'} link "${oldName}" as their primary lorebook. Re-point them to "${newName}"? (Otherwise those links will break.)`,
            confirmLabel: 'Re-point links',
            cancelLabel: 'Leave them',
        });
        if (confirmRelink) {
            let relinked = 0;
            for (const l of linkedBefore) {
                const okRelink = await CoreAPI.applyCardFieldUpdates(l.avatar, { 'extensions.world': newName });
                if (okRelink) relinked++;
            }
            buildLinkedMap();
            CoreAPI.showToast(`Renamed to "${newName}"; re-pointed ${relinked} character${relinked === 1 ? '' : 's'}.${chatCaveat}`, 'success', 5000);
            await refreshList({ keepSelection: true });
            renderEditor();
            return;
        }
    }

    await refreshList({ keepSelection: true });
    renderEditor();
    if (chatCaveat) {
        CoreAPI.showToast(`Renamed to "${newName}".${chatCaveat}`, 'success', 6000);
    } else {
        CoreAPI.showToast(`Renamed to "${newName}"`, 'success');
    }
}

async function duplicateWorld() {
    if (!currentWorld) return;
    // currentWorld is already a sanitized file_id; the " (copy)" suffix has no illegal
    // chars, so sanitizeWorldName here is a no-op safety net rather than a behavior change.
    let name = sanitizeWorldName(`${currentWorld} (copy)`);
    let n = 2;
    while (worldsList.some(w => w.file_id.toLowerCase() === name.toLowerCase())) {
        name = sanitizeWorldName(`${currentWorld} (copy ${n++})`);
    }
    const data = await CoreAPI.getWorldInfoData(currentWorld);
    if (!data) { CoreAPI.showToast('Could not read source lorebook', 'error'); return; }
    const ok = await CoreAPI.importWorldInfoData(name, data);
    if (!ok) { CoreAPI.showToast('Duplicate failed', 'error'); return; }
    await refreshList();
    await selectWorld(name);
    CoreAPI.showToast(`Duplicated as "${name}"`, 'success');
}

function exportWorld() {
    if (!workingWorld || !currentWorld) return;
    const blob = new Blob([JSON.stringify(workingWorld, null, 4)], { type: 'application/json' });
    CoreAPI.downloadBlobAsFile(blob, `${currentWorld}.json`);
}

async function deleteWorld() {
    if (!currentWorld) return;
    const deletedName = currentWorld;
    // Snapshot linked characters before delete so we can offer to clear their dangling links.
    const linkedChars = (linkedMap.get(currentWorld) || []).slice();
    const linked = linkedChars.length;

    const ok = await CoreAPI.showConfirm({
        title: 'Delete lorebook?',
        message: linked > 0
            ? `"${deletedName}" is linked to ${linked} character${linked === 1 ? '' : 's'}. Permanently delete it? This cannot be undone.`
            : `Permanently delete "${deletedName}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;

    // If characters link this book, ask whether to also clear those (now-dangling) links.
    // ST's own delete leaves every non-active character pointing at the deleted file.
    let clearLinks = false;
    if (linked > 0) {
        clearLinks = await CoreAPI.showConfirm({
            title: 'Unlink characters too?',
            message: `Also remove the link from the ${linked} character${linked === 1 ? '' : 's'} that used "${deletedName}"? Otherwise ${linked === 1 ? 'it' : 'they'} will point at a deleted lorebook.`,
            confirmLabel: 'Unlink them',
            cancelLabel: 'Leave links',
        });
    }

    const done = await CoreAPI.deleteWorldInfo(deletedName);
    if (!done) { CoreAPI.showToast('Delete failed', 'error'); return; }

    let cleared = 0;
    if (clearLinks) {
        for (const l of linkedChars) {
            const okClear = await CoreAPI.applyCardFieldUpdates(l.avatar, { 'extensions.world': '' });
            if (okClear) cleared++;
        }
    }

    entryCountCache.delete(deletedName);
    currentWorld = null;
    workingWorld = null;
    dirty = false;
    buildLinkedMap();
    await refreshList();
    renderEmptyContent();
    CoreAPI.showToast(
        cleared > 0
            ? `Deleted "${deletedName}" and unlinked ${cleared} character${cleared === 1 ? '' : 's'}.`
            : `Deleted "${deletedName}"`,
        'success', cleared > 0 ? 5000 : 3000,
    );
}

/**
 * Unlink the current world from one character (clears that card's extensions.world).
 * ST's unlinked state is an empty-string world, not a deleted key. The world file is
 * untouched; only the character's primary link is removed.
 */
async function unlinkCharFromCurrentWorld(avatar) {
    if (!currentWorld || !avatar) return;
    const entry = (linkedMap.get(currentWorld) || []).find(l => l.avatar === avatar);
    const charName = entry?.name || avatar;
    const ok = await CoreAPI.showConfirm({
        title: 'Unlink character?',
        message: `Unlink "${currentWorld}" from ${charName}? The lorebook is kept; only this character's link is removed.`,
        confirmLabel: 'Unlink',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    const success = await CoreAPI.applyCardFieldUpdates(avatar, { 'extensions.world': '' }, { awaitNotify: true });
    if (!success) { CoreAPI.showToast('Failed to unlink', 'error'); return; }
    buildLinkedMap();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(`Unlinked from ${charName}.`, 'success', 5000);
}

/**
 * Unbind the current world from one chat (clears that chat's chat_metadata.world_info).
 * Routes through the hardened chat-write helper (integrity-safe, active-chat-guarded).
 * @param {{avatar, charName, char, file_name}} c - a bound-chat entry from chatBoundMap
 */
async function unbindChatFromCurrentWorld(c) {
    if (!currentWorld || !c?.file_name) return;
    const chatName = (c.file_name || '').replace(/\.jsonl$/i, '');
    const ok = await CoreAPI.showConfirm({
        title: 'Unbind chat?',
        message: `Unbind "${currentWorld}" from ${c.charName}'s chat "${chatName}"? The lorebook is kept; only this chat's binding is removed.`,
        confirmLabel: 'Unbind',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    const charRef = c.char || { avatar: c.avatar, name: c.charName };
    const success = await CoreAPI.setChatBoundWorld(charRef, c.file_name, '');
    if (!success) { CoreAPI.showToast('Failed to unbind (the chat may be open in SillyTavern)', 'error'); return; }
    // Update the in-memory reverse index, then re-render.
    const list = (chatBoundMap.get(currentWorld) || []).filter(x => x.file_name !== c.file_name);
    if (list.length) chatBoundMap.set(currentWorld, list);
    else chatBoundMap.delete(currentWorld);
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(`Unbound from "${chatName}". Reopen the chat in ST to apply.`, 'success', 5000);
}

// ========================================
// IMPORT
// ========================================

async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let imported = 0;
    for (const file of files) {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const baseName = file.name.replace(/\.json$/i, '').trim();

            let native;
            let name = baseName;
            if (json && json.entries && !Array.isArray(json.entries) && typeof json.entries === 'object') {
                // Native ST world file (entries object)
                native = json;
                name = json.name || baseName;
            } else if (json && Array.isArray(json.entries)) {
                // Embedded character_book (entries array)
                native = convertCharacterBookToNative(json);
                name = json.name || baseName;
            } else if (json?.data?.character_book?.entries) {
                // Full V2/V3 card JSON: pull the embedded book
                native = convertCharacterBookToNative(json.data.character_book);
                name = json.data.character_book.name || json.data?.name || baseName;
            } else {
                CoreAPI.showToast(`"${file.name}" is not a recognized lorebook`, 'warning');
                continue;
            }

            // Use the name ST will store on disk; fall back if it sanitizes to empty.
            const baseId = sanitizeWorldName(name) || sanitizeWorldName(baseName) || 'Imported Lorebook';
            // Avoid clobbering an existing world silently (compare sanitized ids).
            let finalName = baseId;
            let n = 2;
            while (worldsList.some(w => w.file_id.toLowerCase() === finalName.toLowerCase())) {
                finalName = sanitizeWorldName(`${baseId} (${n++})`);
            }
            const ok = await CoreAPI.importWorldInfoData(finalName, native);
            if (ok) {
                imported++;
                worldsList.push({ file_id: finalName, name: finalName, extensions: {} });
            }
        } catch (err) {
            console.error('[Lorebooks] Import failed for', file.name, err);
            CoreAPI.showToast(`Failed to import "${file.name}"`, 'error');
        }
    }
    if (imported > 0) {
        await refreshList();
        CoreAPI.showToast(`Imported ${imported} lorebook${imported === 1 ? '' : 's'}`, 'success');
    }
}

// ========================================
// LINK PICKER (characters: primary link, chats: chat-bound lore)
// ========================================

function openLinkPicker(initialMode = 'characters', { manage = false } = {}) {
    if (!currentWorld) return;
    linkBook = currentWorld;
    linkMode = initialMode === 'chats' ? 'chats' : 'characters';
    linkManageMode = manage;
    linkSelection = new Set();
    linkSearch = '';
    linkHideLinked = false;
    linkPlaylistUid = '';
    linkPlaylistSet = null;
    linkChatChar = null;
    linkChatList = [];
    linkFiltered = [];
    linkBaseSorted = null; // rebuild the sorted base for this book/mode
    linkRowStride = 0;     // remeasure (desktop vs mobile row height)
    // Manage-chats lists the book's bound chats across all characters (chatBoundMap), since the
    // normal pick-a-character-then-their-chats flow doesn't model a cross-character "all bound" view.
    manageChatList = manage && linkMode === 'chats' ? (chatBoundMap.get(linkBook) || []).slice() : [];
    const nameEl = document.getElementById('lbLinkBookName');
    if (nameEl) nameEl.textContent = currentWorld;
    const verbEl = document.getElementById('lbLinkVerb');
    if (verbEl) verbEl.textContent = manage ? 'Manage links for' : 'Link';
    const searchEl = document.getElementById('lbLinkSearch');
    if (searchEl) searchEl.value = '';
    const hideEl = document.getElementById('lbLinkHideLinked');
    if (hideEl) hideEl.checked = false;
    populateLinkPlaylistFilter();
    document.getElementById('lbLinkHead')?.classList.remove('lb-toolbar-hidden', 'lb-pinned'); // start expanded + unpinned; a prior session may have left either
    syncLinkModeUI();
    setLinkApplyButton();
    renderLinkList();
    updateLinkFooter();
    document.getElementById('lbLinkModal')?.classList.add('visible');
    if (!matchMedia('(pointer: coarse)').matches && !manage) searchEl?.focus();
}

// The apply button reads as Link (primary) or Unlink selected (danger) depending on the mode.
function setLinkApplyButton() {
    const btn = document.getElementById('lbLinkApplyBtn');
    if (!btn) return;
    btn.classList.toggle('cl-btn-danger', linkManageMode);
    btn.classList.toggle('cl-btn-primary', !linkManageMode);
    btn.innerHTML = linkManageMode
        ? `<i class="fa-solid fa-link-slash"></i> Unlink selected <span id="lbLinkApplyCount"></span>`
        : `<i class="fa-solid fa-link"></i> Link <span id="lbLinkApplyCount"></span>`;
}

function closeLinkPicker() {
    document.getElementById('lbLinkModal')?.classList.remove('visible');
}

// Reflect the active mode (set by the entry point: link / bind / manage) on the hint, the search
// placeholder, and the hide-already-linked control (characters-only).
function syncLinkModeUI() {
    const hint = document.getElementById('lbLinkModeHint');
    const searchEl = document.getElementById('lbLinkSearch');
    const hideWrap = document.getElementById('lbLinkHideLinkedWrap');
    syncLinkPlaylistVisibility();
    if (linkManageMode) {
        const what = linkMode === 'chats' ? 'chats bound to' : 'characters linked to';
        if (hint) hint.innerHTML = `Select the ${what} <strong>${esc(linkBook)}</strong> to unlink, then Unlink selected.`;
        if (searchEl) searchEl.placeholder = linkMode === 'chats' ? 'Search bound chats...' : 'Search linked characters...';
        if (hideWrap) hideWrap.style.display = 'none';
        return;
    }
    if (linkMode === 'characters') {
        if (hint) hint.innerHTML = `Set <strong>${esc(linkBook)}</strong> as the <strong>primary</strong> lorebook on the chosen characters (writes to the card).`;
        if (searchEl) searchEl.placeholder = 'Search characters...';
        if (hideWrap) hideWrap.style.display = '';
    } else {
        if (hint) {
            hint.innerHTML = linkChatChar
                ? `Bind <strong>${esc(linkBook)}</strong> to chats of <strong>${esc(linkChatChar.name || linkChatChar.avatar)}</strong> (writes to the chat, not the card).`
                : `Pick a character, then choose which of their chats to bind <strong>${esc(linkBook)}</strong> to (writes to the chat, not the card).`;
        }
        if (searchEl) searchEl.placeholder = linkChatChar ? 'Search chats...' : 'Search characters...';
        if (hideWrap) hideWrap.style.display = 'none';
    }
}

// Playlists group characters, so the filter only makes sense in the characters modes.
function syncLinkPlaylistVisibility() {
    const wrap = document.getElementById('lbLinkPlaylistWrap');
    if (wrap) wrap.style.display = (linkPlaylistAvailable && linkMode === 'characters') ? '' : 'none';
}

// Rebuild the playlist options on each open so renames/new playlists show without a reload.
async function populateLinkPlaylistFilter() {
    const sel = document.getElementById('lbLinkPlaylistFilter');
    if (!sel) return;
    try { await CoreAPI.playlistsLoadPlaylists(); } catch (_) { /* filter just stays hidden */ }
    const lists = CoreAPI.playlistsGetAll() || [];
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All characters';
    sel.appendChild(all);
    for (const pl of lists) {
        const o = document.createElement('option');
        o.value = pl.uid;
        o.textContent = pl.name;
        sel.appendChild(o);
    }
    sel.value = lists.some(p => p.uid === linkPlaylistUid) ? linkPlaylistUid : '';
    sel._customSelect?.refresh();
    linkPlaylistAvailable = lists.length > 0;
    syncLinkPlaylistVisibility();
}

// The world/mode-filtered, name-sorted set, sorted once and cached. The sort (localeCompare,
// matching the main grid) is the costly part, so it never re-runs on a keystroke or a
// row toggle; only a mode/hide-linked/open change invalidates it.
function linkBaseList() {
    if (linkBaseSorted) return linkBaseSorted;
    const chars = (CoreAPI.getAllCharacters() || []).filter(c => c && c.avatar);
    linkBaseSorted = chars.filter(c => {
        if (linkPlaylistSet && !linkPlaylistSet.has(c.avatar)) return false;
        const cur = c.data?.extensions?.world || '';
        if (linkManageMode && linkMode === 'characters') return cur === linkBook; // manage: only linked here
        if (linkMode === 'characters' && linkHideLinked && cur === linkBook) return false;
        return true;
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return linkBaseSorted;
}

// Cheap per-query filter over the cached base, on the precomputed lowercase keys (no re-sort,
// no per-row toLowerCase). Order-preserving, so the base sort carries through.
function charCandidates() {
    const q = linkSearch.trim().toLowerCase();
    const base = linkBaseList();
    if (!q) return base;
    return base.filter(c => (c._lowerName || '').includes(q) || (c._lowerCreator || '').includes(q));
}

// ---- List virtualization (unbounded character lists; only render what's in view) ----

// Measure a real row's height once per open so the window math is exact on desktop and mobile
// (mobile bumps the row min-height) without hardcoding token-derived pixels.
function measureLinkRowStride(listEl) {
    const probe = document.createElement('button');
    probe.className = 'lb-link-row';
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:100%;';
    probe.innerHTML = '<span class="lb-link-check"></span><img class="lb-link-avatar" alt=""><span class="lb-link-name">probe</span>';
    listEl.appendChild(probe);
    // offsetHeight (layout px), NOT getBoundingClientRect (paint px): under a non-100% UI scale
    // (body zoom) the painted height is smaller than the layout height the `top` offsets live in,
    // so measuring the painted height packs rows tighter than their real height and they overlap.
    const h = probe.offsetHeight;
    probe.remove();
    const gap = parseFloat(getComputedStyle(listEl).rowGap) || 4;
    return (h + Math.round(gap)) || 54;
}

function clearVList() {
    vlistActive = false;
    vlistData = null;
}

// On mobile the modal body scrolls (sticky overlay header) and the list flows inside it; on desktop the
// list scrolls itself. The windowing reads whichever actually scrolls.
function vlistScroller(listEl) {
    return CoreAPI.isMobileMode() ? (listEl.closest('.lb-link-body') || listEl) : listEl;
}

// Render a sizer the full height of the list, then fill only the in-view rows (absolute-positioned).
function renderVList(listEl, items, rowFn) {
    if (!linkRowStride) linkRowStride = measureLinkRowStride(listEl);
    vlistData = { items, rowFn };
    vlistActive = true;
    listEl.innerHTML = `<div class="lb-vsizer" style="height:${items.length * linkRowStride}px;"></div>`;
    const scroller = vlistScroller(listEl);
    scroller.scrollTop = 0;
    // Distance from the scroll origin to the list's content (the hint + sticky header above it when the
    // body scrolls; 0 when the list is its own scroller). Stable until the next render, so cache it.
    vlistListOffset = scroller === listEl ? 0
        : Math.max(0, listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    paintVList();
    // clientHeight can be 0 during the modal open animation; correct the window once laid out.
    requestAnimationFrame(paintVList);
}

function paintVList() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl || !vlistActive || !vlistData) return;
    const sizer = listEl.firstElementChild;
    if (!sizer || !sizer.classList.contains('lb-vsizer')) return;
    const { items, rowFn } = vlistData;
    const stride = linkRowStride;
    const scroller = vlistScroller(listEl);
    const viewH = scroller.clientHeight || 400;
    const viewTop = scroller.scrollTop - vlistListOffset; // how far we've scrolled into the list's own content
    const OVERSCAN = 6;
    const start = Math.max(0, Math.floor(viewTop / stride) - OVERSCAN);
    const end = Math.min(items.length, Math.ceil((viewTop + viewH) / stride) + OVERSCAN);
    let html = '';
    for (let i = start; i < end; i++) {
        html += `<div class="lb-vrow" style="top:${i * stride}px;">${rowFn(items[i])}</div>`;
    }
    sizer.innerHTML = html;
}

// Repaint without rebuilding the dataset/scroll (used after select-all flips selection state).
function repaintLinkList() {
    if (vlistActive) paintVList();
    else renderLinkList();
}

function charLinkRowHtml(c) {
    const cur = c.data?.extensions?.world || '';
    const selected = linkSelection.has(c.avatar);
    const isThis = cur === linkBook;
    const hasOther = cur && cur !== linkBook;
    const status = isThis
        ? `<span class="lb-link-status current"><i class="fa-solid fa-check"></i> Linked here</span>`
        : hasOther
            ? `<span class="lb-link-status other" title="Currently linked to ${esc(cur)}"><i class="fa-solid fa-triangle-exclamation"></i> <span class="lb-link-status-name">${esc(cur)}</span></span>`
            : '';
    return `
        <button class="lb-link-row${selected ? ' selected' : ''}" data-action="link-toggle" data-avatar="${esc(c.avatar)}" title="${esc(c.name || c.avatar)}">
            <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar lb-avatar-clickable" src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy" title="View character details">
            <span class="lb-link-name">${esc(c.name || c.avatar)}</span>
            ${status}
        </button>`;
}

// Chats mode step 1: pick a character to drill into (no checkbox, chevron affordance).
function charPickRowHtml(c) {
    return `
        <button class="lb-link-row" data-action="link-pick-char" data-avatar="${esc(c.avatar)}" title="${esc(c.name || c.avatar)}">
            <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy">
            <span class="lb-link-name">${esc(c.name || c.avatar)}</span>
            <i class="fa-solid fa-chevron-right lb-link-chev"></i>
        </button>`;
}

function renderLinkList() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl) return;

    if (linkMode === 'chats') { renderChatLinkList(listEl); return; }

    linkFiltered = charCandidates();
    if (!linkFiltered.length) {
        clearVList();
        listEl.innerHTML = `<div class="lb-link-empty">No characters match.</div>`;
        return;
    }
    renderVList(listEl, linkFiltered, charLinkRowHtml);
}

// Manage-chats bound list filtered by the current search.
function manageChatVisible() {
    const q = linkSearch.trim().toLowerCase();
    if (!q) return manageChatList;
    return manageChatList.filter(c => {
        const name = (c.file_name || '').replace(/\.jsonl$/i, '').toLowerCase();
        return name.includes(q) || (c.charName || '').toLowerCase().includes(q);
    });
}

// Manage-chats: every chat bound to this book, across characters (no per-char drill-down).
function renderManageChatList(listEl) {
    clearVList(); // bounded list (one book's bound chats); render in full
    const items = manageChatVisible();
    if (!items.length) {
        listEl.innerHTML = `<div class="lb-link-empty">${manageChatList.length ? 'No bound chats match.' : 'No chats are bound to this lorebook.'}</div>`;
        return;
    }
    listEl.innerHTML = items.map(c => {
        const key = `${c.avatar}:${c.file_name}`;
        const name = (c.file_name || '').replace(/\.jsonl$/i, '');
        return `
            <button class="lb-link-row${linkSelection.has(key) ? ' selected' : ''}" data-action="link-toggle-managechat" data-key="${esc(key)}" title="${esc(name)}">
                <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
                <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy">
                <span class="lb-link-name">${esc(c.charName)}: ${esc(name)}</span>
            </button>`;
    }).join('');
}

// Chats mode is two-step: pick a character, then pick that character's chats.
function renderChatLinkList(listEl) {
    if (linkManageMode) { renderManageChatList(listEl); return; }
    if (linkChatsLoading) {
        clearVList();
        listEl.innerHTML = `<div class="lb-link-empty">Loading chats...</div>`;
        return;
    }

    if (!linkChatChar) {
        linkFiltered = charCandidates();
        if (!linkFiltered.length) { clearVList(); listEl.innerHTML = `<div class="lb-link-empty">No characters match.</div>`; return; }
        renderVList(listEl, linkFiltered, charPickRowHtml);
        return;
    }

    // Chat list for the chosen character.
    clearVList(); // bounded (one character's chats); render in full with the Back affordance
    const q = linkSearch.trim().toLowerCase();
    const chats = linkChatList.filter(ch => {
        if (!q) return true;
        return (ch.file_name || '').toLowerCase().includes(q);
    });
    const back = `
        <button class="lb-link-back" data-action="link-chat-back"><i class="fa-solid fa-arrow-left"></i> Back to characters</button>`;
    if (!chats.length) {
        listEl.innerHTML = back + `<div class="lb-link-empty">${linkChatList.length ? 'No chats match.' : 'This character has no chats.'}</div>`;
        return;
    }
    listEl.innerHTML = back + chats.map(ch => {
        const file = ch.file_name;
        const name = (file || '').replace(/\.jsonl$/i, '');
        const cur = ch.chat_metadata?.world_info || '';
        const selected = linkSelection.has(file);
        const isThis = cur === linkBook;
        const hasOther = cur && cur !== linkBook;
        const count = ch.chat_items || ch.mes_count || ch.message_count || 0;
        const status = isThis
            ? `<span class="lb-link-status current"><i class="fa-solid fa-check"></i> Bound here</span>`
            : hasOther
                ? `<span class="lb-link-status other" title="Currently bound to ${esc(cur)}"><i class="fa-solid fa-triangle-exclamation"></i> <span class="lb-link-status-name">${esc(cur)}</span></span>`
                : '';
        return `
            <button class="lb-link-row${selected ? ' selected' : ''}" data-action="link-toggle-chat" data-file="${esc(file)}" title="${esc(name)}">
                <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
                <i class="fa-solid fa-message lb-link-chat-icon"></i>
                <span class="lb-link-name">${esc(name)}</span>
                <span class="lb-link-chat-count">${count} msg</span>
                ${status}
            </button>`;
    }).join('');
}

async function pickLinkChatChar(avatar) {
    const char = (CoreAPI.getAllCharacters() || []).find(c => c.avatar === avatar);
    if (!char) return;
    linkChatChar = char;
    linkSelection = new Set();
    linkSearch = '';
    linkChatsLoading = true;
    syncLinkModeUI();
    renderLinkList();
    linkChatList = await CoreAPI.listCharacterChatsWithMeta(char);
    linkChatsLoading = false;
    const searchEl = document.getElementById('lbLinkSearch');
    if (searchEl) searchEl.value = '';
    renderLinkList();
    updateLinkFooter();
}

function backToCharPick() {
    linkChatChar = null;
    linkChatList = [];
    linkSelection = new Set();
    linkSearch = '';
    const searchEl = document.getElementById('lbLinkSearch');
    if (searchEl) searchEl.value = '';
    syncLinkModeUI();
    renderLinkList();
    updateLinkFooter();
}

function updateLinkFooter() {
    const countEl = document.getElementById('lbLinkCount');
    if (countEl) countEl.textContent = `${linkSelection.size} selected`;
    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyCount = document.getElementById('lbLinkApplyCount');
    if (applyBtn) applyBtn.disabled = linkSelection.size === 0;
    if (applyCount) applyCount.textContent = linkSelection.size ? `(${linkSelection.size})` : '';
    // The select toggle only makes sense on a list of selectable rows. Collapse it (display:none)
    // rather than just hiding it, so it doesn't reserve an empty gap above the list (the chats
    // pick-a-character step has no select-all).
    const selBar = document.querySelector('.lb-link-selectbar');
    if (selBar) {
        const showSel = linkManageMode || linkMode === 'characters' || (linkMode === 'chats' && !!linkChatChar);
        selBar.style.display = showSel ? '' : 'none';
    }
    syncLinkSelectToggle();
}

// Chats-mode chats visible for the chosen character, filtered by search (bounded list).
function linkVisibleChats() {
    if (!linkChatChar) return [];
    const q = linkSearch.trim().toLowerCase();
    return linkChatList.filter(ch => !q || (ch.file_name || '').toLowerCase().includes(q));
}

// Selection keys of the currently-shown rows (mode-aware: chars / per-char chats / manage-chats).
// Reads the cached filtered set for characters, so it never re-filters/re-sorts the library.
function linkShownKeys() {
    if (linkManageMode && linkMode === 'chats') return manageChatVisible().map(c => `${c.avatar}:${c.file_name}`);
    if (linkMode === 'chats') return linkVisibleChats().map(ch => ch.file_name);
    return linkFiltered.map(c => c.avatar);
}

// Cheap count of shown rows without materializing the key array (keeps the toggle O(1)).
function linkShownCount() {
    if (linkManageMode && linkMode === 'chats') return manageChatVisible().length;
    if (linkMode === 'chats') return linkVisibleChats().length;
    return linkFiltered.length;
}

function syncLinkSelectToggle() {
    const btn = document.getElementById('lbLinkSelectToggle');
    if (!btn) return;
    const shown = linkShownCount();
    // Short-circuit: "all shown selected" is impossible unless at least that many are selected,
    // so the full membership scan only runs when the user has actually selected (nearly) everything.
    const allSel = shown > 0 && linkSelection.size >= shown && linkShownKeys().every(k => linkSelection.has(k));
    btn.title = allSel ? 'Deselect all shown' : 'Select all shown';
    btn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
}

async function applyLinks() {
    if (!linkBook || linkSelection.size === 0) return;
    if (linkManageMode) return applyUnlinks();
    if (linkMode === 'chats') return applyChatLinks();

    const chars = CoreAPI.getAllCharacters() || [];
    const targets = chars.filter(c => linkSelection.has(c.avatar));

    // Warn for characters that already have a DIFFERENT primary book.
    const conflicts = targets.filter(c => {
        const cur = c.data?.extensions?.world || '';
        return cur && cur !== linkBook;
    });
    let skipConflicts = false;
    if (conflicts.length) {
        const names = conflicts.slice(0, 8).map(c => `${c.name || c.avatar} (${c.data.extensions.world})`).join(', ');
        const more = conflicts.length > 8 ? ` and ${conflicts.length - 8} more` : '';
        const ok = await CoreAPI.showConfirm({
            title: 'Overwrite existing links?',
            message: `${conflicts.length} selected character${conflicts.length === 1 ? '' : 's'} already link a different lorebook: ${names}${more}. Overwrite them, or skip them and link only the rest?`,
            confirmLabel: 'Overwrite',
            cancelLabel: 'Skip those',
            danger: true,
        });
        skipConflicts = !ok;
    }

    const toLink = targets.filter(c => {
        const cur = c.data?.extensions?.world || '';
        if (cur === linkBook) return false;           // already linked here, no-op
        if (skipConflicts && cur && cur !== linkBook) return false;
        return true;
    });

    if (!toLink.length) {
        CoreAPI.showToast('Nothing to link (all selected were skipped or already linked)', 'info');
        return;
    }

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Linking...'; }

    let done = 0;
    try {
        for (const c of toLink) {
            const ok = await CoreAPI.applyCardFieldUpdates(c.avatar, { 'extensions.world': linkBook });
            if (ok) done++;
        }
    } finally {
        if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }
    }

    closeLinkPicker();
    buildLinkedMap();
    renderEditor();
    renderWorldList();
    const skipped = targets.length - toLink.length;
    CoreAPI.showToast(
        `Linked ${done} character${done === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`,
        'success', 5000,
    );
}

async function applyChatLinks() {
    if (!linkChatChar || linkSelection.size === 0) return;
    const targets = linkChatList.filter(ch => linkSelection.has(ch.file_name));

    // Warn for chats already bound to a DIFFERENT book.
    const conflicts = targets.filter(ch => {
        const cur = ch.chat_metadata?.world_info || '';
        return cur && cur !== linkBook;
    });
    let skipConflicts = false;
    if (conflicts.length) {
        const names = conflicts.slice(0, 6).map(ch => `${(ch.file_name || '').replace(/\.jsonl$/i, '')} (${ch.chat_metadata.world_info})`).join(', ');
        const more = conflicts.length > 6 ? ` and ${conflicts.length - 6} more` : '';
        const ok = await CoreAPI.showConfirm({
            title: 'Overwrite existing chat bindings?',
            message: `${conflicts.length} selected chat${conflicts.length === 1 ? '' : 's'} already bind a different lorebook: ${names}${more}. Overwrite them, or skip them and bind only the rest?`,
            confirmLabel: 'Overwrite',
            cancelLabel: 'Skip those',
            danger: true,
        });
        skipConflicts = !ok;
    }

    const toBind = targets.filter(ch => {
        const cur = ch.chat_metadata?.world_info || '';
        if (cur === linkBook) return false;
        if (skipConflicts && cur && cur !== linkBook) return false;
        return true;
    });

    if (!toBind.length) {
        CoreAPI.showToast('Nothing to bind (all selected were skipped or already bound)', 'info');
        return;
    }

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Binding...'; }

    let done = 0;
    const newlyBound = [];
    try {
        for (const ch of toBind) {
            const ok = await CoreAPI.setChatBoundWorld(linkChatChar, ch.file_name, linkBook);
            if (ok) {
                done++;
                ch.chat_metadata = ch.chat_metadata || {};
                ch.chat_metadata.world_info = linkBook;
                newlyBound.push({ avatar: linkChatChar.avatar, charName: linkChatChar.name || linkChatChar.avatar, char: linkChatChar, file_name: ch.file_name });
            }
        }

        // Keep the reverse index in sync (only if it's been built) so the editor + sidebar reflect
        // the new bindings without a full refetch.
        if (chatIndexLoaded && newlyBound.length) {
            const list = chatBoundMap.get(linkBook) || [];
            for (const nb of newlyBound) {
                if (!list.some(x => x.file_name === nb.file_name && x.avatar === nb.avatar)) list.push(nb);
            }
            chatBoundMap.set(linkBook, list);
        }
    } finally {
        if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }
    }

    closeLinkPicker();
    if (currentWorld) renderEditor();
    renderWorldList();
    const skipped = targets.length - toBind.length;
    CoreAPI.showToast(
        `Bound ${done} chat${done === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}. Reopen the chat in ST to apply.`,
        'success', 5000,
    );
}

// Manage-mode batch unlink: remove this book from the selected characters or chats.
async function applyUnlinks() {
    if (!linkBook || linkSelection.size === 0) return;
    const isChat = linkMode === 'chats';
    const n = linkSelection.size;
    const ok = await CoreAPI.showConfirm({
        title: isChat ? 'Unbind selected chats?' : 'Unlink selected characters?',
        message: `Remove "${esc(linkBook)}" from ${n} ${isChat ? `chat${n === 1 ? '' : 's'}` : `character${n === 1 ? '' : 's'}`}?`,
        confirmLabel: isChat ? 'Unbind' : 'Unlink',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Unlinking...'; }

    let done = 0;
    try {
        if (isChat) {
            for (const key of linkSelection) {
                const c = manageChatList.find(x => `${x.avatar}:${x.file_name}` === key);
                if (!c) continue;
                const okU = await CoreAPI.setChatBoundWorld(c.char || { avatar: c.avatar, name: c.charName }, c.file_name, '');
                if (okU) {
                    done++;
                    if (c.chat_metadata) c.chat_metadata.world_info = '';
                    const list = chatBoundMap.get(linkBook);
                    if (list) chatBoundMap.set(linkBook, list.filter(x => !(x.avatar === c.avatar && x.file_name === c.file_name)));
                }
            }
        } else {
            for (const avatar of linkSelection) {
                const okU = await CoreAPI.applyCardFieldUpdates(avatar, { 'extensions.world': '' });
                if (okU) done++;
            }
        }
    } finally {
        if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }
    }

    closeLinkPicker();
    buildLinkedMap();
    if (currentWorld) renderEditor();
    renderWorldList();
    CoreAPI.showToast(
        `${isChat ? 'Unbound' : 'Unlinked'} ${done} ${isChat ? `chat${done === 1 ? '' : 's'}` : `character${done === 1 ? '' : 's'}`}.`,
        'success', 4000,
    );
}

// ========================================
// EVENTS
// ========================================

// App-bar float: in flow on the way down (scrolls away naturally), floats back in (sticky lb-pinned)
// on an up-run while deep, slides out + unfloats on the next down-run. Not scroll-linked on purpose:
// scroll events lag the compositor thread, so pixel-tracking jitters at slow speeds.
function createToolbarAutoHide(getToolbar, getHeadH) {
    let lastY = null, lastEl = null, downRun = 0, upRun = 0, hideTimer = 0;
    const showFloat = (el) => {
        clearTimeout(hideTimer); hideTimer = 0;
        el.classList.remove('lb-toolbar-hidden');
        el.classList.add('lb-pinned');
    };
    const hideFloat = (el, instant) => {
        if (!el.classList.contains('lb-pinned')) return;
        if (instant) { clearTimeout(hideTimer); hideTimer = 0; el.classList.remove('lb-pinned', 'lb-toolbar-hidden'); return; }
        if (hideTimer) return;
        el.classList.add('lb-toolbar-hidden');
        hideTimer = setTimeout(() => { hideTimer = 0; el.classList.remove('lb-pinned', 'lb-toolbar-hidden'); }, 220);
    };
    return (y) => {
        const toolbar = getToolbar();
        if (!toolbar) return;
        // A re-rendered toolbar node starts fresh (inline, runs reset).
        if (toolbar !== lastEl) { lastEl = toolbar; lastY = null; downRun = 0; upRun = 0; clearTimeout(hideTimer); hideTimer = 0; }
        const dy = lastY === null ? 0 : y - lastY;
        lastY = y;
        if (dy > 0) { downRun += dy; upRun = 0; } else if (dy < 0) { upRun -= dy; downRun = 0; }
        const slotTop = getHeadH();
        if (y <= slotTop) { hideFloat(toolbar, true); return; }  // natural slot at/below the top edge: pure inline
        const floating = toolbar.classList.contains('lb-pinned');
        if (!floating && y < slotTop + toolbar.offsetHeight) return;  // partially scrolled into view: let it move naturally
        if (!floating && upRun > 8) showFloat(toolbar);
        else if (floating && downRun > 16) hideFloat(toolbar, false);
    };
}

function attachAutoHideToolbar(scrollEl, toolbarSel, headSel) {
    if (!scrollEl) return;
    const autoHide = createToolbarAutoHide(
        () => scrollEl.querySelector(toolbarSel),
        () => { const h = scrollEl.querySelector(headSel); return h ? h.offsetHeight : 48; },
    );
    scrollEl.addEventListener('scroll', () => autoHide(scrollEl.scrollTop), { passive: true });
}

function attachEvents() {
    const modal = document.getElementById('lorebookModal');
    if (!modal) return;

    document.getElementById('lbCloseBtn')?.addEventListener('click', handleModalBack);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Mobile: both the entries toolbar and the world-list tools bar auto-hide on scroll (sticky bars).
    attachAutoHideToolbar(document.getElementById('lbContent'), '.lb-entries-toolbar', '.lb-editor-head');
    attachAutoHideToolbar(modal.querySelector('.lb-sidebar'), '.lb-sidebar-tools', '.lb-sidebar-actions');

    // Up/down navigate the sidebar lorebook list (loading each). Bails while typing in a field or
    // when a sub-modal owns the keyboard. One-time document listener (attachEvents runs once).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        if (!lbNavAllowed()) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        e.preventDefault();
        moveActiveWorld(e.key === 'ArrowDown' ? 1 : -1);
    });

    document.getElementById('lbNewBtn')?.addEventListener('click', startCreate);
    // "New" is a split button: the caret reveals secondary create actions (Generate with AI).
    document.getElementById('lbNewCaret')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('lbNewMenu')?.classList.toggle('hidden');
    });
    document.getElementById('lbAiBtn')?.addEventListener('click', () => {
        document.getElementById('lbNewMenu')?.classList.add('hidden');
        aiOpenGenerate('new');
    });
    // close the split menu on any outside click
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('lbNewMenu');
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.lb-split-btn')) menu.classList.add('hidden');
    });
    document.getElementById('lbImportBtn')?.addEventListener('click', () => document.getElementById('lbImportInput')?.click());
    document.getElementById('lbImportInput')?.addEventListener('change', (e) => {
        importFiles(e.target.files);
        e.target.value = '';
    });

    document.getElementById('lbWorldSearch')?.addEventListener('input', (e) => {
        worldSearch = e.target.value;
        renderWorldList();
    });
    document.getElementById('lbWorldSort')?.addEventListener('change', (e) => {
        worldSort = e.target.value;
        renderWorldList();
    });
    // Used-by lens toggle (Characters | Chats) governs sidebar badges/sort + editor usage.
    document.querySelectorAll('.lb-usedby-opt').forEach(btn => {
        btn.addEventListener('click', () => setUsedByMode(btn.dataset.mode));
    });

    // Sidebar delegation (world rows + inline new-name input)
    document.getElementById('lbWorldList')?.addEventListener('click', (e) => {
        const row = e.target.closest('[data-action="select-world"]');
        if (row) selectWorld(row.dataset.world);
    });
    document.getElementById('lbWorldList')?.addEventListener('keydown', (e) => {
        if (e.target.id === 'lbNewNameInput') {
            if (e.key === 'Enter') { e.preventDefault(); commitCreate(e.target.value); }
            else if (e.key === 'Escape') { e.preventDefault(); creatingNew = false; renderWorldList(); }
        }
    });
    document.getElementById('lbWorldList')?.addEventListener('focusout', (e) => {
        if (e.target.id === 'lbNewNameInput' && creatingNew) {
            // Commit on blur unless the value is empty (treat empty blur as cancel)
            commitCreate(e.target.value);
        }
    });

    // Content delegation
    const content = document.getElementById('lbContent');
    if (content) {
        content.addEventListener('click', onContentClick);
        content.addEventListener('input', onContentInput);
        content.addEventListener('change', onContentChange);
        content.addEventListener('keydown', onContentKeydown);
    }

    // Close the editor overflow (kebab) menu on any outside click.
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('lbEditorOverflowMenu');
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.lb-editor-overflow')) menu.classList.add('hidden');
    });

    // Link picker
    const linkModal = document.getElementById('lbLinkModal');
    document.getElementById('lbLinkCloseBtn')?.addEventListener('click', closeLinkPicker);
    document.getElementById('lbLinkCancelBtn')?.addEventListener('click', closeLinkPicker);
    linkModal?.addEventListener('click', (e) => { if (e.target === linkModal) closeLinkPicker(); });
    document.getElementById('lbLinkApplyBtn')?.addEventListener('click', applyLinks);
    document.getElementById('lbLinkSearch')?.addEventListener('input', (e) => {
        linkSearch = e.target.value;
        // Debounce so a keystroke storm collapses to one filter+render pass.
        clearTimeout(linkSearchTimer);
        linkSearchTimer = setTimeout(renderLinkList, 120);
    });
    document.getElementById('lbLinkHideLinked')?.addEventListener('change', (e) => {
        linkHideLinked = e.target.checked;
        linkBaseSorted = null; // membership changed; rebuild the sorted base
        renderLinkList();
    });
    CoreAPI.initCustomSelect(document.getElementById('lbLinkPlaylistFilter'));
    document.getElementById('lbLinkPlaylistFilter')?.addEventListener('change', (e) => {
        linkPlaylistUid = e.target.value || '';
        linkPlaylistSet = linkPlaylistUid ? (CoreAPI.playlistsGetAvatarSet(linkPlaylistUid) || null) : null;
        linkBaseSorted = null;
        renderLinkList();
    });
    // The link list repaints its in-view rows on scroll (coalesced to one rAF). On mobile the modal body
    // is the scroller and the search/controls header is a sticky overlay that auto-hides on scroll-down /
    // reveals on scroll-up (translateY, no list reflow). Attach to both; only the active scroller fires.
    const linkAutoHide = createToolbarAutoHide(
        () => document.getElementById('lbLinkHead'),
        () => document.querySelector('#lbLinkModal .lb-link-body .lb-link-mode-hint')?.offsetHeight || 0,
    );
    const onLinkScroll = (e) => {
        const scroller = e.currentTarget;
        if (scroller.classList.contains('lb-link-body')) linkAutoHide(scroller.scrollTop);
        if (vlistActive && !vlistRaf) vlistRaf = requestAnimationFrame(() => { vlistRaf = 0; paintVList(); });
    };
    document.getElementById('lbLinkList')?.addEventListener('scroll', onLinkScroll, { passive: true });
    document.querySelector('#lbLinkModal .lb-link-body')?.addEventListener('scroll', onLinkScroll, { passive: true });
    document.getElementById('lbLinkList')?.addEventListener('click', (e) => {
        const back = e.target.closest('[data-action="link-chat-back"]');
        if (back) { backToCharPick(); return; }

        const charPick = e.target.closest('[data-action="link-pick-char"]');
        if (charPick) { pickLinkChatChar(charPick.dataset.avatar); return; }

        const charRow = e.target.closest('[data-action="link-toggle"]');
        if (charRow) {
            const avatar = charRow.dataset.avatar;
            // Clicking the avatar opens the character detail modal on top (not a selection toggle).
            if (e.target.closest('.lb-avatar-clickable')) {
                const char = (CoreAPI.getAllCharacters() || []).find(c => c.avatar === avatar);
                if (char) { CoreAPI.openCharModalElevated(char); return; }
            }
            if (linkSelection.has(avatar)) linkSelection.delete(avatar);
            else linkSelection.add(avatar);
            charRow.classList.toggle('selected', linkSelection.has(avatar));
            updateLinkFooter();
            return;
        }

        const chatRow = e.target.closest('[data-action="link-toggle-chat"]');
        if (chatRow) {
            const file = chatRow.dataset.file;
            if (linkSelection.has(file)) linkSelection.delete(file);
            else linkSelection.add(file);
            chatRow.classList.toggle('selected', linkSelection.has(file));
            updateLinkFooter();
            return;
        }

        const manageChatRow = e.target.closest('[data-action="link-toggle-managechat"]');
        if (manageChatRow) {
            const key = manageChatRow.dataset.key;
            if (linkSelection.has(key)) linkSelection.delete(key);
            else linkSelection.add(key);
            manageChatRow.classList.toggle('selected', linkSelection.has(key));
            updateLinkFooter();
        }
    });
    document.getElementById('lbLinkSelectToggle')?.addEventListener('click', () => {
        const keys = linkShownKeys();
        const allSel = keys.length > 0 && linkSelection.size >= keys.length && keys.every(k => linkSelection.has(k));
        keys.forEach(k => allSel ? linkSelection.delete(k) : linkSelection.add(k));
        repaintLinkList(); // selection changed, not the dataset; keep scroll position
        updateLinkFooter();
    });
}

function onContentClick(e) {
    const stop = e.target.closest('[data-stop]');
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const uid = actionEl.dataset.uid !== undefined ? Number(actionEl.dataset.uid) : null;

    // Any action other than opening it dismisses the editor overflow (kebab) menu.
    if (action !== 'editor-overflow') document.getElementById('lbEditorOverflowMenu')?.classList.add('hidden');

    // Entry expand/collapse: ignore clicks that originate inside the toggle switch or head actions
    if (action === 'toggle-entry') {
        if (stop) return;
        const u = Number(actionEl.dataset.uid);
        if (expandedUids.has(u)) expandedUids.delete(u);
        else expandedUids.add(u);
        refreshRow(u);
        return;
    }

    switch (action) {
        case 'save': saveWorld(); break;
        case 'rename-world': startRename(); break;
        case 'link-chars': openLinkPicker('characters'); break;
        case 'bind-chats': openLinkPicker('chats'); break;
        case 'manage-links': openLinkPicker(usedByMode === 'chats' ? 'chats' : 'characters', { manage: true }); break;
        case 'duplicate-world': duplicateWorld(); break;
        case 'export-world': exportWorld(); break;
        case 'delete-world': deleteWorld(); break;
        case 'add-entry': addEntry(); break;
        case 'editor-overflow': e.stopPropagation(); document.getElementById('lbEditorOverflowMenu')?.classList.toggle('hidden'); break;
        case 'ai-generate': aiOpenGenerate('current'); break;
        case 'toggle-all': {
            const ents = sortedEntries();
            const allExpanded = ents.length > 0 && ents.every(en => expandedUids.has(en.uid));
            if (allExpanded) expandedUids.clear();
            else ents.forEach(en => expandedUids.add(en.uid));
            renderEditor();
            break;
        }
        case 'duplicate-entry': duplicateEntry(uid); break;
        case 'delete-entry': deleteEntry(uid); break;
        case 'toggle-advanced':
            if (advancedUids.has(uid)) advancedUids.delete(uid); else advancedUids.add(uid);
            refreshRow(uid);
            break;
        case 'set-state': {
            const en = workingWorld.entries[uid];
            if (!en) break;
            const s = actionEl.dataset.state;
            en.constant = s === 'constant';
            en.vectorized = s === 'vectorized';
            markDirty();
            refreshRow(uid);
            break;
        }
        case 'remove-key': {
            const field = actionEl.dataset.field;
            const idx = Number(actionEl.dataset.index);
            const arr = workingWorld.entries[uid][field];
            if (Array.isArray(arr)) { arr.splice(idx, 1); markDirty(); refreshRow(uid); refreshRowHeader(uid); }
            break;
        }
        case 'open-char': {
            const avatar = actionEl.dataset.avatar;
            const entry = (linkedMap.get(currentWorld) || []).find(l => l.avatar === avatar);
            // Open the character detail modal ABOVE the manager (don't close it); the user
            // returns to the manager when they dismiss the detail modal.
            if (entry?.char) CoreAPI.openCharModalElevated(entry.char);
            break;
        }
        case 'unlink-char': unlinkCharFromCurrentWorld(actionEl.dataset.avatar); break;
        case 'open-bound-chat': {
            const c = (chatBoundMap.get(currentWorld) || [])[Number(actionEl.dataset.idx)];
            if (c?.char) CoreAPI.openCharModalElevated(c.char);
            break;
        }
        case 'unbind-chat': {
            const c = (chatBoundMap.get(currentWorld) || [])[Number(actionEl.dataset.idx)];
            if (c) unbindChatFromCurrentWorld(c);
            break;
        }
        case 'empty-new': startCreate(); break;
        case 'empty-import': document.getElementById('lbImportInput')?.click(); break;
    }
}

async function mobileBackToList() {
    if (dirty) {
        const ok = await CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        });
        if (!ok) return;
    }
    currentWorld = null;
    workingWorld = null;
    dirty = false;
    setEditingMode(false);
    renderEmptyContent();
    renderWorldList();
}

// Single back/close router for the modal header arrow, Android back, and Escape. On mobile with a
// lorebook open it steps back to the list first; otherwise it closes the manager. Desktop shows the
// list and editor side by side, so theres no intermediate step and it always closes.
function handleModalBack() {
    const body = document.querySelector('#lorebookModal .lb-body');
    if (CoreAPI.isMobileMode() && body?.classList.contains('lb-editing')) {
        mobileBackToList();
    } else {
        closeModal();
    }
}

function onContentInput(e) {
    const target = e.target;
    if (target.id === 'lbEntrySearch') {
        entrySearch = target.value;
        renderEntriesOnly();
        return;
    }
    const field = target.dataset.field;
    if (!field || target.dataset.action === 'add-key') return;
    const uid = Number(target.dataset.uid);
    const type = target.dataset.type || 'string';
    if (type === 'bool' || type === 'bool-inv' || type === 'int' || type === 'tristate') return; // those fire 'change'
    coerceStore(uid, field, type, target.value);
    markDirty();
    if (field === 'content') autoGrowLb(target);
    if (field === 'comment' || field === 'order') refreshRowHeader(uid);
}

function onContentChange(e) {
    const target = e.target;
    if (target.id === 'lbEntrySort') {
        entrySort = target.value;
        renderEntriesOnly();
        return;
    }
    const field = target.dataset.field;
    if (!field) return;
    const uid = Number(target.dataset.uid);
    const type = target.dataset.type || 'string';
    const raw = (type === 'bool' || type === 'bool-inv') ? target.checked : target.value;
    coerceStore(uid, field, type, raw);
    markDirty();
    // Layout-affecting fields: re-render the row so dependent controls show/hide.
    if (field === 'position' || field === 'disable') refreshRow(uid);
}

function onContentKeydown(e) {
    const target = e.target;
    if (target.dataset?.action !== 'add-key') return;
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const raw = target.value.trim().replace(/,$/, '').trim();
        if (!raw) return;
        const uid = Number(target.dataset.uid);
        const field = target.dataset.field;
        const arr = workingWorld.entries[uid][field];
        if (Array.isArray(arr)) {
            // Allow comma-paste of multiple keys at once
            for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!arr.includes(part)) arr.push(part);
            }
            markDirty();
            refreshRow(uid);
            refreshRowHeader(uid);
            requestAnimationFrame(() => {
                const fresh = document.querySelector(`.lb-pill-input[data-uid="${uid}"][data-field="${field}"]`);
                fresh?.focus();
            });
        }
    } else if (e.key === 'Backspace' && target.value === '') {
        const uid = Number(target.dataset.uid);
        const field = target.dataset.field;
        const arr = workingWorld.entries[uid][field];
        if (Array.isArray(arr) && arr.length) {
            arr.pop();
            markDirty();
            refreshRow(uid);
            refreshRowHeader(uid);
            requestAnimationFrame(() => {
                const fresh = document.querySelector(`.lb-pill-input[data-uid="${uid}"][data-field="${field}"]`);
                fresh?.focus();
            });
        }
    }
}

// Re-render just the entries list (preserves the header/toolbar, used for search/sort)
function renderEntriesOnly() {
    const wrap = document.getElementById('lbEntries');
    if (!wrap || !workingWorld) return;
    const entries = sortedEntries();
    const total = Object.keys(workingWorld.entries).length;
    wrap.innerHTML = entries.length ? entries.map(e => renderEntryRow(e)).join('') : renderNoEntries(total);
    growVisibleContentFields(wrap);
}

// ========================================
// AI: CONNECTION (delegates request/parse to the shared CoreAPI.callLLM + getLlmSettings;
// only the panel's own profile <select> + selection live here.)
// ========================================

let aiProfiles = [];
let aiActiveSource = '';
let aiActiveModel = '';
let aiActivePreset = null;

// Populate the panel's profile <select> from the shared settings helper. The module owns
// only its own DOM; the source/model/preset resolution lives in CoreAPI.getLlmSettings.
async function aiLoadProfiles() {
    const selectEl = document.getElementById('lbAiProfile');
    const s = await CoreAPI.getLlmSettings();
    aiProfiles = s.profiles;
    aiActiveSource = s.activeSource;
    aiActiveModel = s.activeModel;
    aiActivePreset = s.activePreset;
    if (selectEl) {
        const opts = [`<option value="">Active preset${aiActiveSource ? ` (${esc(aiActiveModel || aiActiveSource)})` : ''}</option>`]
            .concat(aiProfiles.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.api || 'Unnamed')}</option>`));
        selectEl.innerHTML = opts.join('');
        // prefer the CM's currently-selected profile if any, else the active preset
        if (s.selectedProfileId && aiProfiles.some(p => p.id === s.selectedProfileId)) selectEl.value = s.selectedProfileId;
        else selectEl.value = '';
        selectEl._customSelect?.refresh();
    }
    aiUpdateConnLabel();
}

function aiSelectedProfile() {
    const id = document.getElementById('lbAiProfile')?.value || '';
    return id ? (aiProfiles.find(p => p.id === id) || null) : null;
}

function aiUpdateConnLabel() {
    const dot = document.getElementById('lbAiConnDot');
    const label = document.getElementById('lbAiConnLabel');
    if (!dot || !label) return;
    const profile = aiSelectedProfile();
    const source = profile?.api || aiActiveSource;
    const model = profile?.model || aiActiveModel;
    if (!source) {
        dot.className = 'lb-ai-conn-dot neutral';
        label.textContent = 'No Chat Completion source connected';
    } else {
        dot.className = 'lb-ai-conn-dot connected';
        label.textContent = model || source;
    }
}

// Thin wrapper over the shared client. returnRawOnNonJson:true keeps the lenient behavior
// (callers parse the returned string themselves).
function aiCallLLM(messages, { signal, maxTokens = 4000, temperature = 0.7 } = {}) {
    return CoreAPI.callLLM(messages, {
        profile: aiSelectedProfile(),
        activeSource: aiActiveSource, activeModel: aiActiveModel, activePreset: aiActivePreset,
        temperature, maxTokens, signal,
        returnRawOnNonJson: true, stripSurrogates: true, debugTag: 'Lorebooks AI',
    });
}

// ========================================
// AI: SOURCE FETCH (webpage / MediaWiki wiki via ST's CORS proxy)
// ========================================

// direct fetch first; on CORS/network reject fall back to ST's /proxy/ (mirror of
// provider-utils fetchWithProxy; users run with the ST CORS proxy enabled).
async function aiProxyFetch(url, opts = {}) {
    let direct;
    try {
        direct = await fetch(url, opts);
    } catch (_) { /* CORS/network -> proxy */ }
    if (direct) {
        if (!direct.ok) throw new Error(`HTTP ${direct.status}`);
        return direct;
    }
    const r = await fetch(`/proxy/${proxyEncode(url)}`, opts);
    if (!r.ok) {
        if (r.status === 404) {
            const t = await r.text().catch(() => '');
            if (t.includes('CORS proxy is disabled')) throw new Error('SillyTavern\'s CORS proxy is disabled. Set enableCorsProxy: true in config.yaml and restart SillyTavern to fetch web pages.');
        }
        throw new Error(`HTTP ${r.status}`);
    }
    return r;
}

const AI_SOURCE_MAX_CHARS = 24000;
const AI_GEN_MAX_CONTEXT = 24000;   // default per-request char budget; batches a multi-page source across calls
const AI_GEN_MAX_TOKENS = 8000;     // per-batch output token cap (safe across providers)
// Cap pages/batch so one-entry-per-page output stays under the model's reply token cap; a bigger
// batch truncates the JSON array and the repair drops the tail (a deterministic undercount). ~450 tok/entry worst case.
const AI_GEN_PAGES_PER_BATCH = Math.max(8, Math.floor(AI_GEN_MAX_TOKENS / 450)); // = 17
const AI_ST_CHAT_CAP = 12000;       // per-chat char cap (one big chat shouldn't dominate)
const AI_ST_LASTN_DEFAULT = 50;     // default "Last N" messages for a chat scope
const AI_GEN_CONCURRENCY = 4;       // max simultaneous generate requests when batching
// Character card fields offered per-character in the From-SillyTavern picker (all on by default).
const AI_ST_CHAR_FIELDS = [
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
    ['first_mes', 'First message'],
    ['mes_example', 'Example dialogue'],
];
const aiStAllFields = () => new Set(AI_ST_CHAR_FIELDS.map(f => f[0]));

// Rendered HTML -> readable plain text. DOMParser gives far cleaner extraction than a
// regex strip: we drop non-content nodes, prefer the main/article body, collapse space.
function aiHtmlToText(html) {
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript, template, svg, nav, header, footer, aside, form, .navbox, .mw-editsection, .reference, sup.reference, .toc, .infobox-image, figure, figcaption').forEach(n => n.remove());
        const root = doc.querySelector('article, main, #mw-content-text, .mw-parser-output') || doc.body || doc.documentElement;
        const text = (root?.textContent || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        return text;
    } catch {
        // fallback: crude strip
        return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

// Is this a MediaWiki page URL (Fandom, Wikipedia, most wikis)? If so we hit api.php
// for clean parsed HTML instead of scraping the chrome-heavy page.
function aiDetectMediaWiki(u) {
    try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const isWiki = host.endsWith('fandom.com') || host.endsWith('wikipedia.org') || host.endsWith('wikia.org') || host.includes('.miraheze.org') || /\/wiki\//.test(url.pathname);
        if (!isWiki) return null;
        const m = url.pathname.match(/\/wiki\/([^?#]+)/);
        if (!m) return null;
        const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
        return { api: `${url.origin}/api.php`, title };
    } catch { return null; }
}

// Fetch + extract readable source text from a URL. Returns { text, title }.
async function aiFetchSource(rawUrl) {
    let url = String(rawUrl || '').trim();
    if (!url) throw new Error('Enter a URL first.');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const wiki = aiDetectMediaWiki(url);
    if (wiki) {
        const api = `${wiki.api}?action=parse&page=${encodeURIComponent(wiki.title)}&prop=text&format=json&redirects=1&origin=*`;
        try {
            const resp = await aiProxyFetch(api, { headers: { 'Accept': 'application/json' } });
            const data = await resp.json();
            const htmlText = data?.parse?.text?.['*'];
            if (htmlText) {
                return { text: aiHtmlToText(htmlText).slice(0, AI_SOURCE_MAX_CHARS), title: data?.parse?.title || wiki.title };
            }
            if (data?.error) throw new Error(data.error.info || 'wiki API error');
        } catch (e) {
            CoreAPI.debugLog?.('[Lorebooks AI] wiki API failed, falling back to page scrape:', e?.message || e);
            // fall through to generic page fetch
        }
    }

    const resp = await aiProxyFetch(url, { headers: { 'Accept': 'text/html,*/*' } });
    const html = await resp.text();
    const text = aiHtmlToText(html).slice(0, AI_SOURCE_MAX_CHARS);
    if (!text) throw new Error('Could not extract any text from that page.');
    let title = '';
    try { title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim(); } catch { /* ignore */ }
    return { text, title };
}

// ========================================
// AI: PROMPTS + ENTRY COERCION
// ========================================

const AI_GEN_SYSTEM = `You are an expert SillyTavern lorebook (World Info) author. You turn source material into a set of focused World Info entries.

How World Info works: each entry has trigger KEYS (keywords). When a key appears in recent chat, that entry's CONTENT is injected into the AI's context. So entries should be atomic, one subject each (a character, place, faction, event, item, or world rule), and keys should be the words a conversation would naturally use to refer to that subject: names, aliases, nicknames, titles.

Return ONLY a JSON array. No prose, no markdown fence. Each element:
{
  "comment": short title naming the subject,
  "keys": [primary trigger words and aliases],
  "secondary_keys": [optional words that must ALSO appear to trigger; usually empty []],
  "content": the lore text to inject, concise and factual, written so it reads cleanly mid-prompt, no meta commentary like "this entry describes",
  "constant": true ONLY for always-relevant world setting/rules that should always be in context (rare); otherwise false,
  "position": 0 (before character definitions) by default; 4 for at-depth notes,
  "order": insertion priority, lower inserts first; 100 unless an entry should dominate
}

Good practice (guidance, not rigid rules): split long source into several focused entries rather than one giant entry; give each subject the aliases a chat would actually use; keep content tight and concrete; drop trivia; never invent facts not supported by the source. Honor the user's instructions on granularity, tone, and length.`;

// Tolerant JSON-array parse: fence-strip, direct parse, greedy [..], then truncation repair.
// Mirrors recommender.js parseRecommendations + repairTruncatedArray.
function aiParseJsonArray(raw) {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fence) text = fence[1].trim();
    try { const a = JSON.parse(text); if (Array.isArray(a)) return a; } catch { /* next */ }
    const m = text.match(/\[[\s\S]*\]/);
    if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a; } catch { /* next */ } }
    // truncation repair: keep up to the last complete object and close the array
    const start = text.indexOf('[');
    if (start !== -1) {
        let frag = text.slice(start);
        const lastBrace = frag.lastIndexOf('}');
        if (lastBrace !== -1) {
            frag = frag.slice(0, lastBrace + 1);
            if (!frag.trimEnd().endsWith(']')) frag = frag.replace(/,\s*$/, '') + ']';
            try { const a = JSON.parse(frag); if (Array.isArray(a) && a.length) return a; } catch { /* give up */ }
        }
    }
    return null;
}

function aiNormStrArray(v) {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

// AI entry object -> native world entry. Built on newEntry so every advanced field gets a
// sane default; we only override what the model provided (never a field whitelist that drops
// the rest). uid is assigned by the caller from the live world.
function aiEntryToNative(raw, uid) {
    const e = newEntry(uid, uid);
    e.key = aiNormStrArray(raw.keys ?? raw.key);
    e.keysecondary = aiNormStrArray(raw.secondary_keys ?? raw.keysecondary);
    e.comment = String(raw.comment ?? raw.title ?? raw.name ?? '').trim();
    e.content = String(raw.content ?? '').trim();
    e.constant = !!raw.constant;
    if (raw.vectorized) e.vectorized = true;
    const pos = Number(raw.position);
    if (Number.isFinite(pos) && POSITION_OPTIONS.some(p => p[0] === pos)) e.position = pos;
    const ord = Number(raw.order);
    if (Number.isFinite(ord)) e.order = ord;
    const logic = Number(raw.selectiveLogic);
    if (Number.isFinite(logic) && LOGIC_OPTIONS.some(l => l[0] === logic)) e.selectiveLogic = logic;
    // selective is meaningful only with secondary keys (ST ignores them otherwise).
    e.selective = e.keysecondary.length > 0;
    e.addMemo = !!e.comment;
    return e;
}

// Drop empties: an entry with no content AND (no keys unless constant) is useless.
function aiEntryUsable(e) {
    if (!e.content) return false;
    if (!e.constant && !e.vectorized && (!Array.isArray(e.key) || e.key.length === 0)) return false;
    return true;
}

// ========================================
// AI: UI STATE + MODAL SHELL
// ========================================

let aiModalsBuilt = false;
let aiSourceMode = 'paste';      // paste | url | character
let aiFetchedText = '';          // resolved url/character source text
// From-SillyTavern source: pick characters and/or chats.
let stMode = 'characters';       // 'characters' | 'chats' sub-tab
let stSelChars = new Map();      // avatar -> { fields: Set<fieldKey> } (which card fields to send)
let stSelChats = new Map();      // `${avatar}:${file_name}` -> { file_name, avatar, charName, name, count, scope }
let stChatsCache = null;         // cached solo chats from /chats/recent
let stChatsLoading = false;
let aiCategoryMembers = null;    // [{ title, selected }] when a wiki Category was fetched
let aiCatWiki = null;            // { api, title } of the fetched category
let aiCategoryBlocks = null;     // ['## Title\n<text>', ...] member content capped to the current detail level
let aiCategoryPages = null;      // [{ title, text }] whole fetched pages (to AI_CAT_PER_PAGE_MAX); detail-capped on demand
let aiPageDetail = 'standard';   // lead | standard | full, how much of each page feeds the model
let aiCatCapped = 0;             // pages dropped by the total cap at the current detail (for the status line)
let aiGenerating = false;
let aiGenAbort = null;
let aiLastGen = null;            // { source, instructions } for single-entry regen

// staging
let stagingEntries = [];         // [{ id, e (native entry), include }]
let stagingSeq = 0;
let stagingTarget = 'current';   // 'current' | 'new'
let stagingNewName = '';         // destination name when stagingTarget === 'new'
let stagingExpanded = new Set(); // sids of expanded review cards
let stagingFilter = '';          // review-list filter query

function aiBuildModals() {
    if (aiModalsBuilt) return;
    aiModalsBuilt = true;
    const html = `
    <div id="lbAiGenerateModal" class="cl-modal">
        <div class="cl-modal-content lb-ai-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-wand-magic-sparkles cl-modal-header-icon"></i> Generate Lorebook with AI</h3>
                <button class="cl-modal-close" id="lbAiGenClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-ai-body">
                <div class="lb-ai-grid2">
                    <section class="lb-ai-section lb-ai-col-source">
                        <div class="lb-ai-section-head"><span class="lb-ai-step">1</span> Source material</div>
                        <div class="lb-ai-source-seg" role="group" aria-label="Source">
                            <button class="lb-ai-src-opt active" data-action="ai-src" data-mode="paste"><i class="fa-solid fa-paste"></i> <span>Paste text</span></button>
                            <button class="lb-ai-src-opt" data-action="ai-src" data-mode="url"><i class="fa-solid fa-globe"></i> <span>Web / Wiki</span></button>
                            <button class="lb-ai-src-opt" data-action="ai-src" data-mode="stcontext"><i class="fa-solid fa-layer-group"></i> <span>From SillyTavern</span></button>
                        </div>

                        <div class="lb-ai-src-panel" data-panel="paste">
                            <textarea id="lbAiPasteText" class="lb-ai-textarea lb-ai-textarea-tall" rows="7" placeholder="Paste source material here: a wiki article, a setting doc, a character bio, world notes..."></textarea>
                        </div>

                        <div class="lb-ai-src-panel hidden" data-panel="url">
                            <div class="lb-ai-url-row">
                                <input type="search" id="lbAiUrlInput" class="cl-input lb-ai-url-input" placeholder="https://yourfandom.fandom.com/wiki/Character (or a Category: page)" autocomplete="off">
                                <button class="cl-btn cl-btn-primary lb-ai-fetch-btn" id="lbAiFetchBtn"><i class="fa-solid fa-download"></i> Fetch</button>
                            </div>
                            <div class="lb-ai-cat-panel hidden" id="lbAiCatPanel">
                                <div class="lb-ai-cat-head">
                                    <span class="lb-ai-cat-count" id="lbAiCatCount"></span>
                                </div>
                                <div class="lb-ai-cat-searchrow">
                                    <div class="lb-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lbAiCatSearch" class="cl-input" placeholder="Filter pages..." autocomplete="off"></div>
                                    <button class="lb-icon-btn" data-action="cat-toggle-select" title="Select all"><i class="fa-solid fa-square-check"></i></button>
                                </div>
                                <div class="lb-ai-cat-list" id="lbAiCatList"></div>
                                <div class="lb-ai-cat-detail">
                                    <span class="lb-ai-cat-detail-label" title="How much of each page to send to the model. More detail means richer entries but more tokens per request.">Detail per page</span>
                                    <div class="lb-ai-detail-seg" role="group" aria-label="Detail per page">
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="lead" title="~1000 characters per page (the intro / lead). Concise entries, fits the most pages per request.">Lead</button>
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="standard" title="~3000 characters per page (lead plus the start of the body). Balanced.">Standard</button>
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="full" title="The entire page, no per-page trim. Richest entries, but the most tokens per request.">Full</button>
                                    </div>
                                </div>
                                <button class="cl-btn cl-btn-primary lb-ai-cat-load" id="lbAiCatLoad" disabled><i class="fa-solid fa-download"></i> Load selected</button>
                            </div>
                        </div>

                        <div class="lb-ai-src-panel hidden" data-panel="stcontext">
                            <div class="lb-ai-st-modes" role="group" aria-label="Source type">
                                <button type="button" class="lb-ai-st-mode active" data-action="st-mode" data-mode="characters"><i class="fa-solid fa-user"></i> Characters</button>
                                <button type="button" class="lb-ai-st-mode" data-action="st-mode" data-mode="chats"><i class="fa-solid fa-comments"></i> Chats</button>
                            </div>
                            <div class="lb-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lbAiStSearch" class="cl-input" placeholder="Search characters..." autocomplete="off"></div>
                            <div class="lb-ai-st-list" id="lbAiStList"></div>
                            <div class="lb-ai-st-tray hidden" id="lbAiStTray"></div>
                        </div>

                        <div class="lb-ai-source-info hidden" id="lbAiSourceInfo"></div>
                    </section>

                    <div class="lb-ai-col-settings">
                        <section class="lb-ai-section">
                            <div class="lb-ai-section-head"><span class="lb-ai-step">2</span> Instructions <span class="lb-ai-section-sub">optional</span></div>
                            <textarea id="lbAiInstructions" class="lb-ai-textarea" rows="5" placeholder="e.g. One entry per named character, location and faction. Keys should be names and common aliases. Keep each entry under 120 words. Skip real-world trivia."></textarea>
                        </section>

                        <section class="lb-ai-section">
                            <div class="lb-ai-section-head"><span class="lb-ai-step">3</span> Output</div>
                            <div class="lb-ai-settings-row">
                                <div class="lb-ai-field lb-ai-conn-field">
                                    <div class="lb-ai-label lb-ai-conn-label-row">
                                        <span>Connection</span>
                                        <span class="lb-ai-conn-status">
                                            <span class="lb-ai-conn-dot neutral" id="lbAiConnDot"></span>
                                            <span class="lb-ai-conn-label" id="lbAiConnLabel"></span>
                                        </span>
                                    </div>
                                    <select id="lbAiProfile" class="lb-sort-select cl-select-fluid"></select>
                                </div>
                                <div class="lb-ai-field hidden" id="lbAiNewNameWrap">
                                    <label class="lb-ai-label">New lorebook name</label>
                                    <input type="search" id="lbAiNewName" class="cl-input" placeholder="Lorebook name..." autocomplete="off">
                                </div>
                                <div class="lb-ai-field lb-ai-field-narrow">
                                    <label class="lb-ai-label" title="Maximum number of entries to generate. Leave blank (auto) to let the model decide.">Max</label>
                                    <input type="number" id="lbAiMaxEntries" class="cl-input lb-ai-num" min="0" max="100" step="1" placeholder="auto">
                                </div>
                                <div class="lb-ai-field lb-ai-field-narrow">
                                    <label class="lb-ai-label" title="Per-request budget for source material, in characters. A multi-page source is split into batches that each fit this, then results are merged. Each batch is also limited to ${AI_GEN_PAGES_PER_BATCH} pages (the most entries the model can return in one reply), so beyond that a larger budget will not pack more pages per batch. The token figure beside it is an estimate at ~4 chars per token.">Context <span class="lb-ai-label-hint" id="lbAiCtxHint" title="Your Context budget as an estimated token count. Each generate request sends up to about this many tokens of source material; compare it to your model or proxy's context window."></span></label>
                                    <input type="number" id="lbAiMaxContext" class="cl-input lb-ai-num" min="4000" max="200000" step="1000" value="24000">
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
            <div class="cl-modal-footer">
                <button class="cl-btn" id="lbAiGenCancel">Cancel</button>
                <button class="cl-btn cl-btn-primary" id="lbAiGenerateBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
            </div>
        </div>
    </div>

    <div id="lbAiStagingModal" class="cl-modal">
        <div class="cl-modal-content lb-ai-staging-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-check cl-modal-header-icon"></i> Review generated entries</h3>
                <button class="cl-modal-close" id="lbAiStageClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-ai-staging-body">
                <div class="lb-ai-staging-sub" id="lbAiStagingSub"></div>
                <div class="lb-ai-staging-controls">
                    <div class="lb-search-wrap lb-ai-stage-filter">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" id="lbAiStageFilter" class="cl-input" placeholder="Filter entries by title or key..." autocomplete="off">
                    </div>
                    <div class="lb-ai-staging-toolbar">
                        <button class="lb-icon-btn" data-action="stage-toggle-select" title="Select all"><i class="fa-solid fa-square-check"></i></button>
                        <button class="lb-icon-btn" data-action="stage-toggle-all" title="Expand all"><i class="fa-solid fa-down-left-and-up-right-to-center fa-rotate-90"></i></button>
                        <span class="lb-ai-staging-count" id="lbAiStagingCount"></span>
                    </div>
                </div>
                <div class="lb-ai-staging-list" id="lbAiStagingList"></div>
            </div>
            <div class="cl-modal-footer">
                <button class="cl-btn" id="lbAiStageBack"><i class="fa-solid fa-arrow-left"></i> Back to generate</button>
                <button class="cl-btn cl-btn-primary" id="lbAiStageCommit"><i class="fa-solid fa-plus"></i> Add selected</button>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    Array.from(wrap.children).forEach(el => document.body.appendChild(el));

    const sel = document.getElementById('lbAiProfile');
    if (sel) {
        CoreAPI.initCustomSelect(sel);
        sel.addEventListener('change', aiUpdateConnLabel);
    }
    aiAttachModalEvents();
}

// ========================================
// AI: GENERATE PANEL
// ========================================

function aiOpenGenerate(mode) {
    aiBuildModals();
    aiSourceMode = 'paste';
    aiFetchedText = '';
    stSelChars = new Map(); stSelChats = new Map(); stMode = 'characters';
    aiCategoryMembers = null; aiCatWiki = null; aiCategoryBlocks = null; aiCategoryPages = null;
    aiPageDetail = aiGetSavedPageDetail();
    aiSetSourceMode('paste');
    document.getElementById('lbAiPasteText').value = '';
    document.getElementById('lbAiUrlInput').value = '';
    document.getElementById('lbAiInstructions').value = '';
    document.getElementById('lbAiNewName').value = '';
    document.getElementById('lbAiMaxEntries').value = '';
    document.getElementById('lbAiMaxContext').value = aiGetSavedMaxContext();
    document.getElementById('lbAiCatSearch').value = '';
    document.getElementById('lbAiStSearch').value = '';
    document.getElementById('lbAiStTray').classList.add('hidden');
    document.getElementById('lbAiSourceInfo').classList.add('hidden');
    aiRenderCatPanel();
    aiRenderDetailSeg();
    aiRenderCtxHint();

    // Destination is implied by the launch point: the in-world "AI" button adds to the open
    // lorebook; the "New" split-button creates a new one. Fall back to new if no world is open.
    stagingTarget = (mode === 'current' && currentWorld) ? 'current' : 'new';
    document.getElementById('lbAiNewNameWrap').classList.toggle('hidden', stagingTarget !== 'new');

    aiLoadProfiles();
    document.getElementById('lbAiGenerateModal').classList.add('visible');
    if (!matchMedia('(pointer: coarse)').matches) document.getElementById('lbAiPasteText')?.focus();
}

// Dirty when the user has entered real work: source material, instructions, or an in-flight gen.
// New-name is excluded (fetch/category auto-prefill it, so it isn't a signal of user effort).
function aiGenerateDirty() {
    if (aiGenerating) return true;
    const paste = (document.getElementById('lbAiPasteText')?.value || '').trim();
    const instr = (document.getElementById('lbAiInstructions')?.value || '').trim();
    return !!(paste || instr || aiFetchedText || stSelChars.size || stSelChats.size || (aiCategoryMembers && aiCategoryMembers.length));
}

function aiCloseGenerate() {
    if (!aiGenerateDirty()) { aiForceCloseGenerate(); return; }
    CoreAPI.showConfirm({
        title: 'Discard this generation?',
        message: 'You have source material or instructions entered. Discard them and close?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
    }).then(ok => { if (ok) aiForceCloseGenerate(); });
}

function aiForceCloseGenerate() {
    if (aiGenerating) aiGenAbort?.abort(); // cancel an in-flight generation on close
    document.getElementById('lbAiGenerateModal')?.classList.remove('visible');
}

function aiSetSourceMode(mode) {
    aiSourceMode = mode;
    document.querySelectorAll('.lb-ai-src-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.querySelectorAll('.lb-ai-src-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== mode));
    if (mode === 'stcontext') aiStRefresh();
}

function aiSetSourceInfo(text, ok = true) {
    const el = document.getElementById('lbAiSourceInfo');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.toggle('error', !ok);
    el.innerHTML = text;
}

async function aiFetchUrl() {
    let url = document.getElementById('lbAiUrlInput').value.trim();
    if (!url) { CoreAPI.showToast('Enter a URL', 'warning'); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const btn = document.getElementById('lbAiFetchBtn');

    // A wiki Category page lists members, not content; enumerate them for selection instead.
    const wiki = aiDetectMediaWiki(url);
    if (wiki && /^Category:/i.test(wiki.title)) {
        if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
        try { await aiFetchCategoryMembers(wiki); }
        finally { if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); } }
        return;
    }

    // Single page: clear any prior category UI and fetch the page text directly.
    aiCategoryMembers = null; aiCatWiki = null; aiCategoryBlocks = null; aiCategoryPages = null; aiRenderCatPanel();
    if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
    aiSetSourceInfo('<i class="fa-solid fa-spinner fa-spin"></i> Fetching...');
    try {
        const { text, title } = await aiFetchSource(url);
        aiFetchedText = text;
        aiSetSourceInfo(`<i class="fa-solid fa-circle-check"></i> Fetched <strong>${esc(title || 'page')}</strong> (${text.length.toLocaleString()} chars${text.length >= AI_SOURCE_MAX_CHARS ? ', truncated' : ''})`);
        // prefill a sensible new-book name if the user hasn't typed one
        const nameEl = document.getElementById('lbAiNewName');
        if (nameEl && !nameEl.value && title) nameEl.value = title.slice(0, 60);
    } catch (e) {
        aiFetchedText = '';
        aiSetSourceInfo(`<i class="fa-solid fa-triangle-exclamation"></i> ${esc(e?.message || 'Fetch failed')}`, false);
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); }
    }
}

// ----- Wiki category crawling: enumerate members, then aggregate their page content -----

const AI_CAT_MAX_MEMBERS = 500;     // hard cap on enumerated members
const AI_CAT_DEFAULT_SELECTED = 40; // pre-checked by default
// Detail-per-page levels. Pages are fetched whole and the chosen level is applied at generate time,
// so detail can change without re-fetching. Full = the whole page (the ceiling only guards a monster page).
const AI_CAT_PER_PAGE_MAX = 100000; // fetch/Full ceiling per page (the entire text of any real wiki page)
const AI_CAT_DETAIL = { lead: 1000, standard: 3000, full: AI_CAT_PER_PAGE_MAX };
const AI_CAT_TOTAL_CAP = 1000000;   // safety ceiling on total loaded content (memory guard)

// Enumerate a category's member pages via the MediaWiki categorymembers API (paginated).
async function aiFetchCategoryMembers(wiki) {
    aiSetSourceInfo('<i class="fa-solid fa-spinner fa-spin"></i> Reading category members...');
    const members = [];
    let cont = '';
    try {
        do {
            const u = `${wiki.api}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(wiki.title)}&cmtype=page&cmlimit=500&format=json&origin=*${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''}`;
            const resp = await aiProxyFetch(u, { headers: { 'Accept': 'application/json' } });
            const data = await resp.json();
            for (const m of (data?.query?.categorymembers || [])) members.push(m.title);
            cont = data?.continue?.cmcontinue || '';
        } while (cont && members.length < AI_CAT_MAX_MEMBERS);
    } catch (e) {
        aiCategoryMembers = null; aiRenderCatPanel();
        aiSetSourceInfo(`<i class="fa-solid fa-triangle-exclamation"></i> Could not read that category: ${esc(e?.message || 'error')}`, false);
        return;
    }
    if (!members.length) {
        aiCategoryMembers = null; aiRenderCatPanel();
        aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> No member pages found in that category.', false);
        return;
    }
    aiCatWiki = wiki;
    aiFetchedText = ''; aiCategoryBlocks = null; aiCategoryPages = null; // nothing loaded until the user picks + loads
    aiCategoryMembers = members.map((title, i) => ({ title, selected: i < AI_CAT_DEFAULT_SELECTED }));
    document.getElementById('lbAiSourceInfo')?.classList.add('hidden');
    aiRenderCatPanel();
    const catName = wiki.title.replace(/^Category:/i, '').trim();
    const nameEl = document.getElementById('lbAiNewName');
    if (nameEl && !nameEl.value && catName) nameEl.value = catName.slice(0, 60);
}

function aiRenderCatPanel() {
    const panel = document.getElementById('lbAiCatPanel');
    if (!panel) return;
    if (!aiCategoryMembers) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const total = aiCategoryMembers.length;
    const sel = aiCategoryMembers.filter(m => m.selected).length;
    const countEl = document.getElementById('lbAiCatCount');
    if (countEl) countEl.textContent = `${total} page${total === 1 ? '' : 's'} found, ${sel} selected`;
    const q = (document.getElementById('lbAiCatSearch')?.value || '').trim().toLowerCase();
    const shown = q ? aiCategoryMembers.filter(m => m.title.toLowerCase().includes(q)) : aiCategoryMembers;
    const toggleBtn = document.querySelector('[data-action="cat-toggle-select"]');
    if (toggleBtn) {
        toggleBtn.style.display = shown.length ? '' : 'none'; // nothing visible to select
        const allSel = total > 0 && sel === total;
        toggleBtn.title = allSel ? 'Deselect all' : 'Select all';
        toggleBtn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
    }
    const listEl = document.getElementById('lbAiCatList');
    if (listEl) {
        listEl.innerHTML = shown.length
            ? shown.map(m => `
                <label class="lb-ai-cat-row">
                    <input type="checkbox" data-cat-title="${esc(m.title)}" ${m.selected ? 'checked' : ''}>
                    <span class="lb-ai-cat-name">${esc(m.title)}</span>
                </label>`).join('')
            : `<div class="lb-link-empty">No pages match.</div>`;
    }
    const loadBtn = document.getElementById('lbAiCatLoad');
    if (loadBtn) { loadBtn.disabled = sel === 0; loadBtn.innerHTML = `<i class="fa-solid fa-download"></i> Load ${sel} selected`; }
}

// Fetch each selected member's rendered page content and aggregate into the source. Uses
// action=parse (works on every MediaWiki, including Fandom which lacks the extracts API),
// per-page capped, with bounded concurrency so a 40-page pull stays quick.
async function aiLoadCategorySelection() {
    if (!aiCatWiki || !aiCategoryMembers) return;
    const titles = aiCategoryMembers.filter(m => m.selected).map(m => m.title);
    if (!titles.length) return;
    const btn = document.getElementById('lbAiCatLoad');
    if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
    document.getElementById('lbAiSourceInfo')?.classList.remove('hidden');

    const results = new Array(titles.length).fill(null);
    let next = 0, done = 0;
    const worker = async () => {
        while (next < titles.length) {
            const i = next++;
            const title = titles[i];
            try {
                const u = `${aiCatWiki.api}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&redirects=1&origin=*`;
                const resp = await aiProxyFetch(u, { headers: { 'Accept': 'application/json' } });
                const data = await resp.json();
                const html = data?.parse?.text?.['*'];
                // Store the whole page (to the fetch ceiling). The Detail-per-page control caps it at
                // generate time, so the user can change detail without re-fetching.
                const text = html ? aiHtmlToText(html).slice(0, AI_CAT_PER_PAGE_MAX).trim() : '';
                if (text) results[i] = { title: data?.parse?.title || title, text };
            } catch { /* skip this page */ }
            done++;
            aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Fetching page content (${done}/${titles.length})...`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(5, titles.length) }, worker));

    aiCategoryPages = results.filter(Boolean);
    if (!aiCategoryPages.length) {
        aiCategoryPages = null;
        if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); }
        aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> Could not fetch content for any of the selected pages.', false);
        return;
    }
    const { capped } = aiBuildCategoryBlocks();
    aiRenderCatLoadInfo(capped);
    if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); aiRenderCatPanel(); }
}

// Read the per-request char budget from the settings input (falls back to the default).
function aiCurrentMaxContext() {
    const raw = parseInt(document.getElementById('lbAiMaxContext')?.value, 10);
    return Number.isFinite(raw) && raw >= 4000 ? raw : AI_GEN_MAX_CONTEXT;
}

// Persisted per-request char budget. Mirrors the recommender's getSetting('recommender_<key>')
// pattern with a lorebook-scoped key; loaded on modal open, saved on generate.
function aiGetSavedMaxContext() {
    const v = parseInt(CoreAPI.getSetting('lorebook_aiMaxContext'), 10);
    return Number.isFinite(v) && v >= 4000 ? v : AI_GEN_MAX_CONTEXT;
}

// Persisted page-detail level. Same getSetting/setSetting shape as aiGetSavedMaxContext.
function aiGetSavedPageDetail() {
    const v = CoreAPI.getSetting('lorebook_aiPageDetail');
    return AI_CAT_DETAIL[v] !== undefined ? v : 'standard';
}

// Rough token estimate from char count (~4 chars/token, English). Display-only, always prefixed "~".
function aiEstTokens(chars) { return Math.round(chars / 4); }
function aiFmtTokens(chars) { const t = aiEstTokens(chars); return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`; }

// Rebuild the capped source blocks from the stored full pages at the current detail level. Returns
// how many pages were trimmed by the total safety cap.
function aiBuildCategoryBlocks() {
    if (!aiCategoryPages) { aiCategoryBlocks = null; aiFetchedText = ''; return { capped: 0 }; }
    const cap = AI_CAT_DETAIL[aiPageDetail] || AI_CAT_DETAIL.standard;
    const blocks = []; let total = 0, capped = 0;
    for (const p of aiCategoryPages) {
        const t = p.text.slice(0, cap).trim();
        if (!t) continue;
        const block = `## ${p.title}\n${t}`;
        if (total + block.length + 2 > AI_CAT_TOTAL_CAP) { capped++; continue; }
        total += block.length + 2; blocks.push(block);
    }
    aiCategoryBlocks = blocks;
    aiFetchedText = blocks.join('\n\n'); // resolved-source check + retry payload
    aiCatCapped = capped;
    return { capped };
}

// Loaded-pages status line with token + batch estimate; recomputed whenever detail or budget changes.
function aiRenderCatLoadInfo(capped = aiCatCapped) {
    const blocks = aiCategoryBlocks || [];
    if (!blocks.length) { aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> No usable page content at this detail level.', false); return; }
    const chars = aiFetchedText.length;
    const batches = aiSplitBlocksIntoBatches(blocks, aiCurrentMaxContext());
    const nb = batches.length;
    const perBatchMax = Math.max(...batches.map(b => b.join('\n\n').length));
    const maxPages = Math.max(...batches.map(b => b.length));
    const capNote = capped ? ` (${capped} trimmed past the ${(AI_CAT_TOTAL_CAP / 1000) | 0}k cap)` : '';
    // Surface WHY there are N batches: each request holds the smaller of the Context budget or the
    // page cap, so a big budget can still batch small. The cap is the model's reply limit, not ours.
    const why = `Each request holds whichever is smaller: your Context budget, or ${AI_GEN_PAGES_PER_BATCH} pages. That page limit is the most entries the model can return in one reply before its output truncates, so a larger Context budget will not pack more pages into a batch.`;
    const batchNote = nb > 1
        ? ` &rarr; <span class="lb-ai-info-why" title="${why}">${nb} batches of up to ${maxPages} pages (~${aiFmtTokens(perBatchMax)} tok input each)</span>`
        : ' &rarr; 1 request';
    aiSetSourceInfo(`<i class="fa-solid fa-circle-check"></i> ${blocks.length} page${blocks.length === 1 ? '' : 's'} at <strong>${aiPageDetail}</strong> detail (~${chars.toLocaleString()} chars, ~${aiFmtTokens(chars)} tokens)${capNote}${batchNote}.`);
}

// Mark the active detail button.
function aiRenderDetailSeg() {
    document.querySelectorAll('.lb-ai-detail-opt').forEach(b => b.classList.toggle('active', b.dataset.detail === aiPageDetail));
}

// Switch detail level: persist, restyle the segment, then rebuild blocks + refresh the line live.
function aiSetPageDetail(level) {
    if (!AI_CAT_DETAIL[level]) return;
    aiPageDetail = level;
    CoreAPI.setSetting('lorebook_aiPageDetail', level);
    aiRenderDetailSeg();
    if (aiCategoryPages) { const { capped } = aiBuildCategoryBlocks(); aiRenderCatLoadInfo(capped); }
}

// Token-equivalent shown inside the Context label (kept out of the input flow so it can't shift
// the row's bottom-aligned inputs).
function aiRenderCtxHint() {
    const hint = document.getElementById('lbAiCtxHint');
    if (hint) hint.textContent = `(~${aiFmtTokens(aiCurrentMaxContext())} tok)`;
}

// Pulse an element's accent glow once (used to nudge the load/fetch field when a user tries to
// generate with nothing fetched). Reflow so repeated clicks restart the animation.
function aiGlow(el) {
    if (!el) return;
    el.classList.remove('lb-ai-glow');
    void el.offsetWidth;
    el.classList.add('lb-ai-glow');
    el.addEventListener('animationend', () => el.classList.remove('lb-ai-glow'), { once: true });
}

// Glow the field the user still needs to fill for the active source mode.
function aiGlowMissingSource() {
    if (aiSourceMode === 'paste') return aiGlow(document.getElementById('lbAiPasteText'));
    if (aiSourceMode === 'stcontext') return aiGlow(document.getElementById('lbAiStList'));
    // url mode: an enumerated-but-not-loaded category points at Load selected, otherwise Fetch.
    if (aiCategoryMembers?.length && !aiCategoryBlocks?.length) return aiGlow(document.getElementById('lbAiCatLoad'));
    aiGlow(document.getElementById('lbAiFetchBtn'));
}

// Pack whole content blocks into batches that each stay within the char budget. A single
// oversized block (e.g. one long page, or the whole non-category source) gets its own batch.
function aiSplitBlocksIntoBatches(blocks, maxChars) {
    const batches = [];
    let cur = [], len = 0;
    for (const b of blocks) {
        const blen = b.length + 2;
        // New batch when the next block would blow the INPUT budget OR the batch already holds enough
        // pages that one-entry-per-page would overrun the OUTPUT token cap (which truncates results).
        if (cur.length && (len + blen > maxChars || cur.length >= AI_GEN_PAGES_PER_BATCH)) {
            batches.push(cur); cur = []; len = 0;
        }
        cur.push(b); len += blen;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

// ----- From SillyTavern: characters + chats picker -----

function aiStRefresh() {
    document.querySelectorAll('.lb-ai-st-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === stMode));
    const search = document.getElementById('lbAiStSearch');
    if (search) search.placeholder = stMode === 'chats' ? 'Search chats...' : 'Search characters...';
    if (stMode === 'chats') aiRenderStChatList(search?.value || '');
    else aiRenderStCharList(search?.value || '');
    aiRenderStTray();
}

function aiSetStMode(mode) {
    stMode = mode === 'chats' ? 'chats' : 'characters';
    document.querySelectorAll('.lb-ai-st-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === stMode));
    const search = document.getElementById('lbAiStSearch');
    if (search) search.value = '';
    if (stMode === 'chats' && !stChatsCache && !stChatsLoading) { aiLoadStChats(); aiRenderStTray(); return; }
    aiStRefresh();
}

function aiRenderStCharList(q) {
    const listEl = document.getElementById('lbAiStList');
    if (!listEl) return;
    const query = (q || '').trim().toLowerCase();
    const chars = (CoreAPI.getAllCharacters() || [])
        .filter(c => c && c.avatar && (!query || (c.name || '').toLowerCase().includes(query)))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .slice(0, 80);
    if (!chars.length) { listEl.innerHTML = `<div class="lb-link-empty">No characters match.</div>`; return; }
    listEl.innerHTML = chars.map(c => `
        <button class="lb-ai-st-row${stSelChars.has(c.avatar) ? ' selected' : ''}" data-action="st-pick-char" data-avatar="${esc(c.avatar)}" title="${esc(c.name || c.avatar)}">
            <span class="lb-ai-st-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy">
            <span class="lb-link-name">${esc(c.name || c.avatar)}</span>
        </button>`).join('');
}

// Load solo-character chats (with message counts) from /chats/recent, once, cached.
async function aiLoadStChats() {
    stChatsLoading = true;
    const listEl = document.getElementById('lbAiStList');
    if (listEl) listEl.innerHTML = `<div class="lb-ai-st-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats...</div>`;
    try {
        const resp = await CoreAPI.apiRequest('/chats/recent', 'POST', { metadata: true });
        const data = resp.ok ? await resp.json() : [];
        const byAvatar = new Map((CoreAPI.getAllCharacters() || []).map(c => [c.avatar, c]));
        stChatsCache = (data || [])
            .filter(ch => ch && ch.avatar && !ch.group && (ch.chat_items || 0) > 0 && byAvatar.has(ch.avatar))
            .map(ch => {
                // /chats/get appends .jsonl itself; pass the bare name like chats.js does.
                const bare = (ch.file_name || '').replace(/\.jsonl$/i, '');
                return {
                    file_name: bare,
                    avatar: ch.avatar,
                    charName: byAvatar.get(ch.avatar)?.name || ch.avatar,
                    name: bare,
                    count: ch.chat_items || 0,
                };
            });
    } catch { stChatsCache = []; }
    finally {
        stChatsLoading = false;
        if (aiSourceMode === 'stcontext' && stMode === 'chats') aiRenderStChatList(document.getElementById('lbAiStSearch')?.value || '');
    }
}

function aiRenderStChatList(q) {
    const listEl = document.getElementById('lbAiStList');
    if (!listEl) return;
    if (stChatsLoading) { listEl.innerHTML = `<div class="lb-ai-st-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats...</div>`; return; }
    if (!stChatsCache) { aiLoadStChats(); return; }
    const query = (q || '').trim().toLowerCase();
    const chats = stChatsCache
        .filter(c => !query || c.name.toLowerCase().includes(query) || (c.charName || '').toLowerCase().includes(query))
        .slice(0, 120);
    if (!chats.length) { listEl.innerHTML = `<div class="lb-link-empty">No chats match.</div>`; return; }
    listEl.innerHTML = chats.map(c => {
        const key = `${c.avatar}:${c.file_name}`;
        return `
        <button class="lb-ai-st-row${stSelChats.has(key) ? ' selected' : ''}" data-action="st-pick-chat" data-key="${esc(key)}" title="${esc(c.name)}">
            <span class="lb-ai-st-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarStThumbUrl(c.avatar))}" alt="" loading="lazy">
            <span class="lb-ai-st-chatmeta"><span class="lb-link-name">${esc(c.name)}</span><span class="lb-ai-st-sub">${esc(c.charName)} &middot; ${c.count} msg</span></span>
        </button>`;
    }).join('');
}

function aiToggleStChar(avatar) {
    if (stSelChars.has(avatar)) stSelChars.delete(avatar);
    else stSelChars.set(avatar, { fields: aiStAllFields() }); // all fields on by default
    aiStRefresh();
}

// Per-character field toggle (multi-select; mirrors the chat scope control but each is independent).
function aiStToggleField(avatar, field) {
    const c = stSelChars.get(avatar);
    if (!c) return;
    if (c.fields.has(field)) c.fields.delete(field); else c.fields.add(field);
    aiRenderStTray();
}

function aiStFieldPills(avatar, sel) {
    const pill = (key, label) => `<button type="button" class="lb-ai-st-field-opt${sel.has(key) ? ' active' : ''}" data-action="st-field" data-avatar="${esc(avatar)}" data-field="${key}">${esc(label)}</button>`;
    return `<div class="lb-ai-st-fields">${AI_ST_CHAR_FIELDS.map(f => pill(f[0], f[1])).join('')}</div>`;
}

function aiToggleStChat(key) {
    if (stSelChats.has(key)) stSelChats.delete(key);
    else {
        const c = (stChatsCache || []).find(x => `${x.avatar}:${x.file_name}` === key);
        if (c) stSelChats.set(key, { ...c, scope: { mode: 'all', n: AI_ST_LASTN_DEFAULT, from: 1, to: c.count } });
    }
    aiStRefresh();
}

// Per-chat scope control (All / Last N / Range), shown on its tray row.
function aiStScopeSeg(key, c) {
    const s = c.scope || { mode: 'all' };
    const seg = (mode, label) => `<button type="button" class="lb-ai-st-scope-opt${s.mode === mode ? ' active' : ''}" data-action="st-scope" data-key="${esc(key)}" data-scope="${mode}">${label}</button>`;
    let extra = '';
    if (s.mode === 'last') {
        extra = `<input type="number" class="lb-ai-st-scope-num" data-action="st-scope-n" data-key="${esc(key)}" min="1" value="${s.n || AI_ST_LASTN_DEFAULT}" title="Most-recent messages to include">`;
    } else if (s.mode === 'range') {
        extra = `<span class="lb-ai-st-range"><input type="number" class="lb-ai-st-scope-num" data-action="st-scope-from" data-key="${esc(key)}" min="1" value="${s.from || 1}" title="From message #"><span class="lb-ai-st-range-dash">to</span><input type="number" class="lb-ai-st-scope-num" data-action="st-scope-to" data-key="${esc(key)}" min="1" value="${s.to || c.count}" title="To message #"></span>`;
    }
    return `<div class="lb-ai-st-scope-seg">${seg('all', 'All')}${seg('last', 'Last')}${seg('range', 'Range')}</div>${extra}`;
}

function aiStSetScopeMode(key, mode) {
    const c = stSelChats.get(key);
    if (!c) return;
    c.scope = c.scope || {};
    c.scope.mode = mode;
    if (mode === 'last' && !c.scope.n) c.scope.n = AI_ST_LASTN_DEFAULT;
    if (mode === 'range') { if (!c.scope.from) c.scope.from = 1; if (!c.scope.to) c.scope.to = c.count || 1; }
    aiRenderStTray();
}

function aiStSetScopeNum(key, field, val) {
    const c = stSelChats.get(key);
    if (!c) return;
    const n = parseInt(val, 10);
    c.scope = c.scope || {};
    c.scope[field] = Number.isFinite(n) && n > 0 ? n : 1;
}

function aiRenderStTray() {
    const tray = document.getElementById('lbAiStTray');
    if (!tray) return;
    const nChar = stSelChars.size, nChat = stSelChats.size;
    if (!nChar && !nChat) { tray.classList.add('hidden'); tray.innerHTML = ''; return; }
    tray.classList.remove('hidden');
    const charLookup = new Map((CoreAPI.getAllCharacters() || []).map(c => [c.avatar, c]));
    const charCards = [...stSelChars].map(([av, sel]) => {
        const c = charLookup.get(av);
        return `
        <div class="lb-ai-st-chatpick">
            <div class="lb-ai-st-chatpick-top">
                <i class="fa-solid fa-user"></i>
                <span class="lb-ai-st-chatpick-name" title="${esc(c?.name || av)}">${esc(c?.name || av)}</span>
                <button class="lb-ai-st-chip-x" data-action="st-remove-char" data-avatar="${esc(av)}" title="Remove">&times;</button>
            </div>
            <div class="lb-ai-st-chatpick-scope">${aiStFieldPills(av, sel.fields)}</div>
        </div>`;
    }).join('');
    const chatCards = [...stSelChats.values()].map(c => {
        const key = `${c.avatar}:${c.file_name}`;
        return `
        <div class="lb-ai-st-chatpick">
            <div class="lb-ai-st-chatpick-top">
                <i class="fa-solid fa-comments"></i>
                <span class="lb-ai-st-chatpick-name" title="${esc(c.name)} (${esc(c.charName)})">${esc(c.name)}</span>
                <button class="lb-ai-st-chip-x" data-action="st-remove-chat" data-key="${esc(key)}" title="Remove">&times;</button>
            </div>
            <div class="lb-ai-st-chatpick-scope">${aiStScopeSeg(key, c)}</div>
        </div>`;
    }).join('');
    tray.innerHTML = `
        <div class="lb-ai-st-tray-head">Selected <span class="lb-ai-st-tray-count">${nChar} character${nChar === 1 ? '' : 's'}, ${nChat} chat${nChat === 1 ? '' : 's'}</span></div>
        ${(charCards || chatCards) ? `<div class="lb-ai-st-chatpicks">${charCards}${chatCards}</div>` : ''}`;
}

// Build one source block per selected character + chat (chats fetched + scoped here).
async function aiBuildStContextBlocks(signal) {
    const blocks = [];
    const charLookup = new Map((CoreAPI.getAllCharacters() || []).map(c => [c.avatar, c]));
    const total = stSelChars.size + stSelChats.size;
    let done = 0;
    for (const [av, sel] of stSelChars) {
        if (signal?.aborted) return blocks;
        aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Reading selection (${++done}/${total})...`);
        const block = await aiStCharBlock(charLookup.get(av), sel.fields);
        if (block) blocks.push(block);
    }
    for (const c of stSelChats.values()) {
        if (signal?.aborted) return blocks;
        aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Reading selection (${++done}/${total})...`);
        const block = await aiStChatBlock(c);
        if (block) blocks.push(block);
    }
    return blocks;
}

async function aiStCharBlock(char, fields) {
    if (!char) return '';
    const enabled = fields || aiStAllFields();
    try {
        await CoreAPI.hydrateCharacter(char);
        const d = char.data || char;
        const parts = [`## ${char.name || char.avatar}`];
        const push = (key, label, v) => { if (!enabled.has(key)) return; const t = (v || '').toString().trim(); if (t) parts.push(`${label}: ${t}`); };
        push('description', 'Description', d.description);
        push('personality', 'Personality', d.personality);
        push('scenario', 'Scenario', d.scenario);
        push('first_mes', 'First message', d.first_mes);
        push('mes_example', 'Example dialogue', d.mes_example);
        if (parts.length < 2) return '';
        return parts.join('\n').slice(0, AI_SOURCE_MAX_CHARS);
    } catch { return ''; }
}

async function aiStChatBlock(c) {
    try {
        const resp = await CoreAPI.apiRequest('/chats/get', 'POST', { ch_name: c.charName, file_name: c.file_name, avatar_url: c.avatar });
        if (!resp.ok) return '';
        let msgs = await resp.json();
        if (!Array.isArray(msgs)) return '';
        msgs = msgs.filter(m => m && !m.is_system && (m.mes || '').trim());
        const s = c.scope || { mode: 'all' };
        if (s.mode === 'last') msgs = msgs.slice(-Math.max(1, s.n || AI_ST_LASTN_DEFAULT));
        else if (s.mode === 'range') {
            const from = Math.max(1, s.from || 1);
            const to = Math.max(from, s.to || msgs.length);
            msgs = msgs.slice(from - 1, to);
        }
        if (!msgs.length) return '';
        const lines = msgs.map(m => `${m.name || (m.is_user ? 'User' : c.charName)}: ${(m.mes || '').replace(/\s+/g, ' ').trim()}`);
        let body = lines.join('\n');
        if (body.length > AI_ST_CHAT_CAP) body = body.slice(-AI_ST_CHAT_CAP); // keep the most recent within the cap
        return `## Chat: ${c.name} (${c.charName})\n${body}`;
    } catch { return ''; }
}

function aiResolveSource() {
    if (aiSourceMode === 'paste') return (document.getElementById('lbAiPasteText')?.value || '').trim();
    return (aiFetchedText || '').trim();
}

async function aiDoGenerate() {
    if (aiGenerating) { aiGenAbort?.abort(); return; }
    // Source presence check (stcontext source is built async below, so just check the selection).
    if (aiSourceMode === 'stcontext') {
        if (!stSelChars.size && !stSelChats.size) { CoreAPI.showToast('Pick characters or chats first', 'warning'); aiGlowMissingSource(); return; }
    } else if (!aiResolveSource()) {
        CoreAPI.showToast('Add some source material first', 'warning'); aiGlowMissingSource(); return;
    }

    const instructions = (document.getElementById('lbAiInstructions')?.value || '').trim();
    const maxRaw = parseInt(document.getElementById('lbAiMaxEntries')?.value, 10);
    const maxEntries = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 100) : 0;

    // stagingTarget was resolved from the launch point in aiOpenGenerate().
    let newName = '';
    if (stagingTarget === 'new') {
        newName = sanitizeWorldName(document.getElementById('lbAiNewName')?.value || '');
        if (!newName) { CoreAPI.showToast('Enter a name for the new lorebook', 'warning'); document.getElementById('lbAiNewName')?.focus(); return; }
        if (worldsList.some(w => w.file_id.toLowerCase() === newName.toLowerCase())) { CoreAPI.showToast('A lorebook with that name already exists', 'warning'); return; }
    } else if (!currentWorld) {
        CoreAPI.showToast('No lorebook open to add to; choose "New lorebook"', 'warning'); return;
    }
    stagingNewName = newName;

    const maxContext = aiCurrentMaxContext();
    CoreAPI.setSetting('lorebook_aiMaxContext', maxContext); // remember the budget for next time

    aiGenerating = true;
    aiGenAbort = new AbortController();
    const signal = aiGenAbort.signal;
    const btn = document.getElementById('lbAiGenerateBtn');
    // Stays enabled so a second click aborts (handled by the guard at the top).
    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stop';
    let batches = [];
    let multi = false;
    let completed = 0;
    const setBtn = () => {
        if (!btn) return;
        btn.innerHTML = multi
            ? `<i class="fa-solid fa-spinner fa-spin"></i> Stop (${completed}/${batches.length})`
            : '<i class="fa-solid fa-spinner fa-spin"></i> Stop';
    };

    // Per-batch cap only makes sense for a single request; across batches we collect everything
    // and slice to maxEntries at the end (so the cap isn't applied N times).
    const buildMsg = (batchBlocks) => {
        const constraints = (maxEntries && !multi) ? `Produce at most ${maxEntries} entries.\n\n` : '';
        return `${instructions ? `Instructions:\n${instructions}\n\n` : ''}${constraints}SOURCE MATERIAL:\n${batchBlocks.join('\n\n')}`;
    };

    try {
        // Source blocks: From-SillyTavern fetches chats async (with progress); a wiki category is
        // one block per member; everything else is a single source blob.
        let sourceBlocks;
        if (aiSourceMode === 'stcontext') {
            sourceBlocks = await aiBuildStContextBlocks(signal);
        } else if (aiSourceMode === 'url' && aiCategoryBlocks?.length) {
            sourceBlocks = aiCategoryBlocks;
        } else {
            sourceBlocks = [aiResolveSource()];
        }
        if (signal.aborted) { CoreAPI.showToast('Generation cancelled', 'info'); return; }
        if (!sourceBlocks.length) { CoreAPI.showToast('Could not read the selected sources. Try again.', 'warning'); return; }
        aiLastGen = { source: sourceBlocks.join('\n\n'), instructions };
        batches = aiSplitBlocksIntoBatches(sourceBlocks, maxContext);
        multi = batches.length > 1;
        setBtn();

        // Bounded concurrency: process all batches but cap simultaneous requests so a low
        // context budget (many batches) doesn't hammer the provider or trip rate limits.
        const settled = new Array(batches.length);
        let nextBatch = 0;
        const runOne = async () => {
            while (nextBatch < batches.length && !signal.aborted) {
                const i = nextBatch++;
                try {
                    const raw = await aiCallLLM(
                        [{ role: 'system', content: AI_GEN_SYSTEM }, { role: 'user', content: buildMsg(batches[i]) }],
                        { signal, maxTokens: AI_GEN_MAX_TOKENS, temperature: 0.7 },
                    );
                    const parsed = aiParseJsonArray(raw) || [];
                    // The model's array should end with a closing ']'; if it doesn't, the output hit
                    // the token cap and was cut off (the parser salvaged the complete entries before
                    // the cut). Surface it so an undercount reads as truncation, not silent loss.
                    const truncated = !/]\s*(?:```)?\s*$/.test(String(raw).trim());
                    CoreAPI.debugLog(`[Lorebooks AI] batch ${i + 1}/${batches.length}: ${batches[i].length} pages -> ${parsed.length} entries${truncated ? ' (OUTPUT TRUNCATED at the token cap)' : ''}`);
                    settled[i] = { status: 'fulfilled', value: parsed };
                } catch (e) {
                    settled[i] = { status: 'rejected', reason: e };
                }
                completed++; setBtn();
            }
        };
        await Promise.all(Array.from({ length: Math.min(AI_GEN_CONCURRENCY, batches.length) }, runOne));
        if (signal.aborted) { CoreAPI.showToast('Generation cancelled', 'info'); return; }

        let natives = [];
        let failed = 0;
        let firstErr = null;
        for (const r of settled) {
            if (r.status === 'rejected') { failed++; firstErr = firstErr || r.reason; continue; }
            natives.push(...r.value.map((x, i) => aiEntryToNative(x || {}, natives.length + i)).filter(aiEntryUsable));
        }
        natives = aiDedupeEntries(natives);
        if (maxEntries) natives = natives.slice(0, maxEntries);

        if (!natives.length) {
            if (failed === batches.length) {
                CoreAPI.showToast(firstErr?.message || 'The model did not return usable entries. Try again or adjust your instructions.', 'error', 7000);
            } else {
                CoreAPI.showToast('No usable entries were generated. Try again.', 'warning');
            }
            return;
        }

        stagingEntries = natives.map(e => ({ id: ++stagingSeq, e, include: true }));
        document.getElementById('lbAiGenerateModal')?.classList.remove('visible');
        aiOpenStaging();
        if (failed) CoreAPI.showToast(`${failed} of ${batches.length} batches failed; showing partial results.`, 'warning', 6000);
    } catch (e) {
        const msg = e?.message || String(e);
        if (/cancel/i.test(msg)) CoreAPI.showToast('Generation cancelled', 'info');
        else CoreAPI.showToast(msg, 'error', 7000);
    } finally {
        aiGenerating = false;
        aiGenAbort = null;
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate'; }
    }
}

// Drop entries whose title + first key collide (a model occasionally repeats across batches).
function aiDedupeEntries(natives) {
    const seen = new Set();
    const out = [];
    for (const e of natives) {
        const firstKey = (Array.isArray(e.key) && e.key[0] ? e.key[0] : '').toString().trim().toLowerCase();
        const sig = `${(e.comment || '').trim().toLowerCase()}|${firstKey}`;
        if (sig === '|') { out.push(e); continue; } // no title/key to compare on, keep it
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(e);
    }
    return out;
}

// ========================================
// AI: STAGING TRAY (review before commit)
// ========================================

function aiOpenStaging() {
    aiBuildModals();
    stagingFilter = '';
    stagingExpanded = new Set();
    // Small batches open expanded for immediate review; large ones stay collapsed and scannable.
    if (stagingEntries.length <= 5) stagingEntries.forEach(s => stagingExpanded.add(s.id));
    const filterEl = document.getElementById('lbAiStageFilter');
    if (filterEl) filterEl.value = '';
    aiRenderStaging();
    document.getElementById('lbAiStagingModal').classList.add('visible');
}

function aiCloseStaging() {
    if (!stagingEntries.length) { aiForceCloseStaging(); return; }
    const n = stagingEntries.length;
    CoreAPI.showConfirm({
        title: 'Discard generated entries?',
        message: `You have ${n} generated entr${n === 1 ? 'y' : 'ies'} that haven't been added yet. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep',
        danger: true,
    }).then(ok => { if (ok) aiForceCloseStaging(); });
}

function aiForceCloseStaging() {
    document.getElementById('lbAiStagingModal')?.classList.remove('visible');
}

function aiStagingSelectedCount() { return stagingEntries.filter(s => s.include).length; }

function aiUpdateStagingCount() {
    const el = document.getElementById('lbAiStagingCount');
    if (el) el.textContent = `${aiStagingSelectedCount()} of ${stagingEntries.length} selected`;
    const commit = document.getElementById('lbAiStageCommit');
    if (commit) commit.disabled = aiStagingSelectedCount() === 0;
    aiUpdateStageToggleSelect();
}

// Master select/deselect-all toggle reflects whether every filtered entry is included.
function aiUpdateStageToggleSelect() {
    const btn = document.querySelector('[data-action="stage-toggle-select"]');
    if (!btn) return;
    const visible = aiVisibleStaging();
    const allSel = visible.length > 0 && visible.every(s => s.include);
    btn.title = allSel ? 'Deselect all' : 'Select all';
    btn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
}

// Master expand/collapse-all toggle reflects whether every filtered entry is expanded.
function aiUpdateStageToggleAll() {
    const btn = document.querySelector('[data-action="stage-toggle-all"]');
    if (!btn) return;
    const visible = aiVisibleStaging();
    const allExp = visible.length > 0 && visible.every(s => stagingExpanded.has(s.id));
    btn.title = allExp ? 'Collapse all' : 'Expand all';
    btn.innerHTML = `<i class="fa-solid ${allExp ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center fa-rotate-90'}"></i>`;
}

// Entries matching the current filter (title or any key). Bulk actions operate on this set.
function aiVisibleStaging() {
    const q = stagingFilter.trim().toLowerCase();
    if (!q) return stagingEntries;
    return stagingEntries.filter(s => {
        const keys = Array.isArray(s.e.key) ? s.e.key.join(' ') : '';
        return (s.e.comment || '').toLowerCase().includes(q) || keys.toLowerCase().includes(q);
    });
}

// First few keys as compact pills (with a +N overflow), or a muted "no keys".
function aiStageKeyPills(keysArr) {
    if (!keysArr.length) return '<span class="lb-stage-nokeys"><i class="fa-solid fa-key"></i> no keys</span>';
    const shown = keysArr.slice(0, 5);
    const extra = keysArr.length - shown.length;
    return shown.map(k => `<span class="lb-stage-keypill">${esc(k)}</span>`).join('')
        + (extra > 0 ? `<span class="lb-stage-keypill lb-stage-keypill-more">+${extra}</span>` : '');
}

// One review card: a collapsible entry mirroring the main editor's lb-entry.
function aiStageCardHtml(s) {
    const e = s.e;
    const expanded = stagingExpanded.has(s.id);
    const keysArr = Array.isArray(e.key) ? e.key : [];
    const keys = keysArr.join(', ');
    const hasTitle = !!(e.comment && e.comment.trim());
    const titleHtml = hasTitle
        ? `<span class="lb-entry-title">${esc(e.comment)}</span>`
        : `<span class="lb-entry-title lb-stage-untitled">Untitled entry</span>`;
    const flat = (e.content || '').replace(/\s+/g, ' ').trim();
    const snippet = flat ? `${esc(flat.slice(0, 140))}${flat.length > 140 ? '…' : ''}` : '';
    return `
    <div class="lb-entry lb-stage-card${expanded ? ' expanded' : ''}${s.include ? '' : ' lb-stage-excluded'}" data-sid="${s.id}">
        <div class="lb-entry-head" data-action="stage-expand" data-sid="${s.id}">
            <label class="lb-switch" data-stop title="${s.include ? 'Included (toggle to exclude)' : 'Excluded (toggle to include)'}">
                <input type="checkbox" data-action="stage-toggle" data-sid="${s.id}" ${s.include ? 'checked' : ''}>
                <span class="lb-switch-track"></span>
            </label>
            <div class="lb-entry-summary">
                <div class="lb-entry-title-line">
                    ${titleHtml}
                    ${e.constant ? '<span class="lb-badge constant" title="Constant: always on"><i class="fa-solid fa-anchor"></i></span>' : ''}
                </div>
                <div class="lb-entry-sub lb-stage-keyrow" title="${esc(keys)}">${aiStageKeyPills(keysArr)}</div>
                ${!expanded && snippet ? `<div class="lb-stage-snippet">${snippet}</div>` : ''}
            </div>
            <div class="lb-entry-head-actions">
                <button class="lb-icon-btn small" data-action="stage-regen" data-sid="${s.id}" data-stop title="Regenerate this entry"><i class="fa-solid fa-rotate"></i></button>
                <button class="lb-icon-btn small danger" data-action="stage-del" data-sid="${s.id}" data-stop title="Discard this entry"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-down lb-entry-chevron${expanded ? ' open' : ''}"></i>
            </div>
        </div>
        ${expanded ? `
        <div class="lb-entry-body lb-stage-body">
            <input class="lb-ai-stage-title" data-sf="comment" data-sid="${s.id}" value="${esc(e.comment)}" placeholder="Title" autocomplete="off">
            <div class="lb-ai-stage-keys-row">
                <i class="fa-solid fa-key"></i>
                <input class="lb-ai-stage-keys" data-sf="key" data-sid="${s.id}" value="${esc(keys)}" placeholder="comma, separated, keys" autocomplete="off">
            </div>
            <textarea class="lb-ai-stage-content" data-sf="content" data-sid="${s.id}" rows="5" placeholder="Content">${esc(e.content)}</textarea>
        </div>` : ''}
    </div>`;
}

// Re-render a single card in place (expand/collapse) without rebuilding the whole list.
function aiRefreshStageCard(sid) {
    const s = aiStageRow(sid);
    const card = document.querySelector(`.lb-stage-card[data-sid="${sid}"]`);
    if (s && card) card.outerHTML = aiStageCardHtml(s);
    aiUpdateStageToggleAll();
}

function aiRenderStaging() {
    const sub = document.getElementById('lbAiStagingSub');
    if (sub) {
        const destIcon = stagingTarget === 'new' ? 'fa-book-medical' : 'fa-book';
        const destName = stagingTarget === 'new' ? stagingNewName : currentWorld;
        const n = stagingEntries.length;
        sub.innerHTML = `<span>${n} entr${n === 1 ? 'y' : 'ies'} generated. Review and edit, then add the selected ones to</span> <span class="lb-meta-pill"><i class="fa-solid ${destIcon}"></i> ${esc(destName || '')}</span>`;
    }
    const listEl = document.getElementById('lbAiStagingList');
    if (!listEl) return;
    if (!stagingEntries.length) { listEl.innerHTML = `<div class="lb-link-empty">No entries left.</div>`; aiUpdateStagingCount(); aiUpdateStageToggleAll(); return; }
    const visible = aiVisibleStaging();
    if (!visible.length) { listEl.innerHTML = `<div class="lb-link-empty">No entries match "${esc(stagingFilter)}".</div>`; aiUpdateStagingCount(); aiUpdateStageToggleAll(); return; }
    listEl.innerHTML = visible.map(aiStageCardHtml).join('');
    aiUpdateStagingCount();
    aiUpdateStageToggleAll();
}

function aiStageRow(sid) { return stagingEntries.find(s => s.id === Number(sid)); }

function aiStageEdit(sid, field, value) {
    const row = aiStageRow(sid);
    if (!row) return;
    if (field === 'key') {
        row.e.key = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (field === 'comment') {
        row.e.comment = value;
        row.e.addMemo = !!value.trim();
    } else if (field === 'content') {
        row.e.content = value;
    }
}

// Scope the regen source for one entry. For a batched category source, the full joined text can
// be far larger than one context window, so prefer the member block that matches the subject and
// fall back to a bounded slice. Single-source generations already fit, so use them as-is.
function aiRegenSource(subject) {
    const full = aiLastGen?.source || '';
    if (Array.isArray(aiCategoryBlocks) && aiCategoryBlocks.length) {
        const subj = (subject || '').trim().toLowerCase();
        if (subj) {
            const match = aiCategoryBlocks.find(b => {
                const head = (b.split('\n', 1)[0] || '').replace(/^#+\s*/, '').trim().toLowerCase();
                return head && (head === subj || head.includes(subj) || subj.includes(head));
            });
            if (match) return match.slice(0, AI_GEN_MAX_CONTEXT);
        }
        return full.slice(0, AI_GEN_MAX_CONTEXT);
    }
    return full;
}

async function aiRegenStageRow(sid) {
    const row = aiStageRow(sid);
    if (!row || !aiLastGen) return;
    const btn = document.querySelector(`.lb-stage-card[data-sid="${sid}"] [data-action="stage-regen"]`);
    if (btn) { btn.disabled = true; btn.querySelector('i')?.classList.add('fa-spin'); }
    try {
        const subject = row.e.comment || (row.e.key || []).join(', ') || 'this subject';
        const regenSource = aiRegenSource(subject);
        const userMsg = `${aiLastGen.instructions ? `Instructions:\n${aiLastGen.instructions}\n\n` : ''}From the SOURCE below, produce ONE improved World Info entry for: ${subject}. Return a JSON array containing exactly one entry object.\n\nSOURCE MATERIAL:\n${regenSource}`;
        const raw = await aiCallLLM(
            [{ role: 'system', content: AI_GEN_SYSTEM }, { role: 'user', content: userMsg }],
            { maxTokens: 2000, temperature: 0.8 },
        );
        const arr = aiParseJsonArray(raw);
        if (arr && arr[0]) {
            const fresh = aiEntryToNative(arr[0], row.e.uid);
            if (aiEntryUsable(fresh)) { row.e = fresh; aiRenderStaging(); CoreAPI.showToast('Regenerated', 'success'); return; }
        }
        CoreAPI.showToast('Could not regenerate that entry', 'warning');
    } catch (e) {
        CoreAPI.showToast(e?.message || 'Regenerate failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.querySelector('i')?.classList.remove('fa-spin'); }
    }
}

async function aiCommitStaging() {
    const selected = stagingEntries.filter(s => s.include);
    if (!selected.length) return;

    // Resolve the destination world into the manager's working copy.
    if (stagingTarget === 'new') {
        const name = stagingNewName;
        if (worldsList.some(w => w.file_id.toLowerCase() === name.toLowerCase())) { CoreAPI.showToast('That name now exists; rename and retry', 'warning'); return; }
        const ok = await CoreAPI.createWorldInfo(name);
        if (!ok) { CoreAPI.showToast('Could not create the lorebook', 'error'); return; }
        await refreshList();
        // selectWorld honors its own unsaved-edits guard for whatever world is currently
        // open; if the user keeps editing that one, the switch is cancelled and we abort
        // rather than append generated entries to the wrong working copy.
        await selectWorld(name);
        if (currentWorld !== name) { CoreAPI.showToast('Switch cancelled; entries not added', 'info'); return; }
    } else if (!currentWorld || !workingWorld) {
        CoreAPI.showToast('No lorebook open to add to', 'error'); return;
    }

    if (!workingWorld) { CoreAPI.showToast('Could not open the target lorebook', 'error'); return; }
    if (!workingWorld.entries) workingWorld.entries = {};

    let added = 0;
    for (const s of selected) {
        const uid = nextUid();
        s.e.uid = uid;
        s.e.displayIndex = uid;
        workingWorld.entries[uid] = s.e;
        added++;
    }
    markDirty();
    updateSaveButton();
    setEditingMode(true);
    renderEditor();
    stagingEntries = []; // committed; clear so the close guard sees a clean tray
    aiForceCloseStaging();
    CoreAPI.showToast(`Added ${added} entr${added === 1 ? 'y' : 'ies'} to "${currentWorld}". Review and Save to apply.`, 'success', 5000);
}

// ========================================
// AI: MODAL EVENT WIRING (one-time)
// ========================================

function aiAttachModalEvents() {
    // Generate modal
    document.getElementById('lbAiGenClose')?.addEventListener('click', aiCloseGenerate);
    document.getElementById('lbAiGenCancel')?.addEventListener('click', aiCloseGenerate);
    document.getElementById('lbAiGenerateModal')?.addEventListener('click', (e) => { if (e.target.id === 'lbAiGenerateModal') aiCloseGenerate(); });
    document.getElementById('lbAiGenerateBtn')?.addEventListener('click', aiDoGenerate);
    document.getElementById('lbAiFetchBtn')?.addEventListener('click', aiFetchUrl);
    document.getElementById('lbAiUrlInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aiFetchUrl(); } });
    document.getElementById('lbAiStSearch')?.addEventListener('input', () => aiStRefresh());
    document.querySelectorAll('.lb-ai-st-mode').forEach(b => b.addEventListener('click', () => aiSetStMode(b.dataset.mode)));
    document.getElementById('lbAiStTray')?.addEventListener('click', (e) => {
        const rmChar = e.target.closest('[data-action="st-remove-char"]');
        if (rmChar) { aiToggleStChar(rmChar.dataset.avatar); return; }
        const rmChat = e.target.closest('[data-action="st-remove-chat"]');
        if (rmChat) { aiToggleStChat(rmChat.dataset.key); return; }
        const scope = e.target.closest('[data-action="st-scope"]');
        if (scope) { aiStSetScopeMode(scope.dataset.key, scope.dataset.scope); return; }
        const fld = e.target.closest('[data-action="st-field"]');
        if (fld) { aiStToggleField(fld.dataset.avatar, fld.dataset.field); return; }
    });
    document.getElementById('lbAiStTray')?.addEventListener('input', (e) => {
        const el = e.target.closest('[data-action^="st-scope-"]');
        if (!el) return;
        const field = el.dataset.action === 'st-scope-n' ? 'n' : el.dataset.action === 'st-scope-from' ? 'from' : 'to';
        aiStSetScopeNum(el.dataset.key, field, el.value);
    });
    document.querySelectorAll('.lb-ai-src-opt').forEach(b => b.addEventListener('click', () => aiSetSourceMode(b.dataset.mode)));
    document.getElementById('lbAiStList')?.addEventListener('click', (e) => {
        const charRow = e.target.closest('[data-action="st-pick-char"]');
        if (charRow) { aiToggleStChar(charRow.dataset.avatar); return; }
        const chatRow = e.target.closest('[data-action="st-pick-chat"]');
        if (chatRow) { aiToggleStChat(chatRow.dataset.key); return; }
    });

    // Wiki category member selection
    document.getElementById('lbAiCatLoad')?.addEventListener('click', aiLoadCategorySelection);
    document.getElementById('lbAiCatSearch')?.addEventListener('input', aiRenderCatPanel);
    // Context budget drives batch count + token-per-request, so refresh the load line + hint live.
    document.getElementById('lbAiMaxContext')?.addEventListener('input', () => {
        aiRenderCtxHint();
        if (aiCategoryPages) aiRenderCatLoadInfo();
    });
    document.getElementById('lbAiCatList')?.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-cat-title]');
        if (!cb || !aiCategoryMembers) return;
        const m = aiCategoryMembers.find(x => x.title === cb.dataset.catTitle);
        if (m) { m.selected = cb.checked; aiRenderCatPanel(); }
    });
    document.getElementById('lbAiCatPanel')?.addEventListener('click', (e) => {
        const act = e.target.closest('[data-action]')?.dataset.action;
        if (act === 'cat-toggle-select') {
            const allSel = aiCategoryMembers?.length && aiCategoryMembers.every(m => m.selected);
            aiCategoryMembers?.forEach(m => { m.selected = !allSel; });
            aiRenderCatPanel();
        } else if (act === 'cat-detail') {
            aiSetPageDetail(e.target.closest('[data-action]').dataset.detail);
        }
    });

    // Staging modal
    document.getElementById('lbAiStageClose')?.addEventListener('click', aiCloseStaging);
    document.getElementById('lbAiStagingModal')?.addEventListener('click', (e) => { if (e.target.id === 'lbAiStagingModal') aiCloseStaging(); });
    document.getElementById('lbAiStageBack')?.addEventListener('click', () => { aiForceCloseStaging(); document.getElementById('lbAiGenerateModal')?.classList.add('visible'); });
    document.getElementById('lbAiStageCommit')?.addEventListener('click', aiCommitStaging);
    const stageList = document.getElementById('lbAiStagingList');
    stageList?.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        const sid = Number(actionEl.dataset.sid);
        if (action === 'stage-regen') { aiRegenStageRow(sid); return; }
        if (action === 'stage-del') { stagingExpanded.delete(sid); stagingEntries = stagingEntries.filter(s => s.id !== sid); aiRenderStaging(); return; }
        if (action === 'stage-expand') {
            if (e.target.closest('[data-stop]')) return; // the switch + head buttons don't toggle expand
            if (stagingExpanded.has(sid)) stagingExpanded.delete(sid); else stagingExpanded.add(sid);
            aiRefreshStageCard(sid);
        }
    });
    stageList?.addEventListener('change', (e) => {
        const toggle = e.target.closest('[data-action="stage-toggle"]');
        if (!toggle) return;
        const r = aiStageRow(toggle.dataset.sid);
        if (r) { r.include = toggle.checked; e.target.closest('.lb-stage-card')?.classList.toggle('lb-stage-excluded', !r.include); aiUpdateStagingCount(); }
    });
    stageList?.addEventListener('input', (e) => {
        const field = e.target.dataset.sf;
        if (field) aiStageEdit(e.target.dataset.sid, field, e.target.value);
    });
    document.getElementById('lbAiStageFilter')?.addEventListener('input', (e) => { stagingFilter = e.target.value; aiRenderStaging(); });
    // Two master toggles (selection + expansion), each acting on the filtered set so they
    // compose with the filter box.
    document.querySelector('[data-action="stage-toggle-select"]')?.addEventListener('click', () => {
        const visible = aiVisibleStaging();
        const allSel = visible.length > 0 && visible.every(s => s.include);
        visible.forEach(s => { s.include = !allSel; });
        aiRenderStaging();
    });
    document.querySelector('[data-action="stage-toggle-all"]')?.addEventListener('click', () => {
        const visible = aiVisibleStaging();
        const allExpanded = visible.length > 0 && visible.every(s => stagingExpanded.has(s.id));
        visible.forEach(s => allExpanded ? stagingExpanded.delete(s.id) : stagingExpanded.add(s.id));
        aiRenderStaging();
    });

}

// ========================================
// LIFECYCLE
// ========================================

function init() {
    if (isInitialized) return;
    isInitialized = true;

    // Register overlays so Escape and Android back close them (picker first, then manager).
    if (!eventsAttached) {
        eventsAttached = true;
        window.registerOverlay?.({
            id: 'lbLinkModal',
            tier: 6,
            close: () => closeLinkPicker(),
            visible: (el) => el.classList.contains('visible'),
        });
        // AI leaf modals close before the link picker / manager (lower tier closes first).
        window.registerOverlay?.({
            id: 'lbAiStagingModal',
            tier: 4,
            close: () => aiCloseStaging(),
            visible: (el) => el.classList.contains('visible'),
        });
        window.registerOverlay?.({
            id: 'lbAiGenerateModal',
            tier: 5,
            close: () => aiCloseGenerate(),
            visible: (el) => el.classList.contains('visible'),
        });
        window.registerOverlay?.({
            id: 'lorebookModal',
            tier: 7,
            close: () => handleModalBack(),
        });
    }
    CoreAPI.debugLog('[Lorebooks] Module initialized');
}

export { openModal, closeModal };

export default {
    init,
    openModal,
};
