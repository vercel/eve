import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startWeb } from "../packages/start/src/web.ts";
import { appStorage, computer, computerRequest } from "../packages/start/src/computer.ts";
import { parsePair, redeemPair } from "../apps/mobile/pairing.ts";
import mobileBundle from "../packages/start/src/mobile-assets.ts";

test("standalone web login, direct device pairing, shared chat and push never contact a relay", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const outbound: string[] = [];
  let db: Awaited<ReturnType<typeof appStorage>>["db"] | undefined;
  try {
    delete process.env.VERCEL;
    delete process.env.DATABASE_URL;
    delete process.env.EVE_START_DATABASE_URL;
    delete process.env.EVE_START_COMPUTER_DATABASE_URL;
    delete process.env.EVE_START_AGENT_ID;
    process.env.EVE_START_AGENT_TOKEN = randomBytes(32).toString("base64url");
    process.env.EVE_APP_PASSWORD = "standalone-password";
    process.env.EVE_START_COMPUTER_DB_PATH = ":memory:";
    process.env.EVE_START_RELAY_URL = "https://relay-must-not-be-used.invalid";
    process.env.EVE_START_APP_URL = "https://agent.example";
    process.env.EVE_START_APP_BYPASS_TOKEN = "app_bypass_token_123456789";
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      outbound.push(url);
      assert.equal(url, "https://exp.host/--/api/v2/push/send");
      const messages = JSON.parse(String(init?.body));
      assert.equal(messages[0].to, "ExpoPushToken[standalone_test]");
      return Response.json({ data: [{ status: "ok" }] });
    }) as typeof fetch;
    const web = startWeb(async () => {}, undefined, { startBrowserOnLogin: false });
    assert.equal(
      (
        await web.request("/v1/web/pairing", {
          method: "POST",
          headers: { Origin: "http://localhost" },
        })
      ).status,
      401,
    );
    const login = await web.request("/v1/web/login", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "standalone-password" }),
    });
    assert.equal(login.status, 200);
    db = (await appStorage()).db;
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const auth = { Cookie: cookie, Origin: "http://localhost", "Content-Type": "application/json" };
    const pairing = await web.request("/v1/web/pairing", { method: "POST", headers: auth });
    assert.equal(pairing.status, 200);
    const defaultInvite = (await pairing.json()) as any;
    // Without an embedded Expo export, the default link targets an installed native build.
    assert.equal(new URL(defaultInvite.link).protocol, mobileBundle ? "exps:" : "eve-go:");
    assert.equal(defaultInvite.expoGo, Boolean(mobileBundle));
    const [{ count: beforeInvalid }] = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM pairs",
    );
    const invalid = await web.request("/v1/web/pairing", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ expoGoUrl: "https://not-a-metro-url.example" }),
    });
    assert.equal(invalid.status, 400);
    const [{ count: afterInvalid }] = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM pairs",
    );
    assert.equal(afterInvalid, beforeInvalid);
    const expoPairing = await web.request("/v1/web/pairing", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ expoGoUrl: "exp://192.168.1.10:8081" }),
    });
    assert.equal(expoPairing.status, 200);
    const invite = (await expoPairing.json()) as any;
    assert.equal(invite.standalone, true);
    assert.equal(invite.expoGo, true);
    assert.equal(new URL(invite.link).hostname, "192.168.1.10");
    assert.equal(new URL(invite.link).pathname, "/--/pair");
    assert.match(invite.qr, /^data:image\/png;base64,/);
    const candidate = parsePair(invite.link, { relay: "" });
    assert.equal(candidate.relay, "https://agent.example");
    assert.equal(candidate.bypassToken, process.env.EVE_START_APP_BYPASS_TOKEN);
    assert.equal(candidate.token.length, 43);
    const app = await computer("https://agent.example");
    let requests = 0;
    const device = await redeemPair(candidate, async (pair) => {
      requests++;
      const response = await app.request("/v1/pair", {
        method: "POST",
        body: JSON.stringify({ pairingToken: pair.token }),
      });
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal(requests, 1);
    assert.equal(
      (
        await app.request("/v1/pair", {
          method: "POST",
          body: JSON.stringify({ pairingToken: candidate.token }),
        })
      ).status,
      410,
    );
    const headers = {
      Authorization: "Bearer " + device.deviceToken,
      "Content-Type": "application/json",
    };
    assert.equal((await app.request("/v1/mobile/state")).status, 401);
    assert.equal(
      (
        await app.request("/v1/mobile/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: crypto.randomUUID(), text: "Hello from Expo" }),
        })
      ).status,
      201,
    );
    const state = (await (await web.request("/v1/web/state", { headers: auth })).json()) as any;
    assert.ok(state.messages.some((m: any) => m.text === "Hello from Expo"));
    await app.request("/v1/mobile/push", {
      method: "PUT",
      headers,
      body: JSON.stringify({ pushToken: "ExpoPushToken[standalone_test]" }),
    });
    await computerRequest("agent/notify", {
      text: "Background check complete",
      dedupeKey: "standalone-test",
    });
    await computerRequest("agent/notifications/flush", {});
    assert.deepEqual(outbound, ["https://exp.host/--/api/v2/push/send"]);
    const storage = await appStorage();
    db = storage.db;
    assert.equal(device.agentId, storage.identity.agentId);
    assert.match(device.agentId, /^app-/);
    const [alert] = await db.query<{ state: string }>("SELECT state FROM alerts");
    assert.equal(alert.state, "submitted");
    assert.deepEqual(await (await web.request("/v1/web/config")).json(), {
      standalone: true,
      mobileBundle: Boolean(mobileBundle),
    });
    assert.equal((await web.request("/v1/web/expo.svg", { headers: auth })).status, 404);
    // Expired tickets cannot create devices either.
    const expired = (await (
      await web.request("/v1/web/pairing", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ expoGoUrl: "exp://192.168.1.10:8081" }),
      })
    ).json()) as any;
    await db.query("UPDATE pairs SET expires=0");
    const expiredPair = parsePair(expired.link, { relay: "" });
    assert.equal(
      (
        await app.request("/v1/pair", {
          method: "POST",
          body: JSON.stringify({ pairingToken: expiredPair.token }),
        })
      ).status,
      410,
    );
  } finally {
    await db?.close();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
