# Janny Bookmark Sync — Future Approaches

Round 1 (local-only bookmarks, stored in extension settings under
`jannyBookmarks`) is the current behavior. The notes below capture two
approaches that were considered for actually syncing with jannyai.com's own
bookmark feature. **Both are blocked today by Cloudflare** sitting in front
of jannyai.com — direct browser-side requests to the bookmark endpoints get
challenged/403'd, even with the user's auth cookie.

## Option A — Route through `cl-helper`

Reuse the same proxy mechanism that already scrapes character pages
(`provider.fetchMetadata()` in `janny-provider.js`, which goes via
`fetchWithProxy` in `janny-api.js`). The `extras/cl-helper` server already
relays browser-blocked requests to Janny; extending it to forward the
bookmark POST/DELETE/list endpoints would let us carry the user's session
cookie through Cloudflare.

**What this would need:**
- New `cl-helper` endpoints: `GET /janny/bookmarks`, `POST /janny/bookmarks/<id>`,
  `DELETE /janny/bookmarks/<id>` — each forwarding to jannyai.com with the
  user-supplied cookie/auth and returning the upstream response.
- A way for the user to paste their jannyai.com session token/cookie into
  the extension (mirror Chub's `chubToken` UI in `chub-browse.js:1306-1356`).
- A `Sync now` button that pulls the server list, merges with local
  snapshots, and updates `jannyBookmarks`.
- Conflict policy: server-wins on the bookmark *set*, local-wins on
  snapshot data (since the local snapshot may outlive a deleted card).

**Pros:** real two-way sync, bookmarks made on jannyai.com show up in the
extension and vice versa.
**Cons:** requires `cl-helper` update + redistribution, and the user has to
keep their session cookie current.

## Option B — Manual import bridge

Skip Cloudflare entirely by having the user do the auth themselves: they
visit their jannyai.com bookmarks page logged-in, then either paste the
HTML or a small JSON dump (via a one-line userscript / bookmarklet) into a
new extension dialog. The extension parses it and merges the IDs into
`jannyBookmarks`, fetching each via the existing search API to populate
snapshots.

**What this would need:**
- An "Import from jannyai.com" button in the bookmarks view.
- A modal accepting pasted HTML or JSON; a parser that pulls character IDs
  out of `<a href="/characters/<id>_character-...">` links.
- A batched MeiliSearch lookup by ID list (Janny's MeiliSearch supports
  `filter: "id IN [...]"`) to hydrate the snapshots.
- Optional: a tiny bookmarklet snippet documented in the modal that scrapes
  the user's bookmarks page in their browser context and dumps JSON.

**Pros:** zero server-side work, no cookie handling, no Cloudflare fight.
**Cons:** one-shot import (no live sync), user has to repeat occasionally,
relies on jannyai.com's HTML structure staying parseable.

## Cross-provider note: DataCat auto-bookmark on extraction

DataCat's web UI has its own bookmarks, and logged-in users who extract a
card via DataCat get that card automatically added to their DataCat
bookmarks. Character Library's extraction path (`/dc-extract` via
`cl-helper`, in `datacat-api.js`) currently uses a cl-helper-managed
session — effectively anonymous from the user's perspective — so the
auto-bookmark never lands on the user's DataCat account.

Revisiting this would mean adding a "log in with your DataCat account" UI
mirroring Chub's token modal, plus a settings toggle to route extractions
through the user's session instead of cl-helper's. Out of scope for the
current bookmark-feature round (DataCat got the same local-only treatment
as Janny); tracked here so it doesn't get lost.

## Why we're not doing either right now

Local-only already solves the original "cards disappear and I lose them"
problem because we store full snapshots, not just IDs. Either sync option
is purely a convenience upgrade, and both have non-trivial cost. Revisit
when one of these is true:
- `cl-helper` is being updated for an unrelated reason (cheap to add the
  endpoints alongside).
- Users start asking for cross-device sync and accept the cookie/token UX.
- Janny exposes a public API key (would let us skip the proxy).
