import { sleep } from "#compiled/@workflow/core/index.js";
import { dispatchCoordinationStep } from "#execution/workflow-host/dispatch-step.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { SessionHandoff } from "#execution/session/handoff.js";
import type { SessionBoot, SessionHost } from "#execution/session/program.js";
import { turnStep } from "#execution/workflow-host/turn-step.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";

/**
 * The Workflow host for the session `boot` describes, from its owner run's workflow body: each
 * turn step is a durable `turnStep`, waits sleep durably, and the session moves between runs.
 */
export function workflowSessionHost(boot: SessionBoot, inbox: SessionInboxHandle): SessionHost {
  return {
    moves: new SessionHandoff({
      checkpoint: {
        capabilities: boot.capabilities,
        retention: boot.retention,
        sessionTimeoutMs: boot.sessionTimeoutMs,
      },
      deploymentId: boot.deploymentId,
      inbox,
      isInitialOwner: boot.anchor.kind === "self",
      sessionId: boot.sessionId,
      sessionWritable: boot.sessionWritable,
    }),
    applyRunMessages: (input) => applyRunMessagesStep(input),
    dispatchRuns: (input) => dispatchCoordinationStep(input),
    runTurnStep: (input) => turnStep(input),
    sleep: (ms) => sleep(ms),
    toolStubs: workflowToolStubs,
  };
}
