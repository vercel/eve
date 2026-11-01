import { pendingApprovalsNote } from "#harness/hitl/index.js";
import { type Definition, section, SECTION_ORDER } from "./definition.js";

/**
 * eve's note on the calls still awaiting approval, which a message may revise. It reads the
 * session's current approvals at each model call, never a note left in history.
 */
export const approvals: Definition = {
  contribute: ({ call, step }) => {
    const view = call === undefined ? undefined : step?.view?.();
    const note = view === undefined ? undefined : pendingApprovalsNote(view);
    return note === undefined
      ? {}
      : {
          system: [section("eve.approvals", note, { order: SECTION_ORDER.approvals, part: "own" })],
        };
  },
  id: "eve.approvals",
  label: "eve's note on pending approvals",
};
