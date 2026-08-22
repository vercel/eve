"use client";

import { useEffect, useRef, type JSX } from "react";
import * as THREE from "three/webgpu";
// Type-only import — erased at compile time so the lil-gui package never
// enters the production runtime bundle. The actual module is loaded via
// dynamic import() inside the debug useEffect, which is gated on `?debug`.
import type GUIType from "lil-gui";
import {
  attribute,
  cameraProjectionMatrix,
  exp,
  float,
  int,
  length,
  mix,
  modelViewMatrix,
  mx_fractal_noise_float,
  positionLocal,
  pow,
  screenDPR,
  sin,
  texture as tslTexture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { rgbLogoSvgString } from "./rgb-logo";
import { rasterizeSvgToTexture } from "./rasterize-svg-to-texture";

// ---- Sky (celestial sphere) parameters ----
// All stars live on a sphere centered on the camera at the origin.
// Two populations:
//   - band: dense Milky Way streak (sech² latitude bias around galactic equator)
//   - field: uniform sphere distribution (the rest of the night sky)
type SkyParams = {
  bandCount: number;
  fieldCount: number;
  sphereRadius: number;
  bandThickness: number; // sech² scale in radians of latitude
  brightFraction: number; // fraction of stars rendered noticeably larger
  band2Offset: number; // radians of latitude offset for the second parallel band
};

const DEFAULT_PARAMS: SkyParams = {
  bandCount: 70_000,
  fieldCount: 6_000,
  sphereRadius: 300,
  bandThickness: 0.07,
  brightFraction: 0.1,
  band2Offset: -0.175,
};

const BAND_BLUE: [number, number, number] = [0.75, 0.85, 1.0];
const BAND_WHITE: [number, number, number] = [1.0, 0.95, 0.85];
const FIELD_WHITE: [number, number, number] = [0.95, 0.95, 0.95];

function sampleSech2(scale: number): number {
  const u = Math.random();
  const t = Math.max(-0.995, Math.min(0.995, 2 * u - 1));
  return scale * Math.atanh(t);
}

function writeStar(
  i: number,
  positions: Float32Array,
  colors: Float32Array,
  scales: Float32Array,
  flags: Float32Array,
  x: number,
  y: number,
  z: number,
  baseColor: [number, number, number],
  scale: number,
  flag: number,
): void {
  positions[i * 3 + 0] = x;
  positions[i * 3 + 1] = y;
  positions[i * 3 + 2] = z;
  const cv = 0.85 + Math.random() * 0.3;
  colors[i * 3 + 0] = baseColor[0] * cv;
  colors[i * 3 + 1] = baseColor[1] * cv;
  colors[i * 3 + 2] = baseColor[2] * cv;
  scales[i] = scale;
  flags[i] = flag;
}

function pickStarScale(p: SkyParams, base: number, range: number): number {
  if (Math.random() < p.brightFraction) {
    // A handful of bright "foreground" stars per generation.
    return 1.8 + Math.random() * 2.2;
  }
  return base + Math.random() * range;
}

// Per-star twinkle is driven by two static random sine frequencies. Picking
// frequencies in this range (rad/sec, since the shader does sin(time * freq))
// yields beat envelopes in the ~1.5–4 s window — slow enough to feel like
// real stars, not flicker. The two-sine product creates a non-periodic
// envelope per star with no extra runtime cost beyond two sin() calls.
const TWINKLE_FREQ_MIN = 1.5;
const TWINKLE_FREQ_MAX = 10.0;

function buildSkyAttributes(p: SkyParams): {
  positions: Float32Array;
  colors: Float32Array;
  scales: Float32Array;
  flags: Float32Array;
  twinkles: Float32Array;
} {
  // Two bands of bandCount stars each, plus the diffuse field.
  const N = p.bandCount * 2 + p.fieldCount;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const scales = new Float32Array(N);
  // flags[i] = 1.0 for band stars (cluster noise modulates them),
  //          = 0.0 for field stars (always full opacity).
  const flags = new Float32Array(N);
  // twinkles[i*2..i*2+1] = two static random sine frequencies per star.
  const twinkles = new Float32Array(N * 2);
  const R = p.sphereRadius;

  let idx = 0;

  // Generates one band centered on a given latitude offset. Reused for both
  // the primary band (offset = 0) and the secondary parallel band.
  const writeBand = (latitudeOffset: number): void => {
    for (let i = 0; i < p.bandCount; i++) {
      const b = sampleSech2(p.bandThickness) + latitudeOffset; // latitude (rad)
      const l = Math.random() * Math.PI * 2; // longitude (rad)
      const cosB = Math.cos(b);
      const sinB = Math.sin(b);
      const x = R * cosB * Math.cos(l);
      const y = R * sinB;
      const z = R * cosB * Math.sin(l);
      const color = Math.random() < 0.3 ? BAND_BLUE : BAND_WHITE;
      writeStar(
        idx++,
        positions,
        colors,
        scales,
        flags,
        x,
        y,
        z,
        color,
        pickStarScale(p, 0.4, 0.55),
        1,
      );
    }
  };

  // Primary band — sech² latitude bias around the y=0 plane.
  writeBand(0);
  // Secondary band — same density and thickness, shifted in latitude.
  writeBand(p.band2Offset);

  // Field — uniform on the unit sphere.
  for (let i = 0; i < p.fieldCount; i++) {
    const phi = Math.random() * Math.PI * 2;
    const cosTheta = Math.random() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const x = R * sinTheta * Math.cos(phi);
    const y = R * cosTheta;
    const z = R * sinTheta * Math.sin(phi);
    const color = Math.random() < 0.15 ? BAND_BLUE : FIELD_WHITE;
    writeStar(
      idx++,
      positions,
      colors,
      scales,
      flags,
      x,
      y,
      z,
      color,
      pickStarScale(p, 0.35, 0.5),
      0,
    );
  }

  const freqRange = TWINKLE_FREQ_MAX - TWINKLE_FREQ_MIN;
  for (let i = 0; i < N; i++) {
    twinkles[i * 2 + 0] = TWINKLE_FREQ_MIN + Math.random() * freqRange;
    twinkles[i * 2 + 1] = TWINKLE_FREQ_MIN + Math.random() * freqRange;
  }

  return { positions, colors, scales, flags, twinkles };
}

// Separable 9-tap gaussian — symmetric, 5 unique samples.
const GAUSS_OFFSETS = [0, 1.3846153846, 3.2307692308];
const GAUSS_WEIGHTS = [0.227027027, 0.3162162162, 0.0702702703];

// ---- TSL uniforms (module scope) ----
// Lifted out of the scene useEffect so the optional debug-GUI effect can
// bind sliders directly to `.value`. Vector2 uniforms have placeholder
// initial values; the scene effect overwrites them once it knows canvas
// dimensions. Stable across HMR since module identity is preserved.
const pointSize = uniform(2.3);
// tan(fov/2) — kept in sync with the camera's FOV (default 75°). Used to
// clamp the on-screen pixel footprint of each billboard.
const halfFovTan = uniform(Math.tan((75 * Math.PI) / 180 / 2));
const maxParticlePixels = uniform(5.5);
const clusterScale = uniform(0.03);
const clusterContrast = uniform(1.43);
const clusterStrength = uniform(0.57);
// Secondary cluster layer — same recipe, independent uniforms. Defaults are
// tuned so it reads as a finer-grained embellishment on top of the primary:
// double the scale (~half the feature size), matched contrast as a sensible
// starting point, and a lower strength so it doesn't dominate the primary.
const clusterScale2 = uniform(0.109);
const clusterContrast2 = uniform(1.28);
const clusterStrength2 = uniform(0.83);
// Multiplies brightness ONLY for field stars (aInstanceFlag = 0). Band
// stars (aInstanceFlag = 1) are unaffected. 1 = current behavior, 0 =
// field stars fully hidden, >1 = boosted.
const fieldStrength = uniform(0.58);
// ---- Hover/density highlight system ----
// Mouse hover writes into two low-res buffers per frame:
//   - density: a scalar field splatted with a gaussian at the cursor
//   - velocity: a vec2 field splatted with mouse delta per frame
// The density update samples its previous frame at `uv - velocity * dt`
// (semi-Lagrangian advection), decays, then adds the new splat. The
// density texture is sampled in the star vertex shader at each star's
// projected screen UV — non-zero density boosts brightness.
// Hover sim runs at this fraction of the canvas device-pixel resolution.
const HOVER_DPR = 0.5;
type DebugView = "off" | "density" | "densityCopy" | "velocity" | "velocityCopy";
const mousePos = uniform(new THREE.Vector2(-1, -1)); // UV; -1 = off-screen / no splat
const mouseVel = uniform(new THREE.Vector2(0, 0));
const splatRadius = uniform(0.08); // gaussian sigma in UV space
const splatStrength = uniform(20);
const densityDecay = uniform(0.985);
// Lower velocity magnitudes + small advection step keep the wake sub-pixel
// per frame. Large steps sample outside the splat where the field is ~0, so
// linear filtering rapidly dilutes the field even with decay near 1.
const velocitySplatStrength = uniform(2.0);
const velocityDecay = uniform(0.99);
const advectionStrength = uniform(0.05);
const hoverStrength = uniform(1.0);
// Canvas aspect (width/height). Applied to the splat-distance x-axis so a
// circular splat stays circular on non-square canvases.
const hoverAspect = uniform(1.0);
// Twinkle — only the ~10% of stars flagged via aInstanceBlink respond.
// `strength` is the max brightness reduction at the noise trough; `speed`
// drifts each star's noise sample point through time. Deliberately gentle
// defaults so the effect reads as subtle blinking, not jitter.
const uTime = uniform(0);
const twinkleStrength = uniform(0.4);
const twinkleSpeed = uniform(0.42);
const resolution = uniform(new THREE.Vector2(1, 1));
const bloomThreshold = uniform(0);
const bloomStrength = uniform(0);
// Logo-mask reveal — these three uniforms start at 0 and animate up to their
// targets over REVEAL_DURATION_MS once the post-pipeline begins rendering.
// `revealTargets` is the source of truth (lil-gui binds to it); the animate
// loop computes `target * easedProgress` and assigns to the uniform each
// frame. After the reveal completes (eased=1), slider edits propagate
// immediately since the math is just `target * 1`.
const REVEAL_DURATION_MS = 1500;
// Duration of the white "line" (logoWhiteStrength) fade-in. Independent of
// REVEAL_DURATION_MS so the outlined logo strokes can settle in on their
// own timeline relative to the mask brightening.
const LINE_REVEAL_DURATION_MS = 10000;
// Hold-off before the line starts revealing — lets the mask brightening
// establish first so the white outline lands on an already-glowing logo.
const LINE_REVEAL_DELAY_MS = 500;
// Bloom intensity fade-in. Linear, with its own duration and hold-off.
const BLOOM_REVEAL_DURATION_MS = 1000;
const BLOOM_REVEAL_DELAY_MS = 1000;
// Number of render frames to discard before the reveal clock starts. The
// first frame triggers all the lazy shader compiles for the post pipeline
// (which can block the GPU for hundreds of ms on a cold load); the second
// gives a buffer for any straggling compile or driver warm-up. Without
// this, the reveal would silently "tick" through the compile time and
// users would see the animation skip its opening.
const REVEAL_WARMUP_FRAMES = 2;
// Never leave the event content hidden if WebGPU initialization stalls.
const SHADER_READY_TIMEOUT_MS = 3000;
// The logo tops out near 1080 device pixels, so 1024 preserves its detail
// while avoiding the larger main-thread pixel copy of the former 1600 texture.
const LOGO_TEXTURE_SIZE = 1024;
const revealTargets = {
  logoMinMul: 0.025,
  // The eve mark has broad horizontal strokes; a lower multiplier keeps
  // their dense star field granular instead of saturating into solid bars.
  logoMaxMul: 2.2,
  logoWhiteStrength: 0.65,
  bloomStrength: 0.1,
};
const logoMinMul = uniform(0);
const logoMaxMul = uniform(0);
const logoCurve = uniform(2.1);
const diagonalBoost = uniform(0.8);
// Shapes the green-channel "line" before multiplying by logoWhiteStrength.
// 1 = linear (raw g value), >1 sharpens the falloff so the line reads as a
// thinner highlight, <1 spreads it out into a softer glow.
const lineFalloff = uniform(3);
// Multiplies the entire logo texture sample (r, g, b at once) in the mask
// pass. At 1 the logo behaves normally; at 0 the sample is all zeros, so
// `redCombined` becomes 0 → `shaped` = 0 → `factor` = logoMinMul (the mask
// uniformly dims the whole scene) and the white overlay drops out. Driven
// by window.scrollY from the scene useEffect.
const logoInfluence = uniform(1);
const LOGO_FADE_SCROLL_PX = 300;
const logoWhiteStrength = uniform(0);
const texelH = uniform(new THREE.Vector2(1, 0));
const texelV = uniform(new THREE.Vector2(0, 1));
const ditherLevels = uniform(2.0);
const ditherScale = uniform(3.0);
const ditherExposure = uniform(4.0);
const ditherStrength = uniform(1.0); // 0 = bypass, 1 = full ordered dither
// DOM-driven logo positioning. The mask pass samples the SVG by mapping
// canvas UV into logo-local UV via `(uv - logoCenter) / logoSize + 0.5`.
// Both are in canvas UV space (0..1). The Galaxy effect updates these
// from the rect of the `[data-galaxy-logo-target]` placeholder so the
// SVG ends up exactly where the page lays out the slot.
const logoCenter = uniform(new THREE.Vector2(0.5, 0.5));
const logoSize = uniform(new THREE.Vector2(1, 1));
// Bottom-edge fade — measured in "distance from the bottom edge" (0..1).
// Pixels farther from the bottom than `start` are untouched (factor=1);
// pixels closer than `end` are pure black (factor=0); smooth in between.
const bottomFadeStart = uniform(0.4);
const bottomFadeEnd = uniform(0.0);

// Refs exposed by the scene useEffect for the debug GUI to bind against.
type SceneHandles = {
  camera: THREE.PerspectiveCamera;
  sky: THREE.Mesh;
  params: SkyParams;
  regenerateSky: () => void;
  hoverDebug: { mode: DebugView };
};

export function NightsGalaxy(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandles | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const route = container.closest<HTMLElement>("[data-nights-route]");
    let shaderStateSignaled = false;
    let shaderReadyTimeout: number | null = null;
    const signalShaderState = (state: "ready" | "error"): void => {
      if (shaderStateSignaled) return;
      shaderStateSignaled = true;
      container.dataset.shaderState = state;
      route?.setAttribute("data-shader-state", state);
      if (shaderReadyTimeout !== null) {
        window.clearTimeout(shaderReadyTimeout);
        shaderReadyTimeout = null;
      }
    };
    route?.setAttribute("data-shader-state", "loading");
    shaderReadyTimeout = window.setTimeout(
      () => signalShaderState("ready"),
      SHADER_READY_TIMEOUT_MS,
    );

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera lives at the origin — we are the observer at the center of the sky.
    const camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(0, 0, 0);
    // Look slightly above the galactic equator — pushes the band & bulge into
    // the lower-center of the frame, like the iconic Milky Way "looking south
    // toward Sagittarius" composition.
    camera.lookAt(0, 0.35, -1);

    const renderer = new THREE.WebGPURenderer({
      antialias: true,
    });
    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    // On 1x DPR the default 3-pixel dither block looks chunky; collapse to
    // 1 so the dither matches the per-pixel grid users see on hi-DPI screens.
    if (dpr === 1) ditherScale.value = 1;
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    const initPromise = renderer.init();
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let prefersReducedMotion = motionPreference.matches;
    const handleMotionPreferenceChange = (event: MediaQueryListEvent): void => {
      prefersReducedMotion = event.matches;
    };
    motionPreference.addEventListener("change", handleMotionPreferenceChange);

    // ---- Hover/density buffers ----
    // Created up-front so the star material can sample `densityRT.texture`
    // in its vertex shader. Cleared to black after init (RT contents are
    // undefined until rendered). Each frame the animate loop runs:
    //   copy density → densityCopy → update density (advect + decay + splat)
    //   copy velocity → velocityCopy → update velocity (decay + splat)
    // Hover buffers run at HOVER_DPR × the canvas device pixels — a coarse
    // grid is plenty for a smeared splat/advection field and keeps the
    // per-frame cost down.
    // colorSpace: NoColorSpace — these are data textures (signed velocity
    // components, raw density). Without this, the default sRGB encoding on
    // write clamps negatives to 0, so the velocity field can only push in
    // the +x/+y direction.
    const hoverW = (): number => Math.max(1, Math.floor(container.clientWidth * dpr * HOVER_DPR));
    const hoverH = (): number => Math.max(1, Math.floor(container.clientHeight * dpr * HOVER_DPR));
    const densityRTOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    } as const;
    const velocityRTOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    } as const;
    const densityRT = new THREE.RenderTarget(hoverW(), hoverH(), densityRTOptions);
    const densityCopy = new THREE.RenderTarget(hoverW(), hoverH(), densityRTOptions);
    const velocityRT = new THREE.RenderTarget(hoverW(), hoverH(), velocityRTOptions);
    const velocityCopy = new THREE.RenderTarget(hoverW(), hoverH(), velocityRTOptions);

    // Shared resolution uniform (device pixels). Updated on resize.
    const fullW = (): number => Math.floor(container.clientWidth * dpr);
    const fullH = (): number => Math.floor(container.clientHeight * dpr);
    const halfW = (): number => Math.max(1, Math.floor(fullW() / 2));
    const halfH = (): number => Math.max(1, Math.floor(fullH() / 2));
    resolution.value.set(fullW(), fullH());
    halfFovTan.value = Math.tan((camera.fov * Math.PI) / 180 / 2);
    hoverAspect.value =
      container.clientHeight > 0 ? container.clientWidth / container.clientHeight : 1;

    // ---- Sky stars — instanced billboard quads ----
    // A single 1×1 plane geometry rendered N times via InstancedBufferGeometry.
    // Each instance's world position/scale/color come from instanced attributes.
    // Vertex shader projects the instance origin to view space then adds the
    // local quad vertex in view-aligned axes (camera-facing billboard).
    const params: SkyParams = { ...DEFAULT_PARAMS };

    const quadGeometry = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quadGeometry.index;
    geometry.setAttribute("position", quadGeometry.attributes.position);
    geometry.setAttribute("uv", quadGeometry.attributes.uv);
    quadGeometry.dispose();

    // Repopulates the instanced buffers from `params`. Called once on setup
    // and again by the debug GUI when band/field counts or distribution
    // params change.
    const regenerateSky = (): void => {
      const { positions, colors, scales, flags, twinkles } = buildSkyAttributes(params);
      const count = positions.length / 3;
      geometry.setAttribute("aInstancePosition", new THREE.InstancedBufferAttribute(positions, 3));
      geometry.setAttribute("aInstanceColor", new THREE.InstancedBufferAttribute(colors, 3));
      geometry.setAttribute("aInstanceScale", new THREE.InstancedBufferAttribute(scales, 1));
      geometry.setAttribute("aInstanceFlag", new THREE.InstancedBufferAttribute(flags, 1));
      geometry.setAttribute("aInstanceTwinkle", new THREE.InstancedBufferAttribute(twinkles, 2));
      geometry.instanceCount = count;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), params.sphereRadius * 1.1);
    };
    regenerateSky();

    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;

    // ---- Billboard vertex ----
    // attribute() by name resolves through the geometry.
    // `as const` is required so the second arg narrows to the literal type and
    // the returned AttributeNode<'vec3'>/<'float'> gets the vec/scalar chainable methods.
    const instPos = attribute("aInstancePosition", "vec3" as const);
    const instColor = attribute("aInstanceColor", "vec3" as const);
    const instFlag = attribute("aInstanceFlag", "float" as const); // 1 = band, 0 = field/bulge
    const instTwinkle = attribute("aInstanceTwinkle", "vec2" as const); // per-star sine freqs
    const instSizeAttr = attribute("aInstanceScale", "float" as const);
    const desiredScale = instSizeAttr.mul(pointSize);

    const viewInstance = modelViewMatrix.mul(vec4(instPos, 1));
    // Distance from camera in view space (positive in front of the camera).
    const viewDist = viewInstance.z.negate().max(0.001);
    // World-units-per-pixel at this depth. Clamp our world-space scale so the
    // projected on-screen size never exceeds `maxParticlePixels` device pixels.
    //   pixels = worldSize * viewportHeight / (2 * dist * tan(fov/2))
    //   ⇒ maxWorldSize = maxPixels * 2 * dist * tan(fov/2) / viewportHeight
    const maxPixelsDevice = maxParticlePixels.mul(screenDPR);
    const maxWorldSize = maxPixelsDevice.mul(2).mul(viewDist).mul(halfFovTan).div(resolution.y);
    const instScale = desiredScale.min(maxWorldSize);

    const viewOffset = vec4(positionLocal.x.mul(instScale), positionLocal.y.mul(instScale), 0, 0);
    const projectedClip = cameraProjectionMatrix.mul(viewInstance.add(viewOffset));
    material.vertexNode = projectedClip;

    // ---- Per-instance 3D cluster noise (vertex-stage only) ----
    // Sampled once per instance position with 3-octave fBm, remapped to [0,1],
    // then power-shaped for contrast and mixed against 1.0 by clusterStrength.
    // Gated by aInstanceFlag so only band stars are clustered (field stars
    // stay at full opacity — strength * 0 = 0, so mix(1, shaped, 0) = 1).
    // Wrapped in varying() so the value is computed in the vertex shader (4×
    // per quad, all identical) and interpolated as a constant to the fragment —
    // avoids per-fragment noise cost.
    const clusterNoise = mx_fractal_noise_float(
      instPos.mul(clusterScale),
      int(3),
      float(2),
      float(0.5),
    )
      .add(1)
      .mul(0.5);
    const shapedCluster = clusterNoise.pow(clusterContrast).clamp(0, 1);
    const clusterMul = mix(float(1), shapedCluster, clusterStrength.mul(instFlag));

    // ---- Per-instance 3D cluster noise — secondary layer ----
    // A finer-grained version of the primary cluster noise that multiplies
    // on top of `clusterMul`. Identical recipe (same sample, shaping, and
    // mix-against-1 pattern) with its own uniforms so the two layers can be
    // tuned independently. Also gated by instFlag so field stars stay
    // untouched.
    const clusterNoise2 = mx_fractal_noise_float(
      instPos.mul(clusterScale2),
      int(3),
      float(2),
      float(0.5),
    )
      .add(1)
      .mul(0.5);
    const shapedCluster2 = clusterNoise2.pow(clusterContrast2).clamp(0, 1);
    const clusterMul2 = mix(float(1), shapedCluster2, clusterStrength2.mul(instFlag));

    // ---- Per-instance twinkle (vertex-stage, animated) ----
    // Two static random sine frequencies per star, combined as a product.
    // The product gives a non-periodic envelope (no two stars share a
    // pattern unless they have identical frequency pairs), at the cost of
    // two sin() per quad. Range is [-1, 1] → remapped to [0, 1] → used as
    // a brightness multiplier bounded by twinkleStrength.
    //
    // Effective strength is scaled by the star's raw size attribute so the
    // visible amplitude tracks the star's footprint: big stars (the rare
    // "bright fraction" with scale 1.8–4) modulate noticeably; small stars
    // (scale ~0.35–0.95) barely budge, and the dither does the rest by
    // flipping a pixel on/off as their value crosses thresholds.
    const phasedTime = uTime.mul(twinkleSpeed);
    // Bake a per-star starting phase out of the freq value so stars don't
    // all share `sin(0) = 0` at t=0. The 13.7 / 7.3 / 3.1 multipliers are
    // arbitrary irrationals — they rotate each star into an unrelated
    // position on its sine cycle, breaking the global synchronization.
    const sineA = sin(phasedTime.mul(instTwinkle.x).add(instTwinkle.x.mul(13.7)));
    const sineB = sin(phasedTime.mul(instTwinkle.y).add(instTwinkle.y.mul(7.3)));
    // Third layer: derived freq from the product of the two stored freqs,
    // damped so the product (which can reach ~100 at the high end of the
    // freq range) doesn't strobe. The freq is irrational against both
    // sineA and sineB, so it adds genuine unpredictability rather than
    // re-tracing either dominant cycle.
    const freqC = instTwinkle.x.mul(instTwinkle.y).mul(0.1);
    const sineC = sin(phasedTime.mul(freqC).add(freqC.mul(3.1)));
    // Sum the three sines: sineA carries, sineB perturbs at 50%, sineC
    // adds a third irrational layer at 20%. Sum range is [-1.7, 1.7];
    // the 1/3.4 normalizer + 0.5 offset bakes that back into [0, 1].
    const turbulent = sineA.add(sineB.mul(0.5)).add(sineC.mul(0.2));
    const twinkle01 = turbulent
      .mul(1 / 3.4)
      .add(0.5)
      .clamp(0.3, 1);
    const effectiveTwinkleStrength = twinkleStrength.mul(instSizeAttr).clamp(0, 1);
    const twinkleMul = float(1).sub(effectiveTwinkleStrength.mul(twinkle01.oneMinus()));

    // Per-star multiplier driven by fieldStrength. instFlag=0 (field) →
    // fieldStrength; instFlag=1 (band) → 1.0. Leaves band brightness alone.
    const fieldMul = mix(fieldStrength, float(1), instFlag);

    // ---- Hover density boost (vertex-stage sample) ----
    // Project the star to screen UV (NDC → [0,1]) and sample the density
    // buffer at that point. Stars under the cursor brighten proportionally
    // to local density. Multiplier is 1 + density * hoverStrength so a
    // zeroed density behaves as a no-op.
    const ndcXY = projectedClip.xy.div(projectedClip.w);
    const hoverScreenUV = ndcXY.mul(0.5).add(0.5);
    const hoverDensity = tslTexture(densityRT.texture, hoverScreenUV).r;
    const hoverMul = float(1).add(hoverDensity.mul(hoverStrength));

    const brightnessVarying = varying(
      clusterMul.mul(clusterMul2).mul(twinkleMul).mul(fieldMul).mul(hoverMul),
    );

    // ---- Radial gradient fragment (additive), modulated by cluster mask ----
    const r = length(uv().sub(0.5)).mul(2); // 0 center → 1 at edge of inscribed circle
    const falloff = r.oneMinus().max(0).pow(2);
    material.colorNode = vec4(instColor.mul(falloff).mul(brightnessVarying), 1);

    const sky = new THREE.Mesh(geometry, material);
    sky.frustumCulled = false; // billboards' projected bounds aren't trivial
    sky.rotation.z = -0.47;
    sky.rotation.x = 0.43;
    sky.rotation.y = 0;
    scene.add(sky);

    // Publish handles for the debug useEffect. Set synchronously so it can
    // wire camera/sky controls as soon as `?debug` triggers the dynamic
    // import — well before the async logo/init promise resolves.
    const hoverDebug: { mode: DebugView } = { mode: "off" };
    sceneRef.current = { camera, sky, params, regenerateSky, hoverDebug };

    // ---- Custom postprocessing pipeline ----

    const sceneRT = new THREE.RenderTarget(fullW(), fullH(), {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    const ditheredRT = new THREE.RenderTarget(fullW(), fullH(), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    const maskedRT = new THREE.RenderTarget(fullW(), fullH(), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    const brightRT = new THREE.RenderTarget(halfW(), halfH(), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    const blurHRT = new THREE.RenderTarget(halfW(), halfH(), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    const blurVRT = new THREE.RenderTarget(halfW(), halfH(), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });

    texelH.value.set(1 / halfW(), 0);
    texelV.value.set(0, 1 / halfH());

    // Ordered Bayer 4x4 dither matrix as a 4x4 R8 texture (REPEAT + NEAREST).
    // Each cell holds threshold ≈ (i + 0.5) / 16 mapped into 8-bit.
    const BAYER_4X4_VALUES = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const bayerBuffer = new Uint8Array(BAYER_4X4_VALUES.length);
    for (let i = 0; i < BAYER_4X4_VALUES.length; i++) {
      bayerBuffer[i] = Math.round(((BAYER_4X4_VALUES[i] + 0.5) / 16) * 255);
    }
    const bayerTexture = new THREE.DataTexture(
      bayerBuffer,
      4,
      4,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    bayerTexture.magFilter = THREE.NearestFilter;
    bayerTexture.minFilter = THREE.NearestFilter;
    bayerTexture.wrapS = THREE.RepeatWrapping;
    bayerTexture.wrapT = THREE.RepeatWrapping;
    bayerTexture.needsUpdate = true;

    // DOM-driven logo + galaxy positioning. The page renders an empty
    // placeholder div with `data-galaxy-logo-target`. We measure that
    // rect to drive both the mask uniforms (where to draw the SVG) and
    // the camera projection offset (so the band/bulge sit behind the
    // logo). A ResizeObserver keeps everything in sync as the layout
    // reflows on resize / viewport breakpoint changes.
    const placeholder = document.querySelector<HTMLElement>("[data-galaxy-logo-target]");

    const updateLogoLayout = (): void => {
      const containerW = container.clientWidth;
      const containerH = container.clientHeight;

      if (!placeholder) {
        // Defensive fallback: centered fullscreen "contain" mapping, no
        // camera offset. Preserves the old behavior if the page ever
        // forgets the placeholder.
        logoCenter.value.set(0.5, 0.5);
        const aspect = containerW / containerH;
        logoSize.value.set(aspect >= 1 ? 1 / aspect : 1, aspect >= 1 ? 1 : aspect);
        camera.clearViewOffset();
        return;
      }

      const phRect = placeholder.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();

      // Placeholder center & size in canvas pixel space.
      const cx = phRect.left + phRect.width / 2 - cRect.left;
      const cy = phRect.top + phRect.height / 2 - cRect.top;

      // Pack into UV space, using the placeholder's actual aspect (no
      // square enforcement). The texture is rasterized as a uniform
      // stretch of the SVG into a square, so sampling into a same-aspect
      // placeholder reproduces the SVG at its true proportions.
      // TSL's fullscreen UV uses the same top-origin convention as the DOM
      // rect here. The SVG sample itself is flipped below, independently.
      logoCenter.value.set(cx / containerW, cy / containerH);
      logoSize.value.set(phRect.width / containerW, phRect.height / containerH);

      // Camera off-axis projection. The natural projection center must
      // map to (cx, cy) on the canvas. Solve for the minimum (fullW,
      // fullH) that satisfies x ≥ 0, y ≥ 0, and (x+w, y+h) ≤ (fullW,
      // fullH) — i.e. the smallest projection containing both the
      // natural center and our canvas crop.
      const fullW = 2 * Math.max(cx, containerW - cx);
      const fullH = 2 * Math.max(cy, containerH - cy);
      const x = fullW / 2 - cx;
      const y = fullH / 2 - cy;
      camera.setViewOffset(fullW, fullH, x, y, containerW, containerH);
    };

    const layoutObserver = new ResizeObserver(updateLogoLayout);
    layoutObserver.observe(container);
    if (placeholder) layoutObserver.observe(placeholder);
    updateLogoLayout();

    // Scroll-driven fade: logoInfluence ramps from 1 (scroll=0) down to 0
    // at scroll >= LOGO_FADE_SCROLL_PX. The shader multiplies the texture
    // sample by this, so the logo's red/green/blue contributions all
    // vanish together and the scene reads as uniformly dim everywhere.
    const updateLogoInfluence = (): void => {
      const t = Math.min(window.scrollY / LOGO_FADE_SCROLL_PX, 1);
      logoInfluence.value = 1 - t;
    };
    window.addEventListener("scroll", updateLogoInfluence, { passive: true });
    updateLogoInfluence();

    // ---- Dither pass — desaturates to luminance and applies ordered (Bayer 4x4)
    // dithering. Quantizes to N levels per channel with a per-pixel threshold
    // sampled from the bayer texture (NEAREST + REPEAT auto-tiles the 4x4 cell).
    const ditherMat = new THREE.NodeMaterial();
    {
      // Snap the scene sample to the center of the current dither block so
      // every fragment in a ditherScale×ditherScale macropixel reads the same
      // source luminance. Without this snap, each fragment samples the scene
      // at its own UV and within-block luminance variation slices the
      // macropixel into mismatched fragments.
      const pixelCoord = uv().mul(resolution);
      const blockIndex = pixelCoord.div(ditherScale).floor();
      const blockCenterUV = blockIndex.add(0.5).mul(ditherScale).div(resolution);

      const sceneSample = tslTexture(sceneRT.texture, blockCenterUV);
      const lum = sceneSample.r
        .mul(0.2126)
        .add(sceneSample.g.mul(0.7152))
        .add(sceneSample.b.mul(0.0722))
        .mul(ditherExposure);

      // Bayer threshold lookup — already per-block (floor() collapses), so
      // the whole macropixel resolves to a single threshold and the
      // single-luminance block gets quantized to one solid color.
      const bayerUV = blockIndex.add(0.5).div(4);
      const threshold = tslTexture(bayerTexture, bayerUV).r;

      // Per-pixel threshold contribution. Instead of a hard step (which
      // would pop the pixel to its full source intensity the moment lum
      // crosses the bayer threshold), remap (frac - threshold) linearly
      // from [threshold, 1] → [0, 1]. At lum = threshold the pixel just
      // turns on at value 0; it then ramps up linearly so its output
      // tracks how far source has overshot the threshold. Below threshold
      // the contribution is clamped to 0 (pixel stays off).
      const levelsMinus1 = ditherLevels.sub(1);
      const sLum = lum.mul(levelsMinus1);
      const lower = sLum.floor();
      const frac = sLum.sub(lower);
      const upperContribution = frac.sub(threshold).div(threshold.oneMinus()).max(0);
      const quantized = lower.add(upperContribution).div(levelsMinus1);

      // Use `quantized` as a multiplier on the source color rather than as
      // the output color directly. ON pixels keep the underlying RGB at its
      // original intensity (a red region dithers to red dots, not white
      // dots); OFF pixels go to black. Multi-level dither scales the source
      // by the graded quantization level.
      const dithered = sceneSample.rgb.mul(quantized);
      const out = mix(sceneSample.rgb, dithered, ditherStrength);
      ditherMat.colorNode = vec4(out, 1);
    }

    let running = true;
    let logoTexture: THREE.DataTexture | null = null;

    type PostQuads = {
      maskQuad: THREE.QuadMesh;
      brightQuad: THREE.QuadMesh;
      blurHQuad: THREE.QuadMesh;
      blurVQuad: THREE.QuadMesh;
      composeQuad: THREE.QuadMesh;
    };
    type PostMats = {
      maskMat: THREE.NodeMaterial;
      brightMat: THREE.NodeMaterial;
      blurHMat: THREE.NodeMaterial;
      blurVMat: THREE.NodeMaterial;
      composeMat: THREE.NodeMaterial;
    };
    let postQuads: PostQuads | null = null;
    let postMats: PostMats | null = null;

    const ditherQuad = new THREE.QuadMesh(ditherMat);

    // The reveal clock only starts after REVEAL_WARMUP_FRAMES have rendered,
    // so the cold shader compile on the first frame doesn't burn through the
    // beginning of the animation. During warmup, uniforms stay at their
    // zero starting values (so the canvas is blank/dark) and the pipeline
    // still runs every frame to trigger the compiles.
    let revealStart: number | null = null;
    let renderedFrames = 0;

    // ---- Hover update materials ----
    // densityCopyMat / velocityCopyMat sample their "main" RT (the one the
    // star shader reads from) and render its content to the bound copy RT.
    // The update materials then sample the COPY RT (= previous frame's
    // main) and write back to the bound main RT, so the star material's
    // texture node stays stable across the ping-pong.
    // Use `fragmentNode` (not `colorNode`) on every hover-pipeline material:
    // `colorNode` flows through NodeMaterial.setupDiffuseColor(), which ends
    // with `vec4(outgoingLightNode, alpha).max(0)` — that `.max(0)` silently
    // clamps signed velocity to non-negative. `fragmentNode` bypasses the
    // diffuse-color pipeline and writes raw values to the framebuffer, so
    // rg16float can actually store negative components.
    const densityCopyMat = new THREE.NodeMaterial();
    densityCopyMat.fragmentNode = vec4(tslTexture(densityRT.texture, uv()).r, 0, 0, 1);
    densityCopyMat.toneMapped = false;

    const velocityCopyMat = new THREE.NodeMaterial();
    velocityCopyMat.fragmentNode = vec4(tslTexture(velocityRT.texture, uv()).rg, 0, 1);
    velocityCopyMat.toneMapped = false;

    // Gaussian splat centered on `mousePos` in UV space, falling off with
    // `splatRadius` as the standard deviation. The x-axis delta is scaled
    // by `hoverAspect` (canvas width/height) so distance is measured in a
    // square metric — keeps the splat circular on non-square viewports.
    const splatDelta = uv().sub(mousePos);
    const splatDeltaSquare = vec2(splatDelta.x.mul(hoverAspect), splatDelta.y);
    const splatGaussian = length(splatDeltaSquare).div(splatRadius).pow(2).negate();

    const velocityUpdateMat = new THREE.NodeMaterial();
    velocityUpdateMat.toneMapped = false;
    {
      // Self-advect velocity (sample at uv - vel*advection from the COPY —
      // never read the RT we're writing into), decay, add the mouse-delta
      // splat scaled by velocitySplatStrength * gaussian.
      const velAtUV = tslTexture(velocityCopy.texture, uv()).rg;
      const advectionUV = uv().sub(velAtUV.mul(advectionStrength));
      const advectedVel = tslTexture(velocityCopy.texture, advectionUV).rg;
      const decayedVel = advectedVel.mul(velocityDecay);
      const g = exp(splatGaussian);
      const velSplat = mouseVel.mul(velocitySplatStrength).mul(g);
      velocityUpdateMat.fragmentNode = vec4(decayedVel.add(velSplat), 0, 1);
    }

    const densityUpdateMat = new THREE.NodeMaterial();
    densityUpdateMat.toneMapped = false;
    {
      // Advect density along the velocity field (read from velocityCopy so
      // we're not racing the in-flight velocityRT write — both update passes
      // share velocityCopy as their stable read source), decay, add gaussian
      // splat scaled by mouse-motion magnitude. A stationary cursor deposits
      // zero density so the only visible activations are wakes that trail
      // behind actual movement.
      const velAtUV = tslTexture(velocityCopy.texture, uv()).rg;
      const advectionUV = uv().sub(velAtUV.mul(advectionStrength));
      const advectedDensity = tslTexture(densityCopy.texture, advectionUV).r;
      const decayedDensity = advectedDensity.mul(densityDecay);
      const g = exp(splatGaussian);
      const motionAmount = length(mouseVel);
      const splatContrib = g.mul(splatStrength).mul(motionAmount);
      densityUpdateMat.fragmentNode = vec4(decayedDensity.add(splatContrib), 0, 0, 1);
    }

    const densityCopyQuad = new THREE.QuadMesh(densityCopyMat);
    const densityUpdateQuad = new THREE.QuadMesh(densityUpdateMat);
    const velocityCopyQuad = new THREE.QuadMesh(velocityCopyMat);
    const velocityUpdateQuad = new THREE.QuadMesh(velocityUpdateMat);

    // Debug visualization quads — one per hover RT. Density renders as
    // grayscale (clamped 0..1). Velocity renders r→red, g→green, biased
    // from [-1,1] to [0,1] so zero shows mid-gray, positive moves right/up
    // hot, negative cold.
    const debugMats: THREE.NodeMaterial[] = [];
    const makeDensityDebugQuad = (rt: THREE.RenderTarget): THREE.QuadMesh => {
      const mat = new THREE.NodeMaterial();
      const d = tslTexture(rt.texture, uv()).r.clamp(0, 1);
      mat.colorNode = vec4(d, d, d, 1);
      debugMats.push(mat);
      return new THREE.QuadMesh(mat);
    };
    const makeVelocityDebugQuad = (rt: THREE.RenderTarget): THREE.QuadMesh => {
      const mat = new THREE.NodeMaterial();
      const v = tslTexture(rt.texture, uv()).rg.mul(0.5).add(0.5).clamp(0, 1);
      mat.colorNode = vec4(v.x, v.y, 0.5, 1);
      debugMats.push(mat);
      return new THREE.QuadMesh(mat);
    };
    const debugQuads = {
      density: makeDensityDebugQuad(densityRT),
      densityCopy: makeDensityDebugQuad(densityCopy),
      velocity: makeVelocityDebugQuad(velocityRT),
      velocityCopy: makeVelocityDebugQuad(velocityCopy),
    };

    // Clear all four hover RTs to black once after the renderer is ready
    // (their contents are undefined until first written). Without this the
    // first frame's advection samples garbage and the density blows up.
    const clearMat = new THREE.NodeMaterial();
    clearMat.colorNode = vec4(0, 0, 0, 1);
    clearMat.toneMapped = false;
    const clearQuad = new THREE.QuadMesh(clearMat);
    let hoverCleared = false;
    const clearHoverBuffers = (): void => {
      if (hoverCleared) return;
      for (const rt of [densityRT, densityCopy, velocityRT, velocityCopy]) {
        renderer.setRenderTarget(rt);
        clearQuad.render(renderer);
      }
      hoverCleared = true;
    };

    // ---- Pointer tracking for hover splat ----
    // mousePos = current pointer UV (relative to the canvas container).
    // pendingMouseDelta accumulates UV-space deltas between animate frames;
    // each frame the animate loop transfers it to the mouseVel uniform and
    // resets it.
    const pendingMouseDelta = { x: 0, y: 0 };
    let lastMouseUV: { x: number; y: number } | null = null;
    const handlePointerMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const u = (event.clientX - rect.left) / rect.width;
      const v = 1 - (event.clientY - rect.top) / rect.height;
      if (lastMouseUV) {
        pendingMouseDelta.x += u - lastMouseUV.x;
        pendingMouseDelta.y += v - lastMouseUV.y;
      }
      mousePos.value.set(u, v);
      lastMouseUV = { x: u, y: v };
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    let animationFrameId: number | null = null;
    const animate = (): void => {
      animationFrameId = null;
      if (!running || !postQuads || document.hidden) return;

      renderedFrames++;
      if (revealStart === null && renderedFrames > REVEAL_WARMUP_FRAMES) {
        revealStart = performance.now();
      }
      const elapsedMs = revealStart === null ? 0 : performance.now() - revealStart;

      if (prefersReducedMotion) {
        uTime.value = 0;
        logoMinMul.value = revealTargets.logoMinMul;
        logoMaxMul.value = revealTargets.logoMaxMul;
        logoWhiteStrength.value = revealTargets.logoWhiteStrength;
        bloomStrength.value = revealTargets.bloomStrength;
      } else {
        // Wall-clock seconds for the twinkle noise field. Not gated by the
        // reveal warmup — twinkle drives its own decorrelated noise sample so
        // ticking it during warmup costs nothing (uniforms are still 0).
        uTime.value = performance.now() * 0.001;

        // Ease-in circular — `1 - sqrt(1 - t²)`. Starts almost flat (very slow)
        // and accelerates sharply toward t=1. logoMax sweeps the full curve up
        // to its target while logoMin follows the same instantaneous rate and
        // clamps at its smaller target.
        const tMain = Math.min(elapsedMs / REVEAL_DURATION_MS, 1);
        const easedMain = 1 - Math.sqrt(1 - tMain * tMain);
        const scaledMain = revealTargets.logoMaxMul * easedMain;
        logoMaxMul.value = scaledMain;
        logoMinMul.value = Math.min(scaledMain, revealTargets.logoMinMul);

        // Reveal the line and bloom on independent clocks after the mask has
        // begun to establish.
        const tWhite = Math.min(
          Math.max(elapsedMs - LINE_REVEAL_DELAY_MS, 0) / LINE_REVEAL_DURATION_MS,
          1,
        );
        logoWhiteStrength.value = revealTargets.logoWhiteStrength * tWhite;

        const tBloom = Math.min(
          Math.max(elapsedMs - BLOOM_REVEAL_DELAY_MS, 0) / BLOOM_REVEAL_DURATION_MS,
          1,
        );
        bloomStrength.value = revealTargets.bloomStrength * tBloom;
      }

      // Hover update — runs every frame before the scene renders so the
      // star material's vertex sampling sees the freshly-updated density.
      clearHoverBuffers();
      mouseVel.value.set(pendingMouseDelta.x, pendingMouseDelta.y);
      pendingMouseDelta.x = 0;
      pendingMouseDelta.y = 0;
      // Velocity first: density advection samples the just-updated field.
      renderer.setRenderTarget(velocityCopy);
      velocityCopyQuad.render(renderer);
      renderer.setRenderTarget(velocityRT);
      velocityUpdateQuad.render(renderer);
      renderer.setRenderTarget(densityCopy);
      densityCopyQuad.render(renderer);
      renderer.setRenderTarget(densityRT);
      densityUpdateQuad.render(renderer);

      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      renderer.setRenderTarget(ditheredRT);
      ditherQuad.render(renderer);

      renderer.setRenderTarget(maskedRT);
      postQuads.maskQuad.render(renderer);

      renderer.setRenderTarget(brightRT);
      postQuads.brightQuad.render(renderer);

      renderer.setRenderTarget(blurHRT);
      postQuads.blurHQuad.render(renderer);

      renderer.setRenderTarget(blurVRT);
      postQuads.blurVQuad.render(renderer);

      renderer.setRenderTarget(null);
      if (hoverDebug.mode === "off") {
        postQuads.composeQuad.render(renderer);
      } else {
        debugQuads[hoverDebug.mode].render(renderer);
      }

      if (revealStart !== null) signalShaderState("ready");

      animationFrameId = requestAnimationFrame(animate);
    };

    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        pendingMouseDelta.x = 0;
        pendingMouseDelta.y = 0;
        lastMouseUV = null;
        return;
      }

      if (running && postQuads && animationFrameId === null) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void Promise.all([initPromise, rasterizeSvgToTexture(rgbLogoSvgString, LOGO_TEXTURE_SIZE)])
      .then(([, { texture }]) => {
        if (!running) {
          texture.dispose();
          return;
        }
        logoTexture = texture;

        const maskMat = new THREE.NodeMaterial();
        {
          const sceneSample = tslTexture(ditheredRT.texture, uv());
          // Map canvas UV into the logo's local UV by subtracting its center
          // and dividing by its size, then Y-flip for image-coord orientation.
          // Off-logo pixels sample outside [0,1] → clamp-to-edge returns the
          // SVG's black border → mask leaves those regions alone.
          const localUV = uv().sub(logoCenter).div(logoSize).add(0.5);
          const logoUV = vec2(localUV.x, localUV.y.oneMinus());
          const logoSample = tslTexture(texture, logoUV).mul(logoInfluence);
          const redCombined = logoSample.r.add(logoSample.b.mul(diagonalBoost)).clamp(0, 1);
          const shaped = pow(redCombined, logoCurve);
          const factor = mix(logoMinMul, logoMaxMul, shaped);
          const masked = sceneSample.rgb.mul(factor);
          // Green channel paints pure white on top, using g as the opacity.
          // `lineFalloff` shapes the raw g via pow() before the strength mul —
          // higher values pinch the highlight tighter against where g is brightest.
          const shapedLine = pow(logoSample.g, lineFalloff);
          const whiteOpacity = shapedLine.mul(logoWhiteStrength).clamp(0, 1);
          const final = mix(masked, vec3(1, 1, 1), whiteOpacity);
          maskMat.colorNode = vec4(final, 1);
        }

        const brightMat = new THREE.NodeMaterial();
        {
          const c = tslTexture(maskedRT.texture, uv());
          const lum = c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722));
          const factor = lum.sub(bloomThreshold).max(0).div(lum.add(0.0001));
          brightMat.colorNode = vec4(c.rgb.mul(factor), 1);
        }

        // Separable 9-tap gaussian — symmetric, 5 unique samples. Inlined for
        // each pass because `texelH`/`texelV` are typed UniformNode<'vec2'>
        // instances whose generic isn't reachable through a public type export.
        const buildBlurColor = (
          rtTexture: THREE.Texture,
          texelOffset: typeof texelH,
        ): ReturnType<typeof vec4> => {
          const baseUV = uv();
          let sum = tslTexture(rtTexture, baseUV).rgb.mul(GAUSS_WEIGHTS[0]);
          for (let i = 1; i < GAUSS_OFFSETS.length; i++) {
            const offset = texelOffset.mul(GAUSS_OFFSETS[i]);
            sum = sum
              .add(tslTexture(rtTexture, baseUV.add(offset)).rgb.mul(GAUSS_WEIGHTS[i]))
              .add(tslTexture(rtTexture, baseUV.sub(offset)).rgb.mul(GAUSS_WEIGHTS[i]));
          }
          return vec4(sum, 1);
        };

        const blurHMat = new THREE.NodeMaterial();
        blurHMat.colorNode = buildBlurColor(brightRT.texture, texelH);

        const blurVMat = new THREE.NodeMaterial();
        blurVMat.colorNode = buildBlurColor(blurHRT.texture, texelV);

        // Composite: pass 1 (masked scene) is the base; pass 2 (bloom) just
        // adds an accent. Multiply by a vertical falloff so the bottom edge
        // fades to pure black (lets the canvas blend into the page beneath).
        // In this compose quad uv.y=0 is at the top, so flip with oneMinus()
        // to get a coordinate measured from the bottom upward.
        const composeMat = new THREE.NodeMaterial();
        const maskedRGB = tslTexture(maskedRT.texture, uv()).rgb;
        const bloomRGB = tslTexture(blurVRT.texture, uv()).rgb;
        const distFromBottom = uv().y.oneMinus();
        // Linear remap of distFromBottom from [end, start] → [0, 1], clamped.
        // The smoothing is intentionally NOT in this step — the pow(1/2.2)
        // below provides the curve shape.
        const fadeLinear = distFromBottom
          .sub(bottomFadeEnd)
          .div(bottomFadeStart.sub(bottomFadeEnd))
          .clamp(0, 1);
        const bottomFade = fadeLinear.pow(1 / 2.2);
        composeMat.colorNode = vec4(maskedRGB.add(bloomRGB.mul(bloomStrength)).mul(bottomFade), 1);

        const maskQuad = new THREE.QuadMesh(maskMat);
        const brightQuad = new THREE.QuadMesh(brightMat);
        const blurHQuad = new THREE.QuadMesh(blurHMat);
        const blurVQuad = new THREE.QuadMesh(blurVMat);
        const composeQuad = new THREE.QuadMesh(composeMat);

        postQuads = { maskQuad, brightQuad, blurHQuad, blurVQuad, composeQuad };
        postMats = { maskMat, brightMat, blurHMat, blurVMat, composeMat };

        if (!document.hidden) animationFrameId = requestAnimationFrame(animate);
      })
      .catch((error: unknown) => {
        if (!running) return;
        signalShaderState("error");
        console.error("Failed to initialize the nights shader", error);
      });

    const handleResize = (): void => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      hoverAspect.value = h > 0 ? w / h : 1;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      sceneRT.setSize(fullW(), fullH());
      ditheredRT.setSize(fullW(), fullH());
      maskedRT.setSize(fullW(), fullH());
      brightRT.setSize(halfW(), halfH());
      blurHRT.setSize(halfW(), halfH());
      blurVRT.setSize(halfW(), halfH());
      densityRT.setSize(hoverW(), hoverH());
      densityCopy.setSize(hoverW(), hoverH());
      velocityRT.setSize(hoverW(), hoverH());
      velocityCopy.setSize(hoverW(), hoverH());
      hoverCleared = false;
      texelH.value.set(1 / halfW(), 0);
      texelV.value.set(0, 1 / halfH());
      resolution.value.set(fullW(), fullH());
      // updateLogoLayout is driven by ResizeObserver on the container —
      // it'll fire on its own when the canvas changes size.
    };
    window.addEventListener("resize", handleResize);

    return () => {
      running = false;
      if (shaderReadyTimeout !== null) window.clearTimeout(shaderReadyTimeout);
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      sceneRef.current = null;
      window.removeEventListener("resize", handleResize);
      layoutObserver.disconnect();
      window.removeEventListener("scroll", updateLogoInfluence);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionPreferenceChange);
      geometry.dispose();
      material.dispose();
      ditherMat.dispose();
      bayerTexture.dispose();
      densityCopyMat.dispose();
      densityUpdateMat.dispose();
      velocityCopyMat.dispose();
      velocityUpdateMat.dispose();
      clearMat.dispose();
      for (const m of debugMats) m.dispose();
      postMats?.maskMat.dispose();
      postMats?.brightMat.dispose();
      postMats?.blurHMat.dispose();
      postMats?.blurVMat.dispose();
      postMats?.composeMat.dispose();
      sceneRT.dispose();
      ditheredRT.dispose();
      maskedRT.dispose();
      brightRT.dispose();
      blurHRT.dispose();
      blurVRT.dispose();
      densityRT.dispose();
      densityCopy.dispose();
      velocityRT.dispose();
      velocityCopy.dispose();
      logoTexture?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Debug GUI — only loaded when the URL contains `?debug`. The dynamic
  // import keeps lil-gui out of the default page chunk; users without the
  // query string never download it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("debug")) return;

    let gui: GUIType | null = null;
    let cancelled = false;

    void import("lil-gui").then(({ default: GUI }) => {
      if (cancelled) return;
      gui = new GUI({ title: "galaxy" });

      const bloomFolder = gui.addFolder("bloom");
      bloomFolder.add(bloomThreshold, "value", 0, 2, 0.01).name("threshold");
      // Strength is owned by the reveal animation, so bind to the target.
      bloomFolder.add(revealTargets, "bloomStrength", 0, 10, 0.05).name("strength");

      const fadeFolder = gui.addFolder("bottom fade");
      fadeFolder.add(bottomFadeStart, "value", 0, 1, 0.005).name("start (from bottom)");
      fadeFolder.add(bottomFadeEnd, "value", 0, 1, 0.005).name("end (from bottom)");

      const ditherFolder = gui.addFolder("dither");
      ditherFolder.add(ditherStrength, "value", 0, 1, 0.01).name("strength");
      ditherFolder.add(ditherLevels, "value", 2, 16, 1).name("levels");
      ditherFolder.add(ditherScale, "value", 1, 8, 1).name("pixel scale");
      ditherFolder.add(ditherExposure, "value", 0.1, 4, 0.01).name("exposure");

      const logoFolder = gui.addFolder("logo mask");
      // These three bind to `revealTargets` (the destination of the reveal
      // animation), not to the uniform's `.value` — the animate loop owns
      // `.value` and overwrites it every frame as `target * easedProgress`.
      // Once the reveal completes (eased=1), slider edits propagate immediately.
      logoFolder.add(revealTargets, "logoMinMul", 0, 5, 0.01).name("min mul (red=0)");
      logoFolder.add(revealTargets, "logoMaxMul", 0, 20, 0.01).name("max mul (red=1)");
      logoFolder.add(logoCurve, "value", 0.1, 6, 0.01).name("curve");
      logoFolder.add(revealTargets, "logoWhiteStrength", 0, 10, 0.01).name("line power");
      logoFolder.add(lineFalloff, "value", 1, 6, 0.01).name("line falloff");
      logoFolder.add(diagonalBoost, "value", 0, 3, 0.01).name("diagonal boost");

      const particlesFolder = gui.addFolder("particles");
      particlesFolder.add(pointSize, "value", 0.5, 40, 0.1).name("point size");
      particlesFolder.add(maxParticlePixels, "value", 1, 50, 0.5).name("max pixels");

      const clustersFolder = gui.addFolder("clusters (3D noise)");
      clustersFolder.add(clusterStrength, "value", 0, 1, 0.01).name("strength");
      clustersFolder.add(clusterScale, "value", 0.001, 0.2, 0.001).name("scale");
      clustersFolder.add(clusterContrast, "value", 0.2, 6, 0.01).name("contrast");

      const clustersFolder2 = gui.addFolder("clusters #2 (3D noise)");
      clustersFolder2.add(clusterStrength2, "value", 0, 1, 0.01).name("strength");
      clustersFolder2.add(clusterScale2, "value", 0.001, 0.2, 0.001).name("scale");
      clustersFolder2.add(clusterContrast2, "value", 0.2, 6, 0.01).name("contrast");

      const twinkleFolder = gui.addFolder("twinkle");
      twinkleFolder.add(twinkleStrength, "value", 0, 1, 0.01).name("strength");
      twinkleFolder.add(twinkleSpeed, "value", 0, 2, 0.01).name("speed");

      // Camera / sky / hover-debug controls require the scene effect to have
      // populated its handles. The scene effect runs first and is synchronous
      // up to and including this assignment, so by the time this dynamic
      // import resolves, `sceneRef.current` is set.
      const scene = sceneRef.current;
      if (!scene) return;

      const hoverFolder = gui.addFolder("hover");
      hoverFolder
        .add(scene.hoverDebug, "mode", [
          "off",
          "density",
          "densityCopy",
          "velocity",
          "velocityCopy",
        ])
        .name("debug view");
      hoverFolder.add(splatRadius, "value", 0.01, 0.5, 0.005).name("splat radius");
      hoverFolder.add(splatStrength, "value", 0, 200, 0.5).name("splat strength");
      hoverFolder.add(densityDecay, "value", 0.5, 0.999, 0.001).name("density decay");
      hoverFolder.add(velocitySplatStrength, "value", 0, 16, 0.05).name("vel splat str");
      hoverFolder.add(velocityDecay, "value", 0.9, 1, 0.001).name("velocity decay");
      hoverFolder.add(advectionStrength, "value", 0, 0.5, 0.001).name("advection str");
      hoverFolder.add(hoverStrength, "value", 0, 16, 0.1).name("hover strength");

      const cameraFolder = gui.addFolder("camera");
      cameraFolder
        .add(scene.camera, "fov", 30, 120, 1)
        .name("FOV")
        .onChange(() => {
          scene.camera.updateProjectionMatrix();
          halfFovTan.value = Math.tan((scene.camera.fov * Math.PI) / 180 / 2);
        });

      const skyFolder = gui.addFolder("sky");
      skyFolder
        .add(scene.params, "bandCount", 0, 250_000, 1000)
        .name("band count")
        .onFinishChange(() => scene.regenerateSky());
      skyFolder.add(fieldStrength, "value", 0, 2, 0.01).name("field strength");
      skyFolder
        .add(scene.params, "fieldCount", 0, 150_000, 1000)
        .name("field count")
        .onFinishChange(() => scene.regenerateSky());
      skyFolder
        .add(scene.params, "bandThickness", 0.01, 0.6, 0.005)
        .name("band thickness")
        .onChange(() => scene.regenerateSky());
      skyFolder
        .add(scene.params, "brightFraction", 0, 0.1, 0.001)
        .name("bright fraction")
        .onFinishChange(() => scene.regenerateSky());
      skyFolder
        .add(scene.params, "band2Offset", -Math.PI / 2, Math.PI / 2, 0.005)
        .name("band 2 offset")
        .onChange(() => scene.regenerateSky());
      skyFolder.add(scene.sky.rotation, "z", -Math.PI, Math.PI, 0.001).name("rotation Z");
      skyFolder.add(scene.sky.rotation, "x", -Math.PI, Math.PI, 0.001).name("rotation X");
      skyFolder.add(scene.sky.rotation, "y", -Math.PI, Math.PI, 0.001).name("rotation Y");
    });

    return () => {
      cancelled = true;
      gui?.destroy();
    };
  }, []);

  // Mobile stays bounded to the logo row; desktop intentionally expands to the viewport.
  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 min-[740px]:fixed"
    />
  );
}
