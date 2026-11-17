import { describe, expect, it } from "vitest";

import { reasoningStatus } from "#channel/reasoning-status.js";

describe("reasoningStatus", () => {
  it.each([
    {
      name: "prefers the latest bold heading",
      reasoning: "**Planning**\nFirst idea.\n**Checking Snowflake sources**\nMore text",
      expected: "Checking Snowflake sources",
    },
    {
      name: "skips a sentence still streaming below the display limit",
      reasoning: "I should check the revenue tables first. Then compare",
      expected: "I should check the revenue tables first.",
    },
    {
      name: "shows a streaming sentence once it reaches the display limit",
      reasoning: "Short start. Now I am comparing quarterly revenue across every region we",
      expected: "Now I am comparing quarterly revenue across every region we",
    },
    {
      name: "drops numbered list markers",
      reasoning: "Steps to take:\n1. Read the quarterly revenue tables.\n2. Compare",
      expected: "Read the quarterly revenue tables.",
    },
    {
      name: "skips code fences",
      reasoning: "Running the revenue query now.\n```sql select 1 from revenue_tables```",
      complete: true,
      expected: "Running the revenue query now.",
    },
    {
      name: "strips markdown from the chosen piece",
      reasoning: "I'll call `query_revenue` with **region** set to [EMEA](https://x.y).",
      complete: true,
      expected: "I'll call query_revenue with region set to EMEA.",
    },
    {
      name: "shows a short final sentence once the reasoning is complete",
      reasoning: "Long preamble about revenue. Then compare",
      complete: true,
      expected: "Then compare",
    },
  ])("$name", ({ reasoning, complete, expected }) => {
    expect(reasoningStatus(reasoning, { complete, maxLength: 50 })).toBe(expected);
  });

  it("holds a streaming sentence back until it reaches the caller's limit", () => {
    const reasoning =
      "I should check the revenue tables for last quarter. Then compare them against the forecast numbers from the fin";
    expect(reasoningStatus(reasoning, { maxLength: 50 })).toBe(
      "Then compare them against the forecast numbers from the fin",
    );
    expect(reasoningStatus(reasoning, { maxLength: 200 })).toBe(
      "I should check the revenue tables for last quarter.",
    );
  });

  it("returns nothing when no piece reads as prose", () => {
    expect(reasoningStatus("```\n1234\n```", { complete: true, maxLength: 50 })).toBeUndefined();
  });
});
