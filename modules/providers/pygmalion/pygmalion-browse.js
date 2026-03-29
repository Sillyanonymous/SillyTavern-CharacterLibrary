// Pygmalion Browse View — Online tab UI for pygmalion.chat character browsing
//
// Grid-based browse with search, sort, NSFW toggle.
// Preview modal fetches full character detail via Connect RPC API.

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    searchCharacters,
    fetchCharacterDetail,
    fetchCharactersByOwner,
    getAvatarUrl,
    getCharacterPageUrl,
    getGalleryImages,
    getFollowedUsers,
    toggleFollowUser,
    stripHtml,
    PYGMALION_SITE_BASE,
    CL_HELPER_PLUGIN_BASE,
    checkPluginAvailable,
    getTokenTTL,
} from './pygmalion-api.js';

const {
    onElement: on, showToast, escapeHtml, debugLog, getSetting, setSetting,
    fetchCharacters, fetchAndAddCharacter,
    checkCharacterForDuplicatesAsync, showPreImportDuplicateWarning,
    deleteCharacter, getCharacterGalleryId, showImportSummaryModal,
    formatRichText, debounce,
    apiRequest, cleanupCreatorNotesContainer,
    getProviderExcludeTags,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let pygCharacters = [];
let pygCurrentSearch = '';
let pygSortMode = 'downloads';
let pygSortDescending = true;
let pygNsfwEnabled = false;
let pygCurrentPage = 0;
let pygTotalItems = 0;
let pygHasMore = true;
let pygIsLoading = false;
let pygGridRenderedCount = 0;

let pygSelectedChar = null;
let delegatesInitialized = false;

let pygIncludeTags = new Set();
let pygExcludeTags = new Set();
let pygKnownTags = new Set();
let pygFilterHideOwned = false;
let pygFilterHidePossible = false;

// View mode: 'browse' or 'following'
let pygViewMode = 'browse';
let pygToken = null;
let pygFollowedUsers = [];
let pygFollowingCharacters = [];
let pygFollowingLoading = false;
let pygFollowingSort = 'newest';

// Auth state
let pygPluginAvailable = false;
let pygAutoRefreshTimer = null;
let pygLoginInProgress = false;

const PAGE_SIZE = 48;

// Well-known tags seeded from popular characters
const SEED_TAGS = [
    'Female', 'Male', 'Human', 'Non-Human', 'Anime', 'Original', 'Original Character',
    'Ali:Chat', 'minimALIstic', 'Adventure', 'Horror', 'Yandere', 'Scenario', 'Fun',
    'Magical', 'Monster Girl', 'Monster Boy', 'Furry', 'Robot', 'Elf', 'Demon', 'Deity',
    'Video Game', 'Extrovert', 'Introvert', 'Kuudere', 'Deredere', 'Gimmick', 'Joke',
    'Knight', 'Wizard', 'Meme', 'W++',
];
for (const t of SEED_TAGS) pygKnownTags.add(t);

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// PURIFY CONFIG (for formatRichText in modal)
// ========================================

const BROWSE_PURIFY_CONFIG = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'p', 'span', 'div', 'ul', 'ol', 'li', 'hr', 'a', 'blockquote', 'code', 'pre'],
    ALLOWED_ATTR: ['class', 'style', 'href', 'target', 'rel'],
};

// ========================================
// LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(hit) {
    if (hit.id && view._lookup.byProviderId.has(hit.id)) return true;

    const name = (hit.displayName || hit.name || '').toLowerCase().trim();
    const creator = (hit.owner?.username || hit.owner?.displayName || '').toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(h) {
    if (isCharInLocalLibrary(h)) return false;
    const owner = h.owner || {};
    return view.isCharPossibleMatch(h.displayName || h.name || '', owner.username || owner.displayName || '');
}

// ========================================
// TAG CLAMPING
// ========================================

