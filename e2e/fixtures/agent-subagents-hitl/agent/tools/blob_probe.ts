import { vercelBlob } from "eve/memory/file/vercel";
import { defineTool } from "eve/tools";
import { z } from "zod";

const PREFIX = "eve/e2e/agent-subagents-hitl/blob-probe";
const backend = vercelBlob({ prefix: PREFIX });
const instance = crypto.randomUUID();

const HEADERS = ["x-vercel-cache", "age", "cache-control", "etag", "last-modified", "x-vercel-id"];

/** The private URL the SDK's `get` fetches for `key`, as `vercel-blob.ts` encodes it. */
function blobUrl(key: string): string {
  const store = (process.env.BLOB_STORE_ID ?? "").replace(/^store_/u, "");
  return `https://${store}.private.blob.vercel-storage.com/${PREFIX}/${encodeURIComponent(key)}/MEMORY.md`;
}

async function rawRead(url: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN ?? ""}` },
  });
  const headers = Object.fromEntries(HEADERS.map((name) => [name, response.headers.get(name)]));
  await response.body?.cancel();
  return { status: response.status, headers };
}

async function sdkRead(key: string) {
  const document = await backend.read({ key, signal: AbortSignal.timeout(10_000) });
  return document === null ? null : document.version;
}

/** Records how Vercel Blob answers reads of a key around its first write, for the stale-read probe. */
export default defineTool({
  description: "Probe Vercel Blob read-after-write for one key.",
  inputSchema: z.strictObject({
    key: z.string(),
    step: z.enum(["read-missing", "write", "poll"]),
  }),
  async execute({ key, step }) {
    const at = new Date().toISOString();
    const base = {
      at,
      instance,
      region: process.env.VERCEL_REGION ?? null,
      store: process.env.BLOB_STORE_ID ?? null,
      tokenStore: (process.env.BLOB_READ_WRITE_TOKEN ?? "").split("_")[3] ?? null,
      path: `${PREFIX}/${encodeURIComponent(key)}/MEMORY.md`,
      step,
    };
    const url = blobUrl(key);
    if (step === "write") {
      const written = await backend.write({
        content: "probe",
        expectedVersion: null,
        key,
        signal: AbortSignal.timeout(10_000),
      });
      return { ...base, etag: written.version };
    }
    if (step === "read-missing") {
      return { ...base, sdk: await sdkRead(key), cached: await rawRead(`${url}?cache=0`) };
    }
    const reads = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      reads.push({
        at: new Date().toISOString(),
        sdk: await sdkRead(key),
        cached: await rawRead(`${url}?cache=0`),
        fresh: await rawRead(`${url}?cache=0&probe=${crypto.randomUUID()}`),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ...base, reads };
  },
});
