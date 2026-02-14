/**
 * Chats Module for SillyTavern Character Library
 * 
 * Handles all chat-related functionality:
 * - Character modal chats tab (per-character chat list)
 * - Top-level chats view (browse all chats across all characters)
 * - Chat preview modal with message viewing/editing/deleting
 * - Chat caching for performance
 * 
 * @module Chats
 * @version 1.0.0
 */

import * as CoreAPI from './core-api.js';

// ========================================
// API ENDPOINTS
// ========================================

const ENDPOINTS = {
    CHARACTERS_CHATS: '/characters/chats',
    CHATS_GET: '/chats/get',
    CHATS_SAVE: '/chats/save',
    CHATS_DELETE: '/chats/delete',
};

// ========================================
// MODULE STATE
// ========================================

let allChats = [];
let currentGrouping = 'flat'; // 'flat' or 'grouped'
let currentChatSort = 'recent';
let currentPreviewChat = null;
let currentPreviewChar = null;
let currentChatMessages = [];
let _modalChatsChar = null;

// ========================================
// CHATS CACHING
// ========================================

const CHATS_CACHE_KEY = 'st_gallery_chats_cache';
const CHATS_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes before background refresh

function getCachedChats() {
    try {
        const cached = localStorage.getItem(CHATS_CACHE_KEY);
        if (!cached) return null;

        const data = JSON.parse(cached);
        return data;
    } catch (e) {
        console.warn('[ChatsCache] Failed to read cache:', e);
        return null;
    }
}

function saveChatCache(chats) {
    try {
        const cacheData = {
            timestamp: Date.now(),
            chats: chats.map(c => ({
                file_name: c.file_name,
                last_mes: c.last_mes,
                chat_items: c.chat_items || c.mes_count || 0,
                charName: c.charName,
                charAvatar: c.charAvatar,
                preview: c.preview,
                models: c.models || null
            }))
        };
        localStorage.setItem(CHATS_CACHE_KEY, JSON.stringify(cacheData));
        CoreAPI.debugLog(`[ChatsCache] Saved ${chats.length} chats to cache`);
    } catch (e) {
        console.warn('[ChatsCache] Failed to save cache:', e);
    }
}

function clearChatCache() {
    localStorage.removeItem(CHATS_CACHE_KEY);
}

// ========================================
// CHARACTER MODAL — CHATS TAB
// ========================================

/**
 * Fetch and render chats for a character in the modal chats tab
 * @param {Object} char - Character object
 */
