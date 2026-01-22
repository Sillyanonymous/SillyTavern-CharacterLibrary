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
    const url = `${baseUrl}/gallery.html?csrf=${encodeURIComponent(token)}`;
    window.open(url, '_blank');
}

jQuery(async () => {
    console.log(`${EXTENSION_NAME}: Initializing...`);
    
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
    
    console.log(`${EXTENSION_NAME}: Loaded successfully.`);
});
