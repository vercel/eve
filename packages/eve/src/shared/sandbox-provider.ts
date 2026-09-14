import { dirname, join } from "node:path";

import {
  createSandboxEnvironment,
  type SandboxEnvironment,
  type SandboxPrepare,
} from "#shared/sandbox-environment.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface SandboxDeleteOptions {
  readonly abortSignal?: AbortSignal;
}

export type SandboxProviderTags = Readonly<Record<string, string>>;

export interface SandboxDockerfileInput {
  readonly contextPath: string;
  readonly contentHash: string;
  readonly path: string;
}

export interface SandboxProviderResourceFile {
  readonly content: string | Uint8Array;
  readonly relativePath: string;
}

export interface SandboxProviderResourceTree {
  readonly files: readonly SandboxProviderResourceFile[];
  readonly key: string;
  readonly mountPath: string;
  readonly path?: string;
  readonly targetPath: string;
}

export interface SandboxProviderResources {
  readonly skills?: SandboxProviderResourceTree;
  readonly workspace?: SandboxProviderResourceTree;
}

export type SandboxPreparedArtifact =
  | null
  | boolean
  | number
  | string
  | readonly SandboxPreparedArtifact[]
  | { readonly [key: string]: SandboxPreparedArtifact };

export function isSandboxPreparedArtifactRecord(
  artifact: SandboxPreparedArtifact | undefined,
): artifact is { readonly [key: string]: SandboxPreparedArtifact } {
  return typeof artifact === "object" && artifact !== null && !Array.isArray(artifact);
}

export interface SandboxProviderPrepareContext {
  readonly appRoot: string;
  readonly dockerfile?: SandboxDockerfileInput;
  readonly force?: boolean;
  readonly log?: (message: string) => void;
  readonly resources: SandboxProviderResources;
  runPreparation(sandbox: SandboxSession): Promise<void>;
  readonly templateName: string;
}

export interface SandboxProviderPreparedArtifact<
  PreparedArtifact extends SandboxPreparedArtifact = SandboxPreparedArtifact,
> {
  readonly artifact: PreparedArtifact;
  readonly templateName: string;
}

export interface SandboxProviderCreateContext<CreateOptions, Metadata> {
  readonly appRoot: string;
  readonly existing?: Readonly<Metadata>;
  handle(input: SandboxProviderHandle<Metadata>): SandboxProviderHandle<Metadata>;
  readonly options: Readonly<CreateOptions>;
  readonly resources: SandboxProviderResources;
  readonly sandboxName: string;
  readonly tags?: SandboxProviderTags;
}

export interface SandboxProviderHandle<Metadata> {
  captureMetadata?(): Promise<Metadata>;
  readonly metadata: Metadata;
  readonly sandbox: SandboxSession;
  delete(options?: SandboxDeleteOptions): Promise<void>;
  shutdown(): Promise<void>;
  stop(): Promise<void>;
}

export interface SandboxProviderImplementation<
  CreateOptions,
  Metadata,
  PreparedArtifact extends SandboxPreparedArtifact = SandboxPreparedArtifact,
> {
  prepare(
    context: SandboxProviderPrepareContext,
  ): Promise<{ readonly artifact: PreparedArtifact; readonly reused: boolean }>;
  getOrCreate(
    context: SandboxProviderCreateContext<CreateOptions, Metadata>,
    prepared?: SandboxProviderPreparedArtifact<PreparedArtifact>,
  ): Promise<SandboxProviderHandle<Metadata>>;
}

export type SandboxProviderDefinition<
  EnvironmentOptions extends object,
  CreateOptions extends object | undefined,
  Metadata extends Record<string, unknown>,
  PreparedArtifact extends SandboxPreparedArtifact,
> = {
  readonly name: string;
  kind?(options: Readonly<EnvironmentOptions>): SandboxEnvironment["kind"];
} & (
  | {
      environment(
        options: Readonly<EnvironmentOptions>,
      ): SandboxProviderImplementation<CreateOptions, Metadata, PreparedArtifact>;
      readonly select?: never;
    }
  | {
      readonly environment?: never;
      select(
        options: Readonly<EnvironmentOptions>,
        prepare: SandboxPrepare | undefined,
      ): SandboxEnvironment<CreateOptions>;
    }
);

export type SandboxProviderEnvironmentOptions<Options extends object> = Omit<Options, "prepare"> & {
  readonly prepare?: SandboxPrepare;
};

