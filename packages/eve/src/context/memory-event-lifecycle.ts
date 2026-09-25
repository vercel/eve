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

const log = createLogger("memory");

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
    return await dispatchMemoryTurnStarted({
      abortSignal: input.abortSignal,
      appRoot: input.appRoot,
      ctx: input.ctx,
      event: input.event,
      instrumentation: input.instrumentation,
      memories: input.memories,
      nodeId: input.nodeId,
    });
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
    messages = await dispatchMemoryCompactionCompleted({
      abortSignal: input.abortSignal,
      ctx: input.ctx,
      event: input.event,
      instrumentation: input.instrumentation,
      memories: input.memories,
      messages,
    });
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
