import { SiNextdotjs, SiNuxt, SiSvelte } from "@icons-pack/react-simple-icons";
import {
  IconCheck,
  IconCross,
  IconMessage,
  IconShieldCheck,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import { Database, KeyRound, UserRound } from "lucide-react";
import type { JSX } from "react";
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
      {/* The front window runs past the frame's right edge and fades out before it. Only the
          frame's background is behind it there, so a mask reads as fading into the page. */}
      <div
        aria-hidden
        className="absolute inset-0 select-none text-[4.57cqw] [mask-image:linear-gradient(to_right,black_80%,transparent)]"
      >
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

// Your runtime as a dashed boundary: credentials, run data, and user access stay inside it with
// the agent, and the one line out carries tool results to the model.
const boundary = { x: 16, y: 34, width: 208, height: 128 };
const agentNode = { x: 150, y: 84, width: 56, height: 24 };
const modelNode = { x: 254, y: 84, width: 50, height: 24 };
// Where the kept items' badges end, right-aligned, and their lines to the agent begin.
const keptEnd = 122;
const KEPT = [
  { name: "credentials", Icon: KeyRound, y: 64 },
  { name: "run data", Icon: Database, y: 96 },
  { name: "access", Icon: UserRound, y: 128 },
];

function DataBoundary() {
  const midY = agentNode.y + agentNode.height / 2;
  return (
    <Visual
      caption="Your runtime holds the agent with its credentials, run data, and per-user access. Only tool results leave it, for the model outside."
      scene={
        <>
          <rect
            height={boundary.height}
            rx={8}
            stroke="var(--ds-gray-alpha-600)"
            strokeDasharray="3 3"
            width={boundary.width}
            x={boundary.x}
            y={boundary.y}
          />
          {KEPT.map(({ name, y }) => (
            <path
              d={`M${keptEnd + 4} ${y}C${keptEnd + 18} ${y} ${agentNode.x - 14} ${midY} ${agentNode.x} ${midY}`}
              key={name}
              stroke="var(--ds-gray-alpha-400)"
            />
          ))}
          <rect
            fill="var(--ds-gray-200)"
            height={agentNode.height}
            rx={4}
            stroke="var(--ds-gray-alpha-500)"
            width={agentNode.width}
            x={agentNode.x}
            y={agentNode.y}
          />
          <path
            d={`M${agentNode.x + agentNode.width} ${midY}H${modelNode.x}`}
            stroke="var(--ds-gray-alpha-600)"
          />
          <rect
            fill="var(--ds-background-100)"
            height={modelNode.height}
            rx={4}
            stroke="var(--ds-gray-alpha-500)"
            strokeDasharray="2 2"
            width={modelNode.width}
            x={modelNode.x}
            y={modelNode.y}
          />
        </>
      }
    >
      <div className="select-none text-[4.4cqw]">
        {KEPT.map(({ Icon, name, y }) => (
          <span
            className="absolute -translate-x-full -translate-y-1/2"
            key={name}
            style={{ left: pct(keptEnd, view.width), top: pct(y, view.height) }}
          >
            <GrayBadge icon={<Icon aria-hidden />}>{name}</GrayBadge>
          </span>
        ))}
        <span
          className="absolute -translate-1/2 font-mono text-[0.625em] text-gray-1000 leading-none"
          style={{
            left: pct(agentNode.x + agentNode.width / 2, view.width),
            top: pct(midY, view.height),
          }}
        >
          agent
        </span>
        <span
          className="absolute -translate-1/2 font-mono text-[0.625em] text-gray-900 leading-none"
          style={{
            left: pct(modelNode.x + modelNode.width / 2, view.width),
            top: pct(midY, view.height),
          }}
        >
          model
        </span>
        <span
          className="absolute -translate-1/2 text-[0.5em] text-gray-900 leading-none"
          style={{
            left: pct((boundary.x + boundary.width + modelNode.x) / 2, view.width),
            top: pct(midY - 8, view.height),
          }}
        >
          results
        </span>
      </div>
      <Label x={boundary.x + boundary.width / 2} y={boundary.y}>
        Your runtime
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
          href="/docs/guides/deployment/self-hosting"
          icon={<IconShieldCheck aria-hidden size={16} />}
          title="Own your data"
          visual={<DataBoundary />}
        >
          You own the runtime and decide where run data lives. Each user reaches only what they're
          granted, and credentials never reach the model.
        </FeatureCard>
      </ul>
    </HomeSection>
  );
}
