import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import { buildStepCatalog, type StepCatalog } from "#execution/catalog/step-catalog.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { sessionDefinitions } from "./agent.js";
import { draftOf } from "./combine.js";
import {
  type CallInput,
  type CallRecord,
  type Draft,
  renderSystem,
  type StepInfo,
} from "./definition.js";
import { contributionsOf } from "./kernel.js";
import { placeAnchored } from "./messages.js";
import { chooseModel, type ModelChoice } from "./model.js";

// Where a step asks its agent's definitions, and renders what it needs from what they make.

/** What a step's definitions read: a `Step`, or the parts of one a test builds. */
export interface StepSource {
  readonly config: { readonly tools: HarnessToolMap };
  readonly ctx: ContextReader;
  readonly finalReplyOnly: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
  readonly view?: () => SessionView;
}

function stepInfo(step: StepSource): StepInfo {
  return {
    agentTools: step.config.tools,
    finalReplyOnly: step.finalReplyOnly,
    session: step.session,
    ...(step.view !== undefined && { view: () => step.view!() }),
  };
}

/** The step's model call as its definitions make it. */
export async function stepDraft(step: StepSource, call?: CallInput): Promise<Draft> {
  const definitions = await sessionDefinitions(step.ctx);
  return draftOf(contributionsOf(definitions, step.ctx, { call, step: stepInfo(step) }), call);
}

/** What a model call's values evaluate with: the conversation it reads. */
export interface ValueRun {
  readonly abortSignal?: AbortSignal;
  readonly conversation: readonly ModelMessage[];
}

/**
 * Before a model call: evaluates what the step's definitions keep, as the call reads it, each
 * once, with the conversation the call reads. The model first: every other value may read it. A
 * part of the call a later definition replaces evaluates nothing under it.
 */
export async function evaluateStepValues(step: StepSource, run: ValueRun): Promise<void> {
  const container = step.ctx as ContextContainer;
  const definitions = await sessionDefinitions(container);
  const contributions = contributionsOf(
    definitions,
    container,
    { history: run.conversation, signal: run.abortSignal, step: stepInfo(step) },
    "evaluate",
  );
  await chooseModel(contributions, container);
  const draft = draftOf(contributions);
  await draft.tools();
  await draft.system();
  await draft.context();
}

/** The model the step's call runs, as its definitions last chose it. */
export async function stepModel(step: StepSource): Promise<ModelChoice | undefined> {
  const container = step.ctx as ContextContainer;
  const definitions = await sessionDefinitions(container);
  return await chooseModel(
    contributionsOf(definitions, container, { step: stepInfo(step) }),
    container,
  );
}

/** Evaluates a session's dynamic values as its next model call would, outside a step. */
export async function evaluateValues(ctx: ContextContainer, run: ValueRun): Promise<void> {
  await evaluateStepValues(
    {
      config: { tools: new Map() },
      ctx,
      finalReplyOnly: false,
      session: { rootSessionId: ctx.get(SessionIdKey) ?? "" },
    },
    run,
  );
}

/** The step's catalog: what its definitions offer, as the model's tools and what each call runs. */
export async function stepCatalog(
  step: StepSource,
  input: { readonly endsTurn: boolean; readonly draft?: Draft },
): Promise<StepCatalog> {
  const draft = input.draft ?? (await stepDraft(step));
  return buildStepCatalog({
    ctx: step.ctx,
    endsTurn: input.endsTurn,
    session: step.session,
    table: await draft.tools(),
  });
}

/** The step's system prompt: a string, or parts. */
export async function stepSystem(
  step: StepSource,
  draft?: Draft,
): Promise<string | readonly string[]> {
  return renderSystem(await (draft ?? (await stepDraft(step))).system());
}

/**
 * The call's messages: the record the step commits, and what the model reads, which is the record
 * as `project` shows it with each context entry ahead of its turn's input.
 */
export async function stepMessages(
  draft: Draft,
  input: {
    readonly call: CallInput;
    readonly project: (record: readonly HarnessModelMessage[]) => HarnessModelMessage[];
  },
): Promise<CallRecord & { readonly view: readonly HarnessModelMessage[] }> {
  const record = (await draft.record()) ?? {
    historyState: input.call.historyState,
    record: input.call.record,
  };
  return {
    ...record,
    view: placeAnchored(input.project(record.record), await draft.context()),
  };
}
