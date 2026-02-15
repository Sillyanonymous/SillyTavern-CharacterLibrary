# SillyTavern Character Library

A powerful SillyTavern extension for discovering, organizing, and managing your character library with a modern glassmorphic interface.

> **Note:** This is a hobby project but things mostly work. Expect bugs, use at your own risk.

## Screenshots

![Main Gallery View](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/Main.jpg)
*Browse your character library with search, filtering, and sorting*

![Character Details](https://github.com/Sillyanonymous/assets/blob/main/Details.png)
*View and edit character details, chats, media, and related characters*

![Character Gallery](https://github.com/Sillyanonymous/assets/blob/main/Gallery.jpg)
*Download embedded character media*

![Character Details Expanded views](https://github.com/Sillyanonymous/assets/blob/main/Expanded%20fields.png)
*Expand separate views such as Creator's notes*

![Related Characters](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/Related.png)
*Find potentially related characters*

![ChubAI Integration](https://raw.githubusercontent.com/Sillyanonymous/assets/refs/heads/main/ChubAI.jpg)
*Browse and download characters directly from ChubAI*



## Installation

1. Clone to your SillyTavern extensions folder:
   ```
   SillyTavern/data/default-user/extensions/SillyTavern-CharacterLibrary
   ```
2. Refresh SillyTavern's page
3. Click SillyTavern's native "Character Management" button, a dropdown list will appear where you can Select Character Library



## ✨ Core Features

### 📚 Character Discovery & Organization

- **Beautiful grid view** with progressive lazy-loading
- **Powerful search** across name, tags, author, and creator's notes
- **Tag filtering** with include/exclude/neutral tri-state logic  
- **Sort** by name, last modified, or date created
- **Card updates** check for and apply field-level updates from ChubAI (single or batch)
- **Batch tagging** add or remove tags across multiple characters at once
- **Version history & snapshots** track changes, save/restore snapshots, and browse remote ChubAI version history with full diff preview

### 🎨 Character Details & Editing

Click any character for a **rich tabbed interface**:

| Tab | Description |
|-----|-------------|
| **Details** | Rich markdown/HTML/CSS rendering, embedded images, creator notes in secure sandboxed iframe, alternate greetings, embedded lorebooks |
| **Edit** | Full character card editor with change tracking and visual diff preview |
| **Gallery** | All images (PNG/JPG/WebP/GIF) and audio (MP3/WAV/OGG/M4A) with built-in players |
| **Chats** | All conversations with message counts; resume any chat directly |
| **Related** | Smart recommendations based on shared tags, creator, or content keywords |
| **Versions** | Remote ChubAI version history and local snapshots with diff preview |
| **Info (Optional)** | Debug/metadata panel for power users (enable in Settings) |

**Edit Lock** prevents accidental changes.

---

## 🔧 Feature Details

### 🖼️ Media Management

- **Gallery** for all character images, video, and audio in one tab
- **Embedded media downloads** batch download images linked in creator notes, descriptions, and greetings
- **ChubAI gallery downloads** pull gallery images from linked characters on ChubAI
- **Audio & video support** MP3, WAV, OGG, M4A with built-in player; video thumbnails with inline playback
- **Full-screen image viewer** with keyboard navigation, zoom, and slideshow
- **Download options** Per-character or bulk download

---

### 🎴 On-the-Fly Media Localization

Many character cards embed images from external hosts (Imgur, ImageShack, Catbox, etc.) which can be slow, unreliable, or go offline entirely. Media Localization links these images locally and swaps the URLs **at display time only** — your original character cards are never modified.

1. Download embedded media via the **Gallery tab** → **"Download Embedded Media"**
2. Enable **"Media Localization"** in Settings (globally or per-character)
3. When rendering, remote URLs are transparently replaced with local copies in:
   - Character Library detail views (creator notes, greetings, descriptions)
   - **SillyTavern chat messages and Creator's Notes**, live in your conversations!

**Your original character cards stay untouched** — replacement happens dynamically at display time. Fast, private, and offline-friendly!

> **Note:** Some image hosts block direct downloads due to CORS restrictions. SillyTavern's built-in CORS proxy handles this automatically, but it must be enabled. See [Troubleshooting](#-troubleshooting) if downloads fail.

---

### 🔍 Smart Duplicate Detection

- **Name similarity** and **creator matching**
- **Jaccard similarity** for content comparison
- **Duplicate media detection** via file hashing
- **Match confidence & reasoning** for each result
- **Delete duplicates** directly from the interface
- **Pre-import warnings** when downloading potential duplicates

---

### 🔗 Related Character Discovery

Automatically finds similar characters via:
- **Shared tags** with rarity weighting (rare tags = stronger signal)
- **Same creator**
- **Content keywords** (shared universes, franchises, themes)

Shows relationship strength and reasoning for each suggestion.

---

### ♻️ Card Updates

Keep Chub-linked characters in sync:

1. Run **Check for Updates** (single character or batch)
2. Review side-by-side diffs for each field
3. Apply selected fields or apply all in batch

Updates are pulled from the Chub API first (with PNG fallback) and only change the fields you choose.
Please review fields carefully before applying. If you manually tag your characters, don't synch tags. This feature will be expanded with field filtering (ie. user can decide to never compare tags, creator's notes etc)

---

### 🕓 Version History & Snapshots (New!)

Track changes and restore previous versions of your character cards:

#### Remote Versions (ChubAI-linked characters)
- View the full published version history from ChubAI
- Field-by-field diff preview comparing any version to your local card
- Restore any remote version with one click

#### Local Snapshots
- **Save snapshots** of any character's current state at any time
- **Restore, rename, or delete** individual snapshots
- **Auto-backup** a snapshot is automatically saved before every restore, edit, or card update with one-click undo
- Auto-backups are deduped (identical consecutive states are skipped) and capped at a configurable max (default 10) per character

#### Diff Preview
- Side-by-side comparison for every card field (description, personality, scenario, greetings, tags, etc.)
- **Tags** shown as pill badges with added/removed/kept highlighting
- **Alternate greetings** displayed as numbered expandable blocks with change badges
- **Long text fields** use LCS-based line diff with added/removed highlighting
- Small diffs (≤8 lines) auto-expand for quick review
- Avatar thumbnail with apply button to update the character's image

#### Storage
Snapshots are stored as JSON files via SillyTavern's Files API (`user/files/`), using a per-character file with a master index for fast lookups. Each character gets a stable `version_uid` that travels with the card PNG, so snapshots survive renames and reimports. Configure max auto-backup count in Settings → Version History.

---

### 💬 Chat History Browser

- **Browse all conversations** across all characters
- **Sort by** date, character, message count, or frequency
- **Group by character** or view flat list
- **Message previews** before opening
- **Jump into any chat** without returning to SillyTavern

---

### 📱 Mobile UI

Now optimized for small screens:

- **Mobile-friendly modal layout** and tap targets
- **Improved scrolling and navigation** for long content
- **Touch-optimized gallery viewer** (double-tap zoom, drag pan, swipe)

---

### ⚡ Bulk Media Localization

Batch-download embedded media across your whole library:

- **Bulk localization** from Settings with progress and abort
- **History tracking** to skip already-processed characters
- **Optional Chub gallery download** for linked characters

---

### 🗂️ Unique Gallery Folders

> ⚠️ **Experimental Feature** — Enable in Settings → Gallery Folders

#### The Problem
SillyTavern stores gallery images in folders named after the character (e.g., `/user/images/Nami/`). This causes **shared galleries** when you have multiple characters with the same name — for example, three different "Nami" characters from different creators would all use the same gallery folder, so viewing any "Nami" shows images from all of them mixed together.

#### The Solution
When enabled, each character gets a **unique gallery folder** using a 12-character ID:
```
/user/images/Nami_aB3xY9kLmN2p/
/user/images/Nami_7Fk2mPqR4sXw/
/user/images/Nami_9LnTvWx1cDfG/
```

#### How It Works
1. A `gallery_id` is stored in the character's `data.extensions` object:
   ```json
   {
     "data": {
       "extensions": {
         "gallery_id": "aB3xY9kLmN2p"
       }
     }
   }
   ```
2. The gallery folder becomes `{CharacterName}_{gallery_id}`
3. SillyTavern's gallery extension is configured to use this folder via `extensionSettings.gallery.folders`

> **Note:** This will update the card's updated/createdAt date.

#### Migration Tools
When enabling this feature, existing images may be in old-style folders. The Settings panel provides:

- **Assign Gallery IDs** — Add unique IDs to characters that don't have one, then automatically sync folder mappings to SillyTavern
- **Migrate All Images** — Moves images from old `CharacterName` folders to new `CharacterName_uuid` folders:
  - **Unique names** — Simple move; if only one character has that name, all images transfer directly
  - **Shared names** — Uses content hashing and ownership fingerprinting to determine which images belong to which character (compares against Chub gallery and embedded media URLs)
- **Browse Orphaned Folders** — Find and redistribute images from legacy folders that no longer match one single character

> **Note:** Folder overrides are automatically registered when you enable the feature (for characters that already have IDs) and when you click "Assign Gallery IDs" (as part of the migration process).

#### Disabling the Feature
When you disable Unique Gallery Folders, a dialog appears with options:
- **Move images back** — Relocates images from `CharName_uuid` folders back to default `CharName` folders, then clears ST folder mappings
- **Keep images in place** — Only clears ST folder mappings; images remain in their unique folders (you can manually move them later)
- **Cancel** — Abort disabling, keeping the feature enabled

> **Note:** Gallery IDs stored in character data are preserved even when disabled, so re-enabling will use the same IDs.

#### Why Experimental?

<details>
<summary>⚠️ PSA: Character Cards Are the Wild West (click to expand)</summary>

The character card ecosystem has **barely enforced standards**. Cards come from countless creators with wildly different practices:
- **Embedded media chaos** — Images and audio can be hosted on any CDN (Imgur, Catbox, Discord, personal servers), many of which go offline, change URLs, or return incorrect data
- **CDNs lie about content types** — Some servers return wrong `Content-Type` headers (e.g., serving an MP3 file as `image/jpeg`), which can cause files to be saved with wrong extensions
- **Inconsistent card structure** — Some creators use standard fields, others embed everything in description, some mix HTML/Markdown/plaintext randomly
- **Media URL formats vary wildly** — Direct links, redirects, query parameters, URL-encoded paths, base64 embeds... you name it
- **No versioning or update tracking** — The same character can exist in dozens of variations with no way to tell which is "canonical"
- **Creator practices are unpredictable** — Some carefully curate their cards, others upload and abandon them

This feature has worked well for me on a **1000+ card library**, but with so many variables in the ecosystem, edge cases are inevitable. The migration tools do their best to intelligently sort images using content hashing and ownership fingerprinting, but weird things can happen when you're dealing with cards from hundreds of different creators, each doing things their own way.

**If you value your gallery images and you want to try out this feature I urge you to do a complete backup of your ST user folder.**

</details>

**Technical reasons it's experimental:**
- **Changes ST's default behavior** — Overrides how SillyTavern resolves gallery folders
- **Not extensively tested** — May have edge cases with certain setups or workflows
- **Modifies character data** — Adds `gallery_id` to character extensions
- **Migration complexity** — Relocating images for large libraries with many same-name characters can be messy

---

### ✅ Gallery Integrity & Sync

When **Unique Gallery Folders** is enabled, each character's gallery depends on a `gallery_id` stored in the card and a matching folder override registered with SillyTavern. If either gets out of sync — for example, when importing a card directly through SillyTavern instead of Character Library, or after a backup restore — images can end up in the wrong folder or become invisible. Gallery Integrity & Sync catches these issues:

- **Status indicator** shows audit results and warnings at a glance in the Gallery tab
- **Integrity checks** detects missing `gallery_id`s, orphaned folder mappings, and unregistered overrides
- **Cleanup tools** assign or remove orphaned mappings safely with guided actions
- **ST import warning + 1-click fix** when a card is added directly in SillyTavern (bypassing Character Library), a warning banner appears with a one-click repair to assign the missing `gallery_id` and register the folder override
---

## 🌐 ChubAI Integration

### Without Authentication
- Browse and download public characters
- Full search and filtering  
- Character preview with metadata
- One-click import to your library
- See which characters you already own
- **Hide Owned** filter to show only characters not in your library

### With URQL Token (Optional)
Unlock additional features:
- **Timeline view** — New releases from followed authors
- **Favorites filtering** — Show only your saved favorites
- **Toggle favorites** — Add/remove characters from your ChubAI favorites
- **Follow/Unfollow authors** — Track creators you like
- **Restricted content** — Access private listings

### 🔗 Character Linking
Link your local characters to their ChubAI counterparts:
- **Manual linking** — Search and link via the ChubAI indicator in character details
- **Bulk link scanner** — Automatically scan your library and match unlinked characters
- **Auto-link on import** — Characters downloaded from ChubAI are automatically linked
- **Gallery downloads** — Download gallery images from linked characters
- **View on ChubAI** — Jump to the linked character's ChubAI page
- **Filter by link status** — Use `chub:yes` or `chub:no` in search

#### Getting Your Token:
1. Log into [chub.ai](https://chub.ai)
2. Open DevTools (F12) → **Application** tab → **Local Storage** → `https://chub.ai`
3. Copy the `URQL_TOKEN` value
4. Paste in Character Library Settings (⚙️ in ChubAI view)

### Batch Import
- Paste multiple ChubAI URLs (one per line)
- Progress tracking and error logging
- Pre-import duplicate detection
- **Auto-download options** — Optionally download gallery and embedded media during import
- Gallery notification when imported characters have additional images

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Page Up/Down` | Scroll through character grid |
| `Home/End` | Jump to top/bottom |
| `Escape` | Close modals, overlays, exit multi-select mode |
| `Space` | Toggle multi-select mode |
| `Enter` | Add tag (when tag input is focused) |
| `Arrow Down` | Focus first tag suggestion (when tag input is focused) |
| `← / →` | Navigate images in gallery viewer |

---

## 💡 Tips & Tricks

- **Quick creator filter** - Type `creator:AuthorName` in search
- **Filter by ChubAI link** - Type `chub:yes` or `chub:no` to filter linked/unlinked characters
- **Batch import** - Paste multiple ChubAI URLs or local PNG files in the import dialog
- **Gallery tab** - See all character images and audio in one place
- **Bulk link scanner** - Use ⋮ menu → "Bulk Link to ChubAI" to auto-match your library
- **Duplicate cleanup** - Use Find Duplicates to clean up your library
- **Multi-select** - Press Space on the character grid to enter multi-select mode for batch tagging, deletion, or export
- **Right-click context menu** - Right-click any character card for quick actions
- **Version safety net** - Edits and card updates auto-snapshot before applying, so you can always undo

---

## ❓ Troubleshooting

### Media downloads fail with CORS errors

Some image hosts (Imgur, Catbox, etc.) block direct browser requests due to CORS restrictions. Character Library automatically falls back to SillyTavern's built-in CORS proxy, but it must be enabled:

1. Open **SillyTavern** (main page, not Character Library)
2. Go to **User Settings** (top-left user icon)
3. Scroll to the **Network** section
4. Enable **"CORS Proxy"**
5. Retry the download in Character Library

This affects embedded media downloads, ChubAI gallery downloads, and bulk localization. If the proxy is disabled, you'll see "CORS blocked and proxy is disabled" in the browser console.

### Character fields are empty or settings don't save

If character details (Description, First Message, Personality, etc.) show up blank — but Creator Notes and name still work — or if settings like Unique Gallery Folders don't persist after reload, this has been reported to be caused by **lazy loading** in SillyTavern's config.

Open `config.yaml` in your SillyTavern root folder and make sure lazy loading is **disabled**:

```yaml
performance:
  lazyLoadCharacters: false
```

Restart SillyTavern after changing this. Lazy loading prevents Character Library from reading the full character data through the API, which causes incomplete fields and broken saves.

---

## 🚧 TODO