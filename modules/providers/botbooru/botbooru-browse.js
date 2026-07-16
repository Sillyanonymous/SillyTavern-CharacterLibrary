// BotbooruBrowseView - Botbooru browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, CL_HELPER_PLUGIN_BASE, isMobileMode, absolutizeMediaPaths, finishBrowseImport } from '../provider-utils.js';
import {
    BOTBOORU_BASE,
    getBotbooruPreviewUrl,
    getBotbooruDownloadUrl,
    fetchBotbooruPosts,
    fetchBotbooruPost,
    fetchBotbooruUser,
    fetchBotbooruFollowing,
    setBotbooruFollow,
    fetchBotbooruFollowedTags,
    addBotbooruFollowedTag,
    removeBotbooruFollowedTag,
    fetchBotbooruTagWeights,
    upsertBotbooruTagWeight,
    deleteBotbooruTagWeight,
    fetchBotbooruFavoriteState,
    toggleBotbooruFavorite,
    fetchBotbooruFavorites,
    getBotbooruWriterTag,
    fetchBotbooruTags,
    fetchBotbooruMe,
    patchBotbooruAccount,
} from './botbooru-api.js';

// Botbooru mirrors embedded images as root-relative /mirror/ paths; only the site can resolve those
const absBB = (t) => absolutizeMediaPaths(t, BOTBOORU_BASE);

// ========================================
// CORE-API DESTRUCTURE
// ========================================

/* eslint-disable no-unused-vars */
const {
    onElement: on,
    showElement: show,
    hideElement: hide,
    hideModal,
    debugLog,
    showToast,
    escapeHtml,
    safePurify,
    formatRichText,
    sanitizeTaglineHtml,
    renderLoadingState,
    renderSkeletonGrid,
    getSetting,
    setSetting,
    setSettings,
    debounce,
    getCharacterGalleryId,
    deleteCharacter,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    getProviderExcludeTags,
    apiRequest,
} = CoreAPI;
/* eslint-enable no-unused-vars */

// ========================================
// STATE & HELPERS
// ========================================

let bbPosts = [];
let bbTotal = 0;
let bbHasMore = true;
let bbIsLoading = false;
let bbLoadToken = 0;
let bbSortPreset = 'latest';
let bbNsfwEnabled = false; // persisted via the botbooruNsfw setting (synced in initBotbooruView); SFW is the fresh-install default
let bbCurrentSearch = '';
let bbUploaderFilter = null; // {id, name} - uploads-view mode (writers are tags and ride the search instead)
let bbUploaderSort = 'latest'; // uploads-view sort; valid upload_sort values: latest, downloads, favorites

// Following mode (server-backed user follows: POST/DELETE /api/users/{id}/follow,
// list via /api/users/{me}/following; there is NO followed-feed param on /posts/,
// so the timeline merges each followed uploader's latest uploads client-side)
let bbViewMode = 'browse'; // 'browse' | 'following'
let bbMyUserId = null;
let bbFollowedUsers = null; // [{id, username, avatar_url}] or null = not loaded
let bbTimelinePosts = [];
let bbTimelinePage = 0;
let bbTimelineHasMore = false;
let bbTimelineLoading = false;
let bbTimelineSort = 'newest';
let bbTimelineLoadToken = 0;
const BB_TIMELINE_PER_USER = 20;
let bbSelectedPost = null;
let bbSelectedDetail = null; // /post/{id} detail fetched by the preview (full fields + uploader), reused for the import duplicate check
let bbPreviewToken = 0;      // identity guard: the api helpers have no abort signal, so stale results are discarded by token

// Curated sub-sort; only sent when the account runs weighted-tag mode
// (server ignores it otherwise)
let bbCuratedSort = 'recent';

// Sort presets (sort + optional time_window; valid windows are day/week/month,
// anything else silently means all-time)
const BB_SORT_PRESETS = {
    'latest':      { sort: 'latest' },
    'hot_day':     { sort: 'favorites', timeWindow: 'day' },
    'hot_week':    { sort: 'favorites', timeWindow: 'week' },
    'hot_month':   { sort: 'favorites', timeWindow: 'month' },
    'hot_all':     { sort: 'favorites' },
    'views_day':   { sort: 'views', timeWindow: 'day' },
    'views_week':  { sort: 'views', timeWindow: 'week' },
    'views_month': { sort: 'views', timeWindow: 'month' },
    'views_all':   { sort: 'views' },
    'dl_day':      { sort: 'downloads', timeWindow: 'day' },
    'dl_week':     { sort: 'downloads', timeWindow: 'week' },
    'dl_month':    { sort: 'downloads', timeWindow: 'month' },
    'dl_all':      { sort: 'downloads' },
    'curated':     { sort: 'curated', curatedSort: 'recent' },
    'random':      { sort: 'random' },
};

// Library filters (client-side)
let bbFilterHideOwned = false;
let bbFilterHidePossible = false;

// Server-side content filter: hide_ai=true drops AI-generated cards (~30% of
// the catalog); session-scoped like its dropdown siblings
let bbHideAi = false;

// Curated freshness: curated_include_updated=false excludes bumped/updated
// cards from the Curated feed (mode-independent, unlike the sub-sort)
let bbCuratedFreshOnly = false;

// My Favorites view (browse-mode data source: the account favorites list)
let bbFilterFavorites = false;
let bbFavoritesPage = 0;

// Tag filters (tri-state). Includes are merged into q (the API matches tag names);
// excludes are client-side, the API has no exclusion param.
let bbTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>
let bbMinTokens = 0;
// Server-side advanced filters (Tags dropdown > Advanced Options)
let bbIncludeLorebookTokens = false; // lorebook text counts toward min_tokens
let bbUploadedAfter = '';            // YYYY-MM-DD, server-side range filter
let bbUploadedBefore = '';

let bbCardLookup = new Map(); // id -> post
let bbDelegatesInitialized = false;
let bbModalEventsAttached = false;
let bbGridRenderedCount = 0;

// Tag DB (lazy; /tags/ is ~1.6MB so it only loads when the dropdown first opens)
let bbAllTags = [];
let bbTagsLoading = false;
let bbTagsLoaded = false;

// Favorite tags (followed tags; curated-sort boosters): lower(tag_name) -> entry
let bbFollowedTagsMap = null;

async function loadFollowedTagsMap(force = false) {
    if (!force && bbFollowedTagsMap) return bbFollowedTagsMap;
    if (!getSetting('botbooruToken')) return null;
    const entries = await fetchBotbooruFollowedTags();
    if (!entries) return bbFollowedTagsMap;
    bbFollowedTagsMap = new Map(entries.map(en => [en.tag_name.toLowerCase(), en]));
    return bbFollowedTagsMap;
}

// Tag weights (weighted-tag mode): lower(tag_name) -> entry. The dropdown
// stars manage these instead of the follows list when the account switch is on
let bbTagWeightsMap = null;

async function loadTagWeightsMap(force = false) {
    if (!force && bbTagWeightsMap) return bbTagWeightsMap;
    if (!getSetting('botbooruToken')) return null;
    const entries = await fetchBotbooruTagWeights();
    if (!entries) return bbTagWeightsMap;
    bbTagWeightsMap = new Map(entries.map(en => [en.tag_name.toLowerCase(), en]));
    return bbTagWeightsMap;
}

// Default weight a dropdown star assigns (matches the settings add-row default)
const BB_STAR_WEIGHT = 100;

function tagWeightIsBoost(entry) {
    return !!entry && (Number(entry.weight) > 0 || entry.always_follow === true);
}

// Meta-ish tag names screened out of card chips when the payload gave us
// string tags with no category to filter on
const BB_META_TAG_NAMES = new Set(['sfw', 'nsfw', 'nsfl', 'english', 'origin_chub', 'origin_janitor', 'original_prose', 'is_fork', 'multiple_greetings', 'meta']);

// Uploader id -> username (session cache; the posts list only carries the id)
const bbUploaderNames = new Map();
let bbUploaderFetchActive = 0;
const bbUploaderFetchQueue = [];

// ========================================
// IMAGE LOAD QUEUE
// The image host rate-limits by overall pressure (bursts of 80 parallel
// produced 20x 429; the budget is shared with the API + tag DB traffic), so
// images load through a concurrency gate with PACED dispatches, and retries
// back off far enough (4s/8s/16s) to escape the rate window entirely.
// ========================================

const BB_IMG_CONCURRENCY = 4;
const BB_IMG_MAX_RETRIES = 3;
const BB_IMG_DISPATCH_MS = 120; // min spacing between dispatches (~8/s sustained)
const bbImgQueue = [];
let bbImgActive = 0;
let bbImgLastDispatch = 0;
let bbImgPumpTimer = 0;

function bbEnqueueImage(img) {
    if (!img?.dataset?.src || img.dataset.failed || img.dataset.loadedOk || img.dataset.queued) return;
    img.dataset.queued = '1';
    bbImgQueue.push(img);
    bbPumpImageQueue();
}

function bbPumpImageQueue() {
    while (bbImgActive < BB_IMG_CONCURRENCY && bbImgQueue.length > 0) {
        const sinceLast = Date.now() - bbImgLastDispatch;
        if (sinceLast < BB_IMG_DISPATCH_MS) {
            if (!bbImgPumpTimer) {
                bbImgPumpTimer = setTimeout(() => { bbImgPumpTimer = 0; bbPumpImageQueue(); }, BB_IMG_DISPATCH_MS - sinceLast);
            }
            return;
        }
        const img = bbImgQueue.shift();
        delete img.dataset.queued;
        if (!img.isConnected || img.dataset.failed || img.dataset.loadedOk) continue;
        const realSrc = img.dataset.src;
        bbImgActive++;
        bbImgLastDispatch = Date.now();

        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onError);
            bbImgActive--;
            bbPumpImageQueue();
        };
        const onLoad = () => {
            img.dataset.loadedOk = '1';
            settle();
        };
        const onError = () => {
            const tries = (+img.dataset.retry || 0) + 1;
            if (tries <= BB_IMG_MAX_RETRIES) {
                img.dataset.retry = String(tries);
                // Long backoff: short retries land inside the same rate window
                setTimeout(() => { if (img.isConnected) bbEnqueueImage(img); }, 4000 * Math.pow(2, tries - 1));
            } else {
                img.dataset.failed = '1';
                img.src = '/img/ai4.png';
            }
            settle();
        };
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onError);
        const tries = +img.dataset.retry || 0;
        // rr param dodges any cached error response on retries; BrowseView.loadImage
        // keeps the container's loaded/load-failed class wiring consistent
        BrowseView.loadImage(img, tries ? `${realSrc}&rr=${tries}` : realSrc);
    }
}

let view; // module-scoped BrowseView instance reference (set once in constructor)

function postHasTag(post, lowerName) {
    return (post.tags || []).some(t => (t.name || '').toLowerCase() === lowerName);
}

function isPostInLocalLibrary(post) {
    return view._lookup.byProviderId.has(String(post.id));
}

function isPostPossibleMatch(post) {
    return !!postPossibleTier(post)?.show;
}

function postPossibleTier(post) {
    if (isPostInLocalLibrary(post)) return null;
    // The Writer tag is the creator credit; the resolved uploader name is the
    // fallback signal. With NO creator signal, a name-only match would flag
    // half the catalog (generic character names), so skip the badge instead.
    const creator = getBotbooruWriterTag(post)
        || (post.uploader_id != null ? bbUploaderNames.get(String(post.uploader_id)) : '') || '';
    if (!creator) return null;
    return view.getPossibleMatchTier(post.character_name || '', creator);
}

