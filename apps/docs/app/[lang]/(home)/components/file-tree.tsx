import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps, JSX } from "react";
import {
  IconAcronymTs,
  IconAgents,
  IconClock,
  IconFileText,
  IconLinked,
  IconMessage,
  type IconProps,
  IconSandbox,
  IconWrench,
} from "@/components/geistcn-icons";
import { cn } from "@/lib/utils";
import { FileTreeView } from "./file-tree-view";

interface Snippet {
  name: string;
  fileName: string;
  lang: string;
  Icon: (props: IconProps) => JSX.Element;
  code: string;
}

const snippets: Snippet[] = [
  {
    name: "instructions.md",
    fileName: "instructions.md",
    lang: "markdown",
    Icon: IconFileText,
    code: `# Identity

You are an expert weather assistant.
You can fetch the weather for any
city in the world.`,
  },
  {
    name: "agent.ts",
    fileName: "agent.ts",
    lang: "typescript",
    Icon: IconAcronymTs,
    code: `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
});`,
  },
  {
    name: "skills/",
    fileName: "skills/research.md",
    lang: "markdown",
    Icon: IconFileText,
    code: `---
name: research
description: Research unfamiliar topics
---

When the task is novel or ambiguous,
gather evidence first, then answer.`,
  },
  {
    name: "tools/",
    fileName: "tools/get_weather.ts",
    lang: "typescript",
    Icon: IconWrench,
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
    name: "sandbox/",
    fileName: "sandbox/sandbox.ts",
    lang: "typescript",
    Icon: IconSandbox,
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
    name: "channels/",
    fileName: "channels/slack.ts",
    lang: "typescript",
    Icon: IconMessage,
    code: `import { slackChannel } from
  "eve/channels/slack";

export default slackChannel({
  botName: "my-agent",
});`,
  },
  {
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    Icon: IconLinked,
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    name: "subagents/",
    fileName: "subagents/researcher/agent.ts",
    lang: "typescript",
    Icon: IconAgents,
    code: `import { defineAgent } from
  "eve";

export default defineAgent({
  description: "Investigate questions",
  model: "openai/gpt-5.4",
});`,
  },
  {
    name: "schedules/",
    fileName: "schedules/daily-report.md",
    lang: "markdown",
    Icon: IconClock,
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
          // Render the highlighted output through the geistdocs CodeBlock so the
          // snippets match the docs (line numbers, copy button, geist theme),
          // with its default border/background stripped to sit flush in the panel.
          pre: (props: ComponentProps<"pre">) => (
            <CodeBlock
              {...props}
              data-line-numbers="true"
              className={cn(
                props.className,
                // No pre padding: each `.line` already carries a 16px inset
                // (geistdocs), which matches the header's px-4 so the gutter
                // aligns with the header icon.
                "rounded-none border-0 bg-transparent px-0 py-4",
                // Left-align the line-number gutter so the numbers sit flush
                // under the header icon instead of floating right-aligned.
                // `!` overrides the more specific geistdocs `.line::before` rule.
                "[&_.line]:before:!mr-4 [&_.line]:before:!w-5 [&_.line]:before:!text-left",
              )}
            />
          ),
        },
      }),
    ),
  );

  const items = snippets.map((snippet, i) => ({
    name: snippet.name,
    fileName: snippet.fileName,
    icon: <snippet.Icon aria-hidden className="shrink-0" color="gray-900" size={16} />,
    code: rendered[i],
  }));

  return (
    <section className="px-4 pb-24 pt-16 font-sans sm:px-12">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold tracking-tighter text-gray-1000 sm:text-4xl">
          An agent is a directory
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Define instructions and skills in markdown, tools in TypeScript, and deploy. The framework
          compiles the directory, wires up durable workflows, and connects channels.
        </p>
      </div>

      <FileTreeView items={items} />
    </section>
  );
}
