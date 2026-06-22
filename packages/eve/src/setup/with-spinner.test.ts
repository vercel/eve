import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { describe, expect, it, vi } from "vitest";

import { withSpinner } from "./with-spinner.js";

describe("withSpinner", () => {
  it("returns the task result and stops the spinner", async () => {
    const { prompter } = createFakePrompter();
    const stop = vi.fn();
    const spinner = vi.fn(() => ({ stop }));
    prompter.log.spinner = spinner;

    await expect(withSpinner(prompter, "Working…", async () => 42)).resolves.toBe(42);

    expect(spinner).toHaveBeenCalledExactlyOnceWith("Working…");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the spinner when the task rejects", async () => {
    const { prompter } = createFakePrompter();
    const failure = new Error("boom");
    const stop = vi.fn();
    prompter.log.spinner = vi.fn(() => ({ stop }));

    await expect(
      withSpinner(prompter, "Working…", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("runs the task when the prompter has no spinner", async () => {
    const { prompter } = createFakePrompter();
    const task = vi.fn(async () => "done");

    await expect(withSpinner(prompter, "Working…", task)).resolves.toBe("done");

    expect(task).toHaveBeenCalledOnce();
  });
});
