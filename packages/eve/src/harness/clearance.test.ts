import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { approvedClearance, mintClearance, requireClearance } from "#harness/clearance.js";
import { decideApproval, invokeTool, type RunnableTool } from "#harness/tools.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";

function viewOf(...lines: unknown[][]) {
  const view = emptySessionView();
  for (const facts of lines)
    foldLine(view, { at: "2026-10-31T00:00:00.000Z", facts } as never, view.position);
  return view;
}

const runnable = (name: string): RunnableTool => ({
  description: name,
  execute: () => "done",
  inputSchema: jsonSchema({ type: "object" }),
  name,
});

const turn = { turnId: "turn_0" };
const run = { runId: "run_0", turnId: "turn_0" };
const asked = (interactionId: string) => ({
  data: {
    interactionId,
    request: { kind: "approval", prompt: "Deploy?" },
    subject: { callId: "c_0" },
  },
  type: "interaction.opened",
});
const opened = [
  [{ data: {}, type: "session.started" }],
  [
    {
      data: { cause: { policy: "test" }, follows: null, turnId: "turn_0" },
      scope: turn,
      type: "turn.started",
    },
  ],
  [{ data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" }],
  [
    {
      data: {
        callId: "c_0",
        capability: { kind: "tool", name: "deploy" },
        owner: { runId: "run_0" },
      },
      scope: run,
      type: "call.requested",
    },
  ],
];

describe("approvedClearance", () => {
  it("clears a call on its latest approval, once accepted", () => {
    const view = viewOf(
      ...opened,
      [asked("i_0")],
      [{ data: { interactionId: "i_0", outcome: "interrupted" }, type: "interaction.settled" }],
      [asked("i_1")],
      [{ data: { interactionId: "i_1", outcome: "accepted" }, type: "interaction.settled" }],
    );
    expect(approvedClearance(view, "c_0")).toEqual({
      callId: "c_0",
      clearedBy: { interactionId: "i_1" },
    });
  });

  it("gives no clearance while the approval is open, or once it's declined", () => {
    expect(approvedClearance(viewOf(...opened, [asked("i_0")]), "c_0")).toBeUndefined();
    const declined = viewOf(
      ...opened,
      [asked("i_0")],
      [{ data: { interactionId: "i_0", outcome: "declined" }, type: "interaction.settled" }],
    );
    expect(approvedClearance(declined, "c_0")).toBeUndefined();
  });
});

describe("decideApproval", () => {
  it("clears a call that needs no approval, naming nothing", async () => {
    const tool = runnable("read_notes");
    await expect(decideApproval(tool, { callId: "c_0", input: {} })).resolves.toEqual({
      clearance: { callId: "c_0" },
      denied: false,
    });
  });
});

describe("invokeTool", () => {
  const tool = runnable("deploy");

  it("refuses to run a call on another call's clearance", async () => {
    expect(() => requireClearance(mintClearance("c_1"), "c_0")).toThrow(
      'Call "c_0" can\'t run on the clearance of call "c_1".',
    );
    await expect(
      invokeTool(tool, {}, { messages: [], toolCallId: "c_0" }, mintClearance("c_1")),
    ).rejects.toThrow("clearance of call");
  });

  it("takes a clearance to run at all", () => {
    // Never called: the type is what's under test.
    const unchecked = () =>
      // @ts-expect-error A call runs only on what the gate decided.
      invokeTool(tool, {}, { messages: [], toolCallId: "c_0" });
    expect(typeof unchecked).toBe("function");
  });
});
