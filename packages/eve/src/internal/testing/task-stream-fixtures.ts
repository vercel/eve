import type {
  MessageStreamEvent,
  MessageStreamEventMeta,
  TaskSettledStreamEvent,
  TaskStartedStreamEvent,
} from "#protocol/message.js";

// Recorded session streams that each release publishes under
// `conformance/task-streams/v<N>/` so stream consumers can replay real
// `task.*` traffic in their own contract tests. The scenario suite records
// and checks them; the unit suite replays them through eve's own consumers.

/** Version of the fixture layout: the directory, the manifest shape, and the file format. */
export const TASK_STREAM_FIXTURE_VERSION = 1;

/** `manifest.json` beside the recorded streams. */
export interface TaskStreamFixtureManifest {
  readonly fixtureVersion: number;
  /** The `x-eve-stream-version` the streams were recorded with. */
  readonly streamVersion: string;
  /** The task protocol version of the deployments that recorded them. */
  readonly taskProtocolVersion: number;
  readonly description: string;
  readonly fixtures: readonly TaskStreamFixture[];
}

export interface TaskStreamFixture {
  readonly name: string;
  /** NDJSON file beside the manifest: one stream event per line, in recorded order. */
  readonly file: string;
  readonly description: string;
  /** Normalized ID of the recorded session. */
  readonly sessionId: string;
  /** Task states a consumer derives from the whole stream. */
  readonly tasks: readonly TaskStreamState[];
}

/** What a consumer knows about one task after reading a stream. */
export interface TaskStreamState {
  readonly taskId: string;
  readonly name: string;
  readonly kind?: TaskStartedStreamEvent["data"]["kind"];
  /** The `mode` of the task's first `task.started`. */
  readonly mode?: TaskStartedStreamEvent["data"]["mode"];
  readonly status: "working" | TaskSettledStreamEvent["data"]["status"];
  readonly errorCode?: string;
  /** `task.started` events for the task: one per generation. */
  readonly generations: number;
  readonly remote: boolean;
  /** Input requests surfaced on the stream with the task's ID. */
  readonly inputRequests: number;
  /** Whether a `task.result` input delivered the task's result. */
  readonly delivered: boolean;
}

type TaskStreamEvent = Extract<
  MessageStreamEvent,
  { readonly type: "task.settled" | "task.started" }
>;

export function isTaskStreamEvent(event: MessageStreamEvent): event is TaskStreamEvent {
  return event.type === "task.started" || event.type === "task.settled";
}

/**
 * The reference fold from stream events to task states. Tasks are keyed by
 * `taskId` and sorted by it, so a detached child's `task.started`, which
 * may land before or after its turn ends, does not change the result.
 */
export function deriveTaskStreamStates(
  events: readonly MessageStreamEvent[],
): readonly TaskStreamState[] {
  const toolNames = new Map<string, string>();
  const states = new Map<string, { -readonly [K in keyof TaskStreamState]: TaskStreamState[K] }>();
  const ensure = (taskId: string, callId?: string) => {
    let state = states.get(taskId);
    if (state === undefined) {
      state = {
        delivered: false,
        generations: 0,
        inputRequests: 0,
        name: (callId === undefined ? undefined : toolNames.get(callId)) ?? taskId,
        remote: false,
        status: "working",
        taskId,
      };
      states.set(taskId, state);
    }
    return state;
  };

  for (const event of events) {
    switch (event.type) {
      case "actions.requested":
        for (const action of event.data.actions) {
          if (action.kind === "tool-call") toolNames.set(action.callId, action.toolName);
        }
        break;
      case "task.started": {
        const state = ensure(event.data.taskId, event.data.callId);
        state.name = event.data.name;
        state.kind ??= event.data.kind;
        state.mode ??= event.data.mode;
        state.generations += 1;
        state.status = "working";
        delete state.errorCode;
        if (event.data.child?.remote !== undefined) state.remote = true;
        break;
      }
      case "task.settled": {
        const state = ensure(event.data.taskId, event.data.callId);
        state.status = event.data.status;
        if (event.data.error === undefined) delete state.errorCode;
        else state.errorCode = event.data.error.code;
        break;
      }
      case "input.requested":
        if (event.data.taskId !== undefined) {
          ensure(event.data.taskId).inputRequests += event.data.requests.length;
        }
        break;
      case "message.received":
        if (event.data.kind === "task.result") {
          for (const taskId of event.data.taskIds ?? []) ensure(taskId).delivered = true;
        }
        break;
    }
  }

  return [...states.values()].toSorted((left, right) => left.taskId.localeCompare(right.taskId));
}

/**
 * Every manifest key, in the order the published file lists them. Passed to
 * `JSON.stringify`, it keeps the manifest readable; a key missing here is
 * dropped, which the replay test's comparison with derived states catches.
 */
export const TASK_STREAM_MANIFEST_KEYS = [
  "fixtureVersion",
  "streamVersion",
  "taskProtocolVersion",
  "name",
  "description",
  "fixtures",
  "file",
  "sessionId",
  "tasks",
  "taskId",
  "kind",
  "mode",
  "status",
  "errorCode",
  "generations",
  "remote",
  "inputRequests",
  "delivered",
] as const satisfies readonly (
  | keyof TaskStreamFixtureManifest
  | keyof TaskStreamFixture
  | keyof TaskStreamState
)[];

/** Serializes events exactly as the stream route writes them: one JSON object per line. */
export function serializeTaskStream(events: readonly MessageStreamEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

export function parseTaskStream(text: string): MessageStreamEvent[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MessageStreamEvent);
}

