import type { World } from "#compiled/@workflow/world/index.js";

/**
 * Whether `start()` can claim a hook token atomically with admitting the run,
 * so a duplicate start is refused instead of becoming a run.
 */
export function supportsStartClaims(world: World): boolean {
  return world.capabilities?.atomicStartHook?.active === true;
}

/**
 * Mints the id `start()` will give the run and pins it on a view of the
 * World, so a start hook can carry metadata naming its own run. `start()`
 * names the run `wrun_<world.createRunId(options)>`; worlds without
 * `createRunId` get the same monotonic ULID `start()` would mint.
 */
export function pinRunId(
  world: World,
  options: Readonly<Record<string, unknown>>,
): { readonly runId: string; readonly world: World } {
  const bareId = world.createRunId?.(options) ?? monotonicUlid();
  const pinned = new Proxy(world, {
    get(target, key) {
      if (key === "createRunId") return () => bareId;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { runId: `wrun_${bareId}`, world: pinned };
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

function monotonicUlid(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    // 256 is a multiple of 32, so masking keeps each digit uniform.
    lastRandom = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte & 31);
  } else {
    for (let index = 15; index >= 0; index--) {
      if (lastRandom[index]! < 31) {
        lastRandom[index]! += 1;
        break;
      }
      lastRandom[index] = 0;
    }
  }
  let time = "";
  for (let rest = lastTime, digit = 0; digit < 10; digit++, rest = Math.floor(rest / 32)) {
    time = ULID_ALPHABET[rest % 32] + time;
  }
  return time + lastRandom.map((digit) => ULID_ALPHABET[digit]).join("");
}
