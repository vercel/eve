/**
 * The one place a program runtime plugs into the benchmark. Each key is an arm
 * name accepted by `EVE_ARMS_MODE`; its value is spread into the root agent's
 * definition when that arm runs, e.g. `js: { codeMode: ... }`. Adding a runtime
 * means filling in its entry here; the evals, `measure.ts` and `run-arms.mjs`
 * stay as they are.
 *
 * `null` marks a runtime this build doesn't have yet; selecting it fails fast.
 */
export const PROGRAM_ARMS: Record<string, Record<string, unknown> | null> = {
  js: null,
  py: null,
};
