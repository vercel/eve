import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { decodeWireValue } from "#compute/codec.js";
import { ComputeError } from "#compute/errors.js";
import { NO_COMPUTE_FAILPOINTS, type ComputeFailpoints } from "#compute/failpoints.js";
import { hashRequest } from "#compute/identity.js";
import { DEFAULT_COMPUTE_LIMITS, type ComputeLimits } from "#compute/limits.js";
import { requireManifestDefinition } from "#compute/manifest.js";
import type {
  CellView,
  EventRecord,
  MessageReceipt,
  NamespaceView,
  SendRequest,
} from "#compute/protocol.js";
import { lockNamespaceUsage, persistPayloads } from "#compute/storage/payloads.js";
import { lockNamespace, readReadyDeployment } from "#compute/storage/namespaces.js";
import type { ComputeQueryExecutor, ComputeStorage } from "#compute/storage/types.js";
import { runComputeTransaction } from "#compute/storage/retry.js";
import {
  assertDefinitionId,
  assertLocalKey,
  assertUuid,
  assertVersionedValue,
  toCounter,
} from "#compute/validation.js";

export interface AdmitMessageInput {
  failpoints?: ComputeFailpoints;
  limits?: ComputeLimits;
  namespaceId: string;
  principalId: string;
  request: SendRequest;
}

interface CellRow {
  adopted_epoch: string;
  cell_id: string;
  definition_id: string;
  deployment_digest: string;
  kind: "cell" | "resumable_task";
  next_message_seq: string;
  processed_seq: string;
  status: "active" | "quarantined" | "terminal";
}

interface MessageRow {
  cell_id: string;
  message_id: string;
  request_hash: Uint8Array;
  sequence: string;
  status: MessageReceipt["status"];
}

function assertMessageSize(request: SendRequest, limits: ComputeLimits): void {
  const bytes = Buffer.byteLength(request.message.value.data, "utf8");
  if (bytes > limits.maxMessageBytes) {
    throw new ComputeError(
      "PAYLOAD_TOO_LARGE",
      `Cell message exceeds the configured ${limits.maxMessageBytes}-byte limit.`,
    );
  }
}

async function selectCell(
  transaction: ComputeQueryExecutor,
  namespaceId: string,
  definition: string,
  key: string,
): Promise<CellRow | undefined> {
  const result = await transaction.query<CellRow>(
    "SELECT adopted_epoch, cell_id, definition_id, deployment_digest, kind, " +
      "next_message_seq, processed_seq, status " +
      "FROM compute.cells WHERE namespace_id = $1 AND definition_id = $2 AND cell_key = $3 " +
      "FOR UPDATE",
    [namespaceId, definition, key],
  );
  return result.rows[0];
}

async function findExistingMessage(
  transaction: ComputeQueryExecutor,
  namespaceId: string,
  cellId: string,
  deliveryKey: string,
): Promise<MessageRow | undefined> {
  const result = await transaction.query<MessageRow>(
    "SELECT cell_id, message_id, request_hash, sequence, status FROM compute.messages " +
      "WHERE namespace_id = $1 AND cell_id = $2 AND delivery_key = $3",
    [namespaceId, cellId, deliveryKey],
  );
  return result.rows[0];
}

function toReceipt(row: MessageRow): MessageReceipt {
  return {
    cellId: row.cell_id,
    messageId: row.message_id,
    sequence: toCounter(row.sequence),
    status: row.status,
  };
}

