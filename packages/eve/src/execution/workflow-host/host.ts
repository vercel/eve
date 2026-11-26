import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { installDurableHost, type DurableHost } from "#execution/hosts.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import { resumeSignInCallback } from "#execution/session-inbox/owner.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  deliverSubscriptionEvent,
  emitSubscriptionEvent,
  findSubscriptionOwner,
  retireSubscriptionOwner,
  startSubscriptionOwner,
} from "#runtime/subscriptions/owner.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";

const workflowLineStore: SessionLineStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
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

export const workflowHost: DurableHost = {
  name: "workflow",
  deliver: async (to, payload) => {
    if ("hook" in to) await resumeHook(to.hook, payload);
    else if ("session" in to) await resumeSessionInbox(to.session, payload as DeliverHookPayload);
    else await resumeSignInCallback(to.signIn, payload as AuthorizationCallbackPayload);
  },
  runStatus: async (runId) => await getRun(runId).status,
  cancelRun: async (runId, reason) => {
    await cancelRun(await getWorld(), runId, { cancelReason: reason });
  },
  lineStore: workflowLineStore,
  createRuntime: (input) => createWorkflowRuntime(input),
  subscriptions: {
    start: (binding, bundle, signal) => startSubscriptionOwner(binding, bundle, signal),
    find: (bindingId) => findSubscriptionOwner(bindingId),
    retire: (bindingId) => retireSubscriptionOwner(bindingId),
    emit: (channelName, key, occurrence, source) =>
      emitSubscriptionEvent(channelName, key, occurrence, source),
    deliver: (bindingId, from, occurrence, source) =>
      deliverSubscriptionEvent(bindingId, from, occurrence, source),
  },
  callbackBaseUrl() {
    try {
      const { url } = getWorkflowMetadata();
      return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url) : undefined;
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

export function installWorkflowHost(): void {
  installDurableHost(workflowHost);
}
