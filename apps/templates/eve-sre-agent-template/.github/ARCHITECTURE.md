# Architecture

## Project identification

- Name is **eve-sre-agent-template**.
- License is MIT.
- Maintained by Vercel Labs.
- Built on the [eve](https://eve.dev) agent framework.

## Overview

sre is a Slack incident response agent. It investigates production issues with evidence from Datadog, GitHub, Slack, and Vercel. Investigations start from a Slack mention or direct message, from a watched channel message, or from a `POST /v1/investigate` webhook call. The agent records typed evidence for each finding and renders it in the Slack reply.

## Directory map

```text
agent/
  agent.ts            Model, context window, and reasoning configuration
  channels/           Trigger surfaces
    slack.ts          Mentions, DMs, and channel watch (optional)
    webhook.ts        POST /v1/investigate
    eve.ts            Local development channel
  connections/        Datadog and Vercel MCP connections
  extensions/         GitHub tools extension
  instructions/       System instructions and date context
  tools/              Evidence, Slack read, watch, and skill tools
  skills/             Built-in investigation skills
    custom.ts         Custom skills loader (optional, needs Blob)
  lib/                Shared logic
    auth.ts           Slack user auth helpers
    blob.ts           Vercel Blob object store
    evidence.ts       Investigation evidence state and rendering
    channel-watch/    Watchlist store and admission (optional, needs Blob)
    skills/           Custom skill store (optional, needs Blob)
    slack/            Message parsing and investigation rendering
    webhook/          Webhook auth, request parsing, and session logic
```

Channel watch and custom skills are optional. Both need the private Vercel Blob store. The rest of the agent works without Blob.

## Core components

| Component        | Location                    | Purpose                                               |
| ---------------- | --------------------------- | ----------------------------------------------------- |
| Agent definition | `agent/agent.ts`            | Selects the model and reasoning effort.               |
| Slack channel    | `agent/channels/slack.ts`   | Handles mentions, DMs, and watched channel messages.  |
| Webhook channel  | `agent/channels/webhook.ts` | Accepts `POST /v1/investigate` and starts Slack runs. |
| Instructions     | `agent/instructions/`       | Defines identity, rules, and tool guidance.           |
| Evidence system  | `agent/lib/evidence.ts`     | Records findings and renders them for agent and Slack replies. |
| Channel watch    | `agent/lib/channel-watch/`  | Admits top-level messages from watched channels.      |
| Custom skills    | `agent/lib/skills/`         | Stores user and global runbooks in Blob.              |
| Connectors       | `agent/lib/constants.ts`    | Resolves Slack, GitHub, Datadog, and Vercel connector UIDs. |
