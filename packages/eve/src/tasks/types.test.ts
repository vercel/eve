import { describe, expect, it } from "vitest";

import type { AgentAddress, AgentIdentity } from "#harness/handles/store.js";
import {
  createTaskRelayBinding,
  createSubagentExecutorBinding,
  readSubagentExecutor,
  readSubagentTaskMetadata,
  readTaskRelay,
} from "#tasks/types.js";

const identity: AgentIdentity = {
  id: "ag_research:operation1",
  name: "research",
  nodeId: "node_research",
};

const localAddress: AgentAddress = {
  continuationToken: "continuation_child",
  kind: "agent/local",
  sessionId: "session_child",
};

const remoteAddress: AgentAddress = {
  callbackBaseUrl: "https://parent.example",
  credentialResolver: { resolverId: "dynamic-credentials-step" },
  kind: "agent/remote",
  sessionId: "session_child",
  url: "https://child.example",
};

describe("subagent executor binding", () => {
  it("round-trips a local child through the durable binding", () => {
    const binding = createSubagentExecutorBinding({ address: localAddress, identity });
    expect(binding.kind).toBe("subagent");
    expect(readSubagentExecutor(binding)).toEqual({ address: localAddress, identity });
  });

  it("reads a structurally valid workflow relay", () => {
    expect(
      readTaskRelay({
        binding: createTaskRelayBinding({
          callId: "call-1",
          hookToken: "relay-hook",
          runId: "relay-run",
          toolName: "research",
        }),
      }),
    ).toEqual({
      callId: "call-1",
      hookToken: "relay-hook",
      runId: "relay-run",
      toolName: "research",
    });
    expect(readTaskRelay({ kind: "subagent-relay", data: { callId: 1 } } as never)).toBeUndefined();
    expect(
      readTaskRelay({
        data: {
          $eveRelay: {
            callId: "call-1",
            hookToken: "relay-hook",
            runId: "relay-run",
            toolName: "research",
          },
        },
        kind: "authored-executor",
      }),
    ).toBeUndefined();
  });

  it("round-trips a remote child through the durable binding", () => {
    const binding = createSubagentExecutorBinding({ address: remoteAddress, identity });
    expect(readSubagentExecutor(binding)).toEqual({ address: remoteAddress, identity });
  });

  it("round-trips an explicit no-credential remote resolver", () => {
    const address: AgentAddress = {
      ...remoteAddress,
      credentialResolver: {},
    };
    const binding = createSubagentExecutorBinding({ address, identity });

    expect(readSubagentExecutor(binding)).toEqual({ address, identity });
  });

  it("reads the binding recorded on task executor state", () => {
    const binding = createSubagentExecutorBinding({ address: localAddress, identity });
    expect(readSubagentExecutor({ binding })).toEqual({ address: localAddress, identity });
  });

  it("derives subagent task metadata from the binding of a generic tool task", () => {
    const executor = createSubagentExecutorBinding({ address: remoteAddress, identity });
    expect(
      readSubagentTaskMetadata({ executor, metadata: { kind: "tool", name: "research" } }),
    ).toEqual({ agentId: identity.id, kind: "subagent", mode: "remote", name: identity.name });
  });

  it("returns undefined for other executor kinds and incomplete addresses", () => {
    expect(readSubagentExecutor(undefined)).toBeUndefined();
    expect(readSubagentExecutor({ data: { exportId: "x" }, kind: "export" })).toBeUndefined();
    expect(
      readSubagentExecutor({
        // A local address without its continuation token cannot route a
        // cancel; the reader rejects it instead of returning a partial value.
        data: {
          address: { kind: "agent/local", sessionId: "session_child" },
          identity: { id: identity.id, name: identity.name, nodeId: identity.nodeId },
        },
        kind: "subagent",
      }),
    ).toBeUndefined();
  });
});
