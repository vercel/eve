import {
  EVE_ACTIVITY_STREAM_FORMAT,
  EVE_ACTIVITY_STREAM_VERSION,
  parseActivitySnapshotV1,
  type ActivitySnapshotV1,
} from "#protocol/activity.js";
import { EVE_STREAM_FORMAT_HEADER, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
import { createEveSessionActivityStreamRoutePath } from "#protocol/routes.js";
import { readJsonNdjsonStream } from "#client/ndjson.js";
import { followDurableStreamIterable } from "#client/open-stream.js";
import type { ClientSessionContext } from "#client/session.js";
import type {
  ActivitySessionSnapshot,
  StreamOptions,
  StreamReconnectPolicy,
} from "#client/types.js";

/** Activity snapshots associated with one fixed root session. */
export class ClientSessionActivity {
  readonly #context: ClientSessionContext;
  readonly #sessionId: string;
  #streamIndex = 0;

  /** @internal */
  constructor(context: ClientSessionContext, sessionId: string) {
    this.#context = context;
    this.#sessionId = sessionId;
  }

  /** Current activity-stream cursor. */
  get streamIndex(): number {
    return this.#streamIndex;
  }

  /** Reads the latest persisted snapshot without advancing this handle. */
  async snapshot(options?: { readonly signal?: AbortSignal }): Promise<ActivitySessionSnapshot> {
    options?.signal?.throwIfAborted();
    let snapshot: ActivitySnapshotV1 | undefined;
    let streamIndex = 0;
    for await (const update of this.#read({
      follow: false,
      signal: options?.signal,
      startIndex: 0,
    })) {
      snapshot = update;
      streamIndex += 1;
    }
    options?.signal?.throwIfAborted();
    return { snapshot, session: { sessionId: this.#sessionId, streamIndex } };
  }

  /** Opens the durable activity snapshot stream and advances its independent cursor. */
  stream(options?: StreamOptions): AsyncIterable<ActivitySnapshotV1> {
    const startIndex = options?.startIndex ?? this.#streamIndex;
    if (options?.follow === false && startIndex < 0) {
      throw new Error(
        "activity.stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
      );
    }
    return this.#streamAndAdvance(startIndex, options);
  }

  async *#streamAndAdvance(
    startIndex: number,
    options?: StreamOptions,
  ): AsyncGenerator<ActivitySnapshotV1> {
    let count = 0;
    try {
      for await (const snapshot of this.#read({
        follow: options?.follow,
        signal: options?.signal,
        startIndex,
        streamReconnectPolicy: options?.streamReconnectPolicy,
      })) {
        count += 1;
        yield snapshot;
      }
    } finally {
      if (startIndex >= 0) this.#streamIndex = Math.max(this.#streamIndex, startIndex + count);
    }
  }

  #read(input: {
    readonly follow?: boolean;
    readonly signal?: AbortSignal;
    readonly startIndex: number;
    readonly streamReconnectPolicy?: StreamOptions["streamReconnectPolicy"];
  }): AsyncIterable<ActivitySnapshotV1> {
    return followDurableStreamIterable(
      {
        follow: input.follow,
        host: this.#context.host,
        path: createEveSessionActivityStreamRoutePath(this.#sessionId),
        redirect: this.#context.redirect,
        resolveHeaders: () => this.#context.resolveHeaders(),
        sessionId: this.#sessionId,
        signal: input.signal,
        startIndex: input.startIndex,
        streamReconnectPolicy: activityReconnectPolicy(input.streamReconnectPolicy),
      },
      (connection, idleTimeoutMs) => {
        if (
          connection.headers.get(EVE_STREAM_FORMAT_HEADER) !== EVE_ACTIVITY_STREAM_FORMAT ||
          connection.headers.get(EVE_STREAM_VERSION_HEADER) !== EVE_ACTIVITY_STREAM_VERSION
        ) {
          throw new Error("Activity stream returned an unsupported format or version.");
        }
        return readJsonNdjsonStream(connection.body, {
          idleTimeoutMs,
          parse: parseActivitySnapshot,
        });
      },
    );
  }
}

function activityReconnectPolicy(policy: StreamReconnectPolicy | undefined): StreamReconnectPolicy {
  if (policy && "reconnect" in policy) return policy;
  return {
    ...policy,
    retryableErrorStatuses: (
      policy?.retryableErrorStatuses ?? [409, 425, 500, 502, 503, 504]
    ).filter((status) => status !== 404),
  };
}

function parseActivitySnapshot(line: string): ActivitySnapshotV1 {
  const snapshot = parseActivitySnapshotV1(JSON.parse(line));
  if (snapshot === undefined) throw new Error("Activity stream returned an invalid snapshot.");
  return snapshot;
}
