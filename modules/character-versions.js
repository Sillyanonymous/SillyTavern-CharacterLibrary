/**
 * Character Versions Module for SillyTavern Character Library
 * 
 * Provides version history + local snapshots, rendered inline as a tab pane
 * inside the character detail modal.
 * 
 * Two data sources:
 * - Remote: ChubAI V4 API (GitLab-compatible) — published version history
 * - Local: User-created snapshots stored on the filesystem via ST's Files API
 * 
 * Storage: Per-character JSON files in ST's `user/files/` directory,
 * accessed via `/api/files/upload`, `/api/files/delete`, and static
 * serve at `/user/files/`. An index file provides O(1) lookups even
 * with 10k+ character libraries.
 * 
 * File layout in `user/files/`:
 *   _clv_index.json           — master index (version_uid → metadata + avatar map)
 *   _clv_{version_uid}.json   — per-character snapshots + backup
 * 
 * Identity: Each character gets a stable `version_uid` (stored in
 * data.extensions.version_uid) on first snapshot. This UID travels WITH
 * the card PNG, surviving renames and reimports. Lookups fall back to
 * `avatar` filename for backwards compatibility via the index's avatarMap.
 * 
 * @module CharacterVersions
 * @version 4.0.0
 */

import * as CoreAPI from './core-api.js';

// ========================================
// MODULE STATE
// ========================================

let isInitialized = false;

// Remote version caches
const versionListCache = new Map(); // fullPath -> { versions, fetchedAt, projectId }
const VERSION_LIST_CACHE_TTL = 5 * 60 * 1000;
const versionDataCache = new Map(); // projectId:ref -> cardData
const VERSION_DATA_CACHE_MAX = 20;

// Active pane state
let paneContainer = null;
let currentChar = null;
let currentProjectId = null;
let currentFullPath = null;
let currentVersions = [];
let selectedVersionRef = null;
let activeTab = 'remote';
let currentLocalSnapshots = [];
let selectedSnapshotId = null;
let paneDelegationHandler = null;
let _dialogOpen = false; // re-entry guard for dialogs

// ========================================
// FILESYSTEM STORAGE VIA ST FILES API
// ========================================

const FILE_PREFIX = '_clv_';
const INDEX_FILE = `${FILE_PREFIX}index.json`;

// In-memory cache (loaded once on first access)
let cachedIndex = null;
let charDataCache = new Map(); // version_uid -> char file data

// Fields captured in snapshots / restores
const CARD_FIELDS = [
    'name', 'description', 'personality', 'scenario',
    'first_mes', 'mes_example', 'system_prompt',
    'post_history_instructions', 'creator_notes', 'creator',
    // 'character_version', // Always "main" on ChubAI — excluded from diffs
    'tags', 'alternate_greetings', 'character_book'
];

// --- Low-level File I/O ---

/**
 * Encode a string to base64 (unicode-safe)
 */
function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/**
 * Upload a JSON object as a file to ST's user/files/ directory
 * @param {string} name - Filename (e.g., '_clv_index.json')
 * @param {Object} data - Data to serialize as JSON
 */
async function fileUpload(name, data) {
    const jsonStr = JSON.stringify(data);
    const base64 = toBase64(jsonStr);
    const resp = await CoreAPI.apiRequest('/files/upload', 'POST', { name, data: base64 });
    if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`File upload failed (${resp.status}): ${err}`);
    }
    return resp.json();
}

/**
 * Read a JSON file from ST's user/files/ directory
 * @param {string} name - Filename
 * @returns {Object|null} Parsed JSON or null if not found
 */
