// Runs the built agent against a fake Slack: a local Web API that records every post, edit, and
// delete, plus one signed app_mention. Prints the message timeline and the final card blocks.
//
//   pnpm build && pnpm simulate "How did deploys go last week?"
//
// Set SHOW_AGENT_LOG=1 to print the agent's server log at the end.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const question = process.argv[2] ?? "How did our deploys go last week? Show me the numbers.";
const SIGNING_SECRET = "simulated-signing-secret";
const BOT = "UBOT";
const CHANNEL = "CDEMO";
const API_PORT = 4810;
const AGENT_PORT = 4811;
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

const messages = new Map(); // ts -> { blocks, text, edits }
let nextTs = 1;

function summarize(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => b.type).join(",");
}

const api = createServer(async (req, res) => {
  const method = req.url.replace(/^\/+/, "").split("?")[0];
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = req.headers["content-type"]?.includes("json")
      ? JSON.parse(raw || "{}")
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {}
  if (typeof body.blocks === "string") body.blocks = JSON.parse(body.blocks);
  const reply = (extra = {}) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ...extra }));
  };

  switch (method) {
    case "chat.postMessage": {
      const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
      messages.set(ts, { blocks: body.blocks, text: body.text ?? body.markdown_text, edits: 0 });
      console.log(
        `${at()}  post    ${ts}  ${body.blocks ? `[${summarize(body.blocks)}]` : JSON.stringify((body.text ?? body.markdown_text ?? "").slice(0, 120))}`,
      );
      return reply({ ts, channel: CHANNEL, message: { ts } });
    }
    case "chat.update": {
      const message = messages.get(body.ts);
      if (message)
        Object.assign(message, {
          blocks: body.blocks ?? message.blocks,
          text: body.text ?? message.text,
          edits: message.edits + 1,
        });
      console.log(
        `${at()}  update  ${body.ts}  ${body.blocks ? `[${summarize(body.blocks)}]` : JSON.stringify((body.text ?? "").slice(0, 80))}`,
      );
      return reply({ ts: body.ts, channel: CHANNEL });
    }
    case "chat.delete":
      messages.delete(body.ts);
      console.log(`${at()}  delete  ${body.ts}`);
      return reply();
    case "assistant.threads.setStatus":
      if (body.status) console.log(`${at()}  status  ${body.status}`);
      return reply();
    case "auth.test":
      return reply({ user_id: BOT, team_id: "TDEMO", bot_id: "BDEMO" });
    case "users.info":
      return reply({
        user: {
          id: body.user,
          name: "alice",
          real_name: "Alice",
          profile: { display_name: "Alice" },
          tz: "America/Los_Angeles",
        },
      });
    case "conversations.replies":
    case "conversations.history":
      return reply({ messages: [], has_more: false });
    case "conversations.info":
      return reply({ channel: { id: CHANNEL, name: "deploys", is_channel: true } });
    default:
      return reply();
  }
});
await new Promise((resolve) => api.listen(API_PORT, resolve));

const agent = spawn("npx", ["eve", "start", "--port", String(AGENT_PORT)], {
  env: {
    ...process.env,
    SLACK_BOT_TOKEN: "xoxb-simulated",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_API_BASE_URL: `http://127.0.0.1:${API_PORT}/`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let agentLog = "";
agent.stdout.on("data", (d) => (agentLog += d));
agent.stderr.on("data", (d) => (agentLog += d));
const shutdown = (code) => {
  agent.kill();
  api.close();
  process.exit(code);
};

for (let i = 0; ; i++) {
  try {
    await fetch(`http://127.0.0.1:${AGENT_PORT}/`);
    break;
  } catch {
    if (i > 120) {
      console.error(agentLog);
      shutdown(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const ts = String(Date.now() / 1000);
const body = JSON.stringify({
  type: "event_callback",
  team_id: "TDEMO",
  event_id: `Ev${ts}`,
  authorizations: [{ is_bot: true, is_enterprise_install: false, team_id: "TDEMO", user_id: BOT }],
  event: {
    type: "app_mention",
    channel_type: "channel",
    channel: CHANNEL,
    user: "UALICE",
    text: `<@${BOT}> ${question}`,
    ts,
    event_ts: ts,
  },
});
const timestamp = Math.floor(Date.now() / 1000);
const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
console.log(`${at()}  mention "${question}"`);
const response = await fetch(`http://127.0.0.1:${AGENT_PORT}/eve/v1/slack`, {
  method: "POST",
  body,
  headers: {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  },
});
if (!response.ok) {
  console.error(`webhook returned ${response.status}: ${await response.text()}`);
  console.error(agentLog);
  shutdown(1);
}

// Settle once the thread has been quiet for a while after the first post.
let quietSince = Date.now();
let lastCount = 0;
const timeout = Date.now() + 180_000;
while (Date.now() < timeout) {
  await new Promise((r) => setTimeout(r, 500));
  const count = [...messages.values()].reduce((n, m) => n + 1 + m.edits, 0);
  if (count !== lastCount) {
    lastCount = count;
    quietSince = Date.now();
  } else if (count > 0 && Date.now() - quietSince > 8000) break;
}

console.log("\nFinal thread:");
for (const [ts, m] of messages) {
  console.log(`\n--- ${ts} (${m.edits} edits)`);
  console.log(m.blocks ? JSON.stringify(m.blocks, null, 2) : m.text);
}
if (process.env.SHOW_AGENT_LOG) console.log(agentLog);
shutdown(0);
