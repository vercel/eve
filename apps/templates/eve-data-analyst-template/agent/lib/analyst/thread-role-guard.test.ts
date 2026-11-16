import type { SessionAuthContext } from "eve/context";
import type { HookEvent } from "eve/hooks";
import { beforeEach, expect, it, vi } from "vitest";

import { eventView, hookContext } from "../testing/events";
import { localDevAuth, sessionContext, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import hook from "./thread-role-guard";

const settled = hook.events?.["call.settled"];
const started = hook.events?.["turn.started"];
if (!settled || !started) {
  throw new Error("Expected call and turn hooks.");
}
const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });
const start: HookEvent<"turn.started"> = {
  data: {
    cause: { deliveryId: "delivery-1" },
    follows: null,
    turnId: "turn-2",
  },
  type: "turn.started",
};
const result = async (
  caller: SessionAuthContext,
  name = "run_sql",
  outcome: "completed" | "failed" | "rejected" = "completed"
) => {
  const event: HookEvent<"call.settled"> = {
    data: { callId: "call-1", outcome, output: {} },
    type: "call.settled",
  };
  await settled(
    event,
    hookContext({
      ...sessionContext({ current: caller }),
      view: eventView([
        start,
        {
          data: {
            callId: "call-1",
            capability: { kind: "tool", name },
            input: {},
            owner: { turnId: "turn-2" },
          },
          type: "call.requested",
        },
        event,
      ]),
    })
  );
};
const nextTurn = async (current: SessionAuthContext) => {
  const cancel = vi.fn();
  await started(start, hookContext({ ...sessionContext({ current }), cancel }));
  return cancel;
};
beforeEach(() => {
  testState.reset();
  installTestState();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
});
it.each(["run_sql", "describe_schema"])(
  "blocks a later different-role caller after successful %s",
  async (name) => {
    await result(alice, name);
    expect(await nextTurn(bob)).toHaveBeenCalledOnce();
    expect(await nextTurn(alice)).not.toHaveBeenCalled();
  }
);
it.each(["failed", "rejected"] as const)(
  "does not hold a role after a %s call",
  async (outcome) => {
    await result(alice, "run_sql", outcome);
    expect(await nextTurn(bob)).not.toHaveBeenCalled();
  }
);
it("ignores other tools and permits local development", async () => {
  await result(alice, "post_slack_table");
  expect(await nextTurn(bob)).not.toHaveBeenCalled();
  await result(localDevAuth());
  expect(await nextTurn(localDevAuth())).not.toHaveBeenCalled();
});
