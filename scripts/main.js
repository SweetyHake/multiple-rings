const MODULE_ID = "multiple-rings";
const RING_SELECT_ID = "multiple-rings-appearance-select";
const FLAG_PATH = `flags.${MODULE_ID}.ringAppearance`;
const MEGA_ID = "mringsCombinedRings";
const MEGA_SHEET_KEY = "multiple-rings-combined.json";

// Eviction tuning
const EVICT_SWEEP_MS = 60_000;        // sweep interval
const EVICT_IDLE_MS = 5 * 60_000;     // evict packs unused for 5 minutes

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
let evictTimer = null;
const warnedUnknownPacks = new Set();

// Metadata registry built from JSONs only (no images needed)
// key = "<cfgId>:<frameName>"
const ringRegistry = [];
const sheetFrameIds = new Map();   // cfgId -> Set<prefixed keys>
const sheetSources = new Map();    // cfgId -> { imgPath, rects, config }
const materialized = new Map();    // cfgId -> PIXI.Texture (source image, kept while baked)
const failedSheets = new Set();
const pendingSheets = new Map();   // cfgId -> Promise<boolean>
const sheetSlots = new Map();      // cfgId -> [{key,x,y,w,h}]
const lastUsed = new Map();        // cfgId -> Date.now()

// Atlas packing state
let atlasCanvas = null;
let atlasCtx = null;
let atlasBaseTexture = null;
let atlasSheet = null;
let atlasW = 2048;
let atlasH = 1024;
let activeScale = 1; // resolved at createAtlas: auto or manual override
let packX = 0, packY = 0, packRowH = 0;

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

  // Per-client bake quality. "auto" picks the highest quality that fits every
  // indexed ring pack within this device's GPU texture limit; rendering happens
  // locally, so this is deliberately a client choice rather than a world one.
  game.settings.register(MODULE_ID, "bakeScale", {
    name: "MRINGS.SettingBakeScaleName",
    hint: "MRINGS.SettingBakeScaleHint",
    scope: "client",
    config: true,
    default: "auto",
    type: String,
    choices: {
      auto: "Auto",
      1: "100%",
      0.75: "75%",
      0.5: "50%"
    },
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

/** Manual override from settings; null = auto. */
function settingBakeScale() {
  try {
    const v = game.settings.get(MODULE_ID, "bakeScale") ?? "auto";
    if (v === "auto") return null;
    const n = Number(v);
    return (n > 0 && n <= 1) ? n : null;
  } catch {
    return null;
  }
}

/** Slot size for a source frame after applying the resolved bake scale. */
function scaledFrameSize(fr) {
  return {
    w: Math.max(1, Math.round(fr.w * activeScale)),
    h: Math.max(1, Math.round(fr.h * activeScale))
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

function getRingChoices() {
  const ring = globalThis.CONFIG?.Token?.ring;
  if (!ring) return {};
  const out = {};
  try {
    for (const id of ring.configIDs ?? []) {
      if (id === MEGA_ID) continue;
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
  ui.notifications.warn(game.i18n.localize("MRINGS.WarnCapacity"));
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

      // Remember raw locations; image URL is resolved lazily per pack
      const src = {
        imgPath: null,
        rects,
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

  // Resolve which config the world actually uses; fall back to first known
  worldConfigId ??= ring.id;
  const worldIndexed = sheetFrameIds.has(worldConfigId);
  console.log(`${MODULE_ID} | world ring setting "${worldConfigId}" ${worldIndexed ? "indexed" : "NOT indexed"}; ` +
    `indexed packs: ${[...sheetFrameIds.keys()].join(", ") || "(none)"}`);
  if (!worldIndexed) {
    worldConfigId = sheetFrameIds.keys().next().value ?? null;
  }

  console.log(`${MODULE_ID} | indexed ${sheetSources.size} ring sheets, ${ringRegistry.length} rings`);
  return sheetSources.size > 0 && worldConfigId != null;
}

function simulateHeight(width, scale) {
  let px = 0, py = 0, rh = 0;
  for (const src of sheetSources.values()) {
    for (const r of src.rects) {
      const w = Math.max(1, Math.round(r.data.frame.w * scale));
      const h = Math.max(1, Math.round(r.data.frame.h * scale));
      if (px + w > width) { px = 0; py += rh; rh = 0; }
      px += w;
      rh = Math.max(rh, h);
    }
  }
  return py + rh;
}

function createAtlas() {
  const maxTex = getMaxTextureSize();
  const manual = settingBakeScale();
  const candidates = manual != null ? [manual] : [1, 0.75, 0.5];

  // Pick the highest quality whose full layout fits the GPU texture limit.
  // If none fits (auto mode), fall back to the smallest candidate at max width вЂ”
  // lazy baking + per-pack graceful fallback handle any remaining overflow.
  atlasW = Math.min(2048, maxTex);
  activeScale = candidates[candidates.length - 1];
  for (const s of candidates) {
    let w = Math.min(2048, maxTex);
    let needed = simulateHeight(w, s);
    if (needed > maxTex && w < maxTex) { w = maxTex; needed = simulateHeight(w, s); }
    if (needed <= maxTex) { activeScale = s; atlasW = w; break; }
    if (manual == null) { activeScale = s; atlasW = w; } // remember widest attempt
  }

  const needed = simulateHeight(atlasW, activeScale);
  atlasH = Math.min(Math.max(1, Math.ceil(needed)), maxTex);
  console.log(`${MODULE_ID} | bake scale ${activeScale} (${manual != null ? "manual" : "auto"}), ` +
    `atlas ${atlasW}x${atlasH}, GPU limit ${maxTex}`);

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

/** Draw one sheet's frames into the atlas and register their textures. */
function bakeSheetPixels(cfgId, tex) {
  const src = sheetSources.get(cfgId);
  if (!src || !atlasCtx) return false;
  const source = tex.baseTexture.resource.source;
  const slots = [];
  let bakedAny = false;

  for (const r of src.rects) {
    const fr = r.data.frame;
    const { w: dw, h: dh } = scaledFrameSize(fr);
    const slot = allocSlot(dw, dh);
    if (!slot) { warnCapacityOnce(); break; }
    atlasCtx.drawImage(source, fr.x, fr.y, fr.w, fr.h, slot.x, slot.y, dw, dh);
    const extra = Object.fromEntries(Object.entries(r.data).filter(([k]) => META_KEYS.includes(k)));
    atlasSheet.data.frames[r.key] = frameEntry(fr, slot, dw, dh, extra);
    PIXI.Assets.cache.set(
      r.key,
      new PIXI.Texture(atlasBaseTexture, new PIXI.Rectangle(slot.x, slot.y, dw, dh))
    );
    slots.push({ key: r.key, ...slot, w: dw, h: dh });
    bakedAny = true;
  }

  sheetSlots.set(cfgId, slots);
  return bakedAny;
}

async function materializeSheet(cfgId) {
  if (materialized.has(cfgId)) return Promise.resolve(true);
  if (failedSheets.has(cfgId)) return Promise.resolve(false);
  if (pendingSheets.has(cfgId)) return pendingSheets.get(cfgId);
  if (rebuildInProgress) {
    // Queue behind the running rebuild, then retry normally
    return rebuildPromise.then(() => materializeSheet(cfgId));
  }

  const job = (async () => {
    const src = sheetSources.get(cfgId);
    const cfg = CONFIG.Token.ring.getConfig(cfgId);
    if (!src || !atlasCtx) { failedSheets.add(cfgId); return false; }
    try {
      let tex = materialized.get(cfgId);
      if (!tex) {
        src.imgPath ??= resolveImageURL(src);
        tex = await loadTexture(src.imgPath);
        if (!tex?.baseTexture?.valid) throw new Error(`image load failed: ${src.imgPath}`);
      }
      const ok = bakeSheetPixels(cfgId, tex);
      if (!ok) { failedSheets.add(cfgId); return false; }
      materialized.set(cfgId, tex);
      lastUsed.set(cfgId, Date.now());
      atlasBaseTexture.update();

      if (booted) refreshUVs();
      console.log(`${MODULE_ID} | baked ring sheet "${cfgId}"`);
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

function ensureForDoc(doc) {
  const rid = getEffectiveRingId(doc);
  if (!rid || rid === worldConfigId) return Promise.resolve(true);
  return materializeSheet(rid);
}

function scheduleTokenRefresh(t) {
  ensureForDoc(t.document).then(ok => {
    if (!ok) return;
    try { t.renderFlags?.set({ redraw: true }); } catch { /* noop */ }
  });
}

function refreshUVs() {
  try { foundry.canvas.placeables.tokens.TokenRing.createAssetsUVs(); } catch (e) {
    console.warn(`${MODULE_ID} | createAssetsUVs failed`, e);
  }
}

/* ------------------------------------------------------------------ */
/* LRU eviction                                                       */
/* ------------------------------------------------------------------ */

function placedTokensUsePack(cfgId) {
  for (const t of canvas.tokens?.placeables ?? []) {
    if (getEffectiveRingId(t.document) === cfgId) return true;
  }
  return false;
}

function unloadSheet(cfgId) {
  for (const key of sheetFrameIds.get(cfgId) ?? []) {
    delete atlasSheet.data.frames[key];
    try { PIXI.Assets.cache.delete(key); } catch { /* noop */ }
  }
  materialized.delete(cfgId);
  sheetSlots.delete(cfgId);
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
          tex = await loadTexture(src.imgPath);
          if (!tex?.baseTexture?.valid) throw new Error("reload failed");
        } catch (e) {
          console.warn(`${MODULE_ID} | rebuild: cannot reload "${cfgId}", dropping`, e);
          failedSheets.add(cfgId);
          unloadSheet(cfgId);
          continue;
        }
      }
      if (!bakeSheetPixels(cfgId, tex)) {
        warnCapacityOnce();
        failedSheets.add(cfgId);
        unloadSheet(cfgId);
      }
    }

    atlasBaseTexture.update();
    if (booted) refreshUVs();
    console.log(`${MODULE_ID} | atlas rebuilt (${reason}); ${materialized.size} pack(s) baked`);
  })();
  rebuildPromise = job.finally(() => {});
  return job.finally(() => { rebuildInProgress = false; });
}

function startEvictionSweep() {
  clearInterval(evictTimer);
  evictTimer = setInterval(async () => {
    if (!booted || rebuildInProgress) return;
    const now = Date.now();
    const victims = [...materialized.keys()].filter(id =>
      id !== worldConfigId
      && now - (lastUsed.get(id) ?? 0) > EVICT_IDLE_MS
      && !placedTokensUsePack(id));
    if (!victims.length) return;
    for (const v of victims) unloadSheet(v);
    await rebuildAtlas(`evicted ${victims.join(", ")}`);
  }, EVICT_SWEEP_MS);
}

/* ------------------------------------------------------------------ */
/* Runtime wrappers (libWrapper with direct fallback)                 */
/* ------------------------------------------------------------------ */

/** Compute + install the allowed-frame context for a token being drawn. */
function applyRingContext(token) {
  const doc = token?.document;
  const rid = getEffectiveRingId(doc);

  // Track usage so LRU never evicts live packs
  lastUsed.set(worldConfigId, Date.now());

  if (rid && materialized.has(rid)) {
    lastUsed.set(rid, Date.now());
    setAllowed(sheetFrameIds.get(rid) ?? null);
  } else {
    setAllowed(sheetFrameIds.get(worldConfigId) ?? null);
    // Kick off lazy baking; the token redraws once ready
    if (rid && !failedSheets.has(rid) && booted && !rebuildInProgress && !pendingSheets.has(rid)) {
      if (!sheetFrameIds.has(rid) && !warnedUnknownPacks.has(rid)) {
        warnedUnknownPacks.add(rid);
        console.warn(`${MODULE_ID} | token "${token?.name ?? "?"}" requests unknown ring pack "${rid}" вЂ” using world default`);
      }
      materializeSheet(rid).then(ok => {
        if (!ok) return;
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
      const allowed = currentAllowed();
      if (allowed && ringRegistry.length) {
        const candidates = ringRegistry
          .filter(r => allowed.has(r.ringName))
          .map(r => [Math.abs(r.gridTarget - size), r])
          .sort((a, b) => a[0] - b[0]);
        const chosen = candidates[0]?.[1];
        if (chosen) return { ...chosen };
      }
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
    const allowed = currentAllowed();
    if (allowed && ringRegistry.length) {
      const candidates = ringRegistry
        .filter(r => allowed.has(r.ringName))
        .map(r => [Math.abs(r.gridTarget - size), r])
        .sort((a, b) => a[0] - b[0]);
      const chosen = candidates[0]?.[1];
      if (chosen) return { ...chosen };
    }
    return origLookup.call(this, size);
  };
}

function installPatches() {
  if (wrappersInstalled) return;
  if (!featureDetect(foundry.canvas?.placeables?.tokens?.TokenRing)) return;

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
    startEvictionSweep();
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

Hooks.on("updateToken", (doc) => {
  if (!booted) return;
  const touched =
    foundry.utils.hasProperty(doc, FLAG_PATH) ||
    foundry.utils.hasProperty(doc, `flags.${MODULE_ID}.-=ringAppearance`) ||
    foundry.utils.hasProperty(doc, "ring.enabled");
  if (!touched) return;
  const t = canvas.tokens?.get(doc.id);
  if (t) scheduleTokenRefresh(t);
});

Hooks.on("updateActor", (actor, changed) => {
  if (!booted) return;
  if (!foundry.utils.hasProperty(changed, `prototypeToken.flags.${MODULE_ID}`)) return;
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

    const choices = getRingChoices();
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
