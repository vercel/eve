---
title: "Recipes"
description: "Copy-ready snippets for the requirements most agents need: tools, approvals, Slack, SSO, connections, per-user tools, subagents, skills, schedules, webhooks, memory, and evals."
---

Each recipe is the smallest complete version of one requirement, checked against the current API. Copy the ones you need, then follow the link only when you need an option the recipe doesn't show. Every capability is a file: its path under `agent/` gives its name, so `agent/tools/get_order.ts` is the tool `get_order`.

## Start a project

```bash
npx eve@latest init my-agent   # scaffolds, installs dependencies, initializes Git
cd my-agent
npm run typecheck && npm run build
```

`agent/instructions.md` is the system prompt and `agent/agent.ts` sets the model. Add files only for what you need. Install other packages you import, such as `@vercel/connect`, with `npm install`. See [Getting Started](./getting-started.mdx) and [Agent Files](./reference/agent-files.md).

## Call an HTTP API from a tool

```ts title="agent/tools/get_order.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up an order by ID.",
  inputSchema: z.object({ orderId: z.string() }),
  async execute({ orderId }, ctx) {
    const response = await fetch(`https://api.example.com/orders/${encodeURIComponent(orderId)}`, {
      headers: { authorization: `Bearer ${process.env.ORDERS_TOKEN}` },
      signal: ctx.abortSignal,
    });
    if (!response.ok) throw new Error(`Orders API returned ${response.status}`);
    return response.json();
  },
});
```

Validate input in the schema or in `execute` before any side effect. A thrown error reaches the model as a tool error. See [Tools](./tools) (`tools/overview.mdx`).

## Require approval for some calls

```ts title="agent/tools/refund.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  approval: ({ toolInput }) => {
    if (toolInput === undefined) return { type: "denied", reason: "Missing input." };
    return toolInput.amount >= 500 ? "user-approval" : "not-applicable";
  },
  async execute({ orderId, amount }) {
    return { orderId, refunded: amount };
  },
});
```

`"user-approval"` pauses for a person, `"not-applicable"` runs without asking, and `{ type: "denied", reason }` refuses. For a fixed policy, use `always()`, `once()`, or `never()` from `eve/tools/approval`. Connections take the same `approval` option. See [Human in the Loop](./human-in-the-loop#approvals) (`tools/human-in-the-loop.md`).

## Add Slack

With a Vercel Connect connector:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

With your own Slack app credentials in environment variables:

```ts title="agent/channels/slack.ts"
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
});
```

`slackChannel()` with no `credentials` reads the same two variables. The defaults answer app mentions and DMs, reply in the thread, and render approvals as buttons. Each sender becomes a `user` principal. See [Slack](./channels/slack.mdx).

## Protect the HTTP API with your SSO

```ts title="agent/channels/eve.ts"
import { type AuthFn, localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const sso = oidc({ issuer: "https://sso.example.com", audiences: ["my-agent"] });
const dev = localDev();

const employee: AuthFn<Request> = async (request) => {
  const caller = await sso(request);
  return caller ? { ...caller, principalType: "user" } : null;
};

// Local `eve dev` only. allowToolStubs lets `eve eval` stub tools.
const localWithStubs: AuthFn<Request> = async (request) => {
  const caller = await dev(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({ auth: [employee, localWithStubs] });
```

- `auth` entries run in order. The first to return a principal wins, and a request nobody accepts gets a `401`. `localDev()` never accepts anything in production, so this channel admits only SSO tokens there.
- `oidc()` fetches the issuer's discovery document, verifies signature, issuer, audience, and expiry, and labels the caller `authenticator: "oidc"`, `principalType: "service"`. Relabel it `"user"`, as above, when tokens identify people. User-scoped connections, such as `connect()` below, require a `user` principal.
- Custom string and string-array claims become `ctx.session.auth.current.attributes`, so a `groups` claim is `attributes.groups`. Standard claims (`iss`, `sub`, `aud`, `exp`, …) are omitted; the subject is `principalId`.

See [Authentication](./guides/auth-and-route-protection.md).

## Connect an MCP server as each user

```ts title="agent/connections/notion.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Search and read Notion pages as the signed-in user.",
  auth: connect({ connector: "mcp.notion.com/my-agent", principalType: "user" }),
  tools: { allow: ["search", "fetch"] },
});
```

The model reaches its tools as `notion__search` and `notion__fetch`. `principalType: "user"` uses the caller's own grant and asks them to sign in on first use; `"app"` acts as the agent. For a static token, use `auth: { getToken: async () => ({ token: process.env.API_TOKEN! }) }`. Use `tools: { block: [...] }` to hide specific tools instead. See [Connections](./connections) (`connections/overview.mdx`) and [MCP](./connections/mcp.mdx).

## Turn an OpenAPI contract into tools

```ts title="agent/connections/inventory.ts"
import { defineOpenAPIConnection } from "eve/connections";
import spec from "../../inventory-openapi.json";

export default defineOpenAPIConnection({
  spec,
  baseUrl: "https://api.example.com",
  description: "Inventory lookups and purchase orders.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: process.env.INVENTORY_API_TOKEN! }),
  },
  operations: { allow: ["getStock", "createOrder"] },
  approval: ({ toolName, toolInput }) => {
    if (toolName !== "inventory__createOrder") return "not-applicable";
    const body = toolInput?.body as { quantity?: number; unitCost?: number } | undefined;
    return (body?.quantity ?? 0) * (body?.unitCost ?? 0) >= 1000
      ? "user-approval"
      : "not-applicable";
  },
});
```

- `spec` is a URL or a parsed object. Import a local JSON contract (the scaffold enables `resolveJsonModule`) so it ships with the build.
- Each operation becomes the tool `<connection>__<operationId>`. Its input holds path, query, and header parameters by name and the JSON request body under `body`.
- `operations` takes exactly one of `allow` or `block`, matched by `operationId`. An operation that isn't exposed can't be called.

See [OpenAPI Connections](./connections/openapi.mdx).

## Show a tool only to some callers

```ts title="agent/tools/payroll_report.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic((ctx) => {
  const groups = ctx.session.auth.current?.attributes.groups;
  if (!Array.isArray(groups) || !groups.includes("hr")) return null;
  return defineTool({
    description: "Get the payroll report for a month like 2026-01.",
    inputSchema: z.object({ month: z.string() }),
    async execute({ month }) {
      return { month };
    },
  });
});
```

eve evaluates the function before each model call; returning `null` removes the tool, so the model never sees it. The same pattern works for connections, skills, subagents, and instructions. See [Dynamic Capabilities](./guides/dynamic-capabilities.md).

## Delegate to subagents from a tool

A subagent is a directory under `agent/subagents/` with its own `agent.ts`, instructions, and capabilities. It doesn't inherit the parent's tools or connections:

```text
agent/subagents/analyst/agent.ts
agent/subagents/analyst/instructions.md
agent/subagents/analyst/tools/run_query.ts
agent/subagents/researcher/agent.ts
agent/subagents/researcher/instructions.md
agent/subagents/researcher/connections/notion.ts   # export { default } from "../../../connections/notion";
```

```ts title="agent/subagents/analyst/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Answers questions from the data warehouse.",
  model: "anthropic/claude-sonnet-5",
  tool: false, // hidden from the parent model; only workflow tools can call it
});
```

```ts title="agent/tools/investigate.ts"
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Ask the analyst and researcher in parallel and return both answers.",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx) {
    "use workflow";
    const [analyst, researcher] = await Promise.all([
      ctx.agent("analyst").send(question, { signal: ctx.abortSignal }),
      ctx.agent("researcher").send(question, { signal: ctx.abortSignal }),
    ]);
    const [a, r] = await Promise.all([analyst.result(), researcher.result()]);
    return { analyst: a.reply, researcher: r.reply };
  },
});
```

`description` is required. Without `tool: false`, the parent model can call the subagent directly as a tool. Share code between agents by re-exporting from one file, as the researcher's connection does. See [Subagents](./subagents) (`subagents/index.mdx`) and [Workflow Tools](./tools/workflows.mdx#delegate-work-ctxagent).

## Load knowledge only when it's needed

```md title="agent/skills/metric-definitions.md"
---
description: Metric definitions. Load when someone asks about a metric such as ARR or churn.
---

