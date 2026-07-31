import { describe, expect, it } from "vitest";

import { deriveTraceViewerSurfaces } from "./trace-surfaces.js";

describe("deriveTraceViewerSurfaces", () => {
  it("reproduces the original dark palette on a black background", () => {
    const surfaces = deriveTraceViewerSurfaces({ r: 0, g: 0, b: 0 });
    expect(surfaces.header).toBe("\x1b[48;2;22;22;22m");
    expect(surfaces.body).toBe("\x1b[48;2;36;36;36m");
    expect(surfaces.errorHeader).toBe("\x1b[48;2;69;32;37m");
    expect(surfaces.errorBody).toBe("\x1b[48;2;58;26;31m");
  });

  it("darkens surfaces on a light background instead of lightening", () => {
    const surfaces = deriveTraceViewerSurfaces({ r: 255, g: 255, b: 255 });
    expect(surfaces.header).toBe("\x1b[48;2;233;233;233m");
    expect(surfaces.body).toBe("\x1b[48;2;219;219;219m");
    // Error bands blend toward the red accent from the light side: a soft
    // pink instead of a dark maroon.
    expect(surfaces.errorHeader).toBe("\x1b[48;2;248;210;215m");
    expect(surfaces.errorBody).toBe("\x1b[48;2;249;218;222m");
  });

  it("styles primary text for contrast: truecolor white on dark, black on light", () => {
    const dark = deriveTraceViewerSurfaces({ r: 0, g: 0, b: 0 });
    expect(dark.primaryText("assistant")).toBe("\x1b[38;2;255;255;255massistant\x1b[39m");
    const light = deriveTraceViewerSurfaces({ r: 255, g: 255, b: 255 });
    expect(light.primaryText("assistant")).toBe("\x1b[38;2;0;0;0massistant\x1b[39m");
  });

  it("anchors muted text as a truecolor grey blended toward the primary", () => {
    const dark = deriveTraceViewerSurfaces({ r: 0, g: 0, b: 0 });
    expect(dark.mutedText("hints")).toBe("\x1b[38;2;140;140;140mhints\x1b[39m");
    const light = deriveTraceViewerSurfaces({ r: 255, g: 255, b: 255 });
    expect(light.mutedText("hints")).toBe("\x1b[38;2;115;115;115mhints\x1b[39m");
  });

  it("keys the blend direction on perceived luminance, not raw channels", () => {
    // A saturated blue reads dark despite a maxed channel: lighten it.
    const blue = deriveTraceViewerSurfaces({ r: 0, g: 0, b: 255 });
    expect(blue.header).toBe("\x1b[48;2;22;22;255m");
    // A pale yellow reads light: darken it.
    const yellow = deriveTraceViewerSurfaces({ r: 255, g: 255, b: 200 });
    expect(yellow.header).toBe("\x1b[48;2;233;233;183m");
  });
});
