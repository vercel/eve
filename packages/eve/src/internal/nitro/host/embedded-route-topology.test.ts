import type { Nitro } from "nitro/types";
import { describe, expect, it, vi } from "vitest";

import {
  replaceLiveChannelVirtualHandlers,
  type NitroChannelRouteRegistration,
} from "#internal/nitro/host/channel-routes.js";
import { stageEmbeddedRouteTopology } from "#internal/nitro/host/embedded-route-topology.js";
import type { DevelopmentNitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";

const artifactsConfig: DevelopmentNitroArtifactsConfig = {
  appRoot: "/app",
  devRuntimeArtifactsPointerPath: "/app/.eve/dev-runtime/latest.json",
  kind: "development",
  moduleMapLoaderPath: "/eve/authored-module-map-loader.js",
};
const previous: readonly NitroChannelRouteRegistration[] = [{ method: "GET", route: "/old" }];
const next: readonly NitroChannelRouteRegistration[] = [{ method: "POST", route: "/new" }];

function createNitro(): Nitro {
  const nitro = Object.assign({} as Nitro, {
    options: { handlers: [], routes: {}, virtual: {} },
    routing: { sync: vi.fn() },
    scannedHandlers: [],
    vfs: new Map(),
  });
  replaceLiveChannelVirtualHandlers(nitro, {
    artifactsConfig,
    next: previous,
    previous: [],
  });
  vi.mocked(nitro.routing.sync).mockClear();
  return nitro;
}

function snapshot(nitro: Nitro) {
  return {
    handlers: structuredClone(nitro.options.handlers),
    vfs: [...nitro.vfs.keys()],
    virtual: structuredClone(nitro.options.virtual),
  };
}

describe("stageEmbeddedRouteTopology", () => {
  it("restores the previous route set when Nitro rejects the staged sync", () => {
    const nitro = createNitro();
    const before = snapshot(nitro);
    vi.mocked(nitro.routing.sync).mockImplementationOnce(() => {
      throw new Error("sync failed");
    });

    expect(() =>
      stageEmbeddedRouteTopology({
        artifactsConfig,
        next,
        nitro,
        previous,
        reload: vi.fn(),
      }),
    ).toThrow("sync failed");

    expect(snapshot(nitro)).toEqual(before);
    expect(nitro.routing.sync).toHaveBeenCalledTimes(2);
  });

  it("reloads only on commit and restores the previous routes on rollback", async () => {
    const nitro = createNitro();
    const before = snapshot(nitro);
    const reload = vi.fn(async () => undefined);
    const replacement = stageEmbeddedRouteTopology({
      artifactsConfig,
      next,
      nitro,
      previous,
      reload,
    });

    expect(reload).not.toHaveBeenCalled();
    await replacement.commit();
    expect(reload).toHaveBeenCalledOnce();

    await replacement.rollback();
    expect(snapshot(nitro)).toEqual(before);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
