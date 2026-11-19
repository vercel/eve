import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { passwordEveAuth } from "./eve-auth.ts";
import { createPasswordSessionToken, PASSWORD_SESSION_COOKIE_NAME } from "./password-auth.ts";

const APP = "https://computer-use.example.com";

beforeEach(() => {
  process.env.EVE_COMPUTER_USE_PASSWORD = "correct-horse-battery-1";
  delete process.env.VERCEL_ENV;
});

function eveRequest(method: string, origin?: string): Request {
  const headers = new Headers({
    cookie: `${PASSWORD_SESSION_COOKIE_NAME}=${encodeURIComponent(createPasswordSessionToken())}`,
    host: new URL(APP).host,
    "content-type": "text/plain",
  });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request(`${APP}/eve/v1/session`, {
    method,
    headers,
    body: method === "GET" ? undefined : '{"message":"hi"}',
  });
}

const authenticated = async (request: Request) => (await passwordEveAuth(request)) !== null;

test("a same-site sibling origin can't start a session with a valid password cookie", async () => {
  assert.equal(await authenticated(eveRequest("POST", "https://sibling.example.com")), false);
  assert.equal(
    await authenticated(eveRequest("POST", "http://computer-use.example.com:8080")),
    false,
  );
});

test("a state-changing request without an Origin is refused", async () => {
  assert.equal(await authenticated(eveRequest("POST")), false);
});

test("the app's own pages are accepted, including a same-origin read without an Origin", async () => {
  assert.equal(await authenticated(eveRequest("POST", APP)), true);
  assert.equal(await authenticated(eveRequest("GET")), true);
});

test("without password mode, the cookie authenticates nothing", async () => {
  process.env.EVE_COMPUTER_USE_PASSWORD = "short";
  assert.equal(await authenticated(eveRequest("POST", APP)), false);
});
