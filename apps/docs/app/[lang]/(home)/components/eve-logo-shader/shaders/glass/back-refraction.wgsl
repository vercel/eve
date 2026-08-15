// Back-surface refraction helpers for the front glass entry shader.
// INVARIANT: texture/sampler resources are passed as parameters; this module declares no bindings.
// INVARIANT: fallback 1x1 back-depth texture means zero thickness and disables blur.

const VOGEL_SAMPLE_COUNT = 16u;
const GOLDEN_ANGLE = 2.399963229728653;
const MAX_BACK_BLUR_RADIUS_UV = 0.01;
const BACK_BLUR_SIGMA = 0.4;
const BACK_MIN_TRANSMISSION = 0.38;
const BACK_ABSORPTION_TINT = vec3f(0.9);
const TAU = 6.28318530718;

export fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

export fn normalized_thickness(
  backDepthTexture: texture_2d<f32>,
  cameraAxisDepth: f32,
  thicknessScale: f32,
  pixel: vec2i,
  backSize: vec2i,
) -> f32 {
  // A 1x1 back-depth texture is the fallback used by renderers that have not produced a real
  // back depth map. Treat it as zero thickness so the blur remains disabled there.
  if (backSize.x <= 1 || backSize.y <= 1 || !all(pixel >= vec2i(0)) || !all(pixel < backSize)) {
    return 0.0;
  }

  let backCameraAxisDepth = textureLoad(backDepthTexture, pixel, 0).r;
  let thickness = max(backCameraAxisDepth - cameraAxisDepth, 0.0);
  return clamp(thickness / max(thicknessScale, 0.000001), 0.0, 1.0);
}

fn vogel_gaussian_blur(
  backMaterialTexture: texture_2d<f32>,
  backSampler: sampler,
  uv: vec2f,
  blurRadius: f32,
  baseRotation: f32,
) -> vec3f {
  var color = vec3f(0.0);
  var totalWeight = 0.0;

  for (var i = 0u; i < VOGEL_SAMPLE_COUNT; i = i + 1u) {
    let fi = f32(i);
    let vogelRadius = sqrt((fi + 0.5) / f32(VOGEL_SAMPLE_COUNT));
    let theta = fi * GOLDEN_ANGLE + baseRotation;
    let sampleUv = uv + vec2f(cos(theta), sin(theta)) * vogelRadius * blurRadius;
    let sigma = max(BACK_BLUR_SIGMA, 0.0001);
    let weight = exp(-(vogelRadius * vogelRadius) / (2.0 * sigma * sigma));
    color += textureSampleLevel(backMaterialTexture, backSampler, sampleUv, 0.0).rgb * weight;
    totalWeight += weight;
  }

  return color / max(totalWeight, 0.0001);
}

export fn blurred_back_contribution(
  backMaterialTexture: texture_2d<f32>,
  backDepthTexture: texture_2d<f32>,
  backSampler: sampler,
  uv: vec2f,
  pixel: vec2i,
  cameraAxisDepth: f32,
  thicknessScale: f32,
  glassAbsorption: f32,
) -> vec3f {
  let normalizedThickness = normalized_thickness(
    backDepthTexture,
    cameraAxisDepth,
    thicknessScale,
    pixel,
    vec2i(textureDimensions(backDepthTexture)),
  );
  let blurRadius = normalizedThickness * MAX_BACK_BLUR_RADIUS_UV;
  let baseVogelRotation = hash12(uv) * TAU;
  let blurredBackContribution = vogel_gaussian_blur(backMaterialTexture, backSampler, uv, blurRadius, baseVogelRotation);
  let thicknessFade = pow(clamp(normalizedThickness, 0.0, 1.0), 0.5);
  let absorptionFade = thicknessFade * glassAbsorption;
  let transmission = mix(1.0, BACK_MIN_TRANSMISSION, absorptionFade);
  let absorptionTint = mix(vec3f(1.0), BACK_ABSORPTION_TINT, absorptionFade);
  return blurredBackContribution * transmission * absorptionTint;
}
