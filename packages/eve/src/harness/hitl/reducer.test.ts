import { openApprovalsOf, approvalOf } from "./approval.js";
import { openRelayed } from "./relay.js";
import { openAuthorizationsOf } from "./authorization.js";
import { openLimit } from "#harness/session-machine/view.js";
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { HarnessSession } from "#harness/types.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { readTurnState } from "#harness/session-machine/state.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { createTurnStartedEvent, createInputRequestedEvent } from "#protocol/message.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";
import {
  ALICE,
  AT,
  BUDGET_QUESTION,
  approval,
  approvalsRequested,
  answers,
  answer,
  challenge,
  message,
  stepResponse,
} from "#internal/testing/hitl.js";
import { HumanInput } from "#internal/testing/hitl-observer.js";
import { beforeStep, afterStep } from "./reducer.js";
import { migrateSessionState } from "#harness/session-machine/migrate.js";
import {
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  STATE_KEY,
} from "#harness/session-machine/migrate-legacy.js";
import { reduce } from "./reducer.js";

function view(): SessionView {
  return {
    projection: foldSession(initialSessionProjection(), createTurnStartedEvent(AT)),
    turn: { grants: [], suspended: [] },
    relayedRequestIds: new Set(),
    signIns: [],
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 12, outputTokens: 3 },
  };
}
function session(): HarnessSession {
  return {
    sessionId: "s",
    continuationToken: "http:test",
    agent: { modelReference: { id: "test" }, system: "test", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100000 },
    history: [],
    limits: { maxInputTokensPerSession: 100 },
  };
}
const route = { childContinuationToken: "child" };

