export const ACP_MAX_LINE_BYTES = 10 * 1024 * 1024;

export function limitAcpLineBytes(
  maximumBytes: number = ACP_MAX_LINE_BYTES,
): TransformStream<Uint8Array, Uint8Array> {
  let currentLineBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          currentLineBytes = 0;
          continue;
        }
        currentLineBytes += 1;
        if (currentLineBytes > maximumBytes) {
          controller.error(new Error(`ACP message exceeds the ${maximumBytes}-byte line limit.`));
          return;
        }
      }
      controller.enqueue(chunk);
    },
  });
}
