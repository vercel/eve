import { createHook, type Hook } from "#compiled/@workflow/core/index.js";
import { z } from "#compiled/zod/index.js";

import { tell } from "#execution/tool-run/tell.js";

import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
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
 * Who a message is from: enough for an owner sharing one inbox across many
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
 * Everything a run says to its owner, on the owner's hook (`ctx.replyTo`).
 * One shape for every owner: a turn resolves the call, emits a partial, or
 * publishes the request; a task wakes the agent or publishes the request; a
 * run in the middle decides for itself.
 */
export type RunMessage =
  | { readonly from: RunRef; readonly kind: "report"; readonly update: JsonValue }
  | {
      readonly from: RunRef;
      readonly kind: "request";
      readonly replyTo: string;
      readonly request: RunRequest;
    }
  | { readonly from: RunRef; readonly kind: "outcome"; readonly result: RunOutcome };

/** What an owner says to a run, on the run's own hook. */
export type RunControlMessage = { readonly kind: "cancel"; readonly reason: string };

export const runControlMessageSchema: z.ZodType<RunControlMessage> = z
  .object({ kind: z.literal("cancel"), reason: z.string() })
  .strict();

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
 * Create a hook, send its token as the request's return address, wait on it —
 * three SDK operations, with no privilege an author's own version would lack.
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
  await tell(ctx.replyTo, {
    from: context.from,
    kind: "request",
    replyTo: answer.token,
    request,
  });
  return answer;
}
