import { oriented_normal, env_reflect_dir, env_reflection_from_dir, encode_normal } from "../shared/material-core.wgsl";
import { Params, WIRE_PASS_THRESHOLD } from "../shared/scene-params.wgsl";
import { VertexInput, VertexOutput, glass_vs_main, is_back_facing_to_camera } from "../shared/glass-vertex.wgsl";
import { shade_glass } from "../shared/glass-material.wgsl";
import { ascii_imprint_coverage } from "../shared/ascii-imprint.wgsl";
import { normalized_thickness, blurred_back_contribution } from "./back-refraction.wgsl";
import { sample_paint, sample_ascii_voronoi } from "./paint-read.wgsl";
import { ascii_vertical_opacity, ascii_coverage_with_opacity, ascii_final_composite } from "./ascii-composite.wgsl";

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var studioCube: texture_2d_array<f32>;
@group(0) @binding(2) var studioSampler: sampler;
@group(0) @binding(3) var backMaterial: texture_2d<f32>;
@group(0) @binding(4) var backDepth: texture_2d<f32>;
@group(0) @binding(5) var paintTex: texture_2d<f32>;
@group(0) @binding(6) var asciiVoronoiValueTex: texture_2d<f32>;
@group(0) @binding(7) var asciiVoronoiEdgeTex: texture_2d<f32>;

const FRONT_GATE_START = 0.55;
const FRONT_GATE_FULL = 0.80;

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

  // Front material: only render fragments facing the camera.
  if (is_back_facing_to_camera(ngeo, v)) {
    discard;
  }

  let materialKind = u32(clamp(round(params.materialKind), 0.0, 4.0));
  switch (materialKind) {
    case 4u: {
      let backSize = vec2i(textureDimensions(backDepth));
      let pixel = vec2i(input.clipPosition.xy);
      let normalizedThickness = normalized_thickness(backDepth, input.cameraAxisDepth, params.thicknessScale, pixel, backSize);
      return vec4f(vec3f(normalizedThickness), 1.0);
    }
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
      var glass = shade_glass(studioCube, studioSampler, n, v, reflected, params.envYaw, params.envPitch, false, params.glassAbsorption);
      let backSize = vec2i(textureDimensions(backMaterial));
      let pixel = vec2i(input.clipPosition.xy);
      if (all(pixel >= vec2i(0)) && all(pixel < backSize)) {
        let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(backSize);
        let backContribution = blurred_back_contribution(
          backMaterial,
          backDepth,
          studioSampler,
          uv,
          pixel,
          input.cameraAxisDepth,
          params.thicknessScale,
          params.glassAbsorption,
        );
        // The main scene uses additive alpha blending (`src-alpha + one`). The offscreen back
        // texture already contains the blended back-side contribution, so divide by the front
        // alpha before returning to preserve the previous two-draw visual result.
        glass = vec4f(glass.rgb + backContribution / max(glass.a, 0.001), glass.a);
      }
      // Order: read paint -> build glyph coverage -> apply theme/fade/luminance -> composite.
      // Paint never reveals the noisy base ASCII chain; ascii_imprint_coverage gates that by
      // imprintProgress and adds a separate clean hover-station coverage for paint.
      let paintValue = clamp(sample_paint(paintTex, input.modelPos.xy, params.ascii0.y, params.ascii1.zw), 0.0, 1.0);
      let imprintProgress = clamp(params.ascii0.x, 0.0, 1.0);
      let glassVisibility = 1.0 - imprintProgress;
      let frontMask = smoothstep(FRONT_GATE_START, FRONT_GATE_FULL, ngeo.z);
      let themeT = clamp(params.glassAbsorption, 0.0, 1.0);
      let asciiOpacity = ascii_vertical_opacity(input.modelPos.y, themeT);
      let glyphCoverage = ascii_imprint_coverage(
        input.modelPos.xy,
        params.ascii0.y,
        params.ascii0.z,
        params.ascii0.w,
        params.ascii1.xy,
        imprintProgress,
        paintValue,
        sample_ascii_voronoi(asciiVoronoiValueTex, asciiVoronoiEdgeTex, input.modelPos.xy, params.ascii0.y, params.ascii0.w, params.ascii1.zw),
      ) * frontMask;
      // Paint bypasses most of the vertical fade, boosts light-theme density by lowering
      // coverage gamma, and boosts dark-theme HDR emissive below. `coverage` is still
      // premultiplied-safe alpha coverage; the glass color itself is not paint-faded.
      let coverage = ascii_coverage_with_opacity(glyphCoverage, asciiOpacity, paintValue, themeT);
      if (params.ascii0.x <= 0.0 && paintValue <= 0.0) {
        return glass;
      }
      return ascii_final_composite(glass, glassVisibility, coverage, themeT, paintValue);
    }
  }
}
