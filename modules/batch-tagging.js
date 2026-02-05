/**
 * Batch Tagging Module for SillyTavern Character Library
 * Allows adding/removing multiple tags to/from multiple selected characters
 * 
 * @module BatchTagging
 * @version 1.1.0
 */

import * as SharedStyles from './shared-styles.js';
import * as CoreAPI from './core-api.js';

// Module state
let isInitialized = false;
let currentTagAnalysis = null; // Store current tag analysis for remove suggestions

/**
 * Initialize the batch tagging module
 * @param {Object} deps - Dependencies (legacy, now using CoreAPI)
 */
export function init(deps) {
    if (isInitialized) {
        console.warn('[BatchTagging] Already initialized');
        return;
    }
    
    // Ensure shared styles are loaded first
    SharedStyles.inject();
    
    // Inject module-specific styles (only what's unique to batch tagging)
    injectStyles();
    
    // Inject modal HTML
    injectModal();
    
    // Setup event listeners
    setupEventListeners();
    
    isInitialized = true;
    console.log('[BatchTagging] Module initialized');
}

/**
 * Open the batch tagging modal
 * Called from gallery.js when user triggers batch tag action
 */
export function openModal() {
    if (!isInitialized) {
        console.error('[BatchTagging] Module not initialized');
        return;
    }
    
    const selected = CoreAPI.getSelectedCharacters();
    if (!selected || selected.length === 0) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }
    
    // Update modal header with count
    const countEl = document.getElementById('batchTagCharCount');
    if (countEl) {
        countEl.textContent = selected.length;
    }
    
    // Analyze existing tags across selected characters
    const tagAnalysis = analyzeSelectedTags(selected);
    currentTagAnalysis = tagAnalysis; // Store for remove suggestions
    renderExistingTags(tagAnalysis);
    
    // Clear input fields
    document.getElementById('batchTagAddInput').value = '';
    document.getElementById('batchTagRemoveInput').value = '';
    
    // Clear tag pills
    document.getElementById('batchTagAddPills').innerHTML = '';
    document.getElementById('batchTagRemovePills').innerHTML = '';
    
    // Show modal
    document.getElementById('batchTagModal').classList.add('visible');
}

/**
 * Analyze tags across all selected characters
 * @param {Array} characters - Selected characters
 * @returns {Object} Tag analysis with counts
 */
function analyzeSelectedTags(characters) {
    const tagCounts = {};
    const totalChars = characters.length;
    
    for (const char of characters) {
        const tags = getCharacterTags(char);
        // Deduplicate tags per character (case-insensitive) to avoid double-counting
        const seenInThisChar = new Set();
        
        for (const tag of tags) {
            const normalizedTag = tag.trim().toLowerCase();
            if (normalizedTag && !seenInThisChar.has(normalizedTag)) {
                seenInThisChar.add(normalizedTag);
                if (!tagCounts[normalizedTag]) {
                    tagCounts[normalizedTag] = { name: tag.trim(), count: 0 };
                }
                tagCounts[normalizedTag].count++;
            }
        }
    }
    
    // Categorize tags
    const result = {
        all: [],      // Tags on ALL selected characters
        some: [],     // Tags on SOME selected characters
        total: totalChars
    };
    
    for (const [key, data] of Object.entries(tagCounts)) {
        if (data.count === totalChars) {
            result.all.push(data.name);
        } else {
            result.some.push({ name: data.name, count: data.count });
        }
    }
    
    // Sort alphabetically
    result.all.sort((a, b) => a.localeCompare(b));
    result.some.sort((a, b) => a.name.localeCompare(b.name));
    
    return result;
}

/**
 * Get tags from a character object
 * @param {Object} char - Character object
 * @returns {Array} Array of tag strings
 */
