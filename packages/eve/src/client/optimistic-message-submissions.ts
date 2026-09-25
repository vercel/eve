import { EveAgentProjection } from "#client/eve-agent-projection.js";
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
export class OptimisticMessageSubmissions<TData> {
  readonly #optimistic: boolean;
  readonly #projection: EveAgentProjection<TData>;
  #pending: readonly PendingMessageSubmission[] = [];

  constructor(projection: EveAgentProjection<TData>, optimistic: boolean) {
    this.#projection = projection;
    this.#optimistic = optimistic;
  }

  reset(): void {
    this.#pending = [];
  }

  submit(input: SendTurnPayload, eventStartIndex: number): string | undefined {
    if (input.message === undefined) return undefined;
    const pending = {
      createdAt: Date.now(),
      eventStartIndex,
      id: createSubmissionId(),
      message: summarizeUserContent(input.message),
      requiresDeliveryId: true,
    };
    this.#pending = [...this.#pending, pending];
    if (this.#optimistic) {
      this.#projection.append({
        data: { createdAt: pending.createdAt, message: pending.message, submissionId: pending.id },
        type: "client.message.submitted",
      });
    }
    return pending.id;
  }

  apply(event: MessageStreamEvent): ReconciledSubmissions | undefined {
    if (event.type !== "message.received") {
      this.#projection.append(event);
      return undefined;
    }
    const matching = this.#matching(event);
    if (matching.length === 0) {
      this.#projection.append(event);
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
      if (event.type !== "message.received") continue;
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
    this.#projection.replace(
      (event) =>
        event.type === "client.message.submitted" && event.data.submissionId === pending.id,
      {
        data: {
          createdAt: pending.createdAt,
          error: { message: error.message },
          message: pending.message,
          submissionId: pending.id,
        },
        type: "client.message.failed",
      },
    );
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
    if (alreadyProjected) {
      this.#projection.remove(
        (candidate) =>
          candidate.type === "client.message.submitted" && idSet.has(candidate.data.submissionId),
      );
    } else {
      this.#projection.replace(
        (candidate) =>
          candidate.type === "client.message.submitted" && candidate.data.submissionId === ids[0],
        event,
      );
      this.#projection.remove(
        (candidate) =>
          candidate.type === "client.message.submitted" && idSet.has(candidate.data.submissionId),
      );
    }
    return { alreadyProjected, event, ids };
  }
}
