"use client";

import {
  Activity,
  Check,
  CircleDot,
  CodeXml,
  GitMerge,
  GitPullRequestArrow,
  Headset,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { IconBox, IconCheck } from "@vercel/geistdocs/assets/icons";
import { LogoIconMicrosoftTeamsSvg } from "@vercel/geistdocs/assets/logos/logo-icon-microsoft-teams-svg";
import { Button } from "@vercel/geistdocs/components/button";
import {
  type ComponentType,
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SiWhatsapp } from "@icons-pack/react-simple-icons";
import { logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { monochromeLogo } from "./control-visual";

type Platform = "slack" | "teams" | "whatsapp";

/** Agents get an icon avatar and an "Agent" badge; people get their initial. */
type Author = { name: string; icon?: ComponentType<{ className?: string }> };

const AUTHORS = {
  Coder: { name: "Coder", icon: CodeXml },
  Reviewer: { name: "Reviewer", icon: ScanSearch },
  Ops: { name: "Ops", icon: Activity },
  Dana: { name: "Dana" },
  Concierge: { name: "Acme Org", icon: Headset },
  Maya: { name: "Maya" },
} satisfies Record<string, Author>;

type AuthorKey = keyof typeof AUTHORS;

/** Each beat waits `delay` ms before it appears; while it waits, its author shows as working. */
type Beat =
  | {
      kind: "message";
      author: AuthorKey;
      time: string;
      body: ReactNode;
      attachment?: ReactNode;
      delay: number;
    }
  | {
      kind: "reactions";
      reactions: { emoji: keyof typeof TEXT_EMOJI; count: number }[];
      delay: number;
    };

function Mention({ children }: { children: string }) {
  return <span className="rounded bg-gray-alpha-200 px-0.5 text-gray-1000">@{children}</span>;
}

function Card({
  icon,
  title,
  meta,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mt-2 flex max-w-[24rem] gap-2.5 rounded-lg border border-gray-alpha-400 bg-background-100 px-3 py-2.5">
      <span aria-hidden className="mt-0.5 text-gray-900 [&>svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-copy-14 text-gray-1000">{title}</span>
        <span className="truncate text-copy-13 text-gray-900">{meta}</span>
        {children}
      </div>
    </div>
  );
}

function ChatButton({ children, primary }: { children: string; primary?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-md px-3 font-medium text-label-13",
        primary
          ? "bg-gray-1000 text-background-100"
          : "bg-background-100 text-gray-1000 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Teams renders agent replies as Adaptive Cards, laid out as Microsoft's agent design guidance
 * describes: a concise title, a body that leads with the key facts as a fact set, and only the
 * essential actions, left-aligned with the primary first.
 */
function AdaptiveCard({
  title,
  facts,
  actions,
}: {
  title: string;
  facts: [string, string][];
  actions: [string, string];
}) {
  return (
    <div className="mt-2 max-w-[24rem] rounded-lg bg-background-100 p-4 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
      <p className="font-semibold text-copy-14">{title}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-copy-13">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-gray-900">{label}</dt>
            <dd className="text-gray-1000">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex gap-2">
        <ChatButton primary>{actions[0]}</ChatButton>
        <ChatButton>{actions[1]}</ChatButton>
      </div>
    </div>
  );
}

const REVIEW_CHECKS = [
  "Correctness: merge handles empty and duplicate carts",
  "Tests: 4 new cases cover the regression",
  "Security: cart ownership verified, no secrets in logs",
];

const SLACK_BEATS: Beat[] = [
  {
    kind: "message",
    author: "Coder",
    time: "10:02 AM",
    body: "Picked up a P1 bug and reproduced it in a sandbox.",
    attachment: (
      <Card
        icon={<CircleDot />}
        meta="acme/storefront#412 · opened by Dana"
        title="Saved carts disappear after sign-in"
      />
    ),
    delay: 600,
  },
  {
    kind: "message",
    author: "Coder",
    time: "10:26 AM",
    body: (
      <>
        Fixed, with tests. <Mention>Reviewer</Mention> ready for review.
      </>
    ),
    attachment: (
      <Card
        icon={<GitPullRequestArrow />}
        meta="acme/storefront#418 · +84 −12 · 6 checks passed"
        title="fix(cart): keep guest items after sign-in"
      />
    ),
    delay: 2400,
  },
  {
    kind: "message",
    author: "Reviewer",
    time: "10:33 AM",
    body: (
      <>
        The merge logic is right, but the security pass flagged one thing. <Mention>Coder</Mention>
      </>
    ),
    attachment: (
      <Card
        icon={<ShieldAlert />}
        meta="cart/session.ts:42 · could pull another guest's cart into an account"
        title="Guest cart ID is trusted from the cookie"
      />
    ),
    delay: 2600,
  },
  {
    kind: "message",
    author: "Coder",
    time: "10:38 AM",
    body: "Good catch. The merge now checks the guest cart belongs to the signing-in session, with a test for it. Pushed.",
    attachment: (
      <code className="mt-1 block truncate font-mono text-copy-13-mono text-gray-900">
        pnpm vitest cart/session · 4 passed
      </code>
    ),
    delay: 2400,
  },
  {
    kind: "message",
    author: "Reviewer",
    time: "10:41 AM",
    body: "Verified the fix. Security pass is clean, approving.",
    attachment: (
      <Card
        icon={<ShieldCheck />}
        meta="acme/storefront#418 · approved by Reviewer"
        title="fix(cart): keep guest items after sign-in"
      >
        <ul className="mt-1.5 flex list-none flex-col gap-1 p-0">
          {REVIEW_CHECKS.map((check) => (
            <li className="flex items-center gap-1.5 text-copy-13 text-gray-900" key={check}>
              <Check aria-hidden className="size-3.5 shrink-0 text-gray-1000" />
              <span className="truncate">{check}</span>
            </li>
          ))}
        </ul>
      </Card>
    ),
    delay: 2200,
  },
  {
    kind: "message",
    author: "Coder",
    time: "10:42 AM",
    body: "Merged and closed the issue. It goes out with the next deploy.",
    attachment: (
      <Card
        icon={<GitMerge />}
        meta="acme/storefront#418 · merged into main · closed #412"
        title="fix(cart): keep guest items after sign-in"
      />
    ),
    delay: 1600,
  },
  {
    kind: "reactions",
    reactions: [{ emoji: "LFG", count: 1 }],
    delay: 900,
  },
];

const TEAMS_BEATS: Beat[] = [
  {
    kind: "message",
    author: "Ops",
    time: "2:14 PM",
    body: "Checkout p95 latency is up 4x since the 2:05 PM deploy.",
    attachment: (
      <Card
        icon={<Activity />}
        meta="storefront · p95 2.4s · started 2:06 PM"
        title="Checkout latency is degraded"
      />
    ),
    delay: 600,
  },
  {
    kind: "message",
    author: "Ops",
    time: "2:16 PM",
    body: "Traced it to a cart query added in #421. Rolling back is the fastest fix.",
    attachment: (
      <AdaptiveCard
        actions={["Roll back", "Not now"]}
        facts={[
          ["Service", "storefront"],
          ["Deploys to", "Previous deployment (1:42 PM)"],
          ["Time", "About 30 seconds"],
        ]}
        title="Roll back production?"
      />
    ),
    delay: 2200,
  },
  {
    kind: "message",
    author: "Dana",
    time: "2:17 PM",
    body: "Approved, go ahead.",
    delay: 2400,
  },
  {
    kind: "message",
    author: "Ops",
    time: "2:18 PM",
    body: "Rolled back. p95 is at 610 ms and holding. I opened an issue to fix the query.",
    attachment: (
      <Card
        icon={<CircleDot />}
        meta="acme/storefront#424 · assigned to Coder"
        title="perf(cart): index guest cart lookups"
      />
    ),
    delay: 2200,
  },
];

const WHATSAPP_BEATS: Beat[] = [
  {
    kind: "message",
    author: "Maya",
    time: "9:12 AM",
    body: "Hi, my order still hasn't arrived.",
    delay: 600,
  },
  {
    kind: "message",
    author: "Concierge",
    time: "9:12 AM",
    body: "Sorry about that, Maya. Order #4821 has been held at the Oakland depot since Monday.",
    delay: 2000,
  },
  {
    kind: "message",
    author: "Concierge",
    time: "9:12 AM",
    body: (
      <>
        <span className="block font-semibold">Send a replacement?</span>
        A new one ships today and arrives Thursday.
        <br />
        <span className="mt-1 inline-block text-copy-13 text-gray-900">Order #4821</span>
      </>
    ),
    attachment: (
      <ReplyButtons
        buttons={[
          { label: "Send replacement", icon: <IconBox aria-hidden size={16} /> },
          { label: "Refund instead", icon: <IconCoins /> },
        ]}
      />
    ),
    delay: 1600,
  },
  {
    kind: "message",
    author: "Maya",
    time: "9:13 AM",
    body: (
      <>
        <Quote author="Acme Org">Send a replacement?</Quote>
        Send replacement
      </>
    ),
    delay: 2400,
  },
  {
    kind: "message",
    author: "Concierge",
    time: "9:13 AM",
    body: "Done. It ships today with tracking 1Z 999 AA1 0123 4567. I'll message you when it's out for delivery.",
    delay: 1800,
  },
];

const CONVERSATIONS: {
  id: Platform;
  label: string;
  logo: (className: string) => ReactNode;
  beats: Beat[];
}[] = [
  {
    id: "slack",
    label: "Software Factory",
    logo: (className) =>
      logos.slack({ "aria-hidden": true, className: cn(className, monochromeLogo) }),
    beats: SLACK_BEATS,
  },
  {
    id: "teams",
    label: "Operations",
    logo: (className) => <LogoIconMicrosoftTeamsSvg aria-hidden className={className} size={16} />,
    beats: TEAMS_BEATS,
  },
  {
    id: "whatsapp",
    label: "Customer Support",
    logo: (className) => <SiWhatsapp aria-hidden className={className} />,
    beats: WHATSAPP_BEATS,
  },
];

const REACTIONS_KEY = "eve-home-reactions";

// Vercel's custom Slack emoji: a short word in white on a colored tile.
const TEXT_EMOJI = {
  LFG: "bg-pink-700",
};

function TextEmoji({ name }: { name: keyof typeof TEXT_EMOJI }) {
  return (
    <span
      aria-label={`:${name.toLowerCase()}:`}
      className={cn(
        "inline-flex size-4 items-center justify-center rounded-[4px] font-bold text-[6.5px] text-white leading-none tracking-wide",
        TEXT_EMOJI[name],
      )}
      role="img"
    >
      {name}
    </span>
  );
}

function authorOf(beat: Beat | undefined): AuthorKey | undefined {
  return beat?.kind === "message" ? beat.author : undefined;
}

// Agent avatars take each platform's accent: Slack's aubergine purple, Teams' blue-violet.
const AGENT_AVATAR = {
  slack: "border-transparent bg-purple-700 text-white",
  teams: "border-transparent bg-blue-700 text-white",
};

function Avatar({ author, platform }: { author: Author; platform: keyof typeof AGENT_AVATAR }) {
  const Icon = author.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-gray-alpha-400 font-medium text-label-14",
        Icon ? AGENT_AVATAR[platform] : "bg-background-100 text-gray-1000",
      )}
    >
      {Icon ? <Icon className="size-4" /> : author.name[0]}
    </span>
  );
}

/**
 * A message's card or buttons fade in a beat after its bubble, like vercel.com/sandbox's agent
 * actions (200ms ease-out), so a message reads as one entrance instead of two at once.
 */
function Attachment({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      className="animate-command-fade-in"
      // Inline, since the animation shorthand would reset a class-set delay.
      style={{ animationDelay: "60ms" }}
    >
      {children}
    </div>
  );
}

// The agent's replies are wider and taller than people's short messages, so they start closer
// to full size to travel about as far as they scale in.
const agentEntrance = "[--bubble-from:0.9]";

/** Slack: avatar, name, Agent badge, time; consecutive messages fold under the first. */
function ThreadMessage({
  author,
  time,
  continued,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "grid origin-top-left grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5 motion-safe:animate-bubble-in motion-reduce:animate-fade-in",
        author.icon && agentEntrance,
        continued ? "pt-2" : "pt-4",
      )}
    >
      {continued ? <span /> : <Avatar author={author} platform="slack" />}
      <div className="min-w-0 max-w-[20rem] text-copy-14 text-gray-1000">
        {continued ? (
          <span className="sr-only">{author.name}</span>
        ) : (
          <p className="flex items-baseline gap-1.5">
            <span className="font-medium">{author.name}</span>
            {author.icon ? (
              <span className="rounded bg-gray-alpha-200 px-1 text-label-12 text-gray-900">
                Agent
              </span>
            ) : null}
            <span className="text-copy-13 text-gray-900 tabular-nums">{time}</span>
          </p>
        )}
        {children}
      </div>
    </li>
  );
}

