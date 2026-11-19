import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { deriveTakeoverKeys, mintStreamToken, TAKEOVER_PROXY_SOURCE } from "@eve/takeover/core";

const keys = deriveTakeoverKeys("p".repeat(32));
const SESSION_ID = "ses_proxy";
const CALL_ID = "call_proxy";
const ORIGIN = "https://agent.example";

const token = (callId = CALL_ID) => mintStreamToken(keys, { sessionId: SESSION_ID, callId }).token;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A loopback WebSocket server that records handshake headers and echoes short text frames. */
async function websocketUpstream() {
  const seen = [];
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk) => {
      const length = chunk[1] & 0x7f;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });
  return { server, port: await listen(server), seen };
}

/** A loopback TCP server, like VNC: greets, then echoes bytes. */
async function tcpUpstream() {
  const server = createTcpServer((socket) => {
    socket.write("RFB 003.008\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return { server, port: await listen(server) };
}

async function startProxy(dir, name, env) {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, TAKEOVER_PROXY_SOURCE);
  const port = await freePort();
  const child = spawn(process.execPath, [path], {
    env: {
      ...process.env,
      EVE_TAKEOVER_PORT: String(port),
      EVE_TAKEOVER_PUBLIC_KEY: keys.publicKeySpki,
      EVE_TAKEOVER_SESSION_ID: SESSION_ID,
      EVE_TAKEOVER_CALL_ID: CALL_ID,
      EVE_TAKEOVER_TTL_MS: "60000",
      EVE_TAKEOVER_ALLOWED_ORIGIN: ORIGIN,
      ...env,
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { child, port };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("The proxy did not start.");
}

function upgradeStatus(port, path, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Cookie: "session=secret",
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Node's WebSocket (undici) takes request headers in its options object. */
function openSocket(port, binary) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${token()}`, {
    headers: { Origin: ORIGIN },
  });
  if (binary) socket.binaryType = "arraybuffer";
  return socket;
}

describe("takeover proxy", () => {
  let dir;
  const cleanups = [];
  let ws;
  let tcp;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "eve-takeover-proxy-"));
    const wsUpstream = await websocketUpstream();
    const tcpServer = await tcpUpstream();
    cleanups.push(
      () => wsUpstream.server.close(),
      () => tcpServer.server.close(),
    );
    ws = {
      upstream: wsUpstream,
      ...(await startProxy(dir, "ws", {
        EVE_TAKEOVER_UPSTREAM: "websocket",
        EVE_TAKEOVER_PORT_COMMAND: `echo ${wsUpstream.port}`,
      })),
    };
    tcp = await startProxy(dir, "tcp", {
      EVE_TAKEOVER_UPSTREAM: "tcp",
      EVE_TAKEOVER_PORT_COMMAND: `echo ${tcpServer.port}`,
    });
    cleanups.push(
      () => ws.child.kill(),
      () => tcp.child.kill(),
    );
  });

  after(async () => {
    for (const cleanup of cleanups) cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("serves only the health check over plain HTTP", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${ws.port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${ws.port}/api/exec`)).status, 404);
  });

  test("refuses missing, forged, and foreign tokens, other origins, and other paths", async () => {
    assert.equal(await upgradeStatus(ws.port, "/stream"), 401);
    assert.equal(await upgradeStatus(ws.port, "/stream?token=nope"), 401);
    assert.equal(await upgradeStatus(ws.port, `/stream?token=${token("other")}`), 401);
    const otherKey = mintStreamToken(deriveTakeoverKeys("q".repeat(32)), {
      sessionId: SESSION_ID,
      callId: CALL_ID,
    }).token;
    assert.equal(await upgradeStatus(ws.port, `/stream?token=${otherKey}`), 401);
    assert.equal(
      await upgradeStatus(ws.port, `/stream?token=${token()}`, "https://evil.example"),
      403,
    );
    assert.equal(await upgradeStatus(ws.port, `/?token=${token()}`), 404);
  });

  test("forwards a WebSocket upstream once per token, without the browser's Origin or cookies", async () => {
    const before = ws.upstream.seen.length;
    const once = token();
    assert.equal(await upgradeStatus(ws.port, `/stream?token=${once}`), 101);
    assert.equal(await upgradeStatus(ws.port, `/stream?token=${once}`), 401);
    assert.equal(ws.upstream.seen.length, before + 1);
    const headers = ws.upstream.seen[before];
    assert.equal(headers.origin, undefined);
    assert.equal(headers.cookie, undefined);

    const socket = openSocket(ws.port, false);
    const echoed = await new Promise((resolve, reject) => {
      socket.onopen = () => socket.send("hello");
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = () => reject(new Error("socket error"));
    });
    socket.close();
    assert.equal(echoed, "hello");
  });

  test("bridges binary WebSocket frames to a TCP upstream, in both directions", async () => {
    const socket = openSocket(tcp.port, true);
    const received = [];
    const done = new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        received.push(Buffer.from(event.data));
        const all = Buffer.concat(received).toString("latin1");
        if (all.includes("ping-from-viewer")) resolve(all);
      };
      socket.onerror = () => reject(new Error("socket error"));
    });
    // A large payload exercises the 16-bit length path in both directions.
    const big = Buffer.alloc(70_000, 7);
    socket.onopen = () => {
      socket.send(big);
      socket.send(new TextEncoder().encode("ping-from-viewer"));
    };
    const all = await done;
    socket.close();
    assert.ok(all.startsWith("RFB 003.008\n"));
    assert.equal(Buffer.concat(received).length, 12 + big.length + "ping-from-viewer".length);
  });
});
