import { describe, expect, it } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Asker } from "#setup/ask.js";
import { WizardCancelledError } from "../step.js";
import { setupIntegration } from "./registry.js";
import { integrationSetupEnvironment } from "./shared/environment.js";
import { createSetupContexts } from "./shared/ui.js";

const asker: Asker = {
  ask: async <T>() => undefined as T,
  askEditable: async <T>() => ({ value: undefined as T }),
  askMany: async () => [],
};

describe("setup integrations", () => {
  it("folds prepare cancellation", async () => {
    const cancelling = {
      ...asker,
      ask: async () => {
        throw new WizardCancelledError();
      },
    };
    const contexts = createSetupContexts({
      appRoot: "/project",
      asker: cancelling,
      environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });
    await expect(setupIntegration("slack").run(contexts)).resolves.toEqual({ kind: "cancelled" });
  });
  it("registers GitHub", () => {
    expect(setupIntegration("github")).toMatchObject({ kind: "github", label: "GitHub" });
  });
  it("rejects unknown integrations", () => {
    expect(() => setupIntegration("unknown")).toThrow(
      'Integration setup "unknown" is not available',
    );
  });
});
