import type { Nitro } from "nitro/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PreparedApplicationHost } from "./types.js";

interface NitroStub {
  hooks: {
    hook(): void;
  };
  options: {
    buildDir: string;
    dev: boolean;
    handlers: Nitro["options"]["handlers"];
    rootDir: string;
    virtual: Nitro["options"]["virtual"];
  };
  routing: {
    sync(): void;
  };
}

interface PreparedApplicationHostStub {
  appRoot: string;
  compileResult: {
    manifest: {
      channels: [];
      config: {
        name: string;
        experimental?: { workflow?: { world?: string } };
      };
    };
    project: {
      agentRoot: string;
      appRoot: string;
      layout: "nested";
    };
  };
  compiledArtifacts: {
    bootstrapPath: string;
  };
  scheduleRegistrations: [];
  schedules: [];
  workflowBuildDir: string;
}

const workflowBuilderMocks = vi.hoisted(() => ({
  build: vi.fn(async () => {}),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => fsMocks);

vi.mock("../../application/package.js", () => ({
  resolvePackageDependencyPath: (specifier: string) =>
    `G:\\projects\\test-eve\\node_modules\\.pnpm\\${specifier}@1.0.0\\node_modules\\${specifier}\\dist\\index.js`,
  resolvePackageRoot: () =>
    "G:\\projects\\test-eve\\node_modules\\.pnpm\\eve@0.3.0\\node_modules\\eve",
  resolvePackageSourceFilePath: (relativeSourcePath: string) =>
    `G:\\projects\\test-eve\\node_modules\\.pnpm\\eve@0.3.0\\node_modules\\eve\\dist\\${relativeSourcePath
      .replace(/\.[cm]?tsx?$/, ".js")
      .replaceAll("/", "\\")}`,
  resolveWorkflowModulePath: (specifier: string) =>
    `G:\\projects\\test-eve\\node_modules\\.pnpm\\eve@0.3.0\\node_modules\\eve\\dist\\src\\compiled\\${specifier
      .replace(/^workflow\/(?:api|runtime)$/, "@workflow\\core\\runtime")
      .replace(/^workflow\/internal\/private$/, "@workflow\\core\\private")
      .replaceAll("/", "\\")}.js`,
}));

vi.mock("../../workflow-bundle/builder.js", () => ({
  WorkflowBundleBuilder: class {
    build = workflowBuilderMocks.build;
  },
}));

// Mock paths.js so the unit test avoids its heavyweight workflow-runtime import
// graph while preserving the real, env-driven `isVercelBuildEnvironment`
// semantics that the direct-handler gate depends on.
vi.mock("../../application/paths.js", () => ({
  isVercelBuildEnvironment: () => Boolean(process.env.VERCEL),
}));

const { configureNitroRoutes } = await import("./configure-nitro-routes.js");
const { EVE_HEALTH_ROUTE_PATH, EVE_INFO_ROUTE_PATH } = await import("#protocol/routes.js");

function createNitroStub(
  input: { buildDir?: string; dev?: boolean; rootDir?: string } = {},
): Nitro {
  const nitro: NitroStub = {
    hooks: {
      hook() {},
    },
    options: {
      buildDir: input.buildDir ?? "G:\\projects\\test-eve\\.eve\\nitro",
      dev: input.dev ?? false,
      handlers: [],
      rootDir: input.rootDir ?? "G:\\projects\\test-eve",
      virtual: {},
    },
    routing: {
      sync() {},
    },
  };

  return nitro as never as Nitro;
}

function createPreparedHost(
  input: {
    agentName?: string;
    appRoot?: string;
    workflowWorld?: string;
    workflowBuildDir?: string;
  } = {},
): PreparedApplicationHost {
  const appRoot = input.appRoot ?? "G:\\projects\\test-eve";

  const preparedHost: PreparedApplicationHostStub = {
    appRoot,
    compileResult: {
      manifest: {
        channels: [],
        config:
          input.workflowWorld === undefined
            ? { name: input.agentName ?? "test-agent" }
            : {
                name: input.agentName ?? "test-agent",
                experimental: { workflow: { world: input.workflowWorld } },
              },
      },
      project: {
        agentRoot: `${appRoot}\\agent`,
        appRoot,
        layout: "nested",
      },
    },
    compiledArtifacts: {
      bootstrapPath: `${appRoot}\\.eve\\compiled-artifacts-bootstrap.mjs`,
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: input.workflowBuildDir ?? `${appRoot}\\.eve\\workflow-cache`,
  };

  return preparedHost as never as PreparedApplicationHost;
}

describe("configureNitroRoutes", () => {
  beforeEach(() => {
    fsMocks.mkdir.mockClear();
    fsMocks.writeFile.mockClear();
    workflowBuilderMocks.build.mockClear();
    // The direct-handler gate keys off `process.env.VERCEL`; ensure each test
    // starts from a clean, self-hosted (non-Vercel) baseline.
    vi.unstubAllEnvs();
  });

  it("registers package-owned route files through file-url virtual handlers", async () => {
    const nitro = createNitroStub();

    await configureNitroRoutes(nitro, createPreparedHost(), {
      surface: "app",
    });

    const healthHandler = nitro.options.handlers.find(
      (handler) => handler.route === EVE_HEALTH_ROUTE_PATH && handler.method === "GET",
    );
    expect(healthHandler?.handler).toBe(`#eve-route-handler/GET ${EVE_HEALTH_ROUTE_PATH}`);

    const virtualSource = nitro.options.virtual[healthHandler?.handler ?? ""];
    expect(virtualSource).toContain(
      'import handler from "file:///G:/projects/test-eve/node_modules/.pnpm/eve@0.3.0/node_modules/eve/dist/src/internal/nitro/routes/health.js";',
    );
    expect(virtualSource).not.toContain('"G:\\');
  });

  it("registers the health route for HEAD so load balancers probing with HEAD see 200", async () => {
    const nitro = createNitroStub();

    await configureNitroRoutes(nitro, createPreparedHost(), {
      surface: "app",
    });

    const healthMethods = nitro.options.handlers
      .filter((handler) => handler.route === EVE_HEALTH_ROUTE_PATH)
      .map((handler) => handler.method);
    expect(healthMethods).toContain("GET");
    expect(healthMethods).toContain("HEAD");

    const headHandler = nitro.options.handlers.find(
      (handler) => handler.route === EVE_HEALTH_ROUTE_PATH && handler.method === "HEAD",
    );
    expect(headHandler?.handler).toBe(`#eve-route-handler/HEAD ${EVE_HEALTH_ROUTE_PATH}`);

    const virtualSource = nitro.options.virtual[headHandler?.handler ?? ""];
    expect(virtualSource).toContain(
      'import handler from "file:///G:/projects/test-eve/node_modules/.pnpm/eve@0.3.0/node_modules/eve/dist/src/internal/nitro/routes/health.js";',
    );
  });

  it("registers workflow routes through physical handlers with relative bundle imports", async () => {
    const root = "/tmp/eve-nitro-routes";
    const buildDir = `${root}/nitro`;
    const workflowBuildDir = `${root}/workflow-cache`;
    const nitro = createNitroStub({ buildDir, dev: true, rootDir: root });

    await configureNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
      }),
      {
        surface: "flow",
      },
    );

    const workflowHandler = nitro.options.handlers.find(
      (handler) => handler.route === "/.well-known/workflow/v1/flow",
    );
    const expectedHandlerPath = `${buildDir}/workflow/workflows-handler.mjs`;

    expect(workflowHandler?.handler).toBe(expectedHandlerPath);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expectedHandlerPath,
      expect.stringContaining('import { POST } from "./workflows.mjs";'),
    );
    expect(workflowBuilderMocks.build).toHaveBeenCalledWith({
      nitroStepOutfile: `${buildDir}/workflow/steps.mjs`,
      nitroWorkflowOutfile: `${buildDir}/workflow/workflows.mjs`,
    });
    expect(nitro.options.virtual["#eve-workflow/workflows"]).toBeUndefined();
  });

  it("registers direct workflow queue handlers in dev mode so the worker bypasses HTTP dispatch", async () => {
    const root = "/tmp/eve-nitro-direct-handlers";
    const buildDir = `${root}/nitro`;
    const nitro = createNitroStub({ buildDir, dev: true, rootDir: root });

    await configureNitroRoutes(nitro, createPreparedHost({ appRoot: root }), {
      surface: "all",
    });

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).toContain('import { POST } from "./workflows.mjs";');
    expect(workflowHandlerSource).toContain(
      'import { getWorld as __eveGetWorkflowWorld } from "file:///G:/projects/test-eve/node_modules/.pnpm/eve@0.3.0/node_modules/eve/dist/src/compiled/@workflow/core/runtime.js";',
    );
    expect(workflowHandlerSource).toContain(
      "const __eveWorkflowWorld = await __eveGetWorkflowWorld();",
    );
    expect(workflowHandlerSource).toContain(
      '__eveWorkflowWorld.registerHandler("__eve746573742d6167656e74_wkf_workflow_", POST);',
    );
    expect(readWriteFileSourceMatching("/workflow/steps-handler.mjs")).toBeUndefined();
  });

  it("registers the dev runtime artifact revision route only in dev mode", async () => {
    const devNitro = createNitroStub({ dev: true });
    const prodNitro = createNitroStub({ dev: false });

    await configureNitroRoutes(devNitro, createPreparedHost(), {
      surface: "app",
    });
    await configureNitroRoutes(prodNitro, createPreparedHost(), {
      surface: "app",
    });

    expect(devNitro.options.handlers).toContainEqual({
      handler: "#eve-route/eve/v1/dev/runtime-artifacts",
      method: "GET",
      route: "/eve/v1/dev/runtime-artifacts",
    });
    expect(devNitro.options.handlers).toContainEqual({
      handler: "#eve-route/eve/v1/dev/runtime-artifacts/rebuild",
      method: "POST",
      route: "/eve/v1/dev/runtime-artifacts/rebuild",
    });
    expect(prodNitro.options.handlers).not.toContainEqual(
      expect.objectContaining({
        route: "/eve/v1/dev/runtime-artifacts",
      }),
    );
    expect(prodNitro.options.handlers).not.toContainEqual(
      expect.objectContaining({
        route: "/eve/v1/dev/runtime-artifacts/rebuild",
      }),
    );
  });

  it("registers the agent info route for dev and production app builds", async () => {
    const devNitro = createNitroStub({ dev: true });
    const prodNitro = createNitroStub({ dev: false });

    await configureNitroRoutes(devNitro, createPreparedHost(), {
      surface: "app",
    });
    await configureNitroRoutes(prodNitro, createPreparedHost(), {
      surface: "app",
    });

    expect(devNitro.options.handlers).toContainEqual({
      handler: `#eve-route${EVE_INFO_ROUTE_PATH}`,
      method: "GET",
      route: EVE_INFO_ROUTE_PATH,
    });
    expect(prodNitro.options.handlers).toContainEqual({
      handler: `#eve-route${EVE_INFO_ROUTE_PATH}`,
      method: "GET",
      route: EVE_INFO_ROUTE_PATH,
    });
    expect(devNitro.options.virtual[`#eve-route${EVE_INFO_ROUTE_PATH}`]).toContain(
      '"mode":"development"',
    );
    expect(prodNitro.options.virtual[`#eve-route${EVE_INFO_ROUTE_PATH}`]).toContain(
      '"mode":"production"',
    );
  });

  it("does not register direct workflow queue handlers for Vercel production builds", async () => {
    vi.stubEnv("VERCEL", "1");

    const root = "/tmp/eve-nitro-direct-handlers-vercel";
    const buildDir = `${root}/nitro`;
    const workflowBuildDir = `${root}/workflow-cache`;
    const nitro = createNitroStub({ buildDir, dev: false, rootDir: root });

    await configureNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
        workflowWorld: "@workflow/world-postgres",
      }),
      {
        surface: "all",
      },
    );

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).toContain(
      'import { POST } from "../../workflow-cache/workflows.mjs";',
    );
    expect(workflowHandlerSource).not.toContain("registerHandler");
    expect(workflowHandlerSource).not.toContain("__eveGetWorkflowWorld");
    expect(readWriteFileSourceMatching("/workflow/steps-handler.mjs")).toBeUndefined();
  });

  it("registers direct workflow queue handlers for self-hosted production builds with a configured world", async () => {
    const root = "/tmp/eve-nitro-direct-handlers-self-hosted";
    const buildDir = `${root}/nitro`;
    const workflowBuildDir = `${root}/workflow-cache`;
    const nitro = createNitroStub({ buildDir, dev: false, rootDir: root });

    await configureNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
        workflowWorld: "@workflow/world-postgres",
      }),
      {
        surface: "all",
      },
    );

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).toContain(
      'import { POST } from "../../workflow-cache/workflows.mjs";',
    );
    expect(workflowHandlerSource).toContain(
      "const __eveWorkflowWorld = await __eveGetWorkflowWorld();",
    );
    expect(workflowHandlerSource).toContain(
      '__eveWorkflowWorld.registerHandler("__eve746573742d6167656e74_wkf_workflow_", POST);',
    );
    expect(readWriteFileSourceMatching("/workflow/steps-handler.mjs")).toBeUndefined();
  });

  it("does not register direct workflow queue handlers for self-hosted production builds without a configured world", async () => {
    const root = "/tmp/eve-nitro-direct-handlers-self-hosted-no-world";
    const buildDir = `${root}/nitro`;
    const workflowBuildDir = `${root}/workflow-cache`;
    const nitro = createNitroStub({ buildDir, dev: false, rootDir: root });

    await configureNitroRoutes(nitro, createPreparedHost({ appRoot: root, workflowBuildDir }), {
      surface: "all",
    });

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).not.toContain("registerHandler");
    expect(workflowHandlerSource).not.toContain("__eveGetWorkflowWorld");
  });
});

function readWriteFileSourceMatching(suffix: string): string | undefined {
  const calls = fsMocks.writeFile.mock.calls as readonly unknown[][];
  const call = calls.find((args) => {
    const target = args[0];
    return typeof target === "string" && target.replaceAll("\\", "/").endsWith(suffix);
  });

  if (call === undefined) {
    return undefined;
  }

  const source = call[1];
  return typeof source === "string" ? source : undefined;
}
