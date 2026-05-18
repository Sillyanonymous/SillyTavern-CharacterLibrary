# BotBooru Provider Design

Date: 2026-04-30

## Goal

Add BotBooru (`https://botbooru.com/`) as a first-class Online provider in Character Library. The provider should support anonymous public browsing, importing character cards, linking local cards to BotBooru posts, update checks, and optional authenticated favorites.

BotBooru public endpoints allow anonymous browsing and downloads, including NSFW results when `sfw_only=false`, but they do not expose browser CORS headers. Character Library will use the bundled `cl-helper` server plugin as a public proxy for BotBooru API access even when no token is configured.

## Selected Approach

Implement a full provider plus public-first `cl-helper` proxy support.

This matches the existing provider architecture and keeps BotBooru-specific network behavior in one place:

- Browser provider modules own UI state, card normalization, import/link/update behavior, and settings.
- `cl-helper` owns server-side BotBooru requests that need to bypass browser CORS, with or without a token.
- Browsing, previewing, importing, and update checks are anonymous by default.
- Authentication uses a pasted BotBooru bearer/access token only for account-specific features, similar to Chub's token flow. Character Library will not store BotBooru username/password credentials.

## Provider Scope

Provider identity:

- `id`: `botbooru`
- `name`: `BotBooru`
- Enabled by default.
- NSFW toggle defaults to enabled by sending `sfw_only=false`.
- No token is required for normal browse, preview, import, or update-check flows.

Initial provider capabilities:

- Browse/search BotBooru posts anonymously through `/posts/`.
- Fetch post detail anonymously through `/post/{id}`.
- Import cards anonymously using `/download/png/{id}`.
- Fetch V2 JSON anonymously for update comparison using `/download/json/{id}`.
- Link local cards with `extensions.botbooru`.
- Check linked cards for updates by comparing remote JSON against local V2 data.
- Show an authenticated Favorites view when a token is configured.
- Add/remove favorites from preview cards when authenticated.

Out of scope for the first pass:

- Remote version history.
- BotBooru upload/moderation flows.
- Username/password login or automated token refresh.
- Gallery downloads beyond embedded media already handled by Character Library.

## Files And Components

New provider files:

- `modules/providers/botbooru/botbooru-api.js`
- `modules/providers/botbooru/botbooru-provider.js`
- `modules/providers/botbooru/botbooru-browse.js`
- `modules/providers/botbooru/botbooru-browse.css`

Modified shared files:

- `modules/module-loader.js`: load BotBooru CSS and register the provider.
- `app/library.html`: add BotBooru settings/help UI, helper-required banner, token controls, and provider docs/search-help entries.
- `app/library.js`: add BotBooru defaults, settings field wiring, helper availability checks, token validation/clear behavior, exclude-tag wiring, and Online view refresh after settings changes.
- `index.js`: include `botbooru` in provider extension-key detection where needed.
- `README.md`: document BotBooru, token setup, favorites, and helper requirement.
- `extras/cl-helper/index.js`: add BotBooru proxy/auth/favorites routes.
- `extras/cl-helper/package.json`: bump helper version if route behavior changes.

Existing contracts to preserve:

- `provider-registry.js` owns provider ordering, disabled-provider filtering, provider selector rendering, and activation.
- `BrowseView` owns the common browse lifecycle and calls each provider's `renderFilterBar()`, `renderView()`, `renderModals()`, `activate()`, and `deactivate()`.
- The Online tab shell is static in `app/library.html`: `#providerSelectorArea`, `#onlineFilterContent`, and `#onlineView`.
- Individual providers inject their own filter bars, browse grids, previews, and modals when activated.

## Browse Integration Audit

The implementation should follow the current Online-provider path:

