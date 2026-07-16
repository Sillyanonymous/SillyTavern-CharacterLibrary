// AI CSS Assistant: chat interface for generating snippets via LLM.

import CoreAPI from './core-api.js';
import { createSnippet, updateSnippet, loadSnippets, renderSidebar as renderCustomCssSidebar, setSnippetsDirty, loadSnippetIntoEditor, getActiveSnippetId } from './custom-css.js';

// ========================================
// CSS CATALOGUE
// ========================================
// Hand-written, kept in sync with library.css. Add new @canonical components or themable tokens here.

const CATALOGUE_TOKENS = `
COLOR TOKENS (override on :root to retheme the whole app):
  --bg-primary           Main page background (#121212).
  --bg-secondary         Card-level surfaces: sidebars, settings panels, code blocks (#1e1e1e).
  --text-primary         Default text color (#e0e0e0).
  --text-secondary       Subdued text: hints, metadata (#a0a0a0).
  --text-faint           De-emphasised markers between secondary and muted (#888).
  --text-muted           Faintest text: timestamps, placeholders (#707070).
  --accent               Primary brand color: links, buttons, focus rings (#4a9eff).
  --accent-rgb           Comma-separated RGB of --accent, for use in rgba() alpha tints (74, 158, 255).
  --accent-hover         Accent on hover (#6ab0ff).
  --accent-glow          Computed from --accent-rgb at 30% alpha. Overriding --accent-rgb updates this automatically.
  --accent-secondary     Secondary brand color, for gradients (#5550f0).
  --accent-secondary-rgb Comma-separated RGB of --accent-secondary (85, 80, 240).
  --accent-text          Text color shown on top of an accent background (#ffffff).
  --glass-bg             Translucent surface for "glass" panels (rgba(30, 30, 30, 0.6)).
  --glass-border         Border for glass surfaces (rgba(255, 255, 255, 0.1)).
  --card-bg              Background for character grid cards (rgba(40, 40, 40, 0.4)).
  --cl-favorite-gold     Gold accent for favorite indicators and the favorite-button hover treatment (#ffd700). Has a matching --cl-favorite-gold-rgb (255, 215, 0) for rgba() tints.
  --cl-in-library        Cyan "in your library" badge on Online browse cards (#00bcd4, companion --cl-in-library-rgb 0, 188, 212). Semantic category color, deliberately outside the status tiers so an accent retheme keeps its meaning.
  --cl-possible-match    Amber "possible match in library" badge on Online browse cards (#f0a500, companion --cl-possible-match-rgb 240, 165, 0). The icon alpha grades by confidence tier over this token (.possible-library.pl-high 1.0 / base .pl-med 0.72 / .pl-low 0.5). NOTE the dark badge background is a HARDCODED rgba(0,0,0,0.7) shared by all .browse-feature-badge and does NOT follow this token; only the glyph color does.

--cl-* MODULE-DIALOG TOKEN FAMILY (surface + text only; the accent is unified into the core --accent chain, there is no separate --cl-accent anymore):
  --cl-border            General-purpose border token for module dialogs. Used for internal dividers, panel outlines, dashed borders across batch-tagging, card-updates, character-versions, context-menu, playlists. NOT used by .cl-btn: the base button is borderless, and the DEFAULT glass button style adds its own hardcoded 1px rgba(255,255,255,0.08) border that follows neither this token nor the accent (target :root[data-btn-style="glass"] .cl-btn to restyle it).
  --cl-text-primary      Default value resolves to #e0e0e0. (The declaration references SmartTheme but CL runs in its own browser tab where those vars are never defined, so the fallback always wins.)
  --cl-text-secondary    Default value resolves to #a0a0a0. Same situation.
  Global accent retheme: override --accent / --accent-rgb only. Module dialogs (.cl-btn, card-updates, playlists, character-versions, context-menu, batch-tagging) read the core --accent / --accent-rgb / --accent-hover directly now, so they follow automatically. --accent-rgb also drives --accent-glow. There is no separate --cl-accent chain to override anymore.
  CAVEAT: --text-primary and --cl-text-primary are INDEPENDENT vars. Overriding --text-primary does NOT change text inside module dialogs. To re-color module-dialog text, override --cl-text-primary directly.

MODAL BACKGROUND VARS:
  --modal-bg             Used by .modal-glass (character detail, creator, chat preview).
  --cl-glass-bg          Used by .cl-modal-content shell on DESKTOP (translucent + backdrop blur) AND by inner surfaces inside module dialogs (batch-tagging header/footer, playlist manage panels, custom-css editor panels, card-updates progress strip, context-menu, vt-dialog, etc).
  --cl-topbar-bg         Used ONLY by the .topbar chrome strip. Default is rgba(20, 20, 20, 0.8) (darker + more see-through than --cl-glass-bg so it sits under content without competing). Override separately if you want the topbar tinted independently of modal chrome.
  --bg-secondary         Used by .cl-modal-content on MOBILE (overrides --cl-glass-bg via library-mobile.css; full-viewport bottom-sheets need solid bg or scrim-bleed reads as funhouse). Also used by .confirm-modal-content shells on both platforms.
  For a complete dark-mode reskin, override all three together. They look similar by default but read from independent vars.

RESTORE SIMPLE / FLAT CHROME (anti-funhouse, "make modals opaque" / "kill the blur" / "flat modals" / "old chrome" / "performance" requests):
  The desktop .cl-modal-content default is the full feature chrome: translucent var(--cl-glass-bg), 20px backdrop blur, inner-light tint border (rgba 255/255/255 0.08), triple-stack shadow, accent-gradient header, h3 weight 700. To revert to flatter pre-feature chrome (solid bg, no GPU blur, flat header, lighter title), apply this whole block globally:

    .cl-modal-content {
        background: var(--bg-secondary);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        border: 1px solid var(--glass-border);
        box-shadow: var(--cl-shadow-lg);
    }
    .cl-modal-header {
        background: transparent;
    }
    .cl-modal-header h3 {
        font-weight: 600;
    }

  Or scoped to one or more modal IDs (mirror the same blocks under #specificModalId .cl-modal-content / .cl-modal-header / .cl-modal-header h3). Don't bias toward a preset of "heavy" modals - apply globally OR to exactly the IDs the user names.

  What each rule undoes:
    background + backdrop-filter:  kills translucent glass + the 20px GPU blur (this is also the perf win - drops the compositor layer cost on desktop)
    border:                         swaps the hardcoded rgba(255,255,255,0.08) inner-light tint for the canonical --glass-border token (10% white)
    box-shadow:                     swaps triple-stack (drop + outer stroke + inner top highlight) for the canonical modal-size single drop (--cl-shadow-lg)
    .cl-modal-header background:    kills the accent gradient strip
    h3 font-weight 600:             lighter title, matches the pre-feature look

  Do NOT also touch: .cl-modal-content overflow: hidden (clips header to corners), border-radius (visual continuity with the rest of the system), .cl-modal-header padding (back-arrow zone reservation on mobile).

  Modal IDs the user is most likely to ask about by feature name:
    "Custom CSS" / "CSS editor"           -> #customCssModal
    "Recommender" / "AI recommender"      -> #recommenderModal
    "Ask about character" / "card chat" / "recommender chat" -> #recommenderCharChatModal (settings panel .recommender-chat-settings; message cards .recommender-chat-msg.user / .assistant; user cards + gear-active follow the accent, neutral surfaces are theme-neutral by design)
    "CSS assistant" / "AI CSS assistant"  -> #cssAssistantModal
    "Add to playlist" / "playlist picker" -> #playlistPickerModal
    "Manage playlists"                    -> #playlistManageModal
    "Batch tagging" / "tag editor"        -> #batchTagModal
    "Card updates" / "update checker"     -> #cardUpdateSingleModal, #cardUpdateBatchModal
    "Settings"                            -> #gallerySettingsModal
    "Help" / "Help & Tips"                -> #galleryInfoModal

  When user wants only the blur amount tuned (not full revert): .cl-modal-content { backdrop-filter: blur(<n>px); -webkit-backdrop-filter: blur(<n>px); } - 12px subtle, 20px default, 40px heavy frost. When user wants only the blur off (keep translucent + gradient header): drop just backdrop-filter / -webkit-backdrop-filter, leave the rest.

GRADIENT-CLIPPED TITLE ICON (default):
  The leading icon in a modal header (.cl-modal-header h3 > i:first-child) is accent-gradient clipped by DEFAULT (accent -> accent-secondary). The legacy .cl-modal-header-icon class is an alias for the same effect on an icon that is not the leading child.

  When the user asks to RECOLOR the title icon ("different gradient", "make it match X"): override the gradient stops. The icon is shipped markup, so scope via the modal ID (Custom CSS can't edit markup). Example:
        #recommenderModal .cl-modal-header h3 > i:first-child {
            background: linear-gradient(135deg, <color-a>, <color-b>);
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
        }

  When the user wants the title icon FLAT (no gradient): reset the fill.
        #recommenderModal .cl-modal-header h3 > i:first-child {
            background: none;
            -webkit-text-fill-color: currentColor;
        }

  When NOT to use:
    - User asks for app-wide accent changes (override --accent / --accent-secondary tokens instead; the gradient follows them automatically).
    - User asks for chrome / shadow / shape changes (those are the default cl-modal look; no opt-in needed).

MODAL SCRIM (the dimming overlay BEHIND a modal; separate from the modal's own background):
  --cl-modal-scrim-light  Full rgba; default rgba(0, 0, 0, 0.6). Nested overlays that open on top of an already-open surface: the showConfirm dialog overlay (.cl-confirm-overlay), version-history dialogs (.vt-dialog-overlay), the mobile tag-editor backdrop.
  --cl-modal-scrim        Full rgba; default rgba(0, 0, 0, 0.7). Standard module dialogs (.cl-modal: settings, batch tagging, playlists, card updates, theme customizer).
  --cl-modal-scrim-heavy  Full rgba; default rgba(0, 0, 0, 0.8). Full-screen primary modals (.modal-overlay: character detail, character creator) and destructive confirms (.confirm-modal).
  These are FULL rgba values, not alpha-only knobs. Tinting the scrim is supported (e.g. rgba(20, 0, 40, 0.7) for a purple-tinted dimming on a synthwave theme). Three tiers map to gesture, not aesthetic preference: pick by what the modal is asking the user to do.
  NOT on the token system: the gallery viewer (.gv-modal) HARDCODES its scrim at rgba(0, 0, 0, 0.95) and the full-screen image/avatar viewer (.browse-avatar-viewer) at rgba(0, 0, 0, 0.88); overriding the scrim tokens does nothing there, retinting those two needs their class targeted directly.

STATUS COLORS (semantic, three tiers; override on :root to retheme toasts/badges/banners):
  Muted Material tier: --cl-success (#4caf50), --cl-error (#f44336), --cl-warning (#ff9800), --cl-info (#29b6f6).
  Punchy Flat UI tier: --cl-success-bright (#2ecc71), --cl-error-bright (#e74c3c), --cl-warning-bright (#f39c12), --cl-info-bright (#3498db).
  Pale Material 300 tier: --cl-success-pale (#81c784), --cl-error-pale (#e57373), --cl-warning-pale (#ffd54f), --cl-info-pale (#64b5f6). Designed for legible text on translucent status backgrounds (tag pill labels, callout body text).
  Each muted/bright token has a matching *-rgb companion (e.g. --cl-success-rgb) for rgba() tints. In practice: muted tier powers toast chrome/icons and most status pills/badges; bright tier powers hero banners, big action buttons (danger/cancel gradients), and prominent status indicators; pale tier powers text on top of translucent status backgrounds.
  Gradient second stops: the danger/cancel and warning button gradients run from the -bright token to a darker companion, --cl-error-bright-darker (#c0392b) and --cl-warning-bright-darker (#e67e22), each with a *-rgb form. Retheming --cl-error-bright or --cl-warning-bright WITHOUT also overriding its -darker companion leaves the gradient's far stop on the stock color (half-rethemed buttons).
  --cl-danger-text (#ff6b7a): danger ACTION text on dark/translucent chrome, .cl-btn-danger text (both button styles), context-menu Delete rows (desktop + mobile sheet), playlist delete hover. Deliberately OUTSIDE the error tiers: retheming --cl-error-* does not move it, override --cl-danger-text directly.
  KNOWN COUPLING GAPS:
    1. .toast.info uses --accent (not --cl-info). Re-color info toasts by overriding --accent or by targeting .toast.info directly.
  INTENTIONAL DECOUPLING (do NOT route through the status tier):
    .cl-tag-success / -warning / -info / -danger are tag UI affordances (visually category-coloured pills like "NSFW", "Beta", "Featured"), NOT status semantic surfaces. They use the *-pale tokens for text but hardcoded rgba triples for chrome on purpose, so that re-theming the status tier (e.g. --cl-warning: cyan to retint warning toasts) does NOT also recolor unrelated "Warning"-named tag pills across the app. To re-theme cl-tag-* pill chrome, target the classes directly.

SHADOW SCALE (tokens exist but the codebase rarely uses them; emit directly when you need consistent depth):
  --cl-shadow-sm, --cl-shadow-md, --cl-shadow-lg, --cl-shadow-xl. Sm shallowest, xl deepest.

SPACING SCALE (px values):
  --space-2xs (2px), --space-xs (4px), --space-xs-sm (6px), --space-sm (8px),
  --space-sm-md (10px), --space-md (12px), --space-lg (16px), --space-xl (20px), --space-2xl (24px).
  Use for padding/gap/margin instead of raw px.

BORDER RADIUS SCALE:
  --radius-2xs (2px), --radius-xs (3px), --radius-sm (4px), --radius-sm-alt (5px),
  --radius-md (6px), --radius-lg (8px), --radius-xl (10px), --radius-2xl (12px),
  --radius-2xl-alt (14px), --radius-3xl (16px), --radius-4xl (20px),
  --radius-circle (50%), --radius-pill (999px).
  Picks: --radius-sm for chips/tags, --radius-md for buttons/inputs, --radius-lg for panels/cards, --radius-2xl for major surfaces, --radius-pill for fully round.

TYPOGRAPHY SCALE (rem values; full set):
  --font-4xs (0.55rem), --font-3xs (0.65rem), --font-2xs (0.7rem), --font-xs (0.75rem),
  --font-sm (0.8rem), --font-md (0.85rem), --font-md-lg (0.9rem), --font-pre-base (0.95rem),
  --font-base (1rem), --font-lg (1.15rem), --font-xl (1.3rem), --font-2xl (1.5rem), --font-3xl (2rem), --font-4xl (3rem).
  Picks: --font-xs for tags/captions, --font-sm for hints/metadata, --font-md for body, --font-base for inputs/emphasis, --font-lg for headings, --font-4xl for empty-state ghost icons.

BUTTON SIZING:
  --btn-pad-v-xl/lg/md/sm, --btn-pad-h-xl/lg/md/sm, --btn-font-xl/lg/md/sm.
  Default cl-btn/action-btn is the md tier. (Note: --btn-font-md and --btn-font-sm currently share the same 0.85rem value.)

TOUCH + MOBILE CHROME:
  --touch-target-min (44px)   WCAG/iOS/Android floor. Use for min-height/min-width on any interactive element on mobile.
  --chrome-h-mobile (56px)    Mobile modal header height + bottom nav height. Apply as min-height on cl-modal-header / confirm-modal-header / mobile-bottom-nav-tab on mobile.
  --back-arrow-zone (56px)    Header padding-left reserved for the absolutely-positioned mobile back-arrow.
  --safe-bottom               env(safe-area-inset-bottom, 0px) alias. Use in padding-bottom + calc() expressions on bottom-stuck mobile elements (sticky footers, bottom sheets, FABs).
  --ease-drawer               cubic-bezier(0.32, 0.72, 0, 1). The canonical bottom-sheet/drawer slide easing, shared by every mobile sheet/drawer (settings/menu/selector/context, cl-modal-drawer pickers, filter popups). Use as the timing-function in transition/animation on any bottom drawer so its motion matches; pair with an explicit duration (0.28s opens, 0.22s quick-dismiss). Retarget it to restyle all drawer motion at once.
`.trim();

