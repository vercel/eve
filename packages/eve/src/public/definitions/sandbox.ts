import type { SandboxSelector } from "#shared/sandbox-environment.js";

export type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxReadTextFileOptions,
  SandboxKeepRunningOptions,
  SandboxKeepRunningResult,
  SandboxRunOptions,
  SandboxSession,
  RuntimeSandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteFilesOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
export type {
  SandboxOpenArguments,
  SandboxEnvironment,
  SandboxSelector,
  SandboxSelectorContext,
} from "#shared/sandbox-environment.js";

const SELECTOR = Symbol.for("eve.sandbox-selector");
const PARENT = Symbol.for("eve.sandbox-parent-definition");

/**
 * Defines the sandbox selector for an agent's `sandbox.ts`. The selector opens the session's sandbox,
 * usually with `environment.open()`, and runs until it succeeds once; later steps resume that sandbox.
 */
export function defineSandbox(definition: SandboxSelector): SandboxSelector {
  Object.defineProperty(definition, SELECTOR, { value: true });
  return definition;
}

/**
 * Defines a subagent's sandbox as the sandbox of the parent that called it, so both share one
 * sandbox owned by the parent's session.
 */
export function defineParentSandbox(): SandboxSelector {
  const selector = defineSandbox(async () => {
    throw new Error("Parent sandbox selection is resolved by eve.");
  });
  Object.defineProperty(selector, PARENT, { value: true });
  return selector;
}
