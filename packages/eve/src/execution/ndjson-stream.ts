export function parseNdjsonStream<T>(
  createByteStream: () => ReadableStream<Uint8Array>,
  parse: (value: unknown) => T = (value) => value as T,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  return new ReadableStream<T>({
    start() {
      reader = createByteStream().getReader();
    },
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader!.read();

          if (cancelled) return;

          if (done) {
            buffer += decoder.decode();
            const trailing = buffer.trim();
            if (trailing.length > 0) {
              controller.enqueue(parse(JSON.parse(trailing)));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          let enqueued = false;
          for (
            let newlineIndex = buffer.indexOf("\n");
            newlineIndex !== -1;
            newlineIndex = buffer.indexOf("\n")
          ) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
              controller.enqueue(parse(JSON.parse(line)));
              enqueued = true;
            }
          }
          if (enqueued) return;
        }
      } catch (error) {
        if (cancelled) return;
        controller.error(error);
        await reader!.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason);
    },
  });
}
