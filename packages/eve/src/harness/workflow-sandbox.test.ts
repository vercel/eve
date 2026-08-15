import { asSchema, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  applyWorkflowTool,
  buildWorkflowHostTools,
  resolveWorkflowSandboxBridgeRequestLimit,
} from "#harness/workflow-sandbox.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";

const continuationSecurity = { signingKey: "workflow-sandbox-test-key" };

function orchestrationTools(): HarnessToolMap {
  return new Map<string, HarnessToolDefinition>([
    [
      "researcher",
      {
        description: "Delegate to the researcher subagent.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      },
    ],
    [
      "remote_reviewer",
      {
        description: "Delegate to the remote reviewer.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "remote_reviewer",
        runtimeAction: {
          kind: "remote-agent-call",
          nodeId: "subagents/remote-reviewer.ts",
          remoteAgentName: "remote_reviewer",
          subagentName: "remote_reviewer",
        },
      },
    ],
    [
      "bash",
      {
        description: "Run a shell command.",
        execute: async () => "ok",
        inputSchema: jsonSchema({ type: "object" }),
        name: "bash",
      },
    ],
  ]);
}

describe("applyWorkflowTool", () => {
  it("keeps sandbox bridge capacity above the configured dispatch budget", () => {
    expect(resolveWorkflowSandboxBridgeRequestLimit()).toBe(256);
    expect(resolveWorkflowSandboxBridgeRequestLimit(100)).toBe(256);
    expect(resolveWorkflowSandboxBridgeRequestLimit(255)).toBe(256);
    expect(resolveWorkflowSandboxBridgeRequestLimit(256)).toBe(257);
    expect(resolveWorkflowSandboxBridgeRequestLimit(300)).toBe(301);
  });

  it("adds only agent runtime actions to the sandbox", async () => {
    const harnessTools = orchestrationTools();
    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools,
      tools: flatTools,
    });

    expect(modelTools.Workflow).toBeDefined();
    expect(modelTools.researcher).toBeDefined();
    expect(modelTools.remote_reviewer).toBeDefined();
    expect(modelTools.bash).toBeDefined();
    expect(hostTools.researcher?.execute).toBeDefined();
    expect(hostTools.remote_reviewer?.execute).toBeDefined();
    expect(hostTools.bash).toBeUndefined();
  });

  it("describes Workflow as an agents-only orchestrator", async () => {
    const harnessTools = orchestrationTools();
    const { modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools,
      tools: buildToolSet({ tools: harnessTools }),
    });

    const description = (modelTools.Workflow as { description?: string }).description ?? "";
    expect(description).toContain("Use `Workflow` for:");
    expect(description).toContain("Do not use `Workflow` when:");
    expect(description).toContain("Promise.all");
    expect(description).toContain("researcher");
    expect(description).toContain("Available agent API:");
    expect(description).not.toContain("bash");
    expect(description).not.toContain("code-mode");

    const inputSchema = asSchema(modelTools.Workflow?.inputSchema).jsonSchema;
    expect(inputSchema).toMatchObject({
      properties: {
        js: { description: expect.stringContaining("JavaScript orchestration program") },
      },
    });
  });

  it("does not add Workflow when no agent runtime actions exist", async () => {
    const harnessTools: HarnessToolMap = new Map([
      [
        "bash",
        {
          description: "Run a shell command.",
          execute: async () => "ok",
          inputSchema: jsonSchema({ type: "object" }),
          name: "bash",
        },
      ],
    ]);
    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applyWorkflowTool({
      continuationSecurity,
      harnessTools,
      tools: flatTools,
    });

    expect(modelTools.Workflow).toBeUndefined();
    expect(modelTools.bash).toBeDefined();
    expect(hostTools).toEqual({});
  });

  it("rebuilds only workflow agent host tools for continuation", () => {
    const hostTools = buildWorkflowHostTools({ tools: orchestrationTools() });

    expect(hostTools.researcher).toBeDefined();
    expect(hostTools.remote_reviewer).toBeDefined();
    expect(hostTools.bash).toBeUndefined();
  });

  it("does not construct ordinary tools while rebuilding the continuation surface", () => {
    const tools: HarnessToolMap = new Map([
      [
        "bash",
        {
          description: "Run a shell command.",
          execute: async () => "ok",
          get inputSchema(): never {
            throw new Error("ordinary tool schema should not be read");
          },
          name: "bash",
        },
      ],
    ]);

    expect(buildWorkflowHostTools({ tools })).toEqual({});
  });
});
