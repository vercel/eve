import type { LocalSubmission } from "#client/conversation.js";
import { summarizeMessage } from "#client/eve-agent-store-helpers.js";
import type { SendTurnPayload } from "#client/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

type Submission = LocalSubmission & { readonly deliveryId?: string };

/** Local message echoes until their deliveries arrive, including failed sends. */
export class OptimisticMessageSubmissions {
  readonly #optimistic: boolean;
  readonly #show: (submissions: readonly LocalSubmission[]) => void;
  readonly #submissions = new Map<string, Submission>();

  constructor(show: (submissions: readonly LocalSubmission[]) => void, optimistic: boolean) {
    this.#show = show;
    this.#optimistic = optimistic;
  }

  reset(): void {
    this.#submissions.clear();
    this.#publish();
  }

  submit(input: SendTurnPayload, turnId?: string): string | undefined {
    if (input.message === undefined) return undefined;
    const id = crypto.randomUUID();
    this.#submissions.set(id, { id, message: summarizeMessage(input.message), turnId });
    this.#publish();
    return id;
  }

  resubmit(id: string | undefined, input: SendTurnPayload): string | undefined {
    if (id === undefined) return this.submit(input);
    const previous = this.#submissions.get(id);
    if (input.message === undefined) this.#submissions.delete(id);
    else this.#submissions.set(id, { ...previous, id, message: summarizeMessage(input.message) });
    this.#publish();
    return input.message === undefined ? undefined : id;
  }

  correlate(id: string | undefined, deliveryId: string): void {
    if (id === undefined) return;
    const submission = this.#submissions.get(id);
    if (submission !== undefined) this.#submissions.set(id, { ...submission, deliveryId });
  }

  reconcile(view: SessionView): void {
    for (const [id, submission] of this.#submissions) {
      const row =
        submission.deliveryId === undefined ? undefined : view.deliveries[submission.deliveryId];
      if (row?.consumedAt !== undefined) this.#submissions.delete(id);
      else if (row?.status === "settled" && submission.error === undefined) {
        this.fail(new Error(row.reason ?? "The message was not consumed."), id);
      }
    }
    this.#publish();
  }

  fail(error: Error, id: string | undefined): void {
    if (id === undefined) return;
    const submission = this.#submissions.get(id);
    if (submission !== undefined) {
      this.#submissions.set(id, { ...submission, error: { message: error.message } });
      this.#publish();
    }
  }

  failAll(error: Error): void {
    for (const [id, submission] of this.#submissions) {
      if (submission.error === undefined) this.fail(error, id);
    }
  }

  #publish(): void {
    this.#show(
      [...this.#submissions.values()].filter(
        (submission) => this.#optimistic || submission.error !== undefined,
      ),
    );
  }
}
