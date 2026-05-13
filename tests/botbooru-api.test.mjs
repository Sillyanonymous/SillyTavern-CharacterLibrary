import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fetchBotbooruFavorites,
    fetchBotbooruFollowedTags,
    followBotbooruTag,
    parseBotbooruTagInput,
    setApiRequest,
    unfollowBotbooruTag,
} from '../modules/providers/botbooru/botbooru-api.js';

test('fetchBotbooruFavorites accepts BotBooru profile favorites arrays', async () => {
    setApiRequest(async (path) => {
        assert.match(path, /\/bb-favorites\?/);
        return new Response(JSON.stringify([
            {
                id: 123,
                character_name: 'Shelby',
                uploader_name: 'DJLegnds',
                filename: 'shelby.png',
                favorites: 148,
                views: 200,
                downloads: 10,
                tags: [{ name: 'nsfw' }],
            },
            {
                id: 456,
                character_name: 'Elise',
                uploader_name: 'Someone',
                filename: 'elise.png',
                favorite_count: 12,
            },
        ]), { status: 200 });
    });

    const result = await fetchBotbooruFavorites({ limit: 48, offset: 0 });

    assert.equal(result.total, 2);
    assert.equal(result.posts.length, 2);
    assert.equal(result.posts[0].id, 123);
    assert.equal(result.posts[0].name, 'Shelby');
    assert.equal(result.posts[0].favorites, 148);
    assert.equal(result.posts[0].rating, 'nsfw');
    assert.equal(result.posts[1].name, 'Elise');
});

test('parseBotbooruTagInput normalizes namespaced followed-tag input', () => {
    assert.deepEqual(parseBotbooruTagInput('character:Jane Doe'), {
        tag_name: 'jane_doe',
        category: 'Characters',
    });
    assert.deepEqual(parseBotbooruTagInput('artist:cinnabus'), {
        tag_name: 'cinnabus',
        category: 'Artist',
    });
    assert.equal(parseBotbooruTagInput('x')?.error, 'Tag must be at least 2 characters.');
});

test('followed tag helpers use the BotBooru helper routes', async () => {
    const calls = [];
    setApiRequest(async (path, method = 'GET', body = null) => {
        calls.push({ path, method, body });
        if (path.includes('/bb-followed-tags/12')) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (method === 'POST') {
            return new Response(JSON.stringify({ id: 12, tag_name: body.tag_name, category: body.category }), { status: 200 });
        }
        return new Response(JSON.stringify([
            { id: 12, tag_name: 'cinnabus', category: 'Artist' },
        ]), { status: 200 });
    });

    const followed = await fetchBotbooruFollowedTags();
    const added = await followBotbooruTag('artist:cinnabus');
    const removed = await unfollowBotbooruTag(12);

    assert.deepEqual(followed, [{ id: 12, tag_name: 'cinnabus', category: 'Artist' }]);
    assert.equal(added.tag_name, 'cinnabus');
    assert.equal(added.category, 'Artist');
    assert.equal(removed, true);
    assert.deepEqual(calls.map(c => [c.path, c.method]), [
        ['/plugins/cl-helper/bb-followed-tags', 'GET'],
        ['/plugins/cl-helper/bb-followed-tags', 'POST'],
        ['/plugins/cl-helper/bb-followed-tags/12', 'DELETE'],
    ]);
});

test('BotBooru syncs saved token for personalized loads without gating Curated', async () => {
    globalThis.window = globalThis.window || {};
    const { shouldSyncBotbooruTokenForLoad } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=sync-token-${Date.now()}`);

    assert.equal(shouldSyncBotbooruTokenForLoad('browse', 'latest'), false);
    assert.equal(shouldSyncBotbooruTokenForLoad('browse', 'curated'), true);
    assert.equal(shouldSyncBotbooruTokenForLoad('curated', 'latest'), true);
    assert.equal(shouldSyncBotbooruTokenForLoad('curated', 'curated'), true);
    assert.equal(shouldSyncBotbooruTokenForLoad('favorites', 'latest'), true);
});

test('BotBooru Curated mode keeps Sort By on normal order values', async () => {
    globalThis.window = globalThis.window || {};
    const { getBotbooruSortSelectValue } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=sort-select-${Date.now()}`);

    assert.equal(getBotbooruSortSelectValue('latest'), 'latest');
    assert.equal(getBotbooruSortSelectValue('favorites'), 'favorites');
    assert.equal(getBotbooruSortSelectValue('curated'), 'latest');
    assert.equal(getBotbooruSortSelectValue(''), 'latest');
});

