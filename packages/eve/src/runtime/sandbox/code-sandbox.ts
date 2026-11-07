import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import {
  getSandboxEnvironmentRuntime,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";

// A sandbox for an agent defined in code: the session resource its sandbox tools open, as
// `agent/sandbox.ts` would declare it. A build prepares a file agent's sandbox template ahead of
// time; a program has no build, so its template is prepared on first use, once per process and
// sandbox, under the app's sandbox cache.

/** A sandbox a code agent's sessions open, with how its template is prepared. */
export interface CodeSandbox {
  readonly registry: RuntimeSandboxRegistry;
  /** The prepared template the provider starts sessions from. */
  readonly preparedArtifact: () => Promise<SandboxPreparedArtifact>;
  /** Where the provider keeps templates and session roots. */
  readonly appRoot: string;
}

export interface CodeSandboxOptions {
  /** Names the sandbox's template; change it to prepare a fresh one. `code:default` by default. */
  readonly revision?: string;
  /** The project the sandbox's cache lives under; the process's working directory by default. */
  readonly appRoot?: string;
}

/** A sandbox environment a code agent can open: what a provider's `environment()` returns. */
export type CodeSandboxEnvironment = SandboxEnvironmentIdentity & {
  open(): Promise<RuntimeSandboxSession>;
};

/** A sandbox that opens `environment` for each session, its template prepared on first use. */
export function codeSandbox(
  environment: CodeSandboxEnvironment,
  options: CodeSandboxOptions = {},
): CodeSandbox {
  const appRoot = options.appRoot ?? process.cwd();
  const revision = options.revision ?? "code:default";
  let prepared: Promise<SandboxPreparedArtifact> | undefined;
  const preparedArtifact = () => {
    prepared ??= (async () => {
      const provider = getSandboxEnvironmentRuntime(environment);
      // Loaded when a sandbox is first prepared: a build's prewarm brings the module loader.
      const { createSandboxPrepareContext } = await import("#execution/sandbox/prewarm.js");
      return await provider.implementation.prepare(
        createSandboxPrepareContext({
          appRoot,
          files: createSandboxProviderFiles(appRoot),
          log: () => {},
          provider,
          resources: {},
          sourceRevision: revision,
          storagePath: resolveSandboxCacheDirectory(appRoot),
        }),
      );
    })();
    prepared.catch(() => {
      prepared = undefined;
    });
    return prepared;
  };
  return codeSandboxWith(environment, { appRoot, preparedArtifact, revision });
}

/**
 * A code sandbox around `environment` whose template the caller prepares: on disk
 * ({@link codeSandbox}), or not at all, for a provider with nothing to build.
 */
export function codeSandboxWith(
  environment: CodeSandboxEnvironment,
  options: {
    readonly appRoot: string;
    readonly revision: string;
    readonly preparedArtifact: () => Promise<SandboxPreparedArtifact>;
  },
): CodeSandbox {
  return {
    appRoot: options.appRoot,
    preparedArtifact: options.preparedArtifact,
    registry: {
      sandbox: {
        definition: {
          environment,
          kind: "independent",
          logicalPath: "sandbox.ts",
          revisionHash: options.revision,
          selector: defineSandbox(() => environment.open()),
          sourceId: "code:sandbox",
          sourceKind: "module",
        },
        workspaceResourceRoot: { logicalPath: "workspace", rootEntries: [] },
      },
    },
  };
}
