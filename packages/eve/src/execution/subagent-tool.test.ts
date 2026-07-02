import { describe, expect, it } from "vitest";

import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { buildSubagentRunInput } from "#execution/subagent-tool.js";

type BuildSubagentRunInput = Parameters<typeof buildSubagentRunInput>[0];

function makeSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  };
}

function makeAction(): RuntimeSubagentCallActionRequest {
  return {
    callId: "call-1",
    description: "Delegate to linear.",
    input: { message: "Make an issue titled 'Resolve flaky test'." },
    kind: "subagent-call",
    name: "linear",
    nodeId: "subagents/linear",
    subagentName: "linear",
  };
}

function buildRuntimeSubagentRunInput(
  input: Omit<BuildSubagentRunInput, "source">,
): ReturnType<typeof buildSubagentRunInput> {
  return buildSubagentRunInput({ ...input, source: { type: "runtime" } });
}

describe("buildSubagentRunInput", () => {
  it("forwards parent capabilities to the child run input", () => {
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      capabilities: { requestInput: true },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.capabilities).toEqual({ requestInput: true });
  });

  it("leaves capabilities undefined when the parent has none", () => {
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.capabilities).toBeUndefined();
  });

  it("sets the subagent adapter state with parent lineage metadata", () => {
    const { childContinuationToken, runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 5, turnId: "turn-17" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.adapter.kind).toBe(SUBAGENT_ADAPTER_KIND);
    expect(runInput.adapter.state).toMatchObject({
      callId: "call-1",
      parentContinuationToken: "parent-token",
      parentSessionId: "parent-session",
      subagentName: "linear",
    });
    expect(runInput.parent).toEqual({
      callId: "call-1",
      rootSessionId: "parent-session",
      sessionId: "parent-session",
      turn: { id: "turn-17", sequence: 5 },
    });
    expect(runInput.continuationToken).toBe(childContinuationToken);
    expect(childContinuationToken).toMatch(/^subagent:parent-session:call-1$/);
  });

  it("routes parent notifications to an active turn inbox when supplied", () => {
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      parentContinuationToken: "turn-inbox",
      session: makeSession(),
    });

    expect(runInput.adapter.state).toMatchObject({
      parentContinuationToken: "turn-inbox",
    });
  });

  it("forwards channelMetadata to the child run input", () => {
    const projection = {
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678", userId: "U123" },
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      channelMetadata: projection,
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.channelMetadata).toEqual(projection);
  });

  it("leaves channelMetadata undefined when the parent has none", () => {
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.channelMetadata).toBeUndefined();
  });

  it("propagates an existing rootSessionId through a nested subagent chain", () => {
    const nestedSession: HarnessSession = {
      ...makeSession(),
      rootSessionId: "root-session-from-top",
      sessionId: "intermediate-session",
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 1, turnId: "turn-99" },
      initiatorAuth: null,
      session: nestedSession,
    });

    expect(runInput.parent).toEqual({
      callId: "call-1",
      rootSessionId: "root-session-from-top",
      sessionId: "intermediate-session",
      turn: { id: "turn-99", sequence: 1 },
    });
  });

  it("increments subagent depth for the child run input", () => {
    const nestedSession: HarnessSession = {
      ...makeSession(),
      sessionId: "intermediate-session",
      subagentDepth: 2,
      subagentMaxDepth: 4,
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 1, turnId: "turn-99" },
      initiatorAuth: null,
      session: nestedSession,
    });

    expect(runInput.subagentDepth).toBe(3);
    expect(runInput.subagentMaxDepth).toBe(4);
  });

  it("threads outputSchema from action input to RunInput", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } };
    const action: RuntimeSubagentCallActionRequest = {
      ...makeAction(),
      input: { message: "do something", outputSchema: schema },
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action,
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.input.outputSchema).toEqual(schema);
  });

  it("passes a resolved local subagent description into the child message", () => {
    const { runInput } = buildSubagentRunInput({
      action: {
        ...makeAction(),
        description: "Runtime action event description.",
      },
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
      source: { description: "Local delegate subagent description.", type: "local" },
    });

    expect(runInput.input.message).toBe(
      [
        'You are the subagent "linear".',
        "Description: Local delegate subagent description.",
        "",
        "The caller delegated the following task to you. Complete it and return the final result directly.",
        "",
        "Caller message:",
        "Make an issue titled 'Resolve flaky test'.",
      ].join("\n"),
    );
    expect(runInput.input.message).not.toContain("Runtime action event description.");
  });

  it("does not pass the built-in agent tool description into the child message", () => {
    const action: RuntimeSubagentCallActionRequest = {
      ...makeAction(),
      description: "Delegate a focused subtask to a fresh copy of yourself.",
      name: "agent",
      nodeId: "root",
      subagentName: "agent",
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action,
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.input.message).toBe(
      [
        `You are the subagent "${action.subagentName}".`,
        "",
        "The caller delegated the following task to you. Complete it and return the final result directly.",
        "",
        "Caller message:",
        "Make an issue titled 'Resolve flaky test'.",
      ].join("\n"),
    );
    expect(runInput.input.message).not.toContain(action.description);
  });

  it("leaves outputSchema undefined when not provided", () => {
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session: makeSession(),
    });

    expect(runInput.input.outputSchema).toBeUndefined();
  });

  it("includes parentSandboxState and sandboxSessionId for self-delegation", () => {
    const sandboxState = { initialized: true, session: null };
    const session = { ...makeSession(), sandboxState };
    const action: RuntimeSubagentCallActionRequest = {
      ...makeAction(),
      subagentName: "agent",
    };
    const { runInput } = buildRuntimeSubagentRunInput({
      action,
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session,
    });

    expect(runInput.adapter.state).toMatchObject({
      parentSandboxState: sandboxState,
      sandboxSessionId: "parent-session",
    });
  });

  it("does not include sandbox sharing fields for normal subagents", () => {
    const sandboxState = { initialized: true, session: null };
    const session = { ...makeSession(), sandboxState };
    const { runInput } = buildRuntimeSubagentRunInput({
      action: makeAction(),
      auth: null,
      batchEvent: { sequence: 0, turnId: "turn-0" },
      initiatorAuth: null,
      session,
    });

    expect(runInput.adapter.state).not.toHaveProperty("parentSandboxState");
    expect(runInput.adapter.state).not.toHaveProperty("sandboxSessionId");
  });
});
