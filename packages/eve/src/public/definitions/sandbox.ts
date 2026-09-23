import type { SandboxSelector } from "#shared/sandbox-environment.js";

export type { NetworkPolicySandboxSession } from "#public/sandbox/network-policy-session.js";
export type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  RuntimeSandboxSession,
  RuntimeSandboxSessionFor,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
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

export function defineSandbox(definition: SandboxSelector): SandboxSelector {
  Object.defineProperty(definition, SELECTOR, { value: true });
  return definition;
}

export function defineParentSandbox(): SandboxSelector {
  const selector = defineSandbox(async () => {
    throw new Error("Parent sandbox selection is resolved by eve.");
  });
  Object.defineProperty(selector, PARENT, { value: true });
  return selector;
}