function markBotbooruCardAsImported(id) {
    const grid = document.getElementById('botbooruGrid');
    if (!grid || !id) return;
    const card = grid.querySelector(`[data-post-id="${CSS.escape(String(id))}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        const imgWrap = card.querySelector('.browse-card-image');
        if (imgWrap) {
            imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = imgWrap.querySelector('.browse-feature-badges');
        }
    }
    if (badgesEl) {
        badgesEl.querySelector('.possible-library')?.remove();
        if (!badgesEl.querySelector('.in-library')) {
            badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
        }
    }
}

function buildBbLookup(targetMap, posts) {
    targetMap.clear();
    for (const post of posts) {
        if (post.id != null) targetMap.set(String(post.id), post);
    }
}

class BotbooruBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        // Kept low: the preview endpoint rate-limits bursts (80 parallel requests
        // produced 20x 429 in testing), so eager preloading must stay under it
        this._preloadLimit = 30;
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const id = char.data?.extensions?.botbooru?.id;
        if (id != null) idSet.add(String(id));
    }

    // ── Following Manager (server-backed user follows) ──

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        const users = await loadFollowedUsers(true);
        return (users || []).map(u => ({
            id: String(u.id),
            name: u.username || `#${u.id}`,
            username: u.username || '',
            avatar: u.avatar_url ? (u.avatar_url.startsWith('/') ? BOTBOORU_BASE + u.avatar_url : u.avatar_url) : '',
        }));
    }

    async followCreator(query) {
        if (!getSetting('botbooruToken')) {
            showToast('Login required to follow uploaders on Botbooru', 'warning');
            openBotbooruLoginModal();
            return null;
        }
        // No user search exists, so follows take a profile URL or numeric id
        const m = String(query).match(/profile\/(\d+)/) || String(query).trim().match(/^(\d+)$/);
        if (!m) {
            showToast('Enter an uploader profile URL or numeric id', 'info');
            return null;
        }
        const id = m[1];
        const ok = await setBotbooruFollow(id, true);
        if (ok !== true) {
            showToast('Failed to follow uploader', 'error');
            return null;
        }
        bbFollowedUsers = null;
        const user = await fetchBotbooruUser(id);
        const name = user?.username || `#${id}`;
        if (user?.username) bbUploaderNames.set(String(id), user.username);
        showToast(`Now following ${name}!`, 'success');
        return { id: String(id), name };
    }

    async unfollowCreator(id) {
        const ok = await setBotbooruFollow(id, false);
        if (ok === false) {
            bbFollowedUsers = null;
            showToast('Unfollowed', 'info');
            return true;
        }
        showToast('Failed to unfollow', 'error');
        return false;
    }

    browseCreatorFromManager(creator) {
        switchBotbooruViewMode('browse');
        filterByUploader(creator.id, creator.name);
    }

    get hasModeToggle() { return true; }

    get previewModalId() { return 'botbooruCharModal'; }

    _getImageGridIds() {
        return bbViewMode === 'following' ? ['botbooruTimelineGrid'] : ['botbooruGrid'];
    }

    // ── Image pipeline overrides: everything routes through the rate-limit-aware
    // queue instead of loading immediately (see the IMAGE LOAD QUEUE block) ──

    _initImageObserver() {
        if (this._imageObserver) return;
        this._imageObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) bbEnqueueImage(entry.target);
            }
        }, { rootMargin: '600px' });
    }

    eagerLoadVisibleImages(container) {
        if (!container) return;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const preloadBottom = viewportHeight + 700;
        // skip already-handled images before the getBoundingClientRect, so a deep grid
        // doesnt re-measure every card ever appended on each new page.
        for (const img of container.querySelectorAll('.browse-card-image:not(.loaded) img[data-src]')) {
            if (img.dataset.loadedOk || img.dataset.failed || img.dataset.queued) continue;
            const rect = img.getBoundingClientRect();
            if (rect.bottom > -160 && rect.top < preloadBottom) bbEnqueueImage(img);
        }
    }

    eagerPreloadImages(container) {
        if (!container) return;
        let queued = 0;
        for (const img of container.querySelectorAll('.browse-card-image:not(.loaded) img[data-src]')) {
            if (queued >= this._preloadLimit) break;
            if (img.dataset.loadedOk || img.dataset.failed || img.dataset.queued) continue;
            bbEnqueueImage(img);
            queued++;
        }
    }

    closePreview() {
        closeBotbooruCharPreview();
    }

    get mobileFilterIds() {
        return {
            sort: 'botbooruSortPreset',
            subSort: 'botbooruCuratedSort',
            tags: 'botbooruTagsBtn',
            filters: 'botbooruFiltersBtn',
            nsfw: 'botbooruNsfwToggle',
            refresh: 'refreshBotbooruBtn',
            timelineSort: 'botbooruTimelineSortHeader',
            modeBrowseSelector: '.chub-view-btn[data-botbooru-view="browse"]',
            modeFollowSelector: '.chub-view-btn[data-botbooru-view="following"]',
            modeBtnClass: 'chub-view-btn',
        };
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'latest', label: 'Latest' },
                { value: 'hot_day', label: 'Hot Today' },
                { value: 'hot_week', label: 'Hot This Week' },
                { value: 'hot_month', label: 'Hot This Month' },
                { value: 'views_day', label: 'Most Viewed (Day)' },
                { value: 'dl_day', label: 'Most Downloaded (Day)' },
                { value: 'curated', label: 'Curated' },
                { value: 'random', label: 'Random' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    refreshCuratedSortVisibility() { syncCuratedSortVisibility(); }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'botbooruUploaderSearchInput' : 'botbooruSearchInput';
    }
    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Uploader profile URL or id...' : 'Characters or tags...';
    }
    getSearchModeLabel(mode) {
        return mode === 'creator' ? 'Uploader' : 'Character';
    }

    canLoadMore() {
        if (bbViewMode === 'following') return bbTimelineHasMore && !bbTimelineLoading;
        return bbHasMore && !bbIsLoading;
    }

    async loadMore() {
        if (bbViewMode === 'following') {
            await loadBotbooruTimeline(false);
        } else {
            await loadBotbooruPosts(false, true);
        }
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Mode Toggle (reuses the canonical chub-view-toggle styling) -->
            <div class="chub-view-toggle">
                <button class="chub-view-btn active" data-botbooru-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="chub-view-btn" data-botbooru-view="following" title="New from followed uploaders (requires login)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort presets -->
            <div class="browse-sort-container">
                <select id="botbooruSortPreset" class="glass-select" title="Sort">
                    <optgroup label="Discovery">
                        <option value="latest" selected>🆕 Latest</option>
                        <option value="curated">⭐ Curated</option>
                        <option value="random">🎲 Random</option>
                    </optgroup>
                    <optgroup label="Favorites">
                        <option value="hot_day">🔥 Hot Today</option>
                        <option value="hot_week">🔥 Hot This Week</option>
                        <option value="hot_month">📈 Hot This Month</option>
                        <option value="hot_all">🏆 Most Favorited (All Time)</option>
                    </optgroup>
                    <optgroup label="Views">
                        <option value="views_day">👀 Most Viewed (Day)</option>
                        <option value="views_week">👀 Most Viewed (Week)</option>
                        <option value="views_month">👀 Most Viewed (Month)</option>
                        <option value="views_all">👀 Most Viewed (All Time)</option>
                    </optgroup>
                    <optgroup label="Downloads">
                        <option value="dl_day">📥 Most Downloaded (Day)</option>
                        <option value="dl_week">📥 Most Downloaded (Week)</option>
                        <option value="dl_month">📥 Most Downloaded (Month)</option>
                        <option value="dl_all">📥 Most Downloaded (All Time)</option>
                    </optgroup>
                </select>

                <!-- Timeline Sort (Following mode) -->
                <select id="botbooruTimelineSortHeader" class="glass-select browse-filter-hidden" title="Sort timeline">
                    <option value="newest">🆕 Newest</option>
                    <option value="oldest">🕐 Oldest First</option>
                    <option value="name_asc">📝 Name A-Z</option>
                    <option value="name_desc">📝 Name Z-A</option>
                    <option value="favorites">❤️ Most Favorited</option>
                    <option value="views">👀 Most Viewed</option>
                    <option value="downloads">📥 Most Downloaded</option>
                    <option value="random">🎲 Random</option>
                </select>

                <!-- Curated sub-sort (weighted-tag accounts only) -->
                <select id="botbooruCuratedSort" class="glass-select browse-filter-hidden" title="Curated ordering (weighted tags)">
                    <option value="recent" selected>🕐 Recent</option>
                    <option value="score">⭐ Tag Score</option>
                    <option value="followed">📌 Only Followed</option>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="botbooruTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="botbooruTagsBtnLabel">Tags</span>
                </button>
                <div id="botbooruTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="botbooruTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="botbooruTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="botbooruTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="botbooruMinTokens" class="glass-input-small" value="0" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label title="Count lorebook text toward Min Tokens"><i class="fa-solid fa-book"></i> Count lorebook tokens</label>
                        <input type="checkbox" id="botbooruIncludeLorebookTokens">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-calendar-day"></i> Uploaded after</label>
                        <input type="date" id="botbooruUploadedAfter" class="glass-input-small botbooru-date-input">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-calendar-day"></i> Uploaded before</label>
                        <input type="date" id="botbooruUploadedBefore" class="glass-input-small botbooru-date-input">
                    </div>
                </div>
            </div>

            <!-- Feature + Library Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="botbooruFiltersBtn" class="glass-btn" title="Personal and library filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="botbooruFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div id="botbooruCuratedSection" class="hidden">
                        <div class="dropdown-section-title">Curated:</div>
                        <label class="filter-checkbox" title="New uploads only (exclude bumped/updated cards)"><input type="checkbox" id="botbooruCuratedFresh"> <i class="fa-solid fa-seedling"></i> New Uploads Only</label>
                        <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    </div>
                    <div class="dropdown-section-title">Personal <span style="font-size: 0.8em; opacity: 0.6;">(requires login)</span>:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterFavorites"> <i class="fa-solid fa-heart" style="color: #e74c3c;"></i> My Favorites</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Content:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterHideAi"> <i class="fa-solid fa-robot"></i> Hide AI-generated</label>
                </div>
            </div>

            <!-- Content Toggles -->
            <button id="botbooruNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content (requires login)">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Auth -->
            <button id="botbooruAuthBtn" class="glass-btn icon-only" title="Botbooru login">
                <i class="fa-solid fa-key"></i>
            </button>

            <!-- Refresh -->
            <button id="refreshBotbooruBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="botbooruBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="botbooruSearchInput" placeholder="Search Botbooru characters or tags..." autocomplete="one-time-code">
                        <button id="botbooruClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="botbooruSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="botbooruUploaderSearchInput" placeholder="Uploader profile URL or id..." autocomplete="one-time-code">
                            <button id="botbooruUploaderSearchBtn" class="browse-search-submit" title="Browse an uploader's cards">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Uploader Filter Banner -->
                <div id="botbooruCreatorBanner" class="chub-author-banner hidden">
                    <div class="chub-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing uploads by <strong id="botbooruCreatorBannerName">Uploader</strong></span>
                    </div>
                    <div class="chub-author-banner-actions">
                        <select id="botbooruUploaderSortSelect" class="glass-select" title="Sort uploader's characters">
                            <option value="latest" selected>🆕 Newest</option>
                            <option value="downloads">📥 Most Downloaded</option>
                            <option value="favorites">❤️ Most Favorited</option>
                        </select>
                        <button id="botbooruFollowUploaderBtn" class="glass-btn browse-author-follow-btn" title="Follow this uploader on Botbooru">
                            <i class="fa-solid fa-user-plus"></i> <span>Follow</span>
                        </button>
                        <button id="botbooruClearCreatorBtn" class="glass-btn icon-only" title="Clear uploader filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="botbooruGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="botbooruLoadMore" style="display: none;">
                    <button id="botbooruLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="botbooruFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from uploaders you follow</p>
                    </div>
                    <div class="chub-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="botbooruFollowMgrToggle"
                                title="Manage followed uploaders">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="botbooruTimelineGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="botbooruTimelineLoadMore" style="display: none;">
                    <button id="botbooruTimelineLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return this._renderLoginModal() + this._renderPreviewModal();
    }

    _renderLoginModal() {
        return `
    <div id="botbooruLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> Botbooru Authentication</h2>
                <button class="close-btn" id="botbooruLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle" style="color: var(--cl-success-bright);"></i>
                    <strong>SFW browsing and importing works without an account!</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-fire" style="color: var(--accent);"></i>
                    <strong>NSFW content requires login.</strong> Logging in also lets CL enable the account-side NSFW switch for you.
                </p>

                <div class="browse-login-form" id="botbooruLoginForm">
                    <div class="form-group">
                        <label for="botbooruUsernameInput">Username</label>
                        <input type="text" id="botbooruUsernameInput" class="glass-input" placeholder="Botbooru username" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label for="botbooruPasswordInput">Password</label>
                        <input type="password" id="botbooruPasswordInput" class="glass-input" placeholder="Password" autocomplete="current-password">
                    </div>
                    <div class="browse-login-status" id="botbooruLoginStatus" style="display:none;"></div>
                </div>

                <details style="margin-top: 15px; background: rgba(255,255,255,0.03); padding: 10px; border-radius: var(--radius-lg);">
                    <summary style="cursor: pointer; color: var(--accent);">
                        <i class="fa-solid fa-key"></i> Or paste a token manually
                    </summary>
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--glass-border); font-size: 0.9rem; color: var(--text-secondary);">
                        <p style="margin: 0 0 8px;">Username/password login needs the cl-helper plugin. Without it, paste the JWT from botbooru.com's local storage (key <code>access_token</code>) here:</p>
                        <input type="password" id="botbooruManualTokenInput" class="glass-input" placeholder="Paste bearer token..." autocomplete="new-password">
                        <button id="botbooruSaveTokenBtn" class="action-btn secondary" style="margin-top: 8px;">
                            <i class="fa-solid fa-save"></i> Save Token
                        </button>
                    </div>
                </details>

                <div class="browse-login-actions">
                    <button id="botbooruLoginBtn" class="action-btn primary">
                        <i class="fa-solid fa-right-to-bracket"></i> Login
                    </button>
                    <button id="botbooruLogoutBtn" class="action-btn secondary" style="display:none;">
                        <i class="fa-solid fa-trash"></i> Clear Token
                    </button>
                    <a href="${BOTBOORU_BASE}/account" target="_blank" class="action-btn secondary" title="Register on the Botbooru website">
                        <i class="fa-solid fa-external-link"></i> Register on Botbooru
                    </a>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="botbooruCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="botbooruCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="botbooruCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            <span id="botbooruCharCreatorWrap" style="display:none;">by <span id="botbooruCharCreator" class="browse-meta-identity">Writer</span> •</span>
                            <span id="botbooruCharUploaderWrap" style="display:none;">uploaded by <span id="botbooruCharUploader" class="browse-meta-identity" data-identity-icon="fa-solid fa-user">Uploader</span>
                            <a id="botbooruCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open uploader's Botbooru profile"><i class="fa-solid fa-external-link"></i></a> •</span>
                            <span id="botbooruCharViews" title="Views"><i class="fa-solid fa-eye"></i> 0</span> •
                            <span id="botbooruCharDownloads" title="Downloads"><i class="fa-solid fa-download"></i> 0</span> •
                            <span id="botbooruCharFavoriteBtn" class="botbooru-fav-btn-inline browse-fav-toggle" title="Add to favorites on Botbooru"><i class="fa-regular fa-heart"></i> <span id="botbooruCharFavoriteCount">0</span></span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="botbooruOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on Botbooru">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="botbooruDownloadBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="botbooruCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="botbooruCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="botbooruCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="botbooruCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="botbooruCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="botbooruCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="botbooruCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="botbooruCharLorebookStat" style="display: none;">
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                        <div class="browse-stat" id="botbooruCharForkStat" style="display: none;">
                            <i class="fa-solid fa-code-fork"></i>
                            Fork
                        </div>
                        <div class="browse-stat" id="botbooruCharOriginStat" style="display: none;">
                            <i class="fa-solid fa-link"></i>
                            <a id="botbooruCharOriginLink" href="#" target="_blank" rel="noopener noreferrer" title="Original source">Origin</a>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="botbooruCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="botbooruCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="botbooruCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading failure note -->
                <div id="botbooruCharDefinitionLoading" class="browse-char-section" style="display: none;"></div>

                <!-- Description -->
                <div class="browse-char-section" id="botbooruCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="botbooruCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="botbooruCharPersonalitySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="botbooruCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="botbooruCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="botbooruCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="botbooruCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="botbooruCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="botbooruCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="botbooruCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="botbooruCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="botbooruCharAltGreetingsCount"></span>
                    </h3>
                    <div id="botbooruCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery (mini-gallery, max 3 images) -->
                <div class="browse-char-section" id="botbooruCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="botbooruCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="botbooruCharGalleryLabel"></span>
                    </h3>
                    <div id="botbooruCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    init() {
        super.init();
        initBotbooruView();
        this._registerDropdownDismiss([
            { dropdownId: 'botbooruFiltersDropdown', buttonId: 'botbooruFiltersBtn' },
            { dropdownId: 'botbooruTagsDropdown', buttonId: 'botbooruTagsBtn' },
        ]);
    }

    applyDefaults(defaults) {
        if (defaults.view === 'following') {
            switchBotbooruViewMode('following', { skipLoad: true });
        }
        if (defaults.sort) {
            if (bbViewMode === 'following') {
                bbTimelineSort = defaults.sort;
                const el = document.getElementById('botbooruTimelineSortHeader');
                if (el) el.value = defaults.sort;
            } else if (BB_SORT_PRESETS[defaults.sort]) {
                bbSortPreset = defaults.sort;
                const el = document.getElementById('botbooruSortPreset');
                if (el) el.value = defaults.sort;
            }
        }
        if (defaults.hideOwned) {
            bbFilterHideOwned = true;
            const el = document.getElementById('botbooruFilterHideOwned');
            if (el) el.checked = true;
        }
        if (defaults.hidePossible) {
            bbFilterHidePossible = true;
            const el = document.getElementById('botbooruFilterHidePossible');
            if (el) el.checked = true;
        }
        if (defaults.hideOwned || defaults.hidePossible) updateBotbooruFeaturesButton();
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            bbCurrentSearch = '';
            bbUploaderFilter = null;
            bbPosts = [];
            bbTotal = 0;
            bbHasMore = true;
            bbIsLoading = false;
            bbGridRenderedCount = 0;
            bbSelectedPost = null;
            bbSelectedDetail = null;
            bbViewMode = 'browse';
            bbTimelinePosts = [];
            bbTimelinePage = 0;
            bbTimelineHasMore = false;
            bbTimelineLoading = false;
        }
        super.activate(container, options);
        bbDelegatesInitialized = true;

        this.buildLocalLibraryLookup();
        const grid = document.getElementById('botbooruGrid');
        const timelineGrid = document.getElementById('botbooruTimelineGrid');

        if (bbViewMode === 'following') {
            if (bbTimelinePosts.length === 0) {
                loadBotbooruTimeline(true);
            } else if (timelineGrid && timelineGrid.children.length === 0) {
                renderBotbooruTimeline();
            } else {
                this.reconnectImageObserver();
            }
        } else if (bbPosts.length === 0) {
            loadBotbooruPosts();
        } else if (grid && grid.children.length === 0 && bbPosts.length > 0) {
            bbGridRenderedCount = 0;
            renderBotbooruGrid();
        } else {
            this.reconnectImageObserver();
        }
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.postId;
            return id != null && view._lookup.byProviderId.has(String(id));
        }, ['botbooruGrid', 'botbooruTimelineGrid']);
    }

    // Same policy as postPossibleTier: writer tag, else the resolved uploader name; with no
    // creator signal a name-only match would flag half the catalog, so skip the badge.
    _cardPossibleTier(card, name) {
        const el = card.querySelector('.browse-card-creator-link');
        const creator = el?.dataset.writer
            || (el?.dataset.uploaderId ? (bbUploaderNames.get(String(el.dataset.uploaderId)) || '') : '');
        return creator ? this.getPossibleMatchTier(name, creator) : { show: false };
    }

    deactivate() {
        super.deactivate();
        bbDelegatesInitialized = false;
        this.disconnectImageObserver();
        bbPreviewToken++;      // discard any in-flight preview detail
        bbTimelineLoadToken++; // and any in-flight timeline merge
        bbTimelineLoading = false;
    }

    /**
     * Settings mutated the favorite tags; drop the cache so the dropdown
     * stars re-read on next open.
     */
    invalidateFollowedTags() {
        bbFollowedTagsMap = null;
        bbTagWeightsMap = null;
    }

    /**
     * Settings flipped the NSFL checkbox. When the account already went through
     * the first NSFW-enable consent (accountWasSynced), push the switches to the
     * account immediately, regardless of view state, so the change is visible on
     * botbooru.com right away; then reload the grid if a NSFW session is live.
     */
    async refreshAfterContentFlagsChange(accountWasSynced) {
        if (!getSetting('botbooruToken')) return;
        if (!accountWasSynced) {
            // CL never synced, but the NSFW master switch may already be on (enabled
            // on the site itself); pushing the NSFL sub-switch then matches intent
            // without granting NSFW. Otherwise the first CL NSFW enable sends both.
            const me = await fetchBotbooruMe();
            if (!me?.show_nsfw) return;
        }
        const ok = await ensureNsfwAccountFlags();
        if (ok && bbNsfwEnabled && bbDelegatesInitialized && document.getElementById('botbooruGrid')) {
            loadBotbooruPosts(true);
        }
    }

    closeDropdowns() {
        document.getElementById('botbooruTagsDropdown')?.classList.add('hidden');
        document.getElementById('botbooruFiltersDropdown')?.classList.add('hidden');
    }
}

// ========================================
// BOTBOORU BROWSE LOGIC
// ========================================

function initBotbooruView() {
    const sortEl = document.getElementById('botbooruSortPreset');
    if (sortEl) {
        sortEl.value = bbSortPreset;
        CoreAPI.initCustomSelect?.(sortEl);
    }
    const curatedSortEl = document.getElementById('botbooruCuratedSort');
    if (curatedSortEl) {
        curatedSortEl.value = bbCuratedSort;
        CoreAPI.initCustomSelect?.(curatedSortEl);
    }
    syncCuratedSortVisibility();

    // Restore the persisted NSFW choice (a token is required to have enabled it;
    // if the token expired the server returns SFW-only anyway)
    bbNsfwEnabled = getSetting('botbooruNsfw') === true && !!getSetting('botbooruToken');
    updateNsfwToggleState();
    updateAuthButtonState();
    setupBotbooruGridDelegates();

    // Mode toggle (Browse / Following); following requires a token
    document.querySelectorAll('.chub-view-btn[data-botbooru-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.botbooruView;
            if (newMode === bbViewMode) return;
            if (newMode === 'following' && !getSetting('botbooruToken')) {
                showToast('Following requires a Botbooru login', 'warning');
                openBotbooruLoginModal();
                return;
            }
            switchBotbooruViewMode(newMode);
        });
    });

    const timelineSortEl = document.getElementById('botbooruTimelineSortHeader');
    if (timelineSortEl) {
        timelineSortEl.value = bbTimelineSort;
        // Transfer the hidden class to the custom-select container it becomes
        const wasHidden = timelineSortEl.classList.contains('browse-filter-hidden');
        CoreAPI.initCustomSelect?.(timelineSortEl);
        if (wasHidden && timelineSortEl._customSelect?.container) {
            timelineSortEl._customSelect.container.classList.add('browse-filter-hidden');
        }
        timelineSortEl.addEventListener('change', (e) => {
            bbTimelineSort = e.target.value;
            renderBotbooruTimeline();
        });
    }

    on('botbooruTimelineLoadMoreBtn', 'click', () => {
        if (bbTimelineLoading) return;
        loadBotbooruTimeline(false);
    });

    // Search handlers
    on('botbooruSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performBotbooruSearch();
    });
    on('botbooruSearchInput', 'input', (e) => {
        document.getElementById('botbooruClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('botbooruSearchBtn', 'click', () => performBotbooruSearch());
    on('botbooruUploaderSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performBotbooruUploaderSearch();
    });
    on('botbooruUploaderSearchBtn', 'click', () => performBotbooruUploaderSearch());
    on('botbooruClearSearchBtn', 'click', () => {
        const input = document.getElementById('botbooruSearchInput');
        if (input) { input.value = ''; input.focus(); }
        document.getElementById('botbooruClearSearchBtn')?.classList.add('hidden');
        performBotbooruSearch();
    });

    // Sort preset
    on('botbooruCuratedSort', 'change', (e) => {
        bbCuratedSort = e.target.value;
        loadBotbooruPosts(true);
    });

    on('botbooruCuratedFresh', 'change', (e) => {
        bbCuratedFreshOnly = e.target.checked;
        updateBotbooruFeaturesButton();
        loadBotbooruPosts(true);
    });

    on('botbooruSortPreset', 'change', (e) => {
        bbSortPreset = e.target.value;
        syncCuratedSortVisibility();
        loadBotbooruPosts(true);
    });

    // Library filters dropdown
    on('botbooruFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        document.getElementById('botbooruTagsDropdown')?.classList.add('hidden');
        document.getElementById('botbooruFiltersDropdown')?.classList.toggle('hidden');
    });

    const filterCheckboxes = [
        { id: 'botbooruFilterFavorites', setter: (v) => bbFilterFavorites = v, getter: () => bbFilterFavorites },
        { id: 'botbooruFilterHideOwned', setter: (v) => bbFilterHideOwned = v, getter: () => bbFilterHideOwned },
        { id: 'botbooruFilterHidePossible', setter: (v) => bbFilterHidePossible = v, getter: () => bbFilterHidePossible },
        { id: 'botbooruFilterHideAi', setter: (v) => bbHideAi = v, getter: () => bbHideAi },
    ];
    filterCheckboxes.forEach(({ id, getter }) => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = getter();
    });
    updateBotbooruFeaturesButton();
    filterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            if (id === 'botbooruFilterFavorites' && e.target.checked && !getSetting('botbooruToken')) {
                e.target.checked = false;
                showToast('Login required to view your Botbooru favorites', 'warning');
                openBotbooruLoginModal();
                return;
            }
            setter(e.target.checked);
            updateBotbooruFeaturesButton();
            if (id === 'botbooruFilterFavorites') {
                // Favorites is a different data source (the account list), not a
                // client-side predicate; it lives in the browse grid
                if (bbViewMode === 'following') switchBotbooruViewMode('browse', { skipLoad: true });
                if (e.target.checked && bbUploaderFilter) clearUploaderFilter(false);
                loadBotbooruPosts(true);
                return;
            }
            if (id === 'botbooruFilterHideAi') {
                // Server-side param, not a client predicate; refetch
                if (bbViewMode === 'following') switchBotbooruViewMode('browse', { skipLoad: true });
                loadBotbooruPosts(true);
                return;
            }
            if (bbViewMode === 'following') {
                renderBotbooruTimeline();
            } else {
                bbGridRenderedCount = 0;
                renderBotbooruGrid();
            }
        });
    });

    initBotbooruTagsDropdown();

    // NSFW toggle - server-gated: anonymous browsing is SFW-only, so enabling needs a token
    on('botbooruNsfwToggle', 'click', async () => {
        if (!bbNsfwEnabled) {
            if (!getSetting('botbooruToken')) {
                showToast('NSFW browsing requires a Botbooru login', 'warning');
                openBotbooruLoginModal();
                return;
            }
            const ok = await ensureNsfwAccountFlags();
            if (!ok) return;
        }
        bbNsfwEnabled = !bbNsfwEnabled;
        setSetting('botbooruNsfw', bbNsfwEnabled);
        updateNsfwToggleState();
        loadBotbooruPosts(true);
    });

    on('botbooruAuthBtn', 'click', () => openBotbooruLoginModal());

    on('botbooruClearCreatorBtn', 'click', () => clearUploaderFilter());

    const uploaderSortEl = document.getElementById('botbooruUploaderSortSelect');
    if (uploaderSortEl) {
        uploaderSortEl.value = bbUploaderSort;
        CoreAPI.initCustomSelect?.(uploaderSortEl);
        uploaderSortEl.addEventListener('change', (e) => {
            bbUploaderSort = e.target.value;
            if (bbUploaderFilter) loadBotbooruPosts(true);
        });
    }

    on('botbooruFollowUploaderBtn', 'click', async () => {
        if (!bbUploaderFilter) return;
        if (!getSetting('botbooruToken')) {
            showToast('Login required to follow uploaders on Botbooru', 'warning');
            openBotbooruLoginModal();
            return;
        }
        const btn = document.getElementById('botbooruFollowUploaderBtn');
        const wantFollow = !btn?.classList.contains('following');
        const result = await setBotbooruFollow(bbUploaderFilter.id, wantFollow);
        if (result === null) {
            showToast('Failed to update follow state', 'error');
            return;
        }
        bbFollowedUsers = null;
        showToast(result ? `Now following ${bbUploaderFilter.name}!` : `Unfollowed ${bbUploaderFilter.name}`, result ? 'success' : 'info');
        updateBannerFollowState();
    });

    on('refreshBotbooruBtn', 'click', () => loadBotbooruPosts(true));

    on('botbooruLoadMoreBtn', 'click', () => {
        if (bbIsLoading) return;
        loadBotbooruPosts(false, true);
    });

    // Modal and document-level listeners - only attach once since these elements
    // persist in document.body across provider switches (DOM recreation)
    if (!bbModalEventsAttached) {
        bbModalEventsAttached = true;

        const overlay = document.getElementById('botbooruCharModal');
        BrowseView.wireTitleScroll(document.getElementById('botbooruCharName'), overlay, overlay?.querySelector('.browse-char-modal'));

        // Avatar click -> full-size viewer; the card PNG download is the full-resolution source.
        // Desktop only at event time; on mobile bail before stopPropagation so the delegated tap runs.
        const avatar = document.getElementById('botbooruCharAvatar');
        if (avatar) {
            avatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!avatar.src || !bbSelectedPost) return;
                BrowseView.openAvatarViewer(getBotbooruDownloadUrl(bbSelectedPost.id, 'png'), avatar.src);
            });
        }

        const galleryGridEl = document.getElementById('botbooruCharGalleryGrid');
        if (galleryGridEl) {
            galleryGridEl.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...galleryGridEl.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.dataset.full || t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(urls[idx], e.target.src, urls, idx);
                }
            });
        }

        on('botbooruCharClose', 'click', closeBotbooruCharPreview);
        on('botbooruDownloadBtn', 'click', () => downloadBotbooruCharacter());
        on('botbooruCharFavoriteBtn', 'click', toggleBotbooruCharFavorite);
        on('botbooruCharModal', 'click', (e) => {
            if (e.target.id === 'botbooruCharModal') closeBotbooruCharPreview();
        });

        on('botbooruLoginClose', 'click', () => hideModal('botbooruLoginModal'));
        on('botbooruLoginModal', 'click', (e) => {
            if (e.target.id === 'botbooruLoginModal') hideModal('botbooruLoginModal');
        });
        on('botbooruLoginBtn', 'click', loginToBotbooru);
        on('botbooruPasswordInput', 'keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); loginToBotbooru(); }
        });
        on('botbooruSaveTokenBtn', 'click', saveBotbooruManualToken);
        on('botbooruLogoutBtn', 'click', clearBotbooruToken);

        window.registerOverlay?.({ id: 'botbooruCharModal', tier: 7, close: closeBotbooruCharPreview });
        window.registerOverlay?.({ id: 'botbooruLoginModal', tier: 6, close: () => hideModal('botbooruLoginModal') });
        window.registerOverlay?.({ id: 'botbooruCreatorBanner', tier: 9, close: () => clearUploaderFilter() });
    }

    debugLog('Botbooru view initialized');
}

// ========================================
// AUTH (token login via cl-helper + manual paste fallback)
// ========================================

export function openBotbooruLoginModal() {
    const modal = document.getElementById('botbooruLoginModal');
    if (!modal) return;
    const hasToken = !!getSetting('botbooruToken');
    const logoutBtn = document.getElementById('botbooruLogoutBtn');
    if (logoutBtn) logoutBtn.style.display = hasToken ? '' : 'none';
    setBotbooruLoginStatus(hasToken ? 'Logged in. A saved token is active.' : '', false);
    modal.classList.remove('hidden');
}

function setBotbooruLoginStatus(msg, isError) {
    const el = document.getElementById('botbooruLoginStatus');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.toggle('success', !isError);
}

async function loginToBotbooru() {
    const username = document.getElementById('botbooruUsernameInput')?.value?.trim();
    const password = document.getElementById('botbooruPasswordInput')?.value || '';
    if (!username || !password) {
        setBotbooruLoginStatus('Enter username and password', true);
        return;
    }

    const loginBtn = document.getElementById('botbooruLoginBtn');
    const originalHtml = loginBtn?.innerHTML;
    if (loginBtn) { loginBtn.disabled = true; loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...'; }

    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/botbooru-login`, 'POST', { username, password });
        if (resp.status === 404) {
            setBotbooruLoginStatus('cl-helper plugin not found. Install it (and restart ST), or paste a token manually below.', true);
            return;
        }
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.access_token) {
            setBotbooruLoginStatus(data.detail || data.error || `Login failed (${resp.status})`, true);
            return;
        }

        // New token = possibly a different account; re-sync the content switches
        // and drop the cached identity/follows on next use
        setSettings({ botbooruToken: data.access_token, botbooruNsfwAccountSynced: false, botbooruUseTagWeights: false });
        bbMyUserId = null;
        bbFollowedUsers = null;
        bbFollowedTagsMap = null;
        updateAuthButtonState();
        // Weighted-tags status check (the account switch decides whether the
        // basic favorite-tags list does anything at all)
        fetchBotbooruMe().then(me => {
            if (typeof me?.use_tag_weights === 'boolean') setSetting('botbooruUseTagWeights', me.use_tag_weights);
        }).catch(() => {});
        const pwInput = document.getElementById('botbooruPasswordInput');
        if (pwInput) pwInput.value = '';
        showToast('Logged in to Botbooru!', 'success');
        hideModal('botbooruLoginModal');
    } catch (e) {
        setBotbooruLoginStatus(`Login failed: ${e.message}`, true);
    } finally {
        if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = originalHtml; }
    }
}

