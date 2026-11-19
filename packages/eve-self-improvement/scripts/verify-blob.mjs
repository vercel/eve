import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { head } from "@vercel/blob";
const requireConsumer = createRequire(path.resolve(process.argv[2] ?? ".", "package.json"));
const { configSchema, store, BlobStore, storageBackend } = await import(
  pathToFileURL(requireConsumer.resolve("@eve/self-improvement/core"))
);
const c = configSchema.parse({
  instance: `blob-verification-${randomUUID()}`,
  project: {
    teamId: "team_fixture",
    projectId: "prj_fixture",
    productionUrl: "https://fixture.example.com",
  },
  repository: { owner: "fixture", name: "agent" },
  owner: { authenticator: "fixture", principalId: "owner" },
  models: { analyst: "fixture/analyst", maintainer: "fixture/maintainer" },
});
assert.equal(
  storageBackend(c),
  "blob",
  "Run with Blob credentials and no Postgres URL configuration",
);
const db = store(c),
  at = Date.now();
const experiment = {
  id: "synthetic",
  createdAt: at,
  updatedAt: at,
  rootSession: "synthetic-root",
  status: "analyzing",
  base: "a".repeat(40),
  finding: {
    id: "synthetic",
    target: "fixture",
    metric: "failure",
    count: 2,
    samples: 10,
    principals: 2,
    summary: "Isolated storage verification",
  },
  attempts: 0,
  checks: [],
};
const observation = {
  id: "synthetic",
  at,
  session: "pseudonym",
  turn: "pseudonym",
  principal: "pseudonym",
  kind: "tool",
  target: "fixture",
  outcome: "completed",
};
try {
  await db.put("synthetic:large", { padding: "x".repeat(32768) });
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => db.acquire(`worker-${i}`)));
  assert.equal(
    claims.filter(Boolean).length,
    1,
    "The real provider must permit exactly one concurrent claim",
  );
  const privateObject = await head(`${db.prefix}control.json`);
  const anonymous = await fetch(privateObject.url);
  assert.ok(
    [401, 403, 404].includes(anonymous.status),
    "Private ledger must deny unauthenticated reads",
  );
  const first = claims.find(Boolean);
  await db.save(first.lease, experiment);
  assert.deepEqual(await db.get("experiment:synthetic"), experiment);
  const bindings = await Promise.allSettled([
    db.bindSession(first.lease, "coordinatorSession", "one"),
    db.bindSession(first.lease, "coordinatorSession", "two"),
  ]);
  assert.equal(bindings.filter((result) => result.status === "fulfilled").length, 1);
  await db.release(first.lease);
  const next = await db.acquire("recovery");
  assert.ok(next.lease.fence > first.lease.fence);
  assert.equal(next.experiment.id, experiment.id);
  await assert.rejects(db.save(first.lease, experiment), /lease/);
  await db.release(first.lease);
  assert.equal((await db.active()).lease.owner, "recovery");

  let lost = false;
  const transport = {
    ...db.objects,
    async write(...args) {
      const saved = await db.objects.write(...args);
      if (saved && !lost && args[0].endsWith("control.json")) {
        lost = true;
        throw new Error("Synthetic lost response");
      }
      return saved;
    },
  };
  await new BlobStore(transport, db.scope).save(next.lease, { ...experiment, status: "rejected" });
  assert.equal((await db.active()).experiment.status, "rejected");
  await db.put("doctor:expired", { synthetic: true }, -1);
  assert.equal(await db.hasRecord("doctor:expired"), true);
  await db.purge();
  assert.equal(await db.hasRecord("doctor:expired"), false);
  await Promise.all([db.observe(observation), db.observe(observation)]);
  assert.deepEqual(await db.observations(at - 1, at + 1), {
    values: [observation],
    complete: true,
  });
  let now = at + 8 * 86400000;
  const expired = new BlobStore(db.objects, db.scope, 90, 90, () => now);
  await expired.observe({ ...observation, at: now });
  assert.deepEqual(await expired.observations(at - 1, now + 1), { values: [], complete: true });
  await expired.purge();
  assert.equal((await db.objects.list(`${db.prefix}observations/`)).objects.length, 0);
  assert.ok(await db.active(), "Retention must preserve active recovery state");
  console.log(
    JSON.stringify({
      status: "passed",
      storage: "real private Vercel Blob",
      checks: [
        "large ledger strong ETags",
        "anonymous private reads denied",
        "concurrent provider claims",
        "conditional session ownership",
        "stale fencing",
        "interrupted recovery",
        "lost committed response",
        "physical deletion",
        "idempotent observations",
        "original expiry across config changes",
      ],
      fixture: c.instance,
    }),
  );
} finally {
  let cursor;
  do {
    const page = await db.objects.list(db.prefix, cursor);
    for (const object of page.objects) await db.objects.remove(object.path, object.etag);
    cursor = page.cursor;
  } while (cursor);
  assert.equal(
    (await db.objects.list(db.prefix)).objects.length,
    0,
    "Synthetic Blob namespace was not removed",
  );
}
