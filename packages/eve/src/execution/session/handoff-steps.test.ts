import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { IncompatibleStateLayoutError } from "#context/serialize.js";
import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import {
  prepareSuccessorStep,
  signalSessionOwnerActivationStep,
  startSuccessorStep,
  stopUntrackedChildSessionsStep,
  type SuccessorStartInput,
} from "#execution/session/handoff-steps.js";
import { positionState } from "#internal/testing/session-machine.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { DefaultSandbox } from "#sandbox/providers/default.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";

const deserializeContextMock = vi.fn();
const readDurableSessionMock = vi.fn();
const cancelRunMock = vi.fn();
const setAttributesMock = vi.fn();
const getWorldMock = vi.fn(async () => ({}));
const getRunMock = vi.fn();
const resumeHookMock = vi.fn();
const getHookByTokenMock = vi.fn();
const startWorkflowOnDeploymentMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  setAttributes: (...args: unknown[]) => setAttributesMock(...args),
}));

vi.mock("#context/serialize.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deserializeContext: (...args: unknown[]) => deserializeContextMock(...args),
}));
vi.mock("#execution/durable-session-read.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getRun: (...args: unknown[]) => getRunMock(...args),
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getWorld: () => getWorldMock(),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  startWorkflowOnDeployment: (...args: unknown[]) => startWorkflowOnDeploymentMock(...args),
}));

const SOURCE_TOKENS = ["eve:session:session-1", "channel:alias"];

describe("prepareSuccessorStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the target bundle and durable state, then records this owner", async () => {
    const require = vi.fn();
    deserializeContextMock.mockResolvedValue({ require });
    readDurableSessionMock.mockReturnValue({});
    const checkpoint = createCheckpoint();

    await expect(validate(checkpoint)).resolves.toEqual({ kind: "valid" });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
    expect(setAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({ "$eve.session": "session-1" }),
      { allowReservedAttributes: true },
    );
  });

  it.each([
    ["every address is still the source's", ["run-a", "run-a"], "valid"],
    ["another run now holds an alias", ["run-a", "run-other"], "source-gone"],
    ["an address is no longer held", ["run-a", undefined], "source-gone"],
  ] as const)("checks the source still holds its addresses: %s", async (_name, holders, kind) => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({});
    getHookByTokenMock.mockImplementation(async (token: string) => {
      const runId = holders[token.includes("channel:alias") ? 1 : 0];
      if (runId === undefined) throw new HookNotFoundError(token);
      return { runId };
    });

    await expect(
      prepareSuccessorStep({
        handoffVersion: 3,
        migration: { kind: "current", checkpoint: createCheckpoint(), childRunIdsToStop: [] },
        sessionId: "session-1",
        source: { hookTokens: SOURCE_TOKENS, runId: "run-a" },
      }),
    ).resolves.toEqual({ kind });
    expect(getHookByTokenMock.mock.calls.map(([token]) => token)).toEqual(
      SOURCE_TOKENS.map(sessionInboxHookToken),
    );
    // Ingress reads the recorded owner version, so only a successor that will claim records it.
    expect(setAttributesMock).toHaveBeenCalledTimes(kind === "valid" ? 1 : 0);
  });

  it("ignores a sandbox record saved before the provider redesign", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      sandboxState: {
        initialized: true,
        session: { backendName: "vercel", sessionKey: "old", metadata: {} },
      },
    });

    await expect(validate(createCheckpoint())).resolves.toEqual({ kind: "valid" });
  });

  it("accepts a sandbox record DefaultSandbox saved under the provider it picked", async () => {
    const environment = DefaultSandbox.environment();
    deserializeContextMock.mockResolvedValue({
      require: () => ({
        graph: {
          root: {
            sandboxRegistry: { sandbox: { definition: { environment, kind: "independent" } } },
          },
        },
        nodeId: "__root__",
      }),
    });
    readDurableSessionMock.mockReturnValue({
      sandboxState: {
        session: {
          providerName: "vercel",
          state: { sandboxName: "eve-sbx-vercel-old", version: 3 },
          stateProtocolVersion: 1,
        },
      },
    });

    await expect(validate(createCheckpoint())).resolves.toEqual({ kind: "valid" });
  });

  it("rejects an incompatible workflow tool run with the current checkpoint version", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      state: {
        "eve.workflowTool": {
          version: 4,
          runs: [
            {
              callId: "call",
              toolName: "research",
              origin: { turnId: "turn", stepIndex: 0 },
              address: { runId: "run", hookToken: 42 },
            },
          ],
        },
      },
    });
    await expect(validate(createCheckpoint())).rejects.toThrow(
      "Corrupt workflow tool run registry",
    );
  });

  it("reports a checkpoint that could not be upgraded without reading it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detail = "checkpoint version 7 is outside the supported range";

    await expect(
      prepareSuccessorStep({
        handoffVersion: 3,
        migration: { kind: "incompatible", detail },
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ kind: "incompatible", reason: "checkpoint-version" });
    expect(deserializeContextMock).not.toHaveBeenCalled();
    expect(setAttributesMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot read the checkpoint"),
      expect.objectContaining({ detail, sessionId: "session-1" }),
    );
    warn.mockRestore();
  });

  it("answers rather than retries when saved state has no owner here", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deserializeContextMock.mockRejectedValue(new IncompatibleStateLayoutError("acme-crm.requests"));

    await expect(validate(createCheckpoint())).resolves.toEqual({
      kind: "incompatible",
      reason: "checkpoint-version",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot read the checkpoint"),
      expect.objectContaining({ detail: expect.stringContaining('"acme-crm.requests"') }),
    );
    warn.mockRestore();
  });

  it.each([undefined, -1, NaN, Infinity, "30000", true])(
    "rejects an invalid renewal duration (%s)",
    async (sessionTimeoutMs) => {
      const checkpoint = { ...createCheckpoint(), sessionTimeoutMs } as SessionCheckpoint;
      await expect(validate(checkpoint)).rejects.toThrow("invalid timeout duration");
      expect(deserializeContextMock).not.toHaveBeenCalled();
    },
  );
});

