// Shared cubemap face mapping helpers for eve logo environment shaders.
// INVARIANT: face order is +X, -X, +Y, -Y, +Z, -Z for all bake/sample paths.
// INVARIANT: lookup UVs keep a small inset and the established Y conventions.

const CUBEMAP_UV_INSET = 0.001;

export fn cube_dir(face: f32, uv: vec2f) -> vec3f {
  let p = uv * 2.0 - vec2f(1.0);
  // WebGPU cube face order: +X, -X, +Y, -Y, +Z, -Z.
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
