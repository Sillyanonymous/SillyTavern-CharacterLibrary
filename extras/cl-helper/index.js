// cl-helper: SillyTavern server plugin for Character Library
//
// Provides server-side request proxying for providers that require
// custom headers (like Origin) that browsers forbid setting.
// Also provides gallery thumbnail generation via ST's bundled jimp.

import { randomUUID } from 'node:crypto';
import { join, resolve, sep, dirname } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { stat, lstat, readFile, writeFile, rename, unlink, readdir, open } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'cl-helper',
    name: 'Character Library Helper',
    description: 'Auth and request proxying for the Character Library extension.',
};

let _runningVersion = 'unknown';
try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    if (pkg?.version) _runningVersion = String(pkg.version);
} catch {}

// Detect symlink/junction; on Windows ESM resolves junctions at load so __dirname is the target, also check the canonical plugins path.
let _isLinkedInstall = false;
const _pathEq = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
try {
    if (lstatSync(__dirname).isSymbolicLink()) _isLinkedInstall = true;
} catch {}
if (!_isLinkedInstall) {
    try {
        const real = realpathSync(__dirname);
        if (real && !_pathEq(real, __dirname)) _isLinkedInstall = true;
    } catch {}
}
if (!_isLinkedInstall) {
    try {
        const pluginPath = resolve(process.cwd(), 'plugins', 'cl-helper');
        const st = lstatSync(pluginPath);
        if (st.isSymbolicLink()) {
            _isLinkedInstall = true;
        } else {
            const real = realpathSync(pluginPath);
            if (real && !_pathEq(real, pluginPath)) _isLinkedInstall = true;
        }
    } catch {}
}

// =============================================================================
// Gallery thumbnails
// =============================================================================

const THUMB_QUALITY = 82;
const THUMB_MAX_SIZE = 1024;
const THUMB_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
const THUMB_CONCURRENCY = 2;
const THUMB_MAX_FILE_BYTES = 50 * 1024 * 1024;   // 50 MB on-disk
const THUMB_MAX_PIXELS = 150_000_000;            // ~150 MP (decoded RAM ~600 MB worst case)
const THUMB_HEADER_PEEK_BYTES = 65536;           // 64 KB scan for JPEG SOF

/**
 * Peek image dimensions without decoding. Returns {w, h} when known, null otherwise.
 * Handles PNG (IHDR at fixed offset), GIF (LSD), and JPEG (scan first 64KB for SOF).
 * WebP/AVIF/TIFF/BMP fall through to the file-size cap.
 */
async function peekImageDimensions(filePath) {
    let fh;
    try {
        fh = await open(filePath, 'r');
        const buf = Buffer.alloc(THUMB_HEADER_PEEK_BYTES);
        const { bytesRead } = await fh.read(buf, 0, THUMB_HEADER_PEEK_BYTES, 0);
        if (bytesRead < 16) return null;

        // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at bytes 16..23 (BE uint32)
        if (bytesRead >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        }

        // GIF: "GIF87a"/"GIF89a", logical screen width/height at bytes 6..9 (LE uint16)
        if (bytesRead >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
            return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
        }

        // JPEG: starts FF D8; scan markers for SOF0/1/2 (FF C0/C1/C2)
        if (bytesRead >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
            let i = 2;
            while (i + 9 < bytesRead) {
                if (buf[i] !== 0xFF) { i++; continue; }
                let marker = buf[i + 1];
                // skip padding 0xFF bytes
                while (marker === 0xFF && i + 2 < bytesRead) { i++; marker = buf[i + 1]; }
                if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
                // SOF0/1/2/3/5/6/7/9..11/13..15 carry dimensions; SOF4/8/12 are not frame headers
                if ((marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    if (i + 9 >= bytesRead) return null;
                    const h = buf.readUInt16BE(i + 5);
                    const w = buf.readUInt16BE(i + 7);
                    return { w, h };
                }
                // Other markers carry length at next 2 bytes (BE)
                const segLen = buf.readUInt16BE(i + 2);
                if (segLen < 2) return null;
                i += 2 + segLen;
            }
        }

        return null;
    } catch {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

let _Jimp = null;
let _imagesDir = null;
let _charactersDir = null;
let _thumbsReady = false;
let _thumbActive = 0;
let _thumbQueue = [];

function _thumbSemaphore() {
    if (_thumbActive < THUMB_CONCURRENCY) {
        _thumbActive++;
        return Promise.resolve();
    }
    return new Promise(resolve => _thumbQueue.push(resolve));
}

function _thumbRelease() {
    if (_thumbQueue.length > 0) {
        _thumbQueue.shift()();
    } else {
        _thumbActive--;
    }
}

function resolveImagesDir() {
    const stRoot = process.cwd();
    const dataDir = join(stRoot, 'data');
    if (!existsSync(dataDir)) return null;

    const defaultPath = join(dataDir, 'default-user', 'user', 'images');
    if (existsSync(defaultPath)) return defaultPath;

    try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const candidate = join(dataDir, entry.name, 'user', 'images');
            if (existsSync(candidate)) return candidate;
        }
    } catch {}

    return null;
}

function resolveCharactersDir() {
    // ST's USER_DIRECTORY_TEMPLATE puts `characters` at the user root (data/<user>/characters),
    // NOT under user/ like gallery images (data/<user>/user/images).
    const stRoot = process.cwd();
    const dataDir = join(stRoot, 'data');
    if (!existsSync(dataDir)) return null;

    const defaultPath = join(dataDir, 'default-user', 'characters');
    if (existsSync(defaultPath)) return defaultPath;

    try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
            const candidate = join(dataDir, entry.name, 'characters');
            if (existsSync(candidate)) return candidate;
        }
    } catch {}

    return null;
}

// resolve() to absolute: a relative DATA_ROOT (eg. ./data) fails the routes' absolute-path startsWith guard and 403s
function imagesDirForReq(req) {
    const dir = req.user?.directories?.userImages || _imagesDir;
    return dir ? resolve(dir) : null;
}
function charactersDirForReq(req) {
    const dir = req.user?.directories?.characters || _charactersDir;
    return dir ? resolve(dir) : null;
}
function avatarThumbDirForReq(req) {
    const charactersDir = charactersDirForReq(req);
    return charactersDir ? join(charactersDir, '..', 'cl_avatar_thumbs') : null;
}

async function initImageLib() {
    const stModules = join(process.cwd(), 'node_modules');
    const stImport = async (pkg) => {
        const pj = JSON.parse(await readFile(join(stModules, pkg, 'package.json'), 'utf8'));
        const entry = pj.exports?.['.']?.import?.default || pj.module || 'index.js';
        return import(pathToFileURL(join(stModules, pkg, entry)).href);
    };

    try {
        const { createJimp } = await stImport('@jimp/core');
        const jpeg = (await stImport('@jimp/wasm-jpeg')).default;
        const png = (await stImport('@jimp/wasm-png')).default;
        const resize = await stImport('@jimp/plugin-resize');
        const crop = await stImport('@jimp/plugin-crop');
        const cover = await stImport('@jimp/plugin-cover');

        const formats = [jpeg, png];
        try { formats.push((await stImport('@jimp/wasm-webp')).default); } catch (e) { console.log('[cl-helper] webp not available:', e.message); }
        try { formats.push((await stImport('@jimp/js-gif')).default); } catch (e) { console.log('[cl-helper] gif not available:', e.message); }

        _Jimp = createJimp({
            plugins: [resize.methods, crop.methods, cover.methods],
            formats,
        });
        return true;
    } catch (err) {
        console.log('[cl-helper] jimp not available:', err.message);
        return false;
    }
}

