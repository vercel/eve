import { defineAgent } from "eve";
import { MOCK_MODELS, SCRIPTED_MODEL } from "#lib/mock-model/config.js";
import { LEAD_MODEL } from "#lib/models/config.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model for the marketing team lead; the rest of the agent's surface (channels,
 * connections, tools, skills, subagents) is discovered from the filesystem under `agent/`. This
 * agent routes work to specialists rather than producing deliverables itself, so it is the first
 * place to try a cheaper model tier if cost matters more than routing quality. Conversation history
 * is compacted once it reaches 90% of the context window.
 *
 * `defaultTools: false` turns off every optional built-in, including the root-copy `agent` tool.
 * The lead works through its authored tools, `workflow`, and the specialists, and has no use for a
 * shell, the sandbox file tools, or the web. A built-in that a later eve release adds stays off
 * until someone opts in.
 *
 * The agent-level `approval` adds one gate: removing a saved preference pauses for the user, the
 * same as any other delete on this team. It returns `undefined` for every other call, which leaves
 * each tool's and connection's own policy in charge.
 *
 * Under {@link MOCK_MODELS} the model is a scripted mock for the offline evals.
 */
export default defineAgent({
  approval: ({ toolName }) =>
    toolName === "preferences__remove_memory" ? "user-approval" : undefined,
  compaction: { threshold: 0.9 },
  defaultTools: false,
  model: MOCK_MODELS ? SCRIPTED_MODEL : LEAD_MODEL,
});
