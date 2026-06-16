/**
 * Sandbox authoring helpers for `agent/sandbox.ts` (or
 * `agent/sandbox/sandbox.ts` when paired with a `workspace/` folder).
 */
export {
  defineSandbox,
  type SandboxBootstrapContext,
  type SandboxBootstrapUseFn,
  type SandboxCommandResult,
  type SandboxDefinition,
  type SandboxProcess,
  type SandboxReadBinaryFileOptions,
  type SandboxReadFileOptions,
  type SandboxReadTextFileOptions,
  type SandboxRevalidationKeyFn,
  type SandboxRunOptions,
  type SandboxSession,
  type SandboxSpawnOptions,
  type SandboxSessionContext,
  type SandboxSessionUseFn,
  type SandboxWriteBinaryFileOptions,
  type SandboxWriteFileOptions,
  type SandboxWriteTextFileOptions,
} from "#public/definitions/sandbox.js";
export type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendRuntimeContext,
  SandboxBackendSessionState,
  SandboxSeedFile,
} from "#public/definitions/sandbox-backend.js";
export type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
export { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
export {
  defaultSandbox as defaultBackend,
  type DefaultSandboxOptions as DefaultBackendOptions,
} from "#public/sandbox/backends/default.js";
