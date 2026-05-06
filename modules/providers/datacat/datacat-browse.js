// DatacatBrowseView -- DataCat browse/search UI for the Online tab
//
// Data sources:
//   - DataCat API: recent browse, creator browse, faceted tag filtering
//   - JanitorAI MeiliSearch: text search + sort (activated via janny_* sort modes)
//   - Extraction: cloud-browser extraction for JanitorAI-only characters

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    DATACAT_API_BASE,
    resolveDatacatAvatarUrl,
    stripHtml,
    resolveTagNames,
    checkDcPluginAvailable,
    initDcSession,
    fetchDatacatCharacter,
    fetchDatacatDownload,
    fetchDatacatCreator,
    fetchDatacatCreatorCharacters,
    fetchRecentPublic,
    fetchFreshCharacters,
    fetchFacetedTags,
    submitExtraction,
    fetchExtractionStatus,
    searchMeiliJanny,
    fetchHampterCharacters,
    searchSaucepan,
    fetchSaucepanCompanion,
    fetchSaucepanCompanionsOfUser,
    JANNY_TAG_MAP,
    pickRecoveryVariant,
    createFlareSolverrSession,
    destroyFlareSolverrSession,
} from './datacat-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    formatRichText,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    getProviderExcludeTags,
    renderLoadingState,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let datacatCharacters = [];
let datacatCurrentOffset = 0;
let datacatHasMore = true;
let datacatIsLoading = false;
let datacatLoadToken = 0;
let datacatSelectedChar = null;
let datacatGridRenderedCount = 0;

// Browse mode: 'recent' (default) or 'creator'
let datacatBrowseMode = 'recent';

// Creator browsing state
let datacatCreatorId = null;
let datacatCreatorName = '';
// Source of the active creator filter:
//   'datacat'  -> uses DataCat's /api/creators/{uuid}/characters
//   'saucepan' -> uses saucepan.ai /api/v1/companions-of-user?handle=...
//                 (saucepan creators are not present in DataCat's creator DB)
let datacatCreatorSource = 'datacat';
let saucepanCreatorHandle = '';
// When browsing a saucepan creator, the API returns the entire list in one
// shot, so we cache it here and paginate client-side via `loadCharacters`.
let _saucepanCreatorFullList = [];
let _returnToFollowing = false;
let datacatSortMode = 'recent';
let datacatCreatorSortMode = 'chat_count';

let datacatFilterHideOwned = false;
let datacatFilterHidePossible = false;
let datacatFilterHideJanitor = false;
let datacatFilterHideSaucepan = false;

// Fresh endpoint pagination
let datacatFreshLimit24 = 80;
let datacatFreshLimitWeek = 20;
const FRESH_PAGE_INCREMENT = 20;

// NSFW filter (client-side)
let datacatNsfwEnabled = true;

// Faceted tag filtering
let datacatActiveTagIds = new Set();
let datacatTagGroups = [];
let datacatTags = [];
let datacatTagsLoaded = false;

// View mode: 'browse' or 'following'
let datacatViewMode = 'browse';

// Following state
let datacatFollowedCreators = [];
let datacatFollowingCharacters = [];
let datacatFollowingLoading = false;
let datacatFollowingSort = 'newest';
let datacatFollowingDisplayLimit = 60;
let datacatFollowingFiltered = [];

let view; // module-scoped BrowseView instance reference (set once in constructor)

const PAGE_SIZE = 80;

// MeiliSearch (JanitorAI) state
let meiliCurrentPage = 1;
let meiliTotalPages = 0;
let meiliSearchQuery = '';

// Shared JanitorAI tag filter state (used by both MeiliSearch and Hampter modes)
let jannyActiveTagIds = new Set();

// Hampter (JanitorAI) state
let hampterCurrentPage = 1;
let hampterTotalPages = 0;
let hampterSearchQuery = '';

// FlareSolverr session reuse state. Sessions keep a hot Chromium instance
// so subsequent requests skip the Cloudflare challenge.
let flareSession = { url: '', id: '' };
let flareSessionPromise = null;

/**
 * Ensure a FlareSolverr session exists for the given URL. Returns the session
 * ID, or '' if creation failed (caller should fall back to sessionless).
 *
 * Sessions are MUCH faster than sessionless requests on FlareSolverr - even
 * the very first in-session fetch beats sessionless by ~4-5x because cold
 * browser spawns dominate sessionless latency. Always prefer sessions.
 */
async function ensureFlareSession(flareUrl) {
    if (!flareUrl) return '';
    if (flareSession.url === flareUrl && flareSession.id) return flareSession.id;
    if (flareSession.url && flareSession.url !== flareUrl) {
        const stale = flareSession;
        flareSession = { url: '', id: '' };
        destroyFlareSolverrSession(stale.url, stale.id);
    }
    if (flareSessionPromise) return flareSessionPromise;
    flareSessionPromise = (async () => {
        try {
            const id = await createFlareSolverrSession(flareUrl);
            flareSession = { url: flareUrl, id };
            return id;
        } catch (err) {
            console.warn('[DatacatBrowse] FlareSolverr session create failed, falling back to sessionless:', err.message);
            return '';
        } finally {
            flareSessionPromise = null;
        }
    })();
    return flareSessionPromise;
}

function clearFlareSession() {
    if (flareSession.url && flareSession.id) {
        destroyFlareSolverrSession(flareSession.url, flareSession.id);
    }
    flareSession = { url: '', id: '' };
    flareSessionPromise = null;
    flareWarmed = false;
    flareWarmupPromise = null;
}

// Whether the current FlareSolverr session has already solved the JanitorAI
// CF challenge once (cookie cached). Once warm, subsequent fetches are fast.
let flareWarmed = false;
let flareWarmupPromise = null;

/**
 * Pre-warm a FlareSolverr session by creating it AND issuing one background
 * request to JanitorAI's Hampter endpoint to cache the cf_clearance cookie.
 * Called on tab entry so that by the time the user picks a Hampter sort
 * (especially after browsing other modes first), the cookie is already
 * cached and the actual fetch is fast.
 *
 * If the user clicks Hampter during the warmup, loadCharacters() awaits this
 * promise instead of firing a duplicate request.
 */
function prewarmFlareSession(flareUrl) {
    if (!flareUrl || flareWarmed || flareWarmupPromise) return;
    flareWarmupPromise = (async () => {
        try {
            const sessionId = await ensureFlareSession(flareUrl);
            if (!sessionId) return;
            // Single warmup fetch - solves CF challenge and caches cookie.
            await fetchHampterCharacters({
                sort: 'trending',
                page: 1,
                nsfw: true,
                flareSolverrUrl: flareUrl,
                flareSessionId: sessionId,
            });
            flareWarmed = true;
        } catch (err) {
            console.warn('[DatacatBrowse] FlareSolverr prewarm failed:', err.message);
        } finally {
            flareWarmupPromise = null;
        }
    })();
}

// Saucepan state
let saucepanCurrentPage = 1;
let saucepanTotalPages = 0;
let saucepanSearchQuery = '';
let saucepanOpenDefinitionOnly = true;
let saucepanActiveTags = new Set(); // tag slugs (strings) for include filter
let saucepanExcludedTags = new Set(); // tag slugs (strings) for exclude filter
let saucepanDiscoveredTags = new Set(); // slugs harvested from results, merged with curated list

// Extraction state
let extractionPollTimer = null;
let extractionTargetUrl = null;
let extractionTargetId = null;
let extractionStartTime = null;

// ========================================
// FIELD HELPERS (handle camelCase/snake_case from different endpoints)
// ========================================

function getCharId(hit) {
    return hit?.characterId || hit?.character_id || hit?.id || '';
}

function getCreatorId(hit) {
    return hit?.creatorId || hit?.creator_id || '';
}

function getCreatorName(hit) {
    return hit?.creatorName || hit?.creator_name || '';
}

function getChatCount(hit) {
    return parseInt(hit?.chatCount || hit?.chat_count, 10) || 0;
}

function getMsgCount(hit) {
    return parseInt(hit?.messageCount || hit?.message_count, 10) || 0;
}

function getTotalTokens(hit) {
    return parseInt(
        hit?.totalTokens
            || hit?.total_tokens
            || hit?.token_counts?.total_tokens
            || hit?.tokenCounts?.total_tokens,
        10
    ) || 0;
}

function getCreatedDate(hit) {
    const raw = hit?.createdAt || hit?.created_at;
    return raw ? new Date(raw).toLocaleDateString() : '';
}

