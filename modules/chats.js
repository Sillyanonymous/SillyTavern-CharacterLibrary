import * as CoreAPI from './core-api.js';

// ========================================
// API ENDPOINTS
// ========================================

const ENDPOINTS = {
    CHARACTERS_CHATS: '/characters/chats',
    CHATS_GET: '/chats/get',
    CHATS_SAVE: '/chats/save',
    CHATS_DELETE: '/chats/delete',
    CHATS_RECENT: '/chats/recent',
    GROUPS_ALL: '/groups/all',
    CHATS_GROUP_GET: '/chats/group/get',
    CHATS_GROUP_SAVE: '/chats/group/save',
    CHATS_GROUP_DELETE: '/chats/group/delete',
};

// ========================================
// MODULE STATE
// ========================================

let allChats = [];
let allGroups = new Map();
let currentGrouping = 'flat'; // 'flat' or 'grouped'
let currentChatSort = 'recent';
let currentPreviewChat = null;
let currentPreviewChar = null;
let currentChatMessages = [];
let _modalChatsChar = null;

// Pagination / lazy-load state
const PAGE_SIZE = 50;
let _renderedCount = 0;
let _sortedChats = [];
let _previewObserver = null;
let _sentinelObserver = null;

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
                models: c.models || null,
                isGroup: c.isGroup || false,
                groupId: c.groupId || null,
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

async function openChat(char, chatFile) {
    try {
        const chatName = chatFile.replace('.jsonl', '');

        CoreAPI.showToast("Opening chat...", "success");

        // Close any open modals
        CoreAPI.hideModal('chatPreviewModal');

        // Register gallery folder override for media localization
        if (CoreAPI.getSetting('uniqueGalleryFolders') && CoreAPI.getCharacterGalleryId(char)) {
            CoreAPI.registerGalleryFolderOverride(char, true);
        }

        const host = CoreAPI.getHostWindow();
        if (host) {
            let context = null;
            let mainCharacters = [];

            if (host.SillyTavern && host.SillyTavern.getContext) {
                context = host.SillyTavern.getContext();
                mainCharacters = context.characters || [];
            } else if (host.characters) {
                mainCharacters = host.characters;
            }

            const characterIndex = mainCharacters.findIndex(c => c.avatar === char.avatar);

            if (characterIndex !== -1 && context) {
                await context.selectCharacterById(characterIndex);

                if (context.openCharacterChat) {
                    await context.openCharacterChat(chatName);
                }

                if (CoreAPI.getIsEmbedded()) {
                    CoreAPI.closeEmbeddedPanel();
                }

                return;
            }
        }

        // Fallback: open in main window
        CoreAPI.showToast("Opening in main window...", "info");
        const fallbackHost = CoreAPI.getHostWindow();
        if (fallbackHost) {
            fallbackHost.location.href = `/?character=${encodeURIComponent(char.avatar)}`;
            fallbackHost.focus();
        }
    } catch (e) {
        console.error('openChat error:', e);
        CoreAPI.showToast("Could not open chat: " + e.message, "error");
    }
}

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

