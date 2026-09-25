import { e2eModel } from "@eve-e2e/config";
import type { EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";

import type { LifecycleControlEvent } from "../agent/lib/lifecycle-control.js";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const SESSION_INITIATOR_AUTHORIZATION = "Bearer e2e-task-session-initiator";
const LATER_PARENT_CALLER_AUTHORIZATION = "Bearer e2e-task-later-parent-caller";
const ANONYMOUS_TASK_CREATOR_HEADER = "x-eve-fixture-anonymous-task-creator";

export default defineTaskEval({
  description:
    "A schedule-shaped background task with no current principal keeps the session initiator after a later turn changes the current caller.",
  tags: ["real-model"],
  transition: {
    primary: "task.dispatch.start.accepted-acknowledged",
    dimensions: { transport: "local" },
  },
  async test(t) {
    const modelId = e2eModel();
    if (typeof modelId !== "string")
      throw new Error("Auth snapshot coverage requires a real model.");

    // One authenticated caller creates the session and remains its initiator.
    const firstTurn = await t.send("TASK-AUTH-SNAPSHOT-ROOT", {
      taskDeliveryPolicy: "cohort",
      headers: { authorization: SESSION_INITIATOR_AUTHORIZATION },
    });
    const session = firstTurn.session;
    firstTurn.expectOk();
    firstTurn.messageIncludes("TASK-AUTH-SNAPSHOT-ROOT-ACK");
    firstTurn.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    // The first authenticated turn establishes the only session initiator.
    await t.require(
      firstTurn.requireToolCall("snapshot_whoami").output,
      equals({ current: "session-initiator", initiator: "session-initiator" }),
    );

    // A route-authenticated, schedule-shaped turn has no current session principal.
    const key = crypto.randomUUID();
    const started = await session.send(`TASK-AUTH-SNAPSHOT ${key}`, {
      taskDeliveryPolicy: "cohort",
      headers: { [ANONYMOUS_TASK_CREATOR_HEADER]: "1" },
    });
    started.expectOk();
    started.messageIncludes("TASK-AUTH-SNAPSHOT-STARTED");
    started.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    // The schedule-shaped turn has no current principal but retains the session initiator.
    await t.require(
      started.requireToolCall("snapshot_whoami").output,
      equals({ current: null, initiator: "session-initiator" }),
    );
    const sessionId = started.sessionId;
    if (sessionId === undefined) throw new Error("The task has no parent session.");

    const gateToken = await waitForGate(t, sessionId, key);

    // Another authenticated caller takes the last parent turn before nested dispatch.
    const lastParentTurn = await session.send("TASK-AUTH-SNAPSHOT-LATER", {
      taskDeliveryPolicy: "cohort",
      headers: { authorization: LATER_PARENT_CALLER_AUTHORIZATION },
    });
    lastParentTurn.expectOk();
    lastParentTurn.messageIncludes("TASK-AUTH-SNAPSHOT-LATER-ACK");
    lastParentTurn.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    // The later parent turn changes only the current principal.
    await t.require(
      lastParentTurn.requireToolCall("snapshot_whoami").output,
      equals({ current: "later-parent-caller", initiator: "session-initiator" }),
    );

    await releaseGate(t, sessionId, key, gateToken);
    const childSessionId = await waitForSubagent(t, lastParentTurn.session);
    const child = await t.target.watchTurn(childSessionId).result();
    child.expectOk();
    child.noFailedActions();
    child.event("step.started", { data: { modelId } });
    child.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    // Nested dispatch uses the task creator's null current principal, not the later caller.
    await t.require(
      child.requireToolCall("snapshot_whoami").output,
      equals({ current: null, initiator: "session-initiator" }),
    );
  },
});

async function waitForGate(t: EveEvalContext, sessionId: string, key: string): Promise<string> {
  for (let index = 0; index < 2; index += 1) {
    const response = await t.target.fetch(
      `/eve/v1/task-lifecycle/${encodeURIComponent(sessionId)}/next`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, index }),
        signal: t.signal,
      },
    );
    await t.require(response.status, equals(200));
    const event = (await response.json()) as LifecycleControlEvent;
    if (event.kind === "gate" && event.token !== undefined) return event.token;
  }
  throw new Error("The background task did not pause before starting its subagent.");
}

async function releaseGate(
  t: EveEvalContext,
  sessionId: string,
  key: string,
  token: string,
): Promise<void> {
  const response = await t.target.fetch(
    `/eve/v1/task-lifecycle/${encodeURIComponent(sessionId)}/release`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, token }),
      signal: t.signal,
    },
  );
  await t.require(response.status, equals(200));
  await t.require(await response.json(), equals({ released: true }));
}

async function waitForSubagent(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
): Promise<string> {
  let session = initialSession;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("The task has no parent session.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Subagent wait"),
    });
    const turn = await live.result();
    turn.expectOk();
    session = live.session;
    const called = turn.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "auth-snapshot-worker",
    );
    if (called?.type === "subagent.called") return called.data.childSessionId;
  }
  throw new Error("The background task did not start its subagent.");
}
