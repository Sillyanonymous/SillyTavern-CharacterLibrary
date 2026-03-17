// Provider Registry — manages external source providers for the Online tab

/** @type {Map<string, import('./provider-interface.js').ProviderBase>} */
const providers = new Map();

/** @type {string|null} */
let activeProviderId = null;

/** @type {Object|null} CoreAPI reference, set during init */
let coreAPI = null;

// ========================================
// REGISTRATION
// ========================================

/**
 * Register a provider instance. Call this during module loading, before init.
 * @param {import('./provider-interface.js').ProviderBase} provider
 */
export function registerProvider(provider) {
    if (!provider?.id) {
        console.error('[ProviderRegistry] Cannot register provider without id');
        return;
    }
    if (providers.has(provider.id)) {
        console.warn(`[ProviderRegistry] Provider "${provider.id}" already registered, replacing`);
    }
    providers.set(provider.id, provider);
    coreAPI?.debugLog(`[ProviderRegistry] Registered provider: ${provider.name} (${provider.id})`);
}

/**
 * Initialize all registered providers with the CoreAPI reference.
 * Called once during app startup after CoreAPI is available.
 * @param {Object} api — CoreAPI object
 */
export async function initProviders(api) {
    coreAPI = api;
    for (const [id, provider] of providers) {
        try {
            await provider.init(api);
            if (provider.browseView) provider.browseView.provider = provider;
            coreAPI.debugLog(`[ProviderRegistry] Initialized provider: ${id}`);
        } catch (err) {
            console.error(`[ProviderRegistry] Failed to init provider "${id}":`, err);
        }
    }
    initRecoveryBannerDismiss();
}

// ========================================
// PROVIDER ACCESS
// ========================================

/**
 * Get a provider by ID.
 * @param {string} id
 * @returns {import('./provider-interface.js').ProviderBase|undefined}
 */
export function getProvider(id) {
    return providers.get(id);
}

/**
 * Get all registered providers.
 * @returns {import('./provider-interface.js').ProviderBase[]}
 */
export function getAllProviders() {
    return [...providers.values()];
}

/**
 * Get providers that have a browsable view, respecting saved order.
 * @returns {import('./provider-interface.js').ProviderBase[]}
 */
export function getViewProviders() {
    const all = getAllProviders().filter(p => p.hasView);
    const savedOrder = coreAPI?.getSetting?.('providerOrder');
    if (!Array.isArray(savedOrder) || savedOrder.length === 0) return all;

    const byId = new Map(all.map(p => [p.id, p]));
    const ordered = [];
    for (const id of savedOrder) {
        const p = byId.get(id);
        if (p) {
            ordered.push(p);
            byId.delete(id);
        }
    }
    // Append any providers not in saved order (newly added)
    for (const p of byId.values()) ordered.push(p);
    return ordered;
}

/**
 * Get the currently active provider (the one visible in the Online tab).
 * @returns {import('./provider-interface.js').ProviderBase|null}
 */
export function getActiveProvider() {
    return activeProviderId ? providers.get(activeProviderId) ?? null : null;
}

/**
 * Get the active provider's ID.
 * @returns {string|null}
 */
export function getActiveProviderId() {
    return activeProviderId;
}

// ========================================
// ACTIVATION / DEACTIVATION
// ========================================

/**
 * Switch the Online tab to a specific provider. Deactivates the previous one.
 * Called by the Online tab's provider selector UI.
 * @param {string} providerId
 * @param {HTMLElement} container — the provider content area
 * @param {HTMLElement} [filterContainer] — the filter bar area
 */
