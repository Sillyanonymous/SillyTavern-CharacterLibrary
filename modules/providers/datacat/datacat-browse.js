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
    DATACAT_IMAGE_BASE,
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
    JANNY_TAG_MAP,
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
let datacatSortMode = 'recent';
let datacatCreatorSortMode = 'chat_count';

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
let datacatFollowingGridRenderedCount = 0;

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
    return parseInt(hit?.totalTokens || hit?.total_tokens, 10) || 0;
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

// ========================================
// CARD RENDERING
// ========================================

function createDatacatCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarFile = hit.avatar;
    const avatarUrl = avatarFile ? `${DATACAT_IMAGE_BASE}${avatarFile}` : '/img/ai4.png';
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
    if (isNsfw(hit)) {
        badges.push('<span class="browse-nsfw-badge">NSFW</span>');
    }

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
                ${badges.length > 0 ? badges.map(b => b.includes('browse-nsfw-badge') ? b : `<div class="browse-feature-badges">${b}</div>`).join('') : ''}
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
            : isJannySortMode(datacatSortMode) ? 'JanitorAI (MeiliSearch)' : 'DataCat';
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Loading from ${loadingSource}...</p>
            </div>
        `;
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let list = [];
        let total = 0;

        if (datacatBrowseMode === 'creator' && datacatCreatorId) {
            const data = await fetchDatacatCreatorCharacters(datacatCreatorId, {
                limit: PAGE_SIZE,
                offset: datacatCurrentOffset,
                sortBy: datacatCreatorSortMode
            });
            list = data?.list || [];
            total = data?.total || 0;
            sortCreatorResults(list, datacatCreatorSortMode);
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
            const data = await fetchHampterCharacters({
                sort: hampterSort,
                page: hampterCurrentPage,
                search: hampterSearchQuery,
                nsfw: datacatNsfwEnabled,
            });
            list = data?.characters || [];
            total = data?.total || 0;
            hampterTotalPages = total > 0 ? Math.ceil(total / (data?.pageSize || 34)) : 0;
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
        showToast(`DataCat load failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                    <p style="margin-top: 12px;">Load failed: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="datacatRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
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
        renderTagsList();
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
        renderTagsList();
    } catch (e) {
        debugLog('[DatacatBrowse] Tag count refresh failed:', e);
    }
}

