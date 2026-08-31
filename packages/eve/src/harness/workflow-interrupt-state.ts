import type { ModelMessage } from "ai";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

const PENDING_KEY = "eve.harness.pendingWorkflowInterrupt";

export const WORKFLOW_RUNTIME_UPGRADE_MESSAGE =
  "The Workflow runtime was upgraded while this invocation was paused. Run the Workflow again.";

export interface PendingWorkflowInterrupt {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly responseMessages: readonly ModelMessage[];
  readonly usedCalls: number;
  readonly version: 2;
}

export interface LegacyPendingWorkflowInterrupt {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly responseMessages: readonly ModelMessage[];
  readonly usedCalls: 0;
  readonly version: 1;
}

export type StoredPendingWorkflowInterrupt =
  | LegacyPendingWorkflowInterrupt
  | PendingWorkflowInterrupt;

export function getPendingWorkflowInterrupt(
  state: SessionStateMap | undefined,
): StoredPendingWorkflowInterrupt | undefined {
  const value = state?.[PENDING_KEY];
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.responseMessages)) return undefined;

  if (isLegacyWorkflowInterruptShape(value.interrupt)) {
    return {
      interrupt: value.interrupt as WorkflowSandboxInterrupt,
      responseMessages: value.responseMessages as ModelMessage[],
      usedCalls: 0,
      version: 1,
    };
  }

  if (value.version !== 2 || !isWorkflowInterruptShape(value.interrupt)) return undefined;
  if (!Number.isSafeInteger(value.usedCalls) || (value.usedCalls as number) < 0) return undefined;

  return {
    interrupt: value.interrupt,
    responseMessages: value.responseMessages as ModelMessage[],
    usedCalls: value.usedCalls as number,
    version: 2,
  };
}

export function isLegacyPendingWorkflowInterrupt(
  pending: StoredPendingWorkflowInterrupt,
): pending is LegacyPendingWorkflowInterrupt {
  return pending.version === 1;
}

export function setPendingWorkflowInterrupt(input: {
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly usedCalls: number;
}): HarnessSession {
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [PENDING_KEY]: {
        interrupt: input.interrupt,
        responseMessages: input.responseMessages,
        usedCalls: input.usedCalls,
        version: 2,
      } satisfies PendingWorkflowInterrupt,
    },
  };
}

export function setPendingWorkflowUsedCalls(input: {
  readonly session: HarnessSession;
  readonly usedCalls: number;
}): HarnessSession {
  const pending = getPendingWorkflowInterrupt(input.session.state);
  if (pending === undefined || pending.version === 1) return input.session;
  return setPendingWorkflowInterrupt({
    ...pending,
    session: input.session,
    usedCalls: input.usedCalls,
  });
}

function isLegacyWorkflowInterruptShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "code-mode-interrupt" &&
    typeof value.interruptId === "string" &&
    typeof value.outerToolCallId === "string" &&
    isRecord(value.payload) &&
    value.payload.kind === WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND &&
    isRecord(value.continuation) &&
    value.continuation.version === 1 &&
    typeof value.continuation.outerToolCallId === "string" &&
    Array.isArray(value.continuation.ledger)
  );
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
    value.continuation.version === 2 &&
    typeof value.continuation.outerToolCallId === "string" &&
    Array.isArray(value.continuation.pendingInterruptions) &&
    Array.isArray(value.continuation.resolutions)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
