/**
 * Gallery Sync Module
 * Ensures consistency between character gallery_ids and settings.json folder mappings
 * 
 * @module GallerySync
 */

import * as CoreAPI from './core-api.js';

// ========================================
// MODULE STATE
// ========================================

let isInitialized = false;
let lastAuditResult = null;

// ========================================
// AUDIT FUNCTIONS
// ========================================

/**
 * Audit gallery integrity - identifies all issues without changing anything
 * @returns {Object} Audit results with categorized issues
 */
export function auditGalleryIntegrity() {
    const characters = CoreAPI.getAllCharacters();
    const context = getSTContext();
    const folderMappings = context?.extensionSettings?.gallery?.folders || {};
    const uniqueFoldersEnabled = CoreAPI.getSetting('uniqueGalleryFolders') || false;
    
    const result = {
        timestamp: Date.now(),
        uniqueFoldersEnabled,
        totalCharacters: characters.length,
        totalMappings: Object.keys(folderMappings).length,
        
        // Characters missing gallery_id
        missingGalleryId: [],
        
        // Characters with gallery_id but no folder mapping (when feature enabled)
        missingMapping: [],
        
        // Mappings for avatars that don't exist (orphaned)
        orphanedMappings: [],
        
        // Characters with gallery_id that have folder mapping (healthy)
        healthy: [],
        
        // Summary
        issues: {
            missingIds: 0,
            missingMappings: 0,
            orphaned: 0
        }
    };
    
    // Build avatar set for quick lookup
    const existingAvatars = new Set(characters.map(c => c.avatar));
    
    // Check each character
    for (const char of characters) {
        const galleryId = CoreAPI.getCharacterGalleryId(char);
        const hasMapping = folderMappings[char.avatar] !== undefined;
        
        if (!galleryId) {
            result.missingGalleryId.push({
                avatar: char.avatar,
                name: char.name || char.data?.name || 'Unknown'
            });
        } else if (uniqueFoldersEnabled && !hasMapping) {
            result.missingMapping.push({
                avatar: char.avatar,
                name: char.name || char.data?.name || 'Unknown',
                galleryId
            });
        } else if (galleryId && hasMapping) {
            result.healthy.push({
                avatar: char.avatar,
                name: char.name || char.data?.name || 'Unknown',
                galleryId,
                folder: folderMappings[char.avatar]
            });
        }
    }
    
    // Check for orphaned mappings
    for (const [avatar, folder] of Object.entries(folderMappings)) {
        if (!existingAvatars.has(avatar)) {
            result.orphanedMappings.push({ avatar, folder });
        }
    }
    
    // Update summary
    result.issues.missingIds = result.missingGalleryId.length;
    result.issues.missingMappings = result.missingMapping.length;
    result.issues.orphaned = result.orphanedMappings.length;
    
    lastAuditResult = result;
    return result;
}

/**
 * Get the last audit result without re-running
 * @returns {Object|null} Last audit result or null
 */
export function getLastAuditResult() {
    return lastAuditResult;
}

// ========================================
// REPAIR FUNCTIONS
// ========================================

/**
 * Assign gallery_id to characters that don't have one
 * @param {Object} options - Options
 * @param {Function} options.onProgress - Progress callback (current, total, char)
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
export async function assignMissingGalleryIds(options = {}) {
    const { onProgress } = options;
    const audit = auditGalleryIntegrity();
    const toFix = audit.missingGalleryId;
    
    const result = {
        success: 0,
        failed: 0,
        errors: []
    };
    
    for (let i = 0; i < toFix.length; i++) {
        const { avatar, name } = toFix[i];
        
        if (onProgress) {
            onProgress(i + 1, toFix.length, { avatar, name });
        }
        
        try {
            const success = await assignGalleryIdToCharacter(avatar);
            if (success) {
                result.success++;
            } else {
                result.failed++;
                result.errors.push({ avatar, name, error: 'Assignment returned false' });
            }
        } catch (err) {
            result.failed++;
            result.errors.push({ avatar, name, error: err.message });
        }
        
        // Small delay to avoid overwhelming the server
        await sleep(50);
    }
    
    return result;
}

/**
 * Create folder mappings for characters that have gallery_id but no mapping
 * @param {Object} options - Options
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
export async function createMissingMappings(options = {}) {
    const { onProgress } = options;
    const audit = auditGalleryIntegrity();
    const toFix = audit.missingMapping;
    const context = getSTContext();
    
    if (!context?.extensionSettings?.gallery) {
        context.extensionSettings.gallery = { folders: {} };
    }
    if (!context.extensionSettings.gallery.folders) {
        context.extensionSettings.gallery.folders = {};
    }
    
    const result = {
        success: 0,
        failed: 0,
        errors: []
    };
    
    for (let i = 0; i < toFix.length; i++) {
        const { avatar, name, galleryId } = toFix[i];
        
        if (onProgress) {
            onProgress(i + 1, toFix.length, { avatar, name });
        }
        
        try {
            // Get the character to build folder name
            const char = CoreAPI.getCharacterByAvatar(avatar);
            if (!char) {
                result.failed++;
                result.errors.push({ avatar, name, error: 'Character not found' });
                continue;
            }
            
            const charName = char.name || char.data?.name || 'Unknown';
            const folderName = `${charName}_${galleryId}`;
            
            context.extensionSettings.gallery.folders[avatar] = folderName;
            result.success++;
        } catch (err) {
            result.failed++;
            result.errors.push({ avatar, name, error: err.message });
        }
    }
    
    // Save settings
    if (result.success > 0 && typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
    
    return result;
}

/**
 * Remove orphaned folder mappings (mappings for non-existent avatars)
 * @returns {{removed: number, mappings: Array}}
 */
