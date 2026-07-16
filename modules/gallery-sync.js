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

// Section status consumed by the notifications shell (library.js); kept in
// sync by updateWarningIndicator and read back via getStatus
let _sectionStatus = { visible: false, level: 'none', badge: '', title: '' };

export function updateWarningIndicator(audit = null) {
    const dropdown = document.getElementById('notificationsDropdown');
    const uniqueFoldersEnabled = CoreAPI.getSetting('uniqueGalleryFolders') || false;

    if (!uniqueFoldersEnabled) {
        _sectionStatus = { visible: false, level: 'none', badge: '', title: '' };
        const content = dropdown?.querySelector('.sync-dropdown-content');
        if (content) content.innerHTML = '';
        CoreAPI.refreshNotificationsUI();
        return;
    }

    if (CoreAPI.isExtensionsRecoveryInProgress()) {
        _sectionStatus = {
            visible: true,
            level: 'activity',
            icon: 'fa-solid fa-spinner fa-spin',
            title: 'Gallery sync — recovering character data…',
        };
        if (dropdown) showRecoveryDropdown(dropdown);
        CoreAPI.refreshNotificationsUI();
        return;
    }

    if (!audit) audit = auditGalleryIntegrity();

    const missingIds = audit.issues.missingIds;
    if (missingIds > 0) {
        _sectionStatus = {
            visible: true,
            level: 'warning',
            badge: missingIds > 99 ? '99+' : missingIds,
            title: `${missingIds} character${missingIds !== 1 ? 's' : ''} without gallery_id - click to review`,
        };
    } else {
        _sectionStatus = {
            visible: true,
            level: 'none',
            badge: '',
            title: 'Gallery sync status - all characters have IDs',
        };
    }

    updateDropdownContent(dropdown, audit);
    CoreAPI.refreshNotificationsUI();
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

    // The notifications shell (library.js) owns the button + dropdown chrome;
    // this module just contributes its section
    CoreAPI.registerNotificationSection({
        id: 'gallery-sync',
        getStatus: () => _sectionStatus,
        onOpen: (sectionEl) => {
            sectionEl.innerHTML = '<div class="sync-dropdown-loading"><i class="fa-solid fa-spinner fa-spin"></i> Checking...</div>';
            const dropdown = document.getElementById('notificationsDropdown');
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
        },
    });

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
    updateWarningIndicator,
};