function registerThumbnailRoutes(router) {
    router.get('/gallery-thumb/:folder/:file', async (req, res) => {
        if (!_Jimp || !_imagesDir) {
            return res.status(503).json({ error: 'Thumbnails not available' });
        }

        const { folder, file } = req.params;
        const size = Math.min(Math.max(parseInt(req.query.s) || 384, 64), THUMB_MAX_SIZE);

        const imagesDir = imagesDirForReq(req);
        if (!imagesDir) {
            return res.status(503).json({ error: 'Thumbnails not available' });
        }

        // Block path separators only; benign filenames can legitimately contain ".." (eg. ellipsis).
        // The resolve + startsWith check below catches any traversal that survives this.
        if (!folder || !file
            || folder.includes('/') || folder.includes('\\')
            || file.includes('/') || file.includes('\\')) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        if (!THUMB_EXTENSIONS.test(file)) {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        const originalPath = resolve(imagesDir, folder, file);
        if (!originalPath.startsWith(imagesDir + sep)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        let origStat;
        try {
            origStat = await stat(originalPath);
        } catch {
            console.log(`[cl-helper] 404: ${originalPath}`);
            return res.status(404).json({ error: 'Not found' });
        }

        if (origStat.size > THUMB_MAX_FILE_BYTES) {
            console.log(`[cl-helper] thumb rejected (file too large ${origStat.size}): ${folder}/${file}`);
            return res.status(413).json({ error: 'Image too large' });
        }

        const dims = await peekImageDimensions(originalPath);
        if (dims && (dims.w * dims.h) > THUMB_MAX_PIXELS) {
            console.log(`[cl-helper] thumb rejected (dimensions ${dims.w}x${dims.h}): ${folder}/${file}`);
            return res.status(413).json({ error: 'Image dimensions too large' });
        }

        const cacheFolder = join(imagesDir, '..', 'cl_thumbs', folder);
        const cachePath = join(cacheFolder, `${file}_${size}.jpg`);

        try {
            const cacheStat = await stat(cachePath);
            if (cacheStat.mtimeMs > origStat.mtimeMs) {
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(await readFile(cachePath));
            }
        } catch { /* cache miss */ }

        try {
            await _thumbSemaphore();
            const image = await _Jimp.read(originalPath);
            image.cover({ w: size, h: size });
            const buffer = await image.getBuffer('image/jpeg', { quality: THUMB_QUALITY, jpegColorSpace: 'ycbcr' });
            _thumbRelease();

            mkdirSync(cacheFolder, { recursive: true });
            writeFile(cachePath, buffer).catch(() => {});

            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } catch (err) {
            _thumbRelease();
            console.error(`[cl-helper] Thumb error ${folder}/${file}:`, err.message);
            res.status(500).json({ error: 'Generation failed' });
        }
    });

    router.post('/gallery-thumb-cleanup/:folder', (req, res) => {
        const imagesDir = imagesDirForReq(req);
        if (!imagesDir) {
            return res.status(503).json({ error: 'Thumbnails not available' });
        }

        const { folder } = req.params;
        if (!folder || folder.includes('/') || folder.includes('\\')) {
            return res.status(400).json({ error: 'Invalid folder' });
        }

        const cacheDir = join(imagesDir, '..', 'cl_thumbs');
        const cacheFolder = resolve(cacheDir, folder);
        if (!cacheFolder.startsWith(cacheDir + sep)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (existsSync(cacheFolder)) {
                rmSync(cacheFolder, { recursive: true, force: true });
                console.log(`[cl-helper] Cleaned thumb cache: ${folder}`);
                res.json({ ok: true, deleted: true });
            } else {
                res.json({ ok: true, deleted: false });
            }
        } catch (err) {
            console.error(`[cl-helper] Cache cleanup error ${folder}:`, err.message);
            res.status(500).json({ error: 'Cleanup failed' });
        }
    });

    // Avatar thumbnail: aspect-preserving JPEG resize of a character PNG.
    // ST's built-in /thumbnail?type=avatar serves 96x144 which is too small
    // for retina-DPR mobile grids; we serve a larger one (default 512w) with
    // our own jimp pipeline + on-disk cache.
    router.get('/avatar-thumb/:file', async (req, res) => {
        const charactersDir = charactersDirForReq(req);
        if (!_Jimp || !charactersDir) {
            return res.status(503).json({ error: 'Avatar thumbnails not available' });
        }

        const { file } = req.params;
        const size = Math.min(Math.max(parseInt(req.query.s) || 512, 64), THUMB_MAX_SIZE);

        if (!file || file.includes('/') || file.includes('\\')) {
            return res.status(400).json({ error: 'Invalid path' });
        }
        if (!/\.png$/i.test(file)) {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        const originalPath = resolve(charactersDir, file);
        if (!originalPath.startsWith(charactersDir + sep)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        let origStat;
        try {
            origStat = await stat(originalPath);
        } catch {
            return res.status(404).json({ error: 'Not found' });
        }

        if (origStat.size > THUMB_MAX_FILE_BYTES) {
            return res.status(413).json({ error: 'Image too large' });
        }

        const avatarThumbDir = avatarThumbDirForReq(req);
        const cachePath = join(avatarThumbDir, `${file}_${size}.jpg`);

        try {
            const cacheStat = await stat(cachePath);
            if (cacheStat.mtimeMs > origStat.mtimeMs) {
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(await readFile(cachePath));
            }
        } catch { /* cache miss */ }

        try {
            await _thumbSemaphore();
            const image = await _Jimp.read(originalPath);
            // Match .char-card aspect (2:3) so browser object-fit: cover is a no-op and doesnt double-crop.
            image.cover({ w: size, h: Math.round(size * 1.5) });
            const buffer = await image.getBuffer('image/jpeg', { quality: THUMB_QUALITY, jpegColorSpace: 'ycbcr' });
            _thumbRelease();

            mkdirSync(avatarThumbDir, { recursive: true });
            writeFile(cachePath, buffer).catch(() => {});

            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } catch (err) {
            _thumbRelease();
            console.error(`[cl-helper] Avatar thumb error ${file}:`, err.message);
            res.status(500).json({ error: 'Generation failed' });
        }
    });

    router.get('/avatar-thumb-stats', async (req, res) => {
        const avatarThumbDir = avatarThumbDirForReq(req);
        if (!avatarThumbDir) {
            return res.json({ count: 0, bytes: 0, available: false });
        }
        try {
            if (!existsSync(avatarThumbDir)) return res.json({ count: 0, bytes: 0, available: true });
            const entries = readdirSync(avatarThumbDir);
            let bytes = 0;
            for (const name of entries) {
                try {
                    const s = await stat(join(avatarThumbDir, name));
                    if (s.isFile()) bytes += s.size;
                } catch { /* skip */ }
            }
            res.json({ count: entries.length, bytes, available: true });
        } catch (err) {
            console.error('[cl-helper] Avatar thumb stats error:', err.message);
            res.status(500).json({ error: 'Stats failed' });
        }
    });

    router.post('/avatar-thumb-cleanup', (req, res) => {
        const avatarThumbDir = avatarThumbDirForReq(req);
        if (!avatarThumbDir) {
            return res.status(503).json({ error: 'Avatar thumbnails not available' });
        }
        try {
            let deleted = 0;
            if (existsSync(avatarThumbDir)) {
                deleted = readdirSync(avatarThumbDir).length;
                rmSync(avatarThumbDir, { recursive: true, force: true });
                console.log(`[cl-helper] Purged avatar thumb cache (${deleted} files)`);
            }
            res.json({ ok: true, deleted });
        } catch (err) {
            console.error('[cl-helper] Avatar thumb cleanup error:', err.message);
            res.status(500).json({ error: 'Cleanup failed' });
        }
    });

    // Populate runs as a background job: client kicks it off, polls /populate-status
    // for progress. Sequential + setImmediate yield between each thumb keeps ST's
    // event loop responsive (jimp's PNG decode is synchronous on the main thread).
    router.post('/avatar-thumb-populate', async (req, res) => {
        const charactersDir = charactersDirForReq(req);
        const avatarThumbDir = avatarThumbDirForReq(req);
        if (!_Jimp || !charactersDir || !avatarThumbDir) {
            return res.status(503).json({ error: 'Avatar thumbnails not available' });
        }
        if (_populateJob && _populateJob.running) {
            return res.status(409).json({ error: 'Populate already running', job: _populateJob });
        }
        const size = Math.min(Math.max(parseInt(req.query.s) || 512, 64), THUMB_MAX_SIZE);

        let files;
        try {
            files = readdirSync(charactersDir).filter(f => /\.png$/i.test(f));
        } catch (err) {
            return res.status(500).json({ error: 'Failed to read characters directory' });
        }

        mkdirSync(avatarThumbDir, { recursive: true });
        runAvatarPopulateJob(size, files, charactersDir, avatarThumbDir).catch(err => {
            console.error('[cl-helper] populate job crashed:', err.message);
            if (_populateJob) { _populateJob.running = false; _populateJob.finishedAt = Date.now(); }
        });
        res.json({ started: true, total: files.length, size });
    });

    router.get('/avatar-thumb-populate-status', (req, res) => {
        res.json(_populateJob || { running: false, total: 0, processed: 0, generated: 0, skipped: 0, failed: 0 });
    });
}

let _populateJob = null;

async function runAvatarPopulateJob(size, files, charactersDir, avatarThumbDir) {
    _populateJob = {
        running: true,
        total: files.length,
        processed: 0,
        generated: 0,
        skipped: 0,
        failed: 0,
        size,
        startedAt: Date.now(),
        finishedAt: null,
    };

    for (const file of files) {
        const originalPath = resolve(charactersDir, file);
        const cachePath = join(avatarThumbDir, `${file}_${size}.jpg`);

        try {
            const origStat = await stat(originalPath);
            if (origStat.size > THUMB_MAX_FILE_BYTES) {
                console.warn(`[cl-helper] Avatar thumb populate skipped (over ${Math.round(THUMB_MAX_FILE_BYTES / 1024 / 1024)} MB cap, ${(origStat.size / 1024 / 1024).toFixed(1)} MB): ${file}`);
                _populateJob.failed++;
            } else {
                let needs = true;
                try {
                    const cacheStat = await stat(cachePath);
                    if (cacheStat.mtimeMs > origStat.mtimeMs) { _populateJob.skipped++; needs = false; }
                } catch { /* cache miss */ }
                if (needs) {
                    try {
                        await _thumbSemaphore();
                        const image = await _Jimp.read(originalPath);
                        image.cover({ w: size, h: Math.round(size * 1.5) });
                        const buffer = await image.getBuffer('image/jpeg', { quality: THUMB_QUALITY, jpegColorSpace: 'ycbcr' });
                        _thumbRelease();
                        await writeFile(cachePath, buffer);
                        _populateJob.generated++;
                    } catch (err) {
                        _thumbRelease();
                        console.warn(`[cl-helper] Avatar thumb populate failed for ${file}:`, err.message);
                        _populateJob.failed++;
                    }
                }
            }
        } catch (err) {
            console.warn(`[cl-helper] Avatar thumb populate failed for ${file} (stat):`, err.message);
            _populateJob.failed++;
        }

        _populateJob.processed++;
        // Yield back to the event loop between every thumb so other ST requests still get serviced during a long populate.
        await new Promise(r => setImmediate(r));
    }

    _populateJob.running = false;
    _populateJob.finishedAt = Date.now();
    console.log(`[cl-helper] Avatar thumb populate done: ${_populateJob.generated} new, ${_populateJob.skipped} cached, ${_populateJob.failed} failed (size ${size})`);
}

// =============================================================================
// Pygmalion: login proxy
// =============================================================================

const PYGMALION_AUTH_URL = 'https://auth.pygmalion.chat/session';
const PYGMALION_ORIGIN = 'https://pygmalion.chat';

function registerPygmalionRoutes(router) {
    router.post('/pyg-login', async (req, res) => {
        const { username, password } = req.body ?? {};

        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        if (typeof username !== 'string' || typeof password !== 'string'
            || username.length > 256 || password.length > 256) {
            return res.status(400).json({ error: 'Invalid credentials format' });
        }

        try {
            const body = new URLSearchParams({ username, password }).toString();

            const response = await fetch(PYGMALION_AUTH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': PYGMALION_ORIGIN,
                    'Referer': PYGMALION_ORIGIN + '/',
                },
                body,
            });

            const text = await response.text();

            res.status(response.status);
            res.set('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            console.error('[cl-helper] Pygmalion login proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Pygmalion auth server' });
        }
    });
}

// =============================================================================
// Botbooru: login proxy
// =============================================================================

const BOTBOORU_AUTH_URL = 'https://botbooru.com/auth/token';
const BOTBOORU_BASE = 'https://botbooru.com';

// Allow-list for the botbooru proxy; hostname is pinned to botbooru.com separately.
const BOTBOORU_ALLOWED_PATHS = [
    /^\/posts(\/|$)/,
    /^\/post\/\d+/,
    /^\/tags\//,
    /^\/api\/users\//,
    /^\/auth\/me(\/|$)/,
    /^\/interactions\//,
    /^\/download\/(png|json)\//,
    /^\/images\//,
    /^\/mini-gallery\//,
];

async function handleBotbooruProxy(req, res) {
    const bearer = req.headers['x-cl-botbooru-auth'];
    if (bearer !== undefined && (typeof bearer !== 'string' || bearer.length > 4096)) {
        return res.status(400).json({ error: 'Invalid auth header' });
    }

    const targetPath = '/' + (req.params[0] || '');
    const normalizedPath = new URL(targetPath, BOTBOORU_BASE).pathname;
    if (!BOTBOORU_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
        console.warn(`[cl-helper] Botbooru proxy blocked: ${normalizedPath}`);
        return res.status(403).json({ error: 'Proxy path not allowed' });
    }

    const targetUrl = new URL(targetPath, BOTBOORU_BASE);
    targetUrl.search = new URL(req.url, 'http://localhost').search;
    if (targetUrl.hostname !== 'botbooru.com') {
        return res.status(403).json({ error: 'Proxy target must be botbooru.com' });
    }

    const headers = { Accept: 'application/json' };
    if (bearer) headers['Authorization'] = bearer;
    // Only forward a body when the client actually sent one, so bodyless POSTs
    // (favorite toggle, follow) match the direct path exactly.
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method)
        && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    if (hasBody) headers['Content-Type'] = 'application/json';

    try {
        const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body) : undefined,
            redirect: 'follow',
        });

        res.status(response.status);
        const contentType = response.headers.get('content-type') || '';
        if (contentType) res.set('Content-Type', contentType);
        if (response.status === 204) return res.end();
        if (contentType.includes('application/json') || contentType.startsWith('text/')) {
            res.send(await response.text());
        } else {
            res.send(Buffer.from(await response.arrayBuffer()));
        }
    } catch (err) {
        console.error('[cl-helper] Botbooru proxy error:', err.message);
        res.status(502).json({ error: 'Failed to reach Botbooru' });
    }
}

