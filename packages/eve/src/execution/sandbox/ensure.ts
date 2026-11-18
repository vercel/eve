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
import { hasRunningBashCommand } from "#execution/sandbox/bash.js";
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
  recordedSandboxStopsIdle,
  resolvePersistedSandboxSessionState,
  resolveRecordedSandboxProvider,
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
  readonly ownsSandbox?: boolean;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state: SandboxState | null;
  readonly shutdownTracking?: "call" | "none" | "session";
}

export interface EnsuredSandboxAccess extends SandboxAccess {
  readonly idleTimeoutMs: number | undefined;
  end(reason: SandboxSessionEndReason): Promise<void>;
  release(): Promise<void>;
  settle(): Promise<void>;
  stopIdle(options: { readonly signal: AbortSignal }): Promise<{ readonly inUse: boolean }>;
}

interface OpenedSandbox {
  readonly closable: boolean;
  readonly providerName: string;
  readonly sandbox: RuntimeSandboxSession;
  close(): Promise<void>;
  delete(options?: SandboxDeleteOptions): Promise<void>;
  keepAlive(durationMs: number): Promise<void>;
  stop(): Promise<void>;
}

const pendingSandboxStarts = new Map<string, Promise<SandboxSessionState | null>>();

const log = createLogger("execution.sandbox");

function idleStop(
  registry: RuntimeSandboxRegistry,
  sessionId: string,
):
  | {
      readonly backgroundTimeoutMs: number;
      readonly idleTimeoutMs: number;
      readonly provider: SandboxProviderRuntime;
    }
  | undefined {
  const registered = registry.sandbox;
  if (registered === null || isToolSessionId(sessionId)) return undefined;
  const owner = owningSandboxDefinition(registered);
  if (owner.kind !== "independent") return undefined;
  const provider = getSandboxEnvironmentRuntime(owner.environment);
  const { backgroundTimeoutMs, idleTimeoutMs } = provider;
  if (provider.implementation.onSessionIdle === undefined || idleTimeoutMs === false)
    return undefined;
  return { backgroundTimeoutMs, idleTimeoutMs, provider };
}

export function sandboxIdleTimeoutMs(
  registry: RuntimeSandboxRegistry,
  sessionId: string,
  recorded?: SandboxSessionState | null,
): number | undefined {
  const stop = idleStop(registry, sessionId);
  if (stop === undefined || !recordedSandboxStopsIdle(stop.provider, recorded)) return undefined;
  return stop.idleTimeoutMs;
}

