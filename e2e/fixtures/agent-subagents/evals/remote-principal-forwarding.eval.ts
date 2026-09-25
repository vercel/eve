import {
  defineEval,
  type EveEvalContext,
  type EveEvalSession,
  type EveEvalToolCall,
  type EveEvalTurn,
} from "eve/evals";
import { satisfies } from "eve/evals/expect";

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

/** A remote child serves only the user who started it; each caller's lookups resolve only their own membership. */
export default defineEval({
  tags: ["principal-forwarding"],
  description:
    "Alice resumes her remote child, while Bob and a caller with no membership are refused it and each get their own.",
  async test(t) {
    // Alice creates the child and reads her workspace label.
    const aliceTurn = await t.send(CREATE_CHILD_MESSAGE);
    const aliceParent = await waitForRemoteChild(t, aliceTurn.session, aliceTurn);
    const childSessionId = aliceParent.childSessionId;
    const aliceTaskId = aliceParent.taskId;
    const aliceChild = await t.target.watchTurn(childSessionId).result();
    await expectWorkspaceReads(t, aliceChild, ALICE_WORKSPACE_LABEL);

    // Alice continues her own child, and the continuation still runs as her.
    const resumeTurn = await aliceParent.session.send(CONTINUE_CHILD_MESSAGE);
    const resumed = await waitForRemoteChild(t, aliceParent.session, resumeTurn, {
      expectedSessionId: childSessionId,
    });
    const resumedChild = await t.target
      .watchTurn(childSessionId, { startIndex: aliceChild.events.length })
      .result();
    await expectWorkspaceReads(t, resumedChild, ALICE_WORKSPACE_LABEL);

    // Bob names Alice's child. It refuses him, so his lookup runs in a child of his own.
    const bobTurn = await resumed.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    const bobParent = await waitForRemoteChild(t, resumed.session, bobTurn, {
      authorization: BOB_AUTHORIZATION,
      otherThan: childSessionId,
    });
    expectRefused(bobParent.turn, aliceTaskId);
    const bobChild = await t.target.watchTurn(bobParent.childSessionId).result();
    await expectWorkspaceReads(t, bobChild, BOB_WORKSPACE_LABEL);

    // The observer, who has no membership, names Alice's agent too and is refused;
    // its own child is denied access.
    const observerTurn = await bobParent.session.send(CONTINUE_CHILD_MESSAGE, {
      headers: { authorization: OBSERVER_AUTHORIZATION },
    });
    const observerParent = await waitForRemoteChild(t, bobParent.session, observerTurn, {
      authorization: OBSERVER_AUTHORIZATION,
      otherThan: childSessionId,
    });
    expectRefused(observerParent.turn, aliceTaskId);
    if (observerParent.childSessionId === bobParent.childSessionId) {
      throw new Error("The observer's lookup ran in Bob's remote child.");
    }
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

    t.event("task.started", { data: { name: "remote-loopback" }, count: 4 })
      .soft()
      .label("no repeated delegation");
    t.succeeded();
  },
});

/** The turn named Alice's agent, and the agent refused a caller other than Alice. */
function expectRefused(turn: EveEvalTurn, aliceTaskId: string): void {
  turn.calledTool("remote-loopback", { input: { taskId: aliceTaskId }, status: "failed" });
  turn.event("action.result", {
    data: {
      result: {
        kind: "tool-result",
        output: { code: "TASK_OTHER_PRINCIPAL" },
        toolName: "remote-loopback",
      },
      status: "failed",
    },
  });
}

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
  options: {
    readonly authorization?: string;
    readonly expectedSessionId?: string;
    readonly otherThan?: string;
  } = {},
): Promise<{
  readonly childSessionId: string;
  readonly session: SessionCursor;
  readonly taskId: string;
  readonly turn: EveEvalTurn;
}> {
  const { authorization, expectedSessionId, otherThan } = options;
  let session = initial;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Remote child wait has no parent session cursor.");
    }
    turn.expectOk();
    const call = turn.events.find(
      (event) => event.type === "task.started" && event.data.name === "remote-loopback",
    );
    const childSessionId = call?.type === "task.started" ? call.data.child?.sessionId : undefined;
    if (call?.type === "task.started" && childSessionId !== undefined) {
      if (expectedSessionId !== undefined && childSessionId !== expectedSessionId) {
        throw new Error("The parent turn did not continue the existing remote child.");
      }
      if (childSessionId === otherThan) {
        throw new Error("Another user's remote child took this caller's lookup.");
      }
      return { childSessionId, session, taskId: call.data.taskId, turn };
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
