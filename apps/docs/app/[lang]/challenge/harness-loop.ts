import { glyphNoise, glyphSymbols } from "./glyphs";

type Vector = readonly [number, number, number];

export const loopWidth = 720;
export const loopHeight = 440;
export const loopCheckpoints = 4;

const restingYaw = 0.55;
const sway = 0.17;

const sections = 240;
const sides = 6;
const tube = 0.15;
const tau = Math.PI * 2;
const light = normalize([-0.42, 0.58, 0.7]);

function normalize([x, y, z]: Vector): Vector {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function infinityCurve(t: number): Vector {
  const sine = Math.sin(t);
  const x = (2.4 * Math.cos(t)) / (1 + sine * sine);
  return [x, x * sine, 0.45 * sine];
}

export type LoopSample = { position: Vector; normal: Vector; t: number; symbol: number };

export const loopSamples: LoopSample[] = Array.from({ length: sections * sides }, (_, index) => {
  const section = Math.floor(index / sides);
  const side = index % sides;
  const t = (section / sections) * tau;
  const center = infinityCurve(t);
  const ahead = infinityCurve(t + 0.001);
  const tangent = normalize([ahead[0] - center[0], ahead[1] - center[1], ahead[2] - center[2]]);
  const across = normalize(cross(tangent, [0, 0, 1]));
  const up = cross(tangent, across);
  const angle = (side / sides) * tau + section * 0.11;
  const normal: Vector = [
    across[0] * Math.cos(angle) + up[0] * Math.sin(angle),
    across[1] * Math.cos(angle) + up[1] * Math.sin(angle),
    across[2] * Math.cos(angle) + up[2] * Math.sin(angle),
  ];
  return {
    position: [
      center[0] + normal[0] * tube,
      center[1] + normal[1] * tube,
      center[2] + normal[2] * tube,
    ],
    normal,
    t,
    symbol: Math.floor(glyphNoise(section, side, 23) * glyphSymbols.length),
  };
});

export type LoopMark = {
  x: number;
  y: number;
  depth: number;
  size: number;
  shade: number;
  t: number;
  symbol: number;
};

const camera = 7.5;
const tilt = 0.42;
const margin = 16;

function rotation(yaw: number) {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  return ([x, y, z]: Vector): Vector => {
    const rx = x * cosYaw + z * sinYaw;
    const rz = -x * sinYaw + z * cosYaw;
    return [rx, y * cosTilt - rz * sinTilt, y * sinTilt + rz * cosTilt];
  };
}

const loopScale = (() => {
  let reachX = 0;
  let reachY = 0;
  const samples = 24;
  for (let step = 0; step <= samples; step++) {
    const rotate = rotation(restingYaw + sway * ((step / samples) * 2 - 1));
    for (const { position } of loopSamples) {
      const [x, y, z] = rotate(position);
      const perspective = camera / (camera - z);
      reachX = Math.max(reachX, Math.abs(x * perspective));
      reachY = Math.max(reachY, Math.abs(y * perspective));
    }
  }
  return Math.min((loopWidth / 2 - margin) / reachX, (loopHeight / 2 - margin) / reachY);
})();

export function projectLoop(seconds: number): LoopMark[] {
  const rotate = rotation(restingYaw + sway * Math.sin(seconds * 0.25));
  return loopSamples
    .map(({ position, normal, t, symbol }) => {
      const [x, y, z] = rotate(position);
      const facing = rotate(normal);
      const perspective = camera / (camera - z);
      const lit = Math.max(0, facing[0] * light[0] + facing[1] * light[1] + facing[2] * light[2]);
      const front = facing[2] > -0.08;
      return {
        x: loopWidth / 2 + x * loopScale * perspective,
        y: loopHeight / 2 - y * loopScale * perspective,
        depth: z,
        size: 9.5 * perspective,
        shade: front ? 0.24 + 0.76 * lit : 0.07,
        t,
        symbol,
      };
    })
    .sort((a, b) => a.depth - b.depth);
}

export function runPositions(seconds: number) {
  return [0, 1, 2].map((run) => {
    const progress = seconds * 0.05 + run / 3;
    const stage = Math.floor(progress * loopCheckpoints);
    const within = progress * loopCheckpoints - stage;
    const travel = Math.min(1, Math.max(0, (within - 0.3) / 0.7));
    const eased = travel * travel * (3 - 2 * travel);
    return {
      t: (((((stage + eased) / loopCheckpoints) % 1) + 1) % 1) * tau,
      dwelling: travel === 0,
    };
  });
}

export function runGlow(t: number, runs: ReturnType<typeof runPositions>) {
  let glow = 0;
  for (const run of runs) {
    let behind = run.t - t;
    if (behind < -Math.PI) behind += tau;
    if (behind > Math.PI) behind -= tau;
    const trail = behind >= -0.05 ? Math.exp(-Math.max(0, behind) / 0.32) : Math.exp(behind / 0.04);
    glow = Math.max(glow, trail * (run.dwelling ? 1 : 0.85));
  }
  for (let checkpoint = 0; checkpoint < loopCheckpoints; checkpoint++) {
    let distance = Math.abs(t - (checkpoint / loopCheckpoints) * tau);
    distance = Math.min(distance, tau - distance);
    if (distance < 0.05) glow = Math.max(glow, 0.32);
  }
  return glow;
}

export function loopMarkOpacity(mark: LoopMark, runs: ReturnType<typeof runPositions>) {
  const glow = runGlow(mark.t, runs) * Math.min(1, mark.shade * 2.2);
  return Math.min(1, mark.shade * 0.62 + glow * 0.75);
}

function buildStill() {
  const runs = runPositions(0);
  const definitions = glyphSymbols
    .map(({ path, stroke }, index) => {
      const paint = stroke
        ? `fill="none" stroke="currentColor" stroke-width="${stroke}"`
        : 'fill="currentColor"';
      return `<path id="loop-glyph-${index}" d="${path}" transform="scale(1.4)" ${paint}/>`;
    })
    .join("");
  const marks = projectLoop(0).map((mark) => ({
    symbol: mark.symbol,
    opacity: loopMarkOpacity(mark, runs).toFixed(2),
    transform: `translate(${mark.x.toFixed(1)} ${mark.y.toFixed(1)}) scale(${(mark.size / 16).toFixed(3)})`,
  }));
  const uses = marks
    .map(
      ({ symbol, opacity, transform }) =>
        `<use href="#loop-glyph-${symbol}" opacity="${opacity}" transform="${transform}"/>`,
    )
    .join("");
  return {
    marks,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${loopWidth} ${loopHeight}" color="#fff"><defs>${definitions}</defs>${uses}</svg>`,
  };
}

export const stillLoop = buildStill();
