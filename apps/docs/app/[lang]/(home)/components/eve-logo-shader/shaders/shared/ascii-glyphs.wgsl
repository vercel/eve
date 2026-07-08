import { sd_box, sd_equilateral_triangle, sd_rotated_box } from "./sdf.wgsl";

// Shared ASCII glyph selection and hover-station distances.
// INVARIANT: true SDF-value interpolation in hover_shape_distance is preserved.
// The caller owns fwidth/coverage so derivatives stay in uniform control flow.

export const ASCII_BASE_DOT_RADIUS = 0.075;
export const ASCII_EDGE_SQUARE_HALF_SIZE = 0.22;
export const HOVER_ENTRY_START = 0.1;
export const HOVER_ENTRY_FULL = 0.5;

export fn shape_distance(p: vec2f, value: f32) -> f32 {
  if (value < 0.002) {
    return 1.0;
  }
  // Voronoi luminance now selects the spinner glyph ramp (| / \ – — ▲). Keep glyph dimensions
  // fixed so size is controlled by grid geometry and glyphScale, not value. After the tiny
  // empty band the remaining range is divided into six equal hard-switch stations.
  let normalizedValue = clamp((value - 0.002) / (1.0 - 0.002), 0.0, 1.0);
  let station = clamp(i32(floor(normalizedValue * 6.0)), 0, 5);
  return spinner_station_distance(p, station);
}

fn spinner_station_distance(p: vec2f, station: i32) -> f32 {
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

fn imprint_station_distance(p: vec2f, station: i32) -> f32 {
  if (station <= 0) {
    return length(p) - ASCII_BASE_DOT_RADIUS;
  }
  if (station == 1) {
    return length(p) - 0.145;
  }
  if (station == 2) {
    return sd_box(p, vec2f(0.27, 0.055));
  }
  if (station == 3) {
    return length(p) - 0.235;
  }
  return sd_box(p, vec2f(0.255, 0.255));
}

export fn hover_shape_distance(p: vec2f, hover: f32) -> f32 {
  // Paint drives only this clean station ramp: dot -> circle -> dash -> circle -> square.
  // Hard switch: each station covers an equal-length range; no blending between glyphs.
  let t = clamp((hover - HOVER_ENTRY_START) / (1.0 - HOVER_ENTRY_START), 0.0, 1.0);
  let station = clamp(i32(floor(t * 5.0)), 0, 4);
  return imprint_station_distance(p, station);
}
