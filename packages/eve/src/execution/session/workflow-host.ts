import { sleep } from "#compiled/@workflow/core/index.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { SessionHandoff } from "#execution/session/handoff.js";
import { sessionHostClock } from "#execution/session/host-clock.js";
import type { SessionBoot, SessionHost } from "#execution/session/program.js";
import { workflowSessionStep } from "#execution/workflow-host/session-steps.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";

export function workflowSessionHost(boot: SessionBoot, inbox: SessionInboxHandle): SessionHost {
  return {
    ...sessionHostClock(inbox, (at) => sleep(new Date(at))),
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
    step: workflowSessionStep,
    toolStubs: workflowToolStubs,
  };
}