/**
 * Teams chat with an agent: the agent on the left, its rounded-square app icon, name, Agent badge,
 * and time above a light bubble that holds text and cards; people on the right in a tinted bubble
 * with only the time above. Consecutive messages stack under one header.
 */
function TeamsMessage({
  author,
  time,
  continued,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  children: ReactNode;
}) {
  const isAgent = Boolean(author.icon);
  return (
    <li
      className={cn(
        "motion-safe:animate-bubble-in motion-reduce:animate-fade-in",
        isAgent
          ? cn("grid origin-top-left grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5", agentEntrance)
          : "flex origin-top-right flex-col items-end",
        continued ? "pt-1" : "pt-4",
      )}
    >
      {isAgent ? continued ? <span /> : <Avatar author={author} platform="teams" /> : null}
      <div className={cn("min-w-0", isAgent ? "flex flex-col items-start" : "contents")}>
        {continued ? (
          <span className="sr-only">{author.name}</span>
        ) : isAgent ? (
          <p className="mb-1 flex items-baseline gap-1.5 text-copy-13 text-gray-900">
            <span className="font-medium text-gray-1000">{author.name}</span>
            <span className="rounded bg-gray-alpha-200 px-1 text-label-12 text-gray-900">
              Agent
            </span>
            <span className="tabular-nums">{time}</span>
          </p>
        ) : (
          <p className="mb-1 text-copy-13 text-gray-900 tabular-nums">
            <span className="sr-only">{author.name}, </span>
            {time}
          </p>
        )}
        <div
          className={cn(
            "max-w-[20rem] rounded-md px-3 py-2 text-gray-1000",
            isAgent ? "bg-gray-100" : "bg-gray-200",
          )}
        >
          {/* The size sits apart from the color, which cn would otherwise merge it away with. */}
          <div className="text-copy-14">{children}</div>
        </div>
      </div>
    </li>
  );
}

