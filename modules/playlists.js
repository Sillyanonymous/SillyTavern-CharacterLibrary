import CoreAPI from './core-api.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// ========================================
// PLAYLISTS MODULE
// ========================================

const PLAYLISTS_FILE = '_cl_playlists.json';
const STORAGE_VERSION = 1;

let playlistsData = null;   // { version, playlists: {}, order: [] }
let loaded = false;
let saving = false;
let saveQueued = false;

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
        throw new Error(`Playlist file upload failed (${resp.status}): ${err}`);
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
// STORAGE LAYER
// ========================================

function createEmptyData() {
    return { version: STORAGE_VERSION, playlists: {}, order: [] };
}

function generateUid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let uid = '';
    for (let i = 0; i < 12; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    return uid;
}

let _loadingPromise = null;

async function loadPlaylists() {
    if (loaded) return playlistsData;
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
        const data = await fileRead(PLAYLISTS_FILE);
        if (data && data.version && data.playlists) {
            playlistsData = data;
            const ids = Object.keys(data.playlists);
            const orderSet = new Set(data.order || []);
            for (const id of ids) {
                if (!orderSet.has(id)) {
                    playlistsData.order.push(id);
                }
            }
            playlistsData.order = playlistsData.order.filter(id => data.playlists[id]);
        } else {
            playlistsData = createEmptyData();
        }
        loaded = true;
        _loadingPromise = null;
        return playlistsData;
    })();
    return _loadingPromise;
}

async function savePlaylists() {
    if (!playlistsData) return;
    if (saving) {
        saveQueued = true;
        return;
    }
    saving = true;
    try {
        await fileUpload(PLAYLISTS_FILE, playlistsData);
    } catch (e) {
        console.error('[Playlists] Save failed:', e.message);
        CoreAPI.showToast('Failed to save playlists', 'error');
    } finally {
        saving = false;
        if (saveQueued) {
            saveQueued = false;
            savePlaylists();
        }
    }
}

// ========================================
// CRUD OPERATIONS
// ========================================

async function createPlaylist(name, description = '') {
    await loadPlaylists();
    const uid = generateUid();
    playlistsData.playlists[uid] = {
        name: name.trim(),
        description: description.trim(),
        icon: '',
        color: '',
        created: Date.now(),
        modified: Date.now(),
        characters: [],
    };
    playlistsData.order.push(uid);
    await savePlaylists();
    return uid;
}

async function deletePlaylist(uid) {
    await loadPlaylists();
    if (!playlistsData.playlists[uid]) return false;
    delete playlistsData.playlists[uid];
    playlistsData.order = playlistsData.order.filter(id => id !== uid);
    await savePlaylists();
    return true;
}

async function updatePlaylist(uid, updates) {
    await loadPlaylists();
    const pl = playlistsData.playlists[uid];
    if (!pl) return false;
    if (updates.name !== undefined) pl.name = updates.name.trim();
    if (updates.description !== undefined) pl.description = updates.description.trim();
    if (updates.icon !== undefined) pl.icon = updates.icon;
    if (updates.color !== undefined) pl.color = updates.color;
    pl.modified = Date.now();
    await savePlaylists();
    return true;
}

async function addToPlaylist(uid, avatars) {
    await loadPlaylists();
    const pl = playlistsData.playlists[uid];
    if (!pl) return false;
    const existing = new Set(pl.characters);
    let added = 0;
    for (const avatar of avatars) {
        if (!existing.has(avatar)) {
            pl.characters.push(avatar);
            existing.add(avatar);
            added++;
        }
    }
    if (added > 0) {
        pl.modified = Date.now();
        await savePlaylists();
    }
    return added;
}

async function removeFromPlaylist(uid, avatars) {
    await loadPlaylists();
    const pl = playlistsData.playlists[uid];
    if (!pl) return false;
    const removeSet = new Set(avatars);
    const before = pl.characters.length;
    pl.characters = pl.characters.filter(a => !removeSet.has(a));
    if (pl.characters.length !== before) {
        pl.modified = Date.now();
        await savePlaylists();
    }
    return before - pl.characters.length;
}

