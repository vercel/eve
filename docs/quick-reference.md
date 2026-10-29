---
title: "Quick Reference"
description: "Copy-ready snippets for the requirements most agents need: tools, approvals, Slack, SSO, connections, per-user tools, subagents, skills, schedules, webhooks, memory, and evals."
---

Each snippet is the smallest complete version of one requirement, and CI typechecks every one against the current API. Copy the ones you need, then follow the link only when you need an option the snippet doesn't show. For end-to-end designs that combine several features, such as multi-tenant credentials, see [Patterns](./patterns/multi-tenant-auth.md). Every capability is a file: its path under `agent/` gives its name, so `agent/tools/get_project.ts` is the tool `get_project`.

## Start a project

```bash
npx eve@latest init my-agent   # scaffolds, installs dependencies, initializes Git
cd my-agent
npm run typecheck && npm run build
```

`agent/instructions.md` is the system prompt and `agent/agent.ts` sets the model. Add files only for what you need. The scaffold already installs `eve`, `zod`, `ai`, and `@vercel/connect`; add any other package you import with `npm install`. See [Getting Started](./getting-started.mdx) and [Agent Files](./reference/agent-files.md).

## Know what an agent can do by default

Every agent, including each subagent, starts with eve's optional default tools: `bash`, `read_file`, and `write_file` in its own sandbox, `web_fetch`, `web_search` (for supported providers), and, on the root only, `agent`, which delegates to a copy of the root. Set `defaultTools: false` in `agent.ts` to remove them, then add back only what you need, such as `export { default } from "eve/tools/bash";` in `agent/tools/bash.ts`. The catalog tools `eve__search`, `eve__tool`, and `eve__skill` appear whenever the agent has connections or skills to reach. A subagent never inherits its parent's tools, connections, or skills. See [Built-in Tools](./concepts/built-in-tools.md).

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  defaultTools: false,
});
```

## Call an HTTP API from a tool

```ts title="agent/tools/get_project.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up a project by ID.",
  inputSchema: z.object({ projectId: z.string() }),
  async execute({ projectId }, ctx) {
    const response = await fetch(
      `https://api.example.com/projects/${encodeURIComponent(projectId)}`,
      {
        headers: { authorization: `Bearer ${process.env.PROJECTS_API_TOKEN}` },
        signal: ctx.abortSignal,
      },
    );
    if (!response.ok) throw new Error(`Projects API returned ${response.status}`);
    return response.json();
  },
});
```

Validate input in the schema or in `execute` before any side effect. A thrown error reaches the model as a tool error. See [Tools](./tools/overview.mdx).

## Require approval for some calls

```ts title="agent/tools/send_email.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an email.",
  inputSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  // toolInput is undefined when the model's input doesn't parse, so ask a person.
  approval: ({ toolInput }) =>
    toolInput === undefined || !toolInput.to.endsWith("@example.com")
      ? "user-approval"
      : "not-applicable",
  async execute({ to, subject }) {
    return { sent: true, to, subject };
  },
});
```

`"user-approval"` pauses for a person, `"not-applicable"` runs without asking, and `{ type: "denied", reason }` refuses. For a fixed policy, use `always()`, `once()`, or `never()` from `eve/tools/approval`. Connections take the same `approval` option. See [Human in the Loop](./tools/human-in-the-loop.md#approvals).

## Add Slack

### With a Vercel Connect connector

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

### With your own Slack app credentials

```ts title="agent/channels/slack.ts"
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
});
```

`slackChannel()` with no `credentials` reads the same two variables. The defaults answer app mentions and DMs, reply in the thread, and render approvals as buttons. Human senders become `user` principals; other bots become `service` principals. See [Slack](./channels/slack.mdx).

## Protect the HTTP API with your SSO

```ts title="agent/channels/eve.ts"
import { localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [oidc({ issuer: "https://sso.example.com", audiences: ["my-agent"] }), localDev()],
});
```

- `auth` entries run in order. The first to return a principal wins, and a request nobody accepts gets a `401`. `localDev()` accepts only local `eve dev` requests, so in production this channel admits only SSO tokens.
- `oidc()` verifies the token's signature, issuer, audience, and expiry against the issuer's discovery document. Custom string and string-array claims become `ctx.session.auth.current.attributes`, so a `groups` claim is `attributes.groups`; the token's `sub` is `subject`.
- Verified callers are `service` principals. User-scoped connections, such as `connect()` below, need a `user` principal. To get one, wrap `oidc()` in your own `AuthFn` that relabels tokens carrying a claim only your identity provider's user tokens have, as in [`oidc()`](./guides/auth-and-route-protection.md#oidc).

See [Authentication](./guides/auth-and-route-protection.md). To pick credentials or policy per tenant, see [Multi-Tenant Auth](./patterns/multi-tenant-auth.md).

## Connect an MCP server as each user

```ts title="agent/connections/tracker.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.tracker.example/mcp",
  description: "Read issues in the tracker as the signed-in user.",
  auth: connect({ connector: "mcp.tracker.example/my-agent", principalType: "user" }),
  tools: { allow: ["list_issues", "get_issue"] },
});
```

`tools.allow` takes the server's own tool names; the model sees them as `tracker__list_issues` and `tracker__get_issue`. `principalType: "user"` uses the caller's own grant and asks them to sign in on first use; `"app"` acts as the agent. For a static token, use `auth: { getToken: async () => ({ token: process.env.API_TOKEN! }) }`. Use `tools: { block: [...] }` to hide specific tools instead. See [Connections](./connections/overview.mdx) and [MCP](./connections/mcp.mdx).

## Turn an OpenAPI contract into tools

```ts title="agent/connections/calendar.ts"
import { defineOpenAPIConnection } from "eve/connections";
import spec from "../../calendar-openapi.json";

