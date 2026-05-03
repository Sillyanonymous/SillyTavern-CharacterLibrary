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

test('BotBooru Curated mode applies selected sort locally', async () => {
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
