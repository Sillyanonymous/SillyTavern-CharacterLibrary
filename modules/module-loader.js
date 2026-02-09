/**
 * Module Loader for SillyTavern Character Library
 * Handles initialization of external modules and provides bridge to gallery.js
 * 
 * This file is loaded after gallery.js and initializes additional feature modules
 */


// ========================================
// MODULE REGISTRY
// ========================================

const ModuleLoader = {
    modules: {},
    initialized: false,
    
    /**
     * Register a module
     * @param {string} name - Module name
     * @param {Object} module - Module object with init function
     */
    register(name, module) {
        this.modules[name] = module;
        console.log(`[ModuleLoader] Registered module: ${name}`);
    },
    
    /**
     * Initialize all registered modules
     * @param {Object} dependencies - Shared dependencies from gallery.js
     */
    async initAll(dependencies) {
        for (const [name, module] of Object.entries(this.modules)) {
            try {
                if (module.init) {
                    await module.init(dependencies);
                    console.log(`[ModuleLoader] Initialized module: ${name}`);
                }
            } catch (err) {
                console.error(`[ModuleLoader] Failed to initialize module: ${name}`, err);
            }
        }
        this.initialized = true;
    },
    
    /**
     * Get a registered module
     * @param {string} name - Module name
     * @returns {Object|null} Module or null if not found
     */
    get(name) {
        return this.modules[name] || null;
    }
};

// ========================================
// INITIALIZATION
// ========================================

async function initModuleSystem() {
    console.log('[ModuleLoader] Initializing module system...');
    
    // Modules now use CoreAPI directly, but we still pass a minimal deps object
    // for backwards compatibility during transition
    const dependencies = {};
    
    // Dynamically import modules
    try {
        const multiSelectModule = await import('./multi-select.js');
        ModuleLoader.register('multi-select', multiSelectModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load multi-select module:', err);
    }

    try {
        const batchTaggingModule = await import('./batch-tagging.js');
        ModuleLoader.register('batch-tagging', batchTaggingModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load batch-tagging module:', err);
    }
    
    try {
        const contextMenuModule = await import('./context-menu.js');
        ModuleLoader.register('context-menu', contextMenuModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load context-menu module:', err);
    }
    
    try {
        const galleryViewerModule = await import('./gallery-viewer.js');
        ModuleLoader.register('gallery-viewer', galleryViewerModule.default);
        
        // Expose gallery viewer functions for library.js to use
        window.openGalleryViewer = galleryViewerModule.openViewer;
        window.openGalleryViewerWithImages = galleryViewerModule.openViewerWithImages;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-viewer module:', err);
    }
    
    try {
        const cardUpdatesModule = await import('./card-updates.js');
        ModuleLoader.register('card-updates', cardUpdatesModule.default);
        
        // Expose card updates functions for library.js to use
        window.checkCardUpdates = cardUpdatesModule.checkSingleCharacter;
        window.checkAllCardUpdates = cardUpdatesModule.checkAllLinkedCharacters;
        window.checkSelectedCardUpdates = cardUpdatesModule.checkSelectedCharacters;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load card-updates module:', err);
    }
    
    try {
        const gallerySyncModule = await import('./gallery-sync.js');
        ModuleLoader.register('gallery-sync', gallerySyncModule.default);
        
        // Expose gallery sync functions for library.js to use
        window.auditGalleryIntegrity = gallerySyncModule.auditGalleryIntegrity;
        window.fullGallerySync = gallerySyncModule.fullSync;
        window.cleanupOrphanedMappings = gallerySyncModule.cleanupOrphanedMappings;
        window.updateGallerySyncWarning = gallerySyncModule.updateWarningIndicator;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-sync module:', err);
    }
    
    // Initialize all modules
    await ModuleLoader.initAll(dependencies);
    
    console.log('[ModuleLoader] Module system ready');
}

window.ModuleLoader = ModuleLoader;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModuleSystem);
} else {
    // DOM already loaded, init immediately
    setTimeout(initModuleSystem, 100); // Small delay to ensure gallery.js is ready
}
