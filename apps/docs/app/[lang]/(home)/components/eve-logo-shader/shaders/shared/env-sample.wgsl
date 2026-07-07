import { cube_lookup_uv_face } from "./cube-face.wgsl";

// Shared environment sampling helpers for eve logo material/background shaders.
// INVARIANT: yaw then pitch rotation order matches the pre-split cube-sample module.
// Textures and sampler are always supplied by entry shaders; this file declares no bindings.

export fn rotate_y(direction: vec3f, yaw: f32) -> vec3f {
  let s = sin(yaw);
  let c = cos(yaw);
  return normalize(vec3f(direction.x * c - direction.z * s, direction.y, direction.x * s + direction.z * c));
}

export fn rotate_x(direction: vec3f, pitch: f32) -> vec3f {
  let s = sin(pitch);
  let c = cos(pitch);
  return normalize(vec3f(direction.x, direction.y * c - direction.z * s, direction.y * s + direction.z * c));
}

export fn rotate_env(direction: vec3f, yaw: f32, pitch: f32) -> vec3f {
  return rotate_x(rotate_y(direction, yaw), pitch);
}

export fn sample_cubemap_array(envCube: texture_2d_array<f32>, envSampler: sampler, direction: vec3f) -> vec3f {
  let lookup = cube_lookup_uv_face(direction);
  return textureSample(envCube, envSampler, lookup.xy, i32(lookup.z)).rgb;
}

export fn sample_env(
  envCube: texture_2d_array<f32>,
  envSampler: sampler,
  direction: vec3f,
  yaw: f32,
  pitch: f32,
) -> vec3f {
  return sample_cubemap_array(envCube, envSampler, rotate_env(direction, yaw, pitch));
}