async function fetchCharacterChats(char) {
    _modalChatsChar = char;
    const chatsList = document.getElementById('chatsList');
    if (!chatsList) return;

    CoreAPI.renderLoadingState(chatsList, 'Loading chats...', 'chats-loading');

    try {
        const response = await CoreAPI.apiRequest(ENDPOINTS.CHARACTERS_CHATS, 'POST', {
            avatar_url: char.avatar,
            metadata: true
        });

        if (!response.ok) {
            chatsList.innerHTML = '<div class="no-chats"><i class="fa-solid fa-exclamation-circle"></i><p>Failed to load chats</p></div>';
            return;
        }

        const chats = await response.json();

        if (chats.error || !chats.length) {
            chatsList.innerHTML = `
                <div class="no-chats">
                    <i class="fa-solid fa-comments"></i>
                    <p>No chats found for this character</p>
                </div>
            `;
            return;
        }

        // Sort by date (most recent first)
        chats.sort((a, b) => {
            const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
            const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
            return dateB - dateA;
        });

        const currentChat = char.chat;

        chatsList.innerHTML = chats.map(chat => {
            const isActive = chat.file_name === currentChat + '.jsonl';
            const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
            const messageCount = chat.chat_items || chat.mes_count || chat.message_count || '?';
            const chatName = chat.file_name.replace('.jsonl', '');

            return `
                <div class="chat-item ${isActive ? 'active' : ''}" data-chat="${CoreAPI.escapeHtml(chat.file_name)}">
                    <div class="chat-item-icon">
                        <i class="fa-solid fa-message"></i>
                    </div>
                    <div class="chat-item-info">
                        <div class="chat-item-name">${CoreAPI.escapeHtml(chatName)}</div>
                        <div class="chat-item-meta">
                            <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                            <span><i class="fa-solid fa-comment"></i> ${messageCount} messages</span>
                            ${isActive ? '<span style="color: var(--accent);"><i class="fa-solid fa-check-circle"></i> Current</span>' : ''}
                        </div>
                    </div>
                    <div class="chat-item-actions">
                        <button class="chat-action-btn" title="Open chat" data-action="open"><i class="fa-solid fa-arrow-right"></i></button>
                        <button class="chat-action-btn danger" title="Delete chat" data-action="delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (e) {
        chatsList.innerHTML = `<div class="no-chats"><i class="fa-solid fa-exclamation-triangle"></i><p>Error: ${CoreAPI.escapeHtml(e.message)}</p></div>`;
    }
}

/**
 * Open a specific chat in the main SillyTavern window
 * @param {Object} char - Character object
 * @param {string} chatFile - Chat filename (with .jsonl extension)
 */
async function openChat(char, chatFile) {
    try {
        const chatName = chatFile.replace('.jsonl', '');

        CoreAPI.showToast("Opening chat...", "success");

        // Close any open modals
        CoreAPI.hideElement('chatPreviewModal');
        document.querySelector('.modal-overlay')?.classList.add('hidden');

        // Register gallery folder override for media localization
        if (CoreAPI.getSetting('uniqueGalleryFolders') && CoreAPI.getCharacterGalleryId(char)) {
            CoreAPI.registerGalleryFolderOverride(char, true);
        }

        if (window.opener && !window.opener.closed) {
            let context = null;
            let mainCharacters = [];

            if (window.opener.SillyTavern && window.opener.SillyTavern.getContext) {
                context = window.opener.SillyTavern.getContext();
                mainCharacters = context.characters || [];
            } else if (window.opener.characters) {
                mainCharacters = window.opener.characters;
            }

            const characterIndex = mainCharacters.findIndex(c => c.avatar === char.avatar);

            if (characterIndex !== -1 && context) {
                await context.selectCharacterById(characterIndex);
                await new Promise(r => setTimeout(r, 200));

                if (context.openChat) {
                    await context.openChat(chatName);
                } else if (window.opener.jQuery) {
                    const $ = window.opener.jQuery;
                    const chatItems = $('#past_chats_popup .select_chat_block_wrapper');
                    chatItems.each(function() {
                        if ($(this).attr('file_name') === chatName) {
                            $(this).trigger('click');
                        }
                    });
                }

                return;
            }
        }

        // Fallback: open in main window
        CoreAPI.showToast("Opening in main window...", "info");
        if (window.opener && !window.opener.closed) {
            window.opener.location.href = `/?character=${encodeURIComponent(char.avatar)}`;
            window.opener.focus();
        }
    } catch (e) {
        console.error('openChat error:', e);
        CoreAPI.showToast("Could not open chat: " + e.message, "error");
    }
}

/**
 * Delete a chat file (used from character modal chats tab)
 * @param {Object} char - Character object
 * @param {string} chatFile - Chat filename
 */
async function deleteChat(char, chatFile) {
    if (!confirm(`Are you sure you want to delete this chat?\n\n${chatFile}\n\nThis cannot be undone!`)) {
        return;
    }

    try {
        const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_DELETE, 'POST', {
            chatfile: chatFile,
            avatar_url: char.avatar
        });

        if (response.ok) {
            CoreAPI.showToast("Chat deleted", "success");
            fetchCharacterChats(char); // Refresh list
        } else {
            CoreAPI.showToast("Failed to delete chat", "error");
        }
    } catch (e) {
        CoreAPI.showToast("Error deleting chat: " + e.message, "error");
    }
}

/**
 * Create a new chat for a character
 * @param {Object} char - Character object
 */
async function createNewChat(char) {
    try {
        if (await CoreAPI.loadCharInMain(char, true)) {
            CoreAPI.showToast("Creating new chat...", "success");
        }
    } catch (e) {
        CoreAPI.showToast("Could not create new chat: " + e.message, "error");
    }
}

// ========================================
// TOP-LEVEL CHATS VIEW
// ========================================

/**
 * Initialize all event handlers for the chats view
 */
function initChatsView() {
    // View Toggle Handlers
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const view = btn.dataset.view;
            CoreAPI.debugLog('View toggle clicked:', view);
            CoreAPI.switchView(view);
        });
    });

    // Register chats lazy-load: load on first visit
    CoreAPI.onViewEnter('chats', () => {
        if (allChats.length === 0) {
            loadAllChats();
        }
    });

    // Chats Sort Select
    CoreAPI.onElement('chatsSortSelect', 'change', (e) => {
        currentChatSort = e.target.value;
        renderChats();
    });

    // Grouping Toggle - just re-render, don't reload
    document.querySelectorAll('.grouping-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.grouping-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentGrouping = btn.dataset.group;
            renderChats();
        });
    });

    // Refresh Chats Button - force full refresh
    CoreAPI.onElement('refreshChatsViewBtn', 'click', () => {
        clearChatCache();
        allChats = [];
        loadAllChats(true);
    });

    // Chat Preview Modal handlers
    CoreAPI.onElement('chatPreviewClose', 'click', () => CoreAPI.hideModal('chatPreviewModal'));

    CoreAPI.onElement('chatPreviewOpenBtn', 'click', () => {
        if (currentPreviewChat) {
            openChatInST(currentPreviewChat);
        }
    });

    CoreAPI.onElement('chatPreviewDeleteBtn', 'click', () => {
        if (currentPreviewChat) {
            deleteChatFromView(currentPreviewChat);
        }
    });

    // Close modal on overlay click
    CoreAPI.onElement('chatPreviewModal', 'click', (e) => {
        if (e.target.id === 'chatPreviewModal') {
            CoreAPI.hideModal('chatPreviewModal');
        }
    });

    // Search input should also filter chats when in chats view (debounced)
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            if (CoreAPI.getCurrentView() === 'chats') {
                renderChats();
            }
        }, 150));
    }

    // Delegated click handler for modal chats tab (per-character chat list)
    const chatsList = document.getElementById('chatsList');
    if (chatsList) {
        chatsList.addEventListener('click', (e) => {
            const item = e.target.closest('.chat-item');
            if (!item || !_modalChatsChar) return;
            const chatFile = item.dataset.chat;

            const actionBtn = e.target.closest('.chat-action-btn');
            if (actionBtn) {
                e.stopPropagation();
                const action = actionBtn.dataset.action;
                if (action === 'open') openChat(_modalChatsChar, chatFile);
                else if (action === 'delete') deleteChat(_modalChatsChar, chatFile);
                return;
            }

            openChat(_modalChatsChar, chatFile);
        });
    }

    // Delegated click handlers for flat chat cards
    const chatsGrid = document.getElementById('chatsGrid');
    if (chatsGrid) {
        chatsGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.chat-card');
            if (!card) return;
            const chat = findChatByElement(card);
            if (!chat) return;

            const charNameEl = e.target.closest('.clickable-char-name');
            if (charNameEl) {
                e.stopPropagation();
                openCharacterDetailsFromChats(chat.character);
                return;
            }

            const actionBtn = e.target.closest('.chat-card-action');
            if (actionBtn) {
                e.stopPropagation();
                if (actionBtn.dataset.action === 'open') openChatInST(chat);
                else if (actionBtn.dataset.action === 'delete') deleteChatFromView(chat);
                return;
            }

            openChatPreview(chat);
        });
    }

    // Delegated click handlers for grouped chat view
    const groupedView = document.getElementById('chatsGroupedView');
    if (groupedView) {
        groupedView.addEventListener('click', (e) => {
            // Group header collapse toggle
            const header = e.target.closest('.chat-group-header');
            if (header) {
                const charNameEl = e.target.closest('.clickable-char-name');
                if (charNameEl) {
                    e.stopPropagation();
                    const charAvatar = header.closest('.chat-group')?.dataset.charAvatar;
                    const chars = CoreAPI.getAllCharacters();
                    const char = chars.find(c => c.avatar === charAvatar);
                    if (char) openCharacterDetailsFromChats(char);
                    return;
                }
                header.closest('.chat-group')?.classList.toggle('collapsed');
                return;
            }

            // Chat items inside groups
            const item = e.target.closest('.chat-group-item');
            if (!item) return;
            const group = item.closest('.chat-group');
            const chatFile = item.dataset.chatFile;
            const charAvatar = group?.dataset.charAvatar;
            const chat = allChats.find(c => c.file_name === chatFile && c.charAvatar === charAvatar);
            if (!chat) return;

            const actionBtn = e.target.closest('.chat-card-action');
            if (actionBtn) {
                e.stopPropagation();
                if (actionBtn.dataset.action === 'open') openChatInST(chat);
                else if (actionBtn.dataset.action === 'delete') deleteChatFromView(chat);
                return;
            }

            openChatPreview(chat);
        });
    }

    CoreAPI.debugLog('Chats view initialized');
}

/**
 * Look up a chat object from allChats via a card/item element's data attributes
 */
function findChatByElement(el) {
    const chatFile = el.dataset.chatFile;
    const charAvatar = el.dataset.charAvatar;
    return allChats.find(c => c.file_name === chatFile && c.charAvatar === charAvatar) || null;
}

// ========================================
// LOADING & FETCHING
// ========================================

/**
 * Load all chats - uses cache first, then background refresh if stale
 * @param {boolean} forceRefresh - Bypass cache and load fresh
 */
async function loadAllChats(forceRefresh = false) {
    const chatsGrid = document.getElementById('chatsGrid');
    const allCharacters = CoreAPI.getAllCharacters();

    // Try to show cached data first for instant UI
    const cached = getCachedChats();
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    const isCacheValid = cached && cached.chats && cached.chats.length > 0;

    if (isCacheValid && !forceRefresh) {
        CoreAPI.debugLog(`[ChatsCache] Using cached data (${Math.round(cacheAge/1000)}s old, ${cached.chats.length} chats)`);

        // Reconstruct allChats from cache with character references
        allChats = cached.chats.map(cachedChat => {
            const char = allCharacters.find(c => c.avatar === cachedChat.charAvatar);
            if (!char) return null;
            return {
                ...cachedChat,
                character: char,
                mes_count: cachedChat.chat_items
            };
        }).filter(Boolean);

        // Render immediately from cache
        renderChats();

        // If cache is old, do background refresh
        if (cacheAge > CHATS_CACHE_MAX_AGE) {
            CoreAPI.debugLog('[ChatsCache] Cache is stale, refreshing in background...');
            showRefreshIndicator(true);
            await fetchFreshChats(true);
            showRefreshIndicator(false);
        }

        return;
    }

    // No cache or force refresh - do full load
    CoreAPI.renderLoadingState(chatsGrid, 'Loading all chats...', 'chats-loading');
    await fetchFreshChats(false);
}

function showRefreshIndicator(show) {
    let indicator = document.getElementById('chatsRefreshIndicator');
    if (show) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'chatsRefreshIndicator';
            indicator.className = 'chats-refresh-indicator';
            indicator.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Checking for updates...';
            document.getElementById('chatsView')?.prepend(indicator);
        }
    } else {
        indicator?.remove();
    }
}

/**
 * Fetch fresh chats from the server for all characters
 * @param {boolean} isBackground - Whether this is a background refresh
 */
async function fetchFreshChats(isBackground = false) {
    const chatsGrid = document.getElementById('chatsGrid');
    const allCharacters = CoreAPI.getAllCharacters();

    try {
        const newChats = [];

        for (const char of allCharacters) {
            try {
                const response = await CoreAPI.apiRequest(ENDPOINTS.CHARACTERS_CHATS, 'POST', {
                    avatar_url: char.avatar,
                    metadata: true
                });

                if (response.ok) {
                    const chats = await response.json();
                    if (chats && chats.length && !chats.error) {
                        chats.forEach(chat => {
                            const cachedChat = allChats.find(c =>
                                c.file_name === chat.file_name && c.charAvatar === char.avatar
                            );

                            const cachedMsgCount = cachedChat?.chat_items || cachedChat?.mes_count || 0;
                            const newMsgCount = chat.chat_items || chat.mes_count || 0;
                            const canReusePreview = cachedChat?.preview && cachedMsgCount === newMsgCount;

                            newChats.push({
                                ...chat,
                                character: char,
                                charName: char.name,
                                charAvatar: char.avatar,
                                preview: canReusePreview ? cachedChat.preview : null,
                                models: canReusePreview ? (cachedChat.models || null) : null
                            });
                        });
                    }
                }
            } catch (e) {
                console.warn(`Failed to load chats for ${char.name}:`, e);
            }
        }

        if (newChats.length === 0 && !isBackground) {
            chatsGrid.innerHTML = `
                <div class="chats-empty">
                    <i class="fa-solid fa-comments"></i>
                    <h3>No Chats Found</h3>
                    <p>Start a conversation with a character to see it here.</p>
                </div>
            `;
            return;
        }

        allChats = newChats;
        renderChats();

        // Load previews for chats that need them, and model data for chats missing it
        const chatsNeedingLoad = allChats.filter(c => c.preview === null || !c.models);
        CoreAPI.debugLog(`[ChatsCache] ${chatsNeedingLoad.length} of ${allChats.length} chats need loading (preview or model data)`);

        if (chatsNeedingLoad.length > 0) {
            await loadChatPreviews(chatsNeedingLoad);
        }

        saveChatCache(allChats);

    } catch (e) {
        console.error('Failed to load chats:', e);
        if (!isBackground) {
            chatsGrid.innerHTML = `
                <div class="chats-empty">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    <h3>Error Loading Chats</h3>
                    <p>${CoreAPI.escapeHtml(e.message)}</p>
                </div>
            `;
        }
    }
}

/**
 * Fetch chat previews in parallel batches
 * @param {Array|null} chatsToLoad - Specific chats to load previews for, or null for all
 */
async function loadChatPreviews(chatsToLoad = null) {
    const BATCH_SIZE = 5;
    const targetChats = chatsToLoad || allChats;
    CoreAPI.debugLog(`[ChatPreviews] Starting to load previews for ${targetChats.length} chats`);

    for (let i = 0; i < targetChats.length; i += BATCH_SIZE) {
        const batch = targetChats.slice(i, i + BATCH_SIZE);
        CoreAPI.debugLog(`[ChatPreviews] Processing batch ${i/BATCH_SIZE + 1}, chats ${i} to ${i + batch.length}`);

        await Promise.all(batch.map(async (chat) => {
            try {
                const chatFileName = chat.file_name.replace('.jsonl', '');

                const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
                    ch_name: chat.character.name,
                    file_name: chatFileName,
                    avatar_url: chat.character.avatar
                });

                CoreAPI.debugLog(`[ChatPreviews] ${chat.file_name}: response status ${response.status}`);

                if (response.ok) {
                    const messages = await response.json();
                    CoreAPI.debugLog(`[ChatPreviews] ${chat.file_name}: got ${messages?.length || 0} messages`);

                    // Extract model usage stats (free — we already have all messages)
                    chat.models = extractModelStats(messages);

                    if (messages && messages.length > 0) {
                        const lastMsg = [...messages].reverse().find(m => !m.is_system && m.mes);
                        if (lastMsg) {
                            const previewText = lastMsg.mes.substring(0, 150);
                            chat.preview = (lastMsg.is_user ? 'You: ' : '') + previewText + (lastMsg.mes.length > 150 ? '...' : '');
                            updateChatCardPreview(chat);
                        } else {
                            chat.preview = '';
                            updateChatCardPreview(chat);
                        }
                    } else {
                        chat.preview = '';
                        updateChatCardPreview(chat);
                    }
                } else {
                    console.warn(`[ChatPreviews] ${chat.file_name}: HTTP error ${response.status}`);
                    chat.preview = '';
                    updateChatCardPreview(chat);
                }
            } catch (e) {
                console.warn(`[ChatPreviews] ${chat.file_name}: Exception:`, e);
                chat.preview = '';
                updateChatCardPreview(chat);
            }
        }));
    }

    CoreAPI.debugLog(`[ChatPreviews] Finished loading all previews`);
}

/**
 * Update a chat card's preview text in the DOM
 * @param {Object} chat - Chat object
 */
function updateChatCardPreview(chat) {
    const card = document.querySelector(`.chat-card[data-chat-file="${CSS.escape(chat.file_name)}"][data-char-avatar="${CSS.escape(chat.charAvatar)}"]`);
    if (card) {
        const previewEl = card.querySelector('.chat-card-preview');
        if (previewEl && chat.preview) {
            previewEl.textContent = chat.preview;
        }
        // Insert model badge if not already present
        if (chat.models && !card.querySelector('.chat-model-badge')) {
            const metaEl = card.querySelector('.chat-card-meta');
            if (metaEl) metaEl.insertAdjacentHTML('beforeend', buildModelBadgeHtml(chat.models));
        }
    }

    // Also update in grouped view
    const groupItem = document.querySelector(`.chat-group-item[data-chat-file="${CSS.escape(chat.file_name)}"]`);
    if (groupItem) {
        if (chat.models && !groupItem.querySelector('.chat-model-badge')) {
            const metaEl = groupItem.querySelector('.chat-group-item-meta');
            if (metaEl) metaEl.insertAdjacentHTML('beforeend', buildModelBadgeHtml(chat.models));
        }
    }
}

// ========================================
// RENDERING
// ========================================

function renderChats() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
    let filteredChats = allChats;

    if (searchTerm) {
        filteredChats = allChats.filter(chat => {
            const chatName = (chat.file_name || '').toLowerCase();
            const charName = (chat.charName || '').toLowerCase();
            return chatName.includes(searchTerm) || charName.includes(searchTerm);
        });
    }

    filteredChats = sortChats(filteredChats);

    if (currentGrouping === 'flat') {
        renderFlatChats(filteredChats);
    } else {
        renderGroupedChats(filteredChats);
    }
}

function sortChats(chats) {
    const sorted = [...chats];

    switch (currentChatSort) {
        case 'recent':
            sorted.sort((a, b) => {
                const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
                const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
                return dateB - dateA;
            });
            break;
        case 'oldest':
            sorted.sort((a, b) => {
                const dateA = a.last_mes ? new Date(a.last_mes) : new Date(0);
                const dateB = b.last_mes ? new Date(b.last_mes) : new Date(0);
                return dateA - dateB;
            });
            break;
        case 'char_asc':
            sorted.sort((a, b) => (a.charName || '').localeCompare(b.charName || ''));
            break;
        case 'char_desc':
            sorted.sort((a, b) => (b.charName || '').localeCompare(a.charName || ''));
            break;
        case 'most_messages':
            sorted.sort((a, b) => (b.chat_items || b.mes_count || 0) - (a.chat_items || a.mes_count || 0));
            break;
        case 'least_messages':
            sorted.sort((a, b) => (a.chat_items || a.mes_count || 0) - (b.chat_items || b.mes_count || 0));
            break;
        case 'longest_chat':
            sorted.sort((a, b) => (b.chat_items || b.mes_count || 0) - (a.chat_items || a.mes_count || 0));
            break;
        case 'shortest_chat':
            sorted.sort((a, b) => (a.chat_items || a.mes_count || 0) - (b.chat_items || b.mes_count || 0));
            break;
        case 'most_chats': {
            const charChatCounts = {};
            sorted.forEach(c => {
                charChatCounts[c.charAvatar] = (charChatCounts[c.charAvatar] || 0) + 1;
            });
            sorted.sort((a, b) => (charChatCounts[b.charAvatar] || 0) - (charChatCounts[a.charAvatar] || 0));
            break;
        }
    }

    return sorted;
}

function renderFlatChats(chats) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');

    chatsGrid.classList.remove('hidden');
    groupedView.classList.add('hidden');

    if (chats.length === 0) {
        chatsGrid.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Matching Chats</h3>
                <p>Try a different search term.</p>
            </div>
        `;
        return;
    }

    chatsGrid.innerHTML = chats.map(chat => createChatCard(chat)).join('');
}

function renderGroupedChats(chats) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');

    chatsGrid.classList.add('hidden');
    groupedView.classList.remove('hidden');

    // Group by character
    const groups = {};
    chats.forEach(chat => {
        const key = chat.charAvatar;
        if (!groups[key]) {
            groups[key] = {
                character: chat.character,
                chats: []
            };
        }
        groups[key].chats.push(chat);
    });

    let groupKeys = Object.keys(groups);
    if (currentChatSort === 'most_chats') {
        groupKeys.sort((a, b) => groups[b].chats.length - groups[a].chats.length);
    } else if (currentChatSort === 'char_asc') {
        groupKeys.sort((a, b) => (groups[a].character.name || '').localeCompare(groups[b].character.name || ''));
    } else if (currentChatSort === 'char_desc') {
        groupKeys.sort((a, b) => (groups[b].character.name || '').localeCompare(groups[a].character.name || ''));
    }

    if (groupKeys.length === 0) {
        groupedView.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Matching Chats</h3>
                <p>Try a different search term.</p>
            </div>
        `;
        return;
    }

    groupedView.innerHTML = groupKeys.map(key => {
        const group = groups[key];
        const char = group.character;
        const avatarUrl = CoreAPI.getCharacterAvatarUrl(char.avatar);

        const avatarHtml = avatarUrl
            ? `<img src="${avatarUrl}" alt="${CoreAPI.escapeHtml(char.name)}" class="chat-group-avatar" onerror="this.src='/img/ai4.png'">`
            : `<div class="chat-group-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;

        return `
            <div class="chat-group" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}">
                <div class="chat-group-header">
                    ${avatarHtml}
                    <div class="chat-group-info">
                        <div class="chat-group-name clickable-char-name" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}" title="View character details">${CoreAPI.escapeHtml(char.name)}</div>
                        <div class="chat-group-count">${group.chats.length} chat${group.chats.length !== 1 ? 's' : ''}</div>
                    </div>
                    <i class="fa-solid fa-chevron-down chat-group-toggle"></i>
                </div>
                <div class="chat-group-content">
                    ${group.chats.map(chat => createGroupedChatItem(chat)).join('')}
                </div>
            </div>
        `;
    }).join('');
}



