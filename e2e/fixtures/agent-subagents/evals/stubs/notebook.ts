import { defineToolStubs } from "eve/evals";

/** The keeper's measurement keeps the real tool's duration, so the parent's correction lands mid-turn. */
export default defineToolStubs({
  state: () => ({ measurements: 0 }),
  tools: {
    "notebook-measure": async (_input, { state }) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      state.measurements += 1;
      return `STUB-MEASUREMENT ${state.measurements}`;
    },
  },
});
