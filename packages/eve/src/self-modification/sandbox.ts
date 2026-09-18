import {
  defineSandbox,
  type SandboxBackend,
  type SandboxDefinition,
} from "#public/sandbox/index.js";

/** Options retained for source compatibility with the retired scaffold. */

export interface SelfModificationSandboxOptions {
  readonly backend?: SandboxBackend;
  readonly config?: unknown;
}

/** @deprecated The scaffolded sandbox is inert; use the packaged extension. */
export function selectDeployedSelfModificationBackend(
  configured: SandboxBackend | undefined,
  _probes: unknown,
): SandboxBackend {
  if (configured !== undefined) return configured;
  throw new Error("Deployed self-modification is disabled in the retired scaffold.");
}

export function defineSelfModificationSandbox(
  _options: SelfModificationSandboxOptions = {},
): SandboxDefinition {
  return defineSandbox({});
}

/** @deprecated The scaffolded sandbox is inert; use the packaged extension. */
export default defineSelfModificationSandbox();