function initChatsView() {
    // Register chats lazy-load: load on first visit
    CoreAPI.onViewEnter('chats', () => {
        if (allChats.length === 0) {
            loadAllChats();
        }
    });

    CoreAPI.onViewExit('chats', () => {
        disconnectObservers();
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

    window.registerOverlay?.({
        id: 'chatPreviewModal',
        tier: 4,
        close: () => CoreAPI.hideModal('chatPreviewModal'),
    });

    window.registerOverlay?.({
        id: 'editMessageModal',
        tier: 3,
        static: false,
        close: (el) => el.remove(),
    });

    // Search input should also filter chats when in chats view (debounced)
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', CoreAPI.debounce(() => {
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
            if (charNameEl && !chat.isGroup) {
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
                    const chatGroup = header.closest('.chat-group');
                    const groupId = chatGroup?.dataset.groupId;
                    if (groupId) return; // Group chats have no character detail page
                    const charAvatar = chatGroup?.dataset.charAvatar;
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
            const chatGroup = item.closest('.chat-group');
            const chat = findChatByElement(item);
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

function findChatByElement(el) {
    const chatFile = el.dataset.chatFile;
    if (!chatFile) return null;
    const groupId = el.dataset.groupId;
    if (groupId) {
        return allChats.find(c => c.file_name === chatFile && c.isGroup && c.groupId === groupId) || null;
    }
    const charAvatar = el.dataset.charAvatar;
    return allChats.find(c => c.file_name === chatFile && c.charAvatar === charAvatar) || null;
}

// ========================================
// LOADING & FETCHING
// ========================================

async function loadAllChats(forceRefresh = false) {
    const chatsGrid = document.getElementById('chatsGrid');
    const allCharacters = CoreAPI.getAllCharacters();

    // Try to show cached data first for instant UI
    const cached = getCachedChats();
    const cacheAge = cached ? Date.now() - cached.timestamp : Infinity;
    const isCacheValid = cached && cached.chats && cached.chats.length > 0;

    if (isCacheValid && !forceRefresh) {
        CoreAPI.debugLog(`[ChatsCache] Using cached data (${Math.round(cacheAge/1000)}s old, ${cached.chats.length} chats)`);

        // Fetch groups so group chats can be reconstructed
        await fetchGroups();

        // Reconstruct allChats from cache with character/group references
        allChats = cached.chats.map(cachedChat => {
            if (cachedChat.isGroup) {
                const group = allGroups.get(cachedChat.groupId);
                if (!group) return null;
                return {
                    ...cachedChat,
                    group: group,
                    character: null,
                    charName: group.name,
                    mes_count: cachedChat.chat_items
                };
            }
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

let chatsFetchController = null;

async function fetchGroups() {
    try {
        const response = await CoreAPI.apiRequest(ENDPOINTS.GROUPS_ALL, 'POST', {});
        if (!response.ok) return;
        const groups = await response.json();
        allGroups.clear();
        for (const group of groups) {
            allGroups.set(group.id, group);
        }
        CoreAPI.debugLog(`[Chats] Fetched ${allGroups.size} groups`);
    } catch (e) {
        console.error('[Chats] Failed to fetch groups:', e);
    }
}

async function fetchFreshChats(isBackground = false) {
    chatsFetchController?.abort();
    chatsFetchController = new AbortController();
    const { signal } = chatsFetchController;

    const chatsGrid = document.getElementById('chatsGrid');
    const allCharacters = CoreAPI.getAllCharacters();

    try {
        await fetchGroups();
        if (signal.aborted) return;

        const response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_RECENT, 'POST', {});
        if (signal.aborted) return;

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const recentChats = await response.json();
        if (signal.aborted) return;

        const charMap = new Map();
        for (const char of allCharacters) {
            charMap.set(char.avatar, char);
        }

        const newChats = [];
        for (const chat of recentChats) {
            if (chat.group) {
                // Group chat entry
                const group = allGroups.get(chat.group);
                if (!group) continue;

                const cachedChat = allChats.find(c =>
                    c.file_name === chat.file_name && c.isGroup && c.groupId === chat.group
                );

                const cachedMsgCount = cachedChat?.chat_items || cachedChat?.mes_count || 0;
                const newMsgCount = chat.chat_items || 0;
                const canReuseCache = cachedChat && cachedMsgCount === newMsgCount;

                let preview = null;
                if (canReuseCache && cachedChat.preview) {
                    preview = cachedChat.preview;
                } else if (chat.mes && chat.mes !== '[The chat is empty]' && chat.mes !== '[The message is empty]') {
                    const truncated = chat.mes.substring(0, 150);
                    preview = truncated + (chat.mes.length > 150 ? '...' : '');
                }

                newChats.push({
                    file_name: chat.file_name,
                    last_mes: chat.last_mes,
                    chat_items: chat.chat_items || 0,
                    isGroup: true,
                    groupId: chat.group,
                    group: group,
                    character: null,
                    charName: group.name,
                    charAvatar: null,
                    preview: preview,
                    models: canReuseCache ? (cachedChat.models || null) : null,
                });
            } else if (chat.avatar) {
                // Individual character chat entry
                const char = charMap.get(chat.avatar);
                if (!char) continue;

                const cachedChat = allChats.find(c =>
                    c.file_name === chat.file_name && c.charAvatar === chat.avatar
                );

                const cachedMsgCount = cachedChat?.chat_items || cachedChat?.mes_count || 0;
                const newMsgCount = chat.chat_items || 0;
                const canReuseCache = cachedChat && cachedMsgCount === newMsgCount;

                let preview = null;
                if (canReuseCache && cachedChat.preview) {
                    preview = cachedChat.preview;
                } else if (chat.mes && chat.mes !== '[The chat is empty]' && chat.mes !== '[The message is empty]') {
                    const truncated = chat.mes.substring(0, 150);
                    preview = truncated + (chat.mes.length > 150 ? '...' : '');
                }

                newChats.push({
                    file_name: chat.file_name,
                    last_mes: chat.last_mes,
                    chat_items: chat.chat_items || 0,
                    isGroup: false,
                    character: char,
                    charName: char.name,
                    charAvatar: chat.avatar,
                    preview: preview,
                    models: canReuseCache ? (cachedChat.models || null) : null,
                });
            }
        }

        if (signal.aborted) return;
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

function updateChatCardPreview(chat) {
    const secondarySelector = chat.isGroup
        ? `[data-group-id="${CSS.escape(chat.groupId)}"]`
        : `[data-char-avatar="${CSS.escape(chat.charAvatar)}"]`;

    const card = document.querySelector(`.chat-card[data-chat-file="${CSS.escape(chat.file_name)}"]${secondarySelector}`);
    if (card) {
        const previewEl = card.querySelector('.chat-card-preview');
        if (previewEl) {
            if (chat.preview) {
                previewEl.textContent = chat.preview;
            } else {
                previewEl.innerHTML = '<span style="opacity: 0.5;">No messages</span>';
            }
        }
        if (chat.models && !card.querySelector('.chat-model-badge')) {
            const metaEl = card.querySelector('.chat-card-meta');
            if (metaEl) metaEl.insertAdjacentHTML('beforeend', buildModelBadgeHtml(chat.models));
        }
    }

    // Also update in grouped view
    const groupItem = document.querySelector(`.chat-group-item[data-chat-file="${CSS.escape(chat.file_name)}"]${secondarySelector}`);
    if (groupItem) {
        const previewEl = groupItem.querySelector('.chat-group-item-preview');
        if (previewEl) {
            if (chat.preview) {
                previewEl.textContent = chat.preview;
            } else {
                previewEl.innerHTML = '<span class="no-preview">No messages</span>';
            }
        }
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

    const chatRules = CoreAPI.getAdvFilterRulesForChats();
    if (chatRules.length > 0) {
        CoreAPI.resetChatFilterCaches();
        filteredChats = filteredChats.filter(chat => CoreAPI.evaluateChatAdvancedFilters(chat));
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
        case 'longest_chat':
            sorted.sort((a, b) => (b.chat_items || b.mes_count || 0) - (a.chat_items || a.mes_count || 0));
            break;
        case 'least_messages':
        case 'shortest_chat':
            sorted.sort((a, b) => (a.chat_items || a.mes_count || 0) - (b.chat_items || b.mes_count || 0));
            break;
        case 'most_chats': {
            const entityChatCounts = {};
            sorted.forEach(c => {
                const key = c.isGroup ? `_group:${c.groupId}` : c.charAvatar;
                entityChatCounts[key] = (entityChatCounts[key] || 0) + 1;
            });
            sorted.sort((a, b) => {
                const keyA = a.isGroup ? `_group:${a.groupId}` : a.charAvatar;
                const keyB = b.isGroup ? `_group:${b.groupId}` : b.charAvatar;
                return (entityChatCounts[keyB] || 0) - (entityChatCounts[keyA] || 0);
            });
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
    disconnectObservers();

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

    _sortedChats = chats;
    _renderedCount = 0;
    chatsGrid.innerHTML = '';

    appendFlatPage(chatsGrid);
    setupSentinelObserver(chatsGrid, 'flat');
    setupPreviewObserver();
}

function renderGroupedChats(chats) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');

    chatsGrid.classList.add('hidden');
    groupedView.classList.remove('hidden');
    disconnectObservers();

    // Group by entity (character or group chat)
    const entities = {};
    chats.forEach(chat => {
        const key = chat.isGroup ? `_group:${chat.groupId}` : chat.charAvatar;
        if (!entities[key]) {
            entities[key] = {
                isGroup: chat.isGroup,
                character: chat.character,
                group: chat.group,
                name: chat.charName,
                chats: []
            };
        }
        entities[key].chats.push(chat);
    });

    let entityKeys = Object.keys(entities);
    if (currentChatSort === 'most_chats') {
        entityKeys.sort((a, b) => entities[b].chats.length - entities[a].chats.length);
    } else if (currentChatSort === 'char_asc') {
        entityKeys.sort((a, b) => (entities[a].name || '').localeCompare(entities[b].name || ''));
    } else if (currentChatSort === 'char_desc') {
        entityKeys.sort((a, b) => (entities[b].name || '').localeCompare(entities[a].name || ''));
    }

    if (entityKeys.length === 0) {
        groupedView.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Matching Chats</h3>
                <p>Try a different search term.</p>
            </div>
        `;
        return;
    }

    groupedView.innerHTML = entityKeys.map(key => {
        const entity = entities[key];

        let avatarHtml, nameHtml, groupDataAttr;

        if (entity.isGroup) {
            avatarHtml = buildGroupAvatarHtml(entity.group, 'chat-group-avatar');
            nameHtml = `<div class="chat-group-name">${CoreAPI.escapeHtml(entity.name)} <span class="chat-group-badge"><i class="fa-solid fa-users"></i></span></div>`;
            groupDataAttr = `data-group-id="${CoreAPI.escapeHtml(entity.group.id)}"`;
        } else {
            const char = entity.character;
            const avatarUrl = CoreAPI.getCharacterAvatarUrl(char.avatar);
            avatarHtml = avatarUrl
                ? `<div class="chat-avatar-wrap chat-group-avatar-size"><img src="${avatarUrl}" alt="${CoreAPI.escapeHtml(char.name)}" class="chat-group-avatar" onload="this.parentElement.classList.add('loaded')" onerror="this.src='/img/ai4.png'"></div>`
                : `<div class="chat-group-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
            nameHtml = `<div class="chat-group-name clickable-char-name" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}" title="View character details">${CoreAPI.escapeHtml(char.name)}</div>`;
            groupDataAttr = `data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}"`;
        }

        return `
            <div class="chat-group" ${groupDataAttr}>
                <div class="chat-group-header">
                    ${avatarHtml}
                    <div class="chat-group-info">
                        ${nameHtml}
                        <div class="chat-group-count">${entity.chats.length} chat${entity.chats.length !== 1 ? 's' : ''}</div>
                    </div>
                    <i class="fa-solid fa-chevron-down chat-group-toggle"></i>
                </div>
                <div class="chat-group-content">
                    ${entity.chats.map(chat => createGroupedChatItem(chat)).join('')}
                </div>
            </div>
        `;
    }).join('');

    setupPreviewObserver();
}

// ========================================
// PAGINATION (FLAT VIEW)
// ========================================

function appendFlatPage(container) {
    const start = _renderedCount;
    const end = Math.min(start + PAGE_SIZE, _sortedChats.length);
    if (start >= end) return;

    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const tmp = document.createElement('template');
        tmp.innerHTML = createChatCard(_sortedChats[i]);
        fragment.appendChild(tmp.content.firstElementChild);
    }
    container.appendChild(fragment);
    _renderedCount = end;
}

function setupSentinelObserver(container, mode) {
    if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
    if (mode !== 'flat') return;

    let sentinel = document.getElementById('chatsSentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'chatsSentinel';
        sentinel.style.height = '1px';
        container.appendChild(sentinel);
    }

    _sentinelObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        if (_renderedCount >= _sortedChats.length) {
            _sentinelObserver.disconnect();
            sentinel.remove();
            return;
        }
        appendFlatPage(container);
        // Re-observe new cards for preview loading
        observeNewCards();
        // Move sentinel to end
        container.appendChild(sentinel);
    }, { rootMargin: '400px' });

    _sentinelObserver.observe(sentinel);
}

// ========================================
// LAZY PREVIEW LOADING (IntersectionObserver)
// ========================================

function setupPreviewObserver() {
    if (_previewObserver) _previewObserver.disconnect();

    _previewObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            _previewObserver.unobserve(el);
            lazyLoadPreview(el);
        }
    }, { rootMargin: '200px' });

    observeNewCards();
}

function observeNewCards() {
    if (!_previewObserver) return;
    // Observe flat cards that still need preview
    document.querySelectorAll('.chat-card[data-needs-preview="1"]').forEach(card => {
        _previewObserver.observe(card);
    });
    // Observe grouped items that still need preview
    document.querySelectorAll('.chat-group-item[data-needs-preview="1"]').forEach(item => {
        _previewObserver.observe(item);
    });
}

async function lazyLoadPreview(el) {
    const chat = findChatByElement(el);
    if (!chat || chat._previewLoading || (chat.preview !== null && chat.models)) return;
    chat._previewLoading = true;

    el.removeAttribute('data-needs-preview');

    try {
        const chatFileName = chat.file_name.replace('.jsonl', '');
        let response;

        if (chat.isGroup) {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GROUP_GET, 'POST', {
                id: chatFileName
            });
        } else {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
                ch_name: chat.character.name,
                file_name: chatFileName,
                avatar_url: chat.character.avatar
            });
        }

        if (response.ok) {
            const messages = await response.json();
            chat.models = extractModelStats(messages);

            if (messages && messages.length > 0) {
                const lastMsg = [...messages].reverse().find(m => !m.is_system && m.mes);
                if (lastMsg) {
                    const previewText = lastMsg.mes.substring(0, 150);
                    chat.preview = (lastMsg.is_user ? 'You: ' : '') + previewText + (lastMsg.mes.length > 150 ? '...' : '');
                } else {
                    chat.preview = '';
                }
            } else {
                chat.preview = '';
            }
        } else {
            chat.preview = '';
        }
    } catch {
        chat.preview = '';
    } finally {
        chat._previewLoading = false;
    }

    updateChatCardPreview(chat);
    saveChatCacheDebounced();
}

