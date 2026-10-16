import { checksSessionEvents } from "#execution/check-session-events.js";
import {
  decideStep,
  readStepState,
  type StepDecision,
  type StepState,
} from "#execution/session/step-decision.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { activeTurn, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/** What `waiting(view, turnId)` says for the open turn. */
export type TablesSay = "person" | "work" | "session" | "no-turn";

export function tablesSay(view: SessionView): TablesSay {
  const turnId = activeTurn(view)?.turnId;
  return turnId === undefined ? "no-turn" : (waiting(view, turnId)?.on ?? "no-turn");
}

/**
 * How the session's decision disagrees with what the tables say the turn waits on, if it does.
 * The tables say whom the turn waits on, and the decision says what resumes it:
 *
 * - a pause on calls or tasks agrees with a person their run or task asked;
 * - a pause on calls whose runs haven't started agrees with the tables seeing the session's own
 *   work, which is starting them;
 * - the tables don't see input the model hasn't read, so a run beside working tasks agrees with
 *   the tables seeing their work.
 *
 * `formal/Eve/StepDecision.lean` models this check and proves which tables each state allows.
 */
export function decisionDisagreement(
  state: StepState,
  decision: StepDecision,
  tables: TablesSay,
): string | undefined {
  const agrees = (...allowed: readonly TablesSay[]) =>
    allowed.includes(tables) ? undefined : `${label(decision)}-but-${tables}`;
  switch (decision.kind) {
    case "end":
      return undefined;
    case "park":
      return decision.turnOpen === true ? "stranded" : agrees("no-turn");
    case "run":
      return state.workingTaskIds.length > 0 ? agrees("session", "work") : agrees("session");
    case "wait":
      switch (decision.pause.on) {
        case "person":
          return agrees("person");
        case "tasks":
          return agrees("work", "person");
        case "calls":
          return decision.pause.dispatch
            ? agrees("session", "work", "person")
            : agrees("work", "person");
      }
  }
}

function label(decision: StepDecision): string {
  return decision.kind === "wait" ? `wait-${decision.pause.on}` : decision.kind;
}

/**
 * Checks the decision the session's state leads to against its tables, in `eve dev` and with
 * `EVE_CHECK_SESSION_EVENTS=1`. The state cursor calls it after every durable step, so a
 * disagreement shows up in whichever step produced it.
 */
export function checkStepDecision(session: Pick<HarnessSession, "history" | "state">): void {
  if (!checksSessionEvents()) return;
  const state = readStepState(session);
  const decision = decideStep(state);
  const disagreement = decisionDisagreement(
    state,
    decision,
    tablesSay(storedProjection(session.state).view),
  );
  // The cursor runs in the workflow body, where eve's logger can't, so this writes directly.
  if (disagreement !== undefined)
    console.warn("[eve:execution.step-decision] the session's decision disagrees with its tables", {
      disagreement,
    });
}
