import type { ModelMessage } from "ai";

import type { ContextReader } from "#context/key.js";
import { sessionFrameOf } from "#definitions/frame.js";
import { section, type Section, type ToolEntry, type ToolTable } from "#definitions/definition.js";
import { type HarnessModelMessage, turnAnchorOf } from "#harness/messages.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { HarnessCycleError } from "./stack.js";
import { currentView } from "#harness/session-machine/current.js";
import { callTurn } from "#protocol/session-projection/selectors.js";
import type {
  HarnessCall,
  HarnessContext,
  HarnessStep,
  HarnessTool,
  HarnessTools,
} from "#public/definitions/harness.js";

// What a harness reads, and the public shapes of the parts of a model call it changes: tools by
// name, and the system prompt as its parts.

/** The metadata key on a note a harness added, naming its turn. */
export const HARNESS_NOTE_KEY = "eve.harness.note";

/** Where a stage runs, and how it reaches the other stages of the whole stack. */
export interface HarnessWhere {
  readonly history: readonly ModelMessage[];
  /** The turn's input, before it joins the history. */
  readonly pending?: readonly ModelMessage[];
  /** The view as of the step, when the caller holds a newer one than the context's. */
  readonly view?: SessionView;
  readonly lastStep?: HarnessStep;
  readonly tools: () => Promise<ToolTable>;
  readonly system: () => Promise<readonly Section[]>;
}

export function harnessContext(
  container: ContextReader,
  where: HarnessWhere,
  /** The request stage this context runs, which can't read itself through `ctx.harness`. */
  running?: "tools" | "instructions",
): HarnessContext {
  const tables = where.view ?? currentView(container);
  const frame = sessionFrameOf(container, { view: tables });
  const turnId = frame.turn?.status === "settled" ? undefined : frame.turn?.id;
  return {
    ...frame,
    calls: turnId === undefined ? [] : callsOf(tables, turnId),
    continuations: turnId === undefined ? 0 : notesIn(where.history, turnId),
    harness: {
      instructions: async () => {
        if (running === "instructions") throw new HarnessCycleError("instructions");
        return partsOf(await where.system());
      },
      tools: async () => {
        if (running === "tools") throw new HarnessCycleError("tools");
        return toPublicTools(await where.tools());
      },
    },
    history: where.history,
    input: turnId === undefined ? "" : inputOf(turnId, where, frame.turn?.input ?? []),
    ...(where.lastStep !== undefined && { lastStep: where.lastStep }),
  };
}

/**
 * The text a person sent the turn: its input messages, as history marks them with the turn, or
 * the parts its deliveries carried.
 */
function inputOf(
  turnId: string,
  where: HarnessWhere,
  parts: readonly { readonly kind: string; readonly text?: string }[],
): string {
  const messages = [...where.history, ...(where.pending ?? [])].filter(
    (message) =>
      message.role === "user" &&
      (message as { readonly kind?: string }).kind === "user" &&
      turnAnchorOf(message as HarnessModelMessage) === turnId,
  );
  if (messages.length > 0) return messages.map(textOf).join("\n");
  return parts.flatMap((part) => (part.kind === "text" ? [part.text ?? ""] : [])).join("\n");
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The calls `turnId` made, the model's and the harness's, oldest first. */
function callsOf(view: SessionView, turnId: string): readonly HarnessCall[] {
  return Object.values(view.calls)
    .filter((row) => callTurn(view, row) === turnId)
    .sort((a, b) => a.introducedAt - b.introducedAt)
    .map((row) => ({
      by: "turnId" in row.owner ? ("harness" as const) : ("model" as const),
      callId: row.callId,
      status: row.status,
      tool: row.capability.name,
      ...(row.input !== undefined && { input: row.input }),
      ...(row.outcome !== undefined && { outcome: row.outcome }),
      ...(row.output !== undefined && { output: row.output }),
    }));
}

/** The notes a harness added in `turnId`, as the history still holds them. */
function notesIn(history: readonly ModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      (message as { readonly metadata?: Record<string, unknown> }).metadata?.[HARNESS_NOTE_KEY] ===
        turnId,
  ).length;
}

// --- Tools ------------------------------------------------------------------------------------

export function toPublicTools(table: ToolTable): HarnessTools {
  return new Map(
    [...table.entries].map(([name, entry]): [string, HarnessTool] => [
      name,
      {
        deferred: entry.definition.deferred === true,
        description: entry.definition.description,
        name,
      },
    ]),
  );
}

/**
 * The table a harness's tools make: the entries it kept, in its order, with the descriptions it
 * gave them. It can't make a tool here, nor rename one: a tool's code, schema, and approval are
 * its definition's, so a harness adds tools with its value form.
 */
export function fromPublicTools(table: ToolTable, tools: HarnessTools, label: string): ToolTable {
  const entries = new Map<string, ToolEntry>();
  for (const [name, tool] of tools) {
    const entry = table.entries.get(name);
    if (entry === undefined || tool.name !== name) {
      throw new Error(
        `"${label}" offered a tool "${tool.name}" the layers below don't have. Add tools with the harness's \`tools: { ... }\` value form, or a file in tools/.`,
      );
    }
    entries.set(
      name,
      tool.description === entry.definition.description
        ? entry
        : { ...entry, definition: { ...entry.definition, description: tool.description } },
    );
  }
  return { ...table, entries };
}

// --- Instructions ---------------------------------------------------------------------------

/** The system prompt's parts, one per section, in the order the model reads them. */
export function partsOf(sections: readonly Section[]): readonly string[] {
  const ordered = sorted(sections).filter((entry) => entry.text !== "");
  return [
    ...ordered.filter((entry) => entry.part === "base"),
    ...ordered.filter((entry) => entry.part === "own"),
  ].map((entry) => entry.text);
}

/**
 * The sections a harness's parts make, in its order. A part that was a section stays in the
 * prompt's cached prefix (`base`) or after it (`own`); a new one joins the prefix.
 */
export function sectionsOf(
  sections: readonly Section[],
  parts: readonly string[],
  label: string,
): readonly Section[] {
  const byText = new Map(sections.map((entry) => [entry.text, entry]));
  return parts.map((text, order) => {
    const was = byText.get(text);
    return was === undefined ? section(label, text, { order }) : { ...was, order };
  });
}

function sorted(sections: readonly Section[]): readonly Section[] {
  return sections
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
    .map(({ entry }) => entry);
}