1. `modules/module-loader.js` imports the provider module and provider CSS, then registers it with `ProviderRegistry`.
2. `app/library.js` activates Online browsing through `activateOnlineProvider()`, which asks `ProviderRegistry` for enabled view providers and mounts the selector into `#providerSelectorArea`.
3. `ProviderRegistry.activateProvider()` injects the active provider's filter bar into `#onlineFilterContent` and its main browse view into `#onlineView`.
4. `BrowseView.activate()` injects provider modals into `document.body` and wires provider-specific events.

This means BotBooru should not add a static browse grid to `app/library.html`. It should add static settings/help entries there, while the actual BotBooru browse UI lives in `botbooru-browse.js`.

Settings integration needs explicit host-extension wiring:

- Add `botbooruToken`, token visibility, validation, clear/session status, and `botbooruNsfw` defaults.
- Keep BotBooru enabled by default rather than adding it to `disabledProviders`.
- Add BotBooru to provider order/defaults through its provider `getSettingsConfig()`.
- Add BotBooru to `EXCLUDE_TAG_PROVIDERS` if persistent exclude tags are supported.
- Add BotBooru to the provider extension-key arrays used for linked-card detection/export/import behavior.
- Add BotBooru URL recognition to the provider so the existing Import-by-URL flow can call `getProviderForUrl()` and `importCharacter(id)`.

## BotBooru API Shape

Observed endpoints:

- `GET /posts/?sort=latest&limit=...&offset=...&sfw_only=false`
- `GET /post/{id}`
- `GET /download/json/{id}`
- `GET /download/png/{id}`
- `GET /interactions/{postId}/favorites`
- `POST /interactions/{postId}/favorite`
- `POST /auth/token` exists on BotBooru, but Character Library will not use it for username/password login in the first pass.

Anonymous endpoint verification:

- `/posts/?sort=latest&limit=20&offset=0&sfw_only=true` returned SFW-only public results.
- `/posts/?sort=latest&limit=20&offset=0&sfw_only=false` returned mixed SFW/NSFW public results.
- `/post/{id}`, `/download/json/{id}`, and `/download/png/{id}` returned `200` without a token for both SFW and NSFW sampled posts.
- `HEAD /download/png/{id}` returned `405`; downloads should use `GET`.
- These responses did not include CORS allow-origin headers, so browser code should still use `cl-helper`.

Initial browse parameters:

- `sort`: `latest`, `favorites`, `views`, `downloads`, `curated`, `random`
- `q`: search text/tag query
- `limit`, `offset`
- `sfw_only=false` by default; `sfw_only=true` only when the user disables NSFW
- `time_window` only for sort modes verified to support time windows

Additional BotBooru filters, such as AI-content hiding or minimum token count, stay hidden until verified against the live API.

## Helper Routes

Add BotBooru support under the existing `cl-helper` plugin:

- Reuse `GET /health` for helper availability; the provider can treat a successful `cl-helper` health response as BotBooru helper support once the helper version includes the BotBooru routes.
- `GET /bb-proxy/*`: forwards read-only BotBooru GET requests to `https://botbooru.com`; works without a token.
- `POST /bb-set-token`: stores a pasted bearer token in the helper process for the current SillyTavern server session.
- `POST /bb-clear-token`: clears the stored token.
- `GET /bb-session`: reports whether a token is currently configured.
- `GET /bb-validate`: calls `/auth/me` with the token and returns validity/user summary.
- `GET /bb-favorites`: requires a token, resolves the authenticated BotBooru user ID, and fetches that user's favorites.
- `GET /bb-favorites/:postId`: returns public favorite count and authenticated `favorited` state when a token is configured.
- `POST /bb-favorite/:postId`: requires a token and toggles favorite state for the current user.

Proxy safety rules:

- Only allow `botbooru.com` as the upstream host.
- Only allow known read endpoints through the wildcard proxy, such as `/posts/`, `/post/{id}`, `/download/json/{id}`, `/download/png/{id}`, `/images/*`, `/images/preview/*`, `/tags/*`, and `/api/users/*/favorites` if needed.
- Do not proxy arbitrary POST requests through `bb-proxy`.
- Send `Authorization: Bearer <token>` only when a token is configured and the upstream call benefits from auth.
- Do not log token values.