export async function ensureSandboxAccess(
  input: EnsureSandboxAccessInput,
): Promise<EnsuredSandboxAccess> {
  const registered = input.registry.sandbox;
  const persistedOwner = registered === null ? undefined : owningSandboxDefinition(registered);
  let persisted = resolvePersistedSandboxSessionState(
    input.state?.session,
    persistedOwner?.kind === "independent"
      ? getSandboxEnvironmentRuntime(persistedOwner.environment)
      : undefined,
  );
  let opened: OpenedSandbox | undefined;
  let stopped: OpenedSandbox | undefined;
  let opening: Promise<OpenedSandbox> | undefined;
  let requiring: Promise<OpenedSandbox> | undefined;
  const tracking = input.shutdownTracking ?? "session";
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const idle = input.ownsSandbox === false ? undefined : idleStop(input.registry, input.sessionId);
  const idleTimeoutMs = idle?.idleTimeoutMs;
  let running = input.state?.running !== undefined;
  let backgroundUntil = input.state?.running?.backgroundUntil;
  const captured = (): SandboxState =>
    running && idle !== undefined && recordedSandboxStopsIdle(idle.provider, persisted)
      ? {
          session: persisted,
          running: {
            idleTimeoutMs: idle.idleTimeoutMs,
            ...(backgroundUntil !== undefined && { backgroundUntil }),
          },
        }
      : { session: persisted };
  if (registered === null) {
    return {
      async captureState() {
        return captured();
      },
      async end() {},
      idleTimeoutMs,
      async get() {
        return null;
      },
      async open() {
        return null;
      },
      prepare() {},
      async release() {},
      async settle() {},
      async stop() {},
      async stopIdle() {
        return { inUse: false };
      },
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

    const startKey = [appRoot, ownerNodeId, input.sessionId].join("\0");
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
    running = true;
    requiring = resolveOpened().catch((error: unknown) => {
      requiring = undefined;
      throw error;
    });
    return requiring;
  }

  async function openSession(): Promise<RuntimeSandboxSession> {
    return (await requireOpened()).sandbox;
  }

  let preparations: Promise<void> = Promise.resolve();

  function enqueue(job: () => Promise<unknown>): void {
    const report = (error: unknown) => {
      log.warn("background sandbox preparation failed; it runs again when it is needed", {
        error,
        sessionId: input.sessionId,
      });
    };
    preparations = preparations.then(async () => {
      try {
        await job();
      } catch {
        await job().catch(report);
      }
    });
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

  function forgetSandbox(providerName: string) {
    forgetOpened();
    stopped = undefined;
    untrackActiveSandboxConnection({ providerName, sessionId: input.sessionId });
    persisted = null;
    running = false;
    backgroundUntil = undefined;
  }

  async function recordedProvider(provider: SandboxProviderRuntime) {
    const state =
      persisted?.providerName === provider.providerName &&
      persisted.stateProtocolVersion === provider.stateProtocolVersion
        ? persisted.state
        : null;
    return await resolveRecordedSandboxProvider(provider, state, () =>
      loadSandboxPreparedArtifact({
        compiledArtifactsSource: input.compiledArtifactsSource,
        nodeId: ownerNodeId,
        providerName: provider.providerName,
      }),
    );
  }

  return {
    environment: ownerDefinition.kind === "independent" ? ownerDefinition.environment : undefined,
    idleTimeoutMs,
    async captureState() {
      if (opening !== undefined) await opening;
      return captured();
    },
    async delete(deleteOptions) {
      if (input.ownsSandbox === false)
        throw new Error("Only the owning session can delete this sandbox.");
      await preparations;
      const current = await requireOpened();
      await current.delete(deleteOptions);
      forgetSandbox(current.providerName);
    },
    async end(reason: SandboxSessionEndReason) {
      if (input.ownsSandbox === false) return;
      await preparations;
      if (requiring !== undefined) await requiring.catch(() => undefined);
      await opened?.close().catch((error: unknown) => {
        log.warn("failed to close a sandbox connection at session end", {
          error,
          sessionId: input.sessionId,
        });
      });
      const provider = getSandboxEnvironmentRuntime(activeDefinition().environment);
      const recorded = await recordedProvider(provider);
      await recorded?.implementation.onSessionEnd(
        providerContext("sandbox-cleanup"),
        recorded.state,
        {
          reason,
        },
      );
      forgetSandbox(provider.providerName);
    },
    async get() {
      await preparations;
      return await openSession();
    },
    async holdForBackgroundCommand() {
      const current = opened;
      if (idle === undefined || idle.backgroundTimeoutMs === 0 || current === undefined) return;
      backgroundUntil = Math.max(backgroundUntil ?? 0, Date.now() + idle.backgroundTimeoutMs);
      await current.keepAlive(idle.backgroundTimeoutMs).catch((error: unknown) => {
        log.warn(
          "failed to keep the sandbox running for a background command; the provider's own timeout applies",
          { error, sessionId: input.sessionId },
        );
      });
    },
    open: openSession,
    prepare(work) {
      enqueue(work === undefined ? requireOpened : () => work(openSession));
    },
    async settle() {
      await preparations;
    },
    async release() {
      await preparations;
      if (requiring !== undefined) await requiring.catch(() => undefined);
      const current = forgetOpened();
      if (stopped !== undefined && tracking !== "session") {
        untrackActiveSandboxConnection({
          connection: stopped,
          providerName: stopped.providerName,
          sessionId: input.sessionId,
        });
        stopped = undefined;
      }
      if (current === undefined || (tracking === "session" && !current.closable)) return;
      untrackActiveSandboxConnection({
        connection: current,
        providerName: current.providerName,
        sessionId: input.sessionId,
      });
      await current.close();
    },
    async stop() {
      await preparations;
      const current = await requireOpened();
      await current.stop();
      running = false;
      backgroundUntil = undefined;
      forgetOpened();
      if (!current.closable) {
        stopped = current;
        return;
      }
      untrackActiveSandboxConnection({
        connection: current,
        providerName: current.providerName,
        sessionId: input.sessionId,
      });
    },
    async stopIdle({ signal }) {
      if (idle === undefined) return { inUse: false };
      const recorded = await recordedProvider(idle.provider);
      let inUse = false;
      await recorded?.implementation.onSessionIdle?.(
        providerContext("sandbox-idle"),
        recorded.state,
        {
          signal,
          ...(backgroundUntil !== undefined &&
            Date.now() < backgroundUntil && {
              inUse: async (connection) => {
                inUse = await hasRunningBashCommand(createConnectionSession(connection), signal);
                return inUse;
              },
            }),
        },
      );
      return { inUse };
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
            signal: options?.signal,
            reason: "deleted",
          });
        }
      },
      async keepAlive(durationMs) {
        await connection.keepAlive?.({ durationMs });
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

function shared(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= run().finally(() => {
      running = undefined;
    }));
}

function once(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= run().catch((error: unknown) => {
      running = undefined;
      throw error;
    }));
}
