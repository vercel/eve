// Generates the dot-matrix masks behind template card previews.
// Run from apps/docs: node scripts/generate-dot-matrix.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { DOT_MATRIX, dotOpacity } from "../lib/templates/preview-kit.ts";

const OUT = new URL("../public/templates/dot-matrix/", import.meta.url);
const { gap, height, variants, width } = DOT_MATRIX;

mkdirSync(OUT, { recursive: true });
for (let variant = 0; variant < variants; variant++) {
  const dots = [];
  for (let y = gap / 2; y < height; y += gap) {
    for (let x = gap / 2; x < width; x += gap) {
      const opacity = dotOpacity({ variant, x, y });
      if (opacity < 0.02) continue;
      dots.push(`<circle cx="${x}" cy="${y}" r="1" fill-opacity="${+opacity.toFixed(2)}"/>`);
    }
  }
  writeFileSync(
    new URL(`${variant}.svg`, OUT),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${dots.join("")}</svg>\n`,
  );
}