const saveChatCacheDebounced = CoreAPI.debounce(() => saveChatCache(allChats), 2000);

function disconnectObservers() {
    if (_previewObserver) { _previewObserver.disconnect(); _previewObserver = null; }
    if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
}

// ========================================
// MODEL EXTRACTION
// ========================================

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

function getDominantModel(models) {
    if (!models) return null;
    let top = null;
    for (const [name, count] of Object.entries(models)) {
        if (!top || count > top.count) top = { name, count };
    }
    return top;
}

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

function getGroupAvatarUrl(group) {
    if (group.avatar_url) return group.avatar_url;
    return null;
}

function buildGroupAvatarHtml(group, cssClass = 'chat-card-avatar') {
    const activeMembers = (group.members || []).filter(m => m && !(group.disabled_members || []).includes(m));
    const display = activeMembers.slice(0, 4);

    if (display.length === 0) {
        if (group.avatar_url) {
            return `<div class="chat-avatar-wrap ${cssClass}-size"><img src="${CoreAPI.escapeHtml(group.avatar_url)}" alt="${CoreAPI.escapeHtml(group.name)}" class="${cssClass}" onload="this.parentElement.classList.add('loaded')" onerror="this.src='/img/ai4.png'"></div>`;
        }
        return `<div class="${cssClass}-fallback"><i class="fa-solid fa-users"></i></div>`;
    }

    const count = display.length;
    const imgs = display.map(avatar => {
        const url = CoreAPI.escapeHtml(CoreAPI.getCharacterAvatarUrl(avatar) || '/img/ai4.png');
        return `<img src="${url}" alt="" onload="this.classList.add('loaded');this.parentElement.classList.add('loaded')" onerror="this.src='/img/ai4.png'">`;
    }).join('');

    return `<div class="chat-group-composite chat-group-composite-${count} ${cssClass}-size">${imgs}</div>`;
}

