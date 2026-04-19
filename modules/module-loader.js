/**
 * Module Loader for SillyTavern Character Library
 *
 * Two-tier initialization:
 *   Tier 1 — Loaded immediately (critical for Characters grid / detail modal)
 *   Tier 2 — Lazily loaded on first use via proxy stubs
 */

import ProviderRegistry from './providers/provider-registry.js';
import CoreAPI from './core-api.js';


// ========================================
// CSS LOADER
// ========================================

const MODULE_CSS_VERSION = 5;

function loadModuleCSS(path) {
    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        const url = new URL(path, import.meta.url);
        url.searchParams.set('v', MODULE_CSS_VERSION);
        link.href = url.href;
        link.onload = resolve;
        link.onerror = resolve;
        document.head.appendChild(link);
    });
}


// ========================================
// LAZY BRIDGE HELPERS
// ========================================

/**
 * Creates a group of window.* bridges that share a single dynamic import.
 * On first invocation of ANY bridge in the group the module is imported once;
 * setupFn then replaces every stub with the real function so subsequent calls
 * go straight through with zero overhead.
 */
function createLazyBridgeGroup(importFn, setupFn) {
    let loading = null;

    function ensureLoaded() {
        if (!loading) {
            loading = importFn().then(mod => {
                setupFn(mod);
                return mod;
            }).catch(err => {
                console.error('[ModuleLoader] Lazy load failed:', err);
                loading = null;
                throw err;
            });
        }
        return loading;
    }

    /**
     * Returns a stub that, on call, triggers the shared import then resolves
     * getTarget() — which by that point has been replaced with the real
     * function by setupFn — and forwards the original arguments.
     */
    function createStub(getTarget) {
        return function (...args) {
            return ensureLoaded().then(() => {
                const realFn = getTarget();
                if (typeof realFn === 'function') {
                    return realFn(...args);
                }
            });
        };
    }

    return { ensureLoaded, createStub };
}


// ========================================
// MODULE REGISTRY
// ========================================

const ModuleLoader = {
    modules: {},
    _lazyLoaders: {},
    _lazyPromises: {},
    initialized: false,

    register(name, module) {
        this.modules[name] = module;
        delete this._lazyLoaders[name];
        console.log(`[ModuleLoader] Registered module: ${name}`);
    },

    async initAll(dependencies) {
        for (const [name, module] of Object.entries(this.modules)) {
            try {
                if (module.init && !module._mlInitDone) {
                    await module.init(dependencies);
                    module._mlInitDone = true;
                    console.log(`[ModuleLoader] Initialized module: ${name}`);
                }
            } catch (err) {
                console.error(`[ModuleLoader] Failed to initialize module: ${name}`, err);
            }
        }
        this.initialized = true;
    },

    get(name) {
        if (this.modules[name]) return this.modules[name];
        if (this._lazyLoaders[name]) return this._createLazyProxy(name);
        return null;
    },

    async ensureLoaded(name) {
        if (this.modules[name]) return this.modules[name];
        const loader = this._lazyLoaders[name];
        if (loader) {
            await loader();
            return this.modules[name];
        }
        return null;
    },

    _registerLazy(name, loadFn) {
        this._lazyLoaders[name] = () => {
            if (!this._lazyPromises[name]) {
                this._lazyPromises[name] = loadFn().catch(err => {
                    console.error(`[ModuleLoader] Lazy load of '${name}' failed:`, err);
                    delete this._lazyPromises[name];
                    throw err;
                });
            }
            return this._lazyPromises[name];
        };
    },

    /**
     * Returns a Proxy whose property accesses produce async stub functions.
     * Callers like:
     *     const mod = CoreAPI.getModule('batch-tagging');
     *     if (mod?.openModal) { mod.openModal(); }
     * transparently trigger the lazy import on first method call.
     */
    _createLazyProxy(name) {
        const self = this;
        return new Proxy({}, {
            get(target, prop) {
                if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) {
                    return undefined;
                }
                return function (...args) {
                    return self.ensureLoaded(name).then(mod => {
                        if (mod && typeof mod[prop] === 'function') {
                            return mod[prop](...args);
                        }
                    });
                };
            }
        });
    }
};


// ========================================
// INITIALIZATION
// ========================================

