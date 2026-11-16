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
import {
  FeatureCard,
  GrayBadge,
  RuledList,
  monochromeLogo,
  ruledRow,
  Visual,
  pct,
  view,
} from "./control-visual";
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

// One chip every 36° around the guard, alternating between the middle and outer rings, so each
// ring holds five spaced 72° apart and the layout mirrors left to right.
const CHANNELS = (
  [
    { label: "WhatsApp", logo: <SiWhatsapp /> },
    { label: "GitHub", logo: <SiGithub /> },
    { label: "Slack", logo: logos.slack({ className: monochromeLogo }) },
    { label: "Linear", logo: <SiLinear /> },
    { label: "Discord", logo: <SiDiscord /> },
    { label: "Telegram", logo: <SiTelegram /> },
    { label: "Google Chat", logo: <SiGooglechat /> },
    { label: "Microsoft Teams", logo: logos.teams({ className: monochromeLogo }) },
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

// The Acme logo from geistcn-assets (`logo-acme`), which marks each person as a member of the
// Acme org, like the managed accounts visual on vercel.com's enterprise page.
function AcmeLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="none" viewBox="0 0 16 16">
      <path
        clipRule="evenodd"
        d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M4.5 10.63h2.13l2.44-4.26L8 4.5zm4.15 0h2.85l-1.42-2.5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

/** A member's avatar, badged with the org's logo ringed in the page's color. */
function MemberAvatar({ avatar }: { avatar: string }) {
  return (
    <span className="relative size-[1.25em] shrink-0">
      <span className="absolute inset-0 rounded-full" style={{ background: avatar }} />
      <span className="absolute -right-[0.18em] -bottom-[0.18em] flex size-[0.625em] rounded-full bg-background-200 text-gray-1000 shadow-[0_0_0_0.1em_var(--ds-background-200)]">
        <AcmeLogo className="size-full" />
      </span>
    </span>
  );
}

function TenantCapabilities() {
  return (
    <Visual caption="One deployment resolves capabilities per person in the Acme org, each avatar badged with the Acme logo: Alice gets memory and CRM tools, Bob memory and schedules, and Carol memory and legal skills.">
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
            <MemberAvatar avatar={avatar} />
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

// Three runs, each along a line that fades out at both ends: fully agentic, fully
// deterministic, and both in one run. Deterministic steps are your code, in square chips;
// agentic steps are round.
type Step = "agent" | "code";
const RUNS: Step[][] = [
  ["agent", "agent", "agent", "agent"],
  ["code", "code", "code", "code"],
  ["code", "agent", "code", "code"],
];
const runY = (i: number) => 42 + i * 48;
const stepX = (i: number) => 70 + i * 60;
const run = { x0: 28, x1: 292 };

// A `</>` code glyph in the docs icons' 16px, 1.5px-stroke style; the set doesn't include one.
function CodeGlyph() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 16 16">
      <path
        d="M5 4.5 1.5 8 5 11.5M11 4.5 14.5 8 11 11.5M9.25 2.75l-2.5 10.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const chip =
  "absolute flex -translate-1/2 items-center justify-center bg-background-100 text-gray-1000 shadow-(--ds-shadow-border-small)";

function DeterminismRuns() {
  return (
    <Visual
      caption="Three runs: a fully agentic loop of model steps, a deterministic workflow of code steps, and a workflow with one agentic step among its code steps."
      scene={
        <>
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id="determinism-run"
              x1={run.x0}
              x2={run.x1}
              y1="0"
              y2="0"
            >
              <stop stopColor="var(--ds-gray-alpha-500)" stopOpacity="0" />
              <stop offset="0.14" stopColor="var(--ds-gray-alpha-500)" />
              <stop offset="0.86" stopColor="var(--ds-gray-alpha-500)" />
              <stop offset="1" stopColor="var(--ds-gray-alpha-500)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {RUNS.map((_, i) => (
            <path d={`M${run.x0} ${runY(i)}H${run.x1}`} key={i} stroke="url(#determinism-run)" />
          ))}
        </>
      }
    >
      {RUNS.flatMap((steps, i) =>
        steps.map((step, j) => (
          <span
            className={cn(
              chip,
              step === "agent"
                ? "size-[6.5cqw] rounded-full [&>svg]:size-[50%]"
                : "size-[6.5cqw] rounded-[1.2cqw] [&>svg]:size-[50%]",
            )}
            key={`${i}-${j}`}
            style={{ left: pct(stepX(j), view.width), top: pct(runY(i), view.height) }}
          >
            {step === "agent" ? <IconSparkles /> : <CodeGlyph />}
          </span>
        )),
      )}
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
    href: "/docs/channels",
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
    visual: <DeterminismRuns />,
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
    title: "Durable execution & scheduling",
    icon: <IconWorkflow size={16} />,
    text: "Checkpoints every step. Survives crashes, restarts, and days-long waits. Runs on crons, too.",
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
    href: "/docs/evals",
  },
  {
    title: "Connections & subagents",
    icon: <IconLinked size={16} />,
    text: "Connect to services over MCP and OpenAPI, or delegate to focused subagents. Credentials stay in the runtime.",
    href: "/docs/connections",
  },
  {
    title: "Agent identity & sandboxes",
    icon: <IconShieldCheck size={16} />,
    text: "Bring any OIDC provider and act as the agent or the signed-in user. Code runs in an isolated sandbox per session.",
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
