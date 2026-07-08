import { sample_env } from "./env-sample.wgsl";

// Shared material/reflection primitives for eve-5 mesh materials.
// Keep camera-facing normal orientation and reflection direction here so glass,
// metallic, and reflected-normal diagnostics cannot drift apart.
export fn oriented_normal(ngeo: vec3f, v: vec3f) -> vec3f {
  let n = normalize(ngeo);
  let view = normalize(v);
  return select(n, -n, dot(n, view) < 0.0);
}

export fn env_reflect_dir(n: vec3f, v: vec3f) -> vec3f {
  return normalize(reflect(-normalize(v), normalize(n)));
}

export fn env_reflection_from_dir(
  envCube: texture_2d_array<f32>,
  envSampler: sampler,
  reflected: vec3f,
  envYaw: f32,
  envPitch: f32,
) -> vec3f {
  return sample_env(envCube, envSampler, reflected, envYaw, envPitch);
}

export fn encode_normal(n: vec3f) -> vec3f {
  return normalize(n) * 0.5 + vec3f(0.5);
}
