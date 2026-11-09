import { Button } from "@vercel/geistdocs/components/button";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Agents get an icon avatar and an "Agent" badge; people get their initial. */
export type Author = { name: string; icon?: ComponentType<{ className?: string }> };

/** A rounded-square avatar: the agent's icon on its color, or a person's initial on pink. */
export function ChatAvatar({ author, color }: { author: Author; color: string }) {
  const Icon = author.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-white",
        Icon ? color : "bg-pink-700",
      )}
    >
      {/* The size sits apart from the color, which cn would otherwise merge it away with. */}
      {Icon ? (
        <Icon className="size-3.5" />
      ) : (
        <span className="font-semibold text-label-12">{author.name[0]}</span>
      )}
    </span>
  );
}

export function Mention({ children }: { children: string }) {
  return <span className="rounded bg-gray-alpha-200 px-0.5 text-gray-1000">@{children}</span>;
}

export function AgentBadge() {
  return <span className="rounded bg-gray-alpha-200 px-1 text-label-12 text-gray-900">Agent</span>;
}

/** A link preview under a message: an icon, a title, and a line of detail. */
export function Card({
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

/**
 * Slack: avatar, name, Agent badge, time; consecutive messages fold under the first. Replies
 * are as wide as `--reply-width` allows, 20rem unless a conversation sets it.
 */
export function SlackMessage({
  author,
  time,
  continued,
  avatarColor,
  className,
  children,
}: {
  author: Author;
  time: string;
  continued: boolean;
  /** The agent avatar's background. */
  avatarColor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5",
        continued ? "pt-2" : "pt-4",
        className,
      )}
    >
      {continued ? <span /> : <ChatAvatar author={author} color={avatarColor} />}
      <div className="min-w-0 max-w-[var(--reply-width,20rem)] text-copy-14 text-gray-1000">
        {continued ? (
          <span className="sr-only">{author.name}</span>
        ) : (
          <p className="flex items-baseline gap-1.5">
            <span className="font-medium">{author.name}</span>
            {author.icon ? <AgentBadge /> : null}
            <span className="text-copy-13 text-gray-900 tabular-nums">{time}</span>
          </p>
        )}
        {children}
      </div>
    </li>
  );
}

// The bubbles' corner radius, and the tail's scale: drawn at 24px, it renders at 15px. Its
// curve stays tangent to the bubble's side and bottom at any scale, so it meets the bubble's
// edges even though its corner is a little rounder.
export const bubbleRadius = 10;
const tailScale = 0.625;

/**
 * The chat-bubble tail from vercel.com/agents (front's marketing-shared `ai/tail`), filled with
 * the text color `className` sets to match the bubble. It overlaps the bubble's bottom corner: a
 * window-colored square hides the corner, then the bubble's curve flows into the tail.
 */
export function Tail({ className, flipped }: { className: string; flipped?: boolean }) {
  return (
    <svg
      aria-hidden
      className={cn("absolute", flipped && "-scale-x-100", className)}
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
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function TypingIndicator({ author }: { author: Author | undefined }) {
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
 * vercel.com/sandbox's demo button, labeled with the action that starts the example, such as
 * "Trigger a PR", and turning into "Cancel demo" while it plays.
 */
export function DemoButton({
  action,
  actions = [action],
  playing,
  onClick,
  className,
}: {
  action: string;
  /** Every action the button can show, so it keeps one width when the action changes. */
  actions?: string[];
  playing: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      className={className}
      onClick={onClick}
      prefix={playing ? <IconStopCircle /> : <IconPlayCircle />}
      size="small"
      variant="tertiary"
    >
      <StableLabel
        current={playing ? "Cancel demo" : action}
        labels={[...actions, "Cancel demo"]}
      />
    </Button>
  );
}

/**
 * A reaction being added pops its emoji and rolls its count up; one taken back only rolls the
 * count down. Through the Web Animations API, so it runs while a conversation has its CSS
 * entrances off.
 */
function animateReaction(button: Element, adding: boolean, delay = 0) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";
  button.querySelector("[data-count]")?.animate(
    reduce
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateY(${adding ? 6 : -6}px)` },
          { opacity: 1, transform: "none" },
        ],
    { delay, duration: 200, easing: easeOut, fill: "backwards" },
  );
  if (adding && !reduce) {
    button
      .querySelector("[role=img]")
      ?.animate(
        [
          { transform: "none", easing: easeOut },
          { transform: "scale(1.25)", offset: 0.4, easing: easeOut },
          { transform: "none" },
        ],
        { delay, duration: 300 },
      );
  }
}

/**
 * A Slack reaction the visitor can toggle: a click adds one to the count, a second takes it
 * back. In a demo it lands the way a click adds one, once its pill has scaled in; `index`
 * staggers a row of them 60ms apart.
 */
export function Reaction({
  name,
  count,
  demo,
  index = 0,
  className,
  children,
}: {
  /** The emoji's shortcode, without colons. */
  name: string;
  count: number;
  demo: boolean;
  index?: number;
  className?: string;
  /** The emoji, with `role="img"` so it pops. */
  children: ReactNode;
}) {
  const [mine, setMine] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const total = count + (mine ? 1 : 0);

  // Only on mount: a reaction arriving in a demo, not one re-rendered after.
  useEffect(() => {
    if (demo && button.current) animateReaction(button.current, true, 150 + index * 60);
  }, []);

  // The emoji sits 5px in from the left, as from the top and bottom: (28px - 2px border - 16px) / 2.
  return (
    <button
      aria-label={`:${name}: ${total}`}
      aria-pressed={mine}
      className={cn(
        "flex h-7 origin-left cursor-pointer items-center gap-1.5 rounded-full border pr-[7px] pl-[5px] text-gray-1000 tabular-nums transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]",
        demo && "motion-safe:animate-scale-in motion-reduce:animate-fade-in",
        mine
          ? "border-gray-alpha-700 bg-gray-alpha-200"
          : "border-gray-alpha-400 bg-background-100 hover:border-gray-alpha-500",
        className,
      )}
      onClick={(event) => {
        setMine(!mine);
        animateReaction(event.currentTarget, !mine);
      }}
      ref={button}
      style={{ animationDelay: `${index * 60}ms` }}
      type="button"
    >
      {children}
      <span className="text-copy-13" data-count>
        {total}
      </span>
    </button>
  );
}
