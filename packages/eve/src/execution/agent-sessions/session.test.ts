import { beforeEach, expect, it, vi } from "vitest";

import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally } from "#execution/agent-sessions/usage.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  openAgentSessionStep: vi.fn(),
  renewAgentSessionsStep: vi.fn(),
  sendAgentSessionMessageStep: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  // A reply hook whose turn never ends: these tests are about what reaches the session.
  createHook: () => ({
    token: "reply",
    dispose: async () => {},
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }),
}));
vi.mock("#execution/agent-sessions/steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/agent-sessions/steps.js")>()),
  openAgentSessionStep: mocks.openAgentSessionStep,
  renewAgentSessionsStep: mocks.renewAgentSessionsStep,
  sendAgentSessionMessageStep: mocks.sendAgentSessionMessageStep,
}));

const address = {
  continuationToken: "worker-token",
  kind: "local",
  name: "worker",
  sessionId: "worker-session",
};

const run = {
  agentContext: {},
  auth: {},
  from: { runId: "run-1" },
  owner: { send: async () => {} },
} as unknown as WorkflowToolRunContext;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.calls.length = 0;
  mocks.openAgentSessionStep.mockResolvedValue(address);
  mocks.sendAgentSessionMessageStep.mockImplementation(async () => {
    mocks.calls.push("send");
  });
});

it("renews a session still opening when the renewal arrives", async () => {
  const open = Promise.withResolvers<typeof address>();
  mocks.openAgentSessionStep.mockReturnValue(open.promise);
  mocks.renewAgentSessionsStep.mockResolvedValue(undefined);
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  const sending = sessions.open("worker").send("first page");

  const renewed = sessions.renew("R");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.renewAgentSessionsStep).not.toHaveBeenCalled();
  open.resolve(address);
  await renewed;
  await sending;

  expect(mocks.renewAgentSessionsStep).toHaveBeenCalledExactlyOnceWith({
    renewalId: "R",
    sessions: [expect.objectContaining({ address })],
  });
});

it("rejects a renewal that can't reach a session, with no later message to carry it", async () => {
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  await sessions.open("worker").send("first page");
  mocks.renewAgentSessionsStep.mockRejectedValue(new Error("inbox unavailable"));

  await expect(sessions.renew("R")).rejects.toThrow("inbox unavailable");
});

it("holds a message until the pending renewal reaches the session", async () => {
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  const worker = sessions.open("worker");
  await worker.send("first page");
  mocks.calls.length = 0;
  const renewal = Promise.withResolvers<void>();
  mocks.renewAgentSessionsStep.mockImplementation(async () => {
    await renewal.promise;
    mocks.calls.push("renew");
  });

  const renewed = sessions.renew("R");
  const sending = worker.send("next page");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.calls).toEqual([]);
  renewal.resolve();
  await Promise.all([renewed, sending]);

  expect(mocks.calls).toEqual(["renew", "send"]);
});

it("doesn't send a message after its renewal failed", async () => {
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  const worker = sessions.open("worker");
  await worker.send("first page");
  mocks.calls.length = 0;
  mocks.renewAgentSessionsStep.mockRejectedValue(new Error("inbox unavailable"));
  const renewed = sessions.renew("R");

  await expect(worker.send("next page")).rejects.toThrow("inbox unavailable");
  await expect(renewed).rejects.toThrow("inbox unavailable");
  expect(mocks.calls).toEqual([]);
});

it("doesn't renew a session opened after the renewal, which starts in it", async () => {
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  await sessions.renew("R");
  await sessions.open("worker").send("first page");
  await sessions.renew("R");

  expect(mocks.renewAgentSessionsStep).not.toHaveBeenCalled();
});

it("delivers a renewal only after the one before it, so the session ends in the latest", async () => {
  const sessions = createAgentSessions(run, createRunUsageTally(), "");
  await sessions.open("worker").send("first page");
  const first = Promise.withResolvers<void>();
  mocks.renewAgentSessionsStep.mockImplementation(async ({ renewalId }: { renewalId: string }) => {
    if (renewalId === "R1") await first.promise;
    mocks.calls.push(renewalId);
  });

  const renewals = [sessions.renew("R1"), sessions.renew("R2")];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.renewAgentSessionsStep).toHaveBeenCalledOnce();
  first.resolve();
  await Promise.all(renewals);

  expect(mocks.calls).toEqual(["R1", "R2"]);
});
