"use client";

import {
  Client,
  conversationOf,
  endsTurn,
  type SessionStreamEvent,
} from "eve/client";
import { idle } from "eve/events";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  appendHistoryEvent,
  readLatestSessionHistory,
  readOlderSessionHistory,
  type SessionHistoryPage,
} from "../../_lib/session-history";

const client = new Client({ baseUrl: "" });

/**
 * Reads a child session through its parent, which verifies the recorded
 * `child.opened` relationship before it returns the child's history.
 */
export function useSessionHistory(
  parentSessionId: string,
  opened: Extract<SessionStreamEvent, { type: "child.opened" }>
) {
  const [history, setHistory] = useState<SessionHistoryPage>();
  const [error, setError] = useState<string>();
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const historyRef = useRef(history);
  const reader = useMemo(
    () => client.sessions.attach(parentSessionId).agent(opened),
    [opened, parentSessionId]
  );

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    const controller = new AbortController();

    void readLatestSessionHistory(reader, controller.signal)
      .then(async (latest) => {
        if (controller.signal.aborted) return undefined;
        historyRef.current = latest;
        setHistory(latest);

        if (
          latest.events.length === 0 ||
          idle(conversationOf(latest.events).view)
        ) {
          return undefined;
        }

        let turnEnded = false;
        for await (const event of reader.stream({
          signal: controller.signal,
          startIndex: latest.endIndex,
        })) {
          setHistory((current) =>
            current ? appendHistoryEvent(current, event) : current
          );
          turnEnded ||= endsTurn(event);
          if (turnEnded && event.meta.endOfLine !== false) break;
        }
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The task stream disconnected."
          );
        }
        return undefined;
      });

    return () => {
      controller.abort();
    };
  }, [reader]);

  const loadOlder = async () => {
    const current = historyRef.current;
    if (!current || current.startIndex === 0 || isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      const older = await readOlderSessionHistory(reader, current.startIndex);
      setHistory((latest) =>
        latest
          ? {
              ...latest,
              events: [...older.events, ...latest.events],
              startIndex: older.startIndex,
            }
          : latest
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load older task messages."
      );
    } finally {
      setIsLoadingOlder(false);
    }
  };

  return {
    error,
    events: history?.events ?? [],
    hasOlder: (history?.startIndex ?? 0) > 0,
    isLoading: history === undefined && error === undefined,
    isLoadingOlder,
    loadOlder,
  };
}
