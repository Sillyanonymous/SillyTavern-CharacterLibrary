// ChartavernBrowseView — CharacterTavern browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import {
    CT_SITE_BASE,
    searchCards,
    fetchCharacterDetail,
    fetchTopTags,
    getAvatarUrl,
    getCharacterPageUrl,
    stripHtml,
    parseTags,
    formatNumber,
} from './chartavern-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    convertImageToPng,
    embedCharacterDataInPng,
    getCSRFToken,
    generateGalleryId,
    findCharacterMediaUrls,
    checkCharacterForDuplicates,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    getAllCharacters,
    formatRichText,
    debounce
} = CoreAPI;

// ========================================
// CONSTANTS
// ========================================

const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

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

let ctCharacters = [];
let ctCurrentPage = 1;
let ctTotalPages = 1;
let ctHasMore = true;
let ctIsLoading = false;
let ctCurrentSearch = '';
let ctNsfwEnabled = true;
let ctSortMode = 'most_popular';
let ctSelectedChar = null;
let ctImageObserver = null;
let ctGridRenderedCount = 0;

// Filter state
let ctMinTokens = 0;
let ctMaxTokens = 0;
let ctFilterHideOwned = false;
let ctFilterHasLorebook = false;
let ctFilterIsOC = false;

// Tag filter state
/** @type {Set<string>} Active include tags */
let ctIncludeTags = new Set();
/** @type {Set<string>} Active exclude tags */
let ctExcludeTags = new Set();

// Cached top tags from API
let ctTopTags = [];
let ctTopTagsFetched = false;

// Local library lookup for "In Library" badges
let localLibraryLookup = {
    byName: new Set(),
    byNameAndCreator: new Set(),
    byCtPath: new Set()
};

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function buildLocalLibraryLookup() {
    localLibraryLookup.byName.clear();
    localLibraryLookup.byNameAndCreator.clear();
    localLibraryLookup.byCtPath.clear();

    for (const char of getAllCharacters()) {
        if (!char) continue;

        const name = (char.name || '').toLowerCase().trim();
        if (name) localLibraryLookup.byName.add(name);

        const creator = (char.creator || char.data?.creator || '').toLowerCase().trim();
        if (name && creator) localLibraryLookup.byNameAndCreator.add(`${name}|${creator}`);

        const ctData = char.data?.extensions?.chartavern;
        if (ctData?.path) localLibraryLookup.byCtPath.add(ctData.path);
    }

    debugLog('[CTBrowse] Library lookup built:',
        'names:', localLibraryLookup.byName.size,
        'ctPaths:', localLibraryLookup.byCtPath.size);
}

function isCharInLocalLibrary(hit) {
    if (hit.path && localLibraryLookup.byCtPath.has(hit.path)) return true;

    const name = (hit.name || '').toLowerCase().trim();
    if (name && name.length > 3 && localLibraryLookup.byName.has(name)) return true;

    return false;
}

// ========================================
// TAG CLAMPING
// ========================================

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

// ========================================
// CARD RENDERING
// ========================================

function createCtCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.tagline || hit.pageDescription || '');
    const avatarUrl = hit.path ? getAvatarUrl(hit.path) : '/img/ai4.png';
    const tags = parseTags(hit.tags).slice(0, 3);
    const tokens = formatNumber(hit.totalTokens || 0);
    const author = hit.author || hit.path?.split('/')[0] || '';
    const inLibrary = isCharInLocalLibrary(hit);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (hit.hasLorebook) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }
    if (hit.isOC) {
        badges.push('<span class="browse-feature-badge" title="Original Character"><i class="fa-solid fa-star"></i></span>');
    }

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt * 1000).toLocaleDateString()
        : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-ct-path="${escapeHtml(hit.path || '')}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${hit.isNSFW ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${author ? `<span class="browse-card-creator-link" data-author="${escapeHtml(author)}" title="Click to see all characters by ${escapeHtml(author)}">${escapeHtml(author)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.downloads || 0)}</span>
                <span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${formatNumber(hit.likes || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function initCtImageObserver() {
    if (ctImageObserver) return;
    ctImageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            const realSrc = img.dataset.src;
            if (realSrc && !img.dataset.failed && img.src !== realSrc) {
                img.src = realSrc;
            }
        }
    }, { rootMargin: '600px' });
}

