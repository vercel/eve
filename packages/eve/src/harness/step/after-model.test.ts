import { describe, expect, it, vi } from "vitest";

import type { EndsTurnTools } from "#harness/model-call/tools.js";
import { callsEndTurn, type EndingCall } from "#harness/step/after-model.js";

function call(toolName: string, overrides: Partial<EndingCall> = {}): EndingCall {
  return {
    failed: false,
    output: undefined,
    toolCallId: `call-${toolName}`,
    toolName,
    ...overrides,
  };
}

describe("callsEndTurn", () => {
  const tools: EndsTurnTools = new Map([["no_reply", true]]);

  it("ends the turn when an ending call runs beside other calls", async () => {
    expect(await callsEndTurn([call("browser__close"), call("no_reply")], tools)).toBe(true);
    expect(await callsEndTurn([call("no_reply"), call("browser__close")], tools)).toBe(true);
  });

  it("ends the turn whatever its sibling calls' outcomes", async () => {
    const calls = [call("browser__close", { failed: true }), call("no_reply")];

    expect(await callsEndTurn(calls, tools)).toBe(true);
  });

  it("keeps the turn going when the ending call fails", async () => {
    const calls = [call("browser__close"), call("no_reply", { failed: true })];

    expect(await callsEndTurn(calls, tools)).toBe(false);
  });

  it("keeps the turn going when no call can end it", async () => {
    expect(await callsEndTurn([call("browser__close")], tools)).toBe(false);
    expect(await callsEndTurn([], tools)).toBe(false);
  });

  it("ends the turn once one endsTurn function accepts its call's output", async () => {
    const declines = vi.fn(() => false);
    const accepts = vi.fn((output: unknown) => (output as { posted: boolean }).posted);
    const functions: EndsTurnTools = new Map([
      ["post_table", declines],
      ["post_chart", accepts],
    ]);
    const calls = [
      call("post_table", { output: { posted: false } }),
      call("post_chart", { output: { posted: true } }),
      call("browser__close"),
    ];

    expect(await callsEndTurn(calls, functions)).toBe(true);
    expect(declines).toHaveBeenCalledWith({ posted: false });
    expect(accepts).toHaveBeenCalledWith({ posted: true });
  });

  it("keeps the turn going when every endsTurn function declines or throws", async () => {
    const functions: EndsTurnTools = new Map([
      ["post_table", () => false],
      [
        "post_chart",
        () => {
          throw new Error("boom");
        },
      ],
    ]);

    expect(await callsEndTurn([call("post_table"), call("post_chart")], functions)).toBe(false);
  });
});
