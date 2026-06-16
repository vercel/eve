import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import { applySandboxToolSet, buildSandboxHostTools } from "#harness/code-mode.js";
import { CODE_MODE_SURFACE, WORKFLOW_SURFACE } from "#harness/sandbox-surface.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { LiveStepToolsKey } from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessToolMap } from "#harness/types.js";
import { isCodeModeEnvEnabled, resolveCodeModeEnabled } from "#shared/code-mode.js";

describe("resolveCodeModeEnabled", () => {
  it("reads the EVE_EXPERIMENTAL_CODE_MODE backstop", () => {
    expect(isCodeModeEnvEnabled({ EVE_EXPERIMENTAL_CODE_MODE: "1" })).toBe(true);
    expect(isCodeModeEnvEnabled({ EVE_EXPERIMENTAL_CODE_MODE: "true" })).toBe(false);
    expect(isCodeModeEnvEnabled({ EVE_EXPERIMENTAL_CODE_MODE: "0" })).toBe(false);
    expect(isCodeModeEnvEnabled({})).toBe(false);
  });

  it("prefers the authored flag over the env backstop", () => {
    expect(resolveCodeModeEnabled(true, { EVE_EXPERIMENTAL_CODE_MODE: "0" })).toBe(true);
    expect(resolveCodeModeEnabled(false, { EVE_EXPERIMENTAL_CODE_MODE: "1" })).toBe(false);
    expect(resolveCodeModeEnabled(undefined, { EVE_EXPERIMENTAL_CODE_MODE: "1" })).toBe(true);
    expect(resolveCodeModeEnabled(undefined, {})).toBe(false);
  });
});

