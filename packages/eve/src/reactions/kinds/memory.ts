import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { SelectContext } from "#dynamic/definition.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import {
  defaultNamespace,
  type MemoryScope,
  type MemoryTurnContext,
} from "#public/memory/index.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { createMemoryScope, validateMemoryRecallResult } from "#shared/memory-state.js";
import type { InternalResolveContext, Reaction } from "../reaction.js";
import { slotsOf } from "../runner.js";

const log = createLogger("memory");

/**
 * A memory slot's reactions. Recall runs after each turn starts, and what it brings back is part
 * of every model call until the next recall replaces it. Capture runs after each completed turn.
 */
export function memoryReactions(memory: ResolvedMemoryDefinition): readonly Reaction[] {
  const recall: Reaction = {
    contribute: (result) => {
      const messages = validateMemoryRecallResult(result as never, memory.slot);
      return { value: messages.length === 0 ? null : messages.map(({ content }) => content) };
    },
    conversation: true,
    // A recall that fails fails the turn, rather than running it without what it would bring.
    failure: "throw",
    id: `memory:${memory.slot}:recall`,
    kind: "memory",
    label: memory.logicalPath,
    resolve: async (selected, ctx) => {
      const { turn } = selected as { readonly turn: number | null };
      if (turn === null) return null;
      const scope = await resolveMemoryScope(memory, ctx);
      if (scope === null) return null;
      const turnContext = activeTurn(ctx.messages ?? []);
      return await memory.provider.recall["turn.started"]({
        ...buildCallbackContext(),
        abortSignal: ctx.abortSignal,
        memory: { scope, slot: memory.slot },
        messages: ctx.messages ?? [],
        operationId: operationId(ctx, memory.slot, "turn.started", turnContext),
        turn: turnContext,
      });
    },
    select: (view, ctx) => ({
      principal: principalOf(ctx),
      turn: view.latest["turn.started"] ?? null,
    }),
  };
  const capture = memory.provider.capture?.["turn.completed"];
  if (capture === undefined) return [recall];
  return [
    recall,
    {
      contribute: () => ({ value: null }),
      conversation: true,
      id: `memory:${memory.slot}:capture`,
      kind: "memory",
      label: memory.logicalPath,
      resolve: async (_selected, ctx) => {
        const settled = ctx.facts.find(
          (fact) => fact.type === "turn.settled" && fact.data.outcome === "completed",
        );
        if (settled === undefined) return null;
        const scope = await resolveMemoryScope(memory, ctx);
        if (scope === null) return null;
        const turnContext = activeTurn(ctx.messages ?? []);
        try {
          await capture({
            ...buildCallbackContext(),
            abortSignal: ctx.abortSignal,
            memory: { scope, slot: memory.slot },
            messages: ctx.messages ?? [],
            operationId: operationId(ctx, memory.slot, "turn.completed", turnContext),
            turn: turnContext,
          });
        } catch (error) {
          log.error("Completed-turn memory capture failed.", { error, slot: memory.slot });
        }
        return null;
      },
      select: (view) => view.latest["turn.settled"] ?? null,
    },
  ];
}

/** What the memory slots recalled, for the model calls of the turn. */
export function memoryRecallContents(
  ctx: Pick<ContextReader, "get"> | undefined,
): readonly string[] {
  return slotsOf(ctx, "memory").flatMap(({ slot }) =>
    Array.isArray(slot.value) ? (slot.value as readonly string[]) : [],
  );
}

/** The scope a memory slot operates under for this session, or `null` when it's disabled. */
export async function resolveMemoryScope(
  memory: Pick<ResolvedMemoryDefinition, "namespace" | "scope" | "slot">,
  ctx: Pick<InternalResolveContext, "abortSignal" | "channel" | "session" | "ctx">,
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

export function principalOf(ctx: SelectContext): string | null {
  return ctx.session.auth.current?.principalId ?? null;
}

/** The open turn, with the user input that ends the conversation as its input. */
function activeTurn(messages: readonly ModelMessage[]): MemoryTurnContext {
  const projection = currentProjection();
  const turnId = projection.activeTurnId ?? projection.latestTurn?.turnId ?? "";
  const sequence = projection.turns[turnId]?.sequence ?? 0;
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === "user") start -= 1;
  return Object.freeze({
    id: turnId,
    input: Object.freeze(messages.slice(start)),
    sequence,
  });
}

function operationId(
  ctx: Pick<InternalResolveContext, "session">,
  slot: string,
  phase: string,
  turn: MemoryTurnContext,
): string {
  return [
    "eve-memory-operation-v1",
    ctx.session.id,
    String(turn.sequence),
    turn.id.length === 0 ? "standalone" : turn.id,
    phase,
    slot,
  ].join(":");
}

export type { ContextContainer };
