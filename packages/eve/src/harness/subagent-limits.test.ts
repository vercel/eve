import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";

import {
  applySubagentLimits,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  filterAdvertisedSubagentTools,
  resolveEffectiveSubagentLimits,
  setSubagentLimitState,
} from "#harness/subagent-limits.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "sess-test",
    state,
  };
}

function createSubagentAction(index: number): RuntimeSubagentCallActionRequest {
  return {
    callId: `call-${index}`,
    description: "Launch another copy.",
    input: { message: `work item ${index}` },
    kind: "subagent-call",
    name: "agent",
    nodeId: "__root__",
    subagentName: "agent",
  };
}

describe("resolveEffectiveSubagentLimits", () => {
  it("uses eve defaults when no limits are authored or inherited", () => {
    expect(resolveEffectiveSubagentLimits({})).toEqual({
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    });
  });

  it("allows root agents to raise default limits explicitly", () => {
    expect(
      resolveEffectiveSubagentLimits({
        authored: {
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxDepth: 6,
    });
  });

  it("inherits parent limits when a child does not author overrides", () => {
    expect(
      resolveEffectiveSubagentLimits({
        inherited: {
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxDepth: 6,
    });
  });

  it("lets child agents tighten inherited limits but not loosen them", () => {
    expect(
      resolveEffectiveSubagentLimits({
        authored: {
          maxDepth: 10,
        },
        inherited: {
          maxDepth: 6,
        },
      }),
    ).toEqual({
      maxDepth: 6,
    });
  });
});

describe("applySubagentLimits", () => {
  it("rejects stale subagent calls once depth reaches the configured maximum", () => {
    const session = setSubagentLimitState({
      depth: 2,
      limits: {
        maxDepth: 2,
      },
      session: createSession(),
    });

    const result = applySubagentLimits({
      actions: [createSubagentAction(1)],
      session,
    });

    expect(result.actions).toEqual([]);
    expect(result.rejectedResults).toEqual([
      {
        callId: "call-1",
        isError: true,
        kind: "subagent-result",
        output: {
          code: "EVE_SUBAGENT_DEPTH_LIMIT_EXCEEDED",
          message:
            "Maximum subagent depth reached. Do not retry this subagent call; complete the work in this session or return a partial result.",
        },
        subagentName: "agent",
      },
    ]);
  });

  it("allows subagent calls while depth remains below the configured maximum", () => {
    const session = setSubagentLimitState({
      depth: 1,
      limits: {
        maxDepth: 2,
      },
      session: createSession(),
    });

    const result = applySubagentLimits({
      actions: [createSubagentAction(1)],
      session,
    });

    expect(result.actions.map((action) => action.callId)).toEqual(["call-1"]);
    expect(result.rejectedResults).toEqual([]);
  });
});

describe("filterAdvertisedSubagentTools", () => {
  const tools = new Map<string, HarnessToolDefinition>([
    [
      "search",
      {
        description: "Search locally.",
        execute: () => "result",
        inputSchema: jsonSchema({ type: "object" }),
        name: "search",
      },
    ],
    [
      "delegate",
      {
        description: "Delegate to a subagent.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "delegate",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "worker",
          subagentName: "worker",
        },
      },
    ],
    [
      "remote_reviewer",
      {
        description: "Delegate to a remote agent.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "remote_reviewer",
        runtimeAction: {
          kind: "remote-agent-call",
          nodeId: "remote",
          remoteAgentName: "reviewer",
          subagentName: "reviewer",
        },
      },
    ],
  ]);

  it("keeps subagent tools advertised while depth remains below the cap", () => {
    const session = setSubagentLimitState({
      depth: 1,
      limits: {
        maxDepth: 2,
      },
      session: createSession(),
    });

    expect(filterAdvertisedSubagentTools({ session, tools })).toBe(tools);
  });

  it("hides subagent tools from the model once the depth cap is reached", () => {
    const toolsWithFutureRuntimeAction = new Map(tools);
    const futureRuntimeTool: HarnessToolDefinition = {
      description: "Start a durable workflow job.",
      inputSchema: jsonSchema({ type: "object" }),
      name: "workflow_job",
    };
    (
      futureRuntimeTool as {
        runtimeAction?: {
          readonly kind: string;
          readonly nodeId: string;
          readonly subagentName: string;
        };
      }
    ).runtimeAction = {
      kind: "workflow-job",
      nodeId: "workflow",
      subagentName: "workflow",
    };
    toolsWithFutureRuntimeAction.set("workflow_job", futureRuntimeTool);

    const session = setSubagentLimitState({
      depth: 2,
      limits: {
        maxDepth: 2,
      },
      session: createSession(),
    });

    const filtered = filterAdvertisedSubagentTools({
      session,
      tools: toolsWithFutureRuntimeAction,
    });

    expect([...filtered.keys()]).toEqual(["search", "workflow_job"]);
    expect(filtered).not.toBe(toolsWithFutureRuntimeAction);
  });
});