test('BotBooru NSFW toggle mirrors provider label states', async () => {
    globalThis.window = globalThis.window || {};
    const { getBotbooruNsfwToggleState } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=nsfw-toggle-${Date.now()}`);

    assert.deepEqual(getBotbooruNsfwToggleState(true), {
        active: true,
        icon: 'fa-solid fa-fire',
        label: 'NSFW On',
        title: 'NSFW content enabled - click to show SFW only',
    });
    assert.deepEqual(getBotbooruNsfwToggleState(false), {
        active: false,
        icon: 'fa-solid fa-shield-halved',
        label: 'SFW Only',
        title: 'Showing SFW only - click to include NSFW',
    });
});

test('BotBooru provider accepts BotBooru direct download URLs', async () => {
    globalThis.window = globalThis.window || {};
    const { default: provider } = await import(`../modules/providers/botbooru/botbooru-provider.js?case=download-url-${Date.now()}`);

    for (const url of [
        'https://botbooru.com/download/png/5477',
        'https://botbooru.com/download/json/5477',
        'botbooru.com/download/png/5477',
    ]) {
        assert.equal(provider.canHandleUrl(url), true, url);
        assert.equal(provider.parseUrl(url), '5477', url);
    }
});

test('BotBooru import prefers card data embedded in the direct PNG download', async () => {
    globalThis.window = globalThis.window || {};
    const originalFetch = globalThis.fetch;
    const calls = [];
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).buffer;

    try {
        const { default: provider } = await import(`../modules/providers/botbooru/botbooru-provider.js?case=direct-png-import-${Date.now()}`);
        provider.init({
            apiRequest: async (path) => {
                calls.push(path);
                if (path.includes('/download/json/')) {
                    throw new Error('JSON endpoint should not be needed when PNG card data is present');
                }
                return new Response(pngBytes, { status: 200 });
            },
            embedCharacterDataInPng: (pngBuffer) => pngBuffer,
            extractCharacterDataFromPng: () => ({
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: { name: 'Direct PNG Bot', extensions: {} },
            }),
            findCharacterMediaUrls: () => [],
            getCSRFToken: () => 'csrf',
            getSetting: () => false,
        });
        globalThis.fetch = async () => new Response(JSON.stringify({ file_name: 'direct_png_bot.png' }), { status: 200 });

        const result = await provider.importCharacter(5477, { id: 5477, character_name: 'Listing Name' });

        assert.equal(result.success, true);
        assert.equal(result.characterName, 'Direct PNG Bot');
        assert.deepEqual(calls, ['/plugins/cl-helper/bb-proxy/download/png/5477']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('BotBooru preview exposes downloaded card sections', async () => {
    globalThis.window = globalThis.window || {};
    const { getBotbooruPreviewSections } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=preview-sections-${Date.now()}`);
    const sections = getBotbooruPreviewSections({
        data: {
            description: 'Description text',
            personality: 'Personality text',
            scenario: 'Scenario text',
            first_mes: 'First message text',
            mes_example: 'Example dialog text',
            creator_notes: 'Creator notes text',
        },
    });

    assert.deepEqual(sections.map(section => [section.id, section.label, section.content]), [
        ['botbooruCharCreatorNotes', "Creator's Notes", 'Creator notes text'],
        ['botbooruCharDescription', 'Description', 'Description text'],
        ['botbooruCharPersonality', 'Personality', 'Personality text'],
        ['botbooruCharScenario', 'Scenario', 'Scenario text'],
        ['botbooruCharExamples', 'Example Dialogs', 'Example dialog text'],
        ['botbooruCharFirstMsg', 'First Message', 'First message text'],
    ]);
});

