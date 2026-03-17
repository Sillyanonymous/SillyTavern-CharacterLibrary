// Character Creator Module
// Create new characters from scratch with AI-assisted field generation

import * as CoreAPI from './core-api.js';

// ========================================
// CONSTANTS
// ========================================

const GENERATE_ENDPOINTS = [
    '/backends/chat-completions/generate',
    '/openai/generate',
];

const GENERATE_TIMEOUT_MS = 90_000;

const SOURCE_MODEL_KEY = {
    openai: 'openai_model', claude: 'claude_model', openrouter: 'openrouter_model',
    ai21: 'ai21_model', makersuite: 'google_model', vertexai: 'vertexai_model',
    mistralai: 'mistralai_model', custom: 'custom_model', cohere: 'cohere_model',
    perplexity: 'perplexity_model', groq: 'groq_model', siliconflow: 'siliconflow_model',
    electronhub: 'electronhub_model', chutes: 'chutes_model', nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model', aimlapi: 'aimlapi_model', xai: 'xai_model',
    pollinations: 'pollinations_model', cometapi: 'cometapi_model', moonshot: 'moonshot_model',
    fireworks: 'fireworks_model', azure_openai: 'azure_openai_model', zai: 'zai_model',
};

const FIELD_PROMPTS = {
    description: {
        label: 'Description',
        system: `You write character descriptions for AI roleplay characters. Write in second person ("You are...") or third person depending on what fits. Be detailed, creative, and vivid. Include personality traits, appearance, backstory, and mannerisms. Do not use markdown headers. Write plain prose with natural paragraph breaks.`,
    },
    personality: {
        label: 'Personality',
        system: `You write concise personality summaries for AI roleplay characters. List key traits, behaviors, speech patterns, and quirks. Be specific, not generic. Keep it under 200 words. Do not use markdown. Write as comma-separated traits or short phrases.`,
    },
    scenario: {
        label: 'Scenario',
        system: `You write scenario/setting descriptions for AI roleplay characters. Describe the current situation, where the characters are, and what is happening. Write in second person ("You are in..."). Keep it concise but atmospheric. Do not use markdown headers.`,
    },
    first_mes: {
        label: 'First Message',
        system: `You write opening roleplay messages from AI characters. Write in-character as the character speaking/acting. Use *asterisks* for actions and narration. Be evocative and set the scene. The message should invite engagement and give the user something to respond to. Do not include the user's response. Do not use markdown headers.`,
    },
    mes_example: {
        label: 'Example Dialogue',
        system: `You write example dialogue for AI roleplay characters. Use the format:\n<START>\n{{user}}: [user message]\n{{char}}: [character response with *actions*]\n\nWrite 2-3 exchanges that showcase the character's speech patterns, personality, and typical interactions. Keep it natural and in-character.`,
    },
    system_prompt: {
        label: 'System Prompt',
        system: `You write system prompt overrides for AI roleplay characters. These instruct the AI on how to portray the character. Focus on tone, writing style, content boundaries, and roleplay rules specific to this character. Be concise and directive. Do not use markdown headers.`,
    },
    creator_notes: {
        label: "Creator's Notes",
        system: `You write creator notes for AI character cards. These are shown to users who download the card but are NOT sent to the AI.

By default, write a concise overview of the character: who they are, their setting, key dynamics, and what to expect from the roleplay. Think of it as a pitch or summary for someone browsing cards. Be informative and friendly. Do not use markdown headers.

When the user asks for styled, rich, fancy, HTML, or designed notes: generate a complete self-contained HTML+CSS block using inline <style> tags and divs. Create visually striking designs like those found on popular RP character card sites. Use techniques like:
- Gradient backgrounds, glass/frosted panels, decorative borders
- Custom fonts via Google Fonts @import (e.g. Cinzel, Playfair Display, Cormorant Garamond, Quicksand)
- Themed color palettes that match the character's aesthetic
- Sections with icons (use Unicode symbols like ★ ✦ ◆ ❖ ♦ ⚔ ☽ ✧ or SVG)
- Decorative dividers, subtle animations (fade-in, glow, shimmer)
- Organized layout: header/banner, info grid, lorebook tips, recommended settings, scenario hooks
- Dark theme friendly (assume dark background by default)
The HTML must be fully self-contained with all styles in a <style> block at the top. Do not use external images. Do not use markdown. Output raw HTML only, no code fences.`,
    },
};

// ========================================
// STATE
// ========================================

let loadedProfiles = [];
let activeSource = '';
let activeModel = '';
let activePreset = null;
let abortController = null;
let avatarBuffer = null;
let avatarDataUrl = null;
let avatarSourceAvatar = null;
let creatorTagsArray = [];
let tagAutocompleteList = [];
let saveAsTarget = null;


// ========================================
// SETTINGS HELPERS
// ========================================

function getOpt(key) {
    return CoreAPI.getSetting(`creator_${key}`);
}

function setOpt(key, value) {
    CoreAPI.setSetting(`creator_${key}`, value);
}


// ========================================
// MODAL HTML
// ========================================