async function saveBotbooruManualToken() {
    const input = document.getElementById('botbooruManualTokenInput');
    // DevTools header copies arrive as "Bearer eyJ..."; strip the scheme
    const token = input?.value?.trim().replace(/^bearer\s+/i, '');
    if (!token) {
        showToast('Paste a token first', 'warning');
        return;
    }
    setSettings({ botbooruToken: token, botbooruNsfwAccountSynced: false, botbooruUseTagWeights: false });
    bbMyUserId = null;
    bbFollowedUsers = null;
    bbFollowedTagsMap = null;
    updateAuthButtonState();
    const me = await fetchBotbooruMe();
    if (me?.username) {
        if (typeof me.use_tag_weights === 'boolean') setSetting('botbooruUseTagWeights', me.use_tag_weights);
        showToast(`Token saved, logged in as ${me.username}`, 'success');
        if (input) input.value = '';
        hideModal('botbooruLoginModal');
    } else {
        setSetting('botbooruToken', null);
        updateAuthButtonState();
        showToast('Token did not validate against /auth/me', 'error');
    }
}

function clearBotbooruToken() {
    setSettings({
        botbooruToken: null,
        botbooruNsfwAccountSynced: false,
        botbooruNsfw: false,
        botbooruUseTagWeights: false,
    });
    bbMyUserId = null;
    bbFollowedUsers = null;
    bbFollowedTagsMap = null;
    if (bbViewMode === 'following') {
        bbTimelinePosts = [];
        bbTimelinePage = 0;
        switchBotbooruViewMode('browse', { skipLoad: true });
    }
    const wasFavorites = resetBotbooruFavoritesFilter();
    if (bbNsfwEnabled) {
        bbNsfwEnabled = false;
        updateNsfwToggleState();
        loadBotbooruPosts(true);
    } else if (wasFavorites) {
        loadBotbooruPosts(true);
    }
    const logoutBtn = document.getElementById('botbooruLogoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    setBotbooruLoginStatus('', false);
    updateAuthButtonState();
    showToast('Botbooru token cleared', 'info');
}

/**
 * Sync the account-side content switches. The account flags are the server
 * master switches: without show_nsfw the API returns SFW-only no matter what
 * the request asks for, and show_nsfl alone decides whether NSFL rides along
 * (no query param exists). Both flags are sent with their CURRENT intended
 * state so unchecking NSFL actually turns it off server-side. First runs on
 * the user's first NSFW enable, per the approved UX (the switches also
 * affect botbooru.com itself); re-runs whenever the synced flag is cleared
 * (NSFL checkbox changes, logout).
 */
async function ensureNsfwAccountFlags() {
    if (getSetting('botbooruNsfwAccountSynced')) return true;
    const me = await patchBotbooruAccount({
        show_nsfw: true,
        show_nsfl: getSetting('botbooruShowNsfl') === true,
    });
    if (me?.show_nsfw) {
        setSetting('botbooruNsfwAccountSynced', true);
        return true;
    }
    showToast('Could not update the Botbooru account content switches (token may have expired)', 'error');
    return false;
}

// ========================================
// NSFW TOGGLE STATE
// ========================================

// The key is a login entry point only: authenticated sessions hide it (no
// sibling keeps a persistent auth button in the filter bar; account
// management lives in Settings and the gates' login modal).
function updateAuthButtonState() {
    const btn = document.getElementById('botbooruAuthBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !!getSetting('botbooruToken'));
}

function updateNsfwToggleState() {
    const btn = document.getElementById('botbooruNsfwToggle');
    if (!btn) return;
    if (bbNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW (requires login)';
    }
}

// ========================================
// TAGS DROPDOWN (tri-state; includes go into q, excludes filter client-side)
// ========================================

function initBotbooruTagsDropdown() {
    const btn = document.getElementById('botbooruTagsBtn');
    const dropdown = document.getElementById('botbooruTagsDropdown');
    const searchInput = document.getElementById('botbooruTagsSearchInput');
    const clearBtn = document.getElementById('botbooruTagsClearBtn');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        const wasHidden = dropdown.classList.contains('hidden');
        document.getElementById('botbooruFiltersDropdown')?.classList.add('hidden');
        dropdown.classList.toggle('hidden');
        if (wasHidden) {
            renderBotbooruTagsList();
            // Stars need the active list (weights in weighted mode, follows
            // otherwise); rerender once it lands
            const weighted = getSetting('botbooruUseTagWeights') === true;
            const starMapMissing = weighted ? !bbTagWeightsMap : !bbFollowedTagsMap;
            if (getSetting('botbooruToken') && starMapMissing) {
                (weighted ? loadTagWeightsMap() : loadFollowedTagsMap()).then(map => {
                    if (map && !dropdown.classList.contains('hidden')) {
                        renderBotbooruTagsList(searchInput?.value || '');
                    }
                });
            }
            if (!isMobileMode()) searchInput?.focus();
        }
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    searchInput?.addEventListener('input', debounce(() => {
        renderBotbooruTagsList(searchInput.value);
    }, 150));

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = searchInput.value.trim().toLowerCase();
            if (!value || value.length < 2) return;
            bbTagFilters.set(value, 'include');
            searchInput.value = '';
            renderBotbooruTagsList();
            updateTagsButtonState();
            triggerBotbooruReloadDebounced();
        }
    });

    clearBtn?.addEventListener('click', () => {
        bbTagFilters.clear();
        if (searchInput) searchInput.value = '';
        renderBotbooruTagsList('');
        updateTagsButtonState();
        triggerBotbooruReload();
    });

    const minTokensEl = document.getElementById('botbooruMinTokens');
    if (minTokensEl) {
        bbMinTokens = parseInt(getSetting('botbooruMinTokens')) || 0;
        minTokensEl.value = String(bbMinTokens);
        minTokensEl.addEventListener('change', (e) => {
            bbMinTokens = parseInt(e.target.value) || 0;
            setSetting('botbooruMinTokens', bbMinTokens);
            triggerBotbooruReload();
        });
    }

    const lbTokensEl = document.getElementById('botbooruIncludeLorebookTokens');
    if (lbTokensEl) {
        lbTokensEl.checked = bbIncludeLorebookTokens;
        lbTokensEl.addEventListener('change', (e) => {
            bbIncludeLorebookTokens = e.target.checked;
            triggerBotbooruReload();
        });
    }
    const upAfterEl = document.getElementById('botbooruUploadedAfter');
    const upBeforeEl = document.getElementById('botbooruUploadedBefore');
    if (upAfterEl) {
        upAfterEl.value = bbUploadedAfter;
        upAfterEl.addEventListener('change', (e) => {
            bbUploadedAfter = e.target.value || '';
            triggerBotbooruReload();
        });
    }
    if (upBeforeEl) {
        upBeforeEl.value = bbUploadedBefore;
        upBeforeEl.addEventListener('change', (e) => {
            bbUploadedBefore = e.target.value || '';
            triggerBotbooruReload();
        });
    }
}

