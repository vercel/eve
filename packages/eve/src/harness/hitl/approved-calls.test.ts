import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";

import {
  APPROVED_CALL_INTERRUPTED_MESSAGE,
  runApprovedCalls,
  signInReports,
} from "#harness/hitl/approved-calls.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import { eventsOf } from "#harness/publication.js";
import type { ApprovedCall } from "#harness/session-machine/state.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";
import { initialSessionProjection } from "#protocol/session-projection.js";

const view = () => ({ projection: initialSessionProjection() });

function approval(callId: string, toolName: string): ApprovalAsk {
  return {
    call: { callId, input: {}, toolName },
    interactionId: `approval-${callId}`,
    request: { kind: "approval", prompt: `Approve tool call: ${toolName}` },
  };
}

function tool(name: string, execute: () => Promise<unknown>): HarnessToolDefinition {
  return {
    description: name,
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  } as HarnessToolDefinition;
}

it("settles calls a cancellation cut short, and keeps their siblings' results", async () => {
  const controller = new AbortController();
  const finished = tool("finished", async () => "done");
  const cut = tool("cut", async () => {
    // The sibling has its result before the turn is cancelled.
    await Promise.resolve();
    controller.abort(new TurnCancelledError());
    throw controller.signal.reason;
  });
  const execute = { cut: vi.spyOn(cut, "execute"), finished: vi.spyOn(finished, "execute") };

  const result = await runApprovedCalls({
    abortSignal: controller.signal,
    messages: [],
    publish: async () => {},
    view,
    approvals: [approval("call-finished", "finished"), approval("call-cut", "cut")],
    tools: new Map([
      ["finished", finished],
      ["cut", cut],
    ]),
  });

  expect(execute.finished).toHaveBeenCalledOnce();
  expect(execute.cut).toHaveBeenCalledOnce();
  expect(result.settled.map(({ part }) => [part.toolCallId, part.output])).toEqual([
    ["call-finished", { type: "text", value: "done" }],
    ["call-cut", { type: "error-text", value: APPROVED_CALL_INTERRUPTED_MESSAGE }],
  ]);
});

it("leaves a call the cancellation stopped before it started without a result", async () => {
  const controller = new AbortController();
  controller.abort(new TurnCancelledError());
  const unstarted = tool("unstarted", async () => "never");
  const execute = vi.spyOn(unstarted, "execute");

  const result = await runApprovedCalls({
    abortSignal: controller.signal,
    messages: [],
    publish: async () => {},
    view,
    approvals: [approval("call-unstarted", "unstarted")],
    tools: new Map([["unstarted", unstarted]]),
  });

  expect(execute).not.toHaveBeenCalled();
  expect(result.settled).toEqual([]);
});

function challenge(attemptId: string): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { kind: "redirect", url: `https://example.test/${attemptId}` },
    hookUrl: `https://example.test/hook/${attemptId}`,
    name: "github",
  } as AuthorizationChallenge;
}

function signInRow(interactionId: string): InteractionRow {
  return {
    interactionId,
    introducedAt: 0,
    startedAt: "1970-01-01T00:00:00.000Z",
    request: { kind: "sign-in", prompt: "Sign in to GitHub", signIn: { name: "github" } },
    status: "open",
    subject: { callId: `call-${interactionId}` },
  };
}

function stoppedOn(callId: string, attemptId: string): ApprovedCall {
  return { ...approval(callId, callId), signIns: [challenge(attemptId)] };
}

function completion(attemptId: string): AuthorizationResult {
  return {
    attemptId,
    callback: { params: {} },
    hookUrl: `https://example.test/hook/${attemptId}`,
  } as AuthorizationResult;
}

/** A session whose sign-ins stay open as far as `view` says, so only the reports dedupe them. */
function signInSession(...attemptIds: string[]) {
  const published: SessionEvent[] = [];
  const view = () => ({
    projection: {
      ...initialSessionProjection(),
      view: {
        ...emptySessionView(),
        interactions: Object.fromEntries(attemptIds.map((id) => [id, signInRow(id)])),
      },
    },
  });
  const publish = async (publication: Parameters<typeof eventsOf>[0]) => {
    published.push(...eventsOf(publication));
  };
  const settled = (attemptId: string) =>
    published.filter(
      (event) => event.type === "interaction.settled" && event.data.interactionId === attemptId,
    );
  return { publish, settled, view };
}

it("reports each group's sign-in while its call holds, with one reporter for the batch", async () => {
  const session = signInSession("attempt-a", "attempt-b");
  const reports = signInReports(session);
  const calls = [stoppedOn("call-a", "attempt-a"), stoppedOn("call-b", "attempt-b")];
  const completed = reports.completed(calls);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seenWhileHeld: Record<string, number> = {};
  const holding = (attemptId: string) =>
    tool(`call-${attemptId.slice(-1)}`, async () => {
      await completed(completion(attemptId));
      seenWhileHeld[attemptId] = session.settled(attemptId).length;
      await held;
      return "done";
    });
  // Two asking steps resume together: each group runs its own calls, as the intake does.
  const groups = calls.map((call) =>
    runApprovedCalls({
      abortSignal: undefined,
      messages: [],
      publish: session.publish,
      view: session.view,
      signIns: reports,
      approvals: [call],
      tools: new Map([[call.call.toolName, holding(call.signIns![0]!.attemptId!)]]),
    }),
  );
  await vi.waitFor(() => expect(Object.keys(seenWhileHeld)).toHaveLength(2));
  expect(seenWhileHeld).toEqual({ "attempt-a": 1, "attempt-b": 1 });
  release();
  await Promise.all(groups);
  expect(session.settled("attempt-a")).toHaveLength(1);
  expect(session.settled("attempt-b")).toHaveLength(1);
});

it("settles a sign-in once when two calls complete it at the same time", async () => {
  const session = signInSession("attempt-shared");
  const reports = signInReports(session);
  // The intake gives the shared sign-in to the first call; both calls still complete it.
  const calls = [stoppedOn("probe", "attempt-shared"), { ...approval("publish", "publish") }];
  const completed = reports.completed(calls);
  const completing = (name: string) =>
    tool(name, async () => {
      await completed(completion("attempt-shared"));
      return "done";
    });

  await runApprovedCalls({
    abortSignal: undefined,
    messages: [],
    publish: session.publish,
    view: session.view,
    signIns: reports,
    approvals: calls,
    tools: new Map([
      ["probe", completing("probe")],
      ["publish", completing("publish")],
    ]),
  });

  expect(session.settled("attempt-shared").map((event) => event.data)).toEqual([
    expect.objectContaining({ interactionId: "attempt-shared", outcome: "accepted" }),
  ]);
});
