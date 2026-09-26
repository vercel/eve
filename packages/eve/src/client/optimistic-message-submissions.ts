import type { EveAgentProjection } from "#client/eve-agent-projection.js";
import type { PendingMessageSubmission } from "#client/eve-agent-store-state.js";
import { createSubmissionId, summarizeUserContent } from "#client/eve-agent-store-helpers.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { SendTurnPayload } from "#client/types.js";

interface ReconciledSubmissions {
  readonly alreadyProjected: boolean;
  readonly event: Extract<MessageStreamEvent, { readonly type: "message.received" }>;
  readonly ids: readonly string[];
}

/** Owns optimistic message projection and server-delivery reconciliation. */
export class OptimisticMessageSubmissions {
  readonly #optimistic: boolean;
  readonly #projections: readonly EveAgentProjection<unknown>[];
  #pending: readonly PendingMessageSubmission[] = [];

  constructor(projections: readonly EveAgentProjection<unknown>[], optimistic: boolean) {
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

  apply(event: MessageStreamEvent): ReconciledSubmissions | undefined {
    if (event.type !== "message.received") {
      for (const projection of this.#projections) projection.append(event);
      return undefined;
    }
    if (event.data.kind === "execution.background_task") {
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
      if (event.type !== "message.received" || event.data.kind === "execution.background_task") {
        continue;
      }
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

  #matching(event: Extract<MessageStreamEvent, { readonly type: "message.received" }>) {
    return this.#pending.filter((pending) =>
      pending.deliveryId === undefined
        ? !pending.requiresDeliveryId
        : event.meta.deliveryIds?.includes(pending.deliveryId) === true,
    );
  }

  #reconcile(
    submissions: readonly PendingMessageSubmission[],
    event: Extract<MessageStreamEvent, { readonly type: "message.received" }>,
    alreadyProjected: boolean,
  ): ReconciledSubmissions {
    const ids = submissions.map((pending) => pending.id);
    const idSet = new Set(ids);
    this.#pending = this.#pending.filter((pending) => !idSet.has(pending.id));
    for (const projection of this.#projections) {
      projection.remove(
        (candidate) =>
          candidate.type === "client.message.submitted" && idSet.has(candidate.data.submissionId),
      );
      if (!alreadyProjected) projection.append(event);
    }
    return { alreadyProjected, event, ids };
  }
}
