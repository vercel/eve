import { fullscreen_clip_position, fullscreen_uv } from "../shared/fullscreen.wgsl";

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

struct PaintParams {
  brushCell: vec2f,
  brushPreviousCell: vec2f,
  brushRadius: f32,
  brushStrength: f32,
  decayRate: f32,
  diffusionRate: f32,
  diffusionJitter: f32,
  dt: f32,
  brushActive: f32,
  _pad: f32,
};

@group(0) @binding(0) var readTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: PaintParams;
@group(0) @binding(2) var staticNoiseTex: texture_2d<f32>;

const TAU = 6.28318530718;
const BRUSH_EDGE_NOISE = 1.5;
const PAINT_VALUE_MAX = 2.0; // Stored paint max; values >1 give a hidden decay buffer while display clamps at 1.0.

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = fullscreen_clip_position(vertexIndex);
  output.uv = fullscreen_uv(vertexIndex);
  return output;
}

fn load_cell(coord: vec2i, dims: vec2i) -> f32 {
  return textureLoad(readTex, clamp(coord, vec2i(0), dims - vec2i(1)), 0).r;
}

fn jittered_offset(axis: vec2f, angle: f32, scale: f32) -> vec2i {
  let c = cos(angle);
  let s = sin(angle);
  let rotated = vec2f(c * axis.x - s * axis.y, s * axis.x + c * axis.y) * scale;
  var offset = vec2i(round(rotated));
  if (all(offset == vec2i(0))) {
    offset = vec2i(select(-1, 1, axis.x + axis.y >= 0.0), 0);
  }
  return offset;
}

fn segment_distance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let denom = max(dot(ab, ab), 0.000001);
  let t = clamp(dot(p - a, ab) / denom, 0.0, 1.0);
  return distance(p, a + ab * t);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) f32 {
  let dims = vec2i(textureDimensions(readTex));
  let q = clamp(vec2i(input.position.xy), vec2i(0), dims - vec2i(1));

  let c = load_cell(q, dims);
  // Static per-cell hash rotates/scales the four taps, then snaps them to texels.
  // r32float is unfilterable here, so this stays textureLoad-only and preserves the
  // convex 5-tap update while making diffusion grow organically instead of as a disc.
  // Channel usage: r=angle hash, g=diffusion scale hash, b=brush-edge hash, a=decay multiplier.
  let staticNoise = textureLoad(staticNoiseTex, q, 0);
  let jitter = clamp(params.diffusionJitter, 0.0, 4.0);
  let angle = staticNoise.r * TAU;
  let scale = mix(1.0, 1.0 + jitter * 1., staticNoise.g);
  let o0 = jittered_offset(vec2f(1.0, 0.0), angle, scale);
  let o1 = jittered_offset(vec2f(-1.0, 0.0), angle, scale);
  let o2 = jittered_offset(vec2f(0.0, 1.0), angle, scale);
  let o3 = jittered_offset(vec2f(0.0, -1.0), angle, scale);
  let n0 = load_cell(q + o0, dims);
  let n1 = load_cell(q + o1, dims);
  let n2 = load_cell(q + o2, dims);
  let n3 = load_cell(q + o3, dims);
  // `dt` is seconds from rAF/renderer code, clamped to avoid giant hidden-tab steps.
  // TS exposes decay as "paint removed per frame at 120fps", then uploads
  // decayRate = decayPerFrame120 * 120, so the shader applies the equivalent
  // frame-rate-independent subtraction: decayThisFrame = decayRate * dt.
  let dt = min(max(params.dt, 0.0), 0.1);
  let diffusionWeight = min(max(params.diffusionRate, 0.0) * dt, 0.24);
  let diffused = (1.0 - 4.0 * diffusionWeight) * c + diffusionWeight * (n0 + n1 + n2 + n3);

  let cellCenter = vec2f(q) + vec2f(0.5);
  let radius = max(params.brushRadius, 0.0001);
  let segmentDistance = segment_distance(cellCenter, params.brushPreviousCell, params.brushCell);
  // Per-cell hash perturbs the capsule edge to keep brush stamps organic. The noise is static
  // per cell (free) so strokes stay stable frame-to-frame but lose the perfect capsule.
  let brushNoise = (staticNoise.b - 0.5) * BRUSH_EDGE_NOISE;
  let noisyDistance = clamp(segmentDistance + brushNoise, 0.0, radius + BRUSH_EDGE_NOISE);
  let brushFalloff = 1.0 - smoothstep(0.0, radius, noisyDistance);
  let brush = step(0.5, params.brushActive) * max(params.brushStrength, 0.0) * dt * brushFalloff;

  let decayMultiplier = mix(1.0, 2.0, staticNoise.a);
  let decayRate = max(params.decayRate, 0.0) * decayMultiplier;
  var outValue = clamp(diffused - decayRate * 0.2 * dt + brush, 0.0, PAINT_VALUE_MAX);
  if (outValue < 0.001) {
    outValue = 0.0;
  }
  return outValue;
}