async function fileRead(name) {
    try {
        const resp = await fetch(`/user/files/${name}`);
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch (e) {
        console.warn(`[CharVersions] fileRead(${name}):`, e.message);
        return null;
    }
}

/**
 * Delete a file from ST's user/files/ directory
 * @param {string} name - Filename
 * @returns {boolean} Success
 */
async function fileDelete(name) {
    try {
        const resp = await CoreAPI.apiRequest('/files/delete', 'POST', { path: `user/files/${name}` });
        return resp.ok;
    } catch (e) {
        console.warn(`[CharVersions] fileDelete(${name}):`, e.message);
        return false;
    }
}

// --- Index Management ---

/**
 * Create an empty index object
 */
function createEmptyIndex() {
    return { version: 1, characters: {}, avatarMap: {} };
}

/**
 * Ensure the master index is loaded into memory.
 * Loads from filesystem on first call, then cached.
 */
async function ensureIndexLoaded() {
    if (cachedIndex) return cachedIndex;
    cachedIndex = await fileRead(INDEX_FILE);
    if (!cachedIndex || typeof cachedIndex !== 'object' || !cachedIndex.characters) {
        cachedIndex = createEmptyIndex();
    }
    return cachedIndex;
}

/**
 * Persist the in-memory index to filesystem
 */
async function saveIndex() {
    if (!cachedIndex) return;
    await fileUpload(INDEX_FILE, cachedIndex);
}

/**
 * Update the index entry for a character and persist
 * @param {string} versionUid - Character's version_uid
 * @param {string} name - Character name
 * @param {string} avatar - Current avatar filename
 * @param {number} snapshotCount - Number of snapshots
 */
async function updateIndex(versionUid, name, avatar, snapshotCount) {
    await ensureIndexLoaded();
    cachedIndex.characters[versionUid] = {
        name,
        avatar,
        snapshotCount,
        lastModified: Date.now()
    };
    // Update avatar map (remove old mappings to this uid, add current)
    for (const [av, uid] of Object.entries(cachedIndex.avatarMap)) {
        if (uid === versionUid && av !== avatar) delete cachedIndex.avatarMap[av];
    }
    cachedIndex.avatarMap[avatar] = versionUid;
    await saveIndex();
}

/**
 * Remove a character from the index
 */
async function removeFromIndex(versionUid) {
    await ensureIndexLoaded();
    delete cachedIndex.characters[versionUid];
    for (const [av, uid] of Object.entries(cachedIndex.avatarMap)) {
        if (uid === versionUid) delete cachedIndex.avatarMap[av];
    }
    await saveIndex();
}

/**
 * Look up a version_uid by avatar filename (fallback for chars without uid)
 */
async function lookupUidByAvatar(avatar) {
    await ensureIndexLoaded();
    return cachedIndex.avatarMap[avatar] || null;
}

// --- Character File Management ---

function charFileName(versionUid) {
    return `${FILE_PREFIX}${versionUid}.json`;
}

function createEmptyCharFile(versionUid, name, avatar) {
    return {
        version_uid: versionUid,
        name,
        avatar,
        nextId: 1,
        snapshots: [],
        backup: null
    };
}

/**
 * Load a character's version file (with in-memory cache)
 */
async function loadCharFile(versionUid) {
    if (charDataCache.has(versionUid)) return charDataCache.get(versionUid);
    const data = await fileRead(charFileName(versionUid));
    if (data) charDataCache.set(versionUid, data);
    return data;
}

/**
 * Save a character's version file and update index
 */
async function saveCharFile(versionUid, charFile) {
    charDataCache.set(versionUid, charFile);
    await fileUpload(charFileName(versionUid), charFile);
    await updateIndex(versionUid, charFile.name, charFile.avatar, charFile.snapshots.length);
}

// --- Storage API ---

/**
 * Save a snapshot for a character.
 * For auto_backup snapshots: deduplicates against the latest auto_backup
 * and caps the total count to the configured max (default 10).
 */
async function storageSaveSnapshot(avatar, charName, label, source, data, versionUid) {
    if (!versionUid) throw new Error('version_uid required');
    let charFile = await loadCharFile(versionUid);
    if (!charFile) charFile = createEmptyCharFile(versionUid, charName, avatar);

    // Update metadata
    charFile.name = charName;
    charFile.avatar = avatar;

    const dataCopy = JSON.parse(JSON.stringify(data));

    // Dedup: skip if the latest auto_backup for this character is identical
    if (source === 'auto_backup') {
        const existing = charFile.snapshots.filter(s => s.source === 'auto_backup');
        if (existing.length > 0) {
            const latest = existing[existing.length - 1];
            if (JSON.stringify(latest.data) === JSON.stringify(dataCopy)) {
                console.log('[CharVersions] Skipping duplicate auto-backup snapshot');
                return latest.id;
            }
        }
    }

    const id = charFile.nextId++;
    charFile.snapshots.push({
        id,
        label,
        source,
        timestamp: Date.now(),
        charName,
        data: dataCopy
    });

    // Cap: prune oldest auto_backup snapshots beyond max
    if (source === 'auto_backup') {
        const maxBackups = CoreAPI.getSetting('maxAutoBackups') ?? 10;
        if (maxBackups > 0) {
            const autoBackups = charFile.snapshots.filter(s => s.source === 'auto_backup');
            if (autoBackups.length > maxBackups) {
                const toRemove = autoBackups.slice(0, autoBackups.length - maxBackups);
                const removeIds = new Set(toRemove.map(s => s.id));
                charFile.snapshots = charFile.snapshots.filter(s => !removeIds.has(s.id));
            }
        }
    }

    await saveCharFile(versionUid, charFile);
    return id;
}

/**
 * Get all snapshots for a character (by version_uid with avatar fallback)
 */
async function storageGetSnapshots(avatar, versionUid) {
    let uid = versionUid;
    if (!uid) uid = await lookupUidByAvatar(avatar);
    if (!uid) return [];

    const charFile = await loadCharFile(uid);
    if (!charFile || !charFile.snapshots) return [];

    // Return sorted by timestamp descending (newest first)
    return [...charFile.snapshots].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get a single snapshot by ID
 */
async function storageGetSnapshot(versionUid, snapshotId) {
    if (!versionUid) return null;
    const charFile = await loadCharFile(versionUid);
    if (!charFile) return null;
    return charFile.snapshots.find(s => s.id === snapshotId) || null;
}

/**
 * Delete a snapshot by ID
 */
async function storageDeleteSnapshot(versionUid, snapshotId) {
    if (!versionUid) return;
    const charFile = await loadCharFile(versionUid);
    if (!charFile) return;
    charFile.snapshots = charFile.snapshots.filter(s => s.id !== snapshotId);

    if (charFile.snapshots.length === 0 && !charFile.backup) {
        // No data left — remove the file entirely
        charDataCache.delete(versionUid);
        await fileDelete(charFileName(versionUid));
        await removeFromIndex(versionUid);
    } else {
        await saveCharFile(versionUid, charFile);
    }
}

/**
 * Rename a snapshot
 */
async function storageRenameSnapshot(versionUid, snapshotId, newLabel) {
    if (!versionUid) return;
    const charFile = await loadCharFile(versionUid);
    if (!charFile) return;
    const snap = charFile.snapshots.find(s => s.id === snapshotId);
    if (!snap) throw new Error('Snapshot not found');
    snap.label = newLabel;
    await saveCharFile(versionUid, charFile);
}

/**
 * Save a pre-restore backup
 */
async function storageSaveBackup(avatar, versionUid, data) {
    if (!versionUid) return;
    let charFile = await loadCharFile(versionUid);
    if (!charFile) charFile = createEmptyCharFile(versionUid, '', avatar);
    charFile.avatar = avatar;
    charFile.backup = {
        timestamp: Date.now(),
        data: JSON.parse(JSON.stringify(data))
    };
    await saveCharFile(versionUid, charFile);
}

/**
 * Get the pre-restore backup
 */
async function storageGetBackup(versionUid) {
    if (!versionUid) return null;
    const charFile = await loadCharFile(versionUid);
    return charFile?.backup || null;
}

/**
 * Clear the pre-restore backup
 */
async function storageClearBackup(versionUid) {
    if (!versionUid) return;
    const charFile = await loadCharFile(versionUid);
    if (!charFile) return;
    charFile.backup = null;

    if (charFile.snapshots.length === 0) {
        charDataCache.delete(versionUid);
        await fileDelete(charFileName(versionUid));
        await removeFromIndex(versionUid);
    } else {
        await saveCharFile(versionUid, charFile);
    }
}

// ========================================
// ========================================

function generateVersionUid() {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let r = '';
    for (let i = 0; i < 16; i++) r += c.charAt(Math.floor(Math.random() * c.length));
    return r;
}

function getVersionUid(char) {
    return char?.data?.extensions?.version_uid || null;
}

/**
 * Ensure a character has a version_uid. Creates and persists one if missing.
 * @param {Object} char - Character object
 * @returns {Promise<string>} The version_uid
 */
async function ensureVersionUid(char) {
    let uid = getVersionUid(char);
    if (uid) return uid;

    uid = generateVersionUid();
    const success = await CoreAPI.applyCardFieldUpdates(char.avatar, {
        'extensions.version_uid': uid
    });

    if (success) {
        // Update local reference too
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        char.data.extensions.version_uid = uid;
        console.log(`[CharVersions] Assigned version_uid ${uid} to ${char.name || char.avatar}`);
    } else {
        console.warn('[CharVersions] Failed to persist version_uid — using ephemeral');
    }
    return uid;
}

// ========================================
// CARD DATA EXTRACTION
// ========================================

function extractCardData(char) {
    const src = char.data || char;
    const out = {};
    for (const f of CARD_FIELDS) {
        if (src[f] !== undefined) out[f] = JSON.parse(JSON.stringify(src[f]));
    }
    // Preserve avatar URL for snapshot comparisons
    if (char.avatar) {
        out._avatarUrl = `/characters/${encodeURIComponent(char.avatar)}`;
    }
    return out;
}

// ========================================
// CHUB V4 API
// ========================================

async function fetchWithProxy(url, opts = {}) {
    try {
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
    } catch (_) {
        const r = await fetch(`/proxy/${encodeURIComponent(url)}`, opts);
        if (!r.ok) {
            if (r.status === 404) {
                const t = await r.text();
                if (t.includes('CORS proxy is disabled')) throw new Error('CORS proxy is disabled in SillyTavern settings');
            }
            throw new Error(`HTTP ${r.status}`);
        }
        return r;
    }
}

function getHeaders() {
    return CoreAPI.getChubHeaders?.() || { Accept: 'application/json' };
}

async function getProjectId(fullPath) {
    try { const m = await CoreAPI.fetchChubMetadata(fullPath); return m?.id || null; }
    catch { return null; }
}

async function fetchVersionList(projectId) {
    const r = await fetchWithProxy(
        `https://api.chub.ai/api/v4/projects/${projectId}/repository/commits`,
        { headers: getHeaders() }
    );
    const d = await r.json();
    return Array.isArray(d) ? d : [];
}

async function fetchVersionData(projectId, ref) {
    const key = `${projectId}:${ref}`;
    if (versionDataCache.has(key)) return versionDataCache.get(key);

    const url = `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`;
    try {
        const r = await fetchWithProxy(url, { headers: getHeaders() });
        const d = await r.json();
        if (versionDataCache.size >= VERSION_DATA_CACHE_MAX) {
            versionDataCache.delete(versionDataCache.keys().next().value);
        }
        versionDataCache.set(key, d);
        return d;
    } catch (e) {
        console.error('[CharVersions] fetchVersionData:', ref, e);
        return null;
    }
}

// ========================================
// INITIALIZATION
// ========================================

export function init(deps) {
    if (isInitialized) return;
    injectStyles();
    // Lazy-load index in background (non-blocking)
    ensureIndexLoaded()
        .catch(e => console.error('[CharVersions] Init error:', e));
    isInitialized = true;
    console.log('[CharVersions] Module initialized (v4 — filesystem storage)');
}

// ========================================
// PUBLIC API
// ========================================

/**
 * Open the character detail modal and switch to the Versions tab.
 * Called from context menu, ChubAI Link modal button, etc.
 */
export function openVersionHistory(char) {
    if (!char) return;
    CoreAPI.openCharacterModal(char);
    setTimeout(() => {
        const btn = document.querySelector('.tab-btn[data-tab="versions"]');
        if (btn) btn.click();
    }, 100);
}

/**
 * Render the Versions pane inside a container element.
 * Called by the Versions tab click handler in library.js.
 * @param {HTMLElement} container - The tab pane container
 * @param {Object} char - Character object
 */
export function renderVersionsPane(container, char) {
    if (!container || !char) return;

    paneContainer = container;
    currentChar = char;
    currentFullPath = CoreAPI.getChubLinkInfo(char)?.fullPath || null;
    currentProjectId = null;
    currentVersions = [];
    selectedVersionRef = null;
    currentLocalSnapshots = [];
    selectedSnapshotId = null;
    activeTab = currentFullPath ? 'remote' : 'local';

    container.innerHTML = buildPaneHtml();
    setupPaneDelegation(container);

    if (activeTab === 'remote') {
        loadRemoteVersions(currentFullPath);
    } else {
        loadLocalSnapshots();
    }
}

/**
 * Cleanup when the modal closes or tab switches away.
 */
export function cleanupVersionsPane() {
    if (paneContainer && paneDelegationHandler) {
        paneContainer.removeEventListener('click', paneDelegationHandler);
    }
    currentChar = null;
    currentProjectId = null;
    currentFullPath = null;
    currentVersions = [];
    selectedVersionRef = null;
    currentLocalSnapshots = [];
    selectedSnapshotId = null;
    paneContainer = null;
    paneDelegationHandler = null;
}

/**
 * Quick-save a snapshot of the current character (callable externally)
 */
export async function saveCurrentSnapshot(char, label = '') {
    const uid = await ensureVersionUid(char);
    const data = extractCardData(char);
    const charName = char.data?.name || char.name || 'Unknown';
    const finalLabel = label || `Snapshot ${new Date().toLocaleString()}`;
    await storageSaveSnapshot(char.avatar, charName, finalLabel, 'local', data, uid);
    CoreAPI.showToast(`Snapshot saved: "${finalLabel}"`, 'success');
}

/**
 * Auto-snapshot before a change (edit, update, restore).
 * Only runs if the autoSnapshotOnEdit setting is enabled.
 * @param {Object} char - Character object (with current pre-change data)
 * @param {'edit'|'update'|'restore'} source - What triggered the snapshot
 */
export async function autoSnapshotBeforeChange(char, source = 'edit') {
    if (!char) return;
    const enabled = CoreAPI.getSetting('autoSnapshotOnEdit');
    if (!enabled) return;
    try {
        const uid = await ensureVersionUid(char);
        const data = extractCardData(char);
        const charName = char.data?.name || char.name || 'Unknown';
        const timestamp = new Date().toLocaleString();
        const label = `${source.charAt(0).toUpperCase() + source.slice(1)} - ${timestamp}`;
        await storageSaveSnapshot(char.avatar, charName, label, 'auto_backup', data, uid);
    } catch (e) {
        console.error('[CharVersions] Auto-snapshot failed:', e);
    }
}

// ========================================
// SCOPED DOM HELPERS
// ========================================

function el(sel) { return paneContainer?.querySelector(sel); }

// ========================================
// PANE HTML
// ========================================

function buildPaneHtml() {
    const hasChub = !!currentFullPath;
    return `
        <div class="vt-container">
            <button class="vt-btn vt-back-btn"><i class="fa-solid fa-arrow-left"></i> Back to list</button>
            <div class="vt-toolbar">
                ${hasChub ? `
                <div class="vt-sub-tabs">
                    <button class="vt-sub-tab ${activeTab === 'remote' ? 'active' : ''}" data-vt-tab="remote">
                        <i class="fa-solid fa-cloud"></i> Remote
                    </button>
                    <button class="vt-sub-tab ${activeTab === 'local' ? 'active' : ''}" data-vt-tab="local">
                        <i class="fa-solid fa-bookmark"></i> Local
                    </button>
                </div>` : `
                <div class="vt-sub-tabs">
                    <span class="vt-sub-tab active" style="cursor:default;">
                        <i class="fa-solid fa-bookmark"></i> Local Snapshots
                    </span>
                </div>`}
                <div class="vt-toolbar-right">
                    <button class="vt-btn vt-save-snapshot" title="Save current card state as a snapshot">
                        <i class="fa-solid fa-camera"></i> Save Snapshot
                    </button>
                    <button class="vt-btn vt-refresh" title="Refresh">
                        <i class="fa-solid fa-arrows-rotate"></i>
                    </button>
                </div>
            </div>
            <div class="vt-status">
                <i class="fa-solid fa-spinner fa-spin"></i> Loading...
            </div>
            <div class="vt-body">
                <div class="vt-list"></div>
                <div class="vt-preview vt-hidden"></div>
            </div>
            <div class="vt-actions vt-hidden">
                <div class="vt-actions-left">
                    <button class="vt-btn vt-rename" title="Rename snapshot"><i class="fa-solid fa-pen"></i></button>
                    <button class="vt-btn vt-delete" title="Delete snapshot"><i class="fa-solid fa-trash-can"></i></button>
                </div>
                <div class="vt-actions-right">
                    <button class="vt-btn vt-undo" title="Undo last restore"><i class="fa-solid fa-rotate-left"></i> Undo</button>
                    <button class="vt-btn vt-restore" title="Restore this version"><i class="fa-solid fa-download"></i> Restore</button>
                </div>
            </div>
        </div>
    `;
}

// ========================================
// EVENT DELEGATION
// ========================================

function setupPaneDelegation(container) {
    // Remove previous handler to prevent accumulation on re-renders
    if (paneDelegationHandler) {
        container.removeEventListener('click', paneDelegationHandler);
    }

    paneDelegationHandler = (e) => {
        if (e.target.closest('.vt-back-btn')) { closeMobileDetail(); return; }

        const tab = e.target.closest('[data-vt-tab]');
        if (tab) { switchTab(tab.dataset.vtTab); return; }

        // Remote version selection
        const vItem = e.target.closest('.vt-item[data-ref]');
        if (vItem) { selectVersion(vItem.dataset.ref, vItem.dataset.fullId); return; }

        // Local snapshot selection
        const sItem = e.target.closest('.vt-item[data-snapshot-id]');
        if (sItem) { selectSnapshot(Number(sItem.dataset.snapshotId)); return; }

        // Greeting block expand/collapse (check first so it doesn't bubble to outer diff header)
        const gh = e.target.closest('.vt-greeting-header');
        if (gh) { gh.parentElement.classList.toggle('expanded'); return; }

        // Diff expand/collapse
        const dh = e.target.closest('.vt-diff-header');
        if (dh) { dh.parentElement.classList.toggle('expanded'); return; }

        // Buttons (guard against re-entry while a dialog is open)
        if (_dialogOpen) return;
        if (e.target.closest('.vt-save-snapshot')) { handleSaveSnapshot(); return; }
        if (e.target.closest('.vt-refresh')) { handleRefresh(); return; }
        if (e.target.closest('.vt-restore')) { restoreVersion(); return; }
        if (e.target.closest('.vt-undo')) { undoRestore(); return; }
        if (e.target.closest('.vt-rename')) { handleRenameSnapshot(); return; }
        if (e.target.closest('.vt-delete')) { handleDeleteSnapshot(); return; }

        // Apply avatar button
        const applyAvBtn = e.target.closest('.vt-apply-avatar');
        if (applyAvBtn) { handleApplyAvatar(applyAvBtn.dataset.avatarUrl); return; }
    };

    container.addEventListener('click', paneDelegationHandler);
}

// ========================================
// TAB SWITCHING
// ========================================

async function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;

    // Update sub-tab buttons
    paneContainer.querySelectorAll('.vt-sub-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.vtTab === tab);
    });

    // Reset selection
    selectedVersionRef = null;
    selectedSnapshotId = null;
    const preview = el('.vt-preview');
    if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
    const actions = el('.vt-actions');
    if (actions) actions.classList.add('vt-hidden');
    el('.vt-container')?.classList.remove('vt-detail-open');

    if (tab === 'remote' && currentFullPath) {
        await loadRemoteVersions(currentFullPath);
    } else if (tab === 'local') {
        await loadLocalSnapshots();
    }
}