let bbReloadDebounceTimeout = null;
function triggerBotbooruReload() {
    if (bbViewMode === 'following') {
        // Timeline tag filtering is client-side; re-render is instant
        renderBotbooruTimeline();
    } else {
        loadBotbooruPosts(true);
    }
}

function triggerBotbooruReloadDebounced() {
    if (bbReloadDebounceTimeout) clearTimeout(bbReloadDebounceTimeout);
    if (bbViewMode === 'following') {
        bbReloadDebounceTimeout = null;
        triggerBotbooruReload();
        return;
    }
    bbReloadDebounceTimeout = setTimeout(() => {
        bbReloadDebounceTimeout = null;
        triggerBotbooruReload();
    }, 500);
}

// Returns the in-flight promise to concurrent callers. The old shape
// early-returned RESOLVED while loading, which let a second render call
// chain render -> ensure(no-op) -> render in an endless microtask loop;
// the multi-second mobile fetch made that window easy to hit (page froze).
let bbTagsEnsurePromise = null;
function ensureBotbooruTags() {
    if (bbTagsLoaded) return Promise.resolve();
    if (bbTagsEnsurePromise) return bbTagsEnsurePromise;
    bbTagsLoading = true;
    bbTagsEnsurePromise = (async () => {
        try {
            const tags = await fetchBotbooruTags();
            // Skip alias entries (no id, alias_of set); sort popular-first for the default list
            bbAllTags = (tags || []).filter(t => t.id != null && !t.alias_of)
                .sort((a, b) => (b.count || 0) - (a.count || 0));
            bbTagsLoaded = true;
        } finally {
            bbTagsLoading = false;
            bbTagsEnsurePromise = null;
        }
    })();
    return bbTagsEnsurePromise;
}

