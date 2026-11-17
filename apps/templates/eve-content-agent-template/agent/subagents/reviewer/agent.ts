import { defineAgent } from "eve";
import { MOCK_MODELS, structuredReplyModel } from "../../lib/mock-model.js";
import { REVIEW_MODEL } from "../../lib/models.js";

/**
 * Fresh-context reviewer subagent.
 *
 * @remarks
 * A declared subagent — its `subagents/reviewer/` location is what marks it as one — that the
 * root agent delegates to for a final, unbiased pass over a finished draft. It runs in its own
 * child session with no shared history and, like every declared subagent, inherits none of the
 * root's skills, connections, or tools. The root packs only the surface and the draft into
 * `message`; the reviewer loads the matching style rubric itself through its own
 * `get_surface_rubric` tool — a build-time bundle (`lib/rubric.generated.ts`, written by
 * `scripts/sync-shared.mjs`) of the house lists and each surface's best-practices and specs, so
 * no skills or sandbox are needed. That isolation is the point — a reviewer that never saw the
 * source or the drafting reasoning catches the voice drift, AI-tells, and spec misses that
 * self-review rationalizes away. The `check_style` tool also sends a draft here when its
 * decision-model rules are too close to call, so this agent is the fallback judge for both.
 *
 * `defaultTools: false` removes the sandbox and web tools, leaving `get_surface_rubric` as the
 * reviewer's only tool: a review needs the draft and the rubric, nothing else. Under
 * {@link MOCK_MODELS} the model is a mock that always returns a `ready` verdict.
 *
 * `tool: false` hides the default model-facing subagent tool: the root reaches this agent through
 * the `review` workflow tool (`agent/tools/review.ts`), which opens it with `ctx.agent()` and
 * requests the structured verdict as the turn's `outputSchema`. `description` is still required
 * for a subagent.
 *
 * @see The review rubric and verdict contract in this folder's `instructions.md`.
 */
export default defineAgent({
  defaultTools: false,
  description:
    "Review a finished draft with fresh context against the active surface's style rubric " +
    "(voice, AI-tells, plain English, structure, specs) and return a verdict. The caller " +
    "passes the surface and the draft; the reviewer loads the matching rubric itself.",
  model: MOCK_MODELS
    ? structuredReplyModel(() => ({ issues: [], verdict: "ready" }))
    : REVIEW_MODEL,
  tool: false,
});