function createModal() {
    const html = `
    <div id="creatorModal" class="modal-overlay hidden">
        <div class="modal-glass creator-modal-glass">
            <div class="modal-header creator-header">
                <h2><i class="fa-solid fa-plus-circle"></i> Create Character</h2>
                <div class="modal-controls">
                    <button class="glass-btn icon-only" id="creatorFieldsToggle" title="Expand all fields to fit content">
                        <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                    </button>
                    <button class="close-btn" id="creatorClose">&times;</button>
                </div>
            </div>

            <div class="modal-body creator-body">
                <div class="modal-sidebar creator-sidebar">
                    <div class="creator-avatar-area">
                        <div class="creator-avatar-preview" id="creatorAvatarPreview">
                            <i class="fa-solid fa-image"></i>
                            <span>Click to add avatar</span>
                        </div>
                        <input type="file" id="creatorAvatarInput" accept="image/*" style="display: none;">
                        <button type="button" class="action-btn secondary small creator-avatar-clear hidden" id="creatorAvatarClear">
                            <i class="fa-solid fa-times"></i> Remove
                        </button>
                    </div>

                    <div class="creator-sidebar-section">
                        <div class="sidebar-label"><i class="fa-solid fa-tags"></i> Tags
                            <button type="button" class="creator-tag-ai-btn" id="creatorTagAiBtn" title="AI-suggest tags based on character">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>
                            </button>
                        </div>
                        <div class="tags-container" id="creatorTagsContainer"></div>
                        <div id="creatorTagSuggestions" class="creator-tag-suggestions hidden"></div>
                        <div class="creator-tag-input-row">
                            <input type="search" id="creatorTagInput" class="glass-input tag-input" placeholder="Add tag..." autocomplete="one-time-code">
                            <div id="creatorTagAutocomplete" class="tag-autocomplete hidden"></div>
                        </div>
                    </div>

                    <div class="creator-sidebar-section creator-ai-section">
                        <div class="sidebar-label"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Assist</div>
                        <div class="creator-profile-area" id="creatorStConnection">
                            <select id="creatorStProfile" class="hidden">
                                <option value="" disabled selected>Loading...</option>
                            </select>
                            <div class="creator-connection-status">
                                <span class="creator-connection-dot neutral" id="creatorConnectionDot"></span>
                                <span class="creator-connection-label" id="creatorConnectionLabel">Loading...</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="creator-content">
                    <div class="creator-fields">
                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-user"></i> Basic Information</h4>
                            <div class="form-group">
                                <label>Character Name <span class="creator-required">*</span></label>
                                <input type="text" id="creatorName" class="glass-input" placeholder="Give your character a name" autocomplete="one-time-code">
                            </div>
                            <div class="form-row">
                                <div class="form-group half">
                                    <label>Creator / Author</label>
                                    <input type="text" id="creatorAuthor" class="glass-input" placeholder="Your name" autocomplete="one-time-code">
                                </div>
                                <div class="form-group half">
                                    <label>Version</label>
                                    <input type="text" id="creatorVersion" class="glass-input" placeholder="1.0" autocomplete="one-time-code">
                                </div>
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-scroll"></i> Character Definition</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Description / Persona</label>
                                    <button type="button" class="creator-ai-btn" data-field="description" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorDescription" class="glass-input" rows="6" placeholder="Who is this character? Their appearance, backstory, personality..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Personality Summary</label>
                                    <button type="button" class="creator-ai-btn" data-field="personality" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorPersonality" class="glass-input" rows="3" placeholder="Key traits, mannerisms, quirks..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Scenario / Setting</label>
                                    <button type="button" class="creator-ai-btn" data-field="scenario" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorScenario" class="glass-input" rows="3" placeholder="Where and when does the story take place?"></textarea>
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-comments"></i> Messages</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>First Message</label>
                                    <button type="button" class="creator-ai-btn" data-field="first_mes" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorFirstMes" class="glass-input" rows="6" placeholder="The character's opening message..."></textarea>
                            </div>
                            <div class="form-group">
                                <label>Alternate Greetings</label>
                                <div id="creatorAltGreetings" class="creator-alt-greetings"></div>
                                <button type="button" class="action-btn secondary small" id="creatorAddAltGreeting" style="margin-top: 8px;">
                                    <i class="fa-solid fa-plus"></i> Add Greeting
                                </button>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Example Dialogue</label>
                                    <button type="button" class="creator-ai-btn" data-field="mes_example" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorMesExample" class="glass-input" rows="4" placeholder="{{user}}: Hello!\n{{char}}: *waves* Hi there!"></textarea>
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-wand-magic-sparkles"></i> Advanced</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>System Prompt <span class="label-hint">(Override)</span></label>
                                    <button type="button" class="creator-ai-btn" data-field="system_prompt" title="Generate with AI">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorSystemPrompt" class="glass-input" rows="3" placeholder="Optional system prompt override..."></textarea>
                            </div>
                            <div class="form-group">
                                <label>Post-History Instructions <span class="label-hint">(Jailbreak)</span></label>
                                <textarea id="creatorPostHistory" class="glass-input" rows="3" placeholder="Instructions placed after chat history..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Creator's Notes <span class="label-hint">(Not sent to AI)</span></label>
                                    <div class="creator-field-actions">
                                        <button type="button" class="creator-ai-btn" id="creatorNotesPreviewBtn" title="Preview rendered notes">
                                            <i class="fa-solid fa-eye"></i>
                                        </button>
                                        <button type="button" class="creator-ai-btn" data-field="creator_notes" title="Generate with AI">
                                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                                        </button>
                                    </div>
                                </div>
                                <textarea id="creatorNotes" class="glass-input" rows="3" placeholder="Tips and info for users who download this card..."></textarea>
                            </div>
                        </div>
                    </div>

                    <div class="creator-footer">
                        <div class="creator-footer-left">
                            <button type="button" class="action-btn secondary" id="creatorImportBtn">
                                <i class="fa-solid fa-file-import"></i> Import from Library
                            </button>
                        </div>
                        <div class="creator-footer-right">
                            <button type="button" class="action-btn secondary" id="creatorCancelBtn">Cancel</button>
                            <div class="creator-split-btn">
                                <button type="button" class="action-btn primary" id="creatorCreateBtn">
                                    <i class="fa-solid fa-plus"></i> Create Character
                                </button>
                                <button type="button" class="action-btn primary creator-split-caret" id="creatorCreateCaret">
                                    <i class="fa-solid fa-caret-down"></i>
                                </button>
                                <div class="creator-split-menu hidden" id="creatorSplitMenu">
                                    <button type="button" class="dropdown-item" id="creatorSaveAsBtn">
                                        <i class="fa-solid fa-floppy-disk"></i> Save as existing character...
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
}


// ========================================
// MODAL LIFECYCLE
// ========================================

function openModal() {
    let modal = document.getElementById('creatorModal');
    if (!modal) {
        createModal();
        modal = document.getElementById('creatorModal');
        attachEvents();
        const profileSelect = document.getElementById('creatorStProfile');
        if (profileSelect) {
            CoreAPI.initCustomSelect(profileSelect);
            profileSelect._customSelect?.container?.classList.add('hidden');
        }
    }
    resetForm();
    modal.classList.remove('hidden');
    if (!matchMedia('(pointer: coarse)').matches) {
        document.getElementById('creatorName')?.focus();
    }
    loadProfiles().catch(err => CoreAPI.debugLog('[Creator] Profile load error:', err));
    buildTagAutocomplete();
}

function closeModal() {
    abortController?.abort();
    abortController = null;
    document.getElementById('creatorModal')?.classList.add('hidden');
}

function isDirty() {
    const textFields = [
        'creatorName', 'creatorDescription', 'creatorPersonality', 'creatorScenario',
        'creatorFirstMes', 'creatorMesExample', 'creatorSystemPrompt', 'creatorPostHistory', 'creatorNotes',
    ];
    if (textFields.some(id => document.getElementById(id)?.value.trim())) return true;
    if (avatarBuffer) return true;
    if (creatorTagsArray.length > 0) return true;
    if (document.getElementById('creatorAltGreetings')?.children.length > 0) return true;
    return false;
}

function showUnsavedConfirm() {
    return new Promise(resolve => {
        let overlay = document.getElementById('creatorDiscardConfirmOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'creatorDiscardConfirmOverlay';
            overlay.className = 'creator-saveas-diff-overlay';
            overlay.innerHTML = `
            <div class="confirm-modal-content" style="max-width:380px">
                <div class="confirm-modal-header">
                    <h3>Discard unsaved character?</h3>
                </div>
                <div class="confirm-modal-body" style="padding:12px 16px">
                    <p style="margin:0;color:var(--text-secondary)">Your character draft has unsaved changes. Discard them and close?</p>
                </div>
                <div class="confirm-modal-footer">
                    <button type="button" class="action-btn secondary" id="creatorDiscardKeepBtn">Keep Editing</button>
                    <button type="button" class="action-btn danger" id="creatorDiscardConfirmBtn">Discard</button>
                </div>
            </div>`;
            document.body.appendChild(overlay);
            document.getElementById('creatorDiscardKeepBtn').addEventListener('click', () => {
                overlay.classList.add('hidden');
                overlay._resolve?.(false);
            });
            document.getElementById('creatorDiscardConfirmBtn').addEventListener('click', () => {
                overlay.classList.add('hidden');
                overlay._resolve?.(true);
            });
            overlay.addEventListener('click', e => {
                if (e.target === overlay) {
                    overlay.classList.add('hidden');
                    overlay._resolve?.(false);
                }
            });
        }
        overlay._resolve = resolve;
        overlay.classList.remove('hidden');
        document.getElementById('creatorDiscardKeepBtn')?.focus();
    });
}

async function maybeClose() {
    if (isDirty()) {
        const confirmed = await showUnsavedConfirm();
        if (!confirmed) return;
    }
    closeModal();
}

function resetForm() {
    const fields = [
        'creatorName', 'creatorAuthor', 'creatorVersion', 'creatorDescription',
        'creatorPersonality', 'creatorScenario', 'creatorFirstMes', 'creatorMesExample',
        'creatorSystemPrompt', 'creatorPostHistory', 'creatorNotes',
    ];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    avatarBuffer = null;
    if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
    avatarDataUrl = null;
    avatarSourceAvatar = null;
    creatorTagsArray = [];

    const preview = document.getElementById('creatorAvatarPreview');
    if (preview) {
        preview.style.backgroundImage = '';
        preview.classList.remove('has-image');
        preview.querySelector('i').style.display = '';
        preview.querySelector('span').style.display = '';
    }
    document.getElementById('creatorAvatarClear')?.classList.add('hidden');
    document.getElementById('creatorAltGreetings').innerHTML = '';
    renderCreatorTags();
    clearAllFieldStates();
}

function clearAllFieldStates() {
    document.querySelectorAll('.creator-ai-btn').forEach(btn => {
        btn.classList.remove('generating');
        btn.disabled = false;
    });
    // Reset expand toggle
    const btn = document.getElementById('creatorFieldsToggle');
    if (btn?.classList.contains('active')) {
        btn.classList.remove('active');
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
        btn.title = 'Expand all fields to fit content';
        document.querySelectorAll('.creator-fields textarea.glass-input, .creator-alt-textarea').forEach(ta => {
            ta.style.height = '';
        });
    }
}

function toggleFieldExpand() {
    const btn = document.getElementById('creatorFieldsToggle');
    const icon = btn?.querySelector('i');
    if (!btn || !icon) return;
    const textareas = document.querySelectorAll('.creator-fields textarea.glass-input, .creator-alt-textarea');
    if (btn.classList.contains('active')) {
        textareas.forEach(ta => { ta.style.height = ''; });
        btn.classList.remove('active');
        icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
        btn.title = 'Expand all fields to fit content';
    } else {
        textareas.forEach(ta => {
            if (ta.scrollHeight > ta.clientHeight) {
                ta.style.height = (ta.scrollHeight + 4) + 'px';
            }
        });
        btn.classList.add('active');
        icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
        btn.title = 'Contract fields to default size';
    }
}


// ========================================
// EVENT WIRING
// ========================================

function attachEvents() {
    const modal = document.getElementById('creatorModal');
    if (!modal) return;

    // Close
    document.getElementById('creatorClose').addEventListener('click', maybeClose);
    document.getElementById('creatorCancelBtn').addEventListener('click', maybeClose);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) maybeClose();
    });

    // Expand/contract fields toggle
    document.getElementById('creatorFieldsToggle')?.addEventListener('click', toggleFieldExpand);

    // Create
    document.getElementById('creatorCreateBtn').addEventListener('click', handleCreate);

    // Avatar
    document.getElementById('creatorAvatarPreview').addEventListener('click', () => {
        document.getElementById('creatorAvatarInput').click();
    });
    document.getElementById('creatorAvatarInput').addEventListener('change', handleAvatarSelect);
    document.getElementById('creatorAvatarClear').addEventListener('click', handleAvatarClear);

    // Alt greetings
    document.getElementById('creatorAddAltGreeting').addEventListener('click', () => addAltGreeting());
    document.getElementById('creatorAltGreetings').addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.creator-alt-remove');
        if (removeBtn) removeBtn.closest('.creator-alt-greeting-item').remove();
    });

    // AI generate buttons → open AI Studio
    modal.addEventListener('click', (e) => {
        const aiBtn = e.target.closest('.creator-ai-btn');
        if (aiBtn && aiBtn.dataset.field) openStudio(aiBtn.dataset.field);
    });

    // Creator Notes preview
    document.getElementById('creatorNotesPreviewBtn')?.addEventListener('click', openNotesPreview);

    // Import from library
    document.getElementById('creatorImportBtn').addEventListener('click', openImportPicker);

    // Split button dropdown
    document.getElementById('creatorCreateCaret').addEventListener('click', toggleSplitMenu);
    document.getElementById('creatorSaveAsBtn').addEventListener('click', openSaveAsPicker);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.creator-split-btn')) closeSplitMenu();
    });

    // Profile change
    document.getElementById('creatorStProfile')?.addEventListener('change', (e) => {
        setOpt('stProfileId', e.target.value);
        updateProfileStatus();
    });

    // Tag input
    const tagInput = document.getElementById('creatorTagInput');
    tagInput?.addEventListener('keydown', handleTagKeydown);
    tagInput?.addEventListener('input', handleTagAutocomplete);
    tagInput?.addEventListener('focus', handleTagAutocomplete);
    document.getElementById('creatorTagAiBtn')?.addEventListener('click', generateTagSuggestions);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#creatorTagInput') && !e.target.closest('#creatorTagAutocomplete')) {
            document.getElementById('creatorTagAutocomplete')?.classList.add('hidden');
        }
    });
}


// ========================================
// AVATAR HANDLING
// ========================================

async function handleAvatarSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        CoreAPI.showToast('Please select an image file', 'warning');
        return;
    }

    if (file.size > 20 * 1024 * 1024) {
        CoreAPI.showToast('Image is too large (max 20MB)', 'warning');
        return;
    }

    try {
        const originalBuffer = await file.arrayBuffer();
        avatarBuffer = await convertToPng(originalBuffer);
        avatarSourceAvatar = null;

        if (!avatarBuffer) {
            CoreAPI.showToast('Could not process image', 'error');
            return;
        }

        const blob = new Blob([avatarBuffer], { type: 'image/png' });
        if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
        avatarDataUrl = URL.createObjectURL(blob);

        const preview = document.getElementById('creatorAvatarPreview');
        preview.style.backgroundImage = `url(${avatarDataUrl})`;
        preview.classList.add('has-image');
        preview.querySelector('i').style.display = 'none';
        preview.querySelector('span').style.display = 'none';
        document.getElementById('creatorAvatarClear').classList.remove('hidden');
    } catch (err) {
        console.error('[Creator] Avatar processing failed:', err);
        CoreAPI.showToast('Failed to process avatar image', 'error');
    }

    e.target.value = '';
}

function handleAvatarClear() {
    if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
    avatarBuffer = null;
    avatarDataUrl = null;
    avatarSourceAvatar = null;

    const preview = document.getElementById('creatorAvatarPreview');
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    preview.querySelector('i').style.display = '';
    preview.querySelector('span').style.display = '';
    document.getElementById('creatorAvatarClear').classList.add('hidden');
}

async function convertToPng(imageBuffer) {
    const header = new Uint8Array(imageBuffer, 0, 4);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    if (isPng) return imageBuffer;

    try {
        const blob = new Blob([imageBuffer]);
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } catch {
        const fallback = CoreAPI.convertImageToPng(imageBuffer);
        if (fallback) return fallback;
    }
    return null;
}

async function buildPlaceholderPng() {
    const canvas = new OffscreenCanvas(400, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2a3a';
    ctx.fillRect(0, 0, 400, 400);
    ctx.fillStyle = '#555';
    ctx.font = '120px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 200, 200);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
}


// ========================================
// TAG INPUT
// ========================================

function buildTagAutocomplete() {
    tagAutocompleteList = CoreAPI.getAllTags() || [];
}

function renderCreatorTags() {
    const container = document.getElementById('creatorTagsContainer');
    if (!container) return;
    container.innerHTML = creatorTagsArray.map(tag =>
        `<span class="modal-tag editable">${CoreAPI.escapeHtml(tag)}<button type="button" class="tag-remove-btn" data-tag="${CoreAPI.escapeHtml(tag)}" title="Remove tag"><i class="fa-solid fa-times"></i></button></span>`
    ).join('');
    container.querySelectorAll('.tag-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            creatorTagsArray = creatorTagsArray.filter(t => t !== btn.dataset.tag);
            renderCreatorTags();
        });
    });
}

function handleTagKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val && !creatorTagsArray.includes(val)) {
            creatorTagsArray.push(val);
            renderCreatorTags();
        }
        e.target.value = '';
        document.getElementById('creatorTagAutocomplete')?.classList.add('hidden');
    }
}

let tagAiGenerating = false;

const TAG_AI_SYSTEM = `You suggest tags for roleplay chatbot character cards. Tags should be concise (1-3 words each), lowercase, and relevant to RP character browsing and discovery.

Categories to consider: genre/setting, character archetype, personality traits, relationship dynamic, visual traits, species/race, content themes, time period, tone/mood.

Return a JSON array of 10-15 tag strings. Example: ["fantasy", "elf", "tsundere", "romance", "warrior", "medieval"]
Return ONLY the JSON array. No commentary.`;

async function generateTagSuggestions() {
    if (tagAiGenerating) return;

    const ctx = gatherContext();
    if (!ctx.name) {
        CoreAPI.showToast('Enter a character name first', 'warning', 3000);
        return;
    }

    const btn = document.getElementById('creatorTagAiBtn');
    const container = document.getElementById('creatorTagSuggestions');
    if (!container) return;

    tagAiGenerating = true;
    btn?.classList.add('generating');
    container.innerHTML = '<span class="creator-tag-suggestions-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</span>';
    container.classList.remove('hidden');

    let userContent = `Character name: ${ctx.name}\n`;
    if (ctx.description) userContent += `Description: ${ctx.description.slice(0, 500)}\n`;
    if (ctx.personality) userContent += `Personality: ${ctx.personality.slice(0, 300)}\n`;
    if (ctx.scenario) userContent += `Scenario: ${ctx.scenario.slice(0, 200)}\n`;
    if (ctx.creator_notes) userContent += `Creator notes: ${ctx.creator_notes.slice(0, 200)}\n`;
    if (creatorTagsArray.length) userContent += `\nExisting tags (do NOT repeat these): ${creatorTagsArray.join(', ')}\n`;
    userContent += `\nSuggest 10-15 relevant tags for this character.`;

    const messages = [
        { role: 'system', content: TAG_AI_SYSTEM },
        { role: 'user', content: userContent },
    ];

    const abortCtrl = new AbortController();
    const signal = AbortSignal.any([
        abortCtrl.signal,
        AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    ]);

    try {
        const result = await callLLM(messages, signal);
        const cleaned = result.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
        const match = cleaned.match(/\[([\s\S]*?)\]/);
        if (!match) throw new Error('Could not parse tag suggestions');

        const tags = JSON.parse(`[${match[1]}]`)
            .filter(t => typeof t === 'string' && t.trim())
            .map(t => t.trim().toLowerCase())
            .filter(t => !creatorTagsArray.includes(t));

        if (!tags.length) {
            container.innerHTML = '<span class="creator-tag-suggestions-empty">No new tags to suggest.</span>';
            return;
        }

        renderTagSuggestions(tags);
    } catch (err) {
        console.error('[Creator] Tag AI failed:', err);
        container.innerHTML = '<span class="creator-tag-suggestions-empty">Failed to generate tags. Try again.</span>';
    } finally {
        tagAiGenerating = false;
        btn?.classList.remove('generating');
    }
}

function renderTagSuggestions(tags) {
    const container = document.getElementById('creatorTagSuggestions');
    if (!container) return;

    const pillsHtml = tags.map(t =>
        `<button type="button" class="creator-tag-suggestion-pill" data-tag="${CoreAPI.escapeHtml(t)}">${CoreAPI.escapeHtml(t)}</button>`
    ).join('');

    container.innerHTML = `
        <div class="creator-tag-suggestions-header">
            <span>Suggestions</span>
            <button type="button" class="creator-tag-suggestions-add-all" title="Add all">Add All</button>
            <button type="button" class="creator-tag-suggestions-dismiss" title="Dismiss"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="creator-tag-suggestions-pills">${pillsHtml}</div>`;
    container.classList.remove('hidden');

    container.querySelector('.creator-tag-suggestions-dismiss')?.addEventListener('click', () => {
        container.classList.add('hidden');
        container.innerHTML = '';
    });

    container.querySelector('.creator-tag-suggestions-add-all')?.addEventListener('click', () => {
        container.querySelectorAll('.creator-tag-suggestion-pill:not(.added)').forEach(pill => {
            const tag = pill.dataset.tag;
            if (tag && !creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                pill.classList.add('added');
            }
        });
        renderCreatorTags();
    });

    container.querySelectorAll('.creator-tag-suggestion-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const tag = pill.dataset.tag;
            if (pill.classList.contains('added')) {
                creatorTagsArray = creatorTagsArray.filter(t => t !== tag);
                pill.classList.remove('added');
            } else if (!creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                pill.classList.add('added');
            }
            renderCreatorTags();
        });
    });
}

function handleTagAutocomplete() {
    const input = document.getElementById('creatorTagInput');
    const dropdown = document.getElementById('creatorTagAutocomplete');
    if (!input || !dropdown) return;

    const q = input.value.trim().toLowerCase();
    if (!q) { dropdown.classList.add('hidden'); return; }

    const matches = tagAutocompleteList
        .filter(t => t.toLowerCase().includes(q) && !creatorTagsArray.includes(t))
        .slice(0, 10);

    if (!matches.length) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = matches.map(t =>
        `<div class="tag-autocomplete-item">${t}</div>`
    ).join('');
    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.tag-autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
            const tag = item.textContent;
            if (!creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                renderCreatorTags();
            }
            input.value = '';
            dropdown.classList.add('hidden');
        });
    });
}


// ========================================
// ALT GREETINGS
// ========================================

function addAltGreeting(value = '') {
    const container = document.getElementById('creatorAltGreetings');
    const idx = container.children.length + 1;
    const item = document.createElement('div');
    item.className = 'creator-alt-greeting-item';
    item.innerHTML = `
        <textarea class="glass-input creator-alt-textarea" rows="3" placeholder="Alternate greeting #${idx}...">${value}</textarea>
        <button type="button" class="creator-alt-remove" title="Remove"><i class="fa-solid fa-times"></i></button>
    `;
    container.appendChild(item);
}

function collectAltGreetings() {
    const container = document.getElementById('creatorAltGreetings');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.creator-alt-textarea'))
        .map(ta => ta.value.trim())
        .filter(Boolean);
}


// ========================================
// LLM CONNECTION & PROFILES
// ========================================

async function loadProfiles() {
    const dot = document.getElementById('creatorConnectionDot');
    const label = document.getElementById('creatorConnectionLabel');
    const selectEl = document.getElementById('creatorStProfile');
    if (!dot || !label || !selectEl) return;

    dot.className = 'creator-connection-dot neutral';
    label.textContent = 'Loading profiles...';
    const selectContainer = selectEl._customSelect?.container;
    if (selectContainer) selectContainer.classList.add('hidden');
    else selectEl.classList.add('hidden');

    try {
        const response = await CoreAPI.apiRequest('/settings/get', 'POST', {});
        if (!response.ok) throw new Error('Could not fetch settings');

        const data = await response.json();
        const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;

        activeSource = '';
        activeModel = '';
        activePreset = null;
        const presetName = settings?.preset_settings_openai;
        if (presetName && Array.isArray(data.openai_setting_names) && Array.isArray(data.openai_settings)) {
            const idx = data.openai_setting_names.indexOf(presetName);
            if (idx >= 0) {
                try {
                    const preset = typeof data.openai_settings[idx] === 'string'
                        ? JSON.parse(data.openai_settings[idx])
                        : data.openai_settings[idx];
                    activePreset = preset;
                    activeSource = preset?.chat_completion_source || '';
                    const modelKey = SOURCE_MODEL_KEY[activeSource];
                    activeModel = modelKey ? (preset?.[modelKey] || '') : '';
                } catch { /* corrupt preset */ }
            }
        }

        const cm = settings?.extension_settings?.connectionManager;

        if (!cm?.profiles?.length) {
            dot.className = activeSource ? 'creator-connection-dot connected' : 'creator-connection-dot neutral';
            label.textContent = activeSource
                ? `${activeSource}${activeModel ? ' / ' + activeModel : ''}`
                : 'No Connection Profiles found';
            loadedProfiles = [];
            return;
        }

        const ccProfiles = cm.profiles.filter(p => p.mode === 'cc');
        if (!ccProfiles.length) {
            dot.className = activeSource ? 'creator-connection-dot connected' : 'creator-connection-dot neutral';
            label.textContent = activeSource
                ? `${activeSource}${activeModel ? ' / ' + activeModel : ''}`
                : 'No Chat Completion profiles found';
            loadedProfiles = [];
            return;
        }

        loadedProfiles = ccProfiles;
        selectEl.innerHTML = ccProfiles.map(p =>
            `<option value="${CoreAPI.escapeHtml(p.id)}">${CoreAPI.escapeHtml(p.name || p.api || 'Unnamed')}</option>`
        ).join('');

        const savedId = getOpt('stProfileId');
        if (savedId && ccProfiles.some(p => p.id === savedId)) {
            selectEl.value = savedId;
        } else if (cm.selectedProfile && ccProfiles.some(p => p.id === cm.selectedProfile)) {
            selectEl.value = cm.selectedProfile;
        } else {
            selectEl.value = ccProfiles[0].id;
        }
        setOpt('stProfileId', selectEl.value);

        selectEl._customSelect?.refresh();
        if (selectContainer) selectContainer.classList.remove('hidden');
        else selectEl.classList.remove('hidden');
        updateProfileStatus();
    } catch (err) {
        console.error('[Creator] Failed to load profiles:', err);
        dot.className = 'creator-connection-dot neutral';
        label.textContent = 'Could not reach SillyTavern server';
        loadedProfiles = [];
    }
}

function getSelectedProfile() {
    const selectEl = document.getElementById('creatorStProfile');
    const id = selectEl?.value || getOpt('stProfileId');
    return loadedProfiles.find(p => p.id === id) || null;
}

function updateProfileStatus() {
    const dot = document.getElementById('creatorConnectionDot');
    const label = document.getElementById('creatorConnectionLabel');
    if (!dot || !label) return;

    const profile = getSelectedProfile();
    const source = profile?.api || activeSource;
    const model = profile?.model || activeModel;

    if (!source) {
        dot.className = 'creator-connection-dot neutral';
        label.textContent = 'No active Chat Completion source';
        return;
    }

    dot.className = 'creator-connection-dot connected';
    label.textContent = model || source;
}


// ========================================
// LLM API CALLS
// ========================================

async function callLLM(messages, signal) {
    const profile = getSelectedProfile();
    const source = profile?.api || activeSource;
    const model = profile?.model || activeModel;

    if (!source) {
        throw new Error(
            'No Chat Completion source detected. Make sure SillyTavern has a Chat Completion API ' +
            '(OpenAI, Claude, OpenRouter, etc.) selected and connected, then reopen this modal.'
        );
    }

    const body = {
        messages,
        temperature: 0.8,
        max_tokens: 4000,
        stream: false,
        chat_completion_source: source,
    };
    if (model) body.model = model;

    if (profile) {
        if (profile['api-url']) {
            body.custom_url = profile['api-url'];
            body.vertexai_region = profile['api-url'];
            body.zai_endpoint = profile['api-url'];
        }
    } else if (activePreset) {
        if (activePreset.custom_url) body.custom_url = activePreset.custom_url;
        if (activePreset.reverse_proxy) body.reverse_proxy = activePreset.reverse_proxy;
        if (activePreset.proxy_password) body.proxy_password = activePreset.proxy_password;
    }

    for (const endpoint of GENERATE_ENDPOINTS) {
        let response;
        try {
            response = await CoreAPI.apiRequest(endpoint, 'POST', body, { signal });
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Generation cancelled.');
            continue;
        }

        if (response.status === 404) continue;

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`API returned ${response.status}: ${errText.slice(0, 300)}`);
        }

        const responseText = await response.text();
        try {
            const data = JSON.parse(responseText);
            return extractContent(data);
        } catch {
            return responseText;
        }
    }
    throw new Error(
        'Could not reach SillyTavern\'s Chat Completion API. ' +
        'Make sure you have a Chat Completion API configured and connected in SillyTavern.'
    );
}


// ========================================
// AI STUDIO
// ========================================

const FIELD_TEXTAREA_MAP = {
    description: 'creatorDescription',
    personality: 'creatorPersonality',
    scenario: 'creatorScenario',
    first_mes: 'creatorFirstMes',
    mes_example: 'creatorMesExample',
    system_prompt: 'creatorSystemPrompt',
    creator_notes: 'creatorNotes',
};

let studioFieldKey = '';
let studioHistory = [];
let studioHistoryIdx = -1;
let studioConversation = [];
let studioLlmMessages = [];
let studioGenerating = false;
let studioLockedSelection = null;
let studioInjected = false;
let studioEventsAttached = false;
let studioBrainstormMode = false;
let studioBrainstormMessages = [];

const BRAINSTORM_FIELDS = new Set(['description']);

const BRAINSTORM_SYSTEM = `You are a collaborative character design partner. Your job is to help the user develop their character concept through natural conversation.

Behavior rules:
- Ask focused, specific questions to draw out the character concept
- Suggest ideas and alternatives, but let the user decide
- Build on what the user says; reference earlier parts of the conversation
- Keep responses conversational and concise (2-4 paragraphs max)
- Do NOT write the final character description yet; that happens when the user finalizes
- If the user gives you a clear, complete vision, reflect it back and ask what else to explore
- Cover personality, appearance, backstory, mannerisms, speech patterns, motivations as the conversation progresses naturally`;

function gatherContext() {
    return {
        name: document.getElementById('creatorName')?.value?.trim() || '',
        description: document.getElementById('creatorDescription')?.value?.trim() || '',
        personality: document.getElementById('creatorPersonality')?.value?.trim() || '',
        scenario: document.getElementById('creatorScenario')?.value?.trim() || '',
        first_mes: document.getElementById('creatorFirstMes')?.value?.trim() || '',
        mes_example: document.getElementById('creatorMesExample')?.value?.trim() || '',
        system_prompt: document.getElementById('creatorSystemPrompt')?.value?.trim() || '',
        creator_notes: document.getElementById('creatorNotes')?.value?.trim() || '',
        tags: [...creatorTagsArray],
    };
}

// ========================================
// PER-FIELD AI SETTINGS (inside AI Studio)
// ========================================

const PROMPTS_FILE = '_cl_creator_prompts.json';

function getFieldPromptOverride(fieldKey) {
    return getOpt(`field_prompt_${fieldKey}`) || '';
}

function getFieldContextOverrides(fieldKey) {
    return getOpt(`field_ctx_${fieldKey}`) || null;
}

function getEffectiveSystemPrompt(fieldKey) {
    const override = getFieldPromptOverride(fieldKey);
    return (override && override.trim()) ? override.trim() : (FIELD_PROMPTS[fieldKey]?.system || '');
}

function isFieldContextIncluded(fieldKey, contextKey) {
    const overrides = getFieldContextOverrides(fieldKey);
    if (!overrides) return true;
    return overrides[contextKey] !== false;
}

function fieldHasOverrides(fieldKey) {
    const prompt = getFieldPromptOverride(fieldKey);
    if (prompt && prompt.trim()) return true;
    const ctx = getFieldContextOverrides(fieldKey);
    if (ctx && Object.values(ctx).some(v => v === false)) return true;
    return false;
}

async function loadSavedPrompts() {
    try {
        const resp = await fetch(`/user/files/${PROMPTS_FILE}`);
        if (!resp.ok) return {};
        return await resp.json();
    } catch { return {}; }
}

async function saveSavedPrompts(data) {
    const jsonStr = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    await CoreAPI.apiRequest('/files/upload', 'POST', {
        name: PROMPTS_FILE,
        data: btoa(binary),
    });
}

function populateStudioSettings() {
    const fieldKey = studioFieldKey;
    const promptEl = document.getElementById('studioSettingsPrompt');
    const ctxContainer = document.getElementById('studioSettingsContext');
    if (!promptEl || !ctxContainer) return;

    const customPrompt = getFieldPromptOverride(fieldKey);
    promptEl.value = customPrompt;
    promptEl.placeholder = FIELD_PROMPTS[fieldKey]?.system || '';

    const ctxOverrides = getFieldContextOverrides(fieldKey) || {};
    ctxContainer.innerHTML = '';
    for (const key of Object.keys(FIELD_PROMPTS)) {
        if (key === fieldKey) continue;
        const label = FIELD_PROMPTS[key].label;
        const checked = ctxOverrides[key] !== false;
        ctxContainer.insertAdjacentHTML('beforeend', `
            <label class="studio-settings-check">
                <input type="checkbox" data-ctx-field="${key}" ${checked ? 'checked' : ''}>
                <span>${label}</span>
            </label>`);
    }

    updateStudioSettingsIndicator();
    loadPromptPresetList();
}

function updateStudioSettingsIndicator() {
    const btn = document.getElementById('studioSettingsToggle');
    if (btn) btn.classList.toggle('has-overrides', fieldHasOverrides(studioFieldKey));
}

let studioSettingsSaveTimer = null;

function attachStudioSettingsEvents() {
    document.getElementById('studioSettingsPrompt')?.addEventListener('input', () => {
        clearTimeout(studioSettingsSaveTimer);
        studioSettingsSaveTimer = setTimeout(() => {
            setOpt(`field_prompt_${studioFieldKey}`, document.getElementById('studioSettingsPrompt').value);
            updateStudioSettingsIndicator();
        }, 500);
    });

    document.getElementById('studioSettingsContext')?.addEventListener('change', (e) => {
        if (!e.target.matches('input[type="checkbox"]')) return;
        const overrides = getFieldContextOverrides(studioFieldKey) || {};
        overrides[e.target.dataset.ctxField] = e.target.checked;
        setOpt(`field_ctx_${studioFieldKey}`, overrides);
        updateStudioSettingsIndicator();
    });

    document.getElementById('studioSettingsReset')?.addEventListener('click', () => {
        setOpt(`field_prompt_${studioFieldKey}`, '');
        setOpt(`field_ctx_${studioFieldKey}`, null);
        populateStudioSettings();
    });

    document.getElementById('studioSettingsToggle')?.addEventListener('click', () => {
        const panel = document.getElementById('studioSettingsPanel');
        if (panel) {
            const isHidden = panel.classList.toggle('hidden');
            document.getElementById('studioSettingsToggle')?.classList.toggle('active', !isHidden);
        }
    });

    document.getElementById('studioPromptSave')?.addEventListener('click', saveCurrentPrompt);
    document.getElementById('studioPromptPresets')?.addEventListener('change', loadSelectedPreset);
    document.getElementById('studioPromptDelete')?.addEventListener('click', deleteSelectedPreset);
}

async function loadPromptPresetList() {
    const select = document.getElementById('studioPromptPresets');
    if (!select) return;
    const data = await loadSavedPrompts();
    const presets = data[studioFieldKey] || [];
    select.innerHTML = '<option value="" disabled selected>Load saved prompt...</option>';
    presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = p.name || `Preset ${i + 1}`;
        select.appendChild(opt);
    });
    select.value = '';
    select._customSelect?.refresh();
}

let _namePromptResolve = null;

function promptForName(label) {
    return new Promise(resolve => {
        _namePromptResolve = resolve;
        let overlay = document.getElementById('creatorNamePromptOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'creatorNamePromptOverlay';
            overlay.className = 'creator-saveas-diff-overlay';
            overlay.innerHTML = `
            <div class="confirm-modal-content" style="max-width:360px">
                <div class="confirm-modal-header">
                    <h3 id="creatorNamePromptLabel"></h3>
                </div>
                <div class="confirm-modal-body" style="padding:12px 16px">
                    <input id="creatorNamePromptInput" class="glass-input" type="text" style="width:100%" />
                </div>
                <div class="confirm-modal-footer">
                    <button type="button" class="action-btn secondary" id="creatorNamePromptCancel">Cancel</button>
                    <button type="button" class="action-btn primary" id="creatorNamePromptOk">Save</button>
                </div>
            </div>`;
            document.body.appendChild(overlay);
            const submit = () => {
                const val = document.getElementById('creatorNamePromptInput').value.trim();
                overlay.classList.add('hidden');
                const res = _namePromptResolve;
                _namePromptResolve = null;
                res?.(val || null);
            };
            document.getElementById('creatorNamePromptOk').addEventListener('click', submit);
            document.getElementById('creatorNamePromptCancel').addEventListener('click', () => {
                overlay.classList.add('hidden');
                const res = _namePromptResolve;
                _namePromptResolve = null;
                res?.(null);
            });
            document.getElementById('creatorNamePromptInput').addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                if (e.key === 'Escape') {
                    overlay.classList.add('hidden');
                    const res = _namePromptResolve;
                    _namePromptResolve = null;
                    res?.(null);
                }
            });
        }
        document.getElementById('creatorNamePromptLabel').textContent = label;
        const input = document.getElementById('creatorNamePromptInput');
        input.value = '';
        overlay.classList.remove('hidden');
        input.focus();
    });
}

async function saveCurrentPrompt() {
    const promptText = document.getElementById('studioSettingsPrompt')?.value?.trim();
    if (!promptText) {
        CoreAPI.showToast('Write a custom prompt first', 'warning', 2000);
        return;
    }
    const name = await promptForName('Name for this prompt preset:');
    if (!name) return;

    const data = await loadSavedPrompts();
    if (!data[studioFieldKey]) data[studioFieldKey] = [];
    data[studioFieldKey].push({ name: name.trim(), prompt: promptText });
    await saveSavedPrompts(data);
    await loadPromptPresetList();

    // Auto-select the newly saved preset
    const select = document.getElementById('studioPromptPresets');
    if (select && select.options.length > 1) {
        select.value = String(data[studioFieldKey].length - 1);
        select._customSelect?.refresh();
    }

    CoreAPI.showToast('Prompt saved', 'success', 2000);
}

async function loadSelectedPreset() {
    const select = document.getElementById('studioPromptPresets');
    const idx = parseInt(select?.value, 10);
    if (isNaN(idx)) return;

    const data = await loadSavedPrompts();
    const presets = data[studioFieldKey] || [];
    const preset = presets[idx];
    if (!preset) return;

    const promptEl = document.getElementById('studioSettingsPrompt');
    if (promptEl) {
        promptEl.value = preset.prompt;
        setOpt(`field_prompt_${studioFieldKey}`, preset.prompt);
        updateStudioSettingsIndicator();
    }
}

async function deleteSelectedPreset() {
    const select = document.getElementById('studioPromptPresets');
    const idx = parseInt(select?.value, 10);
    if (isNaN(idx)) {
        CoreAPI.showToast('Select a preset to delete', 'warning', 2000);
        return;
    }
    const data = await loadSavedPrompts();
    const presets = data[studioFieldKey] || [];
    if (!presets[idx]) return;

    const name = presets[idx].name;
    presets.splice(idx, 1);
    data[studioFieldKey] = presets;
    await saveSavedPrompts(data);
    CoreAPI.showToast(`"${name}" deleted`, 'info', 2000);
    await loadPromptPresetList();
}


// ========================================
// IMPORT FROM LIBRARY
// ========================================

let importPickerInjected = false;

function createImportPicker() {
    if (importPickerInjected) return;
    importPickerInjected = true;

    const html = `
    <div id="creatorImportPicker" class="creator-import-overlay hidden">
        <div class="creator-import-panel">
            <div class="creator-import-header">
                <h3><i class="fa-solid fa-file-import"></i> Import from Library</h3>
                <button type="button" class="ai-studio-close-btn" id="importPickerClose">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="creator-import-search">
                <i class="fa-solid fa-search"></i>
                <input type="search" id="importPickerSearch" class="glass-input" placeholder="Search characters..." autocomplete="one-time-code">
            </div>
            <div class="creator-import-list" id="importPickerList"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('importPickerClose').addEventListener('click', closeImportPicker);
    document.getElementById('creatorImportPicker').addEventListener('click', (e) => {
        if (e.target.id === 'creatorImportPicker') closeImportPicker();
    });
    document.getElementById('importPickerSearch').addEventListener('input', (e) => {
        const mode = document.getElementById('creatorImportPicker')?.dataset.mode;
        renderImportList(e.target.value.trim().toLowerCase(), mode === 'saveas');
    });
    document.getElementById('importPickerList').addEventListener('click', (e) => {
        const item = e.target.closest('.creator-import-item');
        if (item) {
            const mode = document.getElementById('importPickerList')?.dataset.mode;
            if (mode === 'saveas') {
                handleSaveAsSelection(item.dataset.avatar);
            } else {
                importCharacterFromLibrary(item.dataset.avatar);
                closeImportPicker();
            }
        }
    });
}

