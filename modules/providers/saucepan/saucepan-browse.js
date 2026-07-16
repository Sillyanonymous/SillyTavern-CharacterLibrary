// SaucepanBrowseView -- standalone Saucepan (saucepan.ai) browse/search UI for
// the Online tab.
//
// This view was de-interleaved from the multi-source DataCat browse, where
// Saucepan lived as one of four sources. It is now a single-source provider:
//   - Search / sort / faceted (tri-state) tag filtering via the Saucepan API
//   - Creator browsing via companions-of-user (client-side pagination)
//   - Native definition extraction (Bearer token) in the preview modal
//
// All Saucepan network calls go through cl-helper's saucepan-proxy (see
// saucepan-api.js). A token is only required for native definition extraction;
// search/browse are anonymous.

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import {
    IMG_PLACEHOLDER,
    formatNumber,
    BROWSE_PURIFY_CONFIG,
    skeletonLines,
    deferRender,
    deferCall,
    isMobileMode,
} from '../provider-utils.js';
import {
    searchSaucepan,
    fetchSaucepanCompanionsOfUser,
    fetchSaucepanCompanion,
    fetchSaucepanFandoms,
    fetchSaucepanV2Card,
    buildSaucepanCharacterFromHit,
    hasSaucepanToken,
    resolveSaucepanImageUrl,
} from './saucepan-api.js';
// Reciprocal (circular) import: saucepan-provider.js imports this module's
// default export. Both are singletons and only reference each other inside
// method/function bodies (call time, never at module-evaluation time), so the
// cycle resolves cleanly regardless of which module loads first. Import used
// solely for importCharacter().
import saucepanProvider from './saucepan-provider.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    formatRichText,
    safePurify,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    getProviderExcludeTags,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let saucepanCharacters = [];
let saucepanHasMore = true;
let saucepanIsLoading = false;
let saucepanLoadToken = 0;
let saucepanSelectedChar = null;
let saucepanGridRenderedCount = 0;

// Browse mode: 'recent' (default search/sort) or 'creator'
let saucepanBrowseMode = 'recent';

// Search-mode pagination (page-based)
let saucepanCurrentPage = 1;
let saucepanTotalPages = 0;

// Creator-mode pagination (offset into a cached full list)
let saucepanCurrentOffset = 0;
let saucepanCreatorHandle = '';
let saucepanCreatorName = '';
let _saucepanCreatorFullList = [];
let saucepanCreatorSortMode = 'chat_count';

// Sort + text search + open-definition toggle
let saucepanSortMode = 'saucepan_new';
let saucepanSearchQuery = '';
let saucepanOpenDefinitionOnly = true;

// Tri-state tag filtering
let saucepanActiveTags = new Set();     // include slugs
let saucepanExcludedTags = new Set();   // exclude slugs
let saucepanDiscoveredTags = new Set(); // slugs harvested from result rows

// Content filters. NSFW defaults ON (this audience wants adult content) and maps
// to the server `sus` param; hide-extreme is an opt-OUT that applies Saucepan's
// built-in content-warning exclusion list (off by default = exclude nothing).
let saucepanNsfwEnabled = true;
let saucepanHideExtreme = false;
let saucepanFilterHideOwned = false;
let saucepanFilterHidePossible = false;

// Tri-state fandom filtering (franchise / source-material — a Saucepan dimension
// distinct from regular tags, fetched from /api/v1/fandoms).
let saucepanActiveFandoms = new Set();
let saucepanExcludedFandoms = new Set();
let _saucepanFandomList = null; // cached fandom vocabulary

// Preview modal detail-fetch coordination
let saucepanDetailFetchToken = 0;
let saucepanDetailFetchPromise = null;
let saucepanLastCreatorNotes = '';

let view; // module-scoped BrowseView instance reference (set once in constructor)

const PAGE_SIZE = 80;

// ========================================
// FIELD HELPERS
// (normalized Saucepan hits use snake_case; handle a couple aliases)
// ========================================

function getCharId(hit) {
    return hit?.character_id || hit?.id || '';
}

function getCreatorId(hit) {
    return hit?.creator_id || hit?.creatorId || '';
}

function getCreatorName(hit) {
    return hit?.creator_name || hit?.creatorName || '';
}

function getChatCount(hit) {
    return parseInt(hit?.chat_count ?? hit?.chatCount, 10) || 0;
}

function getMsgCount(hit) {
    return parseInt(hit?.message_count ?? hit?.messageCount, 10) || 0;
}

function getFavCount(hit) {
    return parseInt(hit?.favorite_count ?? hit?.favoriteCount, 10) || 0;
}

function getTotalTokens(hit) {
    return parseInt(hit?.totalTokens ?? hit?.card_token_count, 10) || 0;
}

function getCreatedDate(hit) {
    const raw = hit?.createdAt || hit?.created_at || hit?.posted_at;
    return raw ? new Date(raw).toLocaleDateString() : '';
}

function isNsfw(hit) {
    return !!(hit?.isNsfw || hit?.is_nsfw || hit?.sus);
}

function getAvatar(hit) {
    return hit?.avatar || '/img/ai4.png';
}

/**
 * Build a normalized hit from a companion-detail object (for URL lookups and
 * the in-app preview). Mirrors the shape of normalizeSaucepanHit.
 */
