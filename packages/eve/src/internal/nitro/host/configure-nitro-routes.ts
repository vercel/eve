import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { Nitro, NitroEventHandler } from "nitro/types";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
} from "#protocol/routes.js";
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
  computeChannelRouteRegistrations,
  registerChannelVirtualHandlers,
} from "#internal/nitro/host/channel-routes.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";
import {
  digestDevelopmentControlToken,
  getOrCreateDevelopmentControlToken,
  persistDevelopmentControlToken,
} from "#internal/nitro/dev-control-auth.js";

export function createEveNitroHandlerVirtualId(method: string | undefined, route: string): string {
  return `#eve-route-handler/${method ?? "ALL"} ${route}`;
}

export function createEveNitroFrameworkVirtualId(route: string): string {
  return `#eve-route${route}`;
}

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
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    route: string;
  },
): void {
  const virtualId = createEveNitroHandlerVirtualId(options.method, options.route);
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
async function prepareWorkflowFileHandler(
  nitro: Nitro,
  input: {
    bundleName: string;
    bundlePath: string;
    directHandlers?: ReadonlyArray<WorkflowDirectHandlerEntry>;
    route: string;
    runtimeImportSpecifier?: string;
    workflowWorldPluginPath?: string;
  },
): Promise<NitroEventHandler> {
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

  return {
    handler: handlerPath,
    route: input.route,
  };
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
  const virtualId = createEveNitroFrameworkVirtualId(input.route);
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

function registerWorkflowArtifactBuildHook(
  nitro: Nitro,
  syncWorkflowArtifacts: () => Promise<void>,
): void {
  let isInitialBuild = true;

  nitro.hooks.hook("build:before", async () => {
    if (isInitialBuild) {
      isInitialBuild = false;
      return;
    }

    await syncWorkflowArtifacts();
  });
}

interface PreparedApplicationRoutes {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly channelRegistrations: ReturnType<typeof computeChannelRouteRegistrations>;
}

function prepareApplicationRoutes(
  preparedHost: PreparedApplicationHost,
  artifactsConfig: NitroArtifactsConfig,
): PreparedApplicationRoutes {
  return {
    artifactsConfig,
    channelRegistrations: computeChannelRouteRegistrations(preparedHost),
  };
}

function registerApplicationRoutes(nitro: Nitro, prepared: PreparedApplicationRoutes): void {
  for (const method of ["GET", "HEAD"] as const) {
    registerHandler(nitro, {
      handlerPath: resolvePackageSourceFilePath("src/internal/nitro/routes/health.ts"),
      method,
      route: EVE_HEALTH_ROUTE_PATH,
    });
  }
  registerChannelVirtualHandlers(nitro, {
    artifactsConfig: prepared.artifactsConfig,
    registrations: prepared.channelRegistrations,
  });
}

/**
 * Registers the root page owned by eve's standalone Nitro host.
 *
 * This shell route is deliberately separate from the reusable application
 * routes so an embedding host retains ownership of its own root page.
 */
export function configureStandaloneNitroShellRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): void {
  addFrameworkVirtualHandler(nitro, {
    args: JSON.stringify({
      agentName: preparedHost.compileResult.manifest.config.name,
    }),
    handlerExport: "handleHomePageRequest",
    method: "GET",
    modulePath: resolvePackageSourceFilePath("src/internal/nitro/routes/index.ts"),
    route: "/",
  });
}

function registerDevelopmentControlRoutes(
  nitro: Nitro,
  artifactsConfig: DevelopmentNitroArtifactsConfig,
  controlTokenDigest: string,
): void {
  addFrameworkVirtualHandler(nitro, {
    args: JSON.stringify({ appRoot: artifactsConfig.appRoot }),
    handlerExport: "handleDevRuntimeArtifactsRequest",
    method: "GET",
    modulePath: resolvePackageSourceFilePath("src/internal/nitro/routes/dev-runtime-artifacts.ts"),
    route: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  });
  addFrameworkVirtualHandler(nitro, {
    // The complete config is resolved here, in the unbundled host process,
    // and baked into the handler: resolving the module-map loader path from
    // inside the bundled dev server can land on the authored app instead of
    // the installed eve package (vercel/eve#311).
    args: JSON.stringify({
      artifactsConfig,
      controlTokenDigest,
    }),
    handlerExport: "handleDevScheduleDispatchRequest",
    method: "POST",
    modulePath: resolvePackageSourceFilePath("src/internal/nitro/routes/dev-schedule-dispatch.ts"),
    route: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  });
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

async function prepareWorkflowRoute(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
  workflowBundlePath: string,
  directHandlers: ReadonlyArray<WorkflowDirectHandlerEntry>,
): Promise<NitroEventHandler> {
  const runtimeImportSpecifier =
    directHandlers.length === 0
      ? undefined
      : normalizeEsmImportSpecifier(resolveWorkflowModulePath("workflow/runtime"));

  return await prepareWorkflowFileHandler(nitro, {
    bundleName: "workflows",
    bundlePath: workflowBundlePath,
    directHandlers,
    route: "/.well-known/workflow/v1/flow",
    runtimeImportSpecifier,
    workflowWorldPluginPath: preparedHost.compiledArtifacts.workflowWorldPluginPath,
  });
}

export interface PreparedDevelopmentNitroRoutes {
  readonly application: PreparedApplicationRoutes;
  readonly artifactsConfig: DevelopmentNitroArtifactsConfig;
  readonly controlTokenDigest: string;
  readonly syncWorkflowArtifacts: () => Promise<void>;
  readonly workflowHandler: NitroEventHandler;
}

/** Prepares every fallible development route artifact before Nitro mutation. */
export async function prepareDevelopmentNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): Promise<PreparedDevelopmentNitroRoutes> {
  const workflowBuildDirectory = resolveNitroWorkflowBuildDirectory(nitro);
  const builder = new WorkflowBundleBuilder({
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
  await syncWorkflowArtifacts();

  const artifactsConfig = createDevelopmentNitroArtifactsConfig({
    appRoot: preparedHost.appRoot,
    configuredWorld: preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
  });
  const controlToken = getOrCreateDevelopmentControlToken(artifactsConfig.appRoot);
  await persistDevelopmentControlToken(artifactsConfig.appRoot, controlToken);
  const workflowBundlePath = join(workflowBuildDirectory, "workflows.mjs");
  const directHandlers: WorkflowDirectHandlerEntry[] = [];
  if (
    !usesParentDevelopmentWorkflowWorld(
      preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
    )
  ) {
    directHandlers.push(createWorkflowDirectHandlerEntry(preparedHost, workflowBundlePath));
  }

  return {
    application: prepareApplicationRoutes(preparedHost, artifactsConfig),
    artifactsConfig,
    controlTokenDigest: digestDevelopmentControlToken(controlToken),
    syncWorkflowArtifacts,
    workflowHandler: await prepareWorkflowRoute(
      nitro,
      preparedHost,
      workflowBundlePath,
      directHandlers,
    ),
  };
}

/**
 * Applies prepared eve-owned application, control, and Workflow routes without
 * installing the standalone host's root-page shell.
 */
export function applyPreparedDevelopmentNitroRoutes(
  nitro: Nitro,
  prepared: PreparedDevelopmentNitroRoutes,
): void {
  registerWorkflowArtifactBuildHook(nitro, prepared.syncWorkflowArtifacts);
  registerApplicationRoutes(nitro, prepared.application);
  registerDevelopmentControlRoutes(nitro, prepared.artifactsConfig, prepared.controlTokenDigest);
  nitro.options.handlers.push(prepared.workflowHandler);
}

/** Prepares and applies development routes for direct internal callers. */
export async function configureDevelopmentNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
): Promise<void> {
  applyPreparedDevelopmentNitroRoutes(
    nitro,
    await prepareDevelopmentNitroRoutes(nitro, preparedHost),
  );
}

export interface PreparedProductionNitroRoutes {
  readonly application: PreparedApplicationRoutes | undefined;
  readonly syncWorkflowArtifacts: (() => Promise<void>) | undefined;
  readonly workflowHandler: NitroEventHandler | undefined;
}

/** Prepares every fallible production route artifact before Nitro mutation. */
export async function prepareProductionNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
  surface: NitroBuildSurface,
): Promise<PreparedProductionNitroRoutes> {
  let syncWorkflowArtifacts: (() => Promise<void>) | undefined;
  if (includesWorkflowBundles(surface)) {
    const builder = new WorkflowBundleBuilder({
      agentName: preparedHost.compileResult.manifest.config.name,
      appRoot: preparedHost.appRoot,
      compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
      outDir: preparedHost.workflowBuildDir,
      rootDir: resolvePackageRoot(),
      watch: false,
    });
    syncWorkflowArtifacts = async () => {
      await builder.build({
        nitroStepOutfile: join(resolveNitroWorkflowBuildDirectory(nitro), "steps.mjs"),
      });
    };
    await syncWorkflowArtifacts();
  }

  const application = includesApplicationRoutes(surface)
    ? prepareApplicationRoutes(preparedHost, createProductionNitroArtifactsConfig())
    : undefined;
  let workflowHandler: NitroEventHandler | undefined;
  if (includesWorkflowRoute(surface)) {
    const workflowBundlePath = join(preparedHost.workflowBuildDir, "workflows.mjs");
    const hasConfiguredWorkflowWorld =
      preparedHost.compileResult.manifest.config.experimental?.workflow?.world !== undefined;
    const directHandlers =
      !isVercelBuildEnvironment() && hasConfiguredWorkflowWorld
        ? [createWorkflowDirectHandlerEntry(preparedHost, workflowBundlePath)]
        : [];
    workflowHandler = await prepareWorkflowRoute(
      nitro,
      preparedHost,
      workflowBundlePath,
      directHandlers,
    );
  }

  return {
    application,
    syncWorkflowArtifacts,
    workflowHandler,
  };
}

/**
 * Applies the prepared subset of eve-owned application and Workflow routes
 * without installing the standalone root-page shell.
 */
export function applyPreparedProductionNitroRoutes(
  nitro: Nitro,
  prepared: PreparedProductionNitroRoutes,
): void {
  if (prepared.syncWorkflowArtifacts !== undefined) {
    registerWorkflowArtifactBuildHook(nitro, prepared.syncWorkflowArtifacts);
  }
  if (prepared.application !== undefined) {
    registerApplicationRoutes(nitro, prepared.application);
  }
  if (prepared.workflowHandler !== undefined) {
    nitro.options.handlers.push(prepared.workflowHandler);
  }
}

/** Prepares and applies production routes for direct internal callers. */
export async function configureProductionNitroRoutes(
  nitro: Nitro,
  preparedHost: PreparedApplicationHost,
  surface: NitroBuildSurface,
): Promise<void> {
  applyPreparedProductionNitroRoutes(
    nitro,
    await prepareProductionNitroRoutes(nitro, preparedHost, surface),
  );
}
