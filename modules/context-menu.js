/**
 * Context Menu Module for SillyTavern Character Library
 * Provides right-click context menu functionality for character cards
 * 
 * @module ContextMenu
 * @version 1.0.0
 */

import * as SharedStyles from './shared-styles.js';
import * as CoreAPI from './core-api.js';

// Module state
let isInitialized = false;
let menuElement = null;
let currentCharacter = null;
let currentCard = null;

/**
 * Initialize the context menu module
 * @param {Object} deps - Dependencies from gallery.js
 */
export function init(deps) {
    if (isInitialized) {
        console.warn('[ContextMenu] Already initialized');
        return;
    }
    
    // Ensure shared styles are loaded
    SharedStyles.inject();
    
    // Create menu element
    createMenu();
    
    // Setup global event listeners
    setupGlobalListeners();
    
    isInitialized = true;
    console.log('[ContextMenu] Module initialized');
}

/**
 * Create the context menu DOM element
 */
function createMenu() {
    menuElement = document.createElement('div');
    menuElement.id = 'clContextMenu';
    menuElement.className = 'cl-context-menu';
    document.body.appendChild(menuElement);
}

/**
 * Setup global event listeners
 */
function setupGlobalListeners() {
    // Close menu on click outside
    document.addEventListener('click', (e) => {
        if (!menuElement.contains(e.target)) {
            hide();
        }
    });
    
    // Close menu on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hide();
        }
    });
    
    // Close menu on scroll
    document.addEventListener('scroll', () => hide(), true);
    
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

/**
 * Show context menu for a character card
 * @param {MouseEvent} event - The contextmenu event
 * @param {Object} char - Character object
 * @param {HTMLElement} cardElement - The card DOM element
 */
export function show(event, char, cardElement) {
    event.preventDefault();
    event.stopPropagation();
    
    currentCharacter = char;
    currentCard = cardElement;
    
    // Build menu items based on context
    const menuItems = buildMenuItems(char, cardElement);
    renderMenu(menuItems);
    
    // Position menu
    positionMenu(event.clientX, event.clientY);
    
    // Show with animation
    menuElement.classList.add('visible');
}

/**
 * Hide the context menu
 */
export function hide() {
    menuElement.classList.remove('visible');
    currentCharacter = null;
    currentCard = null;
}

/**
 * Build menu items based on character and context
 * @param {Object} char - Character object
 * @param {HTMLElement} cardElement - Card element
 * @returns {Array} Menu items configuration
 */
function buildMenuItems(char, cardElement) {
    const isSelected = CoreAPI.isCharacterSelected(char.avatar);
    const selectionCount = CoreAPI.getSelectionCount();
    
    // If this card is selected and we have multiple selections, show bulk menu
    if (isSelected && selectionCount > 1) {
        return buildBulkMenuItems(selectionCount);
    }
    
    // Otherwise show single character menu
    return buildSingleMenuItems(char, cardElement);
}

/**
 * Build menu items for bulk operations on multiple selected characters
 * @param {number} count - Number of selected characters
 * @returns {Array} Menu items configuration
 */
