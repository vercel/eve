import { oriented_normal, env_reflect_dir, env_reflection_from_dir, encode_normal } from "../shared/material-core.wgsl";
import { Params, VertexInput, VertexOutput, WIRE_PASS_THRESHOLD, glass_vs_main, is_back_facing_to_camera } from "../shared/glass-common.wgsl";
import { shade_glass } from "../shared/glass-material.wgsl";
import { ascii_imprint_coverage } from "../shared/ascii-imprint.wgsl";

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var studioCube: texture_2d_array<f32>;
@group(0) @binding(2) var studioSampler: sampler;
@group(0) @binding(3) var backMaterial: texture_2d<f32>;
@group(0) @binding(4) var backDepth: texture_2d<f32>;

const VOGEL_SAMPLE_COUNT = 16u;
const GOLDEN_ANGLE = 2.399963229728653;
const MAX_BACK_BLUR_RADIUS_UV = 0.01;
const BACK_BLUR_SIGMA = 0.4;
const BACK_MIN_TRANSMISSION = 0.38;
const BACK_ABSORPTION_TINT = vec3f(0.9);
const TAU = 6.28318530718;
const FRONT_GATE_START = 0.55;
const FRONT_GATE_FULL = 0.80;
const IMPRINT_EMISSIVE = vec3f(2.5);
const ASCII_OPACITY_BOTTOM_Y = 0.;
const ASCII_OPACITY_TOP_Y = 0.3;
const ASCII_OPACITY_BOTTOM_LIGHT = 0.3;
const ASCII_OPACITY_BOTTOM_DARK = 0.1;
const ASCII_OPACITY_TOP = 1.0;
const ASCII_OPACITY_CURVE_POWER = 2.0;

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn normalized_thickness(input: VertexOutput, pixel: vec2i, backSize: vec2i) -> f32 {
  // A 1x1 back-depth texture is the fallback used by renderers that have not produced a real
  // back depth map. Treat it as zero thickness so the blur remains disabled there.
  if (backSize.x <= 1 || backSize.y <= 1 || !all(pixel >= vec2i(0)) || !all(pixel < backSize)) {
    return 0.0;
  }

  let backCameraAxisDepth = textureLoad(backDepth, pixel, 0).r;
  let thickness = max(backCameraAxisDepth - input.cameraAxisDepth, 0.0);
  return clamp(thickness / max(params.thicknessScale, 0.000001), 0.0, 1.0);
}

