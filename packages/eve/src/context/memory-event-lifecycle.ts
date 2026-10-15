import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import {
  dispatchMemoryCompactionCompleted,
  dispatchMemoryCompactionRequested,
  dispatchMemoryTurnCompleted,
  dispatchMemoryTurnStarted,
} from "#context/memory-lifecycle.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import type { MemoryInstrumentation } from "#instrumentation/memory.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("memory");

/** A memory recall failed: the turn fails and the session waits, so the next message can retry. */
export class MemoryRecallError extends Error {
  override readonly name = "MemoryRecallError";

  constructor(error: unknown) {
    super(toErrorMessage(error), { cause: error });
  }
}

export async function dispatchMemoryLifecycleEvent(input: {
  readonly abortSignal?: AbortSignal;
  readonly appRoot: string;
  readonly ctx: AlsContext;
  readonly event: UnstampedMessageStreamEvent;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages?: readonly ModelMessage[];
  readonly nodeId: string;
  readonly instrumentation?: MemoryInstrumentation;
}): Promise<readonly ModelMessage[]> {
  let messages = input.messages ?? [];
  if (input.memories.length === 0) return messages;

  if (input.event.type === "turn.started") {
    try {
      return await dispatchMemoryTurnStarted({
        abortSignal: input.abortSignal,
        appRoot: input.appRoot,
        ctx: input.ctx,
        event: input.event,
        instrumentation: input.instrumentation,
        memories: input.memories,
        nodeId: input.nodeId,
      });
    } catch (error) {
      throw new MemoryRecallError(error);
    }
  }
  if (input.event.type === "compaction.requested") {
    await dispatchMemoryCompactionRequested({
      abortSignal: input.abortSignal,
      appRoot: input.appRoot,
      ctx: input.ctx,
      event: input.event,
      instrumentation: input.instrumentation,
      memories: input.memories,
      messages,
      nodeId: input.nodeId,
    });
  } else if (input.event.type === "compaction.completed") {
    try {
      messages = await dispatchMemoryCompactionCompleted({
        abortSignal: input.abortSignal,
        ctx: input.ctx,
        event: input.event,
        instrumentation: input.instrumentation,
        memories: input.memories,
        messages,
      });
    } catch (error) {
      throw new MemoryRecallError(error);
    }
  } else if (input.event.type === "turn.completed" && input.messages !== undefined) {
    try {
      await dispatchMemoryTurnCompleted({
        abortSignal: input.abortSignal,
        ctx: input.ctx,
        event: input.event,
        instrumentation: input.instrumentation,
        memories: input.memories,
        messages,
      });
    } catch (error) {
      log.error("Completed-turn memory capture failed.", { error });
    }
  }
  return messages;
}