function chatDataAttrs(chat) {
    if (chat.isGroup) {
        return `data-chat-file="${CoreAPI.escapeHtml(chat.file_name)}" data-group-id="${CoreAPI.escapeHtml(chat.groupId)}"`;
    }
    return `data-chat-file="${CoreAPI.escapeHtml(chat.file_name)}" data-char-avatar="${CoreAPI.escapeHtml(chat.charAvatar)}"`;
}

function createChatCard(chat) {
    const chatName = (chat.file_name || '').replace('.jsonl', '');
    const lastDate = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';
    const messageCount = chat.chat_items || chat.mes_count || chat.message_count || 0;
    const needsPreview = chat.preview === null || !chat.models;

    let previewHtml;
    if (chat.preview === null) {
        previewHtml = '<span style="opacity: 0.5;">Loading preview...</span>';
    } else if (chat.preview) {
        previewHtml = CoreAPI.escapeHtml(chat.preview);
    } else {
        previewHtml = '<span style="opacity: 0.5;">No messages</span>';
    }

    let avatarHtml, displayName, nameAttrs, isActive;

    if (chat.isGroup) {
        avatarHtml = buildGroupAvatarHtml(chat.group, 'chat-card-avatar');
        displayName = chat.charName;
        nameAttrs = '';
        isActive = false;
    } else {
        const char = chat.character;
        const avatarUrl = CoreAPI.getCharacterAvatarUrl(char.avatar);
        avatarHtml = avatarUrl
            ? `<div class="chat-avatar-wrap chat-card-avatar-size"><img src="${avatarUrl}" alt="${CoreAPI.escapeHtml(char.name)}" class="chat-card-avatar" onload="this.parentElement.classList.add('loaded')" onerror="this.src='/img/ai4.png'"></div>`
            : `<div class="chat-card-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
        displayName = char.name;
        nameAttrs = `clickable-char-name" data-char-avatar="${CoreAPI.escapeHtml(char.avatar)}" title="View character details`;
        isActive = char.chat === chatName;
    }

    const groupBadge = chat.isGroup ? '<span class="chat-group-badge"><i class="fa-solid fa-users"></i> Group</span>' : '';

    return `
        <div class="chat-card ${isActive ? 'active' : ''} ${chat.isGroup ? 'group-chat' : ''}" ${chatDataAttrs(chat)}${needsPreview ? ' data-needs-preview="1"' : ''}>
            <div class="chat-card-header">
                ${avatarHtml}
                <div class="chat-card-char-info">
                    <div class="chat-card-char-name ${nameAttrs}"><span class="chat-card-char-name-text">${CoreAPI.escapeHtml(displayName)}</span>${groupBadge}</div>
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
    const needsPreview = chat.preview === null || !chat.models;

    let previewText;
    if (chat.preview === null) {
        previewText = '<span style="opacity: 0.5;">Loading...</span>';
    } else if (chat.preview) {
        previewText = CoreAPI.escapeHtml(chat.preview);
    } else {
        previewText = '<span class="no-preview">No messages</span>';
    }

    return `
        <div class="chat-group-item" ${chatDataAttrs(chat)}${needsPreview ? ' data-needs-preview="1"' : ''}>
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

async function openChatPreview(chat) {
    currentPreviewChat = chat;
    currentPreviewChar = chat.isGroup ? null : chat.character;

    const modal = document.getElementById('chatPreviewModal');
    const avatarImg = document.getElementById('chatPreviewAvatar');
    const title = document.getElementById('chatPreviewTitle');
    const charName = document.getElementById('chatPreviewCharName');
    const messageCount = document.getElementById('chatPreviewMessageCount');
    const date = document.getElementById('chatPreviewDate');
    const messagesContainer = document.getElementById('chatPreviewMessages');

    const chatName = (chat.file_name || '').replace('.jsonl', '');

    if (chat.isGroup) {
        const avatarContainer = avatarImg.parentElement;
        const compositeHtml = buildGroupAvatarHtml(chat.group, 'chat-preview-avatar');
        if (compositeHtml.startsWith('<div')) {
            avatarImg.style.display = 'none';
            avatarContainer.querySelector('.chat-group-composite')?.remove();
            avatarContainer.querySelector('.chat-avatar-wrap')?.remove();
            avatarImg.insertAdjacentHTML('afterend', compositeHtml);
        } else {
            avatarImg.style.display = '';
            avatarContainer.querySelector('.chat-group-composite')?.remove();
            avatarContainer.querySelector('.chat-avatar-wrap')?.remove();
            const srcMatch = compositeHtml.match(/src="([^"]+)"/);
            avatarImg.src = srcMatch ? srcMatch[1] : '/img/ai4.png';
        }
        title.textContent = chatName;
        charName.textContent = chat.charName;
        charName.className = '';
        charName.title = '';
        charName.style.cursor = 'default';
        charName.onclick = null;
    } else {
        avatarImg.style.display = '';
        avatarImg.parentElement.querySelector('.chat-group-composite')?.remove();
        avatarImg.parentElement.querySelector('.chat-avatar-wrap')?.remove();
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
    }

    messageCount.textContent = chat.chat_items || chat.mes_count || '?';
    date.textContent = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : 'Unknown';

    let modelsContainer = document.getElementById('chatPreviewModels');
    if (!modelsContainer) {
        modelsContainer = document.createElement('span');
        modelsContainer.id = 'chatPreviewModels';
        const metaEl = document.querySelector('#chatPreviewModal .chat-preview-meta');
        if (metaEl) metaEl.appendChild(modelsContainer);
    }
    modelsContainer.innerHTML = chat.models ? ' \u2022 ' + buildModelBadgeHtml(chat.models) : '';

    CoreAPI.renderLoadingState(messagesContainer, 'Loading messages...', 'chats-loading');
    modal.classList.remove('hidden');

    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        let response;

        if (chat.isGroup) {
            CoreAPI.debugLog(`[ChatPreview] Loading group chat: ${chatFileName} for group ${chat.charName}`);
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GROUP_GET, 'POST', {
                id: chatFileName
            });
        } else {
            CoreAPI.debugLog(`[ChatPreview] Loading chat: ${chatFileName} for ${chat.character.name}`);
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GET, 'POST', {
                ch_name: chat.character.name,
                file_name: chatFileName,
                avatar_url: chat.character.avatar
            });
        }

        CoreAPI.debugLog(`[ChatPreview] Response status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ChatPreview] Error response:`, errorText);
            throw new Error(`HTTP ${response.status}`);
        }

        const messages = await response.json();
        CoreAPI.debugLog(`[ChatPreview] Got ${messages?.length || 0} messages`);

        const freshModels = extractModelStats(messages);
        if (freshModels) {
            chat.models = freshModels;
            const mc = document.getElementById('chatPreviewModels');
            if (mc) mc.innerHTML = ' \u2022 ' + buildModelBadgeHtml(freshModels);
        }

        renderChatMessages(messages, chat.isGroup ? null : chat.character, chat.isGroup);

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

function renderChatMessages(messages, character, isGroupChat = false) {
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

    const charAvatarUrl = character ? (CoreAPI.getCharacterAvatarUrl(character.avatar) || '/img/ai4.png') : '/img/ai4.png';
    const charName = character?.name || 'Character';

    const formattedTexts = [];

    container.innerHTML = messages.map((msg, index) => {
        const isUser = msg.is_user;
        const isSystem = msg.is_system;
        const name = msg.name || (isUser ? 'User' : charName);
        const rawSwipeId = msg.swipe_id ?? 0;
        const swipeId = msg.swipes?.length > 1 ? Math.min(rawSwipeId, msg.swipes.length - 1) : 0;
        const text = msg.swipes?.length > 1 ? (msg.swipes[swipeId] || '') : (msg.mes || '');
        const time = getSwipeTimestamp(msg, swipeId);

        if (index === 0 && msg.chat_metadata && !msg.mes) {
            formattedTexts.push(null);
            return '';
        }

        formattedTexts.push(CoreAPI.formatRichText(text, charName, true));

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

        const swipeNav = msg.swipes?.length > 1 ? buildSwipeNavHtml(index, swipeId, msg.swipes.length) : '';

        if (isSystem) {
            return `
                <div class="chat-message system" data-msg-index="${index}">
                    <div class="chat-message-content">
                        <div class="chat-message-text"></div>
                    </div>
                    ${actionButtons}
                </div>
            `;
        }

        // Per-message avatar for group chats
        let msgAvatarUrl = charAvatarUrl;
        let nameClass = 'chat-message-name';
        let nameDataAttr = '';
        if (isGroupChat && !isUser && msg.original_avatar) {
            msgAvatarUrl = CoreAPI.getCharacterAvatarUrl(msg.original_avatar) || '/img/ai4.png';
            nameClass = 'chat-message-name clickable-char-name';
            nameDataAttr = ` data-char-avatar="${CoreAPI.escapeHtml(msg.original_avatar)}" title="View character details"`;
        }

        return `
            <div class="chat-message ${isUser ? 'user' : 'assistant'}" data-msg-index="${index}">
                ${!isUser ? `<img src="${msgAvatarUrl}" alt="" class="chat-message-avatar" onerror="this.style.display='none'">` : ''}
                <div class="chat-message-content">
                    <div class="${nameClass}"${nameDataAttr}>${CoreAPI.escapeHtml(name)}</div>
                    <div class="chat-message-text"></div>
                    ${swipeNav}
                    ${time ? `<div class="chat-message-time">${time}</div>` : ''}
                </div>
                ${actionButtons}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.chat-message-text').forEach(el => {
        const msgIndex = parseInt(el.closest('.chat-message').dataset.msgIndex, 10);
        if (formattedTexts[msgIndex]) el.innerHTML = formattedTexts[msgIndex];
    });

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

    container.querySelectorAll('.chat-swipe-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const msgIndex = parseInt(btn.dataset.msgIndex, 10);
            const dir = parseInt(btn.dataset.dir, 10);
            navigateSwipe(msgIndex, dir, character);
        });
    });

    container.querySelectorAll('.chat-message-name.clickable-char-name').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const charAvatar = el.dataset.charAvatar;
            if (!charAvatar) return;
            const allCharacters = CoreAPI.getAllCharacters();
            const char = allCharacters.find(c => c.avatar === charAvatar);
            if (char) openCharacterDetailsFromChats(char);
        });
    });

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function getSwipeTimestamp(msg, swipeId) {
    const swipeDate = msg.swipe_info?.[swipeId]?.send_date;
    if (swipeDate) return new Date(swipeDate).toLocaleString();
    if (msg.send_date) return new Date(msg.send_date).toLocaleString();
    return '';
}

