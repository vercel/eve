import type { UserContent } from "ai";

/** Browser-local state for a message submitted while another turn is active. */
export type EveAgentPendingSubmissionStatus = "failed" | "queued" | "steering" | "submitting";

/** One overlapping message that has not entered an authoritative server turn yet. */
export interface EveAgentPendingSubmission {
  readonly error?: Error;
  readonly id: string;
  readonly message: string;
  readonly status: EveAgentPendingSubmissionStatus;
  readonly turnPolicy: "queue" | "steer";
}

export class EveAgentPendingSubmissions {
  readonly #contentKinds = new Map<string, "string" | "structured">();
  #submissions: readonly EveAgentPendingSubmission[] = [];
  #turnSubmissionIds: readonly string[] = [];

  get snapshot(): readonly EveAgentPendingSubmission[] {
    return this.#submissions;
  }

  get hasWork(): boolean {
    return this.#submissions.some((submission) => submission.status !== "failed");
  }

  get hasTurnCandidates(): boolean {
    return this.#turnSubmissionIds.length > 0;
  }

  append(submission: EveAgentPendingSubmission, message: string | UserContent): void {
    this.#contentKinds.set(submission.id, typeof message === "string" ? "string" : "structured");
    this.#submissions = [...this.#submissions, submission];
  }

  update(
    submissionId: string,
    update: Pick<EveAgentPendingSubmission, "status"> & { readonly error?: Error },
  ): void {
    this.#submissions = this.#submissions.map((submission) =>
      submission.id === submissionId ? { ...submission, ...update } : submission,
    );
  }

  captureTurn(awaitingPrimaryMessage: boolean): void {
    this.#turnSubmissionIds = awaitingPrimaryMessage
      ? []
      : this.#submissions
          .filter((submission) => submission.status !== "failed")
          .map((submission) => submission.id);
  }

  clearTurn(): void {
    this.#turnSubmissionIds = [];
  }

  clear(): void {
    this.#contentKinds.clear();
    this.#submissions = [];
    this.#turnSubmissionIds = [];
  }

  consumeTurn(receivedMessage: string): void {
    const candidates = this.#turnSubmissionIds
      .map((submissionId) => this.#submissions.find((submission) => submission.id === submissionId))
      .filter((submission) => submission !== undefined);
    let combinedMessage = "";
    let containsStructuredContent = false;
    let consumedCount = 0;

    for (const [index, submission] of candidates.entries()) {
      const submissionIsStructured = this.#contentKinds.get(submission.id) === "structured";
      if (index === 0) {
        combinedMessage = submission.message;
      } else {
        const separator = containsStructuredContent || submissionIsStructured ? "\n" : "\n\n";
        combinedMessage += `${separator}${submission.message}`;
      }
      containsStructuredContent ||= submissionIsStructured;

      if (combinedMessage === receivedMessage) {
        consumedCount = index + 1;
      }
    }

    const consumed = new Set(candidates.slice(0, consumedCount).map((submission) => submission.id));
    this.#submissions = this.#submissions.filter((submission) => !consumed.has(submission.id));
    for (const submissionId of consumed) {
      this.#contentKinds.delete(submissionId);
    }
    this.clearTurn();
  }

  fail(error: Error): void {
    this.#submissions = this.#submissions.map((submission) =>
      submission.status === "failed" ? submission : { ...submission, error, status: "failed" },
    );
  }
}
