import {
  defineEval,
  type EveEvalContext,
  type EveEvalSession,
  type EveEvalToolCall,
  type EveEvalTurn,
} from "eve/evals";
import { satisfies } from "eve/evals/expect";

const ALICE_WORKSPACE_LABEL = "Maple Studio";
const BOB_WORKSPACE_LABEL = "Cedar Workshop";
const BOB_AUTHORIZATION = "Bearer e2e-workspace-label-bob";
const OBSERVER_AUTHORIZATION = "Bearer e2e-workspace-label-observer";
const CHILD_MESSAGE = [
  "Call read-workspace-label to look up the workspace name for the current caller.",
  "Make a fresh lookup: earlier answers in this session may belong to a different caller.",
  "Report the returned name, or explain if access is denied.",
].join(" ");
const CREATE_CHILD_MESSAGE = [
  "Use remote-loopback with this message:",
  JSON.stringify(CHILD_MESSAGE),
].join(" ");
const CONTINUE_CHILD_MESSAGE = [
  "A different user is making this request now.",
  "Continue that same remote-loopback agent using its agentId with this message:",
  JSON.stringify(CHILD_MESSAGE),
].join(" ");
const CLARIFICATION = [
  "Continue the existing agent.",
  "The service resolves workspace membership from the authenticated caller on every lookup.",
  "Do not reuse previous answers; let the service deny access when no membership exists.",
].join(" ");

/** Three users resume one remote child; each tool call resolves only its current caller's workspace membership. */
export default defineEval({
  tags: ["principal-forwarding", "real-model"],
  description:
    "A persistent remote child switches between two workspace memberships and denies a third caller with none.",
  async test(t) {
    // Alice creates the child and reads her workspace label.
    const aliceTurn = await t.send(CREATE_CHILD_MESSAGE);
    const aliceParent = await waitForRemoteChild(t, t, aliceTurn);
    const childSessionId = aliceParent.childSessionId;
    const aliceChild = await t.target.watchTurn(childSessionId).result();
    await expectWorkspaceReads(t, aliceChild, ALICE_WORKSPACE_LABEL);
    let childEventCount = aliceChild.events.length;

    // Bob continues the same child and must resolve Bob's workspace label, not Alice's.
    const bobTurn = await aliceParent.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    const bobParent = await waitForRemoteChild(
      t,
      aliceParent.session,
      bobTurn,
      childSessionId,
      BOB_AUTHORIZATION,
    );
    const bobChild = await t.target
      .watchTurn(childSessionId, { startIndex: childEventCount })
      .result();
    await expectWorkspaceReads(t, bobChild, BOB_WORKSPACE_LABEL);
    childEventCount += bobChild.events.length;

    // A grantless observer continues it once more. Reusing either prior membership
    // would complete this call; correct per-turn scoping denies access.
    const observerTurn = await bobParent.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: OBSERVER_AUTHORIZATION },
    });
    await waitForRemoteChild(
      t,
      bobParent.session,
      observerTurn,
      childSessionId,
      OBSERVER_AUTHORIZATION,
    );
    const observerChild = await t.target
      .watchTurn(childSessionId, { startIndex: childEventCount })
      .result();
    observerChild.expectOk();
    observerChild.calledTool("read-workspace-label", { status: "failed" });
    observerChild.calledTool("read-workspace-label", { count: 0, status: "completed" });
    observerChild.event("action.result", {
      data: {
        error: { message: /No workspace membership exists for e2e-observer/ },
        result: { kind: "tool-result", toolName: "read-workspace-label" },
        status: "failed",
      },
    });

    t.calledSubagent("remote-loopback", { count: 3 }).soft().label("no repeated delegation");
    t.succeeded();
  },
});

async function expectWorkspaceReads(
  t: EveEvalContext,
  turn: EveEvalTurn,
  workspaceLabel: string,
): Promise<void> {
  turn.expectOk();
  await t.require(
    turn.toolCalls.filter(
      (call) => call.name === "read-workspace-label" && call.status === "completed",
    ),
    satisfies(
      (calls: readonly EveEvalToolCall[]) =>
        calls.length > 0 &&
        calls.every(
          (call) =>
            (call.output as { workspaceLabel?: unknown } | null | undefined)?.workspaceLabel ===
            workspaceLabel,
        ),
      "every workspace read uses the current caller",
    ),
  );
}

type SessionCursor = Pick<EveEvalSession, "respond" | "send" | "sessionId" | "state">;

async function waitForRemoteChild(
  t: EveEvalContext,
  initial: SessionCursor,
  initialTurn: EveEvalTurn,
  expectedSessionId?: string,
  authorization?: string,
): Promise<{ readonly childSessionId: string; readonly session: SessionCursor }> {
  let session = initial;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Remote child wait has no parent session cursor.");
    }
    turn.expectOk();
    const call = turn.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "remote-loopback",
    );
    if (call?.type === "subagent.called") {
      if (expectedSessionId !== undefined && call.data.childSessionId !== expectedSessionId) {
        throw new Error("The parent turn did not continue the existing remote child.");
      }
      return { childSessionId: call.data.childSessionId, session };
    }
    turn.noFailedActions();
    if (attempt === 4) break;
    if (turn.inputRequests.length > 0) {
      const responses = turn.inputRequests.map((request) => {
        if (request.kind !== "question" || request.allowFreeform === false) {
          throw new Error("The remote child continuation requires unsupported input.");
        }
        return { requestId: request.requestId, text: CLARIFICATION };
      });
      turn = await session.respond(responses, {
        headers: authorization === undefined ? undefined : { authorization },
      });
    } else {
      const live = t.target.watchTurn(session.sessionId, {
        startIndex: session.state.streamIndex,
      });
      turn = await live.result();
      session = live.session;
    }
  }
  throw new Error("The parent did not call remote-loopback after five turns.");
}
