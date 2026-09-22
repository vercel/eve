import { deserializeContext } from "#context/serialize.js";
import { withContextScope } from "#context/run-step.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { captureWorkflowSandboxReference } from "#execution/sandbox/workflow-reference.js";
import type { WorkflowSandboxResponse } from "#execution/sandbox/workflow-request.js";
import type { WorkflowToolRunRequestMessage } from "#execution/tools/workflow/messages.js";
import {
  findBlockingWorkflowToolRun,
  findBackgroundWorkflowToolRun,
  readWorkflowTaskView,
} from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";

import { getRun } from "#internal/workflow/runtime.js";

const log = createLogger("execution.workflow-sandbox");

export async function prepareWorkflowSandboxStep(input: {
  readonly message: WorkflowToolRunRequestMessage;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly sessionState: DurableSessionState;
  readonly response?: WorkflowSandboxResponse;
}> {
  "use step";

  if (
    input.message.request.kind !== "sandbox-request" ||
    !input.message.replyTo.startsWith("eve.sandbox.") ||
    input.message.replyTo.length > 256
  ) {
    return { sessionState: input.sessionState };
  }
  const durable = readDurableSession(input.sessionState);
  const { from, request } = input.message;
  const recorded =
    request.taskId === undefined
      ? findBlockingWorkflowToolRun(durable.state, from.callId, from.turnId)
      : findBackgroundWorkflowToolRun(durable.state, request.taskId);
  const accepted =
    recorded?.address.runId === from.runId &&
    recorded.toolName === from.toolName &&
    recorded.origin.turnId === from.turnId &&
    (recorded.lifetime === "turn" || readWorkflowTaskView(recorded.task) === undefined);
  if (!accepted) {
    return {
      sessionState: input.sessionState,
    };
  }
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({ durable, turnAgent: bundle.turnAgent });
  try {
    const scoped = await withContextScope(ctx, session, async (current) => ({
      result: await captureWorkflowSandboxReference({ ctx, session: current }),
      session: current,
    }));
    return {
      sessionState: replaceDurableSessionSnapshot({
        state: input.sessionState,
        session: projectToDurableSession(scoped.session),
      }),
      response: { reference: scoped.result },
    };
  } catch (error) {
    logError(log, "workflow sandbox initialization failed", error, {
      sessionId: session.sessionId,
    });
    return {
      sessionState: input.sessionState,
      response: { error: "Could not initialize the session sandbox. Check the server logs." },
    };
  } finally {
    ctx.clearVirtualContext();
  }
}

/** Publish only after the preparation step has persisted the owner's updated snapshot. */
export async function respondWorkflowSandboxStep(input: {
  readonly message: WorkflowToolRunRequestMessage;
  readonly response: WorkflowSandboxResponse;
}): Promise<void> {
  "use step";

  const namespace = input.message.replyTo;
  if (!namespace.startsWith("eve.sandbox.") || namespace.length > 256) {
    throw new Error("Invalid workflow sandbox response namespace.");
  }
  const run = getRun(input.message.from.runId);
  const existing = run.getReadable({ namespace });
  try {
    if ((await existing.getTailIndex()) >= 0) return;
  } finally {
    await existing.cancel().catch(() => {});
  }
  const writer = run.getWritable<WorkflowSandboxResponse>({ namespace }).getWriter();
  try {
    await writer.write(input.response);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