function buildSwipeNavHtml(msgIndex, activeSwipeId, totalSwipes) {
    const isFirst = activeSwipeId === 0;
    const isLast = activeSwipeId === totalSwipes - 1;
    return `
        <div class="chat-swipe-nav">
            <button class="chat-swipe-btn${isFirst ? ' disabled' : ''}" data-msg-index="${msgIndex}" data-dir="-1" ${isFirst ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <span class="chat-swipe-counter">${activeSwipeId + 1} / ${totalSwipes}</span>
            <button class="chat-swipe-btn${isLast ? ' disabled' : ''}" data-msg-index="${msgIndex}" data-dir="1" ${isLast ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        </div>
    `;
}

function navigateSwipe(msgIndex, dir, character) {
    const msg = currentChatMessages[msgIndex];
    if (!msg?.swipes || msg.swipes.length <= 1) return;

    const currentId = msg.swipe_id ?? 0;
    const newId = currentId + dir;
    if (newId < 0 || newId >= msg.swipes.length) return;

    msg.swipe_id = newId;
    msg.mes = msg.swipes[newId];

    // Update just this message's DOM instead of re-rendering everything
    const msgEl = document.querySelector(`.chat-message[data-msg-index="${msgIndex}"]`);
    if (!msgEl) return;

    const textEl = msgEl.querySelector('.chat-message-text');
    if (textEl) {
        textEl.innerHTML = CoreAPI.formatRichText(msg.swipes[newId] || '', character?.name || '', true);
    }

    const navEl = msgEl.querySelector('.chat-swipe-nav');
    if (navEl) {
        navEl.outerHTML = buildSwipeNavHtml(msgIndex, newId, msg.swipes.length);
        // Re-attach listeners on the new nav element
        msgEl.querySelectorAll('.chat-swipe-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigateSwipe(parseInt(btn.dataset.msgIndex, 10), parseInt(btn.dataset.dir, 10), character);
            });
        });
    }

    const timeEl = msgEl.querySelector('.chat-message-time');
    const time = getSwipeTimestamp(msg, newId);
    if (timeEl) {
        if (time) {
            timeEl.textContent = time;
            timeEl.style.display = '';
        } else {
            timeEl.style.display = 'none';
        }
    } else if (time) {
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (contentEl) {
            const newTimeEl = document.createElement('div');
            newTimeEl.className = 'chat-message-time';
            newTimeEl.textContent = time;
            contentEl.appendChild(newTimeEl);
        }
    }
}

