import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { Client } from "eve/client";
import { restrictBrowserRequests } from "./browser-test-auth.ts";

if (process.env.BELL_LIVE_PARALLEL !== "1" || !process.env.BROWSERBASE_API_KEY)
  throw new Error("Set BELL_LIVE_PARALLEL=1 and BROWSERBASE_API_KEY for this live test.");
const origin = new URL(process.env.BELL_TEST_ORIGIN || "http://127.0.0.1:4320");
const local = origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname);
assert.ok(!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Use a bare test origin without credentials.");
assert.ok(local || (origin.protocol === "https:" && origin.origin === process.env.BELL_TEST_STAGING_ORIGIN), "Remote tests require an exact HTTPS BELL_TEST_STAGING_ORIGIN.");
const username = process.env.BELL_OPERATOR_USERNAME, password = process.env.BELL_OPERATOR_PASSWORD;
const requireAuth = !local || process.env.BELL_TEST_REQUIRE_AUTH === "1";
assert.ok(!requireAuth || (username && !username.includes(":") && password && Buffer.byteLength(password) >= 32), "Authenticated tests require valid BELL_OPERATOR_USERNAME and BELL_OPERATOR_PASSWORD.");
const protection = process.env.BELL_TEST_PROTECTION_BYPASS ? { "x-vercel-protection-bypass": process.env.BELL_TEST_PROTECTION_BYPASS } : {};
const headers = { ...protection, ...(username && password ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } : {}) };
const secrets = Object.entries({ ...process.env, BELL_TEST_AUTHORIZATION: headers.authorization })
  .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD|BYPASS|AUTHORIZATION)$/.test(key) && value);
function assertNoSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const [key, secret] of secrets) assert.ok(!text.includes(secret), `${key} must not appear in conversation data or rendered HTML.`);
}
const client = new Client({ host: origin.origin, headers, redirect: "error" });
const browserbase = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 10_000, maxRetries: 0 });
const directory = path.resolve(process.env.BELL_TEST_ARTIFACT_DIR || ".bell/parallel-e2e", randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROME_PATH ? { executablePath: process.env.TEST_CHROME_PATH } : { channel: "chrome" }) });
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
async function until(check, message) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) { assert.ok(Date.now() < deadline, message); await pause(); }
}
async function verifyAuth(sessionId) {
  if (!requireAuth) return;
  const url = `${origin.origin}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`;
  for (const authorization of [undefined, "Basic invalid"]) {
    const response = await fetch(url, { headers: { ...protection, ...(authorization ? { authorization } : {}) }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    assert.equal(response.status, 401, "Unauthenticated and invalid-auth session reads must be rejected.");
  }
  const csrf = await fetch(`${origin.origin}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST", headers: { ...headers, origin: "https://untrusted.invalid", "content-type": "application/json" },
    body: "{}", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  await csrf.body?.cancel();
  assert.equal(csrf.status, 403, "Authenticated cross-origin writes must be rejected.");
}
async function workflow(index) {
  const hostedIds = new Set(), contextIds = new Set(), marker = `research-${randomUUID()}`;
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const pageErrors = [];
  let streamRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/stream")) streamRequests++; });
  if (index === 1) await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.streamInterrupted = false;
    window.interruptStream = false;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (!new URL(response.url).pathname.endsWith("/stream") || !response.body) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) return controller.close();
            if (window.interruptStream && !window.streamInterrupted) {
              window.streamInterrupted = true;
              await reader.cancel();
              return controller.error(new TypeError("Failed to fetch"));
            }
            controller.enqueue(chunk.value);
          } catch (error) { controller.error(error); }
        },
        cancel: reason => reader.cancel(reason),
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
  page.on("pageerror", () => pageErrors.push("Browser JavaScript error"));
  await restrictBrowserRequests(context, page, origin.origin, headers, () => pageErrors.push("Browser request interception failed"));
  let session, stage = "session creation";
  const remember = events => {
    for (const event of events) {
      const state = event.data?.result?.output?.workbench?.browser;
      if (state?.sessionId) hostedIds.add(state.sessionId);
      if (state?.contextId && state.contextStatus === "draft") contextIds.add(state.contextId);
    }
  };
  try {
    ({ session } = await client.sessions.create({ signal: AbortSignal.timeout(30_000) }));
    stage = "authentication checks";
    await verifyAuth(session.state.sessionId);
    stage = "UI submission";
    await page.goto(`${origin.origin}/s/${encodeURIComponent(session.state.sessionId)}`);
    await page.getByRole("status").filter({ hasText: /^Ready$/ }).waitFor();
    await page.getByLabel("Message Bell", { exact: true }).fill(`Bounded public research test: use web_search to find official sources about the reserved example.com domain. Use web_fetch to read https://example.com/. Then use run to open https://example.com/ and snapshot to verify its title. Reply with a short summary citing at least one exact URL from each research tool (retain query strings), the observed browser title, and verification marker ${marker}. Use exactly one call to each tool. Do not browse other URLs, access credentials, select saved Contexts, or send messages.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (index === 1) await page.evaluate(() => { window.interruptStream = true; });
    stage = "agent response";
    await Promise.race([
      page.locator(".messages article.assistant").filter({ hasText: marker }).waitFor({ timeout: 180_000 }),
      page.locator(".conversation [role=alert]").waitFor({ timeout: 180_000 }).then(() => { throw new Error("Bell displayed a request error"); }),
    ]);
    await page.getByRole("status").filter({ hasText: /^Ready$/ }).waitFor({ timeout: 30_000 });
    const snapshot = await session.snapshot({ signal: AbortSignal.timeout(10_000) });
    remember(snapshot.events);
    assertNoSecrets(snapshot);
    assertNoSecrets(await page.content());
    const calls = snapshot.events.filter(event => event.type === "action.result").map(event => event.data?.result);
    assert.equal(calls.length, 4, "Only the four requested tools may run.");
    for (const name of ["web_search", "web_fetch", "run", "snapshot"]) {
      const matching = calls.filter(call => call?.toolName === name);
      assert.equal(matching.length, 1, `${name} must run exactly once`);
      assert.ok(!matching[0].isError, `${name} must succeed`);
    }
    const answer = await page.locator(".messages article.assistant").last().innerText();
    for (const name of ["web_search", "web_fetch"]) {
      const output = calls.find(call => call.toolName === name).output;
      assert.ok(output.results?.some(source => source.excerpts?.some(Boolean)), `${name} must return evidence`);
      assert.equal(output.errors?.length, 0, `${name} must not return source errors`);
      assert.ok(output.results.some(source => answer.includes(source.url)), `${name} must cite a returned URL verbatim: ${output.results.map(source => source.url).join(", ")}`);
    }
    const observed = calls.find(call => call.toolName === "snapshot").output;
    assert.equal(new URL(observed.result.url).hostname, "example.com");
    assert.equal(observed.workbench.browser.title, "Example Domain");
    assert.equal(observed.result.pageStatus, "live");
    assert.equal(observed.workbench.browser.contextStatus, "draft", "Use a disposable draft Context, never a saved Context.");
    assert.equal(hostedIds.size, 1, "Each conversation must use one hosted browser");
    assert.equal(contextIds.size, 1, "Each conversation must own one disposable Context");
    assert.ok(answer.includes("Example Domain") && answer.includes(marker));
    assert.equal(await page.locator(".conversation [role=alert]").count(), 0);
    assert.equal(pageErrors.length, 0);
    if (index === 1) {
      assert.equal(await page.evaluate(() => window.streamInterrupted), true, "An active response stream must be interrupted");
      assert.ok(streamRequests >= 2 && streamRequests <= 6, "Stream recovery must reconnect within a bounded request budget");
    }
    await page.screenshot({ path: path.join(directory, `conversation-${index}.png`), fullPage: true });
    stage = "automatic retirement";
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForURL(origin.origin + "/");
    await until(async () => {
      const events = (await session.snapshot({ signal: AbortSignal.timeout(10_000) })).events;
      remember(events);
      assert.ok(!events.some(event => event.type === "session.failed"), "Conversation retirement failed");
      return events.some(event => event.type === "session.completed");
    }, "New conversation must retire the previous Eve session");
    for (const id of hostedIds)
      await until(async () => (await browserbase.sessions.retrieve(id)).status === "COMPLETED", "New conversation must release its hosted browser without test intervention");
    return { hostedIds: [...hostedIds], contextIds: [...contextIds] };
  } catch (error) {
    await page.screenshot({ path: path.join(directory, `failure-${index}.png`), fullPage: true }).catch(() => {});
    const alert = await page.locator(".conversation [role=alert]").allTextContents();
    const events = session ? (await session.snapshot({ signal: AbortSignal.timeout(10_000) }).catch(() => ({ events: [] }))).events : [];
    remember(events);
    throw new Error(`${stage}: ${error.message}\nUI: ${alert.join("; ")}\nEvents: ${events.slice(-12).map(event => event.type).join(", ")}`);
  } finally {
    const failures = [];
    if (session) {
      try { remember((await session.snapshot({ signal: AbortSignal.timeout(10_000) })).events); } catch { failures.push("Could not recover final session events"); }
      try { await session.reset({ reason: "Parallel browser E2E cleanup", signal: AbortSignal.timeout(30_000) }); } catch { failures.push("Session reset failed"); }
    }
    for (const id of hostedIds) {
      try {
        if ((await browserbase.sessions.retrieve(id)).status !== "COMPLETED") await browserbase.sessions.update(id, { status: "REQUEST_RELEASE" });
        await until(async () => (await browserbase.sessions.retrieve(id)).status === "COMPLETED", "Hosted browser cleanup timed out");
      } catch { failures.push("Hosted browser cleanup failed"); }
    }
    if (!failures.length) for (const id of contextIds) {
      try {
        await browserbase.contexts.delete(id, { headers: { "Content-Type": null } });
        await assert.rejects(browserbase.contexts.retrieve(id), error => error instanceof Browserbase.APIError && error.status === 404);
      } catch { failures.push("Temporary Context deletion was not confirmed"); }
    }
    await context.close().catch(() => failures.push("Local browser context cleanup failed"));
    assert.equal(failures.length, 0, failures.join("; "));
  }
}
let passed = false, failures = [];
try {
  const results = await Promise.allSettled([workflow(1), workflow(2)]);
  failures = results.filter(result => result.status === "rejected").map(result => {
    let message = String(result.reason?.message || "Workflow failed");
    for (const [, value] of secrets) message = message.replaceAll(value, "[redacted]");
    return message.slice(0, 2_000);
  });
  assert.ok(results.every(result => result.status === "fulfilled"), "A conversation or its cleanup failed; inspect the local test report.");
  const runs = results.map(result => result.value);
  assert.equal(new Set(runs.flatMap(run => run.hostedIds)).size, 2, "Concurrent conversations must not share a hosted browser");
  assert.equal(new Set(runs.flatMap(run => run.contextIds)).size, 2, "Concurrent conversations must not share a Context");
  passed = true;
} finally {
  await browser.close();
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ testedAt: new Date().toISOString(), origin: origin.origin, passed, failures, authenticated: requireAuth, conversations: 2, scope: "Browser UI, interrupted response stream recovery, live Search and Extract, citations, hosted browser handoff, credential non-disclosure, automatic retirement, confirmed cleanup" }, null, 2), { mode: 0o600 });
  console.log(`Parallel browser E2E ${passed ? "passed" : "failed"}. Report: ${path.join(directory, "result.json")}`);
}
