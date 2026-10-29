---
title: "Quick Reference"
description: "Copy-ready snippets for the requirements most agents need: tools, approvals, Slack, GitHub, SSO and cookie auth, a Next.js chat panel, connections, per-user tools, subagents, sandboxes, hooks, skills, schedules, webhooks, memory, and evals."
---

Each snippet is the smallest complete version of one requirement, and CI typechecks every one against the current API. Copy the ones you need, then follow the link only when you need an option the snippet doesn't show. For end-to-end designs that combine several features, such as multi-tenant credentials, see [Patterns](./patterns/multi-tenant-auth.md). Every capability is a file: its path under `agent/` gives its name, so `agent/tools/get_order.ts` is the tool `get_order`.

## Start a project

```bash
npx eve@latest init my-agent   # scaffolds, installs dependencies, initializes Git
cd my-agent
npm run typecheck && npm run build
```

`agent/instructions.md` is the system prompt and `agent/agent.ts` sets the model. Add files only for what you need. The scaffold already installs `eve`, `zod`, `ai`, and `@vercel/connect`; add any other package you import with `npm install`. See [Getting Started](./getting-started.mdx) and [Agent Files](./reference/agent-files.md).

## Know what an agent can do by default

Every agent, including each subagent, starts with eve's optional default tools: `bash`, `read_file`, and `write_file` in its own sandbox, `web_fetch`, `web_search` (for supported providers), and, on the root only, `agent`, which delegates to a copy of the root. Set `defaultTools: false` in `agent.ts` to remove them, then add back only what you need, such as `export { default } from "eve/tools/bash";` in `agent/tools/bash.ts`. Each module is named after its tool, with underscores: `eve/tools/read_file`, `eve/tools/web_fetch`. The catalog tools `eve__search`, `eve__tool`, and `eve__skill` appear whenever the agent has connections or skills to reach. A subagent never inherits its parent's tools, connections, or skills. See [Built-in Tools](./concepts/built-in-tools.md).

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  defaultTools: false,
});
```

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

Validate input in the schema or in `execute` before any side effect. A thrown error reaches the model as a tool error. See [Tools](./tools/overview.mdx).

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

`"user-approval"` pauses for a person, `"not-applicable"` runs without asking, and `{ type: "denied", reason }` refuses. For a fixed policy, use `always()`, `once()`, or `never()` from `eve/tools/approval`. Connections take the same `approval` option. See [Human in the Loop](./tools/human-in-the-loop.md#approvals).

## Limit a tool to the caller's organization and role

```ts title="agent/tools/delete_project.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { deleteProject } from "../../lib/projects";

export default defineTool({
  description: "Permanently delete one of the organization's projects. Owners only.",
  inputSchema: z.object({ projectId: z.string() }),
  approval: ({ session }) =>
    session.auth.current?.attributes.role === "owner"
      ? "user-approval"
      : { type: "denied", reason: "Only organization owners can delete projects." },
  async execute({ projectId }, ctx) {
    const { orgId, role } = ctx.session.auth.current?.attributes ?? {};
    if (typeof orgId !== "string" || role !== "owner") {
      throw new Error("Only organization owners can delete projects.");
    }
    return deleteProject({ orgId, projectId });
  },
});
```

Take the organization from the verified caller, never from tool input, so the model can't reach another organization's data. `attributes` comes from the channel's auth, as in [the session cookie snippet](#sign-in-with-your-apps-session-cookie). Approval is a gate, not authorization: check the role again in `execute`. By default only the person whose turn requested the call can approve it. See [Multi-Tenant Approvals](./patterns/multi-tenant-approvals.md).

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

## Answer GitHub comments and failed checks

```ts title="agent/channels/github.ts"
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