function buildBulkMenuItems(count) {
    const items = [];
    
    // Header
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
    
    // Bulk check for updates (ChubAI linked only)
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

/**
 * Build menu items for a single character
 * @param {Object} char - Character object
 * @param {HTMLElement} cardElement - Card element
 * @returns {Array} Menu items configuration
 */
function buildSingleMenuItems(char, cardElement) {
    const isFavorite = cardElement?.classList.contains('is-favorite') || 
                       char.fav === true || 
                       char.fav === 'true';
    
    const isSelected = CoreAPI.isCharacterSelected(char.avatar);
    const multiSelectEnabled = CoreAPI.isMultiSelectEnabled();
    
    // Check for ChubAI link - getChubLinkInfo normalizes full_path vs fullPath
    const chubInfo = CoreAPI.getChubLinkInfo(char);
    const chubId = chubInfo?.fullPath || char.chub_id;
    
    const items = [];
    
    // Character actions header
    items.push({
        type: 'header',
        label: truncateName(char.name || 'Character', 25)
    });
    
    // Primary actions
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
    
    // ChubAI link
    if (chubId) {
        items.push({
            icon: 'fa-solid fa-link',
            label: 'ChubAI Info',
            action: () => CoreAPI.openChubLinkModal(char)
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
    } else {
        items.push({
            icon: 'fa-solid fa-link',
            label: 'Link to ChubAI',
            action: () => CoreAPI.openChubLinkModal(char)
        });
    }
    
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

/**
 * Render menu items into the menu element
 * @param {Array} items - Menu items configuration
 */
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
    
    // Attach click handlers
    menuElement.querySelectorAll('.cl-context-menu-item:not(.disabled)').forEach((el, index) => {
        const item = items.filter(i => i.type !== 'separator' && i.type !== 'header')[index];
        if (item?.action) {
            el.addEventListener('click', () => {
                hide();
                item.action();
            });
        }
    });
}

/**
 * Position the menu near the cursor, keeping it on screen
 * @param {number} x - Cursor X position
 * @param {number} y - Cursor Y position
 */
function positionMenu(x, y) {
    // Reset position for measurement
    menuElement.style.left = '0';
    menuElement.style.top = '0';
    
    const menuRect = menuElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 10;
    
    // Adjust X to keep menu on screen
    let finalX = x;
    if (x + menuRect.width + padding > viewportWidth) {
        finalX = x - menuRect.width;
    }
    if (finalX < padding) {
        finalX = padding;
    }
    
    // Adjust Y to keep menu on screen
    let finalY = y;
    if (y + menuRect.height + padding > viewportHeight) {
        finalY = y - menuRect.height;
    }
    if (finalY < padding) {
        finalY = padding;
    }
    
    menuElement.style.left = `${finalX}px`;
    menuElement.style.top = `${finalY}px`;
}

/**
 * Toggle favorite status for a character
 * @param {Object} char - Character object
 */
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
            
            // Update card UI - find card fresh by avatar instead of using stale reference
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

/**
 * Bulk toggle favorites for all selected characters
 * @param {boolean} setFavorite - Whether to add or remove from favorites
 */
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

/**
 * Bulk export all selected characters
 */
async function bulkExport() {
    const selected = CoreAPI.getSelectedCharacters();
    if (selected.length === 0) return;
    
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

/**
 * Bulk delete all selected characters with confirmation
 */
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
    
    // Build character list preview
    const names = selected.slice(0, 5).map(c => c.name).join(', ');
    const andMore = selected.length > 5 ? ` and ${selected.length - 5} more` : '';
    
    // Create confirmation modal
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
                <button class="action-btn primary" id="confirmBulkDeleteBtn" style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); box-shadow: 0 2px 8px rgba(231, 76, 60, 0.3);">
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
                
                // Delete character
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
        
        // Show results
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
            if (window.opener && !window.opener.closed) {
                const context = window.opener.SillyTavern?.getContext?.();
                if (context?.getCharacters) {
                    await context.getCharacters();
                }
                if (typeof window.opener.printCharactersDebounced === 'function') {
                    window.opener.printCharactersDebounced();
                }
            }
        } catch (e) {
            console.warn('[ContextMenu] Could not sync main window:', e);
        }
        
        // Force refresh character list from server
        await CoreAPI.refreshCharacters(true);
    });
}

/**
 * Export character as PNG (character card with embedded data)
 * @param {Object} char - Character object
 */
async function exportCharacter(char) {
    try {
        // Character PNGs are served directly at /characters/avatar.png
        // These contain embedded character data (PNG tEXt chunks)
        const avatarUrl = `/characters/${encodeURIComponent(char.avatar)}`;
        
        const response = await fetch(avatarUrl);
        
        if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Use character name for filename, fallback to avatar filename
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

/**
 * Show delete confirmation dialog
 * @param {Object} char - Character object
 */
function confirmDelete(char) {
    // Use existing delete confirmation if available
    const deleteBtn = document.getElementById('deleteCharBtn');
    if (deleteBtn) {
        CoreAPI.openCharacterModal(char);
        setTimeout(() => {
            deleteBtn.click();
        }, 100);
    } else {
        // Fallback: simple confirm
        if (confirm(`Are you sure you want to delete "${char.name}"?\n\nThis cannot be undone.`)) {
            deleteCharacter(char);
        }
    }
}

/**
 * Delete a character
 * @param {Object} char - Character object
 */
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

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    return CoreAPI.escapeHtml(text);
}

/**
 * Truncate name with ellipsis
 * @param {string} name - Name to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated name
 */
function truncateName(name, maxLength) {
    if (name.length <= maxLength) return name;
    return name.substring(0, maxLength - 1) + '…';
}

/**
 * Attach context menu to a card element
 * Call this when creating cards
 * @param {HTMLElement} cardElement - The card DOM element
 * @param {Object} char - Character object
 */
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
