import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Detects each generated MCP server's auth strategy by sending one
 * unauthenticated `initialize` request:
 *
 * - a successful MCP response means the server is public (`none`),
 * - a 401/403 with an OAuth challenge (RFC 9728 `WWW-Authenticate` with
 *   `resource_metadata`, or a Bearer scheme) means `oauth`,
 * - a bare 401/403 means credentials are expected (`headers` when the
 *   registry declared them, otherwise `required`),
 * - anything else (timeouts, 5xx, DNS failures) is inconclusive and leaves
 *   the declared hint untouched.
 *
 * Conclusive probes upgrade the record's `authBasis` to "detected". Run after
 * `generate-mcp-directory.mjs`; the catalog is rewritten in place.
 *
 * Run with UV_THREADPOOL_SIZE=64: DNS lookups for the many dead domains in
 * the registry block Node's default 4-thread pool and starve every fetch
 * queued behind them into a timeout.
 */

const CATALOG_PATH = path.join(process.cwd(), "lib", "integrations", "generated-mcp-catalog.json");
const CONCURRENCY = 48;
const TIMEOUT_MS = 8000;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "eve-catalog-probe", version: "0.0.1" },
  },
});

const probe = async (record) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(record.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INITIALIZE_BODY,
      signal: controller.signal,
    });
    response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      if (/resource_metadata|oauth|bearer/i.test(challenge)) return "oauth";
      return record.authHeaders.length > 0 ? "headers" : "required";
    }
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json") || contentType.includes("event-stream")) return "none";
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const records = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
const counts = { none: 0, oauth: 0, headers: 0, required: 0, inconclusive: 0 };

let cursor = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < records.length) {
      const record = records[cursor];
      cursor += 1;
      const detected = await probe(record);
      done += 1;
      if (done % 500 === 0) console.log(`  probed ${done}/${records.length}`);
      if (detected === null) {
        counts.inconclusive += 1;
        continue;
      }
      counts[detected] += 1;
      record.authHint = detected;
      record.authBasis = "detected";
    }
  }),
);

await writeFile(`${CATALOG_PATH}.tmp`, `${JSON.stringify(records)}\n`);
await rename(`${CATALOG_PATH}.tmp`, CATALOG_PATH);

console.log(
  `Probed ${records.length.toLocaleString()} MCP endpoints: ` +
    `${counts.oauth.toLocaleString()} oauth, ${counts.headers.toLocaleString()} headers, ` +
    `${counts.none.toLocaleString()} public, ${counts.required.toLocaleString()} auth-required, ` +
    `${counts.inconclusive.toLocaleString()} inconclusive (declared hint kept)`,
);
