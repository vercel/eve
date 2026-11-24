import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { traceSessionHandover } from "#execution/session/handover-tracing.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import { delivered } from "#execution/durable.js";
import { workflowDurable } from "#execution/workflow-host/host.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";
import { platformOf } from "#platform/context.js";
import { hostsOf, processApp, type App } from "#runtime/app.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";

function workflowStepHost(app: App | undefined): SessionStepHost {
  const platform = platformOf(app);
  let callbackBaseUrl: string | undefined;
  try {
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string")
      callbackBaseUrl = resolveWorkflowCallbackBaseUrl(metadata.url, platform);
  } catch {}
  const durable = app?.durable ?? workflowDurable();
  return {
    app,
    hosts: hostsOf(app),
    callbackBaseUrl,
    createRuntime: createWorkflowRuntime,
    setAttributes: setEveAttributes,
    toolStubs: workflowToolStubs,
    deliver: (to, payload) => delivered(durable.deliver(to, payload)),
  };
}

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
  return await turnStepOn(workflowStepHost(processApp().started))(input);
}
