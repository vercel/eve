// Shared 2D signed-distance primitives for ASCII glyph shaders.
// INVARIANT: formulas are the pre-split ascii-imprint SDFs; glyph scale is applied by callers.
// No entrypoints or bindings are declared here.

export fn sd_box(p: vec2f, halfSize: vec2f) -> f32 {
  let q = abs(p) - halfSize;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

export fn sd_equilateral_triangle(p0: vec2f) -> f32 {
  let k = sqrt(3.0);
  var p = p0;
  p.x = abs(p.x) - 0.42;
  p.y = p.y + 0.24;
  if (p.x + k * p.y > 0.0) {
    p = vec2f(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x = p.x - clamp(p.x, -0.84, 0.0);
  return -length(p) * sign(p.y);
}

export fn sd_rotated_box(p: vec2f, halfSize: vec2f, angle: f32) -> f32 {
  let s = sin(angle);
  let c = cos(angle);
  let rotated = vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
  return sd_box(rotated, halfSize);
}
