import type { SessionAuthContext } from "#channel/types.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** Longest `callId` a caller may pass to {@link InvokeToolFn}. */
export const INVOKE_TOOL_CALL_ID_MAX_LENGTH = 512;

/** Options for one {@link InvokeToolFn} call. */
export interface InvokeToolOptions {
  /** The caller this request authenticated. Becomes `ctx.session.auth.current`. */
  readonly auth: SessionAuthContext;
  /**
   * The caller's answer to this call's approval. The approval policy still
   * runs first, and the tool's response policy runs with `auth` as the
   * responder. `invokeTool` does not tie the answer to `input` or `callId`: a
   * caller that relays answers across requests must bind them itself, for
   * example with signed state over the tool name and arguments.
   */
  readonly approval?: { readonly approved: boolean };
  /**
   * Correlates the retries of one call, at most 512 characters, and becomes
   * the tool's call id. Minted when absent. It grants nothing.
   */
  readonly callId?: string;
  readonly signal?: AbortSignal;
}

/** One sign-in a call needs before it can run. */
export interface InvokeToolSignIn {
  readonly connection: string;
  /** The page the person opens to sign in, when the connection has one. */
  readonly url?: string;
  readonly userCode?: string;
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
  /** The tool's approval policy asks a person, and no `approval` was passed. The tool did not run. */
  | { readonly status: "approval-required"; readonly callId: string }
  /** The tool needs these sign-ins first. The tool stopped where it needed them. */
  | {
      readonly status: "authorization-required";
      readonly callId: string;
      readonly signIns: readonly InvokeToolSignIn[];
    };

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
