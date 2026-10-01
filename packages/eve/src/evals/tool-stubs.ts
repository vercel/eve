/** Context passed to a tool stub. */
export interface ToolStubContext<TState> {
  /**
   * The stub set's state for this eval session and its subagents. Mutate it
   * in place; later stub calls in the same session tree see the change.
   */
  readonly state: TState;
  /** Name of the tool or agent the call reached, as the model sees it. */
  readonly toolName: string;
  /** Id of the call, as on its stream events. */
  readonly callId: string;
}

/** Returns the same shape as the real tool's `execute` for `input`. */
export type ToolStub<TState> = (input: any, ctx: ToolStubContext<TState>) => unknown;

/** Input accepted by {@link defineToolStubs}. */
export interface ToolStubsInput<TState> {
  /** Starting state, created once per root eval session. */
  readonly state?: () => TState;
  /** Stubs keyed by the tool name the model sees. */
  readonly tools: Readonly<Record<string, ToolStub<TState>>>;
}

/** A tool stub set produced by {@link defineToolStubs}. */
export interface ToolStubs<TState = unknown> extends ToolStubsInput<TState> {
  readonly _tag: "EveToolStubs";
}

/**
 * Defines a tool stub set, authored as the default export of a file in
 * `evals/stubs/`. The set's name is the file path relative to `evals/stubs/`
 * without its extension, so `evals/stubs/two-workflows.ts` is `"two-workflows"`.
 *
 * An eval selects a set with `t.send(message, { stubs })` or
 * `t.session({ stubs })`. In that session the model still sees every real
 * tool and its approval policy; a stub replaces only the tool's own work. Keys
 * name authored, extension, dynamic, connection, and workflow tools, and
 * remote agents. Calling one without a stub fails the turn.
 *
 * Throws when `tools` is not an object of functions or `state` is not a
 * function.
 */
export function defineToolStubs<TState = Record<string, never>>(
  input: ToolStubsInput<TState>,
): ToolStubs<TState> {
  if (input.state !== undefined && typeof input.state !== "function") {
    throw new Error("Tool stubs `state` must be a function that returns the starting state.");
  }
  if (typeof input.tools !== "object" || input.tools === null || Array.isArray(input.tools)) {
    throw new Error("Tool stubs `tools` must be an object of stub functions keyed by tool name.");
  }
  for (const [name, stub] of Object.entries(input.tools)) {
    if (typeof stub !== "function") {
      throw new Error(`Tool stub "${name}" must be a function.`);
    }
  }
  return { ...input, _tag: "EveToolStubs" };
}

/** Matches structurally, because a stub file may load its own copy of `eve/evals`. */
export function isToolStubs(value: unknown): value is ToolStubs {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "EveToolStubs"
  );
}
