import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ensureDevelopmentSandboxesPrepared } from "#execution/sandbox/development-lazy-prewarm.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import { contextStorage } from "#context/container.js";
import {
  buildCallbackContext,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import {
  trackActiveSandboxConnection,
  untrackActiveSandboxConnection,
} from "#execution/sandbox/active-connections.js";
import { createConnectionSession } from "#execution/sandbox/session.js";
import { isToolSessionId } from "#execution/tool-session/id.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import { owningSandboxDefinition, type RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type {
  SandboxConnection,
  SandboxJson,
  SandboxProviderRuntime,
  SandboxSessionContext,
} from "#sandbox/provider.js";
import {
  getSessionEndWithArtifact,
  resolvePersistedSandboxSessionState,
  type SandboxAccess,
  type SandboxSessionEndReason,
  type SandboxSessionState,
  type SandboxState,
} from "#sandbox/state.js";
import {
  getSandboxEnvironmentRuntime,
  runWithSandboxConstructorRuntime,
} from "#shared/sandbox-environment.js";
import { isSandboxPreparedArtifact, type SandboxDeleteOptions } from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession, SandboxSession } from "#shared/sandbox-session.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { ToolSessionSandboxUnsupportedError } from "#shared/sandbox-tool-session-error.js";

interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  /** `false` when the sandbox outlives this access: it may neither delete nor end it. */
  readonly ownsSandbox?: boolean;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state: SandboxState | null;
  /**
   * How long the server-shutdown registry, which holds one connection per
   * session, keeps this access's connection. `"session"`, the default for a
   * session's own steps, keeps a connection without `close()` after release,
   * so shutdown still stops the session's sandbox. `"call"` drops it at
   * release, for a keyed tool call, whose sandbox no session ends. `"none"`
   * never registers it, for a workflow step that borrows a session's sandbox
   * outside its turns and must not replace or drop the session's own.
   */
  readonly shutdownTracking?: "call" | "none" | "session";
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
   * Lets go of the connection this access opened, if any, when the step that
   * opened it ends: closes it without stopping or deleting the sandbox.
   * Waits for an open still in flight, so a caller that finished early never
   * leaves that connection behind.
   */
  release(): Promise<void>;
}

/** A connection this access opened, with the lifecycle eve maps onto it. */
interface OpenedSandbox {
  readonly closable: boolean;
  readonly providerName: string;
  readonly sandbox: RuntimeSandboxSession;
  close(): Promise<void>;
  delete(options?: SandboxDeleteOptions): Promise<void>;
  /** Releases compute, then closes the connection. */
  stop(): Promise<void>;
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
  // Production always registers a sandbox; test runtimes without one cast a null registry.
  const registered = input.registry.sandbox;
  const persistedOwner = registered === null ? undefined : owningSandboxDefinition(registered);
  // A retired record cannot resume, so let the selector start a fresh sandbox.
  let persisted = resolvePersistedSandboxSessionState(
    input.state?.session,
    persistedOwner?.kind === "independent"
      ? getSandboxEnvironmentRuntime(persistedOwner.environment)
      : undefined,
  );
  let opened: OpenedSandbox | undefined;
  // A stopped connection without `close()` resumes on its next use, so shutdown keeps it until the session lets go.
  let stopped: OpenedSandbox | undefined;
  let opening: Promise<OpenedSandbox> | undefined;
  let requiring: Promise<OpenedSandbox> | undefined;
  const tracking = input.shutdownTracking ?? "session";
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const captured = (): SandboxState => ({ session: persisted });
  if (registered === null) {
    return {
      async captureState() {
        return captured();
      },
      async end() {},
      async get() {
        return null;
      },
      async release() {},
      async stop() {},
    };
  }
  const ownerDefinition = owningSandboxDefinition(registered);
  const ownerNodeId = registered.inheritance?.nodeId ?? input.nodeId;

  function providerContext(turnId: string): SandboxSessionContext {
    const activeSession =
      contextStorage.getStore() === undefined
        ? {
            auth: { current: null, initiator: null },
            id: input.sessionId,
            turn: { id: turnId, sequence: 0 },
          }
        : buildCallbackContext().session;
    return {
      kind: isToolSessionId(input.sessionId) ? "tool-session" : "session",
      resolveProjectPath: (path) => resolve(appRoot, path),
      session: { ...activeSession, id: input.sessionId },
      storagePath: resolveSandboxCacheDirectory(appRoot),
    };
  }

  function activeDefinition() {
    if (ownerDefinition.kind !== "independent")
      throw new Error(
        `Sandbox "${ownerDefinition.logicalPath}" uses defineParentSandbox(), but this agent has no parent sandbox to share. ` +
          "Only a declared subagent can share its parent's sandbox. Give this agent its own sandbox with defineSandbox() and an exported environment.",
      );
    return ownerDefinition;
  }

