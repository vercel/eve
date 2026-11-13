import assert from "node:assert/strict";
import Browserbase from "@browserbasehq/sdk";
import { Client } from "eve/client";

// Opt-in: requires a running local Bell and uses the configured model/browser.
if (process.env.BELL_LIVE_RETIREMENT !== "1" || !process.env.BROWSERBASE_API_KEY)
  throw new Error("Set BELL_LIVE_RETIREMENT=1 and BROWSERBASE_API_KEY for this live test.");
const origin = new URL(process.env.BELL_TEST_ORIGIN || "http://127.0.0.1:4320");
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname))
  throw new Error("This test accepts only a local Bell origin.");
const client = new Client({ host: origin.origin });
const browserbase = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
let session;
const browserIds = new Set();
const contextIds = new Set();
const remember = (events) => {
  for (const event of events) {
    const browser = event.data?.result?.output?.workbench?.browser;
    if (browser?.sessionId) browserIds.add(browser.sessionId);
    if (browser?.contextId) contextIds.add(browser.contextId);
  }
};

try {
  const created = await client.sessions.create({
    message: "Bounded integration test: use run to visit https://example.com/, then snapshot. Reply with the page title. Do not visit other sites, use saved Contexts or vaults, or send messages.",
    signal: AbortSignal.timeout(90_000),
  });
  session = created.session;
  const first = await created.response.result();
  remember(first.events);
  assert.equal(first.status, "waiting");
  assert.ok(first.message?.includes("Example Domain"));
  assert.equal(browserIds.size, 1);
  const second = await (await session.send(
    "Without navigating, use snapshot to confirm the current page title and URL. Reply briefly.",
    { signal: AbortSignal.timeout(45_000) },
  )).result();
  remember(second.events);
  assert.equal(second.status, "waiting");
  assert.equal(browserIds.size, 1, "Follow-up must reuse the same hosted browser");
  const reset = await session.reset({ reason: "Completed browser retirement regression" });
  assert.equal(reset.status, "reset");
  const completionDeadline = Date.now() + 20_000;
  let completed = false;
  do {
    const snapshot = await session.snapshot();
    completed = snapshot.events.some((event) => event.type === "session.completed");
    if (completed) break;
    assert.ok(!snapshot.events.some((event) => event.type === "session.failed"), "Session failed during retirement");
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < completionDeadline);
  assert.ok(completed, "Reset must publish session.completed");
  for (const id of browserIds) {
    const deadline = Date.now() + 20_000;
    let status;
    do {
      status = (await browserbase.sessions.retrieve(id)).status;
      if (status === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.equal(status, "COMPLETED", "Reset must release the hosted browser");
  }
  console.log("Live retirement passed: two turns shared one browser; reset emitted completion and Browserbase confirmed COMPLETED.");
} finally {
  const cleanupErrors = [];
  if (session) {
    // Recover IDs even if a model assertion fails. Do not print private events.
    try { remember((await session.snapshot()).events); } catch { /* Session may not have started. */ }
    try { await session.reset({ reason: "Integration test cleanup" }); }
    catch { cleanupErrors.push("Eve session reset failed"); }
  }
  for (const id of browserIds) {
    try {
      if ((await browserbase.sessions.retrieve(id)).status !== "COMPLETED")
        await browserbase.sessions.update(id, { status: "REQUEST_RELEASE" });
    } catch { cleanupErrors.push("Browser release failed"); }
  }
  for (const id of contextIds) {
    try { await browserbase.contexts.delete(id, { headers: { "Content-Type": null } }); }
    catch { cleanupErrors.push("Temporary Context deletion failed"); }
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
}
