import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import { cacheLife } from "next/cache";
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
      "The always-on system prompt. Write it in Markdown, or switch to instructions.ts when it needs code.",
    code: `# Support

You resolve order issues for Acme customers.
Look up the order before you answer.
Hand disputes over $500 to the billing agent.`,
  },
  {
    label: "Agent",
    name: "agent.ts",
    fileName: "agent.ts",
    lang: "typescript",
    NavIcon: IconSparkles,
    description:
      "The model, reasoning effort, and runtime settings. Without this file, eve uses its default model.",
    code: `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
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
      "Playbooks the model loads only when a task calls for one, so they cost no context until then.",
    code: `---
description: Issue refunds and explain timelines
---

Confirm the order and the charge first.
Tell the customer when the money will arrive.`,
  },
  {
    label: "Tools",
    name: "tools/",
    fileName: "tools/refund_charge.ts",
    lang: "typescript",
    NavIcon: IconWorkflow,
    description:
      "Typed functions the model can call. The filename is the tool name, and the approval policy decides when a person must sign off and who may.",
    code: `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { billingLeads, stripe } from "../lib/billing";

export default defineTool({
  description: "Refund a charge.",
  inputSchema: z.object({
    chargeId: z.string(),
    amount: z.number(),
  }),
  approval: {
    request: always(),
    response: ({ response }) =>
      billingLeads.includes(response.principal.principalId)
        ? { status: "allowed" }
        : { status: "rejected", reason: "Billing leads approve refunds." },
  },
  async execute({ chargeId, amount }) {
    return stripe.refunds.create({ charge: chargeId, amount });
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
      "Each session gets an isolated shell and filesystem. Add this file to choose a provider or prepare the environment.",
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
    description:
      "Each channel file puts the same agent on another surface, such as Slack, Teams, GitHub, or your web app.",
    code: `import { slackChannel } from
  "eve/channels/slack";

export default slackChannel({
  botName: "support",
});`,
  },
  {
    label: "Connections",
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    NavIcon: IconLinked,
    description:
      "MCP and OpenAPI servers the agent can use. Credentials stay out of the model's context, and a sign-in prompt parks the turn until the user connects.",
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    label: "Subagents",
    name: "subagents/",
    fileName: "subagents/billing/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
    description:
      "Specialists with their own instructions, tools, and model. The root agent delegates to them and keeps working.",
    code: `import { defineAgent } from "eve";

export default defineAgent({
  description: "Investigates billing disputes",
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});`,
  },
  {
    label: "Schedules",
    name: "schedules/",
    fileName: "schedules/weekly-digest.ts",
    lang: "typescript",
    NavIcon: IconClock,
    description:
      "Cron jobs that start the agent without a user message and deliver the result to any channel.",
    code: `import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack";

export default defineSchedule({
  cron: "0 9 * * 1",
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(slack, { channelId: "C0123ABC" }).send(
        "Summarize last week's refunds.",
        { auth: appAuth },
      ),
    );
  },
});`,
  },
  {
    label: "Evals",
    name: "evals/",
    fileName: "evals/refunds/needs-approval.eval.ts",
    lang: "typescript",
    NavIcon: IconFileText,
    description:
      "Evals live next to agent/ at the project root. They drive real sessions through the agent's HTTP API, locally or in CI with eve eval.",
    code: `import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const turn = await t.send("Refund order #4821, it arrived broken.");
    t.parked();
    turn.calledTool("refund_charge", { status: "pending" });
  },
});`,
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
        components: {
          pre: ({ children, ...props }: ComponentProps<"pre">) => (
            <CodeBlock
              {...props}
              data-line-numbers="true"
              className={cn(
                props.className,
                "my-0! rounded-none border-0 bg-transparent px-0 [&_[data-section=content]]:rounded-none! [&_[data-section=content]]:border-0! [&_pre]:rounded-none! [&_pre]:bg-transparent!",
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
            <h2 className="text-center text-heading-32 text-gray-1000 sm:text-heading-40">
              Your{" "}
              <span className="relative -top-[0.08em] ml-1 inline-flex items-center gap-[0.16em] rounded-lg bg-gray-200 px-3 py-[0.04em] pr-4 align-baseline font-[450]!">
                <IconFolderOpen aria-hidden className="size-[0.58em] text-gray-900" />
                agent/
              </span>{" "}
              is a directory
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
              Each file and folder turns on a part of the runtime. Start with one Markdown file and
              add TypeScript as the agent grows. eve compiles the directory into an app with HTTP
              routes, durable sessions, and a sandbox.
            </p>
          </div>
        }
      />
    </section>
  );
}