const FIXTURE_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * Replaces every value that differs between two recordings of the same
 * scenario with a stable placeholder, keeping each event's shape. Sessions,
 * turns, tasks, requests, and deliveries are numbered in an order that does
 * not depend on when a detached child reported; `meta.id` and `meta.at`
 * follow the recorded order. Call IDs must be stable already, which a mock
 * model gets by naming every tool call's `id`.
 */
export function normalizeTaskStream(
  events: readonly MessageStreamEvent[],
  options: {
    readonly sessionId: string;
    /** Deployment origins mapped to example origins. */
    readonly origins?: Readonly<Record<string, string>>;
  },
): MessageStreamEvent[] {
  const replacements = new Map<string, string>();
  const assign = (value: string | undefined, placeholder: () => string) => {
    if (value !== undefined && value.length > 0 && !replacements.has(value)) {
      replacements.set(value, placeholder());
    }
  };
  for (const [origin, example] of Object.entries(options.origins ?? {})) {
    assign(origin, () => example);
  }
  assign(options.sessionId, () => "session-root");

  let turns = 0;
  for (const event of events) {
    if (event.type === "turn.started") assign(event.data.turnId, () => `turn-${++turns}`);
  }

  // Number tasks by the model call that started them, not by when their
  // events landed.
  const callOrder = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "actions.requested") continue;
    for (const action of event.data.actions) {
      if (!callOrder.has(action.callId)) callOrder.set(action.callId, callOrder.size);
    }
  }
  const firstCalls = new Map<string, string>();
  for (const event of events) {
    if (isTaskStreamEvent(event) && !firstCalls.has(event.data.taskId)) {
      firstCalls.set(event.data.taskId, event.data.callId);
    }
  }
  const tasks = [...firstCalls].toSorted(
    ([, left], [, right]) =>
      (callOrder.get(left) ?? callOrder.size) - (callOrder.get(right) ?? callOrder.size),
  );
  for (const [index, [taskId]] of tasks.entries()) {
    const name = taskId.slice(0, taskId.lastIndexOf("-"));
    assign(taskId, () => `${name}-${String(index + 1).padStart(6, "0")}`);
  }
  for (const event of events) {
    if (event.type === "task.started" && event.data.child !== undefined) {
      const task = replacements.get(event.data.taskId);
      assign(event.data.child.sessionId, () => `session-${task}`);
    }
  }

  let requests = 0;
  for (const event of events) {
    if (event.type !== "input.requested") continue;
    for (const request of event.data.requests) {
      assign(request.requestId, () => `request-${++requests}`);
    }
  }
  let deliveries = 0;
  const byDeliveryOrder = [
    ...events.filter((event) => !isTaskStreamEvent(event)),
    ...events.filter(isTaskStreamEvent),
  ];
  for (const event of byDeliveryOrder) {
    for (const deliveryId of event.meta.deliveryIds ?? []) {
      assign(deliveryId, () => `delivery-${++deliveries}`);
    }
  }

  const keys = [...replacements.keys()].toSorted((left, right) => right.length - left.length);
  const replace = (text: string) =>
    keys.reduce((result, key) => result.replaceAll(key, replacements.get(key)!), text);

  return events.map((event, index) => {
    const { meta, ...rest } = event;
    // `meta.id` and `meta.at` follow the recorded order; other fields are normalized like `data`.
    const normalizedMeta: MessageStreamEventMeta = {
      ...(normalizeValue(meta, replace) as MessageStreamEventMeta),
      at: new Date(FIXTURE_EPOCH_MS + index * 1_000).toISOString(),
      id: `evt-${String(index + 1).padStart(4, "0")}`,
    };
    return { ...(normalizeValue(rest, replace) as MessageStreamEvent), meta: normalizedMeta };
  });
}

function normalizeValue(value: unknown, replace: (text: string) => string, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "eveVersion") return "0.0.0";
    if (key === "traceId") return "0".repeat(32);
    if (key === "spanId") return "0".repeat(16);
    return replace(value);
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, replace));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        replace(name),
        normalizeValue(entry, replace, name),
      ]),
    );
  }
  return value;
}

const VOLATILE_PATTERNS = [
  /\bwrun_[0-9A-Za-z]{8,}/u,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
  /127\.0\.0\.1|localhost:\d+/u,
  /\/(?:tmp|private|var\/folders)\//u,
];

/** Strings left in normalized events that still look run-specific. */
export function findVolatileStrings(events: readonly MessageStreamEvent[]): readonly string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (VOLATILE_PATTERNS.some((pattern) => pattern.test(value))) found.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      for (const [name, entry] of Object.entries(value)) {
        visit(name);
        visit(entry);
      }
    }
  };
  events.forEach(visit);
  return found;
}

/**
 * The parts of a recording that must match across runs: every event other
 * than `task.*` in order, and each task's own `task.*` events in order.
 * A detached child reports `task.started` whenever its session starts,
 * so where task events interleave with the turn is not compared. `meta`
 * is renumbered by position, so it is left out.
 */
export function projectTaskStream(events: readonly MessageStreamEvent[]): {
  readonly ordered: readonly unknown[];
  readonly tasks: Readonly<Record<string, readonly unknown[]>>;
} {
  const withoutMeta = ({ meta: _meta, ...event }: MessageStreamEvent) => event;
  const tasks: Record<string, unknown[]> = {};
  for (const event of events) {
    if (isTaskStreamEvent(event)) (tasks[event.data.taskId] ??= []).push(withoutMeta(event));
  }
  return {
    ordered: events.filter((event) => !isTaskStreamEvent(event)).map(withoutMeta),
    tasks,
  };
}
