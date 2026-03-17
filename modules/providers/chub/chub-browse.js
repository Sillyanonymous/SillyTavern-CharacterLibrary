// ChubBrowseView — ChubAI browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    CHUB_API_BASE,
    CHUB_GATEWAY_BASE,
    CHUB_AVATAR_BASE,
    getChubHeaders,
    extractNodes,
} from './chub-api.js';

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
    formatRichText,
    sanitizeTaglineHtml,
    renderLoadingState,
    getSetting,
    setSetting,
    setSettings,
    getCurrentView,
    debounce,
    getCharacterGalleryId,
    fetchCharacters,
    fetchAndAddCharacter,
    deleteCharacter,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    checkCharacterForDuplicates,
    showPreImportDuplicateWarning,
    showImportSummaryModal,
    getAllCharacters
} = CoreAPI;
/* eslint-enable no-unused-vars */

const CHUB_TOKEN_KEY = 'st_gallery_chub_urql_token'; // Legacy localStorage key for token migration

const BROWSE_PURIFY_CONFIG = {
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

// ========================================
// STATE & HELPERS
// ========================================


let chubCharacters = [];
let chubCurrentPage = 1;
let chubHasMore = true;
let chubIsLoading = false;
let chubDiscoveryPreset = 'popular_week'; // Combined sort + time preset
let chubNsfwEnabled = true; // Default to NSFW enabled
let chubCurrentSearch = '';
let chubSelectedChar = null;
let chubToken = null; // URQL_TOKEN from chub.ai localStorage for Authorization Bearer

// Discovery preset definitions (sort + time combinations)
const CHUB_DISCOVERY_PRESETS = {
    'popular_week':  { sort: 'download_count', days: 7 },
    'popular_month': { sort: 'download_count', days: 30 },
    'popular_all':   { sort: 'download_count', days: 0 },
    'rated_week':    { sort: 'star_count', days: 7 },
    'rated_all':     { sort: 'star_count', days: 0 },
    'newest':        { sort: 'id', days: 30 }, // Last 30 days of new chars (id = creation order)
    'updated':       { sort: 'last_activity_at', days: 0 }, // Recently updated characters
    'recent_hits':   { sort: 'default', days: 0, special_mode: 'newcomer' }, // Recent hits - new characters getting lots of activity
    'random':        { sort: 'random', days: 0 }
};

// Additional ChubAI filters
let chubFilterImages = false;
let chubFilterLore = false;
let chubFilterExpressions = false;
let chubFilterGreetings = false;
let chubFilterFavorites = false;
let chubFilterHideOwned = false;

// Advanced ChubAI filters (Tags dropdown)
let chubTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>
let chubSortAscending = false; // false = descending (default), true = ascending
let chubMinTokens = 50; // Minimum tokens (API default)
let chubMaxTokens = 100000; // Maximum tokens

// ChubAI View mode and author filter
let chubViewMode = 'browse'; // 'browse' or 'timeline'
let chubAuthorFilter = null; // Username to filter by
let chubAuthorSort = 'id'; // Sort for author view (id = newest)
let chubTimelineCharacters = [];
let chubTimelinePage = 1;
let chubTimelineCursor = null; // Cursor for pagination
let chubTimelineHasMore = true;
let chubTimelineAuthorPage = 1;      // Per-author supplemental page (increments on Load More)
let chubTimelineAuthorHasMore = false; // True if any author returned a full page of results
let chubTimelineSort = 'newest'; // Sort for timeline view (client-side)
let chubUserFavoriteIds = new Set(); // Cache of user's favorited character IDs
let chubTimelineRenderToken = 0; // Cancels in-flight chunked timeline renders
let chubTimelineLoadInFlight = false;
let chubCardLookup = new Map();
let chubTimelineLookup = new Map();
let chubDelegatesInitialized = false;
let chubModalEventsAttached = false;
let chubDetailFetchController = null; // AbortController for in-flight detail fetches
let _chubDropdownCloseHandler = null;
const chubDetailCache = new Map();
const CHUB_DETAIL_CACHE_MAX = 5; // LRU cap — keep small for mobile memory (stripped entries only)

// Append-only rendering: track how many cards are already in DOM to avoid full re-render on Load More
let chubGridRenderedCount = 0;

// IntersectionObserver for lazy-loading chub card images
let chubImageObserver = null;

// Local library lookup for marking characters as "In Library"
let localLibraryLookup = {
    byNameAndCreator: new Set(), // "name|creator" combos
    byChubPath: new Set()        // ChubAI fullPath if stored
};

// Build local library lookup from allCharacters
function buildLocalLibraryLookup() {
    localLibraryLookup.byNameAndCreator.clear();
    localLibraryLookup.byChubPath.clear();
    
    for (const char of getAllCharacters()) {
        if (!char) continue;
        
        const name = (char.name || '').toLowerCase().trim();
        const creator = (char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) {
            localLibraryLookup.byNameAndCreator.add(`${name}|${creator}`);
        }
        
        // Check for ChubAI source in extensions data
        const chubData = char.data?.extensions?.chub;
        const chubPath = chubData?.fullPath || chubData?.full_path || '';
        const chubUrl = chubData?.url || char.chub_url || char.source_url || '';
        
        // Direct fullPath from our link feature
        if (chubPath) {
            localLibraryLookup.byChubPath.add(chubPath.toLowerCase());
        }
        
        // Also check URL-based sources
        if (chubUrl) {
            // Extract path from URL like "https://chub.ai/characters/username/slug"
            const match = chubUrl.match(/characters\/([^\/]+\/[^\/\?]+)/);
            if (match) {
                localLibraryLookup.byChubPath.add(match[1].toLowerCase());
            } else if (chubUrl.includes('/')) {
                // Might be just "username/slug"
                localLibraryLookup.byChubPath.add(chubUrl.toLowerCase());
            }
        }
    }
    
    debugLog('[LocalLibrary] Built lookup:', 
        'nameCreators:', localLibraryLookup.byNameAndCreator.size,
        'chubPaths:', localLibraryLookup.byChubPath.size);
}

function isCharInLocalLibrary(chubChar) {
    const fullPath = (chubChar.fullPath || chubChar.full_path || '').toLowerCase();
    const name = (chubChar.name || '').toLowerCase().trim();
    const creator = fullPath.split('/')[0] || '';
    
    // Best match: exact ChubAI path
    if (fullPath && localLibraryLookup.byChubPath.has(fullPath)) {
        return true;
    }
    
    // Good match: name + creator combo
    if (name && creator && localLibraryLookup.byNameAndCreator.has(`${name}|${creator}`)) {
        return true;
    }
    
    return false;
}

function markChubCardAsImported(fullPath) {
    const grid = document.getElementById('chubGrid');
    if (!grid || !fullPath) return;
    const card = grid.querySelector(`[data-full-path="${CSS.escape(fullPath)}"]`);
    if (!card) return;
    card.classList.add('in-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        const imgWrap = card.querySelector('.browse-card-image');
        if (imgWrap) {
            imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = imgWrap.querySelector('.browse-feature-badges');
        }
    }
    if (badgesEl && !badgesEl.querySelector('.in-library')) {
        badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
}

function getChubFullPath(char) {
    return char.fullPath || char.full_path || '';
}

function buildChubLookup(targetMap, characters) {
    targetMap.clear();
    for (const char of characters) {
        const path = getChubFullPath(char);
        if (path) targetMap.set(path, char);
    }
}

// Dynamic tags - populated from ChubAI API
let chubPopularTags = [];
let chubTagsLoading = false;
let chubTagsLoaded = false;

class ChubBrowseView extends BrowseView {

    get previewModalId() { return 'chubCharModal'; }

    closePreview() {
        abortChubDetailFetch();
        cleanupChubCharModal();
        hideModal('chubCharModal');
    }

    get mobileFilterIds() {
        return {
            sort: 'chubDiscoveryPreset',
            tags: 'chubTagsBtn',
            filters: 'chubFiltersBtn',
            nsfw: 'chubNsfwToggle',
            refresh: 'refreshChubBtn',
            timelineSort: 'chubTimelineSortHeader',
            modeBrowseSelector: '.chub-view-btn[data-chub-view="browse"]',
            modeFollowSelector: '.chub-view-btn[data-chub-view="timeline"]',
            modeBtnClass: 'chub-view-btn',
        };
    }

    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular_week', label: 'Hot This Week' },
                { value: 'popular_month', label: 'Hot This Month' },
                { value: 'popular_all', label: 'Most Downloaded' },
                { value: 'rated_week', label: 'Top Rated (Week)' },
                { value: 'rated_all', label: 'Top Rated (All Time)' },
                { value: 'newest', label: 'Newest' },
                { value: 'updated', label: 'Recently Updated' },
                { value: 'recent_hits', label: 'Recent Hits' },
                { value: 'random', label: 'Random' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest Created' },
                { value: 'updated', label: 'Recently Updated' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'downloads', label: 'Most Downloads' },
                { value: 'favorites', label: 'Most Favorites' },
                { value: 'rating', label: 'Top Rated' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'timeline', label: 'Following' },
            ],
        };
    }

    canLoadMore() {
        if (chubViewMode === 'browse') return chubHasMore && !chubIsLoading;
        if (chubViewMode === 'timeline') return (chubTimelineHasMore || chubTimelineAuthorHasMore) && !chubTimelineLoadInFlight;
        return false;
    }

    async loadMore() {
        if (chubViewMode === 'browse') {
            chubCurrentPage++;
            loadChubCharacters();
        } else if (chubViewMode === 'timeline') {
            chubTimelineLoadInFlight = true;
            try {
                if (chubTimelineCursor) {
                    chubTimelinePage++;
                    await loadChubTimeline(false);
                } else if (chubTimelineAuthorHasMore) {
                    chubTimelineAuthorPage++;
                    await supplementTimelineWithAuthorFetches(chubTimelineAuthorPage);
                    renderChubTimeline();
                    chubBrowseView.updateLoadMoreVisibility('chubTimelineLoadMore', chubTimelineAuthorHasMore, true);
                }
            } finally {
                chubTimelineLoadInFlight = false;
            }
        }
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Discovery Mode Toggle -->
            <div class="chub-view-toggle">
                <button class="chub-view-btn active" data-chub-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="chub-view-btn" data-chub-view="timeline" title="New from followed authors (requires token)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort dropdown container -->
            <div class="browse-sort-container">
                <!-- Discovery Preset (Browse mode) -->
                <select id="chubDiscoveryPreset" class="glass-select" title="Discovery mode">
                    <optgroup label="Popular">
                        <option value="popular_week" selected>🔥 Hot This Week</option>
                        <option value="popular_month">📈 Hot This Month</option>
                        <option value="popular_all">👑 Most Downloaded</option>
                    </optgroup>
                    <optgroup label="Quality">
                        <option value="rated_week">⭐ Top Rated (Week)</option>
                        <option value="rated_all">⭐ Top Rated (All Time)</option>
                    </optgroup>
                    <optgroup label="Discovery">
                        <option value="newest">🆕 Newest</option>
                        <option value="updated">🔄 Recently Updated</option>
                        <option value="recent_hits">🌟 Recent Hits</option>
                        <option value="random">🎲 Random</option>
                    </optgroup>
                </select>

                <!-- Timeline Sort (Following mode) -->
                <select id="chubTimelineSortHeader" class="glass-select browse-filter-hidden" title="Sort timeline">
                    <option value="newest">🆕 Newest Created</option>
                    <option value="updated">🔄 Recently Updated</option>
                    <option value="oldest">🕐 Oldest First</option>
                    <option value="name_asc">📝 Name A-Z</option>
                    <option value="name_desc">📝 Name Z-A</option>
                    <option value="downloads">📥 Most Downloads</option>
                    <option value="favorites">❤️ Most Favorites</option>
                    <option value="rating">⭐ Top Rated</option>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="chubTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="chubTagsBtnLabel">Tags</span>
                </button>
                <div id="chubTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="chubTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="chubTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="chubTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr id="chubAdvancedDivider" style="margin: 10px 0; border-color: var(--glass-border);">
                    <div id="chubAdvancedOptions">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-arrow-down-wide-short"></i> Sort Direction</label>
                        <select id="chubSortDirection" class="glass-select-small">
                            <option value="desc" selected data-icon="fa-solid fa-arrow-down-wide-short">Descending</option>
                            <option value="asc" data-icon="fa-solid fa-arrow-up-short-wide">Ascending</option>
                        </select>
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="chubMinTokens" class="glass-input-small" value="50" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="chubMaxTokens" class="glass-input-small" value="100000" min="0" max="500000" step="1000">
                    </div>
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="chubFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="chubFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterImages"> <i class="fa-solid fa-images"></i> Image Gallery</label>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterLore"> <i class="fa-solid fa-book"></i> Lorebook</label>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterExpressions"> <i class="fa-solid fa-face-smile"></i> Expressions</label>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterGreetings"> <i class="fa-solid fa-comments"></i> Alt Greetings</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Personal <span style="font-size: 0.8em; opacity: 0.6;">(requires login)</span>:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterFavorites"> <i class="fa-solid fa-heart" style="color: #e74c3c;"></i> My Favorites</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="chubFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                </div>
            </div>

            <!-- Content Toggles -->
            <button id="chubNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshChubBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="chubBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="chubSearchInput" placeholder="Search ChubAI characters..." autocomplete="one-time-code">
                        <button id="chubClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="chubSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="chubCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
                            <button id="chubCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Author Filter Banner -->
                <div id="chubAuthorBanner" class="chub-author-banner hidden">
                    <div class="chub-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="chubAuthorBannerName">Author</strong></span>
                    </div>
                    <div class="chub-author-banner-actions">
                        <select id="chubAuthorSortSelect" class="glass-select" title="Sort author's characters">
                            <option value="id" selected>🆕 Newest Created</option>
                            <option value="last_activity_at">🔄 Recently Updated</option>
                            <option value="download_count">📥 Most Downloaded</option>
                            <option value="star_count">⭐ Top Rated</option>
                        </select>
                        <button id="chubFollowAuthorBtn" class="glass-btn" title="Follow this author on ChubAI">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="chubClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="chubGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="chubLoadMore" style="display: none;">
                    <button id="chubLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Timeline Section -->
            <div id="chubTimelineSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from authors you follow</p>
                    </div>
                </div>
                <div id="chubTimelineGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="chubTimelineLoadMore" style="display: none;">
                    <button id="chubTimelineLoadMoreBtn" class="glass-btn">
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
    <div id="chubLoginModal" class="modal-overlay hidden">
        <div class="modal-glass chub-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> ChubAI Authentication</h2>
                <button class="close-btn" id="chubLoginClose">&times;</button>
            </div>
            <div class="chub-login-body">
                <p class="chub-login-info">
                    <i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i>
                    <strong>Browsing and downloading public characters works without a token!</strong>
                </p>
                <p class="chub-login-info">
                    <i class="fa-solid fa-key" style="color: var(--accent);"></i>
                    <strong>Optional:</strong> Add your URQL_TOKEN to access your favorites and restricted content.
                </p>

                <div class="chub-login-form">
                    <div class="form-group">
                        <label for="chubApiKeyInput">URQL_TOKEN</label>
                        <input type="password" id="chubApiKeyInput" class="glass-input" placeholder="Paste your URQL_TOKEN here..." autocomplete="new-password">
                    </div>
                    <label class="checkbox-label" style="margin-top: 10px;">
                        <input type="checkbox" id="chubRememberKey" checked> Remember token
                    </label>
                    <div class="chub-login-status" style="display:none;"></div>
                </div>

                <details style="margin-top: 15px; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px;">
                    <summary style="cursor: pointer; color: var(--accent);">
                        <i class="fa-solid fa-question-circle"></i> How to get your URQL_TOKEN
                    </summary>
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--glass-border); font-size: 0.9rem; color: var(--text-secondary);">
                        <ol style="margin: 0; padding-left: 20px; line-height: 1.8;">
                            <li>Go to <a href="https://chub.ai" target="_blank" style="color: var(--accent);">chub.ai</a> and log in</li>
                            <li>Open your browser's Developer Tools (F12)</li>
                            <li>Go to the <strong>Application</strong> tab (or Storage in Firefox)</li>
                            <li>In the left sidebar, expand <strong>Local Storage</strong></li>
                            <li>Click on <code>https://chub.ai</code></li>
                            <li>Find the key <code style="color: #e74c3c; font-weight: bold;">URQL_TOKEN</code> and copy its value</li>
                        </ol>
                        <p style="margin-top: 10px; font-style: italic;">
                            The token is a long string that authenticates you with ChubAI's API.
                        </p>
                    </div>
                </details>

                <div class="chub-login-actions">
                    <button id="chubSaveKeyBtn" class="action-btn primary">
                        <i class="fa-solid fa-save"></i> Save Token
                    </button>
                    <button id="chubClearKeyBtn" class="action-btn secondary" style="display:none;">
                        <i class="fa-solid fa-trash"></i> Clear Token
                    </button>
                    <a href="https://chub.ai" target="_blank" class="action-btn secondary">
                        <i class="fa-solid fa-external-link"></i> ChubAI Website
                    </a>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="chubCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="chubCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="chubCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="chubCharCreator" href="#" title="Click to see all characters by this author">Creator</a>
                            <a id="chubCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open author's ChubAI profile"><i class="fa-solid fa-external-link"></i></a> •
                            <span id="chubCharRating" title="Rating"><i class="fa-solid fa-star"></i> 0</span> •
                            <span id="chubCharDownloads" title="Downloads"><i class="fa-solid fa-download"></i> 0</span> •
                            <span id="chubCharFavoriteBtn" class="chub-favorite-btn-inline" title="Add to favorites on ChubAI"><i class="fa-regular fa-heart"></i> <span id="chubCharFavoriteCount">0</span></span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="chubOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on ChubAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="chubDownloadBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="chubCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="chubCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="chubCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="chubCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="chubCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="chubCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="chubCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="chubCharLorebookStat" style="display: none;">
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                        <div class="browse-stat" id="chubCharGalleryStat" style="display: none;">
                            <i class="fa-solid fa-images"></i>
                            <span id="chubCharGalleryCount">0</span> gallery
                        </div>
                    </div>
                    <div class="browse-char-tags" id="chubCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="chubCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="chubCharCreatorNotes" class="scrolling-text">
                        No description available.
                    </div>
                </div>

                <!-- Definition loading indicator -->
                <div id="chubCharDefinitionLoading" class="browse-char-section" style="display: none;">
                    <div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="chubCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="chubCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="chubCharPersonalitySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="chubCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="chubCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="chubCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="chubCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="chubCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="chubCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="chubCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="chubCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="chubCharAltGreetingsCount"></span>
                    </h3>
                    <div id="chubCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="chubCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="chubCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="chubCharGalleryLabel"></span>
                    </h3>
                    <div id="chubCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    init() {
        super.init();
        initChubView();
    }

    applyDefaults(defaults) {
        if (defaults.view === 'timeline') {
            chubViewMode = 'timeline';
            document.querySelectorAll('.chub-view-btn').forEach(btn =>
                btn.classList.toggle('active', btn.dataset.chubView === 'timeline')
            );
            const browseSection = document.getElementById('chubBrowseSection');
            const timelineSection = document.getElementById('chubTimelineSection');
            browseSection?.classList.add('hidden');
            timelineSection?.classList.remove('hidden');
            const dp = document.getElementById('chubDiscoveryPreset');
            const ts = document.getElementById('chubTimelineSortHeader');
            const dpTarget = dp?._customSelect?.container || dp;
            const tsTarget = ts?._customSelect?.container || ts;
            if (dpTarget) dpTarget.classList.add('browse-filter-hidden');
            if (tsTarget) tsTarget.classList.remove('browse-filter-hidden');
            const tagsContainer = document.querySelector('.browse-tags-dropdown-container');
            if (tagsContainer) tagsContainer.classList.add('browse-filter-hidden');
        }
        if (defaults.sort) {
            if (chubViewMode === 'browse') {
                chubDiscoveryPreset = defaults.sort;
                const el = document.getElementById('chubDiscoveryPreset');
                if (el) el.value = defaults.sort;
            } else {
                chubTimelineSort = defaults.sort;
                const el = document.getElementById('chubTimelineSortHeader');
                if (el) el.value = defaults.sort;
            }
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            chubCurrentSearch = '';
            chubAuthorFilter = null;
            chubCharacters = [];
            chubTimelineCharacters = [];
            chubCurrentPage = 1;
            chubHasMore = true;
            chubTimelinePage = 1;
        }
        super.activate(container, options);
        chubDelegatesInitialized = true;

        // Re-register dropdown close handler after deactivate removed it
        if (!_chubDropdownCloseHandler) {
            initChubDropdownDismiss();
        }

        // Ensure grid is populated — covers fresh init, provider switch, and tab re-entry
        buildLocalLibraryLookup();
        const browseGrid = document.getElementById('chubGrid');
        const timelineGrid = document.getElementById('chubTimelineGrid');

        if (chubCharacters.length === 0 && chubTimelineCharacters.length === 0) {
            if (chubViewMode === 'browse') {
                loadChubCharacters();
            } else {
                loadChubTimeline();
            }
        } else if (chubViewMode === 'browse' && browseGrid && browseGrid.children.length === 0 && chubCharacters.length > 0) {
            chubGridRenderedCount = 0;
            renderChubGrid();
        } else if (chubViewMode === 'timeline' && timelineGrid && timelineGrid.children.length === 0 && chubTimelineCharacters.length > 0) {
            renderChubTimeline();
        } else {
            reconnectBrowseImageObserver();
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    rebuildLocalLibraryLookup() {
        buildLocalLibraryLookup();
    }

    refreshInLibraryBadges() {
        for (const grid of [document.getElementById('chubGrid'), document.getElementById('chubTimelineGrid')]) {
            if (!grid) continue;
            for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
                const fullPath = card.dataset.fullPath;
                const name = card.querySelector('.browse-card-name')?.textContent || '';
                if (!isCharInLocalLibrary({ fullPath, name })) continue;
                card.classList.add('in-library');
                let badgesEl = card.querySelector('.browse-feature-badges');
                if (!badgesEl) {
                    const imgWrap = card.querySelector('.browse-card-image');
                    if (imgWrap) {
                        imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                        badgesEl = imgWrap.querySelector('.browse-feature-badges');
                    }
                }
                if (badgesEl && !badgesEl.querySelector('.in-library')) {
                    badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
                }
            }
        }
    }

    deactivate() {
        super.deactivate();
        chubDelegatesInitialized = false;
        // Increment render token to cancel in-flight chunked renders
        chubTimelineRenderToken++;
        if (chubImageObserver) chubImageObserver.disconnect();
        // Abort any in-flight detail fetch
        if (chubDetailFetchController) {
            try { chubDetailFetchController.abort(); } catch (e) { /* ignore */ }
            chubDetailFetchController = null;
        }
        if (_chubDropdownCloseHandler) {
            document.removeEventListener('click', _chubDropdownCloseHandler);
            _chubDropdownCloseHandler = null;
        }
    }

    closeDropdowns() {
        document.getElementById('chubTagsDropdown')?.classList.add('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.add('hidden');
    }

    // ── Image Observer (BrowseView contract) ────────────────

    disconnectImageObserver() {
        if (chubImageObserver) chubImageObserver.disconnect();
    }

    reconnectImageObserver() {
        reconnectBrowseImageObserver();
    }
}

// ========================================
// CHUB BROWSE LOGIC (moved from library.js)
// ========================================

function initChubDropdownDismiss() {
    if (_chubDropdownCloseHandler) document.removeEventListener('click', _chubDropdownCloseHandler);
    _chubDropdownCloseHandler = (e) => {
        const filtersDropdown = document.getElementById('chubFiltersDropdown');
        const filtersBtn = document.getElementById('chubFiltersBtn');
        if (filtersDropdown && !filtersDropdown.contains(e.target) && e.target !== filtersBtn) {
            filtersDropdown.classList.add('hidden');
        }
        const tagsDropdown = document.getElementById('chubTagsDropdown');
        const tagsBtn = document.getElementById('chubTagsBtn');
        if (tagsDropdown && !tagsDropdown.contains(e.target) && e.target !== tagsBtn && !tagsBtn?.contains(e.target)) {
            tagsDropdown.classList.add('hidden');
        }
    };
    document.addEventListener('click', _chubDropdownCloseHandler);
}

function initChubView() {
    // Sync dropdown values with JS state (browser may cache old form values)
    const discoveryPresetEl = document.getElementById('chubDiscoveryPreset');
    const timelineSortEl = document.getElementById('chubTimelineSortHeader');
    const authorSortEl = document.getElementById('chubAuthorSortSelect');
    const sortDirectionEl = document.getElementById('chubSortDirection');
    
    if (discoveryPresetEl) discoveryPresetEl.value = chubDiscoveryPreset;
    if (timelineSortEl) timelineSortEl.value = chubTimelineSort;
    if (authorSortEl) authorSortEl.value = chubAuthorSort;
    
    for (const el of [discoveryPresetEl, timelineSortEl, authorSortEl, sortDirectionEl]) {
        if (!el) continue;
        const wasHidden = el.classList.contains('browse-filter-hidden');
        CoreAPI.initCustomSelect?.(el);
        // Transfer visibility class to the custom-select container
        if (wasHidden && el._customSelect?.container) {
            el._customSelect.container.classList.add('browse-filter-hidden');
        }
    }
    
    // Also sync NSFW toggle state
    updateNsfwToggleState();

    setupChubGridDelegates();
    
    // View mode toggle (Browse/Timeline)
    document.querySelectorAll('.chub-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.chubView;
            if (newMode === chubViewMode) return;
            
            // Timeline requires token
            if (newMode === 'timeline' && !chubToken) {
                showToast('URQL token required for Timeline. Click the key icon to add your ChubAI token.', 'warning');
                openChubTokenModal();
                return;
            }
            
            switchChubViewMode(newMode);
        });
    });
    
    // Author filter clear button
    on('chubClearAuthorBtn', 'click', () => {
        clearAuthorFilter();
    });
    
    // Follow author button
    on('chubFollowAuthorBtn', 'click', () => {
        toggleFollowAuthor();
    });
    
    // Timeline load more button
    on('chubTimelineLoadMoreBtn', 'click', async () => {
        if (chubTimelineLoadInFlight) return;
        chubTimelineLoadInFlight = true;
        const loadMoreBtn = document.getElementById('chubTimelineLoadMoreBtn');
        const originalLoadMoreHtml = loadMoreBtn ? loadMoreBtn.innerHTML : '';
        if (loadMoreBtn) {
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
        }

        const prevCount = document.querySelectorAll('#chubTimelineGrid .browse-card').length;

        try {
            if (chubTimelineCursor) {
                // Timeline API still has pages
                chubTimelinePage++;
                await loadChubTimeline(false);
            } else if (chubTimelineAuthorHasMore) {
                // Timeline cursor exhausted, but authors have more characters
                chubTimelineAuthorPage++;
                const loadMoreContainer = document.getElementById('chubTimelineLoadMore');
                await supplementTimelineWithAuthorFetches(chubTimelineAuthorPage);
                renderChubTimeline();
                chubBrowseView.updateLoadMoreVisibility('chubTimelineLoadMore', chubTimelineAuthorHasMore, true);
            }
            
            // Scroll to the first new card so the user doesn't lose their place
            requestAnimationFrame(() => {
                const cards = document.querySelectorAll('#chubTimelineGrid .browse-card');
                if (prevCount > 0 && cards.length > prevCount) {
                    cards[prevCount].scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        } finally {
            chubTimelineLoadInFlight = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = originalLoadMoreHtml || '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    });
    
    // Search handlers
    on('chubSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubSearch();
        }
    });
    
    // Show/hide clear button based on input content
    on('chubSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('chubClearSearchBtn');
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !e.target.value.trim());
        }
    });
    
    on('chubSearchBtn', 'click', () => performChubSearch());
    
    on('chubClearSearchBtn', 'click', () => {
        const input = document.getElementById('chubSearchInput');
        if (input) {
            input.value = '';
            input.focus();
        }
        document.getElementById('chubClearSearchBtn')?.classList.add('hidden');
        // Perform search (will show default results)
        performChubSearch();
    });
    
    // Creator search handlers
    on('chubCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubCreatorSearch();
        }
    });
    
    on('chubCreatorSearchBtn', 'click', () => performChubCreatorSearch());
    
    // Discovery preset select (combined sort + time)
    on('chubDiscoveryPreset', 'change', (e) => {
        chubDiscoveryPreset = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    });
    
    // More filters dropdown toggle
    on('chubFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        document.getElementById('chubTagsDropdown')?.classList.add('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.toggle('hidden');
    });
    
    // Filter checkboxes - with getter for syncing
    const filterCheckboxes = [
        { id: 'chubFilterImages', setter: (v) => chubFilterImages = v, getter: () => chubFilterImages },
        { id: 'chubFilterLore', setter: (v) => chubFilterLore = v, getter: () => chubFilterLore },
        { id: 'chubFilterExpressions', setter: (v) => chubFilterExpressions = v, getter: () => chubFilterExpressions },
        { id: 'chubFilterGreetings', setter: (v) => chubFilterGreetings = v, getter: () => chubFilterGreetings },
        { id: 'chubFilterFavorites', setter: (v) => chubFilterFavorites = v, getter: () => chubFilterFavorites },
        { id: 'chubFilterHideOwned', setter: (v) => chubFilterHideOwned = v, getter: () => chubFilterHideOwned }
    ];
    
    // Sync checkbox states with JS variables (browser may cache old form values)
    filterCheckboxes.forEach(({ id, getter }) => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = getter();
    });
    updateChubFiltersButtonState();
    
    filterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', async (e) => {
            // Special handling for favorites - requires token
            if (id === 'chubFilterFavorites' && e.target.checked && !chubToken) {
                e.target.checked = false;
                showToast('URQL token required for favorites. Click the key icon to add your ChubAI token.', 'warning');
                show('chubLoginModal');
                return;
            }
            setter(e.target.checked);
            debugLog(`Filter ${id} set to:`, e.target.checked);
            updateChubFiltersButtonState();
            
            // For timeline mode with favorites filter, fetch favorite IDs first
            if (chubViewMode === 'timeline') {
                if (id === 'chubFilterFavorites' && e.target.checked) {
                    await fetchChubUserFavoriteIds();
                }
                renderChubTimeline();
            } else {
                // For browse mode, always reload from API when changing filters
                // This ensures we get fresh data and don't mix old results
                chubCharacters = [];
                chubCurrentPage = 1;
                loadChubCharacters();
            }
        });
    });
    
    // === Tags Dropdown Handlers ===
    initChubTagsDropdown();
    
    // NSFW toggle - single button toggle
    on('chubNsfwToggle', 'click', () => {
        chubNsfwEnabled = !chubNsfwEnabled;
        updateNsfwToggleState();
        
        // Refresh the appropriate view based on current mode
        if (chubViewMode === 'timeline') {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
            chubTimelineAuthorPage = 1;
            chubTimelineAuthorHasMore = false;
            loadChubTimeline(true);
        } else {
            chubCharacters = [];
            chubCurrentPage = 1;
            loadChubCharacters();
        }
    });
    
    // Refresh button - works for both Browse and Timeline modes
    on('refreshChubBtn', 'click', () => {
        if (chubViewMode === 'timeline') {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
            chubTimelineAuthorPage = 1;
            chubTimelineAuthorHasMore = false;
            loadChubTimeline(true);
        } else {
            chubCharacters = [];
            chubCurrentPage = 1;
            loadChubCharacters(true);
        }
    });
    
    // Load more button (guard against rapid clicks — don't increment page while loading)
    on('chubLoadMoreBtn', 'click', () => {
        if (chubIsLoading) return;
        chubCurrentPage++;
        loadChubCharacters();
    });
    
    // Timeline sort dropdown (header only)
    on('chubTimelineSortHeader', 'change', (e) => {
        chubTimelineSort = e.target.value;
        debugLog('[ChubTimeline] Sort changed to:', chubTimelineSort);
        renderChubTimeline();
    });
    
    // Author sort dropdown
    on('chubAuthorSortSelect', 'change', (e) => {
        chubAuthorSort = e.target.value;
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters(); // Reload with new sort (server-side sorting)
    });
    
    // Modal and document-level listeners — only attach once since these elements
    // persist in document.body across provider switches (DOM recreation)
    if (!chubModalEventsAttached) {
        chubModalEventsAttached = true;

        on('chubCharFavoriteBtn', 'click', toggleChubCharFavorite);

        // Avatar click → full-size image viewer (desktop only; mobile has its own handler)
        const chubAvatar = document.getElementById('chubCharAvatar');
        if (chubAvatar && !window.matchMedia('(max-width: 768px)').matches) {
            chubAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!chubAvatar.src) return;
                const fullSrc = chubAvatar.src.replace(/\/avatar\.webp$/, '/chara_card_v2.png');
                BrowseView.openAvatarViewer(fullSrc, chubAvatar.src);
            });
        }

        on('chubCharClose', 'click', () => {
            abortChubDetailFetch();
            cleanupChubCharModal();
            hideModal('chubCharModal');
        });
        on('chubDownloadBtn', 'click', () => downloadChubCharacter());

        const chubGalleryGrid = document.getElementById('chubCharGalleryGrid');
        if (chubGalleryGrid) {
            chubGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...chubGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        on('chubCharModal', 'click', (e) => {
            if (e.target.id === 'chubCharModal') {
                abortChubDetailFetch();
                cleanupChubCharModal();
                hideModal('chubCharModal');
            }
        });

        on('chubLoginClose', 'click', () => hideModal('chubLoginModal'));
        on('chubLoginModal', 'click', (e) => {
            if (e.target.id === 'chubLoginModal') {
                hideModal('chubLoginModal');
            }
        });
        on('chubSaveKeyBtn', 'click', saveChubToken);
        on('chubClearKeyBtn', 'click', clearChubToken);
    }

    initChubDropdownDismiss();
    
    // Load saved token on init
    loadChubToken();
    
    // Initialize NSFW toggle state (defaults to enabled)
    updateNsfwToggleState();
    
    // Start fetching popular tags in the background
    if (!chubTagsLoaded && !chubTagsLoading) {
        fetchChubPopularTags();
    }
    
    debugLog('ChubAI view initialized');
}

