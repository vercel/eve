import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import bundle from "../packages/start/src/mobile-assets.ts";
import { hostedExpoGoUrl, mobileManifest } from "../packages/start/src/mobile.ts";
import { startWeb } from "../packages/start/src/web.ts";
import { appStorage } from "../packages/start/src/computer.ts";
import { isPairLink, parsePair } from "../apps/mobile/pairing.ts";

test("hosted Expo Go links load the deployment manifest and deliver the pairing route", () => {
  const secure = hostedExpoGoUrl("https://agent.example");
  assert.equal(String(secure), "exps://agent.example/start/mobile/--/pair");
  assert.equal(
    String(hostedExpoGoUrl("http://192.168.1.10:2000")),
    "exp://192.168.1.10:2000/start/mobile/--/pair",
  );
  secure.searchParams.set("app", "https://agent.example");
  secure.searchParams.set("token", "t".repeat(43));
  assert.equal(isPairLink(String(secure)), true);
  assert.equal(parsePair(String(secure), { relay: "" }).relay, "https://agent.example");
  assert.equal(isPairLink("exps://agent.example/start/mobile"), false);
});

test(
  "the deployment serves an Expo Go manifest whose launch bundle and assets match their hashes",
  { skip: bundle ? false : "Run pnpm build:mobile to embed the Expo export." },
  async () => {
    const saved = { ...process.env };
    try {
      delete process.env.VERCEL;
      process.env.EVE_START_AGENT_TOKEN = randomBytes(32).toString("base64url");
      process.env.EVE_APP_PASSWORD = "mobile-password";
      process.env.EVE_START_COMPUTER_DB_PATH = ":memory:";
      process.env.EVE_START_APP_URL = "https://agent.example";
      const web = startWeb(async () => {}, undefined, { startBrowserOnLogin: false });
      assert.equal((await web.request("/mobile")).status, 400);
      for (const platform of ["ios", "android"] as const) {
        const response = await web.request("/mobile", { headers: { "expo-platform": platform } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/expo+json");
        assert.equal(response.headers.get("expo-protocol-version"), "0");
        const manifest = (await response.json()) as ReturnType<typeof mobileManifest>;
        assert.deepEqual(manifest, mobileManifest(bundle!, platform, "https://agent.example"));
        assert.match(manifest.runtimeVersion, /^exposdk:\d+\.\d+\.\d+$/);
        assert.equal(manifest.extra.expoClient.sdkVersion, bundle!.sdkVersion);
        assert.ok(manifest.assets.length > 0);
        for (const asset of [manifest.launchAsset, ...manifest.assets]) {
          const url = new URL(asset.url);
          assert.equal(url.origin, "https://agent.example");
          const file = await web.request(url.pathname.slice("/start".length));
          assert.equal(file.status, 200);
          assert.equal(file.headers.get("content-type"), asset.contentType);
          const body = Buffer.from(await file.arrayBuffer());
          assert.equal(createHash("sha256").update(body).digest("base64url"), asset.hash);
        }
      }
      assert.equal((await web.request("/mobile/files/" + "a".repeat(64))).status, 404);
      assert.deepEqual(await (await web.request("/v1/web/config")).json(), {
        standalone: true,
        mobileBundle: true,
      });
      // The dashboard QR defaults to this deployment's hosted Expo Go app.
      const login = await web.request("/v1/web/login", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "mobile-password" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const invite = (await (
        await web.request("/v1/web/pairing", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "http://localhost" },
        })
      ).json()) as { link: string; expoGo: boolean };
      assert.equal(invite.expoGo, true);
      const link = new URL(invite.link);
      assert.equal(
        link.protocol + "//" + link.host + link.pathname,
        "exps://agent.example/start/mobile/--/pair",
      );
      assert.equal(parsePair(invite.link, { relay: "" }).relay, "https://agent.example");
      // On localhost the dashboard explains the limitation instead of issuing an unreachable QR.
      delete process.env.EVE_START_APP_URL;
      const local = await web.request("http://localhost/v1/web/pairing", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://localhost" },
      });
      assert.equal(local.status, 409);
      assert.match(
        ((await local.json()) as { error: string }).error,
        /Phones cannot reach localhost/,
      );
    } finally {
      await (await appStorage()).db.close();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
);