async function reorderPlaylists(orderedIds) {
    await loadPlaylists();
    const valid = orderedIds.filter(id => playlistsData.playlists[id]);
    // Append any IDs not in the provided order
    const seen = new Set(valid);
    for (const id of playlistsData.order) {
        if (!seen.has(id) && playlistsData.playlists[id]) {
            valid.push(id);
        }
    }
    playlistsData.order = valid;
    await savePlaylists();
}

// ========================================
// QUERY FUNCTIONS
// ========================================

function playlistNameExists(name, excludeUid = null) {
    if (!playlistsData) return false;
    const lower = name.trim().toLowerCase();
    return Object.entries(playlistsData.playlists).some(
        ([uid, pl]) => uid !== excludeUid && pl.name.trim().toLowerCase() === lower,
    );
}

function getAllPlaylists() {
    if (!playlistsData) return [];
    return playlistsData.order
        .filter(id => playlistsData.playlists[id])
        .map(id => ({ uid: id, ...playlistsData.playlists[id] }));
}

function getPlaylist(uid) {
    if (!playlistsData?.playlists[uid]) return null;
    return { uid, ...playlistsData.playlists[uid] };
}

function getPlaylistCharacters(uid) {
    if (!playlistsData?.playlists[uid]) return [];
    const avatars = playlistsData.playlists[uid].characters;
    const all = CoreAPI.getAllCharacters() || [];
    const byAvatar = new Map(all.map(c => [c.avatar, c]));
    return avatars.map(a => byAvatar.get(a)).filter(Boolean);
}

function getPlaylistAvatarSet(uid) {
    if (!playlistsData?.playlists[uid]) return new Set();
    return new Set(playlistsData.playlists[uid].characters);
}

function getPlaylistsForChar(avatar) {
    if (!playlistsData) return [];
    return playlistsData.order
        .filter(id => {
            const pl = playlistsData.playlists[id];
            return pl && pl.characters.includes(avatar);
        })
        .map(id => ({ uid: id, ...playlistsData.playlists[id] }));
}

function isCharInPlaylist(uid, avatar) {
    return !!playlistsData?.playlists[uid]?.characters.includes(avatar);
}

function isCharInAnyPlaylist(avatar) {
    if (!playlistsData) return false;
    for (const id of playlistsData.order) {
        const pl = playlistsData.playlists[id];
        if (pl && pl.characters.includes(avatar)) return true;
    }
    return false;
}

// ========================================
// CHARACTER DELETION HOOK
// ========================================

async function onCharacterDeleted(avatar) {
    if (!playlistsData) return;
    let changed = false;
    for (const pl of Object.values(playlistsData.playlists)) {
        const idx = pl.characters.indexOf(avatar);
        if (idx !== -1) {
            pl.characters.splice(idx, 1);
            changed = true;
        }
    }
    if (changed) await savePlaylists();
}

// ========================================
// PLAYLIST PICKER MODAL
// ========================================

let pickerInjected = false;
let pickerAvatars = [];



