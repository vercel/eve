import type { LanguageModel, ModelMessage } from "ai";

import { HistoryStateKey } from "#context/keys.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import {
  type ApprovedWork,
  dispatchApprovedWorkflows,
  enforceBudget,
  hasApprovedWork,
  humanInputContext,
  runApprovedLocalCalls,
} from "#harness/hitl/index.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import { startStep } from "#harness/session-machine/transitions.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import { failBoundaryEvent, failModelSelection, type Step } from "#harness/step/context.js";
import type { TurnInput } from "#harness/step/intake.js";
import {
  buildPrompt,
  previewPrompt,
  projectPrompt,
  type Prompt,
  withClientContext,
} from "#harness/step/prompt.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import {
  type HarnessToolMap,
  requireSessionModelReference,
  type StepResult,
} from "#harness/types.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { ModelCaller } from "./call.js";
import type { EndsTurnTools } from "./tools.js";
import { reportModelCallFailure } from "./failure.js";
import { resolveEffectiveRuntimeModel } from "./model.js";
import { recoverModelCall } from "./recovery.js";
import { recordModelUsage } from "./usage.js";

/** A model step's response, for the session to act on. */
export interface ModelResponse {
  readonly coordinationTools: HarnessToolMap;
  /** How many prompt messages the model read, when no client context was spliced in. */
  readonly durableModelPromptMessageCount?: number;
  /** Tools that can end the turn in this step, with their `endsTurn` option. */
  readonly endsTurnTools: EndsTurnTools;
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly result: HarnessStepResult;
}

/**
 * One model step of the open turn: the prompt it reads, the model that serves it, and the call
 * with its retries and recoveries. `onResponse` decides what the session does with the response.
 *
 * Approved work runs where the AI SDK ran it, between the step's start and the model call:
 * approved workflow calls join their runs, the budget gate passes, then approved local calls run
 * and the model reads their results.
 */
export async function runModelStep(
  step: Step,
  input: {
    readonly onResponse: (response: ModelResponse) => Promise<StepResult>;
    readonly turn: TurnInput;
    readonly approved: ApprovedWork;
    readonly generation: GenerationSteering;
    /** A child's caller and a schedule hear only the turn's real end. */
    readonly hidesHeldText: boolean;
    /** The attempt the step's events belong to, for instrumentation. */
    readonly setAttemptScope: (scope: InstrumentationAttempt | undefined) => void;
  },
): Promise<StepResult> {
  const { generation } = input;
  const approves = hasApprovedWork(step);
  let prompt = approves ? previewPrompt(step, input.turn) : await buildPrompt(step, input.turn);
  const model = await selectModel(step, prompt);
  if (!("model" in model)) return model.failed;

  const start = (messages: readonly ModelMessage[]) =>
    step.apply(
      startStep(step.view(), { modelId: requireSessionModelReference(step.session).id }),
      messages,
    );
  let projectedMessages = projectPrompt(step, prompt);
  try {
    await start(projectedMessages);
  } catch (error) {
    return failBoundaryEvent(step, error);
  }
  // The turn waits on the runtime for the runs approved calls joined.
  if (approves && (await dispatchApprovedWorkflows(step, input.approved))) {
    return { next: null, session: step.session };
  }
  // Over budget, neither approved calls nor the model run: the step's messages park with the
  // prompt.
  const overBudget = await enforceBudget(step, prompt.messages);
  if (overBudget !== undefined) return overBudget;
  if (approves) {
    const held = await runApprovedLocalCalls(step, input.approved, input.setAttemptScope);
    if (held !== undefined) return held;
    prompt = await buildPrompt(step, input.turn);
    projectedMessages = projectPrompt(step, prompt);
  }
  const { approvedTools, pendingApprovalsNote } = humanInputContext(step);
  const caller = new ModelCaller(step, prompt, {
    approvedTools,
    generation,
    hidesHeldText: input.hidesHeldText,
    model: model.model,
    pendingApprovalsNote,
    projectedMessages,
    setAttemptScope: input.setAttemptScope,
    startStep: start,
    turnMessages: input.turn.messages,
  });

  let result: HarnessStepResult;
  try {
    result = await caller.call({ suppressStepStartedEmission: true });
  } catch (error) {
    caller.throwIfCompactionFailed();
    throwIfTurnAborted(step.config.abortSignal);
    if (generation.interrupted) return caller.steered();
    const recovery = await recoverModelCall({
      call: (options) => caller.call(options),
      error,
      sessionId: step.session.sessionId,
      turnId: step.position().turnId,
    });
    caller.throwIfCompactionFailed();
    throwIfTurnAborted(step.config.abortSignal);
    if (generation.interrupted) return caller.steered();
    if (!("result" in recovery)) return reportModelCallFailure(step, recovery.error);
    result = recovery.result;
  }

  await recordModelUsage(step, { model: model.model, result });
  caller.clearInterruptedUsage();

  let stepResult: StepResult;
  try {
    generation.check();
    stepResult = await input.onResponse({
      coordinationTools: caller.tools?.coordinationTools ?? step.config.tools,
      // Usage measures what the model read only when no client context was spliced in.
      durableModelPromptMessageCount:
        prompt.clientContext === undefined || prompt.clientContext.messages.length === 0
          ? caller.modelMessages.length
          : undefined,
      endsTurnTools: caller.tools?.endsTurnTools ?? new Map(),
      promptMessages: caller.request.history,
      requestEnvelopeTokens: caller.requestEnvelopeTokens,
      result,
    });
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (generation.interrupted) return caller.steered();
    throw error;
  }
  // The returned session now owns these messages; persist their baseline with it.
  step.ctx?.set(HistoryStateKey, caller.request.historyState);
  return stepResult;
}

/**
 * The model that serves the step: a dynamic model resolver picks it from the prompt, or the
 * agent's model serves. No model fails the session.
 */
async function selectModel(
  step: Step,
  prompt: Prompt,
): Promise<{ readonly model: LanguageModel } | { readonly failed: StepResult }> {
  const { config, ctx } = step;
  try {
    if (ctx !== undefined && config.dispatchDynamicModelEvent !== undefined) {
      const position = step.position();
      await config.dispatchDynamicModelEvent({
        ctx,
        event: stepStartedForResolvers({
          modelId: step.session.agent.modelReference?.id ?? "dynamic",
          sequence: position.sequence,
          stepIndex: position.stepIndex,
          turnId: activeTurnId(position),
        }),
        messages: validateHarnessModelMessages(step.projectHistory(withClientContext(prompt))),
      });
    }
    const resolved = await resolveEffectiveRuntimeModel({ config, ctx, session: step.session });
    step.session = resolved.session;
    return { model: resolved.model };
  } catch (error) {
    return { failed: await failModelSelection(step, error) };
  }
}