export function cleanupOrphanedMappings() {
    const audit = auditGalleryIntegrity();
    const context = getSTContext();
    
    if (!context?.extensionSettings?.gallery?.folders) {
        return { removed: 0, mappings: [] };
    }
    
    const result = {
        removed: 0,
        mappings: []
    };
    
    for (const { avatar, folder } of audit.orphanedMappings) {
        delete context.extensionSettings.gallery.folders[avatar];
        result.mappings.push({ avatar, folder });
        result.removed++;
    }
    
    if (result.removed > 0 && typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
    
    return result;
}

/**
 * Full sync - assign IDs, create mappings, cleanup orphans
 * @param {Object} options - Options
 * @param {Function} options.onProgress - Progress callback (phase, current, total, item)
 * @param {boolean} options.assignIds - Whether to assign missing gallery_ids (default: true)
 * @param {boolean} options.createMappings - Whether to create missing mappings (default: true)
 * @param {boolean} options.cleanupOrphans - Whether to cleanup orphaned mappings (default: true)
 * @returns {Promise<Object>} Combined results
 */
export async function fullSync(options = {}) {
    const {
        onProgress,
        assignIds = true,
        createMappings = true,
        cleanupOrphans = true
    } = options;
    
    const result = {
        startTime: Date.now(),
        assignedIds: null,
        createdMappings: null,
        cleanedOrphans: null,
        endTime: null
    };
    
    // Phase 1: Assign missing gallery_ids
    if (assignIds) {
        const audit = auditGalleryIntegrity();
        if (audit.missingGalleryId.length > 0) {
            result.assignedIds = await assignMissingGalleryIds({
                onProgress: onProgress ? (cur, tot, item) => onProgress('assignIds', cur, tot, item) : null
            });
        } else {
            result.assignedIds = { success: 0, failed: 0, errors: [], skipped: true };
        }
    }
    
    // Phase 2: Create missing mappings (re-audit after IDs assigned)
    if (createMappings) {
        const audit = auditGalleryIntegrity();
        if (audit.missingMapping.length > 0) {
            result.createdMappings = await createMissingMappings({
                onProgress: onProgress ? (cur, tot, item) => onProgress('createMappings', cur, tot, item) : null
            });
        } else {
            result.createdMappings = { success: 0, failed: 0, errors: [], skipped: true };
        }
    }
    
    // Phase 3: Cleanup orphaned mappings
    if (cleanupOrphans) {
        result.cleanedOrphans = cleanupOrphanedMappings();
    }
    
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;
    
    return result;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Get SillyTavern context
 */
function getSTContext() {
    if (window.opener?.SillyTavern?.getContext) {
        return window.opener.SillyTavern.getContext();
    }
    if (window.SillyTavern?.getContext) {
        return window.SillyTavern.getContext();
    }
    return null;
}

/**
 * Generate a unique gallery ID
 */
function generateGalleryId() {
    return `gal_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Assign a gallery_id to a character that doesn't have one
 * @param {string} avatar - Character avatar filename
 * @returns {Promise<boolean>} Success status
 */
async function assignGalleryIdToCharacter(avatar) {
    const char = CoreAPI.getCharacterByAvatar(avatar);
    if (!char) return false;
    
    // Check if already has gallery_id
    if (CoreAPI.getCharacterGalleryId(char)) {
        return true; // Already has one
    }
    
    const galleryId = generateGalleryId();
    
    // Use the window.applyCardFieldUpdates if available (from library.js)
    if (typeof window.applyCardFieldUpdates === 'function') {
        return await window.applyCardFieldUpdates(avatar, {
            'extensions.gallery_id': galleryId
        });
    }
    
    // Fallback: Direct API call
    try {
        const existingExtensions = char.data?.extensions || {};
        const updatedExtensions = {
            ...existingExtensions,
            gallery_id: galleryId
        };
        
        const response = await CoreAPI.apiRequest('/characters/edit', 'POST', {
            avatar_url: avatar,
            extensions: updatedExtensions
        });
        
        if (response.ok) {
            // Update local cache
            if (char.data) {
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions.gallery_id = galleryId;
            }
            return true;
        }
        return false;
    } catch (err) {
        console.error('[GallerySync] Failed to assign gallery_id:', err);
        return false;
    }
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// UI HELPERS
// ========================================

/**
 * Format audit result as human-readable summary
 * @param {Object} audit - Audit result
 * @returns {string} Formatted summary
 */
export function formatAuditSummary(audit) {
    if (!audit) return 'No audit data available';
    
    const lines = [
        `Gallery Integrity Audit`,
        `═══════════════════════`,
        `Total Characters: ${audit.totalCharacters}`,
        `Total Mappings: ${audit.totalMappings}`,
        `Unique Folders Enabled: ${audit.uniqueFoldersEnabled ? 'Yes' : 'No'}`,
        ``,
        `Issues Found:`,
        `  • Missing gallery_id: ${audit.issues.missingIds}`,
        `  • Missing mappings: ${audit.issues.missingMappings}`,
        `  • Orphaned mappings: ${audit.issues.orphaned}`,
        ``,
        `Healthy: ${audit.healthy.length} characters properly configured`
    ];
    
    return lines.join('\n');
}

/**
 * Create a sync status UI element
 * @returns {HTMLElement} Status element
 */
export function createSyncStatusUI() {
    const container = document.createElement('div');
    container.className = 'gallery-sync-status';
    container.innerHTML = `
        <div class="sync-status-header">
            <i class="fa-solid fa-rotate"></i>
            <span>Gallery Sync Status</span>
        </div>
        <div class="sync-status-body">
            <div class="sync-status-loading">
                <i class="fa-solid fa-spinner fa-spin"></i> Running audit...
            </div>
        </div>
        <div class="sync-status-actions" style="display: none;">
            <button class="action-btn secondary" data-action="audit">
                <i class="fa-solid fa-magnifying-glass"></i> Re-Audit
            </button>
            <button class="action-btn primary" data-action="sync">
                <i class="fa-solid fa-rotate"></i> Full Sync
            </button>
            <button class="action-btn secondary" data-action="cleanup">
                <i class="fa-solid fa-broom"></i> Cleanup Only
            </button>
        </div>
    `;
    
    return container;
}

/**
 * Update sync status UI with audit results
 * @param {HTMLElement} container - Status container
 * @param {Object} audit - Audit results
 */
export function updateSyncStatusUI(container, audit) {
    const body = container.querySelector('.sync-status-body');
    const actions = container.querySelector('.sync-status-actions');
    
    const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
    const statusClass = totalIssues === 0 ? 'healthy' : 'issues';
    
    body.innerHTML = `
        <div class="sync-summary ${statusClass}">
            <div class="sync-summary-icon">
                <i class="fa-solid ${totalIssues === 0 ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            </div>
            <div class="sync-summary-text">
                ${totalIssues === 0 
                    ? '<strong>All Synced</strong><br>No integrity issues found' 
                    : `<strong>${totalIssues} Issue${totalIssues !== 1 ? 's' : ''} Found</strong>`}
            </div>
        </div>
        ${totalIssues > 0 ? `
        <div class="sync-issues-list">
            ${audit.issues.missingIds > 0 ? `
                <div class="sync-issue-item">
                    <i class="fa-solid fa-id-card"></i>
                    <span>${audit.issues.missingIds} character${audit.issues.missingIds !== 1 ? 's' : ''} missing gallery_id</span>
                </div>
            ` : ''}
            ${audit.issues.missingMappings > 0 ? `
                <div class="sync-issue-item">
                    <i class="fa-solid fa-folder-open"></i>
                    <span>${audit.issues.missingMappings} character${audit.issues.missingMappings !== 1 ? 's' : ''} missing folder mapping</span>
                </div>
            ` : ''}
            ${audit.issues.orphaned > 0 ? `
                <div class="sync-issue-item">
                    <i class="fa-solid fa-ghost"></i>
                    <span>${audit.issues.orphaned} orphaned mapping${audit.issues.orphaned !== 1 ? 's' : ''}</span>
                </div>
            ` : ''}
        </div>
        ` : ''}
        <div class="sync-stats">
            <span><i class="fa-solid fa-users"></i> ${audit.totalCharacters} characters</span>
            <span><i class="fa-solid fa-folder"></i> ${audit.totalMappings} mappings</span>
            <span><i class="fa-solid fa-check"></i> ${audit.healthy.length} healthy</span>
        </div>
    `;
    
    actions.style.display = 'flex';
}

// ========================================
// INITIALIZATION
// ========================================

/**
 * Update the sync status button in the top bar
 * @param {Object} audit - Audit result (optional, will run audit if not provided)
 */
export function updateWarningIndicator(audit = null) {
    if (!audit) {
        audit = auditGalleryIntegrity();
    }
    
    const syncBtn = document.getElementById('gallerySyncStatusBtn');
    const dropdown = document.getElementById('gallerySyncDropdown');
    if (!syncBtn) return;
    
    const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
    const badge = syncBtn.querySelector('.warning-badge');
    const icon = syncBtn.querySelector('i');
    
    if (totalIssues > 0) {
        // Issues found - show warning state
        syncBtn.classList.add('has-issues');
        syncBtn.title = `${totalIssues} gallery sync issue${totalIssues !== 1 ? 's' : ''} - click to review`;
        if (icon) {
            icon.className = 'fa-solid fa-triangle-exclamation';
        }
        if (badge) {
            badge.classList.remove('hidden');
            badge.textContent = totalIssues > 99 ? '99+' : totalIssues;
        }
    } else {
        // All good - show info state
        syncBtn.classList.remove('has-issues');
        syncBtn.title = 'Gallery sync status - all synced';
        if (icon) {
            icon.className = 'fa-solid fa-circle-info';
        }
        if (badge) {
            badge.classList.add('hidden');
        }
    }
    
    // Update dropdown content
    updateDropdownContent(dropdown, audit);
}

/**
 * Update dropdown content with audit results
 */
function updateDropdownContent(dropdown, audit) {
    if (!dropdown) return;
    
    const content = dropdown.querySelector('.sync-dropdown-content');
    if (!content) return;
    
    const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
    const statusClass = totalIssues === 0 ? 'healthy' : 'issues';
    
    content.innerHTML = `
        <div class="sync-dropdown-header ${statusClass}">
            <i class="fa-solid ${totalIssues === 0 ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            <span>${totalIssues === 0 ? 'All Synced' : `${totalIssues} Issue${totalIssues !== 1 ? 's' : ''}`}</span>
        </div>
        <div class="sync-dropdown-stats">
            <span><i class="fa-solid fa-users"></i> ${audit.totalCharacters} chars</span>
            <span><i class="fa-solid fa-folder"></i> ${audit.totalMappings} mappings</span>
            <span><i class="fa-solid fa-check"></i> ${audit.healthy.length} healthy</span>
        </div>
        ${totalIssues > 0 ? `
        <div class="sync-dropdown-issues">
            ${audit.issues.missingIds > 0 ? `
                <div class="sync-dropdown-issue">
                    <i class="fa-solid fa-id-card"></i>
                    <span>${audit.issues.missingIds} missing gallery_id</span>
                </div>
            ` : ''}
            ${audit.issues.missingMappings > 0 ? `
                <div class="sync-dropdown-issue">
                    <i class="fa-solid fa-folder-open"></i>
                    <span>${audit.issues.missingMappings} missing folder mapping</span>
                </div>
            ` : ''}
            ${audit.issues.orphaned > 0 ? `
                <div class="sync-dropdown-issue">
                    <i class="fa-solid fa-ghost"></i>
                    <span>${audit.issues.orphaned} orphaned mapping${audit.issues.orphaned !== 1 ? 's' : ''}</span>
                </div>
            ` : ''}
        </div>
        <div class="sync-dropdown-actions">
            <button class="action-btn secondary small" id="syncDropdownDetailsBtn">
                <i class="fa-solid fa-magnifying-glass"></i> Details
            </button>
            <button class="action-btn primary small" id="syncDropdownFixBtn">
                <i class="fa-solid fa-wrench"></i> Fix Issues
            </button>
        </div>
        ` : `
        <div class="sync-dropdown-actions">
            <button class="action-btn secondary small" id="syncDropdownDetailsBtn">
                <i class="fa-solid fa-gear"></i> Settings
            </button>
        </div>
        `}
    `;
    
    // Setup action button handlers
    const detailsBtn = content.querySelector('#syncDropdownDetailsBtn');
    const fixBtn = content.querySelector('#syncDropdownFixBtn');
    
    if (detailsBtn) {
        detailsBtn.onclick = () => {
            dropdown.classList.add('hidden');
            navigateToGallerySyncSettings();
        };
    }
    
    if (fixBtn) {
        fixBtn.onclick = async () => {
            dropdown.classList.add('hidden');
            // Navigate to settings and trigger full sync
            navigateToGallerySyncSettings(true);
        };
    }
}

/**
 * Navigate to gallery sync settings
 */
function navigateToGallerySyncSettings(triggerSync = false) {
    const settingsBtn = document.getElementById('gallerySettingsBtn');
    if (settingsBtn) {
        settingsBtn.click();
        setTimeout(() => {
            const navItem = document.querySelector('.settings-nav-item[data-section="gallery-folders"]');
            if (navItem) {
                navItem.click();
                setTimeout(() => {
                    // First run audit to show current state
                    const auditBtn = document.getElementById('gallerySyncAuditBtn');
                    if (auditBtn) {
                        auditBtn.click();
                    }
                    
                    // If triggerSync, also click the full sync button after a short delay
                    if (triggerSync) {
                        setTimeout(() => {
                            const syncBtn = document.getElementById('gallerySyncFullBtn');
                            if (syncBtn) {
                                syncBtn.click();
                            }
                        }, 300);
                    }
                    
                    const integritySection = document.getElementById('gallerySyncStatus');
                    if (integritySection) {
                        integritySection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 100);
            }
        }, 150);
    }
}

/**
 * Initialize the Gallery Sync module
 * @param {Object} dependencies - Module dependencies (unused, for consistency)
 */
export async function init(dependencies = {}) {
    if (isInitialized) return;
    
    console.log('[GallerySync] Module initializing...');
    
    // Setup sync status button click handler
    const syncBtn = document.getElementById('gallerySyncStatusBtn');
    const dropdown = document.getElementById('gallerySyncDropdown');
    
    if (syncBtn && dropdown) {
        syncBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Toggle dropdown
            const isOpen = !dropdown.classList.contains('hidden');
            
            // Close all other dropdowns first
            document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach(menu => {
                if (menu !== dropdown) menu.classList.add('hidden');
            });
            
            if (isOpen) {
                dropdown.classList.add('hidden');
            } else {
                // Show loading state
                const content = dropdown.querySelector('.sync-dropdown-content');
                if (content) {
                    content.innerHTML = '<div class="sync-dropdown-loading"><i class="fa-solid fa-spinner fa-spin"></i> Checking...</div>';
                }
                dropdown.classList.remove('hidden');
                
                // Run audit and update
                setTimeout(() => {
                    try {
                        const audit = auditGalleryIntegrity();
                        updateDropdownContent(dropdown, audit);
                    } catch (err) {
                        console.error('[GallerySync] Audit failed:', err);
                    }
                }, 50);
            }
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!syncBtn.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }
    
    // Run initial audit (non-blocking)
    setTimeout(() => {
        try {
            const audit = auditGalleryIntegrity();
            const totalIssues = audit.issues.missingIds + audit.issues.missingMappings + audit.issues.orphaned;
            if (totalIssues > 0) {
                console.log(`[GallerySync] Audit found ${totalIssues} issue(s):`, audit.issues);
            } else {
                console.log('[GallerySync] Audit complete - all synced');
            }
            updateWarningIndicator(audit);
        } catch (err) {
            console.error('[GallerySync] Initial audit failed:', err);
        }
    }, 2000);
    
    isInitialized = true;
    console.log('[GallerySync] Module initialized');
}

// ========================================
// EXPORTS
// ========================================

export default {
    init,
    auditGalleryIntegrity,
    getLastAuditResult,
    assignMissingGalleryIds,
    createMissingMappings,
    cleanupOrphanedMappings,
    fullSync,
    formatAuditSummary,
    createSyncStatusUI,
    updateSyncStatusUI,
    updateWarningIndicator
};
