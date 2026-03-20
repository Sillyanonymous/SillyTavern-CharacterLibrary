import * as CoreAPI from './core-api.js';

function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed'));
        } catch (e) { reject(e); }
        finally { document.body.removeChild(textarea); }
    });
}

let isInitialized = false;
let menuElement = null;
let currentCharacter = null;
let currentCard = null;

export function init(deps) {
    if (isInitialized) {
        console.warn('[ContextMenu] Already initialized');
        return;
    }
    
    createMenu();
    setupGlobalListeners();

    // Bridge for legacy card creation paths
    window.attachCardContextMenu = function(cardElement, char) {
        if (!cardElement || !char) return;
        attachToCard(cardElement, char);
    };
    
    isInitialized = true;
    CoreAPI.debugLog('[ContextMenu] Module initialized');
}

function createMenu() {
    menuElement = document.createElement('div');
    menuElement.id = 'clContextMenu';
    menuElement.className = 'cl-context-menu';
    document.body.appendChild(menuElement);
}

function setupGlobalListeners() {
    document.addEventListener('click', (e) => {
        if (!menuElement.contains(e.target)) {
            hide();
        }
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hide();
        }
    });
    
    document.addEventListener('scroll', () => hide(), true);

    document.addEventListener('cl-extensions-recovered', () => {
        if (menuElement?.classList.contains('visible') && currentCharacter) {
            const menuItems = buildMenuItems(currentCharacter, currentCard);
            renderMenu(menuItems);
        }
    });
    
    // Use event delegation for context menu on character cards
    // This works even for cards created before module loaded
    document.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.char-card');
        if (card) {
            const avatar = card.dataset.avatar;
            if (avatar) {
                const char = CoreAPI.getCharacterByAvatar(avatar);
                if (char) {
                    show(e, char, card);
                }
            }
        }
    });
}

export function show(event, char, cardElement) {
    event.preventDefault();
    event.stopPropagation();
    
    currentCharacter = char;
    currentCard = cardElement;
    
    const menuItems = buildMenuItems(char, cardElement);
    renderMenu(menuItems);
    
    // Force layout for measurement
    menuElement.style.visibility = 'hidden';
    menuElement.classList.add('visible');
    
    positionMenu(event.clientX, event.clientY);
    
    menuElement.style.visibility = '';
}

export function hide() {
    menuElement.classList.remove('visible');
    currentCharacter = null;
    currentCard = null;
}

function buildMenuItems(char, cardElement) {
    const isSelected = CoreAPI.isCharacterSelected(char.avatar);
    const selectionCount = CoreAPI.getSelectionCount();
    
    if (isSelected && selectionCount > 1) {
        return buildBulkMenuItems(selectionCount);
    }
    
    return buildSingleMenuItems(char, cardElement);
}

function buildBulkMenuItems(count) {
    const items = [];
    
    items.push({
        type: 'header',
        label: `${count} Characters Selected`
    });
    
    // Bulk edit tags
    items.push({
        icon: 'fa-solid fa-tags',
        label: 'Edit Tags',
        action: () => {
            const batchTagging = CoreAPI.getModule('batch-tagging');
            if (batchTagging?.openModal) {
                batchTagging.openModal();
            }
        }
    });
    
    // Bulk check for updates (provider-linked only)
    items.push({
        icon: 'fa-solid fa-arrows-rotate',
        label: 'Check for Updates',
        action: () => {
            const cardUpdates = CoreAPI.getModule('card-updates');
            if (cardUpdates?.checkSelectedCharacters) {
                cardUpdates.checkSelectedCharacters();
            }
        }
    });

    // Bulk add to playlist
    items.push({
        icon: 'fa-solid fa-list-ul',
        label: 'Add to Playlist',
        action: () => {
            const avatars = CoreAPI.getSelectedCharacters().map(c => c.avatar);
            if (avatars.length) CoreAPI.openPlaylistPicker(avatars);
        }
    });
    
    items.push({ type: 'separator' });
    
    // Bulk favorite actions
    items.push({
        icon: 'fa-solid fa-star',
        label: 'Add All to Favorites',
        action: () => bulkToggleFavorites(true)
    });
    
    items.push({
        icon: 'fa-regular fa-star',
        label: 'Remove All from Favorites',
        action: () => bulkToggleFavorites(false)
    });
    
    items.push({ type: 'separator' });
    
    // Bulk export
    items.push({
        icon: 'fa-solid fa-download',
        label: 'Export All',
        action: () => bulkExport()
    });
    
    items.push({ type: 'separator' });
    
    // Bulk delete (danger)
    items.push({
        icon: 'fa-solid fa-trash',
        label: 'Delete All',
        className: 'danger',
        action: () => bulkDelete()
    });
    
    items.push({ type: 'separator' });
    
    // Selection management
    items.push({
        icon: 'fa-solid fa-xmark',
        label: 'Clear Selection',
        className: 'secondary',
        action: () => CoreAPI.clearSelection()
    });
    
    return items;
}

