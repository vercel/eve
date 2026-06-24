import { describe, expect, it } from "vitest";

import {
  formatPromptCommandHelp,
  isPromptControlCommand,
  parsePromptCommand,
  promptCommandsFor,
  PROMPT_COMMANDS,
} from "./prompt-commands.js";

describe("parsePromptCommand", () => {
  it("parses /new", () => {
    expect(parsePromptCommand("/new")).toEqual({ type: "new" });
  });

  it("parses /exit and its /quit alias", () => {
    expect(parsePromptCommand("/exit")).toEqual({ type: "exit" });
    expect(parsePromptCommand("/quit")).toEqual({ type: "exit" });
  });

  it("parses bare /model with an empty argument", () => {
    expect(parsePromptCommand("/model")).toEqual({
      type: "extension",
      name: "model",
      argument: "",
    });
  });

  it("parses /model with a trimmed argument", () => {
    expect(parsePromptCommand("/model  anthropic/claude-opus-4.8 ")).toEqual({
      type: "extension",
      name: "model",
      argument: "anthropic/claude-opus-4.8",
    });
  });

  it("parses the setup commands", () => {
    expect(parsePromptCommand("/vc:install")).toEqual({
      type: "extension",
      name: "vc:install",
      argument: "",
    });
    expect(parsePromptCommand("/vc:login")).toEqual({
      type: "extension",
      name: "vc:login",
      argument: "",
    });
    expect(parsePromptCommand("/channels")).toEqual({
      type: "extension",
      name: "channels",
      argument: "",
    });
    expect(parsePromptCommand("/deploy")).toEqual({
      type: "extension",
      name: "deploy",
      argument: "",
    });
  });

  it("parses bare /loglevel and /loglevel with a mode argument", () => {
    expect(parsePromptCommand("/loglevel")).toEqual({ type: "loglevel", argument: "" });
    expect(parsePromptCommand("/loglevel none")).toEqual({ type: "loglevel", argument: "none" });
    expect(parsePromptCommand("/loglevel  stderr ")).toEqual({
      type: "loglevel",
      argument: "stderr",
    });
  });

  it("parses /help and rejects /help with an argument", () => {
    expect(parsePromptCommand("/help")).toEqual({ type: "help" });
    expect(parsePromptCommand("/help model")).toBeNull();
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parsePromptCommand("  /new  ")).toEqual({ type: "new" });
  });

  it("rejects near-misses and ordinary prompts", () => {
    expect(parsePromptCommand("/models")).toBeNull();
    expect(parsePromptCommand("/vercel")).toBeNull();
    expect(parsePromptCommand("/vc")).toBeNull();
    expect(parsePromptCommand("/login")).toBeNull();
    expect(parsePromptCommand("/vc:auth")).toBeNull();
    expect(parsePromptCommand("/channels extra")).toBeNull();
    expect(parsePromptCommand("tell me about /channels")).toBeNull();
    expect(parsePromptCommand("/")).toBeNull();
    expect(parsePromptCommand("")).toBeNull();
    expect(parsePromptCommand("hello")).toBeNull();
  });
});

describe("promptCommandsFor", () => {
  it("exposes project commands only for local sessions", () => {
    const names = promptCommandsFor("local").map((command) => command.name);
    expect(names).toContain("model");
    expect(names).toContain("channels");
    expect(names).toContain("deploy");
    expect(names).toContain("vc:install");
    expect(names).toContain("vc:login");
    expect(names).not.toContain("vc:auth");
  });

  it("exposes the Vercel CLI commands for remote sessions", () => {
    const names = promptCommandsFor("remote").map((command) => command.name);
    expect(names).toContain("vc:install");
    expect(names).toContain("vc:login");
    expect(names).not.toContain("vc:auth");
    expect(names).not.toContain("model");
    expect(names).not.toContain("channels");
    expect(names).not.toContain("deploy");
  });

  it("filters discovery and rejects the obsolete remote auth command", () => {
    const remote = promptCommandsFor("remote");
    expect(parsePromptCommand("/vc:auth")).toBeNull();
    expect(parsePromptCommand("/model")).toEqual({
      type: "extension",
      name: "model",
      argument: "",
    });
    expect(formatPromptCommandHelp(remote)).toContain("/vc:login");
    expect(formatPromptCommandHelp(remote)).not.toContain("/vc:auth");
    expect(formatPromptCommandHelp(remote)).not.toContain("/model");
  });
});

describe("isPromptControlCommand", () => {
  it("is true exactly for recognized commands", () => {
    expect(isPromptControlCommand("/new")).toBe(true);
    expect(isPromptControlCommand("/model gpt-5")).toBe(true);
    expect(isPromptControlCommand("/unknown")).toBe(false);
    expect(isPromptControlCommand("hello")).toBe(false);
  });
});

describe("PROMPT_COMMANDS registry", () => {
  it("keeps names and aliases unique", () => {
    const tokens = PROMPT_COMMANDS.flatMap((spec) => [spec.name, ...spec.aliases]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("describes every command", () => {
    for (const spec of PROMPT_COMMANDS) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("pairs an argument hint with takesArgument", () => {
    for (const spec of PROMPT_COMMANDS) {
      expect(spec.argumentHint !== undefined).toBe(spec.takesArgument);
    }
  });

  it("builds a command every spec's own tokens parse to", () => {
    for (const spec of PROMPT_COMMANDS) {
      for (const alias of [spec.name, ...spec.aliases]) {
        expect(parsePromptCommand(`/${alias}`)).toEqual(spec.build(""));
      }
    }
  });

  it("leads with /help so a bare slash defaults to the safest command", () => {
    expect(PROMPT_COMMANDS[0]?.name).toBe("help");
  });
});

describe("formatPromptCommandHelp", () => {
  it("lists every command with its hint and aliases", () => {
    const help = formatPromptCommandHelp();
    for (const spec of PROMPT_COMMANDS) {
      expect(help).toContain(`/${spec.name}`);
      expect(help).toContain(spec.description);
      if (spec.argumentHint !== undefined) expect(help).toContain(spec.argumentHint);
      for (const alias of spec.aliases) expect(help).toContain(`(/${alias})`);
    }
    expect(help.split("\n")).toHaveLength(PROMPT_COMMANDS.length);
  });
});