function injectPickerModal() {
    if (pickerInjected) return;
    pickerInjected = true;

    const html = `
    <div id="playlistPickerModal" class="cl-modal">
        <div class="cl-modal-content" style="max-width: calc(420px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-ul"></i> Add to Playlist</h3>
                <span id="playlistPickerCount" class="pl-picker-count"></span>
                <button id="playlistPickerCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body" style="padding: 0;">
                <div class="pl-picker-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pl-picker-search-icon"></i>
                    <input type="search" id="playlistPickerSearch" class="cl-input pl-picker-search" placeholder="Search or create..." maxlength="100" autocomplete="one-time-code">
                </div>
                <div id="playlistPickerList" class="pl-picker-list"></div>
                <div id="playlistPickerEmpty" class="pl-picker-empty">No playlists yet. Type a name above to create one.</div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('playlistPickerCloseBtn').addEventListener('click', closePlaylistPicker);
    document.getElementById('playlistPickerModal').addEventListener('click', (e) => {
        if (e.target.id === 'playlistPickerModal') closePlaylistPicker();
    });
    document.getElementById('playlistPickerList').addEventListener('click', handlePickerRowClick);
    document.getElementById('playlistPickerSearch').addEventListener('input', filterPickerList);
    document.getElementById('playlistPickerSearch').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const createRow = document.querySelector('#playlistPickerList .pl-create-row');
            if (createRow && createRow.style.display !== 'none') handlePickerCreate();
        }
    });

    window.registerOverlay?.({ id: 'playlistPickerModal', tier: 7, close: () => closePlaylistPicker(), visible: (el) => el.classList.contains('visible') });
}

function filterPickerList() {
    const query = (document.getElementById('playlistPickerSearch')?.value || '').trim().toLowerCase();
    const rows = document.querySelectorAll('#playlistPickerList .pl-picker-row');
    let visible = 0;
    let exactMatch = false;
    rows.forEach(row => {
        const name = (row.querySelector('.pl-picker-name')?.textContent || '').toLowerCase();
        const show = !query || name.includes(query);
        row.style.display = show ? '' : 'none';
        if (show) visible++;
        if (query && name === query) exactMatch = true;
    });
    const emptyEl = document.getElementById('playlistPickerEmpty');
    const totalRows = rows.length;
    if (emptyEl) emptyEl.style.display = totalRows === 0 && !query ? '' : 'none';

    let createRow = document.querySelector('#playlistPickerList .pl-create-row');
    if (query && !exactMatch) {
        if (!createRow) {
            createRow = document.createElement('div');
            createRow.className = 'pl-create-row';
            createRow.addEventListener('click', handlePickerCreate);
            document.getElementById('playlistPickerList').appendChild(createRow);
        }
        createRow.innerHTML = `<i class="fa-solid fa-plus pl-create-row-icon"></i><span class="pl-create-row-text">Create <strong>${esc(document.getElementById('playlistPickerSearch').value.trim())}</strong></span>`;
        createRow.style.display = '';
    } else if (createRow) {
        createRow.style.display = 'none';
    }
}

async function openPlaylistPicker(avatars) {
    if (!avatars?.length) return;
    injectPickerModal();
    pickerAvatars = [...avatars];
    await loadPlaylists();

    const searchInput = document.getElementById('playlistPickerSearch');
    if (searchInput) searchInput.value = '';
    renderPickerList();

    const countEl = document.getElementById('playlistPickerCount');
    countEl.textContent = avatars.length === 1 ? '1 character' : `${avatars.length} characters`;

    document.getElementById('playlistPickerModal').classList.add('visible');
}

function closePlaylistPicker() {
    document.getElementById('playlistPickerModal')?.classList.remove('visible');
    pickerAvatars = [];
}

function renderPickerList() {
    const listEl = document.getElementById('playlistPickerList');
    const emptyEl = document.getElementById('playlistPickerEmpty');
    const playlists = getAllPlaylists();

    if (!playlists.length) {
        listEl.innerHTML = '';
        emptyEl.style.display = '';
        filterPickerList();
        return;
    }
    emptyEl.style.display = 'none';

    const targetSet = new Set(pickerAvatars);
    listEl.innerHTML = playlists.map(pl => {
        const inCount = pl.characters.filter(a => targetSet.has(a)).length;
        const total = pickerAvatars.length;
        let iconCls, rowCls;
        if (inCount === total) {
            iconCls = 'fa-solid fa-square-check';
            rowCls = 'checked';
        } else if (inCount > 0) {
            iconCls = 'fa-solid fa-square-minus';
            rowCls = 'partial';
        } else {
            iconCls = 'fa-regular fa-square';
            rowCls = '';
        }
        const iconColor = pl.color ? ` style="color:${esc(pl.color)}"` : '';
        const plIcon = pl.icon
            ? `<i class="pl-picker-icon ${esc(pl.icon)}"${iconColor}></i>`
            : '';
        return `<div class="pl-picker-row ${rowCls}" data-uid="${esc(pl.uid)}">
            <i class="pl-picker-check ${iconCls}"></i>
            ${plIcon}
            <span class="pl-picker-name">${esc(pl.name)}</span>
            <span class="pl-picker-badge">${pl.characters.length}</span>
        </div>`;
    }).join('');

    filterPickerList();
}

async function handlePickerRowClick(e) {
    const row = e.target.closest('.pl-picker-row');
    if (!row) return;
    const uid = row.dataset.uid;
    const pl = getPlaylist(uid);
    if (!pl) return;

    const targetSet = new Set(pickerAvatars);
    const inCount = pl.characters.filter(a => targetSet.has(a)).length;

    if (inCount === pickerAvatars.length) {
        await removeFromPlaylist(uid, pickerAvatars);
        CoreAPI.showToast(`Removed from "${pl.name}"`, 'info');
    } else {
        const added = await addToPlaylist(uid, pickerAvatars);
        if (added > 0) CoreAPI.showToast(`Added to "${pl.name}"`, 'success');
    }
    renderPickerList();
    CoreAPI.refreshPlaylistBadges();
}

async function handlePickerCreate() {
    const input = document.getElementById('playlistPickerSearch');
    const name = (input?.value || '').trim();
    if (!name) return;

    if (playlistNameExists(name)) {
        CoreAPI.showToast(`A playlist named "${name}" already exists`, 'warning');
        return;
    }

    const uid = await createPlaylist(name);
    if (pickerAvatars.length) {
        await addToPlaylist(uid, pickerAvatars);
    }
    input.value = '';
    renderPickerList();
    CoreAPI.refreshPlaylistBadges();
    CoreAPI.showToast(`Created "${name}"`, 'success');
}

// ========================================
// PLAYLIST MANAGEMENT MODAL
// ========================================

const PRESET_COLORS = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

const PRESET_ICONS = [
    '', 'fa-solid fa-heart', 'fa-solid fa-star', 'fa-solid fa-bolt', 'fa-solid fa-fire',
    'fa-solid fa-crown', 'fa-solid fa-gem', 'fa-solid fa-shield', 'fa-solid fa-wand-sparkles',
    'fa-solid fa-dragon', 'fa-solid fa-skull', 'fa-solid fa-ghost', 'fa-solid fa-hat-wizard',
    'fa-solid fa-book', 'fa-solid fa-scroll', 'fa-solid fa-music', 'fa-solid fa-palette',
    'fa-solid fa-moon', 'fa-solid fa-sun', 'fa-solid fa-snowflake', 'fa-solid fa-leaf',
    'fa-solid fa-cat', 'fa-solid fa-dog', 'fa-solid fa-dove', 'fa-solid fa-feather',
    'fa-solid fa-face-smile', 'fa-solid fa-robot', 'fa-solid fa-user-secret', 'fa-solid fa-masks-theater',
    'fa-solid fa-gamepad', 'fa-solid fa-dice-d20', 'fa-solid fa-chess-queen', 'fa-solid fa-puzzle-piece',
    'fa-solid fa-flask', 'fa-solid fa-atom', 'fa-solid fa-rocket', 'fa-solid fa-code',
    'fa-solid fa-seedling', 'fa-solid fa-clover', 'fa-solid fa-tree', 'fa-solid fa-mountain-sun',
    'fa-solid fa-water', 'fa-solid fa-hurricane', 'fa-solid fa-meteor', 'fa-solid fa-explosion',
    'fa-solid fa-wand-magic-sparkles', 'fa-solid fa-hand-sparkles', 'fa-solid fa-broom',
    'fa-solid fa-dungeon', 'fa-solid fa-khanda', 'fa-solid fa-hand-fist', 'fa-solid fa-gun',
    'fa-solid fa-skull-crossbones', 'fa-solid fa-biohazard', 'fa-solid fa-radiation',
    'fa-solid fa-person-running', 'fa-solid fa-person-dress', 'fa-solid fa-people-group',
    'fa-solid fa-children', 'fa-solid fa-baby', 'fa-solid fa-user-ninja', 'fa-solid fa-user-astronaut',
    'fa-solid fa-spider', 'fa-solid fa-crow', 'fa-solid fa-fish', 'fa-solid fa-otter',
    'fa-solid fa-hippo', 'fa-solid fa-frog', 'fa-solid fa-horse', 'fa-solid fa-paw-claws',
    'fa-solid fa-camera', 'fa-solid fa-pen-nib', 'fa-solid fa-paintbrush', 'fa-solid fa-scissors',
    'fa-solid fa-guitar', 'fa-solid fa-headphones', 'fa-solid fa-microphone',
    'fa-solid fa-tv', 'fa-solid fa-film', 'fa-solid fa-clapperboard',
    'fa-solid fa-graduation-cap', 'fa-solid fa-microscope', 'fa-solid fa-dna',
    'fa-solid fa-brain', 'fa-solid fa-eye', 'fa-solid fa-glasses',
    'fa-solid fa-mug-hot', 'fa-solid fa-wine-glass', 'fa-solid fa-martini-glass-citrus',
    'fa-solid fa-cookie-bite', 'fa-solid fa-candy-cane', 'fa-solid fa-ice-cream',
    'fa-solid fa-gift', 'fa-solid fa-cake-candles', 'fa-solid fa-champagne-glasses',
    'fa-solid fa-ring', 'fa-solid fa-hat-cowboy', 'fa-solid fa-vest-patches',
    'fa-solid fa-compass', 'fa-solid fa-map', 'fa-solid fa-anchor', 'fa-solid fa-sailboat',
    'fa-solid fa-plane', 'fa-solid fa-shuttle-space', 'fa-solid fa-satellite',
    'fa-solid fa-house-chimney', 'fa-solid fa-building', 'fa-solid fa-city',
    'fa-solid fa-landmark', 'fa-solid fa-church', 'fa-solid fa-torii-gate',
    'fa-solid fa-yin-yang', 'fa-solid fa-cross', 'fa-solid fa-om', 'fa-solid fa-peace',
    'fa-solid fa-rainbow', 'fa-solid fa-umbrella', 'fa-solid fa-cloud-bolt',
    'fa-solid fa-temperature-high', 'fa-solid fa-wind', 'fa-solid fa-volcano',
];

let manageInjected = false;
let activeIconPickerUid = null;
let iconPickerEl = null;

function injectManageModal() {
    if (manageInjected) return;
    manageInjected = true;

    const html = `
    <div id="playlistManageModal" class="cl-modal">
        <div class="cl-modal-content" style="max-width: calc(500px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-ul"></i> Manage Playlists</h3>
                <button id="playlistManageCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body" style="padding: 0;">
                <div class="pl-manage-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pl-manage-search-icon"></i>
                    <input type="search" id="playlistManageSearch" class="cl-input pl-manage-search" placeholder="Search or create..." maxlength="100" autocomplete="one-time-code">
                </div>
                <div id="playlistManageList" class="pl-manage-list"></div>
                <div id="playlistManageEmpty" class="pl-picker-empty">No playlists yet. Type a name above to create one.</div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('playlistManageCloseBtn').addEventListener('click', closePlaylistManager);
    document.getElementById('playlistManageModal').addEventListener('click', (e) => {
        if (e.target.id === 'playlistManageModal') closePlaylistManager();
    });
    document.getElementById('playlistManageSearch').addEventListener('input', filterManageList);
    document.getElementById('playlistManageSearch').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const createRow = document.querySelector('#playlistManageList .pl-create-row');
            if (createRow && createRow.style.display !== 'none') handleManageCreate();
        }
    });

    const list = document.getElementById('playlistManageList');

    list.addEventListener('click', (e) => {
        // Icon button
        const iconBtn = e.target.closest('.pl-manage-icon-btn');
        if (iconBtn) {
            e.stopPropagation();
            toggleIconPicker(iconBtn);
            return;
        }

        // Delete button
        const delBtn = e.target.closest('.pl-manage-delete');
        if (delBtn) {
            const row = delBtn.closest('.pl-manage-row');
            if (row) handleManageDelete(row.dataset.uid);
            return;
        }
    });

    // Name input blur = save rename
    list.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('pl-manage-name')) {
            const row = e.target.closest('.pl-manage-row');
            if (row) handleManageRename(row.dataset.uid, e.target.value);
        }
    });

    // Name input Enter = blur (triggers save)
    list.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('pl-manage-name')) {
            e.target.blur();
        }
    });

    // Close picker when clicking elsewhere
    document.addEventListener('click', () => {
        if (iconPickerEl && !iconPickerEl.classList.contains('hidden')) {
            iconPickerEl.classList.add('hidden');
            activeIconPickerUid = null;
        }
    });

    window.registerOverlay?.({ id: 'playlistManageModal', tier: 7, close: () => closePlaylistManager(), visible: (el) => el.classList.contains('visible') });
}

