"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "motion/react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import type { SubagentSession } from "@/lib/subagent-session";
import { elapsedSeconds, type SubagentProgress } from "@/lib/subagent-progress";
import { formatElapsed } from "@/lib/format-elapsed";
import { useChatWorkspace } from "./chat-workspace";

export function SubagentActivity({
  name,
  progress,
  disconnected = false,
}: {
  readonly name: string;
  readonly progress: SubagentProgress;
  readonly disconnected?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const reduceMotion = useReducedMotion();
  const running = progress.endedAt === undefined && !disconnected;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, progress.startedAt]);
  const elapsed = formatElapsed(elapsedSeconds(progress, now));
  if (disconnected && progress.endedAt === undefined) return <span>{name} · Disconnected</span>;
  if (progress.phase === "done")
    return (
      <span>
        {name} done in {elapsed}
      </span>
    );
  if (progress.phase === "failed")
    return (
      <span>
        {name} · Failed after {elapsed}
      </span>
    );
  if (progress.phase === "cancelled")
    return (
      <span>
        {name} · Cancelled after {elapsed}
      </span>
    );
  return (
    <>
      {progress.phase === "waiting" ? (
        <span className="shrink-0">{name}</span>
      ) : reduceMotion ? (
        <span className="shrink-0">{name}</span>
      ) : (
        <Shimmer as="span" className="shrink-0" duration={2} repeatDelay={4}>
          {name}
        </Shimmer>
      )}
      <span className="min-w-0 truncate">{progress.update}</span>
      <span className="ml-auto shrink-0 tabular-nums">{elapsed}</span>
    </>
  );
}

export function SubagentStatus({
  session,
  onOpen,
}: {
  readonly session: SubagentSession;
  readonly onOpen: (session: SubagentSession) => void;
}) {
  const { subagentCache } = useChatWorkspace();
  const entry = useMemo(() => subagentCache.get(session), [session, subagentCache]);
  useEffect(() => {
    entry.retry();
  }, [entry, session.callId]);
  const { progress, status, ready } = useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onOpen(session)}
      aria-label={`Open ${session.name} session`}
      title={session.name}
      className="flex h-7 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-md px-1 text-xs font-normal text-muted-foreground hover:text-foreground"
    >
      {ready || status === "Disconnected" ? (
        <SubagentActivity
          name={session.name}
          progress={progress}
          disconnected={status === "Disconnected"}
        />
      ) : (
        <span>{session.name}</span>
      )}
    </Button>
  );
}
