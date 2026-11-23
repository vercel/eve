import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionEvent } from "#protocol/session-event.js";

const ports = vi.hoisted(() => ({ findRun: vi.fn(), streamSessionLines: vi.fn() }));
vi.mock("#execution/workflow-host/host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-host/host.js")>()),
  findWorkflowRun: ports.findRun,
}));
vi.mock("#execution/session-event-stream.js", () => ({
  streamSessionLines: ports.streamSessionLines,
}));

import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";

beforeEach(() => vi.resetAllMocks());

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

function serveRun(status: string) {
  ports.findRun.mockResolvedValue({
    runId: "invocation-1",
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    expiredAt: undefined,
    status,
    attributes: {
      [INVOCATION_OWNER_ATTRIBUTE]: invocationOwnerKey(auth),
      [INVOCATION_TOKEN_ATTRIBUTE]: "invocation-token",
    },
  });
}

function serveRecords(records: readonly unknown[]) {
  ports.streamSessionLines.mockImplementation(async function* () {
    for (const [position, record] of records.entries()) {
      const stored =
        typeof record === "object" &&
        record !== null &&
        ("facts" in record || "progress" in record);
      yield { line: stored ? record : undefined, position, record };
    }
  });
}

function execution() {
  return new WorkflowAgentInvocationExecution({
    createSession: async () => {
      throw new Error("Creation is not used by reads");
    },
    from: () => {
      throw new Error("Dispatch is not used by reads");
    },
  });
}

it.each(["cancelled", "failed"] as const)(
  "does not turn a %s request into success when its session retires normally",
  async (outcome) => {
    serveRun("completed");
    const facts: SessionEvent[] = [
      {
        type: "turn.started",
        data: { turnId: "turn-1", follows: null, cause: { deliveryId: "delivery-1" } },
      },
      {
        type: "turn.settled",
        data: {
          turnId: "turn-1",
          outcome,
          error:
            outcome === "failed"
              ? { code: "RELEASE_FAILED", message: "Release failed." }
              : undefined,
        },
      },
      { type: "session.ended", data: { outcome: "completed" } },
    ];
    serveRecords(facts.map((fact) => ({ at: "2026-10-16T00:00:00.000Z", facts: [fact] })));
    expect(await execution().read({ invocationId: "invocation-1", auth })).toMatchObject({
      status: outcome,
      sessionEnded: true,
    });
  },
);

it("fails an invocation an earlier eve started instead of reading it as working", async () => {
  serveRun("running");
  serveRecords([
    { type: "message.received", data: { turnId: "turn-1", message: "Hi" }, meta: {} },
    { type: "input.requested", data: { turnId: "turn-1" }, meta: {} },
  ]);
  const invocation = await execution().read({ invocationId: "invocation-1", auth });
  expect(invocation).toMatchObject({
    status: "failed",
    error: { data: { eveCode: "session_version_unsupported", hint: "Start a new invocation." } },
  });
  expect(invocation).not.toHaveProperty("pollAfterMs");
  await expect(
    execution().update({ invocationId: "invocation-1", auth, responses: [] }),
  ).resolves.toMatchObject({ type: "conflict" });
});

it("reads a fresh invocation with no lines yet as working", async () => {
  serveRun("running");
  serveRecords([]);
  expect(await execution().read({ invocationId: "invocation-1", auth })).toMatchObject({
    status: "working",
  });
});