describe("applySandboxToolSet", () => {
  it("moves every executable tool behind code_mode", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "bash",
        {
          description: "Run a shell command.",
          execute: async () => "ok",
          inputSchema: jsonSchema({ type: "object" }),
          name: "bash",
        },
      ],
      [
        "connection_search",
        {
          description: "Search connections.",
          execute: async () => [],
          inputSchema: jsonSchema({ type: "object" }),
          name: "connection_search",
        },
      ],
      [
        "read_file",
        {
          description: "Read a workspace file.",
          execute: async () => "contents",
          inputSchema: jsonSchema({ type: "object" }),
          name: "read_file",
        },
      ],
      [
        "write_file",
        {
          description: "Write a workspace file.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "write_file",
        },
      ],
      [
        "echo",
        {
          description: "Echo.",
          execute: async () => "echo",
          inputSchema: jsonSchema({ type: "object" }),
          name: "echo",
        },
      ],
    ]);

    const flatTools = buildToolSet({ capabilities: { requestInput: true }, tools: harnessTools });
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [CODE_MODE_SURFACE],
    });

    expect(modelTools.bash).toBeUndefined();
    expect(modelTools.connection_search).toBeUndefined();
    expect(modelTools.read_file).toBeUndefined();
    expect(modelTools.write_file).toBeUndefined();
    expect(modelTools.echo).toBeUndefined();
    expect(modelTools.code_mode).toBeDefined();
    expect(hostTools.bash).toBeDefined();
    expect(hostTools.connection_search).toBeDefined();
    expect(hostTools.read_file).toBeDefined();
    expect(hostTools.write_file).toBeDefined();
    expect(hostTools.echo).toBeDefined();
  });

  it("never sandboxes load_skill — it stays a direct model tool", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "load_skill",
        {
          description: "Load a skill into the session.",
          execute: async () => "ok",
          inputSchema: jsonSchema({ type: "object" }),
          name: "load_skill",
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

    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [CODE_MODE_SURFACE],
    });

    // load_skill is directly callable and never enters the sandbox.
    expect(modelTools.load_skill).toBeDefined();
    expect(hostTools.load_skill).toBeUndefined();
    // ordinary executable tools are still sandboxed.
    expect(hostTools.bash).toBeDefined();
    expect(modelTools.bash).toBeUndefined();
    expect(modelTools.code_mode).toBeDefined();
  });

  it("returns raw nested host tool output inside code mode", async () => {
    const rawOutput = { secret: "hidden", summary: "visible" };
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "report",
        {
          description: "Build report.",
          execute: async () => rawOutput,
          inputSchema: jsonSchema({ type: "object" }),
          name: "report",
          toModelOutput: () => ({ type: "text", value: "visible" }),
        },
      ],
    ]);

    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [CODE_MODE_SURFACE],
    });
    const reportTool = hostTools.report as {
      execute?: (input: unknown, options: unknown) => Promise<unknown>;
    };

    await expect(reportTool.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toBe(
      rawOutput,
    );
  });

  it("keeps provider-managed tools direct when they have no executor", async () => {
    const harnessTools: HarnessToolMap = new Map();
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: {
        web_search: tool({
          description: "Provider search.",
          inputSchema: jsonSchema({ type: "object" }),
        }),
      },
      surfaces: [CODE_MODE_SURFACE],
    });

    expect(modelTools.web_search).toBeDefined();
    expect(modelTools.code_mode).toBeUndefined();
    expect(hostTools.web_search).toBeUndefined();
  });

  it("wraps host tools context-transparently (the package owns the worker context seam)", async () => {
    // Code mode bridges host-tool calls back from a pooled worker_thread whose
    // `message` callback Node binds to the invocation that first created the
    // worker. experimental-ai-sdk-code-mode >= 1.0.11 re-enters the originating
    // invocation's AsyncLocalStorage context before dispatching host callbacks,
    // so eve no longer re-pins context in the wrapper. The wrapper must stay
    // transparent: it observes whatever context the caller provides, never a
    // context captured at build time. The cross-invocation worker guarantee is
    // covered by the package's own regression test.
    const SessionMarkerKey = new ContextKey<string>("test.code-mode.session-marker");

    const buildSession = new ContextContainer();
    buildSession.set(SessionMarkerKey, "build-session");
    const callSession = new ContextContainer();
    callSession.set(SessionMarkerKey, "call-session");

    let observedSession: string | undefined;
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "read_state",
        {
          description: "Read the active session marker.",
          execute: async () => {
            observedSession = contextStorage.getStore()?.get(SessionMarkerKey);
            return observedSession;
          },
          inputSchema: jsonSchema({ type: "object" }),
          name: "read_state",
        },
      ],
    ]);

    // Host tools are built inside the build session's scope.
    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools } = await contextStorage.run(buildSession, async () =>
      applySandboxToolSet({ harnessTools, tools: flatTools, surfaces: [CODE_MODE_SURFACE] }),
    );
    const readStateTool = hostTools.read_state as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };

    // Invoked while a different context is ambient: the wrapper passes it
    // through untouched instead of restoring the build-time context.
    const result = await contextStorage.run(callSession, async () =>
      readStateTool.execute({}, { messages: [], toolCallId: "call_1" }),
    );

    expect(observedSession).toBe("call-session");
    expect(result).toBe("call-session");
  });

  it("wraps host tool approval checks context-transparently", async () => {
    // needsApproval, like execute, must observe the caller's context. The
    // package re-enters the originating invocation's context at the worker
    // bridge (experimental-ai-sdk-code-mode >= 1.0.11), so the wrapper does not
    // re-pin it to the build-time context.
    const SessionMarkerKey = new ContextKey<string>("test.code-mode.approval-session-marker");

    const buildSession = new ContextContainer();
    buildSession.set(SessionMarkerKey, "build-session");
    const callSession = new ContextContainer();
    callSession.set(SessionMarkerKey, "call-session");

    let observedSession: string | undefined;
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "guarded",
        {
          description: "Requires approval.",
          execute: async () => "ok",
          inputSchema: jsonSchema({ type: "object" }),
          name: "guarded",
          needsApproval: () => {
            observedSession = contextStorage.getStore()?.get(SessionMarkerKey);
            return true;
          },
        },
      ],
    ]);

    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools } = await contextStorage.run(buildSession, async () =>
      applySandboxToolSet({ harnessTools, tools: flatTools, surfaces: [CODE_MODE_SURFACE] }),
    );
    const guardedTool = hostTools.guarded as {
      needsApproval: (input: unknown, options: unknown) => Promise<boolean> | boolean;
    };

    const result = await contextStorage.run(callSession, async () =>
      guardedTool.needsApproval({}, { messages: [], toolCallId: "call_1" }),
    );

    expect(observedSession).toBe("call-session");
    expect(result).toBe(true);
  });

  it("preserves dynamic tool approval gates in sandbox host tools", async () => {
    const needsApproval = () => true;
    const ctx = new ContextContainer();
    ctx.setVirtualContext(LiveStepToolsKey, [
      {
        description: "Requires approval.",
        execute: async () => "ok",
        inputSchema: jsonSchema({ type: "object" }),
        name: "connection__tfl__getLineStatus",
        needsApproval,
      },
    ]);

    const hostTools = await contextStorage.run(ctx, () =>
      buildSandboxHostTools({ tools: new Map() }),
    );
    const guardedTool = hostTools.connection__tfl__getLineStatus as {
      needsApproval?: (input: unknown) => Promise<boolean> | boolean;
    };

    await expect(guardedTool.needsApproval?.({ line: "victoria" })).resolves.toBe(true);
  });

  it("dual-routes runtime action tools to both modelTools and hostTools", async () => {
    const harnessTools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
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

    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [CODE_MODE_SURFACE],
    });

    expect(modelTools.researcher).toBeDefined();
    expect(modelTools.remote_reviewer).toBeDefined();
    expect(modelTools.bash).toBeUndefined();
    expect(modelTools.code_mode).toBeDefined();
    expect(hostTools.researcher).toBeDefined();
    expect(hostTools.researcher!.execute).toBeDefined();
    expect(hostTools.remote_reviewer).toBeDefined();
    expect(hostTools.remote_reviewer!.execute).toBeDefined();
    expect(hostTools.bash).toBeDefined();
  });
});

