import type { SubmittedAnswer } from "#harness/types.js";
import {
  responseAdmitted,
  responseSettled,
  responseSubmitted,
} from "#harness/interaction-facts.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import type { ResponseRow, SessionView } from "#protocol/session-projection/tables.js";
import type { Answer } from "#shared/input.js";

// The responses every interaction kind shares: which answer stands, and the response facts a
// settlement records. Each kind decides what its standing answer means.

/** The answer that stands for each open interaction: its latest admitted response. */
export function standingAnswers(tables: SessionView): ReadonlyMap<string, ResponseRow> {
  const standing = new Map<string, ResponseRow>();
  const rows = Object.values(tables.responses).sort((a, b) => a.introducedAt - b.introducedAt);
  for (const row of rows) {
    if (row.status === "admitted") standing.set(row.interactionId, row);
  }
  return standing;
}

export function responseOf(
  interactionId: string,
  row: ResponseRow | undefined,
): Answer | undefined {
  if (row?.value === undefined) return undefined;
  const response: { interactionId: string; optionId?: string; text?: string } = { interactionId };
  if (row.value.optionId !== undefined) response.optionId = row.value.optionId;
  if (row.value.text !== undefined) response.text = row.value.text;
  return response;
}

// ---------------------------------------------------------------------------
// The response ledger
// ---------------------------------------------------------------------------

/**
 * The responses a commit records: each answer submitted once, its checks, and how it settled.
 * Revising an admitted answer abandons the one it replaces; an interaction that settles
 * withdraws the open answers that didn't decide it.
 */
export interface ResponseLedger {
  /** Records answers not seen yet; one to a request nobody can answer anymore is dropped. */
  submit(answers: readonly SubmittedAnswer[]): void;
  admit(responseId: string): void;
  settle(responseId: string, outcome: ResponseOutcome, reason?: string): void;
  /** Settles every other open answer to an interaction that `decidedBy` settles. */
  closeOthers(interactionId: string, decidedBy: string | undefined): void;
  facts(): SessionEvent[];
}

export function responseLedger(tables: SessionView): ResponseLedger {
  const facts: SessionEvent[] = [];
  const fresh = new Map<string, SubmittedAnswer>();
  const status = new Map<string, "submitted" | "admitted" | "settled">();
  for (const row of Object.values(tables.responses)) status.set(row.responseId, row.status);
  const submit = (answers: readonly SubmittedAnswer[]) => {
    for (const answer of answers) {
      const { deliveryId, interactionId, optionId, responseId, text } = answer;
      if (status.has(responseId)) continue;
      // An answer to a request nobody can answer anymore introduces nothing: it was converted
      // or dropped before it got here.
      if (tables.interactions[interactionId]?.status !== "open") continue;
      fresh.set(responseId, answer);
      status.set(responseId, "submitted");
      const value: { optionId?: string; text?: string } = {};
      if (optionId !== undefined) value.optionId = optionId;
      if (text !== undefined) value.text = text;
      facts.push(responseSubmitted({ deliveryId, interactionId, responseId, value }));
    }
  };
  const interactionOf = (responseId: string) =>
    fresh.get(responseId)?.interactionId ?? tables.responses[responseId]?.interactionId;
  const order = (responseId: string) =>
    tables.responses[responseId]?.introducedAt ?? Number.MAX_SAFE_INTEGER;
  const openFor = (interactionId: string) =>
    [...status]
      .filter(([id, state]) => state !== "settled" && interactionOf(id) === interactionId)
      .map(([id]) => id)
      .sort((a, b) => order(a) - order(b));
  const settle = (responseId: string, outcome: ResponseOutcome, reason?: string) => {
    const current = status.get(responseId);
    if (current === undefined || current === "settled") return;
    status.set(responseId, "settled");
    facts.push(responseSettled(responseId, outcome, reason));
  };
  return {
    admit(responseId) {
      if (status.get(responseId) !== "submitted") return;
      const interactionId = interactionOf(responseId);
      if (interactionId !== undefined) {
        for (const other of openFor(interactionId)) {
          if (other !== responseId && status.get(other) === "admitted")
            settle(other, "abandoned", "revised");
        }
      }
      status.set(responseId, "admitted");
      facts.push(responseAdmitted(responseId));
    },
    closeOthers(interactionId, decidedBy) {
      for (const other of openFor(interactionId)) {
        if (other === decidedBy) continue;
        settle(other, status.get(other) === "admitted" ? "abandoned" : "withdrawn");
      }
    },
    facts: () => facts,
    submit,
    settle,
  };
}
