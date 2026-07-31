import { describe, expect, it } from "vitest";

import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";

import { createTheme } from "../theme.js";
import { buildConversationItems, renderConversationItem } from "./trace-conversation.js";

const THEME = createTheme({ color: false, unicode: true });
const BASE = 1_700_000_000_000_000_000n;

function span(
  spanId: string,
  name: string,
  startMs: number,
  endMs: number,
  parentSpanId?: string,
  attributes: Readonly<Record<string, unknown>> = {},
  statusCode = 0,
): LocalTraceSpan {
  return {
    attributes,
    endTimeNs: BASE + BigInt(endMs) * 1_000_000n,
    name,
    parentSpanId,
    spanId,
    startTimeNs: BASE + BigInt(startMs) * 1_000_000n,
    statusCode,
    traceId: "t".repeat(32),
  };
}

function trace(spans: readonly LocalTraceSpan[]): LocalTrace {
  return {
    endTimeNs: spans.reduce((m, s) => (s.endTimeNs > m ? s.endTimeNs : m), 0n),
    sessionIds: [],
    spans,
    startTimeNs: spans.reduce((m, s) => (s.startTimeNs < m ? s.startTimeNs : m), BASE),
    traceId: "t".repeat(32),
  };
}

function weatherTurn(): LocalTraceSpan[] {
  const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, { "agent.turn.id": "turn_0" });
  const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {});
  const messages = JSON.stringify([
    { role: "user", content: "weather in nyc?" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "weather in sf?" },
  ]);
  const model = span("c".repeat(16), "ai.streamText.doStream", 20, 2000, step.spanId, {
    "gen_ai.request.model": "claude-test",
    "ai.prompt.messages": messages,
    "ai.response.text": "Let me check.",
    "agent.usage.input_tokens": 6200,
    "agent.usage.output_tokens": 50,
  });
  const action = span("d".repeat(16), "agent.action", 2100, 2400, step.spanId, {});
  const toolCall = span("e".repeat(16), "ai.toolCall", 2100, 2400, action.spanId, {
    "gen_ai.tool.name": "get_weather",
    "gen_ai.tool.call.arguments": '{"city":"sf"}',
    "gen_ai.tool.call.result": '{"temperatureF":72}',
  });
  return [turn, step, model, action, toolCall];
}

