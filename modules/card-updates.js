/**
 * Card Updates Module for SillyTavern Character Library
 * Check for updates to Chub-linked characters and show diffs
 * 
 * @module CardUpdates
 * @version 1.0.0
 */

import * as CoreAPI from './core-api.js';

// Module state
let isInitialized = false;
let currentUpdateChecks = new Map(); // fullPath -> { local, remote, diffs }
let abortController = null;
let pendingBatchCharacters = [];
let batchCheckPaused = false;
let batchCheckRunning = false;
let batchCheckedCount = 0;

// Fields to compare (key -> display label)
const COMPARABLE_FIELDS = {
    // Core character fields
    'name': 'Name',
    'description': 'Description',
    'personality': 'Personality',
    'scenario': 'Scenario',
    'first_mes': 'First Message',
    'mes_example': 'Example Messages',
    'system_prompt': 'System Prompt',
    'post_history_instructions': 'Post History Instructions',
    'creator_notes': 'Creator Notes',
    'creator': 'Creator',
    // Note: character_version is NOT provided by the Chub API.
    // ST's own downloadChubCharacter() hardcodes it to ''. Comparing it
    // would always show a false diff (local "main" vs remote ""), so we
    // intentionally exclude it.
    'tags': 'Tags',
    'alternate_greetings': 'Alternate Greetings',
    'extensions.chub.tagline': 'Chub Tagline',
    // V3 additions
    'nickname': 'Nickname', // Not mapped from Chub API yet
    'group_only_greetings': 'Group Only Greetings', // Not mapped from Chub API yet
    // Depth prompt
    'depth_prompt.prompt': 'Depth Prompt Text', // Not mapped from Chub API yet
    'depth_prompt.depth': 'Depth Prompt Depth', // Not mapped from Chub API yet
    'depth_prompt.role': 'Depth Prompt Role', // Not mapped from Chub API yet
    'character_book': 'Embedded Lorebook',
};

let batchFieldSelection = new Set(
    Object.keys(COMPARABLE_FIELDS)
);

// Fields that should use text diff view
const LONG_TEXT_FIELDS = new Set([
    'description', 'personality', 'scenario', 'first_mes', 
    'mes_example', 'system_prompt', 'post_history_instructions',
    'creator_notes', 'depth_prompt.prompt', 'alternate_greetings',
    'group_only_greetings', 'extensions.chub.tagline'
]);

/**
 * Initialize the card updates module
 * @param {Object} deps - Dependencies (legacy, now using CoreAPI)
 */
export function init(deps) {
    if (isInitialized) {
        console.warn('[CardUpdates] Already initialized');
        return;
    }
    
    injectStyles();
    injectModals();
    setupEventListeners();
    
    isInitialized = true;
    console.log('[CardUpdates] Module initialized');
}

/**
 * Open update check modal for a single character
 * @param {Object} char - Character to check for updates
 */
export async function checkSingleCharacter(char) {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const chubInfo = getChubLinkInfo(char);
    if (!chubInfo?.fullPath) {
        CoreAPI.showToast('Character is not linked to ChubAI', 'warning');
        return;
    }
    
    showSingleCheckModal(char);
    await performSingleCheck(char);
}

/**
 * Open batch update check modal for all Chub-linked characters
 */
export async function checkAllLinkedCharacters() {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const linkedChars = getChubLinkedCharacters();
    if (linkedChars.length === 0) {
        CoreAPI.showToast('No characters are linked to ChubAI', 'info');
        return;
    }
    
    showBatchCheckModal(linkedChars);
}

/**
 * Check selected characters for updates
 */
export async function checkSelectedCharacters() {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const selected = CoreAPI.getSelectedCharacters();
    if (!selected || selected.length === 0) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }
    
    // Filter to only Chub-linked characters
    const linkedSelected = selected.filter(c => getChubLinkInfo(c)?.fullPath);
    if (linkedSelected.length === 0) {
        CoreAPI.showToast('None of the selected characters are linked to ChubAI', 'warning');
        return;
    }
    
    showBatchCheckModal(linkedSelected);
}

// ========================================
// CHUB INTEGRATION
// ========================================

/**
 * Get Chub link info from a character
 * @param {Object} char - Character object
 * @returns {Object|null} { id, fullPath, linkedAt } or null
 */
function getChubLinkInfo(char) {
    if (!char) return null;
    const extensions = char.data?.extensions || char.extensions;
    const chub = extensions?.chub;
    if (!chub) return null;
    
    // Normalize: native ChubAI cards use full_path (snake_case), we use fullPath (camelCase)
    const fullPath = chub.fullPath || chub.full_path;
    if (!fullPath) return null;
    
    return {
        id: chub.id || null,
        fullPath: fullPath,
        linkedAt: chub.linkedAt || null
    };
}

/**
 * Get all characters that are linked to ChubAI
 * @returns {Array} Characters with Chub links
 */
function getChubLinkedCharacters() {
    const allChars = CoreAPI.getAllCharacters();
    return allChars.filter(c => getChubLinkInfo(c)?.fullPath);
}

/**
 * Fetch with CORS proxy fallback (same pattern as character-versions.js)
 */
async function fetchWithProxy(url, opts = {}) {
    try {
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
    } catch (_) {
        const r = await fetch(`/proxy/${encodeURIComponent(url)}`, opts);
        if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);
        return r;
    }
}

/**
 * Fetch the latest card.json from Chub's V4 Git API.
 * This is the same source that version history uses, and represents
 * the canonical exported state of the card (V2 spec).
 */
async function fetchCardJsonFromV4(projectId) {
    if (!projectId) return null;
    const headers = CoreAPI.getChubHeaders?.() || { Accept: 'application/json' };
    try {
        const commitsResp = await fetchWithProxy(
            `https://api.chub.ai/api/v4/projects/${projectId}/repository/commits`,
            { headers }
        );
        const commits = await commitsResp.json();
        const ref = Array.isArray(commits) && commits[0]?.id;
        if (!ref) return null;

        const cardResp = await fetchWithProxy(
            `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`,
            { headers }
        );
        const card = await cardResp.json();
        return card || null;
    } catch (e) {
        console.warn('[CardUpdates] V4 Git card.json fetch failed for project', projectId, e.message);
        return null;
    }
}

/**
 * Fetch remote character data from ChubAI.
 *
 * When the V4 Git API setting is enabled, uses the Git card.json (latest
 * commit) as the primary source — same source version history uses, already
 * in V2 spec format.
 *
 * When V4 is disabled (default), the metadata API is the primary source
 * with manual field mapping. Both paths resolve linked lorebooks.
 *
 * Last resort: PNG extraction from the avatar image.
 *
 * @param {string} fullPath - Chub full path (creator/slug)
 * @returns {Promise<Object|null>} Remote character card data (V2 format)
 */
async function fetchRemoteCard(fullPath) {
    const useV4 = CoreAPI.getSetting('chubUseV4Api') || false;

    try {
        // Get metadata (always needed for project ID, fallback definition, etc.)
        const metadata = await CoreAPI.fetchChubMetadata(fullPath);
        const projectId = metadata?.id;

        // V4 Git API path — fetches the exported card.json from Git repo
        if (useV4 && projectId) {
            const cardJson = await fetchCardJsonFromV4(projectId);
            if (cardJson) {
                if (cardJson.data) {
                    // Supplement with metadata-only fields that card.json may lack
                    if (metadata.topics && !cardJson.data.tags?.length) {
                        cardJson.data.tags = metadata.topics;
                    }
                    if (metadata.tagline) {
                        cardJson.data.extensions = cardJson.data.extensions || {};
                        cardJson.data.extensions.chub = cardJson.data.extensions.chub || {};
                        if (!cardJson.data.extensions.chub.tagline) {
                            cardJson.data.extensions.chub.tagline = metadata.tagline;
                        }
                    }
                    console.log('[CardUpdates] Using V4 Git card.json for:', fullPath);
                    return cardJson;
                }
                console.log('[CardUpdates] Normalizing raw card.json for:', fullPath);
                return normalizeChubDefinition(cardJson, metadata);
            }
            // V4 failed — fall through to metadata
        }

        // Metadata API path (default, or V4 fallback)
        if (metadata?.definition) {
            console.log(`[CardUpdates] Using metadata API for: ${fullPath}${useV4 ? ' (V4 fallback)' : ''}`);
            return await buildCardFromMetadata(metadata);
        }

        // Last resort: PNG extraction (may have stale data)
        console.log('[CardUpdates] All APIs failed, trying PNG extraction for:', fullPath);
        const pngUrl = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
        let response;
        try {
            response = await fetch(pngUrl);
        } catch (e) {
            response = await fetch(`/proxy/${encodeURIComponent(pngUrl)}`);
        }
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            const cardData = CoreAPI.extractCharacterDataFromPng(buffer);
            if (cardData) {
                console.log('[CardUpdates] Extracted card data from PNG for:', fullPath);
                return cardData;
            }
        }

        return null;
    } catch (error) {
        console.error('[CardUpdates] Failed to fetch remote card:', fullPath, error);
        return null;
    }
}

/**
 * Normalize a raw Chub definition (non-V2) into V2 card format.
 * Handles both Chub API field names and partial V2 objects.
 */
function normalizeChubDefinition(def, metadata) {
    if (!def) return null;
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || metadata?.name || '',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            creator_notes: def.description || '',
            creator: metadata?.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            tags: metadata?.topics || [],
            alternate_greetings: def.alternate_greetings || [],
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: metadata?.tagline || ''
                }
            },
            character_book: def.embedded_lorebook || def.character_book || undefined,
        }
    };
}

/**
 * Build a V2 card from metadata API response (Chub field names → V2 spec).
 * Default primary path when V4 Git API is disabled; also used as fallback
 * when V4 is enabled but the request fails.
 */
async function buildCardFromMetadata(metadata) {
    const def = metadata.definition;

    // Resolve linked lorebooks: the metadata API may return a partial embedded_lorebook
    // but the full merged result (embedded + linked project entries) is only in the V4 Git
    // API's exported card.json. Always prefer V4 when related_lorebooks is present.
    let characterBook = def.embedded_lorebook || undefined;
    if (metadata.related_lorebooks?.length > 0 && metadata.id) {
        try {
            const linked = await CoreAPI.fetchChubLinkedLorebook(metadata.id);
            if (linked?.entries?.length > 0) characterBook = linked;
        } catch (e) {
            console.warn('[CardUpdates] Failed to fetch linked lorebook for', metadata.fullPath, e);
        }
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || metadata.name,
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            creator_notes: def.description || '',
            creator: metadata.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            tags: metadata.topics || [],
            alternate_greetings: def.alternate_greetings || [],
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: metadata.tagline || metadata.definition?.tagline || ''
                }
            },
            character_book: characterBook,
        }
    };
}

/**
 * Get a nested property value from an object using dot notation
 * @param {Object} obj - Object to get value from
 * @param {string} path - Dot-notated path (e.g., 'depth_prompt.prompt')
 * @returns {*} Value at path or undefined
 */
function getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Set a nested property value on an object using dot notation
 * @param {Object} obj - Object to set value on
 * @param {string} path - Dot-notated path
 * @param {*} value - Value to set
 */
function setNestedValue(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((o, k) => {
        if (o[k] === undefined) o[k] = {};
        return o[k];
    }, obj);
    target[lastKey] = value;
}

/**
 * Generate line-by-line diff HTML with added/removed highlighting
 * Uses a simple line-based diff algorithm
 * @param {*} localValue - Local value
 * @param {*} remoteValue - Remote value
 * @returns {string} HTML for diff display
 */
