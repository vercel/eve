import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import { cacheLife } from "next/cache";
import type { ComponentProps, JSX } from "react";
import {
  IconAgents,
  IconClock,
  IconFileText,
  IconLinked,
  IconMessage,
  IconSandbox,
  IconSparkles,
  IconWorkflow,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import { cn } from "@/lib/utils";
import { FileTreeView } from "./file-tree-view";

interface Snippet {
  /** Category name shown in the left "Configure your agent" column. */
  label: string;
  /** File/folder name shown in the IDE file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  lang: string;
  /** Category icon for the left column. */
  NavIcon: (props: { size?: number; className?: string }) => JSX.Element;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  code: string;
  /** For a dynamic file: what it resolves to for each example tenant. */
  tenants?: Tenant[];
  /** For a dynamic file: the 1-based lines of each plan's branch, tinted in its badge color. */
  planLines?: { enterprise: number[]; hobby: number[] };
}

interface Tenant {
  name: string;
  plan: string;
  result: string;
}

// A support agent authored as a folder: every file is static, and each one is optional
// except instructions.md.
const snippets: Snippet[] = [
  {
    label: "Instructions",
    name: "instructions.md",
    fileName: "instructions.md",
    lang: "markdown",
    NavIcon: IconFileText,
    description:
      "An instructions.md file is a complete agent. Describe its role in Markdown, then run eve.",
    code: `# Identity

You are a support agent.
Answer customer questions, look up
their orders, and escalate anything
you can't resolve.`,
  },
  {
    label: "Agent",
    name: "agent.ts",
    fileName: "agent.ts",
    lang: "typescript",
    NavIcon: IconSparkles,
    description:
      "eve uses a default model. Add agent.ts when you want to choose a model or configure the runtime.",
    code: `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});`,
  },
  {
    label: "Skills",
    name: "skills/",
    fileName: "skills/refunds.md",
    lang: "markdown",
    NavIcon: IconWrench,
    description:
      "Skills are Markdown playbooks loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.",
    code: `---
name: refunds
description: Handle refund requests
---

Check the order date first. Refund
within 30 days; otherwise offer
store credit.`,
  },
  {
    label: "Tools",
    name: "tools/",
    fileName: "tools/lookup_order.ts",
    lang: "typescript",
    NavIcon: IconWorkflow,
    description:
      "Drop a TypeScript file in tools/ and the model can call it — the filename becomes the tool name, no registration required.",
    code: `import { defineTool } from "eve/tools";
import z from "zod";

export default defineTool({
  description: "Look up an order by ID",
  inputSchema: z.object({
    orderId: z.string(),
  }),
  async execute(input) {
    const res = await fetch(
      \`\${process.env.ORDERS_API_URL}/orders/\${input.orderId}\`
    );
    return res.json();
  },
});`,
  },
  {
    label: "Sandbox",
    name: "sandbox/",
    fileName: "sandbox/sandbox.ts",
    lang: "typescript",
    NavIcon: IconSandbox,
    description:
      "Every agent includes an isolated sandbox. Add sandbox/sandbox.ts to swap in any backend or customize its setup.",
    code: `import { DefaultSandbox,
  defineSandbox } from "eve/sandbox";

export const environment =
  DefaultSandbox.environment({
    prepare: async (sandbox) => {
      await sandbox.run({
        command: "git clone support-runbooks /workspace"
      });
    }
  });

export default defineSandbox(() =>
  environment.open()
);`,
  },
  {
    label: "Channels",
    name: "channels/",
    fileName: "channels/slack.ts",
    lang: "typescript",
    NavIcon: IconMessage,
    description:
      "Add channel files to answer customers in Slack, Discord, Teams, or the web with the same agent.",
    code: `import { slackChannel } from
  "eve/channels/slack";

export default slackChannel({
  botName: "acme-support",
});`,
  },
  {
    label: "Connections",
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    NavIcon: IconLinked,
    description:
      "Connections handle auth for services like Linear, GitHub, and Stripe, so the agent can file a bug for a support issue without managing tokens.",
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    label: "Sub Agents",
    name: "subagents/",
    fileName: "subagents/billing/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
    description:
      "Add subagents for specialized work. The support agent hands billing questions to a billing specialist and uses its answer.",
    code: `import { defineAgent } from
  "eve";

export default defineAgent({
  description: "Answer billing questions",
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});`,
  },
  {
    label: "Schedules",
    name: "schedules/",
    fileName: "schedules/daily-digest.md",
    lang: "markdown",
    NavIcon: IconClock,
    description:
      "Schedules run agents automatically for jobs like daily digests, continuing durably without an active session.",
    code: `---
cron: "0 8 * * *"
---

Post a summary of yesterday's open
tickets to the support channel.`,
  },
  {
    label: "Evals",
    name: "evals/",
    fileName: "evals/refunds/order-refund.eval.ts",
    lang: "typescript",
    NavIcon: IconFileText,
    description:
      "Evals run the agent through real sessions and score the result, so you can catch regressions as it evolves.",
    code: `import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  async test(t) {
    const turn = await t.send("Can I get a refund for order 1042?");
    t.succeeded();
    t.check(turn.message, includes("refund"));
  },
});`,
  },
];

// The same agent made multi-tenant: a support agent whose files are defineDynamic functions,
// so enterprise customers get faster, escalated support and hobby customers get the basics.
// Each file shows what it resolves to for one customer on each plan.
const ACME = { name: "Acme", plan: "Enterprise" };
const JAMIE = { name: "Jamie", plan: "Hobby" };

const tenantSnippets: Snippet[] = [
  {
    label: "Instructions",
    name: "instructions/support.ts",
    fileName: "instructions/support.ts",
    lang: "typescript",
    NavIcon: IconFileText,
    description:
      "Tell the agent how to support each customer. Enterprise customers get a one-hour SLA; hobby customers start with the docs.",
    code: `import { defineDynamic, defineInstructions }
  from "eve/instructions";

export default defineDynamic((ctx) => {
  const plan =
    ctx.session.auth.current?.attributes.plan;
  return defineInstructions({
    content: plan === "enterprise"
      ? "Reply within the 1-hour SLA. Escalate anything you can't resolve."
      : "Point to the docs and community forum first.",
  });
});`,
    planLines: { enterprise: [9], hobby: [10] },
    tenants: [
      { ...ACME, result: "1-hour SLA, escalate when stuck" },
      { ...JAMIE, result: "Docs and community first" },
    ],
  },
  {
    label: "Agent",
    name: "agent.ts",
    fileName: "agent.ts",
    lang: "typescript",
    NavIcon: IconSparkles,
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
    planLines: { enterprise: [7], hobby: [8] },
    tenants: [
      { ...ACME, result: "Larger model" },
      { ...JAMIE, result: "Default model" },
    ],
  },
  {
    label: "Sub Agents",
    name: "subagents/escalation/",
    fileName: "subagents/escalation/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
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
    planLines: { enterprise: [6, 7, 8, 9], hobby: [10] },
    tenants: [
      { ...ACME, result: "Second-level support engineer" },
      { ...JAMIE, result: "None" },
    ],
  },
  {
    label: "Tools",
    name: "tools/page_on_call.ts",
    fileName: "tools/page_on_call.ts",
    lang: "typescript",
    NavIcon: IconWorkflow,
    description: "Let the agent page the on-call engineer, but only for enterprise customers.",
    code: `import { defineDynamic, defineTool }
  from "eve/tools";
import { z } from "zod";
import { pageOnCall } from "../lib/pager";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes
    .plan === "enterprise"
    ? defineTool({
        description: "Page the on-call engineer.",
        inputSchema: z.object({ summary: z.string() }),
        execute: ({ summary }) => pageOnCall(summary),
      })
    : null,
);`,
    planLines: { enterprise: [9, 10, 11, 12, 13], hobby: [14] },
    tenants: [
      { ...ACME, result: "Can page on-call" },
      { ...JAMIE, result: "None" },
    ],
  },
];

export async function FileTree() {
  "use cache";
  cacheLife("max");

  const toItems = async (list: Snippet[]) => {
    const rendered = await Promise.all(
      list.map((snippet) =>
        highlight(snippet.code, {
          lang: snippet.lang,
          theme: geistShikiTheme,
          transformers: [
            {
              line(node, line) {
                const { enterprise = [], hobby = [] } = snippet.planLines ?? {};
                if (enterprise.includes(line)) node.properties["data-plan"] = "enterprise";
                else if (hobby.includes(line)) node.properties["data-plan"] = "hobby";
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
                  "[&_pre]:overflow-x-hidden! [&_code]:w-full! [&_code]:min-w-0! [&_code]:[grid-template-columns:minmax(0,1fr)]! [&_.line]:whitespace-pre-wrap [&_.line]:[overflow-wrap:anywhere]",
                  // Each plan's branch in a multi-tenant file, tinted like its plan badge and marked on
                  // the left the way Geist code blocks mark a highlighted line.
                  "[&_.line[data-plan=enterprise]]:bg-purple-100 [&_.line[data-plan=enterprise]]:shadow-[inset_2px_0_0_0_var(--ds-purple-800)] [&_.line[data-plan=hobby]]:bg-gray-100 [&_.line[data-plan=hobby]]:shadow-[inset_2px_0_0_0_var(--ds-gray-800)]",
                )}
              >
                {children}
              </CodeBlock>
            ),
          },
        }),
      ),
    );

    return list.map((snippet, i) => ({
      label: snippet.label,
      name: snippet.name,
      fileName: snippet.fileName,
      description: snippet.description,
      navIcon: <snippet.NavIcon className="shrink-0" size={16} />,
      code: rendered[i],
      tenants: snippet.tenants,
    }));
  };

  const [folderItems, tenantItems] = await Promise.all([
    toItems(snippets),
    toItems(tenantSnippets),
  ]);

  return <FileTreeView folderItems={folderItems} tenantItems={tenantItems} />;
}
