import type { ForwardedSubagentStream } from "#channel/types.js";
import {
  createSubagentChildEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

/**
 * Writes one event to its owning session stream and, for delegated child runs,
 * mirrors the same stamped event into the parent stream as `subagent.event`.
 */
export async function writeSessionEvent(input: {
  readonly event: UnstampedMessageStreamEvent;
  readonly forwardedSubagentStream?: ForwardedSubagentStream;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<MessageStreamEvent> {
  const stampedEvent = stampMessageStreamEvent(input.event);
  await input.writer.write(encodeMessageStreamEvent(stampedEvent));

  if (input.forwardedSubagentStream !== undefined) {
    const forwardedWriter = input.forwardedSubagentStream.parentWritable.getWriter();
    try {
      await forwardedWriter.write(
        encodeMessageStreamEvent(
          stampMessageStreamEvent(
            createSubagentChildEvent({
              callId: input.forwardedSubagentStream.callId,
              event: stampedEvent,
              subagentName: input.forwardedSubagentStream.subagentName,
            }),
          ),
        ),
      );
    } finally {
      forwardedWriter.releaseLock();
    }
  }

  return stampedEvent;
}
