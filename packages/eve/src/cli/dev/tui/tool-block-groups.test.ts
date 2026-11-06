import { describe, expect, it } from "vitest";

import type { Block } from "./blocks.js";
import { groupToolBlocksForDisplay, summarizeChildTools } from "./tool-block-groups.js";

function fetchBlock(
  id: string,
  item: string,
  status: "running" | "done" | "error",
  result?: string,
  options?: { live?: boolean },
): Block {
  const block: Block = {
    kind: "tool",
    id,
    live: options?.live ?? status === "running",
    status,
    title: `Fetch ${item}`,
    toolGroup: {
      verb: "Fetch",
      pastVerb: "Fetched",
      singularNoun: "URL",
      pluralNoun: "URLs",
      item,
    },
  };
  if (result !== undefined) block.result = result;
  return block;
}

describe("groupToolBlocksForDisplay", () => {
  it("collapses a settled run to one counted, past-tense header without items", () => {
    const first = fetchBlock("one", "https://one.example", "done");
    const second = fetchBlock("two", "https://two.example", "done");
    const [group] = groupToolBlocksForDisplay([first, second]);

    expect(group?.members).toEqual([first, second]);
    expect(group?.display).toMatchObject({
      id: undefined,
      title: "Fetch 2 URLs",
      doneTitle: "Fetched 2 URLs",
    });
    expect(group?.display.toolGroupItems).toBeUndefined();
  });

  it("accumulates a live run into one group with items listed newest first", () => {
    // The renderer's cohort liveness keeps every member of an in-flight batch
    // live, settled or not — mirrored here so mixed statuses share one run.
    const settled = fetchBlock("one", "https://one.example", "done", undefined, { live: true });
    const running = fetchBlock("two", "https://two.example", "running");
    const newest = fetchBlock("three", "https://three.example", "running");
    const [group] = groupToolBlocksForDisplay([settled, running, newest]);

    expect(group?.members).toEqual([settled, running, newest]);
    expect(group?.display).toMatchObject({
      id: undefined,
      live: true,
      status: "running",
      title: "Fetch 3 URLs",
      toolGroupItems: [
        { text: "https://three.example" },
        { text: "https://two.example" },
        { text: "https://one.example" },
      ],
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

  it("keeps a settled run with failures as one group that itemizes every call", () => {
    const failedFirst = fetchBlock("f1", "https://a.example", "error", "status 403");
    const done = fetchBlock("d1", "https://b.example", "done");
    const failedSecond = fetchBlock("f2", "https://c.example", "error", "status 429");

    const groups = groupToolBlocksForDisplay([failedFirst, done, failedSecond]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toEqual([failedFirst, done, failedSecond]);
    // Failures keep their summaries on the rail, newest call first.
    expect(groups[0]?.display).toMatchObject({
      title: "Fetch 3 URLs",
      status: "error",
      toolGroupItems: [
        { text: "https://c.example", result: "status 429" },
        { text: "https://b.example" },
        { text: "https://a.example", result: "status 403" },
      ],
    });
  });

  it("keeps two agents' settled rows apart even when their calls match", () => {
    const read = (callId: string): Block => ({
      ...fetchBlock(`read:${callId}`, "https://one.example", "done"),
      kind: "subagent-tool",
      subagentCallId: callId,
      depth: 1,
      live: false,
    });
    const groups = groupToolBlocksForDisplay([read("c1"), read("c2")]);
    expect(groups.map((group) => group.members.length)).toEqual([1, 1]);
  });

  it("does not group a settled call with a still-running one", () => {
    const done = fetchBlock("d1", "https://a.example", "done");
    const running = fetchBlock("r1", "https://b.example", "running");

    expect(groupToolBlocksForDisplay([done, running]).map((group) => group.members)).toEqual([
      [done],
      [running],
    ]);
  });
});

describe("summarizeChildTools", () => {
  const child = (
    toolName: string,
    status: "done" | "error" | "running",
    copy?: [string, string, string],
  ): Block => {
    const block: Block = { kind: "subagent-tool", depth: 1, status, toolName, title: toolName };
    if (copy !== undefined) {
      block.toolGroup = {
        verb: copy[0],
        pastVerb: copy[0],
        singularNoun: copy[1],
        pluralNoun: copy[2],
        item: "x",
      };
    }
    return block;
  };

  it("counts an agent's settled work by kind, most frequent first, and never hides failures", () => {
    const read = child("read_file", "done", ["Read", "file", "files"]);
    const summary = summarizeChildTools([
      child("bash", "done", ["Ran", "command", "commands"]),
      read,
      read,
      child("write_file", "done"),
      child("web_fetch", "error", ["Fetched", "URL", "URLs"]),
      child("grep", "running", ["Grepped", "pattern", "patterns"]),
    ]);
    expect(summary).toBe("Read 2 files, Ran 1 command, Wrote 1 file, 1 failed");
  });

  it("has nothing to say for an agent that ran no tools", () => {
    expect(summarizeChildTools([])).toBeUndefined();
  });
});
