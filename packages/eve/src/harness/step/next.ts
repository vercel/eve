/**
 * What the native loop does after a model step whose calls all have results: call the model again
 * in the same turn, wait for the turn's tasks, or settle the turn. Parking on approvals, sign-ins,
 * and runtime calls happens before this choice; those are gates, not choices.
 */
export type TurnNext =
  | { readonly kind: "continue"; readonly reason: ContinueReason }
  | { readonly kind: "wait"; readonly taskIds: readonly string[] }
  | { readonly kind: "settle"; readonly output: string | null };

/** Why the turn calls the model again. */
export type ContinueReason =
  /** The step ended on tool results the model hasn't read. */
  | "tool-results"
  /** A provider-executed call's outcome ended the response before the model answered it. */
  | "provider-outcome"
  /** Input arrived for the turn while the model ran. */
  | "queued-input";

/** What a settled model step leaves for the loop to choose from. */
export interface ModelStepOutcome {
  /** The structured value the model delivered, when it called `eve__reply` while no task works. */
  readonly delivered: boolean;
  /** Every call targeted a tool that ends the turn, and each accepted its output. */
  readonly endsTurn: boolean;
  /** The step's response ends with tool results. */
  readonly endsOnToolResults: boolean;
  readonly providerOutcomeEndsResponse: boolean;
  readonly queuedInput: boolean;
  /** The prose the step wrote, which becomes the reply when the turn settles. */
  readonly text: string | null;
  readonly workingTaskIds: readonly string[];
}

/**
 * eve's native choice. A delivered structured value always settles. Otherwise unread results,
 * a provider outcome, or queued input continue the turn; then no turn ends while its tasks work;
 * then it settles, with text written before an `endsTurn` call counted as narration.
 */
export function chooseNext(outcome: ModelStepOutcome): TurnNext {
  if (!outcome.delivered) {
    if (outcome.endsOnToolResults && !outcome.endsTurn) {
      return { kind: "continue", reason: "tool-results" };
    }
    if (outcome.providerOutcomeEndsResponse) {
      return { kind: "continue", reason: "provider-outcome" };
    }
    if (outcome.queuedInput) return { kind: "continue", reason: "queued-input" };
  }
  if (outcome.workingTaskIds.length > 0) return { kind: "wait", taskIds: outcome.workingTaskIds };
  return { kind: "settle", output: outcome.endsTurn ? null : outcome.text };
}
