/**
 * Remote input: a typed tool interrupt for a remote server that needs the
 * calling turn's user before it can finish a call (an MCP `input_required`
 * with an approval form, from another eve agent's `mcpChannel`).
 *
 * All remote input storage lives in this module: the journal on
 * `session.state` and the continuations in virtual context. It moves onto the
 * HITL request table (`openInputRequests`, vercel/eve#4217) once that lands.
 *
 * ## Lifecycle
 *
 * 1. **Interrupt.** The tool returns a {@link RemoteInputSignal}. The tools
 *    wrapper stashes the full signal and hands the AI SDK an opaque
 *    {@link RemoteInputPendingOutput}, so the retry payload (`requestState`)
 *    never reaches the model, telemetry, or `action.result`.
 * 2. **Park.** {@link parkRemoteInputs} turns each signal into a
 *    `tool-approval` input request on the call: it drops the pending tool
 *    result, records a `tool-approval-request` part for the call, and
 *    journals the retry payload and the expected responder on
 *    `session.state`. The turn parks and emits `input.requested` like any
 *    approval, so every channel renders it unchanged.
 * 3. **Answer.** The approval delivery coordinator accepts an answer only
 *    from the journaled responder ({@link checkRemoteInputResponder}): a
 *    different person is refused and the request stays pending; an answer
 *    whose channel cannot name its responder fails the call closed.
 * 4. **Continue.** On approve, {@link loadRemoteInputContinuations} moves
 *    the retry payload into virtual context and the AI SDK re-runs the
 *    approved call; the tool reads it with
 *    {@link takeRemoteInputContinuation} and retries with the answer. On
 *    deny, the call ends as denied and nothing is sent back.
 * 5. **Ask again.** A re-run call can return another signal (a sign-in the
 *    user has not finished). The AI SDK runs it before the model step, so
 *    its call sits in earlier history: parking moves the call to the end of
 *    the response with a new request id (`remote-input_<callId>_<n>`) and
 *    drops its earlier approval parts. The tool bounds how often it asks,
 *    using `attempt` from the continuation.
 */

import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { isObject } from "#shared/guards.js";
import type { InputRequest } from "#shared/input.js";

const REMOTE_INPUT_SIGNAL_BRAND = "__eveRemoteInputSignal";
const REMOTE_INPUT_PENDING_BRAND = "__eveRemoteInputPending";
const PENDING_REMOTE_INPUTS_KEY = "eve.runtime.pendingRemoteInputs";
const REQUEST_ID_PREFIX = "remote-input_";

/** Opaque retry payload: sent back to the server on approve, never inspected here. */
export interface RemoteInputRetry {
  /** How many times this call has already asked; bounds sign-in re-asks. Not sent. */
  readonly attempt?: number;
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
  /**
   * The arguments the first round actually sent, after host-provided
   * arguments were resolved. A retry resends them unchanged, because the
   * server binds `requestState` to them. Never shown to the model.
   */
  readonly resolvedArguments?: unknown;
}

/** Returned from a tool's `execute` to park the call until its user answers. */
export interface RemoteInputSignal {
  readonly [REMOTE_INPUT_SIGNAL_BRAND]: true;
  /** What the call retries with when the user approves. */
  readonly approve: RemoteInputRetry;
  /** Connection that asked, for the model-facing placeholder. */
  readonly connection: string;
  /** The server's question, shown to the user. */
  readonly prompt: string;
}

/** Model-facing stand-in for a {@link RemoteInputSignal}: no prompt, no retry payload. */
export interface RemoteInputPendingOutput {
  readonly [REMOTE_INPUT_PENDING_BRAND]: true;
  readonly connection: string;
}

export function requestRemoteInput(input: {
  readonly approve: RemoteInputRetry;
  readonly connection: string;
  readonly prompt: string;
}): RemoteInputSignal {
  return { [REMOTE_INPUT_SIGNAL_BRAND]: true, ...input };
}

export function isRemoteInputSignal(value: unknown): value is RemoteInputSignal {
  return isObject(value) && value[REMOTE_INPUT_SIGNAL_BRAND] === true;
}

export function isRemoteInputPendingOutput(value: unknown): value is RemoteInputPendingOutput {
  return isObject(value) && value[REMOTE_INPUT_PENDING_BRAND] === true;
}

