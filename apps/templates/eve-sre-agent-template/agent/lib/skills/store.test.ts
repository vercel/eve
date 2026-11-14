import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlobObjectStore } from "#lib/blob.ts";
import {
  CustomSkillStore,
  InvalidSkillContentError,
  InvalidSkillNameError,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MissingHumanUserError,
  normalizeSkillName,
} from "./store.ts";

class MemoryObjectStore implements BlobObjectStore {
  readonly objects = new Map<string, string>();

  delete(objectPath: string): Promise<void> {
    this.objects.delete(objectPath);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()].filter((objectPath) =>
        objectPath.startsWith(prefix)
      )
    );
  }

  read(objectPath: string): Promise<string | null> {
    return Promise.resolve(this.objects.get(objectPath) ?? null);
  }

  write(objectPath: string, content: string): Promise<void> {
    this.objects.set(objectPath, content);
    return Promise.resolve();
  }
}

const alice = {
  attributes: { team_id: "T1" },
  authenticator: "slack-webhook",
  issuer: "slack:T1",
  principalId: "slack:T1:U1",
  principalType: "user",
} as const;

function testStore() {
  let tick = 0;
  const objects = new MemoryObjectStore();
  const store = new CustomSkillStore(objects, () => {
    const second = tick;
    tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, second));
  });
  return { objects, store };
}

test("normalizes skill names", () => {
  assert.equal(normalizeSkillName("Deploy Checklist"), "deploy-checklist");
  assert.equal(normalizeSkillName("  RFC Review!!  "), "rfc-review");
  assert.throws(() => normalizeSkillName("!!!"), InvalidSkillNameError);
});

test("stores global and personal skills independently", async () => {
  const { store } = testStore();
  await store.save(alice, "global", {
    description: "Use when an operator needs the deployment runbook.",
    markdown: "# Global deploy",
    name: "deploy",
  });
  await store.save(alice, "user", {
    description: "Use when Alice needs her deployment checklist.",
    markdown: "# Alice deploy",
    name: "deploy",
  });

  assert.equal(
    (await store.list(null, "global"))[0]?.markdown,
    "# Global deploy"
  );
  assert.equal(
    (await store.list(alice, "user"))[0]?.markdown,
    "# Alice deploy"
  );
  assert.deepEqual(
    (await store.list(null, "global")).map((skill) => skill.name),
    ["deploy"]
  );
  assert.deepEqual(
    (await store.list(alice, "user")).map((skill) => skill.name),
    ["deploy"]
  );
});

test("overwrites a skill at its deterministic Blob path", async () => {
  const { objects, store } = testStore();
  await store.save(alice, "global", {
    description: "Use when deployment help is needed.",
    markdown: "first",
    name: "deploy",
  });
  await store.save(alice, "global", {
    description: "Use when deployment help is needed.",
    markdown: "second",
    name: "deploy",
  });

  assert.equal(objects.objects.size, 1);
  assert.equal((await store.list(null, "global"))[0]?.markdown, "second");
});

test("deletes an existing skill", async () => {
  const { store } = testStore();
  await store.save(alice, "user", {
    description: "Use when Alice deploys.",
    markdown: "steps",
    name: "deploy",
  });
  await store.delete(alice, "user", "deploy");
  assert.deepEqual(await store.list(alice, "user"), []);
});

test("service callers list global skills without personal skills", async () => {
  const { store } = testStore();
  const service = { principalId: "eve:app", principalType: "service" };
  await assert.rejects(
    store.save(service, "global", {
      description: "Use when deployment help is needed.",
      markdown: "steps",
      name: "deploy",
    }),
    MissingHumanUserError
  );
  await store.save(alice, "global", {
    description: "Global skill.",
    markdown: "steps",
    name: "global",
  });
  await store.save(alice, "user", {
    description: "Personal skill.",
    markdown: "steps",
    name: "personal",
  });
  assert.deepEqual(
    (await store.list(service, "global")).map((skill) => skill.name),
    ["global"]
  );
  assert.deepEqual(await store.list(service, "user"), []);
  await assert.rejects(
    store.delete(service, "global", "deploy"),
    MissingHumanUserError
  );
});

test("rejects invalid skill instructions", async () => {
  const { store } = testStore();
  await assert.rejects(
    store.save(alice, "global", {
      description: "Use when deployment help is needed.",
      markdown: "\u0000",
      name: "deploy",
    }),
    InvalidSkillContentError
  );
});

test("allows descriptions up to 1024 characters", async () => {
  const { store } = testStore();
  const description = "a".repeat(MAX_SKILL_DESCRIPTION_LENGTH);
  await store.save(alice, "global", {
    description,
    markdown: "steps",
    name: "deploy",
  });

  assert.equal((await store.list(null, "global"))[0]?.description, description);
  await assert.rejects(
    store.save(alice, "global", {
      description: `${description}a`,
      markdown: "steps",
      name: "deploy",
    }),
    InvalidSkillContentError
  );
});
