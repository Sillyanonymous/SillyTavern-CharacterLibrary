// BrowseView - base class for provider browse views in the Online tab

import CoreAPI from '../core-api.js';
import { normalizeBrowseName, isMobileMode, scrollBrowseListTop, fetchWithProxy, slugify } from './provider-utils.js';
import { CHUB_API_BASE, getChubHeaders, extractNodes } from './chub/chub-api.js';
import { BOTBOORU_BASE, fetchBotbooruUser } from './botbooru/botbooru-api.js';
import { fetchCharactersByOwner, getCharacterPageUrl } from './pygmalion/pygmalion-api.js';
import { WYVERN_API_BASE, WYVERN_SITE_BASE, getWyvernHeaders } from './wyvern/wyvern-api.js';
import { fetchDatacatCreatorCharacters, fetchSaucepanCompanionsOfUser, fetchDatacatCharacter, submitExtraction, fetchExtractionStatus } from './datacat/datacat-api.js';
import { getSearchToken, JANNY_SEARCH_URL, JANNY_SITE_BASE } from './janny/janny-api.js';
import { searchCards, isCtSessionActive } from './chartavern/chartavern-api.js';

// ── Shared In-Library lookup base ────────────────────────
// byNameAndCreator + byNormalizedName are pure functions of the global character list, so
// theyre byte-identical for every provider. Compute them ONCE and share by reference across
// all browse views; only byProviderId is per-provider. A generation token invalidates the
// shared base whenever the character list changes (full reload, delete, import).
const _sharedBaseLookup = {
    byNameAndCreator: new Set(),
    byNormalizedName: new Map(),
    gen: -1,
};

// Mobile: reset the browse list to the top on a sort change or a Browse/Following toggle.
let _browseScrollResetWired = false;
function wireBrowseScrollReset() {
    if (_browseScrollResetWired) return;
    const filterArea = document.getElementById('onlineFilterContent');
    const onlineView = document.getElementById('onlineView');
    if (!filterArea || !onlineView) return;
    _browseScrollResetWired = true;
    // Every browse <select> is a sort control (some in the filter bar, some in the view), so bind both.
    const onSortChange = (e) => {
        if (e.target?.tagName === 'SELECT') scrollBrowseListTop();
    };
    filterArea.addEventListener('change', onSortChange);
    onlineView.addEventListener('change', onSortChange);
    // Browse/Following tabs render into the filter bar.
    filterArea.addEventListener('click', (e) => {
        if (e.target?.closest?.('[class*="-view-btn"]')) scrollBrowseListTop();
    });
}
let _baseLookupGen = 0;
// getPossibleMatchScore reads only the shared base, so a name|creator score is identical for every
// provider. Memo the SCORE cross-provider (threshold-independent, so the sensitivity slider re-reads
// it for free); cleared when the base gen advances or a char is added incrementally.
const _possibleMatchMemo = new Map();
let _possibleMatchMemoGen = -1;

// Possible-match scoring: 0-100. The sensitivity slider (possibleMatchMinScore) sets the show cutoff;
// the tier bands are fixed so a card reads the same intensity regardless ofthe chosen cutoff.
const POSSIBLE_MATCH_DEFAULT_MIN_SCORE = 65;
const POSSIBLE_MATCH_TIER_HIGH = 85;
const POSSIBLE_MATCH_TIER_MED = 65;
function getPossibleMatchMinScore() {
    const n = Number(CoreAPI.getSetting('possibleMatchMinScore'));
    return Number.isFinite(n) ? n : POSSIBLE_MATCH_DEFAULT_MIN_SCORE;
}

/** Mark the shared base stale so the next build recomputes it. O(1). */
export function invalidateSharedBaseLookup() {
    _baseLookupGen++;
}

/** Normalized name variants for cross-provider matching (|| splits to its primary). */
function computeNameVariants(rawName) {
    const full = normalizeBrowseName(rawName);
    const variants = new Set();
    if (full.length >= 4) variants.add(full);
    if (rawName.includes('||')) {
        const primary = normalizeBrowseName(rawName.split('||')[0]);
        if (primary.length >= 4) variants.add(primary);
    }
    return variants;
}

function buildSharedBaseLookup() {
    const byNameAndCreator = new Set();
    const byNormalizedName = new Map();
    for (const char of CoreAPI.getAllCharacters()) {
        if (!char) continue;
        const name = (char.name || '').toLowerCase().trim();
        const creator = String(char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) byNameAndCreator.add(`${name}|${creator}`);
        for (const variant of computeNameVariants(char.name || '')) {
            let creatorSet = byNormalizedName.get(variant);
            if (!creatorSet) { creatorSet = new Set(); byNormalizedName.set(variant, creatorSet); }
            if (creator) creatorSet.add(creator);
        }
    }
    _sharedBaseLookup.byNameAndCreator = byNameAndCreator;
    _sharedBaseLookup.byNormalizedName = byNormalizedName;
    _sharedBaseLookup.gen = _baseLookupGen;
}

function ensureSharedBaseLookup() {
    if (_sharedBaseLookup.gen !== _baseLookupGen) buildSharedBaseLookup();
}

// ── Per-provider batch fetch/import table ────────────────
// Providers stamp their live creator-filter state onto view._cdRef at their
// filter entry point; everything else reads from here.

function cdMediaEntry(result, extra = {}) {
    return {
        name: result.characterName,
        avatar: result.fileName,
        avatarUrl: result.avatarUrl,
        mediaUrls: result.embeddedMediaUrls || [],
        galleryPageUrls: result.galleryPageUrls || [],
        galleryId: result.galleryId,
        cardData: result.cardData,
        ...extra,
    };
}

function cdHasMedia(result) {
    return (result.embeddedMediaUrls?.length || 0) > 0 || (result.galleryPageUrls?.length || 0) > 0;
}

let _cdActiveView = null;

const cdCharId = (hit) => hit?.characterId || hit?.character_id || hit?.id || '';
const cdSourceKind = (hit) => hit?.primary_content_source_kind === 'saucepan' ? 'saucepan' : 'janitor';

async function cdDatacatExtract(view, charId, sourceKind) {
    const urlBase = sourceKind === 'saucepan' ? 'https://saucepan.ai/companion/' : 'https://janitorai.com/characters/';
    const url = `${urlBase}${charId}`;
    const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;
    // anon sessions cap at 3 jobs and timed-out jobs stay alive server-side (no cancel API), so wait for a slot
    let sub = null;
    const slotDeadline = Date.now() + 120000;
    for (;;) {
        sub = await submitExtraction(url, { publicFeed }).catch(() => null);
        const errText = String(sub?.error || sub?.message || '');
        const capped = /Server returned 429/.test(errText) || /already have \d+ jobs/i.test(errText);
        if (!capped) break;
        if (view._cdCancelled || Date.now() >= slotDeadline) {
            view._dcJammed = true;
            return null;
        }
        await new Promise(r => setTimeout(r, 12000));
    }
    if (!sub || sub.error || sub.success === false) return null;
    const targetId = String(charId).trim();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (view._cdCancelled) return null;
        await new Promise(r => setTimeout(r, 3000));
        const status = await fetchExtractionStatus().catch(() => null);
        if (!status) continue;
        const entry = status.history?.find(h => String(h.characterId || '').trim() === targetId);
        if (!entry) continue;
        if (entry.success === false || entry.status === 'error') {
            CoreAPI.debugLog?.('[Browse] extraction failed:', charId, entry.error || entry.message);
            return null;
        }
        await new Promise(r => setTimeout(r, 1000));
        let character = await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
        if (!character) {
            await new Promise(r => setTimeout(r, 2000));
            character = await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
        }
        return character;
    }
    return null;
}

