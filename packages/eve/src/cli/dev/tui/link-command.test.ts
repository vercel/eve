import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { HumanActionRequiredError } from "#setup/human-action.js";

import { runTuiLinkCommand, type TuiLinkCommandDependencies } from "./link-command.js";

const INPUT = {
  appRoot: "/project",
  prompter: createFakePrompter({ single: () => "repair" }).prompter,
  signal: new AbortController().signal,
};

function dependencies(
  overrides: Partial<TuiLinkCommandDependencies> = {},
): TuiLinkCommandDependencies {
  return {
    runInstallVercelCliFlow: vi.fn<TuiLinkCommandDependencies["runInstallVercelCliFlow"]>(
      async () => ({ kind: "already" }),
    ),
    runLinkFlow: vi.fn<TuiLinkCommandDependencies["runLinkFlow"]>(async () => ({ kind: "done" })),
    runLoginFlow: vi.fn<TuiLinkCommandDependencies["runLoginFlow"]>(async () => ({
      kind: "logged-in",
    })),
    ...overrides,
  };
}

describe("runTuiLinkCommand", () => {
  it("logs in and resumes linking without leaving the TUI", async () => {
    const runLinkFlow = vi
      .fn<TuiLinkCommandDependencies["runLinkFlow"]>()
      .mockRejectedValueOnce(
        new HumanActionRequiredError({
          kind: "vercel-login",
          command: "vercel login",
          reason: "Log in to continue.",
        }),
      )
      .mockResolvedValueOnce({ kind: "done" });
    const deps = dependencies({ runLinkFlow });

    await expect(runTuiLinkCommand(INPUT, deps)).resolves.toMatchObject({
      effect: { kind: "model-access-changed" },
    });
    expect(deps.runLoginFlow).toHaveBeenCalledOnce();
    expect(runLinkFlow).toHaveBeenCalledTimes(2);
    expect(runLinkFlow.mock.calls[1]?.[0]).toMatchObject({ authAlreadyConfirmed: true });
  });
});
