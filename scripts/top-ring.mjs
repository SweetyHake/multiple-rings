/* ------------------------------------------------------------------ */
/* Top layer ("two-layer token")                                      */
/* ------------------------------------------------------------------ */

/**
 * A third drawing layer for ring tokens: ring < subject < TOP.
 *
 * The overlay art lives in the ring pack sheet itself, declared in a
 * `config.overlays` block mapping a base frame name to an extra frame rect
 * of the same sheet image:
 *
 *   "config": {
 *     "overlays": { "dnd5e-med": { "frame": {"x":0, "y":1024, "w":512, "h":512} } }
 *   }
 *
 * Neither PIXI nor the core ring renderer read that block, so with the
 * module disabled the sheet renders a perfectly normal ring and the overlay
 * pixels are simply ignored. With the module enabled, the overlay frames are
 * baked into a shadow atlas and drawn ABOVE the token subject.
 *
 * Rendering goes through the framework slot core provides for this exact
 * purpose (`DynamicRingData.framework.{ringClass,shaderClass}`). Core's ring
 * shader already occupies all 16 vertex attribute slots WebGL guarantees, so
 * the overlay cannot travel as a new attribute: the module bakes overlay
 * frames into a shadow atlas at the SAME rects as their ring frames in the
 * combined atlas, and the shader subclass adds one sampler uniform addressed
 * with the ring's own UVs. Tokens without an overlay pack the state bit off
 * and never touch the sampler.
 *
 * The fragment shader is NOT a copy of core's: it is derived at runtime from
 * the live core source by injecting three small snippets at well-known
 * anchors. Core fixes therefore carry over automatically, and when an anchor
 * disappears (core changed beyond recognition) the top layer is disabled
 * instead of rendering broken rings.
 */

const MODULE_ID = "multiple-rings";

/** Module-private effect bit, above core's 0x01..0x20 range. */
export const TOP_LAYER_EFFECT = 0x40;

/** Fragment injections: [anchor regex, replacement builder]. Every anchor
 * must match exactly once or the top layer stays off. */
const FRAG_INJECTIONS = [
  // Extra sampler, declared next to core's ring sampler
  [/uniform\s+sampler2D\s+tokenRingTexture\s*;/,
    m => `${m}\n    uniform sampler2D mrTopTexture;`],
  // Module state bit, declared next to core's last state constant
  [/const\s+uint\s+STATE_COLOR_OVER_SUBJECT\s*=\s*0x20U\s*;/,
    m => `${m}\n    const uint STATE_TOP_LAYER = ${`0x${TOP_LAYER_EFFECT.toString(16)}`}U;`],
  // Top-layer blend, right before core's final alpha adjustment (or a
  // token-shader wrapper such as Showstopper's ssApplyTokenShader(blendedResult, ...)
  // when another module patched TokenRingSamplerShader before us)
  [/result\s*=\s*(?:blendedResult|[A-Za-z_]\w*\s*\(\s*blendedResult\b[^;]*\))\s*\*\s*vColor\.a\s*;/,
    m => `
    // Top layer: ring-sheet frame drawn ABOVE the ring, all its effects, and
    // the subject. The shadow atlas stores overlay frames at the same rects as
    // the combined atlas, so the ring's own UVs address it. Dynamic ring colors
    // and effects (vRingColor, vBackgroundColor, flashColor, pulse, gradient,
    // wave, colorOverSubject) never touch the overlay; PIXI mesh tint (vColor)
    // and worldAlpha (vColor.a) apply to it identically to the token subject.
    if ( hasState(STATE_TOP_LAYER) ) {
      vec4 mrTop = texture(mrTopTexture, vRingTextureCoord);
      vec4 mrTopPremul = vec4(unpremultiplySafe(mrTop), 1.0) * (mrTop.a * rectangularMask);
      vec4 mrTopTinted = (vColor.a > 0.0) ? (mrTopPremul * (vColor / vColor.a)) : vec4(0.0);
      blendedResult = blend(mrTopTinted, blendedResult);
    }
    ${m}`]
];

/** Symbols the injected code relies on. */
const FRAG_REQUIRED = [
  "hasState", "blend(", "unpremultiplySafe", "rectangularMask",
  "vRingTextureCoord", "vColor", "blendedResult"
];

/**
 * Derive the top-layer fragment shader from core's, or null when the core
 * source no longer has the expected structure.
 * @param {string} frag
 * @returns {string|null}
 */
function deriveFragmentShader(frag) {
  if (!frag || !FRAG_REQUIRED.every(s => frag.includes(s))) return null;
  let out = frag;
  for (const [re, build] of FRAG_INJECTIONS) {
    const global = new RegExp(re.source, "g");
    const hits = out.match(global);
    if (!hits || hits.length !== 1) return null;
    out = out.replace(re, m => build(m));
  }
  return out;
}