const CD_ADAPTERS = {
    chub: {
        async fetchAll(view) {
            const authorName = view._cdRef?.name;
            if (!authorName) return [];
            const nsfw = (CoreAPI.getSetting('chubNsfw') === true).toString();
            const results = [];
            const seen = new Set();
            const MAX_PAGES = 200;
            for (let page = 1; page <= MAX_PAGES; page++) {
                const params = new URLSearchParams();
                params.set('first', '48');
                params.set('page', String(page));
                params.set('username', authorName);
                params.set('sort', 'id');
                params.set('nsfw', nsfw);
                params.set('nsfl', nsfw);
                params.set('include_forks', 'true');
                params.set('venus', 'false');
                params.set('min_tokens', '50');
                const resp = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, { headers: getChubHeaders(true) });
                if (!resp.ok) throw new Error(`ChubAI API error ${resp.status}`);
                const data = await resp.json();
                const nodes = extractNodes(data);
                let added = 0;
                for (const node of nodes) {
                    const fp = node.fullPath || node.full_path || '';
                    if (!fp || seen.has(fp)) continue;
                    seen.add(fp);
                    added++;
                    results.push({ key: fp.toLowerCase(), name: node.name || '', creator: fp.split('/')[0] || '', raw: node });
                }
                const hasMore = (data.data?.cursor ?? data.cursor) != null && nodes.length > 0;
                if (!hasMore || added === 0) break;
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('chub');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const fullPath = card.raw.fullPath || card.raw.full_path || '';
            const result = await provider.importCharacter(fullPath, card.raw, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: `https://chub.ai/characters/${result.fullPath}`,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                }] : [],
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    botbooru: {
        async fetchAll(view) {
            const uploader = view._cdRef;
            if (!uploader?.id) return [];
            const results = [];
            const seen = new Set();
            const PAGE = 50;
            for (let offset = 0; ; offset += PAGE) {
                const user = await fetchBotbooruUser(uploader.id, { uploadLimit: PAGE, uploadOffset: offset, uploadSort: 'latest' });
                if (!user) throw new Error('Botbooru user fetch failed');
                const uploads = Array.isArray(user.uploads) ? user.uploads : [];
                let added = 0;
                for (const post of uploads) {
                    const key = String(post.id);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    added++;
                    if (post.uploader_id == null) post.uploader_id = Number(uploader.id);
                    results.push({ key, name: post.character_name || '', creator: uploader.name || '', raw: post });
                }
                const total = user.uploads_list_total ?? 0;
                if (added === 0 || uploads.length < PAGE || (total > 0 && results.length >= total)) break;
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('botbooru');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const post = card.raw;
            const result = await provider.importCharacter(String(post.id), post, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: `${BOTBOORU_BASE}/character/${post.id}`,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                }] : [],
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    pygmalion: {
        async fetchAll(view) {
            const ownerId = view._cdRef?.ownerId;
            if (!ownerId) return [];
            const token = CoreAPI.getSetting('pygmalionToken') || undefined;
            const results = [];
            const seen = new Set();
            const PAGE = 48;
            for (let page = 0; ; page++) {
                const data = await fetchCharactersByOwner(ownerId, 'approved_at', page, token);
                const hits = data?.characters || [];
                let added = 0;
                for (const hit of hits) {
                    if (!hit.id || seen.has(hit.id)) continue;
                    seen.add(hit.id);
                    added++;
                    const owner = hit.owner || {};
                    results.push({ key: hit.id, name: hit.displayName || hit.name || '', creator: owner.username || owner.displayName || '', raw: hit });
                }
                const totalItems = parseInt(data?.totalItems || '0', 10);
                if (hits.length < PAGE || added === 0 || (totalItems > 0 && results.length >= totalItems)) break;
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('pygmalion');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const hit = card.raw;
            const result = await provider.importCharacter(hit.id, hit, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: getCharacterPageUrl(result.providerCharId),
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                }] : [],
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    wyvern: {
        async fetchAll(view) {
            const uid = view._cdRef?.uid;
            if (!uid) return [];
            const headers = getWyvernHeaders(!!view._cdRef?.nsfwAuth);
            const resp = await fetchWithProxy(`${WYVERN_API_BASE}/characters/user/${uid}`, { method: 'GET', headers });
            if (!resp.ok) throw new Error(`API error: ${resp.status}`);
            const data = await resp.json();
            const nodes = data.characters || data.results || [];
            const results = [];
            const seen = new Set();
            for (const node of nodes) {
                if (!node.id || seen.has(node.id)) continue;
                seen.add(node.id);
                results.push({ key: node.id, name: node.name || '', creator: node.creator?.displayName || node.creator?.username || '', raw: node });
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('wyvern');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const node = card.raw;
            const result = await provider.importCharacter(node.id, node, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: `${WYVERN_SITE_BASE}/characters/${result.providerCharId}`,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                }] : [],
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    datacat: {
        async fetchAll(view) {
            const ref = view._cdRef;
            if (!ref?.creatorId) return [];
            view._dcJammed = false;
            const results = [];
            const seen = new Set();
            const push = (hit) => {
                const id = cdCharId(hit);
                if (id == null || id === '') return;
                const key = String(id);
                if (seen.has(key)) return;
                seen.add(key);
                results.push({ key, name: hit.name || '', creator: hit.creator_name || hit.creatorName || ref.name || '', raw: hit });
            };
            if (ref.source === 'saucepan') {
                const data = await fetchSaucepanCompanionsOfUser(ref.handle);
                for (const hit of (data?.characters || [])) push(hit);
            } else {
                const PAGE = 80;
                for (let offset = 0; ; offset += PAGE) {
                    const data = await fetchDatacatCreatorCharacters(ref.creatorId, { limit: PAGE, offset, sortBy: 'chat_count' });
                    if (!data) {
                        if (offset === 0) throw new Error('DataCat creator fetch failed');
                        break;
                    }
                    const list = data?.list || [];
                    const before = results.length;
                    for (const hit of list) push(hit);
                    const total = data?.total || 0;
                    if (results.length === before || list.length < PAGE || (total > 0 && results.length >= total)) break;
                }
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('datacat');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const hit = card.raw;
            const charId = cdCharId(hit);
            const sourceKind = cdSourceKind(hit);
            let character = hit._fullCharacter || await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
            if (!character) {
                // once the server queue is provably full, dont burn 2 min per remaining card
                if (view._dcJammed) return { ok: false, error: 'Extraction queue full (skipped)' };
                character = await cdDatacatExtract(view, charId, sourceKind);
                if (!character) {
                    return { ok: false, error: view._dcJammed ? 'Extraction queue full' : 'Extraction failed or timed out' };
                }
            }
            const result = await provider.importCharacter(charId, character, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    provider,
                    linkInfo: { providerId: 'datacat', id: result.providerCharId },
                    url: `https://datacat.run/characters/${result.providerCharId}`,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                    cardData: result.cardData,
                }] : [],
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result, { characterName: result.characterName, fileName: result.fileName })] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    jannyai: {
        async fetchAll(view) {
            const authorName = view._cdRef?.creatorName;
            if (!authorName) return [];
            const wanted = authorName.toLowerCase();
            const nsfw = CoreAPI.getSetting('jannyNsfw') === true;
            const token = await getSearchToken();
            const headers = {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Origin': JANNY_SITE_BASE,
                'Referer': `${JANNY_SITE_BASE}/`,
                'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
            };
            const results = [];
            const seen = new Set();
            const MAX_PAGES = 50;
            for (let page = 1; page <= MAX_PAGES; page++) {
                const body = JSON.stringify({ queries: [{
                    indexUid: 'janny-characters',
                    q: authorName,
                    filter: nsfw ? [] : ['isNsfw = false'],
                    hitsPerPage: 80,
                    page,
                }] });
                let resp;
                try {
                    resp = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body });
                } catch (_) {
                    resp = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body });
                }
                if (!resp.ok) throw new Error(`JannyAI search error ${resp.status}`);
                const data = await resp.json();
                const result = data?.results?.[0];
                const hits = result?.hits || [];
                for (const hit of hits) {
                    if (!hit.id || seen.has(String(hit.id))) continue;
                    // author view is a text search; keep exact creator matches only
                    if ((hit.creatorUsername || '').toLowerCase() !== wanted) continue;
                    seen.add(String(hit.id));
                    results.push({ key: String(hit.id), name: hit.name || '', creator: hit.creatorUsername || '', raw: hit });
                }
                const totalPages = result?.totalPages || 1;
                if (page >= totalPages || hits.length === 0) break;
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('jannyai');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const hit = card.raw;
            const identifier = `${hit.id}_character-${slugify(hit.name || 'character')}`;
            const result = await provider.importCharacter(identifier, hit, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = {
                mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result, { characterName: result.characterName, fileName: result.fileName })] : [],
            };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
    chartavern: {
        async fetchAll(view) {
            const authorName = view._cdRef?.name;
            if (!authorName) return [];
            const wanted = authorName.toLowerCase();
            const nsfw = CoreAPI.getSetting('ctNsfw') === true && isCtSessionActive();
            const sort = document.getElementById('ctSortSelect')?.value || 'most_popular';
            const results = [];
            const seen = new Set();
            const MAX_PAGES = 50;
            for (let page = 1; page <= MAX_PAGES; page++) {
                const data = await searchCards({ query: authorName, sort, page, limit: 60, nsfw }, CoreAPI.apiRequest);
                const hits = data?.hits || [];
                for (const hit of hits) {
                    const path = hit.path || '';
                    if (!path || seen.has(path)) continue;
                    // exclude_tags alone doesnt catch all isNSFW cards
                    if (!nsfw && hit.isNSFW) continue;
                    const hitAuthor = (hit.author_username || hit.author || path.split('/')[0] || '').toLowerCase();
                    if (hitAuthor !== wanted) continue;
                    seen.add(path);
                    results.push({ key: path, name: hit.name || '', creator: hit.author_username || hit.author || '', raw: hit });
                }
                const totalPages = data?.totalPages || 1;
                if (page >= totalPages || hits.length === 0) break;
            }
            return results;
        },
        async importOne(view, card) {
            const provider = CoreAPI.getProvider('chartavern');
            if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
            const hit = card.raw;
            const result = await provider.importCharacter(hit.path, hit, {});
            if (!result.success) return { ok: false, error: result.error || 'Import failed' };
            const summaryArgs = { mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [] };
            return { ok: true, avatarFileName: result.fileName, summaryArgs };
        },
    },
};

/**
 * Base class for Online tab browse views.
 * Subclasses MUST override at least renderView().
 */
export class BrowseView {
    /**
     * @param {import('./provider-interface.js').ProviderBase} provider
     */
    constructor(provider) {
        this.provider = provider;
        this._initialized = false;
        this._modalsInjected = false;
        this._imageObserver = null;
        this._dropdownCloseHandler = null;
        this._scrollHandler = null;
        this._scrollIndicator = null;
        this._prefetching = false;
        this._preloadLimit = 48;
        this._lookup = {
            byNameAndCreator: new Set(),
            byProviderId: new Set(),
            byNormalizedName: new Map(), // normalized name → Set<normalized creator>
        };
        // Following manager state
        this._mgrOpen = false;
        this._mgrCreators = [];
        this._mgrFilter = '';
        this._mgrSort = 'name_asc';
        this._mgrDebounceTimer = null;
        this._mgrConfirmTimer = null;
    }

    // ── HTML Rendering ──────────────────────────────────────

    /**
     * Return filter bar HTML for the topbar filters-wrapper area.
     * Called once; injected into #onlineFilterArea by the registry.
     * @returns {string}
     */
    renderFilterBar() { return ''; }

    /**
     * Return main view HTML (grids, search bars, etc.).
     * Called once; injected into #onlineView by the registry.
     * @returns {string}
     */
    renderView() { return ''; }

    /**
     * Return modal HTML to append to document.body.
     * Called once during first activation.
     * @returns {string}
     */
    renderModals() { return ''; }

    // ── Lifecycle ───────────────────────────────────────────

    /**
     * One-time setup after HTML has been injected into the DOM.
     * Subclasses attach event handlers here.
     */
    init() {
        this._initialized = true;
        wireBrowseScrollReset();
        if (this.supportsFollowingManager) {
            this._initFollowingManager();
        }
    }

    /**
     * Called every time the Online tab shows this provider's view.
     * First call should trigger init() if not yet done.
     * @param {HTMLElement} container - #onlineView element
     * @param {Object} [options]
     * @param {boolean} [options.domRecreated] - true when the DOM was
     *   destroyed and rebuilt by the registry (provider switch).
     */
    activate(container, options = {}) {
        if (options.domRecreated) {
            this._initialized = false;
        }
        if (!this._initialized) {
            this.injectModals();
            this.init();
        }
        // Apply saved defaults on first activation with DOM rebuild
        if (options.domRecreated && options.defaults) {
            this.applyDefaults(options.defaults);
        }
        // Re-register dropdown dismiss after deactivate removed it
        if (this._dropdownDismissPairs && !this._dropdownCloseHandler) {
            this._registerDropdownDismiss(this._dropdownDismissPairs);
        }
        // Attach infinite scroll listener
        this._attachScrollListener();
        if (this.creatorDownloadEnabled()) {
            this._injectCreatorDownloadButton(container);
        }
    }

    /**
     * Apply saved default view/sort settings from the settings modal.
     * Called once on first activation when domRecreated is true.
     * Subclasses override to set their specific selects/toggles.
     * Sort-only providers set the sort variable + DOM element.
     * View+sort providers set the view mode variable (the activate()
     * continuation uses it for data loading) and sort.
     * @param {Object} defaults - { view?: string, sort?: string }
     */
    applyDefaults(defaults) {
        // Base implementation - no-op. Subclasses override.
    }

    // ── Search contract (mobile FAB overlay) ──

    /** @returns {Array<'character' | 'creator'>} */
    getSearchModes() { return ['character']; }

    /** @returns {string | null} DOM id of the inline input to proxy. */
    getSearchInputId(mode) { return null; }

    /** @returns {string} placeholder for the mobile search overlay input. */
    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Creator name...' : 'Character name...';
    }

    /** @returns {string} tab label for the mobile search overlay mode. */
    getSearchModeLabel(mode) {
        return mode === 'creator' ? 'Creator' : 'Character';
    }

    /** Default proxies through the inline input + submit button (or Enter). */
    performSearch(mode, query) {
        const inputId = this.getSearchInputId(mode);
        if (!inputId) return;
        const input = document.getElementById(inputId);
        if (!input) return;
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const submitBtn = input.parentElement?.querySelector('.browse-search-submit');
        if (submitBtn) {
            submitBtn.click();
        } else {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
    }

    /**
     * Called when leaving this provider's view.
     * Disconnect observers, abort fetches, etc.
     * Subclasses should call super.deactivate().
     */
    deactivate() {
        this._removeDropdownDismiss();
        this._detachScrollListener();
        // Reset manager state for clean re-activation
        this._mgrOpen = false;
        clearTimeout(this._mgrDebounceTimer);
        clearTimeout(this._mgrConfirmTimer);
        // Reset any in-progress unfollow confirmation
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            for (const btn of list.querySelectorAll('.follow-mgr-unfollow-btn[data-confirming]')) {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }
        }
    }

    // ── Library Lookup ───────────────────────────────────────

    /**
     * Populate _lookup Sets from the current allCharacters list.
     * Handles byNameAndCreator + byNormalizedName universally;
     * delegates provider-specific ID extraction to _extractProviderIds().
     */
    buildLocalLibraryLookup() {
        // Reuse the provider-agnostic base (built once across all providers); only
        // byProviderId is per-provider, so rebuild just that from the live list.
        ensureSharedBaseLookup();
        this._lookup.byNameAndCreator = _sharedBaseLookup.byNameAndCreator;
        this._lookup.byNormalizedName = _sharedBaseLookup.byNormalizedName;

        const byProviderId = this._lookup.byProviderId;
        byProviderId.clear();
        for (const char of CoreAPI.getAllCharacters()) {
            if (char) this._extractProviderIds(char, byProviderId);
        }

        CoreAPI.debugLog(`[${this.provider.name}] Library lookup built:`,
            'nameCreators:', this._lookup.byNameAndCreator.size,
            'providerIds:', byProviderId.size,
            'normalizedNames:', this._lookup.byNormalizedName.size);
    }

    /**
     * Incrementally add ONE freshly imported character to the lookup in O(1), instead of a
     * full rebuild. Mutates the shared base (so all providers see it) plus own byProviderId.
     * Falls back to a full rebuild only if this view is not on the current shared base.
     * @param {Object} char - the slim character just pushed into allCharacters
     */
    addCharToLookup(char) {
        if (!char) return;
        if (this._lookup.byNameAndCreator !== _sharedBaseLookup.byNameAndCreator
            || _sharedBaseLookup.gen !== _baseLookupGen) {
            // This view is not on the current shared base; rebuild fresh from the live list
            // (which already contains char). The gen bump clears the memo on next score read.
            invalidateSharedBaseLookup();
            this.buildLocalLibraryLookup();
            return;
        }
        // The incremental path doesn't bump the gen, so stale "not a match" verdicts must go; but a
        // full clear makes the post-import re-grade re-score every rendered card cold (an O(cards x
        // library) main-thread burst). Only entries the new char's name can affect are dropped: maxed
        // scores cant rise further, and memo keys hold the RAW lowered name so they must be
        // re-normalized through computeNameVariants before intersecting.
        const newVariants = computeNameVariants(char.name || '');
        for (const [key, score] of _possibleMatchMemo) {
            if (score >= 95) continue;
            const keyVariants = computeNameVariants(key.slice(0, key.lastIndexOf('|')));
            let affected = false;
            for (const kv of keyVariants) {
                for (const nv of newVariants) {
                    if (kv === nv || this._isNamePrefixMatch(kv, nv)) { affected = true; break; }
                }
                if (affected) break;
            }
            if (affected) _possibleMatchMemo.delete(key);
        }
        const name = (char.name || '').toLowerCase().trim();
        const creator = String(char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) this._lookup.byNameAndCreator.add(`${name}|${creator}`);
        this._extractProviderIds(char, this._lookup.byProviderId);
        for (const variant of computeNameVariants(char.name || '')) {
            let creatorSet = this._lookup.byNormalizedName.get(variant);
            if (!creatorSet) { creatorSet = new Set(); this._lookup.byNormalizedName.set(variant, creatorSet); }
            if (creator) creatorSet.add(creator);
        }
    }

    /**
     * Extract provider-specific IDs from a local character into the Set.
     * Subclasses override to read their extension key.
     * @param {Object} char - local character from allCharacters
     * @param {Set} idSet - the byProviderId Set to add to
     */
    _extractProviderIds(char, idSet) {}

    /**
     * Check if a browse card name+creator is a possible match (cross-provider).
     * @param {string} name - resolved display name from the browse card
     * @param {string} [creator] - creator/author name from the browse card
     * @returns {boolean}
     */
    isCharPossibleMatch(name, creator) {
        return this.getPossibleMatchScore(name, creator) >= getPossibleMatchMinScore();
    }

    /**
     * Cross-provider memoized possible-match score (0-100). Threshold-independent, so the
     * sensitivity slider re-reads it without recomputing.
     */
    getPossibleMatchScore(name, creator) {
        // Sync to the current base before the gen stamp, or a refresh in the bump-to-rebuild window memos stale scores that outlive the rebuild.
        ensureSharedBaseLookup();
        if (this._lookup.byNormalizedName !== _sharedBaseLookup.byNormalizedName) {
            this._lookup.byNameAndCreator = _sharedBaseLookup.byNameAndCreator;
            this._lookup.byNormalizedName = _sharedBaseLookup.byNormalizedName;
        }
        if (_possibleMatchMemoGen !== _baseLookupGen) {
            _possibleMatchMemo.clear();
            _possibleMatchMemoGen = _baseLookupGen;
        }
        const key = `${(name || '').toLowerCase().trim()}|${(creator || '').toLowerCase().trim()}`;
        let score = _possibleMatchMemo.get(key);
        if (score === undefined) {
            score = this._computePossibleMatchScore(name, creator);
            _possibleMatchMemo.set(key, score);
        }
        return score;
    }

    /**
     * Graded badge data for a browse card: whether to show it, the intensity tier, the tooltip.
     * @returns {{show: boolean, tier: string, tooltip: string}}
     */
    getPossibleMatchTier(name, creator) {
        const score = this.getPossibleMatchScore(name, creator);
        if (score < getPossibleMatchMinScore()) return { show: false, tier: '', tooltip: '' };
        if (score >= POSSIBLE_MATCH_TIER_HIGH) return { show: true, tier: 'high', tooltip: 'Very likely in your library' };
        if (score >= POSSIBLE_MATCH_TIER_MED) return { show: true, tier: 'med', tooltip: 'Likely the same character' };
        return { show: true, tier: 'low', tooltip: 'Possible match (same name)' };
    }

    _computePossibleMatchScore(name, creator) {
        const browseCreator = (creator || '').toLowerCase().trim();
        const variants = this._nameVariants(name);
        let best = 0;

        // Exact normalized-name match: base 60, full 95 when the creator agrees (or none to disagree).
        for (const variant of variants) {
            const creatorSet = this._lookup.byNormalizedName.get(variant);
            if (!creatorSet) continue;
            if (!browseCreator || creatorSet.size === 0) { best = Math.max(best, 95); continue; }
            let creatorHit = false;
            for (const libCreator of creatorSet) {
                if (this._isCreatorMatch(browseCreator, libCreator)) { creatorHit = true; break; }
            }
            best = Math.max(best, creatorHit ? 95 : 60 + this._distinctiveBonus(variant, creatorSet));
        }
        if (best >= 95) return best;

        // Prefix fallback: weaker name signal (base 35), eg. "scar" against "scar - the dark king".
        for (const variant of variants) {
            if (variant.length < 4) continue;
            for (const [libName, creatorSet] of this._lookup.byNormalizedName) {
                if (libName.length < 4) continue;
                if (!this._isNamePrefixMatch(variant, libName)) continue;
                if (!browseCreator || creatorSet.size === 0) { best = Math.max(best, 70); continue; }
                let creatorHit = false;
                for (const libCreator of creatorSet) {
                    if (this._isCreatorMatch(browseCreator, libCreator)) { creatorHit = true; break; }
                }
                best = Math.max(best, creatorHit ? 70 : 35 + Math.round(this._distinctiveBonus(variant, creatorSet) * 0.5));
            }
        }
        return best;
    }

    /**
     * Bonus (0-30) for an exact-name match whose creator does NOT agree: longer, more-worded names
     * are likelier a genuine cross-handle repost; a name the library already holds under 3+ creators
     * is demonstrably common and gets damped back down.
     */
    _distinctiveBonus(normName, creatorSet) {
        const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
        const lenScore = clamp01((normName.length - 12) / 20) * 20;
        let words = 0;
        for (const w of normName.split(' ')) if (w.length >= 2) words++;
        const wordScore = clamp01((words - 1) / 4) * 10;
        const rarity = creatorSet.size >= 3 ? 25 : 0;
        const bonus = lenScore + wordScore - rarity;
        return bonus < 0 ? 0 : bonus > 30 ? 30 : bonus;
    }

    /**
     * Check if one name is a word-boundary prefix of the other.
     * "scar" matches "scar - the dark king" but NOT "scarlett".
     * @param {string} a - normalized name
     * @param {string} b - normalized name
     * @returns {boolean}
     */
    _isNamePrefixMatch(a, b) {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length <= b.length ? b : a;
        if (shorter.length === longer.length) return false;
        if (!longer.startsWith(shorter)) return false;
        return /[\s\-|:,.]/.test(longer[shorter.length]);
    }

    /**
     * Generate normalized name variants for cross-provider matching.
     * Splits on || separators so "Scar || Dark King" matches "Scar".
     * @param {string} rawName
     * @returns {string[]} unique normalized variants with length >= 4
     */
    _nameVariants(rawName) {
        return computeNameVariants(rawName);
    }

    /**
     * Lightweight fuzzy match for creator names across providers.
     * Handles case differences, prefixes, and small edits.
     * @param {string} a - normalized (lowered+trimmed) creator name
     * @param {string} b - normalized (lowered+trimmed) creator name
     * @returns {boolean}
     */
    _isCreatorMatch(a, b) {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;

        const aCompact = a.replace(/[\s_-]/g, '');
        const bCompact = b.replace(/[\s_-]/g, '');
        if (aCompact && aCompact === bCompact) return true;

        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) return false;
        if (Math.abs(a.length - b.length) > maxLen * 0.4) return false;

        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const curr = [i];
            for (let j = 1; j <= b.length; j++) {
                curr[j] = Math.min(
                    prev[j] + 1,
                    curr[j - 1] + 1,
                    prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                );
            }
            prev = curr;
        }

        return (1 - prev[b.length] / maxLen) >= 0.75;
    }

    /**
     * Rebuild the In Library lookup from allCharacters.
     * Called after extensions recovery or character list changes.
     */
    rebuildLocalLibraryLookup() {
        this.buildLocalLibraryLookup();
    }

    /**
     * Re-evaluate In Library badges on already-rendered browse cards.
     * Called after the lookup has been rebuilt to fix stale badges.
     * @param {function(HTMLElement): boolean} checkCard - Returns true if the card is in the local library
     * @param {string[]} [gridIds] - Grid element IDs to scan (defaults to _getImageGridIds())
     */
    /**
     * Possible-match tier for a rendered card during the re-grade pass. The base reads the
     * two common creator attrs; providers whose markup differs (or who skip name-only
     * grading, like botbooru) override.
     * @param {HTMLElement} card - Rendered .browse-card
     * @param {string} name - Card's character name
     * @returns {{show: boolean}} Tier object from getPossibleMatchTier
     */
    _cardPossibleTier(card, name) {
        const creatorEl = card.querySelector('.browse-card-creator-link');
        const creator = creatorEl?.dataset.author || creatorEl?.dataset.creatorName || '';
        return this.getPossibleMatchTier(name, creator);
    }

    refreshInLibraryBadges(checkCard, gridIds) {
        if (!checkCard) return;
        for (const gridId of (gridIds || this._getImageGridIds())) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;

            // Skip the top-left source-badge container (datacat reuses the base class).
            const BOTTOM_BADGES_SEL = '.browse-feature-badges:not(.browse-feature-badges-tl)';

            for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
                if (!checkCard(card)) continue;
                card.classList.add('in-library');
                card.classList.remove('possible-library');
                let badgesEl = card.querySelector(BOTTOM_BADGES_SEL);
                if (!badgesEl) {
                    const imgWrap = card.querySelector('.browse-card-image');
                    if (imgWrap) {
                        imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                        badgesEl = imgWrap.querySelector(BOTTOM_BADGES_SEL);
                    }
                }
                if (badgesEl) {
                    badgesEl.querySelector('.possible-library')?.remove();
                    if (!badgesEl.querySelector('.in-library')) {
                        badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
                    }
                }
            }

            for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
                const name = card.querySelector('.browse-card-name')?.textContent || '';
                const tier = this._cardPossibleTier(card, name);
                let badgesEl = card.querySelector(BOTTOM_BADGES_SEL);
                const existing = badgesEl?.querySelector('.possible-library');
                if (!tier.show) {
                    card.classList.remove('possible-library');
                    existing?.remove();
                    continue;
                }
                card.classList.add('possible-library');
                if (!badgesEl) {
                    const imgWrap = card.querySelector('.browse-card-image');
                    if (imgWrap) {
                        imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                        badgesEl = imgWrap.querySelector(BOTTOM_BADGES_SEL);
                    }
                }
                if (!badgesEl) continue;
                if (existing) {
                    existing.className = `browse-feature-badge possible-library pl-${tier.tier}`;
                    existing.title = tier.tooltip;
                } else {
                    badgesEl.insertAdjacentHTML('afterbegin', `<span class="browse-feature-badge possible-library pl-${tier.tier}" title="${tier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
                }
            }
        }
    }

    // ── Image Observer ──────────────────────────────────────

    /**
     * Grid element IDs this view uses for card rendering.
     * Used by reconnectImageObserver() to find and re-observe images.
     * @returns {string[]}
     */
    _getImageGridIds() { return []; }

    /**
     * Create the shared IntersectionObserver (once). Subclasses normally
     * don't need to call this directly - observeImages() auto-initializes.
     */
    _initImageObserver() {
        if (this._imageObserver) return;
        this._imageObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                const realSrc = img.dataset.src;
                if (realSrc && !img.dataset.failed && img.src !== realSrc) {
                    BrowseView.loadImage(img, realSrc);
                }
            }
        }, { rootMargin: '600px' });
    }

    /**
     * Observe card images in a container for lazy loading.
     * Calls eagerLoadVisibleImages() first, then batches the rest
     * through IntersectionObserver.
     * @param {HTMLElement} container
     */
    observeImages(container) {
        if (!container) return;
        if (!this._imageObserver) this._initImageObserver();
        requestAnimationFrame(() => {
            this.eagerLoadVisibleImages(container);
            this.eagerPreloadImages(container);
            const images = Array.from(
                container.querySelectorAll('.browse-card-image img')
            ).filter(img => !img.dataset.observed);
            if (images.length === 0) return;

            if (images.length > 120) {
                const batchSize = 80;
                let index = 0;
                const observeBatch = () => {
                    const end = Math.min(index + batchSize, images.length);
                    for (let i = index; i < end; i++) {
                        images[i].dataset.observed = '1';
                        this._imageObserver.observe(images[i]);
                    }
                    index = end;
                    if (index < images.length) requestAnimationFrame(observeBatch);
                };
                observeBatch();
                return;
            }

            for (const img of images) {
                img.dataset.observed = '1';
                this._imageObserver.observe(img);
            }
        });
    }

    /**
     * Synchronously load images that are already in/near the viewport.
     * Called at the start of observeImages() for instant display.
     * @param {HTMLElement} container
     */
    eagerLoadVisibleImages(container) {
        if (!container) return;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const preloadBottom = viewportHeight + 700;
        // :not(.loaded) keeps getBoundingClientRect off already-loaded cards; on a deep grid
        // this scan ran over every card ever appended and was the main forced-layout source.
        const images = container.querySelectorAll('.browse-card-image:not(.loaded) img[data-src]');
        for (const img of images) {
            if (img.dataset.failed) continue;
            const rect = img.getBoundingClientRect();
            if (rect.bottom > -160 && rect.top < preloadBottom) {
                const realSrc = img.dataset.src;
                if (realSrc && img.src !== realSrc) {
                    BrowseView.loadImage(img, realSrc);
                }
            }
        }
    }

    /**
     * Preload a batch of images beyond the viewport for smoother scrolling.
     * @param {HTMLElement} container
     */
    eagerPreloadImages(container) {
        if (!container) return;
        const images = container.querySelectorAll('.browse-card-image:not(.loaded) img[data-src]');
        let loaded = 0;
        for (const img of images) {
            if (loaded >= this._preloadLimit) break;
            if (img.dataset.failed) continue;
            const realSrc = img.dataset.src;
            if (realSrc && img.src !== realSrc) {
                BrowseView.loadImage(img, realSrc);
                loaded++;
            }
        }
    }

    /**
     * Disconnect the image lazy-load observer.
     */
    disconnectImageObserver() {
        this._imageObserver?.disconnect();
    }

    /**
     * Reconnect the image observer after disconnect.
     * Clears data-observed flags and re-observes images in all grid containers.
     */
    reconnectImageObserver() {
        for (const gridId of this._getImageGridIds()) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;
            this.eagerLoadVisibleImages(grid);
            const imgs = grid.querySelectorAll('.browse-card-image img[data-observed]');
            for (const img of imgs) delete img.dataset.observed;
            this.observeImages(grid);
        }
    }

    // ── Infinite Scroll ───────────────────────────────────

    /**
     * Whether this view can load more results right now.
     * Subclasses override to check their hasMore + !isLoading state.
     * @returns {boolean}
     */
    canLoadMore() { return false; }

    /**
     * Trigger the next page load (append mode).
     * Subclasses override to increment page and call their load function.
     */
    loadMore() {}

    _triggerLoadMore() {
        this._prefetching = true;
        this._setScrollIndicator('loading');
        const result = this.loadMore();
        if (result && typeof result.then === 'function') {
            result.then(() => { this._prefetching = false; }, () => { this._prefetching = false; });
        } else {
            setTimeout(() => { this._prefetching = false; }, 300);
        }
    }

    /**
     * Whether infinite scroll is active for this provider.
     * Reads from the per-provider setting with global fallback.
     * @returns {boolean}
     */
    isInfiniteScrollEnabled() {
        const perProvider = CoreAPI.getSetting('infiniteScroll');
        const id = this.provider?.id;
        if (id && perProvider && typeof perProvider === 'object' && id in perProvider) {
            return perProvider[id];
        }
        return true;
    }

    /**
     * Attach the scroll listener for infinite loading + prefetch.
     * Listens on .gallery-content (the scrollable parent of #onlineView).
     */
    _getScrollThreshold() {
        const zoom = parseFloat(document.body.style.zoom) || 1;
        return 1500 / zoom;
    }

    _attachScrollListener() {
        this._detachScrollListener();
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        this._scrollHandler = () => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;

            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
            }
        };

        scrollContainer.addEventListener('scroll', this._scrollHandler, { passive: true });
    }

    /**
     * Remove the scroll listener.
     */
    _detachScrollListener() {
        if (this._scrollHandler) {
            document.querySelector('.gallery-content')?.removeEventListener('scroll', this._scrollHandler);
            this._scrollHandler = null;
        }
        this._prefetching = false;
        this._removeScrollIndicator();
    }

    /**
     * Update the visibility of the load-more button container.
     * When infinite scroll is enabled, hides the button.
     * Subclasses call this from their updateLoadMore() or renderGrid().
     * @param {string} loadMoreContainerId - DOM ID of the load-more container div
     * @param {boolean} hasMore - whether more results are available
     * @param {boolean} hasResults - whether any results exist
     */
    updateLoadMoreVisibility(loadMoreContainerId, hasMore, hasResults) {
        const el = document.getElementById(loadMoreContainerId);
        if (!el) return;
        if (this.isInfiniteScrollEnabled()) {
            el.style.display = 'none';
            this._setScrollIndicator(hasMore ? 'hidden' : 'end');
            if (hasMore) this._deferredScrollCheck();
        } else {
            el.style.display = hasMore && hasResults ? 'flex' : 'none';
        }
    }

    _deferredScrollCheck() {
        requestAnimationFrame(() => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;
            const sc = document.querySelector('.gallery-content');
            if (!sc) return;
            const distanceFromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
            }
        });
    }

    _ensureScrollIndicator() {
        if (this._scrollIndicator?.isConnected) return this._scrollIndicator;
        const container = document.getElementById('onlineView');
        if (!container) return null;
        const el = document.createElement('div');
        el.className = 'browse-scroll-indicator';
        container.appendChild(el);
        this._scrollIndicator = el;
        return el;
    }

    _setScrollIndicator(state) {
        if (!this.isInfiniteScrollEnabled()) return;
        const el = this._ensureScrollIndicator();
        if (!el) return;
        el.classList.remove('loading', 'end');
        if (state === 'hidden') {
            el.style.display = 'none';
        } else {
            el.style.display = '';
            el.classList.add(state);
        }
    }

    _removeScrollIndicator() {
        this._scrollIndicator?.remove();
        this._scrollIndicator = null;
    }

    // ── Dropdown Dismiss ────────────────────────────────────

    /**
     * Close all registered dropdowns for this browse view.
     * Called by the registry when topbar dropdowns open or on provider switch.
     */
    closeDropdowns() {
        if (this._dropdownDismissPairs) {
            for (const { dropdownId } of this._dropdownDismissPairs) {
                document.getElementById(dropdownId)?.classList.add('hidden');
            }
        }
    }

    /**
     * Register a document-level click handler that closes dropdowns when
     * clicking outside. Replaces per-provider boilerplate.
     * @param {Array<{dropdownId: string, buttonId: string}>} pairs
     */
    _registerDropdownDismiss(pairs) {
        this._removeDropdownDismiss();
        this._dropdownDismissPairs = pairs;
        this._dropdownCloseHandler = (e) => {
            for (const { dropdownId, buttonId } of pairs) {
                const dropdown = document.getElementById(dropdownId);
                const btn = document.getElementById(buttonId);
                if (dropdown && !dropdown.classList.contains('hidden')) {
                    if (!dropdown.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        dropdown.classList.add('hidden');
                    }
                }
            }
        };
        document.addEventListener('click', this._dropdownCloseHandler);

        // Direct hook: on each dropdown's button click, push a back-button guard
        // when the dropdown transitions from hidden to open. The mobile back-stack
        // catches the body-relocated dropdown at Tier 6 once a guard is queued.
        this._dropdownGuardCleanups = [];
        for (const { dropdownId, buttonId } of pairs) {
            const btn = document.getElementById(buttonId);
            const dropdown = document.getElementById(dropdownId);
            if (!btn || !dropdown) continue;
            const onClick = () => {
                requestAnimationFrame(() => {
                    if (!dropdown.classList.contains('hidden')) {
                        window.pushOverlayGuard?.();
                    }
                });
            };
            btn.addEventListener('click', onClick);
            this._dropdownGuardCleanups.push(() => btn.removeEventListener('click', onClick));
        }
    }

    /**
     * Remove the dropdown dismiss handler. Called automatically from deactivate().
     */
    _removeDropdownDismiss() {
        if (this._dropdownCloseHandler) {
            document.removeEventListener('click', this._dropdownCloseHandler);
            this._dropdownCloseHandler = null;
        }
        if (this._dropdownGuardCleanups) {
            for (const cleanup of this._dropdownGuardCleanups) cleanup();
            this._dropdownGuardCleanups = null;
        }
    }

    // ── Following Manager (Abstract) ────────────────────────

    /** @returns {boolean} */
    get supportsFollowingManager() { return false; }

    /**
     * Fetch followed creators in normalized form.
     * @returns {Promise<Array<{id: string, name: string, username?: string, avatar?: string, characterCount?: number}>>}
     */
    async getFollowedCreators() { return []; }

    /**
     * Follow a creator by query (name, URL, or UUID).
     * @param {string} query
     * @returns {Promise<{id: string, name: string}|null>}
     */
    async followCreator(query) { return null; }

    /**
     * Unfollow a creator by normalized ID.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async unfollowCreator(id) { return false; }

    /**
     * @param {{id: string, avatar?: string}} creator
     * @returns {string}
     */
    getCreatorAvatarUrl(creator) { return creator.avatar || ''; }

    _getInitialsColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const hue = ((hash % 360) + 360) % 360;
        return `hsl(${hue}, 50%, 35%)`;
    }

    /**
     * Navigate to this creator's characters in the browse grid.
     * Should close the manager panel and switch to browse mode.
     * @param {{id: string, name: string}} creator
     */
    browseCreatorFromManager(creator) {}

    /**
     * Provider-specific sort options for the manager list.
     * @returns {Array<{value: string, label: string}>}
     */
    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
        ];
    }

    // ── Following Manager (Shared UI) ───────────────────────

    /**
     * Render the manager panel HTML. Include in renderView() after the timeline header.
     * @returns {string}
     */
    renderFollowingManagerPanel() {
        if (!this.supportsFollowingManager) return '';
        const pid = this.provider.id;
        const sortOptions = this.getFollowingManagerSortOptions();
        const sortHtml = sortOptions.map(o =>
            `<option value="${o.value}">${o.label}</option>`
        ).join('');

        return `
            <div class="follow-mgr-panel hidden" id="${pid}FollowMgr">
                <div class="follow-mgr-toolbar">
                    <div class="follow-mgr-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="follow-mgr-search glass-input"
                               id="${pid}FollowMgrSearch" placeholder="Filter creators...">
                    </div>
                    <div class="follow-mgr-toolbar-actions">
                        <select class="follow-mgr-sort" id="${pid}FollowMgrSort">
                            ${sortHtml}
                        </select>
                    </div>
                </div>
                <div class="follow-mgr-list" id="${pid}FollowMgrList"></div>
                <div class="follow-mgr-empty hidden" id="${pid}FollowMgrEmpty">
                    <i class="fa-solid fa-user-group"></i>
                    <p>No followed creators</p>
                </div>
                <div class="follow-mgr-add">
                    <input type="search" class="follow-mgr-add-input glass-input"
                           id="${pid}FollowMgrAddInput" placeholder="Follow by name or URL...">
                    <button class="follow-mgr-add-btn glass-btn" id="${pid}FollowMgrAddBtn"
                            title="Follow creator">
                        <i class="fa-solid fa-user-plus"></i>
                    </button>
                </div>
            </div>`;
    }

    /**
     * Attach event listeners for the manager panel. Auto-called from init().
     */
    _initFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        if (!panel) return;

        const sortEl = document.getElementById(`${pid}FollowMgrSort`);
        if (sortEl) {
            CoreAPI.initCustomSelect?.(sortEl);
            sortEl.addEventListener('change', () => {
                this._mgrSort = sortEl.value;
                this._renderManagerCreators();
            });
        }

        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                clearTimeout(this._mgrDebounceTimer);
                this._mgrDebounceTimer = setTimeout(() => {
                    this._mgrFilter = searchEl.value.trim().toLowerCase();
                    this._renderManagerCreators();
                }, 150);
            });
        }

        const addInput = document.getElementById(`${pid}FollowMgrAddInput`);
        const addBtn = document.getElementById(`${pid}FollowMgrAddBtn`);
        const handleAdd = async () => {
            const query = addInput?.value?.trim();
            if (!query) return;
            addBtn?.classList.add('loading');
            try {
                const creator = await this.followCreator(query);
                if (creator) {
                    addInput.value = '';
                    await this._loadManagerCreators();
                    this._renderManagerCreators();
                }
            } catch (e) {
                console.error('[FollowingManager] Follow failed:', e);
                CoreAPI.showToast?.('Failed to follow creator', 'error');
            } finally {
                addBtn?.classList.remove('loading');
            }
        };
        if (addBtn) addBtn.addEventListener('click', handleAdd);
        if (addInput) addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
        });

        // Delegation on the list container
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            list.addEventListener('click', (e) => {
                const card = e.target.closest('.follow-mgr-card');
                if (!card) return;
                const creatorId = card.dataset.creatorId;
                const creator = this._mgrCreators.find(c => c.id === creatorId);
                if (!creator) return;

                // Unfollow button
                const unfollowBtn = e.target.closest('.follow-mgr-unfollow-btn');
                if (unfollowBtn) {
                    this._handleManagerUnfollow(unfollowBtn, card, creator);
                    return;
                }

                // Card click = browse creator
                this.closeFollowingManager();
                this.browseCreatorFromManager(creator);
            });
        }

        // Toggle button
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleFollowingManager());
        }
    }

    toggleFollowingManager() {
        if (this._mgrOpen) {
            this.closeFollowingManager();
        } else {
            this.openFollowingManager();
        }
    }

    async openFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = true;
        toggleBtn?.classList.add('active');
        panel.classList.remove('hidden');

        await this._loadManagerCreators();
        this._renderManagerCreators();
    }

    closeFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = false;
        toggleBtn?.classList.remove('active');
        panel.classList.add('hidden');

        clearTimeout(this._mgrDebounceTimer);
        this._mgrFilter = '';
        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) searchEl.value = '';
    }

    async _loadManagerCreators() {
        this._mgrCreators = await this.getFollowedCreators();
    }

    _renderManagerCreators() {
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        const empty = document.getElementById(`${pid}FollowMgrEmpty`);
        if (!list) return;

        let creators = [...this._mgrCreators];

        // Filter
        if (this._mgrFilter) {
            const q = this._mgrFilter;
            creators = creators.filter(c =>
                c.name.toLowerCase().includes(q) ||
                (c.username && c.username.toLowerCase().includes(q))
            );
        }

        // Sort
        this._sortCreators(creators, this._mgrSort);

        if (creators.length === 0) {
            list.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }

        empty?.classList.add('hidden');
        list.innerHTML = creators.map((c, i) =>
            this._renderManagerCreatorCard(c, i)
        ).join('');
    }

    _renderManagerCreatorCard(creator, index) {
        const rawAvatarUrl = this.getCreatorAvatarUrl(creator);
        const avatarUrl = rawAvatarUrl ? CoreAPI.escapeHtml?.(rawAvatarUrl) ?? rawAvatarUrl : '';
        const name = CoreAPI.escapeHtml?.(creator.name) || creator.name;
        const username = creator.username ? CoreAPI.escapeHtml?.(creator.username) || creator.username : '';
        const charCount = creator.characterCount != null ? creator.characterCount : -1;
        const initial = (creator.name || '?').charAt(0).toUpperCase();
        const initialsColor = this._getInitialsColor(creator.name || creator.id || '');

        return `
            <div class="follow-mgr-card" data-creator-id="${creator.id}"
                 style="animation-delay: ${index * 0.04}s">
                <div class="follow-mgr-card-avatar">
                    ${avatarUrl
                        ? `<img src="${avatarUrl}" alt="" loading="lazy"
                               onerror="this.style.display='none';this.parentElement.querySelector('.follow-mgr-card-avatar-fallback').style.display='flex'">`
                        : ''}
                    <div class="follow-mgr-card-avatar-fallback"
                         style="${avatarUrl ? 'display:none;' : ''}background-color:${initialsColor}">
                        ${initial}
                    </div>
                </div>
                <div class="follow-mgr-card-info">
                    <div class="follow-mgr-card-name">${name}</div>
                    <div class="follow-mgr-card-meta">
                        ${username ? `<span class="follow-mgr-card-handle">@${username}</span>` : ''}
                        ${charCount >= 0 ? `<span class="follow-mgr-card-count">${charCount} char${charCount !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                </div>
                <div class="follow-mgr-card-actions">
                    <button class="follow-mgr-unfollow-btn glass-btn icon-only"
                            title="Unfollow">
                        <i class="fa-solid fa-user-minus"></i>
                    </button>
                </div>
            </div>`;
    }

    _sortCreators(creators, sort) {
        switch (sort) {
            case 'name_asc':
                creators.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'name_desc':
                creators.sort((a, b) => b.name.localeCompare(a.name));
                break;
            case 'recent':
                creators.sort((a, b) => (b.followedAt || 0) - (a.followedAt || 0));
                break;
            case 'chars':
                creators.sort((a, b) => (b.characterCount || 0) - (a.characterCount || 0));
                break;
        }
    }

    async _handleManagerUnfollow(btn, card, creator) {
        // Two-phase confirm
        if (!btn.dataset.confirming) {
            btn.dataset.confirming = '1';
            btn.classList.add('confirming');
            btn.title = 'Click again to confirm';
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            this._mgrConfirmTimer = setTimeout(() => {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }, 3000);
            return;
        }

        clearTimeout(this._mgrConfirmTimer);
        card.classList.add('removing');
        let success = false;
        try {
            success = await this.unfollowCreator(creator.id);
        } catch (e) {
            console.error('[FollowingManager] Unfollow failed:', e);
            CoreAPI.showToast?.('Failed to unfollow creator', 'error');
        }
        if (success) {
            card.addEventListener('animationend', () => {
                this._mgrCreators = this._mgrCreators.filter(c => c.id !== creator.id);
                this._renderManagerCreators();
            }, { once: true });
        } else {
            card.classList.remove('removing');
            delete btn.dataset.confirming;
            btn.classList.remove('confirming');
            btn.title = 'Unfollow';
            btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
        }
    }

    // ── Creator Downloads ───────────────────────────────────

    get supportsCreatorDownload() { return !!CD_ADAPTERS[this.provider?.id]; }

    creatorDownloadEnabled() {
        return this.supportsCreatorDownload && CoreAPI.getSetting('creatorDownloads') === true;
    }

    _injectCreatorDownloadButton(container) {
        const actions = container?.querySelector('.browse-author-banner-actions, .chub-author-banner-actions');
        if (!actions || actions.querySelector('.browse-cdl-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'glass-btn icon-only browse-cdl-btn';
        btn.title = 'Download all cards by this creator';
        btn.innerHTML = '<i class="fa-solid fa-download"></i>';
        btn.addEventListener('click', () => this.runCreatorDownload(btn));
        const last = actions.lastElementChild;
        if (last?.tagName === 'BUTTON' && last.querySelector('.fa-times, .fa-xmark')) {
            actions.insertBefore(btn, last);
        } else {
            actions.appendChild(btn);
        }
    }

    async fetchAllCreatorCards() {
        return CD_ADAPTERS[this.provider?.id]?.fetchAll(this) ?? [];
    }

    async importOneCreatorCard(card) {
        const adapter = CD_ADAPTERS[this.provider?.id];
        return adapter ? adapter.importOne(this, card) : { ok: false, error: 'Not supported' };
    }

    async runCreatorDownload(triggerBtn = null) {
        if (!this.creatorDownloadEnabled()) return;
        // one shared modal, so one active run across ALL views
        if (_cdActiveView) {
            CoreAPI.showToast?.('A creator download is already running', 'warning');
            return;
        }
        _cdActiveView = this;
        this._cdRunning = true;
        this._cdCancelled = false;
        const originalBtnHtml = triggerBtn?.innerHTML;
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        }
        try {
            // Display name straight off the banner; the fetch reads provider state itself
            const banner = triggerBtn?.closest('.chub-author-banner, .browse-author-banner');
            const creatorName = banner?.querySelector('strong')?.textContent?.trim() || 'this creator';
            let cards = [];
            try {
                cards = await this.fetchAllCreatorCards();
            } catch (e) {
                CoreAPI.showToast?.(`Could not fetch creator catalog: ${e?.message || e}`, 'error');
                return;
            }
            if (!cards.length) {
                CoreAPI.showToast?.('No cards found for this creator', 'info');
                return;
            }

            this.buildLocalLibraryLookup();
            const minScore = getPossibleMatchMinScore();
            const toImport = [];
            let skipped = 0;
            for (const card of cards) {
                if (card.key && this._lookup.byProviderId.has(card.key)) { skipped++; continue; }
                if (this.getPossibleMatchScore(card.name || '', card.creator || '') >= minScore) { skipped++; continue; }
                toImport.push(card);
            }

            if (!toImport.length) {
                CoreAPI.showToast?.(`All ${cards.length} card${cards.length === 1 ? '' : 's'} by ${creatorName} are already in your library`, 'info');
                return;
            }

            const confirmed = await this._cdConfirm(creatorName, cards.length, toImport.length, skipped);
            if (!confirmed) return;

            this._cdShowProgress(creatorName, toImport.length);
            let imported = 0, failed = 0;
            const failures = [];
            for (let i = 0; i < toImport.length; i++) {
                if (this._cdCancelled) break;
                const card = toImport[i];
                this._cdUpdateProgress(i, toImport.length, card.name || '', imported, failed);
                try {
                    const res = await this.importOneCreatorCard(card);
                    if (res?.ok) {
                        imported++;
                        if (res.avatarFileName) {
                            const added = await CoreAPI.fetchAndAddCharacter(res.avatarFileName);
                            if (added) this.addCharToLookup(added);
                        }
                        if (res.summaryArgs && CoreAPI.getSetting('importMediaAction') !== 'none') CoreAPI.queueImportMediaJobs(res.summaryArgs);
                    } else {
                        failed++;
                        failures.push(card.name || '?');
                        CoreAPI.debugLog?.('[CreatorDownload] Import failed:', card.name, res?.error);
                    }
                } catch (e) {
                    failed++;
                    failures.push(card.name || '?');
                    CoreAPI.debugLog?.('[CreatorDownload] Import threw:', card.name, e?.message || e);
                }
                await new Promise(r => setTimeout(r, 400));
            }
            this.refreshInLibraryBadges();
            this._cdShowDone({ creatorName, imported, failed, failures, skipped, cancelled: this._cdCancelled });
        } finally {
            this._cdRunning = false;
            _cdActiveView = null;
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalBtnHtml;
            }
        }
    }

    _cdEnsureModal() {
        let modal = document.getElementById('creatorDlModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'creatorDlModal';
            modal.className = 'cl-modal cl-modal-drawer cl-drawer-partial';
            modal.innerHTML = `
                <div class="cl-modal-content browse-cdl-content">
                    <div class="cl-modal-header">
                        <h3><i class="fa-solid fa-download"></i> Creator Download</h3>
                        <button class="cl-modal-close" id="creatorDlCloseX"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="cl-modal-body browse-cdl-body" id="creatorDlBody"></div>
                    <div class="cl-modal-footer browse-cdl-footer" id="creatorDlFooter"></div>
                </div>`;
            document.body.appendChild(modal);
            document.getElementById('creatorDlCloseX')?.addEventListener('click', () => window.creatorDlModalClose?.());
        }
        window.creatorDlModalClose = () => this._cdHandleClose();
        window.registerOverlay?.({ id: 'creatorDlModal', tier: 5, close: () => window.creatorDlModalClose?.(), visible: (el) => el.classList.contains('visible') });
        return modal;
    }

    _cdHandleClose() {
        const modal = document.getElementById('creatorDlModal');
        if (!modal) return;
        if (this._cdRunning && !this._cdCancelled && this._cdPhase === 'progress') {
            // first close while running = cancel after current card
            this._cdRequestCancel();
            return;
        }
        if (this._cdConfirmResolve) {
            const resolve = this._cdConfirmResolve;
            this._cdConfirmResolve = null;
            resolve(false);
        }
        modal.classList.remove('visible');
    }

    _cdRequestCancel() {
        this._cdCancelled = true;
        const label = document.getElementById('creatorDlCurrent');
        if (label) label.textContent = 'Cancelling after the current card...';
        const btn = document.getElementById('creatorDlCancelBtn');
        if (btn) btn.disabled = true;
    }

    _cdConfirm(creatorName, total, toImport, skipped) {
        const modal = this._cdEnsureModal();
        this._cdPhase = 'confirm';
        const esc = (s) => CoreAPI.escapeHtml?.(s) ?? s;
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        body.innerHTML = `
            <p class="browse-cdl-lead">Download <strong>${toImport}</strong> of ${total} card${total === 1 ? '' : 's'} by <strong>${esc(creatorName)}</strong>?</p>
            ${skipped > 0 ? `<p class="browse-cdl-sub">${skipped} already in your library will be skipped.</p>` : ''}
            <p class="browse-cdl-sub">Cards import one at a time; media downloads continue in the background queue.</p>`;
        footer.innerHTML = `
            <button class="cl-btn" id="creatorDlCancelConfirm">Cancel</button>
            <button class="cl-btn cl-btn-primary" id="creatorDlGo"><i class="fa-solid fa-download"></i> Download</button>`;
        modal.classList.add('visible');
        return new Promise(resolve => {
            this._cdConfirmResolve = resolve;
            document.getElementById('creatorDlCancelConfirm')?.addEventListener('click', () => {
                this._cdConfirmResolve = null;
                modal.classList.remove('visible');
                resolve(false);
            });
            document.getElementById('creatorDlGo')?.addEventListener('click', () => {
                this._cdConfirmResolve = null;
                resolve(true);
            });
        });
    }

    _cdShowProgress(creatorName, total) {
        const modal = this._cdEnsureModal();
        this._cdPhase = 'progress';
        const esc = (s) => CoreAPI.escapeHtml?.(s) ?? s;
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        body.innerHTML = `
            <p class="browse-cdl-lead">Downloading cards by <strong>${esc(creatorName)}</strong></p>
            <div class="browse-cdl-bar"><div class="browse-cdl-bar-fill" id="creatorDlBarFill"></div></div>
            <div class="browse-cdl-count" id="creatorDlCount">0 / ${total}</div>
            <div class="browse-cdl-current" id="creatorDlCurrent"></div>`;
        footer.innerHTML = `<button class="cl-btn" id="creatorDlCancelBtn">Cancel</button>`;
        document.getElementById('creatorDlCancelBtn')?.addEventListener('click', () => this._cdRequestCancel());
        modal.classList.add('visible');
    }

    _cdUpdateProgress(index, total, name, imported, failed) {
        const fill = document.getElementById('creatorDlBarFill');
        if (fill) fill.style.width = `${Math.round((index / total) * 100)}%`;
        const count = document.getElementById('creatorDlCount');
        if (count) count.textContent = `${index} / ${total}${failed > 0 ? ` (${failed} failed)` : ''}`;
        const current = document.getElementById('creatorDlCurrent');
        if (current && !this._cdCancelled) current.textContent = name;
    }

    _cdShowDone({ creatorName, imported, failed, failures, skipped, cancelled }) {
        this._cdPhase = 'done';
        const modal = document.getElementById('creatorDlModal');
        if (modal && !modal.classList.contains('visible')) {
            CoreAPI.showToast?.(`Creator download ${cancelled ? 'cancelled' : 'finished'}: ${imported} imported${failed > 0 ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
            return;
        }
        const esc = (s) => CoreAPI.escapeHtml?.(s) ?? s;
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        if (!body || !footer) return;
        const failList = failures.length
            ? `<div class="browse-cdl-failures">${failures.map(n => `<div>${esc(n)}</div>`).join('')}</div>`
            : '';
        body.innerHTML = `
            <p class="browse-cdl-lead">${cancelled ? 'Cancelled' : 'Done'}: <strong>${imported}</strong> imported${failed > 0 ? `, <strong>${failed}</strong> failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}</p>
            ${failList}
            ${imported > 0 ? '<p class="browse-cdl-sub">Media downloads are running in the background queue (see Notifications).</p>' : ''}`;
        footer.innerHTML = `<button class="cl-btn cl-btn-primary" id="creatorDlDoneBtn">Close</button>`;
        document.getElementById('creatorDlDoneBtn')?.addEventListener('click', () => {
            document.getElementById('creatorDlModal')?.classList.remove('visible');
        });
    }

    // ── Mobile Integration ──────────────────────────────────

    /**
     * DOM ID of this provider's preview modal (e.g. 'chubCharModal').
     * Used by the mobile back-button handler and STATIC_OVERLAYS set.
     * @returns {string|null}
     */
    get previewModalId() { return null; }

    /**
     * Close the preview modal with proper cleanup (abort fetches, release memory, etc.).
     * Called by the mobile back-button handler. Default hides the modal by ID.
     */
    closePreview() {
        const id = this.previewModalId;
        if (id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        }
    }

    /**
     * Element IDs for the provider's filter bar controls.
     * The mobile settings sheet queries these to build the online section dynamically.
     * @returns {{ sort: string|null, tags: string|null, filters: string|null, nsfw: string|null, refresh: string|null }}
     */
    get mobileFilterIds() {
        return { sort: null, tags: null, filters: null, nsfw: null, refresh: null };
    }

    /**
     * Whether this provider has a mode toggle (e.g. Browse/Following).
     * Providers returning true should provide mobileModeSections for the settings sheet.
     * @returns {boolean}
     */
    get hasModeToggle() { return false; }

    /**
     * Return sort/view config for the settings modal.
     * @returns {{ browseSortOptions: Array<{value:string, label:string}>, followingSortOptions: Array<{value:string, label:string}>, viewModes: Array<{value:string, label:string}> }}
     */
    getSettingsConfig() {
        return { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
    }

    /**
     * Full teardown - page unload.
     */
    destroy() {
        this.deactivate();
    }

    // ── Modal Injection ─────────────────────────────────────

    /**
     * Inject modal HTML into document.body (once).
     * Call from activate() on first run.
     */
    injectModals() {
        if (this._modalsInjected) return;
        const html = this.renderModals();
        if (html) {
            document.body.insertAdjacentHTML('beforeend', html);
        }
        this._modalsInjected = true;
    }

    // ── Avatar Quick-View ───────────────────────────────────

    /**
     * Full-screen view of an image; a multi-image gallery delegates to the shared gallery viewer.
     * @param {string} src
     * @param {string} [fallbackSrc]
     * @param {string[]} [gallery] - image URLs; more than one opens the gallery viewer
     * @param {number} [startIndex]
     */
    static openAvatarViewer(src, fallbackSrc, gallery, startIndex) {
        if (!src) return;
        BrowseView.closeAvatarViewer();

        if (gallery && gallery.length > 1) {
            // name from the url so gv's extension-based gif/video detection works on remote media
            const media = gallery.map((u, i) => ({
                url: u,
                name: (String(u).split('/').pop() || '').split('?')[0].split('#')[0] || `Image ${i + 1}`,
            }));
            CoreAPI.openGalleryViewerWithImages?.(media, startIndex ?? 0, 'Gallery');
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'browseAvatarViewer';
        overlay.className = 'browse-avatar-viewer';

        const img = document.createElement('img');
        img.className = 'browse-av-image';
        img.alt = 'Image';
        img.onerror = () => { img.onerror = null; if (fallbackSrc) img.src = fallbackSrc; else img.style.display = 'none'; };
        img.src = src;
        overlay.appendChild(img);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) BrowseView.closeAvatarViewer(); });
        img.addEventListener('click', () => BrowseView.closeAvatarViewer());

        document.body.appendChild(overlay);
    }

    static closeAvatarViewer() {
        document.getElementById('browseAvatarViewer')?.remove();
    }

    // ── Image loading ───────────────────────────────────────

    static loadImage(img, src) {
        img.src = src;
        const container = img.closest('.browse-card-image');
        if (!container || container.classList.contains('loaded')) return;
        img.addEventListener('load', function onLoad() {
            img.removeEventListener('load', onLoad);
            container.classList.add('loaded');
            container.classList.remove('load-failed');
        });
        img.addEventListener('error', function onError() {
            img.removeEventListener('error', onError);
            container.classList.add('load-failed');
        });
        BrowseView.adjustPortraitPosition(img);
    }

    // ── Portrait-aware position ─────────────────────────────

    static adjustPortraitPosition(img) {
        img.style.objectPosition = '';
        const apply = () => {
            const { naturalWidth: w, naturalHeight: h } = img;
            if (w > 0 && h > 0 && h / w > 1.3) {
                img.style.objectPosition = 'center 10%';
            }
        };
        if (img.complete && img.naturalWidth > 0) {
            apply();
        } else {
            img.addEventListener('load', function handler() {
                img.removeEventListener('load', handler);
                apply();
            });
        }
    }

    // ── Title scroll-reveal on click ─────────────────────────

    static wireTitleScroll(titleEl, overlayEl, glassEl) {
        if (!titleEl) return;
        let _anim = null;
        let _inner = null;

        function unwrap() {
            if (_inner) {
                titleEl.textContent = _inner.textContent;
                _inner = null;
            }
        }

        function cancel() {
            if (!_anim) return;
            if (_anim.animation) _anim.animation.cancel();
            if (_anim.timeout) clearTimeout(_anim.timeout);
            _anim = null;
            unwrap();
            titleEl.classList.remove('browse-title-scrolling', 'browse-title-scroll-start', 'browse-title-scroll-end');
        }

        titleEl.addEventListener('click', async () => {
            if (isMobileMode()) return; // mobile reveals long titles via its own tap handler
            if (_anim) { cancel(); return; }

            const distance = titleEl.scrollWidth - titleEl.clientWidth;
            if (distance <= 0) return;

            const inner = document.createElement('span');
            inner.className = 'browse-title-scroll-inner';
            inner.textContent = titleEl.textContent;
            titleEl.textContent = '';
            titleEl.appendChild(inner);
            _inner = inner;
            _anim = { animation: null, timeout: null };

            const speed = 80;
            const fwdMs = Math.max(500, (distance / speed) * 1000);
            const retMs = Math.max(350, fwdMs * 0.55);

            titleEl.classList.add('browse-title-scrolling', 'browse-title-scroll-start');

            const fwd = inner.animate(
                [{ transform: 'translateX(0)' }, { transform: `translateX(${-distance}px)` }],
                { duration: fwdMs, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)', fill: 'forwards', composite: 'replace' }
            );
            _anim.animation = fwd;
            await fwd.finished;
            if (!_anim) return;

            titleEl.classList.remove('browse-title-scroll-start');
            titleEl.classList.add('browse-title-scroll-end');

            await new Promise(r => { _anim.timeout = setTimeout(r, 1200); });
            if (!_anim) return;

            titleEl.classList.remove('browse-title-scroll-end');

            const ret = inner.animate(
                [{ transform: `translateX(${-distance}px)` }, { transform: 'translateX(0)' }],
                { duration: retMs, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards', composite: 'replace' }
            );
            _anim.animation = ret;
            await ret.finished;
            if (_anim) {
                _anim = null;
                unwrap();
                titleEl.classList.remove('browse-title-scrolling');
            }
        });

        if (overlayEl) {
            new MutationObserver(() => {
                if (overlayEl.classList.contains('hidden')) cancel();
            }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
        }

        if (glassEl) {
            new MutationObserver(() => {
                if (glassEl.classList.contains('header-collapsed')) cancel();
            }).observe(glassEl, { attributes: true, attributeFilter: ['class'] });
        }
    }
}

window.registerOverlay?.({
    id: 'browseAvatarViewer',
    tier: 0,
    static: false,
    close: () => BrowseView.closeAvatarViewer(),
});

export default BrowseView;
