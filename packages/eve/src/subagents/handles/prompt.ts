import type { ModelMessage } from "ai";

import type { AgentHandle, AgentHandleStore } from "#subagents/handles/store.js";

export type AgentStatus = "available" | "created" | "input_required" | "unavailable" | "working";

/** Model-safe projection of one persistent agent. */
export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly status: Exclude<AgentStatus, "created" | "unavailable">;
  readonly statusLine?: string;
  readonly taskId?: string;
}

interface RenderedAgentAnnouncement {
  readonly content: string;
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
}

/** Returns the resumable handles: the only phases the model may continue. */
export function projectParkedAgentHandles(
  store: AgentHandleStore,
): readonly Extract<AgentHandle, { phase: "available" | "parked" }>[] {
  return store.handles.filter(
    (handle): handle is Extract<AgentHandle, { phase: "available" | "parked" }> =>
      handle.phase === "available" || handle.phase === "parked",
  );
}

/** Renders one append-only agent lifecycle announcement. */
export function renderAgentAnnouncement(
  view: Pick<AgentView, "id" | "name"> & {
    readonly status: AgentStatus;
    readonly statusLine?: string;
    readonly taskId?: string;
  },
): string {
  const attributes = [
    `status="${view.status}"`,
    `name="${escapeXml(view.name)}"`,
    `id="${escapeXml(view.id)}"`,
    ...(view.taskId === undefined ? [] : [`taskId="${escapeXml(view.taskId)}"`]),
  ].join(" ");
  const statusLine = view.statusLine?.trim();
  return statusLine === undefined || statusLine === ""
    ? `<agent ${attributes}/>`
    : `<agent ${attributes}>${escapeXml(statusLine)}</agent>`;
}

/**
 * Returns append-only lifecycle deltas for agent state that changed since its
 * latest framework announcement. Each announcement is an independent `user`
 * message so the provider's previous prompt remains an exact cache prefix.
 */
export function resolveAgentAnnouncements(input: {
  readonly agentViews?: readonly AgentView[];
  readonly messages: readonly ModelMessage[];
  readonly store: AgentHandleStore | undefined;
}): readonly string[] {
  const latest = readLatestAgentAnnouncements(input.messages);
  const views = input.agentViews ?? projectParkedAgentViews(input.store ?? { handles: [] });
  const currentIds = new Set(views.map((view) => view.id));
  const announcements: string[] = [];

  for (const view of views) {
    const previous = latest.get(view.id);
    if (previous === undefined) {
      announcements.push(
        renderAgentAnnouncement({ id: view.id, name: view.name, status: "created" }),
      );
    }

    const current = renderAgentAnnouncement(view);
    if (previous?.content !== current) announcements.push(current);
  }

  for (const previous of latest.values()) {
    if (currentIds.has(previous.id) || previous.status === "unavailable") continue;
    announcements.push(
      renderAgentAnnouncement({
        id: previous.id,
        name: previous.name,
        status: "unavailable",
      }),
    );
  }

  return announcements;
}

/** True when text is one complete framework agent announcement. */
export function isAgentAnnouncementText(text: string): boolean {
  return parseAgentAnnouncement(text.trim()) !== undefined;
}

function projectParkedAgentViews(store: AgentHandleStore): readonly AgentView[] {
  return projectParkedAgentHandles(store).map((handle) => ({
    id: handle.identity.id,
    name: handle.identity.name,
    status: "available",
    statusLine: handle.phase === "parked" ? handle.lastStatus : undefined,
  }));
}

function readLatestAgentAnnouncements(
  messages: readonly ModelMessage[],
): ReadonlyMap<string, RenderedAgentAnnouncement> {
  const latest = new Map<string, RenderedAgentAnnouncement>();
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const announcement = parseAgentAnnouncement(message.content.trim());
    if (announcement !== undefined) latest.set(announcement.id, announcement);
  }
  return latest;
}

function parseAgentAnnouncement(content: string): RenderedAgentAnnouncement | undefined {
  const match =
    /^<agent status="(available|created|input_required|unavailable|working)" name="([^"]*)" id="([^"]+)"(?: taskId="[^"]+")?(?:\/>|>.*<\/agent>)$/s.exec(
      content,
    );
  if (match === null) return undefined;
  const [, status, encodedName, encodedId] = match;
  if (status === undefined || encodedName === undefined || encodedId === undefined)
    return undefined;
  return {
    content,
    id: unescapeXml(encodedId),
    name: unescapeXml(encodedName),
    status: status as AgentStatus,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