fn vogel_gaussian_blur(uv: vec2f, blurRadius: f32, baseRotation: f32) -> vec3f {
  var color = vec3f(0.0);
  var totalWeight = 0.0;

  for (var i = 0u; i < VOGEL_SAMPLE_COUNT; i = i + 1u) {
    let fi = f32(i);
    let vogelRadius = sqrt((fi + 0.5) / f32(VOGEL_SAMPLE_COUNT));
    let theta = fi * GOLDEN_ANGLE + baseRotation;
    let sampleUv = uv + vec2f(cos(theta), sin(theta)) * vogelRadius * blurRadius;
    let sigma = max(BACK_BLUR_SIGMA, 0.0001);
    let weight = exp(-(vogelRadius * vogelRadius) / (2.0 * sigma * sigma));
    color += textureSampleLevel(backMaterial, studioSampler, sampleUv, 0.0).rgb * weight;
    totalWeight += weight;
  }

  return color / max(totalWeight, 0.0001);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  return glass_vs_main(input, params);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let ngeo = normalize(input.normal);
  let v = normalize(input.viewDir);

  if (params.passKind > WIRE_PASS_THRESHOLD) {
    // Scene pass is linear HDR; this constant is the previous display grey converted to linear.
    return vec4f(pow(vec3f(0.93), vec3f(2.2)), 0.55);
  }

  let n = oriented_normal(ngeo, v);
  let reflected = env_reflect_dir(n, v);

  // Front material: only render fragments facing the camera.
  if (is_back_facing_to_camera(ngeo, v)) {
    discard;
  }

  let materialKind = u32(clamp(round(params.materialKind), 0.0, 4.0));
  switch (materialKind) {
    case 4u: {
      let backSize = vec2i(textureDimensions(backDepth));
      let pixel = vec2i(input.clipPosition.xy);
      let normalizedThickness = normalized_thickness(input, pixel, backSize);
      return vec4f(vec3f(normalizedThickness), 1.0);
    }
    case 1u: {
      return vec4f(encode_normal(n), 1.0);
    }
    case 2u: {
      return vec4f(encode_normal(reflected), 1.0);
    }
    case 3u: {
      return vec4f(env_reflection_from_dir(studioCube, studioSampler, reflected, params.envYaw, params.envPitch), 1.0);
    }
    default: {
      var glass = shade_glass(studioCube, studioSampler, n, v, reflected, params.envYaw, params.envPitch, false, params.glassAbsorption);
      let backSize = vec2i(textureDimensions(backMaterial));
      let pixel = vec2i(input.clipPosition.xy);
      if (all(pixel >= vec2i(0)) && all(pixel < backSize)) {
        let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(backSize);
        let normalizedThickness = normalized_thickness(input, pixel, vec2i(textureDimensions(backDepth)));
        let blurRadius = normalizedThickness * MAX_BACK_BLUR_RADIUS_UV;
        let baseVogelRotation = hash12(uv) * TAU;
        let blurredBackContribution = vogel_gaussian_blur(uv, blurRadius, baseVogelRotation);
        let thicknessFade = pow(clamp(normalizedThickness, 0.0, 1.0), 0.5);
        let absorptionFade = thicknessFade * params.glassAbsorption;
        let transmission = mix(1.0, BACK_MIN_TRANSMISSION, absorptionFade);
        let absorptionTint = mix(vec3f(1.0), BACK_ABSORPTION_TINT, absorptionFade);
        let backContribution = blurredBackContribution * transmission * absorptionTint;
        // The main scene uses additive alpha blending (`src-alpha + one`). The offscreen back
        // texture already contains the blended back-side contribution, so divide by the front
        // alpha before returning to preserve the previous two-draw visual result.
        glass = vec4f(glass.rgb + backContribution / max(glass.a, 0.001), glass.a);
      }
      if (params.ascii0.x <= 0.0) {
        return glass;
      }

      let imprintProgress = clamp(params.ascii0.x, 0.0, 1.0);
      let glassVisibility = 1.0 - imprintProgress;
      let frontMask = smoothstep(FRONT_GATE_START, FRONT_GATE_FULL, ngeo.z);
      let verticalT = clamp(
        (input.modelPos.y - ASCII_OPACITY_BOTTOM_Y) / (ASCII_OPACITY_TOP_Y - ASCII_OPACITY_BOTTOM_Y),
        0.0,
        1.0,
      );
      let verticalCurve = pow(verticalT, ASCII_OPACITY_CURVE_POWER);
      let themeT = clamp(params.glassAbsorption, 0.0, 1.0);
      let asciiOpacityBottom = mix(ASCII_OPACITY_BOTTOM_LIGHT, ASCII_OPACITY_BOTTOM_DARK, themeT);
      let asciiOpacity = mix(asciiOpacityBottom, ASCII_OPACITY_TOP, verticalCurve);
      let coverage = ascii_imprint_coverage(
        input.modelPos.xy,
        params.ascii0.y,
        params.ascii0.z,
        params.ascii0.w,
        params.ascii1.xy,
        imprintProgress,
      ) * frontMask * asciiOpacity;
      // Fade the normal front-glass/env/back-blur contribution out as ASCII takes over.
      // ASCII coverage itself is not faded by this visibility term, so at p=1 only the
      // emissive imprint remains while non-ASCII glass becomes transparent.
      let fadedGlassAlpha = glass.a * glassVisibility;
      let fadedGlassContribution = glass.rgb * fadedGlassAlpha;
      let imprintColor = IMPRINT_EMISSIVE * clamp(params.glassAbsorption, 0.0, 1.0);
      let aNew = mix(fadedGlassAlpha, 1.0, coverage);
      let desired = mix(fadedGlassContribution, imprintColor, coverage);
      return vec4f(desired / max(aNew, 0.001), aNew);
    }
  }
}
