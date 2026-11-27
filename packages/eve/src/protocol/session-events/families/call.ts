import { z } from "#compiled/zod/index.js";

import {
  cause,
  conforming,
  envelopeOf,
  errorInfo,
  id,
  jsonValue,
  known,
  valueReference,
} from "../common.js";
import type { Cause, Envelope, ErrorInfo, JsonValue, ValueReference } from "../envelope.js";

/**
 * What made a call: a model run, the call it runs inside, or its turn, for a call no model run
 * asked for. A newer eve can add one.
 */
export type CallOwner =
  | { readonly runId: string }
  | { readonly callId: string }
  | { readonly turnId: string };

/**
 * What a call can invoke: a tool, an agent, a skill to load, or `control`, the model managing its
 * own tasks (waiting on or cancelling them), which readers showing activity usually leave out. A
 * newer eve can add one: a reader's switch keeps a default branch.
 */
export type CapabilityKind = "tool" | "agent" | "skill" | "control";

/** What a call invokes. */
export interface Capability {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly label?: string;
  /** An `agent` another deployment serves: a remote agent, not a subagent of this one. */
  readonly remote?: true;
  /**
   * Its tool set `label: false`: readers showing activity leave the call out, as they do `control`
   * calls.
   */
  readonly hidden?: true;
}

/** A preview of a call's input as the model writes it. The first record announces the call. */
export interface CallInputData {
  readonly callId: string;
  /** On the announcing record only: the entry the model calls, and what it invokes. */
  readonly name?: string;
  readonly kind?: CapabilityKind;
  readonly delta: string;
}

/** The payload of `call.requested`: a call is introduced, with what asked for it, what it invokes, and its input. */
export interface CallRequestedData {
  readonly callId: string;
  readonly owner: CallOwner;
  readonly capability: Capability;
  readonly input?: JsonValue;
  readonly inputRef?: ValueReference;
  /** The model's input didn't validate; the call settles `failed` and never runs. */
  readonly inputError?: ErrorInfo;
  /** Estimated tokens of the input as the model sent it. Absent when the input didn't validate. */
  readonly inputTokens?: number;
}

/** What cleared a call to run. Absent when it needed no approval. */
export type ClearedBy = { readonly policy: string } | { readonly interactionId: string };

/** The payload of `call.started`: a call cleared to run begins. */
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
  readonly label?: string;
}

/** How a call ended, as recorded on `call.settled`. */
export type CallOutcome = "completed" | "failed" | "rejected" | "interrupted" | "abandoned";

/** The payload of `call.settled`: a call ends, with its outcome and output or error. */
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
  readonly label?: string;
  /**
   * Estimated tokens of the output or error the model receives. For a call that runs as a task
   * this estimates the raw task output, before the tool's `toModelOutput` and the cut applied
   * when task results are delivered, so it can overstate what the model reads.
   */
  readonly outputTokens?: number;
}

/** A progress record previewing a call's input as the model writes it. */
export type CallInput = Envelope<"call.input", CallInputData>;
/** The fact that introduces a call. */
export type CallRequested = Envelope<"call.requested", CallRequestedData>;
/** The fact recording that a call started running. */
export type CallStarted = Envelope<"call.started", CallStartedData>;
/** A progress record with a snapshot of a call's output so far. */
export type CallProgress = Envelope<"call.progress", CallProgressData>;
/** The terminal fact of a call. */
export type CallSettled = Envelope<"call.settled", CallSettledData>;
/** Any fact in the `call` family. */
export type CallFact = CallRequested | CallStarted | CallSettled;
/** Any progress record in the `call` family. */
export type CallProgressRecord = CallInput | CallProgress;

const owner = conforming<CallOwner>()(
  z.union([z.object({ runId: id }), z.object({ callId: id }), z.object({ turnId: id })]),
);

export const clearedBySchema = conforming<ClearedBy>()(
  z.union([z.object({ policy: z.string() }), z.object({ interactionId: id })]),
);

export const callSchemas = {
  "call.requested": envelopeOf(
    "call.requested",
    conforming<CallRequestedData>()(
      z.object({
        callId: id,
        capability: z.object({
          kind: known<CapabilityKind>(),
          name: z.string(),
          remote: z.literal(true).optional(),
          label: z.string().optional(),
          hidden: z.literal(true).optional(),
        }),
        input: jsonValue.optional(),
        inputError: errorInfo.optional(),
        inputRef: valueReference.optional(),
        inputTokens: z.number().int().nonnegative().optional(),
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
        outcome: known<CallOutcome>(),
        output: jsonValue.optional(),
        outputOf: z.object({ callId: id }).optional(),
        outputRef: valueReference.optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        reason: z.string().optional(),
        label: z.string().optional(),
      }),
    ),
  ),
  "call.started": envelopeOf(
    "call.started",
    conforming<CallStartedData>()(
      z.object({ callId: id, clearedBy: clearedBySchema.optional(), taskId: id.optional() }),
    ),
  ),
};

export const callProgressSchemas = {
  "call.input": envelopeOf(
    "call.input",
    conforming<CallInputData>()(
      z.object({
        callId: id,
        delta: z.string(),
        kind: known<CapabilityKind>().optional(),
        name: z.string().optional(),
      }),
    ),
  ),
  "call.progress": envelopeOf(
    "call.progress",
    conforming<CallProgressData>()(
      z.object({ callId: id, output: jsonValue, label: z.string().optional() }),
    ),
  ),
};