function getCharacterTags(char) {
    // Tags can be in multiple places - check for non-empty arrays
    // Note: empty arrays are truthy, so we need explicit length checks
    let tags = [];
    
    if (Array.isArray(char.tags) && char.tags.length > 0) {
        tags = char.tags;
    } else if (Array.isArray(char.data?.tags) && char.data.tags.length > 0) {
        tags = char.data.tags;
    } else if (typeof char.tags === 'string' && char.tags.trim()) {
        tags = char.tags;
    } else if (typeof char.data?.tags === 'string' && char.data.tags.trim()) {
        tags = char.data.tags;
    }
    
    // Could be a comma-separated string or an array
    if (typeof tags === 'string') {
        tags = tags.split(',').map(t => t.trim()).filter(t => t);
    }
    
    return Array.isArray(tags) ? tags : [];
}

/**
 * Render existing tags analysis in the modal
 * @param {Object} analysis - Tag analysis object
 */
function renderExistingTags(analysis) {
    const container = document.getElementById('batchTagExisting');
    if (!container) return;
    
    let html = '';
    
    if (analysis.all.length > 0) {
        html += `<div class="bt-group">
            <div class="bt-group-label">Tags on ALL ${analysis.total} selected:</div>
            <div class="bt-group-pills">
                ${analysis.all.map(tag => `
                    <span class="cl-tag cl-tag-success" data-tag="${CoreAPI.escapeHtml(tag)}" title="Click to add to removal list">
                        ${CoreAPI.escapeHtml(tag)}
                    </span>
                `).join('')}
            </div>
        </div>`;
    }
    
    if (analysis.some.length > 0) {
        html += `<div class="bt-group">
            <div class="bt-group-label">Tags on SOME selected:</div>
            <div class="bt-group-pills">
                ${analysis.some.map(t => `
                    <span class="cl-tag cl-tag-warning" data-tag="${CoreAPI.escapeHtml(t.name)}" title="${t.count}/${analysis.total} characters - Click to add to removal list">
                        ${CoreAPI.escapeHtml(t.name)} <span class="bt-count">(${t.count}/${analysis.total})</span>
                    </span>
                `).join('')}
            </div>
        </div>`;
    }
    
    if (analysis.all.length === 0 && analysis.some.length === 0) {
        html = '<div class="bt-empty">No existing tags on selected characters</div>';
    }
    
    container.innerHTML = html;
    
    // Add click handlers to existing tag pills (to quickly add to remove list)
    container.querySelectorAll('.cl-tag').forEach(pill => {
        pill.addEventListener('click', () => {
            const tag = pill.dataset.tag;
            addTagToRemoveList(tag);
        });
    });
}

/**
 * Add a tag pill to the "add" list
 * @param {string} tag - Tag to add
 */
function addTagToAddList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagAddPills');
    
    // Check if already exists
    if (container.querySelector(`[data-tag="${CSS.escape(normalized)}"]`)) {
        return;
    }
    
    const pill = document.createElement('span');
    pill.className = 'cl-tag cl-tag-info';
    pill.dataset.tag = normalized;
    pill.innerHTML = `${CoreAPI.escapeHtml(normalized)} <i class="fa-solid fa-xmark bt-pill-close"></i>`;
    pill.querySelector('.bt-pill-close').addEventListener('click', (e) => {
        e.stopPropagation();
        pill.remove();
    });
    
    container.appendChild(pill);
}

/**
 * Add a tag pill to the "remove" list
 * @param {string} tag - Tag to remove
 */
function addTagToRemoveList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagRemovePills');
    
    // Check if already exists
    if (container.querySelector(`[data-tag="${CSS.escape(normalized)}"]`)) {
        return;
    }
    
    const pill = document.createElement('span');
    pill.className = 'cl-tag cl-tag-danger';
    pill.dataset.tag = normalized;
    pill.innerHTML = `${CoreAPI.escapeHtml(normalized)} <i class="fa-solid fa-xmark bt-pill-close"></i>`;
    pill.querySelector('.bt-pill-close').addEventListener('click', (e) => {
        e.stopPropagation();
        pill.remove();
    });
    
    container.appendChild(pill);
}

/**
 * Get all tags from the "add" list
 * @returns {Array} Tags to add
 */
