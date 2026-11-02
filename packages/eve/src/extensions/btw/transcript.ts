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

interface Entry {
  readonly at: string;
  readonly line: string;
}

/**
 * The session so far as tagged lines, oldest first: each turn's messages, the agent's text, and
 * its tool calls with their state. The running turn is marked `status="running"`, and the text it
 * is still streaming is included. Lines are dropped from the oldest end to fit `maxChars`, so the
 * newest work always survives. Every value is JSON-encoded with `<` escaped, so text from the
 * session can't close a tag or forge a line.
 */
export function asideTranscript(view: SessionView, maxChars: number): string {
  const running = activeTurn(view)?.turnId;
  const lines: string[] = [];
  for (const turn of conversation(view)) {
    const { turnId } = turn;
    const status = turnId === running ? "running" : (turn.outcome ?? turn.status);
    lines.push(`<turn status=${encode(status)}>`);
    for (const entry of turnEntries(view, turnId, turnId === running)) lines.push(entry.line);
    lines.push("</turn>");
  }

  const kept: string[] = [];
  let budget = maxChars;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.length + 1 > budget) break;
    kept.unshift(line);
    budget -= line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return omitted > 0
    ? [`<omitted_earlier lines="${omitted}"/>`, ...kept].join("\n")
    : kept.join("\n");
}

function turnEntries(view: SessionView, turnId: string, running: boolean): Entry[] {
  const entries: Entry[] = [];
  for (const delivery of deliveries(view, { turnId })) {
    const text = (delivery.parts ?? [])
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("\n");
    if (text !== "")
      entries.push({ at: delivery.startedAt ?? "", line: `<user>${encode(text)}</user>` });
  }
  for (const part of parts(view, { turnId, kind: "text" })) {
    if (typeof part.value !== "string" || part.value === "") continue;
    entries.push({
      at: part.startedAt ?? "",
      line: `<agent phase=${encode(part.phase)}>${encode(part.value)}</agent>`,
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

  if (running) {
    const runIds = new Set(runs(view, { turnId }).map(({ runId }) => runId));
    for (const preview of contentPreviews(view)) {
      if (preview.kind !== "text" || preview.text === "") continue;
      if (preview.runId !== undefined && !runIds.has(preview.runId)) continue;
      entries.push({ at: "", line: `<agent phase="streaming">${encode(preview.text)}</agent>` });
    }
  }
  return entries;
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
