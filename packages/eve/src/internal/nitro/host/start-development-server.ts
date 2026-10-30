import { handleDevelopmentModelCredentialRequest } from "#internal/model-auth/development-broker-server.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import { defaultDevelopmentExtensions } from "#compiler/development-extensions.js";

import { createDevelopmentBuilds } from "#internal/nitro/host/dev-build-host.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { createDevelopmentAuthoredRebuildCoordinator } from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
} from "#protocol/routes.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";
import { toErrorMessage } from "#shared/errors.js";
import { isLoopbackServerUrl } from "#shared/network-address.js";
import { readDevelopmentRuntimeArtifactsRevision } from "#services/dev-client/runtime-artifacts.js";
import { handleDevRuntimeArtifactsRequest } from "#internal/nitro/routes/dev-runtime-artifacts.js";
import {
  pruneLocalSandboxTemplatesInBackground,
  stopDevelopmentSandboxResources,
} from "#execution/sandbox/bindings/local.js";
import {
  createDevelopmentSandboxRunId,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
} from "#execution/sandbox/development-run.js";
import type {
  DevelopmentServer,
  DevelopmentServerHandle,
  DevelopmentServerOptions,
  StartedDevelopmentServer,
} from "#internal/nitro/host/types.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import {
  readDevelopmentServerEnvironmentPort,
  resolveDevelopmentServerPorts,
} from "#internal/nitro/host/ports.js";
import { installLocalDevCapabilityEnvironment } from "#runtime/local-dev-capability.js";
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

const DEVELOPMENT_SERVER_READINESS_TIMEOUT_MS = 1_000;

export { normalizeDevelopmentServerClientUrl };