// ========================================
// MODEL EXTRACTION
// ========================================

/**
 * Extract AI model usage stats from chat messages
 * @param {Array} messages - Array of chat message objects
 * @returns {Object|null} Map of model names to message counts, or null if no model data
 */
function extractModelStats(messages) {
    if (!messages || !messages.length) return null;
    const counts = {};
    let total = 0;
    for (const msg of messages) {
        if (msg.is_user || msg.is_system) continue;
        const model = msg.extra?.model;
        if (model) {
            counts[model] = (counts[model] || 0) + 1;
            total++;
        }
    }
    return total > 0 ? counts : null;
}

/**
 * Get a short display name for a model
 * e.g. "openrouter/anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet"
 */
function shortModelName(model) {
    if (!model) return '?';
    const parts = model.split('/');
    return parts[parts.length - 1] || model;
}

/**
 * Get the dominant (most-used) model from a stats map
 * @param {Object} models - { modelName: count, ... }
 * @returns {{ name: string, count: number }} Top model
 */
function getDominantModel(models) {
    if (!models) return null;
    let top = null;
    for (const [name, count] of Object.entries(models)) {
        if (!top || count > top.count) top = { name, count };
    }
    return top;
}

/**
 * Build HTML for the model badge with tooltip
 * @param {Object} models - { modelName: count, ... }
 * @returns {string} HTML string
 */