function renderTagsList() {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    if (datacatTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        return;
    }

    const sortedGroups = [...datacatTagGroups].sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    let html = '';
    for (const group of sortedGroups) {
        const groupTags = datacatTags
            .filter(t => t.groupId === group.id)
            .sort((a, b) => (b.count || 0) - (a.count || 0));
        if (groupTags.length === 0) continue;

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

function updateTagsButton() {
    const btn = document.getElementById('datacatTagsBtn');
    const label = document.getElementById('datacatTagsBtnLabel');
    if (!btn) return;

    const count = isJannyTagMode() ? jannyActiveTagIds.size : datacatActiveTagIds.size;
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

function updateTagsVisibility() {
    const btn = document.getElementById('datacatTagsBtn');
    if (!btn) return;
    const hide = isHampterSortMode(datacatSortMode);
    btn.style.display = hide ? 'none' : '';
    if (hide) {
        const dropdown = document.getElementById('datacatTagsDropdown');
        if (dropdown) dropdown.classList.add('hidden');
    }
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
// SORT OPTIONS
// ========================================

const FRESH_SORT_LABELS = [
    { value: 'fresh', label: 'Freshest' },
    { value: 'score', label: 'Score' },
    { value: 'chat_count', label: 'Chat Count' },
    { value: 'messages_per_chat', label: 'MSG/Chat' },
    { value: 'first_published', label: 'First Published' },
];

const CREATOR_SORT_OPTIONS = [
    { value: 'chat_count', label: 'Most Messages' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
];

function isJannySortMode(mode) {
    return mode?.startsWith('janny_');
}

function isHampterSortMode(mode) {
    return mode?.startsWith('hampter_');
}

function parseSortMode(mode) {
    if (mode === 'recent') return null;
    if (isJannySortMode(mode)) return null;
    if (isHampterSortMode(mode)) return null;
    if (mode.endsWith('_week')) return { sortBy: mode.slice(0, -5), window: 'week' };
    if (mode.endsWith('_24h')) return { sortBy: mode.slice(0, -4), window: '24h' };
    return { sortBy: mode, window: '24h' };
}

const JANNY_SORT_OPTIONS = [
    { value: 'janny_newest', label: 'Newest' },
    { value: 'janny_oldest', label: 'Oldest' },
    { value: 'janny_tokens_desc', label: 'Most Tokens' },
    { value: 'janny_tokens_asc', label: 'Least Tokens' },
    { value: 'janny_relevant', label: 'Relevance' },
];

const HAMPTER_SORT_OPTIONS = [
    { value: 'hampter_trending', label: 'Trending' },
    { value: 'hampter_popular', label: 'Popular' },
];

function buildSortOptionsHtml(selected) {
    let html = `<option value="recent" ${selected === 'recent' ? 'selected' : ''}>Recent</option>`;
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

async function browseCreator(creatorId) {
    if (!creatorId) return;
    datacatBrowseMode = 'creator';
    datacatCreatorId = creatorId;
    datacatCurrentOffset = 0;
    datacatCharacters = [];
    datacatHasMore = true;
    datacatGridRenderedCount = 0;

    const banner = document.getElementById('datacatCreatorBanner');
    const bannerName = document.getElementById('datacatCreatorBannerName');

    const creator = await fetchDatacatCreator(creatorId);
    if (creator) {
        datacatCreatorName = creator.userName || creatorId;
    } else {
        datacatCreatorName = creatorId;
    }

    if (banner && bannerName) {
        bannerName.textContent = datacatCreatorName;
        banner.classList.remove('hidden');
    }

    updateFollowButton(creatorId);

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

    updateSortOptions();

    loadCharacters(false);
}

// ========================================
// SEARCH
// ========================================

function updateSearchPlaceholder() {
    const input = document.getElementById('datacatSearchInput');
    if (!input) return;
    input.placeholder = isHampterSortMode(datacatSortMode)
        ? 'Search JanitorAI characters or paste a URL...'
        : isJannySortMode(datacatSortMode)
            ? 'Search JanitorAI characters or paste a URL...'
            : 'Paste a DataCat or JanitorAI character URL...';
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
            const charMatch = url.pathname.match(/\/characters?\/([a-f0-9-]{36})/i);
            if (charMatch) {
                fetchCharacterAndBrowseCreator(charMatch[1]);
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
                lookupJanitorCharacter(charMatch[1], val);
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

    showToast('Paste a DataCat or JanitorAI character URL to browse', 'info');
}

function performDatacatCreatorSearch() {
    const input = document.getElementById('datacatCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Please enter a creator name', 'warning');
        return;
    }
    input.value = '';

    const lowerQuery = query.toLowerCase();

    // Scan followed creators
    const followMatch = datacatFollowedCreators.find(c => c.name?.toLowerCase() === lowerQuery);
    if (followMatch) {
        browseCreator(followMatch.id);
        return;
    }

    // Scan currently loaded browse characters
    const browseMatch = datacatCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (browseMatch) {
        browseCreator(getCreatorId(browseMatch));
        return;
    }

    // Scan following timeline characters
    const followingMatch = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (followingMatch) {
        browseCreator(getCreatorId(followingMatch));
        return;
    }

    // Partial match fallback
    const partialFollow = datacatFollowedCreators.find(c => c.name?.toLowerCase().includes(lowerQuery));
    if (partialFollow) {
        browseCreator(partialFollow.id);
        return;
    }

    const partialBrowse = datacatCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialBrowse) {
        browseCreator(getCreatorId(partialBrowse));
        return;
    }

    const partialFollowing = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialFollowing) {
        browseCreator(getCreatorId(partialFollowing));
        return;
    }

    showToast('Creator not found. Try pasting a DataCat creator URL instead.', 'warning');
}

async function fetchCharacterAndBrowseCreator(characterId) {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Looking up character...</p>
            </div>
        `;
    }

    try {
        const character = await fetchDatacatCharacter(characterId);
        if (character?.creator_id) {
            browseCreator(character.creator_id);
        } else {
            showToast('Could not find creator for this character', 'error');
            clearCreatorFilter();
        }
    } catch (e) {
        showToast(`Failed to look up character: ${e.message}`, 'error');
        clearCreatorFilter();
    }
}

// ========================================
// JANITORAI LOOKUP + EXTRACTION
// ========================================

async function lookupJanitorCharacter(janitorId, originalUrl) {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Looking up character on DataCat...</p>
            </div>
        `;
    }

    // Hide creator banner, load more, etc.
    const banner = document.getElementById('datacatCreatorBanner');
    if (banner) banner.classList.add('hidden');
    const loadMoreEl = document.getElementById('datacatLoadMore');
    if (loadMoreEl) loadMoreEl.style.display = 'none';

    try {
        const character = await fetchDatacatCharacter(janitorId);
        if (character) {
            openPreviewModal(character);
            clearCreatorFilter();
            return;
        }
    } catch { /* not found */ }

    // Character not on DataCat: show extraction panel
    showExtractionPanel(janitorId, originalUrl);
}

function showExtractionPanel(janitorId, originalUrl) {
    const grid = document.getElementById('datacatGrid');
    if (!grid) return;

    const janitorUrl = originalUrl || `https://janitorai.com/characters/${janitorId}`;
    const shortId = janitorId.substring(0, 8);

    grid.innerHTML = `
        <div class="datacat-extract-panel" style="grid-column: 1 / -1;">
            <div class="datacat-extract-icon">
                <i class="fa-solid fa-cat"></i>
            </div>
            <h3>Character Not on DataCat</h3>
            <p class="datacat-extract-desc">
                This JanitorAI character (<code>${escapeHtml(shortId)}...</code>) hasn't been extracted yet.
                DataCat can retrieve its definition using a cloud browser instance.
            </p>
            <p class="datacat-extract-note">
                <i class="fa-solid fa-circle-info"></i>
                Extraction typically takes 15-60 seconds. A public account is used by default.
            </p>
            <div class="datacat-extract-actions">
                <button id="datacatExtractBtn" class="action-btn primary" data-url="${escapeHtml(janitorUrl)}" data-id="${escapeHtml(janitorId)}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Extract Character
                </button>
                <a href="${escapeHtml(janitorUrl)}" target="_blank" class="action-btn secondary">
                    <i class="fa-solid fa-external-link"></i> View on JanitorAI
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

async function fetchExtractedCharacter(janitorId) {
    try {
        const character = await fetchDatacatCharacter(janitorId);
        if (character) {
            openPreviewModal(character);
            return;
        }
        // Might need a brief delay for DataCat indexing
        await new Promise(r => setTimeout(r, 2000));
        const retry = await fetchDatacatCharacter(janitorId);
        if (retry) {
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

async function startModalExtraction(charId) {
    const importBtn = document.getElementById('datacatImportBtn');
    if (!importBtn) return;

    const janitorUrl = `https://janitorai.com/characters/${charId}`;

    importBtn.disabled = true;
    importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

    extractionTargetUrl = janitorUrl;
    extractionTargetId = charId;
    extractionStartTime = Date.now();

    try {
        const result = await submitExtraction(janitorUrl, { publicFeed: getSetting('datacatPublicFeed') === true });

        if (result.queued || result.started) {
            const position = result.queued ? ` (${result.queuePosition || 1})` : '';
            importBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Extracting...${position}`;
            startModalExtractionPolling(charId);
        } else if (result.requiresLogin) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
            showToast('DataCat has no valid session. The extraction service may be temporarily unavailable.', 'error');
        } else {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            showToast(result.message || result.error || 'Extraction failed', 'error');
        }
    } catch (e) {
        importBtn.disabled = false;
        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
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
            importBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${phase}... (${elapsed}s)`;
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
                stopExtractionPolling();

                if (completedEntry.success !== false && completedEntry.status !== 'error') {
                    if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Done! Loading...';
                    showToast('Extraction complete! Loading character...', 'success');
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const character = await fetchDatacatCharacter(charId);
                        if (character) {
                            openPreviewModal(character);
                            return;
                        }
                        await new Promise(r => setTimeout(r, 2000));
                        const retry = await fetchDatacatCharacter(charId);
                        if (retry) {
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
                } else {
                    const errMsg = humanizeExtractionError(completedEntry.error || completedEntry.message);
                    showToast(errMsg, 'error');
                    if (importBtn) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
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
    datacatFollowedCreators = Array.isArray(saved) ? saved : [];
}

function saveFollowedCreators() {
    setSetting('datacatFollowedCreators', datacatFollowedCreators);
}

function isCreatorFollowed(creatorId) {
    return datacatFollowedCreators.some(c => c.id === creatorId);
}

function followCreator(creatorId, creatorName) {
    if (isCreatorFollowed(creatorId)) return;
    datacatFollowedCreators.push({ id: creatorId, name: creatorName || creatorId });
    saveFollowedCreators();
    updateFollowButton(creatorId);
    showToast(`Followed ${creatorName || 'creator'}`, 'success');
}

function unfollowCreator(creatorId) {
    const idx = datacatFollowedCreators.findIndex(c => c.id === creatorId);
    if (idx === -1) return;
    const name = datacatFollowedCreators[idx].name;
    datacatFollowedCreators.splice(idx, 1);
    saveFollowedCreators();
    updateFollowButton(creatorId);
    showToast(`Unfollowed ${name || 'creator'}`, 'info');
}

function updateFollowButton(creatorId) {
    const btn = document.getElementById('datacatFollowCreatorBtn');
    if (!btn) return;

    if (datacatBrowseMode !== 'creator' || datacatCreatorId !== creatorId) return;

    if (isCreatorFollowed(creatorId)) {
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
    }

    loadFollowedCreators();

    if (datacatFollowedCreators.length === 0) {
        renderFollowingEmpty('no_follows');
        datacatFollowingLoading = false;
        return;
    }

    if (grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Loading timeline...</p>
            </div>
        `;
    }

    try {
        const existingIds = new Set(datacatFollowingCharacters.map(c => getCharId(c)));
        const BATCH_SIZE = 3;

        for (let i = 0; i < datacatFollowedCreators.length; i += BATCH_SIZE) {
            const batch = datacatFollowedCreators.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (creator) => {
                try {
                    const data = await fetchDatacatCreatorCharacters(creator.id, {
                        limit: 50,
                        offset: 0,
                        sortBy: 'newest'
                    });
                    return (data?.list || []).map(c => ({
                        ...c,
                        _followedCreatorName: creator.name,
                        _followedCreatorId: creator.id,
                    }));
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
        datacatBrowseView.updateLoadMoreVisibility('datacatFollowingLoadMore', false, true);
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

function renderFollowing() {
    const grid = document.getElementById('datacatFollowingGrid');
    if (!grid) return;

    let filtered = datacatNsfwEnabled
        ? datacatFollowingCharacters
        : datacatFollowingCharacters.filter(c => !isNsfw(c));

    const dcPersistentExclude = getProviderExcludeTags('datacat');
    if (dcPersistentExclude.length > 0) {
        const lowerExclude = dcPersistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = resolveTagNames(c.tags || []).map(n => n.toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }

    const sorted = sortFollowingCharacters(filtered);

    if (sorted.length === 0 && datacatFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="chub-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current NSFW filter setting.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = sorted.map(c => createDatacatCard(c)).join('');
    datacatFollowingGridRenderedCount = sorted.length;

    const followingGrid = document.getElementById('datacatFollowingGrid');
    if (followingGrid) datacatBrowseView.observeImages(followingGrid);
}

// ========================================
// PREVIEW MODAL
// ========================================

let datacatDetailFetchToken = 0;
let datacatDetailFetchPromise = null;

function openPreviewModal(hit) {
    datacatSelectedChar = hit;

    const modal = document.getElementById('datacatCharModal');
    if (!modal) return;

    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';
    const avatarFile = hit.avatar;
    const avatarUrl = avatarFile ? `${DATACAT_IMAGE_BASE}${avatarFile}` : '/img/ai4.png';
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
    document.getElementById('datacatOpenInBrowserBtn').href = `${DATACAT_API_BASE}/characters/${charId}`;

    // Stats (adapt to available data)
    const chatsEl = document.getElementById('datacatCharChats');
    const msgsEl = document.getElementById('datacatCharMessages');
    const tokensEl = document.getElementById('datacatCharTokens');
    const dateEl = document.getElementById('datacatCharDate');

    if (chatsEl) chatsEl.textContent = formatNumber(chatCount);
    if (msgsEl) msgsEl.textContent = formatNumber(msgCount);
    if (tokensEl) tokensEl.textContent = formatNumber(totalTokens);
    if (dateEl) dateEl.textContent = createdDate;

    // Show/hide stats based on data source
    const chatsStat = chatsEl?.closest('.browse-stat');
    const msgsStat = msgsEl?.closest('.browse-stat');
    const tokensStat = tokensEl?.closest('.browse-stat');
    if (chatsStat) chatsStat.style.display = (chatCount || msgCount) ? '' : 'none';
    if (msgsStat) msgsStat.style.display = (chatCount || msgCount) ? '' : 'none';
    if (tokensStat) tokensStat.style.display = totalTokens ? '' : 'none';

    // Tags
    const tagsEl = document.getElementById('datacatCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');

    // Creator's Notes — MeiliSearch/Hampter hits have the tagline immediately; DataCat hits show spinner
    const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
    if (creatorNotesSection) {
        const immediateDesc = (hit._source === 'meilisearch' || hit._source === 'hampter') ? (hit.description || '').trim() : '';
        if (immediateDesc) {
            creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) renderCreatorNotesSecure(immediateDesc, name, creatorNotesEl);
        } else {
            creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) creatorNotesEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading creator notes...</div>';
        }
    }

    // Loading indicator for definition sections
    const descSection = document.getElementById('datacatCharDescriptionSection');
    const descEl = document.getElementById('datacatCharDescription');
    const scenarioSection = document.getElementById('datacatCharScenarioSection');
    const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
    descSection.style.display = 'block';
    descEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>';
    scenarioSection.style.display = 'none';
    firstMsgSection.style.display = 'none';

    // Hide alt greetings + greetings stat until download data arrives
    const altGreetingsSection = document.getElementById('datacatCharAltGreetingsSection');
    if (altGreetingsSection) altGreetingsSection.style.display = 'none';
    const greetingsStat = document.getElementById('datacatCharGreetingsStat');
    if (greetingsStat) greetingsStat.style.display = 'none';
    window.currentBrowseAltGreetings = [];

    // Import button — disabled until fetchAndPopulateDetails resolves (prevents importing barebones data)
    const importBtn = document.getElementById('datacatImportBtn');
    delete importBtn.dataset.extractId;
    delete importBtn.dataset.extractPhase;
    if (inLibrary) {
        importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary', 'warning');
        importBtn.disabled = false;
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary', 'warning');
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

    try {
        const character = await fetchDatacatCharacter(charId);

        if (token !== datacatDetailFetchToken) return;

        if (!character) {
            const descEl = document.getElementById('datacatCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. This character may only exist on JanitorAI.</em>';
            // Show tagline as creator notes when DataCat doesn't have the character
            const fallbackDesc = (hit._source === 'meilisearch' || hit._source === 'hampter') ? (hit.description || '').trim() : '';
            const cnSection = document.getElementById('datacatCharCreatorNotesSection');
            const cnEl = document.getElementById('datacatCharCreatorNotes');
            if (fallbackDesc) {
                if (cnSection) cnSection.style.display = 'block';
                if (cnEl) renderCreatorNotesSecure(fallbackDesc, name, cnEl);
            } else {
                if (cnSection) cnSection.style.display = 'none';
                if (cnEl) cnEl.innerHTML = '';
            }
            const importBtn = document.getElementById('datacatImportBtn');
            if (importBtn) {
                importBtn.disabled = false;
                importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
                importBtn.classList.remove('primary', 'secondary', 'warning');
                importBtn.classList.add('primary');
                importBtn.dataset.extractId = charId;
            }
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

        const personality = character.personality || '';
        const scenario = character.scenario || '';
        const firstMessage = character.first_message || '';

        const descSection = document.getElementById('datacatCharDescriptionSection');
        const descEl = document.getElementById('datacatCharDescription');
        if (descSection) {
            if (personality) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = formatRichText(personality, name, false);
            } else {
                descSection.style.display = 'none';
                if (descEl) descEl.innerHTML = '';
            }
        }

        const scenarioSection = document.getElementById('datacatCharScenarioSection');
        const scenarioEl = document.getElementById('datacatCharScenario');
        if (scenarioSection && scenario) {
            scenarioSection.style.display = 'block';
            if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
        }

        const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
        const firstMsgEl = document.getElementById('datacatCharFirstMsg');
        if (firstMsgSection && firstMessage) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) {
                firstMsgEl.innerHTML = formatRichText(firstMessage, name, false);
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        }

        // Update modal stats with full character data (may have chat/msg counts)
        const chatsEl = document.getElementById('datacatCharChats');
        const msgsEl = document.getElementById('datacatCharMessages');
        const fullChatCount = getChatCount(character);
        const fullMsgCount = getMsgCount(character);
        if (chatsEl && fullChatCount) chatsEl.textContent = formatNumber(fullChatCount);
        if (msgsEl && fullMsgCount) msgsEl.textContent = formatNumber(fullMsgCount);
        const chatsStat = chatsEl?.closest('.browse-stat');
        const msgsStat = msgsEl?.closest('.browse-stat');
        if (chatsStat && (fullChatCount || fullMsgCount)) chatsStat.style.display = '';
        if (msgsStat && (fullChatCount || fullMsgCount)) msgsStat.style.display = '';

        // Refresh creator notes with untruncated HTML from the full character
        const fullCreatorNotes = character.description || '';
        const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
        if (fullCreatorNotes.trim()) {
            if (creatorNotesSection) creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) renderCreatorNotesSecure(fullCreatorNotes, name, creatorNotesEl);
        } else {
            if (creatorNotesSection) creatorNotesSection.style.display = 'none';
            if (creatorNotesEl) creatorNotesEl.innerHTML = '';
        }

        // Update tags if the full character has them
        if (character.tags?.length) {
            const tagsEl = document.getElementById('datacatCharTags');
            const fullTags = resolveTagNames(character.tags);
            if (tagsEl) tagsEl.innerHTML = fullTags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
        }

        // Enable the import button now that full data is available
        const importBtn = document.getElementById('datacatImportBtn');
        if (importBtn && !importBtn.dataset.extractId) {
            const inLib = isCharInLocalLibrary(hit);
            if (inLib) {
                importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
                importBtn.classList.add('secondary');
                importBtn.classList.remove('primary', 'warning');
            } else {
                const creatorName = getCreatorName(hit) || 'Unknown';
                const possible = view.isCharPossibleMatch(hit.name || '', creatorName);
                if (possible) {
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

        // Fetch download data for alternate greetings
        fetchDatacatDownload(charId).then(downloadData => {
            if (token !== datacatDetailFetchToken) return;
            const altGreetings = downloadData?.data?.alternate_greetings;
            renderAltGreetings(altGreetings, name);
        }).catch(() => {});
    } catch (err) {
        debugLog('[DatacatBrowse] Detail fetch error:', err);
        if (token === datacatDetailFetchToken) {
            const descEl = document.getElementById('datacatCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition.</em>';
            const importBtn = document.getElementById('datacatImportBtn');
            if (importBtn) {
                importBtn.disabled = false;
                importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
                importBtn.classList.remove('primary', 'secondary', 'warning');
                importBtn.classList.add('primary');
                importBtn.dataset.extractId = charId;
            }
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

        const character = charData._fullCharacter || charData;
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

            const avatarUrl = (character.avatar || charData.avatar)
                ? `${DATACAT_IMAGE_BASE}${character.avatar || charData.avatar}`
                : '/img/ai4.png';
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
        if (mediaUrls.length > 0 && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                mediaCharacters: [{
                    characterName: result.characterName,
                    name: result.characterName,
                    fileName: result.fileName,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                    mediaUrls
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
                if (creatorId) browseCreator(creatorId);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.datacatId;
            if (!charId) return;
            const hit = datacatCharacters.find(c => String(getCharId(c)) === charId);
            if (hit) openPreviewModal(hit);
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
    });

    // Load More
    on('datacatLoadMoreBtn', 'click', () => {
        if (isHampterSortMode(datacatSortMode)) {
            hampterCurrentPage++;
        } else if (isJannySortMode(datacatSortMode)) {
            meiliCurrentPage++;
        } else {
            const loadParsed = parseSortMode(datacatSortMode);
            const isFreshMode = datacatBrowseMode !== 'creator' && loadParsed;
            if (isFreshMode) {
                if (loadParsed.window === '24h') datacatFreshLimit24 += FRESH_PAGE_INCREMENT;
                else datacatFreshLimitWeek += FRESH_PAGE_INCREMENT;
            } else {
                datacatCurrentOffset += PAGE_SIZE;
            }
        }
        loadCharacters(true);
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
        }
        datacatCurrentOffset = 0;
        updateSearchPlaceholder();
        updateTagsVisibility();
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
        datacatCurrentOffset = 0;
        datacatFreshLimit24 = 80;
        datacatFreshLimitWeek = 20;
        hampterCurrentPage = 1;
        loadCharacters(false);
    });

    // Clear creator filter
    on('datacatClearCreatorBtn', 'click', () => clearCreatorFilter());

    // Tags dropdown toggle
    on('datacatTagsBtn', 'click', () => {
        const dropdown = document.getElementById('datacatTagsDropdown');
        if (!dropdown) return;
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
            if (isJannyTagMode()) {
                renderJannyTagsList();
            } else {
                loadFacetedTags();
            }
        }
    });
    on('datacatTagsClearBtn', 'click', () => {
        if (isJannyTagMode()) {
            jannyActiveTagIds.clear();
            renderJannyTagsList();
        } else {
            datacatActiveTagIds.clear();
            renderTagsList();
            refreshTagCounts();
        }
        updateTagsButton();
        datacatCurrentOffset = 0;
        loadCharacters(false);
    });

    // Dropdown dismiss (click outside)
    datacatBrowseView._registerDropdownDismiss([
        { dropdownId: 'datacatTagsDropdown', buttonId: 'datacatTagsBtn' },
    ]);

    // View mode toggle (Browse / Following)
    document.querySelectorAll('.datacat-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.datacatView;
            if (mode && mode !== datacatViewMode) switchDatacatViewMode(mode);
        });
    });

    // Follow button in creator banner
    on('datacatFollowCreatorBtn', 'click', () => {
        if (!datacatCreatorId) return;
        if (isCreatorFollowed(datacatCreatorId)) {
            unfollowCreator(datacatCreatorId);
        } else {
            followCreator(datacatCreatorId, datacatCreatorName);
        }
    });

    // Following sort
    on('datacatFollowingSortSelect', 'change', () => {
        const el = document.getElementById('datacatFollowingSortSelect');
        if (!el) return;
        datacatFollowingSort = el.value;
        renderFollowing();
    });

    // Following grid card click --> open preview (delegation)
    const followingGrid = document.getElementById('datacatFollowingGrid');
    if (followingGrid) {
        followingGrid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const creatorId = authorLink.dataset.creatorId;
                if (creatorId) {
                    switchDatacatViewMode('browse');
                    browseCreator(creatorId);
                }
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.datacatId;
            if (!charId) return;
            const hit = datacatFollowingCharacters.find(c => String(getCharId(c)) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    // Following refresh
    on('datacatFollowingRefreshBtn', 'click', () => {
        datacatFollowingCharacters = [];
        loadFollowingCharacters(true);
    });

    // ---- Preview modal events (only attach once) ----
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        on('datacatCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('datacatCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const creatorId = getCreatorId(datacatSelectedChar);
                if (creatorId) {
                    closePreviewModal();
                    browseCreator(creatorId);
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
                startModalExtraction(extractId);
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
    }
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

const datacatBrowseView = new (class DatacatBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const dcData = char.data?.extensions?.datacat;
        if (dcData?.id) idSet.add(String(dcData.id));
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
                        <span style="font-size: var(--btn-font-sm); color: var(--text-secondary);">Filter by tags</span>
                        <button id="datacatTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="datacatTagsList"></div>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="datacatNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
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
                            <input type="search" id="datacatCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
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
                    <button id="datacatFollowingRefreshBtn" class="glass-btn icon-only" title="Refresh timeline">
                        <i class="fa-solid fa-sync"></i>
                    </button>
                </div>
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
            </div>
        </div>
    </div>`;
    }

    // -- Lifecycle --

    _getImageGridIds() { return ['datacatGrid', 'datacatFollowingGrid']; }

    canLoadMore() { return datacatHasMore && !datacatIsLoading; }

    loadMore() {
        if (isHampterSortMode(datacatSortMode)) {
            hampterCurrentPage++;
        } else if (isJannySortMode(datacatSortMode)) {
            meiliCurrentPage++;
        } else {
            const parsed = parseSortMode(datacatSortMode);
            const isFreshMode = datacatBrowseMode !== 'creator' && parsed;
            if (isFreshMode) {
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
        if (grid) this.observeImages(grid);

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
            datacatFollowingGridRenderedCount = 0;
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
        stopExtractionPolling();
        super.deactivate();
        this.disconnectImageObserver();
    }
})();

export default datacatBrowseView;