describe("startSuccessorStep", () => {
  const forcingWorld = { capabilities: { hookForceClaim: true, hookRetention: { active: true } } };

  beforeEach(() => {
    vi.clearAllMocks();
    getWorldMock.mockResolvedValue(forcingWorld);
    readDurableSessionMock.mockReturnValue({ state: undefined });
  });

  it.each([
    ["force-claim", { hookRetention: { active: true } }],
    ["hook retention", { hookForceClaim: true }],
  ])("starts nothing on a World without %s support", async (_name, capabilities) => {
    getWorldMock.mockResolvedValue({ capabilities });
    const records = captureLogRecords();
    await expect(startSuccessorStep(startInput())).resolves.toEqual({ kind: "unsupported" });
    expect(startWorkflowOnDeploymentMock).not.toHaveBeenCalled();
    expect(records.records).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("cannot force-claim hooks") }),
    );
  });

  it("starts nothing when the checkpoint still holds work", async () => {
    readDurableSessionMock.mockReturnValue({
      state: positionState({ sequence: 1, turnId: "turn_0" }),
    });
    await expect(startSuccessorStep(startInput())).resolves.toEqual({ kind: "not-idle" });
    expect(startWorkflowOnDeploymentMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, "default"] as const)(
    "starts a version 3 successor on the original stream with retention=%s",
    async (retention) => {
      const sessionWritable = new WritableStream<Uint8Array>();
      getRunMock.mockReturnValue({ getWritable: () => sessionWritable });
      startWorkflowOnDeploymentMock.mockResolvedValue({ runId: "owner-2" });
      const input = startInput();
      const checkpoint = { ...input.checkpoint, retention };

      await expect(startSuccessorStep({ ...input, checkpoint })).resolves.toEqual({
        kind: "started",
        runId: "owner-2",
      });

      expect(getRunMock).toHaveBeenCalledWith("anchor-1");
      expect(startWorkflowOnDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: expect.stringContaining("workflowEntry") }),
        [
          {
            activationToken: "owner-1:handoff:0",
            attemptKey: "owner-1:0",
            checkpoint,
            delivery: input.delivery,
            handoffVersion: 3,
            hookTokens: input.hookTokens,
            kind: "handoff",
            ownerDeploymentId: "deployment-b",
            sessionWritable,
            sessionId: "anchor-1",
            sourceRunId: "owner-1",
          },
        ],
        "deployment-b",
        retention === undefined ? undefined : { experimental_retention: retention },
      );
    },
  );

  function startInput(): SuccessorStartInput & {
    readonly delivery: { readonly kind: "deliver"; readonly payloads: { message: string }[] };
  } {
    return {
      activationToken: "owner-1:handoff:0",
      anchorRunId: "anchor-1",
      attemptKey: "owner-1:0",
      checkpoint: createCheckpoint(),
      delivery: { kind: "deliver", payloads: [{ message: "hello" }] },
      hookTokens: ["eve:session:anchor-1:inbox", "http:alias"],
      sourceRunId: "owner-1",
      targetDeploymentId: "deployment-b",
    };
  }
});

describe("signalSessionOwnerActivationStep", () => {
  it("treats an owner that already settled the attempt as told", async () => {
    resumeHookMock.mockRejectedValue(new HookNotFoundError("owner-1:handoff:0"));
    await expect(
      signalSessionOwnerActivationStep({
        activation: { kind: "active" },
        token: "owner-1:handoff:0",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("stopUntrackedChildSessionsStep", () => {
  it("stops every child except the session itself and tolerates finished runs", async () => {
    cancelRunMock.mockReset();
    cancelRunMock.mockImplementation(async (_world: unknown, runId: string) => {
      if (runId === "child-gone") throw new WorkflowRunNotFoundError(runId);
    });

    await stopUntrackedChildSessionsStep({
      runIds: ["child-gone", "session-1", "child-parked"],
      sessionId: "session-1",
    });

    expect(cancelRunMock.mock.calls.map(([, runId]) => runId)).toEqual([
      "child-gone",
      "child-parked",
    ]);
  });
});

function validate(checkpoint: SessionCheckpoint) {
  return prepareSuccessorStep({
    handoffVersion: 3,
    migration: { kind: "current", checkpoint, childRunIdsToStop: [] },
    sessionId: "session-1",
  });
}

function createCheckpoint(): SessionCheckpoint {
  return {
    admittedDeliveryKeys: [],
    version: SESSION_CHECKPOINT_VERSION,
    history: [],
    sessionTimeoutMs: false,
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      hasProxyInputRequests: false,
      sessionId: "session-1",
    }),
  };
}
