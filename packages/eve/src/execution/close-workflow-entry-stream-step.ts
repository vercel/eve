/** Closes a workflow entry's durable stream when no terminal event is emitted. */
export async function closeWorkflowEntryStreamStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";

  const writer = input.parentWritable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
