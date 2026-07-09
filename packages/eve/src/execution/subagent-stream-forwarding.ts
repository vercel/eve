import type { ForwardedSubagentStream } from "#channel/types.js";
import {
  createSubagentChildEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
  type HandleMessageStreamEvent,
  type TimedHandleMessageStreamEvent,
} from "#protocol/message.js";

/**
 * Writes one event to its owning session stream and, for delegated child runs,
 * mirrors the same timed event into the parent stream as `subagent.event`.
 */
export async function writeSessionEvent(input: {
  readonly event: HandleMessageStreamEvent;
  readonly forwardedSubagentStream?: ForwardedSubagentStream;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<TimedHandleMessageStreamEvent> {
  const timedEvent = timestampHandleMessageStreamEvent(input.event);
  await input.writer.write(encodeMessageStreamEvent(timedEvent));

  if (input.forwardedSubagentStream !== undefined) {
    const forwardedWriter = input.forwardedSubagentStream.parentWritable.getWriter();
    try {
      await forwardedWriter.write(
        encodeMessageStreamEvent(
          timestampHandleMessageStreamEvent(
            createSubagentChildEvent({
              callId: input.forwardedSubagentStream.callId,
              event: timedEvent,
              subagentName: input.forwardedSubagentStream.subagentName,
            }),
          ),
        ),
      );
    } finally {
      forwardedWriter.releaseLock();
    }
  }

  return timedEvent;
}