function registerBotbooruRoutes(router) {
    /**
     * POST /botbooru-login
     * Body: { username, password }
     *
     * Proxies Botbooru's form-encoded token login. Exists because ST's CORS
     * proxy re-serializes bodies as JSON, which this endpoint rejects (422).
     * Stateless: the token goes straight back to the client, nothing is
     * stored server-side.
     */
    router.post('/botbooru-login', async (req, res) => {
        const { username, password } = req.body ?? {};

        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        if (typeof username !== 'string' || typeof password !== 'string'
            || username.length > 256 || password.length > 256) {
            return res.status(400).json({ error: 'Invalid credentials format' });
        }

        try {
            const body = new URLSearchParams({ username, password }).toString();

            const response = await fetch(BOTBOORU_AUTH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });

            const text = await response.text();

            res.status(response.status);
            res.set('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            console.error('[cl-helper] Botbooru login proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Botbooru auth server' });
        }
    });

    // Authed botbooru proxy: injects the user's Bearer server-side to dodge ST's basic-auth gate.
    router.get('/botbooru-proxy/*', handleBotbooruProxy);
    router.post('/botbooru-proxy/*', handleBotbooruProxy);
    router.patch('/botbooru-proxy/*', handleBotbooruProxy);
    router.delete('/botbooru-proxy/*', handleBotbooruProxy);
}

// =============================================================================
// CharacterTavern: cookie session + read-only API proxy
// =============================================================================

// In-memory session store (cookies persist until logout or server restart).
let ctSessionCookies = null; // raw cookie header value, e.g. "session=VALUE"

// CT API paths the proxy is allowed to forward (read-only endpoints only).
const CT_ALLOWED_PATHS = [
    /^\/api\/search\/cards\b/,
    /^\/api\/character\/[^/]+\/[^/]+$/,
    /^\/api\/catalog\/top-tags$/,
];

function registerCharacterTavernRoutes(router) {
    /**
     * POST /ct-set-cookie
     * Body: { cookie: "session=VALUE" } or { cookie: "VALUE" }
     *
     * Stores the provided session cookie for use in proxied requests.
     * Only the `session` cookie is accepted; rejects input containing
     * multiple cookies or unexpected keys to limit stored scope.
     */
    router.post('/ct-set-cookie', async (req, res) => {
        const { cookie } = req.body ?? {};

        if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
            return res.status(400).json({ error: 'cookie string is required' });
        }

        let value = cookie.trim();

        // Normalize: accept bare value or session=VALUE
        if (value.startsWith('session=')) {
            value = value.slice('session='.length).trim();
        }

        // Reject if it looks like multiple cookies or contains suspicious characters
        if (value.includes(';') || value.length > 4096) {
            return res.status(400).json({ error: 'Invalid cookie value. Paste only the session cookie value.' });
        }

        if (!value) {
            return res.status(400).json({ error: 'Empty cookie value' });
        }

        ctSessionCookies = `session=${value}`;
        console.log('[cl-helper] CT session cookie stored');
        res.json({ ok: true });
    });

    /**
     * GET /ct-validate
     * Makes a test request to CT with stored cookies to verify they work.
     * Returns { valid: true/false }.
     */
    router.get('/ct-validate', async (_req, res) => {
        if (!ctSessionCookies) {
            return res.json({ valid: false, reason: 'no cookies stored' });
        }

        try {
            // Search a term that returns both SFW and NSFW results when authenticated
            const response = await fetch('https://character-tavern.com/api/search/cards?query=sara+lane&limit=5', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
                    'Accept': 'application/json',
                    'Cookie': ctSessionCookies,
                },
            });

            if (response.ok) {
                const data = await response.json();
                const hits = data?.hits || [];
                // Authenticated sessions return NSFW results (isNSFW=true, contentWarnings populated)
                const hasNsfw = hits.some(h => h.isNSFW === true);
                
                // Check if server rejected the cookie (by setting it to empty/expired)
                const setCookie = response.headers.get('set-cookie');
                const isRejected = setCookie && (setCookie.includes('session=;') || setCookie.includes('Max-Age=0'));
                
                if (isRejected) {
                    console.warn('[cl-helper] CT session rejected (Set-Cookie deletion detected)');
                    ctSessionCookies = null; // Clear our invalid cookie
                    res.json({ valid: false, reason: 'Session rejected/expired by server' });
                    return;
                }

                console.log(`[cl-helper] CT validate: ${hits.length} hits, totalHits=${data?.totalHits}, hasNSFW=${hasNsfw}`);
                res.json({ valid: true, hasNsfw });
            } else if (response.status === 403) {
                ctSessionCookies = null;
                res.json({ valid: false, reason: 'rejected (cookies expired or invalid)' });
            } else {
                res.json({ valid: false, reason: `HTTP ${response.status}` });
            }
        } catch (err) {
            console.error('[cl-helper] CT validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    /**
     * POST /ct-logout
     * Clears stored session cookies.
     */
    router.post('/ct-logout', (_req, res) => {
        ctSessionCookies = null;
        console.log('[cl-helper] CT session cleared');
        res.json({ ok: true });
    });

    /**
     * GET /ct-session
     * Returns whether a CT session is active.
     */
    router.get('/ct-session', (_req, res) => {
        res.json({ active: !!ctSessionCookies });
    });


    /**
     * GET /ct-proxy/*
     * Read-only proxy to character-tavern.com with stored session cookies.
     * Path-allowlisted to prevent abuse as an open relay.
     */
    router.get('/ct-proxy/*', async (req, res) => {
        const targetPath = '/' + req.params[0]; // everything after /ct-proxy/

        // Normalize and allowlist check: only known read-only API paths
        const normalizedPath = new URL(targetPath, 'https://character-tavern.com/').pathname;
        if (!CT_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] CT proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, 'https://character-tavern.com/');
        // Preserve query string from the original request
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        // Verify resolved URL still points at CT (prevents open-redirect via path tricks)
        if (targetUrl.hostname !== 'character-tavern.com') {
            return res.status(403).json({ error: 'Proxy target must be character-tavern.com' });
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
        };
        if (ctSessionCookies) {
            headers['Cookie'] = ctSessionCookies;
        }

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers,
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                const text = await response.text();
                res.send(text);
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] CT proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach CharacterTavern' });
        }
    });
}

// =============================================================================
// DataCat: token session + extraction + read-only API proxy
// =============================================================================

const DATACAT_BASE = 'https://datacat.run';
const DATACAT_ORIGIN = 'https://datacat.run';

let dcSessionToken = null;

function dcHeaders(token) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': DATACAT_ORIGIN,
        'Referer': DATACAT_ORIGIN + '/',
        'X-Session-Token': token,
    };
}

