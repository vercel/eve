import { resolve } from "node:path";

import type { Nitro, NitroModuleInput } from "nitro/types";
import type { Plugin } from "vite";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
import type { EveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";
import type {
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";

const mocks = vi.hoisted(() => ({
  applyConfigDelta: vi.fn(),
  applyDevelopment: vi.fn(),
  applyProduction: vi.fn(),
  activateGeneration: vi.fn(),
  beginInstallation: vi.fn(),
  commit: vi.fn(),
  createContribution: vi.fn(),
  createEmbeddedCoordinator: vi.fn(),
  createRequirements: vi.fn(),
  createWorkspace: vi.fn(),
  configureProductionArtifacts: vi.fn(),
  discardGeneration: vi.fn(),
  prepareDevelopment: vi.fn(),
  prepareProduction: vi.fn(),
  resolveWatchPaths: vi.fn(),
  removeDevelopmentWorkspace: vi.fn(),
  removeProductionWorkspace: vi.fn(),
  rollback: vi.fn(),
  startViteWatcher: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("#internal/application/build-workspace.js", () => ({
  createApplicationBuildWorkspace: mocks.createWorkspace,
  removeApplicationBuildWorkspace: mocks.removeProductionWorkspace,
}));

vi.mock("#internal/nitro/host/apply-eve-nitro-contribution.js", () => ({
  applyProductionEveNitroContribution: mocks.applyProduction,
  configureInitialStandaloneDevelopmentEveNitroContribution: mocks.applyDevelopment,
}));

vi.mock("#internal/nitro/host/embedded-eve-nitro-requirements.js", () => ({
  createEmbeddedEveNitroRequirements: mocks.createRequirements,
}));

vi.mock("#internal/nitro/host/embedded-production-artifacts.js", () => ({
  configureEmbeddedProductionArtifacts: mocks.configureProductionArtifacts,
}));

vi.mock("#internal/nitro/host/embedded-development-rebuild-coordinator.js", () => ({
  createEmbeddedDevelopmentRebuildCoordinator: mocks.createEmbeddedCoordinator,
}));

vi.mock("#internal/nitro/host/embedded-nitro-host-validation.js", () => ({
  beginEmbeddedEveNitroInstallation: mocks.beginInstallation,
  validateEmbeddedEveNitroHost: mocks.validate,
}));

vi.mock("#internal/nitro/host/eve-nitro-contribution.js", () => ({
  createEveNitroContribution: mocks.createContribution,
}));

vi.mock("#internal/nitro/host/merge-eve-nitro-config.js", () => ({
  applyEveNitroConfigDelta: mocks.applyConfigDelta,
}));

vi.mock("#internal/nitro/host/prepare-application-host.js", () => ({
  prepareDevelopmentApplicationHost: mocks.prepareDevelopment,
  prepareProductionApplicationHost: mocks.prepareProduction,
}));

vi.mock("#internal/nitro/host/dev-authored-source-watcher.js", () => ({
  resolveAuthoredWatchPaths: mocks.resolveWatchPaths,
}));

vi.mock("#internal/nitro/host/embedded-nitro-vite-dev-watcher.js", () => ({
  startEmbeddedNitroViteDevWatcher: mocks.startViteWatcher,
}));

vi.mock("#internal/nitro/development-generation.js", () => ({
  activateDevelopmentGeneration: mocks.activateGeneration,
  discardDevelopmentGeneration: mocks.discardGeneration,
}));

vi.mock("#internal/nitro/host/dev-host-workspace.js", () => ({
  removeDevelopmentHostWorkspace: mocks.removeDevelopmentWorkspace,
}));

import { eveNitro, type EveNitroPlugin } from "./index.js";
import { resolveEveNitroAgentPath } from "./module.js";

const developmentHost = Object.assign({} as PreparedDevelopmentApplicationHost, {
  generation: { snapshotRoot: "/host/.eve/generation" },
  workspace: { rootDir: "/host/.eve/dev-host" },
});
const productionHost = {} as PreparedApplicationHost;
const workspace = {
  compiler: { artifactsDir: "/host/.eve/build/compiler/.eve" },
  rootDir: "/host/.eve/build",
} as ApplicationBuildWorkspace;
const developmentContribution = Object.assign({} as EveNitroContribution<"development">, {
  mode: "development",
  preparedHost: developmentHost,
});
const productionContribution = Object.assign({} as EveNitroContribution<"production">, {
  mode: "production",
  preparedHost: productionHost,
});
const requirements = { routes: [], schedules: false, websocket: false };

function createNitro(input: { dev: boolean; preset?: string; rootDir?: string }) {
  const hooks = new Map<string, () => void | Promise<void>>();
  const routingSync = vi.fn();
  let nitro: Nitro;
  const close = vi.fn(async () => {
    await hooks.get("close")?.();
  });
  nitro = Object.assign({} as Nitro, {
    close,
    hooks: {
      hookOnce: vi.fn((name: string, handler: () => void | Promise<void>) => {
        hooks.set(name, handler);
      }),
    },
    options: {
      dev: input.dev,
      output: { dir: "/host/.output" },
      preset: input.preset,
      rootDir: input.rootDir ?? "/host",
    },
    logger: { error: vi.fn() },
    routing: { sync: routingSync },
  });
  return {
    hooks,
    nitro,
    close,
    routingSync,
    async runHook(name: string) {
      await hooks.get(name)?.();
    },
  };
}

describe("eveNitro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginInstallation.mockReturnValue({
      commit: mocks.commit,
      rollback: mocks.rollback,
    });
    mocks.createContribution.mockImplementation(
      (_preparedHost: unknown, options: { mode: "development" | "production" }) =>
        options.mode === "development" ? developmentContribution : productionContribution,
    );
    mocks.createRequirements.mockReturnValue(requirements);
    mocks.createEmbeddedCoordinator.mockImplementation(
      async (input: { restartHost(): Promise<void> }) => ({
        async rebuild() {
          await input.restartHost();
          return { host: developmentHost, kind: "structural" as const };
        },
      }),
    );
    mocks.createWorkspace.mockResolvedValue(workspace);
    mocks.prepareDevelopment.mockResolvedValue(developmentHost);
    mocks.prepareProduction.mockResolvedValue(productionHost);
    mocks.resolveWatchPaths.mockResolvedValue(["/host/agent"]);
    mocks.startViteWatcher.mockResolvedValue({
      close: vi.fn(async () => undefined),
      stop: vi.fn(),
    });
  });

  it("returns one dual-use Vite plugin and Nitro module without third-party public types", () => {
    const plugin = eveNitro();

    expect(plugin).toMatchObject({
      name: "eve:nitro",
      nitro: { name: "eve:nitro", setup: expect.any(Function) },
    });
    expectTypeOf(plugin).toMatchTypeOf<Plugin>();
    expectTypeOf(plugin).toMatchTypeOf<NitroModuleInput>();
  });

  it("does not compile or create workspaces when the public subpath is imported", async () => {
    vi.resetModules();
    await import("./index.js");

    expect(mocks.prepareDevelopment).not.toHaveBeenCalled();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("prepares and applies the default development agent after validation", async () => {
    const { nitro, routingSync, runHook } = createNitro({ dev: true });

    await eveNitro().nitro.setup(nitro);

    expect(mocks.prepareDevelopment).toHaveBeenCalledWith("/host", {
      agentRoot: resolve("/host", "agent"),
    });
    expect(mocks.createContribution).toHaveBeenCalledWith(developmentHost, {
      host: "embedded",
      mode: "development",
      preset: undefined,
      surface: "all",
    });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.applyConfigDelta).not.toHaveBeenCalled();

    await runHook("build:before");

    expect(mocks.validate).toHaveBeenCalledWith(nitro, requirements);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyConfigDelta.mock.invocationCallOrder[0]!,
    );
    expect(mocks.applyConfigDelta).toHaveBeenCalledWith(nitro, developmentContribution);
    expect(mocks.applyDevelopment).toHaveBeenCalledWith(nitro, developmentContribution);
    expect(mocks.applyProduction).not.toHaveBeenCalled();
    expect(routingSync).toHaveBeenCalledOnce();
    expect(mocks.activateGeneration).toHaveBeenCalledWith({
      appRoot: developmentHost.appRoot,
      generation: developmentHost.generation,
    });
    expect(mocks.commit).toHaveBeenCalledOnce();
  });

  it("normalizes relative and absolute agent locations against the Nitro root", () => {
    expect(resolveEveNitroAgentPath("/host/project", "agents/support")).toBe(
      resolve("/host/project/agents/support"),
    );
    expect(resolveEveNitroAgentPath("/host/project", "/agents/support")).toBe(
      resolve("/agents/support"),
    );
  });

  it("prepares and applies one production contribution without choosing host policy", async () => {
    const { nitro, runHook } = createNitro({ dev: false, preset: "node-server" });

    await eveNitro({ agent: "agents/support" }).nitro.setup(nitro);

    expect(mocks.createWorkspace).toHaveBeenCalledWith("/host", "/host/.output");
    expect(mocks.prepareProduction).toHaveBeenCalledWith(workspace, {
      agentRoot: resolve("/host/agents/support"),
    });
    expect(mocks.createContribution).toHaveBeenCalledWith(productionHost, {
      host: "embedded",
      mode: "production",
      preset: undefined,
      surface: "all",
    });
    expect(mocks.configureProductionArtifacts).toHaveBeenCalledWith({
      compilerArtifactsRoot: workspace.compiler.artifactsDir,
      nitro,
      outputDir: "/host/.output",
    });
    await runHook("build:before");
    expect(mocks.applyProduction).toHaveBeenCalledWith(nitro, productionContribution);
    expect(mocks.applyDevelopment).not.toHaveBeenCalled();
  });

  it("forwards a resolved missing-agent diagnostic and leaves Nitro untouched", async () => {
    const { nitro } = createNitro({ dev: true });
    mocks.prepareDevelopment.mockRejectedValueOnce(
      new Error('Could not resolve an eve agent root from "/host/missing".'),
    );

    await expect(eveNitro({ agent: "missing" }).nitro.setup(nitro)).rejects.toThrow(
      "/host/missing",
    );

    expect(mocks.applyConfigDelta).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });

  it("validates before mutation and cleans up a rejected development host", async () => {
    const { nitro, runHook } = createNitro({ dev: true });
    mocks.validate.mockImplementationOnce(() => {
      throw new Error("route collision");
    });

    await eveNitro().nitro.setup(nitro);
    await expect(runHook("build:before")).rejects.toThrow("route collision");

    expect(mocks.applyConfigDelta).not.toHaveBeenCalled();
    expect(mocks.discardGeneration).toHaveBeenCalledWith(developmentHost.generation);
    expect(mocks.removeDevelopmentWorkspace).toHaveBeenCalledWith(developmentHost.workspace);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("cleans a production workspace when preparation fails", async () => {
    const { nitro } = createNitro({ dev: false, preset: "node-server" });
    mocks.prepareProduction.mockRejectedValueOnce(new Error("compile failed"));

    await expect(eveNitro().nitro.setup(nitro)).rejects.toThrow("compile failed");

    expect(mocks.removeProductionWorkspace).toHaveBeenCalledWith(workspace);
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });

  it("registers idempotent eve-owned cleanup without closing the Nitro listener", async () => {
    const { hooks, nitro, runHook } = createNitro({ dev: true });

    await eveNitro().nitro.setup(nitro);
    expect([...hooks.keys()]).toEqual(["build:before", "close"]);

    await runHook("close");
    await runHook("close");

    expect(mocks.discardGeneration).toHaveBeenCalledOnce();
    expect(mocks.removeDevelopmentWorkspace).toHaveBeenCalledOnce();
  });

  it("uses the host Vite watcher and awaits Nitro cleanup from the host close lifecycle", async () => {
    const { close, nitro, runHook } = createNitro({ dev: true });
    const plugin = eveNitro() as EveNitroPlugin & {
      configureServer(server: {
        close(): Promise<void>;
        restart(): Promise<void>;
        watcher: { add(): void; off(): void; on(): void };
      }): Promise<void>;
    };
    let releaseWatcher: (() => void) | undefined;
    const watcherHandle = {
      close: vi.fn(
        async () =>
          await new Promise<void>((resolveClose) => {
            releaseWatcher = resolveClose;
          }),
      ),
      stop: vi.fn(),
    };
    mocks.startViteWatcher.mockResolvedValueOnce(watcherHandle);
    const server = {
      close: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      watcher: { add: vi.fn(), off: vi.fn(), on: vi.fn() },
    };

    await plugin.nitro.setup(nitro);
    await runHook("build:before");
    await plugin.configureServer(server);

    expect(mocks.resolveWatchPaths).toHaveBeenCalledWith(developmentHost);
    expect(mocks.startViteWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        rebuild: expect.any(Function),
        watcher: server.watcher,
        watchPaths: ["/host/agent"],
      }),
    );
    const closing = server.close();
    await Promise.resolve();
    expect(watcherHandle.close).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.removeDevelopmentWorkspace).not.toHaveBeenCalled();

    releaseWatcher?.();
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.removeDevelopmentWorkspace).toHaveBeenCalledOnce();
  });

  it("cleans the generation activated by a rebuild that finishes during host close", async () => {
    const { nitro, runHook } = createNitro({ dev: true });
    const plugin = eveNitro() as EveNitroPlugin & {
      configureServer(server: {
        close(): Promise<void>;
        restart(): Promise<void>;
        watcher: { add(): void; off(): void; on(): void };
      }): Promise<void>;
    };
    const rebuiltHost = Object.assign({} as PreparedDevelopmentApplicationHost, {
      generation: { snapshotRoot: "/host/.eve/rebuilt-generation" },
      workspace: { rootDir: "/host/.eve/rebuilt-dev-host" },
    });
    let finishRebuild:
      | ((result: { host: PreparedDevelopmentApplicationHost; kind: "runtime" }) => void)
      | undefined;
    const coordinatorRebuild = vi.fn(
      async () =>
        await new Promise<{
          host: PreparedDevelopmentApplicationHost;
          kind: "runtime";
        }>((resolveRebuild) => {
          finishRebuild = resolveRebuild;
        }),
    );
    mocks.createEmbeddedCoordinator.mockResolvedValueOnce({ rebuild: coordinatorRebuild });
    let activeRebuild: Promise<void> | undefined;
    const watcherHandle = {
      close: vi.fn(async () => await activeRebuild),
      stop: vi.fn(),
      updateWatchPaths: vi.fn(),
    };
    mocks.startViteWatcher.mockResolvedValueOnce(watcherHandle);
    const server = {
      close: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      watcher: { add: vi.fn(), off: vi.fn(), on: vi.fn() },
    };

    await plugin.nitro.setup(nitro);
    await runHook("build:before");
    await plugin.configureServer(server);

    const rebuild = mocks.startViteWatcher.mock.calls[0]?.[0].rebuild as (
      changedPaths: readonly string[],
    ) => Promise<void>;
    activeRebuild = rebuild(["/host/agent/agent.ts"]);
    await Promise.resolve();
    const closing = server.close();
    await Promise.resolve();

    finishRebuild?.({ host: rebuiltHost, kind: "runtime" });
    await activeRebuild;
    await closing;

    expect(mocks.discardGeneration).toHaveBeenCalledWith(rebuiltHost.generation);
    expect(mocks.discardGeneration).not.toHaveBeenCalledWith(developmentHost.generation);
    expect(mocks.removeDevelopmentWorkspace).toHaveBeenCalledWith(rebuiltHost.workspace);
    expect(mocks.removeDevelopmentWorkspace).not.toHaveBeenCalledWith(developmentHost.workspace);
    expect(watcherHandle.updateWatchPaths).not.toHaveBeenCalled();
  });

  it("rejects a Vite restart that resolves without replacing the server", async () => {
    const { close, nitro, runHook } = createNitro({ dev: true });
    const plugin = eveNitro() as EveNitroPlugin & {
      configureServer(server: {
        close(): Promise<void>;
        restart(): Promise<void>;
        watcher: { add(): void; off(): void; on(): void };
      }): Promise<void>;
    };
    const closeHost = vi.fn(async () => undefined);
    const server = {
      close: closeHost,
      restart: vi.fn(async () => undefined),
      watcher: { add: vi.fn(), off: vi.fn(), on: vi.fn() },
    };

    await plugin.nitro.setup(nitro);
    await runHook("build:before");
    await plugin.configureServer(server);

    const rebuild = mocks.startViteWatcher.mock.calls[0]?.[0].rebuild as (
      changedPaths: readonly string[],
    ) => Promise<void>;

    await expect(rebuild([])).rejects.toThrow(
      "resolved its restart without replacing the embedded eve lifecycle",
    );
    expect(closeHost).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    await server.close();
  });

  it("fully cleans only the old embedded lifecycle during a Vite restart", async () => {
    const { close, nitro, runHook } = createNitro({ dev: true });
    const replacement = createNitro({ dev: true });
    const plugin = eveNitro() as EveNitroPlugin & {
      configureServer(server: {
        close(): Promise<void>;
        restart(): Promise<void>;
        watcher: { add(): void; off(): void; on(): void };
      }): Promise<void>;
    };
    const closeHost = vi.fn(async () => undefined);
    const closeReplacementHost = vi.fn(async () => undefined);
    const watcherHandle = { close: vi.fn(async () => undefined), stop: vi.fn() };
    const replacementWatcherHandle = { close: vi.fn(async () => undefined), stop: vi.fn() };
    mocks.startViteWatcher
      .mockResolvedValueOnce(watcherHandle)
      .mockResolvedValueOnce(replacementWatcherHandle);
    const server = {
      close: closeHost,
      restart: vi.fn(async () => undefined),
      watcher: { add: vi.fn(), off: vi.fn(), on: vi.fn() },
    };
    const replacementServer = {
      close: closeReplacementHost,
      restart: vi.fn(async () => undefined),
      watcher: { add: vi.fn(), off: vi.fn(), on: vi.fn() },
    };

    await plugin.nitro.setup(nitro);
    await runHook("build:before");
    await plugin.configureServer(server);
    await plugin.nitro.setup(replacement.nitro);
    await replacement.runHook("build:before");
    await plugin.configureServer(replacementServer);
    server.restart.mockImplementationOnce(async () => {
      await server.close();
    });

    const rebuild = mocks.startViteWatcher.mock.calls[0]?.[0].rebuild as (
      changedPaths: readonly string[],
    ) => Promise<void>;
    await rebuild([]);

    expect(watcherHandle.stop).toHaveBeenCalledOnce();
    expect(watcherHandle.close).not.toHaveBeenCalled();
    expect(closeHost).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(replacementWatcherHandle.close).not.toHaveBeenCalled();
    expect(closeReplacementHost).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(mocks.discardGeneration).toHaveBeenCalledOnce();
    expect(mocks.removeDevelopmentWorkspace).toHaveBeenCalledOnce();

    await server.close();
    expect(close).toHaveBeenCalledOnce();

    await replacementServer.close();
    expect(replacementWatcherHandle.close).toHaveBeenCalledOnce();
    expect(replacementWatcherHandle.stop).not.toHaveBeenCalled();
    expect(closeReplacementHost).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("keeps cleanup scoped to each Nitro instance when one plugin object is reused", async () => {
    const firstWorkspace = {
      compiler: { artifactsDir: "/host/.eve/first/compiler/.eve" },
      rootDir: "/host/.eve/first",
    } as ApplicationBuildWorkspace;
    const secondWorkspace = {
      compiler: { artifactsDir: "/host/.eve/second/compiler/.eve" },
      rootDir: "/host/.eve/second",
    } as ApplicationBuildWorkspace;
    mocks.createWorkspace
      .mockResolvedValueOnce(firstWorkspace)
      .mockResolvedValueOnce(secondWorkspace);
    const plugin = eveNitro();
    const first = createNitro({ dev: false, preset: "node-server" });
    const second = createNitro({ dev: false, preset: "node-server" });

    await plugin.nitro.setup(first.nitro);
    await plugin.nitro.setup(second.nitro);
    await first.runHook("close");
    await second.runHook("close");

    expect(mocks.removeProductionWorkspace).toHaveBeenNthCalledWith(1, firstWorkspace);
    expect(mocks.removeProductionWorkspace).toHaveBeenNthCalledWith(2, secondWorkspace);
  });
});
