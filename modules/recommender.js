// AI Card Recommender Module
// Samples characters from the library, sends metadata to an LLM, displays recommendations

import * as CoreAPI from './core-api.js';
// Canonical XSS-safe rich-text config (shared, never redefined) for rendering the chat's LLM output.
import { BROWSE_PURIFY_CONFIG } from './providers/provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

const SYSTEM_PROMPT = `You are a character recommendation engine for an AI roleplay character library. You will receive a numbered list of characters with metadata (name, tags, creator, tagline). The user will describe what they're looking for.

Your job: recommend characters from the list that best match the user's request.

RULES:
- Only recommend characters from the provided list. Never invent characters.
- Use the character's index number (e.g. #1, #5) to identify them.
- Provide a brief reason for each recommendation.
- If nothing matches well, say so honestly and suggest the closest options.
- "creator notes" and "tagline" are different fields. Creator notes are the card author's notes about the character. Tagline is a short description from the hosting provider.
- Respond ONLY with a JSON array. No other text before or after.

Response format:
[
  {"index": 1, "reason": "Brief explanation"},
  {"index": 5, "reason": "Brief explanation"}
]`;

const REDUCE_SYSTEM_PROMPT = `You are a character recommendation engine performing a final ranking. You will receive candidate characters pre-selected from a larger library in multiple evaluation batches. Each candidate includes metadata and the reason it was initially selected.

Your job: pick the BEST matches for the user's request from these pre-selected candidates.

RULES:
- Only pick characters from the provided candidate list.
- Use the candidate's index number to identify them.
- Provide a final reason for each pick (you may refine the initial reason).
- Respond ONLY with a JSON array. No other text.

Response format:
[
  {"index": 1, "reason": "Brief explanation"},
  {"index": 5, "reason": "Brief explanation"}
]`;

const CHAR_CHAT_SYSTEM_BASE = `You are a sharp, enthusiastic guide helping a user explore a character card from their library. Speak ABOUT the character in the third person; never role-play as them. Make the user genuinely understand and feel this card's appeal, grounded entirely in the card data below.

Voice: vivid and specific. Lead with the hook. Cite concrete details from the card instead of generic praise. You can flag genuine problems (incoherent or contradictory writing, one-note characterization, broken mechanics) when they're real, but do NOT treat sparse or open-ended elements as flaws: underspecified side characters, locations, or plot threads are usually deliberate room for the player to fill in and shape across replays, a strength rather than a deficiency. Read open-endedness as opportunity.

`;

const CHAR_CHAT_FORMAT_RICH = `Formatting: write rich, scannable HTML, not flat text. Reach for <h3>/<h4> section headings, <strong>/<em>, <ul>/<li>, <blockquote>, and <table> when they help. Don't be shy with presentation: set off a region, location, or lorebook entry in a styled <div> (inline style is fine), highlight a name or trait with a colored <span>, tuck optional depth into <details><summary>. Aim for something that looks designed. Short answers can stay plain.

`;

const CHAR_CHAT_FORMAT_PLAIN = `Formatting: keep it clean using plain markdown structure only. Headings, tables, bold, italics, bullet and numbered lists, and blockquotes are all welcome and encouraged. Do NOT use inline CSS, styled <div> blocks, background colors, or colored text; the styling stays simple. Short answers can stay plain.

`;

const CHAR_CHAT_TAIL = `Use only the card data provided. If it doesn't cover what the user asks, say so rather than inventing details.`;

// The two built-in presets. The editable prompt is instructions only; the card JSON is appended at send time.
const CHAR_CHAT_DEFAULT_RICH = CHAR_CHAT_SYSTEM_BASE + CHAR_CHAT_FORMAT_RICH + CHAR_CHAT_TAIL;
const CHAR_CHAT_DEFAULT_PLAIN = CHAR_CHAT_SYSTEM_BASE + CHAR_CHAT_FORMAT_PLAIN + CHAR_CHAT_TAIL;

const DEFAULT_SETTINGS = {
    sampleSize: 100,
    temperature: 0.7,
    maxResults: 10,
    includeTags: true,
    includeCreatorNotes: true,
    includeTagline: true,
    includeCreator: true,
    includeSource: false,
    includeDescription: false,
    batchMode: false,
    batchCount: 3,
    filterHasChats: 'any',
    filterFavorite: 'any',
    filterDateEnabled: false,
    filterDateFrom: '',
    filterDateTo: '',
    filterTagsInclude: [],
    filterTagsExclude: [],
    apiMode: 'sillytavern',
    stProfileId: '',
    customApiUrl: '',
    customApiKey: '',
    customModel: '',
};

const GENERATE_TIMEOUT_MS = 120_000;

let isInitialized = false;
let isGenerating = false;
let abortController = null;
let sampledCharacters = null;
let loadedProfiles = [];
let activeSource = '';
let activeModel = '';
let activePreset = null;
let lastDebugContext = null;
let _lastRawApiResponse = null;
let _lastEvaluatedCount = 0;
let _lastPrompt = '';
let _excludedAvatars = new Set();

// Character chat ("ask about this character"): ephemeral per-open session state.
let chatChar = null;
let chatConversation = [];
let chatAbortController = null;
let chatLorebookInfo = null;
let chatBusy = false;


// ========================================
// SETTINGS HELPERS
// ========================================

function getOpt(key) {
    const val = CoreAPI.getSetting(`recommender_${key}`);
    return val !== undefined && val !== null ? val : DEFAULT_SETTINGS[key];
}

function setOpt(key, value) {
    CoreAPI.setSetting(`recommender_${key}`, value);
}

