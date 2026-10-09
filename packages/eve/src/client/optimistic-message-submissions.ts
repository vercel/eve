import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { EveAgentEventLog } from "#client/eve-agent-projection.js";
import type { PendingMessageSubmission } from "#client/eve-agent-store-state.js";
import { createSubmissionId, summarizeUserContent } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";

interface ReconciledSubmissions {
  readonly alreadyProjected: boolean;
  readonly event: Extract<SessionStreamEvent, { readonly type: "delivery.consumed" }>;
  readonly ids: readonly string[];
}

/** Owns optimistic message projection and server-delivery reconciliation. */
export class OptimisticMessageSubmissions {
  readonly #optimistic: boolean;
  readonly #projections: readonly EveAgentEventLog[];
  #pending: readonly PendingMessageSubmission[] = [];

  constructor(projections: readonly EveAgentEventLog[], optimistic: boolean) {
    this.#projections = projections;
    this.#optimistic = optimistic;
  }

  reset(): void {
    this.#pending = [];
  }

  submit(input: SendTurnPayload, eventStartIndex: number, turnId?: string): string | undefined {
    if (input.message === undefined) return undefined;
    const pending = {
      createdAt: Date.now(),
      eventStartIndex,
      id: createSubmissionId(),
      message: summarizeUserContent(input.message),
      turnId,
      requiresDeliveryId: true,
    };
    this.#pending = [...this.#pending, pending];
    if (this.#optimistic) {
      for (const projection of this.#projections) {
        projection.append({
          data: {
            createdAt: pending.createdAt,
            message: pending.message,
            submissionId: pending.id,
            turnId,
          },
          type: "client.message.submitted",
        });
      }
    }
    return pending.id;
  }

  /** Re-echoes a submission whose payload `prepareSend` replaced, keeping its place in the stream. */
  resubmit(submissionId: string | undefined, input: SendTurnPayload): string | undefined {
    const pending = this.#pending.find((candidate) => candidate.id === submissionId);
    const message = input.message === undefined ? undefined : summarizeUserContent(input.message);
    if (pending?.message === message) return submissionId;
    if (pending !== undefined) this.#withdraw([pending.id]);
    return this.submit(input, pending?.eventStartIndex ?? 0, pending?.turnId);
  }

  apply(event: SessionStreamEvent): ReconciledSubmissions | undefined {
    if (!isConsumedMessage(event)) {
      for (const projection of this.#projections) projection.append(event);
      return undefined;
    }
    const matching = this.#matching(event);
    if (matching.length === 0) {
      for (const projection of this.#projections) projection.append(event);
      return undefined;
    }
    return this.#reconcile(matching, event, false);
  }

  correlate(
    submissionId: string | undefined,
    deliveryId: string | undefined,
    events: readonly SessionStreamEvent[],
  ): ReconciledSubmissions | undefined {
    if (submissionId === undefined) return undefined;
    this.#pending = this.#pending.map((pending) =>
      pending.id === submissionId
        ? { ...pending, deliveryId, requiresDeliveryId: deliveryId !== undefined }
        : pending,
    );
    const pending = this.#pending.find((candidate) => candidate.id === submissionId);
    if (pending === undefined) return undefined;
    for (const event of events.slice(pending.eventStartIndex)) {
      if (!isConsumedMessage(event)) continue;
      const matching = this.#matching(event);
      if (matching.some((candidate) => candidate.id === submissionId)) {
        return this.#reconcile(matching, event, true);
      }
    }
    return undefined;
  }

  fail(error: Error, submissionId?: string): void {
    const pending =
      submissionId === undefined
        ? this.#pending[0]
        : this.#pending.find((candidate) => candidate.id === submissionId);
    if (pending === undefined) return;
    this.#pending = this.#pending.filter((candidate) => candidate.id !== pending.id);
    for (const projection of this.#projections) {
      projection.replace(
        (event) =>
          event.type === "client.message.submitted" && event.data.submissionId === pending.id,
        {
          data: {
            createdAt: pending.createdAt,
            error: { message: error.message },
            message: pending.message,
            submissionId: pending.id,
            turnId: pending.turnId,
          },
          type: "client.message.failed",
        },
      );
    }
  }

  failAll(error: Error): void {
    for (const pending of this.#pending) this.fail(error, pending.id);
  }

  #matching(event: ConsumedMessage) {
    return this.#pending.filter((pending) =>
      pending.deliveryId === undefined
        ? !pending.requiresDeliveryId
        : event.data.deliveryId === pending.deliveryId,
    );
  }

  #reconcile(
    submissions: readonly PendingMessageSubmission[],
    event: ConsumedMessage,
    alreadyProjected: boolean,
  ): ReconciledSubmissions {
    const ids = submissions.map((pending) => pending.id);
    this.#withdraw(ids);
    if (!alreadyProjected) for (const projection of this.#projections) projection.append(event);
    return { alreadyProjected, event, ids };
  }

  #withdraw(ids: readonly string[]): void {
    const idSet = new Set(ids);
    this.#pending = this.#pending.filter((pending) => !idSet.has(pending.id));
    for (const projection of this.#projections) {
      projection.remove(
        (candidate) =>
          candidate.type === "client.message.submitted" && idSet.has(candidate.data.submissionId),
      );
    }
  }
}

type ConsumedMessage = Extract<SessionStreamEvent, { readonly type: "delivery.consumed" }>;

/** A message a person sent, as its turn consumed it: an answer or context sends none. */
function isConsumedMessage(event: SessionStreamEvent): event is ConsumedMessage {
  return event.type === "delivery.consumed" && event.data.parts.length > 0;
}
