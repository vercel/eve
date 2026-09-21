"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createServerStatusMonitor, type ServerStatus } from "@/lib/server-status";
import { cn } from "@/lib/utils";

const ServerStatusContext = createContext<ServerStatus>("checking");

export function useServerStatus() {
  return useContext(ServerStatusContext);
}

export function ServerStatusProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    const monitor = createServerStatusMonitor({
      onStatus: setStatus,
      isHidden: () => document.hidden,
    });
    const check = monitor.check;
    const onVisibility = monitor.visibilityChanged;
    void check();
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      monitor.dispose();
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <ServerStatusContext.Provider value={status}>{children}</ServerStatusContext.Provider>;
}

const labels: Record<ServerStatus, string> = {
  checking: "Checking server…",
  ready: "Server reachable",
  "auth-required": "Server reachable · Authentication required",
  forbidden: "Server reachable · Access denied",
  unavailable: "Server unavailable",
};

export function ServerStatusDot() {
  const status = useServerStatus();
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-muted-foreground/50",
        status === "ready" && "bg-emerald-500",
        status === "unavailable" && "bg-red-400",
        (status === "auth-required" || status === "forbidden") && "bg-amber-400",
      )}
    >
      <span className="sr-only">{labels[status]}</span>
    </span>
  );
}
