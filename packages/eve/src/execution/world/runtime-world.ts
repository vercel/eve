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
      };
      readonly specVersion?: number;
    }
  | { readonly eventType: "run_started"; readonly specVersion?: number }
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
  readonly runs: {
    list(params: {
      readonly workflowName?: string;
      readonly pagination?: WorldPagination;
      readonly resolveData: "none";
    }): Promise<WorldPage<WorldRun>>;
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
  };
}