function generateLineDiff(localValue, remoteValue) {
    const localStr = formatValueForDisplay(localValue);
    const remoteStr = formatValueForDisplay(remoteValue);
    
    const localLines = localStr.split('\n');
    const remoteLines = remoteStr.split('\n');
    
    // Simple LCS-based diff
    const diff = computeLineDiff(localLines, remoteLines);
    
    // Post-process to detect modified lines (removed+added pairs) and highlight word changes
    const processedDiff = [];
    for (let i = 0; i < diff.length; i++) {
        const item = diff[i];
        
        // Check if this is a removed line followed by an added line (modification)
        if (item.type === 'removed' && i + 1 < diff.length && diff[i + 1].type === 'added') {
            const oldLine = item.line;
            const newLine = diff[i + 1].line;
            
            // Generate word-level diff for this pair
            const { oldHtml, newHtml } = computeWordDiff(oldLine, newLine);
            processedDiff.push({ type: 'removed', html: oldHtml });
            processedDiff.push({ type: 'added', html: newHtml });
            i++; // Skip the next item since we processed it
        } else {
            processedDiff.push({ type: item.type, html: CoreAPI.escapeHtml(item.line) });
        }
    }
    
    let html = '';
    
    for (const item of processedDiff) {
        if (item.type === 'removed') {
            html += `<div class="card-update-diff-line removed"><span class="card-update-diff-line-prefix">-</span>${item.html}</div>`;
        } else if (item.type === 'added') {
            html += `<div class="card-update-diff-line added"><span class="card-update-diff-line-prefix">+</span>${item.html}</div>`;
        } else {
            html += `<div class="card-update-diff-line context"><span class="card-update-diff-line-prefix"> </span>${item.html}</div>`;
        }
    }
    
    return html || '<div class="card-update-diff-line context">(no content)</div>';
}

/**
 * Generate side-by-side diff view with word-level highlighting
 * @param {*} localValue - Local value
 * @param {*} remoteValue - Remote value  
 * @returns {{localHtml: string, remoteHtml: string, stats: string}}
 */
function generateSideBySideDiff(localValue, remoteValue) {
    const localStr = formatValueForDisplay(localValue);
    const remoteStr = formatValueForDisplay(remoteValue);
    
    // Split into lines
    const localLines = localStr.split('\n');
    const remoteLines = remoteStr.split('\n');
    
    // Get line-level diff first
    const lineDiff = computeLineDiff(localLines, remoteLines);
    
    // Build aligned side-by-side output
    const localOutput = [];
    const remoteOutput = [];
    let changedLines = 0;
    let addedLines = 0;
    let removedLines = 0;
    
    let i = 0;
    while (i < lineDiff.length) {
        const item = lineDiff[i];
        
        if (item.type === 'context') {
            // Unchanged line - show on both sides
            localOutput.push({ type: 'context', html: CoreAPI.escapeHtml(item.line) });
            remoteOutput.push({ type: 'context', html: CoreAPI.escapeHtml(item.line) });
            i++;
        } else if (item.type === 'removed' && i + 1 < lineDiff.length && lineDiff[i + 1].type === 'added') {
            // Modified line - show word diff on both sides
            const { oldHtml, newHtml } = computeWordDiff(item.line, lineDiff[i + 1].line);
            localOutput.push({ type: 'changed', html: oldHtml });
            remoteOutput.push({ type: 'changed', html: newHtml });
            changedLines++;
            i += 2;
        } else if (item.type === 'removed') {
            // Line only in local - show on left, empty on right
            localOutput.push({ type: 'removed', html: CoreAPI.escapeHtml(item.line) });
            remoteOutput.push({ type: 'empty', html: '' });
            removedLines++;
            i++;
        } else if (item.type === 'added') {
            // Line only in remote - empty on left, show on right
            localOutput.push({ type: 'empty', html: '' });
            remoteOutput.push({ type: 'added', html: CoreAPI.escapeHtml(item.line) });
            addedLines++;
            i++;
        } else {
            i++;
        }
    }
    
    // Convert to HTML
    const localHtml = localOutput.map(item => {
        if (item.type === 'empty') {
            return '<div class="diff-line empty"></div>';
        }
        const className = item.type === 'context' ? 'diff-line' : 
                         item.type === 'changed' ? 'diff-line changed' : 
                         'diff-line removed';
        return `<div class="${className}">${item.html || '&nbsp;'}</div>`;
    }).join('');
    
    const remoteHtml = remoteOutput.map(item => {
        if (item.type === 'empty') {
            return '<div class="diff-line empty"></div>';
        }
        const className = item.type === 'context' ? 'diff-line' : 
                         item.type === 'changed' ? 'diff-line changed' : 
                         'diff-line added';
        return `<div class="${className}">${item.html || '&nbsp;'}</div>`;
    }).join('');
    
    // Build stats string
    const statParts = [];
    if (changedLines > 0) statParts.push(`${changedLines} modified`);
    if (addedLines > 0) statParts.push(`${addedLines} added`);
    if (removedLines > 0) statParts.push(`${removedLines} removed`);
    const stats = statParts.length > 0 ? statParts.join(', ') : 'different';
    
    return { localHtml, remoteHtml, stats };
}

/**
 * Compute word-level diff between two lines
 * Returns HTML with highlighted changes
 * @param {string} oldLine - Original line
 * @param {string} newLine - New line
 * @returns {{oldHtml: string, newHtml: string}}
 */
function computeWordDiff(oldLine, newLine) {
    // Tokenize into words (keeping whitespace attached)
    const oldWords = tokenizeForDiff(oldLine);
    const newWords = tokenizeForDiff(newLine);
    
    // LCS on words
    const m = oldWords.length;
    const n = newWords.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldWords[i - 1] === newWords[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    // Backtrack to build diff
    const oldResult = [];
    const newResult = [];
    let i = m, j = n;
    
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
            oldResult.unshift({ type: 'same', text: oldWords[i - 1] });
            newResult.unshift({ type: 'same', text: newWords[j - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            newResult.unshift({ type: 'added', text: newWords[j - 1] });
            j--;
        } else {
            oldResult.unshift({ type: 'removed', text: oldWords[i - 1] });
            i--;
        }
    }
    
    // Convert to HTML
    const oldHtml = oldResult.map(item => {
        const escaped = CoreAPI.escapeHtml(item.text);
        return item.type === 'removed' 
            ? `<span class="word-removed">${escaped}</span>` 
            : escaped;
    }).join('');
    
    const newHtml = newResult.map(item => {
        const escaped = CoreAPI.escapeHtml(item.text);
        return item.type === 'added' 
            ? `<span class="word-added">${escaped}</span>` 
            : escaped;
    }).join('');
    
    return { oldHtml, newHtml };
}

/**
 * Tokenize a string into words for diff comparison
 * Keeps punctuation and whitespace as separate tokens
 * @param {string} str - String to tokenize
 * @returns {Array<string>}
 */
function tokenizeForDiff(str) {
    // Split on word boundaries, keeping the delimiters
    return str.match(/\S+|\s+/g) || [];
}

/**
 * Compute line diff using LCS (Longest Common Subsequence)
 * @param {Array<string>} oldLines - Original lines
 * @param {Array<string>} newLines - New lines
 * @returns {Array<{type: string, line: string}>} Diff items
 */
function computeLineDiff(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;
    
    // Build LCS table
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    // Backtrack to find diff
    const result = [];
    let i = m, j = n;
    
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.unshift({ type: 'context', line: oldLines[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'added', line: newLines[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'removed', line: oldLines[i - 1] });
            i--;
        }
    }
    
    return result;
}

/**
 * Compare two cards and find differences
 * @param {Object} localData - Local character data (char.data)
 * @param {Object} remoteCard - Remote card object
 * @param {Set|null} allowedFields - Optional filter for which fields to compare
 * @returns {Array} Array of { field, label, local, remote, isLongText }
 */
function compareCards(localData, remoteCard, allowedFields = null) {
    const diffs = [];
    const remoteData = remoteCard?.data || remoteCard;
    
    for (const [field, label] of Object.entries(COMPARABLE_FIELDS)) {
        if (allowedFields && !allowedFields.has(field)) {
            continue;
        }
        const localValue = getNestedValue(localData, field);
        const remoteValue = getNestedValue(remoteData, field);

        if (field === 'character_book') {
            const remoteEntries = remoteValue?.entries || [];
            const localEntries = localValue?.entries || [];

            // Remote has no lorebook but local does — lorebook was removed upstream
            if (remoteEntries.length === 0 && !hasRemoteLorebookMeta(remoteValue)) {
                if (localEntries.length > 0) {
                    diffs.push({ field, label, local: localValue, remote: remoteValue, isLongText: false });
                }
                continue;
            }

            // Quick equality check
            if (lorebooksEqual(localValue, remoteValue)) continue;

            // Deeper semantic check
            const { matched, added, removed } = matchLorebookEntries(localEntries, remoteEntries);
            const modified = matched.filter(m => m.changedFields.length > 0);
            const metaDiffs = compareLorebookMeta(localValue, remoteValue);

            if (added.length === 0 && modified.length === 0 && metaDiffs.length === 0 && removed.length === 0) continue;

            diffs.push({
                field, label,
                local: localValue,
                remote: remoteValue,
                isLongText: false,
            });
            continue;
        }
        
        // Normalize for comparison
        const normalizedLocal = normalizeValue(localValue);
        const normalizedRemote = normalizeValue(remoteValue);
        
        if (!valuesEqual(normalizedLocal, normalizedRemote)) {
            diffs.push({
                field,
                label,
                local: localValue,
                remote: remoteValue,
                isLongText: LONG_TEXT_FIELDS.has(field)
            });
        }
    }
    
    return diffs;
}

/**
 * Normalize a value for comparison
 */
function normalizeValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        // ST often initializes empty fields as [] where Chub returns null/undefined.
        // Treat empty arrays as empty so [] vs null/undefined doesn't produce a false diff.
        if (value.length === 0) return '';
        // Normalize each string element: trim whitespace and normalize line endings
        // to avoid false diffs from insignificant whitespace differences
        const normalized = [...value].map(v =>
            typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : JSON.stringify(v)
        );
        // Sort for order-insensitive comparison (e.g. tags)
        normalized.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return JSON.stringify(normalized);
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).replace(/\r\n/g, '\n').trim();
}

/**
 * Check if two normalized values are equal
 */
function valuesEqual(a, b) {
    return a === b;
}

// ========================================
// SINGLE CHARACTER CHECK
// ========================================

// The avatar of the character currently shown in the single-check modal.
// Stored here instead of in HTML attributes to avoid special-character escaping issues.
let singleModalAvatar = null;

/**
 * Open the character details modal above the update checker modals.
 * Adds body class that boosts z-index for the overlay and any child modals
 * (confirm-modals, gallery viewer) so they all stack above the update checker.
 * Restores when the overlay is hidden.
 */
