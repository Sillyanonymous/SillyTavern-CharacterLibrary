// CharaVaultBrowseView - CharaVault browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    cvThumbUrl,
    cvFullPath,
    fetchCvCards,
    fetchCvCardDetail,
    fetchCvTags,
    fetchCvRating,
    fetchCvLinkedLorebooks,
    fetchCvSimilar,
} from './charavault-api.js';

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
    renderLoadingState,
    getSetting,
    debounce,
    fetchCharacters,
    fetchAndAddCharacter,
    deleteCharacter,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    showImportSummaryModal,
    getProviderExcludeTags,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
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
// STATE
// ========================================

let cvCharacters = [];
let cvCurrentPage = 0;       // offset = cvCurrentPage * PAGE_SIZE
let cvHasMore = true;
let cvIsLoading = false;
let cvLoadToken = 0;
let cvCurrentSearch = '';
let cvCurrentCreator = '';   // creator filter (author banner)
let cvSortMode = 'most_downloaded';
let cvNsfwMode = 'sfw';      // 'sfw' | 'nsfw' | 'any'
let cvLorebookMode = 'any';  // 'any' | 'with' | 'without'
let cvSelectedChar = null;
let cvTagFilters = new Set();  // Set of tag names to include
let cvGridRenderedCount = 0;

const PAGE_SIZE = 48;

// Popular tags cache
let cvPopularTags = [];
let cvTagsLoaded = false;

// Module-scoped view reference (set in constructor for card-inline helpers)
let view;

// ========================================
// HELPERS
// ========================================

function cvIsInLibrary(char) {
    const fp = char.fullPath || '';
    const name = (char.name || '').toLowerCase().trim();
    const creator = (char.creator || '').toLowerCase().trim();
    if (fp && view._lookup.byProviderId.has(fp.toLowerCase())) return true;
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;
    return false;
}

function cvIsPossibleMatch(char) {
    if (cvIsInLibrary(char)) return false;
    return view.isCharPossibleMatch(char.name || '', char.creator || '');
}