export default githubChannel({
  botName: "my-agent",
  credentials: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  },
  onCheckSuite: (ctx, suite) =>
    suite.action === "completed" &&
    suite.conclusion === "failure" &&
    suite.app.slug === "github-actions" &&
    suite.pullRequests.length > 0
      ? {
          auth: defaultGitHubAuth(ctx),
          context: [`Check suite ${suite.checkSuiteId} failed at ${suite.headSha}.`],
        }
      : null,
});
```

A comment containing `@my-agent` on an issue or PR starts a turn by default; the reply is posted as a comment. CI hooks (`onCheckSuite`, `onCheckRun`, `onWorkflowRun`) are opt-in: return `{ auth }` to start a turn on the PR, or `null` to ignore the event. Before the first model call, eve checks the PR's ref out into the sandbox; that needs the Vercel Sandbox backend, and local sandboxes skip it. Point the GitHub App's webhook at `/eve/v1/github` and subscribe to `issue_comment`, `pull_request_review_comment`, and the CI events you handle. `ctx.github.request({ method, path, body })` calls any other GitHub API as the app. See [GitHub](./channels/github.mdx).

## Protect the HTTP API with your SSO

```ts title="agent/channels/eve.ts"
import { type AuthFn, localDev, oidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const sso = oidc({ issuer: "https://sso.example.com", audiences: ["my-agent"] });
const dev = localDev();

// Only tokens that name a person become users. Machine tokens from the same
// issuer have no email claim and stay "service" principals.
const employee: AuthFn<Request> = async (request) => {
  const caller = await sso(request);
  if (!caller) return null;
  return typeof caller.attributes.email === "string"
    ? { ...caller, principalType: "user" }
    : caller;
};

// Local `eve dev` only. allowToolStubs lets `eve eval` stub tools.
const localWithStubs: AuthFn<Request> = async (request) => {
  const caller = await dev(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({ auth: [employee, localWithStubs] });
```

- `auth` entries run in order. The first to return a principal wins, and a request nobody accepts gets a `401`. `localDev()` never accepts anything in production, so this channel admits only SSO tokens there.
- `oidc()` fetches the issuer's discovery document, verifies signature, issuer, audience, and expiry, and labels the caller `authenticator: "oidc"`, `principalType: "service"`. Relabel it `"user"` only when the token carries a claim your identity provider sets only for people, such as `email` above, so machine tokens with the same issuer and audience don't get user-scoped connections. User-scoped connections, such as `connect()` below, require a `user` principal.
- Custom string and string-array claims become `ctx.session.auth.current.attributes`, so a `groups` claim is `attributes.groups`. Standard claims (`iss`, `sub`, `aud`, `exp`, …) are omitted from `attributes`; the token's `sub` is `subject`.

See [Authentication](./guides/auth-and-route-protection.md). To pick credentials or policy per tenant, see [Multi-Tenant Auth](./patterns/multi-tenant-auth.md).

## Sign in with your app's session cookie

```ts title="agent/channels/eve.ts"
import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { getSession } from "../../lib/session";

const appSession: AuthFn<Request> = async (request) => {
  const session = await getSession(request.headers.get("cookie"));
  if (!session) return null;
  return {
    authenticator: "app-session",
    principalType: "user",
    principalId: session.userId,
    attributes: { orgId: session.orgId, role: session.role },
  };
};

export default eveChannel({
  auth: [appSession],
  uploadPolicy: { maxBytes: 3 * 1024 * 1024, allowedMediaTypes: ["application/pdf"] },
});
```

When the chat runs on the same domain as your app, the browser sends your app's cookies with every eve request. Use your app's own session lookup; `getSession` stands in for it. A request without a valid session gets a `401`, in local development too. Add `localDev()` after `appSession` only if you want local requests without a session to get through. `attributes` values must be strings or string arrays. `uploadPolicy` caps file parts; a file that breaks it returns `413` or `415`. See [Next.js](./guides/frontend/nextjs.mdx#authenticate-users) and [Send files](./channels/eve.mdx#send-files).

## Add a chat panel to a Next.js app

```ts title="next.config.ts"
import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
```

```tsx title="components/assistant.tsx"
"use client";

import type { ClientSessionState } from "eve/client";
import { openInteractions } from "eve/events";
import { useEveAgent } from "eve/react";
import { useEffect, useState } from "react";

type PageContext = Record<string, string>;

export function Assistant({ pageContext }: { pageContext: PageContext }) {
  // Read localStorage after mount, so the server and first client render match.
  const [saved, setSaved] = useState<ClientSessionState | null>();
  useEffect(() => {
    const raw = localStorage.getItem("assistant-session");
    setSaved(raw ? (JSON.parse(raw) as ClientSessionState) : null);
  }, []);
  if (saved === undefined) return null;
  return <Chat pageContext={pageContext} saved={saved ?? undefined} />;
}

function Chat({ pageContext, saved }: { pageContext: PageContext; saved?: ClientSessionState }) {
  const agent = useEveAgent({
    initialSession: saved,
    resume: saved !== undefined,
    // Reaches the model for this turn only; it isn't added to the conversation history.
    prepareSend: (input) => ({ ...input, clientContext: pageContext }),
  });
  useEffect(() => {
    if (agent.session) localStorage.setItem("assistant-session", JSON.stringify(agent.session));
  }, [agent.session]);

  const busy = agent.status === "busy";
  const prompts = openInteractions(agent.view).filter(
    (item) => item.request.kind !== "sign-in" && item.answer === undefined,
  );

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const text = String(data.get("message") ?? "");
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) return text && agent.send(text);
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve) => {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    return agent.send([
      { type: "text", text },
      { type: "file", data: dataUrl, mediaType: file.type, filename: file.name },
    ]);
  }

  return (
    <aside>
      {agent.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </p>
      ))}
      {prompts.map(({ interactionId, request }) => (
        <div key={interactionId}>
          <p>{request.prompt}</p>
          {request.options?.map((option) => (
            <button
              key={option.id}
              onClick={() => void agent.respond([{ interactionId, optionId: option.id }])}
            >
              {option.label}
            </button>
          ))}
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <input name="message" disabled={agent.status === "resuming"} />
        <input name="file" type="file" accept="application/pdf" />
        <button type="submit">Send</button>
        {busy && (
          <button type="button" onClick={() => void agent.cancel()}>
            Stop
          </button>
        )}
      </form>
    </aside>
  );
}
```

`withEve` runs the agent with the Next.js app: `next dev` starts it, and a Vercel deployment builds and serves it with the app. To run a production build elsewhere, run `eve build` before `next build`. Render `<Assistant pageContext={{ page: "project", projectId }} />` in a shared layout to show it on every page.

- `clientContext` reaches every model call in that turn but isn't added to the conversation history, so page details don't pile up across turns.
- Saving `agent.session` and passing it back as `initialSession` with `resume: true` restores the conversation after a reload. Save `agent.events` as well, and pass them as `initialEvents`, to render old messages before catch-up finishes.
- Approvals and questions arrive as open interactions; `respond()` answers them with the option the person chose. `cancel()` stops the running turn.

See [Next.js](./guides/frontend/nextjs.mdx), [Frontend Overview](./guides/frontend/overview.mdx), and [`useEveAgent`](./guides/frontend/use-eve-agent.mdx).

## Connect an MCP server as each user

```ts title="agent/connections/notion.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Search and read Notion pages as the signed-in user.",
  auth: connect({ connector: "mcp.notion.com/my-agent", principalType: "user" }),
  tools: { allow: ["notion-search", "notion-fetch"] },
});
```

`tools.allow` takes the server's own tool names; the model sees them as `notion__notion-search` and `notion__notion-fetch`. `principalType: "user"` uses the caller's own grant and asks them to sign in on first use; `"app"` acts as the agent. For a static token, use `auth: { getToken: async () => ({ token: process.env.API_TOKEN! }) }`. Use `tools: { block: [...] }` to hide specific tools instead. See [Connections](./connections/overview.mdx) and [MCP](./connections/mcp.mdx).

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

`description` is required. Without `tool: false`, the parent model can call the subagent directly as a tool. Share code between agents by re-exporting from one file, as the researcher's connection does. See [Subagents](./subagents/index.mdx) and [Workflow Tools](./tools/workflows.mdx#delegate-work-ctxagent).

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

const MAX_AGE_SECONDS = 300;

function verify(body: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.ALERTS_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age <= MAX_AGE_SECONDS)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default defineChannel({
  routes: [
    POST("/webhooks/alerts", async (request, ctx) => {
      const body = await request.text();
      const { headers } = request;
      if (!verify(body, headers.get("x-timestamp"), headers.get("x-signature"))) {
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

Routes mount at the path you give, here `POST /webhooks/alerts`. Verify the raw body before parsing, and return early so a rejected request never reaches the agent. Signing the timestamp with the body and rejecting stale requests stops a captured request from being replayed later. A replay inside the five-minute window still gets through, so dedupe on the provider's delivery ID if a duplicate thread matters. Match the header names and signed string to your provider's scheme. The Slack post starts a thread that people can continue by mentioning the app. See [Custom Channels](./channels/custom.mdx#cross-channel-hand-off). To post without an agent turn, with retries, see [Durable Cross-Channel Notifications](./patterns/durable-cross-channel-notifications.md).

## Give the agent a prepared sandbox

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  // Runs once per build; every session sandbox starts from the snapshot.
  prepare: async (sandbox) => {
    const result = await sandbox.run({ command: "npm install -g pnpm@10" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});

export default defineSandbox(() => environment.open({ resources: { vcpus: 4 } }));
```

