import type { SandboxSession } from "#public/definitions/sandbox.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendTags,
} from "#public/definitions/sandbox-backend.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { waitForDevelopmentSandboxPrewarm } from "#execution/sandbox/development-prewarm.js";
import { markDevelopmentSandboxBackendInitialized } from "#execution/sandbox/development-run.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { waitForSandboxTemplatePrewarmLock } from "#execution/sandbox/template-prewarm-lock.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { createRuntimeSandboxKeys } from "#runtime/sandbox/keys.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import type { SandboxAccess, SandboxSessionState, SandboxState } from "#sandbox/state.js";

/**
 * Input for creating or reattaching the live sandbox for one step execution.
 */
export interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly runOnSession?: (callback: () => Promise<void>) => Promise<void>;
  readonly state: SandboxState | null;
  readonly tags?: SandboxBackendTags;
}

/**
 * Creates or reattaches the live sandbox from the compiled agent bundle's
 * registry and persisted session state, returning a {@link SandboxAccess}
 * suitable for the runtime context.
 *
 * Every agent has exactly one sandbox. The sandbox carries its own
 * `SandboxBackend` value (resolved from the authored module or
 * substituted with `defaultSandbox()` when omitted), and the runtime
 * simply calls `backend.create(...)`.
 */
export async function ensureSandboxAccess(input: EnsureSandboxAccessInput): Promise<SandboxAccess> {
  let initialized = input.state?.initialized ?? false;
  let persistedSession: SandboxSessionState | null = input.state?.session ?? null;
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();

  const registered = input.registry.sandbox;
  let handlePromise: Promise<SandboxBackendHandle | null> | undefined;

  function getHandle(): Promise<SandboxBackendHandle | null> {
    if (handlePromise !== undefined) {
      return handlePromise;
    }
    handlePromise = createHandle().catch((error) => {
      handlePromise = undefined;
      throw error;
    });
    return handlePromise;
  }

  async function createHandle(): Promise<SandboxBackendHandle | null> {
    if (registered === null) {
      return null;
    }
    const definition = registered.definition;
    const backend = definition.backend;
    const templatePlan = createRuntimeSandboxTemplatePlan({
      definition,
      workspaceResourceRoot: registered.workspaceResourceRoot,
    });

    const keys = await createRuntimeSandboxKeys({
      backendName: backend.name,
      compiledArtifactsSource: input.compiledArtifactsSource,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      sourceId: definition.sourceId,
      templatePlan,
    });

    if (keys.templateKey !== null) {
      await waitForDevelopmentSandboxPrewarm({
        appRoot,
        compiledArtifactsSource: input.compiledArtifactsSource,
        log: (message) =>
          logDevelopmentSandbox(
            `eve: sandbox template "${formatNodeLabel(input.nodeId)}" (${backend.name}): ${message}`,
          ),
      });
      await waitForSandboxTemplatePrewarmLock({
        appRoot,
        backendName: backend.name,
        log: (message) =>
          logDevelopmentSandbox(
            `eve: sandbox template "${formatNodeLabel(input.nodeId)}" (${backend.name}): ${message}`,
          ),
        templateKey: keys.templateKey,
      });
    }

    const createInput: SandboxBackendCreateInput = {
      existingMetadata:
        persistedSession?.backendName === backend.name &&
        persistedSession.sessionKey === keys.sessionKey
          ? persistedSession.metadata
          : undefined,
      runtimeContext: { appRoot },
      sessionKey: keys.sessionKey,
      tags: input.tags,
      templateKey: keys.templateKey,
    };

    const handle = await withDevelopmentSandboxProgress(
      `eve: opening sandbox session "${formatNodeLabel(input.nodeId)}" on backend "${backend.name}"...`,
      `eve: opening sandbox session "${formatNodeLabel(input.nodeId)}" on backend "${backend.name}"`,
      async () =>
        await createBackendHandleWithPrewarmRetry({
          appRoot,
          backend,
          compiledArtifactsSource: input.compiledArtifactsSource,
          createInput,
        }),
    );
    markDevelopmentSandboxBackendInitialized(backend.name);

    if (!initialized) {
      await runOnSession(async () => {
        await definition.onSession?.({ ctx: buildCallbackContext(), use: handle.useSessionFn });
      });
      initialized = true;
    }

    return handle;
  }

  async function runOnSession(callback: () => Promise<void>): Promise<void> {
    if (input.runOnSession !== undefined) {
      await input.runOnSession(callback);
      return;
    }
    await callback();
  }

  return {
    async captureState() {
      if (handlePromise !== undefined) {
        const handle = await handlePromise;
        if (handle !== null) {
          persistedSession = await handle.captureState();
        }
      }

      return {
        initialized,
        session: persistedSession,
      };
    },
    async dispose() {
      if (handlePromise !== undefined) {
        const handle = await handlePromise;
        await handle?.dispose();
      }
    },
    async get(): Promise<SandboxSession | null> {
      const handle = await getHandle();
      return handle?.session ?? null;
    },
  };
}

async function createBackendHandleWithPrewarmRetry(input: {
  readonly appRoot: string;
  readonly backend: SandboxBackend;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly createInput: SandboxBackendCreateInput;
}): Promise<SandboxBackendHandle> {
  try {
    return await input.backend.create(input.createInput);
  } catch (error) {
    if (
      input.createInput.templateKey === null ||
      input.compiledArtifactsSource.kind !== "disk" ||
      !SandboxTemplateNotProvisionedError.is(error)
    ) {
      throw error;
    }

    await prewarmAppSandboxes({
      appRoot: input.appRoot,
      compiledArtifactsSource: input.compiledArtifactsSource,
      log: (message) => logDevelopmentSandbox(message),
    });
    await waitForSandboxTemplatePrewarmLock({
      appRoot: input.appRoot,
      backendName: input.backend.name,
      log: (message) => logDevelopmentSandbox(`eve: ${message}`),
      templateKey: input.createInput.templateKey,
    });
    logDevelopmentSandbox("eve: sandbox template is ready; retrying sandbox creation...");
    return await input.backend.create(input.createInput);
  }
}

function logDevelopmentSandbox(message: string): void {
  if (isEveDevEnvironment()) {
    console.log(message);
  }
}

async function withDevelopmentSandboxProgress<T>(
  startMessage: string,
  progressMessage: string,
  callback: () => Promise<T>,
): Promise<T> {
  logDevelopmentSandbox(startMessage);
  if (!isEveDevEnvironment()) {
    return await callback();
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logDevelopmentSandbox(`${progressMessage} (${elapsedSeconds}s elapsed)...`);
  }, 5_000);
  timer.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(timer);
  }
}

function formatNodeLabel(nodeId: string): string {
  return nodeId === "__root__" ? "root" : nodeId;
}
