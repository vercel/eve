import type { ModelMessage } from "ai";

import type { AgentRegistryEntry, AgentRegistryState } from "#subagents/registry/state.js";

/**
 * Label prefixing every framework-injected agents announcement. Mock model
 * adapters use it to treat announcements as transparent scaffolding rather
 * than authored user input.
 */
export const AGENTS_SNIPPET_LABEL = "[Agents]";

/** Model-safe projection of one persistent task-mode agent. */
export interface AgentView {
  readonly availability: "available" | "busy";
  readonly id: string;
  readonly name: string;
  readonly statusLine?: string;
  readonly taskId?: string;
  readonly taskStatus?: "working" | "input_required";
}

/** Membership is independent of child execution; routing never enters the advertisement. */
export function projectRegisteredAgentViews(
  handles: readonly AgentRegistryEntry[],
): readonly AgentView[] {
  return handles.flatMap((handle): readonly AgentView[] => {
    const registration = handle.identity.registration;
    if (registration?.visible !== true) return [];
    return [
      {
        id: handle.identity.id,
        name: registration.key,
        availability:
          handle.phase === "registered" || handle.phase === "available" || handle.phase === "parked"
            ? "available"
            : "busy",
        statusLine: `${registration.description} (${handle.phase === "registered" ? "not connected; reachability unknown" : handle.phase})`,
      },
    ];
  });
}

/** Returns the resumable handles: the only phases the model may continue. */
export function projectParkedAgentRegistryEntries(
  store: AgentRegistryState,
): readonly Extract<AgentRegistryEntry, { phase: "available" | "parked" }>[] {
  return store.handles.filter(
    (handle): handle is Extract<AgentRegistryEntry, { phase: "available" | "parked" }> =>
      handle.phase === "available" || handle.phase === "parked",
  );
}

/**
 * Renders the model-visible agent listing. Only idle handles appear:
 * starting and running children cannot accept a continuation, and private
 * delivery coordinates never render.
 */
export function renderAgentsSnippet(store: AgentRegistryState): string {
  const agents = projectParkedAgentRegistryEntries(store).map((handle) => {
    const status = handle.phase === "parked" ? handle.lastStatus : "(available)";
    return `<agent id="${escapeXml(handle.identity.id)}" name="${escapeXml(handle.identity.name)}">${escapeXml(status === "" ? "(no status)" : status)}</agent>`;
  });
  return [AGENTS_SNIPPET_LABEL, "<agents>", ...agents, "</agents>"].join("\n");
}

/** Renders task-derived availability without exposing private addresses. */
export function renderAgentViewsSnippet(views: readonly AgentView[]): string {
  const agents = views.map((view) => {
    const task =
      view.taskId === undefined || view.taskStatus === undefined
        ? ""
        : ` taskId="${escapeXml(view.taskId)}" taskStatus="${view.taskStatus}"`;
    const status = view.statusLine ?? (view.availability === "busy" ? "(busy)" : "(available)");
    return `<agent id="${escapeXml(view.id)}" name="${escapeXml(view.name)}" availability="${view.availability}"${task}>${escapeXml(status)}</agent>`;
  });
  return [AGENTS_SNIPPET_LABEL, "<agents>", ...agents, "</agents>"].join("\n");
}

/**
 * Returns an append-only announcement when the visible handle listing
 * changed since the last one in history, or `undefined` when it is
 * unchanged.
 *
 * The announcement is framework-injected `user`-role conversation content
 * (the pattern system-reminder notes use in Claude Code and OpenCode), not
 * an `assistant` or `system` entry:
 *
 * - `assistant` breaks providers that reject assistant-final requests
 *   (a settle resume carries no new user input, so the announcement would
 *   end the request) and invites the model to imitate the listing.
 * - `system` busts the provider prompt cache for the entire conversation
 *   every time a child settles; append-only history preserves the prefix.
 *
 * The static agent-messaging prompt block declares the `[Agents]` label as
 * eve-injected so the model does not attribute it to the user.
 */
export function resolveAgentsAnnouncement(input: {
  readonly agentViews?: readonly AgentView[];
  readonly messages: readonly ModelMessage[];
  readonly store: AgentRegistryState | undefined;
}): string | undefined {
  const latest = input.messages.findLast(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(AGENTS_SNIPPET_LABEL),
  );
  const store = input.store ?? { handles: [] };
  const visibleCount = input.agentViews?.length ?? projectParkedAgentRegistryEntries(store).length;

  if (latest === undefined && visibleCount === 0) {
    return undefined;
  }

  const rendered =
    input.agentViews === undefined
      ? renderAgentsSnippet(store)
      : renderAgentViewsSnippet(input.agentViews);
  return latest?.content === rendered ? undefined : rendered;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