function buildSingleMenuItems(char, cardElement) {
    const isFavorite = cardElement?.classList.contains('is-favorite') || 
                       char.fav === true || 
                       char.fav === 'true';
    
    const isSelected = CoreAPI.isCharacterSelected(char.avatar);
    const multiSelectEnabled = CoreAPI.isMultiSelectEnabled();
    
    // Check for provider link (provider-agnostic)
    const providerMatch = CoreAPI.getCharacterProvider(char);
    const provider = providerMatch?.provider || null;
    const linkInfo = providerMatch?.linkInfo || null;
    
    const items = [];
    
    items.push({
        type: 'header',
        label: truncateName(char.name || 'Character', 25)
    });
    
    items.push({
        icon: 'fa-solid fa-expand',
        label: 'Open Character',
        action: () => CoreAPI.openCharacterModal(char)
    });
    
    items.push({
        icon: isFavorite ? 'fa-solid fa-star' : 'fa-regular fa-star',
        label: isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
        action: () => toggleFavorite(char)
    });
    
    items.push({ type: 'separator' });
    
    // Selection toggle (always show, enables quick selection)
    items.push({
        icon: isSelected ? 'fa-solid fa-square-minus' : 'fa-solid fa-square-check',
        label: isSelected ? 'Deselect' : 'Select for Batch',
        action: () => {
            // Enable multi-select if not already
            if (!multiSelectEnabled) {
                CoreAPI.enableMultiSelect();
            }
            CoreAPI.toggleCharacterSelection(char, cardElement);
        }
    });
    
    // Provider link
    if (provider && linkInfo) {
        items.push({
            icon: 'fa-solid fa-link',
            label: `${provider.name} Info`,
            action: () => provider.openLinkUI(char)
        });
        
        // Check for updates
        items.push({
            icon: 'fa-solid fa-arrows-rotate',
            label: 'Check for Updates',
            action: () => {
                const cardUpdates = CoreAPI.getModule('card-updates');
                if (cardUpdates?.checkSingleCharacter) {
                    cardUpdates.checkSingleCharacter(char);
                }
            }
        });
    } else if (CoreAPI.isExtensionsRecoveryInProgress()) {
        // Extensions not yet recovered — provider link status unknown
        items.push({
            icon: 'fa-solid fa-spinner fa-spin',
            label: 'Loading provider data…',
            disabled: true
        });
    } else {
        // Unlinked — single entry that opens the global link modal (searches all providers)
        items.push({
            icon: 'fa-solid fa-link',
            label: 'Link to Provider',
            action: () => CoreAPI.openProviderLinkModal(char)
        });
    }
    
    // Version history (available for ALL characters — local snapshots + remote if provider-linked)
    items.push({
        icon: 'fa-solid fa-clock-rotate-left',
        label: 'Version History',
        action: () => {
            const charVersions = CoreAPI.getModule('character-versions');
            if (charVersions?.openVersionHistory) {
                charVersions.openVersionHistory(char);
            }
        }
    });
    
    // Gallery viewer
    items.push({
        icon: 'fa-solid fa-images',
        label: 'View Gallery',
        action: () => {
            const galleryViewer = CoreAPI.getModule('gallery-viewer');
            if (galleryViewer?.openViewer) {
                galleryViewer.openViewer(char);
            }
        }
    });
    
    items.push({ type: 'separator' });
    
    // Utility actions
    items.push({
        icon: 'fa-solid fa-list-ul',
        label: 'Add to Playlist',
        action: () => CoreAPI.openPlaylistPicker([char.avatar])
    });

    items.push({
        icon: 'fa-solid fa-download',
        label: 'Export Character',
        action: () => exportCharacter(char)
    });
    
    items.push({ type: 'separator' });
    
    // Danger zone
    items.push({
        icon: 'fa-solid fa-trash',
        label: 'Delete Character',
        className: 'danger',
        action: () => confirmDelete(char)
    });
    
    return items;
}

