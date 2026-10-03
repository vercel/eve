import { describe, expect, it } from "vitest";

import {
  AT,
  Turn,
  answer,
  answered,
  answers,
  approval,
  approvalsRequested,
  cancel,
  heldOnApprovals,
  message,
  stepResponse,
} from "#internal/testing/human-input.js";

/** What Alice's call to `toolName` returned when it ran. */
function ran(toolName: string, value: { readonly [key: string]: boolean }) {
  return {
    output: { type: "json" as const, value },
    toolCallId: `call-${toolName}`,
    toolName,
    type: "tool-result" as const,
  };
}

/** What Alice's call to `toolName` returns when it never runs. */
function notRun(toolName: string, reason: string) {
  return {
    output: { reason, type: "execution-denied" },
    toolCallId: `call-${toolName}`,
    toolName,
    type: "tool-result",
  };
}

describe("tool approvals", () => {
  it("asking publishes one request per call at the step's coordinates and holds the turn", () => {
    const turn = Turn.idle().interrupt(
      approvalsRequested([approval("send_email"), approval("deploy")]),
    );

    expect(turn.published("input.requested")).toEqual([
      {
        data: { ...AT, requests: [approval("send_email"), approval("deploy")] },
        type: "input.requested",
      },
    ]);
    expect(turn.stored().next()).toEqual({ held: "input" });
    expect(turn.stored().humanInput.openRequestIds()).toEqual(new Set(["send_email", "deploy"]));
  });

  it("a partial answer keeps the turn held and runs nothing", () => {
    const turn = heldOnApprovals("send_email", "deploy").intake(answer("approve", "send_email"));

    expect(turn.events).toEqual([]);
    expect(turn.stored().next()).toEqual({ held: "input" });
  });

  it("the answer that completes the step runs the approved calls with the step that asked", () => {
    const turn = heldOnApprovals("send_email", "deploy")
      .intake(answer("approve", "send_email"))
      .stored()
      .intake(answer("approve", "deploy"));

    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email"), approval("deploy")], type: "calls.approved" },
    ]);
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "approved"],
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a denied or unrecognized answer records the call as not run, and only approved calls run", () => {
    const turn = heldOnApprovals("send_email", "deploy", "delete_repo").intake(
      answers({ send_email: "approve", deploy: "cancel", delete_repo: "maybe" }),
    );

    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email")], type: "calls.approved" },
    ]);
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "denied"],
      ["delete_repo", "invalid"],
    ]);
    // The step waits for the approved call's result before it joins history.
    expect(turn.appended()).toEqual([]);
    expect(turn.published("action.result").map((event) => event.data.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    const settled = turn.stored().intake({
      results: [{ content: [ran("send_email", { sent: true })], role: "tool" }],
      type: "calls.settled",
    });
    expect(settled.appended()).toEqual([
      ...stepResponse([approval("send_email"), approval("deploy"), approval("delete_repo")]),
      {
        content: [
          notRun("deploy", "Tool execution was denied."),
          notRun("delete_repo", "Invalid approval response."),
          ran("send_email", { sent: true }),
        ],
        role: "tool",
      },
    ]);
    expect(settled.stored().humanInput.suspendedMessages()).toEqual([]);
  });

  it("the last answer to a request wins", () => {
    const turn = heldOnApprovals("deploy").intake(
      answered([
        { optionId: "approve", requestId: "deploy" },
        { optionId: "cancel", requestId: "deploy" },
      ]),
    );

    expect(turn.reported("calls.approved")).toEqual([]);
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["denied"]);
  });

  it("a typed reply that names an option answers the approvals, and the turn does not read it", () => {
    const turn = heldOnApprovals("deploy").intake(message("Approve"));

    expect(turn.events[0]).toEqual({ type: "message.answered" });
    expect(turn.reported("calls.approved")).toHaveLength(1);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("any other message steers past unanswered approvals and keeps the answers already given", () => {
    const turn = heldOnApprovals("send_email", "deploy")
      .intake(answer("approve", "send_email"))
      .intake(message("Never mind, check the draft status instead."));

    expect(turn.reported("message.answered")).toEqual([]);
    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email")], type: "calls.approved" },
    ]);
    expect(turn.appended()).toEqual([]);
    expect(turn.next()).toEqual({ run: "model" });
    expect(
      turn
        .intake({
          results: [{ content: [ran("send_email", { sent: true })], role: "tool" }],
          type: "calls.settled",
        })
        .appended(),
    ).toEqual([
      ...stepResponse([approval("send_email"), approval("deploy")]),
      {
        content: [
          notRun("deploy", "Ignored because the user continued without responding."),
          ran("send_email", { sent: true }),
        ],
        role: "tool",
      },
    ]);
  });

  it("a cancel resolves each open approval as cancelled at the step that asked", () => {
    const later = { sequence: 4, stepIndex: 2, turnId: "turn_1" };
    const turn = Turn.idle()
      .interrupt(approvalsRequested([approval("deploy")], { at: later }))
      .intake(cancel);

    expect(turn.published("input.resolved")).toEqual([
      {
        data: {
          ...later,
          resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId: "deploy" }],
        },
        type: "input.resolved",
      },
    ]);
    expect(turn.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [notRun("deploy", "Cancelled before anyone answered.")], role: "tool" },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("asking keeps the step out of history until every call it made has a result", () => {
    const held = heldOnApprovals("deploy").stored();

    expect(held.events.filter((event) => event.type === "history.appended")).toEqual([]);
    expect(held.humanInput.suspendedMessages()).toEqual(stepResponse([approval("deploy")]));

    const denied = held.intake(answer("cancel", "deploy"));
    expect(denied.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [notRun("deploy", "Tool execution was denied.")], role: "tool" },
    ]);
    expect(denied.storesNothing()).toBe(true);
  });

  it("calls that ran beside open approvals wait with the step, and join history with it", () => {
    // The step also made a runtime call, so the coordination batch held its response.
    const step = [
      {
        content: [
          { input: {}, toolCallId: "call-deploy", toolName: "deploy", type: "tool-call" as const },
          { input: {}, toolCallId: "call-build", toolName: "build", type: "tool-call" as const },
        ],
        role: "assistant" as const,
      },
      { content: [ran("build", { built: true })], role: "tool" as const },
    ];
    const settled = Turn.idle()
      .interrupt(approvalsRequested([approval("deploy")], { messages: [] }))
      .intake({ results: step, type: "calls.settled" });

    expect(settled.appended()).toEqual([]);
    expect(settled.stored().next()).toEqual({ held: "input" });

    expect(settled.stored().intake(answer("cancel", "deploy")).appended()).toEqual([
      step[0],
      {
        content: [ran("build", { built: true }), notRun("deploy", "Tool execution was denied.")],
        role: "tool",
      },
    ]);
  });

  it("an approved call that runs as runtime work takes the step with it", () => {
    const approved = heldOnApprovals("deploy").intake(answer("approve", "deploy"));
    const dispatched = approved.stored().intake({
      results: [],
      running: ["call-deploy"],
      type: "calls.settled",
    });

    expect(dispatched.appended()).toEqual([]);
    expect(dispatched.reported("calls.dispatched")).toEqual([
      { at: AT, messages: stepResponse([approval("deploy")]), type: "calls.dispatched" },
    ]);
    expect(dispatched.stored().humanInput.suspendedMessages()).toEqual([]);
  });

  it("a cancel while a step waits answers every call it made", () => {
    const turn = Turn.idle()
      .interrupt(
        approvalsRequested([approval("deploy")], {
          messages: [
            {
              content: [
                { input: {}, toolCallId: "call-deploy", toolName: "deploy", type: "tool-call" },
                { input: {}, toolCallId: "call-lookup", toolName: "lookup", type: "tool-call" },
              ],
              role: "assistant",
            },
          ],
        }),
      )
      .intake(cancel);

    expect(turn.appended().at(-1)).toEqual({
      content: [
        notRun("deploy", "Cancelled before anyone answered."),
        notRun("lookup", "Cancelled before anyone answered."),
      ],
      role: "tool",
    });
  });

  it("results for a step parked with its calls already in history join history directly", () => {
    const results = [
      {
        content: [
          {
            output: { type: "json" as const, value: { sent: true } },
            toolCallId: "call-send_email",
            toolName: "send_email",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ];

    expect(Turn.idle().intake({ results, type: "calls.settled" }).appended()).toEqual(results);
  });

  it("an approved once() approval grants its key, except while another approval for it waits", () => {
    const keyed = (requestId: string) =>
      approvalsRequested([approval("deploy", requestId)], {
        approvalKeys: { [requestId]: "deploy:api" },
      });
    const granted = Turn.idle().interrupt(keyed("first")).intake(answer("approve", "first"));

    expect(granted.stored().humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));
    expect(granted.interrupt(keyed("second")).humanInput.grantedApprovalKeys()).toEqual(new Set());
  });
});
