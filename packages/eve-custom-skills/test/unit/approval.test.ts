import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalCard,
  defaultSkillApproval,
  defaultSkillResponse,
} from "../../extension/lib/approval.ts";
import type { SkillApprovalRequest, SkillScope } from "../../extension/lib/types.ts";

const personal: SkillScope = { name: "personal", key: "user:a", label: "you", shared: false };
const channel: SkillScope = {
  name: "channel",
  key: "space:slack:T1:C1",
  label: "everyone in this channel",
  shared: true,
};

function request(input: Partial<SkillApprovalRequest>): SkillApprovalRequest {
  return {
    action: "create",
    scope: personal,
    caller: null,
    changesLive: true,
    targets: [],
    ...input,
  };
}

test("the default rule asks before live changes in shared scopes and before publishing anywhere", () => {
  assert.equal(defaultSkillApproval(request({ changesLive: false })), "allow");
  assert.equal(defaultSkillApproval(request({ scope: channel, changesLive: false })), "allow");
  assert.equal(defaultSkillApproval(request({})), "allow");
  assert.equal(defaultSkillApproval(request({ action: "set_mode" })), "allow");
  assert.equal(defaultSkillApproval(request({ scope: channel })), "ask");
  assert.equal(defaultSkillApproval(request({ scope: channel, action: "set_mode" })), "ask");
  for (const action of ["publish", "rollback", "remove"] as const) {
    assert.equal(defaultSkillApproval(request({ action })), "ask");
  }
});

test("the card names the change, who it affects, and the content that goes live", () => {
  const card = approvalCard(
    request({
      action: "publish",
      scope: channel,
      targets: [
        {
          name: "deploy",
          version: 3,
          description: "Use when the user asks to deploy.",
          instructions: `Check the build.\n${"x".repeat(2_500)}`,
          applicationMode: "always",
          warnings: [
            "Instructions mention moving secrets or credentials; review before activation.",
          ],
          live: { version: 2, applicationMode: "on-demand" },
        },
      ],
    }),
  );
  assert.match(
    card,
    /^Publish "deploy" v3 for everyone in this channel, always on\? It replaces live v2\./,
  );
  assert.match(card, /Description: Use when the user asks to deploy\./);
  assert.match(card, /Instructions:\nCheck the build\./);
  assert.match(card, /Showing the first 2000 of 2517 characters/);
  assert.match(card, /Warnings: Instructions mention moving secrets/);
  assert.ok(card.length <= 3_000);

  const removal = approvalCard(
    request({
      action: "remove",
      targets: [
        { name: "a", warnings: [], live: { version: 1, applicationMode: "always" } },
        { name: "b", warnings: [], live: { version: null, applicationMode: null } },
      ],
    }),
  );
  assert.match(removal, /^Delete skills "a", "b" for you, with every version\?/);
  assert.match(removal, /"a" v1 is live \(always on\)\./);
});

test("a shared change too long to read on its card is refused", async () => {
  const target = (length: number) => ({
    name: "voice",
    instructions: "x".repeat(length),
    warnings: [],
    live: { version: null, applicationMode: null },
  });
  assert.equal(defaultSkillApproval(request({ scope: channel, targets: [target(2_000)] })), "ask");
  const refused = await defaultSkillApproval(request({ scope: channel, targets: [target(2_001)] }));
  assert.match(typeof refused === "object" ? refused.deny : "", /2001 characters/);
  // A personal change isn't seen by anyone else, so its length doesn't matter.
  assert.equal(defaultSkillApproval(request({ targets: [target(5_000)] })), "allow");
});

test("a shared change needs someone other than the requester to approve it", async () => {
  const alice = { attributes: {}, authenticator: "a", principalId: "alice", principalType: "user" };
  const bob = { ...alice, principalId: "bob" };
  const answer = async (shared: boolean, responder: typeof alice) =>
    (await defaultSkillResponse(async () => shared)({
      request: { principal: alice },
      response: { principal: responder },
    } as never)) as { status: string };

  assert.equal((await answer(false, alice)).status, "allowed");
  assert.equal((await answer(false, bob)).status, "rejected");
  assert.equal((await answer(true, alice)).status, "rejected");
  assert.equal((await answer(true, bob)).status, "allowed");
});