function buildModelBadgeHtml(models) {
    if (!models) return '';
    const dominant = getDominantModel(models);
    if (!dominant) return '';

    const total = Object.values(models).reduce((a, b) => a + b, 0);
    const sorted = Object.entries(models).sort((a, b) => b[1] - a[1]);
    const tooltipLines = sorted.map(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        return `${shortModelName(name)}: ${pct}% (${count})`;
    });

    return `<span class="chat-model-badge" title="${CoreAPI.escapeHtml(tooltipLines.join('\n'))}">
        <i class="fa-solid fa-microchip"></i> ${CoreAPI.escapeHtml(shortModelName(dominant.name))}
    </span>`;
}

// ========================================
// CARD / ITEM CREATION
// ========================================

function createChatCard(chat) {
    const char = chat.character;
    const avatarUrl = CoreAPI.getCharacterAvatarUrl(char.avatar);
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    const messageCount = chat.chat_items || chat.mes_count || chat.message_count || 0;
    const isActive = char.chat === chatName;

    let previewHtml;
    if (chat.preview === null) {
        previewHtml = '<i class="fa-solid fa-spinner fa-spin" style="opacity: 0.5;"></i> <span style="opacity: 0.5;">Loading preview...</span>';
    } else if (chat.preview) {
        previewHtml = CoreAPI.escapeHtml(chat.preview);
    } else {
        previewHtml = '<span style="opacity: 0.5;">No messages</span>';
    }

    const avatarHtml = avatarUrl
        ? `<img src="${avatarUrl}" alt="${CoreAPI.escapeHtml(char.name)}" class="chat-card-avatar" onerror="this.src='/img/ai4.png'">`
        : `<div class="chat-card-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;

    return `
        <div class="chat-card ${isActive ? 'active' : ''}" data-chat-file="${CoreAPI.escapeHtml(chat.file_name)}" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}">
            <div class="chat-card-header">
                ${avatarHtml}
                <div class="chat-card-char-info">
                    <div class="chat-card-char-name clickable-char-name" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}" title="View character details">${CoreAPI.escapeHtml(char.name)}</div>
                    <div class="chat-card-chat-name">${CoreAPI.escapeHtml(chatName)}</div>
                </div>
            </div>
            <div class="chat-card-body">
                <div class="chat-card-preview">${previewHtml}</div>
            </div>
            <div class="chat-card-footer">
                <div class="chat-card-meta">
                    <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                    <span><i class="fa-solid fa-comment"></i> ${messageCount}</span>
                    ${buildModelBadgeHtml(chat.models)}
                </div>
                <div class="chat-card-actions">
                    <button class="chat-card-action" data-action="open" title="Open in SillyTavern">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </button>
                    <button class="chat-card-action danger" data-action="delete" title="Delete chat">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function createGroupedChatItem(chat) {
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    const messageCount = chat.chat_items || chat.mes_count || chat.message_count || 0;

    let previewText;
    if (chat.preview === null) {
        previewText = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    } else if (chat.preview) {
        previewText = CoreAPI.escapeHtml(chat.preview);
    } else {
        previewText = '<span class="no-preview">No messages</span>';
    }

    return `
        <div class="chat-group-item" data-chat-file="${CoreAPI.escapeHtml(chat.file_name)}">
            <div class="chat-group-item-icon"><i class="fa-solid fa-message"></i></div>
            <div class="chat-group-item-info">
                <div class="chat-group-item-name">${CoreAPI.escapeHtml(chatName)}</div>
                <div class="chat-group-item-preview">${previewText}</div>
                <div class="chat-group-item-meta">
                    <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                    <span><i class="fa-solid fa-comment"></i> ${messageCount}</span>
                    ${buildModelBadgeHtml(chat.models)}
                </div>
            </div>
            <div class="chat-group-item-actions">
                <button class="chat-card-action" data-action="open" title="Open in SillyTavern">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </button>
                <button class="chat-card-action danger" data-action="delete" title="Delete chat">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

// ========================================
// CHAT PREVIEW MODAL
// ========================================

/**
 * Open the chat preview modal showing all messages
 * @param {Object} chat - Chat object with file_name, character, etc.
 */
async function openChatPreview(chat) {
    currentPreviewChat = chat;
    currentPreviewChar = chat.character;

    const modal = document.getElementById('chatPreviewModal');
    const avatarImg = document.getElementById('chatPreviewAvatar');
    const title = document.getElementById('chatPreviewTitle');
    const charName = document.getElementById('chatPreviewCharName');
    const messageCount = document.getElementById('chatPreviewMessageCount');
    const date = document.getElementById('chatPreviewDate');
    const messagesContainer = document.getElementById('chatPreviewMessages');

    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const avatarUrl = CoreAPI.getCharacterAvatarUrl(chat.character.avatar) || '/img/ai4.png';

    avatarImg.src = avatarUrl;
    title.textContent = chatName;
    charName.textContent = chat.character.name;
    charName.className = 'clickable-char-name';
    charName.title = 'View character details';
    charName.style.cursor = 'pointer';
    charName.onclick = (e) => {
        e.preventDefault();
        openCharacterDetailsFromChats(chat.character);
    };
    messageCount.textContent = chat.chat_items || chat.mes_count || '?';
    date.textContent = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';

    // Show model badge in preview header if available
    let modelsContainer = document.getElementById('chatPreviewModels');
    if (!modelsContainer) {
        modelsContainer = document.createElement('span');
        modelsContainer.id = 'chatPreviewModels';
        const metaEl = document.querySelector('#chatPreviewModal .chat-preview-meta');
        if (metaEl) metaEl.appendChild(modelsContainer);
    }
    modelsContainer.innerHTML = chat.models ? ' • ' + buildModelBadgeHtml(chat.models) : '';

    CoreAPI.renderLoadingState(messagesContainer, 'Loading messages...', 'chats-loading');

    modal.classList.remove('hidden');

    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');

        CoreAPI.debugLog(`[ChatPreview] Loading chat: ${chatFileName} for ${chat.character.name}`);

        const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
            ch_name: chat.character.name,
            file_name: chatFileName,
            avatar_url: chat.character.avatar
        });

        CoreAPI.debugLog(`[ChatPreview] Response status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ChatPreview] Error response:`, errorText);
            throw new Error(`HTTP ${response.status}`);
        }

        const messages = await response.json();
        CoreAPI.debugLog(`[ChatPreview] Got ${messages?.length || 0} messages`);

        // Update model stats from full message data (more accurate than cached)
        const freshModels = extractModelStats(messages);
        if (freshModels) {
            chat.models = freshModels;
            const mc = document.getElementById('chatPreviewModels');
            if (mc) mc.innerHTML = ' • ' + buildModelBadgeHtml(freshModels);
        }

        renderChatMessages(messages, chat.character);

    } catch (e) {
        console.error('Failed to load chat:', e);
        messagesContainer.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <h3>Could Not Load Chat</h3>
                <p>${CoreAPI.escapeHtml(e.message)}</p>
            </div>
        `;
    }
}

