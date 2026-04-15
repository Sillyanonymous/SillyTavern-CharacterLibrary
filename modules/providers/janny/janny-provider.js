// JannyAI Provider — implementation for JanitorAI/JannyAI character source
//
// Uses MeiliSearch API for character search and HTML scraping for full details.
// No version history (no Git-like API). No gallery support.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import jannyBrowseView from './janny-browse.js';
import {
    JANNY_SEARCH_URL,
    JANNY_IMAGE_BASE,
    JANNY_SITE_BASE,
    getSearchToken,
    fetchWithProxy,
    slugify,
    stripHtml,
    resolveTagNames
} from './janny-api.js';

let api = null;

// ========================================
// CONSTANTS
// ========================================

// ========================================
// PRIVATE UTILITIES
// ========================================

/**
 * Fetch an HTML page through multiple proxy strategies.
 *
 * Cloudflare protects jannyai.com and blocks automated requests via
 * TLS fingerprinting and JS challenges. Strategy order is based on
 * observed reliability:
 *
 * 1. corsproxy.io — most reliable in practice
 * 2. Puter.js WISP relay — needs COOP/COEP headers (SharedArrayBuffer);
 *    SillyTavern doesn't set these, so rustls.wasm fails on most setups
 * 3. SillyTavern /proxy/ — node-fetch with Node.js TLS fingerprint,
 *    Cloudflare usually blocks it with 403
 */
async function fetchHtmlPage(url) {
    const errors = [];

    // Strategy 1: corsproxy.io — most reliable based on real-world testing
    try {
        const html = await corsproxyFetchHtml(url);
        if (html) {
            console.info('[JannyProvider] Page fetched via corsproxy.io');
            return html;
        }
    } catch (e) {
        errors.push(`corsproxy.io: ${e.message}`);
        console.warn('[JannyProvider] corsproxy.io strategy failed:', e.message);
    }

    // Strategy 2: Puter.js WISP relay (only if not known-broken)
    if (!_puterBroken) {
        try {
            const html = await puterFetchHtml(url);
            if (html) {
                console.info('[JannyProvider] Page fetched via Puter.js');
                return html;
            }
        } catch (e) {
            errors.push(`Puter.js: ${e.message}`);
            console.warn('[JannyProvider] Puter.js strategy failed:', e.message);
        }
    }

    // Strategy 3: SillyTavern server-side proxy (node-fetch from user's IP)
    try {
        const html = await stProxyFetchHtml(url);
        if (html) {
            console.info('[JannyProvider] Page fetched via ST proxy');
            return html;
        }
    } catch (e) {
        errors.push(`ST proxy: ${e.message}`);
        console.warn('[JannyProvider] ST proxy strategy failed:', e.message);
    }

    throw new Error(`All proxy strategies failed for ${url}. Errors: ${errors.join(' | ')}`);
}

function isValidCharacterHtml(html) {
    if (!html || typeof html !== 'string') return false;
    if (html.length < 1000) return false;
    return html.includes('CharacterButtons') || html.includes('astro-island');
}

// ── Puter.js proxy helpers ──────────────────────────────────

const PUTER_FETCH_TIMEOUT = 30000;
const PUTER_MAX_REDIRECTS = 5;

let _puterBroken = false;

/**
 * Fetch via Puter.js with manual redirect following.
 * Puter.js uses rustls.wasm for TLS which requires SharedArrayBuffer
 * (needs Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy headers).
 * SillyTavern doesn't set these, so this will fail on most setups.
 * When it fails with a WASM/DOMException error, we set _puterBroken to
 * skip it on future calls.
 */
