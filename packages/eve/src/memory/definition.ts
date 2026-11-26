import { channelOf } from "#definitions/frame.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ModelMessage } from "ai";

import type { FactOf } from "#protocol/session-events/facts.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import type { SessionFrame } from "#dynamic/definition.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf, turnCoordinatesOf } from "#protocol/session-projection.js";
import {
  instrumentMemoryOperation,
  type InstrumentationMemoryRecord,
  type MemoryInstrumentation,
} from "#instrumentation/memory.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import {
  defaultNamespace,
  type MemoryScope,
  type MemoryTurnContext,
} from "#public/memory/index.js";
import { steeredModelCall, turnSteeredMessage } from "#runtime/connections/identity-hold.js";
import { compiledBundleOf, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { trackPrincipalScope } from "#shared/principal-scope.js";
import {
  createMemoryScope,
  type NormalizedMemoryRecallMessage,
  validateMemoryRecallResult,
} from "#shared/memory-state.js";
import {
  committed,
  type Definition,
  type DefinitionContext,
  type InternalContext,
  requireHistory,
} from "#definitions/definition.js";
import {
  digestOf,
  readDefinitionsState,
  readSlot,
  sessionIdOf,
  slotValueOf,
  writeSlot,
} from "#definitions/state.js";
import { effectiveModelId } from "#definitions/model.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { toolsDefinition } from "#definitions/tools.js";
import type { MemoryToolsContext } from "#public/memory/index.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";
import { recordMemoryToolStore } from "#tracing/eve/agent-memory-instrumentation.js";

const log = createLogger("memory");

const instrumentations = new WeakMap<ContextContainer, MemoryInstrumentation>();

export function bindMemoryInstrumentation(
  ctx: ContextContainer,
  instrumentation: MemoryInstrumentation | undefined,
): void {
  if (instrumentation === undefined) instrumentations.delete(ctx);
  else instrumentations.set(ctx, instrumentation);
}

export function memoryDefinition(memory: ResolvedMemoryDefinition): Definition {
  const id = `memory:${memory.slot}:recall`;
  const append = memory.supersede === "append";
  return {
    contribute: (ctx) => ({
      context: async () => {
        const kept = await ctx.keep(async (evaluation, previous) => {
          const latest = readDefinitionsState(evaluation.ctx).latest;
          const turn = latest["turn.started"] ?? null;
          if (turn === null) return null;
          const cleared = latest["context.settled:clear"] ?? null;
          const steeredBy = evaluation.session.auth.steeredBy;
          const recalled = await evaluation.memo(
            {
              cleared,
              principal: principalOf(evaluation),
              turn,
              ...(steeredBy !== undefined && steeredBy.length > 0 && { steeredBy }),
            },
            () => recallOnce(memory, evaluation, cleared),
          );
          if (recalled === null) return null;
          const messages = validateMemoryRecallResult(recalled.result as never, memory.slot);
          const recalls = accumulate(previous ?? null, recalled, messages, append);
          return { value: recalls.batches.length === 0 ? null : parseJsonValue(recalls) };
        });
        return (slotValueOf<Recalls | null | undefined>(kept?.value)?.batches ?? []).flatMap(
          ({ messages, turnId }) =>
            messages.map(({ content, id }) => ({
              message: createFrameworkUserMessage(
                "memory.load",
                append && id !== undefined
                  ? `Memory record ${memory.slot}/${id}. Use only the latest version of this record.\n\n${content}`
                  : content,
              ),
              turnId,
            })),
        );
      },
      effects: () => [
        ...committed(ctx, "context.started").flatMap((started) =>
          started.data.kind === "compaction" && memory.provider.capture?.["compaction.requested"]
            ? [
                {
                  blocking: true as const,
                  id: `memory:${memory.slot}:compaction`,
                  run: () => captureBeforeCompaction(memory, ctx, started),
                },
              ]
            : [],
        ),
        ...(append &&
        committed(ctx, "context.settled").some(
          ({ data }) => data.kind === "compaction" && data.outcome === "completed",
        )
          ? [
              {
                id: `memory:${memory.slot}:prune`,
                run: async () => pruneRecalls(ctx.container as ContextContainer, id),
              },
            ]
          : []),
        ...committed(ctx, "turn.settled").flatMap((settled) =>
          settled.data.outcome === "completed" && memory.provider.capture?.["turn.completed"]
            ? [{ id: `memory:${memory.slot}:capture`, run: () => captureTurn(memory, ctx) }]
            : [],
        ),
      ],
    }),
    id,
    label: memory.logicalPath,
  };
}

async function captureTurn(
  memory: ResolvedMemoryDefinition,
  ctx: DefinitionContext,
): Promise<void> {
  const capture = memory.provider.capture!["turn.completed"]!;
  const container = ctx.container as ContextContainer;
  const messages = requireHistory(ctx.history, memory.logicalPath);
  const turnContext = activeTurn(messages);
  const scopeCtx = commitScopeContext(ctx);
  const resolved = await resolveTrackedMemoryScope(memory, scopeCtx);
  if (resolved === null) return;
  if (resolved.callerScoped && (scopeCtx.session.auth.steeredBy ?? []).length > 0) return;
  const { scope } = resolved;
  const id = operationId(sessionIdOf(container), memory.slot, "turn.completed", turnContext);
  try {
    await instrumentMemoryOperation(
      instrumentations.get(container),
      {
        idempotencyKey: id,
        operationName: "upsert_memory",
        phase: "turn.completed",
        slot: memory.slot,
        storeId: scope.key,
        turnId: turnContext.id,
      },
      async () => {
        await capture({
          ...buildCallbackContext(),
          abortSignal: ctx.signal,
          memory: { scope, slot: memory.slot },
          messages,
          operationId: id,
          turn: turnContext,
        });
        return { value: undefined };
      },
    );
  } catch (error) {
    log.error("Completed-turn memory capture failed.", { error, slot: memory.slot });
  }
}

async function recallOnce(
  memory: ResolvedMemoryDefinition,
  ctx: InternalContext,
  cleared: number | null,
): Promise<RecallRecord | null> {
  const messages = requireHistory(ctx.history, memory.logicalPath);
  const turnContext = activeTurn(messages);
  const resolved = await resolveTrackedMemoryScope(memory, ctx);
  if (resolved === null) return null;
  if (resolved.callerScoped && (ctx.session.auth.steeredBy ?? []).length > 0) return null;
  const { scope } = resolved;
  const operation = operationId(ctx.session.id, memory.slot, "turn.started", turnContext);
  const result = await instrumentMemoryOperation(
    instrumentations.get(ctx.ctx),
    {
      idempotencyKey: operation,
      operationName: "search_memory",
      phase: "turn.started",
      slot: memory.slot,
      storeId: scope.key,
      turnId: turnContext.id,
    },
    async () => {
      const result = await memory.provider.recall["turn.started"]({
        ...buildCallbackContext(),
        abortSignal: ctx.abortSignal,
        memory: { scope, slot: memory.slot },
        messages,
        operationId: operation,
        turn: turnContext,
      });
      const records: InstrumentationMemoryRecord[] = (result?.messages ?? []).map((message) =>
        message.id === undefined
          ? { content: message.content }
          : { content: message.content, id: message.id },
      );
      return { outputRecords: records, recordCount: records.length, value: result };
    },
  );
  return {
    cleared,
    result: (result ?? null) as RecallRecord["result"],
    scope: scope.key,
    turnId: turnContext.id,
  };
}

function commitScopeContext(ctx: DefinitionContext): ScopeContext {
  const frame = buildCallbackContext();
  return {
    abortSignal: ctx.signal,
    channel: channelOf(ctx.container),
    ...(frame.conversation !== undefined && { conversation: frame.conversation }),
    ctx: ctx.container as ContextContainer,
    session: { auth: frame.session.auth, id: frame.session.id },
  };
}

async function captureBeforeCompaction(
  memory: ResolvedMemoryDefinition,
  ctx: DefinitionContext,
  started: FactOf<"context.started">,
): Promise<void> {
  const capture = memory.provider.capture!["compaction.requested"]!;
  const container = ctx.container as ContextContainer;
  try {
    const messages = requireHistory(ctx.history, memory.logicalPath);
    const scopeCtx = commitScopeContext(ctx);
    const resolved = await resolveTrackedMemoryScope(memory, scopeCtx);
    if (resolved === null) return;
    if (resolved.callerScoped && (scopeCtx.session.auth.steeredBy ?? []).length > 0) return;
    const { scope } = resolved;
    const turn = started.data.turnId === undefined ? null : activeTurn(messages);
    const id = [
      "eve-memory-operation-v1",
      sessionIdOf(container),
      "compaction.requested",
      started.data.changeId,
      memory.slot,
    ].join(":");
    await instrumentMemoryOperation(
      instrumentations.get(container),
      {
        idempotencyKey: id,
        operationName: "upsert_memory",
        phase: "compaction.requested",
        slot: memory.slot,
        storeId: scope.key,
        ...(turn !== null && { turnId: turn.id }),
      },
      async () => {
        await capture({
          ...buildCallbackContext(),
          abortSignal: ctx.signal,
          compaction: {
            modelId:
              container.get(SessionAgentKey)?.settings.compaction?.model?.id ??
              effectiveModelId(container) ??
              "unknown",
            usageInputTokens: started.data.trigger?.inputTokens ?? null,
          },
          memory: { scope, slot: memory.slot },
          messages,
          operationId: id,
          turn,
        });
        return { value: undefined };
      },
    );
  } catch (error) {
    log.error("Memory capture before compaction failed; the compaction fails.", {
      error,
      slot: memory.slot,
    });
    throw error;
  }
}

interface RecallRecord {
  readonly cleared: number | null;
  readonly result: unknown;
  readonly scope: string;
  readonly turnId: string;
}

interface RecalledMessage {
  readonly content: string;
  readonly id?: string;
}

interface RecallBatch {
  readonly turnId: string;
  readonly messages: readonly RecalledMessage[];
}

interface Recalls {
  readonly cleared: number | null;
  readonly scope: string;
  readonly batches: readonly RecallBatch[];
}

export function accumulate(
  previous: JsonValue,
  recalled: RecallRecord,
  messages: readonly NormalizedMemoryRecallMessage[],
  append = false,
): Recalls {
  const earlier = previous as Recalls | null;
  const kept =
    earlier?.batches !== undefined &&
    earlier.cleared === recalled.cleared &&
    earlier.scope === recalled.scope
      ? earlier.batches.filter(({ turnId }) => turnId !== recalled.turnId)
      : [];
  const live = new Map<string, string>();
  for (const batch of kept) {
    for (const message of batch.messages) {
      if (message.id !== undefined) live.set(message.id, message.content);
    }
  }
  const added: RecalledMessage[] = messages
    .filter(({ content, itemKey }) => itemKey === undefined || live.get(itemKey) !== content)
    .map(({ content, itemKey }) =>
      itemKey === undefined ? { content } : { content, id: itemKey },
    );
  if (added.length > 0) kept.push({ messages: added, turnId: recalled.turnId });
  return {
    batches: append ? kept : latestBatches(kept),
    cleared: recalled.cleared,
    scope: recalled.scope,
  };
}

function latestBatches(batches: readonly RecallBatch[]): RecallBatch[] {
  const seen = new Set<string>();
  const latest: RecallBatch[] = [];
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i]!;
    const messages = batch.messages.filter(({ id }) => {
      if (id === undefined) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (messages.length > 0) latest.push({ ...batch, messages });
  }
  return latest.reverse();
}

function pruneRecalls(ctx: ContextContainer, id: string): void {
  const slot = readSlot(ctx, id);
  if (slot === undefined || slot.value === null) return;
  const recalls = slotValueOf<Recalls>(slot.value);
  const value = parseJsonValue({ ...recalls, batches: latestBatches(recalls.batches) });
  const digest = digestOf(value);
  if (digest === slot.digest) return;
  writeSlot(ctx, id, { digest, since: readDefinitionsState(ctx).latest["*"] ?? slot.since, value });
}

export interface ScopeContext {
  readonly abortSignal: AbortSignal;
  readonly channel: SessionFrame["channel"];
  readonly conversation?: SessionFrame["conversation"];
  readonly ctx: InternalContext["ctx"];
  readonly session: Pick<SessionFrame["session"], "auth" | "id">;
}

interface TrackedMemoryScope {
  readonly callerScoped: boolean;
  readonly scope: MemoryScope;
}

async function resolveTrackedMemoryScope(
  memory: Pick<ResolvedMemoryDefinition, "namespace" | "scope" | "slot">,
  ctx: ScopeContext,
): Promise<TrackedMemoryScope | null> {
  const { used: callerScoped, value: scope } =
    typeof memory.scope === "function"
      ? await trackPrincipalScope(() =>
          (memory.scope as Extract<typeof memory.scope, Function>)({
            abortSignal: ctx.abortSignal,
            channel: ctx.channel,
            ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
            session: { auth: ctx.session.auth, id: ctx.session.id },
          }),
        )
      : { used: false, value: memory.scope };
  if (scope === null) return disabled(memory.slot, "scope");
  const namespaceContext = {
    appRoot: compiledBundleOf(ctx.ctx)?.resolvedAgent.metadata.appRoot ?? "",
    node: runtimeNodeId(ctx.ctx.get(SessionAgentKey) ?? {}),
    slot: memory.slot,
  };
  const namespace =
    memory.namespace === undefined
      ? defaultNamespace(namespaceContext)
      : typeof memory.namespace === "function"
        ? await memory.namespace(namespaceContext)
        : memory.namespace;
  if (namespace === null) return disabled(memory.slot, "namespace");
  return { callerScoped, scope: createMemoryScope({ namespace, scope, slot: memory.slot }) };
}

export async function resolveMemoryScope(
  memory: Pick<ResolvedMemoryDefinition, "namespace" | "scope" | "slot">,
  ctx: ScopeContext,
): Promise<MemoryScope | null> {
  return (await resolveTrackedMemoryScope(memory, ctx))?.scope ?? null;
}

function disabled(slot: string, resolver: "namespace" | "scope"): null {
  if (isEveDevEnvironment())
    log.info("Memory slot is disabled for this operation", { resolver, slot });
  return null;
}

export function principalOf(ctx: Pick<SessionFrame, "session">): SessionAuthContext | null {
  return ctx.session.auth.current;
}

function activeTurn(messages: readonly ModelMessage[]): MemoryTurnContext {
  const projection = currentProjection();
  const turnId = activeTurnIdOf(projection) ?? latestTurnIdOf(projection) ?? "";
  const { sequence } = turnCoordinatesOf(projection, turnId);
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role !== "user") end -= 1;
  let start = end;
  while (start > 0 && messages[start - 1]!.role === "user") start -= 1;
  return Object.freeze({
    id: turnId,
    input: Object.freeze(messages.slice(start, end)),
    sequence,
  });
}

