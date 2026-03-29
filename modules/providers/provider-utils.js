// Provider Utilities — shared helpers used across all providers
//
// Contains network helpers, text utilities, image processing,
// and the import pipeline shared by all provider implementations.

// ========================================
// CONSTANTS
// ========================================

export const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

export const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';

// ========================================
// NETWORK
// ========================================

const _proxyOrigins = new Set();

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
            // fetch() rejects on CORS/network errors — fall through to proxy
            _proxyOrigins.add(origin);
        }
        if (directResponse) {
            if (!directResponse.ok) throw new Error(`HTTP ${directResponse.status}`);
            return directResponse;
        }
    }
    const r = await fetch(`/proxy/${encodeURIComponent(url)}`, opts);
    if (!r.ok) {
        if (r.status === 404) {
            const t = await r.text();
            if (t.includes('CORS proxy is disabled'))
                throw new Error('CORS proxy is disabled in SillyTavern settings');
        }
        throw new Error(`HTTP ${r.status}`);
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
 * Normalize a character name for cross-provider matching.
 * Strips version suffixes, common modifiers, and collapses whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeBrowseName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        .replace(/\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i, '')
        .replace(/\s*-?\s*v\d+(\.\d+)*$/i, '')
        .replace(/\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
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

    const mediaUrls = api.findCharacterMediaUrls?.(characterCard) || [];
    const galleryId = characterCard.data.extensions?.gallery_id || null;

    return {
        success: true,
        fileName: result.file_name || fileName,
        characterName,
        hasGallery,
        providerCharId,
        fullPath,
        avatarUrl,
        embeddedMediaUrls: mediaUrls,
        galleryId
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
