import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  DiscordGatewayFatalError,
  experimental_runDiscordGatewayRelay,
} from "#public/channels/discord/gateway/index.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface GatewayConnection {
  readonly path: string;
  readonly received: Record<string, any>[];
  send(payload: unknown): void;
  close(code: number): void;
  /** Stops answering, like a peer whose TCP connection silently died. */
  goSilent(): void;
}

/**
 * Fake Discord, plus the eve route the relay forwards to, on one port. The
 * WebSocket side speaks just enough RFC 6455 for the relay's text frames.
 */
async function startFakeDiscord(
  onConnection: (connection: GatewayConnection) => void,
  /** eve's answers to successive forwarded dispatches; 202 once they run out. */
  eveStatuses: number[] = [],
): Promise<{
  readonly url: string;
  readonly forwarded: { readonly body: unknown; readonly authorization?: string }[];
}> {
  const forwarded: { body: unknown; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v10/gateway/bot") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: `ws://127.0.0.1:${port(server)}/gateway` }));
      return;
    }
    if (req.method === "POST" && req.url === "/eve/v1/discord/gateway") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        forwarded.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
        res.statusCode = eveStatuses.shift() ?? 202;
        res.end("{}");
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket) => onConnection(acceptWebSocket(req, socket)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { forwarded, url: `http://127.0.0.1:${port(server)}` };
}

function acceptWebSocket(req: IncomingMessage, socket: Duplex): GatewayConnection {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const received: Record<string, any>[] = [];
  let silent = false;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let frame = readFrame(buffer); frame; frame = readFrame(buffer)) {
      buffer = buffer.subarray(frame.length);
      if (frame.opcode === 1) {
        const payload = JSON.parse(frame.payload.toString("utf8"));
        received.push(payload);
        if (payload.op === 1 && !silent) socket.write(encodeFrame(1, Buffer.from('{"op":11}')));
      }
      if (frame.opcode === 8 && !silent) {
        socket.end(encodeFrame(8, frame.payload));
      }
    }
  });
  socket.on("error", () => {});
  sockets.push(socket);

  return {
    path: req.url ?? "",
    received,
    send: (payload) => socket.write(encodeFrame(1, Buffer.from(JSON.stringify(payload)))),
    goSilent: () => {
      silent = true;
    },
    close: (code) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      socket.write(encodeFrame(8, payload));
    },
  };
}

function readFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buffer.length < 2) return undefined;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const masked = (buffer[1]! & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += masked ? 4 : 0;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
  return { length: offset + length, opcode: buffer[0]! & 0x0f, payload };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the relay.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const servers: Server[] = [];
const sockets: Duplex[] = [];

afterEach(async () => {
  // Upgraded sockets leave the HTTP server's bookkeeping, and a silent one never closes.
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

const HELLO = { d: { heartbeat_interval: 45_000 }, op: 10 };

function messageCreate(s: number, id: string) {
  return { d: { id }, op: 0, s, t: "MESSAGE_CREATE" };
}

describe("experimental_runDiscordGatewayRelay", () => {
  it("forwards message dispatches unchanged and in order, resuming across a reconnect", async () => {
    const connections: GatewayConnection[] = [];
    const discord = await startFakeDiscord((connection) => {
      connections.push(connection);
      connection.send(HELLO);
    });
    const shutdown = new AbortController();

    const relay = experimental_runDiscordGatewayRelay({
      api: { apiBaseUrl: `${discord.url}/api/v10` },
      auth: async () => ({ headers: { authorization: "Bearer relay" } }),
      credentials: { botToken: "bot-token" },
      signal: shutdown.signal,
      url: discord.url,
    });

    await waitFor(() => connections[0]?.received.length === 1);
    const [first] = connections;
    expect(first!.received[0]).toMatchObject({
      d: { intents: (1 << 9) | (1 << 12), token: "bot-token" },
      op: 2,
    });
    first!.send({
      d: { resume_gateway_url: `${discord.url.replace("http", "ws")}/resume`, session_id: "S1" },
      op: 0,
      s: 1,
      t: "READY",
    });
    first!.send(messageCreate(2, "M1"));
    first!.send({ d: {}, op: 0, s: 3, t: "TYPING_START" });
    first!.send(messageCreate(4, "M2"));
    first!.send({ d: null, op: 7 });

    await waitFor(() => connections[1]?.received.length === 1);
    const [, second] = connections;
    expect(second!.path).toMatch(/^\/resume\?/);
    expect(second!.received[0]).toEqual({
      d: { seq: 4, session_id: "S1", token: "bot-token" },
      op: 6,
    });
    second!.send({ d: null, op: 0, s: 5, t: "RESUMED" });
    second!.send(messageCreate(6, "M3"));

    await waitFor(() => discord.forwarded.length === 3);
    shutdown.abort();
    await relay;

    expect(discord.forwarded).toEqual([
      { authorization: "Bearer relay", body: messageCreate(2, "M1") },
      { authorization: "Bearer relay", body: messageCreate(4, "M2") },
      { authorization: "Bearer relay", body: messageCreate(6, "M3") },
    ]);
  });

  it("abandons a connection that stops acknowledging heartbeats and resumes elsewhere", async () => {
    const connections: GatewayConnection[] = [];
    const discord = await startFakeDiscord((connection) => {
      connections.push(connection);
      connection.send({ d: { heartbeat_interval: 50 }, op: 10 });
    });
    const shutdown = new AbortController();
    const relay = experimental_runDiscordGatewayRelay({
      api: { apiBaseUrl: `${discord.url}/api/v10` },
      credentials: { botToken: "bot-token" },
      signal: shutdown.signal,
      url: discord.url,
    });

    await waitFor(() => connections[0]?.received.some((payload) => payload.op === 2) === true);
    connections[0]!.send({
      d: { resume_gateway_url: `${discord.url.replace("http", "ws")}/resume`, session_id: "S1" },
      op: 0,
      s: 1,
      t: "READY",
    });
    connections[0]!.goSilent();

    await waitFor(() => connections[1]?.received.some((payload) => payload.op === 6) === true);
    shutdown.abort();
    await relay;

    expect(connections[1]!.path).toMatch(/^\/resume\?/);
  });

  it("retries a rate limit but never a 5xx, which can come after eve started the turn", async () => {
    let gateway: GatewayConnection | undefined;
    const discord = await startFakeDiscord(
      (connection) => {
        gateway = connection;
        connection.send(HELLO);
      },
      [429, 502],
    );
    const shutdown = new AbortController();
    const relay = experimental_runDiscordGatewayRelay({
      api: { apiBaseUrl: `${discord.url}/api/v10` },
      credentials: { botToken: "bot-token" },
      signal: shutdown.signal,
      url: discord.url,
    });

    await waitFor(() => gateway?.received.length === 1);
    gateway!.send(messageCreate(1, "M1"));
    await waitFor(() => discord.forwarded.length === 2);
    shutdown.abort();
    // Shutdown drains the backlog, so a retry of the 502 would land before this resolves.
    await relay;

    expect(discord.forwarded.map(({ body }) => body)).toEqual([
      messageCreate(1, "M1"),
      messageCreate(1, "M1"),
    ]);
  });

  it("stops with an actionable error when Discord refuses the bot's intents", async () => {
    const discord = await startFakeDiscord((connection) => {
      connection.send(HELLO);
      void waitFor(() => connection.received.length === 1).then(() => connection.close(4014));
    });

    const relay = experimental_runDiscordGatewayRelay({
      api: { apiBaseUrl: `${discord.url}/api/v10` },
      credentials: { botToken: "bot-token" },
      messageContent: true,
      signal: new AbortController().signal,
      url: discord.url,
    });

    await expect(relay).rejects.toThrow(DiscordGatewayFatalError);
    await expect(relay).rejects.toThrow(/4014.*Discord Developer Portal/);
  });
});
