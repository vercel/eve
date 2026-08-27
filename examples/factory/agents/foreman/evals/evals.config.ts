import { defineEvalConfig } from "eve/evals";

/**
 * Run-wide eval configuration.
 *
 * @remarks
 * The judge model scores `t.judge.*` assertions only; it never changes the
 * agent under test. A small, cheap model is enough for the yes/no grading the
 * suite uses. Run the default loop with `pnpm eval --tag fast`; see the
 * README's evals section for the full matrix.
 */
export default defineEvalConfig({
  judge: { model: "google/gemini-3.6-flash" },
});
