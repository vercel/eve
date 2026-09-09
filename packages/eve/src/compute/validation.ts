import { Buffer } from "node:buffer";

import { ComputeError } from "#compute/errors.js";
import type {
  Counter,
  DefinitionId,
  Digest,
  VersionedValue,
  WireValue,
} from "#compute/protocol.js";

const MAX_COUNTER = (1n << 63n) - 1n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFINITION_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const UTC_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/u;

export function invalidInput(message: string): never {
  throw new ComputeError("INVALID_INPUT", message);
}

export function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput(`${label} must be an object.`);
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    invalidInput(`${label} contains unknown field "${unknown[0]}".`);
  }
}

export function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidInput(`${label} must be a canonical UUID.`);
  }
}

export function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    invalidInput(`${label} must be a lowercase sha256 digest.`);
  }
}

export function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) {
    invalidInput(`${label} must be a positive PostgreSQL integer.`);
  }
}

export function parseCounter(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    invalidInput(`${label} must be a non-negative decimal string.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_COUNTER) {
    invalidInput(`${label} must be at most ${MAX_COUNTER}.`);
  }
  return parsed;
}

export function toCounter(value: string | number | bigint): Counter {
  return BigInt(value).toString() as Counter;
}

export function assertDefinitionId(value: unknown, label: string): asserts value is DefinitionId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    DEFINITION_SCHEME_PATTERN.test(value)
  ) {
    invalidInput(`${label} must be a normalized relative definition path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalidInput(`${label} must not contain empty, "." or ".." path segments.`);
  }
}

export function assertLocalKey(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    invalidInput(`${label} must contain 1 to 256 UTF-8 bytes.`);
  }
}

export function assertUtcTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !UTC_OFFSET_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalidInput(`${label} must be an ISO timestamp with an explicit UTC offset.`);
  }
}

export function assertWireValue(value: unknown, label: string): asserts value is WireValue {
  assertRecord(value, label);
  assertExactKeys(value, ["codec", "data"], label);
  if (value.codec !== "eve-value-v1" || typeof value.data !== "string") {
    invalidInput(`${label} must be an eve-value-v1 value.`);
  }
}

export function assertVersionedValue(
  value: unknown,
  label: string,
): asserts value is VersionedValue {
  assertRecord(value, label);
  assertExactKeys(value, ["version", "value"], label);
  assertVersion(value.version, `${label}.version`);
  assertWireValue(value.value, `${label}.value`);
}
