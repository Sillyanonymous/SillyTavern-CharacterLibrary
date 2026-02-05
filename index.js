const EXTENSION_NAME = "Character Library";
const EXTENSION_DIR = "SillyTavern-CharacterLibrary";

// Helper to get the correct path for this extension
function getExtensionUrl() {
    // Try to find the script tag that loaded this extension to get the base path
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.includes(EXTENSION_DIR)) {
            const path = scripts[i].src;
            // Return the directory containing index.js
            return path.substring(0, path.lastIndexOf('/'));
        }
    }
    // Fallback if script tag search fails (e.g. if loaded via eval or blob)
    return `scripts/extensions/third-party/${EXTENSION_DIR}`;
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

async function getCsrfToken() {
    try {
        const response = await fetch('/csrf-token');
        if (response.ok) {
            const data = await response.json();
            return data.token;
        }
    } catch (e) {
        console.error('Failed to fetch CSRF token', e);
    }
    // Fallback to cookie if fetch fails, though likely undefined if fetch failed
    return getCookie('X-CSRF-Token');
}

async function openGallery() {
    const baseUrl = getExtensionUrl();
    const token = await getCsrfToken();
    // Pass token in URL to be safe, though cookies should work cross-tab on same origin
    const url = `${baseUrl}/app/library.html?csrf=${encodeURIComponent(token)}`;
    window.open(url, '_blank');
}

jQuery(async () => {
    // add a delay to ensure the UI is loaded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const galleryBtn = $(`
    <div id="st-gallery-btn" class="interactable" title="Open Character Library" style="cursor: pointer; display: flex; align-items: center; justify-content: center; height: 100%; padding: 0 10px;">
        <i class="fa-solid fa-photo-film" style="font-size: 1.2em;"></i>
    </div>
    `);

    // Event listener
    galleryBtn.on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openGallery();
    });

    // Injection Strategy: Place after the Character Management panel (rightNavHolder) for better centering
    // Priority: After character panel drawer, or in top-settings-holder center area
    let injected = false;
    
    // Try to insert after the Character Management drawer (rightNavHolder)
    const rightNavHolder = $('#rightNavHolder');
    if (rightNavHolder.length) {
        rightNavHolder.after(galleryBtn);
        console.log(`${EXTENSION_NAME}: Added after #rightNavHolder (Character Management)`);
        injected = true;
    }
    
    // Fallback to other locations
    if (!injected) {
        const fallbackTargets = [
            '#top-settings-holder',   // Settings container
            '#top-bar',               // Direct top bar
        ];
        
        for (const selector of fallbackTargets) {
            const target = $(selector);
            if (target.length) {
                // Insert in middle of container for better centering
                const children = target.children();
                if (children.length > 1) {
                    // Insert after first half of children
                    const midPoint = Math.floor(children.length / 2);
                    $(children[midPoint]).after(galleryBtn);
                } else {
                    target.append(galleryBtn);
                }
                console.log(`${EXTENSION_NAME}: Added to ${selector}`);
                injected = true;
                break;
            }
        }
    }
    
    if (!injected) {
         console.warn(`${EXTENSION_NAME}: Could not find Top Bar. Creating floating button.`);
         galleryBtn.css({
             'position': 'fixed',
             'top': '2px', // Align with top bar
             'right': '250px', // Move it left of the hamburger/drawer
             'z-index': '20000',
             'background': 'rgba(0,0,0,0.5)',
             'border': '1px solid rgba(255,255,255,0.2)',
             'padding': '5px',
             'height': '40px',
             'width': '40px',
             'display': 'flex',
             'align-items': 'center',
             'justify-content': 'center',
             'border-radius': '5px'
         });
         // Add to body
         $('body').append(galleryBtn);
    }
    
    // Fallback: Add a slash command
    if (window.SlashCommandParser) {
        window.SlashCommandParser.addCommandObject(Interact.SlashCommand.fromProps({
            name: 'gallery',
            helpString: 'Open the Character Library',
            callback: openGallery
        }));
    }
    
    // ==============================================
    // Media Localization in SillyTavern Chat
    // ==============================================
    
    // Initialize media localization for chat messages
    initMediaLocalizationInChat();
    
    console.log(`${EXTENSION_NAME}: Loaded successfully.`);
});

