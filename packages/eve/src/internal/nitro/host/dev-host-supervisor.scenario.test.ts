import { readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DEV_SERVER_CLOSE_BUDGET_MS } from "#cli/dev/local-server-process.js";
import {
  DEVELOPMENT_CLIENT_ADDRESS_HEADER,
  DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER,
  readTrustedDevelopmentClientAddress,
} from "#internal/nitro/dev-client-address.js";
import { type DevHost, DevHostSupervisor } from "#internal/nitro/host/dev-host-supervisor.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";
import { createParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-server.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/application/dev-transport.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

const ADDRESS = DEVELOPMENT_CLIENT_ADDRESS_HEADER;
const SIGNATURE = DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER;

// A worker entry in the shape Nitro's dev build emits. `workerData` picks the
// behavior per host; file gates let a test step a worker without timers.
const WORKER_SOURCE = `
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { workerData } from "node:worker_threads";

const id = crypto.randomUUID();
const seen = [];
const waitFor = async (path) => {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10));
};
if (workerData.failBoot) throw new Error("candidate failed to boot");
if (workerData.bootGate) await waitFor(workerData.bootGate);
if (workerData.bootLog) await appendFile(workerData.bootLog, id + "\\n");

function heldStream(gate, fail) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("started\\n"));
      void waitFor(gate).then(() =>
        fail ? controller.error(new Error("worker stream died")) : controller.close(),
      );
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    seen.push(url.pathname);
    const gate = url.searchParams.get("gate");
    switch (url.pathname) {
      case "/crash":
        setTimeout(() => process.exit(1), 10);
        return new Response("crashing");
      case "/fail-stream":
        return new Response(heldStream(gate, true));
      case "/headers":
        return Response.json({
          address: request.headers.get(${JSON.stringify(ADDRESS)}),
          signature: request.headers.get(${JSON.stringify(SIGNATURE)}),
        });
      case "/seen":
        return Response.json(seen);
      case "/stream":
        return new Response(heldStream(gate, false));
      case "/upload":
        await request.text();
        return new Response("uploaded");
      default:
        return Response.json({ id, label: workerData.label });
    }
  },
  websocket: {
    upgrade(request) {
      return {
        headers: {
          "x-seen-address": request.headers.get(${JSON.stringify(ADDRESS)}) ?? "",
          "x-seen-signature": request.headers.get(${JSON.stringify(SIGNATURE)}) ?? "",
        },
      };
    },
    message(peer, message) {
      peer.send(message.text());
    },
  },
  ipc: {
    async onClose() {
      if (workerData.closeMarker) await appendFile(workerData.closeMarker, id + "\\n");
    },
  },
};
`;

const createDirectory = useTemporaryDirectories();

interface Identity {
  readonly id: string;
  readonly label?: string;
}

async function startSupervisor() {
  const root = await createDirectory("eve-dev-host-supervisor-");
  const entry = join(root, "worker.mjs");
  await writeFile(entry, WORKER_SOURCE);
  const logs: string[] = [];
  const supervisor = new DevHostSupervisor({ error: (message) => logs.push(String(message)) });
  onTestFinished(async () => await supervisor.close());
  const listener = supervisor.listen({ hostname: "127.0.0.1", port: 0 });
  await listener.ready();
  const url = (path: string) => new URL(path, listener.url);

  return {
    host: (workerData: Record<string, unknown> = {}, dispose?: () => Promise<void>): DevHost => ({
      dispose,
      entry,
      workerData,
    }),
    listener,
    logs,
    /** A file path whose creation releases whatever waits on it. */
    path: (name: string) => join(root, name),
    supervisor,
    url,
    whoami: async (): Promise<Identity> => (await (await fetch(url("/"))).json()) as Identity,
  };
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trim().split("\n");
}

async function open(gate: string): Promise<void> {
  await writeFile(gate, "");
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    if ((await reader.read()).done) return;
  }
}