function isNsfw(hit) {
    return !!(hit?.isNsfw || hit?.is_nsfw);
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(dcChar) {
    const id = getCharId(dcChar);
    if (id && view._lookup.byProviderId.has(String(id))) return true;

    const name = (dcChar.name || '').toLowerCase().trim();
    const creator = getCreatorName(dcChar).toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(c) {
    if (isCharInLocalLibrary(c)) return false;
    return view.isCharPossibleMatch(c.name || '', getCreatorName(c));
}

/**
 * Map a hit's primary_content_source_kind to a normalized source id.
 * DataCat marks Saucepan items explicitly; everything else (including the
 * absence of the field on legacy rows) is treated as JanitorAI.
 * @returns {'janitor'|'saucepan'}
 */
function getSourceKind(hit) {
    return hit?.primary_content_source_kind === 'saucepan' ? 'saucepan' : 'janitor';
}

// ========================================
// CARD RENDERING
// ========================================

function createDatacatCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarUrl = resolveDatacatAvatarUrl(hit) || '/img/ai4.png';
    const charId = getCharId(hit);
    const creatorName = getCreatorName(hit);
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', creatorName);

    // Tags are only present on creator endpoint items, not recent-public
    const tags = resolveTagNames(hit.tags || []).slice(0, 3);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    }

    const sourceBadges = [];
    const sourceKind = getSourceKind(hit);
    // Source badges are only meaningful in DataCat-native sort modes where
    // hits can mix sources (recent / freshest / etc). In single-source sort
    // modes (janny_*, hampter_*, saucepan_*) every card is the same source
    // so the J/S badge is just visual noise. The Following timeline always
    // mixes sources, so badges are always shown there.
    const isSingleSourceMode = !hit._followedCreatorSource && (
        isJannySortMode(datacatSortMode)
        || isHampterSortMode(datacatSortMode)
        || isSaucepanSortMode(datacatSortMode)
    );
    if (!isSingleSourceMode) {
        if (sourceKind === 'saucepan') {
            sourceBadges.push('<span class="browse-feature-badge source-saucepan" title="Source: Saucepan">S</span>');
        } else if (sourceKind === 'janitor') {
            sourceBadges.push('<span class="browse-feature-badge source-janitor" title="Source: JanitorAI">J</span>');
        }
    }

    const nsfwBadge = isNsfw(hit) ? '<span class="browse-nsfw-badge">NSFW</span>' : '';

    const createdDate = getCreatedDate(hit);
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    // Footer stats differ by source
    const chatCount = getChatCount(hit);
    const msgCount = getMsgCount(hit);
    const totalTokens = getTotalTokens(hit);

    let statsHtml;
    if (chatCount || msgCount) {
        statsHtml = `
            <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(chatCount)}</span>
            <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(msgCount)}</span>
        `;
    } else if (totalTokens) {
        const scorerTotal = hit.scorerBaseTotal;
        statsHtml = `<span class="browse-card-stat" title="Total Tokens"><i class="fa-solid fa-text-width"></i> ${formatNumber(totalTokens)}</span>`;
        if (scorerTotal != null && scorerTotal > 0) {
            statsHtml += `<span class="browse-card-stat" title="Quality Score"><i class="fa-solid fa-star"></i> ${Math.round(scorerTotal)}</span>`;
        }
    } else {
        statsHtml = '';
    }

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-datacat-id="${escapeHtml(String(charId))}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${nsfwBadge}
                ${sourceBadges.length > 0 ? `<div class="browse-feature-badges browse-feature-badges-tl">${sourceBadges.join('')}</div>` : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-creator-id="${escapeHtml(getCreatorId(hit))}" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                ${statsHtml}
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function observeNewCards() {
    const grid = document.getElementById('datacatGrid');
    if (grid) datacatBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('datacatGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        datacatGridRenderedCount = 0;
    }

    let filtered = datacatNsfwEnabled
        ? characters
        : characters.filter(c => !isNsfw(c));

    if (datacatFilterHideOwned) {
        filtered = filtered.filter(c => !isCharInLocalLibrary(c));
    }
    if (datacatFilterHidePossible) {
        filtered = filtered.filter(c => !isCharPossibleMatchObj(c));
    }
    if (datacatFilterHideJanitor) {
        filtered = filtered.filter(c => getSourceKind(c) !== 'janitor');
    }
    if (datacatFilterHideSaucepan) {
        filtered = filtered.filter(c => getSourceKind(c) !== 'saucepan');
    }

    // Client-side: persistent exclude tags from settings
    const dcPersistentExclude = getProviderExcludeTags('datacat');
    if (dcPersistentExclude.length > 0) {
        const lowerExclude = dcPersistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = resolveTagNames(c.tags || []).map(n => n.toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }



    const startIdx = append ? datacatGridRenderedCount : 0;
    const html = filtered.slice(startIdx).map(c => createDatacatCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    datacatGridRenderedCount = filtered.length;

    observeNewCards();
    updateLoadMore();
}

function updateLoadMore() {
    datacatBrowseView.updateLoadMoreVisibility('datacatLoadMore', datacatHasMore, datacatCharacters.length > 0);
}

// ========================================
// LOAD CHARACTERS
// ========================================

async function loadCharacters(append = false) {
    if (append && datacatIsLoading) return;
    const thisToken = ++datacatLoadToken;
    datacatIsLoading = true;

    const grid = document.getElementById('datacatGrid');
    const loadMoreBtn = document.getElementById('datacatLoadMoreBtn');

    if (!append && grid) {
        const loadingSource = isHampterSortMode(datacatSortMode) ? 'JanitorAI (Hampter)'
            : isJannySortMode(datacatSortMode) ? 'JanitorAI (MeiliSearch)'
            : isSaucepanSortMode(datacatSortMode) ? 'Saucepan' : 'DataCat';
        renderLoadingState(grid, `Loading from ${loadingSource}...`, 'browse-loading');
    }

    // Helper to update the loading sub-status line during long-running fetches.
    const setLoadingSubstatus = (text) => {
        if (append || !grid) return;
        const labelEl = grid.querySelector('.cl-loading-label');
        if (!labelEl) return;
        let subEl = grid.querySelector('.cl-loading-substatus');
        if (!subEl) {
            subEl = document.createElement('div');
            subEl.className = 'cl-loading-substatus';
            labelEl.insertAdjacentElement('afterend', subEl);
        }
        subEl.textContent = String(text ?? '').replace(/[.\u2026]+\s*$/, '');
    };

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let list = [];
        let total = 0;

        if (datacatBrowseMode === 'creator' && datacatCreatorId) {
            if (datacatCreatorSource === 'saucepan') {
                // Saucepan endpoint returns the full author list in one shot.
                // Fetch once on the initial load, then paginate client-side.
                if (!append) {
                    let full = _saucepanCreatorFullList;
                    if (!full || full.length === 0) {
                        const data = await fetchSaucepanCompanionsOfUser(saucepanCreatorHandle);
                        full = data?.characters || [];
                    } else {
                        // Re-sort the cached list (sortCreatorResults mutates in place)
                        full = full.slice();
                    }
                    sortCreatorResults(full, datacatCreatorSortMode);
                    _saucepanCreatorFullList = full;
                    list = full.slice(0, PAGE_SIZE);
                    total = full.length;
                } else {
                    list = (_saucepanCreatorFullList || []).slice(
                        datacatCharacters.length,
                        datacatCharacters.length + PAGE_SIZE,
                    );
                    total = (_saucepanCreatorFullList || []).length;
                }
            } else {
                const data = await fetchDatacatCreatorCharacters(datacatCreatorId, {
                    limit: PAGE_SIZE,
                    offset: datacatCurrentOffset,
                    sortBy: datacatCreatorSortMode
                });
                list = data?.list || [];
                total = data?.total || 0;
                sortCreatorResults(list, datacatCreatorSortMode);
            }
        } else if (isJannySortMode(datacatSortMode)) {
            if (!append) meiliCurrentPage = 1;
            const data = await searchMeiliJanny({
                search: meiliSearchQuery,
                page: meiliCurrentPage,
                limit: PAGE_SIZE,
                sort: datacatSortMode,
                nsfw: datacatNsfwEnabled,
                includeTags: jannyActiveTagIds,
            });
            list = data?.characters || [];
            total = data?.totalHits || 0;
            meiliTotalPages = data?.totalPages || 0;
        } else if (isHampterSortMode(datacatSortMode)) {
            if (!append) hampterCurrentPage = 1;
            const hampterSort = datacatSortMode.replace('hampter_', '');
            const flareSolverrUrl = (getSetting('datacatFlareSolverrUrl') || '').trim();
            // Always prefer sessions - even the first in-session fetch is
            // ~4-5x faster than sessionless because cold browser spawns
            // dominate sessionless latency on FlareSolverr.
            let flareSessionId = '';
            if (flareSolverrUrl) {
                // If a prewarm is in flight, wait for it instead of firing a
                // duplicate request that would queue behind it.
                if (flareWarmupPromise) {
                    setLoadingSubstatus('Warming FlareSolverr session in the background — waiting for it to finish...');
                    try { await flareWarmupPromise; } catch { /* prewarm errors are logged elsewhere */ }
                }
                const sessionAlreadyExists = !!flareSession.id;
                if (!sessionAlreadyExists) {
                    setLoadingSubstatus('Starting FlareSolverr browser session (one-time, ~1-2s)...');
                }
                flareSessionId = await ensureFlareSession(flareSolverrUrl);
            }
            if (flareSolverrUrl) {
                if (!flareSessionId) {
                    setLoadingSubstatus('FlareSolverr session unavailable — falling back to direct fetch...');
                } else if (flareWarmed && !append) {
                    setLoadingSubstatus('Reusing cached Cloudflare cookie — this should be quick...');
                } else if (flareWarmed) {
                    setLoadingSubstatus('Fetching next page through FlareSolverr session...');
                } else {
                    setLoadingSubstatus('Solving Cloudflare challenge via FlareSolverr. The first request can take 30-60s; subsequent ones are much faster...');
                }
            }
            const fetchOpts = {
                sort: hampterSort,
                page: hampterCurrentPage,
                search: hampterSearchQuery,
                nsfw: datacatNsfwEnabled,
                flareSolverrUrl,
                flareSessionId,
            };
            let data;
            try {
                data = await fetchHampterCharacters(fetchOpts);
                if (flareSessionId) flareWarmed = true;
            } catch (err) {
                if (err?.sessionInvalid && flareSessionId) {
                    setLoadingSubstatus('FlareSolverr session expired — refreshing...');
                    clearFlareSession();
                    const freshId = await ensureFlareSession(flareSolverrUrl);
                    setLoadingSubstatus('Retrying request through new session...');
                    data = await fetchHampterCharacters({ ...fetchOpts, flareSessionId: freshId });
                    if (freshId) flareWarmed = true;
                } else {
                    throw err;
                }
            }
            list = data?.characters || [];
            total = data?.total || 0;
            hampterTotalPages = total > 0 ? Math.ceil(total / (data?.pageSize || 34)) : 0;
        } else if (isSaucepanSortMode(datacatSortMode)) {
            if (!append) saucepanCurrentPage = 1;
            const persistentExclude = getProviderExcludeTags('datacat') || [];
            const mergedExclude = new Set(persistentExclude);
            for (const t of saucepanExcludedTags) mergedExclude.add(t);
            const data = await searchSaucepan({
                search: saucepanSearchQuery,
                page: saucepanCurrentPage,
                limit: PAGE_SIZE,
                sort: datacatSortMode,
                openDefinitionOnly: saucepanOpenDefinitionOnly,
                tags: [...saucepanActiveTags],
                excludedTags: [...mergedExclude],
            });
            list = data?.characters || [];
            total = data?.totalCount || 0;
            saucepanTotalPages = data?.totalPages || 0;
            // Harvest tag slugs from results so the picker grows with what users see
            for (const c of list) {
                const cTags = Array.isArray(c.tags) ? c.tags : [];
                for (const t of cTags) {
                    if (typeof t === 'string' && t) saucepanDiscoveredTags.add(t);
                }
            }
        } else {
            const tagIds = [...datacatActiveTagIds];
            const parsed = parseSortMode(datacatSortMode);
            const useRecent = !parsed || tagIds.length > 0;
            if (useRecent) {
                const data = await fetchRecentPublic({
                    limit: PAGE_SIZE,
                    offset: datacatCurrentOffset,
                    tagIds: tagIds.length > 0 ? tagIds : undefined
                });
                list = data?.characters || [];
                total = data?.totalCount || 0;
            } else {
                const is24h = parsed.window === '24h';
                const data = await fetchFreshCharacters({
                    sortBy: parsed.sortBy,
                    limit24: is24h ? datacatFreshLimit24 : 0,
                    limitWeek: is24h ? 0 : datacatFreshLimitWeek,
                });
                if (data) {
                    list = is24h ? data.last24h : data.thisWeek;
                    total = list.length;
                }
            }
        }

        if (thisToken !== datacatLoadToken) return;
        if (!delegatesInitialized) return;

        const freshParsed = parseSortMode(datacatSortMode);
        const isFreshMode = datacatBrowseMode !== 'creator' && freshParsed && datacatActiveTagIds.size === 0;
        const isMeili = isJannySortMode(datacatSortMode);
        const isHampter = isHampterSortMode(datacatSortMode);
        const isSaucepan = isSaucepanSortMode(datacatSortMode);

        if (isMeili) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            datacatHasMore = meiliCurrentPage < meiliTotalPages;
        } else if (isHampter) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            datacatHasMore = hampterCurrentPage < hampterTotalPages;
        } else if (isSaucepan) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            datacatHasMore = saucepanCurrentPage < saucepanTotalPages;
        } else if (isFreshMode) {
            datacatCharacters = list;
            const activeLimit = freshParsed.window === '24h' ? datacatFreshLimit24 : datacatFreshLimitWeek;
            datacatHasMore = list.length >= activeLimit;
        } else if (append) {
            const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
            datacatCharacters = datacatCharacters.concat(list.filter(c => {
                const id = getCharId(c);
                return !id || !existingIds.has(id);
            }));
            datacatHasMore = (datacatCurrentOffset + PAGE_SIZE) < total;
        } else {
            datacatCharacters = list;
            datacatHasMore = (datacatCurrentOffset + PAGE_SIZE) < total;
        }

        renderGrid(datacatCharacters, append);

        if (!append && datacatCharacters.length === 0) {
            const emptyMsg = datacatBrowseMode === 'creator'
                ? 'No characters found for this creator'
                : 'No characters found';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-cat" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">${emptyMsg}</p>
                </div>
            `;
        }

        debugLog('[DatacatBrowse] Loaded', list.length, 'characters, offset', datacatCurrentOffset, '/', total, 'mode:', datacatBrowseMode);

    } catch (err) {
        if (thisToken !== datacatLoadToken) return;
        console.error('[DatacatBrowse] Load error:', err);
        const isHampterBlocked = err?.code === 'HAMPTER_BLOCKED' && isHampterSortMode(datacatSortMode);
        const isFlareSolverrError = err?.code === 'FLARESOLVERR_ERROR' && isHampterSortMode(datacatSortMode);
        const isInlineNotice = isHampterBlocked || isFlareSolverrError;
        if (!isInlineNotice) {
            showToast(`DataCat load failed: ${err.message}`, 'error');
        }
        if (!append && grid) {
            if (isHampterBlocked) {
                const hasFlareUrl = !!(getSetting('datacatFlareSolverrUrl') || '').trim();
                const flareHint = hasFlareUrl
                    ? '<p style="margin-top: 8px;">Your configured FlareSolverr instance also could not satisfy the challenge. Try restarting it, or check its logs.</p>'
                    : '<p style="margin-top: 8px;">To enable these sort orders, configure a <a href="https://github.com/FlareSolverr/FlareSolverr" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">FlareSolverr</a> instance under Settings &rarr; Online &rarr; DataCat.</p>';
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); max-width: 560px; margin: 0 auto;">
                        <i class="fa-solid fa-shield-halved" style="font-size: 2rem; color: #f5a623;"></i>
                        <p style="margin-top: 12px; color: var(--text-primary);"><strong>JanitorAI blocked this request</strong></p>
                        <p style="margin-top: 8px;">JanitorAI's Hampter endpoint sits behind Cloudflare bot protection and rejects server-side requests. Trending and popular sort orders are unavailable through this extension.</p>
                        <p style="margin-top: 8px;">The other JanitorAI sort orders (MeiliSearch) and Saucepan still work.</p>
                        ${flareHint}
                        <button class="glass-btn" style="margin-top: 12px;" id="datacatRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
            } else if (isFlareSolverrError) {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); max-width: 560px; margin: 0 auto;">
                        <i class="fa-solid fa-fire" style="font-size: 2rem; color: #e74c3c;"></i>
                        <p style="margin-top: 12px; color: var(--text-primary);"><strong>FlareSolverr error</strong></p>
                        <p style="margin-top: 8px;">${escapeHtml(err.message)}</p>
                        <p style="margin-top: 8px;">Verify your FlareSolverr URL under Settings &rarr; Online &rarr; DataCat, or check that the service is running.</p>
                        <button class="glass-btn" style="margin-top: 12px;" id="datacatRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
            } else {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                        <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                        <p style="margin-top: 12px;">Load failed: ${escapeHtml(err.message)}</p>
                        <button class="glass-btn" style="margin-top: 12px;" id="datacatRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
            }
            const retryBtn = document.getElementById('datacatRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
        }
    } finally {
        if (thisToken === datacatLoadToken) {
            datacatIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// FACETED TAG SYSTEM
// ========================================

async function loadFacetedTags() {
    if (datacatTagsLoaded) return;
    try {
        const data = await fetchFacetedTags({ activeTagIds: [...datacatActiveTagIds] });
        if (!data) return;
        datacatTagGroups = data.groups || [];
        datacatTags = data.tags || [];
        datacatTagsLoaded = true;
        renderTagsList(document.getElementById('datacatTagsSearchInput')?.value || '');
        debugLog('[DatacatBrowse] Faceted tags loaded:', datacatTagGroups.length, 'groups,', datacatTags.length, 'tags');
    } catch (e) {
        console.error('[DatacatBrowse] Failed to load faceted tags:', e);
    }
}

async function refreshTagCounts() {
    try {
        const data = await fetchFacetedTags({ activeTagIds: [...datacatActiveTagIds] });
        if (!data) return;
        datacatTags = data.tags || [];
        renderTagsList(document.getElementById('datacatTagsSearchInput')?.value || '');
    } catch (e) {
        debugLog('[DatacatBrowse] Tag count refresh failed:', e);
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    if (datacatTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        return;
    }

    const filterLower = filter.toLowerCase();
    const matchesFilter = (tag) => {
        if (!filter) return true;
        const name = (tag.name || tag.slug || '').toLowerCase();
        const slug = (tag.slug || '').toLowerCase();
        return name.includes(filterLower) || slug.includes(filterLower);
    };

    const sortedGroups = [...datacatTagGroups].sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    let html = '';
    let renderedAny = false;
    for (const group of sortedGroups) {
        const groupTags = datacatTags
            .filter(t => t.groupId === group.id && matchesFilter(t))
            .sort((a, b) => (b.count || 0) - (a.count || 0));
        if (groupTags.length === 0) continue;
        renderedAny = true;

        html += `<div class="dropdown-section-title">${escapeHtml(group.name)}</div>`;
        for (const tag of groupTags) {
            const active = datacatActiveTagIds.has(tag.id);
            const stateClass = active ? 'state-include' : 'state-neutral';
            const stateIcon = active ? '<i class="fa-solid fa-plus"></i>' : '';
            const stateTitle = active ? 'Active: click to remove' : 'Click to filter';
            const countStr = tag.count != null ? ` (${formatNumber(tag.count)})` : '';
            const cleanName = (tag.name || tag.slug || '').replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || tag.name;
            html += `
                <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                    <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                    <span class="tag-label">${escapeHtml(cleanName)}${countStr}</span>
                </div>
            `;
        }
    }

    if (!renderedAny) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = html;

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);

        item.addEventListener('click', () => {
            const tag = datacatTags.find(t => t.id === tagId);
            const group = tag ? datacatTagGroups.find(g => g.id === tag.groupId) : null;

            if (datacatActiveTagIds.has(tagId)) {
                datacatActiveTagIds.delete(tagId);
            } else {
                if (group?.exclusive) {
                    for (const otherTag of datacatTags.filter(t => t.groupId === group.id)) {
                        datacatActiveTagIds.delete(otherTag.id);
                    }
                }
                datacatActiveTagIds.add(tagId);
            }

            cycleTagState(item.querySelector('.browse-tag-state-btn'), datacatActiveTagIds.has(tagId));
            updateTagsButton();
            datacatCurrentOffset = 0;
            loadCharacters(false);
            refreshTagCounts();
        });
    });
}

function cycleTagState(btn, active) {
    btn.className = 'browse-tag-state-btn';
    if (active) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Active: click to remove';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to filter';
    }
}

function cycleTagStateTri(btn, state) {
    if (!btn) return;
    btn.className = 'browse-tag-state-btn';
    if (state === 'include') {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.title = 'Included \u2014 click to exclude';
    } else if (state === 'exclude') {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded \u2014 click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Neutral \u2014 click to include';
    }
}

function updateTagsButton() {
    const btn = document.getElementById('datacatTagsBtn');
    const label = document.getElementById('datacatTagsBtnLabel');
    if (!btn) return;

    const count = isJannyTagMode()
        ? jannyActiveTagIds.size
        : isSaucepanTagMode()
            ? saucepanActiveTags.size + saucepanExcludedTags.size
            : datacatActiveTagIds.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

// ========================================
// JANITORAI TAG SYSTEM (MeiliSearch + Hampter modes)
// ========================================

function isJannyTagMode() {
    return isJannySortMode(datacatSortMode);
}

function isSaucepanTagMode() {
    return isSaucepanSortMode(datacatSortMode);
}

function updateTagsVisibility() {
    const btn = document.getElementById('datacatTagsBtn');
    if (!btn) return;
    // Hampter has no tag-filter API param yet, so we still hide the picker for it.
    const hide = isHampterSortMode(datacatSortMode);
    btn.style.display = hide ? 'none' : '';
    if (hide) {
        const dropdown = document.getElementById('datacatTagsDropdown');
        if (dropdown) dropdown.classList.add('hidden');
    }
}

function updateOpenDefToggleVisibility() {
    const btn = document.getElementById('datacatOpenDefToggle');
    if (!btn) return;
    btn.style.display = isSaucepanSortMode(datacatSortMode) ? '' : 'none';
}

function updateSourceFilterVisibility() {
    const section = document.getElementById('datacatFilterSourceSection');
    if (!section) return;
    // Source filters only meaningful in DataCat-native sort modes (mixed sources).
    // Single-source modes (janny_*, hampter_*, saucepan_*) make these filters useless.
    // Following view always mixes sources from followed creators, so always show.
    if (datacatViewMode === 'following') {
        section.style.display = '';
        return;
    }
    const isSingleSourceMode = isJannySortMode(datacatSortMode)
        || isHampterSortMode(datacatSortMode)
        || isSaucepanSortMode(datacatSortMode);
    section.style.display = isSingleSourceMode ? 'none' : '';
}

function updateOpenDefToggle() {
    const btn = document.getElementById('datacatOpenDefToggle');
    if (!btn) return;
    btn.classList.toggle('active', saucepanOpenDefinitionOnly);
    btn.title = saucepanOpenDefinitionOnly
        ? 'Showing only open-definition characters \u2014 click to include closed'
        : 'Including closed-definition characters \u2014 click to hide';
    const label = btn.querySelector('span');
    if (label) label.textContent = saucepanOpenDefinitionOnly ? 'Open Defs' : 'All Defs';
    const icon = btn.querySelector('i');
    if (icon) icon.className = saucepanOpenDefinitionOnly ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock';
}

const JANNY_ALL_TAGS = Object.entries(JANNY_TAG_MAP)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

function renderJannyTagsList(filter = '') {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    const filtered = filter
        ? JANNY_ALL_TAGS.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
        : JANNY_ALL_TAGS;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jannyActiveTagIds.has(tag.id);
        const stateClass = included ? 'state-include' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = included ? 'Included: click to remove' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        item.addEventListener('click', () => {
            if (jannyActiveTagIds.has(tagId)) {
                jannyActiveTagIds.delete(tagId);
            } else {
                jannyActiveTagIds.add(tagId);
            }
            const btn = item.querySelector('.browse-tag-state-btn');
            cycleTagState(btn, jannyActiveTagIds.has(tagId));
            updateTagsButton();
            if (isHampterSortMode(datacatSortMode)) hampterCurrentPage = 1;
            if (isJannySortMode(datacatSortMode)) meiliCurrentPage = 1;
            datacatCurrentOffset = 0;
            loadCharacters(false);
        });
    });
}

// ========================================
// SAUCEPAN TAG SYSTEM
// ========================================

// Curated seed list of Saucepan tag slugs. Saucepan exposes tags as plain
// slug strings (no listing endpoint), so we ship a known set and merge in
// any new slugs discovered in search results (`saucepanDiscoveredTags`).
const SAUCEPAN_KNOWN_TAGS = [
    'abuse','action','adventure','adventurer','age_gap','age_play','alien','ambitious','angst','anime',
    'anti_hero','anxious','any_pov','arranged_marriage','artist','assassin','assistant','athlete',
    'bakadere','bar','bartender','bdsm','bdsm_verse','beach','best_friend','betrayal','bi','biker',
    'bimbo_himbo','blackmail','blood_play','blue_collar','body_horror','body_worship','bodyguard',
    'bondage','boss','bottom','brat','brat_taming','breastplay','breath_play','breeding','bully',
    'business_owner','cannibalism','captive','celebrity','chance_meeting','charismatic','cheating',
    'chef','childhood_friend','chosen_one','closeted','club','cnc','colleagues_to_lovers','college',
    'comedy','comfort','comic','coming_of_age','concubine','conspiracy','contemporary','content_creator',
    'contractual_relationship','cowboy_cowgirl','crush','curse','cyberpunk','dandere','daredevil',
    'dark_romance','dead_dove','death','deity','demi_human','demi_pov','demisexual','demon','deredere',
    'detective','dilf','disabled','doctor','dom','drag_crossdress','dragon','drugs_addiction','dystopian',
    'eldritch','elf','emo','emotionally_unavailable','empath','empathetic','enemies_to_lovers','enhanced',
    'ensemble_cast','esl','ex','executive','exhibitionism','extroverted','face_sitting','fake_relationship',
    'fantasy','farm_setting','farmer','fem','fem_pov','female','femboy','feral','filthy','firefighter',
    'fluff','food_play','forbidden_love','forced_proximity','found_family','freedom','freeuse',
    'friends_to_lovers','furry','futa','fwb','game','gangster','gender_bend','genderfluid','genki',
    'gentle_giant','giant','gore','grumpy','gyaru','hair_kink','harem','healer','heat_rut','hedonistic',
    'hero','hikikomori','himedere','historical','holidays','home','homeless','hookup','horror','hospital',
    'hostage','housespouse','human','humiliation','hunter','hurt_comfort','hurt_no_comfort','hyper',
    'identity','impact_play','incel','incest_stepcest','indentured','independent','injured_user',
    'interactive_rpg','intern','intersex','intersex_pov','introverted','jock','justice','kakkodere',
    'kamidere','kouhai','kuudere','laboratory','lactation','large_anatomy','lore_heavy','love_triangle',
    'lover','loyal','m4a','m4w','mafia','mage','magical','maid_butler','male','male_pov','manipulator',
    'mansion','martial_artist','masc','masochist','mastermind','masturbation','mean_catty','mechanic',
    'medieval','mentally_ill','milf','military','mind_control','mlm','monster','monster_boy',
    'monster_girl','monster_pov','movie','multiple','murderer','musician','mutant','mystery',
    'mythological','needy_clingy','neighbor','nerd','neurodivergent','ninja_samurai','nobility','noir',
    'non_canonical_au','non_human','non_human_genitalia','non_human_pov','noncon_dubcon','ntr','nurse',
    'o_l','oc','olfactophilia','omegaverse','online','oral','orgasm_denial','ovipositor','owner',
    'pansexual','parallel_universe','part_timer','partner','party_member','performer','person_next_door',
    'perverted','pet_play','pimp','pirate','platonic','playful','plus_sized_bot','plushophilia',
    'politics','popular','porn_star','portal','post_apocalyptic','power_dynamics','praise_kink',
    'pregnant','primal_play','prison','pro_dom','promiscuous','psychological','queer','quest','racer',
    'redemption','rejection','religion','reluctant_hero','revenge','rival','robot','rogue','romance',
    'roommate','royalty','rpg','sacrifice','sadist','sassy','savior','scenario','sci_fi','scientist',
    'second_person_pov','self_harm_suicide','selfish','sensitive','sensory_play','servant','sex_toys',
    'sex_worker','sexual_awakening','sexual_roleplay','size_difference','slice_of_life','slow_burn',
    'slur_usage','small_town','smut','soft_dom','soldier','somnophilia','soulmate','space',
    'special_agents','spouse','spy','stalker','step_parent','step_sibling','stoner','stranger',
    'stripper','student','sub','sugar_parent','supernatural','survival','switch','t4t','t4w',
    'tavern_inn','teacher_professor','teammate','temperature_play','therapist','third_person_pov',
    'thriller','time_travel','tomboy','top','trans','transformation','trauma','tsundere','tv_show',
    'two_faced','undead','unemployed','unestablished_relationship','unreliable','unreliable_narrator',
    'unrequited_love','urban_fantasy','urban_fiction','user_harm','utility','vampire','vanilla',
    'villain','villain_pov','villainess','vintage','violence','virgin','voyeurism','vtuber','w4a',
    'w4m','war','warrior','watersports','wealthy','weapon_play','well_intentioned_extremist',
    'werewolf','white_collar','widowed','wlw','workplace','writer','y2k','yandere',
];

function getSaucepanAllTags() {
    const merged = new Set(SAUCEPAN_KNOWN_TAGS);
    for (const t of saucepanDiscoveredTags) merged.add(t);
    return [...merged].sort((a, b) => a.localeCompare(b));
}

function formatSaucepanTag(slug) {
    return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderSaucepanTagsList(filter = '') {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    const all = getSaucepanAllTags();
    const filterLower = filter.toLowerCase();
    const filtered = filter ? all.filter(t => t.includes(filterLower)) : all;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    // Sort: active filters (include or exclude) first, then alphabetical
    const sorted = [...filtered].sort((a, b) => {
        const aActive = saucepanActiveTags.has(a) || saucepanExcludedTags.has(a);
        const bActive = saucepanActiveTags.has(b) || saucepanExcludedTags.has(b);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return a.localeCompare(b);
    });

    container.innerHTML = sorted.map(slug => {
        const state = saucepanActiveTags.has(slug) ? 'include'
            : saucepanExcludedTags.has(slug) ? 'exclude'
            : 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>'
            : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>'
            : '';
        const stateTitle = state === 'include' ? 'Included \u2014 click to exclude'
            : state === 'exclude' ? 'Excluded \u2014 click to clear'
            : 'Neutral \u2014 click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-slug="${escapeHtml(slug)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(formatSaucepanTag(slug))}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const slug = item.dataset.tagSlug;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const cycle = () => {
            // neutral -> include -> exclude -> neutral
            if (saucepanActiveTags.has(slug)) {
                saucepanActiveTags.delete(slug);
                saucepanExcludedTags.add(slug);
                cycleTagStateTri(stateBtn, 'exclude');
            } else if (saucepanExcludedTags.has(slug)) {
                saucepanExcludedTags.delete(slug);
                cycleTagStateTri(stateBtn, 'neutral');
            } else {
                saucepanActiveTags.add(slug);
                cycleTagStateTri(stateBtn, 'include');
            }
            updateTagsButton();
            saucepanCurrentPage = 1;
            datacatCurrentOffset = 0;
            loadCharacters(false);
        };
        item.addEventListener('click', cycle);
    });
}

// ========================================
// SORT OPTIONS
// ========================================

const FRESH_SORT_LABELS = [
    { value: 'fresh', label: '🌟 Freshest' },
    { value: 'score', label: '⭐ Score' },
    { value: 'chat_count', label: '💬 Chat Count' },
    { value: 'messages_per_chat', label: '📊 MSG/Chat' },
    { value: 'first_published', label: '📅 First Published' },
];

const CREATOR_SORT_OPTIONS = [
    { value: 'chat_count', label: '💬 Most Messages' },
    { value: 'newest', label: '🆕 Newest' },
    { value: 'oldest', label: '🕐 Oldest' },
];

function isJannySortMode(mode) {
    return mode?.startsWith('janny_');
}

function isHampterSortMode(mode) {
    return mode?.startsWith('hampter_');
}

function isSaucepanSortMode(mode) {
    return mode?.startsWith('saucepan_');
}

function parseSortMode(mode) {
    if (mode === 'recent') return null;
    if (isJannySortMode(mode)) return null;
    if (isHampterSortMode(mode)) return null;
    if (isSaucepanSortMode(mode)) return null;
    if (mode.endsWith('_week')) return { sortBy: mode.slice(0, -5), window: 'week' };
    if (mode.endsWith('_24h')) return { sortBy: mode.slice(0, -4), window: '24h' };
    return { sortBy: mode, window: '24h' };
}

const JANNY_SORT_OPTIONS = [
    { value: 'janny_newest', label: '🆕 Newest' },
    { value: 'janny_oldest', label: '🕐 Oldest' },
    { value: 'janny_tokens_desc', label: '📊 Most Tokens' },
    { value: 'janny_tokens_asc', label: '📊 Least Tokens' },
    { value: 'janny_relevant', label: '🔍 Relevance' },
];

const HAMPTER_SORT_OPTIONS = [
    { value: 'hampter_trending', label: '🔥 Trending' },
    { value: 'hampter_popular', label: '👑 Popular' },
];

const SAUCEPAN_SORT_OPTIONS = [
    { value: 'saucepan_new', label: '🆕 New' },
    { value: 'saucepan_trending', label: '🔥 Trending' },
    { value: 'saucepan_popular', label: '👑 Popular' },
];

function buildSortOptionsHtml(selected) {
    let html = `<option value="recent" ${selected === 'recent' ? 'selected' : ''}>🆕 Recent</option>`;
    html += '<optgroup label="Last 24 Hours">';
    for (const o of FRESH_SORT_LABELS) {
        const val = `${o.value}_24h`;
        html += `<option value="${val}" ${val === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup><optgroup label="This Week">';
    for (const o of FRESH_SORT_LABELS) {
        const val = `${o.value}_week`;
        html += `<option value="${val}" ${val === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    html += '<optgroup label="JanitorAI (Hampter)">';
    for (const o of HAMPTER_SORT_OPTIONS) {
        html += `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    html += '<optgroup label="JanitorAI (MeiliSearch)">';
    for (const o of JANNY_SORT_OPTIONS) {
        html += `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    html += '<optgroup label="Saucepan">';
    for (const o of SAUCEPAN_SORT_OPTIONS) {
        html += `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    return html;
}

function updateSortOptions() {
    const el = document.getElementById('datacatSortSelect');
    if (!el) return;
    const isCreator = datacatBrowseMode === 'creator';
    if (isCreator) {
        const current = datacatCreatorSortMode;
        el.innerHTML = CREATOR_SORT_OPTIONS.map(o =>
            `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`
        ).join('');
    } else {
        el.innerHTML = buildSortOptionsHtml(datacatSortMode);
    }
    el._customSelect?.refresh();
}

function sortCreatorResults(list, mode) {
    if (mode === 'chat_count') {
        list.sort((a, b) => getMsgCount(b) - getMsgCount(a) || getChatCount(b) - getChatCount(a));
    } else if (mode === 'newest') {
        list.sort((a, b) => {
            const da = new Date(a.createdAt || a.created_at || 0);
            const db = new Date(b.createdAt || b.created_at || 0);
            return db - da;
        });
    } else if (mode === 'oldest') {
        list.sort((a, b) => {
            const da = new Date(a.createdAt || a.created_at || 0);
            const db = new Date(b.createdAt || b.created_at || 0);
            return da - db;
        });
    }
}

// ========================================
// CREATOR BROWSING
// ========================================

async function browseCreator(creatorId, opts = {}) {
    if (!creatorId) return;
    const source = opts.source === 'saucepan' ? 'saucepan' : 'datacat';
    datacatBrowseMode = 'creator';
    datacatCreatorId = creatorId;
    datacatCreatorSource = source;
    saucepanCreatorHandle = source === 'saucepan' ? (opts.handle || '') : '';
    _saucepanCreatorFullList = [];
    datacatCurrentOffset = 0;
    datacatCharacters = [];
    datacatHasMore = true;
    datacatGridRenderedCount = 0;

    const banner = document.getElementById('datacatCreatorBanner');
    const bannerName = document.getElementById('datacatCreatorBannerName');

    if (source === 'saucepan') {
        // Saucepan creators aren't on DataCat - skip the creator profile lookup.
        datacatCreatorName = opts.name || saucepanCreatorHandle || creatorId;
    } else {
        const creator = await fetchDatacatCreator(creatorId);
        if (creator) {
            datacatCreatorName = creator.userName || creatorId;
        } else {
            datacatCreatorName = creatorId;
        }
    }

    if (banner && bannerName) {
        bannerName.textContent = datacatCreatorName;
        banner.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }

    updateFollowButton(creatorId, source);

    datacatCreatorSortMode = 'chat_count';
    const creatorSortEl = document.getElementById('datacatCreatorSortSelect');
    if (creatorSortEl) creatorSortEl.value = 'chat_count';

    updateSortOptions();

    loadCharacters(false);
}

function clearCreatorFilter() {
    datacatBrowseMode = 'recent';
    datacatCreatorId = null;
    datacatCreatorName = '';
    datacatCreatorSource = 'datacat';
    saucepanCreatorHandle = '';
    _saucepanCreatorFullList = [];
    datacatCharacters = [];
    datacatCurrentOffset = 0;
    datacatFreshLimit24 = 80;
    datacatFreshLimitWeek = 20;
    datacatHasMore = true;
    datacatGridRenderedCount = 0;

    const banner = document.getElementById('datacatCreatorBanner');
    if (banner) banner.classList.add('hidden');

    const followBtn = document.getElementById('datacatFollowCreatorBtn');
    if (followBtn) followBtn.style.display = 'none';

    if (_returnToFollowing) {
        _returnToFollowing = false;
        switchDatacatViewMode('following');
        return;
    }

    updateSortOptions();

    loadCharacters(false);
}

// ========================================
// SEARCH
// ========================================

function updateSearchPlaceholder() {
    const input = document.getElementById('datacatSearchInput');
    if (!input) return;
    input.placeholder = 'Search characters or paste a URL...';
}

function switchToMeiliSearch(query) {
    datacatSortMode = 'janny_relevant';
    const sortEl = document.getElementById('datacatSortSelect');
    if (sortEl) sortEl.value = 'janny_relevant';
    meiliSearchQuery = query;
    meiliCurrentPage = 1;
    datacatCurrentOffset = 0;
    updateSearchPlaceholder();
    updateTagsVisibility();
    loadCharacters(false);
}

function doSearch() {
    const input = document.getElementById('datacatSearchInput');
    const val = (input?.value || '').trim();
    if (!val) {
        // Clear MeiliSearch query if in janny mode and search is emptied
        if (isJannySortMode(datacatSortMode) && meiliSearchQuery) {
            meiliSearchQuery = '';
            meiliCurrentPage = 1;
            datacatCurrentOffset = 0;
            loadCharacters(false);
        }
        // Clear Hampter query if in hampter mode and search is emptied
        if (isHampterSortMode(datacatSortMode) && hampterSearchQuery) {
            hampterSearchQuery = '';
            hampterCurrentPage = 1;
            loadCharacters(false);
        }
        // Clear Saucepan query if in saucepan mode and search is emptied
        if (isSaucepanSortMode(datacatSortMode) && saucepanSearchQuery) {
            saucepanSearchQuery = '';
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
        return;
    }

    // UUID -> browse creator
    const uuidMatch = val.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    if (uuidMatch) {
        browseCreator(val);
        return;
    }

    // DataCat URL -> browse creator or look up character
    try {
        const url = new URL(val.startsWith('http') ? val : `https://${val}`);
        if (/datacat\.run$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/characters?\/(?:[^/]+\/)*([a-f0-9-]{36})/i);
            if (charMatch) {
                fetchCharacterAndOpenPreview(charMatch[1]);
                return;
            }
            const creatorMatch = url.pathname.match(/\/creators?\/([a-f0-9-]{36})/i);
            if (creatorMatch) {
                browseCreator(creatorMatch[1]);
                return;
            }
        }

        // JanitorAI URL -> look up on DataCat, offer extraction if not found
        if (/^(www\.)?janitorai\.com$/i.test(url.hostname) || /^(www\.)?jannyai\.com$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/characters\/([a-f0-9-]{36})/i);
            if (charMatch) {
                lookupExternalCharacter(charMatch[1], val, 'janitor');
                return;
            }
        }

        // Saucepan URL -> look up on DataCat, offer extraction if not found
        if (/^(www\.)?saucepan\.ai$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/companion\/([a-f0-9-]{36})/i);
            if (charMatch) {
                lookupExternalCharacter(charMatch[1], val, 'saucepan');
                return;
            }
        }
    } catch { /* not a URL */ }

    // Text search in Hampter mode
    if (isHampterSortMode(datacatSortMode)) {
        hampterSearchQuery = val;
        hampterCurrentPage = 1;
        loadCharacters(false);
        return;
    }

    // Text search in MeiliSearch mode
    if (isJannySortMode(datacatSortMode)) {
        meiliSearchQuery = val;
        meiliCurrentPage = 1;
        datacatCurrentOffset = 0;
        loadCharacters(false);
        return;
    }

    // Text search in Saucepan mode
    if (isSaucepanSortMode(datacatSortMode)) {
        saucepanSearchQuery = val;
        saucepanCurrentPage = 1;
        loadCharacters(false);
        return;
    }

    // Text search from any other mode: switch to MeiliSearch relevance
    switchToMeiliSearch(val);
}

function performDatacatCreatorSearch() {
    const input = document.getElementById('datacatCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Please enter a creator name or URL', 'warning');
        return;
    }
    input.value = '';

    // URL detection
    try {
        const u = new URL(query.startsWith('http') ? query : `https://${query}`);
        if (/datacat\.run$/i.test(u.hostname)) {
            const creatorMatch = u.pathname.match(/\/creators?\/([a-f0-9-]{36})/i);
            if (creatorMatch) {
                browseCreator(creatorMatch[1]);
                return;
            }
        }
    } catch { /* not a URL */ }

    const lowerQuery = query.toLowerCase();

    // Helper: route to saucepan creator browse if the matched hit is a
    // saucepan card (their author IDs are not in DataCat's creator DB).
    const routeFromHit = (hit) => {
        const creatorId = getCreatorId(hit);
        if (!creatorId) return false;
        if (getSourceKind(hit) === 'saucepan') {
            const handle = getCreatorName(hit);
            browseCreator(creatorId, { source: 'saucepan', handle, name: handle });
        } else {
            browseCreator(creatorId);
        }
        return true;
    };

    // Scan followed creators
    const followMatch = datacatFollowedCreators.find(c => c.name?.toLowerCase() === lowerQuery);
    if (followMatch) {
        browseCreator(followMatch.id);
        return;
    }

    // Scan currently loaded browse characters
    const browseMatch = datacatCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (browseMatch && routeFromHit(browseMatch)) return;

    // Scan following timeline characters
    const followingMatch = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (followingMatch && routeFromHit(followingMatch)) return;

    // Partial match fallback
    const partialFollow = datacatFollowedCreators.find(c => c.name?.toLowerCase().includes(lowerQuery));
    if (partialFollow) {
        browseCreator(partialFollow.id);
        return;
    }

    const partialBrowse = datacatCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialBrowse && routeFromHit(partialBrowse)) return;

    const partialFollowing = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialFollowing && routeFromHit(partialFollowing)) return;

    // No local match. If we're in a saucepan sort mode, treat the input as a
    // saucepan handle and try fetching the author's companions directly.
    if (isSaucepanSortMode(datacatSortMode)) {
        browseCreator(query, { source: 'saucepan', handle: query, name: query });
        return;
    }

    showToast('Creator not found. Try pasting a DataCat creator URL instead.', 'warning');
}

