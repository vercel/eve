import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { DetectedPackageManager } from "../package-manager.js";
import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupMode, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runInteractive } from "../runner.js";
import { oneShotNextSteps } from "./one-shot-next-steps.js";

const silentSink: OutputSink = { write: () => {} };

function notingPrompter(): { prompter: Prompter; note: ReturnType<typeof vi.fn> } {
  const base = createFakePrompter().prompter;
  const note = vi.fn();
  return { prompter: { ...base, note }, note };
}

function scaffoldedState(options: { mode: SetupMode; inPlace: boolean }): SetupState {
  return {
    ...createDefaultSetupState(),
    setupMode: options.mode,
    projectPath: { kind: "resolved", inPlace: options.inPlace, path: "/tmp/parent/kall" },
  };
}

describe("oneShotNextSteps box", () => {
  it("lists the steps in order: cd, pnpm install, vercel link, eve dev", async () => {
    const { prompter, note } = notingPrompter();
    const box = oneShotNextSteps({ prompter });

    await runInteractive([box], scaffoldedState({ mode: "one-shot", inPlace: false }), silentSink);

    expect(note).toHaveBeenCalledOnce();
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Next steps");
    // The text survives any color wrapping, so order is asserted on indexOf.
    const order = ["cd ", "pnpm install", "vercel link", "eve dev"].map((text) =>
      message.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The credential alternative rides the vercel link step, before eve dev.
    expect(message).toContain("or set AI_GATEWAY_API_KEY in .env.local manually");
  });

  it("omits the cd step for an in-place scaffold", async () => {
    const { prompter, note } = notingPrompter();
    const box = oneShotNextSteps({ prompter });

    await runInteractive([box], scaffoldedState({ mode: "one-shot", inPlace: true }), silentSink);

    const [message] = note.mock.calls[0] as [string];
    expect(message).not.toContain("cd ");
    expect(message).toContain("pnpm install");
  });

  it("prints the install command for the scaffold's package manager", async () => {
    const { prompter, note } = notingPrompter();
    const box = oneShotNextSteps({
      prompter,
      detectPackageManager: vi.fn(
        async (): Promise<DetectedPackageManager> => ({
          kind: "bun",
          source: "package-manager-field",
        }),
      ),
    });

    await runInteractive([box], scaffoldedState({ mode: "one-shot", inPlace: true }), silentSink);

    const [message] = note.mock.calls[0] as [string];
    expect(message).toContain("bun install");
    expect(message).not.toContain("pnpm install");
  });

  it("self-skips on a complete run", () => {
    const { prompter } = notingPrompter();
    const box = oneShotNextSteps({ prompter });

    expect(box.shouldRun?.(scaffoldedState({ mode: "complete", inPlace: false }))).toBe(false);
  });
});
