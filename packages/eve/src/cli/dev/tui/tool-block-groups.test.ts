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

  it("coalesces interleaved same-subagent sections into one counted header", () => {
    const h1 = subagentHeader("c1", "echo-marker");
    const s1 = subagentStep("c1", "token one");
    const h2 = subagentHeader("c2", "echo-marker");
    const s2 = subagentStep("c2", "token two");
    const h3 = subagentHeader("c3", "echo-marker");
    const s3 = subagentStep("c3", "token three");

    const groups = groupToolBlocksForDisplay([h1, s1, h2, s2, h3, s3]);

    expect(groups).toHaveLength(4);
    expect(groups[0]?.members).toEqual([h1, h2, h3]);
    expect(groups[0]?.display).toMatchObject({
      kind: "subagent",
      id: undefined,
      title: "echo-marker",
      subtitle: "3 calls",
      live: false,
    });
    // Children re-order call by call beneath the shared header.
    expect(groups.slice(1).map((group) => group.display)).toEqual([s1, s2, s3]);
  });

  it("keeps a counted subagent header live while any call still streams", () => {
    const groups = groupToolBlocksForDisplay([
      subagentHeader("c1", "echo-marker"),
      subagentStep("c1", "token one"),
      subagentHeader("c2", "echo-marker"),
      subagentStep("c2", "token two", true),
    ]);

    expect(groups[0]?.display.live).toBe(true);
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

  it("elides all but the newest children behind a counted stand-in row", () => {
    const blocks: Block[] = [];
    const steps: Block[] = [];
    for (let call = 1; call <= 16; call += 1) {
      const step = subagentStep(`c${call}`, `token ${call}`);
      blocks.push(subagentHeader(`c${call}`, "echo-marker"), step);
      steps.push(step);
    }

    const groups = groupToolBlocksForDisplay(blocks);

    const elidedCount = 16 - maxVisibleSubagentRunChildren;
    expect(groups).toHaveLength(2 + maxVisibleSubagentRunChildren);
    expect(groups[0]?.display.subtitle).toBe("16 calls");
    expect(groups[1]?.members).toEqual(steps.slice(0, elidedCount));
    expect(groups[1]?.display).toMatchObject({
      kind: "subagent-step",
      depth: 1,
      elided: elidedCount,
    });
    expect(groups.slice(2).map((group) => group.display)).toEqual(steps.slice(elidedCount));
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
    expect(groups.slice(2).map((group) => group.display)).toEqual(steps.slice(2));
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

    expect(groups.map((group) => group.display.title ?? group.display.body)).toEqual([
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

    expect(groups.map((group) => group.display)).toEqual([header, step]);
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
