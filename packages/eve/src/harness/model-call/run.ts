import type { LanguageModel } from "ai";
import { handleStepResult } from "#harness/step/after-model.js";

import { HistoryStateKey } from "#context/keys.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { stepCatalog } from "#definitions/step.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import {
  enforceBudget,
  humanInputContext,
  pauseForSignIn,
  settleModelSignIns,
} from "#harness/hitl/index.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { isModelDefinition, modelSignInName } from "#models/definition.js";
import { changeHistory } from "#harness/session-machine/history.js";
import {
  requestRun as requestRunFact,
  startRun as startRunFact,
} from "#harness/session-machine/runs.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import { nextRunId } from "#protocol/session-projection.js";
import {
  failBoundaryEvent,
  failModelSelection,
  isSignInError,
  prepareModelCall,
  type Step,
} from "#harness/step/context.js";
import type { TurnInput } from "#harness/step/intake.js";
import {
  commitTurnInput,
  previewPrompt,
  projectPrompt,
  type Prompt,
  withClientContext,
} from "#harness/step/prompt.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import type { StepResult } from "#harness/types.js";
import { stepReference } from "#harness/step/context.js";
import { ModelCaller } from "./call.js";
import { credentialedModel } from "./credential.js";
import { type EndsTurnTools, endsTurnTools, frameworkToolNames } from "./tools.js";
import { reportModelCallFailure } from "./failure.js";
import { resolveEffectiveRuntimeModel } from "./model.js";
import { recordModelUsage } from "./usage.js";

export interface ModelResponse {
  readonly catalog: StepCatalog;
  readonly durableModelPromptMessageCount?: number;
  readonly endsTurnTools: EndsTurnTools;
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly result: HarnessStepResult;
}

export async function runModelStep(
  step: Step,
  input: {
    readonly turn: TurnInput;
    readonly generation: GenerationSteering;
  },
): Promise<StepResult> {
  const { generation } = input;
  const prepared = await previewPrompt(step, input.turn);
  const failed = await prepareModelCall(step, prepared);
  if (failed !== undefined) return failed;
  const prompt = commitTurnInput(step, prepared);
  const overBudget = await enforceBudget(step, prompt.messages);
  if (overBudget !== undefined) return overBudget;

  const resolved = await resolveModel(step, prompt);
  if ("failed" in resolved) return resolved.failed;
  if ("signIn" in resolved) return await pauseForSignIn(step, resolved.signIn);
  await settleModelSignIns(step);
  const requested = await requestRun(step, prompt);
  if (requested !== undefined) return requested;
  const projectedMessages = projectPrompt(prompt);
  const catalog = await stepCatalog(step);
  step.frameworkToolNames = frameworkToolNames(catalog);
  const { approvalMemory } = humanInputContext(step);
  const caller = new ModelCaller(step, prompt, {
    approvalMemory,
    catalog,
    generation,
    model: resolved.model,
    newRun: async () => {
      const next = await requestRun(step, prompt);
      if (next !== undefined) throw new Error("The model run's replacement found no model.");
    },
    startRun: async (attempt) => await startRun(step, attempt),
    projectedMessages,
    turnMessages: input.turn.messages,
  });

  let result: HarnessStepResult;
  try {
    result = await caller.call();
  } catch (error) {
    throwIfSessionStreamDead(error);
    throwIfTurnAborted(step.config.abortSignal);
    const signInError = signInErrorIn(error);
    if (signInError !== undefined) {
      if (generation.interrupted) return caller.steered();
      const messages = await caller.abandonForSignIn();
      step.session = changeHistory(step.session, { extend: messages });
      return await pauseForSignIn(step, signInError);
    }
    const compactionFailed = await caller.failIfCompactionFailed();
    if (compactionFailed !== undefined) return compactionFailed;
    if (generation.interrupted) return caller.steered();
    return reportModelCallFailure(step, error, caller.takeUnkeptUsage());
  }

  await recordModelUsage(step, { model: resolved.model, tools: catalog.advertised.size });

  let stepResult: StepResult;
  try {
    generation.check();
    stepResult = await handleStepResult(step, {
      catalog,
      durableModelPromptMessageCount:
        prompt.clientContext === undefined || prompt.clientContext.messages.length === 0
          ? caller.modelMessages.length
          : undefined,
      endsTurnTools: endsTurnTools(catalog, step.endsTurn),
      promptMessages: caller.request.history,
      requestEnvelopeTokens: caller.requestEnvelopeTokens,
      result,
    });
  } catch (error) {
    throwIfSessionStreamDead(error);
    throwIfTurnAborted(step.config.abortSignal);
    if (generation.interrupted) return caller.steered();
    throw error;
  }
  step.ctx.set(HistoryStateKey, caller.request.historyState);
  return stepResult;
}

type ResolvedModel =
  | { readonly model: LanguageModel }
  | { readonly failed: StepResult }
  | { readonly signIn: unknown; readonly credential: string | undefined };

async function resolveModel(step: Step, prompt: Prompt): Promise<ResolvedModel> {
  const first = await resolveCredentialedModel(step);
  if (
    !("signIn" in first) ||
    !isConnectionAuthorizationFailedError(first.signIn) ||
    !(await settleModelSignIns(step, first.signIn))
  )
    return first;
  const failed = await prepareModelCall(step, prompt);
  if (failed !== undefined) return { failed };
  const again = await resolveCredentialedModel(step);
  return "signIn" in again && again.credential === first.credential ? first : again;
}

async function resolveCredentialedModel(step: Step): Promise<ResolvedModel> {
  let resolved: Awaited<ReturnType<typeof resolveEffectiveRuntimeModel>>;
  try {
    resolved = await resolveEffectiveRuntimeModel(step);
  } catch (error) {
    return { failed: await failModelSelection(step, error) };
  }
  step.model = resolved.choice;
  try {
    return { model: await credentialedModel(resolved.model, resolved.choice.reference) };
  } catch (error) {
    if (isTurnCancellation(error)) throw error;
    if (!isSignInError(error)) return { failed: await reportModelCallFailure(step, error) };
    return {
      credential: isModelDefinition(resolved.model) ? modelSignInName(resolved.model) : undefined,
      signIn: error,
    };
  }
}

async function requestRun(step: Step, prompt: Prompt): Promise<StepResult | undefined> {
  try {
    await step.apply(
      requestRunFact({ turnId: activeTurnId(step.position()) }, nextRunId(step.view().projection)),
      validateHarnessModelMessages(withClientContext(prompt)),
    );
  } catch (error) {
    return await failBoundaryEvent(step, error);
  }
  return undefined;
}

async function startRun(step: Step, attempt: number): Promise<void> {
  const runId = step.position().runId;
  if (runId === undefined) return;
  const modelId = stepReference(step).id;
  await step.apply(startRunFact({ attempt, modelId, runId }));
}

function signInErrorIn(error: unknown): unknown {
  for (let current = error; current instanceof Error; current = current.cause)
    if (isSignInError(current)) return current;
  return undefined;
}