// ==============================================
// Media Localization Functions for SillyTavern Chat
// ==============================================

const SETTINGS_KEY = 'SillyTavernCharacterGallery';

// Cache for URL→LocalPath mappings per character avatar
const chatMediaLocalizationCache = {};

/**
 * Get our extension settings from SillyTavern's context
 */
function getExtensionSettings() {
    try {
        const context = SillyTavern?.getContext?.();
        if (context?.extensionSettings?.[SETTINGS_KEY]) {
            return context.extensionSettings[SETTINGS_KEY];
        }
    } catch (e) {
        console.warn('[CharLib] Could not access extension settings:', e);
    }
    return {};
}

/**
 * Check if media localization is enabled for a character
 */
function isMediaLocalizationEnabledForChat(avatar) {
    const settings = getExtensionSettings();
    // Default to true if not explicitly set (matching gallery.js DEFAULT_SETTINGS)
    const globalEnabled = settings.mediaLocalizationEnabled !== false;
    const perCharSettings = settings.mediaLocalizationPerChar || {};
    
    // Check per-character override first
    if (avatar && avatar in perCharSettings) {
        return perCharSettings[avatar];
    }
    
    return globalEnabled;
}

/**
 * Sanitize folder name to match SillyTavern's folder naming convention
 */
function sanitizeFolderName(name) {
    if (!name) return '';
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

/**
 * Get the gallery folder name for a character
 * Checks for unique folder override first, then falls back to character name
 * @param {object} character - Character object with name and avatar
 * @returns {string} The folder name to use
 */
function getGalleryFolderForCharacter(character) {
    if (!character) return '';
    
    try {
        const context = SillyTavern?.getContext?.();
        
        // Check for gallery folder override (unique folder)
        const overrideFolders = context?.extensionSettings?.gallery?.folders;
        if (overrideFolders && character.avatar && overrideFolders[character.avatar]) {
            return overrideFolders[character.avatar];
        }
    } catch (e) {
        // Fall through to default
    }
    
    // Default to character name
    return sanitizeFolderName(character.name || '');
}

/**
 * Sanitize media filename the same way gallery.js does
 */
function sanitizeMediaFilename(filename) {
    const nameWithoutExt = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
    return nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}

/**
 * Extract filename from URL
 */
function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        return pathParts[pathParts.length - 1] || '';
    } catch (e) {
        const parts = url.split('/');
        return parts[parts.length - 1]?.split('?')[0] || '';
    }
}

/**
 * Build URL→LocalPath mapping for a character by scanning their gallery folder
 * @param {object} character - Full character object
 */
async function buildChatMediaLocalizationMap(character) {
    const avatar = character?.avatar;
    
    // Get the correct folder name (may be unique folder with UUID suffix)
    const folderName = getGalleryFolderForCharacter(character);
    if (!folderName) {
        return {};
    }
    
    // Cache key includes folder name to handle cases where override is registered after first call
    const cacheKey = avatar ? `${avatar}::${folderName}` : null;
    
    // Check cache first
    if (cacheKey && chatMediaLocalizationCache[cacheKey]) {
        return chatMediaLocalizationCache[cacheKey];
    }
    
    const urlMap = {};
    
    try {
        // Get CSRF token properly
        const csrfToken = await getCsrfToken();
        
        // Get list of files in character's gallery
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ folder: folderName, type: 7 }) // 7 = all media types
        });
        
        if (!response.ok) {
            return urlMap;
        }
        
        const files = await response.json();
        if (!files || files.length === 0) {
            // Don't cache empty results - folder override may not be registered yet
            return urlMap;
        }
        
        // Parse localized_media files
        const localizedPattern = /^localized_media_\d+_(.+)\.[^.]+$/;
        let localizedCount = 0;
        
        for (const file of files) {
            const fileName = (typeof file === 'string') ? file : file.name;
            if (!fileName) continue;
            
            const match = fileName.match(localizedPattern);
            if (match) {
                const sanitizedName = match[1];
                const localPath = `/user/images/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`;
                urlMap[`__sanitized__${sanitizedName}`] = localPath;
                localizedCount++;
            }
        }
        
        // Only cache if we found localized files - don't cache empty results
        if (cacheKey && localizedCount > 0) {
            chatMediaLocalizationCache[cacheKey] = urlMap;
        }
        
        return urlMap;
        
    } catch (error) {
        console.error('[CharLib] Error building localization map:', error);
        return urlMap;
    }
}

