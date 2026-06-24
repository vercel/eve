import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const SLACK_HITL_AUTHORIZATION_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    zod: "^4.3.6",
  },
  files: {
    "agent/agent.ts": `export default { model: "openai/gpt-5.4-mini" };
`,
    "agent/channels/slack.ts": `import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: { botToken: "xoxb-scenario", signingSecret: "scenario-signing-secret" },
  onAppMention: () => ({
    auth: {
      attributes: {},
      authenticator: "scenario",
      principalId: "shared-principal",
      principalType: "user",
    },
  }),
});
`,
    "agent/instructions.md": "Call guarded-echo when the user requests it.\n",
    "agent/tools/guarded-echo.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Record a marker after the caller approves this operation.",
  inputSchema: z.object({ note: z.string() }),
  needsApproval: always(),
  async execute(input) {
    return { recorded: input.note };
  },
});
`,
    "slack-fetch-preload.mjs": `import { appendFile } from "node:fs/promises";

const callsPath = process.env.EVE_SLACK_CALLS_PATH;
if (!callsPath) throw new Error("EVE_SLACK_CALLS_PATH is required.");
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return originalFetch(input, init);

  const body = typeof init?.body === "string" ? init.body : "";
  const params = new URLSearchParams(body);
  const blocks = JSON.parse(params.get("blocks") ?? "[]");
  const actions = blocks.find((block) => block.block_id?.startsWith("eve_input_responder:"));
  const element = actions?.elements?.find((item) => item.action_id?.startsWith("eve_input:"));
  const card = element && {
    actionId: element.action_id, blockId: actions.block_id, value: element.value,
  };
  await appendFile(callsPath, JSON.stringify({
    api: new URL(url).pathname.slice("/api/".length), card, user: params.get("user"),
  }) + "\\n");
  return Response.json({ ok: true, message_ts: "1", ts: "1" });
};
`,
  },
  installDependencies: true,
  name: "slack-hitl-authorization",
};
