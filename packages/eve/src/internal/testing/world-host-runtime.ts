import { appendFileSync } from "node:fs";
import { expect } from "vitest";

import type { ActivationOutcome } from "#execution/actor/actors.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { InProcessRuntime, InProcessRuntimeOptions } from "#execution/in-process/runtime.js";
import { withMemoryQueue, type MemoryQueueWorld } from "#execution/world/memory-queue.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { createWorldHost, type WorldHost } from "#execution/world-host/host.js";

// A World host as a test drives an in-process runtime: the same calls, reaching sessions that
// run only in activations, on a World in this process's memory with a queue that delivers here
// (`memory-queue.ts`). What only an in-process runtime does (snapshots, restores, a session's
// running steps) is refused, with why. Waiting for rest waits for the queue to have nothing due:
// every activation ran until its session waits.

const AGENT = "agent";

/**
 * With `EVE_TEST_ACTIVATION_LOG` set, each activation appends a line to that file naming the
 * test it ran in and how it ended, so a run can show its sessions ran in activations.
 */
function traceActivation(activation: {
  readonly sessionId: string;
  readonly outcome: ActivationOutcome;
  readonly ms: number;
}): void {
  const file = process.env.EVE_TEST_ACTIVATION_LOG;
  if (file === undefined || file === "") return;
  let state: { readonly testPath?: string; readonly currentTestName?: string } | undefined;
  try {
    state = expect.getState();
  } catch {
    // Outside a test.
  }
  appendFileSync(
    file,
    `${JSON.stringify({ file: state?.testPath, ms: activation.ms, outcome: activation.outcome.kind, test: state?.currentTestName })}\n`,
  );
}

export interface TestWorldHostRuntime extends InProcessRuntime {
  readonly host: WorldHost;
  readonly world: MemoryQueueWorld;
}

/** A World host for the test runtime's compiled agent, as an `InProcessRuntime`. */
export function createTestWorldHostRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions = {},
): TestWorldHostRuntime {
  const world = withMemoryQueue(memoryWorld());
  const { callbackBaseUrl, world: _world, lineStore: _lines, ...runtimeOptions } = options;
  const host = createWorldHost({
    agents: { [AGENT]: config.compiledArtifactsSource },
    observe: traceActivation,
    runtimeOptions,
    world,
    ...(callbackBaseUrl !== undefined && { callbackBaseUrl }),
  });
  const ready = host.serve();
  const front = host.runtime(AGENT);
  const refused = (what: string): never => {
    throw new Error(`${what} is an in-process runtime's; a World host's sessions run elsewhere.`);
  };
  /** Until nothing is due on the World's queue, and still nothing a moment later. */
  const idle = async (): Promise<void> => {
    await ready;
    for (let quiet = 0; quiet < 3;) {
      await world.idle();
      await new Promise((resolve) => setTimeout(resolve, 10));
      quiet += 1;
    }
  };
  return {
    host,
    world,
    createSession: async (input) => (await ready, await front.createSession(input)),
    dispatchContinuation: async (input) => (await ready, await front.dispatchContinuation(input)),
    dispatchSession: async (input) => (await ready, await front.dispatchSession(input)),
    resolveContinuation: async (token) => (await ready, await front.resolveContinuation(token)),
    getEventStream: (sessionId, streamOptions) => front.getEventStream(sessionId, streamOptions),
    getLineStream: (sessionId, streamOptions) => front.getLineStream(sessionId, streamOptions),
    getStreamTailIndex: (sessionId) => front.getStreamTailIndex(sessionId),
    ...(front.readChildBinding !== undefined && { readChildBinding: front.readChildBinding }),
    startEntry: async (entry) => (await ready, await front.startEntry(entry)),
    registerWorkflow: (workflowId, body) => host.registerWorkflow(workflowId, body),
    idle: async (sessionId) => {
      if (sessionId !== undefined) refused("Waiting on one session's step");
      await idle();
    },
    async settled(sessionId) {
      // Ended once its actor did; a session waiting on something hasn't.
      for (;;) {
        await idle();
        const info = await host.actors.info(sessionId);
        if (info === undefined || info.status !== "running") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    holds: () => refused("Asking which addresses are held here"),
    stepsRunning: () => 0,
    snapshot: async () => refused("A snapshot"),
    restore: async () => refused("A restore"),
    load: async () => refused("Loading a session"),
    sessions: async () => refused("Listing sessions"),
    end: async () => refused("Ending a session here"),
    startSession: async (_sessionId, input) => (await ready, await front.createSession(input)),
    quiescent: async () => refused("Quiescence"),
    busy: () => false,
    nextTimer: () => undefined,
    drain: async () => {},
    ended: () => false,
    deliver: async () => refused("Delivering to a hook here"),
    activity: () => ({ deliveries: 0, parked: [], runs: [], sessions: [], working: false }),
    async dispose() {
      // What an activation is running finishes first, briefly, so it doesn't outlive the test.
      await Promise.race([idle(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      await host.close();
      await world.close();
    },
  };
}
