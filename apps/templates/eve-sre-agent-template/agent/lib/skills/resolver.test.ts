import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCustomSkills } from "./resolver.ts";
import type { StoredSkill } from "./store.ts";

const SKILL_LOAD_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const globalSkill: StoredSkill = {
  description: "Use when a deployment runbook is needed.",
  markdown: "# Global",
  name: "deploy",
  scope: "global",
  updatedAt: "2026-08-03T12:00:00.000Z",
};

const userSkill: StoredSkill = {
  ...globalSkill,
  description: "Use when Alice needs her deployment checklist.",
  markdown: "# Personal",
  scope: "user",
};

test("loads global skills for service-triggered investigations", async () => {
  const resolved = await resolveCustomSkills(
    { principalId: "eve:app", principalType: "service" },
    {
      list(auth, scope) {
        if (scope === "global") {
          return Promise.resolve([globalSkill]);
        }
        return Promise.resolve(
          auth?.principalType === "user" ? [userSkill] : []
        );
      },
    }
  );

  assert.deepEqual(Object.keys(resolved ?? {}), ["custom-deploy"]);
  assert.equal(
    resolved?.["custom-deploy"]?.description,
    globalSkill.description
  );
  assert.equal(resolved?.["custom-deploy"]?.markdown, "# Global");
});

test("personal skills shadow global skills for a human Slack user", async () => {
  const resolved = await resolveCustomSkills(
    {
      attributes: { team_id: "T1" },
      authenticator: "slack-webhook",
      issuer: "slack:T1",
      principalId: "slack:T1:U1",
      principalType: "user",
    },
    {
      list(_auth, scope) {
        return Promise.resolve(
          scope === "global" ? [globalSkill] : [userSkill]
        );
      },
    }
  );

  assert.equal(resolved?.["custom-deploy"]?.markdown, "# Personal");
});

test("keeps available skills when one scope fails to load", async () => {
  const resolved = await resolveCustomSkills(
    {
      attributes: { team_id: "T1" },
      authenticator: "slack-webhook",
      issuer: "slack:T1",
      principalId: "slack:T1:U1",
      principalType: "user",
    },
    {
      list(_auth, scope) {
        if (scope === "global") {
          return Promise.reject(new Error("Blob unavailable"));
        }
        return Promise.resolve([userSkill]);
      },
    }
  );

  assert.equal(resolved?.["custom-deploy"]?.markdown, "# Personal");
});

test("long stored names remain loadable and preserve personal overrides", async () => {
  const names = [
    "a".repeat(57),
    "a".repeat(58),
    "a".repeat(64),
    `${"a".repeat(63)}b`,
    `${"a".repeat(40)}-d5c039b748aa6466`,
  ] as const;
  const resolved = await resolveCustomSkills(null, {
    list(_auth, scope) {
      return Promise.resolve(
        scope === "global"
          ? names.map((name) => ({ ...globalSkill, markdown: name, name }))
          : [{ ...userSkill, name: names[2] }]
      );
    },
  });

  const entries = Object.entries(resolved ?? {});
  assert.equal(entries.length, 5);
  for (const [name] of entries) {
    assert.match(name, SKILL_LOAD_NAME_PATTERN);
  }
  assert.equal(resolved?.[`custom-${names[0]}`]?.markdown, names[0]);
  assert.deepEqual(
    entries.map(([, skill]) => skill.markdown),
    [names[0], names[1], "# Personal", names[3], names[4]]
  );
});

test("continues without custom skills when storage is unavailable", async () => {
  const resolved = await resolveCustomSkills(null, {
    list() {
      throw new Error("Blob store is unavailable");
    },
  });

  assert.equal(resolved, null);
});
