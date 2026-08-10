import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";

import type { BenchmarkWorld, WorldEvent } from "../types.js";

const WORLD_PORT = 4317;
const EVENT_LOG = "/tmp/eve-authoring-benchmark-events.jsonl";
const STATE_FILE = "/tmp/eve-authoring-benchmark-state.json";
const SERVER_LOG = "/tmp/eve-authoring-photon-world.log";
const VERCEL_SHIM = "/usr/local/bin/vercel";
const BROWSER_SHIM = "/usr/local/bin/xdg-open";

export interface PhotonWorldOptions {
  readonly phoneNumber: string;
  readonly assignedPhoneNumber: string;
  readonly projectId: string;
  readonly projectSecret: string;
}

/**
 * Creates a Photon/Vercel setup world without adding provider-specific hooks to eve.
 *
 * Photon traffic is redirected by one sandbox-wide Node preload. Vercel and
 * browser interactions cross process boundaries, so sandbox-local executable
 * shims record them and return deterministic fixture responses.
 */
export function createPhotonWorld(options: PhotonWorldOptions): BenchmarkWorld {
  let sandbox: HarnessV1NetworkSandboxSession | undefined;
  const env = {
    NODE_OPTIONS: "--import=/tmp/eve-authoring-benchmark-network.mjs",
    EVE_DEV_OFFICIAL_REGISTRY_URL: "http://127.0.0.1:4173/r",
    VERCEL_ORG_ID: "team-id",
    VERCEL_PROJECT_ID: "project-id",
    EVE_AUTHORING_BENCHMARK: "1",
  } as const;

  return {
    id: "photon",
    env,
    allowedHosts: ["app.photon.codes", "spectrum.photon.codes"],
    async bootstrap({ sandbox: bootstrapSandbox }) {
      await Promise.all([
        bootstrapSandbox.writeTextFile({
          path: "/tmp/eve-authoring-photon-world.mjs",
          content: photonServerSource(),
        }),
        bootstrapSandbox.writeTextFile({
          path: "/tmp/eve-authoring-benchmark-network.mjs",
          content: networkInterceptorSource(),
        }),
        bootstrapSandbox.writeTextFile({
          path: VERCEL_SHIM,
          content: vercelShimSource(),
        }),
        bootstrapSandbox.writeTextFile({
          path: BROWSER_SHIM,
          content: browserShimSource(),
        }),
      ]);
      const setup = await bootstrapSandbox.run({
        command: `chmod +x ${VERCEL_SHIM} ${BROWSER_SHIM}`,
      });
      if (setup.exitCode !== 0) throw new Error(setup.stderr || setup.stdout);
    },
    async install(input) {
      sandbox = input.sandbox;
      await input.sandbox.writeTextFile({
        path: STATE_FILE,
        content: JSON.stringify({ ...options, tokenPolls: 0 }),
      });
      const setup = await input.sandbox.run({
        command: ": > /tmp/eve-authoring-benchmark-events.jsonl",
      });
      if (setup.exitCode !== 0) throw new Error(setup.stderr || setup.stdout);

      const start = await input.sandbox.run({
        command: `nohup node /tmp/eve-authoring-photon-world.mjs >${SERVER_LOG} 2>&1 &`,
      });
      if (start.exitCode !== 0) throw new Error(start.stderr || start.stdout);
      await waitForHealth(input.sandbox);
    },
    async events() {
      if (sandbox === undefined) return [];
      const raw = await sandbox.readTextFile({ path: EVENT_LOG });
      if (raw === null || raw.trim() === "") return [];
      return raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as WorldEvent);
    },
    async dispose() {},
  };
}