function closeMobileDetail() {
    el('.vt-container')?.classList.remove('vt-detail-open');
}

function handleRefresh() {
    if (activeTab === 'remote' && currentFullPath) {
        versionListCache.delete(currentFullPath);
        loadRemoteVersions(currentFullPath);
    } else if (activeTab === 'local') {
        loadLocalSnapshots();
    }
}

// ========================================
// REMOTE VERSIONS
// ========================================

async function loadRemoteVersions(fullPath) {
    const status = el('.vt-status');
    const list = el('.vt-list');
    if (!status || !list) return;

    try {
        const cached = versionListCache.get(fullPath);
        if (cached && Date.now() - cached.fetchedAt < VERSION_LIST_CACHE_TTL) {
            currentProjectId = cached.projectId;
            currentVersions = cached.versions;
            renderRemoteList(cached.versions);
            return;
        }

        status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching project info...';
        list.innerHTML = '';

        const projectId = await getProjectId(fullPath);
        if (!projectId) {
            status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Could not find project on ChubAI';
            return;
        }
        currentProjectId = projectId;

        status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading version history...';
        const versions = await fetchVersionList(projectId);

        if (!versions.length) {
            status.innerHTML = '<i class="fa-solid fa-info-circle"></i> No version history found';
            return;
        }

        currentVersions = versions;
        versionListCache.set(fullPath, { projectId, versions, fetchedAt: Date.now() });
        renderRemoteList(versions);
    } catch (e) {
        console.error('[CharVersions] loadRemoteVersions:', e);
        status.innerHTML = `<i class="fa-solid fa-xmark"></i> Error: ${esc(e.message)}`;
    }
}

