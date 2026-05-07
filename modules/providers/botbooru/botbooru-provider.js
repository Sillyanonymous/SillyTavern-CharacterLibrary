import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import botbooruBrowseView from './botbooru-browse.js';
import {
    BOTBOORU_PAGE_RE,
    getBotbooruPostUrl,
    normalizeBotbooruPost,
    setApiRequest,
    slugify,
    fetchBotbooruPost,
    fetchBotbooruCardJson,
    fetchBotbooruCardPng,
} from './botbooru-api.js';

let api = null;

function parsePositiveId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function ensureBotbooruExtension(card, id, post = null) {
    if (!card?.data) return card;

    const numericId = parsePositiveId(id);
    const idValue = numericId || id;
    const fullPath = String(idValue);

    card.data.extensions = card.data.extensions || {};
    const existing = card.data.extensions.botbooru || {};
    card.data.extensions.botbooru = {
        ...existing,
        id: idValue,
        fullPath,
        linkedAt: existing.linkedAt || new Date().toISOString(),
        pageName: post?.character_name || post?.name || existing.pageName || null,
    };

    return card;
}

class BotbooruProvider extends ProviderBase {
    get id() { return 'botbooru'; }
    get name() { return 'BotBooru'; }
    get icon() { return 'fa-solid fa-robot'; }
    get iconUrl() { return 'https://botbooru.com/favicon.ico'; }
    get browseView() { return botbooruBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-eye', label: 'Views' },
            stat2: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat3: { icon: 'fa-solid fa-heart', label: 'Favorites' },
        };
    }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        setApiRequest(coreAPI.apiRequest);
    }

    get hasView() { return true; }

    renderFilterBar() { return botbooruBrowseView.renderFilterBar(); }
    renderView() { return botbooruBrowseView.renderView(); }
    renderModals() { return botbooruBrowseView.renderModals(); }

    async activate(container, options = {}) {
        botbooruBrowseView.activate(container, options);
    }

    deactivate() {
        botbooruBrowseView.deactivate();
    }

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const botbooru = extensions?.botbooru;
        if (!botbooru) return null;

        const id = parsePositiveId(botbooru.id || botbooru.fullPath || botbooru.full_path);
        if (!id) return null;

        return {
            providerId: 'botbooru',
            id,
            fullPath: String(botbooru.fullPath || botbooru.full_path || id),
            linkedAt: botbooru.linkedAt || null,
            pageName: botbooru.pageName || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const id = parsePositiveId(linkInfo.id || linkInfo.fullPath);
            if (!id) return;
            const existing = char.data.extensions.botbooru || {};
            char.data.extensions.botbooru = {
                ...existing,
                id,
                fullPath: String(linkInfo.fullPath || id),
                linkedAt: linkInfo.linkedAt || existing.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.botbooru;
        }
    }

    getCharacterUrl(linkInfo) {
        const id = parsePositiveId(linkInfo?.id || linkInfo?.fullPath);
        return id ? getBotbooruPostUrl(id) : null;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(_char, linkInfo) {
        const id = parsePositiveId(linkInfo?.id || linkInfo?.fullPath);
        if (!id) return null;
        return await this.fetchMetadata(id);
    }

    openPreview(previewChar) {
        window.openBotbooruCharPreview?.(previewChar);
    }

    async fetchMetadata(id) {
        return fetchBotbooruPost(id);
    }

    async fetchRemoteCard(linkInfo) {
        const id = parsePositiveId(linkInfo?.id || linkInfo?.fullPath);
        if (!id) return null;

        try {
            const card = await fetchBotbooruCardJson(id);
            if (!card?.data) return null;

            let post = null;
            try {
                post = await this.fetchMetadata(id);
            } catch (e) {
                api?.debugLog?.('[BotbooruProvider] fetchRemoteCard metadata skipped:', e.message);
            }

            const normalized = this.normalizeRemoteCard(card);
            if (!normalized) return null;

            ensureBotbooruExtension(normalized, id, post);
            normalized._listingName = this.getListingName(post);
            return normalized;
        } catch (e) {
            console.error('[BotbooruProvider] fetchRemoteCard failed:', id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2' && rawData?.data) return rawData;
        if (rawData?.data) return { spec: 'chara_card_v2', spec_version: '2.0', data: rawData.data };
        if (rawData?.name) return { spec: 'chara_card_v2', spec_version: '2.0', data: rawData };
        return null;
    }

    async fetchLinkStats(linkInfo) {
        const id = parsePositiveId(linkInfo?.id || linkInfo?.fullPath);
        if (!id) return null;

        try {
            const post = await this.fetchMetadata(id);
            if (!post) return null;
            return {
                stat1: Number.parseInt(post.views, 10) || 0,
                stat2: Number.parseInt(post.downloads, 10) || 0,
                stat3: Number.parseInt(post.favorites, 10) || 0,
            };
        } catch (e) {
            api?.debugLog?.('[BotbooruProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    getListingName(hitData) {
        return hitData?.character_name || hitData?.name || null;
    }

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?botbooru\.com$/i.test(u.hostname) && BOTBOORU_PAGE_RE.test(u.pathname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            if (!/^(www\.)?botbooru\.com$/i.test(u.hostname)) return null;
            const match = u.pathname.match(BOTBOORU_PAGE_RE);
            return match?.[1] || null;
        } catch {
            return null;
        }
    }

    get supportsImport() { return true; }

    async importCharacter(id, hitData = null, options = {}) {
        try {
            const postId = parsePositiveId(id);
            if (!postId) throw new Error('Invalid BotBooru post id');

            const post = hitData ? normalizeBotbooruPost(hitData) : await this.fetchMetadata(postId);
            if (!post) throw new Error('Could not fetch BotBooru post metadata');

            let imageBuffer = null;
            try {
                imageBuffer = await fetchBotbooruCardPng(postId);
            } catch (e) {
                console.warn('[BotbooruProvider] PNG download failed, importing with placeholder:', e.message);
            }
            let characterCard = this.normalizeRemoteCard(api?.extractCharacterDataFromPng?.(imageBuffer));

            if (!characterCard?.data) {
                characterCard = await fetchBotbooruCardJson(postId);
            }
            if (!characterCard?.data) throw new Error('Could not fetch BotBooru V2 card JSON');

            ensureBotbooruExtension(characterCard, postId, post);
            assignGalleryId(characterCard, options, api);

            const characterName = characterCard.data.name || this.getListingName(post) || `BotBooru ${postId}`;

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `botbooru_${postId}_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: postId,
                fullPath: String(postId),
                avatarUrl: post.avatar_url || null,
                api,
            });
        } catch (error) {
            console.error(`[BotbooruProvider] importCharacter failed for ${id}:`, error);
            return { success: false, error: error.message };
        }
    }
}

const botbooruProvider = new BotbooruProvider();
export default botbooruProvider;
