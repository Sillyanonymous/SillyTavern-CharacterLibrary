/**
 * MEGA Folder Extractor
 *
 * Extracts images from shared MEGA folders (mega.nz/folder/{id}#{key}).
 * MEGA encrypts all files client-side, so this extractor handles:
 *   1. AES key unwrapping (ECB) and attribute decryption (CBC) via a minimal
 *      AES-128 implementation (Web Crypto lacks ECB / unpadded CBC).
 *   2. File content decryption (CTR) via Web Crypto for performance.
 *   3. Returns blob: URLs so the pipeline can fetch decrypted data normally.
 *
 * Supports both URL formats:
 *   New: https://mega.nz/folder/{id}#{key}
 *   Old: https://mega.nz/#F!{id}!{key}  /  https://mega.co.nz/#F!{id}!{key}
 */

import { registerExtractor } from './extractor-registry.js';

const MEGA_PATTERNS = [
    /mega\.nz\/folder\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/,
    /mega\.(?:nz|co\.nz)\/#F![A-Za-z0-9_-]+![A-Za-z0-9_-]+/
];

const MEGA_API = 'https://g.api.mega.co.nz/cs';
const IMAGE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif',
    'mp4', 'webm'
]);
const REQUEST_DELAY_MS = 200;

// ========================================================================
// AES-128 Core (FIPS 197)
// ========================================================================

/* eslint-disable */
const SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]);

const INV_SBOX = new Uint8Array([
    0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
    0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
    0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
    0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
    0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
    0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
    0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
    0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
    0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
    0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
    0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
    0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
    0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
    0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
    0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
    0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d
]);
/* eslint-enable */

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function expandKey(key) {
    const w = new Uint8Array(176);
    w.set(key);
    for (let i = 16; i < 176; i += 4) {
        let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
        if (i % 16 === 0) {
            const tmp = t0;
            t0 = SBOX[t1] ^ RCON[i / 16 - 1];
            t1 = SBOX[t2];
            t2 = SBOX[t3];
            t3 = SBOX[tmp];
        }
        w[i]     = w[i - 16] ^ t0;
        w[i + 1] = w[i - 15] ^ t1;
        w[i + 2] = w[i - 14] ^ t2;
        w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
}

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }

function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        a = xtime(a);
        b >>= 1;
    }
    return p;
}

function decryptBlock(rk, block) {
    const s = new Uint8Array(16);
    s.set(block);

    for (let i = 0; i < 16; i++) s[i] ^= rk[160 + i];

    for (let round = 9; round >= 1; round--) {
        // InvShiftRows
        let tmp = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = tmp;
        tmp = s[2]; s[2] = s[10]; s[10] = tmp;
        tmp = s[6]; s[6] = s[14]; s[14] = tmp;
        tmp = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = tmp;

        for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];

        const off = round * 16;
        for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];

        // InvMixColumns
        for (let c = 0; c < 4; c++) {
            const j = c * 4;
            const a = s[j], b = s[j + 1], d = s[j + 2], e = s[j + 3];
            s[j]     = gmul(a, 14) ^ gmul(b, 11) ^ gmul(d, 13) ^ gmul(e, 9);
            s[j + 1] = gmul(a, 9)  ^ gmul(b, 14) ^ gmul(d, 11) ^ gmul(e, 13);
            s[j + 2] = gmul(a, 13) ^ gmul(b, 9)  ^ gmul(d, 14) ^ gmul(e, 11);
            s[j + 3] = gmul(a, 11) ^ gmul(b, 13) ^ gmul(d, 9)  ^ gmul(e, 14);
        }
    }

    // Final round (no InvMixColumns)
    let tmp = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = tmp;
    tmp = s[2]; s[2] = s[10]; s[10] = tmp;
    tmp = s[6]; s[6] = s[14]; s[14] = tmp;
    tmp = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = tmp;

    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= rk[i];

    return s;
}

function encryptBlock(rk, block) {
    const s = new Uint8Array(16);
    s.set(block);

    for (let i = 0; i < 16; i++) s[i] ^= rk[i];

    for (let round = 1; round <= 9; round++) {
        for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];

        // ShiftRows
        let tmp = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = tmp;
        tmp = s[2]; s[2] = s[10]; s[10] = tmp;
        tmp = s[6]; s[6] = s[14]; s[14] = tmp;
        tmp = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = tmp;

        // MixColumns
        for (let c = 0; c < 4; c++) {
            const j = c * 4;
            const a = s[j], b = s[j + 1], d = s[j + 2], e = s[j + 3];
            s[j]     = xtime(a) ^ xtime(b) ^ b ^ d ^ e;
            s[j + 1] = a ^ xtime(b) ^ xtime(d) ^ d ^ e;
            s[j + 2] = a ^ b ^ xtime(d) ^ xtime(e) ^ e;
            s[j + 3] = xtime(a) ^ a ^ b ^ d ^ xtime(e);
        }

        const off = round * 16;
        for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
    }

    // Final round (no MixColumns)
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];

    let tmp = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = tmp;
    tmp = s[2]; s[2] = s[10]; s[10] = tmp;
    tmp = s[6]; s[6] = s[14]; s[14] = tmp;
    tmp = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = tmp;

    for (let i = 0; i < 16; i++) s[i] ^= rk[160 + i];

    return s;
}