describe("buildConversationItems", () => {
  it("extracts the user message from the turn's first model prompt", () => {
    const items = buildConversationItems(trace(weatherTurn()));
    expect(items[0]?.kind).toBe("user");
    expect(items[0]?.text).toBe("weather in sf?");
    expect(items[0]?.span.name).toBe("agent.turn");
  });

  it("builds assistant and tool items in time order", () => {
    const items = buildConversationItems(trace(weatherTurn()));
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
    expect(items[1]?.text).toBe("Let me check.");
    expect(items[1]?.model).toBe("claude-test");
    expect(items[1]?.inputTokens).toBe(6200);
    expect(items[2]?.name).toBe("get_weather");
    expect(items[2]?.args).toBe('{"city":"sf"}');
    expect(items[2]?.result).toBe('{"temperatureF":72}');
  });

  it("finds turns parented to a session window span", () => {
    // Post-windowing capture: turns are children of the `agent.session` root,
    // so turn discovery must go by name, not root position.
    const window = span("0".repeat(16), "agent.session", 0, 0, undefined, {
      "agent.session.window": 0,
    });
    const spans = weatherTurn().map((s) =>
      s.name === "agent.turn" ? { ...s, parentSpanId: window.spanId } : s,
    );
    const items = buildConversationItems(trace([window, ...spans]));
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
  });

  it("marks turns dispatched by another turn as subagent items", () => {
    const parent = weatherTurn();
    const childTurn = span("f".repeat(16), "agent.turn", 6000, 6000, undefined, {
      "agent.parent.call_id": "call-7",
      "agent.parent.session.id": "session-root",
      "agent.parent.turn.id": "turn_0",
      "agent.subagent.name": "echo-marker",
    });
    const childStep = span("1".repeat(16), "agent.step", 6010, 8000, childTurn.spanId, {});
    const childModel = span(
      "2".repeat(16),
      "ai.streamText.doStream",
      6020,
      7000,
      childStep.spanId,
      {
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "delegated task" }]),
        "ai.response.text": "delegated reply",
      },
    );
    const items = buildConversationItems(trace([...parent, childTurn, childStep, childModel]));
    const parentItems = items.filter((item) => item.subagent === undefined);
    const childItems = items.filter((item) => item.subagent !== undefined);
    expect(parentItems.length).toBeGreaterThan(0);
    expect(childItems.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(childItems[0]?.subagent).toEqual({
      name: "echo-marker",
      parentCallId: "call-7",
      parentTurnId: "turn_0",
    });
  });

  it("interleaves a subagent's cards between the parent's dispatch and reply", () => {
    // The parent parks while the child runs: step 1 dispatches, the child
    // works, step 2 replies with the result. Cards must read in that order,
    // not with the child appended after the parent's whole turn.
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step1 = span("b".repeat(16), "agent.step", 10, 20, turn.spanId, {});
    const dispatch = span("c".repeat(16), "ai.streamText.doStream", 12, 18, step1.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "run the subagent" }]),
      "ai.response.text": "Dispatching.",
    });
    const childTurn = span("f".repeat(16), "agent.turn", 30, 30, undefined, {
      "agent.parent.call_id": "call-1",
      "agent.parent.session.id": "session-root",
      "agent.parent.turn.id": "turn_0",
      "agent.subagent.name": "echo-marker",
    });
    const childStep = span("1".repeat(16), "agent.step", 32, 40, childTurn.spanId, {});
    const childModel = span("2".repeat(16), "ai.streamText.doStream", 34, 38, childStep.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "delegated task" }]),
      "ai.response.text": "delegated reply",
    });
    const step2 = span("3".repeat(16), "agent.step", 50, 60, turn.spanId, {});
    const reply = span("4".repeat(16), "ai.streamText.doStream", 52, 58, step2.spanId, {
      "ai.response.text": "The subagent said: delegated reply",
    });
    const items = buildConversationItems(
      trace([turn, step1, dispatch, childTurn, childStep, childModel, step2, reply]),
    );
    expect(items.map((item) => [item.kind, item.subagent !== undefined])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", true],
      ["assistant", true],
      ["assistant", false],
    ]);
  });

  it("skips model spans with no response text", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 2000, step.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    });
    const items = buildConversationItems(trace([turn, step, model]));
    expect(items.map((item) => item.kind)).toEqual(["user"]);
  });

  it("keeps model spans that failed with an error", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {});
    const model = span(
      "c".repeat(16),
      "ai.streamText.doStream",
      20,
      2000,
      step.spanId,
      { "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]) },
      2,
    );
    const items = buildConversationItems(trace([turn, step, model]));
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(items[1]?.error).toBe(true);
  });

  it("keeps model spans that carry only token usage", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 2000, step.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "agent.usage.input_tokens": 100,
      "agent.usage.output_tokens": 10,
    });
    const items = buildConversationItems(trace([turn, step, model]));
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(items[1]?.inputTokens).toBe(100);
  });

  it("flags error tool calls", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 100, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 50, step.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "agent.usage.input_tokens": 10,
    });
    const action = span("d".repeat(16), "agent.action", 60, 200, step.spanId, {});
    const toolCall = span(
      "e".repeat(16),
      "ai.toolCall",
      60,
      200,
      action.spanId,
      { "gen_ai.tool.name": "explode" },
      2,
    );
    const items = buildConversationItems(trace([turn, step, model, action, toolCall]));
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
    expect(items[2]?.error).toBe(true);
  });
});

