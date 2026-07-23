// Provider Utilities - shared helpers used across all providers
//
// Contains network helpers, text utilities, image processing,
// and the import pipeline shared by all provider implementations.

import CoreAPI from '../core-api.js';

// ========================================
// CONSTANTS
// ========================================

export const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

export const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';

// Live mobile-mode check for handlers that branch per mode (html.cl-mobile, owned by the boot
// policy + the library-mobile lifecycle). Always evaluate at event time, never at listener-attach
// time: the browse modal listener guards never reset, so an attach-time snapshot goes stale when
// the mode flips mid-session.
export function isMobileMode() {
    return document.documentElement.classList.contains('cl-mobile');
}

// Jump the browse list to the top so a new result set doesnt strand the user mid-list; mobile only.
export function scrollBrowseListTop() {
    if (!isMobileMode()) return;
    const sc = document.querySelector('.gallery-content');
    if (sc) sc.scrollTop = 0;
}

// XSS gate for any third-party browse content rendered via innerHTML.
// Never bypass; never duplicate this config per-provider.
export const BROWSE_PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
        'ul', 'ol', 'li', 'a', 'img', 'center', 'font', 'style',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'
    ],
    ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel',
        'width', 'height', 'loading', 'color', 'size', 'align'
    ],
    ALLOW_DATA_ATTR: false
};

// n shimmer rows, last two tapered so it reads as a paragraph not a bar block.
export function skeletonLines(n = 3) {
    if (n <= 0) return '';
    const out = [];
    for (let i = 0; i < n; i++) {
        const cls = i === n - 1 ? 'cl-skeleton-line shorter'
                  : i === n - 2 ? 'cl-skeleton-line short'
                  : 'cl-skeleton-line';
        out.push(`<div class="${cls}"></div>`);
    }
    return out.join('');
}

// A browse preview fills several heavy fields (each a safePurify(formatRichText(...)) on big
// third-party content); doing them in one frame is a long task that janks the open. deferRender runs
// one queued job per frame, and only for fields actually on screen: a job whose element is hidden
// (collapsed section) or below the fold is parked instead of built, and an IntersectionObserver
// re-queues it on first reveal. Content the user never scrolls to never pays the sanitize cost.
let _deferQueue = [];
let _deferRaf = 0;
const _deferParked = new WeakMap(); // el -> job, waiting for first reveal
let _deferIO = null;

// 200px lookahead so a slow scroll meets built content instead of a skeleton.
const DEFER_REVEAL_MARGIN = 200;

// In-layout + within (margin-padded) viewport. getClientRects() is empty for display:none but not
// for zero-height boxes, so still-empty containers (eg. alt-greeting bodies) count as visible.
function _deferOnScreen(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + DEFER_REVEAL_MARGIN && r.bottom > -DEFER_REVEAL_MARGIN;
}

function _deferReveal() {
    if (_deferIO) return _deferIO;
    _deferIO = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            _deferIO.unobserve(en.target);
            const job = _deferParked.get(en.target);
            if (job) { _deferParked.delete(en.target); _enqueueDeferJob(job); }
        }
    }, { rootMargin: `${DEFER_REVEAL_MARGIN}px` });
    return _deferIO;
}