export async function activateProvider(providerId, container, filterContainer) {
    const prev = getActiveProvider();
    const switching = prev && prev.id !== providerId;
    if (switching) {
        try { prev.deactivate(); } catch (e) { console.error('[ProviderRegistry] deactivate error:', e); }
    }

    const provider = providers.get(providerId);
    if (!provider) {
        console.error(`[ProviderRegistry] Provider "${providerId}" not found`);
        return;
    }

    activeProviderId = providerId;

    // Render filter bar — re-render when switching to a different provider
    if (filterContainer) {
        const renderedId = filterContainer.dataset.renderedProvider;
        if (renderedId !== providerId) {
            const filterHtml = provider.renderFilterBar();
            filterContainer.innerHTML = filterHtml || '';
            filterContainer.dataset.renderedProvider = providerId;
        }
    }

    // Render view — re-render when switching to a different provider
    const renderedId = container.dataset.renderedProvider;
    const domRecreated = renderedId !== providerId;
    if (domRecreated) {
        const viewHtml = provider.renderView();
        container.innerHTML = viewHtml || '';
        container.dataset.renderedProvider = providerId;
    }

    // Update provider selector pills if present
    updateProviderSelector(providerId);

    try {
        const providerDefaults = coreAPI?.getSetting?.('providerDefaults') || {};
        const defaults = providerDefaults[providerId] || null;
        await provider.activate(container, { domRecreated, defaults });
    } catch (err) {
        console.error(`[ProviderRegistry] activate error for "${providerId}":`, err);
    }

    // Show recovery banner if extensions are still being recovered (ST lazy loading)
    updateRecoveryBanner();
}

/**
 * Deactivate the current provider (e.g. when leaving the Online tab).
 */
export function deactivateCurrentProvider() {
    const provider = getActiveProvider();
    if (provider) {
        try { provider.deactivate(); } catch (e) { console.error('[ProviderRegistry] deactivate error:', e); }
    }
    hideRecoveryBanner();
}

// ========================================
// GENERIC QUERIES — works across all providers
// ========================================

/**
 * Find which provider owns a character by checking each provider's getLinkInfo.
 * Returns the first match.
 * @param {Object} char — character object
 * @returns {{ provider: import('./provider-interface.js').ProviderBase, linkInfo: import('./provider-interface.js').ProviderLinkInfo }|null}
 */
export function getCharacterProvider(char) {
    for (const provider of providers.values()) {
        const linkInfo = provider.getLinkInfo(char);
        if (linkInfo) {
            return { provider, linkInfo };
        }
    }
    return null;
}

/**
 * Get link info for a character from any provider.
 * @param {Object} char
 * @returns {import('./provider-interface.js').ProviderLinkInfo|null}
 */
export function getLinkInfo(char) {
    return getCharacterProvider(char)?.linkInfo ?? null;
}

/**
 * Get all characters linked to ANY provider.
 * @param {Array} allCharacters
 * @returns {Array<{char: Object, provider: import('./provider-interface.js').ProviderBase, linkInfo: import('./provider-interface.js').ProviderLinkInfo}>}
 */
export function getAllLinkedCharacters(allCharacters) {
    const results = [];
    for (const char of allCharacters) {
        const match = getCharacterProvider(char);
        if (match) {
            results.push({ char, provider: match.provider, linkInfo: match.linkInfo });
        }
    }
    return results;
}

/**
 * Find which provider can handle a given URL.
 * @param {string} url
 * @returns {import('./provider-interface.js').ProviderBase|null}
 */
export function getProviderForUrl(url) {
    for (const provider of providers.values()) {
        if (provider.canHandleUrl(url)) return provider;
    }
    return null;
}

// ========================================
// PROVIDER SELECTOR UI
// ========================================

/**
 * Build the provider selector dropdown HTML. Only shown when 2+ providers
 * have a browsable view. Renders a native `<select>` that library.js will
 * convert into a styled custom dropdown via `initCustomSelect()`.
 *
 * @param {string} activeId — currently active provider ID
 * @returns {string} HTML string (empty if ≤1 view provider)
 */
export function renderProviderSelector(activeId) {
    const vps = getViewProviders();
    if (vps.length < 2) return '';

    const options = vps.map(p => {
        const selected = p.id === activeId ? ' selected' : '';
        const iconUrl = p.iconUrl || '';
        return `<option value="${p.id}"${selected} data-icon-url="${iconUrl}">${p.name}</option>`;
    }).join('');

    return `<select id="providerSelect" class="glass-select">${options}</select>`;
}

