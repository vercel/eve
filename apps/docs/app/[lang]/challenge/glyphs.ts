export const glyphCell = 16;

export const glyphSymbols: readonly { path: string; stroke?: number }[] = [
  { path: "M-3.3 0a3.3 3.3 0 1 0 6.6 0 3.3 3.3 0 1 0-6.6 0Z" },
  { path: "M-3.45 0a3.45 3.45 0 1 0 6.9 0 3.45 3.45 0 1 0-6.9 0Z", stroke: 1.4 },
  { path: "M-3.7 0h7.4M0-3.7v7.4", stroke: 1.55 },
  { path: "M-2.8-2.8l5.6 5.6m0-5.6-5.6 5.6", stroke: 1.55 },
  { path: "M0-4 4 0 0 4-4 0Z" },
  { path: "M-3.6-3.6h3v3h-3zM.6-3.6h3v3h-3zM-3.6.6h3v3h-3zM.6.6h3v3h-3z" },
  { path: "M-3.35-3.35h6.7v6.7h-6.7Z", stroke: 1.45 },
  { path: "M-3.7-3.4h1.7v6.8h-1.7zM-.85-3.4H.85v6.8H-.85zM2-3.4h1.7v6.8H2z" },
];

export type GlyphClearing = { x: number; y: number; radiusX: number; radiusY: number };
export type GlyphFieldOptions = {
  columns: number;
  rows: number;
  seed: number;
  density?: number;
  clearing?: GlyphClearing;
  brightness?: number;
};

export function glyphNoise(x: number, y: number, channel: number) {
  let seed =
    Math.imul(x + 7, 374761393) ^ Math.imul(y + 19, 668265263) ^ Math.imul(channel + 3, 1597334677);
  seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
}

export function glyphMarks({
  columns,
  rows,
  seed,
  density = 0.42,
  clearing,
  brightness = 0.22,
}: GlyphFieldOptions) {
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    if (glyphNoise(column, row, seed) > density) return [];
    if (clearing) {
      const dx = ((column + 0.5) / columns - clearing.x) / clearing.radiusX;
      const dy = ((row + 0.5) / rows - clearing.y) / clearing.radiusY;
      if (dx * dx + dy * dy < 1) return [];
    }
    return [
      {
        id: index,
        x: (column + 0.5) * glyphCell,
        y: (row + 0.5) * glyphCell,
        symbol: Math.floor(glyphNoise(column, row, seed + 1) * glyphSymbols.length),
        opacity: brightness + glyphNoise(column, row, seed + 2) * (1 - brightness) * 0.72,
      },
    ];
  }).flat();
}

export function glyphFieldSvg(options: GlyphFieldOptions, color: string) {
  const definitions = glyphSymbols
    .map(({ path, stroke }, index) => {
      const paint = stroke
        ? `fill="none" stroke="currentColor" stroke-width="${stroke}"`
        : 'fill="currentColor"';
      return `<path id="g${index}" d="${path}" transform="scale(1.4)" ${paint}/>`;
    })
    .join("");
  const marks = glyphMarks(options)
    .map(
      ({ x, y, symbol, opacity }) =>
        `<use href="#g${symbol}" x="${x}" y="${y}" opacity="${opacity.toFixed(2)}"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${options.columns * glyphCell} ${options.rows * glyphCell}" color="${color}"><defs>${definitions}</defs>${marks}</svg>`;
}