function renderRemoteList(versions) {
    const status = el('.vt-status');
    const list = el('.vt-list');
    status.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> ${versions.length} version${versions.length !== 1 ? 's' : ''} found`;

    list.innerHTML = versions.map((v, idx) => {
        const date = new Date(v.committed_date || v.created_at);
        const vid = v.short_id || v.id;
        const title = v.title || v.message || 'Update';
        const isLatest = idx === 0;
        return `
            <div class="vt-item ${isLatest ? 'latest' : ''}" data-ref="${esc(vid)}" data-full-id="${esc(v.id)}">
                <div class="vt-item-header">
                    <span class="vt-item-id">${esc(vid)}</span>
                    ${isLatest ? '<span class="vt-badge latest">Latest</span>' : ''}
                </div>
                <div class="vt-item-title">${esc(truncate(title, 55))}</div>
                <div class="vt-item-date">
                    <i class="fa-regular fa-clock"></i>
                    <span title="${esc(date.toLocaleString())}">${relTime(date)}</span>
                </div>
            </div>`;
    }).join('');
}

// ========================================
// LOCAL SNAPSHOTS
// ========================================

async function loadLocalSnapshots() {
    const status = el('.vt-status');
    const list = el('.vt-list');
    const preview = el('.vt-preview');
    const actions = el('.vt-actions');
    if (!status || !list) return;

    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading snapshots...';
    list.innerHTML = '';
    if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
    if (actions) actions.classList.add('vt-hidden');

    try {
        const uid = getVersionUid(currentChar);
        const snaps = await storageGetSnapshots(currentChar.avatar, uid);
        currentLocalSnapshots = snaps;
        selectedSnapshotId = null;

        if (!snaps.length) {
            status.innerHTML = '<i class="fa-solid fa-info-circle"></i> No snapshots yet — click <b>Save Snapshot</b> to create one';
            return;
        }
        status.innerHTML = `<i class="fa-solid fa-bookmark"></i> ${snaps.length} snapshot${snaps.length !== 1 ? 's' : ''}`;
        renderSnapshotList(snaps);
    } catch (e) {
        console.error('[CharVersions] loadLocalSnapshots:', e);
        status.innerHTML = '<i class="fa-solid fa-xmark"></i> Error loading snapshots';
    }
}

function renderSnapshotList(snaps) {
    const list = el('.vt-list');
    list.innerHTML = snaps.map(s => {
        const date = new Date(s.timestamp);
        let icon;
        switch (s.source) {
            case 'chub_restore': icon = 'fa-cloud-arrow-down'; break;
            case 'auto_backup': icon = 'fa-shield-halved'; break;
            default: icon = 'fa-bookmark';
        }
        return `
            <div class="vt-item" data-snapshot-id="${s.id}">
                <div class="vt-item-header">
                    <i class="fa-solid ${icon} vt-item-icon"></i>
                    <span class="vt-item-label">${esc(truncate(s.label, 40))}</span>
                </div>
                <div class="vt-item-date">
                    <i class="fa-regular fa-clock"></i>
                    <span title="${esc(date.toLocaleString())}">${relTime(date)}</span>
                </div>
            </div>`;
    }).join('');
}

// ========================================
// SELECTION HANDLERS
// ========================================

async function selectVersion(shortId, fullId) {
    if (!currentProjectId) return;
    selectedVersionRef = shortId;
    selectedSnapshotId = null;

    paneContainer.querySelectorAll('.vt-item').forEach(i =>
        i.classList.toggle('selected', i.dataset.ref === shortId)
    );

    updateActionsVisibility();
    el('.vt-container')?.classList.add('vt-detail-open');

    const preview = el('.vt-preview');
    preview.classList.remove('vt-hidden');
    preview.innerHTML = '<div class="vt-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading version data...</div>';

    try {
        const data = await fetchVersionData(currentProjectId, shortId);
        if (!data) { preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-exclamation-triangle"></i> Could not load version data</div>'; return; }
        const card = normalizeChubDef(data);
        renderDiffPreview(preview, currentChar?.data || currentChar, card, data);
    } catch (e) {
        preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-xmark"></i> Error loading preview</div>';
    }
}

async function selectSnapshot(id) {
    selectedSnapshotId = id;
    selectedVersionRef = null;

    paneContainer.querySelectorAll('.vt-item').forEach(i =>
        i.classList.toggle('selected', String(i.dataset.snapshotId) === String(id))
    );

    updateActionsVisibility();
    el('.vt-container')?.classList.add('vt-detail-open');

    const preview = el('.vt-preview');
    preview.classList.remove('vt-hidden');
    preview.innerHTML = '<div class="vt-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading snapshot...</div>';

    try {
        const uid = getVersionUid(currentChar) || await lookupUidByAvatar(currentChar.avatar);
        const snap = uid ? await storageGetSnapshot(uid, id) : null;
        if (!snap) { preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-exclamation-triangle"></i> Snapshot not found</div>'; return; }
        renderDiffPreview(preview, currentChar?.data || currentChar, snap.data, null);
    } catch {
        preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-xmark"></i> Error loading snapshot</div>';
    }
}

function updateActionsVisibility() {
    const actions = el('.vt-actions');
    if (!actions) return;

    const hasSelection = selectedVersionRef || selectedSnapshotId;
    actions.classList.toggle('vt-hidden', !hasSelection);

    // Show rename/delete only for local snapshots
    const rename = actions.querySelector('.vt-rename');
    const del = actions.querySelector('.vt-delete');
    if (rename) rename.style.display = activeTab === 'local' && selectedSnapshotId ? '' : 'none';
    if (del) del.style.display = activeTab === 'local' && selectedSnapshotId ? '' : 'none';
}

// ========================================
// DIFF PREVIEW
// ========================================

/**
 * @param {HTMLElement} previewEl
 * @param {Object} localData - current card data
 * @param {Object} compareData - normalized version/snapshot data
 * @param {Object|null} rawChubData - raw card.json (for avatar URL)
 */
function renderDiffPreview(previewEl, localData, compareData, rawChubData) {
    const fields = [
        { key: 'name', label: 'Name', icon: 'fa-signature' },
        { key: 'description', label: 'Description', long: true, icon: 'fa-align-left' },
        { key: 'personality', label: 'Personality', long: true, icon: 'fa-brain' },
        { key: 'scenario', label: 'Scenario', long: true, icon: 'fa-map' },
        { key: 'first_mes', label: 'First Message', long: true, icon: 'fa-comment' },
        { key: 'mes_example', label: 'Example Messages', long: true, icon: 'fa-comment-dots' },
        { key: 'system_prompt', label: 'System Prompt', long: true, icon: 'fa-terminal' },
        { key: 'post_history_instructions', label: 'Post-History Instructions', long: true, icon: 'fa-clipboard-list' },
        { key: 'creator_notes', label: 'Creator Notes', long: true, icon: 'fa-note-sticky' },
        { key: 'creator', label: 'Creator', icon: 'fa-user-pen' },
        // { key: 'character_version', label: 'Character Version' }, // Always "main" on ChubAI — excluded
        { key: 'tags', label: 'Tags', isArray: true, icon: 'fa-tags' },
        { key: 'alternate_greetings', label: 'Alternate Greetings', long: true, isArray: true, icon: 'fa-comments' },
        { key: 'character_book', label: 'Embedded Lorebook', icon: 'fa-book' },
    ];

    let diffCount = 0;
    let html = '';

    // Avatar image — show the selected version/snapshot's avatar
    const snapshotAvatar = compareData._avatarUrl;
    const remoteAvatar = rawChubData?.data?.avatar;
    const avatarUrl = remoteAvatar || snapshotAvatar;
    if (avatarUrl) {
        html += renderAvatarPreview(avatarUrl);
    }

    for (const f of fields) {
        const lv = nested(localData, f.key);
        const rv = compareData[f.key];

        // Lorebook needs semantic comparison (ST adds internal fields like uid, display_index)
        if (f.key === 'character_book') {
            if (lorebooksEqual(lv, rv)) continue;
            diffCount++;
            html += renderLorebookDiff(f, lv, rv);
            continue;
        }

        if (normVal(lv) === normVal(rv)) continue;
        diffCount++;

        if (f.key === 'tags') {
            html += renderTagsDiff(f, lv, rv);
        } else if (f.key === 'alternate_greetings') {
            html += renderGreetingsDiff(f, lv, rv);
        } else if (f.key === 'character_book') {
            html += renderLorebookDiff(f, lv, rv);
        } else if (f.long) {
            html += renderLongDiff(f, lv, rv);
        } else {
            html += renderShortDiff(f, lv, rv);
        }
    }

    if (diffCount === 0 && !html) {
        previewEl.innerHTML = `<div class="vt-preview-header"><i class="fa-solid fa-check" style="color:var(--cl-success);"></i> Identical to your current local card.</div>`;
        return;
    }

    previewEl.innerHTML = `
        <div class="vt-preview-header">
            <i class="fa-solid fa-arrow-right-arrow-left"></i>
            ${diffCount} field${diffCount !== 1 ? 's' : ''} differ from local
        </div>
        <div class="vt-diff-list">${html}</div>
    `;
}

/**
 * Render the avatar thumbnail for the selected version/snapshot with apply button.
 */
function renderAvatarPreview(avatarUrl) {
    if (!avatarUrl) return '';
    return `
        <div class="vt-avatar-preview">
            <span class="vt-diff-label">Avatar</span>
            <img class="vt-avatar-thumb" src="${esc(avatarUrl)}" alt="Version avatar"
                 onerror="this.style.display='none'" loading="lazy" />
            <button class="vt-btn vt-apply-avatar" data-avatar-url="${esc(avatarUrl)}"
                    title="Apply this avatar to the character">
                <i class="fa-solid fa-file-import"></i>
            </button>
        </div>
    `;
}

function fieldIcon(field) {
    return field.icon ? `<i class="fa-solid ${field.icon} vt-field-icon"></i>` : '';
}

function renderShortDiff(field, lv, rv) {
    const ls = fmtVal(lv), rs = fmtVal(rv);
    return `
        <div class="vt-diff-item short">
            <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
            <div class="vt-diff-vals">
                <span class="vt-local" title="${esc(ls)}">${esc(truncate(ls, 60))}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="vt-remote" title="${esc(rs)}">${esc(truncate(rs, 60))}</span>
            </div>
        </div>`;
}

function renderLongDiff(field, lv, rv) {
    const ls = fmtVal(lv), rs = fmtVal(rv);
    const diff = lcs(ls.split('\n'), rs.split('\n'));
    let added = 0, removed = 0;
    diff.forEach(d => { if (d.t === 'a') added++; if (d.t === 'r') removed++; });
    const totalLines = diff.length;

    const stats = [];
    if (added) stats.push(`<span class="vt-stat added">+${added}</span>`);
    if (removed) stats.push(`<span class="vt-stat removed">-${removed}</span>`);

    const lines = diff.map(d => {
        const e = esc(d.l);
        if (d.t === 'a') return `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${e}</div>`;
        if (d.t === 'r') return `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${e}</div>`;
        return `<div class="vt-diff-line ctx"><span class="vt-prefix"> </span>${e}</div>`;
    }).join('');

    // Auto-expand small diffs (≤8 lines total)
    const autoExpand = totalLines <= 8 ? ' expanded' : '';

    return `
        <div class="vt-diff-item long${autoExpand}">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content">${lines || '<div class="vt-diff-line ctx">(empty)</div>'}</div>
        </div>`;
}

/**
 * Render tags diff as pill badges with added/removed highlighting.
 */
function renderTagsDiff(field, localTags, remoteTags) {
    const local = Array.isArray(localTags) ? localTags.map(t => String(t).trim()).filter(Boolean) : [];
    const remote = Array.isArray(remoteTags) ? remoteTags.map(t => String(t).trim()).filter(Boolean) : [];
    const localSet = new Set(local.map(t => t.toLowerCase()));
    const remoteSet = new Set(remote.map(t => t.toLowerCase()));

    const added = remote.filter(t => !localSet.has(t.toLowerCase()));
    const removed = local.filter(t => !remoteSet.has(t.toLowerCase()));
    const kept = local.filter(t => remoteSet.has(t.toLowerCase()));

    const stats = [];
    if (added.length) stats.push(`<span class="vt-stat added">+${added.length}</span>`);
    if (removed.length) stats.push(`<span class="vt-stat removed">-${removed.length}</span>`);

    const pills = [
        ...removed.map(t => `<span class="vt-tag-pill removed" title="Removed">${esc(t)}</span>`),
        ...added.map(t => `<span class="vt-tag-pill added" title="Added">${esc(t)}</span>`),
        ...kept.map(t => `<span class="vt-tag-pill">${esc(t)}</span>`),
    ].join('');

    return `
        <div class="vt-diff-item long expanded">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content vt-tag-content">
                <div class="vt-tag-pills">${pills || '<span class="vt-empty">(no tags)</span>'}</div>
            </div>
        </div>`;
}

/**
 * Render alternate greetings as numbered expandable blocks.
 */
function renderGreetingsDiff(field, localGreets, remoteGreets) {
    const local = Array.isArray(localGreets) ? localGreets : [];
    const remote = Array.isArray(remoteGreets) ? remoteGreets : [];
    const max = Math.max(local.length, remote.length);

    const stats = [];
    if (remote.length > local.length) stats.push(`<span class="vt-stat added">+${remote.length - local.length}</span>`);
    if (local.length > remote.length) stats.push(`<span class="vt-stat removed">-${local.length - remote.length}</span>`);

    let blocks = '';
    for (let i = 0; i < max; i++) {
        const lv = typeof local[i] === 'string' ? local[i] : '';
        const rv = typeof remote[i] === 'string' ? remote[i] : '';
        if (lv === rv) continue;

        const isNew = i >= local.length;
        const isRemoved = i >= remote.length;
        let badge = '';
        if (isNew) badge = '<span class="vt-greeting-badge added">new</span>';
        else if (isRemoved) badge = '<span class="vt-greeting-badge removed">removed</span>';
        else badge = '<span class="vt-greeting-badge changed">changed</span>';

        // Line diff for changed greetings
        let content;
        if (isNew) {
            content = `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${esc(rv)}</div>`;
        } else if (isRemoved) {
            content = `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${esc(lv)}</div>`;
        } else {
            const diff = lcs(lv.split('\n'), rv.split('\n'));
            content = diff.map(d => {
                const e = esc(d.l);
                if (d.t === 'a') return `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${e}</div>`;
                if (d.t === 'r') return `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${e}</div>`;
                return `<div class="vt-diff-line ctx"><span class="vt-prefix"> </span>${e}</div>`;
            }).join('');
        }

        blocks += `
            <div class="vt-greeting-block">
                <div class="vt-greeting-header">
                    <i class="fa-solid fa-chevron-right vt-greeting-expand-icon"></i>
                    #${i + 1} ${badge}
                </div>
                <div class="vt-greeting-body">${content}</div>
            </div>`;
    }

    if (!blocks) blocks = '<span class="vt-empty">(identical)</span>';

    return `
        <div class="vt-diff-item long">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content vt-greetings-content">${blocks}</div>
        </div>`;
}

// ========================================
// VERSION ACTIONS
// ========================================

async function restoreVersion() {
    if (!currentChar) return;

    let cardData = null;
    let label = '';

    if (activeTab === 'remote' && selectedVersionRef && currentProjectId) {
        const raw = await fetchVersionData(currentProjectId, selectedVersionRef);
        if (!raw) { CoreAPI.showToast('Could not fetch version data', 'error'); return; }
        cardData = normalizeChubDef(raw);
        label = `Chub version ${selectedVersionRef}`;
    } else if (activeTab === 'local' && selectedSnapshotId) {
        const lookupUid = getVersionUid(currentChar) || await lookupUidByAvatar(currentChar.avatar);
        const snap = lookupUid ? await storageGetSnapshot(lookupUid, selectedSnapshotId) : null;
        if (!snap) { CoreAPI.showToast('Snapshot not found', 'error'); return; }
        cardData = snap.data;
        label = `snapshot "${snap.label}"`;
    } else {
        CoreAPI.showToast('Nothing selected', 'warning');
        return;
    }

    const name = currentChar.data?.name || currentChar.name || 'Unknown';
    const ok = await confirmDialog('Restore Version',
        `Overwrite "${name}" with ${label}?\n\nCurrent state will be backed up.`);
    if (!ok) return;

    const status = el('.vt-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Restoring...';

    try {
        const curData = extractCardData(currentChar);
        const uid = await ensureVersionUid(currentChar);
        await storageSaveBackup(currentChar.avatar, uid, curData);

        // Auto-snapshot before restore
        const ts = new Date().toLocaleString();
        await storageSaveSnapshot(currentChar.avatar, name,
            `Restore - ${ts}`, 'auto_backup', curData, uid);

        const updates = {};
        for (const f of CARD_FIELDS) {
            if (cardData[f] !== undefined) updates[f] = cardData[f];
        }

        const success = await CoreAPI.applyCardFieldUpdates(currentChar.avatar, updates);

        if (success) {
            if (activeTab === 'remote' && selectedVersionRef) {
                await storageSaveSnapshot(currentChar.avatar, name,
                    `Chub v${selectedVersionRef} (restored)`, 'chub_restore', cardData, uid);
                await CoreAPI.applyCardFieldUpdates(currentChar.avatar, {
                    'extensions.chub.restored_version': selectedVersionRef,
                    'extensions.chub.restored_at': new Date().toISOString()
                });
            }
            CoreAPI.showToast(`Restored ${label}`, 'success');
            status.innerHTML = '<i class="fa-solid fa-check" style="color:var(--cl-success);"></i> Restored';
            await CoreAPI.refreshCharacters(true);
        } else {
            CoreAPI.showToast('Restore failed', 'error');
            status.innerHTML = '<i class="fa-solid fa-xmark"></i> Restore failed';
        }
    } catch (e) {
        console.error('[CharVersions] restore:', e);
        CoreAPI.showToast('Error: ' + e.message, 'error');
        status.innerHTML = '<i class="fa-solid fa-xmark"></i> Restore failed';
    }
}

async function undoRestore() {
    if (!currentChar) return;
    const uid = getVersionUid(currentChar) || await lookupUidByAvatar(currentChar.avatar);
    const backup = uid ? await storageGetBackup(uid) : null;
    if (!backup) { CoreAPI.showToast('No backup found', 'warning'); return; }

    const name = currentChar.data?.name || currentChar.name || 'Unknown';
    const ok = await confirmDialog('Undo Restore',
        `Revert "${name}" to pre-restore state?\n\nBackup from: ${new Date(backup.timestamp).toLocaleString()}`);
    if (!ok) return;

    const status = el('.vt-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Undoing...';

    try {
        const s = await CoreAPI.applyCardFieldUpdates(currentChar.avatar, backup.data);
        if (s) {
            await storageClearBackup(uid);
            await CoreAPI.applyCardFieldUpdates(currentChar.avatar, {
                'extensions.chub.restored_version': null,
                'extensions.chub.restored_at': null
            });
            CoreAPI.showToast('Backup restored', 'success');
            status.innerHTML = '<i class="fa-solid fa-check" style="color:var(--cl-success);"></i> Restored';
            await CoreAPI.refreshCharacters(true);
        } else {
            CoreAPI.showToast('Undo failed', 'error');
            status.innerHTML = '<i class="fa-solid fa-xmark"></i> Failed';
        }
    } catch (e) {
        console.error('[CharVersions] undo:', e);
        CoreAPI.showToast('Error undoing restore', 'error');
    }
}

/**
 * Apply an avatar image from a URL to the current character.
 * Fetches the image, uploads via /api/characters/edit-avatar FormData endpoint.
 */
async function handleApplyAvatar(avatarUrl) {
    if (!currentChar || !avatarUrl) return;

    const name = currentChar.data?.name || currentChar.name || 'Unknown';
    const ok = await confirmDialog('Apply Avatar',
        `Replace "${name}"'s avatar with this version's image?`);
    if (!ok) return;

    const status = el('.vt-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Applying avatar...';

    try {
        // Fetch image
        const imgResp = await fetch(avatarUrl);
        if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.status}`);
        const blob = await imgResp.blob();

        // Build multipart form
        const formData = new FormData();
        formData.append('avatar', new File([blob], 'avatar.png', { type: blob.type || 'image/png' }));
        formData.append('avatar_url', currentChar.avatar);

        const csrfToken = CoreAPI.getCSRFToken();
        const resp = await fetch('/api/characters/edit-avatar', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData
        });

        if (resp.ok) {
            CoreAPI.showToast('Avatar updated', 'success');
            status.innerHTML = '<i class="fa-solid fa-check" style="color:var(--cl-success);"></i> Avatar applied';
            await CoreAPI.refreshCharacters(true);
        } else {
            throw new Error(`Server returned ${resp.status}`);
        }
    } catch (e) {
        console.error('[CharVersions] apply avatar:', e);
        CoreAPI.showToast('Error applying avatar: ' + e.message, 'error');
        status.innerHTML = '<i class="fa-solid fa-xmark"></i> Avatar update failed';
    }
}

