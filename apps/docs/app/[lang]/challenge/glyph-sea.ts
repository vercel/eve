import {
  glyphScale,
  noise,
  symbols,
  titleArtHeight,
  titleArtWidth,
  titleMarks,
} from "./title-art-data";

type Mark = { x: number; y: number; light: number };
export type SeaPoint = { x: number; y: number };
export type PrismTrace = { from: SeaPoint; to: SeaPoint; radius: number; strength: number };

function sampleLogo(context: CanvasRenderingContext2D, logo: SVGSVGElement) {
  const { x, y, width, height } = logo.viewBox.baseVal;
  const outline = new Path2D();
  for (const path of logo.querySelectorAll("path[d]")) {
    outline.addPath(new Path2D(path.getAttribute("d") ?? ""));
  }
  const span = 610;
  const rise = (span * height) / width;
  const marks: Mark[] = [];
  const spacing = 9;
  for (let row = spacing / 2; row < rise; row += spacing) {
    for (let column = spacing / 2; column < span; column += spacing) {
      if (context.isPointInPath(outline, x + (column / span) * width, y + (row / rise) * height)) {
        marks.push({
          x: (titleArtWidth - span) / 2 + column,
          y: (titleArtHeight - rise) / 2 + row,
          light: 191 + 64 * noise(marks.length, 3, 0),
        });
      }
    }
  }
  return marks;
}

const spriteSide = 24;
const spriteSpan = 12 * glyphScale;

const prismStops = ["red", "amber", "green", "teal", "blue", "purple", "pink"];

function makeAtlas(canvas: HTMLCanvasElement) {
  const styles = getComputedStyle(canvas);
  const colors = [
    "white",
    ...prismStops.map((stop) => styles.getPropertyValue(`--ds-${stop}-700`).trim() || "white"),
  ];
  const atlas = document.createElement("canvas");
  atlas.width = symbols.length * spriteSide;
  atlas.height = colors.length * spriteSide;
  const context = atlas.getContext("2d");
  if (!context) return null;
  const paths = symbols.map(({ path }) => new Path2D(path));
  for (const [row, color] of colors.entries()) {
    context.strokeStyle = context.fillStyle = color;
    for (const [index, symbol] of symbols.entries()) {
      context.setTransform(2, 0, 0, 2, (index + 0.5) * spriteSide, (row + 0.5) * spriteSide);
      if (symbol.stroke) {
        context.lineWidth = symbol.stroke;
        context.stroke(paths[index]!);
      } else {
        context.fill(paths[index]!);
      }
    }
  }
  return atlas;
}

function paintGlyph(
  context: CanvasRenderingContext2D,
  atlas: HTMLCanvasElement,
  tile: number,
  row: number,
  x: number,
  y: number,
  size: number,
  alpha: number,
) {
  context.globalAlpha = alpha;
  context.drawImage(atlas, tile, row * spriteSide, spriteSide, spriteSide, x, y, size, size);
}

