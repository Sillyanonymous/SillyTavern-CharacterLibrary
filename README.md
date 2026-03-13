# SillyTavern Character Library

A powerful SillyTavern extension for discovering, organizing, and managing your character library with a modern glassmorphic interface.

> **Note:** This is a hobby project but things mostly work. Expect bugs, use at your own risk.

## Screenshots

![Main Gallery View](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_Main.jpg)
*Browse your character library with search, filtering, and sorting*

![Character Details](https://github.com/Sillyanonymous/assets/blob/main/v2_Details.png)
*View and edit character details, chats, media, and related characters*

![Character Gallery](https://github.com/Sillyanonymous/assets/blob/main/v2_Gallery.jpg)
*Download embedded character media*

![Character Details Expanded views](https://github.com/Sillyanonymous/assets/blob/main/v2_creatorsNotes.png)
*Expand separate views such as Creator's notes*

![Related Characters](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_Similar.png)
*Find potentially related characters*

![ChubAI Integration](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_online_tab.jpg)
*Browse and download characters from online providers*

![Batch Operations](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_batchOperations.jpg)
*Apply changes to any number of selected characters*

![Batch Tagging](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_batchTagging.jpg)
*...Such as Batch tagging*

![Batch Updates](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_batchUpdates.jpg)
*...Batch updates*

![Batch Updates](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/v2_batchPlaylists.jpg)
*...and much more*

## Installation

1. Clone to your SillyTavern extensions folder:
   ```
   SillyTavern/data/default-user/extensions/SillyTavern-CharacterLibrary
   ```
2. Refresh SillyTavern's page
3. Click SillyTavern's native "Character Management" button. A dropdown appears where you can select Character Library
4. *(Optional)* For Pygmalion and CharacterTavern login (required for NSFW browsing), install the [cl-helper plugin](#cl-helper-plugin-not-detected)



## ✨ Core Features

### 📚 Character Discovery & Organization

- **Grid view** with virtual-scroll and progressive lazy-loading
- **Search** across name, tags, author, and creator's notes, plus [special search filters](#search-filters)
- **Tag filtering** with include/exclude/neutral tri-state logic
- **Sort** by name, last modified, or date created
- **Favorites** filter, with SillyTavern native favorites sync
- **Card updates** from any linked provider with field-level diffs (single or batch)
- **Batch tagging** to add or remove tags across multiple characters at once
- **Multi-select** for batch tagging, favorites, update checks, export, or deletion
- **Right-click context menu** on any character card for quick actions
- **Version history & snapshots** with save/restore, remote version browsing, and full diff preview
- **Playlists** for organizing characters into named, ordered virtual folders with icons and colors

### 🎨 Character Details

Click any character for a **rich tabbed interface**:

| Tab | Description |
|-----|-------------|
| **Details** | Rich markdown/HTML/CSS rendering in a secure sandboxed iframe, embedded images, creator notes, alternate greetings, embedded lorebooks |
| **Edit** | Full character card editor with change tracking and visual diff preview |
| **Chats** | All conversations with message counts; resume any chat directly |
| **Gallery** | Images (PNG/JPG/WebP/GIF), video, and audio (MP3/WAV/OGG/M4A) with built-in players. Download embedded media and provider galleries |
| **Related** | Smart recommendations based on shared tags, creator, and content keywords |
| **Versions** | Local snapshots and remote version history with diff preview (shown when history exists) |
| **Info** | Debug/metadata panel for power users (enable in Settings) |

**Edit Lock** prevents accidental changes.

---

## 🔧 Feature Details

<details open>
<summary><h3>🖼️ Media Management</h3></summary>

- **Gallery tab** for all character images, video, and audio in one place
- **Embedded media downloads** for images linked in creator notes, descriptions, and greetings
- **Provider gallery downloads** from linked characters on ChubAI, Wyvern, or Pygmalion
- **Audio & video support** including MP3, WAV, OGG, M4A with built-in player; video thumbnails with inline playback
- **Full-screen viewer** with keyboard navigation (← → 0 Esc) and scroll-wheel zoom up to 5× with drag-to-pan
- **Bulk localization** across your whole library from Settings, with progress tracking, abort, and history
- **Optional provider gallery** inclusion in bulk localization

</details>

<details>
<summary><h3>🎴 On-the-Fly Media Localization</h3></summary>

Many character cards embed images from external hosts (Imgur, Catbox, etc.) which can be slow, unreliable, or go offline. Media Localization downloads these images locally and swaps the URLs **at display time only**. Your original character cards are never modified.

1. Download embedded media via the **Gallery tab** → **"Download Embedded Media"**
2. Enable **"Media Localization"** in Settings (globally or per-character)
3. Remote URLs are transparently replaced with local copies in:
   - Character Library detail views (creator notes, greetings, descriptions)
   - **SillyTavern chat messages and Creator's Notes**, live in your conversations

> **Note:** Some image hosts block direct downloads due to CORS restrictions. SillyTavern's built-in CORS proxy handles this automatically, but it must be enabled. See [Troubleshooting](#media-downloads-fail-with-cors-errors) if downloads fail.

</details>

<details>
<summary><h3>♻️ Card Updates</h3></summary>

Keep provider-linked characters in sync with their online source:

1. Run **Check for Updates** (single character or batch)
2. Review side-by-side diffs for each field
3. Apply selected fields or apply all in batch

Updates are fetched from the provider's API and only change the fields you choose. Works with all five providers: ChubAI, JanitorAI, CharacterTavern, Pygmalion, and Wyvern.

> Review fields carefully before applying. If you manually tag your characters, skip the tags field during sync.

</details>

<details>
<summary><h3>🕓 Version History & Snapshots</h3></summary>

Track changes and restore previous versions of your character cards.

#### Remote Versions (ChubAI)
- View the full published version history from ChubAI's Git API
- Field-by-field diff preview comparing any version to your local card
- Restore any remote version with one click

#### Local Snapshots (All Characters)
- **Save snapshots** of any character's current state at any time
- **Restore, rename, or delete** individual snapshots
- **Auto-backup** before every restore, edit, or card update, with one-click undo
- Auto-backups are deduped and capped at a configurable max (default 10) per character

#### Diff Preview
- Side-by-side comparison for every card field
- **Tags** shown as pill badges with added/removed/kept highlighting
- **Alternate greetings** displayed as numbered expandable blocks with change badges
- **Long text fields** use LCS-based line diff with added/removed highlighting
- Small diffs (≤8 lines) auto-expand for quick review
- Avatar thumbnail with apply button to update the character's image

#### Storage
Snapshots are stored as JSON files via SillyTavern's Files API (`user/files/`), using a per-character file with a master index for fast lookups. Each character gets a stable `version_uid` that travels with the card PNG, so snapshots survive renames and reimports.

</details>

<details>
<summary><h3>🔍 Duplicate Detection</h3></summary>

- **Name similarity** and **creator matching**
- **Jaccard similarity** for content comparison
- **Duplicate media detection** via file hashing
- **Match confidence & reasoning** for each result
- **Delete duplicates** directly from the interface
- **Pre-import warnings** when downloading potential duplicates

</details>

<details>
<summary><h3>🔗 Related Character Discovery</h3></summary>

Automatically finds similar characters via:
- **Shared tags** with rarity weighting (rare tags = stronger signal)
- **Same creator**
- **Content keywords** (shared universes, franchises, themes)

Shows relationship strength and reasoning for each suggestion.

</details>

<details>
<summary><h3>🎲 Card Recommender</h3></summary>

An AI-powered recommendation engine that uses your connected LLM to discover characters from your library based on natural-language prompts.

#### How It Works

1. **Describe what you want.** "Cozy fantasy girls," "dark horror villains," "sci-fi androids with deep lore," etc.
2. Characters are **sampled from your library** and their metadata (name, tags, creator, creator notes, tagline) is sent to your LLM.
3. The model evaluates each character against your prompt and returns a **ranked list with reasons.**
4. Results appear as clickable cards. Tap any to open the full character detail modal.

#### Batch Mode

For larger libraries, Batch Mode splits your sample pool across multiple parallel batches:

1. **Map phase.** The pool is divided into N batches (configurable, 3-7) and all batches are evaluated simultaneously via parallel API calls.
2. **Reduce phase.** All picks from every batch are collected, deduplicated, and sent to a final ranking pass that selects the best overall matches.
3. Wall-clock time stays roughly the same as a single call thanks to parallelism, but library coverage scales with the batch count (e.g. 5 batches = 5x more characters evaluated).

#### Sample Pool

The Sample Pool controls which characters are eligible for recommendation. Apply pre-sampling filters to narrow the pool, and the "characters in pool" count updates in real time as you adjust them:

- **Has Chats** / **Favorite** tri-state filters (Yes / Any / No)
- **Date Created** range
- **Include / Exclude tags** with autocomplete

If the pool is larger than your configured Sample Size, characters are randomly selected from the filtered pool to fit. For example, with 2,000 characters matching your filters and a sample size of 600, a random subset of 600 is drawn each time you generate.

#### LLM Context

Controls which card metadata fields are included when sending characters to the LLM. Toggle any combination of: tags, creator notes, tagline, creator name, and source provider. A live token estimate updates as you change these, helping you stay within model context limits.

#### API Modes

- **SillyTavern mode** uses your active Chat Completion connection (OpenAI, Claude, OpenRouter, etc.). If you have Connection Profiles configured, a dropdown lets you pick which profile to use. Large, RP heavy presets not recommended.
- **Custom API mode** lets you point to any OpenAI-compatible endpoint with optional API key and model. (Mostly placeholder, still WIP)

#### Settings

| Setting | Description |
|---------|-------------|
| Sample Size | Characters per batch (10-500) |
| Batches | Parallel batch count in Batch Mode (3-7) |
| Temperature | LLM sampling temperature (Custom API only, ST mode uses your preset) |
| Max Results | Maximum recommendations to return |
| LLM Context | Toggle which metadata fields to include (tags, creator notes, tagline, creator, source) with live token estimate |

Access via the **⋮ menu** → **Card Recommender**.

> **Requirements:** Chat Completion APIs only (not Text Completion). The model must be capable of returning structured JSON, so budget/nano models may produce unparseable results. Models like GPT-4o-mini, Claude Haiku, Gemini Flash, or equivalent work well.

> **Non-deterministic.** LLMs are inherently probabilistic, so running the same prompt twice may yield different recommendations.

> **Token usage.** Each generation sends your sample pool's metadata to the model. The live token estimate in Settings helps you gauge cost before generating, but it is a rough approximation based on loose averages, not an actual token count. Enabling more context fields (creator notes, tagline) increases token usage per character. In Batch Mode, tokens scale linearly with the batch count, plus a smaller reduce pass.

</details>

<details>
<summary><h3>💬 Chat History Browser</h3></summary>

- **Browse all conversations** across all characters
- **Sort by** date, character name, message count, chat length, or most active character
- **Group by character** or view flat list
- **AI model badges** showing which model was used for each conversation
- **Message previews** before opening
- **Jump into any chat** without returning to SillyTavern

</details>

<details>
<summary><h3>🗂️ Unique Gallery Folders</h3></summary>

> ⚠️ **Experimental Feature.** Enable in Settings, Gallery Folders.

#### The Problem
SillyTavern stores gallery images in folders named after the character (e.g., `/user/images/Nami/`). Multiple characters with the same name share the same folder, mixing all their images together.

#### The Solution
Each character gets a **unique gallery folder** using a 12-character ID:
```
/user/images/Nami_aB3xY9kLmN2p/
/user/images/Nami_7Fk2mPqR4sXw/
```

A `gallery_id` is stored in the character's `data.extensions` and SillyTavern's gallery extension is configured to use the unique folder.

#### Migration Tools
- **Assign Gallery IDs** to characters that don't have one
- **Migrate All Images** from old folders to new unique folders (uses content hashing for shared-name disambiguation)
- **Browse Orphaned Folders** to find and redistribute images from legacy folders

#### Disabling
When disabled, you can choose to move images back to default folders, keep them in place, or cancel.

> Gallery IDs in character data are preserved when disabled, so re-enabling uses the same IDs.

<details>
<summary>⚠️ Why Experimental?</summary>

- **Changes ST's default behavior** by overriding how SillyTavern resolves gallery folders
- **Modifies character data** by adding `gallery_id` to character extensions
- **Migration complexity** for large libraries with many same-name characters
- The character card ecosystem has barely enforced standards, so media URLs, CDN behaviors, and creator practices vary wildly

**Back up your ST user folder before enabling this feature.**

</details>

</details>

<details>
<summary><h3>✅ Gallery Integrity & Sync</h3></summary>

When **Unique Gallery Folders** is enabled, each character's gallery depends on a `gallery_id` stored in the card and a matching folder override registered with SillyTavern. If either gets out of sync (e.g., importing a card directly through SillyTavern, or after a backup restore), images can end up in the wrong folder or become invisible.

- **Status indicator** showing audit results and warnings at a glance in the Gallery tab
- **Integrity checks** for missing `gallery_id`s, orphaned mappings, and unregistered overrides
- **Cleanup tools** to assign or remove orphaned mappings safely
- **ST import warning + 1-click fix** when a card is added directly in SillyTavern

</details>

---

## 🌐 Online Providers

The **Online** tab lets you browse, search, and import characters from multiple online sources. Switch between providers using the provider selector dropdown.

All providers share a common set of capabilities:
- **Browse & search** with filtering and sorting
- **Infinite scroll** with automatic page loading as you scroll (toggleable per provider)
- **In-app character preview** with full card details, gallery images, and stats
- **One-click import** to your local library
- **"In Library" badges** on characters you already own
- **"Hide Owned" filter** to only show characters not in your library
- **NSFW toggle** to show or hide NSFW content
- **Character linking** to link local characters to their online source for updates
- **Bulk link scanner** to automatically scan your library and match unlinked characters
- **Auto-link on import** for characters imported from any provider

### Provider Feature Matrix

| Feature | ChubAI | JanitorAI | CharacterTavern | Pygmalion | Wyvern |
|---------|--------|-----------|-----------------|-----------|--------|
| Browse & Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| Card Updates | ✅ | ✅ | ✅ | ✅ | ✅ |
| Character Linking | ✅ | ✅ | ✅ | ✅ | ✅ |
| Gallery Downloads | ✅ | -- | -- | ✅ | ✅ |
| Remote Version History | ✅ | -- | -- | -- | -- |
| Following / Timeline | ✅ | -- | -- | ✅ | ✅ |
| Favorites | ✅ | -- | -- | -- | -- |
| Auth Required | Optional | None | Optional | Optional | Optional |

<details>
<summary><h3>ChubAI</h3></summary>

**Auth:** Optional URQL token (from browser DevTools → Local Storage → `URQL_TOKEN`)

#### Without Authentication
- Browse and search public characters
- Full filtering by tags, token count, content features
- Discovery presets: Popular (week/month/all), Top Rated, Newest, Recently Updated, Random, and more
- In-app character preview with metadata and download stats

#### With URQL Token
- **Timeline** with new releases from followed authors
- **Favorites filtering** to show only your saved favorites
- **Toggle favorites** to add/remove from your ChubAI favorites list
- **Follow/Unfollow authors** to track creators you like
- **Restricted content** access

#### ChubAI-Specific Features
- **Gallery downloads** from linked characters
- **Remote version history** showing the full Git commit history of any linked character
- **V4 Git API** (optional setting) for fetching card data directly from ChubAI's Git repository
- **Linked lorebook resolution** for lorebooks linked to a character (not just embedded ones)

#### Getting Your Token
1. Log into [chub.ai](https://chub.ai)
2. Open DevTools (F12) → **Application** tab → **Local Storage** → `https://chub.ai`
3. Copy the `URQL_TOKEN` value
4. Paste in Character Library Settings

</details>

<details>
<summary><h3>JanitorAI</h3></summary>

**Auth:** None required. Uses a public API key automatically.

- Browse and search the full JanitorAI character catalog
- Filter by tags, token count, NSFW toggle
- In-app character preview with card details
- Character linking and card updates

No gallery downloads or version history (JanitorAI doesn't expose these APIs).

</details>

<details>
<summary><h3>CharacterTavern</h3></summary>

**Auth:** Optional session cookie (for NSFW access). Requires the [cl-helper plugin](#cl-helper-plugin-not-detected).

- Browse and search the CharacterTavern catalog
- Filter by tags, token count, has-lorebook, is-OC (original character)
- In-app character preview with card details
- Character linking and card updates

#### NSFW Access
CharacterTavern requires a session cookie for NSFW content. To set it up:
1. Ensure the [cl-helper plugin](#cl-helper-plugin-not-detected) is installed and detected
2. Log into [character-tavern.com](https://character-tavern.com) in your browser
3. Open DevTools (F12) → **Application** tab → **Cookies** → `character-tavern.com`
4. Copy the `session` cookie value
5. Paste it in the login modal (appears when you enable NSFW) or in Settings

</details>

<details>
<summary><h3>Pygmalion</h3></summary>

**Auth:** Optional email/password login. Requires the [cl-helper plugin](#cl-helper-plugin-not-detected).

- Browse and search the Pygmalion character catalog
- Filter by tags, NSFW toggle
- Sort by downloads, stars, views, chat count, or newest
- In-app character preview with card details
- Character linking and card updates

#### With Authentication
- **Following timeline** with characters from users you follow
- **Follow/Unfollow users** from within the app
- **Gallery downloads** including alt avatars, alt images, and chat backgrounds
- **"Remember credentials"** for automatic token refresh

#### Login
1. Ensure the [cl-helper plugin](#cl-helper-plugin-not-detected) is installed and detected
2. When you enable NSFW or access a login-required feature, a login modal will appear
3. Enter your Pygmalion email and password (or set them in Settings)
4. *(Optional)* Check "Remember credentials" for auto-refresh

</details>

<details>
<summary><h3>Wyvern</h3></summary>

**Auth:** Optional email/password login (Firebase). No plugin required.

- Browse and search the Wyvern character catalog
- Discovery-focused sorting: popularity, recommended, newest, most likes, and most messages
- Filter by tags and NSFW state
- In-app character preview before import
- Gallery downloads from linked Wyvern characters

#### With Authentication
- **Following timeline** from creators you follow
- **Follow/Unfollow users** directly from the preview modal

#### Character Library Integration
- **Link local cards to Wyvern** for update checks and sync
- **Auto-link on import** when importing directly from Wyvern

#### Login
1. When you enable NSFW or access a login-required feature, a login modal will appear
2. Enter your Wyvern email and password (or set them in Settings)
3. *(Optional)* Check "Remember credentials" for auto-refresh

</details>

### Character Linking

Link your local characters to their online source for updates, gallery downloads, and version history:

- **Manual linking** via the provider indicator in character details
- **Bulk link scanner** to auto-match unlinked characters (accessible from the ⋮ menu)
- **Auto-link on import** for characters downloaded from any provider
- **View on provider** to jump to the source site or open an in-app preview

### Batch Import

- Paste multiple URLs from any supported provider (one per line)
- Drag & drop or browse local PNG character card files
- Progress tracking and error logging
- Pre-import duplicate detection
- **Auto-download options** to download gallery and embedded media during import

---

## 🔎 Search Filters

Type these prefixes in the search bar for targeted filtering:

| Filter | Example | Description |
|--------|---------|-------------|
| `creator:` | `creator:AuthorName` | Exact creator/author match |
| `fav:` | `fav:yes` or `fav:no` | Filter by favorites status |
| `linked:` | `linked:yes` or `linked:no` | Any provider link |
| `chub:` | `chub:yes` or `chub:no` | ChubAI link specifically |
| `janny:` | `janny:yes` or `janny:no` | JanitorAI link specifically |
| `ct:` | `ct:yes` or `ct:no` | CharacterTavern link specifically |
| `pygmalion:` | `pygmalion:yes` or `pygmalion:no` | Pygmalion link specifically |
| `wyvern:` | `wyvern:yes` or `wyvern:no` | Wyvern link specifically |
| `version:` | `version:1.0` | Match character version string |
| `gallery:` | `gallery:aB3x` or `gallery:none` | Match gallery ID (or `none` for unassigned) |
| `uid:` | `uid:abc123` or `uid:none` | Match version UID (or `none` for unassigned) |
| `playlist:` | `playlist:backlog` or `playlist:none` | Match playlist name (or `none`/`any` for membership) |

Regular search matches across name, tags, author, and creator's notes (toggleable via checkboxes).

Prefixes can be combined with each other and with free text. For example, `creator:john linked:yes dark elf` finds linked characters by "john" matching "dark elf" in the enabled search fields.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Escape` | Close modals, overlays, exit multi-select mode |
| `Space` | Toggle multi-select mode (when not in a text field) |
| `Enter` | Add tag (when tag input is focused) |
| `Arrow Down` | Focus first tag suggestion |
| `← / →` | Navigate images in gallery viewer |
| `0` | Reset zoom in gallery viewer |
| `Scroll wheel` | Zoom in/out in gallery viewer |

---

## 📱 Mobile

The full app is optimized for mobile with:

- **Touch-optimized** tap targets and swipe gestures
- **View swipe**: swipe left/right on the main screen to switch between Characters, Chats, and Online views
- **Tab swipe**: swipe left/right on character detail tabs to navigate between them
- **Greetings swipe**: swipe left/right to cycle alternate greetings
- **Bottom sheets** for context menus, tag editor, filters, and settings (replacing desktop dropdowns)
- **Full-viewport modals** for character details and previews
- **Mobile search overlay** with dedicated search UI
- **Gallery viewer** with zoom, drag pan, and swipe navigation
- **Back button handling** for modal navigation

---

## ❓ Troubleshooting

### cl-helper plugin not detected

The **cl-helper** plugin is required for Pygmalion and CharacterTavern login, which unlocks NSFW browsing on both providers. It ships with Character Library in the `extras/cl-helper/` folder but needs to be placed in SillyTavern's plugins directory:

1. Copy (or symlink) the `extras/cl-helper` folder into your SillyTavern **plugins** directory:
   ```
   SillyTavern/plugins/cl-helper/
   ```
2. Open your SillyTavern **config.yaml** (in your ST root folder) and set `enableServerPlugins` to `true`:
   ```yaml
   enableServerPlugins: true
   ```
3. **Restart SillyTavern** (plugins only load at startup)
4. Verify in the login/auth modal (appears when enabling NSFW). You should see "cl-helper plugin detected"

> The plugin runs server-side to handle auth flows that browsers can't do directly (e.g. Origin headers for Pygmalion, cookie proxying for CharacterTavern). It only communicates with the specific provider APIs. See the [plugin source](extras/cl-helper/index.js) for details.

### Media downloads fail with CORS errors

Some image hosts (Imgur, Catbox, etc.) block direct browser requests due to CORS restrictions. Character Library automatically falls back to SillyTavern's built-in CORS proxy, but it must be enabled:

1. Open **SillyTavern** (main page, not Character Library)
2. Go to **User Settings** (top-left user icon)
3. Scroll to the **Network** section
4. Enable **"CORS Proxy"**
5. Retry the download in Character Library

This affects embedded media downloads, provider gallery downloads, and bulk localization.