async function handleSaveSnapshot() {
    if (!currentChar) return;
    const label = await inputDialog('Save Snapshot', 'Label for this snapshot:',
        `Snapshot ${new Date().toLocaleString()}`);
    if (label === null) return;

    try {
        const uid = await ensureVersionUid(currentChar);
        const data = extractCardData(currentChar);
        const name = currentChar.data?.name || currentChar.name || 'Unknown';
        await storageSaveSnapshot(currentChar.avatar, name, label, 'local', data, uid);
        CoreAPI.showToast(`Snapshot saved: "${label}"`, 'success');
        if (activeTab === 'local') await loadLocalSnapshots();
    } catch (e) {
        console.error('[CharVersions] save snapshot:', e);
        CoreAPI.showToast('Error saving snapshot', 'error');
    }
}

async function handleDeleteSnapshot() {
    if (!selectedSnapshotId) return;
    const s = currentLocalSnapshots.find(s => s.id === selectedSnapshotId);
    if (!s) return;

    const ok = await confirmDialog('Delete Snapshot', `Delete "${s.label}"?\n\nThis cannot be undone.`);
    if (!ok) return;

    try {
        const delUid = getVersionUid(currentChar) || await lookupUidByAvatar(currentChar.avatar);
        if (delUid) await storageDeleteSnapshot(delUid, selectedSnapshotId);
        CoreAPI.showToast('Snapshot deleted', 'success');
        selectedSnapshotId = null;
        const preview = el('.vt-preview');
        if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
        el('.vt-actions')?.classList.add('vt-hidden');
        await loadLocalSnapshots();
    } catch (e) {
        CoreAPI.showToast('Error deleting snapshot', 'error');
    }
}

