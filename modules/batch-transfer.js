import * as CoreAPI from './core-api.js';

// ========================================
// STATE
// ========================================

let isInitialized = false;

const state = {
    view: 'chooser',
    running: false,
    abort: false,
    controller: null,
    zip: null,
    manifest: null,
    importSourceName: '',
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function tryParseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

// ========================================
// ZIP WRITER (STORE only, zip64-aware)
// ========================================

// 32-bit field ceiling. Sizes/offsets at or past this need zip64's 8-byte
// records; the ceiling doubles as the "value lives in the extra field" sentinel.
// card PNGs and gallery media are already compressed so STORE loses almost nothing.
const U32_MAX = 0xFFFFFFFF;
const U16_MAX = 0xFFFF;

function dosDateTime(d) {
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime, dosDate };
}

class ZipWriter {
    constructor() {
        this.parts = [];
        this.central = [];
        this.offset = 0;
    }

    addFile(name, bytes) {
        // A single >=4GB member would need zip64 in the LOCAL header too; the bundle's
        // real members (cards, chats, gallery files) never approach this, so we reject
        // it clearly rather than carry the extra local-header machinery.
        if (bytes.length >= U32_MAX) {
            throw new Error(`"${name}" is 4GB or larger; a single file that big cannot go in the bundle`);
        }
        const nameBytes = enc.encode(name);
        const crc = CoreAPI.crc32(bytes);
        const { dosTime, dosDate } = dosDateTime(new Date());

        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true); // UTF-8 filename flag
        lh.setUint16(8, 0, true);
        lh.setUint16(10, dosTime, true);
        lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, bytes.length, true);
        lh.setUint32(22, bytes.length, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);

        this.central.push({ nameBytes, crc, size: bytes.length, offset: this.offset, dosTime, dosDate });
        // File data goes in as a Blob part so the browser can spill big exports to disk.
        this.parts.push(new Uint8Array(lh.buffer), nameBytes, new Blob([bytes]));
        this.offset += 30 + nameBytes.length + bytes.length;
    }

    finalize() {
        const cdStart = this.offset;
        for (const e of this.central) {
            // Only the local-header offset can overflow (each member is < 4GB); when it
            // does, the 32-bit field holds the sentinel and the true value rides a zip64
            // extended-information extra field (header 0x0001).
            const offsetOverflow = e.offset >= U32_MAX;
            const extraLen = offsetOverflow ? 12 : 0;

            const cd = new DataView(new ArrayBuffer(46));
            cd.setUint32(0, 0x02014b50, true);
            cd.setUint16(4, offsetOverflow ? 45 : 20, true);  // version made by
            cd.setUint16(6, offsetOverflow ? 45 : 20, true);  // version needed to extract
            cd.setUint16(8, 0x0800, true);
            cd.setUint16(10, 0, true);
            cd.setUint16(12, e.dosTime, true);
            cd.setUint16(14, e.dosDate, true);
            cd.setUint32(16, e.crc, true);
            cd.setUint32(20, e.size, true);
            cd.setUint32(24, e.size, true);
            cd.setUint16(28, e.nameBytes.length, true);
            cd.setUint16(30, extraLen, true);
            cd.setUint32(42, offsetOverflow ? U32_MAX : e.offset, true);

            // Central-directory record layout is [fixed header][name][extra], in that order.
            this.parts.push(new Uint8Array(cd.buffer), e.nameBytes);
            if (offsetOverflow) {
                const extra = new DataView(new ArrayBuffer(12));
                extra.setUint16(0, 0x0001, true);          // zip64 extra header
                extra.setUint16(2, 8, true);               // payload = the 8-byte offset only
                extra.setBigUint64(4, BigInt(e.offset), true);
                this.parts.push(new Uint8Array(extra.buffer));
            }
            this.offset += 46 + extraLen + e.nameBytes.length;
        }

        const cdSize = this.offset - cdStart;
        const count = this.central.length;
        const needZip64 = cdStart >= U32_MAX || cdSize >= U32_MAX || count >= U16_MAX;

        if (needZip64) {
            const zEocdOffset = this.offset;
            // Zip64 end-of-central-directory record (56 bytes; the size field counts the 44 bytes after it).
            const z = new DataView(new ArrayBuffer(56));
            z.setUint32(0, 0x06064b50, true);
            z.setBigUint64(4, 44n, true);
            z.setUint16(12, 45, true);
            z.setUint16(14, 45, true);
            z.setUint32(16, 0, true);
            z.setUint32(20, 0, true);
            z.setBigUint64(24, BigInt(count), true);
            z.setBigUint64(32, BigInt(count), true);
            z.setBigUint64(40, BigInt(cdSize), true);
            z.setBigUint64(48, BigInt(cdStart), true);
            this.parts.push(new Uint8Array(z.buffer));
            this.offset += 56;

            // Zip64 end-of-central-directory locator (20 bytes).
            const loc = new DataView(new ArrayBuffer(20));
            loc.setUint32(0, 0x07064b50, true);
            loc.setUint32(4, 0, true);
            loc.setBigUint64(8, BigInt(zEocdOffset), true);
            loc.setUint32(16, 1, true);
            this.parts.push(new Uint8Array(loc.buffer));
            this.offset += 20;
        }

        // Standard EOCD; overflowed fields carry the sentinel so a reader falls through to the zip64 records above.
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, Math.min(count, U16_MAX), true);
        eocd.setUint16(10, Math.min(count, U16_MAX), true);
        eocd.setUint32(12, Math.min(cdSize, U32_MAX), true);
        eocd.setUint32(16, Math.min(cdStart, U32_MAX), true);
        this.parts.push(new Uint8Array(eocd.buffer));
        return new Blob(this.parts, { type: 'application/zip' });
    }
}

