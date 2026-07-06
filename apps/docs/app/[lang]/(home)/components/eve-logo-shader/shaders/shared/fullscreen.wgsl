// Shared non-entry fullscreen triangle helpers.
// INVARIANT: entry shaders keep their own vertex-stage wrappers to avoid duplicate entrypoints.
// The returned UV orientation matches the pre-split fullscreen triangle convention.

export fn fullscreen_clip_position(vertexIndex: u32) -> vec4f {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0),
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

export fn fullscreen_uv(vertexIndex: u32) -> vec2f {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0),
  );
  let position = positions[vertexIndex];
  return position * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
}
