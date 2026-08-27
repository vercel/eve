import { defineExtension } from "eve/extension";

/**
 * Handoff artifacts as a mountable capability.
 *
 * @remarks
 * A handoff artifact is a Markdown document one station produces and another
 * reads, passed by id so the text never travels through the orchestrator's
 * context. In the single-app template every station carried its own copy of
 * these tools (nested subagents cannot share a tools directory); as an
 * extension, each agent that participates in handoffs mounts this package
 * with one file under `extensions/`.
 *
 * The extension contributes both tools; mount-level composition decides the
 * surface. Stations that only consume artifacts (implementer, reviewer)
 * disable `save_artifact` in their mount directory; the orchestrator mounts
 * the reader only, which is what keeps relayed documents out of its context.
 */
export default defineExtension();
