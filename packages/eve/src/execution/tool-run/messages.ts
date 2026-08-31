import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHookStep } from "#execution/tool-run/resume-hook-step.js";

import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { InputRequest } from "#shared/input.js";
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
 * A request a run asks its owner to put to a human. Either the author's
 * shape, completed by the owner with the run's call as its `action`, or a
 * full request forwarded from a child. `requestId` is always the hook token
 * the answer resumes, so the owner overwrites it with the message's `replyTo`.
 */
export type RunRequest = ToolInputRequest | InputRequest;

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

export interface RunRequestMessage {
  readonly from: RunRef;
  readonly replyTo: string;
  readonly request: RunRequest;
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
 * channels. Carried on the tool context under a private symbol so the public
 * `ToolContext` stays free of framework internals while `ask(ctx, ...)` still
 * works from a body.
 */
const RUN_CONTEXT = Symbol.for("eve.tool-run.context");

interface RunContext {
  readonly answerSeq: { value: number };
  readonly from: RunRef;
  readonly owner: ToolRunOwner;
}

/** Prefix marking a per-request answer hook so delivery resumes it directly. */
const ANSWER_HOOK_PREFIX = "eve:tool-run-answer:";

/**
 * A tool run's per-request answer hook is resumed with a plain input response.
 * With `runId`, narrows to the answer hooks of that one run.
 */
export function isToolRunAnswerToken(token: string, runId?: string): boolean {
  return token.startsWith(
    runId === undefined ? ANSWER_HOOK_PREFIX : `${ANSWER_HOOK_PREFIX}${runId}:`,
  );
}

/** Stamps a run's identity and owner onto the context its body receives. */
export function attachRunContext(ctx: ToolContext, context: Omit<RunContext, "answerSeq">): void {
  Object.defineProperty(ctx, RUN_CONTEXT, {
    enumerable: false,
    value: { ...context, answerSeq: { value: 0 } },
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
  const seq = context.answerSeq.value++;
  const answer = createHook<ToolInputResponse>({
    token: `${ANSWER_HOOK_PREFIX}${context.from.runId}:${seq}`,
  });
  const message: RunRequestMessage = { from: context.from, replyTo: answer.token, request };
  void resumeHookStep(context.owner.request, message);
  return answer;
}