export async function admitMessage(
  storage: ComputeStorage,
  input: AdmitMessageInput,
): Promise<MessageReceipt> {
  assertUuid(input.namespaceId, "namespaceId");
  if (typeof input.principalId !== "string" || input.principalId.length === 0) {
    throw new ComputeError("UNAUTHORIZED", "Authenticated principal is required.");
  }
  assertDefinitionId(input.request.address.definition, "address.definition");
  assertLocalKey(input.request.address.key, "address.key");
  assertLocalKey(input.request.idempotencyKey, "idempotencyKey");
  assertVersionedValue(input.request.message, "message");

  const limits = input.limits ?? DEFAULT_COMPUTE_LIMITS;
  const failpoints = input.failpoints ?? NO_COMPUTE_FAILPOINTS;
  assertMessageSize(input.request, limits);
  decodeWireValue(input.request.message.value);
  const requestHash = hashRequest([
    "cell.send",
    input.namespaceId,
    input.request.address.definition,
    input.request.address.key,
    input.request.message.version,
    input.request.message.value.codec,
    input.request.message.value.data,
  ]);

  const receipt = await runComputeTransaction(storage, async (transaction) => {
    const namespace = await lockNamespace(transaction, input.namespaceId);
    let cell = await selectCell(
      transaction,
      input.namespaceId,
      input.request.address.definition,
      input.request.address.key,
    );
    let createdCell = false;

    if (cell === undefined) {
      if (namespace.admissionMode !== "open") {
        throw new ComputeError(
          "DEPLOYMENT_UNAVAILABLE",
          "Namespace is not accepting external messages.",
        );
      }
      const manifest = await readReadyDeployment(transaction, namespace);
      const definition = requireManifestDefinition(
        manifest,
        input.request.address.definition,
        "cell",
      );
      if (definition.inputVersion !== input.request.message.version) {
        throw new ComputeError(
          "MIGRATION_REQUIRED",
          "Message version does not match the active cell definition.",
        );
      }
      const cellId = randomUUID();
      const inserted = await transaction.query<{ cell_id: string }>(
        "INSERT INTO compute.cells(" +
          "namespace_id, cell_id, kind, definition_id, cell_key, deployment_digest, " +
          "adopted_epoch" +
          ") VALUES ($1, $2, 'cell', $3, $4, $5, $6) " +
          "ON CONFLICT (namespace_id, definition_id, cell_key) DO NOTHING " +
          "RETURNING cell_id",
        [
          input.namespaceId,
          cellId,
          input.request.address.definition,
          input.request.address.key,
          namespace.desiredDeployment,
          namespace.deploymentEpoch,
        ],
      );
      createdCell = inserted.rowCount === 1;
      cell = await selectCell(
        transaction,
        input.namespaceId,
        input.request.address.definition,
        input.request.address.key,
      );
      if (cell === undefined) {
        throw new ComputeError("INTERNAL", "Cell creation did not produce a durable row.");
      }
    }

    const existing = await findExistingMessage(
      transaction,
      input.namespaceId,
      cell.cell_id,
      input.request.idempotencyKey,
    );
    if (existing !== undefined) {
      if (!Buffer.from(existing.request_hash).equals(requestHash)) {
        throw new ComputeError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with different message content.",
        );
      }
      return toReceipt(existing);
    }

    if (namespace.admissionMode !== "open") {
      throw new ComputeError(
        "DEPLOYMENT_UNAVAILABLE",
        "Namespace is not accepting external messages.",
      );
    }
    if (cell.status === "terminal") {
      throw new ComputeError("REVISION_CONFLICT", "Terminal cell rejects new messages.");
    }
    if (
      namespace.desiredDeployment === null ||
      cell.deployment_digest !== namespace.desiredDeployment ||
      BigInt(cell.adopted_epoch) !== namespace.deploymentEpoch
    ) {
      throw new ComputeError("MIGRATION_REQUIRED", "Cell must adopt the active deployment.");
    }
    const manifest = await readReadyDeployment(transaction, namespace);
    const definition = requireManifestDefinition(
      manifest,
      input.request.address.definition,
      "cell",
    );
    if (definition.inputVersion !== input.request.message.version) {
      throw new ComputeError(
        "MIGRATION_REQUIRED",
        "Message version does not match the active cell definition.",
      );
    }

    const unprocessed = BigInt(cell.next_message_seq) - BigInt(cell.processed_seq) - 1n;
    if (unprocessed >= BigInt(limits.maxUnprocessedMessages)) {
      throw new ComputeError("QUOTA_EXCEEDED", "Cell message backlog limit was reached.");
    }

    const usage = await lockNamespaceUsage(transaction, input.namespaceId, namespace.quotaBytes);
    const [payloadId] = await persistPayloads(
      transaction,
      usage,
      [input.request.message.value],
      1 + (createdCell ? 1 : 0),
      limits.maxPayloadBytes,
    );
    if (payloadId === undefined) {
      throw new ComputeError("INTERNAL", "Message payload was not persisted.");
    }

    const messageId = randomUUID();
    const sequence = BigInt(cell.next_message_seq);
    await transaction.query(
      "INSERT INTO compute.messages(" +
        "namespace_id, cell_id, message_id, sequence, delivery_key, request_hash, origin, " +
        "original_ref, payload_ref, message_version" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9)",
      [
        input.namespaceId,
        cell.cell_id,
        messageId,
        sequence,
        input.request.idempotencyKey,
        requestHash,
        JSON.stringify({ kind: "external", principalId: input.principalId }),
        payloadId,
        input.request.message.version,
      ],
    );
    await transaction.query(
      "UPDATE compute.cells SET next_message_seq = next_message_seq + 1, " +
        "ready_at = CASE WHEN ready_at IS NULL OR ready_at > clock_timestamp() " +
        "THEN clock_timestamp() ELSE ready_at END " +
        "WHERE namespace_id = $1 AND cell_id = $2",
      [input.namespaceId, cell.cell_id],
    );
    await failpoints.hit("admission.before_commit");
    return {
      cellId: cell.cell_id,
      messageId,
      sequence: toCounter(sequence),
      status: "pending" as const,
    };
  });

  await failpoints.hit("admission.after_commit");
  return receipt;
}

