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
      name: "skips a short sentence that is still streaming",
      reasoning: "I should check the revenue tables first. Then compare",
      expected: "I should check the revenue tables first.",
    },
    {
      name: "shows a streaming sentence once it is long enough",
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
  ])("$name", ({ reasoning, complete, expected }) => {
    expect(reasoningStatus(reasoning, { complete })).toBe(expected);
  });

  it("shows a short final sentence once the reasoning is complete", () => {
    expect(reasoningStatus("Long preamble about revenue. Then compare")).toBe(
      "Long preamble about revenue.",
    );
    expect(reasoningStatus("Long preamble about revenue. Then compare", { complete: true })).toBe(
      "Then compare",
    );
  });

  it("returns nothing when no piece reads as prose", () => {
    expect(reasoningStatus("```\n1234\n```", { complete: true })).toBeUndefined();
  });
});
