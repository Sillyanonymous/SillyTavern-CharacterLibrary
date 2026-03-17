// WyvernBrowseView — Wyvern browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, fetchWithProxy } from '../provider-utils.js';
import {
    WYVERN_API_BASE,
    WYVERN_SITE_BASE,
    getWyvernHeaders,
    getAvatarUrl,
    getCharacterPageUrl,
    firebaseSignIn,
    firebaseRefreshToken,
    getTokenTTL,
} from './wyvern-api.js';

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

let wyvernCharacters = [];
let wyvernCurrentPage = 1;
let wyvernHasMore = true;
let wyvernIsLoading = false;
let wyvernCurrentSort = 'popular';
let wyvernCurrentSearch = '';
let wyvernSelectedChar = null;
let wyvernToken = null;
let wyvernNsfwEnabled = false;
let wyvernRefreshTimer = null;
let wyvernLoginInProgress = false;

let wyvernTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>
let wyvernFilterHideOwned = false;
let wyvernFilterHasLorebook = false;
let wyvernFilterHasAltGreetings = false;

let wyvernViewMode = 'browse';
let wyvernFollowingCharacters = [];
let wyvernFollowingLoading = false;
let wyvernCreatorFilter = null; // { uid, displayName, vanityUrl }
let wyvernCreatorSort = 'created_at';
let wyvernIsFollowingCurrentCreator = false;

let wyvernCardLookup = new Map();
let wyvernDelegatesInitialized = false;
let wyvernModalEventsAttached = false;
let wyvernDetailFetchController = null;
const wyvernDetailCache = new Map();
const WYVERN_DETAIL_CACHE_MAX = 5;

let wyvernGridRenderedCount = 0;

let wyvernImageObserver = null;

let localLibraryLookup = {
    byNameAndCreator: new Set(),
    byWyvernId: new Set()
};

function getCharStats(char) {
    const sr = char.statistics_record || char.entity_statistics || {};
    return {
        views: sr.views || sr.total_views || char.views || 0,
        likes: sr.likes || sr.total_likes || char.likes || 0,
        messages: sr.messages || sr.total_messages || char.messages || 0,
    };
}

function buildLocalLibraryLookup() {
    localLibraryLookup.byNameAndCreator.clear();
    localLibraryLookup.byWyvernId.clear();

    for (const char of getAllCharacters()) {
        if (!char) continue;

        const name = (char.name || '').toLowerCase().trim();
        const creator = (char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) {
            localLibraryLookup.byNameAndCreator.add(`${name}|${creator}`);
        }

        const wyvernData = char.data?.extensions?.wyvern;
        if (wyvernData?.id) {
            localLibraryLookup.byWyvernId.add(wyvernData.id);
        }
    }

    debugLog('[WyvernLibrary] Built lookup:',
        'nameCreators:', localLibraryLookup.byNameAndCreator.size,
        'wyvernIds:', localLibraryLookup.byWyvernId.size);
}

function isCharInLocalLibrary(wyvernChar) {
    const charId = wyvernChar.id || '';
    const name = (wyvernChar.name || '').toLowerCase().trim();
    const creator = (wyvernChar.creator?.displayName || wyvernChar.creator?.username || '').toLowerCase().trim();

    if (charId && localLibraryLookup.byWyvernId.has(charId)) {
        return true;
    }

    if (name && creator && localLibraryLookup.byNameAndCreator.has(`${name}|${creator}`)) {
        return true;
    }

    return false;
}

function markWyvernCardAsImported(charId) {
    const grid = document.getElementById('wyvernGrid');
    if (!grid || !charId) return;
    const card = grid.querySelector(`[data-char-id="${CSS.escape(charId)}"]`);
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

function applyTagsClamp(tagsEl) {
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
            applyTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) {
        tags[i].classList.add('browse-tag-hidden');
    }
}

function buildWyvernLookup(characters) {
    wyvernCardLookup.clear();
    for (const char of characters) {
        if (char.id) wyvernCardLookup.set(char.id, char);
    }
}

// Popular tags from Wyvern (populated from API results)
let wyvernPopularTags = [];
let wyvernTagsLoaded = false;

class WyvernBrowseView extends BrowseView {

    get previewModalId() { return 'wyvernCharModal'; }

    closePreview() {
        abortWyvernDetailFetch();
        cleanupWyvernCharModal();
        hideModal('wyvernCharModal');
    }