function _pumpDefer() {
    _deferRaf = 0;
    const job = _deferQueue.shift();
    if (job && job.el && job.el.isConnected) {
        if (_deferOnScreen(job.el)) {
            const t0 = performance.now();
            // build jobs assign innerHTML; call jobs run a side effect (eg. append a sanitized iframe).
            try { if (job.run) job.run(); else job.el.innerHTML = job.build(); } catch { /* skip a field that fails */ }
            CoreAPI.debugLog(`[defer] ${(performance.now() - t0).toFixed(1)}ms`, job.el.id || job.el.className);
        } else {
            _deferParked.set(job.el, job);
            _deferReveal().observe(job.el);
        }
    }
    if (_deferQueue.length) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// Pace one job per frame, only for on-screen elements; park the rest until first reveal. Reusing the
// same element replaces its pending job (queued or parked), so re-opening the (shared) preview modal
// with a new card supersedes the prior card's pending work instead of briefly painting it.
function _enqueueDeferJob(job) {
    _deferParked.delete(job.el);
    const i = _deferQueue.findIndex(j => j.el === job.el);
    if (i !== -1) _deferQueue.splice(i, 1);
    _deferQueue.push(job);
    if (!_deferRaf) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// build() returns HTML assigned via `el.innerHTML` in the pump (a text field's sanitize pipeline).
export function deferRender(el, build) {
    if (!el || typeof build !== 'function') return;
    _enqueueDeferJob({ el, build });
}

// run() runs a side-effecting callback in the pump instead of assigning innerHTML, for renders that
// append nodes themselves (eg. renderCreatorNotesSecure's sanitized iframe). Same pacing + parking.
export function deferCall(el, run) {
    if (!el || typeof run !== 'function') return;
    _enqueueDeferJob({ el, run });
}

// ========================================
// NETWORK
// ========================================

const _proxyOrigins = new Set();

// Short human snippet from an error body: JSON detail/message/error fields
// when present, else the tag-stripped raw start. Capped at 200 chars.
function errorSnippetFromText(text) {
    const t = (text || '').trim();
    if (!t) return '';
    try {
        const j = JSON.parse(t);
        const msg = j?.detail || j?.message || j?.error;
        if (typeof msg === 'string' && msg) return `: ${msg.slice(0, 200)}`;
        if (msg) return `: ${JSON.stringify(msg).slice(0, 200)}`;
    } catch { /* not JSON; fall through to raw */ }
    return `: ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

async function errorBodySnippet(resp) {
    try {
        return errorSnippetFromText(await resp.text());
    } catch {
        return '';
    }
}

/**
 * Encode a URL for the /proxy/ path. encodeURIComponent leaves the sub-delims
 * !'()* literal; some reverse proxies/WAFs 403 literal parens as injection
 * patterns (postimg "(1)" filenames are the common trigger), so escape them too.
 * @param {string} url
 * @returns {string}
 */
export function proxyEncode(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Fetch with automatic CORS proxy fallback.
 * Remembers origins that need proxying to avoid redundant direct attempts.
 * @param {string} url
 * @param {Object} [opts] - fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithProxy(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!_proxyOrigins.has(origin)) {
        let directResponse;
        try {
            directResponse = await fetch(url, opts);
        } catch (_) {
            // fetch() rejects on CORS/network errors - fall through to proxy
            _proxyOrigins.add(origin);
        }
        if (directResponse) {
            if (!directResponse.ok) throw new Error(`HTTP ${directResponse.status}${await errorBodySnippet(directResponse)}`);
            return directResponse;
        }
    }
    const r = await fetch(`/proxy/${proxyEncode(url)}`, opts);
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 404 && t.includes('CORS proxy is disabled')) {
            throw new Error('CORS proxy is disabled. Set enableCorsProxy: true in SillyTavern\'s config.yaml and restart the server');
        }
        throw new Error(`HTTP ${r.status}${errorSnippetFromText(t)}`);
    }
    return r;
}

// ========================================
// TEXT UTILITIES
// ========================================

/**
 * Slugify a string for use in filenames and URL paths.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
    return (name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

/**
 * Strip HTML tags and decode common entities.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

/**
 * Rewrite root-relative media references in remote card text to the provider's site.
 * Covers markdown image destinations and <img src>; a single leading slash in remote
 * content can only mean site-relative, left alone the browser resolves it against the
 * ST origin and 404s (eg botbooru's ![](/mirror/<hash>.png) mirror rewrites).
 * Protocol-relative (//host) and absolute URLs pass through untouched.
 * @param {string} text
 * @param {string} base - provider site origin, eg 'https://botbooru.com'
 * @returns {string}
 */
export function absolutizeMediaPaths(text, base) {
    if (!text || !base) return text || '';
    const root = String(base).replace(/\/+$/, '');
    return String(text)
        .replace(/(!\[[^\]]*\]\()\/(?!\/)/g, (m, p1) => `${p1}${root}/`)
        .replace(/(<img\s[^>]*?src=["'])\/(?!\/)/gi, (m, p1) => `${p1}${root}/`);
}

// Pure-function memo: same raw name always normalizes the same, so a hit is never stale.
// Both consumers re-run it over stable inputs (library rebuild over allCharacters, per-card
// match checks over recurring browse names), so the cache erases the regex cost on repeats.
// FIFO-evict past the cap to bound a long browse session; dropping any entry is always safe.
const _normalizeBrowseNameCache = new Map();
const NORMALIZE_BROWSE_NAME_CACHE_CAP = 50000;

/**
 * Normalize a character name for cross-provider matching.
 * Strips version suffixes, common modifiers, and collapses whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeBrowseName(name) {
    if (!name) return '';
    const cached = _normalizeBrowseNameCache.get(name);
    if (cached !== undefined) return cached;
    const result = name
        .toLowerCase()
        .trim()
        .replace(/\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i, '')
        .replace(/\s*-?\s*v\d+(\.\d+)*$/i, '')
        .replace(/\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (_normalizeBrowseNameCache.size >= NORMALIZE_BROWSE_NAME_CACHE_CAP) {
        _normalizeBrowseNameCache.delete(_normalizeBrowseNameCache.keys().next().value);
    }
    _normalizeBrowseNameCache.set(name, result);
    return result;
}

/**
 * Format a number with K/M suffixes.
 * @param {number} num
 * @returns {string}
 */
export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// ========================================
// IMAGE PROCESSING
// ========================================

/**
 * Ensure a buffer is PNG format. Returns the buffer as-is if already PNG,
 * otherwise converts via OffscreenCanvas with api.convertImageToPng fallback.
 * @param {ArrayBuffer} imageBuffer
 * @param {Object} [api] - CoreAPI reference for convertImageToPng fallback
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function ensurePng(imageBuffer, api) {
    if (!imageBuffer) return null;

    const header = new Uint8Array(imageBuffer, 0, 4);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    if (isPng) return imageBuffer;

    try {
        const blob = new Blob([imageBuffer]);
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } catch (e1) {
        try {
            if (api?.convertImageToPng) return await api.convertImageToPng(imageBuffer);
        } catch (e2) {
            console.warn('[ProviderUtils] PNG conversion failed:', e2.message);
        }
    }
    return null;
}

/**
 * Generate a 256x256 dark gray placeholder PNG with a "?" character.
 * @returns {Promise<ArrayBuffer>}
 */
export async function generatePlaceholder() {
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#666';
    ctx.font = '100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 128, 128);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
}

// Post-import tail shared by every browse view: summary/preview choreography, success toast,
// library refresh, imported-badge stamp. The timings are deliberate: mobile shows the summary
// OVER the preview for 220ms (the small-viewport fade is too visible), the no-summary path
// flashes the button for 350ms, the refresh waits 200ms for ST to settle the upload, and a
// missed single-char add waits another 500ms before the full-list refetch.
export async function finishBrowseImport({ view, summaryArgs, showSummary, closePreview, importBtn, characterName, avatarFileName, markImported }) {
    if (showSummary) {
        if (isMobileMode()) {
            CoreAPI.showImportSummaryModal(summaryArgs);
            await new Promise(r => setTimeout(r, 220));
            closePreview();
        } else {
            closePreview();
            await new Promise(r => requestAnimationFrame(r));
            CoreAPI.showImportSummaryModal(summaryArgs);
        }
    } else {
        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
        await new Promise(r => setTimeout(r, 350));
        closePreview();
    }

    CoreAPI.showToast(`Imported "${characterName}"`, 'success');

    await new Promise(r => setTimeout(r, 200));
    // Lightweight single-character add (avoids OOM from a full list reload on mobile).
    const added = await CoreAPI.fetchAndAddCharacter(avatarFileName);
    if (added) {
        view.addCharToLookup(added);
    } else {
        await new Promise(r => setTimeout(r, 500));
        await CoreAPI.fetchCharacters(true);
    }
    markImported();
    // markImported only stamps the browse grid; this re-grade covers the mode-aware grids
    // (following/timeline included) and clears the card's stale possible-match badge.
    view.refreshInLibraryBadges?.();
}

/**
 * Assign gallery_id to a character card, inheriting from a replaced character
 * or generating a new one if the uniqueGalleryFolders setting is enabled.
 * @param {Object} card - V2 character card (mutated in place)
 * @param {Object} options
 * @param {string} [options.inheritedGalleryId] - gallery_id from a replaced character
 * @param {Object} api - CoreAPI reference
 */
export function assignGalleryId(card, options, api) {
    if (!card?.data?.extensions) return;
    if (options?.inheritedGalleryId) {
        card.data.extensions.gallery_id = options.inheritedGalleryId;
    } else if (api?.getSetting?.('uniqueGalleryFolders') && !card.data.extensions.gallery_id) {
        card.data.extensions.gallery_id = api.generateGalleryId?.();
    }
}

// ========================================
// IMPORT PIPELINE
// ========================================

/**
 * Shared import-to-SillyTavern pipeline. Handles PNG conversion, card
 * embedding, upload to ST's import endpoint, and result normalization.
 *
 * Providers call this after they've built their V2 card and downloaded
 * the avatar image. Provider-specific logic (metadata fetch, V2 card
 * building, link metadata, avatar download) stays in the provider.
 *
 * @param {Object} params
 * @param {Object} params.characterCard - V2 character card to embed
 * @param {ArrayBuffer|null} params.imageBuffer - avatar image (any format)
 * @param {string} params.fileName - target filename (e.g. "chub_slug.png")
 * @param {string} params.characterName - display name for toasts/results
 * @param {boolean} [params.hasGallery=false] - whether gallery images exist
 * @param {string|number|null} [params.providerCharId] - provider-side ID
 * @param {string|null} [params.fullPath] - canonical path on provider
 * @param {string|null} [params.avatarUrl] - remote avatar URL for display
 * @param {Object} params.api - CoreAPI reference
 * @returns {Promise<Object>} ProviderImportResult
 */
export async function importFromPng({
    characterCard,
    imageBuffer,
    fileName,
    characterName,
    hasGallery = false,
    providerCharId = null,
    fullPath = null,
    avatarUrl = null,
    api
}) {
    if (characterCard?.data?.name && characterCard.data.name.length > 128) {
        characterCard.data.name = characterCard.data.name.substring(0, 128).trimEnd();
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');

    let pngBuffer = await ensurePng(imageBuffer, api);
    imageBuffer = null;

    if (!pngBuffer) {
        pngBuffer = await generatePlaceholder();
    }

    let embeddedPng = api.embedCharacterDataInPng(pngBuffer, characterCard);
    pngBuffer = null;

    let file = new File([embeddedPng], safeName, { type: 'image/png' });
    embeddedPng = null;

    let formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', 'png');
    file = null;

    const csrfToken = api.getCSRFToken?.();
    const importResponse = await fetch('/api/characters/import', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: formData
    });
    formData = null;

    const responseText = await importResponse.text();
    if (!importResponse.ok) throw new Error(`Import error: ${responseText}`);

    let result;
    try { result = JSON.parse(responseText); }
    catch { throw new Error(`Invalid JSON response: ${responseText}`); }
    if (result.error) throw new Error('Import failed: Server returned error');

    // ST's V2 import path runs data.name through sanitize-filename, replacing
    // path-illegal chars like '|' (creators use them as separators) with '_'.
    // merge-attributes does NOT re-sanitize, so we restore the raw name here.
    // Without this, update-checks flag false diffs against the remote and
    // gallery-folder lookups (using char.name) diverge from auto-localize's
    // raw-cardData folder.
    const ST_ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/;
    const rawName = characterCard.data?.name;
    if (result.file_name && rawName && ST_ILLEGAL_NAME_CHARS.test(rawName)) {
        // ST returns file_name without the extension; merge-attributes needs it.
        const avatarWithExt = String(result.file_name).toLowerCase().endsWith('.png')
            ? result.file_name
            : `${result.file_name}.png`;
        let restoreOk = false;
        try {
            // CARVE-OUT from the "no direct merge-attributes" architectural rule: this fires during the import round-trip, before CL has the new char in its allCharacters list, so applyCardFieldUpdates' avatar lookup would fail. The write is a single scalar data.name field with no extension namespace involved, so no preflight or sentinel handling is needed.
            const resp = await api.apiRequest?.('/characters/merge-attributes', 'POST', {
                avatar: avatarWithExt,
                data: { name: rawName }
            });
            if (resp?.ok) {
                restoreOk = true;
            } else if (resp) {
                let body = '';
                try { body = await resp.clone().text(); } catch { /* ignore */ }
                console.warn(`[Import] data.name restore failed (HTTP ${resp.status}):`, body.slice(0, 200));
            }
        } catch (e) {
            console.warn('[Import] Failed to restore raw data.name:', e?.message || e);
        }
        if (!restoreOk) {
            api.showToast?.(`Imported "${characterName}" but couldn't restore special characters in the name; update checks may show false differences.`, 'warning', 6000);
        }
    }

    const mediaUrls = api.findCharacterMediaUrls?.(characterCard) || [];
    await CoreAPI.ensureExtractorsLoaded();
    const galleryPageUrls = CoreAPI.findCharacterGalleryUrls(characterCard);
    const galleryId = characterCard.data.extensions?.gallery_id || null;

    return {
        success: true,
        fileName: result.file_name || fileName,
        characterName: characterCard.data?.name || characterName,
        hasGallery,
        providerCharId,
        fullPath,
        avatarUrl,
        embeddedMediaUrls: mediaUrls,
        galleryPageUrls,
        galleryId,
        cardData: characterCard.data
    };
}

