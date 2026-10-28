import { describe, expect, it } from "vitest";

import { createUserMessage, markSentByHooks, type HarnessModelMessage } from "#harness/messages.js";
import { projectPrompt, readsOnlyHistory, type Prompt } from "./prompt.js";

// A measured prompt's message count is recorded only when it matches history, or compaction's
// next estimate would skip messages the model never read past.

const history: HarnessModelMessage[] = [
  createUserMessage("user", "Alice asks for the report."),
  { content: "Working on it.", role: "assistant" },
];
const hookMessage = markSentByHooks(createUserMessage("user", "Keep going."), ["until-done"]);
const clientContext = { insertionIndex: 1, messages: ["Alice is on mobile."], turnId: "turn-1" };

describe("readsOnlyHistory", () => {
  it.each<[string, Prompt]>([
    ["history alone", { clientContext: undefined, messages: history }],
    ["client context", { clientContext, messages: history }],
    ["a hook's message", { clientContext: undefined, messages: [...history, hookMessage] }],
    ["both", { clientContext, messages: [...history, hookMessage] }],
  ])("holds exactly when the model reads history's messages, with %s", (_name, prompt) => {
    const matches = projectPrompt(prompt).length === prompt.messages.length;
    expect(readsOnlyHistory(prompt)).toBe(matches);
  });

  it("places a note ahead of a hook's message that history doesn't hold", () => {
    const prompt: Prompt = { clientContext: undefined, messages: [...history, hookMessage] };
    const projected = projectPrompt(prompt);
    expect(projected).toHaveLength(history.length + 2);
    expect(JSON.stringify(projected.at(-2))).toContain('from the \\"until-done\\" hook');
    expect(readsOnlyHistory(prompt)).toBe(false);
  });
});