function openCharModalAbove(char) {
    const overlay = document.getElementById('charModal')?.closest('.modal-overlay')
                 || document.querySelector('.modal-overlay');
    if (!overlay) return;
    document.body.classList.add('char-modal-above');
    const restore = () => {
        document.body.classList.remove('char-modal-above');
        observer.disconnect();
    };
    const observer = new MutationObserver(() => {
        if (overlay.classList.contains('hidden')) restore();
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    CoreAPI.openCharacterModal(char);
}

/**
 * Show single character update check modal
 * @param {Object} char - Character to check
 */
function showSingleCheckModal(char) {
    const modal = document.getElementById('cardUpdateSingleModal');
    const charName = char.data?.name || char.name || 'Unknown';
    singleModalAvatar = char.avatar;
    
    const nameEl = document.getElementById('cardUpdateSingleCharName');
    nameEl.textContent = charName;
    nameEl.classList.add('card-update-char-link');
    nameEl.onclick = () => openCharModalAbove(char);
    
    document.getElementById('cardUpdateSingleStatus').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking for updates...';
    document.getElementById('cardUpdateSingleContent').innerHTML = '';
    document.getElementById('cardUpdateSingleApplyBtn').disabled = true;
    updateSourceBadge(modal);
    
    modal.classList.add('visible');
}

/**
 * Perform update check for a single character
 * @param {Object} char - Character to check
 */
async function performSingleCheck(char) {
    const statusEl = document.getElementById('cardUpdateSingleStatus');
    const contentEl = document.getElementById('cardUpdateSingleContent');
    const applyBtn = document.getElementById('cardUpdateSingleApplyBtn');
    
    const chubInfo = getChubLinkInfo(char);
    const fullPath = chubInfo.fullPath;
    
    try {
        const remoteCard = await fetchRemoteCard(fullPath);
        
        if (!remoteCard) {
            statusEl.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Could not fetch remote card data';
            return;
        }
        
        const localData = char.data || char;

        const diffs = compareCards(localData, remoteCard);
        
        if (diffs.length === 0) {
            statusEl.innerHTML = '<i class="fa-solid fa-check"></i> Character is up to date!';
            return;
        }
        
        statusEl.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left"></i> Found ${diffs.length} difference${diffs.length > 1 ? 's' : ''}`;
        
        currentUpdateChecks.set(char.avatar, { char, localData, remoteCard, diffs });
        
        // Render diff UI
        contentEl.innerHTML = renderDiffList(diffs);
        resolveWorldFileStatus(contentEl, char.avatar).catch(e => console.error('[CardUpdates] World status check failed:', e));
        applyBtn.disabled = false;
        
    } catch (error) {
        console.error('[CardUpdates] Check failed:', error);
        statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> Error checking for updates';
    }
}

/**
 * Render the diff list HTML
 * @param {Array} diffs - Array of diff objects
 * @returns {string} HTML string
 */
function renderDiffList(diffs) {
    return `
        <div class="card-update-diff-list">
            <label class="card-update-select-all">
                <input type="checkbox" checked onchange="window.cardUpdatesToggleAll(this.checked)">
                <span>Select All</span>
            </label>
            ${diffs.map((diff, idx) => renderDiffItem(diff, idx)).join('')}
        </div>
    `;
}

/**
 * Render a single diff item
 * @param {Object} diff - Diff object
 * @param {number} idx - Index for unique ID
 * @returns {string} HTML string
 */
function renderDiffItem(diff, idx) {
    const checkboxId = `diff-item-${idx}`;
    const localDisplay = formatValueForDisplay(diff.local);
    const remoteDisplay = formatValueForDisplay(diff.remote);

    if (diff.field === 'character_book') {
        return renderLorebookDiff(diff, idx);
    }

    if (!diff.isLongText && (Array.isArray(diff.local) || Array.isArray(diff.remote))) {
        const localValues = Array.isArray(diff.local) ? diff.local : [];
        const remoteValues = Array.isArray(diff.remote) ? diff.remote : [];
        return `
            <div class="card-update-diff-item short array">
                <label>
                    <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                    <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>
                </label>
                <div class="card-update-array-diff">
                    <div class="card-update-array-column local">
                        <div class="card-update-array-header">
                            <span>Local</span>
                            <span class="card-update-array-count">${localValues.length}</span>
                        </div>
                        ${renderArrayList(localValues, diff.field, remoteValues)}
                    </div>
                    <div class="card-update-array-column remote">
                        <div class="card-update-array-header">
                            <span>Chub</span>
                            <span class="card-update-array-count">${remoteValues.length}</span>
                        </div>
                        ${renderArrayList(remoteValues, diff.field, localValues)}
                    </div>
                </div>
            </div>
        `;
    }
    
    if (diff.isLongText) {
        const { localHtml, remoteHtml, stats } = generateSideBySideDiff(diff.local, diff.remote);
        return `
            <div class="card-update-diff-item long-text">
                <div class="card-update-diff-header">
                    <label>
                        <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                        <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>
                    </label>
                    <span class="card-update-diff-stats">${stats}</span>
                    <button class="card-update-diff-expand" onclick="window.cardUpdatesToggleExpand(this)">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div class="card-update-diff-content collapsed">
                    <div class="card-update-diff-sidebyside">
                        <div class="card-update-diff-panel local">
                            <div class="card-update-diff-panel-header">
                                <i class="fa-solid fa-house"></i> Your Version
                            </div>
                            <div class="card-update-diff-panel-content">
                                ${localHtml}
                            </div>
                        </div>
                        <div class="card-update-diff-panel remote">
                            <div class="card-update-diff-panel-header">
                                <i class="fa-solid fa-cloud"></i> Chub Version
                            </div>
                            <div class="card-update-diff-panel-content">
                                ${remoteHtml}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    return `
        <div class="card-update-diff-item short">
            <label>
                <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>
            </label>
            <div class="card-update-diff-values">
                <span class="local-value" title="${CoreAPI.escapeHtml(localDisplay)}">${CoreAPI.escapeHtml(truncate(localDisplay, 50))}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="remote-value" title="${CoreAPI.escapeHtml(remoteDisplay)}">${CoreAPI.escapeHtml(truncate(remoteDisplay, 50))}</span>
            </div>
        </div>
    `;
}

// ========================================
// LOREBOOK DIFF
// ========================================

function renderLorebookDiff(diff, idx) {
    const checkboxId = `diff-item-${idx}`;
    const localBook = diff.local;
    const remoteBook = diff.remote;
    const localEntries = localBook?.entries || [];
    const remoteEntries = remoteBook?.entries || [];

    const { matched, added, removed } = matchLorebookEntries(localEntries, remoteEntries);
    const modified = matched.filter(m => m.changedFields.length > 0);
    const metaDiffs = compareLorebookMeta(localBook, remoteBook);

    // "removed" = entries in embedded lorebook but not on remote
    const localOnly = removed;

    if (added.length === 0 && localOnly.length === 0 && modified.length === 0 && metaDiffs.length === 0) return '';

    // Stat pills for the collapsed header
    const statParts = [];
    if (added.length > 0) statParts.push(`${added.length} new from remote`);
    if (localOnly.length > 0) statParts.push(`${localOnly.length} local-only`);
    if (modified.length > 0) statParts.push(`${modified.length} modified`);
    if (metaDiffs.length > 0) statParts.push(`${metaDiffs.length} setting${metaDiffs.length > 1 ? 's' : ''} changed`);
    const stats = statParts.join(', ');

    const remoteRemoved = remoteEntries.length === 0 && !hasRemoteLorebookMeta(remoteBook);
    let entriesHtml = '';

    if (remoteRemoved) {
        entriesHtml += `<div class="lorebook-diff-info-box" style="border-color:rgba(255,152,0,0.3); background:rgba(255,152,0,0.06);">
            <i class="fa-solid fa-triangle-exclamation" style="color:#ffb74d;"></i>
            <div>
                <strong>Lorebook removed on remote</strong>
                <p style="margin:4px 0 0;">The remote card no longer includes an embedded lorebook. Applying this change will clear the ${localEntries.length} embedded entr${localEntries.length === 1 ? 'y' : 'ies'} from your card. Your World Info file (if any) is never modified.</p>
            </div>
        </div>`;
    }

    // Help & tips — collapsible explainer
    entriesHtml += `<div class="lorebook-diff-info-box">
        <i class="fa-solid fa-circle-info"></i>
        <div>
            <strong>Embedded lorebook ↔ ChubAI remote</strong>
            <details class="lorebook-diff-help-details">
                <summary>How lorebook updates work</summary>
                <div class="lorebook-diff-help-body">
                    <p>SillyTavern keeps lorebook data in <em>two</em> separate places:</p>
                    <ul>
                        <li><strong>Embedded lorebook</strong> (inside the card) — this is the copy that Character Library compares and updates. It was created when you first imported the card and is not changed by SillyTavern's World Info editor.</li>
                        <li><strong>World Info file</strong> (in <code>/worlds/</code>) — the live working copy that SillyTavern actually uses in chats. All edits you make in the World Info panel go here. The update checker <em>never</em> modifies this file.</li>
                    </ul>
                    <p>The diff below compares your card's embedded lorebook against the creator's latest version on ChubAI. Applying will replace the embedded lorebook with the remote version.</p>
                    <p><strong>What the badges mean:</strong></p>
                    <ul>
                        <li><span style="color:#81c784;">+</span> <strong>New from remote</strong> — entry exists on ChubAI but not in your card. Will be added.</li>
                        <li><span style="color:#ffcc80;">~</span> <strong>Modified</strong> — entry exists in both but some fields differ. Will be updated to match the remote.</li>
                        <li><span style="color:#bdbdbd;">★</span> <strong>Local-only</strong> — entry is in your card but not on ChubAI. Since applying replaces the full embedded lorebook, this entry will be removed from the card.</li>
                    </ul>
                    <p>For local-only entries that would be removed, Character Library reads your World Info file to check whether each entry also exists there:</p>
                    <ul>
                        <li><i class="fa-solid fa-shield-halved" style="color:#81c784;"></i> <strong>Safe in World Info</strong> — a matching entry exists in your World Info file. Removing it from the card won't affect your chats since the live copy is untouched.</li>
                        <li><i class="fa-solid fa-triangle-exclamation" style="color:#ffb74d;"></i> <strong>Not in World Info</strong> — no match found. This entry only exists in the card's embedded data and will be permanently lost after applying.</li>
                    </ul>
                </div>
            </details>
        </div>
    </div>`;

    if (metaDiffs.length > 0) {
        entriesHtml += `<div class="lorebook-diff-meta-section">
            <div class="lorebook-diff-meta-title">Lorebook Settings</div>
            ${metaDiffs.map(m => `<div class="lorebook-diff-meta-row">
                <span class="lorebook-diff-meta-key">${CoreAPI.escapeHtml(m.label)}</span>
                <span class="lorebook-diff-meta-old">${CoreAPI.escapeHtml(m.localStr)}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="lorebook-diff-meta-new">${CoreAPI.escapeHtml(m.remoteStr)}</span>
            </div>`).join('')}
        </div>`;
    }

    // Entries that exist on remote but not locally — will be added
    for (const entry of added) {
        const name = lorebookEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        entriesHtml += `<div class="lorebook-diff-entry added" title="New entry from the remote card — will be added on apply">
            <span class="lorebook-diff-badge added">+</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            ${keys ? `<span class="lorebook-diff-entry-keys">${CoreAPI.escapeHtml(keys)}</span>` : ''}
            <span class="lorebook-diff-entry-tag added">new from remote</span>
        </div>`;
    }

    // Entries in embedded lorebook but not on remote — will be lost from embedded on apply
    for (const entry of localOnly) {
        const name = lorebookEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        const keysData = CoreAPI.escapeHtml(JSON.stringify(entry.keys || []));
        const nameData = CoreAPI.escapeHtml(entry.comment || entry.name || '');
        entriesHtml += `<div class="lorebook-diff-entry local-only" data-lb-keys="${keysData}" data-lb-name="${nameData}" title="This entry is in your embedded lorebook but not on the remote card. Applying will replace the embedded lorebook with the remote version, so this entry will be removed from the card.">
            <span class="lorebook-diff-badge local-only">&#9733;</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            ${keys ? `<span class="lorebook-diff-entry-keys">${CoreAPI.escapeHtml(keys)}</span>` : ''}
            <span class="lorebook-diff-entry-tag local-only">local-only</span>
            <span class="lorebook-world-check" title="Checking World Info file…"><i class="fa-solid fa-spinner fa-spin" style="font-size:10px; opacity:0.5;"></i></span>
        </div>`;
    }

    // Matched entries with field-level changes
    for (const m of modified) {
        const name = lorebookEntryName(m.remote);
        const changes = m.changedFields.join(', ');
        entriesHtml += `<div class="lorebook-diff-entry modified" title="Entry matched by key overlap — the following fields differ: ${CoreAPI.escapeHtml(changes)}">
            <span class="lorebook-diff-badge modified">~</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            <span class="lorebook-diff-entry-changes">${CoreAPI.escapeHtml(changes)}</span>
        </div>`;
    }

    const unchangedCount = matched.length - modified.length;
    if (unchangedCount > 0) {
        entriesHtml += `<div class="lorebook-diff-entry unchanged">
            <span class="lorebook-diff-unchanged-count">${unchangedCount} unchanged entr${unchangedCount === 1 ? 'y' : 'ies'}</span>
        </div>`;
    }



    return `
        <div class="card-update-diff-item long-text lorebook">
            <div class="card-update-diff-header">
                <label>
                    <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                    <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>
                    <span class="lorebook-entry-counts">
                        <span class="local-count">${localEntries.length}</span>
                        <i class="fa-solid fa-arrow-right"></i>
                        <span class="remote-count">${remoteEntries.length}</span>
                    </span>
                </label>
                <span class="card-update-diff-stats">${stats}</span>
                <button class="card-update-diff-expand" onclick="window.cardUpdatesToggleExpand(this)">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
            <div class="card-update-diff-content collapsed">
                <div class="lorebook-diff-entries">
                    ${entriesHtml}
                </div>
            </div>
        </div>
    `;
}

/**
 * Post-render: fetch the linked world file and update each local-only entry
 * row with a per-entry "safe in World Info" or "not in World Info" badge.
 */
async function resolveWorldFileStatus(containerEl, avatar) {
    if (!containerEl || !avatar) return;
    const rows = containerEl.querySelectorAll('.lorebook-diff-entry.local-only[data-lb-keys]');
    if (rows.length === 0) return;

    // Helper: clear spinners and mark all rows as "not in remote" (no world context found)
    const markAllNoWorld = (reason) => {
        for (const row of rows) {
            const check = row.querySelector('.lorebook-world-check');
            if (check) { check.innerHTML = ''; check.title = ''; }
            const tag = row.querySelector('.lorebook-diff-entry-tag');
            if (tag) tag.textContent = 'local-only · no World Info file';
            row.title = `This entry is in your embedded lorebook but not on the remote card. Applying will remove it from the card. ${reason}`;
        }
    };

    try {
        let worldName = CoreAPI.getCharacterWorldName(avatar);

        // Fallback: if the card has no stored world name, list all world files
        // and try to match by character name (ST often names the file after the char)
        if (!worldName) {
            const charObj = currentUpdateChecks.get(avatar)?.char;
            const charName = (charObj?.name || '').trim();
            if (charName) {
                const allWorlds = await CoreAPI.listWorldInfoFiles();
                const lower = charName.toLowerCase();
                worldName = allWorlds.find(w => w.toLowerCase() === lower)
                         || allWorlds.find(w => w.toLowerCase().includes(lower) || lower.includes(w.toLowerCase()))
                         || null;
            }
        }

        if (!worldName) {
            markAllNoWorld('No linked World Info file was found.');
            return;
        }

        let worldData;
        try {
            worldData = await CoreAPI.getWorldInfoData(worldName);
        } catch (_) { /* fetch failed */ }

        if (!worldData?.entries) {
            markAllNoWorld(`World Info file "${worldName}" could not be read.`);
            return;
        }

        const worldEntries = Object.values(worldData.entries).filter(e => e && typeof e === 'object');

        // Expand keys helper (handles comma-separated values inside key arrays)
        const expandKeys = (keys) => {
            const set = new Set();
            for (const k of (keys || [])) {
                for (const part of String(k).split(',')) {
                    const t = part.toLowerCase().trim();
                    if (t) set.add(t);
                }
            }
            return set;
        };

        for (const row of rows) {
            let entryKeys;
            try { entryKeys = JSON.parse(row.dataset.lbKeys || '[]'); } catch (_) { entryKeys = []; }
            const entryName = (row.dataset.lbName || '').toLowerCase().trim();
            const embeddedKeys = expandKeys(entryKeys);

            // Try to find a matching world entry by key overlap or name
            let found = false;
            for (const we of worldEntries) {
                const wKeys = expandKeys(we.key);
                // Key overlap check
                if (embeddedKeys.size > 0 && wKeys.size > 0) {
                    let inter = 0;
                    for (const k of embeddedKeys) { if (wKeys.has(k)) inter++; }
                    const union = new Set([...embeddedKeys, ...wKeys]).size;
                    if (union > 0 && (inter / union) > 0.3) { found = true; break; }
                }
                // Name/comment match
                const wName = (we.comment || '').toLowerCase().trim();
                if (entryName && wName && (entryName === wName || entryName.includes(wName) || wName.includes(entryName))) {
                    found = true; break;
                }
            }

            const check = row.querySelector('.lorebook-world-check');
            const tag = row.querySelector('.lorebook-diff-entry-tag');
            if (found) {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-shield-halved" style="color: #81c784; font-size: 11px;"></i>';
                    check.title = `Also exists in World Info file "${worldName}" — safe, won't be affected by applying`;
                }
                if (tag) tag.textContent = 'local-only · safe in World Info';
                row.title = `This entry is in your embedded lorebook but not on the remote. Applying removes it from the card, but it also exists in your World Info file "${worldName}" which is not affected.`;
            } else {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #ffb74d; font-size: 11px;"></i>';
                    check.title = `Not found in World Info file "${worldName}" — this entry only exists in the embedded lorebook and will be lost if you apply`;
                }
                if (tag) {
                    tag.textContent = 'local-only · not in World Info';
                    tag.classList.remove('local-only');
                    tag.classList.add('warning');
                }
                row.title = `This entry exists only in the embedded lorebook (not found in World Info file "${worldName}"). Applying will remove it from the card with no backup elsewhere.`;
            }
        }
    } catch (err) {
        console.error('[CardUpdates] resolveWorldFileStatus error:', err);
        markAllNoWorld('World Info check failed.');
    }
}