// ============================================================================
// CHUB TOKEN MANAGEMENT (URQL_TOKEN)
// Uses the gallery settings system for persistent storage
// ============================================================================

function loadChubToken() {
    // Gallery settings are already loaded by DOMContentLoaded init
    
    // Get token from settings (server-side persistent)
    const savedToken = getSetting('chubToken');
    if (savedToken) {
        chubToken = savedToken;
        debugLog('[ChubToken] Loaded from gallery settings');
        
        // Populate input field if it exists
        const tokenInput = document.getElementById('chubApiKeyInput');
        if (tokenInput) tokenInput.value = savedToken;
        
        const rememberCheckbox = document.getElementById('chubRememberKey');
        if (rememberCheckbox) rememberCheckbox.checked = true;
        
        return;
    }
    
    // Migration: Check old localStorage key and migrate to new system
    try {
        const oldToken = localStorage.getItem(CHUB_TOKEN_KEY);
        if (oldToken) {
            debugLog('[ChubToken] Migrating from localStorage to settings system');
            chubToken = oldToken;
            setSetting('chubToken', oldToken);
            setSetting('chubRememberToken', true);
            // Remove old key after migration
            localStorage.removeItem(CHUB_TOKEN_KEY);
        }
    } catch (e) {
        console.warn('[ChubToken] Migration check failed:', e);
    }
}

