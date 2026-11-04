import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { installDurableHost, type DurableHost } from "#execution/hosts.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  findConnectionEventOwner,
  retireConnectionEventOwner,
  startConnectionEventOwner,
} from "#runtime/connections/events/owner.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";

// Workflow as this realm's durable host: the hooks, runs and session streams no host here holds
// live on Workflow, and its steps are retried. It's installed with the code that runs on Workflow:
// its builtin steps, which every Workflow step bundle registers (`internal/workflow/builtins.ts`),
// and `createWorkflowRuntime`.

/** Each session's stream is the readable of the run that started it. */
const workflowLineStore: SessionLineStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
    // The readable is never consumed; cancel it so the unread source does not linger.
    const readable = getRun(sessionId).getReadable();
    try {
      const [, tailIndex] = await Promise.all([
        workflowLineStore.assertReadable(sessionId),
        readable.getTailIndex(),
      ]);
      return tailIndex;
    } finally {
      await readable.cancel().catch(() => {});
    }
  },
  // Cheaper than `tail`, whose lookup on the local world opens every chunk file.
  async assertReadable(sessionId) {
    const world = await getWorld();
    const run = await world.runs.get(sessionId, { resolveData: "none" });
    // Purging can leave chunk records behind; their count does not imply readable data.
    if (run.expiredAt !== undefined && run.expiredAt.getTime() <= Date.now()) {
      throw new RunExpiredError(
        "Session history is no longer available.",
        sessionId,
        run.status,
        run.expiredAt,
      );
    }
  },
};

/** Workflow's host. Its step metadata names the attempt; outside a step there's none. */
export const workflowHost: DurableHost = {
  name: "workflow",
  resumeHook: async (token, payload) => {
    await resumeHook(token, payload);
  },
  resumeSessionInbox: async (address, delivery) => {
    await resumeSessionInbox(address, delivery);
  },
  runStatus: async (runId) => await getRun(runId).status,
  cancelRun: async (runId, reason) => {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
  },
  lineStore: workflowLineStore,
  // Both modules import this one back, so each member reads its binding when it's called.
  createRuntime: (input) => createWorkflowRuntime(input),
  connectionEvents: {
    // Each watch is a run on the current deployment.
    start: (binding, bundle, signal) => startConnectionEventOwner(binding, bundle, signal),
    find: (bindingId) => findConnectionEventOwner(bindingId),
    retire: (bindingId) => retireConnectionEventOwner(bindingId),
  },
  stepAttempt() {
    try {
      return getStepMetadata().attempt;
    } catch (error) {
      if (error instanceof Error && error.name === "NotInStepContextError") return undefined;
      throw error;
    }
  },
};

/** Makes Workflow this realm's durable host. */
export function installWorkflowHost(): void {
  installDurableHost(workflowHost);
}