function lorebookEntryName(entry) {
    if (entry.comment?.trim()) return entry.comment.trim();
    if (entry.name?.trim()) return entry.name.trim();
    const keys = entry.keys || [];
    if (keys.length > 0) return keys.slice(0, 3).join(', ');
    return `Entry #${entry.id ?? '?'}`;
}

function matchLorebookEntries(localEntries, remoteEntries) {
    const matched = [];
    const unmatchedRemote = [...remoteEntries];
    const unmatchedLocal = [...localEntries];

    // Match entries by key overlap (Jaccard similarity)
    for (let i = unmatchedLocal.length - 1; i >= 0; i--) {
        let bestIdx = -1;
        let bestScore = 0;

        for (let j = 0; j < unmatchedRemote.length; j++) {
            const score = lorebookEntryMatchScore(unmatchedLocal[i], unmatchedRemote[j]);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = j;
            }
        }

        if (bestIdx >= 0 && bestScore > 0.3) {
            const changedFields = compareLorebookEntryFields(unmatchedLocal[i], unmatchedRemote[bestIdx]);
            matched.push({
                local: unmatchedLocal[i],
                remote: unmatchedRemote[bestIdx],
                changedFields
            });
            unmatchedLocal.splice(i, 1);
            unmatchedRemote.splice(bestIdx, 1);
        }
    }

    return { matched, added: unmatchedRemote, removed: unmatchedLocal };
}

function lorebookEntryMatchScore(a, b) {
    // Expand keys: split comma-separated strings into individual keys
    const expandKeys = (entry) => {
        const raw = entry.keys || [];
        const expanded = new Set();
        for (const k of raw) {
            for (const part of String(k).split(',')) {
                const trimmed = part.toLowerCase().trim();
                if (trimmed) expanded.add(trimmed);
            }
        }
        return expanded;
    };

    const aKeys = expandKeys(a);
    const bKeys = expandKeys(b);

    if (aKeys.size > 0 && bKeys.size > 0) {
        let intersection = 0;
        for (const k of aKeys) { if (bKeys.has(k)) intersection++; }
        const union = new Set([...aKeys, ...bKeys]).size;
        if (union > 0) {
            const jaccard = intersection / union;
            if (jaccard > 0) return jaccard;
        }
    }

    // Name/comment match (exact or substring)
    const aName = (a.comment || a.name || '').toLowerCase().trim();
    const bName = (b.comment || b.name || '').toLowerCase().trim();
    if (aName && bName) {
        if (aName === bName) return 1;
        if (aName.includes(bName) || bName.includes(aName)) return 0.8;
    }

    // Content similarity fallback — first 200 chars
    const aCont = (a.content || '').slice(0, 200).toLowerCase().trim();
    const bCont = (b.content || '').slice(0, 200).toLowerCase().trim();
    if (aCont.length > 20 && bCont.length > 20 && aCont === bCont) return 0.7;

    return 0;
}

function compareLorebookEntryFields(local, remote) {
    const changed = [];
    for (const f of LOREBOOK_ENTRY_FIELDS) {
        if (f === 'id' || f === 'name' || f === 'comment') continue;
        if (JSON.stringify(local[f] ?? null) !== JSON.stringify(remote[f] ?? null)) {
            changed.push(f);
        }
    }
    return changed;
}

const LOREBOOK_META_FIELDS = {
    name: 'Name',
    description: 'Description',
    scan_depth: 'Scan Depth',
    token_budget: 'Token Budget',
    recursive_scanning: 'Recursive Scanning',
};

// V2-spec entry fields — everything else (uid, display_index, vectorized, etc.) is ST-internal
const LOREBOOK_ENTRY_FIELDS = [
    'keys', 'secondary_keys', 'content', 'enabled', 'selective',
    'constant', 'position', 'insertion_order', 'priority', 'case_sensitive',
    'name', 'comment', 'id'
];

function normalizeLorebookEntry(entry) {
    const out = {};
    for (const f of LOREBOOK_ENTRY_FIELDS) {
        if (entry[f] !== undefined) out[f] = entry[f];
    }
    return out;
}

// ========================================
// WORLD INFO ↔ V2 FORMAT CONVERSION
// ========================================
//
// How SillyTavern's lorebook storage works:
//
//   character_book (in card PNG)  — Snapshot created at import time. ST does NOT
//                                   re-embed /worlds data on normal saves.
//
//   /worlds/{name}.json           — The live working copy. All edits in ST's
//                                   World Info editor go here. Linked via
//                                   char.data.extensions.world.
//
// The two copies diverge independently after import.
//
// Our approach:
//   - CHECK: Always compare character_book (embedded) against Chub remote.
//     World files are never read for diff purposes.
//   - APPLY: Write Chub's lorebook to character_book (clean mirror).
//     World files are never modified by the update checker.
//   - If local-only entries would be lost from the embedded lorebook,
//     the diff UI checks for a linked world file and reassures the user
//     that their World Info entries are unaffected.
//

