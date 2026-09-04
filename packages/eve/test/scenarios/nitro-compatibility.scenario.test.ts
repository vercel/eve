import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";

const runFile = promisify(execFile);
const scenarioApp = useScenarioApp();

const CHANNEL_SOURCE = `
import { defineChannel, GET, HEAD, WS } from "eve/channels";
import bufferutil from "bufferutil";

let resolutions = 0;
let closes = 0;
let background = false;
let cancelled = false;

export default defineChannel({
  cors: { origin: ["https://allowed.example"], methods: ["GET", "HEAD"] },
  routes: [
    GET("/compat/native", () => {
      const output = Buffer.alloc(4);
      bufferutil.mask(Buffer.from([1, 2, 3, 4]), Buffer.from([1, 1, 1, 1]), output, 0, 4);
      return Response.json([...output]);
    }),
    GET("/compat/params/:value", (request, { params, requestIp }) => Response.json({ params, requestIp, method: request.method })),
    GET("/compat/static", () => new Response("static")),
    GET("/compat/head", (request) => new Response("get-body", { headers: { "x-handler": "GET", "x-method": request.method } })),
    GET("/compat/explicit", () => new Response("get-body", { headers: { "x-handler": "GET" } })),
    HEAD("/compat/explicit", () => new Response(null, { headers: { "x-handler": "HEAD" } })),
    GET("/compat/choice/fixed", () => new Response("get-body", { headers: { "x-handler": "GET" } })),
    HEAD("/compat/choice/:value", () => new Response(null, { headers: { "x-handler": "HEAD" } })),
    GET("/compat/no-fallback", () => new Response("get-body")),
    HEAD("/compat/no-fallback", () => new Response(null, { status: 404 })),
    GET("/compat/error", () => { throw new Error("private-channel-error"); }),
    GET("/compat/background", (_request, { waitUntil }) => {
      waitUntil(new Promise((resolve) => setTimeout(() => { background = true; resolve(); }, 50)));
      return new Response("accepted");
    }),
    GET("/compat/state", () => Response.json({ background, cancelled, resolutions, closes })),
    GET("/compat/stream", (request) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        request.signal.addEventListener("abort", () => { cancelled = true; controller.close(); }, { once: true });
      },
      cancel() { cancelled = true; },
    }))),
    WS("/compat/socket", () => {
      resolutions++;
      return {
        upgrade(request) {
          if (request.headers.get("authorization") !== "Bearer scenario") return new Response("Unauthorized", { status: 401 });
          return { protocol: "eve.test", headers: { "x-upgrade": "preserved" }, context: { authenticated: true } };
        },
        open(peer) { peer.send(JSON.stringify({ type: "open", authenticated: peer.context.authenticated, resolutions })); },
        ping(peer, data) { peer.send("ping:" + new TextDecoder().decode(data)); },
        pong(peer, data) { peer.send("pong:" + new TextDecoder().decode(data)); },
        drain(peer) { peer.context.drains = (peer.context.drains ?? 0) + 1; },
        error(peer, error) { peer.send("error:" + error.message); },
        async message(peer, message) {
          if (message.text() === "ping") { peer.ping("server"); return; }
          if (message.text() === "oversized-ping") { peer.ping(new Uint8Array(126)); return; }
          if (message.text() === "buffer") {
            const chunk = new Uint8Array(1024 * 1024);
            for (let i = 0; i < 16; i++) peer.send(chunk);
            const buffered = peer.bufferedAmount;
            const abort = new AbortController();
            const waiting = peer.waitForDrain({ signal: abort.signal, pollInterval: 10 });
            abort.abort("cancelled-drain");
            let reason;
            try { await waiting; } catch (error) { reason = error; }
            await peer.waitForDrain({ signal: AbortSignal.timeout(5_000), pollInterval: 10 });
            peer.send(JSON.stringify({ type: "drained", buffered, remaining: peer.bufferedAmount, reason, drains: peer.context.drains ?? 0 }));
          }
        },
        close() { closes++; },
      };
    }),
  ],
});
`;

