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
function setup(tool: HarnessToolDefinition) {
  const events: SessionEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: vi
      .fn()
      .mockImplementationOnce(async () =>
        toolCallsStreamResult([{ input: "{}", toolCallId: "call-0", toolName: tool.name }]),
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
    tools: new Map([[tool.name, tool]]),
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
      inputResponses: [
        {
          optionId: "approve",
          requestId: request?.type === "interaction.opened" ? request.data.interactionId : "",
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
