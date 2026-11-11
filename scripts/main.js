import {buildTopLayerClasses, TOP_LAYER_EFFECT} from "./top-ring.mjs";

const MODULE_ID = "multiple-rings";
const RING_SELECT_ID = "multiple-rings-appearance-select";
const FLAG_PATH = `flags.${MODULE_ID}.ringAppearance`;
const TOKEN_FLAG_PATH = `token.${FLAG_PATH}`;
const MEGA_ID = "mringsCombinedRings";
const MEGA_SHEET_KEY = "multiple-rings-combined.json";

// Eviction: unload packs the moment no placed token wears them. The debounce
// collapses token bursts (paste, bulk delete, scene load) into one rebuild.
const EVICT_DEBOUNCE_MS = 500;

// Quality ladder for the per-pack bake budget (descending). When packs don't
// fit the atlas, the least important ones step down rung by rung.
const SCALE_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
// The world default ring is on every un-flagged token — it degrades like any
// other pack but never drops below this rung.
const WORLD_MIN_SCALE = 0.5;
// Reference density of well-authored ring sheets: ~512px of frame per grid
// cell (med 512 @ gridTarget 1, lrg 1024 @ 2, gnt 2048 @ 4). Frames denser
// than this are capped at bake time — the ring shader samples the frame at
// the token's on-screen size, so extra texels never reach the screen.
const RING_PX_PER_CELL = 512;
// Transparent gutter between atlas slots: keeps linear filtering (and
// mipmaps) from bleeding neighbouring frames into a ring's edge.
const SLOT_PAD = 4;
// Browsers cap 2D canvases below what some GPUs report as MAX_TEXTURE_SIZE
// (Chrome: 32767px per side, ~268M px area); past the cap a canvas silently
// fails. 16384² is the largest square every major browser accepts.
const CANVAS_MAX_SIDE = 16384;
// Spare rows reserved on every (re)plan so the next worn pack or size
// variant can usually be appended instead of forcing a full rebuild.
const ATLAS_HEADROOM_MIN = 128;
const ATLAS_HEADROOM_MAX = 1024;
const ATLAS_HEADROOM_RATIO = 0.25;
// A pack that failed (load error, no room) is retried on demand after this.
const FAILED_RETRY_MS = 60_000;
// Default AE priority of an "override" change (CONST mode 5 × 10).
const DEFAULT_OVERRIDE_PRIORITY = 50;

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

let worldConfigId = null;
let booted = false;
let activationStarted = false;
let featureOK = true;
let capacityWarned = false;
let wrappersInstalled = false;
let rebuildInProgress = false;
let rebuildPromise = Promise.resolve();   // never rejects
let evictDebounce = null;
// {TopRingSamplerShader, setTopAtlas} when the top layer ("two-layer
// token") is supported by this core build, null otherwise
let topLayerClasses = null;
const warnedUnknownPacks = new Set();
const warnedNoWearers = new Set();  // cfgId -> "no wearers yet" logged once

// Metadata registry built from JSONs only (no images needed)
// key = "<cfgId>:<frameName>"
const ringRegistry = [];
const sheetFrameIds = new Map();   // cfgId -> Set<prefixed keys>
const sheetScale = new Map();      // cfgId -> visual ring scale (sheet config.scale)
const sheetSources = new Map();    // cfgId -> { imgPath, rects, config, ... }
const materialized = new Map();    // cfgId -> PIXI.Texture (source image, kept while baked)
const stagedTextures = new Map();  // cfgId -> PIXI.Texture (loaded by pendingSheets, ready for rebuildAtlas)
const failedSheets = new Map();    // cfgId -> failure timestamp
const pendingSheets = new Map();   // cfgId -> Promise<boolean|"deferred">
const variantJobs = new Map();     // cfgId -> Promise (variant top-up bakes)
const sheetSlots = new Map();      // cfgId -> [{key,x,y,w,h}]
const lastUsed = new Map();        // cfgId -> Date.now()
const topImageCache = new Map();   // overlay file url -> Promise<PIXI.Texture|null>
const resolvedTopImages = new Map(); // overlay file url -> PIXI.Texture (after load)
const lastPackOf = new WeakMap();  // Token -> pack id it asked for at its last draw

// Atlas packing state
let atlasCanvas = null;
let atlasCtx = null;
let atlasBaseTexture = null;
let atlasSheet = null;
// Shadow atlas: same dimensions as the main one, overlay frames blitted at
// the same rects as their ring frames, so the top-layer shader can address
// it with the ring's own UVs (core's attribute budget is already full).
// Only created while some planned pack actually has overlays.
let topAtlasCanvas = null;
let topAtlasCtx = null;
let topAtlasBaseTexture = null;
let currentPlanNeedTop = false;        // whether the current plan wanted a shadow atlas
let atlasW = 2048;
let atlasH = 1024;
const pack = { x: 0, y: 0, rowH: 0 };  // shelf cursor of the live atlas
let plannedOrder = [];                 // bake order the current atlas was planned with
let plannedRects = new Map();          // cfgId -> rects planned for the current atlas generation
const scaleAssignments = new Map(); // cfgId -> baked scale, planned at createAtlas
const reportedScales = new Map();   // cfgId -> last logged scale (dedupes budget logs)
const appliedScaleCaps = new Map(); // cfgId -> density cap baked into the current atlas
// Double-buffering: a rebuild bakes into the new atlas without touching live
// renderer state; commitAtlas() installs everything in one synchronous tick
const deferredFrameTextures = new Map(); // frame key -> Texture (new atlas)
const pendingSlots = new Map();          // cfgId -> slots (new atlas)
let retiredAtlas = null;                 // previous { baseTexture, top }, destroyed after commit
let pendingGenerationSwap = false;       // new sheet / shadow atlas wait for commitAtlas

// Active context used by the wrapped getRingDataBySize / configureSize
const moduleContext = { allowed: null, renderPack: null };
function currentAllowed() { return moduleContext.allowed; }
function setAllowed(v) { moduleContext.allowed = v; }

/* ------------------------------------------------------------------ */
/* Settings & registration                                            */
/* ------------------------------------------------------------------ */
/* No module settings: when the per-token ring choices are not wanted,
 * disable the module itself in Manage Modules. */

Hooks.on("initializeDynamicTokenRingConfig", (ringConfig) => {
  try {
    const DynamicRingData = foundry.canvas.placeables.tokens.DynamicRingData;
    topLayerClasses = buildTopLayerClasses();
    ringConfig.addConfig(MEGA_ID, new DynamicRingData({
      id: MEGA_ID,
      label: game.i18n.localize("MRINGS.CombinedConfigLabel"),
      spritesheet: MEGA_SHEET_KEY,
      // Only the shader is swapped: the ringClass stays native because core
      // recreates ring instances only when none exists yet, so a custom
      // class would never reach tokens drawn before activation. The top
      // layer rides TokenRing.prototype patches instead (see installPatches).
      ...(topLayerClasses ? {
        framework: {
          shaderClass: topLayerClasses.TopRingSamplerShader
        }
      } : {})
    }));
    hideInternalConfig();
  } catch (e) {
    topLayerClasses = null;
    console.warn(`${MODULE_ID} | failed to register combined ring config`, e);
  }
});

function hideInternalConfig() {
  try {
    const inst = globalThis.CONFIG?.Token?.ring;
    if (!inst || inst.__mringsLabelsPatched) return;
    const proto = Object.getPrototypeOf(inst);
    const desc = Object.getOwnPropertyDescriptor(proto, "configLabels");
    if (!desc?.get) return;
    Object.defineProperty(proto, "configLabels", {
      ...desc,
      get() {
        const labels = desc.get.call(this);
        if (!labels || typeof labels !== "object") return labels;
        const { [MEGA_ID]: _hidden, ...rest } = labels;
        return rest;
      }
    });
    inst.__mringsLabelsPatched = true;
  } catch (e) {
    console.warn(`${MODULE_ID} | failed to hide internal ring config`, e);
  }
}

/** Next ladder step strictly below s, or null when already at the bottom. */
function nextStepBelow(s) {
  for (const v of SCALE_STEPS) if (v < s - 1e-9) return v;
  return null;
}

/** Scale a given pack bakes at. */
function packScale(cfgId) {
  return scaleAssignments.get(cfgId) ?? packStartScale(cfgId);
}

/** Scale a pack starts at before the budget degrades it: purely the density
 * cap, applied exactly (no ladder step — caps like 25%/75% would only lose
 * quality to quantization). There is no quality to preserve in texels the
 * renderer can never sample. */
function packStartScale(cfgId, rects) {
  return packScaleCap(cfgId, rects);
}

