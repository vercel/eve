import { describe, expect, it } from "vitest";

import { createUserMessage, markSentByHooks, type HarnessModelMessage } from "#harness/messages.js";
import { durableMessagesRead, projectPrompt, type Prompt } from "./prompt.js";

// A measured prompt's message count is recorded only when it matches history, or compaction's
// next estimate would skip messages the model never read past.

const history: HarnessModelMessage[] = [
  createUserMessage("user", "Alice asks for the report."),
  { content: "Working on it.", role: "assistant" },
];
const hookMessage = markSentByHooks(createUserMessage("user", "Keep going."), ["until-done"]);
const clientContext = { insertionIndex: 1, messages: ["Alice is on mobile."], turnId: "turn-1" };

describe("durableMessagesRead", () => {
  it.each<[string, Prompt]>([
    ["history alone", { clientContext: undefined, messages: history }],
    ["a hook's message", { clientContext: undefined, messages: [...history, hookMessage] }],
    [
      "hooks' messages in a row",
      { clientContext: undefined, messages: [...history, hookMessage, hookMessage] },
    ],
  ])("counts history's messages without the hook notes, with %s", (_name, prompt) => {
    expect(durableMessagesRead(prompt, projectPrompt(prompt).length)).toBe(prompt.messages.length);
  });

  it("is unknown when client context was placed among history's messages", () => {
    const prompt: Prompt = { clientContext, messages: [...history, hookMessage] };
    expect(durableMessagesRead(prompt, projectPrompt(prompt).length)).toBeUndefined();
  });

  it("places a note ahead of a hook's message that history doesn't hold, naming no hook", () => {
    const prompt: Prompt = { clientContext: undefined, messages: [...history, hookMessage] };
    const projected = projectPrompt(prompt);
    expect(projected).toHaveLength(history.length + 2);
    expect(JSON.stringify(projected.at(-2))).toContain("sent automatically, not by a person");
    expect(JSON.stringify(projected.map(({ content }) => content))).not.toContain("until-done");
  });
});
