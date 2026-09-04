import type { ModelMessage } from "ai";

import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";

import { replayDynamicTools } from "#context/build-dynamic-tools.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import {
  isCurrentDynamicToolMetadata,
  toCurrentDynamicToolMetadataList,
  type CurrentDynamicToolMetadata,
  type PersistedDynamicToolMetadata,
} from "#context/dynamic-tool-metadata.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import type {
  SessionStartedStreamEvent,
  StepStartedStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { ALLOWED_DYNAMIC_TOOL_EVENTS } from "#dynamic/definition.js";
import { isBrandedToolEntry, type DynamicToolEntry } from "#tools/dynamic.js";
import {
  hasUnregisteredDurableDynamicCallbacks,
  type DurableDynamicCallbackPhase,
  type DurableDynamicCallbackReference,
  type DurableDynamicToolCallbacks,
  type StampedDurableDynamicCallback,
  readDurableDynamicToolCallbacks,
  registerDurableDynamicCallback,
} from "#tools/durable-callbacks.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject } from "#shared/json.js";
import { serializeInputSchema, serializeOutputSchema } from "#tools/schema.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

const log = createLogger("dynamic-tools");

function qualifyDynamicToolNames(
  resolver: ResolvedDynamicToolResolver,
  isSingle: boolean,
  entries: Readonly<Record<string, DynamicToolEntry>>,
): Array<{ name: string; entryKey: string; entry: DynamicToolEntry }> {
  const keys = Object.keys(entries);
  if (keys.length === 0) return [];
  if (isSingle) {
    const entryKey = keys[0]!;
    return [{ name: resolver.slug, entryKey, entry: entries[entryKey]! }];
  }

  const prefix =
    resolver.extensionNamespace === undefined ? "" : `${resolver.extensionNamespace}__`;
  return keys.map((entryKey) => ({
    entry: entries[entryKey]!,
    entryKey,
    name: `${prefix}${entryKey}`,
  }));
}

/** Kept as the session-specific entry point for existing runtime consumers. */
export function replayDynamicSessionTools(
  metadata: readonly CurrentDynamicToolMetadata[],
  _resolvers: readonly ResolvedDynamicToolResolver[],
): readonly HarnessToolDefinition[] {
  return replayDynamicTools(metadata);
}

function durableKeyForEvent(
  eventType: string,
): ContextKey<readonly PersistedDynamicToolMetadata[]> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicToolMetadataKey;
    case "turn.started":
      return TurnDynamicToolMetadataKey;
    case "step.started":
      return StepDynamicToolMetadataKey;
    default:
      return undefined;
  }
}

function readDynamicToolResult(
  resolver: ResolvedDynamicToolResolver,
  value: unknown,
): { readonly entries: Record<string, DynamicToolEntry>; readonly isSingle: boolean } {
  const assertOrdinaryTool = (entry: unknown): void => {
    if (isWorkflowToolDefinition(entry)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" cannot return defineWorkflowTool(). Workflow tools must be static tools; use defineTool() for dynamic entries.`,
      );
    }
  };
  assertOrdinaryTool(value);
  if (isBrandedToolEntry(value)) {
    return { entries: { _single: value as DynamicToolEntry }, isSingle: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Dynamic tool resolver "${resolver.logicalPath}" must return defineTool(), a map of defineTool() values, or null.`,
    );
  }

  const entries: Record<string, DynamicToolEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    assertOrdinaryTool(entry);
    if (!isBrandedToolEntry(entry)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" returned "${name}" without defineTool(). Wrap every dynamic tool entry in defineTool().`,
      );
    }
    entries[name] = entry as DynamicToolEntry;
  }
  return { entries, isSingle: false };
}

