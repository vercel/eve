import {
  createSandboxEnvironment,
  type SandboxEnvironment,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";
import type { SandboxPreparedArtifact, SandboxProviderFiles } from "#shared/sandbox-provider.js";
import type {
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxSession,
  SandboxWriteFilesOptions,
} from "#shared/sandbox-session.js";

/** A JSON-compatible value: what a provider may return as an artifact or session state. */
export type SandboxJson = SandboxPreparedArtifact;

/** Members eve owns on every live sandbox, which a connection's extensions cannot replace. */
type ReservedSessionMember = keyof SandboxSession | "delete" | "stop";

/**
 * The byte-level connection to one sandbox that a provider implements. eve
 * derives the full {@link SandboxSession} from it.
 *
 * Every path a connection receives is absolute, and `workingDirectory` is
 * always set: eve resolves relative paths from {@link workspaceRoot}.
 */
export interface SandboxConnection<Extensions extends object = {}> {
  /**
   * The absolute sandbox directory that relative paths resolve from and
   * commands start in by default. Defaults to `/workspace`. The directory
   * must exist when eve first runs a command.
   */
  readonly workspaceRoot?: string;
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
   * Seeds the connection's workspace root and `$HOME/.agents/skills`, then
   * runs the authored `prepare` with a session over `connection`. With
   * `mountedAt`, the provider has mounted {@link resourcesDirectory}
   * read-only at that sandbox path, and eve copies from it instead of
   * writing every file.
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

type SandboxOptionArguments<Options extends object | undefined> = Options extends undefined
  ? [options?: undefined]
  : Record<never, never> extends Options
    ? [options?: Readonly<Options>]
    : [options: Readonly<Options>];

export interface SandboxProvider<
  EnvironmentOptions extends object | undefined,
  OpenOptions extends object | undefined,
  Session extends SandboxSession,
> {
  readonly name: string;
  environment(
    ...args: SandboxOptionArguments<EnvironmentOptions>
  ): SandboxEnvironment<OpenOptions, Session>;
}

/** What core runs for one environment: the provider's lifecycle with its types erased. */
export interface SandboxProviderRuntime {
  readonly implementation: SandboxProviderImplementation<
    object | undefined,
    SandboxJson,
    SandboxJson,
    object
  >;
  /** The authored `prepare` option, which eve runs in `ctx.populate()`. */
  readonly prepare: ((sandbox: SandboxSession) => void | Promise<void>) | undefined;
  readonly providerName: string;
  readonly stateProtocolVersion: number;
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
  return {
    name: definition.name,
    environment(options?: WithPrepareOption<EnvironmentOptions, Session>) {
      const { prepare, ...environmentOptions } = options ?? {};
      return createSandboxEnvironment<OpenOptions, Session>({
        // The provider's own types are erased: core passes it only what it returned.
        implementation: definition.environment(
          environmentOptions as EnvironmentOptions,
        ) as SandboxProviderRuntime["implementation"],
        prepare: prepare as SandboxProviderRuntime["prepare"],
        providerName: definition.name,
        stateProtocolVersion: definition.stateProtocolVersion ?? 1,
      });
    },
  } as SandboxProvider<WithPrepareOption<EnvironmentOptions, Session>, OpenOptions, Session>;
}
