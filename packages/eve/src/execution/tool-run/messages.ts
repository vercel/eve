import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHook } from "#execution/tool-run/workflow-api.js";

import type {
  ToolContext,
  ToolInputRequest,
  ToolInputResponse,
  ToolRunOwner,
} from "#tools/definition.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type {
  TaskInboundAuthorizationEvent,
  TaskInboundTurnStarted,
  TaskInboundUpdate,
} from "#tasks/types.js";

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
  | { readonly status: "subagent"; readonly result: RuntimeSubagentResult }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason?: string };

/**
 * The public things a run says to its owner. Framework subagent events and
 * outcomes share `report` so their order is durable; authored tools use
 * progress, request, and outcome as before.
 */
export type RunReport =
  | { readonly from: RunRef; readonly kind: "progress"; readonly update: JsonValue }
  | { readonly event: RunEvent; readonly from: RunRef; readonly kind: "subagent-event" }
  | {
      readonly from: RunRef;
      readonly kind: "subagent-outcome";
      readonly result: RuntimeSubagentResult;
    };

export interface RunRequestMessage {
  readonly from: RunRef;
  readonly replyTo: string;
  readonly request: RunRequest;
}

export interface RunOutcomeMessage {
  readonly from: RunRef;
  readonly result: RunOutcome;
}

/** Child payloads a subagent execute run forwards unchanged to its owner. */
export type RunEvent =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload
  | TaskInboundAuthorizationEvent
  | TaskInboundTurnStarted
  | TaskInboundUpdate;

export function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  return (
    kind === "subagent-authorization-event" ||
    kind === "subagent-input-request" ||
    kind === "authorization-event" ||
    kind === "turn-started" ||
    kind === "task-update"
  );
}

export const reportHook = defineHook<RunReport>();
export const requestHook = defineHook<RunRequestMessage>();
export const outcomeHook = defineHook<RunOutcomeMessage>();

/**
 * An owner's public channels derive from its inbox token, so the owner creates
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
export type RunControlMessage =
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "release" };

/**
 * Narrows a control-inbox payload. Hand-written rather than a zod schema: this
 * runs in the replayed body, and a schema would pull all of zod into the
 * workflow driver that ships inside every function bundle.
 */
export function isRunControlMessage(value: unknown): value is RunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  return kind === "release" || (kind === "cancel" && typeof reason === "string");
}

export function isRunReleaseMessage(
  value: unknown,
): value is Extract<RunControlMessage, { kind: "release" }> {
  return isRunControlMessage(value) && value.kind === "release";
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

/** Reads the framework-owned run identity attached to a workflow tool context. */
export function readRunRef(ctx: ToolContext): RunRef {
  return readRunContext(ctx).from;
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
