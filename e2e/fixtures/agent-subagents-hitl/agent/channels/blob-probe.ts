import { defineChannel, GET } from "eve/channels";
import { vercelBlob } from "eve/memory/file/vercel";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * PROBE, do not merge: whether a Vercel Blob path that was read as missing stays missing after it
 * is created. `held-call-does-not-block-others` saw a reader get null for 29 s after another
 * instance created a path that reader had read as missing first.
 */
const store = vercelBlob({ prefix: "eve/e2e/agent-subagents-hitl/blob-probe" });
const INSTANCE = randomUUID().slice(0, 8);

const read = async (key: string) =>
  (await store.read({ key, signal: AbortSignal.timeout(10_000) })) === null ? "null" : "found";
const write = (key: string) =>
  store.write({ content: "x", expectedVersion: null, key, signal: AbortSignal.timeout(10_000) });

/** Polls `key` every 200 ms until found or `limitMs`; returns ms from `since` to the first find. */
async function poll(key: string, since: number, limitMs: number) {
  let reads = 0;
  for (;;) {
    reads += 1;
    if ((await read(key)) === "found") return { foundAfterMs: Date.now() - since, reads };
    if (Date.now() - since > limitMs) return { foundAfterMs: null, reads };
    await sleep(200);
  }
}

export default defineChannel({
  routes: [
    // One instance: read missing, create, poll. Control: create without reading first, poll.
    GET("/fixture-blob-probe/same", async () => {
      const run = randomUUID();
      const readFirst = `${run}/read-first`;
      const control = `${run}/control`;
      const firstRead = await read(readFirst);
      await write(readFirst);
      const readFirstResult = await poll(readFirst, Date.now(), 35_000);
      await write(control);
      const controlResult = await poll(control, Date.now(), 35_000);
      return Response.json({
        control: controlResult,
        firstRead,
        instance: INSTANCE,
        readFirst: readFirstResult,
        region: process.env.VERCEL_REGION ?? null,
      });
    }),
    // Reads `key` once (missing), then keeps polling on this same instance while a separate
    // request writes it. Reports this instance so the eval can compare it with the writer's.
    GET("/fixture-blob-probe/read-then-poll", async (request) => {
      const key = new URL(request.url).searchParams.get("key")!;
      const firstReadAt = Date.now();
      const firstRead = await read(key);
      return Response.json({
        firstRead,
        firstReadAt,
        instance: INSTANCE,
        ...(await poll(key, firstReadAt, 35_000)),
      });
    }),
    GET("/fixture-blob-probe/write", async (request) => {
      const key = new URL(request.url).searchParams.get("key")!;
      await write(key);
      return Response.json({ instance: INSTANCE, writtenAt: Date.now() });
    }),
  ],
});
