import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";

import type { Nitro } from "nitro/types";

import { createDevelopmentApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { createDevelopmentAuthoredRebuildCoordinator } from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
} from "#protocol/routes.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";
import { toErrorMessage } from "#shared/errors.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { isLoopbackServerUrl } from "#shared/network-address.js";
import { handleDevRuntimeArtifactsRequest } from "#internal/nitro/routes/dev-runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  pruneLocalSandboxTemplatesInBackground,
  stopDevelopmentSandboxResources,
} from "#execution/sandbox/bindings/local.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import {
  createDevelopmentSandboxRunId,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
} from "#execution/sandbox/development-run.js";
import type {
  DevelopmentServer,
  DevelopmentServerHandle,
  DevelopmentServerOptions,
  StartedDevelopmentServer,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_PORT,
  MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS,
} from "#internal/nitro/host/ports.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { eveDevArguments } from "#setup/primitives/index.js";
import { devBootPhase } from "#internal/dev-boot-progress.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { randomBytes } from "node:crypto";
import {
  createDevelopmentWorkflowWorld,
  installWorkflowLocalQueueEnvironment,
  installWorkflowTransportEnvironment,
} from "#internal/nitro/host/dev-workflow-world-setup.js";
import type { ParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-server.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_HOST,
  normalizeDevelopmentServerClientUrl,
} from "#internal/nitro/host/dev-server-url.js";

const MAX_ALLOWED_DEVELOPMENT_SERVER_PORT = 65_535;
const PORT_ENV = "PORT";

export { normalizeDevelopmentServerClientUrl };

/**
 * Returns whether a supplied URL identifies this app's healthy local development
 * server. Only that server receives the local TUI credential path.
 */
export async function isActiveDevelopmentServerForApp(input: {
  readonly appRoot: string;
  readonly serverUrl: string;
}): Promise<boolean> {
  try {
    const project = await resolveDiscoveryProject(input.appRoot);
    const recordedServerUrl = await new DevelopmentServerState(project).read();
    if (
      recordedServerUrl === undefined ||
      !isLoopbackServerUrl(recordedServerUrl) ||
      !(await isEveServerHealthy(recordedServerUrl))
    ) {
      return false;
    }

    return (
      new URL(recordedServerUrl).origin ===
      new URL(normalizeDevelopmentServerClientUrl(input.serverUrl)).origin
    );
  } catch {
    return false;
  }
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

type NitroDevelopmentServer = DrainedNitroDevServer;

function resolveDevelopmentServerPort(port: number | string | undefined): number {
  const resolvedPort =
    typeof port === "string" ? Number(port) : (port ?? DEFAULT_DEVELOPMENT_SERVER_PORT);

  if (
    !Number.isInteger(resolvedPort) ||
    resolvedPort < 0 ||
    resolvedPort > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT
  ) {
    throw new Error(
      `Invalid development server port "${String(port)}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return resolvedPort;
}

function readEnvironmentPort(): number | undefined {
  const raw = process.env[PORT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT) {
    throw new Error(
      `Invalid ${PORT_ENV} environment variable "${raw}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  }

  return parsed;
}

async function detectDevelopmentCommandPackageManager(
  appRoot: string,
): Promise<PackageManagerKind> {
  try {
    return (await detectPackageManager(appRoot)).kind;
  } catch {
    return "pnpm";
  }
}

async function formatDevelopmentServerConnectCommand(
  appRoot: string,
  serverUrl: string,
): Promise<string> {
  const packageManager = await detectDevelopmentCommandPackageManager(appRoot);
  return [packageManager, ...eveDevArguments(packageManager), serverUrl].join(" ");
}

async function createDevelopmentServerAlreadyRunningError(
  appRoot: string,
  serverUrl: string,
): Promise<Error> {
  const connectCommand = await formatDevelopmentServerConnectCommand(appRoot, serverUrl);
  return new Error(
    [
      "A dev server is already running for this eve agent.",
      `To connect to the existing instance, run: ${connectCommand}`,
    ].join("\n"),
  );
}

function resolveDevelopmentServerPorts(input: {
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}): readonly [number, ...number[]] {
  const resolvedPort = resolveDevelopmentServerPort(input.port);

  if (resolvedPort === 0 || !input.retryOnAddressInUse) {
    return [resolvedPort];
  }

  const ports: number[] = [];

  for (let offset = 0; offset < MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS; offset += 1) {
    const candidate = resolvedPort + offset;

    if (candidate > 65_535) {
      break;
    }

    ports.push(candidate);
  }

  return ports as [number, ...number[]];
}

function addDevelopmentControlHandler(input: {
  readonly appRoot: string;
  readonly devServer: DrainedNitroDevServer;
  readonly getWatcher: () => AuthoredSourceWatcherHandle | undefined;
  readonly workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
}): void {
  input.devServer.setControlHandler(async (request) => {
    const worldResponse = await input.workflowWorld?.handleRequest(request);
    if (worldResponse !== undefined) {
      return worldResponse;
    }
    const url = new URL(request.url);
    if (url.pathname === EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH && request.method === "GET") {
      return handleDevRuntimeArtifactsRequest({ appRoot: input.appRoot });
    }
    if (url.pathname !== EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH || request.method !== "GET") {
      return undefined;
    }
    const watcher = input.getWatcher();
    if (watcher === undefined) {
      return Response.json({ error: "The development server is still starting." }, { status: 503 });
    }
    if (url.searchParams.get("force") === "1") {
      await watcher.rebuild();
    } else {
      await watcher.flush();
    }
    return handleDevRuntimeArtifactsRequest({ appRoot: input.appRoot });
  });
}

async function closeDevelopmentServerResources(input: {
  readonly appRoot: string;
  readonly authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  readonly devServer: NitroDevelopmentServer | undefined;
  readonly developmentSandboxRunId: string;
  readonly nitro: Nitro | undefined;
  readonly workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
}): Promise<{ readonly errors: readonly unknown[]; readonly listenerClosed: boolean }> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };

  const authoredSourceWatcher = input.authoredSourceWatcher;
  if (authoredSourceWatcher !== undefined) {
    await attempt(() => authoredSourceWatcher.close());
  }
  const devServer = input.devServer;
  const listenerClosed = devServer === undefined ? true : await attempt(() => devServer.close());
  const workflowWorld = input.workflowWorld;
  if (workflowWorld !== undefined) {
    await attempt(() => workflowWorld.close());
  }
  const nitro = input.nitro;
  if (nitro !== undefined) {
    await attempt(() => nitro.close());
  }
  await attempt(() =>
    stopDevelopmentSandboxResources({
      appRoot: input.appRoot,
      devRunId: input.developmentSandboxRunId,
      log: (message) => console.warn(`[eve:dev] ${message}`),
    }),
  );

  return { errors, listenerClosed };
}

function createDevelopmentServerCleanupError(errors: readonly unknown[]): Error | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error
      ? error
      : new Error(`Failed to close the development server: ${toErrorMessage(error)}`, {
          cause: error,
        });
  }

  return new AggregateError(errors, "Multiple development-server resources failed to close.");
}

