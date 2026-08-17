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

  it("defaults to applying the visible plan in a TTY", async () => {
    let message = "";
    let details: readonly string[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        message = options.message;
        expect(options.initialValue).toBe(true);
        details = options.details ?? [];
        return true;
      },
    });

    await expect(
      confirmExistingPackageIntegration(summary, {
        createPrompter: () => fake.prompter,
        hasInteractiveTerminal: () => true,
      }),
    ).resolves.toBeUndefined();

    expect(message).toBe("Apply these edits?");
    expect(details).toEqual([
      "Planned edits",
      "• Create agent/agent.ts",
      "• Add dependencies: ai, eve",
    ]);
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
