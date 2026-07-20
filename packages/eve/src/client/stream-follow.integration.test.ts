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