describe("statusMessage", () => {
  const turn = {
    type: "turn.started",
    data: { turnId: "turn-1", follows: null, cause: { deliveryId: "delivery-1" } },
    scope: { turnId: "turn-1" },
  };
  const run = {
    type: "model.requested",
    data: { owner: { turnId: "turn-1" }, runId: "run-1" },
    scope: { turnId: "turn-1" },
  };
  const runSettled = {
    type: "model.settled",
    data: { outcome: "completed", runId: "run-1" },
    scope: { runId: "run-1", turnId: "turn-1" },
  };
  const call = (callId: string, capability: object) => ({
    type: "call.requested",
    data: { callId, capability, input: {}, owner: { runId: "run-1" } },
    scope: { runId: "run-1" },
  });
  const started = (callId: string) => ({ type: "call.started", data: { callId } });
  const settled = (callId: string) => ({
    type: "call.settled",
    data: { callId, outcome: "completed", output: "done" },
  });

  const delta = (partId: string, delta: string, kind?: string) => ({
    progress: {
      type: "content.delta",
      data: { delta, partId, ...(kind !== undefined && { kind }) },
      scope: { runId: "run-1", turnId: "turn-1" },
    },
  });
  const completed = (partId: string, kind: string, value: string, phase = "narration") => ({
    type: "content.completed",
    data: { kind, partId, phase, runId: "run-1", value },
    scope: { runId: "run-1", turnId: "turn-1" },
  });

  async function statusMessageOf(...records: object[]) {
    serveRun("running");
    serveRecords(
      [{ type: "session.started", data: {} }, turn, run, ...records].map((record) =>
        "progress" in record ? record : { at: "2026-10-16T00:00:00.000Z", facts: [record] },
      ),
    );
    const invocation = await execution().read({ invocationId: "invocation-1", auth });
    expect(invocation?.status).toBe("working");
    return invocation?.status === "working" ? invocation.statusMessage : undefined;
  }

  it("names a running call by its label, else by its tool name", async () => {
    await expect(
      statusMessageOf(
        call("c-1", { kind: "tool", label: "Reading notes.md", name: "read" }),
        started("c-1"),
      ),
    ).resolves.toBe("Reading notes.md");
    await expect(
      statusMessageOf(call("c-1", { kind: "tool", name: "list_files" }), started("c-1")),
    ).resolves.toBe("List files");
  });

  it("names the latest running call and counts the others", async () => {
    await expect(
      statusMessageOf(
        call("c-1", { kind: "tool", name: "read" }),
        call("c-2", { kind: "tool", name: "search" }),
        call("c-3", { kind: "tool", name: "list_files" }),
        started("c-1"),
        started("c-2"),
        started("c-3"),
      ),
    ).resolves.toBe("List files (+2 more)");
  });

  it("drops a call once it settles and hides control calls", async () => {
    await expect(
      statusMessageOf(
        call("c-1", { kind: "tool", name: "read" }),
        call("c-2", { kind: "control", name: "wait" }),
        started("c-1"),
        started("c-2"),
        settled("c-1"),
      ),
    ).resolves.toBe("Thinking...");
  });

  it("shows the latest finished reasoning sentence while reasoning streams", async () => {
    await expect(
      statusMessageOf(
        delta("r-1", "I should check the Snowflake revenue tables for last quarter. ", "reasoning"),
        delta("r-1", "Then compare them against the forecast numbers from the fin"),
      ),
    ).resolves.toBe("I should check the Snowflake revenue tables for last quarter.");
  });

  it("keeps the turn's completed reasoning until new reasoning is long enough", async () => {
    await expect(
      statusMessageOf(
        completed("r-1", "reasoning", "**Checking Snowflake sources**\n\nLooking at tables."),
        call("c-1", { kind: "tool", name: "query" }),
        started("c-1"),
        settled("c-1"),
        delta("r-2", "Now", "reasoning"),
      ),
    ).resolves.toBe("Checking Snowflake sources");
  });

  it.each([
    ["streams", delta("t-1", "word ".repeat(60), "text")],
    ["has completed", completed("t-1", "text", "Done.", "reply")],
  ])("says it is writing a reply once reply text %s", async (_, reply) => {
    await expect(
      statusMessageOf(completed("r-1", "reasoning", "**Checking Snowflake sources**"), reply),
    ).resolves.toBe("Writing a reply...");
  });

  it("stops saying it is writing a reply once a later model step starts", async () => {
    await expect(
      statusMessageOf(
        completed("t-1", "text", "Started the export; I'll report back.", "reply"),
        runSettled,
        {
          type: "model.requested",
          data: { owner: { turnId: "turn-1" }, runId: "run-2" },
          scope: { turnId: "turn-1" },
        },
        {
          type: "content.completed",
          data: {
            kind: "reasoning",
            partId: "r-2",
            phase: "narration",
            runId: "run-2",
            value: "**Checking the export**",
          },
          scope: { runId: "run-2", turnId: "turn-1" },
        },
      ),
    ).resolves.toBe("Checking the export");
  });

  it("keeps naming an approved call while it runs after the turn parked", async () => {
    await expect(
      statusMessageOf(
        call("c-1", { kind: "tool", label: "Deploying", name: "deploy" }),
        runSettled,
        {
          type: "interaction.opened",
          data: {
            interactionId: "i-1",
            request: { kind: "approval", prompt: "Approve deploy?" },
            subject: { callId: "c-1" },
          },
        },
        {
          type: "interaction.settled",
          data: {
            interactionId: "i-1",
            outcome: "accepted",
            answer: { interactionId: "i-1", optionId: "approve" },
          },
        },
        started("c-1"),
      ),
    ).resolves.toBe("Deploying");
  });
});
