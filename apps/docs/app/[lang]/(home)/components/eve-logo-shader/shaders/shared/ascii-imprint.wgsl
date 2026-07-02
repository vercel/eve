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

export fn hash_u32(value: u32) -> u32 {
  var x = value;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

export fn hash3(cell: vec3i) -> f32 {
  let ux = bitcast<u32>(cell.x);
  let uy = bitcast<u32>(cell.y);
  let uz = bitcast<u32>(cell.z);
  let mixed = (ux * 0x8da6b343u) ^ (uy * 0xd8163841u) ^ (uz * 0xcb1ab31fu);
  return f32(hash_u32(mixed) & 0x00ffffffu) / 16777215.0;
}

fn hash3_feature_point(cell: vec3i) -> vec3f {
  return vec3f(
    hash3(cell + vec3i(17, 59, 113)),
    hash3(cell + vec3i(101, 191, 53)),
    hash3(cell + vec3i(47, 223, 149)),
  );
}

const VORONOI_EDGE_WIDTH = 0.08;
const VORONOI_EDGE_SOFTNESS = 0.04;

export fn voronoi_cell_value_and_edge_3d(p: vec3f) -> vec2f {
  let baseCell = vec3i(floor(p));
  let localPosition = fract(p);
  var nearestDistanceSquared = 1000.0;
  var secondNearestDistanceSquared = 1000.0;
  var winningCell = baseCell;

  for (var z = -1; z <= 1; z = z + 1) {
    for (var y = -1; y <= 1; y = y + 1) {
      for (var x = -1; x <= 1; x = x + 1) {
        let neighborOffset = vec3i(x, y, z);
        let neighborCell = baseCell + neighborOffset;
        let featurePoint = vec3f(neighborOffset) + hash3_feature_point(neighborCell);
        let delta = featurePoint - localPosition;
        let distanceSquared = dot(delta, delta);
        if (distanceSquared < nearestDistanceSquared) {
          secondNearestDistanceSquared = nearestDistanceSquared;
          nearestDistanceSquared = distanceSquared;
          winningCell = neighborCell;
        } else if (distanceSquared < secondNearestDistanceSquared) {
          secondNearestDistanceSquared = distanceSquared;
        }
      }
    }
  }

  // Hard-cell Voronoi: the nearest feature cell gets one random value for glyph type.
  // The F2-F1 gap controls a pure-white edge overlay, while interiors keep the full
  // random-selected glyph instead of being masked away.
  let cellValue = hash3(winningCell + vec3i(211, 37, 173));
  let edgeGap = sqrt(secondNearestDistanceSquared) - sqrt(nearestDistanceSquared);
  let edgeMask = 1.0 - smoothstep(VORONOI_EDGE_WIDTH, VORONOI_EDGE_WIDTH + VORONOI_EDGE_SOFTNESS, edgeGap);
  return vec2f(cellValue, edgeMask);
}

const ASCII_BASE_DOT_RADIUS = 0.075;
const ASCII_EDGE_SQUARE_HALF_SIZE = 0.22;

export fn shape_distance(p: vec2f, value: f32) -> f32 {
  if (value < 0.002) {
    return 1.0;
  }
  // Luminance/noise selects the glyph only. Keep each glyph's dimensions fixed so
  // glyph size is controlled by grid geometry and the glyphScale uniform, not value.
  if (value < 0.18) {
    return length(p) - ASCII_BASE_DOT_RADIUS;
  }
  if (value < 0.36) {
    return length(p) - 0.145;
  }
  if (value < 0.58) {
    return sd_box(p, vec2f(0.27, 0.055));
  }
  if (value < 0.78) {
    return length(p) - 0.235;
  }
  if (value < 0.93) {
    let scale = 0.66;
    return sd_equilateral_triangle(p / scale) * scale;
  }
  return sd_box(p, vec2f(0.255, 0.255));
}

const IMPRINT_VORONOI_FREQUENCY = 2.4;
const ASCII_VORONOI_Z_SPEED = 0.35;
const REVEAL_STAGGER_WINDOW = 0.25;

// Returns glyph coverage 0..1 for a model-space X/Y position. The caller applies the
// geometric front-face mask so this module stays independent of material normals.
export fn ascii_imprint_coverage(modelPosXY: vec2f, gridScale: f32, glyphScale: f32, time: f32, mouse: vec2f, prog: f32) -> f32 {
  let safeProgress = clamp(prog, 0.0, 1.0);
  if (safeProgress <= 0.0) {
    return 0.0;
  }

  let safeGridScale = max(gridScale, 0.001);
  let safeGlyphScale = max(glyphScale, 0.1);
  let gridPosition = modelPosXY * safeGridScale;
  let cellCoord = floor(gridPosition);
  let cellCenter = (cellCoord + vec2f(0.5)) / safeGridScale;
  let glyphUv = fract(gridPosition);
  let p = (glyphUv - vec2f(0.5)) * 2.0;

  let samplePosition = vec3f(cellCenter * IMPRINT_VORONOI_FREQUENCY, time * ASCII_VORONOI_Z_SPEED);
  let voronoi = voronoi_cell_value_and_edge_3d(samplePosition);
  let cellValue = voronoi.x;
  let edgeMask = voronoi.y;

  let scaledP = p / safeGlyphScale;
  let baseDotDistance = (length(scaledP) - ASCII_BASE_DOT_RADIUS) * safeGlyphScale;
  let selectedGlyphDistance = shape_distance(scaledP, cellValue) * safeGlyphScale;
  let baseDotAa = max(fwidth(baseDotDistance), 0.01);
  let selectedGlyphAa = max(fwidth(selectedGlyphDistance), 0.01);
  let baseDotCoverage = 1.0 - smoothstep(0.0, baseDotAa, baseDotDistance);
  let selectedGlyphCoverage = 1.0 - smoothstep(0.0, selectedGlyphAa, selectedGlyphDistance);
  let interiorGlyph = max(selectedGlyphCoverage, baseDotCoverage);
  let edgeGlyphDistance = sd_box(scaledP, vec2f(ASCII_EDGE_SQUARE_HALF_SIZE)) * safeGlyphScale;
  let edgeGlyphAa = max(fwidth(edgeGlyphDistance), 0.01);
  let edgeGlyphCoverage = (1.0 - smoothstep(0.0, edgeGlyphAa, edgeGlyphDistance)) * edgeMask;
  // Draw the full random-selected glyph throughout each Voronoi region; the minimum dot only
  // prevents empty branches. F2-F1 edge proximity boosts a small SDF-shaped square at
  // boundaries instead of bypassing the SDF and filling the whole ASCII quad.
  let glyph = max(interiorGlyph, edgeGlyphCoverage);

  let cellRand = hash3(vec3i(vec2i(cellCoord), 0));
  // Spread each cell's 0.25-wide reveal window across the full transition instead of scaling
  // progress by the stagger range. This keeps p=0.5 as a true mid-state while preserving exact
  // endpoints: p=0 reveals no cells, p=1 reveals every cell fully.
  let revealStart = cellRand * (1.0 - REVEAL_STAGGER_WINDOW);
  let reveal = smoothstep(revealStart, revealStart + REVEAL_STAGGER_WINDOW, safeProgress);
  return glyph * reveal;
}
