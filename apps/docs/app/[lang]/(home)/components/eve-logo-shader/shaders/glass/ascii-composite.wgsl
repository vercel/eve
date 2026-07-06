// Scalar ASCII opacity and premultiplied composition helpers for front glass.
// INVARIANT: fwidth/coverage construction stays in ascii-imprint/front entry flow, not here.
// This module declares no bindings and performs no texture reads.

const IMPRINT_EMISSIVE = vec3f(2.5);
const PAINT_EMISSIVE_BOOST = 0.5;
const PAINT_DARKEN_GAMMA = 1.2;
const PAINT_FADE_BYPASS = 0.85;
const ASCII_OPACITY_BOTTOM_Y = 0.;
const ASCII_OPACITY_TOP_Y = 0.3;
const ASCII_OPACITY_BOTTOM_LIGHT = 0.3;
const ASCII_OPACITY_BOTTOM_DARK = 0.1;
const ASCII_OPACITY_TOP = 1.0;
const ASCII_OPACITY_CURVE_POWER = 2.0;

export fn ascii_vertical_opacity(modelY: f32, themeT: f32) -> f32 {
  let verticalT = clamp(
    (modelY - ASCII_OPACITY_BOTTOM_Y) / (ASCII_OPACITY_TOP_Y - ASCII_OPACITY_BOTTOM_Y),
    0.0,
    1.0,
  );
  let verticalCurve = pow(verticalT, ASCII_OPACITY_CURVE_POWER);
  let asciiOpacityBottom = mix(ASCII_OPACITY_BOTTOM_LIGHT, ASCII_OPACITY_BOTTOM_DARK, themeT);
  return mix(asciiOpacityBottom, ASCII_OPACITY_TOP, verticalCurve);
}

export fn ascii_theme_coverage(glyphCoverage: f32, paintValue: f32, themeT: f32) -> f32 {
  let lightCoverage = pow(
    clamp(glyphCoverage, 0.0, 1.0),
    1.0 / (1.0 + PAINT_DARKEN_GAMMA * paintValue),
  );
  return mix(lightCoverage, glyphCoverage, themeT);
}

export fn ascii_coverage_with_opacity(glyphCoverage: f32, asciiOpacity: f32, paintValue: f32, themeT: f32) -> f32 {
  // Paint bypasses most of the vertical fade, boosts light-theme density by lowering
  // coverage gamma. The coverage is still premultiplied-safe alpha coverage; the glass
  // color itself is not paint-faded.
  let opacity = mix(asciiOpacity, 1.0, PAINT_FADE_BYPASS * paintValue);
  return ascii_theme_coverage(glyphCoverage, paintValue, themeT) * opacity;
}

export fn ascii_final_composite(glass: vec4f, glassVisibility: f32, coverage: f32, themeT: f32, paintValue: f32) -> vec4f {
  // Fade the normal front-glass/env/back-blur contribution out only as the regular imprint
  // progresses. Paint overlays ASCII on top of intact glass at imprintProgress=0.
  let fadedGlassAlpha = glass.a * glassVisibility;
  let fadedGlassContribution = glass.rgb * fadedGlassAlpha;
  let imprintColor = IMPRINT_EMISSIVE * themeT * (1.0 + PAINT_EMISSIVE_BOOST * paintValue);
  let aNew = mix(fadedGlassAlpha, 1.0, coverage);
  let desired = mix(fadedGlassContribution, imprintColor, coverage);
  return vec4f(desired / max(aNew, 0.001), aNew);
}