function renderBotbooruTagsList(filter = '') {
    const container = document.getElementById('botbooruTagsList');
    if (!container) return;

    if (!bbTagsLoaded) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        // Only kick the re-render when this call started the load; concurrent
        // callers share the promise and the initiator repaints for everyone
        const alreadyLoading = !!bbTagsEnsurePromise;
        const p = ensureBotbooruTags();
        if (!alreadyLoading) p.then(() => renderBotbooruTagsList(filter));
        return;
    }

    if (bbAllTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        return;
    }

    const filterLower = filter.toLowerCase().trim();
    // The full DB is huge; unfiltered shows the popular head, search scans everything
    const source = filterLower
        ? bbAllTags.filter(t => t.name.toLowerCase().includes(filterLower))
        : bbAllTags;
    const limited = source.slice(0, 200);

    if (limited.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    const sorted = [...limited].sort((a, b) => {
        const aState = bbTagFilters.get(a.name);
        const bState = bbTagFilters.get(b.name);
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        return (b.count || 0) - (a.count || 0);
    });

    const authed = !!getSetting('botbooruToken');
    container.innerHTML = sorted.map(tag => {
        const state = bbTagFilters.get(tag.name) || 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>'
                        : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>'
                        : '';
        const stateTitle = state === 'include' ? 'Included - click to exclude'
                        : state === 'exclude' ? 'Excluded - click to clear'
                        : 'Neutral - click to include';
        const weighted = getSetting('botbooruUseTagWeights') === true;
        const weightEntry = weighted ? bbTagWeightsMap?.get(tag.name.toLowerCase()) : null;
        const faved = weighted ? tagWeightIsBoost(weightEntry) : bbFollowedTagsMap?.has(tag.name.toLowerCase());
        const starTitle = weighted
            ? (faved
                ? `Remove tag weight (${weightEntry.always_follow ? 'always follow' : `+${weightEntry.weight}`})`
                : `Add tag weight (+${BB_STAR_WEIGHT}); fine-tune in Settings`)
            : (faved ? 'Remove from favorite tags (curated boost)' : 'Add to favorite tags (curated boost)');
        const starHtml = authed
            ? `<button class="botbooru-tag-fav-btn${faved ? ' faved' : ''}" data-tag="${escapeHtml(tag.name)}" data-category="${escapeHtml(tag.category || 'General')}" title="${escapeHtml(starTitle)}"><i class="fa-${faved ? 'solid' : 'regular'} fa-star"></i></button>`
            : '';
        return `
            <div class="browse-tag-filter-item" data-tag="${escapeHtml(tag.name)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label" title="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</span>
                <span class="botbooru-tag-meta">${escapeHtml(tag.category || '')} · ${formatNumber(tag.count || 0)}</span>
                ${starHtml}
            </div>
        `;
    }).join('');

    // Favorite-tag stars: weights in weighted mode, follows otherwise
    container.querySelectorAll('.botbooru-tag-fav-btn').forEach(starBtn => {
        starBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const tagName = starBtn.dataset.tag;
            const lower = tagName.toLowerCase();
            const setStar = (on, title) => {
                starBtn.classList.toggle('faved', on);
                starBtn.innerHTML = `<i class="fa-${on ? 'solid' : 'regular'} fa-star"></i>`;
                starBtn.title = title;
            };

            if (getSetting('botbooruUseTagWeights') === true) {
                const map = await loadTagWeightsMap();
                if (!map) return;
                const entry = map.get(lower);
                if (tagWeightIsBoost(entry)) {
                    const ok = await deleteBotbooruTagWeight(entry.id);
                    if (!ok) { showToast('Failed to remove tag weight', 'error'); return; }
                    map.delete(lower);
                    setStar(false, `Add tag weight (+${BB_STAR_WEIGHT}); fine-tune in Settings`);
                } else {
                    // No entry, or a negative/blocking one the user is now boosting:
                    // upsert clears the block (boost + block contradict)
                    const created = await upsertBotbooruTagWeight({
                        tag_name: entry?.tag_name || tagName,
                        category: entry?.category || starBtn.dataset.category || 'General',
                        weight: BB_STAR_WEIGHT,
                        always_follow: false,
                        always_block: false,
                    });
                    if (!created) { showToast('Failed to add tag weight', 'error'); return; }
                    map.set(lower, created);
                    setStar(true, `Remove tag weight (+${created.weight})`);
                }
            } else {
                const map = await loadFollowedTagsMap();
                if (!map) return;
                const entry = map.get(lower);
                if (entry) {
                    const ok = await removeBotbooruFollowedTag(entry.id);
                    if (!ok) { showToast('Failed to remove favorite tag', 'error'); return; }
                    map.delete(lower);
                    setStar(false, 'Add to favorite tags (curated boost)');
                } else {
                    const created = await addBotbooruFollowedTag(tagName, starBtn.dataset.category || 'General');
                    if (!created) { showToast('Failed to add favorite tag', 'error'); return; }
                    map.set(lower, created);
                    setStar(true, 'Remove from favorite tags (curated boost)');
                }
            }
            // Curated results shift with the boosters; refresh if thats whats on screen
            if (bbViewMode === 'browse' && bbSortPreset === 'curated') triggerBotbooruReloadDebounced();
        });
    });

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const label = item.querySelector('.tag-label');

        const cycleState = () => {
            const current = bbTagFilters.get(tag) || 'neutral';
            if (current === 'neutral') bbTagFilters.set(tag, 'include');
            else if (current === 'include') bbTagFilters.set(tag, 'exclude');
            else bbTagFilters.delete(tag);

            const newState = bbTagFilters.get(tag) || 'neutral';
            stateBtn.className = `browse-tag-state-btn state-${newState}`;
            stateBtn.innerHTML = newState === 'include' ? '<i class="fa-solid fa-check"></i>'
                               : newState === 'exclude' ? '<i class="fa-solid fa-minus"></i>' : '';
            updateTagsButtonState();
            triggerBotbooruReloadDebounced();
        };

        stateBtn?.addEventListener('click', (e) => { e.stopPropagation(); cycleState(); });
        label?.addEventListener('click', cycleState);
    });
}

function updateTagsButtonState() {
    const btn = document.getElementById('botbooruTagsBtn');
    const label = document.getElementById('botbooruTagsBtnLabel');
    if (!btn || !label) return;
    const count = bbTagFilters.size;
    btn.classList.toggle('has-filters', count > 0);
    label.textContent = count > 0 ? `Tags (${count})` : 'Tags';
}