function saveChubToken() {
    const tokenInput = document.getElementById('chubApiKeyInput');
    const rememberCheckbox = document.getElementById('chubRememberKey');
    
    if (!tokenInput) return;
    
    const token = tokenInput.value.trim();
    if (!token) {
        alert('Please enter your URQL token');
        return;
    }
    
    chubToken = token;
    
    // Always save to persistent settings (server-side via ST extensionSettings)
    setSettings({
        chubToken: token,
        chubRememberToken: rememberCheckbox?.checked ?? true
    });
    debugLog('[ChubToken] Saved to gallery settings (persistent)');
    
    // Close modal
    const modal = document.getElementById('chubLoginModal');
    if (modal) modal.classList.add('hidden');
    
    showToast('Token saved! Your token is now stored persistently.', 'success');
    
    // Refresh if we have filters that need the token
    if (chubFilterFavorites) {
        loadChubCharacters();
    }
}

function clearChubToken() {
    chubToken = null;
    
    setSettings({
        chubToken: null,
        chubRememberToken: false
    });
    debugLog('[ChubToken] Cleared from gallery settings');
    
    // Also clear old localStorage key if it exists
    try {
        localStorage.removeItem(CHUB_TOKEN_KEY);
    } catch (e) {
        // Ignore
    }
    
    const tokenInput = document.getElementById('chubApiKeyInput');
    if (tokenInput) tokenInput.value = '';
    
    const rememberCheckbox = document.getElementById('chubRememberKey');
    if (rememberCheckbox) rememberCheckbox.checked = false;
    
    if (chubFilterFavorites) {
        chubFilterFavorites = false;
        const favCheckbox = document.getElementById('chubFilterFavorites');
        if (favCheckbox) favCheckbox.checked = false;
        updateChubFiltersButtonState();
    }
    
    showToast('Token cleared', 'info');
}

export function openChubTokenModal() {
    const modal = document.getElementById('chubLoginModal');
    if (!modal) return;
    
    // Pre-fill input if token exists
    const tokenInput = document.getElementById('chubApiKeyInput');
    const clearBtn = document.getElementById('chubClearKeyBtn');
    
    if (tokenInput && chubToken) {
        tokenInput.value = chubToken;
    }
    
    // Show/hide clear button based on whether token exists
    if (clearBtn) {
        clearBtn.style.display = chubToken ? '' : 'none';
    }
    
    // Sync remember checkbox from saved setting
    const rememberCheckbox = document.getElementById('chubRememberKey');
    if (rememberCheckbox) rememberCheckbox.checked = getSetting('chubRememberToken') ?? true;
    
    // Use classList.remove('hidden') to match how the modal is closed
    modal.classList.remove('hidden');
    
    // Fetch popular tags from ChubAI if not already loaded
    if (!chubTagsLoaded && !chubTagsLoading) {
        fetchChubPopularTags();
    }
}

/**
 * Fetch popular tags from ChubAI API by aggregating tags from top characters
 * Uses multiple requests to get a diverse set of tags from different character rankings
 */
async function fetchChubPopularTags() {
    if (chubTagsLoading || chubTagsLoaded) return;
    
    chubTagsLoading = true;
    
    try {
        const headers = getChubHeaders(true);
        const PAGES_PER_SORT = 2;
        
        // Fetch all sort orders in parallel; pages within each are sequential
        const sortOrders = ['download_count', 'id', 'rating', 'default'];
        const results = await Promise.all(sortOrders.map(async (sortOrder) => {
            const chars = [];
            for (let page = 1; page <= PAGES_PER_SORT; page++) {
                try {
                    const params = new URLSearchParams({
                        search: '',
                        first: '200',
                        page: page.toString(),
                        sort: sortOrder,
                        nsfw: 'true',
                        nsfl: 'true',
                        include_forks: 'false',
                        min_tokens: '50'
                    });
                    
                    const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                        method: 'GET',
                        headers
                    });
                    
                    if (!response.ok) break;
                    
                    const data = await response.json();
                    const characters = extractNodes(data);
                    if (characters.length === 0) break;
                    chars.push(...characters);
                } catch (err) {
                    console.warn(`[ChubTags] Failed to fetch sort=${sortOrder} page=${page}:`, err);
                    break;
                }
            }
            return chars;
        }));
        
        const tagCounts = new Map();
        let totalChars = 0;
        for (const chars of results) {
            totalChars += chars.length;
            for (const char of chars) {
                for (const tag of (char.topics || [])) {
                    const normalized = tag.toLowerCase().trim();
                    if (normalized && normalized.length > 1 && normalized.length < 40) {
                        tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
                    }
                }
            }
        }
        
        const sortedTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 1000)
            .map(([tag]) => tag);
        
        if (sortedTags.length > 0) {
            chubPopularTags = sortedTags;
            chubTagsLoaded = true;
        }
        
        debugLog(`[ChubTags] Loaded ${chubPopularTags.length} unique tags from ${totalChars} characters`);
        
    } catch (error) {
        console.error('[ChubTags] Error fetching popular tags:', error);
    } finally {
        chubTagsLoading = false;
        
        // If the tags dropdown is already open, refresh it live
        const dropdown = document.getElementById('chubTagsDropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('chubTagsSearchInput');
            renderChubTagsDropdownList(searchInput?.value || '');
        }
    }
}

/**
 * Extract popular tags from ChubAI search results
 * Supplements existing tags if not fully loaded yet
 */
function extractChubTagsFromResults(characters) {
    // If we already have 250+ tags loaded from API, don't update
    if (chubTagsLoaded && chubPopularTags.length >= 250) return;
    
    const tagCounts = new Map();
    
    // Start with existing tag counts
    for (const tag of chubPopularTags) {
        tagCounts.set(tag, 10); // Give existing tags a baseline
    }
    
    for (const char of characters) {
        const topics = char.topics || [];
        for (const tag of topics) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag && normalizedTag.length > 1 && normalizedTag.length < 30) {
                tagCounts.set(normalizedTag, (tagCounts.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    // Sort by frequency and take top 600 tags
    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 600)
        .map(([tag]) => tag);
    
    if (sortedTags.length > chubPopularTags.length) {
        chubPopularTags = sortedTags;
    }
}

function updateChubFiltersButtonState() {
    const btn = document.getElementById('chubFiltersBtn');
    if (!btn) return;
    
    const hasActiveFilters = chubFilterImages || chubFilterLore || 
                             chubFilterExpressions || chubFilterGreetings || 
                             chubFilterFavorites || chubFilterHideOwned;
    
    btn.classList.toggle('has-filters', hasActiveFilters);
    
    const count = [chubFilterImages, chubFilterLore, chubFilterExpressions, 
                   chubFilterGreetings, chubFilterFavorites, chubFilterHideOwned].filter(Boolean).length;
    
    if (count > 0) {
        btn.innerHTML = `<i class="fa-solid fa-sliders"></i> Features (${count})`;
    } else {
        btn.innerHTML = `<i class="fa-solid fa-sliders"></i> Features`;
    }
}

function updateNsfwToggleState() {
    const btn = document.getElementById('chubNsfwToggle');
    if (!btn) return;
    
    if (chubNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ============================================================================
// CHUBAI TAGS DROPDOWN (Tri-state tag filters + advanced options)
// ============================================================================

/**
 * Add a custom tag as an include filter (typed by the user, not from the pre-fetched list)
 */
function addCustomChubTagFilter(tagText) {
    const normalized = tagText.toLowerCase().trim();
    if (!normalized || normalized.length < 2) return;

    if (!chubPopularTags.includes(normalized)) {
        chubPopularTags.unshift(normalized);
    }
    chubTagFilters.set(normalized, 'include');

    const searchInput = document.getElementById('chubTagsSearchInput');
    if (searchInput) searchInput.value = '';
    renderChubTagsDropdownList();
    updateChubTagsButtonState();
    triggerChubReloadDebounced();
}

/**
 * Initialize the Tags dropdown with event handlers
 */
function initChubTagsDropdown() {
    const btn = document.getElementById('chubTagsBtn');
    const dropdown = document.getElementById('chubTagsDropdown');
    const searchInput = document.getElementById('chubTagsSearchInput');
    const clearBtn = document.getElementById('chubTagsClearBtn');
    
    if (!btn || !dropdown) return;
    
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        const wasHidden = dropdown.classList.contains('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.add('hidden');
        dropdown.classList.toggle('hidden');
        
        // Populate tags when opening
        if (wasHidden) {
            renderChubTagsDropdownList();
            // Skip auto-focus on mobile — it spawns the virtual keyboard
            if (!window.matchMedia('(max-width: 768px)').matches) {
                searchInput?.focus();
            }
        }
    });
    
    // Dropdown close-on-outside-click is handled by the combined
    // _chubDropdownCloseHandler in initChubView()
    
    // Prevent dropdown from closing when clicking inside
    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // Tag search filtering
    searchInput?.addEventListener('input', debounce(() => {
        renderChubTagsDropdownList(searchInput.value);
    }, 150));

    // Enter key adds typed tag directly as a filter
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = searchInput.value.trim();
            if (value) addCustomChubTagFilter(value);
        }
    });
    
    clearBtn?.addEventListener('click', () => {
        chubTagFilters.clear();
        // Also clear the search input
        if (searchInput) searchInput.value = '';
        renderChubTagsDropdownList('');
        updateChubTagsButtonState();
        triggerChubReload();
    });
    
    // Advanced options handlers
    const sortDir = document.getElementById('chubSortDirection');
    const minTokens = document.getElementById('chubMinTokens');
    const maxTokens = document.getElementById('chubMaxTokens');
    
    sortDir?.addEventListener('change', (e) => {
        chubSortAscending = e.target.value === 'asc';
        triggerChubReload();
    });
    
    minTokens?.addEventListener('change', (e) => {
        chubMinTokens = parseInt(e.target.value) || 50;
        triggerChubReload();
    });
    
    maxTokens?.addEventListener('change', (e) => {
        chubMaxTokens = parseInt(e.target.value) || 100000;
        triggerChubReload();
    });
}