  async function loadArtifact(provider: SandboxProviderRuntime) {
    const artifact = await loadSandboxPreparedArtifact({
      compiledArtifactsSource: input.compiledArtifactsSource,
      nodeId: ownerNodeId,
      providerName: provider.providerName,
    });
    if (artifact === undefined) {
      throw new SandboxTemplateNotProvisionedError({
        nodeId: ownerNodeId,
        providerName: provider.providerName,
      });
    }
    return artifact;
  }

  async function open(
    provider: SandboxProviderRuntime,
    options: object | undefined,
    environment: object,
    context: SandboxSessionContext,
  ): Promise<RuntimeSandboxSession> {
    if (opening !== undefined)
      throw new Error(
        "A sandbox definition can open only one sandbox. Call `environment.open()` once in the defineSandbox() selector and return that sandbox.",
      );
    const definition = activeDefinition();
    if (environment !== definition.environment)
      throw new Error(
        `Sandbox "${definition.logicalPath}" opened an environment other than the one it exports as \`environment\`. ` +
          "Call `open()` on the exported environment. A selector cannot open an environment created inside the selector or exported by another sandbox file.",
      );
    if (provider !== getSandboxEnvironmentRuntime(definition.environment))
      throw new Error(`Sandbox "${definition.logicalPath}" selected a different provider.`);
    if (persisted !== null) {
      throw new Error(
        `Sandbox "${definition.logicalPath}" already opened this session's sandbox. ` +
          "Call `environment.open()` once in the defineSandbox() selector and return that sandbox.",
      );
    }

    const artifact = await loadArtifact(provider);
    const start = async () => {
      const result = await provider.implementation.start(context, options, artifact);
      if (!isSandboxPreparedArtifact(result.state)) {
        throw new Error(
          `Sandbox provider "${provider.providerName}" returned non-serializable session state.`,
        );
      }
      const started = await openSandbox(provider, context, result.connection, result.state);
      persisted = {
        generation: randomUUID(),
        providerName: provider.providerName,
        state: result.state,
        stateProtocolVersion: provider.stateProtocolVersion,
      };
      return started;
    };
    opening = start().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    opened = await opening;
    return opened.sandbox;
  }

  async function resumePersisted(context: SandboxSessionContext) {
    if (persisted === null) throw new Error("Sandbox session state is missing.");
    const provider = getSandboxEnvironmentRuntime(activeDefinition().environment);
    // State another provider or protocol recorded cannot resume here, for example
    // after the app switches providers or rolls back eve, so start a fresh sandbox.
    if (persisted.providerName !== provider.providerName) {
      throw new SandboxSessionGoneError(
        `This session's sandbox was created by provider "${persisted.providerName}", but the agent now selects provider "${provider.providerName}". ` +
          "eve cannot move a sandbox between providers, so the session continues in a fresh sandbox without the old sandbox's files.",
      );
    }
    if (persisted.stateProtocolVersion !== provider.stateProtocolVersion) {
      throw new SandboxSessionGoneError(
        `Sandbox session state protocol ${persisted.stateProtocolVersion} is incompatible with provider "${provider.providerName}" protocol ${provider.stateProtocolVersion}.`,
      );
    }
    const artifact = await loadArtifact(provider);
    const state = persisted.state;
    opening = provider.implementation
      .resume(context, artifact, state)
      .then((connection) => openSandbox(provider, context, connection, state))
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    opened = await opening;
    track(opened);
    return opened;
  }

  async function resolveOpened(): Promise<OpenedSandbox> {
    const definition = activeDefinition();
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    const context = providerContext("sandbox-initialization");
    if (context.kind === "tool-session" && provider.implementation.toolSessions !== true) {
      throw new ToolSessionSandboxUnsupportedError(provider.providerName);
    }
    if (isEveDevEnvironment() && input.compiledArtifactsSource.kind === "disk") {
      await ensureDevelopmentSandboxesPrepared({
        compiledArtifactsSource: input.compiledArtifactsSource,
        nodeId: ownerNodeId,
        providerName: provider.providerName,
      });
    }

    if (persisted !== null) {
      try {
        return await resumePersisted(context);
      } catch (error) {
        if (!SandboxSessionGoneError.is(error)) throw error;
        log.warn("session sandbox is gone, starting a fresh one", {
          error,
          providerName: persisted.providerName,
          sessionId: input.sessionId,
        });
        persisted = null;
      }
    }

    // Apps hosted in one process can reuse a node id and a tool session id.
    const startKey = [appRoot, ownerNodeId, input.sessionId].join("\0");
    // A failed start wakes every waiter at once; re-check so only one retries.
    let concurrentStart = pendingSandboxStarts.get(startKey);
    while (concurrentStart !== undefined) {
      persisted = await concurrentStart;
      if (persisted !== null) return await resumePersisted(context);
      concurrentStart = pendingSandboxStarts.get(startKey);
    }

    const starting = startOpened(context);
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
  async function startOpened(context: SandboxSessionContext) {
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
      await opened?.close().catch(() => undefined);
      opened = undefined;
      opening = undefined;
      persisted = null;
      throw error;
    }
    track(opened);
    return opened;
  }

