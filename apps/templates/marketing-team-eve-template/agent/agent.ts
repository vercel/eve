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
 * The lead works through its authored tools, the specialists, and `eve__execute`, and has no use
 * for a shell, the sandbox file tools, or the web. A built-in that a later eve release adds stays
 * off until someone opts in.
 *
 * `codeMode: true` adds `eve__execute`, which `defaultTools` does not govern. It lets the lead run
 * several specialists as one program: the model writes a short program that calls specialists in
 * order or side by side and passes one specialist's reply into the next one's message. The program
 * picks its own specialists at runtime, so nothing here names them and adding one needs no change
 * to this file. A single delegation still goes straight to the specialist.
 *
 * The program runs inside the turn, so the lead reads its result when it returns. It waits through
 * a specialist's approval prompt (an email send, a scheduled post) or question and carries on once
 * the user answers. Any other new message stops it, and the calls that already finished keep their
 * results. eve caps a program at 128 agent calls and 1,024 calls in all. The team's longest real
 * chain is three steps, so those caps stop a runaway program rather than limit real work.
 *
 * The agent-level `approval` adds one gate: removing a saved preference pauses for the user, the
 * same as any other delete on this team. It returns `undefined` for every other call, which leaves
 * each tool's and connection's own policy in charge. A call made from an `eve__execute` program
 * goes through the same policies as one the model makes itself.
 *
 * Under {@link MOCK_MODELS} the model is a scripted mock for the offline evals.
 */
export default defineAgent({
  approval: ({ toolName }) =>
    toolName === "preferences__remove_memory" ? "user-approval" : undefined,
  codeMode: true,
  compaction: { threshold: 0.9 },
  defaultTools: false,
  model: MOCK_MODELS ? SCRIPTED_MODEL : LEAD_MODEL,
});
