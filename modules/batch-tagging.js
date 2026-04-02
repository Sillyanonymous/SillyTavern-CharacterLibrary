import * as CoreAPI from './core-api.js';

const debugLog = (...args) => {
    if (CoreAPI.getSetting?.('debugMode')) {
        console.log(...args);
    }
};

let isInitialized = false;
let currentTagAnalysis = null;

export function init(deps) {
    if (isInitialized) {
        console.warn('[BatchTagging] Already initialized');
        return;
    }
    
    injectModal();
    setupEventListeners();

    window.registerOverlay?.({ id: 'batchTagModal', tier: 7, close: () => closeModal(), visible: (el) => el.classList.contains('visible') });
    
    isInitialized = true;
    debugLog('[BatchTagging] Module initialized');
}

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
    
    const countEl = document.getElementById('batchTagCharCount');
    if (countEl) {
        countEl.textContent = selected.length;
    }
    
    const tagAnalysis = analyzeSelectedTags(selected);
    currentTagAnalysis = tagAnalysis;
    renderExistingTags(tagAnalysis);
    
    document.getElementById('batchTagAddInput').value = '';
    document.getElementById('batchTagRemoveInput').value = '';
    document.getElementById('batchTagAddPills').innerHTML = '';
    document.getElementById('batchTagRemovePills').innerHTML = '';
    document.getElementById('batchTagModal').classList.add('visible');
}

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
    
    result.all.sort((a, b) => a.localeCompare(b));
    result.some.sort((a, b) => a.name.localeCompare(b.name));
    
    return result;
}

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
    
    // Click-to-remove shortcut
    container.querySelectorAll('.cl-tag').forEach(pill => {
        pill.addEventListener('click', () => {
            const tag = pill.dataset.tag;
            addTagToRemoveList(tag);
        });
    });
}

function addTagToAddList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagAddPills');
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

function addTagToRemoveList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagRemovePills');
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

function getTagsToAdd() {
    const pills = document.querySelectorAll('#batchTagAddPills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

function getTagsToRemove() {
    const pills = document.querySelectorAll('#batchTagRemovePills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

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
    
    for (const char of selected) {
        try {
            let currentTags = getCharacterTags(char);
            
            const tagsToRemoveLower = tagsToRemove.map(t => t.toLowerCase());
            currentTags = currentTags.filter(t => !tagsToRemoveLower.includes(t.toLowerCase()));
            
            const currentTagsLower = currentTags.map(t => t.toLowerCase());
            for (const tag of tagsToAdd) {
                if (!currentTagsLower.includes(tag.toLowerCase())) {
                    currentTags.push(tag);
                    currentTagsLower.push(tag.toLowerCase());
                }
            }
            
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
    
    applyBtn.disabled = false;
    applyBtn.innerHTML = originalHtml;
    
    if (errorCount === 0) {
        CoreAPI.showToast(`Updated tags for ${successCount} character(s)`, 'success');
    } else {
        CoreAPI.showToast(`Updated ${successCount}, failed ${errorCount}`, 'warning');
    }
    
    closeModal();
    await CoreAPI.refreshCharacters();
    CoreAPI.clearSelection();
}

function closeModal() {
    document.getElementById('batchTagModal')?.classList.remove('visible');
}

function setupEventListeners() {
    document.getElementById('batchTagCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('batchTagCancelBtn')?.addEventListener('click', closeModal);
    document.getElementById('batchTagApplyBtn')?.addEventListener('click', applyBatchTags);
    document.getElementById('batchTagModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'batchTagModal') {
            closeModal();
        }
    });
    
    // Setup autocomplete for both inputs
    setupAutocomplete('batchTagAddInput', 'batchTagAddSuggestions', 'add');
    setupAutocomplete('batchTagRemoveInput', 'batchTagRemoveSuggestions', 'remove');
}

function setupAutocomplete(inputId, suggestionsId, mode) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);
    if (!input || !suggestions) return;
    
    let selectedIndex = -1;
    
    input.addEventListener('input', () => {
        const value = input.value.trim().toLowerCase();
        
        // Get the part after the last comma (for comma-separated input)
        const parts = input.value.split(',');
        const currentPart = parts[parts.length - 1].trim().toLowerCase();
        
        if (currentPart.length === 0) {
            hideSuggestions(suggestions);
            return;
        }
        
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

function getAvailableTags(mode) {
    if (mode === 'add') {
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

function isTagAlreadyAdded(tag, mode) {
    const containerId = mode === 'add' ? 'batchTagAddPills' : 'batchTagRemovePills';
    const container = document.getElementById(containerId);
    return container?.querySelector(`[data-tag="${CSS.escape(tag)}"]`) !== null;
}

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
    
    container.querySelectorAll('.bt-suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent blur
            const input = document.getElementById(mode === 'add' ? 'batchTagAddInput' : 'batchTagRemoveInput');
            selectSuggestion(input, container, item.dataset.tag, mode);
        });
    });
}

function hideSuggestions(container) {
    container.classList.add('hidden');
    container.innerHTML = '';
}

function updateSelectedSuggestion(items, index) {
    items.forEach((item, i) => {
        item.classList.toggle('selected', i === index);
    });
}

function selectSuggestion(input, suggestions, tag, mode) {
    // If there's comma-separated input, keep the previous parts
    const parts = input.value.split(',');
    parts.pop(); // Remove the part we're replacing
    
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

function injectModal() {
    const modalHtml = `
    <div id="batchTagModal" class="cl-modal">
        <div class="cl-modal-content" style="max-width: calc(600px * var(--modal-scale, 1));">
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
                        <input type="search" id="batchTagAddInput" class="cl-input" placeholder="Type tag and press Enter (comma-separated for multiple)" autocomplete="one-time-code">
                        <div id="batchTagAddSuggestions" class="bt-suggestions hidden"></div>
                    </div>
                    <div id="batchTagAddPills" class="bt-pills"></div>
                </div>
                
                <!-- Remove tags section -->
                <div class="bt-section">
                    <div class="bt-section-title"><i class="fa-solid fa-minus"></i> Remove Tags</div>
                    <div class="bt-input-wrapper">
                        <input type="search" id="batchTagRemoveInput" class="cl-input" placeholder="Type tag and press Enter, or click tags above" autocomplete="one-time-code">
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

export default {
    init,
    openModal
};
