import { randomUUID } from "node:crypto";

import type { PreparedCellTransition } from "#compute/cells/types.js";
import type { NormalizedCellTransition } from "#compute/cells/transition.js";
import { ComputeError } from "#compute/errors.js";
import { composeDeliveryKey, hashRequest } from "#compute/identity.js";
import type { ComputeDeploymentManifest } from "#compute/manifest.js";
import { requireManifestDefinition } from "#compute/manifest.js";
import type { TimerState } from "#compute/storage/transition-locks.js";
import type { ComputeQueryExecutor } from "#compute/storage/types.js";
import { parseCounter } from "#compute/validation.js";

export function transitionPayloads(
  transition: NormalizedCellTransition,
): Array<NormalizedCellTransition["state"]> {
  return [
    transition.state,
    ...transition.effects.map((effect) => effect.input),
    ...transition.sends.map((send) => send.message),
    ...transition.timers.flatMap((timer) => (timer.action === "set" ? [timer.message] : [])),
    ...transition.events.map((event) => event.value),
  ];
}

function requirePayloadId(payloadIds: readonly string[], index: number): string {
  const payloadId = payloadIds[index];
  if (payloadId === undefined) {
    throw new ComputeError("INTERNAL", "Transition payload allocation is incomplete.");
  }
  return payloadId;
}

export async function persistEffects(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  transition: NormalizedCellTransition,
  manifest: ComputeDeploymentManifest,
  payloadIds: readonly string[],
  offset: number,
): Promise<number> {
  let index = offset;
  for (const effect of transition.effects) {
    const definition = requireManifestDefinition(manifest, effect.definition, "effect");
    if (definition.retry === null || definition.outputVersion === null) {
      throw new ComputeError("INTERNAL", "Effect manifest entry is incomplete.");
    }
    const effectKey = composeDeliveryKey(prepared.messageId, effect.key);
    const inputHash = hashRequest([
      "effect",
      prepared.namespaceId,
      prepared.token.resourceId,
      effectKey,
      effect.definition,
      effect.inputVersion,
      effect.input.codec,
      effect.input.data,
    ]);
    const maxAttempts = definition.retry.mode === "manual" ? 1 : definition.retry.maxAttempts;
    const payloadId = requirePayloadId(payloadIds, index++);
    await transaction.query(
      "INSERT INTO compute.effects(" +
        "namespace_id, effect_id, owner_cell_id, effect_key, definition_id, " +
        "input_version, input_ref, input_hash, deployment_digest, logical_generation, " +
        "retry_mode, max_attempts, timeout_ms, deadline, target_output_version" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::integer, " +
        "clock_timestamp() + ($13::integer * interval '1 millisecond'), $14)",
      [
        prepared.namespaceId,
        randomUUID(),
        prepared.token.resourceId,
        effectKey,
        effect.definition,
        effect.inputVersion,
        payloadId,
        inputHash,
        prepared.token.deployment,
        parseCounter(prepared.token.cancellationGeneration, "token.cancellationGeneration"),
        definition.retry.mode,
        maxAttempts,
        definition.retry.timeoutMs,
        definition.outputVersion,
      ],
    );
  }
  return index;
}

export async function persistSends(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  transition: NormalizedCellTransition,
  payloadIds: readonly string[],
  offset: number,
): Promise<number> {
  let index = offset;
  for (const send of transition.sends) {
    const deliveryKey = composeDeliveryKey(prepared.messageId, send.key);
    const requestHash = hashRequest([
      "cell.send",
      prepared.namespaceId,
      send.destination.definition,
      send.destination.key,
      send.messageVersion,
      send.message.codec,
      send.message.data,
    ]);
    const payloadId = requirePayloadId(payloadIds, index++);
    await transaction.query(
      "INSERT INTO compute.outbox(" +
        "namespace_id, delivery_id, source_cell_id, delivery_key, target_definition, " +
        "target_key, message_version, payload_ref, request_hash, origin" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)",
      [
        prepared.namespaceId,
        randomUUID(),
        prepared.token.resourceId,
        deliveryKey,
        send.destination.definition,
        send.destination.key,
        send.messageVersion,
        payloadId,
        requestHash,
        JSON.stringify({
          kind: "cell",
          sourceCellId: prepared.token.resourceId,
        }),
      ],
    );
  }
  return index;
}

export async function persistTimers(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  timerStates: readonly TimerState[],
  payloadIds: readonly string[],
  offset: number,
): Promise<number> {
  let index = offset;
  for (const timer of timerStates) {
    const generation = timer.generation + 1n;
    if (timer.request.action === "cancel") {
      if (timer.generation > 0n) {
        await transaction.query(
          "UPDATE compute.timers SET generation = $4, status = 'cancelled' " +
            "WHERE namespace_id = $1 AND cell_id = $2 AND timer_key = $3",
          [prepared.namespaceId, prepared.token.resourceId, timer.request.key, generation],
        );
      }
      continue;
    }
    const payloadId = requirePayloadId(payloadIds, index++);
    if (timer.generation === 0n) {
      await transaction.query(
        "INSERT INTO compute.timers(" +
          "namespace_id, cell_id, timer_key, generation, deadline, message_version, " +
          "payload_ref, status" +
          ") VALUES ($1, $2, $3, $4, $5, $6, $7, 'armed')",
        [
          prepared.namespaceId,
          prepared.token.resourceId,
          timer.request.key,
          generation,
          timer.request.deadline,
          timer.request.messageVersion,
          payloadId,
        ],
      );
    } else {
      await transaction.query(
        "UPDATE compute.timers SET generation = $4, deadline = $5, message_version = $6, " +
          "payload_ref = $7, status = 'armed' " +
          "WHERE namespace_id = $1 AND cell_id = $2 AND timer_key = $3",
        [
          prepared.namespaceId,
          prepared.token.resourceId,
          timer.request.key,
          generation,
          timer.request.deadline,
          timer.request.messageVersion,
          payloadId,
        ],
      );
    }
  }
  return index;
}

export async function persistEvents(
  transaction: ComputeQueryExecutor,
  prepared: PreparedCellTransition,
  transition: NormalizedCellTransition,
  payloadIds: readonly string[],
  offset: number,
  firstSequence: bigint,
): Promise<number> {
  let index = offset;
  let sequence = firstSequence;
  for (const event of transition.events) {
    const appendKey = composeDeliveryKey(prepared.messageId, event.key);
    const requestHash = hashRequest([
      "cell.event",
      prepared.namespaceId,
      prepared.token.resourceId,
      appendKey,
      event.value.codec,
      event.value.data,
    ]);
    const payloadId = requirePayloadId(payloadIds, index++);
    await transaction.query(
      "INSERT INTO compute.events(" +
        "namespace_id, cell_id, sequence, event_id, append_key, payload_ref, request_hash, " +
        "source_operation_id, source_attempt_id" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)",
      [
        prepared.namespaceId,
        prepared.token.resourceId,
        sequence++,
        randomUUID(),
        appendKey,
        payloadId,
        requestHash,
        prepared.messageId,
      ],
    );
  }
  return index;
}
