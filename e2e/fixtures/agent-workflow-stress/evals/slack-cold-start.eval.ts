import { createHmac, randomBytes } from "node:crypto";

import { defineEval, type EveEvalContext } from "eve/evals";

import {
  SLACK_API_LATENCY_MS,
  SLACK_BOT_USER_ID,
  SLACK_PERSON_ID,
  SLACK_SESSION_ROUTE,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  parseSlackColdStartReply,
} from "../agent/lib/slack-cold-start";

const TRIALS = 5;
/** Read by scripts/eval-metrics/standard.mjs into `overhead.slack_cold_start_ms`. */
const METRIC_LOG_PREFIX = "EVE_SLACK_COLD_START_METRIC=";
/** The thread's session is looked up once its turn has likely started, so the lookups stay off the measured path. */
const FIRST_LOOKUP_MS = 1_500;
const LOOKUP_INTERVAL_MS = 250;
const LOOKUP_TIMEOUT_MS = 60_000;

export default defineEval({
  description:
    "Slack cold start: an app_mention that starts a new thread reaches the model; timed on the server from the webhook's arrival to the model call.",
  tags: ["workflow", "slack", "cold-start"],

  async test(t) {
    const samples: Array<{ modelCallMs: number; trial: number }> = [];

    // Logged even when a trial fails, so the samples taken so far still count.
    try {
      for (let trial = 1; trial <= TRIALS; trial += 1) {
        // A new channel per trial, so every mention starts a new thread and session.
        const channel = `C${randomBytes(5).toString("hex").toUpperCase()}`;
        const ts = `${Math.floor(Date.now() / 1000)}.${String(trial).padStart(6, "0")}`;
        await postMention(t, channel, ts);
        const sessionId = await threadSession(t, channel, ts);
        const turn = await t.target.attach(sessionId).nextTurn();
        turn.expectOk();
        const modelCallMs = parseSlackColdStartReply(turn.reply);
        if (modelCallMs === undefined)
          throw new Error(`Unexpected reply: ${turn.reply ?? "(none)"}`);
        samples.push({ modelCallMs, trial });
        t.log(`trial ${trial}/${TRIALS}: model called ${modelCallMs} ms after the webhook arrived`);
      }
    } finally {
      t.log(
        `${METRIC_LOG_PREFIX}${JSON.stringify({
          schemaVersion: 1,
          slackApiLatencyMs: SLACK_API_LATENCY_MS,
          samples,
          unit: "milliseconds",
        })}`,
      );
    }

    t.succeeded();
  },
});

/** Posts a signed `app_mention` the way Slack's Events API does: no `channel_type`, no `thread_ts`. */
async function postMention(t: EveEvalContext, channel: string, ts: string): Promise<void> {
  const body = JSON.stringify({
    token: "unused",
    team_id: SLACK_TEAM_ID,
    api_app_id: "A0COLDSTART",
    event: {
      type: "app_mention",
      user: SLACK_PERSON_ID,
      text: `<@${SLACK_BOT_USER_ID}> are you there?`,
      ts,
      team: SLACK_TEAM_ID,
      channel,
      event_ts: ts,
    },
    type: "event_callback",
    event_id: `Ev${randomBytes(5).toString("hex").toUpperCase()}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: SLACK_TEAM_ID,
        user_id: SLACK_BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    is_ext_shared_channel: false,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await t.target.fetch("/eve/v1/slack", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
  if (!response.ok)
    throw new Error(`Slack webhook failed (${response.status}): ${await response.text()}`);
}

/** The session eve started for a Slack thread. */
async function threadSession(t: EveEvalContext, channel: string, ts: string): Promise<string> {
  const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
  await sleep(FIRST_LOOKUP_MS);
  for (;;) {
    const query = new URLSearchParams({ channel, ts });
    const response = await t.target.fetch(`${SLACK_SESSION_ROUTE}?${query}`);
    if (!response.ok) throw new Error(`Session lookup failed (${response.status}).`);
    const { sessionId } = (await response.json()) as { sessionId: string | null };
    if (sessionId !== null) return sessionId;
    if (Date.now() > deadline) throw new Error(`No session for Slack thread ${channel}:${ts}.`);
    await sleep(LOOKUP_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