async function testDcToken(token) {
    const response = await fetch(`${DATACAT_BASE}/api/characters/recent-public?limit=1&offset=0&summary=1&minTotalTokens=889`, {
        headers: dcHeaders(token),
    });
    return response;
}

// Read-only API paths forwarded by /dc-proxy.
const DC_ALLOWED_PATHS = [
    /^\/api\/characters\/fresh\b/,
    /^\/api\/characters\/recent-public\b/,
    /^\/api\/characters\/[a-f0-9-]+$/,
    /^\/api\/characters\/[a-f0-9-]+\/download\b/,
    /^\/api\/creators\/[a-f0-9-]+$/,
    /^\/api\/creators\/[a-f0-9-]+\/characters\b/,
    /^\/api\/tags\/faceted\b/,
    /^\/api\/extraction\/status-projection$/,
];

// Resolve a usable public session ID for the extraction endpoint.
async function getPublicSessionId(token) {
    try {
        const resp = await fetch(`${DATACAT_BASE}/api/users`, {
            headers: dcHeaders(token),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const publicUser = (data.users || []).find(u => u.isPublic);
        if (!publicUser?.sessions) return null;
        // Pick a non-background, logged_in session
        const session = publicUser.sessions.find(
            s => s.purpose !== 'BACKGROUND_SCRAPER' && s.status === 'logged_in'
        );
        return session?.id || null;
    } catch {
        return null;
    }
}

function registerDataCatRoutes(router) {
    router.post('/dc-init', async (req, res) => {
        const { force } = req.body ?? {};

        // If we already have a token and not forcing refresh, verify it still works
        if (dcSessionToken && !force) {
            try {
                const check = await testDcToken(dcSessionToken);
                if (check.ok) {
                    return res.json({ ok: true, cached: true, token: dcSessionToken });
                }
            } catch { /* fall through to create new */ }
            dcSessionToken = null;
        }

        // Create anonymous session via the Liberator identify endpoint
        const deviceToken = randomUUID();
        try {
            const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': DATACAT_ORIGIN,
                    'Referer': DATACAT_ORIGIN + '/',
                },
                body: JSON.stringify({ deviceToken }),
            });

            if (!response.ok) {
                const text = await response.text();
                console.warn(`[cl-helper] DC identify failed: HTTP ${response.status}`);
                return res.json({ ok: false, reason: `identify returned ${response.status}: ${text.slice(0, 200)}` });
            }

            const data = await response.json();
            if (data?.success && data?.sessionToken) {
                dcSessionToken = data.sessionToken;
                console.log('[cl-helper] DC anonymous session initialized');
                return res.json({ ok: true, token: dcSessionToken });
            }

            console.warn('[cl-helper] DC identify returned unexpected shape:', JSON.stringify(data).slice(0, 300));
            res.json({ ok: false, reason: 'identify response missing sessionToken' });
        } catch (err) {
            console.error('[cl-helper] DC auto-init error:', err.message);
            res.json({ ok: false, reason: err.message });
        }
    });

    router.post('/dc-set-token', async (req, res) => {
        const { token } = req.body ?? {};

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: 'token string is required' });
        }

        const value = token.trim();
        if (value.length > 256) {
            return res.status(400).json({ error: 'Token too long' });
        }

        dcSessionToken = value;
        console.log('[cl-helper] DC session token stored');
        res.json({ ok: true });
    });

    router.post('/dc-clear-token', (_req, res) => {
        dcSessionToken = null;
        console.log('[cl-helper] DC session token cleared');
        res.json({ ok: true });
    });

    router.get('/dc-session', (_req, res) => {
        res.json({ active: !!dcSessionToken });
    });

    router.get('/dc-validate', async (_req, res) => {
        if (!dcSessionToken) {
            return res.json({ valid: false, reason: 'no token stored' });
        }

        try {
            const response = await testDcToken(dcSessionToken);

            if (response.ok) {
                const data = await response.json();
                const count = data?.totalCount || 0;
                console.log(`[cl-helper] DC validate: ${count} total chars available`);
                res.json({ valid: true, totalCount: count });
            } else {
                const text = await response.text();
                console.warn(`[cl-helper] DC validate failed: HTTP ${response.status}`);
                res.json({ valid: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` });
            }
        } catch (err) {
            console.error('[cl-helper] DC validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    // POST-only: submit extraction request to DataCat
    router.post('/dc-extract', async (req, res) => {
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const { url } = req.body ?? {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url string is required' });
        }
        if (url.length > 512) {
            return res.status(400).json({ error: 'URL too long' });
        }

        // Allow JanitorAI character URLs and Saucepan companion URLs
        let extractionKind = null;
        try {
            const parsed = new URL(url);
            const isJanitor = /^(www\.)?janitorai\.com$/i.test(parsed.hostname) || /^(www\.)?jannyai\.com$/i.test(parsed.hostname);
            const isSaucepan = /^(www\.)?saucepan\.ai$/i.test(parsed.hostname);
            if (!isJanitor && !isSaucepan) {
                return res.status(400).json({ error: 'Only JanitorAI or Saucepan character URLs are supported' });
            }
            if (isJanitor && !/^\/characters\/[a-f0-9-]{8,64}(_[\w-]+)?\/?$/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
            if (isSaucepan && !/^\/companion\/[a-f0-9-]{8,64}\/?$/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
            extractionKind = isSaucepan ? 'saucepan' : 'janitor';
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const requestId = randomUUID();
        const wantPublicFeed = req.body.publicFeed !== false;
        const alwaysReextract = req.body.alwaysReextract === true;

        // Resolve a public session ID when public feed is requested
        let sessionId = null;
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(dcSessionToken);
        }

        try {
            let endpoint, body;
            if (extractionKind === 'saucepan') {
                endpoint = `${DATACAT_BASE}/api/saucepan-extract/run`;
                body = {
                    companion: url,
                    sourceKind: 'one_off',
                    sourceRef: requestId,
                    includeSearch: true,
                    extractHidden: false,
                    idempotencyKey: requestId,
                    alwaysReextract,
                    vpnNamespace: 'general_scraper',
                    netnsRole: 'general_scraper',
                };
            } else {
                endpoint = `${DATACAT_BASE}/api/character/smart-extract-v2`;
                body = {
                    url,
                    openLoginIfNoSession: true,
                    sessionId,
                    appearOnPublicFeed: wantPublicFeed && !!sessionId,
                    useSeparateWorkerServer: true,
                    inlinePostExtractCreatorProfile: true,
                    idempotencyKey: requestId,
                    extractSourceMode: 'core_plus_janny',
                    alwaysReextract,
                };
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    ...dcHeaders(dcSessionToken),
                    'Content-Type': 'application/json',
                    'X-Request-Id': requestId,
                },
                body: JSON.stringify(body),
            });

            const data = await response.json();
            res.status(response.status).json(data);
        } catch (err) {
            console.error('[cl-helper] DC extract error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.get('/dc-proxy/*', async (req, res) => {
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const targetPath = '/' + req.params[0];

        const normalizedPath = new URL(targetPath, DATACAT_BASE).pathname;
        if (!DC_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] DC proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, DATACAT_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        if (targetUrl.hostname !== 'datacat.run') {
            return res.status(403).json({ error: 'Proxy target must be datacat.run' });
        }

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: dcHeaders(dcSessionToken),
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                res.send(await response.text());
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] DC proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });
}

// =============================================================================
// Imgchest: password-protected gallery unlock
// =============================================================================

const IMGCHEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function extractImgchestCookies(headers) {
    const result = { xsrfToken: null, session: null };
    const setCookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') || '').split(/,\s*(?=[A-Z])/);
    for (const sc of setCookies) {
        const xsrf = sc.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrf) result.xsrfToken = xsrf[1];
        const sess = sc.match(/image_chest_session=([^;]+)/);
        if (sess) result.session = sess[1];
    }
    return result;
}

function parseImgchestImages(html) {
    const match = html.match(/data-page="([^"]+)"/);
    if (!match) return [];
    try {
        const decoded = match[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#039;/g, "'");
        const data = JSON.parse(decoded);
        const files = data?.props?.post?.files;
        if (!Array.isArray(files)) return [];
        return files
            .filter(f => f.link && typeof f.link === 'string')
            .map(f => ({ url: f.link, filename: f.link.split('/').pop() }));
    } catch {
        return [];
    }
}

function registerImgchestRoutes(router) {
    /**
     * POST /imgchest-unlock
     * Body: { url: "https://imgchest.com/p/{id}", password: "..." }
     * Returns: { images: [{url, filename}] } or { error: "..." }
     *
     * Three-step flow:
     * 1. GET /p/{id}/validate: obtain XSRF + session cookies
     * 2. POST /p/{id}/validate: submit password, receive authenticated cookies
     * 3. GET /p/{id}: fetch unlocked page, extract images from data-page JSON
     */
    router.post('/imgchest-unlock', async (req, res) => {
        const { url, password } = req.body ?? {};

        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
        if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required' });
        if (url.length > 512) return res.status(400).json({ error: 'URL too long' });
        if (password.length > 256) return res.status(400).json({ error: 'Password too long' });

        let postId;
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== 'imgchest.com') {
                return res.status(400).json({ error: 'Only imgchest.com URLs are supported' });
            }
            const m = parsed.pathname.match(/^\/p\/([a-zA-Z0-9]+)/);
            if (!m) return res.status(400).json({ error: 'Invalid imgchest post URL' });
            postId = m[1];
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const validateUrl = `https://imgchest.com/p/${postId}/validate`;
        const postUrl = `https://imgchest.com/p/${postId}`;

        try {
            const step1 = await fetch(validateUrl, {
                headers: { 'User-Agent': IMGCHEST_UA, 'Accept': 'text/html' },
            });
            if (!step1.ok) {
                return res.json({ error: `Validate page returned HTTP ${step1.status}` });
            }

            const cookies1 = extractImgchestCookies(step1.headers);
            if (!cookies1.xsrfToken || !cookies1.session) {
                return res.json({ error: 'Failed to obtain session from imgchest' });
            }

            const html1 = await step1.text();
            let inertiaVersion = '';
            const dataPageMatch = html1.match(/data-page="([^"]+)"/);
            if (dataPageMatch) {
                const decoded = dataPageMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                const vm = decoded.match(/"version":"([^"]+)"/);
                if (vm) inertiaVersion = vm[1];
            }

            // POST the password, expecting a 302 redirect on success.
            const step2 = await fetch(validateUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': IMGCHEST_UA,
                    'Content-Type': 'application/json',
                    'Accept': 'text/html, application/xhtml+xml',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-Inertia': 'true',
                    ...(inertiaVersion ? { 'X-Inertia-Version': inertiaVersion } : {}),
                    'X-XSRF-TOKEN': decodeURIComponent(cookies1.xsrfToken),
                    'Cookie': `XSRF-TOKEN=${cookies1.xsrfToken}; image_chest_session=${cookies1.session}`,
                    'Origin': 'https://imgchest.com',
                    'Referer': validateUrl,
                },
                body: JSON.stringify({ password }),
                redirect: 'manual',
            });

            if (step2.status === 422) {
                return res.json({ error: 'Wrong password' });
            }
            if (step2.status !== 302) {
                await step2.text().catch(() => {});
                return res.json({ error: `Password validation failed (HTTP ${step2.status})` });
            }

            const cookies2 = extractImgchestCookies(step2.headers);
            const finalXsrf = cookies2.xsrfToken || cookies1.xsrfToken;
            const finalSession = cookies2.session || cookies1.session;

            // Re-fetch the post page now that we hold authenticated cookies.
            const step3 = await fetch(postUrl, {
                headers: {
                    'User-Agent': IMGCHEST_UA,
                    'Accept': 'text/html',
                    'Cookie': `XSRF-TOKEN=${finalXsrf}; image_chest_session=${finalSession}`,
                },
            });

            if (!step3.ok) {
                return res.json({ error: `Failed to fetch unlocked post (HTTP ${step3.status})` });
            }

            const images = parseImgchestImages(await step3.text());
            if (images.length === 0) {
                return res.json({ error: 'No images found after password validation' });
            }

            console.log(`[cl-helper] Imgchest unlocked ${postId}: ${images.length} images`);
            res.json({ images });
        } catch (err) {
            console.error('[cl-helper] Imgchest unlock error:', err.message);
            res.status(502).json({ error: 'Failed to reach imgchest' });
        }
    });
}

