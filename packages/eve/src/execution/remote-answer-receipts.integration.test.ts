// @linux-only: remote answer receipts
import { afterEach, expect, it, vi } from "vitest";

import { SessionIdKey } from "#context/keys.js";
import type { DeliverHookPayload, SubagentInteractionHookPayload } from "#channel/types.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import { restoreSessionStep } from "#execution/publish-session-events.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { readHitlState } from "#harness/hitl/index.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { withPublished } from "#internal/testing/session-machine.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";

// Outside a workflow run, this session calls back no sign-ins of its own.
vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkflowMetadata: () => ({}),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const interactionId = "approval-1";
const remote = { name: "deployer", sessionId: "remote-session", url: "https://deployer.example" };

/** A parent that forwarded the remote child's approval, and the child's receipt per request. */
async function forwardingParent() {
  // The remote child admits each forwarded request under a receipt of its own.
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { answers } = JSON.parse(String(init?.body)) as { answers: { optionId: string }[] };
    return Response.json(
      { deliveryId: `receipt-${answers[0]!.optionId}`, ok: true, sessionId: remote.sessionId },
      { status: 202 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  let step = {
    serializedContext: {
      ...buildSerializedContext({ channelKind: "http" }),
      [SessionIdKey.name]: "parent",
    },
    sessionState: runningCall(),
    sessionWritable: new WritableStream<Uint8Array>(),
  };
  const relayed = async (events: SubagentInteractionHookPayload["events"]) => {
    const published = await emitProxiedSubagentEvent({
      ...(await restoreSessionStep({ ...step, rerun: false })),
      hookPayload: {
        callId: "probe",
        childSessionId: remote.sessionId,
        events,
        kind: "subagent-interaction",
        route: { childContinuationToken: "deployer-hook", remote },
        subagentName: "deployer",
      },
    });
    step = { ...step, ...published };
  };
  // One step can carry several queued deliveries, one payload each.
  const answered = async (...queued: [deliveryId: string, optionId: string][]) => {
    const delivery: DeliverHookPayload = {
      auth: null,
      deliveryMetadata: queued.map(([deliveryId], payloadIndex) => ({
        channelKind: "http",
        channelName: "test",
        deliveryId,
        payloadIndex,
      })),
      kind: "deliver",
      payloads: queued.map(([, optionId]) => ({ answers: [{ interactionId, optionId }] })),
    };
    const { stateDelta } = await routeProxiedDeliverStep({ ...step, delivery });
    const { serializedContext, sessionState } = applySessionStateDelta(
      { ...step, history: [] },
      stateDelta,
    );
    step = { ...step, serializedContext, sessionState };
  };

  await relayed([
    {
      data: {
        interactionId,
        request: { kind: "approval", prompt: "Deploy?" },
        subject: { turnId: "child-turn" },
      },
      type: "interaction.opened",
    },
  ]);
  return { answered, fetchMock, relayed, state: () => stateOf(step.sessionState) };
}

it("refuses the forwarded answer a remote child names by the receipt it gave for it", async () => {
  const runtime = await createTestRuntime({ agent: { name: "remote-answer-receipts" } });
  await runtime.run(async () => {
    const { answered, fetchMock, relayed, state } = await forwardingParent();
    // Alice approves, then Bob rejects before the child settles: both answers go down.
    await answered(["d-alice", "approve"]);
    await answered(["d-bob", "reject"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readHitlState(state()).relays.get(interactionId)?.receipts).toEqual({
      "receipt-approve": "d-alice",
      "receipt-reject": "d-bob",
    });

    // The child refuses Bob's answer, naming the receipt it gave for it.
    await relayed([
      {
        data: { deliveryId: "receipt-reject", interactionId, outcome: "refused", reason: "No." },
        type: "response.settled",
      },
    ]);
    expect(answersOf(state())).toEqual({ "d-alice": "submitted", "d-bob": "refused" });

    // It applies Alice's answer, naming its receipt as the decider; the route retires.
    await relayed([
      {
        data: { cause: { deliveryId: "receipt-approve" }, interactionId, outcome: "accepted" },
        type: "interaction.settled",
      },
    ]);
    expect(answersOf(state())).toEqual({ "d-alice": "applied", "d-bob": "refused" });
    expect(readHitlState(state()).relays.has(interactionId)).toBe(false);
  });
});

it("credits nobody for one receipt that covers answers from several deliveries", async () => {
  const runtime = await createTestRuntime({ agent: { name: "remote-answer-receipts" } });
  await runtime.run(async () => {
    const { answered, fetchMock, relayed, state } = await forwardingParent();
    // Alice's and Bob's answers queue up and go down in one step, under one receipt.
    await answered(["d-alice", "approve"], ["d-bob", "reject"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readHitlState(state()).relays.get(interactionId)?.receipts).toBeUndefined();

    // The receipt cannot say whose answer the child applied, so neither person is credited.
    await relayed([
      {
        data: { cause: { deliveryId: "receipt-approve" }, interactionId, outcome: "accepted" },
        type: "interaction.settled",
      },
    ]);
    expect(answersOf(state())).toEqual({ "d-alice": "withdrawn", "d-bob": "withdrawn" });
  });
});

/** How each forwarded answer stands, by the delivery it came in. */
function answersOf(state: ReturnType<typeof stateOf>): Record<string, string> {
  const { responses } = storedProjection(state).view;
  return Object.fromEntries(
    Object.values(responses).map((row) => [row.deliveryId, row.outcome ?? row.status]),
  );
}

/** A parent whose open turn's call delegated to the remote child and still runs. */
function runningCall(): DurableSessionState {
  const turnId = "turn_0";
  const runId = `test_${turnId}_0`;
  const opened = createTestSessionState(
    { sessionId: "parent" },
    { sequence: 0, stepIndex: 0, turnId },
  );
  const session = withPublished(opened.snapshot.session as HarnessSession, [
    {
      data: { callId: "probe", capability: { kind: "agent", name: "deployer" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "probe" }, scope: { turnId }, type: "call.started" },
  ]);
  return { ...opened, snapshot: { ...opened.snapshot, session } };
}

function stateOf(sessionState: DurableSessionState) {
  return readDurableSession(sessionState).state;
}
