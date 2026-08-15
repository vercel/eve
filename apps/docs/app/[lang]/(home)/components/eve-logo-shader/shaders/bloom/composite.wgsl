import { fullscreen_clip_position, fullscreen_uv } from "../shared/fullscreen.wgsl";
import { aces_tonemap, linear_to_display } from "../shared/tonemap.wgsl";

// Bloom composite pass. Adds finite-radius blurred bloom in linear HDR, then tonemaps once.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

struct CompositeParams {
  strength: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> params: CompositeParams;

const BLOOM_RADIAL_FULL_RADIUS = 0.55;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = fullscreen_clip_position(vertexIndex);
  output.uv = fullscreen_uv(vertexIndex);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let scene = textureSample(sceneTexture, texSampler, input.uv).rgb;
  let bloom = textureSample(bloomTexture, texSampler, input.uv).rgb;
  let sceneSize = vec2f(textureDimensions(sceneTexture));
  let aspectCorrectUv = (input.uv - vec2f(0.5)) * vec2f(sceneSize.x / max(sceneSize.y, 1.0), 1.0);
  let bloomRadial = smoothstep(0.0, BLOOM_RADIAL_FULL_RADIUS, length(aspectCorrectUv));
  let linearColor = scene + bloom * params.strength * bloomRadial;
  return vec4f(linear_to_display(aces_tonemap(linearColor)), 1.0);
}