describe("renderConversationItem", () => {
  it("renders the user message as a borderless card", () => {
    const user = buildConversationItems(trace(weatherTurn())).find((item) => item.kind === "user")!;
    const lines = renderConversationItem(user, 60, THEME, false, false).map(stripAnsi);
    // Padded header band, one body padding row, content, one padding row.
    expect(lines[0]).toMatch(/^ +$/);
    expect(lines[1]).toMatch(/^ {4}user + {4}$/);
    expect(lines[2]).toMatch(/^ +$/);
    expect(lines[3]).toMatch(/^ +$/);
    expect(lines[4]).toMatch(/^ {4}weather in sf\? + {4}$/);
    expect(lines[5]).toMatch(/^ +$/);
    expect(lines).toHaveLength(6);
  });

  it("renders the assistant title with model on the left and metrics right-aligned", () => {
    const assistant = buildConversationItems(trace(weatherTurn())).find(
      (item) => item.kind === "assistant",
    )!;
    const lines = renderConversationItem(assistant, 80, THEME, false, false).map(stripAnsi);
    expect(lines[1]).toContain("assistant");
    expect(lines[1]).toContain("claude-test");
    // Duration, tokens, and cost are right-aligned at the end of the row.
    expect(lines[1]!.trimEnd()).toMatch(/2s.*↑6\.2K.*↓50$/);
  });

  it("badges every card of a subagent turn with the dispatch lineage", () => {
    const assistant = buildConversationItems(trace(weatherTurn())).find(
      (item) => item.kind === "assistant",
    )!;
    const named = {
      ...assistant,
      subagent: { name: "echo-marker", parentCallId: "call-1", parentTurnId: "turn_0" },
    };
    const lines = renderConversationItem(named, 80, THEME, false, false).map(stripAnsi);
    expect(lines[1]).toContain("subagent:echo-marker");

    const anonymous = {
      ...assistant,
      subagent: { parentTurnId: "turn_0" },
    };
    const anonymousLines = renderConversationItem(anonymous, 80, THEME, false, false).map(
      stripAnsi,
    );
    expect(anonymousLines[1]).toContain("subagent");
    expect(anonymousLines[1]).not.toContain("subagent:");
  });

  it("labels a subagent turn's user card as its task", () => {
    const user = buildConversationItems(trace(weatherTurn())).find((item) => item.kind === "user")!;
    const delegated = {
      ...user,
      subagent: { name: "echo-marker", parentTurnId: "turn_0" },
    };
    const lines = renderConversationItem(delegated, 80, THEME, false, false).map(stripAnsi);
    expect(lines[1]).toContain("task");
    expect(lines[1]).toContain("subagent:echo-marker");
    expect(lines[1]).not.toMatch(/\buser\b/);
  });

  it("shows gateway cost right-aligned when the step span carries it", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {
      "gen_ai.usage.cost": 0.0031,
    });
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 2000, step.spanId, {
      "gen_ai.request.model": "claude-test",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "ai.response.text": "reply",
      "agent.usage.input_tokens": 100,
    });
    const assistant = buildConversationItems(trace([turn, step, model])).find(
      (item) => item.kind === "assistant",
    )!;
    expect(assistant.costUsd).toBe(0.0031);
    const lines = renderConversationItem(assistant, 80, THEME, false, false).map(stripAnsi);
    expect(lines[1]!.trimEnd()).toMatch(/\$0\.0031$/);
  });

  it("renders tool calls as their own cards with args and result", () => {
    const items = buildConversationItems(trace(weatherTurn()));
    const tool = items.find((item) => item.kind === "tool")!;
    const lines = renderConversationItem(tool, 60, THEME, false, false).map(stripAnsi);
    expect(lines[1]).toContain("get_weather");
    // Duration is right-aligned at the end of the header row.
    expect(lines[1]!.trimEnd()).toMatch(/300ms$/);
    expect(lines.some((line) => line.includes("Input:"))).toBe(true);
    expect(lines.some((line) => line.includes('"city": "sf"'))).toBe(true);
    expect(lines.some((line) => line.includes("Output:"))).toBe(true);
    expect(lines.some((line) => line.includes('"temperatureF": 72'))).toBe(true);
  });

  it("renders the system prompt as a card with estimated tokens and a preview", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 100, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 50, step.spanId, {
      "ai.prompt.system": "You are a test assistant. Be brief.",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    });
    const items = buildConversationItems(trace([turn, step, model]));
    expect(items[0]?.kind).toBe("system");

    const collapsed = renderConversationItem(items[0]!, 60, THEME, false, false).map(stripAnsi);
    expect(collapsed).toHaveLength(6);
    expect(collapsed[1]).toContain("system");
    expect(collapsed[1]!.trimEnd()).toMatch(/~9 tokens$/);
    // Short prompts fit the cap — no fold marker.
    expect(collapsed[1]).not.toContain("▸");
    expect(collapsed[4]).toContain("You are a test assistant. Be brief.");

    const long = {
      ...items[0]!,
      text: "You are a test assistant.\n\nBe thorough, precise, and concise.\n".repeat(10),
    };
    const truncated = renderConversationItem(long, 60, THEME, false, false).map(stripAnsi);
    expect(truncated[1]).toContain("▸ system");
    const expanded = renderConversationItem(long, 60, THEME, false, true).map(stripAnsi);
    expect(expanded[1]).toContain("▾ system");
    expect(expanded.length).toBeGreaterThan(truncated.length);
  });

  it("renders assistant reasoning dim above the reply", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 100, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 50, step.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "ai.response.reasoning": "let me think about this",
      "ai.response.text": "here is my answer",
    });
    const assistant = buildConversationItems(trace([turn, step, model])).find(
      (item) => item.kind === "assistant",
    )!;
    expect(assistant.reasoning).toBe("let me think about this");
    const lines = renderConversationItem(assistant, 60, THEME, false, false).map(stripAnsi);
    const headerIndex = lines.findIndex((line) => line.includes("Thought:"));
    const reasoningIndex = lines.findIndex((line) => line.includes("let me think about this"));
    const answerIndex = lines.findIndex((line) => line.includes("here is my answer"));
    // Thought: header, a blank line, the reasoning, a blank line, the reply.
    expect(headerIndex).toBeGreaterThan(-1);
    expect(lines[headerIndex + 1]!.trim()).toBe("");
    expect(reasoningIndex).toBe(headerIndex + 2);
    expect(lines[reasoningIndex + 1]!.trim()).toBe("");
    expect(answerIndex).toBe(reasoningIndex + 2);
  });

  it("keeps reasoning-only responses as assistant cards", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, {});
    const step = span("b".repeat(16), "agent.step", 10, 100, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 50, step.spanId, {
      "ai.response.reasoning": "only thinking, no reply text",
    });
    const items = buildConversationItems(trace([turn, step, model]));
    expect(items.map((item) => item.kind)).toEqual(["assistant"]);
  });

  it("caps collapsed payloads and renders them fully when expanded", () => {
    const items = buildConversationItems(trace(weatherTurn()));
    const tool = items.find((item) => item.kind === "tool")!;
    const long = { ...tool, result: "x".repeat(500) };
    const collapsed = renderConversationItem(long, 60, THEME, false, false).map(stripAnsi);
    expect(collapsed.some((line) => line.trim() === "…")).toBe(true);
    expect(collapsed.some((line) => line.includes("Click to expand"))).toBe(true);
    const expanded = renderConversationItem(long, 60, THEME, false, true).map(stripAnsi);
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.some((line) => line.includes("Click to collapse"))).toBe(true);
  });

  it("marks the selected card with a bright bar and a solid surface", () => {
    const assistant = buildConversationItems(trace(weatherTurn())).find(
      (item) => item.kind === "assistant",
    )!;
    const themed = createTheme({ color: true, unicode: true });
    const lines = renderConversationItem(assistant, 80, themed, true, false);
    for (const line of lines) {
      // Cyan half-block bar on the left edge, no inverse.
      expect(line).toContain("\x1b[97m▌\x1b[39m");
      expect(line).not.toContain("\x1b[7m");
    }
    // Header band rows in near-black, body rows in dark gray.
    for (const line of lines.slice(0, 3)) expect(line).toContain("\x1b[48;2;22;22;22m");
    for (const line of lines.slice(3)) expect(line).toContain("\x1b[48;2;36;36;36m");
    // The assistant title is bold white.
    expect(lines[1]).toContain("\x1b[97m");
    const unselected = renderConversationItem(assistant, 80, themed, false, false);
    expect(unselected[0]).not.toContain("▌");
    expect(unselected[0]).toContain("\x1b[48;2;22;22;22m");
  });

  it("never emits rows wider than the given width", () => {
    for (const item of buildConversationItems(trace(weatherTurn()))) {
      for (const line of renderConversationItem(item, 40, THEME, false, false)) {
        expect(visibleLength(line)).toBeLessThanOrEqual(40);
      }
    }
  });
});