async function fetchCharacterAndOpenPreview(characterId) {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        renderLoadingState(grid, 'Looking up character...', 'browse-loading');
    }

    try {
        const character = await fetchDatacatCharacter(characterId);
        if (character) {
            openPreviewModal(character);
        } else {
            showToast('Character not found on DataCat', 'error');
        }
        clearCreatorFilter();
    } catch (e) {
        showToast(`Failed to look up character: ${e.message}`, 'error');
        clearCreatorFilter();
    }
}

// ========================================
// EXTERNAL SOURCE LOOKUP + EXTRACTION (JanitorAI, Saucepan)
// ========================================

const EXTRACT_SOURCES = {
    janitor: {
        label: 'JanitorAI',
        icon: 'fa-solid fa-cat',
        urlBase: 'https://janitorai.com/characters/',
        notFoundCopy: 'JanitorAI character',
    },
    saucepan: {
        label: 'Saucepan',
        icon: 'fa-solid fa-bowl-food',
        urlBase: 'https://saucepan.ai/companion/',
        notFoundCopy: 'Saucepan character',
    },
};

async function lookupExternalCharacter(charId, originalUrl, source = 'janitor') {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        renderLoadingState(grid, 'Looking up character on DataCat...', 'browse-loading');
    }

    // Hide creator banner, load more, etc.
    const banner = document.getElementById('datacatCreatorBanner');
    if (banner) banner.classList.add('hidden');
    const loadMoreEl = document.getElementById('datacatLoadMore');
    if (loadMoreEl) loadMoreEl.style.display = 'none';

    try {
        const character = await fetchDatacatCharacter(charId);
        if (character) {
            openPreviewModal(character);
            clearCreatorFilter();
            return;
        }
    } catch { /* not found */ }

    showExtractionPanel(charId, originalUrl, source);
}

