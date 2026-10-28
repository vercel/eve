import { SiNextdotjs, SiNuxt, SiSvelte } from "@icons-pack/react-simple-icons";
import {
  IconCheck,
  IconCross,
  IconLogs,
  IconMessage,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import {
  FeatureCard,
  GrayBadge,
  Label,
  LimitLine,
  RuledList,
  ruledRow,
  Visual,
  pct,
  view,
} from "./control-visual";
import { HomeSection } from "./section";

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
        <RuledList header={<span className="font-mono">agent/tools</span>}>
          {TOOLS.map(({ Icon, name, state }) => (
            <li className={ruledRow} key={name}>
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
        </RuledList>
      </div>
    </Visual>
  );
}

// The template thumbnail's window from vercel.com/docs, three times, back to front, each
// covering the one behind it but for a sliver. Sizes are front's px values in `em` (1em =
// 16px at a 350px frame), so the windows scale with the frame.
// In % of the frame: each back window shows a `sliver` before the next covers it, and the
// front one runs past the right edge.
const windowWidth = 55;
const sliver = 22;
const APPS = [
  { name: "SvelteKit", Logo: SiSvelte, left: 5, back: true },
  { name: "Nuxt", Logo: SiNuxt, left: 5 + sliver, back: true },
  { name: "Next.js", Logo: SiNextdotjs, left: 5 + 2 * sliver, back: false },
];

function AgentUi() {
  return (
    <Visual caption="Three agent apps in overlapping windows, built with Next.js in front, Nuxt, and SvelteKit.">
      <div aria-hidden className="absolute inset-0 select-none text-[4.57cqw]">
        {APPS.map(({ Logo, back, left, name }) => (
          <div
            className="absolute top-[17%] flex min-h-full flex-col gap-[0.625em] rounded-t-[0.625em] border border-gray-300 bg-background-100 px-[0.75em] pt-[0.25em]"
            key={name}
            style={{ left: `${left}%`, width: `${windowWidth}%` }}
          >
            <div className="flex h-[1em] items-center">
              <div className="mt-[0.25em] flex gap-[0.25em]">
                <span className="size-[0.4375em] rounded-full bg-gray-300" />
                <span className="size-[0.4375em] rounded-full bg-gray-300" />
                <span className="size-[0.4375em] rounded-full bg-gray-300" />
              </div>
            </div>
            <div className="flex flex-col gap-[0.5em]">
              {/* The fill hides overlapping contours and the inner half of the stroke, leaving
                  a 0.5px outer outline. The logo gets the same treatment as the name. */}
              <div className="flex items-center gap-[0.35em] whitespace-nowrap font-bold text-[1.25em] text-gray-700 tracking-[-0.01em] [-webkit-text-fill-color:var(--ds-background-100)] [-webkit-text-stroke:1px_currentColor] [paint-order:stroke_fill]">
                <Logo className="size-[0.9em] shrink-0 overflow-visible fill-background-100 stroke-current [paint-order:stroke_fill] [stroke-width:1px] [vector-effect:non-scaling-stroke] [&_path]:[vector-effect:non-scaling-stroke]" />
                {name}
              </div>
              <div className="h-[1.3125em] w-3/4 shrink-0 rounded-[3px] bg-gray-200" />
              <div className="mt-px h-[3.625em] shrink-0 rounded-[3px] bg-linear-to-b from-gray-200 to-background-100" />
            </div>
            {/* A back window recedes, border and all, toward the page across the sliver it
                shows, starting a third of the way in and stopping short of the page color.
                Drawn over the window rather than as a mask, which would show the window
                behind instead of the page. */}
            {back ? (
              <span
                className="pointer-events-none absolute -inset-px rounded-t-[inherit]"
                style={{
                  background: `linear-gradient(to right, transparent ${(sliver / 3 / windowWidth) * 100}%, color-mix(in srgb, var(--ds-background-200) 60%, transparent) ${(sliver / windowWidth) * 100}%)`,
                }}
              />
            ) : null}
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

export function WhyEve(): JSX.Element {
  return (
    <HomeSection
      id="why-eve"
      lede="Customize at every layer, from the harness to the UI to every agent run."
      title="Own your intelligence"
    >
      <ul className="m-0 grid list-none gap-x-6 gap-y-16 p-0 md:grid-cols-12">
        <FeatureCard
          className="md:col-span-6 lg:col-span-4"
          href="/docs/concepts/default-harness"
          icon={<IconWrench aria-hidden size={16} />}
          title="Own your harness"
          visual={<HarnessTools />}
        >
          Start with great defaults. Turn off what you don't need, extend what you do. Scale from
          side project to enterprise.
        </FeatureCard>
        <FeatureCard
          className="md:col-span-6 lg:col-span-4"
          href="/docs/guides/frontend/overview"
          icon={<IconMessage aria-hidden size={16} />}
          title="Own your agent UI"
          visual={<AgentUi />}
        >
          Build rich agent UIs natively in Next.js, Nuxt, SvelteKit, and TanStack. Ship agent and
          app in one deploy.
        </FeatureCard>
        <FeatureCard
          className="md:col-span-6 lg:col-span-4"
          href="/docs/observability/instrumentation"
          icon={<IconLogs aria-hidden size={16} />}
          title="Own your data"
          visual={<AgentTrace />}
        >
          Govern and observe every run with OpenTelemetry traces of each model and tool call.
          Credentials never reach the model.
        </FeatureCard>
      </ul>
    </HomeSection>
  );
}
