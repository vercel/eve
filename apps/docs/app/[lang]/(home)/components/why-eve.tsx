import {
  SiAnthropic,
  SiGooglegemini,
  SiNuxt,
  SiSvelte,
  SiVercel,
} from "@icons-pack/react-simple-icons";
import {
  IconCheck,
  IconCross,
  IconMessage,
  IconShieldCheck,
  IconWrench,
} from "@vercel/geistdocs/assets/icons";
import { LogoNextJs } from "@vercel/geistdocs/assets/logos";
import type { ComponentProps, JSX } from "react";
import { cn } from "@/lib/utils";
import { FeatureCard, GrayBadge, RuledList, ruledRow, Visual, pct, view } from "./control-visual";
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
// The names' 0.5px outline, as text shadows around text filled with the window's color. A stroke
// with a covering fill doesn't work: Safari ignores paint-order on HTML text, and draws stroked
// and filled text on slightly different pixel grids, so the two never line up.
const textOutline = [
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
  [0.35, 0.35],
  [-0.35, 0.35],
  [0.35, -0.35],
  [-0.35, -0.35],
]
  .map(([x, y]) => `${x}px ${y}px 0 var(--ds-gray-700)`)
  .join(", ");

const APPS = [
  { name: "SvelteKit", Logo: SiSvelte, left: 5, back: true },
  { name: "Nuxt", Logo: SiNuxt, left: 5 + sliver, back: true },
  { name: "Next.js", Logo: LogoNextJs, left: 5 + 2 * sliver, back: false },
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
              {/* The names and the back windows' logos read as 0.5px outlines; the front window
                  shows the filled Next.js mark as the visual's accent. */}
              <div className="flex items-center gap-[0.35em] whitespace-nowrap font-bold text-[1.25em] text-gray-700 tracking-[-0.01em]">
                {back ? (
                  <Logo className="size-[0.9em] shrink-0 overflow-visible fill-background-100 stroke-current [paint-order:stroke_fill] [stroke-width:1px] [vector-effect:non-scaling-stroke] [&_path]:[vector-effect:non-scaling-stroke]" />
                ) : (
                  <Logo className="size-[0.9em] shrink-0 text-gray-1000" />
                )}
                <span className="text-background-100" style={{ textShadow: textOutline }}>
                  {name}
                </span>
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

// The installed simple-icons React package has no OpenAI mark, so its path comes from
// simple-icons directly.
function SiOpenai(props: ComponentProps<"svg">) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

const PROVIDERS = [
  { name: "OpenAI", Logo: SiOpenai },
  { name: "Anthropic", Logo: SiAnthropic },
  { name: "Google Gemini", Logo: SiGooglegemini },
];

// Your data drifts through the channel from right to left as rounded squares, in focus inside
// your runtime's frame: they grow and darken toward its middle and shrink and fade outside it.
// The models stack above and Vercel, the host, below, each running past its edge of the frame
// and fading out before it, like the Next.js window; the data passes between them and touches
// neither.
const center = { x: 160, y: 86 };
const stack = { x: 52, width: 216 };
const modelBottom = 50;
const hostTop = 122;

// Viewfinder corners framing the channel between the stacks, each arm fading out from its
// corner.
const capture = { x1: stack.x, x2: stack.x + stack.width, y1: modelBottom + 8, y2: hostTop - 8 };
const arm = { x: 24, y: 14 };
const ARMS = [
  [capture.x1, capture.y1, 1, 1],
  [capture.x2, capture.y1, -1, 1],
  [capture.x1, capture.y2, 1, -1],
  [capture.x2, capture.y2, -1, -1],
].flatMap(([x, y, dx, dy]) => [
  { id: `why-eve-arm-${x}-${y}-x`, x1: x, y1: y, x2: x + dx * arm.x, y2: y },
  { id: `why-eve-arm-${x}-${y}-y`, x1: x, y1: y, x2: x, y2: y + dy * arm.y },
]);

// A seeded random scatter: the same squares on every render, placed loosely enough that no two
// line up, never overlapping, and clear of the frame's corners.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const particleCount = 60;
const PARTICLES: { x: number; y: number; size: number; opacity: number; angle: number }[] = [];
const random = seededRandom(7);
for (let attempt = 0; PARTICLES.length < particleCount && attempt < 2000; attempt++) {
  const x = -4 + random() * (view.width + 8);
  const y = center.y + 5 * Math.sin((x / view.width) * Math.PI * 1.4 + 0.4) + (random() - 0.5) * 42;
  const focus = Math.exp(-(((x - center.x) / 72) ** 2));
  const size = (2.5 + 7.5 * focus) * (0.8 + random() * 0.4);
  const nearCorner =
    Math.min(Math.abs(x - capture.x1), Math.abs(x - capture.x2)) < arm.x + size &&
    Math.min(Math.abs(y - capture.y1), Math.abs(y - capture.y2)) < arm.y + size;
  const clear = PARTICLES.every(
    (other) => Math.hypot(other.x - x, other.y - y) > (other.size + size) * 0.65 + 1,
  );
  if (nearCorner || !clear) continue;
  PARTICLES.push({
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    size: Math.round(size * 100) / 100,
    // Full gray-500 at the center, fading toward the edges about as light as before.
    opacity: Math.round((0.35 + 0.65 * focus) * 100) / 100,
    angle: Math.round((random() - 0.5) * 60),
  });
}

// Three particles around the center, drawn in full as the data the runtime holds: one low on the
// left, one high in the middle, one low on the right.
const ACCENT_PARTICLES = new Set([53, 51, 2]);

function DataBoundary() {
  return (
    <Visual
      caption="Rounded squares represent data in your runtime, with model providers above and a hosting provider below. Choose your model routing and hosting infrastructure when self-hosting."
      scene={
        <>
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id="why-eve-model-fade"
              x1={0}
              x2={0}
              y1={modelBottom}
              y2={0}
            >
              <stop stopColor="white" />
              <stop offset="0.3" stopColor="white" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id="why-eve-model">
              <rect fill="url(#why-eve-model-fade)" height={view.height} width={view.width} />
            </mask>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id="why-eve-host-fade"
              x1={0}
              x2={0}
              y1={hostTop}
              y2={view.height}
            >
              <stop stopColor="white" />
              <stop offset="0.3" stopColor="white" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id="why-eve-host">
              <rect fill="url(#why-eve-host-fade)" height={view.height} width={view.width} />
            </mask>
            {ARMS.map(({ id, x1, x2, y1, y2 }) => (
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id={id}
                key={id}
                x1={x1}
                x2={x2}
                y1={y1}
                y2={y2}
              >
                <stop stopColor="var(--ds-gray-1000)" />
                <stop offset="1" stopColor="var(--ds-gray-1000)" stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          <rect
            fill="var(--ds-background-100)"
            height={modelBottom + 8}
            mask="url(#why-eve-model)"
            rx={8}
            stroke="var(--ds-gray-alpha-400)"
            width={stack.width}
            x={stack.x}
            y={-8}
          />
          <rect
            fill="var(--ds-background-100)"
            height={view.height - hostTop + 8}
            mask="url(#why-eve-host)"
            rx={8}
            stroke="var(--ds-gray-alpha-400)"
            width={stack.width}
            x={stack.x}
            y={hostTop}
          />
          <g fill="var(--ds-gray-500)">
            {PARTICLES.map(({ angle, opacity, size, x, y }, index) => (
              <rect
                fill={ACCENT_PARTICLES.has(index) ? "var(--ds-gray-1000)" : undefined}
                fillOpacity={ACCENT_PARTICLES.has(index) ? 1 : opacity}
                height={size}
                key={`${x}-${y}`}
                rx={size * 0.22}
                transform={`rotate(${angle} ${x} ${y})`}
                width={size}
                x={x - size / 2}
                y={y - size / 2}
              />
            ))}
          </g>
          {ARMS.map(({ id, x1, x2, y1, y2 }) => (
            <path d={`M${x1} ${y1}L${x2} ${y2}`} key={id} stroke={`url(#${id})`} />
          ))}
        </>
      }
    >
      <div className="select-none text-[4.4cqw]">
        <span
          className="absolute flex -translate-1/2 items-center gap-[1.25em] text-gray-1000"
          style={{
            left: pct(stack.x + stack.width / 2, view.width),
            top: pct(modelBottom / 2, view.height),
          }}
        >
          {PROVIDERS.map(({ Logo, name }) => (
            <Logo aria-label={name} className="size-[1em]" key={name} role="img" />
          ))}
        </span>
        <SiVercel
          aria-label="Vercel"
          className="absolute size-[0.75em] -translate-1/2 text-gray-1000"
          role="img"
          style={{
            left: pct(stack.x + stack.width / 2, view.width),
            top: pct((hostTop + view.height) / 2, view.height),
          }}
        />
      </div>
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
          href="/docs/guides/frontend"
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
          Control where your agent runs and who can access it. Self-host with your own workflow
          storage, sandbox provider, and model routing.
        </FeatureCard>
      </ul>
    </HomeSection>
  );
}
