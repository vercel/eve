import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHook } from "#execution/tool-run/workflow-api.js";

import type { ToolContext, ToolInputRequest, ToolInputResponse, ToolRunOwner } from "#tools/definition.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

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
 * The run identity `ask` and the report path attach to every message. Carried
 * on the tool context under a private symbol so the public `ToolContext` stays
 * free of framework internals while `ask(ctx, ...)` still works from a body.
 */
const RUN_CONTEXT = Symbol.for("eve.tool-run.context");

interface RunContext {
  readonly answerSeq: { value: number };
  readonly from: RunRef;
}

/** Prefix marking a per-request answer hook so delivery resumes it directly. */
const ANSWER_HOOK_PREFIX = "eve:tool-run-answer:";

/** A tool run's per-request answer hook is resumed with a plain input response. */
export function isToolRunAnswerToken(token: string): boolean {
  return token.startsWith(ANSWER_HOOK_PREFIX);
}

/** Stamps a run's identity onto the context its body receives. */
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
 * resumes. Awaiting it suspends the run until a response arrives; iterating it
 * yields every response to the same standing question. Both reject with the
 * abort reason if the run is cancelled first, which withdraws the request.
 *
 * Create a hook, resume the owner's request channel with its token as the
 * return address, wait on it — three SDK operations, with no privilege an
 * author's own version would lack.
 */
export async function ask(
  ctx: ToolContext,
  request: ToolInputRequest,
): Promise<Hook<ToolInputResponse>> {
  const context = readRunContext(ctx);
  const seq = context.answerSeq.value++;
  const answer = createHook<ToolInputResponse>({
    token: `${ANSWER_HOOK_PREFIX}${context.from.runId}:${seq}`,
  });
  const message: RunRequestMessage = { from: context.from, replyTo: answer.token, request };
  await resumeHook(ctx.owner.request, message);
  return answer;
}
