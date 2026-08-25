import { describe, expect, it } from "vitest";

import type { AgentAddress, AgentIdentity } from "#harness/handles/store.js";
import {
  createSubagentExecutorBinding,
  readSubagentExecutor,
  readSubagentTaskMetadata,
} from "#tasks/types.js";

const identity: AgentIdentity = {
  id: "ag_research:operation1",
  name: "research",
  nodeId: "node_research",
};

const localBackgroundIdentity: AgentIdentity = {
  ...identity,
  execution: "background",
  targetKind: "local",
};

const remoteBackgroundIdentity: AgentIdentity = {
  ...identity,
  execution: "background",
  targetKind: "remote",
};

const localAddress: AgentAddress = {
  continuationToken: "continuation_child",
  kind: "agent/local",
  sessionId: "session_child",
};

const remoteAddress: AgentAddress = {
  callbackBaseUrl: "https://parent.example",
  kind: "agent/remote",
  sessionId: "session_child",
  url: "https://child.example",
};

describe("subagent executor binding", () => {
  it("round-trips a local child through the durable binding", () => {
    const binding = createSubagentExecutorBinding({ address: localAddress, identity });
    expect(binding.kind).toBe("subagent");
    expect(readSubagentExecutor(binding)).toEqual({
      address: localAddress,
      identity: localBackgroundIdentity,
    });
  });

  it("round-trips a remote child through the durable binding", () => {
    const binding = createSubagentExecutorBinding({ address: remoteAddress, identity });
    expect(readSubagentExecutor(binding)).toEqual({
      address: remoteAddress,
      identity: remoteBackgroundIdentity,
    });
  });

  it("reads the binding recorded on task executor state", () => {
    const binding = createSubagentExecutorBinding({ address: localAddress, identity });
    expect(readSubagentExecutor({ binding })).toEqual({
      address: localAddress,
      identity: localBackgroundIdentity,
    });
  });

  it("infers legacy task bindings as background with their stored target kind", () => {
    const legacyBinding = {
      data: {
        address: remoteAddress,
        identity: { id: identity.id, name: identity.name, nodeId: identity.nodeId },
      },
      kind: "subagent" as const,
    };

    expect(readSubagentExecutor(legacyBinding)).toEqual({
      address: remoteAddress,
      identity: remoteBackgroundIdentity,
    });
  });

  it("keeps new binding writes byte-compatible with legacy task bindings", () => {
    expect(
      createSubagentExecutorBinding({
        address: remoteAddress,
        identity: remoteBackgroundIdentity,
      }),
    ).toEqual({
      data: {
        address: remoteAddress,
        identity: { id: identity.id, name: identity.name, nodeId: identity.nodeId },
      },
      kind: "subagent",
    });
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
