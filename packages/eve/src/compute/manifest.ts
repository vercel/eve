import { ComputeError } from "#compute/errors.js";
import type { DeploymentManifest, RetryPolicy } from "#compute/protocol.js";
import {
  assertDefinitionId,
  assertDigest,
  assertExactKeys,
  assertRecord,
  assertVersion,
  invalidInput,
} from "#compute/validation.js";

export type ComputeManifestDefinition = DeploymentManifest["definitions"][number];
export type ComputeDeploymentManifest = DeploymentManifest;

function parseNullableVersion(value: unknown, label: string): number | null {
  if (value === null) return null;
  assertVersion(value, label);
  return value;
}

function parseRetryPolicy(value: unknown, label: string): RetryPolicy | null {
  if (value === null) return null;
  assertRecord(value, label);
  if (value.mode === "manual") {
    assertExactKeys(value, ["mode", "timeoutMs"], label);
    assertVersion(value.timeoutMs, `${label}.timeoutMs`);
    if (value.timeoutMs > 900_000) invalidInput(`${label}.timeoutMs exceeds 900000.`);
    return { mode: "manual", timeoutMs: value.timeoutMs };
  }
  if (value.mode === "idempotent") {
    assertExactKeys(value, ["mode", "maxAttempts", "timeoutMs"], label);
    assertVersion(value.maxAttempts, `${label}.maxAttempts`);
    assertVersion(value.timeoutMs, `${label}.timeoutMs`);
    if (value.maxAttempts > 5) invalidInput(`${label}.maxAttempts exceeds 5.`);
    if (value.timeoutMs > 900_000) invalidInput(`${label}.timeoutMs exceeds 900000.`);
    return {
      mode: "idempotent",
      maxAttempts: value.maxAttempts,
      timeoutMs: value.timeoutMs,
    };
  }
  invalidInput(`${label}.mode must be "manual" or "idempotent".`);
}

function parseDefinition(value: unknown, index: number): ComputeManifestDefinition {
  const label = `deployment.definitions[${index}]`;
  assertRecord(value, label);
  assertExactKeys(
    value,
    ["id", "kind", "module", "export", "inputVersion", "stateVersion", "outputVersion", "retry"],
    label,
  );
  assertDefinitionId(value.id, `${label}.id`);
  if (value.kind !== "cell" && value.kind !== "effect" && value.kind !== "resumable_task") {
    invalidInput(`${label}.kind is invalid.`);
  }
  assertDefinitionId(value.module, `${label}.module`);
  if (typeof value.export !== "string" || value.export.length === 0) {
    invalidInput(`${label}.export must be a non-empty string.`);
  }
  assertVersion(value.inputVersion, `${label}.inputVersion`);
  const stateVersion = parseNullableVersion(value.stateVersion, `${label}.stateVersion`);
  const outputVersion = parseNullableVersion(value.outputVersion, `${label}.outputVersion`);
  const retry = parseRetryPolicy(value.retry, `${label}.retry`);

  if (
    value.kind === "cell" &&
    (stateVersion === null || outputVersion !== null || retry !== null)
  ) {
    invalidInput(`${label} has invalid cell version or retry fields.`);
  }
  if (
    value.kind === "effect" &&
    (stateVersion !== null || outputVersion === null || retry === null)
  ) {
    invalidInput(`${label} has invalid effect version or retry fields.`);
  }

  return {
    id: value.id,
    kind: value.kind,
    module: value.module,
    export: value.export,
    inputVersion: value.inputVersion,
    stateVersion,
    outputVersion,
    retry,
  };
}

export function parseDeploymentManifest(value: unknown): ComputeDeploymentManifest {
  assertRecord(value, "deployment");
  assertExactKeys(
    value,
    ["protocol", "image", "artifactManifestHash", "definitions"],
    "deployment",
  );
  if (value.protocol !== 1) invalidInput("deployment.protocol must be 1.");
  assertDigest(value.image, "deployment.image");
  assertDigest(value.artifactManifestHash, "deployment.artifactManifestHash");
  if (!Array.isArray(value.definitions)) invalidInput("deployment.definitions must be an array.");
  const definitions = value.definitions.map(parseDefinition);
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) {
    invalidInput("deployment definition IDs must be unique.");
  }
  return {
    protocol: 1,
    image: value.image,
    artifactManifestHash: value.artifactManifestHash,
    definitions,
  };
}

export function requireManifestDefinition(
  manifest: ComputeDeploymentManifest,
  id: string,
  kind: ComputeManifestDefinition["kind"],
): ComputeManifestDefinition {
  const definition = manifest.definitions.find(
    (candidate) => candidate.id === id && candidate.kind === kind,
  );
  if (definition === undefined) {
    throw new ComputeError(
      "DEPLOYMENT_UNAVAILABLE",
      `Deployment does not contain ${kind} definition "${id}".`,
    );
  }
  return definition;
}