/** Whether a tool output is a remote input interrupt, full or model-facing. */
export function isPendingRemoteInputToolOutput(value: unknown): boolean {
  return isRemoteInputSignal(value) || isRemoteInputPendingOutput(value);
}

export function modelFacingRemoteInputOutput(signal: RemoteInputSignal): RemoteInputPendingOutput {
  return { [REMOTE_INPUT_PENDING_BRAND]: true, connection: signal.connection };
}

export function remoteInputPendingModelText(connection: string): string {
  return `Waiting for the user to answer a request from connection "${connection}".`;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** One parked remote input, journaled on `session.state` across the park. */
export interface PendingRemoteInput {
  readonly callId: string;
  readonly connection: string;
  readonly requestId: string;
  /** The only person whose answer counts: the user the call ran for. */
  readonly responder: SessionAuthContext | null;
  readonly retry: RemoteInputRetry;
}

export function getPendingRemoteInputs(
  state: SessionStateMap | undefined,
): readonly PendingRemoteInput[] {
  const value = state?.[PENDING_REMOTE_INPUTS_KEY];
  return Array.isArray(value) ? (value as PendingRemoteInput[]) : [];
}

export function getPendingRemoteInput(
  state: SessionStateMap | undefined,
  requestId: string,
): PendingRemoteInput | undefined {
  return getPendingRemoteInputs(state).find((entry) => entry.requestId === requestId);
}

function setPendingRemoteInputs(
  state: SessionStateMap | undefined,
  entries: readonly PendingRemoteInput[],
): SessionStateMap {
  const { [PENDING_REMOTE_INPUTS_KEY]: _previous, ...rest } = state ?? {};
  return entries.length === 0 ? rest : { ...rest, [PENDING_REMOTE_INPUTS_KEY]: [...entries] };
}

/** Whether an input request is a remote input (journaled by {@link parkRemoteInputs}). */
export function isRemoteInputRequestId(requestId: string): boolean {
  return requestId.startsWith(REQUEST_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Park
// ---------------------------------------------------------------------------

type AssistantPart = Exclude<
  Extract<ModelMessage, { role: "assistant" }>["content"],
  string
>[number];
type ToolCallPart = Extract<AssistantPart, { type: "tool-call" }>;

/**
 * Converts this step's remote input interrupts into approval requests on
 * their calls. Returns `undefined` when no tool interrupted for remote input.
 *
 * A call asked in this step gets its approval request next to its call in
 * `messages`. A call the AI SDK resumed from an earlier step (an approved
 * call that asked again) has its call in `history`: the call moves to the end
 * of `messages` with a fresh approval request, and its earlier approval parts
 * leave `history`, so the next answer re-runs it and the call still sits right
 * before its result. A resumed call found nowhere fails with an error result.
 */
export function parkRemoteInputs(input: {
  readonly history?: readonly ModelMessage[];
  readonly messages: readonly ModelMessage[];
  readonly responder: SessionAuthContext | null;
  readonly state: SessionStateMap | undefined;
  readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
}):
  | {
      readonly history: ModelMessage[];
      readonly messages: ModelMessage[];
      readonly requests: InputRequest[];
      readonly state: SessionStateMap;
    }
  | undefined {
  const history = input.history ?? [];
  const signals = collectRemoteInputSignals(input.messages, input.toolResults);
  if (signals.size === 0) return undefined;

  const stepCallIds = new Set(toolCallParts(input.messages).map((part) => part.toolCallId));
  const resumedCalls = new Map<string, ToolCallPart>();
  for (const part of toolCallParts(history)) {
    if (signals.has(part.toolCallId) && !stepCallIds.has(part.toolCallId)) {
      resumedCalls.set(part.toolCallId, part);
    }
  }

  const requests: InputRequest[] = [];
  const entries: PendingRemoteInput[] = [];
  const park = (part: ToolCallPart): AssistantPart => {
    const signal = signals.get(part.toolCallId)!;
    const requestId = nextRemoteInputRequestId(part.toolCallId, [...history, ...input.messages]);
    requests.push({
      action: createRuntimeToolCallActionFromToolCall({ toolCall: part }),
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: signal.prompt,
      requestId,
    });
    entries.push({
      callId: part.toolCallId,
      connection: signal.connection,
      requestId,
      responder: input.responder,
      retry: signal.approve,
    });
    return { approvalId: requestId, toolCallId: part.toolCallId, type: "tool-approval-request" };
  };

  const messages: ModelMessage[] = input.messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.flatMap((part) =>
        part.type === "tool-call" && signals.has(part.toolCallId) ? [part, park(part)] : [part],
      ),
    };
  });
  const parked = new Set([...stepCallIds].filter((callId) => signals.has(callId)));
  for (const callId of resumedCalls.keys()) parked.add(callId);

  const projected = messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "tool") return [message];
    const content = message.content.flatMap((part) => {
      if (part.type !== "tool-result" || !signals.has(part.toolCallId)) return [part];
      if (parked.has(part.toolCallId)) return [];
      return [
        {
          ...part,
          output: {
            type: "error-text" as const,
            value:
              `Connection "${signals.get(part.toolCallId)!.connection}" asked for input on a ` +
              "call eve can no longer find. Call the tool again.",
          },
        },
      ];
    });
    return content.length === 0 ? [] : [{ ...message, content }];
  });

  const resumedParts = [...resumedCalls.values()].flatMap((part) => [part, park(part)]);
  if (resumedParts.length > 0) {
    const last = projected.at(-1);
    if (last?.role === "assistant" && typeof last.content !== "string") {
      projected[projected.length - 1] = { ...last, content: [...last.content, ...resumedParts] };
    } else {
      projected.push({ content: resumedParts, role: "assistant" });
    }
  }

  return {
    history: resumedCalls.size === 0 ? [...history] : withoutCalls(history, resumedCalls),
    messages: projected,
    requests,
    state: setPendingRemoteInputs(input.state, [
      ...getPendingRemoteInputs(input.state).filter(
        (entry) => !entries.some((next) => next.callId === entry.callId),
      ),
      ...entries,
    ]),
  };
}

