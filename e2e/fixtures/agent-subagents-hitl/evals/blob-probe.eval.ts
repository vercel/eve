import { defineEval } from "eve/evals";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/** PROBE, do not merge: see agent/channels/blob-probe.ts. Logs results; asserts nothing. */
export default defineEval({
  description: "PROBE: Vercel Blob visibility of a path read as missing before it was created.",
  tags: ["probe"],
  timeoutMs: 200_000,
  async test(t) {
    const get = async (path: string) => {
      const response = await t.target.fetch(path);
      return `${response.status} ${await response.text()}`;
    };
    t.log(`same ${await get("/fixture-blob-probe/same")}`);
    // The reader holds its poll on the instance that read the path as missing; the writer is a
    // separate request, which may land on another instance. Only rounds whose instances differ
    // test the cross-instance case; both IDs are logged.
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (round) => {
        const key = `${randomUUID()}/cross`;
        const reader = get(`/fixture-blob-probe/read-then-poll?key=${key}`);
        await sleep(1_500);
        const writer = await get(`/fixture-blob-probe/write?key=${key}`);
        t.log(`cross ${round} writer ${writer}`);
        t.log(`cross ${round} reader ${await reader}`);
      }),
    );
  },
});