export type SandboxProviderEnvironmentArguments<Options extends object> =
  Record<never, never> extends Options
    ? [options?: SandboxProviderEnvironmentOptions<Options>]
    : [options: SandboxProviderEnvironmentOptions<Options>];

export interface SandboxProvider<
  EnvironmentOptions extends object,
  CreateOptions extends object | undefined,
> {
  readonly name: string;
  environment(
    ...args: SandboxProviderEnvironmentArguments<EnvironmentOptions>
  ): SandboxEnvironment<CreateOptions>;
}

export interface SandboxProviderRuntime {
  readonly implementation: SandboxProviderImplementation<
    object | undefined,
    Record<string, unknown>
  >;
  readonly prepare?: SandboxPrepare;
  readonly providerName: string;
}

export function defineSandboxProvider<
  EnvironmentOptions extends object,
  CreateOptions extends object | undefined = undefined,
  Metadata extends Record<string, unknown> = Record<string, unknown>,
  PreparedArtifact extends SandboxPreparedArtifact = SandboxPreparedArtifact,
>(
  definition: SandboxProviderDefinition<
    EnvironmentOptions,
    CreateOptions,
    Metadata,
    PreparedArtifact
  >,
): SandboxProvider<EnvironmentOptions, CreateOptions> {
  return {
    name: definition.name,
    environment(...args: SandboxProviderEnvironmentArguments<EnvironmentOptions>) {
      const authoredOptions =
        args[0] ?? ({} as SandboxProviderEnvironmentOptions<EnvironmentOptions>);
      const { prepare, ...environmentOptions } = authoredOptions;
      const options = environmentOptions as EnvironmentOptions;
      if (definition.select !== undefined) return definition.select(options, prepare);
      return createSandboxEnvironment({
        configuration: { options, prepare },
        kind: definition.kind?.(options) ?? (prepare === undefined ? "default" : "prepared"),
        runtime: {
          implementation: definition.environment(options) as SandboxProviderImplementation<
            object | undefined,
            Record<string, unknown>
          >,
          prepare,
          providerName: definition.name,
        },
      });
    },
  };
}

export function createSandboxProviderResources(input: {
  readonly resourcesKey?: string;
  readonly resourcesPath?: string;
  readonly seedFiles?: readonly {
    readonly content: string | Uint8Array;
    readonly path: string;
  }[];
}): SandboxProviderResources {
  if (input.resourcesKey === undefined) return {};
  const files = input.seedFiles ?? [];
  return {
    skills: createResourceTree({
      files: files.filter((file) => file.path.startsWith("$HOME/.agents/skills/")),
      key: `${input.resourcesKey}:skills`,
      mountPath: "/eve/resources/skills",
      path: input.resourcesPath === undefined ? undefined : join(input.resourcesPath, "skills"),
      prefix: "$HOME/.agents/skills/",
      targetPath: "$HOME/.agents/skills",
    }),
    workspace: createResourceTree({
      files: files.filter((file) => !file.path.startsWith("$HOME/.agents/skills/")),
      key: `${input.resourcesKey}:workspace`,
      mountPath: "/eve/resources/workspace",
      path: input.resourcesPath === undefined ? undefined : join(input.resourcesPath, "workspace"),
      prefix: "/workspace/",
      targetPath: "/workspace",
    }),
  };
}

function createResourceTree(input: {
  readonly files: readonly { readonly content: string | Uint8Array; readonly path: string }[];
  readonly key: string;
  readonly mountPath: string;
  readonly path?: string;
  readonly prefix: string;
  readonly targetPath: string;
}): SandboxProviderResourceTree {
  return {
    files: input.files.map((file) => ({
      content: file.content,
      relativePath: file.path.startsWith(input.prefix)
        ? file.path.slice(input.prefix.length)
        : file.path,
    })),
    key: input.key,
    mountPath: input.mountPath,
    path: input.path,
    targetPath: input.targetPath,
  };
}

export function providerResourceRoot(resources: SandboxProviderResources): {
  readonly key?: string;
  readonly path?: string;
} {
  const resource = resources.workspace ?? resources.skills;
  if (resource === undefined) return {};
  return {
    key: resource.key.slice(0, resource.key.lastIndexOf(":")),
    path: resource.path === undefined ? undefined : dirname(resource.path),
  };
}
