import { connect } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  DrainedNitroDevServer,
  type DrainedDevServerListener,
} from "#internal/nitro/host/drained-nitro-dev-server.js";
import {
  DEVELOPMENT_CLIENT_ADDRESS_HEADER,
  DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER,
  readTrustedDevelopmentClientAddress,
} from "#internal/nitro/dev-client-address.js";
import type {
  DevelopmentRunner,
  DevelopmentRunnerFactory,
} from "#internal/nitro/host/dev-runner.js";

const TEST_DEADLINE_MS = 5_000;
const LOGGER = { error: () => undefined };

interface TestRunner extends DevelopmentRunner {
  crash(cause: Error): void;
  readonly closeMock: ReturnType<typeof vi.fn>;
}

function createRunnerFactory(
  fetchHandler: (request: Request, runnerIndex: number, init?: RequestInit) => Promise<Response>,
  readiness: (runnerIndex: number) => Promise<void> = async () => undefined,
): { readonly createRunner: DevelopmentRunnerFactory; readonly runners: TestRunner[] } {
  const runners: TestRunner[] = [];
  const createRunner: DevelopmentRunnerFactory = () => {
    const runnerIndex = runners.length;
    let closed = false;
    const closedListeners = new Set<(cause?: unknown) => void>();
    const notifyClosed = (cause?: unknown) => {
      const listeners = [...closedListeners];
      closedListeners.clear();
      for (const listener of listeners) {
        listener(cause);
      }
    };
    const closeMock = vi.fn(async () => {
      closed = true;
      notifyClosed();
    });
    const runner: TestRunner = {
      close: closeMock,
      closeMock,
      get closed() {
        return closed;
      },
      crash(cause) {
        closed = true;
        notifyClosed(cause);
      },
      fetch: async (request, init) => await fetchHandler(request, runnerIndex, init),
      onceClosed(listener) {
        if (closed) {
          listener();
          return;
        }
        closedListeners.add(listener);
      },
      upgrade: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => await readiness(runnerIndex)),
    };
    runners.push(runner);
    return runner;
  };
  return { createRunner, runners };
}

function replacement(entry: string, dispose?: () => Promise<void>) {
  return { dispose, entry, workerData: {} };
}

async function listen(server: DrainedNitroDevServer): Promise<DrainedDevServerListener> {
  const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
  await listener.ready();
  if (listener.url === undefined) {
    throw new Error("Listener did not expose a URL.");
  }
  return listener;
}