/**
 * Look up a remote URL and return local path if found
 */
function lookupLocalizedMediaForChat(urlMap, remoteUrl) {
    if (!urlMap || !remoteUrl) return null;
    
    const filename = extractFilenameFromUrl(remoteUrl);
    if (!filename) return null;
    
    const sanitizedName = sanitizeMediaFilename(filename);
    return urlMap[`__sanitized__${sanitizedName}`] || null;
}

/**
 * Apply media localization to a rendered message element
 */
async function localizeMediaInMessage(messageElement, character) {
    if (!character?.avatar || !messageElement) return;
    
    // Check if localization is enabled
    if (!isMediaLocalizationEnabledForChat(character.avatar)) return;
    
    const urlMap = await buildChatMediaLocalizationMap(character);
    
    if (Object.keys(urlMap).length === 0) return; // No localized files
    
    // Find all media elements with remote URLs
    const mediaSelectors = 'img[src^="http"], video source[src^="http"], audio source[src^="http"], video[src^="http"], audio[src^="http"]';
    const mediaElements = messageElement.querySelectorAll(mediaSelectors);
    
    let replacedCount = 0;
    
    for (const el of mediaElements) {
        const src = el.getAttribute('src');
        if (!src) continue;
        
        const localPath = lookupLocalizedMediaForChat(urlMap, src);
        if (localPath) {
            el.setAttribute('src', localPath);
            replacedCount++;
        }
    }
}

/**
 * Initialize media localization hooks for SillyTavern chat
 */