function renderMenu(items) {
    menuElement.innerHTML = items.map(item => {
        if (item.type === 'separator') {
            return '<div class="cl-context-menu-separator"></div>';
        }
        
        if (item.type === 'header') {
            return `<div class="cl-context-menu-header">${escapeHtml(item.label)}</div>`;
        }
        
        const className = `cl-context-menu-item ${item.className || ''} ${item.disabled ? 'disabled' : ''}`;
        return `
            <div class="${className}" data-action="${item.label}">
                <i class="${item.icon}"></i>
                <span>${escapeHtml(item.label)}</span>
            </div>
        `;
    }).join('');
    
    menuElement.querySelectorAll('.cl-context-menu-item:not(.disabled)').forEach((el, index) => {
        const item = items.filter(i => i.type !== 'separator' && i.type !== 'header' && !i.disabled)[index];
        if (item?.action) {
            el.addEventListener('click', () => {
                hide();
                item.action();
            });
        }
    });
}

function positionMenu(x, y) {
    menuElement.style.left = '0';
    menuElement.style.top = '0';
    
    const menuRect = menuElement.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 10;
    
    let finalX = x;
    if (x + menuRect.width + pad > vw) finalX = x - menuRect.width;
    if (finalX < pad) finalX = pad;
    
    const spaceBelow = vh - y;
    const spaceAbove = y;
    const openUpward = menuRect.height + pad > spaceBelow && spaceAbove > spaceBelow;
    
    let finalY;
    if (openUpward) {
        finalY = Math.max(pad, y - menuRect.height);
        menuElement.style.transformOrigin = 'bottom left';
    } else {
        finalY = y;
        if (finalY + menuRect.height + pad > vh) finalY = vh - menuRect.height - pad;
        if (finalY < pad) finalY = pad;
        menuElement.style.transformOrigin = 'top left';
    }
    
    menuElement.style.left = `${finalX}px`;
    menuElement.style.top = `${finalY}px`;
}

async function toggleFavorite(char) {
    // Check both root and extensions location
    const currentFav = char.fav === true || char.fav === 'true' || 
                       char.data?.extensions?.fav === true || char.data?.extensions?.fav === 'true';
    const newFav = !currentFav;
    
    // Preserve existing data and extensions when updating
    const existingData = char.data || {};
    const existingExtensions = existingData.extensions || char.extensions || {};
    const updatedExtensions = {
        ...existingExtensions,
        fav: newFav
    };
    
    try {
        const response = await CoreAPI.apiRequest('/characters/merge-attributes', 'POST', {
            avatar: char.avatar,
            fav: newFav,
            create_date: char.create_date,
            data: {
                ...existingData,
                extensions: updatedExtensions
            }
        });
        
        if (response.ok) {
            // Update local character data in both locations
            char.fav = newFav;
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.fav = newFav;
            
            const card = CoreAPI.findCardElement(char.avatar);
            if (card) {
                if (newFav) {
                    card.classList.add('is-favorite');
                    if (!card.querySelector('.favorite-indicator')) {
                        card.insertAdjacentHTML('afterbegin', 
                            '<div class="favorite-indicator"><i class="fa-solid fa-star"></i></div>');
                    }
                } else {
                    card.classList.remove('is-favorite');
                    card.querySelector('.favorite-indicator')?.remove();
                }
            }
            
            CoreAPI.showToast(newFav ? 'Added to favorites' : 'Removed from favorites', 'success');
        } else {
            throw new Error('API request failed');
        }
    } catch (err) {
        console.error('[ContextMenu] Failed to toggle favorite:', err);
        CoreAPI.showToast('Failed to update favorite', 'error');
    }
}

