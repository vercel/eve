import { describe, expect, it } from "vitest";

import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { withInterruptedSession } from "#internal/testing/interrupted-session.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

installWorkflowSandboxRuntime();

const runProgram = (js: string) =>
  toolCallStreamResult({
    input: JSON.stringify({ js }),
    toolCallId: "program",
    toolName: "workflow",
  });

function programResult(prompts: readonly string[]): unknown {
  const prompt = JSON.parse(prompts.at(-1)!) as {
    role: string;
    content: { type: string; output?: { value: unknown } }[];
  }[];
  return prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find((part) => part.type === "tool-result")?.output?.value;
}

const requested = (events: readonly SessionStreamEvent[]) =>
  events.flatMap((event) => (event.type === "call.requested" ? [event.data.callId] : []));

describe("program step crash recovery", () => {
  it("replays settled calls from a lost step without running them twice", async () => {
    const { prompts, ran } = await withInterruptedSession(
      "program-replay",
      {
        loseTurnStep: (completion) => completion === 2,
        respond: (_prompt, call) =>
          call === 1
            ? runProgram(
                "const a = await tools.first({}); const b = await tools.second({}); return [a.done, b.done];",
              )
            : textStreamResult("Both ran."),
        tools: [{ name: "workflow", program: true }, { name: "first" }, { name: "second" }],
      },
      async (session) => {
        const turn = await session.next("the program's turn");

        expect(session.interrupted()).toBe(1);
        expect(requested(turn)).toEqual(["program", "program/1", "program/2"]);
      },
    );

    expect(prompts).toHaveLength(2);
    expect(ran).toEqual(["first", "second"]);
    expect(programResult(prompts)).toEqual({
      calls: { completed: 2 },
      result: ["first", "second"],
    });
  }, 120_000);

  it("rejects a call the interrupted attempt started and runs an unstarted call under the same id", async () => {
    const { prompts, ran } = await withInterruptedSession(
      "program-partial",
      {
        failWriteOf: '"done":"second"',
        respond: (_prompt, call) =>
          call === 1
            ? runProgram(`
                const a = await tools.first({});
                const [b, c] = await Promise.allSettled([tools.second({}), tools.gated({})]);
                return [a.done, b.status === "rejected" ? b.reason.message : b.value.done, c.value.done];
              `)
            : textStreamResult("Recovered."),
        tools: [
          { name: "workflow", program: true },
          { name: "first" },
          { name: "second" },
          { approval: true, name: "gated" },
        ],
      },
      async (session) => {
        const asked = await session.next("the approval the retry asks");
        const approvals = asked.flatMap((event) =>
          event.type === "interaction.opened" && event.data.request.kind === "approval"
            ? [event.data]
            : [],
        );
        expect(approvals.map((approval) => approval.subject)).toEqual([{ callId: "program/3" }]);
        await session.answer(approvals[0]!.interactionId, "approve");
        const turn = [...asked, ...(await session.next("the program's turn"))];

        expect(requested(turn)).toEqual(["program", "program/1", "program/2", "program/3"]);
      },
    );

    expect(ran).toEqual(["first", "second", "gated"]);
    expect(programResult(prompts)).toEqual({
      calls: { abandoned: 1, completed: 2 },
      notCompleted: [{ input: "{}", outcome: "abandoned", tool: "second" }],
      result: [
        "first",
        "The step running this call was interrupted. The call may or may not have taken effect.",
        "gated",
      ],
    });
  }, 120_000);
});