// ========================================
// CHAT ACTIONS (from preview modal / chats view)
// ========================================

async function openChatInST(chat) {
    if (chat.isGroup) {
        openGroupChat(chat.groupId, chat.file_name);
        return;
    }
    openChat(chat.character, chat.file_name);
}

async function openGroupChat(groupId, chatFile) {
    try {
        const chatId = chatFile.replace('.jsonl', '');

        CoreAPI.showToast('Opening group chat...', 'success');
        CoreAPI.hideModal('chatPreviewModal');

        const host = CoreAPI.getHostWindow();
        if (!host) {
            CoreAPI.showToast('Could not access SillyTavern window', 'error');
            return;
        }

        const context = host.SillyTavern?.getContext?.();
        if (!context?.openGroupChat) {
            CoreAPI.showToast('SillyTavern context API not available', 'error');
            return;
        }

        const group = context.groups?.find(g => g.id === groupId);
        if (!group) {
            CoreAPI.showToast('Group not found in SillyTavern', 'error');
            return;
        }

        if (context.groupId === groupId) {
            await context.openGroupChat(groupId, chatId);
        } else {
            const $ = host.jQuery;
            const groupEl = $ ? $(`.group_select[data-grid="${groupId}"]`) : null;

            if (groupEl?.length) {
                group.chat_id = chatId;
                groupEl.trigger('click');
            } else {
                await context.openGroupChat(groupId, chatId);
            }
        }

        if (CoreAPI.getIsEmbedded()) {
            CoreAPI.closeEmbeddedPanel();
        }
    } catch (e) {
        console.error('openGroupChat error:', e);
        CoreAPI.showToast('Could not open group chat: ' + e.message, 'error');
    }
}

