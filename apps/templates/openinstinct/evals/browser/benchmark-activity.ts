import type { SessionStreamEvent } from "eve/client";
import { z } from "zod";
import {
  browserActivityKindForTool,
  type BrowserActivityKind,
  sumBrowserActivityDurations,
} from "@web/browser/activity";

const toolActivity = new Map<string, string>([
  ["browser_act", "Acting in the browser"],
  ["browser_find", "Finding page controls"],
  ["browser_snapshot", "Inspecting the page"],
  ["browser_text", "Reading the page"],
  ["capture_browser_image", "Capturing browser evidence"],
  ["computer_action", "Using visual browser controls"],
  ["fill_from_vault", "Securely filling saved user information"],
  ["list_vault", "Checking saved user information"],
  ["manage_browsers", "Starting the browser"],
  ["playwright_execute", "Interacting with the page"],
  ["web_fetch", "Reading a public source"],
  ["web_search", "Searching for live options"],
]);

const managedBrowserOutputSchema = z.object({
  browser: z.object({ browser_live_view_url: z.url() }),
});

type CallRequestedEvent = Extract<
  SessionStreamEvent,
  { type: "call.requested" }
>;

export function browserBenchmarkActivity(
  events: readonly SessionStreamEvent[]
) {
  for (const event of events.toReversed()) {
    if (event.type === "content.delta" && event.data.kind !== "reasoning") {
      const message = activityLine(
        events
          .flatMap((candidate) =>
            candidate.type === "content.delta" &&
            candidate.data.partId === event.data.partId
              ? [candidate.data.delta]
              : []
          )
          .join("")
      );
      if (message) return message;
    }
    if (event.type === "content.completed" && event.data.kind === "text") {
      const text = z.string().safeParse(event.data.value);
      const message = activityLine(text.success ? text.data : "");
      if (message) return message;
    }
    if (event.type === "call.requested") {
      const activities = sameLineCalls(events, event).map(({ data }) => {
        if (data.capability.kind === "skill") {
          return "Loading the browser procedure";
        }
        if (data.capability.kind === "tool") {
          return activityForTool(data.capability.name);
        }
        return "Coordinating browser work";
      });
      return [...new Set(activities)].join(" and ");
    }
    if (event.type === "call.settled") {
      const requested = requestedCall(events, event.data.callId);
      if (requested?.data.capability.kind === "tool") {
        return `Reviewing ${activityForTool(requested.data.capability.name).toLowerCase()} result`;
      }
    }
    if (event.type === "interaction.opened") {
      return "Waiting for required input";
    }
    if (event.type === "model.started") return "Planning the next step";
  }
  return null;
}

export function browserBenchmarkActivityDurations(
  events: readonly SessionStreamEvent[],
  now = Date.now()
) {
  return sumBrowserActivityDurations(
    events.flatMap((event, index) => {
      // One stored line can request several calls; classify them together.
      const previous = events[index - 1];
      if (
        event.type === "call.requested" &&
        previous?.type === "call.requested" &&
        previous.meta.position.line === event.meta.position.line
      ) {
        return [];
      }
      const kind = activityKindForEvent(events, event);
      return kind ? [{ at: Date.parse(event.meta.at), kind }] : [];
    }),
    now
  );
}

export function browserBenchmarkLiveViewUrl(
  events: readonly SessionStreamEvent[]
) {
  for (const event of events.toReversed()) {
    if (event.type !== "call.settled" || event.data.outcome !== "completed") {
      continue;
    }
    const requested = requestedCall(events, event.data.callId);
    if (
      requested?.data.capability.kind !== "tool" ||
      requested.data.capability.name !== "manage_browsers"
    ) {
      continue;
    }
    const parsed = managedBrowserOutputSchema.safeParse(event.data.output);
    if (!parsed.success) continue;
    try {
      const url = new URL(parsed.data.browser.browser_live_view_url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function activityKindForEvent(
  events: readonly SessionStreamEvent[],
  event: SessionStreamEvent
): BrowserActivityKind | null {
  if (
    event.type === "model.started" ||
    event.type === "content.delta" ||
    event.type === "content.completed" ||
    event.type === "call.settled"
  ) {
    return "model";
  }
  if (event.type === "interaction.opened") return "waiting";
  if (event.type !== "call.requested") return null;

  const kinds = new Set(
    sameLineCalls(events, event).map(({ data }) => {
      if (data.capability.kind === "skill") return "setup";
      if (data.capability.kind === "tool") {
        return browserActivityKindForTool(data.capability.name);
      }
      return "other";
    })
  );
  if (kinds.size !== 1) return "other";
  return kinds.values().next().value ?? "other";
}

function sameLineCalls(
  events: readonly SessionStreamEvent[],
  event: CallRequestedEvent
) {
  return events.filter(
    (candidate): candidate is CallRequestedEvent =>
      candidate.type === "call.requested" &&
      candidate.meta.position.line === event.meta.position.line
  );
}

function requestedCall(events: readonly SessionStreamEvent[], callId: string) {
  return events.find(
    (candidate): candidate is CallRequestedEvent =>
      candidate.type === "call.requested" && candidate.data.callId === callId
  );
}

function activityForTool(name: string) {
  return toolActivity.get(name) ?? `Running ${name.replaceAll("_", " ")}`;
}

function activityLine(value: string) {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  if (!line) return null;
  return line.length > 180 ? `${line.slice(0, 179).trimEnd()}…` : line;
}
