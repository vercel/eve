/**
 * Closes a session's durable stream when its run ends without the terminal publication closing
 * it: a session a turn ended, or a run that lost its continuation claim. Readers then reach the
 * stream's end, and the route tells them with `stream.ended`. Never throws: a stream already
 * closed stays closed.
 */
export async function closeSessionStreamStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";

  try {
    const writer = input.sessionWritable.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  } catch {
    // Already closed, or closing: nothing more to end.
  }
}
