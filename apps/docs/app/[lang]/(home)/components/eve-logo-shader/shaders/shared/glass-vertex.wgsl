import { Params } from "./scene-params.wgsl";

// Shared mesh vertex IO and vertex helper for glass mesh entry shaders.
// INVARIANT: vertex locations and output locations match the pipeline vertex layout.
// This module contains no shader entrypoints; entry files keep their vs_main wrappers.

export struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

export struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) normal: vec3f,
  @location(1) viewDir: vec3f,
  @location(2) cameraAxisDepth: f32,
  @location(3) modelPos: vec3f,
};

export fn glass_vs_main(input: VertexInput, params: Params) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = params.viewProj * vec4f(input.position, 1.0);
  output.normal = normalize(input.normal);
  output.viewDir = normalize(params.cameraPos - input.position);
  // Depth along the camera forward axis in object/world space. Unlike view-space distance,
  // this is independent of orbit radius, so front/back subtraction gives stable thickness.
  output.cameraAxisDepth = dot(input.position, normalize(params.cameraForward));
  output.modelPos = input.position;
  return output;
}

export fn is_back_facing_to_camera(ngeo: vec3f, v: vec3f) -> bool {
  return dot(ngeo, v) <= 0.0;
}