// MessageChannel macrotask yield so progress ticks paint (queueMicrotask drains pre-paint; setTimeout(0) is clamped to 4ms).
const _yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const _yieldResolvers = [];
if (_yieldChannel) {
    _yieldChannel.port1.onmessage = () => {
        const r = _yieldResolvers.shift();
        if (r) r();
    };
}
function yieldToBrowser() {
    if (_yieldChannel) {
        return new Promise(resolve => {
            _yieldResolvers.push(resolve);
            _yieldChannel.port2.postMessage(null);
        });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}

const YIELD_BUDGET_MS = 16;


// ========================================
// MODAL CREATION
// ========================================

function createModal() {
    const html = `
    <div id="recommenderModal" class="cl-modal">
        <div class="cl-modal-content recommender-modal-content">
            <div class="cl-modal-header">
                <h3>
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>Card Recommender</span>
                </h3>
                <button class="cl-modal-close" id="recommenderCloseBtn" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="recommender-body">
                <div class="recommender-input-area">
                    <textarea id="recommenderPrompt" class="recommender-prompt" rows="3"
                        placeholder="Describe what you're looking for — e.g. cozy fantasy girls, dark horror, sci-fi androids..." autocomplete="one-time-code"></textarea>
                    <button class="recommender-submit-btn" id="recommenderSubmitBtn" title="Generate recommendations">
                        <i class="fa-solid fa-wand-magic-sparkles"></i><span class="recommender-submit-label">Recommend</span>
                    </button>
                </div>

                <div class="recommender-toolbar">
                    <div class="recommender-api-toggle" id="recommenderApiToggle">
                        <button class="recommender-api-mode-btn active" data-mode="sillytavern" title="Use SillyTavern connection">ST</button>
                        <button class="recommender-api-mode-btn" data-mode="custom" title="Use custom API endpoint">Custom</button>
                    </div>

                    <div class="recommender-profile-area" id="recommenderStConnection">
                        <select id="recommenderStProfile" class="hidden">
                            <option value="" disabled selected>No profiles</option>
                        </select>
                        <div class="recommender-profile-status">
                            <span class="recommender-connection-dot"></span>
                            <span id="recommenderStConnectionText" class="recommender-connection-text">Loading...</span>
                        </div>
                    </div>

                    <div class="recommender-profile-area hidden" id="recommenderCustomConnection">
                        <div class="recommender-profile-status">
                            <span class="recommender-connection-dot neutral"></span>
                            <span id="recommenderCustomConnectionText" class="recommender-connection-text">Not configured</span>
                        </div>
                    </div>

                    <button class="recommender-toolbar-btn" id="recommenderSettingsToggle" title="Settings">
                        <i class="fa-solid fa-sliders"></i>
                    </button>
                </div>

                <div id="recommenderCustomApiFields" class="recommender-custom-api hidden">
                    <input type="text" id="recommenderApiUrl" class="recommender-field"
                        placeholder="OpenAI-compatible base URL (e.g. https://api.example.com/v1)" autocomplete="one-time-code">
                    <input type="password" id="recommenderApiKey" class="recommender-field"
                        placeholder="API Key (optional)" autocomplete="new-password">
                    <input type="text" id="recommenderModel" class="recommender-field"
                        placeholder="Model (e.g. gpt-4o-mini)" autocomplete="one-time-code">
                </div>

                <div id="recommenderSettingsPanel" class="recommender-settings-panel hidden">
                    <div class="recommender-settings-inner">

                        <div class="recommender-setting-section">
                            <div class="recommender-setting-section-title"><i class="fa-solid fa-filter"></i> Sample Pool</div>

                            <div class="recommender-filter-row">
                                <label class="recommender-filter-label">Has Chats</label>
                                <div class="recommender-tristate" id="recommenderFilterHasChats">
                                    <button class="recommender-tristate-btn" data-value="yes">Yes</button>
                                    <button class="recommender-tristate-btn active" data-value="any">Any</button>
                                    <button class="recommender-tristate-btn" data-value="no">No</button>
                                </div>
                            </div>

                            <div class="recommender-filter-row">
                                <label class="recommender-filter-label">Favorite</label>
                                <div class="recommender-tristate" id="recommenderFilterFavorite">
                                    <button class="recommender-tristate-btn" data-value="yes">Yes</button>
                                    <button class="recommender-tristate-btn active" data-value="any">Any</button>
                                    <button class="recommender-tristate-btn" data-value="no">No</button>
                                </div>
                            </div>

                            <div class="recommender-filter-row recommender-filter-row-col">
                                <div class="recommender-filter-date-header">
                                    <label class="recommender-filter-label">Date Created</label>
                                    <label class="recommender-toggle-chip recommender-toggle-chip-sm">
                                        <input type="checkbox" id="recommenderFilterDateEnabled">
                                        <span>Enable</span>
                                    </label>
                                </div>
                                <div id="recommenderDateRange" class="recommender-date-range hidden">
                                    <input type="date" id="recommenderFilterDateFrom" class="recommender-field recommender-field-sm">
                                    <span class="recommender-date-sep">to</span>
                                    <input type="date" id="recommenderFilterDateTo" class="recommender-field recommender-field-sm">
                                </div>
                            </div>

                            <div class="recommender-filter-row recommender-filter-row-col">
                                <label class="recommender-filter-label">Include Tags</label>
                                <div class="recommender-tag-input-wrap">
                                    <input type="search" id="recommenderTagIncludeInput" class="recommender-field recommender-field-sm"
                                        placeholder="Type tag + Enter" autocomplete="one-time-code">
                                    <div id="recommenderTagIncludeAC" class="recommender-tag-autocomplete"></div>
                                    <div id="recommenderTagIncludePills" class="recommender-tag-pills"></div>
                                </div>
                            </div>

                            <div class="recommender-filter-row recommender-filter-row-col">
                                <label class="recommender-filter-label">Exclude Tags</label>
                                <div class="recommender-tag-input-wrap">
                                    <input type="search" id="recommenderTagExcludeInput" class="recommender-field recommender-field-sm"
                                        placeholder="Type tag + Enter" autocomplete="one-time-code">
                                    <div id="recommenderTagExcludeAC" class="recommender-tag-autocomplete"></div>
                                    <div id="recommenderTagExcludePills" class="recommender-tag-pills"></div>
                                </div>
                            </div>

                            <div class="recommender-pool-count" id="recommenderPoolCount"></div>
                        </div>

                        <div class="recommender-setting-section">
                            <div class="recommender-setting-section-title"><i class="fa-solid fa-brain"></i> LLM Context</div>
                            <div class="recommender-toggles-row">
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeTags">
                                    <span><i class="fa-solid fa-tags"></i> Tags</span>
                                </label>
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeCreatorNotes">
                                    <span><i class="fa-solid fa-quote-left"></i> Creator Notes</span>
                                </label>
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeTagline">
                                    <span><i class="fa-solid fa-message"></i> Tagline</span>
                                </label>
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeDescription">
                                    <span><i class="fa-solid fa-align-left"></i> Description</span>
                                </label>
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeCreator">
                                    <span><i class="fa-solid fa-user-pen"></i> Creator</span>
                                </label>
                                <label class="recommender-toggle-chip">
                                    <input type="checkbox" id="recommenderIncludeSource">
                                    <span><i class="fa-solid fa-globe"></i> Source</span>
                                </label>
                            </div>
                            <div class="recommender-token-estimate" id="recommenderTokenEstimate"></div>
                        </div>

                        <div class="recommender-setting-section">
                            <div class="recommender-setting-section-title"><i class="fa-solid fa-sliders"></i> Generation</div>
                            <div class="recommender-sliders">
                                <div class="recommender-slider-row">
                                    <label>Sample</label>
                                    <input type="range" id="recommenderSampleSize" min="10" max="500" step="10">
                                    <span id="recommenderSampleSizeValue" class="recommender-slider-val"></span>
                                </div>
                                <div class="recommender-slider-row" id="recommenderTempRow">
                                    <label>Temp</label>
                                    <input type="range" id="recommenderTemperature" min="0.1" max="2.0" step="0.1">
                                    <span id="recommenderTemperatureValue" class="recommender-slider-val"></span>
                                </div>
                                <div class="recommender-slider-row">
                                    <label>Max</label>
                                    <input type="range" id="recommenderMaxResults" min="1" max="20" step="1">
                                    <span id="recommenderMaxResultsValue" class="recommender-slider-val"></span>
                                </div>
                            </div>
                            <label class="recommender-toggle-chip recommender-batch-toggle" title="Split your pool into parallel batches for wider library coverage">
                                <input type="checkbox" id="recommenderBatchMode">
                                <span><i class="fa-solid fa-layer-group"></i> Batch Mode <span class="recommender-batch-hint" id="recommenderBatchHint">3× coverage</span></span>
                            </label>
                            <div class="recommender-batch-slider-row hidden" id="recommenderBatchSliderRow">
                                <label>Batches</label>
                                <input type="range" id="recommenderBatchCount" min="3" max="7" step="1">
                                <span id="recommenderBatchCountValue" class="recommender-slider-val">3</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="recommenderResults" class="recommender-results hidden"></div>

                <div id="recommenderStatus" class="recommender-status hidden"></div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    document.body.insertAdjacentHTML('beforeend', charChatModalHtml());
}


// ========================================
// MODAL LIFECYCLE
// ========================================

function openModal() {
    let modal = document.getElementById('recommenderModal');
    if (!modal) {
        createModal();
        modal = document.getElementById('recommenderModal');
        attachEvents();
        const profileSelect = document.getElementById('recommenderStProfile');
        if (profileSelect) CoreAPI.initCustomSelect(profileSelect);
    }
    loadSettingsIntoUI();
    clearResults();
    modal.classList.add('visible');
    if (!matchMedia('(pointer: coarse)').matches) document.getElementById('recommenderPrompt')?.focus();
    loadProfiles();
}

function closeModal() {
    if (recommenderHasActiveWork()) {
        const message = isGenerating
            ? 'A recommendation is currently generating. Close and abort it?'
            : 'Closing will discard the current results and reroll history.';
        CoreAPI.showConfirm({
            title: 'Close the Recommender?',
            message,
            confirmLabel: 'Close',
            cancelLabel: 'Keep Open',
            danger: true,
        }).then(confirmed => {
            if (confirmed) forceCloseModal();
        });
        return;
    }
    forceCloseModal();
}

function forceCloseModal() {
    abortController?.abort();
    document.getElementById('recommenderModal')?.classList.remove('visible');
    _lastPrompt = '';
    _excludedAvatars = new Set();
}

function recommenderHasActiveWork() {
    if (isGenerating) return true;
    const resultsEl = document.getElementById('recommenderResults');
    if (resultsEl && !resultsEl.classList.contains('hidden') && resultsEl.children.length) return true;
    return false;
}

function loadSettingsIntoUI() {
    const sampleEl = document.getElementById('recommenderSampleSize');
    const tempEl = document.getElementById('recommenderTemperature');
    const maxEl = document.getElementById('recommenderMaxResults');

    if (sampleEl) {
        const total = CoreAPI.getAllCharacters().length;
        sampleEl.max = Math.max(total, 10);
        const size = Math.min(getOpt('sampleSize'), total);
        sampleEl.value = size;
        updateSampleSizeLabel(size, total);
    }
    if (tempEl) {
        tempEl.value = getOpt('temperature');
        document.getElementById('recommenderTemperatureValue').textContent = getOpt('temperature');
    }
    if (maxEl) {
        maxEl.value = getOpt('maxResults');
        document.getElementById('recommenderMaxResultsValue').textContent = getOpt('maxResults');
    }

    document.getElementById('recommenderIncludeTags').checked = getOpt('includeTags');
    document.getElementById('recommenderIncludeCreatorNotes').checked = getOpt('includeCreatorNotes');
    document.getElementById('recommenderIncludeTagline').checked = getOpt('includeTagline');
    document.getElementById('recommenderIncludeCreator').checked = getOpt('includeCreator');
    document.getElementById('recommenderIncludeSource').checked = getOpt('includeSource');
    document.getElementById('recommenderIncludeDescription').checked = getOpt('includeDescription');
    document.getElementById('recommenderBatchMode').checked = getOpt('batchMode');
    const batchCountEl = document.getElementById('recommenderBatchCount');
    if (batchCountEl) {
        batchCountEl.value = getOpt('batchCount');
        document.getElementById('recommenderBatchCountValue').textContent = getOpt('batchCount');
    }
    document.getElementById('recommenderBatchSliderRow')?.classList.toggle('hidden', !getOpt('batchMode'));

    // Tristate filters
    setTristate('recommenderFilterHasChats', getOpt('filterHasChats'));
    setTristate('recommenderFilterFavorite', getOpt('filterFavorite'));

    // Date range
    const dateEnabled = getOpt('filterDateEnabled');
    document.getElementById('recommenderFilterDateEnabled').checked = dateEnabled;
    document.getElementById('recommenderDateRange')?.classList.toggle('hidden', !dateEnabled);
    document.getElementById('recommenderFilterDateFrom').value = getOpt('filterDateFrom');
    document.getElementById('recommenderFilterDateTo').value = getOpt('filterDateTo');

    // Tag pills
    renderTagPills('recommenderTagIncludePills', getOpt('filterTagsInclude'));
    renderTagPills('recommenderTagExcludePills', getOpt('filterTagsExclude'));

    // API mode
    const mode = getOpt('apiMode');
    document.querySelectorAll('.recommender-api-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const isCustom = mode === 'custom';
    document.getElementById('recommenderCustomApiFields')?.classList.toggle('hidden', !isCustom);
    document.getElementById('recommenderStConnection')?.classList.toggle('hidden', isCustom);
    document.getElementById('recommenderCustomConnection')?.classList.toggle('hidden', !isCustom);
    document.getElementById('recommenderTempRow')?.classList.toggle('hidden', !isCustom);
    document.getElementById('recommenderApiUrl').value = getOpt('customApiUrl');
    document.getElementById('recommenderApiKey').value = getOpt('customApiKey');
    document.getElementById('recommenderModel').value = getOpt('customModel');
    if (isCustom) updateCustomConnectionStatus();

    updatePoolCount();
    updateTokenEstimate();
    updateBatchHint();
}

function saveSettingsFromUI() {
    const sampleEl = document.getElementById('recommenderSampleSize');
    const tempEl = document.getElementById('recommenderTemperature');
    const maxEl = document.getElementById('recommenderMaxResults');

    if (sampleEl) setOpt('sampleSize', parseInt(sampleEl.value));
    if (tempEl) setOpt('temperature', parseFloat(tempEl.value));
    if (maxEl) setOpt('maxResults', parseInt(maxEl.value));

    setOpt('includeTags', document.getElementById('recommenderIncludeTags')?.checked ?? true);
    setOpt('includeCreatorNotes', document.getElementById('recommenderIncludeCreatorNotes')?.checked ?? true);
    setOpt('includeTagline', document.getElementById('recommenderIncludeTagline')?.checked ?? true);
    setOpt('includeCreator', document.getElementById('recommenderIncludeCreator')?.checked ?? true);
    setOpt('includeSource', document.getElementById('recommenderIncludeSource')?.checked ?? false);
    setOpt('includeDescription', document.getElementById('recommenderIncludeDescription')?.checked ?? false);
    setOpt('batchMode', document.getElementById('recommenderBatchMode')?.checked ?? false);
    setOpt('batchCount', parseInt(document.getElementById('recommenderBatchCount')?.value) || 3);

    setOpt('filterHasChats', getTristate('recommenderFilterHasChats'));
    setOpt('filterFavorite', getTristate('recommenderFilterFavorite'));
    setOpt('filterDateEnabled', document.getElementById('recommenderFilterDateEnabled')?.checked ?? false);
    setOpt('filterDateFrom', document.getElementById('recommenderFilterDateFrom')?.value || '');
    setOpt('filterDateTo', document.getElementById('recommenderFilterDateTo')?.value || '');
    setOpt('filterTagsInclude', getTagPills('recommenderTagIncludePills'));
    setOpt('filterTagsExclude', getTagPills('recommenderTagExcludePills'));

    const activeMode = document.querySelector('.recommender-api-mode-btn.active')?.dataset.mode || 'sillytavern';
    setOpt('apiMode', activeMode);
    setOpt('customApiUrl', document.getElementById('recommenderApiUrl')?.value?.trim() || '');
    setOpt('customApiKey', document.getElementById('recommenderApiKey')?.value?.trim() || '');
    setOpt('customModel', document.getElementById('recommenderModel')?.value?.trim() || '');
}

function updateSampleSizeLabel(value, total) {
    const label = document.getElementById('recommenderSampleSizeValue');
    if (!label) return;
    const v = parseInt(value);
    const batchMode = document.getElementById('recommenderBatchMode')?.checked;
    if (v >= total) {
        label.textContent = `All (${total})`;
        label.title = '';
    } else if (batchMode) {
        const batchCount = parseInt(document.getElementById('recommenderBatchCount')?.value) || 3;
        const effective = Math.min(v * batchCount, total);
        label.textContent = `${v} ×${batchCount}`;
        label.title = `${effective} characters total across ${batchCount} batches`;
    } else {
        label.textContent = v;
        label.title = '';
    }
}

const TOKEN_ESTIMATES = {
    base: 8,
    includeTags: 15,
    includeCreatorNotes: 100,
    includeTagline: 35,
    includeCreator: 5,
    includeSource: 3,
    includeDescription: 100,
};
const TOKEN_OVERHEAD = 250;

function updateTokenEstimate() {
    const el = document.getElementById('recommenderTokenEstimate');
    if (!el) return;
    const sampleSize = parseInt(document.getElementById('recommenderSampleSize')?.value) || 100;
    const total = CoreAPI.getAllCharacters().length;
    const batchMode = document.getElementById('recommenderBatchMode')?.checked;
    const batchCount = parseInt(document.getElementById('recommenderBatchCount')?.value) || 3;

    let effective;
    if (batchMode) {
        const totalSampled = Math.min(sampleSize * batchCount, total);
        effective = Math.ceil(totalSampled / batchCount);
    } else {
        effective = Math.min(sampleSize, total);
    }

    let perChar = TOKEN_ESTIMATES.base;
    for (const [key, cost] of Object.entries(TOKEN_ESTIMATES)) {
        if (key === 'base') continue;
        if (document.getElementById(`recommender${key.charAt(0).toUpperCase() + key.slice(1)}`)?.checked) {
            perChar += cost;
        }
    }

    const estimate = TOKEN_OVERHEAD + (effective * perChar);
    const formatted = estimate >= 1000 ? `~${(estimate / 1000).toFixed(1)}k` : `~${estimate}`;
    el.textContent = batchMode
        ? `${formatted} tokens/batch × ${batchCount} + reduce`
        : `${formatted} tokens estimated`;
}

function updateBatchHint() {
    const count = parseInt(document.getElementById('recommenderBatchCount')?.value) || 3;
    const hint = document.getElementById('recommenderBatchHint');
    if (hint) hint.textContent = `${count}× coverage`;
}


// ========================================
// EVENT HANDLERS
// ========================================

function attachEvents() {
    const closeBtn = document.getElementById('recommenderCloseBtn');
    const submitBtn = document.getElementById('recommenderSubmitBtn');
    const settingsToggle = document.getElementById('recommenderSettingsToggle');
    const sampleEl = document.getElementById('recommenderSampleSize');
    const tempEl = document.getElementById('recommenderTemperature');
    const maxEl = document.getElementById('recommenderMaxResults');

    closeBtn?.addEventListener('click', closeModal);
    submitBtn?.addEventListener('click', handleSubmit);

    // Settings panel toggle
    settingsToggle?.addEventListener('click', () => {
        const panel = document.getElementById('recommenderSettingsPanel');
        panel?.classList.toggle('hidden');
        settingsToggle.classList.toggle('active', !panel?.classList.contains('hidden'));
    });

    // Sliders
    sampleEl?.addEventListener('input', () => {
        const total = CoreAPI.getAllCharacters().length;
        updateSampleSizeLabel(sampleEl.value, total);
        updateTokenEstimate();
    });
    tempEl?.addEventListener('input', () => {
        document.getElementById('recommenderTemperatureValue').textContent = tempEl.value;
    });
    maxEl?.addEventListener('input', () => {
        document.getElementById('recommenderMaxResultsValue').textContent = maxEl.value;
    });

    // LLM context checkboxes → update token estimate
    for (const id of ['recommenderIncludeTags', 'recommenderIncludeCreatorNotes', 'recommenderIncludeTagline', 'recommenderIncludeCreator', 'recommenderIncludeSource', 'recommenderIncludeDescription']) {
        document.getElementById(id)?.addEventListener('change', updateTokenEstimate);
    }

    // Batch mode toggle
    document.getElementById('recommenderBatchMode')?.addEventListener('change', () => {
        const on = document.getElementById('recommenderBatchMode')?.checked;
        document.getElementById('recommenderBatchSliderRow')?.classList.toggle('hidden', !on);
        const total = CoreAPI.getAllCharacters().length;
        updateSampleSizeLabel(document.getElementById('recommenderSampleSize')?.value, total);
        updateTokenEstimate();
        updateBatchHint();
    });

    // Batch count slider
    document.getElementById('recommenderBatchCount')?.addEventListener('input', () => {
        const count = document.getElementById('recommenderBatchCount')?.value;
        document.getElementById('recommenderBatchCountValue').textContent = count;
        updateBatchHint();
        const total = CoreAPI.getAllCharacters().length;
        updateSampleSizeLabel(document.getElementById('recommenderSampleSize')?.value, total);
        updateTokenEstimate();
    });

    // Tristate filter buttons
    for (const groupId of ['recommenderFilterHasChats', 'recommenderFilterFavorite']) {
        const group = document.getElementById(groupId);
        group?.addEventListener('click', (e) => {
            const btn = e.target.closest('.recommender-tristate-btn');
            if (!btn) return;
            group.querySelectorAll('.recommender-tristate-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePoolCount();
        });
    }

    // Date range toggle
    document.getElementById('recommenderFilterDateEnabled')?.addEventListener('change', (e) => {
        document.getElementById('recommenderDateRange')?.classList.toggle('hidden', !e.target.checked);
        updatePoolCount();
    });
    document.getElementById('recommenderFilterDateFrom')?.addEventListener('change', updatePoolCount);
    document.getElementById('recommenderFilterDateTo')?.addEventListener('change', updatePoolCount);

    // Tag include/exclude inputs
    setupTagInput('recommenderTagIncludeInput', 'recommenderTagIncludePills', 'recommenderTagIncludeAC');
    setupTagInput('recommenderTagExcludeInput', 'recommenderTagExcludePills', 'recommenderTagExcludeAC');

    // API mode toggle
    document.querySelectorAll('.recommender-api-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.recommender-api-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const isCustom = btn.dataset.mode === 'custom';
            document.getElementById('recommenderCustomApiFields')?.classList.toggle('hidden', !isCustom);
            document.getElementById('recommenderStConnection')?.classList.toggle('hidden', isCustom);
            document.getElementById('recommenderCustomConnection')?.classList.toggle('hidden', !isCustom);
            document.getElementById('recommenderTempRow')?.classList.toggle('hidden', !isCustom);
            if (isCustom) updateCustomConnectionStatus();
            else loadProfiles();
        });
    });

    // Custom API fields → update connection status on input
    for (const id of ['recommenderApiUrl', 'recommenderApiKey', 'recommenderModel']) {
        document.getElementById(id)?.addEventListener('input', updateCustomConnectionStatus);
    }

    // Profile selector
    document.getElementById('recommenderStProfile')?.addEventListener('change', (e) => {
        setOpt('stProfileId', e.target.value);
        updateProfileStatus();
    });

    // Close on backdrop click
    document.getElementById('recommenderModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'recommenderModal') closeModal();
    });

    window.registerOverlay?.({
        id: 'recommenderModal',
        tier: 5,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });

    // Character chat ("ask about this character"): sits above the recommender, closes first
    window.registerOverlay?.({
        id: 'recommenderCharChatModal',
        tier: 4,
        close: () => closeCharChat(),
        visible: (el) => el.classList.contains('visible'),
    });
    document.getElementById('recommenderChatCloseBtn')?.addEventListener('click', () => closeCharChat());
    document.getElementById('recommenderCharChatModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'recommenderCharChatModal') closeCharChat();
    });
    document.getElementById('recommenderChatSendBtn')?.addEventListener('click', () => sendChatMessage());
    document.getElementById('recommenderChatCancelBtn')?.addEventListener('click', () => { if (chatAbortController) chatAbortController.abort(); });
    document.getElementById('recommenderChatInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    document.getElementById('recommenderChatSettingsToggle')?.addEventListener('click', () => toggleChatSettings());
    document.getElementById('recommenderChatSystemPrompt')?.addEventListener('input', (e) => persistChatActive(e.target.value));
    document.getElementById('recommenderChatPresetSelect')?.addEventListener('change', (e) => loadChatPreset(e.target.value));
    document.getElementById('recommenderChatPresetSave')?.addEventListener('click', () => saveChatPreset());
    document.getElementById('recommenderChatPresetDelete')?.addEventListener('click', () => deleteChatPreset());
    document.getElementById('recommenderChatPresetReset')?.addEventListener('click', () => resetChatPrompt());
    buildChatPresetSelect();
    CoreAPI.initCustomSelect?.(document.getElementById('recommenderChatPresetSelect'));

    // Enter key to submit
    document.getElementById('recommenderPrompt')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    });

    // Result card clicks - name link opens modal, card click is passive
    document.getElementById('recommenderResults')?.addEventListener('click', (e) => {
        const plBtn = e.target.closest('.recommender-playlist-btn');
        if (plBtn) {
            e.preventDefault();
            e.stopPropagation();
            const card = plBtn.closest('.recommender-result-card');
            const avatar = card?.dataset.avatar;
            if (avatar) CoreAPI.openPlaylistPicker([avatar]);
            return;
        }

        const chatBtn = e.target.closest('.recommender-chat-btn');
        if (chatBtn) {
            e.preventDefault();
            e.stopPropagation();
            const avatar = chatBtn.closest('.recommender-result-card')?.dataset.avatar;
            if (avatar) openCharChat(avatar);
            return;
        }

        const addAllBtn = e.target.closest('.recommender-playlist-all-btn');
        if (addAllBtn) {
            e.preventDefault();
            e.stopPropagation();
            const avatars = [...document.querySelectorAll('.recommender-result-card[data-avatar]')]
                .map(c => c.dataset.avatar).filter(Boolean);
            if (avatars.length) CoreAPI.openPlaylistPicker(avatars);
            return;
        }

        const rerollBtn = e.target.closest('#recommenderRerollBtn');
        if (rerollBtn) {
            e.preventDefault();
            e.stopPropagation();
            handleReroll();
            return;
        }

        const reason = e.target.closest('.recommender-result-reason');
        if (reason) {
            reason.classList.toggle('expanded');
            return;
        }

        const nameLink = e.target.closest('.recommender-result-name-link');
        if (nameLink) {
            e.preventDefault();
            e.stopPropagation();
            const card = nameLink.closest('.recommender-result-card');
            const avatar = card?.dataset.avatar;
            if (!avatar) return;
            const char = CoreAPI.getCharacterByAvatar(avatar);
            if (!char) return;
            // Page prev/next through the result set (DOM order = display order), not the grid behind us.
            const navList = [...document.querySelectorAll('.recommender-result-card[data-avatar]')]
                .map(c => CoreAPI.getCharacterByAvatar(c.dataset.avatar))
                .filter(Boolean);
            CoreAPI.openCharModalElevated(char, navList);
            return;
        }
    });
}


// ========================================
// TRISTATE & TAG PILL HELPERS
// ========================================

function setTristate(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.recommender-tristate-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
}

function getTristate(groupId) {
    return document.querySelector(`#${groupId} .recommender-tristate-btn.active`)?.dataset.value || 'any';
}

function renderTagPills(containerId, tags) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const arr = Array.isArray(tags) ? tags : [];
    container.innerHTML = arr.map(t =>
        `<span class="recommender-pill" data-tag="${CoreAPI.escapeHtml(t)}">${CoreAPI.escapeHtml(t)} <i class="fa-solid fa-xmark"></i></span>`
    ).join('');
}

