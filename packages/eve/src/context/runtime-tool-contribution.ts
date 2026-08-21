import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  RuntimeToolContributionsKey,
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  type DurableRuntimeToolContribution,
  type DurableRuntimeToolContributionState,
  type RuntimeToolContributionCoordinate,
} from "#context/keys.js";
import {
  prepareDynamicToolMetadata,
  registerPreparedDynamicToolMetadata,
} from "#context/dynamic-tool-lifecycle.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  isBrandedToolEntry,
  type DynamicToolEventName,
  type DynamicToolSet,
} from "#shared/dynamic-tool-definition.js";
import { hasUnregisteredDurableDynamicCallbacks } from "#shared/durable-dynamic-tool-callbacks.js";
import { toErrorMessage } from "#shared/errors.js";
import { TOOL_SLUG_PATTERN } from "#discover/grammar.js";

const log = createLogger("runtime-tool-contributions");

export type RuntimeToolContributionMap = DynamicToolSet;

export interface RuntimeToolContributorResolveInput {
  readonly coordinate: RuntimeToolContributionCoordinate;
  readonly ctx: AlsContext;
  readonly messages: readonly ModelMessage[];
  readonly previous?: DurableRuntimeToolContribution;
}

export interface RuntimeToolContributor {
  readonly eventNames: readonly DynamicToolEventName[];
  readonly ownerId: string;
  readonly qualificationPrefix?: string;
  resolve(
    input: RuntimeToolContributorResolveInput,
  ):
    | RuntimeToolContributionMap
    | null
    | undefined
    | Promise<RuntimeToolContributionMap | null | undefined>;
  readonly sourceId: string;
}

export interface RuntimeToolContributionInput {
  readonly coordinate: RuntimeToolContributionCoordinate;
  readonly ctx: AlsContext;
  readonly ownerId: string;
  readonly qualificationPrefix?: string;
  readonly runtimeRevision: string;
  readonly sourceId: string;
  readonly tools: RuntimeToolContributionMap | null | undefined;
}

class RuntimeToolContributionCollisionError extends Error {}