const CATALOGUE_COMPONENTS = `
COMPONENT SELECTORS (verified against source; class names are exact):

Layout / Chrome (defined in library.css; no !important needed):
  .topbar                Sticky top bar with logo, search, sort, view toggles.
  .view-toggle           Topbar Characters/Chats segmented switcher.
  .view-toggle-btn       One button inside .view-toggle.
  .character-grid        Character grid wrapper (also has id="characterGrid").
  .char-card             One character tile in the main grid.
  .char-card.is-favorite Modifier for favorited cards. (Not ".favorite"; must be ".is-favorite".)
  .card-overlay          Bottom overlay strip on a card holding name + tags. Nested under .char-card.
  .card-name             Character name overlay on a card. Nested as .char-card > .card-overlay > .card-name.
  .card-tag              Tag pill rendered on grid cards. Inside .card-tags container.
  .card-tags             Container for tags on a card.
  .favorite-indicator    Star/heart icon shown on .char-card.is-favorite.
  .modal-glass           Full-viewport detail panel (character detail, character creator, chat preview). NOT gallery viewer (that's .gv-modal).
  .modal-sidebar         Right-side info pane inside the character detail modal. Hidden on mobile (display:none), so styling it under html.cl-mobile is a no-op.
  .tab-nav               The character detail modal's tab bar (container of the .tab-btn buttons). Desktop background is rgba(0,0,0,0.2); on mobile it is sticky with a hardcoded dark background (#141414). To retheme the mobile bar, target "html.cl-mobile #charModal .tab-nav" with !important.
  .tab-btn               The detail modal's tab buttons (Details/Edit/Chats/Gallery/Related/...). Already follow var(--accent) (active text + bottom border, plus rgba(var(--accent-rgb),0.05) active background) and var(--text-secondary), so they retheme automatically; no per-button rules needed for a token retheme.
  .tab-pane              Tab content panes inside the character detail modal. Use .tab-pane.active for the visible one.
  .char-modal-nav        Prev/Next chevron buttons on the sides of the character detail modal (desktop only; mobile uses swipe). Mirrors the gallery viewer's .gv-nav: a plain dark capsule (rgba(0,0,0,0.5)) with a white chevron, flush to the modal edge and half-rounded toward center, background lightens on hover. Not accent-coupled. Variants: .char-modal-nav-prev, .char-modal-nav-next. Icon glyph is a ::before pseudo using Font Awesome 6 Free. Component-scoped vars for per-component theming (override on .char-modal-nav itself): --cmn-bg (rgba(0,0,0,0.5)), --cmn-bg-hover (rgba(255,255,255,0.1)), --cmn-border (1px solid rgba(255,255,255,0.1)), --cmn-color (#fff), --cmn-width (50px), --cmn-height (80px), --cmn-icon-size (var(--font-2xl)), --cmn-icon-prev ('\\f053' = fa-chevron-left, override with any FA6 unicode), --cmn-icon-next ('\\f054' = fa-chevron-right), --cmn-disabled-opacity (0.3). Hidden on mobile via library-mobile.css; gated on the enableCharDetailNav setting.
  .toast / .toast-container  Toast notifications. Variants: .toast.success, .toast.error, .toast.warning, .toast.info.
  .toast-icon            Icon inside a toast.
  .close-btn             Generic X-close button on modals.
  .cl-modal-close        X-close button inside .cl-modal-content modals.
  .tag-filter-item       Pills used in the tag filter dropdown (search/filter UI).

Browse view (defined in modules/providers/browse-shared.css; NEEDS !important for theme overrides):
  .browse-card           Character card in provider browse view (Chub, JanitorAI, etc).
  .browse-tag            Tag pill inside browse cards.
  .browse-search-bar     Search input row in the browse view header.

Settings UI (defined in library.css):
  .settings-nav / .settings-nav-item / .settings-nav-item.active   Settings modal left rail.
  .settings-panel / .settings-panel.active                        Right content panel.
  .settings-group / .settings-group-title                         Grouped settings card with title.
  .settings-row                                                   One labelled control row inside a group.
  .settings-action-btn                                            Inline action button (Open Editor, Migrate, etc). Variants: .primary, .danger.
  .settings-hint                                                  Subdued help text under a control.

Multi-select mode (defined in modules/multi-select.css; NEEDS !important). Bespoke toolbar treatment that doesn't reuse .glass-btn / .action-btn so it can carry its own personality; flag the coupling gaps below when retheming:
  body.multi-select-mode .char-card           Body flag set when multi-select is active; gives every card a pointer cursor + reveals the per-card checkbox.
  .char-card-checkbox                         24x24 checkbox overlay top-left on every card (display:none normally, display:flex inside body.multi-select-mode). Selected paint: ".char-card.selected .char-card-checkbox" (accent bg + accent border + the inner <i> fades in). Hover preview: ".char-card:hover .char-card-checkbox" tints border to accent.
  .multi-select-toolbar                       Persistent action bar inserted before .gallery-content when mode is on. Bg is a HARDCODED dark blue/purple gradient (rgba(26,26,46,0.95) -> rgba(30,30,50,0.95)) NOT bound to the accent token, so a global accent retheme leaves the bar visually disconnected; retarget .multi-select-toolbar background explicitly to follow accent. Border-bottom DOES use var(--accent-rgb) and follows the accent automatically.
  .multi-select-toolbar.hidden                Hidden state (display:none).
  .multi-select-badge                         Count chip on the left ("3"). Accent gradient via --accent + --accent-secondary; themes automatically.
  .multi-select-label                         "characters selected" text next to the badge. Hidden in mobile mode (html.cl-mobile).
  .multi-select-left / .multi-select-actions / .multi-select-right    Three flex sections of the toolbar.
  .ms-divider                                 Vertical 1px divider between button groups inside .multi-select-actions. Hidden on mobile.
  .ms-btn                                     Bespoke toolbar action button (Select All, Tags, Favorite, Export, Updates, Playlist, Delete, Exit). NOT .glass-btn. Translucent white bg (rgba(255,255,255,0.08)), --SmartThemeBodyColor text, hover adds 1px lift + brighter bg. On mobile collapses to 32x32 icon-only (span hidden). Variants:
                                                 .ms-btn.ms-btn-ghost     Transparent bg. Used by the Favorite button when ALL selected are already favorited, signaling "click to unfavorite" with reduced emphasis. The button toggles between .ms-btn (favorite) and .ms-btn.ms-btn-ghost (unfavorite) via JS.
                                                 .ms-btn.ms-btn-danger    Red tint for Delete. HARDCODED #f87171 text + rgba(239,68,68,*) bg/border, NOT linked to --cl-error-bright; retarget the .ms-btn-danger rule explicitly if you want it to follow the status token family.
                                                 .ms-btn.ms-btn-exit      Slightly different bg tint (rgba(100,100,120,*)) and tighter padding for the rightmost exit-mode icon button.
  #multiSelectToggleBtn.active                Active state of the topbar's "Multi-select" toggle button (when mode is on). Accent gradient via --accent + --accent-secondary; themes automatically.

Context menu (defined in modules/context-menu.css; NEEDS !important):
  .cl-context-menu / .cl-context-menu-item   Right-click context menu and rows.

Gallery viewer (defined in modules/gallery-viewer.css; NEEDS !important):
  .gv-modal              Gallery viewer modal overlay.
  .gv-modal.visible      Visible state.

Version history (defined in modules/character-versions.css; NEEDS !important):
  .vt-dialog / .vt-dialog-overlay   Version-history dialog + its scrim (scrim rides --cl-modal-scrim-light).
  .vt-stat / .vt-badge / .vt-lb-*   Diff stats, badges, lorebook-diff rows.
  COUPLING GAP: the entire diff/status palette here is a deliberate VS Code-style carve-out, HARDCODED hexes (#89d185 added, #f48771 removed, #ffb450 modified, #bdbdbd local-only, ~20 hex + 23 rgba sites) bound to NO token. Retheming the --cl-* status tiers moves nothing in this surface; recoloring it means targeting .vt-* classes directly.

Lorebooks (defined in modules/lorebook-manager.css; NEEDS !important for theme overrides). A self-contained World-Info editor plus AI-generation suite. It reuses the canonical shells (.modal-glass, .cl-modal-content) and the token system, but carries its own cohesive entry/button chrome (the way character-creator does). Accent-active states follow var(--accent-rgb) and retheme automatically EXCEPT where flagged:
  .lb-modal-glass        The manager's full-screen panel (reuses the .modal-glass shell at largest size).
  .lb-header             The manager's top bar (title + close).
  .lb-world-row          One lorebook row in the left sidebar list. ".lb-world-row.active" tints bg/border/text via var(--accent-rgb) (themes automatically).
  .lb-meta-pill          Small neutral metadata pill (entry count, etc.). Neutral white-alpha bg; intentionally does NOT follow accent.
  .lb-entry              One collapsible World-Info entry card in the editor. ".lb-entry.expanded" adds an accent border. Neutral rgba(255,255,255,*) surface by design.
  .lb-entry-head         An entry's clickable header (switch + title + badges + actions + chevron). .lb-entry-title is the title text.
  .lb-badge              Status badge on an entry header. Variants: .lb-badge.constant (accent tier, follows accent), .lb-badge.vector (warning tier, var(--cl-warning-rgb) bg + var(--cl-warning-pale) text, follows a warning retheme), .lb-badge.selective (neutral white-alpha, intentionally does not follow accent).
  .lb-switch             The enable/include toggle (also reused by the AI review tray as the per-entry include switch). Checked state uses var(--cl-success-rgb) green; follows the SUCCESS status token, not accent.
  .lb-save-btn           Editor Save button. ".lb-save-btn.dirty" (unsaved) uses var(--cl-success-rgb) green; follows the success token, not accent.
  .lb-link-btn           Link/Bind button in the editor header. Accent-tinted (follows accent).
  .lb-icon-btn           Bespoke 34px square icon-action button (rename, duplicate, export, delete, overflow kebab). Modifiers: .small (28px), .danger (red hover via var(--cl-error-rgb)). Neutral translucent bg; this is NOT the topbar .glass-btn.
  .lb-ai-entry-btn       The accent-tinted "AI" button in the entries toolbar (.lb-add-entry-btn is the "Add Entry" button beside it).
  .lb-ai-modal-content   The "Generate with AI" modal panel (reuses .cl-modal-content chrome).
  .lb-ai-section         A numbered step card (Source / Instructions / Output) inside the AI modal. Neutral card surface.
  .lb-ai-step            The round step-number badge (1/2/3). accent -> accent-secondary gradient (themes automatically).
  .lb-ai-src-opt         A source-type tab (Paste text / Web-Wiki / From SillyTavern). ".lb-ai-src-opt.active" is an accent tint.
  .lb-stage-card         One generated-entry card in the AI review tray (reuses .lb-entry chrome). .lb-stage-keypill is the compact neutral key pill on it.
  .lb-ai-st-mode         The Characters | Chats sub-toggle in the From-SillyTavern picker (active segment = accent tint). .lb-ai-st-chip is an accent-tinted selected-character chip; .lb-ai-st-scope-opt is a per-chat All/Last/Range segment (active = accent).

Buttons (the buttonStyle setting toggles glass vs solid chrome; theming applies to both):
  .glass-btn             Topbar/filter chrome buttons. Defined as a combined selector with .glass-select.
  .action-btn            Solid modal buttons. Variants: .primary, .secondary, .danger.
  .cl-btn                Module dialog buttons. Color variants: .cl-btn-primary, .cl-btn-secondary, .cl-btn-danger. Size modifier: .cl-btn.cl-btn-sm (compounds with .cl-btn).

Inputs / Modals / Dropdowns:
  .glass-input             Text inputs and textareas across the app (topbar search, settings, character detail editor, etc.).
  .cl-input                Text inputs inside module dialogs (batch-tagging, playlists). Peer to .glass-input but scoped to .cl-modal-content surfaces; uses --cl-text-primary and --cl-border.
  .cl-confirm-overlay      The generic confirm dialog built by window.showConfirm({title, message, danger, icon}). Left intent-badge layout: .cl-confirm-main (badge + text row), .cl-confirm-badge (42px circle, accent-tinted by default; add-class .cl-confirm-danger on the overlay switches it to red via rgba(var(--cl-error-rgb)) bg + var(--cl-error-bright) icon), .cl-confirm-text (the column: an h3 title + #clConfirmMessage), and .confirm-modal-footer (Cancel + Confirm action-btns; the confirm button gets .danger when danger:true). Badge and title colors come from --accent / --cl-error / --text-primary tokens, so they auto-follow a retheme. Toggled via the .hidden class on #clConfirmOverlay.
  .confirm-modal-content   The SHARED confirm-dialog shell, used by two surfaces, so a bare ".confirm-modal-content {}" rule hits BOTH. (1) Standalone legacy dialogs that keep the full chrome: .confirm-modal-header (accent-gradient strip + title + .close-confirm-btn X) over a custom .confirm-modal-body, toggled via .hidden on the .confirm-modal parent. These are confirmSaveModal (changes diff), the gallery folder migration / mapping / orphan / disable dialogs, and the delete / bulk-delete confirms. (2) The showConfirm dialog above (.cl-confirm-overlay wraps this same shell and overrides the chrome into the badge layout). To target only one: ".cl-confirm-overlay .confirm-modal-content" for showConfirm, or the legacy ids / .confirm-modal parent for the others. (cl-modal toggles .visible; confirm-modal toggles .hidden, dual class system.)
  .cl-modal-content        Every utility + feature dialog: Settings, Help & Tips, Provider Link, Import, Import Summary, Localize, Bulk Localize / Summary / Auto-Link, Character Duplicates, Pre-Import Duplicate, Save-As Diff, AI Recommender, CSS Assistant, Custom CSS, Card Update, Playlists, Batch Tagging, Save-Preset Picker. (Character creator uses .modal-glass instead.) Shared chrome (all cl-modal-content modals look identical by default):
                             - Background: var(--cl-glass-bg) + backdrop-filter: blur(20px) on desktop; var(--bg-secondary) with no blur on mobile (full-viewport bottom-sheets).
                             - Border: 1px solid rgba(255, 255, 255, 0.08) (inner-light tint).
                             - Border-radius: var(--radius-3xl) (16px).
                             - overflow: hidden (clips the gradient header to rounded corners).
                             - Triple-stack box-shadow: outer 24px/80px drop + hairline outer stroke + inset top highlight.
                             - Header: 12px padding, accent gradient (10%/8% stops), hairline white border-bottom.
                             - Title h3: weight 700, letter-spacing -0.01em.
                           Toggled open/closed via the .visible class on the .cl-modal parent (dual class system - cl-modal uses .visible, confirm-modal uses .hidden).
  .cl-modal-drawer         OPT-IN MARKER on a .cl-modal OR .confirm-modal element. Marks the modal as a tap-away bottom-sheet drawer on mobile: hides the back-arrow (.cl-modal-close / .close-btn / .close-confirm-btn) since the scrim + Android back already close it, and reduces header padding-left from --back-arrow-zone back to --space-md across all three header types (cl-modal-header, confirm-modal-header, modal-header). Add to drawer-shaped modals so the chrome doesn't carry redundant affordances. Current consumers: playlistPickerModal and savePresetPickerOverlay (both cl-modal), and the dynamic confirm-modals deleteConfirmModal / deleteDuplicateModal / legacyFolderModal / folderMappingModal / orphanedFoldersModal / disableGalleryFoldersModal / bulkDeleteConfirmModal.
  .dropdown-menu / .dropdown-item   Popover menus (sort, view, more-options).

Tag pill families (FOUR distinct classes for different contexts; pick by surface):
  .card-tag              Pills on grid cards (library.css).
  .modal-tag             Pills inside the character detail modal (library.css). Use .modal-tag.editable when in edit mode.
  .browse-tag            Pills inside browse-view cards (NEEDS !important; lives in modules/providers/browse-shared.css).
  .cl-tag                Pills inside module dialogs. Variants: .cl-tag-success, .cl-tag-warning, .cl-tag-info, .cl-tag-danger. See STATUS COLORS coupling gaps before retheming.
  .tag-filter-item       Pills in the tag filter dropdown (different from above: a filter UI control, not a content tag).

Loaders & progress (CL does NOT use native <progress> elements):
  .cl-loading            Flex column CONTAINER for the hero loader. Children:
                           .cl-loading .cl-loading-icon          Wrapper for the rotating icon (sized 48x48).
                           .cl-loading .cl-loading-icon i        The FontAwesome icon itself. Has color: var(--accent) and a drop-shadow filter derived from --accent. Recolor: ".cl-loading .cl-loading-icon i { color: <color>; filter: drop-shadow(0 0 10px ...); }".
                           .cl-loading .cl-loading-label         Main status text.
                           .cl-loading .cl-loading-substatus     Secondary status text.
                           .cl-loading .cl-loading-bar > span    Animated indeterminate progress bar inside the loader.
                         CSS border-rotation tricks (border-top-color on .cl-loading) do NOT produce a spinner: the rotation is on the FontAwesome icon, not the container.
  .cl-spinner-inline > i   Inline spinner used in grid/list slots. The <i> child is the rotating FontAwesome icon (uses fa-spin). To recolor: ".cl-spinner-inline i { color: <color>; }".
  Real progress bars (custom div pairs, NOT <progress> elements):
    .import-progress-bar > .import-progress-fill                       Character import, import-media, and media-localize progress.
    .import-summary-progress-bar > .import-summary-progress-fill       Bulk import summary.

Notifications center (the topbar bell dropdown; shell in modules/gallery-sync.css, media-download rows in modules/media-download-queue.css; NEEDS !important for theme overrides):
  .gallery-sync-dropdown   The dropdown panel itself. Despite the legacy "gallery-sync" name it is the SHARED shell for every notification section. HARDCODED dark surface (rgba(30,30,35,0.98) bg + rgba(255,255,255,0.15) border + heavy drop shadow), bound to NO token; retarget .gallery-sync-dropdown background/border directly to recolor the panel.
  .notif-section           One section card inside the dropdown (today: media downloads + gallery sync). Neutral inset surface rgba(0,0,0,0.2) + var(--glass-border) + var(--radius-lg). The bg is HARDCODED (the app's recurring inset-panel value) and does NOT follow accent; retarget .notif-section background to recolor the cards.
  Media downloads (.mdq-* selectors):
    .mdq-header            Section eyebrow title ("MEDIA DOWNLOADS"); its <i> icon is var(--accent) (follows accent).
    .mdq-job               One download row. Children: .mdq-job-icon (leading status glyph: var(--accent) for active; .mdq-job-icon-error adds var(--cl-error-bright) for failed), .mdq-job-body, .mdq-job-name, .mdq-job-sub (with faint .mdq-job-meta count/percent), .mdq-job-actions / .mdq-job-btn (icon buttons; hover bg rgba(var(--accent-rgb),0.15), follows accent).
    .mdq-progress > .mdq-progress-fill   Active-job bar. The FILL is var(--accent) (follows accent); the TRACK (.mdq-progress bg) is a HARDCODED neutral rgba(255,255,255,0.07).
    .mdq-pending           "N more queued" line. .mdq-error is a failed-job message in var(--cl-error-pale) (follows error tier). .mdq-done-row is the "N completed" footer; its check <i> is var(--cl-success) (follows success tier).
  Gallery sync (.sync-dropdown-* / .gallery-sync-status-box selectors):
    .sync-dropdown-header  Status line; .healthy = var(--cl-success-bright), .issues = var(--cl-warning-bright) (follow the status tiers).
    .sync-dropdown-stats   The chars / with-ID stat row. .sync-dropdown-actions is the Details / Assign IDs / Settings .action-btn row. .sync-issue-details / .sync-detail-item is the expandable missing-id list.

Mobile chrome (defined in library-mobile.css and modules/chats.css; scoped under html.cl-mobile). Rules using these selectors typically need !important to beat the mobile stylesheet's existing rules:
  .mobile-bottom-nav            Persistent bottom navigation bar (mobile only; replaces topbar). Frosted-glass surface.
  .mobile-bottom-nav-tab        One of the three view tabs inside .mobile-bottom-nav (Characters / Chats / Online). Takes flex: 1 to share space evenly. Active state: .mobile-bottom-nav-tab.active (gets --accent color + a 3px top stripe).
  .mobile-bottom-nav-action     Small (40px) icon-only utility button (Filters, More). Renders as a floating --radius-circle with --text-faint color; active/press state tints to accent. Labels are hidden.
  .mobile-bottom-nav-actions    Wrapper grouping the action buttons; visually offset from the view tabs with var(--space-md) margin-left.
  .mobile-fab                   Floating action button (primary per-view action). Default solid-accent gradient; respects buttonStyle setting via :root[data-btn-style="glass"] override.
  .mobile-search-overlay        Mobile search overlay shown on Characters / Chats views (FAB-triggered, full-viewport).
  .mobile-online-search-overlay Mobile online-provider search overlay (FAB-triggered on Online view, full-viewport sheet).
  .mobile-more-actions-btn      Kebab popover trigger inside .browse-char-modal .modal-controls (mobile only). Visible when the "Quick-import button on browse previews" setting is OFF.
  .mobile-more-actions-menu     Popover menu spawned by .mobile-more-actions-btn. Contains .mobile-more-actions-item rows mirroring the provider's action buttons.
  .mobile-quick-import-btn      Icon-only Download/Import/Extract square that mirrors the provider's primary action button state. Color-coded via the data-state attribute: data-state="primary" (accent), data-state="warning" (--cl-warning-bright, possible-match), data-state="secondary" (muted, in-library).
  .mobile-provider-quick-switch Topbar provider-switch icon button on the Online view (small icon next to the view tabs).
  .mobile-sheet-overlay / .mobile-sheet   THE canonical mobile bottom-sheet shell (slide-up, drag handle, scrim). Used by Settings/Filters, More menu, provider-switch, the <select> picker, confirm sheets AND the card context menu (long-press). Open state: .mobile-sheet.open. Rows: .mobile-sheet-item; cloned context-menu rows use .cl-context-menu-item inside it.
  .mobile-settings-select       Full-width button chip inside the mobile settings sheet's Sort By section; opens the selector drawer for the real <select> it mirrors. Children: .mobile-settings-select-text (current value, ellipsised) + .mobile-settings-select-arrow (chevron). COUPLING GAP: its background is a HARDCODED rgba(255,255,255,0.08), NOT bound to the accent, so an accent retheme leaves it neutral; retarget .mobile-settings-select background explicitly to follow accent.
  .mobile-avatar-viewer         Tap-on-avatar quick fullscreen image viewer.
  .mobile-pull-refresh-indicator Pull-to-refresh affordance attached to .gallery-content; modifiers: .ready, .refreshing.
  .char-card-swipe-chip         Swipe-action chip rendered on a card during left/right swipe. .char-card-swipe-chip.right is the favorite (gold) chip; .char-card-swipe-chip.left is the destructive (red) chip. .armed state activates on threshold crossing.

Skeleton & empty states (mobile-first but used on both platforms):
  .cl-skeleton-card             Skeleton placeholder matching the .char-card layout. Children: .cl-skeleton-img (image area), .cl-skeleton-line (text rows). All use --glass-border as the base + an animated shimmer overlay.
  .cl-skeleton-line             Single shimmering line; use modifier widths via inline style or extra classes.
  .cl-empty-state               Rich empty-state container with icon + title + hint + optional action button. Children: .cl-empty-state-icon, .cl-empty-state-title, .cl-empty-state-hint, .cl-empty-state-action.

Scrollbars (webkit pseudo-elements; safe to theme globally):
  ::-webkit-scrollbar / ::-webkit-scrollbar-track / ::-webkit-scrollbar-thumb / ::-webkit-scrollbar-thumb:hover

Icons: CL uses FontAwesome 6 (Free) for icons throughout, rendered as <i class="fa-solid fa-NAME"></i>. Common names include fa-check, fa-check-circle, fa-times, fa-xmark, fa-triangle-exclamation, fa-info-circle, fa-lightbulb, fa-star, fa-heart, fa-spinner (with fa-spin class for rotation), fa-paper-plane, fa-floppy-disk. Standard FontAwesome theming techniques apply.

Native form controls: CL has ~97 native <input type="checkbox"> elements (across settings, filters, dialogs) and several <input type="radio">. The global accent-color rule routes them through --accent, so token overrides handle simple tinting. Beyond color, standard browser-form theming patterns apply.

The list above documents stable, recommended theming surfaces. CL is built on standard HTML, CSS, and FontAwesome 6; for requests outside this catalogue (icon swaps, native form-control customization, animations, niche selectors), reach for general web-CSS knowledge. The catalogue is a guide, not a fence.
`.trim();

