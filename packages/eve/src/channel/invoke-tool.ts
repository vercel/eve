import type { SessionAuthContext } from "#channel/types.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** Options for one {@link InvokeToolFn} call. */
export interface InvokeToolOptions {
  /** The caller this request authenticated. Becomes `ctx.session.auth.current`. */
  readonly auth: SessionAuthContext;
  readonly signal?: AbortSignal;
}

/** Outcome of one {@link InvokeToolFn} call. */
export type InvokeToolResult =
  | {
      readonly status: "completed";
      readonly output: unknown;
      readonly modelOutput: ToolModelOutput;
    }
  | { readonly status: "failed"; readonly message: string; readonly errorId?: string }
  | { readonly status: "invalid-input"; readonly message: string }
  | { readonly status: "denied"; readonly reason?: string }
  /** The tool's approval policy asks a person. A call has no one to ask, so the tool did not run. */
  | { readonly status: "approval-required" }
  /** The tool needs a sign-in to these connections first. The tool stopped where it needed them. */
  | { readonly status: "authorization-required"; readonly connections: readonly string[] };

/**
 * Runs one of the agent's tools outside a conversation. No model, turn, or
 * workflow step is involved, and the call never parks. Each call gets its own
 * session: `ctx.session.auth.current` is the caller, authored state starts from
 * its initial value and is not kept, and a sandbox the tool opens is deleted
 * when the call ends.
 */
export type InvokeToolFn = (
  name: string,
  input: unknown,
  options: InvokeToolOptions,
) => Promise<InvokeToolResult>;
