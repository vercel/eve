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
  shape?: "logo";
  brightness?: number;
};

const logoPaths = [
  "M169 8.47h-51.39L81.73 53H70.36L113 0H169z",
  "M169 44.51v8.47h-45.87V44.5z",
  "M45.87 52.98H0V44.5h45.87z",
  "M38.66 30.55H0v-8.47h38.66z",
  "M169 30.55h-38.66v-8.47H169z",
  "M75.52 8.47H0V0h75.52z",
];

function polygon(path: string) {
  const tokens = path.match(/[MLHVZmlhvz]|-?\d*\.?\d+/g) ?? [];
  const points: [number, number][] = [];
  let x = 0;
  let y = 0;
  let command = "M";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (/[a-z]/i.test(token)) {
      command = token;
      continue;
    }
    const value = Number(token);
    if (command === "M" || command === "L") {
      x = value;
      y = Number(tokens[++index]);
    } else if (command === "H") x = value;
    else if (command === "V") y = value;
    else if (command === "h") x += value;
    else if (command === "v") y += value;
    points.push([x, y]);
  }
  return points;
}

const logoPolygons = logoPaths.map(polygon);

function insideLogo(x: number, y: number) {
  return logoPolygons.some((points) => {
    let inside = false;
    for (let index = 0, last = points.length - 1; index < points.length; last = index++) {
      const [ax, ay] = points[index]!;
      const [bx, by] = points[last]!;
      if (ay > y !== by > y && x < ax + ((bx - ax) * (y - ay)) / (by - ay)) inside = !inside;
    }
    return inside;
  });
}

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
  shape,
  brightness = 0.22,
}: GlyphFieldOptions) {
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    if (glyphNoise(column, row, seed) > density) return [];
    if (shape && !insideLogo(((column + 0.5) / columns) * 169, ((row + 0.5) / rows) * 53)) {
      return [];
    }
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
        twinkle: glyphNoise(column, row, seed + 3) > 0.91,
        delay: Math.round(glyphNoise(column, row, seed + 4) * 6400),
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
