import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const fixtureRoot = process.cwd();
const appRoot = mkdtempSync(join(tmpdir(), "eve-a2a-consumer-"));
const logPath = join(fixtureRoot, "verify.log");
for (const path of ["agent", "package.json", "tsconfig.json"])
  cpSync(join(fixtureRoot, path), join(appRoot, path), { recursive: true });
mkdirSync(join(appRoot, "node_modules", "@eve", "a2a"), { recursive: true });
for (const entry of readdirSync(join(fixtureRoot, "node_modules"))) {
  if (entry.startsWith(".") || entry === "@eve") continue;
  symlinkSync(
    join(fixtureRoot, "node_modules", entry),
    join(appRoot, "node_modules", entry),
    "junction",
  );
}
// Only the distribution is available to this consumer; no extension source can mask a missing export.
for (const path of ["dist", "package.json"])
  cpSync(
    resolve(fixtureRoot, "../../../packages/eve-a2a", path),
    join(appRoot, "node_modules", "@eve", "a2a", path),
    { recursive: true },
  );

const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
reservation.close();
await once(reservation, "close");
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, A2A_ORIGIN: origin, A2A_REMOTE_ORIGIN: origin };
const cli = "node_modules/eve/bin/eve.js";
writeFileSync(logPath, "");

function run(args) {
  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => appendFileSync(logPath, data));
  return child;
}
async function finish(args) {
  const child = run(args);
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${args.join(" ")} failed; see verify.log`);
}
async function eventually(read, accept, label) {
  const deadline = Date.now() + 45_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error(`${label}: ${JSON.stringify(value).slice(-3000)}`);
}
let server;
async function startServer() {
  server = run([cli, "start", "--host", "127.0.0.1", "--port", String(port)]);
  await eventually(
    async () => {
      if (server.exitCode !== null) throw new Error("Server exited; see verify.log");
      try {
        return (await fetch(`${origin}/.well-known/agent-card.json`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    "server readiness",
  );
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}
const headers = {
  authorization: `Basic ${Buffer.from(`alice:${env.A2A_DEMO_PASSWORD ?? "prototype-only"}`).toString("base64")}`,
  "content-type": "application/json",
  "a2a-version": "1.0",
};
async function rpc(method, params) {
  const response = await fetch(`${origin}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body));
  return body.result;
}
async function events(id) {
  return (await fetch(`${origin}/demo/${id}/events`, { headers })).json();
}

try {
  await finish([cli, "build"]);
  console.log("PASS extension distribution builds in an isolated consumer");
  await startServer();
  await finish([join(fixtureRoot, "scripts/smoke.mjs")]);
  console.log("PASS HTTP and authored-tool scenarios (details in verify.log)");
  const { task } = await rpc("SendMessage", {
    message: {
      messageId: crypto.randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "REMOTE wait 12" }],
    },
    configuration: { returnImmediately: true },
  });
  const parent = await (
    await fetch(`${origin}/demo`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: `CALL ${JSON.stringify({ tool: "a2a_delegate", input: { taskId: task.id } })}`,
      }),
    })
  ).json();
  await eventually(
    () => events(parent.id),
    (list) => JSON.stringify(list).includes("A2A remote task"),
    "watcher starts",
  );
  const before = await rpc("GetTask", { id: task.id });
  assert.equal(before.status.state, "TASK_STATE_WORKING");
  await stopServer();
  await startServer();
  const completed = await eventually(
    () => rpc("GetTask", { id: task.id }),
    (task) => task.status.state === "TASK_STATE_COMPLETED",
    "remote task resumes",
  );
  assert.equal(completed.id, task.id);
  assert.match(JSON.stringify(completed.artifacts), /12/);
  const received = await eventually(
    () => events(parent.id),
    (list) => JSON.stringify(list).includes("TASK_STATE_COMPLETED"),
    "watcher resumes",
  );
  const starts = received.filter(
    (event) =>
      event.type === "actions.requested" &&
      event.data.actions.some((action) => action.toolName === "a2a_delegate"),
  );
  assert.equal(starts.length, 1);
  console.log("PASS server restart: same remote task and existing workflow watcher resume");
} finally {
  await stopServer();
  rmSync(appRoot, { recursive: true, force: true });
}
