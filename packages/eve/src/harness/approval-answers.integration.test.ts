import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalResponsePolicy } from "#approval/definition.js";
import { contextStorage } from "#context/container.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, HarnessStepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { createProjectionRecorder } from "#internal/testing/session-projection-recorder.js";
import { eachEvent, parkedSteps } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

function gated(name: string, response?: ApprovalResponsePolicy): HarnessToolDefinition {
  return {
    approval:
      response === undefined ? () => "user-approval" : { request: () => "user-approval", response },
    description: name,
    execute: vi.fn(async () => `${name} done`),
    inputSchema: jsonSchema({ type: "object" }),
    name,
  };
}

/** A harness whose model calls every tool in `tools` in one step, then replies. */
function setup(tools: readonly HarnessToolDefinition[]) {
  const events: SessionEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: vi
      .fn()
      .mockImplementationOnce(async () =>
        toolCallsStreamResult(
          tools.map((tool) => ({
            input: "{}",
            toolCallId: `call-${tool.name}`,
            toolName: tool.name,
          })),
        ),
      )
      .mockImplementation(async () => textStreamResult("Finished.")),
    modelId: "approval-model",
    provider: "eve-integration-mock",
  });
  const recorder = createProjectionRecorder();
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    handleEvent: eachEvent(async (event) => {
      recorder.record(event);
      events.push(event);
    }),
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
  };
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "approval-model" },
      system: "Help Alice ship her release.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:approval-answers",
    history: [],
    sessionId: "approval-answers",
  };
  const ctx = recorder.enter(createApprovalContext());
  const step = (current: HarnessSession, input?: HarnessStepInput) =>
    contextStorage.run(ctx, () => createToolLoopHarness(config)(current, input));
  /** The approval the step asked for `toolName`'s call. */
  const approvalOf = (toolName: string): string => {
    const opened = events.find(
      (event) =>
        event.type === "interaction.opened" &&
        "callId" in event.data.subject &&
        event.data.subject.callId === `call-${toolName}`,
    );
    if (opened?.type !== "interaction.opened") throw new Error(`No approval for ${toolName}.`);
    return opened.data.interactionId;
  };
  return { approvalOf, events, session, step };
}

describe("approval answers (real AI SDK)", () => {
  // #4817: a second press of the same Approve reaches the pass that authorizes the first.
  it("authorizes a pending approval when a duplicate answer joins its pass", async () => {
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const deploy = gated("deploy", response);
    const fixture = setup([deploy]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const approve = {
      answers: [
        {
          deliveryId: "d-approve",
          interactionId: fixture.approvalOf("deploy"),
          optionId: "approve",
          responseId: "r-approve",
        },
      ],
    };

    const first = await fixture.step(parked.session, approve);
    expect(typeof first.next).toBe("function");
    const result = await fixture.step(first.session, approve);

    expect(response).toHaveBeenCalledOnce();
    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(parkedSteps(result.session)).toEqual([]);
  });

  it("authorizes a pending approval when a sibling's direct answer joins its pass", async () => {
    const response = vi.fn<ApprovalResponsePolicy>(() => ({ status: "allowed" }));
    const deploy = gated("deploy", response);
    const notify = gated("notify");
    const fixture = setup([deploy, notify]);
    const parked = await fixture.step(fixture.session, { message: "Deploy, then tell the team." });

    const first = await fixture.step(parked.session, {
      answers: [
        {
          deliveryId: "d-deploy",
          interactionId: fixture.approvalOf("deploy"),
          optionId: "approve",
          responseId: "r-deploy",
        },
      ],
    });
    expect(typeof first.next).toBe("function");
    const result = await fixture.step(first.session, {
      answers: [
        {
          deliveryId: "d-notify",
          interactionId: fixture.approvalOf("notify"),
          optionId: "approve",
          responseId: "r-notify",
        },
      ],
    });

    expect(response).toHaveBeenCalledOnce();
    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(notify.execute).toHaveBeenCalledOnce();
    expect(parkedSteps(result.session)).toEqual([]);
  });

  // #4817: an answer the approval can't take is refused with why, and the approval stays open.
  it.each([
    {
      answer: { optionId: "bogus" },
      feedback: "Respond to this approval with Approve or Cancel.",
      label: "an answer that is neither Approve nor Cancel",
    },
    {
      answer: { optionId: "approve", responder: null },
      feedback: "Authentication is required to respond to this approval.",
      label: "an unauthenticated Approve of the requester's call",
    },
  ])("refuses $label and keeps the approval open", async ({ answer, feedback }) => {
    const deploy = gated("deploy");
    const fixture = setup([deploy]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const result = await fixture.step(parked.session, {
      answers: [
        {
          deliveryId: "d-answer",
          interactionId: fixture.approvalOf("deploy"),
          responseId: "r-answer",
          ...answer,
        },
      ],
    });

    expect(deploy.execute).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        data: { outcome: "refused", reason: feedback, responseId: "r-answer" },
        type: "response.settled",
      }),
    );
    expect(fixture.events.filter((event) => event.type === "interaction.settled")).toEqual([]);
    expect(parkedSteps(result.session)).toHaveLength(1);
  });

  it.each([
    { label: "direct", responsePolicy: false },
    { label: "response-authorized", responsePolicy: true },
  ])("tells the model the note sent with a $label Cancel", async ({ responsePolicy }) => {
    const deploy = gated("deploy", responsePolicy ? () => ({ status: "allowed" }) : undefined);
    const fixture = setup([deploy]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    let result = await fixture.step(parked.session, {
      answers: [
        {
          deliveryId: "d-deny",
          interactionId: fixture.approvalOf("deploy"),
          optionId: "deny",
          responseId: "r-deny",
          text: "use 900 instead of 1250",
        },
      ],
    });
    // A response policy decides the Cancel in the pass the answer schedules.
    if (responsePolicy) result = await fixture.step(result.session);

    expect(deploy.execute).not.toHaveBeenCalled();
    expect(
      result.session.history
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .filter((part) => part.type === "tool-result"),
    ).toMatchObject([
      {
        output: {
          reason:
            'Tool execution was denied. The person who denied it wrote: "use 900 instead of 1250"',
          type: "execution-denied",
        },
        toolCallId: "call-deploy",
      },
    ]);
  });
});
