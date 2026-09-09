import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ComputeError } from "#compute/errors.js";
import { assertExactKeys, assertRecord, assertUuid, invalidInput } from "#compute/validation.js";

export type ComputePermission = "send" | "read" | "operate" | "deploy";

export interface ComputePrincipal {
  principalId: string;
}

export interface ComputeAccessEntry {
  credentialHash: `sha256:${string}`;
  namespaceId: string;
  permissions: ComputePermission[];
  principalId: string;
}

export interface ComputeAuthenticator {
  authenticate(
    request: Request,
    namespaceId: string,
    permission: ComputePermission,
  ): Promise<ComputePrincipal>;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PERMISSIONS = new Set<ComputePermission>(["send", "read", "operate", "deploy"]);

export function hashComputeCredential(token: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ") || header.length === 7) {
    throw new ComputeError("UNAUTHORIZED", "Compute bearer credential is required.");
  }
  return header.slice(7);
}

function equalCredentialHash(left: string, right: string): boolean {
  const leftBytes = createHash("sha256").update(left, "utf8").digest();
  const rightBytes = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftBytes, rightBytes);
}

export function createComputeAuthenticator(
  entries: readonly ComputeAccessEntry[],
): ComputeAuthenticator {
  const access = entries.map(parseAccessEntry);
  return {
    async authenticate(request, namespaceId, permission) {
      const credentialHash = hashComputeCredential(readBearerToken(request));
      const entry = access.find(
        (candidate) =>
          candidate.namespaceId === namespaceId &&
          equalCredentialHash(candidate.credentialHash, credentialHash),
      );
      if (entry === undefined) {
        throw new ComputeError("UNAUTHORIZED", "Compute bearer credential is invalid.");
      }
      if (!entry.permissions.includes(permission)) {
        throw new ComputeError("FORBIDDEN", "Compute credential lacks the required permission.");
      }
      return { principalId: entry.principalId };
    },
  };
}

function parseAccessEntry(value: unknown, index: number): ComputeAccessEntry {
  const label = `access[${index}]`;
  assertRecord(value, label);
  assertExactKeys(value, ["credentialHash", "namespaceId", "permissions", "principalId"], label);
  if (typeof value.credentialHash !== "string" || !HASH_PATTERN.test(value.credentialHash)) {
    invalidInput(`${label}.credentialHash must be a sha256 digest.`);
  }
  assertUuid(value.namespaceId, `${label}.namespaceId`);
  if (!Array.isArray(value.permissions) || value.permissions.length === 0) {
    invalidInput(`${label}.permissions must be a non-empty array.`);
  }
  const permissions = value.permissions.map((permission) => {
    if (typeof permission !== "string" || !PERMISSIONS.has(permission as ComputePermission)) {
      invalidInput(`${label}.permissions contains an invalid permission.`);
    }
    return permission as ComputePermission;
  });
  if (typeof value.principalId !== "string" || value.principalId.length === 0) {
    invalidInput(`${label}.principalId must be a non-empty string.`);
  }
  return {
    credentialHash: value.credentialHash as ComputeAccessEntry["credentialHash"],
    namespaceId: value.namespaceId,
    permissions: [...new Set(permissions)],
    principalId: value.principalId,
  };
}

export async function loadComputeAccessFile(path: string): Promise<ComputeAccessEntry[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ComputeError("INVALID_INPUT", "Compute access file is not valid JSON.");
  }
  if (!Array.isArray(value)) invalidInput("Compute access file must contain an array.");
  return value.map(parseAccessEntry);
}
