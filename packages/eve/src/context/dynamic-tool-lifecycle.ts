import type { ModelMessage } from "ai";

import { replayDynamicTools } from "#context/build-dynamic-tools.js";
import { contextStorage, type ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import type { SessionStartedStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
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
  metadata: readonly DurableDynamicToolMetadata[],
  _resolvers: readonly ResolvedDynamicToolResolver[],
): readonly HarnessToolDefinition[] {
  return replayDynamicTools(metadata);
}

function durableKeyForEvent(
  eventType: string,
): ContextKey<readonly DurableDynamicToolMetadata[]> | undefined {
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
      key !== "approvalRequest" &&
      key !== "approvalResponse" &&
      key !== "toModelOutput",
  );
  if (unknownPhases.length > 0) {
    throw new Error(
      `Dynamic tool "${name}" has unknown durable callback phase(s): ${unknownPhases.join(", ")}.`,
    );
  }

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
    approvalRequest?: DurableDynamicCallbackReference;
    approvalResponse?: DurableDynamicCallbackReference;
    toModelOutput?: DurableDynamicCallbackReference;
  } = { execute };
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
}): DurableDynamicToolMetadata {
  return {
    callbacks: validateDurableDynamicToolCallbacks(input.name, input.entry),
    description: input.entry.description,
    entryKey: input.entryKey,
    inputSchema: serializeInputSchema(input.entry.inputSchema),
    name: input.name,
    outputSchema: serializeOutputSchema(input.entry.outputSchema),
    resolverSlug: input.resolver.slug,
  };
}

interface ResolvedDynamicToolEvent {
  readonly metadata: readonly DurableDynamicToolMetadata[];
}

async function resolveToolsFromEvent(
  ctx: ContextContainer,
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

  const metadata: DurableDynamicToolMetadata[] = [];
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
  ContextContainer,
  { readonly coordinate: string; readonly metadata: readonly DurableDynamicToolMetadata[] }
>();

/** Resolves step-scoped tools once for one internal policy/model pass. */
export async function resolveStepDynamicTools(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const data = ("data" in input.event ? input.event.data : undefined) as
    | { readonly stepIndex?: unknown; readonly turnId?: unknown }
    | undefined;
  const coordinate =
    typeof data?.turnId === "string" && typeof data.stepIndex === "number"
      ? `${data.turnId}:${String(data.stepIndex)}`
      : undefined;
  const cached = resolvedStepTools.get(input.ctx);
  if (coordinate !== undefined && cached?.coordinate === coordinate) {
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
  input.ctx.set(StepDynamicToolMetadataKey, metadata);
  if (coordinate !== undefined) resolvedStepTools.set(input.ctx, { coordinate, metadata });
}

export async function dispatchDynamicToolEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  if (!ALLOWED_DYNAMIC_TOOL_EVENTS.has(input.event.type)) return;
  if (input.event.type === "step.started") {
    await resolveStepDynamicTools(input);
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
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly runtimeRevision: string;
}): Promise<void> {
  const revisionChanged =
    input.ctx.get(SessionDynamicToolRuntimeRevisionKey) !== input.runtimeRevision;
  const needsRebind = hasUnregisteredDurableDynamicCallbacks(
    input.ctx.get(SessionDynamicToolMetadataKey) ?? [],
  );
  if (!revisionChanged && !needsRebind) return;
  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("session.started"),
  );
  const { metadata } =
    matching.length === 0
      ? { metadata: [] }
      : await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages);
  input.ctx.set(SessionDynamicToolMetadataKey, metadata);
  input.ctx.set(SessionDynamicToolRuntimeRevisionKey, input.runtimeRevision);
}

/** Re-registers callbacks for compiled resolvers that explicitly support cold replay. */
export async function rebindMissingCompiledDynamicToolCallbacks(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
}): Promise<void> {
  const persisted = input.ctx.get(TurnDynamicToolMetadataKey) ?? [];
  const missing = persisted.filter((entry) => hasUnregisteredDurableDynamicCallbacks([entry]));
  if (missing.length === 0) return;
  const missingSlugs = new Set(missing.map((entry) => entry.resolverSlug));
  const matching = input.resolvers.filter(
    (resolver) => resolver.rebindMissingCallbacks === true && missingSlugs.has(resolver.slug),
  );
  if (matching.length === 0) return;

  await contextStorage.run(
    input.ctx,
    async () => await resolveToolsFromEvent(input.ctx, matching, input.event, input.messages),
  );
  const unresolved = missing.filter((entry) => hasUnregisteredDurableDynamicCallbacks([entry]));
  if (unresolved.length > 0) {
    throw new Error(
      `Dynamic tool callback rebind did not restore: ${unresolved.map((entry) => entry.name).join(", ")}. The tool may have been renamed or removed.`,
    );
  }
}