function getTagPills(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return [...container.querySelectorAll('.recommender-pill')].map(el => el.dataset.tag);
}

function setupTagInput(inputId, pillsId, acId) {
    const input = document.getElementById(inputId);
    const acEl = document.getElementById(acId);
    if (!input) return;

    let highlightIdx = -1;

    function addTagFromInput(tag) {
        const t = (tag || input.value).trim().toLowerCase();
        if (!t) return;
        const existing = getTagPills(pillsId);
        if (!existing.includes(t)) {
            existing.push(t);
            renderTagPills(pillsId, existing);
            updatePoolCount();
        }
        input.value = '';
        hideAC();
    }

    function showAC() {
        if (!acEl) return;
        const filter = input.value.trim().toLowerCase();
        const existing = getTagPills(pillsId).map(t => t.toLowerCase());
        const allTags = CoreAPI.getAllTags();
        const matches = allTags.filter(t => {
            const lo = t.toLowerCase();
            return (!filter || lo.includes(filter)) && !existing.includes(lo);
        }).slice(0, 8);

        if (!matches.length) { hideAC(); return; }
        highlightIdx = -1;
        acEl.innerHTML = matches.map(t =>
            `<div class="recommender-tag-ac-item" data-tag="${CoreAPI.escapeHtml(t)}">${CoreAPI.escapeHtml(t)}</div>`
        ).join('');
        acEl.classList.add('visible');
    }

    function hideAC() {
        if (!acEl) return;
        acEl.classList.remove('visible');
        highlightIdx = -1;
    }

    function setHighlight(idx) {
        const items = acEl?.querySelectorAll('.recommender-tag-ac-item') || [];
        items.forEach((el, i) => el.classList.toggle('highlighted', i === idx));
        highlightIdx = idx;
    }

    input.addEventListener('input', showAC);
    input.addEventListener('focus', showAC);

    input.addEventListener('keydown', (e) => {
        const items = acEl?.querySelectorAll('.recommender-tag-ac-item') || [];
        if (e.key === 'ArrowDown' && acEl?.classList.contains('visible') && items.length) {
            e.preventDefault();
            setHighlight(highlightIdx < items.length - 1 ? highlightIdx + 1 : 0);
            return;
        }
        if (e.key === 'ArrowUp' && acEl?.classList.contains('visible') && items.length) {
            e.preventDefault();
            setHighlight(highlightIdx > 0 ? highlightIdx - 1 : items.length - 1);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightIdx >= 0 && items[highlightIdx]) {
                addTagFromInput(items[highlightIdx].dataset.tag);
            } else {
                addTagFromInput();
            }
            return;
        }
        if (e.key === 'Escape') {
            hideAC();
        }
    });

    input.addEventListener('blur', () => setTimeout(hideAC, 150));

    acEl?.addEventListener('click', (e) => {
        const item = e.target.closest('.recommender-tag-ac-item');
        if (item) addTagFromInput(item.dataset.tag);
    });

    document.getElementById(pillsId)?.addEventListener('click', (e) => {
        const pill = e.target.closest('.recommender-pill');
        if (!pill) return;
        pill.remove();
        updatePoolCount();
    });
}


