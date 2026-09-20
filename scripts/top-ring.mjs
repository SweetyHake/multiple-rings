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
 * baked into the combined atlas like any other companion (-bkg/-msk) and
 * drawn ABOVE the token subject.
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
 * Everything is created lazily via buildTopLayerClasses() — the classes
 * subclass core classes that are only addressed from the activation flow,
 * and a structural check on the core shader source falls back to "no top
 * layer" instead of rendering broken rings after a core change.
 */

const MODULE_ID = "multiple-rings";

/** Module-private effect bit, above core's 0x01..0x20 range. */
export const TOP_LAYER_EFFECT = 0x40;

/** Markers the core shader must contain for the copied GLSL below to be
 * considered in sync (a cheap structural diff against upstream edits). */
const FRAG_MARKERS = ["STATE_COLOR_OVER_SUBJECT", "rectangularMask", "colorizeTokenRing"];
const VERT_MARKERS = ["aTextureScaleCorrection", "aRingColorBand"];

export function buildTopLayerClasses() {
  const TokenRing = foundry.canvas.placeables.tokens.TokenRing;
  const NativeShader = foundry.canvas.rendering.shaders.TokenRingSamplerShader;

  const frag = String(NativeShader._batchFragmentShader ?? "");
  const vert = String(NativeShader._batchVertexShader ?? "");
  const inSync = FRAG_MARKERS.every(m => frag.includes(m)) && VERT_MARKERS.every(m => vert.includes(m));
  if ( !inSync ) {
    console.warn(`${MODULE_ID} | top layer disabled: the core TokenRingSamplerShader changed beyond recognition`);
    return null;
  }

  // Shadow atlas bind target. The batch plugin invokes copied statics
  // (like _preRenderBatch) with the plugin instance as the receiver, so
  // class private/static access is off-limits inside them — the state lives
  // in this closure instead and is swapped by setTopAtlas() at atlas commits.
  let topAtlas = null;
  let emptyTexture = null;
  const bindTarget = () => topAtlas ?? (emptyTexture ??= PIXI.BaseTexture.from(_emptyTopCanvas()));

  class TopRingSamplerShader extends NativeShader {

    /** @override — own batch plugin; geometry/vertex layout is core's */
    static classPluginName = "multipleRingsTopBatch";

    /**
     * Core's ring shader already uses all 16 vertex attribute slots WebGL
     * guarantees, so the overlay cannot travel as an attribute. Instead the
     * module maintains a shadow atlas of the same dimensions in which overlay
     * frames are baked at the SAME rects as their ring frames in the combined
     * atlas — the overlay is then sampled with the ring's own UVs
     * (vRingTextureCoord), which also makes it inherit every ring scale
     * correction for free.
     */
    static setTopAtlas(baseTexture) {
      topAtlas = baseTexture;
    }

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
      if ( this.__pluginInstalled ) return;
      const name = this.classPluginName;
      try {
        if ( !foundry.canvas.rendering.batching.BatchRenderer.hasPlugin(name) ) {
          PIXI.extensions.add({name, type: PIXI.ExtensionType.RendererPlugin, ref: this.createPlugin()});
        }
        const renderer = canvas.app?.renderer;
        if ( renderer && !renderer.plugins[name] ) {
          const pluginClass = PIXI.Renderer.__plugins[name];
          const plugin = new pluginClass(renderer);
          renderer.plugins[name] = plugin;
          plugin.contextChange();
        }
        this.__pluginInstalled = true;
      } catch (e) {
        console.warn(`${MODULE_ID} | top layer plugin installation failed — overlay stays off`, e);
      }
    }

    /** @override — bind the shadow atlas right after core binds the ring one */
    static _preRenderBatch(batchRenderer) {
      super._preRenderBatch(batchRenderer);
      const uniforms = batchRenderer._shader?.uniforms;
      if ( uniforms ) batchRenderer.renderer.texture.bind(bindTarget(), uniforms.mrTopTexture);
    }

    /* ---------------------------------------- */
    /*  GLSL                                    */
    /* ---------------------------------------- */

    /* The vertex body is inherited unchanged: the overlay reuses the ring's
     * own UV attribute, so no geometry or packing changes are needed. */

    /** @override — core's fragment body + the STATE_TOP_LAYER blend */
    static _batchFragmentShader = `
      ${this.CONSTANTS}
      ${this.PERCEIVED_BRIGHTNESS}

      in vec2 vRingTextureCoord;
      in vec2 vBackgroundTextureCoord;
      in vec2 vMaskTextureCoord;
      in vec2 vOrigTextureCoord;
      flat in vec3 vRingColor;
      flat in vec3 vBackgroundColor;
      flat in vec2 vScaleCorrection;
      flat in vec2 vRingColorBand;
      flat in uint vStates;

      uniform sampler2D tokenRingTexture;
      uniform sampler2D mrTopTexture;
      uniform float time;
      uniform bool debugColorBands;

      const uint STATE_RING_PULSE = 0x02U;
      const uint STATE_RING_GRADIENT = 0x04U;
      const uint STATE_BKG_WAVE = 0x08U;
      const uint STATE_INVISIBLE = 0x10U;
      const uint STATE_COLOR_OVER_SUBJECT = 0x20U;
      const uint STATE_TOP_LAYER = 0x40U;

      vec4 colorOverlay;

      /* -------------------------------------------- */

      bool hasState(in uint state) {
        return (vStates & state) == state;
      }

      /* -------------------------------------------- */

      vec2 rotation(in vec2 uv, in float angle) {
        uv -= 0.5;
        float s = sin(angle);
        float c = cos(angle);
        return uv * mat2(c, -s, s, c) + 0.5;
      }

      /* -------------------------------------------- */

      float normalizedCos(in float val) {
        return (cos(val) + 1.0) * 0.5;
      }

      /* -------------------------------------------- */

      float wave(in float dist) {
        return 0.5 * sin(-time * 4.0 + dist * 100.0) + 0.9;
      }

      /* -------------------------------------------- */

      vec4 blend(vec4 src, vec4 dst) {
        return src + (dst * (1.0 - src.a));
      }

      /* -------------------------------------------- */

      vec3 unpremultiplySafe(in vec4 c) {
        if ( c.a <= 0.0 ) return vec3(0.0);
        return min(c.rgb, vec3(c.a)) / c.a;
      }

      /* -------------------------------------------- */

      vec4 colorizeTokenRing(in vec4 tokenRing, in float dist) {
        vec3 tokenColor = unpremultiplySafe(tokenRing);

        // Sample the mask texture
        vec4 maskTex = texture(tokenRingTexture, vMaskTextureCoord);
        vec3 maskColor = unpremultiplySafe(maskTex);

        // Compute red channel based on mask if available, otherwise fall back to token color
        float redChannel = (maskTex.a > 0.0) ? maskColor.r : tokenColor.r;

        // Compute pulse factor, but only if the pulse state is active
        float pulseFactor = 1.0;
        if ( hasState(STATE_RING_PULSE) ) pulseFactor = cos(time * 2.0) * 0.325 + 0.675;

        // Compute the base pulse color
        vec3 pulseColor = vRingColor * redChannel * pulseFactor;

        // Compute gradient color if the gradient state is active
        vec3 gradientColor = pulseColor;
        if ( hasState(STATE_RING_GRADIENT) ) {
          // Calculate gradient mix based on rotation and time
          float gradientMix = smoothstep(0.0, 1.0, dot(rotation(vTextureCoord, time), vec2(0.5)));
          gradientColor = mix(pulseColor, vBackgroundColor * redChannel, gradientMix);
        }

        // Compute mixFactor based on ring color bands
        float mixFactor = step(vRingColorBand.x, dist) - step(vRingColorBand.y, dist);

        if ( hasState(STATE_COLOR_OVER_SUBJECT) ) {
          float mixAdjusted = mixFactor * tokenRing.a;
          if ( maskTex.a > 0.0 ) colorOverlay = vec4(gradientColor, 1.0) * maskTex.a;
          else colorOverlay = vec4(gradientColor, 1.0) * mixAdjusted;
          return tokenRing * (1.0 - mixAdjusted);
        }

        // Compute the final color by mixing tokenColor and gradientColor based on mixFactor
        vec4 finalColor = vec4(mix(tokenColor, gradientColor, mixFactor), 1.0) * tokenRing.a;

        // If mask is present, blend the final color with the mask color
        if ( maskTex.a > 0.0 ) finalColor = blend(vec4(gradientColor, 1.0) * maskTex.a, finalColor);
        return finalColor;
      }

      /* -------------------------------------------- */

      vec4 colorizeTokenBackground(in vec4 tokenBackground, in float dist) {
        // Pre-correct the background color for alpha if necessary
        vec3 bgColor = (tokenBackground.a > 0.0) ? tokenBackground.rgb / tokenBackground.a : tokenBackground.rgb;

        // Calculate the wave factor based on the state
        float waveFactor = hasState(STATE_BKG_WAVE) ? (0.5 + wave(dist) * 1.5) : 1.0;

        // Check if tint color is pure white (no tint)
        vec3 tintColor = vBackgroundColor.rgb;
        vec3 resultColor = bgColor;

        // Apply overlay blend mode only if tint is not white
        if ( tintColor != vec3(1.0, 1.0, 1.0) ) {
          // Overlay blend: vectorized for each RGB channel
          resultColor = mix(2.0 * bgColor * tintColor,
                            1.0 - 2.0 * (1.0 - bgColor) * (1.0 - tintColor),
                            step(0.5, bgColor));
        }

        // Return the final color with alpha and wave applied
        return vec4(resultColor, 1.0) * tokenBackground.a * waveFactor;
      }

      /* -------------------------------------------- */

      vec4 processTokenColor(in vec4 finalColor) {
        if ( !hasState(STATE_INVISIBLE) ) return finalColor;

        // Computing halo
        float lum = perceivedBrightness(unpremultiplySafe(finalColor));
        vec3 haloColor = vec3(lum) * vec3(0.5, 1.0, 1.0);

        // Construct final image
        return vec4(haloColor, 1.0) * finalColor.a
                     * (0.55 + normalizedCos(time * 2.0) * 0.25);
      }

      /* -------------------------------------------- */

      float getTokenTextureClip() {
        // Check if both x and y coordinates are within the [0.0, 1.0] range
        return step(0.0, vTextureCoord.x) * step(0.0, vTextureCoord.y) *
               step(vTextureCoord.x, 1.0) * step(vTextureCoord.y, 1.0);
      }

      /* -------------------------------------------- */

      vec4 _main() {
        vec4 color;
        vec4 result;

        %forloop%

        // Compute distances for further processing
        vec2 scaledDistVec = (vOrigTextureCoord - 0.5) * 2.0 * vScaleCorrection;
        float dist = length(scaledDistVec);  // Euclidean distance

        // Rectangular mask to not bleed over other spritesheet assets
        float rectangularMask = step(max(abs(scaledDistVec.x), abs(scaledDistVec.y)), 1.0);

        // Clip token texture to handle padding on X/Y axis
        color *= getTokenTextureClip();

        // Precompute alpha-adjusted color (avoid division by 0)
        vec4 alphaAdjustedColor = (vColor.a > 0.0) ? (color * (vColor / vColor.a)) : vec4(0.0);

        // Process token color using a custom function
        vec4 processedColor = processTokenColor(alphaAdjustedColor);

        // Blend token texture, token ring, and token background
        vec4 ringColor = colorizeTokenRing(texture(tokenRingTexture, vRingTextureCoord), dist);
        vec4 backgroundColor = colorizeTokenBackground(texture(tokenRingTexture, vBackgroundTextureCoord), dist);
        vec4 blendedResult = blend(processedColor, blend(ringColor, backgroundColor) * rectangularMask);

        // Apply color overlay if the state is active
        if ( hasState(STATE_COLOR_OVER_SUBJECT) ) blendedResult = blend(colorOverlay * rectangularMask, blendedResult);

        // Top layer: ring-sheet frame drawn ABOVE the subject. The shadow
        // atlas stores overlay frames at the same rects as the combined
        // atlas, so the ring's own UVs address it. Overlay art is authored
        // neutral and is multiplied by the ring color, so it matches the
        // tinted band (pulse/gradient do not apply to it). Premultiply to
        // feed the same src-over chain core uses for its mask colorOverlay.
        if ( hasState(STATE_TOP_LAYER) ) {
          vec4 topColor = texture(mrTopTexture, vRingTextureCoord);
          topColor = vec4(topColor.rgb * vRingColor, topColor.a);
          blendedResult = blend(vec4(topColor.rgb, 1.0) * (topColor.a * rectangularMask), blendedResult);
        }

        // Apply final alpha adjustment
        result = blendedResult * vColor.a;

        if ( debugColorBands ) {
          vec2 debugDistVec = (vTextureCoord - 0.5) * 2.0 * vScaleCorrection;
          float debugDist = length(debugDistVec);
          result.rgb += vec3(0.0, 0.5, 0.0) * (step(vRingColorBand.x, debugDist) - step(vRingColorBand.y, debugDist));
        }
        return result;
      }
    `;
  }

  /* The top layer deliberately does NOT subclass TokenRing: core recreates
   * ring instances only when `!hasDynamicRing`, so any token drawn before
   * activation would keep a native instance forever and never gain the
   * top-layer bit. Instead the bit and the topName reset are installed on
   * TokenRing.prototype by installPatches() in main.js — they work on every
   * instance regardless of when it was created. */

  return {TopRingSamplerShader, setTopAtlas: t => { topAtlas = t; }};
}

/** 1×1 transparent canvas backing the shader's fallback bind target. */
function _emptyTopCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c;
}