function markCvCardImported(fullPath) {
    const grid = document.getElementById('cvGrid');
    if (!grid || !fullPath) return;
    const card = grid.querySelector(`[data-full-path="${CSS.escape(fullPath)}"]`);
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

// ========================================
// BROWSE VIEW CLASS
// ========================================

class CharaVaultBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        this._preloadLimit = 72;
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const cv = char.data?.extensions?.charavault;
        if (cv?.full_path) idSet.add(cv.full_path.toLowerCase());
    }

    get previewModalId() { return 'cvCharModal'; }

    _getImageGridIds() { return ['cvGrid']; }

    closePreview() {
        const notesEl = document.getElementById('cvCharCreatorNotes');
        if (notesEl) cleanupCreatorNotesContainer?.(notesEl);
        hideModal('cvCharModal');
    }

    canLoadMore() { return cvHasMore && !cvIsLoading; }

    async loadMore() {
        cvCurrentPage++;
        await loadCvCharacters();
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Sort dropdown -->
            <div class="browse-sort-container">
                <select id="cvSortSelect" class="glass-select" title="Sort order">
                    <option value="most_downloaded" selected>Most Downloaded</option>
                    <option value="top_rated">Top Rated</option>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="name_asc">Name A-Z</option>
                    <option value="name_desc">Name Z-A</option>
                    <option value="token_count_desc">Most Tokens</option>
                    <option value="token_count_asc">Fewest Tokens</option>
                </select>
            </div>

            <!-- Tag filters dropdown -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="cvTagsBtn" class="glass-btn" title="Filter by tags">
                    <i class="fa-solid fa-tags"></i> <span id="cvTagsBtnLabel">Tags</span>
                </button>
                <div id="cvTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="cvTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="cvTagsClearBtn" class="glass-btn icon-only" title="Clear tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="cvTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                </div>
            </div>

            <!-- Feature filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="cvFiltersBtn" class="glass-btn" title="Feature filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="cvFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    <div class="dropdown-section-title">Lorebook</div>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="any" checked> Any</label>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="with"> <i class="fa-solid fa-book"></i> Has lorebook</label>
                    <label class="filter-checkbox"><input type="radio" name="cvLorebookMode" value="without"> <i class="fa-solid fa-book-skull"></i> No lorebook</label>
                </div>
            </div>

            <!-- NSFW 3-state toggle -->
            <button id="cvNsfwToggle" class="glass-btn nsfw-toggle" title="Cycle NSFW filter (SFW only / NSFW only / Any)">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshCvBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="cvBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="cvSearchInput" placeholder="Search CharaVault characters..." autocomplete="one-time-code">
                        <button id="cvClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="cvSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="cvCreatorSearchInput" placeholder="Filter by creator..." autocomplete="one-time-code">
                            <button id="cvCreatorSearchBtn" class="browse-search-submit" title="Filter by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator banner (shown when filtering by creator) -->
                <div id="cvCreatorBanner" class="cv-creator-banner hidden">
                    <div class="cv-creator-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="cvCreatorBannerName"></strong></span>
                    </div>
                    <div class="cv-creator-banner-actions">
                        <button id="cvClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results grid -->
                <div id="cvGrid" class="browse-grid"></div>

                <!-- Load more -->
                <div class="browse-load-more" id="cvLoadMore" style="display: none;">
                    <button id="cvLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Preview Modal ───────────────────────────────────────

    renderModals() {
        return `
    <div id="cvCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="cvCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="cvCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="cvCharCreator" href="#" title="Show all by this creator">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="cvOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on CharaVault">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="cvDownloadBtn" class="action-btn primary" title="Import to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="cvCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="cv-modal-stats">
                    <div class="cv-modal-stat" title="Average rating / vote count">
                        <i class="fa-solid fa-star"></i>
                        <span id="cvCharRating">0.0</span>
                        <span id="cvCharRatingCount" class="cv-modal-stat-sub"></span>
                    </div>
                    <div class="cv-modal-stat" title="Token count">
                        <i class="fa-solid fa-message"></i>
                        <span id="cvCharTokens" class="cv-token-count">0</span> tokens
                    </div>
                    <div class="cv-modal-stat" id="cvCharDownloadsStat" style="display: none;" title="Total downloads on CharaVault">
                        <i class="fa-solid fa-cloud-arrow-down"></i>
                        <span id="cvCharDownloads">0</span>
                    </div>
                    <div class="cv-modal-stat" id="cvCharLorebookStat" style="display: none;" title="Linked lorebook(s)">
                        <i class="fa-solid fa-book"></i>
                        <span id="cvCharLorebookText">Lorebook</span>
                    </div>
                    <div class="cv-modal-stat" id="cvCharGreetingsStat" style="display: none;" title="Alternate greetings">
                        <i class="fa-solid fa-comment-dots"></i>
                        <span id="cvCharGreetingsCount">0</span> greetings
                    </div>
                    <div class="cv-modal-stat" id="cvCharNsfwStat" style="display: none;" title="NSFW reasons">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span id="cvCharNsfwReasons"></span>
                    </div>
                </div>
                <div class="cv-modal-tier" id="cvCharTierBox" style="display: none;">
                    <i class="fa-solid fa-microchip"></i>
                    <div class="cv-modal-tier-text">
                        <strong id="cvCharTierLabel"></strong>
                        <span id="cvCharTierDesc"></span>
                        <span id="cvCharTierPreset" class="cv-modal-tier-preset"></span>
                    </div>
                </div>
                <div class="browse-char-tags" id="cvCharTags"></div>

                <!-- Creator Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="cvCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="cvCharCreatorNotes" class="scrolling-text">No description available.</div>
                </div>

                <!-- Character Definition (V2 "description" - the prompt) -->
                <div class="browse-char-section" id="cvCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharDescription" data-label="Character Definition" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Character Definition
                    </h3>
                    <div id="cvCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality (extra prompt notes) -->
                <div class="browse-char-section" id="cvCharPersonalitySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="cvCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="cvCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="cvCharScenario" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="cvCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="cvCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Example Dialogs - collapsed by default since they are usually long -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                    </h3>
                    <div id="cvCharExamples" class="scrolling-text"></div>
                </div>

                <!-- System Prompt (only shown when present) -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharSystemPromptSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharSystemPrompt" data-label="System Prompt" data-icon="fa-solid fa-gear" title="Click to expand">
                        <i class="fa-solid fa-gear"></i> System Prompt
                    </h3>
                    <div id="cvCharSystemPrompt" class="scrolling-text"></div>
                </div>

                <!-- Post-History Instructions (jailbreak slot) -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharPostHistorySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharPostHistory" data-label="Post-History Instructions" data-icon="fa-solid fa-flag-checkered" title="Click to expand">
                        <i class="fa-solid fa-flag-checkered"></i> Post-History Instructions
                    </h3>
                    <div id="cvCharPostHistory" class="scrolling-text"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="cvCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings
                        <span class="browse-section-count" id="cvCharAltGreetingsCount"></span>
                    </h3>
                    <div id="cvCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Linked Lorebooks (live) -->
                <div class="browse-char-section" id="cvCharLinkedBooksSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharLinkedBooks" data-label="Linked Lorebooks" data-icon="fa-solid fa-book" title="Click to expand">
                        <i class="fa-solid fa-book"></i> Linked Lorebooks
                        <span class="browse-section-count" id="cvCharLinkedBooksCount"></span>
                    </h3>
                    <div id="cvCharLinkedBooks" class="cv-linked-books-list"></div>
                </div>

                <!-- Similar (visual hash) -->
                <div class="browse-char-section" id="cvCharSimilarSection">
                    <h3 class="browse-section-title" data-section="cvCharSimilar" data-label="Visually Similar" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Visually Similar
                        <span class="browse-section-count" id="cvCharSimilarCount"></span>
                    </h3>
                    <div class="cv-similar-controls">
                        <button id="cvFindSimilarBtn" class="glass-btn cv-find-similar-btn" title="Find visually similar cards">
                            <i class="fa-solid fa-magnifying-glass"></i> Find Similar
                        </button>
                        <span id="cvSimilarStatus" class="cv-similar-status"></span>
                    </div>
                    <div id="cvCharSimilar" class="cv-similar-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    init() {
        super.init();
        initCvView();
        this._registerDropdownDismiss([
            { dropdownId: 'cvFiltersDropdown', buttonId: 'cvFiltersBtn' },
            { dropdownId: 'cvTagsDropdown', buttonId: 'cvTagsBtn' },
        ]);
    }

    applyDefaults(defaults) {
        if (defaults.sort) {
            cvSortMode = defaults.sort;
            const el = document.getElementById('cvSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            cvCurrentSearch = '';
            cvCurrentCreator = '';
            cvCharacters = [];
            cvCurrentPage = 0;
            cvHasMore = true;
            cvIsLoading = false;
            cvGridRenderedCount = 0;
            cvSelectedChar = null;
        }
        super.activate(container, options);

        this.buildLocalLibraryLookup();
        const grid = document.getElementById('cvGrid');
        if (cvCharacters.length === 0) {
            loadCvCharacters();
        } else if (grid && grid.children.length === 0) {
            cvGridRenderedCount = 0;
            renderCvGrid();
        } else {
            this.reconnectImageObserver();
        }
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const fullPath = card.dataset.fullPath;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            return cvIsInLibrary({ fullPath, name });
        }, ['cvGrid']);
    }

    deactivate() {
        super.deactivate();
        this.disconnectImageObserver();
    }

    closeDropdowns() {
        document.getElementById('cvTagsDropdown')?.classList.add('hidden');
        document.getElementById('cvFiltersDropdown')?.classList.add('hidden');
    }
}

// ========================================
// LOAD & RENDER
// ========================================

async function loadCvCharacters(reset = false) {
    if (cvIsLoading) return;
    if (reset) {
        cvCharacters = [];
        cvCurrentPage = 0;
        cvHasMore = true;
        cvGridRenderedCount = 0;
    }
    if (!cvHasMore) return;

    const token = ++cvLoadToken;
    cvIsLoading = true;

    const grid = document.getElementById('cvGrid');
    if (cvCurrentPage === 0 && grid) {
        renderLoadingState?.(grid, 'Loading CharaVault characters...', 'browse-loading');
    }

    try {
        const tagStr = cvTagFilters.size > 0 ? [...cvTagFilters].join(',') : '';
        // nsfw: 'sfw' -> false, 'nsfw' -> true, 'any' -> null (omit)
        const nsfwParam = cvNsfwMode === 'sfw' ? false : cvNsfwMode === 'nsfw' ? true : null;
        // has_book: 'with' -> true, 'without' -> false, 'any' -> null (omit)
        const hasBookParam = cvLorebookMode === 'with' ? true
            : cvLorebookMode === 'without' ? false
                : null;
        const data = await fetchCvCards({
            q: cvCurrentSearch,
            creator: cvCurrentCreator,
            tags: tagStr,
            nsfw: nsfwParam,
            has_book: hasBookParam,
            sort: cvSortMode,
            limit: PAGE_SIZE,
            offset: cvCurrentPage * PAGE_SIZE,
        });

        if (token !== cvLoadToken) return;

        const results = data.results || [];
        const total = data.total || 0;

        for (const r of results) {
            r.fullPath = cvFullPath(r.folder, r.file);
        }

        if (cvCurrentPage === 0) {
            cvCharacters = results;
        } else {
            cvCharacters = cvCharacters.concat(results);
        }

        cvHasMore = cvCharacters.length < total && results.length === PAGE_SIZE;
        renderCvGrid();
    } catch (e) {
        if (token !== cvLoadToken) return;
        debugLog('[CharaVault] loadCvCharacters error:', e.message);
        if (cvCurrentPage === 0 && grid) {
            grid.innerHTML = `<div class="browse-error"><i class="fa-solid fa-exclamation-triangle"></i> Failed to load: ${escapeHtml(e.message)}</div>`;
        }
        cvHasMore = false;
    } finally {
        if (token === cvLoadToken) {
            cvIsLoading = false;
            // Loading state is cleared by renderCvGrid() / error fallback,
            // so no explicit teardown call is needed here.
        }
    }
}

function renderCvGrid(append = false) {
    const grid = document.getElementById('cvGrid');
    if (!grid) return;

    const startIdx = append ? cvGridRenderedCount : 0;
    if (!append) {
        grid.innerHTML = '';
        cvGridRenderedCount = 0;
    }

    const fragment = document.createDocumentFragment();
    for (let i = startIdx; i < cvCharacters.length; i++) {
        const char = cvCharacters[i];
        const card = buildCvCard(char);
        fragment.appendChild(card);
    }
    grid.appendChild(fragment);
    cvGridRenderedCount = cvCharacters.length;

    view.observeImages(grid);
    view.updateLoadMoreVisibility('cvLoadMore', cvHasMore, cvCharacters.length > 0);
}

function buildCvCard(char) {
    const inLib = cvIsInLibrary(char);
    const possible = !inLib && cvIsPossibleMatch(char);
    const thumbUrl = cvThumbUrl(char.folder, char.file);
    const name = escapeHtml(char.name || 'Unknown');
    const creator = escapeHtml(char.creator || '');
    const tokens = char.token_count ? formatNumber(char.token_count) : '';
    const rating = char.avg_rating ? char.avg_rating.toFixed(1) : '';
    const hasLore = char.has_lorebook;

    const badges = [];
    if (inLib) badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    else if (possible) badges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    if (hasLore) badges.push('<span class="browse-feature-badge cv-badge-lorebook" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');

    const card = document.createElement('div');
    card.className = `browse-card${inLib ? ' in-library' : ''}${possible ? ' possible-library' : ''}`;
    card.dataset.fullPath = char.fullPath;
    card.dataset.charIdx = String(cvCharacters.indexOf(char));
    card.innerHTML = `
        <div class="browse-card-image">
            <img data-src="${escapeHtml(thumbUrl)}" src="${IMG_PLACEHOLDER}" alt="${name}" loading="lazy">
            ${badges.length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
        </div>
        <div class="browse-card-info">
            <div class="browse-card-name">${name}</div>
            <div class="browse-card-creator">
                <a class="browse-card-creator-link" href="#" data-author="${creator}" data-creator-name="${creator}" title="Filter by ${creator}">
                    ${creator}
                </a>
            </div>
            <div class="browse-card-meta">
                ${tokens ? `<span title="Tokens"><i class="fa-solid fa-message"></i> ${tokens}</span>` : ''}
                ${rating ? `<span title="Rating"><i class="fa-solid fa-star"></i> ${rating}</span>` : ''}
            </div>
        </div>
    `;
    return card;
}

// ========================================
// GRID DELEGATE EVENTS
// ========================================

function setupCvGridDelegates() {
    const section = document.getElementById('cvBrowseSection');
    if (!section) return;

    section.addEventListener('click', (e) => {
        // Creator link
        const creatorLink = e.target.closest('.browse-card-creator-link');
        if (creatorLink) {
            e.preventDefault();
            e.stopPropagation();
            const author = creatorLink.dataset.author || '';
            if (author) filterByCreator(author);
            return;
        }

        // Card click -> open preview
        const card = e.target.closest('.browse-card');
        if (!card) return;
        const idx = parseInt(card.dataset.charIdx, 10);
        const char = cvCharacters[idx];
        if (char) openCvPreview(char);
    });
}

// ========================================
// CREATOR FILTER
// ========================================

function filterByCreator(creator) {
    cvCurrentCreator = creator;
    cvCurrentSearch = '';
    const searchInput = document.getElementById('cvSearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('cvClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    const banner = document.getElementById('cvCreatorBanner');
    const bannerName = document.getElementById('cvCreatorBannerName');
    if (banner) banner.classList.remove('hidden');
    if (bannerName) bannerName.textContent = creator;

    loadCvCharacters(true);
}

function clearCreatorFilter() {
    cvCurrentCreator = '';
    const banner = document.getElementById('cvCreatorBanner');
    if (banner) banner.classList.add('hidden');
    loadCvCharacters(true);
}

// ========================================
// SEARCH
// ========================================

function performCvSearch() {
    const input = document.getElementById('cvSearchInput');
    const q = input ? input.value.trim() : '';
    cvCurrentSearch = q;
    cvCurrentCreator = '';
    const banner = document.getElementById('cvCreatorBanner');
    if (banner) banner.classList.add('hidden');
    loadCvCharacters(true);
}

// ========================================
// NSFW TOGGLE
// ========================================

function updateCvNsfwToggle() {
    const btn = document.getElementById('cvNsfwToggle');
    if (!btn) return;
    btn.classList.remove('nsfw-active', 'nsfw-any');
    const span = btn.querySelector('span');
    if (cvNsfwMode === 'nsfw') {
        btn.classList.add('nsfw-active');
        if (span) span.textContent = 'NSFW Only';
    } else if (cvNsfwMode === 'any') {
        btn.classList.add('nsfw-any');
        if (span) span.textContent = 'NSFW + SFW';
    } else {
        if (span) span.textContent = 'SFW Only';
    }
}

function cycleCvNsfwMode() {
    // sfw -> nsfw -> any -> sfw
    cvNsfwMode = cvNsfwMode === 'sfw' ? 'nsfw' : cvNsfwMode === 'nsfw' ? 'any' : 'sfw';
}

// ========================================
// TAGS
// ========================================

async function loadCvTags() {
    if (cvTagsLoaded) return;
    const list = document.getElementById('cvTagsList');
    if (!list) return;

    try {
        cvPopularTags = await fetchCvTags();
        cvTagsLoaded = true;
        renderCvTagsList('');
    } catch (e) {
        if (list) list.innerHTML = '<div class="browse-tags-empty">Could not load tags</div>';
    }
}

function renderCvTagsList(filter) {
    const list = document.getElementById('cvTagsList');
    if (!list) return;

    const lowerFilter = filter.toLowerCase();
    const filtered = filter
        ? cvPopularTags.filter(([t]) => t.toLowerCase().includes(lowerFilter))
        : cvPopularTags;

    const top = filtered.slice(0, 80);
    if (top.length === 0) {
        list.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const [tag, count] of top) {
        const active = cvTagFilters.has(tag);
        const el = document.createElement('button');
        el.className = `browse-tag-pill${active ? ' active' : ''}`;
        el.dataset.tag = tag;
        el.title = `${tag} (${formatNumber(count)})`;
        el.textContent = tag;
        fragment.appendChild(el);
    }
    list.innerHTML = '';
    list.appendChild(fragment);
}

function toggleCvTag(tag) {
    if (cvTagFilters.has(tag)) {
        cvTagFilters.delete(tag);
    } else {
        cvTagFilters.add(tag);
    }
    updateCvTagsBtn();
    renderCvTagsList(document.getElementById('cvTagsSearchInput')?.value || '');
    loadCvCharacters(true);
}

function updateCvTagsBtn() {
    const label = document.getElementById('cvTagsBtnLabel');
    const btn = document.getElementById('cvTagsBtn');
    if (!label || !btn) return;
    if (cvTagFilters.size > 0) {
        label.textContent = `Tags (${cvTagFilters.size})`;
        btn.classList.add('active');
    } else {
        label.textContent = 'Tags';
        btn.classList.remove('active');
    }
}

function updateCvFiltersBtn() {
    const btn = document.getElementById('cvFiltersBtn');
    if (!btn) return;
    btn.classList.toggle('active', cvLorebookMode !== 'any');
}

// ========================================
// PREVIEW MODAL
// ========================================

async function openCvPreview(char) {
    cvSelectedChar = char;
    const modal = document.getElementById('cvCharModal');
    if (!modal) return;

    // Reset modal state
    const avatar = document.getElementById('cvCharAvatar');
    const nameEl = document.getElementById('cvCharName');
    const creatorEl = document.getElementById('cvCharCreator');
    const ratingEl = document.getElementById('cvCharRating');
    const ratingCountEl = document.getElementById('cvCharRatingCount');
    const tokensEl = document.getElementById('cvCharTokens');
    const tagsEl = document.getElementById('cvCharTags');
    const downloadsStat = document.getElementById('cvCharDownloadsStat');
    const downloadsEl = document.getElementById('cvCharDownloads');
    const lorebookStat = document.getElementById('cvCharLorebookStat');
    const lorebookTextEl = document.getElementById('cvCharLorebookText');
    const greetingsStat = document.getElementById('cvCharGreetingsStat');
    const greetingsCount = document.getElementById('cvCharGreetingsCount');
    const nsfwStat = document.getElementById('cvCharNsfwStat');
    const nsfwReasonsEl = document.getElementById('cvCharNsfwReasons');
    const tierBox = document.getElementById('cvCharTierBox');
    const tierLabel = document.getElementById('cvCharTierLabel');
    const tierDesc = document.getElementById('cvCharTierDesc');
    const tierPreset = document.getElementById('cvCharTierPreset');
    const openBtn = document.getElementById('cvOpenInBrowserBtn');
    const downloadBtn = document.getElementById('cvDownloadBtn');
    const notesEl = document.getElementById('cvCharCreatorNotes');
    const descSection = document.getElementById('cvCharDescriptionSection');
    const descEl = document.getElementById('cvCharDescription');
    const personalitySection = document.getElementById('cvCharPersonalitySection');
    const personalityEl = document.getElementById('cvCharPersonality');
    const scenarioSection = document.getElementById('cvCharScenarioSection');
    const scenarioEl = document.getElementById('cvCharScenario');
    const firstMsgSection = document.getElementById('cvCharFirstMsgSection');
    const firstMsgEl = document.getElementById('cvCharFirstMsg');
    const examplesSection = document.getElementById('cvCharExamplesSection');
    const examplesEl = document.getElementById('cvCharExamples');
    const systemPromptSection = document.getElementById('cvCharSystemPromptSection');
    const systemPromptEl = document.getElementById('cvCharSystemPrompt');
    const postHistorySection = document.getElementById('cvCharPostHistorySection');
    const postHistoryEl = document.getElementById('cvCharPostHistory');
    const altGreetingsSection = document.getElementById('cvCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('cvCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('cvCharAltGreetingsCount');

    const thumbUrl = cvThumbUrl(char.folder, char.file);
    const fullPath = char.fullPath;

    if (avatar) { avatar.src = thumbUrl; avatar.alt = char.name || ''; }
    if (nameEl) nameEl.textContent = char.name || 'Unknown';
    if (creatorEl) {
        creatorEl.textContent = char.creator || 'Unknown';
        creatorEl.href = '#';
        creatorEl.dataset.creator = char.creator || '';
    }
    if (ratingEl) ratingEl.textContent = char.avg_rating ? char.avg_rating.toFixed(1) : '0.0';
    if (ratingCountEl) ratingCountEl.textContent = char.rating_count ? `(${formatNumber(char.rating_count)})` : '';
    if (tokensEl) tokensEl.textContent = char.token_count ? formatNumber(char.token_count) : '0';
    if (downloadsStat) downloadsStat.style.display = char.download_count ? '' : 'none';
    if (downloadsEl) downloadsEl.textContent = char.download_count ? formatNumber(char.download_count) : '0';
    if (lorebookStat) {
        lorebookStat.style.display = char.has_lorebook ? '' : 'none';
        if (lorebookTextEl) lorebookTextEl.textContent = 'Lorebook';
    }
    if (nsfwStat) {
        const reasons = (char.nsfw_reasons || []).filter(Boolean);
        if (char.nsfw && reasons.length > 0) {
            nsfwStat.style.display = '';
            if (nsfwReasonsEl) nsfwReasonsEl.textContent = reasons.join(', ');
        } else {
            nsfwStat.style.display = 'none';
        }
    }
    if (tierBox) tierBox.style.display = 'none';
    if (greetingsStat) greetingsStat.style.display = 'none';

    if (tagsEl) {
        const excludeTags = getProviderExcludeTags?.() || [];
        const filtered = (char.tags || []).filter(t => !excludeTags.includes(t));
        tagsEl.innerHTML = filtered.map(t =>
            `<span class="browse-tag">${escapeHtml(t)}</span>`
        ).join('');
    }

    if (openBtn) openBtn.href = `https://charavault.net/cards/preview/${encodeURIComponent(char.folder)}/${encodeURIComponent(char.file)}`;
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    }

    // Show preview text from browse list data while we fetch full data
    if (notesEl) {
        const preview = char.description_preview || '';
        notesEl.textContent = preview || 'Loading...';
    }
    // Reset all dynamic sections to hidden; populated below from full metadata.
    for (const s of [descSection, personalitySection, scenarioSection,
                     firstMsgSection, examplesSection, systemPromptSection,
                     postHistorySection, altGreetingsSection]) {
        if (s) s.style.display = 'none';
    }
    for (const el of [descEl, personalityEl, scenarioEl, firstMsgEl,
                      examplesEl, systemPromptEl, postHistoryEl]) {
        if (el) {
            el.innerHTML = '';
            delete el.dataset.fullContent;
        }
    }

    modal.classList.remove('hidden');

    // Fetch full metadata + live rating + linked lorebooks in parallel.
    // Each is best-effort; failure of one doesn't block the rest.
    let detail = null;
    let liveRating = null;
    let linkedLorebooks = null;
    try {
        [detail, liveRating, linkedLorebooks] = await Promise.all([
            fetchCvCardDetail(fullPath),
            fetchCvRating(fullPath),
            fetchCvLinkedLorebooks(fullPath),
        ]);
    } catch (e) {
        debugLog('[CharaVault] openCvPreview parallel fetch error:', e.message);
    }
    // Bail if user navigated away while we were fetching.
    if (cvSelectedChar?.fullPath !== fullPath) return;

    // Live rating refresh - the value in the search-list row may be stale.
    if (liveRating) {
        if (ratingEl) ratingEl.textContent = (liveRating.avg_rating || 0).toFixed(1);
        if (ratingCountEl) ratingCountEl.textContent = liveRating.rating_count
            ? `(${formatNumber(liveRating.rating_count)})` : '';
    }

    // Linked lorebooks - shows even if has_lorebook flag is missing.
    const linkedCount = linkedLorebooks?.lorebooks?.length || 0;
    if (linkedCount > 0 && lorebookStat) {
        lorebookStat.style.display = '';
        if (lorebookTextEl) lorebookTextEl.textContent = `${linkedCount} lorebook${linkedCount === 1 ? '' : 's'}`;
    }

    // Bail out of detail-dependent UI if detail fetch failed.
    if (!detail) return;

    try {
        const meta = detail.fullMetadata?.data || {};
        const entry = detail.entry || {};
        const recs = detail.recommendations || null;

        // Tier hint (model class recommendation).
        if (tierBox && recs && (recs.tier_label || recs.tier_description)) {
            tierBox.style.display = '';
            if (tierLabel) tierLabel.textContent = recs.tier_label || '';
            if (tierDesc) tierDesc.textContent = recs.tier_description || '';
            if (tierPreset) tierPreset.textContent = recs.suggested_preset
                ? `Preset: ${recs.suggested_preset}`
                : '';
        }

        // Live downloads from detail entry (search-list row already had it,
        // but detail wins if both are present).
        if (downloadsStat && entry.download_count) {
            downloadsStat.style.display = '';
            if (downloadsEl) downloadsEl.textContent = formatNumber(entry.download_count);
        }

        if (notesEl) {
            cleanupCreatorNotesContainer?.(notesEl);
            const notes = meta.creator_notes || char.description_preview || 'No description available.';
            if (renderCreatorNotesSecure) {
                renderCreatorNotesSecure(notes, char.name || '', notesEl);
            } else {
                notesEl.textContent = notes;
            }
        }

        const cName = char.name || meta.name || '';
        // Helper: render rich-text with full-content stash for the "expand"
        // modal that core opens on section-title click.
        const renderRich = (section, el, value) => {
            if (!section || !el || !value) return;
            section.style.display = '';
            el.innerHTML = safePurify(formatRichText(value, cName, true), BROWSE_PURIFY_CONFIG);
            el.dataset.fullContent = value;
        };

        renderRich(descSection, descEl, meta.description);
        renderRich(personalitySection, personalityEl, meta.personality);
        renderRich(scenarioSection, scenarioEl, meta.scenario);
        renderRich(firstMsgSection, firstMsgEl, meta.first_mes);
        renderRich(examplesSection, examplesEl, meta.mes_example);
        renderRich(systemPromptSection, systemPromptEl, meta.system_prompt);
        renderRich(postHistorySection, postHistoryEl, meta.post_history_instructions);

        const alts = meta.alternate_greetings || [];
        if (altGreetingsEl && alts.length > 0) {
            altGreetingsSection.style.display = '';
            if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${alts.length})`;
            if (greetingsStat) {
                greetingsStat.style.display = '';
                if (greetingsCount) greetingsCount.textContent = alts.length + 1;
            }
            // Lazy-render alt greeting bodies on first <details> open. Saves
            // a lot of formatRichText work if the user never expands them.
            const buildPreview = (text) => {
                const cleaned = (text || '').replace(/\s+/g, ' ').trim();
                if (!cleaned) return 'No content';
                return cleaned.length > 90 ? `${cleaned.slice(0, 87)}\u2026` : cleaned;
            };
            altGreetingsEl.innerHTML = alts.map((g, i) =>
                `<details class="browse-alt-greeting" data-greeting-idx="${i}">
                    <summary>
                        <span class="browse-alt-greeting-index">#${i + 1}</span>
                        <span class="browse-alt-greeting-preview">${escapeHtml(buildPreview(g))}</span>
                        <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                    </summary>
                    <div class="browse-alt-greeting-body"></div>
                </details>`
            ).join('');
            altGreetingsEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
                details.addEventListener('toggle', function onToggle() {
                    if (!details.open) return;
                    const body = details.querySelector('.browse-alt-greeting-body');
                    if (body && !body.dataset.rendered) {
                        const idx = parseInt(details.dataset.greetingIdx, 10);
                        if (alts[idx] != null) {
                            body.innerHTML = safePurify(formatRichText(alts[idx], cName, true), BROWSE_PURIFY_CONFIG);
                        }
                        body.dataset.rendered = '1';
                    }
                }, { once: true });
            });
            // Expose for the core's fullscreen alt-greetings modal.
            window.currentBrowseAltGreetings = alts;
        } else {
            window.currentBrowseAltGreetings = [];
        }

        // Linked lorebooks list (already fetched in parallel above).
        const linkedBooksSection = document.getElementById('cvCharLinkedBooksSection');
        const linkedBooksEl = document.getElementById('cvCharLinkedBooks');
        const linkedBooksCountEl = document.getElementById('cvCharLinkedBooksCount');
        if (linkedBooksSection && linkedBooksEl) {
            const books = linkedLorebooks?.lorebooks || [];
            if (books.length > 0) {
                linkedBooksSection.style.display = '';
                if (linkedBooksCountEl) linkedBooksCountEl.textContent = `(${books.length})`;
                linkedBooksEl.innerHTML = books.map(b => {
                    const id = escapeHtml(b.id || '');
                    const title = escapeHtml(b.title || b.name || `Lorebook ${id}`);
                    const entries = b.entry_count != null ? ` &middot; ${formatNumber(b.entry_count)} entries` : '';
                    return `<div class="cv-linked-book">
                        <i class="fa-solid fa-book"></i>
                        <span class="cv-linked-book-title">${title}</span>
                        <span class="cv-linked-book-meta">${entries}</span>
                    </div>`;
                }).join('');
            } else {
                linkedBooksSection.style.display = 'none';
            }
        }
    } catch (e) {
        debugLog('[CharaVault] openCvPreview detail render error:', e.message);
    }

    // Reset similar section to its idle state. The user opts into the
    // /cards/similar fetch via the "Find Similar" button - it can be slow
    // and many cards have no image-hash match.
    const simEl = document.getElementById('cvCharSimilar');
    const simCountEl = document.getElementById('cvCharSimilarCount');
    const simStatus = document.getElementById('cvSimilarStatus');
    const simBtn = document.getElementById('cvFindSimilarBtn');
    if (simEl) simEl.innerHTML = '';
    if (simCountEl) simCountEl.textContent = '';
    if (simStatus) simStatus.textContent = '';
    if (simBtn) {
        simBtn.disabled = false;
        simBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Find Similar';
    }
}

async function loadCvSimilar(diskPath) {
    const simEl = document.getElementById('cvCharSimilar');
    const simCountEl = document.getElementById('cvCharSimilarCount');
    const simStatus = document.getElementById('cvSimilarStatus');
    const simBtn = document.getElementById('cvFindSimilarBtn');
    if (simBtn) {
        simBtn.disabled = true;
        simBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';
    }
    if (simStatus) simStatus.textContent = '';
    try {
        // Capture the active fullPath at call time so concurrent opens of
        // other cards do not mistakenly render this result set.
        const callerFullPath = cvSelectedChar?.fullPath;
        const res = await fetchCvSimilar(diskPath);
        if (cvSelectedChar?.fullPath !== callerFullPath) return;
        if (!simEl) return;
        const results = res?.results || [];
        if (!res?.ok) {
            simEl.innerHTML = '';
            if (simCountEl) simCountEl.textContent = '';
            if (simStatus) {
                if (res?.reason === 'no_hash') {
                    simStatus.textContent = 'This card has no image-hash entry on CharaVault, so visual similarity is unavailable.';
                } else if (res?.reason === 'http') {
                    simStatus.textContent = `Server returned HTTP ${res.status}.`;
                } else {
                    simStatus.textContent = `Error: ${res?.error || 'unknown'}`;
                }
            }
            return;
        }
        if (results.length === 0) {
            simEl.innerHTML = '';
            if (simCountEl) simCountEl.textContent = '';
            if (simStatus) simStatus.textContent = 'No visually similar cards found.';
            return;
        }
        if (simCountEl) simCountEl.textContent = `(${results.length})`;
        simEl.innerHTML = results.map(s => {
            const folder = s.folder || '';
            const file = s.file || '';
            const fp = cvFullPath(folder, file);
            const thumb = cvThumbUrl(folder, file);
            const name = escapeHtml(s.name || file || 'Unknown');
            const creator = s.creator && s.creator !== 'Unknown'
                ? `<div class="cv-similar-card-creator">${escapeHtml(s.creator)}</div>`
                : '';
            const score = (typeof s.score === 'number')
                ? `<div class="cv-similar-card-score" title="Match score">${s.score.toFixed(0)}%</div>`
                : '';
            const reasons = Array.isArray(s.reasons) && s.reasons.length
                ? escapeHtml(s.reasons.join(', '))
                : '';
            const tooltip = reasons ? `${name} \u2014 ${reasons}` : name;
            return `<div class="cv-similar-card" data-full-path="${escapeHtml(fp)}" title="${tooltip}">
                <div class="cv-similar-card-thumb">
                    <img src="${escapeHtml(thumb)}" alt="${name}" loading="lazy">
                    ${score}
                </div>
                <div class="cv-similar-card-name">${name}</div>
                ${creator}
            </div>`;
        }).join('');
    } catch (e) {
        debugLog('[CharaVault] loadCvSimilar error:', e);
        if (simStatus) simStatus.textContent = `Error: ${e.message || e}`;
    } finally {
        if (simBtn && document.contains(simBtn)) {
            simBtn.disabled = false;
            simBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Search again';
        }
    }
}

// ========================================
// INIT EVENT HANDLERS
// ========================================

function initCvView() {
    const sortEl = document.getElementById('cvSortSelect');
    if (sortEl) {
        sortEl.value = cvSortMode;
        CoreAPI.initCustomSelect?.(sortEl);
    }
    updateCvNsfwToggle();
    setupCvGridDelegates();

    // Sort change
    on('cvSortSelect', 'change', (e) => {
        cvSortMode = e.target.value;
        loadCvCharacters(true);
    });

    // Search input
    on('cvSearchInput', 'keypress', (e) => { if (e.key === 'Enter') performCvSearch(); });
    on('cvSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('cvClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('cvSearchBtn', 'click', () => performCvSearch());
    on('cvClearSearchBtn', 'click', () => {
        const input = document.getElementById('cvSearchInput');
        if (input) { input.value = ''; input.focus(); }
        document.getElementById('cvClearSearchBtn')?.classList.add('hidden');
        performCvSearch();
    });

    // Creator filter
    on('cvCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            const val = document.getElementById('cvCreatorSearchInput')?.value.trim();
            if (val) filterByCreator(val);
        }
    });
    on('cvCreatorSearchBtn', 'click', () => {
        const val = document.getElementById('cvCreatorSearchInput')?.value.trim();
        if (val) filterByCreator(val);
    });
    on('cvClearCreatorBtn', 'click', () => {
        const input = document.getElementById('cvCreatorSearchInput');
        if (input) input.value = '';
        clearCreatorFilter();
    });

    // NSFW toggle (3-state cycle)
    on('cvNsfwToggle', 'click', () => {
        cycleCvNsfwMode();
        updateCvNsfwToggle();
        loadCvCharacters(true);
    });

    // Refresh
    on('refreshCvBtn', 'click', () => loadCvCharacters(true));

    // Load more button
    on('cvLoadMoreBtn', 'click', async () => {
        if (cvIsLoading) return;
        cvCurrentPage++;
        await loadCvCharacters();
    });

    // Filters dropdown
    on('cvFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('cvTagsDropdown')?.classList.add('hidden');
        document.getElementById('cvFiltersDropdown')?.classList.toggle('hidden');
    });
    // Lorebook 3-state radio
    document.querySelectorAll('input[name="cvLorebookMode"]').forEach(input => {
        input.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            cvLorebookMode = e.target.value;
            updateCvFiltersBtn();
            loadCvCharacters(true);
        });
    });

    // Tags dropdown
    on('cvTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('cvFiltersDropdown')?.classList.add('hidden');
        const dropdown = document.getElementById('cvTagsDropdown');
        const wasHidden = dropdown?.classList.contains('hidden');
        dropdown?.classList.toggle('hidden');
        if (wasHidden) loadCvTags();
    });

    on('cvTagsSearchInput', 'input', (e) => {
        renderCvTagsList(e.target.value);
    });

    on('cvTagsClearBtn', 'click', () => {
        cvTagFilters.clear();
        updateCvTagsBtn();
        const searchInput = document.getElementById('cvTagsSearchInput');
        if (searchInput) searchInput.value = '';
        renderCvTagsList('');
        loadCvCharacters(true);
    });

    const tagsList = document.getElementById('cvTagsList');
    if (tagsList) {
        tagsList.addEventListener('click', (e) => {
            const pill = e.target.closest('.browse-tag-pill');
            if (pill) toggleCvTag(pill.dataset.tag);
        });
    }

    // Modal events
    on('cvCharClose', 'click', () => {
        const notesEl = document.getElementById('cvCharCreatorNotes');
        if (notesEl) cleanupCreatorNotesContainer?.(notesEl);
        hideModal('cvCharModal');
        cvSelectedChar = null;
    });

    on('cvCharCreator', 'click', (e) => {
        e.preventDefault();
        const creator = e.target.dataset.creator || '';
        if (creator) {
            hideModal('cvCharModal');
            cvSelectedChar = null;
            filterByCreator(creator);
        }
    });

    // Modal-level event delegation. Handlers bind to the modal root once, so
    // they survive innerHTML rewrites of inner sections and are not racey with
    // initCvView() ordering. Fire & forget: handlers never throw out.
    const modal = document.getElementById('cvCharModal');
    if (modal) {
        modal.addEventListener('click', async (e) => {
            // Similar-card click - open that character's preview by fetching
            // the row from the card list. Falls back to a synthetic char.
            const simCard = e.target.closest('.cv-similar-card[data-full-path]');
            if (simCard) {
                const fp = simCard.dataset.fullPath;
                if (!fp) return;
                // Look up in current grid first.
                const known = cvCharacters.find(c => c.fullPath === fp);
                if (known) {
                    openCvPreview(known);
                } else {
                    // Synthetic char - openCvPreview tolerates missing fields
                    // and will fetch detail asynchronously.
                    const slash = fp.indexOf('/');
                    const folder = slash >= 0 ? fp.slice(0, slash) : '';
                    const file = slash >= 0 ? fp.slice(slash + 1) : fp;
                    openCvPreview({ fullPath: fp, folder, file, name: file.replace(/\.png$/i, '') });
                }
                return;
            }

            // Section title clicks are handled globally by the core's
            // initBrowseExpandButtons() (opens fullscreen expand modal /
            // toggles inline collapse based on user setting). Do not
            // intercept them here - that previously broke the expand modal.


            // Find Similar button - opt-in /cards/similar fetch.
            const findSimBtn = e.target.closest('#cvFindSimilarBtn');
            if (findSimBtn) {
                e.preventDefault();
                const char = cvSelectedChar;
                if (!char?.fullPath) {
                    return;
                }
                // Backend takes the absolute server-side disk path, not
                // folder/file. entry.path is populated by both search-list
                // rows and detail responses; fall back to detail fetch only
                // if it is missing for some reason.
                let diskPath = char.path;
                if (!diskPath) {
                    try {
                        const detail = await fetchCvCardDetail(char.fullPath);
                        diskPath = detail?.entry?.path || null;
                    } catch { /* ignore */ }
                }
                if (!diskPath) {
                    debugLog('[CharaVault] Find Similar: no entry.path for', char.fullPath);
                    if (typeof showToast === 'function') showToast('No image-hash path on record for this card', 'warning');
                    return;
                }
                await loadCvSimilar(diskPath);
                return;
            }

            // Import button (also fires when icon inside is clicked)
            const importBtn = e.target.closest('#cvDownloadBtn');
            if (importBtn) {
                e.preventDefault();
                const char = cvSelectedChar;
                if (!char) {
                    return;
                }
                if (typeof window.cvImportCharacter !== 'function') {
                    debugLog('[CharaVault] window.cvImportCharacter is not registered. Provider init() may have failed.');
                    showToast?.('CharaVault provider not initialized', 'error');
                    return;
                }
                importBtn.disabled = true;
                const origHtml = importBtn.innerHTML;
                importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
                try {
                    const result = await window.cvImportCharacter(char.fullPath, char);
                    if (result?.success) {
                        markCvCardImported(char.fullPath);
                        showToast?.(`Imported "${result.characterName}"`, 'success');
                    } else {
                        showToast?.(`Import failed: ${result?.error || 'unknown'}`, 'error');
                    }
                } catch (err) {
                    debugLog('[CharaVault] Import threw:', err);
                    showToast?.(`Import failed: ${err.message || err}`, 'error');
                } finally {
                    if (document.contains(importBtn)) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = origHtml;
                    }
                }
                return;
            }
        });
    }
}

// ========================================
// EXPORTS
// ========================================

// Expose for the download button handler wired in initCvView
export { loadCvCharacters, markCvCardImported };

const charavaultBrowseView = new CharaVaultBrowseView(null);
export default charavaultBrowseView;
