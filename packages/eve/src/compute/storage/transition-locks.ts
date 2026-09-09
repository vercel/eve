import { Buffer } from "node:buffer";

import type {
  CellCommitCommand,
  CellCommitResult,
  PreparedCellTransition,
} from "#compute/cells/types.js";
import type {
  NormalizedCellTransition,
  NormalizedTimerRequest,
} from "#compute/cells/transition.js";
import { ComputeError } from "#compute/errors.js";
import type { ComputeDeploymentManifest } from "#compute/manifest.js";
import { requireManifestDefinition } from "#compute/manifest.js";
import type { LockedNamespace } from "#compute/storage/namespaces.js";
import type { ComputeQueryExecutor } from "#compute/storage/types.js";
import { assertDigest, assertUuid, parseCounter } from "#compute/validation.js";

export interface LockedCellRow {
  adopted_epoch: string;
  assignment_id: string | null;
  cell_id: string;
  definition_id: string;
  deployment_digest: string;
  generation: string;
  lease_epoch: string;
  lease_valid: boolean;
  next_event_seq: string;
  owner_id: string | null;
  processed_seq: string;
  revision: string;
  status: "active" | "quarantined" | "terminal";
}

export interface ExistingCommandRow {
  assignment_id: string;
  command_sequence: string;
  request_hash: Uint8Array;
  request_id: string;
  response: unknown;
}

export interface TimerState {
  generation: bigint;
  request: NormalizedTimerRequest;
}

export function validateCommitInput(
  prepared: PreparedCellTransition,
  command: CellCommitCommand,
): void {
  assertUuid(prepared.namespaceId, "namespaceId");
  assertUuid(prepared.messageId, "messageId");
  assertUuid(prepared.token.resourceId, "token.resourceId");
  assertUuid(prepared.token.assignmentId, "token.assignmentId");
  assertUuid(prepared.token.ownerId, "token.ownerId");
  assertUuid(command.requestId, "requestId");
  assertDigest(prepared.token.deployment, "token.deployment");
  parseCounter(prepared.token.epoch, "token.epoch");
  parseCounter(prepared.token.cancellationGeneration, "token.cancellationGeneration");
  parseCounter(prepared.expectedRevision, "expectedRevision");
  parseCounter(command.commandSequence, "commandSequence");
  if (command.commandSequence === "0") {
    throw new ComputeError("INVALID_INPUT", "commandSequence must start at 1.");
  }
}

export async function lockCell(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
): Promise<LockedCellRow> {
  const result = await transaction.query<LockedCellRow>(
    "SELECT adopted_epoch, assignment_id, cell_id, definition_id, deployment_digest, " +
      "generation, lease_epoch, lease_until > clock_timestamp() AS lease_valid, " +
      "next_event_seq, owner_id, processed_seq, revision, status " +
      "FROM compute.cells WHERE namespace_id = $1 AND cell_id = $2 FOR UPDATE",
    [prepared.namespaceId, prepared.token.resourceId],
  );
  const cell = result.rows[0];
  if (cell === undefined) {
    throw new ComputeError("STALE_EXECUTION", "Cell assignment resource no longer exists.");
  }
  return cell;
}

export async function findExistingCommand(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  command: CellCommitCommand,
): Promise<ExistingCommandRow | undefined> {
  const result = await transaction.query<ExistingCommandRow>(
    "SELECT assignment_id, command_sequence, request_hash, request_id, response " +
      "FROM compute.execution_commands WHERE namespace_id = $1 " +
      "AND (request_id = $2 OR (assignment_id = $3 AND command_sequence = $4)) " +
      "FOR UPDATE",
    [
      prepared.namespaceId,
      command.requestId,
      prepared.token.assignmentId,
      parseCounter(command.commandSequence, "commandSequence"),
    ],
  );
  if (result.rows.length > 1) {
    throw new ComputeError(
      "IDEMPOTENCY_CONFLICT",
      "Execution command identifiers refer to different recorded commands.",
    );
  }
  return result.rows[0];
}

export function matchesRecordedCommand(
  existing: ExistingCommandRow,
  prepared: PreparedCellTransition,
  command: CellCommitCommand,
  requestHash: Uint8Array,
): boolean {
  return (
    existing.request_id === command.requestId &&
    existing.assignment_id === prepared.token.assignmentId &&
    BigInt(existing.command_sequence) ===
      parseCounter(command.commandSequence, "commandSequence") &&
    Buffer.from(existing.request_hash).equals(requestHash)
  );
}

export function parseRecordedResponse(value: unknown): CellCommitResult {
  if (
    value === null ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "succeeded" ||
    !("value" in value) ||
    value.value === null ||
    typeof value.value !== "object"
  ) {
    throw new ComputeError("INTERNAL", "Recorded transition response is invalid.");
  }
  const response = value.value as Partial<CellCommitResult>;
  if (
    (response.control !== "continue" && response.control !== "release") ||
    typeof response.revision !== "string"
  ) {
    throw new ComputeError("INTERNAL", "Recorded transition response is invalid.");
  }
  parseCounter(response.revision, "recorded revision");
  return { control: response.control, revision: response.revision };
}