function updateBotbooruFeaturesButton() {
    const btn = document.getElementById('botbooruFiltersBtn');
    if (!btn) return;
    const count = [bbCuratedFreshOnly, bbFilterFavorites, bbFilterHideOwned, bbFilterHidePossible, bbHideAi].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

// ========================================
// LOAD / SEARCH
// ========================================

function performBotbooruSearch() {
    const searchInput = document.getElementById('botbooruSearchInput');
    bbCurrentSearch = searchInput?.value?.trim() || '';
    // A fresh search leaves uploads-view mode
    if (bbUploaderFilter) clearUploaderFilter(false);
    loadBotbooruPosts(true);
}

/**
 * Writers are tags on Botbooru, so "browse by writer" IS a tag search:
 * visible in the search box and clearable like any query.
 */
function searchByWriterTag(writerTag) {
    const searchInput = document.getElementById('botbooruSearchInput');
    if (searchInput) {
        searchInput.value = writerTag;
        document.getElementById('botbooruClearSearchBtn')?.classList.remove('hidden');
    }
    bbCurrentSearch = writerTag;
    if (bbUploaderFilter) clearUploaderFilter(false);
    loadBotbooruPosts(true);
}

/**
 * Uploaders are the profile-shaped identity; their uploads come from
 * /api/users/{id} with its own pagination.
 */
async function performBotbooruUploaderSearch() {
    const input = document.getElementById('botbooruUploaderSearchInput');
    const query = input?.value.trim() || '';
    if (!query) {
        showToast('Enter an uploader profile URL or numeric id', 'warning');
        return;
    }

    // Same shape followCreator accepts; the site has no user-search API
    let id = (query.match(/profile\/(\d+)/) || query.match(/^(\d+)$/))?.[1];

    if (!id) {
        // Names resolve only against uploaders already known this session or followed
        const lower = query.toLowerCase();
        for (const [knownId, name] of bbUploaderNames) {
            if ((name || '').toLowerCase() === lower) { id = knownId; break; }
        }
        if (!id && getSetting('botbooruToken')) {
            const follows = await view.getFollowedCreators().catch(() => []);
            const hit = (follows || []).find(c => (c.name || '').toLowerCase() === lower);
            if (hit) id = String(hit.id);
        }
        if (!id) {
            showToast('Botbooru has no uploader name search; paste a profile URL or numeric id', 'info');
            return;
        }
    }

    input.value = '';
    if (!bbUploaderNames.get(id)) {
        const user = await fetchBotbooruUser(id).catch(() => null);
        if (user?.username) bbUploaderNames.set(String(id), user.username);
    }
    if (bbViewMode === 'following') switchBotbooruViewMode('browse', { skipLoad: true });
    filterByUploader(id, bbUploaderNames.get(id) || `#${id}`);
}

function filterByUploader(id, name) {
    bbUploaderFilter = { id: String(id), name: name || `#${id}` };
    view._cdRef = bbUploaderFilter;
    resetBotbooruFavoritesFilter(); // favorites and uploads-view are competing data sources
    bbCurrentSearch = '';
    const searchInput = document.getElementById('botbooruSearchInput');
    if (searchInput) searchInput.value = '';
    document.getElementById('botbooruClearSearchBtn')?.classList.add('hidden');
    const banner = document.getElementById('botbooruCreatorBanner');
    const bannerName = document.getElementById('botbooruCreatorBannerName');
    if (bannerName) bannerName.textContent = bbUploaderFilter.name;
    banner?.classList.remove('hidden');
    updateBannerFollowState();
    window.pushOverlayGuard?.();
    loadBotbooruPosts(true);
}

async function updateBannerFollowState() {
    const btn = document.getElementById('botbooruFollowUploaderBtn');
    if (!btn || !bbUploaderFilter) return;
    if (!getSetting('botbooruToken')) {
        btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> <span>Follow</span>';
        btn.title = 'Login required to follow uploaders';
        btn.classList.remove('following');
        return;
    }
    // The authed profile carries is_following: per-user truth, immune to the
    // 100-entry cap on the followed-users list (the old scan was wrong past it)
    const user = await fetchBotbooruUser(bbUploaderFilter.id, { uploadLimit: 1 });
    if (!bbUploaderFilter) return; // filter cleared while we fetched
    let following;
    if (typeof user?.is_following === 'boolean') {
        following = user.is_following;
    } else {
        // Field missing (API drift?); fall back to the list scan
        const users = await loadFollowedUsers(true);
        if (!bbUploaderFilter) return;
        following = (users || []).some(u => String(u.id) === bbUploaderFilter.id);
    }
    btn.innerHTML = following
        ? '<i class="fa-solid fa-user-check"></i> <span>Following</span>'
        : '<i class="fa-solid fa-user-plus"></i> <span>Follow</span>';
    btn.title = following ? 'Unfollow this uploader' : 'Follow this uploader on Botbooru';
    btn.classList.toggle('following', following);
}

function clearUploaderFilter(reload = true) {
    bbUploaderFilter = null;
    document.getElementById('botbooruCreatorBanner')?.classList.add('hidden');
    if (reload) loadBotbooruPosts(true);
}

function resetBotbooruFavoritesFilter() {
    if (!bbFilterFavorites) return false;
    bbFilterFavorites = false;
    const cb = document.getElementById('botbooruFilterFavorites');
    if (cb) cb.checked = false;
    return true;
}

function getExcludedTagNames() {
    const excludes = new Set();
    for (const [tag, state] of bbTagFilters) {
        if (state === 'exclude') excludes.add(tag.toLowerCase());
    }
    for (const t of getProviderExcludeTags('botbooru')) {
        excludes.add(t.toLowerCase());
    }
    return excludes;
}

// Callers hoist the excludes Set out of the filter pass (one build per render)
function postPassesClientFilters(post, excludes) {
    if (excludes.size > 0 && (post.tags || []).some(t => excludes.has((t.name || '').toLowerCase()))) return false;
    return true;
}

/**
 * Load posts. reset=true restarts from offset 0 (new search/sort/filter);
 * append=true keeps existing posts and fetches the next page.
 */
async function loadBotbooruPosts(reset = false, append = false) {
    const thisToken = ++bbLoadToken;
    const grid = document.getElementById('botbooruGrid');
    if (!grid) return;

    if (reset) {
        bbPosts = [];
        bbTotal = 0;
        bbHasMore = true;
        bbGridRenderedCount = 0;
    }

    const loadMoreBtn = document.getElementById('botbooruLoadMoreBtn');
    if (!append) renderSkeletonGrid(grid);

    bbIsLoading = true;
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        // Self-heal the account content switches: a cleared synced flag (NSFL
        // checkbox change, logout/login) re-syncs on the next load while NSFW
        // is on, so settings changes apply without bouncing the NSFW toggle.
        if (bbNsfwEnabled && getSetting('botbooruToken') && !getSetting('botbooruNsfwAccountSynced')) {
            await ensureNsfwAccountFlags();
        }

        // My Favorites: the account favorites list replaces /posts/ as the data
        // source. The endpoint has no q/min_tokens params, so search, include
        // tags, and min tokens apply client-side (the items carry everything);
        // excludes + library filters ride the normal render pass.
        if (bbFilterFavorites && getSetting('botbooruToken')) {
            const myId = await ensureMyUserId();
            if (thisToken !== bbLoadToken || !bbDelegatesInitialized) return;
            if (myId == null) throw new Error('Could not resolve your Botbooru account (token may have expired)');

            const page = append ? bbFavoritesPage + 1 : 1;
            const items = await fetchBotbooruFavorites(myId, { page, perPage: 40 });
            if (thisToken !== bbLoadToken || !bbDelegatesInitialized) return;
            if (!items) throw new Error('Could not load your favorites');

            // hasMore rides the RAW page fullness; filtering below only shrinks display
            const fullPage = items.length === 40;
            items.forEach(p => { p._isFavorited = true; });

            let filtered = items;
            const includeTags = [];
            for (const [tag, state] of bbTagFilters) {
                if (state === 'include') includeTags.push(tag.toLowerCase());
            }
            if (includeTags.length > 0) {
                filtered = filtered.filter(p => {
                    const tagNames = (p.tags || []).map(t => (t.name || '').toLowerCase());
                    return includeTags.every(t => tagNames.includes(t));
                });
            }
            if (bbMinTokens > 0) filtered = filtered.filter(p => (p.token_count || 0) >= bbMinTokens);
            if (bbCurrentSearch) {
                const s = bbCurrentSearch.toLowerCase();
                filtered = filtered.filter(p =>
                    (p.character_name || '').toLowerCase().includes(s)
                    || (p.tagline || '').toLowerCase().includes(s)
                    || (p.meta_name || '').toLowerCase().includes(s)
                    || (p.tags || []).some(t => (t.name || '').toLowerCase().includes(s)));
            }

            if (append) {
                const existing = new Set(bbPosts.map(p => p.id));
                for (const post of filtered) {
                    if (!existing.has(post.id)) bbPosts.push(post);
                }
            } else {
                bbPosts = filtered;
            }
            bbFavoritesPage = page;
            bbTotal = bbPosts.length;
            bbHasMore = fullPage;

            renderBotbooruGrid(append);
            botbooruBrowseView.updateLoadMoreVisibility('botbooruLoadMore', bbHasMore, bbPosts.length > 0);
            return;
        }

        // Uploads-view mode: the uploader's posts come from the user profile
        // endpoint with its own pagination, not /posts/
        if (bbUploaderFilter) {
            const user = await fetchBotbooruUser(bbUploaderFilter.id, {
                uploadLimit: 40,
                uploadOffset: append ? bbPosts.length : 0,
                uploadSort: bbUploaderSort,
            });
            if (thisToken !== bbLoadToken) return;
            if (!bbDelegatesInitialized) return;
            if (!user || !Array.isArray(user.uploads)) throw new Error('Could not load uploads for this uploader');

            if (user.username) {
                bbUploaderFilter.name = user.username;
                bbUploaderNames.set(String(bbUploaderFilter.id), user.username);
                const bannerName = document.getElementById('botbooruCreatorBannerName');
                if (bannerName) bannerName.textContent = user.username;
            }

            if (append) {
                const existing = new Set(bbPosts.map(p => p.id));
                for (const post of user.uploads) {
                    if (!existing.has(post.id)) bbPosts.push(post);
                }
            } else {
                bbPosts = user.uploads;
            }
            bbTotal = user.uploads_list_total ?? bbPosts.length;
            bbHasMore = user.uploads.length > 0 && bbPosts.length < bbTotal;

            renderBotbooruGrid(append);
            botbooruBrowseView.updateLoadMoreVisibility('botbooruLoadMore', bbHasMore, bbPosts.length > 0);
            return;
        }

        const preset = BB_SORT_PRESETS[bbSortPreset] || BB_SORT_PRESETS['latest'];

        // q = free search text + included tags + negated excludes, space-joined.
        // The API matches names and tags, and -tag terms exclude server-side (tag
        // names are underscore-joined, never contain spaces). The client-side
        // filter in renderBotbooruGrid stays as belt-and-braces.
        const includeTags = [];
        for (const [tag, state] of bbTagFilters) {
            if (state === 'include') includeTags.push(tag);
        }
        const excludeTerms = [...getExcludedTagNames()].map(t => `-${t}`);
        const q = [bbCurrentSearch, ...includeTags, ...excludeTerms].filter(Boolean).join(' ');

        const params = {
            sort: preset.sort,
            timeWindow: preset.timeWindow,
            curatedSort: (bbSortPreset === 'curated' && getSetting('botbooruUseTagWeights') === true)
                ? bbCuratedSort : preset.curatedSort,
            curatedIncludeUpdated: (bbSortPreset === 'curated' && bbCuratedFreshOnly) ? false : undefined,
            hideAi: bbHideAi || undefined,
            includeLorebookTokens: bbIncludeLorebookTokens || undefined,
            uploadedAfter: bbUploadedAfter || undefined,
            uploadedBefore: bbUploadedBefore || undefined,
            limit: 40,
            offset: append ? bbPosts.length : 0,
        };
        if (q) params.q = q;
        // Anonymous requests are SFW-only server-side regardless; the param makes the
        // toggle authoritative for logged-in accounts whose show_nsfw is on.
        if (!bbNsfwEnabled) params.sfwOnly = true;
        if (bbMinTokens > 0) params.minTokens = bbMinTokens;

        const data = await fetchBotbooruPosts(params);

        if (thisToken !== bbLoadToken) return;
        if (!bbDelegatesInitialized) return;
        if (!data || !Array.isArray(data.posts)) throw new Error('Botbooru returned no data');

        if (append) {
            const existing = new Set(bbPosts.map(p => p.id));
            for (const post of data.posts) {
                if (!existing.has(post.id)) bbPosts.push(post);
            }
        } else {
            bbPosts = data.posts;
        }
        bbTotal = data.total ?? bbPosts.length;
        bbHasMore = data.posts.length > 0 && bbPosts.length < bbTotal;

        renderBotbooruGrid(append);
        botbooruBrowseView.updateLoadMoreVisibility('botbooruLoadMore', bbHasMore, bbPosts.length > 0);
    } catch (e) {
        if (thisToken !== bbLoadToken) return;
        console.error('Botbooru load error:', e);
        if (!append) {
            grid.innerHTML = `
                <div class="browse-error">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load Botbooru</h3>
                    <p>${escapeHtml(e.message)}</p>
                    <button class="action-btn primary browse-retry-btn">
                        <i class="fa-solid fa-refresh"></i> Retry
                    </button>
                </div>
            `;
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        if (thisToken === bbLoadToken) {
            bbIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// GRID RENDER
// ========================================

function renderBotbooruGrid(appendOnly = false) {
    const grid = document.getElementById('botbooruGrid');
    if (!grid) return;

    const excludes = getExcludedTagNames();
    let displayPosts = bbPosts.filter(p => postPassesClientFilters(p, excludes));
    if (bbFilterHideOwned) displayPosts = displayPosts.filter(p => !isPostInLocalLibrary(p));
    if (bbFilterHidePossible) displayPosts = displayPosts.filter(p => !isPostPossibleMatch(p));

    if (displayPosts.length === 0) {
        bbGridRenderedCount = 0;
        bbCardLookup.clear();
        botbooruBrowseView.disconnectImageObserver();
        const message = bbPosts.length > 0
            ? 'Everything here is filtered out (library filters or excluded tags).'
            : 'Try a different search term or adjust your filters.';
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Characters Found</h3>
                <p>${message}</p>
            </div>
        `;
        return;
    }

    buildBbLookup(bbCardLookup, displayPosts);

    if (appendOnly && bbGridRenderedCount > 0 && bbGridRenderedCount < displayPosts.length) {
        const newPosts = displayPosts.slice(bbGridRenderedCount);
        grid.insertAdjacentHTML('beforeend', newPosts.map(p => createBotbooruCard(p)).join(''));
    } else {
        botbooruBrowseView.disconnectImageObserver();
        grid.innerHTML = displayPosts.map(p => createBotbooruCard(p)).join('');
    }

    bbGridRenderedCount = displayPosts.length;
    botbooruBrowseView.observeImages(grid);
    resolveUploaderNames(grid);
}

function setupBotbooruGridDelegates() {
    if (bbDelegatesInitialized) return;
    const grid = document.getElementById('botbooruGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            if (e.target.closest('.browse-retry-btn')) { loadBotbooruPosts(true); return; }

            // Footer person icon: always the uploader entry point
            const uploaderBtn = e.target.closest('.botbooru-uploader-btn');
            if (uploaderBtn) {
                e.stopPropagation();
                const upId = uploaderBtn.dataset.uploaderId;
                if (upId) filterByUploader(upId, bbUploaderNames.get(upId) || `#${upId}`);
                return;
            }

            // Creator clicks: a writer is a tag (search it), an uploader is a profile (uploads view)
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                const writer = creatorLink.dataset.writer;
                if (writer) { searchByWriterTag(writer); return; }
                const upId = creatorLink.dataset.uploaderId;
                if (upId) filterByUploader(upId, creatorLink.textContent.trim());
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const post = bbCardLookup.get(card.dataset.postId)
                || bbPosts.find(p => String(p.id) === card.dataset.postId);
            if (post) openBotbooruCharPreview(post);
        });

    }

    const timelineGrid = document.getElementById('botbooruTimelineGrid');
    if (timelineGrid) {
        timelineGrid.addEventListener('click', (e) => {
            const uploaderBtn = e.target.closest('.botbooru-uploader-btn');
            if (uploaderBtn) {
                e.stopPropagation();
                const upId = uploaderBtn.dataset.uploaderId;
                if (upId) {
                    switchBotbooruViewMode('browse', { skipLoad: true });
                    filterByUploader(upId, bbUploaderNames.get(upId) || `#${upId}`);
                }
                return;
            }
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                const writer = creatorLink.dataset.writer;
                if (writer) { switchBotbooruViewMode('browse', { skipLoad: true }); searchByWriterTag(writer); return; }
                const upId = creatorLink.dataset.uploaderId;
                if (upId) { switchBotbooruViewMode('browse', { skipLoad: true }); filterByUploader(upId, creatorLink.textContent.trim()); }
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const post = bbTimelinePosts.find(p => String(p.id) === card.dataset.postId);
            if (post) openBotbooruCharPreview(post);
        });
    }
    bbDelegatesInitialized = true;
}

// ========================================
// FOLLOWING MODE
// Server-backed user follows; no followed-feed exists on /posts/, so the
// timeline merges each followed uploader's latest uploads client-side
// (paced at 2 concurrent fetches; the host budget is shared).
// ========================================

// Curated extras only show when they can do anything: the sub-select needs
// Curated active AND weighted-tag mode; the freshness checkbox (in the Features
// dropdown) just needs Curated active
function syncCuratedSortVisibility() {
    const curatedActive = bbSortPreset === 'curated' && bbViewMode !== 'following';
    const el = document.getElementById('botbooruCuratedSort');
    if (el) {
        const show = curatedActive && getSetting('botbooruUseTagWeights') === true;
        const target = el._customSelect?.container || el;
        target.classList.toggle('browse-filter-hidden', !show);
    }
    const curatedSection = document.getElementById('botbooruCuratedSection');
    if (curatedSection) curatedSection.classList.toggle('hidden', !curatedActive);
    const freshCb = document.getElementById('botbooruCuratedFresh');
    if (freshCb) freshCb.checked = bbCuratedFreshOnly;
}

function switchBotbooruViewMode(newMode, opts = {}) {
    bbViewMode = newMode;
    document.querySelectorAll('.chub-view-btn[data-botbooru-view]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.botbooruView === newMode));
    document.getElementById('botbooruBrowseSection')?.classList.toggle('hidden', newMode === 'following');
    document.getElementById('botbooruFollowingSection')?.classList.toggle('hidden', newMode !== 'following');
    // Filter bar swaps per mode: browse sort <-> timeline sort, browse-only dropdowns hide
    const sortEl = document.getElementById('botbooruSortPreset');
    const sortTarget = sortEl?._customSelect?.container || sortEl;
    sortTarget?.classList.toggle('browse-filter-hidden', newMode === 'following');
    const tlSortEl = document.getElementById('botbooruTimelineSortHeader');
    const tlSortTarget = tlSortEl?._customSelect?.container || tlSortEl;
    tlSortTarget?.classList.toggle('browse-filter-hidden', newMode !== 'following');
    syncCuratedSortVisibility();
    // Tags and Filters stay visible in both modes: timeline items carry full tag
    // arrays and token counts, so includes/excludes/min-tokens apply client-side there
    if (!opts.skipLoad && newMode === 'following' && bbTimelinePosts.length === 0) {
        loadBotbooruTimeline(true);
    }
}

async function ensureMyUserId() {
    if (bbMyUserId != null) return bbMyUserId;
    if (!getSetting('botbooruToken')) return null;
    const me = await fetchBotbooruMe();
    bbMyUserId = me?.id ?? null;
    return bbMyUserId;
}

async function loadFollowedUsers(useCache = true) {
    if (useCache && Array.isArray(bbFollowedUsers)) return bbFollowedUsers;
    const myId = await ensureMyUserId();
    if (myId == null) return null;
    const data = await fetchBotbooruFollowing(myId);
    bbFollowedUsers = data?.users || [];
    for (const u of bbFollowedUsers) {
        if (u.username) bbUploaderNames.set(String(u.id), u.username);
    }
    return bbFollowedUsers;
}

async function loadBotbooruTimeline(reset = false) {
    // Guard BEFORE touching the token: bumping it on an early return would
    // orphan the in-flight load's finally and leave bbTimelineLoading stuck
    const grid = document.getElementById('botbooruTimelineGrid');
    if (!grid || bbTimelineLoading) return;
    const thisToken = ++bbTimelineLoadToken;

    if (!getSetting('botbooruToken')) {
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Login Required</h3>
                <p>Following needs a Botbooru account. Use the key button to log in.</p>
            </div>`;
        return;
    }

    bbTimelineLoading = true;
    if (reset) {
        bbTimelinePosts = [];
        bbTimelinePage = 0;
        bbTimelineHasMore = false;
        renderSkeletonGrid(grid);
    }
    const loadMoreBtn = document.getElementById('botbooruTimelineLoadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const users = await loadFollowedUsers(!reset);
        if (thisToken !== bbTimelineLoadToken || !bbDelegatesInitialized) return;

        if (!users || users.length === 0) {
            grid.innerHTML = `
                <div class="browse-empty">
                    <i class="fa-solid fa-user-group"></i>
                    <h3>No Followed Uploaders</h3>
                    <p>Follow uploaders from their uploads view, or add them by profile URL in the Manage panel.</p>
                </div>`;
            bbTimelineHasMore = false;
            botbooruBrowseView.updateLoadMoreVisibility('botbooruTimelineLoadMore', false, false);
            return;
        }

        const page = bbTimelinePage + 1;
        let anyFull = false;
        const queue = [...users];
        const workers = Array.from({ length: 2 }, async () => {
            while (queue.length > 0) {
                const u = queue.shift();
                const data = await fetchBotbooruUser(u.id, {
                    uploadLimit: BB_TIMELINE_PER_USER,
                    uploadOffset: (page - 1) * BB_TIMELINE_PER_USER,
                    uploadSort: 'latest',
                });
                if (thisToken !== bbTimelineLoadToken) return;
                const uploads = data?.uploads || [];
                if (uploads.length === BB_TIMELINE_PER_USER) anyFull = true;
                const existing = new Set(bbTimelinePosts.map(p => p.id));
                for (const post of uploads) {
                    if (existing.has(post.id)) continue;
                    // uploads items dont carry the uploader; we know whose list this is
                    if (post.uploader_id == null) post.uploader_id = Number(u.id);
                    bbTimelinePosts.push(post);
                }
            }
        });
        await Promise.all(workers);
        if (thisToken !== bbTimelineLoadToken || !bbDelegatesInitialized) return;

        bbTimelinePage = page;
        bbTimelineHasMore = anyFull;
        renderBotbooruTimeline();
        botbooruBrowseView.updateLoadMoreVisibility('botbooruTimelineLoadMore', bbTimelineHasMore, bbTimelinePosts.length > 0);
    } catch (e) {
        if (thisToken !== bbTimelineLoadToken) return;
        console.error('Botbooru timeline load error:', e);
        grid.innerHTML = `
            <div class="browse-error">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Failed to load the timeline</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>`;
    } finally {
        if (thisToken === bbTimelineLoadToken) {
            bbTimelineLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

function renderBotbooruTimeline() {
    const grid = document.getElementById('botbooruTimelineGrid');
    if (!grid) return;

    const excludes = getExcludedTagNames();
    let posts = bbTimelinePosts.filter(p => postPassesClientFilters(p, excludes));
    if (bbFilterHideOwned) posts = posts.filter(p => !isPostInLocalLibrary(p));
    if (bbFilterHidePossible) posts = posts.filter(p => !isPostPossibleMatch(p));
    // Include-tags + min tokens apply client-side here (the items carry both)
    const includeTags = [];
    for (const [tag, state] of bbTagFilters) {
        if (state === 'include') includeTags.push(tag.toLowerCase());
    }
    if (includeTags.length > 0) {
        posts = posts.filter(p => {
            const tagNames = (p.tags || []).map(t => (t.name || '').toLowerCase());
            return includeTags.every(t => tagNames.includes(t));
        });
    }
    if (bbMinTokens > 0) posts = posts.filter(p => (p.token_count || 0) >= bbMinTokens);
    if (bbTimelineSort === 'newest') {
        posts.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (bbTimelineSort === 'oldest') {
        posts.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    } else if (bbTimelineSort === 'name_asc') {
        posts.sort((a, b) => (a.character_name || '').localeCompare(b.character_name || ''));
    } else if (bbTimelineSort === 'name_desc') {
        posts.sort((a, b) => (b.character_name || '').localeCompare(a.character_name || ''));
    } else if (bbTimelineSort === 'favorites') {
        posts.sort((a, b) => (b.favorite_count || 0) - (a.favorite_count || 0));
    } else if (bbTimelineSort === 'views') {
        posts.sort((a, b) => (b.views || 0) - (a.views || 0));
    } else if (bbTimelineSort === 'downloads') {
        posts.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else if (bbTimelineSort === 'random') {
        // Stable per-render shuffle keyed on id so appends dont reshuffle everything
        posts.sort((a, b) => ((a.id * 2654435761) % 4096) - ((b.id * 2654435761) % 4096));
    }

    if (posts.length === 0) {
        botbooruBrowseView.disconnectImageObserver();
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-clock"></i>
                <h3>Nothing Here Yet</h3>
                <p>Your followed uploaders have no visible uploads (excluded tags and content gating apply).</p>
            </div>`;
        return;
    }

    botbooruBrowseView.disconnectImageObserver();
    grid.innerHTML = posts.map(p => createBotbooruCard(p)).join('');
    botbooruBrowseView.observeImages(grid);
    resolveUploaderNames(grid);
}

// ========================================
// UPLOADER NAME RESOLUTION
// The posts list only carries uploader_id; names resolve lazily through a
// small concurrency gate and a session cache, then patch the rendered cards.
// ========================================

const bbUploaderInFlight = new Set();

function resolveUploaderNames(grid) {
    if (!grid) return;
    for (const el of grid.querySelectorAll('.browse-card-creator-link[data-uploader-id]')) {
        const id = el.dataset.uploaderId;
        if (!id) continue;
        const name = bbUploaderNames.get(id);
        if (name) {
            if (!el.textContent) el.textContent = name;
            continue;
        }
        if (name === null || bbUploaderInFlight.has(id) || bbUploaderFetchQueue.includes(id)) continue;
        bbUploaderFetchQueue.push(id);
    }
    bbPumpUploaderQueue();
}

function bbPumpUploaderQueue() {
    // Concurrency 2: these share the host's rate budget with the image queue
    while (bbUploaderFetchActive < 2 && bbUploaderFetchQueue.length > 0) {
        const id = bbUploaderFetchQueue.shift();
        if (bbUploaderNames.has(id) || bbUploaderInFlight.has(id)) continue;
        bbUploaderInFlight.add(id);
        bbUploaderFetchActive++;
        fetchBotbooruUser(id).then(user => {
            const name = user?.username || null;
            bbUploaderNames.set(id, name);
            if (!name) return;
            for (const el of document.querySelectorAll(`#botbooruGrid .browse-card-creator-link[data-uploader-id="${CSS.escape(id)}"], #botbooruTimelineGrid .browse-card-creator-link[data-uploader-id="${CSS.escape(id)}"]`)) {
                if (!el.textContent) el.textContent = name;
            }
        }).finally(() => {
            bbUploaderInFlight.delete(id);
            bbUploaderFetchActive--;
            bbPumpUploaderQueue();
        });
    }
}

function createBotbooruCard(post) {
    const name = post.character_name || 'Unknown';
    const id = String(post.id);
    const avatarUrl = post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : '/img/ai4.png';
    const isNsfl = postHasTag(post, 'nsfl');
    const isNsfw = !isNsfl && postHasTag(post, 'nsfw');
    // Creator credit: the Writer tag when present (free, rides the list payload);
    // otherwise the uploader name, lazily resolved through the cache. The footer
    // person icon is the uploader entry point regardless of the writer credit.
    const writerTag = getBotbooruWriterTag(post);
    const uploaderId = post.uploader_id != null ? String(post.uploader_id) : '';
    const bodyUploaderId = !writerTag ? uploaderId : '';
    const creatorName = writerTag || (bodyUploaderId ? (bbUploaderNames.get(bodyUploaderId) || '') : '');

    const inLibrary = isPostInLocalLibrary(post);
    const possibleTier = inLibrary ? null : postPossibleTier(post);
    const possibleMatch = !!possibleTier?.show;

    // General/Scenario tags read best on cards; Meta/Language entries are mostly
    // noise. Uploads/favorites payloads carry string tags (category null after
    // normalization), so those filter through a known-meta blocklist instead.
    const tags = (post.tags || [])
        .filter(t => t.category == null
            ? !BB_META_TAG_NAMES.has((t.name || '').toLowerCase())
            : (t.category === 'General' || t.category === 'Scenarios' || t.category === 'Copyright'))
        .slice(0, 3)
        .map(t => t.name);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }
    if (post.is_fork) {
        badges.push('<span class="browse-feature-badge" title="Fork of another card"><i class="fa-solid fa-code-fork"></i></span>');
    }
    if (post.card_is_animated) {
        badges.push('<span class="browse-feature-badge" title="Animated card"><i class="fa-solid fa-film"></i></span>');
    }

    const createdDate = post.created_at ? new Date(post.created_at).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';
    const tooltip = escapeHtml(post.tagline || post.creator_notes_excerpt || '');

    return `
        <div class="${cardClass}" data-post-id="${escapeHtml(id)}" ${tooltip ? `title="${tooltip}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low">
                ${isNsfl ? '<span class="browse-nsfw-badge botbooru-nsfl-badge">NSFL</span>' : isNsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">
                    <span class="botbooru-card-name-text">${escapeHtml(name)}</span>
                    ${uploaderId ? `<span class="botbooru-uploader-btn" data-uploader-id="${escapeHtml(uploaderId)}" title="Show this uploader's cards"><i class="fa-solid fa-user"></i></span>` : ''}
                </div>
                ${(writerTag || bodyUploaderId) ? `<span class="browse-card-creator-link"${writerTag ? ` data-writer="${escapeHtml(writerTag)}" title="Search this writer's cards"` : ''}${bodyUploaderId ? ` data-uploader-id="${escapeHtml(bodyUploaderId)}" title="Show this uploader's cards"` : ''}>${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-coins"></i> ${formatNumber(post.token_count || 0)}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(post.downloads || 0)}</span>
                <span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${formatNumber(post.favorite_count || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// PREVIEW MODAL
// ========================================

// Collapse the preview tag cloud to --browse-tags-max-height with a "..."
// expander (shared browse-tags-collapsed CSS; same mechanism as the canon)
function applyBotbooruTagsClamp(tagsEl) {
    if (!tagsEl) return;

    const existingToggle = tagsEl.querySelector('.browse-tags-more');
    if (existingToggle) existingToggle.remove();

    tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => {
        tag.classList.remove('browse-tag-hidden');
    });

    tagsEl.classList.remove('browse-tags-collapsed', 'browse-tags-expanded');

    const tags = Array.from(tagsEl.querySelectorAll('.browse-tag'));
    if (!tags.length) return;

    tagsEl.classList.add('browse-tags-collapsed');

    const maxHeightValue = getComputedStyle(tagsEl).getPropertyValue('--browse-tags-max-height').trim();
    const maxHeight = parseFloat(maxHeightValue) || tagsEl.clientHeight || 64;

    let overflowIndex = -1;
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (tag.offsetTop + tag.offsetHeight > maxHeight + 2) {
            overflowIndex = i;
            break;
        }
    }

    if (overflowIndex === -1) {
        tagsEl.classList.remove('browse-tags-collapsed');
        return;
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'browse-tag browse-tags-more';
    toggle.textContent = '...';
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (tagsEl.classList.contains('browse-tags-collapsed')) {
            tagsEl.classList.remove('browse-tags-collapsed');
            tagsEl.classList.add('browse-tags-expanded');
            tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyBotbooruTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) {
        tags[i].classList.add('browse-tag-hidden');
    }
}

function closeBotbooruCharPreview() {
    bbPreviewToken++;
    cleanupBotbooruCharModal();
    hideModal('botbooruCharModal');
}

async function openBotbooruCharPreview(post) {
    const thisPreview = ++bbPreviewToken;
    bbSelectedPost = post;
    bbSelectedDetail = null;

    const modal = document.getElementById('botbooruCharModal');
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const avatarImg = document.getElementById('botbooruCharAvatar');
    const nameEl = document.getElementById('botbooruCharName');
    const viewsEl = document.getElementById('botbooruCharViews');
    const downloadsEl = document.getElementById('botbooruCharDownloads');
    const favoriteCountEl = document.getElementById('botbooruCharFavoriteCount');
    const tagsEl = document.getElementById('botbooruCharTags');
    const tokensEl = document.getElementById('botbooruCharTokens');
    const dateEl = document.getElementById('botbooruCharDate');
    const openInBrowserBtn = document.getElementById('botbooruOpenInBrowserBtn');

    const creatorNotesSection = document.getElementById('botbooruCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('botbooruCharCreatorNotes');
    const greetingsStat = document.getElementById('botbooruCharGreetingsStat');
    const greetingsCount = document.getElementById('botbooruCharGreetingsCount');
    const lorebookStat = document.getElementById('botbooruCharLorebookStat');
    const forkStat = document.getElementById('botbooruCharForkStat');
    const descSection = document.getElementById('botbooruCharDescriptionSection');
    const descEl = document.getElementById('botbooruCharDescription');
    const personalitySection = document.getElementById('botbooruCharPersonalitySection');
    const personalityEl = document.getElementById('botbooruCharPersonality');
    const scenarioSection = document.getElementById('botbooruCharScenarioSection');
    const scenarioEl = document.getElementById('botbooruCharScenario');
    const examplesSection = document.getElementById('botbooruCharExamplesSection');
    const examplesEl = document.getElementById('botbooruCharExamples');
    const firstMsgSection = document.getElementById('botbooruCharFirstMsgSection');
    const firstMsgEl = document.getElementById('botbooruCharFirstMsg');
    const altGreetingsSection = document.getElementById('botbooruCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('botbooruCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('botbooruCharAltGreetingsCount');
    const defLoading = document.getElementById('botbooruCharDefinitionLoading');

    const name = post.character_name || 'Unknown';
    const avatarUrl = post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : '/img/ai4.png';
    const inLibrary = isPostInLocalLibrary(post);
    const possibleTier = inLibrary ? null : postPossibleTier(post);
    const possibleMatch = !!possibleTier?.show;

    avatarImg.src = avatarUrl;
    // Full-size source for the avatar viewers (desktop handler + the mobile
    // delegated tap in library-mobile, which only sees the img element)
    avatarImg.dataset.full = getBotbooruDownloadUrl(post.id, 'png');
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    nameEl.textContent = name;
    // Both credit rows fill from the detail payload below
    const creatorWrap = document.getElementById('botbooruCharCreatorWrap');
    if (creatorWrap) creatorWrap.style.display = 'none';
    const uploaderWrap = document.getElementById('botbooruCharUploaderWrap');
    if (uploaderWrap) uploaderWrap.style.display = 'none';
    const taglineSection = document.getElementById('botbooruCharTaglineSection');
    const taglineEl = document.getElementById('botbooruCharTagline');
    if (post.tagline && taglineSection && taglineEl) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = sanitizeTaglineHtml(absBB(post.tagline), name);
    } else if (taglineSection) {
        taglineSection.style.display = 'none';
    }
    openInBrowserBtn.href = `${BOTBOORU_BASE}/character/${post.id}`;
    viewsEl.innerHTML = `<i class="fa-solid fa-eye"></i> ${formatNumber(post.views || 0)}`;
    downloadsEl.innerHTML = `<i class="fa-solid fa-download"></i> ${formatNumber(post.downloads || 0)}`;
    if (favoriteCountEl) favoriteCountEl.textContent = formatNumber(post.favorite_count || 0);
    updateBotbooruFavoriteButton(post);

    const tagNames = (post.tags || []).map(t => t.name);
    tagsEl.innerHTML = tagNames.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyBotbooruTagsClamp(tagsEl));

    tokensEl.textContent = formatNumber(post.token_count || 0);
    dateEl.textContent = post.created_at ? new Date(post.created_at).toLocaleDateString() : 'Unknown';
    if (forkStat) forkStat.style.display = post.is_fork ? 'flex' : 'none';
    if (lorebookStat) lorebookStat.style.display = 'none';
    if (greetingsStat) greetingsStat.style.display = 'none';
    const originStat = document.getElementById('botbooruCharOriginStat');
    if (originStat) originStat.style.display = 'none';
    const gallerySection = document.getElementById('botbooruCharGallerySection');
    const galleryGrid = document.getElementById('botbooruCharGalleryGrid');
    if (gallerySection) gallerySection.style.display = 'none';
    if (galleryGrid) galleryGrid.innerHTML = '';

    // Skeletons: post excerpts say whether notes/description exist, so empty cards dont flash a skeleton
    if (creatorNotesSection && creatorNotesEl) {
        cleanupCreatorNotesContainer(creatorNotesEl);
        if ((post.creator_notes_excerpt || '').trim()) {
            creatorNotesSection.style.display = 'block';
            creatorNotesEl.innerHTML = skeletonLines(3);
        } else {
            creatorNotesSection.style.display = 'none';
            creatorNotesEl.innerHTML = '';
        }
    }
    if (defLoading) { defLoading.style.display = 'none'; defLoading.innerHTML = ''; }
    descSection.style.display = 'block'; descEl.innerHTML = skeletonLines(3);
    personalitySection.style.display = 'none';
    scenarioSection.style.display = 'block'; scenarioEl.innerHTML = skeletonLines(2);
    examplesSection.style.display = 'block'; examplesEl.innerHTML = skeletonLines(3);
    firstMsgSection.style.display = 'block'; firstMsgEl.innerHTML = skeletonLines(4);
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';

    // Import button state
    const downloadBtn = document.getElementById('botbooruDownloadBtn');
    if (downloadBtn) {
        if (inLibrary) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
            downloadBtn.classList.add('secondary');
            downloadBtn.classList.remove('primary', 'warning');
        } else if (possibleMatch) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
            downloadBtn.classList.add('warning');
            downloadBtn.classList.remove('primary', 'secondary');
        } else {
            downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
            downloadBtn.classList.add('primary');
            downloadBtn.classList.remove('secondary', 'warning');
        }
        downloadBtn.disabled = false;
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    const renderAltGreetings = (greetings) => {
        if (!altGreetingsSection || !altGreetingsEl) return;
        if (!Array.isArray(greetings) || greetings.length === 0) {
            altGreetingsSection.style.display = 'none';
            altGreetingsEl.innerHTML = '';
            if (altGreetingsCountEl) altGreetingsCountEl.textContent = '';
            CoreAPI.setBrowseAltGreetings([]);
            return;
        }
        const buildPreview = (text) => {
            const cleaned = (text || '').replace(/\s+/g, ' ').trim();
            if (!cleaned) return 'No content';
            return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
        };
        altGreetingsSection.style.display = 'block';
        altGreetingsEl.innerHTML = greetings.map((greeting, idx) => {
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
        // Lazy-render greeting bodies on first open so one long card cant freeze the modal
        altGreetingsEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
            details.addEventListener('toggle', function onToggle() {
                if (!details.open) return;
                const body = details.querySelector('.browse-alt-greeting-body');
                if (body && !body.dataset.rendered) {
                    const idx = parseInt(details.dataset.greetingIdx, 10);
                    if (greetings[idx] != null) {
                        deferRender(body, () => safePurify(formatRichText(greetings[idx], name, true), BROWSE_PURIFY_CONFIG));
                    }
                    body.dataset.rendered = '1';
                }
            }, { once: true });
        });
        if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${greetings.length})`;
        CoreAPI.setBrowseAltGreetings(greetings);
    };

    // The /post/{id} detail carries the full definition inline PLUS the uploader
    // (the list payload only has uploader_id) and tagline; the api helper caches it.
    // No abort signal on the helpers, so staleness is handled by the identity token.
    const detail = await fetchBotbooruPost(post.id);
    if (thisPreview !== bbPreviewToken || bbSelectedPost !== post) return;

    if (!detail) {
        // Collapse the skeletons; the post excerpts are all we have
        if (creatorNotesSection) {
            const excerpt = absBB((post.creator_notes_excerpt || '').trim());
            if (excerpt) {
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(excerpt, name, creatorNotesEl));
            } else creatorNotesSection.style.display = 'none';
        }
        descSection.style.display = 'none';
        scenarioSection.style.display = 'none';
        examplesSection.style.display = 'none';
        firstMsgSection.style.display = 'none';
        if (defLoading) {
            defLoading.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load the full card. It can still be imported.</em>';
            defLoading.style.display = 'block';
        }
        return;
    }

    bbSelectedDetail = detail;
    const d = detail;

    // Both credits show when available: the Writer tag (clicking searches the
    // tag) and the uploader (clicking opens their uploads view; the external
    // icon opens their profile, the only profile that exists)
    const writerTag = getBotbooruWriterTag(d);
    if (creatorWrap && writerTag) {
        creatorWrap.style.display = '';
        const creatorEl = document.getElementById('botbooruCharCreator');
        if (creatorEl) {
            creatorEl.textContent = writerTag;
            creatorEl.title = "Search this writer's cards";
            creatorEl.style.cursor = 'pointer';
            creatorEl.onclick = () => {
                closeBotbooruCharPreview();
                searchByWriterTag(writerTag);
            };
        }
    }
    if (uploaderWrap && d.uploader_name) {
        uploaderWrap.style.display = '';
        const uploaderEl = document.getElementById('botbooruCharUploader');
        if (uploaderEl) {
            uploaderEl.textContent = d.uploader_name;
            uploaderEl.title = "Show this uploader's cards";
            uploaderEl.style.cursor = 'pointer';
            uploaderEl.onclick = () => {
                closeBotbooruCharPreview();
                if (d.uploader_id) filterByUploader(d.uploader_id, d.uploader_name);
            };
        }
        const creatorExternal = document.getElementById('botbooruCreatorExternal');
        if (creatorExternal && d.uploader_id) {
            creatorExternal.href = `${BOTBOORU_BASE}/profile/${d.uploader_id}`;
        }
    }

    // Tagline can be richer on the detail
    if (d.tagline && taglineSection && taglineEl) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = sanitizeTaglineHtml(d.tagline, name);
    }

    // Provenance: many posts are reuploads; origin names the source platform and
    // sauce links the original page. Display-only, never a CL provider link.
    if (originStat && (d.origin || d.sauce)) {
        const originLink = document.getElementById('botbooruCharOriginLink');
        if (originLink) {
            originLink.textContent = d.origin ? `Origin: ${d.origin}` : 'Origin';
            if (typeof d.sauce === 'string' && /^https?:\/\//i.test(d.sauce)) {
                originLink.href = d.sauce;
                originLink.style.pointerEvents = '';
            } else {
                originLink.removeAttribute('href');
                originLink.style.pointerEvents = 'none';
            }
        }
        originStat.style.display = 'flex';
    }

    if (creatorNotesSection && creatorNotesEl) {
        // creator_notes_display is botbooru's server-sanitized render (strips the raw notes'
        // escaped-HTML junk and CSS-injection blocks); fall back to raw when its absent.
        const notes = absBB((d.creator_notes_display || d.creator_notes || '').trim());
        if (notes) {
            creatorNotesSection.style.display = 'block';
            if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
            deferCall(creatorNotesEl, () => renderCreatorNotesSecure(notes, name, creatorNotesEl));
        } else {
            creatorNotesSection.style.display = 'none';
            cleanupCreatorNotesContainer(creatorNotesEl);
            creatorNotesEl.innerHTML = '';
        }
    }

    if (lorebookStat) lorebookStat.style.display = d.has_lorebook ? 'flex' : 'none';
    const greetCount = (d.alternate_greetings?.length || 0) + 1;
    if (greetingsStat && greetCount > 1) {
        greetingsStat.style.display = 'flex';
        greetingsCount.textContent = greetCount;
    }

    // Mini-gallery (max 3 approved images; thumbs at 480, viewer gets the 1600 view)
    const galleryImages = (d.mini_gallery?.images || []).filter(i => i.status === 'approved' && i.preview_url);
    if (gallerySection && galleryGrid && galleryImages.length > 0) {
        gallerySection.style.display = 'block';
        const galleryLabel = document.getElementById('botbooruCharGalleryLabel');
        if (galleryLabel) galleryLabel.textContent = `(${galleryImages.length})`;
        galleryGrid.innerHTML = galleryImages.map(img =>
            `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(BOTBOORU_BASE + img.preview_url)}" data-full="${escapeHtml(BOTBOORU_BASE + (img.main_view_url || img.preview_url))}" alt="Gallery image" title="Gallery image" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`
        ).join('');
    }

    // RAF defer so safePurify doesnt block the modal-open paint frame
    requestAnimationFrame(() => {
        if (thisPreview !== bbPreviewToken) return;
        const sections = [
            [absBB(d.description), descSection, descEl],
            [absBB(d.personality), personalitySection, personalityEl],
            [absBB(d.scenario), scenarioSection, scenarioEl],
            [absBB(d.mes_example), examplesSection, examplesEl],
            [absBB(d.first_mes), firstMsgSection, firstMsgEl],
        ];
        for (const [text, section, el] of sections) {
            if (text) {
                section.style.display = 'block';
                deferRender(el, () => safePurify(formatRichText(text, name, true), BROWSE_PURIFY_CONFIG));
                el.dataset.fullContent = text;
            } else if (section) {
                section.style.display = 'none';
            }
        }
    });

    renderAltGreetings((d.alternate_greetings || []).map(absBB));
}

