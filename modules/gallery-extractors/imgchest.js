/**
 * Imgchest Gallery Extractor
 *
 * Extracts images from imgchest.com post pages via embedded JSON data.
 * The page embeds a `data-page="..."` attribute containing a JSON object
 * with props.post.files[], each having a `link` to the CDN URL.
 *
 * Pattern: https://imgchest.com/p/{postId}
 * CDN URLs: https://cdn.imgchest.com/files/{filename}
 */

import { registerExtractor } from './extractor-registry.js';
import CoreAPI from '../core-api.js';

const IMGCHEST_PATTERNS = [
    /imgchest\.com\/p\/[a-zA-Z0-9]+/
];

const DATA_PAGE_REGEX = /data-page="([^"]+)"/;
const CDN_URL_REGEX = /https?:\/\/cdn\.imgchest\.com\/files\/[^\s"'<>]+?\.(png|jpe?g|gif|webp)/gi;
const PASSWORD_REGEX = /(?:pass\s*(?:word|code)|p\.?\s*w\.?|pass)\s*(?:[:=\-]|is)\s*["']?([^\s"'<>]+)/i;

const REQUEST_DELAY_MS = 300;
const CL_HELPER_BASE = '/plugins/cl-helper';
const _apiRequest = (...args) => CoreAPI.apiRequest(...args);

/**
 * @param {string} url - Imgchest post URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal, character } = opts;

    if (signal?.aborted) return { images: [], aborted: true };

    try {
        const html = await fetchPage(url, signal);

        if (isPasswordProtected(html)) {
            return await handlePasswordProtected(url, character, signal);
        }

        const images = extractFromDataPage(html);
        if (images.length > 0) return { images };

        const fallback = extractFromRegex(html);
        if (fallback.length > 0) return { images: fallback };

        return { images: [], error: 'No images found on page' };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

// ========================================================================
// Password-protected gallery handling
// ========================================================================

function isPasswordProtected(html) {
    return html.includes('PostPassword');
}

async function handlePasswordProtected(url, character, signal) {
    const password = extractPassword(character);
    if (!password) {
        return { images: [], error: 'Password-protected (no password found in card)' };
    }

    try {
        const health = await _apiRequest(`${CL_HELPER_BASE}/health`).catch(() => null);
        if (!health?.ok) {
            return { images: [], error: 'Password-protected (cl-helper plugin required)' };
        }

        const resp = await _apiRequest(`${CL_HELPER_BASE}/imgchest-unlock`, 'POST', { url, password }, { signal });

        const data = await resp.json();
        if (data.error) return { images: [], error: data.error };
        if (data.images?.length > 0) return { images: data.images };
        return { images: [], error: 'No images found after unlock' };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: `Unlock failed: ${err.message}` };
    }
}

function extractPassword(character) {
    if (!character) return null;
    const data = character.data || character;
    const texts = [];
    for (const f of ['creator_notes', 'description', 'personality', 'scenario', 'first_mes']) {
        if (data[f] && typeof data[f] === 'string') texts.push(data[f]);
    }
    const ext = data.extensions;
    if (ext && typeof ext === 'object') {
        for (const pd of Object.values(ext)) {
            if (pd?.tagline && typeof pd.tagline === 'string') texts.push(pd.tagline);
        }
    }
    for (const text of texts) {
        const stripped = text.replace(/<[^>]*>/g, ' ');
        const match = PASSWORD_REGEX.exec(stripped);
        if (match) return match[1];
    }
    return null;
}

function extractFromDataPage(html) {
    const match = DATA_PAGE_REGEX.exec(html);
    if (!match) return [];

    try {
        const ta = document.createElement('textarea');
        ta.innerHTML = match[1];
        const decoded = ta.value;

        const data = JSON.parse(decoded);
        const files = data?.props?.post?.files;
        if (!Array.isArray(files) || files.length === 0) return [];

        return files
            .filter(f => f.link && typeof f.link === 'string')
            .map(f => ({
                url: f.link,
                filename: f.link.split('/').pop()
            }));
    } catch {
        return [];
    }
}

function extractFromRegex(html) {
    const found = new Set();
    CDN_URL_REGEX.lastIndex = 0;
    let m;
    while ((m = CDN_URL_REGEX.exec(html)) !== null) {
        found.add(m[0]);
    }
    return [...found].map(imgUrl => ({
        url: imgUrl,
        filename: imgUrl.split('/').pop()
    }));
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
    id: 'imgchest',
    name: 'Imgchest',
    patterns: IMGCHEST_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
