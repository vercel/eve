import type { ModelMessage } from "ai";

import type { AgentHandle, AgentHandleStore } from "#harness/handles/store.js";

const AGENTS_SNIPPET_LABEL = "[Agents]";

/** Model-safe projection of one persistent task-mode agent. */
export interface AgentView {
  readonly availability: "available" | "busy";
  readonly id: string;
  readonly name: string;
  readonly statusLine?: string;
  readonly taskId?: string;
  readonly taskStatus?: "working" | "input_required";
}

/** Returns the resumable handles: the only phase the model may continue. */
export function projectParkedAgentHandles(
  store: AgentHandleStore,
): readonly Extract<AgentHandle, { phase: "parked" }>[] {
  return store.handles.filter((handle) => handle.phase === "parked");
}

/**
 * Renders the model-visible agent listing. Only parked handles appear:
 * starting and running children cannot accept a continuation, and private
 * delivery coordinates never render.
 */
export function renderAgentsSnippet(store: AgentHandleStore): string {
  const agents = projectParkedAgentHandles(store).map(
    (handle) =>
      `<agent id="${escapeXml(handle.identity.id)}" name="${escapeXml(handle.identity.name)}">${escapeXml(handle.lastStatus === "" ? "(no status)" : handle.lastStatus)}</agent>`,
  );
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
 * Returns an append-only model announcement when the visible handle listing
 * changed. Keeping volatile handles in conversation history preserves the
 * stable system prompt cache prefix.
 */
export function resolveAgentsAnnouncement(input: {
  readonly agentViews?: readonly AgentView[];
  readonly messages: readonly ModelMessage[];
  readonly store: AgentHandleStore | undefined;
}): string | undefined {
  const latest = input.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.startsWith(AGENTS_SNIPPET_LABEL),
  );
  const store = input.store ?? { handles: [] };
  const visibleCount = input.agentViews?.length ?? projectParkedAgentHandles(store).length;

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
