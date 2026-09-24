import { describe, expect, it } from "vitest";

import { ContinuationHookTokensKey } from "#context/keys.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY } from "#tasks/state.js";

const ALIAS = `eve:task-callback:${"ab".repeat(24)}`;

describe("sessionHookTokens", () => {
  it("claims the stable inbox, every channel alias, and the remote callback alias", () => {
    expect(
      sessionHookTokens({
        serializedContext: {
          [ContinuationHookTokensKey.name]: ["channel:first", "channel:second"],
        },
        sessionState: {
          continuationToken: "channel:second",
          sessionId: "session-1",
          snapshot: { session: { state: { [TASK_CALLBACK_ALIAS_STATE_KEY]: ALIAS } } },
        },
      }),
    ).toEqual(["eve:session:session-1:inbox", "channel:first", "channel:second", ALIAS]);
  });

  it.each([
    ["no snapshot", undefined],
    ["no alias", { session: { state: {} } }],
    [
      "a value outside the alias namespace",
      { session: { state: { [TASK_CALLBACK_ALIAS_STATE_KEY]: "eve:session:other:inbox" } } },
    ],
  ])("claims no callback alias with %s", (_name, snapshot) => {
    expect(
      sessionHookTokens({
        serializedContext: {},
        sessionState: { continuationToken: "", sessionId: "session-1", snapshot },
      }),
    ).toEqual(["eve:session:session-1:inbox"]);
  });
});
