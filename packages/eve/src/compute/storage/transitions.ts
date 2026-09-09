import type {
  CellCommitCommand,
  CellCommitResult,
  LeaseToken,
  PreparedCellTransition,
} from "#compute/cells/types.js";
import { normalizeCellTransition } from "#compute/cells/transition.js";
import { ComputeError } from "#compute/errors.js";
import { NO_COMPUTE_FAILPOINTS, type ComputeFailpoints } from "#compute/failpoints.js";
import { hashRequest } from "#compute/identity.js";
import { DEFAULT_COMPUTE_LIMITS, type ComputeLimits } from "#compute/limits.js";
import { requireManifestDefinition } from "#compute/manifest.js";
import type { Counter } from "#compute/protocol.js";
import { lockNamespace, readReadyDeployment } from "#compute/storage/namespaces.js";
import { lockNamespaceUsage, persistPayloads } from "#compute/storage/payloads.js";
import { runComputeTransaction } from "#compute/storage/retry.js";
import {
  assertCommandSequence,
  assertHeadMessage,
  assertLiveAssignment,
  findExistingCommand,
  lockCell,
  matchesRecordedCommand,
  parseRecordedResponse,
  readTimerStates,
  validateCommitInput,
  validateRegisteredOperations,
} from "#compute/storage/transition-locks.js";
import {
  persistEffects,
  persistEvents,
  persistSends,
  persistTimers,
  transitionPayloads,
} from "#compute/storage/transition-writes.js";
import type { ComputeStorage } from "#compute/storage/types.js";
import { assertDigest, assertUuid, parseCounter, toCounter } from "#compute/validation.js";

export interface CommitCellTransitionInput {
  command: CellCommitCommand;
  failpoints?: ComputeFailpoints;
  limits?: ComputeLimits;
  prepared: PreparedCellTransition;
  storage: ComputeStorage;
}

export interface RejectCellHeadInput {
  error: ComputeError;
  expectedRevision: Counter;
  messageId: string;
  namespaceId: string;
  storage: ComputeStorage;
  token: LeaseToken;
}

function commandResponse(result: CellCommitResult): unknown {
  return {
    status: "succeeded",
    value: {
      control: result.control,
      revision: result.revision,
    },
  };
}