function validateReference(input: {
  readonly name: string;
  readonly phase: DurableDynamicCallbackPhase;
  readonly stamped: StampedDurableDynamicCallback | undefined;
  readonly required: boolean;
}): DurableDynamicCallbackReference | undefined {
  if (input.stamped === undefined) {
    if (input.required) {
      throw new Error(
        `Dynamic tool "${input.name}" callback "${input.phase}" does not have a durable descriptor. ` +
          "Author the callback inline in transformed source or use an eve durable callback helper.",
      );
    }
    return undefined;
  }
  const unknownKeys = Object.keys(input.stamped).filter(
    (key) => key !== "closure" && key !== "callback",
  );
  if (unknownKeys.includes("stepId")) {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" was persisted by a pre-release eve ` +
        "version that identified callbacks by build offset. Start a new session to re-resolve it.",
    );
  }
  if (unknownKeys.length > 0) {
    throw new Error(
      `Dynamic tool "${input.name}" has invalid ${input.phase} callback metadata: unknown key(s) ${unknownKeys.join(", ")}.`,
    );
  }
  if (typeof input.stamped.callback !== "function") {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" does not have a durable descriptor. ` +
        "Author the callback inline in transformed source or use an eve durable callback helper.",
    );
  }
  let closure: DurableDynamicCallbackReference["closure"];
  try {
    closure = parseJsonObject(input.stamped.closure);
  } catch (error) {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" has a non-serializable capture. ${toErrorMessage(error)}`,
    );
  }
  registerDurableDynamicCallback({
    callback: input.stamped.callback,
    phase: input.phase,
    toolName: input.name,
  });
  return { closure };
}

export function validateDurableDynamicToolCallbacks(
  name: string,
  entry: DynamicToolEntry,
): DurableDynamicToolCallbacks {
  const raw = readDurableDynamicToolCallbacks(entry) ?? {};
  const unknownPhases = Object.keys(raw).filter(
    (key) =>
      key !== "execute" &&
      key !== "label" &&
      key !== "approvalRequest" &&
      key !== "approvalResponse" &&
      key !== "toModelOutput",
  );
  if (unknownPhases.length > 0) {
    throw new Error(
      `Dynamic tool "${name}" has unknown durable callback phase(s): ${unknownPhases.join(", ")}.`,
    );
  }

  const hasLabelComplete = entry.label?.complete !== undefined;
  const hasLabelDelta = entry.label?.delta !== undefined;
  const hasLabelStart = entry.label?.start !== undefined;
  const hasApproval = entry.approval !== undefined;
  const hasApprovalResponse =
    entry.approval !== undefined &&
    typeof entry.approval !== "function" &&
    entry.approval.response !== undefined;
  const execute = validateReference({
    name,
    phase: "execute",
    stamped: raw.execute,
    required: true,
  })!;
  const labelComplete = validateReference({
    name,
    phase: "labelComplete",
    stamped: raw.label?.complete,
    required: hasLabelComplete,
  });
  const labelDelta = validateReference({
    name,
    phase: "labelDelta",
    stamped: raw.label?.delta,
    required: hasLabelDelta,
  });
  const labelStart = validateReference({
    name,
    phase: "labelStart",
    stamped: raw.label?.start,
    required: hasLabelStart,
  });
  const approvalRequest = validateReference({
    name,
    phase: "approvalRequest",
    stamped: raw.approvalRequest,
    required: hasApproval,
  });
  const approvalResponse = validateReference({
    name,
    phase: "approvalResponse",
    stamped: raw.approvalResponse,
    required: hasApprovalResponse,
  });
  const toModelOutput = validateReference({
    name,
    phase: "toModelOutput",
    stamped: raw.toModelOutput,
    required: entry.toModelOutput !== undefined,
  });

  const callbacks: {
    execute: DurableDynamicCallbackReference;
    label?: {
      complete?: DurableDynamicCallbackReference;
      delta?: DurableDynamicCallbackReference;
      start?: DurableDynamicCallbackReference;
    };
    approvalRequest?: DurableDynamicCallbackReference;
    approvalResponse?: DurableDynamicCallbackReference;
    toModelOutput?: DurableDynamicCallbackReference;
  } = { execute };
  if (labelComplete !== undefined || labelDelta !== undefined || labelStart !== undefined) {
    callbacks.label = {
      complete: labelComplete,
      delta: labelDelta,
      start: labelStart,
    };
  }
  if (approvalRequest !== undefined) callbacks.approvalRequest = approvalRequest;
  if (approvalResponse !== undefined) callbacks.approvalResponse = approvalResponse;
  if (toModelOutput !== undefined) callbacks.toModelOutput = toModelOutput;
  return callbacks;
}