// ========================================================================
// AES Modes
// ========================================================================

function aesEcbDecrypt(keyBytes, data) {
    const rk = expandKey(keyBytes);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 16) {
        out.set(decryptBlock(rk, data.subarray(i, i + 16)), i);
    }
    return out;
}

function aesCbcDecrypt(keyBytes, iv, data) {
    const rk = expandKey(keyBytes);
    const out = new Uint8Array(data.length);
    let prev = iv;
    for (let i = 0; i < data.length; i += 16) {
        const dec = decryptBlock(rk, data.subarray(i, i + 16));
        for (let j = 0; j < 16; j++) out[i + j] = dec[j] ^ prev[j];
        prev = data.subarray(i, i + 16);
    }
    return out;
}

async function aesCtrDecrypt(keyBytes, counter, data) {
    if (crypto?.subtle) {
        try {
            const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);
            return new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-CTR', counter, length: 64 },
                key, data
            ));
        } catch { /* fall through to pure-JS */ }
    }

    // Pure-JS fallback (slower, but works without Web Crypto)
    const rk = expandKey(keyBytes);
    const out = new Uint8Array(data.length);
    const ctr = new Uint8Array(counter);
    for (let offset = 0; offset < data.length; offset += 16) {
        const ks = encryptBlock(rk, ctr);
        const len = Math.min(16, data.length - offset);
        for (let i = 0; i < len; i++) out[offset + i] = data[offset + i] ^ ks[i];
        // Increment rightmost 64 bits (big-endian, matching Web Crypto length:64)
        // Uint8Array ++ returns the unwrapped JS number (256), not the stored value (0), so use post-increment + break
        for (let i = 15; i >= 8; i--) { ctr[i]++; if (ctr[i]) break; }
    }
    return out;
}

// ========================================================================
// MEGA Utilities
// ========================================================================

function b64Decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function parseFolderUrl(url) {
    try {
        const u = new URL(url);

        // New format: /folder/{id}#{key}
        const newFmt = u.pathname.match(/\/folder\/([A-Za-z0-9_-]+)/);
        if (newFmt && u.hash.length > 1) {
            return { folderId: newFmt[1], key: b64Decode(u.hash.slice(1)) };
        }

        // Old format: /#F!{id}!{key}
        const oldFmt = u.hash.match(/^#F!([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/);
        if (oldFmt) {
            return { folderId: oldFmt[1], key: b64Decode(oldFmt[2]) };
        }
    } catch { /* ignore */ }
    return null;
}

function tryDecryptNodeKey(node, keyMap) {
    const entries = (node.k || '').split('/');
    for (const entry of entries) {
        const sep = entry.indexOf(':');
        if (sep < 1) continue;
        const handle = entry.slice(0, sep);
        const encB64 = entry.slice(sep + 1);
        const parentKey = keyMap.get(handle);
        if (!parentKey) continue;
        try {
            const enc = b64Decode(encB64);
            if (enc.length % 16 !== 0 || enc.length === 0) continue;
            return aesEcbDecrypt(parentKey, enc);
        } catch { continue; }
    }
    return null;
}

function deriveFileKey(decKey) {
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i++) key[i] = decKey[i] ^ decKey[i + 16];
    return key;
}

function buildCtrCounter(decKey) {
    const ctr = new Uint8Array(16);
    ctr.set(decKey.subarray(16, 24));
    return ctr;
}

function decryptAttributes(keyBytes, attrData) {
    if (!attrData || attrData.length === 0 || attrData.length % 16 !== 0) return null;
    const iv = new Uint8Array(16);
    const dec = aesCbcDecrypt(keyBytes, iv, attrData);
    const str = new TextDecoder().decode(dec);
    if (!str.startsWith('MEGA{')) return null;
    const json = str.slice(4).replace(/\0+$/, '');
    try { return JSON.parse(json); }
    catch { return null; }
}

function getFileExtension(filename) {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

const MIME_MAP = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    svg: 'image/svg+xml', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm'
};

// ========================================================================
// MEGA API
// ========================================================================

let apiSeq = Math.floor(Math.random() * 0xFFFFFFFF);

