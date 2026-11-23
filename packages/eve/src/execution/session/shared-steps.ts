import { publishDispatchedCallsStep } from "#execution/coordination-dispatch-step.js";
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
} as const satisfies Omit<SessionStepTable, "turn" | "dispatchRuns" | "applyRunMessages">;