async function deleteChatFromView(chat) {
    if (!confirm(`Delete this chat?\n\n${chat.file_name}\n\nThis cannot be undone!`)) {
        return;
    }

    try {
        let response;
        if (chat.isGroup) {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GROUP_DELETE, 'POST', {
                id: chat.file_name.replace('.jsonl', '')
            });
        } else {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_DELETE, 'POST', {
                chatfile: chat.file_name,
                avatar_url: chat.character.avatar
            });
        }

        if (response.ok) {
            CoreAPI.showToast('Chat deleted', 'success');

            const idx = chat.isGroup
                ? allChats.findIndex(c => c.file_name === chat.file_name && c.isGroup && c.groupId === chat.groupId)
                : allChats.findIndex(c => c.file_name === chat.file_name && c.charAvatar === chat.charAvatar);
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

function openCharacterDetailsFromChats(char) {
    if (!char) return;
    const chatPreviewModal = document.getElementById('chatPreviewModal');
    const chatPreviewOpen = chatPreviewModal && !chatPreviewModal.classList.contains('hidden');
    if (chatPreviewOpen) {
        CoreAPI.openCharModalElevated(char);
    } else {
        CoreAPI.openCharacterModal(char);
    }
}

// ========================================
// MESSAGE EDITING / DELETING
// ========================================

async function editChatMessage(messageIndex) {
    if (!currentPreviewChat || !currentChatMessages[messageIndex]) {
        CoreAPI.showToast('Message not found', 'error');
        return;
    }

    const msg = currentChatMessages[messageIndex];
    const currentText = msg.mes || '';

    const editModalHtml = `
        <div id="editMessageModal" class="modal-overlay">
            <div class="modal-glass" style="max-width: calc(600px * var(--modal-scale, 1)); width: 90%;">
                <div class="modal-header">
                    <h2><i class="fa-solid fa-pen"></i> Edit Message</h2>
                    <button class="close-btn" id="editMessageClose">&times;</button>
                </div>
                <div style="padding: 20px;">
                    <div class="edit-message-info" style="margin-bottom: 15px; font-size: 0.85rem; color: var(--text-secondary);">
                        <span><strong>${CoreAPI.escapeHtml(msg.name || (msg.is_user ? 'User' : currentPreviewChar?.name || 'Character'))}</strong></span>
                        ${msg.send_date ? `<span> \u2022 ${new Date(msg.send_date).toLocaleString()}</span>` : ''}
                    </div>
                    <textarea id="editMessageText" class="glass-input" style="width: 100%; min-height: 200px; resize: vertical;" autocomplete="one-time-code">${CoreAPI.escapeHtml(currentText)}</textarea>
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
            if (msg.swipes?.length > 1) {
                msg.swipes[msg.swipe_id ?? 0] = newText;
            }

            const success = await saveChatToServer(currentPreviewChat, currentChatMessages);

            if (success) {
                CoreAPI.showToast('Message updated', 'success');
                closeEditModal();
                renderChatMessages(currentChatMessages, currentPreviewChat.isGroup ? null : currentPreviewChat.character, currentPreviewChat.isGroup);
                clearChatCache();
            } else {
                currentChatMessages[messageIndex].mes = currentText;
                if (msg.swipes?.length > 1) {
                    msg.swipes[msg.swipe_id ?? 0] = currentText;
                }
                CoreAPI.showToast('Failed to save changes', 'error');
            }
        } catch (e) {
            currentChatMessages[messageIndex].mes = currentText;
            if (msg.swipes?.length > 1) {
                msg.swipes[msg.swipe_id ?? 0] = currentText;
            }
            CoreAPI.showToast('Error: ' + e.message, 'error');
        }
    };
}

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
            renderChatMessages(currentChatMessages, currentPreviewChat.isGroup ? null : currentPreviewChat.character, currentPreviewChat.isGroup);

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

async function saveChatToServer(chat, messages) {
    try {
        const chatFileName = (chat.file_name || '').replace('.jsonl', '');
        let response;

        if (chat.isGroup) {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_GROUP_SAVE, 'POST', {
                id: chatFileName,
                chat: messages
            });
        } else {
            response = await CoreAPI.apiRequest(ENDPOINTS.CHATS_SAVE, 'POST', {
                ch_name: chat.character.name,
                file_name: chatFileName,
                avatar_url: chat.character.avatar,
                chat: messages
            });
        }

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
// PUBLIC API
// ========================================

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
