import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { createSetupPresenter } from "./ui.js";

describe("createSetupPresenter", () => {
  it("renders next steps as a note", () => {
    const fake = createFakePrompter();
    createSetupPresenter(fake.prompter).nextSteps(["Deploy", "Open the app"]);
    expect(vi.mocked(fake.prompter.note)).toHaveBeenCalledWith(
      "Deploy\nOpen the app",
      "Next steps",
      { tone: "success" },
    );
  });
});
