import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultScopes,
  personalScope,
  skillAuthor,
  spaceScope,
} from "../../extension/lib/scopes.ts";
import type { SkillScopeContext } from "../../extension/lib/types.ts";

const alice = {
  attributes: { email: "alice@example.com" },
  authenticator: "slack-webhook",
  principalId: "slack:T1:U1",
  principalType: "user",
};

function context(space?: { id: string; type: "direct" | "group" | "channel" }): SkillScopeContext {
  return {
    session: { id: "s1", auth: { current: alice, initiator: alice } },
    conversation: {
      audience: "private",
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      principalType: "user",
      ...(space && { space }),
    },
  };
}

test("personal scopes key by authenticator and principal", () => {
  const scope = personalScope(context());
  assert.equal(scope?.key, `user:${JSON.stringify(["slack-webhook", "slack:T1:U1"])}`);
  assert.equal(scope?.shared, false);
  assert.equal(
    personalScope({ session: { id: "s1", auth: { current: null, initiator: null } } }),
    null,
  );
});

test("the shared scope comes from the conversation's space, not from DMs", async () => {
  assert.equal(spaceScope(context({ id: "slack:T1:D1", type: "direct" })), null);
  assert.equal(spaceScope(context()), null);
  const channel = spaceScope(context({ id: "slack:T1:C1", type: "channel" }));
  assert.deepEqual(
    [channel?.name, channel?.key, channel?.shared, channel?.loadPrefix],
    ["channel", "space:slack:T1:C1", true, "channel"],
  );
  assert.equal(
    spaceScope(context({ id: "teams:t:g", type: "group" }))?.label,
    "everyone in this conversation",
  );
  assert.deepEqual(
    (await defaultScopes(context({ id: "discord:g:c", type: "channel" }))).map(({ name }) => name),
    ["personal", "channel"],
  );
});

test("authors are labeled by email, then principal", () => {
  assert.deepEqual(skillAuthor(alice), { principalId: "slack:T1:U1", label: "alice@example.com" });
  assert.deepEqual(skillAuthor(null), { principalId: null, label: "unknown" });
});
