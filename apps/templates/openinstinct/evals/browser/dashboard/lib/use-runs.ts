"use client";

import { useEffect, useState } from "react";
import {
  browserBenchmarkRunListSchema,
  type BrowserBenchmarkLiveStatus,
} from "../../live-status-schema";

export function useRuns() {
  const [runs, setRuns] = useState<BrowserBenchmarkLiveStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      let nextDelay = 5_000;
      try {
        const response = await fetch("/api/runs", { cache: "no-store" });
        if (cancelled) return;
        if (response.ok) {
          const next = browserBenchmarkRunListSchema.parse(
            await response.json()
          );
          setRuns(next.runs);
          setError(null);
          if (
            next.runs.some(
              (run) => run.status === "preparing" || run.status === "running"
            )
          ) {
            nextDelay = 1_000;
          }
        } else {
          setError("Unable to read benchmark runs.");
        }
      } catch {
        if (!cancelled) setError("Dashboard server is unreachable.");
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void poll();
        }, nextDelay);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { error, runs };
}
