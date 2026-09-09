import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

import { decodeWireValue } from "#compute/codec.js";
import type {
  LeaseToken,
  PreparedCellTransition,
  PrepareCellTransitionInput,
} from "#compute/cells/types.js";
import { encodeCellTransition, normalizeCellTransition } from "#compute/cells/transition.js";
import { ComputeError } from "#compute/errors.js";
import { DEFAULT_COMPUTE_LIMITS } from "#compute/limits.js";
import type {
  CellDefinition,
  DeliveryContext,
  ErrorCode,
  Failure,
  Result,
  SystemMessage,
  WireValue,
} from "#compute/protocol.js";
import {
  assertDefinitionId,
  assertDigest,
  assertExactKeys,
  assertLocalKey,
  assertRecord,
  assertUuid,
  parseCounter,
  toCounter,
} from "#compute/validation.js";
import { rejectCellHead } from "#compute/storage/transitions.js";

interface AssignmentRow {
  accepted_at: Date | string;
  adopted_epoch: string;
  assignment_id: string;
  cell_id: string;
  definition_id: string;
  deployment_digest: string;
  generation: string;
  lease_epoch: string;
  message_body: Uint8Array;
  message_codec: "eve-value-v1";
  message_id: string;
  message_version: number;
  origin: DeliveryContext["origin"];
  owner_id: string;
  revision: string;
  sequence: string;
  state_body: Uint8Array | null;
  state_codec: "eve-value-v1" | null;
  state_version: number;
}

function wire(codec: "eve-value-v1", body: Uint8Array): WireValue {
  return { codec, data: Buffer.from(body).toString("utf8") };
}

