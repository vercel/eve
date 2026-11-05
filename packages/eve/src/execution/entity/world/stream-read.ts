import type { RuntimeWorld } from "#execution/world/runtime-world.js";

// Reading an entity's stream from its World, from any process, until the stream closes. With a
// live read (`streams.get`) it starts at the reader's position, so following a long stream's end
// costs its new chunks; a live read the World ends while the stream is open (a connection's time
// limit) opens again where it stopped. Without one, it pages from the stream's start and polls for
// chunks written after it caught up.

const PAGE = 500;
const POLL_MS = 200;

type LiveRead = NonNullable<RuntimeWorld["streams"]["get"]>;

const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));

const firstIndex = async (from: number, tail: () => Promise<number>) =>
  from < 0 ? Math.max(0, (await tail()) + 1 + from) : from;

export function liveRead(
  world: RuntimeWorld,
  runId: string,
  name: string,
  from: number,
  tail: () => Promise<number>,
  get: LiveRead,
): ReadableStream<Uint8Array> {
  let next: number | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      next ??= await firstIndex(from, tail);
      while (!cancelled) {
        reader ??= (await get(runId, name, next)).getReader();
        const read = await reader.read();
        if (!read.done) {
          next += 1;
          controller.enqueue(read.value);
          return;
        }
        reader = undefined;
        const info = await world.streams.getInfo(runId, name);
        if (info.done && info.tailIndex < next) {
          controller.close();
          return;
        }
        // Ended with nothing new: wait before reading again, rather than spin.
        if (info.tailIndex < next) await pause();
      }
    },
    async cancel() {
      cancelled = true;
      await reader?.cancel().catch(() => {});
    },
  });
}

export function polledRead(
  world: RuntimeWorld,
  runId: string,
  name: string,
  from: number,
  tail: () => Promise<number>,
): ReadableStream<Uint8Array> {
  let next: number | undefined;
  // Where the page holding `next` starts, once a page ran past it: a poll reads from there.
  let cursor: string | undefined;
  let cancelled = false;
  const buffered: Uint8Array[] = [];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      next ??= await firstIndex(from, tail);
      while (!cancelled) {
        const ready = buffered.shift();
        if (ready !== undefined) {
          controller.enqueue(ready);
          return;
        }
        const page = await world.streams.getChunks(runId, name, {
          limit: PAGE,
          ...(cursor !== undefined && { cursor }),
        });
        for (const chunk of page.data)
          if (chunk.index === next) {
            buffered.push(chunk.data);
            next += 1;
          }
        if (page.hasMore && page.cursor !== null) {
          cursor = page.cursor;
          continue;
        }
        if (buffered.length > 0) continue;
        if (page.done) {
          controller.close();
          return;
        }
        await pause();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