test('BotBooru preview section headings are expandable', async () => {
    globalThis.window = globalThis.window || {};
    globalThis.window.escapeHtml = value => String(value ?? '');
    const { default: browseView } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=preview-expand-${Date.now()}`);

    const html = browseView.renderModals();

    assert.match(html, /data-section="botbooruCharCreatorNotes"/);
    assert.match(html, /data-section="botbooruCharDescription"/);
    assert.match(html, /data-section="botbooruCharPersonality"/);
    assert.match(html, /data-section="botbooruCharScenario"/);
    assert.match(html, /data-section="botbooruCharExamples"/);
    assert.match(html, /data-section="botbooruCharFirstMsg"/);
});

test('BotBooru preview sections use rich text rendering for entities and spacing', async () => {
    globalThis.window = globalThis.window || {};
    const originalFormatRichText = globalThis.window.formatRichText;
    const originalSafePurify = globalThis.window.safePurify;

    try {
        globalThis.window.formatRichText = (text) => String(text)
            .replace(/&quot;/g, '"')
            .replace(/\n\n/g, '<br><br>');
        globalThis.window.safePurify = html => `safe:${html}`;

        const { getBotbooruPreviewSectionHtml } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=preview-html-${Date.now()}`);

        assert.equal(
            getBotbooruPreviewSectionHtml('pics in &quot;Gallery&quot;\n\nLine 2', 'Daphne'),
            'safe:pics in "Gallery"<br><br>Line 2',
        );
    } finally {
        globalThis.window.formatRichText = originalFormatRichText;
        globalThis.window.safePurify = originalSafePurify;
    }
});

test('BotBooru avatar viewer opens the full image with preview fallback', async () => {
    globalThis.window = globalThis.window || {};
    const { BrowseView } = await import('../modules/providers/browse-view.js');
    const { openBotbooruAvatarViewer } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=avatar-viewer-${Date.now()}`);
    const originalOpenAvatarViewer = BrowseView.openAvatarViewer;
    const calls = [];

    try {
        BrowseView.openAvatarViewer = (...args) => calls.push(args);

        openBotbooruAvatarViewer({
            image_url: 'https://botbooru.test/images/full.png',
            avatar_url: 'https://botbooru.test/images/preview.png',
        });
        openBotbooruAvatarViewer({
            avatar_url: 'https://botbooru.test/images/preview-only.png',
        });

        assert.deepEqual(calls, [
            ['https://botbooru.test/images/full.png', 'https://botbooru.test/images/preview.png'],
            ['https://botbooru.test/images/preview-only.png', 'https://botbooru.test/images/preview-only.png'],
        ]);
    } finally {
        BrowseView.openAvatarViewer = originalOpenAvatarViewer;
    }
});

test('BotBooru grid render plan appends only newly visible browse cards', async () => {
    globalThis.window = globalThis.window || {};
    const { getBotbooruGridRenderPlan } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=grid-plan-${Date.now()}`);
    const characters = [
        { id: 1, name: 'Alpha' },
        { id: 2, name: 'Bravo' },
        { id: 3, name: 'Charlie' },
    ];

    assert.deepEqual(
        getBotbooruGridRenderPlan(characters, 1, true),
        {
            mode: 'append',
            characters: [{ id: 2, name: 'Bravo' }, { id: 3, name: 'Charlie' }],
        },
    );
    assert.deepEqual(
        getBotbooruGridRenderPlan(characters, 0, true),
        {
            mode: 'replace',
            characters,
        },
    );
});

