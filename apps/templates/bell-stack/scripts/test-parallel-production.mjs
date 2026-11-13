import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

assert.equal(process.env.BELL_LIVE_PARALLEL, "1", "Set BELL_LIVE_PARALLEL=1 to run this live production-build test.");
for (const name of ["OPENAI_API_KEY", "PARALLEL_API_KEY", "BROWSERBASE_API_KEY"]) assert.ok(process.env[name], `${name} is required`);
const directory = await mkdtemp(path.join(tmpdir(), "bell-production-test-"));
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", BELL_OPERATOR_USERNAME: "regression", BELL_OPERATOR_PASSWORD: randomBytes(32).toString("hex"), BELL_TEST_REQUIRE_AUTH: "1", BELL_TEST_ORIGIN: origin, BELL_CONTEXT_METADATA_PATH: path.join(directory, "contexts.json"), BROWSERBASE_CONTEXT_ID: "", ONEPASSWORD_ENABLED: "false", STAGEHAND_BROWSER: "browserbase" };
delete env.BELL_TEST_PROTECTION_BYPASS;
const routes = JSON.parse(await readFile(".next/routes-manifest.json", "utf8"));
const agentOrigin = new URL(routes.rewrites.beforeFiles.find(route => route.source === "/eve/v1/:path+").destination);
assert.ok(agentOrigin.protocol === "http:" && agentOrigin.hostname === "127.0.0.1" && agentOrigin.port, "Production test requires a build with a loopback Eve rewrite.");
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(Number(agentOrigin.port), "127.0.0.1", resolve); });
await new Promise(resolve => reservation.close(resolve));
const log = await open(path.join(directory, "server.log"), "w", 0o600);
const eve = JSON.parse(await readFile("node_modules/eve/package.json", "utf8")).bin.eve;
const children = [];
function launch(args) {
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", log.fd, log.fd] });
  const stopped = new Promise(resolve => child.once("exit", resolve));
  children.push({ child, stopped });
  return child;
}
async function ready(child, url) {
  const deadline = Date.now() + 60_000;
  while (true) {
    assert.equal(child.exitCode, null, "Production service exited during startup");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* Wait for the owned service to bind. */ }
    assert.ok(Date.now() < deadline, "Production service did not become ready");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
try {
  const agent = launch([path.join("node_modules/eve", eve), "start", "--host", "127.0.0.1", "--port", agentOrigin.port]);
  await ready(agent, `${agentOrigin.origin}/eve/v1/health`);
  const server = launch(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)]);
  await ready(server, origin);
  const test = spawn(process.execPath, ["scripts/test-parallel-research.mjs"], { env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { test.once("error", reject); test.once("exit", resolve); });
  assert.equal(code, 0, "Production-build browser E2E failed");
  console.log("Production-build authentication and browser E2E passed on loopback; this does not certify a hosted staging deployment.");
} finally {
  for (const { child, stopped } of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const timeout = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000);
    await stopped;
    clearTimeout(timeout);
  }
  await log.close();
  console.log(`Production service log: ${path.join(directory, "server.log")}`);
}