function createMetadata(input: {
  readonly entry: DynamicToolEntry;
  readonly entryKey: string;
  readonly name: string;
  readonly resolver: ResolvedDynamicToolResolver;
}): CurrentDynamicToolMetadata {
  return {
    callbacks: validateDurableDynamicToolCallbacks(input.name, input.entry),
    description: input.entry.description,
    execution: input.entry.execution === "background" ? "background" : undefined,
    entryKey: input.entryKey,
    inputSchema: serializeInputSchema(input.entry.inputSchema),
    name: input.name,
    outputSchema: serializeOutputSchema(input.entry.outputSchema),
    resolverSlug: input.resolver.slug,
  };
}

interface ResolvedDynamicToolEvent {
  readonly metadata: readonly CurrentDynamicToolMetadata[];
}

async function resolveToolsFromEvent(
  ctx: AlsContext,
  resolvers: readonly ResolvedDynamicToolResolver[],
  event: UnstampedMessageStreamEvent,
  messages: readonly ModelMessage[],
): Promise<ResolvedDynamicToolEvent> {
  const outcomes = await Promise.allSettled(
    resolvers.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;
      const rawResult = await handler(event, buildResolveContext(ctx, messages));
      if (rawResult === null || rawResult === undefined) return null;
      const { entries, isSingle } = readDynamicToolResult(resolver, rawResult);
      const named = qualifyDynamicToolNames(resolver, isSingle, entries);
      return {
        metadata: named.map(({ name, entryKey, entry }) =>
          createMetadata({ entry, entryKey, name, resolver }),
        ),
        resolver,
      };
    }),
  );

  const metadata: CurrentDynamicToolMetadata[] = [];
  const dynamicToolOwners = new Map<string, string>();
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic tool resolver (${event.type}) failed — skipping its complete result.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    for (const entry of outcome.value.metadata) {
      const previousOwner = dynamicToolOwners.get(entry.name);
      if (previousOwner !== undefined && previousOwner !== outcome.value.resolver.slug) {
        throw new Error(
          `Dynamic tool "${entry.name}" from resolver "${outcome.value.resolver.slug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually.`,
        );
      }
      dynamicToolOwners.set(entry.name, outcome.value.resolver.slug);
    }
    metadata.push(...outcome.value.metadata);
  }
  return { metadata };
}

const resolvedStepTools = new WeakMap<
  AlsContext,
  { readonly coordinate: string; readonly metadata: readonly CurrentDynamicToolMetadata[] }
>();

function stepCoordinate(event: StepStartedStreamEvent): string {
  return `${event.data.turnId}:${String(event.data.stepIndex)}`;
}

function storeResolvedStepTools(input: {
  readonly ctx: AlsContext;
  readonly event: StepStartedStreamEvent;
  readonly metadata: readonly CurrentDynamicToolMetadata[];
}): void {
  input.ctx.set(StepDynamicToolMetadataKey, input.metadata);
  const coordinate = stepCoordinate(input.event);
  resolvedStepTools.set(input.ctx, { coordinate, metadata: input.metadata });
}

/** Resolves step-scoped tools once for one internal policy/model pass. */
export async function resolveStepDynamicTools(input: {
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: StepStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const coordinate = stepCoordinate(input.event);
  const cached = resolvedStepTools.get(input.ctx);
  if (cached?.coordinate === coordinate) {
    input.ctx.set(StepDynamicToolMetadataKey, cached.metadata);
    return;
  }

  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("step.started"),
  );
  const { metadata } =
    matching.length === 0
      ? { metadata: [] }
      : await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages);
  storeResolvedStepTools({ ctx: input.ctx, event: input.event, metadata });
}

