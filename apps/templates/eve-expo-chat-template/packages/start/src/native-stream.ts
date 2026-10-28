import type { SessionStreamEvent } from "eve/client";
import type { ReplyDelta } from "./relay-protocol.ts";
/** Observe one recorded turn without cancelling its execution when this reader disconnects. */
export async function* nativeReply(
  stream: { getReader(): ReadableStreamDefaultReader<SessionStreamEvent> },
  deadline: number,
  turnId?: string,
): AsyncGenerator<ReplyDelta> {
  const reader = stream.getReader();
  const calls = new Map<string, { name: string; status: string }>();
  const parts = new Map<string, { kind: string; text: string }>();
  let lastPart: string | undefined;
  function activity(
    id: string,
    name: string | undefined,
    status: "preparing" | "running" | "completed" | "failed" | "interrupted",
  ): ReplyDelta[] {
    if (!id || !name) return [];
    const previous = calls.get(id);
    if (previous?.status === status || (status === "preparing" && previous)) return [];
    if (!previous && calls.size >= 100) return [];
    calls.set(id, { name, status });
    return [{ type: "tool", id: id.slice(0, 200), name: name.slice(0, 200), status }];
  }
  function finishCalls(): ReplyDelta[] {
    return [...calls].flatMap(([id, call]) =>
      call.status === "running" || call.status === "preparing"
        ? activity(id, call.name, "interrupted")
        : [],
    );
  }
  function text(
    partId: string,
    kind: string | undefined,
    value: string,
    complete: boolean,
  ): string[] {
    const part = parts.get(partId) || { kind: kind || "", text: "" };
    if (!parts.has(partId) && parts.size >= 1000)
      throw Error("Too many content parts in one response");
    if (kind) part.kind = kind;
    parts.set(partId, part);
    if (part.kind !== "text") return [];
    if (complete && !value.startsWith(part.text))
      throw Error("Committed text differs from streamed text");
    const delta = complete ? value.slice(part.text.length) : value;
    part.text += delta;
    if (part.text.length > 1_000_000) throw Error("Response content part is too large");
    if (!delta) return [];
    const chunks = lastPart && lastPart !== partId ? ["\n\n", delta] : [delta];
    lastPart = partId;
    return chunks;
  }
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Native response observation timed out; it will resume without repeating the action.",
                ),
              ),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (done) throw Error("eve response ended before the turn completed");
      const owner = value.scope?.turnId || ("turnId" in value.data ? value.data.turnId : undefined);
      if (turnId && owner !== turnId) continue;
      switch (value.type) {
        case "call.input":
          if (value.data.kind !== "control")
            yield* activity(value.data.callId, value.data.name, "preparing");
          break;
        case "call.requested":
          if (value.data.capability.kind !== "control")
            yield* activity(value.data.callId, value.data.capability.name, "preparing");
          break;
        case "call.started":
          yield* activity(value.data.callId, calls.get(value.data.callId)?.name, "running");
          break;
        case "call.settled":
          yield* activity(
            value.data.callId,
            calls.get(value.data.callId)?.name,
            value.data.outcome === "completed"
              ? "completed"
              : value.data.outcome === "interrupted" || value.data.outcome === "abandoned"
                ? "interrupted"
                : "failed",
          );
          break;
        case "content.delta":
          yield* text(value.data.partId, value.data.kind, value.data.delta, false);
          break;
        case "content.completed":
          if (typeof value.data.value === "string")
            yield* text(value.data.partId, value.data.kind, value.data.value, true);
          break;
        case "turn.paused":
          yield* finishCalls();
          if (!lastPart)
            yield "The agent is waiting for input. Open the eve session to answer the pending request.";
          return;
        case "turn.settled":
          yield* finishCalls();
          if (value.data.outcome === "failed")
            yield "\n\nThe agent could not finish this turn. You can send another message.";
          if (value.data.outcome === "cancelled") yield "\n\nStopped.";
          return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
