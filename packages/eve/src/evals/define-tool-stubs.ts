import type { ToolContext } from "#tools/definition.js";

/** Context passed to a stub: the tool context an authored tool receives, plus the stub state. */
export type ToolStubContext<TState> = ToolContext & {
  /**
   * The session's stub state. The root session and every subagent it starts
   * share one state object, so a write here is visible to later calls.
   */
  readonly state: TState;
};

/**
 * Replaces one tool's `execute`. Receives the tool input, which follows the
 * real tool's input schema, and returns a result in the shape the real tool
 * returns.
 */
export type ToolStub<TState> = (input: any, ctx: ToolStubContext<TState>) => unknown;

/** Input accepted by {@link defineToolStubs}. */
export interface ToolStubsInput<TState> {
  /** Returns the starting state each time a root session selects this set. */
  readonly state?: () => TState;
  /** Stubs keyed by the model-visible tool name. */
  readonly tools: Readonly<Record<string, ToolStub<TState>>>;
}

/** A stub set, as returned by {@link defineToolStubs}. */
export interface ToolStubsDefinition<TState = unknown> extends ToolStubsInput<TState> {
  readonly _tag: "EveToolStubs";
}

/**
 * Defines a stub set for `eve eval`. Put each set in its own file under
 * `evals/stubs/`; the set's name is its path there without the extension
 * (`evals/stubs/two-workflows.ts` → `"two-workflows"`). An eval selects a set
 * with `t.send(message, { stubs: "two-workflows" })` or
 * `t.session({ stubs: "two-workflows" })`.
 *
 * In a stubbed session, a call to a tool named in `tools` runs the stub in
 * place of the tool's `execute`. The model still sees the real tool, and
 * approval policies still run before the stub. A call to an authored,
 * dynamic, or connection tool without a stub fails the turn.
 *
 * ```ts
 * export default defineToolStubs({
 *   state: () => ({ schedules: [{ id: "sched_1", name: "Weekly commit activity" }] }),
 *   tools: {
 *     schedules_read: (input, { state }) => ({ schedules: state.schedules }),
 *   },
 * });
 * ```
 */
export function defineToolStubs<TState = undefined>(
  input: ToolStubsInput<TState>,
): ToolStubsDefinition<TState> {
  if (input.state !== undefined && typeof input.state !== "function") {
    throw new TypeError(
      `defineToolStubs() expects state to be a function that returns the starting state; got ${typeof input.state}.`,
    );
  }
  for (const [toolName, stub] of Object.entries(input.tools)) {
    if (typeof stub !== "function") {
      throw new TypeError(
        `defineToolStubs() expects tools.${toolName} to be a function that returns the tool result; got ${typeof stub}.`,
      );
    }
  }
  return { ...input, _tag: "EveToolStubs" };
}