function openImportPicker() {
    createImportPicker();
    document.getElementById('importPickerSearch').value = '';
    renderImportList('');
    const picker = document.getElementById('creatorImportPicker');
    picker.classList.remove('hidden');
    picker.dataset.mode = 'import';
    picker.querySelector('h3').innerHTML = '<i class="fa-solid fa-file-import"></i> Import from Library';
    requestAnimationFrame(() => document.getElementById('importPickerSearch')?.focus());
}

function closeImportPicker() {
    document.getElementById('creatorImportPicker')?.classList.add('hidden');
}

function renderImportList(query, isSaveAs = false) {
    const list = document.getElementById('importPickerList');
    if (!list) return;

    const chars = CoreAPI.getAllCharacters() || [];
    let filtered = chars;
    if (query) {
        filtered = chars.filter(c =>
            (c.name || '').toLowerCase().includes(query) ||
            (c.data?.creator || '').toLowerCase().includes(query) ||
            (c.data?.tags || []).some(t => t.toLowerCase().includes(query))
        );
    }

    const sorted = [...filtered].sort((a, b) => {
        if (query) {
            const aName = (a.name || '').toLowerCase();
            const bName = (b.name || '').toLowerCase();
            const aStarts = aName.startsWith(query);
            const bStarts = bName.startsWith(query);
            if (aStarts !== bStarts) return aStarts ? -1 : 1;
        }
        return (a.name || '').localeCompare(b.name || '');
    });
    const display = sorted.slice(0, 100);
    list.dataset.mode = isSaveAs ? 'saveas' : 'import';

    list.innerHTML = display.map(c => {
        const name = CoreAPI.escapeHtml(c.name || 'Unknown');
        const creator = c.data?.creator ? CoreAPI.escapeHtml(c.data.creator) : '';
        const avatarPath = c.avatar ? `/characters/${encodeURIComponent(c.avatar)}` : '';
        return `
            <div class="creator-import-item" data-avatar="${CoreAPI.escapeHtml(c.avatar || '')}">
                <div class="creator-import-avatar" ${avatarPath ? `style="background-image: url('${avatarPath}')"` : ''}></div>
                <div class="creator-import-info">
                    <span class="creator-import-name">${name}</span>
                    ${creator ? `<span class="creator-import-creator">${creator}</span>` : ''}
                </div>
            </div>`;
    }).join('');

    if (!display.length) {
        list.innerHTML = '<div class="creator-import-empty">No characters found</div>';
    }
}

