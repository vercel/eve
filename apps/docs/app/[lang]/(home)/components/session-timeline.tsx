"use client";

import {
  Check,
  CircleDot,
  CodeXml,
  GitMerge,
  GitPullRequestArrow,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@vercel/geistdocs/components/button";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { slackLogo } from "@/lib/integrations/logos";
import { cn } from "@/lib/utils";
import { monochromeLogo } from "./control-visual";

type Member = "Coder" | "Reviewer";

/** Each beat waits `delay` ms before it appears; while it waits, its author shows as working. */
type Beat =
  | {
      kind: "message";
      author: Member;
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

const REVIEW_CHECKS = [
  "Correctness: merge handles empty and duplicate carts",
  "Tests: 4 new cases cover the regression",
  "Security: cart ownership verified, no secrets in logs",
];

const BEATS: Beat[] = [
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

function authorOf(beat: Beat | undefined): Member | undefined {
  return beat?.kind === "message" ? beat.author : undefined;
}

function Avatar({ member }: { member: Member }) {
  const Icon = member === "Coder" ? CodeXml : ScanSearch;
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-md border border-gray-alpha-400 bg-black text-white"
    >
      <Icon className="size-4" />
    </span>
  );
}

function MessageRow({
  author,
  time,
  continued,
  children,
}: {
  author: Member;
  time: string;
  /** Consecutive messages from one author fold under the first, like Slack does. */
  continued: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
        continued ? "pt-2" : "pt-4",
      )}
    >
      {continued ? <span /> : <Avatar member={author} />}
      <div className="min-w-0 text-copy-14 text-gray-1000">
        {continued ? (
          <span className="sr-only">{author}</span>
        ) : (
          <p className="flex items-baseline gap-1.5">
            <span className="font-medium">{author}</span>
            <span className="rounded bg-gray-alpha-200 px-1 text-label-12 text-gray-900">
              Agent
            </span>
            <span className="text-copy-13 text-gray-900 tabular-nums">{time}</span>
          </p>
        )}
        {children}
      </div>
    </li>
  );
}

function TypingIndicator({ member }: { member: Member | undefined }) {
  return (
    <p aria-hidden className="flex h-5 items-center gap-1.5 px-1 text-copy-13 text-gray-900">
      {member ? (
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
            <span className="font-medium text-gray-1000">{member}</span> is working
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

/** A replayed Slack channel where two agents take a GitHub issue to a merged pull request. */
export function SessionTimeline(): JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState(1);
  const [inView, setInView] = useState(false);
  // Reduced motion shows the whole transcript at once, so there is nothing to replay.
  const [animated, setAnimated] = useState(true);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(BEATS.length);
      setAnimated(false);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.3,
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const next = BEATS[shown];
  const done = shown === BEATS.length;

  useEffect(() => {
    if (!inView || !next) return;
    const timer = setTimeout(() => setShown((count) => count + 1), next.delay);
    return () => clearTimeout(timer);
  }, [inView, next]);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: animated ? "smooth" : "auto",
    });
  }, [shown, animated]);

  const replay = () => setShown(0);

  return (
    <figure aria-label="Example eve session in Slack" className="m-0" ref={rootRef}>
      {/* No frame: the conversation sits on the page and fades out toward the top, so new
          messages arrive at the bottom and older ones dissolve upward. */}
      <ol
        className="h-[26rem] list-none overflow-y-auto overscroll-contain p-0 pb-2 [mask-image:linear-gradient(to_bottom,transparent,black_40%)] [scrollbar-width:none]"
        ref={listRef}
      >
        {BEATS.slice(0, shown).map((beat, i) => {
          const author = authorOf(beat);
          const continued = author !== undefined && author === authorOf(BEATS[i - 1]);
          switch (beat.kind) {
            case "message":
              return (
                <MessageRow author={beat.author} continued={continued} key={i} time={beat.time}>
                  <p className="text-gray-1000">{beat.body}</p>
                  {beat.attachment}
                </MessageRow>
              );
            case "reactions":
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
        })}
      </ol>
      <figcaption className="mt-3 flex items-center gap-2 text-copy-13 text-gray-900">
        {slackLogo({ "aria-hidden": true, className: cn("size-3.5 shrink-0", monochromeLogo) })}
        <span className="text-gray-1000">#software-factory</span>
        <TypingIndicator member={next?.kind === "message" ? next.author : undefined} />
        {done && animated ? (
          <Button
            className="ml-auto motion-safe:animate-in motion-safe:fade-in"
            onClick={replay}
            prefix={<IconPlayCircle />}
            size="small"
            variant="tertiary"
          >
            Play demo
          </Button>
        ) : null}
      </figcaption>
    </figure>
  );
}
