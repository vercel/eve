import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { traceSessionHandover } from "#execution/session/handover-tracing.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import { delivered, type StepMeta } from "#execution/durable.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";
import { startedApp, type App } from "#runtime/app.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";

function workflowStepHost(app: App): SessionStepHost {
  const { platform } = app;
  let callbackBaseUrl: string | undefined;
  try {
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string")
      callbackBaseUrl = resolveWorkflowCallbackBaseUrl(metadata.url, platform);
  } catch {}
  const { durable } = app;
  return {
    app,
    hosts: app.hosts,
    callbackBaseUrl,
    createRuntime: createWorkflowRuntime,
    setAttributes: setEveAttributes,
    toolStubs: workflowToolStubs,
    deliver: (to, payload) => delivered(durable.deliver(to, payload)),
  };
}

export interface WorkflowTurnStepInput extends TurnStepInput {
  readonly abortSignal?: AbortSignal;
  readonly steeringSignal?: AbortSignal;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

export async function turnStep(input: WorkflowTurnStepInput): Promise<TurnStepResult> {
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
  const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
  const step = getStepMetadata();
  const meta: StepMeta = {
    attempt: step.attempt,
    key: step.stepId,
    sessionId: data.sessionState.sessionId,
    ...(abortSignal !== undefined &&
      steeringSignal !== undefined && { signals: { cancel: abortSignal, steer: steeringSignal } }),
  };
  return await turnStepOn(workflowStepHost(startedApp()))(data, meta, sessionWritable);
}
