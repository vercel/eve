import { SiImessage } from "@icons-pack/react-simple-icons";
import {
  IconCheck,
  IconChevronRightSmall,
  IconClock,
  IconLinked,
  IconShieldCheck,
  IconThumbUp,
  IconUser,
  IconWorkflow,
} from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { type LogoKey, logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { Frame, FrameHeader, HomeSection } from "./section";

const logoClassName = "size-4 shrink-0 grayscale";

const CHANNELS: { label: string; logo: ReactNode }[] = [
  ...(
    [
      ["slack", "Slack"],
      ["teams", "Microsoft Teams"],
      ["discord", "Discord"],
      ["telegram", "Telegram"],
      ["whatsapp", "WhatsApp"],
    ] as [LogoKey, string][]
  ).map(([key, label]) => ({
    label,
    logo: logos[key]({ "aria-hidden": true, className: logoClassName }),
  })),
  { label: "iMessage", logo: <SiImessage aria-hidden className={logoClassName} /> },
  ...(
    [
      ["googlechat", "Google Chat"],
      ["github", "GitHub"],
      ["linear", "Linear"],
      ["twilio", "Twilio"],
      ["web", "Web"],
    ] as [LogoKey, string][]
  ).map(([key, label]) => ({
    label,
    logo: logos[key]({ "aria-hidden": true, className: logoClassName }),
  })),
];

function ChannelGrid() {
  return (
    <ul className="grid flex-1 list-none auto-rows-fr grid-cols-2 gap-px bg-gray-alpha-400 p-0 sm:grid-cols-3">
      {CHANNELS.map((channel) => (
        <li
          className="flex items-center gap-2.5 bg-background-100 px-4 py-3.5 text-copy-14 text-gray-1000"
          key={channel.label}
        >
          <span className="flex text-gray-1000">{channel.logo}</span>
          <span className="truncate">{channel.label}</span>
        </li>
      ))}
      <li className="flex items-center bg-background-100 px-4 py-3.5 text-copy-14 text-gray-900">
        Your own channel
      </li>
    </ul>
  );
}

const USERS = ["Alice", "Bob", "Carol"];

const USER_CAPABILITIES = ["Memory", "Schedules", "Skills"];

const wireClassName = "bg-gray-alpha-500";

function TenantArchitecture() {
  return (
    <figure className="@container flex flex-1 items-center justify-center p-5 sm:p-6">
      <figcaption className="sr-only">
        One agent serves Alice, Bob, and Carol. Each of them has their own memory, schedules, and
        skills.
      </figcaption>
      <div aria-hidden className="flex w-full max-w-[30rem] items-center">
        <span className="shrink-0 rounded-lg border border-gray-alpha-500 bg-background-200 px-4 py-3 text-copy-14 text-gray-1000">
          Agent
        </span>
        <span className={cn("h-px w-4 shrink-0 @md:w-6", wireClassName)} />
        <span className="flex min-w-0 flex-1 flex-col">
          {USERS.map((user, i) => (
            <span className="relative flex items-center py-1.5" key={user}>
              <span
                className={cn(
                  "absolute left-0 w-px",
                  wireClassName,
                  i === 0
                    ? "top-1/2 bottom-0"
                    : i === USERS.length - 1
                      ? "top-0 bottom-1/2"
                      : "inset-y-0",
                )}
              />
              <span className={cn("h-px w-4 shrink-0 @md:w-6", wireClassName)} />
              <span className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-gray-alpha-400 px-3 py-2.5 @md:flex-row @md:items-center @md:justify-between">
                <span className="flex items-center gap-1.5 text-copy-14 text-gray-1000">
                  <IconUser className="text-gray-900" size={14} />
                  {user}
                </span>
                <span className="flex flex-wrap gap-1">
                  {USER_CAPABILITIES.map((capability) => (
                    <span
                      className="rounded-md border border-gray-alpha-400 px-1.5 py-0.5 text-label-12 text-gray-900"
                      key={capability}
                    >
                      {capability}
                    </span>
                  ))}
                </span>
              </span>
            </span>
          ))}
        </span>
      </div>
    </figure>
  );
}

function ModelDiff() {
  const lines: { mark: " " | "-" | "+"; text: string }[] = [
    { mark: " ", text: 'import { defineAgent } from "eve";' },
    { mark: " ", text: "" },
    { mark: " ", text: "export default defineAgent({" },
    { mark: "-", text: '  model: "openai/gpt-6-luna-fast",' },
    { mark: "+", text: '  model: "anthropic/claude-opus-5.5",' },
    { mark: " ", text: "  modelOptions: {" },
    { mark: " ", text: "    providerOptions: {" },
    { mark: " ", text: "      // Fall back to Bedrock if Anthropic is down." },
    { mark: " ", text: '      gateway: { order: ["anthropic", "bedrock"] },' },
    { mark: " ", text: "    }," },
    { mark: " ", text: "  }," },
    { mark: " ", text: "});" },
  ];

  return (
    <>
      <FrameHeader>
        <span className="font-mono text-copy-13-mono text-gray-1000">agent/agent.ts</span>
        <span className="ml-auto">1 line changed</span>
      </FrameHeader>
      <pre className="overflow-x-auto py-3 font-mono text-copy-13-mono">
        {lines.map((line, i) => (
          <div
            className={cn(
              "grid w-max min-w-full grid-cols-[2.5rem_auto] pr-4",
              line.mark === "-" && "bg-red-100 text-red-900",
              line.mark === "+" && "bg-green-100 text-green-900",
              line.mark === " " && "text-gray-1000",
            )}
            // Lines have no stable identity beyond their position in this fixed snippet.
            key={i}
          >
            <span aria-hidden className="select-none text-center opacity-70">
              {line.mark}
            </span>
            <span className="whitespace-pre">
              {line.mark === "-" ? <span className="sr-only">Removed: </span> : null}
              {line.mark === "+" ? <span className="sr-only">Added: </span> : null}
              {line.text || " "}
            </span>
          </div>
        ))}
      </pre>
    </>
  );
}

type Step = "model" | "code";

const MODES: { label: string; steps: (Step | Step[])[] }[] = [
  { label: "Fully agentic loop", steps: ["model", "model", "model", "model"] },
  { label: "Workflow run by an agent", steps: ["model", ["code", "code", "code"], "model"] },
  { label: "Workflow with agentic steps", steps: ["code", "model", "code", "code"] },
];

const LEGEND: { step: Step; term: string }[] = [
  { step: "model", term: "Agentic step" },
  { step: "code", term: "Deterministic step" },
];

function StepMark({ step }: { step: Step }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block size-3.5 shrink-0",
        step === "model"
          ? "rounded-full border-[1.5px] border-gray-1000"
          : "rounded-[2px] bg-gray-1000",
      )}
    />
  );
}

