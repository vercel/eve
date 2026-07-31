import { isSandboxDefinition, type SandboxDefinition } from "#public/definitions/sandbox.js";

/**
 * Validates an authored sandbox definition without invoking it.
 */
export function normalizeSandboxDefinition(value: unknown, message: string): SandboxDefinition {
  if (!isSandboxDefinition(value)) {
    throw new Error(`${message} Use defineSandbox((ctx) => sandbox).`);
  }
  return value;
}