// =============================================================================
// Civitai: gallery extractor auth + read-only API proxy
// =============================================================================

const CIVITAI_HOSTS = new Set(['civitai.com', 'civitai.red']);
const CIVITAI_ALLOWED_PATHS = [
    /^\/api\/v1\/images\/?$/,
    /^\/api\/v1\/images\/[a-zA-Z0-9_-]+\/?$/,
    /^\/posts\/[0-9]+\/?$/,
    /^\/images\/[0-9]+\/?$/,
];
const CIVITAI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let civitaiApiKey = null;

function registerCivitaiRoutes(router) {
    router.post('/civitai-set-key', (req, res) => {
        const { key } = req.body ?? {};
        if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required' });
        if (key.length > 256) return res.status(400).json({ error: 'key too long' });
        civitaiApiKey = key.trim();
        console.log('[cl-helper] Civitai API key stored');
        res.json({ ok: true });
    });

    router.post('/civitai-clear-key', (_req, res) => {
        civitaiApiKey = null;
        res.json({ ok: true });
    });

    router.get('/civitai-session', (_req, res) => {
        res.json({ active: !!civitaiApiKey });
    });

    router.get('/civitai-validate', async (_req, res) => {
        if (!civitaiApiKey) return res.json({ valid: false, error: 'No API key configured' });
        try {
            const response = await fetch('https://civitai.com/api/v1/models?limit=1', {
                headers: {
                    'Authorization': `Bearer ${civitaiApiKey}`,
                    'User-Agent': CIVITAI_UA,
                    'Accept': 'application/json',
                },
            });
            res.json({ valid: response.ok, status: response.status });
        } catch (err) {
            console.error('[cl-helper] Civitai validate error:', err.message);
            res.status(502).json({ valid: false, error: 'Failed to reach Civitai' });
        }
    });

    router.get('/civitai-proxy/:host/*', async (req, res) => {
        const host = req.params.host;
        if (!CIVITAI_HOSTS.has(host)) {
            return res.status(400).json({ error: 'host must be civitai.com or civitai.red' });
        }

        const targetPath = '/' + req.params[0];
        const base = `https://${host}`;
        const normalizedPath = new URL(targetPath, base).pathname;
        if (!CIVITAI_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] Civitai proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, base);
        targetUrl.search = new URL(req.url, 'http://localhost').search;

        if (!CIVITAI_HOSTS.has(targetUrl.hostname)) {
            return res.status(403).json({ error: 'Proxy target must be civitai.com or civitai.red' });
        }

        const headers = {
            'User-Agent': CIVITAI_UA,
            'Accept': targetPath.startsWith('/api/') ? 'application/json' : 'text/html',
        };
        if (civitaiApiKey) headers['Authorization'] = `Bearer ${civitaiApiKey}`;

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers,
                redirect: 'follow',
            });

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                res.send(await response.text());
            } else if (contentType.includes('text/')) {
                res.send(await response.text());
            } else {
                const buffer = Buffer.from(await response.arrayBuffer());
                res.send(buffer);
            }
        } catch (err) {
            console.error('[cl-helper] Civitai proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Civitai' });
        }
    });
}

// =============================================================================
// Saucepan: read-only API proxy. Handles zstd-encoded responses that ST's
// /proxy/ forwards without Content-Encoding (browser can't decode them).
// Negotiates gzip/deflate/br with Saucepan; Node native zstd is fallback.
// =============================================================================

const SAUCEPAN_HOSTNAME = 'saucepan.ai';
const SAUCEPAN_BASE = 'https://saucepan.ai';
const SAUCEPAN_ORIGIN = 'https://saucepan.ai';
const SAUCEPAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const SAUCEPAN_MAX_BYTES = 10 * 1024 * 1024;
const SAUCEPAN_ALLOWED_PATHS = [
    /^\/api\/v1\/search$/,
    /^\/api\/v1\/companions-of-user$/,
    /^\/api\/v1\/companion$/,
    /^\/api\/v1\/companion\/definition$/,
    /^\/cdn\/.+$/,
];
const SAUCEPAN_POST_PATH = '/api/v1/search';
const SAUCEPAN_MAX_SEARCH_LEN = 500;
const SAUCEPAN_MAX_TAG_LEN = 64;
const SAUCEPAN_MAX_TAGS = 100;
const SAUCEPAN_MAX_DATE_LEN = 30;
const SAUCEPAN_MAX_ORDER_LEN = 32;

let saucepanToken = null;

function saucepanHeaders(token) {
    const headers = {
        'User-Agent': SAUCEPAN_UA,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        Origin: SAUCEPAN_ORIGIN,
        Referer: SAUCEPAN_ORIGIN + '/',
        'x-saucepan-client-version': '1',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

// The search endpoint is anonymous, so it cannot prove a token is valid.
// The definition endpoint requires auth: grab any open-definition companion
// id via search, then request its definition with the token under test.
async function testSaucepanToken(token) {
    // The search endpoint 422s unless every field is present.
    const searchResp = await fetch(`${SAUCEPAN_BASE}/api/v1/search`, {
        method: 'POST',
        headers: { ...saucepanHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text_search: null,
            tags: [],
            excluded_tags: [],
            fandom_tags: [],
            excluded_fandom_tags: [],
            match_all_fandom_tags: false,
            match_all_tags: true,
            limit: 1,
            offset: 0,
            sus: true,
            extra_spicy: null,
            order_by: 'created',
            asc: false,
            posted_at_from: null,
            posted_at_to: null,
            hide_hidden_content: false,
            open_definition_only: true,
        }),
    });
    if (!searchResp.ok) throw new Error(`Saucepan search HTTP ${searchResp.status} while validating token`);
    const searchData = JSON.parse(await readSaucepanBody(searchResp));
    const companionId = searchData?.companions?.[0]?.id;
    if (!companionId) throw new Error('No companion available to validate token against');

    return fetch(`${SAUCEPAN_BASE}/api/v1/companion/definition?companion_id=${encodeURIComponent(companionId)}`, {
        method: 'GET',
        headers: {
            ...saucepanHeaders(token),
            Referer: `${SAUCEPAN_ORIGIN}/companion/${companionId}`,
        },
    });
}

function sanitizeSaucepanSearchBody(input) {
    if (!input || typeof input !== 'object') return null;

    const asString = (v, max) => (typeof v === 'string' && v.length <= max) ? v : null;
    const asStringOrNull = (v, max) => v === null ? null : asString(v, max);
    const asBool = (v) => typeof v === 'boolean' ? v : false;
    const asBoolOrNull = (v) => v === null ? null : asBool(v);
    const asTagArray = (v) => Array.isArray(v)
        ? v.filter(t => typeof t === 'string' && t.length <= SAUCEPAN_MAX_TAG_LEN).slice(0, SAUCEPAN_MAX_TAGS)
        : [];
    const asInt = (v, min, max) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= min && n <= max ? n : null;
    };

    const limit = asInt(input.limit, 1, 200);
    const offset = asInt(input.offset, 0, 100000);
    if (limit === null || offset === null) return null;

    return {
        text_search: asStringOrNull(input.text_search, SAUCEPAN_MAX_SEARCH_LEN),
        tags: asTagArray(input.tags),
        excluded_tags: asTagArray(input.excluded_tags),
        fandom_tags: asTagArray(input.fandom_tags),
        excluded_fandom_tags: asTagArray(input.excluded_fandom_tags),
        match_all_fandom_tags: asBool(input.match_all_fandom_tags),
        match_all_tags: asBool(input.match_all_tags),
        limit,
        offset,
        sus: asBool(input.sus),
        extra_spicy: asBoolOrNull(input.extra_spicy),
        order_by: asString(input.order_by, SAUCEPAN_MAX_ORDER_LEN) || 'created',
        asc: asBool(input.asc),
        posted_at_from: asStringOrNull(input.posted_at_from, SAUCEPAN_MAX_DATE_LEN),
        posted_at_to: asStringOrNull(input.posted_at_to, SAUCEPAN_MAX_DATE_LEN),
        hide_hidden_content: asBool(input.hide_hidden_content),
        open_definition_only: asBool(input.open_definition_only),
    };
}

