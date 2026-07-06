import { sd_box, sd_equilateral_triangle, sd_rotated_box } from "./sdf.wgsl";

// Shared ASCII glyph selection and hover-station distances.
// INVARIANT: true SDF-value interpolation in hover_shape_distance is preserved.
// The caller owns fwidth/coverage so derivatives stay in uniform control flow.

export const ASCII_BASE_DOT_RADIUS = 0.075;
export const ASCII_EDGE_SQUARE_HALF_SIZE = 0.22;
export const HOVER_ENTRY_START = 0.020;
export const HOVER_ENTRY_FULL = 1.;

export fn shape_distance(p: vec2f, value: f32) -> f32 {
  if (value < 0.002) {
    return 1.0;
  }
  // Luminance/noise selects the glyph only. Keep each glyph's dimensions fixed so
  // glyph size is controlled by grid geometry and the glyphScale uniform, not value.
  // Phase 3 removes triangles from this base set. The freed upper band is folded
  // into circle/square so paint=0 keeps the same dot/dash/circle/square character.
  if (value < 0.18) {
    return length(p) - ASCII_BASE_DOT_RADIUS;
  }
  if (value < 0.36) {
    return length(p) - 0.145;
  }
  if (value < 0.58) {
    return sd_box(p, vec2f(0.27, 0.055));
  }
  if (value < 0.80) {
    return length(p) - 0.235;
  }
  return sd_box(p, vec2f(0.255, 0.255));
}

fn hover_station_distance(p: vec2f, station: i32) -> f32 {
  if (station <= 0) {
    return sd_rotated_box(p, vec2f(0.28, 0.05), 1.57079632679);
  }
  if (station == 1) {
    return sd_rotated_box(p, vec2f(0.28, 0.05), 0.78539816339);
  }
  if (station == 2) {
    return sd_rotated_box(p, vec2f(0.28, 0.05), -0.78539816339);
  }
  if (station == 3) {
    return sd_box(p, vec2f(0.20, 0.045));
  }
  if (station == 4) {
    return sd_box(p, vec2f(0.31, 0.055));
  }
  let scale = 0.66;
  return sd_equilateral_triangle(p / scale) * scale;
}

export fn hover_shape_distance(p: vec2f, hover: f32) -> f32 {
  // Paint drives only this clean station ramp: | -> / -> \ -> – -> — -> triangle.
  // Squares stay exclusive to base noise.
  // The base noise-selected glyph is not part of the paint-only glass reveal.
  let t = clamp((hover - HOVER_ENTRY_START) / (1.0 - HOVER_ENTRY_START), 0.0, 1.0);
  let stationPosition = t * 5.0;
  let station = min(i32(floor(stationPosition)), 4);
  let f = stationPosition - f32(station);
  let fs = f * f * (3.0 - 2.0 * f);
  return mix(hover_station_distance(p, station), hover_station_distance(p, station + 1), fs);
}
