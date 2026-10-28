import {
  SiDiscord,
  SiGithub,
  SiGooglechat,
  SiImessage,
  SiLinear,
  SiTelegram,
  SiWhatsapp,
} from "@icons-pack/react-simple-icons";
import {
  IconAgents,
  IconCheck,
  IconLinked,
  IconMessage,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconThumbUp,
  IconUser,
  IconWorkflow,
} from "@vercel/geistdocs/assets/icons";
import type { JSX, ReactNode } from "react";
import { logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { FeatureCard, GrayBadge, RuledList, ruledRow, Visual, pct, view } from "./control-visual";
import { HomeSection } from "./section";

// The visibility radar from vercel.com's enterprise page: a guard at the center, dashed rings,
// and one sweep per ring that fades out at both ends, turned a different way on each (that
// visual's center angles and sweeps). The rings sit a little tighter than its 34/58/82 so a
// chip at the bottom of the outer ring stays inside the frame.
const radar = { x: 160, y: 90, guard: 32 };

function ringPoint(r: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: radar.x + r * Math.cos(radians), y: radar.y + r * Math.sin(radians) };
}

const radarRings = [
  { r: 34, center: -50, sweep: 55 },
  { r: 56, center: 160, sweep: 60 },
  { r: 78, center: 30, sweep: 50 },
].map(({ center, r, sweep }) => ({
  r,
  from: ringPoint(r, center - sweep),
  to: ringPoint(r, center + sweep),
}));

// Slack and Teams have no single-color simple icon, so their brand marks take the text color;
// Teams' white letter takes the chip's color so it stays cut out.
const monochrome = "[&_path]:fill-current [&_path[fill=white]]:fill-background-100";

// One chip every 36° around the guard, alternating between the middle and outer rings, so each
// ring holds five spaced 72° apart and the layout mirrors left to right.
const CHANNELS = (
  [
    { label: "WhatsApp", logo: <SiWhatsapp /> },
    { label: "GitHub", logo: <SiGithub /> },
    { label: "Slack", logo: logos.slack({ className: monochrome }) },
    { label: "Linear", logo: <SiLinear /> },
    { label: "Discord", logo: <SiDiscord /> },
    { label: "Telegram", logo: <SiTelegram /> },
    { label: "Google Chat", logo: <SiGooglechat /> },
    { label: "Microsoft Teams", logo: logos.teams({ className: monochrome }) },
    { label: "iMessage", logo: <SiImessage /> },
    { label: "Web", logo: logos.web({}) },
  ] satisfies { label: string; logo: ReactNode }[]
).map((channel, i) => ({ ...channel, angle: 90 + i * 36, ring: i % 2 === 0 ? 2 : 1 }));

function ChannelRadar() {
  return (
    <Visual
      caption={`One agent at the center of radar rings, reached from ${CHANNELS.map((channel) => channel.label).join(", ")}.`}
      scene={radarRings.map(({ from, r, to }, index) => {
        const gradient = `channel-radar-${index}`;
        return (
          <g key={r}>
            <circle
              cx={radar.x}
              cy={radar.y}
              r={r}
              stroke="var(--ds-gray-alpha-200)"
              strokeDasharray="2 3"
            />
            <defs>
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id={gradient}
                x1={from.x}
                x2={to.x}
                y1={from.y}
                y2={to.y}
              >
                <stop stopColor="var(--ds-gray-1000)" stopOpacity="0" />
                <stop offset="0.5" stopColor="var(--ds-gray-1000)" />
                <stop offset="1" stopColor="var(--ds-gray-1000)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={`M${from.x} ${from.y}A${r} ${r} 0 0 1 ${to.x} ${to.y}`}
              stroke={`url(#${gradient})`}
              strokeLinecap="round"
              strokeWidth="0.75"
            />
          </g>
        );
      })}
    >
      <span
        className="absolute flex -translate-1/2 items-center justify-center rounded-full bg-background-100 text-gray-1000 shadow-(--ds-shadow-border-small) [&>svg]:size-[45%]"
        style={{
          height: pct(radar.guard, view.height),
          left: pct(radar.x, view.width),
          top: pct(radar.y, view.height),
          width: pct(radar.guard, view.width),
        }}
      >
        <IconAgents />
      </span>
      {CHANNELS.map(({ angle, label, logo, ring }) => {
        const { x, y } = ringPoint(radarRings[ring].r, angle);
        return (
          <span
            className="absolute flex size-[6.5cqw] -translate-1/2 items-center justify-center rounded-full bg-background-100 text-gray-1000 shadow-(--ds-shadow-border-small) [&>svg]:size-[48%]"
            key={label}
            style={{
              left: pct(x, view.width),
              top: pct(y, view.height),
            }}
          >
            {logo}
          </span>
        );
      })}
    </Visual>
  );
}