## Data Model

Local card link metadata:

```json
{
  "extensions": {
    "botbooru": {
      "id": 4354,
      "linkedAt": "2026-04-30T00:00:00.000Z",
      "pageName": "Sonja"
    }
  }
}
```

`getLinkInfo()` should return:

- `providerId: "botbooru"`
- `id`: numeric post ID
- `fullPath`: string form of the post ID
- `linkedAt`

Imported cards should preserve existing card fields from BotBooru's V2 JSON and add/merge the BotBooru extension metadata.

## Browse UI

BotBooru should follow the existing `BrowseView` pattern:

- Provider selector entry with BotBooru icon/logo.
- Search bar and sort/filter controls.
- NSFW toggle defaulted on.
- Hide Owned and possible-match behavior using the shared local library lookup.
- Grid cards showing name, thumbnail, tags, uploader, stats where available, and In Library badges.
- Preview modal with full text fields, tags, uploader/source metadata, import button, link button, view-on-provider button, and favorite/unfavorite button when authenticated.

Browse modes:

- `browse`: normal search/latest/discovery results.
- `favorites`: authenticated BotBooru favorites for the current token/account.

If the user opens Favorites without a valid token, show a token-required empty state and a button to open the token modal. Normal Browse remains available without any token.

## Auth UX

Use a token modal similar to Chub:

- Explain that users should copy the BotBooru token from their browser local storage after logging in on BotBooru.
- Store the token in Character Library settings/local storage only when the user chooses to enable account features.
- Push the token into `cl-helper` via `/bb-set-token` before authenticated favorites calls.
- Validate with `/bb-validate`.
- Provide clear states: not configured, helper missing, token invalid, authenticated.
- Keep the token UI visually secondary so users understand BotBooru browsing/import works anonymously.

No username/password collection is included.

## Import And Update Flow

Import flow:

1. Fetch post detail and/or V2 JSON through `cl-helper`.
2. Fetch PNG through `cl-helper`.
3. Ensure the card has `extensions.botbooru`.
4. Use shared import pipeline to upload to SillyTavern.
5. Mark the browse card as In Library.

Update flow:

1. For a linked local card, fetch `/download/json/{id}` through `cl-helper`.
2. Normalize to V2 if needed.
3. Compare against local card fields using existing update comparison flow.
4. Include BotBooru-specific comparable fields only if they add real value beyond V2 fields.

## Error Handling

Expected cases:

- Helper missing: show a provider-specific helper-required message for BotBooru because browser fetches are blocked by CORS even for public endpoints.
- Token missing: public browse/import/update flows still work through `cl-helper`; Favorites and favorite actions show token-required UI.
- Token invalid/expired: clear helper session state, keep saved token available for editing, and show a revalidate/login prompt.
- BotBooru returns 401/403 for a future account-gated route: show an authenticated-content-required message for that action only.
- Network/proxy failure: use existing provider loading/error states and toasts.
- Download failure: surface which asset failed and keep the import modal usable.

## Testing

Manual verification:

- Provider loads in Online provider selector.
- Public browse returns BotBooru cards through `cl-helper` without a token.
- NSFW default is on and uses `sfw_only=false`.
- SFW toggle sends `sfw_only=true`.
- Token modal validates a pasted token and handles invalid token errors.
- Favorites view loads with a valid token and blocks gracefully without one.
- Favorite/unfavorite changes preview state and count.
- Import creates a local card with `extensions.botbooru` without requiring a token.
- Linked update check fetches remote JSON without requiring a token and reports field diffs.
- Helper refuses disallowed proxy paths and never logs token values.

Code verification:

- Run any existing lint/test command if present.
- If no automated tests exist, run syntax checks or module import checks for touched JavaScript where feasible.
- Inspect `git diff` for accidental unrelated changes.
