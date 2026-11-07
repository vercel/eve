import type { SessionStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

/** Not a test: logs how Vercel Blob answers reads of a key around its first write. */
export default defineEval({
  description: "Probe: Vercel Blob read-after-write across sessions.",
  tags: ["probe"],
  timeoutMs: 120_000,
  async test(t) {
    const key = `probe-${crypto.randomUUID()}`;
    const run = async (step: string) => {
      const session = await t.session();
      await session.start(`BLOB-PROBE ${JSON.stringify({ key, step })}`);
      const reader = t.target.attach(session.id, { startIndex: 0 });
      await reader
        .watch({
          until: (event: SessionStreamEvent) => {
            if (event.type === "content.completed" && event.data.kind === "text") {
              t.log(`${step} ${String(event.data.value)}`);
            }
            return event.type === "turn.settled";
          },
        })
        .result();
    };
    await run("read-missing");
    await run("write");
    await run("poll");
  },
});
