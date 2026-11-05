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
}

interface Tenant {
  name: string;
  plan: string;
  result: string;
}

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

You are an expert weather assistant.
You can fetch the weather for any
city in the world.`,
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
    fileName: "skills/research.md",
    lang: "markdown",
    NavIcon: IconWrench,
    description:
      "Skills are Markdown playbooks loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.",
    code: `---
name: research
description: Research unfamiliar topics
---

When the task is novel or ambiguous,
gather evidence first, then answer.`,
  },
  {
    label: "Tools",
    name: "tools/",
    fileName: "tools/get_weather.ts",
    lang: "typescript",
    NavIcon: IconWorkflow,
    description:
      "Drop a TypeScript file in tools/ and the model can call it — the filename becomes the tool name, no registration required.",
    code: `import { defineTool } from "eve/tools";
import z from "zod";

export default defineTool({
  description: "Get the weather for a city",
  inputSchema: z.object({
    cityName: z.string(),
  }),
  async execute(input) {
    const res = await fetch(
      \`\${process.env.WEATHER_API_URL}/current?city=\${input.cityName}\`
    );
    const data = await res.json();
    return data.current_condition[0];
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
        command: "git clone repo /workspace"
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
    description: "Add channel files to use the same agent in Slack, Discord, Teams, or the web.",
    code: `import { slackChannel } from
  "eve/channels/slack";

export default slackChannel({
  botName: "my-agent",
});`,
  },
  {
    label: "Connections",
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    NavIcon: IconLinked,
    description:
      "Connections handle auth for services like GitHub, Stripe, and Linear, so tools can call them without managing tokens.",
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    label: "Sub Agents",
    name: "subagents/",
    fileName: "subagents/researcher/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
    description:
      "Add subagents for specialized work. The main agent delegates tasks and combines the results.",
    code: `import { defineAgent } from
  "eve";

export default defineAgent({
  description: "Investigate questions",
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});`,
  },
  {
    label: "Schedules",
    name: "schedules/",
    fileName: "schedules/daily-report.md",
    lang: "markdown",
    NavIcon: IconClock,
    description:
      "Schedules run agents automatically for jobs like daily reports and weekly digests, continuing durably without an active session.",
    code: `---
cron: "0 8 * * *"
---

Send the user a daily weather
digest for their saved cities.`,
  },
  {
    label: "Evals",
    name: "evals/",
    fileName: "evals/weather/brooklyn-forecast.eval.ts",
    lang: "typescript",
    NavIcon: IconFileText,
    description:
      "Evals run the agent through real sessions and score the result, so you can catch regressions as it evolves.",
    code: `import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  async test(t) {
    const turn = await t.send("What is the weather in Brooklyn?");
    t.succeeded();
    t.check(turn.message, includes("Sunny"));
  },
});`,
  },
];

// The same agent made multi-tenant: each file is a defineDynamic function from the Dynamic
// Capabilities guide, shown with what it resolves to for two example tenants.
const ACME = { name: "Acme", plan: "Enterprise" };
const GLOBEX = { name: "Globex", plan: "Pro" };

const tenantSnippets: Snippet[] = [
  {
    label: "Subagents",
    name: "subagents/finance/",
    fileName: "subagents/finance/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
    description:
      "Offer a subagent only to the tenants that should have it. Here, only enterprise plans get the finance analyst.",
    code: `import { defineAgent, defineDynamic }
  from "eve";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes
    .plan === "enterprise"
    ? defineAgent({
        description: "Analyze financial data.",
        model: ctx.model.id,
      })
    : null,
);`,
    tenants: [
      { ...ACME, result: "Finance subagent" },
      { ...GLOBEX, result: "None" },
    ],
  },
  {
    label: "Skills",
    name: "skills/team_playbook.ts",
    fileName: "skills/team_playbook.ts",
    lang: "typescript",
    NavIcon: IconWrench,
    description:
      "Load each team's own playbook as a skill, so every tenant's agent follows its own process.",
    code: `import { defineDynamic, defineSkill }
  from "eve/skills";
import { PLAYBOOKS } from "../lib/playbooks";

export default defineDynamic((ctx) => {
  const team =
    ctx.session.auth.current?.attributes.team;
  const content = team
    ? PLAYBOOKS[team] : undefined;
  return content
    ? defineSkill({ content,
        description: "The team's playbook." })
    : null;
});`,
    tenants: [
      { ...ACME, result: "Sales playbook" },
      { ...GLOBEX, result: "Support playbook" },
    ],
  },
  {
    label: "Connections",
    name: "connections/accounts.ts",
    fileName: "connections/accounts.ts",
    lang: "typescript",
    NavIcon: IconLinked,
    description:
      "Connect each signed-in user to their own accounts, with tokens minted for them when a tool needs one.",
    code: `import { defineDynamic,
  defineMcpClientConnection }
  from "eve/connections";

export default defineDynamic(async (ctx) => {
  const principal = ctx.session.auth.current;
  if (principal?.principalType !== "user")
    return null;
  const accounts = await ctx.memo(principal,
    () => listEnabledAccounts(principal));
  return Object.fromEntries(
    accounts.map((account) => [
      account.slug,
      defineMcpClientConnection({ /* … */ }),
    ]),
  );
});`,
    tenants: [
      { ...ACME, result: "acme-prod, acme-staging" },
      { ...GLOBEX, result: "globex-prod" },
    ],
  },
  {
    label: "Tools",
    name: "tools/query.ts",
    fileName: "tools/query.ts",
    lang: "typescript",
    NavIcon: IconWorkflow,
    description:
      "Build one query tool per table in the tenant's warehouse, so each agent sees only its own data.",
    code: `import { defineDynamic, defineTool }
  from "eve/tools";

export default defineDynamic(async (ctx) => {
  const tables = await ctx.memo(
    ctx.session.id, listTables);
  return Object.fromEntries(
    tables.map((table) => [
      table.name,
      defineTool({ /* … */ }),
    ]),
  );
});`,
    tenants: [
      { ...ACME, result: "orders, users" },
      { ...GLOBEX, result: "invoices" },
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
