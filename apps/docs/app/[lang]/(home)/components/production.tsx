import { SiImessage } from "@icons-pack/react-simple-icons";
import {
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
import { type LogoKey, logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import {
  FeatureCard,
  GrayBadge,
  Label,
  RuledList,
  ruledRow,
  Visual,
  pct,
  view,
} from "./control-visual";
import { HomeSection } from "./section";

const hub = { x: 160, y: 90 };
const rings = [44, 80];

// Inner ring on the diagonals, outer ring every 60° from the horizontal, so no two chips meet.
const CHANNELS: {
  label: string;
  logo: (className: string) => ReactNode;
  ring: 0 | 1;
  angle: number;
}[] = [
  ...(
    [
      ["slack", "Slack", 0, 225],
      ["teams", "Microsoft Teams", 0, 315],
      ["whatsapp", "WhatsApp", 0, 45],
    ] as [LogoKey, string, 0 | 1, number][]
  ).map(([key, label, ring, angle]) => ({
    label,
    ring,
    angle,
    logo: (className: string) => logos[key]({ "aria-hidden": true, className }),
  })),
  {
    label: "iMessage",
    ring: 0,
    angle: 135,
    logo: (className: string) => <SiImessage aria-hidden className={className} />,
  },
  ...(
    [
      ["discord", "Discord", 1, 180],
      ["telegram", "Telegram", 1, 240],
      ["googlechat", "Google Chat", 1, 300],
      ["github", "GitHub", 1, 0],
      ["linear", "Linear", 1, 60],
      ["web", "Web", 1, 120],
    ] as [LogoKey, string, 0 | 1, number][]
  ).map(([key, label, ring, angle]) => ({
    label,
    ring,
    angle,
    logo: (className: string) => logos[key]({ "aria-hidden": true, className }),
  })),
];

function channelPoint(ring: 0 | 1, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return { x: hub.x + rings[ring] * Math.cos(radians), y: hub.y + rings[ring] * Math.sin(radians) };
}

function ChannelHub() {
  return (
    <Visual
      caption={`One agent reached from ${CHANNELS.map((channel) => channel.label).join(", ")}.`}
      scene={
        <>
          {rings.map((r) => (
            <circle
              cx={hub.x}
              cy={hub.y}
              key={r}
              r={r}
              stroke="var(--ds-gray-alpha-200)"
              strokeDasharray="2 3"
            />
          ))}
          {CHANNELS.map(({ angle, label, ring }) => {
            const { x, y } = channelPoint(ring, angle);
            return (
              <path
                d={`M${hub.x} ${hub.y}L${x} ${y}`}
                key={label}
                stroke="var(--ds-gray-alpha-400)"
              />
            );
          })}
        </>
      }
    >
      {CHANNELS.map(({ angle, label, logo, ring }) => {
        const { x, y } = channelPoint(ring, angle);
        return (
          <span
            className="absolute flex size-[7.5cqw] -translate-1/2 items-center justify-center rounded-full bg-background-100 text-gray-1000 shadow-(--ds-shadow-border-small)"
            key={label}
            style={{ left: pct(x, view.width), top: pct(y, view.height) }}
          >
            {logo("size-[45%] grayscale")}
          </span>
        );
      })}
      <Label x={hub.x} y={hub.y}>
        Agent
      </Label>
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
    visual: <ChannelHub />,
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
