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

  it("partitions interleaved successes and failures into one group each", () => {
    const failedFirst = fetchBlock("f1", "https://a.example", "error", "status 403");
    const doneOne = fetchBlock("d1", "https://b.example", "done");
    const doneTwo = fetchBlock("d2", "https://c.example", "done");
    const failedSecond = fetchBlock("f2", "https://d.example", "error", "status 429");
    const doneThree = fetchBlock("d3", "https://e.example", "done");

    const groups = groupToolBlocksForDisplay([
      failedFirst,
      doneOne,
      doneTwo,
      failedSecond,
      doneThree,
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.members).toEqual([failedFirst, failedSecond]);
    // Failures keep their itemized rail, newest call first.
    expect(groups[0]?.display).toMatchObject({
      title: "Fetch 2 URLs",
      status: "error",
      toolGroupItems: [
        { text: "https://d.example", result: "status 429" },
        { text: "https://a.example", result: "status 403" },
      ],
    });
    expect(groups[1]?.members).toEqual([doneOne, doneTwo, doneThree]);
    expect(groups[1]?.display).toMatchObject({
      title: "Fetch 3 URLs",
      doneTitle: "Fetched 3 URLs",
      status: "done",
    });
    expect(groups[1]?.display.toolGroupItems).toBeUndefined();
  });

  it("keeps a lone failure as its own block with the original result line", () => {
    const done = fetchBlock("d1", "https://a.example", "done");
    const failed = fetchBlock("f1", "https://b.example", "error", "status 404");

    const groups = groupToolBlocksForDisplay([done, failed]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.display).toBe(done);
    expect(groups[1]?.display).toBe(failed);
    expect(groups[1]?.display.result).toBe("status 404");
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

  it("coalesces a contiguous run of same-source log writes into one section", () => {
    const write = (title: string, body: string, live = false): Block => ({
      kind: "log",
      title,
      body,
      live,
    });

    const groups = groupToolBlocksForDisplay([
      write("stderr", "warning one\ndetail one"),
      write("stderr", "warning two", true),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
    // The merged section shows only the newest write — every stored
    // diagnostic points at the log file, so on-screen history is redundant
    // — and stays live while any write still is.
    expect(groups[0]?.display).toMatchObject({
      kind: "log",
      title: "stderr",
      body: "warning two",
      live: true,
      elided: 1,
    });
  });

  it("buckets a log run by source and visibility without merging across them", () => {
    const concise: Block = {
      kind: "log",
      title: "stderr",
      body: "concise one",
      logVisibility: "summary",
      live: false,
    };
    const raw: Block = {
      kind: "log",
      title: "stderr",
      body: "raw one",
      logVisibility: "all-only",
      live: false,
    };
    const conciseTwo: Block = { ...concise, body: "concise two" };
    const rawTwo: Block = { ...raw, body: "raw two" };

    const groups = groupToolBlocksForDisplay([concise, raw, conciseTwo, rawTwo]);

    // The concise/raw diagnostic twins each merge with their own kind — a
    // mixed section would double the content under one log filter.
    expect(groups).toHaveLength(2);
    expect(groups[0]?.display).toMatchObject({
      body: "concise two",
      elided: 1,
      logVisibility: "summary",
    });
    expect(groups[1]?.display).toMatchObject({
      body: "raw two",
      elided: 1,
      logVisibility: "all-only",
    });
  });

  it("keeps a lone write and in-place log status blocks out of coalescing", () => {
    const lone: Block = {
      kind: "log",
      title: "stderr",
      body: Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n"),
      live: false,
    };
    const status: Block = {
      kind: "log",
      id: "dev-rebuild:1",
      title: "stdout",
      body: "3 files changed · rebuilding…",
      live: true,
    };
    const write: Block = { kind: "log", title: "stdout", body: "ordinary", live: false };

    const groups = groupToolBlocksForDisplay([lone, status, write]);

    // A lone write is never windowed, and the rebuild status row must not
    // absorb (or be absorbed by) neighboring writes. Single-member buckets
    // sit at their own positions.
    expect(groups.map((group) => group.display)).toEqual([lone, status, write]);
  });

  it("merges a source's writes across interleaved blocks in window mode only", () => {
    const write = (body: string): Block => ({ kind: "log", title: "stderr", body, live: false });
    const notice: Block = { kind: "notice", body: "boundary", live: false };
    const blocks = [write("early failure"), notice, write("late failure")];

    // Window mode: one stream section anchored at the newest write, so
    // everything that happened after the last error displays after it.
    const windowed = groupToolBlocksForDisplay(blocks);
    expect(windowed.map((group) => group.display.kind)).toEqual(["notice", "log"]);
    expect(windowed[1]?.display).toMatchObject({ body: "late failure", elided: 1 });

    // Runs mode (transcript rebuilds): committed positions stay put.
    const runs = groupToolBlocksForDisplay(blocks, { logCoalescing: "runs" });
    expect(runs.map((group) => group.display.kind)).toEqual(["log", "notice", "log"]);
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