const EXAMPLE_OUTPUTS = `
EXAMPLE 1 (GLOBAL, request: "synthwave pink theme"):
\`\`\`css
/* Title: Synthwave Pink Theme */
:root {
    --accent: #ff2e93;
    --accent-rgb: 255, 46, 147;
    --accent-hover: #ff5cab;
    --accent-secondary: #00f0ff;
    --accent-secondary-rgb: 0, 240, 255;
    --bg-primary: #0a0014;
    --bg-secondary: #1a0a2e;
    --modal-bg: rgba(15, 0, 25, 0.9);
    --cl-glass-bg: rgba(20, 5, 35, 0.95);
    --text-primary: #fff5fb;
    --glass-border: rgba(255, 46, 147, 0.35);
}
body {
    background: radial-gradient(ellipse at top, #2a0a4e 0%, #0a0014 70%) fixed;
}
\`\`\`
Pink accent on deep purple, cyan secondary. --accent-hover is hardcoded (not derived from --accent-rgb), so it needs its own override alongside --accent / --accent-rgb. All three modal-background vars overridden so card-update + settings + module dialogs match. Text in module dialogs reads from --cl-text-primary (independent of --text-primary); override that var explicitly if a non-default text color is wanted there too.

EXAMPLE 2 (request: "make character cards more rounded and bigger"):
\`\`\`css
/* Title: Rounded Bigger Cards */
.char-card {
    border-radius: var(--radius-4xl);
    transform: scale(1.05);
    transition: transform 0.2s ease;
}
.char-card:hover {
    transform: scale(1.08) translateY(-3px);
    box-shadow: 0 12px 32px rgba(var(--accent-rgb), 0.25);
}
\`\`\`
Rounder corners and a subtle scale-up on hover.

EXAMPLE 3 (SCOPED, request: "make progress bars bright orange, plus some other elements too, without changing my accent color"):
\`\`\`css
/* Title: Orange Progress Accents */
.import-progress-fill,
.import-summary-progress-fill {
    background: linear-gradient(90deg, #ff6b00, #ffa726);
}
.cl-loading .cl-loading-icon i,
.cl-spinner-inline i {
    color: #ff9500;
}
.cl-loading .cl-loading-bar span {
    background: linear-gradient(90deg, transparent 0%, #ff9500 50%, transparent 100%);
}
::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #ff6b00 0%, var(--accent) 100%);
}
\`\`\`
Orange progress bar fills, spinner icons, indeterminate loader bar, and scrollbar. Direct selectors with direct colors, no :root overrides, so accent and status semantics are untouched.

WHY THE OBVIOUS APPROACH IS WRONG: a tempting answer would be "override --cl-warning to mean orange" (warnings look progress-shaped, after all). Resist this. --cl-warning drives every warning toast, gallery-fills callout, extraction-status banner, and tip lightbulb across the entire app. Hijacking it for orange progress bars repaints hundreds of unrelated surfaces. Similarly, "progress { ... }" matches nothing in CL: there are no native &lt;progress&gt; elements; all progress bars are custom div pairs (see CATALOGUE_COMPONENTS).
`.trim();

