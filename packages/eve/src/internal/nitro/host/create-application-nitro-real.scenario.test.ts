import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Nitro } from "nitro/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import {
  EVE_CALLBACK_ROUTE_PATTERN,
  EVE_CANCEL_TURN_ROUTE_PATTERN,
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_CONTINUE_SESSION_ROUTE_PATTERN,
  EVE_CREATE_SESSION_ROUTE_PATH,
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_MESSAGE_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
import type {
  NitroBuildSurface,
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";

vi.mock("#internal/workflow-bundle/builder.js", () => ({
  WorkflowBundleBuilder: class {
    async build(): Promise<void> {}
  },
}));

const APPLICATION_ROUTE_KEYS = [
  `GET ${EVE_HEALTH_ROUTE_PATH}`,
  `HEAD ${EVE_HEALTH_ROUTE_PATH}`,
  `GET ${EVE_INFO_ROUTE_PATH}`,
  `POST ${EVE_CREATE_SESSION_ROUTE_PATH}`,
  `POST ${EVE_CONTINUE_SESSION_ROUTE_PATTERN}`,
  `POST ${EVE_CANCEL_TURN_ROUTE_PATTERN}`,
  `GET ${EVE_MESSAGE_STREAM_ROUTE_PATTERN}`,
  `GET ${EVE_CONNECTION_CALLBACK_ROUTE_PATTERN}`,
  `POST ${EVE_CONNECTION_CALLBACK_ROUTE_PATTERN}`,
  `POST ${EVE_CALLBACK_ROUTE_PATTERN}`,
];
const WORKFLOW_ROUTE_KEY = "ALL /.well-known/workflow/v1/flow";
const tempRoots: string[] = [];

function createPreparedHost(appRoot: string): PreparedDevelopmentApplicationHost {
  const agentRoot = join(appRoot, "agent");
  const paths = resolveCompilerArtifactPaths(appRoot);
  const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "real-nitro");

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
      bootstrapPath: join(appRoot, ".eve", "bootstrap.mjs"),
      workflowWorldPluginPath: join(appRoot, ".eve", "workflow-world.mjs"),
    } as PreparedApplicationHost["compiledArtifacts"],
    generation: {
      fingerprint: "runtime-fingerprint",
      runtimeAppRoot: join(workspaceRoot, "snapshot", "source", "app"),
      snapshotRoot: join(workspaceRoot, "snapshot"),
      snapshotSourceRoot: join(workspaceRoot, "snapshot", "source"),
      sourceRoot: appRoot,
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(workspaceRoot, "workflow"),
    workspace: {
      artifactsDir: join(workspaceRoot, "artifacts"),
      compilerArtifactsDir: join(workspaceRoot, "compiler"),
      nitroBuildDir: join(workspaceRoot, "nitro"),
      nitroOutputDir: join(workspaceRoot, "output"),
      rootDir: workspaceRoot,
      workflowBuildDir: join(workspaceRoot, "workflow"),
    },
    workspaceExtensions: [],
  };
}

function getRouteKeys(nitro: Nitro): string[] {
  return nitro.options.handlers.map((handler) => `${handler.method ?? "ALL"} ${handler.route}`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("real Nitro standalone route composition", () => {
  it("returns the real Nitro development candidate with eve routes", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-real-nitro-dev-"));
    tempRoots.push(appRoot);
    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const nitro = await createDevelopmentApplicationNitro(createPreparedHost(appRoot));

    try {
      expect(nitro.meta.majorVersion).toBe(3);
      expect(getRouteKeys(nitro)).toEqual(
        expect.arrayContaining([
          "GET /",
          ...APPLICATION_ROUTE_KEYS,
          `GET ${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}`,
          `POST ${EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN}`,
          WORKFLOW_ROUTE_KEY,
        ]),
      );
    } finally {
      await nitro.close();
    }
  });

  it.each<{
    expectedRoutes: readonly string[];
    surface: NitroBuildSurface;
  }>([
    {
      expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS, WORKFLOW_ROUTE_KEY],
      surface: "all",
    },
    { expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS], surface: "app" },
    { expectedRoutes: [WORKFLOW_ROUTE_KEY], surface: "flow" },
  ])(
    "returns the real Nitro production $surface candidate with its eve routes",
    async ({ expectedRoutes, surface }) => {
      const appRoot = await mkdtemp(join(tmpdir(), `eve-real-nitro-${surface}-`));
      tempRoots.push(appRoot);
      const { createProductionApplicationNitro } =
        await import("#internal/nitro/host/create-application-nitro.js");
      const preparedHost = createPreparedHost(appRoot);
      const nitro = await createProductionApplicationNitro(preparedHost, {
        buildDir: join(appRoot, ".eve", `nitro-${surface}`),
        outputDir: join(appRoot, ".output"),
        surface,
      });

      try {
        expect(nitro.meta.majorVersion).toBe(3);
        expect(getRouteKeys(nitro)).toEqual(expect.arrayContaining([...expectedRoutes]));
        if (surface === "flow") {
          expect(getRouteKeys(nitro)).not.toContain("GET /");
          expect(getRouteKeys(nitro)).not.toContain(`GET ${EVE_HEALTH_ROUTE_PATH}`);
        }
      } finally {
        await nitro.close();
      }
    },
  );
});
