import type { RecallMeetingEvent } from "@eve/recall";
import { defineState } from "eve/context";

import { ensureNotesPage } from "./notes.js";
import { appendBlocks, createPage, type NotionBlockInput } from "./notion.js";

// "eve, transcribe this meeting to Notion" starts a live transcript: a
// subpage of the notes that gets every line said or typed from then on. Lines
// are written from the channel's `shouldRespond` hook, which sees every line
// in order without a model call, a few at a time to keep Notion calls down.

/** Lines are written once this many are waiting, or when the transcript stops. */
const FLUSH_EVERY_LINES = 5;
const MAX_TEXT = 2_000;

interface Transcript {
  readonly pageId: string;
  readonly url: string;
  readonly pending: readonly {
    readonly name: string;
    readonly text: string;
    readonly chat: boolean;
  }[];
}

const transcript = defineState<Transcript | null>("meetings.transcript", () => null);

export async function startTranscript(): Promise<{ url: string; started: boolean }> {
  const current = transcript.get();
  if (current) return { url: current.url, started: false };
  const notes = await ensureNotesPage();
  const page = await createPage({
    parentId: notes.pageId,
    title: "Transcript",
    children: [line("eve", "Transcribing from here on.", false)],
  });
  transcript.update(() => ({ pageId: page.id, url: page.url, pending: [] }));
  return { url: page.url, started: true };
}

export async function stopTranscript(): Promise<{ url?: string }> {
  const current = transcript.get();
  if (!current) return {};
  await flush(true);
  transcript.update(() => null);
  return { url: current.url };
}

/**
 * Queues one meeting line, and writes the queue when it's long enough or the
 * meeting ended. A failed write keeps the lines for the next try.
 */
export async function recordLine(event: RecallMeetingEvent): Promise<void> {
  const current = transcript.get();
  if (!current) return;
  if (event.type === "speech" || event.type === "chat") {
    const entry = { name: event.participant.name, text: event.text, chat: event.type === "chat" };
    transcript.update((state) =>
      state ? { ...state, pending: [...state.pending, entry] } : state,
    );
  }
  await flush(event.type === "status");
}

async function flush(all: boolean): Promise<void> {
  const current = transcript.get();
  if (!current || current.pending.length === 0) return;
  if (!all && current.pending.length < FLUSH_EVERY_LINES) return;
  const lines = current.pending;
  await appendBlocks(
    current.pageId,
    lines.map((entry) => line(entry.name, entry.text, entry.chat)),
  );
  transcript.update((state) =>
    state ? { ...state, pending: state.pending.slice(lines.length) } : state,
  );
}

/** "**Alice:** what she said", with the text kept literal: people's words aren't Markdown. */
function line(name: string, text: string, chat: boolean): NotionBlockInput {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: `${name}${chat ? " (chat)" : ""}: ` },
          annotations: { bold: true },
        },
        { type: "text", text: { content: text.slice(0, MAX_TEXT) } },
      ],
    },
  };
}