async function megaApi(folderId, commands, signal) {
    const url = `${MEGA_API}?id=${apiSeq++}&n=${folderId}`;
    let resp;
    try {
        resp = await fetch(url, { method: 'POST', body: JSON.stringify(commands), signal });
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
        const proxy = `/proxy/${encodeURIComponent(url)}`;
        resp = await fetch(proxy, { method: 'POST', body: JSON.stringify(commands), signal });
    }
    if (!resp.ok) throw new Error(`MEGA API HTTP ${resp.status}`);
    return resp.json();
}

async function listFolder(folderId, signal) {
    const res = await megaApi(folderId, [{ a: 'f', c: 1, r: 1 }], signal);
    if (typeof res[0] === 'number') throw new Error(`MEGA API error ${res[0]}`);
    return res[0]?.f || [];
}

async function getDownloadUrl(folderId, fileHandle, signal) {
    const res = await megaApi(folderId, [{ a: 'g', g: 1, n: fileHandle }], signal);
    if (typeof res[0] === 'number') return null;
    return res[0]?.g || null;
}

// ========================================================================
// Extractor
// ========================================================================

const MAX_FILES = 100;

async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const parsed = parseFolderUrl(url);
        if (!parsed) return { images: [], error: 'Invalid MEGA folder URL' };

        const { folderId, key: masterKey } = parsed;
        if (masterKey.length !== 16) return { images: [], error: 'Invalid folder key length' };

        const nodes = await listFolder(folderId, signal);
        if (signal?.aborted) return { images: [], aborted: true };
        if (nodes.length === 0) return { images: [], error: 'Empty folder or access denied' };

        // Build key hierarchy starting from root
        const handleSet = new Set(nodes.map(n => n.h));
        const keyMap = new Map();

        for (const n of nodes) {
            if (n.t >= 1 && !handleSet.has(n.p)) {
                keyMap.set(n.h, masterKey);
                break;
            }
        }

        let resolving = true;
        let passes = 0;
        const maxPasses = nodes.length;
        while (resolving) {
            resolving = false;
            if (++passes > maxPasses) break;
            for (const n of nodes) {
                if (n.t !== 1 || keyMap.has(n.h)) continue;
                const dec = tryDecryptNodeKey(n, keyMap);
                if (dec && dec.length === 16) {
                    keyMap.set(n.h, dec);
                    resolving = true;
                }
            }
        }

        // Decrypt file attributes and filter for images
        const images = [];
        for (const n of nodes) {
            if (n.t !== 0) continue;
            const nodeKey = tryDecryptNodeKey(n, keyMap);
            if (!nodeKey || nodeKey.length < 32) continue;

            const fileKey = deriveFileKey(nodeKey);
            const attrData = b64Decode(n.a);
            const attrs = decryptAttributes(fileKey, attrData);
            if (!attrs?.n) continue;

            const ext = getFileExtension(attrs.n);
            if (!IMAGE_EXTENSIONS.has(ext)) continue;

            const ctr = buildCtrCounter(nodeKey);
            const capturedFolderId = folderId;
            const capturedHandle = n.h;
            const capturedFileKey = fileKey;
            const capturedCtr = ctr;
            const capturedSize = n.s || 0;
            const mime = MIME_MAP[ext] || 'application/octet-stream';

            images.push({
                url: `mega://${folderId}/${n.h}`,
                filename: attrs.n,
                downloadFn: async (dlSignal) => {
                    const dlUrl = await getDownloadUrl(capturedFolderId, capturedHandle, dlSignal);
                    if (!dlUrl) return { success: false, error: 'No download URL' };

                    let resp;
                    try {
                        resp = await fetch(dlUrl, { signal: dlSignal });
                    } catch (err) {
                        if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
                        resp = await fetch(`/proxy/${encodeURIComponent(dlUrl)}`, { signal: dlSignal });
                    }
                    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };

                    const encrypted = new Uint8Array(await resp.arrayBuffer());
                    const decrypted = await aesCtrDecrypt(capturedFileKey, capturedCtr, encrypted);
                    const trimmed = (capturedSize > 0 && decrypted.length > capturedSize)
                        ? decrypted.slice(0, capturedSize)
                        : decrypted;

                    return {
                        success: true,
                        arrayBuffer: trimmed.buffer,
                        contentType: mime,
                        detectedType: mime
                    };
                }
            });

            if (images.length >= MAX_FILES) break;
        }

        if (images.length === 0) {
            return { images: [], error: 'No image files found in folder' };
        }

        return { images };
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return { images: [], aborted: true };
        }
        return { images: [], error: err.message };
    }
}

registerExtractor({
    id: 'mega',
    name: 'MEGA',
    patterns: MEGA_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
