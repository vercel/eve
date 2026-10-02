import type { LanguageModel, ModelMessage } from "ai";

import { HistoryStateKey } from "#context/keys.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { emitStepStarted } from "#harness/emission.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import {
  type ApprovedWork,
  dispatchApprovedWorkflows,
  enforceBudget,
  humanInputContext,
} from "#harness/human-input/index.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { failBoundaryEvent, failModelSelection, type Step } from "#harness/step/context.js";
import type { TurnInput } from "#harness/step/intake.js";
import {
  buildPrompt,
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
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
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
  /** The model's output started streaming, so steering can no longer interrupt the turn. */
  readonly outputStarted: boolean;
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly result: HarnessStepResult;
}

/**
 * One model step of the open turn: the prompt it reads, the model that serves it, and the call
 * with its retries and recoveries. `onResponse` decides what the session does with the response.
 */
export async function runModelStep(
  step: Step,
  input: {
    readonly onResponse: (response: ModelResponse) => Promise<StepResult>;
    readonly turn: TurnInput;
    /** The transcript the step resumes, after the turn's preamble. */
    readonly pending: readonly HarnessModelMessage[];
    readonly approved: ApprovedWork;
    readonly generation: GenerationSteering;
    /** A child's caller and a schedule hear only the turn's real end. */
    readonly hidesHeldText: boolean;
    /** The attempt the step's events belong to, for instrumentation. */
    readonly setAttemptScope: (scope: InstrumentationAttempt | undefined) => void;
  },
): Promise<StepResult> {
  const { generation } = input;
  const prompt = await buildPrompt(step, input.turn, input.pending);
  const model = await selectModel(step, prompt);
  if (!("model" in model)) return model.failed;

  const start = async (messages: readonly ModelMessage[]) => {
    if (step.emit === undefined) return;
    const modelId = requireSessionModelReference(step.session).id;
    await emitStepStarted(step.emit, step.position(), modelId, messages);
  };
  const projectedMessages = projectPrompt(step, prompt);
  try {
    await start(projectedMessages);
  } catch (error) {
    return failBoundaryEvent(step, error);
  }
  const { approvedTools, pendingApprovalsNote } = humanInputContext(step, input.approved);
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
  const dispatched = dispatchApprovedWorkflows(step, input.approved, prompt.messages);
  if (dispatched !== undefined) return dispatched;
  // Over budget, no model call happens.
  const overBudget = await enforceBudget(step, projectedMessages);
  if (overBudget !== undefined) return overBudget;

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
      outputStarted: generation.outputStarted,
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
      const { sequence, stepIndex } = step.position();
      await config.dispatchDynamicModelEvent({
        ctx,
        event: {
          data: { sequence, stepIndex, turnId: activeTurnId(step.position()) },
          type: "step.started",
        } as UnstampedMessageStreamEvent,
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