/** Slot size for a source frame after applying a bake scale. */
function scaledFrameSize(fr, scale) {
  return {
    w: Math.max(1, Math.round(fr.w * scale)),
    h: Math.max(1, Math.round(fr.h * scale))
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Changes array of an ActiveEffect (v14: system.changes; v13: changes). */
function effectChanges(effect) {
  const changes = effect?.system?.changes ?? effect?.changes;
  return Array.isArray(changes) ? changes : [];
}

/** Whether an ActiveEffect currently applies (not disabled nor suppressed). */
function effectIsActive(effect) {
  if (!effect) return false;
  if (typeof effect.active === "boolean") return effect.active;
  return !effect.disabled && !effect.isSuppressed && !effect.suppressed;
}

/** Whether an ActiveEffect change key targets the ring flag (directly or via v14's `token.` prefix). */
function isRingEffectKey(key) {
  return key === FLAG_PATH || key === TOKEN_FLAG_PATH;
}

function effectTouchesRing(effect) {
  return effectChanges(effect).some(c => isRingEffectKey(c?.key));
}

/** Ring values are pack ids; anything else (null, migrated non-strings) is coerced. */
function normalizeRingValue(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Ring override carried by ActiveEffect changes, resolved the way core
 * applies changes: by ascending priority, later effects winning ties.
 * Covers item-transferred effects (Actor#appliedEffects) and both
 * `flags.multiple-rings.ringAppearance` and `token.flags.multiple-rings.ringAppearance`.
 * @returns {string|undefined} pack id, "" for an explicit world default,
 *   undefined when no effect overrides the ring
 */
function effectRingOverride(actor) {
  try {
    if (!actor) return undefined;
    const fx = actor.appliedEffects ?? actor.effects;
    if (!fx) return undefined;
    let out;
    let bestPriority = -Infinity;
    for (const effect of fx) {
      if (!effectIsActive(effect)) continue;
      for (const change of effectChanges(effect)) {
        if (!isRingEffectKey(change?.key)) continue;
        const raw = change.priority;
        let priority = (raw === null || raw === undefined || raw === "") ? DEFAULT_OVERRIDE_PRIORITY : Number(raw);
        if (!Number.isFinite(priority)) priority = DEFAULT_OVERRIDE_PRIORITY;
        if (priority >= bestPriority) {
          bestPriority = priority;
          out = normalizeRingValue(change.value);
        }
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Actor behind a token/prototype document (or the actor itself). */
function actorOf(doc) {
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  return doc.actor
    ?? (doc.parent?.documentName === "Actor" ? doc.parent : null)
    ?? (doc.actorId ? game.actors?.get(doc.actorId) : null)
    ?? null;
}

/**
 * Own ring flag stored directly on `doc` (token or prototype token), ignoring
 * both ActiveEffects (including v14's `token.flags.*` in-memory mutations on
 * `doc.flags`) and the actor's prototype fallback. Used by the config form
 * selector so saving a token never copies the prototype's or effect's ring
 * into the token's own persistent flag.
 * @returns {string|null}
 */
function getOwnRingId(doc) {
  if (!doc) return null;
  const src = doc._source ?? doc;
  const own = foundry.utils.getProperty(src, FLAG_PATH);
  if (own === undefined || own === null) return null;
  return normalizeRingValue(own) || null;
}

/**
 * Stored (non-effect) ring choice of a document: its own non-empty flag or,
 * when unset/Default (""), the actor's prototype token choice. Uses `baseActor`
 * when available so reading an unlinked token's fallback never materializes
 * its lazy `ActorDelta`.
 * @returns {string|null}
 */
function storedRingValue(doc) {
  if (!doc) return null;
  const own = getOwnRingId(doc);
  if (own) return own;
  const proto = (doc.baseActor ?? actorOf(doc))?.prototypeToken;
  if (!proto || proto === doc) return null;
  return getOwnRingId(proto);
}

/**
 * Effective ring pack for a document.
 * Resolution order:
 *   1. ActiveEffect change with key `flags.multiple-rings.ringAppearance`
 *      ("" = explicit world default via effect)
 *   2. Token document flag (non-empty)
 *   3. Actor prototype token flag (when the token is on Default)
 *   4. null (= world default)
 */
function getEffectiveRingId(doc) {
  if (!doc) return null;
  const ae = effectRingOverride(actorOf(doc));
  if (ae !== undefined) return ae || null;
  return storedRingValue(doc);
}

/**
 * Ring pack choices for UI selectors.
 * @param {object} [options]
 * @param {boolean} [options.indexedOnly] Only packs the atlas can actually
 *   bake (indexed at preload). DAE wants every registered pack; the token
 *   selector must not offer one the module would silently strand on the
 *   world default.
 */
function getRingChoices({ indexedOnly = false } = {}) {
  const ring = globalThis.CONFIG?.Token?.ring;
  if (!ring) return {};
  const out = {};
  try {
    for (const id of ring.configIDs ?? []) {
      if (id === MEGA_ID) continue;
      if (indexedOnly && !sheetFrameIds.has(id)) continue;
      out[id] = game.i18n.localize(ring.getConfig(id)?.label ?? id);
    }
  } catch { /* noop */ }
  return out;
}

function colorToLE(value, fallback = null) {
  try {
    const ColorClass = foundry.utils.Color ?? globalThis.Color;
    if (value === undefined || value === null || !ColorClass) return fallback;
    const c = ColorClass.from(value);
    return c.valid ? c.littleEndian : fallback;
  } catch {
    return fallback;
  }
}

function getMaxTextureSize() {
  try {
    const r = canvas.app?.renderer;
    if (r?.gl) return r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE) || 4096;
  } catch { /* noop */ }
  return 4096;
}

/** Largest atlas side both the GPU and a 2D canvas can handle. */
function atlasMaxSide() {
  return Math.min(getMaxTextureSize(), CANVAS_MAX_SIDE);
}

function warnCapacityOnce() {
  if (capacityWarned) return;
  capacityWarned = true;
  console.warn(`${MODULE_ID} | atlas capacity reached: some ring packs could not be baked (see packList in MultipleRings.status())`);
}

function markFailed(cfgId) {
  failedSheets.set(cfgId, Date.now());
}

/** Failed and not yet due for a retry. Indexed packs get another chance
 * after FAILED_RETRY_MS (transient load errors, temporary lack of room). */
function isFailed(cfgId) {
  const t = failedSheets.get(cfgId);
  if (t === undefined) return false;
  if (sheetSources.has(cfgId) && Date.now() - t > FAILED_RETRY_MS) {
    failedSheets.delete(cfgId);
    return false;
  }
  return true;
}

function textureUsable(tex) {
  const bt = tex?.baseTexture;
  return !!bt && bt.valid && !bt.destroyed && !!bt.resource?.source;
}

function redrawToken(t) {
  if (!t || t.destroyed) return;
  try {
    const flags = t.renderFlags?.flags;
    if (flags && "refreshMesh" in flags && "refreshRingVisuals" in flags) {
      t.renderFlags.set({ refreshMesh: true, refreshRingVisuals: true });
    } else {
      t.renderFlags?.set({ redraw: true });
    }
  } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Preload: fetch JSONs, build metadata registry, size the atlas      */
/* ------------------------------------------------------------------ */

/**
 * Resolve an image path from a spritesheet against the sheet location.
 * Handles relative paths, absolute/protocol URLs, data: and blob: URIs —
 * custom rings (e.g. SETT) may register any of these.
 */
function resolveSheetURL(img, sheetSrc) {
  img = String(img);
  if (/^(data|blob|https?|ftp):/i.test(img) || img.startsWith("/")) return img;
  try {
    return new URL(img, new URL(sheetSrc, location.origin)).href;
  } catch {
    const dir = sheetSrc.slice(0, sheetSrc.lastIndexOf("/") + 1);
    return dir + img;
  }
}

/** Frame dictionary of a sheet JSON. Accepts the PIXI hash format and the
 * TexturePacker array export ([{filename, frame, ...}]). */
function sheetFrames(json) {
  const frames = json?.frames ?? json?.config?.frames;
  if (!frames) return null;
  if (!Array.isArray(frames)) return typeof frames === "object" ? frames : null;
  const out = {};
  for (const f of frames) {
    const name = f?.filename ?? f?.name;
    if (name) out[String(name)] = f;
  }
  return out;
}

function validRect(fr) {
  return fr && [fr.x, fr.y, fr.w, fr.h].every(Number.isFinite) && fr.w > 0 && fr.h > 0;
}

async function fetchSheet(cfgId) {
  const cfg = CONFIG.Token.ring.getConfig(cfgId);
  if (!cfg?.spritesheet) return null;
  try {
    const resp = await fetch(cfg.spritesheet);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { cfgId, cfg, json: await resp.json() };
  } catch (e) {
    console.warn(`${MODULE_ID} | skipping ring sheet ${cfg.spritesheet}:`, e);
    return null;
  }
}

function indexSheet({ cfgId, cfg, json }) {
  const frames = sheetFrames(json);
  if (!frames) {
    console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet} has no recognizable frames — skipped`);
    return;
  }
  const metaImage = json.meta?.image;
  if (!metaImage) {
    console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet} has no meta.image — skipped`);
    return;
  }

  const rects = [];
  for (const [name, f] of Object.entries(frames)) {
    const fr = f?.frame;
    if (!validRect(fr)) continue;
    rects.push({ key: `${cfgId}:${name}`, data: f, w: fr.w, h: fr.h });
  }
  if (!rects.length) {
    console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet} has no drawable frames — skipped`);
    return;
  }

  // Top-layer companions: `config.overlays` maps a base frame name to an
  // extra frame drawn ABOVE the token subject. The rect points either
  // into the sheet image itself (`frame` only) or into a separate file
  // (`image` + `frame`, resolved relative to the sheet URL). Neither
  // PIXI nor the core ring renderer read that block, so with the module
  // disabled the sheet behaves as a normal ring sheet.
  const topByBase = new Map();
  const overlayDefs = (json.config ?? {}).overlays;
  if (overlayDefs && typeof overlayDefs === "object") {
    for (const [baseName, ov] of Object.entries(overlayDefs)) {
      const fr = ov?.frame;
      if (!validRect(fr)) continue;
      if (!frames[baseName]) {
        console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet}: overlay "${baseName}" has no matching base frame — skipped`);
        continue;
      }
      const key = `${cfgId}:${baseName}-top`;
      rects.push({
        key,
        data: { frame: fr },
        w: fr.w,
        h: fr.h,
        isTop: true,
        imageOverride: ov.image ? resolveSheetURL(ov.image, cfg.spritesheet) : null
      });
      topByBase.set(baseName, key);
    }
  }

  rects.sort((a, b) => b.h - a.h);

  // Group frames into size variants: a base frame plus its optional
  // -bkg/-msk/-top companions targets one token grid size, and a placed
  // token resolves exactly one variant via getRingDataBySize. Only the
  // variants in actual use get baked (see bakeRects).
  const variantTargets = new Map();
  for (const r of rects) {
    if (r.isTop || r.key.endsWith("-bkg") || r.key.endsWith("-msk")) continue;
    variantTargets.set(r.key, r.data.gridTarget ?? 1);
  }
  for (const r of rects) {
    r.variant = variantBaseKey(r.key);
    r.gridTarget = variantTargets.get(r.variant) ?? 1;
  }

  // Remember raw locations; image URL is resolved lazily per pack
  const src = {
    imgPath: null,
    rects,
    variantCount: variantTargets.size,
    config: json.config ?? {},
    sheetSrc: cfg.spritesheet,
    metaImage
  };
  sheetSources.set(cfgId, src);

  // Metadata registry with PER-SHEET default colors baked per frame
  const defBand = src.config.defaultColorBand
    ?? { startRadius: 0.59, endRadius: 0.7225 };
  const defRC = colorToLE(src.config.defaultRingColor);
  const defBC = colorToLE(src.config.defaultBackgroundColor);
  const DEFAULT_RING_THICKNESS = 0.1269848;
  const DEFAULT_SUBJECT_THICKNESS = 0.6666666;

  sheetFrameIds.set(cfgId, new Set(rects.map(r => r.key)));

  // Ring scale: `config.scale` from the sheet JSON magnifies the ring art
  // relative to the token (subject unchanged). Core ignores the field; the
  // configureSize patch feeds it in as scaleMultiplier (1/scale).
  const cfgScale = Number(src.config.scale);
  if (Number.isFinite(cfgScale) && cfgScale > 0) {
    sheetScale.set(cfgId, Math.min(10, Math.max(0.1, cfgScale)));
  }

  for (const r of rects) {
    if (r.isTop || r.key.endsWith("-bkg") || r.key.endsWith("-msk")) continue;
    const fm = r.data;
    const rc = colorToLE(fm.ringColor, defRC);
    const bc = colorToLE(fm.backgroundColor, defBC);
    const ringThickness = fm.ringThickness ?? DEFAULT_RING_THICKNESS;
    const topName = topByBase.get(r.key.slice(cfgId.length + 1));
    ringRegistry.push({
      ringName: r.key,
      bkgName: `${r.key}-bkg`,
      maskName: `${r.key}-msk`,
      colorBand: foundry.utils.deepClone(fm.colorBand ?? defBand),
      gridTarget: fm.gridTarget ?? 1,
      defaultRingColorLittleEndian: rc,
      defaultBackgroundColorLittleEndian: bc,
      subjectScaleAdjustment: 1 / (ringThickness + DEFAULT_SUBJECT_THICKNESS),
      ...(topName ? { topName } : {})
    });
  }
}

async function preloadRegistries() {
  ringRegistry.length = 0;
  sheetFrameIds.clear();
  sheetScale.clear();
  sheetSources.clear();

  const ring = CONFIG.Token.ring;
  const ids = (ring.configIDs ?? []).filter(id => id !== MEGA_ID);
  if (!ids.length) return false;

  // Fetch all sheet JSONs in parallel, index them in registration order
  const sheets = await Promise.all(ids.map(fetchSheet));
  for (const entry of sheets) {
    if (!entry) continue;
    try {
      indexSheet(entry);
    } catch (e) {
      console.warn(`${MODULE_ID} | skipping ring sheet ${entry.cfg.spritesheet}:`, e);
    }
  }

  ringRegistry.sort((a, b) => a.gridTarget - b.gridTarget);

  // Resolve which config the world actually uses.
  // NOTE: do NOT use CONFIG.Token.ring.id here — module-registered packs
  // (e.g. SETT) build DynamicRingData without an `id` field, so cfg.id is ""
  // even though the config map key is a real id. The world SETTING stores
  // the map key directly, which is exactly what we need. The setting has
  // requiresReload, so it never changes under a running session.
  let worldSetting = null;
  try { worldSetting = game.settings.get("core", "dynamicTokenRing") ?? null; } catch { /* noop */ }
  worldConfigId ??= worldSetting;
  const worldIndexed = sheetFrameIds.has(worldConfigId);
  console.log(`${MODULE_ID} | world ring setting "${worldConfigId}" ${worldIndexed ? "indexed" : "NOT indexed"}; ` +
    `indexed packs: ${[...sheetFrameIds.keys()].join(", ") || "(none)"}`);

  console.log(`${MODULE_ID} | indexed ${sheetSources.size} ring sheets, ${ringRegistry.length} rings`);
  return sheetSources.size > 0 && worldConfigId != null;
}

/** Packs the budget actually plans for: the world default plus everything in use. */
function planningSet() {
  const set = new Set(materialized.keys());
  for (const id of pendingSheets.keys()) set.add(id);
  for (const t of ringWearers()) {
    if (!ringShown(t)) continue;
    const id = effectivePackOf(t);
    if (id && !isFailed(id)) set.add(id);
  }
  if (worldConfigId) set.add(worldConfigId);
  return [...set].filter(id => sheetSources.has(id));
}

/**
 * Deterministic bake order shared by the planner and the rebuild, so the
 * simulated layout is exactly the one that gets baked: world default first,
 * then baked packs by recency, then packs still waiting for their first bake
 * (they are appended after the rebuild).
 */
function bakeOrder(ids) {
  const mru = (a, b) => (lastUsed.get(b) ?? 0) - (lastUsed.get(a) ?? 0);
  const rest = ids.filter(id => id !== worldConfigId);
  return [
    ...(ids.includes(worldConfigId) ? [worldConfigId] : []),
    ...rest.filter(id => materialized.has(id)).sort(mru),
    ...rest.filter(id => !materialized.has(id)).sort(mru)
  ];
}

/* ------------------------------------------------------------------ */
/* Size variants                                                      */
/* ------------------------------------------------------------------ */

/** Strip a frame key's -bkg/-msk/-top companion suffix (base variant key). */
function variantBaseKey(key) {
  return key.replace(/-(bkg|msk|top)$/, "");
}

/** Size variants (base frame keys) of a pack that are currently baked. */
function bakedVariantsOf(cfgId) {
  const set = new Set();
  for (const s of sheetSlots.get(cfgId) ?? []) set.add(variantBaseKey(s.key));
  return set;
}

/** Token size exactly as the core computes it for getRingDataBySize. */
function tokenRingSize(token) {
  const doc = token?.document ?? token;
  const w = Number(doc?.width), h = Number(doc?.height);
  return Math.min(Number.isFinite(w) ? w : 1, Number.isFinite(h) ? h : 1);
}

/**
 * Target (post-animation) token size read from `doc._source`. During a resize
 * animation core interpolates `doc.width` / `doc.height` every frame for 1000ms
 * while `doc._source` already holds the destination dimensions; sizing and
 * eviction against `_source` avoids per-frame density-cap rebuilds and keeps
 * mid-animation eviction from dropping or retaining the wrong size variant.
 */
function tokenTargetRingSize(token) {
  const doc = token?.document ?? token;
  const src = doc?._source;
  const sw = Number(src?.width), sh = Number(src?.height);
  if (Number.isFinite(sw) && Number.isFinite(sh)) return Math.min(sw, sh);
  return tokenRingSize(token);
}

/**
 * Variant (base frame key) a token size resolves to within a pack. Mirrors
 * the wrapped getRingDataBySize pick over the pack's full frame list, so the
 * baked set always covers exactly what placed tokens would resolve to.
 */
function resolveVariantKey(cfgId, size) {
  const allowed = sheetFrameIds.get(cfgId);
  if (!allowed || !ringRegistry.length) return null;
  let best = null, bestDist = Infinity;
  for (const r of ringRegistry) {
    if (!allowed.has(r.ringName)) continue;
    const d = Math.abs(r.gridTarget - size);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best?.ringName ?? null;
}

/** Pack a placed token renders with: its explicit choice or the world default. */
function effectivePackOf(token) {
  return getEffectiveRingId(token?.document ?? token) || worldConfigId;
}

function ringShown(token) {
  const doc = token?.document ?? token;
  return doc?.ring?.enabled !== false;
}

/**
 * Everything that currently renders (or previews) a ring: placed tokens
 * plus open token-config preview clones. The clone being edited already
 * carries the freshly selected pack, so its variant must be baked for the
 * live preview — before the change is ever applied.
 */
function ringWearers() {
  const out = [];
  for (const t of canvas.tokens?.placeables ?? []) out.push(t);
  for (const c of canvas.tokens?._configPreview?.children ?? []) {
    if (c?._previewType === "config") out.push(c);
  }
  return out;
}

/** True while any placed token or open preview renders the given pack. */
function packHasWearers(cfgId) {
  for (const t of ringWearers()) {
    if (ringShown(t) && effectivePackOf(t) === cfgId) return true;
  }
  return false;
}

/** Base keys of the size variants placed tokens actually use in a pack. */
function neededVariants(cfgId) {
  const set = new Set();
  const allowed = sheetFrameIds.get(cfgId);
  for (const t of ringWearers()) {
    if (!ringShown(t)) continue; // core renders no ring
    if (effectivePackOf(t) !== cfgId) continue;
    const cur = tokenRingSize(t);
    const target = tokenTargetRingSize(t);
    const curKey = resolveVariantKey(cfgId, cur);
    const targetKey = resolveVariantKey(cfgId, target);
    if (curKey) set.add(curKey);
    if (targetKey) set.add(targetKey);
    // While a resize animation is in flight, keep any intermediate size
    // variants between the current and target sizes so mid-animation frames
    // never fall back to a distant size.
    if (allowed && Math.abs(cur - target) > 1e-4) {
      const lo = Math.min(cur, target), hi = Math.max(cur, target);
      for (const r of ringRegistry) {
        if (allowed.has(r.ringName) && r.gridTarget >= lo && r.gridTarget <= hi) {
          set.add(r.ringName);
        }
      }
    }
  }
  return set;
}

/** True when a baked pack holds size variants no current wearer needs anymore. */
function hasUnusedVariants(cfgId) {
  const baked = bakedVariantsOf(cfgId);
  if (!baked.size) return false;
  const needed = neededVariants(cfgId);
  if (cfgId === worldConfigId) {
    const key = resolveVariantKey(cfgId, 1);
    if (key) needed.add(key);
  }
  for (const k of baked) {
    if (!needed.has(k)) return true;
  }
  return false;
}

/**
 * Upper bound on a pack's bake scale derived from actual need rather than
 * frame authoring. Each wearer resolves to a specific size variant in the
 * pack; ~RING_PX_PER_CELL per grid cell of that wearer against the frame size
 * of the variant it resolves to is full parity with well-authored packs.
 * Denser source frames (e.g. single-variant 2048px sheets worn by 1×1 tokens,
 * or core's 2048px gargantuan variant worn only by 3×3 Huge tokens) are
 * capped instead of burning atlas memory on texels the shader can never show,
 * while 1×1 tokens on multi-variant packs keep their 512px medium frames at
 * 100% even when a 3×3 token shares the pack.
 */
function packScaleCap(cfgId, rects = bakeRects(cfgId)) {
  if (!rects.length) return 1;
  const allRects = sheetSources.get(cfgId)?.rects ?? rects;
  const frameByVariant = new Map();
  for (const r of allRects) {
    if (r.isTop) continue;
    const prev = frameByVariant.get(r.variant) ?? 0;
    frameByVariant.set(r.variant, Math.max(prev, r.data.frame.w, r.data.frame.h));
  }
  const visualScale = Math.max(1, sheetScale.get(cfgId) ?? 1);
  const pxPerCell = RING_PX_PER_CELL * visualScale;
  let maxCap = 0;
  const considerSize = size => {
    const vKey = resolveVariantKey(cfgId, size);
    const frameSide = vKey ? frameByVariant.get(vKey) : 0;
    if (frameSide > 0) maxCap = Math.max(maxCap, (pxPerCell * size) / frameSide);
  };
  for (const t of ringWearers()) {
    if (!ringShown(t) || effectivePackOf(t) !== cfgId) continue;
    considerSize(tokenRingSize(t));
    considerSize(tokenTargetRingSize(t));
  }
  if (cfgId === worldConfigId || maxCap === 0) considerSize(1);
  if (maxCap === 0) {
    let maxFrame = 0;
    for (const r of rects) maxFrame = Math.max(maxFrame, r.data.frame.w, r.data.frame.h);
    return maxFrame ? Math.min(1, pxPerCell / maxFrame) : 1;
  }
  return Math.min(1, maxCap);
}

/**
 * Source rects to bake for a pack: only the size variants placed tokens
 * resolve to, each with its -bkg/-msk/-top companions. Empty when unused —
 * a pack sheet with 5 size variants then costs 1 instead of 5.
 * Exception: the world pack always keeps its medium variant. It is the
 * fallback every token draws with while its own pack bakes (or after its
 * pack failed); without it such a token would pick an arbitrary pack.
 */
function bakeRects(cfgId) {
  const src = sheetSources.get(cfgId);
  if (!src) return [];
  const needed = neededVariants(cfgId);
  if (cfgId === worldConfigId) {
    const key = resolveVariantKey(cfgId, 1);
    if (key) needed.add(key);
  }
  if (!needed.size) return [];
  return src.rects.filter(r => needed.has(r.variant));
}

/** Frames that live in the main atlas (overlays go to the shadow atlas only). */
function mainRects(rects) {
  return rects.filter(r => !r.isTop);
}

function hasOverlayRects(rects) {
  return rects.some(r => r.isTop);
}

/**
 * Shelf packer step shared by the planner, the fit check and the baker.
 * Mutates the cursor `st` and returns the slot origin; the caller checks
 * the slot against the atlas bounds.
 */
function shelfPlace(st, w, h, width) {
  const fw = w + SLOT_PAD, fh = h + SLOT_PAD;
  if (st.x > 0 && st.x + fw > width) { st.x = 0; st.y += st.rowH; st.rowH = 0; }
  const pos = { x: st.x, y: st.y };
  st.x += fw;
  st.rowH = Math.max(st.rowH, fh);
  return pos;
}

/** Packed height of the given packs, each at its own scale (Infinity when a
 * frame is wider than the atlas). */
function simulateHeight(width, packIds, scaleOf, rectsById) {
  const st = { x: 0, y: 0, rowH: 0 };
  for (const cfgId of packIds) {
    const s = scaleOf(cfgId) ?? 1;
    for (const r of mainRects(rectsById.get(cfgId) ?? [])) {
      const { w, h } = scaledFrameSize(r.data.frame, s);
      if (w > width) return Infinity;
      shelfPlace(st, w, h, width);
    }
  }
  return st.y + st.rowH;
}

/**
 * Assign every pack its starting scale (the density cap — fully automatic),
 * then step the least important packs down the ladder until the full layout
 * fits the size limit. The atlas width is a choice too: a layout that fits
 * at the full width always beats degrading packs.
 */
function planScales(maxSide) {
  const ids = bakeOrder(planningSet());
  // Only the size variants placed tokens actually use count against the budget
  const rectsById = new Map(ids.map(id => [id, bakeRects(id)]));
  const startById = new Map(ids.map(id => [id, packStartScale(id, rectsById.get(id))]));

  // Packs degrade by staleness. The world pack has no special priority —
  // it degrades like any other pack, down to its floor (never above its
  // density cap, so a 2048px single-variant world pack still gets capped).
  const byOldestUse = (a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0);
  const degradeOrder = [...ids].sort(byOldestUse);
  const scaleFloor = id => (id === worldConfigId ? Math.min(startById.get(id) ?? 1, WORLD_MIN_SCALE) : 0);

  /** Round-robin degradation at a fixed width until the layout fits. */
  const planAtWidth = width => {
    const assign = new Map();
    for (const id of ids) {
      assign.set(id, startById.get(id) ?? 1);
    }
    let needed = simulateHeight(width, ids, id => assign.get(id), rectsById);
    let guard = degradeOrder.length * SCALE_STEPS.length + 2;
    while (needed > maxSide && guard-- > 0) {
      // Degrade round-robin: each pass steps every eligible pack down one
      // rung, so quality stays even across rings instead of sinking single
      // packs to the bottom. Priority only decides who yields first.
      let progressed = false;
      for (const id of degradeOrder) {
        const next = nextStepBelow(assign.get(id));
        if (next === null || next < scaleFloor(id) - 1e-9) continue;
        assign.set(id, next);
        progressed = true;
        needed = simulateHeight(width, ids, innerId => assign.get(innerId), rectsById);
        if (needed <= maxSide) break;
      }
      if (!progressed) break; // everyone is at their floor / bottom rung
    }
    return { width, assign, needed, minScale: Math.min(...assign.values(), 1) };
  };

  // Evaluate candidate widths: a layout that fits beats one that doesn't,
  // then the one preserving quality best; the narrower atlas wins ties
  // (less VRAM). Scaling changes are reported once per pack for the winning plan.
  const candidates = [...new Set([Math.min(2048, maxSide), maxSide])].map(planAtWidth);
  const fits = c => c.needed <= maxSide;
  const best = candidates.reduce((a, b) => {
    if (fits(a) !== fits(b)) return fits(b) ? b : a;
    return b.minScale > a.minScale + 1e-9 ? b : a;
  });
  for (const [id, to] of best.assign) {
    const start = startById.get(id) ?? 1;
    const prev = reportedScales.get(id) ?? start;
    reportScaleChange(id, start, prev, to);
  }
  const needTop = !!topLayerClasses && ids.some(id => hasOverlayRects(rectsById.get(id) ?? []));
  return { assign: best.assign, width: best.width, needed: best.needed, order: ids, needTop, rectsById, startById };
}

/** Log scale changes once per actual change; report restorations back to start. */
function reportScaleChange(cfgId, start, from, to) {
  if (to >= start - 1e-9) {
    if (reportedScales.has(cfgId)) {
      console.log(`${MODULE_ID} | bake budget: "${cfgId}" restored to ${(100 * to).toFixed(0)}%`);
      reportedScales.delete(cfgId);
    }
    return;
  }
  if (Math.abs((reportedScales.get(cfgId) ?? -1) - to) <= 1e-9) return;
  reportedScales.set(cfgId, to);
  console.warn(`${MODULE_ID} | bake budget: "${cfgId}" degraded ${(100 * from).toFixed(0)}% -> ${(100 * to).toFixed(0)}% to fit the atlas`);
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx || c.width !== w || c.height !== h) throw new Error(`cannot create a ${w}x${h} canvas`);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas: c, ctx };
}

function atlasTextureOptions() {
  const mipmap = canvas?.performance?.mipmap === "ON" ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF;
  return { mipmap };
}

/**
 * Plan a new atlas generation and create its (empty) canvases. Live
 * renderer state is untouched: the generation is installed by commitAtlas()
 * once rebuildAtlas() has baked it — except for the very first generation,
 * which has nothing to replace.
 * Must be followed synchronously by rebuildAtlas() (see rebuildWithNewPlan).
 */
function createAtlas() {
  const maxSide = atlasMaxSide();
  const plan = planScales(maxSide);
  const width = plan.width;
  const needed = Number.isFinite(plan.needed) ? Math.max(1, Math.ceil(plan.needed)) : maxSide;
  const headroom = Math.min(ATLAS_HEADROOM_MAX,
    Math.max(ATLAS_HEADROOM_MIN, Math.ceil(needed * ATLAS_HEADROOM_RATIO)));
  const height = Math.min(maxSide, needed + headroom);

  // Create everything first: a failure must not leave half-swapped state
  const main = newCanvas(width, height);
  let top = null;
  if (plan.needTop) {
    try { top = newCanvas(width, height); } catch (e) {
      console.warn(`${MODULE_ID} | shadow atlas unavailable — overlays skipped`, e);
    }
  }

  // Retire the previous generation: it stays fully renderable while the new
  // atlas bakes, and commitAtlas() destroys it after tokens have redrawn
  if (retiredAtlas) {
    try { retiredAtlas.baseTexture?.destroy(); } catch { /* noop */ }
    try { retiredAtlas.top?.destroy(); } catch { /* noop */ }
  }
  const firstGeneration = !atlasBaseTexture;
  retiredAtlas = firstGeneration ? null : {
    canvas: atlasCanvas,
    ctx: atlasCtx,
    baseTexture: atlasBaseTexture,
    sheet: atlasSheet,
    topCanvas: topAtlasCanvas,
    topCtx: topAtlasCtx,
    top: topAtlasBaseTexture,
    pack: { ...pack },
    scaleAssignments: new Map(scaleAssignments),
    appliedScaleCaps: new Map(appliedScaleCaps),
    plannedOrder: [...plannedOrder],
    plannedRects: new Map(plannedRects),
    currentPlanNeedTop
  };

  scaleAssignments.clear();
  for (const [id, s] of plan.assign) scaleAssignments.set(id, s);
  appliedScaleCaps.clear();
  for (const [id, s] of plan.startById) appliedScaleCaps.set(id, s);
  plannedOrder = plan.order;
  plannedRects = plan.rectsById;
  atlasW = width;
  atlasH = height;
  const scales = [...scaleAssignments].map(([id, s]) => `${id} ${(100 * s).toFixed(0)}%`).join(", ");
  console.log(`${MODULE_ID} | bake budget (auto), atlas ${atlasW}x${atlasH}${top ? " (+overlay atlas)" : ""}, ` +
    `size limit ${maxSide}; scales: ${scales}`);

  atlasCanvas = main.canvas;
  atlasCtx = main.ctx;
  atlasBaseTexture = PIXI.BaseTexture.from(atlasCanvas, atlasTextureOptions());
  atlasSheet = new PIXI.Spritesheet(atlasBaseTexture, {
    frames: {},
    meta: { scale: "1" }
  });
  topAtlasCanvas = top?.canvas ?? null;
  topAtlasCtx = top?.ctx ?? null;
  topAtlasBaseTexture = top ? PIXI.BaseTexture.from(topAtlasCanvas, atlasTextureOptions()) : null;
  currentPlanNeedTop = !!plan.needTop;
  pack.x = 0; pack.y = 0; pack.rowH = 0;

  if (firstGeneration) installGeneration();
  else pendingGenerationSwap = true;
}

/** Point the renderer-facing caches at the current generation. */
function installGeneration() {
  if (PIXI.Assets.cache.has(MEGA_SHEET_KEY)) PIXI.Assets.cache.remove(MEGA_SHEET_KEY);
  PIXI.Assets.cache.set(MEGA_SHEET_KEY, atlasSheet);
  topLayerClasses?.setTopAtlas(topAtlasBaseTexture);
  pendingGenerationSwap = false;
}

/* ------------------------------------------------------------------ */
/* Live re-plan                                                       */
/* ------------------------------------------------------------------ */

/** Resolve once no atlas rebuild is running. Callers that must act on an
 * idle atlas re-check `rebuildInProgress` synchronously after awaiting. */
async function waitForIdleAtlas() {
  while (rebuildInProgress) await rebuildPromise;
}

/**
 * Re-plan the budget and rebuild the atlas. Serialized: waits for a running
 * rebuild, then plans and starts the new one in the same tick, so no other
 * bake can slip in between createAtlas() and rebuildAtlas().
 */
async function rebuildWithNewPlan(reason) {
  if (!atlasCtx) return;
  while (rebuildInProgress) await rebuildPromise;
  try {
    createAtlas();
  } catch (e) {
    console.error(`${MODULE_ID} | cannot create a new atlas (${reason}) — keeping the current one`, e);
    return;
  }
  await rebuildAtlas(reason);
}

/** Re-plan, rebuild, retry failed packs and bake whatever tokens still miss. */
async function replanAndRefresh(reason) {
  if (!atlasCtx) return;
  // Clear previous failures BEFORE planning so the new atlas reserves room
  // for worn packs that had failed under the old budget.
  const hadFailed = [...failedSheets.keys()].filter(id => sheetSources.has(id));
  for (const id of hadFailed) failedSheets.delete(id);
  if (hadFailed.length) capacityWarned = false;
  await rebuildWithNewPlan(reason);
  if (failedSheets.size) await retryFailed({ quiet: true, allowReplan: false });
  // commitAtlas() already redrew every token; this only bakes what is still
  // missing (including packs that were cleared from failedSheets above) and
  // redraws the tokens that actually got new frames
  for (const t of ringWearers()) scheduleTokenRefresh(t);
}

/** Re-plan pack scales and rebuild the atlas without a reload. */
async function replanAndRebuild(reason) {
  if (!booted || !atlasCtx) return;
  return replanAndRefresh(reason);
}

/** True if the given frames fit the atlas' free space at the given scale. */
function packFitsAtlas(cfgId, scale, rects = bakeRects(cfgId)) {
  if (!atlasCtx) return false;
  // Overlays need the shadow atlas, which only exists when planned for. If the
  // current plan already asked for a shadow atlas (`currentPlanNeedTop`) and
  // its canvas creation failed, replanning cannot help — bake the ring without
  // overlays instead of failing the pack.
  if (topLayerClasses && !topAtlasCtx && !currentPlanNeedTop && hasOverlayRects(rects)) return false;
  const st = { ...pack };
  for (const r of mainRects(rects)) {
    const { w, h } = scaledFrameSize(r.data.frame, scale);
    const pos = shelfPlace(st, w, h, atlasW);
    if (pos.x + w > atlasW || pos.y + h > atlasH) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Baking & lazy materialization                                      */
/* ------------------------------------------------------------------ */

function frameEntry(slot, dw, dh, extra) {
  return {
    frame: { x: slot.x, y: slot.y, w: dw, h: dh },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: dw, h: dh },
    sourceSize: { w: dw, h: dh },
    ...extra
  };
}

const META_KEYS = ["ringColor", "backgroundColor", "colorBand", "gridTarget", "ringThickness"];

/** Overlay art stored in standalone files (`config.overlays[].image`):
 * loaded once per URL, kept for the session (reloaded if Foundry's idle
 * texture sweep destroyed the cached copy). */
function loadTopImage(url) {
  if (resolvedTopImages.has(url) && !textureUsable(resolvedTopImages.get(url))) {
    resolvedTopImages.delete(url);
    topImageCache.delete(url);
  }
  let job = topImageCache.get(url);
  if (!job) {
    job = (async () => {
      try {
        const tex = await foundry.canvas.loadTexture(url);
        if (!textureUsable(tex)) throw new Error("invalid texture");
        try { foundry.canvas.TextureLoader?.pinSource?.(url); } catch { /* noop */ }
        resolvedTopImages.set(url, tex);
        return tex;
      } catch (e) {
        console.warn(`${MODULE_ID} | top-layer image "${url}" failed to load — overlay skipped`, e);
        topImageCache.delete(url); // allow a later retry
        return null;
      }
    })();
    topImageCache.set(url, job);
  }
  return job;
}

/** Preload every override image a pack's overlays reference. */
async function ensureTopImages(cfgId) {
  const src = sheetSources.get(cfgId);
  if (!src) return;
  await Promise.all(src.rects
    .filter(r => r.isTop && r.imageOverride)
    .map(r => loadTopImage(r.imageOverride)));
}

/** Resolved texture for an override image, or null while loading / on failure. */
function topImageTexture(url) {
  const tex = resolvedTopImages.get(url);
  return textureUsable(tex) ? tex : null;
}

/**
 * Source image of a pack. Reloads it when Foundry's texture cache expired
 * (destroyed) the copy the module held.
 */
async function loadSourceTexture(cfgId) {
  const held = materialized.get(cfgId) ?? stagedTextures.get(cfgId);
  if (textureUsable(held)) return held;
  const src = sheetSources.get(cfgId);
  if (!src) throw new Error(`pack "${cfgId}" is not indexed`);
  src.imgPath ??= resolveSheetURL(src.metaImage, src.sheetSrc);
  const tex = await foundry.canvas.loadTexture(src.imgPath);
  if (!textureUsable(tex)) throw new Error(`image load failed: ${src.imgPath}`);
  // The world default pack is never evicted, so pin its source image against
  // Foundry's idle texture cache sweep to avoid redundant re-fetches on rebuilds
  if (cfgId === worldConfigId) {
    try { foundry.canvas.TextureLoader?.pinSource?.(src.imgPath); } catch { /* noop */ }
  }
  if (materialized.has(cfgId)) materialized.set(cfgId, tex);
  if (stagedTextures.has(cfgId)) stagedTextures.set(cfgId, tex);
  return tex;
}

/** Free a pack's source image once no other baked or pending pack shares it. */
function releaseSourceTexture(cfgId) {
  const path = sheetSources.get(cfgId)?.imgPath;
  if (!path) return;
  for (const id of [...materialized.keys(), ...pendingSheets.keys(), ...stagedTextures.keys()]) {
    if (id !== cfgId && sheetSources.get(id)?.imgPath === path) return;
  }
  try {
    const bust = foundry.utils.getCacheBustURL?.(path);
    const key = PIXI.Assets.cache.has(path) ? path : (bust && PIXI.Assets.cache.has(bust) ? bust : null);
    if (key) Promise.resolve(PIXI.Assets.unload(key)).catch(() => {});
  } catch { /* noop */ }
}

/**
 * Draw a pack's given frames into the atlas and register their textures.
 * The pack bakes atomically: every slot is planned first, and when one does
 * not fit nothing is drawn or registered. append=true adds slots to the
 * pack's existing ones (variant top-up) instead of replacing them; with no
 * rects this is a successful no-op (a pack nobody currently wears bakes
 * nothing).
 */
function bakeSheetPixels(cfgId, tex, rects, { append = false, defer = false } = {}) {
  const src = sheetSources.get(cfgId);
  if (!src || !atlasCtx || !textureUsable(tex)) return false;
  const scale = packScale(cfgId);

  // Plan every main-atlas slot first
  const st = { ...pack };
  const planned = [];
  for (const r of mainRects(rects)) {
    const { w, h } = scaledFrameSize(r.data.frame, scale);
    const pos = shelfPlace(st, w, h, atlasW);
    if (pos.x + w > atlasW || pos.y + h > atlasH) {
      warnCapacityOnce();
      return false;
    }
    planned.push({ r, x: pos.x, y: pos.y, w, h });
  }
  Object.assign(pack, st);

  const source = tex.baseTexture.resource.source;
  const slots = [];
  for (const { r, x, y, w: dw, h: dh } of planned) {
    const fr = r.data.frame;
    atlasCtx.drawImage(source, fr.x, fr.y, fr.w, fr.h, x, y, dw, dh);
    const extra = Object.fromEntries(Object.entries(r.data).filter(([k]) => META_KEYS.includes(k)));
    atlasSheet.data.frames[r.key] = frameEntry({ x, y }, dw, dh, extra);
    const frameTex = new PIXI.Texture(atlasBaseTexture, new PIXI.Rectangle(x, y, dw, dh));
    if (defer) {
      // Mid-rebuild: keep the previous generation's cache entries alive so
      // live draws keep rendering the old rings; commitAtlas() swaps them
      deferredFrameTextures.set(r.key, frameTex);
    } else {
      // PIXI v7: Assets.cache has no `delete` (only `remove`), and `remove`
      // clears just the Assets-level maps — Texture/BaseTexture also keep
      // global id entries that `set` would warn over on every re-bake. Clear
      // all three layers first; each call is a no-op when the id is absent.
      if (PIXI.Assets.cache.has(r.key)) PIXI.Assets.cache.remove(r.key);
      PIXI.Texture.removeFromCache(r.key);
      PIXI.BaseTexture.removeFromCache(r.key);
      PIXI.Assets.cache.set(r.key, frameTex);
    }
    slots.push({ key: r.key, x, y, w: dw, h: dh });
  }

  if (defer) pendingSlots.set(cfgId, append ? [...(pendingSlots.get(cfgId) ?? []), ...slots] : slots);
  else sheetSlots.set(cfgId, append ? [...(sheetSlots.get(cfgId) ?? []), ...slots] : slots);

  // Top-layer frames go to the shadow atlas only, at the SAME rect as their
  // ring frame — the shader samples it with the ring's own UVs, so the base
  // frame's slot must already be known (hence after the main loop). Scaled
  // to the base slot's on-atlas size; overlay and ring art share the same
  // authored frame size.
  if (topAtlasCtx) {
    const allSlots = defer ? (pendingSlots.get(cfgId) ?? slots) : (sheetSlots.get(cfgId) ?? slots);
    for (const r of rects) {
      if (!r.isTop) continue;
      const slot = slots.find(s => s.key === r.variant) ?? allSlots.find(s => s.key === r.variant);
      if (!slot) continue;
      const overlayTex = r.imageOverride ? topImageTexture(r.imageOverride) : null;
      // No fallback to the sheet texture here: with an override missing
      // (still loading / failed), the ring frame's rect would sample wrong
      // pixels — render no overlay instead.
      if (r.imageOverride && !overlayTex) continue;
      const rectSource = (overlayTex ?? tex).baseTexture.resource.source;
      const fr = r.data.frame;
      topAtlasCtx.drawImage(rectSource, fr.x, fr.y, fr.w, fr.h, slot.x, slot.y, slot.w, slot.h);
    }
  }
  return true;
}

/**
 * Swap the freshly baked atlas generation into the renderer in one
 * synchronous tick: sheet + shadow atlas, per-frame cache entries, slot
 * bookkeeping, UV tables and token redraws all switch together. Until this
 * runs, every token draw — including ones triggered mid-rebuild — resolves
 * against the previous generation and keeps showing its old (or fallback)
 * ring instead of rendering nothing.
 */
function commitAtlas() {
  if (pendingGenerationSwap) installGeneration();
  for (const [key, tex] of deferredFrameTextures) {
    if (PIXI.Assets.cache.has(key)) PIXI.Assets.cache.remove(key);
    PIXI.Texture.removeFromCache(key);
    PIXI.BaseTexture.removeFromCache(key);
    PIXI.Assets.cache.set(key, tex);
  }
  deferredFrameTextures.clear();
  // Frames that didn't make it into the new generation (evicted packs,
  // size variants no token resolves to) — drop their stale cache entries
  for (const keys of sheetFrameIds.values()) {
    for (const key of keys) {
      if (atlasSheet.data.frames[key]) continue;
      if (PIXI.Assets.cache.has(key)) PIXI.Assets.cache.remove(key);
      PIXI.Texture.removeFromCache(key);
      PIXI.BaseTexture.removeFromCache(key);
    }
  }
  sheetSlots.clear();
  for (const [cfgId, slots] of pendingSlots) sheetSlots.set(cfgId, slots);
  pendingSlots.clear();
  atlasBaseTexture.update();
  topAtlasBaseTexture?.update();
  // Only when the UV tables actually rebuilt do meshes stop referencing the
  // previous atlas; otherwise it must stay alive (core still samples it).
  // Before activation core never saw the atlas, so it is free either way.
  const uvRebuilt = booted ? refreshUVs() : false;
  // New atlas generation: every existing ring mesh must redraw or it keeps
  // sampling the new texture with UVs from the old one
  refreshAllRingTokens();
  const old = retiredAtlas;
  retiredAtlas = null;
  // Tokens pick up the new generation on the next frame or two; only then is
  // the previous atlas truly unreferenced and safe to free from the GPU
  if (old && (uvRebuilt || !booted)) {
    setTimeout(() => {
      try { old.baseTexture?.destroy(); } catch { /* noop */ }
      try { old.top?.destroy(); } catch { /* noop */ }
    }, 2000);
  }
}

/**
 * Wait until no rebuild runs and the pack's frames fit, re-planning the atlas
 * when allowed, then run `bake(rects)` in the same synchronous tick as the
 * final fit check — nothing can swap the atlas in between.
 * @returns {Promise<boolean|"deferred">} bake()'s result, "deferred" when no
 *   frames are needed (anymore), false when the pack does not fit
 */
async function bakeWhenRoom(cfgId, getRects, bake, { allowReplan = true, reason = "" } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    while (rebuildInProgress) await rebuildPromise;
    // ---- synchronous from here until the next await ----
    const rects = getRects();
    if (!rects.length) return "deferred";
    if (packFitsAtlas(cfgId, packScale(cfgId), rects)) return bake(rects);
    if (!allowReplan) break;
    await rebuildWithNewPlan(reason || `make room for "${cfgId}"`);
  }
  warnCapacityOnce();
  return false;
}

async function materializeSheet(cfgId, { allowReplan = true } = {}) {
  if (materialized.has(cfgId)) return true;
  if (isFailed(cfgId)) return false;
  if (pendingSheets.has(cfgId)) return pendingSheets.get(cfgId);

  const job = (async () => {
    const src = sheetSources.get(cfgId);
    if (!src || !atlasCtx) {
      console.warn(`${MODULE_ID} | cannot bake "${cfgId}": ${!src ? "pack is not indexed (its sheet failed to load at startup)" : "atlas is not created yet"}`);
      markFailed(cfgId);
      return false;
    }
    try {
      // Usage-based budget: only the size variants placed tokens (and open
      // token-config previews) actually use are planned and baked. A pack
      // nobody wears bakes nothing — and must NOT be marked materialized:
      // an "empty baked" pack would make every draw re-request it, each
      // request "succeeding" and triggering another redraw — an endless
      // chain that keeps the token hidden until its pack is truly baked.
      // Returns the string "deferred" here (not true) so callers can tell
      // "nothing baked yet" apart from success and skip their redraws.
      if (!bakeRects(cfgId).length) {
        if (!warnedNoWearers.has(cfgId)) {
          warnedNoWearers.add(cfgId);
          console.log(`${MODULE_ID} | "${cfgId}" has no wearers yet — bake deferred until a token (or open preview) wears it`);
        }
        return "deferred";
      }

      const tex = await loadSourceTexture(cfgId);
      await ensureTopImages(cfgId);
      stagedTextures.set(cfgId, tex);
      // If the newly worn pack doesn't fit the current atlas, degrade
      // everyone just enough to make room for it (the plan includes packs
      // that are pending, like this one, and rebuildAtlas bakes staged packs
      // directly in plannedOrder so concurrent wakeups cannot fragment rows)
      const result = await bakeWhenRoom(cfgId,
        () => (materialized.has(cfgId) ? missingRects(cfgId) : bakeRects(cfgId)),
        rects => {
          const appending = materialized.has(cfgId);
          if (!bakeSheetPixels(cfgId, tex, rects, { append: appending })) return false;
          materialized.set(cfgId, tex);
          stagedTextures.delete(cfgId);
          if (!appliedScaleCaps.has(cfgId)) appliedScaleCaps.set(cfgId, packScaleCap(cfgId));
          return true;
        },
        { allowReplan, reason: `make room for "${cfgId}"` });
      if (result === "deferred") {
        if (materialized.has(cfgId) && !missingRects(cfgId).length) {
          stagedTextures.delete(cfgId);
          pendingSheets.delete(cfgId);
          warnedNoWearers.delete(cfgId);
          if (booted && cfgId !== worldConfigId && !packHasWearers(cfgId)) {
            scheduleEviction("wearer left during bake");
          }
          console.log(`${MODULE_ID} | baked ring sheet "${cfgId}" (${sheetSlots.get(cfgId)?.length ?? 0} frames)`);
          return true;
        }
        stagedTextures.delete(cfgId);
        pendingSheets.delete(cfgId);
        releaseSourceTexture(cfgId);
        return "deferred";
      }
      if (result !== true) {
        stagedTextures.delete(cfgId);
        pendingSheets.delete(cfgId);
        releaseSourceTexture(cfgId);
        markFailed(cfgId);
        return false;
      }

      stagedTextures.delete(cfgId);
      pendingSheets.delete(cfgId);
      lastUsed.set(cfgId, Date.now());
      atlasBaseTexture.update();
      topAtlasBaseTexture?.update();
      if (booted) {
        refreshUVs();
        // Frames just landed: every placed wearer that drew against the
        // world default while this bake was in flight must redraw onto them
        refreshPackWearers(cfgId);
        if (cfgId !== worldConfigId && !packHasWearers(cfgId)) {
          scheduleEviction("wearer left during bake");
        }
      }
      warnedNoWearers.delete(cfgId);
      console.log(`${MODULE_ID} | baked ring sheet "${cfgId}" (${sheetSlots.get(cfgId)?.length ?? 0} frames)`);
      return true;
    } catch (e) {
      console.warn(`${MODULE_ID} | failed to bake ring sheet "${cfgId}"`, e);
      stagedTextures.delete(cfgId);
      pendingSheets.delete(cfgId);
      releaseSourceTexture(cfgId);
      markFailed(cfgId);
      return false;
    } finally {
      stagedTextures.delete(cfgId);
      pendingSheets.delete(cfgId);
    }
  })();

  pendingSheets.set(cfgId, job);
  return job;
}

/** Make sure this token's pack AND its size variant are baked. */
function ensureForToken(token) {
  if (!ringShown(token)) return Promise.resolve("noop");
  const cfgId = effectivePackOf(token);
  if (!cfgId || !sheetSources.has(cfgId)) return Promise.resolve("noop");
  return ensureVariantsFor(cfgId);
}

/** Frames of a pack's needed variants that are not baked yet. */
function missingRects(cfgId) {
  const have = bakedVariantsOf(cfgId);
  return bakeRects(cfgId).filter(r => !have.has(r.variant));
}

/**
 * Bake size variants a pack's placed tokens need but the atlas lacks yet
 * (token placed, or grew into a different size). Appends in free atlas space
 * when possible, otherwise re-plans the whole budget.
 * @returns {Promise<true|false|"deferred"|"noop">} "noop": nothing was missing
 */
async function ensureVariantsFor(cfgId) {
  if (!booted || !atlasCtx || !sheetSources.has(cfgId)) {
    console.warn(`${MODULE_ID} | cannot prepare "${cfgId}": ${!booted ? "module is not booted" : !atlasCtx ? "atlas is not created yet" : "pack is not indexed"}`);
    return false;
  }
  if (!materialized.has(cfgId)) return materializeSheet(cfgId);
  if (variantJobs.has(cfgId)) return variantJobs.get(cfgId);
  // Fast path when idle and nothing changed for this pack
  if (!rebuildInProgress
    && packScaleCap(cfgId) <= (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6
    && !missingRects(cfgId).length) {
    return "noop";
  }
  const job = (async () => {
    let bakedAny = false;
    for (let pass = 0; pass < 3; pass++) {
      await waitForIdleAtlas();
      if (!materialized.has(cfgId)) {
        variantJobs.delete(cfgId);
        return materializeSheet(cfgId); // evicted meanwhile
      }
      // A larger token arrived: the pack's density cap rose above what the
      // current atlas was planned with — re-plan so its frames re-bake higher.
      // Compared against the cap recorded at plan time (not the assigned
      // scale) so budget degradation below the cap can't loop the rebuild.
      const capNow = packScaleCap(cfgId);
      if (capNow > (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6) {
        await rebuildWithNewPlan(`higher resolution needed for "${cfgId}"`);
        bakedAny = true;
        if (!materialized.has(cfgId)) continue;
        if (packScaleCap(cfgId) <= (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6
          && !missingRects(cfgId).length) {
          return true;
        }
        continue;
      }
      if (!missingRects(cfgId).length) return bakedAny ? true : "noop";
      const tex = await loadSourceTexture(cfgId);
      await ensureTopImages(cfgId);
      const result = await bakeWhenRoom(cfgId,
        () => (materialized.has(cfgId) ? missingRects(cfgId) : []),
        rects => bakeSheetPixels(cfgId, tex, rects, { append: true }),
        { reason: `make room for new ring size on "${cfgId}"` });
      if (result === "deferred") {
        // A re-plan baked the variant as part of the rebuild, or it is no
        // longer needed — check if newer demand arrived meanwhile
        if (!materialized.has(cfgId)) continue;
        if (packScaleCap(cfgId) > (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6
          || missingRects(cfgId).length > 0) {
          continue;
        }
        return !missingRects(cfgId).length ? true : "deferred";
      }
      if (result !== true) return false;
      bakedAny = true;
      atlasBaseTexture.update();
      topAtlasBaseTexture?.update();
      refreshUVs();
      refreshPackWearers(cfgId);
      console.log(`${MODULE_ID} | baked new ring frame(s) for "${cfgId}"`);
      if (packScaleCap(cfgId) <= (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6
        && !missingRects(cfgId).length) {
        return true;
      }
    }
    return !missingRects(cfgId).length;
  })().catch(e => {
    console.warn(`${MODULE_ID} | failed to bake new ring size for "${cfgId}"`, e);
    return false;
  }).finally(() => variantJobs.delete(cfgId));
  variantJobs.set(cfgId, job);
  return job;
}

/**
 * Bake what a token needs, then redraw it.
 * Without `force` the redraw only happens when frames actually landed
 * (true): "deferred" = nothing was baked (no wearer recorded a need) —
 * redrawing would re-request the same nothing and loop; "noop" = everything
 * was already there. With `force` (the token's ring choice itself changed)
 * it always redraws once, so even a failed/unknown pack swaps to the
 * fallback ring instead of keeping the old one.
 */
function scheduleTokenRefresh(t, { force = false } = {}) {
  if (t && force) lastPackOf.set(t, effectivePackOf(t));
  Promise.resolve(ensureForToken(t)).then(ok => {
    if (ok === true || force) redrawToken(t);
  }).catch(() => { if (force) redrawToken(t); });
}

function refreshUVs() {
  try {
    // Core's createAssetsUVs throws on a frameless sheet — after having
    // already cleared its static UV table and ring data, which would break
    // every subsequent ring draw. Never feed it an empty atlas.
    if (!Object.keys(atlasSheet?.data.frames ?? {}).length) return false;
    foundry.canvas.placeables.tokens.TokenRing.createAssetsUVs();
    return true;
  } catch (e) {
    console.warn(`${MODULE_ID} | createAssetsUVs failed`, e);
    return false;
  }
}

/**
 * Redraw every placed ring token. Token meshes capture UVs and the atlas
 * baseTexture at draw time; an atlas rebuild replaces both, so meshes drawn
 * against the previous generation sample the new texture with stale UVs and
 * render broken rings until redrawn.
 */
function refreshAllRingTokens() {
  for (const t of canvas.tokens?.placeables ?? []) redrawToken(t);
  // TokenConfig live-preview clones draw on top of the real token but are
  // not in the layer's placeables — left stale, they would keep sampling the
  // retired atlas (destroyed shortly after commit) and render as nothing
  for (const clone of canvas.tokens?._configPreview?.children ?? []) redrawToken(clone);
}

/**
 * Redraw only the placed tokens (and open preview clones) wearing a given
 * pack. Called when that pack's frames land in the atlas: every wearer may
 * have drawn against the world default while the bake was in flight, and a
 * token that drew mid-bake gets no redraw on its own — the chain attached at
 * draw time only covers the token whose draw happened to kick the bake off.
 */
function refreshPackWearers(cfgId) {
  for (const t of ringWearers()) {
    if (effectivePackOf(t) === cfgId) redrawToken(t);
  }
}

/** Redraw every config preview clone (their pack choice changed in the form). */
function refreshConfigPreviews() {
  for (const clone of canvas.tokens?._configPreview?.children ?? []) {
    if (clone?._previewType === "config") redrawToken(clone);
  }
}

/* ------------------------------------------------------------------ */
/* Eviction of unplaced packs                                         */
/* ------------------------------------------------------------------ */

/** Number of placed tokens wearing a given pack (visible rings only). */
function tokensWearingCount(cfgId) {
  let n = 0;
  for (const t of canvas.tokens?.placeables ?? []) {
    if (ringShown(t) && effectivePackOf(t) === cfgId) n++;
  }
  return n;
}

function unloadSheet(cfgId) {
  for (const key of sheetFrameIds.get(cfgId) ?? []) {
    if (atlasSheet) delete atlasSheet.data.frames[key];
    deferredFrameTextures.delete(key);
    // Mid-rebuild the old cache entries still back live draws — commitAtlas
    // sweeps them at the swap instead of yanking textures mid-render
    if (!rebuildInProgress) {
      if (PIXI.Assets.cache.has(key)) PIXI.Assets.cache.remove(key);
      PIXI.Texture.removeFromCache(key);
      PIXI.BaseTexture.removeFromCache(key);
    }
  }
  sheetSlots.delete(cfgId);
  pendingSlots.delete(cfgId);
  materialized.delete(cfgId);
  stagedTextures.delete(cfgId);
  appliedScaleCaps.delete(cfgId);
  reportedScales.delete(cfgId);
  lastUsed.delete(cfgId);
  releaseSourceTexture(cfgId);
}

/** Restore the previous atlas generation if a rebuild aborts before commit. */
function rollbackUncommittedAtlas() {
  pendingSlots.clear();
  deferredFrameTextures.clear();
  if (!pendingGenerationSwap || !retiredAtlas) {
    pendingGenerationSwap = false;
    return;
  }
  const unusedBase = atlasBaseTexture;
  const unusedTop = topAtlasBaseTexture;
  atlasCanvas = retiredAtlas.canvas;
  atlasCtx = retiredAtlas.ctx;
  atlasBaseTexture = retiredAtlas.baseTexture;
  atlasSheet = retiredAtlas.sheet;
  topAtlasCanvas = retiredAtlas.topCanvas;
  topAtlasCtx = retiredAtlas.topCtx;
  topAtlasBaseTexture = retiredAtlas.top;
  atlasW = atlasCanvas?.width ?? atlasW;
  atlasH = atlasCanvas?.height ?? atlasH;
  Object.assign(pack, retiredAtlas.pack);
  scaleAssignments.clear();
  for (const [k, v] of retiredAtlas.scaleAssignments) scaleAssignments.set(k, v);
  appliedScaleCaps.clear();
  for (const [k, v] of retiredAtlas.appliedScaleCaps) appliedScaleCaps.set(k, v);
  plannedOrder = retiredAtlas.plannedOrder;
  plannedRects = retiredAtlas.plannedRects;
  currentPlanNeedTop = retiredAtlas.currentPlanNeedTop;
  retiredAtlas = null;
  pendingGenerationSwap = false;
  try { unusedBase?.destroy(); } catch { /* noop */ }
  try { unusedTop?.destroy(); } catch { /* noop */ }
}

/** Re-blit all surviving packs onto the freshly created atlas generation. */
async function rebuildAtlas(reason) {
  if (!atlasCtx || rebuildInProgress) return;
  rebuildInProgress = true;
  const job = (async () => {
    try {
      atlasSheet.data.frames = {};
      pendingSlots.clear();
      deferredFrameTextures.clear();
      const newlyBaked = new Map();

      // Same order the plan was simulated with (world first, then MRU, then
      // staged pending packs whose textures already finished loading)
      const isReadyPack = id => materialized.has(id) || stagedTextures.has(id);
      const order = plannedOrder.filter(isReadyPack);
      for (const id of [...materialized.keys(), ...stagedTextures.keys()]) {
        if (!order.includes(id)) order.push(id);
      }

      for (const cfgId of order) {
        const wasMaterialized = materialized.has(cfgId);
        if (!wasMaterialized && !stagedTextures.has(cfgId)) continue;
        if (!sheetSources.has(cfgId)) {
          if (wasMaterialized) unloadSheet(cfgId);
          else stagedTextures.delete(cfgId);
          continue;
        }
        let tex;
        try {
          tex = await loadSourceTexture(cfgId);
        } catch (e) {
          console.warn(`${MODULE_ID} | rebuild: cannot reload "${cfgId}", dropping`, e);
          if (cfgId !== worldConfigId) {
            markFailed(cfgId);
            if (wasMaterialized) unloadSheet(cfgId);
            else stagedTextures.delete(cfgId);
          }
          continue;
        }
        await ensureTopImages(cfgId);
        if (!materialized.has(cfgId) && !stagedTextures.has(cfgId)) continue;
        const liveRects = bakeRects(cfgId);
        // A non-world pack whose last wearer disappeared while the rebuild was
        // loading textures has nothing left to bake — evict it instead of
        // keeping a zero-slot entry in `materialized`.
        if (!liveRects.length && cfgId !== worldConfigId) {
          if (materialized.has(cfgId)) unloadSheet(cfgId);
          else stagedTextures.delete(cfgId);
          continue;
        }
        // Bake at most the variants createAtlas() planned for (filtering out
        // variants no longer needed), so a larger token placed mid-rebuild
        // cannot overflow the planned canvas; any newly arrived variants are
        // topped up after commitAtlas().
        const planned = plannedRects.get(cfgId);
        let rects = liveRects;
        if (planned?.length) {
          const liveVariants = new Set(liveRects.map(r => r.variant));
          const intersection = planned.filter(r => liveVariants.has(r.variant));
          rects = intersection.length ? intersection : (wasMaterialized ? planned : []);
        }
        if (!rects.length) continue;
        if (!bakeSheetPixels(cfgId, tex, rects, { defer: true })) {
          if (cfgId !== worldConfigId) {
            markFailed(cfgId);
            if (materialized.has(cfgId)) unloadSheet(cfgId);
            else stagedTextures.delete(cfgId);
          }
          continue;
        }
        if (!materialized.has(cfgId)) newlyBaked.set(cfgId, tex);
      }

      if (!Object.keys(atlasSheet.data.frames).length) {
        console.warn(`${MODULE_ID} | rebuild produced no frames (${reason}) — keeping previous atlas cache`);
        rollbackUncommittedAtlas();
        return;
      }

      for (const [cfgId, tex] of newlyBaked) {
        materialized.set(cfgId, tex);
        stagedTextures.delete(cfgId);
        lastUsed.set(cfgId, Date.now());
        warnedNoWearers.delete(cfgId);
        if (!appliedScaleCaps.has(cfgId)) appliedScaleCaps.set(cfgId, packScaleCap(cfgId));
      }
      commitAtlas();
      console.log(`${MODULE_ID} | atlas rebuilt (${reason}); ${materialized.size} pack(s) baked`);
    } catch (e) {
      console.error(`${MODULE_ID} | atlas rebuild failed (${reason})`, e);
      rollbackUncommittedAtlas();
    }
  })();
  rebuildPromise = job;
  try {
    await job;
  } finally {
    rebuildInProgress = false;
  }
}

/**
 * Unload every pack that no placed token (or open preview) wears anymore,
 * then compact the atlas. Event-driven (scene changes, token/effect
 * updates) instead of a slow sweep, so a freed pack releases its memory
 * right away.
 */
async function evictUnplaced(reason = "manual") {
  if (!booted) return;
  await waitForIdleAtlas();
  if (rebuildInProgress) return scheduleEviction(reason);
  const victims = [...materialized.keys()].filter(id =>
    id !== worldConfigId
    && !pendingSheets.has(id)  // don't yank packs that are mid-bake
    && !variantJobs.has(id)
    && !packHasWearers(id));
  // Demand can also shrink without a pack leaving: a token got smaller (or a
  // larger wearer left while a smaller one still wears the pack), so its
  // needed size variants or density cap dropped below what was baked
  const overshot = [...materialized.keys()].filter(id =>
    !victims.includes(id)
    && !pendingSheets.has(id)
    && !variantJobs.has(id)
    && ((appliedScaleCaps.has(id) && appliedScaleCaps.get(id) > packScaleCap(id) + 1e-6)
      || hasUnusedVariants(id)));
  if (!victims.length && !overshot.length) return;
  for (const v of victims) unloadSheet(v);
  // Re-plan instead of plain rebuild: freed budget steps remaining packs
  // back up toward their start quality and shrinks the atlas
  const reasonParts = [];
  if (victims.length) reasonParts.push(`evicted ${victims.join(", ")}`);
  if (overshot.length) reasonParts.push(`demand shrank for ${overshot.join(", ")}`);
  await replanAndRefresh(`${reasonParts.join("; ")} (${reason})`);
  // A pack finishing its bake while we ran would have been missed — re-check
  if ([...materialized.keys()].some(id => id !== worldConfigId && !packHasWearers(id))) {
    scheduleEviction("post-eviction recheck");
  }
}

/** Debounced eviction so token bursts collapse into one rebuild. */
function scheduleEviction(reason) {
  if (!booted) return;
  clearTimeout(evictDebounce);
  evictDebounce = setTimeout(() => {
    evictDebounce = null;
    evictUnplaced(reason).catch(e => console.warn(`${MODULE_ID} | eviction failed`, e));
  }, EVICT_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* Console diagnostics API                                            */
/* ------------------------------------------------------------------ */

function packState(cfgId) {
  if (pendingSheets.has(cfgId)) return "pending";
  if (materialized.has(cfgId)) return "baked";
  if (failedSheets.has(cfgId)) return "failed";
  return "unloaded";
}

function packLabel(cfgId) {
  try {
    return game.i18n.localize(CONFIG.Token.ring.getConfig(cfgId)?.label ?? cfgId) || cfgId;
  } catch {
    return cfgId;
  }
}

/** Baked size variants of a pack as a compact label, e.g. "med-ring+gnt-ring". */
function variantLabel(cfgId) {
  const src = sheetSources.get(cfgId);
  const targets = new Map((src?.rects ?? []).map(r => [r.variant, r.gridTarget]));
  const baked = [...bakedVariantsOf(cfgId)]
    .sort((a, b) => (targets.get(a) ?? 0) - (targets.get(b) ?? 0))
    .map(k => k.slice(k.indexOf(":") + 1));
  return baked.join("+") || null;
}

/** Snapshot of module internals as plain data (safe to call at any time). */
function buildStatus() {
  const atlasPx = atlasW * atlasH;
  let slotPx = 0, slotCount = 0;
  for (const slots of sheetSlots.values()) {
    slotCount += slots.length;
    for (const s of slots) slotPx += s.w * s.h;
  }
  const inUse = bakeOrder(planningSet());
  const rectsById = new Map(inUse.map(id => [id, bakeRects(id)]));
  const plannedPx = atlasCtx ? simulateHeight(atlasW, inUse, id => packScale(id), rectsById) : 0;
  const fullQualityPx = atlasCtx ? simulateHeight(atlasW, inUse, id => packStartScale(id), rectsById) : 0;

  const packList = [...sheetFrameIds.keys()].map(cfgId => {
    const tex = materialized.get(cfgId);
    const scale = packScale(cfgId);
    return {
      id: cfgId,
      label: packLabel(cfgId),
      state: packState(cfgId),
      scale: +scale.toFixed(2),
      startScale: +packStartScale(cfgId).toFixed(2),
      planned: scaleAssignments.has(cfgId),
      frames: sheetFrameIds.get(cfgId)?.size ?? 0,
      topFrames: [...(sheetFrameIds.get(cfgId) ?? [])].filter(k => k.endsWith("-top")).length,
      bakedSlots: sheetSlots.get(cfgId)?.length ?? 0,
      variants: variantLabel(cfgId),
      variantsAll: sheetSources.get(cfgId)?.variantCount ?? 0,
      cap: Math.round(100 * packScaleCap(cfgId)),
      tokens: tokensWearingCount(cfgId),
      sourceMB: textureUsable(tex) ? +((tex.width * tex.height * 4) / (1024 * 1024)).toFixed(1) : 0,
      idleSec: lastUsed.has(cfgId) ? Math.round((Date.now() - lastUsed.get(cfgId)) / 1000) : null
    };
  });
  const degradedCount = packList.filter(p => p.scale < p.startScale - 1e-9).length;

  const renderer = canvas.app?.renderer;
  return {
    booted,
    worldPack: worldConfigId,
    ringsIndexed: ringRegistry.length,
    topLayer: !!topLayerClasses,
    atlas: {
      w: atlasW,
      h: atlasH,
      overlayAtlas: !!topAtlasCtx,
      gpuMaxTextureSize: getMaxTextureSize(),
      sizeLimit: atlasMaxSide(),
      megabytes: +(atlasPx * 4 * (topAtlasCtx ? 2 : 1) / (1024 * 1024)).toFixed(1),
      slotCount,
      rowFill: atlasH ? Math.min(1, (pack.y + pack.rowH) / atlasH) : 0,
      pixelFill: atlasPx ? slotPx / atlasPx : 0,
      plannedPx,        // height of the current per-pack layout
      fullQualityPx,    // height everything would need at start quality
      fitsAllIndexed: plannedPx <= atlasH
    },
    renderer: renderer ? {
      type: renderer.constructor.name,
      resolution: renderer.resolution,
      fps: Math.round(canvas.app.ticker?.FPS ?? 0)
    } : null,
    packs: {
      indexed: sheetFrameIds.size,
      planned: packList.filter(p => p.planned).length,
      baked: materialized.size,
      failed: failedSheets.size,
      pending: pendingSheets.size,
      degraded: degradedCount
    },
    failedIds: [...failedSheets.keys()],
    packList
  };
}

function printStatus() {
  const s = buildStatus();
  const pct = x => `${(100 * x).toFixed(0)}%`;
  console.group(`%c${MODULE_ID} | status${s.booted ? "" : " (NOT BOOTED)"}`, "font-weight:bold");
  console.log(`bake budget: automatic, ${s.packs.degraded} pack(s) degraded`);
  console.log(`atlas: ${s.atlas.w}x${s.atlas.h}px${s.atlas.overlayAtlas ? " + overlay atlas" : ""} = ${s.atlas.megabytes} MB, ` +
    `GPU max texture ${s.atlas.gpuMaxTextureSize}px, size limit ${s.atlas.sizeLimit}px`);
  console.log(`atlas fill: ${pct(s.atlas.rowFill)} of rows, ${pct(s.atlas.pixelFill)} of pixels, ${s.atlas.slotCount} frame slot(s)`);
  console.log(`layout: ${s.atlas.plannedPx}px for ${s.packs.planned} in-use pack(s) vs ${s.atlas.fullQualityPx}px at full quality, ${s.atlas.h}px available — ${s.atlas.fitsAllIndexed ? "OK" : "OVERFLOW, some packs will fall back"}`);
  if (s.renderer) {
    console.log(`renderer: ${s.renderer.type}, resolution ${s.renderer.resolution}x, fps ${s.renderer.fps}`);
  }
  console.log(`packs: ${s.packs.baked}/${s.packs.indexed} baked, ${s.packs.failed} failed, ${s.packs.pending} pending` +
    (s.failedIds.length ? ` — failed: ${s.failedIds.join(", ")}` : ""));
  console.table(s.packList);
  console.groupEnd();
  return s;
}

/** Forget packs that failed to bake and try them again (no reload needed). */
async function retryFailed({ quiet = false, allowReplan = true } = {}) {
  if (!atlasCtx) {
    if (!quiet) console.warn(`${MODULE_ID} | atlas not created yet`);
    return {};
  }
  const ids = [...failedSheets.keys()].filter(id => sheetSources.has(id));
  if (!ids.length) {
    if (!quiet) console.log(`${MODULE_ID} | no failed packs to retry`);
    return {};
  }
  for (const id of ids) failedSheets.delete(id);
  capacityWarned = false;
  const results = {};
  for (const id of ids) results[id] = await materializeSheet(id, { allowReplan });
  if (!quiet) {
    console.table(Object.entries(results).map(([id, ok]) => ({ pack: id, baked: ok === true, deferred: ok === "deferred" })));
  }
  // Redraw tokens (and open preview clones) that were wearing a pack we just baked
  for (const t of ringWearers()) {
    const id = effectivePackOf(t);
    if (results[id] === true) redrawToken(t);
  }
  return results;
}

function registerApi() {
  const api = {
    status: printStatus,
    packs: () => buildStatus().packList,
    retryFailed: () => retryFailed(),
    evictNow: () => evictUnplaced("manual"),
    replan: () => replanAndRebuild("manual")
  };
  const mod = game.modules?.get(MODULE_ID);
  if (mod) mod.api = api;
  window.MultipleRings = api; // convenience alias for console use
}

Hooks.once("init", registerApi);
Hooks.once("ready", registerApi);

/* ------------------------------------------------------------------ */
/* Runtime wrappers (libWrapper with direct fallback)                 */
/* ------------------------------------------------------------------ */

/** Set up the allowed-frame context for a token being drawn. Any exception
 * here would abort the token's draw mid-way, leaving it invisible (draw()
 * hides the placeable until _draw completes), so it must never throw. */
function applyRingContext(token) {
  try {
    applyRingContextInner(token);
  } catch (e) {
    console.error(`${MODULE_ID} | applyRingContext failed`, e);
    setAllowed(null);
    moduleContext.renderPack = null;
  }
}

/** Render with the world pack's baked frames (fallback while the token's own
 * pack is unavailable). */
function useWorldFallback() {
  const worldBaked = worldConfigId ? bakedVariantsOf(worldConfigId) : null;
  if (worldBaked?.size) {
    setAllowed(worldBaked);
    moduleContext.renderPack = worldConfigId;
  } else {
    setAllowed(null);
    moduleContext.renderPack = null;
  }
}

function applyRingContextInner(token) {
  const doc = token?.document;
  const rid = getEffectiveRingId(doc);
  const now = Date.now();

  // Track usage so the budget degrades stale packs first
  if (worldConfigId) lastUsed.set(worldConfigId, now);

  const packId = rid || worldConfigId;
  if (token) lastPackOf.set(token, packId);

  if (packId && materialized.has(packId)) {
    lastUsed.set(packId, now);
    // Resolve against baked variants only, so an unbaked size can never be
    // referenced — until its frames land, the closest baked one stands in.
    const have = bakedVariantsOf(packId);
    if (have.size) {
      setAllowed(have);
      moduleContext.renderPack = packId;
    } else {
      useWorldFallback();
    }
    const want = resolveVariantKey(packId, tokenTargetRingSize(token));
    const capExceeded = packScaleCap(packId) > (appliedScaleCaps.get(packId) ?? 1) + 1e-6;
    if (booted && ((want && !have.has(want)) || capExceeded)) {
      ensureVariantsFor(packId).then(ok => {
        // Redraw only when the wanted variant or higher density cap actually
        // got baked — otherwise this draw would re-request it and loop the
        // chain forever, hiding the token the whole time
        if (ok !== true || (want && !bakedVariantsOf(packId).has(want))) return;
        redrawToken(token);
      });
    }
  } else {
    useWorldFallback();
    // Kick off lazy baking; this token redraws once the frames land. ALWAYS
    // attach — even when another wearer's bake is already pending or a
    // rebuild is running (materializeSheet waits behind both and dedupes
    // via pendingSheets). Skipping the attach here is what left tokens stuck
    // on the world default: only the token that happened to kick the bake
    // off ever redrawed when it completed.
    if (rid && booted && !isFailed(rid)) {
      if (!sheetFrameIds.has(rid) && !warnedUnknownPacks.has(rid)) {
        warnedUnknownPacks.add(rid);
        console.warn(`${MODULE_ID} | token "${token?.name ?? "?"}" requests unknown ring pack "${rid}" — using world default`);
      }
      materializeSheet(rid).then(ok => {
        // Loop guard: deferred (no need recorded yet) or failed bakes must
        // not schedule another draw that would re-request them
        if (ok !== true || !materialized.has(rid) || !bakedVariantsOf(rid).size) return;
        redrawToken(token);
      });
    }
  }
}

function featureDetect(TokenRing) {
  const proto = TokenRing?.prototype;
  if (!proto
    || typeof proto.configureSize !== "function"
    || typeof proto.configureVisuals !== "function"
    || typeof TokenRing.getRingDataBySize !== "function"
    || typeof TokenRing.getTextureUVs !== "function"
    || typeof TokenRing.createAssetsUVs !== "function") {
    featureOK = false;
    ui.notifications.warn(game.i18n.localize("MRINGS.WarnPatchFailed"));
    return false;
  }
  return true;
}

let uvMismatchWarned = false;

/**
 * Resolve ring data for a token size among the allowed frames, preferring
 * frames the renderer can actually draw. Core builds its UV table from the
 * baked atlas; a resolution whose frame is missing from that table leaves
 * the mesh without UVs — the whole token (art + ring) renders nothing until
 * a manual refresh. Filtering here means a stale or mid-bake state can only
 * ever show a neighbouring ring, never a blank token.
 * Without an allowed set the pick is confined to the world pack, so a token
 * never ends up with an arbitrary other pack's ring.
 */
function pickRingData(allowed, size) {
  if (!ringRegistry.length) return null;
  const pool = allowed ?? sheetFrameIds.get(worldConfigId) ?? null;
  const tData = foundry.canvas.placeables.tokens.TokenRing.texturesData;
  let best = null, bestDist = Infinity;       // closest drawable in pool
  let fallback = null, fallbackDist = Infinity; // closest in pool (diagnostics)
  for (const r of ringRegistry) {
    if (pool && !pool.has(r.ringName)) continue;
    const d = Math.abs(r.gridTarget - size);
    const drawable = !tData || !!tData[r.ringName];
    if (drawable && (d < bestDist || best === null)) { best = r; bestDist = d; }
    if (!drawable && d < fallbackDist) { fallback = r; fallbackDist = d; }
  }
  if (best) return { ring: best, drawable: true };
  // Nothing in `pool` has UVs yet — pick the closest drawable frame from the
  // world pack (or anywhere in the UV table) so the ring never gets undefined UVs
  const worldPool = sheetFrameIds.get(worldConfigId);
  let anyBest = null, anyDist = Infinity;
  for (const r of ringRegistry) {
    if (tData && !tData[r.ringName]) continue;
    const d = Math.abs(r.gridTarget - size) + (worldPool?.has(r.ringName) ? 0 : 100);
    if (d < anyDist) { anyDist = d; anyBest = r; }
  }
  const chosen = anyBest ?? fallback;
  if (chosen) {
    if (!uvMismatchWarned) {
      uvMismatchWarned = true;
      console.warn(`${MODULE_ID} | resolved ring frame "${(fallback ?? chosen).ringName}" is not in the renderer UV table yet — using fallback until the next redraw`);
    }
    return { ring: chosen, drawable: !!anyBest };
  }
  return null;
}

/* Ring scale: configureSize's scaleMultiplier feeds scaleCorrection, where a
 * value < 1 MAGNIFIES the ring art — and core itself adds the mesh padding
 * needed so the enlarged ring is not clipped. Pack scale 2 → multiplier ½ →
 * ring drawn twice as large; the subject texture keeps its own size.
 * The scale is taken from the pack the token actually renders with right
 * now (a fallback ring keeps its own scale while the chosen pack bakes). */
function withPackScale(options) {
  const packId = moduleContext.renderPack;
  const s = packId ? sheetScale.get(packId) : undefined;
  if (!Number.isFinite(s) || s <= 0 || s === 1) return options;
  const opts = (options && typeof options === "object") ? { ...options } : {};
  opts.scaleMultiplier = (Number.isFinite(opts.scaleMultiplier) ? opts.scaleMultiplier : 1) / s;
  return opts;
}

/* Top-layer support on ANY ring instance: core recreates ring instances
 * only when none exists (`#initializeRing`), so subclassing cannot reach
 * tokens drawn before activation. Instead:
 * - configureSize starts with a clean topName (Object.assign only adds
 *   keys, so a pack switch must not keep the previous pack's overlay);
 * - configureVisuals raises the module's TOP_LAYER effect bit after core's
 *   mask pass whenever the resolved ring variant carries an overlay. */

function syncTopLayerBit(ring) {
  if (ring.topName && topLayerClasses && topAtlasBaseTexture) ring.effects |= TOP_LAYER_EFFECT;
  else ring.effects &= ~TOP_LAYER_EFFECT;
}

/** Fix Foundry v14's TokenRing#configureSize padding math when c0 < 1:
 * core computes `scalePadding = (1 - c0) * maxSideLength` in world grid
 * pixels instead of `((1 / c0) - 1) * (longSide / 2)` in texture pixels,
 * clipping enlarged rings into a square box and mis-scaling them whenever
 * the texture resolution differs from the grid pixel size. */
function fixLowScalePadding(ring, opts) {
  const scaleMultiplier = Number.isFinite(opts?.scaleMultiplier) ? opts.scaleMultiplier : 1;
  const rawSubjScale = Number(ring.token?.document?.ring?.subject?.scale);
  const subjScale = (Number.isFinite(rawSubjScale) && rawSubjScale > 0) ? rawSubjScale : 1;
  const c0 = subjScale * scaleMultiplier;
  if (!(c0 > 0 && c0 < 1)) return;
  const mesh = ring.token?.mesh;
  const tex = mesh?.texture ?? ring.token?.texture;
  const tw = tex?.width ?? 0;
  const th = tex?.height ?? 0;
  const longSide = Math.max(tw, th);
  const shortSide = Math.min(tw, th);
  if (!mesh || !(longSide > 0 && shortSide > 0)) return;

  const scalePadding = ((1 / c0) - 1) * (longSide / 2);
  const padding = (longSide - shortSide) / 2;
  const paddingX = (tw < th) ? padding : 0;
  const paddingY = (tw > th) ? padding : 0;
  mesh.paddingX = paddingX + scalePadding;
  mesh.paddingY = paddingY + scalePadding;

  ring.scaleCorrection = 1;
  const scaleAdjustment = c0;
  const aspectRatioAdjustment = (shortSide / longSide) * scaleAdjustment;
  ring.scaleAdjustmentX = paddingX ? aspectRatioAdjustment : scaleAdjustment;
  ring.scaleAdjustmentY = paddingY ? aspectRatioAdjustment : scaleAdjustment;

  const TokenRing = ring.constructor;
  const nullUvs = CONFIG.Token?.ring?.shaderClass?.nullUvs;
  ring.ringUVs = TokenRing.getTextureUVs(ring.ringName, 1) ?? nullUvs;
  ring.bkgUVs = TokenRing.getTextureUVs(ring.bkgName, 1) ?? nullUvs;
  ring.maskUVs = TokenRing.getTextureUVs(ring.maskName, 1) ?? nullUvs;
}

function runConfigureSize(ring, options, callOriginal) {
  const prevAllowed = moduleContext.allowed;
  const prevPack = moduleContext.renderPack;
  try {
    applyRingContext(ring.token);
    const prevDefRC = ring.defaultRingColorLittleEndian;
    const prevDefBC = ring.defaultBackgroundColorLittleEndian;
    ring.topName = undefined;
    const opts = withPackScale(options);
    const result = callOriginal(opts);
    fixLowScalePadding(ring, opts);
    // Core's _refreshSize / _refreshMesh calls configureSize without a
    // matching configureVisuals; keep the top-layer bit and any changed
    // default ring/background colors in sync right here too (skip on the
    // initial TokenRing#configure call, where prevDefRC/prevDefBC are still
    // undefined and core calls configureVisuals on the very next line)
    syncTopLayerBit(ring);
    if ((prevDefRC !== undefined || prevDefBC !== undefined)
      && (ring.defaultRingColorLittleEndian !== prevDefRC
        || ring.defaultBackgroundColorLittleEndian !== prevDefBC)) {
      ring.configureVisuals();
    }
    return result;
  } finally {
    moduleContext.allowed = prevAllowed;
    moduleContext.renderPack = prevPack;
  }
}

function ringDataBySize(size, original) {
  const picked = pickRingData(currentAllowed(), Number.isFinite(size) ? size : 1);
  if (picked) return { ...picked.ring, colorBand: foundry.utils.deepClone(picked.ring.colorBand) };
  return original(size);
}

/** NaN scaleCorrection (e.g. a config-preview clone whose subject texture
 * has not loaded yet) would scale UVs into NaN — a mesh that renders
 * nothing. Clamp to identity instead; it heals on the next draw. */
function safeScaleCorrection(scaleCorrection) {
  return Number.isFinite(scaleCorrection) ? scaleCorrection : 1;
}

function installLibWrapperPatches() {
  const base = "foundry.canvas.placeables.tokens.TokenRing";
  libWrapper.register(MODULE_ID, `${base}.prototype.configureSize`,
    function (wrapped, options) {
      return runConfigureSize(this, options, opts => wrapped(opts));
    }, "MIXED");

  libWrapper.register(MODULE_ID, `${base}.getRingDataBySize`,
    function (wrapped, size) {
      return ringDataBySize(size, wrapped);
    }, "MIXED");

  libWrapper.register(MODULE_ID, `${base}.prototype.configureVisuals`,
    function (wrapped, ...args) {
      const result = wrapped(...args);
      syncTopLayerBit(this);
      return result;
    }, "WRAPPER");

  libWrapper.register(MODULE_ID, `${base}.getTextureUVs`,
    function (wrapped, name, scaleCorrection = 1) {
      return wrapped(name, safeScaleCorrection(scaleCorrection));
    }, "WRAPPER");
}

function installDirectPatches() {
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  if (TokenRing.prototype.__mringsDirect) return;
  TokenRing.prototype.__mringsDirect = true;

  const origConfigureSize = TokenRing.prototype.configureSize;
  TokenRing.prototype.configureSize = function (options) {
    return runConfigureSize(this, options, opts => origConfigureSize.call(this, opts));
  };

  const origConfigureVisuals = TokenRing.prototype.configureVisuals;
  TokenRing.prototype.configureVisuals = function (...args) {
    const result = origConfigureVisuals.apply(this, args);
    syncTopLayerBit(this);
    return result;
  };

  const origLookup = TokenRing.getRingDataBySize;
  TokenRing.getRingDataBySize = function (size) {
    return ringDataBySize(size, s => origLookup.call(this, s));
  };

  const origGetUVs = TokenRing.getTextureUVs;
  TokenRing.getTextureUVs = function (name, scaleCorrection = 1) {
    return origGetUVs.call(this, name, safeScaleCorrection(scaleCorrection));
  };
}

function installPatches() {
  if (wrappersInstalled) return;
  if (!featureDetect(foundry.canvas?.placeables?.tokens?.TokenRing)) return;

  if (globalThis.libWrapper) {
    try {
      installLibWrapperPatches();
      wrappersInstalled = true;
      console.log(`${MODULE_ID} | patches installed via libWrapper`);
      return;
    } catch (e) {
      console.warn(`${MODULE_ID} | libWrapper registration failed, using direct patch`, e);
      // Drop whatever got registered before the failure, or the direct
      // patches below would wrap the same methods a second time
      try { libWrapper.unregister_all(MODULE_ID); } catch { /* noop */ }
    }
  }
  installDirectPatches();
  wrappersInstalled = true;
  console.log(`${MODULE_ID} | patches installed directly`);
}

/* ------------------------------------------------------------------ */
/* Activation                                                         */
/* ------------------------------------------------------------------ */

async function activateFlow() {
  if (booted || activationStarted) return;
  activationStarted = true;

  // Self-heal: reset internal config accidentally picked as world setting
  // (world setting — only a GM may write it)
  if (game.user?.isGM) {
    try {
      if (game.settings.get("core", "dynamicTokenRing") === MEGA_ID) {
        const coreSteel = foundry.canvas.placeables.tokens.TokenRingConfig
          ?.CORE_TOKEN_RINGS?.coreSteel?.id ?? "coreSteel";
        await game.settings.set("core", "dynamicTokenRing", coreSteel);
        console.log(`${MODULE_ID} | world ring setting pointed at internal config; reset to ${coreSteel}`);
      }
    } catch { /* noop */ }
  }

  try {
    // Core's texture cache expires entries it has not handed out for a
    // while; the combined sheet is only fetched when UVs rebuild, so it
    // must be pinned or a later scene change would unload it.
    try { foundry.canvas.TextureLoader?.pinSource?.(MEGA_SHEET_KEY); } catch { /* noop */ }

    const ok = await preloadRegistries();
    if (!ok) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnNoSheets"));
      return;
    }

    // Never take over rendering with a substituted world pack: if the actual
    // world setting could not be indexed, staying native preserves its look.
    if (!sheetFrameIds.has(worldConfigId)) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
      console.warn(`${MODULE_ID} | world ring pack "${worldConfigId}" could not be indexed — staying on native rendering`);
      return;
    }

    createAtlas();

    // Bake the world-default sheet first — everything falls back to it
    const worldBaked = await materializeSheet(worldConfigId);
    if (worldBaked !== true) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
      return; // stay on native config
    }

    installPatches();
    if (!featureOK) return;

    const topOK = topLayerClasses ? topLayerClasses.TopRingSamplerShader.ensurePlugin() : false;
    CONFIG.Token.ring.useConfig(MEGA_ID);
    if (topLayerClasses && !topOK) {
      // No plugin, no custom shader: fall back to core's
      CONFIG.Token.ring.shaderClass = foundry.canvas.rendering.shaders.TokenRingSamplerShader;
      topLayerClasses = null;
    }
    foundry.canvas.placeables.tokens.TokenRing.tokenRingSamplerShader = CONFIG.Token.ring.shaderClass;
    refreshUVs();

    booted = true;
    registerDaeIntegration(); // belt & braces if dae.ready raced ahead of us
    // Tokens drawn before activation still hold native UVs and the native
    // ring shader: switch them onto the combined atlas (and world fallback
    // while custom packs download) immediately, then kick off bakes for all
    // current wearers.
    refreshAllRingTokens();
    for (const t of ringWearers()) scheduleTokenRefresh(t, { force: true });
  } catch (e) {
    console.error(`${MODULE_ID} | activation failed`, e);
    ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
  } finally {
    if (!booted && featureOK) activationStarted = false;
  }
}

Hooks.on("canvasReady", activateFlow);

/* ------------------------------------------------------------------ */
/* Document hooks                                                     */
/* ------------------------------------------------------------------ */

/** Tokens on the current scene representing an actor. Checks `document.actorId`
 * first so scanning the scene never eagerly materializes lazy `ActorDelta`
 * instances on unrelated unlinked tokens. */
function tokensOfActor(actor) {
  if (!actor) return [];
  if (actor.isToken) {
    const t = actor.token?.object;
    return t ? [t] : [];
  }
  const id = actor.id;
  return (canvas.tokens?.placeables ?? []).filter(t => {
    const doc = t?.document;
    if (id && doc?.actorId) return doc.actorId === id;
    return t?.actor === actor || (id && t?.actor?.id === id);
  });
}

/** Redraw an actor's tokens whose effective pack differs from the one they
 * were last drawn with, and re-check the budget. */
function refreshActorTokens(actor, reason) {
  for (const t of tokensOfActor(actor)) {
    if (lastPackOf.has(t) && lastPackOf.get(t) === effectivePackOf(t)) continue;
    scheduleTokenRefresh(t, { force: true });
  }
  scheduleEviction(reason);
}

/** Check every placed token on the scene for an effective-pack change (e.g.
 * when a temporary ActiveEffect expires on combat/time advance). */
function syncSceneTokenRings(reason) {
  if (!booted) return;
  let changed = false;
  for (const t of canvas.tokens?.placeables ?? []) {
    if (lastPackOf.has(t) && lastPackOf.get(t) === effectivePackOf(t)) continue;
    changed = true;
    scheduleTokenRefresh(t, { force: true });
  }
  if (changed) scheduleEviction(reason);
}

/** Whether a document diff touches this module's flags (set or delete). */
function diffTouchesModuleFlags(flagsDiff) {
  return !!flagsDiff && Object.keys(flagsDiff).some(k => k.replace(/^-=/, "") === MODULE_ID);
}

Hooks.on("updateToken", (doc, changed) => {
  if (!booted || !changed) return;
  const resized = "width" in changed || "height" in changed;
  const flagTouched = diffTouchesModuleFlags(changed.flags);
  const ringToggled = foundry.utils.hasProperty(changed, "ring.enabled");
  const actorSwapped = "actorId" in changed || "actorLink" in changed;
  if (!resized && !flagTouched && !ringToggled && !actorSwapped) return;
  // Resize in either direction changes the budget: growth may need new
  // variants, shrink frees the frames and density the token no longer needs
  scheduleEviction("token ring changed");
  const t = canvas.tokens?.get(doc.id);
  if (resized && t) {
    // Core animates width/height over 1000ms (past EVICT_DEBOUNCE_MS) under
    // `movementAnimationPromise` (v14) / `animationName` (v13); re-run
    // eviction once the animation settles so any intermediate size variants
    // held during the transition are reclaimed promptly.
    const animPromise = t.movementAnimationPromise
      ?? foundry.canvas?.animation?.CanvasAnimation?.getAnimation?.(t.animationName)?.promise;
    animPromise?.finally?.(() => scheduleEviction("token resize finished"));
  }
  // Core redraws on size/ring toggles itself; a changed ring choice is
  // invisible to core and needs an explicit redraw
  if (t) scheduleTokenRefresh(t, { force: flagTouched || actorSwapped });
});

Hooks.on("updateActor", (actor, changed) => {
  if (!booted) return;
  if (!diffTouchesModuleFlags(changed?.prototypeToken?.flags)) return;
  refreshActorTokens(actor, "prototype ring changed");
});

Hooks.on("createToken", (doc) => {
  if (!booted) return;
  if (!ringShown(doc)) return;
  const t = canvas.tokens?.get(doc.id);
  if (t) scheduleTokenRefresh(t);
});

// Safety net for draws that raced a bake: a token that had to draw against
// the world default (or a neighbouring size variant) re-arms its redraw chain
// here. Silent when nothing is missing or the pack is known-failed, so it
// cannot loop — the redraw this schedules only fires when new frames land.
Hooks.on("drawToken", (token) => {
  if (!booted || !ringShown(token)) return;
  const cfgId = effectivePackOf(token);
  if (!cfgId || isFailed(cfgId)) return;
  scheduleTokenRefresh(token);
});

Hooks.on("deleteToken", () => scheduleEviction("token deleted"));
Hooks.on("canvasReady", () => {
  if (!booted) return;
  // A new scene is a natural point to give failed packs another chance
  for (const id of [...failedSheets.keys()]) if (sheetSources.has(id)) failedSheets.delete(id);
  scheduleEviction("scene ready");
});
// A closed config window takes its preview clone (and the pack it previewed) along
Hooks.on("closeTokenConfig", () => scheduleEviction("token config closed"));
Hooks.on("closePrototypeTokenConfig", (app) => {
  // PrototypeTokenConfig's "Assign Token" action updates `actor.prototypeToken`
  // with `{noHook: true}` (suppressing `updateActor`), so sync the actor's
  // placed tokens here as well.
  const actor = configActor(app, configDocument(app));
  if (actor) refreshActorTokens(actor, "prototype config closed");
  else scheduleEviction("token config closed");
});

/* --- ActiveEffect-driven rings ------------------------------------ */

/** Actor an effect applies to (directly or transferred from an owned item). */
function effectActor(effect) {
  const parent = effect?.parent;
  if (!parent) return null;
  if (parent.documentName === "Actor") return parent;
  if (parent.documentName === "Item" && parent.parent?.documentName === "Actor") return parent.parent;
  return null;
}

for (const hook of ["createActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, (effect) => {
    if (!booted || !effectTouchesRing(effect)) return;
    refreshActorTokens(effectActor(effect), hook === "createActiveEffect" ? "effect added" : "effect removed");
  });
}

Hooks.on("updateActiveEffect", (effect, changes) => {
  if (!booted) return;
  const touchesRing =
    effectTouchesRing(effect) ||
    foundry.utils.hasProperty(changes ?? {}, "system.changes") ||
    foundry.utils.hasProperty(changes ?? {}, "changes");
  if (!touchesRing) return;
  refreshActorTokens(effectActor(effect), "effect updated");
});

// Item-transferred effects: adding/removing the item, or a system toggling
// suppression through item data (e.g. equipping), changes the ring
function itemCarriesRingEffect(item) {
  for (const effect of item?.effects ?? []) if (effectTouchesRing(effect)) return true;
  return false;
}

for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, (item) => {
    if (!booted) return;
    const actor = item?.parent;
    if (actor?.documentName !== "Actor" || !itemCarriesRingEffect(item)) return;
    refreshActorTokens(actor, `item ${hook.replace("Item", "").toLowerCase()}d`);
  });
}

// Temporary ActiveEffects expire when combat or world time advances without
// firing updateActiveEffect
for (const hook of ["updateCombat", "deleteCombat", "updateWorldTime"]) {
  Hooks.on(hook, () => syncSceneTokenRings("effect duration check"));
}

/* ------------------------------------------------------------------ */
/* DAE integration                                                    */
/* ------------------------------------------------------------------ */

let daeRegistered = false;

/**
 * Register `flags.multiple-rings.ringAppearance` as a first-class DAE change key:
 * - appears in DAE's field browser;
 * - its value renders as a <select> of all registered ring packs;
 * - change mode is forced to "override" (a ring choice is a replacement).
 * `options` is a getter, so packs registered by other modules appear immediately.
 */
function registerDaeIntegration() {
  if (daeRegistered) return true;
  const api = globalThis.DAE ?? game.modules.get("dae")?.api;
  const actorSpecs = api?.ValidSpec?.actorSpecs;
  if (!actorSpecs) return false;

  const specEntry = {
    fieldSpec: FLAG_PATH,
    forcedMode: "override",
    phase: "final",
    label: game.i18n.localize("MRINGS.SelectLabel"),
    description: game.i18n.localize("MRINGS.DAEDescription"),
    get options() {
      return {
        "": game.i18n.localize("MRINGS.WorldDefault"),
        ...getRingChoices()
      };
    }
  };

  let touched = 0;
  for (const specMap of Object.values(actorSpecs)) {
    if (!specMap?.allSpecsObj) continue;
    specMap.allSpecsObj[FLAG_PATH] = specEntry;
    if (Array.isArray(specMap.allSpecs) && !specMap.allSpecs.includes(specEntry)) {
      specMap.allSpecs.push(specEntry);
    }
    touched++;
  }

  try {
    api.addAutoFields?.([{ name: FLAG_PATH }]);
    // localizationMap is a plain object in current DAE ({}), not a Map
    const locEntry = {
      name: specEntry.label,
      description: specEntry.description
    };
    if (api.localizationMap instanceof Map) api.localizationMap.set(FLAG_PATH, locEntry);
    else if (api.localizationMap) api.localizationMap[FLAG_PATH] = locEntry;
  } catch (e) {
    console.warn(`${MODULE_ID} | failed to register DAE field metadata`, e);
  }

  daeRegistered = true;
  console.log(`${MODULE_ID} | DAE integration registered (${touched} actor spec maps)`);
  return true;
}

Hooks.once("dae.ready", () => registerDaeIntegration());

/* ------------------------------------------------------------------ */
/* Token / Prototype token config UI injection                        */
/* ------------------------------------------------------------------ */

/**
 * Document the config form edits. `app.token` is the live preview (it
 * carries unsaved form changes, so re-renders keep the pending choice):
 * a TokenDocument clone in TokenConfig, the PrototypeToken in
 * PrototypeTokenConfig (which has no `document`).
 */
function configDocument(app) {
  let doc = null;
  try { doc = app?.token ?? null; } catch { doc = null; }
  doc ??= app?.document ?? app?.object ?? null;
  if (doc?.documentName === "Actor") doc = doc.prototypeToken ?? null;
  return doc;
}

function configActor(app, doc) {
  try { return app?.actor ?? actorOf(doc); } catch { return actorOf(doc); }
}

function injectRingSelect(app, element) {
  try {
    if (!booted || !featureOK) return false;
    const root = element instanceof HTMLElement ? element : element?.[0] ?? app?.element ?? null;
    if (!root?.querySelector) return false;
    if (root.querySelector(`#${RING_SELECT_ID}`)) return true;

    let ringFieldset = null;
    const ringLegend = game.i18n.localize("TOKEN.RING.SHEET.legend");
    for (const fs of root.querySelectorAll("fieldset")) {
      const legend = fs.querySelector("legend");
      if ((legend && legend.textContent.trim() === ringLegend)
        || fs.querySelector('[name="ring.enabled"], [name="ring.subject.scale"]')) {
        ringFieldset = fs;
        break;
      }
    }
    if (!ringFieldset) {
      ringFieldset = root.querySelector('.tab[data-tab="appearance"]')
        ?? root.querySelector('[data-tab="appearance"]')
        ?? root.querySelector(".standard-form, form")
        ?? root;
      if (!ringFieldset) return false;
    }

    const row = document.createElement("div");
    row.className = "form-group";
    const label = document.createElement("label");
    label.textContent = game.i18n.localize("MRINGS.SelectLabel");
    label.htmlFor = RING_SELECT_ID;

    const fields = document.createElement("div");
    fields.className = "form-fields";

    // Show the document's OWN stored flag, never the prototype fallback or
    // the effect-resolved ring: saving the form must not copy a prototype or
    // active-effect ring into the token's own flag
    const doc = configDocument(app);
    const currentValue = getOwnRingId(doc) ?? "";

    const choices = getRingChoices({ indexedOnly: true });
    const select = document.createElement("select");
    select.id = RING_SELECT_ID;
    select.name = FLAG_PATH;

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = game.i18n.localize("MRINGS.WorldDefault");
    select.appendChild(blank);

    for (const [id, labelText] of Object.entries(choices)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = labelText;
      if (id === currentValue) opt.selected = true;
      select.appendChild(opt);
    }
    if (currentValue && !choices[currentValue]) {
      const opt = document.createElement("option");
      opt.value = currentValue;
      opt.textContent = currentValue;
      opt.selected = true;
      select.appendChild(opt);
    }

    fields.appendChild(select);
    // Pre-bake the chosen pack while the form is still open (the preview
    // clone counts as a wearer, so its size variant is covered), then let the
    // live preview show the new ring immediately — core does not redraw the
    // preview for a flag change on its own. Unapplied choices get reclaimed
    // by the eviction sweep once the window closes.
    select.addEventListener("change", () => {
      const pickedId = select.value;
      // Defer past the form's own change handling so the preview clone
      // already carries the new choice when the wearer scan runs
      setTimeout(() => {
        const effectiveId = effectivePackOf(configDocument(app)) || pickedId;
        if (!effectiveId || !sheetSources.has(effectiveId)) {
          if (pickedId && !sheetSources.has(pickedId)) {
            console.warn(`${MODULE_ID} | ring "${pickedId}" is not indexed and cannot be baked — its sheet likely failed to load at startup (see earlier warnings)`);
          }
          refreshConfigPreviews();
          return;
        }
        // PrototypeTokenConfig has no live canvas preview clone; skip
        // pre-baking when no placed token or preview currently wears the pack
        if (!packHasWearers(effectiveId)) {
          refreshConfigPreviews();
          return;
        }
        ensureVariantsFor(effectiveId).then(ok => {
          if (ok === false) console.warn(`${MODULE_ID} | pre-bake of "${effectiveId}" failed; it will retry on apply`);
          refreshConfigPreviews();
        });
      }, 0);
    });
    // PrototypeTokenConfig's "Assign Token" button replaces `actor.prototypeToken`
    // using `{noHook: true}`; sync the select value and placed tokens after click.
    const assignBtn = root.querySelector('[data-action="assignToken"]');
    if (assignBtn && !assignBtn.__mringsBound) {
      assignBtn.__mringsBound = true;
      assignBtn.addEventListener("click", () => {
        setTimeout(() => {
          const actor = configActor(app, configDocument(app));
          if (actor) refreshActorTokens(actor, "prototype token assigned");
        }, 50);
      });
    }
    row.append(label, fields);

    // Note when an ActiveEffect currently overrides the choice
    const aeOverride = effectRingOverride(configActor(app, doc));
    if (aeOverride !== undefined) {
      const note = document.createElement("p");
      note.className = "hint";
      const shown = aeOverride ? (choices[aeOverride] ?? aeOverride) : game.i18n.localize("MRINGS.WorldDefault");
      note.textContent = `${game.i18n.localize("MRINGS.AEOverrideNote")} (${shown})`;
      row.append(note);
    }

    const textureRow = ringFieldset.querySelector('[name="ring.subject.texture"]')?.closest(".form-group");
    if (textureRow && textureRow.parentElement === ringFieldset) textureRow.after(row);
    else {
      const anchor = ringFieldset.querySelector('[name="ring.subject.scale"]')?.closest(".form-group");
      if (anchor && anchor.parentElement === ringFieldset) anchor.before(row);
      else ringFieldset.appendChild(row);
    }
    return true;
  } catch (e) {
    console.warn(`${MODULE_ID} | ring select inject failed`, e);
    return false;
  }
}

const observedRoots = new WeakSet();

function retryInject(app, element) {
  if (injectRingSelect(app, element)) return;
  requestAnimationFrame(() => {
    if (injectRingSelect(app, element)) return;
    setTimeout(() => injectRingSelect(app, element), 250);
  });
  try {
    const root = element instanceof HTMLElement ? element : element?.[0] ?? app?.element;
    // One observer per window element, however often it re-renders
    if (!root?.querySelector || observedRoots.has(root)) return;
    observedRoots.add(root);
    const stop = () => { obs.disconnect(); observedRoots.delete(root); };
    const obs = new MutationObserver(() => {
      if (injectRingSelect(app, root)) stop();
    });
    obs.observe(root, { childList: true, subtree: true });
    setTimeout(stop, 4000);
  } catch { /* noop */ }
}

Hooks.on("renderTokenConfig", retryInject);
Hooks.on("renderPrototypeTokenConfig", retryInject);
