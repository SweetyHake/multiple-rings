const MODULE_ID = "multiple-rings";
const RING_SELECT_ID = "multiple-rings-appearance-select";
const FLAG_PATH = `flags.${MODULE_ID}.ringAppearance`;
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

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

let worldConfigId = null;
let booted = false;
let featureOK = true;
let capacityWarned = false;
let wrappersInstalled = false;
let rebuildInProgress = false;
let rebuildPromise = Promise.resolve();
let evictDebounce = null;
const warnedUnknownPacks = new Set();
const warnedNoWearers = new Set();  // cfgId -> "no wearers yet" logged once

// Metadata registry built from JSONs only (no images needed)
// key = "<cfgId>:<frameName>"
const ringRegistry = [];
const sheetFrameIds = new Map();   // cfgId -> Set<prefixed keys>
const sheetSources = new Map();    // cfgId -> { imgPath, rects, config }
const materialized = new Map();    // cfgId -> PIXI.Texture (source image, kept while baked)
const failedSheets = new Set();
const pendingSheets = new Map();   // cfgId -> Promise<boolean>
const variantJobs = new Map();     // cfgId -> Promise<boolean> (variant top-up bakes)
const sheetSlots = new Map();      // cfgId -> [{key,x,y,w,h}]
const lastUsed = new Map();        // cfgId -> Date.now()

// Atlas packing state
let atlasCanvas = null;
let atlasCtx = null;
let atlasBaseTexture = null;
let atlasSheet = null;
let atlasW = 2048;
let atlasH = 1024;
let packX = 0, packY = 0, packRowH = 0;
const scaleAssignments = new Map(); // cfgId -> baked scale, planned at createAtlasconst reportedScales = new Map();   // cfgId -> last logged scale (dedupes budget logs)
const appliedScaleCaps = new Map(); // cfgId -> density cap baked into the current atlas
// Double-buffering: a rebuild bakes into the new atlas without touching live
// renderer state; commitAtlas() installs everything in one synchronous tick
const deferredFrameTextures = new Map(); // frame key -> Texture (new atlas)
const pendingSlots = new Map();          // cfgId -> slots (new atlas)
let retiredAtlas = null;                 // previous { baseTexture }, destroyed after commit

// Active context used by the wrapped getRingDataBySize
const moduleContext = { allowed: null };
function currentAllowed() { return moduleContext.allowed; }
function setAllowed(v) { moduleContext.allowed = v; }

/* ------------------------------------------------------------------ */
/* Settings & registration                                            */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "MRINGS.SettingEnabledName",
    hint: "MRINGS.SettingEnabledHint",
    scope: "world",
    config: true,
    default: true,
    type: Boolean,
    requiresReload: true
  });
});