async function withinDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), TEST_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("drained Nitro dev server", () => {
  it("keeps the previous worker serving when a candidate fails readiness", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(`runner-${String(runnerIndex)}`),
      async (runnerIndex) => {
        if (runnerIndex === 1) {
          throw new Error("candidate failed");
        }
      },
    );
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);

    await server.replaceWorker(replacement("/tmp/first.mjs"));
    await expect(server.replaceWorker(replacement("/tmp/second.mjs"))).rejects.toThrow(
      "candidate failed",
    );
    expect(runners[1]?.closeMock).toHaveBeenCalled();
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-0");

    await server.close();
  });

  it("drains the retired worker and disposes it after its last exchange settles", async () => {
    let releaseFirstResponse: (() => void) | undefined;
    const { createRunner, runners } = createRunnerFactory(async (_request, runnerIndex) => {
      if (runnerIndex === 0) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("started\n"));
            releaseFirstResponse = () => controller.close();
          },
        });
        return new Response(body);
      }
      return new Response("runner-1");
    });
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    const disposeFirst = vi.fn(async () => undefined);

    await server.replaceWorker(replacement("/tmp/first.mjs", disposeFirst));
    const streaming = await fetch(new URL("/", listener.url));
    const reader = streaming.body?.getReader();
    await reader?.read();

    await server.replaceWorker(replacement("/tmp/second.mjs"));
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-1");
    expect(runners[0]?.closeMock).not.toHaveBeenCalled();
    expect(disposeFirst).not.toHaveBeenCalled();

    releaseFirstResponse?.();
    await withinDeadline(
      (async () => {
        for (;;) {
          const result = await reader?.read();
          if (result === undefined || result.done) {
            return;
          }
        }
      })(),
      "Timed out waiting for the retired stream to finish.",
    );
    await vi.waitFor(() => {
      expect(runners[0]?.closeMock).toHaveBeenCalled();
      expect(disposeFirst).toHaveBeenCalledOnce();
    });

    await server.close();
  });

  it("restarts the worker with its own workspace when it exits unexpectedly", async () => {
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(`runner-${String(runnerIndex)}`),
    );
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    const dispose = vi.fn(async () => undefined);
    await server.replaceWorker(replacement("/tmp/first.mjs", dispose));

    runners[0]?.crash(new Error("worker exploded"));
    await withinDeadline(
      vi.waitFor(async () => {
        const response = await fetch(new URL("/", listener.url));
        expect(await response.text()).toBe("runner-1");
      }),
      "Timed out waiting for the restarted worker.",
    );
    expect(dispose).not.toHaveBeenCalled();

    await server.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("destroys the socket when an upgrade fails and closes idempotently", async () => {
    const { createRunner, runners } = createRunnerFactory(async () => new Response("ok"));
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    await server.replaceWorker(replacement("/tmp/first.mjs"));
    (runners[0] as { upgrade: unknown }).upgrade = vi.fn(async () => {
      throw new Error("upgrade rejected");
    });

    const target = new URL(listener.url ?? "");
    await withinDeadline(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
          socket.write(
            "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
        });
        socket.once("close", () => resolve());
        socket.once("error", reject);
      }),
      "Timed out waiting for the failed upgrade socket to close.",
    );

    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(runners[0]?.closeMock).toHaveBeenCalledOnce();
  });

  it("lets an in-flight replacement win over a crash restart", async () => {
    let releaseCandidate: (() => void) | undefined;
    const { createRunner, runners } = createRunnerFactory(
      async (_request, runnerIndex) => new Response(`runner-${String(runnerIndex)}`),
      async (runnerIndex) => {
        if (runnerIndex === 1) {
          await new Promise<void>((resolve) => {
            releaseCandidate = resolve;
          });
        }
      },
    );
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    const disposeFirst = vi.fn(async () => undefined);
    await server.replaceWorker(replacement("/tmp/first.mjs", disposeFirst));

    const second = server.replaceWorker(replacement("/tmp/second.mjs"));
    await withinDeadline(
      vi.waitFor(() => {
        expect(releaseCandidate).toBeDefined();
      }),
      "Timed out waiting for the candidate to start readiness.",
    );
    runners[0]?.crash(new Error("worker exploded"));
    releaseCandidate?.();
    await second;

    // The queued crash restart must yield to the replacement that was
    // already in flight instead of swapping retired code back in.
    await expect(
      fetch(new URL("/", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("runner-1");
    await vi.waitFor(() => {
      expect(disposeFirst).toHaveBeenCalledOnce();
    });
    expect(runners).toHaveLength(2);

    await server.close();
  });

  it("releases the exchange when a client aborts before response headers", async () => {
    let sawRequest: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    const { createRunner, runners } = createRunnerFactory(async (_request, runnerIndex, init) => {
      if (runnerIndex === 0) {
        sawRequest?.();
        return await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return new Response("runner-1");
    });
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    const disposeFirst = vi.fn(async () => undefined);
    await server.replaceWorker(replacement("/tmp/first.mjs", disposeFirst));

    const abort = new AbortController();
    const hung = fetch(new URL("/", listener.url), { signal: abort.signal }).catch(() => undefined);
    await withinDeadline(requestSeen, "Timed out waiting for the hung request to be admitted.");
    abort.abort();
    await hung;

    await server.replaceWorker(replacement("/tmp/second.mjs"));
    await withinDeadline(
      vi.waitFor(() => {
        expect(runners[0]?.closeMock).toHaveBeenCalled();
        expect(disposeFirst).toHaveBeenCalledOnce();
      }),
      "Timed out waiting for the aborted exchange to release the retired worker.",
    );

    await server.close();
  });

  it("closes within a bounded interval while a candidate is mid-readiness", async () => {
    const { createRunner } = createRunnerFactory(
      async () => new Response("ok"),
      async (runnerIndex) => {
        if (runnerIndex === 1) {
          await new Promise<never>(() => undefined);
        }
      },
    );
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    await listen(server);
    await server.replaceWorker(replacement("/tmp/first.mjs"));

    const pending = server.replaceWorker(replacement("/tmp/second.mjs"));
    pending.catch(() => undefined);
    await withinDeadline(server.close(), "Timed out closing during a pending replacement.");
    await expect(pending).rejects.toThrow();
  });

  it("terminates the client connection when a worker response fails mid-stream", async () => {
    let failStream: (() => void) | undefined;
    const { createRunner } = createRunnerFactory(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("started\n"));
          failStream = () => controller.error(new Error("worker stream died"));
        },
      });
      return new Response(body);
    });
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    const listener = await listen(server);
    await server.replaceWorker(replacement("/tmp/first.mjs"));

    const response = await fetch(new URL("/", listener.url));
    const reader = response.body?.getReader();
    await reader?.read();
    failStream?.();

    // A truncated stream must surface as a client-visible failure, never as
    // a cleanly terminated response.
    await expect(
      withinDeadline(
        (async () => {
          for (;;) {
            const result = await reader?.read();
            if (result === undefined || result.done) {
              return;
            }
          }
        })(),
        "Timed out waiting for the failed stream to settle.",
      ),
    ).rejects.toThrow();

    await server.close();
  });

  it("stamps a signed client address and strips forged copies", async () => {
    const SECRET = "scenario-transport-secret";
    const { createRunner } = createRunnerFactory(async (request) =>
      Response.json({
        address: request.headers.get(DEVELOPMENT_CLIENT_ADDRESS_HEADER),
        signature: request.headers.get(DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER),
      }),
    );
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    server.setClientAddressSecret(SECRET);
    const listener = await listen(server);
    await server.replaceWorker(replacement("/tmp/first.mjs"));

    const response = await fetch(new URL("/", listener.url), {
      headers: {
        [DEVELOPMENT_CLIENT_ADDRESS_HEADER]: "203.0.113.7",
        [DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER]: "forged",
      },
    });
    const body = (await response.json()) as { address: string | null; signature: string | null };

    // The forged public copy is replaced by the socket peer, and the stamped
    // value carries a signature the worker can verify.
    expect(body.address).toBe("127.0.0.1");
    expect(body.signature).not.toBe("forged");
    const verified = readTrustedDevelopmentClientAddress(
      new Headers({
        [DEVELOPMENT_CLIENT_ADDRESS_HEADER]: body.address ?? "",
        [DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER]: body.signature ?? "",
      }),
      SECRET,
    );
    expect(verified).toBe("127.0.0.1");

    await server.close();
  });

  it("answers control requests without admitting them to the worker", async () => {
    const fetchMock = vi.fn(async () => new Response("worker"));
    const { createRunner } = createRunnerFactory(fetchMock);
    const server = new DrainedNitroDevServer(LOGGER, createRunner);
    server.setControlHandler(async (request) =>
      new URL(request.url).pathname === "/control" ? new Response("parent") : undefined,
    );
    const listener = await listen(server);
    await server.replaceWorker(replacement("/tmp/first.mjs"));

    await expect(
      fetch(new URL("/control", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("parent");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      fetch(new URL("/other", listener.url)).then(async (response) => await response.text()),
    ).resolves.toBe("worker");

    await server.close();
  });
});