function applyTagsClamp(tagsEl) {
    if (!tagsEl) return;

    const existingToggle = tagsEl.querySelector('.browse-tags-more');
    if (existingToggle) existingToggle.remove();
    tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
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

// ========================================
// CARD RENDERING
// ========================================

function createPygCard(hit) {
    const name = hit.displayName || 'Unknown';
    const desc = stripHtml(hit.description || '');
    const avatarUrl = hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '/img/ai4.png';
    const tags = (hit.tags || []).slice(0, 3);
    const owner = hit.owner || {};
    const creator = owner.username || owner.displayName || '';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.displayName || hit.name || '', creator);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    }

    const galleryCount = (hit.altAvatars?.length || 0) + (hit.altImages?.length || 0);
    if (galleryCount > 0) {
        badges.push(`<span class="browse-feature-badge" title="${galleryCount} gallery image${galleryCount > 1 ? 's' : ''}"><i class="fa-solid fa-images"></i></span>`);
    }

    const createdDate = hit.approvedAt
        ? new Date(parseInt(hit.approvedAt, 10) * 1000).toLocaleDateString()
        : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-pyg-id="${escapeHtml(hit.id || '')}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${hit.isSensitive ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creator ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creator)}" data-owner-id="${escapeHtml(owner.id || '')}" title="Click to see all characters by ${escapeHtml(creator)}">${escapeHtml(creator)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.downloads || 0)}</span>
                <span class="browse-card-stat" title="Stars"><i class="fa-solid fa-star"></i> ${formatNumber(hit.stars || 0)}</span>
                <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(hit.chatCount || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

function observeNewCards() {
    const grid = document.getElementById('pygGrid');
    if (!grid) return;
    pygmalionBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('pygGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        pygGridRenderedCount = 0;
    }

    const startIdx = pygGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createPygCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    pygGridRenderedCount = characters.length;

    observeNewCards();
    updateLoadMore();
}

function updateLoadMore() {
    // Pyg allows loading more even when current list is empty (client-side filters may hide all results on a page)
    pygmalionBrowseView.updateLoadMoreVisibility('pygLoadMore', pygHasMore, true);
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (pygIsLoading) return;
    pygIsLoading = true;

    const grid = document.getElementById('pygGrid');
    const loadMoreBtn = document.getElementById('pygLoadMoreBtn');

    if (!append && grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Searching Pygmalion...</p>
            </div>
        `;
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let data;

        const mergedExclude = [...pygExcludeTags];
        for (const t of getProviderExcludeTags('pygmalion')) {
            if (!mergedExclude.includes(t)) mergedExclude.push(t);
        }

        if (pygAuthorOwnerId) {
            // Dedicated owner API for author filter
            data = await fetchCharactersByOwner(pygAuthorOwnerId, pygAuthorSort, pygCurrentPage, pygToken || undefined);
        } else {
            data = await searchCharacters({
                query: pygCurrentSearch,
                orderBy: pygSortMode,
                orderDescending: pygSortDescending,
                includeSensitive: pygNsfwEnabled,
                token: pygNsfwEnabled ? pygToken : undefined,
                pageSize: PAGE_SIZE,
                page: pygCurrentPage,
                tagsNamesInclude: [...pygIncludeTags],
                tagsNamesExclude: mergedExclude,
            });
        }

        if (!delegatesInitialized) return;

        let hits = data?.characters || [];
        pygTotalItems = parseInt(data?.totalItems || '0', 10);
        const totalPages = Math.ceil(pygTotalItems / PAGE_SIZE);

        // Client-side: strict tag filtering (API does substring matching, so "Male" matches "Female")
        // Only apply in search mode (author mode API doesn't support tags anyway)
        const strictTagFilter = pygIncludeTags.size > 0 && !pygAuthorOwnerId;
        if (strictTagFilter) {
            const requiredTags = Array.from(pygIncludeTags).map(t => t.toLowerCase());
            hits = hits.filter(h => {
                if (!h.tags || !Array.isArray(h.tags)) return false;
                const charTags = h.tags.map(t => t.toLowerCase());
                return requiredTags.every(rt => charTags.includes(rt));
            });
            debugLog('[PygBrowse] Client-side filtered hits:', hits.length);
        }

        // Collect tags from results
        collectTagsFromResults(hits);

        // Client-side: hide owned / possible match characters
        if (pygFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }
        if (pygFilterHidePossible) {
            hits = hits.filter(h => !isCharPossibleMatchObj(h));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = pygFilterHideOwned || pygFilterHidePossible || strictTagFilter;
        if (hasClientFilters && pygCurrentPage < totalPages - 1) {
            let autoFetches = 0;
            while (hits.length < PAGE_SIZE && pygCurrentPage < totalPages - 1 && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                pygCurrentPage++;
                let moreData;
                if (pygAuthorOwnerId) {
                    moreData = await fetchCharactersByOwner(pygAuthorOwnerId, pygAuthorSort, pygCurrentPage, pygToken || undefined);
                } else {
                    moreData = await searchCharacters({
                        query: pygCurrentSearch,
                        orderBy: pygSortMode,
                        orderDescending: pygSortDescending,
                        includeSensitive: pygNsfwEnabled,
                        token: pygNsfwEnabled ? pygToken : undefined,
                        pageSize: PAGE_SIZE,
                        page: pygCurrentPage,
                        tagsNamesInclude: [...pygIncludeTags],
                        tagsNamesExclude: mergedExclude,
                    });
                }
                if (!delegatesInitialized) return;
                let moreHits = moreData?.characters || [];
                if (strictTagFilter) {
                    const requiredTags = Array.from(pygIncludeTags).map(t => t.toLowerCase());
                    moreHits = moreHits.filter(h => {
                        if (!h.tags || !Array.isArray(h.tags)) return false;
                        const charTags = h.tags.map(t => t.toLowerCase());
                        return requiredTags.every(rt => charTags.includes(rt));
                    });
                }
                collectTagsFromResults(moreHits);
                if (pygFilterHideOwned) {
                    moreHits = moreHits.filter(h => !isCharInLocalLibrary(h));
                }
                if (pygFilterHidePossible) {
                    moreHits = moreHits.filter(h => !isCharPossibleMatchObj(h));
                }
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[PygBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters`);
            }
        }

        if (append) {
            pygCharacters = pygCharacters.concat(hits);
        } else {
            pygCharacters = hits;
        }

        pygHasMore = pygCurrentPage < totalPages - 1;

        renderGrid(pygCharacters, append);

        if (!append && pygCharacters.length === 0) {
            const msg = pygHasMore ? 'No valid characters found on this page (API fuzzy match filtered out) — try loading more' : 'No characters found';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-search" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">${msg}</p>
                </div>
            `;
        }

        debugLog('[PygBrowse] Loaded', hits.length, 'characters, page', pygCurrentPage, '/', totalPages, 'total:', pygTotalItems);

    } catch (err) {
        if (err.authFailed && pygNsfwEnabled) {
            console.warn('[PygBrowse] Auth failed during NSFW search, attempting re-login:', err.message);
            // Try auto-login before falling back to SFW
            const recovered = await attemptTokenRecovery();
            if (recovered) {
                debugLog('[PygBrowse] Token recovered, retrying with NSFW');
                setTimeout(() => loadCharacters(false), 0);
            } else {
                pygNsfwEnabled = false;
                setSetting('pygmalionNsfw', false);
                updateNsfwToggle();
                showToast('Pygmalion token expired — please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
                setTimeout(() => loadCharacters(false), 0);
            }
        } else {
            console.error('[PygBrowse] Search error:', err);
            showToast(`Pygmalion search failed: ${err.message}`, 'error');
            if (!append && grid) {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                        <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                        <p style="margin-top: 12px;">Search failed: ${escapeHtml(err.message)}</p>
                        <button class="glass-btn" style="margin-top: 12px;" id="pygRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
                const retryBtn = document.getElementById('pygRetryBtn');
                if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
            }
        }
    } finally {
        pygIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

// ========================================
// TAGS FILTER
// ========================================

function collectTagsFromResults(characters) {
    for (const char of characters) {
        if (!Array.isArray(char.tags)) continue;
        for (const tag of char.tags) {
            if (tag) pygKnownTags.add(tag);
        }
    }
}

function getSortedTagList() {
    return [...pygKnownTags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function renderPygTagsList(filter = '') {
    const container = document.getElementById('pygTagsList');
    if (!container) return;

    const allTags = getSortedTagList();
    const filtered = filter
        ? allTags.filter(t => t.toLowerCase().includes(filter.toLowerCase()))
        : allTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tagName => {
        const included = pygIncludeTags.has(tagName);
        const excluded = pygExcludeTags.has(tagName);
        const stateClass = included ? 'state-include' : excluded ? 'state-exclude' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : excluded ? '<i class="fa-solid fa-minus"></i>' : '';
        const stateTitle = included ? 'Included — click to exclude' : excluded ? 'Excluded — click to reset' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-name="${escapeHtml(tagName)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tagName)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagName = item.dataset.tagName;
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            if (pygIncludeTags.has(tagName)) {
                pygIncludeTags.delete(tagName);
                pygExcludeTags.add(tagName);
            } else if (pygExcludeTags.has(tagName)) {
                pygExcludeTags.delete(tagName);
            } else {
                pygIncludeTags.add(tagName);
            }
            cyclePygTagState(stateBtn, tagName);
            updatePygTagsButton();
            if (pygViewMode === 'following') {
                renderPygFollowing();
            } else {
                pygCurrentPage = 0;
                loadCharacters(false);
            }
        });
    });
}

function cyclePygTagState(btn, tagName) {
    btn.className = 'browse-tag-state-btn';
    if (pygIncludeTags.has(tagName)) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included — click to exclude';
    } else if (pygExcludeTags.has(tagName)) {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded — click to reset';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updatePygTagsButton() {
    const btn = document.getElementById('pygTagsBtn');
    const label = document.getElementById('pygTagsBtnLabel');
    if (!btn) return;

    const count = pygIncludeTags.size + pygExcludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updatePygFiltersButton() {
    const btn = document.getElementById('pygFiltersBtn');
    if (!btn) return;
    btn.classList.toggle('has-filters', pygFilterHideOwned || pygFilterHidePossible || !pygSortDescending);
}

// ========================================
// PREVIEW MODAL
// ========================================

let pygDetailFetchToken = 0;

function openPreviewModal(hit) {
    pygSelectedChar = hit;

    const modal = document.getElementById('pygCharModal');
    if (!modal) return;

    const name = hit.displayName || hit.personality?.name || 'Unknown';
    const owner = hit.owner || {};
    const creator = owner.username || owner.displayName || 'Unknown';
    const avatarUrl = hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '/img/ai4.png';
    const pygUrl = getCharacterPageUrl(hit.id);
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', creator);

    try {
        const tagline = stripHtml(hit.description || '');
        const tags = hit.tags || [];
        const downloads = formatNumber(hit.downloads || 0);
        const stars = formatNumber(hit.stars || 0);
        const views = formatNumber(hit.views || 0);
        const chats = formatNumber(hit.chatCount || 0);

        const createdDate = hit.approvedAt
            ? new Date(parseInt(hit.approvedAt, 10) * 1000).toLocaleDateString()
            : '';

        // Header
        const avatarImg = document.getElementById('pygCharAvatar');
        if (avatarImg) {
            avatarImg.src = avatarUrl;
            avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
            BrowseView.adjustPortraitPosition(avatarImg);
        }
        const nameEl = document.getElementById('pygCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('pygCharCreator');
        if (creatorEl) {
            creatorEl.textContent = creator;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${creator}`;
            creatorEl.dataset.ownerId = owner.id || '';
        }
        // External profile link
        const creatorExternal = document.getElementById('pygCreatorExternal');
        if (creatorExternal) {
            creatorExternal.href = creator ? `${PYGMALION_SITE_BASE}/user/${encodeURIComponent(creator)}` : '#';
        }
        const openBtn = document.getElementById('pygOpenInBrowserBtn');
        if (openBtn) openBtn.href = pygUrl;

        // Tagline
        const taglineSection = document.getElementById('pygCharTaglineSection');
        const taglineEl = document.getElementById('pygCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.style.display = 'block';
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.style.display = 'none';
            }
        }

        // Stats
        const downloadsEl = document.getElementById('pygCharDownloads');
        if (downloadsEl) downloadsEl.textContent = downloads;
        const starsEl = document.getElementById('pygCharStars');
        if (starsEl) starsEl.textContent = stars;
        const viewsEl = document.getElementById('pygCharViews');
        if (viewsEl) viewsEl.textContent = views;
        const chatsEl = document.getElementById('pygCharChats');
        if (chatsEl) chatsEl.textContent = chats;
        const dateEl = document.getElementById('pygCharDate');
        if (dateEl) dateEl.textContent = createdDate || 'Unknown';

        // Source
        const sourceEl = document.getElementById('pygCharSource');
        const sourceSection = document.getElementById('pygCharSourceStat');
        if (sourceSection) {
            if (hit.source) {
                sourceSection.style.display = 'flex';
                if (sourceEl) sourceEl.textContent = hit.source;
            } else {
                sourceSection.style.display = 'none';
            }
        }

        // Gallery count
        const galleryImages = getGalleryImages(hit);
        const galleryStat = document.getElementById('pygCharGalleryStat');
        const galleryCountEl = document.getElementById('pygCharGalleryCount');
        if (galleryStat) {
            if (galleryImages.length > 0) {
                galleryStat.style.display = 'flex';
                if (galleryCountEl) galleryCountEl.textContent = String(galleryImages.length);
            } else {
                galleryStat.style.display = 'none';
            }
        }
        renderPygGalleryGrid(galleryImages);

        // Greetings stat
        const greetingsStat = document.getElementById('pygCharGreetingsStat');
        const greetingsCount = document.getElementById('pygCharGreetingsCount');
        const altGreetings = Array.isArray(hit.personality?.alternateGreetings) ? hit.personality.alternateGreetings.filter(Boolean) : [];
        if (greetingsStat) {
            if (altGreetings.length > 0) {
                greetingsStat.style.display = 'flex';
                if (greetingsCount) greetingsCount.textContent = String(altGreetings.length + 1);
            } else {
                greetingsStat.style.display = 'none';
            }
        }

        // Tags
        const tagsEl = document.getElementById('pygCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // Populate definition sections from full character detail (if available)
        const p = hit.personality || {};
        populateDefinitionSections(name, p, altGreetings);

        // Import button state
        const importBtn = document.getElementById('pygImportBtn');
        if (importBtn) {
            if (inLibrary) {
                importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
                importBtn.classList.add('secondary');
                importBtn.classList.remove('primary', 'warning');
            } else if (possibleMatch) {
                importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
                importBtn.classList.add('warning');
                importBtn.classList.remove('primary', 'secondary');
            } else {
                importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                importBtn.classList.add('primary');
                importBtn.classList.remove('secondary', 'warning');
            }
            importBtn.disabled = false;
        }
    } catch (err) {
        console.error('[PygBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Search results don't include personality — always fetch full detail
    if (!hit.personality) {
        const fetchToken = ++pygDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

function renderPygGalleryGrid(galleryImages) {
    const section = document.getElementById('pygCharGallerySection');
    const grid = document.getElementById('pygCharGalleryGrid');
    const label = document.getElementById('pygCharGalleryLabel');
    if (!section || !grid) return;
    if (galleryImages.length > 0) {
        section.style.display = 'block';
        if (label) label.textContent = `(${galleryImages.length})`;
        grid.innerHTML = galleryImages.map(img =>
            `<img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="Gallery image" title="Gallery image" loading="lazy" onerror="this.style.display='none'">`
        ).join('');
    } else {
        section.style.display = 'none';
        grid.innerHTML = '';
    }
}

function populateDefinitionSections(name, p, altGreetings) {
    // Creator's Notes
    const creatorNotesEl = document.getElementById('pygCharCreatorNotes');
    if (creatorNotesEl) {
        if (p.characterNotes) {
            creatorNotesEl.innerHTML = formatRichText(p.characterNotes, name, false);
        } else {
            creatorNotesEl.textContent = 'No creator notes available.';
        }
    }

    // Description (persona)
    const descSection = document.getElementById('pygCharDescriptionSection');
    const descEl = document.getElementById('pygCharDescription');
    if (descSection) {
        if (p.persona) {
            descSection.style.display = 'block';
            if (descEl) descEl.innerHTML = formatRichText(p.persona, name, false);
        } else if (!p.persona && !p.greeting) {
            // No personality data yet — show loading
            descSection.style.display = 'block';
            if (descEl) descEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>';
        } else {
            descSection.style.display = 'none';
        }
    }

    // First Message
    const firstMsgSection = document.getElementById('pygCharFirstMsgSection');
    const firstMsgEl = document.getElementById('pygCharFirstMsg');
    if (firstMsgSection) {
        if (p.greeting) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) firstMsgEl.innerHTML = formatRichText(p.greeting, name, false);
        } else {
            firstMsgSection.style.display = 'none';
        }
    }

    // Alternate Greetings
    const altSection = document.getElementById('pygCharAltGreetingsSection');
    const altEl = document.getElementById('pygCharAltGreetings');
    const altCountEl = document.getElementById('pygCharAltGreetingsCount');
    if (altSection) {
        if (altGreetings.length > 0) {
            altSection.style.display = 'block';
            if (altCountEl) altCountEl.textContent = `(${altGreetings.length})`;
            window.currentBrowseAltGreetings = altGreetings;
            if (altEl) {
                const buildPreview = (text) => {
                    const cleaned = (text || '').replace(/\s+/g, ' ').trim();
                    if (!cleaned) return 'No content';
                    return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
                };
                altEl.innerHTML = altGreetings.map((greeting, idx) => {
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
                altEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
                    details.addEventListener('toggle', function onToggle() {
                        if (!details.open) return;
                        const body = details.querySelector('.browse-alt-greeting-body');
                        if (body && !body.dataset.rendered) {
                            const idx = parseInt(details.dataset.greetingIdx, 10);
                            if (altGreetings[idx] != null) {
                                body.innerHTML = DOMPurify.sanitize(formatRichText(altGreetings[idx], name, true), BROWSE_PURIFY_CONFIG);
                            }
                            body.dataset.rendered = '1';
                        }
                    }, { once: true });
                });
            }
        } else {
            altSection.style.display = 'none';
            window.currentBrowseAltGreetings = [];
        }
    }

    // Example Messages
    const examplesSection = document.getElementById('pygCharExamplesSection');
    const examplesEl = document.getElementById('pygCharExamples');
    if (examplesSection) {
        if (p.mesExample) {
            examplesSection.style.display = 'block';
            if (examplesEl) examplesEl.innerHTML = formatRichText(p.mesExample, name, false);
        } else {
            examplesSection.style.display = 'none';
        }
    }
}

async function fetchAndPopulateDetails(hit, stalenessToken) {
    if (!hit.id) return;

    try {
        const data = await fetchCharacterDetail(hit.id, undefined, pygToken || undefined);
        if (stalenessToken !== pygDetailFetchToken) return;
        if (!data?.character) return;

        const char = data.character;
        const name = char.personality?.name || char.displayName || 'Unknown';

        // Store full data on selected char for import
        if (pygSelectedChar?.id === hit.id) {
            pygSelectedChar._fullDetail = char;
        }

        const p = char.personality || {};
        const altGreetings = Array.isArray(p.alternateGreetings) ? p.alternateGreetings.filter(Boolean) : [];
        populateDefinitionSections(name, p, altGreetings);

        // Update gallery count with full data
        const galleryImages = getGalleryImages(char);
        const galleryStat = document.getElementById('pygCharGalleryStat');
        const galleryCountEl = document.getElementById('pygCharGalleryCount');
        if (galleryStat && galleryImages.length > 0) {
            galleryStat.style.display = 'flex';
            if (galleryCountEl) galleryCountEl.textContent = String(galleryImages.length);
        }
        renderPygGalleryGrid(galleryImages);

        // Update greetings stat
        const greetingsStat = document.getElementById('pygCharGreetingsStat');
        const greetingsCount = document.getElementById('pygCharGreetingsCount');
        if (greetingsStat && altGreetings.length > 0) {
            greetingsStat.style.display = 'flex';
            if (greetingsCount) greetingsCount.textContent = String(altGreetings.length + 1);
        }

        // Update source
        const sourceEl = document.getElementById('pygCharSource');
        const sourceStat = document.getElementById('pygCharSourceStat');
        if (sourceStat && char.source) {
            sourceStat.style.display = 'flex';
            if (sourceEl) sourceEl.textContent = char.source;
        }

    } catch (err) {
        debugLog('[PygBrowse] Detail fetch error:', err);
        if (stalenessToken === pygDetailFetchToken) {
            const descEl = document.getElementById('pygCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
        }
    }
}

function cleanupPygCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const sectionIds = [
        'pygCharDescription',
        'pygCharFirstMsg',
        'pygCharAltGreetings',
        'pygCharExamples',
        'pygCharTags',
        'pygCharGalleryGrid',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('pygCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    pygDetailFetchToken++;
    cleanupPygCharModal();
    const modal = document.getElementById('pygCharModal');
    if (modal) modal.classList.add('hidden');
    pygSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.id) return;

    const importBtn = document.getElementById('pygImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('pygmalion');
        if (!provider?.importCharacter) throw new Error('Pygmalion provider not available');

        const charName = charData.personality?.name || charData.displayName || '';
        const charCreator = charData.owner?.username || charData.owner?.displayName || '';

        // Pre-import duplicate check
        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: charData.id,
            description: charData.personality?.persona || '',
            first_mes: charData.personality?.greeting || '',
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = charData.avatarUrl ? getAvatarUrl(charData.avatarUrl) : '';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: charData.id,
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
                    console.warn('[PygBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        // Use full detail if fetched, otherwise pass search hit
        const fullChar = charData._fullDetail || charData;
        const result = await provider.importCharacter(charData.id, fullChar, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        closePreviewModal();
        await new Promise(r => requestAnimationFrame(r));

        showToast(`Imported "${result.characterName}"`, 'success');

        const hasGallery = result.hasGallery;
        const mediaUrls = result.embeddedMediaUrls || [];
        if ((hasGallery || mediaUrls.length > 0) && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                galleryCharacters: hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider: provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: getCharacterPageUrl(result.providerCharId),
                    avatar: result.fileName,
                    galleryId: result.galleryId
                }] : [],
                mediaCharacters: mediaUrls.length > 0 ? [{
                    name: result.characterName,
                    avatar: result.fileName,
                    avatarUrl: result.avatarUrl,
                    mediaUrls: mediaUrls,
                    galleryId: result.galleryId
                }] : []
            });
        }

        const added = await fetchAndAddCharacter(result.fileName);
        if (!added) await fetchCharacters(true);
        view.buildLocalLibraryLookup();
        markCardAsImported(charData.id);

    } catch (err) {
        console.error('[PygBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(charId) {
    for (const gridId of ['pygGrid', 'pygFollowingGrid']) {
        const grid = document.getElementById(gridId);
        if (!grid) continue;
        const card = grid.querySelector(`[data-pyg-id="${charId}"]`);
        if (!card) continue;
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
}

// ========================================
// AUTHOR FILTER
// ========================================

let pygAuthorFilter = null;
let pygAuthorOwnerId = null;
let pygAuthorSort = 'approved_at';

function filterByAuthor(authorName, ownerId) {
    closePreviewModal();
    pygAuthorFilter = authorName;
    pygAuthorOwnerId = ownerId || null;
    pygCurrentSearch = '';
    pygCurrentPage = 0;

    const input = document.getElementById('pygSearchInput');
    if (input) input.value = '';

    const clearBtn = document.getElementById('pygClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    const banner = document.getElementById('pygAuthorBanner');
    const bannerName = document.getElementById('pygAuthorBannerName');
    if (banner) {
        banner.classList.remove('hidden');
        if (bannerName) bannerName.textContent = authorName;
    }

    // Reset author sort to newest
    pygAuthorSort = 'approved_at';
    const authorSortEl = document.getElementById('pygAuthorSortSelect');
    if (authorSortEl) authorSortEl.value = 'approved_at';

    // Update follow button
    updatePygFollowButton(ownerId);

    loadCharacters(false);
}

function clearAuthorFilter() {
    pygAuthorFilter = null;
    pygAuthorOwnerId = null;
    pygCurrentSearch = '';
    pygCurrentPage = 0;

    const input = document.getElementById('pygSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('pygClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    const banner = document.getElementById('pygAuthorBanner');
    if (banner) banner.classList.add('hidden');

    const followBtn = document.getElementById('pygFollowAuthorBtn');
    if (followBtn) followBtn.style.display = 'none';

    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('pygNsfwToggle');
    if (!btn) return;

    if (pygNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled (requires auth token) - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW (requires auth token)';
    }

    // Grey out if no token
    btn.style.opacity = pygToken ? '' : '0.5';
}

// ========================================
// VIEW MODE SWITCHING
// ========================================

async function switchPygViewMode(mode) {
    loadPygToken();
    pygViewMode = mode;

    document.querySelectorAll('.pyg-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.pygView === mode);
    });

    const browseSection = document.getElementById('pygBrowseSection');
    const followingSection = document.getElementById('pygFollowingSection');

    const browseSortEl = document.getElementById('pygSortSelect');
    const followingSortEl = document.getElementById('pygFollowingSortSelect');

    const bsTarget = browseSortEl?._customSelect?.container || browseSortEl;
    const fsTarget = followingSortEl?._customSelect?.container || followingSortEl;

    if (mode === 'browse') {
        browseSection?.classList.remove('hidden');
        followingSection?.classList.add('hidden');

        if (bsTarget) bsTarget.classList.remove('browse-filter-hidden');
        if (fsTarget) fsTarget.classList.add('browse-filter-hidden');

        const grid = document.getElementById('pygGrid');
        if (grid) {
            grid.innerHTML = `
                <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                    <p style="margin-top: 12px; color: var(--text-muted);">Loading Pygmalion characters...</p>
                </div>
            `;
        }

        pygCharacters = [];
        pygCurrentPage = 0;
        loadCharacters(false);

    } else if (mode === 'following') {
        browseSection?.classList.add('hidden');
        followingSection?.classList.remove('hidden');

        if (bsTarget) bsTarget.classList.add('browse-filter-hidden');
        if (fsTarget) fsTarget.classList.remove('browse-filter-hidden');

        if (pygFollowingCharacters.length === 0) {
            loadPygFollowingTimeline();
        } else {
            renderPygFollowing();
        }
    }
}

// ========================================
// FOLLOWING TIMELINE
// ========================================

async function loadPygFollowingTimeline(forceRefresh = false) {
    if (!pygToken) {
        renderPygFollowingEmpty('login');
        return;
    }

    if (pygFollowingLoading) return;
    pygFollowingLoading = true;

    const grid = document.getElementById('pygFollowingGrid');
    const loadMoreContainer = document.getElementById('pygFollowingLoadMore');

    if (forceRefresh) {
        pygFollowingCharacters = [];
        pygFollowedUsers = [];
    }

    if (grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Loading timeline...</p>
            </div>
        `;
    }

    let shouldRetry = false;
    try {
        // Fetch all followed users (paginated)
        if (pygFollowedUsers.length === 0) {
            let page = 0;
            let hasMore = true;
            const allUsers = [];

            while (hasMore) {
                const resp = await getFollowedUsers(pygToken, { pageNumber: page, pageSize: 50 });
                const users = resp.users || [];
                allUsers.push(...users);
                hasMore = users.length >= 50;
                page++;
                if (page > 20) break; // safety cap
            }

            pygFollowedUsers = allUsers;
            debugLog('[PygFollowing] Following', allUsers.length, 'users');
        }

        if (pygFollowedUsers.length === 0) {
            renderPygFollowingEmpty('no_follows');
            pygFollowingLoading = false;
            return;
        }

        // Fetch characters from each followed user (batched)
        const existingIds = new Set(pygFollowingCharacters.map(c => c.id));
        const BATCH_SIZE = 5;

        for (let i = 0; i < pygFollowedUsers.length; i += BATCH_SIZE) {
            const batch = pygFollowedUsers.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (user) => {
                try {
                    const userId = user.id || user.userId;
                    if (!userId) return [];
                    const data = await fetchCharactersByOwner(userId, 'approved_at', 0, pygToken || undefined);
                    return (data?.characters || []).map(c => ({
                        ...c,
                        _followedAuthor: user.username || user.displayName || '',
                        _followedAuthorId: userId,
                    }));
                } catch (e) {
                    debugLog('[PygFollowing] Error fetching from user:', e.message);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            for (const chars of results) {
                for (const c of chars) {
                    if (!existingIds.has(c.id)) {
                        existingIds.add(c.id);
                        pygFollowingCharacters.push(c);
                    }
                }
            }
        }

        debugLog('[PygFollowing] Total characters from followed authors:', pygFollowingCharacters.length);

        if (pygFollowingCharacters.length === 0) {
            renderPygFollowingEmpty('empty');
            pygFollowingLoading = false;
            return;
        }

        renderPygFollowing();

    } catch (err) {
        console.error('[PygFollowing] Error loading timeline:', err);

        if (err.authFailed) {
            const recovered = await attemptTokenRecovery();
            if (recovered) {
                debugLog('[PygFollowing] Token recovered, retrying');
                shouldRetry = true;
            } else {
                showToast('Pygmalion token expired \u2014 please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
                renderPygFollowingEmpty('login');
            }
        } else {
            if (grid) {
                grid.innerHTML = `
                    <div class="chub-timeline-empty">
                        <i class="fa-solid fa-exclamation-triangle"></i>
                        <h3>Error Loading Timeline</h3>
                        <p>${escapeHtml(err.message)}</p>
                        <button class="action-btn primary" id="pygFollowingRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
                document.getElementById('pygFollowingRetryBtn')?.addEventListener('click', () => loadPygFollowingTimeline(true));
            }
        }
    } finally {
        pygFollowingLoading = false;
        pygmalionBrowseView.updateLoadMoreVisibility('pygFollowingLoadMore', false, true);
    }

    if (shouldRetry) {
        loadPygFollowingTimeline(true);
    }
}

function renderPygFollowingEmpty(reason) {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;

    if (reason === 'login') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Token Required</h3>
                <p>Add your Pygmalion session token to see new characters from authors you follow.</p>
                <button class="action-btn primary" id="pygFollowingLoginBtn">
                    <i class="fa-solid fa-key"></i> Add Token
                </button>
            </div>
        `;
        document.getElementById('pygFollowingLoginBtn')?.addEventListener('click', () => openPygTokenModal());
    } else if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Authors</h3>
                <p>Follow some character creators to see their new characters here!</p>
                <a href="https://pygmalion.chat" target="_blank" class="action-btn primary">
                    <i class="fa-solid fa-external-link"></i> Find Authors on Pygmalion
                </a>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Authors you follow haven't posted characters yet.</p>
            </div>
        `;
    }
}

function sortPygFollowingCharacters(characters) {
    const sorted = [...characters];
    switch (pygFollowingSort) {
        case 'newest':
            return sorted.sort((a, b) => (parseInt(b.approvedAt || '0', 10)) - (parseInt(a.approvedAt || '0', 10)));
        case 'oldest':
            return sorted.sort((a, b) => (parseInt(a.approvedAt || '0', 10)) - (parseInt(b.approvedAt || '0', 10)));
        case 'name_asc':
            return sorted.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        case 'name_desc':
            return sorted.sort((a, b) => (b.displayName || '').localeCompare(a.displayName || ''));
        case 'downloads':
            return sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
        case 'stars':
            return sorted.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        default:
            return sorted;
    }
}

function renderPygFollowing() {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;

    // Client-side tag + hide-owned filtering
    const includeTags = [...pygIncludeTags];
    const excludeTags = [...pygExcludeTags];
    for (const t of getProviderExcludeTags('pygmalion')) {
        if (!excludeTags.includes(t)) excludeTags.push(t);
    }
    const anyFilterActive = pygFilterHideOwned || pygFilterHidePossible || includeTags.length > 0 || excludeTags.length > 0;

    let filtered;
    if (anyFilterActive) {
        filtered = pygFollowingCharacters.filter(c => {
            if (pygFilterHideOwned && isCharInLocalLibrary(c)) return false;
            if (pygFilterHidePossible && isCharPossibleMatchObj(c)) return false;
            if (includeTags.length > 0 || excludeTags.length > 0) {
                const charTags = (c.tags || []).map(t => t.toLowerCase());
                if (includeTags.length > 0 && !includeTags.every(t => charTags.includes(t.toLowerCase()))) return false;
                if (excludeTags.length > 0 && excludeTags.some(t => charTags.includes(t.toLowerCase()))) return false;
            }
            return true;
        });
    } else {
        filtered = pygFollowingCharacters.slice();
    }

    let sorted = sortPygFollowingCharacters(filtered);

    // NSFW filter
    if (!pygNsfwEnabled) {
        sorted = sorted.filter(c => !c.isSensitive);
    }

    if (sorted.length === 0 && pygFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting them.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = sorted.map(c => createPygCard(c)).join('');
    observeNewFollowingCards();
}

function observeNewFollowingCards() {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;
    pygmalionBrowseView.observeImages(grid);
}

// ========================================
// TOKEN MANAGEMENT
// ========================================

function loadPygToken() {
    pygToken = getSetting('pygmalionToken') || null;

    if (!pygToken && pygNsfwEnabled) {
        pygNsfwEnabled = false;
        setSetting('pygmalionNsfw', false);
    }
    updateNsfwToggle();
    updateLoginUI();
}

function savePygToken(token) {
    pygToken = token || null;
    setSetting('pygmalionToken', pygToken);
    updateLoginUI();
}

async function openPygTokenModal() {
    loadPygToken();

    pygPluginAvailable = await checkPluginAvailable(apiRequest);
    updateLoginUI();

    // Populate stored credentials if any
    const emailInput = document.getElementById('pygLoginEmail');
    if (emailInput && getSetting('pygmalionRememberCredentials')) {
        emailInput.value = getSetting('pygmalionEmail') || '';
    }

    const modal = document.getElementById('pygLoginModal');
    if (modal) modal.classList.remove('hidden');
}

function closePygTokenModal() {
    const modal = document.getElementById('pygLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateLoginUI() {
    // Plugin status
    const pluginOk = document.getElementById('pygPluginStatusOk');
    const pluginMissing = document.getElementById('pygPluginStatusMissing');
    const loginForm = document.getElementById('pygLoginForm');
    const loginBtn = document.getElementById('pygLoginBtn');

    if (pluginOk) pluginOk.style.display = pygPluginAvailable ? '' : 'none';
    if (pluginMissing) pluginMissing.style.display = pygPluginAvailable ? 'none' : '';
    if (loginForm) loginForm.classList.toggle('pyg-login-disabled', !pygPluginAvailable);
    if (loginBtn) loginBtn.disabled = !pygPluginAvailable || pygLoginInProgress;

    // Auto-expand manual token section when plugin unavailable
    const manualSection = document.querySelector('.pyg-manual-token-section');
    if (manualSection && !pygPluginAvailable) manualSection.open = true;

    // Login button state
    if (loginBtn) {
        loginBtn.innerHTML = pygLoginInProgress
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...'
            : '<i class="fa-solid fa-sign-in-alt"></i> Log In';
    }

    // Token status area
    const statusArea = document.getElementById('pygTokenStatus');
    if (statusArea) {
        if (pygToken) {
            const ttl = getTokenTTL(pygToken);
            let ttlText;
            if (ttl === Infinity) {
                ttlText = 'no expiry';
            } else if (ttl <= 0) {
                ttlText = '<span style="color: #e74c3c;">expired</span>';
            } else {
                const min = Math.floor(ttl / 60);
                ttlText = min > 0 ? `${min}m remaining` : `${ttl}s remaining`;
            }
            statusArea.innerHTML = `
                <i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i>
                <strong>Authenticated</strong> — token ${ttlText}
            `;
            statusArea.style.display = '';
        } else {
            statusArea.style.display = 'none';
        }
    }

}

// ========================================
// LOGIN / AUTO-REFRESH
// ========================================

async function loginWithCredentials(email, password) {
    if (pygLoginInProgress) return;
    pygLoginInProgress = true;
    updateLoginUI();

    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (!token) throw new Error('Login succeeded but no token in response');

            savePygToken(token);

            // Always remember credentials when logging in via this modal
            setSetting('pygmalionEmail', email);
            setSetting('pygmalionPassword', password);
            setSetting('pygmalionRememberCredentials', true);

            scheduleTokenRefresh(token, email, password);

            if (!pygNsfwEnabled) {
                pygNsfwEnabled = true;
                setSetting('pygmalionNsfw', true);
                updateNsfwToggle();
            }

            showToast('Logged in to Pygmalion!', 'success');
            closePygTokenModal();

            pygFollowedUserIds = null;
            pygFollowedUsers = [];
            pygFollowingCharacters = [];
        } else if (resp.status === 422) {
            showToast('Invalid email or password', 'error');
        } else if (resp.status === 502) {
            showToast('Pygmalion auth server unreachable', 'error');
        } else {
            const text = await resp.text().catch(() => '');
            showToast(`Login failed (${resp.status}): ${text || 'Unknown error'}`, 'error');
        }
    } catch (err) {
        console.error('[PygAuth] Login error:', err);
        showToast(`Login error: ${err.message}`, 'error');
    } finally {
        pygLoginInProgress = false;
        updateLoginUI();
    }
}

function logout() {
    clearTokenRefresh();
    savePygToken(null);
    setSetting('pygmalionEmail', null);
    setSetting('pygmalionPassword', null);
    setSetting('pygmalionRememberCredentials', false);

    const emailInput = document.getElementById('pygLoginEmail');
    const passInput = document.getElementById('pygLoginPassword');
    if (emailInput) emailInput.value = '';
    if (passInput) passInput.value = '';

    pygNsfwEnabled = false;
    setSetting('pygmalionNsfw', false);
    updateNsfwToggle();

    pygFollowedUserIds = null;
    pygFollowedUsers = [];
    pygFollowingCharacters = [];

    if (pygViewMode === 'following') {
        switchPygViewMode('browse');
    }

    showToast('Logged out from Pygmalion', 'info');
}

function scheduleTokenRefresh(token, email, password) {
    clearTokenRefresh();

    const ttl = getTokenTTL(token);
    if (ttl === Infinity || ttl <= 0) return;

    // Re-login at 80% of lifetime (~48 min for 1h tokens)
    const refreshIn = Math.max(60, Math.floor(ttl * 0.8)) * 1000;
    debugLog('[PygAuth] Token refresh scheduled in', Math.floor(refreshIn / 1000), 'seconds');

    pygAutoRefreshTimer = setTimeout(async () => {
        debugLog('[PygAuth] Auto-refreshing token...');
        try {
            const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/pyg-login`, 'POST', {
                username: email,
                password: password,
            });

            if (resp.status === 201) {
                const data = await resp.json();
                const newToken = data?.result?.id_token;
                if (newToken) {
                    savePygToken(newToken);
                    scheduleTokenRefresh(newToken, email, password);
                    debugLog('[PygAuth] Token refreshed successfully');
                }
            } else {
                console.warn('[PygAuth] Token refresh failed:', resp.status);
            }
        } catch (e) {
            console.warn('[PygAuth] Token refresh error:', e);
        }
    }, refreshIn);
}

function clearTokenRefresh() {
    if (pygAutoRefreshTimer) {
        clearTimeout(pygAutoRefreshTimer);
        pygAutoRefreshTimer = null;
    }
}

/**
 * Attempt to recover from an expired token using stored credentials.
 * Unlike tryAutoLogin(), this is called reactively on auth failure
 * and always attempts re-login regardless of current token state.
 * @returns {Promise<boolean>} true if a new valid token was obtained
 */
async function attemptTokenRecovery() {
    if (!getSetting('pygmalionRememberCredentials')) return false;

    const email = getSetting('pygmalionEmail');
    const password = getSetting('pygmalionPassword');
    if (!email || !password) return false;

    if (!pygPluginAvailable) {
        pygPluginAvailable = await checkPluginAvailable(apiRequest);
        if (!pygPluginAvailable) return false;
    }

    debugLog('[PygAuth] Attempting token recovery...');

    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (token) {
                savePygToken(token);
                scheduleTokenRefresh(token, email, password);
                debugLog('[PygAuth] Token recovery successful');
                return true;
            }
        }
    } catch (e) {
        debugLog('[PygAuth] Token recovery failed:', e.message);
    }
    return false;
}

/**
 * Auto-login with stored credentials if plugin available and no valid token.
 * Called on activate() — runs silently, no toasts on failure.
 */
async function tryAutoLogin() {
    if (pygToken && getTokenTTL(pygToken) > 60) return;
    if (!getSetting('pygmalionRememberCredentials')) return;

    const email = getSetting('pygmalionEmail');
    const password = getSetting('pygmalionPassword');
    if (!email || !password) return;

    pygPluginAvailable = await checkPluginAvailable(apiRequest);
    if (!pygPluginAvailable) return;

    debugLog('[PygAuth] Attempting auto-login with stored credentials...');

    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (token) {
                savePygToken(token);
                scheduleTokenRefresh(token, email, password);

                if (!pygNsfwEnabled) {
                    pygNsfwEnabled = true;
                    setSetting('pygmalionNsfw', true);
                    updateNsfwToggle();
                    // Reload with NSFW if initial load was SFW-only
                    pygCurrentPage = 0;
                    loadCharacters(false);
                }

                debugLog('[PygAuth] Auto-login successful');
            }
        }
    } catch (e) {
        debugLog('[PygAuth] Auto-login failed:', e.message);
    }
}

// ========================================
// FOLLOW AUTHOR
// ========================================

let pygIsFollowingCurrentAuthor = false;
let pygFollowedUserIds = null; // Set<string> — cached followed user IDs

async function fetchPygFollowedUserIds() {
    if (!pygToken) return new Set();

    try {
        let page = 0;
        const ids = new Set();
        let hasMore = true;

        while (hasMore) {
            const resp = await getFollowedUsers(pygToken, { pageNumber: page, pageSize: 50 });
            const users = resp.users || [];
            for (const u of users) {
                if (u.id) ids.add(u.id);
            }
            hasMore = users.length >= 50;
            page++;
            if (page > 20) break;
        }

        pygFollowedUserIds = ids;
        debugLog('[PygFollow] Cached', ids.size, 'followed user IDs');
        return ids;
    } catch (e) {
        console.error('[PygFollow] Error fetching followed users:', e);
        return new Set();
    }
}

async function updatePygFollowButton(ownerId) {
    const followBtn = document.getElementById('pygFollowAuthorBtn');
    if (!followBtn) return;

    if (!pygToken || !ownerId) {
        followBtn.style.display = 'none';
        return;
    }

    followBtn.style.display = '';
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        if (!pygFollowedUserIds) {
            await fetchPygFollowedUserIds();
        }
        pygIsFollowingCurrentAuthor = pygFollowedUserIds?.has(ownerId) || false;
    } catch (e) {
        debugLog('[PygFollow] Could not check follow status:', e);
        pygIsFollowingCurrentAuthor = false;
    }

    followBtn.disabled = false;
    if (pygIsFollowingCurrentAuthor) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = 'Unfollow this author';
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = 'Follow this author';
    }
}

async function togglePygFollowAuthor() {
    if (!pygToken) {
        showToast('Login required to follow authors', 'warning');
        openPygTokenModal();
        return;
    }

    if (!pygAuthorOwnerId) {
        showToast('Cannot determine author ID', 'warning');
        return;
    }

    const followBtn = document.getElementById('pygFollowAuthorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        let result;
        try {
            result = await toggleFollowUser(pygToken, pygAuthorOwnerId);
        } catch (e) {
            if (e.authFailed) {
                showToast('Pygmalion token expired — please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
            } else {
                showToast(`Follow failed: ${e.message}`, 'error');
            }
            if (followBtn) {
                followBtn.disabled = false;
                followBtn.innerHTML = pygIsFollowingCurrentAuthor
                    ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
                    : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            }
            return;
        }
        pygIsFollowingCurrentAuthor = result.isFollowing ?? !pygIsFollowingCurrentAuthor;

        // Update cached set
        if (pygFollowedUserIds) {
            if (pygIsFollowingCurrentAuthor) {
                pygFollowedUserIds.add(pygAuthorOwnerId);
            } else {
                pygFollowedUserIds.delete(pygAuthorOwnerId);
            }
        }

        if (pygIsFollowingCurrentAuthor) {
            showToast(`Now following ${pygAuthorFilter}!`, 'success');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
                followBtn.classList.add('following');
            }
        } else {
            showToast(`Unfollowed ${pygAuthorFilter}`, 'info');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
                followBtn.classList.remove('following');
            }
        }

        // Invalidate following timeline cache
        pygFollowingCharacters = [];
        pygFollowedUsers = [];

        if (followBtn) followBtn.disabled = false;
    } catch (e) {
        console.error('[PygFollow] Error:', e);
        showToast(`Follow action failed: ${e.message}`, 'error');

        if (followBtn) {
            followBtn.disabled = false;
            followBtn.innerHTML = pygIsFollowingCurrentAuthor
                ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
                : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        }
    }
}

// ========================================
// EVENT WIRING
// ========================================

let modalEventsAttached = false;

function initPygView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Search
    on('pygSearchBtn', 'click', () => {
        const val = document.getElementById('pygSearchInput')?.value.trim() || '';
        pygCurrentSearch = val;
        pygCurrentPage = 0;

        // Clear author filter on new search
        if (pygAuthorFilter) {
            pygAuthorFilter = null;
            pygAuthorOwnerId = null;
            const banner = document.getElementById('pygAuthorBanner');
            if (banner) banner.classList.add('hidden');
        }

        const clearBtn = document.getElementById('pygClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !val);

        loadCharacters(false);
    });

    const searchInput = document.getElementById('pygSearchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('pygSearchBtn')?.click();
            }
        });
    }

    on('pygClearSearchBtn', 'click', clearAuthorFilter);
    on('pygClearAuthorBtn', 'click', clearAuthorFilter);
    on('pygFollowAuthorBtn', 'click', togglePygFollowAuthor);

    // Sort (browse mode)
    const sortSelect = document.getElementById('pygSortSelect');
    if (sortSelect) {
        CoreAPI.initCustomSelect?.(sortSelect);
        sortSelect.addEventListener('change', () => {
            pygSortMode = sortSelect.value;
            pygCurrentPage = 0;
            loadCharacters(false);
        });
    }

    // Sort (following mode)
    const followingSortSelect = document.getElementById('pygFollowingSortSelect');
    if (followingSortSelect) {
        const wasHidden = followingSortSelect.classList.contains('browse-filter-hidden');
        CoreAPI.initCustomSelect?.(followingSortSelect);
        if (wasHidden && followingSortSelect._customSelect?.container) {
            followingSortSelect._customSelect.container.classList.add('browse-filter-hidden');
        }
        followingSortSelect.addEventListener('change', () => {
            pygFollowingSort = followingSortSelect.value;
            renderPygFollowing();
        });
    }

    // Sort (author filter)
    const authorSortSelect = document.getElementById('pygAuthorSortSelect');
    if (authorSortSelect) {
        CoreAPI.initCustomSelect?.(authorSortSelect);
        authorSortSelect.addEventListener('change', () => {
            pygAuthorSort = authorSortSelect.value;
            pygCurrentPage = 0;
            loadCharacters(false);
        });
    }

    // View mode toggle (Browse/Following)
    document.querySelectorAll('.pyg-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.pygView;
            if (newMode === pygViewMode) return;

            if (newMode === 'following') {
                loadPygToken();
                if (!pygToken) {
                    showToast('Session token required for Following. Click the key icon to add your Pygmalion token.', 'warning');
                    openPygTokenModal();
                    return;
                }
            }

            switchPygViewMode(newMode);
        });
    });

    // NSFW toggle
    on('pygNsfwToggle', 'click', () => {
        loadPygToken();
        if (!pygToken) {
            showToast('Session token required for NSFW content. Add your Pygmalion token in Settings or click the key icon.', 'warning');
            openPygTokenModal();
            return;
        }
        pygNsfwEnabled = !pygNsfwEnabled;
        setSetting('pygmalionNsfw', pygNsfwEnabled);
        updateNsfwToggle();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    // Refresh
    on('pygRefreshBtn', 'click', () => {
        if (pygViewMode === 'following') {
            loadPygFollowingTimeline(true);
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('pygTagsDropdown');
    const filtersDropdown = document.getElementById('pygFiltersDropdown');

    on('pygTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderPygTagsList();

    const tagSearchInput = document.getElementById('pygTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderPygTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('pygTagsClearBtn', 'click', () => {
        pygIncludeTags.clear();
        pygExcludeTags.clear();
        renderPygTagsList(document.getElementById('pygTagsSearchInput')?.value || '');
        updatePygTagsButton();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    // ── Features dropdown ──
    on('pygFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('pygFilterHideOwned', 'change', () => {
        const el = document.getElementById('pygFilterHideOwned');
        if (el) pygFilterHideOwned = el.checked;
        updatePygFiltersButton();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    on('pygFilterHidePossible', 'change', () => {
        const el = document.getElementById('pygFilterHidePossible');
        if (el) pygFilterHidePossible = el.checked;
        updatePygFiltersButton();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    on('pygFilterSortDir', 'change', () => {
        const el = document.getElementById('pygFilterSortDir');
        if (el) pygSortDescending = !el.checked;
        updatePygFiltersButton();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygCurrentPage = 0;
            loadCharacters(false);
        }
    });

    // Close dropdowns when clicking outside
    pygmalionBrowseView._registerDropdownDismiss([
        { dropdownId: 'pygTagsDropdown', buttonId: 'pygTagsBtn' },
        { dropdownId: 'pygFiltersDropdown', buttonId: 'pygFiltersBtn' }
    ]);

    // Load More
    on('pygLoadMoreBtn', 'click', () => {
        if (pygHasMore && !pygIsLoading) {
            pygCurrentPage++;
            loadCharacters(true);
        }
    });

    // Grid card click (browse)
    const grid = document.getElementById('pygGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            // Creator link
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                const author = creatorLink.dataset.author;
                const ownerId = creatorLink.dataset.ownerId;
                if (author) filterByAuthor(author, ownerId);
                return;
            }

            // Card click → open preview
            const card = e.target.closest('.browse-card');
            if (card) {
                const charId = card.dataset.pygId;
                const hit = pygCharacters.find(c => c.id === charId);
                if (hit) openPreviewModal(hit);
            }
        });
    }

    // Grid card click (following)
    const followingGrid = document.getElementById('pygFollowingGrid');
    if (followingGrid) {
        followingGrid.addEventListener('click', (e) => {
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                const author = creatorLink.dataset.author;
                const ownerId = creatorLink.dataset.ownerId;
                if (author) {
                    switchPygViewMode('browse');
                    filterByAuthor(author, ownerId);
                }
                return;
            }

            const card = e.target.closest('.browse-card');
            if (card) {
                const charId = card.dataset.pygId;
                const hit = pygFollowingCharacters.find(c => c.id === charId);
                if (hit) openPreviewModal(hit);
            }
        });
    }

    // ── Preview modal events (attached once — persist across provider switches)
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        on('pygCharClose', 'click', () => closePreviewModal());
        on('pygImportBtn', 'click', () => { if (pygSelectedChar) importCharacter(pygSelectedChar); });

        // Creator name → in-app author filter
        const creatorLink = document.getElementById('pygCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const name = creatorLink.textContent.trim();
                const ownerId = creatorLink.dataset.ownerId;
                if (name && name !== 'Unknown') {
                    closePreviewModal();
                    filterByAuthor(name, ownerId);
                }
            });
        }

        // Avatar click → full-size viewer (desktop only; mobile has its own handler)
        const avatar = document.getElementById('pygCharAvatar');
        if (avatar && !window.matchMedia('(max-width: 768px)').matches) {
            avatar.style.cursor = 'pointer';
            avatar.addEventListener('click', () => {
                const src = avatar.src;
                if (src && src !== '/img/ai4.png') {
                    BrowseView.openAvatarViewer(src, '/img/ai4.png');
                }
            });
        }

        // Backdrop click (preview)
        const modalOverlay = document.getElementById('pygCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        const pygGalleryGrid = document.getElementById('pygCharGalleryGrid');
        if (pygGalleryGrid) {
            pygGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...pygGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        // ── Login modal events ──
        on('pygLoginClose', 'click', closePygTokenModal);

        const loginOverlay = document.getElementById('pygLoginModal');
        if (loginOverlay) {
            loginOverlay.addEventListener('click', (e) => {
                if (e.target === loginOverlay) closePygTokenModal();
            });
        }

        // Email/password login
        on('pygLoginBtn', 'click', () => {
            const email = document.getElementById('pygLoginEmail')?.value.trim();
            const password = document.getElementById('pygLoginPassword')?.value;
            if (!email || !password) {
                showToast('Please enter both email and password', 'warning');
                return;
            }
            loginWithCredentials(email, password);
        });

        // Enter key submits login form
        for (const id of ['pygLoginEmail', 'pygLoginPassword']) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        document.getElementById('pygLoginBtn')?.click();
                    }
                });
            }
        }

    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class PygmalionBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const pygData = char.data?.extensions?.pygmalion;
        if (pygData?.id) idSet.add(pygData.id);
    }

    get previewModalId() { return 'pygCharModal'; }
    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'downloads', label: 'Downloads' },
                { value: 'stars', label: 'Stars' },
                { value: 'views', label: 'Views' },
                { value: 'approved_at', label: 'Newest' },
                { value: 'token_count', label: 'Tokens' },
                { value: 'display_name', label: 'Name' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest Created' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'downloads', label: 'Most Downloads' },
                { value: 'stars', label: 'Most Stars' },
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

    get mobileFilterIds() {
        return {
            sort: 'pygSortSelect',
            tags: 'pygTagsBtn',
            filters: 'pygFiltersBtn',
            nsfw: 'pygNsfwToggle',
            refresh: 'pygRefreshBtn',
            timelineSort: 'pygFollowingSortSelect',
            modeBrowseSelector: '.pyg-view-btn[data-pyg-view="browse"]',
            modeFollowSelector: '.pyg-view-btn[data-pyg-view="following"]',
            modeBtnClass: 'pyg-view-btn',
        };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            <div class="chub-view-toggle">
                <button class="pyg-view-btn active" data-pyg-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="pyg-view-btn" data-pyg-view="following" title="New from followed authors (requires token)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort (Browse mode) -->
            <div class="browse-sort-container">
                <select id="pygSortSelect" class="glass-select" title="Sort order">
                    <option value="downloads" selected>⬇️ Downloads</option>
                    <option value="stars">⭐ Stars</option>
                    <option value="views">👁️ Views</option>
                    <option value="approved_at">🆕 Newest</option>
                    <option value="token_count">📝 Tokens</option>
                    <option value="display_name">🔤 Name</option>
                </select>

                <!-- Sort (Following mode) -->
                <select id="pygFollowingSortSelect" class="glass-select browse-filter-hidden" title="Sort following timeline">
                    <option value="newest" selected>🆕 Newest Created</option>
                    <option value="oldest">🕐 Oldest First</option>
                    <option value="name_asc">📝 Name A-Z</option>
                    <option value="name_desc">📝 Name Z-A</option>
                    <option value="downloads">📥 Most Downloads</option>
                    <option value="stars">⭐ Most Stars</option>
                </select>
            </div>

            <!-- Tags Dropdown -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="pygTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="pygTagsBtnLabel">Tags</span>
                </button>
                <div id="pygTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="pygTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="pygTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="pygTagsList"></div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="pygFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="pygFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Sort:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="pygFilterSortDir"> <i class="fa-solid fa-arrow-up-short-wide"></i> Ascending Order</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="pygFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="pygFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <!-- NSFW toggle (requires auth token for sensitive content) -->
            <button id="pygNsfwToggle" class="glass-btn nsfw-toggle" title="Showing SFW only - click to include NSFW (requires auth token)" style="opacity: 0.5;">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="pygRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="pygBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="pygSearchInput" placeholder="Search Pygmalion characters..." autocomplete="one-time-code">
                        <button id="pygClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="pygSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <div id="pygAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="pygAuthorBannerName">Author</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="pygAuthorSortSelect" class="glass-select" title="Sort author's characters">
                            <option value="approved_at" selected>🆕 Newest Created</option>
                            <option value="downloads">📥 Most Downloads</option>
                            <option value="stars">⭐ Top Rated</option>
                            <option value="views">👁️ Most Views</option>
                        </select>
                        <button id="pygFollowAuthorBtn" class="glass-btn" title="Follow this author" style="display: none;">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="pygClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="pygGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="pygLoadMore" style="display: none;">
                    <button id="pygLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="pygFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from authors you follow</p>
                    </div>
                </div>
                <div id="pygFollowingGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="pygFollowingLoadMore" style="display: none;">
                    <button id="pygFollowingLoadMoreBtn" class="glass-btn">
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
    <div id="pygLoginModal" class="modal-overlay hidden">
        <div class="modal-glass chub-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> Pygmalion Authentication</h2>
                <button class="close-btn" id="pygLoginClose">&times;</button>
            </div>
            <div class="chub-login-body">
                <p class="chub-login-info">
                    <i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i>
                    <strong>Browsing and downloading public characters works without logging in!</strong>
                </p>
                <p class="chub-login-info">
                    <i class="fa-solid fa-key" style="color: var(--accent);"></i>
                    <strong>Optional:</strong> Log in to enable NSFW content, follow authors, and access your Following timeline.
                </p>

                <!-- Token status -->
                <div id="pygTokenStatus" class="pyg-auth-status" style="display:none;"></div>

                <!-- Login form (requires cl-helper plugin) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="pygPluginStatusOk" style="display:none;">
                            <i class="fa-solid fa-plug-circle-check" style="color: #2ecc71;"></i> cl-helper plugin detected
                        </span>
                        <span id="pygPluginStatusMissing" style="display:none;">
                            <i class="fa-solid fa-plug-circle-xmark" style="color: #e67e22;"></i>
                            cl-helper plugin not found — see <a href="https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary#cl-helper-plugin-not-detected" target="_blank" style="color: var(--accent);">setup instructions</a>
                        </span>
                    </div>

                    <div id="pygLoginForm" class="chub-login-form">
                        <div class="form-group">
                            <label for="pygLoginEmail">Email</label>
                            <input type="email" id="pygLoginEmail" class="glass-input" placeholder="your-email@example.com" autocomplete="email">
                        </div>
                        <div class="form-group" style="margin-top: 8px;">
                            <label for="pygLoginPassword">Password</label>
                            <input type="password" id="pygLoginPassword" class="glass-input" placeholder="Your Pygmalion password" autocomplete="current-password">
                        </div>

                        <div class="chub-login-actions" style="margin-top: 15px; display: flex; gap: 8px; justify-content: flex-start;">
                            <button id="pygLoginBtn" class="glass-btn" disabled style="color: #2ecc71; border-color: rgba(46, 204, 113, 0.4);">
                                <i class="fa-solid fa-sign-in-alt"></i> Log In
                            </button>
                            <a href="https://pygmalion.chat" target="_blank" class="glass-btn" title="Go to Pygmalion Website">
                                <i class="fa-solid fa-external-link"></i> Website
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="pygCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="pygCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="pygCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="pygCharCreator" href="#" title="Click to see all characters by this author">Creator</a>
                            <a id="pygCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open author's Pygmalion profile"><i class="fa-solid fa-external-link"></i></a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="pygOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on Pygmalion">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="pygImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="pygCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="pygCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="pygCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="pygCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-star"></i>
                            <span id="pygCharStars">0</span> stars
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-eye"></i>
                            <span id="pygCharViews">0</span> views
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="pygCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="pygCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="pygCharSourceStat" style="display: none;">
                            <i class="fa-solid fa-tag"></i>
                            <span id="pygCharSource"></span>
                        </div>
                        <div class="browse-stat" id="pygCharGalleryStat" style="display: none;">
                            <i class="fa-solid fa-images"></i>
                            <span id="pygCharGalleryCount">0</span> images
                        </div>
                        <div class="browse-stat" id="pygCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="pygCharGreetingsCount">0</span> greetings
                        </div>
                    </div>
                    <div class="browse-char-tags" id="pygCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="pygCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="pygCharCreatorNotes" class="scrolling-text">
                        No creator notes available.
                    </div>
                </div>

                <!-- Description (Persona) -->
                <div class="browse-char-section" id="pygCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="pygCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="pygCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="pygCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="pygCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="pygCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="pygCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="pygCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="pygCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="pygCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="pygCharAltGreetingsCount"></span>
                    </h3>
                    <div id="pygCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="pygCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="pygCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="pygCharGalleryLabel"></span>
                    </h3>
                    <div id="pygCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() {
        return ['pygGrid', 'pygFollowingGrid'];
    }

    canLoadMore() { return pygHasMore && !pygIsLoading && pygViewMode === 'browse'; }

    loadMore() {
        pygCurrentPage++;
        loadCharacters(true);
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        loadPygToken();

        // Restore persisted NSFW preference (only if token exists)
        if (pygToken && getSetting('pygmalionNsfw')) {
            pygNsfwEnabled = true;
        }

        initPygView();
        const grid = document.getElementById('pygGrid');
        if (grid) this.observeImages(grid);
        loadCharacters(false);
    }

    applyDefaults(defaults) {
        if (defaults.view === 'following') {
            pygViewMode = 'following';
            document.querySelectorAll('.pyg-view-btn').forEach(btn =>
                btn.classList.toggle('active', btn.dataset.pygView === 'following')
            );
            const browseSection = document.getElementById('pygBrowseSection');
            const followingSection = document.getElementById('pygFollowingSection');
            browseSection?.classList.add('hidden');
            followingSection?.classList.remove('hidden');
            const bs = document.getElementById('pygSortSelect');
            const fs = document.getElementById('pygFollowingSortSelect');
            const bsTarget = bs?._customSelect?.container || bs;
            const fsTarget = fs?._customSelect?.container || fs;
            if (bsTarget) bsTarget.classList.add('browse-filter-hidden');
            if (fsTarget) fsTarget.classList.remove('browse-filter-hidden');
        }
        if (defaults.sort) {
            if (pygViewMode === 'browse') {
                pygSortMode = defaults.sort;
                const el = document.getElementById('pygSortSelect');
                if (el) el.value = defaults.sort;
            } else {
                pygFollowingSort = defaults.sort;
                const el = document.getElementById('pygFollowingSortSelect');
                if (el) el.value = defaults.sort;
            }
        }
    }

    async activate(container, options = {}) {
        if (options.domRecreated) {
            pygCurrentSearch = '';
            pygCharacters = [];
            pygCurrentPage = 0;
            pygHasMore = true;
            pygIsLoading = false;
            pygFollowingLoading = false;
            pygGridRenderedCount = 0;
            pygAuthorFilter = null;
            pygAuthorOwnerId = null;
            pygAuthorSort = 'approved_at';
            pygIncludeTags.clear();
            pygExcludeTags.clear();
            pygFilterHideOwned = false;
            pygFilterHidePossible = false;
            pygSortDescending = true;
            pygViewMode = 'browse';
            pygFollowingCharacters = [];
            pygFollowedUsers = [];
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        loadPygToken();
        await tryAutoLogin();

        if (wasInitialized && this._initialized && !options.domRecreated) {
            delegatesInitialized = true;
            this.buildLocalLibraryLookup();
            this.reconnectImageObserver();

            if (pygViewMode === 'browse') {
                if (pygCharacters.length === 0) {
                    loadCharacters(false);
                }
            } else if (pygViewMode === 'following') {
                if (pygFollowingCharacters.length === 0) {
                    loadPygFollowingTimeline();
                } else {
                    renderPygFollowing();
                }
            }
        }

        if (options.domRecreated && pygViewMode === 'following') {
            loadPygFollowingTimeline();
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const charId = card.dataset.pygId;
            if (!charId) return false;
            const hit = pygCharacters.find(c => c.id === charId) || pygFollowingCharacters.find(c => c.id === charId);
            return hit ? isCharInLocalLibrary(hit) : isCharInLocalLibrary({ id: charId });
        });
    }

    deactivate() {
        pygDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const pygmalionBrowseView = new PygmalionBrowseView(null);

window.openPygmalionCharPreview = function(hit) {
    openPreviewModal(hit);
};

window.openPygmalionTokenModal = function() {
    openPygTokenModal();
};

export default pygmalionBrowseView;
