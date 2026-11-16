import { decide } from "eve/ai";
import { MOCK_MODELS } from "#lib/mock-model/config.js";
import { DECISION_MODEL } from "#lib/models/config.js";

/**
 * The decision model and the shared way tools ask it yes/no questions.
 *
 * @remarks
 * A decision model answers a bounded question with a probability instead of prose, which makes it
 * the right size for a judgment a regex can't make and the main model shouldn't spend a turn on:
 * does this draft read machine-made, does this email carry a postal address. Two tools ask such
 * questions today (`lint_against_style` and `check_send_readiness`), so the thresholds
 * and the error handling live here once. The model id is `DECISION_MODEL` in
 * `lib/models/config.ts`, next to the other model ids.
 *
 * Every caller treats the answer as evidence for the agent to act on, never as a gate. A decision
 * model must not stand in for a human approval.
 *
 * @packageDocumentation
 */

/**
 * Lower edge of the uncertain band for a probability.
 *
 * @remarks
 * A probability at or below this is a confident "no". Decision-model probabilities are estimates
 * rather than calibrated confidence, so the band is deliberately wide.
 *
 * @defaultValue 0.25
 */
export const UNCERTAIN_LOW = 0.25;

/**
 * Upper edge of the uncertain band for a probability.
 *
 * @remarks
 * A probability above this is a confident "yes". Anything between {@link UNCERTAIN_LOW} and this
 * value is too close to call and is reported as `unsure`, so the agent reads the text itself.
 *
 * @defaultValue 0.75
 */
export const UNCERTAIN_HIGH = 0.75;

/**
 * The three outcomes a judged rule can have.
 */
export type Verdict = "pass" | "fail" | "unsure";

/**
 * One rule's outcome from the decision model.
 */
export interface Judgment {
  /** The decision model's estimate (0-1) that the rule holds. */
  probability: number;
  /** The key of the rule that was asked. */
  rule: string;
  /** The probability read against the uncertain band. */
  verdict: Verdict;
}

/**
 * Read a probability against the uncertain band.
 *
 * @param probability - The decision model's estimate that a rule holds.
 * @returns `pass` above the band, `fail` at or below it, and `unsure` inside it or when the value
 * is not a finite number.
 */
export const toVerdict = (probability: number): Verdict => {
  if (!Number.isFinite(probability)) {
    return "unsure";
  }
  if (probability > UNCERTAIN_HIGH) {
    return "pass";
  }
  return probability <= UNCERTAIN_LOW ? "fail" : "unsure";
};

/**
 * Ask the decision model a set of yes/no rules about one piece of state.
 *
 * @remarks
 * Fails open. A decision model that is unavailable or errors returns `null` instead of throwing,
 * because every caller pairs these rules with deterministic checks that should still be reported.
 * The failure is logged so it shows up in the runtime logs instead of disappearing behind the
 * fallback. Only the error's message is logged: the full error can carry the request, which is
 * the draft or the email copy being judged.
 *
 * Under the offline evals (`MOCK_MODELS`) no decision model is called and the result is `null`,
 * which is the same path a provider outage takes.
 *
 * The state is user-authored copy. It is passed as data for the model to judge, and nothing in it
 * is treated as an instruction.
 *
 * @param rules - Each rule's question, keyed by the name reported back in {@link Judgment.rule}.
 * Phrase every question so that "yes" means the text is fine.
 * @param state - The text being judged and any rubric it is judged against.
 * @param signal - The tool call's abort signal, so a cancelled call cancels the decision.
 * @returns One judgment per rule, or `null` when the decision model failed.
 */
export const judgeRules = async (
  rules: Readonly<Record<string, string>>,
  state: Readonly<Record<string, string>>,
  signal?: AbortSignal
): Promise<Judgment[] | null> => {
  const questions = Object.fromEntries(
    Object.entries(rules).map(([rule, instructions]) => [
      rule,
      { instructions, type: "boolean" as const },
    ])
  );
  if (MOCK_MODELS) {
    return null;
  }
  try {
    const { answers } = await decide({
      model: DECISION_MODEL,
      questions,
      signal,
      state,
    });
    return Object.entries(answers).map(([rule, { probability }]) => ({
      probability,
      rule,
      verdict: toVerdict(probability),
    }));
  } catch (error) {
    console.warn(
      "judgeRules: the decision model failed.",
      error instanceof Error ? error.message : "Unknown error"
    );
    return null;
  }
};
