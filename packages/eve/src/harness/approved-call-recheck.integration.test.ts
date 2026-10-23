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
import { eventsOf } from "#harness/publication.js";
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
    // Each publication commits as one line, as the session's sink writes it.
    handleEvent: async (publication) => {
      recorder.record(eventsOf(publication));
      events.push(...eventsOf(publication));
    },
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
  it("remembers approval across inputs through a wrapped policy without clearing another tool", async () => {
    const perTool = once<Record<string, unknown>>();
    const execute = vi.fn(() => "deployed");
    const deploy: HarnessToolDefinition = {
      name: "deploy",
      description: "Deploy Alice's release",
      inputSchema: jsonSchema({ type: "object" }),
      approval: (context) => perTool(Object.freeze({ ...context })),
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
        [call("deploy", "prod", "remembered"), call("rollback", "prod", "different-tool")],
      ],
    });
    const initial = await fixture.step(fixture.session, {
      message: "Help Alice deploy her release.",
    });
    const first = fixture.events.find((event) => event.type === "interaction.opened");
    if (first?.type !== "interaction.opened") throw new Error("Expected approval request");
    await fixture.step(JSON.parse(JSON.stringify(initial.session)) as HarnessSession, {
      answers: [
        {
          deliveryId: "approve-dev",
          responseId: "answer-dev",
          optionId: "approve",
          interactionId: first.data.interactionId,
        },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      fixture.events.filter((event) => event.type === "call.started").map((event) => event.data),
    ).toMatchObject([
      { callId: "first", clearedBy: { interactionId: first.data.interactionId } },
      { callId: "remembered", clearedBy: { policy: "approval" } },
    ]);
    expect(fixture.events.filter((event) => event.type === "interaction.opened")).toHaveLength(2);
    expect(
      fixture.events.filter((event) => event.type === "interaction.opened").at(-1)?.data.subject,
    ).toEqual({ callId: "different-tool" });
  });

  it.each([
    ["always", "approve", false],
    ["consulted", "approve", false],
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
          approval: async (context) => {
            if (context.callId !== "first" || policy === "once") return perTool(context);
            // A policy that consults once() but returns another branch's prompt offers no grant.
            if (policy === "consulted") await perTool(context);
            return ask(context);
          },
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

  it.each([
    ["both approve", ["left", "approve"], ["right", "approve"], true],
    ["the later answer declines", ["left", "approve"], ["right", "deny"], false],
    [
      "the later answer, to the earlier prompt, declines",
      ["right", "approve"],
      ["left", "deny"],
      false,
    ],
    ["the later answer approves", ["left", "deny"], ["right", "approve"], true],
  ] as const)(
    "keeps simultaneous once prompts independent, then remembers the latest decision (%s)",
    async (_name, firstAnswer, secondAnswer, remembered) => {
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
      const answer = ([prompt, optionId]: readonly [string, string]) => ({
        interactionId: requests[prompt === "left" ? 0 : 1]!.data.interactionId,
        optionId,
        deliveryId: `answer-${prompt}`,
        responseId: `response-${prompt}`,
      });
      const partial = await fixture.step(initial.session, { answers: [answer(firstAnswer)] });
      expect(execute).not.toHaveBeenCalled();
      expect(fixture.events.filter((event) => event.type === "interaction.settled")).toHaveLength(
        0,
      );
      await fixture.step(JSON.parse(JSON.stringify(partial.session)) as HarnessSession, {
        answers: [answer(secondAnswer)],
      });
      const approvals = [firstAnswer, secondAnswer].filter(
        ([, optionId]) => optionId === "approve",
      );
      expect(execute).toHaveBeenCalledTimes(approvals.length + (remembered ? 1 : 0));
      const prompts = fixture.events.filter((event) => event.type === "interaction.opened");
      expect(prompts).toHaveLength(remembered ? 2 : 3);
      if (!remembered) expect(prompts.at(-1)?.data.subject).toEqual({ callId: "later" });
    },
  );

  it.each([
    [
      "approves the later prompt, then denies the earlier one",
      ["right", "approve"],
      ["left", "deny"],
    ],
    [
      "denies the earlier prompt, then approves the later one",
      ["left", "deny"],
      ["right", "approve"],
    ],
  ] as const)("keeps a denial when one delivery %s", async (_name, firstAnswer, secondAnswer) => {
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
    const answer = ([prompt, optionId]: readonly [string, string]) => ({
      interactionId: requests[prompt === "left" ? 0 : 1]!.data.interactionId,
      optionId,
      deliveryId: "answers",
      responseId: `response-${prompt}`,
    });
    await fixture.step(initial.session, { answers: [answer(firstAnswer), answer(secondAnswer)] });
    expect(execute).toHaveBeenCalledTimes(1);
    const prompts = fixture.events.filter((event) => event.type === "interaction.opened");
    expect(prompts).toHaveLength(3);
    expect(prompts.at(-1)?.data.subject).toEqual({ callId: "later" });
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
  it.each(["local", "workflow", "agent"])(
    "rechecks an approved %s call before execution",
    async (kind) => {
      let frozen = false;
      const policy = vi.fn((ctx: ApprovalContext) =>
        frozen && ctx.session.auth.current?.principalId === "user-1"
          ? { type: "denied" as const, reason: "A change freeze is in effect." }
          : ("user-approval" as const),
      );
      const tool = workflow(
        "deploy",
        policy,
        kind === "agent" ? "workflow//./agent/subagents/release//run" : undefined,
      );
      const execute = vi.fn(() => "deployed");
      const fixture = setup(kind === "local" ? { ...tool, workflowId: undefined, execute } : tool);
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

      // The recheck runs as the requester, and its denial means execution never starts.
      expect(execute).not.toHaveBeenCalled();
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
    },
  );

  it.each(["workflow", "agent"])(
    "fails an approved %s call whose dynamic entry changed before dispatch",
    async (kind) => {
      const tool = {
        ...workflow(
          "deploy",
          () => "user-approval" as const,
          kind === "agent" ? "workflow//./agent/subagents/release//run" : undefined,
        ),
        version: "offered",
      };
      const fixture = setup(tool);
      const initial = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
      const request = fixture.events.find((event) => event.type === "interaction.opened");

      // Bob changes the release target while Alice's approval waits.
      (tool as { version: string }).version = "changed";
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

      expect(runtimeWait(approved.session.state)).toBeUndefined();
      expect(
        fixture.events.slice(start).filter((event) => event.type === "call.settled"),
      ).toMatchObject([
        {
          data: {
            callId: "call-0",
            output:
              'The tool "deploy" changed since it was offered, so the call didn\'t run. If the task still needs it, request it again.',
          },
        },
      ]);
    },
  );
});