Hooks.on("initializeDynamicTokenRingConfig", (ringConfig) => {
  try {
    const DynamicRingData = foundry.canvas.placeables.tokens.DynamicRingData;
    ringConfig.addConfig(MEGA_ID, new DynamicRingData({
      id: MEGA_ID,
      label: game.i18n.localize("MRINGS.CombinedConfigLabel"),
      spritesheet: MEGA_SHEET_KEY
    }));
    hideInternalConfig();
  } catch (e) {
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

function isEnabled() {
  try { return game.settings.get(MODULE_ID, "enabled") !== false; }
  catch { return true; }
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
function packStartScale(cfgId) {
  return packScaleCap(cfgId);
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

/** Ring override carried by an ActiveEffect change (last applied wins). */
function effectRingOverride(actor) {
  try {
    const fx = actor?.appliedEffects ?? actor?.effects;
    if (!fx || !fx.length) return undefined;
    let out;
    for (const effect of fx) {
      if (effect.disabled || effect.suppressed) continue;
      for (const change of effect.changes ?? []) {
        if (change.key === FLAG_PATH) out = change.value;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Effective ring pack for a document.
 * Resolution order:
 *   1. ActiveEffect change with key `flags.multiple-rings.ringAppearance`
 *   2. Token/prototype document flag
 *   3. null (= world default)
 */
function getEffectiveRingId(doc) {
  if (!doc) return null;

  const actor = doc.actor
    ?? (doc.parent?.documentName === "Actor" ? doc.parent : null)
    ?? (doc.actorId ? game.actors.get(doc.actorId) : null);

  const ae = effectRingOverride(actor);
  if (ae != null && ae !== "") return ae;
  if (ae === "") return null; // explicit default via effect

  const own = foundry.utils.getProperty(doc, FLAG_PATH);
  if (own) return own;

  const proto = actor?.prototypeToken;
  const protoVal = proto ? foundry.utils.getProperty(proto, FLAG_PATH) : null;
  return protoVal ?? null;
}

/** Legacy alias used by UI code paths that only want the stored flag. */
function getFlagRingId(doc) {
  if (!doc) return null;
  return foundry.utils.getProperty(doc, FLAG_PATH) ?? null;
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
    const c = Color.from(value);
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

function warnCapacityOnce() {
  if (capacityWarned) return;
  capacityWarned = true;
  console.warn(`${MODULE_ID} | atlas capacity reached: some ring frames were skipped (see packList in MultipleRings.status())`);
}

/* ------------------------------------------------------------------ */
/* Preload: fetch JSONs, build metadata registry, size the atlas      */
/* ------------------------------------------------------------------ */

/**
 * Resolve a spritesheet's meta.image against the sheet location.
 * Handles relative paths, absolute/protocol URLs, data: and blob: URIs вЂ”
 * custom rings (e.g. SETT) may register any of these.
 */
function resolveImageURL(src) {
  const img = src.metaImage;
  if (/^(data|blob|https?|ftp):/i.test(img) || img.startsWith("/")) return img;
  try {
    return new URL(img, new URL(src.sheetSrc, location.origin)).href;
  } catch {
    const dir = src.sheetSrc.slice(0, src.sheetSrc.lastIndexOf("/") + 1);
    return dir + img;
  }
}

async function preloadRegistries() {
  const ring = CONFIG.Token.ring;
  const ids = (ring.configIDs ?? []).filter(id => id !== MEGA_ID);
  if (!ids.length) return false;

  for (const cfgId of ids) {
    const cfg = ring.getConfig(cfgId);
    if (!cfg?.spritesheet) continue;
    try {
      const resp = await fetch(cfg.spritesheet);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      let frames = json.frames;
      if (!frames && json.config?.frames) frames = json.config.frames;
      if (!frames) {
        console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet} has no recognizable frames вЂ” skipped`);
        continue;
      }

      const rects = [];
      for (const [name, f] of Object.entries(frames)) {
        const fr = f.frame;
        if (!fr) continue;
        rects.push({ key: `${cfgId}:${name}`, data: f, w: fr.w, h: fr.h });
      }
      if (!rects.length) {
        console.warn(`${MODULE_ID} | sheet ${cfg.spritesheet} has no drawable frames вЂ” skipped`);
        continue;
      }
      rects.sort((a, b) => b.h - a.h);

      // Group frames into size variants: a base frame plus its optional
      // -bkg/-msk companions targets one token grid size, and a placed token
      // resolves exactly one variant via getRingDataBySize. Only the variants
      // in actual use get baked (see bakeRects).
      const variantTargets = new Map();
      for (const r of rects) {
        if (r.key.endsWith("-bkg") || r.key.endsWith("-msk")) continue;
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
        metaImage: json.meta.image
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

      for (const r of rects) {
        if (r.key.endsWith("-bkg") || r.key.endsWith("-msk")) continue;
        const fm = r.data;
        const rc = colorToLE(fm.ringColor, defRC);
        const bc = colorToLE(fm.backgroundColor, defBC);
        const ringThickness = fm.ringThickness ?? DEFAULT_RING_THICKNESS;
        ringRegistry.push({
          ringName: r.key,
          bkgName: `${r.key}-bkg`,
          maskName: `${r.key}-msk`,
          colorBand: foundry.utils.deepClone(fm.colorBand ?? defBand),
          gridTarget: fm.gridTarget ?? 1,
          defaultRingColorLittleEndian: rc,
          defaultBackgroundColorLittleEndian: bc,
          subjectScaleAdjustment: 1 / (ringThickness + DEFAULT_SUBJECT_THICKNESS)
        });
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | skipping ring sheet ${cfg.spritesheet}:`, e);
    }
  }

  ringRegistry.sort((a, b) => a.gridTarget - b.gridTarget);

  // Resolve which config the world actually uses.
  // NOTE: do NOT use CONFIG.Token.ring.id here — module-registered packs
  // (e.g. SETT) build DynamicRingData without an `id` field, so cfg.id is ""
  // even though the config map key is a real id. The world SETTING stores
  // the map key directly, which is exactly what we need.
  let worldSetting = null;
  try { worldSetting = game.settings.get("core", "dynamicTokenRing") ?? null; } catch { /* noop */ }
  worldConfigId ??= worldSetting;
  const worldIndexed = sheetFrameIds.has(worldConfigId);
  console.log(`${MODULE_ID} | world ring setting "${worldConfigId}" ${worldIndexed ? "indexed" : "NOT indexed"}; ` +
    `indexed packs: ${[...sheetFrameIds.keys()].join(", ") || "(none)"}`);
  if (!worldIndexed) {
    worldConfigId = sheetFrameIds.keys().next().value ?? null;
  }

  console.log(`${MODULE_ID} | indexed ${sheetSources.size} ring sheets, ${ringRegistry.length} rings`);
  return sheetSources.size > 0 && worldConfigId != null;
}

/** Packs the budget actually plans for: the world default plus everything in use. */
function planningSet() {
  const set = new Set(materialized.keys());
  for (const id of pendingSheets.keys()) set.add(id);
  if (worldConfigId) set.add(worldConfigId);
  return [...set].filter(id => sheetSources.has(id));
}

/* ------------------------------------------------------------------ */
/* Size variants                                                      */
/* ------------------------------------------------------------------ */

/** Strip a frame key's -bkg/-msk companion suffix (base variant key). */
function variantBaseKey(key) {
  return key.replace(/-(bkg|msk)$/, "");
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

/**
 * Everything that currently renders (or previews) with a given pack: placed
 * tokens plus open token-config preview clones. The clone being edited
 * already carries the freshly selected pack, so its variant must be baked
 * for the live preview — before the change is ever applied.
 */
function ringWearers(cfgId) {
  const out = [];
  for (const t of canvas.tokens?.placeables ?? []) out.push(t);
  for (const c of canvas.tokens?._configPreview?.children ?? []) {
    if (c?._previewType === "config") out.push(c);
  }
  return out;
}

/** Base keys of the size variants placed tokens actually use in a pack. */
function neededVariants(cfgId) {
  const set = new Set();
  for (const t of ringWearers(cfgId)) {
    if (t.document?.ring?.enabled === false) continue; // core renders no ring
    if (effectivePackOf(t) !== cfgId) continue;
    const key = resolveVariantKey(cfgId, tokenRingSize(t));
    if (key) set.add(key);
  }
  return set;
}

/**
 * Upper bound on a pack's bake scale derived from actual need rather than
 * frame authoring. A frame only ever gets sampled at the wearing token's
 * on-screen size, so ~RING_PX_PER_CELL per grid cell of the largest wearing
 * token is full parity with well-authored packs; denser source frames (e.g.
 * single-variant 2048px sheets whose gridTarget is 1) are capped instead of
 * burning atlas memory on texels the shader can never show. For standard
 * packs this always evaluates to >= 1, i.e. a no-op. With no placed wearer
 * the size defaults to 1 (the world-fallback resolution).
 */
function packScaleCap(cfgId, rects = bakeRects(cfgId)) {
  if (!rects.length) return 1;
  let maxSize = 1;
  for (const t of ringWearers(cfgId)) {
    if (t.document?.ring?.enabled === false) continue;
    if (effectivePackOf(t) !== cfgId) continue;
    maxSize = Math.max(maxSize, tokenRingSize(t));
  }
  let maxFrame = 0;
  for (const r of rects) maxFrame = Math.max(maxFrame, r.data.frame.w, r.data.frame.h);
  return maxFrame ? Math.min(1, (RING_PX_PER_CELL * maxSize) / maxFrame) : 1;
}

/**
 * Source rects to bake for a pack: only the size variants placed tokens
 * resolve to, each with its -bkg/-msk companions. Empty when unused —
 * a pack sheet with 5 size variants then costs 1 instead of 5.
 * Exception: while the atlas holds nothing at all, the world pack keeps its
 * medium variant baked. Core builds its UV/ring tables from this sheet, and
 * an empty sheet leaves ring draws without data — a token being drawn before
 * its own pack is baked then disappears entirely instead of showing a
 * fallback ring.
 */
function bakeRects(cfgId) {
  const src = sheetSources.get(cfgId);
  if (!src) return [];
  let needed = neededVariants(cfgId);
  if (!needed.size && cfgId === worldConfigId && ![...sheetSlots.values()].some(s => s.length)) {
    const key = resolveVariantKey(cfgId, 1);
    if (key) needed = new Set([key]);
  }
  if (!needed.size) return [];
  return src.rects.filter(r => needed.has(r.variant));
}

/** Packed height of the given packs, each at its own scale. */
function simulateHeight(width, packIds, scaleOf, rectsById) {
  let px = 0, py = 0, rh = 0;
  for (const cfgId of packIds) {
    const s = scaleOf(cfgId) ?? 1;
    for (const r of rectsById.get(cfgId) ?? []) {
      const w = Math.max(1, Math.round(r.data.frame.w * s));
      const h = Math.max(1, Math.round(r.data.frame.h * s));
      if (px + w > width) { px = 0; py += rh; rh = 0; }
      px += w;
      rh = Math.max(rh, h);
    }
  }
  return py + rh;
}

/**
 * Assign every pack its starting scale (the density cap — fully automatic),
 * then step the least important packs down the ladder until the full layout
 * fits the GPU texture limit. The atlas width is a choice too: a layout that
 * fits at the GPU's full width always beats degrading packs.
 */
function planScales(maxTex) {
  const ids = planningSet();
  // Only the size variants placed tokens actually use count against the budget
  const rectsById = new Map(ids.map(id => [id, bakeRects(id)]));

  // Packs degrade by staleness. The world pack has no special priority —
  // it degrades like any other pack.
  const byOldestUse = (a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0);
  const degradeOrder = [...ids].sort(byOldestUse);
  const scaleFloor = id => (id === worldConfigId ? WORLD_MIN_SCALE : 0);

  /** Round-robin degradation at a fixed width until the layout fits maxTex. */
  const planAtWidth = width => {
    const assign = new Map();
    for (const id of ids) {
      const start = packStartScale(id);
      // The world pack's floor wins over the density cap
      assign.set(id, id === worldConfigId ? Math.max(start, WORLD_MIN_SCALE) : start);
    }
    let needed = simulateHeight(width, ids, id => assign.get(id), rectsById);
    const changes = [];
    let guard = degradeOrder.length * SCALE_STEPS.length + 2;
    while (needed > maxTex && guard-- > 0) {
      // Degrade round-robin: each pass steps every eligible pack down one
      // rung, so quality stays even across rings instead of sinking single
      // packs to the bottom. Priority only decides who yields first.
      let progressed = false;
      for (const id of degradeOrder) {
        const next = nextStepBelow(assign.get(id));
        if (next === null || next < scaleFloor(id) - 1e-9) continue;
        const from = assign.get(id);
        assign.set(id, next);
        changes.push([id, from, next]);
        progressed = true;
        needed = simulateHeight(width, ids, innerId => assign.get(innerId), rectsById);
        if (needed <= maxTex) break;
      }
      if (!progressed) break; // everyone is at their floor / bottom rung
    }
    return { width, assign, needed, minScale: Math.min(...assign.values(), 1), changes };
  };

  // Evaluate candidate widths and keep the one that preserves quality best;
  // the narrower atlas wins ties (less VRAM). Scaling changes are reported
  // only for the winning plan.
  const candidates = [...new Set([Math.min(2048, maxTex), maxTex])].map(planAtWidth);
  const best = candidates.reduce((a, b) => (b.minScale > a.minScale ? b : a));
  for (const [id, from, to] of best.changes) reportScaleChange(id, from, to);
  return { assign: best.assign, width: best.width, needed: best.needed };
}

/** Log scale changes once per actual change; report restorations back to start. */
function reportScaleChange(cfgId, from, to) {
  const start = packStartScale(cfgId);
  if (to >= start - 1e-9) {
    if (reportedScales.has(cfgId)) {
      console.log(`${MODULE_ID} | bake budget: "${cfgId}" restored to ${(100 * to).toFixed(0)}%`);
    }
    reportedScales.delete(cfgId);
    return;
  }
  if (reportedScales.get(cfgId) === to) return;
  reportedScales.set(cfgId, to);
  console.warn(`${MODULE_ID} | bake budget: "${cfgId}" degraded ${(100 * from).toFixed(0)}% -> ${(100 * to).toFixed(0)}% to fit the atlas`);
}

function createAtlas() {
  const maxTex = getMaxTextureSize();
  const plan = planScales(maxTex);
  scaleAssignments.clear();
  for (const [id, s] of plan.assign) scaleAssignments.set(id, s);
  appliedScaleCaps.clear();
  for (const id of plan.assign.keys()) appliedScaleCaps.set(id, packScaleCap(id));
  atlasW = plan.width;
  atlasH = Math.min(Math.max(1, Math.ceil(plan.needed)), maxTex);
  const scales = [...scaleAssignments].map(([id, s]) => `${id} ${(100 * s).toFixed(0)}%`).join(", ");
  console.log(`${MODULE_ID} | bake budget (auto), atlas ${atlasW}x${atlasH}, ` +
    `GPU limit ${maxTex}; scales: ${scales}`);

  // Retire the previous generation: it stays fully renderable while the new
  // atlas bakes, and commitAtlas() destroys it after tokens have redrawn
  retiredAtlas = atlasBaseTexture ? { baseTexture: atlasBaseTexture } : null;

  atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasW;
  atlasCanvas.height = atlasH;
  atlasCtx = atlasCanvas.getContext("2d");
  atlasCtx.imageSmoothingEnabled = true;
  atlasCtx.imageSmoothingQuality = "high";
  atlasBaseTexture = PIXI.BaseTexture.from(atlasCanvas);
  atlasSheet = new PIXI.Spritesheet(atlasBaseTexture, {
    frames: {},
    meta: { scale: "1" }
  });
  PIXI.Assets.cache.set(MEGA_SHEET_KEY, atlasSheet);
}

/* ------------------------------------------------------------------ */
/* Live re-plan                                                       */
/* ------------------------------------------------------------------ */

/** Re-plan pack scales and rebuild the atlas without a reload. */
async function replanAndRebuild(reason) {
  if (!booted || !atlasCtx) return;
  if (rebuildInProgress) {
    // Queue behind the running rebuild (eviction, lazy bake), then retry
    return rebuildPromise.then(() => replanAndRebuild(reason));
  }
  createAtlas();
  await rebuildAtlas(reason);
  if (failedSheets.size) await retryFailed();
  for (const t of canvas.tokens?.placeables ?? []) scheduleTokenRefresh(t);
}

/** True if the given frames fit the atlas' free space at the given scale. */
function packFitsAtlas(cfgId, scale, rects = bakeRects(cfgId)) {
  if (!atlasCtx) return false;
  let px = packX, py = packY, rh = packRowH;
  for (const r of rects) {
    const { w, h } = scaledFrameSize(r.data.frame, scale);
    if (px + w > atlasW) { px = 0; py += rh; rh = 0; }
    if (py + h > atlasH) return false;
    px += w;
    rh = Math.max(rh, h);
  }
  return true;
}

/**
 * Make room for a newly worn pack: re-plan the budget over the in-use set
 * (degrading packs just enough), resize the atlas and re-bake the survivors.
 * The caller bakes the new pack itself afterwards.
 */
async function replanAtlasFor(cfgId, rects = bakeRects(cfgId)) {
  while (rebuildInProgress) {
    await rebuildPromise;
    // A concurrent replan covered us — planning set includes pending packs
    if (packFitsAtlas(cfgId, packScale(cfgId), rects)) return;
  }
  if (packFitsAtlas(cfgId, packScale(cfgId), rects)) return;
  createAtlas();
  await rebuildAtlas(`make room for "${cfgId}"`);
  if (failedSheets.size) await retryFailed();
  for (const t of canvas.tokens?.placeables ?? []) scheduleTokenRefresh(t);
}

/* ------------------------------------------------------------------ */
/* Baking & lazy materialization                                      */
/* ------------------------------------------------------------------ */

function allocSlot(w, h) {
  if (packX + w > atlasW) { packX = 0; packY += packRowH; packRowH = 0; }
  if (packY + h > atlasH) return null;
  const slot = { x: packX, y: packY };
  packX += w;
  packRowH = Math.max(packRowH, h);
  return slot;
}

function frameEntry(_fr, slot, dw, dh, extra) {
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

/**
 * Draw a pack's given frames into the atlas and register their textures.
 * append=true adds slots to the pack's existing ones (variant top-up)
 * instead of replacing them; with no rects this is a successful no-op
 * (a pack nobody currently wears bakes nothing).
 */
function bakeSheetPixels(cfgId, tex, rects, { append = false, defer = false } = {}) {
  const src = sheetSources.get(cfgId);
  if (!src || !atlasCtx) return false;
  const source = tex.baseTexture.resource.source;
  const scale = packScale(cfgId);
  const slots = [];

  for (const r of rects) {
    const fr = r.data.frame;
    const { w: dw, h: dh } = scaledFrameSize(fr, scale);
    const slot = allocSlot(dw, dh);
    if (!slot) break;
    atlasCtx.drawImage(source, fr.x, fr.y, fr.w, fr.h, slot.x, slot.y, dw, dh);
    const extra = Object.fromEntries(Object.entries(r.data).filter(([k]) => META_KEYS.includes(k)));
    atlasSheet.data.frames[r.key] = frameEntry(fr, slot, dw, dh, extra);
    const frameTex = new PIXI.Texture(atlasBaseTexture, new PIXI.Rectangle(slot.x, slot.y, dw, dh));
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
    slots.push({ key: r.key, ...slot, w: dw, h: dh });
  }

  if (defer) pendingSlots.set(cfgId, slots);
  else sheetSlots.set(cfgId, append ? [...(sheetSlots.get(cfgId) ?? []), ...slots] : slots);
  if (slots.length < rects.length) warnCapacityOnce();
  return slots.length === rects.length;
}

/**
 * Swap the freshly baked atlas generation into the renderer in one
 * synchronous tick: per-frame cache entries, slot bookkeeping, UV tables and
 * token redraws all switch together. Until this runs, every token draw —
 * including ones triggered mid-rebuild — resolves against the previous
 * generation and keeps showing its old (or fallback) ring instead of
 * rendering nothing.
 */
function commitAtlas() {
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
  for (const [cfgId, slots] of pendingSlots) sheetSlots.set(cfgId, slots);
  pendingSlots.clear();
  atlasBaseTexture.update();
  // Only when the UV tables actually rebuilt do meshes stop referencing the
  // previous atlas; otherwise it must stay alive (core still samples it)
  const uvRebuilt = booted ? refreshUVs() : false;
  // New atlas generation: every existing ring mesh must redraw or it keeps
  // sampling the new texture with UVs from the old one
  refreshAllRingTokens();
  const old = retiredAtlas;
  retiredAtlas = null;
  // Tokens pick up the new generation on the next frame or two; only then is
  // the previous atlas truly unreferenced and safe to free from the GPU
  if (old && uvRebuilt) {
    setTimeout(() => { try { old.baseTexture.destroy(); } catch { /* noop */ } }, 2000);
  }
}

async function materializeSheet(cfgId, { allowReplan = true } = {}) {
  if (materialized.has(cfgId)) return Promise.resolve(true);
  if (failedSheets.has(cfgId)) return Promise.resolve(false);
  if (pendingSheets.has(cfgId)) return pendingSheets.get(cfgId);
  if (rebuildInProgress) {
    // Queue behind the running rebuild, then retry normally
    return rebuildPromise.then(() => materializeSheet(cfgId, { allowReplan }));
  }

  const job = (async () => {
    const src = sheetSources.get(cfgId);
    const cfg = CONFIG.Token.ring.getConfig(cfgId);
    if (!src || !atlasCtx) {
      console.warn(`${MODULE_ID} | cannot bake "${cfgId}": ${!src ? "pack is not indexed (its sheet failed to load at startup)" : "atlas is not created yet"}`);
      failedSheets.add(cfgId);
      return false;
    }
    try {
      // Usage-based budget: only the size variants placed tokens (and open
      // token-config previews) actually use are planned and baked. A pack
      // nobody wears bakes nothing — and must NOT be marked materialized:
      // an "empty baked" pack would make every draw re-request it, each
      // request "succeeding" and triggering another redraw — an endless
      // chain that keeps the token hidden until its pack is truly baked.
      const rects = bakeRects(cfgId);
      if (!rects.length) {
        if (!warnedNoWearers.has(cfgId)) {
          warnedNoWearers.add(cfgId);
          console.log(`${MODULE_ID} | "${cfgId}" has no wearers yet — bake deferred until a token (or open preview) wears it`);
        }
        return true;
      }

      let tex = materialized.get(cfgId);
      if (!tex) {
        src.imgPath ??= resolveImageURL(src);
        tex = await foundry.canvas.loadTexture(src.imgPath);
        if (!tex?.baseTexture?.valid) throw new Error(`image load failed: ${src.imgPath}`);
      }
      // If the newly worn pack doesn't fit the current atlas, degrade
      // everyone just enough to make room for it
      if (allowReplan && !packFitsAtlas(cfgId, packScale(cfgId), rects)) {
        await replanAtlasFor(cfgId, rects);
      }
      const ok = bakeSheetPixels(cfgId, tex, rects);
      if (!ok) { failedSheets.add(cfgId); return false; }
      materialized.set(cfgId, tex);
      lastUsed.set(cfgId, Date.now());
      atlasBaseTexture.update();

      if (booted) refreshUVs();
      warnedNoWearers.delete(cfgId);
      console.log(`${MODULE_ID} | baked ring sheet "${cfgId}" (${sheetSlots.get(cfgId)?.length ?? 0} frames)`);
      return true;
    } catch (e) {
      console.warn(`${MODULE_ID} | failed to bake ring sheet "${cfgId}"`, e);
      failedSheets.add(cfgId);
      return false;
    } finally {
      pendingSheets.delete(cfgId);
    }
  })();

  pendingSheets.set(cfgId, job);
  return job;
}

/** Make sure this token's pack AND its size variant are baked. */
function ensureForToken(token) {
  const cfgId = effectivePackOf(token);
  if (!cfgId || !sheetSources.has(cfgId)) return Promise.resolve(true);
  return ensureVariantsFor(cfgId);
}

/**
 * Bake size variants a pack's placed tokens need but the atlas lacks yet
 * (token placed, or grew into a different size). Appends in free atlas space
 * when possible, otherwise re-plans the whole budget.
 */
async function ensureVariantsFor(cfgId) {
  if (!booted || !atlasCtx || !sheetSources.has(cfgId)) {
    console.warn(`${MODULE_ID} | cannot prepare "${cfgId}": ${!booted ? "module is not booted" : !atlasCtx ? "atlas is not created yet" : "pack is not indexed"}`);
    return false;
  }
  if (!materialized.has(cfgId)) return materializeSheet(cfgId);
  if (variantJobs.has(cfgId)) return variantJobs.get(cfgId);
  const job = (async () => {
    if (rebuildInProgress) await rebuildPromise;
    const tex = materialized.get(cfgId);
    if (!tex) return materializeSheet(cfgId); // evicted meanwhile
    const have = bakedVariantsOf(cfgId);
    const missing = bakeRects(cfgId).filter(r => !have.has(r.variant));
    // A larger token arrived: the pack's density cap rose above what the
    // current atlas was planned with — re-plan so its frames re-bake higher.
    // Compared against the cap recorded at plan time (not the assigned
    // scale) so budget degradation below the cap can't loop the rebuild.
    const capNow = packScaleCap(cfgId);
    if (capNow > (appliedScaleCaps.get(cfgId) ?? 1) + 1e-6) {
      createAtlas();
      await rebuildAtlas(`higher resolution needed for "${cfgId}"`);
      if (failedSheets.size) await retryFailed();
      const have2 = bakedVariantsOf(cfgId);
      return bakeRects(cfgId).every(r => have2.has(r.variant));
    }
    if (!missing.length) return true;
    if (!packFitsAtlas(cfgId, packScale(cfgId), missing)) {
      createAtlas();
      await rebuildAtlas(`make room for new ring size on "${cfgId}"`);
      if (failedSheets.size) await retryFailed();
      const have2 = bakedVariantsOf(cfgId);
      return bakeRects(cfgId).every(r => have2.has(r.variant));
    }
    bakeSheetPixels(cfgId, tex, missing, { append: true });
    atlasBaseTexture.update();
    if (booted) refreshUVs();
    console.log(`${MODULE_ID} | baked ${missing.length} new ring frame(s) for "${cfgId}"`);
    return true;
  })().finally(() => variantJobs.delete(cfgId));
  variantJobs.set(cfgId, job);
  return job;
}

function scheduleTokenRefresh(t) {
  ensureForToken(t).then(ok => {
    if (!ok) return;
    try { t.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
  });
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
  for (const t of canvas.tokens?.placeables ?? []) {
    try { t.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
  }
  // TokenConfig live-preview clones draw on top of the real token but are
  // not in the layer's placeables — left stale, they would keep sampling the
  // retired atlas (destroyed shortly after commit) and render as nothing
  for (const clone of canvas.tokens?._configPreview?.children ?? []) {
    try { clone?.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Eviction of unplaced packs                                         */
/* ------------------------------------------------------------------ */

function placedTokensUsePack(cfgId) {
  return tokensWearingCount(cfgId) > 0;
}

/** Number of placed tokens wearing a given pack (visible rings only). */
function tokensWearingCount(cfgId) {
  let n = 0;
  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.document?.ring?.enabled === false) continue;
    if (getEffectiveRingId(t.document) === cfgId) n++;
  }
  return n;
}

function unloadSheet(cfgId) {
  for (const key of sheetFrameIds.get(cfgId) ?? []) {
    delete atlasSheet.data.frames[key];
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
  lastUsed.delete(cfgId);
}

/** Re-blit all surviving packs onto a cleared atlas (avoids fragmentation). */
async function rebuildAtlas(reason) {
  if (!atlasCtx || rebuildInProgress) return;
  rebuildInProgress = true;
  const job = (async () => {
    atlasCtx.clearRect(0, 0, atlasW, atlasH);
    atlasSheet.data.frames = {};
    packX = 0; packY = 0; packRowH = 0;

    // Bake order: world default first, then most-recently-used survivors
    const survivors = [...materialized.keys()]
      .filter(id => id !== worldConfigId)
      .sort((a, b) => (lastUsed.get(b) ?? 0) - (lastUsed.get(a) ?? 0));
    const order = [worldConfigId, ...survivors].filter(Boolean).filter(id => materialized.has(id));

    for (const cfgId of order) {
      const src = sheetSources.get(cfgId);
      if (!src) { unloadSheet(cfgId); continue; }
      let tex = materialized.get(cfgId);
      if (!tex?.baseTexture?.valid) {
        try {
          src.imgPath ??= resolveImageURL(src);
          tex = await foundry.canvas.loadTexture(src.imgPath);
          if (!tex?.baseTexture?.valid) throw new Error("reload failed");
        } catch (e) {
          console.warn(`${MODULE_ID} | rebuild: cannot reload "${cfgId}", dropping`, e);
          failedSheets.add(cfgId);
          unloadSheet(cfgId);
          continue;
        }
      }
      if (!bakeSheetPixels(cfgId, tex, bakeRects(cfgId), { defer: true })) {
        warnCapacityOnce();
        failedSheets.add(cfgId);
        unloadSheet(cfgId);
      }
    }

    commitAtlas();
    console.log(`${MODULE_ID} | atlas rebuilt (${reason}); ${materialized.size} pack(s) baked`);
  })();
  rebuildPromise = job.finally(() => {});
  return job.finally(() => { rebuildInProgress = false; });
}

/**
 * Unload every pack that no placed token wears anymore, then compact the
 * atlas. Event-driven (scene changes, token/effect updates) instead of a slow
 * sweep, so a freed pack releases its memory right away.
 */
async function evictUnplaced(reason = "manual") {
  if (!booted) return;
  if (rebuildInProgress) {
    // Queue behind the running rebuild, then re-check
    return rebuildPromise.then(() => evictUnplaced(reason));
  }
  const victims = [...materialized.keys()].filter(id =>
    id !== worldConfigId
    && !pendingSheets.has(id) // don't yank packs that are mid-bake
    && !placedTokensUsePack(id));
  // Demand can also shrink without a pack leaving: a token got smaller, so
  // its variant or density cap dropped below what the atlas was planned for
  const overshot = [...materialized.keys()].filter(id =>
    (appliedScaleCaps.get(id) ?? 1) > packScaleCap(id) + 1e-6);
  if (!victims.length && !overshot.length) return;
  for (const v of victims) unloadSheet(v);
  // Re-plan instead of plain rebuild: freed budget steps remaining packs
  // back up toward their start quality and shrinks the atlas
  const reasonParts = [];
  if (victims.length) reasonParts.push(`evicted ${victims.join(", ")}`);
  if (overshot.length) reasonParts.push(`demand shrank for ${overshot.join(", ")}`);
  await replanAndRebuild(`${reasonParts.join("; ")} (${reason})`);
  // A pack finishing its bake while we ran would have been missed — re-check
  if ([...materialized.keys()].some(id => id !== worldConfigId && !placedTokensUsePack(id))) {
    scheduleEviction("post-eviction recheck");
  }
}

/** Debounced eviction so token bursts collapse into one rebuild. */
function scheduleEviction(reason) {
  if (!booted) return;
  clearTimeout(evictDebounce);
  evictDebounce = setTimeout(() => {
    evictDebounce = null;
    evictUnplaced(reason);
  }, EVICT_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* Console diagnostics API                                             */
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
  const inUse = planningSet();
  const rectsById = new Map(inUse.map(id => [id, bakeRects(id)]));
  const plannedPx = atlasCtx ? simulateHeight(atlasW, inUse, id => scaleAssignments.get(id) ?? 1, rectsById) : 0;
  const fullQualityPx = atlasCtx ? simulateHeight(atlasW, inUse, id => packStartScale(id), rectsById) : 0;

  const packList = [...sheetFrameIds.keys()].map(cfgId => {
    const tex = materialized.get(cfgId);
    const scale = scaleAssignments.get(cfgId) ?? packStartScale(cfgId);
    return {
      id: cfgId,
      label: packLabel(cfgId),
      state: packState(cfgId),
      scale: +scale.toFixed(2),
      startScale: +packStartScale(cfgId).toFixed(2),
      planned: scaleAssignments.has(cfgId),
      frames: sheetFrameIds.get(cfgId)?.size ?? 0,
      bakedSlots: sheetSlots.get(cfgId)?.length ?? 0,
      variants: variantLabel(cfgId),
      variantsAll: sheetSources.get(cfgId)?.variantCount ?? 0,
      cap: Math.round(100 * packScaleCap(cfgId)),
      tokens: tokensWearingCount(cfgId),
      sourceMB: tex ? +((tex.width * tex.height * 4) / (1024 * 1024)).toFixed(1) : 0,
      idleSec: lastUsed.has(cfgId) ? Math.round((Date.now() - lastUsed.get(cfgId)) / 1000) : null
    };
  });
  const degradedCount = packList.filter(p => p.scale < p.startScale - 1e-9).length;

  const renderer = canvas.app?.renderer;
  return {
    booted,
    enabled: isEnabled(),
    worldPack: worldConfigId,
    ringsIndexed: ringRegistry.length,
    atlas: {
      w: atlasW,
      h: atlasH,
      gpuMaxTextureSize: getMaxTextureSize(),
      megabytes: +(atlasPx * 4 / (1024 * 1024)).toFixed(1),
      slotCount,
      rowFill: atlasH ? Math.min(1, (packY + packRowH) / atlasH) : 0,
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
    failedIds: [...failedSheets],
    packList
  };
}

function printStatus() {
  const s = buildStatus();
  const pct = x => `${(100 * x).toFixed(0)}%`;
  console.group(`%c${MODULE_ID} | status${s.booted ? "" : " (NOT BOOTED)"}`, "font-weight:bold");
  console.log(`bake budget: automatic, ${s.packs.degraded} pack(s) degraded`);
  console.log(`atlas: ${s.atlas.w}x${s.atlas.h}px = ${s.atlas.megabytes} MB, GPU max texture ${s.atlas.gpuMaxTextureSize}px`);
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
async function retryFailed() {
  if (!atlasCtx) return console.warn(`${MODULE_ID} | atlas not created yet`);
  const ids = [...failedSheets];
  if (!ids.length) return console.log(`${MODULE_ID} | no failed packs to retry`);
  failedSheets.clear();
  capacityWarned = false;
  const results = {};
  // allowReplan: false — a retry right after a replan must not loop back
  // into replanning if the pack still doesn't fit
  for (const id of ids) results[id] = await materializeSheet(id, { allowReplan: false });
  console.table(Object.entries(results).map(([id, ok]) => ({ pack: id, baked: ok })));
  // Redraw tokens that were wearing a pack we just baked
  for (const t of canvas.tokens?.placeables ?? []) {
    if (ids.includes(getEffectiveRingId(t.document))) scheduleTokenRefresh(t);
  }
  return results;
}

Hooks.once("ready", () => {
  const api = {
    status: printStatus,
    packs: () => buildStatus().packList,
    retryFailed,
    evictNow: () => evictUnplaced("manual")
  };
  game.modules.get(MODULE_ID).api = api;
  window.MultipleRings = api; // convenience alias for console use
});

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
  }
}

function applyRingContextInner(token) {
  const doc = token?.document;
  const rid = getEffectiveRingId(doc);

  // Track usage so LRU never evicts live packs
  lastUsed.set(worldConfigId, Date.now());

  const packId = rid || worldConfigId;
  const worldBaked = worldConfigId ? bakedVariantsOf(worldConfigId) : null;

  if (packId && materialized.has(packId)) {
    lastUsed.set(packId, Date.now());
    // Resolve against baked variants only, so an unbaked size can never be
    // referenced — until its frames land, the closest baked one stands in.
    const have = bakedVariantsOf(packId);
    setAllowed(have.size ? have : null);
    const want = resolveVariantKey(packId, tokenRingSize(token));
    if (want && !have.has(want)) {
      ensureVariantsFor(packId).then(ok => {
        // Redraw only when the wanted variant actually got baked — otherwise
        // this draw would re-request it and loop the chain forever, hiding
        // the token the whole time
        if (!ok || !bakedVariantsOf(packId).has(want)) return;
        try { token.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
      });
    }
  } else {
    setAllowed(worldBaked?.size ? worldBaked : null);
    // Kick off lazy baking; the token redraws once ready
    if (rid && !failedSheets.has(rid) && booted && !rebuildInProgress && !pendingSheets.has(rid)) {
      if (!sheetFrameIds.has(rid) && !warnedUnknownPacks.has(rid)) {
        warnedUnknownPacks.add(rid);
        console.warn(`${MODULE_ID} | token "${token?.name ?? "?"}" requests unknown ring pack "${rid}" вЂ” using world default`);
      }
      materializeSheet(rid).then(ok => {
        // Same loop guard: a no-op bake (nobody wears the pack yet) must not
        // schedule another draw that would re-request it
        if (!ok || !materialized.has(rid) || !bakedVariantsOf(rid).size) return;
        try { token.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
      });
    }
  }
}

function featureDetect(TokenRing) {
  if (!TokenRing?.prototype
    || typeof TokenRing.prototype.configureSize !== "function"
    || typeof TokenRing.getRingDataBySize !== "function"
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
 */
function pickRingData(allowed, size) {
  if (!ringRegistry.length) return null;
  const tData = foundry.canvas.placeables.tokens.TokenRing.texturesData;
  let best = null, bestDist = Infinity;       // closest drawable
  let fallback = null, fallbackDist = Infinity; // closest at all (diagnostics)
  for (const r of ringRegistry) {
    if (allowed && !allowed.has(r.ringName)) continue;
    const d = Math.abs(r.gridTarget - size);
    const drawable = !tData || !!tData[r.ringName];
    if (drawable && (d < bestDist || best === null)) { best = r; bestDist = d; }
    if (!drawable && d < fallbackDist) { fallback = r; fallbackDist = d; }
  }
  if (best) return { ring: best, drawable: true };
  if (fallback) {
    if (!uvMismatchWarned) {
      uvMismatchWarned = true;
      console.warn(`${MODULE_ID} | resolved ring frame "${fallback.ringName}" is not in the renderer UV table yet — using the closest native resolution; this heals on the next redraw`);
    }
    return { ring: fallback, drawable: false };
  }
  return null;
}

function installLibWrapperPatches() {
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  libWrapper.register(MODULE_ID,
    "foundry.canvas.placeables.tokens.TokenRing.prototype.configureSize",
    function (wrapped, options) {
      const prev = currentAllowed();
      try {
        applyRingContext(this.token);
        return wrapped.call(this, options);
      } finally {
        setAllowed(prev);
      }
    }, "MIXED");

  libWrapper.register(MODULE_ID,
    "foundry.canvas.placeables.tokens.TokenRing.getRingDataBySize",
    function (wrapped, size) {
      const picked = pickRingData(currentAllowed(), Number.isFinite(size) ? size : 1);
      if (picked) return { ...picked.ring };
      return wrapped(size);
    }, "MIXED");
}

function installDirectPatches() {
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  if (TokenRing.prototype.__mringsDirect) return;
  TokenRing.prototype.__mringsDirect = true;

  const origConfigureSize = TokenRing.prototype.configureSize;
  TokenRing.prototype.configureSize = function (options = {}) {
    const prev = currentAllowed();
    try {
      applyRingContext(this.token);
      return origConfigureSize.call(this, options);
    } finally {
      setAllowed(prev);
    }
  };

  const origLookup = TokenRing.getRingDataBySize;
  TokenRing.getRingDataBySize = function (size) {
    const picked = pickRingData(currentAllowed(), Number.isFinite(size) ? size : 1);
    if (picked) return { ...picked.ring };
    return origLookup.call(this, size);
  };
}

function installPatches() {
  if (wrappersInstalled) return;
  if (!featureDetect(foundry.canvas?.placeables?.tokens?.TokenRing)) return;

  // NaN scaleCorrection (e.g. a config-preview clone whose subject texture
  // has not loaded yet) would scale UVs into NaN — a mesh that renders
  // nothing. Clamp to identity instead; it heals on the next draw.
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  const origGetUVs = TokenRing.getTextureUVs;
  TokenRing.getTextureUVs = function (name, scaleCorrection = 1) {
    return origGetUVs.call(this, name, Number.isFinite(scaleCorrection) ? scaleCorrection : 1);
  };

  if (window.libWrapper) {
    try {
      installLibWrapperPatches();
      wrappersInstalled = true;
      console.log(`${MODULE_ID} | patches installed via libWrapper`);
      return;
    } catch (e) {
      console.warn(`${MODULE_ID} | libWrapper registration failed, using direct patch`, e);
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
  if (booted || !isEnabled()) return;
  if (game.release.generation < 13) return;

  // Self-heal: reset internal config accidentally picked as world setting
  try {
    if (game.settings.get("core", "dynamicTokenRing") === MEGA_ID) {
      const coreSteel = foundry.canvas.placeables.tokens.TokenRingConfig
        ?.CORE_TOKEN_RINGS?.coreSteel?.id ?? "coreSteel";
      await game.settings.set("core", "dynamicTokenRing", coreSteel);
      console.log(`${MODULE_ID} | world ring setting pointed at internal config; reset to ${coreSteel}`);
    }
  } catch { /* noop */ }

  try {
    const ok = await preloadRegistries();
    if (!ok) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnNoSheets"));
      return;
    }

    // Never take over rendering with a substituted world pack: if the actual
    // world setting could not be indexed, staying native preserves its look.
    if (!sheetFrameIds.has(worldConfigId)) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
      console.warn(`${MODULE_ID} | world ring pack "${worldConfigId}" could not be indexed вЂ” staying on native rendering`);
      return;
    }

    createAtlas();

    // Bake the world-default sheet first вЂ” everything falls back to it
    const worldBaked = await materializeSheet(worldConfigId);
    if (!worldBaked) {
      ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
      return; // stay on native config
    }

    installPatches();
    if (!featureOK) return;

    CONFIG.Token.ring.useConfig(MEGA_ID);
    refreshUVs();

    booted = true;
    registerDaeIntegration(); // belt & braces if dae.ready raced ahead of us
    for (const t of canvas.tokens?.placeables ?? []) scheduleTokenRefresh(t);
  } catch (e) {
    console.error(`${MODULE_ID} | activation failed`, e);
    ui.notifications.warn(game.i18n.localize("MRINGS.WarnBuildFailed"));
  }
}

Hooks.once("canvasReady", activateFlow);

/* ------------------------------------------------------------------ */
/* Document hooks                                                     */
/* ------------------------------------------------------------------ */

Hooks.on("updateToken", (doc, changed) => {
  if (!booted) return;
  // A size change moves the token to a different ring size variant
  const resized = !!changed && ("width" in changed || "height" in changed);
  const touched =
    foundry.utils.hasProperty(doc, FLAG_PATH) ||
    foundry.utils.hasProperty(doc, `flags.${MODULE_ID}.-=ringAppearance`) ||
    foundry.utils.hasProperty(doc, "ring.enabled");
  if (!touched && !resized) return;
  // Resize in either direction changes the budget: growth may need new
  // variants, shrink frees the frames and density the token no longer needs
  if (touched || resized) scheduleEviction("token ring changed");
  const t = canvas.tokens?.get(doc.id);
  if (t) scheduleTokenRefresh(t);
});

Hooks.on("updateActor", (actor, changed) => {
  if (!booted) return;
  if (!foundry.utils.hasProperty(changed, `prototypeToken.flags.${MODULE_ID}`)) return;
  scheduleEviction("prototype ring changed");
  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.actor?.id === actor.id) scheduleTokenRefresh(t);
  }
});

Hooks.on("createToken", (doc) => {
  if (!booted) return;
  if (!getEffectiveRingId(doc)) return;
  const t = canvas.tokens?.get(doc.id);
  if (t) scheduleTokenRefresh(t);
});

Hooks.on("deleteToken", () => scheduleEviction("token deleted"));
Hooks.on("canvasReady", () => scheduleEviction("scene ready"));

/* --- ActiveEffect-driven rings ------------------------------------ */

function actorUsesRingEffects(effect) {
  return (effect.changes ?? []).some(c => c.key === FLAG_PATH);
}

for (const hook of ["createActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, (effect) => {
    if (!booted) return;
    const actor = effect?.parent;
    if (!actor) return;
    if (hook === "createActiveEffect" && !actorUsesRingEffects(effect)) return;
    if (hook === "deleteActiveEffect") scheduleEviction("effect removed");
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t.actor?.id === actor.id) scheduleTokenRefresh(t);
    }
  });
}

Hooks.on("updateActiveEffect", (effect, changes) => {
  if (!booted) return;
  const touchesRing =
    foundry.utils.hasProperty(changes, "changes") ||
    foundry.utils.hasProperty(changes, "disabled") ||
    actorUsesRingEffects(effect);
  if (!touchesRing) return;
  scheduleEviction("effect updated");
  const actor = effect?.parent;
  if (!actor) return;
  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.actor?.id === actor.id) scheduleTokenRefresh(t);
  }
});

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

    const doc = app.document ?? app.object ?? app.token ?? null;
    const currentValue = getEffectiveRingId(doc) ?? "";

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
    // live preview show the new ring immediately. Unapplied choices get
    // reclaimed by the eviction sweep like any other unworn pack.
    select.addEventListener("change", () => {
      const cfgId = select.value;
      if (!cfgId) return;
      if (!sheetSources.has(cfgId)) {
        console.warn(`${MODULE_ID} | ring "${cfgId}" is not indexed and cannot be baked — its sheet likely failed to load at startup (see earlier warnings)`);
        return;
      }
      // Defer past the form's own change handling so the preview clone
      // already carries the new choice when the wearer scan runs
      setTimeout(() => {
        ensureVariantsFor(cfgId).then(ok => {
          if (!ok) {
            console.warn(`${MODULE_ID} | pre-bake of "${cfgId}" failed; it will retry on apply`);
            return;
          }
          for (const clone of canvas.tokens?._configPreview?.children ?? []) {
            if (getEffectiveRingId(clone?.document) !== cfgId) continue;
            try { clone.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
          }
        });
      }, 0);
    });
    row.append(label, fields);

    // Note when an ActiveEffect currently overrides the choice
    const aeOverride = effectRingOverride(doc?.actor);
    if (aeOverride) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = `${game.i18n.localize("MRINGS.AEOverrideNote")} (${choices[aeOverride] ?? aeOverride})`;
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

function retryInject(app, element) {
  if (injectRingSelect(app, element)) return;
  requestAnimationFrame(() => {
    if (injectRingSelect(app, element)) return;
    setTimeout(() => injectRingSelect(app, element), 250);
  });
  try {
    const root = element instanceof HTMLElement ? element : element?.[0] ?? app?.element;
    if (!root?.querySelector) return;
    const obs = new MutationObserver(() => {
      if (injectRingSelect(app, root)) obs.disconnect();
    });
    obs.observe(root, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 4000);
  } catch { /* noop */ }
}

Hooks.on("renderTokenConfig", retryInject);
Hooks.on("renderPrototypeTokenConfig", retryInject);