// ========================================
// POOL FILTERING
// ========================================

function getFilteredPool() {
    const allChars = CoreAPI.getAllCharacters();
    const hasChats = getTristate('recommenderFilterHasChats');
    const favorite = getTristate('recommenderFilterFavorite');
    const dateEnabled = document.getElementById('recommenderFilterDateEnabled')?.checked;
    const dateFrom = dateEnabled ? document.getElementById('recommenderFilterDateFrom')?.value : '';
    const dateTo = dateEnabled ? document.getElementById('recommenderFilterDateTo')?.value : '';
    const tagsInclude = getTagPills('recommenderTagIncludePills');
    const tagsExclude = getTagPills('recommenderTagExcludePills');

    const dateFromTs = dateFrom ? new Date(dateFrom).getTime() : 0;
    const dateToTs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : Infinity;

    return allChars.filter(c => {
        if (hasChats === 'yes' && !c.date_last_chat) return false;
        if (hasChats === 'no' && c.date_last_chat) return false;

        const isFav = c.fav || c.data?.fav;
        if (favorite === 'yes' && !isFav) return false;
        if (favorite === 'no' && isFav) return false;

        if (dateEnabled && (dateFrom || dateTo)) {
            const created = c._createDate || 0;
            if (created < dateFromTs || created > dateToTs) return false;
        }

        if (tagsInclude.length) {
            const charTags = c._tagsLower || '';
            if (!tagsInclude.every(t => charTags.includes(t))) return false;
        }

        if (tagsExclude.length) {
            const charTags = c._tagsLower || '';
            if (tagsExclude.some(t => charTags.includes(t))) return false;
        }

        return true;
    });
}

function updatePoolCount() {
    const el = document.getElementById('recommenderPoolCount');
    if (!el) return;
    const total = CoreAPI.getAllCharacters().length;
    const filtered = getFilteredPool().length;
    if (filtered === total) {
        el.textContent = `${total} characters in pool`;
        el.className = 'recommender-pool-count';
    } else {
        el.textContent = `${filtered} of ${total} characters match filters`;
        el.className = 'recommender-pool-count recommender-pool-count-filtered';
    }
}

function getProviderSource(char) {
    const ext = char.data?.extensions;
    if (!ext) return '';
    for (const [key, label] of PROVIDER_SOURCE_MAP) {
        if (ext[key]) return label;
    }
    return '';
}

const PROVIDER_SOURCE_MAP = [
    ['chub', 'ChubAI'],
    ['chartavern', 'CharacterTavern'],
    ['jannyai', 'JanitorAI'],
    ['pygmalion', 'Pygmalion'],
    ['wyvern', 'Wyvern'],
    ['datacat', 'DataCat'],
    ['botbooru', 'Botbooru'],
];


// ========================================
// CHARACTER SAMPLING & PROMPT BUILDING
// ========================================

function sampleCharacters(allChars, sampleSize) {
    if (sampleSize >= allChars.length) return [...allChars];
    const shuffled = [...allChars];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, sampleSize);
}

// description is a slim-stripped heavy field, so it has to be hydrated before the prompt build.
// Chunked to avoid a fetch stampede on large samples; only ever called when the Description toggle is on.
async function hydrateForDescriptions(chars, signal) {
    const slim = chars.filter(c => c?._slim);
    if (!slim.length) return;
    const CHUNK = 40;
    for (let i = 0; i < slim.length; i += CHUNK) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const upto = Math.min(i + CHUNK, slim.length);
        showStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Loading descriptions ${upto}/${slim.length}...`, 'info');
        await Promise.all(slim.slice(i, upto).map(c => CoreAPI.hydrateCharacter(c)));
    }
}

async function buildCharacterListAsync(chars, opts, signal, onProgress) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const lines = [];
    const total = chars.length;
    let chunkStart = performance.now();

    for (let i = 0; i < total; i++) {
        const c = chars[i];
        const parts = [`#${i + 1} "${(CoreAPI.getCharacterName(c) || 'Unknown')}"`];

        if (opts.includeTags) {
            const tags = CoreAPI.getCharacterTags(c);
            if (tags.length) parts.push(`[tags: ${tags.join(', ')}]`);
        }
        if (opts.includeCreator && c.data?.creator) {
            parts.push(`[creator: ${c.data.creator}]`);
        }
        if (opts.includeCreatorNotes && c.data?.creator_notes) {
            const notes = cleanTextForLLM(c.data.creator_notes).slice(0, 400);
            if (notes) parts.push(`[creator notes: ${notes}]`);
        }
        if (opts.includeTagline) {
            const tagline = getProviderTagline(c);
            if (tagline) parts.push(`[tagline: ${tagline}]`);
        }
        if (opts.includeDescription && c.data?.description) {
            const desc = cleanTextForLLM(c.data.description).slice(0, 400);
            if (desc) parts.push(`[description: ${desc}]`);
        }
        if (opts.includeSource) {
            const source = getProviderSource(c);
            if (source) parts.push(`[source: ${source}]`);
        }
        lines.push(parts.join(' '));

        const done = i + 1;
        // Time-budget over fixed-item chunks: per-char cost varies widely (heavy HTML notes hit 15-20ms each).
        if (done < total && performance.now() - chunkStart >= YIELD_BUDGET_MS) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (onProgress) onProgress(done, total);
            await yieldToBrowser();
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            chunkStart = performance.now();
        }
    }

    if (onProgress) onProgress(total, total);
    return lines.join('\n');
}

function stripHtml(html) {
    if (!html) return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.textContent || '';
}

const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2300}-\u{23FF}\u{2B50}\u{2764}\u{2934}-\u{2935}\u{25AA}-\u{25FE}\u{2190}-\u{21FF}\u{2702}-\u{27B0}\u{FE0F}]/gu;

const URL_RE = /https?:\/\/[^\s)\]>"']+/gi;

const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;

function stripCssFromText(text) {
    text = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
    let prev;
    do {
        prev = text;
        text = text.replace(/[^{}\n]{0,500}\{([^{}]*)\}/g, (match, inner) => {
            if (!inner.trim()) return ' ';
            if (/[\w-]+\s*:\s*[^;}]+[;}]/i.test(inner)) return ' ';
            return match;
        });
    } while (text !== prev);
    text = text.replace(/@(?:keyframes|import|font-face|media|supports|charset)\b[^;{}]*/gi, ' ');
    return text;
}

function cleanTextForLLM(raw) {
    if (!raw) return '';
    let text = stripHtml(raw);
    text = stripCssFromText(text);
    text = text.replace(MARKDOWN_LINK_RE, '$1');
    text = text.replace(URL_RE, '');
    text = text.replace(EMOJI_RE, '');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
}