async function initModuleSystem() {
    console.log('[ModuleLoader] Initializing module system...');

    const dependencies = {};

    // ============================
    // TIER 1 — Immediate modules
    // ============================

    try {
        const multiSelectModule = await import('./multi-select.js');
        loadModuleCSS('./multi-select.css');
        ModuleLoader.register('multi-select', multiSelectModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load multi-select module:', err);
    }

    try {
        const contextMenuModule = await import('./context-menu.js');
        loadModuleCSS('./context-menu.css');
        ModuleLoader.register('context-menu', contextMenuModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load context-menu module:', err);
    }

    try {
        const galleryViewerModule = await import('./gallery-viewer.js');
        loadModuleCSS('./gallery-viewer.css');
        ModuleLoader.register('gallery-viewer', galleryViewerModule.default);

        window.openGalleryViewer = galleryViewerModule.openViewer;
        window.openGalleryViewerWithImages = galleryViewerModule.openViewerWithImages;
        window.closeGalleryViewer = galleryViewerModule.closeViewer;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-viewer module:', err);
    }

    try {
        const charVersionsModule = await import('./character-versions.js');
        loadModuleCSS('./character-versions.css');
        ModuleLoader.register('character-versions', charVersionsModule.default);

        window.openCharVersionHistory = charVersionsModule.openVersionHistory;
        window.renderVersionsPane = charVersionsModule.renderVersionsPane;
        window.cleanupVersionsPane = charVersionsModule.cleanupVersionsPane;
        window.autoSnapshotBeforeChange = charVersionsModule.autoSnapshotBeforeChange;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load character-versions module:', err);
    }

    try {
        loadModuleCSS('./card-updates.css');
        const cardUpdatesModule = await import('./card-updates.js');
        ModuleLoader.register('card-updates', cardUpdatesModule.default);

        window.checkCardUpdates = cardUpdatesModule.checkSingleCharacter;
        window.checkAllCardUpdates = cardUpdatesModule.checkAllLinkedCharacters;
        window.checkSelectedCardUpdates = cardUpdatesModule.checkSelectedCharacters;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load card-updates module:', err);
    }

    try {
        loadModuleCSS('./gallery-sync.css');
        const gallerySyncModule = await import('./gallery-sync.js');
        ModuleLoader.register('gallery-sync', gallerySyncModule.default);

        window.auditGalleryIntegrity = gallerySyncModule.auditGalleryIntegrity;
        window.fullGallerySync = gallerySyncModule.fullSync;
        window.cleanupOrphanedMappings = gallerySyncModule.cleanupOrphanedMappings;
        window.updateGallerySyncWarning = gallerySyncModule.updateWarningIndicator;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-sync module:', err);
    }

    try {
        loadModuleCSS('./recommender.css');
        const recommenderModule = await import('./recommender.js');
        ModuleLoader.register('recommender', recommenderModule.default);

        window.openRecommender = recommenderModule.openModal;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load recommender module:', err);
    }

    try {
        loadModuleCSS('./character-creator.css');
        const creatorModule = await import('./character-creator.js');
        ModuleLoader.register('character-creator', creatorModule.default);

        window.openCharacterCreator = creatorModule.openModal;
        window.closeCharacterCreator = creatorModule.closeModal;
        window.closeAiStudio = creatorModule.closeStudio;
        window.closeNotesPreview = creatorModule.closeNotesPreview;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load character-creator module:', err);
    }

    try {
        loadModuleCSS('./playlists.css');
        const playlistsModule = await import('./playlists.js');
        ModuleLoader.register('playlists', playlistsModule.default);

        window.playlistsLoadPlaylists = playlistsModule.loadPlaylists;
        window.playlistsCreatePlaylist = playlistsModule.createPlaylist;
        window.playlistsDeletePlaylist = playlistsModule.deletePlaylist;
        window.playlistsUpdatePlaylist = playlistsModule.updatePlaylist;
        window.playlistsAddToPlaylist = playlistsModule.addToPlaylist;
        window.playlistsRemoveFromPlaylist = playlistsModule.removeFromPlaylist;
        window.playlistsReorderPlaylists = playlistsModule.reorderPlaylists;
        window.playlistsGetAll = playlistsModule.getAllPlaylists;
        window.playlistsGetPlaylist = playlistsModule.getPlaylist;
        window.playlistsGetCharacters = playlistsModule.getPlaylistCharacters;
        window.playlistsGetAvatarSet = playlistsModule.getPlaylistAvatarSet;
        window.playlistsGetForChar = playlistsModule.getPlaylistsForChar;
        window.playlistsIsCharInPlaylist = playlistsModule.isCharInPlaylist;
        window.playlistsIsCharInAny = playlistsModule.isCharInAnyPlaylist;
        window.playlistsOnCharDeleted = playlistsModule.onCharacterDeleted;
        window.playlistsPruneDeleted = playlistsModule.pruneDeletedCharacters;
        window.openPlaylistPicker = playlistsModule.openPlaylistPicker;
        window.closePlaylistPicker = playlistsModule.closePlaylistPicker;
        window.openPlaylistManager = playlistsModule.openPlaylistManager;
        window.closePlaylistManager = playlistsModule.closePlaylistManager;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load playlists module:', err);
    }

    // Providers — must be Tier 1 because ProviderRegistry is queried
    // during character grid rendering (link indicators, taglines, etc.)
    loadModuleCSS('./providers/browse-shared.css');
    loadModuleCSS('./providers/chub/chub-browse.css');
    loadModuleCSS('./providers/janny/janny-browse.css');
    loadModuleCSS('./providers/chartavern/chartavern-browse.css');
    loadModuleCSS('./providers/pygmalion/pygmalion-browse.css');
    loadModuleCSS('./providers/wyvern/wyvern-browse.css');
    loadModuleCSS('./providers/datacat/datacat-browse.css');
    {
        const providerImports = [
            { name: 'chub', load: () => import('./providers/chub/chub-provider.js') },
            { name: 'janny', load: () => import('./providers/janny/janny-provider.js') },
            { name: 'chartavern', load: () => import('./providers/chartavern/chartavern-provider.js') },
            { name: 'pygmalion', load: () => import('./providers/pygmalion/pygmalion-provider.js') },
            { name: 'wyvern', load: () => import('./providers/wyvern/wyvern-provider.js') },
            { name: 'datacat', load: () => import('./providers/datacat/datacat-provider.js') },
        ];
        const results = await Promise.allSettled(providerImports.map(p => p.load()));
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled') {
                ProviderRegistry.registerProvider(results[i].value.default);
            } else {
                console.warn(`[ModuleLoader] Failed to load ${providerImports[i].name} provider:`, results[i].reason);
            }
        }
        try {
            await ProviderRegistry.initProviders(CoreAPI);
        } catch (err) {
            console.warn('[ModuleLoader] Provider initialization error:', err);
        }
        window.ProviderRegistry = ProviderRegistry;
        window.closeActiveBrowseDropdowns = ProviderRegistry.closeActiveBrowseDropdowns;
        console.log(`[ModuleLoader] Providers registered and initialized (${ProviderRegistry.getAllProviders().length}/${providerImports.length})`);
    }

    // ============================
    // TIER 2 — Lazy modules
    // ============================

    setupLazyBatchTagging();
    loadModuleCSS('./chats.css');
    setupLazyChats();

    // Initialize all Tier 1 modules
    await ModuleLoader.initAll(dependencies);

    console.log('[ModuleLoader] Module system ready');
}