function lorebooksEqual(a, b) {
    const aEntries = a?.entries || [];
    const bEntries = b?.entries || [];
    const aEmpty = aEntries.length === 0;
    const bEmpty = bEntries.length === 0;
    if (aEmpty && bEmpty) return true;

    // Compare meta
    for (const key of Object.keys(LOREBOOK_META_FIELDS)) {
        if (JSON.stringify(a?.[key] ?? null) !== JSON.stringify(b?.[key] ?? null)) return false;
    }

    // Compare entries (order-sensitive by spec)
    if (aEntries.length !== bEntries.length) return false;
    for (let i = 0; i < aEntries.length; i++) {
        const na = normalizeLorebookEntry(aEntries[i]);
        const nb = normalizeLorebookEntry(bEntries[i]);
        if (JSON.stringify(na) !== JSON.stringify(nb)) return false;
    }
    return true;
}

function hasRemoteLorebookMeta(book) {
    if (!book) return false;
    return Object.keys(LOREBOOK_META_FIELDS).some(k => book[k] != null);
}

function compareLorebookMeta(localBook, remoteBook) {
    const diffs = [];
    for (const [key, label] of Object.entries(LOREBOOK_META_FIELDS)) {
        const lv = localBook?.[key];
        const rv = remoteBook?.[key];
        if (JSON.stringify(lv ?? null) !== JSON.stringify(rv ?? null)) {
            diffs.push({
                key,
                label,
                localStr: lv == null ? '(not set)' : typeof lv === 'object' ? JSON.stringify(lv) : String(lv),
                remoteStr: rv == null ? '(not set)' : typeof rv === 'object' ? JSON.stringify(rv) : String(rv)
            });
        }
    }
    return diffs;
}

function renderArrayList(values, field, otherSide = null) {
    if (!values || values.length === 0) {
        return '<div class="card-update-array-list"><span class="card-update-empty">(empty)</span></div>';
    }
    // Build a Set of normalized values from the other side for highlighting
    const otherSet = otherSide ? new Set(otherSide.map(v =>
        (typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase().trim()
    )) : null;
    const items = values.map(value => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        let classes = field === 'tags' ? 'card-update-pill tag' : 'card-update-pill';
        // Highlight items that exist only on this side (not in the other)
        if (otherSet && !otherSet.has(text.toLowerCase().trim())) {
            classes += ' card-update-pill-unique';
        }
        return `<span class="${classes}">${CoreAPI.escapeHtml(text)}</span>`;
    }).join('');

    return `<div class="card-update-array-list">${items}</div>`;
}

/**
 * Format a value for display
 * @param {*} value - Value to format
 * @returns {string} Display string
 */
