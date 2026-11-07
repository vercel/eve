import { describe, expect, it } from "vitest";

import { runTerminal } from "#embed/terminal.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { defineAgent } from "#public/definitions/agent.js";

// What `runTerminal` refuses before it opens the terminal UI: a `resume` it can't continue.

const chat = defineAgent({ model: "openai/gpt-5", name: "chat" });
const SESSION = "session_01M6KYGW9S6MJ5YJABGQ85D4BG";

describe("runTerminal's resume", () => {
  it("needs the World it continues the session from", async () => {
    await expect(runTerminal(chat, { name: "chat", resume: SESSION })).rejects.toThrow(
      "runTerminal's `resume` continues a session from its `world`; pass both.",
    );
  });

  it("names a session the World doesn't have", async () => {
    await expect(
      runTerminal(chat, { name: "chat", resume: SESSION, world: memoryWorld() }),
    ).rejects.toThrow(`No saved session "${SESSION}" in the world.`);
  });
});
