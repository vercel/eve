import { Button } from "@vercel/geistdocs/components/button";
import type { ComponentType, ReactNode } from "react";
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

export function AgentBadge() {
  return <span className="rounded bg-gray-alpha-200 px-1 text-label-12 text-gray-900">Agent</span>;
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

/** vercel.com/sandbox's "Play demo" button, which turns into "Stop demo" while playing. */
export function DemoButton({
  playing,
  onClick,
  className,
}: {
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
        current={playing ? "Stop demo" : "Play demo"}
        labels={["Play demo", "Stop demo"]}
      />
    </Button>
  );
}