/**
 * Release the memory held by the preview modal (rendered rich text, alt
 * greetings, creator-notes iframe). Matters on mobile.
 */
function cleanupBotbooruCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);

    const modal = document.getElementById('botbooruCharModal');
    if (modal) {
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });
        const sectionIds = [
            'botbooruCharAltGreetings',
            'botbooruCharDescription',
            'botbooruCharPersonality',
            'botbooruCharScenario',
            'botbooruCharExamples',
            'botbooruCharFirstMsg',
            'botbooruCharTagline',
            'botbooruCharGalleryGrid',
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        cleanupCreatorNotesContainer(document.getElementById('botbooruCharCreatorNotes'));
    }
    bbSelectedPost = null;
    bbSelectedDetail = null;
}

// ========================================
// FAVORITES (post hearts; server-backed, POST is a pure toggle)
// ========================================

/**
 * Sync the heart button to the post's favorite state. Unknown state is
 * resolved via the per-item endpoint once and cached on the post object.
 */
async function updateBotbooruFavoriteButton(post) {
    const btn = document.getElementById('botbooruCharFavoriteBtn');
    if (!btn) return;

    btn.classList.remove('favorited', 'loading');
    btn.querySelector('i').className = 'fa-regular fa-heart';

    if (!getSetting('botbooruToken')) {
        btn.title = 'Login to Botbooru to add favorites';
        return;
    }
    btn.title = 'Add to favorites on Botbooru';

    const applyFavorited = () => {
        btn.classList.add('favorited');
        btn.querySelector('i').className = 'fa-solid fa-heart';
        btn.title = 'Remove from favorites on Botbooru';
    };

    if (post._isFavorited === true) { applyFavorited(); return; }
    if (post._isFavorited === false) return;

    btn.classList.add('loading');
    const state = await fetchBotbooruFavoriteState(post.id);
    if (bbSelectedPost !== post) return; // modal moved on while we fetched
    btn.classList.remove('loading');
    if (!state) return;

    post._isFavorited = state.favorited;
    post.favorite_count = state.count;
    const countEl = document.getElementById('botbooruCharFavoriteCount');
    if (countEl) countEl.textContent = formatNumber(state.count || 0);
    if (state.favorited) applyFavorited();
}

