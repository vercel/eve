import { createHash } from "node:crypto";
import { glyphScale, symbols, titleArtHeight, titleArtWidth, titleMarks } from "./title-art-data";

const definitions = symbols
  .map(({ path, stroke }, index) => {
    const paint = stroke ? `fill="none" stroke="currentColor" stroke-width="${stroke}"` : "";
    return `<path id="g${index}" d="${path}" transform="scale(${glyphScale})" ${paint}/>`;
  })
  .join("");
const marks = titleMarks
  .map(({ x, y, symbol, light }) => {
    const color = light.toString(16).repeat(3);
    return `<use href="#g${symbol}" x="${x}" y="${y}" color="#${color}"/>`;
  })
  .join("");

export const titleStillSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${titleArtWidth} ${titleArtHeight}" width="${titleArtWidth}" height="${titleArtHeight}" fill="currentColor"><defs>${definitions}</defs>${marks}</svg>`;
const version = createHash("sha256").update(titleStillSvg).digest("hex").slice(0, 12);
export const titleArtUrl = `/challenge/artwork?v=${version}`;
