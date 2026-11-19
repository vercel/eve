import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { Store, databaseConnection, type Sql } from "../../extension/lib/store.js";
import { experiment, observation } from "./fixtures.js";
import { config, BASE, HEAD } from "./fixtures.js";
import { GitHub } from "../../extension/lib/providers.js";
import { reconcilePublication } from "../../extension/lib/publish.js";
import { authorizeCoordinator, authorizeAnalyst } from "../../extension/lib/delegation.js";

let sql: Sql, stop: () => Promise<void>;
const scopes: string[] = [];
const makeStore = () => {
  const scope = `fixture-${randomUUID()}`;
  scopes.push(scope);
  return new Store(sql, scope, 7, 90);
};
before(async () => {
  if (process.env.EVE_EVOLUTION_TEST_DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.EVE_EVOLUTION_TEST_DATABASE_URL,
      max: 8,
    });
    sql = pool;
    stop = () => pool.end();
  } else {
    const database = new PGlite();
    await database.waitReady;
    sql = {
      async query(text, values) {
        const result = await database.query(text, values);
        return {
          rows: result.rows,
          rowCount: /^\s*SELECT\b/.test(text) ? result.rows.length : (result.affectedRows ?? 0),
        };
      },
    };
    stop = () => database.close();
  }
});
after(async () => {
  if (scopes.length)
    await sql.query("DELETE FROM eve_evolution_records WHERE namespace=ANY($1)", [scopes]);
  await stop();
});

test("Vercel Postgres defers and refreshes project-scoped OIDC with verified TLS", async () => {
  const calls: unknown[] = [];
  const { options, key } = databaseConnection(
    config({ database: "vercel-postgres" }),
    { PGHOST: "database.fixture", PGPORT: "5432" },
    async (options) => {
      calls.push(options);
      return `synthetic-oidc-${calls.length}`;
    },
  );
  assert.equal(calls.length, 0, "Module/config setup must not request an OIDC token");
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.sslnegotiation, "direct");
  assert.equal(options.maxLifetimeSeconds, 1500);
  assert.equal(options.connectionString, undefined);
  assert.equal(typeof options.password, "function");
  const password = options.password as () => Promise<string>;
  assert.equal(await password(), "synthetic-oidc-1");
  assert.equal(await password(), "synthetic-oidc-2");
  assert.deepEqual(calls, [
    { project: "prj_fixture", team: "team_fixture" },
    { project: "prj_fixture", team: "team_fixture" },
  ]);
  assert.ok(
    !key.includes("synthetic-oidc"),
    "Pool identity must not contain a resolved OIDC token",
  );
  const other = databaseConnection(
    config({
      database: "vercel-postgres",
      project: {
        teamId: "team_other",
        projectId: "prj_other",
        productionUrl: "https://other.example.com",
      },
    }),
    { PGHOST: "database.fixture" },
  );
  assert.notEqual(key, other.key, "Different projects cannot share the first project's OIDC pool");
});
test("standard and explicit Postgres URLs remain compatible and take precedence", () => {
  const c = config({ database: "vercel-postgres" });
  for (const name of ["EVE_EVOLUTION_DATABASE_URL", "POSTGRES_URL", "DATABASE_URL"]) {
    const { options } = databaseConnection(c, { [name]: "postgresql://fixture/records" });
    assert.equal(options.connectionString, "postgresql://fixture/records");
    assert.equal(options.password, undefined);
  }
  const explicit = databaseConnection(
    config({ databaseUrl: () => "postgresql://fixture/explicit" }),
    { POSTGRES_URL: "postgresql://fixture/fallback" },
  );
  assert.equal(explicit.options.connectionString, "postgresql://fixture/explicit");
});
test("Vercel Postgres needs explicit opt-in and real project connection settings", () => {
  assert.throws(() => databaseConnection(config(), { PGHOST: "database.fixture" }), /Configure/);
  assert.throws(() => databaseConnection(config({ database: "vercel-postgres" }), {}), /PGHOST/);
  assert.throws(
    () =>
      databaseConnection(config({ database: "vercel-postgres" }), {
        PGHOST: "database.fixture",
        PGPORT: "NaN",
      }),
    /PGPORT/,
  );
});

