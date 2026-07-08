import { fullscreen_clip_position, fullscreen_uv } from "../shared/fullscreen.wgsl";

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var paintTex: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = fullscreen_clip_position(vertexIndex);
  output.uv = fullscreen_uv(vertexIndex);
  output.uv.y = 1. - output.uv.y;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(paintTex));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.999999));
  let coord = clamp(vec2i(floor(uv * vec2f(dims))), vec2i(0), dims - vec2i(1));
  let paint = textureLoad(paintTex, coord, 0).r;
  return vec4f(vec3f(clamp(paint, 0.0, 1.0)), 1.0);
}