function getTagsToAdd() {
    const pills = document.querySelectorAll('#batchTagAddPills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

/**
 * Get all tags from the "remove" list
 * @returns {Array} Tags to remove
 */
function getTagsToRemove() {
    const pills = document.querySelectorAll('#batchTagRemovePills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

/**
 * Apply the batch tag changes
 */
async function applyBatchTags() {
    const tagsToAdd = getTagsToAdd();
    const tagsToRemove = getTagsToRemove();
    
    if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
        CoreAPI.showToast('No tag changes specified', 'warning');
        return;
    }
    
    const selected = CoreAPI.getSelectedCharacters();
    if (!selected || selected.length === 0) {
        CoreAPI.showToast('No characters selected', 'error');
        return;
    }
    
    const applyBtn = document.getElementById('batchTagApplyBtn');
    const originalHtml = applyBtn.innerHTML;
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Applying...';
    
    let successCount = 0;
    let errorCount = 0;
    
    // Process each character
    for (const char of selected) {
        try {
            // Get current tags
            let currentTags = getCharacterTags(char);
            
            // Remove tags (case-insensitive matching)
            const tagsToRemoveLower = tagsToRemove.map(t => t.toLowerCase());
            currentTags = currentTags.filter(t => !tagsToRemoveLower.includes(t.toLowerCase()));
            
            // Add new tags (avoid duplicates, case-insensitive)
            const currentTagsLower = currentTags.map(t => t.toLowerCase());
            for (const tag of tagsToAdd) {
                if (!currentTagsLower.includes(tag.toLowerCase())) {
                    currentTags.push(tag);
                    currentTagsLower.push(tag.toLowerCase());
                }
            }
            
            // Save via merge-attributes API
            // IMPORTANT: SillyTavern reads tags from data.tags, not root level
            // Must include data object with tags while preserving existing data fields
            const existingData = char.data || {};
            const existingExtensions = existingData.extensions || char.extensions || {};
            
            const payload = {
                avatar: char.avatar,
                tags: currentTags,
                create_date: char.create_date,
                data: {
                    ...existingData,
                    tags: currentTags,
                    extensions: existingExtensions
                }
            };
            
            const response = await CoreAPI.apiRequest('/characters/merge-attributes', 'POST', payload);
            
            if (response.ok) {
                // Update local character data
                char.tags = currentTags;
                if (char.data) char.data.tags = currentTags;
                successCount++;
            } else {
                console.error('[BatchTagging] Failed to update', char.name);
                errorCount++;
            }
        } catch (err) {
            console.error('[BatchTagging] Error updating', char.name, err);
            errorCount++;
        }
    }
    
    // Restore button
    applyBtn.disabled = false;
    applyBtn.innerHTML = originalHtml;
    
    // Show result
    if (errorCount === 0) {
        CoreAPI.showToast(`Updated tags for ${successCount} character(s)`, 'success');
    } else {
        CoreAPI.showToast(`Updated ${successCount}, failed ${errorCount}`, 'warning');
    }
    
    // Close modal and clear selection
    closeModal();
    
    // Refresh the display
    await CoreAPI.refreshCharacters();
    
    // Clear selection
    CoreAPI.clearSelection();
}

/**
 * Close the batch tagging modal
 */
function closeModal() {
    document.getElementById('batchTagModal')?.classList.remove('visible');
}

/**
 * Setup event listeners for the modal
 */
function setupEventListeners() {
    // Close button
    document.getElementById('batchTagCloseBtn')?.addEventListener('click', closeModal);
    
    // Cancel button
    document.getElementById('batchTagCancelBtn')?.addEventListener('click', closeModal);
    
    // Apply button
    document.getElementById('batchTagApplyBtn')?.addEventListener('click', applyBatchTags);
    
    // Close on backdrop click
    document.getElementById('batchTagModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'batchTagModal') {
            closeModal();
        }
    });
    
    // Setup autocomplete for both inputs
    setupAutocomplete('batchTagAddInput', 'batchTagAddSuggestions', 'add');
    setupAutocomplete('batchTagRemoveInput', 'batchTagRemoveSuggestions', 'remove');
}

/**
 * Setup autocomplete for a tag input
 * @param {string} inputId - ID of the input element
 * @param {string} suggestionsId - ID of the suggestions container
 * @param {string} mode - 'add' for all tags, 'remove' for selected character tags only
 */
function setupAutocomplete(inputId, suggestionsId, mode) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);
    if (!input || !suggestions) return;
    
    let selectedIndex = -1;
    
    // Input event - show suggestions as user types
    input.addEventListener('input', () => {
        const value = input.value.trim().toLowerCase();
        
        // Get the part after the last comma (for comma-separated input)
        const parts = input.value.split(',');
        const currentPart = parts[parts.length - 1].trim().toLowerCase();
        
        if (currentPart.length === 0) {
            hideSuggestions(suggestions);
            return;
        }
        
        // Get available tags based on mode
        const availableTags = getAvailableTags(mode);
        
        // Filter tags that match the current input
        const matches = availableTags.filter(tag => 
            tag.toLowerCase().includes(currentPart) && 
            !isTagAlreadyAdded(tag, mode)
        ).slice(0, 10); // Limit to 10 suggestions
        
        if (matches.length === 0) {
            hideSuggestions(suggestions);
            return;
        }
        
        // Render suggestions
        renderSuggestions(suggestions, matches, currentPart, mode);
        selectedIndex = -1;
    });
    
    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = suggestions.querySelectorAll('.bt-suggestion-item');
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelectedSuggestion(items, selectedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelectedSuggestion(items, selectedIndex);
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0 && items[selectedIndex]) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[selectedIndex].dataset.tag, mode);
                selectedIndex = -1;
            } else {
                // No suggestion selected - add whatever is typed
                const value = input.value.trim().replace(/,+$/, '');
                if (value) {
                    e.preventDefault();
                    value.split(',').forEach(tag => {
                        if (mode === 'add') {
                            addTagToAddList(tag.trim());
                        } else {
                            addTagToRemoveList(tag.trim());
                        }
                    });
                    input.value = '';
                    hideSuggestions(suggestions);
                }
            }
        } else if (e.key === ',') {
            if (selectedIndex >= 0 && items[selectedIndex]) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[selectedIndex].dataset.tag, mode);
                selectedIndex = -1;
            }
        } else if (e.key === 'Escape') {
            hideSuggestions(suggestions);
            selectedIndex = -1;
        } else if (e.key === 'Tab' && !suggestions.classList.contains('hidden')) {
            // Tab selects first suggestion if any
            if (items.length > 0) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[0].dataset.tag, mode);
                selectedIndex = -1;
            }
        }
    });
    
    // Hide suggestions on blur (with delay to allow click)
    input.addEventListener('blur', () => {
        setTimeout(() => {
            hideSuggestions(suggestions);
            // Add remaining text as tag
            const value = input.value.trim();
            if (value) {
                value.split(',').forEach(tag => {
                    if (mode === 'add') {
                        addTagToAddList(tag.trim());
                    } else {
                        addTagToRemoveList(tag.trim());
                    }
                });
                input.value = '';
            }
        }, 200);
    });
}

