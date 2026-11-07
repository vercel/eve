import assert from "node:assert/strict";
import test from "node:test";

import { approvalCard, defaultSkillApproval } from "../../extension/lib/approval.ts";
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
          instructions: `Check the build.\n${"x".repeat(1_000)}`,
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
  assert.match(card, /…/);
  assert.match(card, /Warnings: Instructions mention moving secrets/);
  assert.ok(card.length <= 2_500);

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
