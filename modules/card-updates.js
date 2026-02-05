/**
 * Card Updates Module for SillyTavern Character Library
 * Check for updates to Chub-linked characters and show diffs
 * 
 * @module CardUpdates
 * @version 1.0.0
 */

import * as SharedStyles from './shared-styles.js';
import * as CoreAPI from './core-api.js';

// Module state
let isInitialized = false;
let currentUpdateChecks = new Map(); // fullPath -> { local, remote, diffs }
let abortController = null;

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
    'character_version': 'Version',
    'tags': 'Tags',
    'alternate_greetings': 'Alternate Greetings',
    // V3 additions
    'nickname': 'Nickname',
    'group_only_greetings': 'Group Only Greetings',
    // Depth prompt
    'depth_prompt.prompt': 'Depth Prompt Text',
    'depth_prompt.depth': 'Depth Prompt Depth',
    'depth_prompt.role': 'Depth Prompt Role',
};

// Fields that should use text diff view
const LONG_TEXT_FIELDS = new Set([
    'description', 'personality', 'scenario', 'first_mes', 
    'mes_example', 'system_prompt', 'post_history_instructions',
    'creator_notes', 'depth_prompt.prompt', 'alternate_greetings',
    'group_only_greetings'
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
    
    SharedStyles.inject();
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
 * Fetch remote character data from ChubAI
 * @param {string} fullPath - Chub full path (creator/slug)
 * @returns {Promise<Object|null>} Remote character card data
 */
async function fetchRemoteCard(fullPath) {
    try {
        // First try to get the actual PNG with embedded data (most accurate)
        const pngUrl = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
        
        let response;
        try {
            response = await fetch(pngUrl);
        } catch (e) {
            // Try proxy
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
        
        // Fallback: use API metadata
        console.log('[CardUpdates] PNG extraction failed, trying API for:', fullPath);
        const metadata = await CoreAPI.fetchChubMetadata(fullPath);
        if (metadata?.definition) {
            // Build a card-like structure from API data
            return {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: {
                    name: metadata.definition.name || metadata.name,
                    description: metadata.definition.description || '',
                    personality: metadata.definition.personality || '',
                    scenario: metadata.definition.scenario || '',
                    first_mes: metadata.definition.first_mes || '',
                    mes_example: metadata.definition.mes_example || '',
                    system_prompt: metadata.definition.system_prompt || '',
                    post_history_instructions: metadata.definition.post_history_instructions || '',
                    creator_notes: metadata.definition.creator_notes || '',
                    creator: metadata.definition.creator || metadata.fullPath?.split('/')[0] || '',
                    character_version: metadata.definition.character_version || '',
                    tags: metadata.definition.tags || [],
                    alternate_greetings: metadata.definition.alternate_greetings || [],
                    extensions: metadata.definition.extensions || {}
                }
            };
        }
        
        return null;
    } catch (error) {
        console.error('[CardUpdates] Failed to fetch remote card:', fullPath, error);
        return null;
    }
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
 * @returns {Array} Array of { field, label, local, remote, isLongText }
 */
function compareCards(localData, remoteCard) {
    const diffs = [];
    const remoteData = remoteCard?.data || remoteCard;
    
    for (const [field, label] of Object.entries(COMPARABLE_FIELDS)) {
        const localValue = getNestedValue(localData, field);
        const remoteValue = getNestedValue(remoteData, field);
        
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
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).trim();
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

/**
 * Show single character update check modal
 * @param {Object} char - Character to check
 */
function showSingleCheckModal(char) {
    const modal = document.getElementById('cardUpdateSingleModal');
    const charName = char.data?.name || char.name || 'Unknown';
    
    document.getElementById('cardUpdateSingleCharName').textContent = charName;
    document.getElementById('cardUpdateSingleStatus').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking for updates...';
    document.getElementById('cardUpdateSingleContent').innerHTML = '';
    document.getElementById('cardUpdateSingleApplyBtn').disabled = true;
    
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
        
        // Store for apply action
        currentUpdateChecks.set(char.avatar, { char, localData, remoteCard, diffs });
        
        // Render diff UI
        contentEl.innerHTML = renderDiffList(diffs, char.avatar);
        applyBtn.disabled = false;
        
    } catch (error) {
        console.error('[CardUpdates] Check failed:', error);
        statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> Error checking for updates';
    }
}

/**
 * Render the diff list HTML
 * @param {Array} diffs - Array of diff objects
 * @param {string} charKey - Character key for checkbox naming
 * @returns {string} HTML string
 */
function renderDiffList(diffs, charKey) {
    return `
        <div class="card-update-diff-list">
            <label class="card-update-select-all">
                <input type="checkbox" checked onchange="window.cardUpdatesToggleAll('${charKey}', this.checked)">
                <span>Select All</span>
            </label>
            ${diffs.map((diff, idx) => renderDiffItem(diff, charKey, idx)).join('')}
        </div>
    `;
}

/**
 * Render a single diff item
 * @param {Object} diff - Diff object
 * @param {string} charKey - Character key
 * @param {number} idx - Index for unique ID
 * @returns {string} HTML string
 */
function renderDiffItem(diff, charKey, idx) {
    const checkboxId = `diff-${charKey}-${idx}`;
    const localDisplay = formatValueForDisplay(diff.local);
    const remoteDisplay = formatValueForDisplay(diff.remote);
    
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
    
    countEl.textContent = characters.length;
    progressEl.innerHTML = '';
    actionsEl.style.display = 'none';
    currentUpdateChecks.clear();
    
    // Build initial list
    listEl.innerHTML = characters.map(char => {
        const chubInfo = getChubLinkInfo(char);
        const name = char.data?.name || char.name || 'Unknown';
        return `
            <div class="card-update-batch-item" data-avatar="${char.avatar}">
                <div class="card-update-batch-item-info">
                    <span class="card-update-batch-item-name">${CoreAPI.escapeHtml(name)}</span>
                    <span class="card-update-batch-item-path">${CoreAPI.escapeHtml(chubInfo?.fullPath || '')}</span>
                </div>
                <div class="card-update-batch-item-status">
                    <i class="fa-solid fa-clock"></i> Pending
                </div>
            </div>
        `;
    }).join('');
    
    modal.classList.add('visible');
    
    // Start checking
    performBatchCheck(characters);
}

/**
 * Perform batch update check
 * @param {Array} characters - Characters to check
 */
async function performBatchCheck(characters) {
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    const actionsEl = document.getElementById('cardUpdateBatchActions');
    
    abortController = new AbortController();
    let checked = 0;
    let withUpdates = 0;
    let errors = 0;
    
    for (const char of characters) {
        if (abortController.signal.aborted) break;
        
        const itemEl = document.querySelector(`.card-update-batch-item[data-avatar="${char.avatar}"]`);
        const statusEl = itemEl?.querySelector('.card-update-batch-item-status');
        
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
                const diffs = compareCards(localData, remoteCard);
                
                if (diffs.length === 0) {
                    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-check" style="color: var(--success-color, #4caf50);"></i> Up to date';
                } else {
                    if (statusEl) {
                        statusEl.innerHTML = `
                            <span class="has-updates">${diffs.length} update${diffs.length > 1 ? 's' : ''}</span>
                            <button class="card-update-batch-view-btn" onclick="window.cardUpdatesViewDiffs('${char.avatar}')">
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
        
        checked++;
        progressEl.innerHTML = `Checked ${checked}/${characters.length}`;
    }
    
    progressEl.innerHTML = `
        Done! ${withUpdates} with updates, ${errors} errors
    `;
    
    if (withUpdates > 0) {
        actionsEl.style.display = 'flex';
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
    contentEl.innerHTML = renderDiffList(diffs, avatar);
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
    
    // Find the character from stored checks
    const firstCheckbox = modal.querySelector('.card-update-diff-item input[type="checkbox"]');
    const checkboxId = firstCheckbox?.id || '';
    const avatarMatch = checkboxId.match(/^diff-(.+?)-\d+$/);
    if (!avatarMatch) return;
    
    const avatar = avatarMatch[1];
    const checkData = currentUpdateChecks.get(avatar);
    if (!checkData) return;
    
    const { char, diffs, remoteCard } = checkData;
    const remoteData = remoteCard?.data || remoteCard;
    
    // Build updated data object
    const updatedFields = {};
    checkboxes.forEach(cb => {
        const field = cb.dataset.field;
        const remoteValue = getNestedValue(remoteData, field);
        updatedFields[field] = remoteValue;
    });
    
    // Apply via CoreAPI
    try {
        const success = await CoreAPI.applyCardFieldUpdates(char.avatar, updatedFields);
        
        if (success) {
            CoreAPI.showToast(`Updated ${checkboxes.length} field${checkboxes.length > 1 ? 's' : ''}`, 'success');
            closeSingleModal();
            
            // Update batch list if visible
            const batchItem = document.querySelector(`.card-update-batch-item[data-avatar="${avatar}"]`);
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
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const [avatar, checkData] of entries) {
        const { char, diffs, remoteCard } = checkData;
        const remoteData = remoteCard?.data || remoteCard;
        
        // Apply all diffs for this character
        const updatedFields = {};
        for (const diff of diffs) {
            const remoteValue = getNestedValue(remoteData, diff.field);
            updatedFields[diff.field] = remoteValue;
        }
        
        try {
            const success = await CoreAPI.applyCardFieldUpdates(avatar, updatedFields);
            
            if (success) {
                successCount++;
                
                // Update batch list
                const batchItem = document.querySelector(`.card-update-batch-item[data-avatar="${avatar}"]`);
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
    }
    
    currentUpdateChecks.clear();
    
    CoreAPI.showToast(`Updated ${successCount} character${successCount !== 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 
        errorCount > 0 ? 'warning' : 'success');
    
    document.getElementById('cardUpdateBatchActions').style.display = 'none';
}

// ========================================
// MODAL MANAGEMENT
// ========================================

function closeSingleModal() {
    document.getElementById('cardUpdateSingleModal')?.classList.remove('visible');
}

function closeBatchModal() {
    abortController?.abort();
    document.getElementById('cardUpdateBatchModal')?.classList.remove('visible');
    currentUpdateChecks.clear();
}

// ========================================
// UI HELPERS (exposed to window)
// ========================================

/**
 * Toggle all checkboxes for a character's diffs
 */
function toggleAllCheckboxes(charKey, checked) {
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
    
    // Apply buttons
    document.getElementById('cardUpdateSingleApplyBtn')?.addEventListener('click', applySingleUpdates);
    document.getElementById('cardUpdateBatchApplyAllBtn')?.addEventListener('click', applyAllBatchUpdates);
    
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
    window.cardUpdatesViewDiffs = viewBatchItemDiffs;
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
                    <div id="cardUpdateBatchList" class="card-update-batch-list"></div>
                    <div id="cardUpdateBatchProgress" class="card-update-batch-progress"></div>
                </div>
                <div class="cl-modal-footer">
                    <div id="cardUpdateBatchActions" class="card-update-batch-actions" style="display: none;">
                        <button class="cl-btn cl-btn-primary" id="cardUpdateBatchApplyAllBtn">
                            <i class="fa-solid fa-check-double"></i> Apply All Updates
                        </button>
                    </div>
                    <button class="cl-btn cl-btn-secondary" onclick="document.getElementById('cardUpdateBatchModal').classList.remove('visible')">Close</button>
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