export default defineOpenAPIConnection({
  spec,
  baseUrl: "https://api.example.com",
  description: "Read and schedule team calendar events.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: process.env.CALENDAR_API_TOKEN! }),
  },
  operations: { allow: ["listEvents", "createEvent"] },
  approval: ({ toolName }) =>
    toolName === "calendar__createEvent" ? "user-approval" : "not-applicable",
});
```

- `spec` is a URL or a parsed object. Import a local JSON contract (the scaffold enables `resolveJsonModule`) so it ships with the build.
- Each operation becomes the tool `<connection>__<operationId>`. Its input holds path, query, and header parameters by name and the JSON request body under `body`.
- `operations` takes exactly one of `allow` or `block`, matched by `operationId`. An operation that isn't exposed can't be called.
- `approval` works as it does on a tool. A policy that depends on the request reads it from `toolInput`, such as `toolInput.body`.

See [OpenAPI Connections](./connections/openapi.mdx).

## Show a tool only to some callers

```ts title="agent/tools/export_audit_log.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic((ctx) => {
  const groups = ctx.session.auth.current?.attributes.groups;
  if (!Array.isArray(groups) || !groups.includes("admin")) return null;
  return defineTool({
    description: "Export the audit log for a date range.",
    inputSchema: z.object({ from: z.string().date(), to: z.string().date() }),
    async execute({ from, to }) {
      return { from, to, entries: [] };
    },
  });
});
```

eve evaluates the function before each model call; returning `null` removes the tool, so the model never sees it. `attributes` come from the channel's auth, such as the `groups` claim in the [SSO snippet](#protect-the-http-api-with-your-sso). The same pattern works for connections, skills, subagents, and instructions. See [Dynamic Capabilities](./guides/dynamic-capabilities.md).

## Delegate to a subagent

A subagent is a directory under `agent/subagents/` with its own `agent.ts`, instructions, and capabilities. It doesn't inherit the parent's tools or connections; share one by re-exporting it:

```text
agent/subagents/researcher/agent.ts
agent/subagents/researcher/instructions.md
agent/subagents/researcher/connections/tracker.ts   # export { default } from "../../../connections/tracker";
agent/subagents/reviewer/agent.ts
agent/subagents/reviewer/instructions.md
```

```ts title="agent/subagents/researcher/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Researches a question in the issue tracker and returns a sourced answer.",
  model: "anthropic/claude-sonnet-5",
});
```

The parent model gets a `researcher` tool that takes a `message` and decides when to call it from `description`, which is required. The child never sees the parent's conversation, so the message must carry everything it needs.

When code should decide the order instead of the model, such as reviewing every answer before it's returned, call subagents from a workflow tool:

```ts title="agent/tools/research_and_review.ts"
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Research a question, then have the reviewer check the answer.",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx) {
    "use workflow";
    const research = await ctx.agent("researcher").send(question, { signal: ctx.abortSignal });
    const { reply: draft } = await research.result();
    const review = await ctx
      .agent("reviewer")
      .send(`Check this answer to "${question}":\n\n${draft}`, { signal: ctx.abortSignal });
    const { reply: verdict } = await review.result();
    return { draft, verdict };
  },
});
```

To hide a subagent from the parent model so only workflow tools can call it, set `tool: false` in its `agent.ts`. To run several at once, wrap their `send()` and `result()` calls in `Promise.all`. See [Subagents](./subagents/index.mdx) and [Workflow Tools](./tools/workflows.mdx#delegate-work-ctxagent).

## Load knowledge only when it's needed

```md title="agent/skills/release-checklist.md"
---
description: Steps for cutting a release. Load when someone asks to ship, tag, or release a version.
---

