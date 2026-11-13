import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createTestKernel, type TestKernelConfig } from "#internal/testing/kernel.js";
import type { HarnessSession, HarnessStepInput, StepResult } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createProjectionRecorder } from "#internal/testing/session-projection-recorder.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

function local(name: string, extra: Partial<HarnessToolDefinition> = {}): HarnessToolDefinition {
  return {
    description: name,
    execute: vi.fn(async () => `${name} done`),
    inputSchema: jsonSchema({ type: "object" }),
    name,
    ...extra,
  };
}

const noReply = local("no_reply", { endsTurn: true });
const close = () => local("browser__close");
const gated = () => local("deploy", { approval: () => "user-approval" });
const workflow = (extra: Partial<HarnessToolDefinition> = {}): HarnessToolDefinition => ({
  ...local("deploy"),
  execute: undefined,
  workflowId: "workflow//./agent/tools/deploy//execute",
  ...extra,
});

/** A harness whose model calls every tool in `tools` in one step, then writes text. */
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
      .mockImplementation(async () => textStreamResult("Nothing was posted.")),
    modelId: "ends-turn-model",
    provider: "eve-integration-mock",
  });
  const recorder = createProjectionRecorder();
  const config: TestKernelConfig = {
    agent: { model: { id: "ends-turn-model" } },
    capabilities: { requestInput: true },
    handleEvent: eachEvent(async (event) => {
      recorder.record(event);
      events.push(event);
    }),
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
  };
  const session: HarnessSession = {
    compaction: {},
    continuationToken: "http:ends-turn",
    history: [],
    sessionId: "ends-turn",
  };
  const ctx = recorder.enter(createApprovalContext());
  ctx.set(SandboxKey, mockSandbox().access);
  const runStep = (current: HarnessSession, input?: HarnessStepInput) =>
    contextStorage.run(ctx, () => createTestKernel(config)(current, recorder.admit(input)));
  /** Runs a step and every step it chains to in-process. */
  const run = async (current: HarnessSession, input?: HarnessStepInput): Promise<StepResult> => {
    let result = await runStep(current, input);
    while (typeof result.next === "function") result = await runStep(result.session);
    return result;
  };
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
  return { approvalOf, model, run, session };
}

const deployed = {
  runtimeActionResults: [
    { callId: "call-deploy", kind: "tool-result" as const, output: "deployed", toolName: "deploy" },
  ],
};

describe("an endsTurn call beside other calls", () => {
  it("ends the turn after an inline sibling, with no second model call", async () => {
    const fixture = setup([close(), noReply]);

    const result = await fixture.run(fixture.session, { message: "Check the count." });

    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(result.settledTurn?.output).toBe("");
  });

  it("ends the turn once a parked workflow sibling settles", async () => {
    const fixture = setup([noReply, workflow()]);
    const parked = await fixture.run(fixture.session, { message: "Check the count." });

    const result = await fixture.run(parked.session, deployed);

    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(result.settledTurn?.output).toBe("");
  });

  it("ends the turn when a parked workflow call that ends it settles beside an inline sibling", async () => {
    const fixture = setup([close(), workflow({ endsTurn: true })]);
    const parked = await fixture.run(fixture.session, { message: "Deploy." });

    const result = await fixture.run(parked.session, deployed);

    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(result.settledTurn?.output).toBe("");
  });

  it.each(["approve", "deny"])(
    "ends the turn once an approval-gated sibling is answered (%s)",
    async (optionId) => {
      const fixture = setup([noReply, gated()]);
      const parked = await fixture.run(fixture.session, { message: "Check the count." });

      const result = await fixture.run(parked.session, {
        answers: [
          {
            deliveryId: "d-answer",
            interactionId: fixture.approvalOf("deploy"),
            optionId,
            responseId: "r-answer",
          },
        ],
      });

      expect(fixture.model.doStreamCalls).toHaveLength(1);
      expect(result.settledTurn?.output).toBe("");
    },
  );

  it("lets the model answer when the ending call fails", async () => {
    const failing = local("no_reply", {
      endsTurn: true,
      execute: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    const fixture = setup([close(), failing]);

    const result = await fixture.run(fixture.session, { message: "Check the count." });

    expect(fixture.model.doStreamCalls).toHaveLength(2);
    expect(result.settledTurn?.output).toBe("Nothing was posted.");
  });
});
