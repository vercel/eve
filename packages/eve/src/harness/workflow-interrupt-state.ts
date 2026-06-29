import type { ModelMessage } from "ai";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

const PENDING_KEY = "eve.harness.pendingWorkflowInterrupt";

export interface PendingWorkflowInterrupt {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly responseMessages: readonly ModelMessage[];
}

export function getPendingWorkflowInterrupt(
  state: SessionStateMap | undefined,
): PendingWorkflowInterrupt | undefined {
  const value = state?.[PENDING_KEY];
  if (!isRecord(value)) return undefined;
  if (!isWorkflowInterruptShape(value.interrupt) || !Array.isArray(value.responseMessages)) {
    return undefined;
  }
  return {
    interrupt: value.interrupt,
    responseMessages: value.responseMessages as ModelMessage[],
  };
}

export function setPendingWorkflowInterrupt(input: {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [PENDING_KEY]: {
        interrupt: input.interrupt,
        responseMessages: input.responseMessages,
      } satisfies PendingWorkflowInterrupt,
    },
  };
}

export function clearPendingWorkflowInterrupt(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_KEY] === undefined) return session;

  const state = { ...session.state };
  delete state[PENDING_KEY];
  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}

function isWorkflowInterruptShape(value: unknown): value is WorkflowSandboxInterrupt {
  return (
    isRecord(value) &&
    value.type === "code-mode-interrupt" &&
    typeof value.interruptId === "string" &&
    typeof value.outerToolCallId === "string" &&
    isRecord(value.payload) &&
    value.payload.kind === WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND &&
    isRecord(value.continuation) &&
    typeof value.continuation.outerToolCallId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
