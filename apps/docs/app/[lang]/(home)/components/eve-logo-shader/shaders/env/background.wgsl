import { sample_env } from "../shared/env-sample.wgsl";
import { Params } from "../shared/scene-params.wgsl";

// Environment background pass for eve-5.
// Draws the fixed-world studio HDR cubemap from the same true orbit camera as the logo.

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) ndc: vec2f,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var studioCube: texture_2d_array<f32>;
@group(0) @binding(2) var studioSampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let xy = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let p = xy[vertexIndex];
  var output: VertexOutput;
  output.clipPosition = vec4f(p, 0.0, 1.0);
  output.ndc = p;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let focalY = 1.0 / tan(params.fov * 0.5);
  let dir = normalize(
    params.cameraForward +
      params.cameraRight * (input.ndc.x * params.aspect / focalY) +
      params.cameraUp * (input.ndc.y / focalY)
  );
  let hdr = sample_env(studioCube, studioSampler, dir, params.envYaw, params.envPitch);
  // Scene target is linear HDR (ACES/gamma applied later in the composite pass).
  return vec4f(hdr, 1.0);
}
