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
  RuntimeSandboxSession,
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

/** Opaque reference to an ancestor's durable sandbox. */
export interface SandboxAncestorReference {
  readonly sandbox: SandboxParentValue;
}

/**
 * Opaque value returned from a sandbox definition to select its parent's
 * durable sandbox. It intentionally exposes no provider operations: authored
 * code can only return it to eve.
 */
export interface SandboxParentValue {
  readonly __eveSandboxParentValue: unique symbol;
}

/** Runtime ancestry passed to a parent-selecting sandbox definition. */
export interface SandboxParentDefinitionContext {
  readonly parent: SandboxAncestorReference | null;
}

/** A definition that selects the dispatching parent's exact sandbox. */
export type SandboxParentDefinition = (
  context: SandboxParentDefinitionContext,
) => SandboxParentValue | Promise<SandboxParentValue>;

const SANDBOX_PARENT_DEFINITION_MARKER = Symbol.for("eve.sandbox-parent-definition");

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
 * Pass an object to define an independent sandbox. Passing a callback to
 * `defineSandbox` opts into sharing: return `parent.sandbox` to select the
 * dispatching parent's exact durable sandbox. It is intended for child-only
 * definitions; throw when `parent` is `null`.
 */
export function defineSandbox(definition: SandboxParentDefinition): SandboxParentDefinition;
export function defineSandbox<BO = Record<string, never>, SO = Record<string, never>>(
  definition: SandboxDefinition<BO, SO>,
): SandboxDefinition<BO, SO>;
export function defineSandbox<BO = Record<string, never>, SO = Record<string, never>>(
  definition: SandboxDefinition<BO, SO> | SandboxParentDefinition,
): SandboxDefinition<BO, SO> | SandboxParentDefinition {
  if (typeof definition === "function") {
    Object.defineProperty(definition, SANDBOX_PARENT_DEFINITION_MARKER, { value: true });
  }
  return definition;
}
