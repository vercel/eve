import { ensureDevelopmentSandboxesPrepared } from "#execution/sandbox/development-lazy-prewarm.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { contextStorage } from "#context/container.js";
import {
  buildCallbackContext,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import { trackActiveSandboxHandle } from "#execution/sandbox/active-handles.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxAccess, SandboxSessionState, SandboxState } from "#sandbox/state.js";
import {
  getSandboxEnvironmentRuntime,
  runWithSandboxConstructorRuntime,
} from "#shared/sandbox-environment.js";
import {
  isSandboxPreparedArtifact,
  type SandboxDeleteOptions,
  type SandboxProviderHandle,
  type SandboxProviderRuntime,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly ownsSandbox?: boolean;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state: SandboxState | null;
}

interface OpenedSandbox {
  readonly handle: SandboxProviderHandle;
  readonly providerName: string;
  readonly sandbox: RuntimeSandboxSession;
}

// Parent and subagent sessions that share a sandbox each build their own
// access, so concurrent first use in one process would otherwise race to
// start the same provider sandbox. Late arrivals resume from the winner's
// state instead.
const pendingSandboxStarts = new Map<string, Promise<SandboxSessionState | null>>();

export async function ensureSandboxAccess(input: EnsureSandboxAccessInput): Promise<SandboxAccess> {
  let persisted: SandboxSessionState | null = input.state?.session ?? null;
  let opened: OpenedSandbox | undefined;
  let opening: Promise<SandboxProviderHandle> | undefined;
  let requiring: Promise<SandboxProviderHandle> | undefined;
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const registered = input.registry.sandbox;
  if (registered === null) {
    return {
      async captureState() {
        return { session: persisted };
      },
      async get() {
        return null;
      },
      async stop() {},
    };
  }

  async function open(
    provider: SandboxProviderRuntime,
    options: object | undefined,
    environment: object,
    session: SandboxProviderSessionContext["session"],
  ): Promise<RuntimeSandboxSession> {
    if (opening !== undefined) throw new Error("A sandbox definition can open only one sandbox.");
    const inherited = registered.inheritance;
    const definition = inherited?.definition ?? registered.definition;
    if (definition.kind !== "independent")
      throw new Error(`Sandbox "${definition.logicalPath}" has no environment.`);
    if (environment !== definition.environment)
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different environment.`);
    if (provider !== getSandboxEnvironmentRuntime(definition.environment))
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different provider.`);
    if (persisted !== null) {
      throw new Error(`Sandbox "${definition.logicalPath}" is already initialized.`);
    }

    const artifactNodeId = inherited?.nodeId ?? input.nodeId;
    const artifact = await loadSandboxPreparedArtifact({
      compiledArtifactsSource: input.compiledArtifactsSource,
      nodeId: artifactNodeId,
      providerName: provider.providerName,
    });
    if (artifact === undefined) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: provider.providerName,
        templateKey: artifactNodeId,
      });
    }

    const context: SandboxProviderSessionContext = {
      host: createSandboxProviderHost(appRoot),
      session,
      storagePath: resolveSandboxCacheDirectory(appRoot),
    };
    const createHandle = async () => {
      const result = await provider.implementation.start(context, options, artifact);
      if (!isSandboxPreparedArtifact(result.state)) {
        throw new Error(
          `Sandbox provider "${provider.providerName}" returned non-serializable session state.`,
        );
      }
      persisted = {
        providerName: provider.providerName,
        state: result.state,
        stateProtocolVersion: provider.stateProtocolVersion,
      };
      return result.handle;
    };
    opening = createHandle().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });

    const handle = await opening;
    return installHandle(provider.providerName, handle);
  }

  function installHandle(
    providerName: string,
    handle: SandboxProviderHandle,
  ): RuntimeSandboxSession {
    const sandbox = withRuntimeSandboxLifecycle(
      handle.sandbox,
      (deleteOptions?: SandboxDeleteOptions) => handle.onSessionDelete(deleteOptions),
      () => handle.onSessionStop(),
    );
    opened = { handle, providerName, sandbox };
    return sandbox;
  }

  async function resumePersisted(
    definition: Extract<typeof registered.definition, { readonly kind: "independent" }>,
    session: SandboxProviderSessionContext["session"],
  ): Promise<SandboxProviderHandle> {
    if (persisted === null) throw new Error("Sandbox session state is missing.");
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    if (persisted.providerName !== provider.providerName) {
      throw new Error(
        `Sandbox session state belongs to provider "${persisted.providerName}", not "${provider.providerName}".`,
      );
    }
    if (persisted.stateProtocolVersion !== provider.stateProtocolVersion) {
      throw new Error(
        `Sandbox session state protocol ${persisted.stateProtocolVersion} is incompatible with provider "${provider.providerName}" protocol ${provider.stateProtocolVersion}.`,
      );
    }
    const inherited = registered.inheritance;
    const artifactNodeId = inherited?.nodeId ?? input.nodeId;
    const artifact = await loadSandboxPreparedArtifact({
      compiledArtifactsSource: input.compiledArtifactsSource,
      nodeId: artifactNodeId,
      providerName: provider.providerName,
    });
    if (artifact === undefined) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: provider.providerName,
        templateKey: artifactNodeId,
      });
    }
    const context: SandboxProviderSessionContext = {
      host: createSandboxProviderHost(appRoot),
      session,
      storagePath: resolveSandboxCacheDirectory(appRoot),
    };
    opening = provider.implementation
      .resume(context, artifact, persisted.state)
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    const handle = await opening;
    installHandle(provider.providerName, handle);
    trackActiveSandboxHandle({
      handle,
      providerName: provider.providerName,
      sessionId: input.sessionId,
    });
    return handle;
  }

  async function resolveHandle(): Promise<SandboxProviderHandle> {
    const inherited = registered.inheritance;
    const definition = inherited?.definition ?? registered.definition;
    if (definition.kind !== "independent")
      throw new Error(`Sandbox "${definition.logicalPath}" has no resolved parent.`);

    if (isEveDevEnvironment() && input.compiledArtifactsSource.kind === "disk") {
      await ensureDevelopmentSandboxesPrepared({
        compiledArtifactsSource: input.compiledArtifactsSource,
        nodeId: inherited?.nodeId ?? input.nodeId,
        providerName: getSandboxEnvironmentRuntime(definition.environment).providerName,
      });
    }

    const activeSession =
      contextStorage.getStore() === undefined
        ? {
            auth: { current: null, initiator: null },
            id: input.sessionId,
            turn: { id: "sandbox-initialization", sequence: 0 },
          }
        : buildCallbackContext().session;
    const session = { ...activeSession, id: input.sessionId };

    if (persisted !== null) {
      return await resumePersisted(definition, session);
    }

    const startKey = `${inherited?.nodeId ?? input.nodeId}\0${input.sessionId}`;
    const concurrentStart = pendingSandboxStarts.get(startKey);
    if (concurrentStart !== undefined) {
      persisted = await concurrentStart;
      if (persisted !== null) return await resumePersisted(definition, session);
    }

    const starting = startHandle(definition, session);
    const sharedStart = starting.then(
      () => persisted,
      () => null,
    );
    pendingSandboxStarts.set(startKey, sharedStart);
    try {
      return await starting;
    } finally {
      if (pendingSandboxStarts.get(startKey) === sharedStart) {
        pendingSandboxStarts.delete(startKey);
      }
    }
  }

  async function startHandle(
    definition: Extract<typeof registered.definition, { readonly kind: "independent" }>,
    session: SandboxProviderSessionContext["session"],
  ): Promise<SandboxProviderHandle> {
    const inherited = registered.inheritance;
    if (inherited !== undefined) {
      await open(
        getSandboxEnvironmentRuntime(definition.environment),
        undefined,
        definition.environment,
        session,
      );
    } else {
      try {
        const selected = await runWithSandboxConstructorRuntime(
          {
            open: ({ environment, options, provider }) =>
              open(provider, options, environment, session),
          },
          async () => definition.selector({ session }),
        );
        if (opened === undefined || selected !== opened.sandbox) {
          throw new Error(`Sandbox "${definition.logicalPath}" must return the sandbox it opens.`);
        }
      } catch (error) {
        const failed = opened?.handle;
        opened = undefined;
        opening = undefined;
        persisted = null;
        if (failed !== undefined) {
          try {
            await failed.onSessionDelete();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Sandbox "${definition.logicalPath}" initialization and cleanup both failed.`,
              { cause: error },
            );
          }
        }
        throw error;
      }
    }

    if (opened === undefined)
      throw new Error(`Sandbox "${definition.logicalPath}" did not open a provider handle.`);
    trackActiveSandboxHandle({
      handle: opened.handle,
      providerName: opened.providerName,
      sessionId: input.sessionId,
    });
    return opened.handle;
  }

  function requireHandle(): Promise<SandboxProviderHandle> {
    if (requiring !== undefined) return requiring;
    requiring = resolveHandle().catch((error: unknown) => {
      requiring = undefined;
      throw error;
    });
    return requiring;
  }

  const activeDefinition = registered.inheritance?.definition ?? registered.definition;

  return {
    environment: activeDefinition.kind === "independent" ? activeDefinition.environment : undefined,
    async captureState() {
      if (opening !== undefined) await opening;
      return { session: persisted };
    },
    async delete(deleteOptions) {
      if (input.ownsSandbox === false)
        throw new Error("Only the owning session can delete this sandbox.");
      const current = await requireHandle();
      await current.onSessionDelete(deleteOptions);
      opened = undefined;
      opening = undefined;
      persisted = null;
      requiring = undefined;
    },
    async get() {
      await requireHandle();
      return opened?.sandbox ?? null;
    },
    async stop() {
      const current = await requireHandle();
      await current.onSessionStop();
      opened = undefined;
      opening = undefined;
      requiring = undefined;
    },
  };
}
