import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { AuthKey, ParentSessionKey, SessionKey } from "#context/keys.js";
import { createSessionContext } from "#context/providers/session.js";
import { deserializeContext } from "#context/serialize.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import type { HandleEventFn } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.workflow-entry");

type TerminalSessionEvent = Extract<
  UnstampedMessageStreamEvent,
  { type: "session.completed" | "session.failed" }
>;

/** Delivers one out-of-turn terminal event through the native instrumentation lifecycle. */
export async function emitTerminalSessionEvent(input: {
  readonly errorId?: string;
  readonly event: TerminalSessionEvent;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly turnId?: string;
}): Promise<void> {
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  let ctx: ContextContainer | undefined;

  try {
    ctx = await deserializeContext(input.serializedContext);
  } catch (error) {
    log.error(`failed to restore context for terminal ${input.event.type} event`, {
      error,
      errorId: input.errorId,
      sessionId,
    });
  }

  if (ctx !== undefined) {
    ctx.setVirtualContext(
      SessionKey,
      createSessionContext({
        auth: ctx.get(AuthKey) ?? null,
        ctx,
        sessionId,
        turnId: input.turnId,
      }),
    );
  }

  const handleEvent: HandleEventFn = async (event) => {
    if (ctx !== undefined) {
      const adapter = ctx.get(ChannelKey);
      if (adapter !== undefined) {
        try {
          await callAdapterEventHandler(adapter, event, buildAdapterContext(adapter, ctx));
        } catch (error) {
          log.error(`adapter failed to handle terminal ${event.type} event`, {
            error,
            errorId: input.errorId,
            sessionId,
          });
        }
      }
    }

    try {
      const writer = input.sessionWritable.getWriter();
      try {
        const stamped = stampMessageStreamEvent(event);
        await writer.write(encodeMessageStreamEvent(stamped));
        const bundle = ctx?.get(BundleKey);
        if (ctx !== undefined && bundle !== undefined) {
          await dispatchStreamEventHooks({
            ctx,
            event: stamped,
            registry: bundle.hookRegistry,
          });
        }
      } finally {
        writer.releaseLock();
      }
    } catch (error) {
      log.error(`failed to write terminal ${event.type} event to durable stream`, {
        error,
        errorId: input.errorId,
        sessionId,
      });
    }
  };

  let instrumentation: ReturnType<typeof bindSessionInstrumentation>;
  if (ctx !== undefined) {
    try {
      const bundle = ctx.require(BundleKey);
      instrumentation = bindSessionInstrumentation({
        agentName: bundle.turnAgent.id,
        ctx,
        rootSessionId: ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId,
        sessionId,
      });
    } catch (error) {
      log.error(`failed to bind instrumentation for terminal ${input.event.type} event`, {
        error,
        errorId: input.errorId,
        sessionId,
      });
    }
  }

  const emit =
    instrumentation?.createHandleEvent({
      handleEvent,
      turnId: input.turnId,
    }) ?? handleEvent;
  try {
    if (ctx === undefined) {
      await emit(input.event);
    } else {
      await contextStorage.run(ctx, () => emit(input.event));
    }
  } catch (error) {
    log.error(`instrumentation failed to handle terminal ${input.event.type} event`, {
      error,
      errorId: input.errorId,
      sessionId,
    });
  } finally {
    try {
      await instrumentation?.flush();
    } catch (error) {
      log.error(`failed to flush instrumentation after terminal ${input.event.type} event`, {
        error,
        errorId: input.errorId,
        sessionId,
      });
    }
  }
}
