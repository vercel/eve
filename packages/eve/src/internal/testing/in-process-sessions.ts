import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import type { SessionSnapshot } from "#execution/in-process/snapshot.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { isObject } from "#shared/guards.js";

// What the in-process host's tests read sessions with, on either host: their events, the protocol
// checker's verdict, and the shape two hosts must agree on.

/** Alice's HTTP address on `runtime`. */
export function address(
  runtime: Runtime,
  continuationToken: string,
): ReturnType<typeof createChannelAddress> {
  return createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });
}

/** What the protocol checker finds in a session's whole stream, read from its first line. */
export async function violations(runtime: Runtime, sessionId: string): Promise<Violation[]> {
  const checker = createStreamChecker({ validate: schemaViolation });
  const found: Violation[] = [];
  let position = 0;
  for await (const record of await runtime.getLineStream(sessionId, { follow: false })) {
    if (!isStoredLine(record)) throw new Error(`Line ${position} isn't a stored line.`);
    found.push(...checker.check(record, position++));
  }
  return found;
}

/** Every event a session recorded so far. */
export async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

/** Follows a session's stream until `done` says the conversation is over. */
export async function follow(
  runtime: Runtime,
  sessionId: string,
  done: (events: readonly SessionStreamEvent[]) => boolean,
): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId)).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      events.push(next.value);
      if (done(events)) break;
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

/** A field of an event's data, when its data has it. */
export function dataField(event: SessionStreamEvent, field: string): unknown {
  return isObject(event.data) ? event.data[field] : undefined;
}

/** What the model said, in order. */
export function replies(events: readonly SessionStreamEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "content.completed" ? [dataField(event, "value")] : [],
  );
}

/** The call a session event belongs to, if it belongs to one. */
export function callOf(event: SessionStreamEvent): string | undefined {
  const owner = dataField(event, "owner");
  const callId = dataField(event, "callId") ?? (isObject(owner) ? owner.callId : undefined);
  return typeof callId === "string" ? callId : undefined;
}

/** Types and data with ids, times, and positions taken out: what two hosts must agree on. */
export function shape(events: readonly SessionStreamEvent[]) {
  const ids = new Map<string, string>();
  const rename = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      // A child's stream is named by its session, which each host names its own way.
      if (/(?:Id|Token)$/.test(key) || key === "id" || key === "stream") {
        if (!ids.has(value)) ids.set(value, `<${ids.size}>`);
        return ids.get(value);
      }
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "<time>";
      // A task's id appears in what the model reads.
      return value.replace(/\b[a-z]+-[0-9a-z]{6}\b/g, "<task>");
    }
    if (Array.isArray(value)) return value.map((entry) => rename(entry, key));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([field]) => field !== "meta" && field !== "runtime")
          .map(([field, entry]) => [field, rename(entry, field)]),
      );
    return value;
  };
  return events.map((event) => rename({ data: event.data, type: event.type }));
}

/**
 * What two hosts agree on when calls run in parallel: the session's own events in order, and
 * each call's events in order. How the calls interleave is up to each host.
 */
export function parallelShape(events: readonly SessionStreamEvent[]) {
  const calls = new Map<string, SessionStreamEvent[]>();
  for (const event of events) {
    const callId = callOf(event);
    if (callId !== undefined) calls.set(callId, [...(calls.get(callId) ?? []), event]);
  }
  return {
    calls: Object.fromEntries(
      [...calls]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([callId, own]) => [callId, shape(own)]),
    ),
    session: events.filter((event) => callOf(event) === undefined).map(({ type }) => type),
  };
}

// A World that stops keeping writes once a line matches, as if the process died there.
export { dyingAfter } from "./world-faults.js";

/** `snapshot` as it reads back after a store or another process held it as JSON. */
export function throughJson(snapshot: SessionSnapshot): SessionSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}
