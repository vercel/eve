import type { Block, ToolGroupItem } from "./blocks.js";

export interface ToolBlockDisplayGroup {
  readonly members: readonly Block[];
  readonly display: Block;
}

/**
 * Coalesces presentation only; each member keeps its call id and lifecycle.
 *
 * A contiguous run of equivalent tool calls is partitioned by status, so a
 * batch with interleaved outcomes renders as one succeeded aggregate and one
 * failed aggregate instead of fragmenting on every status flip. A contiguous
 * run of same-named subagent calls coalesces the repeated headers into one
 * counted header, reorders the interleaved children call by call, and elides
 * all but the newest {@link maxVisibleSubagentRunChildren} children behind a
 * `… +N more` row. Because of that, a group's members are not always
 * contiguous in the input: callers that consume a group must remove its
 * members by identity, never by prefix length.
 */
export function groupToolBlocksForDisplay(blocks: readonly Block[]): ToolBlockDisplayGroup[] {
  const groups: ToolBlockDisplayGroup[] = [];
  for (let index = 0; index < blocks.length;) {
    const first = blocks[index]!;
    if (first.kind === "subagent" && first.subagentCallId !== undefined) {
      const run = collectSubagentRun(blocks, index);
      groups.push(...run.groups);
      index += run.consumed;
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

    // A run with any call still executing accumulates as one group — mixed
    // settled/running statuses must not fragment the batch mid-flight. Only a
    // fully settled run partitions by outcome (collapsed successes, itemized
    // failures).
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
    // Copy tuples are unique per tool today; the name check keeps two tools
    // that ever converge on the same copy from merging into one count.
    candidate.toolName === first.toolName &&
    candidate.toolGroup?.verb === first.toolGroup?.verb &&
    candidate.toolGroup?.singularNoun === first.toolGroup?.singularNoun &&
    candidate.toolGroup?.pluralNoun === first.toolGroup?.pluralNoun
  );
}

/** Splits one run into per-status groups, ordered by each status's first call. */
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

/**
 * A subagent run renders at most this many child blocks; earlier ones
 * collapse into a single `… +N more` line under the header.
 */
export const maxVisibleSubagentRunChildren = 10;

function collectSubagentRun(
  blocks: readonly Block[],
  start: number,
): { consumed: number; groups: ToolBlockDisplayGroup[] } {
  const first = blocks[start]!;
  const headers = [first];
  const childrenByCall = new Map<string, Block[]>([[first.subagentCallId!, []]]);
  let consumed = 1;
  for (; start + consumed < blocks.length; consumed += 1) {
    const candidate = blocks[start + consumed]!;
    if (candidate.kind === "subagent") {
      if (candidate.title !== first.title || candidate.subagentCallId === undefined) break;
      if (childrenByCall.has(candidate.subagentCallId)) break;
      headers.push(candidate);
      childrenByCall.set(candidate.subagentCallId, []);
      continue;
    }
    const children =
      candidate.subagentCallId === undefined
        ? undefined
        : childrenByCall.get(candidate.subagentCallId);
    if (children === undefined) break;
    children.push(candidate);
  }

  // The run stays live while any of its headers or calls still streams.
  // Headers are born live and settle only at the turn boundary: committing a
  // batch to scrollback as soon as its children finalized would strand the
  // turn's later calls to the same subagent in a fresh fragment header.
  const live =
    headers.some((header) => header.live !== false) ||
    [...childrenByCall.values()].some((children) => children.some((child) => child.live !== false));
  const groups: ToolBlockDisplayGroup[] = [];
  if (headers.length === 1) {
    groups.push({ members: [first], display: live ? { ...first, live: true } : first });
  } else {
    groups.push({
      members: headers,
      display: {
        ...first,
        id: undefined,
        live,
        subtitle: `${headers.length} calls`,
      },
    });
  }

  // Cap the run's visible children at the newest `maxVisibleSubagentRunChildren`
  // blocks. Elided blocks stay members (they must still commit and clear by
  // identity) but collapse into one display-only `… +N more` row.
  const childCount = [...childrenByCall.values()].reduce(
    (total, children) => total + children.length,
    0,
  );
  const elidedCount = Math.max(0, childCount - maxVisibleSubagentRunChildren);
  let remainingToElide = elidedCount;
  const elided: Block[] = [];
  const keptByCall = headers.map((header) => {
    const children = childrenByCall.get(header.subagentCallId!)!;
    const take = Math.min(remainingToElide, children.length);
    remainingToElide -= take;
    elided.push(...children.slice(0, take));
    return children.slice(take);
  });
  if (elidedCount > 0) {
    groups.push({
      members: elided,
      display: { kind: "subagent-step", depth: 1, live, elided: elidedCount },
    });
  }
  for (const kept of keptByCall) {
    if (kept.length > 0) groups.push(...groupToolBlocksForDisplay(kept));
  }
  return { consumed, groups };
}

function aggregateToolBlocks(members: readonly Block[]): Block {
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

/**
 * The accumulating form of an in-flight batch: one counted header whose items
 * list every announced call, newest first, so fresh calls surface at the top
 * of the rail while earlier ones slide toward the elision line.
 */
function aggregateLiveToolBlocks(members: readonly Block[]): Block {
  return {
    ...aggregateToolBlocks(members),
    status: "running",
    live: true,
  };
}

/**
 * The settled form of a successful batch: the counted header alone, past
 * tense, with the item rail dropped — completed activity compresses to one
 * line in the transcript.
 */
function collapseSettledToolBlocks(members: readonly Block[]): Block {
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

/** Newest call first: the rail reads bottom-up, like changes arriving. */
function newestFirstItems(members: readonly Block[]): ToolGroupItem[] {
  return members
    .slice()
    .reverse()
    .map((member): ToolGroupItem => {
      const item: ToolGroupItem = { text: member.toolGroup!.item };
      // Failed calls keep their individual error summaries visible per row.
      return member.status === "error" && member.result !== undefined
        ? { ...item, result: member.result }
        : item;
    });
}