// orphan halves bonk Python-strict encoders downstream (LiteLLM, ai-horde, etc).
function stripOrphanSurrogates(str) {
    if (!str) return str;
    return str
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function getProviderTagline(char) {
    const tagline = CoreAPI.getDisplayTagline(char);
    if (!tagline) return '';
    return cleanTextForLLM(tagline).slice(0, 400);
}


// ========================================
// API CALLS
// ========================================

async function loadProfiles() {
    const dot = document.querySelector('#recommenderStConnection .recommender-connection-dot');
    const text = document.getElementById('recommenderStConnectionText');
    const container = document.getElementById('recommenderStConnection');
    const selectEl = document.getElementById('recommenderStProfile');
    const submitBtn = document.getElementById('recommenderSubmitBtn');
    if (!dot || !text || !container || !selectEl) return;

    const mode = document.querySelector('.recommender-api-mode-btn.active')?.dataset.mode;
    container.classList.toggle('hidden', mode !== 'sillytavern');
    if (mode !== 'sillytavern') return;

    if (submitBtn) submitBtn.disabled = true;
    dot.className = 'recommender-connection-dot checking';
    text.textContent = 'Loading profiles...';
    const selectContainer = selectEl._customSelect?.container;
    if (selectContainer) selectContainer.classList.add('hidden');
    else selectEl.classList.add('hidden');

    try {
        const s = await CoreAPI.getLlmSettings();
        if (s.error) throw new Error('Could not fetch settings');

        activeSource = s.activeSource;
        activeModel = s.activeModel;
        activePreset = s.activePreset;
        const ccProfiles = s.profiles;

        if (!s.hasProfiles) {
            dot.className = 'recommender-connection-dot connected';
            text.textContent = activeSource
                ? `${activeSource}${activeModel ? ' — ' + activeModel : ''}`
                : 'No Connection Profiles found — create one in SillyTavern';
            if (!activeSource) dot.className = 'recommender-connection-dot neutral';
            loadedProfiles = [];
            return;
        }

        if (!ccProfiles.length) {
            dot.className = 'recommender-connection-dot connected';
            text.textContent = activeSource
                ? `${activeSource}${activeModel ? ' — ' + activeModel : ''}`
                : 'No Chat Completion profiles found';
            if (!activeSource) dot.className = 'recommender-connection-dot neutral';
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
        } else if (s.selectedProfileId && ccProfiles.some(p => p.id === s.selectedProfileId)) {
            selectEl.value = s.selectedProfileId;
        } else {
            selectEl.value = ccProfiles[0].id;
        }
        setOpt('stProfileId', selectEl.value);

        selectEl._customSelect?.refresh();
        if (selectContainer) selectContainer.classList.remove('hidden');
        else selectEl.classList.remove('hidden');
        updateProfileStatus();
    } catch (err) {
        console.error('[Recommender] Failed to load profiles:', err);
        dot.className = 'recommender-connection-dot disconnected';
        text.textContent = 'Could not reach SillyTavern server';
        loadedProfiles = [];
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

function getSelectedProfile() {
    const selectEl = document.getElementById('recommenderStProfile');
    const id = selectEl?.value || getOpt('stProfileId');
    return loadedProfiles.find(p => p.id === id) || null;
}

function getConnectionLabel(profile) {
    return profile?.model || activeModel || profile?.api || activeSource || '';
}

function updateProfileStatus() {
    const dot = document.querySelector('#recommenderStConnection .recommender-connection-dot');
    const text = document.getElementById('recommenderStConnectionText');
    if (!dot || !text) return;

    const profile = getSelectedProfile();
    const source = profile?.api || activeSource;
    const label = getConnectionLabel(profile);

    if (!source) {
        dot.className = 'recommender-connection-dot neutral';
        text.textContent = 'No active Chat Completion source detected';
        return;
    }

    dot.className = 'recommender-connection-dot connected';
    text.textContent = label || 'Model not detected';
}

function updateCustomConnectionStatus() {
    const dot = document.querySelector('#recommenderCustomConnection .recommender-connection-dot');
    const text = document.getElementById('recommenderCustomConnectionText');
    if (!dot || !text) return;

    const url = document.getElementById('recommenderApiUrl')?.value?.trim();
    const model = document.getElementById('recommenderModel')?.value?.trim();

    if (!url) {
        dot.className = 'recommender-connection-dot neutral';
        text.textContent = 'Not configured';
        return;
    }

    dot.className = 'recommender-connection-dot connected';
    text.textContent = model || 'Custom API';
}

// Delegates to the shared client. onRaw feeds the debug panel's last-raw-response capture.
function callSillyTavernAPI(messages, temperature, signal) {
    return CoreAPI.callLLM(messages, {
        profile: getSelectedProfile(),
        activeSource, activeModel, activePreset,
        temperature, maxTokens: 4000, signal,
        onRaw: t => { _lastRawApiResponse = t; },
        debugTag: 'Recommender',
        extraUnreachableHint: 'Or switch to Custom API mode in the recommender settings.',
    });
}

// Custom API mode delegates to the shared client (which appends /chat/completions + parses).
function callCustomAPI(messages, temperature, signal) {
    return CoreAPI.callCustomLLM(messages, {
        url: getOpt('customApiUrl'), apiKey: getOpt('customApiKey'), model: getOpt('customModel'),
        temperature, maxTokens: 2000, signal,
        onRaw: t => { _lastRawApiResponse = t; },
        debugTag: 'Recommender',
    });
}

// Single dispatch for both API modes; reused by generate, the batch-reduce step, and the character chat.
async function callForMode(messages, temperature, signal) {
    const mode = getOpt('apiMode');
    if (mode === 'custom') return await callCustomAPI(messages, temperature, signal);
    return await callSillyTavernAPI(messages, temperature, signal);
}

async function generate(userPrompt, chars, opts, signal, onProgress) {
    const charList = await buildCharacterListAsync(chars, opts, signal, onProgress);
    // Yield once so the final progress tick paints before the surrogate scan and the fetch fire off.
    await yieldToBrowser();
    const userMessage = stripOrphanSurrogates(
        `CHARACTER LIBRARY (${chars.length} characters):\n${charList}\n\nUSER REQUEST: ${userPrompt}\n\nRecommend up to ${opts.maxResults} characters. Respond with a JSON array only.`
    );
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
    ];

    const mode = getOpt('apiMode');
    const profile = getSelectedProfile();

    CoreAPI.debugLog('[Recommender] Generate:', {
        mode, chars: chars.length, sampleSize: opts.sampleSize,
        temperature: opts.temperature, maxResults: opts.maxResults,
        fields: { tags: opts.includeTags, creator: opts.includeCreator, creatorNotes: opts.includeCreatorNotes, tagline: opts.includeTagline, description: opts.includeDescription, source: opts.includeSource },
        systemPromptLength: SYSTEM_PROMPT.length, userMsgLength: messages[1].content.length,
    });
    CoreAPI.debugLog('[Recommender] User message:', messages[1].content);
    lastDebugContext = {
        timestamp: new Date().toISOString(),
        apiMode: mode,
        source: mode === 'custom' ? 'custom' : (profile?.api || activeSource || '(none)'),
        model: mode === 'custom' ? (getOpt('customModel') || '(none)') : (profile?.model || activeModel || '(none)'),
        profileName: profile?.name || null,
        sampleSize: opts.sampleSize,
        sampledCount: chars.length,
        poolSize: opts.poolSize ?? chars.length,
        totalChars: CoreAPI.getAllCharacters().length,
        temperature: opts.temperature,
        maxResults: opts.maxResults,
        contextFields: { tags: opts.includeTags, creator: opts.includeCreator, creatorNotes: opts.includeCreatorNotes, tagline: opts.includeTagline, description: opts.includeDescription, source: opts.includeSource },
        filters: { hasChats: getOpt('filterHasChats'), favorite: getOpt('filterFavorite'), dateEnabled: getOpt('filterDateEnabled'), dateFrom: getOpt('filterDateFrom'), dateTo: getOpt('filterDateTo'), tagsInclude: getOpt('filterTagsInclude'), tagsExclude: getOpt('filterTagsExclude') },
        userPrompt,
        messages,
        rawResponse: null,
        error: null,
    };

    try {
        const rawContent = await callForMode(messages, opts.temperature, signal);
        lastDebugContext.rawResponse = rawContent;
        CoreAPI.debugLog('[Recommender] Raw response:', rawContent);
        if (!rawContent?.trim()) {
            throw new Error('Model returned empty response — it may be overloaded or the request too large. Try again.');
        }
        return rawContent;
    } catch (err) {
        if (_lastRawApiResponse && !lastDebugContext.rawResponse) {
            lastDebugContext.rawResponse = _lastRawApiResponse;
        }
        lastDebugContext.error = err.message;
        CoreAPI.debugLog('[Recommender] Generation error:', err.message);
        throw err;
    }
}


// ========================================
// BATCH MODE (MAP-REDUCE)
// ========================================

async function generateReduce(userPrompt, finalists, opts, signal) {
    const entries = finalists.map((f, i) => {
        const c = f.char;
        const parts = [`#${i + 1} "${CoreAPI.getCharacterName(c) || 'Unknown'}"`];
        const tags = CoreAPI.getCharacterTags(c);
        if (tags.length) parts.push(`[tags: ${tags.slice(0, 8).join(', ')}]`);
        if (c.data?.creator) parts.push(`[creator: ${c.data.creator}]`);
        if (f.reason) parts.push(`[initial pick reason: ${f.reason}]`);
        return parts.join(' ');
    });

    const messages = [
        { role: 'system', content: REDUCE_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `CANDIDATE CHARACTERS (${finalists.length} pre-selected from ${getOpt('batchCount')} evaluation batches):\n${entries.join('\n')}\n\nUSER REQUEST: ${userPrompt}\n\nPick the best ${opts.maxResults} matches. Respond with a JSON array only.`
        },
    ];

    return await callForMode(messages, opts.temperature, signal);
}

// ========================================
// CHARACTER CHAT ("ask about this character")
// ========================================

function charChatModalHtml() {
    return `
    <div class="cl-modal recommender-chat-modal" id="recommenderCharChatModal">
        <div class="cl-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-comment-dots"></i> <span id="recommenderChatTitle">Ask about character</span></h3>
                <div class="recommender-chat-header-actions">
                    <button class="recommender-chat-gear" id="recommenderChatSettingsToggle" title="Chat settings"><i class="fa-solid fa-sliders"></i></button>
                    <button class="cl-modal-close" id="recommenderChatCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="recommender-chat-settings hidden" id="recommenderChatSettings">
                <div class="recommender-chat-settings-section">
                    <div class="recommender-chat-settings-head">
                        <label class="recommender-chat-settings-label">System prompt</label>
                        <div class="recommender-chat-preset-row">
                            <select id="recommenderChatPresetSelect" class="cl-select-fluid"></select>
                            <button class="recommender-chat-icon-btn" id="recommenderChatPresetSave" title="Save current as a preset"><i class="fa-solid fa-floppy-disk"></i></button>
                            <button class="recommender-chat-icon-btn" id="recommenderChatPresetDelete" title="Delete the selected preset"><i class="fa-solid fa-trash-can"></i></button>
                            <button class="recommender-chat-icon-btn" id="recommenderChatPresetReset" title="Reset to the default prompt"><i class="fa-solid fa-rotate-left"></i></button>
                        </div>
                    </div>
                    <textarea id="recommenderChatSystemPrompt" class="glass-input recommender-chat-prompt-editor" rows="6" placeholder="System prompt the assistant follows. The card data is added automatically."></textarea>
                </div>
                <div class="recommender-chat-settings-section recommender-chat-lorebook-section hidden" id="recommenderChatLorebookSection">
                    <label class="recommender-toggle-chip">
                        <input type="checkbox" id="recommenderChatIncludeLorebook">
                        <span><i class="fa-solid fa-book"></i> Include lorebook</span>
                    </label>
                    <span class="recommender-chat-lorebook-size" id="recommenderChatLorebookSize"></span>
                </div>
            </div>
            <div class="cl-modal-body recommender-chat-body">
                <div class="recommender-chat-messages" id="recommenderChatMessages"></div>
                <div class="recommender-chat-empty" id="recommenderChatEmpty">
                    <i class="fa-solid fa-comments"></i>
                    <p id="recommenderChatEmptyTitle">Ask anything about this character</p>
                    <ul>
                        <li>What themes and tone does this card explore?</li>
                        <li>Would they work for a slow-burn romance?</li>
                        <li>Summarize their personality and backstory.</li>
                    </ul>
                </div>
            </div>
            <div class="cl-modal-footer recommender-chat-footer">
                <textarea id="recommenderChatInput" class="glass-input recommender-chat-input" placeholder="Ask about this character (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
                <div class="recommender-chat-footer-actions">
                    <button class="cl-btn cl-btn-danger cl-hidden" id="recommenderChatCancelBtn"><i class="fa-solid fa-stop"></i> Stop</button>
                    <button class="cl-btn cl-btn-primary" id="recommenderChatSendBtn"><i class="fa-solid fa-paper-plane"></i> Send</button>
                </div>
            </div>
        </div>
    </div>`;
}

// Prompt content lives in a Files-API JSON (never in settings), matching _cl_playlists.json etc.
// Load/save mirror the canonical playlists pattern: cache + in-flight dedupe, write serialization, resp.ok check.
const CHAT_PROMPTS_FILE = '_cl_chat_prompts.json';
let _chatPrompts = null; // { active: string, presets: [{name, prompt}] }
let _chatPromptsLoaded = false;
let _chatPromptsLoadingPromise = null;
let _chatPromptsSaving = false;
let _chatPromptsSaveQueued = false;
let _chatActiveSaveTimer = null;

async function loadChatPrompts() {
    if (_chatPromptsLoaded) return _chatPrompts;
    if (_chatPromptsLoadingPromise) return _chatPromptsLoadingPromise;
    _chatPromptsLoadingPromise = (async () => {
        let data = null;
        try {
            const resp = await fetch(`/user/files/${CHAT_PROMPTS_FILE}`);
            if (resp.ok) {
                const text = await resp.text();
                if (text && text.trim()) data = JSON.parse(text);
            }
        } catch { /* missing or invalid file is fine */ }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            // pre-envelope files carry no version key; accept them and upgrade on next save
            if (data.version !== undefined && data.version !== 1) data = null;
        } else {
            data = null;
        }
        _chatPrompts = data || {};
        delete _chatPrompts.version;
        if (!Array.isArray(_chatPrompts.presets)) _chatPrompts.presets = [];
        if (typeof _chatPrompts.active !== 'string') _chatPrompts.active = '';
        _chatPromptsLoaded = true;
        _chatPromptsLoadingPromise = null;
        return _chatPrompts;
    })();
    return _chatPromptsLoadingPromise;
}

async function saveChatPrompts() {
    if (!_chatPrompts) return false;
    if (_chatPromptsSaving) { _chatPromptsSaveQueued = true; return false; }
    _chatPromptsSaving = true;
    let ok = false;
    try {
        const resp = await CoreAPI.apiRequest('/files/upload', 'POST', {
            name: CHAT_PROMPTS_FILE,
            data: CoreAPI.utf8ToBase64(JSON.stringify({ version: 1, ..._chatPrompts }, null, 2)),
        });
        if (!resp.ok) throw new Error(`upload failed (${resp.status})`);
        ok = true;
    } catch (e) {
        console.error('[Recommender] Failed to save chat prompts:', e.message);
        CoreAPI.showToast('Failed to save chat prompt', 'error');
    } finally {
        _chatPromptsSaving = false;
        if (_chatPromptsSaveQueued) { _chatPromptsSaveQueued = false; saveChatPrompts(); }
    }
    return ok;
}

// Debounced so typing in the editor doesn't spam file writes; discrete actions call saveChatPrompts directly.
function persistChatActive(text) {
    if (!_chatPrompts) return;
    _chatPrompts.active = text;
    clearTimeout(_chatActiveSaveTimer);
    _chatActiveSaveTimer = setTimeout(saveChatPrompts, 1000);
}

function toggleChatSettings() {
    const panel = document.getElementById('recommenderChatSettings');
    if (!panel) return;
    const open = panel.classList.toggle('hidden') === false;
    document.getElementById('recommenderChatSettingsToggle')?.classList.toggle('active', open);
}

function buildChatPresetSelect() {
    const select = document.getElementById('recommenderChatPresetSelect');
    if (!select) return;
    const presets = _chatPrompts?.presets || [];
    let html = `<option value="" disabled selected>Load a prompt...</option>`
        + `<option value="default:rich">Default (Rich styling)</option>`
        + `<option value="default:plain">Default (Plain markdown)</option>`;
    presets.forEach((p, i) => { html += `<option value="saved:${i}">${CoreAPI.escapeHtml(p.name)}</option>`; });
    select.innerHTML = html;
    select._customSelect?.refresh();
}

function loadChatPreset(value) {
    const editor = document.getElementById('recommenderChatSystemPrompt');
    if (!editor || !value) return;
    let prompt = null;
    if (value === 'default:rich') prompt = CHAR_CHAT_DEFAULT_RICH;
    else if (value === 'default:plain') prompt = CHAR_CHAT_DEFAULT_PLAIN;
    else if (value.startsWith('saved:')) prompt = (_chatPrompts?.presets || [])[parseInt(value.slice(6), 10)]?.prompt;
    if (prompt != null) {
        editor.value = prompt;
        persistChatActive(prompt);
    }
}

function resetChatPrompt() {
    const editor = document.getElementById('recommenderChatSystemPrompt');
    if (!editor) return;
    editor.value = CHAR_CHAT_DEFAULT_RICH;
    persistChatActive(CHAR_CHAT_DEFAULT_RICH);
    CoreAPI.showToast('Reset to the default prompt', 'info', 1500);
}

async function saveChatPreset() {
    const prompt = (document.getElementById('recommenderChatSystemPrompt')?.value || '').trim();
    if (!prompt) { CoreAPI.showToast('Write a prompt first', 'warning', 2000); return; }
    await loadChatPrompts();
    const result = await CoreAPI.savePresetPicker('Save prompt preset', _chatPrompts.presets);
    if (!result) return;
    if (result.overwriteIndex >= 0) _chatPrompts.presets[result.overwriteIndex].prompt = prompt;
    else _chatPrompts.presets.push({ name: result.name, prompt });
    await saveChatPrompts();
    buildChatPresetSelect();
    CoreAPI.showToast('Prompt saved', 'success', 1500);
}

async function deleteChatPreset() {
    const value = document.getElementById('recommenderChatPresetSelect')?.value || '';
    if (!value.startsWith('saved:')) { CoreAPI.showToast('Pick a saved preset to delete (defaults cannot be removed)', 'warning', 2500); return; }
    const idx = parseInt(value.slice(6), 10);
    await loadChatPrompts();
    if (idx < 0 || idx >= _chatPrompts.presets.length) return;
    _chatPrompts.presets.splice(idx, 1);
    await saveChatPrompts();
    buildChatPresetSelect();
    CoreAPI.showToast('Preset deleted', 'info', 1500);
}

function computeLorebookInfo(char) {
    const book = char?.data?.character_book || char?.character_book;
    if (!book || !Array.isArray(book.entries) || !book.entries.length) return null;
    return { entries: book.entries.length, chars: JSON.stringify(book).length };
}

// Content fields only; operational extensions (gallery_id, version_uid, provider links, etc.) are deliberately omitted.
function buildChatCardContext(char, includeLorebook) {
    const d = char.data || {};
    const arr = v => (Array.isArray(v) && v.length) ? v : undefined;
    const card = {
        name: d.name || char.name,
        creator: d.creator || undefined,
        character_version: d.character_version || undefined,
        tagline: CoreAPI.getDisplayTagline(char) || undefined,
        tags: arr(d.tags),
        description: d.description || undefined,
        personality: d.personality || undefined,
        scenario: d.scenario || undefined,
        first_mes: d.first_mes || undefined,
        alternate_greetings: arr(d.alternate_greetings),
        mes_example: d.mes_example || undefined,
        creator_notes: d.creator_notes || undefined,
        nickname: d.nickname || undefined,
        group_only_greetings: arr(d.group_only_greetings),
    };
    if (includeLorebook) {
        const book = d.character_book || char.character_book;
        if (book) card.character_book = book;
    }
    return JSON.stringify(card, null, 2);
}

function setChatBusy(busy) {
    chatBusy = busy;
    document.getElementById('recommenderChatSendBtn')?.classList.toggle('cl-hidden', busy);
    document.getElementById('recommenderChatCancelBtn')?.classList.toggle('cl-hidden', !busy);
    const input = document.getElementById('recommenderChatInput');
    if (input) input.disabled = busy;
}

// Drops blank lines before formatRichText (else they become <br><br> = cavernous spacing); safePurify still runs last.
function mdBlocksToHtml(text) {
    const out = [];
    let list = null, para = [];
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const BLOCK_HTML = /^\s*<\/?(h[1-6]|div|p|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|hr|details|summary|section|center|img|style)\b/i;
    for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
        const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        const num = line.match(/^\s*\d+\.\s+(.+)$/);
        if (h) {
            flushPara(); closeList();
            const lvl = Math.min(h[1].length, 6);
            out.push(`<h${lvl}>${h[2]}</h${lvl}>`);
        } else if (bullet) {
            flushPara();
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push(`<li>${bullet[1]}</li>`);
        } else if (num) {
            flushPara();
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push(`<li>${num[1]}</li>`);
        } else if (BLOCK_HTML.test(line)) {
            flushPara(); closeList();
            out.push(line);
        } else if (!line.trim()) {
            flushPara(); closeList();
        } else {
            closeList();
            para.push(line);
        }
    }
    flushPara(); closeList();
    return out.join('\n');
}