// Each person's capabilities, resolved when their session runs. Avatars are two-stop
// gradients in Geist colors, like Vercel's default avatars, so no image is fetched.
const TENANTS = [
  {
    name: "Alice",
    capabilities: ["Memory", "CRM tools"],
    avatar: "linear-gradient(135deg, var(--ds-blue-600), var(--ds-teal-700))",
  },
  {
    name: "Bob",
    capabilities: ["Memory", "Schedules"],
    avatar: "linear-gradient(135deg, var(--ds-amber-600), var(--ds-red-700))",
  },
  {
    name: "Carol",
    capabilities: ["Memory", "Legal skills"],
    avatar: "linear-gradient(135deg, var(--ds-purple-600), var(--ds-pink-700))",
  },
];

function TenantCapabilities() {
  return (
    <Visual caption="One deployment resolves capabilities per person: Alice gets memory and CRM tools, Bob memory and schedules, and Carol memory and legal skills.">
      <RuledList
        header={
          <>
            <IconUser className="size-[1em]" />
            Resolved per user
          </>
        }
      >
        {TENANTS.map(({ avatar, capabilities, name }) => (
          <li className={cn(ruledRow, "gap-[0.5em]")} key={name}>
            <span className="size-[1.25em] shrink-0 rounded-full" style={{ background: avatar }} />
            <span className="w-[4.5em] whitespace-nowrap text-[0.75em] text-gray-1000 leading-none">
              {name}
            </span>
            {capabilities.map((capability) => (
              <GrayBadge key={capability}>{capability}</GrayBadge>
            ))}
          </li>
        ))}
      </RuledList>
    </Visual>
  );
}

type Step = "model" | "code";

const MODES: { label: string; steps: (Step | Step[])[] }[] = [
  { label: "Fully agentic loop", steps: ["model", "model", "model", "model"] },
  { label: "Workflow run by an agent", steps: ["model", ["code", "code", "code"], "model"] },
  { label: "Workflow with agentic steps", steps: ["code", "model", "code", "code"] },
];

const track = { x0: 34, x1: 286 };
const modeY = (i: number) => 64 + i * 44;

function StepMark({ step, x, y }: { step: Step; x: number; y: number }) {
  return step === "model" ? (
    <circle cx={x} cy={y} fill="var(--ds-background-200)" r={4.5} stroke="var(--ds-gray-1000)" />
  ) : (
    <rect fill="var(--ds-gray-1000)" height={8} rx={1.5} width={8} x={x - 4} y={y - 4} />
  );
}

