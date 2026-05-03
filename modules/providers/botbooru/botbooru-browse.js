// BotBooruBrowseView -- BotBooru public browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    checkBotbooruPluginAvailable,
    clearBotbooruToken,
    fetchBotbooruCardJson,
    fetchBotbooruFavoriteState,
    fetchBotbooruFavorites,
    fetchBotbooruPost,
    fetchBotbooruPosts,
    getBotbooruPostUrl,
    setBotbooruToken,
    toggleBotbooruFavorite,
    validateBotbooruSession,
} from './botbooru-api.js';

const {
    showToast,
    getSetting,
    setSetting,
    escapeHtml,
    showPreImportDuplicateWarning,
    showImportSummaryModal,
    getCharacterGalleryId,
    getProviderExcludeTags,
} = CoreAPI;

const PAGE_SIZE = 48;
const DEFAULT_SORT = 'latest';
const SORT_OPTIONS = [
    { value: 'latest', label: '🆕 Newest' },
    { value: 'favorites', label: '❤️ Most Favorited' },
    { value: 'views', label: '👁️ Most Viewed' },
    { value: 'downloads', label: '📥 Most Downloaded' },
    { value: 'curated', label: '⭐ Curated' },
    { value: 'random', label: '🎲 Random' },
];

let botbooruCharacters = [];
let botbooruOffset = 0;
let botbooruTotal = 0;
let botbooruHasMore = true;
let botbooruLoading = false;
let botbooruFilterHideOwned = false;
let botbooruFilterHidePossible = false;
let botbooruLoadToken = 0;
let botbooruSelectedChar = null;
let botbooruViewMode = 'browse';
let botbooruSort = DEFAULT_SORT;
let botbooruSearch = '';
let botbooruNsfw = true;
let botbooruPluginOk = false;
let botbooruToken = null;
let botbooruTokenSynced = false;
let view;

function safe(value) {
    return escapeHtml?.(String(value ?? '')) ?? String(value ?? '');
}

function on(id, event, handler, options) {
    document.getElementById(id)?.addEventListener(event, handler, options);
}

function isBotbooruLinked(char, id) {
    const botbooru = char?.data?.extensions?.botbooru || char?.extensions?.botbooru;
    if (!botbooru) return false;
    const wanted = String(id);
    return [botbooru.id, botbooru.fullPath, botbooru.full_path]
        .filter(value => value != null)
        .some(value => String(value) === wanted);
}

function isCharInLocalLibrary(char) {
    const id = String(char?.id || char?.fullPath || '');
    if (id && view?._lookup.byProviderId.has(id)) return true;

    const name = String(char?.name || '').toLowerCase().trim();
    const creator = String(char?.creator || '').toLowerCase().trim();
    return !!(name && creator && view?._lookup.byNameAndCreator.has(`${name}|${creator}`));
}

function isCharPossibleMatch(char) {
    return !isCharInLocalLibrary(char) && !!view?.isCharPossibleMatch(char?.name || '', char?.creator || '');
}

function getProvider() {
    return CoreAPI.getProvider?.('botbooru');
}

function getGrid() {
    return document.getElementById('botbooruGrid');
}

function buildSortOptionsHtml(selected = botbooruSort) {
    return SORT_OPTIONS
        .map(option => `<option value="${safe(option.value)}" ${option.value === selected ? 'selected' : ''}>${safe(option.label)}</option>`)
        .join('');
}

function applyPersistentExcludeTags(characters) {
    const excluded = getProviderExcludeTags?.('botbooru') || [];
    if (!excluded.length) return characters;

    const lowerExcluded = excluded.map(tag => String(tag).trim().toLowerCase()).filter(Boolean);
    if (!lowerExcluded.length) return characters;

    return characters.filter(char => {
        const tags = (char.tags || []).map(tag => String(tag).toLowerCase());
        return !lowerExcluded.some(excludedTag => tags.includes(excludedTag));
    });
}

function updateResultCount() {
    const el = document.getElementById('botbooruResultCount');
    if (!el) return;
    if (botbooruLoading && botbooruCharacters.length === 0) {
        el.textContent = 'Loading BotBooru...';
        return;
    }
    const shown = botbooruCharacters.length;
    const total = botbooruTotal || shown;
    el.textContent = shown
        ? `${formatNumber(shown)} of ${formatNumber(total)} results`
        : 'No results';
}

function updateLoadMore() {
    botbooruBrowseView.updateLoadMoreVisibility('botbooruLoadMore', botbooruHasMore, botbooruCharacters.length > 0);
}

function setLoadingGrid(message = 'Loading BotBooru...') {
    const grid = getGrid();
    if (!grid) return;
    grid.innerHTML = `
        <div class="browse-loading-overlay botbooru-state" style="grid-column: 1 / -1;">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <p>${safe(message)}</p>
        </div>
    `;
    updateResultCount();
    updateLoadMore();
}