// Post-render contrast guard: the LLM's inline styles often assume a light page, so they can set text or block
// colors that are unreadable on the dark chat surface. Detect and repair the low-contrast cases without prompting.
const CHAT_SURFACE_RGB = [30, 30, 30]; // --bg-secondary #1e1e1e
const _colorCache = new Map();

function parseColor(str) {
    if (!str || /gradient|url\(|var\(/i.test(str)) return null;
    if (_colorCache.has(str)) return _colorCache.get(str);
    let rgb = null;
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = str;
    if (probe.style.color) {
        document.body.appendChild(probe);
        const m = getComputedStyle(probe).color.match(/(\d+),\s*(\d+),\s*(\d+)/);
        document.body.removeChild(probe);
        if (m) rgb = [+m[1], +m[2], +m[3]];
    }
    _colorCache.set(str, rgb);
    return rgb;
}

function _lum([r, g, b]) {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function _contrast(a, b) {
    const la = _lum(a), lb = _lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function _readableOn(bg) { return _lum(bg) > 0.45 ? '#15151f' : '#f2f2f5'; }
function _effectiveBg(el) {
    for (let cur = el; cur && cur.style; cur = cur.parentElement) {
        const bg = parseColor(cur.style.backgroundColor || cur.style.background);
        if (bg) return bg;
    }
    return CHAT_SURFACE_RGB;
}

function fixChatContrast(html) {
    if (!html || html.indexOf('style=') === -1) return html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('[style]').forEach(el => {
        const ownBg = parseColor(el.style.backgroundColor || el.style.background);
        if (ownBg) {
            const fg = parseColor(el.style.color);
            if (!fg || _contrast(fg, ownBg) < 3.5) el.style.color = _readableOn(ownBg);
        }
        const fg = parseColor(el.style.color);
        if (fg) {
            const bg = _effectiveBg(el);
            if (_contrast(fg, bg) < 3.5) el.style.color = _readableOn(bg);
        }
    });
    return tmp.innerHTML;
}

function renderChatMessages() {
    const el = document.getElementById('recommenderChatMessages');
    const emptyEl = document.getElementById('recommenderChatEmpty');
    if (!el) return;
    if (emptyEl) emptyEl.hidden = chatConversation.length > 0 || chatBusy;
    let html = chatConversation.map(m => {
        if (m.role === 'user') {
            return `<div class="recommender-chat-msg user">
                <div class="recommender-chat-msg-role"><i class="fa-solid fa-user"></i> You</div>
                <div class="recommender-chat-msg-text">${CoreAPI.escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
            </div>`;
        }
        // LLM output is untrusted (card content can prompt-inject), so it goes through the canonical safe rich-text pipeline.
        const body = m._error
            ? CoreAPI.escapeHtml(m.content)
            : fixChatContrast(CoreAPI.safePurify(CoreAPI.formatRichText(mdBlocksToHtml(m.content), '', true), BROWSE_PURIFY_CONFIG));
        return `<div class="recommender-chat-msg assistant${m._error ? ' error' : ''}">
            <div class="recommender-chat-msg-role"><i class="fa-solid fa-comment-dots"></i> Assistant</div>
            <div class="recommender-chat-msg-text">${body}</div>
        </div>`;
    }).join('');
    if (chatBusy) {
        html += `<div class="recommender-chat-msg assistant thinking">
            <div class="recommender-chat-msg-role"><i class="fa-solid fa-comment-dots"></i> Assistant</div>
            <div class="recommender-chat-thinking-dots"><span></span><span></span><span></span></div>
        </div>`;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
}

async function openCharChat(avatar) {
    const char = CoreAPI.getCharacterByAvatar(avatar);
    if (!char) return;
    const modal = document.getElementById('recommenderCharChatModal');
    if (!modal) return;
    chatChar = char;
    chatConversation = [];
    chatLorebookInfo = null;
    setChatBusy(false);
    const name = CoreAPI.getCharacterName(char) || 'this character';
    const titleEl = document.getElementById('recommenderChatTitle');
    if (titleEl) titleEl.textContent = `Ask about ${name}`;
    const emptyTitle = document.getElementById('recommenderChatEmptyTitle');
    if (emptyTitle) emptyTitle.innerHTML = `Ask anything about <strong>${CoreAPI.escapeHtml(name)}</strong>`;
    await loadChatPrompts();
    const editor = document.getElementById('recommenderChatSystemPrompt');
    if (editor) editor.value = _chatPrompts.active || CHAR_CHAT_DEFAULT_RICH;
    buildChatPresetSelect();
    document.getElementById('recommenderChatSettings')?.classList.add('hidden');
    document.getElementById('recommenderChatSettingsToggle')?.classList.remove('active');
    const lbSection = document.getElementById('recommenderChatLorebookSection');
    const lbSize = document.getElementById('recommenderChatLorebookSize');
    if (lbSection) lbSection.classList.add('hidden');
    renderChatMessages();
    modal.classList.add('visible');
    // Mobile: drop the keyboard-only Enter/Shift+Enter hint; desktop keeps the full template placeholder.
    if (CoreAPI.isMobileMode()) {
        const ci = document.getElementById('recommenderChatInput');
        if (ci) ci.placeholder = 'Ask about this character';
    }
    await CoreAPI.hydrateCharacter(char);
    if (chatChar !== char) return; // closed or reopened on a different char during hydrate
    chatLorebookInfo = computeLorebookInfo(char);
    if (chatLorebookInfo) {
        const lbToggle = document.getElementById('recommenderChatIncludeLorebook');
        if (lbToggle) lbToggle.checked = true;
        if (lbSize) lbSize.innerHTML = `<i class="fa-solid fa-weight-hanging"></i> ${chatLorebookInfo.entries} ${chatLorebookInfo.entries === 1 ? 'entry' : 'entries'} · ~${(chatLorebookInfo.chars / 1024).toFixed(1)} KB · ~${Math.round(chatLorebookInfo.chars / 4).toLocaleString()} tokens`;
        if (lbSection) lbSection.classList.remove('hidden');
    }
    if (!matchMedia('(pointer: coarse)').matches) document.getElementById('recommenderChatInput')?.focus();
}

async function sendChatMessage() {
    if (chatBusy || !chatChar) return;
    const input = document.getElementById('recommenderChatInput');
    const text = input?.value?.trim();
    if (!text) return;
    chatConversation.push({ role: 'user', content: stripOrphanSurrogates(text) });
    if (input) input.value = '';
    setChatBusy(true);
    renderChatMessages();
    const includeLorebook = !!chatLorebookInfo && !!document.getElementById('recommenderChatIncludeLorebook')?.checked;
    const instructions = (document.getElementById('recommenderChatSystemPrompt')?.value || '').trim() || CHAR_CHAT_DEFAULT_RICH;
    const system = stripOrphanSurrogates(instructions + '\n\nCHARACTER CARD:\n' + buildChatCardContext(chatChar, includeLorebook));
    const messages = [{ role: 'system', content: system }, ...chatConversation.map(m => ({ role: m.role, content: m.content }))];
    chatAbortController = new AbortController();
    try {
        const reply = await callForMode(messages, 0.7, chatAbortController.signal);
        chatConversation.push({ role: 'assistant', content: reply?.trim() || '(The model returned an empty response.)' });
    } catch (err) {
        if (err?.name !== 'AbortError' && !err?.isCancelled) {
            chatConversation.push({ role: 'assistant', content: `Error: ${err?.message || 'request failed'}`, _error: true });
        }
    } finally {
        chatAbortController = null;
        setChatBusy(false);
        renderChatMessages();
        if (!matchMedia('(pointer: coarse)').matches) document.getElementById('recommenderChatInput')?.focus();
    }
}

function closeCharChat() {
    const input = document.getElementById('recommenderChatInput');
    const hasDraft = !!(input?.value || '').trim();
    if (hasDraft || chatConversation.length) {
        CoreAPI.showConfirm({
            title: 'Close the chat?',
            message: 'Your conversation about this character will be discarded.',
            confirmLabel: 'Close',
            cancelLabel: 'Keep Open',
            danger: true,
        }).then(confirmed => { if (confirmed) forceCloseCharChat(); });
        return;
    }
    forceCloseCharChat();
}

function forceCloseCharChat() {
    if (chatAbortController) { chatAbortController.abort(); chatAbortController = null; }
    document.getElementById('recommenderCharChatModal')?.classList.remove('visible');
    const input = document.getElementById('recommenderChatInput');
    if (input) input.value = '';
    chatChar = null;
    chatConversation = [];
    chatLorebookInfo = null;
    setChatBusy(false);
}

function collapseSettingsOnMobile() {
    if (CoreAPI.isMobileMode()) {
        const panel = document.getElementById('recommenderSettingsPanel');
        if (panel && !panel.classList.contains('hidden')) {
            panel.classList.add('hidden');
            document.getElementById('recommenderSettingsToggle')?.classList.remove('active');
        }
    }
}

async function runBatchMode(prompt, pool, opts, signal) {
    const batchCount = getOpt('batchCount');
    const totalSample = Math.min(opts.sampleSize * batchCount, pool.length);
    const allSampled = sampleCharacters(pool, totalSample);
    _lastEvaluatedCount = allSampled.length;
    if (opts.includeDescription) await hydrateForDescriptions(allSampled, signal);

    const batches = [];
    const batchSize = Math.ceil(allSampled.length / batchCount);
    for (let i = 0; i < batchCount; i++) {
        const batch = allSampled.slice(i * batchSize, (i + 1) * batchSize);
        if (batch.length) batches.push(batch);
    }

    showStatus(
        `<i class="fa-solid fa-spinner fa-spin"></i> Evaluating ${allSampled.length} characters across ${batches.length} batches...`,
        'info'
    );

    // Map phase — parallel
    let completedBatches = 0;
    const mapPromises = batches.map(batch =>
        generate(prompt, batch, opts, signal).then(result => {
            completedBatches++;
            if (completedBatches < batches.length) {
                showStatus(
                    `<i class="fa-solid fa-spinner fa-spin"></i> Evaluated ${completedBatches}/${batches.length} batches...`,
                    'info'
                );
            }
            return result;
        })
    );

    const mapResults = await Promise.allSettled(mapPromises);

    // Collect finalists from successful batches
    const finalists = [];
    let failedBatches = 0;
    for (let i = 0; i < mapResults.length; i++) {
        if (mapResults[i].status === 'rejected') { failedBatches++; continue; }
        const parsed = parseRecommendations(mapResults[i].value);
        if (!parsed) { failedBatches++; continue; }
        for (const rec of parsed) {
            const idx = rec.index - 1;
            if (idx >= 0 && idx < batches[i].length) {
                finalists.push({ char: batches[i][idx], reason: rec.reason || '' });
            }
        }
    }

    if (!finalists.length) {
        if (failedBatches === batches.length) {
            const firstErr = mapResults.find(r => r.status === 'rejected');
            throw firstErr?.reason || new Error('All batches failed.');
        }
        throw new Error('No matches found across any batch. Try a different prompt or adjust filters.');
    }

    // Deduplicate by avatar
    const seen = new Set();
    const uniqueFinalists = finalists.filter(f => {
        if (seen.has(f.char.avatar)) return false;
        seen.add(f.char.avatar);
        return true;
    });

    // If few enough finalists, skip reduce
    if (uniqueFinalists.length <= opts.maxResults) {
        sampledCharacters = uniqueFinalists.map(f => f.char);
        const directRecs = uniqueFinalists.map((f, i) => ({ index: i + 1, reason: f.reason }));
        hideStatus();
        collapseSettingsOnMobile();
        renderResults(directRecs);
        if (failedBatches > 0) CoreAPI.showToast(`${failedBatches} of ${batches.length} batches failed`, 'warning', 3000);
        return;
    }

    // Reduce phase
    showStatus(
        `<i class="fa-solid fa-spinner fa-spin"></i> Assimilating ${uniqueFinalists.length} candidates...`,
        'info'
    );

    sampledCharacters = uniqueFinalists.map(f => f.char);

    try {
        const reduceContent = await generateReduce(prompt, uniqueFinalists, opts, signal);
        hideStatus();
        collapseSettingsOnMobile();
        const reduceRecs = parseRecommendations(reduceContent);
        if (reduceRecs) {
            renderResults(reduceRecs);
        } else {
            showStatus('Could not parse assimilation results. Showing first-pass picks:', 'warning');
            const fallbackRecs = uniqueFinalists.slice(0, opts.maxResults).map((f, i) => ({ index: i + 1, reason: f.reason }));
            renderResults(fallbackRecs);
        }
    } catch {
        hideStatus();
        collapseSettingsOnMobile();
        showStatus(`Assimilation step failed. Showing first-pass picks from ${batches.length - failedBatches} batches:`, 'warning');
        const fallbackRecs = uniqueFinalists.slice(0, opts.maxResults).map((f, i) => ({ index: i + 1, reason: f.reason }));
        renderResults(fallbackRecs);
    }
    if (failedBatches > 0) CoreAPI.showToast(`${failedBatches} of ${batches.length} batches failed`, 'warning', 3000);
}


// ========================================
// RESPONSE PARSING
// ========================================

function parseRecommendations(rawContent) {
    let text = rawContent.trim();

    // Strip markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    // Try parsing as JSON array
    try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) return arr;
    } catch { /* fallthrough */ }

    // Try extracting a JSON array from the text (greedy — grab the largest match)
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            const arr = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arr)) return arr;
        } catch { /* fallthrough */ }
    }

    // Handle truncated JSON — the response may have been cut off mid-array
    const truncated = repairTruncatedArray(text);
    if (truncated) return truncated;

    return null;
}

