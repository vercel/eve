import { describe, expect, it } from "vitest";

import type { CallRecord } from "#definitions/definition.js";
import { announce } from "#definitions/messages.js";
import type { Announcement } from "#harness/announcements.js";
import {
  anchorToTurn,
  createFrameworkUserMessage,
  createUserMessage,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";
import { projectPrompt, type Prompt } from "./prompt.js";

function input(content: string, turnId: string): UserModelMessage {
  return anchorToTurn(createUserMessage("user", content), turnId);
}

function said(content: string): HarnessModelMessage {
  return { content, role: "assistant" };
}

const texts = (messages: readonly HarnessModelMessage[]) => messages.map(({ content }) => content);

const announcements: Record<string, Announcement> = {
  policy: { kind: "context.instruction", render: () => "Answer in one sentence.", value: "v1" },
};

/**
 * One model call, in `ModelCaller.buildRequest`'s order: announcements join the record, then the
 * model reads its projection.
 */
function call(
  draft: CallRecord,
  turn: readonly UserModelMessage[],
  clientContext: Prompt["clientContext"],
) {
  const record = announce(draft, new Set(turn), announcements);
  return { record, view: projectPrompt({ clientContext, messages: [...record.record] }) };
}

describe("client context", () => {
  it("sits after the turn's announcements, so later steps and turns keep the prompt cached", () => {
    const earlier = [input("Earlier.", "turn_0"), said("Sure.")];
    const hello = input("Hello.", "turn_1");
    const clientContext = {
      insertionIndex: earlier.length,
      messages: ["Client page: /settings"],
      turnId: "turn_1",
    };
    const first = call({ historyState: {}, record: [...earlier, hello] }, [hello], clientContext);
    const toolCall: HarnessModelMessage = {
      content: [{ input: {}, toolCallId: "call_1", toolName: "lookup", type: "tool-call" }],
      role: "assistant",
    };
    const toolResult: HarnessModelMessage = {
      content: [
        {
          output: { type: "text", value: "found" },
          toolCallId: "call_1",
          toolName: "lookup",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const second = call(
      { ...first.record, record: [...first.record.record, toolCall, toolResult] },
      [],
      clientContext,
    );
    const thanks = input("Thanks.", "turn_2");
    const next = call(
      { ...second.record, record: [...second.record.record, said("Done."), thanks] },
      [thanks],
      undefined,
    );

    expect(texts(first.view)).toEqual([
      "Earlier.",
      "Sure.",
      "Answer in one sentence.",
      "Client page: /settings",
      "Hello.",
    ]);
    expect(second.view.slice(0, first.view.length)).toEqual(first.view);
    // The next turn reads no client context, so its prompt shares the first one's through the
    // instruction.
    expect(next.view.slice(0, 3)).toEqual(first.view.slice(0, 3));
  });

  it("stays ahead of a compaction checkpoint", () => {
    const compacted: HarnessModelMessage[] = [
      createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
      said("Alice asked about settings."),
      createFrameworkUserMessage("execution.continuation", "Continue."),
    ];

    const view = projectPrompt({
      clientContext: { insertionIndex: 0, messages: ["Client page: /settings"], turnId: "turn_1" },
      messages: compacted,
    });

    expect(texts(view)).toEqual([
      "Client page: /settings",
      "Summary of our conversation so far:",
      "Alice asked about settings.",
      "Continue.",
    ]);
  });
});
