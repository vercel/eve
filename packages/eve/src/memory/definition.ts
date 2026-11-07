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
import { compiledBundleOf, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
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
import { readDefinitionsState, sessionIdOf } from "#definitions/state.js";
import { effectiveModelId } from "#definitions/model.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { toolsDefinition } from "#definitions/tools.js";
import type { MemoryToolsContext } from "#public/memory/index.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";

const log = createLogger("memory");

/** Memory operation instrumentation for a step's context, when the session installs it. */
const instrumentations = new WeakMap<ContextContainer, MemoryInstrumentation>();

export function bindMemoryInstrumentation(
  ctx: ContextContainer,
  instrumentation: MemoryInstrumentation | undefined,
): void {
  if (instrumentation === undefined) instrumentations.delete(ctx);
  else instrumentations.set(ctx, instrumentation);
}

/**
 * A `defineMemory()` slot. Recall runs before the first model call of each turn, and what it
 * brings back joins what earlier turns' recalls brought, which the slot keeps: each model call
 * reads every turn's recall just ahead of that turn's input, where earlier calls read it, so the
 * prompt ahead of it stays cached. A message with an `id` replaces the one with that `id` an
 * earlier turn recalled. A clear or a new scope starts over. Capture runs after the commit that
 * completes a turn, and before a compaction rewrites the history it captures: a failure there
 * fails the compaction. The provider's tools are {@link memoryToolsDefinition}'s.
 */
export function memoryDefinition(memory: ResolvedMemoryDefinition): Definition {
  return {
    contribute: (ctx) => ({
      context: async () => {
        // Recall runs once per turn, principal, and clear: the memo keeps what it brought back.
        const kept = await ctx.keep(async (evaluation, previous) => {
          const latest = readDefinitionsState(evaluation.ctx).latest;
          const turn = latest["turn.started"] ?? null;
          if (turn === null) return null;
          const cleared = latest["context.settled:clear"] ?? null;
          const recalled = await evaluation.memo(
            { cleared, principal: principalOf(evaluation), turn },
            () => recallOnce(memory, evaluation, cleared),
          );
          if (recalled === null) return null;
          const messages = validateMemoryRecallResult(recalled.result as never, memory.slot);
          const recalls = accumulate(previous ?? null, recalled, messages);
          return { value: recalls.batches.length === 0 ? null : parseJsonValue(recalls) };
        });
        return ((kept?.value as Recalls | null | undefined)?.batches ?? []).flatMap(
          ({ messages, turnId }) =>
            messages.map(({ content }) => ({
              message: createFrameworkUserMessage("memory.load", content),
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
        ...committed(ctx, "turn.settled").flatMap((settled) =>
          settled.data.outcome === "completed" && memory.provider.capture?.["turn.completed"]
            ? [{ id: `memory:${memory.slot}:capture`, run: () => captureTurn(memory, ctx) }]
            : [],
        ),
      ],
    }),
    id: `memory:${memory.slot}:recall`,
    label: memory.logicalPath,
  };
}

/** Capture after the commit that completes a turn: a failure is logged. */
async function captureTurn(
  memory: ResolvedMemoryDefinition,
  ctx: DefinitionContext,
): Promise<void> {
  const capture = memory.provider.capture!["turn.completed"]!;
  const container = ctx.container as ContextContainer;
  const messages = requireHistory(ctx.history, memory.logicalPath);
  const turnContext = activeTurn(messages);
  const scope = await resolveMemoryScope(memory, commitScopeContext(ctx));
  if (scope === null) return;
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

/** One turn's recall: what the provider brought back, under the scope it recalled in. */
async function recallOnce(
  memory: ResolvedMemoryDefinition,
  ctx: InternalContext,
  cleared: number | null,
): Promise<RecallRecord | null> {
  const messages = requireHistory(ctx.history, memory.logicalPath);
  const turnContext = activeTurn(messages);
  const scope = await resolveMemoryScope(memory, ctx);
  if (scope === null) return null;
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

/** What resolving a memory scope reads, after a commit. */
function commitScopeContext(ctx: DefinitionContext): ScopeContext {
  const frame = buildCallbackContext();
  return {
    abortSignal: ctx.signal,
    channel: channelOf(ctx.container),
    ctx: ctx.container as ContextContainer,
    session: { auth: frame.session.auth, id: frame.session.id },
  };
}

/**
 * Capture before compaction, after the commit that starts it: that commit carries the history
 * compaction is about to rewrite, and the summary waits for it. It blocks: a capture that fails
 * fails the compaction before it rewrites the history the capture couldn't keep.
 */
async function captureBeforeCompaction(
  memory: ResolvedMemoryDefinition,
  ctx: DefinitionContext,
  started: FactOf<"context.started">,
): Promise<void> {
  const capture = memory.provider.capture!["compaction.requested"]!;
  const container = ctx.container as ContextContainer;
  try {
    const messages = requireHistory(ctx.history, memory.logicalPath);
    const scope = await resolveMemoryScope(memory, commitScopeContext(ctx));
    if (scope === null) return;
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

/** One turn's recall, as `record` returns it. */
interface RecallRecord {
  /** The latest clear when it recalled: a clear starts over. */
  readonly cleared: number | null;
  readonly result: unknown;
  /** The scope it recalled under: another scope starts over. */
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

/** What a slot's recalls brought, for the session so far: each turn's, in turn order. */
interface Recalls {
  readonly cleared: number | null;
  readonly scope: string;
  readonly batches: readonly RecallBatch[];
}

/**
 * Joins a turn's recall to what earlier turns' recalls brought. A message with an `id` an earlier
 * turn recalled replaces it, unless its content is the same; a recall for a turn that already has
 * one, as on a new deployment, replaces that turn's.
 */
export function accumulate(
  previous: JsonValue,
  recalled: RecallRecord,
  messages: readonly NormalizedMemoryRecallMessage[],
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
  const replaced = new Set(added.flatMap(({ id }) => (id === undefined ? [] : [id])));
  const batches: RecallBatch[] = kept
    .map((batch) => ({
      ...batch,
      messages: batch.messages.filter(({ id }) => id === undefined || !replaced.has(id)),
    }))
    .filter(({ messages }) => messages.length > 0);
  if (added.length > 0) batches.push({ messages: added, turnId: recalled.turnId });
  return { batches, cleared: recalled.cleared, scope: recalled.scope };
}

/** What resolving a memory slot's scope reads. */
export interface ScopeContext {
  readonly abortSignal: AbortSignal;
  readonly channel: SessionFrame["channel"];
  readonly ctx: InternalContext["ctx"];
  readonly session: Pick<SessionFrame["session"], "auth" | "id">;
}

/** The scope a memory slot operates under for this session, or `null` when it's disabled. */
export async function resolveMemoryScope(
  memory: Pick<ResolvedMemoryDefinition, "namespace" | "scope" | "slot">,
  ctx: ScopeContext,
): Promise<MemoryScope | null> {
  const scope =
    typeof memory.scope === "function"
      ? await memory.scope({
          abortSignal: ctx.abortSignal,
          channel: ctx.channel,
          session: { auth: ctx.session.auth, id: ctx.session.id },
        })
      : memory.scope;
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
  return createMemoryScope({ namespace, scope, slot: memory.slot });
}

function disabled(slot: string, resolver: "namespace" | "scope"): null {
  if (isEveDevEnvironment())
    log.info("Memory slot is disabled for this operation", { resolver, slot });
  return null;
}

/**
 * Who the session acts for, as a memory selection reads it: the whole principal, since a scope
 * tells principals apart by type, authenticator, issuer, and id, and an authored scope can read
 * its attributes too. Two principals that share an id never share a selection.
 */
export function principalOf(ctx: Pick<SessionFrame, "session">): SessionAuthContext | null {
  return ctx.session.auth.current;
}

/** The open turn, with the user input that ends the conversation as its input. */
function activeTurn(messages: readonly ModelMessage[]): MemoryTurnContext {
  const projection = currentProjection();
  const turnId = activeTurnIdOf(projection) ?? latestTurnIdOf(projection) ?? "";
  const { sequence } = turnCoordinatesOf(projection, turnId);
  // The turn's input is the latest run of user messages: trailing while the turn is starting,
  // followed by the turn's response once it has completed.
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

/**
 * A memory's provider tools, named `<slot>__<key>`, as the tool file `agent/tools/<slot>.ts`
 * would offer them, which replaces or disables them where the agent declares it.
 */
export function memoryToolsDefinition(memory: ResolvedMemoryDefinition): Definition {
  return toolsDefinition({ logicalPath: `tools/${memory.slot}.ts`, slug: memory.slot }, (ctx) =>
    memoryTools(memory, ctx),
  );
}

async function memoryTools(memory: ResolvedMemoryDefinition, ctx: InternalContext) {
  const { provider, slot } = memory;
  if (provider.tools === undefined) return null;
  // The scope is the data the tools are made from: resolved once per turn and principal, as recall
  // resolves it, so both read the channel of the same turn.
  const turn = readDefinitionsState(ctx.ctx).latest["turn.started"] ?? null;
  const scope = await ctx.memo({ principal: principalOf(ctx), turn }, () =>
    resolveMemoryScope(memory, ctx),
  );
  if (scope === null) return null;
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
      return [name, { ...tool, description }];
    }),
  );
}