async function importCharacterFromLibrary(avatar) {
    if (!avatar) return;

    const chars = CoreAPI.getAllCharacters() || [];
    const char = chars.find(c => c.avatar === avatar);
    if (!char) {
        CoreAPI.showToast('Character not found', 'error');
        return;
    }

    await CoreAPI.hydrateCharacter(char);
    const data = char.data || {};

    document.getElementById('creatorName').value = char.name || '';
    document.getElementById('creatorAuthor').value = data.creator || '';
    document.getElementById('creatorVersion').value = data.character_version || '';
    document.getElementById('creatorDescription').value = data.description || '';
    document.getElementById('creatorPersonality').value = data.personality || '';
    document.getElementById('creatorScenario').value = data.scenario || '';
    document.getElementById('creatorFirstMes').value = data.first_mes || '';
    document.getElementById('creatorMesExample').value = data.mes_example || '';
    document.getElementById('creatorSystemPrompt').value = data.system_prompt || '';
    document.getElementById('creatorPostHistory').value = data.post_history_instructions || '';
    document.getElementById('creatorNotes').value = data.creator_notes || '';

    // Alt greetings
    document.getElementById('creatorAltGreetings').innerHTML = '';
    if (Array.isArray(data.alternate_greetings)) {
        data.alternate_greetings.forEach(g => addAltGreeting(g));
    }

    // Tags
    creatorTagsArray = Array.isArray(data.tags) ? [...data.tags] : [];
    renderCreatorTags();

    // Avatar
    const avatarUrl = `/characters/${encodeURIComponent(avatar)}`;
    try {
        const resp = await fetch(avatarUrl);
        if (resp.ok) {
            const blob = await resp.blob();
            avatarBuffer = await blob.arrayBuffer();
            if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
            avatarDataUrl = URL.createObjectURL(blob);
            avatarSourceAvatar = avatar;
            const preview = document.getElementById('creatorAvatarPreview');
            if (preview) {
                preview.style.backgroundImage = `url(${avatarDataUrl})`;
                preview.classList.add('has-image');
                preview.querySelector('i').style.display = 'none';
                preview.querySelector('span').style.display = 'none';
            }
            document.getElementById('creatorAvatarClear')?.classList.remove('hidden');
        }
    } catch { /* avatar load failed, non-critical */ }

    CoreAPI.showToast(`Imported "${char.name}" fields`, 'success', 2000);
}


// ========================================
// CREATOR NOTES PREVIEW
// ========================================

let notesPreviewInjected = false;