// ========================================
// ZIP READER
// ========================================

async function parseZip(file) {
    // EOCD sits at the end, preceded by an up-to-64KB comment; scan the tail backwards.
    const tailSize = Math.min(file.size, 65557);
    if (tailSize < 22) throw new Error('Not a zip file');
    const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
            eocdPos = i;
            break;
        }
    }
    if (eocdPos < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

    const eocd = new DataView(tail.buffer, eocdPos);
    let count = eocd.getUint16(10, true);
    let cdSize = eocd.getUint32(12, true);
    let cdOffset = eocd.getUint32(16, true);

    // Any maxed-out field means the real values live in the zip64 EOCD record,
    // reached via the 20-byte locator immediately preceding the standard EOCD.
    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
        const locPos = eocdPos - 20;
        if (locPos < 0 || tail[locPos] !== 0x50 || tail[locPos + 1] !== 0x4b || tail[locPos + 2] !== 0x06 || tail[locPos + 3] !== 0x07) {
            throw new Error('Corrupt bundle: zip64 markers present but the locator is missing');
        }
        const zEocdOffset = Number(new DataView(tail.buffer, locPos).getBigUint64(8, true));
        const zBytes = new Uint8Array(await file.slice(zEocdOffset, zEocdOffset + 56).arrayBuffer());
        const z = new DataView(zBytes.buffer);
        if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt zip64 end-of-central-directory record');
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOffset = Number(z.getBigUint64(48, true));
    }

    const cdBytes = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const cd = new DataView(cdBytes.buffer);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory');
        const method = cd.getUint16(p + 10, true);
        let compSize = cd.getUint32(p + 20, true);
        let size = cd.getUint32(p + 24, true);
        const nameLen = cd.getUint16(p + 28, true);
        const extraLen = cd.getUint16(p + 30, true);
        const commentLen = cd.getUint16(p + 32, true);
        let localOffset = cd.getUint32(p + 42, true);
        const name = dec.decode(cdBytes.subarray(p + 46, p + 46 + nameLen));

        // Resolve any sentinel'd field from the zip64 extra (header 0x0001); the 8-byte
        // values appear in size / compressed-size / offset order, only the flagged ones.
        if (size === U32_MAX || compSize === U32_MAX || localOffset === U32_MAX) {
            let ep = p + 46 + nameLen;
            const extraEnd = ep + extraLen;
            while (ep + 4 <= extraEnd) {
                const hid = cd.getUint16(ep, true);
                const hlen = cd.getUint16(ep + 2, true);
                if (hid === 0x0001) {
                    let fp = ep + 4;
                    if (size === U32_MAX) { size = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    if (compSize === U32_MAX) { compSize = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    if (localOffset === U32_MAX) { localOffset = Number(cd.getBigUint64(fp, true)); fp += 8; }
                    break;
                }
                ep += 4 + hlen;
            }
        }

        entries.set(name, { method, compSize, size, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries };
}

async function readZipEntry(zip, name) {
    const e = zip.entries.get(name);
    if (!e) return null;
    // Name/extra lengths must come from the LOCAL header; tools can write a
    // different extra field there than in the central directory.
    const lh = new DataView(await zip.file.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`Corrupt zip entry: ${name}`);
    const nameLen = lh.getUint16(26, true);
    const extraLen = lh.getUint16(28, true);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const blob = zip.file.slice(start, start + e.compSize);
    if (e.method === 0) return new Uint8Array(await blob.arrayBuffer());
    if (e.method === 8) {
        // Deflate support so bundles re-zipped by external tools still import.
        const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`Unsupported zip compression method ${e.method} for ${name}`);
}

// ========================================
// MODAL SHELL
// ========================================

function injectModal() {
    const modalHtml = `
    <div id="batchTransferModal" class="cl-modal cl-modal-drawer cl-drawer-partial">
        <div class="cl-modal-content btx-content" style="max-width: calc(560px * var(--modal-scale, 1));">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-box-archive"></i> <span id="batchTransferTitle">Export</span></h3>
                <button id="batchTransferCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body btx-body" id="batchTransferBody"></div>
            <div class="cl-modal-footer btx-footer" id="batchTransferFooter"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('batchTransferCloseBtn')?.addEventListener('click', () => closeModal());
    document.getElementById('batchTransferModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'batchTransferModal') closeModal();
    });
}

function setTitle(text) {
    const el = document.getElementById('batchTransferTitle');
    if (el) el.textContent = text;
}

function showModal() {
    document.getElementById('batchTransferModal')?.classList.add('visible');
}

async function closeModal() {
    if (state.running) {
        const confirmed = await CoreAPI.showConfirm({
            title: state.view === 'import-progress' ? 'Cancel import?' : 'Cancel export?',
            message: 'The operation is still running. Cancel and close?',
            icon: 'fa-solid fa-triangle-exclamation',
            iconColor: 'var(--cl-warning-bright)',
            confirmLabel: 'Cancel It',
            cancelLabel: 'Keep Running',
            danger: true,
        });
        if (!confirmed) return;
        state.abort = true;
        state.controller?.abort();
    }
    state.zip = null;
    state.manifest = null;
    document.getElementById('batchTransferModal')?.classList.remove('visible');
}

// ========================================
// PROGRESS VIEW (shared by export + import)
// ========================================

function renderProgressView() {
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;
    body.innerHTML = `
        <div class="btx-progress-label" id="btxProgressLabel">Starting...</div>
        <div class="btx-bar"><div class="btx-bar-fill" id="btxBarFill"></div></div>
        <div class="btx-log" id="btxLog"></div>`;
    footer.innerHTML = `
        <button id="btxCancelBtn" class="cl-btn cl-btn-secondary"><i class="fa-solid fa-ban"></i> Cancel</button>`;
    document.getElementById('btxCancelBtn')?.addEventListener('click', () => {
        state.abort = true;
        state.controller?.abort();
    });
}

function setProgress(fraction, label) {
    const fill = document.getElementById('btxBarFill');
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    const labelEl = document.getElementById('btxProgressLabel');
    if (labelEl && label) labelEl.textContent = label;
}

function logLine(text, level = 'info') {
    const log = document.getElementById('btxLog');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `btx-log-line btx-log-${level}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function renderDoneFooter() {
    const footer = document.getElementById('batchTransferFooter');
    if (!footer) return;
    footer.innerHTML = `<button id="btxDoneBtn" class="cl-btn cl-btn-primary"><i class="fa-solid fa-check"></i> Done</button>`;
    document.getElementById('btxDoneBtn')?.addEventListener('click', () => closeModal());
}

// ========================================
// EXPORT: CHOOSER
// ========================================

function openExportChooser() {
    if (!isInitialized) return;
    const selected = CoreAPI.getSelectedCharacters();
    if (!selected || selected.length === 0) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }
    if (CoreAPI.isExtensionsRecoveryInProgress()) {
        CoreAPI.showToast('Character data is still being recovered; try again in a moment', 'warning');
        return;
    }

    state.view = 'chooser';
    setTitle(`Export ${selected.length} Character${selected.length !== 1 ? 's' : ''}`);

    const linksDefault = !!CoreAPI.getSetting('exportAsLinks');
    const defaultBadge = '<span class="btx-default-badge">Default</span>';
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;

    body.innerHTML = `
        <div class="btx-options">
            <button class="btx-option" data-mode="bundle">
                <i class="fa-solid fa-box-archive"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Full bundle (.zip)</div>
                    <div class="btx-option-desc">Cards, all chats, and gallery folders in one archive for moving to another SillyTavern instance</div>
                </div>
            </button>
            <button class="btx-option" data-mode="pngs">
                <i class="fa-solid fa-file-image"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Character cards (.png) ${linksDefault ? '' : defaultBadge}</div>
                    <div class="btx-option-desc">Download each card as a separate PNG file</div>
                </div>
            </button>
            <button class="btx-option" data-mode="links">
                <i class="fa-solid fa-link"></i>
                <div class="btx-option-text">
                    <div class="btx-option-title">Provider links ${linksDefault ? defaultBadge : ''}</div>
                    <div class="btx-option-desc">Copy the source URLs of linked characters to the clipboard</div>
                </div>
            </button>
        </div>
        <label class="btx-worlds-check">
            <input type="checkbox" id="btxIncludeWorlds" checked>
            <span>Include linked lorebooks in the full bundle</span>
        </label>`;
    footer.innerHTML = '';

    body.querySelectorAll('.btx-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === 'bundle') {
                const includeWorlds = !!document.getElementById('btxIncludeWorlds')?.checked;
                runBundleExport(CoreAPI.getSelectedCharacters(), includeWorlds);
                return;
            }
            closeModal();
            const contextMenu = CoreAPI.getModule('context-menu');
            if (mode === 'pngs') contextMenu?.bulkExportPngs?.();
            if (mode === 'links') contextMenu?.bulkExportLinks?.();
        });
    });

    showModal();
}