function readState(ctx: ContextReader): DurableRuntimeToolContributionState {
  const state = ctx.get(RuntimeToolContributionsKey);
  if (state === undefined) return { contributions: [], version: 1 };
  if (
    typeof state !== "object" ||
    state === null ||
    state.version !== 1 ||
    !Array.isArray(state.contributions)
  ) {
    throw new Error("Runtime tool contribution state has an unsupported or malformed version.");
  }
  return state;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Runtime tool contribution ${label} must be a non-empty string.`);
  }
}

function validateCoordinate(coordinate: RuntimeToolContributionCoordinate): void {
  switch (coordinate.event) {
    case "session.started":
      return;
    case "turn.started":
      requireNonEmpty(coordinate.turnId, "turnId");
      return;
    case "step.started":
      requireNonEmpty(coordinate.turnId, "turnId");
      if (!Number.isSafeInteger(coordinate.stepIndex) || coordinate.stepIndex < 0) {
        throw new Error("Runtime tool contribution stepIndex must be a non-negative safe integer.");
      }
  }
}

function isSameScope(
  contribution: DurableRuntimeToolContribution,
  coordinate: RuntimeToolContributionCoordinate,
): boolean {
  return contribution.coordinate.event === coordinate.event;
}

function metadataForEvent(ctx: ContextReader, event: DynamicToolEventName) {
  switch (event) {
    case "session.started":
      return ctx.get(SessionDynamicToolMetadataKey) ?? [];
    case "turn.started":
      return ctx.get(TurnDynamicToolMetadataKey) ?? [];
    case "step.started":
      return ctx.get(StepDynamicToolMetadataKey) ?? [];
  }
}

function qualifyToolName(prefix: string | undefined, entryKey: string): string {
  if (entryKey.length === 0) {
    throw new Error("Runtime tool contribution keys must be non-empty strings.");
  }
  if (prefix !== undefined) {
    requireNonEmpty(prefix, "qualificationPrefix");
    if (entryKey.startsWith(`${prefix}__`)) {
      throw new Error(
        `Runtime tool contribution key "${entryKey}" is already qualified with "${prefix}". Pass bare map keys so eve qualifies names exactly once.`,
      );
    }
  }
  const name = prefix === undefined ? entryKey : `${prefix}__${entryKey}`;
  if (!TOOL_SLUG_PATTERN.test(name)) {
    throw new Error(
      `Runtime tool contribution produced invalid tool name "${name}". Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.`,
    );
  }
  return name;
}

function readToolEntries(
  ownerId: string,
  tools: RuntimeToolContributionInput["tools"],
): readonly [string, DynamicToolSet[string]][] {
  if (tools === null || tools === undefined) return [];
  if (isBrandedToolEntry(tools)) {
    throw new Error(
      `Runtime tool contributor "${ownerId}" returned one defineTool() value. Return a keyed map of defineTool() values instead.`,
    );
  }
  if (typeof tools !== "object" || Array.isArray(tools)) {
    throw new Error(
      `Runtime tool contributor "${ownerId}" must return a keyed map of defineTool() values or null.`,
    );
  }

  return Object.entries(tools).map(([entryKey, entry]) => {
    if (!isBrandedToolEntry(entry)) {
      throw new Error(
        `Runtime tool contributor "${ownerId}" returned "${entryKey}" without defineTool(). Wrap every runtime tool entry in defineTool().`,
      );
    }
    return [entryKey, entry as DynamicToolSet[string]] as const;
  });
}

function collisionOwner(
  name: string,
  input: RuntimeToolContributionInput,
  state: DurableRuntimeToolContributionState,
): string | undefined {
  const authored = metadataForEvent(input.ctx, input.coordinate.event).find(
    (entry) => entry.name === name,
  );
  if (authored !== undefined) return `dynamic resolver "${authored.resolverSlug}"`;

  for (const contribution of state.contributions) {
    if (contribution.ownerId === input.ownerId || !isSameScope(contribution, input.coordinate)) {
      continue;
    }
    if (contribution.metadata.some((entry) => entry.name === name)) {
      return `runtime contributor "${contribution.ownerId}"`;
    }
  }
  return undefined;
}

/**
 * Atomically validates, qualifies, captures, and replaces one owner-scoped
 * set of runtime-contributed tools.
 */
export function contributeRuntimeTools(input: RuntimeToolContributionInput): void {
  requireNonEmpty(input.ownerId, "ownerId");
  requireNonEmpty(input.runtimeRevision, "runtimeRevision");
  requireNonEmpty(input.sourceId, "sourceId");
  validateCoordinate(input.coordinate);

  const state = readState(input.ctx);
  const entries = readToolEntries(input.ownerId, input.tools);
  const withoutOwner = state.contributions.filter(
    (contribution) =>
      contribution.ownerId !== input.ownerId || !isSameScope(contribution, input.coordinate),
  );
  if (entries.length === 0) {
    input.ctx.set(RuntimeToolContributionsKey, {
      contributions: withoutOwner,
      version: 1,
    });
    return;
  }

  const prepared = entries.map(([entryKey, entry]) => {
    const name = qualifyToolName(input.qualificationPrefix, entryKey);
    const owner = collisionOwner(name, input, state);
    if (owner !== undefined) {
      throw new RuntimeToolContributionCollisionError(
        `Runtime tool "${name}" from contributor "${input.ownerId}" collides with ${owner}.`,
      );
    }
    return prepareDynamicToolMetadata({
      entry,
      entryKey,
      name,
      resolverSlug: `runtime:${input.ownerId}`,
    });
  });

  const duplicateNames = new Set<string>();
  for (const entry of prepared) {
    if (duplicateNames.has(entry.metadata.name)) {
      throw new RuntimeToolContributionCollisionError(
        `Runtime tool contributor "${input.ownerId}" produced duplicate tool name "${entry.metadata.name}".`,
      );
    }
    duplicateNames.add(entry.metadata.name);
  }

  registerPreparedDynamicToolMetadata(prepared);
  input.ctx.set(RuntimeToolContributionsKey, {
    contributions: [
      ...withoutOwner,
      {
        coordinate: input.coordinate,
        metadata: prepared.map((entry) => entry.metadata),
        ownerId: input.ownerId,
        qualificationPrefix: input.qualificationPrefix,
        runtimeRevision: input.runtimeRevision,
        sourceId: input.sourceId,
      },
    ],
    version: 1,
  });
}

/** Clears expired lifecycle scopes before contributors publish the next set. */
export function prepareRuntimeToolContributionsForEvent(
  ctx: AlsContext,
  coordinate: RuntimeToolContributionCoordinate,
): void {
  validateCoordinate(coordinate);
  const state = readState(ctx);
  const expired =
    coordinate.event === "session.started"
      ? new Set<DynamicToolEventName>(["session.started", "turn.started", "step.started"])
      : coordinate.event === "turn.started"
        ? new Set<DynamicToolEventName>(["turn.started", "step.started"])
        : new Set<DynamicToolEventName>(["step.started"]);
  ctx.set(RuntimeToolContributionsKey, {
    contributions: state.contributions.filter(
      (contribution) => !expired.has(contribution.coordinate.event),
    ),
    version: 1,
  });
}

export function runtimeToolContributionCoordinate(
  event: UnstampedMessageStreamEvent,
): RuntimeToolContributionCoordinate | undefined {
  switch (event.type) {
    case "session.started":
      return { event: "session.started" };
    case "turn.started":
      return { event: "turn.started", turnId: event.data.turnId };
    case "step.started":
      return {
        event: "step.started",
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      };
    default:
      return undefined;
  }
}

/** Resolves and publishes all runtime contributors subscribed to one event. */
export async function dispatchRuntimeToolContributors(input: {
  readonly contributors: readonly RuntimeToolContributor[];
  readonly ctx: AlsContext;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly runtimeRevision: string;
}): Promise<void> {
  const coordinate = runtimeToolContributionCoordinate(input.event);
  if (coordinate === undefined) return;
  prepareRuntimeToolContributionsForEvent(input.ctx, coordinate);

  const matching = input.contributors.filter((contributor) =>
    contributor.eventNames.includes(coordinate.event),
  );
  const outcomes = await Promise.allSettled(
    matching.map(async (contributor) => ({
      contributor,
      tools: await contributor.resolve({
        coordinate,
        ctx: input.ctx,
        messages: input.messages,
      }),
    })),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Runtime tool contributor (${coordinate.event}) failed — skipping its result.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    try {
      contributeRuntimeTools({
        coordinate,
        ctx: input.ctx,
        ownerId: outcome.value.contributor.ownerId,
        qualificationPrefix: outcome.value.contributor.qualificationPrefix,
        runtimeRevision: input.runtimeRevision,
        sourceId: outcome.value.contributor.sourceId,
        tools: outcome.value.tools,
      });
    } catch (error) {
      if (error instanceof RuntimeToolContributionCollisionError) throw error;
      log.error(`Runtime tool contributor (${coordinate.event}) failed — skipping its result.`, {
        error: toErrorMessage(error),
        ownerId: outcome.value.contributor.ownerId,
      });
    }
  }
}

/**
 * Re-resolves persisted contributors after a cold start or runtime revision
 * change so name-keyed callback bindings point at the current code.
 */
export async function refreshRuntimeToolContributionsForRuntimeRevision(input: {
  readonly contributors: readonly RuntimeToolContributor[];
  readonly ctx: AlsContext;
  readonly runtimeRevision: string;
}): Promise<void> {
  const snapshot = [...readState(input.ctx).contributions];
  for (const contribution of snapshot) {
    const needsRefresh =
      contribution.runtimeRevision !== input.runtimeRevision ||
      hasUnregisteredDurableDynamicCallbacks(contribution.metadata);
    if (!needsRefresh) continue;

    const contributor = input.contributors.find(
      (candidate) =>
        candidate.ownerId === contribution.ownerId && candidate.sourceId === contribution.sourceId,
    );
    if (contributor === undefined) {
      if (contribution.runtimeRevision !== input.runtimeRevision) {
        contributeRuntimeTools({
          coordinate: contribution.coordinate,
          ctx: input.ctx,
          ownerId: contribution.ownerId,
          qualificationPrefix: contribution.qualificationPrefix,
          runtimeRevision: input.runtimeRevision,
          sourceId: contribution.sourceId,
          tools: null,
        });
        continue;
      }
      throw new Error(
        `Runtime tool contributor "${contribution.ownerId}" cannot rebind because source "${contribution.sourceId}" is not registered in this process.`,
      );
    }

    const tools = await contributor.resolve({
      coordinate: contribution.coordinate,
      ctx: input.ctx,
      messages: [],
      previous: contribution,
    });
    contributeRuntimeTools({
      coordinate: contribution.coordinate,
      ctx: input.ctx,
      ownerId: contribution.ownerId,
      qualificationPrefix: contribution.qualificationPrefix,
      runtimeRevision: input.runtimeRevision,
      sourceId: contribution.sourceId,
      tools,
    });
  }
}