# Metric definitions

- ARR: ...
```

Only the `description` stays in context; the model loads the body when a request matches it. Put always-on behavior in `instructions.md` instead. See [Skills](./skills.mdx).

## Run on a schedule and post to Slack

```ts title="agent/schedules/weekly-digest.ts"
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 15 * * 1", // Mondays at 15:00 UTC
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send("Post this week's metrics summary.", {
        auth: appAuth,
      }),
    );
  },
});
```

The agent runs a turn as the app principal and posts its reply as a new thread in that channel. Fetch data the prompt needs in `run` before sending. See [Schedules](./schedules.mdx).

## Receive a signed webhook and hand it to Slack

```ts title="agent/channels/alerts.ts"
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import slack from "./slack";

function verify(body: string, signature: string | null): boolean {
  const secret = process.env.ALERTS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/alerts", async (request, ctx) => {
      const body = await request.text();
      if (!verify(body, request.headers.get("x-signature"))) {
        return new Response("invalid signature", { status: 401 });
      }
      const alert = JSON.parse(body) as { id: string };
      ctx.waitUntil(
        ctx.to(slack, { channelId: "C0ALERTS1" }).send(`New alert: ${JSON.stringify(alert)}`, {
          auth: {
            authenticator: "alerts-webhook",
            principalType: "service",
            principalId: "alerts",
            attributes: {},
          },
        }),
      );
      return new Response("ok");
    }),
  ],
});
```

Routes mount at the path you give, here `POST /webhooks/alerts`. Verify the raw body before parsing, and return early so a rejected request never reaches the agent. The Slack post starts a thread that people can continue by mentioning the app. See [Custom Channels](./channels/custom.mdx#cross-channel-hand-off).

## Remember facts across conversations

```ts title="agent/memory/suppliers.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Facts the team shares about suppliers: lead times and minimum orders.",
  provider: fileMemory(),
  scope: "team",
});
```

A fixed string scope gives everyone one shared memory. Use `byPrincipal` from `eve/memory/scope` for one memory per person. See [Memory](./memory) (`memory/overview.mdx`).

## Test with an eval and a stubbed tool

```ts title="evals/evals.config.ts"
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({});
```

```ts title="evals/order-lookup.eval.ts"
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Looks up an order with get_order.",
  async test(t) {
    const session = await t.session({
      stubs: [{ id: "order", tool: "get_order", outcome: { response: { status: "shipped" } } }],
    });
    const turn = await session.send("Where is order 42?");
    t.succeeded();
    t.calledTool("get_order");
    t.check(turn.reply, includes("shipped"));
  },
});
```

Run it with `npx eve eval order-lookup`. Stubs replace the tool's `execute`, so the eval never calls the real API. Stubbed sessions need `allowToolStubs: true` from the channel's auth, as the [SSO recipe](#protect-the-http-api-with-your-sso) grants in local development. See [Evals](./evals/overview.mdx) and [Tool Stubs](./evals/tool-stubs.mdx).
