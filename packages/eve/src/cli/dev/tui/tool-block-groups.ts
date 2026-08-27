import type { Block, DisplayBlock, ToolGroupItem } from "./blocks.js";
import { toolBaseName } from "./tool-presentation.js";

export interface ToolBlockDisplayGroup {
  readonly members: readonly Block[];
  readonly display: DisplayBlock;
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
 * `… +N more` row. Captured log writes coalesce per
 * {@link GroupToolBlocksOptions.logCoalescing}. Because of all this, a
 * group's members are not always contiguous in the input: callers that
 * consume a group must remove its members by identity, never by prefix
 * length.
 */
export interface GroupToolBlocksOptions {
  /**
   * How captured log writes coalesce. `"window"` (the default, for the live
   * block window) merges every write of one source across the whole input
   * into a single section appended after the rest — a process stream is
   * continuous, so interleaved activity must not fragment it — and the
   * section commits as one cluster at the turn boundary. `"runs"` (for
   * committed-transcript rebuilds) merges only contiguous writes, so a
   * `/loglevel` toggle re-renders history at its committed positions instead
   * of relocating every past write to the end.
   */
  readonly logCoalescing?: "window" | "runs";
}

export function groupToolBlocksForDisplay(
  blocks: readonly Block[],
  options: GroupToolBlocksOptions = {},
): ToolBlockDisplayGroup[] {
  if ((options.logCoalescing ?? "window") === "window") {
    // Bucket every write by (source, visibility) and anchor each bucket's
    // ready-made merged group at its NEWEST member: the section renders
    // where the last write landed, so everything that happened after it
    // displays after it. Non-anchor members simply drop from the walk —
    // they ride the anchored group's member list.
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
        // Window mode: only a bucket's newest member emits its prebuilt
        // merged group, at the last write's position.
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
    if (first.kind === "subagent" && first.subagentCallId !== undefined) {
      const run = collectSubagentRun(blocks, index, logAnchors);
      groups.push(...run.groups);
      index += run.consumed;
      continue;
    }
    // Inside a subagent's flow, a settled tool run directly followed by a
    // message condenses to one multi-kind row — the message is the story,
    // the tools its footnote. Failed calls ride the run without breaking
    // it: they group with the other tools but stay itemized as their own
    // rows, because an error must not vanish into a count.
    if (isCondensableChildTool(first)) {
      const run = [first];
      while (index + run.length < blocks.length) {
        const candidate = blocks[index + run.length]!;
        if (candidate.subagentCallId !== first.subagentCallId) break;
        if (!isCondensableChildTool(candidate) && !isItemizedChildFailure(candidate)) break;
        run.push(candidate);
      }
      const next = blocks[index + run.length];
      const condensable = run.filter(isCondensableChildTool);
      if (
        condensable.length >= 2 &&
        next?.kind === "subagent-step" &&
        // The message must belong to the same call — a sibling section's
        // prose must not trigger a foreign run's condensation.
        next.subagentCallId === first.subagentCallId
      ) {
        groups.push({ members: condensable, display: condenseChildToolRun(condensable) });
        for (const failure of run) {
          if (!isCondensableChildTool(failure)) {
            groups.push({ members: [failure], display: failure });
          }
        }
        index += run.length;
        continue;
      }
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
    // Copy derives from the tool name, so name equality implies equal copy.
    candidate.toolName === first.toolName
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
 * A live subagent section shows only its most recently active child row;
 * everything earlier collapses into a single `… (N more)` line under the
 * header. The completed section's counted footnote carries the full story.
 */
export const maxVisibleSubagentRunChildren = 1;

/**
 * An ordinary captured write. In-place log status blocks (the dev rebuild
 * cycle) carry an id and must never merge into a run.
 */
function isGroupableLogWrite(block: Block): boolean {
  return block.kind === "log" && block.id === undefined;
}

/** The (source, visibility) identity a write merges under. */
function logBucketKey(block: Block): string {
  return `${block.title ?? ""}\u0000${block.logVisibility ?? ""}`;
}

/**
 * Coalesces captured writes into one section per (source, visibility)
 * bucket, so a stream renders as a single `○ stderr` section instead of one
 * per write. Bucketing keeps the concise/raw diagnostic twins apart — only
 * one of the pair is visible under any log filter, and a merged display can
 * carry only one visibility. The section shows only the NEWEST write —
 * every stored diagnostic points at the log file, so history on screen is
 * redundant — with earlier writes collapsed into the elided count.
 */
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

/** One already-bucketed stream's merged group: the newest write, counted. */
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
  return { members, display };
}

/**
 * Block kinds that may splice into a subagent run (captured output, stream
 * errors, notices) without belonging to it. They pass through and re-emit
 * after the sections they interrupted instead of splitting a run into
 * headerless fragments.
 */
const RUN_PASS_THROUGH_KINDS: ReadonlySet<Block["kind"]> = new Set([
  "log",
  "sandbox",
  "error",
  "warning",
  "notice",
]);

/**
 * Unscrambles a run of interleaved subagent calls — any names — into
 * individual sections: each call keeps its own header (ordinal subtitles
 * tell parallel same-named calls apart) followed by its own newest-window
 * of child rows. Collection is run-wide because parallel calls' children
 * arrive interleaved in block order.
 */
function collectSubagentRun(
  blocks: readonly Block[],
  start: number,
  logAnchors?: ReadonlyMap<Block, ToolBlockDisplayGroup>,
): { consumed: number; groups: ToolBlockDisplayGroup[] } {
  const first = blocks[start]!;
  const headers = [first];
  const childrenByCall = new Map<string, Block[]>([[first.subagentCallId!, []]]);
  const passThrough: Block[] = [];
  let consumed = 1;
  for (; start + consumed < blocks.length; consumed += 1) {
    const candidate = blocks[start + consumed]!;
    if (RUN_PASS_THROUGH_KINDS.has(candidate.kind)) {
      passThrough.push(candidate);
      continue;
    }
    if (candidate.kind === "subagent") {
      if (candidate.subagentCallId === undefined) break;
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
  // Trailing pass-through blocks did not interrupt anything — hand them
  // back to the main loop so they keep their position after the run.
  while (passThrough.length > 0 && blocks[start + consumed - 1] === passThrough.at(-1)) {
    passThrough.pop();
    consumed -= 1;
  }

  const groups: ToolBlockDisplayGroup[] = [];
  for (const header of headers) {
    const children = childrenByCall.get(header.subagentCallId!)!;
    // A section stays live while its own header or any of its children
    // still streams; sibling calls settle independently.
    const live = header.live !== false || children.some((child) => child.live !== false);
    const headerDisplay: DisplayBlock =
      live === (header.live !== false) ? header : { ...header, live };

    // A completed call collapses whole: the header reports Done and the
    // children fold into one counted footnote on the closing corner (the
    // parent's own reply carries the conclusion). Members still ride the
    // groups so they commit and clear by identity.
    if (header.status === "done") {
      const summary = condensedChildSummary(children);
      groups.push({ members: [header], display: headerDisplay });
      groups.push({
        members: children,
        display: {
          kind: "subagent-close",
          subagentCallId: header.subagentCallId!,
          live,
          body: summary === undefined ? "Done" : `Done. ${summary}`,
        },
      });
      continue;
    }

    groups.push({ members: [header], display: headerDisplay });

    // Group the full child list first — so a condensed row counts every
    // call it stands for — then order MRU-down: each group sorts by its
    // newest member, so the latest activity sits nearest the live edge and
    // an accumulating batch sinks as it receives calls. The window keeps
    // the most recent display rows; dropped groups' blocks stay members
    // (they must still commit and clear by identity) but collapse into one
    // display-only `… (N more)` row that counts raw events, not display
    // rows.
    // Activity stamps rank a just-updated call above a later-announced idle
    // one. The renderer stamps every push and in-place update; grouping
    // reads exactly one ordering semantic.
    const recency = (group: ToolBlockDisplayGroup) =>
      group.members.reduce((max, member) => Math.max(max, updateRecency(member)), -1);
    const childGroups = groupToolBlocksForDisplay(children)
      .slice()
      .sort((a, b) => recency(a) - recency(b));
    const dropped = childGroups.slice(
      0,
      Math.max(0, childGroups.length - maxVisibleSubagentRunChildren),
    );
    const kept = childGroups.slice(dropped.length);
    const elidedMembers = dropped.flatMap((group) => group.members);
    if (elidedMembers.length > 0) {
      groups.push({
        members: elidedMembers,
        display: { kind: "subagent-step", depth: 1, live, elided: elidedMembers.length },
      });
    }
    // The rail closes on the newest child instead of a bare corner row:
    // the last kept group's display (a clone — displays can be original
    // blocks, and the flag must re-derive per paint) carries the corner.
    groups.push(...kept.slice(0, -1));
    const lastKept = kept.at(-1);
    if (lastKept !== undefined) {
      groups.push({
        members: lastKept.members,
        display: { ...lastKept.display, closesRail: true },
      });
    }
  }
  // Interrupting pass-through blocks render after the sections they
  // spliced into. In window mode a spliced log write emits only if it is
  // its bucket's anchor (the merged section); earlier members ride that
  // group instead.
  for (const block of passThrough) {
    if (logAnchors !== undefined && isGroupableLogWrite(block)) {
      const group = logAnchors.get(block);
      if (group !== undefined) groups.push(group);
      continue;
    }
    groups.push({ members: [block], display: block });
  }
  return { consumed, groups };
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

/**
 * The accumulating form of an in-flight batch: one counted header whose items
 * list every announced call, newest first, so fresh calls surface at the top
 * of the rail while earlier ones slide toward the elision line.
 */
function aggregateLiveToolBlocks(members: readonly Block[]): DisplayBlock {
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

/**
 * A settled child tool can fold into the multi-kind condensed row once a
 * message follows it. Failures stay itemized — an error must not vanish
 * into a count.
 */
function isCondensableChildTool(block: Block): boolean {
  return block.kind === "subagent-tool" && block.status === "done" && block.expanded !== true;
}

/** A failed child call: rides a condensable run but keeps its own row. */
function isItemizedChildFailure(block: Block): boolean {
  return block.kind === "subagent-tool" && block.status === "error" && block.expanded !== true;
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
 * The whole activity footnote of a completed section: counted settled work
 * plus a failure count — an error may fold into the collapsed form, but it
 * must never vanish from it. `undefined` when the child ran no tools.
 */
function condensedChildSummary(children: readonly Block[]): string | undefined {
  const tools = children.filter((block) => block.kind === "subagent-tool");
  if (tools.length === 0) return undefined;
  const settled = tools.filter((block) => block.status === "done");
  const failed = tools.filter((block) => block.status === "error").length;
  const parts: string[] = [];
  if (settled.length > 0) parts.push(condensedRunTitle(settled));
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Folds one settled child-tool run into a single counted row.
 */
function condenseChildToolRun(run: readonly Block[]): DisplayBlock {
  const title = condensedRunTitle(run);
  const first = run[0]!;
  return {
    kind: "subagent-tool",
    subagentCallId: first.subagentCallId,
    depth: first.depth,
    live: first.live,
    status: "done",
    title,
    doneTitle: title,
    subtitle: "",
  };
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
  return { pastVerb: "Made", singularNoun: "tool call", pluralNoun: "tool calls" };
}

/** A block's activity stamp; unstamped (test-built) blocks all tie at 0. */
function updateRecency(block: Block): number {
  return block.updateSeq ?? 0;
}

/**
 * Most recently active call first: the rail reads bottom-up, like changes
 * arriving. Activity stamps put a just-settled parallel call ahead of a
 * later-announced one still idle.
 */
function newestFirstItems(members: readonly Block[]): ToolGroupItem[] {
  return members
    .map((member, position) => ({ member, order: updateRecency(member), position }))
    .sort((a, b) => b.order - a.order || b.position - a.position)
    .map(({ member }): ToolGroupItem => {
      const item: ToolGroupItem = { text: member.toolGroup!.item };
      // Failed calls keep their individual error summaries visible per row.
      return member.status === "error" && member.result !== undefined
        ? { ...item, result: member.result }
        : item;
    });
}
