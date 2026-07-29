import { z } from "#compiled/zod/index.js";

import { AGENTS_SNIPPET_LABEL } from "#harness/compaction-prompt.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

/** Session-state key for delegated agent handles. */
export const AGENT_HANDLES_STATE_KEY = "eve.agent.handles";

/** Delivery category for a delegated agent handle. */
export type AgentHandleKind = "agent/local" | "agent/remote" | "agent/runtime";

/** Durable delivery coordinates for one delegated agent. */
export interface AgentHandle {
  /** Model-visible identifier derived from the tool name and session id. */
  readonly id: string;
  readonly kind: AgentHandleKind;
  readonly relationship: "child" | "parent";
  /** Deliver target base URL. Empty for the same deployment; never model-visible. */
  readonly url: string;
  /** Subagent tool name. */
  readonly name: string;
  /** Agent-graph node used to re-resolve remote headers. */
  readonly nodeId: string;
  readonly sessionId: string;
  /** Private delivery credential; never model-visible. */
  readonly continuationToken: string;
  /** Short task description captured from the latest delegation tool call. */
  readonly description?: string;
  /**
   * Callback base URL stub captured when the remote child was dispatched.
   * Continuation binds the current parent token to this stub; only present
   * for `agent/remote` handles. Never model-visible.
   */
  readonly callbackBaseUrl?: string;
  /** Latest one-line output snippet, truncated to 120 characters. */
  readonly lastStatus?: string;
  /** ISO timestamp for the latest handle update. */
  readonly updatedAt: string;
}

/** Session-state collection of delegated agent handles. */
export interface AgentHandleStore {
  readonly handles: readonly AgentHandle[];
}

const agentHandleSchema: z.ZodType<AgentHandle> = z.object({
  callbackBaseUrl: z.string().optional(),
  continuationToken: z.string(),
  description: z.string().optional(),
  id: z.string(),
  kind: z.enum(["agent/local", "agent/remote", "agent/runtime"]),
  lastStatus: z.string().optional(),
  name: z.string(),
  nodeId: z.string(),
  relationship: z.enum(["child", "parent"]),
  sessionId: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});

const agentHandleStoreSchema: z.ZodType<AgentHandleStore> = z.object({
  handles: z.array(agentHandleSchema),
});

/** Error code for a requested agent that is not registered. */
export const AGENT_UNKNOWN = "AGENT_UNKNOWN";

/** Error code for delivery coordinates that do not match the registered agent. */
export const AGENT_MISMATCH = "AGENT_MISMATCH";

/** Error code for a registered agent that cannot be reached. */
export const AGENT_UNREACHABLE = "AGENT_UNREACHABLE";

/** Derives the model-visible agent identifier for a delegated agent session. */
export function deriveAgentId(name: string, sessionId: string): string {
  return `ag_${name}:${sessionId.slice(-12)}`;
}

/** Reads and validates the agent handle store from session state. */
export function getAgentHandleStore(
  state: SessionStateMap | undefined,
): AgentHandleStore | undefined {
  const parsed = agentHandleStoreSchema.safeParse(state?.[AGENT_HANDLES_STATE_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** Returns a session with the handle inserted or replaced by identifier. */
export function upsertAgentHandle(session: HarnessSession, handle: AgentHandle): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existingIndex = handles.findIndex((existing) => existing.id === handle.id);
  const nextHandles =
    existingIndex === -1
      ? [...handles, handle]
      : handles.map((existing, index) => (index === existingIndex ? handle : existing));

  return {
    ...session,
    state: {
      ...session.state,
      [AGENT_HANDLES_STATE_KEY]: { handles: nextHandles } satisfies AgentHandleStore,
    },
  };
}

/** Returns a session without the handle, preserving identity when it is absent. */
export function removeAgentHandle(session: HarnessSession, id: string): HarnessSession {
  const store = getAgentHandleStore(session.state);
  if (store === undefined || !store.handles.some((handle) => handle.id === id)) {
    return session;
  }

  return {
    ...session,
    state: {
      ...session.state,
      [AGENT_HANDLES_STATE_KEY]: {
        handles: store.handles.filter((handle) => handle.id !== id),
      } satisfies AgentHandleStore,
    },
  };
}

/** Renders the model-visible agent listing without private delivery coordinates. */
export function renderAgentsSnippet(store: AgentHandleStore): string {
  const agents = store.handles.map(
    (handle) =>
      `<agent id="${escapeXml(handle.id)}" name="${escapeXml(handle.name)}">${escapeXml(handle.lastStatus ?? "(no status)")}</agent>`,
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