function hitFromCompanion(companion, fallbackId) {
    const id = companion?.id || fallbackId;
    return {
        character_id: id,
        id,
        name: companion?.display_name || companion?.name || 'Unknown',
        avatar: resolveSaucepanImageUrl(
            companion?.image?.highres_url
            || companion?.image?.url
            || (companion?.image?.id ? `https://saucepan.ai/cdn/${companion.image.id}/card` : ''),
        ),
        description: companion?.short_description || '',
        tags: Array.isArray(companion?.tags) ? companion.tags : [],
        creator_name: companion?.author_handle || '',
        creator_id: companion?.author_id || '',
        createdAt: companion?.posted_at || '',
        isNsfw: !!companion?.sus,
        totalTokens: companion?.card_token_count || 0,
        chat_count: companion?.chat_count || 0,
        message_count: companion?.interaction_count || 0,
        favorite_count: companion?.favorite_count || 0,
        portrait_count: Array.isArray(companion?.portraits) ? companion.portraits.length : 0,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
        _fullCompanion: companion,
    };
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(hit) {
    const id = getCharId(hit);
    if (id && view._lookup.byProviderId.has(String(id))) return true;

    const name = (hit.name || '').toLowerCase().trim();
    const creator = getCreatorName(hit).toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(c) {
    if (isCharInLocalLibrary(c)) return false;
    return view.isCharPossibleMatch(c.name || '', getCreatorName(c));
}

// ========================================
// SAUCEPAN TAG SYSTEM (tri-state include / exclude picker)
// ========================================

// Curated seed list of Saucepan tag slugs. Saucepan exposes tags as plain
// slug strings (no listing endpoint), so we ship a known set and merge in any
// new slugs discovered in search results (`saucepanDiscoveredTags`).
const SAUCEPAN_KNOWN_TAGS = [
    'abuse','action','adventure','adventurer','age_gap','age_play','alien','ambitious','angst','anime',
    'anti_hero','anxious','any_pov','arranged_marriage','artist','assassin','assistant','athlete',
    'bakadere','bar','bartender','bdsm','bdsm_verse','beach','best_friend','betrayal','bi','biker',
    'bimbo_himbo','blackmail','blood_play','blue_collar','body_horror','body_worship','bodyguard',
    'bondage','boss','bottom','brat','brat_taming','breastplay','breath_play','breeding','bully',
    'business_owner','cannibalism','captive','celebrity','chance_meeting','charismatic','cheating',
    'chef','childhood_friend','chosen_one','closeted','club','cnc','colleagues_to_lovers','college',
    'comedy','comfort','comic','coming_of_age','concubine','conspiracy','contemporary','content_creator',
    'contractual_relationship','cowboy_cowgirl','crush','curse','cyberpunk','dandere','daredevil',
    'dark_romance','dead_dove','death','deity','demi_human','demi_pov','demisexual','demon','deredere',
    'detective','dilf','disabled','doctor','dom','drag_crossdress','dragon','drugs_addiction','dystopian',
    'eldritch','elf','emo','emotionally_unavailable','empath','empathetic','enemies_to_lovers','enhanced',
    'ensemble_cast','esl','ex','executive','exhibitionism','extroverted','face_sitting','fake_relationship',
    'fantasy','farm_setting','farmer','fem','fem_pov','female','femboy','feral','filthy','firefighter',
    'fluff','food_play','forbidden_love','forced_proximity','found_family','freedom','freeuse',
    'friends_to_lovers','furry','futa','fwb','game','gangster','gender_bend','genderfluid','genki',
    'gentle_giant','giant','gore','grumpy','gyaru','hair_kink','harem','healer','heat_rut','hedonistic',
    'hero','hikikomori','himedere','historical','holidays','home','homeless','hookup','horror','hospital',
    'hostage','housespouse','human','humiliation','hunter','hurt_comfort','hurt_no_comfort','hyper',
    'identity','impact_play','incel','incest_stepcest','indentured','independent','injured_user',
    'interactive_rpg','intern','intersex','intersex_pov','introverted','jock','justice','kakkodere',
    'kamidere','kouhai','kuudere','laboratory','lactation','large_anatomy','lore_heavy','love_triangle',
    'lover','loyal','m4a','m4w','mafia','mage','magical','maid_butler','male','male_pov','manipulator',
    'mansion','martial_artist','masc','masochist','mastermind','masturbation','mean_catty','mechanic',
    'medieval','mentally_ill','milf','military','mind_control','mlm','monster','monster_boy',
    'monster_girl','monster_pov','movie','multiple','murderer','musician','mutant','mystery',
    'mythological','needy_clingy','neighbor','nerd','neurodivergent','ninja_samurai','nobility','noir',
    'non_canonical_au','non_human','non_human_genitalia','non_human_pov','noncon_dubcon','ntr','nurse',
    'o_l','oc','olfactophilia','omegaverse','online','oral','orgasm_denial','ovipositor','owner',
    'pansexual','parallel_universe','part_timer','partner','party_member','performer','person_next_door',
    'perverted','pet_play','pimp','pirate','platonic','playful','plus_sized_bot','plushophilia',
    'politics','popular','porn_star','portal','post_apocalyptic','power_dynamics','praise_kink',
    'pregnant','primal_play','prison','pro_dom','promiscuous','psychological','queer','quest','racer',
    'redemption','rejection','religion','reluctant_hero','revenge','rival','robot','rogue','romance',
    'roommate','royalty','rpg','sacrifice','sadist','sassy','savior','scenario','sci_fi','scientist',
    'second_person_pov','self_harm_suicide','selfish','sensitive','sensory_play','servant','sex_toys',
    'sex_worker','sexual_awakening','sexual_roleplay','size_difference','slice_of_life','slow_burn',
    'slur_usage','small_town','smut','soft_dom','soldier','somnophilia','soulmate','space',
    'special_agents','spouse','spy','stalker','step_parent','step_sibling','stoner','stranger',
    'stripper','student','sub','sugar_parent','supernatural','survival','switch','t4t','t4w',
    'tavern_inn','teacher_professor','teammate','temperature_play','therapist','third_person_pov',
    'thriller','time_travel','tomboy','top','trans','transformation','trauma','tsundere','tv_show',
    'two_faced','undead','unemployed','unestablished_relationship','unreliable','unreliable_narrator',
    'unrequited_love','urban_fantasy','urban_fiction','user_harm','utility','vampire','vanilla',
    'villain','villain_pov','villainess','vintage','violence','virgin','voyeurism','vtuber','w4a',
    'w4m','war','warrior','watersports','wealthy','weapon_play','well_intentioned_extremist',
    'werewolf','white_collar','widowed','wlw','workplace','writer','y2k','yandere',
];

function getSaucepanAllTags() {
    const merged = new Set(SAUCEPAN_KNOWN_TAGS);
    for (const t of saucepanDiscoveredTags) merged.add(t);
    return [...merged].sort((a, b) => a.localeCompare(b));
}

function formatSaucepanTag(slug) {
    return String(slug).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function cycleTagStateTri(btn, state) {
    if (!btn) return;
    btn.className = 'browse-tag-state-btn';
    if (state === 'include') {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.title = 'Included — click to exclude';
    } else if (state === 'exclude') {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded — click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Neutral — click to include';
    }
}

function updateTagsButton() {
    const btn = document.getElementById('saucepanTagsBtn');
    const label = document.getElementById('saucepanTagsBtnLabel');
    if (!btn) return;
    const count = saucepanActiveTags.size + saucepanExcludedTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateFandomsButton() {
    const btn = document.getElementById('saucepanFandomsBtn');
    const label = document.getElementById('saucepanFandomsBtnLabel');
    if (!btn) return;
    const count = saucepanActiveFandoms.size + saucepanExcludedFandoms.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Fandoms <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Fandoms';
    }
}

function renderSaucepanTagsList(filter = '') {
    const container = document.getElementById('saucepanTagsList');
    if (!container) return;

    const all = getSaucepanAllTags();
    const filterLower = filter.toLowerCase();
    const filtered = filter ? all.filter(t => t.includes(filterLower)) : all;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    // Sort: active filters (include or exclude) first, then alphabetical
    const sorted = [...filtered].sort((a, b) => {
        const aActive = saucepanActiveTags.has(a) || saucepanExcludedTags.has(a);
        const bActive = saucepanActiveTags.has(b) || saucepanExcludedTags.has(b);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return a.localeCompare(b);
    });

    container.innerHTML = sorted.map(slug => {
        const state = saucepanActiveTags.has(slug) ? 'include'
            : saucepanExcludedTags.has(slug) ? 'exclude'
            : 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>'
            : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>'
            : '';
        const stateTitle = state === 'include' ? 'Included — click to exclude'
            : state === 'exclude' ? 'Excluded — click to clear'
            : 'Neutral — click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-slug="${escapeHtml(slug)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(formatSaucepanTag(slug))}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const slug = item.dataset.tagSlug;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        item.addEventListener('click', () => {
            // neutral -> include -> exclude -> neutral
            if (saucepanActiveTags.has(slug)) {
                saucepanActiveTags.delete(slug);
                saucepanExcludedTags.add(slug);
                cycleTagStateTri(stateBtn, 'exclude');
            } else if (saucepanExcludedTags.has(slug)) {
                saucepanExcludedTags.delete(slug);
                cycleTagStateTri(stateBtn, 'neutral');
            } else {
                saucepanActiveTags.add(slug);
                cycleTagStateTri(stateBtn, 'include');
            }
            updateTagsButton();
            saucepanCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

// ── Fandom picker (franchise/source-material; same tri-state UI as tags) ──

async function ensureSaucepanFandomsLoaded() {
    if (Array.isArray(_saucepanFandomList)) return;
    _saucepanFandomList = []; // mark as loading so we don't double-fetch
    try {
        const list = await fetchSaucepanFandoms();
        _saucepanFandomList = Array.isArray(list) ? list : [];
    } catch {
        _saucepanFandomList = [];
    }
}

function renderSaucepanFandomsList(filter = '') {
    const container = document.getElementById('saucepanFandomsList');
    if (!container) return;

    const all = Array.isArray(_saucepanFandomList) ? _saucepanFandomList : [];
    if (all.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">Loading fandoms…</div>';
        return;
    }

    const f = filter.toLowerCase();
    const filtered = f
        ? all.filter(x => x.name.toLowerCase().includes(f)
            || x.id.toLowerCase().includes(f)
            || (x.searchTerms || '').toLowerCase().includes(f))
        : all;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching fandoms</div>';
        return;
    }

    // Active first, then alphabetical by display name.
    const sorted = [...filtered].sort((a, b) => {
        const aActive = saucepanActiveFandoms.has(a.id) || saucepanExcludedFandoms.has(a.id);
        const bActive = saucepanActiveFandoms.has(b.id) || saucepanExcludedFandoms.has(b.id);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return a.name.localeCompare(b.name);
    });

    container.innerHTML = sorted.map(fd => {
        const state = saucepanActiveFandoms.has(fd.id) ? 'include'
            : saucepanExcludedFandoms.has(fd.id) ? 'exclude'
            : 'neutral';
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>'
            : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>' : '';
        const stateTitle = state === 'include' ? 'Included — click to exclude'
            : state === 'exclude' ? 'Excluded — click to clear'
            : 'Neutral — click to include';
        return `
            <div class="browse-tag-filter-item" data-fandom-id="${escapeHtml(fd.id)}" title="${escapeHtml(fd.description || fd.name)}">
                <button class="browse-tag-state-btn state-${state}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(fd.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const id = item.dataset.fandomId;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        item.addEventListener('click', () => {
            // neutral -> include -> exclude -> neutral
            if (saucepanActiveFandoms.has(id)) {
                saucepanActiveFandoms.delete(id);
                saucepanExcludedFandoms.add(id);
                cycleTagStateTri(stateBtn, 'exclude');
            } else if (saucepanExcludedFandoms.has(id)) {
                saucepanExcludedFandoms.delete(id);
                cycleTagStateTri(stateBtn, 'neutral');
            } else {
                saucepanActiveFandoms.add(id);
                cycleTagStateTri(stateBtn, 'include');
            }
            updateFandomsButton();
            saucepanCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

// ========================================
// SORT OPTIONS
// ========================================

const SAUCEPAN_SORT_OPTIONS = [
    { value: 'saucepan_new', label: '🆕 New' },
    { value: 'saucepan_trending', label: '🔥 Trending' },
    { value: 'saucepan_popular', label: '👑 Popular' },
];

const CREATOR_SORT_OPTIONS = [
    { value: 'chat_count', label: '💬 Most Messages' },
    { value: 'newest', label: '🆕 Newest' },
    { value: 'oldest', label: '🕐 Oldest' },
];

function buildSortOptionsHtml(selected) {
    return SAUCEPAN_SORT_OPTIONS.map(o =>
        `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`
    ).join('');
}

function updateSortOptions() {
    const el = document.getElementById('saucepanSortSelect');
    if (!el) return;
    if (saucepanBrowseMode === 'creator') {
        const current = saucepanCreatorSortMode;
        el.innerHTML = CREATOR_SORT_OPTIONS.map(o =>
            `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`
        ).join('');
    } else {
        el.innerHTML = buildSortOptionsHtml(saucepanSortMode);
    }
    el._customSelect?.refresh();
}

function sortCreatorResults(list, mode) {
    if (mode === 'chat_count') {
        list.sort((a, b) => getMsgCount(b) - getMsgCount(a) || getChatCount(b) - getChatCount(a));
    } else if (mode === 'newest') {
        list.sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
    } else if (mode === 'oldest') {
        list.sort((a, b) => new Date(a.createdAt || a.created_at || 0) - new Date(b.createdAt || b.created_at || 0));
    }
}

// ========================================
// CARD RENDERING
// ========================================

function createSaucepanCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = (hit.description || '').trim();
    const avatarUrl = getAvatar(hit);
    const charId = getCharId(hit);
    const creatorName = getCreatorName(hit);
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(name, creatorName);
    const possibleMatch = !!possibleTier?.show;

    const tags = (Array.isArray(hit.tags) ? hit.tags : []).slice(0, 3).map(formatSaucepanTag);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }

    const nsfwBadge = isNsfw(hit) ? '<span class="browse-nsfw-badge">NSFW</span>' : '';

    const createdDate = getCreatedDate(hit);
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const chatCount = getChatCount(hit);
    const msgCount = getMsgCount(hit);
    const favCount = getFavCount(hit);
    const totalTokens = getTotalTokens(hit);

    let statsHtml = '';
    if (chatCount || msgCount || favCount) {
        statsHtml = `<span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(chatCount)}</span>`;
        if (favCount) {
            statsHtml += `<span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${formatNumber(favCount)}</span>`;
        } else {
            statsHtml += `<span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(msgCount)}</span>`;
        }
    } else if (totalTokens) {
        statsHtml = `<span class="browse-card-stat" title="Total Tokens"><i class="fa-solid fa-text-width"></i> ${formatNumber(totalTokens)}</span>`;
    }

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-saucepan-id="${escapeHtml(String(charId))}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${nsfwBadge}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-creator-id="${escapeHtml(getCreatorId(hit))}" data-creator-handle="${escapeHtml(creatorName)}" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                ${statsHtml}
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function observeNewCards() {
    const grid = document.getElementById('saucepanGrid');
    if (grid) view.observeImages(grid);
}

function updateLoadMore() {
    view.updateLoadMoreVisibility('saucepanLoadMore', saucepanHasMore, saucepanCharacters.length > 0);
}

function renderGrid(characters, append = false) {
    const grid = document.getElementById('saucepanGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        saucepanGridRenderedCount = 0;
    }

    let filtered = saucepanNsfwEnabled ? characters : characters.filter(c => !isNsfw(c));

    if (saucepanFilterHideOwned) {
        filtered = filtered.filter(c => !isCharInLocalLibrary(c));
    }
    if (saucepanFilterHidePossible) {
        filtered = filtered.filter(c => !isCharPossibleMatchObj(c));
    }

    // Client-side: persistent exclude tags from settings
    const persistentExclude = getProviderExcludeTags('saucepan');
    if (persistentExclude.length > 0) {
        const lowerExclude = persistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = (Array.isArray(c.tags) ? c.tags : []).map(n => String(n).toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }

    const startIdx = append ? saucepanGridRenderedCount : 0;
    const html = filtered.slice(startIdx).map(c => createSaucepanCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    saucepanGridRenderedCount = filtered.length;

    observeNewCards();
    updateLoadMore();
}

// ========================================
// LOAD CHARACTERS
// ========================================

async function loadCharacters(append = false) {
    if (append && saucepanIsLoading) return;
    const thisToken = ++saucepanLoadToken;
    saucepanIsLoading = true;

    const grid = document.getElementById('saucepanGrid');
    const loadMoreBtn = document.getElementById('saucepanLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let list = [];
        let total = 0;

        if (saucepanBrowseMode === 'creator' && saucepanCreatorHandle) {
            // The companions-of-user endpoint returns the full author list in
            // one shot. Fetch once on the initial load, then paginate
            // client-side.
            if (!append) {
                saucepanCurrentOffset = 0;
                let full = _saucepanCreatorFullList;
                if (!full || full.length === 0) {
                    const data = await fetchSaucepanCompanionsOfUser(saucepanCreatorHandle);
                    full = data?.characters || [];
                } else {
                    full = full.slice();
                }
                sortCreatorResults(full, saucepanCreatorSortMode);
                _saucepanCreatorFullList = full;
                list = full.slice(0, PAGE_SIZE);
                total = full.length;
            } else {
                list = (_saucepanCreatorFullList || []).slice(
                    saucepanCharacters.length,
                    saucepanCharacters.length + PAGE_SIZE,
                );
                total = (_saucepanCreatorFullList || []).length;
            }
        } else {
            if (!append) saucepanCurrentPage = 1;
            const persistentExclude = getProviderExcludeTags('saucepan') || [];
            const mergedExclude = new Set(persistentExclude);
            for (const t of saucepanExcludedTags) mergedExclude.add(t);
            const data = await searchSaucepan({
                search: saucepanSearchQuery,
                page: saucepanCurrentPage,
                limit: PAGE_SIZE,
                sort: saucepanSortMode,
                openDefinitionOnly: saucepanOpenDefinitionOnly,
                tags: [...saucepanActiveTags],
                excludedTags: [...mergedExclude],
                nsfw: saucepanNsfwEnabled,
                hideExtreme: saucepanHideExtreme,
                fandomTags: [...saucepanActiveFandoms],
                excludedFandomTags: [...saucepanExcludedFandoms],
            });
            list = data?.characters || [];
            total = data?.totalCount || 0;
            saucepanTotalPages = data?.totalPages || 0;
            // Harvest tag slugs from results so the picker grows with what users see
            for (const c of list) {
                const cTags = Array.isArray(c.tags) ? c.tags : [];
                for (const t of cTags) {
                    if (typeof t === 'string' && t) saucepanDiscoveredTags.add(t);
                }
            }
        }

        if (thisToken !== saucepanLoadToken) return;
        if (!delegatesInitialized) return;

        if (append) {
            const existingIds = new Set(saucepanCharacters.map(c => getCharId(c)));
            saucepanCharacters = saucepanCharacters.concat(list.filter(c => {
                const id = getCharId(c);
                return !id || !existingIds.has(id);
            }));
        } else {
            saucepanCharacters = list;
        }

        if (saucepanBrowseMode === 'creator') {
            saucepanHasMore = (saucepanCurrentOffset + PAGE_SIZE) < total;
        } else {
            saucepanHasMore = saucepanCurrentPage < saucepanTotalPages;
        }

        renderGrid(saucepanCharacters, append);

        if (!append && saucepanCharacters.length === 0) {
            const emptyMsg = saucepanBrowseMode === 'creator'
                ? 'No characters found for this creator'
                : 'No characters found';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-bowl-food" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">${emptyMsg}</p>
                </div>
            `;
        }

        debugLog('[SaucepanBrowse] Loaded', list.length, 'characters, total', total, 'mode:', saucepanBrowseMode);
    } catch (err) {
        if (thisToken !== saucepanLoadToken) return;
        console.error('[SaucepanBrowse] Load error:', err);
        showToast(`Saucepan load failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); max-width: 560px; margin: 0 auto;">
                    <i class="fa-solid fa-plug-circle-xmark" style="font-size: 2rem; color: var(--cl-warning-bright-darker);"></i>
                    <p style="margin-top: 12px; color: var(--text-primary);"><strong>Could not reach Saucepan</strong></p>
                    <p style="margin-top: 8px;">Saucepan browsing requires the <strong>cl-helper</strong> server plugin. Make sure it is installed and your SillyTavern server was restarted.</p>
                    <p style="margin-top: 8px; font-size: 0.85em;">${escapeHtml(err.message || '')}</p>
                </div>
            `;
        }
    } finally {
        if (thisToken === saucepanLoadToken) saucepanIsLoading = false;
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

// ========================================
// CREATOR BROWSING
// ========================================

function browseCreator(handle, opts = {}) {
    handle = (handle || '').trim();
    if (!handle) return;
    saucepanBrowseMode = 'creator';
    saucepanCreatorHandle = handle;
    saucepanCreatorName = opts.name || handle;
    _saucepanCreatorFullList = [];
    saucepanCurrentOffset = 0;
    saucepanCharacters = [];
    saucepanHasMore = true;
    saucepanGridRenderedCount = 0;

    const banner = document.getElementById('saucepanCreatorBanner');
    const bannerName = document.getElementById('saucepanCreatorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = saucepanCreatorName;
        banner.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }

    saucepanCreatorSortMode = 'chat_count';
    const creatorSortEl = document.getElementById('saucepanCreatorSortSelect');
    if (creatorSortEl) creatorSortEl.value = 'chat_count';

    updateSortOptions();
    loadCharacters(false);
}

function clearCreatorFilter() {
    saucepanBrowseMode = 'recent';
    saucepanCreatorHandle = '';
    saucepanCreatorName = '';
    _saucepanCreatorFullList = [];
    saucepanCharacters = [];
    saucepanCurrentOffset = 0;
    saucepanCurrentPage = 1;
    saucepanHasMore = true;
    saucepanGridRenderedCount = 0;

    const banner = document.getElementById('saucepanCreatorBanner');
    if (banner) banner.classList.add('hidden');

    updateSortOptions();
    loadCharacters(false);
}

// ========================================
// SEARCH
// ========================================

function doSearch() {
    const input = document.getElementById('saucepanSearchInput');
    const val = (input?.value || '').trim();
    if (!val) {
        if (saucepanSearchQuery) {
            saucepanSearchQuery = '';
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
        return;
    }

    // saucepan.ai URL -> companion preview or creator browse
    try {
        const url = new URL(val.startsWith('http') ? val : `https://${val}`);
        if (/^(www\.)?saucepan\.ai$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/companion\/([a-f0-9-]{36})/i);
            if (charMatch) {
                fetchCompanionAndOpenPreview(charMatch[1]);
                return;
            }
            // Any other saucepan.ai path: treat the first segment (minus a
            // leading @) as a creator handle.
            const seg = url.pathname.replace(/^\/+/, '').split('/')[0].replace(/^@/, '');
            if (seg && seg !== 'companion') {
                if (saucepanBrowseMode === 'creator') clearCreatorFilter();
                browseCreator(seg);
                return;
            }
        }
    } catch { /* not a URL */ }

    // Plain text search
    if (saucepanBrowseMode === 'creator') clearCreatorFilter();
    saucepanSearchQuery = val;
    saucepanCurrentPage = 1;
    loadCharacters(false);
}

function performCreatorSearch() {
    const input = document.getElementById('saucepanCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Enter a Saucepan creator handle or URL', 'warning');
        return;
    }
    input.value = '';

    // Accept a saucepan.ai/@handle URL or a bare @handle / handle.
    let handle = query.replace(/^@/, '');
    const urlMatch = query.match(/saucepan\.ai\/@?([A-Za-z0-9_.-]+)/i);
    if (urlMatch) handle = urlMatch[1];

    browseCreator(handle);
}

async function fetchCompanionAndOpenPreview(companionId) {
    const grid = document.getElementById('saucepanGrid');
    if (grid) renderLoadingState(grid, 'Looking up companion...', 'browse-loading');
    try {
        const companion = await fetchSaucepanCompanion(companionId);
        if (companion) {
            openPreviewModal(hitFromCompanion(companion, companionId));
            // Restore the grid behind the modal.
            renderGrid(saucepanCharacters, false);
        } else {
            showToast('Companion not found on Saucepan', 'warning');
            renderGrid(saucepanCharacters, false);
        }
    } catch (err) {
        showToast(`Lookup failed: ${err.message}`, 'error');
        renderGrid(saucepanCharacters, false);
    }
}

// ========================================
// TOGGLES / FILTER-BAR STATE
// ========================================

function updateNsfwToggle() {
    const btn = document.getElementById('saucepanNsfwToggle');
    if (!btn) return;
    if (saucepanNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled. Click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only. Click to include NSFW';
    }
}

function updateOpenDefToggle() {
    const btn = document.getElementById('saucepanOpenDefToggle');
    if (!btn) return;
    btn.classList.toggle('active', saucepanOpenDefinitionOnly);
    btn.title = saucepanOpenDefinitionOnly
        ? 'Showing only open-definition characters — click to include closed'
        : 'Including closed-definition characters — click to hide';
    const label = btn.querySelector('span');
    if (label) label.textContent = saucepanOpenDefinitionOnly ? 'Open Defs' : 'All Defs';
    const icon = btn.querySelector('i');
    if (icon) icon.className = saucepanOpenDefinitionOnly ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock';
}

function updateFiltersButtonState() {
    const btn = document.getElementById('saucepanFiltersBtn');
    if (!btn) return;
    const count = [saucepanFilterHideOwned, saucepanFilterHidePossible].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    btn.innerHTML = count > 0
        ? `<i class="fa-solid fa-sliders"></i> Features (${count})`
        : '<i class="fa-solid fa-sliders"></i> <span>Features</span>';
}

// ========================================
// PREVIEW MODAL
// ========================================

function renderLockedDefBanner() {
    // Reuses DataCat's modal locked-banner CSS (shared stylesheet).
    return `
        <div class="datacat-modal-locked-banner">
            <i class="fa-solid fa-lock"></i>
            <div>
                <strong>Locked Definition</strong>
                <p>This Saucepan companion's definition is not publicly available. Native extraction may not retrieve the full character body.</p>
            </div>
        </div>
    `;
}

function setImportButtonState(state, hit) {
    const btn = document.getElementById('saucepanImportBtn');
    if (!btn) return;
    delete btn.dataset.authNeeded;
    btn.classList.remove('primary', 'secondary', 'warning');
    switch (state) {
        case 'loading':
            btn.disabled = true;
            btn.classList.add('secondary');
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...';
            break;
        case 'auth':
            btn.disabled = false;
            btn.classList.add('primary');
            btn.dataset.authNeeded = '1';
            btn.innerHTML = '<i class="fa-solid fa-key"></i> Configure Token';
            break;
        case 'unavailable':
            btn.disabled = true;
            btn.classList.add('secondary');
            btn.innerHTML = '<i class="fa-solid fa-ban"></i> Unavailable';
            break;
        case 'inLibrary':
            btn.disabled = false;
            btn.classList.add('secondary');
            btn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
            break;
        case 'import': {
            btn.disabled = false;
            const possible = view.isCharPossibleMatch(hit?.name || '', getCreatorName(hit));
            if (possible) {
                btn.classList.add('warning');
                btn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
            } else {
                btn.classList.add('primary');
                btn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
            }
            break;
        }
    }
}

function openPreviewModal(hit) {
    saucepanSelectedChar = hit;

    // Ensure modal DOM + listeners exist even when called from outside the
    // Online tab (e.g. in-app preview from the link modal).
    view.injectModals();
    ensureModalEventsAttached();

    const modal = document.getElementById('saucepanCharModal');
    if (!modal) return;
    window.resetBrowseSectionCollapseState?.(modal);

    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';
    const avatarUrl = getAvatar(hit);
    const tags = (Array.isArray(hit.tags) ? hit.tags : []).map(formatSaucepanTag);
    const creatorName = getCreatorName(hit) || 'Unknown';
    const inLibrary = isCharInLocalLibrary(hit);

    // Header
    const avatarImg = document.getElementById('saucepanCharAvatar');
    if (avatarImg) {
        avatarImg.src = avatarUrl;
        avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
        BrowseView.adjustPortraitPosition(avatarImg);
    }
    const nameEl = document.getElementById('saucepanCharName');
    if (nameEl) nameEl.textContent = name;
    const creatorEl = document.getElementById('saucepanCharCreator');
    if (creatorEl) creatorEl.textContent = creatorName;

    const openBtn = document.getElementById('saucepanOpenInBrowserBtn');
    if (openBtn) {
        openBtn.href = `https://saucepan.ai/companion/${charId}`;
        openBtn.title = 'Open on Saucepan';
    }

    // Stats
    const chatsEl = document.getElementById('saucepanCharChats');
    const favsEl = document.getElementById('saucepanCharFavorites');
    const tokensEl = document.getElementById('saucepanCharTokens');
    const dateEl = document.getElementById('saucepanCharDate');
    if (chatsEl) chatsEl.textContent = formatNumber(getChatCount(hit));
    if (favsEl) favsEl.textContent = formatNumber(getFavCount(hit));
    if (tokensEl) tokensEl.textContent = formatNumber(getTotalTokens(hit));
    if (dateEl) dateEl.textContent = getCreatedDate(hit) || 'Unknown';

    // Tags
    const tagsEl = document.getElementById('saucepanCharTags');
    if (tagsEl) tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');

    // Creator notes skeleton
    const creatorNotesSection = document.getElementById('saucepanCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('saucepanCharCreatorNotes');
    saucepanLastCreatorNotes = '';
    if (creatorNotesSection && creatorNotesEl) {
        cleanupCreatorNotesContainer(creatorNotesEl);
        creatorNotesSection.style.display = 'block';
        creatorNotesEl.innerHTML = skeletonLines(2);
    }

    // Definition sections hidden until the fetch resolves.
    const defLoading = document.getElementById('saucepanCharDefinitionLoading');
    if (defLoading) defLoading.style.display = 'block';
    for (const id of [
        'saucepanCharDescriptionSection',
        'saucepanCharScenarioSection',
        'saucepanCharMesExampleSection',
        'saucepanCharFirstMsgSection',
        'saucepanCharAltGreetingsSection',
        'saucepanCharGallerySection',
    ]) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    const greetingsStat = document.getElementById('saucepanCharGreetingsStat');
    if (greetingsStat) greetingsStat.style.display = 'none';
    window.currentBrowseAltGreetings = [];
    const galleryGrid = document.getElementById('saucepanCharGalleryGrid');
    if (galleryGrid) galleryGrid.innerHTML = '';

    // Import button - neutral loading state until the definition resolves.
    setImportButtonState(inLibrary ? 'inLibrary' : 'loading', hit);

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    const fetchToken = ++saucepanDetailFetchToken;
    saucepanDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
}

function paintBodySection(sectionId, elId, content, name) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(elId);
    if (!section) return;
    if (content && content.trim()) {
        section.style.display = 'block';
        if (el) {
            deferRender(el, () => safePurify(formatRichText(content, name, true), BROWSE_PURIFY_CONFIG));
            if (elId === 'saucepanCharFirstMsg' || elId === 'saucepanCharMesExample') {
                el.dataset.fullContent = content;
            }
        }
    } else {
        section.style.display = 'none';
        if (el) el.innerHTML = '';
    }
}

function renderTokenCTA({ locked = false } = {}) {
    for (const id of [
        'saucepanCharScenarioSection',
        'saucepanCharFirstMsgSection',
        'saucepanCharMesExampleSection',
        'saucepanCharAltGreetingsSection',
    ]) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    const section = document.getElementById('saucepanCharDescriptionSection');
    const el = document.getElementById('saucepanCharDescription');
    if (section) section.style.display = 'block';
    if (el) {
        el.innerHTML = `
            ${locked ? renderLockedDefBanner() : ''}
            <div class="datacat-modal-extract-cta">
                <div class="datacat-modal-extract-icon-wrap">
                    <i class="fa-solid fa-key datacat-modal-extract-icon"></i>
                </div>
                <p class="datacat-modal-extract-message">A Saucepan token is required to load this character's full definition.</p>
                <p class="datacat-modal-extract-hint">Log in or paste a Bearer token in the Saucepan account settings to enable native extraction.</p>
                <button class="action-btn primary datacat-modal-extract-btn" id="saucepanModalAuthBtn">
                    <i class="fa-solid fa-right-to-bracket"></i> Configure Token
                </button>
            </div>
        `;
        el.querySelector('#saucepanModalAuthBtn')?.addEventListener('click', () => openSaucepanAuthUI());
    }
    setImportButtonState('auth');
}

function renderExtractionUnavailable({ locked = false } = {}) {
    for (const id of [
        'saucepanCharScenarioSection',
        'saucepanCharFirstMsgSection',
        'saucepanCharMesExampleSection',
        'saucepanCharAltGreetingsSection',
    ]) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    const section = document.getElementById('saucepanCharDescriptionSection');
    const el = document.getElementById('saucepanCharDescription');
    if (section) section.style.display = 'block';
    if (el) {
        el.innerHTML = `
            ${locked ? renderLockedDefBanner() : ''}
            <div class="datacat-modal-extract-cta">
                <div class="datacat-modal-extract-icon-wrap">
                    <i class="fa-solid fa-triangle-exclamation datacat-modal-extract-icon"></i>
                </div>
                <p class="datacat-modal-extract-message">${locked
                    ? "This companion's definition is locked and can't be extracted."
                    : "Could not load this character's definition."}</p>
            </div>
        `;
    }
    setImportButtonState('unavailable');
}

function renderSaucepanGallery(portraits) {
    const section = document.getElementById('saucepanCharGallerySection');
    const grid = document.getElementById('saucepanCharGalleryGrid');
    const label = document.getElementById('saucepanCharGalleryLabel');
    if (!section || !grid) return;
    if (!Array.isArray(portraits) || portraits.length === 0) {
        section.style.display = 'none';
        grid.innerHTML = '';
        if (label) label.textContent = '';
        return;
    }
    section.style.display = 'block';
    if (label) label.textContent = `(${portraits.length})`;
    grid.innerHTML = portraits.map(p => {
        // CORP headers block hotlinking; route through cl-helper's proxy.
        const url = resolveSaucepanImageUrl(p?.image?.highres_url || p?.image?.url);
        if (!url) return '';
        const title = p?.description || p?.name || 'Gallery image';
        return `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" title="${escapeHtml(title)}" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`;
    }).join('');
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';

    try {
        // Companion detail is anonymous: it surfaces open_definition (lock
        // state), portraits, the blurb, and richer stats.
        let companion = hit._fullCompanion || null;
        if (!companion) {
            companion = await fetchSaucepanCompanion(charId).catch(() => null);
        }
        if (token !== saucepanDetailFetchToken) return;

        const lockedDef = !!companion && companion.open_definition === false;

        // Richer stats from detail
        if (companion) {
            const chatsEl = document.getElementById('saucepanCharChats');
            const favsEl = document.getElementById('saucepanCharFavorites');
            const tokensEl = document.getElementById('saucepanCharTokens');
            const chats = parseInt(companion.chat_count, 10);
            const favs = parseInt(companion.favorite_count, 10);
            const toks = parseInt(companion.card_token_count, 10);
            if (chatsEl && chats) chatsEl.textContent = formatNumber(chats);
            if (favsEl && favs) favsEl.textContent = formatNumber(favs);
            if (tokensEl && toks) tokensEl.textContent = formatNumber(toks);
        }

        // Creator notes = short blurb (available with or without a token).
        const blurb = (companion?.short_description || hit.description || '').trim();
        const creatorNotesSection = document.getElementById('saucepanCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('saucepanCharCreatorNotes');
        if (blurb && blurb !== saucepanLastCreatorNotes) {
            saucepanLastCreatorNotes = blurb;
            if (creatorNotesSection) creatorNotesSection.style.display = 'block';
            if (creatorNotesEl) {
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(2);
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(blurb, name, creatorNotesEl));
            }
        } else if (!blurb) {
            if (creatorNotesSection) creatorNotesSection.style.display = 'none';
            if (creatorNotesEl) cleanupCreatorNotesContainer(creatorNotesEl);
        }

        // Portrait gallery
        renderSaucepanGallery(companion?.portraits);

        // Native extraction requires a token.
        const defLoading = document.getElementById('saucepanCharDefinitionLoading');
        if (!hasSaucepanToken()) {
            if (defLoading) defLoading.style.display = 'none';
            renderTokenCTA({ locked: lockedDef });
            return;
        }

        const v2Card = await fetchSaucepanV2Card(hit).catch(() => null);
        if (token !== saucepanDetailFetchToken) return;
        if (defLoading) defLoading.style.display = 'none';

        if (!v2Card?.data) {
            renderExtractionUnavailable({ locked: lockedDef });
            return;
        }

        // Cache the native-built character on the selected hit for import.
        const character = buildSaucepanCharacterFromHit(hit, v2Card);
        if (saucepanSelectedChar && getCharId(saucepanSelectedChar) === charId) {
            saucepanSelectedChar._fullCharacter = character;
            saucepanSelectedChar._v2Card = v2Card;
        }

        const data = v2Card.data;
        // Companion Core -> Description (the character body)
        paintBodySection('saucepanCharDescriptionSection', 'saucepanCharDescription', data.description, name);
        // Scenario is empty for Saucepan cards, but paint defensively.
        paintBodySection('saucepanCharScenarioSection', 'saucepanCharScenario', data.scenario, name);
        paintBodySection('saucepanCharFirstMsgSection', 'saucepanCharFirstMsg', data.first_mes, name);
        paintBodySection('saucepanCharMesExampleSection', 'saucepanCharMesExample', data.mes_example, name);
        renderAltGreetings(data.alternate_greetings, name);

        // Enable import now that a usable definition is confirmed.
        setImportButtonState(isCharInLocalLibrary(hit) ? 'inLibrary' : 'import', hit);
    } catch (err) {
        debugLog('[SaucepanBrowse] Detail fetch error:', err);
        if (token === saucepanDetailFetchToken) {
            const defLoading = document.getElementById('saucepanCharDefinitionLoading');
            if (defLoading) defLoading.style.display = 'none';
            renderExtractionUnavailable({});
        }
    }
}

function renderAltGreetings(greetings, charName) {
    const section = document.getElementById('saucepanCharAltGreetingsSection');
    const listEl = document.getElementById('saucepanCharAltGreetings');
    const countEl = document.getElementById('saucepanCharAltGreetingsCount');
    if (!section || !listEl) return;

    const greetingsStat = document.getElementById('saucepanCharGreetingsStat');
    const greetingsCountEl = document.getElementById('saucepanCharGreetingsCount');

    if (!Array.isArray(greetings) || greetings.length === 0) {
        section.style.display = 'none';
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (greetingsStat) greetingsStat.style.display = 'none';
        window.currentBrowseAltGreetings = [];
        return;
    }

    if (greetingsStat) greetingsStat.style.display = 'flex';
    // +1 accounts for the first_mes greeting.
    if (greetingsCountEl) greetingsCountEl.textContent = String(greetings.length + 1);

    const buildPreview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.style.display = 'block';
    listEl.innerHTML = greetings.map((greeting, idx) => {
        const label = `#${idx + 1}`;
        const preview = escapeHtml(buildPreview(greeting));
        return `
            <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                <summary>
                    <span class="browse-alt-greeting-index">${label}</span>
                    <span class="browse-alt-greeting-preview">${preview}</span>
                    <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="browse-alt-greeting-body"></div>
            </details>
        `;
    }).join('');

    listEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                if (greetings[idx] != null) {
                    deferRender(body, () => safePurify(formatRichText(greetings[idx], charName, true), BROWSE_PURIFY_CONFIG));
                }
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });

    if (countEl) countEl.textContent = `(${greetings.length})`;
    window.currentBrowseAltGreetings = greetings;
}

function cleanupCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const sectionIds = [
        'saucepanCharDescription',
        'saucepanCharScenario',
        'saucepanCharFirstMsg',
        'saucepanCharMesExample',
        'saucepanCharAltGreetings',
        'saucepanCharTags',
        'saucepanCharGalleryGrid',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('saucepanCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    saucepanDetailFetchToken++;
    saucepanDetailFetchPromise = null;
    cleanupCharModal();
    const modal = document.getElementById('saucepanCharModal');
    if (modal) modal.classList.add('hidden');
    saucepanSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importSaucepanCharacter(hit) {
    const charId = getCharId(hit);
    if (!charId) return;

    const importBtn = document.getElementById('saucepanImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        if (saucepanDetailFetchPromise) {
            try { await saucepanDetailFetchPromise; } catch { /* ignore */ }
        }

        // Prefer the natively-extracted V2 for a richer duplicate check.
        const v2 = hit._v2Card?.data || null;
        const charName = v2?.name || hit.name || '';
        const charCreator = v2?.creator || getCreatorName(hit) || '';

        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: String(charId),
            description: v2?.description || '',
            first_mes: v2?.first_mes || '',
            scenario: v2?.scenario || '',
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = resolveSaucepanImageUrl(hit.avatar || '') || '/img/ai4.png';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: String(charId),
                avatarUrl,
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                setImportButtonState('import', hit);
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (!deleteSuccess) {
                    console.warn('[SaucepanBrowse] Could not delete existing character, proceeding anyway');
                }
            }
        }

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        // The provider re-runs native extraction and downloads the avatar.
        const result = await saucepanProvider.importCharacter(charId, hit, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const hasGallery = !!result.hasGallery;
        const showSummary = (hasGallery || mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        const summaryArgs = {
            galleryCharacters: hasGallery ? [{
                name: result.characterName,
                provider: saucepanProvider,
                linkInfo: { providerId: 'saucepan', id: result.providerCharId },
                url: `https://saucepan.ai/companion/${result.providerCharId}`,
                avatar: result.fileName,
                galleryId: result.galleryId,
                cardData: result.cardData,
            }] : [],
            mediaCharacters: (mediaUrls.length > 0 || galleryPageUrls.length > 0) ? [{
                characterName: result.characterName,
                name: result.characterName,
                fileName: result.fileName,
                avatar: result.fileName,
                galleryId: result.galleryId,
                mediaUrls,
                galleryPageUrls,
                cardData: result.cardData,
            }] : [],
        };

        if (showSummary) {
            if (window.matchMedia?.('(max-width: 768px)').matches) {
                showImportSummaryModal(summaryArgs);
                await new Promise(r => setTimeout(r, 220));
                closePreviewModal();
            } else {
                closePreviewModal();
                await new Promise(r => requestAnimationFrame(r));
                showImportSummaryModal(summaryArgs);
            }
        } else {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
            await new Promise(r => setTimeout(r, 350));
            closePreviewModal();
        }

        showToast(`Imported "${result.characterName}"`, 'success');

        const added = await fetchAndAddCharacter(result.fileName);
        if (added) view.addCharToLookup(added);
        else await fetchCharacters(true);
        markCardAsImported(charId);
    } catch (err) {
        console.error('[SaucepanBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        setImportButtonState('import', hit);
    }
}

function markCardAsImported(charId) {
    const grid = document.getElementById('saucepanGrid');
    if (!grid) return;
    const card = grid.querySelector(`[data-saucepan-id="${CSS.escape(String(charId))}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        const imgWrap = card.querySelector('.browse-card-image');
        if (imgWrap) {
            imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = imgWrap.querySelector('.browse-feature-badges');
        }
    }
    if (badgesEl) {
        badgesEl.querySelector('.possible-library')?.remove();
        if (!badgesEl.querySelector('.in-library')) {
            badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
        }
    }
}

// ========================================
// AUTH UI
// ========================================

/**
 * Focus the Saucepan account section of the settings modal. The full auth UI
 * (handle/password login, token paste, validate/clear) already lives in the
 * settings modal (library.html / library.js), so this reuses it rather than
 * duplicating a login modal.
 */
function openSaucepanAuthUI() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.add('visible');
        requestAnimationFrame(() => {
            const tokenInput = document.getElementById('settingsSaucepanToken');
            const group = tokenInput?.closest('.settings-group') || tokenInput;
            group?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            document.getElementById('settingsSaucepanHandle')?.focus?.();
        });
    } else {
        showToast('Open Settings to configure your Saucepan account.', 'info');
    }
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initSaucepanView() {
    // Default ON: only an explicit `false` opts out of NSFW.
    saucepanNsfwEnabled = getSetting('saucepanNsfw') !== false;
    saucepanHideExtreme = getSetting('saucepanHideExtreme') === true;

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('saucepanSortSelect');
    if (sortEl) {
        sortEl.value = saucepanSortMode;
        CoreAPI.initCustomSelect?.(sortEl);
    }
    const creatorSortEl = document.getElementById('saucepanCreatorSortSelect');
    if (creatorSortEl) {
        creatorSortEl.value = saucepanCreatorSortMode;
        CoreAPI.initCustomSelect?.(creatorSortEl);
    }

    // Grid card click -> open preview / browse creator (delegation)
    const grid = document.getElementById('saucepanGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const handle = authorLink.dataset.creatorHandle || authorLink.dataset.author;
                if (handle) browseCreator(handle);
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.saucepanId;
            if (!charId) return;
            const hit = saucepanCharacters.find(c => String(getCharId(c)) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('saucepanSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    on('saucepanSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('saucepanClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !(e.target.value || '').trim());
    });
    on('saucepanSearchBtn', 'click', () => doSearch());
    on('saucepanClearSearchBtn', 'click', () => {
        const input = document.getElementById('saucepanSearchInput');
        const clearBtn = document.getElementById('saucepanClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        if (saucepanBrowseMode === 'creator') {
            clearCreatorFilter();
        } else if (saucepanSearchQuery) {
            saucepanSearchQuery = '';
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
    });

    // Creator search
    on('saucepanCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performCreatorSearch();
    });
    on('saucepanCreatorSearchBtn', 'click', () => performCreatorSearch());
    on('saucepanClearCreatorBtn', 'click', () => clearCreatorFilter());

    // Load more
    on('saucepanLoadMoreBtn', 'click', () => {
        if (saucepanIsLoading) return;
        if (saucepanBrowseMode === 'creator') saucepanCurrentOffset += PAGE_SIZE;
        else saucepanCurrentPage++;
        loadCharacters(true);
    });

    // Sort select
    on('saucepanSortSelect', 'change', () => {
        const el = document.getElementById('saucepanSortSelect');
        if (!el) return;
        if (saucepanBrowseMode === 'creator') {
            saucepanCreatorSortMode = el.value;
            const bannerSort = document.getElementById('saucepanCreatorSortSelect');
            if (bannerSort) bannerSort.value = el.value;
            // Re-sort the cached creator list in place.
            _saucepanCreatorFullList = [];
            saucepanCurrentOffset = 0;
            loadCharacters(false);
        } else {
            saucepanSortMode = el.value;
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
    });

    // Creator banner sort
    on('saucepanCreatorSortSelect', 'change', () => {
        const el = document.getElementById('saucepanCreatorSortSelect');
        if (!el) return;
        saucepanCreatorSortMode = el.value;
        const mainSort = document.getElementById('saucepanSortSelect');
        if (mainSort) mainSort.value = el.value;
        _saucepanCreatorFullList = [];
        saucepanCurrentOffset = 0;
        loadCharacters(false);
    });

    // NSFW toggle. In search mode `sus` is a server param, so re-query; creator
    // mode has no sus param, so re-render (renderGrid still filters client-side).
    on('saucepanNsfwToggle', 'click', () => {
        saucepanNsfwEnabled = !saucepanNsfwEnabled;
        setSetting('saucepanNsfw', saucepanNsfwEnabled);
        updateNsfwToggle();
        if (saucepanBrowseMode === 'creator') {
            renderGrid(saucepanCharacters, false);
        } else {
            saucepanCurrentPage = 1;
            loadCharacters(false);
        }
    });
    updateNsfwToggle();

    // Open-Definition toggle
    on('saucepanOpenDefToggle', 'click', () => {
        saucepanOpenDefinitionOnly = !saucepanOpenDefinitionOnly;
        updateOpenDefToggle();
        saucepanCurrentPage = 1;
        if (saucepanBrowseMode !== 'creator') loadCharacters(false);
    });
    updateOpenDefToggle();

    // Refresh
    on('saucepanRefreshBtn', 'click', () => {
        if (saucepanBrowseMode === 'creator') {
            _saucepanCreatorFullList = [];
            saucepanCurrentOffset = 0;
        } else {
            saucepanCurrentPage = 1;
        }
        loadCharacters(false);
    });

    // Filters dropdown toggle
    on('saucepanFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('saucepanTagsDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFandomsDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFiltersDropdown')?.classList.toggle('hidden');
    });

    // Filter checkboxes
    const filterCheckboxes = [
        { id: 'saucepanFilterHideOwned', setter: (v) => saucepanFilterHideOwned = v, getter: () => saucepanFilterHideOwned },
        { id: 'saucepanFilterHidePossible', setter: (v) => saucepanFilterHidePossible = v, getter: () => saucepanFilterHidePossible },
    ];
    filterCheckboxes.forEach(({ id, getter }) => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = getter();
    });
    updateFiltersButtonState();
    filterCheckboxes.forEach(({ id, setter }) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            setter(e.target.checked);
            updateFiltersButtonState();
            renderGrid(saucepanCharacters, false);
        });
    });

    // Hide-extreme is a SERVER filter (excluded_tags), so persist + re-query.
    const hideExtremeCb = document.getElementById('saucepanHideExtreme');
    if (hideExtremeCb) {
        hideExtremeCb.checked = saucepanHideExtreme;
        hideExtremeCb.addEventListener('change', (e) => {
            saucepanHideExtreme = e.target.checked;
            setSetting('saucepanHideExtreme', saucepanHideExtreme);
            if (saucepanBrowseMode !== 'creator') {
                saucepanCurrentPage = 1;
                loadCharacters(false);
            }
        });
    }

    // Tags dropdown toggle
    on('saucepanTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('saucepanFiltersDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFandomsDropdown')?.classList.add('hidden');
        const dropdown = document.getElementById('saucepanTagsDropdown');
        if (!dropdown) return;
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('saucepanTagsSearchInput');
            if (searchInput) searchInput.value = '';
            renderSaucepanTagsList();
            setTimeout(() => searchInput?.focus(), 50);
        }
    });
    on('saucepanTagsClearBtn', 'click', () => {
        const searchInput = document.getElementById('saucepanTagsSearchInput');
        if (searchInput) searchInput.value = '';
        saucepanActiveTags.clear();
        saucepanExcludedTags.clear();
        renderSaucepanTagsList();
        updateTagsButton();
        saucepanCurrentPage = 1;
        loadCharacters(false);
    });
    on('saucepanTagsSearchInput', 'input', () => {
        const q = document.getElementById('saucepanTagsSearchInput')?.value || '';
        renderSaucepanTagsList(q);
    });

    // Fandoms dropdown toggle (own dropdown; vocabulary is eager-loaded at init)
    on('saucepanFandomsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('saucepanFiltersDropdown')?.classList.add('hidden');
        document.getElementById('saucepanTagsDropdown')?.classList.add('hidden');
        const dropdown = document.getElementById('saucepanFandomsDropdown');
        if (!dropdown) return;
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('saucepanFandomsSearchInput');
            if (searchInput) searchInput.value = '';
            renderSaucepanFandomsList();
            // Prefetched at init; re-render once loaded in case that fetch is still in flight.
            ensureSaucepanFandomsLoaded().then(() => {
                if (!dropdown.classList.contains('hidden')) {
                    renderSaucepanFandomsList(searchInput?.value || '');
                }
            });
            setTimeout(() => searchInput?.focus(), 50);
        }
    });
    on('saucepanFandomsClearBtn', 'click', () => {
        const searchInput = document.getElementById('saucepanFandomsSearchInput');
        if (searchInput) searchInput.value = '';
        saucepanActiveFandoms.clear();
        saucepanExcludedFandoms.clear();
        renderSaucepanFandomsList();
        updateFandomsButton();
        saucepanCurrentPage = 1;
        loadCharacters(false);
    });
    on('saucepanFandomsSearchInput', 'input', () => {
        const q = document.getElementById('saucepanFandomsSearchInput')?.value || '';
        renderSaucepanFandomsList(q);
    });

    // Dropdown dismiss (click outside)
    view._registerDropdownDismiss([
        { dropdownId: 'saucepanTagsDropdown', buttonId: 'saucepanTagsBtn' },
        { dropdownId: 'saucepanFandomsDropdown', buttonId: 'saucepanFandomsBtn' },
        { dropdownId: 'saucepanFiltersDropdown', buttonId: 'saucepanFiltersBtn' },
    ]);

    // Eager-load the fandom vocabulary so the Fandoms dropdown opens populated
    // immediately (like Tags), instead of showing "Loading fandoms…" on first open.
    ensureSaucepanFandomsLoaded().then(() => renderSaucepanFandomsList());
    updateFandomsButton();

    ensureModalEventsAttached();
    debugLog('Saucepan view initialized');
}

function ensureModalEventsAttached() {
    if (modalEventsAttached) return;
    if (!document.getElementById('saucepanCharModal')) return;
    modalEventsAttached = true;

    const overlay = document.getElementById('saucepanCharModal');
    BrowseView.wireTitleScroll(document.getElementById('saucepanCharName'), overlay, overlay?.querySelector('.browse-char-modal'));

    on('saucepanCharClose', 'click', () => closePreviewModal());

    const galleryGrid = document.getElementById('saucepanCharGalleryGrid');
    if (galleryGrid) {
        galleryGrid.addEventListener('click', (e) => {
            if (e.target.classList.contains('browse-gallery-thumb')) {
                const thumbs = [...galleryGrid.querySelectorAll('.browse-gallery-thumb')];
                const urls = thumbs.map(t => t.src);
                const idx = thumbs.indexOf(e.target);
                BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
            }
        });
    }

    const creatorLink = document.getElementById('saucepanCharCreator');
    if (creatorLink) {
        creatorLink.addEventListener('click', (e) => {
            e.preventDefault();
            const handle = getCreatorName(saucepanSelectedChar);
            if (handle) {
                closePreviewModal();
                browseCreator(handle);
            }
        });
    }

    // Desktop only; on mobile bail before stopPropagation so the delegated tap runs.
    const avatar = document.getElementById('saucepanCharAvatar');
    if (avatar) {
        avatar.addEventListener('click', (e) => {
            if (isMobileMode()) return;
            e.stopPropagation();
            if (!avatar.src || avatar.src.endsWith('/img/ai4.png')) return;
            BrowseView.openAvatarViewer(avatar.src);
        });
    }

    on('saucepanImportBtn', 'click', () => {
        const importBtn = document.getElementById('saucepanImportBtn');
        if (importBtn?.dataset.authNeeded) {
            openSaucepanAuthUI();
            return;
        }
        if (saucepanSelectedChar) importSaucepanCharacter(saucepanSelectedChar);
    });

    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closePreviewModal();
        });
    }

    window.registerOverlay?.({ id: 'saucepanCharModal', tier: 7, close: () => closePreviewModal() });
    window.registerOverlay?.({ id: 'saucepanCreatorBanner', tier: 9, close: () => clearCreatorFilter() });
}

// Expose preview opener on window for parity with datacat (used by link modal).
window.openSaucepanCharPreview = function (char) {
    openPreviewModal(char);
};

// ========================================
// BROWSE VIEW CLASS
// ========================================

class SaucepanBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    // -- Library lookup contract --

    _extractProviderIds(char, idSet) {
        const ext = char.data?.extensions || char.extensions;
        const sp = ext?.saucepan;
        if (sp?.id) idSet.add(String(sp.id));
        // Back-compat: cards imported while Saucepan lived inside DataCat carry
        // extensions.datacat with sourceKind === 'saucepan'.
        const dc = ext?.datacat;
        if (dc?.id && dc.sourceKind === 'saucepan') idSet.add(String(dc.id));
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.saucepanId;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const creatorEl = card.querySelector('.browse-card-creator-link');
            const creatorName = creatorEl?.dataset.author || creatorEl?.textContent || '';
            return isCharInLocalLibrary({ character_id: id, name, creator_name: creatorName });
        }, ['saucepanGrid']);
    }

    // -- Mobile / registry contract --

    get previewModalId() { return 'saucepanCharModal'; }

    closePreview() { closePreviewModal(); }

    _getImageGridIds() { return ['saucepanGrid']; }

    get mobileFilterIds() {
        return {
            sort: 'saucepanSortSelect',
            tags: 'saucepanTagsBtn',
            fandoms: 'saucepanFandomsBtn',
            filters: 'saucepanFiltersBtn',
            nsfw: 'saucepanNsfwToggle',
            refresh: 'saucepanRefreshBtn',
        };
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'saucepan_new', label: 'New' },
                { value: 'saucepan_trending', label: 'Trending' },
                { value: 'saucepan_popular', label: 'Popular' },
            ],
            followingSortOptions: [],
            viewModes: [],
        };
    }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'saucepanCreatorSearchInput' : 'saucepanSearchInput';
    }
    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Saucepan creator handle...' : 'Search Saucepan or paste a URL...';
    }

    // -- Infinite scroll --

    canLoadMore() {
        return saucepanHasMore && !saucepanIsLoading;
    }

    loadMore() {
        if (saucepanIsLoading) return;
        if (saucepanBrowseMode === 'creator') saucepanCurrentOffset += PAGE_SIZE;
        else saucepanCurrentPage++;
        loadCharacters(true);
    }

    // -- Filter Bar --

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="saucepanSortSelect" class="glass-select" title="Sort order">
                    ${buildSortOptionsHtml(saucepanSortMode)}
                </select>
            </div>

            <!-- Tags -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="saucepanTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="saucepanTagsBtnLabel">Tags</span>
                </button>
                <div id="saucepanTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="saucepanTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="saucepanTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="saucepanTagsList"></div>
                </div>
            </div>

            <!-- Fandoms -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="saucepanFandomsBtn" class="glass-btn" title="Fandom (franchise) filters">
                    <i class="fa-solid fa-masks-theater"></i> <span id="saucepanFandomsBtnLabel">Fandoms</span>
                </button>
                <div id="saucepanFandomsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="saucepanFandomsSearchInput" placeholder="Search fandoms..." autocomplete="one-time-code">
                        <button id="saucepanFandomsClearBtn" class="glass-btn icon-only" title="Clear all fandom filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="saucepanFandomsList"></div>
                </div>
            </div>

            <!-- Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="saucepanFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="saucepanFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 260px;">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="saucepanFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="saucepanFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                    <div class="dropdown-section-title">Content:</div>
                    <label class="filter-checkbox" title="Exclude gore, noncon, self-harm and other extreme-content tags (Saucepan's default content-warning list)"><input type="checkbox" id="saucepanHideExtreme"> <i class="fa-solid fa-triangle-exclamation" style="color: #e06c6c;"></i> Hide Extreme Content</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="saucepanNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Open-Definition toggle -->
            <button id="saucepanOpenDefToggle" class="glass-btn active" title="Showing only open-definition characters">
                <i class="fa-solid fa-lock-open"></i> <span>Open Defs</span>
            </button>

            <!-- Refresh -->
            <button id="saucepanRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // -- Main View --

    renderView() {
        return `
            <div id="saucepanBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="saucepanSearchInput" placeholder="Search Saucepan or paste a companion URL..." autocomplete="one-time-code">
                        <button id="saucepanClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="saucepanSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="saucepanCreatorSearchInput" placeholder="Creator handle or URL..." autocomplete="one-time-code">
                            <button id="saucepanCreatorSearchBtn" class="browse-search-submit" title="Browse a creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator Banner -->
                <div id="saucepanCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-bowl-food"></i>
                        <span>Browsing characters by <strong id="saucepanCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="saucepanCreatorSortSelect" class="glass-select" title="Sort creator's characters">
                            ${CREATOR_SORT_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
                        </select>
                        <button id="saucepanClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="saucepanGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="saucepanLoadMore" style="display: none;">
                    <button id="saucepanLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // -- Modals --

    renderModals() {
        return `
    <div id="saucepanCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="saucepanCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="saucepanCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="saucepanCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to browse this creator's characters">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="saucepanOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on Saucepan">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="saucepanImportBtn" class="action-btn primary" title="Import to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="saucepanCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="saucepanCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-heart"></i>
                            <span id="saucepanCharFavorites">0</span> favorites
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-text-width"></i>
                            <span id="saucepanCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat" id="saucepanCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="saucepanCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="saucepanCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="saucepanCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="saucepanCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="saucepanCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading indicator -->
                <div id="saucepanCharDefinitionLoading" class="browse-char-section" style="display: none;">
                    <div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description (character body) -->
                <div class="browse-char-section" id="saucepanCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="saucepanCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="saucepanCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="saucepanCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Messages -->
                <div class="browse-char-section browse-section-collapsed" id="saucepanCharMesExampleSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharMesExample" data-label="Example Messages" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Messages
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="saucepanCharMesExample" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="saucepanCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="saucepanCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="saucepanCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="saucepanCharAltGreetingsCount"></span>
                    </h3>
                    <div id="saucepanCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery (Saucepan portraits) -->
                <div class="browse-char-section" id="saucepanCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="saucepanCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="saucepanCharGalleryLabel"></span>
                    </h3>
                    <div id="saucepanCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // -- Lifecycle --

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        initSaucepanView();
        const grid = document.getElementById('saucepanGrid');
        if (grid) {
            this.observeImages(grid);
            renderSkeletonGrid(grid);
        }
        loadCharacters(false);
    }

    applyDefaults(defaults) {
        if (defaults?.sort) {
            saucepanSortMode = defaults.sort;
            const el = document.getElementById('saucepanSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            saucepanBrowseMode = 'recent';
            saucepanSelectedChar = null;
            saucepanCharacters = [];
            saucepanCurrentPage = 1;
            saucepanCurrentOffset = 0;
            saucepanTotalPages = 0;
            saucepanHasMore = true;
            saucepanIsLoading = false;
            saucepanGridRenderedCount = 0;
            saucepanCreatorHandle = '';
            saucepanCreatorName = '';
            _saucepanCreatorFullList = [];
            saucepanCreatorSortMode = 'chat_count';
            saucepanSearchQuery = '';
            saucepanSortMode = 'saucepan_new';
            saucepanActiveTags.clear();
            saucepanExcludedTags.clear();
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized) {
            // Re-entry without DOM rebuild: refresh lookup + re-observe images.
            delegatesInitialized = true;
            this.buildLocalLibraryLookup();
            this.reconnectImageObserver();
            const grid = document.getElementById('saucepanGrid');
            if (grid && grid.children.length === 0 && saucepanCharacters.length > 0) {
                saucepanGridRenderedCount = 0;
                renderGrid(saucepanCharacters, false);
            }
        }
    }

    deactivate() {
        saucepanDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }

    closeDropdowns() {
        document.getElementById('saucepanTagsDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFandomsDropdown')?.classList.add('hidden');
        document.getElementById('saucepanFiltersDropdown')?.classList.add('hidden');
    }

    // -- Provider-facing hooks --

    /**
     * Open the preview modal for an in-app preview object built by the provider
     * (buildPreviewObject -> { id, name, description, avatar, tags, is_nsfw, creator_name }).
     */
    openPreview(previewChar) {
        if (!previewChar) return;
        // Live companion detail available -> full hit with real stats/portraits/tags.
        if (previewChar._companion) {
            openPreviewModal(hitFromCompanion(previewChar._companion, previewChar.id));
            return;
        }
        // Local fallback: build a minimal hit from the imported card.
        const hit = {
            character_id: previewChar.id,
            id: previewChar.id,
            name: previewChar.name || 'Unknown',
            avatar: previewChar.avatar || '',
            description: previewChar.description || '',
            tags: Array.isArray(previewChar.tags) ? previewChar.tags : [],
            creator_name: previewChar.creator_name || '',
            creator_id: previewChar.creator_id || '',
            isNsfw: !!previewChar.is_nsfw,
            primary_content_source_kind: 'saucepan',
            _source: 'saucepan',
        };
        openPreviewModal(hit);
    }

    /** Open the Saucepan account section of the settings modal. */
    openAuthUI() {
        openSaucepanAuthUI();
    }
}

const saucepanBrowseView = new SaucepanBrowseView();
export default saucepanBrowseView;
