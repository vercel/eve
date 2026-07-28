import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  eveModule: { name: "eve:nitro" },
  eveNitro: vi.fn(),
  nitroPlugin: { name: "nitro" },
}));

vi.mock("#internal/nitro/host/build-embedded-astro-nitro.js", () => ({
  buildEmbeddedAstroNitro: mocks.build,
}));

vi.mock("#public/nitro/module.js", () => ({
  eveNitro: mocks.eveNitro,
}));

vi.mock("nitro/vite", () => ({
  nitro: vi.fn(() => [mocks.nitroPlugin]),
}));

import { eveNitroAstro } from "./astro.js";

function createResolvedAstroConfig() {
  return {
    build: {
      client: new URL("file:///workspace/dist/client/"),
      server: new URL("file:///workspace/dist/server/"),
      serverEntry: "entry.mjs",
    },
    root: new URL("file:///workspace/"),
  };
}

describe("eveNitroAstro", () => {
  it("installs the embedded Nitro host only in Astro development", () => {
    mocks.eveNitro.mockReturnValue({ nitro: mocks.eveModule, name: "eve:nitro" });
    const integration = eveNitroAstro({ agent: "agents/support" });
    const updateDevelopmentConfig = vi.fn();
    const updateBuildConfig = vi.fn();

    integration.hooks["astro:config:setup"]({
      command: "dev",
      updateConfig: updateDevelopmentConfig,
    });
    integration.hooks["astro:config:setup"]({
      command: "build",
      updateConfig: updateBuildConfig,
    });

    expect(mocks.eveNitro).toHaveBeenCalledWith({ agent: "agents/support" });
    expect(updateDevelopmentConfig).toHaveBeenCalledWith({
      vite: {
        plugins: [
          expect.objectContaining({ name: "eve:nitro" }),
          mocks.nitroPlugin,
          expect.objectContaining({ name: "eve:nitro:astro-entry" }),
        ],
      },
    });
    expect(updateBuildConfig).toHaveBeenCalledWith({
      vite: {
        plugins: [expect.objectContaining({ name: "eve:nitro:astro-entry" })],
      },
    });
  });

  it("registers Astro's server entry and declared adapter capabilities", () => {
    const integration = eveNitroAstro();
    const setAdapter = vi.fn();

    integration.hooks["astro:config:done"]({
      config: createResolvedAstroConfig(),
      setAdapter,
    });

    expect(setAdapter).toHaveBeenCalledWith({
      adapterFeatures: { buildOutput: "server", middlewareMode: "classic" },
      entrypointResolution: "auto",
      name: "eve:nitro:astro",
      serverEntrypoint: "virtual:eve-nitro-astro-entry",
      supportedAstroFeatures: {
        hybridOutput: "stable",
        serverOutput: "stable",
        sharpImageService: "stable",
        staticOutput: "unsupported",
      },
    });
  });

  it("packages the completed Astro server from the build-done lifecycle", async () => {
    mocks.eveNitro.mockReturnValue({ nitro: mocks.eveModule, name: "eve:nitro" });
    const integration = eveNitroAstro({ agent: "agents/support", preset: "bun" });

    integration.hooks["astro:config:done"]({
      config: createResolvedAstroConfig(),
      setAdapter: vi.fn(),
    });
    await integration.hooks["astro:build:done"]({
      dir: new URL("file:///workspace/dist/"),
    });

    expect(mocks.build).toHaveBeenCalledWith({
      astroClientDirectory: "/workspace/dist/client/",
      astroServerEntry: "/workspace/dist/server/entry.mjs",
      eveModule: mocks.eveModule,
      outputDirectory: "/workspace/.output",
      preset: "bun",
      rootDirectory: "/workspace/",
    });
  });

  it("rejects a build that bypassed Astro adapter configuration", async () => {
    const integration = eveNitroAstro();

    await expect(
      integration.hooks["astro:build:done"]({ dir: new URL("file:///workspace/dist/") }),
    ).rejects.toThrow("before the eve Nitro adapter was configured");
  });
});
