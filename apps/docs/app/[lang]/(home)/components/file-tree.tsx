import { cacheLife } from "next/cache";
import type { JSX } from "react";
import {
  IconAgents,
  IconBox,
  IconCheck,
  IconClock,
  IconFileText,
  IconLinked,
  IconMessage,
  IconSandbox,
  IconSparkles,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import { FileTreeView } from "./file-tree-view";
import { highlightFlush } from "./highlight";

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

// Mirrors the coding agent template (apps/templates/eve-coding-agent-template),
// plus skills, connections, subagents, schedules, and evals it does not ship.
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

You are a coding agent. People reach you from Slack and GitHub to answer questions about code, review changes, investigate bugs, and ship fixes as pull requests.

Ground every claim in evidence you can point to: files, diffs, logs, or test output.`,
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
  model: "anthropic/claude-opus-5.5",
  reasoning: "medium",
  // Coding sessions run long; compact
  // before the context gets crowded.
  compaction: { thresholdPercent: 0.7 },
});`,
  },
  {
    label: "Sandbox",
    name: "sandbox.ts",
    fileName: "sandbox.ts",
    lang: "typescript",
    NavIcon: IconSandbox,
    description: "Each session runs in an isolated sandbox. Pick its backend and preinstall tools.",
    code: `import { installCodeTooling } from "eve/extensions/code/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  prepare: (sandbox) => installCodeTooling(sandbox),
});
export default defineSandbox(() => environment.open());`,
  },
  {
    label: "Extensions",
    name: "extensions/",
    fileName: "extensions/code.ts",
    lang: "typescript",
    NavIcon: IconBox,
    description:
      "Extensions mount a packaged set of tools, skills, and subagents. The code extension adds patching, search, and review.",
    code: `import code from "eve/extensions/code";

export default code({});`,
  },
  {
    label: "Channels",
    name: "channels/",
    fileName: "channels/slack.ts",
    lang: "typescript",
    NavIcon: IconMessage,
    description: "Add channel files to reach the same agent from Slack, GitHub, Teams, or the web.",
    code: `import { connectSlackCredentials }
  from "@vercel/connect/eve";
import { slackChannel }
  from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials(
    "slack/coding-agent",
  ),
});`,
  },
  {
    label: "Connections",
    name: "connections/",
    fileName: "connections/linear.ts",
    lang: "typescript",
    NavIcon: IconLinked,
    description:
      "Connections handle auth for services like GitHub, Stripe, and Linear, so the agent can pick up issues without managing tokens.",
    code: `import { defineMcpClientConnection }
  from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
});`,
  },
  {
    label: "Skills",
    name: "skills/",
    fileName: "skills/fix-flaky-test.md",
    lang: "markdown",
    NavIcon: IconWrench,
    description:
      "Skills are Markdown playbooks loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.",
    code: `---
name: fix-flaky-test
description: Diagnose and fix a flaky test
---

Rerun the test in a loop until it fails. Find the race or shared state behind it and fix the root cause. Never paper over it with retries.`,
  },
  {
    label: "Subagents",
    name: "subagents/",
    fileName: "subagents/security-reviewer/agent.ts",
    lang: "typescript",
    NavIcon: IconAgents,
    description:
      "Add subagents for specialized work. The main agent delegates tasks and combines the results.",
    code: `import { defineAgent } from "eve";

export default defineAgent({
  description: "Audit a diff for security issues",
  model: "anthropic/claude-opus-5.5",
  reasoning: "high",
});`,
  },
  {
    label: "Schedules",
    name: "schedules/",
    fileName: "schedules/dependency-updates.md",
    lang: "markdown",
    NavIcon: IconClock,
    description:
      "Schedules run the agent on a cron for recurring jobs, continuing durably without an active session.",
    code: `---
cron: "0 9 * * 1"
---

Check each repository for outdated dependencies and open one pull request per repository with the upgrades.`,
  },
  {
    label: "Evals",
    name: "evals/",
    fileName: "evals/fixes-flaky-test.eval.ts",
    lang: "typescript",
    NavIcon: IconCheck,
    description:
      "Evals run the agent through real sessions and score the result, so you can catch regressions as it evolves.",
    code: `import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    await t.send("Fix the flaky checkout test.");
    t.succeeded();
    t.calledTool("code__apply_patch");
  },
});`,
  },
];

export async function FileTree() {
  "use cache";
  cacheLife("max");

  const rendered = await Promise.all(
    snippets.map((snippet) => highlightFlush(snippet.code, snippet.lang, true)),
  );

  const items = snippets.map((snippet, i) => ({
    label: snippet.label,
    name: snippet.name,
    fileName: snippet.fileName,
    description: snippet.description,
    navIcon: <snippet.NavIcon className="shrink-0" size={16} />,
    code: rendered[i],
  }));

  return <FileTreeView items={items} />;
}
