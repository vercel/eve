import { defineTool } from "eve/tools";
import { z } from "zod";

const EXPECTED_CONCURRENT_CALLS = 10;
const BARRIER_TIMEOUT_MS = 15_000;

interface Barrier {
  arrived: number;
  departed: number;
  readonly released: Promise<void>;
  readonly release: () => void;
}

let activeBarrier: Barrier | undefined;

export default defineTool({
  description:
    "Test-only tool: waits for ten concurrent calls before releasing them. Only call when the user explicitly asks to use `fanout-barrier`.",
  inputSchema: z.object({
    label: z.string(),
  }),
  async execute(input) {
    const barrier = joinBarrier();

    try {
      await waitForRelease(barrier.released);
      return { concurrentCallsAtRelease: barrier.arrived, label: input.label };
    } finally {
      barrier.departed += 1;
      if (barrier.departed === barrier.arrived && activeBarrier === barrier) {
        activeBarrier = undefined;
      }
    }
  },
});

function joinBarrier(): Barrier {
  const barrier = activeBarrier ?? createBarrier();
  activeBarrier = barrier;

  if (barrier.arrived >= EXPECTED_CONCURRENT_CALLS) {
    throw new Error("fanout-barrier received more than ten concurrent calls");
  }

  barrier.arrived += 1;
  if (barrier.arrived === EXPECTED_CONCURRENT_CALLS) {
    barrier.release();
  }
  return barrier;
}

function createBarrier(): Barrier {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived: 0, departed: 0, release, released };
}

async function waitForRelease(released: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      released,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("fanout-barrier timed out waiting for ten concurrent calls"));
        }, BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
