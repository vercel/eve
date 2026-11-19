/**
 * Source of the stream proxy a takeover runs inside the sandbox.
 *
 * Stream servers such as agent-browser's listen on loopback only, and a VNC
 * server speaks raw TCP, so neither can face the internet directly. This proxy
 * exposes exactly one thing, `GET /stream` as a WebSocket, behind a
 * short-lived, one-use Ed25519 token that only the agent's server can mint.
 * Behind it, it either forwards the WebSocket upgrade to a loopback WebSocket
 * server (`websocket`) or terminates the WebSocket and bridges binary frames to
 * a loopback TCP server (`tcp`, the websockify role for VNC).
 *
 * Plain Node.js, no dependencies. It never logs tokens, frames, or input.
 *
 * Environment:
 * - EVE_TAKEOVER_PORT              port to listen on (0.0.0.0): the exposed sandbox port
 * - EVE_TAKEOVER_PUBLIC_KEY        Ed25519 public key, SPKI DER base64
 * - EVE_TAKEOVER_SESSION_ID        eve session id tokens must name
 * - EVE_TAKEOVER_CALL_ID           takeover tool call id tokens must name
 * - EVE_TAKEOVER_UPSTREAM          "websocket" or "tcp"
 * - EVE_TAKEOVER_PORT_COMMAND      shell command that prints the loopback upstream port
 * - EVE_TAKEOVER_TTL_MS            the proxy exits after this long
 * - EVE_TAKEOVER_ALLOWED_ORIGIN    optional exact browser Origin to require
 * - EVE_TAKEOVER_MAX_TOKEN_TTL_MS  longest token lifetime accepted
 */
