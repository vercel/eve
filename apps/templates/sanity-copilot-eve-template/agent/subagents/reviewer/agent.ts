import { defineAgent } from "eve";
import { MOCK_MODELS, structuredReplyModel } from "../../lib/mock-model.js";
import { REVIEW_MODEL } from "../../lib/models.js";

/**
 * Fresh-context draft-review subagent.
 *
 * @remarks
 * The root delegates here for a final, unbiased pass over a finished draft before proposing it
 * to the user. The reviewer runs in a fresh child session and inherits none of the root's
 * skills, connections, or tools. It carries its own copy of the `writing-quality` skill (and
 * its own sandbox to read that skill's references), so the root passes only the draft and any
 * voice or audience context in `message`. A reviewer that never saw the sources or the drafting
 * reasoning catches the AI-tells, bloated wording, and structure misses that self-review
 * rationalizes away. In the skill copy under this folder's `skills/`, the two reference files it
 * shares with the root's copy (`ai-phrases-to-avoid.md`, `plain-english-alternatives.md`) are
 * written from `shared-references/` by `scripts/sync-shared.mjs`; edit them there. `SKILL.md`,
 * `web-content-specs.md`, and `web-writing-best-practices.md` are maintained per copy and differ
 * on purpose: where the root's copy points at root-only skills (e.g. `seo-aeo-best-practices`),
 * this copy states those concerns are out of scope, since the reviewer can't load them.
 *
 * `defaultTools: false` removes every built-in tool, and `tools/` adds back only `read_file`,
 * which the reviewer needs to read its skill's reference files from its sandbox. It has no shell,
 * no file-write tools, and no web access.
 *
 * `tool: false` hides the derived subagent tool: the root calls the reviewer through the
 * `review_draft` workflow tool (`agent/tools/review_draft.ts`), which requests the structured
 * verdict per turn. Keep `description` in step with that tool's description.
 *
 * Under {@link MOCK_MODELS} the model is a mock that always returns a `ready` verdict, so an
 * offline eval can exercise the delegation without a provider call.
 *
 * @see The review rubric and verdict contract in this folder's `instructions.md`.
 */
export default defineAgent({
  defaultTools: false,
  description:
    "Review a finished content draft with fresh context against the writing-quality rubric " +
    "(AI-tells, plain English, structure, web-content specs) before it goes to the user. The " +
    "caller passes the full draft plus any voice or audience context in the message; the " +
    "reviewer loads its own rubric and returns a verdict with concrete issues.",
  model: MOCK_MODELS
    ? structuredReplyModel(() => ({ issues: [], verdict: "ready" }))
    : REVIEW_MODEL,
  tool: false,
});