async function openPlaylistManager() {
    injectManageModal();
    await loadPlaylists();
    const searchInput = document.getElementById('playlistManageSearch');
    if (searchInput) searchInput.value = '';
    renderManageList();
    document.getElementById('playlistManageModal').classList.add('visible');
}

function closePlaylistManager() {
    document.getElementById('playlistManageModal')?.classList.remove('visible');
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
}

function renderManageList() {
    const listEl = document.getElementById('playlistManageList');
    const emptyEl = document.getElementById('playlistManageEmpty');
    const playlists = getAllPlaylists();

    if (!playlists.length) {
        listEl.innerHTML = '';
        emptyEl.style.display = '';
        filterManageList();
        return;
    }
    emptyEl.style.display = 'none';

    listEl.innerHTML = playlists.map(pl => {
        const iconColor = pl.color ? ` style="color:${esc(pl.color)}"` : '';
        const iconInner = pl.icon ? `<i class="${esc(pl.icon)}"${iconColor}></i>` : `<i class="fa-solid fa-icons" style="opacity:0.3"></i>`;
        const count = pl.characters.length;
        return `<div class="pl-manage-row" data-uid="${esc(pl.uid)}">
            <button class="pl-manage-icon-btn" title="Change icon">${iconInner}</button>
            <input type="text" class="pl-manage-name cl-input" value="${esc(pl.name)}" maxlength="100" autocomplete="one-time-code">
            <span class="pl-manage-count">${count}</span>
            <button class="pl-manage-delete" title="Delete playlist"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    }).join('');

    filterManageList();
}

function filterManageList() {
    const query = (document.getElementById('playlistManageSearch')?.value || '').trim().toLowerCase();
    const rows = document.querySelectorAll('#playlistManageList .pl-manage-row');
    let exactMatch = false;
    rows.forEach(row => {
        const name = (row.querySelector('.pl-manage-name')?.value || '').toLowerCase();
        const show = !query || name.includes(query);
        row.style.display = show ? '' : 'none';
        if (query && name === query) exactMatch = true;
    });
    const emptyEl = document.getElementById('playlistManageEmpty');
    if (emptyEl) emptyEl.style.display = rows.length === 0 && !query ? '' : 'none';

    let createRow = document.querySelector('#playlistManageList .pl-create-row');
    if (query && !exactMatch) {
        if (!createRow) {
            createRow = document.createElement('div');
            createRow.className = 'pl-create-row';
            createRow.addEventListener('click', handleManageCreate);
            document.getElementById('playlistManageList').appendChild(createRow);
        }
        createRow.innerHTML = `<i class="fa-solid fa-plus pl-create-row-icon"></i><span class="pl-create-row-text">Create <strong>${esc(document.getElementById('playlistManageSearch').value.trim())}</strong></span>`;
        createRow.style.display = '';
    } else if (createRow) {
        createRow.style.display = 'none';
    }
}

function positionPickerAtButton(btn, picker) {
    const zoom = parseFloat(document.body.style.zoom) || 1;
    const rect = btn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${rect.left / zoom}px`;
    picker.style.top = `${(rect.bottom / zoom) + 4}px`;
}

function toggleIconPicker(btn) {
    if (!iconPickerEl) {
        iconPickerEl = document.createElement('div');
        iconPickerEl.className = 'pl-manage-icon-picker hidden';
        const iconsHtml = PRESET_ICONS.map(ic => {
            const inner = ic ? `<i class="${ic}"></i>` : `<i class="fa-solid fa-xmark" style="opacity:0.3"></i>`;
            const title = ic ? ic.split(' ').pop().replace('fa-', '') : 'No icon';
            return `<button class="pl-icon-option" data-icon="${ic}" title="${title}">${inner}</button>`;
        }).join('');
        const swatchesHtml = PRESET_COLORS.map(c => {
            const style = c ? `background:${c}` : 'background:transparent; border: 1px dashed rgba(255,255,255,0.3)';
            const title = c || 'No color';
            return `<button class="pl-color-swatch" data-color="${c}" style="${style}" title="${title}"></button>`;
        }).join('');
        iconPickerEl.innerHTML = `<div class="pl-icon-picker-icons">${iconsHtml}</div><div class="pl-icon-picker-colors"><span class="pl-icon-picker-label">Color</span>${swatchesHtml}</div>`;
        document.body.appendChild(iconPickerEl);

        iconPickerEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const iconOpt = e.target.closest('.pl-icon-option');
            if (iconOpt && activeIconPickerUid) {
                handleManageIconChange(activeIconPickerUid, iconOpt.dataset.icon || '');
                return;
            }
            const swatch = e.target.closest('.pl-color-swatch');
            if (swatch && activeIconPickerUid) {
                handleManageColorChange(activeIconPickerUid, swatch.dataset.color || '');
                return;
            }
        });
    }

    const row = btn.closest('.pl-manage-row');
    const uid = row?.dataset.uid;

    if (activeIconPickerUid === uid && !iconPickerEl.classList.contains('hidden')) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
        return;
    }

    activeIconPickerUid = uid;
    positionPickerAtButton(btn, iconPickerEl);
    iconPickerEl.classList.remove('hidden');
}

