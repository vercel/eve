import assert from "node:assert/strict";
import { test } from "node:test";

import { assertJobIdentity, createJobIdentity, identityHash } from "./job-identity.ts";

const input = {
  name: "resume",
  harness: "eve@local",
  model: "provider/model",
  attempts: 2,
  dataset: {
    name: "bench",
    version: "2",
    gitUrl: "https://example.com/tasks",
    commit: "abc",
    tasks: ["a", "b"],
  },
  tasks: [
    { name: "a", hash: "aaa" },
    { name: "b", hash: "bbb" },
  ],
  provenance: { key: "bundle", build: { version: "1", sha: "abc" } },
};

test("identity is stable across object key and selected task order, and JSON round trips", () => {
  const expected = createJobIdentity(input);
  const reordered = createJobIdentity({
    ...input,
    tasks: [...input.tasks].reverse(),
    provenance: { build: { sha: "abc", version: "1" }, key: "bundle" },
  });
  assert.deepEqual(reordered, expected);
  assertJobIdentity(JSON.parse(JSON.stringify(expected)), reordered);
  assert.equal(
    identityHash({ b: [1, { z: 2, a: 3 }], a: true }),
    identityHash({ a: true, b: [1, { a: 3, z: 2 }] }),
  );
  assert.notEqual(identityHash([1, 2]), identityHash([2, 1]));
  assert.notEqual(identityHash(["ab", "c"]), identityHash(["a", "bc"]));
});

for (const [field, changes] of [
  ["job", { name: "different" }],
  ["harness", { harness: "oracle" }],
  ["model", { model: "provider/other" }],
  ["attempts", { attempts: 3 }],
  ["tasks", { tasks: [{ name: "renamed", hash: "aaa" }, input.tasks[1]!] }],
  ["tasks", { tasks: [{ name: "a", hash: "changed" }, input.tasks[1]!] }],
  ["tasks", { tasks: input.tasks.slice(0, 1) }],
  ["provenance", { provenance: { key: "bundle", build: { version: "1", sha: "changed" } } }],
  ...(["name", "version", "gitUrl", "commit"] as const).map(
    (key) => ["dataset", { dataset: { ...input.dataset, [key]: "changed" } }] as const,
  ),
] as const) {
  test(`changed ${field} refuses resume with an actionable error`, () => {
    assert.throws(
      () =>
        assertJobIdentity(createJobIdentity(input), createJobIdentity({ ...input, ...changes })),
      new RegExp(`differs \\(.*${field}.*\\).*new job name`),
    );
  });
}

test("unselected dataset task inventory does not change selected content identity", () => {
  assert.deepEqual(
    createJobIdentity({ ...input, dataset: { ...input.dataset, tasks: ["a", "b", "unselected"] } }),
    createJobIdentity(input),
  );
});

test("legacy, unsupported, and incomplete identities fail closed", () => {
  const expected = createJobIdentity(input);
  for (const saved of [undefined, null, {}, "bad", { ...expected, version: 2 }, { version: 1 }]) {
    assert.throws(() => assertJobIdentity(saved, expected), /new job name/);
  }
});

test("duplicate task names cannot share trial directories", () => {
  assert.throws(
    () => createJobIdentity({ ...input, tasks: [input.tasks[0]!, input.tasks[0]!] }),
    /unique/,
  );
});

test("absent provenance is stable and distinct from recorded provenance", () => {
  const { provenance: _provenance, ...without } = input;
  assert.deepEqual(createJobIdentity(without), createJobIdentity({ ...without, provenance: {} }));
  assert.throws(
    () => assertJobIdentity(createJobIdentity(without), createJobIdentity(input)),
    /provenance/,
  );
});
