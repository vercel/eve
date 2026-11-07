import { defineEval } from "eve/evals";
import { randomUUID } from "node:crypto";

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
    for (const round of [0, 1, 2]) {
      const key = `${randomUUID()}/cross`;
      t.log(`cross ${round} read ${await get(`/fixture-blob-probe/step?step=read&key=${key}`)}`);
      const results = await Promise.all([
        get(`/fixture-blob-probe/step?step=write&key=${key}`),
        ...[0, 1, 2].map(() =>
          get(`/fixture-blob-probe/step?step=poll&since=${Date.now()}&key=${key}`),
        ),
      ]);
      for (const line of results) t.log(`cross ${round} ${line}`);
    }
  },
});