function createNotesPreviewModal() {
    if (notesPreviewInjected) return;
    notesPreviewInjected = true;

    const html = `
    <div id="creatorNotesPreview" class="modal-overlay hidden">
        <div class="modal-glass creator-notes-fullscreen-modal" id="creatorNotesPreviewInner" data-size="normal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-eye"></i> Creator's Notes Preview</h2>
                <div class="creator-notes-display-controls">
                    <div class="display-control-btns zoom-controls" id="previewZoomBtns">
                        <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                            <i class="fa-solid fa-minus"></i>
                        </button>
                        <span class="zoom-level" id="previewZoomLevel">100%</span>
                        <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                        <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="display-control-btns" id="previewSizeBtns">
                        <button type="button" class="display-control-btn" data-size="compact" title="Compact">
                            <i class="fa-solid fa-compress"></i>
                        </button>
                        <button type="button" class="display-control-btn active" data-size="normal" title="Normal">
                            <i class="fa-regular fa-window-maximize"></i>
                        </button>
                        <button type="button" class="display-control-btn" data-size="wide" title="Wide">
                            <i class="fa-solid fa-expand"></i>
                        </button>
                    </div>
                </div>
                <div class="modal-controls">
                    <button class="close-btn" id="creatorNotesPreviewClose">&times;</button>
                </div>
            </div>
            <div class="creator-notes-fullscreen-body" id="creatorNotesPreviewBody"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('creatorNotesPreviewClose').addEventListener('click', closeNotesPreview);
    document.getElementById('creatorNotesPreview').addEventListener('click', (e) => {
        if (e.target.id === 'creatorNotesPreview') closeNotesPreview();
    });

    // Size controls
    document.getElementById('previewSizeBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-size]');
        if (!btn) return;
        document.querySelectorAll('#previewSizeBtns .display-control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('creatorNotesPreviewInner').dataset.size = btn.dataset.size;
    });

    // Zoom controls
    document.getElementById('previewZoomBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updatePreviewZoom(previewZoom + 10);
        else if (action === 'out') updatePreviewZoom(previewZoom - 10);
        else if (action === 'reset') updatePreviewZoom(100);
    });
}

let previewZoom = 100;

function updatePreviewZoom(zoom) {
    previewZoom = Math.max(50, Math.min(200, zoom));
    const display = document.getElementById('previewZoomLevel');
    if (display) display.textContent = `${previewZoom}%`;

    const iframe = document.querySelector('#creatorNotesPreviewBody iframe');
    if (!iframe) return;
    const scale = previewZoom / 100;
    try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc?.body) {
            const wrapper = doc.getElementById('content-wrapper');
            if (wrapper) {
                wrapper.style.transform = `scale(${scale})`;
                wrapper.style.transformOrigin = 'top center';
                wrapper.style.width = scale <= 1 ? '100%' : `${100 / scale}%`;
                wrapper.style.margin = '0 auto';
            }
            doc.body.style.zoom = scale;
        }
    } catch { /* sandboxed */ }
}

function openNotesPreview() {
    const content = document.getElementById('creatorNotes')?.value?.trim();
    if (!content) {
        CoreAPI.showToast('No notes to preview', 'warning', 2000);
        return;
    }
    createNotesPreviewModal();

    // Reset zoom and size
    previewZoom = 100;
    const zoomDisplay = document.getElementById('previewZoomLevel');
    if (zoomDisplay) zoomDisplay.textContent = '100%';
    const inner = document.getElementById('creatorNotesPreviewInner');
    if (inner) inner.dataset.size = 'normal';
    document.querySelectorAll('#previewSizeBtns .display-control-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.size === 'normal');
    });

    const container = document.getElementById('creatorNotesPreviewBody');
    const charName = document.getElementById('creatorName')?.value?.trim() || 'Character';
    CoreAPI.renderCreatorNotesSecure(content, charName, container);

    const iframe = container.querySelector('iframe');
    if (iframe) {
        // Kill the auto-resize machinery — this container has a fixed flex height.
        // setupCreatorNotesResize sets iframe.onload which would re-impose a pixel
        // height, overriding height:100% and causing the iframe to visually cut off.
        iframe._resizeObserver?.disconnect();
        iframe._resizeObserver = null;
        iframe.onload = null;
        iframe.style.height = '100%';
        iframe.style.maxHeight = 'none';
        iframe.style.minHeight = '0';
        iframe.addEventListener('load', () => {
            setTimeout(() => updatePreviewZoom(previewZoom), 50);
        }, { once: true });
    }

    document.getElementById('creatorNotesPreview').classList.remove('hidden');
}

function closeNotesPreview() {
    document.getElementById('creatorNotesPreview')?.classList.add('hidden');
}


function createStudioModal() {
    if (studioInjected) return;
    studioInjected = true;

    const html = `
    <div id="aiStudioOverlay" class="ai-studio-overlay hidden">
        <div class="ai-studio-modal">
            <div class="ai-studio-header">
                <div class="ai-studio-header-left">
                    <div class="ai-studio-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                    <div class="ai-studio-title">
                        <h3>AI Studio</h3>
                        <span class="ai-studio-field-label" id="studioFieldLabel">Description</span>
                    </div>
                </div>
                <div class="ai-studio-header-actions">
                    <button type="button" class="ai-studio-nav-btn" id="studioBrainstormToggle" title="Brainstorm mode: develop your character through conversation">
                        <i class="fa-solid fa-lightbulb"></i>
                    </button>
                    <div class="ai-studio-history-nav">
                        <button type="button" class="ai-studio-nav-btn" id="studioUndo" title="Undo" disabled>
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                        <span class="ai-studio-history-pos" id="studioHistoryPos"></span>
                        <button type="button" class="ai-studio-nav-btn" id="studioRedo" title="Redo" disabled>
                            <i class="fa-solid fa-rotate-right"></i>
                        </button>
                    </div>
                    <button type="button" class="ai-studio-nav-btn" id="studioSettingsToggle" title="Field AI Settings">
                        <i class="fa-solid fa-sliders"></i>
                    </button>
                    <button type="button" class="ai-studio-close-btn" id="studioClose">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            </div>

            <div id="studioSettingsPanel" class="studio-settings-panel hidden">
                <div class="studio-settings-section">
                    <label class="studio-settings-label">Custom System Prompt</label>
                    <textarea id="studioSettingsPrompt" class="glass-input studio-settings-prompt" rows="3"
                        placeholder="Custom instructions for this field (leave empty for default)"></textarea>
                    <div class="studio-settings-presets">
                        <select id="studioPromptPresets" class="studio-settings-preset-select">
                            <option value="" disabled selected>Load saved prompt...</option>
                        </select>
                        <button type="button" class="ai-studio-nav-btn" id="studioPromptSave" title="Save current prompt">
                            <i class="fa-solid fa-floppy-disk"></i>
                        </button>
                        <button type="button" class="ai-studio-nav-btn" id="studioPromptDelete" title="Delete selected preset">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
                <div class="studio-settings-section">
                    <div class="studio-settings-context-row">
                        <label class="studio-settings-label">Include as Context</label>
                        <button type="button" class="ai-studio-nav-btn" id="studioSettingsReset" title="Reset field overrides">
                            <i class="fa-solid fa-rotate-left"></i> Reset
                        </button>
                    </div>
                    <div id="studioSettingsContext" class="studio-settings-checks"></div>
                </div>
            </div>

            <div class="ai-studio-body">
                <div class="ai-studio-content-area">
                    <div class="ai-studio-editor-wrap">
                        <div class="ai-studio-highlight-layer" id="studioHighlightLayer" aria-hidden="true"></div>
                        <textarea id="studioContent" class="ai-studio-textarea" placeholder="AI-generated content will appear here. Type your instructions below to get started..."></textarea>
                    </div>
                    <div class="ai-studio-content-meta">
                        <span id="studioWordCount">0 words</span>
                    </div>
                </div>

                <div class="ai-studio-conversation" id="studioConversation">
                    <div class="ai-studio-empty-state" id="studioEmptyState">
                        <i class="fa-solid fa-comments"></i>
                        <p>Tell the AI what to write. Be specific about tone, style, details you want.</p>
                        <div class="ai-studio-suggestions" id="studioSuggestions"></div>
                    </div>
                </div>

                <div class="ai-studio-input-area">
                    <div class="ai-studio-selection-badge hidden" id="studioSelectionBadge">
                        <i class="fa-solid fa-highlighter"></i>
                        <span>Revising selection</span>
                        <button type="button" class="ai-studio-selection-clear" id="studioSelectionClear" title="Clear selection">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="ai-studio-input-meta">
                        <div class="ai-studio-word-target">
                            <label for="studioWordTarget"><i class="fa-solid fa-ruler-horizontal"></i> Target</label>
                            <input type="number" id="studioWordTarget" min="0" max="9999" step="50" placeholder="auto">
                            <span>words</span>
                        </div>
                    </div>
                    <div class="ai-studio-input-row">
                        <textarea id="studioInput" class="ai-studio-input" placeholder="Describe what you want..." rows="1"></textarea>
                        <button type="button" class="ai-studio-send-btn" id="studioSend" title="Generate">
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button type="button" class="ai-studio-stop-btn hidden" id="studioStop" title="Stop">
                            <i class="fa-solid fa-stop"></i>
                        </button>
                    </div>
                </div>
            </div>

            <div class="ai-studio-footer">
                <button type="button" class="action-btn secondary" id="studioDiscard">Discard</button>
                <button type="button" class="action-btn primary" id="studioBrainstormFinalize" style="display:none;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Finalize into Description
                </button>
                <button type="button" class="action-btn primary" id="studioApply">
                    <i class="fa-solid fa-check"></i> Apply to Card
                </button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
}

function attachStudioEvents() {
    if (studioEventsAttached) return;
    studioEventsAttached = true;

    const overlay = document.getElementById('aiStudioOverlay');

    document.getElementById('studioClose').addEventListener('click', closeStudio);
    document.getElementById('studioDiscard').addEventListener('click', closeStudio);
    document.getElementById('studioApply').addEventListener('click', applyStudio);

    document.getElementById('studioBrainstormToggle').addEventListener('click', toggleBrainstormMode);
    document.getElementById('studioBrainstormFinalize').addEventListener('click', finalizeBrainstorm);

    document.getElementById('studioUndo').addEventListener('click', studioUndo);
    document.getElementById('studioRedo').addEventListener('click', studioRedo);

    document.getElementById('studioSend').addEventListener('click', studioGenerate);
    document.getElementById('studioStop').addEventListener('click', studioStopGeneration);

    const input = document.getElementById('studioInput');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!studioGenerating) studioGenerate();
        }
    });
    input.addEventListener('input', autoResizeStudioInput);

    const studioContentEl = document.getElementById('studioContent');
    studioContentEl.addEventListener('input', () => {
        updateStudioWordCount();
        clearStudioHighlight();
    });
    studioContentEl.addEventListener('scroll', syncHighlightScroll);

    const lockSelection = () => {
        const start = studioContentEl.selectionStart;
        const end = studioContentEl.selectionEnd;
        if (start !== end) {
            studioLockedSelection = { start, end };
        } else {
            studioLockedSelection = null;
        }
        renderHighlightOverlay();
        updateSelectionBadge();
    };
    studioContentEl.addEventListener('mouseup', lockSelection);
    studioContentEl.addEventListener('keyup', lockSelection);

    // Mobile: selectionchange is the reliable way to detect handle-based
    // text selection. touchend alone fires too early (before handles settle).
    let selectionChangeRaf = 0;
    document.addEventListener('selectionchange', () => {
        if (document.activeElement !== studioContentEl) return;
        cancelAnimationFrame(selectionChangeRaf);
        selectionChangeRaf = requestAnimationFrame(lockSelection);
    });

    document.getElementById('studioSelectionClear').addEventListener('click', () => {
        clearStudioHighlight();
        studioContentEl.focus();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeStudio();
    });

    document.getElementById('studioConversation').addEventListener('click', (e) => {
        const suggestion = e.target.closest('.ai-studio-suggestion-chip');
        if (suggestion) {
            document.getElementById('studioInput').value = suggestion.textContent;
            autoResizeStudioInput();
            studioGenerate();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('aiStudioOverlay')?.classList.contains('hidden')) {
            if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
                const active = document.activeElement;
                if (active?.id !== 'studioContent' && active?.id !== 'studioInput' && active?.id !== 'studioSettingsPrompt') {
                    e.preventDefault();
                    studioUndo();
                }
            }
            if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                const active = document.activeElement;
                if (active?.id !== 'studioContent' && active?.id !== 'studioInput' && active?.id !== 'studioSettingsPrompt') {
                    e.preventDefault();
                    studioRedo();
                }
            }
        }
    }, true);

    attachStudioSettingsEvents();
}

function autoResizeStudioInput() {
    const input = document.getElementById('studioInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function openStudio(fieldKey) {
    const fieldConfig = FIELD_PROMPTS[fieldKey];
    if (!fieldConfig) return;

    const ctx = gatherContext();
    if (!ctx.name) {
        CoreAPI.showToast('Enter a character name first', 'warning', 3000);
        document.getElementById('creatorName')?.focus();
        return;
    }

    createStudioModal();
    attachStudioEvents();

    const presetSelect = document.getElementById('studioPromptPresets');
    if (presetSelect && !presetSelect._customSelect) CoreAPI.initCustomSelect(presetSelect);

    studioFieldKey = fieldKey;
    studioConversation = [];
    studioLlmMessages = [];
    studioGenerating = false;
    studioLockedSelection = null;
    studioBrainstormMode = false;
    studioBrainstormMessages = [];

    const sourceTextarea = document.getElementById(FIELD_TEXTAREA_MAP[fieldKey]);
    const existingContent = sourceTextarea?.value?.trim() || '';

    studioHistory = [existingContent];
    studioHistoryIdx = 0;

    document.getElementById('studioFieldLabel').textContent = fieldConfig.label;
    document.getElementById('studioContent').value = existingContent;
    document.getElementById('studioInput').value = '';
    document.getElementById('studioInput').placeholder = 'Describe what you want...';
    document.getElementById('studioInput').style.height = '';
    document.getElementById('studioConversation').innerHTML = '';
    document.getElementById('studioHighlightLayer').innerHTML = '';
    document.getElementById('studioContent').classList.remove('has-highlight');

    renderStudioEmptyState(fieldKey, ctx);
    updateStudioHistoryUI();
    updateStudioWordCount();
    updateStudioSendState();
    updateSelectionBadge();
    populateStudioSettings();

    document.getElementById('studioSettingsPanel')?.classList.add('hidden');
    document.getElementById('studioSettingsToggle')?.classList.remove('active');

    const bsToggle = document.getElementById('studioBrainstormToggle');
    if (bsToggle) {
        bsToggle.style.display = BRAINSTORM_FIELDS.has(fieldKey) ? '' : 'none';
        bsToggle.classList.remove('active');
    }
    document.getElementById('studioBrainstormFinalize')?.setAttribute('style', 'display:none;');
    document.getElementById('studioApply')?.removeAttribute('style');
    document.querySelector('.ai-studio-modal')?.classList.remove('brainstorm-mode');

    document.getElementById('aiStudioOverlay').classList.remove('hidden');

    requestAnimationFrame(() => {
        document.getElementById('studioInput')?.focus();
    });
}

function renderStudioEmptyState(fieldKey, ctx) {
    const conv = document.getElementById('studioConversation');
    const suggestions = getFieldSuggestions(fieldKey, ctx.name);

    const chipsHtml = suggestions.map(s =>
        `<button type="button" class="ai-studio-suggestion-chip">${CoreAPI.escapeHtml(s)}</button>`
    ).join('');

    conv.innerHTML = `
        <div class="ai-studio-empty-state" id="studioEmptyState">
            <i class="fa-solid fa-comments"></i>
            <p>Tell the AI what to write. Be specific about tone, style, and details.</p>
            ${chipsHtml ? `<div class="ai-studio-suggestions">${chipsHtml}</div>` : ''}
        </div>`;
}

function getFieldSuggestions(fieldKey, charName) {
    const name = charName || 'this character';
    const map = {
        description: [
            `Write a detailed description for ${name}`,
            `Describe ${name}'s appearance and personality`,
            `Create a mysterious, dark backstory for ${name}`,
            `Write a physical description focusing on distinctive features`,
            `Describe ${name} as seen through a stranger's eyes`,
            `Write a poetic, atmospheric character portrait`,
            `Create a description that reveals personality through habits`,
            `Describe ${name} in the middle of their daily routine`,
            `Write a clinical, dossier-style character profile`,
            `Focus on ${name}'s body language and mannerisms`,
            `Describe ${name} through sensory details (sounds, scents, textures)`,
            `Write a description that hints at a hidden past`,
            `Create a vivid first impression of ${name}`,
            `Describe ${name}'s most striking contradictions`,
            `Write a description emphasizing ${name}'s emotional state`,
        ],
        personality: [
            `List key personality traits for ${name}`,
            `Make ${name} sarcastic and witty`,
            `Give ${name} a warm, nurturing personality`,
            `Create a complex personality with internal conflicts`,
            `Write ${name} as cheerful but hiding deep insecurities`,
            `Make ${name} cold and logical with a hidden soft side`,
            `Give ${name} an unpredictable, chaotic personality`,
            `Write ${name} as stoic and duty-bound`,
            `Make ${name} flirtatious and confident`,
            `Give ${name} a brooding, introspective nature`,
            `Write ${name} as fiercely loyal but quick to anger`,
            `Make ${name} playful and mischievous`,
            `Give ${name} a calm, wise demeanor`,
            `Write ${name} as anxious and overthinking but deeply caring`,
            `Make ${name} bold, blunt, and unapologetically honest`,
        ],
        scenario: [
            `Set the scene in a cozy coffee shop`,
            `Create a fantasy adventure setting`,
            `Write a tense first encounter scenario`,
            `Set the scene during a late-night conversation`,
            `Create a scenario where ${name} needs the user's help`,
            `Write a chance meeting in an unexpected place`,
            `Set the scene in a post-apocalyptic world`,
            `Create a workplace scenario with tension`,
            `Write a scenario set during a festival or celebration`,
            `Set the scene on a long train journey`,
            `Create a scenario involving a shared secret`,
            `Write a scenario where something just went wrong`,
            `Set the scene in a dreamlike, surreal environment`,
            `Create a scenario with an awkward reunion`,
            `Write a scenario involving a dare or challenge`,
        ],
        first_mes: [
            `Write an atmospheric opening message`,
            `Start with ${name} doing something unexpected`,
            `Write a casual, slice-of-life greeting`,
            `Open with ${name} mid-conversation with someone else`,
            `Start with ${name} reacting to the user's arrival`,
            `Write an opening that drops into an action scene`,
            `Start with ${name} lost in thought`,
            `Open with ${name} asking the user for a favor`,
            `Write a moody, rain-soaked opening scene`,
            `Start with ${name} laughing at something`,
            `Open with ${name} in the middle of a crisis`,
            `Write a first message with strong sensory details`,
            `Start with ${name} breaking an awkward silence`,
            `Open mid-argument or disagreement`,
            `Write a mysterious opening that raises questions`,
        ],
        mes_example: [
            `Show ${name}'s typical speech patterns`,
            `Write playful banter between ${name} and the user`,
            `Demonstrate ${name}'s personality through dialogue`,
            `Show how ${name} reacts when angry or upset`,
            `Write ${name} being vulnerable or emotional`,
            `Show ${name}'s sense of humor in conversation`,
            `Write ${name} giving advice or comfort`,
            `Show how ${name} acts in a dangerous situation`,
            `Write ${name} telling a story or reminiscing`,
            `Show ${name}'s reaction to an unexpected compliment`,
            `Write ${name} explaining something they're passionate about`,
            `Show ${name} being evasive or deflecting a question`,
            `Write an example with rich internal monologue`,
            `Show ${name} in a lighthearted, silly moment`,
            `Write ${name} using their signature catchphrase or verbal tic`,
        ],
        system_prompt: [
            `Write a system prompt for immersive roleplay`,
            `Focus on maintaining ${name}'s character voice`,
            `Emphasize descriptive, literary writing style`,
            `Write a system prompt that prioritizes dialogue quality`,
            `Focus on slow-burn pacing and tension building`,
            `Emphasize environmental and sensory descriptions`,
            `Write a prompt that encourages dynamic scene-setting`,
            `Focus on emotional depth and character development`,
            `Emphasize natural, realistic conversation flow`,
            `Write a prompt for action-heavy, fast-paced scenes`,
            `Focus on dark, gritty tone and atmosphere`,
            `Emphasize humor and comedic timing`,
            `Write a prompt that balances narration and dialogue`,
            `Focus on mystery elements and suspense`,
            `Write a prompt emphasizing proactive character behavior`,
        ],
        creator_notes: [
            `Write helpful usage notes for this card`,
            `Explain the recommended settings and scenarios`,
            `Describe what makes ${name} unique`,
            `List the best conversation starters for ${name}`,
            `Describe ${name}'s key relationships and dynamics`,
            `Explain the lore or world-building behind ${name}`,
            `Write tips for getting the best responses`,
            `Describe the intended tone and genre`,
            `List potential story arcs to explore with ${name}`,
            `Explain any special mechanics or triggers in the card`,
            `Describe ${name}'s growth potential over long chats`,
            `Write a brief FAQ for users of this card`,
            `Explain what models or settings work best`,
            `Describe the inspiration behind ${name}`,
            `List ${name}'s likes, dislikes, and boundaries`,
            `Design a rich HTML+CSS creator notes page for ${name}`,
            `Create a fancy styled HTML card page with lore and tips`,
            `Build an elegant dark-themed HTML notes page with sections`,
            `Make a stylish HTML creator page with gradients and icons`,
            `Design a professional HTML card overview with custom fonts`,
        ],
    };
    const all = map[fieldKey] || [];
    if (all.length <= 3) return all;
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, 3);
}