```ts title="agent/subagents/tester/sandbox.ts"
import { defineParentSandbox } from "eve/sandbox";

export default defineParentSandbox();
```

```ts title="agent/hooks/after-turn.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      try {
        await fetch("https://metrics.example.com/turns", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.METRICS_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            outcome: event.data.outcome,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        console.warn("metrics report failed", error);
      }
      const sandbox = await ctx.getSandbox();
      await sandbox.stop();
    },
  },
});
```

- Setup in `prepare` is captured in a snapshot when `eve build` runs, so sessions don't repeat it. Setup after `open()` runs in each new session. `open()` options such as `resources` apply when a session's sandbox is created.
- `defineParentSandbox()` makes a subagent work in its parent's sandbox, files included, instead of opening its own.
- `turn.settled` fires after every turn. Catch errors from optional work such as metrics, so an outage can't fail the turn or skip the cleanup after it. `stop()` releases compute but keeps the files; the next access resumes the sandbox. `getSandbox()` opens the sandbox if the session hasn't yet, so stop unconditionally only when turns use it anyway, as a GitHub agent's checkout does.
- Capturing the snapshot needs Vercel credentials, which deployments on Vercel provide. Keep `"build": "eve build"` in `package.json`. To check a build locally without credentials, run `npx eve build --skip-sandbox-prewarm` instead of changing the script.

See [Sandbox](./sandbox/index.mdx), [Vercel Sandbox](./sandbox/vercel.mdx), and [Hooks](./guides/hooks.md).

## Remember facts across conversations

```ts title="agent/memory/preferences.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Each person's preferences, such as tone and formatting.",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

`byPrincipal` gives each authenticated caller their own memory across conversations, so people never see each other's. All `localDev()` callers share one principal, and so one memory. A fixed string such as `scope: "team"` gives everyone one shared memory instead. See [Memory](./memory/overview.mdx) and [Multi-Tenant Memory](./patterns/multi-tenant-memory.md).

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

Run it with `npx eve eval order-lookup`. Stubs replace the tool's `execute`, so the eval never calls the real API. Stubbed sessions need `allowToolStubs: true` from the channel's auth, as the [SSO snippet](#protect-the-http-api-with-your-sso) grants in local development. See [Evals](./evals/overview.mdx) and [Tool Stubs](./evals/tool-stubs.mdx).
