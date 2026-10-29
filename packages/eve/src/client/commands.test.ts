import { describe, expect, it } from "vitest";

import { parseSlashCommand, type ChannelCommandInfo } from "#client/commands.js";

const commands: ChannelCommandInfo[] = [
  { name: "new", description: "Start over", aliases: ["reset"], session: "required" },
  {
    name: "standup",
    description: "Draft a standup",
    argumentHint: "[topic]",
    session: "optional",
  },
];

describe("parseSlashCommand", () => {
  it("matches a command by name or alias and trims its argument", () => {
    expect(parseSlashCommand("  /standup  the spike ", commands)).toEqual({
      command: commands[1],
      argument: "the spike",
    });
    expect(parseSlashCommand("/reset", commands)).toEqual({ command: commands[0], argument: "" });
  });

  it("leaves unknown commands and ordinary text as messages", () => {
    expect(parseSlashCommand("/unknown", commands)).toBeUndefined();
    // `new` has no argument hint, so trailing text keeps the message from ending the session.
    expect(parseSlashCommand("/new plan for today", commands)).toBeUndefined();
    expect(parseSlashCommand("/", commands)).toBeUndefined();
    expect(parseSlashCommand("tell me about /standup", commands)).toBeUndefined();
  });
});