export const TAKEOVER_PROXY_SOURCE = String.raw`
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";

const env = process.env;
const PORT = Number(env.EVE_TAKEOVER_PORT);
const PUBLIC_KEY = createPublicKey({
  key: Buffer.from(env.EVE_TAKEOVER_PUBLIC_KEY ?? "", "base64"),
  format: "der",
  type: "spki",
});
const SESSION_ID = env.EVE_TAKEOVER_SESSION_ID ?? "";
const CALL_ID = env.EVE_TAKEOVER_CALL_ID ?? "";
const UPSTREAM = env.EVE_TAKEOVER_UPSTREAM === "tcp" ? "tcp" : "websocket";
const PORT_COMMAND = env.EVE_TAKEOVER_PORT_COMMAND ?? "";
const ALLOWED_ORIGIN = env.EVE_TAKEOVER_ALLOWED_ORIGIN || "";
const MAX_TOKEN_TTL_MS = Number(env.EVE_TAKEOVER_MAX_TOKEN_TTL_MS) || 120000;
const DEADLINE = Date.now() + (Number(env.EVE_TAKEOVER_TTL_MS) || 1200000);
const MAX_CONNECTIONS = 2;
const MAX_FRAME_BYTES = 1 << 20;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

if (!PORT || !SESSION_ID || !CALL_ID || !PORT_COMMAND) {
  process.stderr.write("eve takeover proxy: missing configuration\n");
  process.exit(2);
}

/** jti -> exp of tokens already accepted: each token opens one connection. */
const spent = new Map();
const connections = new Set();

function acceptToken(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const payload = Buffer.from(parts[0], "base64url");
  try {
    if (!verify(null, payload, PUBLIC_KEY, Buffer.from(parts[1], "base64url"))) return false;
  } catch {
    return false;
  }
  let claims;
  try {
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    return false;
  }
  const now = Date.now();
  for (const [jti, exp] of spent) if (exp <= now) spent.delete(jti);
  if (
    !claims ||
    claims.aud !== "eve-takeover" ||
    claims.sid !== SESSION_ID ||
    claims.cid !== CALL_ID ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    claims.exp > now + MAX_TOKEN_TTL_MS ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    spent.has(claims.jti)
  ) {
    return false;
  }
  spent.set(claims.jti, claims.exp);
  return true;
}

function upstreamPort() {
  return new Promise((resolve) => {
    execFile("sh", ["-c", PORT_COMMAND], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null);
      const port = Number(String(stdout).trim().split(/\s+/)[0]);
      resolve(Number.isInteger(port) && port > 0 && port < 65536 ? port : null);
    });
  });
}

function refuse(socket, status, reason) {
  socket.end("HTTP/1.1 " + status + " " + reason + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function track(...sockets) {
  const entry = { sockets, close: () => sockets.forEach((s) => s.destroy()) };
  connections.add(entry);
  for (const s of sockets) {
    s.on("error", () => entry.close());
    s.on("close", () => {
      connections.delete(entry);
      entry.close();
    });
  }
}

/** Forward the upgrade to a loopback WebSocket server, without the browser's Origin or cookies. */
function forwardWebSocket(request, socket, head, port) {
  const upstream = connect(port, "127.0.0.1");
  track(socket, upstream);
  upstream.on("connect", () => {
    const lines = [
      "GET / HTTP/1.1",
      "Host: 127.0.0.1:" + port,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + request.headers["sec-websocket-key"],
      "Sec-WebSocket-Version: 13",
    ];
    const extensions = request.headers["sec-websocket-extensions"];
    if (typeof extensions === "string") lines.push("Sec-WebSocket-Extensions: " + extensions);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

function wsFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Terminate the WebSocket and bridge binary frames to a loopback TCP server. */
function bridgeTcp(request, socket, head, port) {
  const upstream = connect(port, "127.0.0.1");
  track(socket, upstream);
  upstream.on("connect", () => {
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    upstream.on("data", (chunk) => socket.write(wsFrame(2, chunk)));
    upstream.on("end", () => socket.end(wsFrame(8, Buffer.alloc(0))));
    let buffered = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    const drain = () => {
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 0x0f;
        const masked = (buffered[1] & 0x80) !== 0;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          const big = buffered.readBigUInt64BE(2);
          if (big > BigInt(MAX_FRAME_BYTES)) return socket.destroy();
          length = Number(big);
          offset = 10;
        }
        // Browsers always mask; an unmasked client frame is a protocol error.
        if (!masked || length > MAX_FRAME_BYTES) return socket.destroy();
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i++) payload[i] = buffered[offset + 4 + i] ^ mask[i % 4];
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode === 0x8) {
          socket.end(wsFrame(8, Buffer.alloc(0)));
          upstream.end();
          return;
        }
        if (opcode === 0x9) socket.write(wsFrame(0xa, payload));
        else if (opcode === 0x0 || opcode === 0x2) upstream.write(payload);
      }
    };
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      drain();
    });
    drain();
  });
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("ok");
    return;
  }
  response.writeHead(404, { "cache-control": "no-store" });
  response.end();
});

server.on("upgrade", async (request, socket, head) => {
  socket.on("error", () => socket.destroy());
  let url;
  try {
    url = new URL(request.url ?? "/", "http://proxy.invalid");
  } catch {
    return refuse(socket, 400, "Bad Request");
  }
  if (url.pathname !== "/stream") return refuse(socket, 404, "Not Found");
  if (Date.now() >= DEADLINE) return refuse(socket, 410, "Gone");
  if (ALLOWED_ORIGIN && request.headers.origin !== ALLOWED_ORIGIN) return refuse(socket, 403, "Forbidden");
  if (!acceptToken(url.searchParams.get("token"))) return refuse(socket, 401, "Unauthorized");
  if (connections.size >= MAX_CONNECTIONS) return refuse(socket, 429, "Too Many Requests");
  if (typeof request.headers["sec-websocket-key"] !== "string") return refuse(socket, 400, "Bad Request");
  const port = await upstreamPort();
  if (port === null) return refuse(socket, 503, "Service Unavailable");
  if (UPSTREAM === "tcp") bridgeTcp(request, socket, head, port);
  else forwardWebSocket(request, socket, head, port);
});

server.listen(PORT, "0.0.0.0");

const shutdown = () => {
  for (const entry of connections) entry.close();
  server.close();
  process.exit(0);
};
setTimeout(shutdown, Math.max(0, DEADLINE - Date.now())).unref();
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;