describe("applySandboxToolSet — Workflow partition", () => {
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

  it("sandboxes only subagent/remote tools and leaves other tools direct", async () => {
    const harnessTools = orchestrationTools();
    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [WORKFLOW_SURFACE],
    });

    // The Workflow sandbox is emitted; code_mode is not (code mode is off).
    expect(modelTools.Workflow).toBeDefined();
    expect(modelTools.code_mode).toBeUndefined();
    // Agents stay directly callable AND enter the Workflow sandbox.
    expect(modelTools.researcher).toBeDefined();
    expect(modelTools.remote_reviewer).toBeDefined();
    expect(hostTools.researcher).toBeDefined();
    expect(hostTools.remote_reviewer).toBeDefined();
    // bash is never sandboxed by Workflow: it stays a direct model tool.
    expect(modelTools.bash).toBeDefined();
    expect(hostTools.bash).toBeUndefined();
  });

  it("describes the Workflow tool as an agents-only orchestrator", async () => {
    const harnessTools = orchestrationTools();
    const flatTools = buildToolSet({ tools: harnessTools });
    const { modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [WORKFLOW_SURFACE],
    });

    const description = (modelTools.Workflow as { description?: string }).description ?? "";
    expect(description).toContain("Orchestrate this agent's subagents");
    expect(description).toContain("Promise.all");
  });

  it("keeps agents in both sandboxes and other host tools only in code_mode when both are enabled", async () => {
    const harnessTools = orchestrationTools();
    const flatTools = buildToolSet({ tools: harnessTools });
    const { hostTools, modelTools } = await applySandboxToolSet({
      harnessTools,
      tools: flatTools,
      surfaces: [WORKFLOW_SURFACE, CODE_MODE_SURFACE],
    });

    expect(modelTools.Workflow).toBeDefined();
    expect(modelTools.code_mode).toBeDefined();
    // bash is sandboxed by code mode (not directly callable).
    expect(modelTools.bash).toBeUndefined();
    expect(hostTools.researcher).toBeDefined();
    expect(hostTools.remote_reviewer).toBeDefined();
    expect(hostTools.bash).toBeDefined();

    const workflowDescription = (modelTools.Workflow as { description?: string }).description ?? "";
    const codeModeDescription =
      (modelTools.code_mode as { description?: string }).description ?? "";
    // Agents are callable from BOTH sandboxes; code mode is the full surface
    // (agents + host tools), Workflow is agents-only.
    expect(workflowDescription).toContain("researcher");
    expect(codeModeDescription).toContain("researcher");
    expect(codeModeDescription).toContain("bash");
    expect(workflowDescription).not.toContain("bash");
  });
});
