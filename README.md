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