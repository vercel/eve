import type { EveMessage } from "eve/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessage } from ".";

describe("agent messages", () => {
  it("renders ordinary assistant text without a delivery tool result", () => {
    const message = {
      id: "assistant-message",
      metadata: { status: "complete" },
      parts: [
        {
          state: "done",
          text: "Hello from ordinary assistant output.",
          type: "text",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onAnswers={() => undefined}
      />
    );

    expect(markup).toContain("Hello from ordinary assistant output.");
  });

  it("renders only Linq-delivered content in the iMessage view", () => {
    const message = {
      id: "turn-1:assistant",
      metadata: { status: "complete", turnId: "turn-1" },
      parts: [
        {
          state: "done",
          stepIndex: 1,
          text: "I’ll check that now.",
          type: "text",
        },
        {
          state: "done",
          stepIndex: 0,
          text: "Private reasoning",
          type: "reasoning",
        },
        {
          callId: "call-1",
          input: { query: "example" },
          kind: "tool",
          label: "Web search",
          name: "web_search",
          output: { result: "internal" },
          state: "completed",
          stepIndex: 0,
          type: "tool",
        },
        {
          state: "done",
          stepIndex: 1,
          text: "Here’s what I found.",
          type: "text",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onAnswers={() => undefined}
        sentMessageParts={[
          {
            state: "done",
            stepIndex: 1,
            text: "Here’s what I found.",
            type: "text",
          },
        ]}
        userVisibleOnly
      />
    );

    expect(markup).toContain("Here’s what I found.");
    expect(markup).not.toContain("I’ll check that now.");
    expect(markup).not.toContain("Private reasoning");
    expect(markup).not.toContain("web_search");
  });

  it("shows approval controls without exposing tool internals in the iMessage projection", () => {
    const message = {
      id: "turn-2:assistant",
      metadata: { status: "streaming", turnId: "turn-2" },
      parts: [
        {
          callId: "call-2",
          input: { amount: 50, recipient: "Hidden recipient" },
          interaction: {
            call: {
              callId: "call-2",
              input: { amount: 50, recipient: "Hidden recipient" },
              name: "send_payment",
            },
            interactionId: "approval-1",
            request: {
              kind: "approval",
              options: [
                { id: "approve", label: "Approve", style: "primary" },
                { id: "deny", label: "Deny", style: "danger" },
              ],
              prompt: "Approve this action?",
            },
            status: "open",
            stepIndex: 0,
            turnId: "turn-2",
          },
          kind: "tool",
          label: "Send payment",
          name: "send_payment",
          state: "approval",
          stepIndex: 0,
          type: "tool",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onAnswers={() => undefined}
        userVisibleOnly
      />
    );

    expect(markup).toContain("Approve this action?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain("send_payment");
    expect(markup).not.toContain("Hidden recipient");
  });
});