export function buildTopLayerClasses() {
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  const NativeShader = foundry.canvas.rendering.shaders.TokenRingSamplerShader;

  // The private bit must not collide with an effect core (or a system) added
  const usedBits = Object.values(TokenRing?.effects ?? {}).reduce((acc, v) => acc | (Number(v) || 0), 0);
  if (usedBits & TOP_LAYER_EFFECT) {
    console.warn(`${MODULE_ID} | top layer disabled: effect bit 0x${TOP_LAYER_EFFECT.toString(16)} is already used by core`);
    return null;
  }

  const fragment = deriveFragmentShader(String(NativeShader?._batchFragmentShader ?? ""));
  if (!fragment) {
    console.warn(`${MODULE_ID} | top layer disabled: the core TokenRingSamplerShader changed beyond recognition`);
    return null;
  }

  // Shadow atlas bind target. The batch plugin invokes copied statics
  // (like _preRenderBatch) with the plugin instance as the receiver, so
  // class private/static access is off-limits inside them — the state lives
  // in this closure instead and is swapped by setTopAtlas() at atlas commits.
  let topAtlas = null;
  let emptyTexture = null;
  const bindTarget = () => {
    if (topAtlas && !topAtlas.destroyed) return topAtlas;
    return (emptyTexture ??= PIXI.BaseTexture.from(_emptyTopCanvas()));
  };

  class TopRingSamplerShader extends NativeShader {

    /** @override — own batch plugin; geometry/vertex layout is core's */
    static classPluginName = "multipleRingsTopBatch";

    /** @override — one extra texture unit for the shadow atlas (core: occlusion + ring) */
    static reservedTextureUnits = NativeShader.reservedTextureUnits + 1;

    /** True once the batch plugin has been installed on the live renderer. */
    static __pluginInstalled = false;

    /** @override */
    static batchDefaultUniforms(maxTex) {
      return {
        ...super.batchDefaultUniforms(maxTex),
        mrTopTexture: maxTex + NativeShader.reservedTextureUnits
      };
    }

    /**
     * Install this shader's batch plugin. Core registers ring plugins before
     * the PIXI.Application exists; this module activates on canvasReady,
     * when the plugin map of the running renderer is already frozen — so the
     * instance is added by hand (exactly what PluginSystem.init would have
     * done: the constructor self-registers on the contextChange runner).
     */
    static ensurePlugin() {
      const name = this.classPluginName;
      const renderer = globalThis.canvas?.app?.renderer;
      if ( this.__pluginInstalled && (!renderer || renderer.plugins[name]) ) return true;
      try {
        const BatchRenderer = foundry.canvas?.rendering?.batching?.BatchRenderer;
        if ( !BatchRenderer ) return false;
        if ( !BatchRenderer.hasPlugin(name) ) {
          this.initializeBatchGeometry?.();
          PIXI.extensions.add({name, type: PIXI.ExtensionType.RendererPlugin, ref: this.createPlugin()});
        }
        if ( renderer ) {
          if ( !renderer.plugins[name] ) {
            const pluginClass = PIXI.Renderer.__plugins[name];
            if ( !pluginClass ) return false;
            const plugin = new pluginClass(renderer);
            renderer.plugins[name] = plugin;
            plugin.contextChange();
            plugin.onPrerender?.();
          }
          this.__pluginInstalled = true;
        }
        return true;
      } catch (e) {
        console.warn(`${MODULE_ID} | top layer plugin installation failed — overlay stays off`, e);
        return false;
      }
    }

    /** @override — bind the shadow atlas right after core binds the ring one */
    static _preRenderBatch(batchRenderer) {
      super._preRenderBatch(batchRenderer);
      const unit = batchRenderer.uniforms?.mrTopTexture ?? batchRenderer._shader?.uniforms?.mrTopTexture;
      if ( unit !== undefined ) batchRenderer.renderer.texture.bind(bindTarget(), unit);
    }

    /* The vertex body is inherited unchanged: the overlay reuses the ring's
     * own UV attribute, so no geometry or packing changes are needed. */

    /** @override — core's live fragment source + the STATE_TOP_LAYER blend */
    static _batchFragmentShader = fragment;
  }

  // If NativeShader was already patched in-place by Showstopper before
  // deriveFragmentShader ran, `fragment` already includes its GLSL helpers —
  // mark TopRingSamplerShader with its own flag so Showstopper's addConfig /
  // useConfig hooks do not inject those helpers a second time.
  if (Object.prototype.hasOwnProperty.call(NativeShader, "__showstopperRingPatched")) {
    Object.defineProperty(TopRingSamplerShader, "__showstopperRingPatched", {
      value: true,
      configurable: true
    });
  }

  /* The top layer deliberately does NOT subclass TokenRing: core recreates
   * ring instances only when `!hasDynamicRing`, so any token drawn before
   * activation would keep a native instance forever and never gain the
   * top-layer bit. Instead the bit and the topName reset are installed on
   * TokenRing.prototype by installPatches() in main.js — they work on every
   * instance regardless of when it was created. */

  // Register the PIXI extension early (during initializeDynamicTokenRingConfig,
  // before PIXI.Application is created) so PIXI's PluginSystem wires all
  // renderer runners natively; ensurePlugin() remains a fallback for late
  // registration.
  TopRingSamplerShader.ensurePlugin();

  return {TopRingSamplerShader, setTopAtlas: t => { topAtlas = t ?? null; }};
}

/** 1×1 transparent canvas backing the shader's fallback bind target. */
function _emptyTopCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c;
}
