import type { SessionAuthContext } from "eve/context";
import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { localDevAuth, sessionContext, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import hook from "./thread-role-guard";

const actionResult = hook.events?.["action.result"];
const turnStarted = hook.events?.["turn.started"];
if (!(actionResult && turnStarted)) {
  throw new Error("Expected action.result and turn.started handlers.");
}

const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });

/* Stream metadata eve stamps on every recorded event. */
const meta = { at: "2026-10-10T00:00:00.000Z", id: "event-1" };

/* Hook context for a turn whose caller is `current`, with an observable cancel. */
const hookContext = (current: SessionAuthContext) => {
  const cancel = vi.fn<HookContext["cancel"]>();
  const ctx: HookContext = {
    ...sessionContext({ current }),
    agent: { name: "test" },
    cancel,
    channel: { kind: "channel:slack" },
  };
  return { cancel, ctx };
};

interface ResultOptions {
  isError?: boolean;
  status?: HookEvent<"action.result">["data"]["status"];
  toolName?: string;
}

/* One tool call's result in turn-1. */
const resultEvent = ({
  isError,
  status = "completed",
  toolName = "run_sql",
}: ResultOptions = {}): HookEvent<"action.result"> => {
  const result: HookEvent<"action.result">["data"]["result"] = {
    callId: "call-1",
    kind: "tool-result",
    output: {},
    toolName,
  };
  if (isError !== undefined) {
    result.isError = isError;
  }
  return {
    data: { result, sequence: 3, status, stepIndex: 1, turnId: "turn-1" },
    meta,
    type: "action.result",
  };
};

/* Start of a later turn in the same session. */
const startedEvent = (turnId = "turn-2"): HookEvent<"turn.started"> => ({
  data: { sequence: 6, turnId },
  meta,
  type: "turn.started",
});

/* Runs one completed tool result as `caller`, then starts the next turn as `next`. */
const queryThenStart = async (
  caller: SessionAuthContext,
  next: SessionAuthContext,
  options: ResultOptions = {}
) => {
  await actionResult(resultEvent(options), hookContext(caller).ctx);
  const started = hookContext(next);
  await turnStarted(startedEvent(), started.ctx);
  return started.cancel;
};

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
});

describe("action.result", () => {
  it.each(["run_sql", "describe_schema"])(
    "records the caller's role after a successful %s",
    async (toolName) => {
      await actionResult(resultEvent({ toolName }), hookContext(alice).ctx);
      expect(testState.get("analyst.thread-roles")).toStrictEqual({
        roles: ["analyst_finance"],
      });
    }
  );

  it.each<[string, ResultOptions]>([
    ["errors", { isError: true }],
    ["failed calls", { status: "failed" }],
    ["rejected calls", { status: "rejected" }],
    ["other tools", { toolName: "post_slack_table" }],
  ])("records nothing for %s", async (_name, options) => {
    await actionResult(resultEvent(options), hookContext(alice).ctx);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });
});

describe("turn.started", () => {
  it("cancels a caller with a different role", async () => {
    const cancel = await queryThenStart(alice, bob);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("lets the same caller continue", async () => {
    const cancel = await queryThenStart(alice, alice);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("lets anyone in when only failed queries ran", async () => {
    const cancel = await queryThenStart(alice, bob, { isError: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("never cancels local development", async () => {
    const cancel = await queryThenStart(localDevAuth(), localDevAuth());
    expect(cancel).not.toHaveBeenCalled();
  });
});
