import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import { buildStepCatalog, type StepCatalog } from "#execution/catalog/step-catalog.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { sessionDefinitions } from "./agent.js";
import { decideModel, draftOf } from "./combine.js";
import {
  type CallInput,
  type CallRecord,
  type Draft,
  renderSystem,
  type StepInfo,
} from "./definition.js";
import { contributionsOf } from "./kernel.js";
import { announce, placeAnchored } from "./messages.js";
import { chooseModel, type ModelChoice } from "./model.js";

export interface StepSource {
  readonly config: { readonly tools: HarnessToolMap };
  readonly ctx: ContextReader;
  readonly finalReplyOnly: boolean;
  readonly endsTurn?: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
  readonly view?: () => SessionView;
}

function stepInfo(step: StepSource): StepInfo {
  return {
    agentTools: step.config.tools,
    endsTurn: step.endsTurn ?? false,
    finalReplyOnly: step.finalReplyOnly,
    session: step.session,
    ...(step.view !== undefined && { view: () => step.view!() }),
  };
}

export async function stepDraft(step: StepSource, call?: CallInput): Promise<Draft> {
  const definitions = await sessionDefinitions(step.ctx);
  return draftOf(contributionsOf(definitions, step.ctx, { call, step: stepInfo(step) }));
}

export interface ValueRun {
  readonly abortSignal?: AbortSignal;
  readonly conversation: readonly ModelMessage[];
}

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
  await draft.announcements();
}

export async function stepModel(step: StepSource): Promise<ModelChoice | undefined> {
  const container = step.ctx as ContextContainer;
  const definitions = await sessionDefinitions(container);
  return await chooseModel(
    contributionsOf(definitions, container, { step: stepInfo(step) }),
    container,
  );
}

export async function compactionModel(
  ctx: ContextContainer,
  run: ValueRun,
): Promise<ModelChoice | undefined> {
  const contributions = contributionsOf(
    await sessionDefinitions(ctx),
    ctx,
    { history: run.conversation, signal: run.abortSignal },
    "evaluate",
  );
  return await decideModel(contributions, "compactionModel");
}

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

export async function stepCatalog(step: StepSource): Promise<StepCatalog> {
  const draft = await stepDraft(step);
  return buildStepCatalog({
    ctx: step.ctx,
    endsTurn: step.endsTurn ?? false,
    session: step.session,
    table: await draft.tools(),
  });
}

export async function stepSystem(
  step: StepSource,
  draft?: Draft,
): Promise<string | readonly string[]> {
  return renderSystem(await (draft ?? (await stepDraft(step))).system());
}

export async function stepMessages(
  draft: Draft,
  input: {
    readonly call: CallInput;
    readonly project: (record: readonly HarnessModelMessage[]) => HarnessModelMessage[];
  },
): Promise<CallRecord & { readonly view: readonly HarnessModelMessage[] }> {
  const drafted = { historyState: input.call.historyState, record: input.call.record };
  const announcements = { ...(await draft.announcements()) };
  for (const { announcements: own } of (await draft.tools()).entries.values()) {
    for (const [key, announcement] of Object.entries(own ?? {}))
      announcements[key] ??= announcement;
  }
  const record = announce(drafted, input.call.currentInput, announcements);
  return {
    ...record,
    view: placeAnchored(input.project(record.record), await draft.context()),
  };
}
