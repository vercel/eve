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

function follow(host: string, options?: { follow?: boolean; signal?: AbortSignal }) {
  return followStreamIterable({
    follow: options?.follow,
    host,
    resolveHeaders: () => Promise.resolve(new Headers()),
    sessionId: "s",
    signal: options?.signal,
    startIndex: 0,
  });
}

function trackAbortListeners(signal: AbortSignal) {
  let adds = 0;
  let removes = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperties(signal, {
    addEventListener: {
      value(
        type: string,
        listener: Parameters<AbortSignal["addEventListener"]>[1],
        options?: Parameters<AbortSignal["addEventListener"]>[2],
      ) {
        if (type === "abort") adds += 1;
        return add(type, listener, options);
      },
    },
    removeEventListener: {
      value(
        type: string,
        listener: Parameters<AbortSignal["removeEventListener"]>[1],
        options?: Parameters<AbortSignal["removeEventListener"]>[2],
      ) {
        if (type === "abort") removes += 1;
        return remove(type, listener, options);
      },
    },
  });
  return { adds: () => adds, removes: () => removes };
}

describe("stream following over real sockets", () => {
  it("releases external abort forwarding on EOF, return, throw, and pre-abort", async () => {
    const host = await listen(
      createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-eve-stream-tail-index": "-1",
        });
        res.end();
      }),
    );

    const eofController = new AbortController();
    const eofListeners = trackAbortListeners(eofController.signal);
    await expect(
      follow(host, { follow: false, signal: eofController.signal })[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({ done: true });
    eofController.abort();
    expect(eofListeners.adds()).toBe(1);
    expect(eofListeners.removes()).toBe(1);

    for (const method of ["return", "throw"] as const) {
      const controller = new AbortController();
      const listeners = trackAbortListeners(controller.signal);
      const iterator = follow(host, { follow: false, signal: controller.signal })[
        Symbol.asyncIterator
      ]();
      if (method === "return") await iterator.return?.();
      else
        await expect(iterator.throw?.(new Error("caller stopped following"))).rejects.toThrow(
          "caller stopped following",
        );
      controller.abort();
      expect(listeners.adds()).toBe(1);
      expect(listeners.removes()).toBe(1);
    }

    const preAborted = new AbortController();
    preAborted.abort(new Error("already stopped"));
    const preAbortedListeners = trackAbortListeners(preAborted.signal);
    const iterator = follow(host, { signal: preAborted.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(preAbortedListeners.adds()).toBe(0);
    expect(preAbortedListeners.removes()).toBe(0);
  });

  it("joins a pending live pull when its iterator returns", async () => {
    let activeConnections = 0;
    let closedConnections = 0;
    const host = await listen(
      createServer((_req, res) => {
        activeConnections += 1;
        res.once("close", () => {
          activeConnections -= 1;
          closedConnections += 1;
        });
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ type: "session.waiting", data: {} })}\n`);
      }),
    );
    const iterator = follow(host)[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "session.waiting" },
    });
    const pending = iterator.next();
    const returned = iterator.return?.();
    if (returned === undefined) throw new Error("Expected stream iterator to support return().");

    await expect(withTimeout(returned, "iterator return")).resolves.toMatchObject({ done: true });
    await expect(withTimeout(pending, "pending stream pull")).resolves.toMatchObject({
      done: true,
    });
    await expect(
      withTimeout(
        waitFor(() => activeConnections === 0),
        "socket close",
      ),
    ).resolves.toBeUndefined();
    expect(closedConnections).toBe(1);
  });

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

    await expect(follow(host, { follow: false })[Symbol.asyncIterator]().next()).rejects.toThrow(
      /x-eve-stream-tail-index/,
    );
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

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 250);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
}
