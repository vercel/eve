import { spawn, type ChildProcess } from "node:child_process";
import { request, Agent } from "node:http";
import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PLUGIN_PATH = fileURLToPath(new URL("./connection-drain-plugin.ts", import.meta.url));

/** srvx's graceful shutdown: it closes the server, and the process exits once nothing is left. */
const SRVX_LISTENER = 'process.on("SIGTERM", () => server.close());';

/** Like signal-exit, bundled in eve's server: it re-raises a signal no other listener handles. */
const SIGNAL_EXIT_LISTENER = `process.on("SIGTERM", function reraise(signal) {
  if (process.listenerCount(signal) > 1) return;
  process.removeListener(signal, reraise);
  process.kill(process.pid, signal);
});`;

function serverSource(signalListener: string): string {
  return `
import { createServer } from "node:http";
import connectionDrainPlugin from ${JSON.stringify(PLUGIN_PATH)};
const server = createServer((_request, response) => {
  setTimeout(() => response.end("done"), 300);
});
connectionDrainPlugin();
${signalListener}
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;
}

const children: ChildProcess[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const socket of sockets.splice(0)) socket.destroy();
});

/** Starts the server; with `srvx: false` it runs as srvx would skip graceful shutdown, in CI. */
async function startServer(input: { readonly srvx: boolean }) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.TEST;
  if (!input.srvx) env.CI = "1";
  const source = serverSource(input.srvx ? SRVX_LISTENER : SIGNAL_EXIT_LISTENER);
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString())));
    child.once("exit", () => reject(new Error("The server exited before listening.")));
  });
  return { child, exited, port };
}

function openIdleConnection(port: number): Promise<void> {
  const socket = connect(port, "127.0.0.1");
  // The server may reset it on shutdown.
  socket.on("error", () => {});
  sockets.push(socket);
  return new Promise((resolve) => socket.once("connect", () => resolve()));
}

function get(port: number, agent: Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ agent, host: "127.0.0.1", port }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.once("end", () => resolve(body));
    })
      .once("error", reject)
      .end();
  });
}

describe("connection drain plugin", () => {
  it("exits on SIGTERM once in-flight responses finish, whatever clients keep open", async () => {
    const { child, exited, port } = await startServer({ srvx: true });
    const agent = new Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
    try {
      // A client that connected without sending a request, and a request still in flight on a
      // connection its client keeps alive.
      await openIdleConnection(port);
      const response = get(port, agent);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const signalledAt = Date.now();
      child.kill("SIGTERM");

      await expect(response).resolves.toBe("done");
      expect(await Promise.race([exited, sleep(2_000).then(() => "still running")])).toEqual({
        code: 0,
        signal: null,
      });
      expect(Date.now() - signalledAt).toBeLessThan(2_000);
    } finally {
      agent.destroy();
    }
  });

  it("leaves a signal to Node's default when srvx doesn't handle it", async () => {
    const { child, exited, port } = await startServer({ srvx: false });
    await openIdleConnection(port);

    child.kill("SIGTERM");

    expect(await Promise.race([exited, sleep(2_000).then(() => "still running")])).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  });
});
