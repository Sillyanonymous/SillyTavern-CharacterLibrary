// Flags characters missing a gallery_id and offers one-click assignment (folder names are computed live by the index.js Proxy).

import * as CoreAPI from './core-api.js';

let isInitialized = false;

// Audit: only flags characters missing a gallery_id when unique-folders is on.
export function auditGalleryIntegrity() {
    const characters = CoreAPI.getAllCharacters();
    const uniqueFoldersEnabled = CoreAPI.getSetting('uniqueGalleryFolders') || false;

    const result = {
        timestamp: Date.now(),
        uniqueFoldersEnabled,
        totalCharacters: characters.length,
        missingGalleryId: [],
        issues: { missingIds: 0 },
    };

    if (uniqueFoldersEnabled) {
        for (const char of characters) {
            if (!CoreAPI.getCharacterGalleryId(char)) {
                result.missingGalleryId.push({
                    avatar: char.avatar,
                    name: char.name || char.data?.name || 'Unknown',
                });
            }
        }
    }

    result.issues.missingIds = result.missingGalleryId.length;
    return result;
}

export async function assignMissingGalleryIds(options = {}) {
    const { onProgress } = options;
    const audit = auditGalleryIntegrity();
    const toFix = audit.missingGalleryId;

    const result = { success: 0, failed: 0, errors: [] };

    for (let i = 0; i < toFix.length; i++) {
        const { avatar, name } = toFix[i];
        if (onProgress) onProgress(i + 1, toFix.length, { avatar, name });

        try {
            const ok = await assignGalleryIdToCharacter(avatar);
            if (ok) result.success++;
            else { result.failed++; result.errors.push({ avatar, name, error: 'Assignment returned false' }); }
        } catch (err) {
            result.failed++;
            result.errors.push({ avatar, name, error: err.message });
        }

        await sleep(50);
    }

    return result;
}

function getSTContext() {
    try {
        const host = CoreAPI.getHostWindow();
        if (host?.SillyTavern?.getContext) return host.SillyTavern.getContext();
    } catch { /* cross-origin or unavailable */ }
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
    return null;
}

function generateGalleryId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