function studioHasUnsavedWork() {
    if (studioBrainstormMode && studioBrainstormMessages.length > 1) return true;
    if (studioHistory.length > 1) return true;
    const current = document.getElementById('studioContent')?.value || '';
    if (current !== (studioHistory[0] || '')) return true;
    return false;
}

function showStudioDiscardConfirm() {
    return new Promise(resolve => {
        let overlay = document.getElementById('studioDiscardConfirmOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'studioDiscardConfirmOverlay';
            overlay.className = 'creator-saveas-diff-overlay';
            overlay.innerHTML = `
            <div class="confirm-modal-content" style="max-width:380px">
                <div class="confirm-modal-header">
                    <h3>Discard AI Studio progress?</h3>
                </div>
                <div class="confirm-modal-body" style="padding:12px 16px">
                    <p style="margin:0;color:var(--text-secondary)">You have unsaved work in the AI Studio. Discard and close?</p>
                </div>
                <div class="confirm-modal-footer">
                    <button type="button" class="action-btn secondary" id="studioDiscardKeepBtn">Keep Editing</button>
                    <button type="button" class="action-btn danger" id="studioDiscardConfirmBtn">Discard</button>
                </div>
            </div>`;
            document.body.appendChild(overlay);
            document.getElementById('studioDiscardKeepBtn').addEventListener('click', () => {
                overlay.classList.add('hidden');
                overlay._resolve?.(false);
            });
            document.getElementById('studioDiscardConfirmBtn').addEventListener('click', () => {
                overlay.classList.add('hidden');
                overlay._resolve?.(true);
            });
            overlay.addEventListener('click', e => {
                if (e.target === overlay) {
                    overlay.classList.add('hidden');
                    overlay._resolve?.(false);
                }
            });
        }
        overlay._resolve = resolve;
        overlay.classList.remove('hidden');
        document.getElementById('studioDiscardKeepBtn')?.focus();
    });
}

async function closeStudio() {
    if (studioHasUnsavedWork()) {
        const confirmed = await showStudioDiscardConfirm();
        if (!confirmed) return;
    }
    forceCloseStudio();
}

function forceCloseStudio() {
    abortController?.abort();
    abortController = null;
    studioGenerating = false;
    document.getElementById('aiStudioOverlay')?.classList.add('hidden');
}

function applyStudio() {
    const content = document.getElementById('studioContent')?.value || '';
    const textareaId = FIELD_TEXTAREA_MAP[studioFieldKey];
    const textarea = document.getElementById(textareaId);

    if (textarea) {
        textarea.value = content;
        textarea.dispatchEvent(new Event('input'));
    }

    const label = FIELD_PROMPTS[studioFieldKey]?.label || 'Field';
    CoreAPI.showToast(`${label} applied`, 'success', 2000);
    forceCloseStudio();
}


// ========================================
// STUDIO UNDO / REDO
// ========================================

function pushStudioSnapshot(content) {
    if (studioHistoryIdx < studioHistory.length - 1) {
        studioHistory = studioHistory.slice(0, studioHistoryIdx + 1);
    }
    studioHistory.push(content);
    if (studioHistory.length > 50) studioHistory.shift();
    studioHistoryIdx = studioHistory.length - 1;
    updateStudioHistoryUI();
}

function studioUndo() {
    if (studioHistoryIdx <= 0) return;
    studioHistoryIdx--;
    document.getElementById('studioContent').value = studioHistory[studioHistoryIdx];
    updateStudioHistoryUI();
    updateStudioWordCount();
}

function studioRedo() {
    if (studioHistoryIdx >= studioHistory.length - 1) return;
    studioHistoryIdx++;
    document.getElementById('studioContent').value = studioHistory[studioHistoryIdx];
    updateStudioHistoryUI();
    updateStudioWordCount();
}

function updateStudioHistoryUI() {
    const undoBtn = document.getElementById('studioUndo');
    const redoBtn = document.getElementById('studioRedo');
    const pos = document.getElementById('studioHistoryPos');

    if (undoBtn) undoBtn.disabled = studioHistoryIdx <= 0;
    if (redoBtn) redoBtn.disabled = studioHistoryIdx >= studioHistory.length - 1;
    if (pos) {
        pos.textContent = studioHistory.length > 1
            ? `${studioHistoryIdx + 1}/${studioHistory.length}`
            : '';
    }
}

function updateStudioWordCount() {
    const content = document.getElementById('studioContent')?.value || '';
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const el = document.getElementById('studioWordCount');
    if (el) el.textContent = `${words} word${words !== 1 ? 's' : ''}`;
}

function updateStudioSendState() {
    const sendBtn = document.getElementById('studioSend');
    const stopBtn = document.getElementById('studioStop');
    if (studioGenerating) {
        sendBtn?.classList.add('hidden');
        stopBtn?.classList.remove('hidden');
    } else {
        sendBtn?.classList.remove('hidden');
        stopBtn?.classList.add('hidden');
    }
}

function updateSelectionBadge() {
    const badge = document.getElementById('studioSelectionBadge');
    if (!badge) return;
    badge.classList.toggle('hidden', !studioLockedSelection);
}

function renderHighlightOverlay() {
    const layer = document.getElementById('studioHighlightLayer');
    const el = document.getElementById('studioContent');
    if (!layer || !el) return;

    if (!studioLockedSelection) {
        layer.innerHTML = '';
        el.classList.remove('has-highlight');
        return;
    }

    const text = el.value;
    const { start, end } = studioLockedSelection;
    if (start >= end || end > text.length) {
        layer.innerHTML = '';
        el.classList.remove('has-highlight');
        return;
    }

    const before = escapeOverlayHtml(text.substring(0, start));
    const selected = escapeOverlayHtml(text.substring(start, end));
    const after = escapeOverlayHtml(text.substring(end));

    layer.innerHTML = `${before}<mark class="ai-studio-mark">${selected}</mark>${after}`;
    el.classList.add('has-highlight');
    syncHighlightScroll();
}

function escapeOverlayHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function syncHighlightScroll() {
    const el = document.getElementById('studioContent');
    const layer = document.getElementById('studioHighlightLayer');
    if (el && layer) {
        layer.scrollTop = el.scrollTop;
        layer.scrollLeft = el.scrollLeft;
    }
}

function clearStudioHighlight() {
    studioLockedSelection = null;
    updateSelectionBadge();
    renderHighlightOverlay();
}

function getStudioSelection() {
    if (!studioLockedSelection) return null;
    const el = document.getElementById('studioContent');
    if (!el) return null;
    const { start, end } = studioLockedSelection;
    if (start >= end || end > el.value.length) return null;
    return {
        text: el.value.substring(start, end),
        before: el.value.substring(0, start),
        after: el.value.substring(end),
        start,
        end,
    };
}


// ========================================
// STUDIO CONVERSATION & GENERATION
// ========================================

function addConversationEntry(role, text) {
    const entry = { role, text, timestamp: Date.now() };
    if (role !== 'thinking') studioConversation.push(entry);
    renderConversationEntry(entry);
}

function renderConversationEntry(entry) {
    const conv = document.getElementById('studioConversation');
    const empty = document.getElementById('studioEmptyState');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = `ai-studio-msg ai-studio-msg-${entry.role}`;

    if (entry.role === 'user') {
        div.innerHTML = `
            <div class="ai-studio-msg-icon"><i class="fa-solid fa-user"></i></div>
            <div class="ai-studio-msg-body">${CoreAPI.escapeHtml(entry.text)}</div>`;
    } else if (entry.role === 'assistant') {
        div.innerHTML = `
            <div class="ai-studio-msg-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <div class="ai-studio-msg-body">${CoreAPI.escapeHtml(entry.text)}</div>`;
    } else if (entry.role === 'error') {
        div.innerHTML = `
            <div class="ai-studio-msg-icon"><i class="fa-solid fa-exclamation-circle"></i></div>
            <div class="ai-studio-msg-body">${CoreAPI.escapeHtml(entry.text)}</div>`;
    } else if (entry.role === 'thinking') {
        div.setAttribute('id', 'studioThinkingMsg');
        div.innerHTML = `
            <div class="ai-studio-msg-icon"><div class="ai-studio-thinking-dots"><span></span><span></span><span></span></div></div>
            <div class="ai-studio-msg-body">Generating...</div>`;
    }

    conv.appendChild(div);
    conv.scrollTop = conv.scrollHeight;
}

async function studioBrainstormGenerate() {
    const input = document.getElementById('studioInput');
    const instruction = input?.value?.trim();
    if (!instruction || studioGenerating) return;

    input.value = '';
    input.style.height = '';
    studioGenerating = true;
    updateStudioSendState();

    addConversationEntry('user', instruction);
    addConversationEntry('thinking', '');

    const ctx = gatherContext();

    let systemContent = BRAINSTORM_SYSTEM + '\n\n';
    systemContent += `Character name: ${ctx.name}\n`;
    if (ctx.tags.length) systemContent += `Tags: ${ctx.tags.join(', ')}\n`;

    const otherFields = [];
    for (const [key, value] of Object.entries(ctx)) {
        if (key === 'name' || key === 'tags' || !value) continue;
        if (typeof value === 'string' && value.trim()) {
            const label = FIELD_PROMPTS[key]?.label || key;
            otherFields.push(`${label}: ${value.slice(0, 300)}`);
        }
    }
    if (otherFields.length) {
        systemContent += '\nExisting character fields for context:\n' + otherFields.join('\n');
    }

    if (studioBrainstormMessages.length === 0) {
        studioBrainstormMessages.push({ role: 'system', content: systemContent });
        studioBrainstormMessages.push({ role: 'user', content: instruction });
    } else {
        studioBrainstormMessages[0] = { role: 'system', content: systemContent };
        studioBrainstormMessages.push({ role: 'user', content: instruction });
    }

    abortController = new AbortController();
    const signal = AbortSignal.any([
        abortController.signal,
        AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    ]);

    try {
        const result = await callLLM(studioBrainstormMessages, signal);
        const content = result?.trim();

        if (!content) {
            addConversationEntry('error', 'AI returned an empty response. Try rephrasing.');
            studioBrainstormMessages.pop();
            return;
        }

        studioBrainstormMessages.push({ role: 'assistant', content });
        addConversationEntry('assistant', content);
    } catch (err) {
        studioBrainstormMessages.pop();
        if (err.message === 'Generation cancelled.') {
            addConversationEntry('error', 'Generation stopped.');
        } else {
            console.error('[Creator] Brainstorm generation failed:', err);
            addConversationEntry('error', err.message || 'Generation failed. Check your connection and try again.');
        }
    } finally {
        document.getElementById('studioThinkingMsg')?.remove();
        studioGenerating = false;
        abortController = null;
        updateStudioSendState();
        document.getElementById('studioInput')?.focus();
    }
}