async function waitForHealth(sandbox: HarnessV1NetworkSandboxSession): Promise<void> {
  let lastHealth = "health probe did not run";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await sandbox.run({
      command: `node -e ${shellQuote(`fetch("http://127.0.0.1:${WORLD_PORT}/health").then(async r => { if (!r.ok) throw new Error(String(r.status) + " " + await r.text()) }).catch(error => { console.error(error); process.exit(1) })`)}`,
      env: { NODE_OPTIONS: "" },
    });
    if (result.exitCode === 0) return;
    lastHealth = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const serverLog = await sandbox.readTextFile({ path: SERVER_LOG });
  throw new Error(
    [
      "Photon benchmark world did not become healthy.",
      `Last health probe: ${lastHealth}`,
      `Server log:\n${serverLog?.trim() || "<empty>"}`,
    ].join("\n\n"),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function networkInterceptorSource(): string {
  return String.raw`const nativeFetch = globalThis.fetch;
globalThis.fetch = async function benchmarkFetch(input, init) {
  const request = input instanceof Request ? input : undefined;
  const original = new URL(request?.url ?? String(input));
  if (original.hostname !== "app.photon.codes" && original.hostname !== "spectrum.photon.codes") {
    return nativeFetch(input, init);
  }
  const routed = new URL(original.pathname + original.search, "http://127.0.0.1:${WORLD_PORT}");
  const headers = new Headers(request?.headers ?? init?.headers);
  headers.set("x-eve-benchmark-host", original.host);
  return nativeFetch(routed, {
    method: request?.method ?? init?.method,
    headers,
    body: request?.body ?? init?.body,
    duplex: request?.body ? "half" : init?.duplex,
    signal: request?.signal ?? init?.signal,
  });
};
`;
}

function photonServerSource(): string {
  return String.raw`import { createServer } from "node:http";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const port = ${WORLD_PORT};
const stateFile = ${JSON.stringify(STATE_FILE)};
const eventLog = ${JSON.stringify(EVENT_LOG)};

async function state() { return JSON.parse(await readFile(stateFile, "utf8")); }
async function update(value) { await writeFile(stateFile, JSON.stringify(value)); }
async function record(type, data = {}) {
  await appendFile(eventLog, JSON.stringify({ at: new Date().toISOString(), type, data }) + "\n");
}
function json(response, status = 200) {
  return { status, body: JSON.stringify(response), headers: { "content-type": "application/json" } };
}

createServer(async (request, response) => {
  const originalHost = request.headers["x-eve-benchmark-host"] ?? request.headers.host ?? "";
  const url = new URL(request.url ?? "/", "http://world");
  if (url.pathname === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const data = body ? JSON.parse(body) : undefined;
  await record("http.request", { host: originalHost, method: request.method, path: url.pathname });
  const current = await state();
  let result;
  if (url.pathname === "/api/auth/device/code" && request.method === "POST") {
    await record("photon.authorization.requested", { userCode: "EVE-1234" });
    result = json({
      device_code: "device-code",
      user_code: "EVE-1234",
      verification_uri_complete: "https://app.photon.codes/device?code=EVE-1234",
      expires_in: 60,
      interval: 0.01
    });
  } else if (url.pathname === "/api/auth/device/token" && request.method === "POST") {
    current.tokenPolls += 1;
    await update(current);
    result = current.tokenPolls === 1
      ? json({ error: "authorization_pending" }, 400)
      : json({ access_token: "dashboard-token" });
  } else if (url.pathname === "/api/projects" && request.method === "POST") {
    await record("photon.project.created", { id: current.projectId, name: data?.name });
    result = json({ id: current.projectId });
  } else if (url.pathname === "/api/projects/" + current.projectId + "/regenerate-secret" && request.method === "POST") {
    result = json({ projectSecret: current.projectSecret });
  } else if (url.pathname === "/projects/" + current.projectId + "/users/" && request.method === "POST") {
    await record("photon.phone.registered", { phoneNumber: data?.phoneNumber });
    result = json({ data: { user: { assignedPhoneNumber: current.assignedPhoneNumber } } });
  } else if (url.pathname === "/api/projects/" + current.projectId && request.method === "DELETE") {
    result = json({});
  } else {
    await record("http.unhandled", { host: originalHost, method: request.method, path: url.pathname });
    result = json({ error: "Unhandled benchmark-world request" }, 501);
  }
  response.writeHead(result.status, result.headers).end(result.body);
}).listen(port, "0.0.0.0");
`;
}

function vercelShimSource(): string {
  return String.raw`#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const eventLog = ${JSON.stringify(EVENT_LOG)};
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
await appendFile(eventLog, JSON.stringify({
  at: new Date().toISOString(),
  type: "vercel.command",
  data: { args, stdinBytes: Buffer.byteLength(stdin) }
}) + "\n");
const cwd = process.cwd();
if (args[0] === "whoami") {
  console.log("benchmark-team");
} else if (args[0] === "api") {
  console.log(JSON.stringify({ targets: {} }));
} else if (args[0] === "connect" && args[1] === "create") {
  console.log(JSON.stringify({ id: "connector-id", uid: "photon/benchmark-agent", supportedSubjectTypes: ["app"] }));
} else if (args[0] === "connect" && (args[1] === "attach" || args[1] === "detach")) {
  console.log("ok");
} else if (args[0] === "link") {
  await mkdir(join(cwd, ".vercel"), { recursive: true });
  await writeFile(join(cwd, ".vercel/project.json"), JSON.stringify({ orgId: "team-id", projectId: "project-id", projectName: "benchmark-agent" }));
  console.log("Linked");
} else if (args[0] === "teams" && args[1] === "ls") {
  console.log(JSON.stringify([{ slug: "benchmark-team", name: "Benchmark Team", current: true }]));
} else {
  console.error("Unhandled benchmark vercel command: " + args.join(" "));
  process.exitCode = 2;
}
`;
}

function browserShimSource(): string {
  return String.raw`#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(EVENT_LOG)}, JSON.stringify({
  at: new Date().toISOString(),
  type: "browser.open",
  data: { url: process.argv[2] }
}) + "\n");
`;
}
