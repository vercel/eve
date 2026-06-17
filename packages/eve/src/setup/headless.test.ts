import { describe, expect, test } from "vitest";

import { createHeadlessPrompter, formatHeadlessEvent, HeadlessPromptError } from "./headless.js";

describe("createHeadlessPrompter", () => {
  test("rejects every interactive prompt with HeadlessPromptError", async () => {
    const prompter = createHeadlessPrompter(() => {});
    await expect(prompter.text({ message: "Name?" })).rejects.toBeInstanceOf(HeadlessPromptError);
    await expect(prompter.password({ message: "Key?" })).rejects.toBeInstanceOf(
      HeadlessPromptError,
    );
    await expect(prompter.select({ message: "Pick", options: [] })).rejects.toBeInstanceOf(
      HeadlessPromptError,
    );
    await expect(
      prompter.select({ message: "Model", search: true, options: [] }),
    ).rejects.toBeInstanceOf(HeadlessPromptError);
    await expect(
      prompter.select({ message: "Channels", multiple: true, options: [] }),
    ).rejects.toBeInstanceOf(HeadlessPromptError);
  });

  test("carries the prompt message for diagnostics", async () => {
    const prompter = createHeadlessPrompter(() => {});
    await expect(
      prompter.select({ message: "Connect to Vercel AI Gateway", options: [] }),
    ).rejects.toMatchObject({ promptMessage: "Connect to Vercel AI Gateway" });
  });

  test("routes log output to the sink", () => {
    const lines: string[] = [];
    const prompter = createHeadlessPrompter((text) => lines.push(text));
    prompter.intro("Create a new eve agent", "subtitle");
    prompter.log.success("scaffolded");
    prompter.log.error("boom");
    prompter.outro("done");
    expect(lines).toEqual(["Create a new eve agent: subtitle", "scaffolded", "boom", "done"]);
  });
});

describe("formatHeadlessEvent", () => {
  test("serializes a done event as one NDJSON line", () => {
    const line = formatHeadlessEvent({
      type: "done",
      projectPath: "/tmp/a",
      channels: ["web"],
      model: "m",
    });
    expect(line).toBe('{"type":"done","projectPath":"/tmp/a","channels":["web"],"model":"m"}');
    expect(line).not.toContain("\n");
  });
});
