struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var backAlbedo: texture_2d<f32>;
@group(0) @binding(1) var backDepthMap: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var<uniform> mode: vec4f;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let position = positions[vertexIndex];
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = clamp(input.uv, vec2f(0.0), vec2f(1.0));
  if (mode.x < 0.5) {
    let color = textureSample(backAlbedo, sourceSampler, uv);
    return vec4f(color.rgb, 1.0);
  }

  let depth = textureSample(backDepthMap, sourceSampler, uv).r;
  // backDepthMap stores raw camera-axis depth in its red channel. Normalize it for display with
  // renderer-provided min/max bounds so negative or tiny model-space values remain inspectable.
  let depth01 = clamp((depth - mode.y) / max(mode.z - mode.y, 0.000001), 0.0, 1.0);
  return vec4f(vec3f(depth01), 1.0);
}
