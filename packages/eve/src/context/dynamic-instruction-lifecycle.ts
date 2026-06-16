import type { ModelMessage, SystemModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  isBrandedInstructionsEntry,
} from "#shared/dynamic-tool-definition.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import { SessionDynamicInstructionsKey, TurnDynamicInstructionsKey } from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-instructions");

type SlugMessageMap = Record<string, readonly SystemModelMessage[]>;

function lowerToSystemMessage(definition: InstructionsDefinition): SystemModelMessage | undefined {
  const trimmed = definition.markdown.trim();
  if (trimmed.length === 0) return undefined;
  return { role: "system", content: trimmed };
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
  readonly event: HandleMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const durableKey = durableKeyForEvent(event.type);
  if (durableKey === undefined) return;

  const resolveCtx = buildResolveContext(ctx, messages);

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, message: undefined };

      if (!isBrandedInstructionsEntry(rawResult)) {
        log.error(
          `Dynamic instructions resolver "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
        );
        return null;
      }

      return { resolver, message: lowerToSystemMessage(rawResult as InstructionsDefinition) };
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

    const { resolver, message } = outcome.value;
    if (message !== undefined) {
      durable[resolver.slug] = [message];
    } else {
      delete durable[resolver.slug];
    }
  }

  ctx.set(durableKey, durable);
}