    get mobileFilterIds() {
        return {
            sort: 'wyvernSortSelect',
            tags: 'wyvernTagsBtn',
            filters: 'wyvernFiltersBtn',
            nsfw: 'wyvernNsfwToggle',
            refresh: 'refreshWyvernBtn',
            modeBrowseSelector: '.wyvern-view-btn[data-wyvern-view="browse"]',
            modeFollowSelector: '.wyvern-view-btn[data-wyvern-view="following"]',
            modeBtnClass: 'wyvern-view-btn',
        };
    }

    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular', label: 'Popular' },
                { value: 'nsfw-popular', label: 'Popular NSFW' },
                { value: 'recommended', label: 'Recommended' },
                { value: 'created_at', label: 'New' },
                { value: 'votes', label: 'Most Likes' },
                { value: 'messages', label: 'Most Messages' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    canLoadMore() {
        return wyvernHasMore && !wyvernIsLoading && wyvernViewMode === 'browse';
    }

    loadMore() {
        wyvernCurrentPage++;
        loadWyvernCharacters();
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            <div class="chub-view-toggle">
                <button class="wyvern-view-btn active" data-wyvern-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="wyvern-view-btn" data-wyvern-view="following" title="New from followed authors (requires login)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort dropdown -->
            <div class="browse-sort-container">
                <select id="wyvernSortSelect" class="glass-select" title="Sort characters">
                    <option value="popular" selected>🔥 Popular</option>
                    <option value="nsfw-popular">🔞 Popular NSFW</option>
                    <option value="recommended">⭐ Recommended</option>
                    <option value="created_at">🆕 New</option>
                    <option value="votes">❤️ Most Likes</option>
                    <option value="messages">💬 Most Messages</option>
                </select>
            </div>

            <!-- Tag Filter -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="wyvernTagsBtn" class="glass-btn" title="Filter by tag">
                    <i class="fa-solid fa-tags"></i> <span id="wyvernTagsBtnLabel">Tags</span>
                </button>
                <div id="wyvernTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="wyvernTagsSearchInput" placeholder="Type a tag name..." autocomplete="one-time-code">
                        <button id="wyvernTagsClearBtn" class="glass-btn icon-only" title="Clear tag filter">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="wyvernTagsList"></div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="wyvernFiltersBtn" class="glass-btn" title="Filter options">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="wyvernFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="wyvernFilterLorebook"> <i class="fa-solid fa-book"></i> Lorebook</label>
                    <label class="filter-checkbox"><input type="checkbox" id="wyvernFilterGreetings"> <i class="fa-solid fa-comments"></i> Alt Greetings</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="wyvernFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                </div>
            </div>

            <!-- NSFW Toggle -->
            <button id="wyvernNsfwToggle" class="glass-btn nsfw-toggle" style="opacity: 0.5;">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshWyvernBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="wyvernBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="wyvernSearchInput" placeholder="Search Wyvern characters..." autocomplete="one-time-code">
                        <button id="wyvernClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="wyvernSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="wyvernCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
                            <button id="wyvernCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator Filter Banner -->
                <div id="wyvernCreatorBanner" class="chub-author-banner hidden">
                    <div class="chub-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="wyvernCreatorName"></strong></span>
                    </div>
                    <div class="chub-author-banner-actions">
                        <select id="wyvernCreatorSortSelect" class="glass-select" title="Sort creator's characters">
                            <option value="created_at" selected>🆕 Newest Created</option>
                            <option value="votes">❤️ Most Likes</option>
                            <option value="messages">💬 Most Messages</option>
                        </select>
                        <button id="wyvernFollowCreatorBtn" class="glass-btn" title="Follow this creator on Wyvern">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="wyvernClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="wyvernGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="wyvernLoadMore" style="display: none;">
                    <button id="wyvernLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="wyvernFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from authors you follow</p>
                    </div>
                </div>
                <div id="wyvernFollowingGrid" class="browse-grid"></div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return this._renderLoginModal() + this._renderPreviewModal();
    }

    _renderLoginModal() {
        return `
    <div id="wyvernLoginModal" class="modal-overlay hidden">
        <div class="modal-glass chub-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-dragon"></i> Wyvern Login</h2>
                <button class="close-btn" id="wyvernLoginClose">&times;</button>
            </div>
            <div class="chub-login-body">
                <p class="chub-login-info">
                    <i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i>
                    <strong>Browsing, search, and NSFW Popular sort work without an account!</strong>
                </p>
                <p class="chub-login-info">
                    <i class="fa-solid fa-fire" style="color: var(--accent);"></i>
                    <strong>Log in</strong> to see NSFW content in all sort modes.
                </p>

                <div class="chub-login-form">
                    <div class="form-group">
                        <label for="wyvernLoginEmail">Email</label>
                        <input type="email" id="wyvernLoginEmail" class="glass-input" placeholder="your@email.com" autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label for="wyvernLoginPassword">Password</label>
                        <input type="password" id="wyvernLoginPassword" class="glass-input" placeholder="Password" autocomplete="current-password">
                    </div>
                    <label class="checkbox-label" style="margin-top: 10px;">
                        <input type="checkbox" id="wyvernRememberKey" checked> Remember credentials
                    </label>
                    <div id="wyvernLoginStatus" class="chub-login-status" style="display:none;"></div>
                    <div id="wyvernTokenStatus" class="chub-login-status" style="display:none;"></div>
                </div>

                <div class="chub-login-actions">
                    <button id="wyvernLoginBtn" class="action-btn primary">
                        <i class="fa-solid fa-sign-in-alt"></i> Log In
                    </button>
                    <button id="wyvernLogoutBtn" class="action-btn secondary" style="display:none;">
                        <i class="fa-solid fa-sign-out-alt"></i> Log Out
                    </button>
                    <a href="${WYVERN_SITE_BASE}" target="_blank" class="action-btn secondary">
                        <i class="fa-solid fa-external-link"></i> Wyvern Website
                    </a>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="wyvernCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="wyvernCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="wyvernCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="wyvernCharCreator" href="#" title="Click to see all characters by this author">Creator</a> •
                            <span id="wyvernCharMessages" title="Messages"><i class="fa-solid fa-message"></i> 0</span> •
                            <span id="wyvernCharLikes" title="Likes"><i class="fa-solid fa-heart"></i> 0</span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="wyvernOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on Wyvern">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="wyvernDownloadBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="wyvernCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="wyvernCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="wyvernCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-eye"></i>
                            <span id="wyvernCharViews">0</span> views
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="wyvernCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="wyvernCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="wyvernCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="wyvernCharGalleryStat" style="display: none;">
                            <i class="fa-solid fa-images"></i>
                            <span id="wyvernCharGalleryCount">0</span> gallery
                        </div>
                    </div>
                    <div class="browse-char-tags" id="wyvernCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="wyvernCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="wyvernCharCreatorNotes" class="scrolling-text">
                        No description available.
                    </div>
                </div>

                <!-- Definition loading indicator -->
                <div id="wyvernCharDefinitionLoading" class="browse-char-section" style="display: none;">
                    <div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="wyvernCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="wyvernCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="wyvernCharPersonalitySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="wyvernCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="wyvernCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="wyvernCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="wyvernCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="wyvernCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="wyvernCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="wyvernCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="wyvernCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="wyvernCharAltGreetingsCount"></span>
                    </h3>
                    <div id="wyvernCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="wyvernCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="wyvernCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="wyvernCharGalleryLabel"></span>
                    </h3>
                    <div id="wyvernCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    init() {
        super.init();
        initWyvernView();
    }

    applyDefaults(defaults) {
        if (defaults.view === 'following') {
            wyvernViewMode = 'following';
        }
        if (defaults.sort && wyvernViewMode === 'browse') {
            wyvernCurrentSort = defaults.sort;
            const el = document.getElementById('wyvernSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    async activate(container, options = {}) {
        if (options.domRecreated) {
            wyvernCurrentSearch = '';
            wyvernCharacters = [];
            wyvernCurrentPage = 1;
            wyvernHasMore = true;
        }
        super.activate(container, options);
        wyvernDelegatesInitialized = true;

        if (!_wyvernDropdownCloseHandler) {
            initWyvernDropdownDismiss();
        }

        buildLocalLibraryLookup();

        await tryWyvernAutoLogin();

        if (wyvernViewMode === 'browse') {
            const grid = document.getElementById('wyvernGrid');
            if (wyvernCharacters.length === 0) {
                loadWyvernCharacters();
            } else if (grid && grid.children.length === 0 && wyvernCharacters.length > 0) {
                wyvernGridRenderedCount = 0;
                renderWyvernGrid();
            } else {
                reconnectWyvernImageObserver();
            }
        } else if (wyvernViewMode === 'following') {
            switchWyvernViewMode('following');
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    rebuildLocalLibraryLookup() {
        buildLocalLibraryLookup();
    }

    refreshInLibraryBadges() {
        for (const gridId of ['wyvernGrid', 'wyvernFollowingGrid']) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;
            for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
                const charId = card.dataset.charId;
                const name = card.querySelector('.browse-card-name')?.textContent || '';
                if (!isCharInLocalLibrary({ id: charId, name })) continue;
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
        wyvernDelegatesInitialized = false;
        if (wyvernImageObserver) wyvernImageObserver.disconnect();
        if (wyvernDetailFetchController) {
            try { wyvernDetailFetchController.abort(); } catch (e) { /* ignore */ }
            wyvernDetailFetchController = null;
        }
        if (_wyvernDropdownCloseHandler) {
            document.removeEventListener('click', _wyvernDropdownCloseHandler);
            _wyvernDropdownCloseHandler = null;
        }
    }

    closeDropdowns() {
        document.getElementById('wyvernTagsDropdown')?.classList.add('hidden');
        document.getElementById('wyvernFiltersDropdown')?.classList.add('hidden');
    }

    // ── Image Observer (BrowseView contract) ────────────────

    disconnectImageObserver() {
        if (wyvernImageObserver) wyvernImageObserver.disconnect();
    }

    reconnectImageObserver() {
        reconnectWyvernImageObserver();
    }
}

// ========================================
// WYVERN BROWSE LOGIC
// ========================================

let _wyvernDropdownCloseHandler = null;

function initWyvernDropdownDismiss() {
    if (_wyvernDropdownCloseHandler) document.removeEventListener('click', _wyvernDropdownCloseHandler);
    _wyvernDropdownCloseHandler = (e) => {
        const filtersDropdown = document.getElementById('wyvernFiltersDropdown');
        const filtersBtn = document.getElementById('wyvernFiltersBtn');
        if (filtersDropdown && !filtersDropdown.contains(e.target) && e.target !== filtersBtn) {
            filtersDropdown.classList.add('hidden');
        }
        const tagsDropdown = document.getElementById('wyvernTagsDropdown');
        const tagsBtn = document.getElementById('wyvernTagsBtn');
        if (tagsDropdown && !tagsDropdown.contains(e.target) && e.target !== tagsBtn && !tagsBtn?.contains(e.target)) {
            tagsDropdown.classList.add('hidden');
        }
    };
    document.addEventListener('click', _wyvernDropdownCloseHandler);
}

function initWyvernView() {
    const sortEl = document.getElementById('wyvernSortSelect');
    if (sortEl) {
        sortEl.value = wyvernCurrentSort;
        CoreAPI.initCustomSelect?.(sortEl);
    }

    const creatorSortEl = document.getElementById('wyvernCreatorSortSelect');
    if (creatorSortEl) {
        creatorSortEl.value = wyvernCreatorSort;
        CoreAPI.initCustomSelect?.(creatorSortEl);
    }

    setupWyvernGridDelegates();

    // Mode toggle (Browse / Following)
    document.querySelectorAll('.wyvern-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.wyvernView;
            if (!mode || mode === wyvernViewMode) return;
            if (mode === 'following' && !wyvernToken) {
                showToast('Login required for Following. Click Log In to authenticate.', 'warning');
                openWyvernLoginModal();
                return;
            }
            switchWyvernViewMode(mode);
        });
    });

    // Sort change
    on('wyvernSortSelect', 'change', (e) => {
        wyvernCurrentSort = e.target.value;
        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        loadWyvernCharacters();
    });

    // Filters dropdown toggle
    on('wyvernFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        document.getElementById('wyvernTagsDropdown')?.classList.add('hidden');
        document.getElementById('wyvernFiltersDropdown')?.classList.toggle('hidden');
    });

    // Hide owned checkbox
    document.getElementById('wyvernFilterHideOwned')?.addEventListener('change', (e) => {
        wyvernFilterHideOwned = e.target.checked;
        updateWyvernFiltersButtonState();
        if (wyvernViewMode === 'browse') renderWyvernGrid();
        else renderWyvernFollowing();
    });

    // Feature filter: Lorebook
    document.getElementById('wyvernFilterLorebook')?.addEventListener('change', (e) => {
        wyvernFilterHasLorebook = e.target.checked;
        updateWyvernFiltersButtonState();
        if (wyvernViewMode === 'browse') renderWyvernGrid();
        else renderWyvernFollowing();
    });

    // Feature filter: Alt Greetings
    document.getElementById('wyvernFilterGreetings')?.addEventListener('change', (e) => {
        wyvernFilterHasAltGreetings = e.target.checked;
        updateWyvernFiltersButtonState();
        if (wyvernViewMode === 'browse') renderWyvernGrid();
        else renderWyvernFollowing();
    });

    // Creator filter
    on('wyvernClearCreatorBtn', 'click', clearWyvernCreatorFilter);
    on('wyvernFollowCreatorBtn', 'click', toggleWyvernFollowCreator);
    on('wyvernCreatorSortSelect', 'change', (e) => {
        wyvernCreatorSort = e.target.value;
        renderWyvernGrid();
    });

    // Tags dropdown
    initWyvernTagsDropdown();

    // Refresh
    on('refreshWyvernBtn', 'click', () => {
        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        loadWyvernCharacters(true);
    });

    // Load more
    on('wyvernLoadMoreBtn', 'click', () => {
        if (wyvernIsLoading) return;
        wyvernCurrentPage++;
        loadWyvernCharacters();
    });

    // Search
    on('wyvernSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performWyvernSearch();
    });
    on('wyvernSearchBtn', 'click', () => performWyvernSearch());
    on('wyvernClearSearchBtn', 'click', () => {
        const input = document.getElementById('wyvernSearchInput');
        if (input) { input.value = ''; input.focus(); }
        document.getElementById('wyvernClearSearchBtn')?.classList.add('hidden');
        performWyvernSearch();
    });

    // Creator search
    on('wyvernCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performWyvernCreatorSearch();
    });
    on('wyvernCreatorSearchBtn', 'click', () => performWyvernCreatorSearch());

    // Modal + document-level listeners — attach once (persist across provider switches)
    if (!wyvernModalEventsAttached) {
        wyvernModalEventsAttached = true;

        // Avatar click → full-size
        const wyvernAvatar = document.getElementById('wyvernCharAvatar');
        if (wyvernAvatar && !window.matchMedia('(max-width: 768px)').matches) {
            wyvernAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!wyvernAvatar.src) return;
                BrowseView.openAvatarViewer(wyvernAvatar.src);
            });
        }

        on('wyvernCharClose', 'click', () => {
            abortWyvernDetailFetch();
            cleanupWyvernCharModal();
            hideModal('wyvernCharModal');
        });
        on('wyvernDownloadBtn', 'click', () => downloadWyvernCharacter());

        const wyvernGalleryGrid = document.getElementById('wyvernCharGalleryGrid');
        if (wyvernGalleryGrid) {
            wyvernGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...wyvernGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        on('wyvernCharModal', 'click', (e) => {
            if (e.target.id === 'wyvernCharModal') {
                abortWyvernDetailFetch();
                cleanupWyvernCharModal();
                hideModal('wyvernCharModal');
            }
        });

        on('wyvernLoginClose', 'click', () => hideModal('wyvernLoginModal'));
        on('wyvernLoginModal', 'click', (e) => {
            if (e.target.id === 'wyvernLoginModal') hideModal('wyvernLoginModal');
        });
        on('wyvernLoginBtn', 'click', wyvernLoginWithCredentials);
        on('wyvernLogoutBtn', 'click', wyvernLogout);

        // Enter key submits login
        const loginKeyHandler = (e) => { if (e.key === 'Enter') wyvernLoginWithCredentials(); };
        document.getElementById('wyvernLoginEmail')?.addEventListener('keypress', loginKeyHandler);
        document.getElementById('wyvernLoginPassword')?.addEventListener('keypress', loginKeyHandler);

        // NSFW toggle
        on('wyvernNsfwToggle', 'click', () => {
            wyvernNsfwEnabled = !wyvernNsfwEnabled;
            setSetting('wyvernNsfw', wyvernNsfwEnabled);
            updateWyvernNsfwToggle();
            wyvernCharacters = [];
            wyvernCurrentPage = 1;
            loadWyvernCharacters();
        });
    }

    initWyvernDropdownDismiss();

    loadWyvernToken();

    debugLog('Wyvern view initialized');
}

// ========================================
// WYVERN AUTH
// ========================================

function loadWyvernToken() {
    const savedToken = getSetting('wyvernToken');
    if (savedToken) {
        wyvernToken = savedToken;
        debugLog('[WyvernAuth] Loaded token from settings');
    }
    wyvernNsfwEnabled = !!getSetting('wyvernNsfw');
    updateWyvernNsfwToggle();
    updateWyvernLoginUI();
}

async function wyvernLoginWithCredentials() {
    if (wyvernLoginInProgress) return;

    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');
    const loginBtn = document.getElementById('wyvernLoginBtn');
    const statusEl = document.getElementById('wyvernLoginStatus');

    const email = emailInput?.value.trim();
    const password = passwordInput?.value;
    if (!email || !password) {
        showToast('Please enter your email and password', 'warning');
        return;
    }

    wyvernLoginInProgress = true;
    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...';
    }
    if (statusEl) { statusEl.style.display = 'none'; }

    try {
        const result = await firebaseSignIn(email, password);
        const idToken = result.idToken;
        const refreshToken = result.refreshToken;

        wyvernToken = idToken;
        setSettings({
            wyvernToken: idToken,
            wyvernRefreshToken: refreshToken,
            wyvernRememberToken: true,
            wyvernUid: result.localId || '',
        });

        const rememberCheckbox = document.getElementById('wyvernRememberKey');
        if (rememberCheckbox?.checked) {
            setSettings({ wyvernEmail: email, wyvernPassword: password });
        }

        scheduleWyvernTokenRefresh(idToken, refreshToken);

        if (!wyvernNsfwEnabled) {
            wyvernNsfwEnabled = true;
            setSetting('wyvernNsfw', true);
        }
        updateWyvernNsfwToggle();
        updateWyvernLoginUI();

        hideModal('wyvernLoginModal');
        showToast('Logged in to Wyvern!', 'success');

        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        loadWyvernCharacters();
    } catch (e) {
        console.error('[WyvernAuth] Login failed:', e);
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.innerHTML = `<i class="fa-solid fa-exclamation-circle" style="color:#e74c3c;"></i> ${escapeHtml(e.message)}`;
        }
        showToast('Login failed: ' + e.message, 'error');
    } finally {
        wyvernLoginInProgress = false;
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<i class="fa-solid fa-sign-in-alt"></i> Log In';
        }
    }
}

function wyvernLogout() {
    clearWyvernTokenRefresh();
    wyvernToken = null;
    wyvernNsfwEnabled = false;
    setSettings({
        wyvernToken: null,
        wyvernRefreshToken: null,
        wyvernRememberToken: false,
        wyvernNsfw: false,
        wyvernEmail: null,
        wyvernPassword: null,
        wyvernUid: null,
    });

    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');
    const rememberCheckbox = document.getElementById('wyvernRememberKey');
    if (emailInput) emailInput.value = '';
    if (passwordInput) passwordInput.value = '';
    if (rememberCheckbox) rememberCheckbox.checked = false;

    updateWyvernNsfwToggle();
    updateWyvernLoginUI();
    showToast('Logged out of Wyvern', 'info');

    wyvernCharacters = [];
    wyvernCurrentPage = 1;
    loadWyvernCharacters();
}

function scheduleWyvernTokenRefresh(idToken, refreshToken) {
    clearWyvernTokenRefresh();
    if (!refreshToken) return;

    const ttl = getTokenTTL(idToken);
    if (ttl <= 0) return;

    // Refresh at 80% of TTL
    const delay = Math.max(30, Math.floor(ttl * 0.8)) * 1000;
    debugLog(`[WyvernAuth] Scheduling token refresh in ${Math.round(delay / 1000)}s (TTL: ${ttl}s)`);

    wyvernRefreshTimer = setTimeout(async () => {
        try {
            const result = await firebaseRefreshToken(refreshToken);
            const newIdToken = result.id_token;
            const newRefreshToken = result.refresh_token;

            wyvernToken = newIdToken;
            setSettings({
                wyvernToken: newIdToken,
                wyvernRefreshToken: newRefreshToken,
            });
            debugLog('[WyvernAuth] Token refreshed successfully');
            scheduleWyvernTokenRefresh(newIdToken, newRefreshToken);
        } catch (e) {
            console.error('[WyvernAuth] Token refresh failed:', e);
            // Try recovery with stored credentials
            const recovered = await attemptWyvernTokenRecovery();
            if (!recovered) {
                wyvernToken = null;
                wyvernNsfwEnabled = false;
                setSetting('wyvernNsfw', false);
                updateWyvernNsfwToggle();
                updateWyvernLoginUI();
            }
        }
    }, delay);
}

function clearWyvernTokenRefresh() {
    if (wyvernRefreshTimer) {
        clearTimeout(wyvernRefreshTimer);
        wyvernRefreshTimer = null;
    }
}

async function attemptWyvernTokenRecovery() {
    const refreshToken = getSetting('wyvernRefreshToken');
    if (refreshToken) {
        try {
            const result = await firebaseRefreshToken(refreshToken);
            wyvernToken = result.id_token;
            setSettings({
                wyvernToken: result.id_token,
                wyvernRefreshToken: result.refresh_token,
            });
            scheduleWyvernTokenRefresh(result.id_token, result.refresh_token);
            debugLog('[WyvernAuth] Token recovered via refresh token');
            return true;
        } catch { /* fall through to credential login */ }
    }

    const email = getSetting('wyvernEmail');
    const password = getSetting('wyvernPassword');
    if (!email || !password) return false;

    try {
        const result = await firebaseSignIn(email, password);
        wyvernToken = result.idToken;
        setSettings({
            wyvernToken: result.idToken,
            wyvernRefreshToken: result.refreshToken,
        });
        scheduleWyvernTokenRefresh(result.idToken, result.refreshToken);
        debugLog('[WyvernAuth] Token recovered via stored credentials');
        return true;
    } catch (e) {
        console.error('[WyvernAuth] Token recovery failed:', e);
        return false;
    }
}

async function tryWyvernAutoLogin() {
    if (wyvernToken && getTokenTTL(wyvernToken) > 60) {
        // Token is valid — schedule refresh
        const refreshToken = getSetting('wyvernRefreshToken');
        if (refreshToken) scheduleWyvernTokenRefresh(wyvernToken, refreshToken);
        return;
    }

    // Token expired or missing — try recovery silently
    const recovered = await attemptWyvernTokenRecovery();
    if (recovered) {
        updateWyvernNsfwToggle();
        updateWyvernLoginUI();
        if (wyvernNsfwEnabled) {
            wyvernCharacters = [];
            wyvernCurrentPage = 1;
            loadWyvernCharacters();
        }
    }
}

function updateWyvernNsfwToggle() {
    const btn = document.getElementById('wyvernNsfwToggle');
    if (!btn) return;

    if (wyvernNsfwEnabled) {
        btn.classList.add('active');
        btn.style.opacity = '1';
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = wyvernToken
            ? 'NSFW content enabled — click to disable'
            : 'NSFW content enabled (limited without login) — click to disable';
    } else {
        btn.classList.remove('active');
        btn.style.opacity = '0.7';
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Click to enable NSFW content';
    }
}

function updateWyvernLoginUI() {
    const loginBtn = document.getElementById('wyvernLoginBtn');
    const logoutBtn = document.getElementById('wyvernLogoutBtn');
    const tokenStatus = document.getElementById('wyvernTokenStatus');
    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');

    if (wyvernToken) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = '';
        if (emailInput) emailInput.disabled = true;
        if (passwordInput) passwordInput.disabled = true;

        const ttl = getTokenTTL(wyvernToken);
        const mins = Math.floor(ttl / 60);
        if (tokenStatus) {
            tokenStatus.style.display = 'block';
            tokenStatus.innerHTML = `<i class="fa-solid fa-check-circle" style="color:#2ecc71;"></i> Authenticated (token expires in ${mins}m)`;
        }

        // Populate email if stored
        const storedEmail = getSetting('wyvernEmail');
        if (storedEmail && emailInput && !emailInput.value) emailInput.value = storedEmail;
    } else {
        if (loginBtn) loginBtn.style.display = '';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (emailInput) emailInput.disabled = false;
        if (passwordInput) passwordInput.disabled = false;
        if (tokenStatus) tokenStatus.style.display = 'none';
    }
}

function openWyvernLoginModal() {
    const modal = document.getElementById('wyvernLoginModal');
    if (!modal) return;
    // Sync remember checkbox from saved setting
    const rememberCheckbox = document.getElementById('wyvernRememberKey');
    if (rememberCheckbox) rememberCheckbox.checked = getSetting('wyvernRememberCredentials') ?? true;
    updateWyvernLoginUI();
    modal.classList.remove('hidden');
}

// ========================================
// WYVERN TAGS DROPDOWN
// ========================================

function initWyvernTagsDropdown() {
    const btn = document.getElementById('wyvernTagsBtn');
    const dropdown = document.getElementById('wyvernTagsDropdown');
    const searchInput = document.getElementById('wyvernTagsSearchInput');
    const clearBtn = document.getElementById('wyvernTagsClearBtn');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        document.getElementById('wyvernFiltersDropdown')?.classList.add('hidden');
        const wasHidden = dropdown.classList.contains('hidden');
        dropdown.classList.toggle('hidden');
        if (wasHidden) {
            renderWyvernTagsList();
            if (!window.matchMedia('(max-width: 768px)').matches) searchInput?.focus();
        }
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    searchInput?.addEventListener('input', debounce(() => {
        renderWyvernTagsList(searchInput.value);
    }, 150));

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = searchInput.value.trim().toLowerCase();
            if (value && !wyvernTagFilters.has(value)) {
                wyvernTagFilters.set(value, 'include');
                searchInput.value = '';
                updateWyvernTagsButtonState();
                renderWyvernTagsList('');
                triggerWyvernReloadDebounced();
            }
        }
    });

    clearBtn?.addEventListener('click', () => {
        wyvernTagFilters.clear();
        if (searchInput) searchInput.value = '';
        renderWyvernTagsList('');
        updateWyvernTagsButtonState();
        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        loadWyvernCharacters();
    });
}

let wyvernTagFilterDebounceTimeout = null;

function triggerWyvernReloadDebounced() {
    if (wyvernTagFilterDebounceTimeout) clearTimeout(wyvernTagFilterDebounceTimeout);
    wyvernTagFilterDebounceTimeout = setTimeout(() => {
        wyvernTagFilterDebounceTimeout = null;
        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        loadWyvernCharacters();
    }, 500);
}

function renderWyvernTagsList(filter = '') {
    const container = document.getElementById('wyvernTagsList');
    if (!container) return;

    if (wyvernPopularTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">Type a tag name and press Enter to filter</div>';
        return;
    }

    const filterLower = filter.toLowerCase();
    const filteredTags = filter
        ? wyvernPopularTags.filter(tag => tag.toLowerCase().includes(filterLower))
        : wyvernPopularTags;

    const hasExactMatch = filter && filteredTags.some(t => t.toLowerCase() === filterLower);
    const showCustomAdd = filter && filterLower.length >= 2 && !hasExactMatch;

    if (filteredTags.length === 0 && !showCustomAdd) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags — press Enter to add as filter</div>';
        return;
    }

    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = wyvernTagFilters.get(a);
        const bState = wyvernTagFilters.get(b);
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        return a.localeCompare(b);
    });

    const customAddHtml = showCustomAdd ? `
        <div class="browse-tag-filter-item browse-tag-custom-add" data-custom-tag="${escapeHtml(filterLower)}">
            <button class="browse-tag-state-btn state-include"><i class="fa-solid fa-plus"></i></button>
            <span class="tag-label">Add <strong>${escapeHtml(filterLower)}</strong> as filter</span>
        </div>
    ` : '';

    container.innerHTML = customAddHtml + sortedTags.map(tag => {
        const state = wyvernTagFilters.get(tag) || 'neutral';
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

    container.querySelector('.browse-tag-custom-add')?.addEventListener('click', () => {
        if (!wyvernTagFilters.has(filterLower)) {
            wyvernTagFilters.set(filterLower, 'include');
            updateWyvernTagsButtonState();
            renderWyvernTagsList('');
            const searchInput = document.getElementById('wyvernTagsSearchInput');
            if (searchInput) searchInput.value = '';
            triggerWyvernReloadDebounced();
        }
    });

    container.querySelectorAll('.browse-tag-filter-item[data-tag]').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const label = item.querySelector('.tag-label');

        const cycleState = () => {
            const current = wyvernTagFilters.get(tag) || 'neutral';
            let newState;
            if (current === 'neutral') {
                newState = 'include';
                wyvernTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                newState = 'exclude';
                wyvernTagFilters.set(tag, 'exclude');
            } else {
                newState = 'neutral';
                wyvernTagFilters.delete(tag);
            }
            updateWyvernTagStateButton(stateBtn, newState);
            updateWyvernTagsButtonState();
            triggerWyvernReloadDebounced();
        };

        stateBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleState();
        });
        label?.addEventListener('click', cycleState);
    });
}

function updateWyvernTagStateButton(btn, state) {
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

function updateWyvernTagsButtonState() {
    const label = document.getElementById('wyvernTagsBtnLabel');
    const btn = document.getElementById('wyvernTagsBtn');
    if (!label || !btn) return;

    const includeCount = Array.from(wyvernTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(wyvernTagFilters.values()).filter(v => v === 'exclude').length;

    let text = 'Tags';
    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);
    if (parts.length > 0) text += ` (${parts.join('/')})`;

    label.textContent = text;
    btn.classList.toggle('has-filters', includeCount > 0 || excludeCount > 0);
}

function updateWyvernFiltersButtonState() {
    const btn = document.getElementById('wyvernFiltersBtn');
    if (!btn) return;
    const count = (wyvernFilterHideOwned ? 1 : 0) + (wyvernFilterHasLorebook ? 1 : 0) + (wyvernFilterHasAltGreetings ? 1 : 0);
    btn.classList.toggle('has-filters', count > 0);
    btn.innerHTML = count > 0
        ? `<i class="fa-solid fa-sliders"></i> Features (${count})`
        : '<i class="fa-solid fa-sliders"></i> Features';
}

function extractWyvernTagsFromResults(characters) {
    if (wyvernTagsLoaded && wyvernPopularTags.length >= 100) return;

    const tagCounts = new Map();
    for (const tag of wyvernPopularTags) tagCounts.set(tag, 10);

    for (const char of characters) {
        for (const tag of (char.tags || [])) {
            const normalized = tag.toLowerCase().trim();
            if (normalized && normalized.length > 1 && normalized.length < 40) {
                tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
            }
        }
    }

    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([tag]) => tag);

    if (sortedTags.length > wyvernPopularTags.length) {
        wyvernPopularTags = sortedTags;
        wyvernTagsLoaded = true;
    }
}

// ========================================
// WYVERN SEARCH
// ========================================

function performWyvernSearch() {
    const searchInput = document.getElementById('wyvernSearchInput');
    wyvernCurrentSearch = searchInput?.value.trim() || '';
    const clearBtn = document.getElementById('wyvernClearSearchBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !wyvernCurrentSearch);
    wyvernCharacters = [];
    wyvernCurrentPage = 1;
    loadWyvernCharacters();
}

async function performWyvernCreatorSearch() {
    const input = document.getElementById('wyvernCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Please enter a creator name', 'warning');
        return;
    }

    input.value = '';

    try {
        const headers = getWyvernHeaders(false);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/users?q=${encodeURIComponent(query)}&page=1&limit=10`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();
        const results = data.results || [];

        if (results.length === 0) {
            showToast(`No creators found matching "${query}"`, 'warning');
            return;
        }

        // Exact match first, then closest match
        const exact = results.find(u => u.displayName?.toLowerCase() === query.toLowerCase()
            || u.vanityUrl?.toLowerCase() === query.toLowerCase());
        const user = exact || results[0];

        loadWyvernCreatorCharacters(user.uid, user.displayName, user.vanityUrl || '');
    } catch (e) {
        console.error('[Wyvern] Creator search error:', e);
        showToast('Creator search failed: ' + e.message, 'error');
    }
}

// ========================================
// WYVERN CHARACTER LOADING
// ========================================

async function loadWyvernCharacters(forceRefresh = false) {
    if (wyvernIsLoading) return;

    const grid = document.getElementById('wyvernGrid');
    const loadMoreContainer = document.getElementById('wyvernLoadMore');

    const loadMoreBtn = document.getElementById('wyvernLoadMoreBtn');

    if (wyvernCurrentPage === 1) {
        renderLoadingState(grid, 'Loading Wyvern characters...', 'browse-loading');
    }

    wyvernIsLoading = true;

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        // Recommended: separate endpoint, single batch, requires auth
        if (wyvernCurrentSort === 'recommended') {
            if (!wyvernToken) {
                showToast('Login required for recommendations', 'warning');
                wyvernIsLoading = false;
                return;
            }

            const headers = getWyvernHeaders(true);
            const response = await fetchWithProxy(`${WYVERN_API_BASE}/recommendations/characters?limit=48`, {
                method: 'GET',
                headers
            });

            if (!response.ok) throw new Error(`API error: ${response.status}`);
            const data = await response.json();
            if (!wyvernDelegatesInitialized) return;

            wyvernCharacters = data.results || [];
            extractWyvernTagsFromResults(wyvernCharacters);
            wyvernHasMore = false;
            renderWyvernGrid(false);
            wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', false, true);
            wyvernIsLoading = false;
            return;
        }

        const params = new URLSearchParams();
        params.set('limit', '48');
        params.set('page', wyvernCurrentPage.toString());

        // Include tags → API parameter (comma-separated)
        const includeTags = [];
        for (const [tag, state] of wyvernTagFilters) {
            if (state === 'include') includeTags.push(tag);
        }
        if (includeTags.length > 0) {
            params.set('tags', includeTags.join(','));
        }

        // Search — omit sort so results are global, not restricted to a trending/votes pool
        if (wyvernCurrentSearch) {
            params.set('q', wyvernCurrentSearch);
        } else {
            params.set('sort', wyvernCurrentSort);
            params.set('order', 'DESC');
        }

        // NSFW rating filter
        if (wyvernNsfwEnabled && wyvernToken) {
            // Authenticated + NSFW on: omit rating to get all content
        } else if (wyvernCurrentSort === 'nsfw-popular') {
            // nsfw-popular sort returns explicit content without auth
        } else {
            params.set('rating', 'none');
        }

        debugLog('[Wyvern] Loading characters:', params.toString());

        const headers = getWyvernHeaders(wyvernNsfwEnabled && !!wyvernToken);
        const response = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, {
            method: 'GET',
            headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Wyvern] API error:', response.status, errorText);
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();

        if (!wyvernDelegatesInitialized) return;

        const nodes = data.results || [];

        if (wyvernCurrentPage === 1) {
            wyvernCharacters = nodes;
            extractWyvernTagsFromResults(nodes);
        } else {
            for (const node of nodes) wyvernCharacters.push(node);
        }

        wyvernHasMore = data.hasMore === true;
        const wasAppend = wyvernCurrentPage > 1;

        // Build exclude list for client-side filtering
        const autoFetchExcludeTags = [];
        for (const [tag, state] of wyvernTagFilters) {
            if (state === 'exclude') autoFetchExcludeTags.push(tag);
        }
        const hasClientFilters = wyvernFilterHideOwned || autoFetchExcludeTags.length > 0 || wyvernFilterHasLorebook || wyvernFilterHasAltGreetings;

        const isVisible = (c) => {
            if (wyvernFilterHideOwned && isCharInLocalLibrary(c)) return false;
            if (autoFetchExcludeTags.length > 0) {
                const charTags = (c.tags || []).map(t => t.toLowerCase());
                if (autoFetchExcludeTags.some(et => charTags.includes(et))) return false;
            }
            if (wyvernFilterHasLorebook && !(c.lorebooks?.length > 0)) return false;
            if (wyvernFilterHasAltGreetings && !(c.alternate_greetings?.length > 0)) return false;
            return true;
        };

        // Auto-fetch more when client-side filters remove too many results
        if (hasClientFilters && wyvernHasMore) {
            let visibleNew = nodes.filter(isVisible).length;
            let autoFetches = 0;

            while (visibleNew < 48 && wyvernHasMore && autoFetches < 3 && wyvernDelegatesInitialized) {
                autoFetches++;
                wyvernCurrentPage++;
                params.set('page', wyvernCurrentPage.toString());

                const moreRes = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, {
                    method: 'GET', headers
                });
                if (!moreRes.ok) break;

                const moreData = await moreRes.json();
                const moreNodes = moreData.results || [];
                for (const node of moreNodes) wyvernCharacters.push(node);
                wyvernHasMore = moreData.hasMore === true;
                visibleNew += moreNodes.filter(isVisible).length;
            }
        }