// Saucepan card click: try DataCat lookup without resetting browse state.
// If found, open preview. If not, prompt extraction in a modal-like overlay
// so the user can return to their saucepan grid afterwards.
async function openSaucepanCardPreview(hit) {
    // Retained for any callers that still want the lookup-then-extract flow.
    // The standard grid click now goes through openPreviewModal() directly,
    // which surfaces the inline extraction CTA when the DataCat lookup fails.
    const charId = String(getCharId(hit));
    const url = `https://saucepan.ai/companion/${charId}`;
    try {
        const character = await fetchDatacatCharacter(charId);
        if (character) {
            openPreviewModal(character);
            return;
        }
    } catch { /* not found on DataCat */ }
    showExtractionPanel(charId, url, 'saucepan');
}

function showExtractionPanel(charId, originalUrl, source = 'janitor') {
    const grid = document.getElementById('datacatGrid');
    if (!grid) return;

    const cfg = EXTRACT_SOURCES[source] || EXTRACT_SOURCES.janitor;
    const sourceUrl = originalUrl || `${cfg.urlBase}${charId}`;
    const shortId = charId.substring(0, 8);

    grid.innerHTML = `
        <div class="datacat-extract-panel" style="grid-column: 1 / -1;">
            <div class="datacat-extract-icon">
                <i class="${cfg.icon}"></i>
            </div>
            <h3>Character Not on DataCat</h3>
            <p class="datacat-extract-desc">
                This ${cfg.notFoundCopy} (<code>${escapeHtml(shortId)}...</code>) hasn't been extracted yet.
                DataCat can retrieve its definition using a cloud browser instance.
            </p>
            <p class="datacat-extract-note">
                <i class="fa-solid fa-circle-info"></i>
                Extraction typically takes 15-60 seconds. A public account is used by default.
            </p>
            <div class="datacat-extract-actions">
                <button id="datacatExtractBtn" class="action-btn primary" data-url="${escapeHtml(sourceUrl)}" data-id="${escapeHtml(charId)}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Extract Character
                </button>
                <a href="${escapeHtml(sourceUrl)}" target="_blank" class="action-btn secondary">
                    <i class="fa-solid fa-external-link"></i> View on ${cfg.label}
                </a>
            </div>
            <div id="datacatExtractProgress" class="datacat-extract-progress hidden"></div>
        </div>
    `;

    const extractBtn = document.getElementById('datacatExtractBtn');
    if (extractBtn) {
        extractBtn.addEventListener('click', () => {
            startExtraction(extractBtn.dataset.url, extractBtn.dataset.id);
        });
    }
}

async function startExtraction(janitorUrl, janitorId) {
    const extractBtn = document.getElementById('datacatExtractBtn');
    const progressEl = document.getElementById('datacatExtractProgress');
    if (!extractBtn || !progressEl) return;

    extractBtn.disabled = true;
    extractBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = `
        <div class="datacat-extract-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Submitting extraction request...</span>
        </div>
    `;

    extractionTargetUrl = janitorUrl;
    extractionTargetId = janitorId;
    extractionStartTime = Date.now();

    try {
        const result = await submitExtraction(janitorUrl, { publicFeed: getSetting('datacatPublicFeed') === true });

        if (result.queued || result.started) {
            extractBtn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> Extracting...';
            const position = result.queued ? ` (queue position: ${result.queuePosition || 1})` : '';
            updateExtractionProgress('pending', result.queued ? `Queued for extraction${position}` : 'Extraction started, waiting for completion...');
            startExtractionPolling(janitorId);
        } else if (result.requiresLogin) {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract Character';
            updateExtractionProgress('error', 'DataCat has no valid session. The extraction service may be temporarily unavailable.');
        } else if (result.error || result.errorCode) {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateExtractionProgress('error', result.message || result.error || 'Extraction failed');
        } else {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateExtractionProgress('error', 'Unexpected response from DataCat');
        }
    } catch (e) {
        extractBtn.disabled = false;
        extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
        updateExtractionProgress('error', `Failed to submit: ${e.message}`);
    }
}

function humanizeExtractionError(msg) {
    if (!msg) return 'Extraction failed';
    if (/CHARACTER_NOT_FOUND_OR_SET_TO_PRIVATE/i.test(msg)) return 'Character not found or privated';
    if (/WORKER.?ERROR/i.test(msg)) return msg.replace(/WORKER.?ERROR\s*\(?/i, '').replace(/\)$/, '').trim() || 'Extraction failed';
    return msg;
}

function updateExtractionProgress(status, message) {
    const progressEl = document.getElementById('datacatExtractProgress');
    if (!progressEl) return;

    let icon, colorClass;
    switch (status) {
        case 'pending':
            icon = 'fa-solid fa-spinner fa-spin';
            colorClass = 'datacat-extract-pending';
            break;
        case 'success':
            icon = 'fa-solid fa-check-circle';
            colorClass = 'datacat-extract-success';
            break;
        case 'error':
            icon = 'fa-solid fa-exclamation-circle';
            colorClass = 'datacat-extract-error';
            break;
        default:
            icon = 'fa-solid fa-circle-info';
            colorClass = '';
    }

    const elapsed = extractionStartTime ? Math.round((Date.now() - extractionStartTime) / 1000) : 0;
    const elapsedText = elapsed > 0 && status === 'pending' ? ` <span class="datacat-extract-elapsed">(${elapsed}s)</span>` : '';

    progressEl.innerHTML = `
        <div class="datacat-extract-status ${colorClass}">
            <i class="${icon}"></i>
            <span>${escapeHtml(message)}${elapsedText}</span>
        </div>
    `;
}

function startExtractionPolling(janitorId) {
    stopExtractionPolling();

    let elapsedTimer = setInterval(() => {
        const progressEl = document.getElementById('datacatExtractProgress');
        if (!progressEl || !extractionStartTime) { clearInterval(elapsedTimer); return; }
        const statusEl = progressEl.querySelector('.datacat-extract-elapsed');
        if (statusEl) {
            const elapsed = Math.round((Date.now() - extractionStartTime) / 1000);
            statusEl.textContent = `(${elapsed}s)`;
        }
    }, 1000);

    extractionPollTimer = setInterval(async () => {
        try {
            const status = await fetchExtractionStatus();
            if (!status) return;

            // Check if our extraction completed (appears in history)
            const completedEntry = status.history?.find(h => {
                const historyId = String(h.characterId || '').trim();
                return historyId === janitorId;
            });

            if (completedEntry) {
                clearInterval(elapsedTimer);
                stopExtractionPolling();

                if (completedEntry.success !== false && completedEntry.status !== 'error') {
                    updateExtractionProgress('success', 'Extraction complete! Loading character...');
                    // Fetch the now-available character
                    setTimeout(() => fetchExtractedCharacter(janitorId), 1000);
                } else {
                    const errMsg = humanizeExtractionError(completedEntry.error || completedEntry.message);
                    updateExtractionProgress('error', errMsg);
                    const extractBtn = document.getElementById('datacatExtractBtn');
                    if (extractBtn) {
                        extractBtn.disabled = false;
                        extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                }
                return;
            }

            // Still in progress: update status text
            if (status.inProgress) {
                const phase = status.inProgress.status || 'processing';
                const phaseNames = {
                    opening_page: 'Opening character page',
                    preparing: 'Preparing extraction',
                    initiating: 'Initiating extraction',
                    pulling: 'Pulling character data',
                    post_extract: 'Finalizing',
                    complete: 'Completing',
                };
                const phaseName = phaseNames[phase] || phase.replace(/_/g, ' ');
                updateExtractionProgress('pending', phaseName + '...');
            } else if (status.queueLength > 0) {
                updateExtractionProgress('pending', `Waiting in queue (${status.queueLength} ahead)...`);
            }
        } catch (e) {
            debugLog('[DatacatBrowse] Extraction poll error:', e);
        }
    }, 3000);
}

function stopExtractionPolling() {
    if (extractionPollTimer) {
        clearInterval(extractionPollTimer);
        extractionPollTimer = null;
    }
}

function clearExtractionState() {
    stopExtractionPolling();
    extractionTargetUrl = null;
    extractionTargetId = null;
    extractionStartTime = null;
}

async function fetchExtractedCharacter(janitorId) {
    try {
        const character = await fetchDatacatCharacter(janitorId);
        if (character) {
            character._fullCharacter = character;
            openPreviewModal(character);
            return;
        }
        // Might need a brief delay for DataCat indexing
        await new Promise(r => setTimeout(r, 2000));
        const retry = await fetchDatacatCharacter(janitorId);
        if (retry) {
            retry._fullCharacter = retry;
            openPreviewModal(retry);
            return;
        }
        updateExtractionProgress('success', 'Extraction complete, but the character could not be loaded yet. Try searching again in a moment.');
    } catch (e) {
        updateExtractionProgress('error', `Character extracted but failed to load: ${e.message}`);
    }
}

// ========================================
// MODAL EXTRACTION (extract from preview modal)
// ========================================

function updateInlineExtractionCTA(state, detail) {
    const cta = document.querySelector('.datacat-modal-extract-cta');
    if (!cta) return;
    const iconWrap = cta.querySelector('.datacat-modal-extract-icon-wrap');
    const message = cta.querySelector('.datacat-modal-extract-message');
    const hint = cta.querySelector('.datacat-modal-extract-hint');
    const btn = cta.querySelector('.datacat-modal-extract-btn');

    cta.classList.remove('extracting', 'success', 'error');

    if (state === 'submitting') {
        cta.classList.add('extracting');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Submitting extraction request...';
        if (hint) hint.textContent = '';
        if (btn) btn.style.display = 'none';
    } else if (state === 'extracting') {
        cta.classList.add('extracting');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Extraction in progress';
        if (hint) hint.textContent = detail || '';
        if (btn) btn.style.display = 'none';
    } else if (state === 'progress') {
        if (message) message.textContent = detail || 'Extracting...';
    } else if (state === 'done') {
        cta.classList.add('success');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-check datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Extraction complete!';
        if (hint) hint.textContent = 'Loading character...';
        if (btn) btn.style.display = 'none';
    } else if (state === 'error') {
        cta.classList.add('error');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-triangle-exclamation datacat-modal-extract-icon"></i>';
        if (message) message.textContent = detail || 'Extraction failed';
        if (hint) hint.textContent = 'Try again or check back later.';
        if (btn) { btn.disabled = false; btn.style.display = ''; btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry'; }
    }
}

async function startModalExtraction(charId, source = 'janitor') {
    const importBtn = document.getElementById('datacatImportBtn');
    if (!importBtn) return;

    const cfg = EXTRACT_SOURCES[source] || EXTRACT_SOURCES.janitor;
    const sourceUrl = `${cfg.urlBase}${charId}`;

    importBtn.disabled = true;
    importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';
    updateInlineExtractionCTA('submitting');

    extractionTargetUrl = sourceUrl;
    extractionTargetId = charId;
    extractionStartTime = Date.now();

    try {
        const result = await submitExtraction(sourceUrl, { publicFeed: getSetting('datacatPublicFeed') === true });

        if (result.queued || result.started) {
            importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting...';
            const position = result.queued ? ` (${result.queuePosition || 1})` : '';
            updateInlineExtractionCTA('extracting', position.trim() ? `Queue position${position}` : '');
            startModalExtractionPolling(charId);
        } else if (result.requiresLogin) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
            updateInlineExtractionCTA('error', 'Session unavailable');
            showToast('DataCat has no valid session. The extraction service may be temporarily unavailable.', 'error');
        } else {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateInlineExtractionCTA('error', result.message || result.error || 'Extraction failed');
            showToast(result.message || result.error || 'Extraction failed', 'error');
        }
    } catch (e) {
        importBtn.disabled = false;
        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
        updateInlineExtractionCTA('error', e.message);
        showToast(`Failed to submit extraction: ${e.message}`, 'error');
    }
}

function startModalExtractionPolling(charId) {
    stopExtractionPolling();

    const importBtn = document.getElementById('datacatImportBtn');

    let elapsedTimer = setInterval(() => {
        if (!importBtn || !extractionStartTime) { clearInterval(elapsedTimer); return; }
        const elapsed = Math.round((Date.now() - extractionStartTime) / 1000);
        if (importBtn.disabled) {
            const phase = importBtn.dataset.extractPhase || 'Extracting';
            const label = `${phase}... (${elapsed}s)`;
            updateInlineExtractionCTA('progress', label);
        }
    }, 1000);

    extractionPollTimer = setInterval(async () => {
        try {
            const status = await fetchExtractionStatus();
            if (!status) return;

            const completedEntry = status.history?.find(h => {
                const historyId = String(h.characterId || '').trim();
                return historyId === charId;
            });

            if (completedEntry) {
                clearInterval(elapsedTimer);
                clearExtractionState();

                if (completedEntry.success !== false && completedEntry.status !== 'error') {
                    if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Done! Loading...';
                    updateInlineExtractionCTA('done');
                    showToast('Extraction complete! Loading character...', 'success');
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const character = await fetchDatacatCharacter(charId);
                        if (character) {
                            character._fullCharacter = character;
                            openPreviewModal(character);
                            return;
                        }
                        await new Promise(r => setTimeout(r, 2000));
                        const retry = await fetchDatacatCharacter(charId);
                        if (retry) {
                            retry._fullCharacter = retry;
                            openPreviewModal(retry);
                            return;
                        }
                        showToast('Character extracted but not yet available. Try searching again.', 'warning');
                    } catch (e) {
                        showToast(`Extracted but failed to load: ${e.message}`, 'error');
                    }
                    if (importBtn) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                    updateInlineExtractionCTA('error', 'Extracted but failed to load');
                } else {
                    const errMsg = humanizeExtractionError(completedEntry.error || completedEntry.message);
                    showToast(errMsg, 'error');
                    if (importBtn) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                    updateInlineExtractionCTA('error', errMsg);
                }
                return;
            }

            if (status.inProgress) {
                const phase = status.inProgress.status || 'processing';
                const phaseNames = {
                    opening_page: 'Opening page',
                    preparing: 'Preparing',
                    initiating: 'Initiating',
                    pulling: 'Pulling data',
                    post_extract: 'Finalizing',
                    complete: 'Completing',
                };
                if (importBtn) importBtn.dataset.extractPhase = phaseNames[phase] || phase.replace(/_/g, ' ');
            } else if (status.queueLength > 0 && importBtn) {
                importBtn.dataset.extractPhase = `Queue (${status.queueLength})`;
            }
        } catch (e) {
            debugLog('[DatacatBrowse] Modal extraction poll error:', e);
        }
    }, 3000);
}

