import type { LanguageModel } from "ai";

import { HistoryStateKey } from "#context/keys.js";
import { buildStepCatalog, type StepCatalog } from "#execution/catalog/step-catalog.js";
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
import { requestModel, startModel } from "#harness/session-machine/transitions.js";
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
import { requireSessionModelReference, type StepResult } from "#harness/types.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { ModelCaller } from "./call.js";
import { type EndsTurnTools, endsTurnTools, frameworkToolNames } from "./tools.js";
import { reportModelCallFailure } from "./failure.js";
import { resolveEffectiveRuntimeModel } from "./model.js";
import { recoverModelCall } from "./recovery.js";
import { recordModelUsage } from "./usage.js";

/** A model step's response, for the session to act on. */
export interface ModelResponse {
  /** The step's catalog, which decides what each of the response's calls runs. */
  readonly catalog: StepCatalog;
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
 * Approved work runs before the run is requested: approved workflow calls join their runs, the
 * budget gate passes, then approved local calls run and the model reads their results. Then the
 * turn requests a model run, after which reactions choose its model and tools, and the run starts
 * as its provider call begins.
 */
export async function runModelStep(
  step: Step,
  input: {
    readonly onResponse: (response: ModelResponse) => Promise<StepResult>;
    readonly turn: TurnInput;
    readonly approved: ApprovedWork;
    readonly generation: GenerationSteering;
    /** The attempt the step's events belong to, for instrumentation. */
    readonly setAttemptScope: (scope: InstrumentationAttempt | undefined) => void;
  },
): Promise<StepResult> {
  const { generation } = input;
  const approves = hasApprovedWork(step);
  let prompt = approves ? previewPrompt(step, input.turn) : await buildPrompt(step, input.turn);
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
  }

  const run = await requestRun(step, prompt);
  if ("failed" in run) return run.failed;
  const projectedMessages = projectPrompt(step, prompt);
  // Dynamic tools and subagents resolved when the run was requested, so the step's calls resolve
  // once, against this catalog.
  const endsTurn = !step.hasDelegatedCaller && step.session.outputSchema === undefined;
  const catalog = buildStepCatalog({
    agentTools: step.config.tools,
    ctx: step.ctx,
    endsTurn,
    session: step.session,
  });
  step.frameworkToolNames = frameworkToolNames(catalog);
  const { approvedTools, pendingApprovalsNote } = humanInputContext(step, catalog);
  const caller = new ModelCaller(step, prompt, {
    approvedTools,
    catalog,
    generation,
    model: run.model,
    newRun: async () => {
      const next = await requestRun(step, prompt);
      if ("failed" in next) throw new Error("The model run's replacement found no model.");
    },
    startRun: async () => await startRun(step),
    pendingApprovalsNote,
    projectedMessages,
    setAttemptScope: input.setAttemptScope,
    turnMessages: input.turn.messages,
  });

  let result: HarnessStepResult;
  try {
    result = await caller.call({});
  } catch (error) {
    caller.throwIfCompactionFailed();
    throwIfTurnAborted(step.config.abortSignal);
    if (generation.interrupted) return caller.steered();
    const recovery = await recoverModelCall({
      call: async (options) => {
        await caller.prepareRetry();
        return await caller.call(options);
      },
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

  await recordModelUsage(step, { model: run.model, result });
  caller.clearInterruptedUsage();

  let stepResult: StepResult;
  try {
    generation.check();
    stepResult = await input.onResponse({
      catalog,
      // Usage measures what the model read only when no client context was spliced in.
      durableModelPromptMessageCount:
        prompt.clientContext === undefined || prompt.clientContext.messages.length === 0
          ? caller.modelMessages.length
          : undefined,
      endsTurnTools: endsTurnTools(catalog, endsTurn),
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
 * The turn requests a model run: reactions choose the model and tools from the prompt, or
 * the agent's model serves. No model fails the session.
 */
async function requestRun(
  step: Step,
  prompt: Prompt,
): Promise<{ readonly model: LanguageModel } | { readonly failed: StepResult }> {
  const { config, ctx } = step;
  try {
    await step.apply(
      requestModel(step.view()),
      validateHarnessModelMessages(step.projectHistory(withClientContext(prompt))),
    );
  } catch (error) {
    return { failed: await failBoundaryEvent(step, error) };
  }
  try {
    const resolved = await resolveEffectiveRuntimeModel({ config, ctx, session: step.session });
    step.session = resolved.session;
    return { model: resolved.model };
  } catch (error) {
    return { failed: await failModelSelection(step, error) };
  }
}

/** The run's model is chosen and its provider call begins. */
async function startRun(step: Step): Promise<void> {
  const runId = step.position().runId;
  if (runId === undefined) return;
  await step.apply(
    startModel(step.view(), { modelId: requireSessionModelReference(step.session).id, runId }),
  );
}
