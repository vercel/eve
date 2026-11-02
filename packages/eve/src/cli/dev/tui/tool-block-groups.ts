import type { Block, DisplayBlock, ToolGroupItem } from "./blocks.js";
import { toolBaseName } from "./tool-presentation.js";

interface ToolBlockDisplayGroup {
  readonly members: readonly Block[];
  readonly display: DisplayBlock;
}

/**
 * Coalesces a contiguous run of equivalent tool calls into one row; each
 * member keeps its call id and lifecycle. Groups are always contiguous, so
 * committing a group's display commits exactly its members.
 */
export function groupToolBlocksForDisplay(blocks: readonly Block[]): ToolBlockDisplayGroup[] {
  const groups: ToolBlockDisplayGroup[] = [];
  for (let index = 0; index < blocks.length;) {
    const first = blocks[index]!;
    const run = [first];
    while (
      isGroupable(first) &&
      index + run.length < blocks.length &&
      isGroupable(blocks[index + run.length]!) &&
      sameRun(first, blocks[index + run.length]!)
    ) {
      run.push(blocks[index + run.length]!);
    }
    groups.push({ members: run, display: run.length === 1 ? first : aggregate(run) });
    index += run.length;
  }
  return groups;
}

function isGroupable(block: Block): boolean {
  return (
    (block.kind === "tool" || block.kind === "subagent-tool") &&
    block.toolGroup !== undefined &&
    block.expanded !== true &&
    (block.status === "running" ||
      block.status === "error" ||
      (block.status === "done" && block.result === undefined))
  );
}

function sameRun(first: Block, candidate: Block): boolean {
  return (
    candidate.kind === first.kind &&
    candidate.depth === first.depth &&
    candidate.live === first.live &&
    candidate.subagentCallId === first.subagentCallId &&
    // Copy derives from the tool name, so name equality implies equal copy.
    candidate.toolName === first.toolName
  );
}

/**
 * One counted header for a run. While any call runs it lists every call,
 * newest first; a settled run of successes collapses to the past-tense count;
 * a run with failures keeps each failure's summary under the count.
 */
function aggregate(run: readonly Block[]): DisplayBlock {
  const first = run[0]!;
  const group = first.toolGroup!;
  const count = run.length;
  const noun = count === 1 ? group.singularNoun : group.pluralNoun;
  const display: DisplayBlock = {
    ...first,
    id: undefined,
    result: undefined,
    title: `${group.verb} ${count} ${noun}`,
  };
  if (run.some((block) => block.status === "running")) {
    return { ...display, status: "running", live: true, toolGroupItems: newestFirstItems(run) };
  }
  if (run.every((block) => block.status === "done")) {
    return { ...display, doneTitle: `${group.pastVerb} ${count} ${noun}` };
  }
  return { ...display, status: "error", toolGroupItems: newestFirstItems(run) };
}

/** The (past verb, noun) copy one condensed-count entry renders with. */
interface CondensedKindCopy {
  readonly pastVerb: string;
  readonly singularNoun: string;
  readonly pluralNoun: string;
}

/** How many tool kinds the condensed row names before "and more". */
const maxCondensedKinds = 3;

/**
 * The counted multi-kind summary of a settled child-tool run:
 * `Ran 17 commands, Read 10 files, Wrote 6 files, and more`.
 */
function condensedRunTitle(run: readonly Block[]): string {
  const counts = new Map<string, { copy: CondensedKindCopy; count: number }>();
  for (const block of run) {
    const copy = condensedKindCopy(block);
    const key = `${copy.pastVerb} ${copy.pluralNoun}`;
    const entry = counts.get(key);
    if (entry === undefined) {
      counts.set(key, { copy, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const named = ranked
    .slice(0, maxCondensedKinds)
    .map(
      ({ copy, count }) =>
        `${copy.pastVerb} ${count} ${count === 1 ? copy.singularNoun : copy.pluralNoun}`,
    );
  return ranked.length > maxCondensedKinds ? `${named.join(", ")}, and more` : named.join(", ");
}

/**
 * What an agent did, for the line its task ends on: counted settled work plus
 * a failure count, so an error folds into the summary without vanishing from
 * it. `undefined` when the agent ran no tools.
 */
export function summarizeChildTools(children: readonly Block[]): string | undefined {
  const tools = children.filter((block) => block.kind === "subagent-tool");
  if (tools.length === 0) return undefined;
  const settled = tools.filter((block) => block.status === "done");
  const failed = tools.filter((block) => block.status === "error").length;
  const parts: string[] = [];
  if (settled.length > 0) parts.push(condensedRunTitle(settled));
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function condensedKindCopy(block: Block): CondensedKindCopy {
  const group = block.toolGroup;
  if (group !== undefined) {
    return {
      pastVerb: group.pastVerb,
      singularNoun: group.singularNoun,
      pluralNoun: group.pluralNoun,
    };
  }
  if (toolBaseName(block.toolName ?? "") === "write_file") {
    return { pastVerb: "Wrote", singularNoun: "file", pluralNoun: "files" };
  }
  return { pastVerb: "Used", singularNoun: "tool", pluralNoun: "tools" };
}

/** Newest call first: the rail reads bottom-up, like changes arriving. */
function newestFirstItems(members: readonly Block[]): ToolGroupItem[] {
  return [...members].reverse().map((member): ToolGroupItem => {
    const item: ToolGroupItem = { text: member.toolGroup!.item };
    // Failed calls keep their individual error summaries visible per row.
    return member.status === "error" && member.result !== undefined
      ? { ...item, result: member.result }
      : item;
  });
}
