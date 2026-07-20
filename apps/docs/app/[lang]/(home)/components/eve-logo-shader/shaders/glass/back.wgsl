import { oriented_normal, env_reflect_dir, env_reflection_from_dir, encode_normal } from "../shared/material-core.wgsl";
import { Params, WIRE_PASS_THRESHOLD } from "../shared/scene-params.wgsl";
import { VertexInput, VertexOutput, glass_vs_main, is_back_facing_to_camera } from "../shared/glass-vertex.wgsl";
import { shade_glass } from "../shared/glass-material.wgsl";

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var studioCube: texture_2d_array<f32>;
@group(0) @binding(2) var studioSampler: sampler;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  return glass_vs_main(input, params);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let ngeo = normalize(input.normal);
  let v = normalize(input.viewDir);

  if (params.passKind > WIRE_PASS_THRESHOLD) {
    // Scene pass is linear HDR; this constant is the previous display grey converted to linear.
    return vec4f(pow(vec3f(0.93), vec3f(2.2)), 0.55);
  }

  let n = oriented_normal(ngeo, v);
  let reflected = env_reflect_dir(n, v);

  // Back material: only render fragments facing away from the camera.
  if (!is_back_facing_to_camera(ngeo, v)) {
    discard;
  }

  let materialKind = u32(clamp(round(params.materialKind), 0.0, 3.0));
  switch (materialKind) {
    case 1u: {
      return vec4f(encode_normal(n), 1.0);
    }
    case 2u: {
      return vec4f(encode_normal(reflected), 1.0);
    }
    case 3u: {
      return vec4f(env_reflection_from_dir(studioCube, studioSampler, reflected, params.envYaw, params.envPitch), 1.0);
    }
    default: {
      return shade_glass(studioCube, studioSampler, n, v, reflected, params.envYaw, params.envPitch, true, params.glassAbsorption);
    }
  }
}
