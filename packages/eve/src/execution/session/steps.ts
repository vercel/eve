import type {
  CoordinationDispatchInput,
  CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import type { publishDispatchedCallsStep } from "#execution/coordination-dispatch-step.js";
import type { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import type { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import type { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import type { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import type {
  ApplyRunMessagesInput,
  ApplyRunMessagesResult,
} from "#execution/tools/workflow/apply-run-messages.js";
import type { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
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
}

export type SessionStepName = keyof SessionStepTypes;
export type SessionStepInput<N extends SessionStepName> = SessionStepTypes[N]["input"];
export type SessionStepResult<N extends SessionStepName> = SessionStepTypes[N]["result"];

export type SessionStepTable = {
  readonly [N in SessionStepName]: (input: SessionStepInput<N>) => Promise<SessionStepResult<N>>;
};

export type SessionStepCall = <N extends SessionStepName>(
  name: N,
  input: SessionStepInput<N>,
  key: string,
) => Promise<SessionStepResult<N>>;

export function dispatchSessionSteps(table: SessionStepTable): SessionStepCall {
  return (name, input) => {
    const step = table[name];
    return step(input);
  };
}

export function sessionStepKeys(sessionId: string): (name: SessionStepName) => string {
  let next = 0;
  return (name) => `${sessionId}:${next++}:${name}`;
}
