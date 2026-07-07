import { ascii_voronoi_noise_for_cell } from "../shared/ascii-imprint.wgsl";

// Paint and animated Voronoi texture readers for the front glass entry shader.
// INVARIANT: r32float textures are sampled with textureLoad only; no filtering.
// Texture resources are passed as parameters; this module declares no bindings.

export fn model_cell_index(modelPosXY: vec2f, gridScale: f32, originCellValue: vec2f) -> vec2i {
  let originCell = vec2i(i32(originCellValue.x), i32(originCellValue.y));
  return vec2i(floor(modelPosXY * gridScale)) - originCell;
}

export fn sample_paint(
  paintTexture: texture_2d<f32>,
  modelPosXY: vec2f,
  gridScale: f32,
  originCellValue: vec2f,
) -> f32 {
  // Front pass reads the paint buffer by ASCII cell with textureLoad only.
  // Renderer stores the negative-bound origin in ascii1.zw so writer/reader use
  // identical model-space -> cell mapping, including cells left/below model zero.
  let dims = vec2i(textureDimensions(paintTexture));
  let cell = model_cell_index(modelPosXY, gridScale, originCellValue);
  if (any(cell < vec2i(0)) || any(cell >= dims)) {
    return 0.0;
  }
  return textureLoad(paintTexture, cell, 0).r;
}

export fn sample_ascii_voronoi(
  asciiVoronoiValueTexture: texture_2d<f32>,
  asciiVoronoiEdgeTexture: texture_2d<f32>,
  modelPosXY: vec2f,
  gridScale: f32,
  time: f32,
  originCellValue: vec2f,
) -> vec2f {
  // Voronoi noise is animated in z, so the renderer refreshes these two r32 textures once
  // per frame at the ASCII-cell lattice resolution. The coverage code still computes
  // derivatives for glyph edges procedurally; only the per-cell random value/edge mask moves.
  let dims = vec2i(textureDimensions(asciiVoronoiValueTexture));
  let cell = model_cell_index(modelPosXY, gridScale, originCellValue);
  if (any(cell < vec2i(0)) || any(cell >= dims)) {
    return ascii_voronoi_noise_for_cell(modelPosXY, gridScale, time);
  }
  return vec2f(
    textureLoad(asciiVoronoiValueTexture, cell, 0).r,
    textureLoad(asciiVoronoiEdgeTexture, cell, 0).r,
  );
}
