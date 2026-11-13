# ARCHITECTURE.md

This document maps how the agent is put together, for humans and AI agents working in the repo. Keep it current as the codebase evolves.

## Project identification

- **Name:** `marketing-team-eve-template`
- **Maintainer:** Vercel Labs
- **License:** MIT
- **Last updated:** 2026-11-12

## Overview

Marketing agents arranged as a hierarchy on the [eve](https://eve.dev) framework. The root **lead** grounds itself in a shared brand context document and this person's saved preferences, then routes the request to exactly one specialist. `product-marketer` owns positioning: the competitive alternatives, the segment, the message hierarchy, and the shared brand context document itself. `content-marketer` owns long-form: content planning by buyer stage, then blog posts, landing pages, case studies, newsletters, and docs, written into Notion rather than handed back as chat text. `social-media-coordinator` owns short-form: posts and threads for X, LinkedIn, Threads, Bluesky, and Mastodon, plus the Typefully queue and Notion briefs. `seo` owns organic search: page and site audits, hierarchy and internal linking, JSON-LD schema, and templated page sets. `email` owns the email channel: taking copy that already exists, reworking it to survive an inbox, then building, targeting, and sending it in Resend. No specialist delegates further: each gathers its own evidence with the framework's `web_search` and `web_fetch`, and the ones that touch prose run their own review pass against the editing rubrics before handing work back. Shared state (brand context, per-user preferences, assets) lives in Vercel Blob.

The five specialists do not overlap by accident. `product-marketer` decides what the team claims, `content-marketer` writes the words, `seo` decides which pages should exist and whether one is findable, and `social-media-coordinator` and `email` are the two that can put something in front of an audience. Where their guidance touches the same number, such as title length or internal-link counts, the specs are kept in agreement rather than duplicated silently.

`content-marketer` and `email` are the pair most likely to blur, so the split is by job rather than by artifact: the content marketer authors the prose, and the email agent adapts it and operates the channel. A newsletter is therefore two hops, and the lead chains them with an artifact id or a Notion link rather than briefing both. The email agent's own writing work is the email-fit pass (subject and preview text, one call to action, the plain text version, link and alt text hygiene), never a draft from nothing.

The dependency runs one way. The product marketer writes the brand context document, and the other four read it at the start of every task. That makes it the one piece of shared state whose quality bounds everything else, which is why one specialist owns authoring it and its structure is a skill rather than a convention.

There is no central registry or wiring file: a tool's name is its filename, a subagent's name is its directory name, a connection's name is its filename, and a skill's name is its directory name. eve walks `agent/` at build time and produces a manifest from what it finds. Adding a specialist means adding a directory; removing one means deleting it. `npx eve info` prints the resulting surface.

## Project structure

```text
agent/
  agent.ts                          # lead: model, compaction threshold, defaultTools off, memory-removal gate
  instructions.md                   # lead behavior: ground, route once with a full brief, hand back
  channels/
    eve.ts                          # inbound route for the TUI and your own front end
    slack.ts                        # inbound route for Slack, credentials via Vercel Connect
  memory/
    preferences.ts                  # per-person standing preferences (eve file memory, user principals only)
  tools/
    get_brand_context.ts            # read the team's shared product/positioning/voice document
    save_brand_context.ts           # overwrite it (no approval gate)
    read_artifact.ts                # read a handoff artifact by id, on request
    workflow.ts                     # run several specialists as one durable, model-written program
  lib/                              # shared typed helpers; imported as #lib/<domain>/<file>.js
    vercel-blob/{config,tools}.ts   # Blob key layout, reserved-prefix guards, 5 asset tool factories
    brand-context/{config,tools}.ts # brand context key + size cap, get/save tool factories
    models/config.ts                # every model id, one constant per role
    mock-model/config.ts            # EVE_MOCK_MODEL switch + the scripted mock for offline evals
    slack/config.ts                 # Slack connector credentials + the message-to-identity rules
    notion/connection.ts            # the shared Notion connection, notionConnection()
    content/{config,tools}.ts       # banned-words match helpers + judgment rules, lintAgainstStyleTool(listsBySurface)
    decisions/config.ts             # uncertain band and judgeRules() over the decision model (no tools)
    email/{config,tools}.ts         # pre-send copy patterns + rules, checkSendReadinessTool()
    artifacts/{config,tools}.ts     # artifact key layout + id format, save/readArtifactTool()
    tracking/{config,tools}.ts      # campaign-tag vocabulary, buildTrackedLinkTool(surfaces)
    writing-quality/{config,skill}.ts # the shared prose-rules skill, used by every prose agent
  subagents/
    product-marketer/
      agent.ts  instructions.md     # interview, position, then write the shared document
      sandbox.ts                    # its own sandbox; subagents inherit nothing
      connections/notion.ts         # Notion MCP: search, read, edit pages and databases
      skills/positioning/           # alternatives, segment, differentiators, statement
      skills/messaging/             # hierarchy, value props per audience, objections, grades
      skills/customer-research/     # interview questions, mining customers' own words
      skills/brand-context/         # the shared document's structure and merge rules
      skills/writing-quality.ts     # surface-independent prose rules (shared from lib)
      tools/                        # 5 asset tools, get/save_brand_context, save/read_artifact,
                                    #   ask_question, read_file, web_fetch, web_search
    social-media-coordinator/
      agent.ts  instructions.md     # short-form drafting, platform fit, queue management
      sandbox.ts                    # its own sandbox; subagents inherit nothing
      connections/typefully.ts      # Typefully MCP: read/create/edit drafts, schedule, analytics
      connections/notion.ts         # Notion MCP: search, read, edit pages and databases
      skills/x-style/               # per-surface voice, specs, and banned-words list
      skills/linkedin-style/
      skills/threads-style/
      skills/bluesky-style/
      skills/mastodon-style/
      skills/writing-quality.ts     # surface-independent prose rules (shared from lib)
      tools/                        # 5 asset tools, get_brand_context, lint_against_style,
                                    #   build_tracked_link, post_analytics_report,
                                    #   save/read_artifact, ask_question, read_file, web_fetch, web_search
    content-marketer/
      agent.ts  instructions.md     # planning then drafting long-form
      sandbox.ts                    # its own sandbox; subagents inherit nothing
      connections/notion.ts         # Notion MCP: the finished piece is written here
      skills/blog-style/            # blog voice, format specs, banned words
      skills/content-planning/      # buyer stages, pillars and clusters
      skills/content-editing/       # editing in separate passes
      skills/writing-quality.ts     # surface-independent prose rules (shared from lib)
      tools/                        # 5 asset tools, get_brand_context, lint_against_style,
                                    #   save/read_artifact, ask_question, read_file, web_fetch, web_search
    seo/
      agent.ts  instructions.md     # audit what it can see, plan what should exist
      sandbox.ts                    # its own sandbox; subagents inherit nothing
      connections/notion.ts         # Notion MCP: search, read, edit pages and databases
      skills/seo-audit/             # priority-ordered checks, marked fetch vs tool-only
      skills/site-architecture/     # hierarchy, URL patterns, navigation, internal linking
      skills/schema/                # JSON-LD per type, plus validation
      skills/programmatic-seo/      # 12 patterns, data defensibility, thin-content failure
      skills/writing-quality.ts     # surface-independent prose rules (shared from lib)
      tools/                        # 5 asset tools, get_brand_context, validate_schema, save/read_artifact,
                                    #   ask_question, read_file, web_fetch, web_search
    email/
      agent.ts  instructions.md     # adapt copy for the inbox, then build and send in Resend
      sandbox.ts                    # its own sandbox; subagents inherit nothing
      connections/resend.ts         # Resend MCP: allow-listed; sends and deletes gated
      connections/notion.ts         # Notion MCP: reads the piece the content marketer wrote
      skills/email-style/           # inbox voice, sourced format limits, banned words
      skills/email-adaptation/      # what to cut, pointer vs whole-thing, per-type patterns
      skills/deliverability/        # checks marked by the tool that verifies them, or none;
                                    #   plus the legal gate (postal address, consent, opt-out)
      skills/resend-build/          # tool order, the compose/html mode trap, the send gate
      skills/writing-quality.ts     # surface-independent prose rules (shared from lib)
      tools/                        # 5 asset tools, get_brand_context, lint_against_style,
                                    #   check_send_readiness, build_tracked_link, save/read_artifact, ask_question,
                                    #   read_file, web_fetch, web_search
```

## Core components

| Component | Lives in | eve primitive | Responsibility |
| --- | --- | --- | --- |
| eve channel | `agent/channels/eve.ts` | channel | Inbound route for the dev TUI and your own front end. Its auth chain is a `localDev()` shim that upgrades a trusted local caller to a `user` principal, then `vercelOidc()` for deployed callers. |
| Slack channel | `agent/channels/slack.ts` | channel | Inbound route for Slack. Answers mentions and DMs, and auto-replies to un-mentioned messages only in a subscribed thread whose original requester is still the sole human participant. Credentials and webhook verification come from Vercel Connect. |
| Lead runtime | `agent/agent.ts`, `agent/instructions.md` | agent | Loads brand context, has the person's saved preferences recalled into each turn, picks one specialist, writes the brief, returns the specialist's work without rewriting it. Runs the same model as the specialists; it routes rather than produces, so a cheaper tier here is the first cost lever to reach for. It sets `defaultTools: false` and adds nothing back, so it has no shell, file, or web tools. |
| Shared state tools | `agent/tools/*.ts` + `lib/brand-context` | tools | Read and write the team-wide brand context in Blob. |
| Preferences | `agent/memory/preferences.ts` | memory | eve file memory scoped to the resolved principal, for `user` principals only. eve recalls the document into each of the lead's turns, and the model edits it with `preferences__save_memory` and `preferences__remove_memory`. Removal pauses for approval through the agent-level policy in `agent/agent.ts`. |
| Slack identity | `lib/slack/config.ts` | helper | Pure functions that turn a Slack message into session auth. A message with no identifiable sender gets no identity. A bot post is attributed to a person it mentions only when the bot is listed in `SLACK_ON_BEHALF_OF_BOTS`. |
| Social media coordinator | `agent/subagents/social-media-coordinator/` | subagent | Drafts short-form for five platforms, drives the Typefully queue, reads and writes Notion. Owns six skills. |
| Product marketer | `agent/subagents/product-marketer/` | subagent | Interviews the user, researches the competitive set, decides positioning and messaging, then writes the shared brand context document. The only specialist whose deliverable is that document rather than a piece of work. Owns five skills and a sandbox. Grades every claim `proven`, `plausible`, or `assumption`, so downstream agents know when to hedge. Does not draft posts, pages, or campaigns. |
| Content marketer | `agent/subagents/content-marketer/` | subagent | Plans content by buyer stage, then drafts long-form. Owns four skills and a sandbox. Does not publish, schedule, or touch social accounts. |
| SEO | `agent/subagents/seo/` | subagent | Audits a page against what a fetch can actually show, plans hierarchy, URLs and internal linking, writes JSON-LD, and scopes templated page sets. Owns five skills and a sandbox. Recommends titles, meta descriptions, and slugs; hands body copy to the content marketer. Has no crawler, rank tracker, or Search Console, and says so instead of inferring. |
| Email | `agent/subagents/email/` | subagent | Takes copy the content marketer (or the user) already wrote, reworks it for an inbox, then builds the template or broadcast in Resend, picks a verified from address, targets the segment, and reports delivery. Owns five skills and a sandbox. Does not originate long-form prose, and says so rather than producing a thin version of it. Cannot see inbox placement or domain reputation, and marks every deliverability check with the tool that verifies it. |
| Typefully connection | `.../connections/typefully.ts` | connection | Remote MCP, static workspace API key. Discovery is narrowed by `tools.allow`. Deletes and a change to the queue schedule always pause for approval; create and edit pause unless the call is recognizably a plain draft with no publish time. |
| Resend connection | `.../email/connections/resend.ts` | connection | Remote MCP, user-scoped OAuth through Vercel Connect, the same as Notion. `tools.allow` cuts around 85 published tools to the 47 that make up the campaign, list, diagnostic, and read-only-domain surface, leaving out API keys, webhooks, and domain writes entirely. Sends (`send-broadcast`, `send-email`, `send-batch-emails`) and destructive calls always pause for approval, scheduled or not, since Resend splits composing from committing into separate tools. The connector issues only `user` tokens, so sends are attributed to the person who approved them. |
| Notion connection | `agent/connections/notion.ts` and one per specialist | connection | Remote MCP, user-scoped OAuth, defined once in `lib/notion/connection.ts` and called from a one-line file per agent. Page edits, moves, data source updates, and view changes pause for approval; page creation is deliberately ungated, since drafting into Notion is the normal flow. |
| Asset tools | `lib/vercel-blob/tools.ts`, wired per agent | tools | Upload, list, inspect, download, and delete Blob assets. Deletes pause for approval; every reserved prefix (brand context, file memory, artifacts) is refused. |
| Style lint | `lib/content/tools.ts` | tool factory | Reads `references/banned-words.json` from the calling agent's `<surface>-style` skill and returns `{ ok, violations, checks, judged }`: the banned-words hits, plus a decision-model verdict on AI-sounding phrasing and plain English judged against the `writing-quality` references. The coordinator passes five surfaces; the content marketer passes `blog`; the email agent passes `email`. |
| Pre-send copy check | `lib/email/` | tool factory | `check_send_readiness` reads the final subject and body before a send goes for approval. Pattern checks cover the unsubscribe placeholder, name fallbacks, and the plain text version; a decision model judges the postal address, the opt-out notice, advertisement identification, and the subject. It reads copy only and never calls Resend, and it returns rows rather than a verdict, so the approval stays with the user. |
| Decision model | `lib/decisions/config.ts` | helper | `judgeRules()` asks a decision model yes/no rules through `decide` from `eve/ai` and maps each probability to `pass`, `fail`, or `unsure`. It fails open: an unavailable model returns nothing, and the calling tool still reports its deterministic checks. |
| Lead workflow | `agent/tools/workflow.ts` | workflow tool | eve's model-authored `workflow` tool. The lead writes a short program that calls specialists in order and passes one reply into the next brief, as a durable run that waits through a specialist's approval prompt. |
| Handoff artifacts | `lib/artifacts/` | tool factories | `save_artifact` writes a Markdown document to Blob under the reserved `artifacts/` prefix and returns an id; `read_artifact` reads it back by key. The store is private, and the tools hand back an id, never a URL. All five specialists hold both. The lead holds only the reader, so a long document can be relayed between specialists by id without passing through the lead's context. This is also the main channel from the content marketer to the email agent. |
| Campaign tracking | `lib/tracking/` | tool factory | `build_tracked_link` adds `utm_*` parameters to a batch of links, deriving source and medium from the surface and normalizing the campaign name, so one campaign doesn't arrive in analytics as several spellings. Held by the coordinator and the email agent. Deliberately not on links between pages of your own site. |
| Writing quality | `lib/writing-quality/skill.ts` | skill factory | The surface-independent prose rules and their two reference lists, defined once and called from a one-line `skills/writing-quality.ts` in each agent that drafts or edits prose. `defineSkill` materializes the references as real sibling files, so the compiled package matches an authored directory. |

The two channels are the only inbound boundary. Outbound, the agents reach Blob, the three MCP servers, the open web through `web_search` and `web_fetch`, the Slack Web API from `post_analytics_report`, and the AI Gateway for the models. Everything else is model reasoning over loaded skills. Each specialist call starts a fresh session with none of the lead's conversation, skills, connections, or sandbox, so the lead's job is to write a complete `message`. The tree is one level deep: the lead delegates, and specialists do not.

## Data flow

```text
you
 └─ eve channel (resolve principal)
     └─ lead
         ├─ saved preferences                                (file memory, recalled each turn)
         ├─ get_brand_context                                (Blob read)
         ├─ save_brand_context / preferences__save_memory    (Blob write, ungated)
         ├─ preferences__remove_memory                       (pauses for approval)
         └─ one specialist, briefed in full
             ├─ get_brand_context                           (Blob read, again: fresh context)
             ├─ save_brand_context                          (product-marketer: its deliverable)
             ├─ eve__skill <surface>-style, writing-quality  (sandbox materializes references/)
             ├─ eve__skill positioning, messaging, ...        (product-marketer only)
             ├─ eve__skill seo-audit, schema, ...            (seo only)
             ├─ web_fetch a page under review                (seo only: server HTML, no JS)
             ├─ web_search / web_fetch                       (own research, source-budgeted)
             ├─ lint_against_style                           (banned words + decision-model rules)
             ├─ save_artifact -> id                          (long output, private Blob)
             ├─ read_artifact <id>                           (an artifact the brief named)
             ├─ eve__skill content-editing, writing-quality   (own review pass before handback)
             ├─ eve__skill email-adaptation, resend-build     (email only)
             ├─ notion MCP tools, via eve__search / eve__tool (content-marketer: writes the page)
             ├─ typefully MCP tools                          (approval on scheduling and deletes)
             ├─ resend MCP tools                             (email only: allow-listed surface,
             │                                                 approval on every send and delete)
             └─ asset tools                                  (Blob)
```

A newsletter is the one request that routes twice. The lead calls `content-marketer`, which writes the piece into Notion and hands back a link (or saves an artifact and hands back an id), and the lead puts that into `email`'s brief. The email agent opens it, runs the email-fit pass, builds the broadcast, and stops at the approval gate.

## Data stores

- **Vercel Blob**: the only persistent store, and it is private. Every object is written with `access: "private"` and read through the SDK with the project's credentials, so a Blob URL is an identifier for the asset tools and not a link. Four namespaces: the team's shared brand context document under a reserved prefix (capped at 20,000 characters), eve file memory under `eve/memory/`, handoff artifacts under a reserved `artifacts/` prefix (capped at 200,000 characters), and free-form assets everywhere else. The general asset tools refuse every reserved prefix, including the retired `user-preferences/`, so they can't read or overwrite state as a side channel. A deployment made from an earlier version of this template has a public store and needs a new private one; existing files are not migrated.
- **Notion**: the workspace the specialists read and write through MCP, and where the content marketer's finished pieces live. Owned by the user, not this project.
- **Typefully**: the social draft and schedule queue, reached through MCP.
- **Resend**: the email campaigns, templates, contacts, segments, and delivery records, reached through MCP. Owned by the user, not this project, and the only outbound integration whose writes reach people directly.
- **Session state**: eve manages conversation state per session; compaction kicks in at 90% of the window for the lead and for every specialist.

There is no application database.

## External integrations

| Integration | Purpose | Method |
| --- | --- | --- |
| Vercel AI Gateway | model access for every agent | ambient project credentials; models are plain gateway strings, all declared in `agent/lib/models/config.ts` |
| Vercel Blob | brand context, file memory, artifacts, assets | `@vercel/blob` SDK, private access |
| Notion | briefs, calendars, and the finished long-form pieces | remote MCP at `mcp.notion.com`, user-scoped OAuth through Vercel Connect |
| Typefully | social drafts, scheduling, post and follower analytics | remote MCP at `mcp.typefully.com`, static workspace API key |
| Resend | email campaigns, templates, contacts and segments, delivery records | remote MCP at `mcp.resend.com`, user-scoped OAuth through Vercel Connect, discovery narrowed by `tools.allow` |
| Vercel Sandbox | materializes each skill's `references/` files, read with `read_file` | `VercelSandbox.environment()`, opened by `defineSandbox(() => environment.open())` |
| Open web | research and fact-checking | `web_search` and `web_fetch`, added back in each specialist; there is no shell, so fetching goes through `web_fetch` |

## Deployment & infrastructure

- **Platform:** Vercel. `eve deploy` for production; `eve build` produces the bundle and captures each agent's Vercel Sandbox snapshot, so it needs a linked project. To check that the bundle builds without one, run `npx eve build --skip-sandbox-prewarm`; that output isn't deployable.
- **Stores:** one private Vercel Blob store. Auth is the project's OIDC token, so no Blob credential is stored.
- **Connectors:** three Vercel Connect connectors, Notion (`NOTION_CONNECTOR`, defaulting to `notion/marketing-team`), Resend (`RESEND_CONNECTOR`, defaulting to `resend/marketing-team`), and Slack (`SLACK_CONNECTOR`, defaulting to `slack/marketing-team`). The Slack one needs `--triggers` and its trigger path set to `/eve/v1/slack`, which the Deploy button does; a connector created by hand with `vercel connect create` has to be re-pointed there. Blob is provisioned as a store, not a connector.
- **Environment:** `TYPEFULLY_API_KEY` is the only static credential. Notion and Resend are authorized per user in the browser and Slack is brokered by the same Connect layer, so none of them holds a secret here, and Blob and the model use the project's OIDC token. `vercel env pull` gives local runs the same environment as production. Resend also needs a verified sending domain in the workspace before anything can be sent; the agent reads that state but cannot create it.
- **Runtime:** Node 24.x, ESM, `moduleResolution: "bundler"`. `SLACK_ON_BEHALF_OF_BOTS` is an optional comma-separated list of Slack bot ids allowed to start a session for a person they mention; it is empty by default.
- **Local development:** `vercel link` then `vercel env pull`, then `pnpm dev` for the eve TUI. `/login` connects a model provider when none is found, and `/model` switches models. The sandbox only starts against a linked and authenticated Vercel project.

## Development & testing

- **Runtime/TUI:** `pnpm dev` (`eve dev`). Talk to the lead to exercise routing, and watch which specialist it picks.
- **Type checking:** `pnpm typecheck` (`tsc`; `noEmit` is set in `tsconfig.json`).
- **Lint/format:** `pnpm check` and `pnpm fix` (Ultracite / Biome, ~145 files).
- **Discovery diagnostics:** `npx eve info` prints the manifest, currently 5 subagents, 4 root tools (`get_brand_context`, `save_brand_context`, `read_artifact`, `workflow`; every optional built-in is off), and 1 root connection. Its `Skills` and `Connections` counts cover the root only, so `Skills` reads `0`: all 25 skills belong to subagents, as do the Typefully and Resend connections. Detail lands in `.eve/discovery/diagnostics.json`.
- **Offline evals:** `pnpm eval:offline` runs `evals/offline/` on mock models in a few seconds: approvals, memory, delegation, and the pure helpers (Slack identity, reserved prefixes, artifact ids, banned words, pre-send patterns).
- **Live evals:** `pnpm eval` runs `evals/live/` on real models: one routing case and one case per decision-model tool asserting `judged: true`. It needs AI Gateway credentials whose team allows the decision model's provider.
- **Everything at once:** `pnpm validate` (lint, types, discovery, and the offline evals).

The Slack channel itself, the approval prompts on the three connections, and private Blob behavior on a deployment are not covered by an eval; exercise them by hand.

## Glossary

- **eve**: Vercel's agent framework. Discovers an agent's capabilities from the filesystem and produces a deployable app.
- **Channel**: an inbound entry point plus its auth chain. This project has two, `eve` and `slack`.
- **Connection**: an MCP server the agent can call. The model finds its tools with `eve__search` and calls them with `eve__tool` by their qualified name, `<connection>__<tool>`, for example `notion__notion-create-pages`. Approval policies see the same qualified name.
- **Tool**: a typed function in the app runtime, one default export per file, named after its filename.
- **Skill**: a `SKILL.md` plus optional `references/`, loaded on demand when its frontmatter `description` matches the situation. Scoped to the agent that declares it. eve has no shared-skill mechanism, so the one shared skill, `writing-quality`, is a `defineSkill` factory in `lib/` called from each specialist.
- **Subagent**: a child agent exposed to its parent as a tool. It runs in a fresh session and inherits nothing, so the parent passes everything in `message`.
- **Principal**: the identity a channel resolves for the caller. It scopes file memory and decides whose Notion and Resend grants a session runs on.
- **Vercel Connect**: brokers per-user OAuth to third-party services, so the app holds no long-lived user tokens.
- **OIDC**: the short-lived, per-deployment token that lets the project authenticate to Vercel services such as Blob, the AI Gateway, and Sandbox without a static key.
