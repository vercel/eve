import {
  defineEval,
  type EveEvalContext,
  type EveEvalSession,
  type EveEvalToolCall,
  type EveEvalTurn,
} from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { WORKSPACE_FORWARDING_MARKER, WORKSPACE_LOOKUP_MESSAGE } from "../constants";

const ALICE_WORKSPACE_LABEL = "Maple Studio";
const BOB_WORKSPACE_LABEL = "Cedar Workshop";
const BOB_AUTHORIZATION = "Bearer e2e-workspace-label-bob";
const OBSERVER_AUTHORIZATION = "Bearer e2e-workspace-label-observer";
const CREATE_CHILD_MESSAGE = [
  WORKSPACE_FORWARDING_MARKER,
  "Use remote-loopback with this message:",
  JSON.stringify(WORKSPACE_LOOKUP_MESSAGE),
].join(" ");
const CONTINUE_CHILD_MESSAGE = [
  WORKSPACE_FORWARDING_MARKER,
  "Continue that same remote-loopback agent using its taskId with this message:",
  JSON.stringify(WORKSPACE_LOOKUP_MESSAGE),
].join(" ");
const CLARIFICATION = [
  "Continue the existing agent.",
  "The service resolves workspace membership from the authenticated caller on every lookup.",
  "Do not reuse previous answers; let the service deny access when no membership exists.",
].join(" ");

/**
 * Each caller's remote-loopback call resolves only that caller's workspace membership. A
 * continuation reaches the same remote child, and only the task's creator can continue it,
 * so other callers start children of their own.
 */
export default defineEval({
  tags: ["principal-forwarding"],
  description:
    "Remote children read the workspace membership of the caller that started them and deny a caller with none.",
  async test(t) {
    // Alice creates the child and reads her workspace label.
    const aliceTurn = await t.send(CREATE_CHILD_MESSAGE);
    const aliceParent = await waitForRemoteChild(t, aliceTurn.session, aliceTurn);
    const { childSessionId, taskId } = aliceParent;
    const aliceChild = await t.target.watchTurn(childSessionId).result();
    await expectWorkspaceReads(t, aliceChild, ALICE_WORKSPACE_LABEL);

    // Alice continues the same child by its taskId and still reads her own label.
    const continuedTurn = await aliceParent.session.send(CONTINUE_CHILD_MESSAGE);
    const continued = await waitForRemoteChild(t, aliceParent.session, continuedTurn, aliceParent);
    const continuedChild = await t.target
      .watchTurn(childSessionId, { startIndex: aliceChild.events.length })
      .result();
    await expectWorkspaceReads(t, continuedChild, ALICE_WORKSPACE_LABEL);

    // Bob asks in the same parent session. He cannot reach Alice's task, so his call
    // starts his own child, which must resolve Bob's workspace label, not Alice's.
    const bobTurn = await continued.session.send(CREATE_CHILD_MESSAGE, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    const bobParent = await waitForRemoteChild(
      t,
      continued.session,
      bobTurn,
      undefined,
      BOB_AUTHORIZATION,
    );
    t.check(bobParent.taskId !== taskId, equals(true)).label("Bob starts his own task");
    const bobChild = await t.target.watchTurn(bobParent.childSessionId).result();
    await expectWorkspaceReads(t, bobChild, BOB_WORKSPACE_LABEL);

    // A grantless observer's child must be denied rather than reuse either membership.
    const observerTurn = await bobParent.session.send(CREATE_CHILD_MESSAGE, {
      headers: { authorization: OBSERVER_AUTHORIZATION },
    });
    const observerParent = await waitForRemoteChild(
      t,
      bobParent.session,
      observerTurn,
      undefined,
      OBSERVER_AUTHORIZATION,
    );
    const observerChild = await t.target.watchTurn(observerParent.childSessionId).result();
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

    t.event("task.started", { data: { name: "remote-loopback", taskId }, count: 2 })
      .soft()
      .label("Alice's continuation reaches her task");
    t.event("agent.started", { data: { name: "remote-loopback" }, count: 3 })
      .soft()
      .label("one remote child per caller");
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

/** The remote-loopback agent task and the remote session every call to it reaches. */
interface RemoteChild {
  readonly childSessionId: string;
  readonly taskId: string;
}

async function waitForRemoteChild(
  t: EveEvalContext,
  initial: SessionCursor,
  initialTurn: EveEvalTurn,
  expected?: RemoteChild,
  authorization?: string,
): Promise<RemoteChild & { readonly session: SessionCursor }> {
  let session = initial;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Remote child wait has no parent session cursor.");
    }
    turn.expectOk();
    const child = findRemoteChild(turn, expected);
    if (child !== undefined) return { ...child, session };
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

/** A later call reaches the task's session, so only the first call announces it. */
function findRemoteChild(turn: EveEvalTurn, expected?: RemoteChild): RemoteChild | undefined {
  for (const event of turn.events) {
    if (event.type !== "task.started" || event.data.name !== "remote-loopback") continue;
    if (expected !== undefined) {
      if (event.data.taskId !== expected.taskId) {
        throw new Error("The parent turn did not continue the existing remote-loopback task.");
      }
      return expected;
    }
    const started = turn.events.find(
      (candidate) =>
        candidate.type === "agent.started" && candidate.data.callId === event.data.callId,
    );
    if (started?.type === "agent.started") {
      return { childSessionId: started.data.sessionId, taskId: event.data.taskId };
    }
  }
  return undefined;
}
