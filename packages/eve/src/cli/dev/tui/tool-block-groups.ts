import type { Block, DisplayBlock, ToolGroupItem } from "./blocks.js";
import { toolBaseName } from "./tool-presentation.js";

interface ToolBlockDisplayGroup {
  readonly members: readonly Block[];
  readonly display: DisplayBlock;
}

interface GroupToolBlocksOptions {
  readonly logCoalescing?: "window" | "runs";
}

export function groupToolBlocksForDisplay(
  blocks: readonly Block[],
  options: GroupToolBlocksOptions = {},
): ToolBlockDisplayGroup[] {
  if ((options.logCoalescing ?? "window") === "window") {
    const buckets = new Map<string, Block[]>();
    for (const block of blocks) {
      if (!isGroupableLogWrite(block)) continue;
      const key = logBucketKey(block);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [block]);
      else bucket.push(block);
    }
    const anchors = new Map<Block, ToolBlockDisplayGroup>();
    for (const members of buckets.values()) {
      anchors.set(members.at(-1)!, coalesceLogBucket(members));
    }
    return groupBlocks(blocks, anchors);
  }
  return groupBlocks(blocks);
}

function groupBlocks(
  blocks: readonly Block[],
  logAnchors?: ReadonlyMap<Block, ToolBlockDisplayGroup>,
): ToolBlockDisplayGroup[] {
  const groups: ToolBlockDisplayGroup[] = [];
  for (let index = 0; index < blocks.length;) {
    const first = blocks[index]!;
    if (isGroupableLogWrite(first)) {
      if (logAnchors !== undefined) {
        const group = logAnchors.get(first);
        if (group !== undefined) groups.push(group);
        index += 1;
        continue;
      }
      const run = [first];
      while (
        index + run.length < blocks.length &&
        isGroupableLogWrite(blocks[index + run.length]!)
      ) {
        run.push(blocks[index + run.length]!);
      }
      groups.push(...coalesceLogWrites(run));
      index += run.length;
      continue;
    }
    if (!isGroupable(first)) {
      groups.push({ members: [first], display: first });
      index += 1;
      continue;
    }

    const run = [first];
    while (index + run.length < blocks.length) {
      const candidate = blocks[index + run.length]!;
      if (!isGroupable(candidate) || !sameRun(first, candidate)) break;
      run.push(candidate);
    }

    const running = run.some((block) => block.status === "running");
    if (running && run.length > 1) {
      groups.push({ members: run, display: aggregateLiveToolBlocks(run) });
    } else {
      groups.push(...partitionRunByStatus(run));
    }
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
    candidate.parentCallId === first.parentCallId &&
    candidate.toolName === first.toolName
  );
}

function partitionRunByStatus(run: readonly Block[]): ToolBlockDisplayGroup[] {
  const partitions = new Map<Block["status"], Block[]>();
  for (const block of run) {
    const partition = partitions.get(block.status);
    if (partition === undefined) {
      partitions.set(block.status, [block]);
    } else {
      partition.push(block);
    }
  }

  return [...partitions.values()].map((members) => ({
    members,
    display:
      members.length === 1
        ? members[0]!
        : members[0]!.status === "done"
          ? collapseSettledToolBlocks(members)
          : aggregateToolBlocks(members),
  }));
}

function isGroupableLogWrite(block: Block): boolean {
  return block.kind === "log" && block.id === undefined;
}

function logBucketKey(block: Block): string {
  return `${block.title ?? ""}\u0000${block.logLevel ?? ""}\u0000${block.logVisibility ?? ""}`;
}

function coalesceLogWrites(run: readonly Block[]): ToolBlockDisplayGroup[] {
  const buckets = new Map<string, Block[]>();
  for (const block of run) {
    const key = logBucketKey(block);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [block]);
    } else {
      bucket.push(block);
    }
  }
  return [...buckets.values()].map(coalesceLogBucket);
}

function coalesceLogBucket(members: readonly Block[]): ToolBlockDisplayGroup {
  if (members.length === 1) return { members, display: members[0]! };
  const newest = members.at(-1)!;
  const display: DisplayBlock = {
    kind: "log",
    live: members.some((member) => member.live !== false),
    body: newest.body ?? "",
    elided: members.length - 1,
  };
  if (newest.title !== undefined) display.title = newest.title;
  if (newest.logVisibility !== undefined) display.logVisibility = newest.logVisibility;
  if (newest.logLevel !== undefined) display.logLevel = newest.logLevel;
  return { members, display };
}

function aggregateToolBlocks(members: readonly Block[]): DisplayBlock {
  const first = members[0]!;
  const group = first.toolGroup!;
  const count = members.length;
  return {
    ...first,
    id: undefined,
    result: undefined,
    title: `${group.verb} ${count} ${count === 1 ? group.singularNoun : group.pluralNoun}`,
    toolGroupItems: newestFirstItems(members),
  };
}

function aggregateLiveToolBlocks(members: readonly Block[]): DisplayBlock {
  return {
    ...aggregateToolBlocks(members),
    status: "running",
    live: true,
  };
}

function collapseSettledToolBlocks(members: readonly Block[]): DisplayBlock {
  const first = members[0]!;
  const group = first.toolGroup!;
  const count = members.length;
  const noun = count === 1 ? group.singularNoun : group.pluralNoun;
  return {
    ...first,
    id: undefined,
    result: undefined,
    title: `${group.verb} ${count} ${noun}`,
    doneTitle: `${group.pastVerb} ${count} ${noun}`,
  };
}

interface CondensedKindCopy {
  readonly pastVerb: string;
  readonly singularNoun: string;
  readonly pluralNoun: string;
}

const maxCondensedKinds = 3;

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

function updateRecency(block: Block): number {
  return block.updateSeq ?? 0;
}

function newestFirstItems(members: readonly Block[]): ToolGroupItem[] {
  return members
    .map((member, position) => ({ member, order: updateRecency(member), position }))
    .sort((a, b) => b.order - a.order || b.position - a.position)
    .map(({ member }): ToolGroupItem => {
      const item: ToolGroupItem = { text: member.toolGroup!.item };
      return member.status === "error" && member.result !== undefined
        ? { ...item, result: member.result }
        : item;
    });
}
