import { callAdapterEventHandler } from "#channel/adapter.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { contextStorage } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { createLogger } from "#internal/logging.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.session.initialize");

/** Initialization has no harness state, but the accepting channel can still report failure. */
export async function notifyInitializationFailure(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly event: MessageStreamEvent;
}): Promise<void> {
  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.get(ChannelKey);
    if (adapter === undefined) return;
    await contextStorage.run(ctx, () =>
      callAdapterEventHandler(adapter, input.event, buildAdapterContext(adapter, ctx)),
    );
  } catch (error) {
    log.error("Could not notify the channel of session initialization failure", { error });
  }
}
