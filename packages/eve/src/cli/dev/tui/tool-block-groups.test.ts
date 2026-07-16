import { describe, expect, it } from "vitest";

import type { Block } from "./blocks.js";
import { groupToolBlocksForDisplay } from "./tool-block-groups.js";

function fetchBlock(id: string, item: string, status: "running" | "done"): Block {
  return {
    kind: "tool",
    id,
    live: status === "running",
    status,
    title: `Fetch ${item}`,
    toolGroup: { verb: "Fetch", singularNoun: "URL", pluralNoun: "URLs", item },
  };
}

describe("groupToolBlocksForDisplay", () => {
  it("coalesces adjacent equivalent calls while retaining independent members", () => {
    const first = fetchBlock("one", "https://one.example", "done");
    const second = fetchBlock("two", "https://two.example", "done");
    const [group] = groupToolBlocksForDisplay([first, second]);

    expect(group?.members).toEqual([first, second]);
    expect(group?.display).toMatchObject({
      id: undefined,
      title: "Fetch 2 URLs",
      toolGroupItems: ["https://one.example", "https://two.example"],
    });
  });

  it("keeps calls separate when status or intervening content differs", () => {
    const blocks: Block[] = [
      fetchBlock("one", "https://one.example", "done"),
      { kind: "assistant", body: "between", live: false },
      fetchBlock("two", "https://two.example", "running"),
    ];

    expect(groupToolBlocksForDisplay(blocks).map((group) => group.members.length)).toEqual([
      1, 1, 1,
    ]);
  });
});
