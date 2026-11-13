import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Browserbase from "@browserbasehq/sdk";
import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright-core";

const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
if (!apiKey) throw new Error("Set BROWSERBASE_API_KEY to a test project's key.");
delete process.env.DEBUG;
const sdk = new Browserbase({ apiKey, maxRetries: 0, timeout: 20_000 });
const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim() || undefined;
const runId = randomUUID(), results = [], cleanupErrors = [];
const directory = await mkdtemp(join(tmpdir(), "bell-extension-repro-"));
const browserSettings = { recordSession: false, logSession: false, verified: true };
const userMetadata = { purpose: "bell-extension-repro", runId };
let extension;
const sanitized = error => String(error?.message ?? "Unknown failure").replaceAll(apiKey, "[redacted]").replace(/https?:\/\/\S+/g, "[url]");
async function check(name, operation) {
  try { await operation(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: sanitized(error) }); }
}
async function stagehandCheck(extensionId) {
  let browser, stagehand;
  try {
    browser = await browserbase.launch({ apiKey, projectId, ...(extensionId ? { extensionId } : {}), timeout: 60, keepAlive: false, browserSettings, userMetadata });
    stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
    const page = await browser.context.newPage();
    await page.goto("data:text/html,<title>Extension repro</title>");
    if (await page.title() !== "Extension repro") throw new Error("Stagehand page operation failed.");
  } finally {
    try { await stagehand?.close(); } finally { await browser?.close(); }
  }
}
try {
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Bell extension repro", version: "1.0", background: { service_worker: "worker.js" } }));
  await writeFile(join(directory, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  execFileSync("zip", ["-q", "extension.zip", "manifest.json", "worker.js"], { cwd: directory, stdio: "pipe" });
  extension = await sdk.extensions.create({ file: createReadStream(join(directory, "extension.zip")) });
  await check("stagehand_only", () => stagehandCheck());
  await check("custom_extension_only", async () => {
    const session = await sdk.sessions.create({ projectId, extensionId: extension.id, api_timeout: 60, browserSettings, userMetadata });
    let browser;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15_000 });
      const context = browser.contexts()[0];
      const deadline = Date.now() + 15_000;
      while (true) {
        const names = await Promise.all(context.serviceWorkers().map(worker => worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => "")));
        if (names.includes("Bell extension repro")) break;
        if (Date.now() >= deadline) throw new Error("Custom extension did not load.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      try { await browser?.close(); } finally { await sdk.sessions.update(session.id, { projectId, status: "REQUEST_RELEASE" }); }
    }
  });
  await check("stagehand_with_custom_extension", () => stagehandCheck(extension.id));
} catch (error) {
  results.push({ name: "setup", passed: false, error: sanitized(error) });
} finally {
  try {
    const sessions = await sdk.sessions.list();
    for (const session of sessions.filter(session => session.userMetadata?.runId === runId && ["PENDING", "RUNNING"].includes(session.status))) {
      try { await sdk.sessions.update(session.id, { projectId, status: "REQUEST_RELEASE" }); }
      catch { cleanupErrors.push("session_release_failed"); }
    }
  } catch { cleanupErrors.push("session_cleanup_check_failed"); }
  if (extension) {
    try { await sdk.extensions.delete(extension.id, { headers: { "Content-Type": null } }); }
    catch { cleanupErrors.push("extension_delete_failed"); }
  }
  await rm(directory, { recursive: true, force: true });
}
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
console.log(JSON.stringify({ stagehandDependency: manifest.dependencies["@browserbasehq/stagehand"], runId, results, cleanupErrors }, null, 2));
if (results.some(result => !result.passed) || cleanupErrors.length) process.exitCode = 1;