async function studioGenerate() {
    if (studioBrainstormMode) return studioBrainstormGenerate();

    const input = document.getElementById('studioInput');
    const instruction = input?.value?.trim();
    if (!instruction || studioGenerating) return;

    const fieldConfig = FIELD_PROMPTS[studioFieldKey];
    if (!fieldConfig) return;

    // Capture selection before generation clears it
    const selection = getStudioSelection();
    clearStudioHighlight();

    input.value = '';
    input.style.height = '';
    studioGenerating = true;
    updateStudioSendState();

    if (selection) {
        addConversationEntry('user', `[Selection] ${instruction}`);
    } else {
        addConversationEntry('user', instruction);
    }
    addConversationEntry('thinking', '');

    const currentContent = document.getElementById('studioContent')?.value?.trim() || '';
    const ctx = gatherContext();

    // Build contextual system prompt
    let systemContent = getEffectiveSystemPrompt(studioFieldKey) + '\n\n';
    systemContent += `Character name: ${ctx.name}\n`;
    if (ctx.tags.length) systemContent += `Tags: ${ctx.tags.join(', ')}\n`;

    const otherFields = [];
    for (const [key, value] of Object.entries(ctx)) {
        if (key === 'name' || key === 'tags' || !value) continue;
        if (key === studioFieldKey) continue;
        if (!isFieldContextIncluded(studioFieldKey, key)) continue;
        if (typeof value === 'string' && value.trim()) {
            const label = FIELD_PROMPTS[key]?.label || key;
            otherFields.push(`${label}: ${value.slice(0, 300)}`);
        }
    }
    if (otherFields.length) {
        systemContent += '\nOther character fields for context:\n' + otherFields.join('\n');
    }

    if (selection) {
        systemContent += '\n\nThe user has selected a specific portion of text to revise. You MUST output ONLY the revised version of the selected text. Do NOT include any of the surrounding content. Keep length and format similar to the original selection unless the user asks otherwise. Respond ONLY with the revised selection. No commentary, no explanations.';
    } else {
        systemContent += '\n\nRespond ONLY with the requested content. No commentary, no explanations, no markdown headers.';
    }

    const wordTarget = parseInt(document.getElementById('studioWordTarget')?.value);
    if (wordTarget > 0) {
        systemContent += `\n\nIMPORTANT: Target approximately ${wordTarget} words in your response. This is a soft target, not a hard limit. Prioritize quality and completeness, but aim for roughly ${wordTarget} words.`;
    }

    // Build the user message
    let userMsg;
    if (selection) {
        userMsg = `Here is the full content for reference:\n\n---\n${currentContent}\n---\n\nI have selected this portion to revise:\n\n>>>\n${selection.text}\n>>>\n\nInstruction: ${instruction}`;
    } else if (currentContent) {
        userMsg = studioLlmMessages.length === 0
            ? `Here is the current content:\n\n---\n${currentContent}\n---\n\nInstruction: ${instruction}`
            : `Current content:\n\n---\n${currentContent}\n---\n\nInstruction: ${instruction}`;
    } else {
        userMsg = instruction;
    }

    // Build message thread for multi-turn conversation
    if (studioLlmMessages.length === 0) {
        studioLlmMessages.push({ role: 'system', content: systemContent });
        studioLlmMessages.push({ role: 'user', content: userMsg });
    } else {
        studioLlmMessages[0] = { role: 'system', content: systemContent };
        studioLlmMessages.push({ role: 'user', content: userMsg });
    }

    abortController = new AbortController();
    const signal = AbortSignal.any([
        abortController.signal,
        AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    ]);

    try {
        const result = await callLLM(studioLlmMessages, signal);
        const content = result?.trim();

        if (!content) {
            addConversationEntry('error', 'AI returned an empty response. Try rephrasing your instruction.');
            studioLlmMessages.pop();
            return;
        }

        studioLlmMessages.push({ role: 'assistant', content });

        let finalContent;
        if (selection) {
            // Splice the revised selection back into the full content
            finalContent = selection.before + content + selection.after;
        } else {
            finalContent = content;
        }

        document.getElementById('studioContent').value = finalContent;
        pushStudioSnapshot(finalContent);
        updateStudioWordCount();

        const words = finalContent.split(/\s+/).length;
        if (selection) {
            addConversationEntry('assistant', `Revised selection (${words} total words). You can undo if needed.`);
        } else {
            addConversationEntry('assistant', `Generated (${words} words). You can ask for revisions or apply to the card.`);
        }
    } catch (err) {
        studioLlmMessages.pop();
        if (err.message === 'Generation cancelled.') {
            addConversationEntry('error', 'Generation stopped.');
        } else {
            console.error('[Creator] Studio generation failed:', err);
            addConversationEntry('error', err.message || 'Generation failed. Check your connection and try again.');
        }
    } finally {
        document.getElementById('studioThinkingMsg')?.remove();
        studioGenerating = false;
        abortController = null;
        updateStudioSendState();
        document.getElementById('studioInput')?.focus();
    }
}

function toggleBrainstormMode() {
    if (studioGenerating) return;
    studioBrainstormMode = !studioBrainstormMode;

    const modal = document.querySelector('.ai-studio-modal');
    const toggle = document.getElementById('studioBrainstormToggle');
    const finalizeBtn = document.getElementById('studioBrainstormFinalize');
    const applyBtn = document.getElementById('studioApply');
    const input = document.getElementById('studioInput');

    if (studioBrainstormMode) {
        modal?.classList.add('brainstorm-mode');
        toggle?.classList.add('active');
        if (finalizeBtn) finalizeBtn.style.display = '';
        if (applyBtn) applyBtn.style.display = 'none';

        document.getElementById('studioSettingsPanel')?.classList.add('hidden');
        document.getElementById('studioSettingsToggle')?.classList.remove('active');

        studioBrainstormMessages = [];
        studioConversation = [];
        studioLlmMessages = [];
        document.getElementById('studioConversation').innerHTML = '';
        renderBrainstormEmptyState();

        if (input) input.placeholder = 'Describe your character idea...';
    } else {
        modal?.classList.remove('brainstorm-mode');
        toggle?.classList.remove('active');
        if (finalizeBtn) finalizeBtn.style.display = 'none';
        if (applyBtn) applyBtn.style.display = '';

        studioBrainstormMessages = [];
        studioConversation = [];
        studioLlmMessages = [];
        document.getElementById('studioConversation').innerHTML = '';
        const ctx = gatherContext();
        renderStudioEmptyState(studioFieldKey, ctx);

        if (input) input.placeholder = 'Describe what you want...';
    }

    input?.focus();
}

function renderBrainstormEmptyState() {
    const conv = document.getElementById('studioConversation');
    const name = gatherContext().name || 'your character';
    const suggestions = [
        `I want to create a mysterious character with a hidden past`,
        `Help me develop a cheerful character who hides deep sadness`,
        `I have a rough idea for ${name} but need help fleshing it out`,
        `Let's brainstorm a sci-fi character with unusual abilities`,
        `I want ${name} to feel like a real person with contradictions`,
        `Help me figure out what motivates ${name}`,
    ];
    const shuffled = suggestions.sort(() => Math.random() - 0.5).slice(0, 4);
    const chipsHtml = shuffled.map(s =>
        `<button type="button" class="ai-studio-suggestion-chip">${CoreAPI.escapeHtml(s)}</button>`
    ).join('');

    conv.innerHTML = `
        <div class="ai-studio-empty-state" id="studioEmptyState">
            <i class="fa-solid fa-lightbulb"></i>
            <p>Brainstorm mode: have a conversation to explore your character concept. When you're happy with the direction, hit Finalize to distill it into a description.</p>
            ${chipsHtml ? `<div class="ai-studio-suggestions">${chipsHtml}</div>` : ''}
        </div>`;
}

async function finalizeBrainstorm() {
    if (studioGenerating || studioBrainstormMessages.length === 0) return;

    studioGenerating = true;
    updateStudioSendState();
    addConversationEntry('thinking', '');

    const ctx = gatherContext();
    const fieldPrompt = getEffectiveSystemPrompt(studioFieldKey);

    const distillMessages = [...studioBrainstormMessages];
    distillMessages.push({
        role: 'user',
        content: `Based on everything we've discussed, write the final character description for ${ctx.name}. Follow these guidelines:\n\n${fieldPrompt}\n\nRespond ONLY with the description content. No commentary, no explanations, no markdown headers.`,
    });
    distillMessages[0] = {
        role: 'system',
        content: fieldPrompt + `\n\nCharacter name: ${ctx.name}\n` + (ctx.tags.length ? `Tags: ${ctx.tags.join(', ')}\n` : ''),
    };

    abortController = new AbortController();
    const signal = AbortSignal.any([
        abortController.signal,
        AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    ]);

    try {
        const result = await callLLM(distillMessages, signal);
        const content = result?.trim();

        if (!content) {
            addConversationEntry('error', 'AI returned an empty response. Try finalizing again.');
            return;
        }

        document.getElementById('studioContent').value = content;
        pushStudioSnapshot(content);
        updateStudioWordCount();

        const words = content.split(/\s+/).length;
        addConversationEntry('assistant', `Finalized into description (${words} words). Review in the content area, then Apply to card.`);

        toggleBrainstormMode();
    } catch (err) {
        if (err.message === 'Generation cancelled.') {
            addConversationEntry('error', 'Generation stopped.');
        } else {
            console.error('[Creator] Brainstorm finalization failed:', err);
            addConversationEntry('error', err.message || 'Finalization failed. Check your connection and try again.');
        }
    } finally {
        document.getElementById('studioThinkingMsg')?.remove();
        studioGenerating = false;
        abortController = null;
        updateStudioSendState();
    }
}

function studioStopGeneration() {
    abortController?.abort();
    abortController = null;
}

function extractContent(data) {
    if (typeof data === 'string') return data.trim();
    if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    if (data?.content) return data.content.trim();
    return JSON.stringify(data);
}


// ========================================
// CHARACTER CREATION
// ========================================

