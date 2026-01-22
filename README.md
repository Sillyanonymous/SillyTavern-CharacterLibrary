# SillyTavern Character Library

A powerful SillyTavern extension for discovering, organizing, and managing your character library with a modern glassmorphic interface.

> **Note:** This is a hobby project but things mostly work. Expect bugs, use at your own risk.

## Screenshots

![Main Gallery View](docs/images/Main.jpg)
*Browse your character library with search, filtering, and sorting*

![Character Details](docs/images/Details.jpg)
*View and edit character details, chats, media, and related characters*

![ChubAI Integration](docs/images/ChubAI.jpg)
*Browse and download characters directly from ChubAI*

## Installation

1. Clone to your SillyTavern extensions folder:
   ```
   SillyTavern/data/default-user/extensions/SillyTavern-CharacterLibrary
   ```
2. Restart SillyTavern
3. Click the film icon in the top bar, next to SillyTavern's native "Character Management" button (WIP)

## Core Features

### Character Discovery & Organization

Browse your library in a **beautiful grid view** with progressive lazy-loading. **Search** across name, tags, author, and creator's notes. **Filter by tags** with include/exclude logic. **Sort** by name, date added, or custom order. Your preferences automatically save.

### Character Details & Editing

Click any character for a **tabbed interface**:
- **Details tab** - Rich markdown, HTML, and CSS rendering with embedded images, creator's notes in a secure sandboxed iframe (Experimental and optional: some card creators can't into proper formatting, there's only so much I can do), alternate greetings, and embedded lorebooks
- **Edit tab** - Full character card editor with change tracking and visual diff preview
- **Media tab** - All associated images (PNG/JPG/WebP/GIF) and audio (MP3/WAV/OGG/M4A) with built-in player
- **Chats tab** - All conversations with message counts; resume any chat directly
- **Related tab** - Smart recommendations based on shared tags, creator, or content keywords
- **Edit Lock** - Prevents accidents


### Chat History Browser

View and search through your entire conversation history. 
- **Sort by** date, character, message count, or frequency.
- **Group by character** or view flat. See message previews before opening. Jump into any chat without returning to SillyTavern.

### Smart Duplicate Detection

Scan for duplicate characters using:
- **Name similarity** and **creator matching**
- **Jaccard similarity** for content fields. Shows match confidence and reasoning
- **Find duplicate media** using file hashing
- **Delete duplicates** directly from the library
- **Warns of potential duplicate** when importing new cards, prints side by side diff

### Media Management

- **Manage your character's SillyTavern gallery** - View all associated images and audio in one place with built-in players
- **Batch download embedded media** - Automatically extract and download all images and audio files embedded in creator's notes and greetings
- **Audio support** - Yes, audio! Supports MP3, WAV, OGG, and M4A files embedded in character cards
- **Detect duplicate media** using file hashing to avoid redundancy

### Related Character Discovery

Automatically finds similar characters via:
- **Shared tags** with **tag rarity weighting** (rare tags are more significant)
- **Same creator**
- **Content keywords** (shared universes, franchises, themes)

Shows relationship strength and match reasoning for each suggestion.

### ChubAI Integration

- **Browse and download** characters from ChubAI without leaving the app.
- **Search** the full catalog with text filtering.
- **Discovery presets** for trending, top-rated, newest, random. 
- **Filter by features** (gallery, lorebook, expressions, alt greetings, verified). Marks which ChubAI characters you already downloaded.
- **Batch import** multiple characters via URL list with progress tracking and error logging.
- **Pre-import duplicate detection** warns if you're already downloading the same character.
- **ChubAI gallery notifications** alert when imported characters have additional gallery images available.

**Optional authentication** with your ChubAI URQL token unlocks:
- **Timeline view** - New releases from authors you follow
- **Favorites filtering** - See only your saved favorites
- **Restricted content** - Access private character listings

Your token is stored locally and only used for ChubAI API requests.

### Media Management

- **Organize media** - View all associated images and audio in one place with separate galleries and built-in audio player.
- **Find and download remote media** - embedded in character descriptions (markdown links, HTML img tags, or media URLs) to speed up character loading.
- **Detect duplicate media** using file hashing to avoid redundancy.

### Advanced Features

- **Change tracking** - Visual diff before saving edits
- **Tag filtering** - Use the tri-state logic (include/exclude/neutral) for powerful tag combinations
- And honestly much more I'm probably forgetting as I suck at readmes

## Tips & Tricks

- **Quick creator filter** - Type `creator:Name` in search to see all characters by that creator
- **Batch import** - Paste multiple ChubAI URLs (one per line) into the import dialog
- **Media organization** - Click Media tab to see all associated images and audio
- **Duplicate cleanup** - Use Find Duplicates to identify and remove redundant characters


## Keyboard Navigation

- **Page Up/Down** - Scroll through character grid
- **Home/End** - Jump to top/bottom of grid
- **Escape** - Close modals

## ChubAI Features & Token Setup

### Using ChubAI Without a Token

Browse and download public characters from ChubAI without authentication:
- Full character search and filtering
- Character preview with descriptions and metadata
- Direct one-click import to your library
- See which characters you already own
- View gallery images available on ChubAI

### Optional: Add Your URQL Token for Advanced Features

**Getting Your Token:**
1. Log into [chub.ai](https://chub.ai) in your browser
2. Open browser DevTools (F12)
3. Go to the **Application** tab (Storage in Firefox)
4. In the left sidebar, expand **Local Storage** → `https://chub.ai`
5. Find the key `URQL_TOKEN` and copy its value
6. In the Character Library, click ⚙️ (Settings) in the ChubAI view
7. Paste your token and save

**What the token enables:**
- **Timeline view** - New characters from authors you follow
- **My Favorites** - Filter to show only your saved favorites
- **Restricted content** - Access characters with restricted visibility

## TODO

- Better icon placement in SillyTavern's topbar (lol)
- Performance improvements, including avatar thumbnail caching for very large libraries