function DeterminismModes() {
  // A row's steps spread evenly over the track, so a grouped workflow sits in the middle.
  const stepX = (i: number, count: number) => track.x0 + (i * (track.x1 - track.x0)) / (count - 1);
  return (
    <Visual
      caption="Three ways to run a task: a fully agentic loop of model steps, a workflow of deterministic steps run by an agent, and a workflow with agentic steps inside it."
      scene={
        <>
          {MODES.map((mode, i) => {
            const y = modeY(i);
            return (
              <g key={mode.label}>
                <path d={`M${track.x0} ${y}H${track.x1}`} stroke="var(--ds-gray-alpha-400)" />
                {mode.steps.map((step, j) => {
                  const x = stepX(j, mode.steps.length);
                  if (!Array.isArray(step)) {
                    return <StepMark key={j} step={step} x={x} y={y} />;
                  }
                  return (
                    <g key={j}>
                      <rect
                        fill="var(--ds-background-200)"
                        height={18}
                        rx={3}
                        stroke="var(--ds-gray-1000)"
                        strokeDasharray="2 2.5"
                        strokeOpacity="0.55"
                        width={48}
                        x={x - 24}
                        y={y - 9}
                      />
                      {step.map((inner, k) => (
                        <StepMark key={k} step={inner} x={x + (k - 1) * 14} y={y} />
                      ))}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </>
      }
    >
      <div className="absolute inset-0 select-none text-[4.4cqw]">
        {MODES.map((mode, i) => (
          <span
            className="absolute -translate-y-full whitespace-nowrap pb-[0.6em] text-[0.625em] text-gray-1000 leading-none"
            key={mode.label}
            style={{ left: pct(track.x0 - 4, view.width), top: pct(modeY(i) - 6, view.height) }}
          >
            {mode.label}
          </span>
        ))}
        <span
          aria-hidden
          className="absolute flex items-center gap-[1.25em] text-[0.5625em] text-gray-900 leading-none"
          style={{ left: pct(track.x0 - 4, view.width), top: pct(18, view.height) }}
        >
          <span className="flex items-center gap-[0.5em]">
            <span className="size-[0.8em] rounded-full border border-gray-1000" />
            Agentic step
          </span>
          <span className="flex items-center gap-[0.5em]">
            <span className="size-[0.7em] rounded-[1.5px] bg-gray-1000" />
            Deterministic step
          </span>
        </span>
      </div>
    </Visual>
  );
}

const PRIMARY: {
  title: string;
  text: string;
  href: string;
  icon: ReactNode;
  visual: ReactNode;
}[] = [
  {
    title: "Agent chat on every channel",
    text: "Multiplayer and single-player chat across Slack, Teams, iMessage, WhatsApp, and the web. Channels are a framework primitive.",
    href: "/docs/channels/overview",
    icon: <IconMessage aria-hidden size={16} />,
    visual: <ChannelRadar />,
  },
  {
    title: "Multi-tenant with dynamic capabilities",
    text: "One deployment, every customer. Skills, schedules, memory, and tools resolved per user at runtime.",
    href: "/docs/guides/dynamic-capabilities",
    icon: <IconUser aria-hidden size={16} />,
    visual: <TenantCapabilities />,
  },
  {
    title: "Determinism where you need it",
    text: "Fully agentic loops, deterministic workflows, or both in one run. You choose per task.",
    href: "/docs/tools/workflows",
    icon: <IconRoute aria-hidden size={16} />,
    visual: <DeterminismModes />,
  },
];

const SECONDARY: { title: string; text: string; href: string; icon: ReactNode }[] = [
  {
    title: "Any model, no rewrite",
    icon: <IconSparkles size={16} />,
    text: "Swap models with a one-line edit. Provider fallback included. Route different models to different tasks.",
    href: "/docs/agent-config#set-the-model",
  },
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
    title: "Agent identity",
    icon: <IconShieldCheck size={16} />,
    text: "Bring any OIDC provider. Act as the agent, or as the signed-in user with their approved permissions.",
    href: "/docs/guides/auth-and-route-protection",
  },
];

export function Production(): JSX.Element {
  return (
    <HomeSection id="production" title="Everything you need to ship to production">
      <ul className="m-0 grid list-none gap-x-6 gap-y-16 p-0 md:grid-cols-12">
        {PRIMARY.map((feature) => (
          <FeatureCard
            className="md:col-span-6 lg:col-span-4"
            href={feature.href}
            icon={feature.icon}
            key={feature.title}
            title={feature.title}
            visual={feature.visual}
          >
            {feature.text}
          </FeatureCard>
        ))}
      </ul>
      <ul className="m-0 mt-24 grid list-none gap-x-6 gap-y-12 p-0 md:grid-cols-12 lg:gap-y-24">
        {SECONDARY.map((feature) => (
          <FeatureCard
            className="md:col-span-6 lg:col-span-4"
            href={feature.href}
            icon={feature.icon}
            key={feature.title}
            title={feature.title}
          >
            {feature.text}
          </FeatureCard>
        ))}
      </ul>
    </HomeSection>
  );
}