// ========================================
// LAZY: BATCH TAGGING
// ========================================

function setupLazyBatchTagging() {
    ModuleLoader._registerLazy('batch-tagging', async () => {
        const mod = await import('./batch-tagging.js');
        loadModuleCSS('./batch-tagging.css');
        ModuleLoader.register('batch-tagging', mod.default);
        await mod.default.init({});
        mod.default._mlInitDone = true;
        console.log('[ModuleLoader] Lazy-loaded batch-tagging');
    });
}


// ========================================
// LAZY: CHATS
// ========================================

function setupLazyChats() {
    const { createStub } = createLazyBridgeGroup(
        () => import('./chats.js'),
        (mod) => {
            const chats = mod.default;
            ModuleLoader.register('chats', chats);
            chats.init({});
            chats._mlInitDone = true;

            window.chatsModule = {
                fetchCharacterChats: chats.fetchCharacterChats,
                openChat: chats.openChat,
                deleteChat: chats.deleteChat,
                createNewChat: chats.createNewChat,
                loadAllChats: chats.loadAllChats,
                renderChats: chats.renderChats,
                clearChatCache: chats.clearChatCache,
                openChatPreview: chats.openChatPreview,
            };

            window.fetchCharacterChats = chats.fetchCharacterChats;
            window.createNewChat = chats.createNewChat;
            window.openChat = chats.openChat;
            window.deleteChat = chats.deleteChat;

            console.log('[ModuleLoader] Lazy-loaded chats');
        }
    );

    const chatStub = (method) => createStub(() => window.chatsModule?.[method]);

    window.chatsModule = {
        fetchCharacterChats: chatStub('fetchCharacterChats'),
        openChat: chatStub('openChat'),
        deleteChat: chatStub('deleteChat'),
        createNewChat: chatStub('createNewChat'),
        loadAllChats: chatStub('loadAllChats'),
        renderChats: chatStub('renderChats'),
        clearChatCache: chatStub('clearChatCache'),
        openChatPreview: chatStub('openChatPreview'),
    };

    window.fetchCharacterChats = chatStub('fetchCharacterChats');
    window.createNewChat = chatStub('createNewChat');
    window.openChat = chatStub('openChat');
    window.deleteChat = chatStub('deleteChat');
}


// ========================================
// EXPOSE & BOOTSTRAP
// ========================================

window.ModuleLoader = ModuleLoader;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModuleSystem);
} else {
    setTimeout(initModuleSystem, 100);
}
