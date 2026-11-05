import type { SessionLineStore } from "#execution/session-line-store.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { sessionLinesStream, sessionRunId } from "#execution/world/session-runs.js";

// A session's stream read from its World, for a process that may not be running it: the World
// host's readers follow a session there, whichever process a wake reached. A reader polls for
// lines written after it caught up, until the stream closes.

const PAGE = 500;

export function worldLineStore(
  world: RuntimeWorld,
  options: { readonly pollMs?: number } = {},
): SessionLineStore {
  const pollMs = options.pollMs ?? 200;
  const tail = async (sessionId: string): Promise<number> =>
    (await world.streams.getInfo(sessionRunId(sessionId), sessionLinesStream(sessionId))).tailIndex;
  return {
    tail,
    async assertReadable() {},
    readable(sessionId, startIndex = 0) {
      const runId = sessionRunId(sessionId);
      const name = sessionLinesStream(sessionId);
      let next: number | undefined;
      // Where the page holding `next` starts, once a page ran past it: a poll reads from there.
      let cursor: string | undefined;
      let cancelled = false;
      const buffered: Uint8Array[] = [];
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          next ??=
            startIndex < 0 ? Math.max(0, (await tail(sessionId)) + 1 + startIndex) : startIndex;
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
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        },
        cancel() {
          cancelled = true;
        },
      });
    },
  };
}
