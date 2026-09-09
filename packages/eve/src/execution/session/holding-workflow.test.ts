import { beforeEach, describe, expect, it, vi } from "vitest";
import { holdingWorkflow } from "#execution/session/holding-workflow.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { AcceptedSubmission } from "#execution/turn/types.js";

const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  inbox: vi.fn(),
  initialize: vi.fn(),
  redirect: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: mocks.hook,
  getWorkflowMetadata: () => ({ workflowRunId: "holder" }),
}));
vi.mock("#execution/inbox/owner.js", () => ({ createOwnerInbox: mocks.inbox }));
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: mocks.send }));
vi.mock("#execution/session/holding-steps.js", () => ({
  initializeHolderStep: mocks.initialize,
  redirectHolderStep: mocks.redirect,
}));
vi.mock("#execution/session/dispatch.js", () => ({ startTurnStep: mocks.start }));

const stop = new Error("test stopped holder");
const firstTurn: AcceptedSubmission = {
  eventId: "first",
  command: { kind: "send", payload: { message: "Hello" } },
};
let commands: InboxEnvelope[];
let hooks: Map<
  string,
  { getConflict: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
>;
let disposeControl: ReturnType<typeof vi.fn>;
let conflicts: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  commands = [];
  hooks = new Map();
  conflicts = new Set();
  disposeControl = vi.fn();
  mocks.inbox.mockReturnValue({
    claim: async () => ({ kind: "owned" }),
    next: async () => {
      const next = commands.shift();
      if (next === undefined) throw stop;
      return next;
    },
    dispose: disposeControl,
  });
  mocks.hook.mockImplementation(({ token }: { token: string }) => {
    const hook = {
      getConflict: vi.fn(async () => (conflicts.has(token) ? { runId: "winner" } : null)),
      dispose: vi.fn(),
    };
    hooks.set(token, hook);
    return hook;
  });
  mocks.initialize.mockResolvedValue({ sessionId: "holder" });
  mocks.start.mockResolvedValue({ runId: "first-turn" });
  mocks.send.mockResolvedValue("delivered");
});

function rekey(token: unknown, eventId = String(token)): InboxEnvelope {
  return {
    eventId,
    requestId: eventId,
    kind: "rekey",
    payload: { token, replyTo: { token: "turn-inbox", ownerRunId: "turn" } },
  };
}

const run = (initialToken?: string) => holdingWorkflow({ firstTurn, initialToken });

describe("holding workflow", () => {
  it("claims the initial address, prepares resources, and starts exactly one first turn", async () => {
    await expect(run("provider-thread")).rejects.toBe(stop);
    expect(hooks.get("provider-thread")!.getConflict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initialize.mock.invocationCallOrder[0]!,
    );
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith("holder", "first");
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ sessionId: "holder" }, firstTurn);
    expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0]!,
    );
    expect(disposeControl).toHaveBeenCalledOnce();
  });

  it("redirects a duplicate provider bootstrap without creating another session", async () => {
    conflicts.add("provider-thread");
    await expect(run("provider-thread")).resolves.toBeUndefined();
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("holder", "winner", firstTurn);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(hooks.get("provider-thread")!.dispose).toHaveBeenCalledOnce();
  });

  it("retains original aliases and makes a repeated rekey idempotent", async () => {
    commands.push(rekey("new"), rekey("new", "repeat"));
    await expect(run("original")).rejects.toBe(stop);
    expect(mocks.hook.mock.calls.map(([input]) => input.token)).toEqual(["original", "new"]);
    expect(mocks.send.mock.calls.map(([, envelope]) => envelope.payload.status)).toEqual([
      "claimed",
      "claimed",
    ]);
    expect(hooks.get("original")!.dispose).toHaveBeenCalledOnce();
    expect(hooks.get("new")!.dispose).toHaveBeenCalledOnce();
  });

  it("rejects conflicts and invalid rekeys without destroying the holder", async () => {
    conflicts.add("occupied");
    commands.push(
      rekey("occupied"),
      rekey(""),
      { eventId: "bad", kind: "unknown", payload: null },
      rekey("valid"),
    );
    await expect(run("original")).rejects.toBe(stop);
    expect(mocks.send.mock.calls.map(([, envelope]) => envelope.payload.status)).toEqual([
      "conflict",
      "invalid",
      "claimed",
    ]);
    expect(hooks.get("occupied")!.dispose).toHaveBeenCalledOnce();
    expect(hooks.has("")).toBe(false);
    expect(hooks.has("valid")).toBe(true);
  });

  it("bounds additive aliases while allowing a previously claimed alias", async () => {
    commands.push(
      ...Array.from({ length: 128 }, (_, index) => rekey(`alias-${index}`)),
      rekey("original"),
    );
    await expect(run("original")).rejects.toBe(stop);
    expect(hooks.size).toBe(128);
    expect(mocks.send.mock.calls.at(-2)?.[1].payload.status).toBe("limit");
    expect(mocks.send.mock.calls.at(-1)?.[1].payload.status).toBe("claimed");
  });
});
