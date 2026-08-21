"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom> & {
  scrollRestorationKey?: string;
};

export const Conversation = ({
  children,
  className,
  initial,
  scrollRestorationKey,
  ...props
}: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial={initial ?? (scrollRestorationKey === undefined ? "smooth" : false)}
    resize="smooth"
    role="log"
    {...props}
  >
    {typeof children === "function" ? (
      (context) => (
        <>
          {children(context)}
          {scrollRestorationKey === undefined ? null : (
            <ConversationScrollRestoration storageKey={scrollRestorationKey} />
          )}
        </>
      )
    ) : (
      <>
        {children}
        {scrollRestorationKey === undefined ? null : (
          <ConversationScrollRestoration storageKey={scrollRestorationKey} />
        )}
      </>
    )}
  </StickToBottom>
);

function ConversationScrollRestoration({ storageKey }: { readonly storageKey: string }) {
  const { scrollRef, scrollToBottom, state } = useStickToBottomContext();
  const restoredKeyRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) return;

    if (restoredKeyRef.current !== storageKey) {
      const saved = readScrollPosition(sessionStorage.getItem(storageKey));
      if (saved?.atBottom === false) {
        scrollElement.scrollTop = saved.scrollTop;
        requestAnimationFrame(() => {
          scrollElement.scrollTop = saved.scrollTop;
        });
      } else {
        scrollElement.scrollTop = scrollElement.scrollHeight;
        scrollToBottom({ animation: "instant", ignoreEscapes: true });
      }
      restoredKeyRef.current = storageKey;
    }

    const saveNow = () => {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          atBottom: state.isAtBottom || state.isNearBottom,
          scrollTop: scrollElement.scrollTop,
        }),
      );
    };
    let frame: number | undefined;
    const scheduleSave = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        saveNow();
      });
    };
    scrollElement.addEventListener("scroll", scheduleSave, { passive: true });
    window.addEventListener("pagehide", saveNow);
    return () => {
      scrollElement.removeEventListener("scroll", scheduleSave);
      window.removeEventListener("pagehide", saveNow);
      if (frame !== undefined) cancelAnimationFrame(frame);
      saveNow();
    };
  }, [scrollRef, scrollToBottom, state, storageKey]);

  return null;
}

function readScrollPosition(value: string | null):
  | {
      readonly atBottom: boolean;
      readonly scrollTop: number;
    }
  | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as { atBottom?: unknown; scrollTop?: unknown };
    return typeof parsed.atBottom === "boolean" && typeof parsed.scrollTop === "number"
      ? { atBottom: parsed.atBottom, scrollTop: parsed.scrollTop }
      : undefined;
  } catch {
    return undefined;
  }
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-32 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
