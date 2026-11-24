import type {
  CoordinationDispatchInput,
  CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import type { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import type { publishDispatchedCallsStep } from "#execution/coordination-dispatch-step.js";
import type { createSessionStep } from "#execution/create-session-step.js";
import type {
  mapHeldAnswersStep,
  routeProxiedDeliverStep,
} from "#execution/proxied-deliver-step.js";
import type { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type {
  endSessionSandboxStep,
  reportSessionSandboxCleanupFailureStep,
} from "#execution/session/end-sandbox-step.js";
import type { settleDuplicateDeliveryStep } from "#execution/session/settle-duplicate-delivery-step.js";
import type { cancelTasksStep } from "#execution/tasks/steps.js";
import type { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import type { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import type {
  reportChildSessionTeardownFailureStep,
  terminateChildSessionsStep,
} from "#execution/terminate-child-sessions-step.js";
import type { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import type { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import type { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { StepSignals } from "#execution/durable.js";
import type { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import type { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import type {
  ApplyRunMessagesInput,
  ApplyRunMessagesResult,
} from "#execution/tools/workflow/apply-run-messages.js";
import type { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import type { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type {
  withdrawFinishedRunQuestionsStep,
  withdrawWorkflowToolRunQuestionStep,
} from "#execution/tools/workflow/withdraw-step.js";
import type { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";

type StepOf<F extends (input: never) => Promise<unknown>> = {
  readonly input: Parameters<F>[0];
  readonly result: Awaited<ReturnType<F>>;
};

export interface SessionStepTypes {
  readonly turn: { readonly input: TurnStepInput; readonly result: TurnStepResult };
  readonly dispatchRuns: {
    readonly input: CoordinationDispatchInput;
    readonly result: WithSessionStateDelta<CoordinationDispatchResult>;
  };
  readonly applyRunMessages: {
    readonly input: ApplyRunMessagesInput;
    readonly result: ApplyRunMessagesResult;
  };
  readonly publishDispatchedCalls: StepOf<typeof publishDispatchedCallsStep>;
  readonly interruptRun: StepOf<typeof interruptWorkflowToolRun>;
  readonly startTaskToolCalls: StepOf<typeof startTaskToolCallsStep>;
  readonly settleControlDelivery: StepOf<typeof settleControlDeliveryStep>;
  readonly stopIdleSandbox: StepOf<typeof stopIdleSessionSandboxStep>;
  readonly settleCancelledTurn: StepOf<typeof settleCancelledTurnStep>;
  readonly notifyCancelledTaskCaller: StepOf<typeof notifyCancelledTaskCallerStep>;
  readonly prewarmSession: StepOf<typeof prewarmSessionStep>;
  readonly resolveInitialTurnCaller: StepOf<typeof resolveInitialTurnCallerStep>;
  readonly notifyTurnCaller: StepOf<typeof notifyTurnCallerStep>;
  readonly createSession: StepOf<typeof createSessionStep>;
  readonly closeSessionStream: StepOf<typeof closeSessionStreamStep>;
  readonly terminateChildSessions: StepOf<typeof terminateChildSessionsStep>;
  readonly reportChildSessionTeardownFailure: StepOf<typeof reportChildSessionTeardownFailureStep>;
  readonly endSessionSandbox: StepOf<typeof endSessionSandboxStep>;
  readonly reportSessionSandboxCleanupFailure: StepOf<
    typeof reportSessionSandboxCleanupFailureStep
  >;
  readonly emitTerminalSessionCompletion: StepOf<typeof emitTerminalSessionCompletionStep>;
  readonly emitTerminalSessionFailure: StepOf<typeof emitTerminalSessionFailureStep>;
  readonly settleDuplicateDelivery: StepOf<typeof settleDuplicateDeliveryStep>;
  readonly reportDroppedWirePayload: StepOf<typeof reportDroppedWirePayloadStep>;
  readonly mapHeldAnswers: StepOf<typeof mapHeldAnswersStep>;
  readonly cancelTasks: StepOf<typeof cancelTasksStep>;
  readonly routeProxiedDeliver: StepOf<typeof routeProxiedDeliverStep>;
  readonly proxySubagentEvent: StepOf<typeof runProxySubagentEventStep>;
  readonly withdrawFinishedRunQuestions: StepOf<typeof withdrawFinishedRunQuestionsStep>;
  readonly withdrawRunQuestion: StepOf<typeof withdrawWorkflowToolRunQuestionStep>;
  readonly resumeHook: {
    readonly input: {
      readonly token: Parameters<typeof resumeHookStep>[0];
      readonly payload: Parameters<typeof resumeHookStep>[1];
      readonly options?: Parameters<typeof resumeHookStep>[2];
    };
    readonly result: Awaited<ReturnType<typeof resumeHookStep>>;
  };
}

export type SessionStepName = keyof SessionStepTypes;
export type SessionStepInput<N extends SessionStepName> = SessionStepTypes[N]["input"];
export type SessionStepResult<N extends SessionStepName> = SessionStepTypes[N]["result"];

export interface StepRun {
  readonly key?: string;
  readonly signals?: StepSignals;
  readonly stream?: WritableStream<Uint8Array>;
}

export type SessionStepTable = {
  readonly [N in SessionStepName]: (
    input: SessionStepInput<N>,
    run?: StepRun,
  ) => Promise<SessionStepResult<N>>;
};

export type SessionStepCall = <N extends SessionStepName>(
  name: N,
  input: SessionStepInput<N>,
  key: string,
  run?: StepRun,
) => Promise<SessionStepResult<N>>;

export interface SessionStepRunner {
  readonly host: { readonly step: SessionStepCall };
  readonly stepKey: (name: SessionStepName) => string;
}

export function dispatchSessionSteps(table: SessionStepTable): SessionStepCall {
  return (name, input, _key, run) => {
    const step = table[name];
    return run === undefined ? step(input) : step(input, run);
  };
}

export function sessionStepKeys(sessionId: string): (name: SessionStepName) => string {
  let next = 0;
  return (name) => `${sessionId}:${next++}:${name}`;
}