test("concurrent claims execute only one experiment; releases allow later recovery", async () => {
  const db = makeStore();
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => db.acquire(`runner-${i}`)));
  const winner = claims.find(Boolean)!;
  assert.equal(claims.filter(Boolean).length, 1);
  await db.save(winner.lease, experiment());
  await db.release(winner.lease);
  const resumed = await db.acquire("resuming-runner");
  assert.equal(resumed!.experiment!.id, "fixture");
  assert.ok(resumed!.lease.fence > winner.lease.fence);
});
test("expired holders cannot save or release a newer fenced claim", async () => {
  const db = makeStore(),
    first = (await db.acquire("old", 60))!;
  await setTimeout(85);
  const second = (await db.acquire("new"))!;
  await assert.rejects(db.save(first.lease, experiment()), /lease/);
  await db.release(first.lease);
  await db.save(second.lease, { ...experiment(), status: "review" });
  assert.equal((await db.active())!.lease.owner, "new");
});
test("parallel coordinator/writer delegations cannot share the same fenced stage", async () => {
  const db = makeStore(),
    active = (await db.acquire("root"))!;
  await db.save(active.lease, experiment());
  const claims = await Promise.allSettled([
    db.bindSession(active.lease, "coordinatorSession", "one"),
    db.bindSession(active.lease, "coordinatorSession", "two"),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  const e = (await db.active())!.experiment!;
  await db.bindSession(active.lease, "coordinatorSession", e.coordinatorSession!);
  await db.bindSession(active.lease, "writerSession", "writer");
  await assert.rejects(
    db.bindSession(active.lease, "writerSession", "other-writer"),
    /already owns/,
  );
});
test("coordinator and analyst require the actual scheduled root and immediate parent", async () => {
  const db = makeStore(),
    active = (await db.acquire("scheduled-root"))!;
  await db.save(active.lease, { ...experiment(), status: "analyzing" });
  const app = { authenticator: "app", principalType: "runtime", principalId: "eve:app" };
  const ctx: any = {
    session: {
      id: "coordinator",
      auth: { current: app },
      parent: { sessionId: "root-fixture", rootSessionId: "root-fixture" },
    },
  };
  await authorizeCoordinator(config(), ctx, db);
  await assert.rejects(
    authorizeCoordinator(
      config(),
      {
        session: {
          ...ctx.session,
          auth: {
            current: { authenticator: "basic", principalType: "user", principalId: "eve:app" },
          },
        },
      } as any,
      db,
    ),
  );
  await assert.rejects(
    authorizeCoordinator(
      config(),
      {
        session: { ...ctx.session, parent: { sessionId: "copy", rootSessionId: "root-fixture" } },
      } as any,
      db,
    ),
  );
  await assert.rejects(
    authorizeCoordinator(
      config(),
      { session: { ...ctx.session, id: "second-coordinator" } } as any,
      db,
    ),
  );
  const analyst: any = {
    session: {
      id: "analyst",
      auth: { current: app },
      parent: { sessionId: "coordinator", rootSessionId: "root-fixture" },
    },
  };
  await authorizeAnalyst(config(), analyst, db);
  await assert.rejects(authorizeAnalyst(config(), ctx, db));
  await db.release(active.lease);
  await assert.rejects(authorizeAnalyst(config(), analyst, db));
});
test("namespace isolation covers telemetry, experiment decisions and claims", async () => {
  const a = makeStore(),
    b = makeStore();
  await a.put("experiment:same", { status: "rejected" });
  await a.observe(observation(1, { at: Date.now() }));
  assert.equal(await b.get("experiment:same"), null);
  assert.deepEqual((await b.observations(0, Date.now() + 1000)).values, []);
  assert.ok(await a.acquire("one"));
  assert.ok(await b.acquire("two"));
});
test("rejected experiments remain discoverable after interruption and do not become active forever", async () => {
  const db = makeStore(),
    claim = (await db.acquire("runner"))!;
  await db.save(claim.lease, {
    ...experiment(),
    status: "rejected",
    reason: "Hypothesis not reproduced",
  });
  await db.release(claim.lease);
  assert.equal((await db.get<{ status: string }>("experiment:fixture"))!.status, "rejected");
  const next = (await db.acquire("next"))!;
  await db.save(next.lease, null);
  await db.release(next.lease);
  assert.equal(await db.get("active"), null);
  assert.equal((await db.get<{ status: string }>("experiment:fixture"))!.status, "rejected");
});
test("retention physically deletes expired rows without removing the active recovery record", async () => {
  const db = makeStore(),
    active = (await db.acquire("runner"))!;
  await db.save(active.lease, experiment());
  await db.put("expired", { private: "fixture" }, -1);
  const removed = await db.purge();
  assert.equal(removed, 1);
  const physical = await sql.query(
    "SELECT key FROM eve_evolution_records WHERE namespace=$1 AND key='expired'",
    [db.scope],
  );
  assert.equal(physical.rows.length, 0);
  assert.equal((await db.active())!.experiment!.id, "fixture");
});
test("replayed old observations retain their original expiry, not another full retention period", async () => {
  const db = makeStore();
  await db.observe(observation(1, { at: Date.now() - 8 * 86400000 }));
  await db.purge();
  assert.equal((await db.observations(0, Date.now())).values.length, 0);
});
test("event retries are idempotent and list prefixes do not act as SQL wildcards", async () => {
  const db = makeStore(),
    sample = observation(1, { at: Date.now() });
  await db.observe(sample);
  await db.observe(sample);
  assert.equal((await db.observations(0, Date.now() + 1000)).values.length, 1);
  await db.put("experiment:plain", { id: 1 });
  await db.put("experiment:foo_%", { id: 2 });
  assert.deepEqual(await db.list("experiment:foo_%"), [{ id: 2 }]);
});
test("truncated observation windows are explicit, not passing evidence", async () => {
  const db = makeStore();
  await db.init();
  const at = Date.now();
  await sql.query(
    `INSERT INTO eve_evolution_records(namespace,key,value,expires_at) SELECT $1,'observation:bulk-'||n,jsonb_build_object('id',n,'at',$2::bigint),clock_timestamp()+interval '1 day' FROM generate_series(1,10001) n`,
    [db.scope, at],
  );
  const result = await db.observations(at - 1, at + 1);
  assert.equal(result.complete, false);
  assert.equal(result.values.length, 10000);
});
test("a lost signed-commit response reconciles its branch/PR without a second commit", async () => {
  const db = makeStore(),
    active = (await db.acquire("runner"))!;
  const e = {
    ...experiment(),
    publishIntent: {
      expectedHead: BASE,
      digest: "fixture-operation",
      paths: ["agent/tool.ts"],
      summary: "Fixed the reproduced issue",
      addressedThreads: [],
    },
  };
  await db.save(active.lease, e);
  class PublishedGit extends GitHub {
    commits = 0;
    prs = 0;
    override async branch() {
      return HEAD;
    }
    override async graphql<T = any>(): Promise<T> {
      this.commits++;
      throw new Error("Commit should be reconciled, not repeated");
    }
    override async findPr() {
      return this.prs ? { number: 1, html_url: "https://github.com/fixture/agent/pull/1" } : null;
    }
    override async api<T = any>(path: string): Promise<T> {
      if (path.includes("/commits/"))
        return {
          commit: {
            verification: { verified: true },
            message: "Eve-Evolution-Operation: fixture-operation",
            committer: { date: "2026-11-12T00:00:00Z" },
          },
        } as T;
      this.prs++;
      return { number: 1, html_url: "https://github.com/fixture/agent/pull/1" } as T;
    }
  }
  const git = new PublishedGit(config());
  assert.equal(await reconcilePublication(config(), { ...active, experiment: e }, git, db), true);
  assert.equal(git.commits, 0);
  assert.equal(git.prs, 1);
  const recovered = (await db.active())!.experiment!;
  assert.equal(recovered.status, "review");
  assert.equal(recovered.candidate!.head, HEAD);
  assert.equal(
    recovered.publishIntent,
    undefined,
    "Completed intents must not consume the next requested review fix",
  );
  assert.equal(
    await reconcilePublication(config(), { ...active, experiment: recovered }, git, db),
    false,
  );
  assert.equal(git.prs, 1);
});
