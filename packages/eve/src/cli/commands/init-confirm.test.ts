import { describe, expect, it } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { confirmExistingPackageIntegration } from "./init-confirm.js";

const summary = ["Create agent/agent.ts", "Add dependencies: ai, eve"];

describe("confirmExistingPackageIntegration", () => {
  it("prints the plan and --yes recovery without a TTY", async () => {
    await expect(
      confirmExistingPackageIntegration(summary, {
        createPrompter: () => createFakePrompter().prompter,
        hasInteractiveTerminal: () => false,
      }),
    ).rejects.toThrow("Planned edits:\n  - Create agent/agent.ts\n  - Add dependencies: ai, eve");
  });

  it("confirms the durable-edit and install checkpoint in a TTY", async () => {
    let description = "";
    const fake = createFakePrompter({
      single: (options) => {
        description = options.description ?? "";
        return true;
      },
    });

    await expect(
      confirmExistingPackageIntegration(summary, {
        createPrompter: () => fake.prompter,
        hasInteractiveTerminal: () => true,
      }),
    ).resolves.toBeUndefined();

    expect(description).toContain("remain if installation fails");
  });

  it("cancels without applying the supplied plan", async () => {
    const fake = createFakePrompter({ single: () => false });

    await expect(
      confirmExistingPackageIntegration(summary, {
        createPrompter: () => fake.prompter,
        hasInteractiveTerminal: () => true,
      }),
    ).rejects.toThrow("no files were changed");
  });
});
