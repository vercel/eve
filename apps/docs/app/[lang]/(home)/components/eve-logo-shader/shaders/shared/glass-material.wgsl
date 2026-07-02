import { env_reflection_from_dir } from "./material-core.wgsl";

const IOR_ACRYLIC = 1.49;
const F0_ACRYLIC = pow((IOR_ACRYLIC - 1.0) / (IOR_ACRYLIC + 1.0), 2.0);
// reflections-debug learning: pure dielectric F0 (~0.039) leaves flat head-on faces almost
// non-reflective, so the studio lights only appear at grazing edges. A small polished-acrylic
// specular floor keeps the reflection readable across the whole face while Fresnel still ramps
// reflectance up toward grazing angles.
const REFLECTION_FLOOR = 0.22;

export fn dielectric_fresnel_schlick(cosTheta: f32, f0: vec3f) -> vec3f {
  let m = clamp(1.0 - cosTheta, 0.0, 1.0);
  let factor = pow(m, 5.0);
  return f0 + (vec3f(1.0) - f0) * factor;
}

export fn beer_lambert_transmittance(absorption: vec3f, thickness: f32) -> vec3f {
  return exp(-absorption * thickness);
}

export fn shade_glass(
  studioCube: texture_2d_array<f32>,
  studioSampler: sampler,
  n: vec3f,
  v: vec3f,
  reflected: vec3f,
  envYaw: f32,
  envPitch: f32,
  inside: bool,
  absorptionStrength: f32,
) -> vec4f {
  let ndotv = clamp(dot(n, v), 0.0, 1.0);

  let fresnel = dielectric_fresnel_schlick(ndotv, vec3f(F0_ACRYLIC));
  // Learning from reflections-debug: a pure dielectric F0 (~0.039) makes head-on faces nearly
  // non-reflective, so flat logo faces look dim/flat and the studio lights only show at grazing
  // angles. Lift the specular floor so the polished-acrylic reflection reads across the face,
  // while still ramping up toward grazing via Fresnel.
  let specularReflectance = clamp(REFLECTION_FLOOR + fresnel, vec3f(0.0), vec3f(1.0));
  let clearcoatSample = env_reflection_from_dir(studioCube, studioSampler, reflected, envYaw, envPitch);
  // Learning from the cube-camera mirror test: artificial >1.0 reflection boosts make the
  // reflection brighter than the environment actually is (exaggerated). Keep the clearcoat a
  // true 1:1 reflection weighted only by the (energy-conserving) specular reflectance.
  let clearcoat = clearcoatSample * specularReflectance;

  // Approximate the visible air -> acrylic interface for both front and back passes
  // with the camera-facing normal, matching Three.js-style transmission direction.
  let refracted = refract(-v, n, 1.0 / IOR_ACRYLIC);
  let fallbackDir = normalize(mix(v, reflected, 0.25));
  let refractValid = dot(refracted, refracted) > 0.0;
  let transmissionDir = normalize(select(fallbackDir, refracted, refractValid));
  let baseSample = env_reflection_from_dir(studioCube, studioSampler, transmissionDir, envYaw, envPitch);

  let baseThickness = select(0.22, 0.14, inside);
  let approxThickness = clamp(baseThickness / max(ndotv, 0.08), 0.05, 2.0);
  let absorptionCoeff = vec3f(0.18) * absorptionStrength;
  let transmission = beer_lambert_transmittance(absorptionCoeff, approxThickness);
  let baseWeight = select(0.42, 0.28, inside);
  let baseContribution = baseSample * transmission * (vec3f(1.0) - fresnel) * baseWeight;

  // Removed the additive edgeLift haze: like the cube-camera mirror fix, a constant additive
  // term brightens the surface beyond what the environment provides and washes out contrast.
  let linearColor = clearcoat + baseContribution;

  let alphaBase = select(0.32, 0.22, inside);
  let alpha = clamp(alphaBase + fresnel.r * 0.12, 0.0, 1.0);

  return vec4f(linearColor, alpha);
}
