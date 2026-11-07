import assert from "node:assert/strict";
import test from "node:test";

import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";

import { documentRepository } from "../../extension/lib/document-repository.ts";
import { SkillLifecycle } from "../../extension/lib/lifecycle.ts";
import type { SkillScope } from "../../extension/lib/types.ts";

const ROUTING = "Use when the user asks for a deploy checklist.";
const alice: SkillScope = { name: "personal", key: "user:alice", label: "you", shared: false };
const channel: SkillScope = {
  name: "channel",
  key: "space:slack:T1:C1",
  label: "everyone in this channel",
  shared: true,
};
const savedBy = { principalId: "alice", label: "alice@example.com" };

function setup(backend: MemoryDocumentBackend = inMemory(), namespace?: string) {
  return {
    backend,
    skills: new SkillLifecycle({ repository: documentRepository({ backend, namespace }) }),
  };
}

test("saves, publishes, and rolls back through one catalog document per scope", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  const first = await skills.save(alice, input, { savedBy });
  assert.equal(first.skill.status, "active");
  assert.equal(first.skill.savedBy.label, "alice@example.com");
  await skills.save(alice, { ...input, markdown: "Deploy v2." }, { savedBy });
  await skills.publish(alice, "deploy", 2);
  const rolledBack = await skills.rollback(alice, "deploy", 1);
  assert.equal(rolledBack.skill.instructions, "Deploy.");
  assert.deepEqual(
    (await skills.listVersions(alice, "deploy")).map(({ version, status }) => [version, status]),
    [
      [2, "draft"],
      [1, "active"],
    ],
  );
  await skills.save(channel, input, { savedBy });
  assert.deepEqual(
    (await skills.listSummaries(alice)).map(({ name, latestVersion }) => [name, latestVersion]),
    [["deploy", 2]],
  );
  assert.equal((await skills.listLive(channel)).length, 1);
});

test("namespaces keep two agents on one store apart", async () => {
  const backend = inMemory();
  const support = setup(backend, "support").skills;
  const sales = setup(backend, "sales").skills;
  await support.save(
    alice,
    { name: "deploy", description: ROUTING, markdown: "Deploy." },
    { savedBy },
  );
  assert.equal((await support.listLive(alice)).length, 1);
  assert.equal((await sales.listLive(alice)).length, 0);
});

test("a replayed save returns the original version", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  const first = await skills.save(alice, input, { savedBy, idempotencyKey: "s1:call-1" });
  const replay = await skills.save(alice, input, { savedBy, idempotencyKey: "s1:call-1" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.skill.version, first.skill.version);
  assert.equal((await skills.listVersions(alice, "deploy")).length, 1);
});

test("concurrent saves get distinct versions", async () => {
  const { skills } = setup();
  const input = { name: "deploy", description: ROUTING, markdown: "Deploy." };
  await skills.save(alice, input, { savedBy });
  const saved = await Promise.all(
    ["A.", "B.", "C."].map((markdown) => skills.save(alice, { ...input, markdown }, { savedBy })),
  );
  assert.deepEqual(saved.map(({ skill }) => skill.version).sort(), [2, 3, 4]);
  assert.equal((await skills.listVersions(alice, "deploy")).length, 4);
});

test("deferred skills are stored and listed live like on-demand ones", async () => {
  const { skills } = setup();
  await skills.save(
    alice,
    { name: "rare", description: ROUTING, markdown: "Rarely needed.", applicationMode: "deferred" },
    { savedBy },
  );
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
  await skills.save(
    alice,
    { name: "deploy", description: ROUTING, markdown: "Deploy." },
    { savedBy },
  );
  const versionKey = writes.find(({ content }) => content.includes('"markdown"'))?.key;
  assert.ok(versionKey);
  assert.ok(!versionKey.includes("alice"), "scope keys are hashed into paths");

  assert.deepEqual(await skills.remove(alice, ["deploy", "missing"]), {
    removed: ["deploy"],
    notFound: ["missing"],
  });
  const cleared = await backend.read({ key: versionKey, signal: new AbortController().signal });
  assert.equal(cleared?.content, "");
  assert.deepEqual(await skills.listSummaries(alice), []);
});