function renderChatMessages(messages, character) {
    const container = document.getElementById('chatPreviewMessages');

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>Empty Chat</h3>
                <p>This chat has no messages.</p>
            </div>
        `;
        currentChatMessages = [];
        return;
    }

    currentChatMessages = messages;

    const avatarUrl = CoreAPI.getCharacterAvatarUrl(character.avatar) || '/img/ai4.png';

    container.innerHTML = messages.map((msg, index) => {
        const isUser = msg.is_user;
        const isSystem = msg.is_system;
        const name = msg.name || (isUser ? 'User' : character.name);
        const text = msg.mes || '';
        const time = msg.send_date ? new Date(msg.send_date).toLocaleString() : '';

        const formattedText = CoreAPI.formatRichText(text, character.name, true);

        // Skip rendering metadata-only messages (chat header)
        if (index === 0 && msg.chat_metadata && !msg.mes) {
            return '';
        }

        const isMetadata = msg.chat_metadata !== undefined;
        const actionButtons = isMetadata ? '' : `
            <div class="chat-message-actions">
                <button class="chat-msg-action-btn" data-action="edit" data-index="${index}" title="Edit message">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="chat-msg-action-btn danger" data-action="delete" data-index="${index}" title="Delete message">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;

        if (isSystem) {
            return `
                <div class="chat-message system" data-msg-index="${index}">
                    <div class="chat-message-content">
                        <div class="chat-message-text">${formattedText}</div>
                    </div>
                    ${actionButtons}
                </div>
            `;
        }

        return `
            <div class="chat-message ${isUser ? 'user' : 'assistant'}" data-msg-index="${index}">
                ${!isUser ? `<img src="${avatarUrl}" alt="" class="chat-message-avatar" onerror="this.style.display='none'">` : ''}
                <div class="chat-message-content">
                    <div class="chat-message-name">${CoreAPI.escapeHtml(name)}</div>
                    <div class="chat-message-text">${formattedText}</div>
                    ${time ? `<div class="chat-message-time">${time}</div>` : ''}
                </div>
                ${actionButtons}
            </div>
        `;
    }).join('');

    // Add event listeners for message actions
    container.querySelectorAll('.chat-msg-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const index = parseInt(btn.dataset.index, 10);

            if (action === 'edit') {
                editChatMessage(index);
            } else if (action === 'delete') {
                deleteChatMessage(index);
            }
        });
    });

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// ========================================
// CHAT ACTIONS (from preview modal / chats view)
// ========================================

