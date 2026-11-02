import {
  activeTurn,
  calls,
  contentPreviews,
  conversation,
  deliveries,
  parts,
  runs,
  type SessionView,
} from "#public/events/index.js";

/** Characters of one call input or output kept in the transcript. */
const MAX_FIELD_CHARS = 2_000;
/** Characters of one message or piece of agent text kept in the transcript. */
const MAX_TEXT_CHARS = 4_000;

/** One turn as transcript lines: its opener, the message that started it, and what followed. */
export interface TranscriptTurn {
  readonly opener: string;
  readonly task?: string;
  readonly entries: readonly string[];
}

interface Entry {
  readonly at: string;
  readonly line: string;
}

/**
 * The session so far as tagged lines, oldest first: each turn's messages, the agent's text, and
 * its tool calls with their state. The running turn is marked `status="running"`, and the text it
 * is still streaming is included. Every value is JSON-encoded with `<` escaped, so text from the
 * session can't close a tag or forge a line. See {@link fitTranscript} for how it fits `maxChars`.
 */
export function asideTranscript(view: SessionView, maxChars: number): string {
  const running = activeTurn(view)?.turnId;
  const turns = conversation(view).map((turn): TranscriptTurn => {
    const { turnId } = turn;
    const status = turnId === running ? "running" : (turn.outcome ?? turn.status);
    const [task, ...messages] = deliveries(view, { turnId }).flatMap((delivery) => {
      const text = (delivery.parts ?? [])
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("\n");
      return text === "" ? [] : [{ at: delivery.startedAt ?? "", line: userLine(text) }];
    });
    return {
      opener: `<turn status=${encode(status)}>`,
      ...(task !== undefined && { task: task.line }),
      entries: turnEntries(view, turnId, turnId === running, messages),
    };
  });
  return fitTranscript(turns, maxChars);
}

/**
 * Joins turns into lines that fit `maxChars`. The newest turn always keeps its opener and the
 * message that started it; its oldest entries after that message are dropped first, then whole
 * earlier turns from the oldest end. Each drop leaves a marker that says how much is missing.
 */
export function fitTranscript(turns: readonly TranscriptTurn[], maxChars: number): string {
  const newest = turns.at(-1);
  if (newest === undefined) return "";

  const head = newest.task === undefined ? [newest.opener] : [newest.opener, newest.task];
  let budget = maxChars - size(head) - size(["</turn>"]);
  const kept: string[] = [];
  for (const entry of [...newest.entries].reverse()) {
    if (entry.length + 1 > budget) break;
    kept.unshift(entry);
    budget -= entry.length + 1;
  }
  const droppedEntries = newest.entries.length - kept.length;
  const lines = [
    ...head,
    ...(droppedEntries > 0 ? [`<omitted_earlier_in_turn entries="${droppedEntries}"/>`] : []),
    ...kept,
    "</turn>",
  ];

  // Whole earlier turns only, newest first: a partial earlier turn would lose its own opener.
  let earlier = turns.length - 1;
  while (droppedEntries === 0 && earlier > 0) {
    const turn = turns[earlier - 1]!;
    const block = [turn.opener, ...(turn.task === undefined ? [] : [turn.task]), ...turn.entries];
    block.push("</turn>");
    if (size(block) > budget) break;
    lines.unshift(...block);
    budget -= size(block);
    earlier--;
  }
  if (earlier > 0) lines.unshift(`<omitted_earlier turns="${earlier}"/>`);
  return lines.join("\n");
}

function size(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

function turnEntries(
  view: SessionView,
  turnId: string,
  running: boolean,
  messages: readonly Entry[],
): string[] {
  const entries: Entry[] = [...messages];
  for (const part of parts(view, { turnId, kind: "text" })) {
    if (typeof part.value !== "string" || part.value === "") continue;
    entries.push({
      at: part.startedAt ?? "",
      line: `<agent phase=${encode(part.phase)}>${encode(clipText(part.value))}</agent>`,
    });
  }
  for (const call of calls(view, { turnId })) {
    // Task waits and cancels are the agent polling its own work, not something it did.
    if (call.kind === "control") continue;
    const fields: Record<string, unknown> = { name: call.name, state: call.state };
    if (call.input !== undefined) fields.input = clip(call.input);
    if (call.output !== undefined) fields.output = clip(call.output);
    else if (call.outputRef !== undefined) fields.output = "[stored separately]";
    if (call.error !== undefined) fields.error = call.error.message;
    entries.push({ at: call.startedAt ?? "", line: `<call>${encode(fields)}</call>` });
  }
  // Stable sort: entries without a time keep their place after those with one.
  entries.sort((a, b) =>
    a.at === b.at ? 0 : a.at === "" ? 1 : b.at === "" ? -1 : a.at < b.at ? -1 : 1,
  );
  const lines = entries.map(({ line }) => line);

  if (running) {
    const runIds = new Set(runs(view, { turnId }).map(({ runId }) => runId));
    for (const preview of contentPreviews(view)) {
      if (preview.kind !== "text" || preview.text === "") continue;
      if (preview.runId !== undefined && !runIds.has(preview.runId)) continue;
      // The end of text still streaming says the most about what the agent is doing now.
      lines.push(`<agent phase="streaming">${encode(clipText(preview.text, "end"))}</agent>`);
    }
  }
  return lines;
}

function userLine(text: string): string {
  return `<user>${encode(clipText(text))}</user>`;
}

function clipText(text: string, keep: "start" | "end" = "start"): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const omitted = `[${text.length - MAX_TEXT_CHARS} more characters]`;
  return keep === "start"
    ? `${text.slice(0, MAX_TEXT_CHARS)}… ${omitted}`
    : `${omitted} …${text.slice(-MAX_TEXT_CHARS)}`;
}

function clip(value: unknown): unknown {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (text.length <= MAX_FIELD_CHARS) return value;
  return `${text.slice(0, MAX_FIELD_CHARS)}… [${text.length - MAX_FIELD_CHARS} more characters]`;
}

/** JSON with `<` escaped, so no field can contain a tag. */
function encode(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replaceAll("<", "\\u003c");
}
