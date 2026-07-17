// ==UserScript==
// @name         Link Garden
// @namespace    https://mbparks.com/fieldinstruments
// @version      2.0.1
// @description  Turn saved links into a living atlas with multiple gardens, snapshots, read-only sharing, maps, long-range reports, cultivation tools, history, bookmark migration, and ambient ecology.
// @author       Michael Parks
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const APP_NAME = 'Link Garden';
  const VERSION = '2.0.1';
  const STORAGE_KEY = 'linkGarden.v1';
  const DAY = 86_400_000;

  const uid = () => `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => Date.now();

  const DEFAULT_STATE = {
    schema: 7,
    links: [],
    beds: [
      { id: 'bed_wild', name: 'Wild Bed', createdAt: Date.now() },
      { id: 'bed_reference', name: 'Reference', createdAt: Date.now() }
    ],
    settings: {
      theme: 'auto',
      sort: 'vitality',
      selectedBed: 'all',
      search: '',
      view: 'garden',
      journalRange: '30',
      journalFilter: 'all',
      importFolderMode: 'leaf',
      importDuplicateMode: 'skip',
      importApplySuggestions: true,
      ecologyEnabled: true,
      ecologySeason: 'auto',
      ecologyHemisphere: 'north',
      ecologyTime: 'auto',
      ecologyWeather: 'auto',
      ecologyPollinators: true,
      ecologyMotion: true,
      cultivationStrategy: 'species',
      atlasRange: '365'
    },
    meta: {
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    atlas: {
      activeGardenId: 'garden_primary',
      gardens: [{ id: 'garden_primary', name: 'My Garden', description: 'The original Link Garden.', emoji: '🌿', createdAt: Date.now(), updatedAt: Date.now() }],
      gardenData: {},
      snapshots: []
    }
  };

  let state = loadState();
  let saveTimer = null;
  let currentCanonicalUrl = canonicalize(location.href);
  let currentLinkId = null;
  let shadow;
  let panel;
  let launcher;
  let saveDot;
  let saveText;
  let toastTimer;
  let checkingDeadLinks = false;
  let pendingBookmarkImport = null;
  let selectedLinkIds = new Set();
  let ecologyClock = null;
  const undoStack = [];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function loadState() {
    try {
      const stored = GM_getValue(STORAGE_KEY, null);
      if (!stored) return clone(DEFAULT_STATE);
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return migrateState(parsed);
    } catch (error) {
      console.warn('[Link Garden] Could not load saved data.', error);
      return clone(DEFAULT_STATE);
    }
  }

  function normalizeGardenDataset(input = {}) {
    const next = { ...clone(DEFAULT_STATE), ...(input || {}) };
    delete next.atlas;
    next.links = Array.isArray(input?.links) ? input.links.map(normalizeLink) : [];
    next.beds = Array.isArray(input?.beds) && input.beds.length
      ? input.beds.map((bed) => ({
          id: String(bed.id || uid()),
          name: String(bed.name || 'Untitled Bed'),
          createdAt: Number(bed.createdAt || now())
        }))
      : clone(DEFAULT_STATE.beds);
    const validBedIds = new Set(next.beds.map((bed) => bed.id));
    const fallbackBedId = next.beds[0]?.id || 'bed_wild';
    next.links.forEach((link) => { if (!validBedIds.has(link.bedId)) link.bedId = fallbackBedId; });
    next.settings = { ...DEFAULT_STATE.settings, ...(input?.settings || {}) };
    if (!['garden', 'nursery', 'journal', 'atlas'].includes(next.settings.view)) next.settings.view = 'garden';
    if (!['30', '90', '365', 'all'].includes(String(next.settings.journalRange))) next.settings.journalRange = '30';
    if (!['all', 'visits', 'blooms', 'changes'].includes(next.settings.journalFilter)) next.settings.journalFilter = 'all';
    if (!['leaf', 'path', 'top', 'single'].includes(next.settings.importFolderMode)) next.settings.importFolderMode = 'leaf';
    if (!['skip', 'merge', 'keep'].includes(next.settings.importDuplicateMode)) next.settings.importDuplicateMode = 'skip';
    next.settings.importApplySuggestions = next.settings.importApplySuggestions !== false;
    next.settings.ecologyEnabled = next.settings.ecologyEnabled !== false;
    if (!['auto', 'spring', 'summer', 'autumn', 'winter'].includes(next.settings.ecologySeason)) next.settings.ecologySeason = 'auto';
    if (!['north', 'south'].includes(next.settings.ecologyHemisphere)) next.settings.ecologyHemisphere = 'north';
    if (!['auto', 'day', 'dusk', 'night'].includes(next.settings.ecologyTime)) next.settings.ecologyTime = 'auto';
    if (!['auto', 'clear', 'cloudy', 'rain', 'breeze'].includes(next.settings.ecologyWeather)) next.settings.ecologyWeather = 'auto';
    if (!['species', 'domain', 'tag'].includes(next.settings.cultivationStrategy)) next.settings.cultivationStrategy = 'species';
    if (!['90', '365', 'all'].includes(String(next.settings.atlasRange))) next.settings.atlasRange = '365';
    next.settings.ecologyPollinators = next.settings.ecologyPollinators !== false;
    next.settings.ecologyMotion = next.settings.ecologyMotion !== false;
    const validViews = new Set(['all', 'needs', 'mushrooms', 'archive', 'queue', 'rediscover', 'seedtray', 'recentblooms', 'repair', ...next.beds.map((bed) => bed.id)]);
    if (!validViews.has(next.settings.selectedBed)) next.settings.selectedBed = 'all';
    next.meta = { ...DEFAULT_STATE.meta, ...(input?.meta || {}) };
    return { links: next.links, beds: next.beds, settings: next.settings, meta: next.meta };
  }

  function normalizeGardenMeta(garden, fallbackId = uid()) {
    return {
      id: String(garden?.id || fallbackId),
      name: String(garden?.name || 'Untitled Garden').trim() || 'Untitled Garden',
      description: String(garden?.description || ''),
      emoji: String(garden?.emoji || '🌿').slice(0, 8),
      createdAt: Number(garden?.createdAt || now()),
      updatedAt: Number(garden?.updatedAt || now())
    };
  }

  function migrateState(input) {
    const activeData = normalizeGardenDataset(input || {});
    const sourceAtlas = input?.atlas && typeof input.atlas === 'object' ? input.atlas : null;
    let gardens = Array.isArray(sourceAtlas?.gardens) && sourceAtlas.gardens.length
      ? sourceAtlas.gardens.map((garden) => normalizeGardenMeta(garden))
      : [normalizeGardenMeta({ id: 'garden_primary', name: 'My Garden', description: 'The original Link Garden.', emoji: '🌿', createdAt: activeData.meta.createdAt, updatedAt: activeData.meta.updatedAt }, 'garden_primary')];
    const ids = new Set();
    gardens = gardens.filter((garden) => {
      if (ids.has(garden.id)) garden.id = uid();
      ids.add(garden.id);
      return true;
    });
    let activeGardenId = String(sourceAtlas?.activeGardenId || gardens[0].id);
    if (!gardens.some((garden) => garden.id === activeGardenId)) activeGardenId = gardens[0].id;
    const gardenData = {};
    gardens.forEach((garden) => {
      const raw = sourceAtlas?.gardenData?.[garden.id];
      gardenData[garden.id] = garden.id === activeGardenId
        ? clone(activeData)
        : normalizeGardenDataset(raw || {});
    });
    const snapshots = Array.isArray(sourceAtlas?.snapshots) ? sourceAtlas.snapshots.map((snapshot) => ({
      id: String(snapshot.id || uid()),
      gardenId: gardens.some((garden) => garden.id === snapshot.gardenId) ? String(snapshot.gardenId) : activeGardenId,
      name: String(snapshot.name || 'Garden snapshot'),
      note: String(snapshot.note || ''),
      createdAt: Number(snapshot.createdAt || now()),
      summary: snapshot.summary && typeof snapshot.summary === 'object' ? snapshot.summary : {},
      data: normalizeGardenDataset(snapshot.data || {})
    })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80) : [];
    return {
      ...activeData,
      schema: 7,
      atlas: { activeGardenId, gardens, gardenData, snapshots }
    };
  }

  function extractGardenData(source = state) {
    return {
      links: clone(source.links || []),
      beds: clone(source.beds || []),
      settings: clone(source.settings || DEFAULT_STATE.settings),
      meta: clone(source.meta || DEFAULT_STATE.meta)
    };
  }

  function activeGardenMeta() {
    return state.atlas?.gardens?.find((garden) => garden.id === state.atlas.activeGardenId) || state.atlas?.gardens?.[0] || normalizeGardenMeta({ id: 'garden_primary', name: 'My Garden' }, 'garden_primary');
  }

  function syncActiveGardenData() {
    if (!state.atlas) return;
    const id = state.atlas.activeGardenId;
    if (!id) return;
    state.atlas.gardenData[id] = extractGardenData();
    const meta = state.atlas.gardens.find((garden) => garden.id === id);
    if (meta) meta.updatedAt = state.meta.updatedAt || now();
  }

  function atlasGardenRecords() {
    return state.atlas.gardens.map((meta) => ({
      meta,
      data: meta.id === state.atlas.activeGardenId ? extractGardenData() : normalizeGardenDataset(state.atlas.gardenData[meta.id] || {})
    }));
  }

  function stableFraction(seed, offset = 0) {
    const text = `${seed}:${offset}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 10000) / 10000;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeLink(link) {
    const url = String(link.url || '');
    const id = String(link.id || uid());
    const rawX = Number(link.gardenX);
    const rawY = Number(link.gardenY);
    const normalized = {
      id,
      url,
      canonicalUrl: canonicalize(link.canonicalUrl || url),
      title: String(link.title || safeHost(url) || 'Untitled Link'),
      bedId: String(link.bedId || 'bed_wild'),
      notes: String(link.notes || ''),
      tags: Array.isArray(link.tags) ? link.tags.map(String) : [],
      createdAt: Number(link.createdAt || now()),
      lastVisited: Number(link.lastVisited || 0),
      previousVisited: Number(link.previousVisited || 0),
      visits: Math.max(0, Number(link.visits || 0)),
      dead: Boolean(link.dead),
      archived: Boolean(link.archived),
      statusCode: Number(link.statusCode || 0),
      lastChecked: Number(link.lastChecked || 0),
      bloomUntil: Number(link.bloomUntil || 0),
      gardenX: Number.isFinite(rawX) ? clamp(rawX, 7, 93) : 9 + stableFraction(id, 1) * 82,
      gardenY: Number.isFinite(rawY) ? clamp(rawY, 12, 86) : 16 + stableFraction(id, 2) * 62,
      speciesOverride: String(link.speciesOverride || ''),
      importedAt: Math.max(0, Number(link.importedAt || 0)),
      importSource: String(link.importSource || ''),
      importPath: Array.isArray(link.importPath) ? link.importPath.map(String) : [],
      events: [],
      snapshots: [],
      lastHealth: String(link.lastHealth || ''),
      queueState: ['queued', 'done'].includes(String(link.queueState)) ? String(link.queueState) : 'none',
      queuePriority: clamp(Number(link.queuePriority || 2), 1, 3),
      queuedAt: Math.max(0, Number(link.queuedAt || 0)),
      queueCompletedAt: Math.max(0, Number(link.queueCompletedAt || 0)),
      repairedAt: Math.max(0, Number(link.repairedAt || 0)),
      previousUrl: String(link.previousUrl || '')
    };
    normalized.events = normalizeEvents(link.events, normalized);
    normalized.snapshots = normalizeSnapshots(link.snapshots, normalized);
    normalized.lastHealth = normalized.lastHealth || plantProfile(normalized).health;
    return normalized;
  }

  function normalizeEvents(events, link) {
    if (Array.isArray(events) && events.length) {
      return events.map((event) => ({
        id: String(event.id || uid()),
        type: String(event.type || 'note'),
        at: Number(event.at || now()),
        label: String(event.label || ''),
        detail: String(event.detail || ''),
        count: Math.max(1, Number(event.count || 1)),
        from: String(event.from || ''),
        to: String(event.to || ''),
        bedId: String(event.bedId || ''),
        vitality: event.vitality == null ? null : (Number.isFinite(Number(event.vitality)) ? Number(event.vitality) : null),
        health: String(event.health || ''),
        synthetic: Boolean(event.synthetic)
      })).sort((a, b) => a.at - b.at).slice(-600);
    }
    const seeded = [{
      id: uid(), type: 'planted', at: link.createdAt, label: 'Planted in Link Garden', detail: '', count: 1,
      from: '', to: '', bedId: link.bedId, vitality: null, health: '', synthetic: false
    }];
    if (link.visits > 0 && link.lastVisited) {
      seeded.push({
        id: uid(), type: 'visit', at: link.lastVisited, label: link.visits === 1 ? 'First recorded visit' : `${link.visits} earlier visits imported`,
        detail: 'Historical total carried forward from an earlier Link Garden version.', count: link.visits,
        from: '', to: '', bedId: link.bedId, vitality: null, health: '', synthetic: true
      });
    }
    if (link.dead) {
      seeded.push({
        id: uid(), type: 'dead', at: link.lastChecked || now(), label: 'Became a mushroom', detail: link.statusCode ? `HTTP ${link.statusCode}` : '', count: 1,
        from: '', to: 'dead', bedId: link.bedId, vitality: -100, health: 'dead', synthetic: true
      });
    }
    return seeded.sort((a, b) => a.at - b.at);
  }

  function normalizeSnapshots(snapshots, link) {
    if (Array.isArray(snapshots) && snapshots.length) {
      return snapshots.map((snapshot) => ({
        at: Number(snapshot.at || now()),
        vitality: clamp(Number(snapshot.vitality || 0), -100, 110),
        health: String(snapshot.health || ''),
        visits: Math.max(0, Number(snapshot.visits || 0))
      })).sort((a, b) => a.at - b.at).slice(-370);
    }
    const points = [];
    if (link.lastVisited) {
      points.push({ at: link.lastVisited, vitality: vitalityAt(link, link.lastVisited), health: 'healthy', visits: link.visits });
    }
    points.push({ at: now(), vitality: vitalityAt(link, now()), health: plantProfile(link).health, visits: link.visits });
    return points;
  }

  function scheduleSave() {
    state.meta.updatedAt = now();
    syncActiveGardenData();
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        GM_setValue(STORAGE_KEY, JSON.stringify(state));
        setSaveStatus('saved');
      } catch (error) {
        console.error('[Link Garden] Save failed.', error);
        setSaveStatus('error');
      }
    }, 180);
  }

  function setSaveStatus(status) {
    if (!saveDot || !saveText) return;
    saveDot.dataset.status = status;
    saveText.textContent = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : 'Saved locally';
  }

  function canonicalize(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      parsed.hash = '';
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }
      if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      return parsed.toString();
    } catch {
      return String(rawUrl || '').trim();
    }
  }

  function safeHost(rawUrl) {
    try {
      return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDate(timestamp, fallback = 'Never') {
    if (!timestamp) return fallback;
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);
  }

  function relativeAge(timestamp) {
    if (!timestamp) return 'never visited';
    const days = Math.max(0, Math.floor((now() - timestamp) / DAY));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 730) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  }

  function bedName(bedId) {
    return state.beds.find((bed) => bed.id === bedId)?.name || 'Wild Bed';
  }

  function defaultBedId() {
    return state.beds[0]?.id || 'bed_wild';
  }

  function vitalityAt(link, at = now()) {
    if (link.dead) return -100;
    const anchor = link.lastVisited && link.lastVisited <= at ? link.lastVisited : (link.createdAt || at);
    const recencyDays = Math.max(0, (at - anchor) / DAY);
    const frequency = Math.min(60, Math.log2(link.visits + 1) * 14);
    const recency = Math.max(-55, 45 - recencyDays * 1.55);
    return Math.round(frequency + recency);
  }

  function vitality(link) {
    return vitalityAt(link, now());
  }

  function linkSpecies(link) {
    if (link.speciesOverride) return link.speciesOverride;
    const haystack = `${link.title} ${link.url} ${link.notes}`.toLowerCase();
    const host = safeHost(link.url).toLowerCase();
    if (/youtube|youtu\.be|vimeo|video|watch/.test(haystack)) return 'sunflower';
    if (/docs|documentation|manual|reference|wiki|specification|standard|readme/.test(haystack)) return 'tree';
    if (/github|gitlab|generator|calculator|tool|editor|dashboard|app\b|studio/.test(haystack)) return 'shrub';
    if (/substack|medium|blog|article|news|journal|essay/.test(haystack)) return 'flower';
    if (/twitter|x\.com|bluesky|mastodon|reddit|instagram|facebook|linkedin|social/.test(`${host} ${haystack}`)) return 'vine';
    if (/recipe|how to|guide|tutorial|learn|course/.test(haystack)) return 'herb';
    return 'wildflower';
  }

  function speciesEmoji(species, stage, blooming, health) {
    if (health === 'dead') return '🍄';
    if (health === 'wilted' || health === 'parched') return '🥀';
    if (stage === 'seed') return '🫘';
    if (stage === 'sprout') return '🌱';
    if (blooming) return species === 'tree' ? '🌸' : '🌺';
    return ({
      tree: stage === 'tree' ? '🌳' : '🌲',
      shrub: stage === 'tree' ? '🌳' : '🪴',
      sunflower: '🌻',
      flower: stage === 'tree' ? '🌺' : '🌼',
      vine: '🍃',
      herb: '🌿',
      wildflower: stage === 'tree' ? '🌸' : '🌷'
    })[species] || '🌿';
  }

  function plantProfile(link) {
    const ageDays = (now() - (link.lastVisited || link.createdAt || now())) / DAY;
    const blooming = link.bloomUntil > now() && !link.dead;
    const species = linkSpecies(link);

    if (link.dead) {
      return { stage: 'mushroom', species: 'mushroom', emoji: '🍄', label: 'Dead link', health: 'dead', blooming: false };
    }

    let stage;
    let label;
    if (link.visits >= 18) {
      stage = 'tree'; label = 'Canopy';
    } else if (link.visits >= 10) {
      stage = 'flowering'; label = 'Flourishing';
    } else if (link.visits >= 5) {
      stage = 'bush'; label = 'Established';
    } else if (link.visits >= 2) {
      stage = 'sprout'; label = 'Sprouting';
    } else {
      stage = 'seed'; label = 'Newly planted';
    }

    let health = 'healthy';
    if (ageDays > 60) health = 'parched';
    else if (ageDays > 28) health = 'wilted';
    else if (ageDays > 14) health = 'thirsty';

    if (blooming) {
      label = 'Blooming again';
      health = 'blooming';
    }

    return { stage, species, emoji: speciesEmoji(species, stage, blooming, health), label, health, blooming };
  }

  function plantScale(link) {
    return clamp(0.78 + Math.log2(link.visits + 1) * 0.12, 0.78, 1.42);
  }

  function recordEvent(link, type, details = {}, at = now()) {
    if (!Array.isArray(link.events)) link.events = [];
    const event = {
      id: uid(),
      type,
      at: Number(at || now()),
      label: String(details.label || ''),
      detail: String(details.detail || ''),
      count: Math.max(1, Number(details.count || 1)),
      from: String(details.from || ''),
      to: String(details.to || ''),
      bedId: String(details.bedId || link.bedId || ''),
      vitality: Number.isFinite(Number(details.vitality)) ? Number(details.vitality) : vitality(link),
      health: String(details.health || plantProfile(link).health),
      synthetic: Boolean(details.synthetic)
    };
    link.events.push(event);
    if (link.events.length > 600) link.events = link.events.slice(-600);
    return event;
  }

  function recordSnapshot(link, at = now(), force = false) {
    if (!Array.isArray(link.snapshots)) link.snapshots = [];
    const snapshot = { at, vitality: vitalityAt(link, at), health: plantProfile(link).health, visits: link.visits };
    const last = link.snapshots.at(-1);
    const sameDay = last && dateKey(last.at) === dateKey(at);
    if (sameDay && !force) link.snapshots[link.snapshots.length - 1] = snapshot;
    else link.snapshots.push(snapshot);
    if (link.snapshots.length > 370) link.snapshots = link.snapshots.slice(-370);
  }

  function sweepLifecycleEvents() {
    let changed = false;
    state.links.forEach((link) => {
      const profile = plantProfile(link);
      const previous = link.lastHealth || profile.health;
      if (previous !== profile.health) {
        recordEvent(link, 'health', {
          label: healthTransitionLabel(previous, profile.health),
          from: previous,
          to: profile.health,
          health: profile.health,
          vitality: vitality(link)
        });
        link.lastHealth = profile.health;
        recordSnapshot(link, now(), true);
        changed = true;
      }
      const lastSnapshot = link.snapshots?.at(-1);
      if (!lastSnapshot || dateKey(lastSnapshot.at) !== dateKey(now())) {
        recordSnapshot(link);
        changed = true;
      }
    });
    if (changed) scheduleSave();
  }

  function healthTransitionLabel(from, to) {
    if (to === 'blooming') return 'Burst into bloom';
    if (to === 'dead') return 'Became a mushroom';
    if (from === 'blooming' && to === 'healthy') return 'Bloom faded';
    if (to === 'healthy' && ['thirsty', 'wilted', 'parched', 'dead'].includes(from)) return 'Returned to health';
    if (to === 'thirsty') return 'Became thirsty';
    if (to === 'wilted') return 'Began to wilt';
    if (to === 'parched') return 'Became parched';
    return `Changed from ${from || 'unknown'} to ${to}`;
  }

  function dateKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function applyVisitToLink(link, title, visitedAt, announce = false) {
    const previous = link.lastVisited;
    const gapDays = previous ? (visitedAt - previous) / DAY : 0;
    recordSnapshot(link, visitedAt - 1, true);
    link.previousVisited = previous;
    link.lastVisited = visitedAt;
    link.visits += 1;
    link.title = title || link.title;
    const wasDead = link.dead;
    link.dead = false;
    link.archived = false;
    link.statusCode = 200;
    recordEvent(link, 'visit', {
      label: previous ? 'Revisited page' : 'First visit after planting',
      detail: previous ? `${Math.max(0, Math.floor(gapDays))} days since the previous visit.` : 'The planted page was opened.',
      count: 1,
      vitality: vitality(link),
      health: 'healthy'
    }, visitedAt);
    if (wasDead) recordEvent(link, 'revived', { label: 'Mushroom revived', detail: 'The page responded when revisited.', from: 'dead', to: 'healthy' }, visitedAt);
    if (gapDays >= 21) {
      link.bloomUntil = visitedAt + 3 * DAY;
      recordEvent(link, 'bloom', {
        label: 'Rediscovery bloom', detail: `Returned after ${Math.floor(gapDays)} days away.`, from: link.lastHealth, to: 'blooming', health: 'blooming'
      }, visitedAt);
      if (announce) setTimeout(() => showToast(`🌸 ${link.title} is blooming after ${Math.floor(gapDays)} days away.`), 700);
    }
    link.lastHealth = plantProfile(link).health;
    recordSnapshot(link, visitedAt, true);
  }

  function recordVisit(rawUrl, title = document.title) {
    const canonical = canonicalize(rawUrl);
    currentCanonicalUrl = canonical;
    const visitedAt = now();
    let changed = false;
    const activeLink = state.links.find((item) => item.canonicalUrl === canonical);
    currentLinkId = activeLink?.id || null;
    if (activeLink) {
      applyVisitToLink(activeLink, title, visitedAt, true);
      changed = true;
    }
    state.atlas?.gardens?.forEach((garden) => {
      if (garden.id === state.atlas.activeGardenId) return;
      const data = state.atlas.gardenData[garden.id];
      if (!data?.links) return;
      const link = data.links.find((item) => canonicalize(item.canonicalUrl || item.url) === canonical);
      if (!link) return;
      applyVisitToLink(link, title, visitedAt, false);
      data.meta = { ...(data.meta || {}), updatedAt: visitedAt };
      garden.updatedAt = visitedAt;
      changed = true;
    });
    if (changed) scheduleSave();
    updateLauncherState();
    if (panel?.dataset.open === 'true') render();
  }

  function installShadowStyles(root, cssText) {
    // Sites with strict Content Security Policies, including LinkedIn, can
    // reject inline <style> elements even inside a userscript Shadow DOM.
    // Constructable stylesheets are not inline page styles and keep the UI
    // fully isolated from the host site's CSS.
    try {
      const Sheet = document.defaultView?.CSSStyleSheet || globalThis.CSSStyleSheet;
      if (Sheet && 'adoptedStyleSheets' in root && typeof Sheet.prototype.replaceSync === 'function') {
        const sheet = new Sheet();
        sheet.replaceSync(cssText);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        return 'constructable';
      }
    } catch (error) {
      console.warn('[Link Garden] Constructable stylesheet unavailable; using fallback.', error);
    }

    try {
      const style = document.createElement('style');
      style.setAttribute('data-link-garden-styles', 'fallback');
      style.textContent = cssText;
      root.appendChild(style);
      return 'style-element';
    } catch (error) {
      console.error('[Link Garden] Could not install interface styles.', error);
      return 'failed';
    }
  }

  function initUI() {
    const existingHost = document.getElementById('link-garden-root');
    if (existingHost) existingHost.remove();

    const host = document.createElement('div');
    host.id = 'link-garden-root';
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const styleMode = installShadowStyles(shadow, CSS);

    const shell = document.createElement('div');
    shell.dataset.styleMode = styleMode;
    shell.className = 'lg-shell';
    shell.innerHTML = `
      <button class="lg-launcher" type="button" aria-label="Open Link Garden" title="Open Link Garden (Shift+G)">
        <span class="lg-launcher-plant">🌱</span>
        <span class="lg-launcher-badge" hidden></span>
      </button>
      <section class="lg-panel" data-open="false" aria-label="Link Garden">
        <div class="lg-app"></div>
      </section>
      <div class="lg-toast" role="status" aria-live="polite"></div>
    `;
    if (styleMode === 'failed') {
      shell.style.position = 'fixed';
      shell.style.right = '18px';
      shell.style.bottom = '18px';
      shell.style.zIndex = '2147483646';
      const fallbackLauncher = shell.querySelector('.lg-launcher');
      const fallbackPanel = shell.querySelector('.lg-panel');
      if (fallbackLauncher) {
        fallbackLauncher.style.cssText = 'width:58px;height:58px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:#356a43;color:white;font-size:28px;display:grid;place-items:center;box-shadow:0 10px 28px rgba(25,71,39,.35);';
      }
      if (fallbackPanel) fallbackPanel.style.display = 'none';
    }

    shadow.appendChild(shell);

    launcher = shell.querySelector('.lg-launcher');
    panel = shell.querySelector('.lg-panel');
    launcher.addEventListener('click', togglePanel);
    updateLauncherState();

    document.addEventListener('keydown', (event) => {
      if (event.shiftKey && event.key.toLowerCase() === 'g' && !isTypingTarget(event.target)) {
        event.preventDefault();
        togglePanel();
      }
      if (event.key === 'Escape' && panel.dataset.open === 'true') closePanel();
    });
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement && (
      target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    );
  }

  function updateLauncherState() {
    if (!launcher) return;
    const plant = launcher.querySelector('.lg-launcher-plant');
    const badge = launcher.querySelector('.lg-launcher-badge');
    const current = state.links.find((link) => link.canonicalUrl === currentCanonicalUrl);
    if (current) {
      plant.textContent = plantProfile(current).emoji;
      badge.hidden = false;
      badge.textContent = current.visits > 99 ? '99+' : String(current.visits);
      launcher.title = `${current.title} · ${current.visits} visits · Open Link Garden (Shift+G)`;
    } else {
      plant.textContent = '🌱';
      badge.hidden = true;
      launcher.title = 'Plant this page or open Link Garden (Shift+G)';
    }
  }

  function togglePanel() {
    panel.dataset.open === 'true' ? closePanel() : openPanel();
  }

  function openPanel() {
    panel.dataset.open = 'true';
    launcher.setAttribute('aria-expanded', 'true');
    render();
  }

  function closePanel() {
    panel.dataset.open = 'false';
    launcher.setAttribute('aria-expanded', 'false');
  }

  function render() {
    sweepLifecycleEvents();
    const root = shadow.querySelector('.lg-app');
    const visibleLinks = getVisibleLinks();
    const stats = getStats();
    const selectedBed = state.settings.selectedBed;
    const currentView = state.settings.view;
    const gardenView = currentView === 'garden';
    const nurseryView = currentView === 'nursery';
    const journalView = currentView === 'journal';
    const atlasView = currentView === 'atlas';
    const activeGarden = activeGardenMeta();

    selectedLinkIds = new Set([...selectedLinkIds].filter((id) => state.links.some((link) => link.id === id)));

    root.innerHTML = `
      <header class="lg-header">
        <div class="lg-brand">
          <div class="lg-brand-mark">🌿</div>
          <div>
            <div class="lg-title-row">
              <h1>${APP_NAME}</h1>
              <span class="lg-version">v${VERSION}</span>
            </div>
            <p>${escapeHTML(activeGarden.emoji)} ${escapeHTML(activeGarden.name)} · A living bookmark atlas</p>
          </div>
        </div>
        <div class="lg-header-actions">
          <div class="lg-save-state"><span class="lg-save-dot" data-status="saved"></span><span class="lg-save-text">Saved locally</span></div>
          <button class="lg-icon-button" data-action="undo" title="Undo last garden change" ${undoStack.length ? '' : 'disabled'}>↶</button>
          <button class="lg-icon-button" data-action="theme" title="Change theme">◐</button>
          <button class="lg-icon-button" data-action="close" title="Close">×</button>
        </div>
      </header>

      <div class="lg-toolbar">
        <button class="lg-primary" data-action="add-current">${currentLinkId ? '✓ Page planted' : '＋ Plant this page'}</button>
        <button data-action="add-link">＋ Add link</button>
        <button data-action="check-links" ${checkingDeadLinks ? 'disabled' : ''}>${checkingDeadLinks ? 'Checking…' : '☂ Check health'}</button>
        <button data-action="ecology" title="Season, time, weather, and ambient life">☀ Ecology</button>
        <button data-action="cultivate" title="Smart beds, reading queue, repair, and automatic grouping">✦ Cultivate</button>
        <div class="lg-view-switch" aria-label="Garden display">
          <button class="${gardenView ? 'is-active' : ''}" data-action="view-garden" title="Living garden view">🌿 Garden</button>
          <button class="${nurseryView ? 'is-active' : ''}" data-action="view-nursery" title="Card management view">▦ Nursery</button>
          <button class="${journalView ? 'is-active' : ''}" data-action="view-journal" title="Garden history and analytics">⌁ Journal</button>
          <button class="${atlasView ? 'is-active' : ''}" data-action="view-atlas" title="Multiple gardens, snapshots, maps, and long-range reports">⌘ Atlas</button>
        </div>
        <span class="lg-toolbar-spacer"></span>
        <button data-action="data-center" title="Share, back up, or import garden data">Data</button>
        <input class="lg-json-file-input" type="file" accept="application/json,.json" hidden>
        <input class="lg-bookmark-file-input" type="file" accept="text/html,.html,.htm" hidden>
      </div>

      <div class="lg-body">
        <aside class="lg-sidebar">
          <div class="lg-stats">
            <div><strong>${stats.total}</strong><span>plants</span></div>
            <div><strong>${stats.visits}</strong><span>visits</span></div>
            <div><strong>${stats.blooming}</strong><span>blooming</span></div>
            <div><strong>${stats.dead}</strong><span>mushrooms</span></div>
          </div>

          <div class="lg-section-title"><span>Garden atlas</span><button data-action="new-garden" title="Create another garden">＋</button></div>
          <div class="lg-atlas-switcher">
            <label><span>Active garden</span><select data-field="active-garden">${state.atlas.gardens.map((garden) => `<option value="${escapeHTML(garden.id)}" ${garden.id === state.atlas.activeGardenId ? 'selected' : ''}>${escapeHTML(garden.emoji)} ${escapeHTML(garden.name)}</option>`).join('')}</select></label>
            <div><button data-action="view-atlas">Open Atlas</button><button data-action="edit-garden" title="Edit active garden">✎</button></div>
          </div>

          <div class="lg-section-title"><span>Garden beds</span><button data-action="add-bed" title="Add garden bed">＋</button></div>
          <nav class="lg-bed-list">
            ${bedNavItem('all', 'Whole Garden', state.links.filter((link) => !link.archived).length, selectedBed === 'all', '🌎')}
            ${state.beds.map((bed) => bedNavItem(bed.id, bed.name, state.links.filter((link) => link.bedId === bed.id && !link.archived).length, selectedBed === bed.id, '▰', true)).join('')}
            ${bedNavItem('needs', 'Needs Attention', stats.needs, selectedBed === 'needs', '💧')}
            ${bedNavItem('mushrooms', 'Mushroom Patch', stats.dead, selectedBed === 'mushrooms', '🍄')}
            ${bedNavItem('archive', 'Compost Archive', stats.archived, selectedBed === 'archive', '♻')}
          </nav>
          <div class="lg-section-title lg-smart-title"><span>Smart beds</span><button data-action="cultivate" title="Open cultivation tools">✦</button></div>
          <nav class="lg-bed-list lg-smart-bed-list">
            ${bedNavItem('queue', 'Reading Queue', stats.queue, selectedBed === 'queue', '📚')}
            ${bedNavItem('rediscover', 'Rediscovery', stats.rediscover, selectedBed === 'rediscover', '🧭')}
            ${bedNavItem('seedtray', 'Seed Tray', stats.seedtray, selectedBed === 'seedtray', '🫘')}
            ${bedNavItem('recentblooms', 'Recent Blooms', stats.recentblooms, selectedBed === 'recentblooms', '🌺')}
            ${bedNavItem('repair', 'Repair Bench', stats.repair, selectedBed === 'repair', '🛠')}
          </nav>
          <div class="lg-sidebar-note">${atlasView ? 'The Atlas keeps several independent gardens in one local collection. Visits are recorded across every garden containing the current page.' : journalView ? 'The Journal records visits, blooms, imports, health changes, transplants, pruning, and archive activity. Earlier totals remain preserved as historical baselines.' : 'Smart beds gather plants automatically. Use Cultivate to organize the garden, recover useful compost, manage reading, rediscover old links, and repair mushrooms.'}</div>
        </aside>

        <main class="lg-main">
          <div class="lg-main-head">
            <div>
              <h2>${atlasView ? 'Garden Atlas' : journalView ? 'Garden Journal' : escapeHTML(selectedBedTitle())}</h2>
              <p>${atlasView ? `${state.atlas.gardens.length} named ${state.atlas.gardens.length === 1 ? 'garden' : 'gardens'} · snapshots, maps, and browsing ecology` : journalView ? `History and growth patterns for ${escapeHTML(selectedBedTitle())}` : `${visibleLinks.length} ${visibleLinks.length === 1 ? 'link' : 'links'} in view`}</p>
            </div>
            ${atlasView ? renderAtlasControls() : journalView ? renderJournalFilters() : `<div class="lg-filters">
              <label class="lg-search"><span>⌕</span><input data-field="search" value="${escapeHTML(state.settings.search)}" placeholder="Search plants, labels, or URLs"></label>
              <select data-field="sort" aria-label="Sort links">
                ${sortOption('vitality', 'Most alive')}
                ${sortOption('recent', 'Recently visited')}
                ${sortOption('frequent', 'Most visited')}
                ${sortOption('oldest', 'Most neglected')}
                ${sortOption('title', 'Title A–Z')}
              </select>
            </div>`}
          </div>

          ${nurseryView && selectedLinkIds.size ? renderBulkBar() : ''}
          ${atlasView
            ? renderAtlasView()
            : journalView
            ? renderJournalView()
            : visibleLinks.length
              ? gardenView ? renderGardenView(visibleLinks) : `<div class="lg-garden-grid">${visibleLinks.map(renderPlantCard).join('')}</div>`
              : renderEmptyState()}
        </main>
      </div>
      <div class="lg-dialog-layer"></div>
    `;

    saveDot = root.querySelector('.lg-save-dot');
    saveText = root.querySelector('.lg-save-text');
    bindUI(root);
    applyTheme();
  }

  function bedNavItem(id, name, count, active, icon, editable = false) {
    return `<div class="lg-bed-nav-row ${active ? 'is-active' : ''}">
      <button class="lg-bed-item" data-bed-id="${escapeHTML(id)}"><span>${icon}</span><b>${escapeHTML(name)}</b><em>${count}</em></button>
      ${editable ? `<button class="lg-bed-edit" data-action="edit-bed" data-id="${escapeHTML(id)}" title="Rename or remove ${escapeHTML(name)}">✎</button>` : ''}
    </div>`;
  }

  function selectedBedTitle() {
    if (state.settings.selectedBed === 'all') return 'Whole Garden';
    if (state.settings.selectedBed === 'needs') return 'Needs Attention';
    if (state.settings.selectedBed === 'mushrooms') return 'Mushroom Patch';
    if (state.settings.selectedBed === 'archive') return 'Compost Archive';
    if (state.settings.selectedBed === 'queue') return 'Reading Queue';
    if (state.settings.selectedBed === 'rediscover') return 'Rediscovery Bed';
    if (state.settings.selectedBed === 'seedtray') return 'Seed Tray';
    if (state.settings.selectedBed === 'recentblooms') return 'Recent Blooms';
    if (state.settings.selectedBed === 'repair') return 'Repair Bench';
    return bedName(state.settings.selectedBed);
  }

  function datasetStats(data) {
    const active = (data.links || []).filter((link) => !link.archived);
    const profiles = active.map(plantProfile);
    return {
      total: active.length,
      archived: (data.links || []).filter((link) => link.archived).length,
      visits: active.reduce((sum, link) => sum + Number(link.visits || 0), 0),
      blooms: active.reduce((sum, link) => sum + (link.events || []).filter((event) => event.type === 'bloom').reduce((count, event) => count + Number(event.count || 1), 0), 0),
      blooming: profiles.filter((profile) => profile.blooming).length,
      dead: active.filter((link) => link.dead).length,
      thriving: active.filter((link) => !link.dead && vitality(link) >= 35).length,
      beds: (data.beds || []).length,
      vitality: active.length ? Math.round(active.reduce((sum, link) => sum + vitality(link), 0) / active.length) : 0
    };
  }

  function renderAtlasControls() {
    return `<div class="lg-filters lg-atlas-controls">
      <select data-field="atlas-range" aria-label="Atlas report range">
        <option value="90" ${String(state.settings.atlasRange) === '90' ? 'selected' : ''}>Last 90 days</option>
        <option value="365" ${String(state.settings.atlasRange) === '365' ? 'selected' : ''}>Last year</option>
        <option value="all" ${String(state.settings.atlasRange) === 'all' ? 'selected' : ''}>All history</option>
      </select>
      <button data-action="create-snapshot">＋ Snapshot</button>
      <button data-action="new-garden">＋ Garden</button>
      <button data-action="share-garden">Share active</button>
    </div>`;
  }

  function atlasCutoff() {
    const range = String(state.settings.atlasRange || '365');
    if (range === 'all') return 0;
    return now() - Number(range) * DAY;
  }

  function atlasEvents(records = atlasGardenRecords()) {
    const cutoff = atlasCutoff();
    return records.flatMap(({ meta, data }) => (data.links || []).flatMap((link) => (link.events || [])
      .filter((event) => event.at >= cutoff)
      .map((event) => ({ ...event, gardenId: meta.id, gardenName: meta.name, gardenEmoji: meta.emoji, linkTitle: link.title, linkUrl: link.url }))));
  }

  function renderAtlasView() {
    const records = atlasGardenRecords();
    const summaries = records.map((record) => ({ ...record, stats: datasetStats(record.data) }));
    const totalPlants = summaries.reduce((sum, item) => sum + item.stats.total, 0);
    const totalVisits = summaries.reduce((sum, item) => sum + item.stats.visits, 0);
    const totalBlooms = summaries.reduce((sum, item) => sum + item.stats.blooms, 0);
    const mushrooms = summaries.reduce((sum, item) => sum + item.stats.dead, 0);
    const snapshots = state.atlas.snapshots.filter((snapshot) => snapshot.gardenId === state.atlas.activeGardenId);
    const activeRecord = summaries.find((item) => item.meta.id === state.atlas.activeGardenId) || summaries[0];
    return `<div class="lg-atlas-dashboard">
      <section class="lg-atlas-kpis">
        ${atlasKpi('⌘', summaries.length, summaries.length === 1 ? 'Named garden' : 'Named gardens', 'Independent collections in this atlas')}
        ${atlasKpi('🌿', totalPlants, 'Living plants', 'Across every non-archived garden')}
        ${atlasKpi('↻', totalVisits, 'Recorded visits', 'All-time visit totals across the atlas')}
        ${atlasKpi('🌸', totalBlooms, 'Rediscovery blooms', 'Returns after a long absence')}
        ${atlasKpi('🍄', mushrooms, 'Mushrooms', 'Dead links awaiting repair')}
        ${atlasKpi('◫', state.atlas.snapshots.length, 'Snapshots', 'Restorable garden moments')}
      </section>

      <section class="lg-atlas-section">
        <div class="lg-atlas-section-head"><div><h3>Atlas map</h3><p>Each card is an independent garden. Open one to cultivate it.</p></div><button data-action="new-garden">Create garden</button></div>
        <div class="lg-atlas-map">${summaries.map(renderAtlasGardenCard).join('')}</div>
      </section>

      <div class="lg-atlas-columns">
        <section class="lg-atlas-section lg-atlas-active-map">
          <div class="lg-atlas-section-head"><div><h3>${escapeHTML(activeRecord.meta.emoji)} ${escapeHTML(activeRecord.meta.name)}</h3><p>${escapeHTML(activeRecord.meta.description || 'The active garden, shown bed by bed.')}</p></div><button data-action="edit-garden">Edit garden</button></div>
          ${renderAtlasBedMap(activeRecord.data)}
        </section>
        <section class="lg-atlas-section">
          <div class="lg-atlas-section-head"><div><h3>Garden snapshots</h3><p>Freeze a restorable copy before a large cleanup or reorganization.</p></div><button data-action="create-snapshot">Take snapshot</button></div>
          <div class="lg-snapshot-list">${snapshots.length ? snapshots.slice(0, 8).map(renderSnapshotCard).join('') : `<div class="lg-atlas-empty"><span>◫</span><p>No snapshots of this garden yet.</p><button data-action="create-snapshot">Create the first snapshot</button></div>`}</div>
        </section>
      </div>

      <section class="lg-atlas-section">
        <div class="lg-atlas-section-head"><div><h3>Long-range browsing ecology</h3><p>How attention has moved among gardens during the selected period.</p></div><span class="lg-atlas-range-label">${state.settings.atlasRange === 'all' ? 'All recorded history' : `Last ${state.settings.atlasRange} days`}</span></div>
        ${renderAtlasReport(summaries)}
      </section>
    </div>`;
  }

  function atlasKpi(icon, value, label, detail) {
    return `<div class="lg-atlas-kpi"><span>${icon}</span><div><strong>${value}</strong><b>${escapeHTML(label)}</b><small>${escapeHTML(detail)}</small></div></div>`;
  }

  function renderAtlasGardenCard(record, index) {
    const { meta, data, stats } = record;
    const active = meta.id === state.atlas.activeGardenId;
    const bedPreview = (data.beds || []).slice(0, 5).map((bed) => {
      const plants = (data.links || []).filter((link) => !link.archived && link.bedId === bed.id).slice(0, 8);
      return `<div class="lg-atlas-mini-bed" title="${escapeHTML(bed.name)}"><b>${escapeHTML(bed.name)}</b><span>${plants.length ? plants.map((link) => plantProfile(link).emoji).join('') : '·'}</span></div>`;
    }).join('');
    return `<article class="lg-atlas-garden-card ${active ? 'is-active' : ''}" style="--atlas-order:${index}">
      <header><span class="lg-atlas-garden-icon">${escapeHTML(meta.emoji)}</span><div><h4>${escapeHTML(meta.name)}</h4><p>${escapeHTML(meta.description || 'A garden in the Link Garden Atlas.')}</p></div>${active ? '<em>Active</em>' : ''}</header>
      <div class="lg-atlas-mini-map">${bedPreview || '<div class="lg-atlas-mini-bed"><b>Empty garden</b><span>🌱</span></div>'}</div>
      <div class="lg-atlas-card-stats"><span><b>${stats.total}</b> plants</span><span><b>${stats.visits}</b> visits</span><span><b>${stats.blooms}</b> blooms</span><span><b>${stats.dead}</b> mushrooms</span></div>
      <footer><small>Updated ${relativeAge(meta.updatedAt)}</small><button class="${active ? 'lg-primary' : ''}" data-action="switch-garden" data-id="${escapeHTML(meta.id)}">${active ? 'Open garden' : 'Visit garden'}</button></footer>
    </article>`;
  }

  function renderAtlasBedMap(data) {
    const beds = data.beds || [];
    const activeLinks = (data.links || []).filter((link) => !link.archived);
    if (!beds.length) return '<div class="lg-atlas-empty"><span>🌱</span><p>This garden has no beds yet.</p></div>';
    return `<div class="lg-atlas-bed-map">${beds.map((bed) => {
      const links = activeLinks.filter((link) => link.bedId === bed.id);
      return `<div class="lg-atlas-bed-row"><div><strong>${escapeHTML(bed.name)}</strong><small>${links.length} ${links.length === 1 ? 'plant' : 'plants'}</small></div><div class="lg-atlas-bed-plants">${links.length ? links.slice(0, 22).map((link) => `<span title="${escapeHTML(link.title)} · ${plantProfile(link).label}">${plantProfile(link).emoji}</span>`).join('') : '<i>fresh soil</i>'}${links.length > 22 ? `<em>+${links.length - 22}</em>` : ''}</div></div>`;
    }).join('')}</div>`;
  }

  function renderSnapshotCard(snapshot) {
    const summary = snapshot.summary || datasetStats(snapshot.data);
    return `<article class="lg-snapshot-card"><div><strong>◫ ${escapeHTML(snapshot.name)}</strong><p>${escapeHTML(snapshot.note || `${summary.total || 0} plants · ${summary.visits || 0} visits`)}</p><small>${formatDate(snapshot.createdAt)} · ${relativeAge(snapshot.createdAt)}</small></div><div><button data-action="restore-snapshot" data-id="${escapeHTML(snapshot.id)}">Restore</button><button class="lg-danger-text" data-action="delete-snapshot" data-id="${escapeHTML(snapshot.id)}">Delete</button></div></article>`;
  }

  function renderAtlasReport(summaries) {
    const events = atlasEvents(summaries);
    const visitsByGarden = new Map(summaries.map((item) => [item.meta.id, 0]));
    const bloomsByGarden = new Map(summaries.map((item) => [item.meta.id, 0]));
    events.forEach((event) => {
      if (event.type === 'visit') visitsByGarden.set(event.gardenId, (visitsByGarden.get(event.gardenId) || 0) + Number(event.count || 1));
      if (event.type === 'bloom') bloomsByGarden.set(event.gardenId, (bloomsByGarden.get(event.gardenId) || 0) + Number(event.count || 1));
    });
    const maxVisits = Math.max(1, ...visitsByGarden.values());
    const months = atlasMonthlyActivity(events);
    const mostVisited = summaries.flatMap(({ meta, data }) => (data.links || []).filter((link) => !link.archived).map((link) => ({ ...link, gardenName: meta.name, gardenEmoji: meta.emoji }))).sort((a, b) => b.visits - a.visits).slice(0, 6);
    const domainMap = new Map();
    summaries.forEach(({ data }) => (data.links || []).filter((link) => !link.archived).forEach((link) => domainMap.set(rootDomain(link.url), (domainMap.get(rootDomain(link.url)) || 0) + link.visits)));
    const domains = [...domainMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return `<div class="lg-atlas-report">
      <div class="lg-atlas-report-card"><h4>Attention by garden</h4><div class="lg-atlas-bars">${summaries.map(({ meta, stats }) => {
        const visits = visitsByGarden.get(meta.id) || 0;
        return `<div class="lg-atlas-bar-row"><span>${escapeHTML(meta.emoji)} ${escapeHTML(meta.name)}</span><div><i style="width:${Math.max(visits ? 4 : 0, Math.round((visits / maxVisits) * 100))}%"></i></div><b>${visits}</b><small>${bloomsByGarden.get(meta.id) || 0} blooms · ${stats.vitality} avg vitality</small></div>`;
      }).join('')}</div></div>
      <div class="lg-atlas-report-card"><h4>Monthly return rhythm</h4><div class="lg-atlas-months">${months.map((month) => `<div title="${escapeHTML(month.label)} · ${month.visits} visits"><i style="height:${month.height}%"></i><span>${escapeHTML(month.short)}</span><b>${month.visits}</b></div>`).join('')}</div></div>
      <div class="lg-atlas-report-card"><h4>Most cultivated plants</h4><div class="lg-atlas-ranked">${mostVisited.length ? mostVisited.map((link, index) => `<div><b>${index + 1}</b><span>${plantProfile(link).emoji}</span><p><strong>${escapeHTML(link.title)}</strong><small>${escapeHTML(link.gardenEmoji)} ${escapeHTML(link.gardenName)}</small></p><em>${link.visits}</em></div>`).join('') : '<p class="lg-muted">Visits will appear here as the atlas grows.</p>'}</div></div>
      <div class="lg-atlas-report-card"><h4>Domain canopy</h4><div class="lg-atlas-ranked">${domains.length ? domains.map(([domain, visits], index) => `<div><b>${index + 1}</b><span>⌂</span><p><strong>${escapeHTML(domain)}</strong><small>Across every garden</small></p><em>${visits}</em></div>`).join('') : '<p class="lg-muted">No domain activity is recorded yet.</p>'}</div></div>
    </div>`;
  }

  function atlasMonthlyActivity(events) {
    const months = [];
    const date = new Date();
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    for (let offset = 11; offset >= 0; offset -= 1) {
      const start = new Date(date.getFullYear(), date.getMonth() - offset, 1).getTime();
      const end = new Date(date.getFullYear(), date.getMonth() - offset + 1, 1).getTime();
      const visits = events.filter((event) => event.type === 'visit' && event.at >= start && event.at < end).reduce((sum, event) => sum + Number(event.count || 1), 0);
      const d = new Date(start);
      months.push({ start, visits, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), short: d.toLocaleDateString(undefined, { month: 'short' }) });
    }
    const max = Math.max(1, ...months.map((month) => month.visits));
    return months.map((month) => ({ ...month, height: Math.max(month.visits ? 8 : 2, Math.round((month.visits / max) * 100)) }));
  }

  function renderBulkBar() {
    return `<div class="lg-bulk-bar">
      <strong>${selectedLinkIds.size} selected</strong>
      <button data-action="bulk-transplant">Transplant</button>
      <button data-action="bulk-archive">${state.settings.selectedBed === 'archive' ? 'Restore' : 'Compost'}</button>
      <button data-action="clear-selection">Clear</button>
    </div>`;
  }

  function sortOption(value, label) {
    return `<option value="${value}" ${state.settings.sort === value ? 'selected' : ''}>${label}</option>`;
  }

  function getVisibleLinks() {
    const query = state.settings.search.trim().toLowerCase();
    const selected = state.settings.selectedBed;
    let links = state.links.filter((link) => {
      if (selected === 'archive') {
        if (!link.archived) return false;
      } else {
        if (link.archived) return false;
        if (selected === 'mushrooms' && !link.dead) return false;
        if (selected === 'needs' && !(link.dead || ['thirsty', 'wilted', 'parched'].includes(plantProfile(link).health))) return false;
        if (selected === 'queue' && link.queueState !== 'queued') return false;
        if (selected === 'rediscover' && !isRediscoveryCandidate(link)) return false;
        if (selected === 'seedtray' && (link.dead || link.visits !== 0)) return false;
        if (selected === 'recentblooms' && !isRecentBloom(link)) return false;
        if (selected === 'repair' && !link.dead) return false;
        if (!['all', 'mushrooms', 'needs', 'queue', 'rediscover', 'seedtray', 'recentblooms', 'repair'].includes(selected) && link.bedId !== selected) return false;
      }
      if (!query) return true;
      return [link.title, link.url, link.notes, bedName(link.bedId), linkSpecies(link), queuePriorityLabel(link.queuePriority), ...link.tags].join(' ').toLowerCase().includes(query);
    });

    const sorters = {
      vitality: (a, b) => vitality(b) - vitality(a) || b.visits - a.visits,
      recent: (a, b) => b.lastVisited - a.lastVisited,
      frequent: (a, b) => b.visits - a.visits || b.lastVisited - a.lastVisited,
      oldest: (a, b) => (a.lastVisited || a.createdAt) - (b.lastVisited || b.createdAt),
      title: (a, b) => a.title.localeCompare(b.title),
      queue: (a, b) => b.queuePriority - a.queuePriority || a.queuedAt - b.queuedAt
    };
    const forcedSorter = selected === 'queue' ? sorters.queue : selected === 'rediscover' || selected === 'seedtray' ? sorters.oldest : null;
    return [...links].sort(forcedSorter || sorters[state.settings.sort] || sorters.vitality);
  }

  function getStats() {
    const active = state.links.filter((link) => !link.archived);
    const profiles = active.map(plantProfile);
    const smart = smartBedCounts();
    return {
      total: active.length,
      thriving: active.filter((link) => !link.dead && vitality(link) >= 35).length,
      visits: active.reduce((sum, link) => sum + link.visits, 0),
      blooming: profiles.filter((profile) => profile.blooming).length,
      dead: active.filter((link) => link.dead).length,
      needs: active.filter((link) => link.dead || ['thirsty', 'wilted', 'parched'].includes(plantProfile(link).health)).length,
      archived: state.links.filter((link) => link.archived).length,
      ...smart
    };
  }

  function isRediscoveryCandidate(link) {
    if (link.archived || link.dead || link.queueState === 'done') return false;
    const age = (now() - (link.lastVisited || link.createdAt)) / DAY;
    return link.visits > 0 && age >= 21;
  }

  function isRecentBloom(link) {
    const cutoff = now() - 30 * DAY;
    return link.bloomUntil > now() || (link.events || []).some((event) => event.type === 'bloom' && event.at >= cutoff);
  }

  function smartBedCounts() {
    const active = state.links.filter((link) => !link.archived);
    return {
      queue: active.filter((link) => link.queueState === 'queued').length,
      rediscover: active.filter(isRediscoveryCandidate).length,
      seedtray: active.filter((link) => !link.dead && link.visits === 0).length,
      recentblooms: active.filter(isRecentBloom).length,
      repair: active.filter((link) => link.dead).length
    };
  }

  function queuePriorityLabel(priority) {
    return ({ 1: 'Someday', 2: 'Soon', 3: 'Next' })[Number(priority)] || 'Soon';
  }

  function queuePriorityIcon(priority) {
    return ({ 1: '○', 2: '◐', 3: '●' })[Number(priority)] || '◐';
  }

  function speciesBedSuggestion(link) {
    return ({
      tree: 'Reference Grove',
      shrub: 'Toolshed Bed',
      sunflower: 'Video Patch',
      flower: 'Reading Bed',
      vine: 'Social Trellis',
      herb: 'Guide Garden',
      wildflower: 'Wild Finds'
    })[linkSpecies(link)] || 'Wild Finds';
  }

  function rootDomain(url) {
    try {
      const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
      return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
    } catch { return 'Other Sites'; }
  }

  function titleCase(value) {
    return String(value || '').replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
  }

  function suggestedBedName(link, strategy = state.settings.cultivationStrategy) {
    if (strategy === 'domain') return titleCase(rootDomain(link.url));
    if (strategy === 'tag') return link.tags?.[0] ? titleCase(link.tags[0]) : speciesBedSuggestion(link);
    return speciesBedSuggestion(link);
  }

  function autoCultivationPlan(strategy = state.settings.cultivationStrategy) {
    return state.links.filter((link) => !link.archived).map((link) => ({
      link,
      current: bedName(link.bedId),
      suggested: suggestedBedName(link, strategy)
    })).filter((item) => item.current.toLowerCase() !== item.suggested.toLowerCase());
  }

  function archivedRecoveryCandidates() {
    return state.links.filter((link) => link.archived)
      .map((link) => ({ link, score: link.visits * 10 + Math.max(0, 90 - ((now() - (link.lastVisited || link.createdAt)) / DAY)) }))
      .filter((item) => item.link.visits >= 2 || item.score >= 35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.link);
  }

  function deadLinkCandidates(link) {
    const candidates = [];
    try {
      const parsed = new URL(link.url);
      const add = (url, label, note) => {
        const canonical = canonicalize(url);
        if (!candidates.some((item) => item.canonical === canonical) && canonical !== link.canonicalUrl) candidates.push({ url, canonical, label, note });
      };
      add(`${parsed.protocol === 'https:' ? 'http:' : 'https:'}//${parsed.host}${parsed.pathname}${parsed.search}`, 'Try the other protocol', 'Useful when a site moved between HTTP and HTTPS.');
      if (parsed.hostname.startsWith('www.')) add(`${parsed.protocol}//${parsed.hostname.slice(4)}${parsed.pathname}${parsed.search}`, 'Remove www', 'Try the bare domain.');
      else add(`${parsed.protocol}//www.${parsed.hostname}${parsed.pathname}${parsed.search}`, 'Add www', 'Try the traditional hostname.');
      if (parsed.pathname !== '/') add(`${parsed.protocol}//${parsed.host}/`, 'Open the site root', 'The page may have moved while the site remains available.');
    } catch { /* no candidates */ }
    return candidates.slice(0, 4);
  }

  function resolvedSeason(at = new Date()) {
    if (state.settings.ecologySeason !== 'auto') return state.settings.ecologySeason;
    const month = at.getMonth();
    const north = month <= 1 || month === 11 ? 'winter'
      : month <= 4 ? 'spring'
        : month <= 7 ? 'summer'
          : month <= 10 ? 'autumn'
            : 'winter';
    if (state.settings.ecologyHemisphere !== 'south') return north;
    return ({ winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' })[north];
  }

  function resolvedTimeOfDay(at = new Date()) {
    if (state.settings.ecologyTime !== 'auto') return state.settings.ecologyTime;
    const hour = at.getHours();
    if (hour >= 7 && hour < 17) return 'day';
    if ((hour >= 5 && hour < 7) || (hour >= 17 && hour < 20)) return 'dusk';
    return 'night';
  }

  function resolvedWeather(at = new Date()) {
    if (state.settings.ecologyWeather !== 'auto') return state.settings.ecologyWeather;
    const seed = `${dateKey(at.getTime())}:${resolvedSeason(at)}`;
    const roll = stableFraction(seed, 17);
    if (roll < .12) return 'rain';
    if (roll < .34) return 'cloudy';
    if (roll < .52) return 'breeze';
    return 'clear';
  }

  function ecologyState() {
    if (!state.settings.ecologyEnabled) return { enabled: false, season: 'summer', time: 'day', weather: 'clear', pollinators: false, motion: false };
    const date = new Date();
    return {
      enabled: true,
      season: resolvedSeason(date),
      time: resolvedTimeOfDay(date),
      weather: resolvedWeather(date),
      pollinators: state.settings.ecologyPollinators,
      motion: state.settings.ecologyMotion
    };
  }

  function ecologyLabel(ecology = ecologyState()) {
    if (!ecology.enabled) return 'Ecology paused';
    const season = ecology.season[0].toUpperCase() + ecology.season.slice(1);
    const time = ecology.time[0].toUpperCase() + ecology.time.slice(1);
    const weather = ecology.weather[0].toUpperCase() + ecology.weather.slice(1);
    return `${season} · ${time} · ${weather}`;
  }

  function ecologySkyIcon(ecology) {
    if (ecology.time === 'night') return ecology.weather === 'rain' ? '☂' : '☾';
    if (ecology.time === 'dusk') return '◒';
    if (ecology.weather === 'rain') return '☂';
    if (ecology.weather === 'cloudy') return '☁';
    if (ecology.weather === 'breeze') return '〰';
    return '☀';
  }

  function renderWeatherLayer(ecology) {
    if (!ecology.enabled) return '';
    if (ecology.weather === 'rain') {
      return `<div class="lg-rain-layer" aria-hidden="true">${Array.from({ length: 18 }, (_, index) => `<i style="--drop-x:${stableFraction('rain', index) * 100}%;--drop-delay:${stableFraction('rain-delay', index) * -2.4}s;--drop-speed:${.8 + stableFraction('rain-speed', index) * .9}s"></i>`).join('')}</div>`;
    }
    if (ecology.weather === 'cloudy') return '<div class="lg-cloud-bank" aria-hidden="true"><i>☁</i><i>☁</i><i>☁</i></div>';
    if (ecology.weather === 'breeze') return '<div class="lg-breeze-lines" aria-hidden="true"><i>〰</i><i>〰</i><i>〰</i></div>';
    return '';
  }

  function renderPollinators(ecology, bedId) {
    if (!ecology.enabled || !ecology.pollinators || ecology.season === 'winter' || ecology.weather === 'rain') return '';
    const nighttime = ecology.time === 'night';
    const icons = nighttime ? ['✦', '·', '✦', '·'] : ecology.season === 'autumn' ? ['🍂', '🍁', '🍂'] : ['🐝', '🦋', '🐝'];
    return `<div class="lg-pollinators ${nighttime ? 'is-fireflies' : ''}" aria-hidden="true">${icons.map((icon, index) => `<span style="--bug-x:${8 + stableFraction(bedId, index + 80) * 84}%;--bug-y:${8 + stableFraction(bedId, index + 90) * 58}%;--bug-delay:${stableFraction(bedId, index + 100) * -7}s;--bug-speed:${5 + stableFraction(bedId, index + 110) * 5}s">${icon}</span>`).join('')}</div>`;
  }

  function seasonalPlantAdornment(link, ecology) {
    if (!ecology.enabled || link.dead) return '';
    const species = linkSpecies(link);
    if (ecology.season === 'winter') return species === 'tree' || species === 'shrub' ? '<span class="lg-season-adornment">❄</span>' : '';
    if (ecology.season === 'autumn' && ['tree', 'shrub', 'vine'].includes(species)) return '<span class="lg-season-adornment">🍂</span>';
    if (ecology.season === 'spring' && !plantProfile(link).blooming && ['tree', 'flower', 'wildflower'].includes(species)) return '<span class="lg-season-adornment">✿</span>';
    return '';
  }

  function renderGardenView(visibleLinks) {
    const ecology = ecologyState();
    const groups = state.beds.map((bed) => ({
      bed,
      links: visibleLinks.filter((link) => link.bedId === bed.id),
      ecology
    })).filter((group) => group.links.length || state.settings.selectedBed === group.bed.id || state.settings.selectedBed === 'all');

    return `<div class="lg-landscape season-${ecology.season} time-${ecology.time} weather-${ecology.weather} ${ecology.enabled ? 'ecology-on' : 'ecology-off'} ${ecology.motion ? 'motion-on' : 'motion-off'}">
      <div class="lg-garden-sky">
        <span class="lg-sky-orb">${ecologySkyIcon(ecology)}</span>
        <span><b>Link Garden</b><small>${escapeHTML(ecologyLabel(ecology))}</small></span>
        <button data-action="ecology" title="Adjust garden ecology">Tune ecology</button>
      </div>
      ${renderWeatherLayer(ecology)}
      ${groups.map(renderGardenBed).join('')}
      ${!groups.length ? renderEmptyState() : ''}
    </div>`;
  }

  function renderGardenBed(group) {
    const count = group.links.length;
    const height = clamp(230 + Math.floor(Math.max(0, count - 6) / 5) * 70, 230, 440);
    const canDrop = state.settings.selectedBed !== 'archive';
    const ecology = group.ecology || ecologyState();
    const groundDecor = ecology.enabled
      ? ({ spring: '✿ · ✾ · ✿', summer: '· · 🌼 · ·', autumn: '🍂 · 🍁 · 🍂', winter: '· ❄ · ❄ ·' })[ecology.season]
      : '';
    return `<section class="lg-landscape-bed">
      <header><div><span class="lg-bed-sign">${escapeHTML(group.bed.name)}</span><small>${count} ${count === 1 ? 'plant' : 'plants'}</small></div><button data-action="edit-bed" data-id="${escapeHTML(group.bed.id)}">Tend bed</button></header>
      <div class="lg-bed-canvas" style="--bed-height:${height}px" ${canDrop ? `data-drop-bed-id="${escapeHTML(group.bed.id)}"` : ''}>
        <div class="lg-bed-path"></div>
        <div class="lg-season-ground" aria-hidden="true">${groundDecor}</div>
        ${renderPollinators(ecology, group.bed.id)}
        ${group.links.map((link) => renderGardenPlant(link, ecology)).join('')}
        ${count ? '' : '<div class="lg-bed-empty">Drop a plant here to transplant it.</div>'}
      </div>
    </section>`;
  }

  function renderGardenPlant(link, ecology = ecologyState()) {
    const profile = plantProfile(link);
    const scale = plantScale(link);
    const note = link.notes.trim() || 'No plant label yet.';
    return `<div class="lg-garden-plant health-${profile.health}" draggable="${link.archived ? 'false' : 'true'}" data-link-id="${escapeHTML(link.id)}" style="left:${link.gardenX}%;top:${link.gardenY}%;--plant-scale:${scale}">
      <button class="lg-garden-sprite" data-action="open-link" data-id="${escapeHTML(link.id)}" title="Open ${escapeHTML(link.title)}">
        <span class="lg-garden-sparkles">${profile.blooming ? '✦ ✿ ✦' : ''}</span>
        <span class="lg-garden-emoji">${profile.emoji}</span>
        ${seasonalPlantAdornment(link, ecology)}
      </button>
      <div class="lg-garden-tooltip">
        <strong>${escapeHTML(link.title)}</strong>
        <span>${escapeHTML(profile.label)} · ${escapeHTML(profile.species)}</span>
        <em>${escapeHTML(note)}</em>
        <small>↻ ${link.visits} · ${relativeAge(link.lastVisited)}</small>
        <div><button data-action="open-link" data-id="${escapeHTML(link.id)}">Water</button><button data-action="queue-link" data-id="${escapeHTML(link.id)}">${link.queueState === 'queued' ? 'Queued' : 'Queue'}</button>${link.dead ? `<button data-action="repair-link" data-id="${escapeHTML(link.id)}">Repair</button>` : ''}<button data-action="journal-link" data-id="${escapeHTML(link.id)}">Journal</button><button data-action="edit-link" data-id="${escapeHTML(link.id)}">Prune</button></div>
      </div>
    </div>`;
  }

  function renderJournalFilters() {
    return `<div class="lg-filters lg-journal-filters">
      <select data-field="journal-range" aria-label="Journal date range">
        ${journalRangeOption('30', 'Last 30 days')}
        ${journalRangeOption('90', 'Last 90 days')}
        ${journalRangeOption('365', 'Last year')}
        ${journalRangeOption('all', 'All history')}
      </select>
      <select data-field="journal-filter" aria-label="Journal event filter">
        ${journalFilterOption('all', 'All events')}
        ${journalFilterOption('visits', 'Visits only')}
        ${journalFilterOption('blooms', 'Blooms only')}
        ${journalFilterOption('changes', 'Garden changes')}
      </select>
    </div>`;
  }

  function journalRangeOption(value, label) {
    return `<option value="${value}" ${String(state.settings.journalRange) === value ? 'selected' : ''}>${label}</option>`;
  }

  function journalFilterOption(value, label) {
    return `<option value="${value}" ${state.settings.journalFilter === value ? 'selected' : ''}>${label}</option>`;
  }

  function journalScopeLinks() {
    const selected = state.settings.selectedBed;
    return state.links.filter((link) => {
      if (selected === 'archive') return link.archived;
      if (link.archived) return false;
      if (selected === 'mushrooms' || selected === 'repair') return link.dead;
      if (selected === 'needs') return link.dead || ['thirsty', 'wilted', 'parched'].includes(plantProfile(link).health);
      if (selected === 'queue') return link.queueState === 'queued';
      if (selected === 'rediscover') return isRediscoveryCandidate(link);
      if (selected === 'seedtray') return !link.dead && link.visits === 0;
      if (selected === 'recentblooms') return isRecentBloom(link);
      if (selected !== 'all') return link.bedId === selected;
      return true;
    });
  }

  function journalCutoff() {
    const range = String(state.settings.journalRange || '30');
    if (range === 'all') return 0;
    return now() - Number(range) * DAY;
  }

  function getJournalEvents(links = journalScopeLinks()) {
    const ids = new Set(links.map((link) => link.id));
    const cutoff = journalCutoff();
    const filter = state.settings.journalFilter;
    const filterTypes = {
      visits: new Set(['visit']),
      blooms: new Set(['bloom']),
      changes: new Set(['planted', 'import', 'import-update', 'health', 'dead', 'revived', 'transplant', 'prune', 'archive', 'restore', 'queue', 'queue-done', 'queue-remove', 'organize', 'repair'])
    };
    return state.links.flatMap((link) => (link.events || []).map((event) => ({ ...event, link })))
      .filter((entry) => ids.has(entry.link.id) && entry.at >= cutoff)
      .filter((entry) => filter === 'all' || filterTypes[filter]?.has(entry.type))
      .sort((a, b) => b.at - a.at);
  }

  function renderJournalView() {
    const links = journalScopeLinks();
    if (!links.length) return renderEmptyState();
    const events = getJournalEvents(links);
    const totalVisits = links.reduce((sum, link) => sum + link.visits, 0);
    const bloomCount = links.reduce((sum, link) => sum + (link.events || []).filter((event) => event.type === 'bloom' && event.at >= journalCutoff()).length, 0);
    const living = links.filter((link) => !link.dead);
    const averageVitality = living.length ? Math.round(living.reduce((sum, link) => sum + vitality(link), 0) / living.length) : -100;
    const activeDays = new Set(events.filter((event) => !event.synthetic).map((event) => dateKey(event.at))).size;
    const neglected = [...links].filter((link) => !link.dead).sort((a, b) => (a.lastVisited || a.createdAt) - (b.lastVisited || b.createdAt)).slice(0, 4);

    return `<div class="lg-journal-dashboard">
      <section class="lg-journal-kpis">
        ${journalKpi('↻', totalVisits, 'Recorded visits', 'All-time totals for this view')}
        ${journalKpi('🌸', bloomCount, 'Rediscovery blooms', journalRangeLabel())}
        ${journalKpi('⌁', averageVitality, 'Average vitality', 'Range −100 to 105')}
        ${journalKpi('▦', activeDays, 'Active days', journalRangeLabel())}
      </section>

      <section class="lg-journal-grid lg-journal-grid-top">
        <article class="lg-journal-card lg-chart-card">
          <header><div><h3>Visits over time</h3><p>Recorded page openings in ${journalRangeLabel().toLowerCase()}</p></div><span>${events.filter((event) => event.type === 'visit' && !event.synthetic).reduce((sum, event) => sum + event.count, 0)} tracked visits</span></header>
          ${renderVisitChart(links)}
        </article>
        <article class="lg-journal-card">
          <header><div><h3>Garden vitality</h3><p>Current health distribution</p></div></header>
          ${renderVitalityMix(links)}
        </article>
      </section>

      <section class="lg-journal-grid">
        <article class="lg-journal-card">
          <header><div><h3>Plant families</h3><p>Species in the selected garden</p></div></header>
          ${renderSpeciesBreakdown(links)}
        </article>
        <article class="lg-journal-card">
          <header><div><h3>Old friends</h3><p>Neglected pages ready for rediscovery</p></div></header>
          <div class="lg-rediscover-list">${neglected.map(renderRediscoverItem).join('') || '<p class="lg-journal-empty">Nothing needs rediscovery.</p>'}</div>
        </article>
      </section>

      <section class="lg-journal-card lg-timeline-card">
        <header><div><h3>Garden timeline</h3><p>${events.length} recorded ${events.length === 1 ? 'event' : 'events'} in this view</p></div></header>
        ${events.length ? `<div class="lg-timeline">${events.slice(0, 80).map(renderJournalEvent).join('')}</div>` : '<p class="lg-journal-empty">No events match this range and filter yet.</p>'}
      </section>
    </div>`;
  }

  function journalKpi(icon, value, label, note) {
    return `<article><span>${icon}</span><div><strong>${value}</strong><b>${escapeHTML(label)}</b><small>${escapeHTML(note)}</small></div></article>`;
  }

  function journalRangeLabel() {
    const range = String(state.settings.journalRange || '30');
    return range === 'all' ? 'All recorded history' : range === '365' ? 'The last year' : `The last ${range} days`;
  }

  function renderVisitChart(links) {
    const range = String(state.settings.journalRange || '30');
    const days = range === 'all' ? 90 : Math.min(90, Number(range));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
    const buckets = Array.from({ length: days }, (_, index) => ({ at: start.getTime() + index * DAY, value: 0 }));
    const indexByDay = new Map(buckets.map((bucket, index) => [dateKey(bucket.at), index]));
    links.forEach((link) => (link.events || []).forEach((event) => {
      if (event.type !== 'visit' || event.synthetic) return;
      const index = indexByDay.get(dateKey(event.at));
      if (index !== undefined) buckets[index].value += event.count;
    }));
    const max = Math.max(1, ...buckets.map((bucket) => bucket.value));
    const width = 720;
    const height = 190;
    const padX = 22;
    const padTop = 16;
    const padBottom = 28;
    const chartHeight = height - padTop - padBottom;
    const gap = days > 45 ? 1 : 3;
    const barWidth = Math.max(2, (width - padX * 2) / days - gap);
    const bars = buckets.map((bucket, index) => {
      const barHeight = (bucket.value / max) * chartHeight;
      const x = padX + index * ((width - padX * 2) / days) + gap / 2;
      const y = padTop + chartHeight - barHeight;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(1, barHeight).toFixed(2)}" rx="2"><title>${formatDate(bucket.at)}: ${bucket.value} visits</title></rect>`;
    }).join('');
    const labels = [0, Math.floor((days - 1) / 2), days - 1].map((index) => `<text x="${(padX + index * ((width - padX * 2) / days)).toFixed(2)}" y="181" text-anchor="${index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle'}">${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(buckets[index].at)}</text>`).join('');
    return `<svg class="lg-visit-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Visits over time"><line x1="${padX}" y1="${padTop + chartHeight}" x2="${width - padX}" y2="${padTop + chartHeight}"></line>${bars}${labels}</svg>`;
  }

  function renderVitalityMix(links) {
    const groups = { thriving: 0, healthy: 0, thirsty: 0, wilted: 0, dead: 0 };
    links.forEach((link) => {
      const health = plantProfile(link).health;
      if (health === 'dead') groups.dead += 1;
      else if (vitality(link) >= 45 || health === 'blooming') groups.thriving += 1;
      else if (health === 'healthy') groups.healthy += 1;
      else if (health === 'thirsty') groups.thirsty += 1;
      else groups.wilted += 1;
    });
    const total = Math.max(1, links.length);
    const segments = [groups.thriving, groups.healthy, groups.thirsty, groups.wilted, groups.dead];
    let cursor = 0;
    const stops = segments.map((value, index) => {
      const start = cursor;
      cursor += value / total * 100;
      return `var(--vital-${index}) ${start}% ${cursor}%`;
    }).join(',');
    return `<div class="lg-vitality-mix">
      <div class="lg-vitality-ring" style="background:conic-gradient(${stops})"><span><strong>${links.length}</strong><small>plants</small></span></div>
      <div class="lg-vitality-legend">
        ${vitalityLegend('Thriving', groups.thriving, 0)}${vitalityLegend('Healthy', groups.healthy, 1)}${vitalityLegend('Thirsty', groups.thirsty, 2)}${vitalityLegend('Wilted', groups.wilted, 3)}${vitalityLegend('Mushrooms', groups.dead, 4)}
      </div>
    </div>`;
  }

  function vitalityLegend(label, value, index) {
    return `<div><i style="background:var(--vital-${index})"></i><span>${label}</span><b>${value}</b></div>`;
  }

  function renderSpeciesBreakdown(links) {
    const counts = new Map();
    links.forEach((link) => counts.set(linkSpecies(link), (counts.get(linkSpecies(link)) || 0) + 1));
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((row) => row[1]));
    return `<div class="lg-species-bars">${rows.map(([species, count]) => `<div><span>${speciesEmoji(species, 'flowering', false, 'healthy')} ${escapeHTML(species)}</span><i><b style="width:${count / max * 100}%"></b></i><strong>${count}</strong></div>`).join('')}</div>`;
  }

  function renderRediscoverItem(link) {
    const profile = plantProfile(link);
    return `<div class="lg-rediscover-item"><span>${profile.emoji}</span><div><strong>${escapeHTML(link.title)}</strong><small>${relativeAge(link.lastVisited)} · ${link.visits} visits</small></div><button data-action="open-link" data-id="${escapeHTML(link.id)}">Water</button><button data-action="journal-link" data-id="${escapeHTML(link.id)}">History</button></div>`;
  }

  function renderJournalEvent(entry) {
    const presentation = eventPresentation(entry);
    return `<article class="lg-timeline-event event-${escapeHTML(entry.type)}"><span class="lg-event-icon">${presentation.icon}</span><div><strong>${escapeHTML(presentation.title)}</strong><p>${escapeHTML(presentation.detail)}</p><small>${formatEventTime(entry.at)} · ${escapeHTML(entry.link.title)}</small></div><button data-action="journal-link" data-id="${escapeHTML(entry.link.id)}">View plant</button></article>`;
  }

  function eventPresentation(entry) {
    const event = entry;
    const defaults = {
      planted: ['🌱', 'Planted', `Added to ${bedName(event.bedId || entry.link.bedId)}.`],
      visit: ['💧', event.count > 1 ? `${event.count} visits imported` : 'Page revisited', event.detail || 'The page was opened.'],
      bloom: ['🌸', 'Rediscovery bloom', event.detail || 'An old page bloomed again.'],
      health: [event.to === 'dead' ? '🍄' : event.to === 'healthy' ? '☀' : '🥀', event.label || 'Health changed', event.from && event.to ? `${event.from} → ${event.to}` : event.detail],
      dead: ['🍄', 'Became a mushroom', event.detail || 'The page did not respond.'],
      revived: ['🌿', 'Mushroom revived', event.detail || 'The page responded again.'],
      transplant: ['↔', 'Transplanted', event.detail || `Moved to ${bedName(event.to || event.bedId)}.`],
      prune: ['✂', 'Plant pruned', event.detail || 'Its title, label, address, or species changed.'],
      archive: ['♻', 'Composted', event.detail || 'Moved to the compost archive.'],
      restore: ['↟', 'Restored', event.detail || 'Returned to its garden bed.'],
      queue: ['📚', 'Added to reading queue', event.detail || `Priority: ${queuePriorityLabel(entry.link.queuePriority)}.`],
      'queue-done': ['✓', 'Reading completed', event.detail || 'Marked as read.'],
      'queue-remove': ['−', 'Removed from queue', event.detail || 'Returned to the general garden.'],
      organize: ['✦', 'Automatically cultivated', event.detail || 'Moved by an automatic grouping rule.'],
      repair: ['🛠', 'Link repaired', event.detail || 'Its destination address was replaced.'],
      import: ['⇣', 'Imported bookmark', event.detail || 'Added from a browser bookmark file.'],
      'import-update': ['⌁', 'Bookmark labels merged', event.detail || 'Browser bookmark details were merged into this plant.']
    };
    const [icon, title, detail] = defaults[event.type] || ['•', event.label || 'Garden event', event.detail || ''];
    return { icon, title: event.label || title, detail };
  }

  function formatEventTime(timestamp) {
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function openPlantJournal(id) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    const profile = plantProfile(link);
    const events = [...(link.events || [])].sort((a, b) => b.at - a.at);
    const blooms = events.filter((event) => event.type === 'bloom').length;
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <section class="lg-dialog lg-history-dialog">
        <div class="lg-dialog-head"><div class="lg-history-title"><span>${profile.emoji}</span><div><h3>${escapeHTML(link.title)}</h3><p>${escapeHTML(profile.label)} · ${escapeHTML(bedName(link.bedId))}</p></div></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
        <div class="lg-history-kpis">
          <div><strong>${link.visits}</strong><span>visits</span></div><div><strong>${vitality(link)}</strong><span>vitality</span></div><div><strong>${blooms}</strong><span>blooms</span></div><div><strong>${relativeAge(link.lastVisited)}</strong><span>last watered</span></div>
        </div>
        <div class="lg-history-chart"><h4>Vitality history</h4>${renderVitalitySparkline(link)}</div>
        <div class="lg-history-timeline"><h4>Lifecycle timeline</h4>${events.length ? events.map((event) => renderJournalEvent({ ...event, link })).join('') : '<p class="lg-journal-empty">No history recorded yet.</p>'}</div>
        <div class="lg-dialog-actions"><button data-action="open-link" data-id="${escapeHTML(link.id)}">💧 Water</button><span></span><button data-action="edit-link" data-id="${escapeHTML(link.id)}">✂ Prune</button><button type="button" data-dialog-close>Close</button></div>
      </section>
    </div>`;
    bindDialogClose(layer);
  }

  function renderVitalitySparkline(link) {
    const points = [...(link.snapshots || [])].sort((a, b) => a.at - b.at);
    if (!points.length) return '<p class="lg-journal-empty">No vitality snapshots yet.</p>';
    const width = 680;
    const height = 160;
    const pad = 20;
    const minAt = points[0].at;
    const maxAt = Math.max(minAt + 1, points.at(-1).at);
    const coords = points.map((point) => {
      const x = pad + ((point.at - minAt) / (maxAt - minAt)) * (width - pad * 2);
      const y = pad + ((105 - clamp(point.vitality, -100, 105)) / 205) * (height - pad * 2);
      return { ...point, x, y };
    });
    const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
    return `<svg class="lg-vitality-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Vitality history"><line class="lg-zero-line" x1="${pad}" y1="${(pad + (105 / 205) * (height - pad * 2)).toFixed(1)}" x2="${width - pad}" y2="${(pad + (105 / 205) * (height - pad * 2)).toFixed(1)}"></line><polygon points="${area}"></polygon><polyline points="${line}"></polyline>${coords.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${formatDate(point.at)}: vitality ${point.vitality}</title></circle>`).join('')}</svg>`;
  }

  function renderPlantCard(link) {
    const profile = plantProfile(link);
    const note = link.notes.trim();
    const checked = link.lastChecked ? `Checked ${relativeAge(link.lastChecked)}` : 'Not health-checked';
    const selected = selectedLinkIds.has(link.id);
    return `
      <article class="lg-plant-card health-${profile.health} ${selected ? 'is-selected' : ''}" data-link-id="${escapeHTML(link.id)}">
        <label class="lg-select-plant" title="Select plant"><input type="checkbox" data-action="toggle-select" data-id="${escapeHTML(link.id)}" ${selected ? 'checked' : ''}><span>✓</span></label>
        <div class="lg-soil"></div>
        <div class="lg-weather">${weatherGlyph(profile.health)}</div>
        <button class="lg-plant-visual" data-action="open-link" data-id="${escapeHTML(link.id)}" title="Open ${escapeHTML(link.title)}">
          <span class="lg-bloom-ring">${profile.blooming ? '✦ ✿ ✦' : ''}</span>
          <span class="lg-plant-emoji">${profile.emoji}</span>
          <span class="lg-shadow"></span>
        </button>
        <div class="lg-plant-info">
          <div class="lg-card-topline">
            <span class="lg-stage">${escapeHTML(profile.label)} · ${escapeHTML(profile.species)}</span>
            <button class="lg-more" data-action="edit-link" data-id="${escapeHTML(link.id)}" title="Prune plant">•••</button>
          </div>
          <h3 title="${escapeHTML(link.title)}">${escapeHTML(link.title)}</h3>
          ${link.queueState === 'queued' ? `<div class="lg-queue-chip priority-${link.queuePriority}">${queuePriorityIcon(link.queuePriority)} Reading queue · ${queuePriorityLabel(link.queuePriority)}</div>` : link.queueState === 'done' ? `<div class="lg-queue-chip is-done">✓ Read</div>` : ''}
          <a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(link.url)}">${escapeHTML(safeHost(link.url) || link.url)}</a>
          <div class="lg-growth-row">
            <span title="Total visits">↻ ${link.visits}</span>
            <span title="Last visited">◷ ${relativeAge(link.lastVisited)}</span>
            <span title="Garden bed">▰ ${escapeHTML(bedName(link.bedId))}</span>
          </div>
          <div class="lg-label ${note ? '' : 'is-empty'}" title="${escapeHTML(note || 'No label note')}">
            <span class="lg-label-pin"></span>
            ${escapeHTML(note || 'Add a plant label…')}
          </div>
          <div class="lg-card-actions">
            <button data-action="open-link" data-id="${escapeHTML(link.id)}">💧 Water</button>
            <button data-action="transplant-link" data-id="${escapeHTML(link.id)}">↔ Transplant</button>
            <button data-action="queue-link" data-id="${escapeHTML(link.id)}">${link.queueState === 'queued' ? '📚 Queue' : link.queueState === 'done' ? '✓ Read' : '＋ Queue'}</button>
            ${link.dead ? `<button data-action="repair-link" data-id="${escapeHTML(link.id)}">🛠 Repair</button>` : ''}
            <button data-action="journal-link" data-id="${escapeHTML(link.id)}">⌁ Journal</button>
            <button data-action="edit-link" data-id="${escapeHTML(link.id)}">✂ Prune</button>
            <button data-action="archive-link" data-id="${escapeHTML(link.id)}">${link.archived ? '↟ Restore' : '♻ Compost'}</button>
          </div>
          <div class="lg-card-footer"><span>${escapeHTML(checked)}</span>${link.statusCode ? `<span>HTTP ${link.statusCode}</span>` : ''}</div>
        </div>
      </article>
    `;
  }

  function weatherGlyph(health) {
    return ({ blooming: '✨', healthy: '☀', thirsty: '◌', wilted: '☁', parched: '≈', dead: '⋯' })[health] || '☀';
  }

  function renderEmptyState() {
    const mushroom = state.settings.selectedBed === 'mushrooms';
    return `
      <div class="lg-empty">
        <div class="lg-empty-scene">${mushroom ? '🌿' : '🌱'}</div>
        <h3>${mushroom ? 'No mushrooms here' : 'This bed is waiting for seeds'}</h3>
        <p>${mushroom ? 'All checked links are currently alive.' : 'Plant the page you are viewing or add a link by hand.'}</p>
        ${mushroom ? '' : '<button class="lg-primary" data-action="add-current">＋ Plant this page</button>'}
      </div>
    `;
  }

  function bindUI(root) {
    root.addEventListener('click', handleClick);
    root.querySelector('[data-field="search"]')?.addEventListener('input', (event) => {
      state.settings.search = event.target.value;
      scheduleSave();
      debounceRender();
    });
    root.querySelector('[data-field="sort"]')?.addEventListener('change', (event) => {
      state.settings.sort = event.target.value;
      scheduleSave();
      render();
    });
    root.querySelector('[data-field="journal-range"]')?.addEventListener('change', (event) => {
      state.settings.journalRange = event.target.value;
      scheduleSave();
      render();
    });
    root.querySelector('[data-field="journal-filter"]')?.addEventListener('change', (event) => {
      state.settings.journalFilter = event.target.value;
      scheduleSave();
      render();
    });
    root.querySelector('[data-field="active-garden"]')?.addEventListener('change', (event) => switchGarden(event.target.value));
    root.querySelector('[data-field="atlas-range"]')?.addEventListener('change', (event) => {
      state.settings.atlasRange = event.target.value;
      scheduleSave();
      render();
    });
    root.querySelector('.lg-json-file-input')?.addEventListener('change', importGardenBackup);
    root.querySelector('.lg-bookmark-file-input')?.addEventListener('change', readBrowserBookmarkFile);
    root.querySelectorAll('.lg-garden-plant[draggable="true"]').forEach((plant) => {
      plant.addEventListener('dragstart', handlePlantDragStart);
      plant.addEventListener('dragend', () => plant.classList.remove('is-dragging'));
    });
    root.querySelectorAll('[data-drop-bed-id]').forEach((bed) => {
      bed.addEventListener('dragover', (event) => {
        event.preventDefault();
        bed.classList.add('is-drop-target');
      });
      bed.addEventListener('dragleave', () => bed.classList.remove('is-drop-target'));
      bed.addEventListener('drop', handlePlantDrop);
    });
  }

  let renderTimer = null;
  function debounceRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 130);
  }

  function handleClick(event) {
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      const { action, id } = actionButton.dataset;
      const actions = {
        close: closePanel,
        theme: cycleTheme,
        undo: undoLastChange,
        'view-garden': () => setView('garden'),
        'view-nursery': () => setView('nursery'),
        'view-journal': () => setView('journal'),
        'view-atlas': () => setView('atlas'),
        'add-current': addCurrentPage,
        'add-link': () => openLinkDialog(),
        'edit-link': () => openLinkDialog(id),
        'journal-link': () => openPlantJournal(id),
        'open-link': () => openSavedLink(id),
        'transplant-link': () => openTransplantDialog([id]),
        'archive-link': () => toggleArchiveLink(id),
        'toggle-select': () => toggleSelectedLink(id),
        'clear-selection': clearSelection,
        'bulk-transplant': () => openTransplantDialog([...selectedLinkIds]),
        'bulk-archive': bulkArchiveSelected,
        'add-bed': () => openBedDialog(),
        'edit-bed': () => openBedDialog(id),
        'check-links': checkAllLinks,
        ecology: openEcologyDialog,
        cultivate: openCultivationDialog,
        'queue-link': () => openQueueDialog(id),
        'repair-link': () => openRepairDialog(id),
        'smart-surprise': openRediscoverySurprise,
        'auto-organize': openAutoOrganizeDialog,
        'recover-link': () => recoverArchivedLink(id),
        'new-garden': () => openGardenDialog(),
        'edit-garden': () => openGardenDialog(state.atlas.activeGardenId),
        'switch-garden': () => switchGarden(id),
        'create-snapshot': openSnapshotDialog,
        'restore-snapshot': () => restoreAtlasSnapshot(id),
        'delete-snapshot': () => deleteAtlasSnapshot(id),
        'share-garden': openShareDialog,
        'data-center': openDataCenter,
        export: exportGarden,
        import: openImportCenter,
        'import-json': () => shadow.querySelector('.lg-json-file-input')?.click(),
        'import-bookmarks': () => shadow.querySelector('.lg-bookmark-file-input')?.click(),
        'bookmark-select-new': () => setBookmarkImportSelection('new'),
        'bookmark-select-all': () => setBookmarkImportSelection('all'),
        'bookmark-select-none': () => setBookmarkImportSelection('none'),
        'bookmark-back': openImportCenter
      };
      actions[action]?.();
      return;
    }

    const bedButton = event.target.closest('[data-bed-id]');
    if (bedButton) {
      state.settings.selectedBed = bedButton.dataset.bedId;
      selectedLinkIds.clear();
      scheduleSave();
      render();
    }
  }

  function setView(view) {
    if (!['garden', 'nursery', 'journal', 'atlas'].includes(view)) return;
    state.settings.view = view;
    scheduleSave();
    render();
  }

  function rememberChange(label) {
    undoStack.push({ label, state: clone(state) });
    if (undoStack.length > 12) undoStack.shift();
  }

  function undoLastChange() {
    const entry = undoStack.pop();
    if (!entry) return;
    state = migrateState(entry.state);
    selectedLinkIds.clear();
    currentLinkId = state.links.find((link) => link.canonicalUrl === currentCanonicalUrl)?.id || null;
    scheduleSave();
    updateLauncherState();
    render();
    showToast(`Undid: ${entry.label}`);
  }

  function toggleSelectedLink(id) {
    if (!id) return;
    selectedLinkIds.has(id) ? selectedLinkIds.delete(id) : selectedLinkIds.add(id);
    render();
  }

  function clearSelection() {
    selectedLinkIds.clear();
    render();
  }

  function toggleArchiveLink(id) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    rememberChange(link.archived ? 'restore plant' : 'compost plant');
    link.archived = !link.archived;
    recordEvent(link, link.archived ? 'archive' : 'restore', { label: link.archived ? 'Moved to compost archive' : 'Restored to garden', detail: link.archived ? 'Archived without deleting its history.' : `Returned to ${bedName(link.bedId)}.` });
    selectedLinkIds.delete(id);
    scheduleSave();
    render();
    showToast(link.archived ? 'Plant moved to the compost archive.' : 'Plant restored to its garden bed.');
  }

  function bulkArchiveSelected() {
    const links = state.links.filter((link) => selectedLinkIds.has(link.id));
    if (!links.length) return;
    const restoring = links.every((link) => link.archived);
    rememberChange(restoring ? 'restore selected plants' : 'compost selected plants');
    links.forEach((link) => {
      link.archived = !restoring;
      recordEvent(link, restoring ? 'restore' : 'archive', { label: restoring ? 'Restored to garden' : 'Moved to compost archive', detail: restoring ? `Returned to ${bedName(link.bedId)}.` : 'Archived as part of a bulk garden action.' });
    });
    selectedLinkIds.clear();
    scheduleSave();
    render();
    showToast(restoring
      ? `${links.length} plants restored to their garden beds.`
      : `${links.length} plants moved to the compost archive.`);
  }

  function openTransplantDialog(ids) {
    const links = state.links.filter((link) => ids.includes(link.id));
    if (!links.length) return;
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-dialog-small" data-dialog="transplant">
          <div class="lg-dialog-head"><div><h3>Transplant ${links.length === 1 ? 'plant' : `${links.length} plants`}</h3><p>Move the selection into another garden bed.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <label>Destination bed<select name="bedId">${state.beds.map((bed) => `<option value="${escapeHTML(bed.id)}">${escapeHTML(bed.name)}</option>`).join('')}</select></label>
          <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Transplant</button></div>
        </form>
      </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const bedId = String(new FormData(form).get('bedId') || '');
      if (!state.beds.some((bed) => bed.id === bedId)) return;
      rememberChange('transplant plants');
      links.forEach((link, index) => {
        const fromBedId = link.bedId;
        link.bedId = bedId;
        link.gardenX = 10 + stableFraction(link.id, now() + index) * 80;
        link.gardenY = 18 + stableFraction(link.id, now() + index + 1) * 58;
        link.archived = false;
        recordEvent(link, 'transplant', { label: `Transplanted to ${bedName(bedId)}`, from: fromBedId, to: bedId, bedId, detail: `Moved from ${bedName(fromBedId)} using the transplant tool.` });
      });
      selectedLinkIds.clear();
      scheduleSave();
      closeDialog();
      render();
      showToast(`${links.length} ${links.length === 1 ? 'plant' : 'plants'} transplanted.`);
    });
  }

  function handlePlantDragStart(event) {
    const plant = event.currentTarget;
    plant.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/link-garden-id', plant.dataset.linkId || '');
  }

  function handlePlantDrop(event) {
    event.preventDefault();
    const bed = event.currentTarget;
    bed.classList.remove('is-drop-target');
    const id = event.dataTransfer.getData('text/link-garden-id');
    const link = state.links.find((item) => item.id === id);
    const bedId = bed.dataset.dropBedId;
    if (!link || !state.beds.some((item) => item.id === bedId)) return;
    const rect = bed.getBoundingClientRect();
    const fromBedId = link.bedId;
    rememberChange('move plant');
    link.bedId = bedId;
    link.gardenX = clamp(((event.clientX - rect.left) / rect.width) * 100, 7, 93);
    link.gardenY = clamp(((event.clientY - rect.top) / rect.height) * 100, 12, 86);
    recordEvent(link, 'transplant', { label: `Transplanted to ${bedName(bedId)}`, from: fromBedId, to: bedId, bedId, detail: `Dragged from ${bedName(fromBedId)} to ${bedName(bedId)}.` });
    scheduleSave();
    render();
    showToast(`Transplanted ${link.title} to ${bedName(bedId)}.`);
  }

  function addCurrentPage() {
    const existing = state.links.find((link) => link.canonicalUrl === currentCanonicalUrl);
    if (existing) {
      currentLinkId = existing.id;
      openLinkDialog(existing.id);
      return;
    }
    openLinkDialog(null, {
      url: location.href,
      title: document.title || safeHost(location.href),
      bedId: state.beds.some((bed) => bed.id === state.settings.selectedBed) ? state.settings.selectedBed : defaultBedId(),
      notes: ''
    });
  }

  function openLinkDialog(linkId = null, seed = null) {
    const existing = linkId ? state.links.find((link) => link.id === linkId) : null;
    const values = existing || seed || { url: '', title: '', bedId: defaultBedId(), notes: '', speciesOverride: '' };
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog" data-dialog="link">
          <div class="lg-dialog-head">
            <div><h3>${existing ? 'Tend plant' : 'Plant a link'}</h3><p>${existing ? 'Update its bed, label, or address.' : 'Add a new bookmark to your garden.'}</p></div>
            <button type="button" class="lg-icon-button" data-dialog-close>×</button>
          </div>
          <label>Page address<input name="url" type="url" required value="${escapeHTML(values.url)}" placeholder="https://example.com"></label>
          <label>Plant name<input name="title" required value="${escapeHTML(values.title)}" placeholder="A memorable title"></label>
          <label>Garden bed<select name="bedId">${state.beds.map((bed) => `<option value="${escapeHTML(bed.id)}" ${bed.id === values.bedId ? 'selected' : ''}>${escapeHTML(bed.name)}</option>`).join('')}</select></label>
          <label>Plant label<textarea name="notes" rows="3" placeholder="Why this matters, what to remember, or what to do next…">${escapeHTML(values.notes)}</textarea></label>
          <label>Plant species<select name="speciesOverride">
            <option value="" ${!values.speciesOverride ? 'selected' : ''}>Automatic</option>
            ${[['tree','Tree / reference'],['shrub','Shrub / tool'],['sunflower','Sunflower / video'],['flower','Flower / article'],['vine','Vine / social'],['herb','Herb / guide'],['wildflower','Wildflower']].map(([value,label]) => `<option value="${value}" ${values.speciesOverride === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
          <div class="lg-dialog-actions">
            ${existing ? `<button type="button" data-archive-link>${existing.archived ? 'Restore' : 'Compost'}</button><button type="button" class="lg-danger" data-delete-link>Uproot</button>` : ''}
            <span></span>
            <button type="button" data-dialog-close>Cancel</button>
            <button class="lg-primary" type="submit">${existing ? 'Save changes' : 'Plant link'}</button>
          </div>
        </form>
      </div>
    `;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const rawUrl = String(data.get('url') || '').trim();
      let validated;
      try {
        validated = new URL(rawUrl, location.href);
        if (!/^https?:$/.test(validated.protocol)) throw new Error('Unsupported protocol');
      } catch {
        showToast('Please enter a complete http or https address.');
        return;
      }

      const canonicalUrl = canonicalize(validated.toString());
      const duplicate = state.links.find((link) => link.canonicalUrl === canonicalUrl && link.id !== existing?.id);
      if (duplicate) {
        showToast('That link is already planted.');
        return;
      }

      rememberChange(existing ? 'edit plant' : 'plant link');
      if (existing) {
        existing.url = validated.toString();
        existing.canonicalUrl = canonicalUrl;
        existing.title = String(data.get('title') || safeHost(validated.toString())).trim();
        existing.bedId = String(data.get('bedId') || defaultBedId());
        existing.notes = String(data.get('notes') || '').trim();
        existing.speciesOverride = String(data.get('speciesOverride') || '');
        recordEvent(existing, 'prune', { label: 'Plant pruned', detail: 'Its title, label, address, bed, or species was updated.' });
        recordSnapshot(existing, now(), true);
      } else {
        const isCurrent = canonicalUrl === currentCanonicalUrl;
        const newLink = normalizeLink({
          id: uid(),
          url: validated.toString(),
          canonicalUrl,
          title: String(data.get('title') || safeHost(validated.toString())).trim(),
          bedId: String(data.get('bedId') || defaultBedId()),
          notes: String(data.get('notes') || '').trim(),
          speciesOverride: String(data.get('speciesOverride') || ''),
          visits: isCurrent ? 1 : 0,
          lastVisited: isCurrent ? now() : 0,
          createdAt: now()
        });
        if (isCurrent && !(newLink.events || []).some((event) => event.type === 'visit')) {
          recordEvent(newLink, 'visit', { label: 'First visit after planting', detail: 'The current page was planted while open.', count: 1 }, newLink.lastVisited);
        }
        newLink.lastHealth = plantProfile(newLink).health;
        recordSnapshot(newLink, now(), true);
        state.links.push(newLink);
        if (isCurrent) currentLinkId = newLink.id;
      }
      scheduleSave();
      closeDialog();
      updateLauncherState();
      render();
      showToast(existing ? 'Plant tended.' : 'Link planted.');
    });

    layer.querySelector('[data-archive-link]')?.addEventListener('click', () => {
      rememberChange(existing.archived ? 'restore plant' : 'compost plant');
      existing.archived = !existing.archived;
      recordEvent(existing, existing.archived ? 'archive' : 'restore', { label: existing.archived ? 'Moved to compost archive' : 'Restored to garden', detail: existing.archived ? 'Archived from the plant editor.' : `Returned to ${bedName(existing.bedId)}.` });
      scheduleSave();
      closeDialog();
      render();
      showToast(existing.archived ? 'Plant moved to the compost archive.' : 'Plant restored.');
    });

    layer.querySelector('[data-delete-link]')?.addEventListener('click', () => {
      if (!confirm(`Uproot “${existing.title}” from Link Garden?`)) return;
      rememberChange('uproot plant');
      state.links = state.links.filter((link) => link.id !== existing.id);
      if (currentLinkId === existing.id) currentLinkId = null;
      scheduleSave();
      closeDialog();
      updateLauncherState();
      render();
      showToast('Plant uprooted.');
    });
    setTimeout(() => form.querySelector(existing ? '[name="title"]' : '[name="url"]')?.focus(), 0);
  }

  function openBedDialog(bedId = null) {
    const existing = bedId ? state.beds.find((bed) => bed.id === bedId) : null;
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-dialog-small" data-dialog="bed">
          <div class="lg-dialog-head"><div><h3>${existing ? 'Tend garden bed' : 'Make a garden bed'}</h3><p>${existing ? 'Rename this collection or return its soil to the wild bed.' : 'Collections become distinct patches of the garden.'}</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <label>Bed name<input name="name" required maxlength="40" value="${escapeHTML(existing?.name || '')}" placeholder="Ideas, Long Reads, Workshop…"></label>
          <div class="lg-dialog-actions">
            ${existing ? '<button type="button" class="lg-danger" data-delete-bed>Remove bed</button>' : '<span></span>'}
            <span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">${existing ? 'Save bed' : 'Create bed'}</button>
          </div>
        </form>
      </div>
    `;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) return;
      rememberChange(existing ? 'rename garden bed' : 'create garden bed');
      if (existing) {
        existing.name = name;
      } else {
        const bed = { id: uid(), name, createdAt: now() };
        state.beds.push(bed);
        state.settings.selectedBed = bed.id;
      }
      scheduleSave();
      closeDialog();
      render();
      showToast(existing ? `Renamed bed to ${name}.` : `Created the ${name} bed.`);
    });

    layer.querySelector('[data-delete-bed]')?.addEventListener('click', () => {
      if (!existing) return;
      if (state.beds.length === 1) {
        showToast('Link Garden needs at least one garden bed.');
        return;
      }
      const replacement = state.beds.find((bed) => bed.id !== existing.id);
      const plantCount = state.links.filter((link) => link.bedId === existing.id).length;
      if (!confirm(`Remove “${existing.name}” and transplant ${plantCount} plants to “${replacement.name}”?`)) return;
      rememberChange('remove garden bed');
      state.links.forEach((link) => {
        if (link.bedId === existing.id) link.bedId = replacement.id;
      });
      state.beds = state.beds.filter((bed) => bed.id !== existing.id);
      if (state.settings.selectedBed === existing.id) state.settings.selectedBed = replacement.id;
      scheduleSave();
      closeDialog();
      render();
      showToast(`Removed ${existing.name}; its plants were transplanted.`);
    });
    setTimeout(() => form.querySelector('input')?.focus(), 0);
  }

  function bindDialogClose(layer) {
    layer.querySelectorAll('[data-dialog-close]').forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.currentTarget !== event.target && event.currentTarget.classList.contains('lg-dialog-backdrop')) return;
        closeDialog();
      });
    });
    layer.querySelector('.lg-dialog')?.addEventListener('click', (event) => event.stopPropagation());
  }

  function closeDialog() {
    const layer = shadow.querySelector('.lg-dialog-layer');
    if (layer) layer.innerHTML = '';
  }

  function openSavedLink(id) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    window.open(link.url, '_blank', 'noopener,noreferrer');
  }

  function openCultivationDialog() {
    const layer = shadow.querySelector('.lg-dialog-layer');
    const counts = smartBedCounts();
    const recovery = archivedRecoveryCandidates();
    const plan = autoCultivationPlan();
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <section class="lg-dialog lg-cultivation-dialog">
        <div class="lg-dialog-head"><div><h3>Cultivation Tools</h3><p>Turn a large bookmark collection into a garden you can actually tend.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
        <div class="lg-cultivation-kpis">
          <button data-smart-target="queue"><strong>${counts.queue}</strong><span>Reading queue</span></button>
          <button data-smart-target="rediscover"><strong>${counts.rediscover}</strong><span>Old friends</span></button>
          <button data-smart-target="seedtray"><strong>${counts.seedtray}</strong><span>Unvisited seeds</span></button>
          <button data-smart-target="repair"><strong>${counts.repair}</strong><span>Need repair</span></button>
        </div>
        <div class="lg-cultivation-grid">
          <article><span>✦</span><div><h4>Automatic grouping</h4><p>${plan.length} plants can be sorted into sensible beds by species, domain, or label.</p></div><button data-action="auto-organize">Preview</button></article>
          <article><span>🧭</span><div><h4>Rediscovery walk</h4><p>Open one neglected but once-used link and give it another chance to bloom.</p></div><button data-action="smart-surprise" ${counts.rediscover ? '' : 'disabled'}>Surprise me</button></article>
          <article><span>📚</span><div><h4>Reading queue</h4><p>Prioritize pages as Next, Soon, or Someday and mark them complete without deleting them.</p></div><button data-smart-target="queue">Open queue</button></article>
          <article><span>🛠</span><div><h4>Repair bench</h4><p>Retry mushrooms, test common replacement addresses, search for moved pages, or use the Wayback Machine.</p></div><button data-smart-target="repair">Open bench</button></article>
        </div>
        <section class="lg-recovery-section"><header><div><h4>Compost recovery</h4><p>Archived plants with signs of past value.</p></div><span>${recovery.length} suggestions</span></header>
          <div class="lg-recovery-list">${recovery.length ? recovery.map((link) => `<div><span>${plantProfile(link).emoji}</span><div><strong>${escapeHTML(link.title)}</strong><small>${link.visits} visits · ${relativeAge(link.lastVisited)}</small></div><button data-action="recover-link" data-id="${escapeHTML(link.id)}">Restore</button></div>`).join('') : '<p>No strong recovery candidates right now.</p>'}</div>
        </section>
        <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Close</button></div>
      </section>
    </div>`;
    bindDialogClose(layer);
    layer.querySelectorAll('[data-smart-target]').forEach((button) => button.addEventListener('click', () => {
      state.settings.selectedBed = button.dataset.smartTarget;
      state.settings.view = button.dataset.smartTarget === 'repair' || button.dataset.smartTarget === 'queue' ? 'nursery' : state.settings.view;
      scheduleSave(); closeDialog(); render();
    }));
    layer.querySelector('[data-action="auto-organize"]')?.addEventListener('click', openAutoOrganizeDialog);
    layer.querySelector('[data-action="smart-surprise"]')?.addEventListener('click', openRediscoverySurprise);
    layer.querySelectorAll('[data-action="recover-link"]').forEach((button) => button.addEventListener('click', () => recoverArchivedLink(button.dataset.id)));
  }

  function openRediscoverySurprise() {
    const candidates = state.links.filter(isRediscoveryCandidate);
    if (!candidates.length) return showToast('No neglected old friends are ready for rediscovery.');
    const weighted = [...candidates].sort((a, b) => (a.lastVisited || a.createdAt) - (b.lastVisited || b.createdAt));
    const pool = weighted.slice(0, Math.min(8, weighted.length));
    const choice = pool[Math.floor(Math.random() * pool.length)];
    closeDialog();
    showToast(`Rediscovering: ${choice.title}`);
    openSavedLink(choice.id);
  }

  function recoverArchivedLink(id) {
    const link = state.links.find((item) => item.id === id && item.archived);
    if (!link) return;
    rememberChange('recover composted plant');
    link.archived = false;
    recordEvent(link, 'restore', { label: 'Recovered from compost', detail: `Cultivation Tools restored it to ${bedName(link.bedId)}.` });
    scheduleSave();
    openCultivationDialog();
    showToast(`${link.title} restored.`);
  }

  function openQueueDialog(id) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <form class="lg-dialog lg-dialog-small" data-queue-form>
        <div class="lg-dialog-head"><div><h3>Reading Queue</h3><p>${escapeHTML(link.title)}</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
        <label>Queue status<select name="status">
          <option value="none" ${link.queueState === 'none' ? 'selected' : ''}>Not queued</option>
          <option value="queued" ${link.queueState === 'queued' ? 'selected' : ''}>Waiting to read</option>
          <option value="done" ${link.queueState === 'done' ? 'selected' : ''}>Completed</option>
        </select></label>
        <label>Priority<select name="priority">
          <option value="3" ${link.queuePriority === 3 ? 'selected' : ''}>Next</option>
          <option value="2" ${link.queuePriority === 2 ? 'selected' : ''}>Soon</option>
          <option value="1" ${link.queuePriority === 1 ? 'selected' : ''}>Someday</option>
        </select></label>
        <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Save queue</button></div>
      </form>
    </div>`;
    bindDialogClose(layer);
    layer.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const status = String(data.get('status') || 'none');
      const priority = clamp(Number(data.get('priority') || 2), 1, 3);
      const previous = link.queueState;
      rememberChange('update reading queue');
      link.queueState = status;
      link.queuePriority = priority;
      if (status === 'queued') {
        link.queuedAt = previous === 'queued' && link.queuedAt ? link.queuedAt : now();
        link.queueCompletedAt = 0;
        recordEvent(link, 'queue', { label: 'Added to reading queue', detail: `Priority set to ${queuePriorityLabel(priority)}.` });
      } else if (status === 'done') {
        link.queueCompletedAt = now();
        recordEvent(link, 'queue-done', { label: 'Reading completed', detail: 'Marked complete while preserving the plant and its history.' });
      } else if (previous !== 'none') {
        recordEvent(link, 'queue-remove', { label: 'Removed from reading queue', detail: 'The plant remains in its original garden bed.' });
      }
      scheduleSave(); closeDialog(); render(); showToast(status === 'queued' ? 'Added to the reading queue.' : status === 'done' ? 'Marked as read.' : 'Removed from the reading queue.');
    });
  }

  function openAutoOrganizeDialog() {
    const layer = shadow.querySelector('.lg-dialog-layer');
    const strategy = state.settings.cultivationStrategy;
    const plan = autoCultivationPlan(strategy);
    const groups = [...new Set(plan.map((item) => item.suggested))];
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <form class="lg-dialog lg-organize-dialog" data-organize-form>
        <div class="lg-dialog-head"><div><h3>Automatic Grouping</h3><p>Preview every move. Existing history, queue status, and plant positions remain intact.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
        <label>Grouping strategy<select name="strategy">
          <option value="species" ${strategy === 'species' ? 'selected' : ''}>By plant type and purpose</option>
          <option value="domain" ${strategy === 'domain' ? 'selected' : ''}>By website domain</option>
          <option value="tag" ${strategy === 'tag' ? 'selected' : ''}>By first suggested label</option>
        </select></label>
        <div class="lg-organize-summary"><div><strong>${plan.length}</strong><span>plants to move</span></div><div><strong>${groups.length}</strong><span>destination beds</span></div></div>
        <div class="lg-organize-list">${plan.length ? plan.slice(0, 80).map((item) => `<label><input type="checkbox" name="move" value="${escapeHTML(item.link.id)}" checked><span>${plantProfile(item.link).emoji}</span><div><strong>${escapeHTML(item.link.title)}</strong><small>${escapeHTML(item.current)} → ${escapeHTML(item.suggested)}</small></div></label>`).join('') : '<p>The garden already matches this cultivation strategy.</p>'}</div>
        ${plan.length > 80 ? `<p class="lg-import-limit">Showing 80 of ${plan.length} proposed moves. All are selected by default.</p>` : ''}
        <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit" ${plan.length ? '' : 'disabled'}>Cultivate selected</button></div>
      </form>
    </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.querySelector('[name="strategy"]').addEventListener('change', (event) => {
      state.settings.cultivationStrategy = event.target.value;
      scheduleSave();
      openAutoOrganizeDialog();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const ids = new Set(new FormData(form).getAll('move').map(String));
      const currentPlan = autoCultivationPlan(state.settings.cultivationStrategy).filter((item) => ids.has(item.link.id));
      if (!currentPlan.length) return showToast('Select at least one plant to cultivate.');
      rememberChange('automatically organize garden');
      const bedMap = new Map(state.beds.map((bed) => [bed.name.toLowerCase(), bed]));
      let created = 0;
      currentPlan.forEach((item, index) => {
        const key = item.suggested.toLowerCase();
        let bed = bedMap.get(key);
        if (!bed) {
          bed = { id: uid(), name: item.suggested, createdAt: now() };
          state.beds.push(bed); bedMap.set(key, bed); created += 1;
        }
        const from = item.link.bedId;
        item.link.bedId = bed.id;
        item.link.gardenX = 10 + stableFraction(item.link.id, now() + index) * 80;
        item.link.gardenY = 18 + stableFraction(item.link.id, now() + index + 71) * 60;
        recordEvent(item.link, 'organize', { label: 'Automatically cultivated', detail: `${bedName(from)} → ${bed.name} using ${state.settings.cultivationStrategy} grouping.`, from, to: bed.id, bedId: bed.id });
      });
      state.settings.selectedBed = 'all';
      scheduleSave(); closeDialog(); render(); showToast(`${currentPlan.length} plants cultivated; ${created} beds created.`);
    });
  }

  function openRepairDialog(id) {
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    const candidates = deadLinkCandidates(link);
    const layer = shadow.querySelector('.lg-dialog-layer');
    const archiveUrl = `https://web.archive.org/web/*/${encodeURIComponent(link.url)}`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`\"${link.title}\" ${safeHost(link.url)}`)}`;
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <form class="lg-dialog lg-repair-dialog" data-repair-form>
        <div class="lg-dialog-head"><div><h3>Repair Bench</h3><p>${escapeHTML(link.title)}</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
        <div class="lg-repair-status ${link.dead ? 'is-dead' : 'is-alive'}"><span>${link.dead ? '🍄' : '🌿'}</span><div><strong>${link.dead ? 'Currently a mushroom' : 'Currently responding'}</strong><small>${link.lastChecked ? `Last checked ${relativeAge(link.lastChecked)}${link.statusCode ? ` · HTTP ${link.statusCode}` : ''}` : 'Not checked yet'}</small></div><button type="button" data-retry-health>Retry</button></div>
        <label>Replacement address<input name="url" type="url" required value="${escapeHTML(link.url)}"></label>
        <div class="lg-repair-candidates">${candidates.map((candidate) => `<button type="button" data-candidate-url="${escapeHTML(candidate.url)}"><strong>${escapeHTML(candidate.label)}</strong><small>${escapeHTML(candidate.note)}</small></button>`).join('') || '<p>No automatic address variations were available.</p>'}</div>
        <div class="lg-repair-links"><a href="${escapeHTML(archiveUrl)}" target="_blank" rel="noopener noreferrer">◷ Search Wayback Machine</a><a href="${escapeHTML(searchUrl)}" target="_blank" rel="noopener noreferrer">⌕ Search for moved page</a></div>
        <p class="lg-repair-result" data-repair-result>Test a replacement before saving, or save a known-good address directly.</p>
        <div class="lg-dialog-actions"><button type="button" data-test-replacement>Test address</button><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Use replacement</button></div>
      </form>
    </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    const input = form.querySelector('[name="url"]');
    const result = form.querySelector('[data-repair-result]');
    form.querySelectorAll('[data-candidate-url]').forEach((button) => button.addEventListener('click', () => { input.value = button.dataset.candidateUrl; result.textContent = 'Candidate loaded. Test it before saving.'; }));
    const testUrl = async (url) => {
      result.textContent = 'Testing address…';
      try {
        const response = await requestLinkStatus(url);
        const alive = response.status > 0 && response.status < 400;
        result.textContent = alive ? `Responded successfully with HTTP ${response.status}.` : `The address returned HTTP ${response.status || 0}.`;
        result.dataset.status = alive ? 'alive' : 'dead';
        return alive;
      } catch { result.textContent = 'The address did not respond.'; result.dataset.status = 'dead'; return false; }
    };
    form.querySelector('[data-test-replacement]').addEventListener('click', () => testUrl(input.value));
    form.querySelector('[data-retry-health]').addEventListener('click', async () => {
      const alive = await testUrl(link.url);
      link.lastChecked = now();
      link.dead = !alive;
      if (alive) { link.statusCode = 200; link.lastHealth = 'healthy'; recordEvent(link, 'revived', { label: 'Link revived at repair bench', detail: 'The original address responded during a retry.' }); }
      scheduleSave();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      let parsed;
      try { parsed = new URL(input.value); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { return showToast('Enter a complete http or https address.'); }
      const canonical = canonicalize(parsed.toString());
      const duplicate = state.links.find((item) => item.id !== link.id && item.canonicalUrl === canonical);
      if (duplicate) return showToast('That replacement is already planted elsewhere.');
      rememberChange('repair dead link');
      const oldUrl = link.url;
      link.previousUrl = oldUrl;
      link.url = parsed.toString();
      link.canonicalUrl = canonical;
      link.dead = false;
      link.statusCode = 0;
      link.lastChecked = 0;
      link.repairedAt = now();
      link.lastHealth = plantProfile(link).health;
      recordEvent(link, 'repair', { label: 'Destination repaired', detail: `${oldUrl} → ${link.url}` });
      scheduleSave(); closeDialog(); updateLauncherState(); render(); showToast('Link repaired and returned to the garden.');
    });
  }

  function ecologySelectOption(value, current, label) {
    return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
  }

  function openEcologyDialog() {
    const layer = shadow.querySelector('.lg-dialog-layer');
    const ecology = ecologyState();
    layer.innerHTML = `<div class="lg-dialog-backdrop" data-dialog-close>
      <form class="lg-dialog lg-ecology-dialog" data-ecology-form>
        <div class="lg-dialog-head">
          <div><h3>Garden Ecology</h3><p>Decorative ambience only. Link vitality and history remain unchanged.</p></div>
          <button type="button" class="lg-icon-button" data-dialog-close>×</button>
        </div>
        <div class="lg-ecology-preview season-${ecology.season} time-${ecology.time} weather-${ecology.weather}">
          <span>${ecologySkyIcon(ecology)}</span><strong>${escapeHTML(ecologyLabel(ecology))}</strong><em>🌳 🌻 🌿 🐝</em>
        </div>
        <label class="lg-switch-row"><span><b>Living ecology</b><small>Enable seasonal scenery and ambience.</small></span><input type="checkbox" name="enabled" ${state.settings.ecologyEnabled ? 'checked' : ''}></label>
        <div class="lg-ecology-grid">
          <label>Season<select name="season">
            ${ecologySelectOption('auto', state.settings.ecologySeason, 'Automatic from date')}
            ${ecologySelectOption('spring', state.settings.ecologySeason, 'Spring')}
            ${ecologySelectOption('summer', state.settings.ecologySeason, 'Summer')}
            ${ecologySelectOption('autumn', state.settings.ecologySeason, 'Autumn')}
            ${ecologySelectOption('winter', state.settings.ecologySeason, 'Winter')}
          </select></label>
          <label>Hemisphere<select name="hemisphere">
            ${ecologySelectOption('north', state.settings.ecologyHemisphere, 'Northern')}
            ${ecologySelectOption('south', state.settings.ecologyHemisphere, 'Southern')}
          </select></label>
          <label>Time of day<select name="time">
            ${ecologySelectOption('auto', state.settings.ecologyTime, 'Automatic from clock')}
            ${ecologySelectOption('day', state.settings.ecologyTime, 'Day')}
            ${ecologySelectOption('dusk', state.settings.ecologyTime, 'Dusk')}
            ${ecologySelectOption('night', state.settings.ecologyTime, 'Night')}
          </select></label>
          <label>Micro-weather<select name="weather">
            ${ecologySelectOption('auto', state.settings.ecologyWeather, 'Automatic daily pattern')}
            ${ecologySelectOption('clear', state.settings.ecologyWeather, 'Clear')}
            ${ecologySelectOption('cloudy', state.settings.ecologyWeather, 'Cloudy')}
            ${ecologySelectOption('rain', state.settings.ecologyWeather, 'Rain')}
            ${ecologySelectOption('breeze', state.settings.ecologyWeather, 'Breeze')}
          </select></label>
        </div>
        <label class="lg-switch-row"><span><b>Pollinators and visitors</b><small>Bees and butterflies by day, fireflies at night.</small></span><input type="checkbox" name="pollinators" ${state.settings.ecologyPollinators ? 'checked' : ''}></label>
        <label class="lg-switch-row"><span><b>Ambient motion</b><small>Plant sway, rain, drifting leaves, and moving visitors.</small></span><input type="checkbox" name="motion" ${state.settings.ecologyMotion ? 'checked' : ''}></label>
        <p class="lg-ecology-note">Automatic weather is a calm, deterministic garden microclimate based on the date. It does not use your location or an online weather service.</p>
        <div class="lg-dialog-actions"><button type="button" data-action="ecology-reset">Reset automatic</button><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Apply ecology</button></div>
      </form>
    </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('[data-ecology-form]');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      state.settings.ecologyEnabled = data.get('enabled') === 'on';
      state.settings.ecologySeason = String(data.get('season') || 'auto');
      state.settings.ecologyHemisphere = String(data.get('hemisphere') || 'north');
      state.settings.ecologyTime = String(data.get('time') || 'auto');
      state.settings.ecologyWeather = String(data.get('weather') || 'auto');
      state.settings.ecologyPollinators = data.get('pollinators') === 'on';
      state.settings.ecologyMotion = data.get('motion') === 'on';
      scheduleSave();
      closeDialog();
      render();
      showToast(`Ecology set to ${ecologyLabel()}.`);
    });
    layer.querySelector('[data-action="ecology-reset"]')?.addEventListener('click', () => {
      state.settings.ecologyEnabled = true;
      state.settings.ecologySeason = 'auto';
      state.settings.ecologyHemisphere = 'north';
      state.settings.ecologyTime = 'auto';
      state.settings.ecologyWeather = 'auto';
      state.settings.ecologyPollinators = true;
      state.settings.ecologyMotion = true;
      scheduleSave();
      closeDialog();
      render();
      showToast('Garden ecology returned to automatic settings.');
    });
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    scheduleSave();
    applyTheme();
    showToast(`Theme: ${state.settings.theme}`);
  }

  function applyTheme() {
    const shell = shadow?.querySelector('.lg-shell');
    if (!shell) return;
    shell.dataset.theme = state.settings.theme;
  }

  async function checkAllLinks() {
    const activeLinks = state.links.filter((link) => !link.archived);
    if (checkingDeadLinks || !activeLinks.length) {
      if (!activeLinks.length) showToast('Plant a few active links before checking their health.');
      return;
    }
    checkingDeadLinks = true;
    render();
    let deadCount = 0;

    for (let index = 0; index < activeLinks.length; index += 1) {
      const link = activeLinks[index];
      const wasDead = link.dead;
      const previousHealth = plantProfile(link).health;
      showToast(`Checking ${index + 1} of ${activeLinks.length}: ${link.title}`);
      try {
        const result = await requestLinkStatus(link.url);
        link.lastChecked = now();
        link.statusCode = result.status;
        link.dead = result.status >= 400 || result.status === 0;
      } catch {
        link.lastChecked = now();
        link.statusCode = 0;
        link.dead = true;
      }
      if (link.dead !== wasDead) {
        recordEvent(link, link.dead ? 'dead' : 'revived', {
          label: link.dead ? 'Became a mushroom' : 'Link revived',
          detail: link.dead ? (link.statusCode ? `Health check returned HTTP ${link.statusCode}.` : 'The page did not respond to its health check.') : `Health check returned HTTP ${link.statusCode}.`,
          from: wasDead ? 'dead' : previousHealth,
          to: link.dead ? 'dead' : 'healthy',
          health: link.dead ? 'dead' : 'healthy'
        });
      }
      link.lastHealth = plantProfile(link).health;
      recordSnapshot(link, now(), true);
      if (link.dead) deadCount += 1;
      scheduleSave();
    }

    checkingDeadLinks = false;
    render();
    showToast(deadCount ? `${deadCount} dead ${deadCount === 1 ? 'link became a mushroom' : 'links became mushrooms'}.` : 'Every checked link is alive.');
  }

  function requestLinkStatus(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'HEAD',
        url,
        timeout: 12_000,
        anonymous: true,
        onload: (response) => {
          if ([405, 501].includes(response.status)) {
            GM_xmlhttpRequest({
              method: 'GET',
              url,
              timeout: 12_000,
              anonymous: true,
              headers: { Range: 'bytes=0-0' },
              onload: (fallback) => resolve({ status: fallback.status || 0 }),
              onerror: reject,
              ontimeout: reject
            });
          } else {
            resolve({ status: response.status || 0 });
          }
        },
        onerror: reject,
        ontimeout: reject
      });
    });
  }

  function exportGarden() {
    const payload = {
      app: APP_NAME,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      data: state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `link-garden-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Atlas backup exported.');
  }

  function openDataCenter() {
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <section class="lg-dialog lg-import-center">
          <div class="lg-dialog-head"><div><h3>Atlas data</h3><p>Share one garden, protect the complete atlas, or bring more links inside.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <div class="lg-import-choices lg-data-choices">
            <button type="button" class="lg-import-choice" data-action="share-garden"><span>🗺️</span><div><strong>Share active garden</strong><p>Create a standalone read-only HTML garden with optional notes and metrics.</p><em>Portable HTML</em></div></button>
            <button type="button" class="lg-import-choice" data-action="export"><span>🧰</span><div><strong>Back up Garden Atlas</strong><p>Save every garden, snapshot, bed, setting, plant, and journal event.</p><em>Complete JSON backup</em></div></button>
            <button type="button" class="lg-import-choice" data-action="import"><span>🌱</span><div><strong>Import or restore</strong><p>Restore an atlas backup or migrate a browser bookmark HTML file.</p><em>JSON or browser bookmarks</em></div></button>
          </div>
          <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Close</button></div>
        </section>
      </div>`;
    bindDialogClose(layer);
  }

  function openImportCenter() {
    pendingBookmarkImport = null;
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <section class="lg-dialog lg-import-center">
          <div class="lg-dialog-head">
            <div><h3>Bring links into the garden</h3><p>Restore a Link Garden atlas backup or cultivate a browser bookmark export.</p></div>
            <button type="button" class="lg-icon-button" data-dialog-close>×</button>
          </div>
          <div class="lg-import-choices">
            <button type="button" class="lg-import-choice" data-action="import-bookmarks">
              <span>🌳</span><div><strong>Browser bookmarks</strong><p>Import Chrome, Edge, Firefox, Safari, or another Netscape-format bookmark HTML file. Folders can become garden beds.</p><em>Merge into this garden</em></div>
            </button>
            <button type="button" class="lg-import-choice" data-action="import-json">
              <span>🪴</span><div><strong>Link Garden backup</strong><p>Restore a JSON export created by Link Garden, including beds, history, visits, and settings.</p><em>Replaces this atlas</em></div>
            </button>
          </div>
          <div class="lg-import-help"><strong>How to export browser bookmarks</strong><p>Open your browser’s bookmark manager and choose <b>Export bookmarks</b>. Select the resulting <code>.html</code> file here.</p></div>
          <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Close</button></div>
        </section>
      </div>`;
    bindDialogClose(layer);
  }

  function importGardenBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const imported = parsed.data || parsed;
        const next = migrateState(imported);
        if (!confirm(`Replace the current atlas with ${next.links.length} links in its active garden?`)) return;
        state = next;
        pendingBookmarkImport = null;
        currentLinkId = state.links.find((link) => link.canonicalUrl === currentCanonicalUrl)?.id || null;
        scheduleSave();
        updateLauncherState();
        render();
        showToast('Garden Atlas backup restored.');
      } catch (error) {
        console.error('[Link Garden] Import failed.', error);
        showToast('That file is not a valid Link Garden export.');
      }
    };
    reader.readAsText(file);
  }

  function readBrowserBookmarkFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseBrowserBookmarks(String(reader.result));
        if (!parsed.items.length) {
          showToast('No web bookmarks were found in that HTML file.');
          return;
        }
        pendingBookmarkImport = {
          fileName: file.name,
          items: parsed.items,
          unsupported: parsed.unsupported,
          folderCount: parsed.folderCount,
          options: {
            folderMode: state.settings.importFolderMode,
            duplicateMode: state.settings.importDuplicateMode,
            applySuggestions: state.settings.importApplySuggestions
          }
        };
        syncBookmarkDuplicateSelection(true);
        openBookmarkImportPreview();
      } catch (error) {
        console.error('[Link Garden] Bookmark import failed.', error);
        showToast('That file does not look like a browser bookmark export.');
      }
    };
    reader.readAsText(file);
  }

  function parseBrowserBookmarks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('dl') || doc.body;
    const items = [];
    let unsupported = 0;
    const folderNames = new Set();

    function addBookmark(anchor, path) {
      const rawUrl = String(anchor.getAttribute('href') || '').trim();
      let parsedUrl;
      try { parsedUrl = new URL(rawUrl); } catch { unsupported += 1; return; }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) { unsupported += 1; return; }
      const cleanPath = path.map((part) => String(part || '').trim()).filter(Boolean);
      cleanPath.forEach((part) => folderNames.add(part));
      const canonicalUrl = canonicalize(parsedUrl.toString());
      const addDateValue = Number(anchor.getAttribute('add_date') || anchor.getAttribute('ADD_DATE') || 0);
      const rawTags = String(anchor.getAttribute('tags') || anchor.getAttribute('TAGS') || '');
      const title = String(anchor.textContent || '').trim() || suggestedBookmarkTitle(parsedUrl);
      const item = {
        id: uid(),
        url: parsedUrl.toString(),
        canonicalUrl,
        title,
        path: cleanPath,
        addedAt: addDateValue > 0 ? (addDateValue < 10_000_000_000 ? addDateValue * 1000 : addDateValue) : 0,
        tags: rawTags.split(',').map((tag) => tag.trim()).filter(Boolean),
        suggestedTags: [],
        duplicateInGarden: false,
        duplicateInFile: false,
        selected: true
      };
      item.suggestedTags = bookmarkTagSuggestions(item);
      items.push(item);
    }

    function walk(container, path = []) {
      let pendingFolder = '';
      [...container.children].forEach((child) => {
        const tag = child.tagName.toLowerCase();
        if (tag === 'dt') {
          const direct = [...child.children];
          const heading = direct.find((node) => node.tagName?.toLowerCase() === 'h3');
          const anchor = direct.find((node) => node.tagName?.toLowerCase() === 'a');
          const nested = direct.find((node) => node.tagName?.toLowerCase() === 'dl');
          if (anchor) addBookmark(anchor, path);
          if (heading) {
            const folder = String(heading.textContent || '').trim() || 'Untitled Folder';
            if (nested) {
              walk(nested, [...path, folder]);
              pendingFolder = '';
            } else {
              pendingFolder = folder;
            }
          } else if (nested) {
            walk(nested, path);
          }
          direct.filter((node) => node.tagName?.toLowerCase() === 'p').forEach((node) => walk(node, path));
          return;
        }
        if (tag === 'h3') {
          pendingFolder = String(child.textContent || '').trim() || 'Untitled Folder';
          return;
        }
        if (tag === 'a') {
          addBookmark(child, path);
          return;
        }
        if (tag === 'dl') {
          walk(child, pendingFolder ? [...path, pendingFolder] : path);
          pendingFolder = '';
          return;
        }
        if (tag === 'p') walk(child, path);
      });
    }

    walk(root, []);
    const seen = new Set();
    const gardenUrls = new Set(state.links.map((link) => link.canonicalUrl));
    items.forEach((item) => {
      item.duplicateInGarden = gardenUrls.has(item.canonicalUrl);
      item.duplicateInFile = seen.has(item.canonicalUrl);
      if (!item.duplicateInFile) seen.add(item.canonicalUrl);
      item.selected = !item.duplicateInGarden && !item.duplicateInFile;
    });
    return { items, unsupported, folderCount: folderNames.size };
  }

  function suggestedBookmarkTitle(url) {
    const host = url.hostname.replace(/^www\./, '');
    const lastPart = url.pathname.split('/').filter(Boolean).at(-1) || '';
    const decoded = decodeURIComponent(lastPart).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
    return decoded ? decoded.replace(/\b\w/g, (letter) => letter.toUpperCase()) : host || 'Imported Bookmark';
  }

  function meaningfulBookmarkFolders(path) {
    const generic = /^(bookmarks?|favorites?|bookmarks bar|bookmarks toolbar|favorites bar|other bookmarks|mobile bookmarks|bookmarks menu|imported)$/i;
    return path.map((part) => part.trim()).filter((part) => part && !generic.test(part));
  }

  function bookmarkTagSuggestions(item) {
    const folders = meaningfulBookmarkFolders(item.path).slice(-2);
    const host = safeHost(item.url).toLowerCase();
    const hostParts = host.split('.').filter(Boolean);
    let domainTag = hostParts.length > 1 ? hostParts.at(-2) : hostParts[0];
    if (['co', 'com', 'org', 'net', 'gov', 'edu'].includes(domainTag) && hostParts.length > 2) domainTag = hostParts.at(-3);
    const species = linkSpecies({ title: item.title, url: item.url, notes: '', speciesOverride: '' });
    return [...new Set([...item.tags, ...folders, species, domainTag].map((tag) => String(tag || '').trim()).filter(Boolean))].slice(0, 6);
  }

  function bookmarkBedName(item, mode = state.settings.importFolderMode) {
    const folders = meaningfulBookmarkFolders(item.path);
    if (mode === 'single' || !folders.length) return 'Imported Bookmarks';
    if (mode === 'top') return folders[0].slice(0, 64);
    if (mode === 'path') return folders.join(' › ').slice(0, 90);
    return folders.at(-1).slice(0, 64);
  }

  function syncBookmarkDuplicateSelection(initial = false) {
    if (!pendingBookmarkImport) return;
    const mode = pendingBookmarkImport.options.duplicateMode;
    pendingBookmarkImport.items.forEach((item) => {
      if (mode === 'keep') {
        if (initial || item.duplicateInGarden || item.duplicateInFile) item.selected = true;
      } else if (mode === 'merge') {
        if (initial || item.duplicateInGarden) item.selected = !item.duplicateInFile;
      } else if (item.duplicateInGarden || item.duplicateInFile) {
        item.selected = false;
      }
    });
  }

  function openBookmarkImportPreview() {
    if (!pendingBookmarkImport) return openImportCenter();
    const layer = shadow.querySelector('.lg-dialog-layer');
    const data = pendingBookmarkImport;
    const duplicateGarden = data.items.filter((item) => item.duplicateInGarden).length;
    const duplicateFile = data.items.filter((item) => item.duplicateInFile).length;
    const selected = data.items.filter((item) => item.selected).length;
    const previewItems = data.items.slice(0, 500);
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-import-preview" data-dialog="bookmark-import">
          <div class="lg-dialog-head">
            <div><h3>Cultivate browser bookmarks</h3><p>${escapeHTML(data.fileName)} · review the seedlings before planting.</p></div>
            <button type="button" class="lg-icon-button" data-dialog-close>×</button>
          </div>
          <div class="lg-import-summary">
            <div><strong>${data.items.length}</strong><span>web bookmarks</span></div>
            <div><strong>${data.folderCount}</strong><span>source folders</span></div>
            <div><strong>${duplicateGarden}</strong><span>already planted</span></div>
            <div><strong>${selected}</strong><span>selected</span></div>
          </div>
          <div class="lg-import-options">
            <label>Turn folders into beds<select name="folderMode" data-import-option>
              ${bookmarkImportOption('leaf', 'Leaf folders become beds', data.options.folderMode)}
              ${bookmarkImportOption('path', 'Full folder paths become beds', data.options.folderMode)}
              ${bookmarkImportOption('top', 'Top-level folders become beds', data.options.folderMode)}
              ${bookmarkImportOption('single', 'Put everything in one bed', data.options.folderMode)}
            </select></label>
            <label>When a link already exists<select name="duplicateMode" data-import-option>
              ${bookmarkImportOption('skip', 'Skip duplicates', data.options.duplicateMode)}
              ${bookmarkImportOption('merge', 'Merge suggested labels', data.options.duplicateMode)}
              ${bookmarkImportOption('keep', 'Keep another copy', data.options.duplicateMode)}
            </select></label>
            <label class="lg-import-check"><input type="checkbox" name="applySuggestions" data-import-option ${data.options.applySuggestions ? 'checked' : ''}><span>Apply suggested labels from folders, domains, and plant type</span></label>
          </div>
          <div class="lg-import-selection-tools">
            <strong>${selected} selected</strong><span></span>
            <button type="button" data-action="bookmark-select-new">Select new</button>
            <button type="button" data-action="bookmark-select-all">Select all</button>
            <button type="button" data-action="bookmark-select-none">Clear</button>
          </div>
          <div class="lg-import-list">
            ${previewItems.map(renderBookmarkImportRow).join('')}
          </div>
          ${data.items.length > previewItems.length ? `<p class="lg-import-limit">Showing the first ${previewItems.length} bookmarks. Selection rules still apply to all ${data.items.length}.</p>` : ''}
          ${(duplicateFile || data.unsupported) ? `<p class="lg-import-note">${duplicateFile ? `${duplicateFile} duplicate ${duplicateFile === 1 ? 'entry appears' : 'entries appear'} inside the file. ` : ''}${data.unsupported ? `${data.unsupported} non-web or invalid ${data.unsupported === 1 ? 'bookmark was' : 'bookmarks were'} ignored.` : ''}</p>` : ''}
          <div class="lg-dialog-actions"><button type="button" data-action="bookmark-back">Back</button><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit" ${selected ? '' : 'disabled'}>Plant ${selected} bookmarks</button></div>
        </form>
      </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', commitBrowserBookmarkImport);
    form.querySelectorAll('[data-import-option]').forEach((control) => control.addEventListener('change', handleBookmarkImportOption));
    form.querySelectorAll('[data-bookmark-import-id]').forEach((control) => control.addEventListener('change', (event) => {
      const item = pendingBookmarkImport?.items.find((entry) => entry.id === event.target.dataset.bookmarkImportId);
      if (item) item.selected = event.target.checked;
      openBookmarkImportPreview();
    }));
  }

  function bookmarkImportOption(value, label, selected) {
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHTML(label)}</option>`;
  }

  function renderBookmarkImportRow(item) {
    const duplicate = item.duplicateInGarden ? 'Already planted' : item.duplicateInFile ? 'Repeated in file' : 'New seedling';
    const statusClass = item.duplicateInGarden || item.duplicateInFile ? 'is-duplicate' : 'is-new';
    const tags = item.suggestedTags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join('');
    return `<label class="lg-import-row ${statusClass}">
      <input type="checkbox" data-bookmark-import-id="${escapeHTML(item.id)}" ${item.selected ? 'checked' : ''}>
      <span class="lg-import-row-icon">${speciesEmoji(linkSpecies({ title: item.title, url: item.url, notes: '', speciesOverride: '' }), 'seed', false, 'healthy')}</span>
      <span class="lg-import-row-main"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(safeHost(item.url))} · ${escapeHTML(bookmarkBedName(item, pendingBookmarkImport.options.folderMode))}</small><em>${tags}</em></span>
      <b>${duplicate}</b>
    </label>`;
  }

  function handleBookmarkImportOption(event) {
    if (!pendingBookmarkImport) return;
    const { name } = event.target;
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    if (name === 'folderMode') pendingBookmarkImport.options.folderMode = value;
    if (name === 'duplicateMode') {
      pendingBookmarkImport.options.duplicateMode = value;
      syncBookmarkDuplicateSelection(true);
    }
    if (name === 'applySuggestions') pendingBookmarkImport.options.applySuggestions = value;
    state.settings.importFolderMode = pendingBookmarkImport.options.folderMode;
    state.settings.importDuplicateMode = pendingBookmarkImport.options.duplicateMode;
    state.settings.importApplySuggestions = pendingBookmarkImport.options.applySuggestions;
    scheduleSave();
    openBookmarkImportPreview();
  }

  function setBookmarkImportSelection(mode) {
    if (!pendingBookmarkImport) return;
    pendingBookmarkImport.items.forEach((item) => {
      if (mode === 'none') item.selected = false;
      else if (mode === 'all') item.selected = true;
      else item.selected = !item.duplicateInGarden && !item.duplicateInFile;
    });
    openBookmarkImportPreview();
  }

  function commitBrowserBookmarkImport(event) {
    event.preventDefault();
    if (!pendingBookmarkImport) return;
    const selected = pendingBookmarkImport.items.filter((item) => item.selected);
    if (!selected.length) return showToast('Select at least one bookmark to plant.');
    rememberChange('import browser bookmarks');
    const options = pendingBookmarkImport.options;
    const bedByName = new Map(state.beds.map((bed) => [bed.name.trim().toLowerCase(), bed]));
    const linkByUrl = new Map(state.links.map((link) => [link.canonicalUrl, link]));
    let planted = 0;
    let merged = 0;
    let skipped = 0;
    let bedsCreated = 0;

    function bedFor(item) {
      const name = bookmarkBedName(item, options.folderMode);
      const key = name.toLowerCase();
      if (bedByName.has(key)) return bedByName.get(key);
      const bed = { id: uid(), name, createdAt: now() };
      state.beds.push(bed);
      bedByName.set(key, bed);
      bedsCreated += 1;
      return bed;
    }

    selected.forEach((item) => {
      const existing = linkByUrl.get(item.canonicalUrl);
      if (existing && options.duplicateMode === 'skip') { skipped += 1; return; }
      const labels = options.applySuggestions ? item.suggestedTags : item.tags;
      if (existing && options.duplicateMode === 'merge') {
        existing.tags = [...new Set([...(existing.tags || []), ...labels])];
        existing.importedAt = now();
        existing.importSource = 'browser-bookmarks';
        existing.importPath = item.path;
        recordEvent(existing, 'import-update', {
          label: 'Browser labels merged',
          detail: item.path.length ? `Merged labels from ${item.path.join(' › ')}.` : 'Merged labels from a browser bookmark export.'
        });
        merged += 1;
        return;
      }
      const bed = bedFor(item);
      const importedAt = now();
      const link = normalizeLink({
        id: uid(),
        url: item.url,
        canonicalUrl: item.canonicalUrl,
        title: item.title,
        bedId: bed.id,
        notes: '',
        tags: labels,
        createdAt: item.addedAt || importedAt,
        lastVisited: 0,
        previousVisited: 0,
        visits: 0,
        importedAt,
        importSource: 'browser-bookmarks',
        importPath: item.path
      });
      recordEvent(link, 'import', {
        label: 'Imported from browser bookmarks',
        detail: item.path.length ? `Cultivated from ${item.path.join(' › ')} into ${bed.name}.` : `Cultivated into ${bed.name}.`,
        bedId: bed.id
      }, importedAt);
      recordSnapshot(link, importedAt, true);
      state.links.push(link);
      if (!existing) linkByUrl.set(link.canonicalUrl, link);
      planted += 1;
    });

    state.settings.selectedBed = 'all';
    state.settings.view = 'nursery';
    selectedLinkIds.clear();
    const report = { planted, merged, skipped, bedsCreated, fileName: pendingBookmarkImport.fileName };
    pendingBookmarkImport = null;
    scheduleSave();
    updateLauncherState();
    render();
    setTimeout(() => openBookmarkImportReport(report), 0);
  }

  function openBookmarkImportReport(report) {
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <section class="lg-dialog lg-dialog-small lg-import-report">
          <div class="lg-dialog-head"><div><h3>Bookmark garden cultivated</h3><p>${escapeHTML(report.fileName)}</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <div class="lg-import-summary">
            <div><strong>${report.planted}</strong><span>new plants</span></div>
            <div><strong>${report.merged}</strong><span>labels merged</span></div>
            <div><strong>${report.bedsCreated}</strong><span>beds created</span></div>
            <div><strong>${report.skipped}</strong><span>duplicates skipped</span></div>
          </div>
          <p class="lg-import-complete">Your imported bookmarks are ready in Nursery View. Their original folder labels and import event are preserved in each plant’s history.</p>
          <div class="lg-dialog-actions"><span></span><button class="lg-primary" type="button" data-dialog-close>Explore nursery</button></div>
        </section>
      </div>`;
    bindDialogClose(layer);
  }

  function activateGardenData(id, view = 'garden') {
    const atlas = state.atlas;
    const meta = atlas.gardens.find((garden) => garden.id === id);
    if (!meta) return false;
    const data = normalizeGardenDataset(atlas.gardenData[id] || {});
    atlas.activeGardenId = id;
    data.settings.view = view;
    state = { ...data, schema: 7, atlas };
    selectedLinkIds.clear();
    currentLinkId = state.links.find((link) => link.canonicalUrl === currentCanonicalUrl)?.id || null;
    scheduleSave();
    updateLauncherState();
    render();
    return true;
  }

  function switchGarden(id) {
    if (!state.atlas.gardens.some((garden) => garden.id === id)) return;
    if (id === state.atlas.activeGardenId) {
      state.settings.view = 'garden';
      scheduleSave();
      render();
      return;
    }
    syncActiveGardenData();
    const name = state.atlas.gardens.find((garden) => garden.id === id)?.name || 'garden';
    if (activateGardenData(id, 'garden')) showToast(`Opened ${name}.`);
  }

  function openGardenDialog(gardenId = null) {
    const existing = gardenId ? state.atlas.gardens.find((garden) => garden.id === gardenId) : null;
    const layer = shadow.querySelector('.lg-dialog-layer');
    const icons = ['🌿', '🌳', '🌻', '🌵', '🪴', '🍄', '🌾', '🌺', '🧭', '📚', '🛠️', '✨'];
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-garden-dialog" data-dialog="garden">
          <div class="lg-dialog-head"><div><h3>${existing ? 'Edit atlas garden' : 'Create atlas garden'}</h3><p>${existing ? 'Rename this garden or clarify what belongs here.' : 'Start with fresh soil or duplicate the active garden.'}</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <div class="lg-garden-dialog-grid">
            <label>Garden name<input name="name" maxlength="70" required value="${escapeHTML(existing?.name || '')}" placeholder="Research Grove"></label>
            <label>Garden marker<select name="emoji">${icons.map((icon) => `<option value="${icon}" ${icon === (existing?.emoji || '🌿') ? 'selected' : ''}>${icon}</option>`).join('')}</select></label>
          </div>
          <label>Description<textarea name="description" rows="3" maxlength="260" placeholder="What kinds of links grow in this garden?">${escapeHTML(existing?.description || '')}</textarea></label>
          ${existing ? '' : `<fieldset class="lg-garden-starter"><legend>Starting soil</legend><label><input type="radio" name="starter" value="blank" checked><span><b>Fresh garden</b><small>Two empty beds, ready for a distinct collection.</small></span></label><label><input type="radio" name="starter" value="duplicate"><span><b>Duplicate active garden</b><small>Copy its beds, plants, notes, and history into an independent garden.</small></span></label></fieldset>`}
          <div class="lg-dialog-actions">${existing && state.atlas.gardens.length > 1 ? '<button type="button" class="lg-danger" data-garden-delete>Delete garden</button>' : '<span></span>'}<button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">${existing ? 'Save garden' : 'Create garden'}</button></div>
        </form>
      </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const name = String(formData.get('name') || '').trim();
      if (!name) return;
      const description = String(formData.get('description') || '').trim();
      const emoji = String(formData.get('emoji') || '🌿');
      if (existing) {
        rememberChange('edit atlas garden');
        existing.name = name;
        existing.description = description;
        existing.emoji = emoji;
        existing.updatedAt = now();
        scheduleSave();
        closeDialog();
        render();
        showToast('Garden details updated.');
        return;
      }
      rememberChange('create atlas garden');
      syncActiveGardenData();
      const id = uid();
      const starter = String(formData.get('starter') || 'blank');
      const data = starter === 'duplicate' ? extractGardenData() : normalizeGardenDataset({});
      data.settings.view = 'garden';
      data.settings.selectedBed = 'all';
      data.settings.search = '';
      data.meta = { createdAt: now(), updatedAt: now() };
      const meta = normalizeGardenMeta({ id, name, description, emoji, createdAt: now(), updatedAt: now() }, id);
      state.atlas.gardens.push(meta);
      state.atlas.gardenData[id] = data;
      closeDialog();
      activateGardenData(id, 'garden');
      showToast(`${name} added to the atlas.`);
    });
    layer.querySelector('[data-garden-delete]')?.addEventListener('click', () => deleteAtlasGarden(existing.id));
  }

  function deleteAtlasGarden(id) {
    const meta = state.atlas.gardens.find((garden) => garden.id === id);
    if (!meta || state.atlas.gardens.length <= 1) return;
    if (!confirm(`Delete “${meta.name}” and all plants in it? Atlas snapshots for this garden will also be removed.`)) return;
    rememberChange('delete atlas garden');
    syncActiveGardenData();
    state.atlas.gardens = state.atlas.gardens.filter((garden) => garden.id !== id);
    delete state.atlas.gardenData[id];
    state.atlas.snapshots = state.atlas.snapshots.filter((snapshot) => snapshot.gardenId !== id);
    const nextId = state.atlas.gardens[0].id;
    closeDialog();
    if (id === state.atlas.activeGardenId) activateGardenData(nextId, 'atlas');
    else {
      scheduleSave();
      render();
    }
    showToast(`${meta.name} removed from the atlas.`);
  }

  function openSnapshotDialog() {
    const meta = activeGardenMeta();
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-dialog-small" data-dialog="snapshot">
          <div class="lg-dialog-head"><div><h3>Snapshot ${escapeHTML(meta.name)}</h3><p>Save a restorable copy of every bed, plant, note, and journal event.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <label>Snapshot name<input name="name" maxlength="90" required value="${escapeHTML(`${meta.name} · ${new Date().toLocaleDateString()}`)}"></label>
          <label>Note<textarea name="note" rows="3" maxlength="260" placeholder="Before reorganizing the research beds"></textarea></label>
          <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Take snapshot</button></div>
        </form>
      </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const data = extractGardenData();
      const snapshot = {
        id: uid(), gardenId: state.atlas.activeGardenId,
        name: String(formData.get('name') || 'Garden snapshot').trim() || 'Garden snapshot',
        note: String(formData.get('note') || '').trim(),
        createdAt: now(), summary: datasetStats(data), data
      };
      state.atlas.snapshots.unshift(snapshot);
      if (state.atlas.snapshots.length > 80) state.atlas.snapshots.length = 80;
      scheduleSave();
      closeDialog();
      render();
      showToast('Garden snapshot saved.');
    });
  }

  function restoreAtlasSnapshot(id) {
    const snapshot = state.atlas.snapshots.find((item) => item.id === id);
    if (!snapshot) return;
    const garden = state.atlas.gardens.find((item) => item.id === snapshot.gardenId);
    if (!garden) return;
    if (!confirm(`Restore “${snapshot.name}” into ${garden.name}? The current garden state will be replaced, but this snapshot remains available.`)) return;
    rememberChange('restore garden snapshot');
    syncActiveGardenData();
    state.atlas.gardenData[snapshot.gardenId] = normalizeGardenDataset(snapshot.data);
    activateGardenData(snapshot.gardenId, 'garden');
    showToast(`Restored ${snapshot.name}.`);
  }

  function deleteAtlasSnapshot(id) {
    const snapshot = state.atlas.snapshots.find((item) => item.id === id);
    if (!snapshot || !confirm(`Delete snapshot “${snapshot.name}”?`)) return;
    rememberChange('delete garden snapshot');
    state.atlas.snapshots = state.atlas.snapshots.filter((item) => item.id !== id);
    scheduleSave();
    render();
    showToast('Snapshot deleted.');
  }

  function openShareDialog() {
    const meta = activeGardenMeta();
    const stats = datasetStats(extractGardenData());
    const layer = shadow.querySelector('.lg-dialog-layer');
    layer.innerHTML = `
      <div class="lg-dialog-backdrop" data-dialog-close>
        <form class="lg-dialog lg-share-dialog" data-dialog="share">
          <div class="lg-dialog-head"><div><h3>Share ${escapeHTML(meta.name)}</h3><p>Export a standalone, read-only HTML garden. It opens without Tampermonkey and cannot modify your local atlas.</p></div><button type="button" class="lg-icon-button" data-dialog-close>×</button></div>
          <div class="lg-share-summary"><span>${escapeHTML(meta.emoji)}</span><div><strong>${escapeHTML(meta.name)}</strong><p>${stats.total} plants · ${stats.beds} beds · ${stats.visits} visits</p></div></div>
          <fieldset class="lg-share-options"><legend>Include in the shared garden</legend><label><input type="checkbox" name="notes" checked><span><b>Plant labels and notes</b><small>Useful context, but review notes for private information.</small></span></label><label><input type="checkbox" name="archive"><span><b>Compost archive</b><small>Include archived plants in a separate historical section.</small></span></label><label><input type="checkbox" name="metrics" checked><span><b>Visit and vitality metrics</b><small>Show counts, health, blooms, and last-visit dates.</small></span></label></fieldset>
          <div class="lg-share-warning"><strong>Privacy check</strong><p>The file contains the URLs, titles, and any options selected above. Link Garden does not upload it; the HTML is generated locally for you to share.</p></div>
          <div class="lg-dialog-actions"><span></span><button type="button" data-dialog-close>Cancel</button><button class="lg-primary" type="submit">Export read-only HTML</button></div>
        </form>
      </div>`;
    bindDialogClose(layer);
    const form = layer.querySelector('form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      exportReadOnlyGarden({ notes: formData.has('notes'), archive: formData.has('archive'), metrics: formData.has('metrics') });
      closeDialog();
    });
  }

  function safeSharedHref(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '#';
    } catch { return '#'; }
  }

  function fileSlug(value) {
    return String(value || 'link-garden').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'link-garden';
  }

  function downloadTextFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportReadOnlyGarden(options = {}) {
    const meta = activeGardenMeta();
    const data = extractGardenData();
    const links = data.links.filter((link) => options.archive || !link.archived);
    const stats = datasetStats(data);
    const bedSections = data.beds.map((bed) => {
      const bedLinks = links.filter((link) => link.bedId === bed.id && !link.archived);
      if (!bedLinks.length) return '';
      return `<section class="bed" data-bed="${escapeHTML(bed.id)}"><header><div><span>▰</span><h2>${escapeHTML(bed.name)}</h2></div><b>${bedLinks.length} plants</b></header><div class="plants">${bedLinks.map((link) => sharedPlantCard(link, options)).join('')}</div></section>`;
    }).join('');
    const archived = options.archive ? links.filter((link) => link.archived) : [];
    const archivedSection = archived.length ? `<section class="bed archive" data-bed="archive"><header><div><span>♻</span><h2>Compost Archive</h2></div><b>${archived.length} plants</b></header><div class="plants">${archived.map((link) => sharedPlantCard(link, options)).join('')}</div></section>` : '';
    const bedOptions = data.beds.map((bed) => `<option value="${escapeHTML(bed.id)}">${escapeHTML(bed.name)}</option>`).join('') + (archived.length ? '<option value="archive">Compost Archive</option>' : '');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(meta.name)} · Link Garden</title><style>
      :root{color-scheme:light dark;--bg:#eef1e4;--paper:#fffdf5;--ink:#213026;--muted:#657167;--line:#d5dac9;--green:#315f3c;--soft:#e0ebdc;--danger:#8b443c}*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 15% 0,#fff8d8 0,transparent 35%),var(--bg);color:var(--ink)}header.hero{padding:52px clamp(20px,6vw,90px) 30px;background:linear-gradient(145deg,#244f35,#3e7550);color:#fff}header.hero .mark{font-size:54px}header.hero h1{font-size:clamp(34px,6vw,70px);margin:4px 0 5px;line-height:1}header.hero p{max-width:760px;margin:0;opacity:.85;font-size:17px}.stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}.stats span{background:#ffffff18;border:1px solid #ffffff2b;border-radius:99px;padding:7px 12px}.toolbar{position:sticky;top:0;z-index:3;display:flex;gap:10px;flex-wrap:wrap;padding:12px clamp(20px,6vw,90px);background:color-mix(in srgb,var(--paper) 94%,transparent);backdrop-filter:blur(15px);border-bottom:1px solid var(--line)}input,select{border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);padding:10px 12px;font:inherit}.toolbar input{flex:1;min-width:220px}main{max-width:1500px;margin:auto;padding:28px clamp(16px,4vw,58px) 80px}.bed{background:color-mix(in srgb,var(--paper) 93%,#8c6b3d);border:1px solid var(--line);border-radius:22px;padding:18px;margin-bottom:24px;box-shadow:0 14px 40px #1e352315}.bed>header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:15px}.bed>header div{display:flex;align-items:center;gap:10px}.bed h2{margin:0}.bed>header b{color:var(--muted)}.plants{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}.plant{display:flex;gap:12px;min-width:0;padding:16px;border-radius:16px;border:1px solid var(--line);background:var(--paper);text-decoration:none;color:inherit;transition:.18s transform,.18s border-color}.plant:hover{transform:translateY(-2px);border-color:var(--green)}.plant .emoji{font-size:34px}.plant h3{font-size:16px;margin:0 0 3px}.plant .host{font-size:12px;color:var(--muted);word-break:break-all}.plant p{margin:10px 0 0;color:var(--muted)}.plant footer{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}.plant footer span{font-size:11px;padding:3px 7px;border-radius:99px;background:var(--soft);color:var(--green)}.plant.dead{border-style:dashed}.archive{opacity:.85}.empty{padding:80px 20px;text-align:center;color:var(--muted)}.about{margin-top:40px;padding-top:22px;border-top:1px solid var(--line);color:var(--muted)}@media(prefers-color-scheme:dark){:root{--bg:#172019;--paper:#202b22;--ink:#edf4ea;--muted:#a8b5aa;--line:#3a493d;--green:#a8d4a9;--soft:#2b4231}body{background:radial-gradient(circle at 15% 0,#4b451d66 0,transparent 35%),var(--bg)}}
    </style></head><body><header class="hero"><div class="mark">${escapeHTML(meta.emoji)}</div><h1>${escapeHTML(meta.name)}</h1><p>${escapeHTML(meta.description || 'A read-only garden of cultivated links.')}</p><div class="stats"><span>${stats.total} plants</span><span>${stats.beds} beds</span><span>${stats.visits} visits</span><span>${stats.blooms} blooms</span><span>${stats.dead} mushrooms</span><span>Exported ${escapeHTML(new Date().toLocaleDateString())}</span></div></header><div class="toolbar"><input id="search" type="search" placeholder="Search this garden"><select id="bed"><option value="all">Whole garden</option>${bedOptions}</select></div><main>${bedSections}${archivedSection || ''}<div id="empty" class="empty" hidden>No plants match this view.</div><p class="about">Read-only export from Link Garden v${VERSION}. This file contains no connection to the owner’s local atlas and cannot modify it.</p></main><script>
      const search=document.getElementById('search'),bed=document.getElementById('bed'),empty=document.getElementById('empty');function filter(){const q=search.value.trim().toLowerCase(),b=bed.value;let visible=0;document.querySelectorAll('.bed').forEach(section=>{const bedMatch=b==='all'||section.dataset.bed===b;let count=0;section.querySelectorAll('.plant').forEach(card=>{const show=bedMatch&&(!q||card.textContent.toLowerCase().includes(q));card.hidden=!show;if(show){count++;visible++;}});section.hidden=count===0;});empty.hidden=visible!==0;}search.addEventListener('input',filter);bed.addEventListener('change',filter);
    ${'</scr' + 'ipt>'}</body></html>`;
    downloadTextFile(html, `${fileSlug(meta.name)}-link-garden-${new Date().toISOString().slice(0, 10)}.html`, 'text/html;charset=utf-8');
    showToast('Read-only garden exported.');
  }

  function sharedPlantCard(link, options) {
    const profile = plantProfile(link);
    const href = safeSharedHref(link.url);
    const metrics = options.metrics ? `<footer><span>${link.visits} visits</span><span>${escapeHTML(profile.label)}</span><span>${escapeHTML(relativeAge(link.lastVisited || link.createdAt))}</span>${link.dead ? '<span>Dead link</span>' : ''}</footer>` : '';
    const notes = options.notes && link.notes ? `<p>${escapeHTML(link.notes)}</p>` : '';
    return `<a class="plant ${link.dead ? 'dead' : ''}" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"><span class="emoji">${profile.emoji}</span><div><h3>${escapeHTML(link.title)}</h3><div class="host">${escapeHTML(safeHost(link.url) || link.url)}</div>${notes}${metrics}</div></a>`;
  }

  function showToast(message) {
    const toast = shadow?.querySelector('.lg-toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.visible = 'true';
    toastTimer = setTimeout(() => { toast.dataset.visible = 'false'; }, 3200);
  }

  function installNavigationWatch() {
    const emit = () => window.dispatchEvent(new Event('linkgarden:urlchange'));
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function patchedHistory(...args) {
        const result = original.apply(this, args);
        emit();
        return result;
      };
    }
    window.addEventListener('popstate', emit);
    window.addEventListener('linkgarden:urlchange', () => {
      const next = canonicalize(location.href);
      if (next === currentCanonicalUrl) return;
      currentCanonicalUrl = next;
      setTimeout(() => recordVisit(location.href, document.title), 250);
    });
  }

  function installEcologyClock() {
    clearInterval(ecologyClock);
    ecologyClock = setInterval(() => {
      if (panel?.dataset.open === 'true' && state.settings.view === 'garden' && state.settings.ecologyEnabled && (state.settings.ecologyTime === 'auto' || state.settings.ecologyWeather === 'auto')) render();
    }, 60_000);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('Open Link Garden', openPanel);
    GM_registerMenuCommand('Plant current page', addCurrentPage);
    GM_registerMenuCommand('Open Garden Journal', () => { state.settings.view = 'journal'; openPanel(); });
    GM_registerMenuCommand('Open Garden Atlas', () => { state.settings.view = 'atlas'; openPanel(); });
    GM_registerMenuCommand('Open Cultivation Tools', () => { openPanel(); setTimeout(openCultivationDialog, 0); });
    GM_registerMenuCommand('Import browser bookmarks', () => { openPanel(); setTimeout(openImportCenter, 0); });
    GM_registerMenuCommand('Share active garden', openShareDialog);
    GM_registerMenuCommand('Export atlas backup', exportGarden);
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .lg-shell {
      --bg: #f6f3e8;
      --panel: #fffdf5;
      --panel-2: #eee8d6;
      --ink: #243328;
      --muted: #687369;
      --line: #d8d2bf;
      --accent: #356a43;
      --accent-2: #214c31;
      --accent-soft: #dcebdc;
      --danger: #a33a32;
      --vital-0: #3f8751; --vital-1: #7aad70; --vital-2: #d3ad4e; --vital-3: #b66f51; --vital-4: #76685b;
      --shadow: 0 22px 70px rgba(32, 48, 35, .28);
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483646;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.4;
    }
    .lg-shell[data-theme="dark"] {
      --bg: #111712; --panel: #182019; --panel-2: #202a21; --ink: #edf5ec; --muted: #a9b7aa; --line: #364338;
      --accent: #79b886; --accent-2: #b5dfbc; --accent-soft: #263b2a; --danger: #ef8178;
      --vital-0: #72c486; --vital-1: #9acb8d; --vital-2: #dfbd60; --vital-3: #d18265; --vital-4: #91867b; --shadow: 0 24px 80px rgba(0,0,0,.55);
    }
    @media (prefers-color-scheme: dark) {
      .lg-shell[data-theme="auto"] {
        --bg: #111712; --panel: #182019; --panel-2: #202a21; --ink: #edf5ec; --muted: #a9b7aa; --line: #364338;
        --accent: #79b886; --accent-2: #b5dfbc; --accent-soft: #263b2a; --danger: #ef8178;
      --vital-0: #72c486; --vital-1: #9acb8d; --vital-2: #dfbd60; --vital-3: #d18265; --vital-4: #91867b; --shadow: 0 24px 80px rgba(0,0,0,.55);
      }
    }
    .lg-launcher {
      position: absolute; right: 0; bottom: 0; width: 58px; height: 58px; border-radius: 50%; border: 1px solid rgba(255,255,255,.35);
      background: radial-gradient(circle at 35% 25%, #6faa75, #2e5d3a 72%); color: white; box-shadow: 0 10px 28px rgba(25,71,39,.35);
      display: grid; place-items: center; transition: transform .2s ease, box-shadow .2s ease; z-index: 3;
    }
    .lg-launcher:hover { transform: translateY(-2px) rotate(-3deg); box-shadow: 0 14px 32px rgba(25,71,39,.42); }
    .lg-launcher-plant { font-size: 28px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.22)); }
    .lg-launcher-badge { position: absolute; right: -3px; top: -3px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #f4d06f; color: #2c321f; font-size: 11px; font-weight: 800; line-height: 20px; border: 2px solid white; }
    .lg-panel {
      position: absolute; right: 0; bottom: 74px; width: min(1080px, calc(100vw - 36px)); height: min(760px, calc(100vh - 110px));
      background: var(--bg); border: 1px solid var(--line); border-radius: 22px; box-shadow: var(--shadow); overflow: hidden;
      opacity: 0; transform: translateY(14px) scale(.985); pointer-events: none; transform-origin: bottom right; transition: opacity .2s ease, transform .2s ease;
    }
    .lg-panel[data-open="true"] { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    .lg-app { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
    .lg-header { min-height: 76px; padding: 15px 18px; background: var(--panel); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .lg-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .lg-brand-mark { width: 44px; height: 44px; display: grid; place-items: center; font-size: 25px; background: var(--accent-soft); border-radius: 13px; }
    .lg-title-row { display: flex; align-items: center; gap: 8px; }
    .lg-title-row h1 { margin: 0; font: 800 20px/1.05 Georgia, serif; letter-spacing: -.02em; color: var(--ink); }
    .lg-version { padding: 3px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); font-size: 10px; font-weight: 800; }
    .lg-brand p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
    .lg-header-actions { display: flex; align-items: center; gap: 8px; }
    .lg-save-state { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .lg-save-dot { width: 8px; height: 8px; border-radius: 50%; background: #5f9f6a; box-shadow: 0 0 0 3px rgba(95,159,106,.12); }
    .lg-save-dot[data-status="saving"] { background: #d09d3c; }
    .lg-save-dot[data-status="error"] { background: #bd4a44; }
    .lg-icon-button { width: 34px; height: 34px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--ink); font-size: 19px; display: grid; place-items: center; }
    .lg-toolbar { padding: 10px 14px; display: flex; align-items: center; gap: 8px; background: var(--panel); border-bottom: 1px solid var(--line); overflow-x: auto; }
    .lg-toolbar button, .lg-dialog-actions button, .lg-empty button { border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; color: var(--ink); background: var(--panel); font-weight: 700; white-space: nowrap; }
    .lg-toolbar button:hover, .lg-dialog-actions button:hover, .lg-empty button:hover, .lg-icon-button:hover { border-color: var(--accent); }
    button.lg-primary { background: var(--accent); color: white; border-color: var(--accent); }
    button.lg-primary:hover { background: var(--accent-2); border-color: var(--accent-2); }
    button:disabled { opacity: .55; cursor: wait; }
    .lg-view-switch { display: inline-flex; align-items: center; padding: 3px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); }
    .lg-view-switch button { border: 0; padding: 6px 9px; background: transparent; color: var(--muted); }
    .lg-view-switch button.is-active { background: var(--panel); color: var(--accent-2); box-shadow: 0 1px 5px rgba(0,0,0,.1); }
    .lg-toolbar-spacer { flex: 1; }
    .lg-body { min-height: 0; flex: 1; display: grid; grid-template-columns: 218px 1fr; }
    .lg-sidebar { min-height: 0; overflow-y: auto; padding: 14px 12px; border-right: 1px solid var(--line); background: var(--panel); }
    .lg-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 18px; }
    .lg-stats div { padding: 9px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
    .lg-stats strong { display: block; font-size: 17px; color: var(--ink); }
    .lg-stats span { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    .lg-section-title { display: flex; align-items: center; justify-content: space-between; margin: 0 4px 7px; color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .lg-section-title button { width: 25px; height: 25px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
    .lg-bed-list { display: grid; gap: 4px; }
    .lg-bed-nav-row { display: grid; grid-template-columns: 1fr 28px; align-items: center; gap: 2px; border-radius: 9px; }
    .lg-bed-nav-row.is-active { background: var(--accent-soft); }
    .lg-bed-nav-row .lg-bed-item { min-width: 0; }
    .lg-bed-edit { width: 27px; height: 27px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--muted); opacity: 0; }
    .lg-bed-nav-row:hover .lg-bed-edit, .lg-bed-nav-row.is-active .lg-bed-edit { opacity: 1; }
    .lg-bed-edit:hover { background: var(--panel-2); color: var(--ink); }

    .lg-bed-item { width: 100%; display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: 7px; border: 0; border-radius: 9px; padding: 8px 9px; color: var(--ink); background: transparent; text-align: left; }
    .lg-bed-item:hover { background: var(--panel-2); }
    .lg-bed-item.is-active { background: var(--accent-soft); color: var(--accent-2); }
    .lg-bed-item b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-bed-item em { font-style: normal; font-size: 11px; color: var(--muted); }
    .lg-sidebar-note { margin-top: 18px; padding: 10px; border-radius: 10px; background: var(--bg); color: var(--muted); font-size: 10px; line-height: 1.55; }
    .lg-main { min-width: 0; min-height: 0; overflow-y: auto; padding: 17px; }
    .lg-main-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
    .lg-main-head h2 { margin: 0; font: 800 22px/1.1 Georgia, serif; }
    .lg-main-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .lg-filters { display: flex; align-items: center; gap: 8px; }
    .lg-search { min-width: 280px; height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .lg-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--ink); }
    .lg-filters select, .lg-dialog select, .lg-dialog input, .lg-dialog textarea { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--ink); }
    .lg-filters select { height: 38px; padding: 0 10px; }
    .lg-garden-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; padding-bottom: 18px; }
    .lg-bulk-bar { position: sticky; top: -1px; z-index: 5; display: flex; align-items: center; gap: 8px; margin: -4px 0 14px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 5px 18px rgba(0,0,0,.08); }
    .lg-bulk-bar strong { margin-right: auto; }
    .lg-bulk-bar button, .lg-card-actions button, .lg-landscape-bed header button, .lg-garden-tooltip button { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 10px; font-weight: 800; padding: 6px 8px; }
    .lg-landscape { display: grid; gap: 18px; padding-bottom: 28px; }
    .lg-garden-sky { height: 56px; margin: -2px -2px -8px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(180deg, color-mix(in srgb, #a9d5ee 62%, var(--panel)), color-mix(in srgb, #dfeec4 50%, var(--panel))); color: color-mix(in srgb, var(--ink) 70%, #315c73); font: 800 18px/1 Georgia, serif; overflow: hidden; }
    .lg-garden-sky span:first-child { opacity: .66; animation: lg-cloud-drift 10s ease-in-out infinite alternate; }
    .lg-garden-sky span:last-child { animation: lg-sun-pulse 4s ease-in-out infinite; }
    @keyframes lg-cloud-drift { to { transform: translateX(24px); } }
    @keyframes lg-sun-pulse { 50% { transform: rotate(8deg) scale(1.08); } }
    .lg-landscape-bed { border: 1px solid var(--line); border-radius: 18px; overflow: visible; background: var(--panel); box-shadow: 0 7px 22px rgba(39,60,43,.08); }
    .lg-landscape-bed > header { min-height: 52px; padding: 9px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, var(--panel), var(--bg)); border-radius: 18px 18px 0 0; }
    .lg-landscape-bed > header > div { display: flex; align-items: center; gap: 9px; }
    .lg-bed-sign { display: inline-block; padding: 6px 10px; border: 1px solid #8b6b42; border-radius: 4px; background: #cda56d; color: #3e2c18; font: 800 12px/1.1 "Segoe Print", cursive; transform: rotate(-.5deg); box-shadow: inset 0 0 0 2px rgba(255,255,255,.2); }
    .lg-landscape-bed header small { color: var(--muted); }
    .lg-bed-canvas { position: relative; height: var(--bed-height); min-height: 230px; overflow: hidden; background:
      radial-gradient(circle at 13% 22%, rgba(255,255,255,.2) 0 2px, transparent 3px),
      radial-gradient(circle at 71% 65%, rgba(255,255,255,.13) 0 2px, transparent 3px),
      repeating-linear-gradient(166deg, transparent 0 29px, rgba(48,31,19,.055) 30px 32px),
      linear-gradient(180deg, #876247 0%, #6b4933 72%, #573825 100%);
      border-radius: 0 0 17px 17px;
      overflow: visible;
    }
    .lg-bed-canvas::before { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(83,121,62,.38), transparent 11%, transparent 89%, rgba(83,121,62,.38)); }
    .lg-bed-canvas.is-drop-target { outline: 4px solid color-mix(in srgb, var(--accent) 75%, transparent); outline-offset: -4px; }
    .lg-bed-path { position: absolute; left: 4%; right: 4%; bottom: 11%; height: 34px; border-radius: 50%; background: repeating-linear-gradient(90deg, #b49a79 0 23px, #9b8061 24px 27px); opacity: .35; transform: rotate(-1deg); }
    .lg-bed-empty { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.72); font-weight: 800; text-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: none; }
    .lg-garden-plant { position: absolute; z-index: 2; width: 88px; height: 96px; transform: translate(-50%, -50%); cursor: grab; }
    .lg-garden-plant:hover { z-index: 12; }
    .lg-garden-plant.is-dragging { opacity: .45; cursor: grabbing; }
    .lg-garden-sprite { position: absolute; inset: 0; border: 0; background: transparent; color: inherit; }
    .lg-garden-sprite::after { content: ''; position: absolute; left: 50%; bottom: 7px; width: 52px; height: 10px; border-radius: 50%; background: rgba(0,0,0,.2); filter: blur(4px); transform: translateX(-50%); }
    .lg-garden-emoji { position: absolute; left: 50%; bottom: 9px; transform: translateX(-50%) scale(var(--plant-scale)); transform-origin: bottom center; font-size: 52px; line-height: 1; filter: drop-shadow(0 5px 4px rgba(0,0,0,.2)); transition: transform .18s ease; }
    .lg-garden-plant:hover .lg-garden-emoji { transform: translateX(-50%) translateY(-4px) scale(calc(var(--plant-scale) + .06)); }
    .lg-garden-plant.health-wilted .lg-garden-emoji, .lg-garden-plant.health-parched .lg-garden-emoji { transform: translateX(-50%) rotate(8deg) scale(var(--plant-scale)); filter: saturate(.55) sepia(.2) drop-shadow(0 5px 4px rgba(0,0,0,.2)); }
    .lg-garden-plant.health-blooming .lg-garden-emoji { animation: lg-garden-bloom 1.8s ease-in-out infinite; }
    @keyframes lg-garden-bloom { 50% { transform: translateX(-50%) translateY(-5px) rotate(2deg) scale(calc(var(--plant-scale) + .05)); } }
    .lg-garden-sparkles { position: absolute; left: 50%; top: 2px; transform: translateX(-50%); color: #ffd2e2; letter-spacing: 3px; white-space: nowrap; text-shadow: 0 1px 4px rgba(95,22,51,.5); animation: lg-sparkle 2.2s ease-in-out infinite; }
    .lg-garden-tooltip { position: absolute; left: 50%; bottom: calc(100% - 4px); width: 210px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); color: var(--ink); box-shadow: 0 10px 28px rgba(0,0,0,.2); opacity: 0; pointer-events: none; transform: translate(-50%, 8px); transition: .16s ease; }
    .lg-garden-plant:hover .lg-garden-tooltip, .lg-garden-plant:focus-within .lg-garden-tooltip { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
    .lg-garden-tooltip strong, .lg-garden-tooltip span, .lg-garden-tooltip em, .lg-garden-tooltip small { display: block; }
    .lg-garden-tooltip strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-garden-tooltip span { margin-top: 2px; color: var(--accent); font-size: 10px; font-weight: 900; text-transform: uppercase; }
    .lg-garden-tooltip em { margin: 8px 0; padding: 6px 7px; border-radius: 4px; background: #fff2bf; color: #554727; font: 600 10px/1.35 "Segoe Print", cursive; }
    .lg-garden-tooltip small { color: var(--muted); }
    .lg-garden-tooltip div { display: flex; gap: 6px; margin-top: 8px; }

    .lg-plant-card { position: relative; min-height: 330px; overflow: hidden; border: 1px solid var(--line); border-radius: 17px; background: var(--panel); box-shadow: 0 7px 20px rgba(42,58,45,.07); }
    .lg-plant-card.is-selected { outline: 3px solid var(--accent); outline-offset: -3px; }
    .lg-select-plant { position: absolute; left: 10px; top: 10px; z-index: 5; width: 25px; height: 25px; cursor: pointer; }
    .lg-select-plant input { position: absolute; opacity: 0; }
    .lg-select-plant span { width: 25px; height: 25px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: transparent; font-weight: 900; }
    .lg-select-plant input:checked + span { background: var(--accent); border-color: var(--accent); color: white; }

    .lg-plant-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 135px; background: linear-gradient(180deg, rgba(164,204,171,.32), rgba(244,232,192,.13)); }
    .lg-plant-card.health-wilted .lg-plant-emoji, .lg-plant-card.health-parched .lg-plant-emoji { filter: saturate(.55) sepia(.22); transform: rotate(9deg) translateY(5px); }
    .lg-plant-card.health-dead::before { background: linear-gradient(180deg, rgba(170,165,150,.25), rgba(98,82,66,.12)); }
    .lg-soil { position: absolute; left: 0; right: 0; top: 120px; height: 32px; background: radial-gradient(ellipse at center, #6c5039 0, #493325 72%); border-radius: 55% 55% 0 0 / 75% 75% 0 0; opacity: .92; }
    .lg-weather { position: absolute; right: 14px; top: 12px; font-size: 15px; opacity: .7; }
    .lg-plant-visual { position: relative; z-index: 1; display: block; width: 100%; height: 150px; border: 0; background: transparent; }
    .lg-plant-emoji { position: absolute; left: 50%; top: 24px; transform: translateX(-50%); font-size: 72px; line-height: 1; filter: drop-shadow(0 7px 5px rgba(28,53,32,.18)); transition: transform .2s ease, filter .2s ease; }
    .lg-plant-visual:hover .lg-plant-emoji { transform: translateX(-50%) translateY(-4px) scale(1.04); }
    .lg-plant-card.health-blooming .lg-plant-emoji { animation: lg-bloom 1.8s ease-in-out infinite; }
    .lg-bloom-ring { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); color: #d9789a; font-size: 17px; letter-spacing: 5px; animation: lg-sparkle 2.2s ease-in-out infinite; }
    .lg-shadow { position: absolute; left: 50%; bottom: 8px; width: 90px; height: 14px; border-radius: 50%; background: rgba(0,0,0,.18); transform: translateX(-50%); filter: blur(5px); }
    @keyframes lg-bloom { 50% { transform: translateX(-50%) translateY(-4px) rotate(2deg) scale(1.04); } }
    @keyframes lg-sparkle { 50% { opacity: .4; transform: translateX(-50%) scale(.92); } }
    .lg-plant-info { position: relative; z-index: 2; padding: 12px 13px 13px; }
    .lg-card-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .lg-stage { color: var(--accent); font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
    .lg-more { border: 0; background: transparent; color: var(--muted); font-weight: 900; padding: 2px 4px; }
    .lg-plant-info h3 { margin: 5px 0 2px; color: var(--ink); font-size: 15px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-plant-info > a { display: block; color: var(--muted); font-size: 11px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-plant-info > a:hover { color: var(--accent); text-decoration: underline; }
    .lg-growth-row { display: flex; flex-wrap: wrap; gap: 7px 10px; margin-top: 10px; color: var(--muted); font-size: 10px; }
    .lg-label { position: relative; margin: 14px 2px 6px; padding: 8px 9px 8px 13px; min-height: 35px; border: 1px solid #c7b98f; border-radius: 3px; background: #fff2bf; color: #554727; font: 600 11px/1.35 "Segoe Print", "Bradley Hand", cursive; transform: rotate(-.6deg); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .lg-label.is-empty { opacity: .68; font-style: italic; }
    .lg-label-pin { position: absolute; left: 4px; top: -5px; width: 2px; height: 44px; background: #8b7452; transform: rotate(2deg); }

    .lg-card-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 9px; }
    .lg-card-actions button:hover { border-color: var(--accent); color: var(--accent-2); }
    .lg-card-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 9px; }
    .lg-empty { min-height: 390px; display: grid; place-items: center; align-content: center; text-align: center; color: var(--muted); }
    .lg-empty-scene { font-size: 72px; }
    .lg-empty h3 { margin: 10px 0 4px; color: var(--ink); font: 800 19px/1.2 Georgia, serif; }
    .lg-empty p { max-width: 360px; margin: 0 0 15px; }
    .lg-journal-dashboard { display: grid; gap: 14px; padding-bottom: 24px; }
    .lg-journal-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .lg-journal-kpis article { min-width: 0; display: flex; align-items: center; gap: 11px; padding: 13px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 5px 16px rgba(35,52,38,.06); }
    .lg-journal-kpis article > span { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 11px; background: var(--accent-soft); font-size: 20px; }
    .lg-journal-kpis strong, .lg-journal-kpis b, .lg-journal-kpis small { display: block; }
    .lg-journal-kpis strong { color: var(--ink); font-size: 21px; line-height: 1; }
    .lg-journal-kpis b { margin-top: 3px; font-size: 11px; }
    .lg-journal-kpis small { margin-top: 2px; color: var(--muted); font-size: 9px; }
    .lg-journal-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, .72fr); gap: 14px; }
    .lg-journal-grid-top { grid-template-columns: minmax(0, 1.5fr) minmax(300px, .8fr); }
    .lg-journal-card { min-width: 0; padding: 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: 0 6px 18px rgba(35,52,38,.06); }
    .lg-journal-card > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
    .lg-journal-card h3 { margin: 0; font: 800 17px/1.15 Georgia, serif; }
    .lg-journal-card header p { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
    .lg-journal-card header > span { padding: 5px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-2); font-size: 10px; font-weight: 800; }
    .lg-visit-chart { width: 100%; height: auto; min-height: 160px; overflow: visible; }
    .lg-visit-chart rect { fill: var(--accent); opacity: .82; }
    .lg-visit-chart rect:hover { opacity: 1; }
    .lg-visit-chart line { stroke: var(--line); stroke-width: 1; }
    .lg-visit-chart text { fill: var(--muted); font-size: 10px; }
    .lg-vitality-mix { min-height: 200px; display: grid; grid-template-columns: 145px 1fr; align-items: center; gap: 16px; }
    .lg-vitality-ring { width: 145px; aspect-ratio: 1; padding: 22px; border-radius: 50%; }
    .lg-vitality-ring > span { width: 100%; height: 100%; display: grid; place-items: center; align-content: center; border-radius: 50%; background: var(--panel); box-shadow: inset 0 0 0 1px var(--line); }
    .lg-vitality-ring strong, .lg-vitality-ring small { display: block; text-align: center; }
    .lg-vitality-ring strong { font-size: 25px; }
    .lg-vitality-ring small { color: var(--muted); font-size: 9px; text-transform: uppercase; }
    .lg-vitality-legend { display: grid; gap: 7px; }
    .lg-vitality-legend div { display: grid; grid-template-columns: 9px 1fr auto; align-items: center; gap: 7px; font-size: 10px; }
    .lg-vitality-legend i { width: 9px; height: 9px; border-radius: 50%; }
    .lg-vitality-legend b { color: var(--muted); }
    .lg-species-bars { display: grid; gap: 10px; }
    .lg-species-bars > div { display: grid; grid-template-columns: 120px 1fr 24px; align-items: center; gap: 9px; font-size: 10px; text-transform: capitalize; }
    .lg-species-bars i { height: 8px; overflow: hidden; border-radius: 999px; background: var(--panel-2); }
    .lg-species-bars i b { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .lg-species-bars strong { text-align: right; }
    .lg-rediscover-list { display: grid; gap: 7px; }
    .lg-rediscover-item { display: grid; grid-template-columns: 28px 1fr auto auto; align-items: center; gap: 7px; padding: 7px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
    .lg-rediscover-item > span { font-size: 21px; }
    .lg-rediscover-item div { min-width: 0; }
    .lg-rediscover-item strong, .lg-rediscover-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-rediscover-item strong { font-size: 10px; }
    .lg-rediscover-item small { color: var(--muted); font-size: 9px; }
    .lg-rediscover-item button, .lg-timeline-event button { border: 1px solid var(--line); border-radius: 7px; padding: 5px 7px; background: var(--panel); color: var(--ink); font-size: 9px; font-weight: 800; }
    .lg-timeline-card { padding-bottom: 5px; }
    .lg-timeline { display: grid; }
    .lg-timeline-event { position: relative; display: grid; grid-template-columns: 34px 1fr auto; gap: 10px; padding: 10px 2px; border-top: 1px solid var(--line); }
    .lg-timeline-event:first-child { border-top: 0; }
    .lg-event-icon { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 10px; background: var(--accent-soft); }
    .lg-timeline-event > div { min-width: 0; }
    .lg-timeline-event strong, .lg-timeline-event p, .lg-timeline-event small { display: block; }
    .lg-timeline-event strong { font-size: 11px; }
    .lg-timeline-event p { margin: 2px 0; color: var(--muted); font-size: 10px; }
    .lg-timeline-event small { color: var(--muted); font-size: 9px; }
    .lg-journal-empty { margin: 22px 0; color: var(--muted); text-align: center; font-size: 11px; }
    .lg-history-dialog { width: min(760px, 100%); }
    .lg-history-title { display: flex; align-items: center; gap: 11px; }
    .lg-history-title > span { font-size: 36px; }
    .lg-history-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 15px; }
    .lg-history-kpis div { padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
    .lg-history-kpis strong, .lg-history-kpis span { display: block; }
    .lg-history-kpis strong { font-size: 17px; }
    .lg-history-kpis span { margin-top: 2px; color: var(--muted); font-size: 9px; text-transform: uppercase; }
    .lg-history-chart, .lg-history-timeline { margin-top: 15px; }
    .lg-history-chart h4, .lg-history-timeline h4 { margin: 0 0 8px; font: 800 13px/1.2 Georgia, serif; }
    .lg-vitality-chart { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
    .lg-vitality-chart polygon { fill: color-mix(in srgb, var(--accent) 16%, transparent); }
    .lg-vitality-chart polyline { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .lg-vitality-chart circle { fill: var(--panel); stroke: var(--accent); stroke-width: 2; }
    .lg-vitality-chart .lg-zero-line { stroke: var(--line); stroke-dasharray: 4 5; }
    .lg-history-timeline { max-height: 290px; overflow-y: auto; padding-right: 4px; }

    .lg-import-center { width: min(700px, 100%); }
    .lg-import-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .lg-import-choice { min-width: 0; display: grid; grid-template-columns: 48px 1fr; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 15px; background: var(--bg); color: var(--ink); text-align: left; }
    .lg-import-choice:hover { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .lg-import-choice > span { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 13px; background: var(--panel); font-size: 27px; }
    .lg-import-choice strong, .lg-import-choice p, .lg-import-choice em { display: block; }
    .lg-import-choice strong { font: 800 17px/1.2 Georgia, serif; }
    .lg-import-choice p { margin: 5px 0 10px; color: var(--muted); font-size: 10px; font-style: normal; }
    .lg-import-choice em { color: var(--accent-2); font-size: 9px; font-style: normal; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    .lg-import-help { margin-top: 13px; padding: 12px; border: 1px dashed var(--line); border-radius: 12px; background: var(--panel-2); }
    .lg-import-help strong { font-size: 10px; }
    .lg-import-help p { margin: 4px 0 0; color: var(--muted); font-size: 10px; }
    .lg-import-help code { padding: 1px 4px; border-radius: 4px; background: var(--panel); color: var(--ink); }
    .lg-import-preview { width: min(900px, 100%); }
    .lg-import-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .lg-import-summary div { padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
    .lg-import-summary strong, .lg-import-summary span { display: block; }
    .lg-import-summary strong { font-size: 20px; line-height: 1; }
    .lg-import-summary span { margin-top: 4px; color: var(--muted); font-size: 8px; text-transform: uppercase; letter-spacing: .05em; }
    .lg-import-options { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 12px; padding: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--panel-2); }
    .lg-import-options label { display: grid; gap: 5px; color: var(--ink); font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    .lg-import-options select { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--ink); font-size: 10px; text-transform: none; letter-spacing: normal; }
    .lg-import-options .lg-import-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: normal; font-weight: 600; }
    .lg-import-check input { width: 16px; height: 16px; accent-color: var(--accent); }
    .lg-import-selection-tools { display: flex; align-items: center; gap: 6px; margin: 12px 0 7px; }
    .lg-import-selection-tools strong { font-size: 10px; }
    .lg-import-selection-tools span { flex: 1; }
    .lg-import-selection-tools button { padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 9px; font-weight: 800; }
    .lg-import-list { max-height: 330px; overflow-y: auto; display: grid; gap: 6px; padding-right: 3px; }
    .lg-import-row { display: grid; grid-template-columns: 17px 34px minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); cursor: pointer; }
    .lg-import-row:hover { border-color: var(--accent); }
    .lg-import-row.is-duplicate { opacity: .78; }
    .lg-import-row > input { width: 16px; height: 16px; accent-color: var(--accent); }
    .lg-import-row-icon { font-size: 23px; }
    .lg-import-row-main { min-width: 0; }
    .lg-import-row-main strong, .lg-import-row-main small, .lg-import-row-main em { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-import-row-main strong { font-size: 10px; }
    .lg-import-row-main small { color: var(--muted); font-size: 9px; }
    .lg-import-row-main em { margin-top: 3px; font-style: normal; }
    .lg-import-row-main em span { display: inline-block; margin-right: 4px; padding: 2px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-2); font-size: 8px; }
    .lg-import-row > b { padding: 4px 6px; border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 8px; white-space: nowrap; }
    .lg-import-row.is-new > b { color: var(--accent-2); }
    .lg-import-limit, .lg-import-note, .lg-import-complete { margin: 8px 0 0; color: var(--muted); font-size: 9px; }
    .lg-import-report .lg-import-summary { grid-template-columns: 1fr 1fr; }

    /* v1.4 garden ecology */
    .lg-landscape { position: relative; isolation: isolate; overflow: hidden; border-radius: 16px; transition: background .35s ease, color .35s ease; }
    .lg-landscape::before { content: ''; position: absolute; inset: 0; z-index: -2; pointer-events: none; opacity: .42; background: radial-gradient(circle at 20% 8%, rgba(255,255,255,.7), transparent 24%), linear-gradient(180deg, transparent 0 20%, rgba(65,97,61,.06)); }
    .lg-landscape.season-spring { --eco-sky: #ccebdc; --eco-sky-2: #eef9ef; --eco-soil: #72533a; --eco-grass: #77a95b; --eco-accent: #f5a8c7; }
    .lg-landscape.season-summer { --eco-sky: #bfe5f4; --eco-sky-2: #f4fbdf; --eco-soil: #765035; --eco-grass: #5f9c42; --eco-accent: #f4c44e; }
    .lg-landscape.season-autumn { --eco-sky: #efd0a4; --eco-sky-2: #faead6; --eco-soil: #6c4935; --eco-grass: #98743d; --eco-accent: #cc6f38; }
    .lg-landscape.season-winter { --eco-sky: #cfdde8; --eco-sky-2: #f6f9fb; --eco-soil: #6d625a; --eco-grass: #84928d; --eco-accent: #9fc9df; }
    .lg-landscape.ecology-off { --eco-sky: var(--panel-2); --eco-sky-2: var(--panel); --eco-soil: #75543c; --eco-grass: #6f9959; --eco-accent: var(--accent); }
    .lg-garden-sky { position: relative; overflow: hidden; background: linear-gradient(180deg, var(--eco-sky), var(--eco-sky-2)); color: #26382d; transition: background .35s ease, color .35s ease; }
    .lg-garden-sky > span:nth-child(2) { display: grid; place-items: center; gap: 1px; }
    .lg-garden-sky b { font: 800 16px/1 Georgia, serif; }
    .lg-garden-sky small { color: currentColor; opacity: .67; font-size: 8px; letter-spacing: .07em; text-transform: uppercase; }
    .lg-garden-sky button { position: relative; z-index: 3; padding: 6px 8px; border: 1px solid rgba(38,56,45,.18); border-radius: 999px; background: rgba(255,255,255,.5); color: inherit; font-size: 8px; font-weight: 900; text-transform: uppercase; letter-spacing: .06em; }
    .lg-sky-orb { font-size: 23px; filter: drop-shadow(0 3px 8px rgba(255,255,255,.35)); }
    .lg-landscape.time-dusk .lg-garden-sky { background: linear-gradient(180deg, #725c8d, #e5a277 62%, #f0c99c); color: #fff8ed; }
    .lg-landscape.time-night .lg-garden-sky { background: radial-gradient(circle at 14% 20%, rgba(255,255,255,.25) 0 1px, transparent 2px), radial-gradient(circle at 77% 32%, rgba(255,255,255,.24) 0 1px, transparent 2px), linear-gradient(180deg, #19283c, #344964); color: #eef5ff; }
    .lg-landscape.time-night .lg-garden-sky button, .lg-landscape.time-dusk .lg-garden-sky button { border-color: rgba(255,255,255,.25); background: rgba(10,20,30,.22); }
    .lg-landscape-bed { position: relative; z-index: 1; }
    .lg-bed-canvas { background: linear-gradient(180deg, var(--eco-grass) 0 14%, var(--eco-soil) 15% 100%); transition: background .35s ease, filter .35s ease; }
    .lg-landscape.time-night .lg-bed-canvas { filter: brightness(.7) saturate(.75); }
    .lg-landscape.time-dusk .lg-bed-canvas { filter: sepia(.08) saturate(.92); }
    .lg-landscape.weather-cloudy .lg-bed-canvas { filter: brightness(.88) saturate(.82); }
    .lg-landscape.weather-rain .lg-bed-canvas { filter: brightness(.8) saturate(.95); }
    .lg-landscape.season-winter .lg-bed-canvas::before { content: ''; position: absolute; inset: 0 0 auto; height: 19%; background: linear-gradient(180deg, rgba(250,253,255,.94), rgba(226,238,245,.84)); border-radius: inherit; pointer-events: none; }
    .lg-season-ground { position: absolute; left: 4%; right: 4%; bottom: 6px; z-index: 1; overflow: hidden; color: rgba(255,255,255,.62); text-align: center; font-size: 12px; letter-spacing: 1.3em; white-space: nowrap; pointer-events: none; }
    .lg-season-adornment { position: absolute; right: -5px; top: -5px; z-index: 2; font-size: 12px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.15)); }
    .lg-landscape.season-winter .lg-garden-plant:not(.health-dead) .lg-garden-emoji { filter: saturate(.62) brightness(.95); }
    .lg-landscape.season-autumn .lg-garden-plant:not(.health-dead) .lg-garden-emoji { filter: sepia(.18) saturate(.9); }
    .lg-cloud-bank { position: absolute; inset: 34px 0 auto; z-index: 2; height: 44px; overflow: hidden; pointer-events: none; opacity: .55; }
    .lg-cloud-bank i { position: absolute; font-style: normal; font-size: 28px; filter: grayscale(1); }
    .lg-cloud-bank i:nth-child(1) { left: 8%; top: 6px; }
    .lg-cloud-bank i:nth-child(2) { left: 47%; top: -4px; font-size: 38px; }
    .lg-cloud-bank i:nth-child(3) { right: 10%; top: 11px; font-size: 24px; }
    .lg-breeze-lines { position: absolute; inset: 45px 0 auto; z-index: 2; height: 50px; overflow: hidden; pointer-events: none; color: rgba(255,255,255,.56); }
    .lg-breeze-lines i { position: absolute; left: -15%; font-style: normal; font-size: 29px; }
    .lg-breeze-lines i:nth-child(1) { top: 2px; }
    .lg-breeze-lines i:nth-child(2) { top: 19px; left: 28%; }
    .lg-breeze-lines i:nth-child(3) { top: 34px; left: 66%; }
    .lg-rain-layer { position: absolute; inset: 50px 0 0; z-index: 5; overflow: hidden; pointer-events: none; }
    .lg-rain-layer i { position: absolute; left: var(--drop-x); top: -18px; width: 1px; height: 12px; background: rgba(214,237,255,.7); transform: rotate(12deg); }
    .lg-pollinators { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
    .lg-pollinators span { position: absolute; left: var(--bug-x); top: var(--bug-y); font-size: 13px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.18)); }
    .lg-pollinators.is-fireflies span { color: #fff7a1; text-shadow: 0 0 8px #e8ef7c; }
    .motion-on.weather-rain .lg-rain-layer i { animation: lgRain var(--drop-speed) linear var(--drop-delay) infinite; }
    .motion-on.weather-breeze .lg-breeze-lines i { animation: lgBreeze 5s ease-in-out infinite; }
    .motion-on.weather-breeze .lg-garden-plant { animation: lgPlantSway 3.8s ease-in-out infinite alternate; transform-origin: center bottom; }
    .motion-on .lg-pollinators span { animation: lgPollinate var(--bug-speed) ease-in-out var(--bug-delay) infinite alternate; }
    .motion-on.season-autumn .lg-season-adornment { animation: lgLeafDrift 4.5s ease-in-out infinite; }
    @keyframes lgRain { to { transform: translate(20px, 720px) rotate(12deg); } }
    @keyframes lgBreeze { 0%,100% { transform: translateX(-20px); opacity: .2; } 50% { transform: translateX(100px); opacity: .8; } }
    @keyframes lgPlantSway { from { rotate: -1.5deg; } to { rotate: 1.5deg; } }
    @keyframes lgPollinate { from { translate: -16px -8px; rotate: -8deg; } to { translate: 20px 12px; rotate: 8deg; } }
    @keyframes lgLeafDrift { 0%,100% { transform: translate(0,0) rotate(-8deg); } 50% { transform: translate(4px,5px) rotate(16deg); } }
    @media (prefers-reduced-motion: reduce) { .lg-landscape * { animation: none !important; } }
    .lg-ecology-dialog { width: min(560px, 100%); }
    .lg-ecology-preview { display: flex; align-items: center; gap: 12px; min-height: 74px; padding: 13px 16px; border-radius: 14px; background: linear-gradient(135deg, #bfe5f4, #eef8dc); color: #26382d; }
    .lg-ecology-preview.time-dusk { background: linear-gradient(135deg, #725c8d, #eda477); color: #fff; }
    .lg-ecology-preview.time-night { background: linear-gradient(135deg, #19283c, #425b77); color: #eef5ff; }
    .lg-ecology-preview > span { font-size: 31px; }
    .lg-ecology-preview strong { flex: 1; font: 800 16px/1.1 Georgia, serif; }
    .lg-ecology-preview em { font-style: normal; letter-spacing: 3px; }
    .lg-ecology-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .lg-ecology-grid label { display: grid; gap: 6px; color: var(--ink); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    .lg-ecology-grid select { width: 100%; padding: 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--ink); text-transform: none; letter-spacing: normal; }
    .lg-switch-row { display: flex !important; grid-template-columns: none !important; flex-direction: row !important; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); text-transform: none !important; letter-spacing: normal !important; }
    .lg-switch-row span { display: grid; gap: 2px; }
    .lg-switch-row b { font-size: 11px; }
    .lg-switch-row small { color: var(--muted); font-size: 9px; font-weight: 500; }
    .lg-switch-row input { width: 18px; height: 18px; accent-color: var(--accent); }
    .lg-ecology-note { margin: 12px 0 0; padding: 9px 10px; border-radius: 9px; background: var(--panel-2); color: var(--muted); font-size: 9px; line-height: 1.45; }

    .lg-smart-title { margin-top: 14px; }
    .lg-smart-bed-list .lg-bed-item { border-style: dashed; background: color-mix(in srgb, var(--accent-soft) 42%, transparent); }
    .lg-queue-chip { display: inline-flex; align-items: center; gap: 5px; width: fit-content; margin: 0 0 5px; padding: 3px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-2); font-size: 9px; font-weight: 850; }
    .lg-queue-chip.priority-3 { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent); }
    .lg-queue-chip.is-done { background: var(--panel-2); color: var(--muted); }
    .lg-cultivation-dialog { width: min(760px, 100%); }
    .lg-cultivation-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 13px; }
    .lg-cultivation-kpis button { display: grid; gap: 2px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); color: var(--ink); text-align: left; }
    .lg-cultivation-kpis strong { font: 850 22px/1 Georgia, serif; color: var(--accent); }
    .lg-cultivation-kpis span { color: var(--muted); font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    .lg-cultivation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .lg-cultivation-grid article { display: grid; grid-template-columns: 34px minmax(0,1fr) auto; gap: 9px; align-items: center; padding: 11px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
    .lg-cultivation-grid article > span { font-size: 23px; }
    .lg-cultivation-grid h4, .lg-recovery-section h4 { margin: 0; font-size: 12px; }
    .lg-cultivation-grid p, .lg-recovery-section p { margin: 3px 0 0; color: var(--muted); font-size: 9px; line-height: 1.35; }
    .lg-recovery-section { margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--panel-2); }
    .lg-recovery-section > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .lg-recovery-section > header > span { color: var(--muted); font-size: 9px; font-weight: 800; }
    .lg-recovery-list { display: grid; gap: 6px; }
    .lg-recovery-list > div { display: grid; grid-template-columns: 26px 1fr auto; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 9px; background: var(--panel); }
    .lg-recovery-list strong, .lg-recovery-list small { display: block; }
    .lg-recovery-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
    .lg-recovery-list small { color: var(--muted); font-size: 8px; }
    .lg-organize-dialog { width: min(680px, 100%); }
    .lg-organize-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin: 12px 0; }
    .lg-organize-summary div { display: flex; align-items: baseline; gap: 7px; padding: 10px; border-radius: 10px; background: var(--panel-2); }
    .lg-organize-summary strong { font: 850 20px Georgia, serif; color: var(--accent); }
    .lg-organize-summary span { color: var(--muted); font-size: 9px; font-weight: 800; }
    .lg-organize-list { display: grid; gap: 5px; max-height: 340px; overflow: auto; padding-right: 3px; }
    .lg-organize-list label { display: grid; grid-template-columns: 17px 28px minmax(0,1fr); gap: 7px; align-items: center; padding: 7px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); text-transform: none; letter-spacing: normal; }
    .lg-organize-list input { width: 15px; height: 15px; }
    .lg-organize-list strong, .lg-organize-list small { display: block; }
    .lg-organize-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
    .lg-organize-list small { color: var(--muted); font-size: 8px; }
    .lg-repair-dialog { width: min(610px, 100%); }
    .lg-repair-status { display: grid; grid-template-columns: 36px 1fr auto; gap: 9px; align-items: center; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel-2); }
    .lg-repair-status > span { font-size: 25px; }
    .lg-repair-status strong, .lg-repair-status small { display: block; }
    .lg-repair-status small { color: var(--muted); font-size: 9px; }
    .lg-repair-status.is-dead { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
    .lg-repair-candidates { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 10px; }
    .lg-repair-candidates button { display: grid; gap: 2px; padding: 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); color: var(--ink); text-align: left; }
    .lg-repair-candidates small { color: var(--muted); font-size: 8px; line-height: 1.3; }
    .lg-repair-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .lg-repair-links a { padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--accent); font-size: 9px; font-weight: 800; text-decoration: none; }
    .lg-repair-result { margin: 10px 0 0; padding: 8px 9px; border-radius: 8px; background: var(--panel-2); color: var(--muted); font-size: 9px; }
    .lg-repair-result[data-status="alive"] { background: var(--accent-soft); color: var(--accent-2); }
    .lg-repair-result[data-status="dead"] { color: var(--danger); }

    .lg-data-choices { grid-template-columns: repeat(3, minmax(0,1fr)); }
    .lg-data-choices .lg-import-choice { grid-template-columns: 38px minmax(0,1fr); }
        .lg-atlas-switcher { display: grid; gap: 7px; padding: 9px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel-2); }
    .lg-atlas-switcher label { display: grid; gap: 4px; color: var(--muted); font-size: 8px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .lg-atlas-switcher select { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 10px; font-weight: 750; }
    .lg-atlas-switcher > div { display: grid; grid-template-columns: 1fr 32px; gap: 5px; }
    .lg-atlas-switcher button { min-width: 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 9px; font-weight: 800; }
    .lg-atlas-controls { min-width: min(470px, 100%); }
    .lg-atlas-controls button { border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; background: var(--panel); color: var(--ink); font-size: 10px; font-weight: 800; white-space: nowrap; }
    .lg-atlas-dashboard { display: grid; gap: 16px; }
    .lg-atlas-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .lg-atlas-kpi { display: grid; grid-template-columns: 32px minmax(0,1fr); gap: 7px; align-items: start; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 6px 18px rgba(31,49,35,.05); }
    .lg-atlas-kpi > span { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent-soft); font-size: 16px; }
    .lg-atlas-kpi strong, .lg-atlas-kpi b, .lg-atlas-kpi small { display: block; min-width: 0; }
    .lg-atlas-kpi strong { font: 850 19px/1 Georgia, serif; color: var(--accent); }
    .lg-atlas-kpi b { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
    .lg-atlas-kpi small { margin-top: 2px; color: var(--muted); font-size: 7px; line-height: 1.25; }
    .lg-atlas-section { min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: 15px; background: var(--panel); box-shadow: 0 8px 24px rgba(31,49,35,.06); }
    .lg-atlas-section-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 11px; }
    .lg-atlas-section-head h3 { margin: 0; font: 800 16px/1.2 Georgia, serif; }
    .lg-atlas-section-head p { margin: 3px 0 0; color: var(--muted); font-size: 9px; }
    .lg-atlas-section-head > button { flex: 0 0 auto; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--ink); font-size: 9px; font-weight: 800; }
    .lg-atlas-range-label { padding: 5px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-2); font-size: 8px; font-weight: 850; }
    .lg-atlas-map { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 10px; }
    .lg-atlas-garden-card { min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--panel-2); animation: lg-atlas-arrive .3s ease both; animation-delay: calc(var(--atlas-order) * 35ms); }
    .lg-atlas-garden-card.is-active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent), 0 8px 22px rgba(35,85,48,.1); }
    .lg-atlas-garden-card > header { display: grid; grid-template-columns: 34px minmax(0,1fr) auto; gap: 8px; align-items: start; }
    .lg-atlas-garden-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: var(--panel); font-size: 20px; }
    .lg-atlas-garden-card h4 { margin: 0; font: 800 14px/1.15 Georgia, serif; }
    .lg-atlas-garden-card header p { margin: 3px 0 0; display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 8px; line-height: 1.3; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .lg-atlas-garden-card header em { padding: 3px 6px; border-radius: 99px; background: var(--accent); color: white; font-size: 7px; font-style: normal; font-weight: 850; letter-spacing: .05em; text-transform: uppercase; }
    .lg-atlas-mini-map { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 5px; min-height: 82px; margin: 10px 0; padding: 7px; border-radius: 10px; background: linear-gradient(155deg, color-mix(in srgb, var(--accent-soft) 62%, var(--panel)), var(--panel)); }
    .lg-atlas-mini-bed { min-width: 0; padding: 5px; border: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 7px; background: color-mix(in srgb, var(--panel) 78%, transparent); }
    .lg-atlas-mini-bed b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 7px; }
    .lg-atlas-mini-bed span { display: block; overflow: hidden; height: 21px; white-space: nowrap; font-size: 13px; letter-spacing: -3px; }
    .lg-atlas-card-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .lg-atlas-card-stats span { color: var(--muted); font-size: 8px; }
    .lg-atlas-card-stats b { color: var(--ink); }
    .lg-atlas-garden-card > footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); }
    .lg-atlas-garden-card footer small { color: var(--muted); font-size: 7px; }
    .lg-atlas-garden-card footer button { padding: 6px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); font-size: 8px; font-weight: 850; }
    .lg-atlas-garden-card footer button.lg-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .lg-atlas-columns { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(280px,.85fr); gap: 16px; align-items: start; }
    .lg-atlas-bed-map { display: grid; gap: 7px; }
    .lg-atlas-bed-row { display: grid; grid-template-columns: minmax(90px,.32fr) minmax(0,1fr); gap: 9px; align-items: center; min-height: 46px; padding: 7px 9px; border-radius: 10px; background: var(--panel-2); }
    .lg-atlas-bed-row strong, .lg-atlas-bed-row small { display: block; }
    .lg-atlas-bed-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
    .lg-atlas-bed-row small { color: var(--muted); font-size: 7px; }
    .lg-atlas-bed-plants { display: flex; align-items: center; gap: 0; min-width: 0; overflow: hidden; padding: 4px 6px; border: 1px dashed color-mix(in srgb, var(--accent) 28%, var(--line)); border-radius: 8px; background: var(--panel); }
    .lg-atlas-bed-plants span { flex: 0 0 auto; margin-right: -2px; font-size: 17px; cursor: help; }
    .lg-atlas-bed-plants i { color: var(--muted); font-size: 8px; }
    .lg-atlas-bed-plants em { margin-left: auto; color: var(--muted); font-size: 8px; font-style: normal; font-weight: 800; }
    .lg-snapshot-list { display: grid; gap: 6px; max-height: 330px; overflow: auto; padding-right: 2px; }
    .lg-snapshot-card { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 9px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
    .lg-snapshot-card strong, .lg-snapshot-card p, .lg-snapshot-card small { display: block; margin: 0; }
    .lg-snapshot-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
    .lg-snapshot-card p { margin-top: 2px; color: var(--muted); font-size: 8px; line-height: 1.3; }
    .lg-snapshot-card small { margin-top: 3px; color: var(--muted); font-size: 7px; }
    .lg-snapshot-card > div:last-child { display: flex; gap: 4px; }
    .lg-snapshot-card button { padding: 5px 7px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); font-size: 7px; font-weight: 850; }
    button.lg-danger-text { color: var(--danger); }
    .lg-atlas-empty { display: grid; place-items: center; gap: 7px; min-height: 150px; padding: 20px; border: 1px dashed var(--line); border-radius: 11px; color: var(--muted); text-align: center; }
    .lg-atlas-empty > span { font-size: 28px; }
    .lg-atlas-empty p { margin: 0; font-size: 9px; }
    .lg-atlas-empty button { padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font-size: 8px; font-weight: 800; }
    .lg-atlas-report { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
    .lg-atlas-report-card { min-width: 0; min-height: 220px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel-2); }
    .lg-atlas-report-card h4 { margin: 0 0 9px; font: 800 11px Georgia, serif; }
    .lg-atlas-bars { display: grid; gap: 7px; }
    .lg-atlas-bar-row { display: grid; grid-template-columns: minmax(70px,.65fr) minmax(75px,1fr) 26px; gap: 5px; align-items: center; }
    .lg-atlas-bar-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 7px; font-weight: 750; }
    .lg-atlas-bar-row > div { height: 7px; overflow: hidden; border-radius: 99px; background: var(--panel); }
    .lg-atlas-bar-row i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .lg-atlas-bar-row b { font-size: 7px; text-align: right; }
    .lg-atlas-bar-row small { grid-column: 1 / -1; margin-top: -4px; color: var(--muted); font-size: 6px; }
    .lg-atlas-months { display: grid; grid-template-columns: repeat(12,1fr); align-items: end; gap: 3px; height: 158px; padding-top: 8px; }
    .lg-atlas-months > div { display: grid; grid-template-rows: 1fr auto auto; align-items: end; height: 100%; min-width: 0; text-align: center; }
    .lg-atlas-months i { display: block; align-self: end; width: 70%; min-height: 2px; margin: auto; border-radius: 4px 4px 1px 1px; background: var(--accent); }
    .lg-atlas-months span { margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 5px; }
    .lg-atlas-months b { font-size: 5px; }
    .lg-atlas-ranked { display: grid; gap: 5px; }
    .lg-atlas-ranked > div { display: grid; grid-template-columns: 15px 20px minmax(0,1fr) auto; gap: 5px; align-items: center; min-width: 0; padding: 5px; border-radius: 7px; background: var(--panel); }
    .lg-atlas-ranked > div > b { color: var(--muted); font-size: 6px; text-align: center; }
    .lg-atlas-ranked > div > span { font-size: 14px; }
    .lg-atlas-ranked p { min-width: 0; margin: 0; }
    .lg-atlas-ranked strong, .lg-atlas-ranked small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lg-atlas-ranked strong { font-size: 7px; }
    .lg-atlas-ranked small { color: var(--muted); font-size: 6px; }
    .lg-atlas-ranked em { color: var(--accent); font-size: 8px; font-style: normal; font-weight: 850; }
    .lg-muted { color: var(--muted); font-size: 8px; }
    .lg-garden-dialog { width: min(560px, 100%); }
    .lg-garden-dialog-grid { display: grid; grid-template-columns: minmax(0,1fr) 110px; gap: 9px; }
    .lg-garden-dialog-grid label { display: grid; gap: 6px; color: var(--ink); font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
    .lg-garden-starter, .lg-share-options { display: grid; gap: 7px; margin: 13px 0 0; padding: 11px; border: 1px solid var(--line); border-radius: 11px; }
    .lg-garden-starter legend, .lg-share-options legend { padding: 0 5px; color: var(--muted); font-size: 9px; font-weight: 850; letter-spacing: .06em; text-transform: uppercase; }
    .lg-garden-starter label, .lg-share-options label { display: grid; grid-template-columns: 17px minmax(0,1fr); gap: 8px; align-items: start; padding: 8px; border-radius: 9px; background: var(--panel-2); cursor: pointer; }
    .lg-garden-starter input, .lg-share-options input { width: 15px; height: 15px; margin-top: 2px; }
    .lg-garden-starter b, .lg-garden-starter small, .lg-share-options b, .lg-share-options small { display: block; }
    .lg-garden-starter b, .lg-share-options b { font-size: 9px; }
    .lg-garden-starter small, .lg-share-options small { margin-top: 2px; color: var(--muted); font-size: 8px; line-height: 1.3; }
    .lg-share-dialog { width: min(600px,100%); }
    .lg-share-summary { display: grid; grid-template-columns: 48px minmax(0,1fr); gap: 10px; align-items: center; padding: 11px; border-radius: 11px; background: var(--panel-2); }
    .lg-share-summary > span { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 13px; background: var(--panel); font-size: 28px; }
    .lg-share-summary strong { display: block; font: 800 16px Georgia, serif; }
    .lg-share-summary p { margin: 3px 0 0; color: var(--muted); font-size: 9px; }
    .lg-share-warning { margin-top: 12px; padding: 10px; border: 1px solid color-mix(in srgb, #c59238 40%, var(--line)); border-radius: 10px; background: color-mix(in srgb, #f3d98b 17%, var(--panel)); }
    .lg-share-warning strong { font-size: 9px; }
    .lg-share-warning p { margin: 3px 0 0; color: var(--muted); font-size: 8px; line-height: 1.4; }
    @keyframes lg-atlas-arrive { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }

    .lg-dialog-layer { position: absolute; inset: 0; pointer-events: none; z-index: 10; }
    .lg-dialog-backdrop { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(22,31,24,.48); backdrop-filter: blur(4px); pointer-events: auto; }
    .lg-dialog { width: min(520px, 100%); max-height: 90%; overflow-y: auto; padding: 18px; border: 1px solid var(--line); border-radius: 17px; background: var(--panel); box-shadow: var(--shadow); }
    .lg-dialog-small { width: min(430px, 100%); }
    .lg-dialog-head { display: flex; justify-content: space-between; gap: 15px; margin-bottom: 15px; }
    .lg-dialog-head h3 { margin: 0; font: 800 21px/1.2 Georgia, serif; }
    .lg-dialog-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .lg-dialog > label { display: grid; gap: 6px; margin-top: 11px; color: var(--ink); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    .lg-dialog input, .lg-dialog select, .lg-dialog textarea { width: 100%; padding: 10px 11px; outline: 0; text-transform: none; letter-spacing: normal; font-weight: 500; }
    .lg-dialog input:focus, .lg-dialog select:focus, .lg-dialog textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .lg-dialog textarea { resize: vertical; min-height: 82px; }
    .lg-dialog-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
    .lg-dialog-actions > span { flex: 1; }
    button.lg-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
    .lg-toast { position: absolute; right: 0; bottom: 77px; max-width: 360px; padding: 10px 13px; border-radius: 10px; background: var(--ink); color: var(--panel); box-shadow: 0 8px 25px rgba(0,0,0,.22); opacity: 0; transform: translateY(8px); pointer-events: none; transition: .18s ease; font-weight: 700; }
    .lg-toast[data-visible="true"] { opacity: 1; transform: translateY(0); }
    @media (max-width: 760px) {
      .lg-shell { right: 10px; bottom: 10px; }
      .lg-panel { right: -2px; bottom: 68px; width: calc(100vw - 16px); height: calc(100vh - 88px); border-radius: 18px; }
      .lg-body { grid-template-columns: 1fr; }
      .lg-sidebar { display: none; }
      .lg-main-head { align-items: stretch; flex-direction: column; }
      .lg-filters { flex-direction: column; align-items: stretch; }
      .lg-search { min-width: 0; }
      .lg-garden-grid { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
      .lg-save-state { display: none; }
      .lg-view-switch { order: 5; }
      .lg-landscape-bed > header { position: relative; z-index: 2; }
      .lg-garden-tooltip { width: 180px; }
      .lg-garden-sky { height: 46px; }
      .lg-toolbar { padding-right: 8px; }
      .lg-journal-kpis { grid-template-columns: 1fr 1fr; }
      .lg-journal-grid, .lg-journal-grid-top { grid-template-columns: 1fr; }
      .lg-vitality-mix { grid-template-columns: 120px 1fr; }
      .lg-vitality-ring { width: 120px; }
      .lg-history-kpis { grid-template-columns: 1fr 1fr; }
      .lg-import-choices, .lg-import-options { grid-template-columns: 1fr; }
      .lg-import-options .lg-import-check { grid-column: 1; }
      .lg-import-summary { grid-template-columns: 1fr 1fr; }
      .lg-import-row { grid-template-columns: 17px 30px minmax(0, 1fr); }
      .lg-import-row > b { grid-column: 3; justify-self: start; }
      .lg-ecology-grid { grid-template-columns: 1fr; }
      .lg-cultivation-kpis, .lg-cultivation-grid, .lg-repair-candidates { grid-template-columns: 1fr; }
      .lg-cultivation-kpis { grid-template-columns: 1fr 1fr; }
      .lg-ecology-preview em { display: none; }
      .lg-garden-sky button { font-size: 0; width: 31px; height: 31px; padding: 0; }
      .lg-garden-sky button::after { content: '☀'; font-size: 14px; }
      .lg-timeline-event { grid-template-columns: 32px 1fr; }
      .lg-timeline-event > button { grid-column: 2; justify-self: start; }
      .lg-atlas-kpis { grid-template-columns: 1fr 1fr; }
      .lg-atlas-columns, .lg-atlas-report { grid-template-columns: 1fr; }
      .lg-atlas-map { grid-template-columns: 1fr; }
      .lg-atlas-controls { min-width: 0; }
      .lg-atlas-bed-row { grid-template-columns: 90px minmax(0,1fr); }
      .lg-garden-dialog-grid { grid-template-columns: 1fr; }
    }
  `;

  recordVisit(location.href, document.title);
  initUI();
  installNavigationWatch();
  installEcologyClock();
  registerMenuCommands();
})();
