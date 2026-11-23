import { titleStencils } from "./title-stencils";

export const titleArtWidth = 960;
export const titleArtHeight = 550;
export const glyphScale = 1.72;
const cellSize = 16;

export const symbols: readonly { path: string; stroke?: number }[] = [
  { path: "M-3.3 0a3.3 3.3 0 1 0 6.6 0 3.3 3.3 0 1 0-6.6 0Z" },
  { path: "M-3.45 0a3.45 3.45 0 1 0 6.9 0 3.45 3.45 0 1 0-6.9 0Z", stroke: 1.4 },
  { path: "M-3.7 0h7.4M0-3.7v7.4", stroke: 1.55 },
  { path: "M-2.8-2.8l5.6 5.6m0-5.6-5.6 5.6", stroke: 1.55 },
  { path: "M0-4 4 0 0 4-4 0Z" },
  { path: "M-3.6-3.6h3v3h-3zM.6-3.6h3v3h-3zM-3.6.6h3v3h-3zM.6.6h3v3h-3z" },
  { path: "M-3.35-3.35h6.7v6.7h-6.7Z", stroke: 1.45 },
  { path: "M-3.7-3.4h1.7v6.8h-1.7zM-.85-3.4H.85v6.8H-.85zM2-3.4h1.7v6.8H2z" },
  { path: "M-2.65 0a2.65 2.65 0 1 0 5.3 0 2.65 2.65 0 1 0-5.3 0Z" },
];

export function noise(x: number, y: number, channel: number) {
  let seed =
    Math.imul(x + 7, 374761393) ^ Math.imul(y + 19, 668265263) ^ Math.imul(channel + 3, 1597334677);
  seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
}

export const titleMarks = titleStencils.flatMap((stencil) =>
  stencil.mask.split("\n").flatMap((row, offset) => {
    const y = stencil.row + offset;
    return Array.from(row).flatMap((cell, x) =>
      cell === "#"
        ? [
            {
              x: 50 + x * cellSize,
              y: y * cellSize,
              symbol: Math.floor(noise(x, y, 0) * symbols.length),
              light: Math.round(169 + noise(x, y, 1) * 85),
            },
          ]
        : [],
    );
  }),
);
