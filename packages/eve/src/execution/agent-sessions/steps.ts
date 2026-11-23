import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  agentSessionsOver,
  type LocalAgentSessions,
} from "#execution/agent-sessions/sessions-over.js";
import { remoteReplyHookToken } from "#execution/callback-hook-tokens.js";
import type {
  AgentSessionMessage,
  AgentSessionOpenInput,
  AgentSessionReceipt,
  OpenedAgentSession,
  StartedAgentSession,
} from "#execution/agent-sessions/start.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeSessionStartHook } from "#execution/session-inbox/resume.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { platformOf } from "#platform/context.js";
import { processApp, type App } from "#runtime/app.js";
import { sessionAddress } from "#execution/durable.js";
import { workflowSessionFor } from "#execution/workflow-host/session-durable.js";
import {
  createWorkflowRuntime,
  dispatchWorkflowSessionCommand,
} from "#execution/workflow-runtime.js";

const WORKFLOW_LOCAL_SESSIONS: LocalAgentSessions = {
  async start(prepared, { context }) {
    const childRuntime = createWorkflowRuntime(prepared.runtime);
    const started = await contextStorage.run(
      new ContextContainer({ localDevRequest: context.localDevRequest }),
      () => childRuntime.createSession(prepared.runInput),
    );
    return { address: prepared.address(started.sessionId), deliveryId: prepared.deliveryId };
  },
  async command(opened, command) {
    const { continuationToken, sessionId } = opened.address;
    const result = await dispatchWorkflowSessionCommand({ command, sessionId });
    if (result.status === "accepted" || result.status === "reset") return result;
    const current = await workflowSessionFor(sessionAddress(continuationToken));
    if (current === undefined || current === sessionId) return result;
    return await dispatchWorkflowSessionCommand({ command, sessionId: current });
  },
  async commandLate(sessionId, command) {
    try {
      await resumeHook(sessionInboxHookToken(sessionCommandHookToken(sessionId)), command);
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if ((await resumeSessionStartHook(sessionId, command)) === undefined) throw error;
    }
  },
};

function workflowAgentSessions(app: App | undefined) {
  return agentSessionsOver({
    deliveryId: (kind, sessionId) =>
      `agent-session:${getWorkflowMetadata().workflowRunId}:${getStepMetadata().stepId}:${sessionId}:${kind}`,
    local: WORKFLOW_LOCAL_SESSIONS,
    remote: {
      callbackBaseUrl: () =>
        resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url, platformOf(app)),
    },
  });
}

export async function openAgentSessionStep(
  input: AgentSessionOpenInput,
): Promise<StartedAgentSession> {
  "use step";

  return await workflowAgentSessions(processApp().started).open(input);
}

export async function sendAgentSessionMessageStep(
  input: AgentSessionMessage & OpenedAgentSession,
): Promise<AgentSessionReceipt> {
  "use step";

  return await workflowAgentSessions(processApp().started).send(input);
}

export async function createRemoteReplyTokenStep(): Promise<string> {
  "use step";

  return remoteReplyHookToken(crypto.randomUUID());
}

export async function cancelAgentSessionTurnStep(input: OpenedAgentSession): Promise<void> {
  "use step";

  await workflowAgentSessions(processApp().started).cancelTurn(input);
}

export async function endAgentSessionsStep(input: {
  readonly sessions: readonly OpenedAgentSession[];
}): Promise<void> {
  "use step";

  await workflowAgentSessions(processApp().started).end(input);
}

export async function stopLateAgentSessionStep(opened: OpenedAgentSession): Promise<void> {
  "use step";

  await workflowAgentSessions(processApp().started).stopLate(opened);
}
