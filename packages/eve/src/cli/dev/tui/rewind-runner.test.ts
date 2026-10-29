import { afterEach, expect, it, vi } from "vitest";
import { Client } from "#client/index.js";
import { EveTUIRunner } from "./runner.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { FakeEveServer, reply } from "./test/fake-eve-server.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("selects a message, repaints the screen, and restores it to the composer", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  const server = new FakeEveServer((request) =>
    reply(`Reply to ${String(request.body?.message)}`)(request).map((event) =>
      event.type === "turn.started" && request.turnId === "turn_2"
        ? { ...event, data: { ...event.data, follows: "turn_1" } }
        : event,
    ),
  );
  vi.stubGlobal("fetch", server.fetch);
  const input = new MockUserInput();
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const renderer = new TerminalRenderer({ input, output: screen, color: false, unicode: true });
  const running = new EveTUIRunner({
    client: new Client({ baseUrl: "http://localhost:3000" }),
    renderer,
  }).run();
  try {
    await screen.waitForIdlePrompt();
    input.type("First message");
    input.enter();
    await screen.waitForText("Reply to First message");
    await screen.waitForIdlePrompt();
    input.type("Second message");
    input.enter();
    await screen.waitForText("Reply to Second message");
    await screen.waitForIdlePrompt();
    input.type("/rewind");
    input.enter();
    await screen.waitForText("Choose a message to edit");
    expect(screen.snapshot()).toContain("1. Second message");
    expect(screen.snapshot()).toContain("2. First message");
    input.enter();
    await screen.waitForText("Rewound. Edit the message to continue.");
    await screen.waitForText("Second message");
    expect(server.requestsTo("POST", "/session_1/rewind")).toMatchObject([
      { body: { turnId: "turn_1" } },
    ]);
    expect(screen.snapshot()).toContain("First message");
    expect(screen.snapshot()).toContain("Reply to First message");
    expect(screen.snapshot()).not.toContain("Reply to Second message");
    expect(screen.snapshot()).toContain("Second message"); // The editable draft, not its old turn.
    expect(screen.rawOutput()).toContain("\x1b[3J");
    input.ctrlC();
  } finally {
    renderer.shutdown();
    server.close();
  }
  await running;
}, 10_000);
