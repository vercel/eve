import { channelOf } from "../frame.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ModelMessage } from "ai";

import type { AnchoredContext } from "#harness/current-messages.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
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
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import {
  createMemoryScope,
  type NormalizedMemoryRecallMessage,
  validateMemoryRecallResult,
} from "#shared/memory-state.js";
import {
  requireHistory,
  type CommitContext,
  type CommitReaction,
  type InternalContext,
  type Reaction,
  type ValueReaction,
} from "../reaction.js";
import { readReactionsState, readSlot, sessionIdOf, slotsOf } from "../state.js";
import { effectiveModelId } from "./model.js";

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
 * A memory slot's reactions. Recall runs before the first model call of each turn, and what it
 * brings back joins what earlier turns' recalls brought: each model call reads every turn's
 * recall just ahead of that turn's input, where earlier calls read it, so the prompt ahead of it
 * stays cached. A message with an `id` replaces the one with that `id` an earlier turn recalled.
 * A clear or a new scope starts over. Capture runs after the commit that completes a turn.
 */
export function memoryReactions(memory: ResolvedMemoryDefinition): readonly Reaction[] {
  const id = `memory:${memory.slot}:recall`;
  const recall: ValueReaction = {
    contribute: (result, ctx) => {
      if (result === null) return { value: null };
      const recalled = result as RecallRecord;
      const messages = validateMemoryRecallResult(recalled.result as never, memory.slot);
      const recalls = accumulate(readSlot(ctx.ctx, id)?.value ?? null, recalled, messages);
      return { value: recalls.batches.length === 0 ? null : parseJsonValue(recalls) };
    },
    // Recall runs once per turn, principal, and clear: the memo keeps what it brought back.
    evaluate: async (ctx) => {
      const latest = readReactionsState(ctx.ctx).latest;
      const turn = latest["turn.started"] ?? null;
      if (turn === null) return null;
      const cleared = latest["context.settled:clear"] ?? null;
      return await ctx.memo({ cleared, principal: principalOf(ctx), turn }, () =>
        recallOnce(memory, ctx, cleared),
      );
    },
    id,
    kind: "memory",
    label: memory.logicalPath,
  };
  const reactions: Reaction[] = [recall];
  const compaction = compactionCapture(memory);
  if (compaction !== undefined) reactions.push(compaction);
  const capture = memory.provider.capture?.["turn.completed"];
  if (capture === undefined) return reactions;
  return [
    ...reactions,
    {
      id: `memory:${memory.slot}:capture`,
      kind: "memory",
      label: memory.logicalPath,
      // Capture is an effect of the turn settling, so it runs after the commit that settles it.
      onCommit: async (ctx) => {
        const settled = ctx.facts.find(
          (fact) => fact.type === "turn.settled" && fact.data.outcome === "completed",
        );
        if (settled === undefined) return;
        const messages = requireHistory(ctx, memory.logicalPath);
        const turnContext = activeTurn(messages);
        const scope = await resolveMemoryScope(memory, commitScopeContext(ctx));
        if (scope === null) return;
        const id = operationId(sessionIdOf(ctx.ctx), memory.slot, "turn.completed", turnContext);
        try {
          await instrumentMemoryOperation(
            instrumentations.get(ctx.ctx),
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
                abortSignal: ctx.abortSignal,
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
      },
      timing: "commit",
    } satisfies CommitReaction,
  ];
}

/** One turn's recall: what the provider brought back, under the scope it recalled in. */
async function recallOnce(
  memory: ResolvedMemoryDefinition,
  ctx: InternalContext,
  cleared: number | null,
): Promise<RecallRecord | null> {
  const messages = requireHistory(ctx, memory.logicalPath);
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

/** What resolving a memory scope reads, in a commit-time effect. */
function commitScopeContext(ctx: CommitContext): ScopeContext {
  const frame = buildCallbackContext();
  return {
    abortSignal: ctx.abortSignal,
    channel: channelOf(ctx.ctx),
    ctx: ctx.ctx,
    session: { auth: frame.session.auth, id: frame.session.id },
  };
}

/** What failed a compaction's capture, for the compaction that commit started. */
const compactionCaptureFailures = new WeakMap<object, unknown>();

/**
 * Takes the error a memory slot's capture threw for the compaction this step started: the
 * compaction then fails before it rewrites history.
 */
export function takeCompactionCaptureFailure(ctx: object | undefined): unknown {
  if (ctx === undefined || !compactionCaptureFailures.has(ctx)) return undefined;
  const error = compactionCaptureFailures.get(ctx);
  compactionCaptureFailures.delete(ctx);
  return error ?? new Error("A memory capture failed.");
}

/**
 * Capture before compaction, after the commit that starts it: that commit carries the history
 * compaction is about to rewrite, and the summary waits for it.
 */
function compactionCapture(memory: ResolvedMemoryDefinition): CommitReaction | undefined {
  const capture = memory.provider.capture?.["compaction.requested"];
  if (capture === undefined) return undefined;
  return {
    id: `memory:${memory.slot}:compaction`,
    kind: "memory",
    label: memory.logicalPath,
    timing: "commit",
    onCommit: async (ctx) => {
      const started = ctx.facts.find(
        (fact): fact is FactOf<"context.started"> =>
          fact.type === "context.started" && fact.data.kind === "compaction",
      );
      if (started === undefined) return;
      try {
        const messages = requireHistory(ctx, memory.logicalPath);
        const scope = await resolveMemoryScope(memory, commitScopeContext(ctx));
        if (scope === null) return;
        const turn = started.data.turnId === undefined ? null : activeTurn(messages);
        const id = [
          "eve-memory-operation-v1",
          sessionIdOf(ctx.ctx),
          "compaction.requested",
          started.data.changeId,
          memory.slot,
        ].join(":");
        await instrumentMemoryOperation(
          instrumentations.get(ctx.ctx),
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
              abortSignal: ctx.abortSignal,
              compaction: {
                modelId: effectiveModelId(ctx.ctx) ?? "unknown",
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
        if (!compactionCaptureFailures.has(ctx.ctx)) compactionCaptureFailures.set(ctx.ctx, error);
      }
    },
  };
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

/** What the memory slots recalled, each with the turn whose input it belongs ahead of. */
export function memoryRecallContents(
  ctx: Pick<ContextReader, "get"> | undefined,
): readonly AnchoredContext[] {
  return slotsOf(ctx, "memory").flatMap(({ slot }) => {
    const recalls = slot.value as Recalls | null;
    return (recalls?.batches ?? []).flatMap(({ messages, turnId }) =>
      messages.map(({ content }) => ({ content, turnId })),
    );
  });
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
  const bundle = ctx.ctx.get(BundleKey);
  const namespaceContext = {
    appRoot: bundle?.resolvedAgent.metadata.appRoot ?? "",
    node: bundle?.nodeId ?? "__root__",
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
