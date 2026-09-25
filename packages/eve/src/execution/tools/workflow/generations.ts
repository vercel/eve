import type { WorkflowToolRunOutcome } from "#execution/tools/workflow/messages.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// The generation state of one resumable workflow tool run. It lives in the
// workflow body's memory, so the Workflow SDK rebuilds it on every replay
// from the same hook payloads in the same order: no Node.js built-ins, no
// clocks, no randomness.

/** The call that started a generation: its context (`ctx.callId`, the turn, `ctx.ask`). */
export interface GenerationCall {
  readonly callId: string;
  readonly input: JsonObject;
  readonly stepIndex: number;
  readonly turn: { readonly id: string; readonly sequence: number };
}

/**
 * What the run reports to its owner, in order. `reports` counts the body's
 * progress reports sent before a reply; the run relays the reply only after
 * relaying them.
 */
export type GenerationEvent =
  | {
      readonly kind: "started";
      readonly generation: number;
      readonly send: number;
      readonly call: GenerationCall;
    }
  | {
      readonly kind: "reply";
      readonly generation: number;
      readonly call: GenerationCall;
      readonly result: WorkflowToolRunOutcome;
      readonly read: readonly number[];
      readonly reports: number;
    };

/** Thrown into a pending or later `ctx.receive()` once the task has ended. */
export class TaskEndedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TaskEndedError";
  }
}

export interface Generations {
  readonly generation: number;
  readonly call: GenerationCall;
  /** The current generation has its result; the body owns no work until it reads again. */
  readonly replied: boolean;
  /** The current generation's signal (`ctx.abortSignal`); each generation gets a fresh one. */
  readonly signal: AbortSignal;
  /** Wakes the run loop when events are queued; values carry nothing. */
  readonly wakes: AsyncIterable<void>;
  /** Run loop: the oldest queued event, if its earlier reports were relayed. */
  next(relayedReports: number): GenerationEvent | undefined;
  /** Run loop: a send from the command hook. A duplicate seq is ignored. */
  deliver(seq: number, input: JsonObject, call: GenerationCall): void;
  /** Run loop: stops the current generation and every send queued for it. */
  cancel(reason: string): void;
  /** Run loop: the task stops taking input. */
  end(reason: string): void;
  /**
   * Run loop: the body finished, which ends the task. Its outcome settles a
   * generation that has not replied; after a reply, it is `ignored`. Returns
   * the sends the body never read.
   */
  finish(outcome: WorkflowToolRunOutcome): {
    readonly unread: readonly number[];
    readonly ignored?: WorkflowToolRunOutcome;
  };
  /** Body: one progress report sent. */
  noteReport(): void;
  /** Body: `ctx.receive()`. */
  receive(): Promise<JsonObject>;
  /** Body: `ctx.reply(output)`. */
  reply(output: JsonValue): void;
}

interface QueuedSend {
  readonly seq: number;
  readonly input: JsonObject;
  readonly call: GenerationCall;
  /** A cancel landed while this send was queued: its generation settles `cancelled`. */
  cancelled?: true;
}

export function createGenerations(first: GenerationCall): Generations {
  let generation = 1;
  let call = first;
  let replied = false;
  let cancelled = false;
  let ended: string | undefined;
  let controller = new AbortController();
  let read: number[] = [];
  let reports = 0;
  const seen = new Set<number>();
  const queue: QueuedSend[] = [];
  const events: GenerationEvent[] = [];
  let waker: (() => void) | undefined;
  let pending:
    | {
        readonly promise: Promise<JsonObject>;
        readonly resolve: (input: JsonObject) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;

  const push = (event: GenerationEvent) => {
    events.push(event);
    const wake = waker;
    waker = undefined;
    wake?.();
  };

  const begin = (send: QueuedSend) => {
    generation += 1;
    call = send.call;
    replied = false;
    cancelled = false;
    controller = new AbortController();
    read = [];
    push({ call, generation, kind: "started", send: send.seq });
  };

  const settle = (result: WorkflowToolRunOutcome) => {
    replied = true;
    push({ call, generation, kind: "reply", read, reports, result });
    read = [];
    settleCancelledSends();
  };

  // Sends a cancel stopped settle as their own generations, never run.
  const settleCancelledSends = () => {
    while (queue[0]?.cancelled === true) {
      begin(queue.shift()!);
      settle({ status: "cancelled" });
    }
  };

  // A cancelled generation the body leaves by reading again settles `cancelled`.
  const confirmCancel = () => {
    if (cancelled && !replied) settle({ status: "cancelled" });
  };

  const pump = () => {
    if (pending === undefined || queue.length === 0) return;
    confirmCancel();
    const next = queue.shift();
    if (next === undefined) return;
    if (replied) begin(next);
    else read.push(next.seq);
    const { resolve } = pending;
    pending = undefined;
    resolve(next.input);
  };

  return {
    get call() {
      return call;
    },
    get generation() {
      return generation;
    },
    get replied() {
      return replied;
    },
    get signal() {
      return controller.signal;
    },
    wakes: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          events.length > 0
            ? Promise.resolve({ done: false as const, value: undefined })
            : new Promise<IteratorResult<void>>((resolve) => {
                waker = () => resolve({ done: false, value: undefined });
              }),
      }),
    },
    next(relayedReports) {
      const head = events[0];
      if (head === undefined || (head.kind === "reply" && head.reports > relayedReports)) {
        return undefined;
      }
      return events.shift();
    },
    deliver(seq, input, sendCall) {
      if (seen.has(seq)) return;
      seen.add(seq);
      queue.push({ call: sendCall, input, seq });
      if (ended === undefined) pump();
    },
    cancel(reason) {
      if (ended !== undefined) return;
      for (const send of queue) send.cancelled = true;
      if (replied) {
        settleCancelledSends();
        return;
      }
      if (cancelled) return;
      cancelled = true;
      controller.abort(new Error(reason));
    },
    end(reason) {
      if (ended !== undefined) return;
      ended = reason;
      controller.abort(new TaskEndedError(reason));
      const waiting = pending;
      pending = undefined;
      waiting?.reject(new TaskEndedError(reason));
    },
    finish(outcome) {
      const ignored = replied ? outcome : undefined;
      if (!replied) settle(cancelled ? { status: "cancelled" } : outcome);
      return { ignored, unread: queue.map((send) => send.seq) };
    },
    noteReport() {
      reports += 1;
    },
    receive() {
      if (ended !== undefined) return Promise.reject(new TaskEndedError(ended));
      confirmCancel();
      if (pending !== undefined) return pending.promise;
      let resolve!: (input: JsonObject) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<JsonObject>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      pending = { promise, reject, resolve };
      pump();
      return promise;
    },
    reply(output) {
      if (replied) {
        throw new Error(
          `ctx.reply() was already called for generation ${String(generation)} of this task. Each generation ends with exactly one reply; call ctx.receive() to wait for the next input first.`,
        );
      }
      settle(cancelled ? { status: "cancelled" } : { output, status: "completed" });
    },
  };
}