function setupImageObserver() {
    initCtImageObserver();
    const grid = document.getElementById('ctGrid');
    if (grid) observeCtImages(grid);
}

function observeCtImages(container) {
    if (!ctImageObserver) initCtImageObserver();
    requestAnimationFrame(() => {
        eagerLoadVisibleCtImages(container);
        const images = Array.from(container.querySelectorAll('.browse-card-image img')).filter(img => !img.dataset.observed);
        if (images.length === 0) return;

        if (images.length > 120) {
            const batchSize = 80;
            let index = 0;
            const observeBatch = () => {
                const end = Math.min(index + batchSize, images.length);
                for (let i = index; i < end; i++) {
                    images[i].dataset.observed = '1';
                    ctImageObserver.observe(images[i]);
                }
                index = end;
                if (index < images.length) requestAnimationFrame(observeBatch);
            };
            observeBatch();
            return;
        }

        for (const img of images) {
            img.dataset.observed = '1';
            ctImageObserver.observe(img);
        }
    });
}

function observeNewCards(startIdx) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;
    observeCtImages(grid);
}

function eagerLoadVisibleCtImages(container) {
    if (!container) return;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const preloadBottom = viewportHeight + 700;
    const images = container.querySelectorAll('.browse-card-image img[data-src]');
    for (const img of images) {
        if (img.dataset.failed) continue;
        const rect = img.getBoundingClientRect();
        if (rect.bottom > -160 && rect.top < preloadBottom) {
            const realSrc = img.dataset.src;
            if (realSrc && img.src !== realSrc) img.src = realSrc;
        }
    }
}