async function toggleBotbooruCharFavorite() {
    const post = bbSelectedPost;
    if (!post) return;
    if (!getSetting('botbooruToken')) {
        showToast('Login to Botbooru to add favorites', 'info');
        openBotbooruLoginModal();
        return;
    }

    const btn = document.getElementById('botbooruCharFavoriteBtn');
    if (!btn || btn.classList.contains('loading')) return;
    btn.classList.add('loading');

    const data = await toggleBotbooruFavorite(post.id);
    if (!data) {
        btn.classList.remove('loading');
        showToast('Failed to update favorite', 'error');
        return;
    }

    // The response is the authoritative new state; cache it on the post
    post._isFavorited = data.favorited;
    post.favorite_count = data.count;
    if (bbSelectedPost !== post) return;

    btn.classList.remove('loading');
    btn.classList.toggle('favorited', data.favorited);
    btn.querySelector('i').className = data.favorited ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    btn.title = data.favorited ? 'Remove from favorites on Botbooru' : 'Add to favorites on Botbooru';
    const countEl = document.getElementById('botbooruCharFavoriteCount');
    if (countEl) countEl.textContent = formatNumber(data.count || 0);
    showToast(data.favorited ? 'Added to Botbooru favorites!' : 'Removed from Botbooru favorites', data.favorited ? 'success' : 'info');
}

// ========================================
// IMPORT
// ========================================

async function downloadBotbooruCharacter() {
    if (!bbSelectedPost) return;

    const downloadBtn = document.getElementById('botbooruDownloadBtn');
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    downloadBtn.disabled = true;

    let inheritedGalleryId = null;

    try {
        const post = bbSelectedPost;
        const detail = bbSelectedDetail; // set by the preview fetch; may be null on failure
        const characterName = detail?.character_name || post.character_name || `botbooru_${post.id}`;

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: characterName,
            creator: getBotbooruWriterTag(detail || post) || detail?.uploader_name || '',
            fullPath: String(post.id),
            description: detail?.description || post.description_excerpt || '',
            first_mes: detail?.first_mes || '',
            personality: detail?.personality || '',
            scenario: detail?.scenario || ''
        });

        if (duplicateMatches.length > 0) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const result = await showPreImportDuplicateWarning({
                name: characterName,
                creator: '',
                fullPath: String(post.id),
                avatarUrl: post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (!deleteSuccess) {
                    console.warn('[BotbooruDownload] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';

        const provider = CoreAPI.getProvider('botbooru');
        if (!provider?.importCharacter) throw new Error('Botbooru provider not available');

        const result = await provider.importCharacter(String(post.id), post, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        const localAvatarFileName = result.fileName;
        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const hasGallery = !!result.hasGallery;
        const showSummary = (hasGallery || mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        const summaryArgs = {
            galleryCharacters: hasGallery ? [{
                name: result.characterName,
                fullPath: result.fullPath,
                provider: provider,
                linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                url: `${BOTBOORU_BASE}/character/${post.id}`,
                avatar: localAvatarFileName,
                galleryId: result.galleryId
            }] : [],
            mediaCharacters: (mediaUrls.length > 0 || galleryPageUrls.length > 0) ? [{
                name: result.characterName,
                avatar: localAvatarFileName,
                avatarUrl: result.avatarUrl,
                mediaUrls: mediaUrls,
                galleryPageUrls: galleryPageUrls,
                galleryId: result.galleryId,
                cardData: result.cardData
            }] : []
        };

        await finishBrowseImport({
            view,
            summaryArgs,
            showSummary,
            closePreview: closeBotbooruCharPreview,
            importBtn: downloadBtn,
            characterName: result.characterName,
            avatarFileName: localAvatarFileName,
            markImported: () => markBotbooruCardAsImported(post.id),
        });

    } catch (e) {
        console.error('[BotbooruDownload] Download error:', e);
        showToast('Import failed: ' + e.message, 'error');
    } finally {
        downloadBtn.innerHTML = originalHtml;
        downloadBtn.disabled = false;
    }
}

// ========================================
// WINDOW EXPORTS
// Functions called from library.js / the provider
// ========================================

window.openBotbooruCharPreview = openBotbooruCharPreview;

// ========================================
// SINGLETON EXPORT
// ========================================

const botbooruBrowseView = new BotbooruBrowseView();
export default botbooruBrowseView;
