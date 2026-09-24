import {
  EveAgentStore,
  defaultMessageReducer,
  type EveDynamicToolPart,
  type EveMessageData,
} from "eve/client";
import { defineEval, type EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";

const ALICE = { "x-eve-fixture-user": "alice" };
const TOOL = "authorized-change";

type Store = EveAgentStore<EveMessageData>;

function toolPart(store: Store, callId: string): EveDynamicToolPart {
  const parts = store.snapshot.data.messages.flatMap((message) => message.parts);
  const matches = parts.filter(
    (part): part is EveDynamicToolPart =>
      part.type === "dynamic-tool" && part.toolCallId === callId,
  );
  if (matches.length !== 1) throw new Error(`Expected one projected tool part for ${callId}.`);
  return matches[0]!;
}

async function settles<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within 20s.`)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectAnswerable(
  t: EveEvalContext,
  store: Store,
  callId: string,
  requestId: string,
) {
  await t.require(store.snapshot.status, equals("ready"));
  await t.require(store.snapshot.error, equals(undefined));
  const part = toolPart(store, callId);
  await t.require(part.state, equals("approval-requested"));
  await t.require(part.approval?.id, equals(requestId));
  await t.require(part.toolMetadata?.eve?.inputRequest?.requestId, equals(requestId));
  await t.require(part.toolMetadata?.eve?.inputResponse, equals(undefined));
  const cancel = await settles("Idle store cancellation", store.cancel());
  await t.require(cancel.status, equals("no_active_turn"));
  await t.require(store.snapshot.status, equals("ready"));
}

async function refuse(t: EveEvalContext, store: Store, callId: string, requestId: string) {
  const start = store.snapshot.events.length;
  await settles(
    "Refused approval submission",
    store.send({
      headers: ALICE,
      inputResponses: [{ requestId, optionId: "approve" }],
      signal: t.signal,
    }),
  );
  const events = store.snapshot.events.slice(start);
  const candidates = events
    .filter((event) => event.type === "approval.candidate")
    .filter((event) => event.data.requestId === requestId);
  await t.require(
    candidates.map((event) => event.data.outcome),
    equals(["pending", "rejected"]),
  );
  await t.require(candidates.at(-1)?.data.reason, equals("Wrong responder."));
  await t.require(
    events
      .filter((event) => event.type === "approval.candidate" || event.type === "session.waiting")
      .map((event) => event.type),
    equals(["approval.candidate", "approval.candidate", "session.waiting"]),
  );
  await t.require(events.at(-1)?.type, equals("session.waiting"));
  await t.require(
    events.filter(
      (event) =>
        event.type === "turn.started" ||
        event.type === "input.resolved" ||
        event.type === "approval.settled" ||
        event.type === "action.result",
    ).length,
    equals(0),
  );
  await expectAnswerable(t, store, callId, requestId);
  return candidates.at(-1)?.data.candidateId;
}

export default defineEval({
  description:
    "A refused approval returns the frontend to an answerable idle state, including after reload (#3757).",
  tags: ["hitl", "regression", "authorization", "client"],
  timeoutMs: 120_000,
  async test(t) {
    const host = `https://${crypto.randomUUID()}.invalid`;
    const originalFetch = globalThis.fetch;
    const stores: Store[] = [];
    // Keep deployment credentials in the eval target while exercising the real client transport.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === host
        ? t.target.fetch(`${url.pathname}${url.search}`, init)
        : originalFetch(input, init);
    };

    try {
      for (const decision of ["approve", "cancel"] as const) {
        t.log(
          `Alice prepares a change; after a refused answer and reload, finish with ${decision}.`,
        );
        const session = await t.session({
          headers: { ...ALICE, "x-eve-fixture-model": "continuation" },
        });
        const page = new EveAgentStore({
          host,
          headers: ALICE,
          initialSession: session.state,
          reducer: defaultMessageReducer(),
        });
        stores.push(page);
        await settles(
          "Initial approval request",
          page.send({ message: "Prepare an authorized change.", signal: t.signal }),
        );
        const parked = (await t.target.watchTurn(session.sessionId).result()).expectOk();
        const approval = parked.session.requireInputRequest({ toolName: TOOL });
        const { requestId } = approval;
        const callId = approval.action.callId;
        await expectAnswerable(t, page, callId, requestId);

        const firstCandidate = await refuse(t, page, callId, requestId);
        // Retrying on the same page must reach the policy again, not reuse the refused candidate.
        const retryCandidate = await refuse(t, page, callId, requestId);
        await t.require(retryCandidate !== firstCandidate, equals(true));
        page.reset();

        const reload = new EveAgentStore({
          host,
          headers: ALICE,
          initialSession: { sessionId: session.sessionId, streamIndex: 0 },
          reducer: defaultMessageReducer(),
        });
        stores.push(reload);
        await settles("Reload resume", reload.resume());
        await expectAnswerable(t, reload, callId, requestId);
        await t.require(
          reload.snapshot.events.filter(
            (event) =>
              event.type === "approval.candidate" &&
              event.data.requestId === requestId &&
              event.data.outcome === "rejected",
          ).length,
          equals(2),
        );
        const reloadedCandidate = await refuse(t, reload, callId, requestId);
        await t.require(reloadedCandidate !== retryCandidate, equals(true));

        t.log(
          decision === "approve"
            ? "The authorized responder approves Alice's still-pending change."
            : "Alice cancels her still-pending change instead of approving it.",
        );
        const startIndex = reload.snapshot.session!.streamIndex;
        await settles(
          "Final approval decision",
          reload.send({
            headers:
              decision === "approve" ? { "x-eve-fixture-user": "e2e-approval-responder" } : ALICE,
            inputResponses: [{ requestId, optionId: decision }],
            signal: t.signal,
          }),
        );
        await t.require(reload.snapshot.status, equals("ready"));
        await t.require(reload.snapshot.error, equals(undefined));
        const finished = (
          await t.target.watchTurn(session.sessionId, { startIndex }).result()
        ).expectOk();
        finished.event("approval.settled", {
          data: { requestId, outcome: decision === "approve" ? "approved" : "cancelled" },
          count: 1,
        });
        finished.event("input.resolved", {
          data: {
            resolutions: (items) =>
              items.some(
                (item) =>
                  item.requestId === requestId &&
                  item.outcome === (decision === "approve" ? "approved" : "denied"),
              ),
          },
          count: 1,
        });
        if (decision === "approve") {
          finished.calledTool(TOOL, { status: "completed", output: { executions: 1 }, count: 1 });
        } else {
          finished.event("action.result", {
            data: { result: { callId, toolName: TOOL }, status: "rejected" },
            count: 1,
          });
          finished.calledTool(TOOL, { status: "completed", count: 0 });
        }
        await t.require(toolPart(reload, callId).state === "approval-requested", equals(false));
        reload.reset();
      }
    } finally {
      for (const store of stores) store.reset();
      globalThis.fetch = originalFetch;
    }
  },
});