export async function readMessageReceipt(
  storage: ComputeQueryExecutor,
  namespaceId: string,
  messageId: string,
): Promise<MessageReceipt> {
  assertUuid(namespaceId, "namespaceId");
  assertUuid(messageId, "messageId");
  const result = await storage.query<MessageRow>(
    "SELECT cell_id, message_id, request_hash, sequence, status FROM compute.messages " +
      "WHERE namespace_id = $1 AND message_id = $2",
    [namespaceId, messageId],
  );
  const message = result.rows[0];
  if (message === undefined) {
    throw new ComputeError("NOT_FOUND", "Compute message was not found.");
  }
  return toReceipt(message);
}

export async function readCellView(
  storage: ComputeQueryExecutor,
  namespaceId: string,
  cellId: string,
): Promise<CellView> {
  assertUuid(namespaceId, "namespaceId");
  assertUuid(cellId, "cellId");
  const result = await storage.query<{
    cell_id: string;
    codec: "eve-value-v1" | null;
    deployment_digest: CellView["deployment"];
    revision: string;
    state_body: Uint8Array | null;
    state_version: number;
    status: CellView["status"];
  }>(
    "SELECT c.cell_id, c.deployment_digest, c.revision, c.state_version, c.status, " +
      "p.codec, p.body AS state_body FROM compute.cells c " +
      "LEFT JOIN compute.payloads p ON p.namespace_id = c.namespace_id " +
      "AND p.payload_id = c.state_ref " +
      "WHERE c.namespace_id = $1 AND c.cell_id = $2",
    [namespaceId, cellId],
  );
  const cell = result.rows[0];
  if (cell === undefined) {
    throw new ComputeError("NOT_FOUND", "Compute cell was not found.");
  }
  return {
    cellId: cell.cell_id,
    status: cell.status,
    revision: toCounter(cell.revision),
    deployment: cell.deployment_digest,
    state:
      cell.state_body === null || cell.codec === null
        ? null
        : {
            version: cell.state_version,
            value: {
              codec: cell.codec,
              data: Buffer.from(cell.state_body).toString("utf8"),
            },
          },
  };
}

export async function readCellEvents(
  storage: ComputeQueryExecutor,
  namespaceId: string,
  cellId: string,
  after: bigint,
  limit: number,
): Promise<EventRecord[]> {
  assertUuid(namespaceId, "namespaceId");
  assertUuid(cellId, "cellId");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ComputeError("INVALID_INPUT", "Event limit must be between 1 and 1000.");
  }
  const cell = await storage.query<{ exists: boolean }>(
    "SELECT EXISTS(" +
      "SELECT 1 FROM compute.cells WHERE namespace_id = $1 AND cell_id = $2" +
      ") AS exists",
    [namespaceId, cellId],
  );
  if (cell.rows[0]?.exists !== true) {
    throw new ComputeError("NOT_FOUND", "Compute cell was not found.");
  }
  const result = await storage.query<{
    append_key: string;
    body: Uint8Array;
    codec: "eve-value-v1";
    event_id: string;
    sequence: string;
    source_attempt_id: string | null;
    source_operation_id: string;
  }>(
    "SELECT e.append_key, e.event_id, e.sequence, e.source_operation_id, " +
      "e.source_attempt_id, p.codec, p.body FROM compute.events e " +
      "JOIN compute.payloads p ON p.namespace_id = e.namespace_id " +
      "AND p.payload_id = e.payload_ref " +
      "WHERE e.namespace_id = $1 AND e.cell_id = $2 AND e.sequence > $3 " +
      "ORDER BY e.sequence LIMIT $4",
    [namespaceId, cellId, after, limit],
  );
  return result.rows.map((event) => ({
    id: event.event_id,
    sequence: toCounter(event.sequence),
    value: {
      codec: event.codec,
      data: Buffer.from(event.body).toString("utf8"),
    },
    source: {
      operationId: event.source_operation_id,
      attemptId: event.source_attempt_id,
    },
  }));
}

export async function readNamespaceView(
  storage: ComputeQueryExecutor,
  namespaceId: string,
): Promise<NamespaceView> {
  assertUuid(namespaceId, "namespaceId");
  const result = await storage.query<{
    admission_mode: NamespaceView["admissionMode"];
    deployment_epoch: string;
    desired_deployment: NamespaceView["desiredDeployment"];
    namespace_id: string;
    quota_bytes: string;
    used_bytes: string;
  }>(
    "SELECT n.namespace_id, n.deployment_epoch, n.desired_deployment, " +
      "n.admission_mode, n.quota_bytes, u.used_bytes " +
      "FROM compute.namespaces n JOIN compute.namespace_usage u " +
      "ON u.namespace_id = n.namespace_id WHERE n.namespace_id = $1",
    [namespaceId],
  );
  const namespace = result.rows[0];
  if (namespace === undefined) {
    throw new ComputeError("NOT_FOUND", "Compute namespace was not found.");
  }
  return {
    namespaceId: namespace.namespace_id,
    deploymentEpoch: toCounter(namespace.deployment_epoch),
    admissionMode: namespace.admission_mode,
    desiredDeployment: namespace.desired_deployment,
    usedBytes: toCounter(namespace.used_bytes),
    quotaBytes: toCounter(namespace.quota_bytes),
  };
}
