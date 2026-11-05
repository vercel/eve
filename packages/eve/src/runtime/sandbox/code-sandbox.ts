import { hostWorkingDirectory } from "#platform/host-path.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { resolveSandboxCacheDirectory } from "#platform/sandbox-cache.js";
import {
  codeSandboxWith,
  type CodeSandbox,
  type CodeSandboxEnvironment,
} from "#runtime/sandbox/code-sandbox-registry.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";

// A sandbox for an agent defined in code whose template is prepared on disk: a build prepares a
// file agent's sandbox template ahead of time; a program has no build, so its template is prepared
// on first use, once per process and sandbox, under the app's sandbox cache. The sandbox itself is
// `code-sandbox-registry.ts`'s, which a host with nothing to prepare (a browser) uses alone.

export interface CodeSandboxOptions {
  /** Names the sandbox's template; change it to prepare a fresh one. `code:default` by default. */
  readonly revision?: string;
  /** The project the sandbox's cache lives under; the process's working directory by default. */
  readonly appRoot?: string;
}

/** A sandbox that opens `environment` for each session, its template prepared on first use. */
export function codeSandbox(
  environment: CodeSandboxEnvironment,
  options: CodeSandboxOptions = {},
): CodeSandbox {
  const appRoot = options.appRoot ?? hostWorkingDirectory();
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
