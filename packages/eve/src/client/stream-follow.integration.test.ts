import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "./client.js";
import { followStreamIterable } from "./open-stream.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

function startIndexOf(url: string | undefined): number {
  return Number(new URL(url ?? "", "http://127.0.0.1").searchParams.get("startIndex") ?? "0");
}

function follow(host: string, options?: { follow?: boolean }) {
  return followStreamIterable({
    follow: options?.follow,
    host,
    resolveHeaders: () => Promise.resolve(new Headers()),
    sessionId: "s",
    startIndex: 0,
  });
}

describe("stream following over real sockets", () => {
  it("stays attached across abrupt drops and clean closes until the boundary event", async () => {
    const log = [
      { type: "step.started", data: {} },
      { type: "step.completed", data: {} },
      { type: "step.started", data: {} },
      { type: "step.completed", data: {} },
      { type: "step.started", data: {} },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ];
    let connections = 0;
    const host = await listen(
      createServer((req, res) => {
        connections += 1;
        const index = startIndexOf(req.url);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify(log[index])}\n`);

        if (index % 2 === 0) {
          setTimeout(() => req.socket.destroy(), 80);
        } else {
          res.end();
        }
      }),
    );

    const client = new Client({ host });
    const session = client.sessions.attach("s1");

    const received: string[] = [];
    for await (const event of session.stream()) {
      received.push(event.type);
      if (event.type === "session.waiting") {
        break;
      }
    }

    expect(received).toEqual([
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "session.waiting",
    ]);
    expect(connections).toBe(6);
    expect(session.state).toMatchObject({ sessionId: "s1", streamIndex: 6 });
  });

  it("gives up after the idle-reconnect budget when a settled run's stream ends boundary-less", async () => {
    let connections = 0;
    const host = await listen(
      createServer((_req, res) => {
        connections += 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        setTimeout(() => res.end(), 10);
      }),
    );

    const received: string[] = [];
    for await (const event of follow(host)) {
      received.push(event.type);
    }

    expect(received).toEqual([]);
    expect(connections).toBe(6);
  }, 20_000);

  it("bounds a follow: false read at the first connection's tail across reconnects", async () => {
    const log = [
      { type: "step.started", data: {} },
      { type: "step.completed", data: {} },
      { type: "step.started", data: {} },
      { type: "step.completed", data: {} },
      { type: "step.started", data: {} },
      { type: "step.completed", data: {} },
    ];
    const tailRequests: Array<string | null> = [];
    let connections = 0;
    const host = await listen(
      createServer((req, res) => {
        connections += 1;
        const index = startIndexOf(req.url);
        const tailRequested = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get(
          "includeTailIndex",
        );
        tailRequests.push(tailRequested);
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          ...(tailRequested === "1" ? { "x-eve-stream-tail-index": String(log.length - 1) } : {}),
        });

        // The first two connections drop after one event; the third serves the
        // rest and holds the connection open — a live follow would keep waiting.
        const events = index < 2 ? [log[index]] : log.slice(index);
        for (const event of events) {
          res.write(`${JSON.stringify(event)}\n`);
        }
        if (index < 2) {
          setTimeout(() => req.socket.destroy(), 40);
        }
      }),
    );

    const client = new Client({ host });
    const session = client.sessions.attach("s1");

    const received: string[] = [];
    for await (const event of session.stream({ follow: false })) {
      received.push(event.type);
    }

    expect(received).toEqual(log.map((event) => event.type));
    expect(connections).toBe(3);
    expect(tailRequests).toEqual(["1", null, null]);
    expect(session.state).toMatchObject({ sessionId: "s1", streamIndex: 6 });
  });

  it("ends a follow: false read immediately when the cursor is already past the tail", async () => {
    let connections = 0;
    const host = await listen(
      createServer((_req, res) => {
        connections += 1;
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-eve-stream-tail-index": "-1",
        });
        // Send headers without any body: a live follow would idle here
        // waiting for events that never arrive.
        res.flushHeaders();
      }),
    );

    const received: string[] = [];
    for await (const event of follow(host, { follow: false })) {
      received.push(event.type);
    }

    expect(received).toEqual([]);
    expect(connections).toBe(1);
  });

  it("fails a follow: false read when the server does not report a tail index", async () => {
    const host = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end();
      }),
    );

    await expect(follow(host, { follow: false }).next()).rejects.toThrow(/x-eve-stream-tail-index/);
  });

  it("never abandons a progressing turn: any event resets the idle budget", async () => {
    const events = ["step.started", "step.completed", "step.started", "session.completed"];
    const idlesServed = new Map<number, number>();
    let connections = 0;
    const host = await listen(
      createServer((req, res) => {
        connections += 1;
        const index = startIndexOf(req.url);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const served = idlesServed.get(index) ?? 0;
        if (index < events.length && served >= 2) {
          res.end(`${JSON.stringify({ type: events[index], data: {} })}\n`);
        } else {
          idlesServed.set(index, served + 1);
          setTimeout(() => res.end(), 10);
        }
      }),
    );

    const received: string[] = [];
    for await (const event of follow(host)) {
      received.push(event.type);
      if (event.type === "session.completed") break;
    }

    expect(received).toEqual(events);
    expect(connections).toBe(3 * events.length);
  }, 30_000);
});
