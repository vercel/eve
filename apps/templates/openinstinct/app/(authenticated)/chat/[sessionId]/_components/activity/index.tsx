"use client";

import type { SessionStreamEvent } from "eve/client";
import type { SessionView } from "eve/events";
import { ListTreeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@web/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@web/components/ui/sheet";
import {
  collectSubagentSessions,
  getSubagentStatus,
} from "@app/_lib/subagent-sessions";
import type { ChatUsage } from "@shared/chat/schema";
import { cn } from "@web/components/class-names";
import type { TraceView } from "../../_lib/trace-view";
import { ActivityCard } from "./card";
import { TracePreview } from "./preview";
import { useChatUsage } from "./use-chat-usage";

const emptyEventsBySession = new Map<string, readonly SessionStreamEvent[]>();

export function SubagentPanel({
  childOpenings,
  events,
  historyComplete,
  initialUsage,
  onTraceViewChange,
  sessionId,
  traceView,
  view,
}: {
  readonly childOpenings: readonly Extract<
    SessionStreamEvent,
    { type: "child.opened" }
  >[];
  readonly events: readonly SessionStreamEvent[];
  readonly historyComplete: boolean;
  readonly initialUsage?: ChatUsage;
  readonly onTraceViewChange: (view: TraceView) => void;
  readonly sessionId: string;
  readonly traceView: TraceView;
  readonly view: SessionView;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const traceCloseButton = useRef<HTMLButtonElement>(null);
  const restoreFocusId = useRef<string | undefined>(undefined);
  const sessions = useMemo(
    () => collectSubagentSessions(events, view, childOpenings),
    [childOpenings, events, view]
  );
  const { usage, label: usageLabel } = useChatUsage({
    events,
    historyComplete,
    initialUsage,
    sessionId,
  });

  useEffect(() => {
    if (!window.matchMedia("(min-width: 48rem)").matches) return undefined;
    if (!selectedId) {
      const taskId = restoreFocusId.current;
      if (!taskId) return undefined;
      const frame = requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-task-session="${CSS.escape(taskId)}"]`
          )
          ?.focus();
        restoreFocusId.current = undefined;
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }

    const frame = requestAnimationFrame(() =>
      traceCloseButton.current?.focus()
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedId]);

  const selected = sessions.find(
    (session) => session.childSessionId === selectedId
  );
  const statuses = useMemo(
    () =>
      new Map(
        sessions.map((session) => [
          session.childSessionId,
          getSubagentStatus([], session),
        ])
      ),
    [sessions]
  );
  const workingCount = [...statuses.values()].filter((status) =>
    ["starting", "working"].includes(status)
  ).length;
  const doneCount = sessions.length - workingCount;
  const openTask = (childSessionId: string) => {
    restoreFocusId.current = childSessionId;
    setSelectedId(childSessionId);
  };
  const closeTask = () => {
    setSelectedId(undefined);
  };
  const activity = (
    <ActivityCard
      doneCount={doneCount}
      eventsBySession={emptyEventsBySession}
      onSelect={openTask}
      onTraceViewChange={onTraceViewChange}
      sessions={sessions}
      statuses={statuses}
      traceView={traceView}
      usage={usage}
      usageLabel={usageLabel}
      workingCount={workingCount}
    />
  );

  return (
    <>
      <aside
        aria-hidden={selected !== undefined}
        className={cn(
          "relative hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear md:block",
          selected ? "w-0" : "w-80"
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 flex w-80 items-start p-3 transition-[opacity,transform] duration-200",
            selected
              ? "pointer-events-none translate-x-6 opacity-0"
              : "translate-x-0 opacity-100"
          )}
        >
          {activity}
        </div>
      </aside>

      <Button
        aria-label="Open activity panel"
        className="absolute top-2 right-3 z-30 md:hidden"
        onClick={() => {
          setMobileOpen(true);
        }}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ListTreeIcon />
      </Button>

      <aside
        aria-hidden={!selected}
        className={cn(
          "relative hidden h-full shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-linear md:block",
          selected ? "w-1/2 min-w-80" : "w-0 border-l-0"
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 flex w-full min-w-80 flex-col transition-[opacity,transform] duration-200",
            selected
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-6 opacity-0"
          )}
        >
          {selected ? (
            <TracePreview
              closeButtonRef={traceCloseButton}
              key={selected.childSessionId}
              onClose={closeTask}
              parentSessionId={sessionId}
              session={selected}
            />
          ) : null}
        </div>
      </aside>

      <Sheet
        onOpenChange={(open) => {
          setMobileOpen(open);
          if (!open) closeTask();
        }}
        open={mobileOpen}
      >
        <SheetContent
          className="h-[85svh] w-full gap-0 p-0 sm:max-w-none"
          side="bottom"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>
              {selected ? `${selected.name} trace` : "Agent activity"}
            </SheetTitle>
            <SheetDescription>
              {selected
                ? "Full trace for the selected subagent"
                : "Conversation views, sources, and live task statuses"}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <TracePreview
              key={selected.childSessionId}
              onClose={closeTask}
              parentSessionId={sessionId}
              session={selected}
            />
          ) : (
            activity
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
