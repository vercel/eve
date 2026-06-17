import type { Optional } from "#shared/optional.js";
import type {
  SandboxDefinitionWithBootstrap as SharedSandboxDefinitionWithBootstrap,
  SandboxDefinitionWithoutBootstrap as SharedSandboxDefinitionWithoutBootstrap,
} from "#shared/sandbox-definition.js";

export type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
export type {
  SandboxBootstrapUseFn,
  SandboxRevalidationKeyFn,
  SandboxSessionUseFn,
  SandboxBootstrapContext,
  SandboxSessionContext,
} from "#shared/sandbox-definition.js";

/**
 * The shape passed to {@link defineSandbox}: a discriminated union over
 * whether a `bootstrap` hook is present. `backend` is optional here (it is
 * required on the shared base): when omitted, eve substitutes
 * `defaultBackend()` at runtime. `BO`/`SO` type the options for the
 * bootstrap-use and session-use functions respectively.
 */
export type SandboxDefinition<BO = Record<string, never>, SO = Record<string, never>> =
  | Optional<SharedSandboxDefinitionWithBootstrap<BO, SO>, "backend">
  | Optional<SharedSandboxDefinitionWithoutBootstrap<BO, SO>, "backend">;

/**
 * Defines the sandbox an agent (or subagent) runs in. Authored at the
 * path-derived location `agent/sandbox.ts` (or `agent/sandbox/sandbox.ts`
 * when paired with a `workspace/` folder); subagents use
 * `subagents/<name>/sandbox.ts`.
 *
 * Returns the definition unchanged: this is an identity helper that only
 * attaches types. `backend` is optional and defaults to `defaultBackend()`
 * at runtime. The `BO`/`SO` generics type the options accepted by the
 * `use()` calls inside `bootstrap` and `onSession` respectively.
 */
export function defineSandbox<BO = Record<string, never>, SO = Record<string, never>>(
  definition: SandboxDefinition<BO, SO>,
): SandboxDefinition<BO, SO> {
  return definition;
}