async function bulkToggleFavorites(setFavorite) {
    const selected = CoreAPI.getSelectedCharacters();
    if (selected.length === 0) return;
    
    let successCount = 0;
    let failCount = 0;
    
    CoreAPI.showToast(`Updating ${selected.length} characters...`, 'info');
    
    for (const char of selected) {
        try {
            // IMPORTANT: SillyTavern reads fav from data.extensions.fav
            // Must include data object while preserving existing data fields
            const existingData = char.data || {};
            const existingExtensions = existingData.extensions || char.extensions || {};
            
            const response = await CoreAPI.apiRequest('/characters/merge-attributes', 'POST', {
                avatar: char.avatar,
                fav: setFavorite,
                create_date: char.create_date,
                data: {
                    ...existingData,
                    extensions: {
                        ...existingExtensions,
                        fav: setFavorite
                    }
                }
            });
            
            if (response.ok) {
                char.fav = setFavorite;
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions.fav = setFavorite;
                
                // Update card UI
                const card = CoreAPI.findCardElement(char.avatar);
                if (card) {
                    if (setFavorite) {
                        card.classList.add('is-favorite');
                        if (!card.querySelector('.favorite-indicator')) {
                            card.insertAdjacentHTML('afterbegin', 
                                '<div class="favorite-indicator"><i class="fa-solid fa-star"></i></div>');
                        }
                    } else {
                        card.classList.remove('is-favorite');
                        card.querySelector('.favorite-indicator')?.remove();
                    }
                }
                successCount++;
            } else {
                failCount++;
            }
        } catch (err) {
            console.error('[ContextMenu] Bulk favorite failed for:', char.name, err);
            failCount++;
        }
    }
    
    if (failCount === 0) {
        CoreAPI.showToast(`${setFavorite ? 'Added' : 'Removed'} ${successCount} favorites`, 'success');
    } else {
        CoreAPI.showToast(`Updated ${successCount}, failed ${failCount}`, 'warning');
    }
}

