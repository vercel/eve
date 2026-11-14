import { defineEvalConfig } from "eve/evals";

/**
 * Run-wide eval configuration.
 *
 * @remarks
 * The judge model scores `t.judge(...)` assertions only; it never changes the
 * agent under test. `typesafe-ai/jev` (eve's default evaluation model) is
 * left implicit rather than named here: `t.judge` calls a native evaluation
 * model, not an ordinary language model id, and passing a plain chat model
 * id such as `google/gemini-3.6-flash` doesn't route through the evaluation
 * API. Run the default loop with `pnpm eval --tag fast`; see the README's
 * evals section for the full matrix.
 */
export default defineEvalConfig({});
