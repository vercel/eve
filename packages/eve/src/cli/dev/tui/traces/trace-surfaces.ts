import type { RgbColor } from "../terminal-background.js";

export interface TraceViewerSurfaces {
  readonly header: string;
  readonly body: string;
  readonly errorHeader: string;
  readonly errorBody: string;
  readonly primaryText: (text: string) => string;
  readonly mutedText: (text: string) => string;
}

export const SURFACE_CLOSE = "\x1b[49m";

const HEADER_BLEND = 0.086;
const BODY_BLEND = 0.141;
const ERROR_HEADER_BLEND = 0.3;
const ERROR_BODY_BLEND = 0.25;
const ERROR_ACCENT: RgbColor = { r: 230, g: 105, b: 123 };
const WHITE: RgbColor = { r: 255, g: 255, b: 255 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const MUTED_BLEND = 0.55;

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