function operationId(
  sessionId: string,
  slot: string,
  phase: string,
  turn: MemoryTurnContext,
): string {
  return [
    "eve-memory-operation-v1",
    sessionId,
    String(turn.sequence),
    turn.id.length === 0 ? "standalone" : turn.id,
    phase,
    slot,
  ].join(":");
}

export function memoryToolsDefinition(memory: ResolvedMemoryDefinition): Definition {
  return toolsDefinition({ logicalPath: `tools/${memory.slot}.ts`, slug: memory.slot }, (ctx) =>
    memoryTools(memory, ctx),
  );
}

export async function memoryTools(memory: ResolvedMemoryDefinition, ctx: InternalContext) {
  const { provider, slot } = memory;
  if (provider.tools === undefined) return null;
  const turn = readDefinitionsState(ctx.ctx).latest["turn.started"] ?? null;
  const steeredBy = ctx.session.auth.steeredBy;
  const resolved = await ctx.memo(
    {
      principal: principalOf(ctx),
      turn,
      ...(steeredBy !== undefined && steeredBy.length > 0 && { steeredBy }),
    },
    () => resolveTrackedMemoryScope(memory, ctx),
  );
  if (resolved === null) return null;
  const { callerScoped, scope } = resolved;
  const context: { -readonly [K in keyof MemoryToolsContext]: MemoryToolsContext[K] } = {
    abortSignal: ctx.abortSignal,
    channel: ctx.channel,
    memory: { scope, slot },
    session: ctx.session,
  };
  if (ctx.conversation !== undefined) context.conversation = ctx.conversation;
  const result = await provider.tools(context);
  if (result === null) return null;
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Memory slot "${slot}" provider.tools() must return a tool map or null.`);
  }
  return Object.fromEntries(
    Object.entries(result).map(([key, tool]) => {
      const name = `${slot}__${key}`;
      if (!isBrandedToolEntry(tool)) {
        throw new Error(`Memory provider tool "${name}" must be created with defineTool().`);
      }
      const description =
        memory.description === undefined
          ? tool.description
          : `${memory.description}\n\n${tool.description}`;
      return [
        name,
        {
          ...tool,
          description,
          execute(input: unknown, toolContext: Parameters<typeof tool.execute>[1]) {
            if (callerScoped && steeredModelCall()) {
              throw new Error(turnSteeredMessage(`memory "${slot}"`));
            }
            recordMemoryToolStore(scope.key, slot);
            return tool.execute(input, toolContext);
          },
        },
      ];
    }),
  );
}
