import assert from "node:assert/strict";
import test from "node:test";

import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";

import { documentRepository } from "../../extension/lib/document-repository.ts";
import { SkillLifecycle } from "../../extension/lib/lifecycle.ts";
import { personalScope, slackChannelScope } from "../../extension/lib/scopes.ts";

const ROUTING = "Use when the user asks for a deploy checklist.";
const alice = personalScope({
  principalId: "slack:T1:U1",
  attributes: { email: "a@example.com" },
})!;
const channel = slackChannelScope({
  principalId: "slack:T1:U1",
  attributes: { channel_id: "C1", team_id: "T1" },
})!;

function setup(backend: MemoryDocumentBackend = inMemory()) {
  return { backend, skills: new SkillLifecycle({ repository: documentRepository({ backend }) }) };
}

test("saves, publishes, and rolls back through one catalog document per scope", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  const first = await skills.save(alice, input);
  assert.equal(first.status, "active");
  assert.equal(first.ownerLabel, "a@example.com");
  await skills.save(alice, { ...input, markdown: "Deploy v2." });
  await skills.publish(alice, "deploy", 2);
  const rolledBack = await skills.rollback(alice, "deploy", 1);
  assert.equal(rolledBack.markdown, "Deploy.");
  assert.deepEqual(
    (await skills.listVersions(alice, "deploy")).map(({ version, status }) => [version, status]),
    [
      [2, "draft"],
      [1, "active"],
    ],
  );
  await skills.save(channel, input);
  assert.deepEqual(
    (await skills.listSummaries(alice)).map(({ name, versionCount }) => [name, versionCount]),
    [["deploy", 2]],
  );
  assert.equal((await skills.listLive(channel)).length, 1);
});

test("a replayed save returns the original version and a stale one conflicts", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  const first = await skills.save(alice, input, { idempotencyKey: "call-1" });
  const replay = await skills.save(alice, input, { idempotencyKey: "call-1" });
  assert.equal(replay.version, first.version);
  assert.equal((await skills.listVersions(alice, "deploy")).length, 1);

  await skills.save(alice, { ...input, markdown: "Deploy v2." });
  await assert.rejects(
    skills.save(alice, input, { expectedLatest: 1 }),
    /latest version is 2, not 1/,
  );
  await assert.rejects(skills.save(alice, input, { expectedLatest: null }), /already exists/);
});

test("concurrent saves get distinct versions", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  await skills.save(alice, input);
  const saved = await Promise.all(
    ["A.", "B.", "C."].map((markdown) => skills.save(alice, { ...input, markdown })),
  );
  assert.deepEqual(saved.map(({ version }) => version).sort(), [2, 3, 4]);
  assert.equal((await skills.listVersions(alice, "deploy")).length, 4);
});

test("deferred skills are stored and listed live like on-demand ones", async () => {
  const { skills } = setup();
  await skills.save(alice, {
    name: "rare",
    description: ROUTING,
    markdown: "Rarely needed.",
    applicationMode: "deferred",
  });
  const [live] = await skills.listLive(alice);
  assert.equal(live?.applicationMode, "deferred");
});

test("deleting a skill clears its version documents", async () => {
  const backend = inMemory();
  const writes: Array<{ key: string; content: string }> = [];
  const recording: MemoryDocumentBackend = {
    read: backend.read,
    async write(input) {
      writes.push({ key: input.key, content: input.content });
      return backend.write(input);
    },
  };
  const { skills } = setup(recording);
  await skills.save(alice, { name: "deploy", description: ROUTING, markdown: "Deploy." });
  const versionKey = writes.find(({ key }) => key.includes("/deploy/"))?.key;
  assert.ok(versionKey);

  assert.deepEqual(await skills.remove(alice, ["deploy", "missing"]), {
    deleted: ["deploy"],
    notFound: ["missing"],
  });
  const cleared = await backend.read({ key: versionKey, signal: new AbortController().signal });
  assert.equal(cleared?.content, "");
  assert.deepEqual(await skills.listSummaries(alice), []);
});
