import type { SessionStreamEvent } from "eve/client";
import type { SessionReader } from "eve/sessions";

const linesPerRead = 128;
const turnsPerPage = 4;

/** A contiguous window of a session's stream, addressed by stored line. */
export interface SessionHistoryPage {
  /** The next line to read after this page. */
  readonly endIndex: number;
  readonly events: readonly SessionStreamEvent[];
  /** Recorded child relationships survive trimming the visible transcript. */
  readonly childOpenings: readonly Extract<
    SessionStreamEvent,
    { type: "child.opened" }
  >[];
  /** The first line this page holds. */
  readonly startIndex: number;
}

export async function readLatestSessionHistory(
  reader: SessionReader,
  signal?: AbortSignal
): Promise<SessionHistoryPage> {
  const events = await readLines(reader, -linesPerRead, undefined, signal);
  const last = events.at(-1);
  const endIndex = last ? lineAfter(last) : 0;
  const startIndex = events[0]?.meta.position.line ?? endIndex;

  const page = await extendToTurnBoundary(
    { childOpenings: [], endIndex, events, startIndex },
    reader,
    signal
  );
  return await retainChildOpenings(page, reader, events, signal);
}

export async function readOlderSessionHistory(
  reader: SessionReader,
  before: number,
  signal?: AbortSignal
): Promise<SessionHistoryPage> {
  const page = await extendToTurnBoundary(
    { childOpenings: [], endIndex: before, events: [], startIndex: before },
    reader,
    signal
  );
  return await retainChildOpenings(page, reader, [], signal);
}

/** The line a reader resumes from after `event`, once its line is complete. */
function lineAfter(event: SessionStreamEvent) {
  return event.meta.next ?? event.meta.position.line + 1;
}

/** Appends streamed events once each, keyed by their stored position. */
export function appendHistoryEvent(
  page: SessionHistoryPage,
  event: SessionStreamEvent
): SessionHistoryPage {
  const endIndex =
    event.meta.endOfLine === false
      ? page.endIndex
      : Math.max(page.endIndex, lineAfter(event));
  const { line, index } = event.meta.position;
  const known = page.events.some(
    (candidate) =>
      candidate.meta.position.line === line &&
      candidate.meta.position.index === index
  );
  const childOpenings =
    event.type === "child.opened"
      ? [
          ...page.childOpenings.filter(
            (opened) => opened.data.sessionId !== event.data.sessionId
          ),
          event,
        ]
      : page.childOpenings;
  return known
    ? { ...page, endIndex }
    : { ...page, childOpenings, endIndex, events: [...page.events, event] };
}

async function extendToTurnBoundary(
  initial: SessionHistoryPage,
  reader: SessionReader,
  signal?: AbortSignal
) {
  let page = initial;

  while (
    page.startIndex > 0 &&
    startedTurnLines(page.events).length < turnsPerPage
  ) {
    const from = Math.max(0, page.startIndex - linesPerRead);
    /* oxlint-disable-next-line eslint/no-await-in-loop -- Each backward read starts at the cursor returned by the preceding read. */
    const older = await readLines(reader, from, page.startIndex, signal);
    page = {
      childOpenings: [
        ...page.childOpenings,
        ...older.filter((event) => event.type === "child.opened"),
      ],
      endIndex: page.endIndex,
      events: [...older, ...page.events],
      startIndex: from,
    };
  }

  // Delivery admission can be on an earlier line than turn.started. The
  // native projection needs that admission to render the consumed user input.
  const visibleTurns = page.events
    .filter((event) => event.type === "turn.started")
    .slice(-turnsPerPage);
  const firstTurn = visibleTurns[0];
  if (!firstTurn) return page;
  const visibleTurnIds = new Set(
    visibleTurns.map((event) => event.data.turnId)
  );
  const deliveryIds = new Set([
    ...visibleTurns.flatMap((event) =>
      "deliveryId" in event.data.cause ? [event.data.cause.deliveryId] : []
    ),
    ...page.events.flatMap((event) =>
      event.type === "delivery.consumed" &&
      visibleTurnIds.has(event.data.turnId)
        ? [event.data.deliveryId]
        : []
    ),
  ]);
  const admissions = new Map<string, number>();
  const collectAdmissions = (events: readonly SessionStreamEvent[]) => {
    for (const event of events) {
      if (
        event.type === "delivery.admitted" &&
        deliveryIds.has(event.data.deliveryId)
      ) {
        admissions.set(event.data.deliveryId, event.meta.position.line);
      }
    }
  };
  collectAdmissions(page.events);
  while (page.startIndex > 0 && admissions.size < deliveryIds.size) {
    const from = Math.max(0, page.startIndex - linesPerRead);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve the displayed turns' earlier admissions without fabricating projection events.
    const older = await readLines(reader, from, page.startIndex, signal);
    collectAdmissions(older);
    page = { ...page, events: [...older, ...page.events], startIndex: from };
  }
  const firstLine = Math.min(
    firstTurn.meta.position.line,
    ...admissions.values()
  );
  if (firstLine <= page.startIndex) return page;
  return {
    ...page,
    childOpenings: [
      ...page.childOpenings,
      ...page.events.filter((event) => event.type === "child.opened"),
    ],
    events: page.events.filter(
      (event) => event.meta.position.line >= firstLine
    ),
    startIndex: firstLine,
  };
}

async function readLines(
  reader: SessionReader,
  startIndex: number,
  before: number | undefined,
  signal?: AbortSignal
) {
  const events: SessionStreamEvent[] = [];

  for await (const event of reader.stream({
    follow: false,
    signal,
    startIndex,
  })) {
    if (before !== undefined && event.meta.position.line >= before) break;
    events.push(event);
  }

  return events;
}

function startedTurnLines(events: readonly SessionStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "turn.started" ? [event.meta.position.line] : []
  );
}

/** Resolve relationships needed by recent calls without rendering older transcript turns. */
export async function retainChildOpenings(
  page: SessionHistoryPage,
  reader: SessionReader,
  seed: readonly SessionStreamEvent[],
  signal?: AbortSignal
): Promise<SessionHistoryPage> {
  const needed = new Set(
    page.events.flatMap((event) =>
      event.type === "child.sent" || event.type === "child.opened"
        ? [event.data.sessionId]
        : []
    )
  );
  const openings = new Map<
    string,
    SessionHistoryPage["childOpenings"][number]
  >();
  const collect = (events: readonly SessionStreamEvent[]) => {
    for (const event of events) {
      if (event.type === "child.opened" && needed.has(event.data.sessionId)) {
        openings.set(event.data.sessionId, event);
      }
    }
  };
  collect([...seed, ...page.childOpenings, ...page.events]);
  let before = page.startIndex;
  while (before > 0 && openings.size < needed.size) {
    const from = Math.max(0, before - linesPerRead);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve older relationships through bounded backward reads.
    collect(await readLines(reader, from, before, signal));
    before = from;
  }
  return { ...page, childOpenings: [...openings.values()] };
}