/**
 * Trigger a reload of ChubAI characters
 */
function triggerChubReload() {
    if (chubViewMode === 'timeline') {
        renderChubTimeline();
    } else {
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    }
}

// Debounce timeout for tag filter changes
let chubTagFilterDebounceTimeout = null;

/**
 * Debounced version of triggerChubReload for tag filtering
 * Waits 500ms after the last change before reloading
 */
function triggerChubReloadDebounced() {
    if (chubTagFilterDebounceTimeout) {
        clearTimeout(chubTagFilterDebounceTimeout);
    }
    chubTagFilterDebounceTimeout = setTimeout(() => {
        chubTagFilterDebounceTimeout = null;
        triggerChubReload();
    }, 500);
}

/**
 * Render the tag list in the dropdown with tri-state buttons
 */
function renderChubTagsDropdownList(filter = '') {
    const container = document.getElementById('chubTagsList');
    if (!container) return;
    
    if (chubTagsLoading) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }
    
    // Try to load tags if not available
    if (chubPopularTags.length === 0) {
        if (!chubTagsLoaded) {
            fetchChubPopularTags().then(() => renderChubTagsDropdownList(filter));
        } else {
            container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        }
        return;
    }
    
    // Filter tags
    const filterLower = filter.toLowerCase();
    const filteredTags = filter 
        ? chubPopularTags.filter(tag => tag.toLowerCase().includes(filterLower))
        : chubPopularTags;
    
    // Check if the typed text exactly matches any known tag
    const hasExactMatch = filter && filteredTags.some(t => t.toLowerCase() === filterLower);
    const showCustomAdd = filter && filterLower.length >= 2 && !hasExactMatch;
    
    if (filteredTags.length === 0 && !showCustomAdd) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }
    
    // Sort: active filters first, then alphabetically
    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = chubTagFilters.get(a);
        const bState = chubTagFilters.get(b);
        // Active filters (include/exclude) come first
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        // Then sort alphabetically
        return a.localeCompare(b);
    });
    
    // "Add as filter" row when typed text isn't in the list
    const customAddHtml = showCustomAdd ? `
        <div class="browse-tag-filter-item browse-tag-custom-add" data-custom-tag="${escapeHtml(filterLower)}">
            <button class="browse-tag-state-btn state-include"><i class="fa-solid fa-plus"></i></button>
            <span class="tag-label">Add <strong>${escapeHtml(filterLower)}</strong> as filter</span>
        </div>
    ` : '';

    container.innerHTML = customAddHtml + sortedTags.map(tag => {
        const state = chubTagFilters.get(tag) || 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>' 
                        : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>' 
                        : '';
        const stateTitle = state === 'include' ? 'Included - click to exclude'
                        : state === 'exclude' ? 'Excluded - click to clear'
                        : 'Neutral - click to include';
        
        return `
            <div class="browse-tag-filter-item" data-tag="${escapeHtml(tag)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag)}</span>
            </div>
        `;
    }).join('');
    
    // Custom-add row click handler
    container.querySelector('.browse-tag-custom-add')?.addEventListener('click', () => {
        addCustomChubTagFilter(filterLower);
    });

    // Attach click handlers
    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const label = item.querySelector('.tag-label');
        
        const cycleState = () => {
            const current = chubTagFilters.get(tag) || 'neutral';
            let newState;
            
            // Cycle: neutral -> include -> exclude -> neutral
            if (current === 'neutral') {
                newState = 'include';
                chubTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                newState = 'exclude';
                chubTagFilters.set(tag, 'exclude');
            } else {
                newState = 'neutral';
                chubTagFilters.delete(tag);
            }
            
            updateChubTagStateButton(stateBtn, newState);
            updateChubTagsButtonState();
            triggerChubReloadDebounced();
        };
        
        stateBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleState();
        });
        
        label?.addEventListener('click', cycleState);
    });
}

/**
 * Update a single tag state button's appearance
 */
function updateChubTagStateButton(btn, state) {
    if (!btn) return;
    
    btn.className = 'browse-tag-state-btn';
    if (state === 'include') {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.title = 'Included - click to exclude';
    } else if (state === 'exclude') {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded - click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Neutral - click to include';
    }
}

/**
 * Update the Tags button to show active filter count
 */
function updateChubTagsButtonState() {
    const btn = document.getElementById('chubTagsBtn');
    const label = document.getElementById('chubTagsBtnLabel');
    if (!btn || !label) return;
    
    const includeCount = Array.from(chubTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(chubTagFilters.values()).filter(v => v === 'exclude').length;
    
    const hasAdvanced = chubSortAscending || chubMinTokens !== 50 || chubMaxTokens !== 100000;
    
    let text = 'Tags';
    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);
    if (parts.length > 0) {
        text += ` (${parts.join('/')})`;
    }
    
    label.textContent = text;
    
    // Visual indicator for active filters
    const hasFilters = includeCount > 0 || excludeCount > 0 || hasAdvanced;
    btn.classList.toggle('has-filters', hasFilters);
}

// ============================================================================
// CHUBAI VIEW MODE SWITCHING (Browse/Timeline)
// ============================================================================

async function switchChubViewMode(mode) {
    chubViewMode = mode;
    
    document.querySelectorAll('.chub-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.chubView === mode);
    });
    
    // Show/hide sections
    const browseSection = document.getElementById('chubBrowseSection');
    const timelineSection = document.getElementById('chubTimelineSection');
    
    if (mode === 'browse') {
        browseSection?.classList.remove('hidden');
        timelineSection?.classList.add('hidden');
        
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        const timelineSortHeader = document.getElementById('chubTimelineSortHeader');
        const tagsDropdownContainer = document.querySelector('.browse-tags-dropdown-container');
        const dpTarget = discoveryPreset?._customSelect?.container || discoveryPreset;
        const tsTarget = timelineSortHeader?._customSelect?.container || timelineSortHeader;
        if (dpTarget) dpTarget.classList.remove('browse-filter-hidden');
        if (tsTarget) tsTarget.classList.add('browse-filter-hidden');
        if (tagsDropdownContainer) tagsDropdownContainer.classList.remove('browse-filter-hidden');
        // Show advanced options (API-only params) in browse mode
        const advancedOpts = document.getElementById('chubAdvancedOptions');
        const advancedDivider = document.getElementById('chubAdvancedDivider');
        if (advancedOpts) advancedOpts.style.display = '';
        if (advancedDivider) advancedDivider.style.display = '';
        
        const grid = document.getElementById('chubGrid');
        if (grid) {
            renderLoadingState(grid, 'Loading ChubAI characters...', 'browse-loading');
        }
        
        // Always reload browse data when switching to it to avoid stale/mixed data
        chubCharacters = [];
        chubCurrentPage = 1;
        loadChubCharacters();
    } else if (mode === 'timeline') {
        browseSection?.classList.add('hidden');
        timelineSection?.classList.remove('hidden');
        
        const discoveryPreset = document.getElementById('chubDiscoveryPreset');
        const timelineSortHeader = document.getElementById('chubTimelineSortHeader');
        const tagsDropdownContainer = document.querySelector('.browse-tags-dropdown-container');
        const dpTarget = discoveryPreset?._customSelect?.container || discoveryPreset;
        const tsTarget = timelineSortHeader?._customSelect?.container || timelineSortHeader;
        if (dpTarget) dpTarget.classList.add('browse-filter-hidden');
        if (tsTarget) tsTarget.classList.remove('browse-filter-hidden');
        // Hide advanced options (sort direction, token limits) — not applicable to timeline
        const advancedOpts = document.getElementById('chubAdvancedOptions');
        const advancedDivider = document.getElementById('chubAdvancedDivider');
        if (advancedOpts) advancedOpts.style.display = 'none';
        if (advancedDivider) advancedDivider.style.display = 'none';
        
        // If favorites filter is enabled, fetch the favorite IDs first
        if (chubFilterFavorites && chubToken) {
            await fetchChubUserFavoriteIds();
        }
        
        // Load timeline if not loaded, otherwise just re-render with current filters
        if (chubTimelineCharacters.length === 0) {
            loadChubTimeline();
        } else {
            // Re-render to apply any active filters (like favorites)
            renderChubTimeline();
        }
    }
}

// ============================================================================
// CHUBAI TIMELINE (New from followed authors)
// ============================================================================

async function loadChubTimeline(forceRefresh = false, _isAutoPage = false) {
    if (!chubToken) {
        renderTimelineEmpty('login');
        return;
    }
    
    const grid = document.getElementById('chubTimelineGrid');
    const loadMoreContainer = document.getElementById('chubTimelineLoadMore');
    const isInitialLoad = !_isAutoPage;
    
    if (forceRefresh || (!chubTimelineCursor && chubTimelineCharacters.length === 0)) {
        renderLoadingState(grid, 'Loading timeline...', 'browse-loading');
        if (forceRefresh) {
            chubTimelineCharacters = [];
            chubTimelinePage = 1;
            chubTimelineCursor = null;
            chubTimelineAuthorPage = 1;
            chubTimelineAuthorHasMore = false;
        }
    }
    
    try {
        // Use the dedicated timeline endpoint which returns updates from followed authors
        // This API uses cursor-based pagination, not page-based
        const params = new URLSearchParams();
        params.set('first', '50');
        params.set('nsfw', chubNsfwEnabled.toString());
        params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
        params.set('count', 'true'); // Request total count for better pagination info
        
        // Use cursor for pagination if we have one (for loading more)
        const hadCursor = !!chubTimelineCursor;
        if (chubTimelineCursor) {
            params.set('cursor', chubTimelineCursor);
            debugLog('[ChubTimeline] Loading next page with cursor');
        }
        
        const headers = getChubHeaders(true);
        
        debugLog('[ChubTimeline] Loading timeline, nsfw:', chubNsfwEnabled);
        
        const response = await fetch(`${CHUB_API_BASE}/api/timeline/v1?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubTimeline] Error response:', response.status, errorText);
            
            if (response.status === 401) {
                renderTimelineEmpty('login');
                return;
            }
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Extract response data (may be nested under 'data')
        const responseData = data.data || data;
        
        const totalCount = responseData.count ?? null;
        
        const nextCursor = responseData.cursor || null;
        
        let nodes = [];
        if (responseData.nodes) {
            nodes = responseData.nodes;
        } else if (Array.isArray(responseData)) {
            nodes = responseData;
        }
        
        debugLog('[ChubTimeline] Got', nodes.length, 'items from API');
        
        // Filter to only include characters (not lorebooks, posts, etc.)
        // Timeline API returns paths without "characters/" prefix, so check for:
        // - Has a fullPath with username/slug format (not lorebooks/ or posts/)
        // - OR has character-specific fields like tagline, topics, etc.
        const characterNodes = nodes.filter(node => {
            const fullPath = node.fullPath || node.full_path || '';
            
            // Skip if explicitly a lorebook or post
            if (fullPath.startsWith('lorebooks/') || fullPath.startsWith('posts/')) {
                return false;
            }
            
            // If it has entries array, it's a lorebook
            if (node.entries && Array.isArray(node.entries)) {
                return false;
            }
            
            // Check for character-specific properties that indicate this is a character
            // Characters have: tagline, first_mes/definition, topics, etc.
            const hasCharacterProperties = node.tagline !== undefined || 
                                          node.definition !== undefined ||
                                          node.first_mes !== undefined ||
                                          node.topics !== undefined ||
                                          (node.labels && Array.isArray(node.labels));
            
            // If fullPath has format "characters/user/slug" or "user/slug" it's likely a character
            // Also accept if it has character-like properties
            const hasCharPath = fullPath.startsWith('characters/') || 
                               (fullPath.includes('/') && !fullPath.startsWith('lorebooks/') && !fullPath.startsWith('posts/'));
            
            const isCharacter = hasCharPath || hasCharacterProperties;
            
            return isCharacter;
        });
        
        // Dedupe by fullPath
        if (chubTimelineCharacters.length === 0) {
            chubTimelineCharacters = characterNodes;
        } else {
            const existingPaths = new Set(chubTimelineCharacters.map(c => c.fullPath || c.full_path));
            // Push new items instead of spread-copying the entire array
            for (const c of characterNodes) {
                const fp = c.fullPath || c.full_path;
                if (!existingPaths.has(fp)) {
                    chubTimelineCharacters.push(c);
                    existingPaths.add(fp);
                }
            }
        }

        debugLog('[ChubTimeline] Total characters:', chubTimelineCharacters.length);
        
        chubTimelineCursor = nextCursor;
        
        const gotItems = nodes.length > 0;
        chubTimelineHasMore = gotItems && nextCursor;
        
        // Check how recent the oldest item in this batch is
        let oldestInBatch = null;
        if (nodes.length > 0) {
            const lastNode = nodes[nodes.length - 1];
            oldestInBatch = lastNode.createdAt || lastNode.created_at;
        }
        
        // Auto-load more pages to get recent content
        // Keep loading if we have a cursor and:
        // 1. We filtered out all items (lorebooks etc)
        // 2. Or we want more characters (up to 96 for good coverage)
        // 3. The oldest item is still recent (less than 14 days old)
        let shouldAutoLoad = false;
        const autoLoadTarget = 96;
        const autoLoadPageLimit = 8;
        if (nextCursor) {
            if (characterNodes.length === 0) {
                shouldAutoLoad = true; // All filtered out
            } else if (chubTimelineCharacters.length < autoLoadTarget) {
                // Check age of oldest item - keep loading if less than 14 days old
                if (oldestInBatch) {
                    const oldestDate = new Date(oldestInBatch);
                    const daysSinceOldest = (Date.now() - oldestDate.getTime()) / (1000 * 60 * 60 * 24);
                    shouldAutoLoad = daysSinceOldest < 14;
                } else {
                    shouldAutoLoad = true;
                }
            }
        }
        
        // Limit auto-loading to prevent infinite loops
        if (shouldAutoLoad && chubTimelinePage < autoLoadPageLimit) {
            debugLog('[ChubTimeline] Auto-loading next page... (have', chubTimelineCharacters.length, 'chars so far)');
            chubTimelinePage++;
            await loadChubTimeline(false, true);
            return;
        }
        
        // Timeline API is unreliable -- supplement with direct author fetches
        // on any initial/forced load (not on auto-page recursion or Load More)
        if (isInitialLoad) {
            debugLog('[ChubTimeline] Supplementing with direct author fetches...');
            await supplementTimelineWithAuthorFetches();
        }
        
        if (chubTimelineCharacters.length === 0) {
            renderTimelineEmpty('empty');
        } else {
            renderChubTimeline();
        }
        
        // Show/hide load more button (visible if timeline cursor OR author pages remain)
        chubBrowseView.updateLoadMoreVisibility('chubTimelineLoadMore', chubTimelineHasMore || chubTimelineAuthorHasMore, true);
        
    } catch (e) {
        console.error('[ChubTimeline] Load error:', e);
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Failed to Load Timeline</h3>
                <p>${escapeHtml(e.message)}</p>
                <button class="action-btn primary browse-retry-btn">
                    <i class="fa-solid fa-refresh"></i> Retry
                </button>
            </div>
        `;
    }
}

/**
 * Supplement timeline with direct fetches from followed authors.
 * Supports pagination: page 1 fetches the 24 newest per author,
 * page 2 fetches 25-48, etc. Sets chubTimelineAuthorHasMore if
 * any author returned a full page (indicating deeper content exists).
 */
async function supplementTimelineWithAuthorFetches(page = 1) {
    try {
        const followedAuthors = await fetchMyFollowsList();
        if (!followedAuthors || followedAuthors.size === 0) {
            debugLog('[ChubTimeline] No followed authors to fetch from');
            chubTimelineAuthorHasMore = false;
            return;
        }
        
        debugLog('[ChubTimeline] Fetching page', page, 'from', followedAuthors.size, 'followed authors');
        
        const existingPaths = new Set(chubTimelineCharacters.map(c => 
            (c.fullPath || c.full_path || '').toLowerCase()
        ));
        
        const authorsToFetch = [...followedAuthors];
        const PAGE_SIZE = 24;
        let anyFullPage = false;

        const batchSize = 5;
        for (let i = 0; i < authorsToFetch.length; i += batchSize) {
            const batch = authorsToFetch.slice(i, i + batchSize);
            
            const promises = batch.map(async (author) => {
                try {
                    const params = new URLSearchParams();
                    params.set('username', author);
                    params.set('first', PAGE_SIZE.toString());
                    params.set('page', page.toString());
                    params.set('sort', 'id');
                    params.set('nsfw', chubNsfwEnabled.toString());
                    params.set('nsfl', chubNsfwEnabled.toString());
                    params.set('include_forks', 'true');
                    
                    const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                        headers: getChubHeaders(true)
                    });
                    
                    if (!response.ok) {
                        debugLog(`[ChubTimeline] Error from ${author}: ${response.status}`);
                        return [];
                    }
                    
                    const data = await response.json();
                    const nodes = data.nodes || data.data?.nodes || [];
                    if (nodes.length >= PAGE_SIZE) anyFullPage = true;
                    return nodes;
                } catch (e) {
                    debugLog(`[ChubTimeline] Error fetching from ${author}:`, e.message);
                    return [];
                }
            });
            
            const results = await Promise.all(promises);
            
            for (const authorChars of results) {
                for (const char of authorChars) {
                    const path = (char.fullPath || char.full_path || '').toLowerCase();
                    if (path && !existingPaths.has(path)) {
                        existingPaths.add(path);
                        chubTimelineCharacters.push(char);
                    }
                }
            }

        }
        
        chubTimelineAuthorHasMore = anyFullPage;
        debugLog('[ChubTimeline] After supplement page', page, '- have', chubTimelineCharacters.length, 'total chars, hasMore:', anyFullPage);
        
    } catch (e) {
        console.error('[ChubTimeline] Error supplementing timeline:', e);
        chubTimelineAuthorHasMore = false;
    }
}

