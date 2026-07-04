import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { SubagentMaxCallsPerStepKey } from "#context/keys.js";
import {
  getSubagentDelegationName,
  isSubagentDelegationAction,
  type DelegatedRuntimeActionRequest,
} from "#harness/subagent-depth.js";
import type {
  RuntimeActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";

export const DEFAULT_SUBAGENT_MAX_CALLS_PER_STEP = 4;

const SUBAGENT_STEP_CALLS_STATE_KEY = "eve.runtime.subagentStepCalls";

interface SubagentStepCallState {
  readonly acceptedCalls: number;
  readonly requestedCalls: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

interface SubagentFanoutRejection {
  readonly action: DelegatedRuntimeActionRequest;
  readonly message: string;
}

export interface ApplySubagentFanoutLimitResult {
  readonly actions: readonly RuntimeActionRequest[];
  readonly rejectedResults: readonly RuntimeSubagentResultActionResult[];
  readonly session: HarnessSession;
}

export function resolveSubagentMaxCallsPerStep(
  session: Pick<HarnessSession, "subagentMaxCallsPerStep">,
): number {
  return (
    parsePositiveInteger(session.subagentMaxCallsPerStep) ?? DEFAULT_SUBAGENT_MAX_CALLS_PER_STEP
  );
}

export function readSerializedSubagentMaxCallsPerStep(
  serializedContext: Readonly<Record<string, unknown>>,
): number | undefined {
  return parsePositiveInteger(serializedContext[SubagentMaxCallsPerStepKey.name]);
}

export function applySubagentFanoutLimit(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly session: HarnessSession;
  readonly step?: {
    readonly stepIndex: number;
    readonly turnId: string;
  };
}): ApplySubagentFanoutLimitResult {
  const maxCallsPerStep = resolveSubagentMaxCallsPerStep(input.session);
  const requestedDelegationCalls = input.actions.filter(isSubagentDelegationAction).length;
  const priorStepCalls = resolveStepCallState({
    session: input.session,
    step: input.step,
  });
  const actions: RuntimeActionRequest[] = [];
  const rejections: SubagentFanoutRejection[] = [];
  let acceptedDelegationCalls = priorStepCalls?.acceptedCalls ?? 0;
  const totalRequestedDelegationCalls =
    (priorStepCalls?.requestedCalls ?? 0) + requestedDelegationCalls;

  for (const action of input.actions) {
    if (!isSubagentDelegationAction(action)) {
      actions.push(action);
      continue;
    }

    if (acceptedDelegationCalls >= maxCallsPerStep) {
      rejections.push({
        action,
        message: `This step requested ${totalRequestedDelegationCalls} subagent calls, but eve allows ${maxCallsPerStep}. The first ${maxCallsPerStep} were started. Retry the remaining work in a later step with at most ${maxCallsPerStep} subagent calls.`,
      });
      continue;
    }

    acceptedDelegationCalls++;
    actions.push(action);
  }

  return {
    actions,
    rejectedResults: rejections.map(createSubagentFanoutLimitResult),
    session: setStepCallState({
      acceptedCalls: acceptedDelegationCalls,
      requestedCalls: totalRequestedDelegationCalls,
      session: input.session,
      step: input.step,
    }),
  };
}

function createSubagentFanoutLimitResult(
  rejection: SubagentFanoutRejection,
): RuntimeSubagentResultActionResult {
  return {
    callId: rejection.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED",
      message: rejection.message,
    },
    subagentName: getSubagentDelegationName(rejection.action),
  };
}

function resolveStepCallState(input: {
  readonly session: HarnessSession;
  readonly step: { readonly stepIndex: number; readonly turnId: string } | undefined;
}): SubagentStepCallState | undefined {
  if (input.step === undefined) return undefined;
  const value = input.session.state?.[SUBAGENT_STEP_CALLS_STATE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const stepCalls = value as SubagentStepCallState;
  if (stepCalls.turnId !== input.step.turnId || stepCalls.stepIndex !== input.step.stepIndex) {
    return undefined;
  }
  if (
    !Number.isInteger(stepCalls.acceptedCalls) ||
    stepCalls.acceptedCalls < 0 ||
    !Number.isInteger(stepCalls.requestedCalls) ||
    stepCalls.requestedCalls < 0
  ) {
    return undefined;
  }
  return stepCalls;
}

function setStepCallState(input: {
  readonly acceptedCalls: number;
  readonly requestedCalls: number;
  readonly session: HarnessSession;
  readonly step: { readonly stepIndex: number; readonly turnId: string } | undefined;
}): HarnessSession {
  if (input.step === undefined || input.requestedCalls === 0) return input.session;

  const state: SessionStateMap = {
    ...input.session.state,
    [SUBAGENT_STEP_CALLS_STATE_KEY]: {
      acceptedCalls: input.acceptedCalls,
      requestedCalls: input.requestedCalls,
      stepIndex: input.step.stepIndex,
      turnId: input.step.turnId,
    } satisfies SubagentStepCallState,
  };
  return { ...input.session, state };
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