function repairTruncatedArray(text) {
    // Find the start of a JSON array
    const arrStart = text.indexOf('[');
    if (arrStart === -1) return null;

    let fragment = text.slice(arrStart);

    // Trim any trailing incomplete object (cut off mid-key/value)
    // Find the last complete object by locating the last '}'
    const lastBrace = fragment.lastIndexOf('}');
    if (lastBrace === -1) return null;

    fragment = fragment.slice(0, lastBrace + 1);

    // Close the array if needed
    if (!fragment.trimEnd().endsWith(']')) {
        // Remove any trailing comma
        fragment = fragment.replace(/,\s*$/, '') + ']';
    }

    try {
        const arr = JSON.parse(fragment);
        if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch { /* not recoverable */ }

    return null;
}


// ========================================
// STATUS & RESULTS RENDERING
// ========================================

function categorizeLLMError(msg) {
    if (/cancelled|aborted/i.test(msg)) return { summary: 'Generation cancelled.' };
    if (/empty response/i.test(msg)) return { summary: 'The model returned an empty response.', detail: 'This usually means the model is overloaded or the request was too large. Try a smaller sample size or try again later.' };
    if (/API error:/i.test(msg)) {
        const inner = msg.replace(/^API error:\s*/i, '');
        return { summary: 'The API returned an error.', detail: inner };
    }
    if (/API returned (\d+)/i.test(msg)) {
        const code = msg.match(/API returned (\d+)/i)?.[1];
        if (code === '500' || code === '502' || code === '503') return { summary: `Server error (${code}) — the model provider may be down.`, detail: msg };
        if (code === '429') return { summary: 'Rate limited — too many requests.', detail: 'Wait a moment and try again.' };
        if (code === '401' || code === '403') return { summary: 'Authentication failed — check your API key or connection profile.', detail: msg };
        return { summary: `API error ${code}`, detail: msg };
    }
    if (/non-JSON/i.test(msg)) return { summary: 'The API returned an invalid response.', detail: msg };
    if (/could not reach/i.test(msg)) return { summary: 'Could not reach the API.', detail: 'Make sure SillyTavern has a Chat Completion API configured and connected, or switch to Custom API mode.' };
    if (/No Chat Completion source/i.test(msg)) return { summary: 'No API source detected.', detail: 'Select a Chat Completion API in SillyTavern and reopen this modal.' };
    return { summary: CoreAPI.escapeHtml(msg) };
}

function showStatus(message, type = 'info') {
    const el = document.getElementById('recommenderStatus');
    if (!el) return;
    el.className = `recommender-status recommender-status-${type}`;
    if (type === 'error' && lastDebugContext) {
        el.innerHTML = `<div class="recommender-status-row"><div class="recommender-status-message">${message}</div><button class="recommender-copy-debug" title="Copy debug info to clipboard"><i class="fa-regular fa-clipboard"></i></button></div>`;
        el.querySelector('.recommender-copy-debug')?.addEventListener('click', copyDebugToClipboard);
    } else {
        el.innerHTML = message;
    }
    el.classList.remove('hidden');
}

function copyDebugToClipboard() {
    if (!lastDebugContext) return;
    const d = lastDebugContext;
    const lines = [
        `=== AI Recommender Debug ===`,
        `Time: ${d.timestamp}`,
        `API Mode: ${d.apiMode}`,
        `Source: ${d.source}`,
        `Model: ${d.model}`,
        d.profileName ? `Profile: ${d.profileName}` : null,
        ``,
        `--- Pool ---`,
        `Total characters: ${d.totalChars}`,
        `Pool after filters: ${d.poolSize}`,
        `Sampled: ${d.sampledCount} (requested ${d.sampleSize})`,
        ``,
        `--- Filters ---`,
        `Has Chats: ${d.filters.hasChats}`,
        `Favorite: ${d.filters.favorite}`,
        d.filters.dateEnabled ? `Date range: ${d.filters.dateFrom || '(any)'} — ${d.filters.dateTo || '(any)'}` : `Date range: off`,
        d.filters.tagsInclude?.length ? `Tags include: ${d.filters.tagsInclude.join(', ')}` : null,
        d.filters.tagsExclude?.length ? `Tags exclude: ${d.filters.tagsExclude.join(', ')}` : null,
        ``,
        `--- Generation ---`,
        `Temperature: ${d.temperature}`,
        `Max results: ${d.maxResults}`,
        `Context fields: ${Object.entries(d.contextFields).filter(([,v]) => v).map(([k]) => k).join(', ') || 'none'}`,
        ``,
        `--- User Prompt ---`,
        d.userPrompt,
        ``,
        `--- System Prompt ---`,
        d.messages?.[0]?.content || '(none)',
        ``,
        `--- User Message Sent ---`,
        d.messages?.[1]?.content || '(none)',
        ``,
        `--- Raw Response ---`,
        d.rawResponse || '(no response received)',
        ``,
        `--- Error ---`,
        d.error || '(none)',
    ].filter(l => l !== null).join('\n');

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(lines).then(
            () => CoreAPI.showToast('Debug info copied to clipboard', 'success', 2000),
            () => CoreAPI.showToast('Failed to copy to clipboard', 'error'),
        );
    } else {
        const ta = document.createElement('textarea');
        ta.value = lines;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            CoreAPI.showToast('Debug info copied to clipboard', 'success', 2000);
        } catch {
            CoreAPI.showToast('Failed to copy to clipboard', 'error');
        }
        ta.remove();
    }
}

