import type { AgentHandle, AgentHandleStore } from "#harness/handles/store.js";

const AGENTS_SNIPPET_LABEL = "[Agents]";

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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