async function openChatInST(chat) {
    openChat(chat.character, chat.file_name);
}

async function deleteChatFromView(chat) {
    if (!confirm(`Delete this chat?\n\n${chat.file_name}\n\nThis cannot be undone!`)) {
        return;
    }

    try {
        const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_DELETE, 'POST', {
            chatfile: chat.file_name,
            avatar_url: chat.character.avatar
        });

        if (response.ok) {
            CoreAPI.showToast('Chat deleted', 'success');

            const idx = allChats.findIndex(c => c.file_name === chat.file_name && c.charAvatar === chat.charAvatar);
            if (idx !== -1) {
                allChats.splice(idx, 1);
            }

            if (currentPreviewChat === chat) {
                document.getElementById('chatPreviewModal').classList.add('hidden');
            }

            renderChats();
        } else {
            CoreAPI.showToast('Failed to delete chat', 'error');
        }
    } catch (e) {
        CoreAPI.showToast('Error: ' + e.message, 'error');
    }
}

/**
 * Open character details modal from the Chats view
 */
function openCharacterDetailsFromChats(char) {
    if (!char) return;
    CoreAPI.openCharacterModal(char);
}

// ========================================
// MESSAGE EDITING / DELETING
// ========================================

/**
 * Edit a specific message in the current chat
 */
