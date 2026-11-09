import { describe, expect, it } from "vitest";

import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";

const source = { kind: "bundled" } as const;
const sandboxRegistry = { sandbox: { definition: { kind: "independent" } } };
const rootUsage = () => true;

/** A compiled node bundle with only what the port reads. */
function bundle(input: {
  readonly connections?: readonly unknown[];
  readonly definitions?: readonly { readonly kind: string }[];
  readonly nodeId?: string;
}): CompiledBundle {
  const agent = {
    config: {
      compaction: { thresholdPercent: 0.8 },
      experimental: { workflow: { modelCallsPerStep: 3, retention: 0 } },
      limits: { sessionTimeoutMs: 60_000 },
      name: "Researcher",
    },
    connections: input.connections ?? [],
    definitions: input.definitions ?? [],
  };
  return {
    adapterRegistry: { channels: [] },
    compiledArtifactsSource: source,
    graph: {
      nodesByNodeId: new Map([
        [
          ROOT_RUNTIME_AGENT_NODE_ID,
          { agent: { config: { limits: { sessionUsage: rootUsage } } } },
        ],
      ]),
      root: { agent, sandboxRegistry },
    },
    nodeId: input.nodeId,
    resolvedAgent: agent,
    turnAgent: {
      compactionModel: { id: "openai/gpt-5.4-mini" },
      id: "researcher",
      reasoning: "low",
    },
  } as never;
}

describe("fromCompiledBundle", () => {
  it("names the node the bundle is for, and carries it by its artifacts", () => {
    const node = fromCompiledBundle(bundle({ nodeId: "subagents/researcher" }));
    expect(node).toMatchObject({ id: "researcher", name: "Researcher" });
    expect(node.reference).toEqual({ kind: "bundle", nodeId: "subagents/researcher", source });
    expect(runtimeNodeId(node)).toBe("subagents/researcher");

    const root = fromCompiledBundle(bundle({}));
    expect(root.nodeId).toBeUndefined();
    expect(runtimeNodeId(root)).toBe(ROOT_RUNTIME_AGENT_NODE_ID);
  });

  it("reads agent.ts's settings, with the root's session usage limit as the fallback", () => {
    expect(fromCompiledBundle(bundle({})).settings).toEqual({
      compaction: { model: { id: "openai/gpt-5.4-mini" }, thresholdPercent: 0.8 },
      limits: { sessionTimeoutMs: 60_000, sessionUsage: rootUsage },
      modelCallsPerStep: 3,
      reasoning: "low",
      retention: 0,
    });
  });

  it("opens the node's sandbox from the build's artifacts, shared with its parent as its graph says", async () => {
    await expect(fromCompiledBundle(bundle({})).sandbox()).resolves.toEqual({
      registry: sandboxRegistry,
      sharesParent: true,
      template: { compiledArtifactsSource: source },
    });
  });

  it("starts sessions with a connection registry only when the node has or adds connections", () => {
    expect(fromCompiledBundle(bundle({})).connections()).toBeUndefined();
    const declared = [{ connectionName: "linear" }];
    expect(fromCompiledBundle(bundle({ connections: declared })).connections()).toBe(declared);
    expect(
      fromCompiledBundle(bundle({ definitions: [{ kind: "connection" }] })).connections(),
    ).toEqual([]);
  });

  it("is one agent per bundle", () => {
    const compiled = bundle({});
    expect(fromCompiledBundle(compiled)).toBe(fromCompiledBundle(compiled));
    expect(fromCompiledBundle(compiled).compiled).toBe(compiled);
  });
});