describe("dev host supervisor", () => {
  it("swaps only to a ready worker and keeps the previous one serving when a candidate fails", async () => {
    const { host, supervisor, whoami } = await startSupervisor();
    const disposeFailed = vi.fn(async () => undefined);

    await supervisor.swapTo(host({ label: "first" }));
    const before = await whoami();
    await expect(supervisor.swapTo(host({ failBoot: true }, disposeFailed))).rejects.toThrow(
      "candidate failed to boot",
    );

    // The candidate's host never served, so its workspace is gone already.
    expect(disposeFailed).toHaveBeenCalledOnce();
    await expect(whoami()).resolves.toEqual(before);
  });

  it("holds a request that arrives before any worker until one is active", async () => {
    const { host, supervisor, url } = await startSupervisor();
    // Control routes run just before a request waits for a worker.
    const admitted = Promise.withResolvers<void>();
    supervisor.setControlHandler(async () => {
      admitted.resolve();
      return undefined;
    });

    const early = fetch(url("/"));
    await admitted.promise;
    await supervisor.swapTo(host({ label: "first" }));
    await expect((await early).json()).resolves.toMatchObject({ label: "first" });
  });

  it("drains a retired worker and retires it within a second of its last exchange", async () => {
    const { host, path, supervisor, url, whoami } = await startSupervisor();
    const disposeFirst = vi.fn(async () => undefined);
    const streamGate = path("stream-gate");
    await supervisor.swapTo(host({ label: "first" }, disposeFirst));
    const streaming = await fetch(url(`/stream?gate=${encodeURIComponent(streamGate)}`));
    const reader = streaming.body!.getReader();
    await reader.read();

    await supervisor.swapTo(host({ label: "second" }));
    await expect(whoami()).resolves.toMatchObject({ label: "second" });
    expect(disposeFirst).not.toHaveBeenCalled();

    await open(streamGate);
    await readToEnd(reader);
    await vi.waitFor(() => expect(disposeFirst).toHaveBeenCalledOnce(), { timeout: 1_000 });
  });

  it.each([
    {
      name: "cancels a streamed response",
      admit: async (context: Awaited<ReturnType<typeof startSupervisor>>) => {
        const streaming = await fetch(context.url(`/stream?gate=${context.path("never")}`));
        const reader = streaming.body!.getReader();
        await reader.read();
        return async () => await reader.cancel();
      },
    },
    {
      name: "aborts an upload before response headers",
      admit: async (context: Awaited<ReturnType<typeof startSupervisor>>) => {
        const abort = new AbortController();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial-upload"));
          },
        });
        const upload = fetch(context.url("/upload"), {
          body,
          duplex: "half",
          method: "POST",
          signal: abort.signal,
        } as RequestInit).catch(() => undefined);
        await vi.waitFor(async () => {
          const seen = (await (await fetch(context.url("/seen"))).json()) as string[];
          expect(seen).toContain("/upload");
        });
        return async () => {
          abort.abort();
          await upload;
        };
      },
    },
  ])("releases a retired worker when its client $name", async ({ admit }) => {
    const context = await startSupervisor();
    const disposeFirst = vi.fn(async () => undefined);
    await context.supervisor.swapTo(context.host({}, disposeFirst));
    const leave = await admit(context);

    await context.supervisor.swapTo(context.host());
    expect(disposeFirst).not.toHaveBeenCalled();
    await leave();
    await vi.waitFor(() => expect(disposeFirst).toHaveBeenCalledOnce());
  });

  it("waits for a retired host's disposal before close resolves", async () => {
    const { host, supervisor } = await startSupervisor();
    const disposeStarted = Promise.withResolvers<void>();
    const finishDispose = Promise.withResolvers<void>();
    const disposeFirst = vi.fn(async () => {
      disposeStarted.resolve();
      await finishDispose.promise;
    });

    await supervisor.swapTo(host({}, disposeFirst));
    await supervisor.swapTo(host());
    await disposeStarted.promise;

    let closed = false;
    const closing = supervisor.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    finishDispose.resolve();
    await closing;
    expect(disposeFirst).toHaveBeenCalledOnce();
  });

  it("restarts a crashed worker on its own host", async () => {
    const { host, supervisor, url, whoami } = await startSupervisor();
    const dispose = vi.fn(async () => undefined);
    await supervisor.swapTo(host({ label: "first" }, dispose));
    const before = await whoami();

    await fetch(url("/crash"));
    await vi.waitFor(
      async () => {
        const after = await whoami();
        expect(after.label).toBe("first");
        expect(after.id).not.toBe(before.id);
      },
      { timeout: 5_000 },
    );
    expect(dispose).not.toHaveBeenCalled();

    await supervisor.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a host's workspace until its last recycled or spare worker retires", async () => {
    const { host, path, supervisor, whoami } = await startSupervisor();
    const bootLog = path("boots.log");
    const boots = async () => (await lines(bootLog)).length;
    const disposeFirst = vi.fn(async () => undefined);
    const disposeSecond = vi.fn(async () => undefined);

    await supervisor.swapTo(host({ bootLog, label: "first" }, disposeFirst));
    const first = await whoami();
    await supervisor.recycle();
    const recycled = await whoami();
    expect(recycled).toMatchObject({ label: "first" });
    expect(recycled.id).not.toBe(first.id);

    supervisor.prepareSpare();
    await supervisor.recycle();
    expect((await whoami()).id).not.toBe(recycled.id);
    // The recycle took the spare instead of booting a worker of its own.
    await expect(boots()).resolves.toBe(3);
    expect(disposeFirst).not.toHaveBeenCalled();

    supervisor.prepareSpare();
    await supervisor.swapTo(host({ label: "second" }, disposeSecond));
    await expect(whoami()).resolves.toMatchObject({ label: "second" });
    await vi.waitFor(() => expect(disposeFirst).toHaveBeenCalledOnce());
    expect(disposeSecond).not.toHaveBeenCalled();

    await supervisor.close();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });

  it("runs a discarded spare's close hooks", async () => {
    const { host, path, supervisor } = await startSupervisor();
    const bootLog = path("boots.log");
    const closeMarker = path("closed.log");
    await supervisor.swapTo(host({ bootLog, closeMarker }));
    supervisor.prepareSpare();
    await vi.waitFor(async () => expect(await lines(bootLog)).toHaveLength(2));

    // A new host retires the active worker and discards the old host's spare.
    await supervisor.swapTo(host());
    const booted = await lines(bootLog);
    await vi.waitFor(async () => expect((await lines(closeMarker)).sort()).toEqual(booted.sort()));
  });

  it("lets a swap already in flight win over a crash restart", async () => {
    const { host, logs, path, supervisor, url, whoami } = await startSupervisor();
    const disposeFirst = vi.fn(async () => undefined);
    const bootGate = path("second-boot");
    await supervisor.swapTo(host({ label: "first" }, disposeFirst));

    const second = supervisor.swapTo(host({ bootGate, label: "second" }));
    await fetch(url("/crash"));
    await vi.waitFor(() => expect(logs).toContain("[eve:dev] dev worker exited; restarting."));
    await open(bootGate);
    await second;
    // Queued behind the restart, so the restart has run once this settles; a
    // restart that swapped retired code back in would recycle to it.
    await supervisor.recycle();

    await expect(whoami()).resolves.toMatchObject({ label: "second" });
    expect(disposeFirst).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a candidate",
      begin: (context: Awaited<ReturnType<typeof startSupervisor>>) =>
        context.supervisor.swapTo(context.host({ bootGate: context.path("never") })),
    },
    {
      name: "the spare a recycle waits on",
      begin: (context: Awaited<ReturnType<typeof startSupervisor>>) => {
        context.supervisor.prepareSpare();
        return context.supervisor.recycle();
      },
    },
  ])("closes promptly while $name is still booting", async ({ begin }) => {
    const context = await startSupervisor();
    const bootGate = context.path("boot-gate");
    await open(bootGate);
    await context.supervisor.swapTo(context.host({ bootGate }));
    // Workers booted from here on wait forever.
    await rm(bootGate);

    const pending = begin(context);
    pending.catch(() => undefined);
    // Let the swap start waiting on its booting worker.
    await new Promise((resolve) => setImmediate(resolve));
    const startedAt = performance.now();
    await context.supervisor.close();
    expect(performance.now() - startedAt).toBeLessThan(DEV_SERVER_CLOSE_BUDGET_MS);
    await expect(pending).rejects.toThrow();
  });

  it("closes within the CLI budget with a response streaming, running the worker's close hooks", async () => {
    const { host, path, supervisor, url } = await startSupervisor();
    const closeMarker = path("closed.txt");
    await supervisor.swapTo(host({ closeMarker }));
    const streaming = await fetch(url(`/stream?gate=${path("never")}`));
    const reader = streaming.body!.getReader();
    await reader.read();

    const startedAt = performance.now();
    await Promise.all([supervisor.close(), supervisor.close()]);
    expect(performance.now() - startedAt).toBeLessThan(DEV_SERVER_CLOSE_BUDGET_MS);
    await expect(lines(closeMarker)).resolves.toHaveLength(1);
    await reader.cancel().catch(() => undefined);
  });

  it("terminates the client connection when a worker response fails mid-stream", async () => {
    const { host, path, supervisor, url } = await startSupervisor();
    const failGate = path("fail-gate");
    await supervisor.swapTo(host());
    const response = await fetch(url(`/fail-stream?gate=${encodeURIComponent(failGate)}`));
    const reader = response.body!.getReader();
    await reader.read();

    await open(failGate);
    // A truncated stream must reach the client as a failure, never as a
    // cleanly terminated response.
    await expect(readToEnd(reader)).rejects.toThrow();
  });

  it("stamps a signed client address on requests and strips forged copies", async () => {
    const secret = "scenario-transport-secret";
    const { host, supervisor, url } = await startSupervisor();
    supervisor.setClientAddressSecret(secret);
    await supervisor.swapTo(host());

    const response = await fetch(url("/headers"), {
      headers: { [ADDRESS]: "203.0.113.7", [SIGNATURE]: "forged" },
    });
    const seen = (await response.json()) as { address: string; signature: string };

    expect(seen.address).toBe("127.0.0.1");
    expect(
      readTrustedDevelopmentClientAddress(
        new Headers({ [ADDRESS]: seen.address, [SIGNATURE]: seen.signature }),
        secret,
      ),
    ).toBe("127.0.0.1");
  });

  it("proxies WebSocket upgrades to the worker with a signed client address", async () => {
    const secret = "scenario-websocket-transport-secret";
    const { host, listener, supervisor } = await startSupervisor();
    supervisor.setClientAddressSecret(secret);
    await supervisor.swapTo(host());
    const target = new URL(listener.url!);

    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
        socket.write(
          [
            "GET / HTTP/1.1",
            "Host: localhost",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            `${ADDRESS}: 203.0.113.7`,
            `${SIGNATURE}: forged`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.once("error", reject);
    });
    const headers = new Map(
      handshake
        .split("\r\n")
        .slice(1)
        .map((line) => [
          line.slice(0, line.indexOf(":")).toLowerCase(),
          line.slice(line.indexOf(":") + 1).trim(),
        ]),
    );
    expect(handshake.startsWith("HTTP/1.1 101")).toBe(true);
    expect(headers.get("x-seen-address")).toBe("127.0.0.1");
    expect(
      readTrustedDevelopmentClientAddress(
        new Headers({
          [ADDRESS]: headers.get("x-seen-address") ?? "",
          [SIGNATURE]: headers.get("x-seen-signature") ?? "",
        }),
        secret,
      ),
    ).toBe("127.0.0.1");

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(new URL("/", target.href.replace(/^http/, "ws")));
      socket.addEventListener("open", () => socket.send("ping"));
      socket.addEventListener("message", (event) => {
        resolve(String(event.data));
        socket.close();
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed.")));
    });
    expect(echoed).toBe("ping");
  });

  it("answers control requests without admitting them to the worker", async () => {
    const { host, supervisor, url } = await startSupervisor();
    supervisor.setControlHandler(async (request) =>
      new URL(request.url).pathname === "/control" ? new Response("parent") : undefined,
    );
    await supervisor.swapTo(host());

    await expect((await fetch(url("/control"))).text()).resolves.toBe("parent");
    await expect((await fetch(url("/seen"))).json()).resolves.toEqual(["/seen"]);
  });

  it("cancels parent-owned Workflow streams before their first chunk", async () => {
    const appRoot = await createDirectory("eve-dev-world-stream-cancel-");
    const secret = "scenario-workflow-transport-secret";
    const world = createParentDevelopmentWorkflowWorld({
      agentName: "dev-world-stream-cancel-test",
      appRoot,
      resolveActiveGenerationId: () => "generation-a",
      transportSecret: secret,
    });
    const supervisor = new DevHostSupervisor({ error: () => undefined });
    supervisor.setControlHandler(async (request) => await world.handleRequest(request));
    const listener = supervisor.listen({ hostname: "127.0.0.1", port: 0 });
    await listener.ready();
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", listener.url);
    vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, secret);
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, appRoot);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    try {
      await world.start();
      const worker = createDevelopmentWorkflowWorld();
      for (let index = 0; index < 12; index += 1) {
        const stream = await worker.streams.get(
          "wrun_http_cancel_test",
          "strm_http_cancel_test_system_abort",
        );
        await stream.cancel();
      }

      const maxListenerWarnings = emitWarning.mock.calls.filter(
        ([warning]) => warning instanceof Error && warning.name === "MaxListenersExceededWarning",
      );
      expect(maxListenerWarnings).toEqual([]);
    } finally {
      emitWarning.mockRestore();
      vi.unstubAllEnvs();
      await supervisor.close();
      await world.close();
    }
  });
});
