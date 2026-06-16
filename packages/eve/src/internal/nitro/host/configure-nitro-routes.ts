import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { Nitro } from "nitro/types";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
} from "#protocol/routes.js";
import {
  normalizeEsmImportSpecifier,
  stringifyEsmImportSpecifier,
} from "#internal/application/import-specifier.js";
import {
  resolvePackageRoot,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import {
  createNitroArtifactsConfig,
  type NitroArtifactsConfigInput,
} from "#internal/nitro/host/artifacts-config.js";
import { EVE_WORKFLOW_QUEUE_PREFIX } from "#internal/workflow/queue-namespace.js";
import {
  computeChannelRouteRegistrations,
  registerChannelVirtualHandlers,
} from "#internal/nitro/host/channel-routes.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";

function includesApplicationRoutes(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "app";
}

function includesWorkflowBundles(surface: NitroBuildSurface): boolean {
  return includesWorkflowRoute(surface);
}

function includesWorkflowRoute(surface: NitroBuildSurface): boolean {
  return surface === "all" || surface === "flow";
}

function registerHandler(
  nitro: Nitro,
  options: {
    handlerPath: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    route: string;
  },
): void {
  const virtualId = `#eve-route-handler/${options.method ?? "ALL"} ${options.route}`;
  const handlerPath = stringifyEsmImportSpecifier(options.handlerPath);

  nitro.options.handlers.push({
    handler: virtualId,
    method: options.method,
    route: options.route,
  });
  nitro.options.virtual[virtualId] = [
    `import handler from ${handlerPath};`,
    "export default handler;",
  ].join("\n");
}

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
  },
): Promise<void> {
  const handlerPath = join(
    resolveNitroWorkflowBuildDirectory(nitro),
    `${input.bundleName}-handler.mjs`,
  );
  const handlerDirectoryPath = dirname(handlerPath);
  const bundlePath = createRelativeImportSpecifier(handlerDirectoryPath, input.bundlePath);
  const directHandlers = input.directHandlers ?? [];
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
function addFrameworkVirtualHandler(
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

/**
 * Wires eve's package-owned app, channel, workflow inspection, and Workflow
 * SDK endpoints into one Nitro host instance.
 */
export async function configureNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
  input: {
    surface: NitroBuildSurface;
  },
): Promise<void> {
  if (includesWorkflowBundles(input.surface)) {
    const packageRoot = resolvePackageRoot();
    const builder = new WorkflowBundleBuilder({
      appRoot: preparedHost.appRoot,
      compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
      outDir: preparedHost.workflowBuildDir,
      rootDir: packageRoot,
      watch: nitro.options.dev,
    });
    let syncWorkflowArtifactsPromise: Promise<void> = Promise.resolve();
    const buildWorkflowArtifacts = async (): Promise<void> => {
      await builder.build({
        nitroStepOutfile: includesWorkflowRoute(input.surface)
          ? join(resolveNitroWorkflowBuildDirectory(nitro), "steps.mjs")
          : undefined,
        nitroWorkflowOutfile:
          nitro.options.dev && includesWorkflowRoute(input.surface)
            ? join(resolveNitroWorkflowBuildDirectory(nitro), "workflows.mjs")
            : undefined,
      });
    };
    const syncWorkflowArtifacts = async (): Promise<void> => {
      const nextSync = syncWorkflowArtifactsPromise.then(buildWorkflowArtifacts);
      syncWorkflowArtifactsPromise = nextSync.catch(() => {});
      await nextSync;
    };

    let isInitialBuild = true;

    await syncWorkflowArtifacts();

    nitro.hooks.hook("build:before", async () => {
      if (isInitialBuild) {
        isInitialBuild = false;
        return;
      }

      await syncWorkflowArtifacts();
    });

    if (nitro.options.dev) {
      nitro.hooks.hook("dev:reload", async () => {
        await syncWorkflowArtifacts();
      });
    }
  }

  const artifactsConfig: NitroArtifactsConfigInput = createNitroArtifactsConfig({
    appRoot: preparedHost.appRoot,
    dev: nitro.options.dev,
  });

  if (includesApplicationRoutes(input.surface)) {
    // Framework routes that need no build-time config use physical handler
    // files directly. The home page is a fully static, build-time-baked HTML
    // string with no agent metadata, so it does not need to round-trip
    // through the virtual-handler args plumbing.
    registerHandler(nitro, {
      handlerPath: resolvePackageSourceFilePath("src/internal/nitro/routes/index.ts"),
      method: "GET",
      route: "/",
    });
    registerHandler(nitro, {
      handlerPath: resolvePackageSourceFilePath("src/internal/nitro/routes/health.ts"),
      method: "GET",
      route: EVE_HEALTH_ROUTE_PATH,
    });

    // The agent info endpoint needs `appRoot` baked at build time (used by
    // the disk-source fallback in dev) and runs request-time auth, so it
    // stays a virtual handler.
    addFrameworkVirtualHandler(nitro, {
      args: JSON.stringify({
        ...artifactsConfig,
        mode: nitro.options.dev ? "development" : "production",
      }),
      handlerExport: "handleAgentInfoRequest",
      method: "GET",
      modulePath: resolvePackageSourceFilePath("src/internal/nitro/routes/info.ts"),
      route: EVE_INFO_ROUTE_PATH,
    });

    // Per-channel mounting: one virtual Nitro handler per (method, urlPath) in
    // the merged channel set. Each handler bakes in its route key and artifacts
    // config so the dispatch function can look up the channel and resolve
    // compiled artifacts directly.
    registerChannelVirtualHandlers(nitro, {
      artifactsConfig,
      registrations: computeChannelRouteRegistrations(preparedHost),
    });

    // Dev-only artifact and control routes. These need `appRoot` baked at
    // build time so their handlers can read the dev runtime artifacts from
    // disk, and they are never registered in production builds.
    if (nitro.options.dev) {
      addFrameworkVirtualHandler(nitro, {
        args: JSON.stringify({ appRoot: artifactsConfig.appRoot }),
        handlerExport: "handleDevRuntimeArtifactsRequest",
        method: "GET",
        modulePath: resolvePackageSourceFilePath(
          "src/internal/nitro/routes/dev-runtime-artifacts.ts",
        ),
        route: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
      });
      addFrameworkVirtualHandler(nitro, {
        args: JSON.stringify({ appRoot: artifactsConfig.appRoot }),
        handlerExport: "handleDevRuntimeArtifactsRebuildRequest",
        method: "POST",
        modulePath: resolvePackageSourceFilePath(
          "src/internal/nitro/routes/dev-runtime-artifacts.ts",
        ),
        route: EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
      });
      addFrameworkVirtualHandler(nitro, {
        args: JSON.stringify({ appRoot: artifactsConfig.appRoot }),
        handlerExport: "handleDevScheduleDispatchRequest",
        method: "POST",
        modulePath: resolvePackageSourceFilePath(
          "src/internal/nitro/routes/dev-schedule-dispatch.ts",
        ),
        route: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
      });
    }
  }

  const workflowBuildDirectory = resolveNitroWorkflowBuildDirectory(nitro);
  const workflowBundlePath = includesWorkflowRoute(input.surface)
    ? nitro.options.dev
      ? join(workflowBuildDirectory, "workflows.mjs")
      : join(preparedHost.workflowBuildDir, "workflows.mjs")
    : undefined;

  // Direct handler registration is dev-only: it only helps when the local
  // workflow queue runs inside the same Nitro dev worker. Production
  // deployments dispatch through Vercel's queue trigger.
  const directHandlerEntries: WorkflowDirectHandlerEntry[] =
    nitro.options.dev && workflowBundlePath !== undefined
      ? [{ bundlePath: workflowBundlePath, queuePrefix: EVE_WORKFLOW_QUEUE_PREFIX }]
      : [];
  // Generated handlers will JSON-stringify this at write-time, so we hand them
  // an ESM-safe specifier (Windows drive paths get converted to file://) but
  // skip the surrounding quotes that `stringifyEsmImportSpecifier` adds.
  const runtimeImportSpecifier =
    directHandlerEntries.length > 0
      ? normalizeEsmImportSpecifier(resolveWorkflowModulePath("workflow/runtime"))
      : undefined;

  if (workflowBundlePath) {
    await addWorkflowFileHandler(nitro, {
      bundleName: "workflows",
      bundlePath: workflowBundlePath,
      directHandlers: directHandlerEntries,
      route: "/.well-known/workflow/v1/flow",
      runtimeImportSpecifier,
    });
  }

  nitro.routing.sync();
}