function formatValueForDisplay(value) {
    if (value === null || value === undefined) return '(empty)';
    if (Array.isArray(value)) {
        if (value.length === 0) return '(empty array)';
        return value.map((v, i) => `[${i + 1}] ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    }
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    if (typeof value === 'string' && value.trim() === '') return '(empty)';
    return String(value);
}

/**
 * Truncate a string
 * @param {string} str - String to truncate
 * @param {number} max - Max length
 * @returns {string} Truncated string
 */
function truncate(str, max) {
    if (str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
}

// ========================================
// BATCH CHECK
// ========================================

/**
 * Show batch check modal
 * @param {Array} characters - Characters to check
 */
function showBatchCheckModal(characters) {
    const modal = document.getElementById('cardUpdateBatchModal');
    const countEl = document.getElementById('cardUpdateBatchCount');
    const listEl = document.getElementById('cardUpdateBatchList');
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    const actionsEl = document.getElementById('cardUpdateBatchActions');
    const fieldSelectEl = document.getElementById('cardUpdateBatchFieldSelect');
    const fieldGridEl = document.getElementById('cardUpdateBatchFieldGrid');
    const fieldCountEl = document.getElementById('cardUpdateBatchFieldCount');
    const startBtn = document.getElementById('cardUpdateBatchStartBtn');
    
    countEl.textContent = characters.length;
    progressEl.innerHTML = '';
    actionsEl.style.display = 'none';
    currentUpdateChecks.clear();
    pendingBatchCharacters = characters;
    
    // Build field selection
    if (fieldGridEl) {
        fieldGridEl.innerHTML = Object.entries(COMPARABLE_FIELDS).map(([field, label]) => {
            const isChecked = batchFieldSelection.has(field);
            return `
                <label class="card-update-field-option">
                    <input type="checkbox" data-field="${field}" ${isChecked ? 'checked' : ''}>
                    <span class="card-update-field-label">${CoreAPI.escapeHtml(label)}</span>
                </label>
            `;
        }).join('');
    }

    if (fieldCountEl) {
        fieldCountEl.textContent = `${batchFieldSelection.size}/${Object.keys(COMPARABLE_FIELDS).length}`;
    }

    if (fieldSelectEl) fieldSelectEl.classList.remove('hidden');
    listEl.classList.add('hidden');
    progressEl.classList.add('hidden');
    
    // Reset state
    batchCheckPaused = false;
    batchCheckRunning = false;
    batchCheckedCount = 0;
    updateBatchFooter('idle');
    updateSourceBadge(modal);
    
    modal.classList.add('visible');
}

/**
 * Perform batch update check
 * @param {Array} characters - Characters to check
 */
async function performBatchCheck(characters, allowedFields, startFrom = 0) {
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    
    abortController = new AbortController();
    batchCheckRunning = true;
    batchCheckPaused = false;
    updateBatchFooter('checking');
    
    let withUpdates = currentUpdateChecks.size;
    let errors = 0;
    
    for (let i = startFrom; i < characters.length; i++) {
        if (abortController.signal.aborted || batchCheckPaused) break;
        
        const char = characters[i];
        const itemEl = document.querySelector(`.card-update-batch-item[data-avatar="${CSS.escape(char.avatar)}"]`);
        const statusEl = itemEl?.querySelector('.card-update-batch-item-status');
        
        // Skip already-checked items
        const curStatus = statusEl?.textContent?.trim() || '';
        if (curStatus.includes('Up to date') || curStatus.includes('update') || 
            curStatus.includes('Updated') || curStatus.includes('Failed') || curStatus.includes('Error')) {
            continue;
        }
        
        if (statusEl) {
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        }
        
        try {
            const chubInfo = getChubLinkInfo(char);
            const remoteCard = await fetchRemoteCard(chubInfo.fullPath);
            
            if (!remoteCard) {
                if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Failed';
                errors++;
            } else {
                const localData = char.data || char;

                const diffs = compareCards(localData, remoteCard, allowedFields);
                
                if (diffs.length === 0) {
                    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-check" style="color: var(--success-color, #4caf50);"></i> Up to date';
                } else {
                    if (statusEl) {
                        statusEl.innerHTML = `
                            <span class="has-updates">${diffs.length} update${diffs.length > 1 ? 's' : ''}</span>
                            <button class="card-update-batch-view-btn" data-view-avatar="${CoreAPI.escapeHtml(char.avatar)}">
                                View
                            </button>
                        `;
                    }
                    currentUpdateChecks.set(char.avatar, { char, localData, remoteCard, diffs });
                    withUpdates++;
                }
            }
        } catch (error) {
            console.error('[CardUpdates] Batch check error for:', char.avatar, error);
            if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> Error';
            errors++;
        }
        
        batchCheckedCount++;
        progressEl.innerHTML = `Checked ${batchCheckedCount}/${characters.length}`;
        updateBatchFooter('checking');
    }
    
    batchCheckRunning = false;
    
    if (batchCheckPaused) {
        progressEl.innerHTML = `Paused — Checked ${batchCheckedCount}/${characters.length}`;
        updateBatchFooter('paused');
    } else {
        progressEl.innerHTML = `Done! ${withUpdates} with updates, ${errors} error${errors !== 1 ? 's' : ''}`;
        updateBatchFooter('done');
    }
}

/**
 * View diffs for a character from batch view
 * @param {string} avatar - Character avatar
 */
function viewBatchItemDiffs(avatar) {
    const checkData = currentUpdateChecks.get(avatar);
    if (!checkData) return;
    
    // Show in single modal overlaid
    const { char, diffs } = checkData;
    showSingleCheckModal(char);
    
    const statusEl = document.getElementById('cardUpdateSingleStatus');
    const contentEl = document.getElementById('cardUpdateSingleContent');
    const applyBtn = document.getElementById('cardUpdateSingleApplyBtn');
    
    statusEl.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left"></i> Found ${diffs.length} difference${diffs.length > 1 ? 's' : ''}`;
    contentEl.innerHTML = renderDiffList(diffs);
    resolveWorldFileStatus(contentEl, checkData.char?.avatar).catch(e => console.error('[CardUpdates] World status check failed:', e));
    applyBtn.disabled = false;
}

// ========================================
// APPLY UPDATES
// ========================================

/**
 * Apply selected updates for a single character
 */
async function applySingleUpdates() {
    const modal = document.getElementById('cardUpdateSingleModal');
    const checkboxes = modal.querySelectorAll('.card-update-diff-item input[type="checkbox"]:checked');
    
    if (checkboxes.length === 0) {
        CoreAPI.showToast('No updates selected', 'warning');
        return;
    }
    
    // Retrieve avatar from JS variable (not from HTML) to avoid special-character issues
    const avatar = singleModalAvatar;
    const checkData = avatar ? currentUpdateChecks.get(avatar) : null;
    if (!checkData) return;
    
    const { char, diffs, remoteCard } = checkData;
    const remoteData = remoteCard?.data || remoteCard;
    
    // Build updated data object
    const updatedFields = {};
    checkboxes.forEach(cb => {
        const field = cb.dataset.field;
        const remoteValue = getNestedValue(remoteData, field);
        // null means "clear this field" — undefined would be silently dropped by JSON
        updatedFields[field] = remoteValue ?? null;
    });
    
    // Apply via CoreAPI
    try {
        // Auto-snapshot before update
        if (window.autoSnapshotBeforeChange) {
            try { await window.autoSnapshotBeforeChange(char, 'update'); } catch (_) {}
        }
        const success = await CoreAPI.applyCardFieldUpdates(char.avatar, updatedFields);
        
        if (success) {
            CoreAPI.showToast(`Updated ${checkboxes.length} field${checkboxes.length > 1 ? 's' : ''}`, 'success');
            closeSingleModal();
            
            // Update batch list if visible
            const batchItem = document.querySelector(`.card-update-batch-item[data-avatar="${CSS.escape(avatar)}"]`);
            if (batchItem) {
                const statusEl = batchItem.querySelector('.card-update-batch-item-status');
                if (statusEl) {
                    statusEl.innerHTML = '<i class="fa-solid fa-check" style="color: var(--success-color, #4caf50);"></i> Updated';
                }
            }
            
            currentUpdateChecks.delete(avatar);
        } else {
            CoreAPI.showToast('Failed to apply updates', 'error');
        }
    } catch (error) {
        console.error('[CardUpdates] Apply failed:', error);
        CoreAPI.showToast('Error applying updates', 'error');
    }
}

/**
 * Apply all updates to all characters with diffs
 */
async function applyAllBatchUpdates() {
    const entries = Array.from(currentUpdateChecks.entries());
    if (entries.length === 0) {
        CoreAPI.showToast('No updates to apply', 'info');
        return;
    }
    const progressWrap = document.getElementById('cardUpdateBatchApplyProgress');
    const progressText = document.getElementById('cardUpdateBatchApplyText');
    const progressFill = document.getElementById('cardUpdateBatchApplyFill');
    const actionsEl = document.getElementById('cardUpdateBatchActions');
    if (actionsEl) actionsEl.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'flex';
    if (progressFill) progressFill.style.width = '0%';

    let successCount = 0;
    let errorCount = 0;
    let processed = 0;
    const total = entries.length;
    
    for (const [avatar, checkData] of entries) {
        const { char, diffs, remoteCard } = checkData;
        const remoteData = remoteCard?.data || remoteCard;
        
        // Apply all diffs for this character
        const updatedFields = {};
        for (const diff of diffs) {
            const remoteValue = getNestedValue(remoteData, diff.field);
            updatedFields[diff.field] = remoteValue ?? null;
        }
        
        try {
            // Auto-snapshot before batch update
            if (window.autoSnapshotBeforeChange) {
                try { await window.autoSnapshotBeforeChange(char, 'update'); } catch (_) {}
            }
            const success = await CoreAPI.applyCardFieldUpdates(avatar, updatedFields);
            
            if (success) {
                successCount++;
                
                // Update batch list
                const batchItem = document.querySelector(`.card-update-batch-item[data-avatar="${CSS.escape(avatar)}"]`);
                if (batchItem) {
                    const statusEl = batchItem.querySelector('.card-update-batch-item-status');
                    if (statusEl) {
                        statusEl.innerHTML = '<i class="fa-solid fa-check" style="color: var(--success-color, #4caf50);"></i> Updated';
                    }
                }
            } else {
                errorCount++;
            }
        } catch (error) {
            console.error('[CardUpdates] Batch apply error for:', avatar, error);
            errorCount++;
        }

        processed++;
        const percent = Math.round((processed / total) * 100);
        if (progressText) {
            progressText.textContent = `Applying updates... ${processed}/${total}`;
        }
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
    }
    
    currentUpdateChecks.clear();
    
    CoreAPI.showToast(`Updated ${successCount} character${successCount !== 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 
        errorCount > 0 ? 'warning' : 'success');
    
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    
    // Update footer: if we were paused and unchecked characters remain, show resume; otherwise done
    if (batchCheckPaused && batchCheckedCount < pendingBatchCharacters.length) {
        updateBatchFooter('paused');
    } else {
        updateBatchFooter('done');
    }
}

// ========================================
// MODAL MANAGEMENT
// ========================================

function closeSingleModal() {
    singleModalAvatar = null;
    document.getElementById('cardUpdateSingleModal')?.classList.remove('visible');
}

/**
 * Show or refresh the API source badge in a modal header.
 */
function updateSourceBadge(modal) {
    const header = modal?.querySelector('.cl-modal-header');
    if (!header) return;
    let badge = header.querySelector('.card-update-source-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'card-update-source-badge';
        header.querySelector('h3')?.appendChild(badge);
    }
    const useV4 = CoreAPI.getSetting('chubUseV4Api') || false;
    badge.textContent = useV4 ? 'V4 Git API' : 'Metadata API';
    badge.title = useV4
        ? 'Fetching the exported card.json from Chub\u2019s Git repository. Matches version history source. Change in Settings \u2192 ChubAI.'
        : 'Fetching from Chub\u2019s metadata API \u2014 same source as imports. Change in Settings \u2192 ChubAI.';
}

function closeBatchModal() {
    abortController?.abort();
    batchCheckPaused = false;
    batchCheckRunning = false;
    batchCheckedCount = 0;
    document.getElementById('cardUpdateBatchModal')?.classList.remove('visible');
    currentUpdateChecks.clear();
    pendingBatchCharacters = [];
}

/**
 * Pause the currently running batch check
 */
function pauseBatchCheck() {
    if (!batchCheckRunning) return;
    batchCheckPaused = true;
    abortController?.abort();
}

/**
 * Resume a paused batch check
 */
function resumeBatchCheck() {
    if (!batchCheckPaused || batchCheckRunning) return;
    performBatchCheck(pendingBatchCharacters, new Set(batchFieldSelection), 0);
}

/**
 * Update the batch modal footer buttons based on state
 * @param {'idle'|'checking'|'paused'|'done'} state
 */
function updateBatchFooter(state) {
    const startBtn = document.getElementById('cardUpdateBatchStartBtn');
    const pauseBtn = document.getElementById('cardUpdateBatchPauseBtn');
    const applyBtn = document.getElementById('cardUpdateBatchApplyAllBtn');
    const closeBtn = document.getElementById('cardUpdateBatchCloseFooterBtn');
    const actionsWrap = document.getElementById('cardUpdateBatchActions');
    
    // Update apply button count
    const updateCount = currentUpdateChecks.size;
    if (applyBtn) {
        applyBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Apply All ${updateCount} Update${updateCount !== 1 ? 's' : ''}`;
    }
    
    switch (state) {
        case 'idle':
            if (startBtn) { startBtn.style.display = ''; startBtn.disabled = false; }
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (actionsWrap) actionsWrap.style.display = 'none';
            if (closeBtn) closeBtn.style.display = '';
            break;
        case 'checking':
            if (startBtn) startBtn.style.display = 'none';
            if (pauseBtn) {
                pauseBtn.style.display = '';
                pauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
                pauseBtn.classList.remove('resume');
                pauseBtn.classList.add('pause');
            }
            if (actionsWrap) actionsWrap.style.display = 'none';
            if (closeBtn) closeBtn.style.display = '';
            break;
        case 'paused':
            if (startBtn) startBtn.style.display = 'none';
            if (pauseBtn) {
                pauseBtn.style.display = '';
                pauseBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
                pauseBtn.classList.remove('pause');
                pauseBtn.classList.add('resume');
            }
            if (actionsWrap) actionsWrap.style.display = updateCount > 0 ? 'flex' : 'none';
            if (closeBtn) closeBtn.style.display = '';
            break;
        case 'done':
            if (startBtn) startBtn.style.display = 'none';
            if (pauseBtn) pauseBtn.style.display = 'none';
            if (actionsWrap) actionsWrap.style.display = updateCount > 0 ? 'flex' : 'none';
            if (closeBtn) closeBtn.style.display = '';
            break;
    }
}

function updateBatchFieldCount() {
    const fieldCountEl = document.getElementById('cardUpdateBatchFieldCount');
    if (!fieldCountEl) return;
    fieldCountEl.textContent = `${batchFieldSelection.size}/${Object.keys(COMPARABLE_FIELDS).length}`;
}

function handleBatchFieldSelectionChange(e) {
    const checkbox = e.target.closest('input[type="checkbox"][data-field]');
    if (!checkbox) return;
    const field = checkbox.dataset.field;
    if (!field) return;
    if (checkbox.checked) {
        batchFieldSelection.add(field);
    } else {
        batchFieldSelection.delete(field);
    }
    updateBatchFieldCount();
}

function setBatchFieldsChecked(checked) {
    const grid = document.getElementById('cardUpdateBatchFieldGrid');
    if (!grid) return;
    const checkboxes = grid.querySelectorAll('input[type="checkbox"][data-field]');
    batchFieldSelection.clear();
    checkboxes.forEach(cb => {
        cb.checked = checked;
        if (checked) batchFieldSelection.add(cb.dataset.field);
    });
    updateBatchFieldCount();
}

function startBatchCheck() {
    if (!pendingBatchCharacters || pendingBatchCharacters.length === 0) return;
    if (batchFieldSelection.size === 0) {
        CoreAPI.showToast('Select at least one field to compare', 'warning');
        return;
    }

    const listEl = document.getElementById('cardUpdateBatchList');
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    const fieldSelectEl = document.getElementById('cardUpdateBatchFieldSelect');

    // Reset counters
    batchCheckedCount = 0;
    currentUpdateChecks.clear();

    // Build initial list
    listEl.innerHTML = pendingBatchCharacters.map(char => {
        const chubInfo = getChubLinkInfo(char);
        const name = char.data?.name || char.name || 'Unknown';
        return `
            <div class="card-update-batch-item" data-avatar="${CoreAPI.escapeHtml(char.avatar)}">
                <div class="card-update-batch-item-info">
                    <span class="card-update-batch-item-name card-update-char-link" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}">${CoreAPI.escapeHtml(name)}</span>
                    <span class="card-update-batch-item-path">${CoreAPI.escapeHtml(chubInfo?.fullPath || '')}</span>
                </div>
                <div class="card-update-batch-item-status">
                    <i class="fa-solid fa-clock"></i> Pending
                </div>
            </div>
        `;
    }).join('');

    if (fieldSelectEl) fieldSelectEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    progressEl.classList.remove('hidden');

    performBatchCheck(pendingBatchCharacters, new Set(batchFieldSelection), 0);
}

// ========================================
// UI HELPERS (exposed to window)
// ========================================

/**
 * Toggle all checkboxes for a character's diffs
 */
function toggleAllCheckboxes(checked) {
    const modal = document.getElementById('cardUpdateSingleModal');
    modal.querySelectorAll(`.card-update-diff-item input[type="checkbox"]`).forEach(cb => {
        cb.checked = checked;
    });
}

/**
 * Toggle expand/collapse of a diff item
 */
function toggleExpand(button) {
    const content = button.closest('.card-update-diff-item').querySelector('.card-update-diff-content');
    const icon = button.querySelector('i');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        icon.classList.remove('fa-chevron-down');
        icon.classList.add('fa-chevron-up');
    } else {
        content.classList.add('collapsed');
        icon.classList.remove('fa-chevron-up');
        icon.classList.add('fa-chevron-down');
    }
}

// ========================================
// EVENT LISTENERS
// ========================================

function setupEventListeners() {
    // Close buttons
    document.getElementById('cardUpdateSingleCloseBtn')?.addEventListener('click', closeSingleModal);
    document.getElementById('cardUpdateBatchCloseBtn')?.addEventListener('click', closeBatchModal);
    document.getElementById('cardUpdateBatchCloseFooterBtn')?.addEventListener('click', closeBatchModal);
    
    // Apply buttons
    document.getElementById('cardUpdateSingleApplyBtn')?.addEventListener('click', applySingleUpdates);
    document.getElementById('cardUpdateBatchApplyAllBtn')?.addEventListener('click', applyAllBatchUpdates);
    document.getElementById('cardUpdateBatchStartBtn')?.addEventListener('click', startBatchCheck);
    
    // Pause/Resume button
    document.getElementById('cardUpdateBatchPauseBtn')?.addEventListener('click', () => {
        if (batchCheckRunning && !batchCheckPaused) {
            pauseBatchCheck();
        } else if (batchCheckPaused && !batchCheckRunning) {
            resumeBatchCheck();
        }
    });
    
    // Close on backdrop click
    document.getElementById('cardUpdateSingleModal')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('cl-modal-overlay')) closeSingleModal();
    });
    document.getElementById('cardUpdateBatchModal')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('cl-modal-overlay')) closeBatchModal();
    });
    
    // Expose UI helpers to window
    window.cardUpdatesToggleAll = toggleAllCheckboxes;
    window.cardUpdatesToggleExpand = toggleExpand;

    // Event delegation for batch list: View buttons and character name clicks
    const batchListEl = document.getElementById('cardUpdateBatchList');
    batchListEl?.addEventListener('click', (e) => {
        const viewBtn = e.target.closest('.card-update-batch-view-btn');
        if (viewBtn) {
            const avatar = viewBtn.dataset.viewAvatar;
            if (avatar) viewBatchItemDiffs(avatar);
            return;
        }
        const nameLink = e.target.closest('.card-update-char-link[data-char-avatar]');
        if (nameLink) {
            const avatar = nameLink.dataset.charAvatar;
            if (!avatar) return;
            const allChars = CoreAPI.getAllCharacters();
            const char = allChars.find(c => c.avatar === avatar);
            if (char) openCharModalAbove(char);
        }
    });

    // Batch field selection
    document.getElementById('cardUpdateBatchFieldGrid')?.addEventListener('change', handleBatchFieldSelectionChange);
    document.getElementById('cardUpdateBatchFieldSelectAll')?.addEventListener('click', () => setBatchFieldsChecked(true));
    document.getElementById('cardUpdateBatchFieldSelectNone')?.addEventListener('click', () => setBatchFieldsChecked(false));
}

