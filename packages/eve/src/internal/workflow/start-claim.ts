import type { World } from "#compiled/@workflow/world/index.js";

export function assertStartClaims(world: World): void {
  if (world.capabilities?.atomicStartHook?.active === true) return;
  throw new Error(
    "The configured Workflow world does not support atomic start hooks, which eve needs to start a session. Use the local world, Vercel Workflow, or @workflow/world-postgres 5.1.1 or later.",
  );
}

const RUN_ID_PREFIX = "wrun_";

export function createRunId(world: World, options: Readonly<Record<string, unknown>>): string {
  return `${RUN_ID_PREFIX}${world.createRunId?.(options) ?? monotonicUlid()}`;
}

export function pinRunId(
  world: World,
  options: Readonly<Record<string, unknown>>,
  runId = createRunId(world, options),
): { readonly runId: string; readonly world: World } {
  if (!runId.startsWith(RUN_ID_PREFIX))
    throw new Error(`"${runId}" is not a Workflow run ID, so a run can't start with it.`);
  const bareId = runId.slice(RUN_ID_PREFIX.length);
  const pinned = new Proxy(world, {
    get(target, key) {
      if (key === "createRunId") return () => bareId;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { runId, world: pinned };
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

function monotonicUlid(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
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
