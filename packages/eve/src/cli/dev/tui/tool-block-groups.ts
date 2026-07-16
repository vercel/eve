import type { Block } from "./blocks.js";

export interface ToolBlockDisplayGroup {
  readonly members: readonly Block[];
  readonly display: Block;
}

/** Coalesces presentation only; each member keeps its call id and lifecycle. */
export function groupToolBlocksForDisplay(blocks: readonly Block[]): ToolBlockDisplayGroup[] {
  const groups: ToolBlockDisplayGroup[] = [];
  for (let index = 0; index < blocks.length;) {
    const first = blocks[index]!;
    const members = [first];
    if (isGroupable(first)) {
      while (index + members.length < blocks.length) {
        const candidate = blocks[index + members.length]!;
        if (!canJoin(first, candidate)) break;
        members.push(candidate);
      }
    }

    groups.push({
      members,
      display: members.length === 1 ? first : aggregateToolBlocks(first, members),
    });
    index += members.length;
  }
  return groups;
}

function isGroupable(block: Block): boolean {
  return (
    (block.kind === "tool" || block.kind === "subagent-tool") &&
    block.toolGroup !== undefined &&
    block.expanded !== true &&
    block.result === undefined &&
    (block.status === "running" || block.status === "done")
  );
}

function canJoin(first: Block, candidate: Block): boolean {
  return (
    isGroupable(candidate) &&
    candidate.kind === first.kind &&
    candidate.depth === first.depth &&
    candidate.status === first.status &&
    candidate.live === first.live &&
    candidate.toolGroup?.verb === first.toolGroup?.verb &&
    candidate.toolGroup?.singularNoun === first.toolGroup?.singularNoun &&
    candidate.toolGroup?.pluralNoun === first.toolGroup?.pluralNoun
  );
}

function aggregateToolBlocks(first: Block, members: readonly Block[]): Block {
  const group = first.toolGroup!;
  const count = members.length;
  return {
    ...first,
    id: undefined,
    title: `${group.verb} ${count} ${count === 1 ? group.singularNoun : group.pluralNoun}`,
    toolGroupItems: members.map((member) => member.toolGroup!.item),
  };
}
