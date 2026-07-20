import { Params } from "../shared/scene-params.wgsl";
import { VertexInput, VertexOutput, glass_vs_main, is_back_facing_to_camera } from "../shared/glass-vertex.wgsl";

@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  return glass_vs_main(input, params);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let ngeo = normalize(input.normal);
  let v = normalize(input.viewDir);

  // Match the back-material target: store only the camera-backfacing/inside surface depth.
  if (!is_back_facing_to_camera(ngeo, v)) {
    discard;
  }

  return vec4f(input.cameraAxisDepth, 0.0, 0.0, 1.0);
}