async function handleRenameSnapshot() {
    if (!selectedSnapshotId) return;
    const s = currentLocalSnapshots.find(s => s.id === selectedSnapshotId);
    if (!s) return;

    const newLabel = await inputDialog('Rename Snapshot', 'New label:', s.label);
    if (newLabel === null || newLabel === s.label) return;

    try {
        const renameUid = getVersionUid(currentChar) || await lookupUidByAvatar(currentChar.avatar);
        if (renameUid) await storageRenameSnapshot(renameUid, selectedSnapshotId, newLabel);
        CoreAPI.showToast('Snapshot renamed', 'success');
        await loadLocalSnapshots();
    } catch (e) {
        CoreAPI.showToast('Error renaming', 'error');
    }
}

// ========================================
// NORMALIZATION & HELPERS
// ========================================

function normalizeChubDef(def) {
    if (!def) return {};
    if (def.spec === 'chara_card_v2' && def.data) {
        const out = { ...def.data };
        // Preserve avatar URL from ChubAI if present
        if (def.data.avatar) out._avatarUrl = def.data.avatar;
        return out;
    }
    if (def.data && (def.data.description !== undefined || def.data.first_mes !== undefined)) {
        const out = { ...def.data };
        if (def.data.avatar) out._avatarUrl = def.data.avatar;
        return out;
    }
    return {
        name: def.name || '',
        description: def.personality || '',
        personality: def.tavern_personality || '',
        scenario: def.scenario || '',
        first_mes: def.first_message || '',
        mes_example: def.example_dialogs || '',
        system_prompt: def.system_prompt || '',
        post_history_instructions: def.post_history_instructions || '',
        creator_notes: def.description || '',
        creator: def.creator || '',
        character_version: def.character_version || '',
        tags: def.tags || def.topics || [],
        alternate_greetings: def.alternate_greetings || [],
        character_book: def.embedded_lorebook || def.character_book || undefined,
        extensions: def.extensions || {},
    };
}

function nested(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }

// ========================================
// LOREBOOK DIFF
// ========================================

function renderLorebookDiff(field, localBook, remoteBook) {
    const localEntries = localBook?.entries || [];
    const remoteEntries = remoteBook?.entries || [];
    const { matched, added, removed } = matchLbEntries(localEntries, remoteEntries);
    const modified = matched.filter(m => m.changedFields.length > 0);
    const metaDiffs = compareLbMeta(localBook, remoteBook);

    const statParts = [];
    if (added.length > 0) statParts.push(`<span class="vt-stat added">+${added.length}</span>`);
    if (removed.length > 0) statParts.push(`<span class="vt-stat removed">-${removed.length}</span>`);
    if (modified.length > 0) statParts.push(`<span class="vt-stat changed">${modified.length} modified</span>`);
    if (metaDiffs.length > 0) statParts.push(`<span class="vt-stat changed">${metaDiffs.length} setting${metaDiffs.length > 1 ? 's' : ''}</span>`);
    const stats = statParts.length > 0 ? statParts.join(' ') : 'identical';

    let entriesHtml = '';

    if (metaDiffs.length > 0) {
        entriesHtml += `<div class="vt-lb-meta-section">
            <div class="vt-lb-meta-title">Lorebook Settings</div>
            ${metaDiffs.map(m => `<div class="vt-lb-meta-row">
                <span class="vt-lb-meta-key">${esc(m.label)}</span>
                <span class="vt-lb-meta-old">${esc(m.localStr)}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="vt-lb-meta-new">${esc(m.remoteStr)}</span>
            </div>`).join('')}
        </div>`;
    }

    for (const entry of added) {
        const name = lbEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        entriesHtml += `<div class="vt-lb-entry added">
            <span class="vt-lb-badge added">+</span>
            <span class="vt-lb-name">${esc(name)}</span>
            ${keys ? `<span class="vt-lb-keys">${esc(keys)}</span>` : ''}
        </div>`;
    }

    for (const entry of removed) {
        const name = lbEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        entriesHtml += `<div class="vt-lb-entry removed">
            <span class="vt-lb-badge removed">&minus;</span>
            <span class="vt-lb-name">${esc(name)}</span>
            ${keys ? `<span class="vt-lb-keys">${esc(keys)}</span>` : ''}
        </div>`;
    }

    for (const m of modified) {
        const name = lbEntryName(m.remote);
        const changes = m.changedFields.join(', ');
        entriesHtml += `<div class="vt-lb-entry modified">
            <span class="vt-lb-badge modified">~</span>
            <span class="vt-lb-name">${esc(name)}</span>
            <span class="vt-lb-changes">${esc(changes)}</span>
        </div>`;
    }

    const unchangedCount = matched.length - modified.length;
    if (unchangedCount > 0) {
        entriesHtml += `<div class="vt-lb-entry unchanged">
            <span class="vt-lb-unchanged">${unchangedCount} unchanged entr${unchangedCount === 1 ? 'y' : 'ies'}</span>
        </div>`;
    }

    return `
        <div class="vt-diff-item long expanded">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}
                    <span class="vt-lb-counts">
                        <span>${localEntries.length}</span>
                        <i class="fa-solid fa-arrow-right"></i>
                        <span>${remoteEntries.length}</span>
                    </span>
                </span>
                <div class="vt-diff-stats">${stats}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content vt-lb-content">
                ${entriesHtml}
            </div>
        </div>
    `;
}

function lbEntryName(entry) {
    if (entry.comment?.trim()) return entry.comment.trim();
    if (entry.name?.trim()) return entry.name.trim();
    const keys = entry.keys || [];
    if (keys.length > 0) return keys.slice(0, 3).join(', ');
    return `Entry #${entry.id ?? '?'}`;
}

function matchLbEntries(localEntries, remoteEntries) {
    const matched = [];
    const unmatchedRemote = [...remoteEntries];
    const unmatchedLocal = [...localEntries];

    for (let i = unmatchedLocal.length - 1; i >= 0; i--) {
        let bestIdx = -1;
        let bestScore = 0;

        for (let j = 0; j < unmatchedRemote.length; j++) {
            const score = lbMatchScore(unmatchedLocal[i], unmatchedRemote[j]);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = j;
            }
        }

        if (bestIdx >= 0 && bestScore > 0.3) {
            const changedFields = compareLbFields(unmatchedLocal[i], unmatchedRemote[bestIdx]);
            matched.push({
                local: unmatchedLocal[i],
                remote: unmatchedRemote[bestIdx],
                changedFields
            });
            unmatchedLocal.splice(i, 1);
            unmatchedRemote.splice(bestIdx, 1);
        }
    }

    return { matched, added: unmatchedRemote, removed: unmatchedLocal };
}

function lbMatchScore(a, b) {
    const aKeys = new Set((a.keys || []).map(k => k.toLowerCase()));
    const bKeys = new Set((b.keys || []).map(k => k.toLowerCase()));

    if (aKeys.size > 0 && bKeys.size > 0) {
        let intersection = 0;
        for (const k of aKeys) { if (bKeys.has(k)) intersection++; }
        const union = new Set([...aKeys, ...bKeys]).size;
        if (union > 0) return intersection / union;
    }

    const aName = (a.comment || a.name || '').toLowerCase().trim();
    const bName = (b.comment || b.name || '').toLowerCase().trim();
    if (aName && bName && aName === bName) return 1;

    return 0;
}

function compareLbFields(local, remote) {
    const changed = [];
    for (const f of LB_ENTRY_FIELDS) {
        if (f === 'id' || f === 'name' || f === 'comment') continue;
        if (JSON.stringify(local[f] ?? null) !== JSON.stringify(remote[f] ?? null)) {
            changed.push(f);
        }
    }
    return changed;
}

const LB_META_FIELDS = {
    name: 'Name',
    description: 'Description',
    scan_depth: 'Scan Depth',
    token_budget: 'Token Budget',
    recursive_scanning: 'Recursive Scanning',
};

// V2-spec entry fields — everything else (uid, display_index, vectorized, etc.) is ST-internal
const LB_ENTRY_FIELDS = [
    'keys', 'secondary_keys', 'content', 'enabled', 'selective',
    'constant', 'position', 'insertion_order', 'priority', 'case_sensitive',
    'name', 'comment', 'id'
];

function normalizeLbEntry(entry) {
    const out = {};
    for (const f of LB_ENTRY_FIELDS) {
        if (entry[f] !== undefined) out[f] = entry[f];
    }
    return out;
}

function lorebooksEqual(a, b) {
    const aEntries = a?.entries || [];
    const bEntries = b?.entries || [];
    const aEmpty = aEntries.length === 0;
    const bEmpty = bEntries.length === 0;
    if (aEmpty && bEmpty) return true;

    for (const key of Object.keys(LB_META_FIELDS)) {
        if (JSON.stringify(a?.[key] ?? null) !== JSON.stringify(b?.[key] ?? null)) return false;
    }

    if (aEntries.length !== bEntries.length) return false;
    for (let i = 0; i < aEntries.length; i++) {
        const na = normalizeLbEntry(aEntries[i]);
        const nb = normalizeLbEntry(bEntries[i]);
        if (JSON.stringify(na) !== JSON.stringify(nb)) return false;
    }
    return true;
}

function compareLbMeta(localBook, remoteBook) {
    const diffs = [];
    for (const [key, label] of Object.entries(LB_META_FIELDS)) {
        const lv = localBook?.[key];
        const rv = remoteBook?.[key];
        if (JSON.stringify(lv ?? null) !== JSON.stringify(rv ?? null)) {
            diffs.push({
                key,
                label,
                localStr: lv == null ? '(not set)' : typeof lv === 'object' ? JSON.stringify(lv) : String(lv),
                remoteStr: rv == null ? '(not set)' : typeof rv === 'object' ? JSON.stringify(rv) : String(rv)
            });
        }
    }
    return diffs;
}

function normVal(v) {
    if (v == null) return '';
    if (Array.isArray(v)) {
        const n = [...v].map(x => typeof x === 'string' ? x.replace(/\r\n/g, '\n').trim() : JSON.stringify(x));
        n.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return JSON.stringify(n);
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).replace(/\r\n/g, '\n').trim();
}

