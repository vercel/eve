import type { LanguageModel } from "ai";
import { handleStepResult } from "#harness/step/after-model.js";

import { HistoryStateKey } from "#context/keys.js";
import {
  buildStepCatalog,
  recordOfferedCatalogTools,
  type StepCatalog,
} from "#execution/catalog/step-catalog.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { enforceBudget, humanInputContext } from "#harness/hitl/index.js";
import { runRequested, runStarted } from "#harness/facts.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import { nextRunId } from "#protocol/session-projection.js";
import {
  failBoundaryEvent,
  failModelSelection,
  prepareModelCall,
  type Step,
} from "#harness/step/context.js";
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
import { ModelCaller } from "./call.js";
import { type EndsTurnTools, endsTurnTools, frameworkToolNames } from "./tools.js";
import { reportModelCallFailure } from "./failure.js";
import { resolveEffectiveRuntimeModel } from "./model.js";
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
 * with its retries and recoveries. The response handler applies what it returned.
 *
 * The budget gate passes first, after the session's dynamic values are evaluated with the
 * conversation the call reads, which fixes its model, tools, and context. Then the turn requests
 * a model run, and the run starts as its provider call begins.
 */
export async function runModelStep(
  step: Step,
  input: {
    readonly turn: TurnInput;
    readonly generation: GenerationSteering;
  },
): Promise<StepResult> {
  const { generation } = input;
  const failed = await prepareModelCall(step, previewPrompt(step, input.turn));
  if (failed !== undefined) return failed;
  const prompt = await buildPrompt(step, input.turn);
  // Over budget, the model doesn't run: the step's messages park with the prompt.
  const overBudget = await enforceBudget(step, prompt.messages);
  if (overBudget !== undefined) return overBudget;

  const run = await requestRun(step, prompt);
  if ("failed" in run) return run.failed;
  const projectedMessages = projectPrompt(prompt);
  // Dynamic tools and subagents were evaluated before the run was requested, so the step's calls
  // resolve once, against this catalog.
  const endsTurn = !step.hasDelegatedCaller && step.session.outputSchema === undefined;
  const catalog = buildStepCatalog({
    agentTools: step.config.tools,
    ctx: step.ctx,
    endsTurn,
    session: step.session,
  });
  recordOfferedCatalogTools(step.ctx, catalog);
  step.frameworkToolNames = frameworkToolNames(catalog);
  const { approvalMemory, pendingApprovalsNote } = humanInputContext(step);
  const caller = new ModelCaller(step, prompt, {
    approvalMemory,
    catalog,
    generation,
    model: run.model,
    newRun: async () => {
      const next = await requestRun(step, prompt);
      if ("failed" in next) throw new Error("The model run's replacement found no model.");
    },
    startRun: async (attempt) => await startRun(step, attempt),
    pendingApprovalsNote,
    projectedMessages,
    turnMessages: input.turn.messages,
  });

  let result: HarnessStepResult;
  try {
    result = await caller.call();
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    const compactionFailed = await caller.failIfCompactionFailed();
    if (compactionFailed !== undefined) return compactionFailed;
    if (generation.interrupted) return caller.steered();
    return reportModelCallFailure(step, error);
  }

  await recordModelUsage(step, { model: run.model });
  caller.clearInterruptedUsage();

  let stepResult: StepResult;
  try {
    generation.check();
    stepResult = await handleStepResult(step, {
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
 * The turn requests a model run, which the dynamic model evaluated for it serves, or the agent's
 * model. No model fails the session.
 */
async function requestRun(
  step: Step,
  prompt: Prompt,
): Promise<{ readonly model: LanguageModel } | { readonly failed: StepResult }> {
  const { config, ctx } = step;
  try {
    await step.apply(
      [runRequested({ turnId: activeTurnId(step.position()) }, nextRunId(step.view().projection))],
      validateHarnessModelMessages(withClientContext(prompt)),
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
async function startRun(step: Step, attempt: number): Promise<void> {
  const runId = step.position().runId;
  if (runId === undefined) return;
  const modelId = requireSessionModelReference(step.session).id;
  await step.apply([runStarted({ attempt, modelId, runId })]);
}