test('BotBooru preview cleanup clears transient modal content', async () => {
    globalThis.window = globalThis.window || {};
    const originalDocument = globalThis.document;
    const { BrowseView } = await import('../modules/providers/browse-view.js');
    const { cleanupBotbooruCharModal } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=preview-cleanup-${Date.now()}`);
    const originalCloseAvatarViewer = BrowseView.closeAvatarViewer;
    let viewerClosed = false;

    const tracked = [{ dataset: { fullContent: 'hello' } }, { dataset: { fullContent: 'world' } }];
    const sections = {
        botbooruCharAltGreetings: { innerHTML: 'greetings' },
        botbooruCharCreatorNotes: { innerHTML: 'notes' },
        botbooruCharDescription: { innerHTML: 'description' },
        botbooruCharPersonality: { innerHTML: 'personality' },
        botbooruCharScenario: { innerHTML: 'scenario' },
        botbooruCharExamples: { innerHTML: 'examples' },
        botbooruCharFirstMsg: { innerHTML: 'first message' },
    };

    try {
        BrowseView.closeAvatarViewer = () => { viewerClosed = true; };
        globalThis.window.currentBrowseAltGreetings = ['one', 'two'];
        globalThis.document = {
            getElementById(id) {
                if (id === 'botbooruCharModal') {
                    return {
                        querySelectorAll(selector) {
                            return selector === '[data-full-content]' ? tracked : [];
                        },
                    };
                }
                return sections[id] || null;
            },
        };

        cleanupBotbooruCharModal();

        assert.equal(viewerClosed, true);
        assert.equal(globalThis.window.currentBrowseAltGreetings, null);
        assert.deepEqual(tracked.map(entry => 'fullContent' in entry.dataset), [false, false]);
        assert.deepEqual(Object.values(sections).map(section => section.innerHTML), ['', '', '', '', '', '', '']);
    } finally {
        BrowseView.closeAvatarViewer = originalCloseAvatarViewer;
        globalThis.document = originalDocument;
    }
});

test('BotBooru cards render creator as static text until author search is supported', async () => {
    globalThis.window = globalThis.window || {};
    const { renderBotbooruCardMarkup } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=static-creator-${Date.now()}`);

    const html = renderBotbooruCardMarkup({
        id: 1,
        name: 'Daphne',
        creator: 'spaghettiman',
        tags: [],
    });

    assert.match(html, /botbooru-card-creator/);
    assert.doesNotMatch(html, /browse-card-creator-link/);
});

test('BotBooru personalized modes apply selected sort locally', async () => {
    globalThis.window = globalThis.window || {};
    const { sortBotbooruCharactersForView } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=local-curated-sort-${Date.now()}`);
    const posts = [
        { id: 1, name: 'Bowsette', favorites: 1, views: 35, downloads: 3, createdAt: '2026-01-01T00:00:00Z' },
        { id: 2, name: 'Osana Robin', favorites: 2, views: 25, downloads: 4, createdAt: '2026-01-02T00:00:00Z' },
        { id: 3, name: 'Bowsette Alt', favorites: 0, views: 7, downloads: 5, createdAt: '2026-01-03T00:00:00Z' },
    ];

    assert.deepEqual(sortBotbooruCharactersForView(posts, 'curated', 'favorites').map(post => post.id), [2, 1, 3]);
    assert.deepEqual(sortBotbooruCharactersForView(posts, 'curated', 'downloads').map(post => post.id), [3, 2, 1]);
    assert.deepEqual(sortBotbooruCharactersForView(posts, 'curated', 'latest').map(post => post.id), [3, 2, 1]);
    assert.deepEqual(sortBotbooruCharactersForView(posts, 'favorites', 'favorites').map(post => post.id), [2, 1, 3]);
    assert.deepEqual(sortBotbooruCharactersForView(posts, 'favorites', 'downloads').map(post => post.id), [3, 2, 1]);
    assert.equal(sortBotbooruCharactersForView(posts, 'browse', 'favorites'), posts);
});

test('BotBooru filter bar exposes Browse and Curated mode buttons', async () => {
    globalThis.window = globalThis.window || {};
    globalThis.window.escapeHtml = value => String(value ?? '');
    const { default: browseView } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=${Date.now()}`);

    const html = browseView.renderFilterBar();

    assert.match(html, /data-botbooru-view="browse"/);
    assert.match(html, /data-botbooru-view="curated"/);
    assert.match(html, />\s*Browse\s*</);
    assert.match(html, />\s*Curated\s*</);
    assert.match(html, /<option value="curated"[^>]*hidden/);
});
