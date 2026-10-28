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
