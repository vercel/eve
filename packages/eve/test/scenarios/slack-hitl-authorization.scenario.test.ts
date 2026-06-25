import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SLACK_HITL_AUTHORIZATION_DESCRIPTOR } from "#internal/testing/scenario-apps/slack-hitl-authorization.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { stripAnsi } from "#cli/dev/tui/terminal-text.js";

const SIGNING_SECRET = "scenario-signing-secret";
const CHANNEL_ID = "C_SCENARIO";
const TEAM_ID = "T_SCENARIO";
const THREAD_TS = "1700000000.000001";
const USER_A = "U_OWNER_A";
const USER_B = "U_OWNER_B";

const hitlCardSchema = z.object({
  actionId: z.string(),
  blockId: z.string(),
  value: z.string(),
});
type HitlCard = z.infer<typeof hitlCardSchema>;

const slackCallSchema = z.object({
  api: z.string(),
  card: hitlCardSchema.optional(),
  user: z.string().nullable(),
});
type SlackCall = z.infer<typeof slackCallSchema>;

const scenarioApp = useScenarioApp();

describe("Slack HITL authorization contract", () => {
  it("binds each durable prompt to the current Slack-authenticated caller", async () => {
    const app = await scenarioApp(SLACK_HITL_AUTHORIZATION_DESCRIPTOR);
    const callsPath = join(app.appRoot, "slack-calls.jsonl");
    await writeFile(callsPath, "");
    const server = await startEveDev(app.appRoot, callsPath);

    try {
      expect((await postSlack(server.url, mention(USER_A, "owner-a", "000003"))).status).toBe(200);
      const firstCard = await waitFor("first HITL card", async () =>
        findCard(await readCalls(callsPath), 0),
      );
      const sessionRunIds = await waitFor("durable Slack session", async () => {
        const ids = await readSessionRunIds(app.appRoot);
        return ids.length === 1 ? ids : null;
      });

      let callIndex = (await readCalls(callsPath)).length;
      expect((await postSlack(server.url, interaction(firstCard, USER_A))).status).toBe(200);
      await waitFor("first completed reply", async () =>
        findCall(await readCalls(callsPath), callIndex, "chat.postMessage"),
      );

      callIndex = (await readCalls(callsPath)).length;
      expect((await postSlack(server.url, mention(USER_B, "owner-b", "000004"))).status).toBe(200);
      const secondCard = await waitFor("second HITL card", async () =>
        findCard(await readCalls(callsPath), callIndex),
      );
      expect(secondCard.blockId).not.toBe(firstCard.blockId);
      expect(await readSessionRunIds(app.appRoot)).toEqual(sessionRunIds);

      callIndex = (await readCalls(callsPath)).length;
      expect((await postSlack(server.url, interaction(secondCard, USER_A))).status).toBe(200);
      await waitFor("stale-user rejection", async () =>
        findCall(await readCalls(callsPath), callIndex, "chat.postEphemeral", USER_A),
      );
      expect(findCall(await readCalls(callsPath), callIndex, "chat.update")).toBeNull();

      callIndex = (await readCalls(callsPath)).length;
      expect((await postSlack(server.url, interaction(secondCard, USER_B))).status).toBe(200);
      await waitFor("second completed reply", async () =>
        findCall(await readCalls(callsPath), callIndex, "chat.postMessage"),
      );
    } finally {
      await server.stop();
    }
  }, 360_000);
});

async function startEveDev(appRoot: string, callsPath: string) {
  const preload = pathToFileURL(join(appRoot, "slack-fetch-preload.mjs")).href;
  const child = spawn(
    process.execPath,
    [join(appRoot, "node_modules", "eve", "bin", "eve.js"), "dev", "--no-ui", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        EVE_SLACK_CALLS_PATH: callsPath,
        NODE_ENV: "test",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" "),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));

  try {
    const url = await waitFor(
      "eve dev server URL",
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`eve dev exited before startup.\n${output}`);
        }
        return /server listening at (https?:\/\/\S+)/u.exec(stripAnsi(output))?.[1] ?? null;
      },
      120_000,
    );
    return { url, stop: () => stopProcess(child) };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  killTimer.unref();
  child.kill("SIGTERM");
  await exit;
  clearTimeout(killTimer);
}

async function postSlack(serverUrl: string, payload: Record<string, unknown>): Promise<Response> {
  const isInteraction = payload.type === "block_actions";
  const body = isInteraction
    ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    : JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return await fetch(new URL("/eve/v1/slack", serverUrl), {
    body,
    headers: {
      "content-type": isInteraction ? "application/x-www-form-urlencoded" : "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    method: "POST",
  });
}

function mention(user: string, note: string, suffix: string): Record<string, unknown> {
  const ts = `1700000000.${suffix}`;
  return {
    event: {
      channel: CHANNEL_ID,
      event_ts: ts,
      text: `Use guarded-echo exactly once with note "${note}".`,
      thread_ts: THREAD_TS,
      ts,
      type: "app_mention",
      user,
    },
    event_id: `Ev_${note}`,
    team_id: TEAM_ID,
    type: "event_callback",
  };
}

function interaction(card: HitlCard, user: string): Record<string, unknown> {
  return {
    actions: [
      {
        action_id: card.actionId,
        block_id: card.blockId,
        value: card.value,
      },
    ],
    channel: { id: CHANNEL_ID },
    message: { thread_ts: THREAD_TS, ts: "1" },
    team: { id: TEAM_ID },
    type: "block_actions",
    user: { id: user, team_id: TEAM_ID },
  };
}

async function readCalls(path: string): Promise<SlackCall[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      return slackCallSchema.parse(value);
    });
}

function findCard(calls: readonly SlackCall[], start: number): HitlCard | null {
  return (
    calls.slice(start).find((call) => call.api === "chat.postMessage" && call.card)?.card ?? null
  );
}

function findCall(
  calls: readonly SlackCall[],
  start: number,
  api: string,
  user?: string,
): SlackCall | null {
  return (
    calls
      .slice(start)
      .find((call) => call.api === api && (user === undefined || call.user === user)) ?? null
  );
}

async function readSessionRunIds(appRoot: string): Promise<string[]> {
  const root = join(appRoot, ".workflow-data", "runs");
  const entries = await readdir(root).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const value: unknown = JSON.parse(await readFile(join(root, entry), "utf8"));
        return z.object({ runId: z.string(), workflowName: z.string() }).parse(value);
      }),
  );
  return runs
    .filter((run) => run.workflowName === "workflow//eve//workflowEntry")
    .map((run) => run.runId)
    .sort();
}

async function waitFor<T>(
  description: string,
  load: () => T | null | Promise<T | null>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
