import type { EveAgentEventLog } from "#client/eve-agent-projection.js";
import type { PendingMessageSubmission } from "#client/eve-agent-store-state.js";
import { createSubmissionId, summarizeUserContent } from "#client/eve-agent-store-helpers.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { SendTurnPayload } from "#client/types.js";

interface ReconciledSubmissions {
  readonly alreadyProjected: boolean;
  /** The event that settled the submissions: their `message.received`, or their turn's end. */
  readonly event: MessageStreamEvent;
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

  apply(event: MessageStreamEvent): ReconciledSubmissions | undefined {
    const settling = this.#settling(event);
    if (settling.length === 0) {
      for (const projection of this.#projections) projection.append(event);
      return undefined;
    }
    return this.#settle(settling, event, false);
  }

  correlate(
    submissionId: string | undefined,
    deliveryId: string | undefined,
    events: readonly MessageStreamEvent[],
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
      const settling = this.#settling(event);
      if (settling.some((candidate) => candidate.id === submissionId)) {
        return this.#settle(settling, event, true);
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

  /** The pending submissions this event settles: received by it, or left unread by its turn's end. */
  #settling(event: MessageStreamEvent): readonly PendingMessageSubmission[] {
    if (event.type === "message.received") return this.#matching(event);
    // A turn that ends without receiving a delivery keeps it in history, and the server never
    // announces it with `message.received` afterwards.
    if (event.type !== "turn.cancelled" && event.type !== "turn.failed") return [];
    const named = event.meta.deliveryIds ?? [];
    return this.#pending.filter(
      (pending) => pending.deliveryId !== undefined && named.includes(pending.deliveryId),
    );
  }

  #matching(event: Extract<MessageStreamEvent, { readonly type: "message.received" }>) {
    return this.#pending.filter((pending) =>
      pending.deliveryId === undefined
        ? !pending.requiresDeliveryId
        : event.meta.deliveryIds?.includes(pending.deliveryId) === true,
    );
  }

  #settle(
    submissions: readonly PendingMessageSubmission[],
    event: MessageStreamEvent,
    alreadyProjected: boolean,
  ): ReconciledSubmissions {
    const ids = submissions.map((pending) => pending.id);
    if (event.type === "message.received") {
      this.#withdraw(ids);
    } else {
      const error = new Error("The turn ended before the agent read the message.");
      for (const id of ids) this.fail(error, id);
    }
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