async function bulkExport() {
    const selected = CoreAPI.getSelectedCharacters();
    if (selected.length === 0) return;

    if (CoreAPI.getSetting('exportAsLinks')) {
        return bulkExportLinks(selected);
    }
    
    CoreAPI.showToast(`Exporting ${selected.length} characters...`, 'info');
    
    let successCount = 0;
    
    for (const char of selected) {
        try {
            const avatarUrl = `/characters/${encodeURIComponent(char.avatar)}`;
            const response = await fetch(avatarUrl);
            
            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const filename = char.name ? `${char.name}.png` : char.avatar;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                successCount++;
                
                // Small delay between downloads to not overwhelm browser
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (err) {
            console.error('[ContextMenu] Export failed for:', char.name, err);
        }
    }
    
    CoreAPI.showToast(`Exported ${successCount}/${selected.length} characters`, 'success');
}

function bulkExportLinks(selected) {
    const links = [];
    let skipped = 0;
    for (const char of selected) {
        const match = CoreAPI.getCharacterProvider(char);
        if (match) {
            const url = match.provider.getCharacterUrl?.(match.linkInfo);
            if (url) { links.push(url); continue; }
        }
        skipped++;
    }
    if (links.length === 0) {
        CoreAPI.showToast('No linked characters to export', 'warning');
        return;
    }
    copyToClipboard(links.join('\n')).then(() => {
        let msg = `${links.length} link${links.length !== 1 ? 's' : ''} copied to clipboard`;
        if (skipped > 0) msg += ` (${skipped} unlinked skipped)`;
        CoreAPI.showToast(msg, 'success');
    }).catch(() => {
        CoreAPI.showToast('Failed to copy to clipboard', 'error');
    });
}

async function bulkDelete() {
    const selected = CoreAPI.getSelectedCharacters();
    if (selected.length === 0) return;
    
    // Check which characters have gallery images AND unique gallery IDs
    // Only offer gallery deletion when unique folders feature is ENABLED
    const uniqueFoldersEnabled = CoreAPI.getSetting('uniqueGalleryFolders') || false;
    
    const galleryInfos = await Promise.all(
        selected.map(async char => ({
            char,
            info: await CoreAPI.getCharacterGalleryInfo(char),
            hasUniqueGallery: !!CoreAPI.getCharacterGalleryId(char)
        }))
    );
    
    // Only count characters with unique galleries for deletion option (when feature is enabled)
    const charsWithUniqueGallery = uniqueFoldersEnabled 
        ? galleryInfos.filter(g => g.info.count > 0 && g.hasUniqueGallery)
        : [];
    const charsWithSharedGallery = galleryInfos.filter(g => g.info.count > 0 && (!g.hasUniqueGallery || !uniqueFoldersEnabled));
    const totalUniqueGalleryFiles = charsWithUniqueGallery.reduce((sum, g) => sum + g.info.count, 0);
    
    const names = selected.slice(0, 5).map(c => c.name).join(', ');
    const andMore = selected.length > 5 ? ` and ${selected.length - 5} more` : '';
    
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'bulkDeleteConfirmModal';
    modal.innerHTML = `
        <div class="confirm-modal-content" style="max-width: 480px;">
            <div class="confirm-modal-header" style="background: linear-gradient(135deg, rgba(231, 76, 60, 0.2) 0%, rgba(192, 57, 43, 0.2) 100%);">
                <h3 style="border: none; padding: 0; margin: 0;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #e74c3c;"></i>
                    Delete ${selected.length} Characters
                </h3>
                <button class="close-confirm-btn" id="closeBulkDeleteModal">&times;</button>
            </div>
            <div class="confirm-modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 15px;">
                    <strong>${names}</strong>${andMore}
                </p>
                
                ${totalUniqueGalleryFiles > 0 ? `
                    <div style="background: rgba(241, 196, 15, 0.15); border: 1px solid rgba(241, 196, 15, 0.4); border-radius: 8px; padding: 12px; margin-bottom: 15px;">
                        <div style="display: flex; align-items: center; gap: 8px; color: #f1c40f; margin-bottom: 10px;">
                            <i class="fa-solid fa-images"></i>
                            <strong>${charsWithUniqueGallery.length} character${charsWithUniqueGallery.length !== 1 ? 's have' : ' has'} unique gallery files (${totalUniqueGalleryFiles} total)</strong>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2);">
                                <input type="radio" name="galleryAction" value="keep" checked style="accent-color: #f1c40f;">
                                <span><strong>Keep gallery files</strong> - Leave in folders</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: var(--text-primary); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2);">
                                <input type="radio" name="galleryAction" value="delete" style="accent-color: #e74c3c;">
                                <span><strong>Delete gallery files</strong> - Remove all images</span>
                            </label>
                        </div>
                    </div>
                ` : ''}
                
                ${charsWithSharedGallery.length > 0 ? `
                    <div style="background: rgba(150, 150, 150, 0.15); border: 1px solid rgba(150, 150, 150, 0.4); border-radius: 8px; padding: 10px; margin-bottom: 15px; font-size: 13px;">
                        <i class="fa-solid fa-info-circle" style="color: #888;"></i>
                        <span style="color: var(--text-secondary);">${charsWithSharedGallery.length} character${charsWithSharedGallery.length !== 1 ? 's have' : ' has'} shared galleries (files will be kept)</span>
                    </div>
                ` : ''}
                
                <p style="color: var(--text-secondary);">
                    <i class="fa-solid fa-exclamation-circle" style="color: #e74c3c;"></i>
                    This action cannot be undone!
                </p>
            </div>
            <div class="confirm-modal-footer">
                <button class="action-btn secondary" id="cancelBulkDeleteBtn">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                <button class="action-btn danger" id="confirmBulkDeleteBtn">
                    <i class="fa-solid fa-trash"></i> Delete All
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event handlers
    const closeModal = () => modal.remove();
    
    modal.querySelector('#closeBulkDeleteModal').addEventListener('click', closeModal);
    modal.querySelector('#cancelBulkDeleteBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    
    modal.querySelector('#confirmBulkDeleteBtn').addEventListener('click', async () => {
        const confirmBtn = modal.querySelector('#confirmBulkDeleteBtn');
        const galleryAction = modal.querySelector('input[name="galleryAction"]:checked')?.value || 'keep';
        
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        
        let successCount = 0;
        let failCount = 0;
        let galleryDeleted = 0;
        
        for (let i = 0; i < selected.length; i++) {
            const char = selected[i];
            const galleryData = galleryInfos.find(g => g.char.avatar === char.avatar);
            
            confirmBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${i + 1}/${selected.length}...`;
            
            try {
                // Delete gallery files if requested AND character has unique gallery
                if (galleryAction === 'delete' && galleryData?.hasUniqueGallery && galleryData?.info?.count > 0) {
                    const safeFolderName = CoreAPI.sanitizeFolderName(galleryData.info.folder);
                    for (const fileName of galleryData.info.files) {
                        try {
                            const deletePath = `/user/images/${safeFolderName}/${fileName}`;
                            await CoreAPI.apiRequest('/images/delete', 'POST', { path: deletePath });
                            galleryDeleted++;
                        } catch (e) {
                            // Continue even if image deletion fails
                        }
                    }
                }
                
                const response = await CoreAPI.apiRequest('/characters/delete', 'POST', {
                    avatar_url: char.avatar,
                    delete_chats: false
                });
                
                if (response.ok) {
                    // Clean up gallery folder override if character had unique gallery
                    if (galleryData?.hasUniqueGallery) {
                        CoreAPI.removeGalleryFolderOverride(char.avatar);
                    }
                    
                    const card = CoreAPI.findCardElement(char.avatar);
                    card?.remove();
                    successCount++;
                } else {
                    failCount++;
                }
            } catch (err) {
                console.error('[ContextMenu] Delete failed for:', char.name, err);
                failCount++;
            }
        }
        
        closeModal();
        CoreAPI.clearSelection();
        
        let message = `Deleted ${successCount} character${successCount !== 1 ? 's' : ''}`;
        if (galleryDeleted > 0) {
            message += ` and ${galleryDeleted} gallery file${galleryDeleted !== 1 ? 's' : ''}`;
        }
        if (failCount > 0) {
            message += `, ${failCount} failed`;
            CoreAPI.showToast(message, 'warning');
        } else {
            CoreAPI.showToast(message, 'success');
        }
        
        // Sync main ST window's character list
        try {
            const host = CoreAPI.getHostWindow();
            if (host) {
                const context = host.SillyTavern?.getContext?.();
                if (context?.getCharacters) {
                    await context.getCharacters();
                }
                if (typeof host.printCharactersDebounced === 'function') {
                    host.printCharactersDebounced();
                }
            }
        } catch (e) {
            console.warn('[ContextMenu] Could not sync main window:', e);
        }
        
        // Force refresh character list from server
        await CoreAPI.refreshCharacters(true);
    });
}

