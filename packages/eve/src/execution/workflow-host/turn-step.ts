import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { traceSessionHandover } from "#execution/session/handover-tracing.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";

/** The Workflow host of a turn step: its run's callback URL, attributes, runtime and stubs. */
function workflowStepHost(): SessionStepHost {
  let callbackBaseUrl: string | undefined;
  try {
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string")
      callbackBaseUrl = resolveWorkflowCallbackBaseUrl(metadata.url);
  } catch {
    // Outside a workflow context (e.g. tests) — getHookUrl will return undefined.
  }
  return {
    callbackBaseUrl,
    createRuntime: createWorkflowRuntime,
    setAttributes: setEveAttributes,
    toolStubs: workflowToolStubs,
  };
}

/** Runs a bounded batch of harness model steps inside one durable `"use step"` boundary. */
export async function turnStep(input: TurnStepInput): Promise<TurnStepResult> {
  "use step";
  if (input.handover !== undefined) {
    traceSessionHandover(
      "inbox_unblocked",
      input.sessionState.sessionId,
      input.handover.attemptKey,
      {
        "eve.handoff.buffered_payload_count": input.handover.payloadCount,
        "eve.handoff.applied_at_ms": input.handover.appliedAtMs,
        "eve.handoff.applied_at_clock": "workflow",
      },
    );
  }
  return await turnStepOn(workflowStepHost())(input);
}
