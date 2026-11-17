import { pendingApprovalsNote } from "#harness/hitl/approval-prompt.js";
import { type Definition, section, SECTION_ORDER } from "./definition.js";

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
