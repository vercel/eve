import {
  IconLogs,
  IconMessage,
  IconRobot,
  IconSandbox,
  IconUser,
  IconWorkflow,
} from "@vercel/geistdocs/assets/icons";
import type { JSX, ReactNode } from "react";

const FEATURES: { icon: ReactNode; label: string; description: string }[] = [
  {
    icon: <IconWorkflow className="text-gray-1000" size={16} />,
    label: "Durable Execution",
    description:
      "Workflows survive crashes and restarts. Every step is checkpointed. Agents park when waiting, resume on the next message.",
  },
  {
    icon: <IconSandbox className="text-gray-1000" size={16} />,
    label: "Sandboxed Compute",
    description:
      "Agents run code in isolated sandboxes. File system access, bash execution, and code, all fully isolated.",
  },
  {
    icon: <IconMessage className="text-gray-1000" size={16} />,
    label: "Multi-Channel Delivery",
    description: "One agent codebase deploys to web chat, Slack, API, cron, CLI, and custom apps.",
  },
  {
    icon: <IconUser className="text-gray-1000" size={16} />,
    label: "Human-in-the-Loop",
    description:
      "Tools that need confirmation trigger approval gates. Sessions park until resolved, then resume seamlessly.",
  },
  {
    icon: <IconRobot className="text-gray-1000" size={16} />,
    label: "Subagents",
    description:
      "Delegate specialized work to child agents with their own prompts, tools, and sandbox.",
  },
  {
    icon: <IconLogs className="text-gray-1000" size={16} />,
    label: "Evaluations",
    description:
      "Define test suites with scoring rubrics. Run evals on every deployment and on a schedule.",
  },
];

export function FeatureGrid(): JSX.Element {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-medium! text-heading-32 tracking-tighter text-gray-1000 sm:text-heading-40">
          Everything you need for production agents
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900 text-balance">
          Durability, sandboxing, human-in-the-loop, and evals are built into the framework. Focus
          on building your agent.
        </p>
        <ul className="mt-16 grid list-none gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.label} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                {feature.icon}
                <span className="font-medium! text-gray-1000 text-heading-16">{feature.label}</span>
              </div>
              <p className="text-gray-900 text-copy-16">{feature.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