/**
 * Get available tags based on mode
 * @param {string} mode - 'add' or 'remove'
 * @returns {Array<string>} Available tags
 */
function getAvailableTags(mode) {
    if (mode === 'add') {
        // All known tags in the library
        return CoreAPI.getAllTags();
    } else {
        // Only tags from selected characters
        if (!currentTagAnalysis) return [];
        const allSelectedTags = [
            ...currentTagAnalysis.all,
            ...currentTagAnalysis.some.map(t => t.name)
        ];
        return [...new Set(allSelectedTags)].sort((a, b) => a.localeCompare(b));
    }
}

/**
 * Check if a tag is already in the add/remove list
 * @param {string} tag - Tag to check
 * @param {string} mode - 'add' or 'remove'
 * @returns {boolean} True if tag is already added
 */
function isTagAlreadyAdded(tag, mode) {
    const containerId = mode === 'add' ? 'batchTagAddPills' : 'batchTagRemovePills';
    const container = document.getElementById(containerId);
    return container?.querySelector(`[data-tag="${CSS.escape(tag)}"]`) !== null;
}

/**
 * Render suggestions dropdown
 * @param {HTMLElement} container - Suggestions container
 * @param {Array<string>} tags - Tags to show
 * @param {string} highlight - Text to highlight
 * @param {string} mode - 'add' or 'remove'
 */