// WhatsApp's chat UI in monochrome: incoming bubbles white, outgoing light gray where
// WhatsApp uses green, the read ticks and reply-button labels gray where it uses blue.

// The bubbles' corner radius, and the tail's scale: drawn at 24px, it renders at 15px, its
// stroke widened to stay a 1px hairline. Its curve stays tangent to the bubble's side and
// bottom at any scale, so it meets the border even though its corner is a little rounder.
const bubbleRadius = 10;
const tailScale = 0.625;

/**
 * The chat-bubble tail from vercel.com/agents (front's marketing-shared `ai/tail`), with the
 * bubble fill as a prop. It overlaps the bubble's bottom corner: a window-colored square hides
 * the corner, then the bubble's curve flows into the tail with the same hairline.
 */
function Tail({ fill, flipped }: { fill: string; flipped?: boolean }) {
  return (
    <svg
      aria-hidden
      className={cn(
        "absolute [--tail-border:var(--ds-gray-alpha-400)] dark:[--tail-border:#252525]",
        flipped && "-scale-x-100",
      )}
      fill="none"
      height={24 * tailScale}
      overflow="hidden"
      style={{ bottom: -3 * tailScale, [flipped ? "right" : "left"]: -7 * tailScale }}
      viewBox="0 0 24 24"
      width={24 * tailScale}
    >
      <path d="M0 0H24V24H0z" fill="var(--ds-background-100)" />
      <path
        clipRule="evenodd"
        d="M27-19C15.954-19 7-10.046 7 1c0 .335.008.669.025 1H7v10a15 15 0 01-3 9c4.116 0 7.845-1.658 10.555-4.342A19.915 19.915 0 0027 21c11.046 0 20-8.954 20-20s-8.954-20-20-20z"
        fill={fill}
        fillRule="evenodd"
        paintOrder="stroke fill"
        stroke="var(--tail-border)"
        strokeWidth={2 / tailScale}
      />
    </svg>
  );
}

