import type { SessionAuthContext } from "#channel/types.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** Longest {@link InvokeToolOptions.key} `invokeTool` accepts. */
export const TOOL_SESSION_KEY_MAX_LENGTH = 512;

/** Options for one {@link InvokeToolFn} call. */
export interface InvokeToolOptions {
  /** The caller this request authenticated. Becomes `ctx.session.auth.current`. */
  readonly auth: SessionAuthContext;
  /**
   * Names a tool session the call joins: 1 to 512 characters, chosen by the
   * caller. Calls from the same `auth` principal with the same key share one
   * session id and one sandbox, which outlives the call. A different
   * principal using the same key gets a different session. Without a key,
   * the call runs in a one-off session.
   */
  readonly key?: string;
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
 * workflow step is involved, and the call never parks. `ctx.session.auth.current`
 * is the caller, and authored state starts from its initial value and is not
 * kept, with or without a key. Without `key`, each call gets its own session,
 * and a sandbox the tool opens is deleted when the call ends. With `key`, the
 * session id is stable for that caller and key, and its sandbox is kept for
 * the next call with the same key.
 */
export type InvokeToolFn = (
  name: string,
  input: unknown,
  options: InvokeToolOptions,
) => Promise<InvokeToolResult>;
