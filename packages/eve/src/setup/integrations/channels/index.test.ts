import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { interactiveAsker } from "../../ask.js";
import type { AddChannelsDeps } from "./setup.js";
import { channelSetupEnvironment } from "./environment.js";
import { channelSetupIntegration, createChannelSetupUi } from "./index.js";
import { createDefaultSetupState } from "../../state.js";
import { WizardCancelledError } from "../../step.js";

function context(prompter = createFakePrompter().prompter) {
  return {
    environment: channelSetupEnvironment("logged-out", { kind: "unresolved" } as const),
    state: {
      ...createDefaultSetupState(),
      projectPath: { kind: "resolved", inPlace: true, path: "/tmp/project" } as const,
      channelSelection: ["slack" as const],
    },
    ui: createChannelSetupUi({ asker: interactiveAsker(prompter), prompter }),
  };
}

describe("channel setup integrations", () => {
  it("keeps picker cancellation as a structured result", async () => {
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });

    const result = await channelSetupIntegration("slack").setup(context(fake.prompter));

    expect(result).toMatchObject({ kind: "cancelled" });
  });

  it("keeps Web setup independent of Slack credential prompts", async () => {
    const fake = createFakePrompter();
    const ensureChannel = vi.fn<AddChannelsDeps["ensureChannel"]>(async () => ({
      kind: "web",
      action: "skipped",
      skipReason: "nextjs-project",
      filesWritten: [],
      filesSkipped: ["/tmp/project/package.json"],
      packageJsonUpdated: [],
    }));

    const result = await channelSetupIntegration("web").setup({
      ...context(fake.prompter),
      state: {
        ...context(fake.prompter).state,
        channelSelection: ["web"],
      },
      deps: {
        ensureChannel,
        deriveSlackConnectorSlug: vi.fn(),
        provisionSlackbot: vi.fn(),
        reconcileSlackUid: vi.fn(),
        detectPackageManager: vi.fn<AddChannelsDeps["detectPackageManager"]>(async () => ({
          kind: "pnpm",
          source: "default",
        })),
        runPackageManagerInstall: vi.fn(),
        runVercel: vi.fn(),
        detectDeployment: vi.fn(),
      },
    });

    expect(result.kind).toBe("done");
    expect(ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", configureVercelServices: false }),
    );
    expect(fake.selectMessages).toEqual([]);
  });
});