  function requireOpened(): Promise<OpenedSandbox> {
    if (requiring !== undefined) return requiring;
    requiring = resolveOpened().catch((error: unknown) => {
      requiring = undefined;
      throw error;
    });
    return requiring;
  }

  function track(current: OpenedSandbox) {
    if (tracking === "none") return;
    trackActiveSandboxConnection({
      connection: current,
      providerName: current.providerName,
      sessionId: input.sessionId,
    });
  }

  function forgetOpened() {
    const current = opened;
    opened = undefined;
    opening = undefined;
    requiring = undefined;
    return current;
  }

  /** The sandbox is gone, so shutdown has nothing left to stop for the session. */
  function forgetSandbox(providerName: string) {
    forgetOpened();
    stopped = undefined;
    untrackActiveSandboxConnection({ providerName, sessionId: input.sessionId });
    persisted = null;
  }

  return {
    environment: ownerDefinition.kind === "independent" ? ownerDefinition.environment : undefined,
    async captureState() {
      if (opening !== undefined) await opening;
      return captured();
    },
    async delete(deleteOptions) {
      if (input.ownsSandbox === false)
        throw new Error("Only the owning session can delete this sandbox.");
      const current = await requireOpened();
      await current.delete(deleteOptions);
      forgetSandbox(current.providerName);
    },
    async end(reason: SandboxSessionEndReason) {
      if (input.ownsSandbox === false) return;
      if (requiring !== undefined) await requiring.catch(() => undefined);
      // A failed close of a process-local resource must not block deleting the sandbox.
      await opened?.close().catch((error: unknown) => {
        log.warn("failed to close a sandbox connection at session end", {
          error,
          sessionId: input.sessionId,
        });
      });
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
      const context = providerContext("sandbox-cleanup");
      const endWithArtifact = getSessionEndWithArtifact(provider.implementation);
      if (endWithArtifact === undefined) {
        await provider.implementation.onSessionEnd(context, state, { reason });
      } else {
        const artifact = await loadSandboxPreparedArtifact({
          compiledArtifactsSource: input.compiledArtifactsSource,
          nodeId: ownerNodeId,
          providerName: provider.providerName,
        });
        await endWithArtifact(context, state, { artifact, reason });
      }
      forgetSandbox(provider.providerName);
    },
    async get() {
      return (await requireOpened()).sandbox;
    },
    async release() {
      // A failed open left nothing to let go of.
      if (requiring !== undefined) await requiring.catch(() => undefined);
      const current = forgetOpened();
      // A keyed call never ends, so it drops a connection it stopped instead of keeping it for shutdown.
      if (stopped !== undefined && tracking !== "session") {
        untrackActiveSandboxConnection({
          connection: stopped,
          providerName: stopped.providerName,
          sessionId: input.sessionId,
        });
        stopped = undefined;
      }
      // Without `close()` there is nothing to free, and shutdown still stops the session's sandbox.
      if (current === undefined || (tracking === "session" && !current.closable)) return;
      untrackActiveSandboxConnection({
        connection: current,
        providerName: current.providerName,
        sessionId: input.sessionId,
      });
      await current.close();
    },
    async stop() {
      const current = await requireOpened();
      await current.stop();
      forgetOpened();
      if (!current.closable) {
        stopped = current;
        return;
      }
      // A closed connection cannot resume, so shutdown has nothing left to stop.
      untrackActiveSandboxConnection({
        connection: current,
        providerName: current.providerName,
        sessionId: input.sessionId,
      });
    },
  };

  async function openSandbox(
    provider: SandboxProviderRuntime,
    context: SandboxSessionContext,
    connection: SandboxConnection<object>,
    state: SandboxJson,
  ): Promise<OpenedSandbox> {
    let session: SandboxSession;
    try {
      session = createConnectionSession(connection);
    } catch (error) {
      await connection.close?.().catch((closeError: unknown) => {
        log.warn("failed to close a sandbox connection eve could not use", {
          error: closeError,
          sessionId: input.sessionId,
        });
      });
      throw error;
    }
    // A stopped connection can resume on its next use, so a later stop runs
    // again; only a stop already in flight is shared. Close runs once.
    const stopCompute = shared(() => connection.stop());
    const close = once(async () => await connection.close?.());
    const current: OpenedSandbox = {
      closable: connection.close !== undefined,
      close,
      async delete(options) {
        try {
          await close();
        } finally {
          await provider.implementation.onSessionEnd(context, state, {
            abortSignal: options?.abortSignal,
            reason: "deleted",
          });
        }
      },
      providerName: provider.providerName,
      sandbox: withRuntimeSandboxLifecycle(
        session,
        (options) => current.delete(options),
        () => current.stop(),
      ),
      async stop() {
        try {
          await stopCompute();
        } finally {
          await close();
        }
      },
    };
    return current;
  }
}

/** Runs `run` at most once at a time; a later call after it settles runs it again. */
function shared(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= run().finally(() => {
      running = undefined;
    }));
}

/** Runs `run` at most once while it succeeds; a failed run can be retried. */
function once(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= run().catch((error: unknown) => {
      running = undefined;
      throw error;
    }));
}