function renderSuggestions(container, tags, highlight, mode) {
    const html = tags.map(tag => {
        // Highlight matching part
        const lowerTag = tag.toLowerCase();
        const idx = lowerTag.indexOf(highlight.toLowerCase());
        let displayTag;
        if (idx >= 0) {
            displayTag = CoreAPI.escapeHtml(tag.substring(0, idx)) +
                '<strong>' + CoreAPI.escapeHtml(tag.substring(idx, idx + highlight.length)) + '</strong>' +
                CoreAPI.escapeHtml(tag.substring(idx + highlight.length));
        } else {
            displayTag = CoreAPI.escapeHtml(tag);
        }
        return `<div class="bt-suggestion-item" data-tag="${CoreAPI.escapeHtml(tag)}">${displayTag}</div>`;
    }).join('');
    
    container.innerHTML = html;
    container.classList.remove('hidden');
    
    // Add click handlers
    container.querySelectorAll('.bt-suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent blur
            const input = document.getElementById(mode === 'add' ? 'batchTagAddInput' : 'batchTagRemoveInput');
            selectSuggestion(input, container, item.dataset.tag, mode);
        });
    });
}

/**
 * Hide suggestions dropdown
 * @param {HTMLElement} container - Suggestions container
 */
function hideSuggestions(container) {
    container.classList.add('hidden');
    container.innerHTML = '';
}

/**
 * Update visual selection in suggestions
 * @param {NodeList} items - Suggestion items
 * @param {number} index - Selected index
 */
function updateSelectedSuggestion(items, index) {
    items.forEach((item, i) => {
        item.classList.toggle('selected', i === index);
    });
}

/**
 * Select a suggestion and add it as a tag
 * @param {HTMLInputElement} input - Input element
 * @param {HTMLElement} suggestions - Suggestions container
 * @param {string} tag - Tag to add
 * @param {string} mode - 'add' or 'remove'
 */
function selectSuggestion(input, suggestions, tag, mode) {
    // If there's comma-separated input, keep the previous parts
    const parts = input.value.split(',');
    parts.pop(); // Remove the part we're replacing
    
    // Add the tag
    if (mode === 'add') {
        addTagToAddList(tag);
    } else {
        addTagToRemoveList(tag);
    }
    
    // Keep any remaining parts in input, or clear it
    input.value = parts.length > 0 ? parts.join(',') + ', ' : '';
    hideSuggestions(suggestions);
    input.focus();
}

/**
 * Inject the modal HTML into the document
 * Uses shared cl-* classes for common elements
 */
