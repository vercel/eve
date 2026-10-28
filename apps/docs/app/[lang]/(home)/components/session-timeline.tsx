"use client";

import {
  Activity,
  Check,
  CircleDot,
  CodeXml,
  GitMerge,
  GitPullRequestArrow,
  Headset,
  Reply,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { IconCheck, IconChevronDownSmall } from "@vercel/geistdocs/assets/icons";
import { Button } from "@vercel/geistdocs/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@vercel/geistdocs/components/dropdown-menu";
import { type ComponentType, type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { logos } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";

type Platform = "slack" | "teams" | "whatsapp";

/** Agents get an icon avatar and an "Agent" badge; people get their initial. */
type Author = { name: string; icon?: ComponentType<{ className?: string }> };

const AUTHORS = {
  Coder: { name: "Coder", icon: CodeXml },
  Reviewer: { name: "Reviewer", icon: ScanSearch },
  Ops: { name: "Ops", icon: Activity },
  Dana: { name: "Dana" },
  Concierge: { name: "Acme", icon: Headset },
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
  return (
    <span className="rounded bg-gray-alpha-200 px-0.5 font-medium text-gray-1000">@{children}</span>
  );
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
    <div className="mt-2 flex max-w-[26rem] gap-2.5 rounded-lg border border-gray-alpha-400 bg-background-100 px-3 py-2.5">
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

/** Teams renders bot replies as Adaptive Cards: a bordered card with full-width actions. */
function AdaptiveCard({
  title,
  text,
  actions,
}: {
  title: string;
  text: string;
  actions: [string, string];
}) {
  return (
    <div className="mt-2 max-w-[26rem] rounded-lg bg-background-100 p-3 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
      <p className="font-semibold text-copy-14">{title}</p>
      <p className="mt-1 text-copy-13 text-gray-900">{text}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
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
    body: "Picked up a new issue from GitHub and triaged it: bug, P1, scoped to cart sessions.",
    attachment: (
      <Card
        icon={<CircleDot />}
        meta="acme/storefront#412 · opened by Dana · bug · P1"
        title="Saved carts disappear after sign-in"
      />
    ),
    delay: 600,
  },
  {
    kind: "message",
    author: "Coder",
    time: "10:09 AM",
    body: "Reproduced it in a sandbox. Guest cart items are dropped when the session upgrades on sign-in.",
    attachment: (
      <code className="mt-1 block truncate font-mono text-copy-13-mono text-gray-900">
        pnpm vitest cart/session · 1 failed
      </code>
    ),
    delay: 1800,
  },
  {
    kind: "message",
    author: "Coder",
    time: "10:26 AM",
    body: (
      <>
        Fixed it and added 3 tests. <Mention>Reviewer</Mention> ready for review.
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
    reactions: [
      { emoji: "ACK", count: 1 },
      { emoji: "LFG", count: 2 },
    ],
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
        text="Reverts storefront to the previous deployment. Takes about 30 seconds."
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
    attachment: <ReplyButtons labels={["Send replacement", "Refund instead"]} />,
    delay: 1600,
  },
  {
    kind: "message",
    author: "Maya",
    time: "9:13 AM",
    body: (
      <>
        <Quote author="Acme">Send a replacement?</Quote>
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
    logo: (className) => logos.slack({ "aria-hidden": true, className }),
    beats: SLACK_BEATS,
  },
  {
    id: "teams",
    label: "Operations",
    logo: (className) => logos.teams({ "aria-hidden": true, className }),
    beats: TEAMS_BEATS,
  },
  {
    id: "whatsapp",
    label: "Acme Support",
    logo: (className) => logos.whatsapp({ "aria-hidden": true, className }),
    beats: WHATSAPP_BEATS,
  },
];

// Vercel's custom Slack emoji: a short word in white on a colored tile.
const TEXT_EMOJI = {
  ACK: "bg-purple-800",
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

function Avatar({ author, round }: { author: Author; round: boolean }) {
  const Icon = author.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center border border-gray-alpha-400 font-medium text-label-14",
        round ? "rounded-full" : "rounded-md",
        Icon ? "bg-black text-white" : "bg-background-100 text-gray-1000",
      )}
    >
      {Icon ? <Icon className="size-4" /> : author.name[0]}
    </span>
  );
}

/** Slack and Teams: avatar, name, time; consecutive messages fold under the first. */
function ThreadMessage({
  author,
  time,
  continued,
  round,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  round: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
        continued ? "pt-2" : "pt-4",
      )}
    >
      {continued ? <span /> : <Avatar author={author} round={round} />}
      <div className="min-w-0 text-copy-14 text-gray-1000">
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

// WhatsApp's chat UI in monochrome: incoming bubbles white, outgoing light gray where
// WhatsApp uses green, the read ticks and reply-button labels gray where it uses blue.

/** The tail WhatsApp gives the first bubble in a run, at its top outer corner. */
function BubbleTail({ outgoing }: { outgoing: boolean }) {
  return (
    <svg
      aria-hidden
      className={cn(
        "absolute top-0 h-[13px] w-2",
        outgoing ? "-right-2 text-gray-200" : "-left-2 text-background-100",
      )}
      viewBox="0 0 8 13"
    >
      <path
        d={
          outgoing
            ? "M5.19 1H0v11.19l6.47-8.62C7.53 2.16 6.96 1 5.19 1z"
            : "M1.53 3.57 8 12.19V1H2.81C1.04 1 .47 2.16 1.53 3.57z"
        }
        fill="currentColor"
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

/** A tapped reply quotes the message it answers, like any WhatsApp reply. */
function Quote({ author, children }: { author: string; children: string }) {
  return (
    <span className="mb-1 block rounded-[5px] border-gray-700 border-l-4 bg-gray-alpha-100 px-2 py-1">
      <span className="block font-medium text-copy-13 text-gray-1000">{author}</span>
      <span className="block truncate text-copy-13 text-gray-900">{children}</span>
    </span>
  );
}

/** Reply buttons sit inside the message bubble, one per row under a divider. */
function ReplyButtons({ labels }: { labels: string[] }) {
  return labels.map((label) => (
    <span
      className="flex h-10 items-center justify-center gap-1.5 border-gray-alpha-300 border-t font-medium text-copy-14 text-gray-1000"
      key={label}
    >
      <Reply aria-hidden className="size-4" />
      {label}
    </span>
  ));
}

function Bubble({
  author,
  time,
  continued,
  attachment,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  attachment?: ReactNode;
  children: ReactNode;
}) {
  const outgoing = !author.icon;
  return (
    <li
      className={cn(
        "flex motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
        outgoing ? "justify-end pr-2" : "justify-start pl-2",
        continued ? "pt-0.5" : "pt-3",
      )}
    >
      <span className="sr-only">{author.name}</span>
      <div
        className={cn(
          "relative max-w-[min(80%,22rem)] rounded-[7.5px] text-copy-14 text-gray-1000 shadow-[0_1px_0.5px_var(--ds-gray-alpha-400)]",
          outgoing ? "bg-gray-200" : "bg-background-100",
          !continued && (outgoing ? "rounded-tr-none" : "rounded-tl-none"),
        )}
      >
        {continued ? null : <BubbleTail outgoing={outgoing} />}
        {/* As in WhatsApp, a spacer at the end of the text reserves room for the time, so it
            shares the last line when it fits and takes its own line when it doesn't. */}
        <div className="relative text-pretty px-2 pt-1.5 pb-2">
          {children}
          <span
            aria-hidden
            className={cn("inline-block", outgoing ? "w-[5.5rem]" : "w-[4.25rem]")}
          />
          <span className="absolute right-2 bottom-1.5 inline-flex items-center gap-1 text-[11px] text-gray-900 leading-none tabular-nums">
            {time}
            {outgoing ? <ReadTicks /> : null}
          </span>
        </div>
        {attachment}
      </div>
    </li>
  );
}

function TypingIndicator({ author }: { author: Author | undefined }) {
  return (
    <p aria-hidden className="flex h-5 items-center gap-1.5 px-1 text-copy-13 text-gray-900">
      {author ? (
        <>
          <span className="flex gap-0.5">
            {[0, 150, 300].map((delay) => (
              <span
                className="size-1 rounded-full bg-gray-900 motion-safe:animate-bounce"
                key={delay}
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span>
            <span className="font-medium text-gray-1000">{author.name}</span>{" "}
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
  const listRef = useRef<HTMLOListElement>(null);
  const [platform, setPlatform] = useState<Platform>("slack");
  // While playing, how many beats are in; otherwise the whole conversation shows.
  const [playing, setPlaying] = useState(false);
  const [count, setCount] = useState(0);
  // Which edges have messages scrolled past them, so only those edges fade.
  const [overflow, setOverflow] = useState({ above: false, below: false });

  const conversation = CONVERSATIONS.find((c) => c.id === platform) ?? CONVERSATIONS[0];
  const beats = conversation.beats;
  const shown = playing ? count : beats.length;
  const next = playing ? beats[count] : undefined;

  useEffect(() => {
    if (!playing) return;
    if (!next) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCount((n) => n + 1), next.delay);
    return () => clearTimeout(timer);
  }, [playing, next]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // The full conversation opens at its start; a replay follows new messages at the end.
    list.scrollTo(playing ? { top: list.scrollHeight, behavior: "smooth" } : { top: 0 });
    measure(list);
  }, [shown, platform, playing]);

  const measure = (list: HTMLOListElement) => {
    const above = list.scrollTop > 1;
    const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setOverflow((o) => (o.above === above && o.below === below ? o : { above, below }));
  };

  const play = () => {
    setCount(0);
    setPlaying(true);
  };

  const pick = (id: string) => {
    setPlatform(id as Platform);
    setPlaying(false);
  };

  return (
    <figure aria-label="Example eve sessions in Slack, Teams, and WhatsApp" className="m-0">
      {/* No frame: the conversation sits on the page and fades out only at an edge that has
          messages scrolled past it. In full it opens at its start; a replay fills from the
          bottom like a chat. */}
      <ol
        className="-mx-1 flex h-[34rem] list-none flex-col overflow-y-auto overscroll-contain px-1 pt-0 pb-12 [scrollbar-width:none] [&>li:first-child]:mt-auto"
        key={platform}
        onScroll={(event) => measure(event.currentTarget)}
        ref={listRef}
        style={{
          maskImage: `linear-gradient(to bottom, ${overflow.above ? "transparent, black 35%" : "black"}, ${overflow.below ? "black 65%, transparent" : "black"})`,
        }}
      >
        {beats.slice(0, shown).map((beat, i) => {
          if (beat.kind === "reactions") {
            return (
              <li className="flex gap-1.5 pt-1.5 pl-[2.875rem]" key={i}>
                {beat.reactions.map((reaction) => (
                  <span
                    className="flex h-7 items-center gap-1.5 rounded-full border border-gray-alpha-400 bg-background-100 pr-3 pl-[5px] text-copy-13 text-gray-1000 tabular-nums motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75"
                    key={reaction.emoji}
                  >
                    <TextEmoji name={reaction.emoji} />
                    {reaction.count}
                  </span>
                ))}
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
                key={i}
                time={beat.time}
              >
                {beat.body}
              </Bubble>
            );
          }
          const continued = beat.author === authorOf(beats[i - 1]);
          return (
            <ThreadMessage
              author={author}
              continued={continued}
              key={i}
              round={platform === "teams"}
              time={beat.time}
            >
              <p className="text-gray-1000">{beat.body}</p>
              {beat.attachment}
            </ThreadMessage>
          );
        })}
        {next?.kind === "message" ? (
          <li className={cn("pt-3", platform === "whatsapp" ? "pl-2" : "pl-[2.875rem]")}>
            <TypingIndicator author={AUTHORS[next.author]} />
          </li>
        ) : null}
      </ol>
      {/* A floating dock: the only raised element, overlapping the conversation's bottom so
          messages fade out behind it. */}
      <figcaption className="relative z-10 mx-auto -mt-9 flex w-fit items-center gap-1 rounded-full border border-gray-alpha-400 bg-background-100 p-1 shadow-sm">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Conversation: ${conversation.label}`}
              className="rounded-full"
              prefix={conversation.logo("size-4")}
              size="small"
              suffix={<IconChevronDownSmall className="text-gray-900" />}
              variant="tertiary"
            >
              <StableLabel
                current={conversation.label}
                labels={CONVERSATIONS.map((c) => c.label)}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56" side="top">
            <DropdownMenuRadioGroup onValueChange={pick} value={platform}>
              {CONVERSATIONS.map((c) => (
                // The check sits on the right, so the item's own left indicator is hidden.
                <DropdownMenuRadioItem
                  className="group gap-2.5 pl-2 text-label-14 [&>span:first-child]:hidden"
                  key={c.id}
                  value={c.id}
                >
                  {c.logo("size-4")}
                  {c.label}
                  <IconCheck className="ml-auto opacity-0 group-data-[state=checked]:opacity-100" />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span aria-hidden className="h-4 w-px bg-gray-alpha-400" />
        <Button
          className="rounded-full"
          onClick={playing ? () => setPlaying(false) : play}
          prefix={playing ? <IconStopCircle /> : <IconPlayCircle />}
          size="small"
          variant="tertiary"
        >
          <StableLabel
            current={playing ? "Stop demo" : "Play demo"}
            labels={["Play demo", "Stop demo"]}
          />
        </Button>
      </figcaption>
    </figure>
  );
}