async function isDevelopmentServerReady(serverUrl: string): Promise<boolean> {
  return (
    (await readDevelopmentRuntimeArtifactsRevision({
      serverUrl,
      timeoutMs: DEVELOPMENT_SERVER_READINESS_TIMEOUT_MS,
    })) !== undefined
  );
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

type NitroDevelopmentServer = DrainedNitroDevServer;

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
  return [
    packageManager,
    ...eveDevArguments(packageManager).slice(0, -1),
    "remote",
    "connect",
    "--url",
    serverUrl,
  ].join(" ");
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

function addDevelopmentControlHandler(input: {
  readonly appRoot: string;
  readonly devServer: DrainedNitroDevServer;
  readonly getWatcher: () => AuthoredSourceWatcherHandle | undefined;
  readonly workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
  readonly transportSecret: string;
}): void {
  input.devServer.setControlHandler(async (request) => {
    const credentialResponse = await handleDevelopmentModelCredentialRequest(request, {
      appRoot: input.appRoot,
      secret: input.transportSecret,
    });
    if (credentialResponse !== undefined) return credentialResponse;
    const worldResponse = await input.workflowWorld?.handleRequest(request);
    if (worldResponse !== undefined) {
      return worldResponse;
    }
    const url = new URL(request.url);
    if (url.pathname === EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH && request.method === "GET") {
      return handleDevRuntimeArtifactsRequest({ appRoot: input.appRoot });
    }
    const isSuspendRequest =
      url.pathname === EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH && request.method === "POST";
    const isResumeRequest =
      url.pathname === EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH && request.method === "POST";
    const isRebuildRequest =
      url.pathname === EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH &&
      (request.method === "GET" || request.method === "POST");
    if (!isSuspendRequest && !isResumeRequest && !isRebuildRequest) {
      return undefined;
    }
    const watcher = input.getWatcher();
    if (watcher === undefined) {
      return Response.json({ error: "The development server is still starting." }, { status: 503 });
    }
    const leaseId = url.searchParams.get("lease");
    if ((isSuspendRequest || isResumeRequest) && (leaseId === null || leaseId.length === 0)) {
      return Response.json({ error: "A suspension lease is required." }, { status: 400 });
    }
    if (isSuspendRequest) {
      await watcher.suspend(leaseId!);
      return Response.json({ suspended: true });
    }
    if (isResumeRequest) {
      await watcher.resume(leaseId!, { silent: url.searchParams.get("silent") === "1" });
      return handleDevRuntimeArtifactsRequest({ appRoot: input.appRoot });
    }
    if (url.searchParams.get("force") === "1") {
      await watcher.rebuild();
    } else {
      await watcher.flush();
    }
    return handleDevRuntimeArtifactsRequest({ appRoot: input.appRoot });
  });
}

/** Disposes a cleanup stack and returns every failure in teardown order. */
async function disposeCollectingErrors(cleanup: AsyncDisposableStack): Promise<unknown[]> {
  try {
    await cleanup.disposeAsync();
    return [];
  } catch (error) {
    return collectDisposalErrors(error);
  }
}

function collectDisposalErrors(error: unknown): unknown[] {
  // Each later failure wraps the earlier ones as `suppressed`.
  return error instanceof SuppressedError
    ? [...collectDisposalErrors(error.suppressed), error.error]
    : [error];
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

  const developmentExtensions = options.developmentExtensions ?? defaultDevelopmentExtensions();
  const project = await resolveDiscoveryProject(rootDir);
  await loadDevelopmentEnvironmentFiles(project.appRoot);

  const environmentPort = readDevelopmentServerEnvironmentPort();
  const requestedPort = options.port ?? environmentPort;
  const hasExplicitServerConfiguration =
    options.resume === true ||
    options.developmentExtensions !== undefined ||
    options.host !== undefined ||
    options.port !== undefined ||
    environmentPort !== undefined;
  const state = new DevelopmentServerState(project);
  const existingServerUrl = await state.read();

  if (
    existingServerUrl !== undefined &&
    isLoopbackServerUrl(existingServerUrl) &&
    (await isDevelopmentServerReady(existingServerUrl))
  ) {
    if (options.existing === "attach-if-unconfigured" && !hasExplicitServerConfiguration) {
      return {
        handle: { kind: "existing", appRoot: project.appRoot, url: existingServerUrl },
        close: undefined,
      };
    }
    throw await createDevelopmentServerAlreadyRunningError(project.appRoot, existingServerUrl);
  }

  // Teardown runs in reverse registration order, shared by failed startup and close().
  const cleanup = new AsyncDisposableStack();
  const previousDevelopmentSandboxRunId = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
  const developmentSandboxRunId = createDevelopmentSandboxRunId();
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = developmentSandboxRunId;
  cleanup.defer(() => restoreDevelopmentSandboxRunId(previousDevelopmentSandboxRunId));
  let listenerClosed = true;
  cleanup.defer(async () => {
    if (listenerClosed) {
      await state.remove().catch(() => {});
    }
  });
  let restoreLocalDevCapabilityEnvironment: (() => void) | undefined;
  let restoreWorkflowLocalQueueEnvironment: (() => void) | undefined;
  let restoreWorkflowTransportEnvironment: (() => void) | undefined;
  cleanup.defer(() => {
    restoreWorkflowLocalQueueEnvironment?.();
    restoreWorkflowTransportEnvironment?.();
    restoreLocalDevCapabilityEnvironment?.();
  });
  cleanup.defer(
    async () =>
      await stopDevelopmentSandboxResources({
        devRunId: developmentSandboxRunId,
        log: (message) => console.warn(`[eve:dev] ${message}`),
      }),
  );
  const builds = createDevelopmentBuilds();
  const build = builds.begin();
  cleanup.defer(() => build.close());
  cleanup.defer(() => builds.close());
  let authoredSourceWatcher: AuthoredSourceWatcherHandle | undefined;
  let initialGenerationPublished = false;
  let initialWorkspaceTransferred = false;

  try {
    const preparedHost = await devBootPhase(
      "compiling agent",
      () => build.prepare({ appRoot: project.appRoot, developmentExtensions }),
      options.onBootProgress,
    );
    cleanup.defer(async () => {
      if (!initialWorkspaceTransferred) {
        await removeDevelopmentHostWorkspace(preparedHost.workspace);
      }
    });
    cleanup.defer(async () => {
      if (!initialGenerationPublished) {
        await discardDevelopmentGeneration(preparedHost.generation);
      }
    });
    pruneLocalSandboxTemplatesInBackground(preparedHost.appRoot);
    const devServer = new DrainedNitroDevServer();
    cleanup.defer(async () => {
      try {
        await devServer.close();
      } catch (error) {
        listenerClosed = false;
        throw error;
      }
    });
    const workflowTransportSecret = randomBytes(32).toString("base64url");
    devServer.setClientAddressSecret(workflowTransportSecret);
    restoreWorkflowTransportEnvironment = installWorkflowTransportEnvironment(
      project.appRoot,
      workflowTransportSecret,
    );
    const workflowWorld = createDevelopmentWorkflowWorld({
      appRoot: project.appRoot,
      preparedHost,
      resume: options.resume,
      transportSecret: workflowTransportSecret,
    });
    if (workflowWorld !== undefined) {
      cleanup.defer(async () => await workflowWorld.close());
    }
    const onRuntimePruned =
      workflowWorld === undefined ? undefined : () => workflowWorld.reconcileExpiredRuns();
    // Parent-owned control routes must answer before the World starts: queue
    // redelivery begins at start(), and a delivery's World calls would
    // otherwise fall through to the worker and 404.
    addDevelopmentControlHandler({
      appRoot: project.appRoot,
      devServer: devServer,
      getWatcher: () => authoredSourceWatcher,
      workflowWorld,
      transportSecret: workflowTransportSecret,
    });
    const hostname = options.host ?? DEFAULT_DEVELOPMENT_SERVER_HOST;
    const retryOnAddressInUse = requestedPort === undefined;
    const server = await devBootPhase(
      "binding port",
      () =>
        listenForDevelopmentServer({
          devServer: devServer,
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
    // Published before the first worker is created, so every runtime generation
    // inherits it: workers copy `process.env` at construction.
    restoreLocalDevCapabilityEnvironment = installLocalDevCapabilityEnvironment({
      appRoot: project.appRoot,
      serverUrl,
    });
    await devBootPhase(
      "building dev bundle",
      async () => {
        const payload = await build.buildHost(preparedHost);
        build.close();
        const workspace = preparedHost.workspace;
        initialWorkspaceTransferred = true;
        await devServer.replaceWorker({
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
    devServer.prepareSpareWorker();
    await workflowWorld?.start();

    const rebuildCoordinator = await createDevelopmentAuthoredRebuildCoordinator({
      builds,
      developmentExtensions,
      devServer: devServer,
      initialHost: preparedHost,
      onRuntimePruned,
    });

    const watcher = await devBootPhase(
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
    authoredSourceWatcher = watcher;
    cleanup.defer(async () => {
      // Before the watcher, which waits for an in-flight rebuild: that rebuild's
      // build process exits, so the rebuild fails instead of finishing first.
      builds.close();
      await watcher.close();
    });
    await state.write(serverUrl);
    const owned = cleanup.move();
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const cleanupError = createDevelopmentServerCleanupError(
          await disposeCollectingErrors(owned),
        );
        if (cleanupError !== undefined) {
          throw cleanupError;
        }
      })();
      return closePromise;
    };
    return {
      handle: { kind: "started", appRoot: project.appRoot, url: serverUrl },
      close,
    };
  } catch (error) {
    const cleanupErrors = await disposeCollectingErrors(cleanup);
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
