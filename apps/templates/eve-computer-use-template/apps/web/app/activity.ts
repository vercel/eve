import { call, type SessionView } from "eve/events";
import type { EveMessage, EveToolPart, Interaction } from "eve/react";

import type { Screen } from "../../../agent/lib/screen";

export interface ToolActivity {
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "awaiting" | "done" | "error";
  /** The screen after the call, from the browser and desktop tools. */
  readonly screen?: Screen;
  readonly error?: string;
  readonly input?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** An approval waiting on the person. */
  readonly approval?: Interaction;
}

export function toolParts(messages: readonly EveMessage[]): EveToolPart[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool" && part.kind === "tool" ? [part] : [])),
  );
}

export function toActivity(part: EveToolPart, view: SessionView): ToolActivity {
  const observed = call(view, part.callId);
  const approval = part.interaction?.status === "open" ? part.interaction : undefined;
  return {
    id: part.callId,
    label: part.label,
    state:
      part.state === "approval" || part.state === "blocked"
        ? "awaiting"
        : part.state === "completed"
          ? "done"
          : part.state === "failed" || part.state === "rejected" || part.state === "cancelled"
            ? "error"
            : "running",
    screen: screenOf(part.output),
    error:
      part.state === "failed"
        ? (part.error?.message ?? "Failed")
        : part.state === "rejected"
          ? "Declined"
          : part.state === "cancelled"
            ? "Cancelled"
            : undefined,
    input: part.input,
    startedAt: time(observed?.startedAt),
    endedAt: time(observed?.endedAt),
    approval,
  };
}

/** The latest screen any call returned, including the browser's own screenshot tool. */
export function latestScreen(activities: readonly ToolActivity[]): Screen | undefined {
  return activities.findLast((activity) => activity.screen !== undefined)?.screen;
}

/** Whether a call has started `device`'s live stream in this session. */
export function hasLiveStream(
  activities: readonly ToolActivity[],
  device: "browser" | "desktop",
): boolean {
  return activities.some(
    (activity) => activity.screen?.device === device && activity.screen.sandbox !== undefined,
  );
}

function screenOf(output: unknown): Screen | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const { screen, imageDataUrl } = output as { screen?: Screen; imageDataUrl?: unknown };
  if (screen?.imageDataUrl) return screen;
  // The browser's own screenshot tool returns an image without a `screen`.
  return typeof imageDataUrl === "string" ? { device: "browser", imageDataUrl } : undefined;
}

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Turn agent-browser's error text into something a person can read at a glance. */
export function explainError(raw: string): string {
  const message = raw.replace(/^Error:\s*/, "").replace(/^agent-browser \w+ failed:\s*/, "");
  if (/is covered by <(.+?)> at its click point/.test(message)) return "Covered by another element";
  if (/timed? ?out/i.test(message)) return "Timed out";
  return message.split(/(?<=\.)\s/)[0] ?? message;
}