function renderTimelineEmpty(reason) {
    const grid = document.getElementById('chubTimelineGrid');
    
    if (reason === 'login') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Token Required</h3>
                <p>Add your ChubAI URQL token to see new characters from authors you follow.</p>
                <button class="action-btn primary browse-add-token-btn">
                    <i class="fa-solid fa-key"></i> Add Token
                </button>
            </div>
        `;
    } else if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Authors</h3>
                <p>Follow some character creators on ChubAI to see their new characters here!</p>
                <a href="https://chub.ai" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Find Authors on ChubAI
                </a>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No New Characters</h3>
                <p>Authors you follow haven't posted new characters recently.</p>
                <a href="https://chub.ai" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Browse ChubAI
                </a>
            </div>
        `;
    }
}

/**
 * Sort timeline characters based on the current sort option (client-side)
 */
function sortTimelineCharacters(characters) {
    switch (chubTimelineSort) {
        case 'newest':
            // Sort by created_at or id descending (newest first)
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'updated':
            // Sort by last_activity_at or updated_at descending (recently updated first)
            return characters.sort((a, b) => {
                const dateA = a.lastActivityAt || a.last_activity_at || a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0;
                const dateB = b.lastActivityAt || b.last_activity_at || b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'oldest':
            // Sort by created_at or id ascending (oldest first)
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateA) - new Date(dateB);
                }
                return dateA - dateB;
            });
        case 'name_asc':
            // Sort by name A-Z
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });
        case 'name_desc':
            // Sort by name Z-A
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameB.localeCompare(nameA);
            });
        case 'downloads':
            // Sort by download count descending
            // ChubAI's weird naming: starCount is actually downloads
            return characters.sort((a, b) => {
                const dlA = a.starCount || 0;
                const dlB = b.starCount || 0;
                return dlB - dlA;
            });
        case 'rating':
            // Sort by rating descending (1-5 star rating)
            return characters.sort((a, b) => {
                const ratingA = a.rating || 0;
                const ratingB = b.rating || 0;
                return ratingB - ratingA;
            });
        case 'favorites':
            // Sort by favorites count descending (the heart/favorite count)
            return characters.sort((a, b) => {
                const favA = a.n_favorites || a.nFavorites || 0;
                const favB = b.n_favorites || b.nFavorites || 0;
                return favB - favA;
            });
        default:
            return characters;
    }
}

function renderChubTimeline() {
    const grid = document.getElementById('chubTimelineGrid');
    
    // Build tag include/exclude sets for client-side filtering
    const includeTags = [];
    const excludeTags = [];
    for (const [tag, state] of chubTagFilters) {
        if (state === 'include') includeTags.push(tag.toLowerCase());
        else if (state === 'exclude') excludeTags.push(tag.toLowerCase());
    }
    
    const anyFilterActive = chubFilterImages || chubFilterLore || chubFilterExpressions ||
        chubFilterGreetings || chubFilterHideOwned || (chubFilterFavorites && chubUserFavoriteIds.size > 0) ||
        includeTags.length > 0 || excludeTags.length > 0;
    
    let filteredCharacters;
    if (anyFilterActive) {
        filteredCharacters = chubTimelineCharacters.filter(c => {
            if (chubFilterImages && !(c.hasGallery || c.has_gallery)) return false;
            if (chubFilterLore && !(c.has_lore || c.related_lorebooks?.length > 0)) return false;
            if (chubFilterExpressions && !c.has_expression_pack) return false;
            if (chubFilterGreetings && !(c.alternate_greetings?.length > 0 || c.n_greetings > 1)) return false;
            if (chubFilterHideOwned && isCharInLocalLibrary(c)) return false;
            if (chubFilterFavorites && chubUserFavoriteIds.size > 0 && !chubUserFavoriteIds.has(c.id || c.project_id)) return false;
            // Tag filters (client-side — timeline data already has topics)
            if (includeTags.length > 0 || excludeTags.length > 0) {
                const charTopics = (c.topics || []).map(t => t.toLowerCase());
                if (includeTags.length > 0 && !includeTags.every(t => charTopics.includes(t))) return false;
                if (excludeTags.length > 0 && excludeTags.some(t => charTopics.includes(t))) return false;
            }
            return true;
        });
    } else {
        filteredCharacters = chubTimelineCharacters.slice();
    }
    
    // Sort the characters based on chubTimelineSort
    const sortedCharacters = sortTimelineCharacters(filteredCharacters);
    
    if (sortedCharacters.length === 0 && chubTimelineCharacters.length > 0) {
        chubTimelineRenderToken++;
        chubTimelineLookup.clear();
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting the filters.</p>
            </div>
        `;
        return;
    }

    buildChubLookup(chubTimelineLookup, sortedCharacters);
    if (chubImageObserver) chubImageObserver.disconnect();

    if (sortedCharacters.length > 180) {
        const token = ++chubTimelineRenderToken;
        const chunkSize = 60;
        let index = 0;
        grid.innerHTML = '';

        const appendNextChunk = () => {
            if (token !== chubTimelineRenderToken || getCurrentView() !== 'online' || chubViewMode !== 'timeline') return;
            const end = Math.min(index + chunkSize, sortedCharacters.length);
            grid.insertAdjacentHTML('beforeend', sortedCharacters.slice(index, end).map(char => createChubCard(char, true)).join(''));
            index = end;
            if (index < sortedCharacters.length) {
                requestAnimationFrame(appendNextChunk);
            } else {
                eagerLoadVisibleChubImages(grid);
                observeChubImages(grid);
            }
        };

        requestAnimationFrame(appendNextChunk);
        return;
    }

    chubTimelineRenderToken++;
    grid.innerHTML = sortedCharacters.map(char => createChubCard(char, true)).join('');
    eagerLoadVisibleChubImages(grid);
    observeChubImages(grid);
}

// ============================================================================
// CHUB IMAGE LAZY LOADING (IntersectionObserver)
// One-directional — loads images near the viewport, never unloads.
// ============================================================================

function initChubImageObserver() {
    if (chubImageObserver) return;
    chubImageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            const realSrc = img.dataset.src;
            if (realSrc && !img.dataset.failed && img.src !== realSrc) {
                img.src = realSrc;
                BrowseView.adjustPortraitPosition(img);
            }
        }
    }, {
        rootMargin: '600px'
    });
}

function observeChubImages(container) {
    if (!chubImageObserver) initChubImageObserver();
    // Defer observer hookup to the next frame so innerHTML paint isn't blocked
    requestAnimationFrame(() => {
        eagerLoadVisibleChubImages(container);
        eagerPreloadChubImages(container);
        const images = Array.from(container.querySelectorAll('.browse-card-image img')).filter(img => !img.dataset.observed);
        if (images.length === 0) return;

        if (images.length > 120) {
            const batchSize = 80;
            let index = 0;
            const observeBatch = () => {
                const end = Math.min(index + batchSize, images.length);
                for (let i = index; i < end; i++) {
                    const img = images[i];
                    img.dataset.observed = '1';
                    chubImageObserver.observe(img);
                }
                index = end;
                if (index < images.length) {
                    requestAnimationFrame(observeBatch);
                }
            };
            observeBatch();
            return;
        }

        for (const img of images) {
            img.dataset.observed = '1';
            chubImageObserver.observe(img);
        }
    });
}

function eagerLoadVisibleChubImages(container) {
    if (!container) return;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const preloadBottom = viewportHeight + 700;
    const images = container.querySelectorAll('.browse-card-image img[data-src]');
    for (const img of images) {
        if (img.dataset.failed) continue;
        const rect = img.getBoundingClientRect();
        if (rect.bottom > -160 && rect.top < preloadBottom) {
            const realSrc = img.dataset.src;
            if (realSrc && img.src !== realSrc) {
                img.src = realSrc;
                BrowseView.adjustPortraitPosition(img);
            }
        }
    }
}

function eagerPreloadChubImages(container) {
    if (!container) return;
    const images = container.querySelectorAll('.browse-card-image img[data-src]');
    let loaded = 0;
    const MAX_PRELOAD = 90;
    for (const img of images) {
        if (loaded >= MAX_PRELOAD) break;
        if (img.dataset.failed) continue;
        const realSrc = img.dataset.src;
        if (realSrc && img.src !== realSrc) {
            img.src = realSrc;
            BrowseView.adjustPortraitPosition(img);
            loaded++;
        }
    }
}

/**
 * Reconnect the image observer to whichever chub grid is currently visible.
 * Clears data-observed flags first since disconnect() doesn't remove them.
 */
function reconnectBrowseImageObserver() {
    const gridId = chubViewMode === 'timeline' ? 'chubTimelineGrid' : 'chubGrid';
    const grid = document.getElementById(gridId);
    if (!grid) return;
    eagerLoadVisibleChubImages(grid);
    eagerPreloadChubImages(grid);
    const imgs = grid.querySelectorAll('.browse-card-image img[data-observed]');
    for (const img of imgs) delete img.dataset.observed;
    observeChubImages(grid);
}

// ============================================================================
// AUTHOR FILTERING
// ============================================================================

/**
 * Search for a creator from the creator search input
 */
function performChubCreatorSearch() {
    const creatorInput = document.getElementById('chubCreatorSearchInput');
    const creatorName = creatorInput?.value.trim();
    
    if (!creatorName) {
        showToast('Please enter a creator name', 'warning');
        return;
    }
    
    creatorInput.value = '';
    
    filterByAuthor(creatorName);
}

function filterByAuthor(authorName) {
    // Set filter state BEFORE mode switch — switchChubViewMode('browse')
    // triggers loadChubCharacters() internally, which must see the author filter
    chubAuthorFilter = authorName;
    chubCurrentSearch = '';
    chubCharacters = [];
    chubCurrentPage = 1;

    // Reset author sort to newest (most useful default when viewing an author)
    chubAuthorSort = 'id';
    const sortSelect = document.getElementById('chubAuthorSortSelect');
    if (sortSelect) sortSelect.value = 'id';

    // Switch to browse mode (will trigger loadChubCharacters with author filter)
    if (chubViewMode !== 'browse') {
        switchChubViewMode('browse');
    } else {
        // Already in browse mode — trigger load directly
        loadChubCharacters();
    }

    const banner = document.getElementById('chubAuthorBanner');
    const bannerName = document.getElementById('chubAuthorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = authorName;
        banner.classList.remove('hidden');
    }
    
    updateFollowAuthorButton(authorName);
    
    document.getElementById('chubSearchInput').value = '';
}

// Track if we're following the current author
let chubIsFollowingCurrentAuthor = false;
let chubMyFollowsList = null; // Cache of who we follow

// Fetch list of users we follow (cached)
async function fetchMyFollowsList(forceRefresh = false) {
    if (chubMyFollowsList && !forceRefresh) {
        return chubMyFollowsList;
    }
    
    if (!chubToken) return [];
    
    try {
        // First get our own username from account
        const accountResp = await fetch(`${CHUB_API_BASE}/api/account`, {
            headers: getChubHeaders(true)
        });
        
        if (!accountResp.ok) {
            debugLog('[ChubFollow] Could not get account info');
            return [];
        }
        
        const accountData = await accountResp.json();
        
        // API returns user_name (with underscore), not username
        const myUsername = accountData.user_name || accountData.name || accountData.username || 
                          accountData.data?.user_name || accountData.data?.name;
        
        if (!myUsername) {
            debugLog('[ChubFollow] No username found in account data');
            return [];
        }
        
        // Now get who we follow
        const followsResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=1`, {
            headers: getChubHeaders(true)
        });
        
        if (!followsResp.ok) {
            debugLog('[ChubFollow] Could not get follows list');
            return [];
        }
        
        const followsData = await followsResp.json();
        
        const followsList = followsData.follows || followsData.nodes || followsData.data?.follows || followsData.data?.nodes || [];
        const followedUsernames = new Set();
        
        for (const node of followsList) {
            // The node might be a user object or have username in different places
            // API uses user_name (with underscore)
            const username = node.user_name || node.username || node.name || node.user?.user_name || node.user?.username;
            if (username) {
                followedUsernames.add(username.toLowerCase());
            }
        }
        
        // Fetch more pages if needed (count tells us total)
        const totalCount = followsData.count || 0;
        let page = 2;
        while (followedUsernames.size < totalCount && page <= 20) {
            const moreResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=${page}`, {
                headers: getChubHeaders(true)
            });
            
            if (!moreResp.ok) break;
            
            const moreData = await moreResp.json();
            const moreFollows = moreData.follows || moreData.nodes || moreData.data?.follows || [];
            
            if (moreFollows.length === 0) break;
            
            for (const node of moreFollows) {
                const username = node.user_name || node.username || node.name || node.user?.user_name;
                if (username) {
                    followedUsernames.add(username.toLowerCase());
                }
            }
            page++;
        }
        
        chubMyFollowsList = followedUsernames;
        debugLog('[ChubFollow] Following', followedUsernames.size, 'users:', [...followedUsernames]);
        return followedUsernames;
        
    } catch (e) {
        console.error('[ChubFollow] Error fetching follows:', e);
        return [];
    }
}

// Update the follow button based on whether we're already following this author
async function updateFollowAuthorButton(authorName) {
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (!followBtn) return;
    
    // Show/hide based on whether we have a token
    if (!chubToken) {
        followBtn.style.display = 'none';
        return;
    }
    
    followBtn.style.display = '';
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    // Check if we're following this author
    try {
        const followsList = await fetchMyFollowsList();
        chubIsFollowingCurrentAuthor = followsList && followsList.has(authorName.toLowerCase());
        debugLog('[ChubFollow] Checking if following', authorName, ':', chubIsFollowingCurrentAuthor);
    } catch (e) {
        debugLog('[ChubFollow] Could not check follow status:', e);
        chubIsFollowingCurrentAuthor = false;
    }
    
    // Update button state
    followBtn.disabled = false;
    if (chubIsFollowingCurrentAuthor) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = `Unfollow ${authorName} on ChubAI`;
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = `Follow ${authorName} on ChubAI`;
    }
}

// Follow/unfollow the currently viewed author
async function toggleFollowAuthor() {
    if (!chubAuthorFilter || !chubToken) {
        showToast('Login required to follow authors', 'warning');
        return;
    }
    
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        // ChubAI follow API: POST to follow, DELETE to unfollow
        // Correct endpoint: /api/follow/{username}
        const method = chubIsFollowingCurrentAuthor ? 'DELETE' : 'POST';
        const headers = getChubHeaders(true);
        headers['Content-Type'] = 'application/json';
        
        const response = await fetch(`${CHUB_API_BASE}/api/follow/${chubAuthorFilter}`, {
            method: method,
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubFollow] Error:', response.status, errorText);
            throw new Error(`Failed: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('[ChubFollow] Response:', data);
        
        // Toggle state and update cache
        chubIsFollowingCurrentAuthor = !chubIsFollowingCurrentAuthor;
        
        // Update the cached follows list
        if (chubMyFollowsList) {
            const authorLower = chubAuthorFilter.toLowerCase();
            if (chubIsFollowingCurrentAuthor) {
                chubMyFollowsList.add(authorLower);
            } else {
                chubMyFollowsList.delete(authorLower);
            }
        }
        
        if (chubIsFollowingCurrentAuthor) {
            showToast(`Now following ${chubAuthorFilter}!`, 'success');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
                followBtn.classList.add('following');
            }
        } else {
            showToast(`Unfollowed ${chubAuthorFilter}`, 'info');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
                followBtn.classList.remove('following');
            }
        }
        
        if (followBtn) followBtn.disabled = false;
        
    } catch (e) {
        console.error('[ChubFollow] Error:', e);
        showToast(`Failed: ${e.message}`, 'error');
        
        if (followBtn) {
            followBtn.disabled = false;
            // Restore previous state
            if (chubIsFollowingCurrentAuthor) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
            } else {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            }
        }
    }
}

