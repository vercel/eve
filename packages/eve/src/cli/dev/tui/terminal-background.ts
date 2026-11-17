export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const BACKGROUND_COLOR_QUERY = "\x1b]11;?\x07";

export function parseBackgroundColorReply(payload: string): RgbColor | undefined {
  const match = /^11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/iu.exec(payload.trim());
  if (match === null) return undefined;
  const channel = (hex: string): number =>
    Math.round((Number.parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return { r: channel(match[1]!), g: channel(match[2]!), b: channel(match[3]!) };
}
