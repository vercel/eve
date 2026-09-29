import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev, waitForPath, withinDeadline } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SIGNING_SECRET = "observation-scenario-signing-secret";

describe("Slack run observation worker crash", () => {
  it("recovers one accepted create after the provider worker exits before journaling", async () => {
    const app = await scenarioApp({
      name: "run-observation-crash",
      installDependencies: true,
      files: {
        "agent/instructions.md": "Reply to Alice with a short greeting.\n",
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(() => "Hello Alice."),
  modelContextWindowTokens: 32000,
});`,
        "agent/channels/slack.ts": `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { slackChannel } from "eve/channels/slack";

const acceptedPath = join(process.cwd(), ".accepted-slack-create.json");
const updatedPath = join(process.cwd(), ".updated-slack-create");
const recoveryWorkerPath = join(process.cwd(), ".recovery-worker");
const callsPath = join(process.cwd(), ".slack-calls");
const workerIdentity = process.pid + ":" + threadId;

export default slackChannel({
  credentials: { botToken: "xoxb-fake", signingSecret: "${SIGNING_SECRET}" },
  experimental: { runObservation: true },
  api: {
    fetch: async (request, init) => {
      const method = String(request).split("/").at(-1);
      appendFileSync(callsPath, method + "\\n");
      if (method === "chat.postMessage") {
        if (existsSync(acceptedPath)) throw new Error("A second create was attempted.");
        const body = new URLSearchParams(String(init?.body ?? ""));
        const metadata = JSON.parse(body.get("metadata") ?? "null");
        writeFileSync(acceptedPath, JSON.stringify({ metadata, text: body.get("text"), workerIdentity }));
        process.exit(1);
      }
      if (method === "conversations.replies") {
        const accepted = JSON.parse(readFileSync(acceptedPath, "utf8"));
        writeFileSync(recoveryWorkerPath, workerIdentity);
        return Response.json({ ok: true, messages: [{ ts: "123.456", text: "stale", metadata: accepted.metadata }] });
      }
      if (method === "chat.update") {
        writeFileSync(updatedPath, "updated");
        return Response.json({ ok: true, ts: "123.456" });
      }
      if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT", team_id: "T1" });
      return Response.json({ ok: true });
    },
  },
});`,
      },
    });
    const server = await startEveDev(app.appRoot, { defaultExtensions: false });
    try {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev-observation-crash",
        event: {
          type: "app_mention",
          user: "U1",
          text: "Hello from Alice",
          channel: "C1",
          ts: "1700000001.000001",
          thread_ts: "1700000000.000001",
          event_ts: "1700000001.000001",
        },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      const response = await fetch(new URL("/eve/v1/slack", server.url), {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": signature,
        },
      });
      expect(response.status).toBe(200);
      try {
        await withinDeadline(
          waitForPath(join(app.appRoot, ".updated-slack-create")),
          "The restarted worker did not recover the accepted Slack create.",
        );
      } catch (error) {
        const calls = await readFile(join(app.appRoot, ".slack-calls"), "utf8").catch(
          () => "<no fake Slack calls>",
        );
        throw new Error(
          `${String(error)}\nFake Slack calls:\n${calls}\nstdout:\n${server.stdout()}\nstderr:\n${server.stderr()}`,
        );
      }
      const methods = (await readFile(join(app.appRoot, ".slack-calls"), "utf8"))
        .trim()
        .split("\n");
      expect(methods.filter((method) => method === "chat.postMessage")).toHaveLength(1);
      expect(methods).toContain("conversations.replies");
      expect(methods).toContain("chat.update");
      const accepted = JSON.parse(
        await readFile(join(app.appRoot, ".accepted-slack-create.json"), "utf8"),
      ) as { workerIdentity: string };
      expect(await readFile(join(app.appRoot, ".recovery-worker"), "utf8")).not.toBe(
        accepted.workerIdentity,
      );
    } finally {
      await server.stop();
    }
  }, 360_000);
});