function reconnectCtObserver() {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;
    eagerLoadVisibleCtImages(grid);
    const imgs = grid.querySelectorAll('.browse-card-image img[data-observed]');
    for (const img of imgs) delete img.dataset.observed;
    observeCtImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        ctGridRenderedCount = 0;
    }

    const startIdx = ctGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createCtCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    ctGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    const loadMore = document.getElementById('ctLoadMore');
    if (loadMore) {
        loadMore.style.display = ctHasMore && ctCharacters.length > 0 ? 'block' : 'none';
    }
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (ctIsLoading) return;
    ctIsLoading = true;

    const grid = document.getElementById('ctGrid');
    const loadMoreBtn = document.getElementById('ctLoadMoreBtn');

    if (!append && grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Searching CharacterTavern...</p>
            </div>
        `;
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const opts = {
            query: ctCurrentSearch,
            sort: ctSortMode,
            page: ctCurrentPage,
            limit: 30,
            nsfw: ctNsfwEnabled
        };

        if (ctIncludeTags.size > 0) opts.tags = [...ctIncludeTags].join(',');
        if (ctExcludeTags.size > 0) opts.excludeTags = [...ctExcludeTags].join(',');
        if (ctMinTokens > 0) opts.minimumTokens = ctMinTokens;
        if (ctMaxTokens > 0) opts.maximumTokens = ctMaxTokens;
        if (ctFilterHasLorebook) opts.hasLorebook = true;
        if (ctFilterIsOC) opts.isOC = true;

        const data = await searchCards(opts);

        // Provider was deactivated during the fetch
        if (!delegatesInitialized) return;

        let hits = data?.hits || [];
        ctTotalPages = data?.totalPages || 1;

        // Client-side: hide owned characters
        if (ctFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }

        if (append) {
            ctCharacters = ctCharacters.concat(hits);
        } else {
            ctCharacters = hits;
        }

        ctHasMore = ctCurrentPage < ctTotalPages;

        renderGrid(ctCharacters, append);

        if (!append && ctCharacters.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-search" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">No characters found</p>
                </div>
            `;
        }

        debugLog('[CTBrowse] Loaded', hits.length, 'characters, page', ctCurrentPage, '/', ctTotalPages);

    } catch (err) {
        console.error('[CTBrowse] Search error:', err);
        showToast(`CharacterTavern search failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                    <p style="margin-top: 12px;">Search failed: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="ctRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('ctRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
        }
    } finally {
        ctIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

let ctDetailFetchToken = 0;

function openPreviewModal(hit) {
    ctSelectedChar = hit;

    const modal = document.getElementById('ctCharModal');
    if (!modal) return;

    const name = hit.name || 'Unknown';
    const author = hit.author || hit.path?.split('/')[0] || 'Unknown';
    const avatarUrl = hit.path ? getAvatarUrl(hit.path, 512) : '/img/ai4.png';
    const ctUrl = hit.path ? getCharacterPageUrl(hit.path) : '#';
    const inLibrary = isCharInLocalLibrary(hit);

    let charDef = '';

    try {
        const tagline = stripHtml(hit.tagline || '');
        const creatorNotes = hit.pageDescription || '';
        const tags = parseTags(hit.tags);
        const tokens = formatNumber(hit.totalTokens || 0);
        const downloads = formatNumber(hit.downloads || 0);
        const likes = formatNumber(hit.likes || 0);

        const createdDate = hit.createdAt
            ? new Date(hit.createdAt * 1000).toLocaleDateString()
            : '';

        // Header
        const avatarImg = document.getElementById('ctCharAvatar');
        if (avatarImg) {
            avatarImg.src = avatarUrl;
            avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
        }
        const nameEl = document.getElementById('ctCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('ctCharCreator');
        if (creatorEl) {
            creatorEl.textContent = author;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${author}`;
            creatorEl.onclick = (e) => {
                e.preventDefault();
                filterByAuthor(author);
            };
        }
        const openBtn = document.getElementById('ctOpenInBrowserBtn');
        if (openBtn) openBtn.href = ctUrl;

        // Tagline (above meta grid, no section header — matches Chub pattern)
        const taglineSection = document.getElementById('ctCharTaglineSection');
        const taglineEl = document.getElementById('ctCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.style.display = 'block';
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.style.display = 'none';
            }
        }

        // Stats
        const tokensEl = document.getElementById('ctCharTokens');
        if (tokensEl) tokensEl.textContent = tokens;
        const downloadsEl = document.getElementById('ctCharDownloads');
        if (downloadsEl) downloadsEl.textContent = downloads;
        const likesEl = document.getElementById('ctCharLikes');
        if (likesEl) likesEl.textContent = likes;
        const dateEl = document.getElementById('ctCharDate');
        if (dateEl) dateEl.textContent = createdDate || 'Unknown';

        // Greetings stat
        const greetingsStat = document.getElementById('ctCharGreetingsStat');
        const greetingsCount = document.getElementById('ctCharGreetingsCount');
        const altGreetings = Array.isArray(hit.alternativeFirstMessage) ? hit.alternativeFirstMessage.filter(Boolean) : [];
        if (greetingsStat) {
            if (altGreetings.length > 0) {
                greetingsStat.style.display = 'flex';
                if (greetingsCount) greetingsCount.textContent = String(altGreetings.length + 1);
            } else {
                greetingsStat.style.display = 'none';
            }
        }

        // Tags
        const tagsEl = document.getElementById('ctCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // Creator's Notes (public listing description — always visible)
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        if (creatorNotesEl) {
            if (creatorNotes) {
                creatorNotesEl.innerHTML = formatRichText(creatorNotes, name, false);
            } else {
                creatorNotesEl.textContent = 'No description available.';
            }
        }

        // Description (character definition)
        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        charDef = hit.characterDefinition || '';
        if (descSection) {
            if (charDef) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = formatRichText(charDef, name, false);
            } else {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>';
            }
        }

        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const scenario = hit.characterScenario || '';
        if (scenarioSection) {
            if (scenario) {
                scenarioSection.style.display = 'block';
                if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
            } else {
                scenarioSection.style.display = 'none';
            }
        }

        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        const firstMsg = hit.characterFirstMessage || '';
        if (firstMsgSection) {
            if (firstMsg) {
                firstMsgSection.style.display = 'block';
                if (firstMsgEl) firstMsgEl.innerHTML = formatRichText(firstMsg, name, false);
            } else {
                firstMsgSection.style.display = 'none';
            }
        }

        // Alternate Greetings — collapsible details with lazy rendering (matches Chub pattern)
        const altGreetingsSection = document.getElementById('ctCharAltGreetingsSection');
        const altGreetingsEl = document.getElementById('ctCharAltGreetings');
        const altGreetingsCountEl = document.getElementById('ctCharAltGreetingsCount');
        if (altGreetingsSection) {
            if (altGreetings.length > 0) {
                altGreetingsSection.style.display = 'block';
                if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${altGreetings.length})`;
                window.currentCtAltGreetings = altGreetings;
                if (altGreetingsEl) {
                    const buildPreview = (text) => {
                        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
                        if (!cleaned) return 'No content';
                        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
                    };
                    altGreetingsEl.innerHTML = altGreetings.map((greeting, idx) => {
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
                                if (altGreetings[idx] != null) {
                                    body.innerHTML = DOMPurify.sanitize(formatRichText(altGreetings[idx], name, true), BROWSE_PURIFY_CONFIG);
                                }
                                body.dataset.rendered = '1';
                            }
                        }, { once: true });
                    });
                }
            } else {
                altGreetingsSection.style.display = 'none';
                window.currentCtAltGreetings = [];
            }
        }

        // Example Dialogs
        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = hit.characterExampleMessages || '';
        if (examplesSection) {
            if (examples) {
                examplesSection.style.display = 'block';
                if (examplesEl) examplesEl.innerHTML = formatRichText(examples, name, false);
            } else {
                examplesSection.style.display = 'none';
            }
        }

        // Import button state
        const importBtn = document.getElementById('ctImportBtn');
        if (importBtn) {
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
        }
    } catch (err) {
        console.error('[CTBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');

    // If no definition was available in the search hit, fetch full details
    if (!charDef) {
        const fetchToken = ++ctDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

async function fetchAndPopulateDetails(hit, token) {
    if (!hit.path) return;
    const parts = hit.path.split('/');
    if (parts.length < 2) return;
    const name = hit.name || 'Unknown';

    try {
        const data = await fetchCharacterDetail(parts[0], parts[1]);
        if (token !== ctDetailFetchToken) return;
        if (!data?.card) return;

        const card = data.card;

        // Store full data on the selected char for import
        if (ctSelectedChar?.path === hit.path) {
            ctSelectedChar._fullDetail = card;
        }

        // Creator's Notes from detail API (richer than search hit's pageDescription)
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        const detailNotes = card.description || '';
        if (detailNotes && creatorNotesEl) {
            creatorNotesEl.innerHTML = formatRichText(detailNotes, name, false);
        }

        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        const charDef = card.definition_character_description || '';
        if (charDef) {
            descSection.style.display = 'block';
            descEl.innerHTML = formatRichText(charDef, name, false);
        } else {
            descSection.style.display = 'none';
        }

        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const scenario = card.definition_scenario || '';
        if (scenario) {
            scenarioSection.style.display = 'block';
            scenarioEl.innerHTML = formatRichText(scenario, name, false);
        }

        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        const firstMsg = card.definition_first_message || '';
        if (firstMsg) {
            firstMsgSection.style.display = 'block';
            firstMsgEl.innerHTML = formatRichText(firstMsg, name, false);
        }

        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = card.definition_example_messages || '';
        if (examples) {
            examplesSection.style.display = 'block';
            examplesEl.innerHTML = formatRichText(examples, name, false);
        }
    } catch (err) {
        debugLog('[CTBrowse] Detail fetch error:', err);
    }
}

function closePreviewModal() {
    ctDetailFetchToken++;
    const modal = document.getElementById('ctCharModal');
    if (modal) modal.classList.add('hidden');
    ctSelectedChar = null;
    window.currentCtAltGreetings = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.path) return;

    const importBtn = document.getElementById('ctImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('chartavern');
        if (!provider?.importCharacter) throw new Error('CharacterTavern provider not available');

        const charName = charData.name || charData.path.split('/').pop() || '';
        const charCreator = charData.author || charData.path?.split('/')[0] || '';

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = checkCharacterForDuplicates({
            name: charName,
            creator: charCreator,
            fullPath: charData.path,
            description: charData.characterDescription || '',
            first_mes: charData.characterFirstMessage || '',
            personality: charData.characterPersonality || '',
            scenario: charData.characterScenario || ''
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = getAvatarUrl(charData);
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: charData.path,
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
                    console.warn('[CTBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(charData.path, charData, { inheritedGalleryId });
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
        markCardAsImported(charData.path);

    } catch (err) {
        console.error('[CTBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(path) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;
    const card = grid.querySelector(`[data-ct-path="${path}"]`);
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

async function loadTopTags() {
    if (ctTopTagsFetched) return;
    try {
        ctTopTags = await fetchTopTags();
        ctTopTagsFetched = true;
    } catch (e) {
        console.warn('[CTBrowse] Failed to fetch top tags:', e.message);
        ctTopTags = [];
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('ctTagsList');
    if (!container) return;

    if (!ctTopTagsFetched) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const filtered = filter
        ? ctTopTags.filter(t => t.tag.toLowerCase().includes(filter.toLowerCase()))
        : ctTopTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(({ tag, count }) => {
        const isIncluded = ctIncludeTags.has(tag);
        const isExcluded = ctExcludeTags.has(tag);
        let stateClass, stateIcon, stateTitle;

        if (isIncluded) {
            stateClass = 'state-include';
            stateIcon = '<i class="fa-solid fa-plus"></i>';
            stateTitle = 'Included — click to exclude';
        } else if (isExcluded) {
            stateClass = 'state-exclude';
            stateIcon = '<i class="fa-solid fa-minus"></i>';
            stateTitle = 'Excluded — click to clear';
        } else {
            stateClass = 'state-neutral';
            stateIcon = '';
            stateTitle = 'Click to include';
        }

        return `
            <div class="browse-tag-filter-item" data-tag-name="${escapeHtml(tag)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag)}</span>
                <span class="tag-count">${formatNumber(count)}</span>
            </div>
        `;
    }).join('');

    // Bind click handlers on tag items
    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagName = item.dataset.tagName;
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            // Cycle: neutral → include → exclude → neutral
            if (ctIncludeTags.has(tagName)) {
                ctIncludeTags.delete(tagName);
                ctExcludeTags.add(tagName);
            } else if (ctExcludeTags.has(tagName)) {
                ctExcludeTags.delete(tagName);
            } else {
                ctIncludeTags.add(tagName);
            }
            cycleTagState(stateBtn, tagName);
            updateCtTagsButton();
            ctCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

function cycleTagState(btn, tagName) {
    btn.className = 'browse-tag-state-btn';
    if (ctIncludeTags.has(tagName)) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included — click to exclude';
    } else if (ctExcludeTags.has(tagName)) {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded — click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateCtTagsButton() {
    const btn = document.getElementById('ctTagsBtn');
    const label = document.getElementById('ctTagsBtnLabel');
    if (!btn) return;

    const count = ctIncludeTags.size + ctExcludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateCtFiltersButton() {
    const btn = document.getElementById('ctFiltersBtn');
    if (!btn) return;

    const active = ctFilterHideOwned || ctFilterHasLorebook || ctFilterIsOC;
    btn.classList.toggle('has-filters', active);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;
let _dropdownCloseHandler = null;

function initCtView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Convert native selects to styled custom dropdowns
    const sortEl = document.getElementById('ctSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('ctGrid');
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
            const path = card.dataset.ctPath;
            if (!path) return;
            const hit = ctCharacters.find(c => c.path === path);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('ctSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('ctSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('ctSearchBtn', 'click', () => doSearch());
    on('ctClearSearchBtn', 'click', () => {
        const input = document.getElementById('ctSearchInput');
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        ctCurrentSearch = '';
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Load More
    on('ctLoadMoreBtn', 'click', () => {
        ctCurrentPage++;
        loadCharacters(true);
    });

    // NSFW toggle
    on('ctNsfwToggle', 'click', () => {
        ctNsfwEnabled = !ctNsfwEnabled;
        updateNsfwToggle();
        ctCurrentPage = 1;
        loadCharacters(false);
    });
    updateNsfwToggle();

    // Sort mode
    on('ctSortSelect', 'change', () => {
        const el = document.getElementById('ctSortSelect');
        if (el) ctSortMode = el.value;
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Refresh
    on('ctRefreshBtn', 'click', () => {
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('ctTagsDropdown');

    on('ctTagsBtn', 'click', async (e) => {
        e.stopPropagation();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
        // Lazy-load tags on first open
        if (!ctTopTagsFetched) {
            await loadTopTags();
            renderTagsList();
        }
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('ctTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('ctTagsClearBtn', 'click', () => {
        ctIncludeTags.clear();
        ctExcludeTags.clear();
        renderTagsList(document.getElementById('ctTagsSearchInput')?.value || '');
        updateCtTagsButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => {
        ctCurrentPage = 1;
        loadCharacters(false);
    }, 500);

    on('ctMinTokens', 'change', () => {
        const el = document.getElementById('ctMinTokens');
        if (el) ctMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('ctMaxTokens', 'change', () => {
        const el = document.getElementById('ctMaxTokens');
        if (el) ctMaxTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });

    // ── Features dropdown ──
    const filtersDropdown = document.getElementById('ctFiltersDropdown');

    on('ctFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('ctFilterHasLorebook', 'change', () => {
        const el = document.getElementById('ctFilterHasLorebook');
        if (el) ctFilterHasLorebook = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterIsOC', 'change', () => {
        const el = document.getElementById('ctFilterIsOC');
        if (el) ctFilterIsOC = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterHideOwned', 'change', () => {
        const el = document.getElementById('ctFilterHideOwned');
        if (el) ctFilterHideOwned = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Close dropdowns when clicking outside (uses .contains() — works after mobile relocation to body)
    if (_dropdownCloseHandler) document.removeEventListener('click', _dropdownCloseHandler);
    _dropdownCloseHandler = (e) => {
        const tagsBtn = document.getElementById('ctTagsBtn');
        if (tagsDropdown && !tagsDropdown.classList.contains('hidden')) {
            if (!tagsDropdown.contains(e.target) && e.target !== tagsBtn && !tagsBtn?.contains(e.target)) {
                tagsDropdown.classList.add('hidden');
            }
        }
        const filtersBtn = document.getElementById('ctFiltersBtn');
        if (filtersDropdown && !filtersDropdown.classList.contains('hidden')) {
            if (!filtersDropdown.contains(e.target) && e.target !== filtersBtn && !filtersBtn?.contains(e.target)) {
                filtersDropdown.classList.add('hidden');
            }
        }
    };
    document.addEventListener('click', _dropdownCloseHandler);

    // ── Preview modal events (attached once — modal DOM persists across provider switches) ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        on('ctCharClose', 'click', () => closePreviewModal());

        // Avatar click → full-size image viewer (desktop only; mobile has its own handler)
        const ctAvatar = document.getElementById('ctCharAvatar');
        if (ctAvatar && !window.matchMedia('(max-width: 768px)').matches) {
            ctAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!ctAvatar.src || ctAvatar.src.endsWith('/img/ai4.png')) return;
                // Strip CDN resize params to get original full-size PNG
                const fullSrc = ctAvatar.src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
                BrowseView.openAvatarViewer(fullSrc, ctAvatar.src);
            });
        }

        on('ctImportBtn', 'click', () => {
            if (ctSelectedChar) importCharacter(ctSelectedChar);
        });

        const modalOverlay = document.getElementById('ctCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }
    }
}

function doSearch() {
    const input = document.getElementById('ctSearchInput');
    const clearBtn = document.getElementById('ctClearSearchBtn');
    const val = (input?.value || '').trim();

    ctCurrentSearch = val;
    ctCurrentPage = 1;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    loadCharacters(false);
}

function filterByAuthor(authorName) {
    ctCurrentSearch = authorName;
    ctCurrentPage = 1;

    const input = document.getElementById('ctSearchInput');
    if (input) input.value = authorName;

    const clearBtn = document.getElementById('ctClearSearchBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !authorName);

    // Close preview modal if open
    const modal = document.getElementById('ctCharModal');
    if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
        ctSelectedChar = null;
    }

    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('ctNsfwToggle');
    if (!btn) return;

    if (ctNsfwEnabled) {
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

class ChartavernBrowseView extends BrowseView {

    get previewModalId() { return 'ctCharModal'; }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'ctSortSelect',
            tags: 'ctTagsBtn',
            filters: 'ctFiltersBtn',
            nsfw: 'ctNsfwToggle',
            refresh: 'ctRefreshBtn'
        };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="ctSortSelect" class="glass-select" title="Sort order">
                    <option value="most_popular" selected>🔥 Most Popular</option>
                    <option value="trending">📈 Trending</option>
                    <option value="newest">🆕 Newest</option>
                    <option value="oldest">🕐 Oldest</option>
                    <option value="most_likes">❤️ Most Liked</option>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="ctTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="ctTagsBtnLabel">Tags</span>
                </button>
                <div id="ctTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="text" id="ctTagsSearchInput" placeholder="Search tags...">
                        <button id="ctTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="ctTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="ctMinTokens" class="glass-input-small" value="0" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="ctMaxTokens" class="glass-input-small" value="0" min="0" max="500000" step="1000" placeholder="No limit">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="ctFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> Features
                </button>
                <div id="ctFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterHasLorebook"> <i class="fa-solid fa-book"></i> Lorebook</label>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterIsOC"> <i class="fa-solid fa-star"></i> Original Character</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="ctNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="ctRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="ctBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="text" id="ctSearchInput" placeholder="Search CharacterTavern characters...">
                        <button id="ctClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="ctSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="ctGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="ctLoadMore" style="display: none;">
                    <button id="ctLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return `
    <div id="ctCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="ctCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="ctCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="ctCharCreator" href="#" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="ctOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on CharacterTavern">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="ctImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="ctCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="ctCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="ctCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="ctCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="ctCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-heart"></i>
                            <span id="ctCharLikes">0</span> likes
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="ctCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="ctCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="ctCharGreetingsCount">0</span> greetings
                        </div>
                    </div>
                    <div class="browse-char-tags" id="ctCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="ctCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="ctCharCreatorNotes" class="scrolling-text">
                        No description available.
                    </div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="ctCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="ctCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="ctCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="ctCharScenario" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="ctCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="ctCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="ctCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="ctCharAltGreetingsCount"></span>
                    </h3>
                    <div id="ctCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section" id="ctCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                    </h3>
                    <div id="ctCharExamples" class="scrolling-text"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    init() {
        super.init();
        buildLocalLibraryLookup();
        initCtView();
        setupImageObserver();
        loadCharacters(false);
    }

    activate(container, options = {}) {
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized) {
            delegatesInitialized = true;
            buildLocalLibraryLookup();
            setupImageObserver();
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    rebuildLocalLibraryLookup() {
        buildLocalLibraryLookup();
    }

    refreshInLibraryBadges() {
        const grid = document.getElementById('ctGrid');
        if (!grid) return;
        for (const card of grid.querySelectorAll('.browse-card:not(.in-library)')) {
            const path = card.dataset.ctPath;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            if (isCharInLocalLibrary({ path, name })) {
                markCardAsImported(path || name);
            }
        }
    }

    deactivate() {
        delegatesInitialized = false;
        if (_dropdownCloseHandler) {
            document.removeEventListener('click', _dropdownCloseHandler);
            _dropdownCloseHandler = null;
        }
        if (ctImageObserver) ctImageObserver.disconnect();
    }

    // ── Image Observer (BrowseView contract) ────────────────

    disconnectImageObserver() {
        if (ctImageObserver) ctImageObserver.disconnect();
    }

    reconnectImageObserver() {
        reconnectCtObserver();
    }
}

const chartavernBrowseView = new ChartavernBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openCtCharPreview = function(hit) {
    openPreviewModal(hit);
};

export default chartavernBrowseView;