const WEBSOCKET_PROBE = `
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";

const url = process.argv[2].replace("http:", "ws:") + "/compat/socket";
const rejected = new WebSocket(url, "eve.test");
const rejection = await new Promise((resolve, reject) => {
  rejected.once("unexpected-response", (_request, response) => {
    response.resume();
    resolve(response.statusCode);
    rejected.terminate();
  });
  rejected.on("error", () => {});
  rejected.once("open", () => reject(new Error("Unauthenticated upgrade accepted")));
});
assert.equal(rejection, 401);

const socket = new WebSocket(url, ["unused", "eve.test"], { headers: { authorization: "Bearer scenario" } });
const messages = [];
socket.on("message", (data, binary) => { if (!binary) messages.push(data.toString()); });
const handshake = once(socket, "upgrade");
await once(socket, "open");
assert.equal((await handshake)[0].headers["x-upgrade"], "preserved");
assert.equal(socket.protocol, "eve.test");
async function take(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Missing WebSocket message: " + JSON.stringify(messages));
}
const opened = JSON.parse(await take((m) => m.startsWith("{")));
assert.equal(opened.authenticated, true);
// One rejected and one accepted upgrade each resolve their route once.
assert.equal(opened.resolutions, 2);
socket.ping("client");
assert.equal(await take((m) => m.startsWith("ping:")), "ping:client");
socket.send("ping");
assert.equal(await take((m) => m.startsWith("pong:")), "pong:server");
socket.send("oversized-ping");
assert.match(await take((m) => m.startsWith("error:")), /125/);
socket.pause();
socket.send("buffer");
await new Promise((resolve) => setTimeout(resolve, 100));
socket.resume();
const drained = JSON.parse(await take((m) => m.startsWith("{")));
assert.ok(drained.buffered > 0);
assert.equal(drained.reason, "cancelled-drain");
assert.equal(drained.remaining, 0);
assert.ok(drained.drains > 0);
const closed = once(socket, "close");
socket.close();
await closed;
`;

async function readState(url: string) {
  return (await (await fetch(`${url}/compat/state`)).json()) as {
    background: boolean;
    cancelled: boolean;
    closes: number;
  };
}

