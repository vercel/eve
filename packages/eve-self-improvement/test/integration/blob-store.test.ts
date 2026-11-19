import { test } from "node:test";
import assert from "node:assert/strict";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { BlobStore, blobObjects, type BlobObjects } from "../../extension/lib/blob-store.js";
import { storageBackend } from "../../extension/lib/store.js";
import { digest } from "../../extension/lib/config.js";
import { config, experiment, observation } from "./fixtures.js";

const DAY = 86400000,
  epoch = Date.UTC(2026, 10, 15, 12);
class Objects implements BlobObjects {
  values = new Map<string, { text: string; etag: string }>();
  version = 0;
  failBefore?: string;
  loseResponse?: string;
  async read(path: string) {
    const value = this.values.get(path);
    return value ? { ...value } : null;
  }
  async write(path: string, text: string, etag: string | null) {
    if (this.failBefore && path.includes(this.failBefore)) {
      this.failBefore = undefined;
      throw new Error("Fixture write interrupted");
    }
    if ((this.values.get(path)?.etag ?? null) !== etag) return false;
    this.values.set(path, { text, etag: String(++this.version) });
    if (this.loseResponse && path.includes(this.loseResponse)) {
      this.loseResponse = undefined;
      throw new Error("Fixture lost committed response");
    }
    return true;
  }
  async remove(path: string, etag: string) {
    if (this.values.get(path)?.etag !== etag) return false;
    return this.values.delete(path);
  }
  async list(prefix: string, cursor?: string) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
      .sort();
    const page = keys.slice(0, 37);
    return {
      objects: page.map((path) => ({ path, etag: this.values.get(path)!.etag })),
      cursor: keys.length > page.length ? page.at(-1) : undefined,
    };
  }
}
function fixture() {
  const objects = new Objects();
  let now = epoch;
  const db = new BlobStore(objects, "fixture", 7, 90, () => now);
  return {
    objects,
    db,
    time(value: number) {
      now = value;
    },
  };
}

test("new installs use Blob; existing database configuration never silently changes ledgers", () => {
  assert.equal(storageBackend(config(), {}), "blob");
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "EVE_EVOLUTION_DATABASE_URL"])
    assert.equal(storageBackend(config(), { [name]: "postgresql://fixture" }), "postgres");
  assert.equal(
    storageBackend(config({ databaseUrl: () => "postgresql://fixture" }), {}),
    "postgres",
  );
  assert.equal(storageBackend(config({ database: "vercel-postgres" }), {}), "vercel-postgres");
  assert.equal(
    storageBackend(config({ database: "blob" }), { DATABASE_URL: "postgresql://fixture" }),
    "blob",
  );
});
test("Blob claims, recovery and fencing remain atomic across independent workers", async () => {
  const { db, objects, time } = fixture();
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new BlobStore(objects, db.scope, 7, 90, db.now).acquire(`runner-${i}`, 1000),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  await db.save(first.lease, experiment());
  time(epoch + 1001);
  const next = (await db.acquire("resumed"))!;
  assert.ok(next.lease.fence > first.lease.fence);
  assert.equal(next.experiment?.id, "fixture");
  await assert.rejects(db.save(first.lease, experiment()), /lease/);
  await assert.rejects(db.renew(first.lease), /lease/);
  await assert.rejects(db.bindSession(first.lease, "coordinatorSession", "stale"), /lease/);
  await db.release(first.lease);
  assert.equal((await db.active())!.lease.owner, "resumed");
  await db.release(next.lease);
  assert.equal((await db.active())!.lease.owner, null);
  assert.ok((await db.acquire("third"))!.lease.fence > next.lease.fence);
});
test("Blob saves active state and history together and reconciles a lost commit response", async () => {
  const { db, objects } = fixture();
  objects.loseResponse = "control.json";
  const claim = (await db.acquire("root"))!;
  assert.ok(claim);
  objects.failBefore = "control.json";
  await assert.rejects(db.save(claim.lease, experiment()), /interrupted/);
  assert.equal(await db.active(), null);
  assert.equal(await db.get("experiment:fixture"), null);
  objects.loseResponse = "control.json";
  await db.save(claim.lease, { ...experiment(), status: "rejected" });
  assert.equal((await db.active())!.experiment!.status, "rejected");
  assert.equal((await db.get<{ status: string }>("experiment:fixture"))!.status, "rejected");
  await db.save(claim.lease, null);
  assert.equal(await db.get("active"), null);
  assert.equal((await db.get<{ status: string }>("experiment:fixture"))!.status, "rejected");
});
test("a provider retry returning conflict after a committed claim still returns its real lease", async () => {
  const { db, objects } = fixture();
  const write = objects.write.bind(objects);
  let uncertain = true;
  objects.write = async (...args) => {
    const saved = await write(...args);
    if (saved && uncertain) {
      uncertain = false;
      return false;
    }
    return saved;
  };
  const claim = await db.acquire("same-operation");
  assert.ok(claim);
  assert.equal(claim.lease.fence, 1);
  await db.save(claim.lease, experiment());
});

