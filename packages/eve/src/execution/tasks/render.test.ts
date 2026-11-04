import { describe, expect, it } from "vitest";

import { readTaskResults, renderTaskResults } from "#execution/tasks/render.js";

describe("renderTaskResults", () => {
  // Pins #5746 until the fix lands.
  it.fails("cuts a one-line body at the budget instead of dropping it", () => {
    const body = JSON.stringify({ id: "abc123", data: "x".repeat(60_000) });
    const [block] = readTaskResults(
      renderTaskResults([{ body, status: "completed", taskId: "lookup-1", tool: "lookup" }]),
    );

    expect(block!.body.endsWith("[truncated]")).toBe(true);
    const kept = block!.body.replace(/\n?\[truncated\]$/, "");
    expect(body.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(50_000);
  });
});