// ========================================
// FOLLOWING (local creator follow)
// ========================================

function loadFollowedCreators() {
    const saved = getSetting('datacatFollowedCreators');
    // Back-compat: pre-source entries default to 'datacat'.
    datacatFollowedCreators = Array.isArray(saved)
        ? saved.map(c => ({ ...c, source: c.source || 'datacat' }))
        : [];
}

function saveFollowedCreators() {
    setSetting('datacatFollowedCreators', datacatFollowedCreators);
}

function isCreatorFollowed(creatorId, source = 'datacat') {
    return datacatFollowedCreators.some(c => c.id === creatorId && (c.source || 'datacat') === source);
}

function followCreator(creatorId, creatorName, source = 'datacat') {
    if (isCreatorFollowed(creatorId, source)) return;
    datacatFollowedCreators.push({ id: creatorId, name: creatorName || creatorId, source });
    saveFollowedCreators();
    updateFollowButton(creatorId, source);
    showToast(`Followed ${creatorName || 'creator'}`, 'success');
}

function unfollowCreator(creatorId, source = 'datacat') {
    const idx = datacatFollowedCreators.findIndex(c => c.id === creatorId && (c.source || 'datacat') === source);
    if (idx === -1) return;
    const name = datacatFollowedCreators[idx].name;
    datacatFollowedCreators.splice(idx, 1);
    saveFollowedCreators();
    updateFollowButton(creatorId, source);
    showToast(`Unfollowed ${name || 'creator'}`, 'info');
}

function updateFollowButton(creatorId, source = datacatCreatorSource) {
    const btn = document.getElementById('datacatFollowCreatorBtn');
    if (!btn) return;

    if (datacatBrowseMode !== 'creator' || datacatCreatorId !== creatorId) return;
    if (datacatCreatorSource !== source) return;

    if (isCreatorFollowed(creatorId, source)) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        btn.title = 'Unfollow this creator';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-regular fa-heart"></i> <span>Follow</span>';
        btn.title = 'Follow this creator';
    }
    btn.style.display = '';
}

async function switchDatacatViewMode(mode) {
    datacatViewMode = mode;

    document.querySelectorAll('.datacat-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.datacatView === mode);
    });

    updateSourceFilterVisibility();

    const browseSection = document.getElementById('datacatBrowseSection');
    const followingSection = document.getElementById('datacatFollowingSection');

    const browseSortEl = document.getElementById('datacatSortSelect');
    const followingSortEl = document.getElementById('datacatFollowingSortSelect');
    const bsTarget = browseSortEl?._customSelect?.container || browseSortEl;
    const fsTarget = followingSortEl?._customSelect?.container || followingSortEl;

    if (mode === 'browse') {
        browseSection?.classList.remove('hidden');
        followingSection?.classList.add('hidden');

        if (bsTarget) bsTarget.classList.remove('hidden');
        if (fsTarget) fsTarget.classList.add('hidden');

        if (datacatCharacters.length === 0) {
            loadCharacters(false);
        }

    } else if (mode === 'following') {
        browseSection?.classList.add('hidden');
        followingSection?.classList.remove('hidden');

        if (bsTarget) bsTarget.classList.add('hidden');
        if (fsTarget) fsTarget.classList.remove('hidden');

        if (datacatFollowingCharacters.length === 0) {
            loadFollowingCharacters();
        } else {
            renderFollowing();
        }
    }
}

