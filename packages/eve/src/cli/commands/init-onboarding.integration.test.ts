import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockScreen, MockUserInput } from "#cli/dev/tui/test/mock-terminal.js";
import { LiveRegion } from "#cli/ui/live-region.js";
import type * as Startup from "#cli/dev/tui/startup.js";
import type * as StartupOnboarding from "#cli/dev/tui/startup-onboarding.js";

let screen: MockScreen;
let input: MockUserInput;

// The real startup screen, drawn on a mock terminal.
vi.mock("#cli/dev/tui/startup.js", async (importOriginal) => {
  const original = await importOriginal<typeof Startup>();
  return {
    ...original,
    startDevelopmentTuiStartup: (
      options: Parameters<typeof original.startDevelopmentTuiStartup>[0],
    ) => {
      // The startup screen forwards its options to the renderer, which accepts a terminal.
      const terminal: object = {
        input,
        output: screen,
        captureForeignOutput: false,
        unicode: true,
      };
      return original.startDevelopmentTuiStartup({ ...options, ...terminal });
    },
  };
});

// Onboarding asks one question on the startup screen's setup flow, like the provider picker.
vi.mock("#cli/dev/tui/startup-onboarding.js", () => ({
  runStartupOnboarding: async (
    options: Parameters<typeof StartupOnboarding.runStartupOnboarding>[0],
  ): ReturnType<typeof StartupOnboarding.runStartupOnboarding> => {
    options.onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
    const flow = options.startup.renderer.setupFlow;
    flow.begin("");
    try {
      const answer = await flow
        .readSelect({
          kind: "single",
          message: "Connect a model",
          options: [{ label: "Alice's gateway", value: "gateway" }],
        })
        .catch(() => undefined);
      return { outcome: answer === undefined ? { cancelled: true } : { message: "" } };
    } finally {
      flow.end({ preserveDiagnostics: false });
    }
  },
}));

const { startInitOnboarding } = await import("./init-onboarding.js");

function telemetry() {
  return { trackSetupStep: vi.fn(), trackSetupTerminal: vi.fn() };
}

beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("TERM", "xterm-256color");
  screen = new MockScreen({ columns: 100, rows: 30 });
  input = new MockUserInput();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startInitOnboarding", () => {
  it("closes an open question without interrupting init", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-init-onboarding-close-"));
    const events = telemetry();
    const onboarding = await startInitOnboarding({ projectPath, telemetry: events });
    await screen.waitForText("Connect a model");

    await expect(onboarding.close()).resolves.toEqual({});

    // `close()` cancels with a synthetic Ctrl-C; only a person's Ctrl-C stops the install.
    expect(onboarding.interrupted.aborted).toBe(false);
    await expect(onboarding.finished).resolves.toEqual({ cancelled: true });
    expect(events.trackSetupTerminal).toHaveBeenCalledExactlyOnceWith({
      flow: "onboarding",
      step: "model_provider",
      result: "cancelled",
    });
  });

  it("interrupts init when the person presses Ctrl-C on a question", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-init-onboarding-interrupt-"));
    const onboarding = await startInitOnboarding({ projectPath, telemetry: telemetry() });
    await screen.waitForText("Connect a model");

    input.ctrlC();

    await expect(onboarding.finished).resolves.toEqual({ cancelled: true });
    expect(onboarding.interrupted.aborted).toBe(true);
    await onboarding.close();
  });

  it("reports a finished connection and carries the queue and draft to eve dev", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-init-onboarding-finish-"));
    const events = telemetry();
    const onboarding = await startInitOnboarding({ projectPath, telemetry: events });
    await screen.waitForText("Connect a model");

    input.enter();
    await expect(onboarding.finished).resolves.toEqual({ cancelled: false });
    input.type("Help Alice");
    input.enter();
    input.type("and Bob");
    input.enter();
    input.type("plan their week");

    await expect(onboarding.close()).resolves.toEqual({
      queued: ["Help Alice", "and Bob"],
      draft: "plan their week",
    });
    expect(onboarding.interrupted.aborted).toBe(false);
    // eve dev paints its own screen in place, so nothing of this one stays behind.
    expect(screen.snapshot().trim()).toBe("");
    expect(events.trackSetupStep.mock.calls).toEqual([
      [{ flow: "onboarding", step: "model_provider" }],
      [{ flow: "onboarding", step: "connection_ready" }],
    ]);
    expect(events.trackSetupTerminal).toHaveBeenCalledExactlyOnceWith({
      flow: "onboarding",
      step: "model_provider",
      result: "completed",
    });
  });

  it("keeps its screen up under init's summary when it hands the terminal to eve dev", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-init-onboarding-handoff-"));
    const onboarding = await startInitOnboarding({ projectPath });
    await screen.waitForText("Connect a model");
    input.enter();
    await onboarding.finished;
    onboarding.setInstalling(false);
    input.type("Help Alice");

    await onboarding.close({ rows: ["✓ Created an eve agent in /tmp/alice", ""] });

    const frames = screen.frames();
    const firstPaint = frames.findIndex((frame) => frame.includes("☰eve"));
    // The screen opens on the install, which is what's running, not on an agent starting.
    expect(frames[firstPaint]).toContain("Installing dependencies…");
    for (const frame of frames.slice(firstPaint)) {
      // Never blanks, and never shows a prompt-less "Ready" as if the agent were up.
      expect(frame).toContain("☰eve");
      expect(frame).not.toMatch(/Ready|Reading saved connection/u);
    }
    const kept = screen.snapshot();
    expect(kept.indexOf("✓ Created an eve agent in /tmp/alice")).toBeLessThan(
      kept.indexOf("☰eve"),
    );
    expect(kept).toContain("Help Alice");
    expect(kept).toContain("Starting agent…");

    // eve dev's first paint lands on the kept screen's first row and replaces it in place.
    new LiveRegion({ write: (chunk) => screen.write(chunk) }).update(["eve dev"]);
    expect(screen.snapshot()).toBe(`${kept.slice(0, kept.indexOf("☰eve"))}eve dev`);
  });
});
