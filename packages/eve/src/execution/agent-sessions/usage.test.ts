import { describe, expect, it } from "vitest";

import { countRunUsage, createRunUsageTally } from "#execution/agent-sessions/usage.js";
import {
  getSessionUsage,
  getSessionUsageWindow,
  renewSessionUsageWindow,
} from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

function input(inputTokens: number): TokenUsage {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens, outputTokens: 0 };
}

const renewed = (renewalId: string) => renewSessionUsageWindow({ state: {} }, renewalId).session;

describe("run usage tally", () => {
  it("keeps a report the run carried before it heard of a renewal out of the caller's new window", () => {
    // 1. The caller applies R and sends it to the run.
    const caller = renewed("R");
    // 2. Before the run reads R, it carries 30M its session spent in the first window.
    const tally = createRunUsageTally();
    tally.record({ "": input(30_000_000) });
    const carried = tally.carry()!;
    // 3. The caller receives the report after its reset.
    const counted = countRunUsage(caller, carried);

    expect(getSessionUsageWindow(counted).inputTokens).toBe(0);
    expect(getSessionUsage(counted).inputTokens).toBe(30_000_000);
  });

  it("keeps a child turn that ended before the renewal out of the new window when the run hears of it after", () => {
    // The run already has R; the child's result, produced before the child applied R, arrives now.
    const tally = createRunUsageTally();
    tally.record({ "": input(30_000_000) });
    tally.record({ "": input(15_000_000), R: input(1_000_000) });
    const counted = countRunUsage(renewed("R"), tally.carry()!);

    expect(getSessionUsageWindow(counted).inputTokens).toBe(1_000_000);
    expect(getSessionUsage(counted).inputTokens).toBe(46_000_000);
  });

  it("counts each carry from the last one, window by window", () => {
    const tally = createRunUsageTally();
    tally.record({ "": input(10) });
    const first = tally.carry()!;
    tally.record({ "": input(5) });
    tally.record({ R: input(2) });

    expect(tally.hasUncarried()).toBe(true);
    const second = tally.carry()!;
    expect(tally.hasUncarried()).toBe(false);
    expect(second).toEqual({ usage: input(17), windows: { "": input(15), R: input(2) } });

    const caller = countRunUsage(renewed("R"), second, first);
    expect(getSessionUsageWindow(caller).inputTokens).toBe(2);
    expect(getSessionUsage(caller).inputTokens).toBe(7);
  });

  it("sends nothing new for a turn that spent nothing", () => {
    const tally = createRunUsageTally();
    tally.record({ "": input(0) });

    expect(tally.hasUncarried()).toBe(false);
    expect(tally.carry()).toBeUndefined();
  });
});
