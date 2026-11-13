import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPrivacyLock } from "../server/browser/privacy-lock";

const databaseUrl = process.env.TEST_LINK_DATABASE_URL;
describe.skipIf(!databaseUrl)("Browser privacy with PostgreSQL", () => {
  const schema = `privacy_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, first: Pool, second: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    first = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    second = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await first.query(
      await readFile(new URL("../migrations/003_link_checkout.sql", import.meta.url), "utf8"),
    );
  });
  afterAll(async () => {
    await first?.end();
    await second?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("serializes independent workers and rejects a read queued behind payment entry", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const payment = withBrowserPrivacyLock(
      "same-browser",
      async ({ quarantine }) => {
        entered();
        await gate;
        await quarantine();
      },
      first,
    );
    await started;
    const read = withBrowserPrivacyLock("same-browser", async () => "private-snapshot", second);
    const result = expect(read).rejects.toThrow("Payment details may remain");
    release();
    await payment;
    await result;
    expect(await withBrowserPrivacyLock("different-browser", async () => "safe", second)).toBe(
      "safe",
    );
  });
  it("retains the committed guard after an interrupted payment and client replacement", async () => {
    await expect(
      withBrowserPrivacyLock(
        "interrupted",
        async ({ quarantine }) => {
          await quarantine();
          throw new Error("interrupted fill");
        },
        first,
      ),
    ).rejects.toThrow("interrupted fill");
    await first.end();
    first = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await expect(
      withBrowserPrivacyLock("interrupted", async () => "private-snapshot", first),
    ).rejects.toThrow("Payment details may remain");
    expect(
      (
        await first.query(
          "SELECT session_id FROM bell_browser_privacy_guards WHERE session_id=$1",
          ["interrupted"],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("requires the lock before recording sensitive entry", async () => {
    let quarantine: (() => Promise<void>) | undefined;
    await withBrowserPrivacyLock(
      "released",
      async (context) => {
        quarantine = context.quarantine;
      },
      first,
    );
    await expect(quarantine!()).rejects.toThrow("private browser lock");
  });
});