export async function assertCommandSequence(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  command: CellCommitCommand,
): Promise<void> {
  const result = await transaction.query<{ last_sequence: string }>(
    "SELECT COALESCE(max(command_sequence), 0)::text AS last_sequence " +
      "FROM compute.execution_commands WHERE namespace_id = $1 AND assignment_id = $2",
    [prepared.namespaceId, prepared.token.assignmentId],
  );
  const expected = BigInt(result.rows[0]?.last_sequence ?? "0") + 1n;
  if (parseCounter(command.commandSequence, "commandSequence") !== expected) {
    throw new ComputeError(
      "REVISION_CONFLICT",
      `Expected command sequence ${expected.toString()}.`,
    );
  }
}

export function assertLiveAssignment(
  cell: LockedCellRow,
  prepared: PreparedCellTransition,
  namespace: LockedNamespace,
): void {
  const token = prepared.token;
  if (
    namespace.admissionMode === "frozen" ||
    cell.status !== "active" ||
    cell.owner_id !== token.ownerId ||
    cell.assignment_id !== token.assignmentId ||
    BigInt(cell.lease_epoch) !== parseCounter(token.epoch, "token.epoch") ||
    BigInt(cell.generation) !==
      parseCounter(token.cancellationGeneration, "token.cancellationGeneration") ||
    cell.deployment_digest !== token.deployment ||
    !cell.lease_valid ||
    BigInt(cell.revision) !== parseCounter(prepared.expectedRevision, "expectedRevision") ||
    BigInt(cell.adopted_epoch) !== namespace.deploymentEpoch ||
    namespace.desiredDeployment !== token.deployment
  ) {
    throw new ComputeError("STALE_EXECUTION", "Cell assignment is no longer valid.");
  }
}

export async function assertHeadMessage(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  cell: LockedCellRow,
): Promise<void> {
  const result = await transaction.query<{
    message_id: string;
    sequence: string;
    status: string;
  }>(
    "SELECT message_id, sequence, status FROM compute.messages " +
      "WHERE namespace_id = $1 AND cell_id = $2 AND sequence = $3 FOR UPDATE",
    [prepared.namespaceId, cell.cell_id, BigInt(cell.processed_seq) + 1n],
  );
  const message = result.rows[0];
  if (
    message === undefined ||
    message.message_id !== prepared.messageId ||
    message.status !== "pending"
  ) {
    throw new ComputeError("STALE_EXECUTION", "Prepared message is no longer the cell head.");
  }
}

export function validateRegisteredOperations(
  transition: NormalizedCellTransition,
  manifest: ComputeDeploymentManifest,
  cellDefinitionId: string,
  namespaceId: string,
): void {
  const cellDefinition = requireManifestDefinition(manifest, cellDefinitionId, "cell");
  for (const effect of transition.effects) {
    let definition;
    try {
      definition = requireManifestDefinition(manifest, effect.definition, "effect");
    } catch {
      throw new ComputeError(
        "INVALID_INPUT",
        `Transition references unknown effect definition "${effect.definition}".`,
      );
    }
    if (definition.inputVersion !== effect.inputVersion) {
      throw new ComputeError(
        "INVALID_INPUT",
        `Transition effect "${effect.definition}" uses an inactive input version.`,
      );
    }
  }
  for (const send of transition.sends) {
    if (send.destination.namespaceId !== namespaceId) {
      throw new ComputeError(
        "INVALID_INPUT",
        "Outgoing cell messages cannot cross namespaces in v1.",
      );
    }
    let definition;
    try {
      definition = requireManifestDefinition(manifest, send.destination.definition, "cell");
    } catch {
      throw new ComputeError(
        "INVALID_INPUT",
        `Transition references unknown destination definition "${send.destination.definition}".`,
      );
    }
    if (definition.inputVersion !== send.messageVersion) {
      throw new ComputeError(
        "INVALID_INPUT",
        `Transition destination "${send.destination.definition}" uses an inactive message version.`,
      );
    }
  }
  for (const timer of transition.timers) {
    if (timer.action === "set" && timer.messageVersion !== cellDefinition.inputVersion) {
      throw new ComputeError("INVALID_INPUT", "Transition timer uses an inactive message version.");
    }
  }
}

export async function readTimerStates(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  timers: readonly NormalizedTimerRequest[],
): Promise<TimerState[]> {
  const states: TimerState[] = [];
  for (const timer of timers) {
    const result = await transaction.query<{ generation: string }>(
      "SELECT generation FROM compute.timers " +
        "WHERE namespace_id = $1 AND cell_id = $2 AND timer_key = $3 FOR UPDATE",
      [prepared.namespaceId, prepared.token.resourceId, timer.key],
    );
    states.push({
      generation: BigInt(result.rows[0]?.generation ?? "0"),
      request: timer,
    });
  }
  return states;
}
