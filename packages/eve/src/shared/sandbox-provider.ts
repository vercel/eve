import {
  createSandboxEnvironment,
  type SandboxEnvironment,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface SandboxDeleteOptions {
  readonly abortSignal?: AbortSignal;
}

export interface SandboxProviderResourceFile {
  readonly content: string | Uint8Array;
  readonly relativePath: string;
}

export interface SandboxProviderResourceTree {
  readonly files: readonly SandboxProviderResourceFile[];
  readonly key: string;
  readonly mountPath: string;
  readonly targetPath: string;
}

export type SandboxProviderResourceSource =
  | { readonly kind: "none" }
  | { readonly key: string; readonly kind: "inline" }
  | { readonly key: string; readonly kind: "materialized"; readonly path: string };

export interface SandboxProviderResources {
  readonly skills?: SandboxProviderResourceTree;
  readonly source: SandboxProviderResourceSource;
  readonly workspace?: SandboxProviderResourceTree;
}

export function sandboxProviderResourceIdentity(resources: SandboxProviderResources): object {
  return {
    skills: resources.skills?.key,
    workspace: resources.workspace?.key,
  };
}

export interface SandboxProviderTargetFile {
  readonly content: string | Uint8Array;
  readonly path: string;
}

export function providerResourceTargetFiles(
  resources: SandboxProviderResources,
): SandboxProviderTargetFile[] {
  return [resources.workspace, resources.skills].flatMap((resource) =>
    resource === undefined
      ? []
      : resource.files.map((file) => ({
          content: file.content,
          path: `${resource.targetPath}/${file.relativePath}`,
        })),
  );
}

export type SandboxPreparedArtifact =
  | null
  | boolean
  | number
  | string
  | readonly SandboxPreparedArtifact[]
  | { readonly [key: string]: SandboxPreparedArtifact };

export function isSandboxPreparedArtifact(value: unknown): value is SandboxPreparedArtifact {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isSandboxPreparedArtifact);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isSandboxPreparedArtifact)
  );
}

export function isSandboxPreparedArtifactRecord(
  artifact: unknown,
): artifact is { readonly [key: string]: SandboxPreparedArtifact } {
  return typeof artifact === "object" && artifact !== null && !Array.isArray(artifact);
}

