import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const CROSS_CHANNEL_OUTPUT_SCHEMA_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/source.ts": `import { defineChannel, POST } from "eve/channels";

import target, { summarySchema } from "./target.js";

export default defineChannel({
  routes: [
    POST("/api/handoff", async (req, { receive }) => {
      const body = (await req.json()) as { message: string; threadId: string };
      const session = await receive(target, {
        auth: null,
        message: body.message,
        outputSchema: summarySchema,
        target: { threadId: body.threadId },
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
`,
    "agent/channels/target.ts": `import { defineChannel, POST } from "eve/channels";

export const summarySchema = {
  "~standard": {
    version: 1,
    vendor: "portability-test",
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      }),
    },
  },
} as const;

export default defineChannel<undefined, void, { threadId: string }>({
  routes: [POST("/api/target", async () => new Response("ok"))],
  receive(input, { send }) {
    return send(input.message, {
      auth: input.auth,
      continuationToken: input.target.threadId,
    });
  },
});
`,
    "agent/schedules/daily-summary.ts": `import { defineSchedule } from "eve/schedules";

import target, { summarySchema } from "../channels/target.js";

export default defineSchedule({
  cron: "0 9 * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(
      receive(target, {
        auth: appAuth,
        message: "Prepare the daily summary.",
        outputSchema: summarySchema,
        target: { threadId: "daily" },
      }),
    );
  },
});
`,
  },
  name: "cross-channel-output-schema-portability",
};