async function puterFetchHtml(url) {
    // Check if the environment even supports SharedArrayBuffer
    if (typeof SharedArrayBuffer === 'undefined') {
        _puterBroken = true;
        throw new Error('SharedArrayBuffer not available (missing COOP/COEP headers)');
    }

    if (!isPuterAvailable()) {
        throw new Error('Puter.js not loaded');
    }

    const headers = {
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'User-Agent': navigator.userAgent
    };

    let currentUrl = url;
    for (let i = 0; i <= PUTER_MAX_REDIRECTS; i++) {
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Puter.js fetch timed out (${PUTER_FETCH_TIMEOUT}ms)`)), PUTER_FETCH_TIMEOUT)
        );

        let r;
        try {
            r = await Promise.race([
                window.puter.net.fetch(currentUrl, { method: 'GET', headers }),
                timeout
            ]);
        } catch (e) {
            // Catch WASM/DOMException from rustls.js and permanently disable Puter
            if (e instanceof DOMException || e.message?.includes('WebAssembly') || e.message?.includes('serialize')) {
                _puterBroken = true;
                throw new Error('Puter.js WASM broken (missing COOP/COEP headers) — disabled for this session');
            }
            throw e;
        }

        // Follow redirects manually — puter.net.fetch uses raw HTTP/1.1
        if ([301, 302, 303, 307, 308].includes(r.status)) {
            const location = r.headers?.get?.('location') || r.headers?.get?.('Location');
            if (!location) break;
            currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
            continue;
        }

        if (!r.ok) throw new Error(`Puter HTTP ${r.status}`);

        const html = await r.text();
        if (isValidCharacterHtml(html)) return html;

        if (html.includes('Just a moment') || html.includes('cf-challenge') || html.includes('challenge-platform')) {
            throw new Error('Cloudflare challenge page received');
        }

        throw new Error(`Response does not contain character data (${html.length} bytes)`);
    }

    throw new Error('Too many redirects');
}

function isPuterAvailable() {
    return typeof window !== 'undefined'
        && window.puter?.net
        && typeof window.puter.net.fetch === 'function';
}

// ── SillyTavern proxy helper ────────────────────────────────

async function stProxyFetchHtml(url) {
    const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
    const r = await fetch(proxyUrl, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    if (r.status === 404) {
        const t = await r.text();
        if (t.includes('CORS proxy is disabled')) {
            throw new Error('ST CORS proxy is disabled — enable it in SillyTavern settings');
        }
        throw new Error('ST proxy returned 404');
    }

    if (!r.ok) throw new Error(`ST proxy HTTP ${r.status}`);

    const html = await r.text();
    if (isValidCharacterHtml(html)) return html;

    if (html.includes('Just a moment') || html.includes('cf-challenge')) {
        throw new Error('Cloudflare challenge page via ST proxy');
    }

    throw new Error(`ST proxy response not valid character page (${html.length} bytes)`);
}

// ── corsproxy.io helper ─────────────────────────────────────

async function corsproxyFetchHtml(url) {
    const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, {
        headers: {
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Origin': JANNY_SITE_BASE
        }
    });

    if (!r.ok) throw new Error(`corsproxy.io HTTP ${r.status}`);

    const html = await r.text();
    if (isValidCharacterHtml(html)) return html;

    throw new Error(`corsproxy.io response not valid character page (${html.length} bytes)`);
}

/**
 * Decode Astro's island props serialization format.
 * Values are [type, data] where type 0 = primitive/object, 1 = array.
 */
function decodeAstroValue(value) {
    if (!Array.isArray(value)) return value;
    const [type, data] = value;
    if (type === 0) {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            const decoded = {};
            for (const [key, val] of Object.entries(data)) {
                decoded[key] = decodeAstroValue(val);
            }
            return decoded;
        }
        return data;
    } else if (type === 1) {
        return data.map(item => decodeAstroValue(item));
    }
    return data;
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search JannyAI characters via MeiliSearch.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=40]
 * @returns {Promise<Object>} MeiliSearch multi-search response
 */
async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 40 } = opts;

    const filters = ['totalToken <= 4101 AND totalToken >= 29'];
    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isLowQuality', 'tagIds', 'totalToken'],
            attributesToCrop: ['description:300'],
            cropMarker: '...',
            filter: filters,
            attributesToHighlight: ['name', 'description'],
            highlightPreTag: '__ais-highlight__',
            highlightPostTag: '__/ais-highlight__',
            hitsPerPage: limit,
            page,
            sort: ['createdAtStamp:desc']
        }]
    };

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)'
    };

    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`JannyAI search error ${response.status}: ${text}`);
    }

    return response.json();
}

/**
 * Fetch full character data by scraping the JannyAI character page.
 * Extracts Astro island props containing the full definition.
 */
async function fetchCharacterDetails(characterId, slug) {
    const url = `${JANNY_SITE_BASE}/characters/${characterId}_${slug || 'character'}`;
    console.info(`[JannyProvider] Fetching character details: ${url}`);

    const html = await fetchHtmlPage(url);
    console.info(`[JannyProvider] Got HTML (${html.length} bytes), parsing Astro props...`);

    // Try CharacterButtons first, then fallback to any astro-island with character props
    let astroMatch = html.match(
        /astro-island[^>]*component-export="CharacterButtons"[^>]*props="([^"]+)"/
    );
    if (!astroMatch) {
        astroMatch = html.match(/astro-island[^>]*props="([^"]*character[^"]*)"/);
    }
    if (!astroMatch) {
        const islandCount = (html.match(/astro-island/g) || []).length;
        console.error(`[JannyProvider] No character Astro island found. ${islandCount} islands total.`);
        throw new Error(`Could not parse JannyAI character page (${islandCount} astro-islands, none with character data)`);
    }

    const propsDecoded = astroMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");

    const propsJson = JSON.parse(propsDecoded);
    const character = decodeAstroValue(propsJson.character);
    const imageUrl = decodeAstroValue(propsJson.imageUrl);

    // Extract creator username from page HTML (rendered server-side as "Creator: @username")
    let creatorUsername = null;
    const creatorMatch = html.match(/Creator:\s*(?:<\/[^>]+>\s*)?<a[^>]*>@?([^<]+)<\/a>/);
    if (creatorMatch) {
        creatorUsername = creatorMatch[1].trim();
    }
    if (creatorUsername && character) {
        character.creatorUsername = creatorUsername;
    }

    if (character?.personality || character?.firstMessage) {
        console.info(`[JannyProvider] Character "${character.name}" parsed — personality: ${(character.personality || '').length} chars, firstMsg: ${(character.firstMessage || '').length} chars${creatorUsername ? `, creator: @${creatorUsername}` : ''}`);
    } else {
        console.warn(`[JannyProvider] Character parsed but missing definition fields:`, Object.keys(character || {}));
    }

    return { character, imageUrl };
}

/**
 * Map a MeiliSearch hit to a V2-compatible flat field object for import/diff.
 * JannyAI field mapping:
 *   - "personality" → V2 "description" (main character definition)
 *   - "description" → website blurb → V2 "creator_notes"
 *   - "firstMessage" → V2 "first_mes"
 *   - "exampleDialogs" → V2 "mes_example"
 *   - "scenario" → V2 "scenario"
 */
function buildV2FromDetails(charData) {
    const char = charData.character || charData;
    const rawDesc = char.description || '';
    const plainDesc = stripHtml(rawDesc) || '';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: char.name || 'Unnamed',
            description: char.personality || '',
            personality: '',
            scenario: char.scenario || '',
            first_mes: char.firstMessage || '',
            mes_example: char.exampleDialogs || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: rawDesc,
            creator: char.creatorUsername || char.creatorId || '',
            character_version: '1.0',
            tags: resolveTagNames(char.tagIds),
            alternate_greetings: [],
            extensions: {
                jannyai: {
                    id: char.id,
                    creatorId: char.creatorId || null,
                    tagline: plainDesc
                }
            },
            character_book: undefined
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class JannyProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'jannyai'; }
    get name() { return 'JannyAI'; }
    get icon() { return 'fa-solid fa-robot'; }
    get iconUrl() { return 'https://tse3.mm.bing.net/th/id/OIP.nb-qi0od9W6zRsskVwL6QAHaHa?rs=1&pid=ImgDetMain&o=7&rm=3'; }
    get browseView() { return jannyBrowseView; }

    get linkStatFields() {
        return {
            stat1: null,
            stat2: null,
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return jannyBrowseView.renderFilterBar(); }
    renderView() { return jannyBrowseView.renderView(); }
    renderModals() { return jannyBrowseView.renderModals(); }

    async activate(container, options = {}) {
        jannyBrowseView.activate(container, options);
    }

    deactivate() {
        jannyBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const janny = extensions?.jannyai;
        if (!janny) return null;

        const id = janny.id;
        if (!id) return null;

        return {
            providerId: 'jannyai',
            id,
            fullPath: janny.slug ? `${id}_${janny.slug}` : String(id),
            linkedAt: janny.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.jannyai || {};
            char.data.extensions.jannyai = {
                id: linkInfo.id,
                slug: linkInfo.slug || null,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.jannyai;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            // Derive a search term from the slug portion of fullPath
            const parts = String(linkInfo.fullPath || '').split('_');
            const slugPart = parts.slice(1).join('_').replace(/^character-/, '');
            const searchName = slugPart.replace(/-/g, ' ').trim();
            if (!searchName) return null;

            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === linkInfo.id);
            if (!match) return null;

            return {
                stat1: null,
                stat2: null,
                stat3: match.totalToken || 0
            };
        } catch (e) {
            api?.debugLog?.('[JannyProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const parts = String(fullPath).split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';
            const data = await fetchCharacterDetails(charId, slug);
            return data?.character || null;
        } catch (e) {
            console.error('[JannyProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const slug = linkInfo.slug || slugify(linkInfo.name || '');
            const data = await fetchCharacterDetails(linkInfo.id, slug);
            if (data) {
                const result = buildV2FromDetails(data);
                if (result) result._listingName = this.getListingName(data);
                return result;
            }
            return null;
        } catch (e) {
            console.error('[JannyProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return buildV2FromDetails(rawData);
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.jannyai.tagline',
                label: "Creator's Notes",
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Version History ─────────────────────────────────────

    // JannyAI has no public version/commit history API
    get supportsVersionHistory() { return false; }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        return `https://jannyai.com/characters/${linkInfo.fullPath}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        // Derive a search term from the slug to find this character remotely
        const parts = String(linkInfo.fullPath || '').split('_');
        const slugPart = parts.slice(1).join('_').replace(/^character-/, '');
        const searchName = slugPart.replace(/-/g, ' ').trim() || char?.name || '';
        if (!searchName) return null;

        try {
            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === charId);
            if (match) return match;
        } catch (e) {
            console.warn('[JannyProvider] buildPreviewObject search failed:', e.message);
        }

        // Fallback to local data if remote fetch failed
        const jannyData = char?.data?.extensions?.jannyai || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: jannyData.avatar || '',
            tagIds: jannyData.tagIds || [],
            totalToken: jannyData.totalToken || char?.data?.extensions?.total_tokens || 0,
            createdAtStamp: jannyData.createdAtStamp || 0,
            creatorId: jannyData.creatorId || char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openJannyCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.jannyai;

        // Card already has Janny metadata (previously imported via our app)
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'jannyai',
                    charId: ext.id,
                    fullPath: ext.slug ? `${ext.id}_${ext.slug}` : String(ext.id),
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        }

        // No Janny extensions — try to find this character on JannyAI
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            // Require exact name match
            const normalizedName = name.toLowerCase().trim();
            const match = results.find(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (!match) return null;

            // Fetch full details for proper V2 field mapping
            const parts = match.fullPath.split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';

            const data = await fetchCharacterDetails(charId, slug);
            if (!data?.character) return null;

            const char = data.character;

            // Verify creator matches when both sides have one — prevents
            // false-claiming cards that belong to a different provider
            if (creator && char.creatorUsername) {
                if (creator.toLowerCase() !== char.creatorUsername.toLowerCase()) {
                    return null;
                }
            }

            // Backfill tags/creatorId from MeiliSearch
            if (!char.tagIds?.length || !char.creatorId) {
                try {
                    const searchData = await searchJanny({ search: name, page: 1, limit: 20 });
                    const hits = searchData?.results?.[0]?.hits || [];
                    const hitMatch = hits.find(h => h.id === charId);
                    if (hitMatch) {
                        if (!char.tagIds?.length && hitMatch.tagIds) char.tagIds = hitMatch.tagIds;
                        if (!char.creatorId && hitMatch.creatorId) char.creatorId = hitMatch.creatorId;
                    }
                } catch (_) { /* best-effort */ }
            }

            // Build properly-mapped V2 card (personality → description, etc.)
            const enrichedCard = buildV2FromDetails(data);

            if (!enrichedCard.data.extensions) enrichedCard.data.extensions = {};
            enrichedCard.data.extensions.jannyai = {
                ...(enrichedCard.data.extensions.jannyai || {}),
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug,
                linkedAt: new Date().toISOString(),
                tagline: stripHtml(enrichedCard.data.creator_notes) || '',
                pageName: this.getListingName(char),
            };

            // Preserve gallery_id from original card
            if (cardData.data?.extensions?.gallery_id) {
                enrichedCard.data.extensions.gallery_id = cardData.data.extensions.gallery_id;
            }

            return {
                cardData: enrichedCard,
                providerInfo: {
                    providerId: 'jannyai',
                    charId,
                    fullPath: match.fullPath,
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        } catch (e) {
            console.warn('[JannyProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // ── Authentication ──────────────────────────────────────

    // JannyAI MeiliSearch uses a public key, no user auth needed
    get hasAuth() { return false; }

    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?jannyai\.com$/i.test(u.hostname)
                || /^(www\.)?janitorai\.com$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Path: /characters/{uuid}_{slug}
            const match = u.pathname.match(/\/characters\/([a-f0-9-]+(?:_[^/]*)?)/i);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from JannyAI.
     * @param {string} identifier - e.g. "uuid_slug"
     * @param {Object} [hitData] - Optional pre-fetched character data or MeiliSearch hit.
     *   If hitData has definition fields (personality, firstMessage), it's used directly
     *   to avoid a redundant page scrape.
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const parts = String(identifier).split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';

            let data;

            // If hitData already has definition fields (e.g., from preview modal fetch),
            // use it directly — no need to scrape the page a second time
            const hasDefinitionFields = hitData && (hitData.personality || hitData.firstMessage);
            if (hasDefinitionFields) {
                console.info('[JannyProvider] Using pre-fetched character data for import');
                data = { character: hitData, imageUrl: hitData.avatar ? `${JANNY_IMAGE_BASE}${hitData.avatar}` : null };
            }

            if (!data?.character) {
                try {
                    data = await fetchCharacterDetails(charId, slug);
                } catch (e) {
                    console.warn('[JannyProvider] Page scrape failed, falling back to hit data:', e.message);
                }
            }

            // Fall back to raw MeiliSearch hit data if scrape failed (definitions will be empty)
            if (!data?.character && hitData) {
                console.warn('[JannyProvider] Using MeiliSearch hit as last resort — definitions will be incomplete');
                data = { character: hitData, imageUrl: hitData.avatar ? `${JANNY_IMAGE_BASE}${hitData.avatar}` : null };
            }
            if (!data?.character) throw new Error('Could not fetch character data from JannyAI');

            const char = data.character;
            const characterName = char.name || 'Unnamed';

            // Page scrape often lacks tagIds/creatorId — backfill from MeiliSearch
            if (!char.tagIds?.length || !char.creatorId) {
                try {
                    const searchData = await searchJanny({ search: char.name || '', page: 1, limit: 20 });
                    const hits = searchData?.results?.[0]?.hits || [];
                    const match = hits.find(h => h.id === charId);
                    if (match) {
                        if (!char.tagIds?.length && match.tagIds) char.tagIds = match.tagIds;
                        if (!char.creatorId && match.creatorId) char.creatorId = match.creatorId;
                    }
                } catch (e) {
                    console.warn('[JannyProvider] MeiliSearch backfill failed:', e.message);
                }
            }

            const characterCard = buildV2FromDetails(data);

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existingJanny = characterCard.data.extensions.jannyai || {};
            characterCard.data.extensions.jannyai = {
                ...existingJanny,
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug: slug,
                linkedAt: new Date().toISOString(),
                tagline: stripHtml(characterCard.data.creator_notes) || existingJanny.tagline || '',
                pageName: this.getListingName(char),
            };

            // Gallery ID: inherit from replaced character, or generate new
            assignGalleryId(characterCard, options, api);

            // Download avatar
            const avatarUrl = data.imageUrl || (char.avatar ? `${JANNY_IMAGE_BASE}${char.avatar}` : null);
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[JannyProvider] Avatar download failed:', e.message);
                }
            }

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `janny_${slugify(characterName)}.png`,
                characterName, hasGallery: false,
                providerCharId: charId,
                fullPath: identifier,
                avatarUrl: avatarUrl || null,
                api
            });
        } catch (error) {
            console.error(`[JannyProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        // JannyAI needs no user-configurable settings for now.
        // The MeiliSearch token is fetched automatically.
        return [];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    /**
     * Search JannyAI for characters matching a local character's name.
     * JannyAI doesn't expose creator names in search results, so matching
     * relies on name similarity and token counts.
     */
    async searchForBulkLink(name, creator) {
        try {
            // JannyAI has no creator filter — search by name only
            const searchTerm = name;
            const data = await searchJanny({ search: searchTerm, page: 1, limit: 15 });
            const hits = data?.results?.[0]?.hits || [];

            return hits.map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[JannyProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Private Helpers ─────────────────────────────────────

    _normalizeSearchResult(hit) {
        const slug = slugify(hit.name);
        const plainDesc = stripHtml(hit.description) || '';
        return {
            id: hit.id || null,
            fullPath: hit.id ? `${hit.id}_character-${slug}` : '',
            name: hit.name || 'Unnamed',
            avatarUrl: hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '',
            rating: 0,
            starCount: 0,
            description: plainDesc,
            rawDescription: hit.description || '',
            tagline: plainDesc,
            nTokens: hit.totalToken || 0,
            slug
        };
    }
}

const jannyProvider = new JannyProvider();
export default jannyProvider;
