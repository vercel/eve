import { createServer, type IncomingMessage, type Server } from "node:http";

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

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function follow(host: string) {
  return followStreamIterable({
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
      { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "eve:x" } },
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
    const session = client.session({ sessionId: "s1", streamIndex: 0 });

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

  it("accepts one clean current-tail response without durable-follow reconnect", async () => {
    let connections = 0;
    let requestedUrl: string | undefined;
    const host = await listen(
      createServer((req, res) => {
        connections += 1;
        requestedUrl = req.url;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(
          `${JSON.stringify({
            type: "session.waiting",
            data: { wait: "next-user-message", continuationToken: "eve:current" },
          })}\n`,
        );
      }),
    );
    const session = new Client({ host }).session({ sessionId: "s1", streamIndex: 0 });

    const received: string[] = [];
    for await (const event of session.stream({ throughCurrentTail: true })) {
      received.push(event.type);
    }

    expect(received).toEqual(["session.waiting"]);
    expect(connections).toBe(1);
    expect(new URL(requestedUrl ?? "", host).searchParams.get("throughCurrentTail")).toBe("true");
    expect(session.state).toEqual({
      continuationToken: "eve:current",
      sessionId: "s1",
      streamIndex: 1,
    });
  });

  it("fails an abruptly interrupted current-tail body without opening another snapshot", async () => {
    let connections = 0;
    const host = await listen(
      createServer((req, res) => {
        connections += 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ type: "turn.started", data: {} })}\n`);
        setTimeout(() => req.socket.destroy(), 80);
      }),
    );
    const session = new Client({ host }).session({ sessionId: "s1", streamIndex: 0 });
    const received: string[] = [];

    const consumed = (async () => {
      for await (const event of session.stream({ throughCurrentTail: true })) {
        received.push(event.type);
      }
    })();

    await expect(consumed).rejects.toBeInstanceOf(Error);
    expect(received).toEqual(["turn.started"]);
    expect(connections).toBe(1);
    expect(session.state).toEqual({ sessionId: "s1", streamIndex: 0 });
  });

  it("retries a failed current-tail replay from the original cursor and does not send a stale historical token", async () => {
    const historicalWaiting = {
      type: "session.waiting",
      data: { wait: "next-user-message", continuationToken: "eve:historical" },
    };
    const currentWaiting = {
      type: "session.waiting",
      data: { wait: "next-user-message", continuationToken: "eve:current" },
    };
    const streamUrls: string[] = [];
    const postBodies: unknown[] = [];
    let streamRequest = 0;
    const host = await listen(
      createServer(async (req, res) => {
        if (req.method === "POST") {
          postBodies.push(await readRequestJson(req));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "s1" }));
          return;
        }

        streamRequest += 1;
        streamUrls.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        if (streamRequest === 1) {
          res.write(`${JSON.stringify(historicalWaiting)}\n`);
          res.write(
            `${JSON.stringify({ type: "turn.started", data: { sequence: 2, turnId: "turn-2" } })}\n`,
          );
          setTimeout(() => req.socket.destroy(), 80);
          return;
        }

        res.end(
          [
            historicalWaiting,
            { type: "turn.started", data: { sequence: 2, turnId: "turn-2" } },
            { type: "turn.completed", data: { sequence: 2, turnId: "turn-2" } },
            currentWaiting,
          ]
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n",
        );
      }),
    );
    const initialState = {
      continuationToken: "eve:original",
      sessionId: "s1",
      streamIndex: 4,
    };
    const session = new Client({ host }).session(initialState);
    const failedEvents: string[] = [];

    const failedReplay = (async () => {
      for await (const event of session.stream({ throughCurrentTail: true })) {
        failedEvents.push(event.type);
      }
    })();

    await expect(failedReplay).rejects.toBeInstanceOf(Error);
    expect(failedEvents).toEqual(["session.waiting", "turn.started"]);
    expect(session.state).toEqual(initialState);

    await session.send("next after failed replay");
    expect(postBodies).toEqual([
      { continuationToken: "eve:original", message: "next after failed replay" },
    ]);
    expect(session.state).toEqual(initialState);

    const retryEvents: string[] = [];
    for await (const event of session.stream({ throughCurrentTail: true })) {
      retryEvents.push(event.type);
    }

    expect(retryEvents).toEqual([
      "session.waiting",
      "turn.started",
      "turn.completed",
      "session.waiting",
    ]);
    expect(streamUrls.map(startIndexOf)).toEqual([4, 4]);
    expect(
      streamUrls.map((url) =>
        new URL(url, "http://127.0.0.1").searchParams.get("throughCurrentTail"),
      ),
    ).toEqual(["true", "true"]);
    expect(session.state).toEqual({
      continuationToken: "eve:current",
      sessionId: "s1",
      streamIndex: 8,
    });
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