const SYSTEM_PROMPT = `You produce CSS snippets for the SillyTavern Character Library (CL) extension. The user pastes your output into a custom CSS field that injects into a <style> tag at end of <head>.

${CATALOGUE_TOKENS}

${CATALOGUE_COMPONENTS}

${EXAMPLE_OUTPUTS}

SCOPE FRAMEWORK (apply BEFORE writing CSS):

Step 1, classify the request:
  GLOBAL retheme  → the user wants the whole app to look different ("synthwave theme", "make everything purple", "neon mode", "darker dark mode"). Override :root tokens.
  SCOPED change   → the user wants a specific element or feature to change ("orange progress bars", "round the avatar", "bigger character names", "glow on hover", "hide the badges"). Use direct selectors with direct values. Do NOT override :root tokens.
  MIXED iteration → a scoped change inside an existing themed snippet. Add direct rules; do NOT restate or modify the existing :root block.

Step 2, check for hard fences:
  Phrases like "without changing X", "keep my Y", "don't touch Z" are not preferences; they are constraints. Anything tied to X is off-limits, including INDIRECT couplings (e.g. if the user says "don't change the accent color" and you override --accent-rgb, you've broken the fence because --accent-glow is computed from --accent-rgb).

Step 3, note how semantic tokens propagate:
  --cl-success / --cl-error / --cl-warning / --cl-info (and their *-bright + *-rgb companions) drive every toast, banner, status icon, badge, and callout across the app. Overriding them rethemes status semantics globally, useful when that's what the user asked for ("make all my warnings cyan"). For a scoped color change ("make MY progress bars orange"), direct selectors are the cleaner tool (see Example 3).

OUTPUT FORMAT (strict):
1. Open with a single fenced \`\`\`css ... \`\`\` code block. No prose, no preamble before the code block.
2. The FIRST line inside the code block must be a title comment: /* Title: <2-5 words describing the snippet> */
   Examples: /* Title: Synthwave Pink Theme */ , /* Title: Rounded Bigger Cards */ , /* Title: Neon Hover Glow */
   The title is used as the snippet name when saved. Pick something descriptive of the visual effect, not the user's literal words.
3. After the code block, optionally one short sentence (max 20 words) summarizing the change. No more.
4. If the user's request is ambiguous AND you cannot make a reasonable default choice, ask ONE clarifying question instead of generating code. Otherwise pick sensible defaults and ship.

CSS RULES:

1. For a GLOBAL retheme, override :root tokens; they propagate coherently. For a SCOPED change, use direct selectors. See SCOPE FRAMEWORK above.

2. When changing the modal background (global theme only), override --modal-bg AND --bg-secondary AND --cl-glass-bg together. Three flavors of modal read from these three independent vars.

3. For a global accent retheme, override --accent / --accent-rgb (and --accent-hover, which is hardcoded). The module-dialog button family and all module CSS read the core --accent chain directly now, so it carries through automatically. The --cl-* family that remains is surface/text only (see CATALOGUE_TOKENS).

4. Use rgba() and the *-rgb tokens (e.g. rgba(var(--accent-rgb), 0.3)) for translucent effects tied to the active theme. For one-off scoped colors that aren't theme-tied, raw rgba is fine.

5. Keep snippets under 2 KB. If the user wants more, ask whether to split into multiple snippets.

6. CSS only. No <script>, no <style> tags. @import and external url() are allowed but warn the user that they hit the network.

KNOWN GOTCHAS (avoid these failure modes):

1. Global accent retheme is a single chain. Override --accent + --accent-rgb (and --accent-hover, which is hardcoded, not derived):
     :root {
         --accent: #ff2e93;
         --accent-rgb: 255, 46, 147;
         --accent-hover: #ff5cab;
     }
   Module dialogs (.cl-btn, .cl-modal-content chrome, card-updates / batch-tagging / playlists / character-versions / context-menu) all read the core --accent / --accent-rgb / --accent-hover directly, so this carries through the whole app. The old separate --cl-accent chain was removed; there is no second chain to override.

2. Buttons get their visual identity from --accent (background, focus ring, glow). The --accent-glow token is computed from --accent-rgb at 30% alpha, so changing --accent-rgb automatically updates glows. Don't add direct rules like ".glass-btn { border: 1px solid ... }" for a global retheme; they stack messily with the built-in hover/focus styles. Direct rules are fine when you want a behavior tokens can't produce (e.g. a neon outer glow only on hover).

3. --accent-text is the text color shown ON a solid accent-colored background. If your --accent is pale, set --accent-text to a dark color for contrast. If --accent is dark, --accent-text should be light.

4. Catch-all substring attribute selectors are the trap to watch. ".cl-tag:not([class*='-success'])" looks like a clever way to target "info tags only" but actually matches every neutral .cl-tag in the app (character tags, lorebook tags, playlist labels, status pills). Use the actual class name (.cl-tag.cl-tag-info) or restrict by context (.recommender-result .cl-tag). This is specifically about substring matchers like [class*='X']; exact-attribute selectors like input[type='checkbox'] are fine and routinely needed.

5. Module CSS files load AFTER the custom CSS <style> tag. Anything in modules/ needs !important to win source-order. Module CSS files (15): custom-css, recommender, playlists, card-update, batch-tagging, character-creator, character-versions, chats, css-assistant, gallery-sync, gallery-viewer, multi-select, context-menu, lorebook-manager, media-download-queue. Provider browse CSS files (6 with class prefixes): browse-shared, chub-browse, chartavern-browse, pygmalion-browse, datacat-browse, botbooru-browse. (Wyvern's CSS file holds a single [data-select-id] rule and otherwise inherits .browse-*. Janny has no CSS file; inherits from browse-shared.) Class-prefix map for the modules: .ccss-* (custom-css), .recommender-*, .pl-* (playlists), .card-update-*, .bt-* (batch-tagging), .creator-* (character-creator), .vt-* (character-versions), .chat-*, .css-assistant-*, .gallery-sync-*, .gv-* (gallery-viewer), .multi-select-*, .cl-context-menu-*, .lb-* (lorebook-manager), .mdq-* (media-download-queue), .browse-*, .chub-*, .ct-* (chartavern), .pyg-* (pygmalion), .datacat-*, .botbooru-*. For library.css selectors (.char-card, .topbar, .glass-btn, .toast, .settings-*, .view-toggle, .tab-pane, .modal-glass, .modal-sidebar, .favorite-indicator, etc.), source order favors custom CSS so no !important is needed.

6. .toast.info reads from --accent, not --cl-info. Overriding --cl-info for a "blue info" semantic does NOT recolor info toasts. If a global theme needs info toasts to follow a non-accent color, target ".toast.info" directly with a !important rule on its border-color and ".toast.info .toast-icon" on the icon color.

7. Mobile mode (html.cl-mobile) disables hover transforms and backdrop-filter via "!important" rules in library-mobile.css. Hover-only styling silently no-ops on touch devices. If a theme effect needs to be visible on mobile, don't tie it to :hover alone. Desktop-only themes are fine; acknowledge the limitation if it matters.

8. Custom CSS applies on all viewports. Scope rules under "html.cl-mobile" for mobile-specific behavior (the app's mobile-mode class: set on small screens, touch-first devices like tablets, or by the user's Mobile Layout setting), or "html:not(.cl-mobile)" for desktop-only. Prefer the class over width-based @media queries: width queries miss tablets and users who force mobile mode. Layout-heavy themes (changing card sizes, repositioning the topbar) often need explicit mobile handling.

9. Theme coherence on mobile. Mobile chrome is a fully separate surface (the topbar disappears; the persistent UI is .mobile-bottom-nav at the bottom plus .mobile-fab, bottom sheets, and overlays). A global retheme that only paints desktop chrome leaves these mobile-only surfaces looking off-brand. Most .mobile-* selectors (CATALOGUE_COMPONENTS → Mobile chrome) pick up token overrides automatically, but a few want explicit rules scoped under "html.cl-mobile" to feel coherent in mobile mode: .mobile-fab (solid-accent gradient in default buttonStyle), the .mobile-bottom-nav frosted-glass surface and its .mobile-bottom-nav-tab.active accent stripe, and the .mobile-quick-import-btn[data-state] color states. For any non-trivial global theme, include a small mobile block that re-applies the same visual identity to these elements.

CONVERSATION:
- The user can iterate: "make it more red", "add a glow on hover", etc. Modify the previous code block rather than restarting.
- If something cannot be done with CSS alone (logic, conditional content), say so plainly in one sentence.`;