/**
 * Update active state on existing provider selector.
 * @param {string} activeId
 */
function updateProviderSelector(activeId) {
    const select = document.getElementById('providerSelect');
    if (select && select.value !== activeId) {
        select.value = activeId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

/**
 * Attach change handler to the provider selector dropdown. Called once after
 * the selector HTML has been injected into the DOM and initCustomSelect() runs.
 * @param {Function} onSwitch — callback(providerId) when user picks a provider
 */
export function initProviderSelector(onSwitch) {
    const select = document.getElementById('providerSelect');
    if (!select) return;

    select.addEventListener('change', () => {
        const id = select.value;
        if (id && id !== activeProviderId) {
            onSwitch(id);
        }
    });

    // Convert to styled dropdown
    coreAPI?.initCustomSelect?.(select);
}

// ========================================
// BROWSE LIBRARY LOOKUP DISPATCHERS
// ========================================

export function rebuildAllBrowseLookups() {
    for (const p of providers.values()) {
        p.browseView?.rebuildLocalLibraryLookup();
    }
}

export function refreshActiveBrowseBadges() {
    getActiveProvider()?.browseView?.refreshInLibraryBadges();
}

// ========================================
// RECOVERY BANNER
// ========================================

let recoveryBannerDismissed = false;

function updateRecoveryBanner() {
    const el = document.getElementById('browseRecoveryBanner');
    if (!el) return;
    if (coreAPI?.isExtensionsRecoveryInProgress?.() && !recoveryBannerDismissed) {
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

export function hideRecoveryBanner() {
    const el = document.getElementById('browseRecoveryBanner');
    if (el) el.classList.add('hidden');
}

function initRecoveryBannerDismiss() {
    document.querySelector('.browse-recovery-dismiss')?.addEventListener('click', () => {
        recoveryBannerDismissed = true;
        hideRecoveryBanner();
    });
}

// ========================================
// BROWSE IMAGE OBSERVER DISPATCHERS
// ========================================

export function disconnectActiveBrowseImageObserver() {
    const provider = getActiveProvider();
    provider?.browseView?.disconnectImageObserver();
}

export function reconnectActiveBrowseImageObserver() {
    const provider = getActiveProvider();
    provider?.browseView?.reconnectImageObserver();
}

// ========================================
// MOBILE INTEGRATION HELPERS
// ========================================

export function getPreviewModalIds() {
    const ids = [];
    for (const provider of providers.values()) {
        const id = provider.browseView?.previewModalId;
        if (id) ids.push(id);
    }
    return ids;
}

export function closeActivePreviewModal() {
    getActiveProvider()?.browseView?.closePreview();
}

export function closeActiveBrowseDropdowns() {
    getActiveProvider()?.browseView?.closeDropdowns();
}

export function getActiveMobileFilterIds() {
    return getActiveProvider()?.browseView?.mobileFilterIds ?? null;
}

export function activeProviderHasModeToggle() {
    return getActiveProvider()?.browseView?.hasModeToggle ?? false;
}

// ========================================
// DEFAULT EXPORT
// ========================================

export default {
    registerProvider,
    initProviders,
    getProvider,
    getAllProviders,
    getViewProviders,
    getActiveProvider,
    getActiveProviderId,
    activateProvider,
    deactivateCurrentProvider,
    getCharacterProvider,
    getLinkInfo,
    getAllLinkedCharacters,
    getProviderForUrl,
    renderProviderSelector,
    initProviderSelector,
    rebuildAllBrowseLookups,
    refreshActiveBrowseBadges,
    hideRecoveryBanner,
    disconnectActiveBrowseImageObserver,
    reconnectActiveBrowseImageObserver,
    getPreviewModalIds,
    closeActivePreviewModal,
    closeActiveBrowseDropdowns,
    getActiveMobileFilterIds,
    activeProviderHasModeToggle
};