async function checkHttp(url: string) {
  url = url.replace(/\/$/, "");
  expect(await (await fetch(`${url}/compat/native`)).json()).toEqual([0, 3, 2, 5]);
  for (const [encoded, decoded] of [
    ["caf%C3%A9", "café"],
    ["a%20b", "a b"],
    ["a%2Fb", "a%2Fb"],
    ["a%5Cb", "a%5Cb"],
    ["a%252Fb", "a%252Fb"],
    ["a%2520b", "a%20b"],
  ]) {
    const response = await fetch(`${url}/compat/params/${encoded}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      params: { value: decoded },
      requestIp: "127.0.0.1",
      method: "GET",
    });
  }
  const canonical = await fetch(`${url}/compat/st%61tic`);
  expect(await canonical.text()).toBe("static");
  for (const path of ["%ZZ", "%C0%AF", "%E0%A4%A"]) {
    expect((await fetch(`${url}/compat/params/${path}`)).status).toBe(400);
  }
  for (const [path, handler] of [
    ["head", "GET"],
    ["explicit", "HEAD"],
    ["choice/fixed", "HEAD"],
  ]) {
    const response = await fetch(`${url}/compat/${path}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-handler")).toBe(handler);
    expect(await response.text()).toBe("");
    if (handler === "GET") expect(response.headers.get("x-method")).toBe("HEAD");
  }
  expect((await fetch(`${url}/compat/no-fallback`, { method: "HEAD" })).status).toBe(404);
  const preflight = await fetch(`${url}/compat/head`, {
    method: "OPTIONS",
    headers: { origin: "https://allowed.example", "access-control-request-method": "GET" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  const denied = await fetch(`${url}/compat/head`, {
    headers: { origin: "https://denied.example" },
  });
  expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  const error = await fetch(`${url}/compat/error`, {
    headers: { origin: "https://allowed.example" },
  });
  expect(error.status).toBe(500);
  expect(error.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  expect(await error.text()).not.toContain("private-channel-error");
  expect(await (await fetch(`${url}/compat/background`)).text()).toBe("accepted");
  await waitForCondition(
    async () => (await readState(url)).background,
    "Background task did not finish.",
  );
  const abort = new AbortController();
  const stream = await fetch(`${url}/compat/stream`, { signal: abort.signal });
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  abort.abort();
  await reader.cancel().catch(() => {});
  await waitForCondition(
    async () => (await readState(url)).cancelled,
    "Stream cancellation did not reach the handler.",
  );
}

async function startProduction(appRoot: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    NODE_ENV: "production",
    PORT: "0",
    NITRO_PORT: "0",
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
  };
  delete env.VERCEL;
  delete env.TEST;
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: appRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data;
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data;
  });
  const exited = once(child, "exit");
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.kill("SIGTERM");
    try {
      const [code, signal] = await exited;
      if (process.platform === "win32") {
        expect(signal, output).toBe("SIGTERM");
      } else {
        expect(code, output).toBe(143);
      }
    } finally {
      clearTimeout(kill);
    }
  }
  try {
    await waitForCondition(
      () => {
        if (child.exitCode !== null) throw new Error(output);
        return /http:\/\/127\.0\.0\.1:\d+/.test(output);
      },
      () => `Production server did not start.\n${output}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0], stop };
}

describe("packed Nitro compatibility", () => {
  it.each(["npm", "pnpm"] as const)(
    "builds and serves a %s consumer without installing a builder",
    async (packageManager) => {
      const app = await scenarioApp({
        name: "nitro-compatibility",
        packageManager,
        installDependencies: true,
        dependencies: { bufferutil: "4.1.0", ws: "8.21.3" },
        files: {
          "agent/agent.ts":
            'import { defineAgent } from "eve"; export default defineAgent({ model: "openai/gpt-5.4-mini" });',
          "agent/channels/compatibility.ts": CHANNEL_SOURCE,
          "agent/instructions.md": "Respond concisely.\n",
          "agent/schedules/tick.ts":
            'import { defineSchedule } from "eve/schedules"; export default defineSchedule({ cron: "* * * * *", async run() {} });',
          "probe.mjs": WEBSOCKET_PROBE,
          "vite.config.ts":
            'import { nitro } from "nitro/vite"; throw new Error("Surrounding Vite config must not run"); export default { plugins: [nitro()] };',
        },
      });
      const lockfile = packageManager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
      const snapshot = async () => ({
        manifest: await readFile(join(app.appRoot, "package.json"), "utf8"),
        lock: await readFile(join(app.appRoot, lockfile), "utf8"),
        modules: (await readdir(join(app.appRoot, "node_modules"))).filter(
          (name) => name !== ".cache" && name !== ".nitro",
        ),
      });
      const before = await snapshot();
      const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NODE_ENV: "production" };
      delete env.VERCEL;
      const build = await runFile(process.execPath, ["node_modules/eve/bin/eve.js", "build"], {
        cwd: app.appRoot,
        env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
      expect(`${build.stdout}\n${build.stderr}`).not.toMatch(
        /installing.*(?:vite|rolldown)|automatically install/i,
      );
      expect(await snapshot()).toEqual(before);
      expect(JSON.parse(before.manifest).dependencies.rolldown).toBeUndefined();
      let production: Awaited<ReturnType<typeof startProduction>> | undefined;
      try {
        await rename(
          join(app.appRoot, "node_modules"),
          join(app.appRoot, ".consumer-node-modules"),
        );
        try {
          production = await startProduction(app.appRoot);
          await checkHttp(production.url);
        } finally {
          await rename(
            join(app.appRoot, ".consumer-node-modules"),
            join(app.appRoot, "node_modules"),
          );
        }
        await runFile(process.execPath, ["probe.mjs", production.url], {
          cwd: app.appRoot,
          timeout: 30_000,
        });
        await waitForCondition(
          async () => (await readState(production!.url)).closes === 1,
          "Disconnect cleanup did not run.",
        );
      } finally {
        await production?.stop();
      }

      if (packageManager === "npm") {
        const dev = await startEveDev(app.appRoot);
        try {
          await checkHttp(dev.url);
          await runFile(process.execPath, ["probe.mjs", dev.url.replace(/\/$/, "")], {
            cwd: app.appRoot,
            timeout: 30_000,
          });
          expect(await snapshot()).toEqual(before);
        } finally {
          await dev.stop();
        }
      }
    },
    360_000,
  );
});
