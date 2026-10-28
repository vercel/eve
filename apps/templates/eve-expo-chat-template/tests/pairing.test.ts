import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePair, redeemPair, isPairLink, editPairCode } from "../apps/mobile/pairing.ts";
import { expoGoPairingUrl } from "../packages/start/src/expo-go.ts";

test("mobile pairing preserves ticket bytes and only uses the explicit app origin and bypass", () => {
  const ticket = "AbCd_efGH-".repeat(4);
  const link = new URL("eve-go://pair");
  link.searchParams.set("app", "https://agent.example");
  link.searchParams.set("token", ticket);
  link.searchParams.set("bypass", "app_bypass_token_123456789");
  assert.deepEqual(parsePair(String(link), { relay: "" }), {
    relay: "https://agent.example",
    token: ticket,
    bypassToken: "app_bypass_token_123456789",
  });
  for (const origin of [
    "http://public.example",
    "https://user:pass@agent.example",
    "https://agent.example/path",
  ]) {
    link.searchParams.set("app", origin);
    assert.throws(() => parsePair(String(link), { relay: "" }));
  }
  assert.throws(() => parsePair("ABCD-EFGH", { relay: "" }), /complete pairing link/);
});

test("Expo Go launch links retain the app ticket and distinguish pairing routes from ordinary launches", () => {
  for (const server of ["exp://192.168.1.10:8081", "exps://my-metro.example/"]) {
    const launch = expoGoPairingUrl(server);
    launch.searchParams.set("app", "https://agent.example");
    launch.searchParams.set("token", "AbCd_efGH-".repeat(4));
    launch.searchParams.set("bypass", "app_bypass_token_123456789");
    const link = String(launch);
    assert.equal(launch.pathname, "/--/pair");
    assert.equal(isPairLink(link), true);
    assert.deepEqual(parsePair(link, { relay: "" }), {
      relay: "https://agent.example",
      token: "AbCd_efGH-".repeat(4),
      bypassToken: "app_bypass_token_123456789",
    });
    assert.equal(editPairCode("", link).text, link);
    assert.equal(isPairLink(server), false);
  }
  assert.equal(isPairLink("exp://192.168.1.10:8081/--/other"), false);
  assert.equal(isPairLink("https://agent.example/--/pair"), false);
  for (const invalid of [
    "https://metro.example",
    "exp://user:password@metro.example",
    "exp://metro.example/--/pair",
    "exp://metro.example?token=secret",
    "exp://metro.example#secret",
    "not a URL",
  ])
    assert.throws(() => expoGoPairingUrl(invalid), /Metro|server address/);
});

test("mobile redeems directly once and rejects malformed device credentials", async () => {
  const candidate = { relay: "https://agent.example", token: "t".repeat(43) };
  const device = { agentId: "agent", name: "Agent", deviceToken: "d".repeat(43) };
  let calls = 0;
  const paired = await redeemPair(candidate, async (received) => {
    calls++;
    assert.deepEqual(received, candidate);
    return device;
  });
  assert.equal(calls, 1);
  assert.equal(paired.relay, candidate.relay);
  assert.equal(paired.deviceToken, device.deviceToken);
  await assert.rejects(
    redeemPair(candidate, async () => ({ ...device, deviceToken: "" })),
    /Invalid pairing/,
  );
});