function createDevelopmentServerStartupCleanupError(
  startupError: unknown,
  cleanupErrors: readonly unknown[],
): AggregateError {
  return new AggregateError(
    [startupError, ...cleanupErrors],
    `${toErrorMessage(startupError)} Cleanup also failed.`,
    { cause: startupError },
  );
}

async function listenForDevelopmentServer(input: {
  readonly devServer: NitroDevelopmentServer;
  readonly host: string;
  readonly port: number | string | undefined;
  readonly retryOnAddressInUse: boolean;
}) {
  const ports = resolveDevelopmentServerPorts({
    port: input.port,
    retryOnAddressInUse: input.retryOnAddressInUse,
  });
  let lastError: unknown;

  for (const port of ports) {
    const server = input.devServer.listen({
      hostname: input.host,
      port,
    });

    try {
      await server.ready();
      return server;
    } catch (error) {
      lastError = error;
      await server.close().catch(() => {});

      if (!isAddressInUseError(error)) {
        throw error;
      }

      if (!input.retryOnAddressInUse) {
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to start Nitro dev server after ${ports.length} attempts. Tried ports ${ports.join(", ")}.`,
    {
      cause: lastError,
    },
  );
}

interface DevelopmentServerStartResult {
  readonly handle: DevelopmentServerHandle;
  /** Teardown for a server this process owns; undefined when attached to an existing owner. */
  readonly close: (() => Promise<void>) | undefined;
}

async function startNitroDevelopmentServer(
  rootDir: string,
  options: DevelopmentServerOptions,
): Promise<DevelopmentServerStartResult> {
  // Marks this process tree as an `eve dev` session so runtime features
  // that must never run in production (for example auto-installing
  // optional sandbox engine packages) can gate on it.
  process.env[EVE_DEV_ENV_FLAG] ??= "1";

  const project = await resolveDiscoveryProject(rootDir);
  loadDevelopmentEnvironmentFiles(project.appRoot);

  const environmentPort = readEnvironmentPort();
  const requestedPort = options.port ?? environmentPort;
  const hasExplicitEndpoint =
    options.host !== undefined || options.port !== undefined || environmentPort !== undefined;
  const state = new DevelopmentServerState(project);
  const existingServerUrl = await state.read();

  if (
    existingServerUrl !== undefined &&
    isLoopbackServerUrl(existingServerUrl) &&
    (await isEveServerHealthy(existingServerUrl))
  ) {
    if (options.existing === "attach-if-unconfigured" && !hasExplicitEndpoint) {
      return {
        handle: { kind: "existing", appRoot: project.appRoot, url: existingServerUrl },
        close: undefined,
      };
    }
    throw await createDevelopmentServerAlreadyRunningError(project.appRoot, existingServerUrl);
  }

  const previousDevelopmentSandboxRunId = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  const developmentSandboxRunId = createDevelopmentSandboxRunId();
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = developmentSandboxRunId;
  let nitro: Nitro | undefined;
  let devServer: NitroDevelopmentServer | undefined;
  let restoreWorkflowLocalQueueEnvironment: (() => void) | undefined;
  let restoreWorkflowTransportEnvironment: (() => void) | undefined;
  let workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
  let authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  let preparedDevelopmentHost: PreparedDevelopmentApplicationHost | undefined;
  let initialGenerationPublished = false;
  let initialWorkspaceTransferred = false;

  try {
    const preparedHost = await devBootPhase(
      "compiling agent",
      () => prepareDevelopmentApplicationHost(project.appRoot),
      options.onBootProgress,
    );
    preparedDevelopmentHost = preparedHost;
    const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(
      createDevelopmentNitroArtifactsConfig({
        appRoot: preparedHost.appRoot,
        configuredWorld: preparedHost.compileResult.manifest.config.experimental?.workflow?.world,
      }),
    );
    pruneLocalSandboxTemplatesInBackground(preparedHost.appRoot);
    const activeNitro = await devBootPhase(
      "creating dev server",
      () => createDevelopmentApplicationNitro(preparedHost),
      options.onBootProgress,
    );
    nitro = activeNitro;
    devServer = new DrainedNitroDevServer(activeNitro.logger);
    const activeDevServer = devServer;
    const workflowTransportSecret = randomBytes(32).toString("base64url");
    activeDevServer.setClientAddressSecret(workflowTransportSecret);
    restoreWorkflowTransportEnvironment = installWorkflowTransportEnvironment(
      project.appRoot,
      workflowTransportSecret,
    );
    workflowWorld = createDevelopmentWorkflowWorld({
      appRoot: project.appRoot,
      preparedHost,
      transportSecret: workflowTransportSecret,
    });
    // Parent-owned control routes must answer before the World starts: queue
    // redelivery begins at start(), and a delivery's World calls would
    // otherwise fall through to the worker and 404.
    addDevelopmentControlHandler({
      appRoot: project.appRoot,
      devServer: activeDevServer,
      getWatcher: () => authoredSourceWatcher,
      workflowWorld,
    });
    const hostname =
      options.host ?? activeNitro.options.devServer.hostname ?? DEFAULT_DEVELOPMENT_SERVER_HOST;
    const retryOnAddressInUse = requestedPort === undefined;
    const server = await devBootPhase(
      "binding port",
      () =>
        listenForDevelopmentServer({
          devServer: activeDevServer,
          host: hostname,
          port: requestedPort,
          retryOnAddressInUse,
        }),
      options.onBootProgress,
    );

    if (!server.url) {
      throw new Error("Nitro dev server did not expose a URL.");
    }

    const serverUrl = normalizeDevelopmentServerClientUrl(server.url);
    restoreWorkflowLocalQueueEnvironment = installWorkflowLocalQueueEnvironment(serverUrl);
    await devBootPhase(
      "building dev bundle",
      async () => {
        const payload = await buildDevelopmentHostCandidate({
          host: preparedHost,
          nitro: activeNitro,
        });
        nitro = undefined;
        const workspace = preparedHost.workspace;
        initialWorkspaceTransferred = true;
        await activeDevServer.replaceWorker({
          dispose: async () => await removeDevelopmentHostWorkspace(workspace),
          entry: payload.entry,
          workerData: payload.workerData,
        });
        await activateDevelopmentGeneration({
          appRoot: preparedHost.appRoot,
          generation: preparedHost.generation,
        });
        initialGenerationPublished = true;
      },
      options.onBootProgress,
    );
    await workflowWorld?.start();
    startDevelopmentSandboxPrewarmInBackground({
      appRoot: preparedHost.appRoot,
      compiledArtifactsSource,
    });

    const rebuildCoordinator = await createDevelopmentAuthoredRebuildCoordinator({
      devServer: activeDevServer,
      initialHost: preparedHost,
    });

    authoredSourceWatcher = await devBootPhase(
      "starting file watcher",
      async () => {
        const { startAuthoredSourceWatcher } =
          await import("#internal/nitro/host/dev-authored-source-watcher.js");
        return startAuthoredSourceWatcher({
          coordinator: rebuildCoordinator,
          preparedHost,
        });
      },
      options.onBootProgress,
    );
    await state.write(serverUrl);
    const restoreWorkflowLocalQueueEnvironmentOnClose = restoreWorkflowLocalQueueEnvironment;
    if (restoreWorkflowLocalQueueEnvironmentOnClose === undefined) {
      throw new Error("Workflow local queue environment was not initialized.");
    }

    const authoredSourceWatcherOnClose = authoredSourceWatcher;
    const devServerOnClose = devServer;
    const workflowWorldOnClose = workflowWorld;
    const restoreWorkflowTransportEnvironmentOnClose = restoreWorkflowTransportEnvironment;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const cleanup = await closeDevelopmentServerResources({
          appRoot: project.appRoot,
          authoredSourceWatcher: authoredSourceWatcherOnClose,
          devServer: devServerOnClose,
          developmentSandboxRunId,
          nitro: undefined,
          workflowWorld: workflowWorldOnClose,
        });
        if (cleanup.listenerClosed) {
          await state.remove().catch(() => {});
        }

        try {
          const cleanupError = createDevelopmentServerCleanupError(cleanup.errors);
          if (cleanupError !== undefined) {
            throw cleanupError;
          }
        } finally {
          restoreWorkflowLocalQueueEnvironmentOnClose();
          restoreWorkflowTransportEnvironmentOnClose?.();
          restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId);
        }
      })();
      return closePromise;
    };
    return {
      handle: { kind: "started", appRoot: project.appRoot, url: serverUrl },
      close,
    };
  } catch (error) {
    const cleanup = await closeDevelopmentServerResources({
      appRoot: project.appRoot,
      authoredSourceWatcher,
      devServer,
      developmentSandboxRunId,
      nitro,
      workflowWorld,
    });
    const cleanupErrors = [...cleanup.errors];
    if (preparedDevelopmentHost !== undefined && !initialGenerationPublished) {
      await discardDevelopmentGeneration(preparedDevelopmentHost.generation).catch(
        (cleanupError) => {
          cleanupErrors.push(cleanupError);
        },
      );
    }
    if (preparedDevelopmentHost !== undefined && !initialWorkspaceTransferred) {
      await removeDevelopmentHostWorkspace(preparedDevelopmentHost.workspace).catch(
        (cleanupError) => {
          cleanupErrors.push(cleanupError);
        },
      );
    }
    restoreWorkflowLocalQueueEnvironment?.();
    restoreWorkflowTransportEnvironment?.();
    if (cleanup.listenerClosed) {
      await state.remove().catch(() => {});
    }
    restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId);
    if (cleanupErrors.length > 0) {
      throw createDevelopmentServerStartupCleanupError(error, cleanupErrors);
    }
    throw error;
  }
}

/**
 * Creates a development server for an eve application. Call `start()` to boot an
 * owned Nitro server or attach to a running owner, and `close()` to tear down a
 * server this instance started. `close()` waits for an in-progress `start()`,
 * resolves after failed-start cleanup, and is a no-op when it attached to an
 * existing owner or was never started.
 *
 * Authored schedules are never registered with Nitro's cron scheduler in dev
 * mode. To fire one authored schedule on demand, `POST` the dev-only
 * `/eve/v1/dev/schedules/:scheduleId` route — the handler returns
 * `{ scheduleId, sessionIds }` so callers can subscribe to the existing
 * per-session stream route.
 */
export function createDevelopmentServer(
  rootDir: string,
  options?: DevelopmentServerOptions & { existing?: "reject" },
): DevelopmentServer<StartedDevelopmentServer>;
export function createDevelopmentServer(
  rootDir: string,
  options?: DevelopmentServerOptions,
): DevelopmentServer;
export function createDevelopmentServer(
  rootDir: string,
  options: DevelopmentServerOptions = {},
): DevelopmentServer {
  let startPromise: Promise<DevelopmentServerHandle> | undefined;
  let closeStartedServer: (() => Promise<void>) | undefined;

  return {
    start(): Promise<DevelopmentServerHandle> {
      if (startPromise !== undefined) {
        throw new Error("DevelopmentServer.start() was already called.");
      }

      startPromise = startNitroDevelopmentServer(rootDir, options).then(({ handle, close }) => {
        closeStartedServer = close;
        return handle;
      });
      return startPromise;
    },
    async close(): Promise<void> {
      if (startPromise === undefined) {
        return;
      }

      await startPromise.catch(() => undefined);
      await closeStartedServer?.();
    },
  };
}

function restoreDevelopmentSandboxRunId(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    return;
  }
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = previous;
}