async function editChatMessage(messageIndex) {
    if (!currentPreviewChat || !currentChatMessages[messageIndex]) {
        CoreAPI.showToast('Message not found', 'error');
        return;
    }

    const msg = currentChatMessages[messageIndex];
    const currentText = msg.mes || '';

    const editModalHtml = `
        <div id="editMessageModal" class="modal-overlay">
            <div class="modal-glass" style="max-width: 600px; width: 90%;">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-pen"></i> Edit Message</h2>
                    <button class="close-btn" id="editMessageClose">&times;</button>
                </div>
                <div style="padding: 20px;">
                    <div class="edit-message-info" style="margin-bottom: 15px; font-size: 0.85rem; color: var(--text-secondary);">
                        <span><strong>${CoreAPI.escapeHtml(msg.name || (msg.is_user ? 'User' : currentPreviewChar?.name || 'Character'))}</strong></span>
                        ${msg.send_date ? `<span> \u2022 ${new Date(msg.send_date).toLocaleString()}</span>` : ''}
                    </div>
                    <textarea id="editMessageText" class="glass-input" style="width: 100%; min-height: 200px; resize: vertical;">${CoreAPI.escapeHtml(currentText)}</textarea>
                    <div style="display: flex; gap: 10px; margin-top: 15px; justify-content: flex-end;">
                        <button id="editMessageCancel" class="action-btn secondary">Cancel</button>
                        <button id="editMessageSave" class="action-btn primary"><i class="fa-solid fa-save"></i> Save</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    const existingModal = document.getElementById('editMessageModal');
    if (existingModal) existingModal.remove();
    document.body.insertAdjacentHTML('beforeend', editModalHtml);

    const editModal = document.getElementById('editMessageModal');
    const textarea = document.getElementById('editMessageText');

    setTimeout(() => textarea.focus(), 50);

    const closeEditModal = () => editModal.remove();

    document.getElementById('editMessageClose').onclick = closeEditModal;
    document.getElementById('editMessageCancel').onclick = closeEditModal;
    editModal.onclick = (e) => { if (e.target === editModal) closeEditModal(); };

    document.getElementById('editMessageSave').onclick = async () => {
        const newText = textarea.value;
        if (newText === currentText) {
            closeEditModal();
            return;
        }

        try {
            currentChatMessages[messageIndex].mes = newText;

            const success = await saveChatToServer(currentPreviewChat, currentChatMessages);

            if (success) {
                CoreAPI.showToast('Message updated', 'success');
                closeEditModal();
                renderChatMessages(currentChatMessages, currentPreviewChat.character);
                clearChatCache();
            } else {
                currentChatMessages[messageIndex].mes = currentText;
                CoreAPI.showToast('Failed to save changes', 'error');
            }
        } catch (e) {
            currentChatMessages[messageIndex].mes = currentText;
            CoreAPI.showToast('Error: ' + e.message, 'error');
        }
    };
}

/**
 * Delete a specific message from the current chat
 */
async function deleteChatMessage(messageIndex) {
    if (!currentPreviewChat || !currentChatMessages[messageIndex]) {
        CoreAPI.showToast('Message not found', 'error');
        return;
    }

    if (messageIndex === 0 && currentChatMessages[0]?.chat_metadata) {
        CoreAPI.showToast('Cannot delete chat metadata header', 'error');
        return;
    }

    const msg = currentChatMessages[messageIndex];
    const previewText = (msg.mes || '').substring(0, 100) + (msg.mes?.length > 100 ? '...' : '');

    if (!confirm(`Delete this message?\n\n"${previewText}"\n\nThis cannot be undone!`)) {
        return;
    }

    try {
        const deletedMsg = currentChatMessages[messageIndex];
        currentChatMessages.splice(messageIndex, 1);

        const success = await saveChatToServer(currentPreviewChat, currentChatMessages);

        if (success) {
            CoreAPI.showToast('Message deleted', 'success');
            renderChatMessages(currentChatMessages, currentPreviewChat.character);

            const countEl = document.getElementById('chatPreviewMessageCount');
            if (countEl) {
                countEl.textContent = currentChatMessages.length;
            }

            clearChatCache();
        } else {
            currentChatMessages.splice(messageIndex, 0, deletedMsg);
            CoreAPI.showToast('Failed to delete message', 'error');
        }
    } catch (e) {
        CoreAPI.showToast('Error: ' + e.message, 'error');
    }
}

/**
 * Save the entire chat array to the server
 */
async function saveChatToServer(chat, messages) {
    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');

        const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_SAVE, 'POST', {
            ch_name: chat.character.name,
            file_name: chatFileName,
            avatar_url: chat.character.avatar,
            chat: messages
        });

        if (response.ok) {
            const result = await response.json();
            return result.ok === true;
        } else {
            const err = await response.text();
            console.error('Failed to save chat:', err);
            return false;
        }
    } catch (e) {
        console.error('Error saving chat:', e);
        return false;
    }
}

// ========================================
// UTILITY (local debounce)
// ========================================

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ========================================
// PUBLIC API
// ========================================

/**
 * Get current view state
 * @returns {string} Current view ('characters', 'chats', 'chub')
 */
// ========================================
// MODULE INIT & EXPORTS
// ========================================

function init() {
    // Initialize chats view handlers
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatsView);
    } else {
        initChatsView();
    }
}

export default {
    init,

    // Modal chats tab
    fetchCharacterChats,
    openChat,
    deleteChat,
    createNewChat,

    // Top-level chats view
    initChatsView,
    loadAllChats,
    renderChats,
    clearChatCache,

    // Preview modal
    openChatPreview,
};