/** Converts persisted step metadata before any approval replay can read it. */
export async function preparePersistedStepDynamicToolMetadata(input: {
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: StepStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const persisted = input.ctx.get(StepDynamicToolMetadataKey) ?? [];
  const current = persisted.filter(isCurrentDynamicToolMetadata);
  if (current.length === persisted.length && !hasUnregisteredDurableDynamicCallbacks(current)) {
    if (current.length > 0) {
      storeResolvedStepTools({ ctx: input.ctx, event: input.event, metadata: current });
    }
    return;
  }

  await resolveStepDynamicTools(input);
  const resolved = input.ctx.get(StepDynamicToolMetadataKey) ?? [];
  storeResolvedStepTools({
    ctx: input.ctx,
    event: input.event,
    metadata: toCurrentDynamicToolMetadataList(
      persisted,
      resolved.filter(isCurrentDynamicToolMetadata),
    ),
  });
}

export async function dispatchDynamicToolEvent(input: {
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  if (!ALLOWED_DYNAMIC_TOOL_EVENTS.has(input.event.type)) return;
  if (input.event.type === "step.started") {
    await resolveStepDynamicTools({ ...input, event: input.event });
    return;
  }

  if (input.event.type === "turn.started") input.ctx.set(StepDynamicToolMetadataKey, []);
  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes(input.event.type),
  );
  const { metadata } =
    matching.length === 0
      ? { metadata: [] }
      : await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages);
  const durableKey = durableKeyForEvent(input.event.type);
  if (durableKey === undefined) return;

  if (input.event.type === "session.started") {
    input.ctx.set(SessionDynamicToolMetadataKey, metadata);
    return;
  }
  const slugs = new Set(matching.map((resolver) => resolver.slug));
  const kept = (input.ctx.get(durableKey) ?? []).filter((entry) => !slugs.has(entry.resolverSlug));
  input.ctx.set(durableKey, [...kept, ...metadata]);
}

/**
 * Refreshes session-scoped definitions when the deployed code revision changes
 * or when persisted callbacks have no registered binding (fresh process after
 * a crash, or a redeploy), so replay always resolves against current code.
 */
export async function refreshDynamicSessionToolsForRuntimeRevision(input: {
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly runtimeRevision: string;
}): Promise<void> {
  const persisted: readonly PersistedDynamicToolMetadata[] =
    input.ctx.get(SessionDynamicToolMetadataKey) ?? [];
  const current = persisted.filter(isCurrentDynamicToolMetadata);
  const hasOldMetadata = current.length !== persisted.length;
  const revisionChanged =
    input.ctx.get(SessionDynamicToolRuntimeRevisionKey) !== input.runtimeRevision;
  if (!revisionChanged && !hasOldMetadata && !hasUnregisteredDurableDynamicCallbacks(current)) {
    return;
  }
  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("session.started"),
  );
  const { metadata } =
    matching.length === 0
      ? { metadata: [] }
      : await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages);
  input.ctx.set(
    SessionDynamicToolMetadataKey,
    revisionChanged ? metadata : toCurrentDynamicToolMetadataList(persisted, metadata),
  );
  input.ctx.set(SessionDynamicToolRuntimeRevisionKey, input.runtimeRevision);
}

/** Re-registers callbacks for compiled resolvers that explicitly support cold replay. */
export async function rebindMissingCompiledDynamicToolCallbacks(input: {
  readonly ctx: AlsContext;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
}): Promise<void> {
  const persisted: readonly PersistedDynamicToolMetadata[] =
    input.ctx.get(TurnDynamicToolMetadataKey) ?? [];
  const needsResolution = persisted.filter(
    (entry) =>
      !isCurrentDynamicToolMetadata(entry) || hasUnregisteredDurableDynamicCallbacks([entry]),
  );
  if (needsResolution.length === 0) return;
  const resolverSlugs = new Set(needsResolution.map((entry) => entry.resolverSlug));
  const oldResolverSlugs = new Set(
    persisted
      .filter((entry) => !isCurrentDynamicToolMetadata(entry))
      .map((entry) => entry.resolverSlug),
  );
  const matching = input.resolvers.filter(
    (resolver) =>
      resolverSlugs.has(resolver.slug) &&
      (oldResolverSlugs.has(resolver.slug) || resolver.rebindMissingCallbacks === true),
  );
  if (matching.length === 0) {
    input.ctx.set(TurnDynamicToolMetadataKey, toCurrentDynamicToolMetadataList(persisted));
    return;
  }

  const resolved: ResolvedDynamicToolEvent = await contextStorage.run(
    input.ctx,
    async () => await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages),
  );
  const updated = toCurrentDynamicToolMetadataList(persisted, resolved.metadata);
  input.ctx.set(TurnDynamicToolMetadataKey, updated);

  const unresolved = updated.filter(
    (entry) =>
      needsResolution.some(
        (candidate) =>
          candidate.resolverSlug === entry.resolverSlug && candidate.name === entry.name,
      ) && hasUnregisteredDurableDynamicCallbacks([entry]),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Dynamic tool callback rebind did not restore: ${unresolved.map((entry) => entry.name).join(", ")}. The tool may have been renamed or removed.`,
    );
  }
}