function initMediaLocalizationInChat() {
    try {
        // Check if SillyTavern global is available
        if (typeof SillyTavern === 'undefined') {
            setTimeout(initMediaLocalizationInChat, 1000);
            return;
        }
        
        const context = SillyTavern.getContext?.();
        if (!context || !context.eventSource || !context.event_types) {
            setTimeout(initMediaLocalizationInChat, 1000);
            return;
        }
        
        const { eventSource, event_types } = context;
        
        // Listen for character messages being rendered
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            try {
                // Get fresh context each time (characterId may have changed)
                const currentContext = SillyTavern.getContext();
                
                // Get the message element
                const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
                if (!messageElement) return;
                
                // Get current character
                const charId = currentContext.characterId;
                if (charId === undefined || charId === null) return;
                
                const character = currentContext.characters[charId];
                if (!character) return;
                
                // Apply localization
                await localizeMediaInMessage(messageElement.querySelector('.mes_text'), character);
            } catch (e) {
                console.error('[CharLib] Error in CHARACTER_MESSAGE_RENDERED handler:', e);
            }
        });
        
        // Also listen for user messages (in case they contain media)
        eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
            try {
                const currentContext = SillyTavern.getContext();
                
                const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
                if (!messageElement) return;
                
                const charId = currentContext.characterId;
                if (charId === undefined || charId === null) return;
                
                const character = currentContext.characters[charId];
                if (!character) return;
                
                await localizeMediaInMessage(messageElement.querySelector('.mes_text'), character);
            } catch (e) {
                console.error('[CharLib] Error in USER_MESSAGE_RENDERED handler:', e);
            }
        });
        
        // Listen for chat changes to clear cache
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Clear cache when switching chats/characters
            Object.keys(chatMediaLocalizationCache).forEach(key => delete chatMediaLocalizationCache[key]);
            
            // Also localize creator's notes and other character info when chat changes
            setTimeout(() => localizeCharacterInfoPanels(), 500);
        });
        
        // Listen for message swipes to re-localize the swiped content
        eventSource.on(event_types.MESSAGE_SWIPED, async (messageId) => {
            try {
                const currentContext = SillyTavern.getContext();
                
                const charId = currentContext.characterId;
                if (charId === undefined || charId === null) return;
                
                const character = currentContext.characters[charId];
                if (!character) return;
                
                // Function to localize the message
                const doLocalize = async () => {
                    // Re-query the element each time as ST may have replaced it
                    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
                    if (!messageElement) return;
                    
                    const mesText = messageElement.querySelector('.mes_text');
                    if (mesText) {
                        await localizeMediaInMessage(mesText, character);
                    }
                };
                
                // Multiple attempts with increasing delays to catch ST's re-render
                setTimeout(doLocalize, 50);
                setTimeout(doLocalize, 150);
                setTimeout(doLocalize, 300);
                setTimeout(doLocalize, 600);
            } catch (e) {
                console.error('[CharLib] Error in MESSAGE_SWIPED handler:', e);
            }
        });
        
        // Listen for character selected event to localize info panels
        if (event_types.CHARACTER_EDITED) {
            eventSource.on(event_types.CHARACTER_EDITED, () => {
                setTimeout(() => localizeCharacterInfoPanels(), 300);
            });
        }
        
    } catch (e) {
        console.error('[CharLib] Failed to initialize media localization:', e);
    }
}

/**
 * Localize media in character info panels (creator's notes, description, etc.)
 * These are displayed outside of chat messages in various UI panels
 */
async function localizeCharacterInfoPanels() {
    try {
        const context = SillyTavern.getContext?.();
        if (!context) return;
        
        const charId = context.characterId;
        if (charId === undefined || charId === null) return;
        
        const character = context.characters?.[charId];
        if (!character?.avatar) return;
        
        // Check if localization is enabled for this character
        if (!isMediaLocalizationEnabledForChat(character.avatar)) return;
        
        // Build the URL map
        const urlMap = await buildChatMediaLocalizationMap(character);
        if (Object.keys(urlMap).length === 0) return;
        
        // Selectors for ST panels that might contain character info with images
        const panelSelectors = [
            '.inline-drawer-content',     // Content drawers (creator notes, etc.)
            '#description_div',
            '#creator_notes_div',
            '#character_popup',
            '#char_notes',
            '#firstmessage_div',
            '.character_description',
            '.creator_notes',
            '#mes_example_div',
            '.mes_narration',
            '.swipe_right',               // Alternate greetings swipe area
            '#alternate_greetings',       // Alt greetings container
            '.alternate_greeting',        // Individual alt greeting
            '.greeting_text',             // Greeting text content
        ];
        
        for (const selector of panelSelectors) {
            const panels = document.querySelectorAll(selector);
            for (const panel of panels) {
                if (!panel) continue;
                
                // Find all remote media in this panel
                const mediaElements = panel.querySelectorAll(
                    'img[src^="http"], video source[src^="http"], audio source[src^="http"], video[src^="http"], audio[src^="http"]'
                );
                
                for (const el of mediaElements) {
                    const src = el.getAttribute('src');
                    if (!src) continue;
                    
                    const localPath = lookupLocalizedMediaForChat(urlMap, src);
                    if (localPath) {
                        el.setAttribute('src', localPath);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[CharLib] Error localizing character info panels:', e);
    }
}
