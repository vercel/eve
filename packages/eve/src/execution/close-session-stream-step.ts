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
  } catch {}
}