// ========================================
// GALLERY SAVE
// ========================================

/**
 * Save a downloaded media file to a character's gallery folder.
 * Uses the naming convention: {prefix}_{hash8}_{sanitizedName}.{ext}
 *
 * @param {Object} downloadResult - { arrayBuffer, contentType }
 * @param {Object} imageInfo - { url, id?, nsfw? }
 * @param {string} folderName - gallery folder name
 * @param {string} contentHash - SHA-256 hash of the file content
 * @param {string} filePrefix - naming prefix (e.g. 'chubgallery')
 * @param {Object} api - CoreAPI reference
 * @returns {Promise<{success: boolean, localPath?: string, filename?: string, error?: string}>}
 */
export async function saveGalleryImage(downloadResult, imageInfo, folderName, contentHash, filePrefix, api) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        let extension = 'webp';
        if (contentType) {
            const mimeMap = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
                'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
                'audio/ogg': 'ogg', 'audio/flac': 'flac'
            };
            if (mimeMap[contentType]) extension = mimeMap[contentType];
            else if (contentType.startsWith('audio/')) extension = contentType.split('/')[1].split(';')[0].replace('x-', '') || 'audio';
        } else {
            const urlMatch = imageInfo.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) extension = urlMatch[1].toLowerCase();
        }

        const sanitizedName = api.extractSanitizedUrlName?.(imageInfo.url) || 'gallery_image';
        const shortHash = (contentHash?.length >= 8) ? contentHash.substring(0, 8) : 'nohash00';
        const filenameBase = `${filePrefix}_${shortHash}_${sanitizedName}`;

        let base64Data = api.arrayBufferToBase64?.(arrayBuffer);
        downloadResult.arrayBuffer = null;

        const bodyStr = JSON.stringify({
            image: base64Data,
            filename: filenameBase,
            format: extension,
            ch_name: folderName
        });
        base64Data = null;

        const csrfToken = api.getCSRFToken?.();
        const resp = await fetch(`/api${api.getEndpoints?.()?.IMAGES_UPLOAD || '/images/upload'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: bodyStr
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Upload failed: ${errText}`);
        }

        const saveResult = await resp.json();
        if (!saveResult?.path) throw new Error('No path returned from upload');

        return { success: true, localPath: saveResult.path, filename: `${filenameBase}.${extension}` };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}
