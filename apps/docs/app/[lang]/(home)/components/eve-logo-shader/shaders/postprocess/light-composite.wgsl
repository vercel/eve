// Light-mode composite pass. Tonemaps scene color and writes premultiplied alpha for a transparent canvas.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var texSampler: sampler;

const DISPLAY_GAMMA = 2.2;

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

fn aces_tonemap(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + vec3f(b))) / (color * (c * color + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

fn linear_to_display(color: vec3f) -> vec3f {
  return pow(max(color, vec3f(0.0)), vec3f(1.0 / DISPLAY_GAMMA));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let scene = textureSample(sceneTexture, texSampler, input.uv);
  let rgb = linear_to_display(aces_tonemap(scene.rgb));
  let a = clamp(scene.a, 0.0, 1.0);
  return vec4f(rgb * a, a);
}
