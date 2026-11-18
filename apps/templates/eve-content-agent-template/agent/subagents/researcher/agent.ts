import { defineAgent } from "eve";
import { auto } from "eve/models";
import { MOCK_MODELS, structuredReplyModel } from "../../lib/mock-model.js";
import {
  DECISION_MODEL,
  DEEP_RESEARCH_MODEL,
  STANDARD_RESEARCH_MODEL,
} from "../../lib/models.js";

/**
 * Fields the routed and mocked researcher definitions share.
 */
const shared = {
  defaultTools: false,
  description:
    "Research a topic on the open web for facts, statistics, primary sources, and links the " +
    "writer needs but Notion doesn't cover. Runs refined searches against reliable sources and " +
    "returns cited findings with confidence levels, plus the gaps it couldn't verify.",
  tool: false,
} as const;

/**
 * Fresh-context web-research subagent.
 *
 * @remarks
 * A declared subagent — its `subagents/researcher/` location is what marks it as one — that the
 * root agent delegates to when a draft needs facts the Notion source material doesn't cover: a
 * statistic, a competitor detail, a primary-source link, or a claim to verify. It runs in its own
 * child session with no shared history and, like every declared subagent, inherits none of the
 * root's skills, connections, or tools. `defaultTools: false` removes every built-in tool, and
 * `tools/` adds back only `web_search` and `web_fetch`, so fetched web content can't reach a
 * shell or the sandbox filesystem, and a built-in added by a later eve release stays off until
 * someone opts in. It judges and gathers only from what the root packs into `message` plus what
 * it finds on the open web.
 *
 * That isolation is the point: a researcher that can't see the thread or invent from the draft's
 * momentum is forced to ground every claim in a real, fetched source. It reinforces the root's
 * no-fabrication rule rather than weakening it — the root weaves in only `findings` that come
 * back with citations, and surfaces `gaps` to the writer instead of papering over them.
 *
 * `tool: false` hides the default model-facing subagent tool: the root reaches this agent through
 * the `research` workflow tool (`agent/tools/research.ts`), which opens it with `ctx.agent()` and
 * requests the structured, cited result as the turn's `outputSchema`. `description` is still
 * required for a subagent.
 *
 * The model is routed per call with `auto` from `eve/models`: before the turn's first model
 * call, {@link DECISION_MODEL} reads the research message (a child session routes from its own
 * prompt) and picks {@link DEEP_RESEARCH_MODEL} or {@link STANDARD_RESEARCH_MODEL} from the
 * descriptions below. The `research` tool prefixes the message with a `Research depth:` line
 * when the root states one, which gives the router an explicit signal. `fallback` applies only
 * when the decision model itself fails.
 *
 * The two `defineAgent` calls differ only in `model`: a routed model and a plain model are
 * separate overloads, so one call can't take either. Under {@link MOCK_MODELS} the model is a
 * mock that returns no findings and echoes the message it received as the `summary`, so an
 * offline eval can check what the `research` tool sent.
 *
 * @see The research methodology and output contract in this folder's `instructions.md`.
 */
export default MOCK_MODELS
  ? defineAgent({
      ...shared,
      model: structuredReplyModel((message) => ({
        findings: [],
        gaps: [],
        summary: message,
      })),
    })
  : defineAgent({
      ...shared,
      model: auto({
        fallback: STANDARD_RESEARCH_MODEL,
        model: DECISION_MODEL,
        options: {
          [DEEP_RESEARCH_MODEL]:
            "Deep research: many sources to gather and reconcile, conflicting or technical " +
            "evidence, claims that need verifying against primary sources, or synthesis " +
            "across several topics. Also any request marked 'Research depth: deep'.",
          [STANDARD_RESEARCH_MODEL]:
            "Standard research: one specific fact, statistic, definition, or link that a few " +
            "reliable sources can settle. Also any request marked 'Research depth: quick' or " +
            "'Research depth: standard'.",
        },
      }),
    });
