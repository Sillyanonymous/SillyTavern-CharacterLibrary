/**
 * Google Drive Gallery Extractor
 *
 * Extracts images from public Google Drive folder pages.
 * The folder page embeds file metadata (IDs, names, MIME types) in
 * HTML-entity-encoded JSON arrays within script blocks. Each image file
 * is converted to a direct download URL via /uc?export=download&id=FILE_ID.
 *
 * Pattern: https://drive.google.com/drive/folders/{folderId}
 * Download: https://drive.google.com/uc?export=download&id={fileId}
 */

import { registerExtractor } from './extractor-registry.js';

const GDRIVE_PATTERNS = [
    /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+/
];

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

// Matches file entries: [null,"FILE_ID"],null,null,null,"MIME_TYPE"
const FILE_ENTRY_REGEX = /\[null,&quot;([a-zA-Z0-9_-]{20,50})&quot;\],null,null,null,&quot;(image\/(?:png|jpe?g|gif|webp))&quot;/g;

// Matches filenames after a file entry: ["FILENAME.EXT",null,true]
const FILENAME_REGEX = /&quot;([^&]+\.(?:png|jpe?g|gif|webp))&quot;,null,true\]/i;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Google Drive folder URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);
        const images = parseFileEntries(html);

        if (images.length === 0) {
            return { images: [], error: 'No image files found in folder' };
        }

        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseFileEntries(html) {
    const images = [];
    const seen = new Set();

    FILE_ENTRY_REGEX.lastIndex = 0;
    let match;
    while ((match = FILE_ENTRY_REGEX.exec(html)) !== null) {
        const fileId = match[1];
        if (seen.has(fileId)) continue;
        seen.add(fileId);

        // Look ahead in the HTML for the filename after this entry
        const afterEntry = html.substring(match.index + match[0].length, match.index + match[0].length + 2000);
        const nameMatch = FILENAME_REGEX.exec(afterEntry);
        const filename = nameMatch ? nameMatch[1] : `${fileId}.${mimeToExt(match[2])}`;

        images.push({
            url: `https://drive.google.com/uc?export=download&id=${fileId}`,
            filename
        });
    }

    return images;
}

function mimeToExt(mime) {
    const decoded = mime.replace(/&quot;/g, '');
    if (decoded.includes('png')) return 'png';
    if (decoded.includes('gif')) return 'gif';
    if (decoded.includes('webp')) return 'webp';
    return 'jpg';
}

async function fetchPage(url, signal) {
    let response;
    try {
        response = await fetch(url, { signal });
    } catch (_) {
        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
        response = await fetch(proxyUrl, { signal });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

// Register
registerExtractor({
    id: 'gdrive',
    name: 'Google Drive',
    patterns: GDRIVE_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