/**
 * Signals from this step's tool results, plus calls the AI SDK resumed before
 * the model step: those surface only as a tool result in `messages` whose
 * output is the pending placeholder, with the full signal stashed.
 */
function collectRemoteInputSignals(
  messages: readonly ModelMessage[],
  toolResults: readonly TypedToolResult<ToolSet>[] | undefined,
): Map<string, RemoteInputSignal> {
  const signals = new Map<string, RemoteInputSignal>();
  for (const toolResult of toolResults ?? []) {
    const signal = readRemoteInputSignal(toolResult);
    if (signal !== undefined) signals.set(toolResult.toolCallId, signal);
  }
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return signals;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || signals.has(part.toolCallId)) continue;
      const stashed = readToolInterrupt(ctx, part.toolCallId);
      if (
        isRemoteInputSignal(stashed) &&
        part.output.type === "text" &&
        part.output.value === remoteInputPendingModelText(stashed.connection)
      ) {
        signals.set(part.toolCallId, stashed);
      }
    }
  }
  return signals;
}

function toolCallParts(messages: readonly ModelMessage[]): ToolCallPart[] {
  return messages.flatMap((message) =>
    message.role === "assistant" && typeof message.content !== "string"
      ? message.content.filter((part): part is ToolCallPart => part.type === "tool-call")
      : [],
  );
}

/**
 * `remote-input_<callId>` for a call's first ask, then `remote-input_<callId>_<n>`
 * for its n-th, so every ask is a new request channels render fresh.
 */
function nextRemoteInputRequestId(callId: string, messages: readonly ModelMessage[]): string {
  const base = `${REQUEST_ID_PREFIX}${callId}`;
  let asks = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-approval-request" || part.toolCallId !== callId) continue;
      if (part.approvalId === base) asks = Math.max(asks, 1);
      else if (part.approvalId.startsWith(`${base}_`)) {
        const ask = Number(part.approvalId.slice(base.length + 1));
        if (Number.isInteger(ask)) asks = Math.max(asks, ask);
      }
    }
  }
  return asks === 0 ? base : `${base}_${asks + 1}`;
}

