import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireSessionStreamIndex,
  requireTaskView,
  type TaskEvalSessionDriver,
  waitForCompletedTask,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const AUTHORIZATION_CODE = "c7-deterministic-code";
const AUTHORIZATION_NAME = "c7-task-authorization";

type AuthorizationEvent = Extract<
  EveEvalTurn["events"][number],
  { readonly type: "authorization.completed" | "authorization.required" }
>;

/** A task-owned interactive authorization keeps its distinct lifecycle and task blocker. */
export default defineTaskEval({
  description:
    "A background child surfaces interactive authorization, resumes through its webhook, and completes without masquerading as ordinary input.",
  transition: {
    primary: "task.authorization.callback.accepted-current-attempt",
    dimensions: { transport: "local" },
  },
  async test(t) {
    const started = await t.send("TASK-C7-AUTHORIZATION");
    started.expectOk();
    started.messageIncludes("TASK-C7-STARTED");
    started.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "approval-worker" },
    });
    const taskId = requireBackgroundTaskId(started);

    const required = await waitForAuthorizationEvent(t, t, started, "authorization.required");
    required.turn.event("authorization.required", {
      count: 1,
      data: { authorization: { userCode: AUTHORIZATION_CODE }, name: AUTHORIZATION_NAME },
    });
    required.turn.notEvent("input.requested");

    const webhookUrl = required.event.data.webhookUrl;
    if (webhookUrl === undefined) throw new Error("C7 authorization.required had no webhook URL.");
    const callback = new URL(webhookUrl);
    callback.searchParams.set("code", AUTHORIZATION_CODE);
    // Callback URLs no longer carry a deployment-protection bypass, so the
    // request goes through the authenticated target client instead of a bare
    // fetch that a protected deployment would redirect to SSO.
    const callbackResponse = await t.target.fetch(`${callback.pathname}${callback.search}`, {
      redirect: "manual",
    });
    await t.require(callbackResponse.status, equals(303));
    await t.require(
      callbackResponse.headers.get("location"),
      equals("/eve/v1/connections/authorization-complete"),
    );

    const completed = await waitForAuthorizationEvent(
      t,
      required.session,
      undefined,
      "authorization.completed",
    );
    completed.turn.event("authorization.completed", {
      count: 1,
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });

    const terminal = await waitForCompletedTask(
      t,
      completed.session,
      "TASK-C7-AUTHORIZATION-VERIFY",
      taskId,
    );
    const terminalView = requireTaskView(terminal.requireToolCall("task_cancel").output, taskId);
    await t.require(
      terminalView,
      satisfies(
        (view: Record<string, unknown>) =>
          Reflect.get(view, "status") === "completed" &&
          Reflect.get(Reflect.get(view, "lastOutput") ?? {}, "type") === "result" &&
          Reflect.get(Reflect.get(view, "lastOutput") ?? {}, "data") ===
            "C7-AUTHORIZATION-COMPLETE",
        "authorized child reaches its deterministic terminal output",
      ),
    );
    t.event("authorization.required", {
      count: 1,
      data: { authorization: { userCode: AUTHORIZATION_CODE }, name: AUTHORIZATION_NAME },
    });
    t.event("authorization.completed", {
      count: 1,
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });
    t.eventOrder([{ type: "authorization.required" }, { type: "authorization.completed" }]);
    t.notEvent("input.requested");
    t.noFailedActions();
  },
});

async function waitForAuthorizationEvent<TType extends AuthorizationEvent["type"]>(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn | undefined,
  type: TType,
): Promise<{
  readonly event: Extract<AuthorizationEvent, { readonly type: TType }>;
  readonly session: TaskEvalSessionDriver;
  readonly turn: EveEvalTurn;
}> {
  let session = initialSession;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = turn?.events.find(
      (candidate): candidate is Extract<AuthorizationEvent, { readonly type: TType }> =>
        candidate.type === type,
    );
    if (event !== undefined) return { event, session, turn: turn! };

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Authorization event wait has no session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Authorization event wait"),
    });
    turn = await live.result();
    session = live.session;
  }
  throw new Error(`Task did not surface ${type} after ten turns.`);
}
