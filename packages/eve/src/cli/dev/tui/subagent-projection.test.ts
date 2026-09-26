import { describe, expect, it, vi } from "vitest";
import type { ChildCall, ConversationState } from "#client/conversation-state.js";
import { initialConversationState } from "#client/conversation-reducer.js";
import { TerminalSubagentProjection, type SubagentView } from "./subagent-projection.js";

function view(): SubagentView {
  return {
    begin: vi.fn(),
    background: vi.fn(),
    upsertStep: vi.fn(),
    upsertTool: vi.fn(),
    removeTool: vi.fn(),
    complete: vi.fn(),
    markChildToolCallId: vi.fn(),
  };
}

function child(overrides: Partial<ChildCall> = {}): ChildCall {
  return {
    callId: "delegate",
    name: "researcher",
    childSessionId: "child",
    originTurnId: "parent",
    background: false,
    parentStatus: "dispatched",
    observation: { status: "not-followed" },
    ...overrides,
  };
}
function withChild(value: ChildCall): ConversationState {
  return { ...initialConversationState(), children: { [value.callId]: value } };
}
function content(text: string, status: "streaming" | "done" = "streaming") {
  return {
    ...initialConversationState(),
    messages: [
      {
        id: "msg",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text, state: status }],
      },
    ],
  };
}

describe("terminal child adapter", () => {
  it("renders parent-only dispatch and only changed child content", () => {
    const renderer = view();
    const adapter = new TerminalSubagentProjection(renderer);
    adapter.update(withChild(child()), "delegate");
    adapter.update(
      withChild(child({ observation: { status: "following", conversation: content("Hello") } })),
      "delegate",
    );
    adapter.update(
      withChild(child({ observation: { status: "following", conversation: content("Hello") } })),
      "delegate",
    );
    expect(renderer.begin).toHaveBeenCalledOnce();
    expect(renderer.upsertStep).toHaveBeenCalledOnce();
    adapter.update(
      withChild(
        child({
          parentStatus: "reported-complete",
          observation: { status: "following", conversation: content("Hello", "done") },
        }),
      ),
      "delegate",
    );
    expect(renderer.complete).toHaveBeenCalledWith({ callId: "delegate", authoritative: false });
    adapter.update(
      withChild(
        child({
          parentStatus: "reported-complete",
          observation: {
            status: "ended",
            outcome: "completed",
            conversation: content("Hello", "done"),
          },
        }),
      ),
      "delegate",
    );
    expect(renderer.complete).toHaveBeenCalledWith({ callId: "delegate", authoritative: true });
  });

  it("keeps reasoning attached to the same section as its subsequent text", () => {
    const renderer = view();
    const adapter = new TerminalSubagentProjection(renderer);
    const partial: ConversationState = {
      ...initialConversationState(),
      messages: [
        {
          id: "msg",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Thinking", state: "streaming" }],
        },
      ],
    };
    adapter.update(
      withChild(child({ observation: { status: "following", conversation: partial } })),
      "delegate",
    );
    const answered: ConversationState = {
      ...partial,
      messages: [
        {
          id: "msg",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "Thinking", state: "done" },
            { type: "text", text: "Answer", state: "done" },
          ],
        },
      ],
    };
    adapter.update(
      withChild(child({ observation: { status: "following", conversation: answered } })),
      "delegate",
    );
    expect(renderer.upsertStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sectionKey: 0,
        reasoning: "Thinking",
        message: "Answer",
        finalized: true,
      }),
    );
  });

  it("preserves partial child detail if the observation stream fails", () => {
    const renderer = view();
    const adapter = new TerminalSubagentProjection(renderer);
    adapter.update(
      withChild(child({ observation: { status: "following", conversation: content("Partial") } })),
      "delegate",
    );
    adapter.update(
      withChild(
        child({
          observation: {
            status: "unavailable",
            reason: "stream-error",
            conversation: content("Partial"),
          },
        }),
      ),
      "delegate",
    );
    expect(renderer.removeTool).not.toHaveBeenCalled();
    expect(renderer.complete).not.toHaveBeenCalled();
  });

  it("renders tool state from child message parts instead of a second tool ledger", () => {
    const renderer = view();
    const adapter = new TerminalSubagentProjection(renderer);
    const conversation: ConversationState = {
      ...initialConversationState(),
      messages: [
        {
          id: "msg",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "search",
              toolName: "search",
              toolMetadata: { eve: { kind: "tool-call", name: "search" } },
              input: {},
              state: "input-available",
            },
          ],
        },
      ],
    };
    adapter.update(
      withChild(child({ observation: { status: "following", conversation } })),
      "delegate",
    );
    expect(renderer.upsertTool).toHaveBeenCalledWith(
      expect.objectContaining({ childCallId: "search", status: "executing" }),
    );
    expect(renderer.markChildToolCallId).toHaveBeenCalledWith("search");
  });

  it("does not render skill loads or nested delegations as child tool rows", () => {
    const renderer = view();
    const adapter = new TerminalSubagentProjection(renderer);
    const conversation: ConversationState = {
      ...initialConversationState(),
      messages: [
        {
          id: "msg",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "skill",
              toolName: "load_skill",
              input: {},
              state: "input-available",
              toolMetadata: { eve: { kind: "load-skill", name: "skill" } },
            },
            {
              type: "dynamic-tool",
              toolCallId: "nested",
              toolName: "researcher",
              input: {},
              state: "input-available",
              toolMetadata: { eve: { kind: "subagent-call", name: "researcher" } },
            },
          ],
        },
      ],
    };
    adapter.update(
      withChild(child({ observation: { status: "following", conversation } })),
      "delegate",
    );
    expect(renderer.upsertTool).not.toHaveBeenCalled();
    expect(renderer.markChildToolCallId).not.toHaveBeenCalledWith("skill");
    expect(renderer.markChildToolCallId).not.toHaveBeenCalledWith("nested");
  });
});