function StepConnector() {
  return <span aria-hidden className="h-px min-w-3 flex-1 bg-gray-alpha-500" />;
}

function DeterminismModes() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-5 sm:p-6">
      <ul className="flex flex-1 list-none flex-col justify-center gap-7 p-0">
        {MODES.map((mode) => (
          <li
            className="grid gap-2 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center"
            key={mode.label}
          >
            <span className="text-copy-14 text-gray-1000">{mode.label}</span>
            <span className="flex items-center">
              {mode.steps.map((step, i) => (
                <span className="contents" key={`${mode.label}-${i}`}>
                  {i > 0 ? <StepConnector /> : null}
                  {Array.isArray(step) ? (
                    <span className="flex items-center gap-1.5 rounded-md border border-gray-alpha-500 border-dashed px-2 py-1.5">
                      {step.map((inner, j) => (
                        <StepMark key={`${mode.label}-${i}-${j}`} step={inner} />
                      ))}
                    </span>
                  ) : (
                    <StepMark step={step} />
                  )}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-center gap-x-6 gap-y-2 border-gray-alpha-400 border-t pt-4 text-copy-13 text-gray-1000">
        {LEGEND.map((item) => (
          <span className="flex items-center gap-2" key={item.step}>
            <StepMark step={item.step} /> {item.term}
          </span>
        ))}
      </p>
    </div>
  );
}

const PRIMARY: {
  title: string;
  text: string;
  href: string;
  visual: ReactNode;
}[] = [
  {
    title: "Agent chat on every channel",
    text: "Multiplayer and single-player chat across Slack, Teams, iMessage, WhatsApp, and the web. Channels are a framework primitive.",
    href: "/docs/channels/overview",
    visual: <ChannelGrid />,
  },
  {
    title: "Multi-tenant with dynamic capabilities",
    text: "One deployment, every customer. Skills, schedules, memory, and tools resolved per user at runtime.",
    href: "/docs/guides/dynamic-capabilities",
    visual: <TenantArchitecture />,
  },
  {
    title: "Any model, no rewrite",
    text: "Swap models with a one-line edit. Provider fallback included. Route different models to different tasks.",
    href: "/docs/agent-config#set-the-model",
    visual: <ModelDiff />,
  },
  {
    title: "Determinism where you need it",
    text: "Fully agentic loops, deterministic workflows, or both in one run. You choose per task.",
    href: "/docs/tools/workflows",
    visual: <DeterminismModes />,
  },
];

const SECONDARY: { title: string; text: string; href: string; icon: ReactNode }[] = [
  {
    title: "Durable execution",
    icon: <IconWorkflow size={16} />,
    text: "Checkpoints every step. Survives crashes, restarts, and days-long waits.",
    href: "/docs/concepts/execution-model-and-durability",
  },
  {
    title: "Human in the loop",
    icon: <IconThumbUp size={16} />,
    text: "Pause for approval. Resume durably when it arrives.",
    href: "/docs/human-in-the-loop",
  },
  {
    title: "Evals",
    icon: <IconCheck size={16} />,
    text: "Test agent behavior before and after every change.",
    href: "/docs/evals/overview",
  },
  {
    title: "Connections",
    icon: <IconLinked size={16} />,
    text: "Connect to services over MCP and OpenAPI. Credentials stay in the runtime, never in the model.",
    href: "/docs/connections",
  },
  {
    title: "Scheduling",
    icon: <IconClock size={16} />,
    text: "Crons, plus schedules the agent sets itself.",
    href: "/docs/schedules",
  },
  {
    title: "Agent identity",
    icon: <IconShieldCheck size={16} />,
    text: "Bring any OIDC provider. Act as the agent, or as the signed-in user with their approved permissions.",
    href: "/docs/guides/auth-and-route-protection",
  },
];

export function Production(): JSX.Element {
  return (
    <HomeSection id="production" title="Everything you need to ship to production">
      <div className="grid gap-x-6 gap-y-16 md:grid-cols-2">
        {PRIMARY.map((feature) => (
          <article className="flex min-w-0 flex-col" key={feature.title}>
            <Frame className="flex flex-col md:min-h-[18.5rem]">{feature.visual}</Frame>
            <h3 className="mt-6">
              <Link
                className="group inline-flex items-center text-heading-20 text-gray-1000"
                href={feature.href}
                prefetch={true}
              >
                {feature.title}
                <IconChevronRightSmall
                  className="text-gray-700 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-1000"
                  size={16}
                />
              </Link>
            </h3>
            <p className="mt-2 max-w-[34rem] text-copy-16 text-gray-900">{feature.text}</p>
          </article>
        ))}
      </div>

      <ul className="m-0 mt-24 grid list-none gap-x-6 gap-y-12 p-0 md:grid-cols-12 lg:gap-y-24">
        {SECONDARY.map((feature) => (
          <li className="min-w-0 md:col-span-6 lg:col-span-4" key={feature.title}>
            <Link className="group flex flex-col gap-3" href={feature.href} prefetch={true}>
              <h3 className="flex items-center gap-3 font-[450] text-copy-16 text-gray-1000 [&>svg:first-child]:shrink-0">
                {feature.icon}
                {feature.title}
                <IconChevronRightSmall
                  aria-hidden
                  className="-ml-1 -translate-x-px transition-transform group-hover:translate-x-0"
                  size={14}
                />
              </h3>
              <p className="max-w-[34ch] text-pretty text-copy-16 text-gray-900 transition-colors group-hover:text-gray-1000 lg:text-copy-18">
                {feature.text}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </HomeSection>
  );
}
