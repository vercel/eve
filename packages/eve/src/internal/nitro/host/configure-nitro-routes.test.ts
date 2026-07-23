import type { Nitro } from "nitro/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NitroBuildSurface, PreparedApplicationHost } from "./types.js";

interface NitroStub {
  hookHandlers: Map<string, Array<() => unknown>>;
  hooks: {
    hook(name: string, handler: () => unknown): void;
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
    workflowWorldPluginPath: string;
  };
  scheduleRegistrations: [];
  schedules: [];
  workflowBuildDir: string;
}

const workflowBuilderMocks = vi.hoisted(() => ({
  build: vi.fn(async () => {}),
}));

const fsMocks = vi.hoisted(() => ({
  chmod: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  realpath: vi.fn(async (path: string) => path),
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

const {
  configureDevelopmentNitroRoutes,
  configureProductionNitroRoutes,
  configureStandaloneNitroShellRoutes,
} = await import("./configure-nitro-routes.js");
const {
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
} = await import("#protocol/routes.js");
const { digestDevelopmentControlToken, getOrCreateDevelopmentControlToken } =
  await import("#internal/nitro/dev-control-auth.js");

const WORKFLOW_ROUTE_KEY = "ALL /.well-known/workflow/v1/flow";
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
].sort();

function createNitroStub(
  input: { buildDir?: string; dev?: boolean; rootDir?: string } = {},
): Nitro & Pick<NitroStub, "hookHandlers"> {
  const hookHandlers = new Map<string, Array<() => unknown>>();
  const nitro: NitroStub = {
    hookHandlers,
    hooks: {
      hook(name, handler) {
        hookHandlers.set(name, [...(hookHandlers.get(name) ?? []), handler]);
      },
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

  return nitro as never as Nitro & Pick<NitroStub, "hookHandlers">;
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
  const pathSeparator = appRoot.includes("\\") ? "\\" : "/";

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
      workflowWorldPluginPath: `${appRoot}${pathSeparator}.eve${pathSeparator}compiled-artifacts-workflow-world.mjs`,
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: input.workflowBuildDir ?? `${appRoot}\\.eve\\workflow-cache`,
  };

  return preparedHost as never as PreparedApplicationHost;
}

describe("Nitro route configuration", () => {
  beforeEach(() => {
    fsMocks.chmod.mockClear();
    fsMocks.mkdir.mockClear();
    fsMocks.readFile.mockClear();
    fsMocks.realpath.mockClear();
    fsMocks.writeFile.mockClear();
    workflowBuilderMocks.build.mockReset();
    workflowBuilderMocks.build.mockResolvedValue(undefined);
    // The direct-handler gate keys off `process.env.VERCEL`; ensure each test
    // starts from a clean, self-hosted (non-Vercel) baseline.
    vi.unstubAllEnvs();
  });

  it("registers package-owned route files through file-url virtual handlers", async () => {
    const nitro = createNitroStub();

    await configureProductionNitroRoutes(nitro, createPreparedHost(), "app");

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

  it("bakes the agent name into the home page route", async () => {
    const nitro = createNitroStub();

    configureStandaloneNitroShellRoutes(nitro, createPreparedHost({ agentName: "support-agent" }));

    const homeHandler = nitro.options.handlers.find(
      (handler) => handler.route === "/" && handler.method === "GET",
    );
    expect(homeHandler?.handler).toBe("#eve-route/");

    const virtualSource = nitro.options.virtual[homeHandler?.handler ?? ""];
    expect(virtualSource).toContain("handleHomePageRequest");
    expect(virtualSource).toContain('{"agentName":"support-agent"}');
  });

  it("keeps the standalone root page out of reusable application routes", async () => {
    const nitro = createNitroStub();

    await configureProductionNitroRoutes(nitro, createPreparedHost(), "app");

    expect(getRouteKeys(nitro)).toEqual(APPLICATION_ROUTE_KEYS);
    expect(nitro.options.handlers).not.toContainEqual(expect.objectContaining({ route: "/" }));
  });

  it("preserves a host-owned root page while adding reusable application routes", async () => {
    const nitro = createNitroStub();
    nitro.options.handlers.push({
      handler: "#host-root",
      method: "GET",
      route: "/",
    });
    nitro.options.virtual["#host-root"] = "export default () => 'host root';";

    await configureProductionNitroRoutes(nitro, createPreparedHost(), "app");

    expect(getRouteKeys(nitro)).toEqual(["GET /", ...APPLICATION_ROUTE_KEYS].sort());
    expect(nitro.options.handlers.filter((handler) => handler.route === "/")).toEqual([
      {
        handler: "#host-root",
        method: "GET",
        route: "/",
      },
    ]);
    expect(nitro.options.virtual["#host-root"]).toBe("export default () => 'host root';");
  });

  it("preserves the standalone development route surface", async () => {
    const nitro = createNitroStub({ dev: true });
    const preparedHost = createPreparedHost();

    configureStandaloneNitroShellRoutes(nitro, preparedHost);
    await configureDevelopmentNitroRoutes(nitro, preparedHost);

    expect(getRouteKeys(nitro)).toEqual(
      [
        "GET /",
        ...APPLICATION_ROUTE_KEYS,
        `GET ${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}`,
        `POST ${EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN}`,
        WORKFLOW_ROUTE_KEY,
      ].sort(),
    );
  });

  it.each<{
    expectedRoutes: string[];
    surface: NitroBuildSurface;
  }>([
    {
      expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS, WORKFLOW_ROUTE_KEY],
      surface: "all",
    },
    {
      expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS],
      surface: "app",
    },
    {
      expectedRoutes: [WORKFLOW_ROUTE_KEY],
      surface: "flow",
    },
  ])(
    "preserves the standalone production $surface route surface",
    async ({ expectedRoutes, surface }) => {
      const nitro = createNitroStub();
      const preparedHost = createPreparedHost();

      if (surface !== "flow") {
        configureStandaloneNitroShellRoutes(nitro, preparedHost);
      }
      await configureProductionNitroRoutes(nitro, preparedHost, surface);

      expect(getRouteKeys(nitro)).toEqual([...expectedRoutes].sort());
    },
  );

  it.each<{
    includesWorkflowBundle: boolean;
    surface: NitroBuildSurface;
  }>([
    { includesWorkflowBundle: true, surface: "all" },
    { includesWorkflowBundle: false, surface: "app" },
    { includesWorkflowBundle: true, surface: "flow" },
  ])(
    "$surface production surface preserves Workflow bundle inclusion",
    async ({ includesWorkflowBundle, surface }) => {
      const nitro = createNitroStub();

      await configureProductionNitroRoutes(nitro, createPreparedHost(), surface);

      if (includesWorkflowBundle) {
        expect(workflowBuilderMocks.build).toHaveBeenCalledOnce();
        expect(workflowBuilderMocks.build).toHaveBeenCalledWith({
          nitroStepOutfile: "G:\\projects\\test-eve\\.eve\\nitro/workflow/steps.mjs",
        });
      } else {
        expect(workflowBuilderMocks.build).not.toHaveBeenCalled();
      }
    },
  );

  it("registers the health route for HEAD so load balancers probing with HEAD see 200", async () => {
    const nitro = createNitroStub();

    await configureProductionNitroRoutes(nitro, createPreparedHost(), "app");

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

    await configureDevelopmentNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
      }),
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

  it.each<{ dev: boolean; surface: NitroBuildSurface }>([
    { dev: true, surface: "all" },
    { dev: false, surface: "flow" },
  ])(
    "refreshes Workflow artifacts after the initial $surface build lifecycle",
    async ({ dev, surface }) => {
      const observedRevisions: number[] = [];
      let revision = 1;
      workflowBuilderMocks.build.mockImplementation(async () => {
        observedRevisions.push(revision);
      });
      const nitro = createNitroStub({ dev });

      if (dev) {
        await configureDevelopmentNitroRoutes(nitro, createPreparedHost());
      } else {
        await configureProductionNitroRoutes(nitro, createPreparedHost(), surface);
      }
      const build = nitro.hookHandlers.get("build:before")?.[0];
      if (build === undefined) {
        throw new Error("Expected the workflow build hook to be registered.");
      }

      expect(nitro.hookHandlers.has("dev:reload")).toBe(false);
      expect(observedRevisions).toEqual([1]);
      await expect(build()).resolves.toBeUndefined();
      expect(observedRevisions).toEqual([1]);

      revision = 2;
      await expect(build()).resolves.toBeUndefined();
      expect(observedRevisions).toEqual([1, 2]);
    },
  );

  it("leaves development queue dispatch to the stable parent", async () => {
    const root = "/tmp/eve-nitro-direct-handlers";
    const buildDir = `${root}/nitro`;
    const nitro = createNitroStub({ buildDir, dev: true, rootDir: root });

    await configureDevelopmentNitroRoutes(nitro, createPreparedHost({ appRoot: root }));

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).toContain('import { POST } from "./workflows.mjs";');
    expect(workflowHandlerSource).not.toContain("registerHandler");
    expect(workflowHandlerSource).not.toContain("__eveGetWorkflowWorld");
    expect(readWriteFileSourceMatching("/workflow/steps-handler.mjs")).toBeUndefined();
  });

  it("keeps configured development World queue dispatch inside the worker", async () => {
    const root = "/tmp/eve-nitro-configured-world-handlers";
    const nitro = createNitroStub({ buildDir: `${root}/nitro`, dev: true, rootDir: root });

    await configureDevelopmentNitroRoutes(
      nitro,
      createPreparedHost({ appRoot: root, workflowWorld: "@workflow/world-postgres" }),
    );

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");
    expect(workflowHandlerSource).toContain(
      "const __eveWorkflowWorld = await __eveGetWorkflowWorld();",
    );
    expect(workflowHandlerSource).toContain("__eveWorkflowWorld.registerHandler");
  });

  it("bakes the module map loader into the dev schedule handler", async () => {
    const nitro = createNitroStub({ dev: true });
    const appRoot = "G:\\projects\\test-eve";
    const controlToken = getOrCreateDevelopmentControlToken(appRoot);

    await configureDevelopmentNitroRoutes(nitro, createPreparedHost({ appRoot }));

    const source = nitro.options.virtual[`#eve-route${EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN}`];
    expect(source).toContain('"moduleMapLoaderPath"');
    expect(source).toContain("authored-module-map-loader.js");
    expect(source).toContain(digestDevelopmentControlToken(controlToken));
    expect(source).not.toContain(controlToken);
  });

  it("registers the dev runtime artifact revision route only in dev mode", async () => {
    const devNitro = createNitroStub({ dev: true });
    const prodNitro = createNitroStub({ dev: false });

    await configureDevelopmentNitroRoutes(devNitro, createPreparedHost());
    await configureProductionNitroRoutes(prodNitro, createPreparedHost(), "app");

    expect(devNitro.options.handlers).toContainEqual({
      handler: "#eve-route/eve/v1/dev/runtime-artifacts",
      method: "GET",
      route: "/eve/v1/dev/runtime-artifacts",
    });
    expect(devNitro.options.handlers).not.toContainEqual(
      expect.objectContaining({
        route: "/eve/v1/dev/runtime-artifacts/rebuild",
      }),
    );
    expect(prodNitro.options.handlers).not.toContainEqual(
      expect.objectContaining({
        route: "/eve/v1/dev/runtime-artifacts",
      }),
    );
  });

  it("registers the agent info route for dev and production app builds", async () => {
    const devNitro = createNitroStub({ dev: true });
    const prodNitro = createNitroStub({ dev: false });

    await configureDevelopmentNitroRoutes(devNitro, createPreparedHost());
    await configureProductionNitroRoutes(prodNitro, createPreparedHost(), "app");

    expect(devNitro.options.handlers).toContainEqual({
      handler: `#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`,
      method: "GET",
      route: EVE_INFO_ROUTE_PATH,
    });
    expect(prodNitro.options.handlers).toContainEqual({
      handler: `#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`,
      method: "GET",
      route: EVE_INFO_ROUTE_PATH,
    });
    expect(
      devNitro.options.virtual[`#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`],
    ).toContain('"kind":"development"');
    expect(
      prodNitro.options.virtual[`#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`],
    ).toContain('"kind":"production"');
    expect(
      devNitro.options.virtual[`#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`],
    ).toContain("dispatchChannelRequest");
    expect(
      prodNitro.options.virtual[`#nitro/virtual/eve-channel/GET ${EVE_INFO_ROUTE_PATH}`],
    ).toContain("dispatchChannelRequest");
    expect(devNitro.options.virtual[`#eve-route${EVE_INFO_ROUTE_PATH}`]).toBeUndefined();
    expect(prodNitro.options.virtual[`#eve-route${EVE_INFO_ROUTE_PATH}`]).toBeUndefined();
  });

  it("does not register direct workflow queue handlers for Vercel production builds", async () => {
    vi.stubEnv("VERCEL", "1");

    const root = "/tmp/eve-nitro-direct-handlers-vercel";
    const buildDir = `${root}/nitro`;
    const workflowBuildDir = `${root}/workflow-cache`;
    const nitro = createNitroStub({ buildDir, dev: false, rootDir: root });

    await configureProductionNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
        workflowWorld: "@workflow/world-postgres",
      }),
      "all",
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

    await configureProductionNitroRoutes(
      nitro,
      createPreparedHost({
        appRoot: root,
        workflowBuildDir,
        workflowWorld: "@workflow/world-postgres",
      }),
      "all",
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

    await configureProductionNitroRoutes(
      nitro,
      createPreparedHost({ appRoot: root, workflowBuildDir }),
      "all",
    );

    const workflowHandlerSource = readWriteFileSourceMatching("/workflow/workflows-handler.mjs");

    expect(workflowHandlerSource).not.toContain("registerHandler");
    expect(workflowHandlerSource).not.toContain("__eveGetWorkflowWorld");
  });
});

function getRouteKeys(nitro: Nitro): string[] {
  return nitro.options.handlers
    .map((handler) => `${handler.method ?? "ALL"} ${handler.route}`)
    .sort();
}

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
