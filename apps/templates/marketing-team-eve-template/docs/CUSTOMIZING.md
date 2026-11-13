# Customizing

There is no registry file. A tool's name is its filename, a subagent's and skill's name is its directory name. Add a file to add a capability, delete it to remove one.

Run `pnpm validate` after any change, and `npx eve info` to see what eve discovered.

## Where to change things

| To change | Edit |
| --- | --- |
| Brand context | Ask the lead; it routes to `product-marketer`. Stored in Blob, not the repo |
| Voice, all surfaces | `agent/lib/writing-quality/config.ts` |
| Voice, one surface | `agent/subagents/<id>/skills/<surface>-style/` |
| Banned words | `references/banned-words.json` in that style skill |
| The lead's behavior | `agent/instructions.md` |
| A specialist's behavior | `agent/subagents/<id>/instructions.md` |
| Models | `agent/lib/models/config.ts`, or `/model` in the TUI |
| Approval gates | `APPROVAL_REQUIRED_TOOLS` in `agent/lib/notion/connection.ts`, `ALWAYS_GATED_TOOLS`/`PUBLISH_TOOLS` in `typefully.ts`, `SEND_TOOLS`/`DESTRUCTIVE_TOOLS` in `resend.ts` |
| Resend's and Typefully's tool surface | `ALLOWED_TOOLS` in `email/connections/resend.ts` and `social-media-coordinator/connections/typefully.ts` |
| Slack suggested prompts | `SUGGESTED_PROMPTS` in `agent/channels/slack.ts` |

## Remove what you do not use

| Not using | Delete |
| --- | --- |
| Email | `agent/subagents/email/` |
| Social | `agent/subagents/social-media-coordinator/` |
| SEO | `agent/subagents/seo/` |
| Slack | `agent/channels/slack.ts` |

No agent code references a specialist by name, so deleting the directory removes it from the team. The evals do name `seo` and `email`, so if you remove either, update or delete the cases under `evals/` that delegate to it. Keep `product-marketer`; it owns the brand context everything else reads.

## Add a specialist

Two files minimum. Copy `agent/subagents/seo/` as a starting point.

```ts
// agent/subagents/pr/agent.ts
import { defineAgent } from "eve";
import { SPECIALIST_MODEL } from "#lib/models/config.js";

export default defineAgent({
  compaction: { threshold: 0.9 },
  defaultTools: false,
  description:
    "Write and place press material: releases, media pitches, and spokesperson quotes. " +
    "Pass the announcement, the target publications, and any embargo in the message.",
  model: SPECIALIST_MODEL,
});
```

The `description` is the only thing the lead sees when routing. Add `instructions.md` next to it.

`defaultTools: false` turns off every optional built-in, so copy `read_file.ts`, `web_fetch.ts`, `web_search.ts`, and `ask_question.ts` from another specialist's `tools/` for the ones it needs. `ask_question` is the only way a specialist can ask the person something mid-task.

Subagents inherit nothing, so if it needs the brand context, a sandbox, or Notion, it needs its own copies. The tool files are one line each:

```ts
// agent/subagents/pr/tools/get_brand_context.ts
import { getBrandContextTool } from "#lib/brand-context/tools.js";

export default getBrandContextTool();
```

## Add a skill

```markdown
---
description: Use when planning outreach for backlinks or auditing a backlink profile.
---

# Link building

Keep this short. Put detail in `references/`.
```

Save as `skills/link-building/SKILL.md`. The `description` decides when it loads. Reference files need a `sandbox.ts` in that agent.

## Add a tool

Factory in `lib/`, one-line call in the agent's `tools/`. Lint rejects re-exports, so this is the only shape that passes.

```ts
// agent/lib/pr/tools.ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export const findJournalistsTool = () =>
  defineTool({
    description: "Find journalists covering a beat. Call before writing a pitch.",
    async execute({ beat }) {
      return { journalists: [] };
    },
    inputSchema: z.object({
      beat: z.string().min(1).max(200).describe("Subject area, e.g. 'developer tools'."),
    }),
    outputSchema: z.object({
      journalists: z.array(z.string()).describe("One entry per journalist found."),
    }),
  });
```

Bound every string with `.max()`, describe every field, and gate irreversible tools with `approval` from `eve/tools/approval`. Imports use `#lib/...` with a `.js` extension.

## Add a connection

```ts
// agent/subagents/pr/connections/linear.ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  auth: connect(process.env.LINEAR_CONNECTOR ?? "linear/marketing-team"),
  description: "Linear workspace: issues, projects, and comments.",
  tools: { allow: ["search_issues", "get_issue"] },
  url: "https://mcp.linear.app/mcp",
});
```

Create the connector and put the UID it prints into the env var:

```bash
vercel connect create linear --name marketing-team
```

Use `tools.allow` when the server publishes more than the job needs, and gate writes with `approval`.

## Edit the suggested prompts

The prompts Slack pins when a conversation opens are `SUGGESTED_PROMPTS` in `agent/channels/slack.ts`.

```ts
const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    message:
      "Help me plan and write our next blog post. Pull the brand context, then ask me for details about the post.",
    title: "Write a blog post",
  },
];
```

`title` is the button label and `message` is what gets sent. Slack renders the first four and drops the rest, so reorder rather than append. It sends `message` verbatim on click with no chance to edit, so each one has to be a complete sentence.

`SUGGESTED_PROMPTS_TITLE` in the same file is the heading above them.

## Gotchas

| Symptom | Fix |
| --- | --- |
| Skill missing from `eve info` | Its `description` has a colon followed by a space. Rephrase around it |
| Skill missing, no diagnostic | Its name must start with an alphanumeric character |
| `references/` unreadable | That agent needs its own `sandbox.ts` |
| Specialist can't read a skill's `references/` or search the web | `defaultTools: false` is set, so add `read_file.ts`, `web_fetch.ts`, or `web_search.ts` under its `tools/` |
| Lint rejects a tool file | Use the factory pattern, not a re-export |
| Import fails to resolve | Add the `.js` extension |
| `pnpm fix` will not fix a type | Change the `type` alias to an `interface` by hand |
| `eve info` shows 0 skills | Expected; that count is root only |

The Notion connection is defined once in `agent/lib/notion/connection.ts`. Each agent's `connections/notion.ts` is a one-line call to it, so edit the approval list there.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the component map and [`AGENTS.md`](../AGENTS.md) for agent conventions.