async function loadFollowingCharacters(forceRefresh = false) {
    if (datacatFollowingLoading) return;
    datacatFollowingLoading = true;

    const grid = document.getElementById('datacatFollowingGrid');

    if (forceRefresh) {
        datacatFollowingCharacters = [];
        datacatFollowingDisplayLimit = 60;
    }

    loadFollowedCreators();

    if (datacatFollowedCreators.length === 0) {
        renderFollowingEmpty('no_follows');
        datacatFollowingLoading = false;
        return;
    }

    if (grid) {
        renderLoadingState(grid, 'Loading timeline...', 'browse-loading');
    }

    try {
        const existingIds = new Set(datacatFollowingCharacters.map(c => getCharId(c)));
        const BATCH_SIZE = 3;

        for (let i = 0; i < datacatFollowedCreators.length; i += BATCH_SIZE) {
            const batch = datacatFollowedCreators.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (creator) => {
                try {
                    const allChars = [];
                    const source = creator.source || 'datacat';

                    if (source === 'saucepan') {
                        const handle = creator.name; // saucepan handle is stored as name
                        if (!handle) return [];
                        const data = await fetchSaucepanCompanionsOfUser(handle);
                        for (const c of (data?.characters || [])) {
                            allChars.push({
                                ...c,
                                _followedCreatorName: creator.name,
                                _followedCreatorId: creator.id,
                                _followedCreatorSource: 'saucepan',
                            });
                        }
                        return allChars;
                    }

                    let offset = 0;
                    const limit = 50;
                    while (true) {
                        const data = await fetchDatacatCreatorCharacters(creator.id, {
                            limit,
                            offset,
                            sortBy: 'newest'
                        });
                        const list = data?.list || [];
                        for (const c of list) {
                            allChars.push({
                                ...c,
                                _followedCreatorName: creator.name,
                                _followedCreatorId: creator.id,
                                _followedCreatorSource: 'datacat',
                            });
                        }
                        if (list.length < limit || allChars.length >= (data?.total || 0)) break;
                        offset += limit;
                    }
                    return allChars;
                } catch (e) {
                    debugLog('[DatacatFollowing] Error fetching from creator:', creator.name, e.message);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            for (const chars of results) {
                for (const c of chars) {
                    const id = getCharId(c);
                    if (id && !existingIds.has(id)) {
                        existingIds.add(id);
                        datacatFollowingCharacters.push(c);
                    }
                }
            }
        }

        debugLog('[DatacatFollowing] Total characters from followed creators:', datacatFollowingCharacters.length);

        if (datacatFollowingCharacters.length === 0) {
            renderFollowingEmpty('empty');
            datacatFollowingLoading = false;
            return;
        }

        renderFollowing();

    } catch (err) {
        console.error('[DatacatFollowing] Error loading timeline:', err);
        if (grid) {
            grid.innerHTML = `
                <div class="chub-timeline-empty">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Error Loading Timeline</h3>
                    <p>${escapeHtml(err.message)}</p>
                    <button class="action-btn primary" id="datacatFollowingRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            document.getElementById('datacatFollowingRetryBtn')?.addEventListener('click', () => loadFollowingCharacters(true));
        }
    } finally {
        datacatFollowingLoading = false;
    }
}

function renderFollowingEmpty(reason) {
    const grid = document.getElementById('datacatFollowingGrid');
    if (!grid) return;

    if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Creators</h3>
                <p>Browse characters and follow creators from their banner to see their characters here.</p>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Creators you follow haven't posted characters yet.</p>
            </div>
        `;
    }
}

function sortFollowingCharacters(characters) {
    const sorted = [...characters];
    switch (datacatFollowingSort) {
        case 'newest':
            return sorted.sort((a, b) => {
                const da = new Date(a.createdAt || a.created_at || 0);
                const db = new Date(b.createdAt || b.created_at || 0);
                return db - da;
            });
        case 'oldest':
            return sorted.sort((a, b) => {
                const da = new Date(a.createdAt || a.created_at || 0);
                const db = new Date(b.createdAt || b.created_at || 0);
                return da - db;
            });
        case 'name_asc':
            return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        case 'name_desc':
            return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        case 'chat_count':
            return sorted.sort((a, b) => getChatCount(b) - getChatCount(a));
        default:
            return sorted;
    }
}

function _handleFollowingCardClick(e) {
    const authorLink = e.target.closest('.browse-card-creator-link');
    if (authorLink) {
        e.stopPropagation();
        const creatorId = authorLink.dataset.creatorId;
        if (creatorId) {
            switchDatacatViewMode('browse');
            const card = authorLink.closest('.browse-card');
            const charId = card?.dataset?.datacatId;
            const hit = charId ? datacatFollowingCharacters.find(c => String(getCharId(c)) === charId) : null;
            if (hit && getSourceKind(hit) === 'saucepan') {
                browseCreator(creatorId, { source: 'saucepan', handle: getCreatorName(hit), name: getCreatorName(hit) });
            } else {
                browseCreator(creatorId);
            }
        }
        return;
    }
    const card = e.target.closest('.browse-card');
    if (!card) return;
    const charId = card.dataset.datacatId;
    if (!charId) return;
    const hit = datacatFollowingCharacters.find(c => String(getCharId(c)) === charId);
    if (hit) openPreviewModal(hit);
}

function renderFollowing(append = false) {
    const grid = document.getElementById('datacatFollowingGrid');
    if (!grid) return;

    let source = datacatFollowingCharacters;

    let filtered = datacatNsfwEnabled
        ? source
        : source.filter(c => !isNsfw(c));

    if (datacatFilterHideOwned) {
        filtered = filtered.filter(c => !isCharInLocalLibrary(c));
    }
    if (datacatFilterHidePossible) {
        filtered = filtered.filter(c => !isCharPossibleMatchObj(c));
    }
    if (datacatFilterHideJanitor) {
        filtered = filtered.filter(c => getSourceKind(c) !== 'janitor');
    }
    if (datacatFilterHideSaucepan) {
        filtered = filtered.filter(c => getSourceKind(c) !== 'saucepan');
    }

    const dcPersistentExclude = getProviderExcludeTags('datacat');
    if (dcPersistentExclude.length > 0) {
        const lowerExclude = dcPersistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = resolveTagNames(c.tags || []).map(n => n.toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }

    const sorted = sortFollowingCharacters(filtered);
    datacatFollowingFiltered = sorted;

    if (sorted.length === 0 && datacatFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current NSFW filter setting.</p>
            </div>
        `;
        datacatBrowseView.updateLoadMoreVisibility('datacatFollowingLoadMore', false, false);
        return;
    }

    if (append) {
        const existingCount = grid.querySelectorAll('.browse-card').length;
        const newSlice = sorted.slice(existingCount, datacatFollowingDisplayLimit);
        if (newSlice.length > 0) {
            grid.insertAdjacentHTML('beforeend', newSlice.map(c => createDatacatCard(c)).join(''));
            datacatBrowseView.observeImages(grid);
        }
    } else {
        const page = sorted.slice(0, datacatFollowingDisplayLimit);
        grid.innerHTML = page.map(c => createDatacatCard(c)).join('');
        datacatBrowseView.observeImages(grid);
    }

    const hasMore = datacatFollowingDisplayLimit < sorted.length;
    datacatBrowseView.updateLoadMoreVisibility('datacatFollowingLoadMore', hasMore, sorted.length > 0);
}

// ========================================
// PREVIEW MODAL
// ========================================

let datacatDetailFetchToken = 0;
let datacatDetailFetchPromise = null;
let datacatLastCreatorNotes = '';

function openPreviewModal(hit) {
    datacatSelectedChar = hit;

    // Ensure modal DOM exists and event listeners are wired even when called
    // from outside the Online tab (e.g. "Open on DataCat" from the link modal
    // before user has visited DataCat browse this session).
    view.injectModals();
    ensureModalEventsAttached();

    const modal = document.getElementById('datacatCharModal');
    if (!modal) return;
    window.resetBrowseSectionCollapseState?.(modal);

    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';
    const avatarUrl = resolveDatacatAvatarUrl(hit) || '/img/ai4.png';
    const tags = resolveTagNames(hit.tags || []);
    const creatorName = getCreatorName(hit) || 'Unknown';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', creatorName);

    const chatCount = getChatCount(hit);
    const msgCount = getMsgCount(hit);
    const totalTokens = getTotalTokens(hit);
    const createdDate = getCreatedDate(hit) || 'Unknown';

    // Header
    const avatarImg = document.getElementById('datacatCharAvatar');
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    document.getElementById('datacatCharName').textContent = name;
    document.getElementById('datacatCharCreator').textContent = creatorName;
    const openBtn = document.getElementById('datacatOpenInBrowserBtn');
    if (openBtn) {
        if (getSourceKind(hit) === 'saucepan') {
            openBtn.href = `https://saucepan.ai/companion/${charId}`;
            openBtn.title = 'Open on Saucepan';
        } else {
            openBtn.href = `${DATACAT_API_BASE}/characters/${charId}`;
            openBtn.title = 'Open on DataCat';
        }
    }

    // Stats (adapt to available data)
    const chatsEl = document.getElementById('datacatCharChats');
    const msgsEl = document.getElementById('datacatCharMessages');
    const tokensEl = document.getElementById('datacatCharTokens');
    const dateEl = document.getElementById('datacatCharDate');

    if (chatsEl) chatsEl.textContent = formatNumber(chatCount);
    if (msgsEl) msgsEl.textContent = formatNumber(msgCount);
    if (tokensEl) tokensEl.textContent = formatNumber(totalTokens);
    if (dateEl) dateEl.textContent = createdDate;

    // Tags
    const tagsEl = document.getElementById('datacatCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');

    // Creator's Notes - show immediately if description is available (all sources include it)
    const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
    const immediateDesc = (hit.description || '').trim();
    datacatLastCreatorNotes = immediateDesc;
    if (creatorNotesSection) {
        if (immediateDesc) {
            creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) renderCreatorNotesSecure(immediateDesc, name, creatorNotesEl);
        } else {
            creatorNotesSection.style.display = 'none';
            if (creatorNotesEl) creatorNotesEl.innerHTML = '';
        }
    }

    // Definition sections: all hidden, single loading indicator shown
    const defLoading = document.getElementById('datacatCharDefinitionLoading');
    if (defLoading) defLoading.style.display = 'block';
    const descSection = document.getElementById('datacatCharDescriptionSection');
    const scenarioSection = document.getElementById('datacatCharScenarioSection');
    const mesExampleSection = document.getElementById('datacatCharMesExampleSection');
    const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
    descSection.style.display = 'none';
    scenarioSection.style.display = 'none';
    if (mesExampleSection) mesExampleSection.style.display = 'none';
    firstMsgSection.style.display = 'none';

    // Hide alt greetings + greetings stat until download data arrives
    const altGreetingsSection = document.getElementById('datacatCharAltGreetingsSection');
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    const greetingsStat = document.getElementById('datacatCharGreetingsStat');
    if (greetingsStat) greetingsStat.style.display = 'none';
    window.currentBrowseAltGreetings = [];

    // Hide gallery until detail fetch reveals saucepan portraits
    const gallerySection = document.getElementById('datacatCharGallerySection');
    if (gallerySection) gallerySection.style.display = 'none';
    const galleryGrid = document.getElementById('datacatCharGalleryGrid');
    if (galleryGrid) galleryGrid.innerHTML = '';
    const galleryLabel = document.getElementById('datacatCharGalleryLabel');
    if (galleryLabel) galleryLabel.textContent = '';

    // Import button - neutral loading state until definition fetch resolves
    const importBtn = document.getElementById('datacatImportBtn');
    delete importBtn.dataset.extractId;
    delete importBtn.dataset.extractPhase;
    if (inLibrary) {
        importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary', 'warning');
        importBtn.disabled = false;
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...';
        importBtn.classList.remove('primary', 'secondary', 'warning');
        importBtn.classList.add('secondary');
        importBtn.disabled = true;
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Fetch full details in background
    const fetchToken = ++datacatDetailFetchToken;
    datacatDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';
    const isSaucepanHit = getSourceKind(hit) === 'saucepan';

    // For Saucepan hits, fetch companion detail in parallel to learn whether
    // the definition is publicly open. The search/listing endpoint omits
    // `open_definition`, so this is the only way to surface a lock warning.
    const saucepanDetailPromise = isSaucepanHit
        ? fetchSaucepanCompanion(charId).catch(() => null)
        : Promise.resolve(null);

    function renderLockedDefBanner() {
        return `
            <div class="datacat-modal-locked-banner">
                <i class="fa-solid fa-lock"></i>
                <div>
                    <strong>Locked Definition</strong>
                    <p>This Saucepan companion's definition is not publicly available. Extraction may not retrieve the full character body.</p>
                </div>
            </div>
        `;
    }

    function showExtractionCTA(message, { locked = false } = {}) {
        const source = isSaucepanHit ? 'saucepan' : 'janitor';
        const cfg = EXTRACT_SOURCES[source];
        const descSection = document.getElementById('datacatCharDescriptionSection');
        const descEl = document.getElementById('datacatCharDescription');
        if (descSection) descSection.style.display = 'block';
        if (descEl) descEl.innerHTML = `
            ${locked ? renderLockedDefBanner() : ''}
            <div class="datacat-modal-extract-cta">
                <div class="datacat-modal-extract-icon-wrap">
                    <i class="fa-solid fa-wand-magic-sparkles datacat-modal-extract-icon"></i>
                </div>
                <p class="datacat-modal-extract-message">${escapeHtml(message)}</p>
                <p class="datacat-modal-extract-hint">Use DataCat's extraction service to retrieve this character's full definition from ${cfg.label}.</p>
                <button class="action-btn primary datacat-modal-extract-btn" data-extract-id="${escapeHtml(String(charId))}" data-extract-source="${source}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Extract Character
                </button>
            </div>
        `;
        const inlineBtn = descEl?.querySelector('.datacat-modal-extract-btn');
        if (inlineBtn) inlineBtn.addEventListener('click', () => startModalExtraction(charId, source));
        const importBtn = document.getElementById('datacatImportBtn');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
            importBtn.classList.remove('primary', 'secondary', 'warning');
            importBtn.classList.add('primary');
            importBtn.dataset.extractId = charId;
            importBtn.dataset.extractSource = source;
        }
    }

    // Start download fetch early (runs in parallel with character fetch)
    const downloadPromise = fetchDatacatDownload(charId).catch(() => null);

    try {
        const character = hit._fullCharacter || await fetchDatacatCharacter(charId);

        if (token !== datacatDetailFetchToken) return;

        // Hide the loading indicator
        const defLoading = document.getElementById('datacatCharDefinitionLoading');
        if (defLoading) defLoading.style.display = 'none';

        if (!character) {
            const saucepanDetail = await saucepanDetailPromise;
            const lockedDef = isSaucepanHit && saucepanDetail && saucepanDetail.open_definition === false;
            showExtractionCTA(isSaucepanHit
                ? 'This Saucepan character has not been extracted to DataCat yet.'
                : 'Character definition is hidden or unavailable.',
                { locked: lockedDef });
            return;
        }

        // Store full data on the selected char for import
        if (datacatSelectedChar && getCharId(datacatSelectedChar) === charId) {
            datacatSelectedChar._fullCharacter = character;
        }

        // Update creator name if available (MeiliSearch hits lack it)
        const charCreatorName = character.creator_name || character.creatorName || '';
        if (charCreatorName) {
            const creatorEl = document.getElementById('datacatCharCreator');
            if (creatorEl) creatorEl.textContent = charCreatorName;
            if (datacatSelectedChar && getCharId(datacatSelectedChar) === charId) {
                datacatSelectedChar.creator_name = charCreatorName;
            }
        }

        // Saucepan characters with hidden definitions surface their repaired
        // body via `content_variants[primary].content` on the character row.
        // When present, those fields are authoritative. For open-definition
        // Saucepan rows, DataCat populates `character.description` with the
        // body and exposes a correctly-mapped V2 in `chara_card_v2_json.data`.
        // JanitorAI rows keep the body in `character.personality`.
        const recoveredVariant = pickRecoveryVariant(character);
        const charIsSaucepan = getSourceKind(character) === 'saucepan' || getSourceKind(hit) === 'saucepan';
        const v2Data = character?.chara_card_v2_json?.data || null;
        const saucepanBody = charIsSaucepan
            ? (recoveredVariant?.description || v2Data?.description || character.description || '')
            : '';
        const personality = charIsSaucepan
            ? saucepanBody
            : (recoveredVariant?.description || recoveredVariant?.personality || character.personality || '');
        const scenario = recoveredVariant?.scenario || character.scenario || v2Data?.scenario || '';
        const firstMessage = recoveredVariant?.first_message || character.first_message || v2Data?.first_mes || '';
        const canPaintBody = !!recoveredVariant || !charIsSaucepan || !!saucepanBody;

        // Resolve Saucepan lock state if we have detail data. When the
        // character is on DataCat but the definition is locked AND we have
        // no recovered variant, the body sections are empty: surface a
        // banner so the user understands why.
        const saucepanDetail = await saucepanDetailPromise;
        const saucepanLocked = isSaucepanHit && saucepanDetail && saucepanDetail.open_definition === false;
        const showLockedBanner = saucepanLocked && !recoveredVariant;

        const descSection = document.getElementById('datacatCharDescriptionSection');
        if (descSection) {
            const descEl = document.getElementById('datacatCharDescription');
            if (personality && canPaintBody) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = `${showLockedBanner ? renderLockedDefBanner() : ''}${formatRichText(personality, name, false)}`;
            } else if (showLockedBanner) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = renderLockedDefBanner();
            } else {
                descSection.style.display = 'none';
                if (descEl) descEl.innerHTML = '';
            }
        }

        const scenarioSection = document.getElementById('datacatCharScenarioSection');
        const scenarioEl = document.getElementById('datacatCharScenario');
        if (scenarioSection && scenario && canPaintBody) {
            scenarioSection.style.display = 'block';
            if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
        }

        const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
        const firstMsgEl = document.getElementById('datacatCharFirstMsg');
        if (firstMsgSection && firstMessage && canPaintBody) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) {
                firstMsgEl.innerHTML = formatRichText(firstMessage, name, false);
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        }

        // Silently update stats values if full character has better data
        const chatsEl = document.getElementById('datacatCharChats');
        const msgsEl = document.getElementById('datacatCharMessages');
        const tokensEl = document.getElementById('datacatCharTokens');
        const fullChatCount = getChatCount(character);
        const fullMsgCount = getMsgCount(character);
        const fullTokens = getTotalTokens(character);
        if (chatsEl && fullChatCount) chatsEl.textContent = formatNumber(fullChatCount);
        if (msgsEl && fullMsgCount) msgsEl.textContent = formatNumber(fullMsgCount);
        if (tokensEl && fullTokens) tokensEl.textContent = formatNumber(fullTokens);

        // Refresh creator notes only if content changed (avoids iframe rebuild flash).
        // Source field differs by row kind: JanitorAI puts the blurb in
        // `character.description`; Saucepan puts the body there and exposes
        // the actual blurb via `companion_snapshot.full_description` (with
        // formatting markers) or the V2 mapping in `chara_card_v2_json.data`.
        const fullCreatorNotes = (charIsSaucepan
            ? (character?.companion_snapshot?.full_description
                || character?.intercepted_chat_data?.companion_snapshot?.full_description
                || v2Data?.creator_notes
                || '')
            : (character.description || '')).trim();
        const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
        if (fullCreatorNotes && fullCreatorNotes !== datacatLastCreatorNotes) {
            datacatLastCreatorNotes = fullCreatorNotes;
            if (creatorNotesSection) creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) renderCreatorNotesSecure(fullCreatorNotes, name, creatorNotesEl);
        } else if (!fullCreatorNotes && !datacatLastCreatorNotes) {
            if (creatorNotesSection) creatorNotesSection.style.display = 'none';
            if (creatorNotesEl) creatorNotesEl.innerHTML = '';
        }

        // Update tags only if they differ from what's already rendered
        if (character.tags?.length) {
            const tagsEl = document.getElementById('datacatCharTags');
            if (tagsEl) {
                const fullTags = resolveTagNames(character.tags);
                const newHtml = fullTags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
                if (tagsEl.innerHTML !== newHtml) tagsEl.innerHTML = newHtml;
            }
        }

        // Saucepan portraits gallery
        const portraits = character?.companion_snapshot?.portraits;
        if (Array.isArray(portraits) && portraits.length > 0) {
            const gallerySection = document.getElementById('datacatCharGallerySection');
            const galleryGrid = document.getElementById('datacatCharGalleryGrid');
            const galleryLabel = document.getElementById('datacatCharGalleryLabel');
            if (gallerySection && galleryGrid) {
                gallerySection.style.display = 'block';
                if (galleryLabel) galleryLabel.textContent = `(${portraits.length})`;
                galleryGrid.innerHTML = portraits.map(p => {
                    const url = p?.image?.highres_url;
                    if (!url) return '';
                    const title = p?.description || p?.name || 'Gallery image';
                    return `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" title="${escapeHtml(title)}" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`;
                }).join('');
            }
        }

        // Enable import button now that full character data is confirmed
        const importBtn = document.getElementById('datacatImportBtn');
        if (importBtn && !importBtn.dataset.extractId) {
            const inLibrary = isCharInLocalLibrary(hit);
            if (inLibrary) {
                importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
                importBtn.classList.add('secondary');
                importBtn.classList.remove('primary', 'warning');
            } else {
                const creatorName = character.creator_name || character.creatorName || hit.creator_name || '';
                const possibleMatch = view.isCharPossibleMatch(name, creatorName);
                if (possibleMatch) {
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
                    importBtn.classList.add('warning');
                    importBtn.classList.remove('primary', 'secondary');
                } else {
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                    importBtn.classList.add('primary');
                    importBtn.classList.remove('secondary', 'warning');
                }
            }
            importBtn.disabled = false;
        }

        // Fetch download data for alternate greetings and example messages
        downloadPromise.then(downloadData => {
            if (token !== datacatDetailFetchToken) return;
            const d = downloadData?.data;

            // /download is authoritative for the body fields when available.
            // The character endpoint sometimes carries a short synopsis that
            // DataCat scraped from JanitorAI's listing page in the
            // `personality` slot - using that as the Description gives the
            // preview content that doesn't match what gets imported. Import
            // already prefers /download via buildV2FromDownload, so this
            // mirrors that behavior.
            //
            // Exception: Saucepan with a recovery variant. The recovered
            // variant is the only authoritative source for repaired cards;
            // /download returns empty fields in that case.
            const useRecoveryAsAuthority = charIsSaucepan && !!recoveredVariant;
            const needSaucepanFallback = charIsSaucepan && !recoveredVariant;
            if (d) {
                const dlDesc = d.personality || d.description || '';
                const shouldOverwriteDesc = !useRecoveryAsAuthority
                    && dlDesc
                    && (needSaucepanFallback || !personality || dlDesc !== personality);
                if (shouldOverwriteDesc) {
                    const ds = document.getElementById('datacatCharDescriptionSection');
                    const de = document.getElementById('datacatCharDescription');
                    if (ds) ds.style.display = 'block';
                    if (de) de.innerHTML = `${showLockedBanner ? renderLockedDefBanner() : ''}${formatRichText(dlDesc, name, false)}`;
                }
                if (d.scenario && !useRecoveryAsAuthority && (needSaucepanFallback || !scenario || d.scenario !== scenario)) {
                    const ss = document.getElementById('datacatCharScenarioSection');
                    const se = document.getElementById('datacatCharScenario');
                    if (ss) ss.style.display = 'block';
                    if (se) se.innerHTML = formatRichText(d.scenario, name, false);
                }
                if (d.first_mes && !useRecoveryAsAuthority && (needSaucepanFallback || !firstMessage || d.first_mes !== firstMessage)) {
                    const fs = document.getElementById('datacatCharFirstMsgSection');
                    const fe = document.getElementById('datacatCharFirstMsg');
                    if (fs) fs.style.display = 'block';
                    if (fe) {
                        fe.innerHTML = formatRichText(d.first_mes, name, false);
                        fe.dataset.fullContent = d.first_mes;
                    }
                }
            }

            // Example messages - only present in the download payload
            const mesExample = d?.mes_example || '';
            const mesSection = document.getElementById('datacatCharMesExampleSection');
            const mesEl = document.getElementById('datacatCharMesExample');
            if (mesExample && mesSection && mesEl) {
                mesSection.style.display = 'block';
                mesEl.innerHTML = formatRichText(mesExample, name, false);
                mesEl.dataset.fullContent = mesExample;
            }

            renderAltGreetings(d?.alternate_greetings, name);
        });
    } catch (err) {
        debugLog('[DatacatBrowse] Detail fetch error:', err);
        if (token === datacatDetailFetchToken) {
            const defLoading = document.getElementById('datacatCharDefinitionLoading');
            if (defLoading) defLoading.style.display = 'none';
            showExtractionCTA('Could not load character definition.');
        }
    }
}

function renderAltGreetings(greetings, charName) {
    const section = document.getElementById('datacatCharAltGreetingsSection');
    const listEl = document.getElementById('datacatCharAltGreetings');
    const countEl = document.getElementById('datacatCharAltGreetingsCount');

    if (!section || !listEl) return;

    const greetingsStat = document.getElementById('datacatCharGreetingsStat');
    const greetingsCountEl = document.getElementById('datacatCharGreetingsCount');

    if (!Array.isArray(greetings) || greetings.length === 0) {
        section.style.display = 'none';
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (greetingsStat) greetingsStat.style.display = 'none';
        window.currentBrowseAltGreetings = [];
        return;
    }

    if (greetingsStat) greetingsStat.style.display = 'flex';
    if (greetingsCountEl) greetingsCountEl.textContent = String(greetings.length + 1);

    const buildPreview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.style.display = 'block';
    listEl.innerHTML = greetings.map((greeting, idx) => {
        const label = `#${idx + 1}`;
        const preview = escapeHtml(buildPreview(greeting));
        return `
            <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                <summary>
                    <span class="browse-alt-greeting-index">${label}</span>
                    <span class="browse-alt-greeting-preview">${preview}</span>
                    <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="browse-alt-greeting-body"></div>
            </details>
        `;
    }).join('');

    listEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                if (greetings[idx] != null) {
                    body.innerHTML = formatRichText(greetings[idx], charName, true);
                }
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });

    if (countEl) countEl.textContent = `(${greetings.length})`;
    window.currentBrowseAltGreetings = greetings;
}

function cleanupDatacatCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const sectionIds = [
        'datacatCharDescription',
        'datacatCharScenario',
        'datacatCharFirstMsg',
        'datacatCharAltGreetings',
        'datacatCharTags',
        'datacatCharGalleryGrid',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('datacatCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    datacatDetailFetchToken++;
    datacatDetailFetchPromise = null;
    cleanupDatacatCharModal();
    clearExtractionState();
    const modal = document.getElementById('datacatCharModal');
    if (modal) modal.classList.add('hidden');
    datacatSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    const charId = getCharId(charData);
    if (!charId) return;

    const importBtn = document.getElementById('datacatImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('datacat');
        if (!provider?.importCharacter) throw new Error('DataCat provider not available');

        if (datacatDetailFetchPromise) {
            try { await datacatDetailFetchPromise; } catch { /* ignore */ }
        }

        const character = charData._fullCharacter;
        if (!character) {
            showToast('Character definition not available. Try extracting first.', 'warning');
            if (importBtn) {
                importBtn.disabled = false;
                importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
            }
            return;
        }
        const charName = character.chat_name || character.name || charData.name || '';
        const charCreator = character.creator_name || charData.creatorName || charData.creator_name || '';

        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: String(charId),
            description: character.personality || character.description || '',
            first_mes: character.first_message || '',
            scenario: character.scenario || ''
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = resolveDatacatAvatarUrl(character) || resolveDatacatAvatarUrl(charData) || '/img/ai4.png';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: String(charId),
                avatarUrl
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                if (importBtn) {
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                }
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (!deleteSuccess) {
                    console.warn('[DatacatBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(charId, character, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        closePreviewModal();
        await new Promise(r => requestAnimationFrame(r));

        showToast(`Imported "${result.characterName}"`, 'success');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        if ((mediaUrls.length > 0 || galleryPageUrls.length > 0) && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                mediaCharacters: [{
                    characterName: result.characterName,
                    name: result.characterName,
                    fileName: result.fileName,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                    mediaUrls,
                    galleryPageUrls,
                    cardData: result.cardData
                }]
            });
        }

        const added = await fetchAndAddCharacter(result.fileName);
        if (!added) await fetchCharacters(true);
        view.buildLocalLibraryLookup();
        markCardAsImported(charId);

    } catch (err) {
        console.error('[DatacatBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(charId) {
    for (const gridId of ['datacatGrid', 'datacatFollowingGrid']) {
        const grid = document.getElementById(gridId);
        if (!grid) continue;
        const card = grid.querySelector(`[data-datacat-id="${charId}"]`);
        if (!card) continue;
        card.classList.add('in-library');
        card.classList.remove('possible-library');
        // Use :not(-tl) so we don't grab the top-left source badge container,
        // which shares the .browse-feature-badges base class.
        let badgesEl = card.querySelector('.browse-feature-badges:not(.browse-feature-badges-tl)');
        if (!badgesEl) {
            const imgWrap = card.querySelector('.browse-card-image');
            if (imgWrap) {
                imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                badgesEl = imgWrap.querySelector('.browse-feature-badges:not(.browse-feature-badges-tl)');
            }
        }
        if (badgesEl) {
            badgesEl.querySelector('.possible-library')?.remove();
            if (!badgesEl.querySelector('.in-library')) {
                badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
            }
        }
    }
}

// ========================================
// NSFW TOGGLE
// ========================================

function updateNsfwToggle() {
    const btn = document.getElementById('datacatNsfwToggle');
    if (!btn) return;

    if (datacatNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled. Click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only. Click to include NSFW';
    }
}

function updateDatacatFiltersButtonState() {
    const btn = document.getElementById('datacatFiltersBtn');
    if (!btn) return;
    const count = [datacatFilterHideOwned, datacatFilterHidePossible, datacatFilterHideJanitor, datacatFilterHideSaucepan].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    btn.innerHTML = count > 0
        ? `<i class="fa-solid fa-sliders"></i> Features (${count})`
        : '<i class="fa-solid fa-sliders"></i> <span>Features</span>';
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initDatacatView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('datacatSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    const followingSortEl = document.getElementById('datacatFollowingSortSelect');
    if (followingSortEl) CoreAPI.initCustomSelect?.(followingSortEl);

    const creatorSortEl = document.getElementById('datacatCreatorSortSelect');
    if (creatorSortEl) {
        creatorSortEl.value = datacatCreatorSortMode;
        CoreAPI.initCustomSelect?.(creatorSortEl);
    }

    // Grid card click --> open preview (delegation)
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const creatorId = authorLink.dataset.creatorId;
                if (creatorId) {
                    const card = authorLink.closest('.browse-card');
                    const charId = card?.dataset?.datacatId;
                    const hit = charId ? datacatCharacters.find(c => String(getCharId(c)) === charId) : null;
                    if (hit && getSourceKind(hit) === 'saucepan') {
                        browseCreator(creatorId, { source: 'saucepan', handle: getCreatorName(hit), name: getCreatorName(hit) });
                    } else {
                        browseCreator(creatorId);
                    }
                }
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.datacatId;
            if (!charId) return;
            const hit = datacatCharacters.find(c => String(getCharId(c)) === charId);
            if (!hit) return;
            // Saucepan and DataCat hits both go through the preview modal.
            // For saucepan items not yet on DataCat, fetchAndPopulateDetails
            // will surface the inline extraction CTA when the lookup fails.
            openPreviewModal(hit);
        });
    }

    // Search
    on('datacatSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('datacatSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('datacatClearSearchBtn');
        const val = (e.target.value || '').trim();
        if (clearBtn) clearBtn.classList.toggle('hidden', !val);
    });
    on('datacatSearchBtn', 'click', () => doSearch());

    // Creator search handlers
    on('datacatCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performDatacatCreatorSearch();
    });
    on('datacatCreatorSearchBtn', 'click', () => performDatacatCreatorSearch());
    on('datacatClearSearchBtn', 'click', () => {
        const input = document.getElementById('datacatSearchInput');
        const clearBtn = document.getElementById('datacatClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        if (datacatBrowseMode === 'creator') clearCreatorFilter();
        if (isHampterSortMode(datacatSortMode) && hampterSearchQuery) {
            hampterSearchQuery = '';
            hampterCurrentPage = 1;
            loadCharacters(false);
        }
        if (isJannySortMode(datacatSortMode) && meiliSearchQuery) {
            meiliSearchQuery = '';
            meiliCurrentPage = 1;
            datacatCurrentOffset = 0;
            loadCharacters(false);
        }
        if (isSaucepanSortMode(datacatSortMode) && saucepanSearchQuery) {
            saucepanSearchQuery = '';
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
    });

    // Load More
    on('datacatLoadMoreBtn', 'click', () => {
        if (datacatBrowseMode === 'creator') {
            datacatCurrentOffset += PAGE_SIZE;
        } else if (isHampterSortMode(datacatSortMode)) {
            hampterCurrentPage++;
        } else if (isJannySortMode(datacatSortMode)) {
            meiliCurrentPage++;
        } else if (isSaucepanSortMode(datacatSortMode)) {
            saucepanCurrentPage++;
        } else {
            const loadParsed = parseSortMode(datacatSortMode);
            if (loadParsed) {
                if (loadParsed.window === '24h') datacatFreshLimit24 += FRESH_PAGE_INCREMENT;
                else datacatFreshLimitWeek += FRESH_PAGE_INCREMENT;
            } else {
                datacatCurrentOffset += PAGE_SIZE;
            }
        }
        loadCharacters(true);
    });

    on('datacatFollowingLoadMoreBtn', 'click', () => {
        datacatFollowingDisplayLimit += 60;
        renderFollowing(true);
    });

    // NSFW toggle
    on('datacatNsfwToggle', 'click', () => {
        datacatNsfwEnabled = !datacatNsfwEnabled;
        updateNsfwToggle();
        if (datacatViewMode === 'following') {
            renderFollowing();
        } else {
            renderGrid(datacatCharacters, false);
        }
    });
    updateNsfwToggle();

    // Open-Definition toggle (Saucepan)
    on('datacatOpenDefToggle', 'click', () => {
        saucepanOpenDefinitionOnly = !saucepanOpenDefinitionOnly;
        updateOpenDefToggle();
        if (isSaucepanSortMode(datacatSortMode)) {
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
    });
    updateOpenDefToggle();
    updateOpenDefToggleVisibility();
    updateSourceFilterVisibility();

    // Filters dropdown toggle
    on('datacatFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        document.getElementById('datacatTagsDropdown')?.classList.add('hidden');
        document.getElementById('datacatFiltersDropdown')?.classList.toggle('hidden');
    });

    // Filter checkboxes
    const dcFilterCheckboxes = [
        { id: 'datacatFilterHideOwned', setter: (v) => datacatFilterHideOwned = v, getter: () => datacatFilterHideOwned },
        { id: 'datacatFilterHidePossible', setter: (v) => datacatFilterHidePossible = v, getter: () => datacatFilterHidePossible },
        { id: 'datacatFilterHideJanitor', setter: (v) => datacatFilterHideJanitor = v, getter: () => datacatFilterHideJanitor },
        { id: 'datacatFilterHideSaucepan', setter: (v) => datacatFilterHideSaucepan = v, getter: () => datacatFilterHideSaucepan },
    ];
    dcFilterCheckboxes.forEach(({ id, getter }) => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = getter();
    });
    updateDatacatFiltersButtonState();

    dcFilterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            setter(e.target.checked);
            updateDatacatFiltersButtonState();
            if (datacatViewMode === 'following') {
                renderFollowing();
            } else {
                renderGrid(datacatCharacters, false);
            }
        });
    });

    // Sort mode
    on('datacatSortSelect', 'change', () => {
        const el = document.getElementById('datacatSortSelect');
        if (!el) return;
        if (datacatBrowseMode === 'creator') {
            datacatCreatorSortMode = el.value;
            const bannerSort = document.getElementById('datacatCreatorSortSelect');
            if (bannerSort) bannerSort.value = el.value;
        } else {
            datacatSortMode = el.value;
            datacatFreshLimit24 = 80;
            datacatFreshLimitWeek = 20;
            meiliCurrentPage = 1;
            hampterCurrentPage = 1;
            hampterSearchQuery = '';
            saucepanCurrentPage = 1;
            saucepanSearchQuery = '';
        }
        datacatCurrentOffset = 0;
        updateSearchPlaceholder();
        updateTagsVisibility();
        updateTagsButton();
        // Refresh open tag dropdown so it shows the right tag set for the new mode
        const tagDropdown = document.getElementById('datacatTagsDropdown');
        if (tagDropdown && !tagDropdown.classList.contains('hidden')) {
            if (isJannyTagMode()) renderJannyTagsList();
            else if (isSaucepanTagMode()) renderSaucepanTagsList();
            else loadFacetedTags();
        }
        updateOpenDefToggleVisibility();
        updateSourceFilterVisibility();
        loadCharacters(false);
    });

    // Creator banner sort
    on('datacatCreatorSortSelect', 'change', () => {
        const el = document.getElementById('datacatCreatorSortSelect');
        if (!el) return;
        datacatCreatorSortMode = el.value;
        const mainSort = document.getElementById('datacatSortSelect');
        if (mainSort) mainSort.value = el.value;
        datacatCurrentOffset = 0;
        loadCharacters(false);
    });

    // Refresh
    on('datacatRefreshBtn', 'click', () => {
        if (datacatViewMode === 'following') {
            datacatFollowingCharacters = [];
            datacatFollowingDisplayLimit = 60;
            loadFollowingCharacters(true);
        } else {
            datacatCurrentOffset = 0;
            datacatFreshLimit24 = 80;
            datacatFreshLimitWeek = 20;
            hampterCurrentPage = 1;
            loadCharacters(false);
        }
    });

    // Clear creator filter
    on('datacatClearCreatorBtn', 'click', () => clearCreatorFilter());
    // Tags dropdown toggle
    on('datacatTagsBtn', 'click', () => {
        document.getElementById('datacatFiltersDropdown')?.classList.add('hidden');
        const dropdown = document.getElementById('datacatTagsDropdown');
        if (!dropdown) return;
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('datacatTagsSearchInput');
            if (searchInput) searchInput.value = '';
            if (isJannyTagMode()) {
                renderJannyTagsList();
            } else if (isSaucepanTagMode()) {
                renderSaucepanTagsList();
            } else {
                loadFacetedTags();
            }
            // Focus search after a tick (avoid immediately blurring on open)
            setTimeout(() => searchInput?.focus(), 50);
        }
    });
    on('datacatTagsClearBtn', 'click', () => {
        const searchInput = document.getElementById('datacatTagsSearchInput');
        if (searchInput) searchInput.value = '';
        if (isJannyTagMode()) {
            jannyActiveTagIds.clear();
            renderJannyTagsList();
        } else if (isSaucepanTagMode()) {
            saucepanActiveTags.clear();
            saucepanExcludedTags.clear();
            renderSaucepanTagsList();
            saucepanCurrentPage = 1;
        } else {
            datacatActiveTagIds.clear();
            renderTagsList();
            refreshTagCounts();
        }
        updateTagsButton();
        datacatCurrentOffset = 0;
        loadCharacters(false);
    });

    // Tags search input — filter the current rendered list
    on('datacatTagsSearchInput', 'input', () => {
        const searchInput = document.getElementById('datacatTagsSearchInput');
        const filter = searchInput?.value || '';
        if (isJannyTagMode()) {
            renderJannyTagsList(filter);
        } else if (isSaucepanTagMode()) {
            renderSaucepanTagsList(filter);
        } else {
            renderTagsList(filter);
        }
    });

    // Dropdown dismiss (click outside)
    datacatBrowseView._registerDropdownDismiss([
        { dropdownId: 'datacatTagsDropdown', buttonId: 'datacatTagsBtn' },
        { dropdownId: 'datacatFiltersDropdown', buttonId: 'datacatFiltersBtn' },
    ]);

    // View mode toggle (Browse / Following)
    document.querySelectorAll('.datacat-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.datacatView;
            if (mode && mode !== datacatViewMode) {
                switchDatacatViewMode(mode);
                _returnToFollowing = false;
            }
        });
    });

    // Follow button in creator banner
    on('datacatFollowCreatorBtn', 'click', () => {
        if (!datacatCreatorId) return;
        const src = datacatCreatorSource;
        if (isCreatorFollowed(datacatCreatorId, src)) {
            unfollowCreator(datacatCreatorId, src);
        } else {
            followCreator(datacatCreatorId, datacatCreatorName, src);
        }
    });

    // Following sort
    on('datacatFollowingSortSelect', 'change', () => {
        const el = document.getElementById('datacatFollowingSortSelect');
        if (!el) return;
        datacatFollowingSort = el.value;
        datacatFollowingDisplayLimit = 60;
        renderFollowing();
    });

    // Following grid card click --> open preview (delegation)
    const followingGrid = document.getElementById('datacatFollowingGrid');
    if (followingGrid) {
        followingGrid.addEventListener('click', _handleFollowingCardClick);
    }


    // ---- Preview modal events (only attach once) ----
    ensureModalEventsAttached();
}

function ensureModalEventsAttached() {
    if (modalEventsAttached) return;
    if (!document.getElementById('datacatCharModal')) return;
    modalEventsAttached = true;

    if (!window.matchMedia('(max-width: 768px)').matches) {
        const datacatOverlay = document.getElementById('datacatCharModal');
        BrowseView.wireTitleScroll(document.getElementById('datacatCharName'), datacatOverlay, datacatOverlay?.querySelector('.browse-char-modal'));
    }

    on('datacatCharClose', 'click', () => closePreviewModal());

    const datacatGalleryGrid = document.getElementById('datacatCharGalleryGrid');
    if (datacatGalleryGrid) {
        datacatGalleryGrid.addEventListener('click', (e) => {
            if (e.target.classList.contains('browse-gallery-thumb')) {
                const thumbs = [...datacatGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                const urls = thumbs.map(t => t.src);
                const idx = thumbs.indexOf(e.target);
                BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
            }
        });
    }

    const creatorLink = document.getElementById('datacatCharCreator');
    if (creatorLink) {
        creatorLink.addEventListener('click', (e) => {
            e.preventDefault();
            const creatorId = getCreatorId(datacatSelectedChar);
            if (creatorId) {
                closePreviewModal();
                if (datacatSelectedChar && getSourceKind(datacatSelectedChar) === 'saucepan') {
                    const handle = getCreatorName(datacatSelectedChar);
                    browseCreator(creatorId, { source: 'saucepan', handle, name: handle });
                } else {
                    browseCreator(creatorId);
                }
            }
        });
    }

    const avatar = document.getElementById('datacatCharAvatar');
    if (avatar && !window.matchMedia('(max-width: 768px)').matches) {
        avatar.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!avatar.src || avatar.src.endsWith('/img/ai4.png')) return;
            BrowseView.openAvatarViewer(avatar.src);
        });
    }

    on('datacatImportBtn', 'click', () => {
        const importBtn = document.getElementById('datacatImportBtn');
        const extractId = importBtn?.dataset.extractId;
        if (extractId) {
            const extractSource = importBtn?.dataset.extractSource || 'janitor';
            startModalExtraction(extractId, extractSource);
        } else if (datacatSelectedChar) {
            importCharacter(datacatSelectedChar);
        }
    });

    const modalOverlay = document.getElementById('datacatCharModal');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closePreviewModal();
        });
    }

    window.registerOverlay?.({ id: 'datacatCharModal', tier: 7, close: () => closePreviewModal() });
    window.registerOverlay?.({ id: 'datacatCreatorBanner', tier: 9, close: () => clearCreatorFilter() });
}