// ========================================
// EXPORT: BUNDLE
// ========================================

async function runBundleExport(selected, includeWorlds) {
    state.view = 'export-progress';
    state.running = true;
    state.abort = false;
    state.controller = new AbortController();
    const signal = state.controller.signal;

    setTitle('Exporting Bundle');
    renderProgressView();

    const zip = new ZipWriter();
    const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        generator: 'SillyTavern-CharacterLibrary',
        characters: [],
    };
    const stats = { chars: 0, chats: 0, files: 0, worlds: 0, failedChars: 0, failedFiles: 0 };
    const worldNames = new Set();

    // Folder pre-check via /images/folders: IMAGES_LIST mkdirs missing folders
    // server-side, and most characters have no gallery to begin with. An empty
    // set is indistinguishable from a failed fetch, so treat it as unknown.
    let existingFolders = await CoreAPI.getExistingImageFolders();
    if (!existingFolders || existingFolders.size === 0) existingFolders = null;

    try {
        for (let i = 0; i < selected.length; i++) {
            if (state.abort) break;
            const char = selected[i];
            const displayName = char.data?.name || char.name || char.avatar;
            setProgress(i / selected.length, `${i + 1}/${selected.length}: ${displayName}`);

            try {
                const cardResp = await fetch(`/characters/${encodeURIComponent(char.avatar)}`, { signal });
                if (!cardResp.ok) throw new Error(`card fetch failed (HTTP ${cardResp.status})`);
                zip.addFile(`cards/${char.avatar}`, new Uint8Array(await cardResp.arrayBuffer()));

                const chatFolder = char.avatar.replace(/\.png$/i, '');
                const chatFiles = [];
                const charWorlds = new Set();
                const listResp = await CoreAPI.apiRequest('/characters/chats', 'POST', { avatar_url: char.avatar, simple: true });
                let chatList = [];
                if (listResp.ok) {
                    const parsed = await listResp.json();
                    if (Array.isArray(parsed)) chatList = parsed;
                } else {
                    stats.failedFiles++;
                    logLine(`${displayName}: chat list could not be read (HTTP ${listResp.status}); chats not included`, 'warn');
                }
                for (const chatInfo of chatList) {
                    if (state.abort) break;
                    const fname = chatInfo.file_name;
                    if (!fname) continue;
                    const expResp = await CoreAPI.apiRequest('/chats/export', 'POST', {
                        file: fname,
                        avatar_url: char.avatar,
                        is_group: false,
                        exportfilename: fname,
                        format: 'jsonl',
                    });
                    if (!expResp.ok) {
                        stats.failedFiles++;
                        logLine(`${displayName}: chat "${fname}" could not be read`, 'warn');
                        continue;
                    }
                    const raw = (await expResp.json())?.result;
                    if (typeof raw !== 'string' || raw.length === 0) continue;
                    zip.addFile(`chats/${chatFolder}/${fname}`, enc.encode(raw));
                    chatFiles.push(fname);
                    stats.chats++;
                    if (includeWorlds) {
                        const nl = raw.indexOf('\n');
                        const header = tryParseJson(nl === -1 ? raw : raw.slice(0, nl));
                        const bound = header?.chat_metadata?.world_info;
                        if (typeof bound === 'string' && bound) {
                            worldNames.add(bound);
                            charWorlds.add(bound);
                        }
                    }
                }

                let gallery = { folder: '', files: [] };
                const folderName = CoreAPI.getGalleryFolderName(char);
                // /images/folders and the static serve carry on-disk names ST sanitized at write time; || guards a name that strips to empty
                const diskFolder = CoreAPI.sanitizeFolderName(folderName) || folderName;
                if (folderName && (!existingFolders || existingFolders.has(diskFolder))) {
                    const info = await CoreAPI.getCharacterGalleryInfo(char);
                    const files = (info.files || []).map(f => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
                    const saved = [];
                    for (const fileName of files) {
                        if (state.abort) break;
                        try {
                            const fileResp = await fetch(`/user/images/${encodeURIComponent(diskFolder)}/${encodeURIComponent(fileName)}`, { signal });
                            if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
                            zip.addFile(`gallery/${diskFolder}/${fileName}`, new Uint8Array(await fileResp.arrayBuffer()));
                            saved.push(fileName);
                            stats.files++;
                        } catch (fileErr) {
                            if (state.abort) break;
                            stats.failedFiles++;
                            logLine(`${displayName}: gallery file "${fileName}" failed (${fileErr.message})`, 'warn');
                        }
                    }
                    gallery = { folder: diskFolder, files: saved };
                }

                const linkedWorld = char.data?.extensions?.world;
                if (includeWorlds && typeof linkedWorld === 'string' && linkedWorld) {
                    worldNames.add(linkedWorld);
                    charWorlds.add(linkedWorld);
                }

                manifest.characters.push({
                    avatar: char.avatar,
                    name: displayName,
                    create_date: char.create_date || '',
                    fav: char.fav === true || char.fav === 'true' || char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true',
                    chat: char.chat || '',
                    galleryId: CoreAPI.getCharacterGalleryId(char) || '',
                    chatFiles,
                    gallery,
                    worlds: [...charWorlds],
                });
                stats.chars++;
            } catch (charErr) {
                if (state.abort) break;
                stats.failedChars++;
                logLine(`${displayName}: ${charErr.message}`, 'error');
            }
        }

        if (includeWorlds && !state.abort && worldNames.size > 0) {
            setProgress(1, 'Collecting lorebooks...');
            // Numbered entry names sidestep world names the zip spec cant hold; the
            // manifest maps them back.
            manifest.worlds = [];
            let worldIndex = 0;
            for (const worldName of worldNames) {
                if (state.abort) break;
                try {
                    const data = await CoreAPI.getWorldInfoData(worldName);
                    if (!data) {
                        logLine(`Lorebook "${worldName}" not found on this instance; skipped`, 'warn');
                        continue;
                    }
                    const entryName = `worlds/${worldIndex}.json`;
                    zip.addFile(entryName, enc.encode(JSON.stringify(data)));
                    manifest.worlds.push({ name: worldName, file: entryName });
                    worldIndex++;
                    stats.worlds++;
                } catch (worldErr) {
                    logLine(`Lorebook "${worldName}" failed (${worldErr.message})`, 'warn');
                }
            }
        }

        if (state.abort) {
            setProgress(1, 'Export cancelled');
            logLine('Cancelled; no file was downloaded', 'warn');
            renderDoneFooter();
            return;
        }

        zip.addFile('manifest.json', enc.encode(JSON.stringify(manifest, null, 2)));
        const blob = zip.finalize();
        const stamp = new Date().toISOString().slice(0, 10);
        CoreAPI.downloadBlobAsFile(blob, `cl-bundle-${stamp}.zip`);

        setProgress(1, 'Bundle downloaded');
        const sizeMb = (blob.size / 1048576).toFixed(1);
        logLine(`Exported ${stats.chars} character${stats.chars !== 1 ? 's' : ''}, ${stats.chats} chat${stats.chats !== 1 ? 's' : ''}, ${stats.files} gallery file${stats.files !== 1 ? 's' : ''}${stats.worlds ? `, ${stats.worlds} lorebook${stats.worlds !== 1 ? 's' : ''}` : ''} (${sizeMb} MB)`, 'success');
        if (stats.failedChars || stats.failedFiles) {
            logLine(`${stats.failedChars} character(s) and ${stats.failedFiles} file(s) failed; see lines above`, 'warn');
        }
        renderDoneFooter();
    } catch (err) {
        setProgress(1, 'Export failed');
        logLine(err.message || String(err), 'error');
        renderDoneFooter();
    } finally {
        state.running = false;
        state.controller = null;
    }
}