async function assignGalleryIdToCharacter(avatar) {
    const char = CoreAPI.getCharacterByAvatar(avatar);
    if (!char) return false;
    if (CoreAPI.getCharacterGalleryId(char)) return true;

    const galleryId = generateGalleryId();
    if (CoreAPI.applyCardFieldUpdates) {
        return await CoreAPI.applyCardFieldUpdates(avatar, { 'extensions.gallery_id': galleryId });
    }

    try {
        const existingExtensions = char.data?.extensions || {};
        const response = await CoreAPI.apiRequest('/characters/edit', 'POST', {
            avatar_url: avatar,
            extensions: { ...existingExtensions, gallery_id: galleryId },
        });
        if (response.ok) {
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function updateWarningIndicator(audit = null) {
    const syncBtn = document.getElementById('gallerySyncStatusBtn');
    const dropdown = document.getElementById('gallerySyncDropdown');
    if (!syncBtn) return;

    const container = syncBtn.closest('.gallery-sync-container');
    const uniqueFoldersEnabled = CoreAPI.getSetting('uniqueGalleryFolders') || false;

    if (!uniqueFoldersEnabled) {
        if (container) container.classList.add('hidden');
        const content = dropdown?.querySelector('.sync-dropdown-content');
        if (content) content.innerHTML = '';
        syncBtn.classList.remove('has-issues');
        return;
    }

    if (container) container.classList.remove('hidden');

    if (CoreAPI.isExtensionsRecoveryInProgress()) {
        syncBtn.classList.remove('has-issues');
        syncBtn.title = 'Gallery sync — recovering character data…';
        const icon = syncBtn.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
        const badge = syncBtn.querySelector('.warning-badge');
        if (badge) badge.classList.add('hidden');
        if (dropdown) showRecoveryDropdown(dropdown);
        return;
    }

    if (!audit) audit = auditGalleryIntegrity();

    const missingIds = audit.issues.missingIds;
    const badge = syncBtn.querySelector('.warning-badge');
    const icon = syncBtn.querySelector('i');

    if (missingIds > 0) {
        syncBtn.classList.add('has-issues');
        syncBtn.title = `${missingIds} character${missingIds !== 1 ? 's' : ''} without gallery_id - click to review`;
        if (icon) icon.className = 'fa-solid fa-triangle-exclamation';
        if (badge) {
            badge.classList.remove('hidden');
            badge.textContent = missingIds > 99 ? '99+' : missingIds;
        }
    } else {
        syncBtn.classList.remove('has-issues');
        syncBtn.title = 'Gallery sync status - all characters have IDs';
        if (icon) icon.className = 'fa-solid fa-circle-info';
        if (badge) badge.classList.add('hidden');
    }

    updateDropdownContent(dropdown, audit);
}

function showRecoveryDropdown(dropdown) {
    if (!dropdown) return;
    const content = dropdown.querySelector('.sync-dropdown-content');
    if (!content) return;
    content.innerHTML = `
        <div class="sync-dropdown-header" style="justify-content:center;gap:10px;opacity:0.8;">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Recovering character data…</span>
        </div>
        <div class="sync-dropdown-stats" style="opacity:0.5;text-align:center;">
            <span>Gallery sync status will update automatically once complete.</span>
        </div>
    `;
}

function updateDropdownContent(dropdown, audit) {
    if (!dropdown) return;
    const content = dropdown.querySelector('.sync-dropdown-content');
    if (!content) return;

    const missingIds = audit.issues.missingIds;
    const statusClass = missingIds === 0 ? 'healthy' : 'issues';
    const hasId = audit.totalCharacters - missingIds;

    content.innerHTML = `
        <div class="sync-dropdown-header ${statusClass}">
            <i class="fa-solid ${missingIds === 0 ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            <span>${missingIds === 0 ? 'All characters have gallery IDs' : `${missingIds} missing gallery_id`}</span>
        </div>
        <div class="sync-dropdown-stats">
            <span><i class="fa-solid fa-users"></i> ${audit.totalCharacters} chars</span>
            <span><i class="fa-solid fa-check"></i> ${hasId} with ID</span>
        </div>
        ${missingIds > 0 ? `
        <div class="sync-dropdown-actions">
            <button class="action-btn secondary small" id="syncDropdownDetailsBtn">
                <i class="fa-solid fa-magnifying-glass"></i> Details
            </button>
            <button class="action-btn primary small" id="syncDropdownFixBtn">
                <i class="fa-solid fa-fingerprint"></i> Assign IDs
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

    const detailsBtn = content.querySelector('#syncDropdownDetailsBtn');
    const fixBtn = content.querySelector('#syncDropdownFixBtn');

    if (detailsBtn) {
        detailsBtn.onclick = () => {
            dropdown.classList.add('hidden');
            navigateToGallerySyncSettings();
        };
    }

    if (fixBtn) {
        fixBtn.onclick = () => {
            dropdown.classList.add('hidden');
            navigateToGallerySyncSettings(true);
        };
    }
}

function navigateToGallerySyncSettings(triggerFix = false) {
    const settingsBtn = document.getElementById('gallerySettingsBtn');
    if (settingsBtn) {
        settingsBtn.click();
        setTimeout(() => {
            const navItem = document.querySelector('.settings-nav-item[data-section="gallery-folders"]');
            if (navItem) {
                navItem.click();
                setTimeout(() => {
                    const auditBtn = document.getElementById('gallerySyncAuditBtn');
                    if (auditBtn) auditBtn.click();
                    if (triggerFix) {
                        setTimeout(() => {
                            const migrateBtn = document.getElementById('migrateGalleryFoldersBtn');
                            if (migrateBtn) migrateBtn.click();
                        }, 300);
                    }
                }, 100);
            }
        }, 50);
    }
}

export async function init() {
    if (isInitialized) return;

    CoreAPI.debugLog('[GallerySync] Module initializing...');

    const syncBtn = document.getElementById('gallerySyncStatusBtn');
    const dropdown = document.getElementById('gallerySyncDropdown');

    if (syncBtn && dropdown) {
        syncBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !dropdown.classList.contains('hidden');
            CoreAPI.closeAllTopbarDropdowns('gallerySyncDropdown');

            if (isOpen) {
                dropdown.classList.add('hidden');
            } else {
                const content = dropdown.querySelector('.sync-dropdown-content');
                if (content) {
                    content.innerHTML = '<div class="sync-dropdown-loading"><i class="fa-solid fa-spinner fa-spin"></i> Checking...</div>';
                }
                dropdown.classList.remove('hidden');

                if (CoreAPI.isExtensionsRecoveryInProgress()) {
                    showRecoveryDropdown(dropdown);
                    return;
                }

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

        document.addEventListener('click', (e) => {
            if (!syncBtn.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }

    if (CoreAPI.isExtensionsRecoveryInProgress()) {
        updateWarningIndicator();
    }

    // Deferred audit safety net for the case processAndRender outran our load.
    setTimeout(() => {
        if (CoreAPI.getGallerySyncAuditDone()) return;
        if (CoreAPI.isExtensionsRecoveryInProgress()) return;
        try {
            updateWarningIndicator(auditGalleryIntegrity());
            CoreAPI.setGallerySyncAuditDone(true);
        } catch (err) {
            console.error('[GallerySync] Deferred audit failed:', err);
        }
    }, 5000);

    isInitialized = true;
    CoreAPI.debugLog('[GallerySync] Module initialized');
}

export default {
    init,
    auditGalleryIntegrity,
    assignMissingGalleryIds,
    updateWarningIndicator,
};