export async function commitCellTransition(
  input: CommitCellTransitionInput,
): Promise<CellCommitResult> {
  validateCommitInput(input.prepared, input.command);
  const limits = input.limits ?? DEFAULT_COMPUTE_LIMITS;
  const requestHash = hashRequest([
    "commit_transition",
    input.prepared.namespaceId,
    input.prepared.token.resourceId,
    input.prepared.token.assignmentId,
    input.prepared.token.ownerId,
    input.prepared.token.epoch,
    input.prepared.token.cancellationGeneration,
    input.prepared.token.deployment,
    input.command.commandSequence,
    input.prepared.expectedRevision,
    input.prepared.messageId,
    input.prepared.transition.codec,
    input.prepared.transition.data,
  ]);
  const failpoints = input.failpoints ?? NO_COMPUTE_FAILPOINTS;

  const result = await runComputeTransaction(input.storage, async (transaction) => {
    const namespace = await lockNamespace(transaction, input.prepared.namespaceId);
    const cell = await lockCell(transaction, input.prepared);
    const existing = await findExistingCommand(transaction, input.prepared, input.command);
    if (existing !== undefined) {
      if (!matchesRecordedCommand(existing, input.prepared, input.command, requestHash)) {
        throw new ComputeError(
          "IDEMPOTENCY_CONFLICT",
          "Execution command identity was reused with different content.",
        );
      }
      return parseRecordedResponse(existing.response);
    }

    const transition = normalizeCellTransition(input.prepared.transition, limits);
    await assertCommandSequence(transaction, input.prepared, input.command);
    assertLiveAssignment(cell, input.prepared, namespace);
    await assertHeadMessage(transaction, input.prepared, cell);
    const manifest = await readReadyDeployment(transaction, namespace);
    validateRegisteredOperations(
      transition,
      manifest,
      cell.definition_id,
      input.prepared.namespaceId,
    );

    const usage = await lockNamespaceUsage(
      transaction,
      input.prepared.namespaceId,
      namespace.quotaBytes,
    );
    const timerStates = await readTimerStates(transaction, input.prepared, transition.timers);
    const timerRows = timerStates.filter(
      (timer) => timer.request.action === "set" && timer.generation === 0n,
    ).length;
    const durableRows =
      1 +
      transition.effects.length +
      transition.sends.length +
      transition.events.length +
      timerRows;
    const payloadIds = await persistPayloads(
      transaction,
      usage,
      transitionPayloads(transition),
      durableRows,
      limits.maxPayloadBytes,
    );

    let payloadIndex = 1;
    payloadIndex = await persistEffects(
      transaction,
      input.prepared,
      transition,
      manifest,
      payloadIds,
      payloadIndex,
    );
    payloadIndex = await persistSends(
      transaction,
      input.prepared,
      transition,
      payloadIds,
      payloadIndex,
    );
    payloadIndex = await persistTimers(
      transaction,
      input.prepared,
      timerStates,
      payloadIds,
      payloadIndex,
    );
    payloadIndex = await persistEvents(
      transaction,
      input.prepared,
      transition,
      payloadIds,
      payloadIndex,
      BigInt(cell.next_event_seq),
    );
    if (payloadIndex !== payloadIds.length) {
      throw new ComputeError("INTERNAL", "Transition payload allocation did not settle.");
    }

    await transaction.query(
      "UPDATE compute.messages SET status = 'applied', applied_at = clock_timestamp() " +
        "WHERE namespace_id = $1 AND message_id = $2",
      [input.prepared.namespaceId, input.prepared.messageId],
    );
    if (transition.terminal) {
      await transaction.query(
        "UPDATE compute.messages SET status = 'cancelled' " +
          "WHERE namespace_id = $1 AND cell_id = $2 AND status = 'pending' " +
          "AND message_id <> $3",
        [input.prepared.namespaceId, input.prepared.token.resourceId, input.prepared.messageId],
      );
    }
    const remaining = transition.terminal
      ? "0"
      : ((
          await transaction.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM compute.messages " +
              "WHERE namespace_id = $1 AND cell_id = $2 AND status = 'pending'",
            [input.prepared.namespaceId, input.prepared.token.resourceId],
          )
        ).rows[0]?.count ?? "0");
    const nextRevision = parseCounter(input.prepared.expectedRevision, "expectedRevision") + 1n;
    const stateVersion = requireManifestDefinition(
      manifest,
      cell.definition_id,
      "cell",
    ).stateVersion;
    if (stateVersion === null) {
      throw new ComputeError("INTERNAL", "Cell manifest state version is missing.");
    }
    const statePayloadId = payloadIds[0];
    if (statePayloadId === undefined) {
      throw new ComputeError("INTERNAL", "Transition state payload is missing.");
    }
    await transaction.query(
      "UPDATE compute.cells SET state_ref = $3, state_version = $4, revision = $5, " +
        "processed_seq = processed_seq + 1, next_event_seq = next_event_seq + $6, " +
        "status = CASE WHEN $7 THEN 'terminal' ELSE status END, " +
        "terminal_at = CASE WHEN $7 THEN clock_timestamp() ELSE terminal_at END, " +
        "owner_id = CASE WHEN $7 THEN NULL ELSE owner_id END, " +
        "assignment_id = CASE WHEN $7 THEN NULL ELSE assignment_id END, " +
        "lease_until = CASE WHEN $7 THEN NULL ELSE lease_until END, " +
        "ready_at = CASE WHEN $7 THEN NULL WHEN $8::bigint > 0 THEN clock_timestamp() ELSE NULL END " +
        "WHERE namespace_id = $1 AND cell_id = $2",
      [
        input.prepared.namespaceId,
        input.prepared.token.resourceId,
        statePayloadId,
        stateVersion,
        nextRevision,
        transition.events.length,
        transition.terminal,
        remaining,
      ],
    );
    const commitResult: CellCommitResult = {
      control: transition.terminal ? "release" : "continue",
      revision: toCounter(nextRevision),
    };
    await transaction.query(
      "INSERT INTO compute.execution_commands(" +
        "namespace_id, assignment_id, command_sequence, request_id, request_hash, " +
        "resource_id, response" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        input.prepared.namespaceId,
        input.prepared.token.assignmentId,
        parseCounter(input.command.commandSequence, "commandSequence"),
        input.command.requestId,
        requestHash,
        input.prepared.token.resourceId,
        JSON.stringify(commandResponse(commitResult)),
      ],
    );
    await failpoints.hit("transition.before_commit");
    return commitResult;
  });

  await failpoints.hit("transition.after_commit");
  return result;
}

export async function rejectCellHead(input: RejectCellHeadInput): Promise<void> {
  assertUuid(input.namespaceId, "namespaceId");
  assertUuid(input.messageId, "messageId");
  assertUuid(input.token.resourceId, "token.resourceId");
  assertUuid(input.token.assignmentId, "token.assignmentId");
  assertUuid(input.token.ownerId, "token.ownerId");
  assertDigest(input.token.deployment, "token.deployment");
  parseCounter(input.expectedRevision, "expectedRevision");

  await runComputeTransaction(input.storage, async (transaction) => {
    const namespace = await lockNamespace(transaction, input.namespaceId);
    const prepared: PreparedCellTransition = {
      expectedRevision: input.expectedRevision,
      messageId: input.messageId,
      namespaceId: input.namespaceId,
      token: input.token,
      transition: { codec: "eve-value-v1", data: "-1" },
    };
    const cell = await lockCell(transaction, prepared);
    assertLiveAssignment(cell, prepared, namespace);
    await assertHeadMessage(transaction, prepared, cell);
    await transaction.query(
      "UPDATE compute.messages SET status = 'rejected' " +
        "WHERE namespace_id = $1 AND message_id = $2",
      [input.namespaceId, input.messageId],
    );
    await transaction.query(
      "UPDATE compute.cells SET status = 'quarantined', revision = revision + 1, " +
        "quarantine_reason = $3::jsonb, " +
        "owner_id = NULL, assignment_id = NULL, lease_until = NULL, ready_at = NULL " +
        "WHERE namespace_id = $1 AND cell_id = $2",
      [
        input.namespaceId,
        input.token.resourceId,
        JSON.stringify({
          code: input.error.code,
          message: input.error.message,
          messageId: input.messageId,
        }),
      ],
    );
  });
}
