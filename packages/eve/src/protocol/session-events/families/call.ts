import { z } from "#compiled/zod/index.js";

import { CALL_OUTCOMES } from "../catalog.js";
import {
  cause,
  conforming,
  envelopeOf,
  errorInfo,
  id,
  jsonValue,
  valueReference,
} from "../common.js";
import type { Cause, Envelope, ErrorInfo, JsonValue, ValueReference } from "../envelope.js";

/** What a call belongs to: the model run that made it, or the call it runs inside. */
export type CallOwner = { readonly runId: string } | { readonly callId: string };

/** What a call invokes. `kind` is open: `tool`, `agent`, and `skill` today. */
export interface Capability {
  readonly kind: "tool" | "agent" | "skill" | (string & {});
  readonly name: string;
  readonly title?: string;
}

/** A preview of a call's input as the model writes it. The first record announces the call. */
export interface CallInputData {
  readonly callId: string;
  /** On the announcing record only. */
  readonly name?: string;
  readonly delta: string;
}

export interface CallRequestedData {
  readonly callId: string;
  readonly owner: CallOwner;
  readonly capability: Capability;
  readonly input?: JsonValue;
  readonly inputRef?: ValueReference;
  /** The model's input didn't validate; the call settles `failed` and never runs. */
  readonly inputError?: ErrorInfo;
}

/** What cleared a call to run. Absent when it needed no approval. */
export type ClearedBy =
  | { readonly policy: string }
  | { readonly grant: { readonly interactionId: string } }
  | { readonly interactionId: string };

export interface CallStartedData {
  readonly callId: string;
  readonly clearedBy?: ClearedBy;
  /** The task that serves the call. */
  readonly taskId?: string;
}

/** A bounded snapshot of a call's output so far; the latest replaces earlier ones. */
export interface CallProgressData {
  readonly callId: string;
  readonly output: JsonValue;
  /** The call's label for this output, from the tool. */
  readonly title?: string;
}

export type CallOutcome = "completed" | "failed" | "rejected" | "interrupted" | "abandoned";

export interface CallSettledData {
  readonly callId: string;
  readonly outcome: CallOutcome;
  readonly output?: JsonValue;
  readonly outputRef?: ValueReference;
  /** The call whose `call.settled` carries this call's output, for calls a reply settled together. */
  readonly outputOf?: { readonly callId: string };
  readonly error?: ErrorInfo;
  /** Open: `turn-cancelled` and `authorization-required` for interrupted calls, among others. */
  readonly reason?: string;
  /** Who rejected the call: `{interactionId}` or `{policy}`. */
  readonly cause?: Cause;
  /** The call's label once it settled, from the tool. */
  readonly title?: string;
}

export type CallInput = Envelope<"call.input", CallInputData>;
export type CallRequested = Envelope<"call.requested", CallRequestedData>;
export type CallStarted = Envelope<"call.started", CallStartedData>;
export type CallProgress = Envelope<"call.progress", CallProgressData>;
export type CallSettled = Envelope<"call.settled", CallSettledData>;
export type CallFact = CallRequested | CallStarted | CallSettled;
export type CallProgressRecord = CallInput | CallProgress;

const owner = conforming<CallOwner>()(z.union([z.object({ runId: id }), z.object({ callId: id })]));

const clearedBy = conforming<ClearedBy>()(
  z.union([
    z.object({ policy: z.string() }),
    z.object({ grant: z.object({ interactionId: id }) }),
    z.object({ interactionId: id }),
  ]),
);

export const callSchemas = {
  "call.requested": envelopeOf(
    "call.requested",
    conforming<CallRequestedData>()(
      z.object({
        callId: id,
        capability: z.object({ kind: z.string(), name: z.string(), title: z.string().optional() }),
        input: jsonValue.optional(),
        inputError: errorInfo.optional(),
        inputRef: valueReference.optional(),
        owner,
      }),
    ),
  ),
  "call.settled": envelopeOf(
    "call.settled",
    conforming<CallSettledData>()(
      z.object({
        callId: id,
        cause: cause.optional(),
        error: errorInfo.optional(),
        outcome: z.enum(CALL_OUTCOMES),
        output: jsonValue.optional(),
        outputOf: z.object({ callId: id }).optional(),
        outputRef: valueReference.optional(),
        reason: z.string().optional(),
        title: z.string().optional(),
      }),
    ),
  ),
  "call.started": envelopeOf(
    "call.started",
    conforming<CallStartedData>()(
      z.object({ callId: id, clearedBy: clearedBy.optional(), taskId: id.optional() }),
    ),
  ),
};

export const callProgressSchemas = {
  "call.input": envelopeOf(
    "call.input",
    conforming<CallInputData>()(
      z.object({ callId: id, delta: z.string(), name: z.string().optional() }),
    ),
  ),
  "call.progress": envelopeOf(
    "call.progress",
    conforming<CallProgressData>()(
      z.object({ callId: id, output: jsonValue, title: z.string().optional() }),
    ),
  ),
};
