import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { LocalSubmission } from "#client/conversation.js";
import type { PendingMessageSubmission } from "#client/eve-agent-store-state.js";
import { createSubmissionId, summarizeUserContent } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";

interface ReconciledSubmissions {
  /** The store had received the consuming event before it knew the submission's delivery. */
  readonly alreadyProjected: boolean;
  readonly event: Extract<SessionStreamEvent, { readonly type: "delivery.consumed" }>;
  readonly ids: readonly string[];
}

/**
 * Owns the messages this client sent that eve hasn't consumed: it shows them (when optimistic)
 * until the delivery that consumes them arrives, and shows a failed one as failed.
 */
export class OptimisticMessageSubmissions {
  readonly #optimistic: boolean;
  readonly #show: (submissions: readonly LocalSubmission[]) => void;
  #pending: readonly PendingMessageSubmission[] = [];
  #shown: readonly LocalSubmission[] = [];

  constructor(show: (submissions: readonly LocalSubmission[]) => void, optimistic: boolean) {
    this.#show = show;
    this.#optimistic = optimistic;
  }

  reset(): void {
    this.#pending = [];
    this.#shown = [];
  }

  submit(input: SendTurnPayload, eventStartIndex: number, turnId?: string): string | undefined {
    if (input.message === undefined) return undefined;
    const pending: PendingMessageSubmission = {
      createdAt: Date.now(),
      eventStartIndex,
      id: createSubmissionId(),
      message: summarizeUserContent(input.message),
      turnId,
      requiresDeliveryId: true,
    };
    this.#pending = [...this.#pending, pending];
    if (this.#optimistic) {
      const shown: LocalSubmission = { id: pending.id, message: pending.message };
      this.#setShown([...this.#shown, turnId === undefined ? shown : { ...shown, turnId }]);
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

  /** Withdraws the submissions a received event consumed. */
  apply(event: SessionStreamEvent): ReconciledSubmissions | undefined {
    if (!isConsumedMessage(event)) return undefined;
    const matching = this.#matching(event);
    if (matching.length === 0) return undefined;
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
    const failed: LocalSubmission = {
      error: { message: error.message },
      id: pending.id,
      message: pending.message,
      ...(pending.turnId !== undefined && { turnId: pending.turnId }),
    };
    const index = this.#shown.findIndex((shown) => shown.id === pending.id);
    this.#setShown(
      index === -1
        ? [...this.#shown, failed]
        : this.#shown.map((shown, at) => (at === index ? failed : shown)),
    );
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
    return { alreadyProjected, event, ids };
  }

  #withdraw(ids: readonly string[]): void {
    const idSet = new Set(ids);
    this.#pending = this.#pending.filter((pending) => !idSet.has(pending.id));
    this.#setShown(this.#shown.filter((shown) => !idSet.has(shown.id)));
  }

  #setShown(shown: readonly LocalSubmission[]): void {
    this.#shown = shown;
    this.#show(shown);
  }
}

type ConsumedMessage = Extract<SessionStreamEvent, { readonly type: "delivery.consumed" }>;

/** A message a person sent, as its turn consumed it: an answer or context sends none. */
function isConsumedMessage(event: SessionStreamEvent): event is ConsumedMessage {
  return event.type === "delivery.consumed" && event.data.parts.length > 0;
}
