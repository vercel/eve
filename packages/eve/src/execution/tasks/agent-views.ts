import type { HarnessSession } from "#harness/types.js";
import { resolveAgentsAnnouncement, type AgentView } from "#harness/handles/prompt.js";
import { formatAgentStatus, getAgentHandleStore } from "#harness/handles/store.js";
import { readTaskViews } from "#execution/tasks/control-shared.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

/** Derives model-visible task-agent availability from authoritative task snapshots. */
export async function readTaskAgentViews(session: HarnessSession): Promise<readonly AgentView[]> {
  const addresses = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (handle) => handle.phase === "addressed",
  );
  if (addresses.length === 0) return [];

  const entries = getSessionTaskIndex(session.state);
  const views = await readTaskViews(entries);
  const byAgent = new Map<string, typeof views>();
  for (const view of views) {
    const current = byAgent.get(view.metadata.agentId) ?? [];
    byAgent.set(view.metadata.agentId, [...current, view]);
  }

  return addresses.map((address) => {
    const agentTasks = byAgent.get(address.identity.id) ?? [];
    const active = agentTasks.filter(
      (view) => view.status === "working" || view.status === "input_required",
    );
    if (active.length > 1) {
      throw new Error(`Agent "${address.identity.id}" has more than one nonterminal task.`);
    }
    const task = active[0];
    if (task !== undefined) {
      const taskStatus = task.status === "input_required" ? "input_required" : "working";
      return {
        availability: "busy",
        id: address.identity.id,
        name: address.identity.name,
        taskId: task.taskId,
        taskStatus,
      };
    }

    const latest = agentTasks.at(-1);
    return {
      availability: "available",
      id: address.identity.id,
      name: address.identity.name,
      statusLine:
        latest?.lastOutput === undefined ? undefined : formatAgentStatus(latest.lastOutput.data),
    };
  });
}

/** Appends the changed task-agent projection before the next model call. */
export async function appendTaskAgentAnnouncement(
  session: HarnessSession,
): Promise<HarnessSession> {
  const agentViews = await readTaskAgentViews(session);
  const announcement = resolveAgentsAnnouncement({
    agentViews,
    messages: session.history,
    store: getAgentHandleStore(session.state),
  });
  return announcement === undefined
    ? session
    : {
        ...session,
        history: [...session.history, { content: announcement, role: "assistant" }],
      };
}
