import { defineToolStubs } from "eve/evals";

/** Stubs approval-gated, dynamic, workflow, and plain tools over one shared ledger. */
export default defineToolStubs({
  state: () => ({ markers: ["seeded-marker"] }),
  tools: {
    gate: ({ marker }: { marker: string }, { state }) => {
      state.markers.push(marker);
      return { executed: true, marker, stubbed: true };
    },
    dynamic_scoped_approval: ({ scope }: { scope: string }, { state }) => {
      state.markers.push(scope);
      return { scope, stubbed: true };
    },
    "workflow-draft": () => ({ status: "stubbed-workflow" }),
    "read-status": ({ marker }: { marker: string }, { state }) => ({
      ledger: state.markers.join(","),
      marker,
      status: "stubbed",
    }),
  },
});