async function exportCharacter(char) {
    if (CoreAPI.getSetting('exportAsLinks')) {
        const match = CoreAPI.getCharacterProvider(char);
        if (match) {
            const url = match.provider.getCharacterUrl?.(match.linkInfo);
            if (url) {
                copyToClipboard(url).then(() => {
                    CoreAPI.showToast('Link copied to clipboard', 'success');
                }).catch(() => {
                    CoreAPI.showToast('Failed to copy to clipboard', 'error');
                });
                return;
            }
        }
        CoreAPI.showToast('Character has no provider link — exporting PNG', 'info');
    }

    try {
        const avatarUrl = `/characters/${encodeURIComponent(char.avatar)}`;
        const response = await fetch(avatarUrl);
        
        if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const filename = char.name ? `${char.name}.png` : char.avatar;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            CoreAPI.showToast('Character exported', 'success');
        } else {
            throw new Error('Failed to fetch character file');
        }
    } catch (err) {
        console.error('[ContextMenu] Export failed:', err);
        CoreAPI.showToast('Failed to export character', 'error');
    }
}

function confirmDelete(char) {
    CoreAPI.openCharacterModal(char);
    setTimeout(() => {
        const deleteBtn = document.getElementById('deleteCharBtn');
        if (deleteBtn) {
            deleteBtn.click();
        } else {
            if (confirm(`Are you sure you want to delete "${char.name}"?\n\nThis cannot be undone.`)) {
                deleteCharacter(char);
            }
        }
    }, 200);
}

async function deleteCharacter(char) {
    try {
        const response = await CoreAPI.apiRequest('/characters/delete', 'POST', {
            avatar_url: char.avatar,
            delete_chats: false
        });
        
        if (response.ok) {
            currentCard?.remove();
            CoreAPI.showToast(`Deleted "${char.name}"`, 'success');
            CoreAPI.refreshCharacters();
        }
    } catch (err) {
        console.error('[ContextMenu] Delete failed:', err);
        CoreAPI.showToast('Failed to delete character', 'error');
    }
}

function escapeHtml(text) {
    return CoreAPI.escapeHtml(text);
}

function truncateName(name, maxLength) {
    if (name.length <= maxLength) return name;
    return name.substring(0, maxLength - 1) + '…';
}

export function attachToCard(cardElement, char) {
    cardElement.addEventListener('contextmenu', (e) => {
        show(e, char, cardElement);
    });
}

export default {
    init,
    show,
    hide,
    attachToCard,
    // Bulk actions - exposed for multi-select toolbar
    bulkToggleFavorites,
    bulkExport,
    bulkDelete
};
