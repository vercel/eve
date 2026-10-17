import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalContext } from "#approval/definition.js";
import { contextStorage } from "#context/container.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { runtimeWait } from "#harness/session-machine/view.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { createProjectionRecorder } from "#internal/testing/session-projection-recorder.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { always, once } from "#tools/approval/policies.js";

vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

function workflow(
  name: string,
  approval: HarnessToolDefinition["approval"],
  workflowId = `workflow//./agent/tools/${name}//execute`,
): HarnessToolDefinition {
  return {
    approval,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    workflowId,
  };
}

/** A harness whose model calls `tool` once, then replies; its events fold into one projection. */
function setup(
  tool: HarnessToolDefinition,
  options: {
    readonly tools?: readonly HarnessToolDefinition[];
    readonly calls?: readonly Parameters<typeof toolCallsStreamResult>[0][];
  } = {},
) {
  const events: SessionEvent[] = [];
  const calls = options.calls ?? [[{ input: "{}", toolCallId: "call-0", toolName: tool.name }]];
  let index = 0;
  const model = new MockLanguageModelV4({
    doStream: vi.fn().mockImplementation(async () => {
      const batch = calls[index++];
      return batch === undefined ? textStreamResult("Finished.") : toolCallsStreamResult(batch);
    }),
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
    tools: new Map([tool, ...(options.tools ?? [])].map((entry) => [entry.name, entry])),
  };
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "approval-model" },
      system: "Help Alice coordinate her release.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:approved-call-recheck",
    history: [],
    sessionId: "approved-call-recheck",
  };
  const step = (
    current: HarnessSession,
    input?: Parameters<ReturnType<typeof createToolLoopHarness>>[1],
  ) =>
    contextStorage.run(recorder.enter(createApprovalContext()), () =>
      createToolLoopHarness(config)(current, input),
    );
  return { events, session, step };
}

