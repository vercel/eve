import { Bot, Database, FlaskConical, MessageSquare, Shield, Terminal } from "lucide-react";
import { FeatureCard } from "./feature-card";
import { ChannelsVisual } from "./visuals/channels";
import { DurabilityVisual } from "./visuals/durability";
import { EvalsVisual } from "./visuals/evals";
import { HITLVisual } from "./visuals/hitl";
import { SandboxVisual } from "./visuals/sandbox";
import { SubagentsVisual } from "./visuals/subagents";

const features = [
  {
    title: "Durable Execution",
    description:
      "Workflows survive crashes and restarts. Every step is checkpointed. Agents park when waiting, resume on the next message.",
    icon: <Database className="h-4 w-4 text-green-600" />,
    visual: <DurabilityVisual />,
    href: "/docs/concepts/sessions-runs-and-streaming",
  },
  {
    title: "Sandboxed Compute",
    description:
      "Agents spin up isolated VMs on demand. File system access, bash execution, and code runs, all completely isolated.",
    icon: <Terminal className="h-4 w-4 text-orange-600" />,
    visual: <SandboxVisual />,
    href: "/docs/sandbox",
  },
  {
    title: "Multi-Channel Delivery",
    description: "One agent codebase deploys to web chat, Slack, API, cron, CLI, and custom apps.",
    icon: <MessageSquare className="h-4 w-4 text-cyan-600" />,
    visual: <ChannelsVisual />,
    href: "/docs/channels/overview",
  },
  {
    title: "Human-in-the-Loop",
    description:
      "Tools that need confirmation trigger approval gates. Sessions park until resolved, then resume seamlessly.",
    icon: <Shield className="h-4 w-4 text-amber-600" />,
    visual: <HITLVisual />,
    href: "/docs/tools",
  },
  {
    title: "Subagents",
    description:
      "Delegate specialized work to child agents with their own prompts, tools, and sandbox.",
    icon: <Bot className="h-4 w-4 text-indigo-600" />,
    visual: <SubagentsVisual />,
    href: "/docs/subagents",
  },
  {
    title: "Evaluations",
    description:
      "Define test suites with scoring rubrics. Run evals on every deployment and on a schedule.",
    icon: <FlaskConical className="h-4 w-4 text-pink-600" />,
    visual: <EvalsVisual />,
    href: "/docs/evals/overview",
  },
];

export function FeatureGrid() {
  return (
    <section className="px-4 py-24 sm:px-12">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-bold tracking-tighter text-gray-1000 sm:text-4xl">
          Everything you need for production agents
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-gray-900">
          Enterprise governance, observability, and sandboxed compute come standard. Focus on
          building, not infrastructure.
        </p>
        <div className="mt-16 grid gap-6 md:grid-cols-2">
          {features.map((feature) => (
            <FeatureCard key={feature.title} {...feature} />
          ))}
        </div>
      </div>
    </section>
  );
}
