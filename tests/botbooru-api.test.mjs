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

test('BotBooru exposes Curated as a sort option without a mode toggle', async () => {
    globalThis.window = globalThis.window || {};
    globalThis.window.escapeHtml = value => String(value ?? '');
    const { default: browseView } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=${Date.now()}`);

    const html = browseView.renderFilterBar();

    assert.equal(browseView.hasModeToggle, false);
    assert.match(html, /<option value="curated"/);
    assert.doesNotMatch(html, /data-botbooru-view="browse"/);
    assert.doesNotMatch(html, /data-botbooru-view="curated"/);
    assert.equal(browseView.mobileFilterIds.timelineSort, undefined);
    assert.equal(browseView.mobileFilterIds.tags, 'botbooruTagsBtn');
});

test('BotBooru maps legacy Curated view defaults to the Curated sort', async () => {
    globalThis.window = globalThis.window || {};
    globalThis.window.escapeHtml = value => String(value ?? '');

    const elements = {
        botbooruSortSelect: { value: '' },
        botbooruFilterFavorites: { checked: false },
        botbooruFilterHideOwned: { checked: false },
        botbooruFilterHidePossible: { checked: false },
    };
    globalThis.document = {
        getElementById: id => elements[id] || null,
    };

    const { default: browseView } = await import(`../modules/providers/botbooru/botbooru-browse.js?case=legacy-curated-${Date.now()}`);

    browseView.applyDefaults({ view: 'curated' });

    assert.equal(elements.botbooruSortSelect.value, 'curated');
    assert.equal(elements.botbooruFilterFavorites.checked, false);
});
