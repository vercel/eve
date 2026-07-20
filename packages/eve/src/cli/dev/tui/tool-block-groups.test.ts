import { describe, expect, it } from "vitest";

import type { Block } from "./blocks.js";
import { groupToolBlocksForDisplay, maxVisibleSubagentRunChildren } from "./tool-block-groups.js";

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

function subagentHeader(callId: string, name: string): Block {
  return {
    kind: "subagent",
    id: `subagent:${callId}:header`,
    subagentCallId: callId,
    title: name,
    live: false,
  };
}

function subagentStep(callId: string, body: string, live = false): Block {
  return {
    kind: "subagent-step",
    id: `subagent:${callId}:step:0`,
    subagentCallId: callId,
    depth: 1,
    body,
    live,
  };
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

  it("condenses a settled child-tool run into one counted row once a message follows", () => {
    const child = (id: string, toolName: string, verb: [string, string], noun: [string, string]) =>
      ({
        kind: "subagent-tool",
        id,
        subagentCallId: "c1",
        depth: 1,
        live: false,
        status: "done",
        toolName,
        title: `${verb[0]} x`,
        toolGroup: {
          verb: verb[0],
          pastVerb: verb[1],
          singularNoun: noun[0],
          pluralNoun: noun[1],
          item: "x",
        },
      }) satisfies Block;

    const run = [
      child("b1", "bash", ["Run", "Ran"], ["command", "commands"]),
      child("r1", "read_file", ["Read", "Read"], ["file", "files"]),
      {
        kind: "subagent-tool",
        id: "w1",
        subagentCallId: "c1",
        depth: 1,
        live: false,
        status: "done",
        toolName: "write_file",
        title: "Write /a",
      } satisfies Block,
      {
        kind: "subagent-tool",
        id: "s1",
        subagentCallId: "c1",
        depth: 1,
        live: false,
        status: "done",
        toolName: "web_search",
        title: "Search x",
        toolGroup: {
          verb: "Search",
          pastVerb: "Searched",
          singularNoun: "query",
          pluralNoun: "queries",
          item: "x",
        },
      } satisfies Block,
    ];
    const step: Block = {
      kind: "subagent-step",
      id: "m1",
      subagentCallId: "c1",
      depth: 1,
      live: false,
      body: "Here is what I found.",
    };

    const groups = groupToolBlocksForDisplay([subagentHeader("c1", "researcher"), ...run, step]);

    // header, the condensed run elided behind the stand-in, then the
    // message (the newest row) closing the rail.
    expect(groups).toHaveLength(3);
    expect(groups[1]?.members).toEqual(run);
    expect(groups[1]?.display).toMatchObject({ kind: "subagent-step", elided: 4 });
    expect(groups[2]?.members).toEqual([step]);
    expect(groups[2]?.display).toEqual({ ...step, closesRail: true });
  });

  it("leaves a settled child-tool run itemized when no message follows", () => {
    const tool = (id: string): Block => ({
      kind: "subagent-tool",
      id,
      subagentCallId: "c1",
      depth: 1,
      live: false,
      status: "done",
      toolName: "bash",
      title: "Run x",
      toolGroup: {
        verb: "Run",
        pastVerb: "Ran",
        singularNoun: "command",
        pluralNoun: "commands",
        item: "x",
      },
    });

    const groups = groupToolBlocksForDisplay([
      subagentHeader("c1", "researcher"),
      tool("b1"),
      tool("b2"),
    ]);

    // Falls back to the ordinary per-kind aggregation, items intact.
    expect(groups[1]?.display).toMatchObject({ title: "Run 2 commands" });
  });

  it("keeps interleaved different-named subagent calls as whole sections", () => {
    const ha = subagentHeader("ca", "researcher");
    const hb = subagentHeader("cb", "reviewer");
    const a1 = { ...subagentStep("ca", "finding one"), id: "ca:1", subagentCallId: "ca" };
    const b1 = { ...subagentStep("cb", "critique one"), id: "cb:1", subagentCallId: "cb" };
    const a2 = { ...subagentStep("ca", "finding two"), id: "ca:2", subagentCallId: "ca" };

    // Parallel different subagents interleave; neither may fragment the
    // other into headerless children.
    const groups = groupToolBlocksForDisplay([ha, hb, a1, b1, a2]);

    expect(groups.map((group) => group.display)).toEqual([
      ha,
      { kind: "subagent-step", depth: 1, live: false, elided: 1 },
      { ...a2, closesRail: true },
      hb,
      { ...b1, closesRail: true },
    ]);
  });

  it("does not condense a run against a sibling section's message", () => {
    const tool = (id: string): Block => ({
      kind: "subagent-tool",
      id,
      subagentCallId: "ca",
      depth: 1,
      live: false,
      status: "done",
      toolName: "bash",
      title: "Run x",
      toolGroup: {
        verb: "Run",
        pastVerb: "Ran",
        singularNoun: "command",
        pluralNoun: "commands",
        item: "x",
      },
    });
    const foreignStep: Block = {
      kind: "subagent-step",
      id: "cb:1",
      subagentCallId: "cb",
      depth: 1,
      live: false,
      body: "sibling's message",
    };

    // Headerless layout (worst case): the foreign message directly follows
    // the run but belongs to another call — no condensation.
    const groups = groupToolBlocksForDisplay([tool("a"), tool("b"), foreignStep]);

    expect(groups[0]?.display).toMatchObject({ title: "Run 2 commands" });
    expect(groups[0]?.display.title).not.toContain("Ran");
  });

  it("passes captured log blocks through a subagent run without splitting it", () => {
    const header = subagentHeader("c1", "researcher");
    const s1 = subagentStep("c1", "finding one");
    const stderr: Block = {
      kind: "log",
      title: "stderr",
      body: "tool execution failed",
      live: false,
    };
    const s2 = subagentStep("c2", "other call");

    // The stderr write spliced itself between the run's children; the
    // section must stay whole, with the log re-emitted after it.
    const groups = groupToolBlocksForDisplay([
      header,
      stderr,
      { ...s1, id: "c1:s1" },
      subagentHeader("c2", "researcher"),
      { ...s2, id: "c2:s2", subagentCallId: "c2" },
    ]);

    expect(groups.map((group) => group.display.kind)).toEqual([
      "subagent",
      "subagent-step",
      "subagent",
      "subagent-step",
      "log",
    ]);
  });

  it("hands trailing logs back to the main loop after a run", () => {
    const header = subagentHeader("c1", "researcher");
    const step = subagentStep("c1", "finding");
    const stderr: Block = { kind: "log", title: "stderr", body: "late failure", live: false };

    const groups = groupToolBlocksForDisplay([header, step, stderr]);

    expect(groups.map((group) => group.display.kind)).toEqual(["subagent", "subagent-step", "log"]);
  });

  it("keeps interleaved same-subagent calls as separate sections with rebucketed children", () => {
    const h1 = subagentHeader("c1", "echo-marker");
    const s1 = subagentStep("c1", "token one");
    const h2 = subagentHeader("c2", "echo-marker");
    const s2 = subagentStep("c2", "token two");
    const h3 = subagentHeader("c3", "echo-marker");
    const s3 = subagentStep("c3", "token three");

    // Children arrive interleaved; each call's section reassembles its own.
    const groups = groupToolBlocksForDisplay([h1, h2, h3, s1, s2, s3]);

    expect(groups.map((group) => group.display)).toEqual([
      h1,
      { ...s1, closesRail: true },
      h2,
      { ...s2, closesRail: true },
      h3,
      { ...s3, closesRail: true },
    ]);
  });

  it("keeps a section live while its own children stream, independent of siblings", () => {
    const settledHeader = { ...subagentHeader("c1", "echo-marker"), live: false };
    const liveChildHeader = { ...subagentHeader("c2", "echo-marker"), live: false };
    const groups = groupToolBlocksForDisplay([
      settledHeader,
      subagentStep("c1", "token one"),
      liveChildHeader,
      subagentStep("c2", "token two", true),
    ]);

    expect(groups[0]?.display.live).toBe(false);
    expect(groups[2]?.display.live).toBe(true);
  });

  it("keeps the run live while a header still is, even after every child settles", () => {
    const groups = groupToolBlocksForDisplay([
      { ...subagentHeader("c1", "echo-marker"), live: true },
      subagentStep("c1", "token one"),
      { ...subagentHeader("c2", "echo-marker"), live: true },
      subagentStep("c2", "token two"),
    ]);

    expect(groups[0]?.display.live).toBe(true);
  });

  it("windows each section to its newest children independently", () => {
    const blocks: Block[] = [subagentHeader("c1", "echo-marker")];
    const first: Block[] = [];
    for (let index = 1; index <= maxVisibleSubagentRunChildren + 3; index += 1) {
      const step = { ...subagentStep("c1", `one ${index}`), id: `c1:step:${index}` };
      blocks.push(step);
      first.push(step);
    }
    blocks.push(subagentHeader("c2", "echo-marker"), subagentStep("c2", "two 1"));

    const groups = groupToolBlocksForDisplay(blocks);

    // First section: header, one elision stand-in, then its newest window.
    expect(groups[1]?.members).toEqual(first.slice(0, 3));
    expect(groups[1]?.display).toMatchObject({ kind: "subagent-step", elided: 3 });
    expect(groups.slice(2, 2 + maxVisibleSubagentRunChildren).map((g) => g.display)).toEqual([
      ...first.slice(3, -1),
      { ...first.at(-1)!, closesRail: true },
    ]);
    // The second section is untouched by the first one's overflow.
    const secondHeader = groups.findIndex(
      (group) => group.display.kind === "subagent" && group.display.subagentCallId === "c2",
    );
    expect(secondHeader).toBeGreaterThan(-1);
    expect(groups[secondHeader + 1]?.display.body).toBe("two 1");
  });

  it("caps a single call's long child list too", () => {
    const header = subagentHeader("c1", "researcher");
    const steps = Array.from({ length: maxVisibleSubagentRunChildren + 2 }, (_, index) => ({
      ...subagentStep("c1", `finding ${index + 1}`),
      id: `subagent:c1:step:${index}`,
    }));

    const groups = groupToolBlocksForDisplay([header, ...steps]);

    expect(groups[1]?.display.elided).toBe(2);
    expect(groups[1]?.members).toEqual(steps.slice(0, 2));
    expect(groups.slice(2).map((group) => group.display)).toEqual([
      ...steps.slice(2, -1),
      { ...steps.at(-1)!, closesRail: true },
    ]);
  });

  it("does not elide a run at or under the visible cap", () => {
    const header = subagentHeader("c1", "researcher");
    const steps = Array.from({ length: maxVisibleSubagentRunChildren }, (_, index) => ({
      ...subagentStep("c1", `finding ${index + 1}`),
      id: `subagent:c1:step:${index}`,
    }));

    const groups = groupToolBlocksForDisplay([header, ...steps]);

    expect(groups).toHaveLength(1 + maxVisibleSubagentRunChildren);
    expect(groups.every((group) => group.display.elided === undefined)).toBe(true);
  });

  it("does not merge sections of differently named subagents", () => {
    const groups = groupToolBlocksForDisplay([
      subagentHeader("c1", "echo-marker"),
      subagentStep("c1", "token one"),
      subagentHeader("c2", "researcher"),
      subagentStep("c2", "finding"),
    ]);

    const sections = groups.filter((group) => group.display.kind !== "subagent-close");
    expect(sections.map((group) => group.display.title ?? group.display.body)).toEqual([
      "echo-marker",
      "token one",
      "researcher",
      "finding",
    ]);
    expect(groups[0]?.display.subtitle).toBeUndefined();
  });

  it("keeps a single subagent section untouched", () => {
    const header = subagentHeader("c1", "researcher");
    const step = subagentStep("c1", "finding");

    const groups = groupToolBlocksForDisplay([header, step]);

    expect(groups.map((group) => group.display)).toEqual([header, { ...step, closesRail: true }]);
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
      logVisibility: "stderr-only",
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
      logVisibility: "stderr-only",
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
