import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationContext, SessionAuthContext } from "eve/context";
import { inMemory } from "eve/memory/file";

import extension from "../../extension/extension.ts";
import type { SkillApprovalRule, SkillChangeEvent } from "../../extension/lib/types.ts";
import create from "../../extension/tools/create.ts";
import publish from "../../extension/tools/publish.ts";
import remove from "../../extension/tools/remove.ts";

const ROUTING = "Use when the user asks for a deploy checklist.";
const alice: SessionAuthContext = {
  attributes: { email: "alice@example.com" },
  authenticator: "slack-webhook",
  principalId: "slack:T1:U1",
  principalType: "user",
};
const bob: SessionAuthContext = { ...alice, principalId: "slack:T1:U2", attributes: {} };
const inChannel: ConversationContext = {
  audience: "public",
  channel: { kind: "channel:slack", name: "slack" },
  environment: "production",
  principalType: "user",
  space: { id: "slack:T1:C1", type: "channel", workspaceId: "slack:T1" },
};

function mount(options: { rule?: SkillApprovalRule } = {}) {
  const events: SkillChangeEvent[] = [];
  extension({
    storage: inMemory(),
    approval: options.rule ? { request: options.rule } : {},
    onChange: (event: SkillChangeEvent) => void events.push(event),
  });
  return events;
}

let calls = 0;
function context(input: { approvedBy?: SessionAuthContext; sessionId?: string } = {}) {
  calls += 1;
  return {
    session: {
      id: input.sessionId ?? "session-1",
      auth: { current: alice, initiator: alice },
      turn: { id: "turn-1", sequence: 0 },
    },
    conversation: inChannel,
    callId: `call-${calls}`,
    toolName: "skills__create",
    abortSignal: new AbortController().signal,
    ...(input.approvedBy && { approval: { responder: input.approvedBy } }),
  } as never;
}

type Approval = {
  request(ctx: unknown): Promise<unknown>;
  prompt(ctx: unknown): string;
  response(ctx: unknown): unknown;
};

function approvalOf(tool: unknown): Approval {
  return (tool as { approval: Approval }).approval;
}

async function run(tool: unknown, input: object, ctx: unknown) {
  return (
    tool as { execute(input: object, ctx: unknown): Promise<Record<string, unknown>> }
  ).execute(input, ctx);
}

async function decide(tool: unknown, input: object, ctx: Record<string, unknown>) {
  const approval = approvalOf(tool);
  const status = await approval.request({ ...ctx, toolInput: input });
  const prompt = approval.prompt({ callId: ctx.callId, input, toolName: ctx.toolName });
  return { status, prompt };
}

const deploy = {
  name: "deploy",
  description: ROUTING,
  instructions: "Check the build.",
  applicationMode: "on-demand",
};

test("a personal first version goes live without asking", async () => {
  const events = mount();
  const ctx = context();
  const { status } = await decide(create, { ...deploy }, ctx);
  assert.equal(status, "not-applicable");
  const result = await run(create, { ...deploy }, ctx);
  assert.equal(result.status, "active");
  assert.equal(events[0]?.kind, "saved");
  assert.equal(events[0]?.actor?.principalId, alice.principalId);
});

test("a shared first version asks, shows its content, and goes live only once approved", async () => {
  const events = mount();
  const input = { ...deploy, scope: "channel" };
  const ctx = context();
  const { status, prompt } = await decide(create, input, ctx);
  assert.equal(status, "user-approval");
  assert.match(
    prompt,
    /^Save and turn on "deploy" v1 for everyone in this channel, loaded on demand\?/,
  );
  assert.match(prompt, /Instructions:\nCheck the build\./);

  const approved = await run(create, input, { ...(ctx as object), approval: { responder: bob } });
  assert.equal(approved.status, "active");
  assert.equal(approved.loadName, "channel_deploy");
  const [event] = events;
  assert.equal(event?.scope.name, "channel");
  assert.equal(event?.approvedBy?.principalId, bob.principalId);
});

test("a change that needs approval nobody gave is held back", async () => {
  mount();
  const input = { ...deploy, scope: "channel" };
  const held = await run(create, input, context());
  assert.equal(held.status, "draft");

  const refused = await run(publish, { name: "deploy", version: 1, scope: "channel" }, context());
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /needs approval/);
});

test("a configured rule can refuse changes", async () => {
  mount({
    rule: (change) =>
      change.scope.shared ? { deny: "Shared skills are managed by admins." } : "allow",
  });
  const ctx = context();
  const input = { ...deploy, scope: "channel" };
  assert.deepEqual((await decide(create, input, ctx)).status, {
    type: "denied",
    reason: "Shared skills are managed by admins.",
  });
  const refused = await run(create, input, ctx);
  assert.deepEqual(refused, { success: false, error: "Shared skills are managed by admins." });
});

test("removal reports who removed what", async () => {
  const events = mount();
  await run(create, { ...deploy }, context());
  const ctx = context({ approvedBy: alice });
  const { status, prompt } = await decide(remove, { names: ["deploy", "missing"] }, ctx);
  assert.equal(status, "user-approval");
  assert.match(prompt, /^Delete skill "deploy" for you, with every version\?/);
  const result = await run(remove, { names: ["deploy", "missing"] }, ctx);
  assert.deepEqual([result.deleted, result.notFound], [["deploy"], ["missing"]]);
  assert.deepEqual(events.at(-1), {
    kind: "removed",
    names: ["deploy"],
    scope: events.at(-1)?.scope,
    actor: alice,
    approvedBy: alice,
    sessionId: "session-1",
  });
});

test("only the requester may answer by default", () => {
  mount();
  const response = approvalOf(publish).response;
  assert.deepEqual(response({ request: { principal: alice }, response: { principal: alice } }), {
    status: "allowed",
  });
  assert.equal(
    (
      response({ request: { principal: alice }, response: { principal: bob } }) as {
        status: string;
      }
    ).status,
    "rejected",
  );
});