function injectModal() {
    const modalHtml = `
    <div id="batchTagModal" class="cl-modal">
        <div class="cl-modal-content" style="max-width: 600px;">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Batch Tag Editor</h3>
                <span class="bt-char-count"><span id="batchTagCharCount">0</span> selected</span>
                <button id="batchTagCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            
            <div class="cl-modal-body">
                <!-- Existing tags section -->
                <div class="bt-section">
                    <div class="bt-section-title">Current Tags</div>
                    <div id="batchTagExisting" class="bt-existing">
                        <!-- Populated dynamically -->
                    </div>
                    <div class="bt-hint">Click a tag above to add it to the removal list</div>
                </div>
                
                <!-- Add tags section -->
                <div class="bt-section">
                    <div class="bt-section-title"><i class="fa-solid fa-plus"></i> Add Tags</div>
                    <div class="bt-input-wrapper">
                        <input type="text" id="batchTagAddInput" class="cl-input" placeholder="Type tag and press Enter (comma-separated for multiple)" autocomplete="off">
                        <div id="batchTagAddSuggestions" class="bt-suggestions hidden"></div>
                    </div>
                    <div id="batchTagAddPills" class="bt-pills"></div>
                </div>
                
                <!-- Remove tags section -->
                <div class="bt-section">
                    <div class="bt-section-title"><i class="fa-solid fa-minus"></i> Remove Tags</div>
                    <div class="bt-input-wrapper">
                        <input type="text" id="batchTagRemoveInput" class="cl-input" placeholder="Type tag and press Enter, or click tags above" autocomplete="off">
                        <div id="batchTagRemoveSuggestions" class="bt-suggestions hidden"></div>
                    </div>
                    <div id="batchTagRemovePills" class="bt-pills"></div>
                </div>
            </div>
            
            <div class="cl-modal-footer">
                <button id="batchTagCancelBtn" class="cl-btn cl-btn-secondary">Cancel</button>
                <button id="batchTagApplyBtn" class="cl-btn cl-btn-primary"><i class="fa-solid fa-check"></i> Apply Changes</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * Inject module-specific styles (only what's unique to batch tagging)
 * Common modal/button/input styles come from shared-styles.js
 */
function injectStyles() {
    if (document.getElementById('batch-tagging-styles')) return;
    
    const styles = `
    <style id="batch-tagging-styles">
        /* Batch Tagging specific styles - using bt- prefix */
        
        .bt-char-count {
            font-size: 0.85em;
            color: var(--cl-text-secondary);
            margin-left: auto;
            margin-right: 8px;
        }
        
        .bt-section {
            margin-bottom: 20px;
        }
        
        .bt-section:last-child {
            margin-bottom: 0;
        }
        
        .bt-section-title {
            font-weight: 600;
            margin-bottom: 10px;
            color: var(--cl-text-primary);
            font-size: 0.95em;
        }
        
        .bt-existing {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
            padding: 12px;
            min-height: 40px;
        }
        
        .bt-group {
            margin-bottom: 12px;
        }
        
        .bt-group:last-child {
            margin-bottom: 0;
        }
        
        .bt-group-label {
            font-size: 0.8em;
            color: var(--cl-text-secondary);
            margin-bottom: 6px;
        }
        
        .bt-group-pills {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        
        .bt-pills {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            min-height: 32px;
            margin-top: 10px;
        }
        
        .bt-hint {
            font-size: 0.75em;
            color: var(--cl-text-secondary);
            margin-top: 8px;
            font-style: italic;
            opacity: 0.8;
        }
        
        .bt-empty {
            color: var(--cl-text-secondary);
            font-style: italic;
            font-size: 0.9em;
        }
        
        .bt-count {
            font-size: 0.8em;
            opacity: 0.7;
        }
        
        /* Tag pill close button */
        .bt-pill-close {
            cursor: pointer;
            opacity: 0.7;
            font-size: 0.85em;
            margin-left: 2px;
        }
        
        .bt-pill-close:hover {
            opacity: 1;
        }
        
        /* Autocomplete input wrapper */
        .bt-input-wrapper {
            position: relative;
        }
        
        /* Autocomplete suggestions dropdown */
        .bt-suggestions {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: var(--cl-glass-bg);
            border: 1px solid var(--cl-border);
            border-top: none;
            border-radius: 0 0 8px 8px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 10001;
            box-shadow: var(--cl-shadow-lg);
        }
        
        .bt-suggestions.hidden {
            display: none;
        }
        
        .bt-suggestion-item {
            padding: 8px 12px;
            cursor: pointer;
            color: var(--cl-text-primary);
            font-size: 0.9em;
            transition: background 0.15s;
        }
        
        .bt-suggestion-item:hover,
        .bt-suggestion-item.selected {
            background: rgba(255, 255, 255, 0.1);
        }
        
        .bt-suggestion-item strong {
            color: var(--cl-accent);
        }
    </style>`;
    
    document.head.insertAdjacentHTML('beforeend', styles);
}

// Export for external access
export default {
    init,
    openModal
};