        renderWyvernGrid(wasAppend);

        wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', wyvernHasMore, wyvernCharacters.length > 0);

    } catch (e) {
        console.error('[Wyvern] Load error:', e);
        if (wyvernCurrentPage === 1) {
            grid.innerHTML = `
                <div class="browse-error">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Failed to load Wyvern</h3>
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
        wyvernIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

// ========================================
// VIEW MODE SWITCHING
// ========================================

async function switchWyvernViewMode(mode) {
    wyvernViewMode = mode;

    document.querySelectorAll('.wyvern-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.wyvernView === mode);
    });

    const browseSection = document.getElementById('wyvernBrowseSection');
    const followingSection = document.getElementById('wyvernFollowingSection');

    const sortContainer = document.getElementById('wyvernSortSelect')?.closest('.browse-sort-container');

    if (mode === 'browse') {
        browseSection?.classList.remove('hidden');
        followingSection?.classList.add('hidden');

        if (sortContainer) sortContainer.style.display = '';

        if (wyvernCharacters.length === 0) {
            loadWyvernCharacters();
        } else {
            renderWyvernGrid();
        }
    } else if (mode === 'following') {
        browseSection?.classList.add('hidden');
        followingSection?.classList.remove('hidden');

        if (sortContainer) sortContainer.style.display = 'none';

        if (wyvernFollowingCharacters.length === 0) {
            loadWyvernFollowing();
        } else {
            renderWyvernFollowing();
        }
    }
}

// ========================================
// FOLLOWING TIMELINE
// ========================================

let wyvernFollowingPage = 1;
const FOLLOWING_PAGE_SIZE = 30;

async function loadWyvernFollowing(forceRefresh = false) {
    if (!wyvernToken) {
        renderWyvernFollowingEmpty('login');
        return;
    }

    if (wyvernFollowingLoading) return;
    wyvernFollowingLoading = true;

    const grid = document.getElementById('wyvernFollowingGrid');

    if (forceRefresh) {
        wyvernFollowingCharacters = [];
        wyvernFollowingPage = 1;
        wyvernFollowingHasMore = false;
    }

    if (grid) {
        renderLoadingState(grid, 'Loading timeline...', 'browse-loading');
    }

    try {
        const headers = getWyvernHeaders(true);
        const params = new URLSearchParams({
            page: String(wyvernFollowingPage),
            limit: String(FOLLOWING_PAGE_SIZE),
            contentType: 'character',
            source: 'following',
            sort: 'created_at',
            order: 'DESC',
        });

        let feedData;
        try {
            const feedResp = await fetchWithProxy(`${WYVERN_API_BASE}/unified-feed?${params}`, { method: 'GET', headers });
            feedData = await feedResp.json();
        } catch (e) {
            if (e.message?.includes('401')) {
                renderWyvernFollowingEmpty('login');
                return;
            }
            throw e;
        }

        debugLog('[WyvernFollowing] Page', wyvernFollowingPage, '— items:', feedData.items?.length, 'total:', feedData.total, 'hasMore:', feedData.hasMore);

        const items = feedData.items || [];

        if (items.length === 0 && wyvernFollowingCharacters.length === 0) {
            renderWyvernFollowingEmpty('empty');
            return;
        }

        const existingIds = new Set(wyvernFollowingCharacters.map(c => c.id));
        for (const item of items) {
            const c = item.data || item;
            if (c.id && !existingIds.has(c.id)) {
                existingIds.add(c.id);
                wyvernFollowingCharacters.push(c);
            }
        }

        debugLog('[WyvernFollowing] Total characters:', wyvernFollowingCharacters.length);

        renderWyvernFollowing();

    } catch (err) {
        console.error('[WyvernFollowing] Error loading timeline:', err);
        if (err.message?.includes('401')) {
            renderWyvernFollowingEmpty('login');
            return;
        }
        if (grid) {
            grid.innerHTML = `
                <div class="chub-timeline-empty">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Error Loading Timeline</h3>
                    <p>${escapeHtml(err.message)}</p>
                    <button class="action-btn primary" id="wyvernFollowingRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            document.getElementById('wyvernFollowingRetryBtn')?.addEventListener('click', () => loadWyvernFollowing(true));
        }
    } finally {
        wyvernFollowingLoading = false;
    }
}