/** Drops the calls, their approval requests, and the answers to them from `history`. */
function withoutCalls(
  history: readonly ModelMessage[],
  calls: ReadonlyMap<string, ToolCallPart>,
): ModelMessage[] {
  const approvalIds = new Set<string>();
  for (const message of history) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && calls.has(part.toolCallId)) {
        approvalIds.add(part.approvalId);
      }
    }
  }
  return history.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && typeof message.content !== "string") {
      const content = message.content.filter(
        (part) =>
          !(
            (part.type === "tool-call" || part.type === "tool-approval-request") &&
            calls.has(part.toolCallId)
          ),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-approval-response" || !approvalIds.has(part.approvalId),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

function readRemoteInputSignal(
  toolResult: TypedToolResult<ToolSet>,
): RemoteInputSignal | undefined {
  if (isRemoteInputSignal(toolResult.output)) return toolResult.output;
  if (!isRemoteInputPendingOutput(toolResult.output)) return undefined;
  const ctx = contextStorage.getStore();
  const stashed = ctx === undefined ? undefined : readToolInterrupt(ctx, toolResult.toolCallId);
  return isRemoteInputSignal(stashed) ? stashed : undefined;
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/**
 * Who may answer a remote input request:
 *
 * - `accept`: the user the call ran for.
 * - `refuse`: someone else. The request stays pending for the right person.
 * - `fail-closed`: nobody can be named (the channel reports no responder, or
 *   the call ran for no authenticated user). The call fails as cancelled.
 *
 * `undefined` when `requestId` is not a parked remote input.
 */
export function checkRemoteInputResponder(
  state: SessionStateMap | undefined,
  requestId: string,
  responder: SessionAuthContext | null,
): "accept" | "fail-closed" | "refuse" | undefined {
  const entry = getPendingRemoteInput(state, requestId);
  if (entry === undefined) return undefined;
  if (entry.responder === null || responder === null) return "fail-closed";
  return samePerson(entry.responder, responder) ? "accept" : "refuse";
}

export const REMOTE_INPUT_REFUSED_FEEDBACK =
  "Only the person this request was made for can answer it.";
export const REMOTE_INPUT_FAILED_CLOSED_FEEDBACK =
  "This request was cancelled: only the person it was made for can answer it, " +
  "and this answer did not say who sent it.";

function samePerson(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    left.issuer === right.issuer &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

// ---------------------------------------------------------------------------
// Continue
// ---------------------------------------------------------------------------

const RemoteInputContinuationsKey = new ContextKey<Readonly<Record<string, RemoteInputRetry>>>(
  "eve.remoteInputContinuations",
);

/**
 * Settles journaled remote inputs whose requests resolved this step. An
 * approved one becomes a continuation the re-run call reads; a denied one is
 * dropped. Entries whose request is no longer pending are pruned.
 */
export function loadRemoteInputContinuations(input: {
  readonly context: AlsContext | undefined;
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly resolved:
    | readonly {
        readonly inputs: readonly {
          readonly outcome: string;
          readonly request: Pick<InputRequest, "requestId">;
        }[];
      }[]
    | undefined;
  readonly session: HarnessSession;
}): HarnessSession {
  const entries = getPendingRemoteInputs(input.session.state);
  if (entries.length === 0) return input.session;
  const outcomes = new Map<string, string>();
  for (const batch of input.resolved ?? []) {
    for (const resolved of batch.inputs) outcomes.set(resolved.request.requestId, resolved.outcome);
  }
  const continuations: Record<string, RemoteInputRetry> = {};
  const remaining: PendingRemoteInput[] = [];
  for (const entry of entries) {
    const outcome = outcomes.get(entry.requestId);
    if (outcome === "approved") continuations[entry.callId] = entry.retry;
    else if (outcome === undefined && input.pendingRequestIds.has(entry.requestId)) {
      remaining.push(entry);
    }
  }
  if (Object.keys(continuations).length > 0) {
    input.context?.setVirtualContext(RemoteInputContinuationsKey, {
      ...input.context.get(RemoteInputContinuationsKey),
      ...continuations,
    });
  }
  if (remaining.length === entries.length) return input.session;
  return { ...input.session, state: setPendingRemoteInputs(input.session.state, remaining) };
}

/**
 * The approved answer for a call parked on remote input, when this run is
 * its continuation. Each continuation is read once.
 */
export function takeRemoteInputContinuation(callId: string): RemoteInputRetry | undefined {
  const ctx = contextStorage.getStore();
  const continuations = ctx?.get(RemoteInputContinuationsKey);
  const continuation = continuations?.[callId];
  if (ctx === undefined || continuation === undefined) return undefined;
  const { [callId]: _taken, ...rest } = continuations!;
  ctx.setVirtualContext(RemoteInputContinuationsKey, rest);
  return continuation;
}
