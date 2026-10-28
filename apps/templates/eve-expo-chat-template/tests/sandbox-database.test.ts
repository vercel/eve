import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("database gateway authenticates, binds values, isolates failures and preserves committed data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eve-storage-test-"));
  const secret = randomBytes(32).toString("base64url");
  const config = join(directory, "config.json");
  await writeFile(
    config,
    JSON.stringify({ secret, path: join(directory, "data.sqlite"), port: 0, host: "127.0.0.1" }),
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined;
  async function start() {
    child = fork(
      new URL("../packages/start/database/server.mjs", import.meta.url),
      ["--serve", config],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const [ready] = await once(child, "message");
    return "http://127.0.0.1:" + ready.port;
  }
  async function stop() {
    if (!child) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    child = undefined;
  }
  try {
    let origin = await start();
    const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
    const query = async (sql: string, args: (string | number | null)[] = []) => {
      const r = await fetch(origin + "/query", {
        method: "POST",
        headers,
        body: JSON.stringify({ query: sql, args }),
      });
      const result = (await r.json()) as any;
      assert.equal(r.status, 200, result.error);
      return result.rows;
    };
    assert.equal((await fetch(origin + "/health")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/query", {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
          body: "{}",
        })
      ).status,
      401,
    );
    await query("CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT UNIQUE)");
    const value = "quote ' and $1 are data 📬 café こんにちは";
    await query("INSERT INTO example(id,value) VALUES($1,$2)", [1, value]);
    assert.equal(
      (await query("SELECT value FROM example WHERE id=$1 OR id=$1", [1]))[0].value,
      value,
    );
    const duplicate = await fetch(origin + "/query", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "INSERT INTO example(id,value) VALUES($1,$2)",
        args: [1, "duplicate"],
      }),
    });
    assert.equal(duplicate.status, 500);
    assert.ok(!JSON.stringify(await duplicate.json()).includes(secret));
    await stop();
    origin = await start();
    assert.equal((await query("SELECT value FROM example"))[0].value, value);
    assert.equal((await query("PRAGMA synchronous"))[0].synchronous, 2);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
