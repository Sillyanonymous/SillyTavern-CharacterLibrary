// Botbooru Provider - full implementation for the Botbooru character source
//
// Handles browsing, linking, card fetching, update checking, and import
// against Botbooru's JSON API. /download/json/{id} returns a ready
// chara_card_v2 envelope, so there is no field-mapping layer; the post
// detail (/post/{id}) supplies listing name, stats, and the avatar filename.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, slugify } from '../provider-utils.js';
import botbooruBrowseView, { openBotbooruLoginModal } from './botbooru-browse.js';
import {
    initBotbooruApi,
    BOTBOORU_BASE,
    fetchWithProxy,
    getBotbooruHeaders,
    getBotbooruPreviewUrl,
    getBotbooruDownloadUrl,
    fetchBotbooruPosts,
    fetchBotbooruPost,
    fetchBotbooruCard,
    fetchBotbooruTags,
    fetchBotbooruFollowedTags,
    addBotbooruFollowedTag,
    removeBotbooruFollowedTag,
    fetchBotbooruTagWeights,
    upsertBotbooruTagWeight,
    deleteBotbooruTagWeight,
    fetchBotbooruMe,
    patchBotbooruAccount,
    getBotbooruWriterTag,
    trackBotbooruDownload,
} from './botbooru-api.js';

let api = null; // CoreAPI reference

// Cached raw post from fetchLinkStats - reused by "View on" button
let _cachedLinkNode = null;

/**
 * Drop other providers' link namespaces from a Botbooru card. The cards are
 * largely reuploads of exports that still carry their source's extensions
 * (eg. extensions.chub), and leaving those in would make CL auto-link the
 * import to the WRONG provider. Provenance is recorded in
 * extensions.botbooru.origin/sauce instead, display-only.
 */
const FOREIGN_PROVIDER_NAMESPACES = ['chub', 'janny', 'chartavern', 'pygmalion', 'wyvern', 'datacat'];
function stripForeignProviderNamespaces(card) {
    const ext = card?.data?.extensions;
    if (!ext) return;
    for (const ns of FOREIGN_PROVIDER_NAMESPACES) {
        delete ext[ns];
    }
}

class BotbooruProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'botbooru'; }
    get name() { return 'Botbooru'; }
    get icon() { return 'fa-solid fa-robot'; }
    get iconUrl() { return `${BOTBOORU_BASE}/favicon.ico`; }
    get beta() { return true; }
    get enableWarning() { return 'Botbooru is a new, experimental source and its API has rough edges. SFW browsing and importing work anonymously; NSFW requires logging in with a Botbooru account.'; }
    get browseView() { return botbooruBrowseView; }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initBotbooruApi({
            getSetting: coreAPI.getSetting,
            debugLog: coreAPI.debugLog,
            apiRequest: coreAPI.apiRequest,
            getCSRFToken: coreAPI.getCSRFToken,
        });
    }

    async activate(container, options = {}) {
        botbooruBrowseView.activate(container, options);
    }

    deactivate() {
        botbooruBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return botbooruBrowseView.renderFilterBar(); }
    renderView() { return botbooruBrowseView.renderView(); }
    renderModals() { return botbooruBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const bb = extensions?.botbooru;
        // Cards downloaded straight from botbooru.com carry the SITE's own
        // namespace ({schema_version, post_id, post_url}); accept post_id so
        // sideloaded cards are recognized as linked without a manual relink
        const id = bb?.id ?? (bb?.post_id != null ? String(bb.post_id) : null);
        if (!id) return null;

        return {
            providerId: 'botbooru',
            id,
            // fullPath is the cross-provider path key (duplicate checks compare it);
            // omitting it made the dup checker's empty-string substring match flag
            // every existing botbooru import as an "exact path match"
            fullPath: String(id),
            slug: bb.slug || null,
            filename: bb.filename || null,
            rev: bb.rev || 1,
            uploaderId: bb.uploaderId || null,
            uploaderName: bb.uploaderName || null,
            linkedAt: bb.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.botbooru || {};
            // The shared link modal only passes {id, fullPath, pageName}; enrich
            // the rest from the post detail cached by fetchMetadata/fetchLinkStats
            // (without this, URL/search links land with filename/uploader null)
            const cached = (_cachedLinkNode && String(_cachedLinkNode.id) === String(linkInfo.id)) ? _cachedLinkNode : null;
            char.data.extensions.botbooru = {
                id: linkInfo.id,
                slug: linkInfo.slug || cached?.slug || existing.slug || null,
                // filename + rev feed the preview-image URL for link UI / enrich
                filename: linkInfo.filename || cached?.filename || existing.filename || null,
                rev: linkInfo.rev || cached?.card_image_revision || existing.rev || 1,
                // The uploader is the creator on Botbooru (the list API only carries the id)
                uploaderId: linkInfo.uploaderId || (cached?.uploader_id != null ? String(cached.uploader_id) : null) || existing.uploaderId || null,
                uploaderName: linkInfo.uploaderName || cached?.uploader_name || existing.uploaderName || null,
                origin: linkInfo.origin || cached?.origin || existing.origin || null,
                sauce: linkInfo.sauce || cached?.sauce || existing.sauce || null,
                // pageName feeds the listing-name display + search key
                pageName: linkInfo.pageName || cached?.character_name || existing.pageName || null,
                tagline: linkInfo.tagline || cached?.tagline || existing.tagline || null,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
            };
        } else {
            delete char.data.extensions.botbooru;
        }
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        // The JSON API lives at /post/{id} but the site's page URL is /character/{id}
        return `${BOTBOORU_BASE}/character/${linkInfo.id}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const post = this.getCachedLinkNode() || await fetchBotbooruPost(linkInfo.id);
        if (!post) return null;

        const previewChar = {
            ...post,
            avatar_url: post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
        };

        this.clearCachedLinkNode();
        return previewChar;
    }

    openPreview(previewChar) {
        window.openBotbooruCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.botbooru;
        // Site-downloaded cards carry the site's own namespace (post_id, no id)
        const id = ext?.id ?? (ext?.post_id != null ? String(ext.post_id) : null);
        if (!id) return null;

        // CL-stamped namespaces are already complete; skip the detail round trip
        // (it would fire once per card inside the batch-import loop, and the
        // 3-entry post cache cant absorb that). Reimports claim hasGallery
        // false; the gallery offer already fired on the original import.
        if (ext.id != null && ext.filename && ext.pageName) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'botbooru',
                    charId: id,
                    fullPath: String(id),
                    hasGallery: false,
                    avatarUrl: getBotbooruPreviewUrl(ext.filename, ext.rev)
                }
            };
        }

        // Partial/site namespaces need healing anyway; resolve the real gallery
        // state (mini-galleries are rare, optimistic claims would mostly produce
        // empty gallery offers) from the LRU-cached detail while its in hand
        const post = await fetchBotbooruPost(id);
        const hasGallery = (post?.mini_gallery?.images || []).some(i => i.status === 'approved');

        // Heal partial namespaces while the detail is in hand: site-downloaded
        // cards have only {schema_version, post_id, post_url}, and older
        // URL/search links stamped nulls
        if (post && cardData.data?.extensions) {
            const existing = cardData.data.extensions.botbooru || {};
            cardData.data.extensions.botbooru = {
                ...existing,
                id: existing.id ?? Number(post.id),
                slug: existing.slug || post.slug || null,
                filename: existing.filename || post.filename || null,
                rev: existing.rev || post.card_image_revision || 1,
                uploaderId: existing.uploaderId || (post.uploader_id != null ? String(post.uploader_id) : null),
                uploaderName: existing.uploaderName || post.uploader_name || null,
                pageName: existing.pageName || post.character_name || null,
                tagline: existing.tagline || post.tagline || null,
            };
        }

        const healed = cardData.data?.extensions?.botbooru || ext;
        return {
            cardData,
            providerInfo: {
                providerId: 'botbooru',
                charId: id,
                fullPath: String(id),
                hasGallery,
                avatarUrl: healed.filename ? getBotbooruPreviewUrl(healed.filename, healed.rev) : null
            }
        };
    }

    // ── Remote Data ─────────────────────────────────────────

    /**
     * Resolve a parsed URL handle (the post id) to its metadata. The link-by-URL
     * flow calls this to obtain the numeric id and listing name before saving;
     * without it the saved link would carry id: null and be unreadable.
     */
    async fetchMetadata(handle) {
        const post = await fetchBotbooruPost(handle);
        // Cache for setLinkInfo enrichment (the shared modal calls it right after)
        if (post) _cachedLinkNode = post;
        return post;
    }

    /**
     * Fetch the remote card for update comparison.
     * /download/json is already V2-wrapped; the post detail adds the
     * listing name (character_name can differ from the card's data.name).
     */
    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const card = await fetchBotbooruCard(linkInfo.id);
            if (!card) return null;
            const post = await fetchBotbooruPost(linkInfo.id);
            if (post?.character_name) card._listingName = post.character_name;
            // Mirror the import's creator resolution exactly (Writer tag, then uploader, then the
            // card json value) or the update check would flag a creator diff on every card.
            if (post) {
                card.data.creator = getBotbooruWriterTag(post) || post.uploader_name || card.data.creator || '';
            }
            // Mirror the import-time strip too, or applying an update would re-add
            // the reupload's foreign link namespaces (eg. extensions.chub).
            stripForeignProviderNamespaces(card);
            // The tagline is a post field, not part of the card json; mirror it at
            // the comparable path so update checks can diff it (chub-canon shape)
            if (post && card.data) {
                if (!card.data.extensions) card.data.extensions = {};
                card.data.extensions.botbooru = {
                    ...(card.data.extensions.botbooru || {}),
                    tagline: post.tagline || null,
                };
            }
            return card;
        } catch (e) {
            console.error('[BotbooruProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (!rawData) return null;
        if (rawData.data) return rawData;
        return { spec: 'chara_card_v2', spec_version: '2.0', data: rawData };
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.botbooru.tagline',
                label: 'Botbooru Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Link Stats ──────────────────────────────────────────

    /**
     * Fetch live stats for the link modal; caches the raw post for reuse
     * by getCachedLinkNode().
     * @returns {Promise<{stat1: number, stat2: number, stat3: number}|null>}
     */
    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        const post = await fetchBotbooruPost(linkInfo.id);
        if (!post) return null;

        _cachedLinkNode = post;

        // Slot order follows the base linkStatFields (downloads / favorites / tokens)
        return {
            stat1: post.downloads || 0,
            stat2: post.favorite_count || 0,
            stat3: post.token_count || 0
        };
    }

    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    // ── Listing Name ────────────────────────────────────────

    getListingName(hitData) { return hitData?.character_name || null; }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() {
        return !!(api?.getSetting('botbooruToken'));
    }

    openAuthUI() {
        openBotbooruLoginModal?.();
    }

    getAuthHeaders() {
        const token = api?.getSetting('botbooruToken');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?botbooru\.com$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Site pages use /character/{id}; tolerate the API-shaped /post(s)/{id} too
            const m = u.pathname.match(/^\/(?:character|posts?)\/(\d+)/);
            if (m) return m[1];
        } catch { /* ignore */ }
        return null;
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [
            {
                key: 'botbooruToken',
                label: 'Bearer Token',
                type: 'password',
                defaultValue: null,
                hint: 'JWT from Botbooru login (valid ~90 days)',
                section: 'Authentication'
            },
            {
                key: 'botbooruTrackDownloads',
                label: 'Report downloads to Botbooru',
                type: 'checkbox',
                defaultValue: true,
                hint: 'Feeds the download counters on the site',
                section: 'Privacy'
            },
            {
                key: 'botbooruShowNsfl',
                label: 'Include NSFL posts',
                type: 'checkbox',
                defaultValue: false,
                hint: 'Only applies while NSFW browsing is enabled',
                section: 'Display'
            }
        ];
    }

    // ── Favorite Tags (curated-sort boosters; settings reaches these via the registry) ──

    async listFollowedTags() {
        return fetchBotbooruFollowedTags();
    }

    /**
     * Follow a tag by name. The endpoint requires the tag's category, which is
     * resolved from the tag DB (lazy 1.6MB fetch, cached for the session).
     * @returns {Promise<Object|null>} the created entry, or null
     */
    async followTag(tagName, category = null) {
        const name = String(tagName || '').trim().toLowerCase();
        if (!name) return null;
        const tags = await fetchBotbooruTags();
        const catLower = category ? String(category).toLowerCase() : null;
        const hit = (tags || []).find(t => t.name.toLowerCase() === name
            && (!catLower || (t.category || 'General').toLowerCase() === catLower));
        if (!hit) return null;
        // Aliases carry the canonical tag's counts but not its id; follow the target
        const canonical = hit.alias_of
            ? (tags || []).find(t => t.name.toLowerCase() === hit.alias_of.toLowerCase() && !t.alias_of) || hit
            : hit;
        return addBotbooruFollowedTag(canonical.name, canonical.category || 'General');
    }

    /**
     * Substring autocomplete over the tag DB. "category:term" narrows to one
     * category (prefix-matched, eg "art:" or "char:"); a bare "category:"
     * lists that category's top tags. Count-sorted, aliases skipped.
     * @returns {Promise<Array<{name, category, count}>>}
     */
    async searchTags(query, limit = 8) {
        const raw = String(query || '').trim().toLowerCase();
        if (!raw) return [];
        const tags = await fetchBotbooruTags();
        if (!tags) return [];
        let term = raw;
        let category = null;
        const ci = raw.indexOf(':');
        if (ci > 0) {
            const prefix = raw.slice(0, ci).trim();
            const categories = [...new Set(tags.map(t => t.category || 'General'))];
            const matched = categories.find(c => c.toLowerCase().startsWith(prefix));
            if (matched) {
                category = matched;
                term = raw.slice(ci + 1).trim();
            }
        }
        const out = [];
        for (const t of tags) {
            if (t.alias_of) continue;
            if (category && (t.category || 'General') !== category) continue;
            if (term && !t.name.toLowerCase().includes(term)) continue;
            out.push(t);
        }
        out.sort((a, b) => (b.count || 0) - (a.count || 0));
        return out.slice(0, limit);
    }

    async unfollowTag(entryId) {
        return removeBotbooruFollowedTag(entryId);
    }

    // ── Tag Weights (weighted-tag account mode) ─────────────

    async listTagWeights() {
        return fetchBotbooruTagWeights();
    }

    /**
     * Upsert a weight for a tag by name. Category resolves from the tag DB
     * the same way followTag does (alias-aware).
     * @param {string} tagName
     * @param {{weight?: number, always_follow?: boolean, always_block?: boolean}} opts
     */
    async setTagWeight(tagName, opts = {}) {
        const name = String(tagName || '').trim().toLowerCase();
        if (!name) return null;
        const tags = await fetchBotbooruTags();
        const catLower = opts.category ? String(opts.category).toLowerCase() : null;
        const hit = (tags || []).find(t => t.name.toLowerCase() === name
            && (!catLower || (t.category || 'General').toLowerCase() === catLower));
        if (!hit) return null;
        const canonical = hit.alias_of
            ? (tags || []).find(t => t.name.toLowerCase() === hit.alias_of.toLowerCase() && !t.alias_of) || hit
            : hit;
        return upsertBotbooruTagWeight({
            tag_name: canonical.name,
            category: canonical.category || 'General',
            weight: Math.max(-1000, Math.min(1000, Math.round(Number(opts.weight) || 0))),
            always_follow: !!opts.always_follow,
            always_block: !!opts.always_block,
        });
    }

    /** Re-upsert an existing entry with changed fields (POST is the update). */
    async updateTagWeightEntry(entry, patch = {}) {
        if (!entry?.tag_name) return null;
        return upsertBotbooruTagWeight({
            tag_name: entry.tag_name,
            category: entry.category || 'General',
            weight: Math.max(-1000, Math.min(1000, Math.round(Number(patch.weight ?? entry.weight) || 0))),
            always_follow: !!(patch.always_follow ?? entry.always_follow),
            always_block: !!(patch.always_block ?? entry.always_block),
        });
    }

    async removeTagWeight(entryId) {
        return deleteBotbooruTagWeight(entryId);
    }

    /**
     * Read the accounts use_tag_weights switch fresh and mirror it into the
     * botbooruUseTagWeights setting for synchronous readers (settings UI,
     * browse tooltips, curated sub-sort gating).
     */
    async refreshWeightedModeStatus() {
        if (!api?.getSetting('botbooruToken')) return null;
        const me = await fetchBotbooruMe();
        if (me && typeof me.use_tag_weights === 'boolean') {
            CoreAPI.setSetting('botbooruUseTagWeights', me.use_tag_weights);
            return me.use_tag_weights;
        }
        return null;
    }

    /** Flip the account switch; the PATCH response is authoritative. */
    async setWeightedMode(on) {
        const me = await patchBotbooruAccount({ use_tag_weights: !!on });
        if (me && typeof me.use_tag_weights === 'boolean') {
            CoreAPI.setSetting('botbooruUseTagWeights', me.use_tag_weights);
            return me.use_tag_weights;
        }
        return null;
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    /**
     * Search Botbooru for characters matching a name. q matches character
     * names by substring (NSFW results require an authed token). There is
     * no creator filter; uploader and writer arent queryable, so matching
     * is name-only.
     */
    async searchForBulkLink(name, _creator) {
        if (!name?.trim()) return [];
        try {
            const data = await fetchBotbooruPosts({ q: name.trim(), sort: 'downloads', limit: 25 });
            if (!data?.posts?.length) return [];

            const normalizedName = name.toLowerCase().trim();
            const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 2);

            return data.posts
                .filter(p => {
                    const pName = (p.character_name || '').toLowerCase().trim();
                    return pName === normalizedName || pName.includes(normalizedName)
                        || normalizedName.includes(pName) || nameWords.some(w => pName.includes(w));
                })
                .map(p => this._normalizeSearchResult(p));
        } catch (error) {
            console.error('[BotbooruProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character by post id. The /download/png is the published
     * card PNG (avatar + embedded data), so it doubles as the image source;
     * the V2 json download is the authoritative card payload.
     * @param {string|number} idHandle - post id (from parseUrl or the browse grid)
     * @param {Object} [hitData] - post item from the grid, if invoked from browse
     */
    async importCharacter(idHandle, hitData, options = {}) {
        try {
            const id = String(idHandle).match(/\d+/)?.[0];
            if (!id) throw new Error('Invalid Botbooru post id');

            const characterCard = await fetchBotbooruCard(id);
            if (!characterCard) throw new Error('Could not fetch character card from API');

            // Always fetch the detail: the uploader name and slug live only there
            // (the list payload carries just uploader_id). LRU-cached, usually warm.
            const post = await fetchBotbooruPost(id) || hitData || {};
            const characterName = characterCard.data.name || post?.character_name || `botbooru_${id}`;

            // Creator credit prefers the Writer tag, then the uploader. The card jsons own creator
            // is the reupload sources value (often a junk JanitorAI link), so it only stands as a
            // last resort when theres neither a Writer tag nor an uploader.
            if (post) {
                characterCard.data.creator = getBotbooruWriterTag(post) || post.uploader_name || characterCard.data.creator || '';
            }

            stripForeignProviderNamespaces(characterCard);

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existing = characterCard.data.extensions.botbooru || {};
            characterCard.data.extensions.botbooru = {
                ...existing,
                id: Number(id),
                slug: post?.slug || existing.slug || null,
                filename: post?.filename || existing.filename || null,
                rev: post?.card_image_revision || existing.rev || 1,
                uploaderId: (post?.uploader_id != null ? String(post.uploader_id) : null) || existing.uploaderId || null,
                uploaderName: post?.uploader_name || existing.uploaderName || null,
                origin: post?.origin || existing.origin || null,
                sauce: post?.sauce || existing.sauce || null,
                pageName: post?.character_name || existing.pageName || null,
                tagline: post?.tagline || existing.tagline || null,
                linkedAt: new Date().toISOString()
            };

            assignGalleryId(characterCard, options, api);

            // The card PNG is the best avatar source; fall back to the preview image
            let imageBuffer = null;
            const imageUrls = [getBotbooruDownloadUrl(id, 'png')];
            if (post?.filename) imageUrls.push(getBotbooruPreviewUrl(post.filename, post.card_image_revision));
            for (const url of imageUrls) {
                try {
                    const resp = await fetchWithProxy(url, { headers: getBotbooruHeaders(true) });
                    imageBuffer = await resp.arrayBuffer();
                    break;
                } catch { /* try next */ }
            }

            const hasGallery = (post?.mini_gallery?.images || []).some(i => i.status === 'approved');

            const result = await importFromPng({
                characterCard, imageBuffer,
                fileName: `botbooru_${slugify(characterName)}.png`,
                characterName,
                hasGallery,
                providerCharId: Number(id),
                fullPath: String(id),
                avatarUrl: post?.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
                api
            });

            // Ping only after the import actually landed (counts real downloads)
            if (result?.success && api?.getSetting('botbooruTrackDownloads') !== false) {
                trackBotbooruDownload(id, 'png');
            }
            return result;
        } catch (error) {
            console.error(`[BotbooruProvider] importCharacter failed for ${idHandle}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Gallery Download ────────────────────────────────────

    get supportsGallery() { return true; }

    /**
     * Mini-gallery images for the gallery download pipeline (max 3 per post).
     * Returns the full-resolution download URLs; the per-image API has no
     * NSFW flag, so nsfw rides the post-level rating implicitly.
     */
    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const post = await fetchBotbooruPost(linkInfo.id);
            const images = post?.mini_gallery?.images || [];
            return images
                .filter(img => img.status === 'approved' && img.download_url)
                .map(img => ({
                    url: `${BOTBOORU_BASE}${img.download_url}`,
                    id: String(img.id),
                    nsfw: false
                }));
        } catch (e) {
            console.error('[BotbooruProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _getHeaders() {
        return getBotbooruHeaders(true);
    }

    /**
     * Normalize a post item into the standard bulk-link result format.
     */
    _normalizeSearchResult(post) {
        return {
            id: post.id || null,
            fullPath: String(post.id || ''),
            name: post.character_name || '',
            avatarUrl: post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
            rating: 0,
            starCount: post.favorite_count || 0,
            description: post.description_excerpt || '',
            tagline: post.creator_notes_excerpt || '',
            nTokens: post.token_count || 0,
        };
    }
}

// Singleton instance
const botbooruProvider = new BotbooruProvider();
export default botbooruProvider;