test("parallel Blob session bindings have one owner and accept idempotent retries", async () => {
  const { db } = fixture(),
    claim = (await db.acquire("root"))!;
  await db.save(claim.lease, experiment());
  const bindings = await Promise.allSettled([
    db.bindSession(claim.lease, "coordinatorSession", "one"),
    db.bindSession(claim.lease, "coordinatorSession", "two"),
  ]);
  assert.equal(bindings.filter((result) => result.status === "fulfilled").length, 1);
  const coordinator = (await db.active())!.experiment!.coordinatorSession!;
  await db.bindSession(claim.lease, "coordinatorSession", coordinator);
  await db.bindSession(claim.lease, "writerSession", "writer");
  await assert.rejects(db.bindSession(claim.lease, "writerSession", "intruder"), /already owns/);
});
test("Blob retention physically removes expired history and preserves the recovery fence", async () => {
  const { db, time } = fixture(),
    claim = (await db.acquire("root"))!;
  await db.save(claim.lease, experiment());
  await db.put("expired", { private: "synthetic" }, -1);
  assert.equal(await db.get("expired"), null);
  assert.equal(await db.hasRecord("expired"), true);
  assert.equal(await db.purge(), 1);
  assert.equal(await db.hasRecord("expired"), false);
  time(epoch + 91 * DAY);
  await db.purge();
  assert.equal(await db.hasRecord("experiment:fixture"), false);
  assert.equal((await db.active())!.experiment!.id, "fixture");
  assert.ok((await db.acquire("recovery"))!.lease.fence > claim.lease.fence);
});
test("Blob namespaces isolate evidence, history and leases; list prefixes remain literal", async () => {
  const { db, objects } = fixture(),
    other = new BlobStore(objects, "other", 7, 90, db.now);
  await Promise.all([
    db.put("experiment:plain", { id: 1, updatedAt: 2 }),
    db.put("experiment:foo_%", { id: 2, updatedAt: 3 }),
  ]);
  assert.deepEqual(await db.list("experiment:foo_%"), [{ id: 2, updatedAt: 3 }]);
  assert.deepEqual(await db.list("experiment:", 1), [{ id: 2, updatedAt: 3 }]);
  await db.observe(observation(1, { at: epoch }));
  assert.deepEqual(await other.observations(0, epoch + 1), { values: [], complete: true });
  assert.deepEqual(await other.list("experiment:"), []);
  assert.ok(await db.acquire("one"));
  assert.ok(await other.acquire("two"));
  await other.purge();
  assert.equal((await db.observations(0, epoch + 1)).values.length, 1);
});
test("Blob retries preserve the first observation and original expiry across config changes", async () => {
  const { db, objects, time } = fixture(),
    original = observation(1, { at: epoch });
  await Promise.all([db.observe(original), db.observe(original)]);
  const before = [...objects.values].filter(([path]) => path.includes("/observations/"));
  const longerRetention = new BlobStore(objects, db.scope, 90, 90, db.now);
  time(epoch + DAY);
  await longerRetention.observe({ ...original, at: epoch + DAY, outcome: "changed retry" });
  assert.deepEqual(
    [...objects.values].filter(([path]) => path.includes("/observations/")),
    before,
  );
  assert.deepEqual((await longerRetention.observations(0, epoch + 2 * DAY)).values, [original]);
  time(epoch + 8 * DAY);
  assert.deepEqual(await longerRetention.observations(0, epoch + 9 * DAY), {
    values: [],
    complete: true,
  });
  assert.equal(await longerRetention.purge(), 1);
  assert.equal(objects.values.size, 0, "Both body and time index must be physically deleted");
  await db.observe(original);
  assert.equal(objects.values.size, 0, "Old replays cannot renew retention after deletion");
});
test("Blob interruption leaves explicitly incomplete evidence and the retry repairs it", async () => {
  const { db, objects } = fixture(),
    sample = observation(1, { at: epoch });
  objects.failBefore = "/observations/";
  await assert.rejects(db.observe(sample), /interrupted/);
  assert.deepEqual(await db.observations(0, epoch + 1), { values: [], complete: false });
  await db.observe(sample);
  assert.deepEqual(await db.observations(0, epoch + 1), { values: [sample], complete: true });
  const body = [...objects.values.keys()].find((path) => path.includes("/observations/"))!;
  objects.values.delete(body);
  assert.equal(
    (await db.observations(0, epoch + 1)).complete,
    false,
    "Missing bodies never become passing empty evidence",
  );
});
test("racing duplicate Blob observations repair indexes without inventing a second sample", async () => {
  const { db, objects } = fixture();
  await Promise.all([
    db.observe(observation(1, { at: epoch - 1000 })),
    db.observe(observation(1, { at: epoch })),
  ]);
  assert.equal((await db.observations(0, epoch + 1)).values.length, 1);
  assert.equal((await db.observations(0, epoch + 1)).complete, true);
  assert.equal([...objects.values.keys()].filter((path) => path.includes("/index/")).length, 1);
});
test("Blob purges expired unindexed bodies after interrupted index cleanup", async () => {
  const { db, objects, time } = fixture();
  await db.observe(observation(1, { at: epoch }));
  const marker = [...objects.values.keys()].find((path) => path.includes("/index/"))!;
  objects.values.delete(marker);
  time(epoch + 8 * DAY);
  assert.equal(await db.purge(), 1);
  assert.equal(objects.values.size, 0);
});
test("Blob paginated windows cap real samples and report truncation honestly", async () => {
  const { db, objects } = fixture();
  for (let i = 0; i < 10001; i++) {
    const value = observation(i, { at: epoch }),
      expiresAt = epoch + DAY;
    const index = `${db.prefix}index/2026-11-15/${epoch}_${expiresAt}_${digest(value.id)}.json`;
    objects.values.set(index, { text: "{}", etag: String(++objects.version) });
    objects.values.set(`${db.prefix}observations/${digest(value.id)}.json`, {
      text: JSON.stringify({ value, expiresAt, index }),
      etag: String(++objects.version),
    });
  }
  const result = await db.observations(epoch - 1, epoch + 1);
  assert.equal(result.values.length, 10000);
  assert.equal(result.complete, false);
});
test("Blob adapter uses private origin reads and guarded writes/deletes, without hiding auth failures", async () => {
  const calls: any[] = [];
  let body: string | null = null;
  let fail: Error | null = null;
  const sdk: any = {
    get: async (...args: any[]) => {
      calls.push(["get", ...args]);
      return body === null
        ? null
        : { statusCode: 200, stream: new Response(body).body, blob: { etag: "original" } };
    },
    put: async (...args: any[]) => {
      calls.push(["put", ...args]);
      if (fail) throw fail;
      body = args[1];
      return {};
    },
    del: async (...args: any[]) => {
      calls.push(["del", ...args]);
      if (fail) throw fail;
      body = null;
    },
    list: async () => ({ blobs: [], hasMore: false }),
  };
  const objects = blobObjects(sdk);
  assert.equal(await objects.write("state", "{}", null), true);
  await objects.read("state");
  assert.equal(calls[1][2].useCache, false);
  assert.equal(calls[1][2].access, "private");
  assert.equal(
    calls[1][2].headers["accept-encoding"],
    "identity",
    "Large compressed JSON responses otherwise return weak, unusable ETags",
  );
  assert.equal(calls[0][3].access, "private");
  assert.equal(calls[0][3].addRandomSuffix, false);
  assert.equal(calls[0][3].allowOverwrite, false);
  await objects.write("state", '{"revision":2}', "original");
  assert.equal(calls.at(-1)[3].ifMatch, "original");
  assert.equal(calls.at(-1)[3].allowOverwrite, true);
  await objects.remove("state", "original");
  assert.equal(calls.at(-1)[2].ifMatch, "original");
  fail = new BlobPreconditionFailedError();
  assert.equal(await objects.write("state", "{}", "stale"), false);
  fail = new Error("Fixture auth rejected");
  await assert.rejects(objects.write("state", "{}", null), /auth rejected/);
  await assert.rejects(objects.write("state", "{}", "original"), /auth rejected/);
});

test("unexpected weak Blob validators fail closed instead of bypassing fencing", async () => {
  const sdk: any = {
    get: async () => ({
      statusCode: 200,
      stream: new Response("{}").body,
      blob: { etag: 'W/"weak"' },
    }),
  };
  await assert.rejects(blobObjects(sdk).read("control"), /strong origin ETag/);
});
