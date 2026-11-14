import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * Station 2: analysis and planning.
 *
 * @remarks
 * Works from a live checkout of the factory repository (this station's
 * sandbox clones it at session start), so the plan names real files and the
 * repository's actual conventions instead of guesses. It plans; it never
 * writes the implementation. The acceptance criteria it produces are the
 * contract the reviewer later judges the implementation against, verbatim.
 *
 * `tool: false` hides the station from the orchestrator; it calls it through
 * the `run_analyst` workflow tool, which attaches the output schema.
 * The wrapper cannot share this name: the compiler rejects a tool and a local
 * subagent with the same public name, even with `tool: false`.
 */
export default defineAgent({
  description:
    "Analyze a classified work item against the real repository checkout and produce an " +
    "implementation plan: problem statement, approach, ordered steps, affected files, " +
    "risks, acceptance criteria, and test strategy. Planning only; writes no code. The " +
    "caller passes the work item, its classification, and any research findings in the " +
    "message, plus a research artifact id when the researcher saved a full memo. May " +
    "save its own deep supporting detail as an analysis artifact and return the id.",
  model: MODELS.analyst,
  tool: false,
});
