import assert from "node:assert/strict";
import test from "node:test";

import { loadSlackCanvas } from "../extension/lib/canvas.ts";

const fileUrl = "https://files.slack.com/files-pri/T123-F123/canvas";
const fileInfo = (url: string) =>
  Response.json({ ok: true, file: { id: "F123", url_private: url } });

test("loads the configured canvas as text without including scripts or markup", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    return request.url === fileUrl
      ? new Response(
          "<h1>Guidance</h1><script>hidden</script><ul><li>Draft PRs &amp; ask first</li></ul>",
        )
      : fileInfo(fileUrl);
  });

  assert.match(
    (await loadSlackCanvas("F123", "test-token")) ?? "",
    /^Guidance\s+- Draft PRs & ask first$/u,
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    ["https://slack.com/api/files.info?file=F123", fileUrl],
  );
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), "Bearer test-token");
    assert.equal(request.redirect, "error");
  }
});

test("does not forward Slack credentials to an untrusted download host", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    fileInfo("https://files.slack.com.example.org/canvas"),
  );

  assert.equal(await loadSlackCanvas("F123", "test-token"), null);
  assert.equal(fetch.mock.callCount(), 1);
});

test("drops an oversized download instead of injecting partial instructions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) =>
    url.href === fileUrl ? new Response("a".repeat(256 * 1024 + 1)) : fileInfo(fileUrl),
  );

  assert.equal(await loadSlackCanvas("F123", "test-token"), null);
});