async function handleCreate() {
    const name = document.getElementById('creatorName')?.value?.trim();
    if (!name) {
        CoreAPI.showToast('Character name is required', 'warning');
        document.getElementById('creatorName')?.focus();
        return;
    }

    if (name.length > 128) {
        CoreAPI.showToast('Character name is too long (max 128 characters)', 'warning');
        return;
    }

    const createBtn = document.getElementById('creatorCreateBtn');
    createBtn.disabled = true;
    createBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';

    try {
        const card = buildCharacterCard();
        const pngBuffer = avatarBuffer || await buildPlaceholderPng();
        const embeddedPng = CoreAPI.embedCharacterDataInPng(pngBuffer, card);

        if (!embeddedPng) {
            throw new Error('Failed to embed character data in PNG');
        }

        const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
        const file = new File([embeddedPng], `${safeName}.png`, { type: 'image/png' });

        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');

        const csrfToken = CoreAPI.getCSRFToken();
        const response = await fetch('/api/characters/import', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Import failed: ${errText}`);
        }

        const result = await response.json();
        if (result.error) throw new Error('Server returned an error after import');

        CoreAPI.showToast(`Character "${name}" created!`, 'success');

        await CoreAPI.fetchCharacters(true);

        closeModal();

        // Try to open the newly created character
        const newAvatar = result.file_name;
        if (newAvatar) {
            const chars = CoreAPI.getAllCharacters();
            const newChar = chars.find(c => c.avatar === newAvatar);
            if (newChar) {
                CoreAPI.openCharacterModal(newChar);
            }
        }
    } catch (err) {
        console.error('[Creator] Character creation failed:', err);
        CoreAPI.showToast(`Creation failed: ${err.message}`, 'error');
    } finally {
        createBtn.disabled = false;
        createBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Character';
    }
}

// ========================================
// SAVE AS EXISTING CHARACTER
// ========================================

let saveAsDiffInjected = false;

function createSaveAsDiffModal() {
    if (saveAsDiffInjected) return;
    saveAsDiffInjected = true;

    const html = `
    <div id="creatorSaveAsDiff" class="creator-saveas-diff-overlay hidden">
        <div class="confirm-modal-content creator-saveas-diff-content">
            <div class="confirm-modal-header">
                <h3><i class="fa-solid fa-code-compare"></i> Review Changes</h3>
                <button type="button" class="close-confirm-btn" id="saveAsDiffClose">&times;</button>
            </div>
            <div class="confirm-modal-body">
                <p class="creator-saveas-diff-subtitle" id="saveAsDiffSubtitle">Changes to be applied:</p>
                <div class="changes-diff" id="saveAsDiffContainer"></div>
            </div>
            <div class="confirm-modal-footer">
                <button type="button" class="action-btn secondary" id="saveAsDiffCancel">Cancel</button>
                <button type="button" class="action-btn primary" id="saveAsDiffConfirm">
                    <i class="fa-solid fa-floppy-disk"></i> Save Changes
                </button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('saveAsDiffClose').addEventListener('click', closeSaveAsDiff);
    document.getElementById('saveAsDiffCancel').addEventListener('click', closeSaveAsDiff);
    document.getElementById('saveAsDiffConfirm').addEventListener('click', confirmSaveAs);
    document.getElementById('creatorSaveAsDiff').addEventListener('click', (e) => {
        if (e.target.id === 'creatorSaveAsDiff') closeSaveAsDiff();
    });
}

function closeSaveAsDiff() {
    document.getElementById('creatorSaveAsDiff')?.classList.add('hidden');
}

function openSaveAsPicker() {
    closeSplitMenu();
    const name = document.getElementById('creatorName')?.value?.trim();
    if (!name) {
        CoreAPI.showToast('Enter a character name first', 'warning');
        document.getElementById('creatorName')?.focus();
        return;
    }
    createImportPicker();
    document.getElementById('importPickerSearch').value = '';
    renderImportList('', true);
    document.getElementById('creatorImportPicker').classList.remove('hidden');
    document.getElementById('creatorImportPicker').dataset.mode = 'saveas';
    document.getElementById('creatorImportPicker').querySelector('h3').innerHTML =
        '<i class="fa-solid fa-floppy-disk"></i> Save As...';
    requestAnimationFrame(() => document.getElementById('importPickerSearch')?.focus());
}

async function handleSaveAsSelection(avatar) {
    closeImportPicker();
    // Restore picker title for import use
    const pickerH3 = document.getElementById('creatorImportPicker')?.querySelector('h3');
    if (pickerH3) pickerH3.innerHTML = '<i class="fa-solid fa-file-import"></i> Import from Library';

    const chars = CoreAPI.getAllCharacters() || [];
    const char = chars.find(c => c.avatar === avatar);
    if (!char) { CoreAPI.showToast('Character not found', 'error'); return; }

    await CoreAPI.hydrateCharacter(char);
    saveAsTarget = char;

    const currentValues = collectCreatorValues();
    const originalValues = extractOriginalValues(char);
    const changes = generateCreatorDiff(originalValues, currentValues);

    const hasAvatarChange = avatarBuffer && avatarSourceAvatar !== avatar;

    if (changes.length === 0 && !hasAvatarChange) {
        CoreAPI.showToast('No changes detected vs. this character', 'info');
        saveAsTarget = null;
        return;
    }

    createSaveAsDiffModal();
    const totalChanges = changes.length + (hasAvatarChange ? 1 : 0);
    document.getElementById('saveAsDiffSubtitle').textContent =
        `${totalChanges} field${totalChanges > 1 ? 's' : ''} changed on "${char.name}":`;

    let diffHtml = '';
    if (hasAvatarChange) {
        const oldSrc = `/characters/${encodeURIComponent(avatar)}`;
        const newSrc = avatarDataUrl;
        diffHtml += `
        <div class="diff-item">
            <div class="diff-item-label">Avatar</div>
            <div class="diff-avatar-row">
                <div class="diff-avatar-side diff-old">
                    <img src="${CoreAPI.escapeHtml(oldSrc)}" alt="Current">
                    <span>Current</span>
                </div>
                <div class="diff-avatar-arrow"><i class="fa-solid fa-arrow-right"></i></div>
                <div class="diff-avatar-side diff-new">
                    <img src="${CoreAPI.escapeHtml(newSrc)}" alt="New">
                    <span>New</span>
                </div>
            </div>
        </div>`;
    }
    diffHtml += changes.map(c => `
        <div class="diff-item">
            <div class="diff-item-label">${CoreAPI.escapeHtml(c.field)}</div>
            <div class="diff-old">${c.oldHtml}</div>
            <div class="diff-arrow">\u2193</div>
            <div class="diff-new">${c.newHtml}</div>
        </div>
    `).join('');
    document.getElementById('saveAsDiffContainer').innerHTML = diffHtml;
    document.getElementById('creatorSaveAsDiff').classList.remove('hidden');
}

function collectCreatorValues() {
    return {
        name: document.getElementById('creatorName').value.trim(),
        description: document.getElementById('creatorDescription').value.trim(),
        personality: document.getElementById('creatorPersonality').value.trim(),
        scenario: document.getElementById('creatorScenario').value.trim(),
        first_mes: document.getElementById('creatorFirstMes').value.trim(),
        mes_example: document.getElementById('creatorMesExample').value.trim(),
        system_prompt: document.getElementById('creatorSystemPrompt').value.trim(),
        post_history_instructions: document.getElementById('creatorPostHistory').value.trim(),
        creator_notes: document.getElementById('creatorNotes').value.trim(),
        creator: document.getElementById('creatorAuthor').value.trim(),
        character_version: document.getElementById('creatorVersion').value.trim(),
        tags: [...creatorTagsArray],
        alternate_greetings: collectAltGreetings(),
    };
}

function extractOriginalValues(char) {
    const d = char.data || {};
    return {
        name: char.name || '',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || '',
        mes_example: d.mes_example || '',
        system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '',
        creator_notes: d.creator_notes || '',
        creator: d.creator || '',
        character_version: d.character_version || '',
        tags: Array.isArray(d.tags) ? [...d.tags] : [],
        alternate_greetings: Array.isArray(d.alternate_greetings) ? [...d.alternate_greetings] : [],
    };
}

const DIFF_FIELD_LABELS = {
    name: 'Character Name', description: 'Description', personality: 'Personality',
    scenario: 'Scenario', first_mes: 'First Message', mes_example: 'Example Dialogue',
    system_prompt: 'System Prompt', post_history_instructions: 'Post-History Instructions',
    creator_notes: "Creator's Notes", creator: 'Creator', character_version: 'Version',
    tags: 'Tags', alternate_greetings: 'Alternate Greetings',
};

function generateCreatorDiff(original, current) {
    const changes = [];
    const norm = s => String(s || '').replace(/\r\n/g, '\n').trim();

    for (const key of Object.keys(DIFF_FIELD_LABELS)) {
        if (key === 'tags') {
            const oldT = (original.tags || []).map(t => norm(t)).filter(Boolean).sort((a, b) => a.localeCompare(b));
            const newT = (current.tags || []).map(t => norm(t)).filter(Boolean).sort((a, b) => a.localeCompare(b));
            if (JSON.stringify(oldT) !== JSON.stringify(newT)) {
                changes.push({
                    field: DIFF_FIELD_LABELS[key],
                    oldHtml: CoreAPI.escapeHtml(oldT.join(', ') || '(none)'),
                    newHtml: CoreAPI.escapeHtml(newT.join(', ') || '(none)'),
                });
            }
            continue;
        }
        if (key === 'alternate_greetings') {
            const oldG = (original.alternate_greetings || []).map(g => norm(g)).filter(Boolean);
            const newG = (current.alternate_greetings || []).map(g => norm(g)).filter(Boolean);
            if (JSON.stringify(oldG) !== JSON.stringify(newG)) {
                changes.push({
                    field: DIFF_FIELD_LABELS[key],
                    oldHtml: CoreAPI.escapeHtml(oldG.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'),
                    newHtml: CoreAPI.escapeHtml(newG.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'),
                });
            }
            continue;
        }
        const oldVal = norm(original[key]);
        const newVal = norm(current[key]);
        if (oldVal === newVal) continue;
        changes.push({
            field: DIFF_FIELD_LABELS[key],
            oldHtml: diffHighlight(oldVal, newVal, 'old'),
            newHtml: diffHighlight(oldVal, newVal, 'new'),
        });
    }
    return changes;
}

function diffHighlight(oldStr, newStr, side) {
    if (!oldStr && !newStr) return '<span class="diff-empty">(empty)</span>';
    if (!oldStr) return side === 'old' ? '<span class="diff-empty">(empty)</span>' : `<span class="diff-added">${CoreAPI.escapeHtml(truncDiff(newStr))}</span>`;
    if (!newStr) return side === 'new' ? '<span class="diff-empty">(empty)</span>' : `<span class="diff-removed">${CoreAPI.escapeHtml(truncDiff(oldStr))}</span>`;

    const diffStart = findDiffStart(oldStr, newStr);
    if (diffStart === -1) return CoreAPI.escapeHtml(side === 'old' ? oldStr : newStr);
    const diffEndOld = findDiffEndPos(oldStr, newStr);
    const diffEndNew = findDiffEndPos(newStr, oldStr);

    const str = side === 'old' ? oldStr : newStr;
    const endPos = side === 'old' ? diffEndOld : diffEndNew;
    const cls = side === 'old' ? 'diff-removed' : 'diff-added';

    const MAX = 200;
    if (str.length <= MAX) return buildMarked(str, diffStart, endPos, cls);

    const ctxBefore = 30;
    const start = Math.max(0, diffStart - ctxBefore);
    const end = Math.min(str.length, Math.max(endPos, diffStart) + (MAX - ctxBefore));
    const excerpt = str.substring(start, end);
    const prefix = start > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const suffix = end < str.length ? '<span class="diff-ellipsis">...</span>' : '';
    return prefix + buildMarked(excerpt, diffStart - start, endPos - start, cls) + suffix;
}

function findDiffStart(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { if (a[i] !== b[i]) return i; }
    return a.length === b.length ? -1 : len;
}

function findDiffEndPos(str, other) {
    let si = str.length - 1, oi = other.length - 1;
    while (si >= 0 && oi >= 0 && str[si] === other[oi]) { si--; oi--; }
    return si + 1;
}

function buildMarked(str, start, end, cls) {
    if (start < 0) start = 0;
    if (end > str.length) end = str.length;
    if (start >= end) return CoreAPI.escapeHtml(str);
    return CoreAPI.escapeHtml(str.substring(0, start)) +
        `<span class="${cls}">${CoreAPI.escapeHtml(str.substring(start, end))}</span>` +
        CoreAPI.escapeHtml(str.substring(end));
}

function truncDiff(s, max = 200) {
    return s.length <= max ? s : s.substring(0, max) + '...';
}

async function confirmSaveAs() {
    if (!saveAsTarget) return;
    const btn = document.getElementById('saveAsDiffConfirm');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const current = collectCreatorValues();
        const existingData = saveAsTarget.data || {};
        const existingExtensions = existingData.extensions || {};
        const existingCreateDate = saveAsTarget.create_date;
        const existingSpec = saveAsTarget.spec || existingData.spec;
        const existingSpecVersion = saveAsTarget.spec_version || existingData.spec_version;

        const payload = {
            avatar: saveAsTarget.avatar,
            ...(existingSpec && { spec: existingSpec }),
            ...(existingSpecVersion && { spec_version: existingSpecVersion }),
            name: current.name,
            description: current.description,
            first_mes: current.first_mes,
            personality: current.personality,
            scenario: current.scenario,
            mes_example: current.mes_example,
            system_prompt: current.system_prompt,
            post_history_instructions: current.post_history_instructions,
            creator_notes: current.creator_notes,
            creator: current.creator,
            character_version: current.character_version,
            tags: current.tags,
            alternate_greetings: current.alternate_greetings,
            create_date: existingCreateDate,
            data: {
                ...existingData,
                name: current.name,
                description: current.description,
                first_mes: current.first_mes,
                personality: current.personality,
                scenario: current.scenario,
                mes_example: current.mes_example,
                system_prompt: current.system_prompt,
                post_history_instructions: current.post_history_instructions,
                creator_notes: current.creator_notes,
                creator: current.creator,
                character_version: current.character_version,
                tags: current.tags,
                alternate_greetings: current.alternate_greetings,
                create_date: existingCreateDate,
                extensions: existingExtensions,
            },
        };

        // Auto-snapshot before overwrite (same pattern as detail modal edit save)
        try { await CoreAPI.autoSnapshotBeforeChange(saveAsTarget, 'edit'); } catch (snapErr) {
            CoreAPI.debugLog('[Creator] Auto-snapshot failed (non-blocking):', snapErr);
        }

        const resp = await CoreAPI.apiRequest('/characters/merge-attributes', 'POST', payload);
        if (!resp?.ok) throw new Error('Save failed');

        // Upload new avatar if changed (edit-avatar reads existing card data from PNG, preserving all fields)
        const hasAvatarChange = avatarBuffer && avatarSourceAvatar !== saveAsTarget.avatar;
        if (hasAvatarChange) {
            const formData = new FormData();
            formData.append('avatar', new File([avatarBuffer], 'avatar.png', { type: 'image/png' }));
            formData.append('avatar_url', saveAsTarget.avatar);

            const csrfToken = CoreAPI.getCSRFToken();
            const avatarResp = await fetch('/api/characters/edit-avatar', {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken },
                body: formData,
            });
            if (!avatarResp.ok) throw new Error(`Avatar upload failed: ${avatarResp.status}`);
        }

        CoreAPI.showToast(`Saved over "${saveAsTarget.name}"`, 'success');
        await CoreAPI.fetchCharacters(true);
        closeSaveAsDiff();
        closeModal();
    } catch (err) {
        console.error('[Creator] Save-as failed:', err);
        CoreAPI.showToast(`Save failed: ${err.message}`, 'error');
    } finally {
        saveAsTarget = null;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
}

function toggleSplitMenu() {
    const menu = document.getElementById('creatorSplitMenu');
    menu?.classList.toggle('hidden');
}

function closeSplitMenu() {
    document.getElementById('creatorSplitMenu')?.classList.add('hidden');
}

function buildCharacterCard() {
    const name = document.getElementById('creatorName').value.trim();
    const creator = document.getElementById('creatorAuthor').value.trim();
    const version = document.getElementById('creatorVersion').value.trim();
    const description = document.getElementById('creatorDescription').value.trim();
    const personality = document.getElementById('creatorPersonality').value.trim();
    const scenario = document.getElementById('creatorScenario').value.trim();
    const firstMes = document.getElementById('creatorFirstMes').value.trim();
    const mesExample = document.getElementById('creatorMesExample').value.trim();
    const systemPrompt = document.getElementById('creatorSystemPrompt').value.trim();
    const postHistory = document.getElementById('creatorPostHistory').value.trim();
    const creatorNotes = document.getElementById('creatorNotes').value.trim();
    const altGreetings = collectAltGreetings();
    const tags = [...creatorTagsArray];

    const extensions = {
        talkativeness: '0.5',
        fav: false,
        world: '',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        group_only_greetings: [],
    };

    // Assign gallery ID if the setting is enabled
    if (CoreAPI.getSetting('uniqueGalleryFolders')) {
        extensions.gallery_id = CoreAPI.generateGalleryId();
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality,
            scenario,
            first_mes: firstMes,
            mes_example: mesExample,
            system_prompt: systemPrompt,
            post_history_instructions: postHistory,
            creator_notes: creatorNotes,
            creator,
            character_version: version,
            tags,
            alternate_greetings: altGreetings,
            extensions,
        },
    };
}


// ========================================
// MODULE INIT & EXPORTS
// ========================================

function init() {
    // Register all creator overlays with the overlay registry.
    // The global Escape handler (library.js) and mobile back-button stack
    // (library-mobile.js) both read from this registry — no per-overlay
    // Escape listeners or manual mobile stack entries needed.
    const reg = window.registerOverlay?.bind(window);
    if (!reg) return;

    reg({ id: 'studioDiscardConfirmOverlay', tier: 0, close: (el) => { el.classList.add('hidden'); document.getElementById('studioDiscardKeepBtn')?.click(); } });
    reg({ id: 'aiStudioOverlay',             tier: 1, close: () => window.closeAiStudio?.() });
    reg({ id: 'creatorNotesPreview',          tier: 2, close: () => window.closeNotesPreview?.() });
    reg({ id: 'creatorDiscardConfirmOverlay', tier: 3, close: (el) => { el.classList.add('hidden'); document.getElementById('creatorDiscardKeepBtn')?.click(); } });
    reg({ id: 'creatorSaveAsDiff',            tier: 4, close: (el) => el.classList.add('hidden') });
    reg({ id: 'creatorImportPicker',          tier: 5, close: () => closeImportPicker?.() });
    reg({ id: 'creatorNamePromptOverlay',     tier: 6, close: () => document.getElementById('creatorNamePromptCancel')?.click() });
    reg({ id: 'creatorModal',                 tier: 7, close: () => maybeClose?.() });
}

export { openModal, closeModal, closeStudio, closeNotesPreview };

export default {
    init,
    openModal,
};