// ========================================
// STYLES
// ========================================

function injectStyles() {
    if (document.getElementById('card-updates-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'card-updates-styles';
    style.textContent = `
        /* Card Updates Modal - Override base modal */
        .card-update-modal {
            background: transparent !important;
        }
        
        /* Ensure single modal appears above batch modal when opened from batch view */
        #cardUpdateBatchModal {
            z-index: 10000;
        }
        
        #cardUpdateSingleModal {
            z-index: 10001;
        }

        /* When character details is opened above update checker */
        body.char-modal-above .modal-overlay {
            z-index: 10002 !important;
        }
        body.char-modal-above .confirm-modal:not(.hidden) {
            z-index: 10003 !important;
        }
        body.char-modal-above .gv-modal.visible {
            z-index: 10004 !important;
        }
        
        .card-update-modal .cl-modal-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(4px);
        }
        
        .card-update-modal .cl-modal-content {
            position: relative;
            z-index: 1;
            max-width: 750px;
            width: 95%;
            background: var(--cl-glass-bg, rgba(30, 30, 30, 0.98));
            border: 1px solid var(--cl-border, rgba(80, 80, 80, 0.5));
        }
        
        .card-update-modal .cl-modal-body {
            max-height: 65vh;
            overflow-y: auto;
        }

        .card-update-batch-list.hidden,
        .card-update-batch-progress.hidden {
            display: none;
        }
        
        /* Status line */
        .card-update-status {
            padding: 12px 16px;
            background: var(--cl-glass-bg, rgba(40, 40, 40, 0.9));
            border: 1px solid var(--cl-border, rgba(80, 80, 80, 0.4));
            border-radius: 8px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .card-update-status i {
            font-size: 1.1em;
        }
        
        /* Diff list */
        .card-update-diff-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .card-update-select-all {
            padding: 8px 12px;
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--cl-border, rgba(80,80,80,0.3));
            border-radius: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-weight: 500;
        }
        
        /* Diff item */
        .card-update-diff-item {
            border: 1px solid var(--cl-border, rgba(80,80,80,0.4));
            border-radius: 8px;
            overflow: hidden;
            background: rgba(0,0,0,0.2);
        }
        
        .card-update-diff-item.short {
            padding: 10px 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }
        
        .card-update-diff-item.short label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            flex-shrink: 0;
        }
        
        .card-update-diff-values {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
            overflow: hidden;
        }
        
        .card-update-diff-values .local-value {
            background: rgba(244, 67, 54, 0.2);
            color: #ff8a80;
            text-decoration: line-through;
            padding: 2px 6px;
            border-radius: 3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 150px;
        }
        
        .card-update-diff-values .remote-value {
            background: rgba(76, 175, 80, 0.2);
            color: #b9f6ca;
            padding: 2px 6px;
            border-radius: 3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 150px;
        }
        
        .card-update-diff-values i {
            color: var(--cl-text-secondary, #aaa);
            flex-shrink: 0;
            opacity: 0.7;
        }

        .card-update-array-diff {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            width: 100%;
        }

        .card-update-array-column {
            padding: 10px;
            border-radius: 8px;
            border: 1px solid var(--cl-border, rgba(80,80,80,0.35));
            background: rgba(0,0,0,0.2);
            min-width: 0;
        }

        .card-update-array-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.8em;
            color: var(--cl-text-secondary, #aaa);
            margin-bottom: 8px;
        }

        .card-update-array-count {
            padding: 2px 6px;
            border-radius: 999px;
            background: rgba(255,255,255,0.08);
            font-size: 0.85em;
        }

        .card-update-array-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            max-height: 140px;
            overflow: auto;
        }

        .card-update-pill {
            display: inline-flex;
            align-items: center;
            padding: 3px 8px;
            border-radius: 999px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.12);
            font-size: 0.8em;
        }

        .card-update-pill.tag {
            color: var(--cl-accent, #4a9eff);
            border-color: rgba(74, 158, 255, 0.4);
            background: rgba(74, 158, 255, 0.12);
        }

        /* Highlight items unique to one side (added/removed) */
        .card-update-array-column.local .card-update-pill-unique {
            border-color: rgba(255, 80, 80, 0.6);
            background: rgba(255, 80, 80, 0.15);
            color: #ff6b6b;
        }
        .card-update-array-column.remote .card-update-pill-unique {
            border-color: rgba(80, 200, 80, 0.6);
            background: rgba(80, 200, 80, 0.15);
            color: #5ec85e;
        }

        .card-update-empty {
            color: var(--cl-text-secondary, #888);
            font-size: 0.85em;
        }
        
        /* Long text diff item */
        .card-update-diff-item.long-text .card-update-diff-header {
            padding: 10px 12px;
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(255,255,255,0.03);
        }
        
        .card-update-diff-item.long-text label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            flex-shrink: 0;
        }
        
        .card-update-diff-stats {
            font-size: 0.8em;
            color: var(--cl-text-secondary, #999);
            flex: 1;
            text-align: right;
            padding-right: 8px;
        }
        
        .card-update-diff-expand {
            background: none;
            border: none;
            color: var(--cl-text-secondary, #999);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            transition: background 0.15s, color 0.15s;
            flex-shrink: 0;
        }
        
        .card-update-diff-expand:hover {
            color: var(--cl-text-primary, #fff);
            background: rgba(255,255,255,0.1);
        }
        
        .card-update-diff-content {
            border-top: 1px solid var(--cl-border, rgba(80,80,80,0.3));
        }
        
        .card-update-diff-content.collapsed {
            display: none;
        }
        
        /* Side-by-side diff view */
        .card-update-diff-sidebyside {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0;
        }
        
        .card-update-diff-panel {
            display: flex;
            flex-direction: column;
            min-width: 0;
        }
        
        .card-update-diff-panel.local {
            border-right: 1px solid var(--cl-border, rgba(80,80,80,0.3));
        }
        
        .card-update-source-badge {
            display: inline-block;
            font-size: 0.6rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 2px 7px;
            margin-left: 8px;
            border-radius: 4px;
            vertical-align: middle;
            background: rgba(var(--cl-accent-rgb, 74,158,255), 0.12);
            color: var(--cl-accent, #4a9eff);
            border: 1px solid rgba(var(--cl-accent-rgb, 74,158,255), 0.25);
            cursor: help;
        }

        .card-update-diff-panel-header {
            padding: 8px 12px;
            font-size: 0.75em;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .card-update-diff-panel.local .card-update-diff-panel-header {
            background: rgba(244, 67, 54, 0.1);
            color: #ff8a80;
            border-bottom: 2px solid #f44336;
        }
        
        .card-update-diff-panel.remote .card-update-diff-panel-header {
            background: rgba(76, 175, 80, 0.1);
            color: #b9f6ca;
            border-bottom: 2px solid #4caf50;
        }
        
        .card-update-diff-panel-content {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 0.82em;
            line-height: 1.6;
            max-height: 300px;
            overflow-y: auto;
            background: rgba(0,0,0,0.2);
        }
        
        .card-update-diff-panel-content .diff-line {
            padding: 2px 10px;
            white-space: pre-wrap;
            word-break: break-word;
            min-height: 1.6em;
            border-left: 3px solid transparent;
        }
        
        .card-update-diff-panel-content .diff-line.empty {
            background: rgba(128,128,128,0.1);
            border-left-color: rgba(128,128,128,0.3);
        }
        
        .card-update-diff-panel.local .diff-line.changed,
        .card-update-diff-panel.local .diff-line.removed {
            background: rgba(244, 67, 54, 0.15);
            border-left-color: #f44336;
        }
        
        .card-update-diff-panel.remote .diff-line.changed,
        .card-update-diff-panel.remote .diff-line.added {
            background: rgba(76, 175, 80, 0.15);
            border-left-color: #4caf50;
        }
        
        /* Word-level highlighting within side-by-side panels */
        .diff-line .word-removed {
            background: rgba(244, 67, 54, 0.5);
            color: #ffcdd2;
            text-decoration: line-through;
            text-decoration-color: rgba(255, 205, 210, 0.7);
            border-radius: 2px;
            padding: 1px 3px;
            margin: 0 1px;
        }
        
        .diff-line .word-added {
            background: rgba(76, 175, 80, 0.5);
            color: #c8e6c9;
            border-radius: 2px;
            padding: 1px 3px;
            margin: 0 1px;
        }
        
        /* Batch modal */
        .card-update-batch-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
            max-height: 50vh;
            overflow-y: auto;
        }
        
        .card-update-batch-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            background: rgba(0,0,0,0.2);
            border: 1px solid var(--cl-border, rgba(80,80,80,0.3));
            border-radius: 6px;
            gap: 12px;
        }
        
        .card-update-batch-item-info {
            display: flex;
            flex-direction: column;
            min-width: 0;
            flex: 1;
        }
        
        .card-update-batch-item-name {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .card-update-char-link {
            cursor: pointer;
            color: var(--cl-accent, #4a9eff);
        }
        .card-update-char-link:hover {
            text-decoration: underline;
        }
        
        .card-update-batch-item-path {
            font-size: 0.8em;
            color: var(--cl-text-secondary, #999);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .card-update-batch-item-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
            flex-shrink: 0;
        }
        
        .card-update-batch-item-status .has-updates {
            color: #b9f6ca;
            background: rgba(76, 175, 80, 0.2);
            padding: 2px 8px;
            border-radius: 4px;
            font-weight: 500;
        }
        
        .card-update-batch-view-btn {
            padding: 4px 10px;
            background: var(--cl-accent, #4a9eff);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
            transition: filter 0.15s;
        }
        
        .card-update-batch-view-btn:hover {
            filter: brightness(1.15);
        }
        
        .card-update-batch-progress {
            padding: 10px;
            text-align: center;
            color: var(--cl-text-secondary, #999);
        }
        
        .card-update-batch-actions {
            display: flex;
            justify-content: center;
            gap: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--cl-border, rgba(80,80,80,0.4));
            margin-top: 12px;
        }

        /* Pause / Resume button */
        .card-update-pause-btn {
            transition: background-color 0.2s ease, border-color 0.2s ease;
        }
        .card-update-pause-btn.pause {
            background: rgba(255, 152, 0, 0.2);
            border: 1px solid rgba(255, 152, 0, 0.45);
            color: #ffcc80;
        }
        .card-update-pause-btn.pause:hover {
            background: rgba(255, 152, 0, 0.35);
        }
        .card-update-pause-btn.resume {
            background: rgba(76, 175, 80, 0.2);
            border: 1px solid rgba(76, 175, 80, 0.45);
            color: #a5d6a7;
        }
        .card-update-pause-btn.resume:hover {
            background: rgba(76, 175, 80, 0.35);
        }

        .card-update-apply-progress {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px;
            border-radius: 10px;
            border: 1px solid rgba(74, 158, 255, 0.3);
            background: rgba(74, 158, 255, 0.08);
            margin-bottom: 10px;
        }

        .card-update-apply-text {
            font-size: 0.9rem;
            color: var(--cl-text-primary, #eee);
        }

        .card-update-apply-bar {
            width: 100%;
            height: 8px;
            border-radius: 999px;
            background: rgba(255,255,255,0.1);
            overflow: hidden;
        }

        .card-update-apply-fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, rgba(74, 158, 255, 0.8), rgba(99, 102, 241, 0.9));
            transition: width 0.2s ease;
        }

        .card-update-field-select {
            padding: 14px;
            border: 1px solid rgba(90, 120, 180, 0.35);
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(30, 40, 70, 0.4), rgba(20, 20, 30, 0.6));
            margin-bottom: 16px;
            box-shadow: inset 0 0 0 1px rgba(74, 158, 255, 0.08);
        }

        .card-update-field-select.hidden {
            display: none;
        }

        .card-update-field-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }

        .card-update-field-title {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .card-update-field-title i {
            color: var(--cl-accent, #4a9eff);
            font-size: 1.1rem;
        }

        .card-update-field-heading {
            font-weight: 600;
        }

        .card-update-field-sub {
            font-size: 0.85rem;
            color: rgba(255, 255, 255, 0.65);
        }

        .card-update-field-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .card-update-field-count {
            font-size: 0.85rem;
            color: rgba(255, 255, 255, 0.75);
            padding: 4px 8px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
        }

        .card-update-field-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 8px;
        }

        .card-update-field-option {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .card-update-field-option:hover {
            border-color: rgba(74, 158, 255, 0.4);
            background: rgba(74, 158, 255, 0.08);
        }

        .card-update-field-option input {
            accent-color: var(--cl-accent, #4a9eff);
        }

        .card-update-field-label {
            font-size: 0.9rem;
        }

        /* Lorebook diff */
        .lorebook-diff-entries {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 10px 12px;
        }

        .lorebook-diff-entry {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 0.88em;
        }

        .lorebook-diff-entry.added { background: rgba(76, 175, 80, 0.1); }
        .lorebook-diff-entry.removed { background: rgba(244, 67, 54, 0.1); }
        .lorebook-diff-entry.modified { background: rgba(255, 152, 0, 0.1); }
        .lorebook-diff-entry.unchanged { padding: 4px 10px; }

        .lorebook-diff-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            font-weight: bold;
            font-size: 13px;
            flex-shrink: 0;
            line-height: 1;
        }

        .lorebook-diff-badge.added { background: rgba(76, 175, 80, 0.25); color: #81c784; }
        .lorebook-diff-badge.removed { background: rgba(244, 67, 54, 0.25); color: #ef9a9a; }
        .lorebook-diff-badge.modified { background: rgba(255, 152, 0, 0.25); color: #ffcc80; }
        .lorebook-diff-badge.local-only { background: rgba(158, 158, 158, 0.25); color: #bdbdbd; font-size: 11px; }
        .lorebook-diff-entry.local-only { opacity: 0.7; }

        .lorebook-diff-summary {
            padding: 6px 10px;
            font-size: 0.82em;
            color: var(--cl-text-secondary, #999);
            border-bottom: 1px dashed rgba(255,255,255,0.08);
            line-height: 1.4;
        }

        .lorebook-diff-info-box {
            display: flex;
            gap: 10px;
            padding: 10px 12px;
            margin: 6px 10px;
            background: rgba(74, 158, 255, 0.08);
            border: 1px solid rgba(74, 158, 255, 0.2);
            border-radius: 8px;
            font-size: 0.82em;
            line-height: 1.5;
            color: var(--cl-text-secondary, #bbb);
        }
        .lorebook-diff-info-box > i {
            color: var(--cl-accent, #4a9eff);
            margin-top: 2px;
            flex-shrink: 0;
        }
        .lorebook-diff-info-box strong {
            color: var(--cl-text-primary, #eee);
        }
        .lorebook-diff-help-details { margin-top: 6px; }
        .lorebook-diff-help-details summary {
            cursor: pointer;
            font-size: 0.9em;
            color: var(--cl-accent, #4a9eff);
            user-select: none;
            list-style: none;
        }
        .lorebook-diff-help-details summary::-webkit-details-marker { display: none; }
        .lorebook-diff-help-details summary::before {
            content: '▸ ';
            font-size: 0.8em;
        }
        .lorebook-diff-help-details[open] summary::before {
            content: '▾ ';
        }
        .lorebook-diff-help-body {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(74, 158, 255, 0.15);
            font-size: 0.92em;
            line-height: 1.6;
        }
        .lorebook-diff-help-body p { margin: 6px 0; }
        .lorebook-diff-help-body ul {
            margin: 4px 0 6px 0;
            padding-left: 18px;
        }
        .lorebook-diff-help-body li { margin: 3px 0; }
        .lorebook-diff-help-body code {
            background: rgba(255,255,255,0.08);
            padding: 1px 5px;
            border-radius: 3px;
            font-size: 0.9em;
        }

        .lorebook-diff-entry-tag {
            margin-left: auto;
            font-size: 0.75em;
            padding: 1px 7px;
            border-radius: 9px;
            flex-shrink: 0;
            white-space: nowrap;
            font-weight: 500;
        }
        .lorebook-diff-entry-tag.added {
            background: rgba(76, 175, 80, 0.2);
            color: #81c784;
        }
        .lorebook-diff-entry-tag.local-only {
            background: rgba(158, 158, 158, 0.15);
            color: #bdbdbd;
        }
        .lorebook-diff-entry-tag.warning {
            background: rgba(255, 152, 0, 0.2);
            color: #ffb74d;
        }

        .lorebook-world-check {
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            margin-left: 4px;
        }

        .lorebook-diff-local-only-section { padding: 6px 10px; border-top: 1px dashed rgba(255,255,255,0.08); }
        .lorebook-diff-keep-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.82em; color: var(--cl-text-secondary, #999); }
        .lorebook-diff-keep-toggle input { accent-color: var(--accent, #7b68ee); }

        .lorebook-diff-entry-name {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }

        .lorebook-diff-entry-keys {
            font-size: 0.85em;
            color: var(--cl-text-secondary, #999);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-shrink: 1;
            min-width: 0;
        }

        .lorebook-diff-entry-keys::before {
            content: '\\2014\\00a0';
            opacity: 0.4;
        }

        .lorebook-diff-entry-changes {
            font-size: 0.8em;
            color: var(--cl-text-secondary, #999);
            margin-left: auto;
            flex-shrink: 0;
            white-space: nowrap;
        }

        .lorebook-diff-unchanged-count {
            opacity: 0.5;
            font-style: italic;
            font-size: 0.85em;
        }

        .lorebook-entry-counts {
            font-size: 0.85em;
            opacity: 0.65;
            margin-left: 8px;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        .lorebook-entry-counts i {
            font-size: 8px;
            opacity: 0.6;
        }

        .lorebook-diff-meta-section {
            padding: 8px 10px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .lorebook-diff-meta-title {
            font-size: 0.75em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--cl-text-secondary, #999);
            margin-bottom: 6px;
            font-weight: 600;
        }

        .lorebook-diff-meta-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 3px 0;
            font-size: 0.85em;
        }

        .lorebook-diff-meta-key {
            font-weight: 500;
            min-width: 100px;
            flex-shrink: 0;
        }

        .lorebook-diff-meta-old {
            color: #ff8a80;
            background: rgba(244, 67, 54, 0.15);
            padding: 1px 6px;
            border-radius: 3px;
        }

        .lorebook-diff-meta-new {
            color: #b9f6ca;
            background: rgba(76, 175, 80, 0.15);
            padding: 1px 6px;
            border-radius: 3px;
        }

        .lorebook-diff-meta-row i {
            color: var(--cl-text-secondary, #aaa);
            font-size: 0.7em;
            opacity: 0.6;
            flex-shrink: 0;
        }

    `;
    
    document.head.appendChild(style);
}

// ========================================
// MODALS HTML
// ========================================

function injectModals() {
    if (document.getElementById('cardUpdateSingleModal')) return;
    
    const modalsHtml = `
        <!-- Single Character Update Check Modal -->
        <div id="cardUpdateSingleModal" class="cl-modal card-update-modal">
            <div class="cl-modal-overlay"></div>
            <div class="cl-modal-content">
                <div class="cl-modal-header">
                    <h3>Check for Updates: <span id="cardUpdateSingleCharName"></span></h3>
                    <button class="cl-modal-close" id="cardUpdateSingleCloseBtn">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="cl-modal-body">
                    <div class="card-update-status" id="cardUpdateSingleStatus">
                        <i class="fa-solid fa-spinner fa-spin"></i> Checking...
                    </div>
                    <div id="cardUpdateSingleContent"></div>
                </div>
                <div class="cl-modal-footer">
                    <button class="cl-btn cl-btn-secondary" onclick="document.getElementById('cardUpdateSingleModal').classList.remove('visible')">Cancel</button>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateSingleApplyBtn" disabled>
                        <i class="fa-solid fa-check"></i> Apply Selected
                    </button>
                </div>
            </div>
        </div>
        
        <!-- Batch Update Check Modal -->
        <div id="cardUpdateBatchModal" class="cl-modal card-update-modal">
            <div class="cl-modal-overlay"></div>
            <div class="cl-modal-content">
                <div class="cl-modal-header">
                    <h3>Check for Card Updates (<span id="cardUpdateBatchCount">0</span> characters)</h3>
                    <button class="cl-modal-close" id="cardUpdateBatchCloseBtn">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="cl-modal-body">
                    <div id="cardUpdateBatchFieldSelect" class="card-update-field-select">
                        <div class="card-update-field-header">
                            <div class="card-update-field-title">
                                <i class="fa-solid fa-filter"></i>
                                <div>
                                    <div class="card-update-field-heading">Choose fields to compare</div>
                                    <div class="card-update-field-sub">Unselected fields will be ignored for search and sync.</div>
                                </div>
                            </div>
                            <div class="card-update-field-actions">
                                <span class="card-update-field-count" id="cardUpdateBatchFieldCount">0/0</span>
                                <button class="cl-btn cl-btn-secondary" id="cardUpdateBatchFieldSelectAll">All</button>
                                <button class="cl-btn cl-btn-secondary" id="cardUpdateBatchFieldSelectNone">None</button>
                            </div>
                        </div>
                        <div id="cardUpdateBatchFieldGrid" class="card-update-field-grid"></div>
                    </div>
                    <div id="cardUpdateBatchList" class="card-update-batch-list"></div>
                    <div id="cardUpdateBatchProgress" class="card-update-batch-progress"></div>
                </div>
                <div class="cl-modal-footer">
                    <div id="cardUpdateBatchApplyProgress" class="card-update-apply-progress" style="display: none;">
                        <div class="card-update-apply-text" id="cardUpdateBatchApplyText">Applying updates...</div>
                        <div class="card-update-apply-bar">
                            <div class="card-update-apply-fill" id="cardUpdateBatchApplyFill"></div>
                        </div>
                    </div>
                    <div id="cardUpdateBatchActions" class="card-update-batch-actions" style="display: none;">
                        <button class="cl-btn cl-btn-primary" id="cardUpdateBatchApplyAllBtn">
                            <i class="fa-solid fa-check-double"></i> Apply All Updates
                        </button>
                    </div>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateBatchStartBtn">
                        <i class="fa-solid fa-magnifying-glass"></i> Start Check
                    </button>
                    <button class="cl-btn cl-btn-warning card-update-pause-btn" id="cardUpdateBatchPauseBtn" style="display: none;">
                        <i class="fa-solid fa-pause"></i> Pause
                    </button>
                    <button class="cl-btn cl-btn-secondary" id="cardUpdateBatchCloseFooterBtn">Close</button>
                </div>
            </div>
        </div>
    `;
    
    const container = document.createElement('div');
    container.innerHTML = modalsHtml;
    document.body.appendChild(container);
}

// ========================================
// EXPORTS
// ========================================

export default {
    init,
    checkSingleCharacter,
    checkAllLinkedCharacters,
    checkSelectedCharacters
};