let _zstdDecompressAsync = null;
function getZstdDecompressAsync() {
    if (_zstdDecompressAsync) return _zstdDecompressAsync;
    if (typeof zlib.zstdDecompress !== 'function') {
        throw new Error('node:zlib zstdDecompress unavailable: requires Node >= 22.15. Upstream returned zstd; upgrade Node or ensure server respects Accept-Encoding: gzip, deflate, br.');
    }
    _zstdDecompressAsync = promisify(zlib.zstdDecompress);
    return _zstdDecompressAsync;
}

async function readSaucepanBody(response) {
    const ce = (response.headers.get('content-encoding') || '').toLowerCase();
    if (ce.includes('zstd')) {
        const compressed = Buffer.from(await response.arrayBuffer());
        const decoded = await getZstdDecompressAsync()(compressed, { maxOutputLength: SAUCEPAN_MAX_BYTES });
        return decoded.toString('utf8');
    }
    const text = await response.text();
    if (text.length > SAUCEPAN_MAX_BYTES) {
        throw new Error(`Saucepan response exceeded ${SAUCEPAN_MAX_BYTES} bytes`);
    }
    return text;
}

// Saucepan ships companion definitions as a shuffled fragment list padded
// with decoy fragments, to frustrate naive scrapers (a plain text-join yields
// garbled prose). Each real fragment carries a `proof` hash; decoys don't
// validate. Reassembly (ported verbatim from Saucepan's own web bundle):
//   1. keep only fragments whose proof matches hash(mask, key^mask, text)
//   2. order the survivors by (key ^ mask) ascending
//   3. concatenate their text
// The hash is FNV-1a over the UTF-8 text, seeded from the mask and derived key.
const SAUCEPAN_FNV_OFFSET = 2166136261;
const SAUCEPAN_FNV_PRIME = 16777619;