async function handleManageIconChange(uid, icon) {
    await updatePlaylist(uid, { icon });
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
    renderManageList();
}

async function handleManageColorChange(uid, color) {
    await updatePlaylist(uid, { color });
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
    renderManageList();
}

async function handleManageRename(uid, newName) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (playlistNameExists(trimmed, uid)) {
        CoreAPI.showToast(`A playlist named "${trimmed}" already exists`, 'warning');
        renderManageList();
        return;
    }
    await updatePlaylist(uid, { name: trimmed });
}

async function handleManageDelete(uid) {
    const pl = getPlaylist(uid);
    if (!pl) return;
    const count = pl.characters.length;
    const msg = count > 0
        ? `Delete "${pl.name}"? (${count} character${count !== 1 ? 's' : ''} will be removed from this playlist)`
        : `Delete "${pl.name}"?`;

    if (!confirm(msg)) return;

    await deletePlaylist(uid);
    renderManageList();
    CoreAPI.refreshPlaylistBadges();
    CoreAPI.showToast(`Deleted "${pl.name}"`, 'info');
}

async function handleManageCreate() {
    const input = document.getElementById('playlistManageSearch');
    const name = (input?.value || '').trim();
    if (!name) return;

    if (playlistNameExists(name)) {
        CoreAPI.showToast(`A playlist named "${name}" already exists`, 'warning');
        return;
    }

    await createPlaylist(name);
    input.value = '';
    renderManageList();
    CoreAPI.showToast(`Created "${name}"`, 'success');
}

// ========================================
// INIT
// ========================================

function init() {
    loadPlaylists().then(() => {
        CoreAPI.refreshPlaylistBadges();
    });
}

// ========================================
// PUBLIC API
// ========================================

export {
    loadPlaylists,
    createPlaylist,
    deletePlaylist,
    updatePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    reorderPlaylists,
    getAllPlaylists,
    getPlaylist,
    getPlaylistCharacters,
    getPlaylistAvatarSet,
    getPlaylistsForChar,
    isCharInPlaylist,
    isCharInAnyPlaylist,
    onCharacterDeleted,
    openPlaylistPicker,
    closePlaylistPicker,
    openPlaylistManager,
    closePlaylistManager,
};

export default { init };
