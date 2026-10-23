import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  startEveProductionServer: vi.fn(async () => ({ origin: "http://127.0.0.1:4274" })),
}));

const { startEveProductionServer } = await import("#shared/framework-eve-server.js");
const { ensureEveProductionServer } = await import("./production-server.js");

const globalStateSymbol = Symbol.for("eve.nuxt.production-server");

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[globalStateSymbol];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("ensureEveProductionServer", () => {
  it("starts the built eve server once per process", async () => {
    await ensureEveProductionServer();
    await ensureEveProductionServer();

    expect(startEveProductionServer).toHaveBeenCalledTimes(1);
    expect(startEveProductionServer).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "Nuxt", slug: "nuxt" },
      origin: "http://127.0.0.1:4274",
      portRetryHint: "set EVE_NUXT_PRODUCTION_PORT to another port",
    });
  });

  it("serves the root and port the environment configures", async () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_PORT", "5000");
    vi.stubEnv("EVE_NUXT_PRODUCTION_ROOT", "/srv/agent");

    await ensureEveProductionServer();

    expect(startEveProductionServer).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: "/srv/agent", origin: "http://127.0.0.1:5000" }),
    );
  });

  it("does not start a server on Vercel", async () => {
    vi.stubEnv("VERCEL", "1");

    await ensureEveProductionServer();

    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it("does not start a server when an external origin owns eve routes", async () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    await ensureEveProductionServer();

    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it("refuses to respawn the Nuxt server as eve", async () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ROOT", "/srv/app");
    const argv = process.argv[1];
    process.argv[1] = "/srv/app/.output/server/index.mjs";

    try {
      await expect(ensureEveProductionServer()).rejects.toThrow(/running Nuxt server/);
    } finally {
      process.argv[1] = argv as string;
    }

    expect(startEveProductionServer).not.toHaveBeenCalled();
  });

  it("retries after a failed start", async () => {
    vi.mocked(startEveProductionServer).mockRejectedValueOnce(new Error("port in use"));

    await expect(ensureEveProductionServer()).rejects.toThrow("port in use");
    await ensureEveProductionServer();

    expect(startEveProductionServer).toHaveBeenCalledTimes(2);
  });
});