// ========================================
// MODULE STATE
// ========================================

const MODE_RAW = 'raw';
const MODE_SNIPPETS = 'snippets';

let modalInjected = false;
// Conversation messages: { role, content }. First entry is the system prompt.
let conversation = [];
// Wand snapshot attached to the next user message; consumed once.
let pendingContext = null;
// Sticky reference to the snippet being iterated on. Enables the "Update X" button.
let iterationSnippetId = null;
let iterationSnippetName = '';
let loadedProfiles = [];
let activeSource = '';
let activeModel = '';
let activePreset = null;
let abortController = null;

const SETTING_PROFILE_ID = 'cssAssistantProfileId';

// ========================================
// LLM CALL
// ========================================

function getSavedProfileId() {
    return CoreAPI.getSetting(SETTING_PROFILE_ID) || '';
}

function setSavedProfileId(id) {
    CoreAPI.setSetting(SETTING_PROFILE_ID, id || '');
}

function getSelectedProfile() {
    const selectEl = document.getElementById('cssAssistantProfile');
    const id = selectEl?.value || getSavedProfileId();
    return loadedProfiles.find(p => p.id === id) || null;
}

async function loadProfiles() {
    const selectEl = document.getElementById('cssAssistantProfile');
    const statusEl = document.getElementById('cssAssistantConnectionStatus');
    if (!selectEl) return;

    try {
        const s = await CoreAPI.getLlmSettings();
        if (s.error) throw new Error('Settings fetch failed');

        activeSource = s.activeSource;
        // Local quirk kept from the inline days: fall back to a bare preset.model if the
        // per-source key resolution came up empty.
        activeModel = s.activeModel || s.activePreset?.model || '';
        activePreset = s.activePreset;
        const ccProfiles = s.profiles;

        if (!s.hasProfiles) {
            loadedProfiles = [];
            if (statusEl) statusEl.textContent = 'No Connection Profiles found in SillyTavern.';
            selectEl.innerHTML = '<option value="">(no profiles)</option>';
            selectEl._customSelect?.refresh();
            return;
        }
        if (!ccProfiles.length) {
            loadedProfiles = [];
            if (statusEl) statusEl.textContent = 'No Chat Completion profiles in SillyTavern.';
            selectEl.innerHTML = '<option value="">(no CC profiles)</option>';
            selectEl._customSelect?.refresh();
            return;
        }
        loadedProfiles = ccProfiles;

        selectEl.innerHTML = ccProfiles.map(p =>
            `<option value="${CoreAPI.escapeHtml(p.id)}">${CoreAPI.escapeHtml(p.name || p.api || 'Unnamed')}</option>`
        ).join('');

        const savedId = getSavedProfileId();
        if (savedId && ccProfiles.some(p => p.id === savedId)) {
            selectEl.value = savedId;
        } else if (s.selectedProfileId && ccProfiles.some(p => p.id === s.selectedProfileId)) {
            selectEl.value = s.selectedProfileId;
        } else {
            selectEl.value = ccProfiles[0].id;
        }
        setSavedProfileId(selectEl.value);
        selectEl._customSelect?.refresh();
        updateConnectionStatus();
    } catch (err) {
        console.error('[CSSAssistant] loadProfiles failed:', err);
        if (statusEl) statusEl.textContent = 'Could not reach SillyTavern server.';
    }
}

