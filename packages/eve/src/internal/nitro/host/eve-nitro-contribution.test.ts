import { describe, expect, it, vi } from "vitest";
import type { Nitro } from "nitro/types";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";
import { createEveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";
import { createEmbeddedEveNitroRequirements } from "#internal/nitro/host/embedded-eve-nitro-requirements.js";
import {
  applyEveNitroConfigDelta,
  mergeEveNitroConfig,
} from "#internal/nitro/host/merge-eve-nitro-config.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";

function createPreparedHost(): PreparedApplicationHost {
  const appRoot = "/tmp/weather-agent";
  const agentRoot = `${appRoot}/agent`;
  const paths = resolveCompilerArtifactPaths(appRoot);

  return {
    appRoot,
    compileResult: {
      diagnostics: [],
      manifest: createCompiledAgentManifest({
        agentRoot,
        appRoot,
        config: {
          model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
          name: "weather-agent",
        },
      }),
      metadata: {
        compile: {
          moduleMap: { path: paths.moduleMapPath, sha256: "module-map-sha" },
        },
        discovery: {
          diagnostics: { path: paths.diagnosticsPath, sha256: "diagnostics-sha" },
          manifest: { path: paths.discoveryManifestPath, sha256: "manifest-sha" },
          sourceGraphHash: "source-graph-sha",
          summary: { errors: 0, warnings: 0 },
        },
        generator: { name: "test", version: "0.0.0" },
        kind: COMPILE_METADATA_KIND,
        status: "ready",
        version: COMPILE_METADATA_VERSION,
      },
      paths,
      project: { agentRoot, appRoot, layout: "nested" },
    },
    compiledArtifacts: {
      bootstrapPath: "/tmp/weather-agent/.eve/bootstrap.mjs",
      workflowWorldPluginPath: "/tmp/weather-agent/.eve/workflow-world.mjs",
    } as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: "/tmp/weather-agent/.eve/workflow",
  };
}

describe("createEveNitroContribution", () => {
  it("describes eve-owned development configuration without standalone host policy", () => {
    const contribution = createEveNitroContribution(createPreparedHost(), {
      mode: "development",
      preset: undefined,
      surface: "all",
    });

    expect(contribution).toMatchObject({
      applicationRoutes: true,
      mode: "development",
      surface: "all",
      workflowRoutes: true,
    });
    expect(contribution.configDelta).toMatchObject({
      features: { websocket: true },
      plugins: [
        "/tmp/weather-agent/.eve/bootstrap.mjs",
        "/tmp/weather-agent/.eve/workflow-world.mjs",
      ],
      scanDirs: [resolvePackageSourceDirectoryPath("src/execution")],
    });
    expect(contribution.configDelta).not.toHaveProperty("buildDir");
    expect(contribution.configDelta).not.toHaveProperty("output");
    expect(contribution.configDelta).not.toHaveProperty("preset");
    expect(contribution.configDelta).not.toHaveProperty("rootDir");
    expect(contribution.configDelta).not.toHaveProperty("vercel");
  });

  it("does not force WebSocket support into an HTTP-only embedded development host", () => {
    const contribution = createEveNitroContribution(createPreparedHost(), {
      host: "embedded",
      mode: "development",
      preset: undefined,
      surface: "all",
    });

    expect(contribution.configDelta.features.websocket).toBe(false);
  });

  it("describes the complete embedded resource set without claiming the host root", () => {
    const preparedHost = createPreparedHost();
    preparedHost.scheduleRegistrations = [{} as never];
    const contribution = createEveNitroContribution(preparedHost, {
      host: "embedded",
      mode: "development",
      preset: undefined,
      surface: "all",
    });

    const requirements = createEmbeddedEveNitroRequirements(contribution);

    expect(requirements).toMatchObject({ schedules: true, websocket: false });
    expect(requirements.routes).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          route: "/eve/v1/health",
          virtualId: "#eve-route-handler/GET /eve/v1/health",
        },
        {
          method: "GET",
          route: "/eve/v1/dev/runtime-artifacts",
          virtualId: "#eve-route/eve/v1/dev/runtime-artifacts",
        },
        { route: "/.well-known/workflow/v1/flow" },
      ]),
    );
    expect(requirements.routes.some((route) => route.route === "/")).toBe(false);
  });

  it.each<{
    applicationRoutes: boolean;
    surface: NitroBuildSurface;
    workflowRoutes: boolean;
  }>([
    { applicationRoutes: true, surface: "all", workflowRoutes: true },
    { applicationRoutes: true, surface: "app", workflowRoutes: false },
    { applicationRoutes: false, surface: "flow", workflowRoutes: true },
  ])(
    "keeps production $surface contribution resources isolated",
    ({ applicationRoutes, surface, workflowRoutes }) => {
      const contribution = createEveNitroContribution(createPreparedHost(), {
        mode: "production",
        preset: "vercel",
        surface,
      });

      expect(contribution).toMatchObject({
        applicationRoutes,
        mode: "production",
        surface,
        workflowRoutes,
      });
      expect(contribution.configDelta.features).toEqual({ websocket: false });
      expect(contribution.configDelta.plugins).toEqual(
        expect.arrayContaining([expect.stringContaining("sandbox-shutdown-plugin.ts")]),
      );
      expect(contribution.configDelta.scanDirs).toEqual(
        workflowRoutes ? [resolvePackageSourceDirectoryPath("src/execution")] : [],
      );
    },
  );

  it("merges pre-creation requirements additively with host configuration", () => {
    const contribution = createEveNitroContribution(createPreparedHost(), {
      mode: "production",
      preset: undefined,
      surface: "all",
    });
    const hostRollupPlugin = { name: "host-rollup-plugin" };
    const hostRolldownPlugin = { name: "host-rolldown-plugin" };

    const merged = mergeEveNitroConfig(
      {
        alias: { "#host-owned": "/tmp/host-owned.mjs" },
        features: { runtimeHooks: true },
        plugins: ["/tmp/host-plugin.mjs"],
        rolldownConfig: {
          external: ["host-rolldown-external"],
          plugins: [hostRolldownPlugin],
          treeshake: { moduleSideEffects: false },
        },
        rollupConfig: {
          external: ["host-external"],
          plugins: [hostRollupPlugin],
          treeshake: { moduleSideEffects: false },
        },
        scanDirs: ["/tmp/host-scan"],
        traceDeps: ["host-dependency"],
      },
      contribution,
    );

    expect(merged.alias).toEqual({ "#host-owned": "/tmp/host-owned.mjs" });
    expect(merged.features).toMatchObject({ runtimeHooks: true, websocket: false });
    expect(merged.plugins).toEqual(["/tmp/host-plugin.mjs", ...contribution.configDelta.plugins]);
    expect(merged.scanDirs).toEqual([
      "/tmp/host-scan",
      resolvePackageSourceDirectoryPath("src/execution"),
    ]);
    expect(merged.traceDeps).toEqual(["host-dependency", ...contribution.configDelta.traceDeps]);
    expect(merged.rollupConfig).toMatchObject({ external: ["host-external"] });
    expect(merged.rolldownConfig).toMatchObject({ external: ["host-rolldown-external"] });
    expect(merged.rollupConfig?.treeshake).toEqual({ moduleSideEffects: false });
    expect(merged.rolldownConfig?.treeshake).toEqual({ moduleSideEffects: false });
    expect(merged.rollupConfig?.plugins).toEqual([
      hostRollupPlugin,
      ...(Array.isArray(contribution.configDelta.rollupConfig.plugins)
        ? contribution.configDelta.rollupConfig.plugins
        : []),
    ]);
    expect(merged.rolldownConfig?.plugins).toEqual([
      hostRolldownPlugin,
      ...(Array.isArray(contribution.configDelta.rolldownConfig.plugins)
        ? contribution.configDelta.rolldownConfig.plugins
        : []),
    ]);
  });

  it("applies the additive delta to resolved Nitro options without changing host policy", () => {
    const contribution = createEveNitroContribution(createPreparedHost(), {
      host: "embedded",
      mode: "production",
      preset: undefined,
      surface: "all",
    });
    const output = { dir: "/host/output", publicDir: "/host/public", serverDir: "/host/server" };
    const publicAssets = [{ baseURL: "/", dir: "/host/public" }];
    const storage = { cache: { driver: "memory" } };
    const options = Object.assign({} as Nitro["options"], {
      compatibilityDate: "2026-07-21",
      features: { runtimeHooks: true },
      output,
      plugins: ["/host/plugin.mjs"],
      preset: "node-server",
      publicAssets,
      rolldownConfig: { external: ["host-rolldown"] },
      rollupConfig: { external: ["host-rollup"] },
      scanDirs: ["/host/server"],
      storage,
      traceDeps: ["host-dependency"],
    });
    const nitro = Object.assign({} as Nitro, { options });

    applyEveNitroConfigDelta(nitro, contribution);

    expect(nitro.options).toMatchObject({
      compatibilityDate: "2026-07-21",
      output,
      preset: "node-server",
      publicAssets,
      storage,
    });
    expect(nitro.options.plugins).toEqual([
      "/host/plugin.mjs",
      ...contribution.configDelta.plugins,
    ]);
    expect(nitro.options.scanDirs).toEqual(["/host/server", ...contribution.configDelta.scanDirs]);
    expect(nitro.options.traceDeps).toEqual([
      "host-dependency",
      ...contribution.configDelta.traceDeps,
    ]);
  });

  it.each(["rollupConfig", "rolldownConfig"] as const)(
    "composes host and eve %s log handling without losing suppression",
    (configKey) => {
      const contribution = createEveNitroContribution(createPreparedHost(), {
        mode: "production",
        preset: undefined,
        surface: "all",
      });
      const defaultHandler = vi.fn();
      const hostOnLog = vi.fn(
        (
          level: string,
          log: unknown,
          forward: (forwardedLevel: string, forwardedLog: unknown) => void,
        ) => {
          if ((log as { code?: string }).code !== "HOST_SUPPRESSED") {
            forward(level, log);
          }
        },
      );
      const merged = mergeEveNitroConfig(
        {
          [configKey]: { onLog: hostOnLog },
        },
        contribution,
      );
      const onLog = merged[configKey]?.onLog as
        | ((
            level: string,
            log: unknown,
            handler: (forwardedLevel: string, forwardedLog: unknown) => void,
          ) => void)
        | undefined;
      expect(onLog).toBeTypeOf("function");

      const forwardedLog = { code: "FORWARDED", id: "/tmp/weather-agent/agent.ts" };
      onLog?.("warn", forwardedLog, defaultHandler);
      expect(hostOnLog).toHaveBeenCalledWith("warn", forwardedLog, defaultHandler);
      expect(defaultHandler).toHaveBeenCalledWith("warn", forwardedLog);

      hostOnLog.mockClear();
      defaultHandler.mockClear();
      onLog?.("warn", { id: "/tmp/node_modules/vendor/index.js" }, defaultHandler);
      expect(hostOnLog).not.toHaveBeenCalled();
      expect(defaultHandler).not.toHaveBeenCalled();

      const hostSuppressedLog = {
        code: "HOST_SUPPRESSED",
        id: "/tmp/weather-agent/agent.ts",
      };
      onLog?.("warn", hostSuppressedLog, defaultHandler);
      expect(hostOnLog).toHaveBeenCalledWith("warn", hostSuppressedLog, defaultHandler);
      expect(defaultHandler).not.toHaveBeenCalled();
    },
  );
});
