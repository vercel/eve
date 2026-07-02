// Bloom blur pass.
// Separable finite Gaussian blur; samples every integer texel in [-BLOOM_RADIUS, BLOOM_RADIUS]
// with no skipped pixels. Pass 0 extracts bright pixels and blurs horizontally. Pass 1 blurs
// vertically from the horizontal result.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

struct BloomParams {
  direction: vec2f,
  extract: f32,
  threshold: f32,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;

const BLOOM_RADIUS: i32 = 16;
const BLOOM_SIGMA: f32 = 5.3333335; // radius / 3.0; finite support reaches exactly 16px.

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0),
  );

  var output: VertexOutput;
  let position = positions[vertexIndex];
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return output;
}

fn bright_pass(color: vec3f) -> vec3f {
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let keep = smoothstep(params.threshold, params.threshold + 0.08, luma);
  return color * keep;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(sourceTexture));
  let texel = 1.0 / dims;
  var sum = vec3f(0.0);
  var weightSum = 0.0;

  for (var i = -BLOOM_RADIUS; i <= BLOOM_RADIUS; i = i + 1) {
    let fi = f32(i);
    let offsetUv = input.uv + params.direction * texel * fi;
    let uv = clamp(offsetUv, vec2f(0.0), vec2f(1.0));
    var color = textureSample(sourceTexture, sourceSampler, uv).rgb;
    if (params.extract > 0.5) {
      color = bright_pass(color);
    }
    let weight = exp(-(fi * fi) / (2.0 * BLOOM_SIGMA * BLOOM_SIGMA));
    sum += color * weight;
    weightSum += weight;
  }

  return vec4f(sum / max(weightSum, 1e-5), 1.0);
}