describe("HumanInput boundary transitions", () => {
  it("aggregates multiple suspended steps in suspended-array order, not answer order", () => {
    let v = view();
    for (const [stepIndex, name] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const response = approvalsRequested([approval(name)], { at: { ...AT, stepIndex } });
      const next = afterStep(v, response);
      const adapted = next;
      v = {
        ...v,
        turn: adapted.transition.turn,
        projection: adapted.transition.events.reduce(foldSession, v.projection),
        signIns: next.transition.signIns ?? v.signIns,
      };
    }
    const next = beforeStep(v, [answers({ b: "approve", a: "approve" })]);
    const events = next.transition.events;
    expect(
      events
        .filter((event) => event.type === "input.resolved")
        .map((event) => event.data.stepIndex),
    ).toEqual([0, 1]);
    expect(
      next.transition.turn.suspended.map((step) =>
        step.approved?.map((request) => request.requestId),
      ),
    ).toEqual([["a"], ["b"]]);
    expect(next.transition.turn.grants).toEqual(["a", "b"]);
  });

  it("reconstructs each held lens solely from persisted TurnState after restart", async () => {
    let v = view();
    const a = approval("a");
    const b = approval("b");
    const next = afterStep(
      v,
      approvalsRequested([a, b], { approvalKeys: { a: "a-key" }, responsePolicyRequestIds: ["a"] }),
    );
    const stored = await applyTransition(session(), next.transition, async () => {});
    const restarted = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(stored.state)),
    );
    const projected = restarted;
    expect(projected.turn.suspended[0]?.messages).toEqual(stepResponse([a, b]));
    expect(approvalOf(projected, "a")).toMatchObject({
      approvalKey: "a-key",
      responsePolicy: true,
      requester: ALICE,
    });
    expect(approvalOf(projected, "b")).toMatchObject({ approvalKey: "b" });
    expect(stored.state?.[STATE_KEY]).toBeUndefined();
  });

  it("preserves partial answers and candidate audit across a restart", async () => {
    const v = view();
    const opened = afterStep(v, approvalsRequested([approval("a"), approval("b")]));
    const waiting = { ...v, turn: opened.transition.turn };
    const answered = beforeStep(waiting, [answer("approve", "a")]);
    const stored = await applyTransition(session(), answered.transition, async () => {});
    const restart = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(stored.state)),
    );
    expect(approvalOf(restart, "a")).toMatchObject({
      answer: { requestId: "a", optionId: "approve" },
    });
    expect(restart.turn.hitl?.audit?.settlements.a?.approver).toEqual(ALICE);
    const finished = beforeStep(restart, [answer("approve", "b")]);
    expect(
      finished.transition.turn.suspended[0]?.approved?.map((request) => request.requestId),
    ).toEqual(["a", "b"]);
  });

  it("projects the old coordination batch and grants without changing or deleting legacy records", () => {
    const legacy = {
      [LEGACY_GRANTS_KEY]: ["old-tool"],
      [LEGACY_BATCH_KEY]: {
        event: AT,
        tasks: [],
        responseMessages: stepResponse([approval("old")]),
        followingInput: { message: "following" },
      },
    };
    const unchanged = JSON.stringify(legacy);
    const migrated = sessionView(view().projection, migrateSessionState({ state: legacy }).state);
    const projected = migrated;
    expect(migrated.turn.grants).toEqual(["old-tool"]);
    expect(projected.turn.suspended[0]?.following).toEqual({ message: "following" });
    expect(projected.turn.suspended[0]?.messages).toEqual(stepResponse([approval("old")]));
    expect(JSON.stringify(legacy)).toBe(unchanged);
  });

  it("reconstructs budget, relay route and authorization metadata from the machine view", () => {
    const v = view();
    const req = approval("relay");
    const projection = foldSession(
      v.projection,
      createInputRequestedEvent({ ...AT, requests: [req] }),
    );
    const projected = {
      ...v,
      projection: foldSession(
        projection,
        createInputRequestedEvent({ ...AT, requests: [BUDGET_QUESTION] }),
      ),
      signIns: [challenge("attempt")],
      turn: {
        ...v.turn,
        hitl: {
          relayedRoutes: { relay: route },
          relayedAuthorizations: { child: { at: AT, name: "github", runId: "run" } },
        },
      },
    };
    expect(openRelayed(projected).find((open) => open.request.requestId === "relay")).toMatchObject(
      { kind: "relayed", route },
    );
    expect(openLimit(projected)?.request.kind).toBe("session-limit");
    expect(openAuthorizationsOf(projected).length > 0).toBe(true);
    expect(projected.turn.hitl?.relayedAuthorizations?.child?.runId).toBe("run");
  });

  it("holds arrivals behind approved results, not behind runtime results", () => {
    const result = (callId: string): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "t",
          output: { type: "text", value: "ok" },
        },
      ],
    });
    const deploy = approval("deploy");
    const held = {
      ...view(),
      turn: {
        ...view().turn,
        suspended: [{ event: AT, messages: [], requests: [], approved: [deploy], tasks: [] }],
      },
    };
    const approvedCallId = deploy.action.kind === "tool-call" ? deploy.action.callId : "";
    expect(
      afterStep(held, {
        type: "actions.settled",
        at: AT,
        results: [result(approvedCallId)],
        approved: {},
      }).transition.turn.hitl?.readsResults,
    ).toBe(true);
    expect(
      afterStep(
        {
          ...held,
          turn: { ...held.turn, suspended: [{ ...held.turn.suspended[0]!, approved: undefined }] },
        },
        { type: "actions.settled", at: AT, results: [result("task-call")] },
      ).transition.turn.hitl?.readsResults,
    ).toBeUndefined();
  });

  it("keeps arrivals behind the result-reading barrier", () => {
    const v = { ...view(), turn: { ...view().turn, hitl: { readsResults: true as const } } };
    const result = beforeStep(v, [message("later")]);
    expect(result.transition.events).toEqual([]);
    expect(result.transition.turn.queued).toEqual({ message: "later", messageAuth: ALICE });
    expect(result.transition.turn.hitl?.readsResults).toBe(true);
  });
  it("preserves candidate settlements after commit/restart without asking the policy again", async () => {
    const base = view();
    const open = afterStep(
      base,
      approvalsRequested([approval("a")], { responsePolicyRequestIds: ["a"] }),
    );
    const waiting = { ...base, turn: open.transition.turn };
    const response = answer("approve", "a");
    const projected = waiting;
    const checks: string[] = [];
    reduce(projected, response, "pre-step", (check) => {
      checks.push(check.candidateId);
      return undefined;
    });
    expect(checks).toHaveLength(1);
    const allowed = beforeStep(waiting, [
      {
        ...response,
        verdicts: { [checks[0]!]: { kind: "returned", value: { status: "allowed" } } },
      },
    ]);
    const saved = await applyTransition(session(), allowed.transition, async () => {});
    const restart = sessionView(
      initialSessionProjection(),
      JSON.parse(JSON.stringify(saved.state)),
    );
    expect(restart.turn.hitl?.audit?.settlements.a?.approver).toEqual(ALICE);
    expect(restart.turn.hitl?.audit?.activeCandidates).toEqual({});
    expect(restart.turn.suspended[0]?.approved?.map((request) => request.requestId)).toEqual(["a"]);
    expect(beforeStep(restart, [response]).transition.events).toEqual([]);
  });

  it("settles an originating step without touching a sibling with reused call ids", () => {
    const a = approval("a");
    const b = { ...approval("b"), action: { ...approval("b").action, callId: a.action.callId } };
    let v = view();
    for (const [stepIndex, request] of [
      [0, a],
      [1, b],
    ] as const) {
      const opened = afterStep(v, approvalsRequested([request], { at: { ...AT, stepIndex } }));
      v = { ...v, turn: opened.transition.turn };
    }
    const approved = beforeStep(v, [answers({ a: "approve", b: "approve" })]);
    v = { ...v, turn: approved.transition.turn };
    const result: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: a.action.callId,
          toolName: "a",
          output: { type: "text", value: "done" },
        },
      ],
    };
    const settled = afterStep(v, {
      at: AT,
      type: "actions.settled",
      results: [result],
      approved: {},
    });
    expect(settled.transition.turn.suspended).toHaveLength(1);
    expect(settled.transition.turn.suspended[0]?.event.stepIndex).toBe(1);
    expect(settled.transition.turn.suspended[0]?.approved?.[0]?.requestId).toBe("b");
  });

  it("keeps the result barrier through effect completions and clears it on a whole model response", () => {
    const v = { ...view(), turn: { ...view().turn, hitl: { readsResults: true as const } } };
    const effectsCompleted = afterStep(v, { type: "actions.settled", at: AT, results: [] });
    expect(effectsCompleted.transition.turn.hitl?.readsResults).toBe(true);
    const modelCompleted = afterStep(v, { at: AT, inputs: [] });
    expect(modelCompleted.transition.turn.hitl?.readsResults).toBeUndefined();
    const cancelled = beforeStep(v, [{ type: "cancel.requested" }]);
    expect(cancelled.transition.turn.hitl?.readsResults).toBeUndefined();
  });

  it("consumes a budget answer without consuming the message queued behind it", () => {
    const v = view();
    const asked = beforeStep(v, [{ type: "budget.exceeded", at: AT, request: BUDGET_QUESTION }]);
    const waiting = {
      ...v,
      projection: asked.transition.events.reduce(foldSession, v.projection),
      turn: {
        ...asked.transition.turn,
        hitl: { readsResults: true as const },
        queued: { message: "Answer this after continuing." },
      },
    };
    const answered = beforeStep(waiting, [message("approve")]);
    const adapted = answered;
    expect(adapted.transition.grantBudget).toBe(true);
    expect(
      openLimit({
        ...waiting,
        projection: adapted.transition.events.reduce(foldSession, waiting.projection),
      }),
    ).toBeUndefined();
    expect(adapted.transition.turn.queued?.message).toBe("Answer this after continuing.");
  });

  it("holds and stops a budget question with one resolution while preserving unrelated state", async () => {
    const v = view();
    const asked = beforeStep(v, [{ type: "budget.exceeded", at: AT, request: BUDGET_QUESTION }]);
    const first = asked;
    const saved = await applyTransition(
      { ...session(), state: { unrelated: 1 } },
      first.transition,
      async () => {},
    );
    let projection = first.transition.events.reduce(foldSession, v.projection);
    const restarted = sessionView(projection, saved.state);
    expect(openLimit(restarted)?.request.kind).toBe("session-limit");
    expect(first.transition.events.some((event) => event.type === "turn.completed")).toBe(false);
    const stopped = beforeStep(restarted, [answer("stop", BUDGET_QUESTION.requestId)]);
    expect(
      stopped.transition.events.filter((event) => event.type === "input.resolved"),
    ).toHaveLength(1);
    projection = stopped.transition.events.reduce(foldSession, projection);
    const applied = await applyTransition(saved, stopped.transition, async () => {});
    expect(applied.state?.unrelated).toBe(1);
    expect(openApprovalsOf(sessionView(projection, applied.state))).toEqual([]);
    expect(openLimit(sessionView(projection, applied.state))).toBeUndefined();
    expect(openRelayed(sessionView(projection, applied.state))).toEqual([]);
    expect(openAuthorizationsOf(sessionView(projection, applied.state))).toEqual([]);
  });

  it("cancels multiple held lenses without duplicating sibling resolutions or terminal events", () => {
    let v = view();
    for (const [stepIndex, name] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const opened = afterStep(
        v,
        approvalsRequested([approval(name)], { at: { ...AT, stepIndex } }),
      );
      v = {
        ...v,
        turn: opened.transition.turn,
        projection: opened.transition.events.reduce(foldSession, v.projection),
      };
    }
    const cancelled = beforeStep(v, [{ type: "cancel.requested" }]);
    const resolutions = cancelled.transition.events.flatMap((event) =>
      event.type === "input.resolved" ? event.data.resolutions.map((item) => item.requestId) : [],
    );
    expect(resolutions).toEqual(["a", "b"]);
    expect(
      cancelled.transition.events.filter((event) => event.type === "turn.cancelled"),
    ).toHaveLength(1);
    expect(cancelled.transition.turn.suspended).toEqual([]);
    expect(cancelled.transition.commit?.filter((message) => message.role === "tool")).toHaveLength(
      2,
    );
  });
  it("queues attributed answers as well as messages behind results", () => {
    const v = { ...view(), turn: { ...view().turn, hitl: { readsResults: true as const } } };
    const result = beforeStep(v, [answer("approve", "a"), message("later")]);
    expect(result.transition.events).toEqual([]);
    expect(result.transition.turn.queued?.attributedInputResponses).toEqual([
      { auth: ALICE, response: { optionId: "approve", requestId: "a" } },
    ]);
  });

  it("folds relay lifecycle between arrivals before handing an answer to the outbox", () => {
    const v = view();
    const next = beforeStep(v, [
      { type: "relayed.requested", at: AT, requests: [approval("child")], route },
      { type: "delivery.received", responses: [{ requestId: "child", optionId: "approve" }] },
    ]);
    const result = next;
    expect(result.effects).toEqual([
      { type: "forwardAnswer", route, responses: [{ requestId: "child", optionId: "approve" }] },
    ]);
    expect(result.transition.events.map((event) => event.type)).toEqual([
      "input.requested",
      "turn.waiting",
      "input.resolved",
    ]);
    expect(result.transition.turn.hitl?.relayedRoutes).toEqual({});
  });

  it("migrates the old HumanInput key into machine fields rather than storing another projection", async () => {
    const request = approval("old");
    const legacy = {
      [STATE_KEY]: {
        grants: ["old-grant"],
        requests: {
          old: { kind: "tool-approval", at: AT, request, requester: ALICE, approvalKey: "old-key" },
        },
        held: { at: AT, messages: stepResponse([request]) },
      },
    };
    const migration = sessionView(view().projection, migrateSessionState({ state: legacy }).state);
    const saved = await applyTransition(session(), { ...migration, events: [] }, async () => {});
    expect(saved.state?.[STATE_KEY]).toBeUndefined();
    const restarted = sessionView(initialSessionProjection(), saved.state);
    expect(approvalOf(restarted, "old")).toMatchObject({
      approvalKey: "old-key",
      requester: ALICE,
    });
    expect(restarted.turn.grants).toEqual(["old-grant"]);
  });
  it("projects saved-step cancel closures without re-publishing them on rollback cleanup", () => {
    const v = view();
    const held = afterStep(v, approvalsRequested([approval("a")]));
    const saved = { ...v, turn: held.transition.turn };
    const carried = beforeStep(saved, [{ type: "cancel.replayed" }]);
    expect(carried.transition.events.length > 0).toBe(false);
    expect(carried.transition.turn.suspended[0]?.requests).toEqual([]);
    expect(carried.transition.turn.suspended[0]?.messages).toEqual(stepResponse([approval("a")]));
    const cleanup = beforeStep({ ...saved, turn: carried.transition.turn }, [
      { type: "cancel.requested" },
    ]);
    expect(cleanup.transition.events.filter((event) => event.type === "input.resolved")).toEqual(
      [],
    );
    expect(cleanup.transition.turn.suspended).toEqual([]);
  });
  it("includes a new message immediately after a cancelled approval turn (#4396)", async () => {
    const initial = view();
    const parked = afterStep(initial, approvalsRequested([approval("deploy")]));
    const waiting = { ...initial, turn: parked.transition.turn };
    const cancelled = beforeStep(waiting, [{ type: "cancel.requested" }]);
    let projection = initial.projection;
    const saved = await applyTransition(session(), cancelled.transition, async (event) => {
      projection = foldSession(projection, event);
    });
    const input = HumanInput.fromView(sessionView(projection, saved.state));
    expect(input.next()).toEqual({ run: "model" });
    expect(input.acceptInput({ message: "Answer this in the first step." })).toEqual({
      input: { message: "Answer this in the first step." },
    });
    expect(readTurnState(saved.state).hitl?.readsResults).toBeUndefined();
  });

  it("keeps approved work ahead of the next message, unlike a cancelled approval (#4396)", () => {
    const initial = view();
    const parked = afterStep(initial, approvalsRequested([approval("deploy")]));
    const waiting = { ...initial, turn: parked.transition.turn };
    const approved = beforeStep(waiting, [answer("approve", "deploy")]);
    const input = HumanInput.fromView({ ...waiting, turn: approved.transition.turn });
    expect(input.next()).toEqual({ run: "approved" });
    expect(input.approverOfRequest("deploy")?.principalId).toBe("alice");
  });

  it("cancellation retires active candidates as stale, with the cancel's reason", () => {
    const v = view();
    const opened = afterStep(
      v,
      approvalsRequested([approval("deploy")], {
        responsePolicyRequestIds: ["deploy"],
      }),
    );
    const waiting = { ...v, turn: opened.transition.turn };
    const pending = beforeStep(waiting, [answer("approve", "deploy")], () => undefined);
    expect(Object.keys(pending.transition.turn.hitl?.audit?.activeCandidates ?? {})).toHaveLength(
      1,
    );
    const cancelled = beforeStep({ ...waiting, turn: pending.transition.turn }, [
      { type: "cancel.requested" },
    ]);
    expect(cancelled.transition.turn.hitl?.audit?.activeCandidates).toEqual({});
    expect(cancelled.transition.turn.hitl?.audit?.candidateHistory).toEqual([
      expect.objectContaining({ status: "stale", reason: "Cancelled." }),
    ]);
  });
});
