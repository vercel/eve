// Single shader import/compile registry; WGSL entry paths stay unchanged.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device } from "@vgpu/core";
import { compile } from "@vgpu/wgsl";
import glassBackWgsl from "../shaders/glass/back.wgsl";
import glassFrontWgsl from "../shaders/glass/front.wgsl";
import glassBackDepthWgsl from "../shaders/glass/back-depth.wgsl";
import eveBloomBlurWgsl from "../shaders/bloom/blur.wgsl";
import eveBloomCompositeWgsl from "../shaders/bloom/composite.wgsl";
import eveLightCompositeWgsl from "../shaders/postprocess/light-composite.wgsl";
import eveEnvBgWgsl from "../shaders/env/background.wgsl";
import renderTargetPreviewWgsl from "../shaders/debug/render-target-preview.wgsl";
import paintUpdateWgsl from "../shaders/paint/paint-update.wgsl";
import paintDebugWgsl from "../shaders/paint/paint-debug.wgsl";
import voronoiNoiseUpdateWgsl from "../shaders/paint/voronoi-noise-update.wgsl";

export function createShaders(device: Device) {
  return {
    glassBack: device.createShader(compile(glassBackWgsl)),
    glassFront: device.createShader(compile(glassFrontWgsl)),
    glassBackDepth: device.createShader(compile(glassBackDepthWgsl)),
    bloomBlur: device.createShader(compile(eveBloomBlurWgsl)),
    bloomComposite: device.createShader(compile(eveBloomCompositeWgsl)),
    lightComposite: device.createShader(compile(eveLightCompositeWgsl)),
    envBg: device.createShader(compile(eveEnvBgWgsl)),
    preview: device.createShader(compile(renderTargetPreviewWgsl)),
    paintUpdate: device.createShader(compile(paintUpdateWgsl)),
    paintDebug: device.createShader(compile(paintDebugWgsl)),
    voronoiNoiseUpdate: device.createShader(compile(voronoiNoiseUpdateWgsl)),
  };
}
