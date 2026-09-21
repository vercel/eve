"use client";

import { useChatWorkspace } from "./chat-workspace";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { XIcon, ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SubagentSession } from "@/lib/subagent-session";
import type { SubagentPaneState } from "@/lib/subagent-pane-cache";
import { AgentMessage } from "./agent-message";

const noResponse = () => {};
export function SubagentPane({
  session,
  saved,
  onClose,
}: {
  readonly session: SubagentSession;
  readonly saved: SubagentPaneState;
  readonly onClose: () => void;
}) {
  const { openSubagent } = useChatWorkspace();
  const { data, status, error, ready, disclosures } = useSyncExternalStore(
    saved.subscribe,
    saved.getSnapshot,
    saved.getSnapshot,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(saved.followBottom);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    const body = content.current;
    if (!ready || !viewport || !body) return;
    setFollowing(saved.followBottom);
    const restore = () => {
      viewport.scrollTop = saved.followBottom ? viewport.scrollHeight : saved.scrollTop;
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(viewport);
    observer.observe(body);
    return () => observer.disconnect();
  }, [saved, ready]);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      aria-label={`${session.name} session`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button
          ref={closeButton}
          type="button"
          aria-label="Close subagent pane"
          title="Close pane (Esc)"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{session.name}</h2>
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroll}
          role="log"
          tabIndex={0}
          className="h-full overflow-y-auto [overflow-anchor:none]"
          onScroll={(event) => {
            const viewport = event.currentTarget;
            if (!ready) return;
            saved.setScroll(
              viewport.scrollTop,
              viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 8,
            );
            setFollowing(saved.followBottom);
          }}
        >
          <div ref={content} className="flex flex-col gap-5 px-4 py-5">
            {data.messages.map((message, index) => (
              <AgentMessage
                subagents={data.subagents}
                onOpenSubagent={openSubagent}
                key={message.id}
                showReasoning
                disclosures={disclosures}
                onDisclosureChange={saved.setDisclosure}
                message={message}
                canRespond={false}
                isStreaming={status === "Working" && index === data.messages.length - 1}
                onInputResponses={noResponse}
              />
            ))}
            {!data.messages.length && !error ? (
              <p className="text-sm text-muted-foreground">
                {status === "Connecting…" || status === "Working"
                  ? "Loading conversation…"
                  : "No messages yet."}
              </p>
            ) : null}
            {error ? (
              <div role="alert" className="space-y-2 text-sm text-muted-foreground">
                <p>{error}</p>
                {status === "Disconnected" ? (
                  <Button variant="outline" size="sm" onClick={saved.retry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {!following ? (
          <Button
            aria-label="Scroll subagent to bottom"
            variant="outline"
            size="icon-sm"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full"
            onClick={() => {
              saved.setScroll(scroll.current?.scrollHeight ?? saved.scrollTop, true);
              setFollowing(true);
              if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}
