import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database migrations", () => {
  it("creates a validated schema and keeps adoption migrations idempotent", async () => {
    const database = createDatabase();

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0001_better-auth.sql");
    await applyMigration(database, "0002_heavy_celestials.sql");
    await applyMigration(database, "0003_unusual_fabian_cortez.sql");
    await applyMigration(database, "0004_kind_manta.sql");
    await applyMigration(database, "0005_brave_kang.sql");
    await applyMigration(database, "0006_illegal_tattoo.sql");
    await applyMigration(database, "0007_known_fenris.sql");
    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0001_better-auth.sql");

    await database.exec(`
      INSERT INTO workspaces VALUES ('workspace-1', '2026-01-01');
      INSERT INTO vault_items VALUES (
        'contact-1',
        'workspace-1',
        'contact',
        'Checkout',
        '',
        '2026-01-01',
        '2026-01-01'
      );
    `);
    await applyMigration(database, "0008_black_sandman.sql");
    await applyMigration(database, "0009_cold_power_man.sql");
    await applyMigration(database, "0010_rapid_cerise.sql");
    await applyMigration(database, "0011_faulty_unicorn.sql");
    await applyMigration(database, "0012_harsh_domino.sql");
    await applyMigration(database, "0013_last_christian_walker.sql");
    await applyMigration(database, "0014_chief_tigra.sql");

    const tables = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'workspaces',
           'workstreams',
           'workspace_memberships',
           'vault_items',
           'settings',
           'user_profiles',
           'agent_sessions',
           'browser_image_artifacts',
           'browser_sessions',
           'browser_traces',
           'browser_trace_domains',
           'browser_trace_events',
           'chats',
           'scheduled_agent_jobs',
           'scheduled_agent_runs',
           'encrypted_secrets',
           'user',
           'session',
           'account',
           'verification'
         )`
    );
    const pendingConstraints = await pendingConstraintCount(database);

    expect(tables.rows[0]?.count).toBe(20);
    expect(pendingConstraints).toBe(0);
    await expect(
      database.query("SELECT id FROM vault_items WHERE id = 'contact-1'")
    ).resolves.toMatchObject({
      rows: [{ id: "contact-1" }],
    });
  }, 15_000);

  it("reconciles the pre-merge reply-anchor migration", async () => {
    const database = createDatabase();
    await database.exec(`
      CREATE TABLE chats (session_id text PRIMARY KEY);
      CREATE TABLE scheduled_agent_jobs (
        id text PRIMARY KEY,
        reply_anchor_message_id text
      );
    `);

    await applyMigration(database, "0012_harsh_domino.sql");

    const columns = await database.query<{ columnName: string }>(`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE (table_name = 'chats' AND column_name = 'channel')
         OR (table_name = 'scheduled_agent_jobs' AND column_name = 'reply_anchor_message_id')
      ORDER BY column_name
    `);

    expect(columns.rows).toEqual([
      { columnName: "channel" },
      { columnName: "reply_anchor_message_id" },
    ]);
  });

  it("preserves legacy rows while enforcing constraints for new writes", async () => {
    const database = createDatabase();
    await database.exec(legacyRuntimeSchema);
    await database.exec(`
      INSERT INTO vault_items
      VALUES (
        'legacy-item',
        'orphan-workspace',
        'legacy-kind',
        'Legacy',
        '',
        '2026-01-01',
        '2026-01-01'
      );
      INSERT INTO chats (
        session_id,
        workspace_id,
        title,
        created_at,
        updated_at
      ) VALUES (
        'legacy-chat',
        'orphan-workspace',
        'Legacy',
        '2026-01-01',
        '2026-01-01'
      );
      `);

    await applyMigration(database, "0000_fluffy_the_spike.sql");
    await applyMigration(database, "0002_heavy_celestials.sql");

    const vault = await database.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM vault_items WHERE id = 'legacy-item'"
    );
    const chat = await database.query<{
      costUsd: number | null;
      inputTokens: number;
      outputTokens: number;
    }>(`SELECT
      cost_usd AS "costUsd",
      input_tokens AS "inputTokens",
      output_tokens AS "outputTokens"
    FROM chats
    WHERE session_id = 'legacy-chat'`);

    expect(vault.rows).toEqual([{ id: "legacy-item", kind: "legacy-kind" }]);
    expect(chat.rows).toEqual([
      { costUsd: null, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(await pendingConstraintCount(database)).toBe(14);
    await expect(
      database.exec(`
        INSERT INTO vault_items
        VALUES (
          'new-invalid',
          'orphan-workspace',
          'legacy-kind',
          'Invalid',
          '',
          '2026-01-01',
          '2026-01-01'
        )
        `)
    ).rejects.toThrow(/constraint/);
  }, 15_000);

  it("adopts existing Better Auth tables without changing their rows", async () => {
    const database = createDatabase();
    await database.exec(legacyAuthSchema);
    await database.exec(`
      INSERT INTO "user" (
        id,
        name,
        email,
        "emailVerified",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-user',
        'Auth User',
        'auth@example.com',
        false,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
      INSERT INTO "account" (
        id,
        issuer,
        "accountId",
        "providerId",
        "userId",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-account',
        'credential',
        'auth-user',
        'credential',
        'auth-user',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
      INSERT INTO "session" (
        id,
        "expiresAt",
        token,
        "createdAt",
        "updatedAt",
        "userId"
      ) VALUES (
        'auth-session',
        '2027-01-01T00:00:00Z',
        'auth-token',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        'auth-user'
      );
      INSERT INTO "verification" (
        id,
        identifier,
        value,
        "expiresAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        'auth-verification',
        '+12125550123',
        'hashed-code',
        '2027-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
    `);

    await applyMigration(database, "0001_better-auth.sql");
    await applyMigration(database, "0001_better-auth.sql");
    await database.exec(`
      UPDATE "user"
      SET "phoneNumber" = '+12125550123', "phoneNumberVerified" = true
      WHERE id = 'auth-user'
    `);

    const rows = await database.query<{
      accountId: string;
      sessionId: string;
      userId: string;
      verificationId: string;
    }>(`
      SELECT
        "account".id AS "accountId",
        "session".id AS "sessionId",
        "user".id AS "userId",
        "verification".id AS "verificationId"
      FROM "user"
      JOIN "account" ON "account"."userId" = "user".id
      JOIN "session" ON "session"."userId" = "user".id
      JOIN "verification" ON "verification".identifier = "user"."phoneNumber"
    `);

    expect(rows.rows).toEqual([
      {
        accountId: "auth-account",
        sessionId: "auth-session",
        userId: "auth-user",
        verificationId: "auth-verification",
      },
    ]);
    await expect(
      database.exec(`
        INSERT INTO "session" (
          id,
          "expiresAt",
          token,
          "createdAt",
          "updatedAt",
          "userId"
        ) VALUES (
          'orphan-session',
          now(),
          'orphan-token',
          now(),
          now(),
          'missing-user'
        )
      `)
    ).rejects.toThrow(/foreign key constraint/);
  }, 15_000);
});

function createDatabase() {
  const database = new PGlite();
  databases.push(database);
  return database;
}

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function pendingConstraintCount(database: PGlite) {
  const result = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pg_constraint
     WHERE NOT convalidated
       AND connamespace = 'public'::regnamespace`
  );
  return result.rows[0]?.count;
}

const legacyRuntimeSchema = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspace_memberships (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE vault_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    account TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
  );
  CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE browser_sessions (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE chats (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE encrypted_secrets (
    workspace_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, namespace, id)
  );
`;

const legacyAuthSchema = `
  CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN DEFAULT false NOT NULL,
    image TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT now() NOT NULL
  );
  CREATE TABLE "account" (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX "account_issuer_accountId_uidx"
    ON "account" (issuer, "accountId");
  CREATE INDEX "account_userId_idx" ON "account" ("userId");
  CREATE TABLE "session" (
    id TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  );
  CREATE INDEX "session_userId_idx" ON "session" ("userId");
  CREATE TABLE "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT now() NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT now() NOT NULL
  );
  CREATE INDEX "verification_identifier_idx"
    ON "verification" (identifier);
`;
