/**
 * Example: replace a framework default tool with a custom stateful version.
 *
 * This file shadows the framework `todo` tool because it lives at
 * `tools/todo.ts` — the compiler derives the runtime tool name from the
 * filename slug. The replacement uses `defineState` for durable state.
 * Authors who want the framework's state behavior should spread the default
 * from `eve/tools/defaults` instead of writing a fresh `execute`.
 */
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

interface NoteListState {
  readonly notes: readonly string[];
}

const noteList = defineState<NoteListState>("weather-fixture.notes", () => ({ notes: [] }));

export default defineTool({
  description:
    "Append a short note about the current weather query, or read the running list of notes when called with no arguments.",
  inputSchema: z.object({
    note: z.string().optional(),
  }),
  async execute(input) {
    if (input.note) {
      noteList.update((state) => ({
        notes: [...state.notes, input.note!],
      }));
    }
    const state = noteList.get();
    return {
      count: state.notes.length,
      notes: state.notes,
    };
  },
});