function clearAuthorFilter() {
    chubAuthorFilter = null;
    
    // Hide banner
    hide('chubAuthorBanner');
    
    // Reload without author filter
    chubCharacters = [];
    chubCurrentPage = 1;
    loadChubCharacters();
}

function performChubSearch() {
    const searchInput = document.getElementById('chubSearchInput');
    chubCurrentSearch = searchInput.value.trim();
    // Clear author filter when doing a new search
    if (chubAuthorFilter) {
        chubAuthorFilter = null;
        hide('chubAuthorBanner');
    }
    chubCharacters = [];
    chubCurrentPage = 1;
    loadChubCharacters();
}

async function loadChubCharacters(forceRefresh = false) {
    if (chubIsLoading) return;
    
    const grid = document.getElementById('chubGrid');
    const loadMoreContainer = document.getElementById('chubLoadMore');
    
    // Special handling for favorites filter - use gateway API directly
    if (chubFilterFavorites && chubToken) {
        await loadChubFavorites(forceRefresh);
        return;
    }
    
    const loadMoreBtn = document.getElementById('chubLoadMoreBtn');

    if (chubCurrentPage === 1) {
        renderLoadingState(grid, 'Loading ChubAI characters...', 'browse-loading');
    }
    
    chubIsLoading = true;

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }
    
    try {
        // Build query parameters - ChubAI uses query params even with POST
        const params = new URLSearchParams();
        params.set('first', '48');
        // Get sort and time from discovery preset
        const preset = CHUB_DISCOVERY_PRESETS[chubDiscoveryPreset] || CHUB_DISCOVERY_PRESETS['popular_week'];
        
        params.set('page', chubCurrentPage.toString());
        params.set('nsfw', chubNsfwEnabled.toString());
        params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
        params.set('include_forks', 'true'); // Include forked characters
        params.set('venus', 'false');
        
        if (chubCurrentSearch) {
            params.set('search', chubCurrentSearch);
        }
        
        // Author filter - use 'username' parameter
        if (chubAuthorFilter) {
            params.set('username', chubAuthorFilter);
            // Use author-specific sort instead of preset sort
            params.set('sort', chubAuthorSort);
            // Don't apply time period filter when viewing an author's profile
            // We want to see all their characters, not just recent ones
        } else if (chubCurrentSearch) {
            // When searching, drop time period and special_mode so older
            // characters aren't excluded. Keep the preset sort unless it's
            // 'default' (which triggers server-side relevance).
            if (preset.sort !== 'default') {
                params.set('sort', preset.sort);
            }
        } else {
            // Use preset sort for general browsing
            if (preset.sort !== 'default') {
                params.set('sort', preset.sort);
            }
            // Add special_mode filter if preset has one (e.g., newcomer for recent hits)
            if (preset.special_mode) {
                params.set('special_mode', preset.special_mode);
            }
            // Add time period filter from preset (max_days_ago) only for general browsing
            if (preset.days > 0) {
                params.set('max_days_ago', preset.days.toString());
            }
        }
        
        // Add additional filters
        if (chubFilterImages) {
            params.set('require_images', 'true');
        }
        if (chubFilterLore) {
            params.set('require_lore', 'true');
        }
        if (chubFilterExpressions) {
            params.set('require_expressions', 'true');
        }
        if (chubFilterGreetings) {
            params.set('require_alternate_greetings', 'true');
        }
        
        // === Advanced Tag Filters ===
        // Include tags (topics)
        const includeTags = [];
        const excludeTags = [];
        for (const [tag, state] of chubTagFilters) {
            if (state === 'include') includeTags.push(tag);
            else if (state === 'exclude') excludeTags.push(tag);
        }
        if (includeTags.length > 0) {
            params.set('topics', includeTags.join(','));
        }
        if (excludeTags.length > 0) {
            params.set('excludetopics', excludeTags.join(','));
        }
        
        // Sort direction
        if (chubSortAscending) {
            params.set('asc', 'true');
        }
        
        // Token limits (only set if different from defaults)
        if (chubMinTokens !== 50) {
            params.set('min_tokens', chubMinTokens.toString());
        } else {
            params.set('min_tokens', '50');
        }
        if (chubMaxTokens !== 100000) {
            params.set('max_tokens', chubMaxTokens.toString());
        }
        
        // Note: Favorites filter is now handled by loadChubFavorites() using gateway API
        
        debugLog('[ChubAI] Search params:', params.toString());
        
        const headers = getChubHeaders(true);
        
        const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('ChubAI response:', errorText);
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Provider was deactivated during the fetch
        if (!chubDelegatesInitialized) return;
        
        // Handle different response formats
        let nodes = [];
        if (data.nodes) {
            nodes = data.nodes;
        } else if (data.data?.nodes) {
            nodes = data.data.nodes;
        } else if (Array.isArray(data.data)) {
            nodes = data.data;
        } else if (Array.isArray(data)) {
            nodes = data;
        }
        
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
            // Extract popular tags from search results on first page
            extractChubTagsFromResults(nodes);
        } else {
            const existingPaths = new Set(chubCharacters.map(c => getChubFullPath(c)).filter(Boolean));
            for (const node of nodes) {
                const fp = getChubFullPath(node);
                if (!fp || !existingPaths.has(fp)) {
                    chubCharacters.push(node);
                    if (fp) existingPaths.add(fp);
                }
            }
        }
        
        chubHasMore = (data.data?.cursor ?? data.cursor) != null && nodes.length > 0;
        const wasAppend = chubCurrentPage > 1;
        
        // When "hide owned" is active, auto-fetch additional pages if too many
        // cards were filtered out, so the grid doesn't look sparse.
        // Targets a full page (24) of visible cards per user action; capped at
        // 3 extra fetches to avoid runaway requests when most results are owned.
        // Cost: up to 3 additional lightweight search API calls (JSON-only, no
        // image data). The extra card objects in chubCharacters are ~1-2 KB each
        // and the bidirectional image observer already manages decoded-image memory.
        if (chubFilterHideOwned && chubHasMore) {
            let visibleNew = nodes.filter(c => !isCharInLocalLibrary(c)).length;
            let autoFetches = 0;
            const existingPaths = new Set(chubCharacters.map(c => getChubFullPath(c)).filter(Boolean));
            
            while (visibleNew < 48 && chubHasMore && autoFetches < 3 && chubDelegatesInitialized) {
                autoFetches++;
                chubCurrentPage++;
                params.set('page', chubCurrentPage.toString());
                
                const moreRes = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                    method: 'GET',
                    headers
                });
                if (!moreRes.ok) break;
                
                const moreData = await moreRes.json();
                let moreNodes = [];
                if (moreData.nodes) moreNodes = moreData.nodes;
                else if (moreData.data?.nodes) moreNodes = moreData.data.nodes;
                else if (Array.isArray(moreData.data)) moreNodes = moreData.data;
                else if (Array.isArray(moreData)) moreNodes = moreData;
                
                for (const node of moreNodes) {
                    const fp = getChubFullPath(node);
                    if (!fp || !existingPaths.has(fp)) {
                        chubCharacters.push(node);
                        if (fp) existingPaths.add(fp);
                    }
                }
                chubHasMore = (moreData.data?.cursor ?? moreData.cursor) != null && moreNodes.length > 0;
                visibleNew += moreNodes.filter(c => !isCharInLocalLibrary(c)).length;
            }
            
            if (autoFetches > 0) {
                debugLog(`[ChubAI] Auto-fetched ${autoFetches} extra page(s) to compensate for "hide owned" filter (${visibleNew} visible)`);
            }
        }
        
        renderChubGrid(wasAppend);
        
        // Show/hide load more button
        chubBrowseView.updateLoadMoreVisibility('chubLoadMore', chubHasMore, chubCharacters.length > 0);
        
    } catch (e) {
        console.error('ChubAI load error:', e);
        if (chubCurrentPage === 1) {
            grid.innerHTML = `
                <div class="browse-error">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load ChubAI</h3>
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
        chubIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

/**
 * Fetch and cache user's favorite character IDs
 * Used for filtering in timeline view
 */
async function fetchChubUserFavoriteIds() {
    if (!chubToken) {
        chubUserFavoriteIds = new Set();
        return;
    }
    
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?first=500`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const nodes = data.nodes || data.data || [];
            chubUserFavoriteIds = new Set(nodes.map(n => n.id || n.project_id).filter(Boolean));
            debugLog('[ChubAI] Cached', chubUserFavoriteIds.size, 'favorite IDs');
        }
    } catch (e) {
        debugLog('[ChubAI] Failed to fetch favorite IDs:', e.message);
    }
}

/**
 * Load user's favorites from ChubAI gateway API
 * This uses a different endpoint than the search API
 */
