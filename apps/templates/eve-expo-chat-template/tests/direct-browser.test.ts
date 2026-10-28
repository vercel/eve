import { test } from "node:test";
import assert from "node:assert/strict";
import { database } from "../packages/start/server/db.ts";
import { createApp } from "./app-fixture.ts";
import type { ComputerOptions } from "../packages/start/server/browser/routes.ts";
type Desktop = NonNullable<ComputerOptions["desktop"]>;

const admin = "test-admin-secret-long-enough";
async function fixture(desktop?: Desktop) {
  process.env.EVE_DB_PATH = ":memory:";
  const db = await database();
  const app = createApp(db, admin, fetch, { desktop });
  const request = (path: string, token: string, body?: unknown) =>
    app.request("/v1/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const agent = (await (await request("admin/agents", admin, { name: "Browser" })).json()) as {
    agentToken: string;
  };
  const execute = (args: string[]) =>
    request("agent/browser/execute", agent.agentToken, { type: "agent-browser", args });
  return { db, execute };
}
const browser = (overrides: Partial<Desktop> = {}): Desktop => ({
  ready: async () => {},
  healthy: async () => true,
  start: () => {},
  status: async () => ({ state: "ready" }),
  link: async () => ({}),
  stream: async () => ({}),
  stop: async () => ({}),
  execute: async () => ({ result: null }),
  ...overrides,
});

test("agent browser commands wake the cloud browser first, run once, and stay auditable", async () => {
  const events: string[] = [];
  const f = await fixture(
    browser({
      ready: async () => {
        events.push("ready");
      },
      execute: async (_id, command) => {
        events.push("execute:" + command.args[0]);
        return { result: [{ id: 4, title: "Example" }] };
      },
    }),
  );
  try {
    const response = await f.execute(["tab", "--json"]);
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { result: unknown }).result, [
      { id: 4, title: "Example" },
    ]);
    assert.deepEqual(events, ["ready", "execute:tab"]);
    const [job] = await f.db.query<{ state: string; result: string }>(
      "SELECT state,result FROM jobs",
    );
    assert.equal(job.state, "done");
    assert.deepEqual(JSON.parse(job.result), [{ id: 4, title: "Example" }]);
  } finally {
    await f.db.close();
  }
});

test("an interrupted command is reported as uncertain and never retried", async () => {
  let calls = 0;
  const f = await fixture(
    browser({
      execute: async () => {
        calls++;
        throw Error("connection interrupted after the click");
      },
    }),
  );
  try {
    const response = await f.execute(["click", "@e3"]);
    assert.equal(response.status, 502);
    const body = (await response.json()) as { outcomeMayBeUnknown: boolean };
    assert.equal(body.outcomeMayBeUnknown, true);
    assert.equal(calls, 1);
    const [job] = await f.db.query<{ state: string; error: string }>(
      "SELECT state,error FROM jobs",
    );
    assert.equal(job.state, "done");
    assert.match(job.error, /interrupted/);
  } finally {
    await f.db.close();
  }
});

test("a browser that cannot start, or is not configured, never receives the action", async () => {
  let calls = 0;
  const failing = await fixture(
    browser({
      ready: async () => {
        throw Error("Sandbox quota reached");
      },
      execute: async () => {
        calls++;
        return { result: null };
      },
    }),
  );
  const missing = await fixture(undefined);
  try {
    const failed = await failing.execute(["open", "https://example.com"]);
    assert.equal(failed.status, 503);
    assert.match(((await failed.json()) as { error: string }).error, /could not start.*quota/);
    const unconfigured = await missing.execute(["open", "https://example.com"]);
    assert.equal(unconfigured.status, 503);
    assert.match(((await unconfigured.json()) as { error: string }).error, /setup\.sh/);
    assert.equal(calls, 0);
    assert.equal((await failing.db.query("SELECT id FROM jobs")).length, 0);
  } finally {
    await failing.db.close();
    await missing.db.close();
  }
});
