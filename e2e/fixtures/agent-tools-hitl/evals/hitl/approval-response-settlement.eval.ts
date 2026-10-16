import { waitForStore } from "@eve-e2e/config/frontend";
import { EveAgentStore, type EveToolPart } from "eve/client";
import { defineEval, type EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";

const ALICE = {
  "x-eve-fixture-user": "alice",
  "x-eve-fixture-model": "continuation",
};
const TOOL = "authorized-change";

type Store = EveAgentStore;

function toolPart(store: Store, callId: string): EveToolPart {
  const parts = store.snapshot.messages.flatMap((message) => message.parts);
  const matches = parts.filter(
    (part): part is EveToolPart => part.type === "tool" && part.callId === callId,
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
  interactionId: string,
) {
  // The approval holds its turn open, and the store keeps following it live.
  await t.require(store.snapshot.status, equals("busy"));
  await t.require(store.snapshot.error, equals(undefined));
  const part = toolPart(store, callId);
  await t.require(part.state, equals("approval"));
  await t.require(part.interaction?.status, equals("open"));
  await t.require(part.interaction?.interactionId, equals(interactionId));
  await t.require(part.interaction?.answer, equals(undefined));
}

async function refuse(t: EveEvalContext, store: Store, callId: string, interactionId: string) {
  const start = store.snapshot.events.length;
  const accepted = await settles(
    "Refused approval submission",
    store.send({
      headers: ALICE,
      answers: [{ interactionId, optionId: "approve" }],
      signal: t.signal,
    }),
  );
  await waitForStore(
    store,
    (snapshot) => snapshot.view.deliveries[accepted.deliveryId]?.status === "settled",
    t.signal,
  );
  const events = store.snapshot.events.slice(start);
  const submitted = events.filter(
    (event) => event.type === "response.submitted" && event.data.interactionId === interactionId,
  );
  await t.require(submitted.length, equals(1));
  const responseId =
    submitted[0]?.type === "response.submitted" ? submitted[0].data.responseId : undefined;
  const settled = events.filter(
    (event) => event.type === "response.settled" && event.data.responseId === responseId,
  );
  await t.require(
    settled.map((event) => (event.type === "response.settled" ? event.data : undefined)),
    equals([{ outcome: "refused", reason: "Wrong responder.", responseId }]),
  );
  // The approval holds the turn, so a refused answer leaves it held.
  await t.require(
    events.filter(
      (event) =>
        event.type === "turn.started" ||
        event.type === "turn.settled" ||
        event.type === "interaction.settled" ||
        event.type === "call.settled",
    ).length,
    equals(0),
  );
  await expectAnswerable(t, store, callId, interactionId);
  return responseId;
}

export default defineEval({
  description:
    "A refused approval returns the frontend to an answerable state, including after reload (#3757).",
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
      for (const decision of ["approve", "deny"] as const) {
        t.log(
          `Alice prepares a change; after a refused answer and reload, finish with ${decision}.`,
        );
        const session = await t.session({ headers: ALICE });
        const page = new EveAgentStore({
          host,
          headers: ALICE,
          initialSession: session.state,
        });
        stores.push(page);
        const accepted = await settles(
          "Initial approval request",
          page.send({ message: "Prepare an authorized change.", signal: t.signal }),
        );
        await waitForStore(
          page,
          (snapshot) => snapshot.view.deliveries[accepted.deliveryId]?.status === "settled",
          t.signal,
        );
        const parked = (await t.target.attach(session.id).watch().result()).expectOk();
        const approval = parked.session.requireInteraction({ toolName: TOOL });
        const { interactionId } = approval;
        const callId = approval.call!.callId;
        await expectAnswerable(t, page, callId, interactionId);

        const firstCandidate = await refuse(t, page, callId, interactionId);
        // Retrying on the same page must reach the policy again, not reuse the refused candidate.
        const retryCandidate = await refuse(t, page, callId, interactionId);
        await t.require(retryCandidate !== firstCandidate, equals(true));
        page.newSession();

        const reload = new EveAgentStore({
          host,
          headers: ALICE,
          initialSession: { sessionId: session.id, streamIndex: 0 },
        });
        stores.push(reload);
        await settles("Reload resume", reload.resume());
        await expectAnswerable(t, reload, callId, interactionId);
        await t.require(
          reload.snapshot.events.filter(
            (event) => event.type === "response.settled" && event.data.outcome === "refused",
          ).length,
          equals(2),
        );
        const reloadedCandidate = await refuse(t, reload, callId, interactionId);
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
            answers: [{ interactionId, optionId: decision }],
            signal: t.signal,
          }),
        );
        await waitForStore(
          reload,
          (snapshot) =>
            snapshot.status === "idle" &&
            snapshot.view.interactions[interactionId]?.status === "settled",
          t.signal,
        );
        await t.require(reload.snapshot.status, equals("idle"));
        await t.require(reload.snapshot.error, equals(undefined));
        const finished = (
          await t.target.attach(session.id, { startIndex }).watch().result()
        ).expectOk();
        finished.event("interaction.settled", {
          data: {
            interactionId: interactionId,
            outcome: decision === "approve" ? "accepted" : "declined",
          },
          count: 1,
        });
        if (decision === "approve") {
          finished.calledTool(TOOL, { status: "completed", output: { executions: 1 }, count: 1 });
        } else {
          finished.event("call.settled", { data: { callId, outcome: "rejected" }, count: 1 });
          finished.calledTool(TOOL, { status: "completed", count: 0 });
        }
        await t.require(toolPart(reload, callId).interaction?.status, equals("settled"));
        reload.newSession();
      }
    } finally {
      for (const store of stores) store.newSession();
      globalThis.fetch = originalFetch;
    }
  },
});