async function loadChubFavorites(forceRefresh = false) {
    const grid = document.getElementById('chubGrid');
    const loadMoreContainer = document.getElementById('chubLoadMore');
    
    if (chubCurrentPage === 1) {
        renderLoadingState(grid, 'Loading your favorites...', 'browse-loading');
    }
    
    chubIsLoading = true;
    
    try {
        // Use gateway API to fetch favorites directly
        const params = new URLSearchParams();
        params.set('first', '100'); // Get more items per page from favorites
        
        if (chubCurrentPage > 1) {
            params.set('page', chubCurrentPage.toString());
        }
        
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?${params.toString()}`;
        debugLog('[ChubAI] Loading favorites from:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load favorites: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('[ChubAI] Favorites response:', data);
        
        // Extract nodes from response
        let nodes = data.nodes || data.data || [];
        
        // Apply additional filters client-side
        if (chubFilterImages) {
            nodes = nodes.filter(c => c.hasGallery || c.has_gallery);
        }
        if (chubFilterLore) {
            nodes = nodes.filter(c => c.has_lore || c.related_lorebooks?.length > 0);
        }
        if (chubFilterExpressions) {
            nodes = nodes.filter(c => c.has_expression_pack);
        }
        if (chubFilterGreetings) {
            nodes = nodes.filter(c => c.alternate_greetings?.length > 0 || c.n_greetings > 1);
        }
        if (chubFilterHideOwned) {
            nodes = nodes.filter(c => !isCharInLocalLibrary(c));
        }
        
        // Apply NSFW filter
        if (!chubNsfwEnabled) {
            nodes = nodes.filter(c => !c.nsfw);
        }
        
        // Apply tag filters client-side (favorites API doesn't support topics param)
        if (chubTagFilters.size > 0) {
            const includeTags = [];
            const excludeTags = [];
            for (const [tag, state] of chubTagFilters) {
                if (state === 'include') includeTags.push(tag.toLowerCase());
                else if (state === 'exclude') excludeTags.push(tag.toLowerCase());
            }
            if (includeTags.length > 0 || excludeTags.length > 0) {
                nodes = nodes.filter(c => {
                    const charTopics = (c.topics || []).map(t => t.toLowerCase());
                    if (includeTags.length > 0 && !includeTags.every(t => charTopics.includes(t))) return false;
                    if (excludeTags.length > 0 && excludeTags.some(t => charTopics.includes(t))) return false;
                    return true;
                });
            }
        }
        
        // Apply search filter if any
        if (chubCurrentSearch) {
            const search = chubCurrentSearch.toLowerCase();
            nodes = nodes.filter(c => {
                const name = (c.name || '').toLowerCase();
                const creator = (c.fullPath?.split('/')[0] || '').toLowerCase();
                const tagline = (c.tagline || '').toLowerCase();
                return name.includes(search) || creator.includes(search) || tagline.includes(search);
            });
        }
        
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
        } else {
            // Push new items instead of spread-copying the entire array
            for (const node of nodes) chubCharacters.push(node);
        }
        
        // Check if there's more data
        chubHasMore = data.cursor !== null && nodes.length > 0;
        
        renderChubGrid(chubCurrentPage > 1);
        
        // Show/hide load more button
        chubBrowseView.updateLoadMoreVisibility('chubLoadMore', chubHasMore, chubCharacters.length > 0);
        
    } catch (e) {
        console.error('[ChubAI] Favorites load error:', e);
        if (chubCurrentPage === 1) {
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load favorites</h3>
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
        chubIsLoading = false;
    }
}

function renderChubGrid(appendOnly = false) {
    const grid = document.getElementById('chubGrid');
    
    // Apply client-side "hide owned" filter (other filters are server-side)
    let displayCharacters = chubCharacters;
    if (chubFilterHideOwned) {
        displayCharacters = chubCharacters.filter(c => !isCharInLocalLibrary(c));
    }
    
    if (displayCharacters.length === 0) {
        chubGridRenderedCount = 0;
        chubCardLookup.clear();
        if (chubImageObserver) chubImageObserver.disconnect();
        const message = chubCharacters.length > 0 && chubFilterHideOwned
            ? 'All characters in this view are already in your library.'
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

    buildChubLookup(chubCardLookup, displayCharacters);

    if (appendOnly && chubGridRenderedCount > 0 && chubGridRenderedCount < displayCharacters.length) {
        // Only append new cards instead of rebuilding the entire grid
        const newChars = displayCharacters.slice(chubGridRenderedCount);
        if (newChars.length > 0) {
            grid.insertAdjacentHTML('beforeend', newChars.map(char => createChubCard(char)).join(''));
        }
    } else {
        // Full re-render: disconnect all tracked images before replacing DOM
        if (chubImageObserver) chubImageObserver.disconnect();
        grid.innerHTML = displayCharacters.map(char => createChubCard(char)).join('');
    }

    chubGridRenderedCount = displayCharacters.length;
    eagerLoadVisibleChubImages(grid);
    observeChubImages(grid);
}

function setupChubGridDelegates() {
    if (chubDelegatesInitialized) return;

    const grid = document.getElementById('chubGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            if (e.target.closest('.browse-retry-btn')) { loadChubCharacters(true); return; }

            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const fullPath = card.dataset.fullPath;
            const char = chubCardLookup.get(fullPath) || chubCharacters.find(c => getChubFullPath(c) === fullPath);
            if (char) openChubCharPreview(char);
        });
    }

    const timelineGrid = document.getElementById('chubTimelineGrid');
    if (timelineGrid) {
        timelineGrid.addEventListener('click', (e) => {
            if (e.target.closest('.browse-retry-btn')) { loadChubTimeline(true); return; }
            if (e.target.closest('.browse-add-token-btn')) { openChubTokenModal(); return; }

            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const fullPath = card.dataset.fullPath;
            const char = chubTimelineLookup.get(fullPath) || chubTimelineCharacters.find(c => getChubFullPath(c) === fullPath);
            if (char) openChubCharPreview(char);
        });
    }

    chubDelegatesInitialized = true;
}

function createChubCard(char, isTimeline = false) {
    const name = char.name || 'Unknown';
    const fullPath = getChubFullPath(char);
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    const rating = char.rating ? char.rating.toFixed(1) : '0.0';
    const ratingCount = char.ratingCount || 0;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloads = formatNumber(char.starCount || 0);
    const favorites = formatNumber(char.n_favorites || char.nFavorites || 0);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/ai4.png');
    
    // Check if this character is in local library
    const inLibrary = isCharInLocalLibrary(char);
    
    // Get up to 3 tags
    const tags = (char.topics || []).slice(0, 3);
    
    // Build feature badges
    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (char.hasGallery) {
        badges.push('<span class="browse-feature-badge gallery" title="Has Gallery"><i class="fa-solid fa-images"></i></span>');
    }
    if (char.has_lore || char.related_lorebooks?.length > 0) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }
    if (char.has_expression_pack) {
        badges.push('<span class="browse-feature-badge" title="Has Expressions"><i class="fa-solid fa-face-smile"></i></span>');
    }
    if (char.alternate_greetings?.length > 0 || char.n_greetings > 1) {
        badges.push('<span class="browse-feature-badge" title="Alt Greetings"><i class="fa-solid fa-comment-dots"></i></span>');
    }
    if (char.recommended || char.verified) {
        badges.push('<span class="browse-feature-badge verified" title="Verified"><i class="fa-solid fa-check-circle"></i></span>');
    }
    
    // Show date on cards - createdAt for all cards
    const createdDate = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    
    // Add "in library" class to card for potential styling
    const cardClass = inLibrary ? 'browse-card in-library' : 'browse-card';
    
    // Tagline for hover tooltip (escape for HTML attribute)
    const taglineTooltip = char.tagline ? escapeHtml(char.tagline) : '';
    
    return `
        <div class="${cardClass}" data-full-path="${escapeHtml(fullPath)}" ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${char.nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                <span class="browse-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="${ratingCount} rating${ratingCount !== 1 ? 's' : ''}"><i class="fa-solid fa-star"></i> ${rating}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${downloads}</span>
                <span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${favorites}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}


function applyChubTagsClamp(tagsEl) {
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
        const tagBottom = tag.offsetTop + tag.offsetHeight;
        if (tagBottom > maxHeight + 2) {
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
        const isCollapsed = tagsEl.classList.contains('browse-tags-collapsed');
        if (isCollapsed) {
            tagsEl.classList.remove('browse-tags-collapsed');
            tagsEl.classList.add('browse-tags-expanded');
            tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyChubTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) {
        tags[i].classList.add('browse-tag-hidden');
    }
}

function abortChubDetailFetch() {
    if (chubDetailFetchController) {
        try { chubDetailFetchController.abort(); } catch (e) { /* ignore */ }
        chubDetailFetchController = null;
    }
}

async function openChubCharPreview(char) {
    // Abort any in-flight detail fetch from a previous preview
    abortChubDetailFetch();
    chubSelectedChar = char;
    
    const modal = document.getElementById('chubCharModal');
    const avatarImg = document.getElementById('chubCharAvatar');
    const nameEl = document.getElementById('chubCharName');
    const creatorLink = document.getElementById('chubCharCreator');
    const ratingEl = document.getElementById('chubCharRating');
    const downloadsEl = document.getElementById('chubCharDownloads');
    const tagsEl = document.getElementById('chubCharTags');
    const tokensEl = document.getElementById('chubCharTokens');
    const dateEl = document.getElementById('chubCharDate');
    const descEl = document.getElementById('chubCharDescription');
    const taglineSection = document.getElementById('chubCharTaglineSection');
    const taglineEl = document.getElementById('chubCharTagline');
    const openInBrowserBtn = document.getElementById('chubOpenInBrowserBtn');
    
    // Creator's Notes (public ChubAI description - always visible at top)
    const creatorNotesEl = document.getElementById('chubCharCreatorNotes');
    
    // Definition sections (from detailed fetch)
    const greetingsStat = document.getElementById('chubCharGreetingsStat');
    const greetingsCount = document.getElementById('chubCharGreetingsCount');
    const lorebookStat = document.getElementById('chubCharLorebookStat');
    const descSection = document.getElementById('chubCharDescriptionSection');
    // descEl already defined above
    const personalitySection = document.getElementById('chubCharPersonalitySection');
    const scenarioSection = document.getElementById('chubCharScenarioSection');
    const scenarioEl = document.getElementById('chubCharScenario');
    const firstMsgSection = document.getElementById('chubCharFirstMsgSection');
    const firstMsgEl = document.getElementById('chubCharFirstMsg');
    const examplesSection = document.getElementById('chubCharExamplesSection');
    const examplesEl = document.getElementById('chubCharExamples');
    const altGreetingsSection = document.getElementById('chubCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('chubCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('chubCharAltGreetingsCount');

    const galleryStat = document.getElementById('chubCharGalleryStat');
    const galleryCountEl = document.getElementById('chubCharGalleryCount');
    const gallerySection = document.getElementById('chubCharGallerySection');
    const galleryGrid = document.getElementById('chubCharGalleryGrid');
    const galleryLabel = document.getElementById('chubCharGalleryLabel');
    
    const fullPath = getChubFullPath(char);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/ai4.png');
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    nameEl.textContent = char.name || 'Unknown';
    creatorLink.textContent = creatorName;
    creatorLink.href = '#'; // In-app filter action
    creatorLink.title = `Click to see all characters by ${creatorName}`;
    creatorLink.onclick = (e) => {
        e.preventDefault();
        modal.classList.add('hidden');
        filterByAuthor(creatorName);
    };
    // External link to author's ChubAI profile
    const creatorExternal = document.getElementById('chubCreatorExternal');
    if (creatorExternal) {
        creatorExternal.href = `https://chub.ai/users/${creatorName}`;
    }
    openInBrowserBtn.href = `https://chub.ai/characters/${fullPath}`;
    const ratingCount = char.ratingCount || 0;
    ratingEl.innerHTML = `<i class="fa-solid fa-star"></i> ${char.rating ? char.rating.toFixed(1) : '0.0'}`;
    ratingEl.title = `${ratingCount} rating${ratingCount !== 1 ? 's' : ''}`;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloadCount = char.starCount || 0;
    const favoritesCount = char.n_favorites || char.nFavorites || 0;
    downloadsEl.innerHTML = `<i class="fa-solid fa-download"></i> ${formatNumber(downloadCount)}`;
    downloadsEl.title = 'Downloads';
    
    // Tags
    const tags = char.topics || [];
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyChubTagsClamp(tagsEl));
    
    // Stats
    tokensEl.textContent = formatNumber(char.nTokens || 0);
    dateEl.textContent = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : 'Unknown';
    
    // Favorite button - n_favorites is the actual favorite count
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    favoriteCountEl.textContent = formatNumber(favoritesCount);
    
    // Check if user has favorited this character (requires token)
    updateChubFavoriteButton(char);
    
    // Creator's Notes (public ChubAI listing description) - use secure iframe renderer
    renderCreatorNotesSecure(char.description || char.tagline || 'No description available.', char.name, creatorNotesEl);
    
    // Tagline
    if (char.tagline && char.tagline !== char.description) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = sanitizeTaglineHtml(char.tagline, char.name);
    } else {
        taglineSection.style.display = 'none';
    }
    
    // Greetings count
    const numGreetings = char.n_greetings || (char.alternate_greetings?.length ? char.alternate_greetings.length + 1 : 1);
    if (numGreetings > 1) {
        greetingsStat.style.display = 'flex';
        greetingsCount.textContent = numGreetings;
    } else {
        greetingsStat.style.display = 'none';
    }
    
    // Lorebook indicator
    if (char.has_lore || char.related_lorebooks?.length > 0) {
        lorebookStat.style.display = 'flex';
    } else {
        lorebookStat.style.display = 'none';
    }

    // Gallery stat — hidden until detail data loads with actual count
    if (galleryStat) galleryStat.style.display = 'none';
    
    // Reset definition sections — show loading indicator until detail fetch completes
    const defLoading = document.getElementById('chubCharDefinitionLoading');
    descSection.style.display = 'none';
    personalitySection.style.display = 'none';
    scenarioSection.style.display = 'none';
    examplesSection.style.display = 'none';
    firstMsgSection.style.display = 'none';
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';
    if (gallerySection) gallerySection.style.display = 'none';
    if (galleryGrid) galleryGrid.innerHTML = '';
    if (defLoading) defLoading.style.display = 'block';
    
    // Import button state — show "In Library" if already imported
    const downloadBtn = document.getElementById('chubDownloadBtn');
    if (downloadBtn) {
        if (isCharInLocalLibrary(char)) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
            downloadBtn.classList.add('secondary');
            downloadBtn.classList.remove('primary');
        } else {
            downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
            downloadBtn.classList.add('primary');
            downloadBtn.classList.remove('secondary');
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
            window.currentBrowseAltGreetings = [];
            return;
        }
        const buildPreview = (text) => {
            const cleaned = (text || '').replace(/\s+/g, ' ').trim();
            if (!cleaned) return 'No content';
            return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
        };
        altGreetingsSection.style.display = 'block';
        // Build HTML with empty bodies — content is rendered lazily on toggle to save memory
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
        // Lazy-render greeting body on first open (avoids formatRichText for ALL greetings at once)
        altGreetingsEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
            details.addEventListener('toggle', function onToggle() {
                if (!details.open) return;
                const body = details.querySelector('.browse-alt-greeting-body');
                if (body && !body.dataset.rendered) {
                    const idx = parseInt(details.dataset.greetingIdx, 10);
                    if (greetings[idx] != null) {
                        body.innerHTML = DOMPurify.sanitize(formatRichText(greetings[idx], char.name, true), BROWSE_PURIFY_CONFIG);
                    }
                    body.dataset.rendered = '1';
                }
            }, { once: true });
        });
        if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${greetings.length})`;
        window.currentBrowseAltGreetings = greetings;
    };

    // Render from basic data if already present
    renderAltGreetings(char.alternate_greetings || []);

    const applyDetailData = (node) => {
        if (!node) return;
        const def = node.definition || {};

        // Clear the loading indicator
        if (defLoading) defLoading.style.display = 'none';

        // Update Creator's Notes if node has better/different description than search result
        // node.description is the PUBLIC listing description (Creator's Notes)
        if (node.description && node.description !== char.description) {
            renderCreatorNotesSecure(node.description, char.name, creatorNotesEl);
        }

        // Character Definition (def.personality in ChubAI API = character description/definition for prompt)
        // This is confusingly named in ChubAI's API - "personality" is actually the main character definition
        if (def.personality) {
            descSection.style.display = 'block';
            descEl.innerHTML = DOMPurify.sanitize(formatRichText(def.personality, char.name, true), BROWSE_PURIFY_CONFIG);
            descEl.dataset.fullContent = def.personality;
        }

        // Scenario
        if (def.scenario) {
            scenarioSection.style.display = 'block';
            scenarioEl.innerHTML = DOMPurify.sanitize(formatRichText(def.scenario, char.name, true), BROWSE_PURIFY_CONFIG);
            scenarioEl.dataset.fullContent = def.scenario;
        }

        // Example Dialogs
        if (def.mes_example) {
            examplesSection.style.display = 'block';
            examplesEl.innerHTML = DOMPurify.sanitize(formatRichText(def.mes_example, char.name, true), BROWSE_PURIFY_CONFIG);
            examplesEl.dataset.fullContent = def.mes_example;
        }

        // First message - ChubAI uses first_message, not first_mes
        const firstMsg = def.first_message || def.first_mes;
        if (firstMsg) {
            firstMsgSection.style.display = 'block';
            firstMsgEl.innerHTML = DOMPurify.sanitize(formatRichText(firstMsg, char.name, true), BROWSE_PURIFY_CONFIG);
            firstMsgEl.dataset.fullContent = firstMsg;
        }

        // Update greetings count if we have better data
        if (def.alternate_greetings?.length > 0) {
            greetingsStat.style.display = 'flex';
            greetingsCount.textContent = def.alternate_greetings.length + 1;
        }

        // Alternate greetings list
        if (def.alternate_greetings) {
            renderAltGreetings(def.alternate_greetings);
        }

        // Gallery
        if (node.galleryImages?.length > 0) {
            const count = node.galleryImages.length;
            if (galleryStat) {
                galleryStat.style.display = 'flex';
                if (galleryCountEl) galleryCountEl.textContent = count;
            }
            if (gallerySection && galleryGrid) {
                gallerySection.style.display = 'block';
                if (galleryLabel) galleryLabel.textContent = `(${count})`;
                galleryGrid.innerHTML = node.galleryImages.map(img =>
                    `<img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="Gallery image" title="Gallery image" loading="lazy" onerror="this.style.display='none'">`
                ).join('');
            }
        }
    };

    const cachedDetail = fullPath ? chubDetailCache.get(fullPath) : null;
    if (cachedDetail) {
        // LRU refresh: move to end of Map insertion order
        chubDetailCache.delete(fullPath);
        chubDetailCache.set(fullPath, cachedDetail);
        applyDetailData(cachedDetail);
    }

    if (!cachedDetail && fullPath) {
        // Try to fetch detailed character info
        chubDetailFetchController = new AbortController();
        const fetchSignal = chubDetailFetchController.signal;
        try {
            const detailUrl = `https://api.chub.ai/api/characters/${fullPath}?full=true`;

            // Fetch definition and gallery in parallel
            const galleryHeaders = { 'Accept': 'application/json' };
            if (chubToken) {
                galleryHeaders['samwise'] = chubToken;
                galleryHeaders['CH-API-KEY'] = chubToken;
            }
            const charProjectId = char.id || char.project_id;
            const galleryPromise = char.hasGallery && charProjectId
                ? fetch(`${CHUB_GATEWAY_BASE}/api/gallery/project/${charProjectId}?limit=100&count=false`, {
                    headers: galleryHeaders, signal: fetchSignal
                }).then(r => r.ok ? r.json() : { nodes: [] })
                  .then(data => (data.nodes || []).map(n => ({ url: n.primary_image_path, id: n.uuid, nsfw: n.nsfw_image || false })))
                  .catch(err => { debugLog('[ChubAI] Gallery fetch failed:', err.message); return []; })
                : Promise.resolve([]);

            const [response, galleryImages] = await Promise.all([
                fetch(detailUrl, { signal: fetchSignal }),
                galleryPromise,
            ]);

            if (response.ok) {
                const detailData = await response.json();
                // If modal was closed or a different character was opened while 
                // we were fetching, discard the result to avoid stale rendering
                if (fetchSignal.aborted || chubSelectedChar !== char) {
                    debugLog('[ChubAI] Detail fetch completed but modal moved on — discarding');
                } else {
                    const node = detailData.node || detailData;
                    // Strip heavy data we never display — character_book (lorebook) can be
                    // 100KB-1MB by itself, mes_example and extensions add more.
                    // Only keep fields actually used in applyDetailData.
                    const stripped = {
                        description: node.description,
                        definition: node.definition ? {
                            personality: node.definition.personality,
                            scenario: node.definition.scenario,
                            mes_example: node.definition.mes_example,
                            first_message: node.definition.first_message,
                            first_mes: node.definition.first_mes,
                            alternate_greetings: node.definition.alternate_greetings,
                        } : undefined,
                        galleryImages: galleryImages?.length > 0 ? galleryImages : undefined,
                    };
                    // Enforce LRU cap — evict oldest entries
                    while (chubDetailCache.size >= CHUB_DETAIL_CACHE_MAX) {
                        const oldestKey = chubDetailCache.keys().next().value;
                        chubDetailCache.delete(oldestKey);
                    }
                    chubDetailCache.set(fullPath, stripped);
                    applyDetailData(stripped);
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                debugLog('[ChubAI] Detail fetch aborted (modal closed)');
            } else {
                debugLog('[ChubAI] Could not fetch detailed character info:', e.message);
                if (chubSelectedChar === char && defLoading) {
                    defLoading.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
                }
            }
        }
    }
}

