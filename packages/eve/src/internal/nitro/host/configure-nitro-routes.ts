import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { Nitro } from "nitro/types";
import {
  normalizeEsmImportSpecifier,
  stringifyEsmImportSpecifier,
} from "#internal/application/import-specifier.js";
import { isVercelBuildEnvironment } from "#internal/application/paths.js";
import {
  resolvePackageRoot,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import {
  createDevelopmentNitroArtifactsConfig,
  createProductionNitroArtifactsConfig,
} from "#internal/nitro/host/artifacts-config.js";
import type {
  DevelopmentNitroArtifactsConfig,
  NitroArtifactsConfig,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import {
  type ApplicationRouteRegistry,
  createApplicationRouteRegistry,
} from "#internal/nitro/host/application-route-registry.js";
import { registerChannelVirtualHandlers } from "#internal/nitro/host/channel-routes.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

function resolveNitroWorkflowBuildDirectory(nitro: Nitro): string {
  return join(nitro.options.buildDir, "workflow");
}

function createRelativeImportSpecifier(fromDirectoryPath: string, targetPath: string): string {
  const relativePath = relative(fromDirectoryPath, targetPath).replaceAll("\\", "/");

  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

/**
 * Describes a workflow queue entrypoint eve will register as an in-process
 * direct handler on the runtime world's queue.
 *
 * Direct handlers let the local workflow queue dispatch step / workflow
 * messages without crossing the Nitro dev-server HTTP boundary. This is
 * required for `eve dev` on Windows where the worker → main → worker proxy
 * loop can deadlock under streaming workloads (see the harness-gaps entry
 * for the full background).
 */
interface WorkflowDirectHandlerEntry {
  readonly bundlePath: string;
  readonly queuePrefix: string;
}

/**
 * Registers a physical Nitro handler that adapts a pre-built workflow bundle's
 * named `POST` export into Nitro's default-export handler contract.
 *
 * The adapter uses a relative import to the generated bundle so Windows dev
 * builds do not need to resolve drive-letter file URLs from a virtual module.
 *
 * When `directHandlers` are provided the generated handler also registers each
 * entrypoint as an in-process queue handler on the workflow runtime world. The
 * registration runs at module-load time (before Nitro invokes the route
 * handler) so the very first queue dispatch on this worker can short-circuit
 * the HTTP loopback and call the matching POST handler directly.
 */
async function addWorkflowFileHandler(
  nitro: Nitro,
  input: {
    bundleName: string;
    bundlePath: string;
    directHandlers?: ReadonlyArray<WorkflowDirectHandlerEntry>;
    route: string;
    runtimeImportSpecifier?: string;
    workflowWorldPluginPath?: string;
  },
): Promise<void> {
  const handlerPath = join(
    resolveNitroWorkflowBuildDirectory(nitro),
    `${input.bundleName}-handler.mjs`,
  );
  const handlerDirectoryPath = dirname(handlerPath);
  const bundlePath = createRelativeImportSpecifier(handlerDirectoryPath, input.bundlePath);
  const directHandlers = input.directHandlers ?? [];
  const workflowWorldPluginImportSpecifier =
    directHandlers.length > 0 && input.workflowWorldPluginPath !== undefined
      ? createRelativeImportSpecifier(handlerDirectoryPath, input.workflowWorldPluginPath)
      : undefined;
  const directHandlerImports = directHandlers.map((entry) => {
    const importSpecifier = createRelativeImportSpecifier(handlerDirectoryPath, entry.bundlePath);
    return {
      importSpecifier,
      isOwnBundle: importSpecifier === bundlePath,
      queuePrefix: entry.queuePrefix,
    };
  });

  await mkdir(handlerDirectoryPath, { recursive: true });
  await writeFile(
    handlerPath,
    buildWorkflowFileHandlerSource({
      bundlePath,
      directHandlers: directHandlerImports,
      runtimeImportSpecifier: input.runtimeImportSpecifier,
      workflowWorldPluginImportSpecifier,
    }),
  );

  nitro.options.handlers.push({
    handler: handlerPath,
    route: input.route,
  });
}

/**
 * Renders the source for a Nitro workflow handler module.
 *
 * The generated module always re-exports its bundle's `POST` as the route
 * handler. When `directHandlers` are provided it additionally registers each
 * entrypoint on the workflow world so in-process queue dispatch can bypass
 * the dev-server HTTP loopback. Direct handlers whose bundle matches the
 * route's own bundle reuse the local `POST` import to avoid loading the same
 * module under two specifiers.
 */
function buildWorkflowFileHandlerSource(input: {
  bundlePath: string;
  directHandlers: ReadonlyArray<{
    importSpecifier: string;
    isOwnBundle: boolean;
    queuePrefix: string;
  }>;
  runtimeImportSpecifier?: string;
  workflowWorldPluginImportSpecifier?: string;
}): string {
  const lines: string[] = [
    "// Generated by eve. Do not edit by hand.",
    `import { POST } from ${JSON.stringify(input.bundlePath)};`,
  ];

  if (input.directHandlers.length > 0 && input.runtimeImportSpecifier !== undefined) {
    let companionIndex = 0;
    const handlerBindings = input.directHandlers.map((entry) => {
      if (entry.isOwnBundle) {
        return { ...entry, binding: "POST" };
      }

      const binding = `__eveWorkflowDirectHandler${companionIndex}`;
      companionIndex += 1;
      return { ...entry, binding };
    });

    for (const handler of handlerBindings) {
      if (handler.isOwnBundle) {
        continue;
      }

      lines.push(
        `import { POST as ${handler.binding} } from ${JSON.stringify(handler.importSpecifier)};`,
      );
    }

    if (input.workflowWorldPluginImportSpecifier !== undefined) {
      lines.push(`import ${JSON.stringify(input.workflowWorldPluginImportSpecifier)};`);
    }

    lines.push(
      `import { getWorld as __eveGetWorkflowWorld } from ${JSON.stringify(input.runtimeImportSpecifier)};`,
      "",
      "try {",
      "  const __eveWorkflowWorld = await __eveGetWorkflowWorld();",
      '  if (typeof __eveWorkflowWorld?.registerHandler === "function") {',
    );

    for (const handler of handlerBindings) {
      lines.push(
        `    __eveWorkflowWorld.registerHandler(${JSON.stringify(handler.queuePrefix)}, ${handler.binding});`,
      );
    }

    lines.push(
      "  }",
      "} catch (err) {",
      '  console.warn("[eve] Failed to register direct workflow queue handlers:", err);',
      "}",
    );
  }

  lines.push("", "export default async ({ req }) => {", "  return await POST(req);", "};", "");

  return lines.join("\n");
}

/**
 * Registers a virtual Nitro handler for a framework route that needs
 * build-time config values (e.g. `appRoot`) baked in.
 *
 * The generated handler is invoked by Nitro with `(event)` and forwards
 * `event.req` as the trailing argument to `${handlerExport}`, so the
 * handler can run request-time auth, header inspection, etc. on top of
 * its baked-in config.
 */
function addHostVirtualHandler(
  nitro: Nitro,
  input: {
    args: string;
    handlerExport: string;
    method: "GET" | "POST";
    modulePath: string;
    route: string;
  },
): void {
  const virtualId = `#eve-route${input.route}`;
  const modulePath = stringifyEsmImportSpecifier(input.modulePath);

  nitro.options.handlers.push({
    handler: virtualId,
    method: input.method,
    route: input.route,
  });
  nitro.options.virtual[virtualId] = [
    `import { ${input.handlerExport} } from ${modulePath};`,
    `export default async (event) => ${input.handlerExport}(${input.args}, event.req);`,
  ].join("\n");
}

async function registerWorkflowArtifactBuildHook(
  nitro: Nitro,
  syncWorkflowArtifacts: () => Promise<void>,
): Promise<void> {
  let isInitialBuild = true;

  await syncWorkflowArtifacts();
  nitro.hooks.hook("build:before", async () => {
    if (isInitialBuild) {
      isInitialBuild = false;
      return;
    }

    await syncWorkflowArtifacts();
  });
}

function registerApplicationRoutes(
  nitro: Nitro,
  artifactsConfig: NitroArtifactsConfig,
  registry: ApplicationRouteRegistry,
): void {
  for (const route of registry.routes) {
    switch (route.kind) {
      case "channel":
      case "channel-preflight": {
        registerChannelVirtualHandlers(nitro, {
          artifactsConfig,
          routes: [route],
        });
        break;
      }
      case "development-artifacts": {
        const developmentConfig = artifactsConfig as DevelopmentNitroArtifactsConfig;
        addHostVirtualHandler(nitro, {
          args: JSON.stringify({ appRoot: developmentConfig.appRoot }),
          handlerExport: "handleDevRuntimeArtifactsRequest",
          method: route.method,
          modulePath: resolvePackageSourceFilePath(
            "src/internal/nitro/routes/dev-runtime-artifacts.ts",
          ),
          route: route.path,
        });
        break;
      }
      case "development-schedule": {
        // The complete config is resolved here, in the unbundled host process,
        // and baked into the handler: resolving the module-map loader path from
        // inside the bundled dev server can land on the authored app instead of
        // the installed eve package (vercel/eve#311).
        addHostVirtualHandler(nitro, {
          args: JSON.stringify(artifactsConfig),
          handlerExport: "handleDevScheduleDispatchRequest",
          method: route.method,
          modulePath: resolvePackageSourceFilePath(
            "src/internal/nitro/routes/dev-schedule-dispatch.ts",
          ),
          route: route.path,
        });
        break;
      }
      case "workflow":
        break;
    }
  }
}

function findWorkflowRoute(registry: ApplicationRouteRegistry): string | undefined {
  return registry.routes.find((route) => route.kind === "workflow")?.path;
}

function createWorkflowDirectHandlerEntry(
  preparedHost: PreparedApplicationHost,
  bundlePath: string,
): WorkflowDirectHandlerEntry {
  return {
    bundlePath,
    queuePrefix: deriveEveWorkflowQueuePrefix(preparedHost.compileResult.manifest.config.name),
  };
}

async function registerWorkflowRoute(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
  workflowBundlePath: string,
  directHandlers: ReadonlyArray<WorkflowDirectHandlerEntry>,
  route: string,
): Promise<void> {
  const runtimeImportSpecifier =
    directHandlers.length === 0
      ? undefined
      : normalizeEsmImportSpecifier(resolveWorkflowModulePath("workflow/runtime"));

  await addWorkflowFileHandler(nitro, {
    bundleName: "workflows",
    bundlePath: workflowBundlePath,
    directHandlers,
    route,
    runtimeImportSpecifier,
    workflowWorldPluginPath: preparedHost.compiledArtifacts.workflowWorldPluginPath,
  });
}

/**
 * Wires eve's package-owned app, channel, workflow inspection, dev-control,
 * and Workflow SDK endpoints into one development Nitro candidate.
 */
export async function configureDevelopmentNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): Promise<void> {
  const workflowBuildDirectory = resolveNitroWorkflowBuildDirectory(nitro);
  const builder = new WorkflowBundleBuilder({
    authoredWorkflowModules: preparedHost.compiledArtifacts.authoredWorkflowModules,
    agentName: preparedHost.compileResult.manifest.config.name,
    appRoot: preparedHost.appRoot,
    compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
    outDir: preparedHost.workflowBuildDir,
    rootDir: resolvePackageRoot(),
    watch: true,
  });
  const syncWorkflowArtifacts = async () => {
    await builder.build({
      nitroStepOutfile: join(workflowBuildDirectory, "steps.mjs"),
      nitroWorkflowOutfile: join(workflowBuildDirectory, "workflows.mjs"),
    });
  };

  await registerWorkflowArtifactBuildHook(nitro, syncWorkflowArtifacts);

  const artifactsConfig = createDevelopmentNitroArtifactsConfig({
    appRoot: preparedHost.appRoot,
    configuredWorld: preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
  });
  const routeRegistry = createApplicationRouteRegistry(preparedHost, { development: true });
  registerApplicationRoutes(nitro, artifactsConfig, routeRegistry);

  const workflowBundlePath = join(workflowBuildDirectory, "workflows.mjs");
  const directHandlers: WorkflowDirectHandlerEntry[] = [];
  if (
    !usesParentDevelopmentWorkflowWorld(
      preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
    )
  ) {
    directHandlers.push(createWorkflowDirectHandlerEntry(preparedHost, workflowBundlePath));
  }
  const workflowRoute = findWorkflowRoute(routeRegistry);
  if (workflowRoute !== undefined) {
    await registerWorkflowRoute(
      nitro,
      preparedHost,
      workflowBundlePath,
      directHandlers,
      workflowRoute,
    );
  }
  nitro.routing.sync();
}

/**
 * Wires eve's package-owned app, channel, and Workflow SDK endpoints into the
 * production Nitro host.
 */
export async function configureProductionNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): Promise<void> {
  const builder = new WorkflowBundleBuilder({
    authoredWorkflowModules: preparedHost.compiledArtifacts.authoredWorkflowModules,
    agentName: preparedHost.compileResult.manifest.config.name,
    appRoot: preparedHost.appRoot,
    compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
    outDir: preparedHost.workflowBuildDir,
    rootDir: resolvePackageRoot(),
    watch: false,
  });
  const syncWorkflowArtifacts = async () => {
    await builder.build({
      nitroStepOutfile: join(resolveNitroWorkflowBuildDirectory(nitro), "steps.mjs"),
    });
  };
  await registerWorkflowArtifactBuildHook(nitro, syncWorkflowArtifacts);

  const routeRegistry = createApplicationRouteRegistry(preparedHost);
  registerApplicationRoutes(nitro, createProductionNitroArtifactsConfig(), routeRegistry);

  const workflowBundlePath = join(preparedHost.workflowBuildDir, "workflows.mjs");
  const hasConfiguredWorkflowWorld =
    preparedHost.compileResult.manifest.config.experimental?.workflow?.world !== undefined;
  const directHandlers =
    !isVercelBuildEnvironment() && hasConfiguredWorkflowWorld
      ? [createWorkflowDirectHandlerEntry(preparedHost, workflowBundlePath)]
      : [];
  const workflowRoute = findWorkflowRoute(routeRegistry);
  if (workflowRoute !== undefined) {
    await registerWorkflowRoute(
      nitro,
      preparedHost,
      workflowBundlePath,
      directHandlers,
      workflowRoute,
    );
  }

  nitro.routing.sync();
}