function renderEmptyState(message, icon = 'fa-solid fa-magnifying-glass', actionHtml = '') {
    const grid = getGrid();
    if (!grid) return;
    grid.innerHTML = `
        <div class="botbooru-empty-state" style="grid-column: 1 / -1;">
            <i class="${safe(icon)}"></i>
            <p>${safe(message)}</p>
            ${actionHtml}
        </div>
    `;
    updateResultCount();
    updateLoadMore();
}

function renderPluginMissingState() {
    renderEmptyState(
        'The cl-helper server plugin is required for BotBooru browsing.',
        'fa-solid fa-plug-circle-xmark'
    );
}

function renderFavoritesTokenState(message = 'My Favorites requires a BotBooru bearer token.') {
    renderEmptyState(
        message,
        'fa-regular fa-heart',
        `<button class="glass-btn botbooru-open-token-btn" type="button">
            <i class="fa-solid fa-key"></i> Add Token
        </button>`
    );
}

function renderBotbooruCard(char) {
    const id = String(char.id || char.fullPath || '');
    const name = char.name || `BotBooru ${id}`;
    const creator = char.creator || 'Unknown';
    const tags = (char.tags || []).slice(0, 4);
    const imageUrl = char.avatar_url || char.image_url || '/img/ai4.png';
    const rating = String(char.rating || '').toLowerCase();
    const inLibrary = isCharInLocalLibrary(char);
    const possibleMatch = isCharPossibleMatch(char);

    const featureBadges = [];
    if (inLibrary) {
        featureBadges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        featureBadges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    }

    const ratingBadge = rating === 'nsfl'
        ? '<span class="browse-nsfw-badge botbooru-nsfl-badge">NSFL</span>'
        : rating === 'nsfw'
            ? '<span class="browse-nsfw-badge">NSFW</span>'
            : '';

    const cardClass = inLibrary
        ? 'browse-card botbooru-card in-library'
        : possibleMatch
            ? 'browse-card botbooru-card possible-library'
            : 'browse-card botbooru-card';

    return `
        <div class="${cardClass}" data-botbooru-id="${safe(id)}" title="${safe(name)}">
            <div class="browse-card-image">
                <img data-src="${safe(imageUrl)}" src="${IMG_PLACEHOLDER}" alt="${safe(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${featureBadges.length ? `<div class="browse-feature-badges">${featureBadges.join('')}</div>` : ''}
                ${ratingBadge}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${safe(name)}</div>
                <span class="browse-card-creator-link" data-author="${safe(creator)}">${safe(creator)}</span>
                <div class="browse-card-tags">
                    ${tags.map(tag => `<span class="browse-card-tag" title="${safe(tag)}">${safe(tag)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Views"><i class="fa-solid fa-eye"></i> ${formatNumber(char.views || 0)}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(char.downloads || 0)}</span>
                <span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${formatNumber(char.favorites || 0)}</span>
            </div>
        </div>
    `;
}

function renderBotbooruGrid() {
    const grid = getGrid();
    if (!grid) return;

    if (botbooruCharacters.length === 0) {
        renderEmptyState(botbooruViewMode === 'favorites' ? 'No BotBooru favorites found.' : 'No BotBooru characters found.');
        return;
    }

    let filtered = botbooruCharacters;
    if (botbooruFilterHideOwned) filtered = filtered.filter(c => !isCharInLocalLibrary(c));
    if (botbooruFilterHidePossible) filtered = filtered.filter(c => !isCharPossibleMatch(c));

    if (filtered.length === 0) {
        renderEmptyState('All characters hidden by filters.', 'fa-solid fa-filter');
        return;
    }

    grid.innerHTML = filtered.map(renderBotbooruCard).join('');
    botbooruBrowseView.observeImages(grid);
    botbooruBrowseView.refreshInLibraryBadges();
    updateResultCount();
    updateLoadMore();
}

function syncFilterCheckboxState() {
    const favCb = document.getElementById('botbooruFilterFavorites');
    const ownedCb = document.getElementById('botbooruFilterHideOwned');
    const possibleCb = document.getElementById('botbooruFilterHidePossible');
    if (favCb) favCb.checked = botbooruViewMode === 'favorites';
    if (ownedCb) ownedCb.checked = botbooruFilterHideOwned;
    if (possibleCb) possibleCb.checked = botbooruFilterHidePossible;
}

function setFavoriteButtonState(favorited, count) {
    const favoriteBtn = document.getElementById('botbooruFavoriteBtn');
    const favoriteCountEl = document.getElementById('botbooruCharFavorites');
    if (favoriteCountEl && count != null) favoriteCountEl.textContent = formatNumber(count);
    if (!favoriteBtn) return;

    favoriteBtn.classList.toggle('favorited', !!favorited);
    const icon = favoriteBtn.querySelector('i');
    if (icon) icon.className = favorited ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    favoriteBtn.title = favorited ? 'Remove from BotBooru favorites' : 'Add to BotBooru favorites';
}

function getCardPreviewText(char, keys) {
    for (const key of keys) {
        const value = key.split('.').reduce((obj, part) => obj?.[part], char);
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function renderPreviewSections(char) {
    const description = getCardPreviewText(char, ['description', 'data.description', 'data.personality', 'personality']);
    const firstMessage = getCardPreviewText(char, ['first_message', 'first_mes', 'data.first_message', 'data.first_mes']);

    const descSection = document.getElementById('botbooruCharDescriptionSection');
    const descEl = document.getElementById('botbooruCharDescription');
    if (descSection && descEl) {
        descSection.style.display = description ? '' : 'none';
        descEl.textContent = description;
    }

    const firstSection = document.getElementById('botbooruCharFirstMsgSection');
    const firstEl = document.getElementById('botbooruCharFirstMsg');
    if (firstSection && firstEl) {
        firstSection.style.display = firstMessage ? '' : 'none';
        firstEl.textContent = firstMessage;
    }
}

function applyCardPreviewData(char, card) {
    if (!char || !card?.data) return;
    char.data = { ...(char.data || {}), ...card.data };
    char.description = char.description || card.data.description || card.data.personality || '';
    char.first_mes = char.first_mes || card.data.first_mes || card.data.first_message || '';
    if ((!char.name || /^BotBooru\s+\d+/i.test(char.name)) && card.data.name) char.name = card.data.name;
    if ((!char.creator || char.creator === 'Unknown') && card.data.creator) char.creator = card.data.creator;
    char._cardLoaded = true;
}

async function loadBotbooruCardPreviewData(char) {
    if (!char?.id || char._cardLoaded) return char;
    const card = await fetchBotbooruCardJson(char.id);
    applyCardPreviewData(char, card);
    return char;
}

async function refreshSelectedFavoriteState() {
    if (!botbooruSelectedChar?.id) return;
    try {
        const state = await fetchBotbooruFavoriteState(botbooruSelectedChar.id);
        botbooruSelectedChar.favorites = state.count;
        botbooruSelectedChar._isFavorited = state.favorited;
        setFavoriteButtonState(state.favorited, state.count);
    } catch (err) {
        CoreAPI.debugLog?.('[BotBooru] Favorite state unavailable:', err.message);
        setFavoriteButtonState(false, botbooruSelectedChar.favorites || 0);
    }
}

async function openBotbooruCharPreview(char) {
    if (!char) return;
    botbooruSelectedChar = char;

    const modal = document.getElementById('botbooruCharModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const id = char.id || char.fullPath;
    const nameEl = document.getElementById('botbooruCharName');
    const creatorEl = document.getElementById('botbooruCharCreator');
    const avatarEl = document.getElementById('botbooruCharAvatar');
    const openBtn = document.getElementById('botbooruOpenInBrowserBtn');
    const tagsEl = document.getElementById('botbooruCharTags');

    if (nameEl) nameEl.textContent = char.name || `BotBooru ${id}`;
    if (creatorEl) creatorEl.textContent = char.creator || 'Unknown';
    if (avatarEl) avatarEl.src = char.image_url || char.avatar_url || '/img/ai4.png';
    if (openBtn) openBtn.href = char.page_url || getBotbooruPostUrl(id);
    if (tagsEl) {
        tagsEl.innerHTML = (char.tags || [])
            .slice(0, 18)
            .map(tag => `<span class="browse-card-tag">${safe(tag)}</span>`)
            .join('');
    }

    const viewsEl = document.getElementById('botbooruCharViews');
    const downloadsEl = document.getElementById('botbooruCharDownloads');
    if (viewsEl) viewsEl.textContent = formatNumber(char.views || 0);
    if (downloadsEl) downloadsEl.textContent = formatNumber(char.downloads || 0);
    setFavoriteButtonState(char._isFavorited, char.favorites || 0);
    renderPreviewSections(char);

    try {
        const detail = char._detailLoaded ? char : await fetchBotbooruPost(id);
        if (detail && botbooruSelectedChar === char) {
            Object.assign(char, detail, { _detailLoaded: true });
            if (nameEl) nameEl.textContent = char.name || `BotBooru ${id}`;
            if (creatorEl) creatorEl.textContent = char.creator || 'Unknown';
            if (avatarEl) avatarEl.src = char.image_url || char.avatar_url || '/img/ai4.png';
            if (openBtn) openBtn.href = char.page_url || getBotbooruPostUrl(id);
            if (viewsEl) viewsEl.textContent = formatNumber(char.views || 0);
            if (downloadsEl) downloadsEl.textContent = formatNumber(char.downloads || 0);
            renderPreviewSections(char);
        }
    } catch (err) {
        CoreAPI.debugLog?.('[BotBooru] Detail fetch failed:', err.message);
    }

    try {
        await loadBotbooruCardPreviewData(char);
        if (botbooruSelectedChar === char) {
            if (nameEl) nameEl.textContent = char.name || `BotBooru ${id}`;
            if (creatorEl) creatorEl.textContent = char.creator || 'Unknown';
            renderPreviewSections(char);
        }
    } catch (err) {
        CoreAPI.debugLog?.('[BotBooru] Card preview fetch failed:', err.message);
    }

    refreshSelectedFavoriteState();
}

function closePreviewModal() {
    document.getElementById('botbooruCharModal')?.classList.add('hidden');
    botbooruSelectedChar = null;
}

async function getDuplicateMatches(char) {
    const candidate = {
        name: char.name || '',
        creator: char.creator || '',
        fullPath: String(char.id || char.fullPath || ''),
        description: getCardPreviewText(char, ['description', 'data.description', 'data.personality', 'personality']),
        first_mes: getCardPreviewText(char, ['first_message', 'first_mes', 'data.first_message', 'data.first_mes']),
    };

    if (typeof CoreAPI.findDuplicateCharacters === 'function') {
        return await CoreAPI.findDuplicateCharacters(candidate);
    }
    if (typeof CoreAPI.checkCharacterForDuplicatesAsync === 'function') {
        return await CoreAPI.checkCharacterForDuplicatesAsync(candidate);
    }
    return [];
}

async function importSelectedBotbooruCharacter() {
    if (!botbooruSelectedChar) return;

    const importBtn = document.getElementById('botbooruImportBtn');
    const originalHtml = importBtn?.innerHTML;
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
    }

    try {
        const provider = getProvider();
        if (!provider?.importCharacter) throw new Error('BotBooru provider not available');

        await loadBotbooruCardPreviewData(botbooruSelectedChar).catch(err => {
            CoreAPI.debugLog?.('[BotBooru] Duplicate check card fetch skipped:', err.message);
        });

        let inheritedGalleryId = null;
        const duplicateMatches = await getDuplicateMatches(botbooruSelectedChar);
        if (duplicateMatches.length > 0 && typeof showPreImportDuplicateWarning === 'function') {
            const result = await showPreImportDuplicateWarning({
                name: botbooruSelectedChar.name || '',
                creator: botbooruSelectedChar.creator || '',
                fullPath: String(botbooruSelectedChar.id || botbooruSelectedChar.fullPath || ''),
                avatarUrl: botbooruSelectedChar.avatar_url || botbooruSelectedChar.image_url || '/img/ai4.png',
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast?.('Import cancelled', 'info');
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0]?.char;
                inheritedGalleryId = getCharacterGalleryId?.(toReplace) || null;
                if (typeof CoreAPI.deleteCharacter === 'function' && toReplace) {
                    if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                    const deleteSuccess = await CoreAPI.deleteCharacter(toReplace, false);
                    if (!deleteSuccess) throw new Error('Failed to remove duplicate before replacement');
                }
            }
        }

        const result = await provider.importCharacter(botbooruSelectedChar.id, botbooruSelectedChar, { inheritedGalleryId });
        if (!result?.success) throw new Error(result?.error || 'Import failed');

        closePreviewModal();
        showToast?.(`Imported "${result.characterName}" from BotBooru`, 'success');

        if (getSetting?.('notifyAdditionalContent') !== false && (result.hasGallery || result.embeddedMediaUrls?.length || result.galleryPageUrls?.length)) {
            showImportSummaryModal?.({
                galleryCharacters: result.hasGallery ? [{
                    name: result.characterName,
                    fullPath: result.fullPath,
                    provider,
                    linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                    url: getBotbooruPostUrl(result.providerCharId),
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                }] : [],
                mediaCharacters: (result.embeddedMediaUrls?.length || result.galleryPageUrls?.length) ? [{
                    name: result.characterName,
                    avatar: result.fileName,
                    avatarUrl: result.avatarUrl,
                    mediaUrls: result.embeddedMediaUrls || [],
                    galleryPageUrls: result.galleryPageUrls || [],
                    galleryId: result.galleryId,
                    cardData: result.cardData,
                }] : [],
            });
        }

        if (typeof CoreAPI.fetchAndAddCharacter === 'function') {
            const added = await CoreAPI.fetchAndAddCharacter(result.fileName);
            if (!added) await CoreAPI.fetchCharacters?.(true);
        } else {
            await CoreAPI.fetchCharacters?.(true);
        }
        view?.buildLocalLibraryLookup();
        botbooruBrowseView.refreshInLibraryBadges();
    } catch (err) {
        console.error('[BotBooru] Import failed:', err);
        showToast?.(`BotBooru import failed: ${err.message}`, 'error');
    } finally {
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = originalHtml || '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

async function toggleSelectedFavorite() {
    if (!botbooruSelectedChar) return;
    if (!botbooruToken) {
        openBotbooruTokenModal();
        return;
    }

    const favoriteBtn = document.getElementById('botbooruFavoriteBtn');
    favoriteBtn?.classList.add('loading');

    try {
        await syncSavedTokenToHelper();
        const state = await toggleBotbooruFavorite(botbooruSelectedChar.id);
        botbooruSelectedChar.favorites = state.count;
        botbooruSelectedChar._isFavorited = state.favorited;
        setFavoriteButtonState(state.favorited, state.count);
        showToast?.(state.favorited ? 'Added to BotBooru favorites' : 'Removed from BotBooru favorites', state.favorited ? 'success' : 'info');
        if (botbooruViewMode === 'favorites' && !state.favorited) {
            botbooruCharacters = botbooruCharacters.filter(char => String(char.id) !== String(botbooruSelectedChar.id));
            renderBotbooruGrid();
        }
    } catch (err) {
        showToast?.(`Favorite update failed: ${err.message}`, 'error');
        if (/token|invalid|expired|401/i.test(err.message)) openBotbooruTokenModal();
    } finally {
        favoriteBtn?.classList.remove('loading');
    }
}

function openBotbooruTokenModal() {
    const modal = document.getElementById('botbooruTokenModal');
    const input = document.getElementById('botbooruTokenInput');
    const status = document.getElementById('botbooruTokenStatus');
    if (input) input.value = botbooruToken || getSetting?.('botbooruToken') || '';
    if (status) status.textContent = 'Token is optional and only used for favorites.';
    modal?.classList.remove('hidden');
    input?.focus();
}

async function saveBotbooruTokenFromModal() {
    const input = document.getElementById('botbooruTokenInput');
    const status = document.getElementById('botbooruTokenStatus');
    const saveBtn = document.getElementById('botbooruSaveTokenBtn');
    const token = input?.value?.trim() || '';

    if (!token) {
        showToast?.('Paste a BotBooru token to enable favorites', 'info');
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Validating...';
    }
    if (status) status.textContent = 'Validating token...';

    try {
        const result = await validateBotbooruSession(token);
        if (!result?.valid) throw new Error(result?.reason || 'Invalid token');
        botbooruToken = token;
        setSetting?.('botbooruToken', token);
        await setBotbooruToken(token);
        botbooruTokenSynced = true;
        document.getElementById('botbooruTokenModal')?.classList.add('hidden');
        showToast?.('BotBooru token saved', 'success');
        if (botbooruViewMode === 'favorites') loadBotbooruCharacters({ reset: true });
        if (botbooruSelectedChar) refreshSelectedFavoriteState();
    } catch (err) {
        if (status) status.textContent = `Validation failed: ${err.message}`;
        showToast?.(`BotBooru token failed: ${err.message}`, 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Token';
        }
    }
}

async function clearBotbooruTokenFromModal() {
    botbooruToken = null;
    botbooruTokenSynced = false;
    setSetting?.('botbooruToken', null);
    await clearBotbooruToken().catch(err => CoreAPI.debugLog?.('[BotBooru] Token clear failed:', err.message));
    const input = document.getElementById('botbooruTokenInput');
    const status = document.getElementById('botbooruTokenStatus');
    if (input) input.value = '';
    if (status) status.textContent = 'Token cleared. Public browsing remains available.';
    showToast?.('BotBooru token cleared', 'success');
    if (botbooruViewMode === 'favorites') loadBotbooruCharacters({ reset: true });
}

async function setBotbooruSessionToken(token) {
    const result = await validateBotbooruSession(token);
    if (!result?.valid) throw new Error(result?.reason || 'Invalid BotBooru token');
    botbooruToken = token;
    botbooruTokenSynced = true;
    setSetting?.('botbooruToken', token);
    return true;
}

async function clearBotbooruSession() {
    botbooruToken = null;
    botbooruTokenSynced = false;
    setSetting?.('botbooruToken', null);
    return await clearBotbooruToken();
}

async function ensurePluginAvailable() {
    botbooruPluginOk = await checkBotbooruPluginAvailable();
    return botbooruPluginOk;
}

async function syncSavedTokenToHelper() {
    if (!botbooruToken || botbooruTokenSynced) return;
    const result = await validateBotbooruSession(botbooruToken);
    if (!result?.valid) {
        botbooruTokenSynced = false;
        await clearBotbooruToken().catch(err => CoreAPI.debugLog?.('[BotBooru] Invalid token cleanup failed:', err.message));
        throw new Error(result?.reason || 'BotBooru token is invalid or expired');
    }
    botbooruTokenSynced = true;
}

async function loadBotbooruCharacters({ reset = false } = {}) {
    if (botbooruLoading) return;
    if (reset) {
        botbooruOffset = 0;
        botbooruHasMore = true;
        botbooruTotal = 0;
        botbooruCharacters = [];
    }

    if (botbooruViewMode === 'favorites' && !botbooruToken) {
        botbooruCharacters = [];
        botbooruHasMore = false;
        renderFavoritesTokenState();
        return;
    }

    const token = ++botbooruLoadToken;
    botbooruLoading = true;
    if (reset) setLoadingGrid(botbooruViewMode === 'favorites' ? 'Loading BotBooru favorites...' : 'Loading BotBooru...');

    const loadMoreBtn = document.getElementById('botbooruLoadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        if (!(await ensurePluginAvailable())) {
            if (token === botbooruLoadToken) renderPluginMissingState();
            return;
        }

        if (botbooruViewMode === 'favorites') {
            await syncSavedTokenToHelper();
        }

        const params = {
            limit: PAGE_SIZE,
            offset: botbooruOffset,
            q: botbooruSearch,
            sfwOnly: !botbooruNsfw,
        };
        const data = botbooruViewMode === 'favorites'
            ? await fetchBotbooruFavorites(params)
            : await fetchBotbooruPosts({ ...params, sort: botbooruSort });

        if (token !== botbooruLoadToken) return;

        const rawPosts = data.posts || [];
        const posts = applyPersistentExcludeTags(rawPosts);
        botbooruCharacters = reset ? posts : botbooruCharacters.concat(posts);
        botbooruTotal = data.total || botbooruCharacters.length;
        botbooruOffset += rawPosts.length;
        botbooruHasMore = botbooruOffset < botbooruTotal && rawPosts.length > 0;
        renderBotbooruGrid();
    } catch (err) {
        if (token !== botbooruLoadToken) return;
        console.error('[BotBooru] Load failed:', err);
        showToast?.(`BotBooru load failed: ${err.message}`, 'error');
        if (botbooruViewMode === 'favorites' && /login|token|401/i.test(err.message)) {
            renderFavoritesTokenState('BotBooru token is invalid or expired. Revalidate or edit it to use My Favorites.');
        } else {
            renderEmptyState(`Load failed: ${err.message}`, 'fa-solid fa-triangle-exclamation');
        }
    } finally {
        if (token === botbooruLoadToken) {
            botbooruLoading = false;
            updateResultCount();
            updateLoadMore();
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

function closeTokenModal() {
    document.getElementById('botbooruTokenModal')?.classList.add('hidden');
}

class BotbooruBrowseView extends BrowseView {
    constructor() {
        super({ id: 'botbooru', name: 'BotBooru' });
        this.importBtnSelector = '#botbooruImportBtn';
        this.gridSelector = '#botbooruGrid';
        this.cardSelector = '.botbooru-card';
        this._listenerController = null;
        view = this;
    }

    get previewModalId() { return 'botbooruCharModal'; }

    get hasModeToggle() { return false; }

    getSettingsConfig() {
        return {
            browseSortOptions: SORT_OPTIONS,
            defaultBrowseSort: DEFAULT_SORT,
        };
    }

    get mobileFilterIds() {
        return {
            sort: 'botbooruSortSelect',
            tags: null,
            filters: 'botbooruFiltersBtn',
            nsfw: 'botbooruNsfwToggle',
            refresh: 'botbooruRefreshBtn',
        };
    }

    _getImageGridIds() { return ['botbooruGrid']; }

    _extractProviderIds(char, idSet) {
        const botbooru = char?.data?.extensions?.botbooru || char?.extensions?.botbooru;
        if (!botbooru) return;
        for (const id of [botbooru.id, botbooru.fullPath, botbooru.full_path]) {
            if (id != null) idSet.add(String(id));
        }
    }

    canLoadMore() {
        return botbooruHasMore && !botbooruLoading;
    }

    loadMore() {
        return loadBotbooruCharacters({ reset: false });
    }

    renderFilterBar() {
        return `
            <div class="browse-sort-container">
                <select id="botbooruSortSelect" class="glass-select" title="Sort order">
                    ${buildSortOptionsHtml()}
                </select>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="botbooruFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="botbooruFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Personal <span style="font-size: 0.8em; opacity: 0.6;">(requires token)</span>:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterFavorites"> <i class="fa-solid fa-heart" style="color: #e74c3c;"></i> My Favorites</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="botbooruFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <button id="botbooruNsfwToggle" class="glass-btn nsfw-toggle active" type="button" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>NSFW</span>
            </button>
            <button id="botbooruRefreshBtn" class="glass-btn icon-only" type="button" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    renderView() {
        return `
            <div id="botbooruBrowseSection" class="browse-section">
                <div class="browse-search-bar botbooru-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="botbooruSearchInput" placeholder="Search BotBooru..." autocomplete="one-time-code">
                        <button id="botbooruClearSearchBtn" class="browse-search-clear" title="Clear search" type="button">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="botbooruSearchBtn" class="browse-search-submit" type="button" title="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div id="botbooruResultCount" class="botbooru-result-count">No results</div>
                </div>
                <div id="botbooruGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="botbooruLoadMore" style="display: none;">
                    <button id="botbooruLoadMoreBtn" class="glass-btn" type="button">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    renderModals() {
        return `
    <div id="botbooruCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal botbooru-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="botbooruCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="botbooruCharName">Character Name</h2>
                        <p class="browse-char-meta">by <span id="botbooruCharCreator">Unknown</span></p>
                    </div>
                </div>
                <div class="modal-controls">
                    <button id="botbooruFavoriteBtn" class="action-btn secondary botbooru-favorite-btn" type="button" title="Add to BotBooru favorites">
                        <i class="fa-regular fa-heart"></i>
                    </button>
                    <a id="botbooruOpenInBrowserBtn" href="#" target="_blank" rel="noopener noreferrer" class="action-btn secondary" title="Open on BotBooru">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="botbooruImportBtn" class="action-btn primary" type="button" title="Import to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="botbooruCharClose" type="button">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat"><i class="fa-solid fa-eye"></i> <span id="botbooruCharViews">0</span> views</div>
                        <div class="browse-stat"><i class="fa-solid fa-download"></i> <span id="botbooruCharDownloads">0</span> downloads</div>
                        <div class="browse-stat"><i class="fa-solid fa-heart"></i> <span id="botbooruCharFavorites">0</span> favorites</div>
                    </div>
                    <div class="browse-char-tags" id="botbooruCharTags"></div>
                </div>
                <div class="browse-char-section" id="botbooruCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title"><i class="fa-solid fa-scroll"></i> Description</h3>
                    <div id="botbooruCharDescription" class="scrolling-text"></div>
                </div>
                <div class="browse-char-section" id="botbooruCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title"><i class="fa-solid fa-message"></i> First Message</h3>
                    <div id="botbooruCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>
            </div>
        </div>
    </div>
    <div id="botbooruTokenModal" class="modal-overlay hidden">
        <div class="modal-glass botbooru-token-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> BotBooru Token</h2>
                <button class="close-btn" id="botbooruTokenClose" type="button">&times;</button>
            </div>
            <div class="botbooru-token-body">
                <p id="botbooruTokenStatus" class="botbooru-token-status">Token is optional and only used for favorites.</p>
                <input type="password" id="botbooruTokenInput" class="glass-input" placeholder="Bearer token" autocomplete="off" data-sensitive="true">
                <div class="botbooru-token-actions">
                    <button id="botbooruSaveTokenBtn" class="action-btn primary" type="button">
                        <i class="fa-solid fa-check"></i> Save Token
                    </button>
                    <button id="botbooruClearTokenBtn" class="action-btn secondary danger" type="button">
                        <i class="fa-solid fa-trash-can"></i> Clear
                    </button>
                </div>
            </div>
        </div>
    </div>`;
    }

    applyDefaults(defaults = {}) {
        const nextView = defaults.view === 'favorites' ? 'favorites' : 'browse';
        botbooruViewMode = nextView;
        botbooruSort = defaults.sort || defaults.browseSort || botbooruSort || DEFAULT_SORT;
        const sortEl = document.getElementById('botbooruSortSelect');
        if (sortEl) sortEl.value = botbooruSort;
        syncFilterCheckboxState();
    }

    activate(container, options = {}) {
        const savedToken = getSetting?.('botbooruToken') || null;
        if (savedToken !== botbooruToken) {
            botbooruTokenSynced = false;
        }
        botbooruToken = savedToken;
        botbooruNsfw = getSetting?.('botbooruNsfw') !== false;
        if (options.defaults?.browseSort) botbooruSort = options.defaults.browseSort;
        if (options.domRecreated) {
            botbooruCharacters = [];
            botbooruOffset = 0;
            botbooruTotal = 0;
            botbooruHasMore = true;
            botbooruLoading = false;
            botbooruSelectedChar = null;
        }

        const wasInitialized = this._initialized;
        super.activate(container, options);

        const nsfwBtn = document.getElementById('botbooruNsfwToggle');
        nsfwBtn?.classList.toggle('active', botbooruNsfw);
        const sortEl = document.getElementById('botbooruSortSelect');
        if (sortEl) sortEl.value = botbooruSort;
        syncFilterCheckboxState();

        if (!wasInitialized || options.domRecreated || botbooruCharacters.length === 0) {
            this.buildLocalLibraryLookup();
            loadBotbooruCharacters({ reset: true });
        } else {
            this.reconnectImageObserver();
            this.refreshInLibraryBadges();
        }
    }

    init() {
        super.init();
        const sortEl = document.getElementById('botbooruSortSelect');
        if (sortEl) CoreAPI.initCustomSelect?.(sortEl);
        this._registerDropdownDismiss([
            { dropdownId: 'botbooruFiltersDropdown', buttonId: 'botbooruFiltersBtn' },
        ]);
        this.attachEventListeners();
    }

    attachEventListeners() {
        this._listenerController?.abort();
        this._listenerController = new AbortController();
        const listenerOptions = { signal: this._listenerController.signal };

        on('botbooruFiltersBtn', 'click', (e) => {
            e.stopPropagation();
            document.getElementById('botbooruFiltersDropdown')?.classList.toggle('hidden');
        }, listenerOptions);

        on('botbooruFilterFavorites', 'change', (e) => {
            if (e.target.checked && !botbooruToken) {
                e.target.checked = false;
                openBotbooruTokenModal();
                return;
            }
            botbooruViewMode = e.target.checked ? 'favorites' : 'browse';
            loadBotbooruCharacters({ reset: true });
        }, listenerOptions);

        on('botbooruFilterHideOwned', 'change', (e) => {
            botbooruFilterHideOwned = e.target.checked;
            renderBotbooruGrid();
        }, listenerOptions);

        on('botbooruFilterHidePossible', 'change', (e) => {
            botbooruFilterHidePossible = e.target.checked;
            renderBotbooruGrid();
        }, listenerOptions);

        on('botbooruSortSelect', 'change', e => {
            botbooruSort = e.target.value || DEFAULT_SORT;
            loadBotbooruCharacters({ reset: true });
        }, listenerOptions);
        on('botbooruNsfwToggle', 'click', () => {
            botbooruNsfw = !botbooruNsfw;
            setSetting?.('botbooruNsfw', botbooruNsfw);
            document.getElementById('botbooruNsfwToggle')?.classList.toggle('active', botbooruNsfw);
            loadBotbooruCharacters({ reset: true });
        }, listenerOptions);
        on('botbooruRefreshBtn', 'click', () => loadBotbooruCharacters({ reset: true }), listenerOptions);
        on('botbooruSearchBtn', 'click', () => {
            botbooruSearch = document.getElementById('botbooruSearchInput')?.value?.trim() || '';
            loadBotbooruCharacters({ reset: true });
        }, listenerOptions);
        on('botbooruSearchInput', 'keydown', e => {
            if (e.key === 'Enter') document.getElementById('botbooruSearchBtn')?.click();
        }, listenerOptions);
        on('botbooruClearSearchBtn', 'click', () => {
            const input = document.getElementById('botbooruSearchInput');
            if (input) input.value = '';
            botbooruSearch = '';
            loadBotbooruCharacters({ reset: true });
        }, listenerOptions);
        on('botbooruLoadMoreBtn', 'click', () => loadBotbooruCharacters({ reset: false }), listenerOptions);
        on('botbooruImportBtn', 'click', importSelectedBotbooruCharacter, listenerOptions);
        on('botbooruFavoriteBtn', 'click', toggleSelectedFavorite, listenerOptions);
        on('botbooruCharClose', 'click', closePreviewModal, listenerOptions);
        on('botbooruTokenClose', 'click', closeTokenModal, listenerOptions);
        on('botbooruSaveTokenBtn', 'click', saveBotbooruTokenFromModal, listenerOptions);
        on('botbooruClearTokenBtn', 'click', clearBotbooruTokenFromModal, listenerOptions);

        getGrid()?.addEventListener('click', e => {
            if (e.target.closest('.botbooru-open-token-btn')) {
                openBotbooruTokenModal();
                return;
            }
            const card = e.target.closest('.botbooru-card');
            if (!card) return;
            const id = card.dataset.botbooruId;
            const char = botbooruCharacters.find(item => String(item.id) === String(id));
            if (char) openBotbooruCharPreview(char);
        }, listenerOptions);
    }

    closePreview() {
        closePreviewModal();
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.botbooruId;
            return (CoreAPI.getAllCharacters?.() || []).some(char => isBotbooruLinked(char, id));
        });
    }

    deactivate() {
        botbooruLoadToken++;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const botbooruBrowseView = new BotbooruBrowseView();

window.openBotbooruCharPreview = openBotbooruCharPreview;
window.openBotbooruTokenModal = openBotbooruTokenModal;
window.botbooruValidateSession = validateBotbooruSession;
window.botbooruClearSession = clearBotbooruSession;
window.botbooruSetToken = setBotbooruSessionToken;

export default botbooruBrowseView;