export interface SandboxProviderFiles {
  list(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}

export interface SandboxProviderHost {
  loadOptionalPackage<T>(input: {
    readonly autoInstall: boolean;
    readonly importModule: () => Promise<T>;
    readonly installPackageName?: string;
    readonly ignoredOptionalDependencies?: readonly string[];
    readonly missingMessage: string;
    readonly packageName: string;
  }): Promise<T>;
  resolveProjectPath(path: string): string;
}

export interface SandboxProviderPrepareContext {
  readonly files: SandboxProviderFiles;
  readonly host: SandboxProviderHost;
  readonly log?: (message: string) => void;
  readonly resources: SandboxProviderResources;
  readonly sourceRevision: string;
  readonly storagePath: string;
}

export interface SandboxProviderSessionContext {
  readonly host: SandboxProviderHost;
  readonly session: SandboxSelectorContext["session"];
  readonly storagePath: string;
}

export interface SandboxProviderHandle<Session extends SandboxSession = SandboxSession> {
  readonly sandbox: Session;
  onRuntimeShutdown(): Promise<void>;
  onSandboxDelete(options?: SandboxDeleteOptions): Promise<void>;
  onSandboxStop(): Promise<void>;
}

export interface LegacySandboxProviderImplementation<
  OpenOptions extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession = SandboxSession,
> {
  /**
   * Permanently deletes the sandbox for `context.session.id` after the session's terminal
   * outcome. `state` is what `start()` returned when the session recorded it, or `null` when
   * the session never did, for example because a subagent that shares the sandbox opened it.
   * Find the sandbox from the key when `state` is `null`. Must succeed when no sandbox exists
   * and be idempotent, because the cleanup step may retry.
   */
  onSessionEnd(
    context: SandboxProviderSessionContext,
    state: Readonly<SessionState> | null,
    options: { readonly reason: "completed" | "expired" | "failed" },
  ): Promise<void>;
  prepare(context: SandboxProviderPrepareContext): Promise<PreparedArtifact>;
  resume(
    context: SandboxProviderSessionContext,
    artifact: Readonly<PreparedArtifact>,
    state: Readonly<SessionState>,
  ): Promise<SandboxProviderHandle<Session>>;
  /**
   * Returns the live sandbox for `context.session.id`, creating it when none exists. This
   * must be an idempotent upsert on that key: repeated and concurrent calls, from any process
   * or deployment, return the same sandbox while it exists. Derive the sandbox's identity
   * from the key and a provider-level namespace only, never from `options` or `artifact`,
   * which apply only when this call creates the sandbox.
   */
  start(
    context: SandboxProviderSessionContext,
    options: Readonly<OpenOptions> | undefined,
    artifact: Readonly<PreparedArtifact>,
  ): Promise<{ readonly handle: SandboxProviderHandle<Session>; readonly state: SessionState }>;
}

type SandboxOptionArguments<Options extends object | undefined> = Options extends undefined
  ? [options?: undefined]
  : Record<never, never> extends Options
    ? [options?: Readonly<Options>]
    : [options: Readonly<Options>];

export type LegacySandboxProviderDefinition<
  EnvironmentOptions extends object | undefined,
  OpenOptions extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession,
> = {
  readonly name: string;
  readonly stateProtocolVersion?: number;
  environment(
    ...args: SandboxOptionArguments<EnvironmentOptions>
  ): LegacySandboxProviderImplementation<OpenOptions, PreparedArtifact, SessionState, Session>;
};

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

type ErasedSandboxProviderImplementation = LegacySandboxProviderImplementation<
  object | undefined,
  SandboxPreparedArtifact,
  SandboxPreparedArtifact,
  SandboxSession
>;

export interface SandboxProviderRuntime {
  readonly implementation: ErasedSandboxProviderImplementation;
  readonly providerName: string;
  readonly stateProtocolVersion: number;
}

/**
 * Defines a provider on the handle-based contract that eve's built-in
 * providers still implement and core runs. Internal: the public
 * `defineSandboxProvider()` in `#sandbox/provider.js` compiles the
 * connection-based contract onto it until every built-in migrates.
 */
export function defineLegacySandboxProvider<
  EnvironmentOptions extends object | undefined = undefined,
  OpenOptions extends object | undefined = undefined,
  PreparedArtifact extends SandboxPreparedArtifact = SandboxPreparedArtifact,
  SessionState = SandboxPreparedArtifact,
  Session extends SandboxSession = SandboxSession,
>(
  definition: LegacySandboxProviderDefinition<
    EnvironmentOptions,
    OpenOptions,
    PreparedArtifact,
    SessionState,
    Session
  >,
): SandboxProvider<EnvironmentOptions, OpenOptions, Session> {
  const stateProtocolVersion = definition.stateProtocolVersion ?? 1;
  return {
    name: definition.name,
    environment(...args: SandboxOptionArguments<EnvironmentOptions>) {
      return createSandboxEnvironment<OpenOptions, Session>({
        configuration: args[0],
        runtime: {
          implementation: eraseSandboxProviderImplementation(definition.environment(...args)),
          providerName: definition.name,
          stateProtocolVersion,
        },
      });
    },
  };
}

function eraseSandboxProviderImplementation<
  Options extends object | undefined,
  Artifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession,
>(
  implementation: LegacySandboxProviderImplementation<Options, Artifact, SessionState, Session>,
): ErasedSandboxProviderImplementation {
  return implementation as ErasedSandboxProviderImplementation;
}

export function createSandboxProviderResources(input: {
  readonly key?: string;
  readonly path?: string;
  readonly skills?: readonly SandboxProviderResourceFile[];
  readonly workspace?: readonly SandboxProviderResourceFile[];
}): SandboxProviderResources {
  const { key, path } = input;
  if (key === undefined) return { source: { kind: "none" } };
  return {
    skills: {
      files: input.skills ?? [],
      key: `${key}:skills`,
      mountPath: "/eve/resources/skills",
      targetPath: "$HOME/.agents/skills",
    },
    source: path === undefined ? { key, kind: "inline" } : { key, kind: "materialized", path },
    workspace: {
      files: input.workspace ?? [],
      key: `${key}:workspace`,
      mountPath: "/eve/resources/workspace",
      targetPath: "/workspace",
    },
  };
}