// ========================================
// IMPORT: REVIEW
// ========================================

async function openImportReview(file) {
    if (!isInitialized || !file) return;
    if (CoreAPI.isExtensionsRecoveryInProgress()) {
        CoreAPI.showToast('Character data is still being recovered; try again in a moment', 'warning');
        return;
    }

    state.view = 'import-review';
    state.importSourceName = file.name || 'bundle.zip';
    setTitle('Import Bundle');

    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;
    body.innerHTML = '<div class="btx-progress-label">Reading bundle...</div>';
    footer.innerHTML = '';
    showModal();

    try {
        const zip = await parseZip(file);
        const manifestBytes = await readZipEntry(zip, 'manifest.json');
        if (!manifestBytes) throw new Error('Not a Character Library bundle (manifest.json missing)');
        const manifest = tryParseJson(dec.decode(manifestBytes));
        if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.characters)) {
            throw new Error('Unsupported or corrupt bundle manifest');
        }
        state.zip = zip;
        state.manifest = manifest;
        renderImportReview();
    } catch (err) {
        body.innerHTML = `<div class="btx-error"><i class="fa-solid fa-triangle-exclamation"></i> ${CoreAPI.escapeHtml(err.message || String(err))}</div>`;
        renderDoneFooter();
    }
}

function renderImportReview() {
    const { manifest } = state;
    const body = document.getElementById('batchTransferBody');
    const footer = document.getElementById('batchTransferFooter');
    if (!body || !footer) return;

    const existingAvatars = new Set(CoreAPI.getAllCharacters().map(c => c.avatar));
    const worldCount = Array.isArray(manifest.worlds) ? manifest.worlds.length : 0;

    const rows = manifest.characters.map((entry, idx) => {
        const exists = existingAvatars.has(entry.avatar);
        const chats = (entry.chatFiles || []).length;
        const files = (entry.gallery?.files || []).length;
        return `
        <label class="btx-review-row">
            <input type="checkbox" class="btx-review-check" data-index="${idx}" checked>
            <div class="btx-review-info">
                <div class="btx-review-name">${CoreAPI.escapeHtml(entry.name || entry.avatar)}${exists ? '<span class="btx-exists-badge">In library</span>' : ''}</div>
                <div class="btx-review-meta">${chats} chat${chats !== 1 ? 's' : ''} · ${files} gallery file${files !== 1 ? 's' : ''}</div>
            </div>
        </label>`;
    }).join('');

    body.innerHTML = `
        <div class="btx-review-header">${manifest.characters.length} character${manifest.characters.length !== 1 ? 's' : ''} in "${CoreAPI.escapeHtml(state.importSourceName)}"</div>
        <div class="btx-review-list">${rows}</div>
        <div class="btx-policy">
            <div class="btx-policy-title">If a character already exists here</div>
            <label class="btx-policy-row"><input type="radio" name="btxPolicy" value="skip" checked><span><strong>Skip</strong> - leave the existing character untouched</span></label>
            <label class="btx-policy-row"><input type="radio" name="btxPolicy" value="overwrite"><span><strong>Overwrite</strong> - replace the card in place, add the bundled chats and gallery</span></label>
            <label class="btx-policy-row"><input type="radio" name="btxPolicy" value="copy"><span><strong>Import as copy</strong> - keep both (the copy shares the gallery folder)</span></label>
        </div>
        ${worldCount ? `
        <label class="btx-worlds-check">
            <input type="checkbox" id="btxImportWorlds" checked>
            <span>Import ${worldCount} bundled lorebook${worldCount !== 1 ? 's' : ''} (existing names are skipped)</span>
        </label>` : ''}`;

    footer.innerHTML = `
        <button id="btxReviewCancelBtn" class="cl-btn cl-btn-secondary">Cancel</button>
        <button id="btxReviewImportBtn" class="cl-btn cl-btn-primary"><i class="fa-solid fa-download"></i> Import</button>`;

    document.getElementById('btxReviewCancelBtn')?.addEventListener('click', () => closeModal());
    document.getElementById('btxReviewImportBtn')?.addEventListener('click', () => {
        runBundleImport().catch(err => {
            setProgress(1, 'Import failed');
            logLine(err.message || String(err), 'error');
        }).finally(() => {
            // Backstop so a thrown error cant leave the modal stuck in running state
            if (state.running) {
                state.running = false;
                renderDoneFooter();
            }
        });
    });
}

