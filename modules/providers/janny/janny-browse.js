// JannyBrowseView — JannyAI browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    JANNY_SEARCH_URL,
    JANNY_IMAGE_BASE,
    JANNY_SITE_BASE,
    TAG_MAP,
    getSearchToken,
    fetchWithProxy,
    slugify,
    stripHtml,
    resolveTagNames
} from './janny-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    checkCharacterForDuplicates,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    getAllCharacters,
    formatRichText,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    debounce
} = CoreAPI;

// ========================================
// CONSTANTS
// ========================================



// ========================================
// STATE
// ========================================

let jannyCharacters = [];
let jannyCurrentPage = 1;
let jannyHasMore = true;
let jannyIsLoading = false;
let jannyCurrentSearch = '';
let jannyNsfwEnabled = true;
let jannySortMode = 'newest';
let jannySelectedChar = null;
let jannyGridRenderedCount = 0;

// Filter state — mirrors Chub's filter model for parity
let jannyShowLowQuality = false;
let jannyMinTokens = 29;
let jannyMaxTokens = 100000;
let jannyFilterHideOwned = false;
/** @type {Set<number>} Active include tag IDs */
let jannyIncludeTags = new Set();
let jannyAuthorFilter = null;

// Local library lookup for "In Library" badges
let localLibraryLookup = {
    byNameAndCreator: new Set(),
    byJannyId: new Set()
};

// ========================================
// SEARCH API
// ========================================

async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'newest' } = opts;

    // Build MeiliSearch filter array from state
    const filters = [];
    filters.push(`totalToken >= ${jannyMinTokens}`);
    filters.push(`totalToken <= ${jannyMaxTokens}`);
    if (!jannyNsfwEnabled) filters.push('isNsfw = false');
    if (!jannyShowLowQuality) filters.push('isLowQuality = false');
    if (jannyIncludeTags.size > 0) {
        const tagClauses = [...jannyIncludeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    // MeiliSearch sort
    const sortMap = {
        newest: ['createdAtStamp:desc'],
        oldest: ['createdAtStamp:asc'],
        tokens_desc: ['totalToken:desc'],
        tokens_asc: ['totalToken:asc'],
        relevant: []
    };
    let sortArr = sortMap[sort] || sortMap.newest;

    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isLowQuality', 'isNsfw', 'tagIds', 'totalToken'],
            attributesToCrop: ['description:300'],
            cropMarker: '...',
            filter: filters,
            attributesToHighlight: ['name', 'description'],
            highlightPreTag: '__ais-highlight__',
            highlightPostTag: '__/ais-highlight__',
            hitsPerPage: limit,
            page
        }]
    };

    if (sortArr.length > 0) {
        body.queries[0].sort = sortArr;
    }

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

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function buildLocalLibraryLookup() {
    localLibraryLookup.byNameAndCreator.clear();
    localLibraryLookup.byJannyId.clear();

    for (const char of getAllCharacters()) {
        if (!char) continue;

        const name = (char.name || '').toLowerCase().trim();
        const creator = (char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) localLibraryLookup.byNameAndCreator.add(`${name}|${creator}`);

        const jannyData = char.data?.extensions?.jannyai;
        if (jannyData?.id) localLibraryLookup.byJannyId.add(String(jannyData.id));
    }

    debugLog('[JannyBrowse] Library lookup built:',
        'nameCreators:', localLibraryLookup.byNameAndCreator.size,
        'jannyIds:', localLibraryLookup.byJannyId.size);
}