function ReadTicks() {
  return (
    <svg aria-label="Read" className="h-2.5 w-4" fill="none" role="img" viewBox="0 0 16 10">
      <path
        d="M1 5.5 3.75 8.25 10 1.5M6.5 7.25l1 1L13.75 1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

/**
 * A tapped reply quotes the message it answers, like any WhatsApp reply. The quote is inset
 * as far from the bubble's sides as from its top.
 */
function Quote({ author, children }: { author: string; children: string }) {
  return (
    <span className="-mx-1.5 mb-1 block rounded-[8px] border-gray-700 border-l-4 bg-gray-alpha-100 px-2 py-1">
      <span className="block font-medium text-copy-13 text-gray-1000">{author}</span>
      <span className="block truncate text-copy-13 text-gray-900">{children}</span>
    </span>
  );
}

// geistcn-assets' coins icon.
function IconCoins() {
  return (
    <svg aria-hidden className="size-4" fill="none" viewBox="0 0 16 16">
      <path
        d="M5.5 7c1.38 0 2.67.22 3.64.61q.74.29 1.25.76c.34.31.61.75.61 1.28v3.7c0 .54-.27.98-.6 1.3a4 4 0 0 1-1.26.77A10 10 0 0 1 5.5 16H5.5a10 10 0 0 1-3.63-.58 4 4 0 0 1-1.26-.77c-.33-.32-.6-.76-.6-1.3v-3.7c0-.53.27-.97.6-1.28q.52-.48 1.26-.76A10 10 0 0 1 5.5 7m3.64 4.69c-.97.39-2.26.61-3.64.61a10 10 0 0 1-4-.77v1.82s0 .08.14.22q.22.22.78.46c.75.3 1.83.49 3.07.47h.02a8 8 0 0 0 3.07-.47q.55-.23.78-.46c.14-.14.14-.21.14-.22v-1.82zM5.5 8.5c-1.24 0-2.33.2-3.08.5q-.56.23-.78.46l-.13.15-.01.04.01.04.13.15q.22.22.78.46c.75.3 1.84.5 3.08.5s2.33-.2 3.08-.5q.56-.23.78-.46l.13-.15.01-.04-.01-.04-.13-.15q-.22-.22-.78-.46c-.75-.3-1.84-.5-3.08-.5m5-8.5c1.38 0 2.67.22 3.64.61q.74.29 1.25.76c.34.31.61.75.61 1.28v3.7c0 .55-.25 1-.58 1.33-.3.32-.71.56-1.1.73-.78.34-1.7.51-2.32.51v-1.5c.41 0 1.12-.12 1.71-.38q.44-.2.64-.4c.13-.14.15-.23.15-.29V4.53l-.36.16c-.97.39-2.26.61-3.64.61a10 10 0 0 1-4-.77v.97H5V2.65c0-.53.27-.97.6-1.28Q6.14.89 6.87.6A10 10 0 0 1 10.5 0m0 1.5c-1.24 0-2.33.2-3.08.5q-.56.23-.78.46l-.13.15-.01.04.01.04.13.15q.22.22.78.46c.75.3 1.84.5 3.08.5s2.33-.2 3.08-.5q.56-.23.78-.46l.13-.15.01-.04-.01-.04-.13-.15q-.22-.22-.78-.46c-.75-.3-1.84-.5-3.08-.5"
        fill="currentColor"
      />
    </svg>
  );
}

/** Reply buttons sit inside the message bubble, one per row under a divider. */
function ReplyButtons({ buttons }: { buttons: { label: string; icon: ReactNode }[] }) {
  return buttons.map(({ icon, label }) => (
    <span
      className="flex h-10 items-center justify-center gap-1.5 border-gray-alpha-300 border-t text-copy-14 text-gray-1000"
      key={label}
    >
      {icon}
      {label}
    </span>
  ));
}

function Bubble({
  author,
  time,
  continued,
  tail,
  attachment,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  /** The last bubble in a run of one sender's messages carries the tail. */
  tail: boolean;
  attachment?: ReactNode;
  children: ReactNode;
}) {
  const outgoing = !author.icon;
  return (
    <li
      className={cn(
        "flex motion-safe:animate-bubble-in motion-reduce:animate-fade-in",
        outgoing
          ? "origin-top-right justify-end pr-2"
          : cn("origin-top-left justify-start pl-2", agentEntrance),
        continued ? "pt-1.5" : "pt-4",
      )}
    >
      <span className="sr-only">{author.name}</span>
      <div
        className={cn(
          "relative max-w-[min(80%,20rem)] text-copy-14 text-gray-1000 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]",
          // The agent's bubbles share one width, the reply width the Slack and Teams chats use too.
          outgoing ? "bg-gray-200" : "w-full bg-background-100",
        )}
        style={{ borderRadius: bubbleRadius }}
      >
        {tail ? (
          <Tail
            fill={outgoing ? "var(--ds-gray-200)" : "var(--ds-background-100)"}
            flipped={outgoing}
          />
        ) : null}
        {/* As in WhatsApp, a spacer at the end of the text reserves room for the time, so it
            shares the last line when it fits and takes its own line when it doesn't. */}
        <div className="relative text-pretty px-3 pt-1.5 pb-2 text-copy-14">
          {children}
          <span
            aria-hidden
            className={cn("inline-block", outgoing ? "w-[5.5rem]" : "w-[4.25rem]")}
          />
          <span className="absolute right-3 bottom-1.5 inline-flex items-center gap-1 text-[11px] text-gray-900 leading-none tabular-nums">
            {time}
            {outgoing ? <ReadTicks /> : null}
          </span>
        </div>
        <Attachment>{attachment}</Attachment>
      </div>
    </li>
  );
}

function TypingIndicator({ author }: { author: Author | undefined }) {
  return (
    <p aria-hidden className="flex h-5 items-center gap-1.5 px-1 text-copy-13 text-gray-900">
      {author ? (
        <>
          {/* geistcn's LoadingDots (size lg): three blinking dots, staggered 0.2s apart. */}
          <span className="inline-flex items-center">
            {[0, 200, 400].map((delay) => (
              <span
                className="mx-px inline-block size-1 rounded-full bg-gray-900 motion-safe:animate-blink"
                key={delay}
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          {/* vercel.com/sandbox's in-progress shimmer, over the whole label. */}
          <span className="thinking-loader">
            <span className="font-medium">{author.name}</span>{" "}
            {author.icon ? "is working" : "is typing"}
          </span>
        </>
      ) : null}
    </p>
  );
}

// geistcn-assets' play-circle icon, as on vercel.com/sandbox's "Play demo" button.
function IconPlayCircle() {
  return (
    <svg aria-hidden fill="none" height={16} viewBox="0 0 16 16" width={16}>
      <path
        clipRule="evenodd"
        d="M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M6 11l5.5-3L6 5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

// geistcn-assets' stop-circle icon, red as on vercel.com/sandbox's "Stop demo" button.
function IconStopCircle() {
  return (
    <svg
      aria-hidden
      className="text-red-700"
      fill="none"
      height={16}
      viewBox="0 0 16 16"
      width={16}
    >
      <path
        clipRule="evenodd"
        d="M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-5.5-2.5h-5v5h5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

/**
 * Every label stacked in one grid cell with only the current one visible, so a button keeps
 * the width of its longest label and the dock doesn't resize between choices.
 */
function StableLabel({ current, labels }: { current: string; labels: string[] }) {
  return (
    <span className="grid">
      {labels.map((label) => (
        <span
          aria-hidden={label !== current}
          className={cn("col-start-1 row-start-1 text-left", label !== current && "invisible")}
          key={label}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * An agent conversation, picked from Slack, Teams, and WhatsApp, each drawn in its
 * platform's way. It shows in full; "Play demo" replays it message by message and "Stop demo"
 * returns to the full conversation, as on vercel.com/sandbox.
 */
export function SessionTimeline(): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The outgoing conversation while a channel switch slides it out, and which way it goes.
  const leaving = useRef<{ node: HTMLElement; direction: 1 | -1 } | null>(null);
  const [platform, setPlatform] = useState<Platform>("slack");
  // While playing, how many beats are in; otherwise the whole conversation shows.
  const [playing, setPlaying] = useState(false);
  const [count, setCount] = useState(0);
  // A replay that runs to the end stays at the end, clear of the dock; stopping it or switching
  // channels returns to the conversation's start.
  const [ended, setEnded] = useState(false);
  // Reactions the visitor added, keyed by emoji, toggled like Slack's: a click adds one to the
  // count, a second click takes it back. Remembered in this browser only; storage can be
  // unavailable (private windows, blocked site data), so it's best effort.
  const [reacted, setReacted] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(REACTIONS_KEY) ?? "[]");
      if (Array.isArray(saved)) setReacted(new Set(saved.filter((e) => e in TEXT_EMOJI)));
    } catch {}
  }, []);

  const toggleReaction = (emoji: string) =>
    setReacted((current) => {
      const next = new Set(current);
      if (!next.delete(emoji)) next.add(emoji);
      try {
        localStorage.setItem(REACTIONS_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  // Which edges have messages scrolled past them, so only those edges fade.
  const [overflow, setOverflow] = useState({ above: false, below: false });

  const conversation = CONVERSATIONS.find((c) => c.id === platform) ?? CONVERSATIONS[0];
  const beats = conversation.beats;
  const shown = playing ? count : beats.length;
  const next = playing ? beats[count] : undefined;

  // After a message lands, the typing indicator waits a beat before fading back in, so the
  // message reads as taking its place. It keeps its last author while it fades out.
  const [typing, setTyping] = useState(false);
  const [typingAuthor, setTypingAuthor] = useState<Author>();

  useEffect(() => {
    if (!playing) return;
    if (!next) {
      setPlaying(false);
      setEnded(true);
      setTyping(false);
      return;
    }
    setTyping(false);
    const show = setTimeout(
      () => {
        setTypingAuthor(next.kind === "message" ? AUTHORS[next.author] : undefined);
        setTyping(next.kind === "message");
      },
      Math.min(500, next.delay * 0.4),
    );
    const timer = setTimeout(() => setCount((n) => n + 1), next.delay);
    return () => {
      clearTimeout(show);
      clearTimeout(timer);
    };
  }, [playing, next]);

  // Before paint: the full conversation opens at its start; a replay snaps to its end, so the
  // newest line always settles clear of the dock, then glides there from where the content was
  // (a FLIP), on the same 300ms ease-in-out as the bubble entrance.
  useLayoutEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    if (playing || ended) {
      const from = list.scrollTop;
      list.scrollTop = list.scrollHeight;
      const delta = list.scrollTop - from;
      if (delta > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        content.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
          duration: 300,
          easing: "ease-in-out",
        });
      }
    } else {
      list.scrollTop = 0;
    }
    measure(list);
  }, [shown, platform, playing, ended]);

  const measure = (list: HTMLElement) => {
    const above = list.scrollTop > 1;
    const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setOverflow((o) => (o.above === above && o.below === below ? o : { above, below }));
  };

  const play = () => {
    setCount(0);
    setEnded(false);
    setPlaying(true);
  };

  const stop = () => {
    setPlaying(false);
    setEnded(false);
  };

  // Switching channels pushes the current conversation out and the next one in, like moving
  // between screens: toward the left when the channel is further down the picker, else right.
  const pick = (id: string) => {
    if (id === platform) return;
    const list = listRef.current;
    const body = bodyRef.current;
    if (list && body && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      leaving.current?.node.remove();
      const node = list.cloneNode(true) as HTMLElement;
      node.setAttribute("aria-hidden", "true");
      node.style.position = "absolute";
      node.style.inset = "0";
      node.style.pointerEvents = "none";
      body.append(node);
      node.scrollTop = list.scrollTop;
      const order = CONVERSATIONS.map((c) => c.id);
      leaving.current = {
        node,
        direction: order.indexOf(id as Platform) > order.indexOf(platform) ? 1 : -1,
      };
    }
    setPlatform(id as Platform);
    stop();
  };

  useLayoutEffect(() => {
    const out = leaving.current;
    const list = listRef.current;
    if (!out || !list) return;
    leaving.current = null;
    const timing = { duration: 300, easing: "ease-in-out" };
    out.node
      .animate(
        [{ transform: "none" }, { transform: `translateX(${-100 * out.direction}%)` }],
        timing,
      )
      .finished.then(
        () => out.node.remove(),
        () => out.node.remove(),
      );
    list.animate(
      [{ transform: `translateX(${100 * out.direction}%)` }, { transform: "none" }],
      timing,
    );
  }, [platform]);

  return (
    // Laid out like vercel.com/sandbox's hero: the conversation in a browser window, the channel
    // picker overlapping its bottom-left corner like the sandbox's agent window, and the demo
    // control below its bottom-right.
    <figure
      aria-label="Example eve sessions in Slack, Teams, and WhatsApp"
      className="relative m-0 mb-16 ml-auto w-full max-w-[30rem]"
    >
      <div className="flex flex-col overflow-hidden material-large">
        <header className="relative flex h-9 shrink-0 items-center justify-center shadow-[0_0_0_1px_var(--ds-gray-alpha-200)]">
          <span aria-hidden className="absolute left-3 flex gap-1">
            <span className="size-2 rounded-full bg-[#EE6D5E]" />
            <span className="size-2 rounded-full bg-[#F3BF4A]" />
            <span className="size-2 rounded-full bg-[#5DC753]" />
          </span>
          <span className="text-gray-800 text-label-13">{conversation.label}</span>
        </header>
        {/* The conversation fades out over the outer 40px of an edge with messages scrolled past
            it. In full it opens at its start; a replay fills from the bottom like a chat. */}
        <div className="relative overflow-hidden" ref={bodyRef}>
          <div
            className="h-[26rem] overflow-y-auto overscroll-contain px-4 [scrollbar-width:none]"
            key={platform}
            onScroll={(event) => measure(event.currentTarget)}
            ref={listRef}
            style={{
              maskImage: `linear-gradient(to bottom, ${overflow.above ? "transparent, black 40px" : "black"}, ${overflow.below ? "black calc(100% - 40px), transparent" : "black"})`,
            }}
          >
            <ol
              // Messages only animate in during a replay, including the last one as it ends;
              // shown in full, they're simply there.
              className={cn(
                "m-0 flex min-h-full list-none flex-col p-0 pt-2 pb-28 [&>li:first-child]:mt-auto",
                !playing && !ended && "[&_*]:animate-none [&>*]:animate-none",
              )}
              ref={contentRef}
            >
              {beats.slice(0, shown).map((beat, i) => {
                if (beat.kind === "reactions") {
                  return (
                    <li className="flex gap-1.5 pt-1.5 pl-[2.875rem]" key={i}>
                      {beat.reactions.map((reaction, index) => {
                        const mine = reacted.has(reaction.emoji);
                        const count = reaction.count + (mine ? 1 : 0);
                        return (
                          <button
                            aria-label={`:${reaction.emoji.toLowerCase()}: ${count}`}
                            aria-pressed={mine}
                            className={cn(
                              "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-[7px] text-gray-1000 tabular-nums transition-[background-color,border-color,transform] duration-150 ease-out active:scale-95 motion-safe:animate-scale-in motion-reduce:animate-fade-in",
                              mine
                                ? "border-gray-alpha-700 bg-gray-alpha-200"
                                : "border-gray-alpha-400 bg-background-100 hover:border-gray-alpha-500",
                            )}
                            key={reaction.emoji}
                            onClick={() => toggleReaction(reaction.emoji)}
                            style={{ animationDelay: `${index * 60}ms` }}
                            type="button"
                          >
                            <TextEmoji name={reaction.emoji} />
                            <span className="text-copy-13">{count}</span>
                          </button>
                        );
                      })}
                    </li>
                  );
                }
                const author = AUTHORS[beat.author];
                if (platform === "whatsapp") {
                  return (
                    <Bubble
                      attachment={beat.attachment}
                      author={author}
                      continued={beat.author === authorOf(beats[i - 1])}
                      tail={beat.author !== authorOf(beats.slice(0, shown)[i + 1])}
                      key={i}
                      time={beat.time}
                    >
                      {beat.body}
                    </Bubble>
                  );
                }
                const continued = beat.author === authorOf(beats[i - 1]);
                if (platform === "teams") {
                  return (
                    <TeamsMessage author={author} continued={continued} key={i} time={beat.time}>
                      <p>{beat.body}</p>
                      <Attachment>{beat.attachment}</Attachment>
                    </TeamsMessage>
                  );
                }
                return (
                  <ThreadMessage author={author} continued={continued} key={i} time={beat.time}>
                    <p className="text-gray-1000">{beat.body}</p>
                    <Attachment>{beat.attachment}</Attachment>
                  </ThreadMessage>
                );
              })}
              {/* During a replay the typing indicator keeps a reserved row and only fades, so its
            coming and going never changes the conversation's height. */}
              {playing || ended ? (
                <li
                  aria-hidden={!typing}
                  className={cn(
                    "pt-3 transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    platform === "whatsapp" ? "pl-2" : "pl-[2.875rem]",
                    typing ? "opacity-100" : "opacity-0",
                  )}
                >
                  <TypingIndicator author={typingAuthor} />
                </li>
              ) : null}
            </ol>
          </div>
        </div>
      </div>
      {/* The channel picker stays open, so every conversation is one click away. */}
      <div
        aria-label="Channel"
        className="absolute -bottom-6 -left-2 z-10 flex w-60 flex-col p-1.5 material-menu md:-left-6 lg:-bottom-12 lg:-left-12"
        role="radiogroup"
      >
        {CONVERSATIONS.map((c) => {
          const selected = c.id === platform;
          return (
            <button
              aria-checked={selected}
              className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-left text-gray-1000 transition-colors hover:bg-gray-alpha-100 [&>svg]:size-4 [&>svg]:shrink-0"
              key={c.id}
              onClick={() => pick(c.id)}
              role="radio"
              type="button"
            >
              {c.logo("size-4")}
              <span className="text-label-14">{c.label}</span>
              {selected ? <IconCheck className="ml-auto text-gray-1000" size={16} /> : null}
            </button>
          );
        })}
      </div>
      <Button
        className="absolute top-full right-0 mt-4"
        onClick={playing ? stop : play}
        prefix={playing ? <IconStopCircle /> : <IconPlayCircle />}
        size="small"
        variant="tertiary"
      >
        <StableLabel
          current={playing ? "Stop demo" : "Play demo"}
          labels={["Play demo", "Stop demo"]}
        />
      </Button>
    </figure>
  );
}
