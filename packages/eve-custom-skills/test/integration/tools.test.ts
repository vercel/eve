import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationContext, SessionAuthContext } from "eve/context";
import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";

import extension from "../../extension/extension.ts";
import { documentRepository } from "../../extension/lib/document-repository.ts";
import { loadTurnSkills } from "../../extension/lib/runtime.ts";
import { spaceScope } from "../../extension/lib/scopes.ts";
import type { SkillApprovalRule, SkillChangeEvent } from "../../extension/lib/types.ts";
import create from "../../extension/tools/create.ts";
import list from "../../extension/tools/list.ts";
import publish from "../../extension/tools/publish.ts";
import read from "../../extension/tools/read.ts";
import remove from "../../extension/tools/remove.ts";
import setMode from "../../extension/tools/set_mode.ts";

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

function mount(options: { rule?: SkillApprovalRule; storage?: MemoryDocumentBackend } = {}) {
  const events: SkillChangeEvent[] = [];
  extension({
    storage: options.storage ?? inMemory(),
    approval: options.rule ? { request: options.rule } : {},
    onChange: (event: SkillChangeEvent) => void events.push(event),
  });
  return events;
}

let calls = 0;
function context(
  input: { approvedBy?: SessionAuthContext; sessionId?: string; caller?: SessionAuthContext } = {},
) {
  calls += 1;
  const caller = input.caller ?? alice;
  return {
    session: {
      id: input.sessionId ?? "session-1",
      auth: { current: caller, initiator: caller },
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

  const refused = await run(
    publish,
    { name: "deploy", id: held.id, version: 1, scope: "channel" },
    context(),
  );
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
  const created = await run(create, { ...deploy }, context());
  const ctx = context({ approvedBy: alice });
  const input = {
    skills: [
      { name: "deploy", id: created.id },
      { name: "missing", id: "skill-missing" },
    ],
  };
  const { status, prompt } = await decide(remove, input, ctx);
  assert.equal(status, "user-approval");
  assert.match(prompt, /^Delete skill "deploy" for you, with every version\?/);
  const result = await run(remove, input, ctx);
  assert.deepEqual([result.deleted, result.notFound], [["deploy"], ["missing"]]);
  assert.deepEqual(events.at(-1), {
    kind: "removed",
    skills: [{ id: created.id, name: "deploy" }],
    scope: events.at(-1)?.scope,
    actor: alice,
    approvedBy: alice,
    sessionId: "session-1",
  });
});

test("by default the requester answers for personal skills, and someone else for shared ones", async () => {
  mount();
  const response = approvalOf(publish).response;
  const answer = async (scope: string | undefined, responder: SessionAuthContext) =>
    (
      (await response({
        request: { principal: alice, toolInput: { name: "deploy", id: "x", version: 1, scope } },
        response: { principal: responder },
        session: { id: "session-1", initiator: alice },
      })) as { status: string }
    ).status;

  assert.equal(await answer(undefined, alice), "allowed");
  assert.equal(await answer(undefined, bob), "rejected");
  // The channel scope depends on the conversation, which a response doesn't carry, so it counts as shared.
  assert.equal(await answer("channel", alice), "rejected");
  assert.equal(await answer("channel", bob), "allowed");
});

test("an approval applies only to the skill it showed, not one recreated under its name", async () => {
  mount();
  const input = { ...deploy, scope: "channel" };
  const approvedBy = { approvedBy: alice };
  const original = await run(create, input, context(approvedBy));
  await run(create, { ...input, instructions: "Check the build twice." }, context());

  // While Alice's approval to publish the original's v2 waits, Bob replaces the skill.
  const publishOriginal = { name: "deploy", id: original.id, version: 2, scope: "channel" };
  assert.equal((await decide(publish, publishOriginal, context())).status, "user-approval");
  await run(
    remove,
    { skills: [{ name: "deploy", id: original.id }], scope: "channel" },
    context(approvedBy),
  );
  const replacement = await run(create, input, context(approvedBy));
  await run(create, { ...input, instructions: "Skip the checks." }, context());

  const published = await run(publish, publishOriginal, context(approvedBy));
  assert.equal(published.success, false);
  assert.match(String(published.error), /was replaced since/);

  // Removing by the original's id leaves the replacement alone.
  const removal = await run(
    remove,
    { skills: [{ name: "deploy", id: original.id }], scope: "channel" },
    context(approvedBy),
  );
  assert.deepEqual([removal.deleted, removal.notFound], [[], ["deploy"]]);
  assert.notEqual(replacement.id, original.id);
});

/** Only an administrator may approve, and every live change in a shared scope asks. */
const adminOnly: SkillApprovalRule = (change) =>
  change.changesLive && change.scope.shared ? "ask" : "allow";

test("a shared draft save stays a draft when the skill is deleted before it commits", async () => {
  const backend = inMemory();
  let deleteBeforeNextVersion: (() => Promise<void>) | undefined;
  const racing: MemoryDocumentBackend = {
    read: backend.read,
    async write(input) {
      // Just before the draft's version document lands, an administrator deletes the skill.
      if (input.key.includes("/skills/") && deleteBeforeNextVersion) {
        const removal = deleteBeforeNextVersion;
        deleteBeforeNextVersion = undefined;
        await removal();
      }
      return backend.write(input);
    },
  };
  mount({ rule: adminOnly, storage: racing });
  const input = { ...deploy, scope: "channel" };
  const original = await run(create, input, context({ approvedBy: alice }));
  assert.equal(original.status, "active");

  const admin = documentRepository({ backend });
  const channel = spaceScope({
    session: { id: "s", auth: { current: alice, initiator: alice } },
    conversation: inChannel,
  })!;
  deleteBeforeNextVersion = async () => void (await admin.remove(channel, [String(original.id)]));

  // Bob's draft needed no approval, since it changes nothing live.
  const draft = { ...input, instructions: "Bob's revision." };
  assert.equal((await decide(create, draft, context({ caller: bob }))).status, "not-applicable");
  const saved = await run(create, draft, context({ caller: bob }));
  assert.equal(saved.success, false, `the racing save returned ${JSON.stringify(saved)}`);

  // Retried without approval, the save is a new first version that needs one, so it waits as a draft.
  const retried = await run(create, draft, context({ caller: bob }));
  assert.equal(retried.status, "draft");
  assert.deepEqual(
    (await admin.listHeads(channel)).heads.map(({ liveVersion }) => liveVersion),
    [null],
  );
});

test("personal skills stay apart for principals that share an id across issuers or types", async () => {
  mount();
  const atAcme: SessionAuthContext = {
    attributes: {},
    authenticator: "oidc",
    issuer: "https://acme.example",
    principalId: "42",
    principalType: "user",
  };
  const elsewhere = [
    { ...atAcme, issuer: "https://other.example" },
    { ...atAcme, principalType: "service" },
    { ...atAcme, subject: "someone-else" },
  ];
  const secret = { ...deploy, name: "private-notes", instructions: "Acme's private steps." };
  const saved = await run(create, secret, context({ caller: atAcme }));
  assert.equal(saved.status, "active");

  for (const caller of elsewhere) {
    const listed = await run(list, {}, context({ caller }));
    assert.deepEqual(listed.skills, [], `${JSON.stringify(caller)} listed Acme's skills`);
    const readBack = await run(read, { name: "private-notes" }, context({ caller }));
    assert.equal(readBack.success, false);
  }
  assert.equal(
    (await run(read, { name: "private-notes" }, context({ caller: atAcme }))).instructions,
    "Acme's private steps.",
  );
});

test("a person can inspect, publish, roll back, and change the mode of their own skill", async () => {
  const events = mount();
  const created = await run(create, { ...deploy }, context());
  await run(create, { ...deploy, instructions: "Check the build and the logs." }, context());
  const id = String(created.id);

  const listed = await run(list, {}, context());
  assert.deepEqual(
    (listed.skills as Array<Record<string, unknown>>).map(
      ({ id, name, liveVersion, draftVersions }) => [id, name, liveVersion, draftVersions],
    ),
    [[id, "deploy", 1, [2]]],
  );
  const latest = await run(read, { name: "deploy" }, context());
  assert.equal(latest.version, 2);
  assert.equal(latest.instructions, "Check the build and the logs.");
  assert.deepEqual(
    (latest.versions as Array<Record<string, unknown>>).map(({ version, status }) => [
      version,
      status,
    ]),
    [
      [2, "draft"],
      [1, "active"],
    ],
  );
  assert.equal(
    (await run(read, { name: "deploy", version: 1 }, context())).instructions,
    "Check the build.",
  );

  const approved = context({ approvedBy: alice });
  assert.equal((await run(publish, { name: "deploy", id, version: 2 }, approved)).liveVersion, 2);
  // Publishing an earlier version rolls back to it, and the rule and card call it that.
  const rollingBack = { name: "deploy", id, version: 1 };
  const { prompt } = await decide(publish, rollingBack, context());
  assert.match(prompt, /^Roll back "deploy" for you to v1/);
  const rolledBack = await run(publish, rollingBack, approved);
  assert.equal(rolledBack.liveVersion, 1);
  assert.match(String(rolledBack.message), /^Rolled back "deploy" to version 1/);
  const deferred = await run(
    setMode,
    { name: "deploy", id, version: 1, mode: "deferred" },
    context(),
  );
  assert.equal(deferred.applicationMode, "deferred");
  assert.deepEqual(
    events.map(({ kind }) => kind),
    ["saved", "saved", "published", "published", "mode"],
  );
});

test("a scope whose storage fails is skipped for the turn, with a note for the model", async () => {
  const backend = inMemory();
  const failing: MemoryDocumentBackend = {
    async read(input) {
      if (input.key.includes("space~3a")) throw new Error("Blob is down");
      return backend.read(input);
    },
    write: backend.write,
  };
  mount({ storage: failing });
  await run(create, { ...deploy }, context());

  const loaded = await loadTurnSkills({
    session: { id: "session-1", auth: { current: alice, initiator: alice } },
    conversation: inChannel,
    turnId: "turn-9",
  });
  assert.deepEqual(
    loaded.map(({ scope, skills, unavailable }) => [scope.name, skills.length, unavailable]),
    [
      ["personal", 1, undefined],
      ["channel", 0, true],
    ],
  );
});
