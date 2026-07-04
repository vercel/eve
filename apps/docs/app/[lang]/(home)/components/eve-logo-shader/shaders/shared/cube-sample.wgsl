// Shared cubemap utilities for eve-5 shaders.
// Face order is the repo convention used throughout eve-5: +X, -X, +Y, -Y, +Z, -Z.

const CUBEMAP_UV_INSET = 0.001;

export fn cube_dir(face: f32, uv: vec2f) -> vec3f {
  let p = uv * 2.0 - vec2f(1.0);
  if (face < 0.5) {
    return normalize(vec3f(1.0, -p.y, -p.x));
  }
  if (face < 1.5) {
    return normalize(vec3f(-1.0, -p.y, p.x));
  }
  if (face < 2.5) {
    return normalize(vec3f(p.x, 1.0, p.y));
  }
  if (face < 3.5) {
    return normalize(vec3f(p.x, -1.0, -p.y));
  }
  if (face < 4.5) {
    return normalize(vec3f(p.x, -p.y, 1.0));
  }
  return normalize(vec3f(-p.x, -p.y, -1.0));
}

export fn cube_lookup_uv_face(direction: vec3f) -> vec3f {
  let dir = normalize(direction);
  let ad = abs(dir);
  var face = 0.0;
  var p = vec2f(0.0);

  if (ad.x >= ad.y && ad.x >= ad.z) {
    if (dir.x > 0.0) {
      face = 0.0;
      p = vec2f(-dir.z / ad.x, -dir.y / ad.x);
    } else {
      face = 1.0;
      p = vec2f(dir.z / ad.x, -dir.y / ad.x);
    }
  } else if (ad.y >= ad.x && ad.y >= ad.z) {
    if (dir.y > 0.0) {
      face = 2.0;
      p = vec2f(dir.x / ad.y, dir.z / ad.y);
    } else {
      face = 3.0;
      p = vec2f(dir.x / ad.y, -dir.z / ad.y);
    }
  } else {
    if (dir.z > 0.0) {
      face = 4.0;
      p = vec2f(dir.x / ad.z, -dir.y / ad.z);
    } else {
      face = 5.0;
      p = vec2f(-dir.x / ad.z, -dir.y / ad.z);
    }
  }

  let uv = clamp(p * 0.5 + vec2f(0.5), vec2f(CUBEMAP_UV_INSET), vec2f(1.0 - CUBEMAP_UV_INSET));
  return vec3f(uv, face);
}

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

export fn sample_cubemap_array_yaw(envCube: texture_2d_array<f32>, envSampler: sampler, direction: vec3f, yaw: f32) -> vec3f {
  return sample_cubemap_array(envCube, envSampler, rotate_y(direction, yaw));
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

export fn sample_cubemap_array_level(envCube: texture_2d_array<f32>, envSampler: sampler, direction: vec3f) -> vec3f {
  let lookup = cube_lookup_uv_face(direction);
  return textureSampleLevel(envCube, envSampler, lookup.xy, i32(lookup.z), 0.0).rgb;
}

export fn aces_tonemap(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + vec3f(b))) / (color * (c * color + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

export fn linear_to_display(color: vec3f) -> vec3f {
  return pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2));
}
