import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { installDurableHost, type DurableHost } from "#execution/hosts.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { resumeSignInCallback } from "#execution/session-inbox/owner.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  findConnectionEventOwner,
  retireConnectionEventOwner,
  startConnectionEventOwner,
} from "#runtime/connections/events/owner.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import type { Entities } from "#platform/entities.js";

const workflowSessionEvents: SessionEventStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
    const readable = getRun(sessionId).getReadable();
    try {
      const [, tailIndex] = await Promise.all([
        workflowSessionEvents.assertReadable(sessionId),
        readable.getTailIndex(),
      ]);
      return tailIndex;
    } finally {
      await readable.cancel().catch(() => {});
    }
  },
  async assertReadable(sessionId) {
    const world = await getWorld();
    const run = await world.runs.get(sessionId, { resolveData: "none" });
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

export function createWorkflowHost(platform: Entities): DurableHost {
  return {
    name: "workflow",
    deliver: async (to, payload) => {
      if ("hook" in to) await resumeHook(to.hook, payload);
      else if ("session" in to) await resumeSessionInbox(to.session, payload as DeliverHookPayload);
      else await resumeSignInCallback(to.signIn, payload as AuthorizationCallbackPayload);
    },
    deploymentId: async () =>
      platform.deployment.deploymentId() ?? (await (await getWorld()).getDeploymentId()),
    async findRun(runId) {
      try {
        const run = await (await getWorld()).runs.get(runId);
        return {
          attributes: run.attributes,
          createdAt: run.createdAt,
          expiredAt: run.expiredAt,
          runId: run.runId,
          status: run.status,
        };
      } catch (error) {
        if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
        throw error;
      }
    },
    runStatus: async (runId) => await getRun(runId).status,
    cancelRun: async (runId, reason) => {
      await cancelRun(await getWorld(), runId, { cancelReason: reason });
    },
    sessionEvents: workflowSessionEvents,
    createRuntime: (input) => createWorkflowRuntime(input),
    connectionEvents: {
      start: (binding, bundle, signal) => startConnectionEventOwner(binding, bundle, signal),
      find: (bindingId) => findConnectionEventOwner(bindingId),
      retire: (bindingId) => retireConnectionEventOwner(bindingId),
    },
    callbackBaseUrl() {
      try {
        const { url } = getWorkflowMetadata();
        return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url, platform) : undefined;
      } catch (error) {
        if (error instanceof Error && error.name === "NotInWorkflowOrStepContextError") {
          return undefined;
        }
        throw error;
      }
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
}

export function installWorkflowHost(platform: Entities): void {
  installDurableHost(createWorkflowHost(platform));
}
