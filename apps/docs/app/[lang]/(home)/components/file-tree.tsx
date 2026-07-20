import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps, JSX } from "react";
import {
  IconAgents,
  IconClock,
  IconFileText,
  IconFolderOpen,
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
  model: "openai/gpt-5.4-mini",
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
    code: `import { defineSandbox } from
  "eve/sandbox";

export default defineSandbox({
  async bootstrap({ sandbox }) {
    await sandbox.run(
      "git clone repo /workspace"
    );
  },
});`,
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
  model: "openai/gpt-5.4",
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
];

export async function FileTree() {
  const rendered = await Promise.all(
    snippets.map((snippet) =>
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
                "rounded-none border-0 bg-transparent px-0 py-4",
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

  const items = snippets.map((snippet, i) => ({
    label: snippet.label,
    name: snippet.name,
    fileName: snippet.fileName,
    description: snippet.description,
    navIcon: <snippet.NavIcon className="shrink-0" size={16} />,
    code: rendered[i],
  }));

  return (
    <section className="pb-24 pt-8 font-sans px-4">
      <FileTreeView
        items={items}
        heading={
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center font-medium! text-heading-32 tracking-tighter text-gray-1000 sm:text-heading-40">
              Your{" "}
              <span className="relative -top-[0.08em] ml-1 inline-flex items-center gap-[0.16em] rounded-lg bg-gray-200 px-3 py-[0.04em] pr-4 align-baseline font-[450]!">
                <IconFolderOpen aria-hidden className="size-[0.58em] text-gray-900" />
                agent/
              </span>{" "}
              is a directory
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
              An instructions.md file is all you need to run an agent. Skills, tools, channels, and
              the rest are optional building blocks you add as it grows.
            </p>
          </div>
        }
      />
    </section>
  );
}
