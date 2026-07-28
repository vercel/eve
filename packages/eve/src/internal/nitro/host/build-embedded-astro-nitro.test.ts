import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  close: vi.fn(),
  copyPublicAssets: vi.fn(),
  createNitro: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  prepare: vi.fn(),
  prerender: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp,
  rename: mocks.rename,
  rm: mocks.rm,
}));

vi.mock("nitro/builder", () => ({
  build: mocks.build,
  copyPublicAssets: mocks.copyPublicAssets,
  createNitro: mocks.createNitro,
  prepare: mocks.prepare,
  prerender: mocks.prerender,
}));

vi.mock("#internal/application/package.js", () => ({
  resolvePackageSourceFilePath: vi.fn(() => "/eve/embedded-astro-renderer.ts"),
}));

import { buildEmbeddedAstroNitro } from "./build-embedded-astro-nitro.js";

describe("buildEmbeddedAstroNitro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createNitro.mockResolvedValue({ close: mocks.close });
    mocks.mkdtemp.mockResolvedValue("/app/.eve/astro-nitro-output-staged");
  });

  it("builds one portable Nitro artifact from Astro and eve inputs", async () => {
    const eveModule = { name: "eve:nitro", setup: vi.fn() };

    await buildEmbeddedAstroNitro({
      astroClientDirectory: "/app/dist/client",
      astroServerEntry: "/app/dist/server/index.mjs",
      eveModule,
      outputDirectory: "/app/.output",
      preset: "node-server",
      rootDirectory: "/app",
    });

    expect(mocks.mkdir).toHaveBeenCalledWith("/app/.eve", { recursive: true });
    expect(mocks.mkdtemp).toHaveBeenCalledWith("/app/.eve/astro-nitro-output-");
    expect(mocks.createNitro).toHaveBeenCalledWith({
      _cli: { command: "build" },
      buildDir: "/app/.eve/astro-nitro",
      dev: false,
      modules: [eveModule],
      output: { dir: "/app/.eve/astro-nitro-output-staged" },
      preset: "node-server",
      publicAssets: [{ baseURL: "/", dir: "/app/dist/client", maxAge: 0 }],
      rolldownConfig: {
        plugins: [expect.objectContaining({ name: "eve:nitro:astro-application" })],
      },
      renderer: { handler: "/eve/embedded-astro-renderer.ts" },
      rollupConfig: { plugins: [expect.objectContaining({ name: "eve:nitro:astro-application" })] },
      rootDir: "/app",
      serverDir: false,
    });
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.copyPublicAssets.mock.invocationCallOrder[0]!,
    );
    expect(mocks.copyPublicAssets.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prerender.mock.invocationCallOrder[0]!,
    );
    expect(mocks.prerender.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.build.mock.invocationCallOrder[0]!,
    );
    expect(mocks.build.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rm.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rm).toHaveBeenCalledWith("/app/.output", { force: true, recursive: true });
    expect(mocks.rename).toHaveBeenCalledWith(
      "/app/.eve/astro-nitro-output-staged",
      "/app/.output",
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes Nitro when bundling fails", async () => {
    mocks.build.mockRejectedValueOnce(new Error("bundle failed"));

    await expect(
      buildEmbeddedAstroNitro({
        astroClientDirectory: "/app/dist/client",
        astroServerEntry: "/app/dist/server/index.mjs",
        eveModule: { name: "eve:nitro", setup: vi.fn() },
        outputDirectory: "/app/.output",
        preset: "node-server",
        rootDirectory: "/app",
      }),
    ).rejects.toThrow("bundle failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.rm).not.toHaveBeenCalledWith("/app/.output", expect.anything());
    expect(mocks.rename).not.toHaveBeenCalled();
  });
});
