import { describe, expect, it } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { interactiveAsker } from "../../ask.js";
import { createChannelSetupUi } from "./ui.js";

describe("createChannelSetupUi", () => {
  it("renders integration-owned next steps through the shared notice", () => {
    const fake = createFakePrompter();
    const ui = createChannelSetupUi({
      asker: interactiveAsker(fake.prompter),
      prompter: fake.prompter,
    });

    ui.nextSteps(["Set TOKEN in .env.local.", "Configure the webhook."]);

    expect(fake.prompter.note).toHaveBeenCalledWith(
      "Set TOKEN in .env.local.\nConfigure the webhook.",
      "Next steps",
      { tone: "success" },
    );
  });
});
