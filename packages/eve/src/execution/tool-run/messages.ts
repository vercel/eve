import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHookStep } from "#execution/tool-run/resume-hook-step.js";
import { toolRunAnswerToken } from "#harness/tool-runs.js";

import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export interface ToolRunOwner {
  readonly outcome: string;
  readonly report: string;
  readonly request: string;
}

/** Identifies the sending run to an owner that shares its channels across many runs. */
export interface RunRef {
  readonly callId: string;
  /** The tool's parsed input, shown as the request's action when the run asks. */
  readonly input: JsonObject;
  readonly runId: string;
  /** Stream coordinates of the model call that made the tool call. */
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly turnId: string;
}

export type RunOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason?: string };

/** Progress sent up from a run; the owner streams it as a turn partial or a task update. */
export interface RunReport {
  readonly from: RunRef;
  readonly update: JsonValue;
}

/** A question sent up from a run; the owner puts it to the human and resumes `answerToken` with the reply. */
export interface RunRequestMessage {
  readonly answerToken: string;
  readonly from: RunRef;
  readonly request: ToolInputRequest;
}

/** The end of a run, sent up once; the owner settles the tool call or the task with it. */
export interface RunOutcomeMessage {
  readonly from: RunRef;
  readonly result: RunOutcome;
}

export const reportHook = defineHook<RunReport>();
export const requestHook = defineHook<RunRequestMessage>();
export const outcomeHook = defineHook<RunOutcomeMessage>();

/** Derived from the owner's inbox token so owner and run agree without exchanging tokens. */
export function deriveRunOwner(inboxToken: string): ToolRunOwner {
  return {
    outcome: `${inboxToken}:outcome`,
    report: `${inboxToken}:report`,
    request: `${inboxToken}:request`,
  };
}

export type RunControlMessage = { readonly kind: "cancel"; readonly reason: string };

// Not a zod schema: this runs in the replayed body, and zod would ship in every function bundle.
export function isRunControlMessage(value: unknown): value is RunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  return kind === "cancel" && typeof reason === "string";
}

// Carried on `ctx` under a global-registry symbol: the framework and application
// driver layers are separate bundles and share only the objects they pass around.
const RUN_CONTEXT = Symbol.for("eve.tool-run.context");

interface RunContext {
  answerSeq: number;
  readonly from: RunRef;
  readonly owner: ToolRunOwner;
}

export function attachRunContext(ctx: ToolContext, context: Omit<RunContext, "answerSeq">): void {
  Object.defineProperty(ctx, RUN_CONTEXT, {
    enumerable: false,
    value: { ...context, answerSeq: 0 },
  });
}

function readRunContext(ctx: ToolContext): RunContext {
  const context = (ctx as { [RUN_CONTEXT]?: RunContext })[RUN_CONTEXT];
  if (context === undefined) {
    throw new Error(
      'ask() must be called with the context of a workflow tool body ("use workflow").',
    );
  }
  return context;
}

/**
 * Asks the human on the session's channel and returns the hook the answer
 * resumes, as `createHook` would: await it for the answer, or race it against
 * a `sleep` for a deadline. Synchronous because a `Hook` is thenable: an async
 * `ask` would resolve to the answer, never the hook.
 */
export function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse> {
  const context = readRunContext(ctx);
  const answer = createHook<ToolInputResponse>({
    token: toolRunAnswerToken(context.from.runId, context.answerSeq++),
  });
  const message: RunRequestMessage = { answerToken: answer.token, from: context.from, request };
  void resumeHookStep(context.owner.request, message);
  return answer;
}
