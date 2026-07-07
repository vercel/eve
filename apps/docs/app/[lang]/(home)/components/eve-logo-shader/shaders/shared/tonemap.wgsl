// Shared display transform helpers for eve logo postprocess passes.
// INVARIANT: tonemap is applied once, after HDR scene/bloom accumulation.
// Imported only by fullscreen composite entry shaders.

export const DISPLAY_GAMMA = 2.2;

export fn aces_tonemap(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + vec3f(b))) / (color * (c * color + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

export fn linear_to_display(color: vec3f) -> vec3f {
  return pow(max(color, vec3f(0.0)), vec3f(1.0 / DISPLAY_GAMMA));
}
