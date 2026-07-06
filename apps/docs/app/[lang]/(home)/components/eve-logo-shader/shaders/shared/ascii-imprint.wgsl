import { sd_box } from "./sdf.wgsl";
import { hash3, voronoi_cell_value_and_edge_3d } from "./voronoi.wgsl";
import { ASCII_BASE_DOT_RADIUS, ASCII_EDGE_SQUARE_HALF_SIZE, HOVER_ENTRY_START, HOVER_ENTRY_FULL, shape_distance, hover_shape_distance } from "./ascii-glyphs.wgsl";

// ASCII imprint combiner for front-glass coverage.
// INVARIANT: fwidth calls stay in this function's uniform control flow; do not move them behind non-uniform branches.
// Entry shaders provide textures/bindings and material masks; this module declares none.

const IMPRINT_VORONOI_FREQUENCY = 4.8;
const ASCII_VORONOI_Z_SPEED = 0.35;
const REVEAL_STAGGER_WINDOW = 0.25;
export const HOVER_OVERLAY_SCALE = 0.5; // scales hover spinner-glyph opacity only

export fn ascii_voronoi_noise_for_cell(modelPosXY: vec2f, gridScale: f32, time: f32) -> vec2f {
  let safeGridScale = max(gridScale, 0.001);
  let gridPosition = modelPosXY * safeGridScale;
  let cellCoord = floor(gridPosition);
  let cellCenter = (cellCoord + vec2f(0.5)) / safeGridScale;
  let samplePosition = vec3f(cellCenter * IMPRINT_VORONOI_FREQUENCY, time * ASCII_VORONOI_Z_SPEED);
  return voronoi_cell_value_and_edge_3d(samplePosition);
}

// Returns glyph coverage 0..1 for a model-space X/Y position. The caller applies the
// geometric front-face mask so this module stays independent of material normals.
export fn ascii_imprint_coverage(modelPosXY: vec2f, gridScale: f32, glyphScale: f32, time: f32, mouse: vec2f, prog: f32, hover: f32, voronoi: vec2f) -> f32 {
  let safeProgress = clamp(prog, 0.0, 1.0);
  let safeHover = clamp(hover, 0.0, 1.0);

  let safeGridScale = max(gridScale, 0.001);
  let safeGlyphScale = max(glyphScale, 0.1);
  let gridPosition = modelPosXY * safeGridScale;
  let cellCoord = floor(gridPosition);
  let glyphUv = fract(gridPosition);
  let p = (glyphUv - vec2f(0.5)) * 2.0;

  let cellValue = voronoi.x;
  let edgeMask = voronoi.y;

  let scaledP = p / safeGlyphScale;
  let baseDotDistance = (length(scaledP) - ASCII_BASE_DOT_RADIUS) * safeGlyphScale;
  let selectedGlyphDistance = shape_distance(scaledP, cellValue) * safeGlyphScale;
  let hoverGlyphDistance = hover_shape_distance(scaledP, safeHover) * safeGlyphScale;
  let baseDotAa = max(fwidth(baseDotDistance), 0.01);
  let selectedGlyphAa = max(fwidth(selectedGlyphDistance), 0.01);
  let hoverGlyphAa = max(fwidth(hoverGlyphDistance), 0.01);
  let baseDotCoverage = 1.0 - smoothstep(0.0, baseDotAa, baseDotDistance);
  let selectedGlyphCoverage = 1.0 - smoothstep(0.0, selectedGlyphAa, selectedGlyphDistance);
  let hoverGlyphCoverage = 1.0 - smoothstep(0.0, hoverGlyphAa, hoverGlyphDistance);
  let hoverEntry = smoothstep(HOVER_ENTRY_START, HOVER_ENTRY_FULL, safeHover);
  let selectedCoverage = selectedGlyphCoverage;
  let interiorGlyph = max(selectedCoverage, baseDotCoverage);
  let edgeGlyphDistance = sd_box(scaledP, vec2f(ASCII_EDGE_SQUARE_HALF_SIZE)) * safeGlyphScale;
  let edgeGlyphAa = max(fwidth(edgeGlyphDistance), 0.01);
  let edgeGlyphCoverage = (1.0 - smoothstep(0.0, edgeGlyphAa, edgeGlyphDistance)) * edgeMask;
  // The noisy ASCII chain is controlled only by imprint progress: random selected glyph,
  // minimum dot, Voronoi edge square, then per-cell stagger reveal.
  let imprintGlyph = max(interiorGlyph, edgeGlyphCoverage);

  let cellRand = hash3(vec3i(vec2i(cellCoord), 0));
  // Spread each cell's 0.25-wide reveal window across the full transition instead of scaling
  // progress by the stagger range. This keeps p=0.5 as a true mid-state while preserving exact
  // endpoints: p=0 reveals no cells, p=1 reveals every cell fully.
  let revealStart = cellRand * (1.0 - REVEAL_STAGGER_WINDOW);
  let staggerReveal = smoothstep(revealStart, revealStart + REVEAL_STAGGER_WINDOW, safeProgress);
  let imprintCoverage = imprintGlyph * staggerReveal;

  // Paint reveal is independent from the noise chain. On glass (progress=0) this contributes
  // only the clean station ramp; in ASCII mode it cleanly overrides the selected glyph while
  // the base dots/edge squares remain part of the imprint chain.
  let hoverCoverage = hoverGlyphCoverage * hoverEntry * HOVER_OVERLAY_SCALE;
  // Hard per-cell switchover: once hover passes the entry threshold, the entire cell shows
  // only the spinner glyph; otherwise only the imprint glyph contributes.
  let hoverGate = step(HOVER_ENTRY_START, safeHover);
  return mix(imprintCoverage, hoverCoverage, hoverGate);
}