// ========================================
// EXPOSE openDatacatCharPreview ON WINDOW
// ========================================

window.openDatacatCharPreview = function(char) {
    openPreviewModal(char);
};

// ========================================
// BROWSE VIEW CLASS
// ========================================

// Destroy any active FlareSolverr session on tab close so we don't leak a
// Chromium instance on the user's FlareSolverr server.
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (flareSession.url && flareSession.id) {
            // Use sendBeacon-friendly synchronous path is unavailable; best-effort.
            destroyFlareSolverrSession(flareSession.url, flareSession.id);
        }
    });
}

const datacatBrowseView = new (class DatacatBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const dcData = char.data?.extensions?.datacat;
        if (dcData?.id) idSet.add(String(dcData.id));
    }

    // -- Following Manager --

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        return datacatFollowedCreators.map((c, i) => ({
            id: c.id,
            name: c.name,
            source: c.source || 'datacat',
            handle: (c.source === 'saucepan') ? c.name : undefined,
            followedAt: i,
        }));
    }

    _renderManagerCreatorCard(creator, index) {
        const html = super._renderManagerCreatorCard(creator, index);
        const source = creator.source || 'datacat';
        // DataCat-tracked creators are JanitorAI creators (DataCat indexes JanitorAI),
        // so display them with the Janitor badge for consistency with the timeline.
        const badge = source === 'saucepan'
            ? '<span class="browse-feature-badge source-saucepan" title="Source: Saucepan">S</span>'
            : '<span class="browse-feature-badge source-janitor" title="Source: JanitorAI">J</span>';
        // Inject the source badge inside the meta line, before the existing meta children.
        return html.replace(
            '<div class="follow-mgr-card-meta">',
            `<div class="follow-mgr-card-meta"><span class="follow-mgr-source-badge">${badge}</span>`
        );
    }

    async followCreator(query) {
        if (!query) return null;
        const raw = query.trim();

        // Saucepan URL or @handle pattern
        const saucepanUrlMatch = raw.match(/saucepan\.ai\/@?([A-Za-z0-9_.-]+)/i);
        const atHandleMatch = raw.match(/^@([A-Za-z0-9_.-]+)$/);
        if (saucepanUrlMatch || atHandleMatch) {
            const handle = (saucepanUrlMatch?.[1] || atHandleMatch?.[1] || '').trim();
            if (!handle) return null;
            // Saucepan stores handle as both display name and lookup key; id = author_id
            // Try fetching to resolve author_id
            try {
                const data = await fetchSaucepanCompanionsOfUser(handle);
                const list = data?.characters || [];
                if (list.length === 0) {
                    showToast(`Saucepan creator "${handle}" not found or has no characters`, 'warning');
                    return null;
                }
                const authorId = list[0]?.creator_id;
                if (!authorId) {
                    showToast('Could not resolve Saucepan creator id', 'warning');
                    return null;
                }
                if (isCreatorFollowed(authorId, 'saucepan')) {
                    showToast('Already following this creator', 'info');
                    return null;
                }
                followCreator(authorId, handle, 'saucepan');
                return { id: authorId, name: handle };
            } catch (e) {
                debugLog('[DatacatFollowing] Saucepan follow lookup failed:', e.message);
                showToast('Failed to look up Saucepan creator', 'error');
                return null;
            }
        }

        let creatorId = raw;

        // Extract UUID from DataCat creator URL
        const urlMatch = creatorId.match(/creators?\/([0-9a-f-]{36})/i);
        if (urlMatch) creatorId = urlMatch[1];

        // Check if already followed (datacat)
        if (isCreatorFollowed(creatorId, 'datacat')) {
            showToast('Already following this creator', 'info');
            return null;
        }

        // UUID format: try API lookup
        if (/^[0-9a-f-]{36}$/i.test(creatorId)) {
            const creator = await fetchDatacatCreator(creatorId);
            if (creator) {
                const name = creator.userName || creatorId;
                followCreator(creatorId, name, 'datacat');
                return { id: creatorId, name };
            }
        }

        // Client-side name search across known data
        const lowerQ = raw.toLowerCase();
        const sources = [
            ...datacatFollowedCreators.map(c => ({ id: c.id, name: c.name, source: c.source || 'datacat' })),
            ...datacatCharacters.map(c => ({ id: getCreatorId(c), name: getCreatorName(c), source: getSourceKind(c) === 'saucepan' ? 'saucepan' : 'datacat' })),
            ...datacatFollowingCharacters.map(c => ({ id: getCreatorId(c), name: getCreatorName(c), source: getSourceKind(c) === 'saucepan' ? 'saucepan' : 'datacat' })),
        ];
        const exact = sources.find(c => c.name?.toLowerCase() === lowerQ);
        const match = exact || sources.find(c => c.name?.toLowerCase().includes(lowerQ));

        if (match && match.id && !isCreatorFollowed(match.id, match.source)) {
            followCreator(match.id, match.name, match.source);
            return { id: match.id, name: match.name };
        }

        showToast('Creator not found. Try pasting a DataCat or Saucepan creator URL.', 'warning');
        return null;
    }

    async unfollowCreator(id) {
        const entry = datacatFollowedCreators.find(c => c.id === id);
        unfollowCreator(id, entry?.source || 'datacat');
        return true;
    }

    browseCreatorFromManager(creator) {
        switchDatacatViewMode('browse');
        _returnToFollowing = true;
        const source = creator.source || 'datacat';
        if (source === 'saucepan') {
            browseCreator(creator.id, { source: 'saucepan', handle: creator.handle || creator.name, name: creator.name });
        } else {
            browseCreator(creator.id);
        }
    }

    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
            { value: 'recent', label: 'Recently Added' },
        ];
    }

    get previewModalId() { return 'datacatCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'recent', label: 'Recent' },
                { value: 'fresh_24h', label: 'Freshest (24h)' },
                { value: 'score_24h', label: 'Score (24h)' },
                { value: 'chat_count_24h', label: 'Chat Count (24h)' },
                { value: 'messages_per_chat_24h', label: 'MSG/Chat (24h)' },
                { value: 'first_published_24h', label: 'First Published (24h)' },
                { value: 'fresh_week', label: 'Freshest (Week)' },
                { value: 'score_week', label: 'Score (Week)' },
                { value: 'chat_count_week', label: 'Chat Count (Week)' },
                { value: 'messages_per_chat_week', label: 'MSG/Chat (Week)' },
                { value: 'first_published_week', label: 'First Published (Week)' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest Created' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'chat_count', label: 'Most Messages' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get hasModeToggle() { return true; }

    get mobileFilterIds() {
        return {
            sort: 'datacatSortSelect',
            timelineSort: 'datacatFollowingSortSelect',
            tags: 'datacatTagsBtn',
            filters: 'datacatFiltersBtn',
            nsfw: 'datacatNsfwToggle',
            refresh: 'datacatRefreshBtn',
            modeBrowseSelector: '.datacat-view-btn[data-datacat-view="browse"]',
            modeFollowSelector: '.datacat-view-btn[data-datacat-view="following"]',
        };
    }

    // -- Filter Bar --

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            <div class="chub-view-toggle">
                <button class="datacat-view-btn active" data-datacat-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="datacat-view-btn" data-datacat-view="following" title="Characters from creators you follow">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort -->
            <div id="datacatSortContainer" class="browse-sort-container">
                <select id="datacatSortSelect" class="glass-select" title="Sort order">
                    ${buildSortOptionsHtml(datacatSortMode)}
                </select>
                <select id="datacatFollowingSortSelect" class="glass-select hidden" title="Sort following timeline">
                    <option value="newest" selected>🆕 Newest Created</option>
                    <option value="oldest">🕐 Oldest First</option>
                    <option value="name_asc">📝 Name A-Z</option>
                    <option value="name_desc">📝 Name Z-A</option>
                    <option value="chat_count">💬 Most Messages</option>
                </select>
            </div>

            <!-- Tags -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="datacatTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="datacatTagsBtnLabel">Tags</span>
                </button>
                <div id="datacatTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="datacatTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="datacatTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="datacatTagsList"></div>
                </div>
            </div>

            <!-- Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="datacatFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="datacatFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="datacatFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="datacatFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                    <div id="datacatFilterSourceSection">
                        <div class="dropdown-section-title">Source:</div>
                        <label class="filter-checkbox"><input type="checkbox" id="datacatFilterHideJanitor"> <i class="fa-solid fa-cat"></i> Hide JanitorAI</label>
                        <label class="filter-checkbox"><input type="checkbox" id="datacatFilterHideSaucepan"> <i class="fa-solid fa-bowl-food"></i> Hide Saucepan</label>
                    </div>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="datacatNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Open-Definition toggle (Saucepan only) -->
            <button id="datacatOpenDefToggle" class="glass-btn active" title="Showing only open-definition characters" style="display: none;">
                <i class="fa-solid fa-lock-open"></i> <span>Open Defs</span>
            </button>

            <!-- Refresh -->
            <button id="datacatRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // -- Main View --

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="datacatBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="datacatSearchInput" placeholder="Paste a DataCat or JanitorAI character URL..." autocomplete="one-time-code">
                        <button id="datacatClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="datacatSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="datacatCreatorSearchInput" placeholder="Creator name or URL..." autocomplete="one-time-code">
                            <button id="datacatCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator Banner -->
                <div id="datacatCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-cat"></i>
                        <span>Browsing characters by <strong id="datacatCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="datacatCreatorSortSelect" class="glass-select" title="Sort creator's characters">
                            ${CREATOR_SORT_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
                        </select>
                        <button id="datacatFollowCreatorBtn" class="glass-btn" title="Follow this creator" style="display: none;">
                            <i class="fa-regular fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="datacatClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="datacatGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="datacatLoadMore" style="display: none;">
                    <button id="datacatLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="datacatFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from creators you follow</p>
                    </div>
                    <div class="chub-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="datacatFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="datacatFollowingGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="datacatFollowingLoadMore" style="display: none;">
                    <button id="datacatFollowingLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // -- Modals --

    renderModals() {
        return `
    <div id="datacatCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="datacatCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="datacatCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="datacatCharCreator" href="#" class="creator-link" title="Click to browse this creator's characters">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="datacatOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on DataCat">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="datacatImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="datacatCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="datacatCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-envelope"></i>
                            <span id="datacatCharMessages">0</span> messages
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-text-width"></i>
                            <span id="datacatCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat" id="datacatCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="datacatCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="datacatCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="datacatCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="datacatCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="datacatCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading indicator -->
                <div id="datacatCharDefinitionLoading" class="browse-char-section" style="display: none;">
                    <div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description (personality field) -->
                <div class="browse-char-section" id="datacatCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="datacatCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="datacatCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="datacatCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Messages -->
                <div class="browse-char-section browse-section-collapsed" id="datacatCharMesExampleSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharMesExample" data-label="Example Messages" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Messages
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="datacatCharMesExample" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="datacatCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="datacatCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="datacatCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="datacatCharAltGreetingsCount"></span>
                    </h3>
                    <div id="datacatCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery (Saucepan portraits) -->
                <div class="browse-char-section" id="datacatCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="datacatCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="datacatCharGalleryLabel"></span>
                    </h3>
                    <div id="datacatCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // -- Lifecycle --

    _getImageGridIds() { return ['datacatGrid', 'datacatFollowingGrid']; }

    canLoadMore() {
        if (datacatViewMode === 'following') {
            return datacatFollowingDisplayLimit < datacatFollowingFiltered.length;
        }
        return datacatHasMore && !datacatIsLoading && datacatViewMode === 'browse';
    }

    loadMore() {
        if (datacatViewMode === 'following') {
            datacatFollowingDisplayLimit += 60;
            renderFollowing(true);
            return;
        }
        if (datacatBrowseMode === 'creator') {
            datacatCurrentOffset += PAGE_SIZE;
        } else if (isHampterSortMode(datacatSortMode)) {
            hampterCurrentPage++;
        } else if (isJannySortMode(datacatSortMode)) {
            meiliCurrentPage++;
        } else if (isSaucepanSortMode(datacatSortMode)) {
            saucepanCurrentPage++;
        } else {
            const parsed = parseSortMode(datacatSortMode);
            if (parsed) {
                if (parsed.window === '24h') datacatFreshLimit24 += FRESH_PAGE_INCREMENT;
                else datacatFreshLimitWeek += FRESH_PAGE_INCREMENT;
            } else {
                datacatCurrentOffset += PAGE_SIZE;
            }
        }
        loadCharacters(true);
    }

    init() {
        super.init();
        loadFollowedCreators();
        this.buildLocalLibraryLookup();
        initDatacatView();
        const grid = document.getElementById('datacatGrid');
        if (grid) {
            this.observeImages(grid);
            // Show spinner immediately so the user doesn't see a blank grid
            // while the async cl-helper / session checks below are in flight.
            renderLoadingState(grid, 'Loading from DataCat...', 'browse-loading');
        }

        // Check cl-helper, auto-init session (with persistence), then load
        checkDcPluginAvailable().then(async ok => {
            if (!ok) {
                const g = document.getElementById('datacatGrid');
                if (g) g.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                        <i class="fa-solid fa-plug-circle-xmark" style="font-size: 2rem; color: #e67e22;"></i>
                        <p style="margin-top: 12px;">The <strong>cl-helper</strong> server plugin is required for DataCat browsing.</p>
                        <p style="margin-top: 8px; font-size: 0.85em;">Copy the <code>extras/cl-helper</code> folder into your SillyTavern <code>plugins/</code> directory and restart ST.</p>
                        <p style="margin-top: 8px;"><a href="https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary#cl-helper-plugin-not-detected" target="_blank" style="color: var(--accent);">Setup instructions</a></p>
                    </div>
                `;
                return;
            }

            const savedToken = getSetting('datacatToken') || null;
            const token = await initDcSession(savedToken);
            if (token) {
                if (token !== savedToken) setSetting('datacatToken', token);
                loadCharacters(false);
            } else {
                const g = document.getElementById('datacatGrid');
                if (g) g.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                        <i class="fa-solid fa-triangle-exclamation" style="font-size: 2rem; color: #e67e22;"></i>
                        <p style="margin-top: 12px;">Failed to initialize a DataCat session.</p>
                        <p style="margin-top: 8px; font-size: 0.85em;">DataCat may be temporarily unavailable. Try again later.</p>
                    </div>
                `;
            }
        });
    }

    applyDefaults(defaults) {
        if (defaults.view === 'following') {
            switchDatacatViewMode('following');
        }
        if (defaults.sort) {
            if (datacatViewMode === 'browse') {
                datacatSortMode = defaults.sort;
                const el = document.getElementById('datacatSortSelect');
                if (el) el.value = defaults.sort;
            } else {
                datacatFollowingSort = defaults.sort;
                const el = document.getElementById('datacatFollowingSortSelect');
                if (el) el.value = defaults.sort;
            }
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            datacatBrowseMode = 'recent';
            datacatSelectedChar = null;
            datacatCharacters = [];
            datacatCurrentOffset = 0;
            datacatFreshLimit24 = 80;
            datacatFreshLimitWeek = 20;
            datacatHasMore = true;
            datacatIsLoading = false;
            datacatFollowingLoading = false;
            datacatGridRenderedCount = 0;
            datacatCreatorId = null;
            datacatCreatorName = '';
            datacatActiveTagIds.clear();
            datacatTagsLoaded = false;
            datacatViewMode = 'browse';
            datacatFollowingCharacters = [];
            datacatFollowingDisplayLimit = 60;
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized) {
            delegatesInitialized = true;
            this.buildLocalLibraryLookup();
            this.reconnectImageObserver();
            updateSearchPlaceholder();
            updateTagsVisibility();
        }

        // Pre-warm FlareSolverr in the background so by the time the user
        // picks a Hampter sort the session has already solved CF and cached
        // the cookie. Best-effort; no UI feedback if it fails silently.
        const flareUrl = (getSetting('datacatFlareSolverrUrl') || '').trim();
        if (flareUrl) prewarmFlareSession(flareUrl);
    }

    // -- Library Lookup (BrowseView contract) --

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.datacatId;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const creatorName = card.querySelector('.browse-card-creator-link')?.textContent || '';
            return isCharInLocalLibrary({ characterId: id, name, creatorName });
        });
    }

    deactivate() {
        datacatDetailFetchToken++;
        delegatesInitialized = false;
        clearExtractionState();
        // Intentionally NOT clearing the FlareSolverr session here - keeping
        // it alive across tab switches means re-entering DataCat reuses the
        // already-warm session instead of paying the CF challenge cost again.
        // The session is destroyed on page unload via the beforeunload hook.
        super.deactivate();
        this.disconnectImageObserver();
    }
})();

export default datacatBrowseView;
