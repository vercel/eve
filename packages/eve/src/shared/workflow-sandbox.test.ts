import { asSchema, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createParkingHostTool,
  createWorkflowSandbox,
  installWorkflowSandboxModule,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

const MODULE_KEY = Symbol.for("eve.workflowSandbox.module");
const security = { signingKey: "test" };

class FakeToolError extends Error {
  readonly code = "CODE_MODE_TOOL_ERROR";
}

/** Fake interrupts carry their pending call names directly in the continuation. */
function interruptOf(...pendingNames: string[]): WorkflowSandboxInterrupt {
  const first = pendingNames[0] ?? "none";
  return {
    type: "code-mode-interrupt",
    interruptId: first,
    toolName: first,
    toolCallId: `${first}-call`,
    outerToolCallId: "outer",
    input: {},
    payload: { kind: "test" },
    continuation: {
      version: 2,
      js: "",
      outerToolCallId: "outer",
      toolNames: pendingNames,
      token: "token",
      pendingInterruptions: pendingNames.map((name) => ({
        interruptId: name,
        input: { name },
        payload: { kind: "test", name },
        runInterruptionId: `run-${name}`,
        toolCallId: `${name}-call`,
        toolName: name,
      })),
      resolutions: [],
      auth: { alg: "HMAC-SHA256", nonce: "n", issuedAtMs: 0, expiresAtMs: 1, signature: "s" },
    },
  } as WorkflowSandboxInterrupt;
}

function installFakeModule(overrides: {
  readonly execute?: (input: unknown, options: unknown) => Promise<unknown>;
  readonly continueCodeModeInterrupt?: (input: unknown) => Promise<unknown>;
  readonly description?: string;
}) {
  const requestCodeModeInterrupt = vi.fn((payload: unknown) => {
    throw Object.assign(new Error("parked"), { payload });
  });
  const createCodeModeTool = vi.fn(() => ({
    description: overrides.description ?? "generated description",
    inputSchema: {},
    execute: overrides.execute ?? (async () => undefined),
  }));
  const continueCodeModeInterrupt = vi.fn(
    overrides.continueCodeModeInterrupt ?? (async () => undefined),
  );
  const unwrapCodeModeResult = vi.fn((raw: unknown) => raw);
  installWorkflowSandboxModule({
    CodeModeToolError: FakeToolError,
    continueCodeModeInterrupt,
    createCodeModeTool,
    requestCodeModeInterrupt,
    unwrapCodeModeResult,
  } as never);
  return { continueCodeModeInterrupt, createCodeModeTool, requestCodeModeInterrupt };
}

afterEach(() => {
  (globalThis as Record<symbol, unknown>)[MODULE_KEY] = undefined;
});

describe("createParkingHostTool", () => {
  const tool = createParkingHostTool({
    description: "Lookup",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    interrupt: (toolInput) => ({ kind: "test.call", toolInput, toolName: "lookup" }),
  });
  const execute = (options: unknown) => tool.execute!({ query: "q" } as never, options as never);

  it("exposes the catalog description and schemas", () => {
    expect(tool.description).toBe("Lookup");
    expect(asSchema(tool.inputSchema).jsonSchema).toEqual({ type: "object" });
    expect(asSchema(tool.outputSchema!).jsonSchema).toEqual({ type: "string" });
    expect(
      createParkingHostTool({ description: "d", inputSchema: {}, interrupt: () => ({ kind: "k" }) })
        .outputSchema,
    ).toBeUndefined();
  });

  it("replays a completed resolution as the tool output", async () => {
    installFakeModule({});
    await expect(
      execute({ codeModeInterrupt: { resolution: { status: "completed", output: { hit: 1 } } } }),
    ).resolves.toEqual({ hit: 1 });
  });

  it("rethrows a failed resolution with its message preserved", async () => {
    installFakeModule({});
    const error = await execute({
      codeModeInterrupt: { resolution: { status: "failed", error: "Child failed" } },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(FakeToolError);
    expect(error).toMatchObject({ message: "Child failed" });
  });

  it("requests an interrupt when no resolution is present", async () => {
    const { requestCodeModeInterrupt } = installFakeModule({});
    await expect(execute({ toolCallId: "first" })).rejects.toThrow("parked");
    expect(requestCodeModeInterrupt).toHaveBeenCalledWith({
      kind: "test.call",
      toolInput: { query: "q" },
      toolName: "lookup",
    });
  });
});

describe("createWorkflowSandbox", () => {
  const create = () =>
    createWorkflowSandbox({
      bridgeRequestLimit: 4,
      continuationSecurity: security,
      hostTools: {} as ToolSet,
    });

  it("configures the sandbox tool once and exposes its description", async () => {
    const { createCodeModeTool } = installFakeModule({ description: "Use tools.*" });
    const sandbox = await create();
    expect(sandbox.description).toBe("Use tools.*");
    expect(createCodeModeTool).toHaveBeenCalledWith(
      {},
      {
        continuationSecurity: security,
        executionPolicy: { maxBridgeRequests: 4, maxInFlightBridgeRequests: 4 },
      },
    );
  });

  it("falls back to an empty description", async () => {
    const { createCodeModeTool } = installFakeModule({});
    createCodeModeTool.mockReturnValue({
      inputSchema: {},
      execute: async () => undefined,
    } as never);
    expect((await create()).description).toBe("");
  });

  it("classifies a completed run", async () => {
    const execute = vi.fn(async () => ({ status: "completed", output: 42 }));
    installFakeModule({ execute });
    const sandbox = await create();
    await expect(sandbox.run({ js: "return 42;", toolCallId: "outer" })).resolves.toEqual({
      status: "completed",
      output: 42,
    });
    expect(execute).toHaveBeenCalledWith(
      { js: "return 42;" },
      { messages: [], toolCallId: "outer" },
    );
  });

  it("classifies an interrupted run with its pending calls in order", async () => {
    const interrupt = interruptOf("a", "b");
    installFakeModule({ execute: async () => ({ status: "interrupted", interrupt }) });
    const outcome = await (await create()).run({ js: "", toolCallId: "outer" });
    expect(outcome.status).toBe("interrupted");
    if (outcome.status !== "interrupted") return;
    expect(outcome.interrupt).toBe(interrupt);
    expect(outcome.pending.map((p) => p.toolName)).toEqual(["a", "b"]);
    expect(outcome.pending.map((p) => p.input)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it.each([
    "RUN_USER_SOURCE_ERROR",
    "CODE_MODE_TOOL_ERROR",
    "CODE_MODE_SOURCE_TOO_LARGE",
    "CODE_MODE_BRIDGE_LIMIT",
    "CODE_MODE_DETACHED_BRIDGE_REQUEST",
    "CODE_MODE_SERIALIZATION_ERROR",
  ])("settles %s as a program failure", async (code) => {
    const failure = Object.assign(new Error("Fix the program"), { code });
    installFakeModule({ execute: async () => Promise.reject(failure) });
    await expect((await create()).run({ js: "", toolCallId: "outer" })).resolves.toEqual({
      status: "failed",
      error: "Fix the program",
    });
  });

  it.each([
    Object.assign(new Error("worker failed"), { code: "RUN_ERROR" }),
    Object.assign(new Error("timeout"), { code: "CODE_MODE_TIMEOUT" }),
    new Error("plain"),
    "string failure",
  ])("rethrows infrastructure errors so the step can retry: %s", async (failure) => {
    installFakeModule({ execute: async () => Promise.reject(failure as Error) });
    await expect((await create()).run({ js: "", toolCallId: "outer" })).rejects.toBe(failure);
  });

  it("settles a batch in pending order and classifies the final result", async () => {
    const first = interruptOf("a", "b", "c");
    const afterA = interruptOf("b", "c");
    const afterB = interruptOf("c");
    const continueCodeModeInterrupt = vi
      .fn()
      .mockResolvedValueOnce({ status: "interrupted", interrupt: afterA })
      .mockResolvedValueOnce({ status: "interrupted", interrupt: afterB })
      .mockResolvedValueOnce({ status: "completed", output: "done" });
    installFakeModule({ continueCodeModeInterrupt });
    const resolutions = [
      { status: "completed" as const, output: 1 },
      { status: "failed" as const, error: "b failed" },
      { status: "completed" as const, output: 3 },
    ];
    await expect((await create()).resume({ interrupt: first, resolutions })).resolves.toEqual({
      status: "completed",
      output: "done",
    });
    expect(
      continueCodeModeInterrupt.mock.calls.map(([call]) => ({
        pending: call.interrupt.toolName,
        resolution: call.resolution,
      })),
    ).toEqual([
      { pending: "a", resolution: resolutions[0] },
      { pending: "b", resolution: resolutions[1] },
      { pending: "c", resolution: resolutions[2] },
    ]);
  });

  it("settles a program failure raised while resuming", async () => {
    const failure = Object.assign(new Error("bad program"), { code: "RUN_USER_SOURCE_ERROR" });
    installFakeModule({ continueCodeModeInterrupt: async () => Promise.reject(failure) });
    await expect(
      (await create()).resume({
        interrupt: interruptOf("a"),
        resolutions: [{ status: "completed", output: null }],
      }),
    ).resolves.toEqual({ status: "failed", error: "bad program" });
  });

  it("rejects a resolution count that does not match the parked batch", async () => {
    const { continueCodeModeInterrupt } = installFakeModule({});
    await expect(
      (await create()).resume({
        interrupt: interruptOf("a", "b"),
        resolutions: [{ status: "completed", output: null }],
      }),
    ).rejects.toThrow("Workflow sandbox resumed with 1 resolutions for 2 pending calls.");
    expect(continueCodeModeInterrupt).not.toHaveBeenCalled();
  });

  it("rejects a resume whose program completed before the batch was settled", async () => {
    installFakeModule({
      continueCodeModeInterrupt: async () => ({ status: "completed", output: "early" }),
    });
    await expect(
      (await create()).resume({
        interrupt: interruptOf("a", "b"),
        resolutions: [
          { status: "completed", output: 1 },
          { status: "completed", output: 2 },
        ],
      }),
    ).rejects.toThrow("Workflow sandbox resumed before every parked call was resolved.");
  });
});
