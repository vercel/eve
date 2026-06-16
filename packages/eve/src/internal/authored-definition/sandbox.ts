import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import { lazyBackend } from "#execution/sandbox/lazy-backend.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type { SandboxDefinition, SandboxRevalidationKeyFn } from "#public/definitions/sandbox.js";

type NormalizedSandboxDefinition = Readonly<Omit<SandboxDefinition, "backend">> & {
  readonly backend?: SandboxBackend;
  readonly description?: string;
  readonly revalidationKey?: SandboxRevalidationKeyFn;
};

/**
 * Normalizes one authored sandbox definition into the canonical internal
 * shape. If the author supplied a `backend` callback (e.g.
 * `backend: () => vercel({...})`), it is wrapped via
 * {@link lazyBackend} so downstream consumers always see a plain
 * `SandboxBackend` value — the callback fires exactly once on first
 * access and the resulting backend is memoized.
 */
export function normalizeSandboxDefinition(
  value: unknown,
  message: string,
): NormalizedSandboxDefinition {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    ["backend", "bootstrap", "description", "onSession", "revalidationKey"],
    message,
  );
  const definition: {
    backend?: NormalizedSandboxDefinition["backend"];
    description?: NormalizedSandboxDefinition["description"];
    bootstrap?: NormalizedSandboxDefinition["bootstrap"];
    onSession?: NormalizedSandboxDefinition["onSession"];
    revalidationKey?: NormalizedSandboxDefinition["revalidationKey"];
  } = {};

  if (record.backend !== undefined) {
    definition.backend = expectSandboxBackend(record.backend, message);
  }

  if (record.description !== undefined) {
    if (typeof record.description !== "string") {
      throw new Error(`${message} The "description" field must be a string when set.`);
    }
    definition.description = record.description;
  }

  if (record.bootstrap !== undefined) {
    definition.bootstrap = expectFunction(record.bootstrap, message);
  }

  if (record.revalidationKey !== undefined) {
    definition.revalidationKey = expectFunction(record.revalidationKey, message);
  }

  if (definition.bootstrap === undefined && definition.revalidationKey !== undefined) {
    throw new Error(
      `${message} The "revalidationKey" field can only be set when "bootstrap" is set.`,
    );
  }

  if (record.onSession !== undefined) {
    definition.onSession = expectFunction(record.onSession, message);
  }

  return definition;
}

function expectSandboxBackend(value: unknown, message: string): SandboxBackend {
  if (typeof value === "function") {
    return lazyBackend(value as () => SandboxBackend);
  }

  const record = expectObjectRecord(
    value,
    `${message} The "backend" field must be a SandboxBackend value (use docker(), vercel(), or your own factory) or a zero-arg function returning one.`,
  );

  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(
      `${message} The "backend" value must expose a non-empty string "name" identifier.`,
    );
  }

  if (typeof record.create !== "function") {
    throw new Error(`${message} The "backend" value must expose a "create" function.`);
  }

  if (record.prewarm !== undefined && typeof record.prewarm !== "function") {
    throw new Error(`${message} The "backend.prewarm" property must be a function when set.`);
  }

  return record as unknown as SandboxBackend;
}