describe("approved call recheck (real AI SDK)", () => {
  it("remembers keyed approvals through a wrapped policy and scopes them to the tool", async () => {
    const perEnvironment = once<Record<string, unknown>>({
      key: (input) => String(input.environment),
    });
    const execute = vi.fn(() => "deployed");
    const deploy: HarnessToolDefinition = {
      name: "deploy",
      description: "Deploy Alice's release",
      inputSchema: jsonSchema({ type: "object" }),
      approval: (context) => perEnvironment(Object.freeze({ ...context })),
      execute,
    };
    const call = (toolName: string, environment: string, toolCallId: string) => ({
      toolName,
      toolCallId,
      input: JSON.stringify({ environment }),
    });
    const fixture = setup(deploy, {
      tools: [{ ...deploy, name: "rollback" }],
      calls: [
        [call("deploy", "dev", "first")],
        [call("deploy", "dev", "remembered"), call("deploy", "prod", "different-key")],
        [call("rollback", "prod", "different-tool")],
      ],
    });
    const initial = await fixture.step(fixture.session, {
      message: "Help Alice deploy her release.",
    });
    const first = fixture.events.find((event) => event.type === "interaction.opened");
    if (first?.type !== "interaction.opened") throw new Error("Expected approval request");
    const approved = await fixture.step(
      JSON.parse(JSON.stringify(initial.session)) as HarnessSession,
      {
        answers: [
          {
            deliveryId: "approve-dev",
            responseId: "answer-dev",
            optionId: "approve",
            interactionId: first.data.interactionId,
          },
        ],
      },
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      fixture.events.filter((event) => event.type === "call.started").map((event) => event.data),
    ).toMatchObject([
      { callId: "first", clearedBy: { interactionId: first.data.interactionId } },
      { callId: "remembered", clearedBy: { grant: { interactionId: first.data.interactionId } } },
    ]);
    const second = fixture.events.filter((event) => event.type === "interaction.opened").at(-1)!;
    expect(second.data.subject).toEqual({ callId: "different-key" });
    await fixture.step(JSON.parse(JSON.stringify(approved.session)) as HarnessSession, {
      answers: [
        {
          deliveryId: "approve-prod",
          responseId: "answer-prod",
          optionId: "approve",
          interactionId: second.data.interactionId,
        },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(
      fixture.events.filter((event) => event.type === "interaction.opened").at(-1)?.data.subject,
    ).toEqual({ callId: "different-tool" });
  });

  it.each([
    ["always", "approve", false],
    ["once", "deny", false],
    ["once", "approve", true],
  ] as const)(
    "only remembers an approved once prompt (%s, %s)",
    async (policy, optionId, remembered) => {
      const perTool = once();
      const ask = always();
      const execute = vi.fn(() => "deployed");
      const fixture = setup(
        {
          name: "deploy",
          description: "Deploy Alice's release",
          inputSchema: jsonSchema({ type: "object" }),
          execute,
          approval: (context) =>
            context.callId === "first" && policy === "always" ? ask(context) : perTool(context),
        },
        {
          calls: [
            [{ input: "{}", toolCallId: "first", toolName: "deploy" }],
            [{ input: "{}", toolCallId: "second", toolName: "deploy" }],
          ],
        },
      );
      const initial = await fixture.step(fixture.session, {
        message: "Help Alice deploy her release.",
      });
      const request = fixture.events.find((event) => event.type === "interaction.opened")!;
      await fixture.step(initial.session, {
        answers: [
          {
            interactionId: request.data.interactionId,
            optionId,
            deliveryId: "answer-first",
            responseId: "response-first",
          },
        ],
      });
      expect(execute).toHaveBeenCalledTimes(remembered ? 2 : optionId === "approve" ? 1 : 0);
      const prompts = fixture.events.filter((event) => event.type === "interaction.opened");
      expect(prompts).toHaveLength(remembered ? 1 : 2);
      if (!remembered) expect(prompts.at(-1)?.data.subject).toEqual({ callId: "second" });
    },
  );

  it("keeps simultaneous once prompts independent before reusing their approval", async () => {
    const execute = vi.fn(() => "deployed");
    const call = (toolCallId: string) => ({ input: "{}", toolCallId, toolName: "deploy" });
    const fixture = setup(
      {
        name: "deploy",
        description: "Deploy Alice's release",
        inputSchema: jsonSchema({ type: "object" }),
        execute,
        approval: once(),
      },
      { calls: [[call("left"), call("right")], [call("later")]] },
    );
    const initial = await fixture.step(fixture.session, {
      message: "Help Alice deploy her releases.",
    });
    const requests = fixture.events.filter((event) => event.type === "interaction.opened");
    expect(requests).toHaveLength(2);
    const partial = await fixture.step(initial.session, {
      answers: [
        {
          interactionId: requests[0]!.data.interactionId,
          optionId: "approve",
          deliveryId: "answer-left",
          responseId: "response-left",
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.events.filter((event) => event.type === "interaction.settled")).toHaveLength(0);
    await fixture.step(partial.session, {
      answers: [
        {
          interactionId: requests[1]!.data.interactionId,
          optionId: "approve",
          deliveryId: "answer-right",
          responseId: "response-right",
        },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(fixture.events.filter((event) => event.type === "interaction.opened")).toHaveLength(2);
  });

  it("keeps a human-approved call's model output unchanged when its recheck returns a reason", async () => {
    let approved = false;
    const fixture = setup({
      name: "deploy",
      description: "Deploy Alice's release",
      inputSchema: jsonSchema({ type: "object" }),
      execute: () => "deployed",
      approval: () =>
        approved ? { type: "approved", reason: "Release window checked." } : "user-approval",
    });
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const request = fixture.events.find((event) => event.type === "interaction.opened");
    if (request?.type !== "interaction.opened") throw new Error("Expected approval request");
    approved = true;
    const result = await fixture.step(initial.session, {
      answers: [
        {
          deliveryId: "delivery-approve",
          optionId: "approve",
          interactionId: request.data.interactionId,
          responseId: "response-approve",
        },
      ],
    });
    expect(
      result.session.history.flatMap((message) => (message.role === "tool" ? message.content : [])),
    ).toMatchObject([{ output: { type: "text", value: "deployed" } }]);
  });

  it("preserves explicit policy clearance when a workflow call leaves the harness", async () => {
    const fixture = setup(
      workflow("deploy", () => ({ type: "approved", reason: "Release window checked." })),
    );
    const result = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    expect(runtimeWait(result.session.state)).toMatchObject({
      tasks: [{ callId: "call-0", clearedBy: { policy: "approval" } }],
    });
  });
  it.each(["workflow", "agent"])("rechecks an approved %s call before dispatch", async (kind) => {
    let frozen = false;
    const policy = vi.fn((ctx: ApprovalContext) =>
      frozen && ctx.session.auth.current?.principalId === "user-1"
        ? { type: "denied" as const, reason: "A change freeze is in effect." }
        : ("user-approval" as const),
    );
    const fixture = setup(
      workflow(
        "deploy",
        policy,
        kind === "agent" ? "workflow//./agent/subagents/release//run" : undefined,
      ),
    );
    const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const request = fixture.events.find((event) => event.type === "interaction.opened");
    expect(request?.type === "interaction.opened" && request.data.request.kind).toBe("approval");

    // A freeze begins for the requester after she asked, before anyone approves.
    frozen = true;
    const start = fixture.events.length;
    const approved = await fixture.step(initial.session, {
      answers: [
        {
          deliveryId: "delivery-approve",
          optionId: "approve",
          interactionId: request?.type === "interaction.opened" ? request.data.interactionId : "",
          responseId: "response-approve",
        },
      ],
    });

    // The recheck runs as the requester, and its denial means the run never starts.
    expect(runtimeWait(approved.session.state)).toBeUndefined();
    expect(policy.mock.calls.at(-1)?.[0].session.auth.current?.principalId).toBe("user-1");
    expect(
      fixture.events.slice(start).filter((event) => event.type === "call.settled"),
    ).toMatchObject([
      {
        data: {
          callId: "call-0",
          outcome: "rejected",
          output: { code: "TOOL_EXECUTION_DENIED", message: "A change freeze is in effect." },
        },
      },
    ]);
    expect(
      approved.session.history
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .filter((part) => part.type === "tool-result"),
    ).toMatchObject([
      { output: { reason: "A change freeze is in effect.", type: "execution-denied" } },
    ]);
  });
});
