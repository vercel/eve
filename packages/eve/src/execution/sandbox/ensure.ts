import { ensureDevelopmentSandboxesPrepared } from "#execution/sandbox/development-lazy-prewarm.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { contextStorage } from "#context/container.js";
import {
  buildCallbackContext,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import {
  trackActiveSandboxHandle,
  untrackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type {
  SandboxAccess,
  SandboxSessionEndReason,
  SandboxSessionState,
  SandboxState,
} from "#sandbox/state.js";
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
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  /** `false` when the sandbox outlives this access: it may neither delete nor end it. */
  readonly ownsSandbox?: boolean;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state: SandboxState | null;
  /**
   * `true` for a caller that borrows a session's sandbox outside its turns,
   * such as a workflow step. Its handle stays out of the shutdown registry,
   * which tracks one handle per session, so it never replaces or drops the
   * session's own.
   */
  readonly borrowed?: boolean;
}

/** The access `ensureSandboxAccess` builds, with what the opener may do beyond the sandbox API. */
export interface EnsuredSandboxAccess extends SandboxAccess {
  /**
   * Permanently releases what the provider keeps under this access's key
   * when the owning session ends, even when its last checkpoint recorded no
   * sandbox. Waits for this access's open still in flight first.
   */
  end(reason: SandboxSessionEndReason): Promise<void>;
  /**
   * Lets go of the handle this access opened, if any, without stopping or
   * deleting the sandbox, and returns it so the caller can free what it
   * holds in this process. For a sandbox that outlives the access, such as a
   * tool session's. Waits for an open still in flight, so a caller that
   * finished early never leaves that handle behind.
   */
  detach(): Promise<SandboxProviderHandle | undefined>;
}

interface OpenedSandbox {
  readonly handle: SandboxProviderHandle;
  readonly providerName: string;
  readonly sandbox: RuntimeSandboxSession;
}

// Parent and subagent sessions that share a sandbox each build their own
// access. `start` is an upsert, so concurrent first use is safe, but in one
// process late arrivals resume from the winner's state instead of running
// the selector again.
const pendingSandboxStarts = new Map<string, Promise<SandboxSessionState | null>>();

const log = createLogger("execution.sandbox");

export async function ensureSandboxAccess(
  input: EnsureSandboxAccessInput,
): Promise<EnsuredSandboxAccess> {
  // Sessions saved before the provider redesign (eve 0.64) hold a backend
  // record with no `providerName`. No provider can resume it, so treat it as
  // no sandbox and let the selector start a fresh one.
  let persisted: SandboxSessionState | null =
    input.state?.session?.providerName === undefined ? null : input.state.session;
  let opened: OpenedSandbox | undefined;
  let opening: Promise<SandboxProviderHandle> | undefined;
  let requiring: Promise<SandboxProviderHandle> | undefined;
  const track: typeof trackActiveSandboxHandle = (entry) => {
    if (input.borrowed !== true) trackActiveSandboxHandle(entry);
  };
  const untrack: typeof untrackActiveSandboxHandle = (entry) => {
    if (input.borrowed !== true) untrackActiveSandboxHandle(entry);
  };
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const captured = (): SandboxState => ({ session: persisted });
  const registered = input.registry.sandbox;
  if (registered === null) {
    return {
      async captureState() {
        return captured();
      },
      async detach() {
        return undefined;
      },
      async end() {},
      async get() {
        return null;
      },
      async stop() {},
    };
  }

  function providerContext(turnId: string): SandboxProviderSessionContext {
    const activeSession =
      contextStorage.getStore() === undefined
        ? {
            auth: { current: null, initiator: null },
            id: input.sessionId,
            turn: { id: turnId, sequence: 0 },
          }
        : buildCallbackContext().session;
    return {
      host: createSandboxProviderHost(appRoot),
      session: { ...activeSession, id: input.sessionId },
      storagePath: resolveSandboxCacheDirectory(appRoot),
    };
  }

  function activeDefinition() {
    const definition = registered.inheritance?.definition ?? registered.definition;
    if (definition.kind !== "independent")
      throw new Error(`Sandbox "${definition.logicalPath}" has no environment.`);
    return definition;
  }

  async function loadArtifact(provider: SandboxProviderRuntime) {
    const artifactNodeId = registered.inheritance?.nodeId ?? input.nodeId;
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
    return artifact;
  }

  async function open(
    provider: SandboxProviderRuntime,
    options: object | undefined,
    environment: object,
    context: SandboxProviderSessionContext,
  ): Promise<RuntimeSandboxSession> {
    if (opening !== undefined) throw new Error("A sandbox definition can open only one sandbox.");
    const definition = activeDefinition();
    if (environment !== definition.environment)
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different environment.`);
    if (provider !== getSandboxEnvironmentRuntime(definition.environment))
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different provider.`);
    if (persisted !== null) {
      throw new Error(`Sandbox "${definition.logicalPath}" is already initialized.`);
    }

    const artifact = await loadArtifact(provider);
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
      (deleteOptions?: SandboxDeleteOptions) => handle.onSandboxDelete(deleteOptions),
      () => handle.onSandboxStop(),
    );
    opened = { handle, providerName, sandbox };
    return sandbox;
  }

  async function resumePersisted(context: SandboxProviderSessionContext) {
    if (persisted === null) throw new Error("Sandbox session state is missing.");
    const provider = getSandboxEnvironmentRuntime(activeDefinition().environment);
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
    const artifact = await loadArtifact(provider);
    opening = provider.implementation
      .resume(context, artifact, persisted.state)
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    const handle = await opening;
    installHandle(provider.providerName, handle);
    track({
      handle,
      providerName: provider.providerName,
      sessionId: input.sessionId,
    });
    return handle;
  }

  async function resolveHandle(): Promise<SandboxProviderHandle> {
    const definition = activeDefinition();
    if (isEveDevEnvironment() && input.compiledArtifactsSource.kind === "disk") {
      await ensureDevelopmentSandboxesPrepared({
        compiledArtifactsSource: input.compiledArtifactsSource,
        nodeId: registered.inheritance?.nodeId ?? input.nodeId,
        providerName: getSandboxEnvironmentRuntime(definition.environment).providerName,
      });
    }

    const context = providerContext("sandbox-initialization");
    if (persisted !== null) {
      try {
        return await resumePersisted(context);
      } catch (error) {
        if (!(error instanceof SandboxSessionGoneError)) throw error;
        log.warn("session sandbox is gone, starting a fresh one", {
          error,
          providerName: persisted.providerName,
          sessionId: input.sessionId,
        });
        persisted = null;
      }
    }

    // Apps hosted in one process can reuse a node id and a tool session id.
    const startKey = [
      appRoot,
      registered.inheritance?.nodeId ?? input.nodeId,
      input.sessionId,
    ].join("\0");
    // A failed start wakes every waiter at once; re-check so only one retries.
    let concurrentStart = pendingSandboxStarts.get(startKey);
    while (concurrentStart !== undefined) {
      persisted = await concurrentStart;
      if (persisted !== null) return await resumePersisted(context);
      concurrentStart = pendingSandboxStarts.get(startKey);
    }

    const starting = startHandle(context);
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

  /**
   * Runs the owning sandbox definition, which for a subagent that shares its
   * parent's sandbox is the parent's: whichever session opens the sandbox
   * first creates it with the same options and initialization.
   */
  async function startHandle(context: SandboxProviderSessionContext) {
    const definition = activeDefinition();
    try {
      const selected = await runWithSandboxConstructorRuntime(
        {
          open: ({ environment, options, provider }) =>
            open(provider, options, environment, context),
        },
        async () => definition.selector({ session: context.session }),
      );
      if (opened === undefined || selected !== opened.sandbox) {
        throw new Error(`Sandbox "${definition.logicalPath}" must return the sandbox it opens.`);
      }
    } catch (error) {
      // The sandbox stays: another session or call may share it, and the
      // next access runs the selector again on it. Session end removes it.
      opened = undefined;
      opening = undefined;
      persisted = null;
      throw error;
    }
    track({
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

  function forgetHandle() {
    const current = opened;
    if (current !== undefined) {
      untrack({
        handle: current.handle,
        providerName: current.providerName,
        sessionId: input.sessionId,
      });
    }
    opened = undefined;
    opening = undefined;
    requiring = undefined;
    return current;
  }

  const definition = registered.inheritance?.definition ?? registered.definition;

  return {
    environment: definition.kind === "independent" ? definition.environment : undefined,
    async captureState() {
      if (opening !== undefined) await opening;
      return captured();
    },
    async delete(deleteOptions) {
      if (input.ownsSandbox === false)
        throw new Error("Only the owning session can delete this sandbox.");
      const current = await requireHandle();
      await current.onSandboxDelete(deleteOptions);
      forgetHandle();
      persisted = null;
    },
    async detach() {
      // A failed open left nothing to let go of.
      if (requiring !== undefined) await requiring.catch(() => undefined);
      return forgetHandle()?.handle;
    },
    async end(reason: SandboxSessionEndReason) {
      if (input.ownsSandbox === false) return;
      if (requiring !== undefined) await requiring.catch(() => undefined);
      // A failed step or process loss can create a sandbox without committing
      // any state. The previous checkpoint cannot prove that the key is unused.
      const provider = getSandboxEnvironmentRuntime(activeDefinition().environment);
      // State another provider or protocol recorded is no use here; the key still finds
      // what this provider keeps.
      const state =
        persisted?.providerName === provider.providerName &&
        persisted.stateProtocolVersion === provider.stateProtocolVersion
          ? persisted.state
          : null;
      await provider.implementation.onSessionEnd(providerContext("sandbox-cleanup"), state, {
        reason,
      });
      forgetHandle();
      persisted = null;
    },
    async get() {
      await requireHandle();
      return opened?.sandbox ?? null;
    },
    async stop() {
      const current = await requireHandle();
      await current.onSandboxStop();
      opened = undefined;
      opening = undefined;
      requiring = undefined;
    },
  };
}
