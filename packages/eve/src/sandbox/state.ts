import { parseJsonValue } from "#shared/json.js";
import type { Sandbox, SerializedSandbox } from "#shared/sandbox-value.js";

/**
 * Serializable sandbox value stored on the durable eve session.
 */
export interface SandboxStateValue {
  readonly revision: string;
  readonly value: SerializedSandbox;
}

export interface SandboxState extends SandboxStateValue {
  readonly root?: SandboxStateValue;
}

/**
 * Returns whether a workflow value is a complete serialized sandbox state.
 */
export function isSandboxStateValue(value: unknown): value is SandboxStateValue {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const revision = Reflect.get(value, "revision");
  const sandbox = Reflect.get(value, "value");
  if (
    typeof revision !== "string" ||
    sandbox === null ||
    typeof sandbox !== "object" ||
    typeof Reflect.get(sandbox, "adapterId") !== "string" ||
    typeof Reflect.get(sandbox, "id") !== "string" ||
    typeof Reflect.get(sandbox, "resourceId") !== "string"
  ) {
    return false;
  }

  try {
    parseJsonValue(Reflect.get(sandbox, "reference"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lazy sandbox accessor bound to one step execution.
 */
export interface SandboxAccess {
  captureState(): Promise<SandboxState | null>;
  get(): Promise<Sandbox | null>;
}
