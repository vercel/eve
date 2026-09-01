import type { ModelMessage, SystemModelMessage } from "ai";

import { ALLOWED_DYNAMIC_INSTRUCTION_EVENTS } from "#dynamic/definition.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { AlsContext, ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  DynamicInstructionResolveMessagesKey,
  PendingDynamicInstructionUserMessagesKey,
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-instructions");

type SlugMessageMap = Record<string, readonly SystemModelMessage[]>;

type LoweredInstruction =
  | { readonly role: "system"; readonly message: SystemModelMessage }
  | { readonly role: "user"; readonly message: ModelMessage }
  | undefined;

function lowerInstruction(definition: InstructionsDefinition): LoweredInstruction {
  const normalized = normalizeInstructionsDefinition(
    definition,
    "Expected dynamic instructions to match the public eve shape.",
  );
  const content = normalized.content.trim();
  if (content.length === 0) return undefined;
  return normalized.role === "system"
    ? { role: "system", message: { role: "system", content } }
    : { role: "user", message: { role: "user", content } };
}

function durableKeyForEvent(eventType: string): ContextKey<SlugMessageMap> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicInstructionsKey;
    case "turn.started":
      return TurnDynamicInstructionsKey;
    default:
      return undefined;
  }
}

/**
 * Builds the flattened system messages from session + turn durable keys.
 * Session-scoped entries appear first.
 */
export function buildDynamicInstructionMessages(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): SystemModelMessage[] {
  const session = ctx.get(SessionDynamicInstructionsKey) ?? {};
  const turn = ctx.get(TurnDynamicInstructionsKey) ?? {};
  return [...Object.values(session).flat(), ...Object.values(turn).flat()];
}

/** Starts the instructions-only virtual context for one lifecycle preamble. */
export function prepareDynamicInstructionPreamble(
  ctx: AlsContext,
  messages: readonly ModelMessage[],
): void {
  ctx.setVirtualContext(DynamicInstructionResolveMessagesKey, [...messages]);
  ctx.setVirtualContext(PendingDynamicInstructionUserMessagesKey, []);
}

/** Drains user-role results and clears the instructions-only virtual context. */
export function drainDynamicInstructionUserMessages(ctx: AlsContext): ModelMessage[] {
  const messages = [...(ctx.get(PendingDynamicInstructionUserMessagesKey) ?? [])];
  ctx.delete(DynamicInstructionResolveMessagesKey);
  ctx.delete(PendingDynamicInstructionUserMessagesKey);
  return messages;
}

/**
 * Dispatches a stream event to dynamic instruction resolvers.
 *
 * Each resolver's output replaces its own slot (keyed by slug) in the
 * scope-appropriate durable key (session or turn). The tool-loop calls
 * {@link buildDynamicInstructionMessages} to assemble the flattened
 * result for the model call.
 */
export async function dispatchDynamicInstructionEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicInstructionsResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(event.type)) return;

  if (event.type === "turn.started") {
    // A new turn owns a fresh turn-scoped map. Invalid returns and exceptions
    // therefore cannot leak the previous turn's system instructions.
    ctx.set(TurnDynamicInstructionsKey, {});
  }

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const durableKey = durableKeyForEvent(event.type);
  if (durableKey === undefined) return;

  const resolveMessages = ctx.get(DynamicInstructionResolveMessagesKey) ?? messages;
  const pendingUserMessages = ctx.get(PendingDynamicInstructionUserMessagesKey) ?? [];
  const resolveCtx = buildResolveContext(ctx, [...resolveMessages, ...pendingUserMessages]);

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined)
        return { resolver, instruction: undefined };

      if (!isBrandedInstructionsEntry(rawResult)) {
        log.error(
          `Dynamic instructions resolver "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
        );
        return null;
      }

      try {
        return { resolver, instruction: lowerInstruction(rawResult as InstructionsDefinition) };
      } catch (error) {
        log.error(`Dynamic instructions resolver "${resolver.slug}" returned an invalid value.`, {
          error: toErrorMessage(error),
        });
        return null;
      }
    }),
  );

  const durable = { ...ctx.get(durableKey) };

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic instructions resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    const { resolver, instruction } = outcome.value;
    delete durable[resolver.slug];
    if (instruction?.role === "system") {
      durable[resolver.slug] = [instruction.message];
    } else if (instruction?.role === "user") {
      ctx.setVirtualContext(PendingDynamicInstructionUserMessagesKey, [
        ...(ctx.get(PendingDynamicInstructionUserMessagesKey) ?? []),
        instruction.message,
      ]);
    }
  }

  ctx.set(durableKey, durable);
}
