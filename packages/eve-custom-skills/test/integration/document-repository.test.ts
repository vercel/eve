import assert from "node:assert/strict";
import test from "node:test";

import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";

import { documentRepository, encodePathSegment } from "../../extension/lib/document-repository.ts";
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

function setup(backend: MemoryDocumentBackend = inMemory(), namespace?: string, limits = {}) {
  return {
    backend,
    skills: new SkillLifecycle({ repository: documentRepository({ backend, namespace }), limits }),
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
  const rolledBack = await skills.publish(alice, "deploy", 1);
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
  const [deploy] = await skills.listLive(alice);
  assert.ok(deploy);

  assert.deepEqual(await skills.remove(alice, [{ id: deploy.id, name: "deploy" }]), {
    removed: [{ id: deploy.id, name: "deploy" }],
    notFound: [],
  });
  const cleared = await backend.read({ key: versionKey, signal: new AbortController().signal });
  assert.equal(cleared?.content, "");
  assert.deepEqual(await skills.listSummaries(alice), []);
});

test("concurrent writers can't exceed a scope's always-on limit", async () => {
  const { skills } = setup(inMemory(), undefined, { maxAlwaysOn: 1 });
  const results = await Promise.allSettled(
    ["one", "two", "three"].map((name) =>
      skills.save(
        channel,
        { name, description: "x", markdown: "Always.", applicationMode: "always" },
        { savedBy },
      ),
    ),
  );
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal((await skills.listLive(channel)).length, 1);
});

test("the layout is readable and listable across scopes", async () => {
  const backend = inMemory();
  const writes: string[] = [];
  const recording: MemoryDocumentBackend = {
    read: backend.read,
    async write(input) {
      writes.push(input.key);
      return backend.write(input);
    },
  };
  const repository = documentRepository({ backend: recording, namespace: "support" });
  const skills = new SkillLifecycle({ repository });
  const first = await skills.save(
    alice,
    { name: "deploy", description: ROUTING, markdown: "Deploy." },
    { savedBy },
  );
  await skills.save(
    channel,
    { name: "triage", description: ROUTING, markdown: "Triage." },
    { savedBy },
  );

  assert.ok(writes.includes("support/v1/scopes/space~3aslack~3aT1~3aC1/catalog.json"));
  assert.ok(
    writes.some((key) =>
      key.startsWith(`support/v1/scopes/user~3aalice/skills/${encodePathSegment(first.skill.id)}/`),
    ),
  );

  // An admin view scans every scope without knowing the keys up front.
  const scopes = await repository.listScopes?.();
  assert.deepEqual(scopes?.map(({ key }) => key).sort(), [channel.key, alice.key].sort());
  const library = await Promise.all(
    (scopes ?? []).map(async (scope) => ({
      scope: scope.name,
      skills: (await repository.listHeads(scope)).heads.map(({ name }) => name),
    })),
  );
  assert.deepEqual(
    library.sort((a, b) => a.scope.localeCompare(b.scope)),
    [
      { scope: "channel", skills: ["triage"] },
      { scope: "personal", skills: ["deploy"] },
    ],
  );
});

test("a new skill can't take a name another skill in the scope holds", async () => {
  const repository = documentRepository({ backend: inMemory() });
  const request = {
    name: "deploy",
    expectedLatest: null,
    version: {
      description: ROUTING,
      markdown: "x",
      applicationMode: "on-demand",
      checksum: "c",
      validation: { valid: true, errors: [], warnings: [] },
      savedBy,
    },
    activate: true,
  } as const;
  await repository.appendVersion(alice, { ...request, id: "a" });
  await assert.rejects(repository.appendVersion(alice, { ...request, id: "b" }), /already exists/);
});

test("a skill can be named like a built-in object property", async () => {
  const { skills } = setup();
  for (const name of ["constructor", "tostring", "proto"]) {
    const saved = await skills.save(
      alice,
      { name, description: ROUTING, markdown: `${name} steps.` },
      { savedBy, idempotencyKey: `s1:${name}` },
    );
    assert.equal(saved.skill.status, "active");
  }
  assert.deepEqual(
    (await skills.listLive(alice)).map(({ name }) => name),
    ["constructor", "proto", "tostring"],
  );
});

test("an unreadable catalog entry is skipped and kept, and the rest of the scope still works", async () => {
  const backend = inMemory();
  const { skills } = setup(backend, "repair");
  await skills.save(
    alice,
    { name: "deploy", description: ROUTING, markdown: "Deploy." },
    { savedBy },
  );
  const key = "repair/v1/scopes/user~3aalice/catalog.json";
  const signal = new AbortController().signal;
  const stored = (await backend.read({ key, signal }))!;
  const catalog = JSON.parse(stored.content);
  catalog.skills["broken-id"] = { name: 42 };
  await backend.write({
    key,
    content: JSON.stringify(catalog),
    expectedVersion: stored.version,
    signal,
  });

  assert.deepEqual(
    (await skills.listLive(alice)).map(({ name }) => name),
    ["deploy"],
  );
  await skills.save(
    alice,
    { name: "triage", description: ROUTING, markdown: "Triage." },
    { savedBy },
  );
  const kept = JSON.parse((await backend.read({ key, signal }))!.content);
  assert.deepEqual(kept.skills["broken-id"], { name: 42 });
});

test("a catalog write that lands but reports failure doesn't leave a ghost skill", async () => {
  const backend = inMemory();
  let failAfterCatalogWrite = true;
  const flaky: MemoryDocumentBackend = {
    read: backend.read,
    async write(input) {
      const written = await backend.write(input);
      if (input.key.endsWith("catalog.json") && failAfterCatalogWrite) {
        failAfterCatalogWrite = false;
        throw new Error("connection reset after the write");
      }
      return written;
    },
  };
  const { skills } = setup(flaky);
  const saved = await skills.save(
    alice,
    { name: "deploy", description: ROUTING, markdown: "Deploy." },
    { savedBy },
  );
  assert.equal(saved.skill.status, "active");
  const [live] = await skills.listLive(alice);
  assert.equal(live?.instructions, "Deploy.");
});

test("a version stays when the write's outcome can't be checked", async () => {
  // The catalog write lands but reports failure, and the read that would check it fails too.
  // Storage then recovers, so anything that clears the version afterwards would succeed.
  const backend = inMemory();
  let catalogWrites = 0;
  let failedReads = 0;
  const flaky: MemoryDocumentBackend = {
    async read(input) {
      if (failedReads > 0) {
        failedReads -= 1;
        throw new Error("storage unavailable");
      }
      return backend.read(input);
    },
    async write(input) {
      const written = await backend.write(input);
      if (input.key.endsWith("catalog.json") && catalogWrites++ === 0) {
        failedReads = 1;
        throw new Error("connection reset after the write");
      }
      return written;
    },
  };
  const { skills } = setup(flaky);
  await assert.rejects(
    skills.save(alice, { name: "deploy", description: ROUTING, markdown: "Deploy." }, { savedBy }),
    /connection reset/,
  );

  const [live] = await skills.listLive(alice);
  assert.equal(live?.instructions, "Deploy.");
});
