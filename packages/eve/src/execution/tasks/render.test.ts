import { describe, expect, it } from "vitest";

import {
  readTaskResults,
  renderTaskResults,
  renderTaskWaitResult,
} from "#execution/tasks/render.js";

describe("renderTaskResults", () => {
  it("cuts a one-line body at the budget instead of dropping it", () => {
    const body = JSON.stringify({ id: "abc123", data: "x".repeat(60_000) });
    const [block] = readTaskResults(
      renderTaskResults([{ body, status: "completed", taskId: "lookup-1", tool: "lookup" }]),
    );

    expect(block!.body.endsWith("[truncated]")).toBe(true);
    const kept = block!.body.replace(/\n?\[truncated\]$/, "");
    expect(body.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(50_000);
  });

  it("cuts a later body on a character boundary when an earlier one used most of the budget", () => {
    const [, second] = readTaskResults(
      renderTaskResults([
        { body: "a".repeat(50 * 1024 - 100), status: "completed", taskId: "a-1", tool: "a" },
        { body: "😀".repeat(1_000), status: "completed", taskId: "b-1", tool: "b" },
      ]),
    );

    expect(second!.body).toMatch(/^(?:😀)+\n\[truncated\]$/u);
  });
});

describe("renderTaskWaitResult", () => {
  it("tells the model to wait again when a result arrives while another task works", () => {
    const text = renderTaskWaitResult(
      {
        status: "settled",
        settled: [{ id: "compile_report-a1", status: "completed" }],
        working: ["compile_report-b2"],
      },
      1000,
    );
    expect(text).toBe(
      "compile_report-a1 completed; its result follows. 1 task is still working: compile_report-b2. " +
        "If your reply needs its result, call eve__task_wait again before replying.",
    );
  });

  it("names several working tasks' results in the plural", () => {
    const text = renderTaskWaitResult(
      {
        status: "settled",
        settled: [{ id: "a", status: "completed" }],
        working: ["b", "c"],
      },
      1000,
    );
    expect(text).toContain("If your reply needs their results, call eve__task_wait again");
  });

  it("adds nothing once every task has settled", () => {
    const text = renderTaskWaitResult(
      { status: "settled", settled: [{ id: "a", status: "completed" }], working: [] },
      1000,
    );
    expect(text).toBe("a completed; its result follows.");
  });
});
