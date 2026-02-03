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
2. Restart SillyTavern
3. Click the film icon in the top bar, next to SillyTavern's native "Character Management" button



## ✨ Core Features

### 📚 Character Discovery & Organization

- **Beautiful grid view** with progressive lazy-loading
- **Powerful search** across name, tags, author, and creator's notes
- **Tag filtering** with include/exclude/neutral tri-state logic  
- **Sort** by name, date added, recent chats, or chat frequency
- **Preferences auto-save** between sessions

### 🎨 Character Details & Editing

Click any character for a **rich tabbed interface**:

| Tab | Description |
|-----|-------------|
| **Details** | Rich markdown/HTML/CSS rendering, embedded images, creator notes in secure sandboxed iframe, alternate greetings, embedded lorebooks |
| **Edit** | Full character card editor with change tracking and visual diff preview |
| **Media** | All images (PNG/JPG/WebP/GIF) and audio (MP3/WAV/OGG/M4A) with built-in players |
| **Chats** | All conversations with message counts; resume any chat directly |
| **Related** | Smart recommendations based on shared tags, creator, or content keywords |

**Edit Lock** prevents accidental changes.

### 💬 Chat History Browser

- **Browse all conversations** across all characters
- **Sort by** date, character, message count, or frequency
- **Group by character** or view flat list
- **Message previews** before opening
- **Jump into any chat** without returning to SillyTavern

### 🔍 Smart Duplicate Detection

- **Name similarity** and **creator matching**
- **Jaccard similarity** for content comparison
- **Duplicate media detection** via file hashing
- **Match confidence & reasoning** for each result
- **Delete duplicates** directly from the interface
- **Pre-import warnings** when downloading potential duplicates

### 🖼️ Media Management

- **Unified gallery** for all character images and audio
- **Batch download** embedded media from creator notes and greetings
- **Audio support**  MP3, WAV, OGG, M4A with built-in player
- **Duplicate detection** via file hashing

### 🎴 On-the-Fly Media Localization

Many character cards embed images from external hosts (Imgur, ImageShack, Catbox, etc.) which can be slow or unreliable. Media Localization solves this:

1. Download embedded media via the **Media tab** → **"Download Embedded Media"**
2. Enable **"Media Localization"** in Settings (globally or per-character)
3. Remote URLs are automatically replaced with local files in:
   - Character Library detail views (creator notes, greetings, descriptions)
   - **SillyTavern chat messages** — live in your conversations!

**Your original character cards stay untouched** — replacement happens dynamically at display time. Fast, private, and offline-friendly!

### 🔗 Related Character Discovery

Automatically finds similar characters via:
- **Shared tags** with rarity weighting (rare tags = stronger signal)
- **Same creator**
- **Content keywords** (shared universes, franchises, themes)

Shows relationship strength and reasoning for each suggestion.

### 🗂️ Unique Gallery Folders (Experimental)

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

> ⚠️ **PSA: Character Cards Are the Wild West**
>
> Rant: The character card ecosystem has **barely enforced standards**. Cards come from countless creators with wildly different practices:
> - **Embedded media chaos** — Images and audio can be hosted on any CDN (Imgur, Catbox, Discord, personal servers), many of which go offline, change URLs, or return incorrect data
> - **CDNs lie about content types** — Some servers return wrong `Content-Type` headers (e.g., serving an MP3 file as `image/jpeg`), which can cause files to be saved with wrong extensions
> - **Inconsistent card structure** — Some creators use standard fields, others embed everything in description, some mix HTML/Markdown/plaintext randomly
> - **Media URL formats vary wildly** — Direct links, redirects, query parameters, URL-encoded paths, base64 embeds... you name it
> - **No versioning or update tracking** — The same character can exist in dozens of variations with no way to tell which is "canonical"
> - **Creator practices are unpredictable** — Some carefully curate their cards, others upload and abandon them
>
> This feature has worked well for me on a **1000+ card library**, but with so many variables in the ecosystem, edge cases are inevitable. The migration tools do their best to intelligently sort images using content hashing and ownership fingerprinting, but weird things can happen when you're dealing with cards from hundreds of different creators, each doing things their own way.

>**If you value your gallery images and you want to try out this feature I urge you to do a complete backup of your ST user folder.**

**Technical reasons it's experimental:**
- **Changes ST's default behavior** — Overrides how SillyTavern resolves gallery folders
- **Not extensively tested** — May have edge cases with certain setups or workflows
- **Modifies character data** — Adds `gallery_id` to character extensions
- **Migration complexity** — Relocating images for large libraries with many same-name characters can be messy


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
- **Restricted content** — Access private listings

### 🔗 Character Linking (New!)
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
| `Escape` | Close modals |

---

## 💡 Tips & Tricks

- **Quick creator filter** - Type `creator:AuthorName` in search
- **Filter by ChubAI link** - Type `chub:yes` or `chub:no` to filter linked/unlinked characters
- **Batch import** - Paste multiple ChubAI URLs in the import dialog
- **Media tab** - See all character images and audio in one place
- **Bulk link scanner** - Use ⋮ menu → "Bulk Link to ChubAI" to auto-match your library
- **Duplicate cleanup** - Use Find Duplicates to clean up your library

---

## 🚧 TODO

- Better icon placement in SillyTavern's topbar
- Performance improvements for very large libraries
- Thumbnail caching
- Mobile mode (still in planning/consideration phase)