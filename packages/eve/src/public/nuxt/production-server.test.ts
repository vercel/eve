import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ cluster: false, thread: false }));
vi.mock("node:cluster", () => ({
  default: {
    get isWorker() {
      return workers.cluster;
    },
  },
}));
vi.mock("node:worker_threads", () => ({
  get isMainThread() {
    return !workers.thread;
  },
}));

vi.mock("#shared/framework-eve-server.js", () => ({
  startEveProductionServer: vi.fn(async () => ({ origin: "http://127.0.0.1:5000" })),
}));

const { startEveProductionServer } = await import("#shared/framework-eve-server.js");
const { ensureEveProductionServer, default: createPlugin } = await import("./production-server.js");
const config = { origin: "http://127.0.0.1:5000", relativeRoot: "agent" };

beforeEach(() => {
  vi.stubEnv("EVE_NUXT_PRODUCTION_ROOT", undefined);
  vi.stubEnv("NITRO_SHUTDOWN_DISABLED", undefined);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.nuxt.production-server")];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  workers.cluster = false;
  workers.thread = false;
});

describe("ensureEveProductionServer", () => {
  it("starts once with the build-time destination, not runtime routing variables", async () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "6000");
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    await Promise.all([ensureEveProductionServer(config), ensureEveProductionServer(config)]);

    expect(startEveProductionServer).toHaveBeenCalledTimes(1);
    expect(startEveProductionServer).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: resolve("agent"),
        origin: "http://127.0.0.1:5000",
      }),
    );
  });

  it.each(["./other-agent", "/srv/agent"])(
    "normalizes the runtime root override %s",
    async (root) => {
      vi.stubEnv("EVE_NUXT_PRODUCTION_ROOT", root);

      await ensureEveProductionServer(config);

      expect(startEveProductionServer).toHaveBeenCalledWith(
        expect.objectContaining({ appRoot: resolve(root) }),
      );
    },
  );

  it("rejects a shared Nuxt and eve output even with a wrapper entry point", async () => {
    await expect(ensureEveProductionServer({ ...config, relativeRoot: "" })).rejects.toThrow(
      /separate eveRoot directory/,
    );
    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it("refuses to respawn the running Nuxt entry", async () => {
    const argv = process.argv[1];
    process.argv[1] = resolve("agent/.output/server/index.mjs");
    try {
      await expect(ensureEveProductionServer(config)).rejects.toThrow(/Nuxt server output/);
    } finally {
      process.argv[1] = argv as string;
    }
    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it.each(["cluster", "thread"] as const)(
    "rejects managed startup in a %s worker",
    async (kind) => {
      workers[kind] = true;
      await expect(ensureEveProductionServer(config)).rejects.toThrow(
        /EVE_NUXT_PRODUCTION_ORIGIN.*building Nuxt/,
      );
      expect(startEveProductionServer).not.toHaveBeenCalled();
    },
  );

  it("requires Nitro graceful shutdown for managed startup", async () => {
    vi.stubEnv("NITRO_SHUTDOWN_DISABLED", "1");
    await expect(ensureEveProductionServer(config)).rejects.toThrow(
      /Unset NITRO_SHUTDOWN_DISABLED/,
    );
    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it("cancels startup before Nitro drains requests and awaits termination on close", async () => {
    vi.stubEnv("NITRO_SHUTDOWN_SIGNALS", " SIGUSR2 ");
    const originalListeners = process.listenerCount("SIGUSR2");
    const once = vi.spyOn(process, "once");
    let close: (() => Promise<void>) | undefined;
    let finish!: () => void;
    const terminated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(startEveProductionServer).mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      await terminated;
      throw new Error("cancelled");
    });
    const hook = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createPlugin(config)({ hooks: { hook } });
      close = hook.mock.calls.find(([name]) => name === "close")![1] as () => Promise<void>;
      const beginShutdown = once.mock.calls.find(([name]) => name === "SIGUSR2")?.[1];
      expect(beginShutdown).toBeTypeOf("function");
      beginShutdown!();
      expect(vi.mocked(startEveProductionServer).mock.calls[0]![0].signal!.aborted).toBe(true);
      let closed = false;
      const closing = close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await closing;
      expect(closed).toBe(true);
      expect(process.listenerCount("SIGUSR2")).toBe(originalListeners);
    } finally {
      finish();
      await close?.();
      vi.restoreAllMocks();
    }
  });

  it("retries after a failed start", async () => {
    vi.mocked(startEveProductionServer).mockRejectedValueOnce(new Error("port in use"));
    await expect(ensureEveProductionServer(config)).rejects.toThrow("port in use");
    await ensureEveProductionServer(config);
    expect(startEveProductionServer).toHaveBeenCalledTimes(2);
  });
});
