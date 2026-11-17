import { afterEach, beforeEach, expect, it } from "vitest";

import { TerminalRenderer } from "./terminal-renderer.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

let screen: MockScreen;
let input: MockUserInput;
let renderer: TerminalRenderer;

beforeEach(() => {
  screen = new MockScreen({ columns: 80, rows: 24 });
  input = new MockUserInput();
  renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: false,
    unicode: true,
  });
});

afterEach(() => {
  renderer.shutdown();
});

/** The runner's steps from a ready agent's startup screen to its chat composer, in one tick. */
function finishStartup(): void {
  renderer.finishStartupDraft();
  renderer.renderAgentHeader({
    name: "alice-agent",
    serverUrl: "http://eve-test.invalid",
    localDevelopment: true,
  });
  renderer.setStartupPhase(undefined);
}

it("goes from the startup screen to the chat composer without a prompt-less frame", async () => {
  renderer.beginStartupDraft({ title: "eve" });
  renderer.setStartupPhase("connecting");
  const startupFrames = screen.frames().length;

  finishStartup();
  // Shutdown interrupts the open composer.
  renderer.readInput({ title: "alice-agent" }).catch(() => undefined);

  const frames = screen.frames().slice(startupFrames);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toContain("alice-agent");
  expect(frames[0]).toMatch(/^❯/mu);
  expect(frames[0]).not.toContain("Ready");
  expect(frames[0]).not.toContain("Reading saved connection…");
});

it("paints what the runner left once the tick ends without opening the composer", async () => {
  renderer.beginStartupDraft({ title: "eve" });
  const startupFrames = screen.frames().length;

  finishStartup();
  expect(screen.frames()).toHaveLength(startupFrames);

  await Promise.resolve();
  expect(screen.frames()).toHaveLength(startupFrames + 1);
  expect(screen.snapshot()).toContain("alice-agent");
});
