import { posix } from "node:path";

import {
  hydrateSandboxFromImmutableResources,
  prepareImmutableResources,
} from "#execution/sandbox/bindings/immutable-resources.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { isToolSessionId } from "#execution/tool-session/id.js";
import { withToolSessionSandboxes } from "#execution/tool-session/sandbox.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxSelectorContext } from "#shared/sandbox-environment.js";
import {
  defineLegacySandboxProvider,
  providerResourceTargetFiles,
  sandboxProviderResourceIdentity,
  type LegacySandboxProviderImplementation,
  type SandboxPreparedArtifact,
  type SandboxProvider,
  type SandboxProviderFiles,
  type SandboxProviderHandle,
  type SandboxProviderPrepareContext,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import type {
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxWriteFilesOptions,
} from "#shared/sandbox-session.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

/** A JSON-compatible value: what a provider may return as an artifact or session state. */
export type SandboxJson = SandboxPreparedArtifact;

/** Members eve owns on every live sandbox, which a connection's extensions cannot replace. */
type ReservedSessionMember = keyof SandboxSession | "delete" | "stop";

/**
 * The byte-level connection to one sandbox that a provider implements. eve
 * derives the full {@link SandboxSession} from it.
 *
 * Every path a connection receives is absolute, and `workingDirectory` is
 * always set: eve resolves relative paths from `/workspace`.
 */
export interface SandboxConnection<Extensions extends object = {}> {
  /**
   * Runs `command` as a Bash login-shell script (`bash -lc`) in
   * `workingDirectory`, with the sandbox's environment plus `env`. `env`
   * holds only the per-call variables. Aborting kills the process tree.
   */
  spawn(options: {
    readonly abortSignal?: AbortSignal;
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
    readonly workingDirectory: string;
  }): Promise<SandboxProcess>;
  /**
   * Resolves to `null` only when the path does not exist. A directory or an
   * unreadable path rejects. Return bytes or a stream, whichever the backend has.
   */
  readFile(options: {
    readonly abortSignal?: AbortSignal;
    readonly path: string;
  }): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  /** Creates missing parent directories and overwrites existing files. The only write primitive. */
  writeFiles(options: SandboxWriteFilesOptions): Promise<void>;
  /** `force` ignores a missing path; `recursive` removes a non-empty directory. */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  /** Releases compute and keeps the sandbox's files. */
  stop(): Promise<void>;
  /** Releases what this process holds, such as a local interpreter, without touching the sandbox. */
  close?(): Promise<void>;
  /**
   * Provider capabilities merged onto the session, such as `setNetworkPolicy`.
   * A plain object: eve merges its own enumerable properties, so use closures
   * rather than class methods. A member named like a session method is a type
   * error, and eve rejects it.
   */
  readonly extensions?: Extensions & { readonly [Key in ReservedSessionMember]?: never };
}

/** What eve passes to `start()`, `resume()`, and `onSessionEnd()`. */
export interface SandboxSessionContext {
  /**
   * The session that owns the sandbox. Derive native names from `session.id`:
   * for a subagent that shares its parent's sandbox it is the parent's id, and
   * for a keyed `invokeTool` call it is the derived tool-session id.
   */
  readonly session: SandboxSelectorContext["session"];
  /** `"tool-session"` for a keyed `invokeTool` call's sandbox, `"session"` otherwise. */
  readonly kind: "session" | "tool-session";
  /** A host directory the provider may use for local state. */
  readonly storagePath: string;
  /** Resolves a path relative to the app's project root on the host. */
  resolveProjectPath(path: string): string;
}

/**
 * Values hashed into a template key: JSON values, `undefined` (omitted),
 * plain objects and arrays, and functions (hashed by their source). Other
 * values and circular structures reject.
 */
export type SandboxIdentity = { readonly [key: string]: unknown };

/**
 * What eve passes to `prepare()` while it builds a template. Not generic over
 * the provider's extensions, so TypeScript infers them from `start()`.
 */
export interface SandboxPrepareContext {
  /** Authored files under the agent's `sandbox/` directory. */
  readonly files: SandboxProviderFiles;
  /** `true` when there are no workspace or skill files and no authored `prepare`. */
  readonly isEmpty: boolean;
  readonly storagePath: string;
  /** Reports build progress, such as `eve build` output. */
  log(message: string): void;
  /**
   * Seeds `/workspace` and `$HOME/.agents/skills`, then runs the authored
   * `prepare` with a session over `connection`. With `mountedAt`, the
   * provider has mounted {@link resourcesDirectory} read-only at that
   * sandbox path, and eve copies from it instead of writing every file.
   */
  populate(
    connection: SandboxConnection<object>,
    options?: { readonly mountedAt?: string },
  ): Promise<void>;
  resolveProjectPath(path: string): string;
  /** A stable read-only host directory holding `workspace/` and `skills/`, when one exists. */
  resourcesDirectory(): Promise<string | undefined>;
  /**
   * Hashes `identity` together with the workspace files, skill files, and
   * sandbox source revision into a stable SHA-256 hex key. `resources` and
   * `sourceRevision` are reserved.
   */
  templateKey(identity: SandboxIdentity): string;
}

export interface SandboxSessionEndOptions {
  readonly abortSignal?: AbortSignal;
  readonly reason: "completed" | "expired" | "failed" | "deleted";
}

/** The lifecycle one sandbox environment implements. */
export interface SandboxProviderImplementation<
  OpenOptions extends object | undefined,
  Artifact extends SandboxJson,
  State extends SandboxJson,
  Extensions extends object,
> {
  /**
   * Builds a template during `eve build`, or on first access in `eve dev`, and
   * returns the JSON artifact that ships with the deployment. Call
   * `ctx.populate()` on the build instance before capturing it.
   */
  prepare(ctx: SandboxPrepareContext): Promise<Artifact>;
  /**
   * Returns the sandbox for `ctx.session.id`, creating it when none exists.
   * An idempotent upsert: repeated, concurrent, cross-process, and
   * cross-deployment calls return the same sandbox while it exists. Derive
   * native identity from `ctx.session.id` and a provider-level namespace
   * only; `options` and `artifact` apply only when this call creates it.
   */
  start(
    ctx: SandboxSessionContext,
    options: Readonly<OpenOptions> | undefined,
    artifact: Readonly<Artifact>,
  ): Promise<{ readonly connection: SandboxConnection<Extensions>; readonly state: State }>;
  /**
   * Reconnects to the sandbox `state` names, never recreating it. Throw
   * `SandboxSessionGoneError` when it no longer exists.
   */
  resume(
    ctx: SandboxSessionContext,
    artifact: Readonly<Artifact>,
    state: Readonly<State>,
  ): Promise<SandboxConnection<Extensions>>;
  /**
   * Deletes whatever exists for `ctx.session.id`. `state` is `null` when the
   * session never recorded it. Must succeed when nothing exists and be
   * idempotent. `sandbox.delete()` also lands here, with `reason: "deleted"`.
   */
  onSessionEnd(
    ctx: SandboxSessionContext,
    state: Readonly<State> | null,
    options: SandboxSessionEndOptions,
  ): Promise<void>;
  /**
   * Lets a keyed `invokeTool` call keep its sandbox between calls. eve never
   * ends a keyed sandbox, so the provider must bound its retention.
   */
  readonly toolSessions?: true;
}

export interface SandboxPrepareOption<Session> {
  /** Runs once per template, after eve seeds workspace and skill files. */
  readonly prepare?: (sandbox: Session) => void | Promise<void>;
}

/** Environment options plus the standard `prepare` option. */
export type WithPrepareOption<Options extends object, Session> = Options &
  SandboxPrepareOption<Session>;

export interface SandboxProviderDefinition<
  EnvironmentOptions extends object,
  OpenOptions extends object | undefined,
  Artifact extends SandboxJson,
  State extends SandboxJson,
  Extensions extends object,
> {
  readonly name: string;
  /** Bump when `State` changes incompatibly; recorded state from another version starts fresh. */
  readonly stateProtocolVersion?: number;
  /**
   * Receives the environment options without `prepare`, which eve runs in
   * `ctx.populate()`. Always an object: `{}` when the caller passes none.
   */
  environment(
    options: EnvironmentOptions,
  ): SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions>;
}

/** Defines a sandbox provider from a connection and a lifecycle. */
export function defineSandboxProvider<
  EnvironmentOptions extends object = {},
  OpenOptions extends object | undefined = undefined,
  Artifact extends SandboxJson = SandboxJson,
  State extends SandboxJson = SandboxJson,
  Extensions extends object = {},
>(
  definition: SandboxProviderDefinition<
    EnvironmentOptions,
    OpenOptions,
    Artifact,
    State,
    Extensions
  >,
): SandboxProvider<
  WithPrepareOption<EnvironmentOptions, SandboxSession & Extensions>,
  OpenOptions,
  SandboxSession & Extensions
> {
  type Session = SandboxSession & Extensions;
  const provider = defineLegacySandboxProvider<
    SandboxPrepareOption<Session> | undefined,
    OpenOptions,
    Artifact,
    State,
    Session
  >({
    name: definition.name,
    stateProtocolVersion: definition.stateProtocolVersion,
    environment(options) {
      const { prepare, ...environmentOptions } = options ?? {};
      const implementation = definition.environment(environmentOptions as EnvironmentOptions);
      return adaptSandboxProvider(definition.name, implementation, prepare);
    },
  });
  return provider as SandboxProvider<
    WithPrepareOption<EnvironmentOptions, Session>,
    OpenOptions,
    Session
  >;
}

function adaptSandboxProvider<
  OpenOptions extends object | undefined,
  Artifact extends SandboxJson,
  State extends SandboxJson,
  Extensions extends object,
>(
  providerName: string,
  implementation: SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions>,
  prepare: ((sandbox: SandboxSession & Extensions) => void | Promise<void>) | undefined,
): LegacySandboxProviderImplementation<OpenOptions, Artifact, State, SandboxSession & Extensions> {
  const closers = new WeakMap<SandboxProviderHandle, () => Promise<void>>();
  // Connections this process holds per session, so terminal cleanup can close them.
  const open = new Map<string, Set<() => Promise<void>>>();

  function createHandle(
    context: SandboxSessionContext,
    connection: SandboxConnection<Extensions>,
    state: Readonly<State>,
  ): SandboxProviderHandle<SandboxSession & Extensions> {
    const sessionId = context.session.id;
    // eve may stop or close one connection from several paths, such as
    // `sandbox.stop()` and then server shutdown, so each runs once.
    const stop = once(() => connection.stop());
    const close = once(async () => {
      const remaining = open.get(sessionId);
      remaining?.delete(close);
      if (remaining?.size === 0) open.delete(sessionId);
      await connection.close?.();
    });
    let sessionClosers = open.get(sessionId);
    if (sessionClosers === undefined) open.set(sessionId, (sessionClosers = new Set()));
    sessionClosers.add(close);
    const release = async () => {
      try {
        await stop();
      } finally {
        await close();
      }
    };
    const handle: SandboxProviderHandle<SandboxSession & Extensions> = {
      sandbox: createConnectionSession(connection),
      onRuntimeShutdown: release,
      async onSandboxDelete(options) {
        try {
          await close();
        } finally {
          await implementation.onSessionEnd(context, state, {
            abortSignal: options?.abortSignal,
            reason: "deleted",
          });
        }
      },
      onSandboxStop: release,
    };
    closers.set(handle, close);
    return handle;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const sessionClosers = [...(open.get(sessionId) ?? [])];
    open.delete(sessionId);
    await Promise.allSettled(sessionClosers.map((close) => close()));
  }

  const adapted: LegacySandboxProviderImplementation<
    OpenOptions,
    Artifact,
    State,
    SandboxSession & Extensions
  > = {
    async onSessionEnd(context, state, { reason }) {
      // A failed close of a process-local resource must not block deleting the sandbox.
      await closeSession(context.session.id);
      await implementation.onSessionEnd(createSessionContext(context), state, { reason });
    },
    async prepare(context) {
      return await implementation.prepare(createPrepareContext(providerName, context, prepare));
    },
    async resume(context, artifact, state) {
      const sessionContext = createSessionContext(context);
      const connection = await implementation.resume(sessionContext, artifact, state);
      return createHandle(sessionContext, connection, state);
    },
    async start(context, options, artifact) {
      const sessionContext = createSessionContext(context);
      const { connection, state } = await implementation.start(sessionContext, options, artifact);
      return { handle: createHandle(sessionContext, connection, state), state };
    },
  };
  if (implementation.toolSessions !== true) return adapted;
  return withToolSessionSandboxes(adapted, {
    releaseHandle: async (handle) => await closers.get(handle)?.(),
  });
}

function createSessionContext(context: SandboxProviderSessionContext): SandboxSessionContext {
  return {
    kind: isToolSessionId(context.session.id) ? "tool-session" : "session",
    resolveProjectPath: (path) => context.host.resolveProjectPath(path),
    session: context.session,
    storagePath: context.storagePath,
  };
}

function createPrepareContext<Extensions extends object>(
  providerName: string,
  context: SandboxProviderPrepareContext,
  prepare: ((sandbox: SandboxSession & Extensions) => void | Promise<void>) | undefined,
): SandboxPrepareContext {
  const files = providerResourceTargetFiles(context.resources);
  const log = (message: string) => context.log?.(message);
  return {
    files: context.files,
    isEmpty: files.length === 0 && prepare === undefined,
    log,
    async populate(connection, options) {
      const session = createConnectionSession(connection);
      // Without a resource directory there is nothing mounted to copy from.
      if (options?.mountedAt !== undefined && context.resources.source.kind === "materialized") {
        log("copying workspace and skills from mounted resources");
        await hydrateSandboxFromImmutableResources(session, shellQuote(options.mountedAt));
      } else if (files.length > 0) {
        log("writing workspace and skills");
        await session.writeFiles({
          files: await Promise.all(
            files.map(async (file) => ({
              content: typeof file.content === "string" ? Buffer.from(file.content) : file.content,
              path: await resolveSandboxModelPath({ path: file.path, sandbox: session }),
            })),
          ),
        });
      }
      if (prepare === undefined) return;
      log("running sandbox preparation");
      // The provider builds the template with the connection type its sessions use.
      await prepare(createLoggingSandboxSession({ log, session }) as SandboxSession & Extensions);
    },
    resolveProjectPath: (path) => context.host.resolveProjectPath(path),
    async resourcesDirectory() {
      const source = context.resources.source;
      if (source.kind !== "materialized") return undefined;
      return await prepareImmutableResources({
        provider: providerName,
        resourcesKey: source.key,
        sourcePath: source.path,
        storagePath: context.storagePath,
      });
    },
    storagePath: context.storagePath,
    templateKey(identity) {
      assertSandboxIdentity(identity, "identity", new WeakSet());
      for (const reserved of ["resources", "sourceRevision"]) {
        if (Object.hasOwn(identity, reserved)) {
          throw new Error(
            `ctx.templateKey() reserves "${reserved}": eve adds the workspace and skill files and the sandbox source revision itself. Rename that identity field.`,
          );
        }
      }
      return createSandboxProviderIdentity({
        ...identity,
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
      });
    },
  };
}

function createConnectionSession<Extensions extends object>(
  connection: SandboxConnection<Extensions>,
): SandboxSession & Extensions {
  const session = buildSandboxSession({
    async readFile(options) {
      const content = await connection.readFile(options);
      if (content === null || !ArrayBuffer.isView(content)) return content;
      return bufferToStream(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    },
    removePath: (options) => connection.removePath(options),
    resolvePath: resolveSandboxPath,
    spawn: (options) =>
      connection.spawn({
        abortSignal: options.abortSignal,
        command: options.command,
        env: options.env ?? {},
        workingDirectory: resolveSandboxPath(options.workingDirectory ?? WORKSPACE_ROOT),
      }),
    async writeFile(options) {
      await connection.writeFiles({
        abortSignal: options.abortSignal,
        files: [{ content: await streamToBuffer(options.content), path: options.path }],
      });
    },
    writeFiles: (options) => connection.writeFiles(options),
  });
  const extensions: object = connection.extensions ?? {};
  const collisions = Object.keys(extensions).filter(
    (key) => Object.hasOwn(session, key) || key === "delete" || key === "stop",
  );
  if (collisions.length > 0) {
    throw new Error(
      `Sandbox connection extensions cannot replace the session members eve provides: ${collisions.join(", ")}. Rename them.`,
    );
  }
  return { ...extensions, ...session } as SandboxSession & Extensions;
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

/**
 * Rejects what the template-key hasher cannot tell apart, such as a `Date` or
 * `Map` that would hash as `{}`, and circular values, before hashing.
 */
function assertSandboxIdentity(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || value === undefined || typeof value === "function") return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const prototype = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  const plain = Array.isArray(value) || prototype === Object.prototype || prototype === null;
  if (typeof value !== "object" || !plain) {
    throw new Error(
      `ctx.templateKey() accepts only JSON values, plain objects, arrays, and functions, but ${path} is ${describeIdentityValue(value)}. Pass a JSON form, such as a string.`,
    );
  }
  if (seen.has(value))
    throw new Error(`ctx.templateKey() cannot hash a circular value at ${path}.`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    assertSandboxIdentity(entry, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function describeIdentityValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return `a ${value.constructor?.name ?? "non-plain object"}`;
  }
  return typeof value === "number" ? String(value) : `a ${typeof value}`;
}

function resolveSandboxPath(path: string): string {
  return posix.resolve(WORKSPACE_ROOT, path);
}