function ease(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

const titleTurn = 13;
const logoTurn = 9;
const loopLength = titleTurn + logoTurn;

function assembly(phase: number, logo: boolean) {
  return logo
    ? ease((phase - 1) / 2) * (1 - ease((phase - 6.3) / 2.1))
    : ease((phase - 1) / 2.4) * (1 - ease((phase - 9.5) / 2.6));
}

export function createGlyphSea(canvas: HTMLCanvasElement, logo: SVGSVGElement) {
  const context = canvas.getContext("2d");
  const atlas = makeAtlas(canvas);
  if (!context || !atlas) return null;
  context.resetTransform();
  const logoMarks = sampleLogo(context, logo);
  if (!logoMarks.length) return null;
  const particles = Array.from(
    { length: Math.max(titleMarks.length, logoMarks.length) + 44 },
    (_, index) => ({
      title: titleMarks[index],
      logo: logoMarks[index],
      symbol: titleMarks[index]?.symbol ?? Math.floor(noise(index, 0, 9) * symbols.length),
      seaX: noise(index, 0, 3),
      seaY: noise(index, 0, 4),
      phase: noise(index, 0, 5) * Math.PI * 2,
      amplitude: 0.55 + noise(index, 0, 6) * 0.45,
      tint: 0,
    }),
  );
  let width = titleArtWidth;
  let height = titleArtHeight;
  let left = 0;
  let top = 0;

  function resize(targetWidth: number, targetHeight: number) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const scale = Math.min(
      Math.max(1, targetWidth * dpr) / titleArtWidth,
      Math.max(1, targetHeight * dpr) / titleArtHeight,
    );
    width = canvas.width / scale;
    height = canvas.height / scale;
    left = (titleArtWidth - width) / 2;
    top = (titleArtHeight - height) / 2;
    context?.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
  }

  function point(fractionX: number, fractionY: number): SeaPoint {
    return { x: left + width * fractionX, y: top + height * fractionY };
  }

  function draw(seconds: number, dt: number, trace?: PrismTrace) {
    if (!context || !atlas) return;
    const elapsed = seconds + 2.8;
    const cycle = elapsed % loopLength;
    const showsLogo = cycle >= titleTurn;
    const phase = showsLogo ? cycle - titleTurn : cycle;
    const convergence = assembly(phase, showsLogo);
    const dx = trace ? trace.to.x - trace.from.x : 0;
    const dy = trace ? trace.to.y - trace.from.y : 0;
    const lengthSquared = dx * dx + dy * dy;
    const colorDecay = Math.exp(-dt * 3.1);
    context.clearRect(left, top, width, height);

    for (const particle of particles) {
      const target = showsLogo ? particle.logo : particle.title;
      const current = target
        ? assembly(phase - (target.x / titleArtWidth - 0.5) * 0.8, showsLogo)
        : 0;
      const wave = elapsed * 0.9 + particle.phase;
      const seaX = left + 53 + (width - 106) * particle.seaX;
      const seaY = top + 47 + (height - 94) * particle.seaY;
      const swell = seaX * 0.009 + seaY * 0.011 + elapsed * 0.56;
      let x =
        seaX +
        30 * Math.sin(seaY * 0.014 - elapsed * 0.64) +
        15 * Math.sin(swell) +
        8 * Math.cos(wave);
      let y =
        seaY +
        24 * Math.cos(seaX * 0.01 + elapsed * 0.58) +
        12 * Math.sin(swell) +
        8 * Math.sin(wave);
      let light = particle.amplitude * (target ? 0.46 : 0.45 - convergence * 0.33);
      if (target) {
        const toX = target.x + Math.sin(wave) * 0.62 - x;
        const toY = target.y + Math.cos(wave) * 0.62 - y;
        const curl =
          (showsLogo ? -1 : 1) * (0.16 + 0.07 * Math.sin(swell)) * Math.sin(Math.PI * current) ** 2;
        x += toX * current - toY * curl;
        y += toY * current + toX * curl;
        light += (target.light / 255 - light) * current;
      }

      particle.tint *= colorDecay;
      if (trace) {
        const fromX = x - trace.from.x;
        const fromY = y - trace.from.y;
        const along =
          lengthSquared > 0
            ? Math.max(0, Math.min(1, (fromX * dx + fromY * dy) / lengthSquared))
            : 0;
        const distanceSquared = (fromX - along * dx) ** 2 + (fromY - along * dy) ** 2;
        if (distanceSquared < trace.radius ** 2) {
          const falloff = ease(1 - Math.sqrt(distanceSquared) / trace.radius);
          particle.tint = Math.max(particle.tint, falloff * trace.strength);
        }
      }

      const span =
        spriteSpan * (0.76 + 0.24 * particle.amplitude + (showsLogo ? -0.34 : 0.045) * current);
      const glyphX = x - span / 2;
      const glyphY = y - span / 2;
      const tile = particle.symbol * spriteSide;
      const shimmer = particle.tint * (0.36 + 0.15 * Math.sin(elapsed * 3.2 + particle.phase));
      paintGlyph(context, atlas, tile, 0, glyphX, glyphY, span, light * (1 - shimmer * 0.72));
      if (shimmer > 0.012) {
        const palette = prismStops.length;
        const hue = (elapsed * 1.05 + (particle.phase * palette) / (2 * Math.PI)) % palette;
        const first = Math.floor(hue);
        const blend = hue - first;
        const color = Math.min(1, (light + 0.17) * shimmer);
        paintGlyph(context, atlas, tile, first + 1, glyphX, glyphY, span, color * (1 - blend));
        paintGlyph(
          context,
          atlas,
          tile,
          ((first + 1) % palette) + 1,
          glyphX,
          glyphY,
          span,
          color * blend,
        );
      }
    }
  }

  return { resize, point, draw };
}