function saucepanRotl(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function saucepanFragmentHash(mask, derivedKey, text) {
    const bytes = new TextEncoder().encode(text);
    let h = (SAUCEPAN_FNV_OFFSET ^ saucepanRotl(mask, 7) ^ saucepanRotl(derivedKey, 13)) >>> 0;
    for (const b of bytes) {
        h ^= b;
        h = Math.imul(h, SAUCEPAN_FNV_PRIME) >>> 0;
    }
    return h >>> 0;
}

function assembleSaucepanFragments(content) {
    const fragments = Array.isArray(content?.fragments) ? content.fragments : [];
    const mask = (content?.mask ?? 0) >>> 0;
    return fragments
        .filter(f => {
            if (!f || typeof f.text !== 'string') return false;
            const derivedKey = (f.key ^ mask) >>> 0;
            return saucepanFragmentHash(mask, derivedKey, f.text) === (f.proof >>> 0);
        })
        .sort((a, b) => ((a.key ^ mask) >>> 0) - ((b.key ^ mask) >>> 0))
        .map(f => f.text)
        .join('');
}

// GET a Saucepan JSON endpoint with auth, decoding the (possibly zstd) body.
// Returns { ok, status, data } with data === null on non-JSON responses.
async function fetchSaucepanJson(path, token, companionId) {
    const response = await fetch(`${SAUCEPAN_BASE}${path}`, {
        method: 'GET',
        headers: {
            ...saucepanHeaders(token),
            Referer: `${SAUCEPAN_ORIGIN}/companion/${companionId}`,
        },
    });
    const text = await readSaucepanBody(response);
    let data = null;
    try { data = JSON.parse(text); } catch { /* leave null */ }
    return { ok: response.ok, status: response.status, data };
}

function registerSaucepanRoutes(router) {
    // Saucepan auth: password login
    router.post('/saucepan-login', async (req, res) => {
        const { handle, password } = req.body ?? {};
        if (!handle || typeof handle !== 'string' || !password || typeof password !== 'string') {
            return res.status(400).json({ error: 'handle and password are required' });
        }
        if (handle.length > 64 || password.length > 128) {
            return res.status(400).json({ error: 'handle or password too long' });
        }

        try {
            const response = await fetch(`${SAUCEPAN_BASE}/api/v1/auth/sign_in_password`, {
                method: 'POST',
                headers: {
                    ...saucepanHeaders(),
                    'Content-Type': 'application/json',
                    Referer: `${SAUCEPAN_ORIGIN}/sign-in`,
                },
                body: JSON.stringify({ handle: handle.trim(), password }),
            });

            let data = {};
            try {
                data = JSON.parse(await readSaucepanBody(response));
            } catch { /* non-JSON error body */ }
            if (!response.ok) {
                const msg = data?.error?.message || `HTTP ${response.status}`;
                return res.status(response.status).json({ ok: false, error: msg });
            }

            const token = data?.token || data?.access_token || data?.session_token || data?.sessionToken;
            if (!token) {
                return res.status(502).json({ ok: false, error: 'Login succeeded but no token was returned' });
            }

            saucepanToken = token;
            console.log('[cl-helper] Saucepan login succeeded');
            res.json({ ok: true, token });
        } catch (err) {
            console.error('[cl-helper] Saucepan login error:', err.message);
            res.status(502).json({ ok: false, error: err.message });
        }
    });

    // Store a user-provided Saucepan token
    router.post('/saucepan-set-token', async (req, res) => {
        const { token } = req.body ?? {};
        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: 'token string is required' });
        }
        if (token.length > 2048) {
            return res.status(400).json({ error: 'Token too long' });
        }
        saucepanToken = token.trim();
        console.log('[cl-helper] Saucepan token stored');
        res.json({ ok: true });
    });

    // Clear stored Saucepan token
    router.post('/saucepan-clear-token', (_req, res) => {
        saucepanToken = null;
        console.log('[cl-helper] Saucepan token cleared');
        res.json({ ok: true });
    });

    // Validate stored Saucepan token
    router.get('/saucepan-validate', async (_req, res) => {
        if (!saucepanToken) {
            return res.json({ valid: false, reason: 'no token stored' });
        }
        try {
            const response = await testSaucepanToken(saucepanToken);
            if (response.ok) {
                res.json({ valid: true });
            } else {
                const text = await readSaucepanBody(response).catch(() => '');
                console.warn(`[cl-helper] Saucepan validate failed: HTTP ${response.status}`);
                res.json({ valid: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` });
            }
        } catch (err) {
            console.error('[cl-helper] Saucepan validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    // Native Saucepan extraction: reassemble the companion's obfuscated
    // fragments into a usable card. Pulls two endpoints:
    //   /api/v1/companion/definition -> named prose sections (body, example
    //     dialogue, advanced prompt, response formatting)
    //   /api/v2/companions/{id}      -> starting scenarios (the greetings that
    //     become first_mes / alternate_greetings; absent from the definition)
    router.post('/saucepan-extract', async (req, res) => {
        const bodyToken = typeof req.body?.token === 'string' && req.body.token.length <= 2048
            ? req.body.token.trim()
            : null;
        const token = bodyToken || saucepanToken;
        if (!token) {
            return res.status(401).json({ error: 'No Saucepan token configured' });
        }

        const { url } = req.body ?? {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url string is required' });
        }
        if (url.length > 512) {
            return res.status(400).json({ error: 'URL too long' });
        }

        let companionId;
        try {
            const parsed = new URL(url);
            if (!/^(www\.)?saucepan\.ai$/i.test(parsed.hostname)) {
                return res.status(400).json({ error: 'Only Saucepan companion URLs are supported' });
            }
            const m = parsed.pathname.match(/^\/companion\/([a-f0-9-]{8,64})\/?$/i);
            if (!m) {
                return res.status(400).json({ error: 'Invalid companion URL path' });
            }
            companionId = m[1];
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        try {
            const [defRes, compRes] = await Promise.all([
                fetchSaucepanJson(`/api/v1/companion/definition?companion_id=${encodeURIComponent(companionId)}`, token, companionId),
                fetchSaucepanJson(`/api/v2/companions/${encodeURIComponent(companionId)}`, token, companionId),
            ]);

            // The definition endpoint is authoritative; surface its auth errors.
            if (!defRes.ok) {
                const msg = defRes.data?.error?.message || `Saucepan HTTP ${defRes.status}`;
                return res.status(defRes.status).json({ error: msg });
            }
            if (!defRes.data) {
                return res.status(502).json({ error: 'Invalid JSON from Saucepan' });
            }

            // Reassemble each definition section's shuffled fragments back into
            // prose, dropping the decoy fragments Saucepan injects (see
            // assembleSaucepanFragments).
            const sections = Array.isArray(defRes.data.sections) ? defRes.data.sections : [];
            const assembled = {};
            for (const section of sections) {
                const title = section?.title;
                const content = section?.content;
                if (!title || !content) continue;
                assembled[title] = assembleSaucepanFragments(content);
            }

            const companion = compRes.data?.companion || null;
            if (!compRes.ok || !companion) {
                console.warn(`[cl-helper] Saucepan extract: greetings unavailable (companions/${companionId} HTTP ${compRes.status})`);
            }

            // Greetings live only on the v2 companion object as starting
            // scenarios; each scenario message is fragment-obfuscated too.
            const greetings = [];
            const scenarios = Array.isArray(companion?.starting_scenarios_fragments)
                ? companion.starting_scenarios_fragments
                : [];
            for (const scenario of scenarios) {
                const text = assembleSaucepanFragments(scenario?.message);
                if (text && text.trim()) {
                    greetings.push({ title: typeof scenario?.title === 'string' ? scenario.title : '', text });
                }
            }

            // Fall back to the v2 body if the definition lacked Companion Core.
            if (!assembled['Companion Core'] && companion?.full_description_fragments) {
                assembled['Companion Core'] = assembleSaucepanFragments(companion.full_description_fragments);
            }

            res.json({ success: true, companionId, assembled, greetings });
        } catch (err) {
            console.error('[cl-helper] Saucepan extract error:', err.message);
            res.status(502).json({ error: `Failed to reach Saucepan: ${err.message}` });
        }
    });

    const handleProxy = async (req, res) => {
        const targetPath = '/' + req.params[0];
        const normalizedPath = new URL(targetPath, SAUCEPAN_BASE).pathname;
        if (!SAUCEPAN_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            console.warn(`[cl-helper] Saucepan proxy blocked: ${normalizedPath}`);
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, SAUCEPAN_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;
        if (targetUrl.hostname !== SAUCEPAN_HOSTNAME) {
            return res.status(403).json({ error: `Proxy target must be ${SAUCEPAN_HOSTNAME}` });
        }

        const isCdn = normalizedPath.startsWith('/cdn/');
        const isPost = req.method === 'POST';
        let bodyStr = null;
        if (isPost) {
            if (normalizedPath !== SAUCEPAN_POST_PATH) {
                return res.status(400).json({ error: 'POST not allowed for this path' });
            }
            const sanitized = sanitizeSaucepanSearchBody(req.body);
            if (!sanitized) {
                return res.status(400).json({ error: 'Invalid search body' });
            }
            bodyStr = JSON.stringify(sanitized);
        }

        const headers = {
            'User-Agent': SAUCEPAN_UA,
            'Accept': isCdn ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : '*/*',
            // Deliberately omits zstd: undici auto-decompresses gzip/deflate/br,
            // and Saucepan should respect the negotiated encoding. The zstd
            // fallback in readSaucepanBody covers servers that ignore us.
            'Accept-Encoding': 'gzip, deflate, br',
            'Origin': SAUCEPAN_ORIGIN,
            'Referer': SAUCEPAN_ORIGIN + '/',
            'x-saucepan-client-version': '1',
        };
        if (isPost) headers['Content-Type'] = 'application/json';
        if (saucepanToken && !isCdn) headers['Authorization'] = `Bearer ${saucepanToken}`;

        try {
            const response = await fetch(targetUrl.toString(), {
                method: req.method,
                headers,
                body: bodyStr ?? undefined,
                redirect: 'follow',
            });

            // CDN images: return binary bytes straight back; do not run through
            // the zstd/text reader used for API responses.
            if (isCdn) {
                const contentLength = parseInt(response.headers.get('content-length'), 10);
                if (contentLength > SAUCEPAN_MAX_BYTES) {
                    return res.status(413).json({ error: 'Saucepan image too large' });
                }
                const buf = Buffer.from(await response.arrayBuffer());
                if (buf.length > SAUCEPAN_MAX_BYTES) {
                    return res.status(413).json({ error: 'Saucepan image too large' });
                }
                res.status(response.status);
                res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
                // Saucepan serves images immutable; keeping its cache headers
                // stops the browser re-requesting every avatar through us.
                const cacheControl = response.headers.get('cache-control');
                if (cacheControl) res.set('Cache-Control', cacheControl);
                return res.send(buf);
            }

            const text = await readSaucepanBody(response);
            res.status(response.status);
            res.set('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            console.error('[cl-helper] Saucepan proxy error:', err.message);
            res.status(502).json({ error: `Failed to reach Saucepan: ${err.message}` });
        }
    };

    router.get('/saucepan-proxy/*', handleProxy);
    router.post('/saucepan-proxy/*', handleProxy);
}

// =============================================================================
// Dropbox: GET-only proxy for public folder/file share page HTML
// =============================================================================
//
// ST's built-in /proxy/ sends Dropbox a request shape (UA, accept) that
// returns HTTP 400. The folder share page is needed to extract the embedded
// file-list blob; image bytes themselves come from per-file URLs handled by
// the regular media downloader. Browser-shaped headers fix the 400.

const DROPBOX_HOSTNAME = 'www.dropbox.com';
const DROPBOX_BASE = 'https://www.dropbox.com';
const DROPBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DROPBOX_MAX_BYTES = 5 * 1024 * 1024;
const DROPBOX_ALLOWED_PATHS = [
    /^\/scl\/fo\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/,
    /^\/scl\/fi\/[A-Za-z0-9_-]+\/[^/]+$/,
];

function registerDropboxRoutes(router) {
    router.get('/dropbox-proxy/*', async (req, res) => {
        const targetPath = '/' + req.params[0];
        const normalizedPath = new URL(targetPath, DROPBOX_BASE).pathname;
        if (!DROPBOX_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
            return res.status(403).json({ error: 'Proxy path not allowed' });
        }

        const targetUrl = new URL(targetPath, DROPBOX_BASE);
        targetUrl.search = new URL(req.url, 'http://localhost').search;
        if (targetUrl.hostname !== DROPBOX_HOSTNAME) {
            return res.status(403).json({ error: `Proxy target must be ${DROPBOX_HOSTNAME}` });
        }

        try {
            const response = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: {
                    'User-Agent': DROPBOX_UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                },
                redirect: 'follow',
            });
            const text = await response.text();
            if (!response.ok) {
                console.warn(`[cl-helper] Dropbox returned HTTP ${response.status} for ${targetUrl.toString()}`);
                console.warn(`[cl-helper] Dropbox response body (first 500 chars): ${text.slice(0, 500)}`);
            }
            if (text.length > DROPBOX_MAX_BYTES) {
                return res.status(502).json({ error: `Dropbox response exceeded ${DROPBOX_MAX_BYTES} bytes` });
            }
            res.status(response.status);
            res.set('Content-Type', response.headers.get('content-type') || 'text/html; charset=utf-8');
            res.send(text);
        } catch (err) {
            console.error('[cl-helper] Dropbox proxy error:', err.message);
            res.status(502).json({ error: `Failed to reach Dropbox: ${err.message}` });
        }
    });
}

// =============================================================================
// FlareSolverr: thin POST forwarder for Cloudflare-protected endpoints
// =============================================================================
//
// FlareSolverr (https://github.com/FlareSolverr/FlareSolverr) is a user-run
// service that uses a real Chromium instance to bypass Cloudflare bot
// challenges. It does not emit CORS headers by default, so the browser
// cannot call it directly - we forward the request through here.
//
// This route is a stateless thin POST forwarder. The caller supplies both
// the FlareSolverr endpoint URL and the target URL. We do not store the
// FlareSolverr URL server-side; it is always provided per-request.

const FLARESOLVERR_MAX_TARGET_LENGTH = 1024;
const FLARESOLVERR_TIMEOUT_MS = 90_000;

// Allowlist of upstreams FlareSolverr is allowed to fetch on behalf of CL.
// Matches the hostname-plus-path-regex pattern used by other cl-helper proxies.
const FLARESOLVERR_TARGET_ALLOWLIST = [
    { hostname: 'janitorai.com', pathPattern: /^\/hampter\/characters\/?$/ },
];

function validateFlareTargetUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return FLARESOLVERR_TARGET_ALLOWLIST.some(({ hostname, pathPattern }) =>
        parsed.hostname === hostname && pathPattern.test(parsed.pathname)
    );
}

function validateFlareUrl(flareUrl) {
    if (!flareUrl || typeof flareUrl !== 'string' || flareUrl.length > 256) {
        return { error: 'flareUrl is required' };
    }
    let parsed;
    try { parsed = new URL(flareUrl); } catch { return { error: 'Invalid flareUrl' }; }
    if (!/^https?:$/.test(parsed.protocol)) {
        return { error: 'flareUrl must be http or https' };
    }
    return { url: parsed.toString() };
}

async function postToFlareSolverr(flareUrl, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLARESOLVERR_TIMEOUT_MS + 5000);
    try {
        const response = await fetch(flareUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await response.json().catch(() => null);
        return { response, data };
    } finally {
        clearTimeout(timer);
    }
}

function registerFlareSolverrRoutes(router) {
    router.post('/flaresolverr-fetch', async (req, res) => {
        const { flareUrl, targetUrl, sessionId } = req.body ?? {};

        const flareCheck = validateFlareUrl(flareUrl);
        if (flareCheck.error) return res.status(400).json({ error: flareCheck.error });

        if (!targetUrl || typeof targetUrl !== 'string') {
            return res.status(400).json({ error: 'targetUrl is required' });
        }
        if (targetUrl.length > FLARESOLVERR_MAX_TARGET_LENGTH) {
            return res.status(400).json({ error: 'targetUrl too long' });
        }
        if (!validateFlareTargetUrl(targetUrl)) {
            return res.status(403).json({ error: 'targetUrl not in allowlist' });
        }

        const body = {
            cmd: 'request.get',
            url: targetUrl,
            maxTimeout: FLARESOLVERR_TIMEOUT_MS,
        };
        if (sessionId && typeof sessionId === 'string' && sessionId.length <= 128) {
            body.session = sessionId;
        }

        try {
            const { response, data } = await postToFlareSolverr(flareCheck.url, body);
            if (!data) {
                return res.status(502).json({ error: 'FlareSolverr returned non-JSON response' });
            }
            res.status(response.ok ? 200 : 502).json(data);
        } catch (err) {
            console.error('[cl-helper] FlareSolverr forward error:', err.message);
            const message = err.name === 'AbortError'
                ? 'FlareSolverr timed out'
                : `Failed to reach FlareSolverr: ${err.message}`;
            res.status(502).json({ error: message });
        }
    });

    router.post('/flaresolverr-session-create', async (req, res) => {
        const { flareUrl, sessionId } = req.body ?? {};
        const flareCheck = validateFlareUrl(flareUrl);
        if (flareCheck.error) return res.status(400).json({ error: flareCheck.error });

        const body = { cmd: 'sessions.create' };
        if (sessionId && typeof sessionId === 'string' && sessionId.length <= 128) {
            body.session = sessionId;
        }

        try {
            const { response, data } = await postToFlareSolverr(flareCheck.url, body);
            if (!data) {
                return res.status(502).json({ error: 'FlareSolverr returned non-JSON response' });
            }
            res.status(response.ok ? 200 : 502).json(data);
        } catch (err) {
            console.error('[cl-helper] FlareSolverr session-create error:', err.message);
            const message = err.name === 'AbortError'
                ? 'FlareSolverr timed out'
                : `Failed to reach FlareSolverr: ${err.message}`;
            res.status(502).json({ error: message });
        }
    });

    router.post('/flaresolverr-session-destroy', async (req, res) => {
        const { flareUrl, sessionId } = req.body ?? {};
        const flareCheck = validateFlareUrl(flareUrl);
        if (flareCheck.error) return res.status(400).json({ error: flareCheck.error });

        if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        try {
            const { response, data } = await postToFlareSolverr(flareCheck.url, {
                cmd: 'sessions.destroy',
                session: sessionId,
            });
            if (!data) {
                return res.status(502).json({ error: 'FlareSolverr returned non-JSON response' });
            }
            res.status(response.ok ? 200 : 502).json(data);
        } catch (err) {
            console.error('[cl-helper] FlareSolverr session-destroy error:', err.message);
            const message = err.name === 'AbortError'
                ? 'FlareSolverr timed out'
                : `Failed to reach FlareSolverr: ${err.message}`;
            res.status(502).json({ error: message });
        }
    });
}

// =============================================================================
// Plugin entry
// =============================================================================

/**
 * @param {import('express').Router} router
 */
// Files installed by /self-update. Add here if the bundle grows; nothing else lands on disk.
const _SELF_UPDATE_FILES = ['package.json', 'index.js'];
const _SELF_UPDATE_MAX_BYTES = 2 * 1024 * 1024;
const _SELF_UPDATE_VERSION_RE = /^[\w.\-+]{1,32}$/;
let _selfUpdateInFlight = false;

// Find bundled cl-helper dirs under the requesting user's extensions folder; scoping to the active user disambiguates multi-user setups.
async function findBundledClHelperDirs(userExtDir) {
    if (!userExtDir) return [];
    let extNames;
    try { extNames = await readdir(userExtDir); }
    catch { return []; }
    const matches = [];
    for (const ext of extNames) {
        const candidate = join(userExtDir, ext, 'extras', 'cl-helper');
        try {
            const pkgContent = await readFile(join(candidate, 'package.json'), 'utf-8');
            const pkg = JSON.parse(pkgContent);
            if (pkg?.name === 'cl-helper' && typeof pkg?.version === 'string' && _SELF_UPDATE_VERSION_RE.test(pkg.version)) {
                matches.push({ path: candidate, version: pkg.version });
            }
        } catch {}
    }
    return matches;
}

export async function init(router) {
    router.get('/health', (req, res) => {
        const auth = req.headers.authorization;
        res.json({
            ok: true,
            version: _runningVersion,
            thumbnails: _thumbsReady,
            linked: _isLinkedInstall,
            installPath: __dirname,
            admin: !!req.user?.profile?.admin,
            basicAuth: typeof auth === 'string' && auth.startsWith('Basic '),
        });
    });

    // Server-side fetch: request body ignored, source comes from the bundled folder on disk. Admin-only since it rewrites plugin code.
    router.post('/self-update', async (req, res) => {
        if (!req.user?.profile?.admin) {
            return res.status(403).json({ ok: false, error: 'admin privilege required to update cl-helper' });
        }
        if (_isLinkedInstall) {
            return res.status(400).json({ ok: false, error: 'plugin folder is symlinked; restart SillyTavern to load changes' });
        }
        if (_selfUpdateInFlight) {
            return res.status(409).json({ ok: false, error: 'self-update already in progress' });
        }
        _selfUpdateInFlight = true;
        try {
            const userExtDir = req.user?.directories?.extensions;
            if (!userExtDir) {
                return res.status(500).json({ ok: false, error: 'no user extensions directory in request context' });
            }
            const matches = await findBundledClHelperDirs(userExtDir);
            if (matches.length === 0) {
                return res.status(404).json({ ok: false, error: `no cl-helper bundle found under ${userExtDir}; fall back to manual copy` });
            }
            if (matches.length > 1) {
                return res.status(400).json({ ok: false, error: `multiple cl-helper bundles found (${matches.map(m => m.path).join(' | ')}); resolve before retrying` });
            }
            const source = matches[0];
            const sourceFiles = {};
            for (const name of _SELF_UPDATE_FILES) {
                let content;
                try { content = await readFile(join(source.path, name), 'utf-8'); }
                catch (e) {
                    return res.status(500).json({ ok: false, error: `failed to read source ${name}: ${e.message}` });
                }
                if (Buffer.byteLength(content, 'utf-8') > _SELF_UPDATE_MAX_BYTES) {
                    return res.status(400).json({ ok: false, error: `source ${name}: exceeds size cap` });
                }
                if (content.indexOf('\0') !== -1) {
                    return res.status(400).json({ ok: false, error: `source ${name}: contains null bytes` });
                }
                sourceFiles[name] = content;
            }
            // Sanity-check the bundled package.json (defense-in-depth: even if extras/ was tampered, refuse the obviously-wrong shapes).
            let parsedPkg;
            try { parsedPkg = JSON.parse(sourceFiles['package.json']); }
            catch { return res.status(400).json({ ok: false, error: 'source package.json is not valid JSON' }); }
            if (parsedPkg?.name !== 'cl-helper') {
                return res.status(400).json({ ok: false, error: `source package.json name must be 'cl-helper'` });
            }
            if (typeof parsedPkg?.version !== 'string' || !_SELF_UPDATE_VERSION_RE.test(parsedPkg.version)) {
                return res.status(400).json({ ok: false, error: 'source package.json version missing or malformed' });
            }
            // Refuse pre-planted symlinks: write to a random .tmp via wx (no symlink-follow on create), then atomic-rename; old contents go to .bak.
            const tmpSuffix = `.cl-tmp-${randomUUID()}`;
            const tmpPaths = [];
            const cleanup = async () => {
                for (const t of tmpPaths) { try { await unlink(t); } catch {} }
            };
            try {
                for (const name of _SELF_UPDATE_FILES) {
                    const finalPath = join(__dirname, name);
                    try {
                        if ((await lstat(finalPath)).isSymbolicLink()) {
                            await cleanup();
                            return res.status(400).json({ ok: false, error: `${name}: refusing to overwrite symlink` });
                        }
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e;
                    }
                    const tmpPath = finalPath + tmpSuffix;
                    await writeFile(tmpPath, sourceFiles[name], { encoding: 'utf-8', flag: 'wx' });
                    tmpPaths.push(tmpPath);
                }
                for (let i = 0; i < _SELF_UPDATE_FILES.length; i++) {
                    const finalPath = join(__dirname, _SELF_UPDATE_FILES[i]);
                    try {
                        const old = await readFile(finalPath, 'utf-8');
                        try { await writeFile(finalPath + '.bak', old, 'utf-8'); } catch {}
                    } catch {}
                    await rename(tmpPaths[i], finalPath);
                }
                console.log(`[cl-helper] /self-update installed ${parsedPkg.version} from ${source.path} (was v${_runningVersion})`);
                res.json({ ok: true, written: [..._SELF_UPDATE_FILES], source: source.path, version: parsedPkg.version });
            } catch (e) {
                await cleanup();
                console.warn(`[cl-helper] /self-update failed: ${e.message}`);
                res.status(500).json({ ok: false, error: e.message });
            }
        } finally {
            _selfUpdateInFlight = false;
        }
    });

    registerThumbnailRoutes(router);
    registerPygmalionRoutes(router);
    registerBotbooruRoutes(router);
    registerCharacterTavernRoutes(router);
    registerDataCatRoutes(router);
    registerImgchestRoutes(router);
    registerCivitaiRoutes(router);
    registerSaucepanRoutes(router);
    registerDropboxRoutes(router);
    registerFlareSolverrRoutes(router);

    console.log('[cl-helper] Character Library helper plugin loaded');

    // Image library load happens after route registration so a slow or
    // failed jimp import never delays /health or other routes from being
    // available. Thumbnail routes degrade gracefully when _thumbsReady is false.
    _imagesDir = resolveImagesDir();
    _charactersDir = resolveCharactersDir();
    if (_imagesDir) {
        const ok = await initImageLib();
        _thumbsReady = ok;
        if (ok) {
            console.log(`[cl-helper] Gallery thumbnails enabled (images: ${_imagesDir})`);
        } else {
            console.log('[cl-helper] Gallery thumbnails disabled (jimp not available)');
        }
    } else {
        console.log('[cl-helper] Gallery thumbnails disabled (images directory not found)');
    }
    if (_charactersDir && _thumbsReady) {
        console.log(`[cl-helper] Avatar thumbnails enabled (characters: ${_charactersDir})`);
    } else if (!_charactersDir) {
        console.log('[cl-helper] Avatar thumbnails disabled (characters directory not found)');
    }
}
