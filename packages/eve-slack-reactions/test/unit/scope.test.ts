import assert from "node:assert/strict";
import test from "node:test";

import { defaultReactionScope } from "../../extension/lib/scope.ts";

test("targets the message the turn answers on the agent's slack channel", () => {
  assert.deepEqual(
    defaultReactionScope({
      kind: "channel:slack",
      metadata: { channelId: "C1", threadTs: "1.0", triggeringMessageTs: "2.0" },
    }),
    { channelId: "C1", messageTs: "2.0" },
  );
  assert.deepEqual(
    defaultReactionScope({ kind: "channel:slack", metadata: { channelId: "C1", threadTs: "1.0" } }),
    { channelId: "C1", messageTs: "1.0" },
  );
});

test("a code channel session without a known message still gets the tools", () => {
  assert.deepEqual(
    defaultReactionScope({
      kind: "channel:slack",
      metadata: { channelId: "C1", threadTs: null, codeChannel: true },
    }),
    { channelId: "C1" },
  );
});

test("offers nothing off the agent's slack channel", () => {
  assert.equal(defaultReactionScope({ kind: "http", metadata: {} }), null);
  assert.equal(
    defaultReactionScope({
      kind: "channel:support-slack",
      metadata: { channelId: "C1", threadTs: "1.0" },
    }),
    null,
  );
  assert.equal(
    defaultReactionScope({ kind: "channel:slack", metadata: { channelId: null, threadTs: "1.0" } }),
    null,
  );
});
