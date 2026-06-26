import type { JSX, ReactNode } from "react";
import {
  IconLogs,
  IconMessage,
  IconRobot,
  IconSandbox,
  IconUser,
  IconWorkflow,
} from "@/components/geistcn-icons";

const FEATURES: { icon: ReactNode; label: string; description: string }[] = [
  {
    icon: <IconWorkflow aria-hidden color="gray-1000" size={16} />,
    label: "Durable execution",
    description:
      "Workflows survive crashes and restarts. Every step is checkpointed. Agents park when waiting, resume on the next message.",
  },
  {
    icon: <IconSandbox aria-hidden color="gray-1000" size={16} />,
    label: "Sandboxed compute",
    description:
      "Agents run code in isolated sandboxes. File system access, bash execution, and code, all fully isolated.",
  },
  {
    icon: <IconMessage aria-hidden color="gray-1000" size={16} />,
    label: "Multi-channel delivery",
    description: "One agent codebase deploys to web chat, Slack, API, cron, CLI, and custom apps.",
  },
  {
    icon: <IconUser aria-hidden color="gray-1000" size={16} />,
    label: "Human-in-the-loop",
    description:
      "Tools that need confirmation trigger approval gates. Sessions park until resolved, then resume seamlessly.",
  },
  {
    icon: <IconRobot aria-hidden color="gray-1000" size={16} />,
    label: "Subagents",
    description:
      "Delegate specialized work to child agents with their own prompts, tools, and sandbox.",
  },
  {
    icon: <IconLogs aria-hidden color="gray-1000" size={16} />,
    label: "Evaluations",
    description:
      "Define test suites with scoring rubrics. Run evals on every deployment and on a schedule.",
  },
];

export function FeatureGrid(): JSX.Element {
  return (
    <section className="px-4 py-24 sm:px-12">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold tracking-tighter text-gray-1000 sm:text-4xl">
          Everything you need for production agents
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Durability, sandboxing, human-in-the-loop, and evals are built into the framework. Focus
          on building your agent.
        </p>
        <ul className="mt-16 grid list-none gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.label} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                {feature.icon}
                <span className="font-mono font-medium uppercase tracking-[0.1em] text-gray-1000 text-label-14">
                  {feature.label}
                </span>
              </div>
              <p className="text-gray-900 text-copy-16">{feature.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
