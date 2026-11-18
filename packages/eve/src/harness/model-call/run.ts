import { handleStepResult } from "#harness/step/after-model.js";

import { HistoryStateKey } from "#context/keys.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { stepCatalog } from "#definitions/step.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { enforceBudget, humanInputContext } from "#harness/hitl/index.js";
import { failModelCredential, pauseForModelSignIn } from "./credential-failure.js";
import { isScopedAuthorizationRequiredError } from "#runtime/connections/scoped-authorization.js";
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
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import type { StepResult } from "#harness/types.js";
import { stepReference } from "#harness/step/context.js";
import { ModelCaller } from "./call.js";
import { isModelDefinition } from "#models/definition.js";
import { type CredentialedModel, credentialedModel } from "./credential.js";
import { credentialErrorIn, ModelCredentialFailure } from "./errors.js";
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

  const resolved = await resolveModel(step);
  if ("failed" in resolved) return resolved.failed;
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
    renewCredential: resolved.renew,
    newRun: async () => {
      const next = await requestRun(step, prompt);
      if (next !== undefined) throw new Error("eve couldn't request the replacement model run.");
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
    const credentialError = credentialErrorIn(error);
    if (credentialError !== undefined) {
      if (generation.interrupted) return caller.steered();
      if (credentialError instanceof ModelCredentialFailure)
        return await failOrAsk(step, credentialError);
      return await pauseForModelSignIn(step, credentialError, async () => {
        const messages = await caller.abandon();
        step.session = changeHistory(step.session, { extend: messages });
      });
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

async function resolveModel(
  step: Step,
): Promise<CredentialedModel | { readonly failed: StepResult }> {
  let resolved: Awaited<ReturnType<typeof resolveEffectiveRuntimeModel>>;
  try {
    resolved = await resolveEffectiveRuntimeModel(step);
  } catch (error) {
    return { failed: await failModelSelection(step, error) };
  }
  step.model = resolved.choice;
  if (!isModelDefinition(resolved.model)) return { model: resolved.model };
  try {
    return await credentialedModel(resolved.model);
  } catch (error) {
    const credentialError = credentialErrorIn(error);
    if (credentialError === undefined) throw error;
    return { failed: await failOrAsk(step, credentialError) };
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

async function failOrAsk(
  step: Step,
  error: NonNullable<ReturnType<typeof credentialErrorIn>>,
): Promise<StepResult> {
  if (isScopedAuthorizationRequiredError(error)) return await pauseForModelSignIn(step, error);
  return await failModelCredential(step, error.code, error.cause, error.scoped);
}
