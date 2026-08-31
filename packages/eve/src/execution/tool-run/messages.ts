import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHookStep } from "#execution/tool-run/resume-hook-step.js";
import { toolRunAnswerToken } from "#harness/tool-runs.js";

import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/**
 * The hook tokens of the turn or task that started a run. The run resumes
 * `report` with progress, `request` with a question carrying the token of the
 * hook its answer should resume, and `outcome` once with its result.
 */
export interface ToolRunOwner {
  readonly outcome: string;
  readonly report: string;
  readonly request: string;
}

/**
 * Who a message is from: enough for an owner sharing one channel across many
 * runs to bind an outcome to its call, route a request, and render it.
 */
export interface RunRef {
  readonly callId: string;
  /** The tool's parsed input, shown as the request's action when the run asks. */
  readonly input: JsonObject;
  readonly runId: string;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly turnId: string;
}

/** Terminal result of one run, reported once to its owner. */
export type RunOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason?: string };

/**
 * The three things a run says to its owner, each on its own hook of the
 * owner's {@link ToolRunOwner}: progress on `report`, a question on `request`
 * with the token of the hook its answer resumes, and the end on `outcome`.
 */
export interface RunReport {
  readonly from: RunRef;
  readonly update: JsonValue;
}

/** `replyTo` is the token of the hook the human's answer resumes. */
export interface RunRequestMessage {
  readonly from: RunRef;
  readonly replyTo: string;
  readonly request: ToolInputRequest;
}

export interface RunOutcomeMessage {
  readonly from: RunRef;
  readonly result: RunOutcome;
}

export const reportHook = defineHook<RunReport>();
export const requestHook = defineHook<RunRequestMessage>();
export const outcomeHook = defineHook<RunOutcomeMessage>();

/**
 * An owner's three channels derive from its inbox token, so the owner creates
 * them and a run it starts addresses them from the same string.
 */
export function deriveRunOwner(inboxToken: string): ToolRunOwner {
  return {
    outcome: `${inboxToken}:outcome`,
    report: `${inboxToken}:report`,
    request: `${inboxToken}:request`,
  };
}

/** What an owner says to a run, on the run's own hook. */
export type RunControlMessage = { readonly kind: "cancel"; readonly reason: string };

/**
 * Narrows a control-inbox payload. Hand-written rather than a zod schema: this
 * runs in the replayed body, and a schema would pull all of zod into the
 * workflow driver that ships inside every function bundle.
 */
export function isRunControlMessage(value: unknown): value is RunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  return kind === "cancel" && typeof reason === "string";
}

/**
 * What a body needs to speak to its owner: the run's identity and the owner's
 * channels. Carried on the tool context under a global-registry symbol, not a
 * module-level map: the driver composes the framework and application layers
 * from separate bundles, so `attachRunContext` (framework) and `ask` (reached
 * from authored code through `eve/workflow`) run in different instances of
 * this module and share nothing but the objects they pass around.
 */
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
 * Asks the owner to put a question to a human and returns the hook the answer
 * resumes, the way `createHook` returns one: await it for the answer, race it
 * against a `sleep` for a deadline.
 *
 * Synchronous on purpose. A `Hook` is thenable, so an async function that
 * returned one would adopt it and its promise would settle with the answer,
 * never the hook. The request is published by a step the body does not await;
 * the workflow runs it before the body suspends on the hook.
 */
export function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse> {
  const context = readRunContext(ctx);
  const answer = createHook<ToolInputResponse>({
    token: toolRunAnswerToken(context.from.runId, context.answerSeq++),
  });
  const message: RunRequestMessage = { from: context.from, replyTo: answer.token, request };
  void resumeHookStep(context.owner.request, message);
  return answer;
}