function callDefinition<T>(operation: () => T, message: string): T {
  try {
    return operation();
  } catch {
    throw new ComputeError("INVALID_INPUT", message);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const ERROR_CODES = new Set<ErrorCode>([
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_CONFLICT",
  "STALE_EXECUTION",
  "CONCURRENT_MUTATION",
  "PAYLOAD_TOO_LARGE",
  "QUOTA_EXCEEDED",
  "TRANSIENT_FAILURE",
  "EFFECT_FAILED",
  "INDETERMINATE_EFFECT",
  "MIGRATION_REQUIRED",
  "UNSUPPORTED_EXPORT",
  "DEPLOYMENT_UNAVAILABLE",
  "CANCELLED",
  "INTERNAL",
]);

function parseFailure(value: unknown, label: string): Failure {
  assertRecord(value, label);
  assertExactKeys(value, ["code", "message", "incidentId"], label);
  if (typeof value.code !== "string" || !ERROR_CODES.has(value.code as ErrorCode)) {
    throw new ComputeError("INVALID_INPUT", `${label}.code is invalid.`);
  }
  if (typeof value.message !== "string") {
    throw new ComputeError("INVALID_INPUT", `${label}.message must be a string.`);
  }
  if (value.incidentId !== undefined) assertUuid(value.incidentId, `${label}.incidentId`);
  const failure: Failure = {
    code: value.code as ErrorCode,
    message: value.message,
  };
  if (value.incidentId !== undefined) failure.incidentId = value.incidentId;
  return failure;
}

function parseResult(value: unknown, label: string): Result<unknown> {
  assertRecord(value, label);
  if (value.status === "succeeded") {
    assertExactKeys(value, ["status", "value"], label);
    return { status: "succeeded", value: value.value };
  }
  if (value.status === "failed") {
    assertExactKeys(value, ["status", "error"], label);
    return { status: "failed", error: parseFailure(value.error, `${label}.error`) };
  }
  if (value.status === "cancelled") {
    assertExactKeys(value, ["status"], label);
    return { status: "cancelled" };
  }
  throw new ComputeError("INVALID_INPUT", `${label}.status is invalid.`);
}

function parseSystemMessage(value: unknown, origin: DeliveryContext["origin"]): SystemMessage {
  assertRecord(value, "system message");
  if (origin.kind === "effect" && value.kind === "effect_result") {
    assertExactKeys(value, ["kind", "key", "effectId", "result"], "system message");
    assertLocalKey(value.key, "system message.key");
    assertUuid(value.effectId, "system message.effectId");
    if (value.effectId !== origin.effectId) {
      throw new ComputeError("INVALID_INPUT", "Effect completion identity does not match origin.");
    }
    return {
      kind: "effect_result",
      key: value.key,
      effectId: value.effectId,
      result: parseResult(value.result, "system message.result"),
    };
  }
  if (origin.kind === "child" && value.kind === "child_result") {
    assertExactKeys(value, ["kind", "key", "resumableTaskId", "result"], "system message");
    assertLocalKey(value.key, "system message.key");
    assertUuid(value.resumableTaskId, "system message.resumableTaskId");
    if (value.resumableTaskId !== origin.resumableTaskId) {
      throw new ComputeError("INVALID_INPUT", "Child completion identity does not match origin.");
    }
    return {
      kind: "child_result",
      key: value.key,
      resumableTaskId: value.resumableTaskId,
      result: parseResult(value.result, "system message.result"),
    };
  }
  throw new ComputeError(
    "INVALID_INPUT",
    "Protected completion origin does not match its message.",
  );
}

function decodeMessage<M>(
  row: AssignmentRow,
  definition: CellDefinition<unknown, M>,
): M | SystemMessage {
  const decoded = decodeWireValue(wire(row.message_codec, row.message_body));
  if (row.origin.kind === "effect" || row.origin.kind === "child") {
    return parseSystemMessage(decoded, row.origin);
  }
  if (row.message_version > definition.messageVersion) {
    throw new ComputeError("MIGRATION_REQUIRED", "Cell message uses a newer schema version.");
  }
  const migrated =
    row.message_version === definition.messageVersion
      ? decoded
      : callDefinition(
          () => definition.migrateMessage(row.message_version, decoded),
          "Cell message migration failed.",
        );
  return callDefinition(
    () => definition.messageSchema.parse(migrated),
    "Cell message validation failed.",
  );
}

function decodeState<S>(row: AssignmentRow, definition: CellDefinition<S, unknown>): S {
  if (row.state_body === null || row.state_codec === null) {
    const initial = callDefinition(() => definition.initial(), "Cell initial state failed.");
    if (isThenable(initial)) {
      throw new ComputeError("INVALID_INPUT", "Cell initial state must be synchronous.");
    }
    return callDefinition(
      () => definition.stateSchema.parse(initial),
      "Cell initial state validation failed.",
    );
  }
  if (row.state_version !== definition.stateVersion) {
    throw new ComputeError("MIGRATION_REQUIRED", "Cell state requires deployment migration.");
  }
  const decoded = decodeWireValue(wire(row.state_codec, row.state_body));
  return callDefinition(
    () => definition.stateSchema.parse(decoded),
    "Cell state validation failed.",
  );
}

function validateToken(token: LeaseToken): void {
  assertUuid(token.resourceId, "token.resourceId");
  assertUuid(token.assignmentId, "token.assignmentId");
  assertUuid(token.ownerId, "token.ownerId");
  assertDigest(token.deployment, "token.deployment");
  parseCounter(token.epoch, "token.epoch");
  parseCounter(token.cancellationGeneration, "token.cancellationGeneration");
}

export async function prepareCellTransition<S, M>(
  input: PrepareCellTransitionInput<S, M>,
): Promise<PreparedCellTransition> {
  assertUuid(input.namespaceId, "namespaceId");
  assertDefinitionId(input.definitionId, "definitionId");
  validateToken(input.token);
  const result = await input.storage.query<AssignmentRow>(
    "SELECT c.adopted_epoch, c.assignment_id, c.cell_id, c.definition_id, " +
      "c.deployment_digest, c.generation, c.lease_epoch, c.owner_id, c.revision, " +
      "m.accepted_at, m.message_id, m.message_version, m.origin, m.sequence, " +
      "mp.codec AS message_codec, mp.body AS message_body, " +
      "sp.codec AS state_codec, sp.body AS state_body, c.state_version " +
      "FROM compute.cells c " +
      "JOIN compute.messages m ON m.namespace_id = c.namespace_id " +
      "AND m.cell_id = c.cell_id AND m.sequence = c.processed_seq + 1 " +
      "AND m.status = 'pending' " +
      "JOIN compute.payloads mp ON mp.namespace_id = m.namespace_id " +
      "AND mp.payload_id = m.payload_ref " +
      "LEFT JOIN compute.payloads sp ON sp.namespace_id = c.namespace_id " +
      "AND sp.payload_id = c.state_ref " +
      "WHERE c.namespace_id = $1 AND c.cell_id = $2 AND c.status = 'active' " +
      "AND c.owner_id = $3 AND c.assignment_id = $4 AND c.lease_epoch = $5 " +
      "AND c.generation = $6 AND c.deployment_digest = $7 " +
      "AND c.lease_until > clock_timestamp()",
    [
      input.namespaceId,
      input.token.resourceId,
      input.token.ownerId,
      input.token.assignmentId,
      parseCounter(input.token.epoch, "token.epoch"),
      parseCounter(input.token.cancellationGeneration, "token.cancellationGeneration"),
      input.token.deployment,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || row.definition_id !== input.definitionId) {
    throw new ComputeError("STALE_EXECUTION", "Cell assignment is no longer valid.");
  }

  try {
    const state = decodeState(row, input.definition);
    const message = decodeMessage(row, input.definition);
    const context: DeliveryContext = {
      cellId: row.cell_id,
      deliveryId: row.message_id,
      sequence: toCounter(row.sequence),
      acceptedAt: new Date(row.accepted_at).toISOString(),
      origin: row.origin,
    };
    const started = performance.now();
    const transition = callDefinition(
      () => input.definition.receive(state, message, context),
      "Cell transition handler failed.",
    );
    if (isThenable(transition)) {
      throw new ComputeError("INVALID_INPUT", "Cell transition handler must be synchronous.");
    }
    if (performance.now() - started > (input.cpuBudgetMs ?? 50)) {
      throw new ComputeError("INVALID_INPUT", "Cell transition exceeded its CPU budget.");
    }
    if (transition === null || typeof transition !== "object" || Array.isArray(transition)) {
      throw new ComputeError("INVALID_INPUT", "Cell transition must return an object.");
    }
    const parsedState = callDefinition(
      () => input.definition.stateSchema.parse(transition.state),
      "Cell transition state validation failed.",
    );
    const encoded = encodeCellTransition({ ...transition, state: parsedState });
    normalizeCellTransition(encoded, input.limits ?? DEFAULT_COMPUTE_LIMITS);
    return {
      namespaceId: input.namespaceId,
      token: input.token,
      messageId: row.message_id,
      expectedRevision: toCounter(row.revision),
      transition: encoded,
    };
  } catch (error) {
    if (
      error instanceof ComputeError &&
      (error.code === "INVALID_INPUT" || error.code === "PAYLOAD_TOO_LARGE")
    ) {
      try {
        await rejectCellHead({
          error,
          expectedRevision: toCounter(row.revision),
          messageId: row.message_id,
          namespaceId: input.namespaceId,
          storage: input.storage,
          token: input.token,
        });
      } catch (rejectError) {
        if (rejectError instanceof ComputeError && rejectError.code === "STALE_EXECUTION") {
          throw rejectError;
        }
        throw rejectError;
      }
    }
    throw error;
  }
}