function fmtVal(v) {
    if (v == null) return '(empty)';
    if (Array.isArray(v)) return v.length ? v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ') : '(empty)';
    if (typeof v === 'string' && !v.trim()) return '(empty)';
    if (typeof v === 'object') return JSON.stringify(v, null, 2);
    return String(v);
}

function truncate(s, m) { if (!s) return ''; return s.length <= m ? s : s.slice(0, m - 3) + '...'; }

function esc(s) { return CoreAPI.escapeHtml(s); }

function relTime(d) {
    const ms = Date.now() - d;
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(ms / 3600000);
    if (h < 24) return `${h}h ago`;
    const dy = Math.floor(ms / 86400000);
    if (dy < 30) return `${dy}d ago`;
    const mo = Math.floor(dy / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(dy / 365)}y ago`;
}

/** LCS-based line diff */
function lcs(oldL, newL) {
    const m = oldL.length, n = newL.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = oldL[i - 1] === newL[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

    const res = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldL[i - 1] === newL[j - 1]) {
            res.unshift({ t: 'c', l: oldL[i - 1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            res.unshift({ t: 'a', l: newL[j - 1] }); j--;
        } else {
            res.unshift({ t: 'r', l: oldL[i - 1] }); i--;
        }
    }
    return res;
}

// ========================================
// DIALOGS
// ========================================

function confirmDialog(title, msg) {
    return new Promise(resolve => {
        _dialogOpen = true;
        const ov = document.createElement('div');
        ov.className = 'vt-dialog-overlay';
        ov.innerHTML = `
            <div class="vt-dialog">
                <div class="vt-dialog-title">${esc(title)}</div>
                <div class="vt-dialog-msg">${esc(msg).replace(/\n/g, '<br>')}</div>
                <div class="vt-dialog-btns">
                    <button class="vt-dialog-btn" data-a="cancel">Cancel</button>
                    <button class="vt-dialog-btn primary" data-a="ok">Confirm</button>
                </div>
            </div>`;
        const close = (val) => {
            if (!ov.parentNode) return; // already removed
            ov.remove();
            requestAnimationFrame(() => { _dialogOpen = false; resolve(val); });
        };
        ov.addEventListener('click', e => { e.stopPropagation(); if (e.target === ov) close(false); });
        ov.querySelector('[data-a="cancel"]').addEventListener('click', (e) => { e.stopPropagation(); close(false); });
        ov.querySelector('[data-a="ok"]').addEventListener('click', (e) => { e.stopPropagation(); close(true); });
        document.body.appendChild(ov);
    });
}

function inputDialog(title, msg, defaultVal = '') {
    return new Promise(resolve => {
        _dialogOpen = true;
        const ov = document.createElement('div');
        ov.className = 'vt-dialog-overlay';
        ov.innerHTML = `
            <div class="vt-dialog">
                <div class="vt-dialog-title">${esc(title)}</div>
                <div class="vt-dialog-msg">${esc(msg)}</div>
                <input type="text" class="vt-input" value="${esc(defaultVal)}" />
                <div class="vt-dialog-btns">
                    <button class="vt-dialog-btn" data-a="cancel">Cancel</button>
                    <button class="vt-dialog-btn primary" data-a="ok">OK</button>
                </div>
            </div>`;
        const inp = ov.querySelector('.vt-input');
        const close = (val) => {
            if (!ov.parentNode) return;
            ov.remove();
            requestAnimationFrame(() => { _dialogOpen = false; resolve(val); });
        };
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') close(inp.value.trim());
            if (e.key === 'Escape') close(null);
        });
        ov.querySelector('[data-a="cancel"]').addEventListener('click', (e) => { e.stopPropagation(); close(null); });
        ov.querySelector('[data-a="ok"]').addEventListener('click', (e) => { e.stopPropagation(); close(inp.value.trim()); });
        ov.addEventListener('click', e => { if (e.target === ov) close(null); });
        document.body.appendChild(ov);
        setTimeout(() => inp.select(), 50);
    });
}

// ========================================
// STYLES
// ========================================

function injectStyles() {
    if (document.getElementById('cl-char-versions-styles')) return;
    const s = document.createElement('style');
    s.id = 'cl-char-versions-styles';
    s.textContent = `
/* ===== Versions Tab Pane ===== */
.vt-container {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
}

.vt-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
}

.vt-sub-tabs {
    display: flex;
    gap: 4px;
}

