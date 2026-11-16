import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
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

// A self-signed test certificate, valid until 2126.
const LOCALHOST = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUKHacTUI1cxpPDk584AB8UX5DhcswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTEzNDQyMFoYDzIxMjYxMDA1
MTM0NDIwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARYpSTxjPKVdfmHqeZcgPCq81+MCTM2CLeI9cytnzIoMQ9oRAF1jvSe
GJ8C6Q8EWNudU9y5HpCoCazTG8jvnBrEo2kwZzAdBgNVHQ4EFgQUuYID6YpoVRkW
ESriaj06C3kbaqAwHwYDVR0jBBgwFoAUuYID6YpoVRkWESriaj06C3kbaqAwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
SAAwRQIgYel9VqzZFQajewTlrELRaDI89sa2deN+pJubcxotxBYCIQC/dW9a6YZo
5/6Vvu/4cF3CVdnLx3Z4leVZiepvaV4ueA==
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRuvajLM9BiShCX1J
38fEnm2Q23+hBefMayFxposNE9yhRANCAARYpSTxjPKVdfmHqeZcgPCq81+MCTM2
CLeI9cytnzIoMQ9oRAF1jvSeGJ8C6Q8EWNudU9y5HpCoCazTG8jvnBrE
-----END PRIVATE KEY-----`,
};

type Protocol = "http" | "https";

function serverSource(signalListener: string, protocol: Protocol): string {
  const options = protocol === "https" ? JSON.stringify(LOCALHOST) : "{}";
  return `
import { createServer } from "node:${protocol}";
import connectionDrainPlugin from ${JSON.stringify(PLUGIN_PATH)};
const server = createServer(${options}, (_request, response) => {
  setTimeout(() => response.end("done"), 300);
});
// Accepts every upgrade, as a WebSocket server does.
server.on("upgrade", (_request, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
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
async function startServer(input: { readonly srvx: boolean; readonly protocol?: Protocol }) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.TEST;
  if (!input.srvx) env.CI = "1";
  const source = serverSource(
    input.srvx ? SRVX_LISTENER : SIGNAL_EXIT_LISTENER,
    input.protocol ?? "http",
  );
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

/** Opens a connection and upgrades it; resolves once the server switched protocols. */
function openUpgradedConnection(port: number, protocol: Protocol): Promise<Socket> {
  const socket =
    protocol === "https"
      ? tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false })
      : connect(port, "127.0.0.1");
  socket.on("error", () => {});
  sockets.push(socket);
  socket.write(
    "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  return new Promise((resolve) =>
    socket.once("data", (chunk: Buffer) => {
      expect(chunk.toString()).toMatch(/^HTTP\/1\.1 101 /);
      resolve(socket);
    }),
  );
}

function keepAliveAgent(protocol: Protocol): HttpAgent {
  const options = { keepAlive: true, keepAliveMsecs: 60_000 };
  return protocol === "https"
    ? new HttpsAgent({ ...options, rejectUnauthorized: false })
    : new HttpAgent(options);
}

function get(port: number, protocol: Protocol, agent: HttpAgent): Promise<string> {
  const request = protocol === "https" ? httpsRequest : httpRequest;
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
  it.for(["http", "https"] as const)(
    "exits on SIGTERM once in-flight %s responses finish, whatever clients keep open",
    async (protocol) => {
      const { child, exited, port } = await startServer({ srvx: true, protocol });
      const agent = keepAliveAgent(protocol);
      try {
        // A client that connected without sending a request, and a request still in flight on a
        // connection its client keeps alive.
        await openIdleConnection(port);
        const response = get(port, protocol, agent);
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
    },
  );

  it.for(["http", "https"] as const)(
    "keeps an upgraded %s connection open on SIGTERM until its client closes it",
    async (protocol) => {
      const { child, exited, port } = await startServer({ srvx: true, protocol });
      await openIdleConnection(port);
      const upgradedSocket = await openUpgradedConnection(port, protocol);
      const closed = new Promise<void>((resolve) => upgradedSocket.once("close", () => resolve()));

      child.kill("SIGTERM");

      expect(await Promise.race([exited, closed, sleep(500).then(() => "open")])).toBe("open");
      upgradedSocket.end();
      expect(await Promise.race([exited, sleep(2_000).then(() => "still running")])).toEqual({
        code: 0,
        signal: null,
      });
    },
  );

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