function isCharInLocalLibrary(jannyChar) {
    if (jannyChar.id && localLibraryLookup.byJannyId.has(String(jannyChar.id))) return true;

    const name = (jannyChar.name || '').toLowerCase().trim();
    const creator = (jannyChar.creatorUsername || '').toLowerCase().trim();
    if (name && creator && localLibraryLookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

// ========================================
// CARD RENDERING
// ========================================

function createJannyCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarUrl = hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '/img/ai4.png';
    const tags = resolveTagNames(hit.tagIds).slice(0, 3);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const slug = slugify(name);
    const creatorName = hit.creatorUsername || '';
    const inLibrary = isCharInLocalLibrary(hit);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-janny-id="${escapeHtml(String(charId))}" data-slug="${escapeHtml(slug)}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function observeNewCards() {
    const grid = document.getElementById('jannyGrid');
    if (grid) jannyBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('jannyGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        jannyGridRenderedCount = 0;
    }

    const startIdx = jannyGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createJannyCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    jannyGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    jannyBrowseView.updateLoadMoreVisibility('jannyLoadMore', jannyHasMore, jannyCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (jannyIsLoading) return;
    jannyIsLoading = true;

    const grid = document.getElementById('jannyGrid');
    const loadMoreBtn = document.getElementById('jannyLoadMoreBtn');

    if (!append && grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Searching JannyAI...</p>
            </div>
        `;
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const effectiveSearch = jannyAuthorFilter || jannyCurrentSearch;
        const data = await searchJanny({
            search: effectiveSearch,
            page: jannyCurrentPage,
            limit: 80,
            sort: jannySortMode
        });

        // Provider was deactivated during the fetch
        if (!delegatesInitialized) return;

        const result = data?.results?.[0];
        let hits = result?.hits || [];
        const totalPages = result?.totalPages || 1;

        // Client-side: hide owned characters
        if (jannyFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }

        // Auto-fetch when client-side filters remove too many results
        if (jannyFilterHideOwned && jannyCurrentPage < totalPages) {
            let autoFetches = 0;
            while (hits.length < 80 && jannyCurrentPage < totalPages && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                jannyCurrentPage++;
                const moreData = await searchJanny({
                    search: effectiveSearch,
                    page: jannyCurrentPage,
                    limit: 80,
                    sort: jannySortMode
                });
                if (!delegatesInitialized) return;
                const moreResult = moreData?.results?.[0];
                let moreHits = moreResult?.hits || [];
                moreHits = moreHits.filter(h => !isCharInLocalLibrary(h));
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[JannyBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for "hide owned" filter`);
            }
        }

        if (append) {
            jannyCharacters = jannyCharacters.concat(hits);
        } else {
            jannyCharacters = hits;
        }

        jannyHasMore = jannyCurrentPage < totalPages;

        renderGrid(jannyCharacters, append);

        if (!append && jannyCharacters.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-search" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">No characters found</p>
                </div>
            `;
        }

        debugLog('[JannyBrowse] Loaded', hits.length, 'characters, page', jannyCurrentPage, '/', totalPages);

    } catch (err) {
        console.error('[JannyBrowse] Search error:', err);
        showToast(`JannyAI search failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                    <p style="margin-top: 12px;">Search failed: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="jannyRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('jannyRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
        }
    } finally {
        jannyIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

let jannyDetailFetchToken = 0;
let jannyDetailFetchPromise = null;

function openPreviewModal(hit) {
    jannySelectedChar = hit;

    const modal = document.getElementById('jannyCharModal');
    if (!modal) return;

    const name = hit.name || 'Unknown';
    const creatorNotes = stripHtml(hit.description) || '';
    const avatarUrl = hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '/img/ai4.png';
    const tags = resolveTagNames(hit.tagIds);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const slug = slugify(name);
    const jannyUrl = `${JANNY_SITE_BASE}/characters/${charId}_character-${slug}`;
    const inLibrary = isCharInLocalLibrary(hit);

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');

    // Header
    const avatarImg = document.getElementById('jannyCharAvatar');
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    document.getElementById('jannyCharName').textContent = name;
    document.getElementById('jannyCharCreator').textContent = hit.creatorUsername || hit.creatorId || 'Unknown';
    document.getElementById('jannyOpenInBrowserBtn').href = jannyUrl;

    // Stats
    document.getElementById('jannyCharTokens').textContent = tokens;
    document.getElementById('jannyCharDate').textContent = createdDate || 'Unknown';

    // Tags
    const tagsEl = document.getElementById('jannyCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');

    // Creator's Notes (website description — may include inline images from ella.janitorai.com)
    const rawDescription = hit.description || '';
    const creatorNotesSection = document.getElementById('jannyCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('jannyCharCreatorNotes');
    if (rawDescription.trim()) {
        creatorNotesSection.style.display = 'block';
        renderCreatorNotesSecure(rawDescription, name, creatorNotesEl);
    } else {
        creatorNotesSection.style.display = 'none';
        if (creatorNotesEl) creatorNotesEl.innerHTML = '';
    }

    // Show loading indicator in description section; hide others
    const descSection = document.getElementById('jannyCharDescriptionSection');
    const descEl = document.getElementById('jannyCharDescription');
    const scenarioSection = document.getElementById('jannyCharScenarioSection');
    const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
    const examplesSection = document.getElementById('jannyCharExamplesSection');
    descSection.style.display = 'block';
    descEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>';
    scenarioSection.style.display = 'none';
    firstMsgSection.style.display = 'none';
    examplesSection.style.display = 'none';

    // Import button state
    const importBtn = document.getElementById('jannyImportBtn');
    if (inLibrary) {
        importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary');
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        importBtn.classList.add('primary');
        importBtn.classList.remove('secondary');
    }
    importBtn.disabled = false;

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Fetch full details in background — store promise so Import can await it
    const fetchToken = ++jannyDetailFetchToken;
    jannyDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = hit.id || '';
    const slug = slugify(hit.name || 'character');
    const name = hit.name || 'Unknown';

    try {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider) return;

        let charData = null;
        try {
            const data = await provider.fetchMetadata(`${charId}_character-${slug}`);
            if (data) charData = data;
        } catch (e) {
            console.warn('[JannyBrowse] Detail fetch failed:', e.message);
        }

        // Stale check — user may have opened a different card
        if (token !== jannyDetailFetchToken) return;

        if (!charData) {
            const descSection = document.getElementById('jannyCharDescriptionSection');
            const descEl = document.getElementById('jannyCharDescription');
            if (descSection && descEl) {
                descSection.style.display = 'block';
                descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition — Cloudflare may be blocking the request. The character can still be imported with basic info.</em>';
            }
            return;
        }

        // Store full data on the selected char for import
        if (jannySelectedChar?.id === hit.id) {
            jannySelectedChar._fullData = charData;
        }

        // Update creator display with scraped username (MeiliSearch only has UUID)
        if (charData.creatorUsername && token === jannyDetailFetchToken) {
            const creatorEl = document.getElementById('jannyCharCreator');
            if (creatorEl) creatorEl.textContent = charData.creatorUsername;
            if (jannySelectedChar?.id === hit.id) {
                jannySelectedChar.creatorUsername = charData.creatorUsername;
            }
        }

        const personality = charData.personality || '';
        const scenario = charData.scenario || '';
        const firstMessage = charData.firstMessage || '';
        const exampleDialogs = charData.exampleDialogs || '';

        const descSection = document.getElementById('jannyCharDescriptionSection');
        const descEl = document.getElementById('jannyCharDescription');
        if (descSection) {
            if (personality) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = formatRichText(personality, name, false);
            } else {
                descSection.style.display = 'none';
            }
        }

        const scenarioSection = document.getElementById('jannyCharScenarioSection');
        const scenarioEl = document.getElementById('jannyCharScenario');
        if (scenarioSection && scenario) {
            scenarioSection.style.display = 'block';
            if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
        }

        const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
        const firstMsgEl = document.getElementById('jannyCharFirstMsg');
        if (firstMsgSection && firstMessage) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) {
                firstMsgEl.innerHTML = formatRichText(firstMessage, name, false);
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        }

        const examplesSection = document.getElementById('jannyCharExamplesSection');
        const examplesEl = document.getElementById('jannyCharExamples');
        if (examplesSection && exampleDialogs) {
            examplesSection.style.display = 'block';
            if (examplesEl) examplesEl.innerHTML = formatRichText(exampleDialogs, name, false);
        }
    } catch (err) {
        debugLog('[JannyBrowse] Detail fetch error:', err);
        if (token === jannyDetailFetchToken) {
            const descEl = document.getElementById('jannyCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
        }
    }
}

function cleanupJannyCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const creatorEl = document.getElementById('jannyCharCreator');
    if (creatorEl) creatorEl.textContent = '';
    const sectionIds = [
        'jannyCharDescription',
        'jannyCharScenario',
        'jannyCharFirstMsg',
        'jannyCharExamples',
        'jannyCharAltGreetings',
        'jannyCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('jannyCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    jannyDetailFetchToken++;
    jannyDetailFetchPromise = null;
    cleanupJannyCharModal();
    const modal = document.getElementById('jannyCharModal');
    if (modal) modal.classList.add('hidden');
    jannySelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.id) return;

    const charId = charData.id;
    const slug = slugify(charData.name || 'character');
    const identifier = `${charId}_character-${slug}`;

    const importBtn = document.getElementById('jannyImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider?.importCharacter) throw new Error('JannyAI provider not available');

        // Wait for the detail fetch to finish so _fullData is populated
        if (jannyDetailFetchPromise) {
            try { await jannyDetailFetchPromise; } catch { /* ignore */ }
        }

        const fallbackData = charData._fullData || charData;
        if (!fallbackData.tagIds && charData.tagIds) {
            fallbackData.tagIds = charData.tagIds;
        }

        const charName = fallbackData.name || charData.name || '';
        const charCreator = charData.creatorUsername || fallbackData.creatorUsername || '';

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = checkCharacterForDuplicates({
            name: charName,
            creator: charCreator,
            fullPath: identifier,
            description: fallbackData.personality || fallbackData.description || '',
            first_mes: fallbackData.firstMessage || '',
            scenario: fallbackData.scenario || ''
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = charData.avatar ? `${JANNY_IMAGE_BASE}${charData.avatar}` : '/img/ai4.png';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: identifier,
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
                    console.warn('[JannyBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(identifier, fallbackData, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        closePreviewModal();
        await new Promise(r => requestAnimationFrame(r));

        showToast(`Imported "${result.characterName}"`, 'success');

        // Show import summary before library refresh so modal appears immediately
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

        // Lightweight single-character add (avoids OOM from full list reload on mobile)
        const added = await fetchAndAddCharacter(result.fileName);
        if (!added) await fetchCharacters(true);
        buildLocalLibraryLookup();
        markCardAsImported(charId);

    } catch (err) {
        console.error('[JannyBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(charId) {
    const grid = document.getElementById('jannyGrid');
    if (!grid) return;
    const card = grid.querySelector(`[data-janny-id="${charId}"]`);
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

// ========================================
// TAGS RENDERING
// ========================================

const ALL_TAGS = Object.entries(TAG_MAP)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

function renderTagsList(filter = '') {
    const container = document.getElementById('jannyTagsList');
    if (!container) return;

    const filtered = filter
        ? ALL_TAGS.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
        : ALL_TAGS;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jannyIncludeTags.has(tag.id);
        const stateClass = included ? 'state-include' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = included ? 'Included — click to remove' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    // Bind click handlers on tag items
    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            if (jannyIncludeTags.has(tagId)) {
                jannyIncludeTags.delete(tagId);
            } else {
                jannyIncludeTags.add(tagId);
            }
            cycleTagState(stateBtn, jannyIncludeTags.has(tagId));
            updateJannyTagsButton();
            jannyCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

function cycleTagState(btn, included) {
    btn.className = 'browse-tag-state-btn';
    if (included) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included — click to remove';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateJannyTagsButton() {
    const btn = document.getElementById('jannyTagsBtn');
    const label = document.getElementById('jannyTagsBtnLabel');
    if (!btn) return;

    const count = jannyIncludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateJannyFiltersButton() {
    const btn = document.getElementById('jannyFiltersBtn');
    if (!btn) return;

    const active = jannyShowLowQuality || jannyFilterHideOwned;
    btn.classList.toggle('has-filters', active);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initJannyView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Convert native selects to styled custom dropdowns
    const sortEl = document.getElementById('jannySortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('jannyGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.jannyId;
            if (!charId) return;
            const hit = jannyCharacters.find(c => String(c.id) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('jannySearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('jannySearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('jannySearchBtn', 'click', () => doSearch());
    on('jannyClearSearchBtn', 'click', () => {
        const input = document.getElementById('jannySearchInput');
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        jannyCurrentSearch = '';
        jannyAuthorFilter = null;
        jannyCurrentPage = 1;
        const authorBanner = document.getElementById('jannyAuthorBanner');
        if (authorBanner) authorBanner.classList.add('hidden');
        loadCharacters(false);
    });

    // Load More
    on('jannyLoadMoreBtn', 'click', () => {
        jannyCurrentPage++;
        loadCharacters(true);
    });

    // NSFW toggle
    on('jannyNsfwToggle', 'click', () => {
        jannyNsfwEnabled = !jannyNsfwEnabled;
        updateNsfwToggle();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });
    updateNsfwToggle();

    // Sort mode
    on('jannySortSelect', 'change', () => {
        const el = document.getElementById('jannySortSelect');
        if (el) jannySortMode = el.value;

        // Sync search input if user typed without pressing Enter
        const input = document.getElementById('jannySearchInput');
        if (input) jannyCurrentSearch = input.value.trim();

        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Refresh
    // Author filter banner
    on('jannyClearAuthorBtn', 'click', () => clearAuthorFilter());

    on('jannyRefreshBtn', 'click', () => {
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('jannyTagsDropdown');

    on('jannyTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('jannyTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('jannyTagsClearBtn', 'click', () => {
        jannyIncludeTags.clear();
        renderTagsList(document.getElementById('jannyTagsSearchInput')?.value || '');
        updateJannyTagsButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => {
        jannyCurrentPage = 1;
        loadCharacters(false);
    }, 500);

    on('jannyMinTokens', 'change', () => {
        const el = document.getElementById('jannyMinTokens');
        if (el) jannyMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('jannyMaxTokens', 'change', () => {
        const el = document.getElementById('jannyMaxTokens');
        if (el) jannyMaxTokens = parseInt(el.value, 10) || 100000;
        tokenDebounce();
    });

    // ── Features dropdown ──
    const filtersDropdown = document.getElementById('jannyFiltersDropdown');

    on('jannyFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('jannyFilterLowQuality', 'change', () => {
        const el = document.getElementById('jannyFilterLowQuality');
        if (el) jannyShowLowQuality = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    on('jannyFilterHideOwned', 'change', () => {
        const el = document.getElementById('jannyFilterHideOwned');
        if (el) jannyFilterHideOwned = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Close dropdowns when clicking outside
    jannyBrowseView._registerDropdownDismiss([
        { dropdownId: 'jannyTagsDropdown', buttonId: 'jannyTagsBtn' },
        { dropdownId: 'jannyFiltersDropdown', buttonId: 'jannyFiltersBtn' }
    ]);

    // ── Preview modal events (only attach once — modal DOM persists across provider switches) ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        on('jannyCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('jannyCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const name = creatorLink.textContent.trim();
                if (name && name !== 'Unknown') {
                    closePreviewModal();
                    filterByAuthor(name);
                }
            });
        }

        // Avatar click → full-size image viewer (desktop only; mobile has its own handler)
        const jannyAvatar = document.getElementById('jannyCharAvatar');
        if (jannyAvatar && !window.matchMedia('(max-width: 768px)').matches) {
            jannyAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!jannyAvatar.src || jannyAvatar.src.endsWith('/img/ai4.png')) return;
                BrowseView.openAvatarViewer(jannyAvatar.src);
            });
        }

        on('jannyImportBtn', 'click', () => {
            if (jannySelectedChar) importCharacter(jannySelectedChar);
        });

        const modalOverlay = document.getElementById('jannyCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }
    }
}

function doSearch() {
    const input = document.getElementById('jannySearchInput');
    const clearBtn = document.getElementById('jannyClearSearchBtn');
    const val = (input?.value || '').trim();

    if (jannyAuthorFilter) {
        jannyAuthorFilter = null;
        const banner = document.getElementById('jannyAuthorBanner');
        if (banner) banner.classList.add('hidden');
    }

    jannyCurrentSearch = val;
    jannyCurrentPage = 1;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    // When searching with text, default to relevance sort
    const sortSelect = document.getElementById('jannySortSelect');
    if (val && sortSelect && jannySortMode === 'newest') {
        jannySortMode = 'relevant';
        sortSelect.value = 'relevant';
    }

    loadCharacters(false);
}

function filterByAuthor(authorName) {
    jannyAuthorFilter = authorName;
    jannyCurrentSearch = '';
    jannyCurrentPage = 1;
    jannySortMode = 'relevant';

    const sortSelect = document.getElementById('jannySortSelect');
    if (sortSelect) sortSelect.value = 'relevant';

    const searchInput = document.getElementById('jannySearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('jannyClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    const banner = document.getElementById('jannyAuthorBanner');
    const bannerName = document.getElementById('jannyAuthorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = authorName;
        banner.classList.remove('hidden');
    }

    loadCharacters(false);
}

function clearAuthorFilter() {
    jannyAuthorFilter = null;

    const banner = document.getElementById('jannyAuthorBanner');
    if (banner) banner.classList.add('hidden');

    jannyCharacters = [];
    jannyCurrentPage = 1;
    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('jannyNsfwToggle');
    if (!btn) return;

    if (jannyNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class JannyBrowseView extends BrowseView {

    get previewModalId() { return 'jannyCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'tokens_desc', label: 'Most Tokens' },
                { value: 'tokens_asc', label: 'Least Tokens' },
            ],
            followingSortOptions: [],
            viewModes: [],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'jannySortSelect',
            tags: 'jannyTagsBtn',
            filters: 'jannyFiltersBtn',
            nsfw: 'jannyNsfwToggle',
            refresh: 'jannyRefreshBtn'
        };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="jannySortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Date">
                        <option value="newest" ${jannySortMode === 'newest' ? 'selected' : ''}>🆕 Newest</option>
                        <option value="oldest" ${jannySortMode === 'oldest' ? 'selected' : ''}>🕐 Oldest</option>
                    </optgroup>
                    <optgroup label="Tokens">
                        <option value="tokens_desc" ${jannySortMode === 'tokens_desc' ? 'selected' : ''}>📊 Most Tokens</option>
                        <option value="tokens_asc" ${jannySortMode === 'tokens_asc' ? 'selected' : ''}>📊 Least Tokens</option>
                    </optgroup>
                    <optgroup label="Search">
                        <option value="relevant" ${jannySortMode === 'relevant' ? 'selected' : ''}>🔍 Relevance</option>
                    </optgroup>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="jannyTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="jannyTagsBtnLabel">Tags</span>
                </button>
                <div id="jannyTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="text" id="jannyTagsSearchInput" placeholder="Search tags...">
                        <button id="jannyTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="jannyTagsList"></div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="jannyMinTokens" class="glass-input-small" value="${jannyMinTokens}" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="jannyMaxTokens" class="glass-input-small" value="${jannyMaxTokens}" min="0" max="500000" step="1000">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="jannyFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="jannyFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Content:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterLowQuality"> <i class="fa-solid fa-filter-circle-xmark"></i> Show Low-Quality</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="jannyNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="jannyRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="jannyBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="text" id="jannySearchInput" placeholder="Search JannyAI characters...">
                        <button id="jannyClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="jannySearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <!-- Author Filter Banner -->
                <div id="jannyAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span>Searching for <strong id="jannyAuthorBannerName">Author</strong> <span class="browse-author-banner-hint">(keyword search — may include unrelated results)</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="jannyClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="jannyGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="jannyLoadMore" style="display: none;">
                    <button id="jannyLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return `
    <div id="jannyCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="jannyCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="jannyCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="jannyCharCreator" href="#" class="creator-link" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="jannyOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on JannyAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="jannyImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="jannyCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="jannyCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="jannyCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="jannyCharTags"></div>
                </div>

                <!-- Creator's Notes (website description — may contain images) -->
                <div class="browse-char-section" id="jannyCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="jannyCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description (personality field) -->
                <div class="browse-char-section" id="jannyCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="jannyCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="jannyCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="jannyCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="jannyCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="jannyCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="jannyCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="jannyCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() { return ['jannyGrid']; }

    canLoadMore() { return jannyHasMore && !jannyIsLoading; }

    loadMore() {
        jannyCurrentPage++;
        loadCharacters(true);
    }

    init() {
        super.init();
        buildLocalLibraryLookup();
        initJannyView();
        const grid = document.getElementById('jannyGrid');
        if (grid) this.observeImages(grid);
        loadCharacters(false);
    }

    applyDefaults(defaults) {
        if (defaults.sort) {
            jannySortMode = defaults.sort;
            const el = document.getElementById('jannySortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            jannyCurrentSearch = '';
            jannyAuthorFilter = null;
            jannyCharacters = [];
            jannyCurrentPage = 1;
            jannyHasMore = true;
            jannyGridRenderedCount = 0;
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized) {
            delegatesInitialized = true;
            buildLocalLibraryLookup();
            const grid = document.getElementById('jannyGrid');
            if (grid) this.observeImages(grid);
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    rebuildLocalLibraryLookup() {
        buildLocalLibraryLookup();
    }

    refreshInLibraryBadges() {
        const grid = document.getElementById('jannyGrid');
        if (!grid) return;
        for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
            const id = card.dataset.jannyId;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            if (isCharInLocalLibrary({ id, name })) {
                markCardAsImported(id);
            }
        }
    }

    deactivate() {
        jannyDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const jannyBrowseView = new JannyBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openJannyCharPreview = function(hit) {
    openPreviewModal(hit);
};

export default jannyBrowseView;
