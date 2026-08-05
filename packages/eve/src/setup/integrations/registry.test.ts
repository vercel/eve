import { describe, expect, it } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Asker } from "#setup/ask.js";

import { integrationSetupEnvironment } from "./shared/environment.js";
import { setupIntegration } from "./registry.js";
import { WizardCancelledError } from "../step.js";

const unusedAsker: Asker = {
  ask: async <T>() => undefined as T,
  askMany: async () => [],
};

function context(prompter = createFakePrompter().prompter) {
  return {
    appRoot: "/tmp/project",
    environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" } as const),
    ui: {
      asker: unusedAsker,
      prompter,
      confirm: async () => false,
      nextSteps: () => {},
    },
  };
}

describe("setup integrations", () => {
  it("keeps Slack credential-picker cancellation as a structured result", async () => {
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });

    await expect(setupIntegration("slack").setup(context(fake.prompter))).resolves.toEqual({
      kind: "cancelled",
    });
  });

  it("registers guided Resend setup", () => {
    expect(setupIntegration("resend")).toMatchObject({ kind: "resend", label: "Resend" });
  });

  it("rejects an unknown integration", () => {
    expect(() => setupIntegration("unknown")).toThrow(
      'Integration setup "unknown" is not available',
    );
  });
});
