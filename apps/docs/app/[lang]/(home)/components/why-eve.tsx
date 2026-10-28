import { SiNextdotjs, SiNuxt, SiSvelte } from "@icons-pack/react-simple-icons";
import {
  IconCheck,
  IconChevronRightSmall,
  IconCross,
  IconLogs,
  IconMessage,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HomeSection } from "./section";

// The visuals follow vercel.com's enterprise control visuals: set straight in a 16:9 frame,
// black, white, and gray, thin lines, one black label. Each is drawn on a 320 × 180 canvas
// and scaled with the frame through `cqw` sizes (16px type at a 360px frame).
const view = { width: 320, height: 180 };

function pct(value: number, total: number) {
  return `${(value / total) * 100}%`;
}

function Visual({
  caption,
  children,
  scene,
}: {
  caption: string;
  children?: ReactNode;
  scene?: ReactNode;
}) {
  return (
    <figure className="@container relative m-0 aspect-video w-full overflow-hidden">
      {scene ? (
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          fill="none"
          viewBox={`0 0 ${view.width} ${view.height}`}
        >
          {scene}
        </svg>
      ) : null}
      {children}
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

function Label({ children, x, y }: { children: ReactNode; x: number; y: number }) {
  return (
    <span
      aria-hidden
      className="absolute -translate-1/2 whitespace-nowrap rounded-[0.45em] bg-gray-1000 px-[0.55em] py-[0.2em] font-medium text-[3.05cqw] text-background-100 leading-[1.45]"
      style={{ left: pct(x, view.width), top: pct(y, view.height) }}
    >
      {children}
    </span>
  );
}

/** A dashed line that fades out at both ends. */
function LimitLine({ id, x, y1, y2 }: { id: string; x: number; y1: number; y2: number }) {
  return (
    <>
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={id} x1={x} x2={x} y1={y1} y2={y2}>
          <stop stopColor="var(--ds-gray-1000)" stopOpacity="0" />
          <stop offset="0.14" stopColor="var(--ds-gray-1000)" />
          <stop offset="0.86" stopColor="var(--ds-gray-1000)" />
          <stop offset="1" stopColor="var(--ds-gray-1000)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${x} ${y1}V${y2}`} stroke={`url(#${id})`} strokeDasharray="3 3" />
    </>
  );
}

function GrayBadge({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex h-[1.375em] shrink-0 items-center gap-[0.375em] rounded-full bg-gray-200 px-[0.5em] font-medium text-[0.625em] text-gray-1000 tracking-[0.2px] [&>svg]:size-[1.1em]">
      {icon}
      {children}
    </span>
  );
}

const TOOLS = [
  { name: "bash", state: "Default", Icon: IconCheck },
  { name: "query_crm", state: "Custom", Icon: IconWrench },
  { name: "sleep", state: "Disabled", Icon: IconCross },
  { name: "web_search", state: "Default", Icon: IconCheck },
];

function HarnessTools() {
  return (
    <Visual caption="The agent's tools: bash on by default, a custom query_crm tool added, sleep disabled, and web_search on by default.">
      {/* The fade sits on a frame-sized layer so it ends at the frame, not the list. */}
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_68%,transparent)]">
        <div className="absolute top-[calc(8cqw+1em)] right-0 left-[8%] select-none pl-[1em] text-[4.4cqw]">
          <div className="flex flex-col gap-[1.25em]">
            <span className="font-mono text-[0.8125em] text-gray-900 leading-none">
              agent/tools
            </span>
            <ul className="m-0 flex list-none flex-col divide-y divide-gray-alpha-400 border-gray-alpha-400 border-t p-0 [mask-image:linear-gradient(to_right,black_55%,transparent_92%)]">
              {TOOLS.map(({ Icon, name, state }) => (
                <li className="box-content flex h-[1.25em] items-center py-[0.5em]" key={name}>
                  <span
                    className={cn(
                      "w-[8em] whitespace-nowrap font-mono text-[0.75em] leading-none",
                      state === "Disabled" ? "text-gray-700" : "text-gray-1000",
                    )}
                  >
                    {name}
                  </span>
                  <GrayBadge icon={<Icon />}>{state}</GrayBadge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Visual>
  );
}

const SIGNUPS = [620, 680, 710, 690, 820, 905, 1010, 1284];
const SIGNUPS_MAX = Math.max(...SIGNUPS);

function SignupsChart() {
  return (
    <div className="flex h-[3em] items-end gap-[0.18em] border-gray-alpha-400 border-b">
      {SIGNUPS.map((value, i) => (
        <span
          className={cn(
            "flex-1 rounded-t-[0.15em]",
            i === SIGNUPS.length - 1
              ? "bg-gray-1000"
              : "border border-gray-alpha-500 border-b-0 bg-linear-to-b from-gray-200 to-transparent",
          )}
          key={i}
          style={{ height: `${(value / SIGNUPS_MAX) * 100}%` }}
        />
      ))}
    </div>
  );
}

// Back to front. Each window covers the one behind it but for a sliver, so the back two
// show only their framework and the start of their agent's reply.
const APPS = [
  { name: "Next.js", Logo: SiNextdotjs, x: 16, reply: "Refund approved for order 4821" },
  { name: "Nuxt", Logo: SiNuxt, x: 84, reply: "Rolled back the Friday deploy" },
  { name: "SvelteKit", Logo: SiSvelte, x: 152, reply: null },
];

function AgentUi() {
  return (
    <Visual caption="Three agent apps in overlapping windows, built with Next.js, Nuxt, and SvelteKit. The front one answers a question about signups with a bar chart.">
      {/* The fade sits on a frame-sized layer so it ends at the frame, not the windows. */}
      <div className="absolute inset-0 [mask-composite:intersect] [mask-image:linear-gradient(to_bottom,black_72%,transparent),linear-gradient(to_right,black_90%,transparent)]">
        {APPS.map(({ Logo, name, reply, x }) => (
          <div
            className="absolute top-[15%] -bottom-[10%] flex w-[75%] select-none flex-col gap-[0.75em] rounded-[0.75em] bg-background-100 px-[0.75em] pt-[0.5em] text-[4.4cqw] shadow-(--ds-shadow-border-small)"
            key={name}
            style={{ left: pct(x, view.width) }}
          >
            <div aria-hidden className="mt-[0.25em] flex gap-[0.25em]">
              <span className="size-[0.5em] rounded-full bg-gray-alpha-400" />
              <span className="size-[0.5em] rounded-full bg-gray-alpha-400" />
              <span className="size-[0.5em] rounded-full bg-gray-alpha-400" />
            </div>
            <span className="flex items-center gap-[0.4em] whitespace-nowrap text-[0.75em] text-gray-1000 leading-none [&>svg]:size-[1em] [&>svg]:shrink-0">
              <Logo aria-hidden />
              {name}
            </span>
            {reply ? (
              <span className="whitespace-nowrap text-[0.625em] text-gray-900 leading-none">
                {reply}
              </span>
            ) : (
              <div className="flex w-[9em] flex-col gap-[0.5em]">
                <span className="self-end whitespace-nowrap rounded-full bg-gray-200 px-[0.6em] py-[0.3em] text-[0.625em] text-gray-1000 leading-none">
                  Signups trend?
                </span>
                <SignupsChart />
              </div>
            )}
          </div>
        ))}
      </div>
    </Visual>
  );
}

// One turn as Agent Runs times it, in milliseconds from the turn start.
const STEPS = [
  { name: "claude-opus-5.5", start: 0, end: 800 },
  { name: "oncall-runbook", start: 800, end: 1000 },
  { name: "search_logs", start: 1000, end: 1700 },
  { name: "get_deploy", start: 1700, end: 2000 },
  { name: "claude-opus-5.5", start: 2000, end: 2900 },
];
const TURN_MS = 2900;
const track = { x: 132, width: 156 };
const rowY = (i: number) => 50 + i * 22;
const spanHeight = 10;

function AgentTrace() {
  const end = track.x + track.width;
  return (
    <Visual
      caption="A trace of one 2.9 second turn: a model call, the oncall-runbook skill, the search_logs and get_deploy tools, then a second model call."
      scene={
        <>
          {STEPS.map((step, i) => {
            const y = rowY(i);
            return (
              <g key={`${step.name}-${i}`}>
                <path
                  d={`M${track.x} ${y}H${end}`}
                  stroke="var(--ds-gray-alpha-200)"
                  strokeDasharray="2 3"
                />
                <rect
                  fill="var(--ds-gray-200)"
                  height={spanHeight}
                  rx={2}
                  stroke="var(--ds-gray-alpha-500)"
                  width={((step.end - step.start) / TURN_MS) * track.width}
                  x={track.x + (step.start / TURN_MS) * track.width}
                  y={y - spanHeight / 2}
                />
              </g>
            );
          })}
          <LimitLine id="why-eve-turn-end" x={end} y1={32} y2={166} />
        </>
      }
    >
      <ul className="m-0 list-none p-0 text-[4.4cqw]">
        {STEPS.map((step, i) => (
          <li
            className="absolute -translate-y-1/2 whitespace-nowrap font-mono text-[0.625em] text-gray-1000 leading-none"
            key={`${step.name}-${i}`}
            style={{ left: pct(32, view.width), top: pct(rowY(i), view.height) }}
          >
            {step.name}
          </li>
        ))}
      </ul>
      <Label x={end} y={24}>
        {(TURN_MS / 1000).toFixed(1)}s
      </Label>
    </Visual>
  );
}

function Reason({
  title,
  href,
  icon,
  children,
  visual,
}: {
  title: string;
  href: string;
  icon: ReactNode;
  children: ReactNode;
  visual: ReactNode;
}) {
  return (
    <li className="min-w-0 md:col-span-6 lg:col-span-4">
      <Link className="group flex flex-col gap-3" href={href} prefetch={true}>
        <div className="relative mb-5 overflow-hidden rounded-xs border border-gray-300">
          {visual}
        </div>
        <h3 className="flex items-center gap-3 font-[450] text-copy-16 text-gray-1000 [&>svg:first-child]:shrink-0">
          {icon}
          {title}
          <IconChevronRightSmall
            aria-hidden
            className="-ml-1 -translate-x-px transition-transform group-hover:translate-x-0"
            size={14}
          />
        </h3>
        <p className="max-w-[34ch] text-pretty text-copy-16 text-gray-900 transition-colors group-hover:text-gray-1000 lg:text-copy-18">
          {children}
        </p>
      </Link>
    </li>
  );
}

export function WhyEve(): JSX.Element {
  return (
    <HomeSection
      id="why-eve"
      lede="Customize at every layer, from the harness to the UI to every agent run."
      title="Own your intelligence"
    >
      <ul className="m-0 grid list-none gap-x-6 gap-y-16 p-0 md:grid-cols-12">
        <Reason
          href="/docs/concepts/default-harness"
          icon={<IconWrench aria-hidden size={16} />}
          title="Own your harness"
          visual={<HarnessTools />}
        >
          Start with great defaults. Turn off what you don't need, extend what you do. Scale from
          side project to enterprise.
        </Reason>
        <Reason
          href="/docs/guides/frontend/overview"
          icon={<IconMessage aria-hidden size={16} />}
          title="Own your agent UI"
          visual={<AgentUi />}
        >
          Build rich agent UIs natively in Next.js, Nuxt, SvelteKit, and TanStack. Ship agent and
          app in one deploy.
        </Reason>
        <Reason
          href="/docs/observability/instrumentation"
          icon={<IconLogs aria-hidden size={16} />}
          title="Own your data"
          visual={<AgentTrace />}
        >
          Govern and observe every run with OpenTelemetry traces of each model and tool call.
          Credentials never reach the model.
        </Reason>
      </ul>
    </HomeSection>
  );
}