function updateConnectionStatus() {
    const statusEl = document.getElementById('cssAssistantConnectionStatus');
    if (!statusEl) return;
    const profile = getSelectedProfile();
    if (!profile) {
        statusEl.textContent = activeSource ? `${activeSource}${activeModel ? ' / ' + activeModel : ''}` : 'No profile selected.';
        return;
    }
    const label = profile.model || profile.api || 'unknown';
    statusEl.textContent = `${profile.name || profile.api || 'Profile'} (${label})`;
}

// Delegates the request/proxy/parse to the shared client. checkFinishReason preserves the
// explicit token-truncation error; non-JSON throws (returnRawOnNonJson stays false).
function callSillyTavernAPI(messages, signal) {
    return CoreAPI.callLLM(messages, {
        profile: getSelectedProfile(),
        activeSource, activeModel, activePreset,
        temperature: 0.7, maxTokens: 6000, signal,
        checkFinishReason: true, debugTag: 'CSSAssistant',
    });
}

// ========================================
// CSS BLOCK EXTRACTION
// ========================================

// Tolerant fenced-block extractor: ```css or ```, closed or truncated, leading whitespace.
function extractCssBlock(text) {
    if (typeof text !== 'string') return null;

    const closedCss = text.match(/```css\s*\n([\s\S]*?)```/i);
    if (closedCss) return closedCss[1].trim();

    const closedAny = text.match(/```[a-z]*\s*\n([\s\S]*?)```/i);
    if (closedAny) {
        const body = closedAny[1].trim();
        if (/[.#:@][\w-]*\s*\{/.test(body) || /^[\w-]+\s*:/.test(body)) return body;
    }

    // Unclosed fence: truncated response, grab from open to end.
    const openCss = text.match(/```css\s*\n([\s\S]*)$/i);
    if (openCss) return openCss[1].trim();

    const openAny = text.match(/```[a-z]*\s*\n([\s\S]*)$/i);
    if (openAny) {
        const body = openAny[1].trim();
        if (/[.#:@][\w-]*\s*\{/.test(body) || /^[\w-]+\s*:/.test(body)) return body;
    }

    return null;
}

function extractSnippetTitle(css) {
    if (typeof css !== 'string') return null;
    const m = css.match(/\/\*\s*Title\s*:\s*(.+?)\s*\*\//i);
    if (m) {
        const title = m[1].trim().slice(0, 60);
        if (title) return title;
    }
    return null;
}

function heuristicSnippetTitle(css) {
    if (typeof css !== 'string' || !css.trim()) return 'AI Snippet';
    const lower = css.toLowerCase();
    const hasRoot = /:root\s*\{/.test(lower);
    const hasBg = /--bg-primary|--bg-secondary|--modal-bg|background\s*:/.test(lower);
    const hasAccent = /--accent\s*:|--accent-rgb/.test(lower);
    const hasCard = /\.char-card/.test(lower);
    const hasButton = /\.glass-btn|\.action-btn|\.cl-btn/.test(lower);
    const hasHover = /:hover/.test(lower);
    if (hasRoot && hasBg && hasAccent) return 'Custom Theme';
    if (hasRoot && hasAccent) return 'Accent Override';
    if (hasCard && hasHover) return 'Card Hover Effect';
    if (hasCard) return 'Card Style';
    if (hasButton) return 'Button Style';
    return 'AI Snippet';
}

function snippetNameFromCss(css) {
    return extractSnippetTitle(css) || heuristicSnippetTitle(css);
}

// ========================================
// MODAL HTML
// ========================================

function buildModalHTML() {
    return `
    <div class="cl-modal css-assistant-modal" id="cssAssistantModal">
        <div class="cl-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-wand-magic-sparkles"></i> CSS Assistant</h3>
                <button class="cl-modal-close" id="cssAssistantCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body css-assistant-body">
                <div class="css-assistant-toolbar">
                    <div class="css-assistant-profile-row">
                        <label for="cssAssistantProfile">Connection</label>
                        <select id="cssAssistantProfile" class="glass-select"></select>
                        <span id="cssAssistantConnectionStatus" class="css-assistant-status">Loading...</span>
                    </div>
                    <button class="cl-btn cl-btn-sm cl-btn-secondary" id="cssAssistantResetBtn" title="Start a new conversation"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
                <div class="css-assistant-context-banner" id="cssAssistantContextBanner" hidden>
                    <i class="fa-solid fa-link"></i>
                    <span class="css-assistant-context-text">Iterating on snippet <strong id="cssAssistantContextName"></strong>. Its current CSS will be attached to your next message.</span>
                    <button class="css-assistant-context-dismiss" id="cssAssistantContextDismiss" title="Discard context (fresh chat)"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="css-assistant-chat" id="cssAssistantChat"></div>
                <div class="css-assistant-empty" id="cssAssistantEmpty">
                    <i class="fa-solid fa-comments"></i>
                    <p>Describe the look you want. Examples:</p>
                    <ul>
                        <li>"Pink synthwave theme with glowing accents"</li>
                        <li>"Make character cards round and bigger"</li>
                        <li>"Replace every checkmark with a star emoji on every checkbox"</li>
                    </ul>
                </div>
            </div>
            <div class="cl-modal-footer css-assistant-footer">
                <textarea id="cssAssistantInput" class="glass-input css-assistant-input" placeholder="Describe a UI tweak (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
                <div class="css-assistant-footer-actions">
                    <button class="cl-btn cl-btn-danger cl-hidden" id="cssAssistantCancelBtn"><i class="fa-solid fa-stop"></i> Stop</button>
                    <button class="cl-btn cl-btn-primary" id="cssAssistantSendBtn"><i class="fa-solid fa-paper-plane"></i> Send</button>
                </div>
            </div>
        </div>
    </div>`;
}

// ========================================
// CHAT RENDERING
// ========================================

function escapeHtml(str) {
    return CoreAPI.escapeHtml(String(str));
}

function renderAssistantMessage(content, messageIndex) {
    const cssBlock = extractCssBlock(content);
    if (!cssBlock) {
        return `<div class="css-assistant-msg-text">${renderMarkdownLite(content)}</div>`;
    }
    const prose = content.replace(/```css\s*\n[\s\S]*?```/i, '').replace(/```\s*\n[\s\S]*?```/i, '').trim();
    const updateBtn = iterationSnippetId
        ? `<button class="cl-btn cl-btn-sm cl-btn-primary css-assistant-update-snippet" data-msg-index="${messageIndex}" title="Replace the current snippet with this CSS"><i class="fa-solid fa-floppy-disk"></i> Update &ldquo;${escapeHtml(iterationSnippetName)}&rdquo;</button>`
        : '';
    const addBtnVariant = iterationSnippetId ? 'cl-btn-secondary' : 'cl-btn-primary';
    return `
        ${prose ? `<div class="css-assistant-msg-text">${renderMarkdownLite(prose)}</div>` : ''}
        <div class="css-assistant-code-wrap">
            <pre class="css-assistant-code"><code>${escapeHtml(cssBlock)}</code></pre>
            <div class="css-assistant-code-actions">
                <button class="cl-btn cl-btn-sm cl-btn-secondary css-assistant-copy" data-msg-index="${messageIndex}" title="Copy CSS"><i class="fa-solid fa-copy"></i> Copy</button>
                <button class="cl-btn cl-btn-sm ${addBtnVariant} css-assistant-add-snippet" data-msg-index="${messageIndex}"><i class="fa-solid fa-plus"></i> Save as new</button>
                ${updateBtn}
            </div>
        </div>
    `;
}

function renderMarkdownLite(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return html;
}

function renderChat() {
    const chatEl = document.getElementById('cssAssistantChat');
    const emptyEl = document.getElementById('cssAssistantEmpty');
    if (!chatEl || !emptyEl) return;
    const userMessages = conversation.filter(m => m.role === 'user');
    emptyEl.hidden = userMessages.length > 0;

    const visible = conversation.filter(m => m.role !== 'system');
    chatEl.innerHTML = visible.map((msg, idx) => {
        const conversationIndex = conversation.indexOf(msg);
        if (msg.role === 'user') {
            return `
                <div class="css-assistant-msg user">
                    <div class="css-assistant-msg-role"><i class="fa-solid fa-user"></i> You</div>
                    <div class="css-assistant-msg-text">${renderMarkdownLite(msg.content)}</div>
                </div>
            `;
        }
        return `
            <div class="css-assistant-msg assistant">
                <div class="css-assistant-msg-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Assistant</div>
                ${renderAssistantMessage(msg.content, conversationIndex)}
            </div>
        `;
    }).join('');

    chatEl.scrollTop = chatEl.scrollHeight;
}

function renderThinking() {
    const chatEl = document.getElementById('cssAssistantChat');
    if (!chatEl) return;
    const ind = document.createElement('div');
    ind.className = 'css-assistant-msg assistant thinking';
    ind.id = 'cssAssistantThinking';
    ind.innerHTML = `
        <div class="css-assistant-msg-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Assistant</div>
        <div class="css-assistant-thinking-dots"><span></span><span></span><span></span></div>
    `;
    chatEl.appendChild(ind);
    chatEl.scrollTop = chatEl.scrollHeight;
}

function removeThinking() {
    document.getElementById('cssAssistantThinking')?.remove();
}

// ========================================
// SEND FLOW
// ========================================

function ensureSystemPrompt() {
    if (conversation.length === 0 || conversation[0].role !== 'system') {
        conversation.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }
}

function setPendingContext(ctx) {
    pendingContext = ctx;
    const banner = document.getElementById('cssAssistantContextBanner');
    const nameEl = document.getElementById('cssAssistantContextName');
    if (!banner || !nameEl) return;
    if (ctx) {
        nameEl.textContent = ctx.name || 'Untitled';
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

function setBusy(busy) {
    const sendBtn = document.getElementById('cssAssistantSendBtn');
    const cancelBtn = document.getElementById('cssAssistantCancelBtn');
    const input = document.getElementById('cssAssistantInput');
    if (input) input.disabled = busy;
    // Use class not [hidden] because .cl-btn sets display:inline-flex.
    if (sendBtn) sendBtn.classList.toggle('cl-hidden', busy);
    if (cancelBtn) cancelBtn.classList.toggle('cl-hidden', !busy);
}

async function sendMessage() {
    const input = document.getElementById('cssAssistantInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input._autoGrow?.();

    ensureSystemPrompt();

    // Attach snippet snapshot to the first user message after a wand-open, then clearit.
    let userContent = text;
    if (pendingContext) {
        const ctxBlock = `Current snippet "${pendingContext.name || 'Untitled'}":\n\n\`\`\`css\n${pendingContext.css || '(empty)'}\n\`\`\`\n\nUser request:\n${text}`;
        userContent = ctxBlock;
        setPendingContext(null);
    }

    conversation.push({ role: 'user', content: userContent });
    renderChat();

    setBusy(true);
    renderThinking();
    abortController = new AbortController();

    try {
        const reply = await callSillyTavernAPI(conversation, abortController.signal);
        removeThinking();
        CoreAPI.debugLog?.('[CSSAssistant] Reply:', reply);
        if (!reply || !reply.trim()) {
            CoreAPI.showToast?.('Model returned empty response. It may be overloaded or the request too large. Try again.', 'warning', 4000);
            conversation.pop();
        } else {
            conversation.push({ role: 'assistant', content: reply });
        }
        renderChat();
    } catch (err) {
        removeThinking();
        conversation.pop();
        if (!err.isCancelled) {
            console.error('[CSSAssistant] send failed:', err);
            CoreAPI.showToast?.(err.message || 'Generation failed', 'error');
            if (input) input.value = text;
        }
        renderChat();
    } finally {
        abortController = null;
        setBusy(false);
    }
}

function cancelSend() {
    abortController?.abort();
}

function resetConversation() {
    if (conversation.filter(m => m.role !== 'system').length === 0) {
        CoreAPI.showToast?.('Conversation is already empty', 'info', 1500);
        return;
    }
    if (!window.confirm('Reset the conversation? This clears all messages in this session.')) return;
    conversation = [];
    iterationSnippetId = null;
    iterationSnippetName = '';
    setPendingContext(null);
    renderChat();
}

// ========================================
// ADD AS SNIPPET
// ========================================

async function addAsSnippet(messageIndex) {
    const msg = conversation[messageIndex];
    if (!msg || msg.role !== 'assistant') return;
    const css = extractCssBlock(msg.content);
    if (!css) {
        CoreAPI.showToast?.('No CSS block found in this message', 'warning');
        return;
    }
    const name = snippetNameFromCss(css);
    const body = stripTitleComment(css);
    await createSnippet({ name, css: body, enabled: false });
    try { renderCustomCssSidebar(); } catch { /* not rendered yet */ }
    try { setSnippetsDirty(true); } catch { /* ditto */ }
    CoreAPI.showToast?.(`Snippet "${name}" added`, 'success', 2000);
}

function stripTitleComment(css) {
    if (typeof css !== 'string') return '';
    return css.replace(/^\s*\/\*\s*Title\s*:.*?\*\/\s*\n?/i, '');
}

async function updateIterationSnippet(messageIndex) {
    if (!iterationSnippetId) return;
    const msg = conversation[messageIndex];
    if (!msg || msg.role !== 'assistant') return;
    const css = extractCssBlock(msg.content);
    if (!css) {
        CoreAPI.showToast?.('No CSS block found in this message', 'warning');
        return;
    }
    // Could have been deleted in another modal.
    const data = await loadSnippets();
    const snippet = data?.snippets?.find(s => s.id === iterationSnippetId);
    if (!snippet) {
        CoreAPI.showToast?.(`Snippet "${iterationSnippetName}" no longer exists. Saved as new instead.`, 'warning', 3000);
        await createSnippet({ name: iterationSnippetName || snippetNameFromCss(css), css: stripTitleComment(css), enabled: false });
        iterationSnippetId = null;
        iterationSnippetName = '';
        renderChat();
        try { renderCustomCssSidebar(); } catch { /* ignore */ }
        try { setSnippetsDirty(true); } catch { /* ignore */ }
        return;
    }
    if (!window.confirm(`Replace the CSS in "${snippet.name || 'Untitled'}" with this new version? The previous CSS will be overwritten.`)) return;
    await updateSnippet(iterationSnippetId, { css: stripTitleComment(css) });
    try { renderCustomCssSidebar(); } catch { /* ignore */ }
    try { setSnippetsDirty(true); } catch { /* ignore */ }
    try {
        if (getActiveSnippetId() === iterationSnippetId) loadSnippetIntoEditor(iterationSnippetId);
    } catch { /* custom-css editor not open, nothing to refresh */ }
    CoreAPI.showToast?.(`Snippet "${snippet.name}" updated`, 'success', 2000);
}

// ========================================
// MODAL LIFECYCLE
// ========================================

function injectModal() {
    if (modalInjected) return;
    modalInjected = true;
    document.body.insertAdjacentHTML('beforeend', buildModalHTML());

    const modal = document.getElementById('cssAssistantModal');
    document.getElementById('cssAssistantCloseBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    const input = document.getElementById('cssAssistantInput');
    // Shorter hint on mobile, re-synced on live mode flips since injectModal only runs once.
    const desktopPlaceholder = input.placeholder;
    const syncPlaceholder = () => {
        input.placeholder = CoreAPI.isMobileMode() ? 'Describe a UI tweak' : desktopPlaceholder;
    };
    syncPlaceholder();
    document.addEventListener('cl-mobile-mode-change', syncPlaceholder);
    const autoGrowInput = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', autoGrowInput);
    input._autoGrow = autoGrowInput;
    document.getElementById('cssAssistantSendBtn').addEventListener('click', sendMessage);
    document.getElementById('cssAssistantCancelBtn').addEventListener('click', cancelSend);
    document.getElementById('cssAssistantResetBtn').addEventListener('click', resetConversation);
    document.getElementById('cssAssistantContextDismiss').addEventListener('click', () => setPendingContext(null));

    const profileSelect = document.getElementById('cssAssistantProfile');
    profileSelect.addEventListener('change', () => {
        setSavedProfileId(profileSelect.value);
        updateConnectionStatus();
    });
    CoreAPI.initCustomSelect(profileSelect);

    const chatEl = document.getElementById('cssAssistantChat');
    chatEl.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.css-assistant-copy');
        if (copyBtn) {
            const idx = parseInt(copyBtn.dataset.msgIndex, 10);
            const msg = conversation[idx];
            const css = msg ? extractCssBlock(msg.content) : null;
            if (css) {
                try {
                    await navigator.clipboard.writeText(css);
                    CoreAPI.showToast?.('CSS copied to clipboard', 'success', 1500);
                } catch {
                    CoreAPI.showToast?.('Clipboard write blocked by browser', 'warning');
                }
            }
            return;
        }
        const addBtn = e.target.closest('.css-assistant-add-snippet');
        if (addBtn) {
            const idx = parseInt(addBtn.dataset.msgIndex, 10);
            await addAsSnippet(idx);
            return;
        }
        const updateBtn = e.target.closest('.css-assistant-update-snippet');
        if (updateBtn) {
            const idx = parseInt(updateBtn.dataset.msgIndex, 10);
            await updateIterationSnippet(idx);
            return;
        }
    });

    window.registerOverlay?.({
        id: 'cssAssistantModal',
        tier: 4,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });
}

async function openModal(opts = {}) {
    injectModal();
    await loadProfiles();

    if (opts && opts.snippetId) {
        // Wand on a different snippet starts a fresh chat; same snippet preserves history.
        if (iterationSnippetId && iterationSnippetId !== opts.snippetId) {
            conversation = [];
        }
        try {
            const data = await loadSnippets();
            const snippet = data?.snippets?.find(s => s.id === opts.snippetId);
            if (snippet) {
                setPendingContext({
                    snippetId: snippet.id,
                    name: snippet.name,
                    css: snippet.css || '',
                });
                iterationSnippetId = snippet.id;
                iterationSnippetName = snippet.name || 'Untitled';
            } else {
                setPendingContext(null);
                iterationSnippetId = null;
                iterationSnippetName = '';
            }
        } catch (err) {
            console.warn('[CSSAssistant] Failed to load snippet for context:', err);
            setPendingContext(null);
            iterationSnippetId = null;
            iterationSnippetName = '';
        }
    } else {
        setPendingContext(null);
        iterationSnippetId = null;
        iterationSnippetName = '';
    }

    renderChat();
    document.getElementById('cssAssistantModal').classList.add('visible');
    setTimeout(() => document.getElementById('cssAssistantInput')?.focus(), 50);
}

function closeModal() {
    document.getElementById('cssAssistantModal')?.classList.remove('visible');
}

function init() {}

export { openModal, closeModal };
export default { init, openModal, closeModal };