.vt-sub-tab {
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    color: var(--cl-text-secondary, #aaa);
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
}
.vt-sub-tab:hover { background: rgba(255,255,255,0.06); color: var(--cl-text-primary, #eee); }
.vt-sub-tab.active { background: rgba(var(--cl-accent-rgb, 74,158,255),0.12); color: var(--cl-accent, #4a9eff); border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.3); }
.vt-sub-tab i { font-size: 0.78rem; }

.vt-toolbar-right {
    display: flex;
    gap: 6px;
    align-items: center;
}

.vt-btn {
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    color: var(--cl-text-secondary, #aaa);
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
}
.vt-btn:hover { background: rgba(255,255,255,0.08); color: var(--cl-text-primary, #eee); }
.vt-btn.vt-delete { color: #f48771; }
.vt-btn.vt-delete:hover { background: rgba(244, 135, 113, 0.15); }
.vt-btn.primary { background: rgba(var(--cl-accent-rgb, 74,158,255),0.15); color: var(--cl-accent, #4a9eff); border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.3); }
.vt-btn.primary:hover { background: rgba(var(--cl-accent-rgb, 74,158,255),0.25); }

.vt-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    font-size: 0.85rem;
    color: var(--cl-text-secondary, #aaa);
    flex-shrink: 0;
}
.vt-status i { color: var(--cl-accent, #4a9eff); }

.vt-body {
    display: flex;
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}

.vt-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    min-width: 200px;
    max-width: 260px;
    flex-shrink: 0;
    padding: 6px;
    border-radius: 8px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
}
.vt-list::-webkit-scrollbar { width: 5px; }
.vt-list::-webkit-scrollbar-track { background: transparent; }
.vt-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.vt-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

.vt-item {
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.vt-item:hover { background: rgba(var(--cl-accent-rgb, 74,158,255),0.08); border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.25); }
.vt-item.selected { background: rgba(var(--cl-accent-rgb, 74,158,255),0.12); border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.4); box-shadow: 0 0 10px rgba(var(--cl-accent-rgb, 74,158,255),0.08); }

.vt-item-header { display: flex; align-items: center; gap: 6px; }
.vt-item-id { font-family: 'Cascadia Code','Fira Code',monospace; font-size: 0.82rem; color: var(--cl-accent, #4a9eff); font-weight: 600; }
.vt-item-icon { font-size: 0.8rem; color: var(--cl-accent, #4a9eff); }
.vt-item-label { font-size: 0.82rem; color: var(--cl-text-primary, #eee); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vt-item-title { font-size: 0.78rem; color: var(--cl-text-secondary, #aaa); opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vt-item-date { display: flex; align-items: center; gap: 4px; font-size: 0.72rem; color: var(--cl-text-secondary, #aaa); opacity: 0.6; }

.vt-badge { font-size: 0.65rem; padding: 1px 5px; border-radius: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.vt-badge.latest { background: rgba(var(--cl-accent-rgb, 74,158,255),0.15); color: var(--cl-accent, #4a9eff); border: 1px solid rgba(var(--cl-accent-rgb, 74,158,255),0.3); }

.vt-preview {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    border-radius: 8px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
    min-height: 0;
}
.vt-hidden { display: none !important; }
.vt-back-btn { display: none; }

.vt-preview::-webkit-scrollbar { width: 5px; }
.vt-preview::-webkit-scrollbar-track { background: transparent; }
.vt-preview::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.vt-preview::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

.vt-preview-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 10px; border-radius: 6px; background: rgba(255,255,255,0.04); font-size: 0.85rem; color: var(--cl-text-secondary, #aaa); }

.vt-loading, .vt-error { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 30px 16px; color: var(--cl-text-secondary, #aaa); font-size: 0.85rem; }

.vt-avatar-preview {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    margin-bottom: 8px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
}
.vt-avatar-thumb { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1); }
.vt-apply-avatar {
    margin-left: auto;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: rgba(var(--cl-accent-rgb, 74,158,255),0.1);
    border: 1px solid rgba(var(--cl-accent-rgb, 74,158,255),0.25);
    color: var(--cl-accent, #4a9eff);
    cursor: pointer;
    transition: all 0.15s ease;
    font-size: 0.82rem;
    padding: 0;
    flex-shrink: 0;
}
.vt-apply-avatar:hover {
    background: rgba(var(--cl-accent-rgb, 74,158,255),0.2);
    border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.5);
    box-shadow: 0 0 8px rgba(var(--cl-accent-rgb, 74,158,255),0.15);
}

.vt-diff-list { display: flex; flex-direction: column; gap: 6px; }

.vt-diff-item { border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); overflow: hidden; }
.vt-diff-item.short { display: flex; align-items: center; gap: 10px; padding: 6px 10px; }
.vt-diff-item.long { padding: 0; }

.vt-diff-label { font-weight: 600; font-size: 0.82rem; color: var(--cl-text-primary, #eee); white-space: nowrap; min-width: 70px; display: inline-flex; align-items: center; gap: 6px; }
.vt-field-icon { font-size: 0.72rem; opacity: 0.5; width: 14px; text-align: center; flex-shrink: 0; }
.vt-diff-vals { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font-size: 0.82rem; }
.vt-diff-vals i { color: var(--cl-text-secondary, #aaa); opacity: 0.5; flex-shrink: 0; }
.vt-local { color: #f48771; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vt-remote { color: #89d185; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.vt-diff-header { display: flex; align-items: center; gap: 10px; padding: 6px 10px; cursor: pointer; user-select: none; transition: background 0.1s; }
.vt-diff-header:hover { background: rgba(255,255,255,0.04); }
.vt-diff-stats { display: flex; gap: 5px; margin-left: auto; }
.vt-stat { font-size: 0.72rem; font-family: monospace; padding: 1px 5px; border-radius: 4px; }
.vt-stat.added { color: #89d185; background: rgba(137,209,133,0.1); }
.vt-stat.removed { color: #f48771; background: rgba(244,135,113,0.1); }

.vt-expand-icon { transition: transform 0.2s; opacity: 0.5; font-size: 0.75rem; }
.vt-diff-item.expanded .vt-expand-icon { transform: rotate(180deg); }

.vt-diff-content { display: none; border-top: 1px solid rgba(255,255,255,0.06); max-height: 260px; overflow-y: auto; font-family: 'Cascadia Code','Fira Code',monospace; font-size: 0.78rem; line-height: 1.5; }
.vt-diff-item.expanded .vt-diff-content { display: block; }
.vt-diff-content::-webkit-scrollbar { width: 5px; }
.vt-diff-content::-webkit-scrollbar-track { background: transparent; }
.vt-diff-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.vt-diff-content::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

.vt-diff-line { padding: 1px 10px 1px 4px; white-space: pre-wrap; word-break: break-word; }
.vt-prefix { display: inline-block; width: 14px; text-align: center; opacity: 0.5; user-select: none; }
.vt-diff-line.added { background: rgba(137,209,133,0.08); color: #89d185; }
.vt-diff-line.removed { background: rgba(244,135,113,0.08); color: #f48771; }
.vt-diff-line.ctx { color: var(--cl-text-secondary, #aaa); opacity: 0.6; }

/* Tag pills */
.vt-tag-content { padding: 8px 10px; }
.vt-tag-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.vt-tag-pill {
    display: inline-flex; align-items: center;
    padding: 3px 10px; border-radius: 999px;
    font-size: 0.78rem; font-weight: 500;
    background: rgba(var(--cl-accent-rgb, 74,158,255),0.1);
    border: 1px solid rgba(var(--cl-accent-rgb, 74,158,255),0.3);
    color: var(--cl-accent, #4a9eff);
    transition: all 0.15s ease;
}
.vt-tag-pill.added {
    background: rgba(137,209,133,0.12); border-color: rgba(137,209,133,0.4);
    color: #89d185; animation: vtPillFadeIn 0.2s ease;
}
.vt-tag-pill.removed {
    background: rgba(244,135,113,0.12); border-color: rgba(244,135,113,0.4);
    color: #f48771; text-decoration: line-through; opacity: 0.8;
}
@keyframes vtPillFadeIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }

/* Alternate greetings */
.vt-greetings-content { padding: 6px; flex-direction: column; gap: 6px; }
.vt-diff-item.expanded .vt-greetings-content { display: flex; }
.vt-greeting-block { border-radius: 6px; overflow: hidden; border: 1px solid rgba(255,255,255,0.06); }
.vt-greeting-header {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 10px; font-size: 0.78rem; font-weight: 600;
    color: var(--cl-text-secondary, #aaa); background: rgba(255,255,255,0.03);
    cursor: pointer; user-select: none; transition: background 0.1s;
}
.vt-greeting-header:hover { background: rgba(255,255,255,0.06); }
.vt-greeting-expand-icon { font-size: 0.65rem; opacity: 0.5; transition: transform 0.2s; flex-shrink: 0; }
.vt-greeting-block.expanded .vt-greeting-expand-icon { transform: rotate(90deg); }
.vt-greeting-badge {
    font-size: 0.65rem; padding: 1px 6px; border-radius: 4px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
}
.vt-greeting-badge.added { background: rgba(137,209,133,0.15); color: #89d185; }
.vt-greeting-badge.removed { background: rgba(244,135,113,0.15); color: #f48771; }
.vt-greeting-badge.changed { background: rgba(var(--cl-accent-rgb, 74,158,255),0.15); color: var(--cl-accent, #4a9eff); }
.vt-greeting-body { display: none; max-height: 160px; overflow-y: auto; font-family: 'Cascadia Code','Fira Code',monospace; font-size: 0.78rem; line-height: 1.5; }
.vt-greeting-block.expanded .vt-greeting-body { display: block; }
.vt-greeting-body::-webkit-scrollbar { width: 4px; }
.vt-greeting-body::-webkit-scrollbar-track { background: transparent; }
.vt-greeting-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
.vt-greeting-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

/* Lorebook diff */
.vt-lb-content { flex-direction: column; gap: 4px; padding: 8px 10px; }
.vt-diff-item.expanded .vt-lb-content { display: flex; }
.vt-lb-entry {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px; border-radius: 5px; font-size: 0.82rem;
}
.vt-lb-entry.added { background: rgba(137,209,133,0.08); }
.vt-lb-entry.removed { background: rgba(244,135,113,0.08); }
.vt-lb-entry.modified { background: rgba(255,180,80,0.08); }
.vt-lb-entry.unchanged { padding: 3px 8px; }
.vt-lb-badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%;
    font-weight: bold; font-size: 12px; flex-shrink: 0; line-height: 1;
}
.vt-lb-badge.added { background: rgba(137,209,133,0.2); color: #89d185; }
.vt-lb-badge.removed { background: rgba(244,135,113,0.2); color: #f48771; }
.vt-lb-badge.modified { background: rgba(255,180,80,0.2); color: #ffb450; }
.vt-lb-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vt-lb-keys {
    font-size: 0.85em; color: var(--cl-text-secondary, #999);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex-shrink: 1; min-width: 0;
}
.vt-lb-keys::before { content: '\\2014\\00a0'; opacity: 0.4; }
.vt-lb-changes {
    font-size: 0.78em; color: var(--cl-text-secondary, #999);
    margin-left: auto; flex-shrink: 0; white-space: nowrap;
}
.vt-lb-unchanged { opacity: 0.5; font-style: italic; font-size: 0.82em; }
.vt-lb-counts {
    font-size: 0.85em; opacity: 0.6; margin-left: 6px;
    display: inline-flex; align-items: center; gap: 4px;
}
.vt-lb-counts i { font-size: 7px; opacity: 0.5; }
.vt-stat.changed { color: #ffb450; }

/* Lorebook metadata settings diff */
.vt-lb-meta-section { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.vt-lb-meta-title {
    font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--cl-text-secondary, #999); margin-bottom: 5px; font-weight: 600;
}
.vt-lb-meta-row {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 0; font-size: 0.82em;
}
.vt-lb-meta-key { font-weight: 500; min-width: 90px; flex-shrink: 0; }
.vt-lb-meta-old {
    color: #f48771; background: rgba(244,135,113,0.12);
    padding: 1px 5px; border-radius: 3px;
}
.vt-lb-meta-new {
    color: #89d185; background: rgba(137,209,133,0.12);
    padding: 1px 5px; border-radius: 3px;
}
.vt-lb-meta-row i { color: var(--cl-text-secondary, #aaa); font-size: 0.65em; opacity: 0.5; flex-shrink: 0; }

.vt-empty { color: var(--cl-text-secondary, #aaa); font-size: 0.8rem; padding: 4px 0; }

.vt-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    padding-top: 6px;
    border-top: 1px solid rgba(255,255,255,0.06);
}
.vt-actions-left, .vt-actions-right { display: flex; gap: 6px; }

/* Dialog overlay */
.vt-dialog-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    z-index: 20001;
    display: flex; align-items: center; justify-content: center;
    animation: vtFadeIn 0.15s ease;
}
@keyframes vtFadeIn { from { opacity: 0; } to { opacity: 1; } }
.vt-dialog { background: var(--cl-glass-bg, #1a1a2e); border: 1px solid var(--cl-border, rgba(255,255,255,0.1)); border-radius: 14px; padding: 22px; max-width: 400px; width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
.vt-dialog-title { font-size: 1.05rem; font-weight: 700; color: var(--cl-text-primary, #eee); margin-bottom: 10px; }
.vt-dialog-msg { font-size: 0.88rem; color: var(--cl-text-secondary, #aaa); line-height: 1.5; margin-bottom: 16px; }
.vt-dialog-btns { display: flex; justify-content: flex-end; gap: 8px; }
.vt-dialog-btn {
    padding: 6px 16px; border-radius: 8px; font-size: 0.85rem; font-weight: 500;
    cursor: pointer; border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.06); color: var(--cl-text-secondary, #aaa);
    transition: all 0.15s ease; font-family: inherit;
}
.vt-dialog-btn:hover { background: rgba(255,255,255,0.1); color: var(--cl-text-primary, #eee); }
.vt-dialog-btn.primary { background: rgba(var(--cl-accent-rgb, 74,158,255),0.15); color: var(--cl-accent, #4a9eff); border-color: rgba(var(--cl-accent-rgb, 74,158,255),0.3); }
.vt-dialog-btn.primary:hover { background: rgba(var(--cl-accent-rgb, 74,158,255),0.25); }
.vt-input {
    width: 100%; padding: 8px 12px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.06);
    color: var(--cl-text-primary, #eee);
    font-size: 0.88rem; font-family: inherit;
    margin: 10px 0; outline: none;
    transition: border-color 0.15s; box-sizing: border-box;
}
.vt-input:focus { border-color: var(--cl-accent, #4a9eff); box-shadow: 0 0 6px rgba(var(--cl-accent-rgb, 74,158,255),0.2); }

    `;
    document.head.appendChild(s);
}

// ========================================
// EXPORTS
// ========================================

export default {
    init,
    openVersionHistory,
    renderVersionsPane,
    cleanupVersionsPane,
    saveCurrentSnapshot,
    autoSnapshotBeforeChange
};
