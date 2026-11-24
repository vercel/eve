import { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import { publishDispatchedCallsStep } from "#execution/coordination-dispatch-step.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { mapHeldAnswersStep } from "#execution/proxied-deliver-step.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import {
  endSessionSandboxStep,
  reportSessionSandboxCleanupFailureStep,
} from "#execution/session/end-sandbox-step.js";
import { settleDuplicateDeliveryStep } from "#execution/session/settle-duplicate-delivery-step.js";
import { cancelTasksStep } from "#execution/tasks/steps.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import {
  reportChildSessionTeardownFailureStep,
  terminateChildSessionsStep,
} from "#execution/terminate-child-sessions-step.js";
import { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { SessionStepTable } from "#execution/session/steps.js";
import { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";

export const SHARED_SESSION_STEPS = {
  publishDispatchedCalls: publishDispatchedCallsStep,
  interruptRun: interruptWorkflowToolRun,
  startTaskToolCalls: () => startTaskToolCallsStep(),
  settleControlDelivery: settleControlDeliveryStep,
  stopIdleSandbox: stopIdleSessionSandboxStep,
  settleCancelledTurn: settleCancelledTurnStep,
  notifyCancelledTaskCaller: notifyCancelledTaskCallerStep,
  prewarmSession: prewarmSessionStep,
  resolveInitialTurnCaller: resolveInitialTurnCallerStep,
  notifyTurnCaller: notifyTurnCallerStep,
  createSession: createSessionStep,
  closeSessionStream: closeSessionStreamStep,
  terminateChildSessions: terminateChildSessionsStep,
  reportChildSessionTeardownFailure: reportChildSessionTeardownFailureStep,
  endSessionSandbox: endSessionSandboxStep,
  reportSessionSandboxCleanupFailure: reportSessionSandboxCleanupFailureStep,
  emitTerminalSessionCompletion: emitTerminalSessionCompletionStep,
  emitTerminalSessionFailure: emitTerminalSessionFailureStep,
  settleDuplicateDelivery: settleDuplicateDeliveryStep,
  reportDroppedWirePayload: reportDroppedWirePayloadStep,
  mapHeldAnswers: mapHeldAnswersStep,
  cancelTasks: cancelTasksStep,
} as const satisfies Omit<SessionStepTable, "turn" | "dispatchRuns" | "applyRunMessages">;