function renderWyvernFollowingEmpty(reason) {
    const grid = document.getElementById('wyvernFollowingGrid');
    if (!grid) return;

    if (reason === 'login') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Login Required</h3>
                <p>Log in to your Wyvern account to see new characters from authors you follow.</p>
                <button class="action-btn primary" id="wyvernFollowingLoginBtn">
                    <i class="fa-solid fa-sign-in-alt"></i> Log In
                </button>
            </div>
        `;
        document.getElementById('wyvernFollowingLoginBtn')?.addEventListener('click', () => {
            const modal = document.getElementById('wyvernLoginModal');
            if (modal) modal.classList.remove('hidden');
        });
    } else if (reason === 'no_follows' || reason === 'empty') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Follow some character creators on Wyvern to see their new characters here!</p>
                <a href="${WYVERN_SITE_BASE}" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Browse Wyvern
                </a>
            </div>
        `;
    }
}

function sortWyvernFollowingCharacters(characters) {
    return [...characters].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function renderWyvernFollowing() {
    const grid = document.getElementById('wyvernFollowingGrid');
    if (!grid) return;

    let filtered = wyvernFollowingCharacters;
    if (wyvernFilterHideOwned) {
        filtered = filtered.filter(c => !isCharInLocalLibrary(c));
    }
    if (wyvernFilterHasLorebook) {
        filtered = filtered.filter(c => c.lorebooks?.length > 0);
    }
    if (wyvernFilterHasAltGreetings) {
        filtered = filtered.filter(c => c.alternate_greetings?.length > 0);
    }

    const sorted = sortWyvernFollowingCharacters(filtered);

    if (sorted.length === 0 && wyvernFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting them.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = sorted.map(c => createWyvernCard(c)).join('');
    eagerLoadVisibleWyvernImages(grid);
    observeWyvernImages(grid);
}

// ========================================
// CREATOR FILTER
// ========================================

async function loadWyvernCreatorCharacters(uid, displayName, vanityUrl) {
    wyvernCreatorFilter = { uid, displayName, vanityUrl };
    wyvernCreatorSort = 'created_at';
    const sortSelect = document.getElementById('wyvernCreatorSortSelect');
    if (sortSelect) sortSelect.value = 'created_at';
    wyvernCharacters = [];
    wyvernCurrentPage = 1;
    wyvernHasMore = false;

    const banner = document.getElementById('wyvernCreatorBanner');
    const nameEl = document.getElementById('wyvernCreatorName');
    if (banner && nameEl) {
        nameEl.textContent = displayName;
        banner.classList.remove('hidden');
    }

    updateWyvernFollowCreatorButton(uid);

    const grid = document.getElementById('wyvernGrid');
    wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', false, true);

    renderLoadingState(grid, `Loading characters by ${escapeHtml(displayName)}...`, 'browse-loading');

    try {
        const headers = getWyvernHeaders(wyvernNsfwEnabled && !!wyvernToken);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/characters/user/${uid}`, {
            method: 'GET',
            headers,
        });

        if (!resp.ok) throw new Error(`API error: ${resp.status}`);

        const data = await resp.json();
        wyvernCharacters = data.characters || data.results || [];
        wyvernHasMore = false;

        renderWyvernGrid();

    } catch (e) {
        console.error('[Wyvern] Creator filter error:', e);
        grid.innerHTML = `
            <div class="browse-error">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Failed to load creator's characters</h3>
                <p>${escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

async function updateWyvernFollowCreatorButton(uid) {
    const followBtn = document.getElementById('wyvernFollowCreatorBtn');
    if (!followBtn) return;

    if (!wyvernToken) {
        followBtn.style.display = 'none';
        return;
    }

    followBtn.style.display = '';
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const headers = getWyvernHeaders(true);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/users/${uid}/followers?page=1&limit=100`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();
        let myUid = getSetting('wyvernUid');
        if (!myUid && wyvernToken) {
            try {
                const payload = JSON.parse(atob(wyvernToken.split('.')[1]));
                myUid = payload.user_id || '';
                if (myUid) setSetting('wyvernUid', myUid);
            } catch (_) { /* ignore parse errors */ }
        }
        wyvernIsFollowingCurrentCreator = !!(myUid && data.users?.some(u => u.uid === myUid));
    } catch (e) {
        debugLog('[Wyvern] Could not check follow status:', e);
        wyvernIsFollowingCurrentCreator = false;
    }

    followBtn.disabled = false;
    if (wyvernIsFollowingCurrentCreator) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = `Unfollow on Wyvern`;
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = `Follow on Wyvern`;
    }
}

async function toggleWyvernFollowCreator() {
    if (!wyvernCreatorFilter?.uid || !wyvernToken) {
        showToast('Login required to follow creators', 'warning');
        return;
    }

    const followBtn = document.getElementById('wyvernFollowCreatorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const headers = getWyvernHeaders(true);
        const endpoint = wyvernIsFollowingCurrentCreator ? 'unfollow' : 'follow';
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/users/${wyvernCreatorFilter.uid}/${endpoint}`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();

        if (data.message === 'Followed') {
            wyvernIsFollowingCurrentCreator = true;
            showToast(`Now following ${wyvernCreatorFilter.displayName}!`, 'success');
        } else if (data.message === 'Unfollowed') {
            wyvernIsFollowingCurrentCreator = false;
            showToast(`Unfollowed ${wyvernCreatorFilter.displayName}`, 'info');
        }
    } catch (e) {
        console.error('[Wyvern] Follow toggle error:', e);
        showToast('Follow action failed: ' + e.message, 'error');
    }

    if (followBtn) {
        followBtn.disabled = false;
        if (wyvernIsFollowingCurrentCreator) {
            followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
            followBtn.classList.add('following');
        } else {
            followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            followBtn.classList.remove('following');
        }
    }
}

function clearWyvernCreatorFilter() {
    wyvernCreatorFilter = null;
    wyvernCreatorSort = 'created_at';
    const sortSelect = document.getElementById('wyvernCreatorSortSelect');
    if (sortSelect) sortSelect.value = 'created_at';
    const banner = document.getElementById('wyvernCreatorBanner');
    if (banner) banner.classList.add('hidden');

    wyvernCharacters = [];
    wyvernCurrentPage = 1;
    wyvernHasMore = true;
    loadWyvernCharacters();
}

// ========================================
// WYVERN GRID RENDERING
// ========================================

function renderWyvernGrid(appendOnly = false) {
    const grid = document.getElementById('wyvernGrid');

    let displayCharacters = wyvernCharacters;

    // Client-side sort for creator view
    if (wyvernCreatorFilter && wyvernCreatorSort !== 'created_at') {
        const stats = (c) => getCharStats(c);
        displayCharacters = [...displayCharacters].sort((a, b) => {
            if (wyvernCreatorSort === 'votes') return stats(b).likes - stats(a).likes;
            if (wyvernCreatorSort === 'messages') return stats(b).messages - stats(a).messages;
            return 0;
        });
    }

    if (wyvernFilterHideOwned) {
        displayCharacters = displayCharacters.filter(c => !isCharInLocalLibrary(c));
    }
    // Exclude tags — client-side filter (Wyvern API has no server-side exclude)
    const excludeTags = [];
    for (const [tag, state] of wyvernTagFilters) {
        if (state === 'exclude') excludeTags.push(tag);
    }
    if (excludeTags.length > 0) {
        displayCharacters = displayCharacters.filter(c => {
            const charTags = (c.tags || []).map(t => t.toLowerCase());
            return !excludeTags.some(et => charTags.includes(et));
        });
    }
    if (wyvernFilterHasLorebook) {
        displayCharacters = displayCharacters.filter(c => c.lorebooks?.length > 0);
    }
    if (wyvernFilterHasAltGreetings) {
        displayCharacters = displayCharacters.filter(c => c.alternate_greetings?.length > 0);
    }

    if (displayCharacters.length === 0) {
        wyvernGridRenderedCount = 0;
        wyvernCardLookup.clear();
        if (wyvernImageObserver) wyvernImageObserver.disconnect();
        const message = wyvernCharacters.length > 0 && (wyvernFilterHideOwned || excludeTags.length > 0)
            ? 'All characters in this view were filtered out by your current filters.'
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

    buildWyvernLookup(displayCharacters);

    if (appendOnly && wyvernGridRenderedCount > 0 && wyvernGridRenderedCount < displayCharacters.length) {
        const newChars = displayCharacters.slice(wyvernGridRenderedCount);
        if (newChars.length > 0) {
            grid.insertAdjacentHTML('beforeend', newChars.map(char => createWyvernCard(char)).join(''));
        }
    } else {
        if (wyvernImageObserver) wyvernImageObserver.disconnect();
        grid.innerHTML = displayCharacters.map(char => createWyvernCard(char)).join('');
    }

    wyvernGridRenderedCount = displayCharacters.length;
    eagerLoadVisibleWyvernImages(grid);
    observeWyvernImages(grid);
}

function setupWyvernGridDelegates() {
    if (wyvernDelegatesInitialized) return;

    const cardClickHandler = (e) => {
        if (e.target.closest('.browse-retry-btn')) {
            wyvernCharacters = []; wyvernCurrentPage = 1; wyvernIsLoading = false;
            loadWyvernCharacters(true);
            return;
        }

        // Creator link click — load creator's characters
        const creatorLink = e.target.closest('.browse-card-creator-link');
        if (creatorLink) {
            e.stopPropagation();
            const uid = creatorLink.dataset.creatorUid;
            const name = creatorLink.dataset.creatorName;
            const vanity = creatorLink.dataset.creatorVanity || '';
            if (uid && name) {
                if (wyvernViewMode === 'following') switchWyvernViewMode('browse');
                loadWyvernCreatorCharacters(uid, name, vanity);
            }
            return;
        }

        const card = e.target.closest('.browse-card');
        if (!card) return;
        const charId = card.dataset.charId;
        const char = wyvernCardLookup.get(charId) || wyvernCharacters.find(c => c.id === charId) || wyvernFollowingCharacters.find(c => c.id === charId);
        if (char) openWyvernCharPreview(char);
    };

    const grid = document.getElementById('wyvernGrid');
    if (grid) grid.addEventListener('click', cardClickHandler);

    const followingGrid = document.getElementById('wyvernFollowingGrid');
    if (followingGrid) followingGrid.addEventListener('click', cardClickHandler);

    wyvernDelegatesInitialized = true;
}

function createWyvernCard(char) {
    const name = char.name || 'Unknown';
    const charId = char.id || '';
    const creatorName = char.creator?.displayName || char.creator?.username || 'Unknown';
    const creatorUid = char.creator?.uid || '';
    const stats = getCharStats(char);
    const messages = formatNumber(stats.messages);
    const likes = formatNumber(stats.likes);
    const avatarUrl = getAvatarUrl(char);

    const inLibrary = isCharInLocalLibrary(char);

    const tags = (char.tags || []).slice(0, 3);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (char.lorebooks?.length > 0) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }
    if (char.alternate_greetings?.length > 0) {
        badges.push('<span class="browse-feature-badge" title="Alt Greetings"><i class="fa-solid fa-comment-dots"></i></span>');
    }

    const ratingLabel = char.rating && char.rating !== 'none' ? char.rating : '';
    const createdDate = char.created_at ? new Date(char.created_at).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : 'browse-card';
    const taglineTooltip = char.tagline ? escapeHtml(char.tagline) : '';

    return `
        <div class="${cardClass}" data-char-id="${escapeHtml(charId)}" ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${ratingLabel ? `<span class="browse-nsfw-badge">${escapeHtml(ratingLabel)}</span>` : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                <span class="browse-card-creator-link" data-creator-uid="${escapeHtml(creatorUid)}" data-creator-name="${escapeHtml(creatorName)}" data-creator-vanity="${escapeHtml(char.creator?.vanityUrl || '')}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-message"></i> ${messages}</span>
                <span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${likes}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// WYVERN IMAGE LAZY LOADING
// ========================================

function initWyvernImageObserver() {
    if (wyvernImageObserver) return;
    wyvernImageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            const realSrc = img.dataset.src;
            if (realSrc && !img.dataset.failed && img.src !== realSrc) {
                img.src = realSrc;
                BrowseView.adjustPortraitPosition(img);
            }
        }
    }, { rootMargin: '600px' });
}

function observeWyvernImages(container) {
    if (!wyvernImageObserver) initWyvernImageObserver();
    requestAnimationFrame(() => {
        eagerLoadVisibleWyvernImages(container);
        const images = Array.from(container.querySelectorAll('.browse-card-image img')).filter(img => !img.dataset.observed);
        if (images.length === 0) return;
        for (const img of images) {
            img.dataset.observed = '1';
            wyvernImageObserver.observe(img);
        }
    });
}

function eagerLoadVisibleWyvernImages(container) {
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

function reconnectWyvernImageObserver() {
    const grid = document.getElementById('wyvernGrid');
    if (!grid) return;
    eagerLoadVisibleWyvernImages(grid);
    const imgs = grid.querySelectorAll('.browse-card-image img[data-observed]');
    for (const img of imgs) delete img.dataset.observed;
    observeWyvernImages(grid);
}

// ========================================
// WYVERN CHARACTER PREVIEW
// ========================================

function abortWyvernDetailFetch() {
    if (wyvernDetailFetchController) {
        try { wyvernDetailFetchController.abort(); } catch (e) { /* ignore */ }
        wyvernDetailFetchController = null;
    }
}

async function openWyvernCharPreview(char) {
    abortWyvernDetailFetch();
    wyvernSelectedChar = char;

    const modal = document.getElementById('wyvernCharModal');
    const avatarImg = document.getElementById('wyvernCharAvatar');
    const nameEl = document.getElementById('wyvernCharName');
    const creatorEl = document.getElementById('wyvernCharCreator');
    const messagesEl = document.getElementById('wyvernCharMessages');
    const likesEl = document.getElementById('wyvernCharLikes');
    const tagsEl = document.getElementById('wyvernCharTags');
    const viewsEl = document.getElementById('wyvernCharViews');
    const dateEl = document.getElementById('wyvernCharDate');
    const taglineSection = document.getElementById('wyvernCharTaglineSection');
    const taglineEl = document.getElementById('wyvernCharTagline');
    const openInBrowserBtn = document.getElementById('wyvernOpenInBrowserBtn');
    const creatorNotesEl = document.getElementById('wyvernCharCreatorNotes');
    const greetingsStat = document.getElementById('wyvernCharGreetingsStat');
    const greetingsCount = document.getElementById('wyvernCharGreetingsCount');
    const descSection = document.getElementById('wyvernCharDescriptionSection');
    const descEl = document.getElementById('wyvernCharDescription');
    const personalitySection = document.getElementById('wyvernCharPersonalitySection');
    const personalityEl = document.getElementById('wyvernCharPersonality');
    const scenarioSection = document.getElementById('wyvernCharScenarioSection');
    const scenarioEl = document.getElementById('wyvernCharScenario');
    const firstMsgSection = document.getElementById('wyvernCharFirstMsgSection');
    const firstMsgEl = document.getElementById('wyvernCharFirstMsg');
    const examplesSection = document.getElementById('wyvernCharExamplesSection');
    const examplesEl = document.getElementById('wyvernCharExamples');
    const altGreetingsSection = document.getElementById('wyvernCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('wyvernCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('wyvernCharAltGreetingsCount');
    const galleryStat = document.getElementById('wyvernCharGalleryStat');
    const galleryCountEl = document.getElementById('wyvernCharGalleryCount');
    const gallerySection = document.getElementById('wyvernCharGallerySection');
    const galleryGrid = document.getElementById('wyvernCharGalleryGrid');
    const galleryLabel = document.getElementById('wyvernCharGalleryLabel');

    const charId = char.id || '';
    const avatarUrl = getAvatarUrl(char);
    const creatorName = char.creator?.displayName || char.creator?.username || 'Unknown';

    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    nameEl.textContent = char.name || 'Unknown';
    creatorEl.textContent = creatorName;
    creatorEl.href = '#';
    if (char.creator?.uid) {
        creatorEl.title = `Click to see all characters by ${creatorName}`;
        creatorEl.onclick = (e) => {
            e.preventDefault();
            abortWyvernDetailFetch();
            cleanupWyvernCharModal();
            hideModal('wyvernCharModal');
            loadWyvernCreatorCharacters(char.creator.uid, creatorName, char.creator?.vanityUrl || '');
        };
    } else {
        creatorEl.title = creatorName;
        creatorEl.onclick = (e) => e.preventDefault();
    }
    openInBrowserBtn.href = getCharacterPageUrl(charId);
    const stats = getCharStats(char);
    messagesEl.innerHTML = `<i class="fa-solid fa-message"></i> ${formatNumber(stats.messages)}`;
    messagesEl.title = 'Messages';
    likesEl.innerHTML = `<i class="fa-solid fa-heart"></i> ${formatNumber(stats.likes)}`;
    likesEl.title = 'Likes';

    // Tags
    const tags = char.tags || [];
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    // Stats
    viewsEl.textContent = formatNumber(stats.views);
    dateEl.textContent = char.created_at ? new Date(char.created_at).toLocaleDateString() : 'Unknown';

    // Creator's Notes
    renderCreatorNotesSecure(char.creator_notes || char.tagline || 'No description available.', char.name, creatorNotesEl);

    // Tagline
    if (char.tagline && getSetting('showWyvernTagline') !== false) {
        taglineSection.style.display = 'block';
        taglineEl.innerHTML = sanitizeTaglineHtml(char.tagline, char.name);
    } else {
        taglineSection.style.display = 'none';
    }

    // Greetings count
    const numGreetings = char.alternate_greetings?.length || 0;
    if (numGreetings > 0) {
        greetingsStat.style.display = 'flex';
        greetingsCount.textContent = numGreetings + 1;
    } else {
        greetingsStat.style.display = 'none';
    }

    // Reset definition sections — show loading indicator until detail fetch completes
    const defLoading = document.getElementById('wyvernCharDefinitionLoading');
    descSection.style.display = 'none';
    personalitySection.style.display = 'none';
    scenarioSection.style.display = 'none';
    examplesSection.style.display = 'none';
    firstMsgSection.style.display = 'none';
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    if (altGreetingsEl) altGreetingsEl.innerHTML = '';
    if (gallerySection) gallerySection.style.display = 'none';
    if (galleryGrid) galleryGrid.innerHTML = '';
    if (galleryStat) galleryStat.style.display = 'none';
    if (defLoading) defLoading.style.display = 'block';

    // Import button state
    const downloadBtn = document.getElementById('wyvernDownloadBtn');
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

    renderAltGreetings(char.alternate_greetings || []);

    const applyDetailData = (node) => {
        if (!node) return;

        // Clear the loading indicator
        if (defLoading) defLoading.style.display = 'none';

        // Creator notes from detail if richer
        if (node.creator_notes && node.creator_notes !== char.creator_notes) {
            renderCreatorNotesSecure(node.creator_notes, char.name, creatorNotesEl);
        }

        // Description
        if (node.description) {
            descSection.style.display = 'block';
            descEl.innerHTML = DOMPurify.sanitize(formatRichText(node.description, char.name, true), BROWSE_PURIFY_CONFIG);
            descEl.dataset.fullContent = node.description;
        }

        // Personality
        if (node.personality) {
            personalitySection.style.display = 'block';
            personalityEl.innerHTML = DOMPurify.sanitize(formatRichText(node.personality, char.name, true), BROWSE_PURIFY_CONFIG);
            personalityEl.dataset.fullContent = node.personality;
        }

        // Scenario
        if (node.scenario) {
            scenarioSection.style.display = 'block';
            scenarioEl.innerHTML = DOMPurify.sanitize(formatRichText(node.scenario, char.name, true), BROWSE_PURIFY_CONFIG);
            scenarioEl.dataset.fullContent = node.scenario;
        }

        // Example Dialogs
        if (node.mes_example) {
            examplesSection.style.display = 'block';
            examplesEl.innerHTML = DOMPurify.sanitize(formatRichText(node.mes_example, char.name, true), BROWSE_PURIFY_CONFIG);
            examplesEl.dataset.fullContent = node.mes_example;
        }

        // First message
        if (node.first_mes) {
            firstMsgSection.style.display = 'block';
            firstMsgEl.innerHTML = DOMPurify.sanitize(formatRichText(node.first_mes, char.name, true), BROWSE_PURIFY_CONFIG);
            firstMsgEl.dataset.fullContent = node.first_mes;
        }

        // Alt greetings
        if (node.alternate_greetings?.length > 0) {
            greetingsStat.style.display = 'flex';
            greetingsCount.textContent = node.alternate_greetings.length + 1;
            renderAltGreetings(node.alternate_greetings);
        }

        // Gallery
        if (node.galleryImages?.length > 0) {
            const count = node.galleryImages.length;
            if (galleryStat) {
                galleryStat.style.display = 'flex';
                galleryCountEl.textContent = count;
            }
            if (gallerySection && galleryGrid) {
                gallerySection.style.display = 'block';
                if (galleryLabel) galleryLabel.textContent = `(${count})`;
                galleryGrid.innerHTML = node.galleryImages.map(img =>
                    `<img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="${escapeHtml(img.title || '')}" title="${escapeHtml(img.title || 'Gallery image')}" loading="lazy" onerror="this.style.display='none'">`
                ).join('');
            }
        } else if (node.galleryImages !== undefined) {
            if (gallerySection) gallerySection.style.display = 'none';
            if (galleryGrid) galleryGrid.innerHTML = '';
        }
    };

    // If the char already has definition data (e.g. from "View on Wyvern" or
    // search results), apply it immediately for fast initial render. The detail
    // fetch below will still run to fill in gallery and other missing fields.
    const hasInlineDefinition = char.description || char.first_mes || char.personality || char.scenario;
    if (hasInlineDefinition) {
        const galleryImages = Array.isArray(char.gallery) && char.gallery.length > 0
            ? char.gallery.map(img => ({ url: img.imageURL, title: img.title || '', id: img.id }))
            : undefined;
        const inlineDetail = {
            description: char.description,
            personality: char.personality,
            scenario: char.scenario,
            mes_example: char.mes_example,
            first_mes: char.first_mes,
            creator_notes: char.creator_notes,
            alternate_greetings: char.alternate_greetings,
            galleryImages,
        };
        applyDetailData(inlineDetail);
    }

    // Check detail cache — if cached, apply immediately (replaces spinner)
    const cachedDetail = charId ? wyvernDetailCache.get(charId) : null;
    if (cachedDetail) {
        wyvernDetailCache.delete(charId);
        wyvernDetailCache.set(charId, cachedDetail);
        applyDetailData(cachedDetail);
    }

    // Fetch detailed info if not cached
    if (!cachedDetail && charId) {
        wyvernDetailFetchController = new AbortController();
        const fetchSignal = wyvernDetailFetchController.signal;
        try {
            const detailUrl = `${WYVERN_API_BASE}/characters/${charId}`;
            const response = await fetchWithProxy(detailUrl, { signal: fetchSignal });
            const detailData = await response.json();
            if (fetchSignal.aborted || wyvernSelectedChar !== char) {
                debugLog('[Wyvern] Detail fetch completed but modal moved on — discarding');
            } else {
                const galleryImages = Array.isArray(detailData.gallery) && detailData.gallery.length > 0
                    ? detailData.gallery.map(img => ({ url: img.imageURL, title: img.title || '', id: img.id }))
                    : null;
                const stripped = {
                    description: detailData.description,
                    personality: detailData.personality,
                    scenario: detailData.scenario,
                    mes_example: detailData.mes_example,
                    first_mes: detailData.first_mes,
                    creator_notes: detailData.creator_notes,
                    alternate_greetings: detailData.alternate_greetings,
                    galleryImages,
                };
                while (wyvernDetailCache.size >= WYVERN_DETAIL_CACHE_MAX) {
                    const oldestKey = wyvernDetailCache.keys().next().value;
                    wyvernDetailCache.delete(oldestKey);
                }
                wyvernDetailCache.set(charId, stripped);
                applyDetailData(stripped);
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                debugLog('[Wyvern] Detail fetch aborted (modal closed)');
            } else {
                debugLog('[Wyvern] Could not fetch detailed character info:', e.message);
                if (wyvernSelectedChar === char) {
                    if (defLoading) defLoading.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
                    const gs = document.getElementById('wyvernCharGallerySection');
                    if (gs) gs.style.display = 'none';
                }
            }
        }
    }
}

function cleanupWyvernCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;

    const defLoading = document.getElementById('wyvernCharDefinitionLoading');
    if (defLoading) { defLoading.style.display = 'none'; defLoading.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>'; }

    const modal = document.getElementById('wyvernCharModal');
    if (modal) {
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });

        const sectionIds = [
            'wyvernCharAltGreetings',
            'wyvernCharDescription',
            'wyvernCharPersonality',
            'wyvernCharScenario',
            'wyvernCharFirstMsg',
            'wyvernCharTagline',
            'wyvernCharGalleryGrid',
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }

        const creatorNotesEl = document.getElementById('wyvernCharCreatorNotes');
        cleanupCreatorNotesContainer(creatorNotesEl);
    }
    wyvernSelectedChar = null;
}

// ========================================
// WYVERN CHARACTER DOWNLOAD (import)
// ========================================

async function downloadWyvernCharacter() {
    if (!wyvernSelectedChar) return;

    abortWyvernDetailFetch();

    const downloadBtn = document.getElementById('wyvernDownloadBtn');
    const originalHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    downloadBtn.disabled = true;

    let inheritedGalleryId = null;

    try {
        const charId = wyvernSelectedChar.id;
        const characterName = wyvernSelectedChar.name || 'Unknown';
        const characterCreator = wyvernSelectedChar.creator?.displayName || wyvernSelectedChar.creator?.username || '';

        const cachedDetail = wyvernDetailCache.get(charId);

        // Pre-import duplicate check
        const duplicateMatches = checkCharacterForDuplicates({
            name: characterName,
            creator: characterCreator,
            fullPath: charId,
            description: cachedDetail?.description || wyvernSelectedChar.description || '',
            first_mes: cachedDetail?.first_mes || wyvernSelectedChar.first_mes || '',
            personality: cachedDetail?.personality || wyvernSelectedChar.personality || '',
            scenario: cachedDetail?.scenario || wyvernSelectedChar.scenario || ''
        });

        if (duplicateMatches.length > 0) {
            downloadBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const result = await showPreImportDuplicateWarning({
                name: characterName,
                creator: characterCreator,
                fullPath: charId,
                avatarUrl: getAvatarUrl(wyvernSelectedChar)
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (inheritedGalleryId) {
                    debugLog('[WyvernDownload] Inheriting gallery_id from replaced character:', inheritedGalleryId);
                }
                downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (deleteSuccess) {
                    debugLog('[WyvernDownload] Deleted existing character:', toReplace.avatar);
                } else {
                    console.warn('[WyvernDownload] Could not delete existing character, proceeding with import anyway');
                }
            }
        }

        downloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';

        const provider = CoreAPI.getProvider('wyvern');
        if (!provider?.importCharacter) throw new Error('Wyvern provider not available');

        const result = await provider.importCharacter(charId, wyvernSelectedChar, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        cleanupWyvernCharModal();
        document.getElementById('wyvernCharModal').classList.add('hidden');

        await new Promise(r => requestAnimationFrame(r));

        showToast(`Downloaded "${result.characterName}" successfully!`, 'success');

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
                    url: `${WYVERN_SITE_BASE}/characters/${result.providerCharId}`,
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

        await new Promise(r => setTimeout(r, 200));

        buildLocalLibraryLookup();
        markWyvernCardAsImported(charId);

        await fetchCharacters(true);

    } catch (e) {
        console.error('[Wyvern] Download error:', e);
        showToast(`Download failed: ${e.message}`, 'error');
    } finally {
        if (downloadBtn) {
            downloadBtn.innerHTML = originalHtml;
            downloadBtn.disabled = false;
        }
    }
}

// Expose for provider's openPreview() and auth
window.openWyvernCharPreview = openWyvernCharPreview;
window.openWyvernLoginModal = openWyvernLoginModal;

// Singleton
const wyvernBrowseView = new WyvernBrowseView();
export default wyvernBrowseView;
