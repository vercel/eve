import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import { cacheLife } from "next/cache";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { FileTreeView, type PlanResults } from "./file-tree-view";

interface Snippet {
  /** File or folder name shown in the file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  lang: string;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  code: string;
  /** A dynamic file: what it gives each plan, with null where the plan doesn't get it. */
  results?: PlanResults;
  /** A dynamic file: the 1-based lines of each plan's branch. */
  planLines?: { enterprise: number[]; pro: number[] };
}

// One support agent, authored as a folder. Most files are static and the same for every
// customer; the defineDynamic ones resolve per customer, so enterprise customers get a
// one-hour SLA, a larger model, second-level support, and on-call paging.
const snippets: Snippet[] = [
  {
    name: "instructions.md",
    fileName: "instructions.md",
    lang: "markdown",
    description:
      "An instructions.md file is a complete agent. Describe its role in Markdown, then run eve.",
    code: `# Identity

You are a support agent.
Answer customer questions, look up
their orders, and escalate anything
you can't resolve.`,
  },
  {
    name: "instructions/sla.ts",
    fileName: "instructions/sla.ts",
    lang: "typescript",
    description:
      "Add instructions that depend on the customer. Enterprise customers get a one-hour SLA, and Pro customers get a reply within a business day.",
    code: `import { defineDynamic, defineInstructions }
  from "eve/instructions";

export default defineDynamic((ctx) => {
  const plan =
    ctx.session.auth.current?.attributes.plan;
  return defineInstructions({
    content: plan === "enterprise"
      ? "Reply within the 1-hour SLA. Escalate anything you can't resolve."
      : "Reply within one business day.",
  });
});`,
    results: { enterprise: "1-hour SLA, escalate when stuck", pro: "Reply within a business day" },
    planLines: { enterprise: [9], pro: [10] },
  },
  {
    name: "agent.ts",
    fileName: "agent.ts",
    lang: "typescript",
    description: "Choose the model per customer: a larger model for enterprise conversations.",
    code: `import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic((ctx) =>
    ctx.session.auth.current?.attributes
      .plan === "enterprise"
      ? "openai/gpt-6-luna-fast"
      : "zai/glm-5.2",
  ),
});`,
    results: { enterprise: "Larger model", pro: "Default model" },
    planLines: { enterprise: [7], pro: [8] },
  },
  {
    name: "skills/",
    fileName: "skills/refunds.md",
    lang: "markdown",
    description:
      "Skills are Markdown playbooks loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.",
    code: `---
name: refunds
description: Handle refund requests
---

Check the order date first. Refund
within 30 days. After that, offer
store credit.`,
  },
  {
    name: "tools/",
    fileName: "tools/lookup_order.ts",
    lang: "typescript",
    description:
      "Drop a TypeScript file in tools/ and the model can call it. The filename becomes the tool name, no registration required.",
    code: `import { defineTool } from "eve/tools";
import z from "zod";

export default defineTool({
  description: "Look up an order by ID",
  inputSchema: z.object({ orderId: z.string() }),
  async execute(input) {
    const res = await fetch(
      \`\${process.env.ORDERS_API_URL}/orders/\${input.orderId}\`
    );
    return res.json();
  },
});`,
  },
  {
    name: "tools/page_on_call.ts",
    fileName: "tools/page_on_call.ts",
    lang: "typescript",
    description: "Let the agent page the on-call engineer, but only for enterprise customers.",
    code: `import { defineDynamic, defineTool }
  from "eve/tools";
import { z } from "zod";
import { pageOnCall } from "../lib/pager";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes.plan === "enterprise"
    ? defineTool({
        description: "Page the on-call engineer.",
        inputSchema: z.object({ summary: z.string() }),
        execute: ({ summary }) => pageOnCall(summary),
      })
    : null,
);`,
    results: { enterprise: "Can page on-call", pro: null },
    planLines: { enterprise: [8, 9, 10, 11, 12], pro: [13] },
  },
  {
    name: "channels/",
    fileName: "channels/slack.ts",
    lang: "typescript",
    description:
      "Add channel files to answer customers in Slack, Discord, Teams, or the web with the same agent.",
    code: `import { slackChannel } from "eve/channels/slack";

export default slackChannel();`,
  },
  {
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    description:
      "Connections handle auth for services like Linear, GitHub, and Stripe, so the agent can file a bug for a support issue without managing tokens.",
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    name: "subagents/",
    fileName: "subagents/billing/agent.ts",
    lang: "typescript",
    description:
      "Add subagents for specialized work. The support agent hands billing questions to a billing specialist and uses its answer.",
    code: `import { defineAgent } from "eve";

export default defineAgent({
  description: "Answer billing questions",
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});`,
  },
  {
    name: "subagents/escalation/",
    fileName: "subagents/escalation/agent.ts",
    lang: "typescript",
    description:
      "Give enterprise customers second-level support: a specialist the agent hands hard cases to.",
    code: `import { defineAgent, defineDynamic } from "eve";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes
    .plan === "enterprise"
    ? defineAgent({
        description: "Second-level support engineer.",
        model: ctx.model.id,
      })
    : null,
);`,
    results: { enterprise: "Second-level support engineer", pro: null },
    planLines: { enterprise: [6, 7, 8, 9], pro: [10] },
  },
  {
    name: "schedules/",
    fileName: "schedules/daily-digest.md",
    lang: "markdown",
    description:
      "Schedules run agents automatically for jobs like daily digests, continuing durably without an active session.",
    code: `---
cron: "0 8 * * *"
---

Post a summary of yesterday's open
tickets to the support channel.`,
  },
];

export async function FileTree() {
  "use cache";
  cacheLife("max");

  const rendered = await Promise.all(
    snippets.map((snippet) =>
      highlight(snippet.code, {
        lang: snippet.lang,
        theme: geistShikiTheme,
        // Tag each plan's branch so the view can highlight the customer it shows.
        transformers: [
          {
            line(node, line) {
              const { enterprise = [], pro = [] } = snippet.planLines ?? {};
              if (enterprise.includes(line)) node.properties["data-plan"] = "enterprise";
              else if (pro.includes(line)) node.properties["data-plan"] = "pro";
            },
          },
        ],
        components: {
          pre: ({ children, ...props }: ComponentProps<"pre">) => (
            <CodeBlock
              {...props}
              data-line-numbers="true"
              className={cn(
                props.className,
                // Sit flush in the panel: drop the CodeBlock's own margin, padding,
                // and the border on its inner content section.
                "my-0 rounded-none border-0 bg-transparent p-0 [&>[data-section=content]]:rounded-none [&>[data-section=content]]:border-0",
                "[&_.line]:before:!mr-4 [&_.line]:before:!w-5 [&_.line]:before:!text-left",
                // Wrap long lines instead of scrolling horizontally (keep the
                // line-number grid, just constrain its column so lines wrap).
                "[&_pre]:overflow-x-hidden! [&_code]:w-full! [&_code]:min-w-0! [&_code]:[grid-template-columns:minmax(0,1fr)]! [&_.line]:w-full! [&_.line]:h-auto! [&_.line]:whitespace-pre-wrap [&_.line]:[overflow-wrap:anywhere]",
              )}
            >
              {children}
            </CodeBlock>
          ),
        },
      }),
    ),
  );

  const items = snippets.map((snippet, i) => ({
    name: snippet.name,
    fileName: snippet.fileName,
    description: snippet.description,
    code: rendered[i],
    results: snippet.results,
  }));

  return <FileTreeView items={items} />;
}
