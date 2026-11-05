import { defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxEnvironmentIdentity } from "#shared/sandbox-environment.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";

// A sandbox for an agent defined in code: the session resource its sandbox tools open, as
// `agent/sandbox.ts` would declare it, with however its template is prepared. `codeSandbox()`
// (`code-sandbox.ts`) prepares it on disk; a sandbox with nothing to build prepares nothing.

/** A sandbox a code agent's sessions open, with how its template is prepared. */
export interface CodeSandbox {
  readonly registry: RuntimeSandboxRegistry;
  /** The prepared template the provider starts sessions from. */
  readonly preparedArtifact: () => Promise<SandboxPreparedArtifact>;
  /** Where the provider keeps templates and session roots. */
  readonly appRoot: string;
}

/** A sandbox environment a code agent can open: what a provider's `environment()` returns. */
export type CodeSandboxEnvironment = SandboxEnvironmentIdentity & {
  open(): Promise<RuntimeSandboxSession>;
};

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
