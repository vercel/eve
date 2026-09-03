import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";

const ALICE_PRIVATE_DATA = "ALICE_PRIVATE_DM_7K4M";
const BOB_PRIVATE_DATA = "BOB_PRIVATE_DM_9P2R";
const BOB_AUTHORIZATION = "Bearer e2e-principal-forwarding-bob";
const OBSERVER_AUTHORIZATION = "Bearer e2e-principal-forwarding-observer";
const CHILD_MESSAGE = [
  "[forward-auth:child] Call read-private-data exactly once.",
  "If it succeeds, reply with only its privateData value.",
  "If it fails, reply with only ACCESS_DENIED.",
].join(" ");
const CREATE_CHILD_MESSAGE = [
  "[forward-auth:create] Use remote-loopback exactly once with this message:",
  JSON.stringify(CHILD_MESSAGE),
  "Reply with only the child's output.",
].join(" ");
const CONTINUE_CHILD_MESSAGE = [
  "[forward-auth:continue] Continue that same remote-loopback agent using its agentId with this message:",
  JSON.stringify(CHILD_MESSAGE),
  "Reply with only the child's output.",
].join(" ");

/** Three users resume one remote child; each tool call resolves only its current caller's grant. */
export default defineEval({
  tags: ["principal-forwarding", "real-model"],
  description:
    "A persistent remote child switches between two user grants and denies a third caller with none.",
  async test(t) {
    // Alice creates the child and reads with her own grant.
    await t.send(CREATE_CHILD_MESSAGE);
    const aliceParent = await waitForRemoteChild(t, t);
    const childSessionId = aliceParent.childSessionId;
    const aliceChild = await t.target.watchTurn(childSessionId).result();
    let childEventCount = aliceChild.events.length;

    // Bob continues the same child and must resolve Bob's grant, not Alice's.
    await aliceParent.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    const bobParent = await waitForRemoteChild(t, aliceParent.session, childSessionId);
    const bobChild = await t.target
      .watchTurn(childSessionId, { startIndex: childEventCount })
      .result();
    childEventCount += bobChild.events.length;

    // A grantless observer continues it once more. Reusing either prior bearer
    // would complete this call; correct per-turn scoping makes it fail.
    await bobParent.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: OBSERVER_AUTHORIZATION },
    });
    await waitForRemoteChild(t, bobParent.session, childSessionId);
    const observerChild = await t.target
      .watchTurn(childSessionId, { startIndex: childEventCount })
      .result();

    aliceChild.calledTool("read-private-data", {
      count: 1,
      output: { privateData: ALICE_PRIVATE_DATA },
      status: "completed",
    });
    bobChild.calledTool("read-private-data", {
      count: 1,
      output: { privateData: BOB_PRIVATE_DATA },
      status: "completed",
    });
    observerChild.calledTool("read-private-data", { count: 1, status: "failed" });
    observerChild.calledTool("read-private-data", { count: 0, status: "completed" });
    observerChild.event("action.result", {
      count: 1,
      data: {
        error: { message: /No OAuth grant exists for e2e-observer/ },
        result: { kind: "tool-result", toolName: "read-private-data" },
        status: "failed",
      },
    });

    t.calledSubagent("remote-loopback", { count: 3 });
    t.succeeded();
  },
});

type SessionCursor = Pick<EveEvalSession, "send" | "sessionId" | "state">;

async function waitForRemoteChild(
  t: EveEvalContext,
  initial: SessionCursor,
  expectedSessionId?: string,
): Promise<{ readonly childSessionId: string; readonly session: SessionCursor }> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Remote child wait has no parent session cursor.");
    }
    const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
    const turn = await live.result();
    const call = turn.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "remote-loopback",
    );
    if (call?.type === "subagent.called") {
      if (expectedSessionId !== undefined && call.data.childSessionId !== expectedSessionId) {
        throw new Error("The parent turn did not continue the existing remote child.");
      }
      return { childSessionId: call.data.childSessionId, session: live.session };
    }
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error("The parent did not call remote-loopback after five turns.");
}
