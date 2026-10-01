import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadContext } from "#context/container.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, ToolStubSetKey } from "#context/keys.js";
import {
  runAgentStub,
  runWorkflowToolStub,
  selectToolStubSet,
  takeToolStubTurnFailure,
} from "#execution/tool-stubs.js";
import { isTurnFailingToolError } from "#harness/tool-turn-failure.js";
import {
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_TOOL_STUBS_DIR_ENV,
} from "#internal/application/dev-environment.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import { noReply } from "#tools/provided/no-reply.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

// Stub files carry the `defineToolStubs()` brand directly, so they load from a
// temporary app root that cannot resolve `eve/evals`.
const LEDGER_SET = `
export default {
  _tag: "EveToolStubs",
  state: () => ({ entries: ["seeded"] }),
  tools: {
    record_entry: (input, ctx) => {
      ctx.state.entries.push(input.entry);
      return { entries: [...ctx.state.entries], toolName: ctx.toolName };
    },
    list_entries: (_input, ctx) => ({ entries: [...ctx.state.entries] }),
  },
};
`;

const createAppRoot = useTemporaryAppRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

async function useEvalStubs(files: Readonly<Record<string, string>>): Promise<void> {
  const { appRoot } = await createAppRoot("eve-tool-stubs-", { files });
  vi.stubEnv(EVE_EVALUATION_ENV_FLAG, "1");
  vi.stubEnv(EVE_EVALUATION_TOOL_STUBS_DIR_ENV, join(appRoot, "evals", "stubs"));
}

describe("selectToolStubSet", () => {
  it("rejects stubs on a server that eve eval did not start", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    vi.stubEnv(EVE_EVALUATION_ENV_FLAG, "");

    const selection = await selectToolStubSet("ledger");

    expect(selection).toEqual({
      ok: false,
      error: expect.stringContaining("accepted only by the local server that `eve eval` starts"),
    });
  });

  it("lists the sets it found when the name is unknown", async () => {
    await useEvalStubs({
      "evals/stubs/ledger.ts": LEDGER_SET,
      "evals/stubs/nested/empty.ts": `export default { _tag: "EveToolStubs", tools: {} };`,
    });

    const selection = await selectToolStubSet("ledgr");

    expect(selection).toEqual({
      ok: false,
      error: 'Unknown tool stub set "ledgr". Sets in evals/stubs/: ledger, nested/empty.',
    });
  });

  it("rejects a set whose default export is not a stub set", async () => {
    await useEvalStubs({ "evals/stubs/broken.ts": "export default { tools: {} };" });

    const selection = await selectToolStubSet("broken");

    expect(selection).toEqual({
      ok: false,
      error: expect.stringContaining("must default-export defineToolStubs"),
    });
  });

  it("accepts a set that loads", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    expect(await selectToolStubSet("ledger")).toEqual({ ok: true, set: "ledger" });
  });
});

describe("stubbed tool execution", () => {
  const realRecord = vi.fn(() => ({ real: true }));
  const realList = vi.fn(() => ({ real: true }));
  const realUnstubbed = vi.fn(() => ({ real: true }));

  async function createRuntime() {
    realRecord.mockClear();
    realList.mockClear();
    realUnstubbed.mockClear();
    return await createTestRuntime({
      tools: [
        mockTool({ name: "record_entry", execute: realRecord }),
        mockTool({ name: "list_entries", execute: realList }),
        mockTool({ name: "unstubbed_tool", execute: realUnstubbed }),
      ],
    });
  }

  it("runs the real tool in a session without a stub set", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const output = await runtime.runAsSession({ sessionId: "session_unstubbed" }, () =>
      runtime.executeTool("record_entry", { entry: "a" }),
    );

    expect(output).toEqual({ real: true });
    expect(realRecord).toHaveBeenCalledTimes(1);
  });

  it("runs the stub in place of the real tool and keeps state across calls", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const outputs = await runtime.runAsSession({ sessionId: "session_ledger_calls" }, async () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return [
        await runtime.executeTool("record_entry", { entry: "first" }),
        await runtime.executeTool("list_entries", {}),
      ];
    });

    expect(outputs).toEqual([
      { entries: ["seeded", "first"], toolName: "record_entry" },
      { entries: ["seeded", "first"] },
    ]);
    expect(realRecord).not.toHaveBeenCalled();
    expect(realList).not.toHaveBeenCalled();
  });

  it("fails the turn without running the real tool when the set has no stub", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const failure = await runtime
      .runAsSession({ sessionId: "session_missing_stub" }, () => {
        loadContext().set(ToolStubSetKey, "ledger");
        return runtime.executeTool("unstubbed_tool", {});
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isTurnFailingToolError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "TOOL_STUB_MISSING",
      message: expect.stringContaining('Tool stub set "ledger" has no stub for "unstubbed_tool"'),
    });
    expect(realUnstubbed).not.toHaveBeenCalled();
  });

  it("runs framework tools as usual in a stubbed session", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const outcome = await runtime
      .runAsSession({ sessionId: "session_framework_tool" }, () => {
        loadContext().set(ToolStubSetKey, "ledger");
        return runtime.executeTool("load_skill", { name: "no-such-skill" });
      })
      .then(
        (output: unknown) => ({ output }),
        (error: unknown) => ({ error }),
      );

    expect("error" in outcome && isTurnFailingToolError(outcome.error)).toBe(false);
  });

  it("runs eve-provided tools that the app mounts as usual in a stubbed session", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createTestRuntime({
      modules: [
        { logicalPath: "tools/no_reply.ts", loadNamespace: async () => ({ default: noReply() }) },
      ],
    });

    const output = await runtime.runAsSession({ sessionId: "session_provided_tool" }, () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return runtime.executeTool("no_reply", {});
    });

    expect(output).toBe("No reply was sent.");
  });

  it("shares one state between a root session and its subagents", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    await runtime.runAsSession({ sessionId: "session_root_shared" }, async () => {
      loadContext().set(ToolStubSetKey, "ledger");
      await runtime.executeTool("record_entry", { entry: "from-root" });
    });
    const childOutput = await runtime.runAsSession(
      {
        parent: {
          callId: "call_parent",
          rootSessionId: "session_root_shared",
          sessionId: "session_root_shared",
          turn: { id: "turn_parent", sequence: 1 },
        },
        sessionId: "session_child_shared",
      },
      async () => {
        loadContext().set(ToolStubSetKey, "ledger");
        await runtime.executeTool("record_entry", { entry: "from-child" });
        return await runtime.executeTool("list_entries", {});
      },
    );
    const rootOutput = await runtime.runAsSession({ sessionId: "session_root_shared" }, () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return runtime.executeTool("list_entries", {});
    });

    expect(childOutput).toEqual({ entries: ["seeded", "from-root", "from-child"] });
    expect(rootOutput).toEqual({ entries: ["seeded", "from-root", "from-child"] });
  });
});

