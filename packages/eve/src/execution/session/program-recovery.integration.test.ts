import { describe, expect, it } from "vitest";

import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { withInterruptedSession } from "#internal/testing/interrupted-session.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

// As eve's host does for agents with code mode on.
installWorkflowSandboxRuntime();

// A program step that published and then lost its checkpoint runs again as the same
// `eve__execute` call. The model is never asked to write the program again, and no call the
// interrupted attempt ran runs a second time: the retry replays what the stream recorded.

const runProgram = (code: string) =>
  toolCallStreamResult({
    input: JSON.stringify({ code }),
    toolCallId: "program",
    toolName: "eve__execute",
  });

/** The result of the `eve__execute` call as the model read it in its last prompt. */
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

describe("a program step that runs again", () => {
  it("replays the calls its lost attempt settled without running them twice", async () => {
    const { prompts, ran } = await withInterruptedSession(
      "program-replay",
      {
        codeMode: true,
        // The model step saves the program; the program's step is the second, and is lost once.
        loseTurnStep: (completion) => completion === 2,
        respond: (_prompt, call) =>
          call === 1
            ? runProgram(
                "const a = await tools.first({}); const b = await tools.second({}); return [a.done, b.done];",
              )
            : textStreamResult("Both ran."),
        tools: [{ name: "first" }, { name: "second" }],
      },
      async (session) => {
        const turn = await session.next("the program's turn");

        expect(session.interrupted()).toBe(1);
        // The same call ids on the retry: nothing is requested twice.
        expect(requested(turn)).toEqual(["program", "program/1", "program/2"]);
      },
    );

    // One model call wrote the program; the next read its result.
    expect(prompts).toHaveLength(2);
    expect(ran).toEqual(["first", "second"]);
    expect(programResult(prompts)).toEqual({
      calls: { completed: 2 },
      result: ["first", "second"],
    });
  }, 120_000);

  it("rejects a call the attempt started, and runs one it only requested under the same id", async () => {
    const { prompts, ran } = await withInterruptedSession(
      "program-partial",
      {
        codeMode: true,
        // The write that settles `second` fails, and the attempt dies with `gated` still waiting
        // on its approval policy.
        failWriteOf: '"done":"second"',
        respond: (_prompt, call) =>
          call === 1
            ? runProgram(`
                const a = await tools.first({});
                const [b, c] = await Promise.allSettled([tools.second({}), tools.gated({})]);
                return [a.done, b.status === "rejected" ? b.reason.message : b.value.done, c.value.done];
              `)
            : textStreamResult("Recovered."),
        tools: [{ name: "first" }, { name: "second" }, { approval: true, name: "gated" }],
      },
      async (session) => {
        const asked = await session.next("the approval the retry asks");
        const approvals = asked.flatMap((event) =>
          event.type === "interaction.opened" && event.data.request.kind === "approval"
            ? [event.data]
            : [],
        );
        // The retry asks about the call the attempt requested, as that call.
        expect(approvals.map((approval) => approval.subject)).toEqual([{ callId: "program/3" }]);
        await session.answer(approvals[0]!.interactionId, "approve");
        const turn = [...asked, ...(await session.next("the program's turn"))];

        expect(requested(turn)).toEqual(["program", "program/1", "program/2", "program/3"]);
      },
    );

    // `first` is replayed and `second` is never run again; `gated` runs once, after approval.
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
