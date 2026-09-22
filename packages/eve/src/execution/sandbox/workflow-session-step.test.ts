import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowSandboxAccess } from "#execution/sandbox/workflow-session-step.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { WorkflowSandboxReferenceData } from "#execution/sandbox/workflow-reference.js";

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), bundle: vi.fn(), request: vi.fn() }));
vi.mock("#execution/sandbox/ensure.js", () => ({ ensureSandboxAccess: mocks.ensure }));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.bundle,
}));
vi.mock("#execution/sandbox/workflow-request.js", () => ({
  requestWorkflowSandbox: mocks.request,
}));

const reference: WorkflowSandboxReferenceData = {
  compiledArtifactsSource: { kind: "bundled" },
  nodeId: "root",
  sessionId: "parent-session",
  state: { session: null },
};
const run = {
  owner: { inbox: "owner-inbox" },
  from: {
    callId: "call-1",
    execution: "blocking" as const,
    input: {},
    runId: "run-1",
    sequence: 0,
    stepIndex: 0,
    toolName: "probe",
    turnId: "turn-1",
  },
};
const registry = { sandbox: null };

function createAccess() {
  return createWorkflowSandboxAccess({ run, abortSignal: new AbortController().signal });
}

describe("workflow sandbox access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bundle.mockResolvedValue({ graph: { root: { sandboxRegistry: registry } } });
    mocks.request.mockResolvedValue(reference);
  });

  it("opens lazily and shares access between concurrent callers in one step", async () => {
    const sandbox = mockSandbox();
    mocks.ensure.mockResolvedValue(sandbox.access);
    const access = createAccess();
    expect(mocks.request).not.toHaveBeenCalled();
    await access.captureState();
    expect(mocks.request).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([access.get(), access.get()]);
    expect(first).toBe(sandbox.session);
    expect(second).toBe(first);
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith({
      ...reference,
      ownsSandbox: false,
      registry,
    });
  });

  it("reconstructs access from the owner's state for a new step context", async () => {
    const sandbox = mockSandbox();
    mocks.ensure.mockImplementation(async () => ({ ...sandbox.access }));
    const first = createAccess();
    const second = createAccess();
    expect(first).not.toBe(second);
    expect(await first.get()).toBe(await second.get());
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.ensure.mock.calls) expect(input.state).toBe(reference.state);
  });

  it("leaves sandbox lifecycle mutations with the owning session", async () => {
    const access = createAccess();
    await expect(access.stop()).rejects.toThrow("session owns its lifecycle");
    await expect(access.delete!()).rejects.toThrow("not available");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
