// What eve's in-process host needs from a Workflow World: the part of its interface it reads and
// writes. Any World fits (`world-fit.ts` checks it against Workflow's own type), and so does
// `memoryWorld()`, which keeps everything in this process. Nothing here imports Workflow, so the
// host-neutral core can name it.
//
// A session is one World run that no workflow executes. Its log holds what the session
// continues from (eve-named `step_created` events), and its stream holds the session's lines.

/** One event on a run's log, as eve reads it. */
export interface WorldEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly correlationId?: string;
  readonly eventData?: unknown;
  readonly createdAt: Date;
}

/** One page of a list, newest or oldest first, with the cursor of the next. */
export interface WorldPage<T> {
  readonly data: readonly T[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface WorldPagination {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sortOrder?: "asc" | "desc";
}

/** The events eve writes. */
export type WorldEventRequest =
  | {
      readonly eventType: "run_created";
      readonly eventData: {
        readonly deploymentId: string;
        readonly workflowName: string;
        readonly input: Uint8Array;
        /** `queueNamespace` names the queue a World's recovery re-enqueues the run on. */
        readonly executionContext?: Readonly<Record<string, unknown>>;
        /** The run's attributes; reserved ones (`$retention`) need `allowReservedAttributes`. */
        readonly attributes?: Readonly<Record<string, string>>;
        readonly allowReservedAttributes?: true;
      };
      readonly specVersion?: number;
    }
  | {
      /** An address on the run: what's sent to `token` arrives as its `hook_received`. */
      readonly eventType: "hook_created";
      readonly correlationId: string;
      readonly eventData: { readonly token: string };
      readonly specVersion?: number;
    }
  | {
      /** What arrived at the hook `correlationId` names, written by whoever sent it. */
      readonly eventType: "hook_received";
      readonly correlationId: string;
      readonly eventData: { readonly payload: Uint8Array };
      readonly specVersion?: number;
    }
  | { readonly eventType: "run_started"; readonly specVersion?: number }
  | {
      /** The run ended: the World disposes its hooks, and keeps its data as its retention says. */
      readonly eventType: "run_completed";
      readonly eventData: { readonly output?: Uint8Array };
      readonly specVersion?: number;
    }
  | {
      readonly eventType: "step_created";
      readonly correlationId: string;
      readonly eventData: { readonly stepName: string; readonly input: Uint8Array };
      readonly specVersion?: number;
    };

/**
 * How a write is fenced, on a run created at spec 9 on a World with `capabilities.inBandFence`:
 * the World accepts an in-band write only while the run's in-band count is `expectedSeqInBand`,
 * and refuses it otherwise (`InBandSupersededError`) writing nothing. `eventCount` is the highest
 * position the writer knows of (Vercel's World requires it on an in-band write).
 */
export interface WorldCreateParams {
  readonly inBand?: boolean;
  readonly expectedSeqInBand?: number;
  readonly eventCount?: number;
}

/** A run's counters as a World read them before listing its log (spec 9 runs). */
export interface WorldLogSnapshot {
  /** The highest position written. */
  readonly seq: number;
  /** How many positions in-band writes took. */
  readonly seqInBand: number;
}

/** A run, as a list of runs names it. */
export interface WorldRun {
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: Date;
}

/** One chunk of a stream, at its index. */
export interface WorldStreamChunk {
  readonly index: number;
  readonly data: Uint8Array;
}

/** One delivery of a queue message, as Workflow's `Queue.createQueueHandler` describes it. */
export interface WorldQueueDelivery {
  /** Deliveries counted toward the message's retries: a handoff's next one isn't. */
  readonly attempt: number;
  /** 1 on the message's first delivery, then one more on every redelivery, when known. */
  readonly deliveryCount?: number;
  /** The message's id, the same on each of its deliveries. */
  readonly messageId: string;
  /** When the invocation running this delivery began (epoch ms), when the World knows. */
  readonly invocationStartedAt?: number;
}

/**
 * A World with its queue and hooks: what a host that runs sessions only when something arrives
 * needs (`#execution/world-host`). Workflow's Worlds are one. A message names a run
 * (`{ runId, runSpecVersion: 9 }`), and the World delivers one of a spec 9 run's messages at a
 * time, which keeps one process driving a session. A handler's `{ timeoutSeconds: 0 }` asks for
 * the same message again at once (a handoff); `{ timeoutSeconds: n }`, again in about `n`
 * seconds. Anything else acknowledges it; a throw retries it.
 */
export interface QueueWorld extends RuntimeWorld {
  readonly hooks: NonNullable<RuntimeWorld["hooks"]>;
  queue(
    queueName: string,
    message: unknown,
    options?: { readonly delaySeconds?: number; readonly idempotencyKey?: string },
  ): Promise<unknown>;
  createQueueHandler(
    prefix: string,
    handler: (message: unknown, delivery: WorldQueueDelivery) => Promise<unknown>,
  ): (request: Request) => Promise<Response>;
  /** Delivers a prefix's messages in this process, where the World's queue runs here. */
  registerHandler?(prefix: string, handler: (request: Request) => Promise<Response>): void;
  /** Starts delivering, where the World's queue runs in this process. */
  start?(): Promise<void>;
  close?(): Promise<void>;
}

export interface RuntimeWorld {
  readonly specVersion?: number;
  /** What the World supports; eve reads only the in-band fence. */
  readonly capabilities?: { readonly inBandFence?: boolean };
  getDeploymentId(): Promise<string>;
  readonly events: {
    /** Appends an event to `runId`'s log. A second `run_created` for one run is a conflict. */
    create(runId: string, data: WorldEventRequest, params?: WorldCreateParams): Promise<unknown>;
    /**
     * A page of `runId`'s log, with the run's counters on a spec 9 run (`specVersion: 9` asks for
     * them). Throws a run-not-found error for a run the World never held.
     */
    list(params: {
      readonly runId: string;
      readonly pagination?: WorldPagination;
      readonly resolveData?: "none" | "all";
      readonly specVersion?: number;
    }): Promise<WorldPage<WorldEvent> & { readonly snapshot?: WorldLogSnapshot }>;
  };
  /** The run holding a hook, by its token: what a sender resolves an address to. */
  readonly hooks?: {
    getByToken(
      token: string,
    ): Promise<{ readonly hookId: string; readonly runId: string; readonly token: string }>;
  };
  readonly runs: {
    list(params: {
      readonly workflowName?: string;
      readonly pagination?: WorldPagination;
      readonly resolveData: "none";
    }): Promise<WorldPage<WorldRun>>;
    /**
     * One run, with when its data expired (`expiredAt`): a run whose retention is zero expires
     * once it ends, and what it left behind (a stream's chunks) is no longer to be read. Optional:
     * a World without it expires nothing. Throws a run-not-found error for a run it never held.
     */
    get?(
      runId: string,
      params: { readonly resolveData: "none" },
    ): Promise<WorldRun & { readonly expiredAt?: Date }>;
  };
  readonly streams: {
    /** Appends one chunk; it's stored once this resolves. */
    write(runId: string, name: string, chunk: string | Uint8Array): Promise<void>;
    /**
     * Appends chunks in order in one operation (one request on Vercel's World); they're stored
     * once this resolves. Optional: without it, chunks are written one at a time.
     */
    writeMulti?(runId: string, name: string, chunks: (string | Uint8Array)[]): Promise<void>;
    close(runId: string, name: string): Promise<void>;
    getChunks(
      runId: string,
      name: string,
      options?: { readonly limit?: number; readonly cursor?: string },
    ): Promise<{
      readonly data: readonly WorldStreamChunk[];
      readonly cursor: string | null;
      readonly hasMore: boolean;
      readonly done: boolean;
    }>;
    /** The index of the last chunk (`-1` before the first), and whether the stream closed. */
    getInfo(
      runId: string,
      name: string,
    ): Promise<{ readonly tailIndex: number; readonly done: boolean }>;
    /**
     * A live read from chunk `startIndex` on, which waits for chunks written later, when the World
     * has one: a reader far into a long stream starts there rather than paging from its start.
     */
    get?(runId: string, name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>;
  };
}
