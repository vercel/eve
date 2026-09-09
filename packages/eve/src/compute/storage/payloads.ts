import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { ComputeError } from "#compute/errors.js";
import { sha256Hex } from "#compute/identity.js";
import { DURABLE_ROW_LOGICAL_BYTES } from "#compute/limits.js";
import type { WireValue } from "#compute/protocol.js";
import type { ComputeQueryExecutor } from "#compute/storage/types.js";

export interface NamespaceUsageLock {
  namespaceId: string;
  quotaBytes: bigint;
  usedBytes: bigint;
}

interface PersistedPayload {
  body: Uint8Array;
  contentHash: string;
  id: string;
  isNew: boolean;
  value: WireValue;
}

export async function lockNamespaceUsage(
  transaction: ComputeQueryExecutor,
  namespaceId: string,
  quotaBytes: string | bigint,
): Promise<NamespaceUsageLock> {
  const result = await transaction.query<{ used_bytes: string }>(
    "SELECT used_bytes FROM compute.namespace_usage " + "WHERE namespace_id = $1 FOR UPDATE",
    [namespaceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ComputeError("INTERNAL", "Namespace usage accounting is missing.");
  }
  return {
    namespaceId,
    quotaBytes: BigInt(quotaBytes),
    usedBytes: BigInt(row.used_bytes),
  };
}

export async function persistPayloads(
  transaction: ComputeQueryExecutor,
  usage: NamespaceUsageLock,
  values: readonly WireValue[],
  durableRowCount: number,
  maxPayloadBytes: number,
): Promise<string[]> {
  const unique = new Map<string, PersistedPayload>();
  const keys: string[] = [];

  for (const value of values) {
    const body = Buffer.from(value.data, "utf8");
    if (body.byteLength > maxPayloadBytes) {
      throw new ComputeError("PAYLOAD_TOO_LARGE", "Compute payload exceeds the configured limit.");
    }
    const contentHash = sha256Hex(body);
    const key = `${contentHash}\0${value.data}`;
    keys.push(key);
    if (unique.has(key)) continue;

    const matches = await transaction.query<{ body: Uint8Array; payload_id: string }>(
      "SELECT payload_id, body FROM compute.payloads " +
        "WHERE namespace_id = $1 AND content_hash = decode($2, 'hex') AND codec = $3",
      [usage.namespaceId, contentHash, value.codec],
    );
    const exact = matches.rows.find((row) => Buffer.from(row.body).equals(body));
    if (exact !== undefined) {
      unique.set(key, { body, contentHash, id: exact.payload_id, isNew: false, value });
      continue;
    }
    if (matches.rows.length > 0) {
      throw new ComputeError("INTERNAL", "Compute payload hash collision detected.");
    }
    unique.set(key, { body, contentHash, id: randomUUID(), isNew: true, value });
  }

  const newPayloads = [...unique.values()].filter((payload) => payload.isNew);
  const payloadBytes = newPayloads.reduce(
    (total, payload) => total + BigInt(payload.body.byteLength + DURABLE_ROW_LOGICAL_BYTES),
    0n,
  );
  const rowBytes = BigInt(durableRowCount * DURABLE_ROW_LOGICAL_BYTES);
  const charge = payloadBytes + rowBytes;
  if (usage.usedBytes + charge > usage.quotaBytes) {
    throw new ComputeError("QUOTA_EXCEEDED", "Namespace storage quota would be exceeded.");
  }

  for (const payload of newPayloads) {
    await transaction.query(
      "INSERT INTO compute.payloads(" +
        "namespace_id, payload_id, content_hash, codec, body" +
        ") VALUES ($1, $2, decode($3, 'hex'), $4, $5)",
      [usage.namespaceId, payload.id, payload.contentHash, payload.value.codec, payload.body],
    );
  }
  if (charge > 0n) {
    await transaction.query(
      "UPDATE compute.namespace_usage SET used_bytes = used_bytes + $2 " +
        "WHERE namespace_id = $1",
      [usage.namespaceId, charge],
    );
  }
  return keys.map((key) => unique.get(key)!.id);
}