# Release checklist

1. ...
```

Only the `description` stays in context; the model loads the body when a request matches it. Put always-on behavior in `instructions.md` instead. See [Skills](./skills.mdx).

## Run on a schedule and post to Slack

```ts title="agent/schedules/monthly-recap.ts"
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 8 1 * *", // 08:00 UTC on the first of each month
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send("Recap the projects that shipped last month.", {
        auth: appAuth,
      }),
    );
  },
});
```

The agent runs a turn as the app principal and posts its reply as a new thread in that channel. Fetch data the prompt needs in `run` before sending. See [Schedules](./schedules.mdx).

## Receive a signed webhook and hand it to Slack

```ts title="agent/channels/deploys.ts"
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import slack from "./slack";

// Replace with your provider's scheme or SDK helper.
function isSigned(body: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.DEPLOYS_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/deploys", async (request, ctx) => {
      const body = await request.text();
      const { headers } = request;
      if (!isSigned(body, headers.get("x-timestamp"), headers.get("x-signature"))) {
        return new Response("invalid signature", { status: 401 });
      }
      ctx.waitUntil(
        ctx.to(slack, { channelId: "C0123ABC" }).send(`Summarize this deploy event:\n${body}`, {
          auth: {
            authenticator: "deploys-webhook",
            principalType: "service",
            principalId: "deploys",
            attributes: {},
          },
        }),
      );
      return new Response("ok");
    }),
  ],
});
```

Routes mount at the path you give, here `POST /webhooks/deploys`. Verify the raw body before parsing, and return early so a rejected request never reaches the agent. Signing the timestamp with the body and rejecting requests older than five minutes stops old requests from being replayed. Match the headers and signed content to your provider's scheme. The agent's reply starts a Slack thread that people can continue by mentioning the app. See [Custom Channels](./channels/custom.mdx#cross-channel-hand-off). To post without an agent turn, with retries, see [Durable Cross-Channel Notifications](./patterns/durable-cross-channel-notifications.md).

## Remember facts across conversations

```ts title="agent/memory/team.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Facts the team has shared: preferences, conventions, and decisions.",
  provider: fileMemory(),
  scope: "team",
});
```

A fixed string scope gives everyone one shared memory. Use `byPrincipal` from `eve/memory/scope` for one memory per person. See [Memory](./memory/overview.mdx) and [Multi-Tenant Memory](./patterns/multi-tenant-memory.md).

## Test with an eval and a stubbed tool

Stubs replace a tool's `execute`, so an eval never calls the real API. A session can use stubs only when the channel's auth grants `allowToolStubs`. This channel grants it to local `eve dev` requests; if your channel already has an `auth` array, wrap its `localDev()` entry the same way:

```ts title="agent/channels/eve.ts"
import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const dev = localDev();

export default eveChannel({
  // Local `eve dev` only: lets `eve eval` replace tools with stubs.
  auth: async (request) => {
    const caller = await dev(request);
    return caller ? { ...caller, allowToolStubs: true } : null;
  },
});
```

```ts title="evals/evals.config.ts"
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({});
```

```ts title="evals/project-lookup.eval.ts"
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Looks up a project with get_project.",
  async test(t) {
    const session = await t.session({
      stubs: [
        { id: "project", tool: "get_project", outcome: { response: { status: "on track" } } },
      ],
    });
    const turn = await session.send("How is project 42 doing?");
    t.succeeded();
    t.calledTool("get_project");
    t.check(turn.reply, includes("on track"));
  },
});
```

Run it with `npx eve eval project-lookup`. See [Evals](./evals/overview.mdx) and [Tool Stubs](./evals/tool-stubs.mdx).
