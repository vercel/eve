import type { SessionContext } from "#public/definitions/callback-context.js";
import type { Sandbox } from "#shared/sandbox-value.js";

const SANDBOX_DEFINITION = Symbol.for("eve.sandbox-definition");

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
export type { Sandbox } from "#shared/sandbox-value.js";
export type { SandboxTemplate } from "#shared/sandbox-template.js";

/**
 * Sandbox value exposed by a parent or root agent.
 */
export interface SandboxDefinitionAncestor {
  readonly sandbox: Promise<Sandbox>;
}

/**
 * Runtime context passed to an authored sandbox definition.
 */
export interface SandboxDefinitionContext {
  readonly parent: SandboxDefinitionAncestor | null;
  readonly root: SandboxDefinitionAncestor | null;
  readonly runtime: {
    readonly mode: "development" | "production";
  };
  readonly session: SessionContext["session"];
  readonly signal: AbortSignal;
}

/**
 * Chooses or creates the durable sandbox used by one agent session.
 */
export type SandboxDefinition = (context: SandboxDefinitionContext) => Sandbox | Promise<Sandbox>;

/**
 * Defines how an agent obtains its sandbox.
 *
 * The function runs only when the owning session has no compatible persisted
 * sandbox. Return the actual durable sandbox to use, including a parent's
 * sandbox when the child should share it.
 */
export function defineSandbox(definition: SandboxDefinition): SandboxDefinition {
  Object.defineProperty(definition, SANDBOX_DEFINITION, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return definition;
}

/**
 * Returns whether a module export was created with {@link defineSandbox}.
 */
export function isSandboxDefinition(value: unknown): value is SandboxDefinition {
  return typeof value === "function" && Reflect.get(value, SANDBOX_DEFINITION) === true;
}