/**
 * Update the favorite button state for ChubAI character
 */
async function updateChubFavoriteButton(char) {
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    if (!favoriteBtn) return;
    
    // Reset state
    favoriteBtn.classList.remove('favorited', 'loading');
    favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
    
    // If no token, show but disable with tooltip
    if (!chubToken) {
        favoriteBtn.title = 'Login to ChubAI to add favorites';
        return;
    }
    
    favoriteBtn.title = 'Add to favorites on ChubAI';
    
    // If we already know the favorited state (from previous check or toggle), use it
    if (char._isFavorited === true) {
        favoriteBtn.classList.add('favorited');
        favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
        favoriteBtn.title = 'Remove from favorites on ChubAI';
        return;
    } else if (char._isFavorited === false) {
        // Already checked and not favorited
        return;
    }
    
    // Check if user has favorited this character via API
    try {
        const charId = char.id || char.project_id;
        if (!charId) {
            debugLog('[ChubAI] Cannot check favorite status: no character id');
            return;
        }
        
        favoriteBtn.classList.add('loading');
        
        // Try to get user's favorites list and check if this char is in it
        // The gateway endpoint might not support GET for single item, so we check differently
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?first=500`;
        debugLog('[ChubAI] Checking favorites list for:', charId);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            }
        });
        
        favoriteBtn.classList.remove('loading');
        
        if (response.ok) {
            const data = await response.json();
            debugLog('[ChubAI] Favorites response:', data);
            
            // Check if this character's ID is in the favorites list
            let isFavorited = false;
            const nodes = data.nodes || data.data || data || [];
            if (Array.isArray(nodes)) {
                isFavorited = nodes.some(fav => {
                    const favId = fav.id || fav.project_id || fav.node?.id;
                    return favId === charId || String(favId) === String(charId);
                });
            }
            
            // Store state on character for persistence
            char._isFavorited = isFavorited;
            
            if (isFavorited) {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
                favoriteBtn.title = 'Remove from favorites on ChubAI';
                debugLog('[ChubAI] Character is in favorites');
            } else {
                char._isFavorited = false;
                debugLog('[ChubAI] Character is NOT in favorites');
            }
        } else {
            debugLog('[ChubAI] Favorites check failed:', response.status);
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        debugLog('[ChubAI] Could not check favorite status:', e.message);
    }
}

/**
 * Toggle favorite for the currently selected ChubAI character
 */
async function toggleChubCharFavorite() {
    if (!chubSelectedChar || !chubToken) {
        if (!chubToken) {
            showToast('Login to ChubAI to add favorites', 'info');
            openChubTokenModal();
        }
        return;
    }
    
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    if (!favoriteBtn) return;
    
    // ChubAI favorites API uses numeric project id at gateway.chub.ai
    const charId = chubSelectedChar.id || chubSelectedChar.project_id;
    if (!charId) {
        showToast('Cannot favorite this character - missing ID', 'error');
        return;
    }
    
    const isCurrentlyFavorited = favoriteBtn.classList.contains('favorited');
    
    favoriteBtn.classList.add('loading');
    
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites/${charId}`;
        debugLog('[ChubAI] Toggle favorite:', isCurrentlyFavorited ? 'DELETE' : 'POST', url);
        
        const response = await fetch(url, {
            method: isCurrentlyFavorited ? 'DELETE' : 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'samwise': chubToken,
                'CH-API-KEY': chubToken
            },
            body: '{}'  // ChubAI expects empty JSON body
        });
        
        favoriteBtn.classList.remove('loading');
        
        debugLog('[ChubAI] Favorite toggle response:', response.status, response.statusText);
        
        if (response.ok) {
            const responseData = await response.json().catch(() => ({}));
            debugLog('[ChubAI] Favorite toggle success data:', responseData);
            
            if (isCurrentlyFavorited) {
                favoriteBtn.classList.remove('favorited');
                favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
                favoriteBtn.title = 'Add to favorites on ChubAI';
                // Update stored state
                chubSelectedChar._isFavorited = false;
                // Decrement count
                const currentCount = parseInt(favoriteCountEl.textContent.replace(/[KM]/g, '')) || 0;
                if (currentCount > 0) {
                    chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 1) - 1;
                    favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                }
                showToast('Removed from ChubAI favorites', 'info');
            } else {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
                favoriteBtn.title = 'Remove from favorites on ChubAI';
                // Update stored state
                chubSelectedChar._isFavorited = true;
                // Increment count
                chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 0) + 1;
                favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                showToast('Added to ChubAI favorites!', 'success');
            }
        } else {
            const errorText = await response.text().catch(() => '');
            console.error('[ChubAI] Favorite toggle error response:', response.status, errorText);
            const errorData = JSON.parse(errorText || '{}');
            showToast(errorData.message || `Failed to update favorite (${response.status})`, 'error');
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        console.error('[ChubAI] Favorite toggle error:', e);
        showToast('Failed to update favorite', 'error');
    }
}

/**
 * Clean up memory held by the ChubAI character modal.
 * Releases window globals, dataset.fullContent, alt greetings HTML, and iframe content.
 * Critical for mobile where memory is limited.
 */
function cleanupChubCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;

    const defLoading = document.getElementById('chubCharDefinitionLoading');
    if (defLoading) { defLoading.style.display = 'none'; defLoading.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>'; }
    
    const modal = document.getElementById('chubCharModal');
    if (modal) {
        // Clear heavy dataset.fullContent stored on DOM elements
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });
        
        // Clear all rendered section content (can hold large formatRichText HTML)
        const sectionIds = [
            'chubCharAltGreetings',
            'chubCharDescription',
            'chubCharScenario',
            'chubCharFirstMsg',
            'chubCharTagline',
            'chubCharGalleryGrid',
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        
        // Clear creator notes iframe — disconnect ResizeObserver and release its document
        const creatorNotesEl = document.getElementById('chubCreatorNotes');
        cleanupCreatorNotesContainer(creatorNotesEl);
    }
    chubSelectedChar = null;
}

async function downloadChubCharacter() {
    if (!chubSelectedChar) return;
    
    abortChubDetailFetch();
    
    const downloadBtn = document.getElementById('chubDownloadBtn');
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    downloadBtn.disabled = true;
    
    let inheritedGalleryId = null;
    
    try {
        const fullPath = chubSelectedChar.fullPath;
        const characterName = chubSelectedChar.name || fullPath.split('/').pop();
        const characterCreator = fullPath.split('/')[0] || '';

        // Use cached detail data from the preview panel for richer comparison
        const cachedDetail = chubDetailCache.get(fullPath);
        const definition = cachedDetail?.definition;

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = checkCharacterForDuplicates({
            name: characterName,
            creator: characterCreator,
            fullPath: fullPath,
            description: cachedDetail?.description || chubSelectedChar.description || '',
            first_mes: definition?.first_message || definition?.first_mes || '',
            personality: definition?.personality || '',
            scenario: definition?.scenario || ''
        });
        
        if (duplicateMatches.length > 0) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';
            
            const result = await showPreImportDuplicateWarning({
                name: characterName,
                creator: characterCreator,
                fullPath: fullPath,
                avatarUrl: chubSelectedChar.avatar_url || `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp`
            }, duplicateMatches);
            
            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                return;
            }
            
            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (inheritedGalleryId) {
                    debugLog('[ChubDownload] Inheriting gallery_id from replaced character:', inheritedGalleryId);
                }
                downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (deleteSuccess) {
                    debugLog('[ChubDownload] Deleted existing character:', toReplace.avatar);
                } else {
                    console.warn('[ChubDownload] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===
        
        downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';

        const provider = CoreAPI.getProvider('chub');
        if (!provider?.importCharacter) throw new Error('Chub provider not available');

        const result = await provider.importCharacter(fullPath, chubSelectedChar, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        // Close the character modal and free preview data
        cleanupChubCharModal();
        document.getElementById('chubCharModal').classList.add('hidden');

        await new Promise(r => requestAnimationFrame(r));
        
        showToast(`Downloaded "${result.characterName}" successfully!`, 'success');
        
        // Show import summary if character has gallery or embedded media
        const localAvatarFileName = result.fileName;
        const hasGallery = result.hasGallery;
        const mediaUrls = result.embeddedMediaUrls || [];
        
        if ((hasGallery || mediaUrls.length > 0) && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                galleryCharacters: hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: `https://chub.ai/characters/${result.fullPath}`,
                    avatar: localAvatarFileName,
                    galleryId: result.galleryId
                }] : [],
                mediaCharacters: mediaUrls.length > 0 ? [{
                    name: result.characterName,
                    avatar: localAvatarFileName,
                    avatarUrl: result.avatarUrl,
                    mediaUrls: mediaUrls,
                    galleryId: result.galleryId
                }] : []
            });
        }
        
        // === REFRESH + SYNC ===
        await new Promise(r => setTimeout(r, 200));
        const added = await fetchAndAddCharacter(localAvatarFileName);
        if (!added) {
            await new Promise(r => setTimeout(r, 500));
            await fetchCharacters(true);
        }
        buildLocalLibraryLookup();
        markChubCardAsImported(fullPath);
        
        // Also refresh main ST window's character list (fire-and-forget)
        try {
            if (window.opener && !window.opener.closed && window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                const context = window.opener.SillyTavern.getContext();
                if (context && typeof context.getCharacters === 'function') {
                    debugLog('[ChubDownload] Triggering character refresh in main window...');
                    context.getCharacters().catch(e => console.warn('[ChubDownload] Main window refresh failed:', e));
                }
            }
        } catch (e) {
            console.warn('[ChubDownload] Could not access main window:', e);
        }
        
    } catch (e) {
        console.error('[ChubDownload] Download error:', e);
        showToast('Download failed: ' + e.message, 'error');
    } finally {
        downloadBtn.innerHTML = originalHtml;
        downloadBtn.disabled = false;
    }
}

// ========================================
// WINDOW EXPORTS
// Functions called from library.js
// ========================================

window.openChubCharPreview = openChubCharPreview;

// ========================================
// SINGLETON EXPORT
// ========================================

const chubBrowseView = new ChubBrowseView();
export default chubBrowseView;