// ========================================
// IMPORT: RUN
// ========================================

async function runBundleImport() {
    const { zip, manifest } = state;
    if (!zip || !manifest) return;

    const checked = [...document.querySelectorAll('.btx-review-check:checked')].map(cb => Number(cb.dataset.index));
    const entries = checked.map(i => manifest.characters[i]).filter(e => e && e.avatar);
    if (entries.length === 0) {
        CoreAPI.showToast('No characters selected for import', 'warning');
        return;
    }
    const policy = document.querySelector('input[name="btxPolicy"]:checked')?.value || 'skip';
    const includeWorlds = !!document.getElementById('btxImportWorlds')?.checked;

    state.view = 'import-progress';
    state.running = true;
    state.abort = false;
    setTitle('Importing Bundle');
    renderProgressView();

    const existingAvatars = new Set(CoreAPI.getAllCharacters().map(c => c.avatar));
    const results = [];
    const stats = { imported: 0, skipped: 0, failed: 0, chats: 0, files: 0 };

    for (let i = 0; i < entries.length; i++) {
        if (state.abort) break;
        const entry = entries[i];
        setProgress(i / entries.length, `${i + 1}/${entries.length}: ${entry.name || entry.avatar}`);

        const collision = existingAvatars.has(entry.avatar);
        if (collision && policy === 'skip') {
            stats.skipped++;
            logLine(`${entry.name || entry.avatar}: already in library, skipped`, 'info');
            continue;
        }

        try {
            const cardBytes = await readZipEntry(zip, `cards/${entry.avatar}`);
            if (!cardBytes) throw new Error('card file missing from bundle');

            const formData = new FormData();
            formData.append('avatar', new File([cardBytes], entry.avatar, { type: 'image/png' }));
            formData.append('file_type', 'png');
            // preserved_name keeps the avatar filename (chats key on it); omitted only
            // for the copy path so ST dedupes to a fresh name.
            if (!collision || policy === 'overwrite') {
                formData.append('preserved_name', entry.avatar);
            }
            // Snapshot the card being replaced in place, like every other destructive local mutation.
            // embedAvatar: the overwrite replaces the PNG artwork too, so the live avatar URL
            // would show the NEW art on the old snapshot.
            let keepGalleryId = null;
            let keepVersionUid = null;
            if (collision && policy === 'overwrite') {
                const existing = CoreAPI.getAllCharacters().find(c => c.avatar === entry.avatar);
                if (existing) {
                    keepGalleryId = existing.data?.extensions?.gallery_id || null;
                    try { await CoreAPI.autoSnapshotBeforeChange(existing, 'update', { embedAvatar: true }); } catch (_) {}
                    // Read after the snapshot call: ensureVersionUid stamps a fresh uid onto this ref.
                    keepVersionUid = existing.data?.extensions?.version_uid || null;
                }
            }
            const importResp = await fetch('/api/characters/import', {
                method: 'POST',
                headers: { 'X-CSRF-Token': CoreAPI.getCSRFToken() },
                body: formData,
            });
            if (!importResp.ok) throw new Error(`import failed (HTTP ${importResp.status})`);
            const result = tryParseJson(await importResp.text());
            if (!result || result.error || !result.file_name) throw new Error('SillyTavern rejected the card');
            const newAvatar = String(result.file_name).toLowerCase().endsWith('.png')
                ? result.file_name
                : `${result.file_name}.png`;
            // The card is in the library from here on: count it imported and keep it in
            // the metadata-restore pass even if a chat/gallery section trips below.
            // keepGalleryId rides along so the restore pass can put the local gallery_id
            // back AFTER fetchCharacters(true); writing it here would build the payload
            // from the stale pre-overwrite in-memory card.
            results.push({ entry, newAvatar, keepGalleryId, keepVersionUid });
            stats.imported++;
            const effectiveGalleryId = keepGalleryId || entry.galleryId || null;

            // /chats/save keeps the original filenames; ST's own /chats/import would
            // rename every file to "<name> - <date> imported".
            let chatCount = 0;
            try {
                const srcFolder = entry.avatar.replace(/\.png$/i, '');
                for (const chatFile of entry.chatFiles || []) {
                    if (state.abort) break;
                    const bytes = await readZipEntry(zip, `chats/${srcFolder}/${chatFile}`);
                    if (!bytes) continue;
                    const chat = dec.decode(bytes).split('\n').map(tryParseJson).filter(Boolean);
                    if (chat.length === 0) continue;
                    const saveResp = await CoreAPI.apiRequest('/chats/save', 'POST', {
                        avatar_url: newAvatar,
                        file_name: chatFile.replace(/\.jsonl$/i, ''),
                        chat,
                        force: true,
                    });
                    if (saveResp.ok) {
                        chatCount++;
                        stats.chats++;
                    } else {
                        logLine(`${entry.name}: chat "${chatFile}" failed to save`, 'warn');
                    }
                }
            } catch (err) {
                logLine(`${entry.name}: chat restore interrupted: ${err.message}`, 'warn');
            }

            // Target folder is resolved with THIS instance's gallery settings so the
            // files land where the gallery will actually look for them.
            let fileCount = 0;
            try {
                const bundledFiles = entry.gallery?.files || [];
                if (bundledFiles.length > 0) {
                    const pseudoChar = {
                        name: entry.name || newAvatar.replace(/\.png$/i, ''),
                        avatar: newAvatar,
                        data: { extensions: effectiveGalleryId ? { gallery_id: effectiveGalleryId } : {} },
                    };
                    const targetFolder = CoreAPI.getGalleryFolderName(pseudoChar) || entry.gallery.folder;
                    for (const fileName of bundledFiles) {
                        if (state.abort) break;
                        const bytes = await readZipEntry(zip, `gallery/${entry.gallery.folder}/${fileName}`);
                        if (!bytes) continue;
                        const dot = fileName.lastIndexOf('.');
                        const uploadResp = await CoreAPI.apiRequest('/images/upload', 'POST', {
                            image: CoreAPI.arrayBufferToBase64(bytes.buffer),
                            ch_name: targetFolder,
                            filename: dot > -1 ? fileName.slice(0, dot) : fileName,
                            format: dot > -1 ? fileName.slice(dot + 1).toLowerCase() : 'png',
                        });
                        if (uploadResp.ok) {
                            fileCount++;
                            stats.files++;
                        } else {
                            logLine(`${entry.name}: gallery file "${fileName}" rejected`, 'warn');
                        }
                    }
                }
            } catch (err) {
                logLine(`${entry.name}: gallery restore interrupted: ${err.message}`, 'warn');
            }

            logLine(`${entry.name || entry.avatar}: imported${newAvatar !== entry.avatar ? ` as ${newAvatar}` : ''} (${chatCount} chats, ${fileCount} files)`, 'success');
        } catch (err) {
            stats.failed++;
            logLine(`${entry.name || entry.avatar}: ${err.message}`, 'error');
        }
    }

    if (includeWorlds && !state.abort && Array.isArray(manifest.worlds) && manifest.worlds.length > 0) {
        setProgress(1, 'Importing lorebooks...');
        try {
            const existing = new Set((await CoreAPI.listWorldInfoFiles() || []).map(w => w.file_id));
            for (const world of manifest.worlds) {
                if (state.abort) break;
                if (!world?.name || !world?.file) continue;
                if (existing.has(world.name)) {
                    logLine(`Lorebook "${world.name}" already exists; skipped`, 'info');
                    continue;
                }
                const bytes = await readZipEntry(zip, world.file);
                const data = bytes ? tryParseJson(dec.decode(bytes)) : null;
                if (!data) {
                    logLine(`Lorebook "${world.name}" is missing or corrupt in the bundle`, 'warn');
                    continue;
                }
                const saved = await CoreAPI.saveWorldInfoData(world.name, data);
                logLine(saved !== false ? `Lorebook "${world.name}" imported` : `Lorebook "${world.name}" failed to save`, saved !== false ? 'success' : 'warn');
            }
        } catch (worldErr) {
            logLine(`Lorebook import failed: ${worldErr.message}`, 'warn');
        }
    }

    if (results.length > 0) {
        setProgress(1, 'Restoring metadata...');
        // Populate allCharacters with the freshly imported cards so we can grab live
        // refs; guard it so a refresh hiccup cant strand the modal on this step.
        try { await CoreAPI.fetchCharacters(true); } catch (e) { logLine(`Character refresh failed: ${e.message}`, 'warn'); }
        for (const r of results) {
            try {
                // ST's import sanitizes data.name and unsets fav + the recent-chat pointer
                // and resets create_date to import time; put the source values back. Use
                // writeCardFields (the primitive), NOT applyCardFieldUpdates: the gallery
                // files already sit in the raw-name folder, so the wrapper's per-char
                // gallery-folder rename would be wasted round-trips that stall the run.
                const live = CoreAPI.getAllCharacters().find(c => c.avatar === r.newAvatar);
                if (!live) continue;
                const dataUpdates = {};
                const rootFields = {};
                if (r.entry.create_date) rootFields.create_date = r.entry.create_date;
                if (r.entry.chat) rootFields.chat = r.entry.chat;
                if (r.entry.fav) {
                    rootFields.fav = true;
                    dataUpdates['extensions.fav'] = true;
                }
                if (r.entry.name && (live.data?.name ?? live.name) !== r.entry.name) {
                    dataUpdates.name = r.entry.name;
                }
                // Overwrite keeps THIS instance's gallery folder: the bundle card carried
                // its own gallery_id, so the pre-overwrite one goes back on the fresh card.
                if (r.keepGalleryId && live.data?.extensions?.gallery_id !== r.keepGalleryId) {
                    dataUpdates['extensions.gallery_id'] = r.keepGalleryId;
                }
                // Same rule as gallery_id: the versions panel resolves by the card's own uid, so the bundle's uid would shadow the pre-overwrite safety snapshot.
                if (r.keepVersionUid && live.data?.extensions?.version_uid !== r.keepVersionUid) {
                    dataUpdates['extensions.version_uid'] = r.keepVersionUid;
                }
                if (Object.keys(dataUpdates).length || Object.keys(rootFields).length) {
                    await CoreAPI.writeCardFields(live, dataUpdates, { rootFields });
                }
            } catch (restoreErr) {
                logLine(`${r.entry.name}: metadata restore failed (${restoreErr.message})`, 'warn');
            }
        }

        // Repaint CL's grid so restored fav/name/date show. The host ST window's list is
        // refreshed fire-and-forget (never awaited: a backgrounded opener tab could
        // otherwise stall the finish).
        CoreAPI.performSearch();
        try { CoreAPI.getHostWindow()?.SillyTavern?.getContext?.()?.getCharacters?.()?.catch?.(() => {}); } catch { /* opener may be gone */ }
    }

    setProgress(1, state.abort ? 'Import cancelled' : 'Import complete');
    logLine(`Imported ${stats.imported}, skipped ${stats.skipped}, failed ${stats.failed} (${stats.chats} chats, ${stats.files} gallery files)`, stats.failed ? 'warn' : 'success');
    state.running = false;
    renderDoneFooter();
}

// ========================================
// INIT
// ========================================

function init() {
    if (isInitialized) {
        console.warn('[BatchTransfer] Already initialized');
        return;
    }
    injectModal();
    window.registerOverlay?.({
        id: 'batchTransferModal',
        tier: 7,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });
    isInitialized = true;
    CoreAPI.debugLog('[BatchTransfer] Module initialized');
}

export default {
    init,
    openExportChooser,
    openImportReview,
};
