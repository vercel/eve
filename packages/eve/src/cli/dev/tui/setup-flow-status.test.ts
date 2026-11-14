import { expect, it, vi } from "vitest";

import { TerminalRenderer } from "./terminal-renderer.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

it("shows eve init's install beneath an open onboarding question until it finishes", async () => {
  const screen = new MockScreen({ columns: 80, rows: 24 });
  const input = new MockUserInput();
  const renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: false,
    unicode: true,
  });
  try {
    renderer.beginStartupDraft({ title: "eve" });
    renderer.setStartupPhase("installing");
    renderer.setupFlow.begin("");
    const choice = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Connect a model",
      options: [{ label: "Vercel Account", value: "vercel" }],
    });
    await screen.waitForText("Vercel Account");
    expect(screen.snapshot()).toContain("Installing dependencies…");

    renderer.setStartupPhase("starting");
    await vi.waitFor(() => expect(screen.snapshot()).not.toContain("Installing dependencies…"));
    expect(screen.snapshot()).toContain("Vercel Account");

    input.enter();
    await choice;
    renderer.setupFlow.end();
  } finally {
    renderer.shutdown();
  }
});
