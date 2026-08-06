/**
 * Card surfaces for the `/traces` viewer, derived from the terminal's own
 * background color (the OSC 11 probe) so they look native in any theme: a
 * dark background gets slightly lighter bands, a light background slightly
 * darker ones, and error bands blend toward red from either side. When the
 * terminal never answers the probe, the viewer falls back to gutter rails.
 */

import type { RgbColor } from "../terminal-background.js";

/** Truecolor background opens (`ESC[48;2;…m`) for the viewer's card bands. */
export interface TraceViewerSurfaces {
  /** Card title band. */
  readonly header: string;
  /** Card body band, slightly more elevated than the header. */
  readonly body: string;
  readonly errorHeader: string;
  readonly errorBody: string;
  /**
   * Style for primary text over the surfaces (card titles, selection bar,
   * toast): truecolor white on dark backgrounds, truecolor black on light
   * ones. The theme's fixed bright-white primary assumes a dark terminal
   * and washes out on light backgrounds.
   */
  readonly primaryText: (text: string) => string;
  /**
   * Style for secondary text (control hints, header metadata, drawer
   * labels): a truecolor grey blended from the probed background toward the
   * primary, so muted text keeps guaranteed contrast on any background.
   */
  readonly mutedText: (text: string) => string;
}

/** Closes a surface, restoring the terminal's default background. */
export const SURFACE_CLOSE = "\x1b[49m";

// Blend fractions chosen to reproduce the viewer's original dark palette on
// a black background (header 22/22/22, body 36/36/36, error 69/32/37 and
// 58/26/31) so dark terminals look unchanged.
const HEADER_BLEND = 0.086;
const BODY_BLEND = 0.141;
const ERROR_HEADER_BLEND = 0.3;
const ERROR_BODY_BLEND = 0.25;
const ERROR_ACCENT: RgbColor = { r: 230, g: 105, b: 123 };
const WHITE: RgbColor = { r: 255, g: 255, b: 255 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
/** How far muted text blends from the background toward the primary. */
const MUTED_BLEND = 0.55;

/**
 * Derives the viewer's card surfaces from the terminal's background color.
 * Everything — bands and text styles alike — is truecolor: palette colors
 * (SGR 30/97) and SGR dim are theme-remappable, so a terminal like ghostty
 * can render them without contrast against the very background it reported.
 * Truecolor is exempt from palette remapping and always lands as derived.
 */
export function deriveTraceViewerSurfaces(background: RgbColor): TraceViewerSurfaces {
  const dark = relativeLuminance(background) < 0.5;
  const neutral = dark ? WHITE : BLACK;
  const primaryOpen = foregroundOpen(neutral);
  const mutedOpen = foregroundOpen(mix(background, neutral, MUTED_BLEND));
  return {
    header: backgroundOpen(mix(background, neutral, HEADER_BLEND)),
    body: backgroundOpen(mix(background, neutral, BODY_BLEND)),
    errorHeader: backgroundOpen(mix(background, ERROR_ACCENT, ERROR_HEADER_BLEND)),
    errorBody: backgroundOpen(mix(background, ERROR_ACCENT, ERROR_BODY_BLEND)),
    primaryText: (text) => `${primaryOpen}${text}\x1b[39m`,
    mutedText: (text) => `${mutedOpen}${text}\x1b[39m`,
  };
}

function backgroundOpen(color: RgbColor): string {
  return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

function foregroundOpen(color: RgbColor): string {
  return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

function mix(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const blend = (a: number, b: number): number => Math.round(a + (b - a) * amount);
  return { r: blend(from.r, to.r), g: blend(from.g, to.g), b: blend(from.b, to.b) };
}

function relativeLuminance(color: RgbColor): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}