describe("stubs outside a model step", () => {
  function takeFailure(sessionId: string) {
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, sessionId);
    ctx.set(ToolStubSetKey, "ledger");
    return contextStorage.run(ctx, () => takeToolStubTurnFailure());
  }

  it("answers a workflow tool call with its stub", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    const run = await runWorkflowToolStub({
      callId: "call_workflow",
      entryPoint: "execute",
      input: { entry: "from-workflow" },
      session: { id: "session_workflow", rootId: "session_workflow" },
      set: "ledger",
      toolName: "record_entry",
    });

    expect(run).toEqual({
      kind: "output",
      output: { entries: ["seeded", "from-workflow"], toolName: "record_entry" },
    });
    expect(takeFailure("session_workflow")).toBeUndefined();
  });

  it("fails the session's next step when a workflow tool has no stub", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    const run = await runWorkflowToolStub({
      callId: "call_workflow_missing",
      entryPoint: "execute",
      input: {},
      session: { id: "session_workflow_missing", rootId: "session_workflow_missing" },
      set: "ledger",
      toolName: "send_invoice",
    });

    expect(run).toMatchObject({ kind: "error", message: expect.stringContaining("send_invoice") });
    expect(takeFailure("session_workflow_missing")).toMatchObject({ code: "TOOL_STUB_MISSING" });
    expect(takeFailure("session_workflow_missing")).toBeUndefined();
  });

  it("fails closed for a workflow tool call that starts a task", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    const run = await runWorkflowToolStub({
      callId: "call_workflow_task",
      entryPoint: "task",
      input: {},
      session: { id: "session_workflow_task", rootId: "session_workflow_task" },
      set: "ledger",
      toolName: "record_entry",
    });

    expect(run.kind).toBe("error");
    expect(takeFailure("session_workflow_task")).toMatchObject({ code: "TOOL_STUB_UNSUPPORTED" });
  });

  it("answers a remote agent's message with the stub keyed by the agent's name", async () => {
    await useEvalStubs({
      "evals/stubs/agents.ts": `export default {
        _tag: "EveToolStubs",
        tools: { researcher: (input) => "Researched: " + input.message },
      };`,
    });

    const run = await runAgentStub({
      callId: "call_agent",
      message: "Find Alice's order.",
      name: "researcher",
      session: { id: "session_agent", rootId: "session_agent" },
      set: "agents",
    });

    expect(run).toEqual({ kind: "output", output: "Researched: Find Alice's order." });
  });

  it("fails the root session's next step when a subagent's tool has no stub", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    await runWorkflowToolStub({
      callId: "call_child_missing",
      entryPoint: "execute",
      input: {},
      session: { id: "session_child_missing", rootId: "session_root_of_child" },
      set: "ledger",
      toolName: "send_invoice",
    });

    expect(takeFailure("session_root_of_child")).toMatchObject({ code: "TOOL_STUB_MISSING" });
  });
});
