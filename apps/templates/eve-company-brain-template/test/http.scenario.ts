import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/eve/bin/eve.js", import.meta.url));

test("HTTP routes reject visitors even with development enabled", { timeout: 60_000 }, async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));

  // Use the built app so this test does not compete with a developer's active source watcher.
  const server = spawn(
    process.execPath,
    [cli, "start", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, EVE_DEV: "1", COMPANY_BRAIN_HTTP_PASSWORD: "scenario-password" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const collect = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-16_384);
  };
  server.stdout.on("data", collect);
  server.stderr.on("data", collect);
  const closed = once(server, "close");
  const url = `http://127.0.0.1:${port}/eve/v1`;

  try {
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
        ready = response.ok;
        await response.text();
        if (ready) break;
      } catch {
        // Startup probes can fail before the HTTP listener is ready.
      }
      await delay(100);
    }
    assert.ok(ready, `HTTP test server did not start: ${logs}`);

    const rejectedHeaders: Record<string, string>[] = [
      {},
      { "x-forwarded-host": "public.example", "x-forwarded-for": "127.0.0.1", host: "localhost" },
      { authorization: `Basic ${Buffer.from("company-brain:wrong-password").toString("base64")}` },
    ];
    for (const headers of rejectedHeaders) {
      const info = await fetch(`${url}/info`, { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(info.status, 401);
      assert.match(info.headers.get("www-authenticate") ?? "", /Basic/);
      await info.text();
      const session = await fetch(`${url}/session`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ input: "Summarize the available order data." }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(session.status, 401);
      await session.text();
    }

    const operator = await fetch(`${url}/info`, {
      headers: {
        authorization: `Basic ${Buffer.from("company-brain:scenario-password").toString("base64")}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(operator.status, 200);
    await operator.text();
  } finally {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 5_000);
    try {
      await closed;
    } finally {
      clearTimeout(forceKill);
    }
  }
});
