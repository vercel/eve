// Shared hash and animated 3D Voronoi core for ASCII imprint noise.
// INVARIANT: constants match 7.10 visuals: frequency 4.8, edge 0.04/0.02 at call sites.
// Hash salts and F2-F1 edge math are unchanged from the duplicated implementations.

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

const VORONOI_EDGE_WIDTH = 0.04;
const VORONOI_EDGE_SOFTNESS = 0.02;

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