function hideStatus() {
    document.getElementById('recommenderStatus')?.classList.add('hidden');
}

function clearResults() {
    const el = document.getElementById('recommenderResults');
    if (el) {
        el.innerHTML = '';
        el.classList.add('hidden');
    }
    hideStatus();
}

function renderResults(recommendations) {
    const resultsEl = document.getElementById('recommenderResults');
    if (!resultsEl || !sampledCharacters) return;

    if (!recommendations || recommendations.length === 0) {
        showStatus('The model could not find matching characters. Try a different prompt or increase the sample size.', 'warning');
        return;
    }

    const cards = [];
    const renderedAvatars = [];
    let rank = 0;
    for (const rec of recommendations) {
        const idx = rec.index - 1;
        if (idx < 0 || idx >= sampledCharacters.length) continue;
        const char = sampledCharacters[idx];
        if (!char) continue;
        rank++;
        if (char.avatar) renderedAvatars.push(char.avatar);

        const avatarUrl = CoreAPI.getCharacterAvatarStThumbUrl(char.avatar);
        const tags = CoreAPI.getCharacterTags(char);
        const tagsHtml = tags.slice(0, 5).map(t =>
            `<span class="recommender-tag">${CoreAPI.escapeHtml(t)}</span>`
        ).join('');
        const creator = char.data?.creator;

        cards.push(`
            <div class="recommender-result-card" data-avatar="${CoreAPI.escapeHtml(char.avatar)}">
                <span class="recommender-result-rank">${rank}</span>
                <div class="recommender-result-avatar">
                    <img src="${avatarUrl}" alt="" loading="lazy">
                </div>
                <div class="recommender-result-info">
                    <div class="recommender-result-header">
                        <a class="recommender-result-name-link" href="#" title="Open character details">${CoreAPI.escapeHtml(CoreAPI.getCharacterName(char) || 'Unknown')}</a>
                        ${creator ? `<span class="recommender-result-creator">by ${CoreAPI.escapeHtml(creator)}</span>` : ''}
                    </div>
                    ${rec.reason ? `<div class="recommender-result-reason">${CoreAPI.escapeHtml(rec.reason)}</div>` : ''}
                    ${tagsHtml ? `<div class="recommender-result-tags">${tagsHtml}</div>` : ''}
                </div>
                <div class="recommender-result-actions">
                    <button class="recommender-playlist-btn" title="Add to playlist"><i class="fa-solid fa-list-ul"></i></button>
                    <button class="recommender-chat-btn" title="Ask about this character"><i class="fa-solid fa-comment-dots"></i></button>
                </div>
            </div>
        `);
    }

    if (cards.length === 0) {
        showStatus('Could not match the model\'s response to characters in your library. Try again.', 'warning');
        return;
    }

    resultsEl.innerHTML = `
        <div class="recommender-results-header">
            <i class="fa-solid fa-sparkles"></i>
            <span>${cards.length} Recommendation${cards.length !== 1 ? 's' : ''}</span>
            <button class="recommender-playlist-all-btn" title="Add all to playlist"><i class="fa-solid fa-list-ul"></i></button>
            <button id="recommenderRerollBtn" class="recommender-reroll-btn" title="Reroll: same prompt, exclude these picks"><i class="fa-solid fa-dice"></i><span class="recommender-reroll-label">Reroll</span></button>
            <span class="recommender-results-badge">${_lastEvaluatedCount} evaluated</span>
        </div>
        <div class="recommender-results-grid">${cards.join('')}</div>
    `;
    resultsEl.classList.remove('hidden');

    // Track these picks so reroll excludes them next run
    for (const av of renderedAvatars) _excludedAvatars.add(av);
}

function renderRawFallback(rawContent) {
    const resultsEl = document.getElementById('recommenderResults');
    if (!resultsEl) return;
    resultsEl.innerHTML = `
        <div class="recommender-results-header">
            <i class="fa-solid fa-robot"></i> Raw Model Response
        </div>
        <div class="recommender-raw-response">${CoreAPI.escapeHtml(rawContent)}</div>
    `;
    resultsEl.classList.remove('hidden');
}


// ========================================
// SUBMIT HANDLER
// ========================================

async function executeRecommendation(prompt, pool) {
    const opts = {
        sampleSize: getOpt('sampleSize'),
        temperature: getOpt('temperature'),
        maxResults: getOpt('maxResults'),
        includeTags: getOpt('includeTags'),
        includeCreatorNotes: getOpt('includeCreatorNotes'),
        includeTagline: getOpt('includeTagline'),
        includeCreator: getOpt('includeCreator'),
        includeSource: getOpt('includeSource'),
        includeDescription: getOpt('includeDescription'),
        // Cached for the debug-context dump in generate(); skips a redundant O(pool) re-filter.
        poolSize: pool.length,
    };

    abortController = new AbortController();
    const batchMode = getOpt('batchMode');
    const timeoutId = setTimeout(() => abortController.abort(), batchMode ? GENERATE_TIMEOUT_MS * 2 : GENERATE_TIMEOUT_MS);

    try {
        if (batchMode) {
            await runBatchMode(prompt, pool, opts, abortController.signal);
        } else {
            sampledCharacters = sampleCharacters(pool, opts.sampleSize);
            _lastEvaluatedCount = sampledCharacters.length;
            if (opts.includeDescription) await hydrateForDescriptions(sampledCharacters, abortController.signal);

            const rawContent = await generate(prompt, sampledCharacters, opts, abortController.signal, (done, total) => {
                showStatus(
                    `<i class="fa-solid fa-spinner fa-spin"></i> Building prompt ${done}/${total}...`,
                    'info'
                );
            });
            hideStatus();
            collapseSettingsOnMobile();

            const recommendations = parseRecommendations(rawContent);
            CoreAPI.debugLog('[Recommender] Parse result:', recommendations ? `${recommendations.length} recommendations` : 'parse failed, raw fallback');
            if (recommendations) {
                renderResults(recommendations);
            } else {
                showStatus('The model didn\'t return structured results. Showing raw response:', 'warning');
                renderRawFallback(rawContent);
            }
        }
    } catch (err) {
        console.error('[Recommender] Generation failed:', err);
        const friendly = categorizeLLMError(err.message);
        showStatus(
            `<i class="fa-solid fa-circle-exclamation"></i> ${friendly.summary}` +
            (friendly.detail ? `<div class="recommender-error-detail">${CoreAPI.escapeHtml(friendly.detail)}</div>` : ''),
            'error'
        );
    } finally {
        clearTimeout(timeoutId);
        abortController = null;
    }
}

async function handleSubmit() {
    if (isGenerating) return;

    const prompt = document.getElementById('recommenderPrompt')?.value?.trim();
    if (!prompt) {
        CoreAPI.showToast('Please enter a prompt describing what you\'re looking for.', 'warning');
        return;
    }

    const allChars = CoreAPI.getAllCharacters();
    if (!allChars.length) {
        CoreAPI.showToast('No characters in your library.', 'warning');
        return;
    }

    isGenerating = true;
    const submitBtn = document.getElementById('recommenderSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('generating');
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span class="recommender-submit-label">Generating…</span>';
    }
    clearResults();

    // Reset reroll state for a fresh prompt run
    _lastPrompt = prompt;
    _excludedAvatars = new Set();

    // Yield so the browser paints the spinner before heavy sync work
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    saveSettingsFromUI();

    const pool = getFilteredPool();
    if (!pool.length) {
        CoreAPI.showToast('No characters match the current filters. Adjust the Sample Pool settings.', 'warning');
        isGenerating = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove('generating');
            submitBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span class="recommender-submit-label">Recommend</span>';
        }
        return;
    }

    try {
        await executeRecommendation(prompt, pool);
    } finally {
        isGenerating = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove('generating');
            submitBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span class="recommender-submit-label">Recommend</span>';
        }
    }
}

async function handleReroll() {
    if (isGenerating) return;
    if (!_lastPrompt) {
        CoreAPI.showToast('No previous run to reroll. Hit Recommend first.', 'warning');
        return;
    }

    // Immediate feedback BEFORE any heavy work
    isGenerating = true;
    const rerollBtn = document.getElementById('recommenderRerollBtn');
    if (rerollBtn) {
        rerollBtn.disabled = true;
        rerollBtn.classList.add('generating');
    }
    showStatus('<i class="fa-solid fa-spinner fa-spin"></i> Rerolling...', 'info');

    // Yield so the browser paints the spinner before sync filter/sample work
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const pool = getFilteredPool().filter(c => !_excludedAvatars.has(c.avatar));
    if (!pool.length) {
        hideStatus();
        CoreAPI.showToast('No more characters left in the pool. Start a new prompt or adjust filters.', 'warning');
        isGenerating = false;
        if (rerollBtn) {
            rerollBtn.disabled = false;
            rerollBtn.classList.remove('generating');
        }
        return;
    }

    try {
        await executeRecommendation(_lastPrompt, pool);
    } finally {
        isGenerating = false;
        // Always reset reroll button - on success renderResults replaces it
        // (no-op on a fresh button), on error the old one stays in DOM
        const btn = document.getElementById('recommenderRerollBtn');
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('generating');
        }
    }
}


// ========================================
// MODULE INTERFACE
// ========================================

function init() {
    if (isInitialized) return;
    isInitialized = true;
    CoreAPI.debugLog('[Recommender] Module initialized');
}

export { openModal };

export default {
    init,
    openModal,
};
