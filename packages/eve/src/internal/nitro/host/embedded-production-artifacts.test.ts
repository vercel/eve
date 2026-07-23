import type { Nitro } from "nitro/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
}));

vi.mock("#internal/application/production-compiler-artifacts.js", () => ({
  stageProductionCompilerArtifacts: mocks.stage,
}));

import { configureEmbeddedProductionArtifacts } from "./embedded-production-artifacts.js";

describe("configureEmbeddedProductionArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a writeBundle stage without replacing host plugins", async () => {
    let rollupBefore: ((_nitro: Nitro, config: { plugins?: unknown[] }) => void) | undefined;
    const nitro = Object.assign({} as Nitro, {
      hooks: {
        hook: vi.fn((name: string, handler: typeof rollupBefore) => {
          expect(name).toBe("rollup:before");
          rollupBefore = handler;
        }),
      },
    });
    const hostPlugin = { name: "host" };
    const config: { plugins: unknown[] } = { plugins: [hostPlugin] };

    configureEmbeddedProductionArtifacts({
      compilerArtifactsRoot: "/host/.eve/build/compiler/.eve",
      nitro,
      outputDir: "/host/custom-output",
    });
    rollupBefore?.(nitro, config);

    expect(config.plugins[0]).toBe(hostPlugin);
    const plugin = config.plugins[1];
    if (
      plugin === null ||
      typeof plugin !== "object" ||
      !("writeBundle" in plugin) ||
      typeof plugin.writeBundle !== "function"
    ) {
      throw new TypeError("Expected an embedded production writeBundle plugin.");
    }
    await plugin.writeBundle();
    expect(mocks.stage).toHaveBeenCalledWith({
      compilerArtifactsRoot: "/host/.eve/build/compiler/.eve",
      outputDir: "/host/custom-output",
    });
  });
});
