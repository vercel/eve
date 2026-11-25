const cell = 12;
const splatRadius = 62;
const splatStrength = 0.05;
const velocityStrength = 0.9;
const velocityDecay = 0.955;
const velocityCutoff = 0.05;
const densityDecay = 0.0065;
const advection = 0.92;

export type FlowSample = { density: number; vx: number; vy: number };

export function createHoverFlow() {
  let columns = 0;
  let rows = 0;
  let density = new Float32Array(0);
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let nextDensity = density;
  let nextVx = vx;
  let nextVy = vy;
  let energy = 0;

  function resize(width: number, height: number) {
    columns = Math.max(2, Math.ceil(width / cell) + 1);
    rows = Math.max(2, Math.ceil(height / cell) + 1);
    const size = columns * rows;
    density = new Float32Array(size);
    vx = new Float32Array(size);
    vy = new Float32Array(size);
    nextDensity = new Float32Array(size);
    nextVx = new Float32Array(size);
    nextVy = new Float32Array(size);
    energy = 0;
  }

  function bilinear(field: Float32Array, x: number, y: number) {
    const gx = Math.max(0, Math.min(columns - 1.001, x / cell));
    const gy = Math.max(0, Math.min(rows - 1.001, y / cell));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const index = y0 * columns + x0;
    const top = field[index]! * (1 - fx) + field[index + 1]! * fx;
    const bottom = field[index + columns]! * (1 - fx) + field[index + columns + 1]! * fx;
    return top * (1 - fy) + bottom * fy;
  }

  function step(dt: number, from?: { x: number; y: number }, to?: { x: number; y: number }) {
    const frames = dt * 60;
    let total = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        const x = column * cell;
        const y = row * cell;
        const backX = x - vx[index]! * advection * frames;
        const backY = y - vy[index]! * advection * frames;
        let nextD = Math.max(0, bilinear(density, backX, backY) - densityDecay * frames);
        let velocityX = bilinear(vx, backX, backY);
        let velocityY = bilinear(vy, backX, backY);
        const speed = Math.hypot(velocityX, velocityY);
        const fade = velocityDecay ** frames * Math.min(1, speed / velocityCutoff);
        velocityX *= fade;
        velocityY *= fade;
        if (from && to) {
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const ox = x - to.x;
          const oy = y - to.y;
          const g = Math.exp(-(ox * ox + oy * oy) / (splatRadius * splatRadius));
          if (g > 0.002) {
            velocityX += dx * velocityStrength * g;
            velocityY += dy * velocityStrength * g;
            nextD = Math.min(1.4, nextD + Math.hypot(dx, dy) * splatStrength * g);
          }
        }
        nextDensity[index] = nextD;
        nextVx[index] = velocityX;
        nextVy[index] = velocityY;
        total += nextD;
      }
    }
    [density, nextDensity] = [nextDensity, density];
    [vx, nextVx] = [nextVx, vx];
    [vy, nextVy] = [nextVy, vy];
    energy = total;
  }

  function sample(x: number, y: number): FlowSample {
    return { density: bilinear(density, x, y), vx: bilinear(vx, x, y), vy: bilinear(vy, x, y) };
  }

  return { resize, step, sample, active: () => energy > 0.01 };
}
